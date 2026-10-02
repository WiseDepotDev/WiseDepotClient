import { computed, getCurrentScope, onScopeDispose, reactive, ref, toValue, watch } from 'vue';
import type { ComputedRef, MaybeRefOrGetter } from 'vue';
import { defineStore } from 'pinia';
import { BridgeError, shouldRefetchOnOpen } from '@wise/bridge-client';
import { useBridgeStore } from './bridge.js';
import { useRefreshTick } from './refresh.js';

/**
 * 资源缓存层 —— React 时代 `useBridgeCall` 的替代，但**集中**在 store 里。
 *
 * 组件内不再各拉各的：同一 `方法 + 参数` 在整棵组件树里只对应一个缓存条目，
 * 因此"列表页 → 详情页 → 返回列表"不会白重取，且两处同时要同一份数据时只发一次请求。
 *
 * ## 四条语义是从 React 版逐条搬过来的（都对应踩过的坑，不是新设计）
 *
 * 1. **失败结构化**：抛出/保存的是 `BridgeError`（带 `code`/`messageKey`/`retryable`），
 *    UI 按 code 分支，不做字符串匹配；
 * 2. **作用域销毁后不落地**：由缓存条目的所有者控制（见 `useResource` 的 onScopeDispose），
 *    旧响应不会覆盖新屏；
 * 3. **重连后最多重取一次**：判据沿用 `shouldRefetchOnOpen`，看的是"这次调用发出时连接是否 open"，
 *    所以抖动不会把界面放大成永久骨架屏；
 * 4. **`enabled:false` 与"本来就无参"分离**：`dashboard.summary` 这类无参方法不能被当成
 *    "参数还没准备好"而误伤。
 */
export interface ResourceEntry<T> {
  data: T | undefined;
  error: BridgeError | undefined;
  loading: boolean;
  updatedAt: number;
  /** 这次调用发出时连接是否 open —— `shouldRefetchOnOpen` 的判据。 */
  startedWhileDisconnected: boolean;
}

function newEntry<T>(): ResourceEntry<T> {
  return {
    data: undefined,
    error: undefined,
    loading: false,
    updatedAt: 0,
    startedWhileDisconnected: false,
  };
}

/** 稳定序列化：键排序，避免同样的参数因为属性顺序不同而算成两个缓存键。 */
function stableKey(params: unknown): string {
  if (params === null || params === undefined) {
    return 'null';
  }
  if (typeof params !== 'object') {
    return JSON.stringify(params) ?? 'null';
  }
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) {
        if (src[k] !== undefined) {
          out[k] = walk(src[k]);
        }
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(walk(params)) ?? 'null';
}

export function toBridgeError(e: unknown): BridgeError {
  return e instanceof BridgeError ? e : new BridgeError({ code: 'BRIDGE_INTERNAL', details: String(e) });
}

export const useResourceCacheStore = defineStore('wise.resources', () => {
  const entries = reactive(new Map<string, ResourceEntry<unknown>>());
  /*
   * 在途请求：键 → **请求 + 它绑定的那个缓存条目**。
   *
   * 为什么必须连条目一起记（这个 bug 真发生过）：单飞复用的判据原来只是"这个键上有在途请求吗"。
   * 可失效（`invalidate`）是**删条目**——删完之后 `run()` 一看键上有在途请求，
   * 就把那条**老请求**复用回来，而它的响应会写到**已经被删掉的旧条目**上：
   * 屏幕上那个新条目永远空着，于是刚写完的列表变成"还没有商品"。
   * 触发条件是"写操作正好撞上一次在途刷新"，5 秒一次的自动刷新让它从"罕见"变成"迟早"。
   *
   * 现在的判据是"键上那条在途请求，绑的还是**当前**这条目吗"：条目被删掉就不复用了，
   * 新请求照发；老请求回来时写进孤儿条目（没人读），它的 `finally` 也不会误删新请求的记录。
   */
  const inflight = new Map<string, { readonly task: Promise<unknown>; readonly entry: ResourceEntry<unknown> }>();
  const inflightMutations = new Map<string, Promise<unknown>>();

  /**
   * 挂载中、且**真的在用**的资源键 → 引用计数 + 调用参数。
   *
   * 为什么缓存层要知道这件事：`invalidate` 只是**删条目**，删完不会自己重取。
   * 窄档看不出后果（列表屏是被 push 上来的，回来时重挂载顺手取了一次），
   * 但宽档主从里列表屏**一直在原地**：从右栏绑定 / 改标识之后，左栏的条目被删掉，
   * `StateHost` 就把"没有数据"画成**空态**（"还没有标签…"），而服务端明明有 4 条 ——
   * 这是空态撒谎，不是样式问题。所以失效时必须对挂载中的键按原参数立刻重取一次。
   *
   * 记参数而不是从键里反解：键是 `方法#稳定序列化(参数)`，反解要拆 JSON，
   * 而调用方本来就有方法名与参数原件。
   */
  const live = new Map<string, { readonly method: string; readonly params: unknown; count: number }>();

  const keyOf = (method: string, params?: unknown): string => `${method}#${stableKey(params)}`;

  /**
   * 登记一个"有屏在用"的键（引用计数）。
   *
   * **只有 `enabled` 为真时才登记**：`enabled:false` 的语义是"参数还没准备好，不要发请求"，
   * 登记了就会在失效时把它一并重取，那条语义当场作废。
   */
  function retain(method: string, params: unknown): void {
    const key = keyOf(method, params);
    const current = live.get(key);
    if (current) {
      current.count += 1;
      return;
    }
    live.set(key, { method, params, count: 1 });
  }

  function release(key: string): void {
    const current = live.get(key);
    if (!current) {
      return;
    }
    current.count -= 1;
    if (current.count <= 0) {
      live.delete(key);
    }
  }

  /** 某个键被失效后：还挂着的屏要立刻拿到新值，不能停在"没有数据"（会被画成空态）。 */
  function refetchIfLive(key: string): void {
    const current = live.get(key);
    if (current) {
      void run(current.method, current.params).catch(() => undefined);
    }
  }

  function ensure<T>(key: string): ResourceEntry<T> {
    const existing = entries.get(key);
    if (existing) {
      return existing as ResourceEntry<T>;
    }
    entries.set(key, newEntry<unknown>());
    /*
     * **必须再读一次**，不能 `return created`。
     *
     * `reactive(new Map())` 只在 `get` 时把存的原始对象包成响应式代理。
     * 新建时直接返回原始对象，会让 `run()` 的 `entry.data = …` 写在**代理之外** ——
     * 值确实变了，但没有任何依赖被通知，于是界面永远不刷新。
     *
     * 现场表现极难查：首次进入详情页正常（首次渲染时值已经写好），
     * 但"动作成功 → 失效 → 重取"之后数据是新的、画面是旧的。
     */
    return entries.get(key) as ResourceEntry<T>;
  }

  const entryOf = <T>(method: string, params?: unknown): ResourceEntry<T> => ensure<T>(keyOf(method, params));

  async function run<T>(method: string, params?: unknown): Promise<T> {
    const key = keyOf(method, params);
    const pending = inflight.get(key);
    if (pending) {
      // 同一份数据的并发请求合并成一次 —— 这是"集中缓存"相对"每屏各拉一次"的第一处收益。
      // **但只在"这条在途请求绑的还是当前条目"时才算同一个请求**：
      // 条目已被失效删掉的话，那条老请求的响应会写进孤儿条目，屏上就永远是空的。
      if (pending.entry === (entries.get(key) as ResourceEntry<unknown> | undefined)) {
        return pending.task as Promise<T>;
      }
    }

    const bridge = useBridgeStore();
    const entry = ensure<T>(key);
    entry.startedWhileDisconnected = bridge.state !== 'open';
    entry.loading = true;
    entry.error = undefined;

    /*
     * 本次请求自己的凭据。
     *
     * 为什么不直接比 `task`：`task` 是在它自己的初始化式里被闭包引用的，
     * 严格模式（`noUncheckedIndexedAccess` 之外还有 TDZ 检查）下 TS 会判"用在了赋值之前"。
     * 用一个外部小对象装它就绕开了，语义一样清楚。
     */
    const self: { task: Promise<unknown> | undefined } = { task: undefined };

    const task = (async (): Promise<T> => {
      try {
        const value = await bridge.call<T>(method, params);
        entry.data = value;
        entry.updatedAt = Date.now();
        return value;
      } catch (e) {
        const error = toBridgeError(e);
        entry.error = error;
        throw error;
      } finally {
        entry.loading = false;
        /*
         * 只删"自己这条"：失效会让在途请求变成孤儿（它的条目已经被删掉、屏上已经换成新请求），
         * 孤儿晚回来时若无条件 `delete(key)`，会把**新请求**的单飞记录一起抹掉 ——
         * 单飞没了，同一个键就会并发重复请求。反过来，孤儿若一个都不删，
         * `inflight` 里会留下一条永远不清理的记录，后面的 `run` 会一直复用它（再也刷不新）。
         */
        if (inflight.get(key)?.task === self.task) {
          inflight.delete(key);
        }
      }
    })();

    self.task = task as Promise<unknown>;
    inflight.set(key, { task: task as Promise<unknown>, entry: entry as ResourceEntry<unknown> });
    return task;
  }

  /** 单飞写操作：重复提交拿到的是**同一个** promise，而不是第二次请求。 */
  async function mutate<T>(method: string, params?: unknown): Promise<T> {
    const pending = inflightMutations.get(method);
    if (pending) {
      return pending as Promise<T>;
    }
    const bridge = useBridgeStore();
    const task = (async (): Promise<T> => {
      try {
        return await bridge.call<T>(method, params);
      } finally {
        inflightMutations.delete(method);
      }
    })();
    inflightMutations.set(method, task as Promise<unknown>);
    return task;
  }

  const isMutating = (method: string): boolean => inflightMutations.has(method);

  /**
   * 按**方法 id 前缀**失效（写操作成功后调用，例如 `invalidate('alert')` 会清掉
   * `alert.list#…` / `alert.detail#…`）。
   *
   * 传 `'alert'` 而不是 `'alert.'`：键是 `方法 id + '#' + 参数`，
   * 用 `'alert'` 前缀能同时覆盖 `alert.*` 与将来可能的 `alertXxx`，
   * 而传一个过短的前缀（如 `'a'`）会误伤无关方法 —— 调用点请写完整的方法域前缀。
   *
   * **失效不是"只删不管"**：删完还要给**挂载中**的同键补一次取数，否则屏上会从
   * "有数据"直接掉进空态（见 `live` 的说明）。
   */
  function invalidate(prefix: string): number {
    let removed = 0;
    const dropped: string[] = [];
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) {
        entries.delete(key);
        removed += 1;
        dropped.push(key);
      }
    }
    /*
     * 挂载中的屏立刻补一次取数（原来的写法是"只删不管"）。
     * 同一次写操作里已经显式 `reload()` 的调用点**不会**因此多发请求：
     * `run` 先把 promise 记进 `inflight`，后到的同键调用直接复用它。
     */
    for (const key of dropped) {
      refetchIfLive(key);
    }
    return removed;
  }

  function invalidateKey(key: string): void {
    entries.delete(key);
    refetchIfLive(key);
  }

  function clear(): void {
    entries.clear();
  }

  return { entries, keyOf, ensure, entryOf, run, mutate, isMutating, invalidate, invalidateKey, clear, retain, release };
});

export interface UseResourceOptions {
  /**
   * `false` 时**不发请求**，停在"空且不加载"的静止态。
   *
   * 为什么要有独立开关：`params === undefined` 表示"这个方法本来就无参"，
   * 而"参数还没准备好"是另一件事；用 undefined 兼表两义会把无参方法一起误伤。
   */
  readonly enabled?: MaybeRefOrGetter<boolean> | undefined;
  /**
   * 要不要参与**自动刷新**（默认参与）。
   *
   * 退出的是"每 5 秒重取一次反而会把界面弄错"的资源，目前只有一类：
   * 服务端把读结果 `@Cacheable` 了、而写操作**没有** `@CacheEvict` 的那种
   * （`tag.detail` 就是：绑完/改完之后再读，拿回的是**旧值**）。
   * 详情面板在这些地方刻意"用写操作的响应更新显示、不 reload"，
   * 后台自动刷新会把那份旧值又盖回来。
   *
   * 注意它**只挡自动刷新**：写操作触发的失效重取、重连重取都不受影响。
   */
  readonly autoRefresh?: boolean | undefined;
}

export interface UseResourceResult<T> {
  readonly entry: ComputedRef<ResourceEntry<T>>;
  readonly data: ComputedRef<T | undefined>;
  /**
   * **首次**取数中（还没有任何数据可显示）—— 也就是"该画骨架"的那一刻。
   *
   * 为什么不是"正在请求"：现在是**自动刷新**在驱动界面，每 5 秒就会有一次后台请求。
   * 若把后台请求也算成 loading，`StateHost` 会每 5 秒用骨架屏把内容换掉一次 ——
   * 满屏闪烁。所以后台刷新期间**保留旧内容**（stale-while-revalidate），
   * 需要区分时看 `refreshing`。
   */
  readonly loading: ComputedRef<boolean>;
  /**
   * 后台刷新中（已有内容，正在取新的）。
   *
   * 与 `loading` 互斥，两个都是 false 就是"静止"。
   */
  readonly refreshing: ComputedRef<boolean>;
  /**
   * **会挡住内容**的错误：只有"一条数据都没有"时才交给它。
   *
   * 有旧内容的后台请求失败**不替换界面** —— 那会让一次网络抖动把好数据换成错误页；
   * 失败仍然是真的，原始错误在 `lastError` 里，顶栏的桥芯片也会变成"异常"。
   */
  readonly error: ComputedRef<BridgeError | undefined>;
  /** 最近一次失败（不论界面上是否显示它）。 */
  readonly lastError: ComputedRef<BridgeError | undefined>;
  readonly reload: () => void;
  readonly invalidate: () => void;
}

/**
 * 组件内取数。集中缓存 + 重连自动重取一次，语义与旧 `useBridgeCall` 对齐。
 */
export function useResource<T>(
  method: string,
  params?: MaybeRefOrGetter<unknown> | undefined,
  options?: UseResourceOptions,
): UseResourceResult<T> {
  const cache = useResourceCacheStore();
  const bridge = useBridgeStore();

  const paramValue = (): unknown => (params === undefined ? undefined : toValue(params));
  const enabled = (): boolean => (options?.enabled === undefined ? true : toValue(options.enabled));

  const activeKey = ref(cache.keyOf(method, paramValue()));
  const entry = computed(() => cache.ensure<T>(activeKey.value));

  const load = (): void => {
    if (!enabled()) {
      return;
    }
    const current = cache.entryOf<T>(method, paramValue());
    if (current.data !== undefined || current.loading) {
      return;
    }
    void cache.run<T>(method, paramValue()).catch(() => undefined);
  };

  /*
   * 让缓存层知道"这个键此刻有屏在用、且真的该发请求"（见 store 里 `live` 的说明）：
   * 写操作成功后 `invalidate` 只会对登记过的键补一次取数，没登记的（已卸载的屏、
   * `enabled:false` 的键）仍旧只是被删掉，不会凭空发请求。
   */
  let retainedKey: string | undefined;
  const dropRetained = (): void => {
    if (retainedKey !== undefined) {
      cache.release(retainedKey);
      retainedKey = undefined;
    }
  };

  watch(
    () => [cache.keyOf(method, paramValue()), enabled()] as const,
    ([key, on]) => {
      activeKey.value = key;
      // 参数变了、或者 enabled 关掉了：先松开上一个键（同一个键重复触发不重复计数）
      if (retainedKey !== key || !on) {
        dropRetained();
      }
      if (on) {
        if (retainedKey !== key) {
          cache.retain(method, paramValue());
          retainedKey = key;
        }
        load();
      }
    },
    { immediate: true, deep: true },
  );
  if (getCurrentScope()) {
    onScopeDispose(dropRetained);
  }

  /*
   * 连接恢复后自动重取一次。
   *
   * 判据来自 `shouldRefetchOnOpen`：只看"是否 open"会因连接抖动而无限重取；
   * 看"这次调用发出时是否 open"才能保证**每次断线最多重取一次**。
   */
  const off = bridge.onStateChange((state) => {
    // 同样尊重 `enabled`：参数还没准备好的资源，重连也不该替它发请求
    if (!enabled()) {
      return;
    }
    const current = cache.entryOf<T>(method, paramValue());
    if (
      shouldRefetchOnOpen(state, {
        failed: current.error !== undefined,
        startedWhileDisconnected: current.startedWhileDisconnected,
      })
    ) {
      void cache.run<T>(method, paramValue()).catch(() => undefined);
    }
  });
  if (getCurrentScope()) {
    onScopeDispose(off);
  }

  /*
   * 自动刷新（可见时每 5 秒一次、回到前台/重新聚焦/网络恢复各一次）
   * → 当前屏用到的**每一个**资源各重取一次。
   *
   * 只有挂载中的屏会订阅（`useResource` 在组件 setup 里调用），所以它刷的就是"这一屏"，
   * 不会把别的屏也一起拖下水 —— 各屏自己那个「刷新」按钮因此已经撤掉，不必每屏各写一遍。
   *
   * `autoRefresh: false` 的资源退出这条（见 `UseResourceOptions.autoRefresh` 的说明）：
   * 那是"服务端读缓存没有随写失效"的一类，被后台刷新盖回去会把刚写的东西变回旧值。
   */
  watch(useRefreshTick(), () => {
    /*
     * **也要看 `enabled`**：`enabled:false` 的语义是"参数还没准备好，不要发请求"，
     * 而自动刷新是每 5 秒无条件摸一遍所有挂载中的资源 —— 不判就会周期性发出
     * `user.detail#{userId: undefined}` 这类必然没人要的请求。
     * （真机实测到过：用户列表没选中任何人，后台每 5 秒发一次 detail/roles。）
     */
    if (options?.autoRefresh === false || !enabled()) {
      return;
    }
    void cache.run<T>(method, paramValue()).catch(() => undefined);
  });

  return {
    entry,
    data: computed(() => entry.value.data),
    /*
     * 派生值而不是内部 state：`enabled:false` 的首帧就该是"没在取数"，
     * 否则会画出一块永远不落地的骨架（React 版同一处坑）。
     *
     * 再叠一层"有旧数据就不算 loading"：自动刷新每 5 秒发一次后台请求，
     * 若那也算 loading，`StateHost` 会周期性地把内容换成骨架屏 —— 满屏闪。
     */
    loading: computed(() => enabled() && entry.value.loading && entry.value.data === undefined),
    refreshing: computed(() => enabled() && entry.value.loading && entry.value.data !== undefined),
    /*
     * 挡内容的错误只在"一条数据都没有"时给出去。
     * 有旧内容的后台请求失败不该把好数据换成错误页（真的失败了看 `lastError` 与顶栏芯片）。
     */
    error: computed(() => (entry.value.data === undefined ? entry.value.error : undefined)),
    lastError: computed(() => entry.value.error),
    reload: () => {
      void cache.run<T>(method, paramValue()).catch(() => undefined);
    },
    invalidate: () => cache.invalidateKey(activeKey.value),
  };
}

export interface UseMutationResult<T> {
  readonly pending: ComputedRef<boolean>;
  readonly run: (params?: unknown) => Promise<T>;
}

/** 写操作的组件内用法。写操作**不做乐观更新**（后端有状态机，回滚会误导操作员）。 */
export function useMutation<T>(method: string): UseMutationResult<T> {
  const cache = useResourceCacheStore();
  return {
    pending: computed(() => cache.isMutating(method)),
    run: (params?: unknown) => cache.mutate<T>(method, params),
  };
}

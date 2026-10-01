import { computed, getCurrentScope, onScopeDispose, reactive, ref, toValue, watch } from 'vue';
import type { ComputedRef, MaybeRefOrGetter } from 'vue';
import { defineStore } from 'pinia';
import { BridgeError, shouldRefetchOnOpen } from '@wise/bridge-client';
import { useBridgeStore } from './bridge.js';

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
  const inflight = new Map<string, Promise<unknown>>();
  const inflightMutations = new Map<string, Promise<unknown>>();

  const keyOf = (method: string, params?: unknown): string => `${method}#${stableKey(params)}`;

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
      // 同一份数据的并发请求合并成一次 —— 这是"集中缓存"相对"每屏各拉一次"的第一处收益
      return pending as Promise<T>;
    }

    const bridge = useBridgeStore();
    const entry = ensure<T>(key);
    entry.startedWhileDisconnected = bridge.state !== 'open';
    entry.loading = true;
    entry.error = undefined;

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
        inflight.delete(key);
      }
    })();

    inflight.set(key, task as Promise<unknown>);
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
   */
  function invalidate(prefix: string): number {
    let removed = 0;
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) {
        entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  function invalidateKey(key: string): void {
    entries.delete(key);
  }

  function clear(): void {
    entries.clear();
  }

  return { entries, keyOf, ensure, entryOf, run, mutate, isMutating, invalidate, invalidateKey, clear };
});

export interface UseResourceOptions {
  /**
   * `false` 时**不发请求**，停在"空且不加载"的静止态。
   *
   * 为什么要有独立开关：`params === undefined` 表示"这个方法本来就无参"，
   * 而"参数还没准备好"是另一件事；用 undefined 兼表两义会把无参方法一起误伤。
   */
  readonly enabled?: MaybeRefOrGetter<boolean> | undefined;
}

export interface UseResourceResult<T> {
  readonly entry: ComputedRef<ResourceEntry<T>>;
  readonly data: ComputedRef<T | undefined>;
  readonly loading: ComputedRef<boolean>;
  readonly error: ComputedRef<BridgeError | undefined>;
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

  watch(
    () => [cache.keyOf(method, paramValue()), enabled()] as const,
    ([key, on]) => {
      activeKey.value = key;
      if (on) {
        load();
      }
    },
    { immediate: true, deep: true },
  );

  /*
   * 连接恢复后自动重取一次。
   *
   * 判据来自 `shouldRefetchOnOpen`：只看"是否 open"会因连接抖动而无限重取；
   * 看"这次调用发出时是否 open"才能保证**每次断线最多重取一次**。
   */
  const off = bridge.onStateChange((state) => {
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

  return {
    entry,
    data: computed(() => entry.value.data),
    // 派生值而不是内部 state：`enabled:false` 的首帧就该是"没在取数"，
    // 否则会画出一块永远不落地的骨架（React 版同一处坑）
    loading: computed(() => enabled() && entry.value.loading),
    error: computed(() => entry.value.error),
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

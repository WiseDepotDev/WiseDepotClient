import { shallowRef, ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { subscribeBridgeState } from '@wise/bridge-vue';
import { BridgeErrorCode, type Bridge, type BridgeError, type ConnectionState, type ReqMeta } from '@wise/bridge-client';
import { toBridgeError } from './resource.js';

/** 顶栏那个状态芯片的语义（也是 App.vue 横幅的判据）。 */
export type HealthStatus = 'unknown' | 'ok' | 'degraded' | 'down';

/**
 * 桥连接 store —— **客户端上唯一持有桥实例的地方**（设计稿决策 D3）。
 *
 * 与 React 时代的关键差别：
 *  · 现在读的是**可订阅快照**（`state` / `capabilities` 会随连接变化自动更新），
 *    而不是到处读 `bridge.state` 这种一次性 getter；
 *  · 组件不再自己拿 `Bridge` 调方法，一律经 store（或资源 store），
 *    这样缓存、去重、重连重取才有唯一的落点。
 *
 * 未被附着时调用一律**抛错**而不是静默返回 undefined：静默会让
 * "忘了 attach" 表现成"界面一直空着"，比直接报错难查得多。
 */
export const useBridgeStore = defineStore('wise.bridge', () => {
  const instance = shallowRef<Bridge | null>(null);
  const origin = ref('');
  const state = ref<ConnectionState>('idle');
  const capabilities = ref<readonly string[]>([]);
  const kind = ref<'ws' | 'mock'>('ws');
  const platform = ref('');
  const hostVersion = ref('');
  /**
   * 最近一次**后端请求**的往返耗时（中位数，毫秒）。
   *
   * 为什么是"实测"而不是写死：链路耗时只有量出来的才算数。这里的样本来自
   * 界面自己发出的真实调用（`dashboard.summary`、`alert.list` 这类），
   * 量的是"桥转发 + 后端往返"的端到端耗时，不是到本地桥的 loopback 耗时。
   *
   * 刻意**不给本地方法计时**（`bridge.session` 这类）：它们不经网络，
   * 计进去会把数字压到 1ms 以下，看上去像"网络很快"，实际什么都没测到。
   */
  const latencyMs = ref<number | undefined>(undefined);
  const latencySamples: number[] = [];

  function recordLatency(ms: number): void {
    latencySamples.push(ms);
    if (latencySamples.length > 5) {
      latencySamples.shift();
    }
    const sorted = [...latencySamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
    latencyMs.value = Math.round(median);
  }

  let unsubscribe: (() => void) | null = null;

  // ---- 实时健康探测 ----

  /**
   * 探测用的方法：**真实、轻量、无副作用**的后端 GET。
   *
   * 为什么不用 `health.*`：契约里那个端点被列在 `BRIDGE_EXCLUDED_IDS` 里（桥不暴露它）。
   * 为什么选 `user.current`：它就是一次简单的"我是谁"，不带参数、不改状态，
   * 而且壳里本来也在用它取账号 —— 探测顺带把账号信息刷新了，不是纯粹的空转。
   */
  const PROBE_METHOD = 'user.current';
  /** 探测周期。10 秒是"看起来是活的"与"别把后端当靶子"之间的折中。 */
  const PROBE_INTERVAL_MS = 10_000;

  const probeState = ref<'idle' | 'ok' | 'failed'>('idle');
  const probeError = shallowRef<BridgeError | undefined>(undefined);
  const lastProbeAt = ref(0);

  let probeTimer: number | null = null;

  /** 只有**链路级**失败才算"服务不正常"。 */
  function isLinkFailure(error: BridgeError): boolean {
    switch (error.messageKey) {
      case 'bridge.timeout':
      case 'bridge.connectTimeout':
      case 'bridge.closed':
      case 'bridge.reconnectGaveUp':
      case 'bridge.backendUnreachable':
        return true;
      default:
        break;
    }
    if (error.code === BridgeErrorCode.BACKEND_UNREACHABLE) {
      return true;
    }
    // 后端 5xx：链路通但服务确实坏了 —— 也算不正常
    if (error.code.startsWith('HTTP-5')) {
      return true;
    }
    /*
     * **业务拒绝不算链路故障**：`AUTH-*` / `VAL-*` / `RES-*` / 参数错误都说明
     * 请求走到后端并被处理了。把它们算成"服务异常"会让一次正常的权限拒绝
     * 在顶栏变成红灯 —— 那才是"显示不真实"。
     */
    return false;
  }

  /**
   * 是不是**传输层**失败（区别于"后端服务坏了"）。
   *
   * 判据比 `isLinkFailure` 窄：HTTP-5xx 不算 —— 那说明 WebSocket 是通的、
   * 后端在处理请求并回了 500，此时把连接丢掉重连解决不了任何问题，只会多一轮握手。
   * 真正要重连的只有"包发出去没有回声"这一类。
   */
  function isTransportFailure(error: BridgeError): boolean {
    switch (error.messageKey) {
      case 'bridge.timeout':
      case 'bridge.connectTimeout':
      case 'bridge.closed':
      case 'bridge.reconnectGaveUp':
      case 'bridge.backendUnreachable':
        return true;
      default:
        return error.code === BridgeErrorCode.BACKEND_UNREACHABLE;
    }
  }

  async function probeOnce(): Promise<void> {
    const bridge = instance.value;
    if (!bridge) {
      return;
    }
    const started = performance.now();
    try {
      await bridge.call(PROBE_METHOD);
      recordLatency(performance.now() - started);
      probeState.value = 'ok';
      probeError.value = undefined;
    } catch (e) {
      const error = toBridgeError(e);
      if (isLinkFailure(error)) {
        probeState.value = 'failed';
        probeError.value = error;
        /*
         * **探到"传输层失败"就把连接丢掉**（这是"后台挂久了回来右边内容卡住"的正解）。
         *
         * 半死连接的特征：`state` 还是 `open`，可包发出去没有任何回声。
         * 不丢它的话，`ensureOpen()` 每次都认为"已经连着"，于是每一次刷新都白等满超时，
         * 界面永远停在旧数据上 —— 探针能看出问题却什么也修不了。
         *
         * 只在"传输层自认为连着"时丢：正在重连 / 已断开时再丢一次没有意义，
         * 反而会打断正在进行的退避重连。
         */
        if (isTransportFailure(error) && bridge.state === 'open') {
          bridge.reset();
        }
      } else {
        // 请求被后端处理过 = 链路是通的
        recordLatency(performance.now() - started);
        probeState.value = 'ok';
        probeError.value = undefined;
      }
    } finally {
      lastProbeAt.value = Date.now();
    }
  }

  /**
   * 从后台回到前台：**先验活、再探测**，然后由调用方 bump 一次刷新信号。
   *
   * 顺序不能反：半死的连接不会回包，直接探测要等满 15 秒才失败，
   * 用户"切回来"就盯着旧数据发呆；先做 3 秒的本地 ping 把它判死并丢掉，
   * 后面的探测走的是新连接，几十毫秒就回来了。
   */
  async function resumeAfterBackground(): Promise<void> {
    const bridge = instance.value;
    if (!bridge) {
      return;
    }
    await bridge.checkAlive();
    await probeOnce();
  }

  function stopProbe(): void {
    if (probeTimer !== null) {
      window.clearInterval(probeTimer);
      probeTimer = null;
    }
  }

  /**
   * 起一个周期探测（幂等）。`attach` 之后由应用入口调用一次。
   *
   * 两条省电/省流量的规矩：
   *  · 页面不可见时**停掉**，回到前台立刻补一次 —— 后台标签页没必要一直打后端；
   *  · 探测失败**不重试风暴**：下一个周期自然会再试。
   */
  function startProbe(): void {
    stopProbe();
    if (typeof window === 'undefined') {
      return;
    }
    void probeOnce();
    const schedule = (): void => {
      probeTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') {
          void probeOnce();
        }
      }, PROBE_INTERVAL_MS);
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible') {
      void probeOnce();
    }
  }

  function detach(): void {
    unsubscribe?.();
    unsubscribe = null;
    stopProbe();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  function attach(bridge: Bridge, bridgeOrigin: string): void {
    detach();
    instance.value = bridge;
    origin.value = bridgeOrigin;
    kind.value = bridge.kind;
    platform.value = bridge.platform;
    hostVersion.value = bridge.hostVersion;
    capabilities.value = [...bridge.capabilities];
    state.value = bridge.state;
    unsubscribe = subscribeBridgeState(bridge, (next) => {
      state.value = next;
    });
  }

  function call<T>(method: string, params?: unknown, meta?: ReqMeta): Promise<T> {
    const bridge = instance.value;
    if (!bridge) {
      throw new Error('桥尚未附着：应用入口必须先调用 useBridgeStore().attach(bridge, origin)。');
    }
    const started = performance.now();
    const pending = bridge.call<T>(method, params, meta);
    if (!method.startsWith('bridge.')) {
      // 计时不能影响调用本身：只挂一个"只读"的观察者，原始 promise 原样返回给调用方
      pending.then(
        () => recordLatency(performance.now() - started),
        () => undefined,
      );
    }
    return pending;
  }

  function supports(capability: string): boolean {
    return capabilities.value.includes(capability);
  }

  /** 订阅桥事件（如 `session.expired`）。返回取消订阅函数。 */
  function subscribe(topic: string, handler: (data: unknown) => void): () => void {
    const bridge = instance.value;
    if (!bridge) {
      return () => undefined;
    }
    return bridge.subscribe(topic, handler);
  }

  /** 订阅连接状态。返回取消订阅函数（未附着时是无操作）。 */
  function onStateChange(handler: (next: ConnectionState) => void): () => void {
    const bridge = instance.value;
    if (!bridge) {
      return () => undefined;
    }
    return bridge.onStateChange(handler);
  }

  const isOpen = (): boolean => state.value === 'open';

  /**
   * **真实健康状态** —— 顶栏芯片与顶部横幅都读它。
   *
   * 判据的顺序是有意的：
   *  1. **传输层状态优先**：断开/重连中时，无论上一次探测是不是成功，都不该显示"正常"
   *     （这正是"出了问题还显示正常"的来源）；
   *  2. 传输层正常时看**最近一次探测**：失败即"异常"，并把错误码一起带出去；
   *  3. 还没探测过 = "检测中"，**不假装正常**。
   *
   * 失败是**粘性**的：只有下一次探测成功才会回到"正常"，不会自己恢复。
   */
  const health = computed<{ status: HealthStatus; reason: string; code: string | undefined }>(() => {
    if (state.value === 'closed') {
      return { status: 'down', reason: '与本地服务的连接已断开', code: probeError.value?.code };
    }
    if (state.value === 'reconnecting') {
      return { status: 'degraded', reason: '正在重连本地服务', code: undefined };
    }
    if (state.value === 'connecting' || state.value === 'idle') {
      return { status: 'unknown', reason: '正在连接本地服务', code: undefined };
    }
    if (probeState.value === 'failed') {
      return { status: 'down', reason: '本地服务探测失败', code: probeError.value?.code };
    }
    if (probeState.value === 'ok') {
      return { status: 'ok', reason: '正常', code: undefined };
    }
    return { status: 'unknown', reason: '正在检测本地服务', code: undefined };
  });

  return {
    instance,
    origin,
    state,
    capabilities,
    kind,
    platform,
    hostVersion,
    latencyMs,
    health,
    probeError,
    lastProbeAt,
    attach,
    detach,
    call,
    supports,
    subscribe,
    onStateChange,
    isOpen,
    startProbe,
    stopProbe,
    probeOnce,
    resumeAfterBackground,
  };
});

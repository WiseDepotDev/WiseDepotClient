import {
  BridgeError,
  BridgeErrorCode,
  HANDSHAKE_PATH,
  MAX_BIN_BYTES,
  MAX_FRAME_BYTES,
  type BridgeBootstrap,
  type BridgeFrame,
  type ReqFrame,
  type ReqMeta,
} from './types.js';
import { bodyLength, decodeFrame, encodeFrame, WIRE_HEADER_BYTES, WIRE_MAX_ID_BYTES, WireDecodeError } from './wire.js';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * 连接重新打开时，这一屏要不要重取一次。
 *
 * ## 为什么"还在等"也必须重取（这是"打开一直转"没修干净的那一半）
 *
 * 上一轮只处理了**错误态**：连接恢复时把已经失败的屏救回来。但真正让用户看到
 * "卡在骨架屏"的是**尚未结算**的那一类 —— 请求是在连接还没建好时发出去的，
 * 它绑的那条连接已经不在，却要等满 `callTimeoutMs`（15s）才会 reject。
 * 于是连接明明 1 秒就通了，屏幕还要空转十几秒：
 * 用户看到的仍然"卡加载"，只是这次有个上限。
 *
 * ## 判据为什么是"在断开时发出的"，而不是"还在等"
 *
 * 只看"还在等"会**把连接抖动放大成永久骨架屏**：连接每 open 一次就重取一次，
 * 而每次重取又处在"还在等"状态 —— 抖动比调用返回还快时，这一屏永远 settle 不了。
 *
 * 所以看的是**这次调用发出去时连接是不是 open**：
 *   · 断开时发出的调用绑着一条已不存在的连接（`failPending` 根本没见过它，
 *     因为发送前就失败了），连上就该重来；
 *   · 连上之后重取的那一次是在 open 状态下发出的，它不会再触发下一次 ——
 *     **每次断线最多重取一次**，抖动不会自我放大；
 *   · 已经在展示数据的屏两样都不满足，连上时一次请求都不会发。
 *
 * 连上之后又断掉的那种，走的是 `failed`（传输层 `failPending` 会把它 reject 掉），
 * 不需要 `pending` 这一路来兜。
 *
 * 这条规则被 `tools/check/check-reconnect-refetch.mjs` 钉住 —— 它是本 bug 的回归。
 */
export function shouldRefetchOnOpen(
  state: ConnectionState,
  has: { failed: boolean; startedWhileDisconnected: boolean },
): boolean {
  return state === 'open' && (has.failed || has.startedWhileDisconnected);
}

/** 传输抽象。WS 是唯一生产实现；mock 只服务开发态（见 mock.ts 顶部说明）。 */
export interface BridgeTransport {
  readonly kind: 'ws' | 'mock';
  readonly state: ConnectionState;
  call<T>(method: string, params?: unknown, meta?: ReqMeta): Promise<T>;
  subscribe(topic: string, handler: (data: unknown) => void): () => void;
  onStateChange(handler: (state: ConnectionState) => void): () => void;
  /**
   * 验活：发一个**本地** ping（不经后端），确认这条连接真的还能收发。
   *
   * 为什么必须有它：WebSocket 会**半死** —— 应用被切到后台、机器休眠、NAT 超时，
   * TCP 那头早就没了，本地 `readyState` 却还是 `OPEN`，`onclose` 永远不会来。
   * 此时 `ensureOpen()` 认为"已经连着"，于是每次调用都发进黑洞，只能等满
   * `callTimeoutMs` 才报错；而报错之后**没有人重连**，界面就永久停在旧数据上：
   * 左栏能点、右栏内容不动 —— 用户报的正是这个。
   *
   * 返回 `false` 表示"这条连接不可信"（实现会**顺手丢掉它**，下一次调用重新建连）。
   */
  checkAlive(timeoutMs?: number): Promise<boolean>;
  /** 丢弃当前连接（不问它是否愿意）：下一次调用重新建连。 */
  reset(): void;
  close(): void;
}

export interface WebSocketTransportOptions {
  /** 单次调用超时。作业现场网络抖动多，超时要给重试按钮留出空间（不要设成"永不超时"）。 */
  readonly callTimeoutMs?: number;
  /**
   * **单次建连**超时。
   *
   * 为什么必须单独给一个：TCP 连接可能既不成功也不失败（丢包、黑洞地址、
   * WSA 的 loopback0 之类的怪环境），而操作系统的连接超时是**分钟级**的 ——
   * 那段时间里界面只能一直转骨架，用户以为应用坏了。
   * 有它才能把"连不上"变成一条明确的可重试错误。
   */
  readonly connectTimeoutMs?: number;
  /** 重连退避上限。 */
  readonly maxBackoffMs?: number;
  /** 连续失败多少次后放弃（放弃后 state=closed，UI 显示"桥已断开"）。 */
  readonly maxAttempts?: number;
  /** 宿主重启后刷新端口/token；返回 null 时保留旧引导并让本次连接自然失败重试。 */
  readonly refreshBootstrap?: () => Promise<BridgeBootstrap | null>;
  /**
   * 本壳声明的上限（来自 `__bridge.json.limits`）。
   *
   * 缺省回落到协议常量：**不硬编码**是 v4 的改进点之一 —— 客户端在发之前就知道能不能发，
   * 而不是靠撞上限来学习（v3 的表现是"只发了张图，却收到 FRAME_TOO_LARGE"）。
   */
  readonly limits?: {
    readonly textMaxBytes?: number;
    readonly binMaxBytes?: number;
  };
}

/**
 * Web 侧单次调用的总预算（毫秒）—— **整条超时链的最外层**。
 *
 * 超时必须是一条有大小关系的链，而不是三处各写一个数（见 docs/troubleshooting.md §二·补 第三轮）：
 *
 * ```
 * 后端建连 5000  <  后端读写 8000  <  后端整次调用 10000  <  这里的 15000
 * ```
 *
 * **为什么要大小关系**：内层先到时，失败原因（连接被拒 / 读超时 / DNS）才回得来，
 * 桥侧那条**带原因的日志**才会打；外层先到时，用户只看到一句"请求超时"，
 * 而日志里一条失败记录都没有 —— 排障只能靠猜，第三轮就是这么卡住的。
 *
 * 这个数与 Kotlin 侧的三个常量由 `tools/check/check-timeout-budget.mjs` 跨语言对账：
 * 改一边而不改另一边，门禁直接失败。
 */
export const BRIDGE_CALL_TIMEOUT_MS = 15_000;

/**
 * 从后台回来时那次**验活**的预算（毫秒）。
 *
 * 为什么必需一个单独的小预算：半死的连接不会回包，用默认的 15 秒去试，
 * 用户"切回来"要盯着旧数据看十几秒 —— 那正是这个 bug 的体感。
 * 3 秒足够一次本地 loopback 往返（真机上实测 1–20ms），又短到值得等。
 */
export const BRIDGE_LIVENESS_TIMEOUT_MS = 3_000;

const DEFAULTS = {
  callTimeoutMs: BRIDGE_CALL_TIMEOUT_MS,
  connectTimeoutMs: 6_000,
  maxBackoffMs: 5_000,
  maxAttempts: 6,
  refreshBootstrap: undefined,
  limits: undefined,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/*
 * v3 这里有一个 `isBridgeFrame(value)`：按 JSON 字段（`v`/`type`/`ok`）校验入站文本。
 * v4 把它删了 —— 线格式的校验现在是**解码器**的职责（`wire.ts` 的 `decodeFrame` 抛 `WireDecodeError`），
 * 再留一份字段级校验就是第二个定义同一件事的地方。
 */

/**
 * 生产传输：`ws://127.0.0.1:{port}{HANDSHAKE_PATH}?token=…`。
 *
 * 三个刻意的设计：
 * 1. **惰性连接**：第一个 call 才建连，避免应用启动时多一次握手。
 * 2. **pending 表按 id 关联**：req/res 是异步的，id 是唯一的关联依据。
 * 3. **断线后重订阅**：事件订阅是 UI 的长期需求，重连必须自动恢复，不能靠调用方重来。
 */
export class WebSocketTransport implements BridgeTransport {
  readonly kind = 'ws' as const;

  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }>();
  private readonly topics = new Map<string, Set<(data: unknown) => void>>();
  private readonly stateHandlers = new Set<(s: ConnectionState) => void>();
  private readonly opts: {
    readonly callTimeoutMs: number;
    readonly connectTimeoutMs: number;
    readonly maxBackoffMs: number;
    readonly maxAttempts: number;
    readonly refreshBootstrap: (() => Promise<BridgeBootstrap | null>) | undefined;
    readonly limits: { readonly textMaxBytes?: number; readonly binMaxBytes?: number } | undefined;
  };
  private currentState: ConnectionState = 'idle';
  private connecting: Promise<void> | null = null;
  private cancelReconnect: (() => void) | null = null;
  private attempts = 0;
  private seq = 0;

  constructor(
    private bootstrap: BridgeBootstrap,
    options: WebSocketTransportOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  async call<T>(method: string, params?: unknown, meta?: ReqMeta): Promise<T> {
    return await this.callWithBudget<T>(method, params, meta, this.opts.callTimeoutMs);
  }

  /**
   * 验活（见 `BridgeTransport.checkAlive`）。
   *
   * 用的方法是桥的**内建** `bridge.ping`（`BridgeBuiltins.PING`）：不经后端、不改状态，
   * 因此"验活"这件事本身不会给后端带来任何负载 —— 它测的正是"这条 WebSocket 还能不能收发"。
   */
  async checkAlive(timeoutMs: number = BRIDGE_LIVENESS_TIMEOUT_MS): Promise<boolean> {
    try {
      await this.callWithBudget('bridge.ping', undefined, undefined, timeoutMs);
      return true;
    } catch {
      this.reset();
      return false;
    }
  }

  reset(): void {
    const socket = this.socket;
    this.socket = null;
    this.attempts = 0;
    if (socket) {
      // 只掐"回包"通道：这条连接已经不可信，但它在建连途中时要能自己收尾
      socket.onmessage = null;
      if (socket.readyState === WebSocket.OPEN) {
        // 已经 open 过 = 它的 settle 早结算完了，onclose 再走一遍重连分支只会多开一条连接
        socket.onclose = null;
      }
      try {
        socket.close();
      } catch {
        /* 已经掉了就算了 */
      }
    }
    this.failPending();
    if (this.currentState !== 'closed') {
      // 不说"已断开"（用户没做错什么，而且下一次调用就会重连），说"重连中"才是真的
      this.setState('reconnecting');
    }
  }

  private async callWithBudget<T>(method: string, params: unknown, meta: ReqMeta | undefined, timeoutMs: number): Promise<T> {
    const id = `c-${++this.seq}`;

    /*
     * **计时从进入 call 就开始，而不是从"发出去"才开始。**
     *
     * 踩过的坑：原先的写法是 `await this.ensureOpen()` 之后才起计时器，于是建连阶段
     * 完全没有超时 —— 连接一卡（TCP 既不成功也不失败，OS 级超时是分钟级），
     * 调用就永远不 settle：界面永远转骨架、连报错都没有，
     * 而"切走再切回来"因为连接已经建好就正常了。这正是用户报的现象。
     *
     * 现在连接 + 发送 + 等回复共用同一个预算：无论如何，调用都会在
     * `callTimeoutMs` 内给出结果（成功或可重试的错误）。
     */
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        settled = true;
        this.pending.delete(id);
        reject(new BridgeError({ code: BridgeErrorCode.BACKEND_UNREACHABLE, messageKey: 'bridge.timeout', retryable: true }));
      }, timeoutMs);

      const fail = (e: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        reject(e);
      };

      void this.ensureOpen()
        .then(() => {
          if (settled) {
            return;
          }
          const frame: ReqFrame = {
            type: 'req',
            id,
            method,
            ...(params === undefined ? {} : { params }),
            ...(meta === undefined ? {} : { meta }),
          };
          const bytes = encodeFrame(frame);
          // v4：上限按**正文**算，且以引导下发的 limits 为准（缺省才用协议常量）
          const textMaxBytes = this.opts.limits?.textMaxBytes ?? MAX_FRAME_BYTES;
          if (bodyLength(bytes) > textMaxBytes) {
            fail(new BridgeError({ code: BridgeErrorCode.FRAME_TOO_LARGE, messageKey: 'bridge.frameTooLarge' }));
            return;
          }
          // 先登记 pending 再发：否则极快的回复会找不到接收者
          this.pending.set(id, {
            resolve: ((v: unknown) => {
              if (settled) {
                return;
              }
              settled = true;
              globalThis.clearTimeout(timer);
              resolve(v as T);
            }) as (v: unknown) => void,
            reject: fail,
            timer: timer as unknown as number,
          });
          this.socket?.send(bytes);
        })
        .catch(fail);
    });
  }

  subscribe(topic: string, handler: (data: unknown) => void): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.topics.delete(topic);
      }
    };
  }

  close(): void {
    this.setState('closed');
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.socket?.close();
    this.socket = null;
    this.failPending();
  }

  // ------------------------------------------------------------ 内部

  private setState(s: ConnectionState): void {
    if (this.currentState === s) {
      return;
    }
    this.currentState = s;
    for (const h of this.stateHandlers) {
      h(s);
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  private open(): Promise<void> {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    return (async (): Promise<void> => {
      const refreshed = await this.opts.refreshBootstrap?.();
      if (refreshed) {
        this.bootstrap = refreshed;
      }
      return await new Promise<void>((resolve, reject) => {
      // host 由宿主下发（见 BridgeBootstrap.host）；缺省回退 127.0.0.1 以兼容旧宿主。
      const host = this.bootstrap.host ?? '127.0.0.1';
      const url = `ws://${host}:${this.bootstrap.port}${HANDSHAKE_PATH}?token=${encodeURIComponent(this.bootstrap.token)}`;
      const socket = new WebSocket(url);
      this.socket = socket;

      /*
       * 单次建连也要有上限。WebSocket 可能**既不 onopen 也不 onclose**：
       * 对端丢包、地址是黑洞、或所在环境（例如 WSA 的 loopback0）把包吞了。
       * 那时候 OS 的连接超时是分钟级 —— 没有这个定时器，用户只能一直看骨架。
       */
      let settled = false;
      const connectTimer = globalThis.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        // 主动关掉，让 onclose 不要再走重连分支（这次由我们判定为超时）
        try {
          socket.close();
        } catch {
          /* 已经关了就算了 */
        }
        this.socket = null;
        /*
         * **不是直接失败，而是当作"这次尝试失败"交给重连逻辑。**
         *
         * 区别很重要：直接失败只解决"不再永远挂着"，却把"自愈"也一起丢了 ——
         * 用户得自己点重试。交给重连之后：单次尝试有上限（不会再挂住），
         * 后台按退避继续试，连上时 `state` 变成 open，
         * 正在错误态的屏会自动重取（见 `useBridgeCall` 的状态订阅）。
         *
         * 整次调用的上限由 `callTimeoutMs` 兜（它从进入 call 就开始计时），
         * 所以用户不会等超过那个预算。
         */
        void this.scheduleReconnect(resolve, reject);
      }, this.opts.connectTimeoutMs);

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(connectTimer);
        fn();
      };

      socket.onopen = () => {
        this.attempts = 0;
        this.setState('open');
        settle(resolve);
      };
      // v4：线上全是二进制消息。`arraybuffer` 让我们拿到字节（缺省是 Blob，还要异步读一次）
      socket.binaryType = 'arraybuffer';
      socket.onmessage = (ev) => this.dispatch(ev.data);
      socket.onerror = () => {
        // onerror 之后一定会有 onclose，统一在 onclose 里做重试判定
      };
      socket.onclose = () => {
        this.socket = null;
        this.failPending();
        if (this.currentState === 'closed') {
          settle(() => reject(new BridgeError({ code: BridgeErrorCode.UNAUTHORIZED, messageKey: 'bridge.closed' })));
          return;
        }
        settle(() => {
          void this.scheduleReconnect(resolve, reject);
        });
      };
      });
    })();
  }

  private async scheduleReconnect(resolve: () => void, reject: (e: unknown) => void): Promise<void> {
    this.attempts += 1;
    if (this.attempts > this.opts.maxAttempts) {
      this.setState('closed');
      reject(new BridgeError({ code: BridgeErrorCode.BACKEND_UNREACHABLE, messageKey: 'bridge.reconnectGaveUp', retryable: true }));
      return;
    }
    this.setState('reconnecting');
    const wait = Math.min(this.opts.maxBackoffMs, 300 * 2 ** (this.attempts - 1));
    const canRetry = await new Promise<boolean>((resolve) => {
      const timer = globalThis.setTimeout(() => {
        this.cancelReconnect = null;
        resolve(true);
      }, wait);
      this.cancelReconnect = () => {
        globalThis.clearTimeout(timer);
        this.cancelReconnect = null;
        resolve(false);
      };
    });
    if (!canRetry || this.currentState === 'closed') {
      reject(new BridgeError({ code: BridgeErrorCode.UNAUTHORIZED, messageKey: 'bridge.closed' }));
      return;
    }
    try {
      await this.open();
      resolve();
    } catch (e) {
      reject(e);
    }
  }

  private dispatch(data: unknown): void {
    if (typeof data === 'string') {
      // 文本帧：v4 只走二进制 —— 壳会回一条 WIRE_MODE 错误帧，而这里收到的是**裸文本**，
      // 说明两端不是同一版协议。记一条、别静默。
      this.setState('closed');
      return;
    }
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (bytes === null) {
      return;
    }
    // 入站防御：壳不该发超过它自己声明的数据面上限（真发了说明有 bug，早关好过先把内存吃满）
    const binMaxBytes = this.opts.limits?.binMaxBytes ?? MAX_BIN_BYTES;
    if (bytes.length > binMaxBytes + WIRE_HEADER_BYTES + WIRE_MAX_ID_BYTES) {
      this.socket?.close(1009, 'frame too large');
      return;
    }

    let frame: BridgeFrame;
    try {
      frame = decodeFrame(bytes);
    } catch (e) {
      if (e instanceof WireDecodeError) {
        // 结构不合法：不猜、不静默。把在途调用判失败（重连会拿到新引导），并留一条线索。
        this.failPending();
      }
      return;
    }

    switch (frame.type) {
      case 'res': {
        const entry = this.pending.get(frame.id);
        if (!entry) {
          return;
        }
        globalThis.clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        entry.resolve(frame.data);
        return;
      }
      case 'err': {
        const entry = this.pending.get(frame.id);
        if (!entry) {
          return;
        }
        globalThis.clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        entry.reject(new BridgeError(frame.error));
        return;
      }
      case 'evt': {
        const handlers = this.topics.get(frame.topic);
        if (!handlers) {
          return;
        }
        for (const h of handlers) {
          h(frame.data);
        }
        return;
      }
      default:
        return;
    }
  }

  private failPending(): void {
    for (const [, entry] of this.pending) {
      globalThis.clearTimeout(entry.timer);
      entry.reject(new BridgeError({ code: BridgeErrorCode.BACKEND_UNREACHABLE, messageKey: 'bridge.disconnected', retryable: true }));
    }
    this.pending.clear();
  }
}

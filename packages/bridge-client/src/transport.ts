import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  BridgeErrorCode,
  HANDSHAKE_PATH,
  MAX_FRAME_BYTES,
  type BridgeBootstrap,
  type BridgeFrame,
  type ReqMeta,
} from './types.js';

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
}

const DEFAULTS = { callTimeoutMs: 15_000, connectTimeoutMs: 6_000, maxBackoffMs: 5_000, maxAttempts: 6 } as const;

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
  private readonly opts: Required<WebSocketTransportOptions>;
  private currentState: ConnectionState = 'idle';
  private connecting: Promise<void> | null = null;
  private attempts = 0;
  private seq = 0;

  constructor(
    private readonly bootstrap: BridgeBootstrap,
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
      }, this.opts.callTimeoutMs);

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
          const frame = {
            v: BRIDGE_PROTOCOL_VERSION,
            type: 'req' as const,
            id,
            method,
            ...(params === undefined ? {} : { params }),
            ...(meta === undefined ? {} : { meta }),
          };
          const text = JSON.stringify(frame);
          if (text.length > MAX_FRAME_BYTES) {
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
          this.socket?.send(text);
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
    this.socket?.close();
    this.socket = null;
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
    return new Promise<void>((resolve, reject) => {
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
      socket.onmessage = (ev) => this.dispatch(String(ev.data));
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
    await new Promise((r) => setTimeout(r, wait));
    try {
      await this.open();
      resolve();
    } catch (e) {
      reject(e);
    }
  }

  private dispatch(text: string): void {
    let frame: BridgeFrame;
    try {
      frame = JSON.parse(text) as BridgeFrame;
    } catch {
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

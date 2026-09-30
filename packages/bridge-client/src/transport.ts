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
  /** 重连退避上限。 */
  readonly maxBackoffMs?: number;
  /** 连续失败多少次后放弃（放弃后 state=closed，UI 显示"桥已断开"）。 */
  readonly maxAttempts?: number;
}

const DEFAULTS = { callTimeoutMs: 15_000, maxBackoffMs: 5_000, maxAttempts: 6 } as const;

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
    await this.ensureOpen();
    const id = `c-${++this.seq}`;
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
      throw new BridgeError({ code: BridgeErrorCode.FRAME_TOO_LARGE, messageKey: 'bridge.frameTooLarge' });
    }

    return await new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError({ code: BridgeErrorCode.BACKEND_UNREACHABLE, messageKey: 'bridge.timeout', retryable: true }));
      }, this.opts.callTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket?.send(text);
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
      const url = `ws://127.0.0.1:${this.bootstrap.port}${HANDSHAKE_PATH}?token=${encodeURIComponent(this.bootstrap.token)}`;
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        this.attempts = 0;
        this.setState('open');
        resolve();
      };
      socket.onmessage = (ev) => this.dispatch(String(ev.data));
      socket.onerror = () => {
        // onerror 之后一定会有 onclose，统一在 onclose 里做重试判定
      };
      socket.onclose = () => {
        this.socket = null;
        this.failPending();
        if (this.currentState === 'closed') {
          reject(new BridgeError({ code: BridgeErrorCode.UNAUTHORIZED, messageKey: 'bridge.closed' }));
          return;
        }
        void this.scheduleReconnect(resolve, reject);
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
        window.clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        entry.resolve(frame.data);
        return;
      }
      case 'err': {
        const entry = this.pending.get(frame.id);
        if (!entry) {
          return;
        }
        window.clearTimeout(entry.timer);
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
      window.clearTimeout(entry.timer);
      entry.reject(new BridgeError({ code: BridgeErrorCode.BACKEND_UNREACHABLE, messageKey: 'bridge.disconnected', retryable: true }));
    }
    this.pending.clear();
  }
}

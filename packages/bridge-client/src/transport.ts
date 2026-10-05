import {
  BridgeError,
  BridgeErrorCode,
  HANDSHAKE_PATH,
  MAX_BIN_BYTES,
  MAX_FRAME_BYTES,
  type BridgeBootstrap,
  type BridgeFrame,
  type HelloFrame,
  type ReqFrame,
  type ReqMeta,
} from './types.js';
import { fromHex, hexOf, SealError, SealSession, generateEphemeral, sessionKeys, sharedSecret, type Bytes } from './seal.js';
import {
  bodyLength,
  decodeFrame,
  encodeFrame,
  isHelloFrame,
  openFrame,
  sealFrame,
  WIRE_SEALED_OVERHEAD_BYTES,
  WireDecodeError,
} from './wire.js';

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

/**
 * **后台保活**间隔（毫秒）——只在页面不可见时使用。
 *
 * ## 为什么需要它
 *
 * 桥会把**读空闲超过 60 秒**的连接关掉（`BridgeServerConfig.readerIdleMs`：那是为"对端
 * 进程被杀但没发 FIN"准备的）。而应用的自动刷新探测**只在页面可见时跑**（这是刻意的：
 * 后台标签页不该一直刷后端）。两者叠起来的后果是：**切到后台超过 60 秒，连接必被桥关掉**，
 * 切回来时先验活、发现连接没了、再重连 —— 用户看到的就是"怎么老是断"。
 *
 * 这一条只解决"链路"这件事：它发的是桥的**内建** `bridge.ping`（不经后端、不改任何状态），
 * 所以没有推翻"后台不刷后端"的决定 —— 前台由应用探测保活（10 秒一次），
 * 后台由这里保活（30 秒一次），两件事分开说清楚了。
 *
 * ## 为什么是 30 秒
 *
 * 必须显著小于桥的读空闲（60 秒）才留得出余量：浏览器对隐藏页面的定时器有节流
 * （Chromium 在隐藏 5 分钟后会降到**约每分钟一次**），所以真要靠它保活，
 * 桌面壳还必须关掉 `backgroundThrottling`（见 `apps/desktop/src/main.ts`）。
 * 手机 WebView 在 Activity 暂停时可能整个冻结 JS —— 那时保活发不出去，
 * 退回"回到前台重连一次"（那条路已经是干净的单次重连）。
 */
export const BRIDGE_KEEPALIVE_INTERVAL_MS = 30_000;

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
 * 生产传输：`ws://127.0.0.1:{port}{HANDSHAKE_PATH}?k=…`（v5：帧内容全加密）。
 *
 * 四个刻意的设计：
 * 1. **惰性连接**：第一个 call 才建连，避免应用启动时多一次握手。
 * 2. **pending 表按 id 关联**：req/res 是异步的，id 是唯一的关联依据。
 * 3. **断线后重订阅**：事件订阅是 UI 的长期需求，重连必须自动恢复，不能靠调用方重来。
 * 4. **每条连接的密钥都是新的**：建连时生成临时 ECDH 密钥对，把公钥挂在 `?k=` 上，
 *    服务端回一条明文 `hello`（它的临时公钥），两边各自算出会话密钥 ——
 *    于是"重连"天然换密钥，序号可以从 1 重来（**绝不能跨连接复用 `(key, nonce)`**）。
 *
 * **URL 上没有任何凭据**（v5）：psk 只在引导文件里，认证靠"能产出合法密文帧"。
 *
 * ## 收发都必须**串行**
 *
 * WebCrypto 是异步的：两个响应同一 tick 到达时，`decrypt` 的完成顺序没有保证。
 * 序号水位（防重放）与"发送顺序 == 序号顺序"这两件事都要求**按到达顺序处理**，
 * 所以两个方向各挂一条 promise 链（`inboundChain` / `outboundChain`）。
 * 少了这条链的两个后果都很隐蔽：重放检测的 watermark 会倒退；
 * 或者两个响应以相反顺序上线，接收端因为"序号回退"直接断连。
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

  /** v5：本连接的加密封装。**null 表示还没收到 hello**（此时一条帧都不该发）。 */
  private session: SealSession | null = null;

  /** 两个方向的串行链（见类注释）。 */
  private inboundChain: Promise<unknown> = Promise.resolve();
  private outboundChain: Promise<unknown> = Promise.resolve();

  /**
   * 后台保活定时器（只在页面不可见时真的发；见 [BRIDGE_KEEPALIVE_INTERVAL_MS]）。
   *
   * 类型用 `ReturnType<typeof setInterval>` 而不是 `number`：这个包同时被浏览器与 Node 侧
   * （S6 的 E2E）引用，两边的 `setInterval` 返回类型不同 —— 写死 `number` 会在类型检查里炸。
   */
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

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
    // v5：连接没了，会话密钥跟着丢 —— 下次建连会换一套临时密钥（绝不复用 (key, nonce)）
    this.session = null;
    this.stopKeepAlive();
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
        .then(async () => {
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
          // 上限按**明文正文**算（与桥侧 preflight 的口径一致），且以引导下发的 limits 为准
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
          const sealed = await this.sealOut(bytes);
          if (settled) {
            // 加密期间调用已经超时/被取消：登记过的 pending 要收回，别让它挂在这里
            this.pending.delete(id);
            return;
          }
          this.socket?.send(sealed);
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
    this.session = null;
    this.stopKeepAlive();
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
    if (this.socket?.readyState === WebSocket.OPEN && this.session !== null) {
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

      /*
       * v5：每条连接一套**临时** ECDH 密钥对（前向保密的来源，也是"序号可以从 1 重来"的前提）。
       *
       * 拿不到 `crypto.subtle`（不是安全上下文）时明确失败：**不退回明文**。
       * 那种"看起来连上了、其实没有保密"的状态比连不上更难查。
       */
      let ephemeral;
      try {
        ephemeral = await generateEphemeral();
      } catch (e) {
        throw cryptoFailure(e);
      }

      return await new Promise<void>((resolve, reject) => {
      // host 由宿主下发（见 BridgeBootstrap.host）；缺省回退 127.0.0.1 以兼容旧宿主。
      const host = this.bootstrap.host ?? '127.0.0.1';
      // v5：URL 上**只有**客户端临时公钥（`k`，hex 的未压缩点）—— 没有任何凭据
      const url = `ws://${host}:${this.bootstrap.port}${HANDSHAKE_PATH}?k=${hexOf(ephemeral.publicKey)}`;
      const socket = new WebSocket(url);
      this.socket = socket;

      /*
       * 单次建连也要有上限。WebSocket 可能**既不 onopen 也不 onclose**：
       * 对端丢包、地址是黑洞、或所在环境（例如 WSA 的 loopback0）把包吞了。
       * 那时候 OS 的连接超时是分钟级 —— 没有这个定时器，用户只能一直看骨架。
       *
       * v5：这个上限同时覆盖"升级 + 收 hello + 派生密钥"，因为**只有密钥就绪才算连上**。
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
        /*
         * **这里不置 open**：WS 升级成功只说明"字节能来回"，还不能收发任何桥帧 ——
         * 必须等 hello 到达、密钥派生完成。等到的路径在 `onWire` 里。
         */
      };
      // 线上全是二进制消息。`arraybuffer` 让我们拿到字节（缺省是 Blob，还要异步读一次）
      socket.binaryType = 'arraybuffer';
      socket.onmessage = (ev) => this.onWire(ev.data, ephemeral, settle, resolve, reject);
      socket.onerror = () => {
        // onerror 之后一定会有 onclose，统一在 onclose 里做重试判定
      };
      socket.onclose = () => {
        this.socket = null;
        this.session = null;
        this.stopKeepAlive();
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

  /**
   * 一条入站消息（v5：握手阶段的 hello，与运行阶段的密文帧走同一个入口）。
   *
   * hello 之前**只接受 hello**：先收到任何别的东西（明文帧、垃圾字节）都说明两端不是一版，
   * 直接按 `BRIDGE_WIRE_MODE` 失败 —— 不猜、不静默。
   */
  private onWire(
    data: unknown,
    ephemeral: { readonly publicKey: Bytes; readonly privateKey: CryptoKey },
    settle: (fn: () => void) => void,
    resolve: () => void,
    reject: (e: unknown) => void,
  ): void {
    const bytes = asBytes(data);
    if (bytes === null) {
      // 文本帧：v5 只走二进制。收到裸文本说明两端不是一版 —— 记一条、别静默。
      settle(() => reject(new BridgeError({ code: BridgeErrorCode.WIRE_MODE, messageKey: 'bridge.wireMode' })));
      return;
    }

    if (this.session === null) {
      if (!isHelloFrame(bytes)) {
        settle(() =>
          reject(
            new BridgeError({
              code: BridgeErrorCode.WIRE_MODE,
              messageKey: 'bridge.wireMode',
              details: '握手第一条帧不是 hello',
            }),
          ),
        );
        return;
      }
      void this.completeHandshake(bytes, ephemeral, settle, resolve, reject);
      return;
    }

    // 运行阶段：解封要串行（见类注释），失败即断开这条连接
    //
    // **把 session 捕获下来**：链上的任务是稍后执行的，那时 `this.session` 可能已经被
    // `reset()`/`failCrypto()` 置空（现场表现为 `Cannot read properties of null (reading 'open')`
    // —— 一条"加解密失败"的噪音，掩盖了真正的原因）。
    const session = this.session;
    const run = this.inboundChain.then(async () => {
      const inner = await openFrame(bytes, session);
      this.dispatch(inner);
    });
    this.inboundChain = run.catch((e: unknown) => {
      this.failCrypto(e);
    });
  }

  /** 收 hello → 派生会话密钥 → 才把这次建连算成功（`state` 置 open）。 */
  private async completeHandshake(
    helloBytes: Bytes,
    ephemeral: { readonly publicKey: Bytes; readonly privateKey: CryptoKey },
    settle: (fn: () => void) => void,
    resolve: () => void,
    reject: (e: unknown) => void,
  ): Promise<void> {
    try {
      const frame = decodeFrame(helloBytes);
      if (frame.type !== 'hello') {
        throw new SealError('握手第一条帧不是 hello');
      }
      const serverPublicKey = fromHexHex(frame.publicKeyHex);
      const shared = await sharedSecret(ephemeral.privateKey, serverPublicKey);
      const keys = await sessionKeys(pskBytes(this.bootstrap.psk), ephemeral.publicKey, serverPublicKey, shared);
      const session = new SealSession(keys, 'client');
      this.session = session;
      this.inboundChain = Promise.resolve();
      this.outboundChain = Promise.resolve();
      settle(() => {
        this.attempts = 0;
        this.setState('open');
        resolve();
      });
      /*
       * **握手之后立刻说一句话**（一条 `bridge.ping`，回复按 id 丢弃）。
       *
       * 为什么必须有它（这不是"顺手的心跳"）：
       *  · 桥侧的预认证池有 1.5 秒截止 —— 迟迟不说一句话的连接会被当成"占位"关掉。
       *    而客户端的**自愈重连是主动建连的**（没有等待中的请求），于是那些连接一条帧都不发，
       *    刚建好就被桥关掉，客户端又去重连 —— 现场表现就是"反复正在重连本地服务"。
       *  · 顺带还证明这条通道真的能收发（密钥、序号、封装全对），比"看着连上了"可靠。
       */
      void this.sealOut(encodeFrame({ type: 'req', id: `auth-${this.seq + 1}`, method: 'bridge.ping' }))
        .then((sealed) => {
          if (this.session === session) {
            this.socket?.send(sealed);
          }
        })
        .catch(() => {
          /* 发不出去就交给 onclose/重连处理，这里不额外报错 */
        });

      // 后台保活：连接可用期间一直挂着，但**只在页面不可见时真的发**（见常量的说明）
      this.startKeepAlive();
    } catch (e) {
      settle(() => reject(cryptoFailure(e)));
    }
  }

  /** 串行地加密一条出站消息（顺序必须与序号顺序一致，见类注释）。 */
  private async sealOut(inner: Bytes): Promise<Bytes> {
    const session = this.session;
    if (session === null) {
      throw new BridgeError({ code: BridgeErrorCode.CRYPTO_FAILED, messageKey: 'bridge.cryptoFailed', retryable: true });
    }
    const run = this.outboundChain.then(async () => await sealFrame(inner, session));
    this.outboundChain = run.catch(() => undefined);
    return await run;
  }

  /**
   * 加解密失败：这条连接已经不可信。
   *
   * 与"对端不是一版"（`WIRE_MODE`）分开：这里的两端协议版本一致，只是**密钥/序号对不上**
   * —— 出路是重连（重连会换一套临时密钥）；仍失败才说明引导文件过期。
   */
  private failCrypto(e: unknown): void {
    const detail = e instanceof Error ? e.message : String(e);
    // 把**原因**交给在途调用（cryptoFailure 的 code/messageKey/details 都在里面，见其注释）
    this.failPending(cryptoFailure(e));
    this.reset();
    // 只留一条线索，**不打印任何密钥/nonce/明文**
    globalThis.console?.warn?.(`[bridge] 加解密失败，已丢弃这条连接：${detail}`);
  }

  // ------------------------------------------------------------ 后台保活

  /** 起一个保活定时器（幂等）。 */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = globalThis.setInterval(() => {
      // 只在**页面不可见**时发：前台有应用自己的 10 秒探测（user.current），
      // 这里再发一条就是同一个"保活"有了两个所有者。
      if (this.session === null || this.socket?.readyState !== WebSocket.OPEN || !isPageHidden()) {
        return;
      }
      void this.sendKeepAlive();
    }, BRIDGE_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      globalThis.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /** 一条桥内建的 `bridge.ping`：不经后端、不改状态，只为刷新桥侧的"读空闲"计时。 */
  private async sendKeepAlive(): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    try {
      // 走同一条出站链：保活帧也必须与其它帧保持序号顺序
      const sealed = await this.sealOut(encodeFrame({ type: 'req', id: `ka-${this.seq + 1}`, method: 'bridge.ping' }));
      if (this.session === session) {
        this.socket?.send(sealed);
      }
    } catch {
      /* 发不出去就交给 onclose/重连处理 */
    }
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
    // 入站防御：壳不该发超过它自己声明的数据面上限（真发了说明有 bug，早关好过先把内存吃满）。
    // v5：线上那条消息是外层（内层 + 295），所以判的是 bytes.length 而不是内层正文。
    const binMaxBytes = this.opts.limits?.binMaxBytes ?? MAX_BIN_BYTES;
    if (bytes.length > binMaxBytes + WIRE_SEALED_OVERHEAD_BYTES) {
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

  /**
   * 把所有在途调用拒掉。
   *
   * **`cause` 必须能传进来**（v5 修的）：原先这里无条件用 `bridge.disconnected`，
   * 于是"加解密失败"这条原因被抹平成"连接断了" —— 用户看到的是"桥已断开"，
   * 而真正的出路是"重新读引导文件/重试"，两者的处置完全不同。
   * 更糟的是 `errorTextOf` 里 `bridge.cryptoFailed` 那条分支**永远走不到**：
   * 一个"声明了但到不了"的错误码，比没有它更容易骗过 review。
   */
  private failPending(cause?: unknown): void {
    for (const [, entry] of this.pending) {
      globalThis.clearTimeout(entry.timer);
      entry.reject(
        cause instanceof BridgeError
          ? cause
          : new BridgeError({ code: BridgeErrorCode.BACKEND_UNREACHABLE, messageKey: 'bridge.disconnected', retryable: true }),
      );
    }
    this.pending.clear();
  }
}

/** 线上字节（`arraybuffer` 给到的可能是 ArrayBuffer，也可能是视图）。 */
function asBytes(data: unknown): Bytes | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    // 复制一份：保证底层是普通 ArrayBuffer（WebCrypto 的 BufferSource 要求），也避免视图被复用
    return Uint8Array.from(data);
  }
  return null;
}

/** psk = 引导文件里 psk 的 ASCII 字节（v5：参与 KDF，**永不上线**）。 */
function pskBytes(psk: string): Bytes {
  return new TextEncoder().encode(psk);
}

/** hex → 字节（公钥在 URL 与 hello 上都是 hex）。 */
function fromHexHex(text: string): Bytes {
  return fromHex(text);
}

/**
 * 页面是不是**不可见**（后台）。
 *
 * 非 DOM 环境（Node 里跑这个模块做 E2E）没有 `document` —— 那时按"可见"处理：
 * 保活只在真页面的后台生效，Node 里由测试自己决定要不要发。
 */
function isPageHidden(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return doc?.visibilityState === 'hidden';
}

/**
 * 加密层失败的统一出口。
 *
 * `retryable: true`：出路是重连（重连会换一套临时密钥）。仍失败才说明引导文件过期，
 * 那时候界面上的措辞由 `errorTextOf` 的 `bridge.cryptoFailed` 给出（不在这里拼文案）。
 */
function cryptoFailure(e: unknown): BridgeError {
  return new BridgeError({
    code: BridgeErrorCode.CRYPTO_FAILED,
    messageKey: 'bridge.cryptoFailed',
    retryable: true,
    details: e instanceof Error ? e.message : String(e),
  });
}

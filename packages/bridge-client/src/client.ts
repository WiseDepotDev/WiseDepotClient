import { loadBootstrap } from './bootstrap.js';
import { MockTransport } from './mock.js';
import { WebSocketTransport, type BridgeTransport, type ConnectionState, type WebSocketTransportOptions } from './transport.js';
import type { BridgeBootstrap, ReqMeta } from './types.js';

/**
 * 桥的**统一外观**：UI 只认这个接口，不关心背后是 WS 还是 mock，也不关心平台是桌面还是手机。
 * 平台差异一律走 `supports(capability)`（架构不变式 2）。
 */
export interface Bridge {
  /** `ws` = 真实宿主；`mock` = 开发态假桥（UI 必须显式标注，避免"假通过"）。 */
  readonly kind: 'ws' | 'mock';
  readonly platform: string;
  readonly hostVersion: string;
  readonly capabilities: readonly string[];
  readonly state: ConnectionState;
  /** 能力判定。**不要**判 `platform === 'desktop'`。 */
  supports(capability: string): boolean;
  call<T>(method: string, params?: unknown, meta?: ReqMeta): Promise<T>;
  /**
   * 验活：发一个本地 ping，`false` 表示这条连接可能是**半死**的（见 `BridgeTransport.checkAlive`）。
   * 实现会顺手丢掉不可信的连接，下一次调用重新建连。
   */
  checkAlive(timeoutMs?: number): Promise<boolean>;
  /** 丢弃当前连接（半死 / 不可信），下一次调用重新建连。 */
  reset(): void;
  subscribe(topic: string, handler: (data: unknown) => void): () => void;
  onStateChange(handler: (state: ConnectionState) => void): () => void;
  close(): void;
}

class BridgeImpl implements Bridge {
  constructor(
    private readonly transport: BridgeTransport,
    private readonly bootstrap: BridgeBootstrap,
  ) {}

  get kind(): 'ws' | 'mock' {
    return this.transport.kind;
  }

  get platform(): string {
    return this.bootstrap.platform;
  }

  get hostVersion(): string {
    return this.bootstrap.ver;
  }

  get capabilities(): readonly string[] {
    return this.bootstrap.capabilities;
  }

  get state(): ConnectionState {
    return this.transport.state;
  }

  supports(capability: string): boolean {
    return this.bootstrap.capabilities.includes(capability);
  }

  call<T>(method: string, params?: unknown, meta?: ReqMeta): Promise<T> {
    return this.transport.call<T>(method, params, meta);
  }

  checkAlive(timeoutMs?: number): Promise<boolean> {
    return timeoutMs === undefined ? this.transport.checkAlive() : this.transport.checkAlive(timeoutMs);
  }

  reset(): void {
    this.transport.reset();
  }

  subscribe(topic: string, handler: (data: unknown) => void): () => void {
    return this.transport.subscribe(topic, handler);
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    return this.transport.onStateChange(handler);
  }

  close(): void {
    this.transport.close();
  }
}

export interface CreateBridgeOptions {
  /** 允许在没有宿主时回退到 mock。**只应传 `import.meta.env.DEV`**。 */
  readonly allowMock?: boolean;
  readonly transport?: WebSocketTransportOptions;
  /**
   * 等宿主就绪的上限（毫秒）。
   *
   * **为什么必须有这个等待**：两个宿主都是刻意"并行启动"的 ——
   * 桌面主进程 spawn 桥的同时就建窗、手机在 `Application.onCreate` 里异步起桥。
   * 因此页面第一次读 `__bridge.json` 拿到 **503 是必然事件**，不是异常。
   *
   * 早期版本把它当成致命错误（"宿主未提供引导"），后果是**两端同时白屏**：
   * 探测请求晚一点能拿到 200，页面自己却停在错误页不再重试（W3 实测）。
   */
  readonly waitForHostMs?: number;
  readonly retryIntervalMs?: number;
}

export interface CreateBridgeResult {
  readonly bridge: Bridge;
  /** 引导来源说明，用于在界面上显示"为什么现在是 mock"。 */
  readonly origin: string;
}

const DEFAULT_WAIT_MS = 15_000;
/** 开发态浏览器里根本没有宿主，等太久只会让 `pnpm dev` 显得卡。 */
const DEFAULT_WAIT_DEV_MS = 1_200;

/**
 * 创建桥：**等宿主就绪** → 有宿主走 WS，没宿主且显式允许则走 mock。
 *
 * 生产环境下始终等不到宿主 = 架构错误（宿主没把桥拉起来），此时**直接抛**，
 * 不允许静默降级——那会让一个坏掉的宿主看起来"能用"。
 */
export async function createBridge(options: CreateBridgeOptions = {}): Promise<CreateBridgeResult> {
  const allowMock = options.allowMock === true;
  const waitMs = options.waitForHostMs ?? (allowMock ? DEFAULT_WAIT_DEV_MS : DEFAULT_WAIT_MS);
  const interval = options.retryIntervalMs ?? 250;
  const deadline = Date.now() + waitMs;

  let loaded = await loadBootstrap();
  let attempts = 1;
  while (loaded.kind === 'absent' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    loaded = await loadBootstrap();
    attempts += 1;
  }

  if (loaded.kind === 'ready') {
    const transport = new WebSocketTransport(loaded.bootstrap, {
      ...(options.transport ?? {}),
      refreshBootstrap: async () => {
        const current = await loadBootstrap();
        return current.kind === 'ready' ? current.bootstrap : null;
      },
    });
    return {
      bridge: new BridgeImpl(transport, loaded.bootstrap),
      origin: `宿主 ${loaded.bootstrap.platform} v${loaded.bootstrap.ver} @ 127.0.0.1:${loaded.bootstrap.port}（等待 ${attempts} 次探测）`,
    };
  }

  if (!allowMock) {
    throw new Error(`等待 ${waitMs}ms 仍没有可用的桥（${loaded.reason}），且未允许 mock 回退。`);
  }

  const bootstrap: BridgeBootstrap = {
    port: 0,
    token: 'mock',
    platform: 'browser',
    ver: '0.0.0-mock',
    protocol: 4,
    limits: { textMaxBytes: 256 * 1024, binMaxBytes: 8 * 1024 * 1024 },
    capabilities: [
      'storage.secure',
      'offline.queue',
      'print.system',
      'file.dialog',
      'window.control',
      'scan.camera',
      // 浏览器本来就能 `enumerateDevices` + 按 deviceId 选，所以"能选摄像头"在开发态是**真能工作**的
      'scan.camera.select',
      // 浏览器本来就能接收键盘输入，所以"键盘式扫码枪"在开发态是**真能工作**的：
      // 补上它，扫码三分支（输入焦点 / 屏内消费者 / 兜底跳转）在 pnpm dev 里可验，
      // 不必等真机。
      //
      // 相机取景（`scan.camera`）在开发态同样是**真能工作**的：取景与识别都在 Web 侧
      // （`getUserMedia` + ZXing-wasm），宿主只提供权限与能力位。所以 pnpm dev 里
      // 可以完整走一遍"点条码框里的相机图标 → 扫到码填进框"。
      'scan.gun.keyboard',
    ],
  };
  return {
    bridge: new BridgeImpl(new MockTransport(), bootstrap),
    origin: `开发态 mock（${loaded.reason}）`,
  };
}

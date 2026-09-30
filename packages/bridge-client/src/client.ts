import { loadBootstrap, type BootstrapResult } from './bootstrap.js';
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
}

export interface CreateBridgeResult {
  readonly bridge: Bridge;
  /** 引导来源说明，用于在界面上显示"为什么现在是 mock"。 */
  readonly origin: string;
}

/**
 * 创建桥：读引导 → 有宿主走 WS，没宿主且显式允许则走 mock。
 *
 * 生产环境下没有引导 = 架构错误（宿主没把桥拉起来），此时**直接抛**，
 * 不允许静默降级——那会让一个坏掉的宿主看起来"能用"。
 */
export async function createBridge(options: CreateBridgeOptions = {}): Promise<CreateBridgeResult> {
  const loaded: BootstrapResult = await loadBootstrap();

  if (loaded.kind === 'ready') {
    const transport = new WebSocketTransport(loaded.bootstrap, options.transport ?? {});
    return {
      bridge: new BridgeImpl(transport, loaded.bootstrap),
      origin: `宿主 ${loaded.bootstrap.platform} v${loaded.bootstrap.ver} @ 127.0.0.1:${loaded.bootstrap.port}`,
    };
  }

  if (!options.allowMock) {
    throw new Error(`没有可用的桥（${loaded.reason}），且未允许 mock 回退。`);
  }

  const bootstrap: BridgeBootstrap = {
    port: 0,
    token: 'mock',
    platform: 'browser',
    ver: '0.0.0-mock',
    protocol: 3,
    capabilities: [
      'storage.secure',
      'offline.queue',
      'print.system',
      'file.dialog',
      'window.control',
      'scan.camera',
    ],
  };
  return {
    bridge: new BridgeImpl(new MockTransport(), bootstrap),
    origin: `开发态 mock（${loaded.reason}）`,
  };
}

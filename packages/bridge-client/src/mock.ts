import { BridgeError, BridgeErrorCode, type ReqMeta } from './types.js';
import type { BridgeTransport, ConnectionState } from './transport.js';

/**
 * **开发态**传输：在普通浏览器里 `vite dev` 时没有原生宿主，用它把 UI 跑起来。
 *
 * 三条使用纪律（很重要，否则 mock 会变成"假通过"的来源）：
 * 1. 只由 `createBridge({ allowMock })` 在显式允许时构造，**绝不**作为生产回退；
 * 2. 只实现少量方法，其余一律抛 `BRIDGE_METHOD_UNKNOWN`——这与真实桥的白名单行为一致；
 * 3. UI 必须能看出自己连的是 mock（`bridge.kind === 'mock'`），并在界面上显式标注。
 */
export class MockTransport implements BridgeTransport {
  readonly kind = 'mock' as const;

  private readonly stateHandlers = new Set<(s: ConnectionState) => void>();
  private readonly topics = new Map<string, Set<(data: unknown) => void>>();
  private timer: number | null = null;

  constructor() {
    // 周期性推一条扫码事件，让订阅链路在开发态也是活的
    this.timer = window.setInterval(() => this.emit('scan.code', { code: `TAG-${String(Date.now()).slice(-6)}`, symbology: 'code128' }), 20_000);
  }

  get state(): ConnectionState {
    return 'open';
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  async call<T>(method: string, params?: unknown, _meta?: ReqMeta): Promise<T> {
    await new Promise((r) => setTimeout(r, 120)); // 模拟一次 loopback 往返 + 后端耗时

    const fixture = FIXTURES[method];
    if (!fixture) {
      throw new BridgeError({
        code: BridgeErrorCode.METHOD_UNKNOWN,
        messageKey: 'bridge.methodNotMocked',
        details: { method },
      });
    }
    return (typeof fixture === 'function' ? (fixture as (p: unknown) => unknown)(params) : fixture) as T;
  }

  subscribe(topic: string, handler: (data: unknown) => void): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.topics.clear();
  }

  /** 供开发态手动触发事件（例如在控制台里调 `window.__bridgeMock.emit(...)`）。 */
  emit(topic: string, data: unknown): void {
    for (const h of this.topics.get(topic) ?? []) {
      h(data);
    }
  }
}

/** mock 数据：形状对齐后端 `payload.data`，字段名与 DTO 一致（便于迁移时肉眼对照）。 */
const FIXTURES: Record<string, unknown> = {
  'dashboard.summary': {
    inventoryTotal: 1284,
    todayAlertCount: 3,
    inspectionProgress: 62,
    deviceOnlineCount: 17,
    unprocessedAlerts: [
      { eventId: 9001, level: 2, title: '库存异常 · A-03 货位', status: 0, createTime: '2026-01-01T09:12:00' },
      { eventId: 9002, level: 1, title: '设备离线 · 读头 04', status: 0, createTime: '2026-01-01T08:40:00' },
    ],
    currentTask: { taskId: 501, taskCode: 'PT-20260101-01', status: 1, progress: 62, totalItems: 120, inspectedItems: 74 },
  },
  'inventory.list': (params: unknown) => {
    const p = (params ?? {}) as { page?: number; size?: number };
    const size = p.size ?? 20;
    const page = p.page ?? 1;
    return {
      total: 1284,
      rows: Array.from({ length: size }, (_, i) => ({
        inventoryId: (page - 1) * size + i + 1,
        productName: `样品物料 ${(page - 1) * size + i + 1}`,
        productCode: `P-${String((page - 1) * size + i + 1).padStart(5, '0')}`,
        quantity: 20 + ((i * 7) % 60),
        warehouseName: '立体库 A',
        location: `A-${String((i % 12) + 1).padStart(2, '0')}-${(i % 6) + 1}`,
      })),
    };
  },
  'alert.list': {
    rows: [
      { eventId: 9001, level: 2, title: '库存异常 · A-03 货位', message: '实际 18 / 预期 20', status: 0, createTime: '2026-01-01T09:12:00' },
      { eventId: 9002, level: 1, title: '设备离线 · 读头 04', message: '心跳超时 180s', status: 0, createTime: '2026-01-01T08:40:00' },
      { eventId: 9003, level: 3, title: '未授权移动', message: 'B-02 → C-01', status: 1, createTime: '2026-01-01T07:05:00' },
    ],
    total: 3,
  },
  'user.current': { userId: 1, username: 'operator', nickname: '现场操作员', role: 'OPERATOR' },
  'message.unreadCount': 4,
};

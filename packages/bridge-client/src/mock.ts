import { BridgeError, BridgeErrorCode, BRIDGE_EVENT_SESSION_EXPIRED, type ReqMeta } from './types.js';
import { DomainMock } from './mock-domains.js';
import { MeMock } from './mock-me.js';
import type { BridgeTransport, ConnectionState } from './transport.js';

/**
 * 把假桥的返回值按 **JSON 语义**复制一份（真桥的响应就是一次 JSON 反序列化）。
 *
 * 为什么不用 `structuredClone`：假数据里只有纯 JSON（字符串/数字/布尔/数组/对象/null），
 * 而 `JSON.parse(JSON.stringify(x))` 还顺带把 `undefined` 字段、`Date` 之类的边界
 * 表现对齐成真桥会给的样子（`Date` → ISO 串）。`undefined` 在下面特判返回本身。
 */
function cloneJson(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      // 理论上到不了这里（假数据都是纯 JSON）；真到了也别把一次正常调用变成异常
      return value;
    }
  }
  return value;
}

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

  /** 开发态的会话状态。真实桥的会话在 Kotlin 侧；这里只为让"启动 → 登录 → 进主界面"这条链在浏览器里跑通。 */
  private authenticated = false;
  private username = 'operator';

  constructor() {
    // 周期性推一条扫码事件，让订阅链路在开发态也是活的
    this.timer = window.setInterval(() => this.emit('scan.code', { code: `TAG-${String(Date.now()).slice(-6)}`, symbology: 'code128' }), 20_000);
    /*
     * 把假桥挂到 window 上：开发态可以手动制造故障，用来验"出问题真的会显示异常"。
     *
     *   await window.__bridgeMock.setBackendDown(true)   // 之后所有后端调用都报"后端不可达"
     *   await window.__bridgeMock.setBackendDown(false)  // 恢复
     *
     * 没有这个开关，"状态显示是真的"这条只能靠嘴说 —— 你没法让真后端按需挂掉。
     */
    (window as unknown as { __bridgeMock?: MockTransport }).__bridgeMock = this;
  }

  /** 后端挂掉开关（开发态专用，见构造函数里的说明）。 */
  private backendDown = false;

  /** 会话是否已过期（开发态：由 `expireSession()` 触发，真宿主在令牌失效/被吊销时推同样的事件）。 */
  private sessionExpired = false;

  setBackendDown(down: boolean): void {
    this.backendDown = down;
  }

  /**
   * 开发态：**让会话立刻过期**，并推一次真宿主会推的那条事件。
   *
   * 为什么需要它：真机上"登录过期"通常要等令牌自然到期（或后端把人踢下线），
   * 你没法按需复现 —— 而这条链路上有三件事只有真过期才看得见：
   *   1. 界面是否**自动**回登录屏（而不是等用户点一下才跳）；
   *   2. 登录屏有没有说明"为什么被踢出来"（不然用户以为是系统坏了）；
   *   3. 过期后 `bridge.session` 必须报"未登录"，否则界面会继续画上一份数据。
   *
   * 用法（浏览器控制台或冒烟脚本）：
   *   window.__bridgeMock.expireSession()
   */
  expireSession(): void {
    this.authenticated = true; // 曾经登录过
    this.sessionExpired = true;
    this.emit(BRIDGE_EVENT_SESSION_EXPIRED, {});
  }

  /** 开发态：把会话恢复成"已登录"（配合上面的开关做对照）。 */
  restoreSession(): void {
    this.sessionExpired = false;
  }

  /** 空库开关（开发态专用，见 `emptyDashboard()` 的说明）。 */
  private dashboardEmpty = false;

  /**
   * 开发态：把看板切成**空库**（KPI 全 0、没有未处理告警、没有进行中任务）。
   *
   * 为什么需要它：真机上的空库是"数据被清过/刚初始化"的现场，平时碰不到；
   * 而这时候界面最容易假装正常 —— 一屏 0 到底是**真的没有数据**，还是**字段接错了**，
   * 只有把两个状态摆在一起看才知道。真后端 2026-10-01 就是这个状态
   * （`/api/inventories` total=0、3 台设备全离线、当天无新告警），
   * 但假桥平时给的是有数据的那份，所以要用开关把另一份调出来。
   *
   *   window.__bridgeMock.emptyDashboard(true)   // 切成空库（刷新后生效）
   *   window.__bridgeMock.emptyDashboard(false)  // 切回有数据
   */
  emptyDashboard(on: boolean): void {
    this.dashboardEmpty = on;
  }

  get state(): ConnectionState {
    return 'open';
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  async call<T>(method: string, params?: unknown, meta?: ReqMeta): Promise<T> {
    const value = await this.callInternal<T>(method, params, meta);
    /*
     * **按 JSON 语义克隆一次再交出去。**
     *
     * 真桥的响应过了一次 JSON 反序列化：每次调用回来的都是**新对象**。
     * 假桥如果直接把内部那份数据（甚至就是内部那个被就地改过的对象）返回，
     * 引用不变 —— 而 Vue 的响应式是"新值 !== 旧值才通知"，
     * 于是"写完 → 重取 → 界面刷新"这条链在开发态**永远刷不动**：
     * 数据是新的、画面是旧的。实测就踩到了：任务状态在假桥里已经是"进行中"，
     * 界面芯片还写着"待开始"，而在真机上这是好的。
     *
     * 这类"只有开发态才出现"的假红（也可能反过来造成假绿）最费时间，
     * 所以在这里统一对齐真实传输的语义，而不是让每个 mock 各自记得返回副本。
     */
    return cloneJson(value) as T;
  }

  private async callInternal<T>(method: string, params?: unknown, _meta?: ReqMeta): Promise<T> {
    await new Promise((r) => setTimeout(r, 120)); // 模拟一次 loopback 往返 + 后端耗时

    // 后端挂掉开关（开发态）：用来验"出问题真的会显示异常"
    if (this.backendDown && method !== 'bridge.session') {
      throw new BridgeError({
        code: BridgeErrorCode.BACKEND_UNREACHABLE,
        messageKey: 'bridge.backendUnreachable',
        retryable: true,
      });
    }

    /*
     * 会话三件套在这里特判而不是放进 FIXTURES：
     * `auth.login` 要改变后续 `bridge.session` 的返回值，FIXTURES 是模块级常量、看不到实例状态。
     * 这三个方法补上之后，纯浏览器里的 `pnpm dev` 也能走完"启动 → 登录 → 进主界面"，
     * 不必等宿主就绪才知道登录屏对不对。
     */
    if (method === 'bridge.session') {
      return {
        // 过期之后**不再是已登录**：界面必须回登录屏，而不是继续画上一份数据
        authenticated: this.authenticated && !this.sessionExpired,
        username: this.authenticated && !this.sessionExpired ? this.username : null,
        passwordChangeRequired: false,
        expired: this.sessionExpired,
      } as T;
    }
    if (method === 'auth.login') {
      const p = (params ?? {}) as { username?: string };
      this.authenticated = true;
      this.sessionExpired = false;
      this.username = p.username && p.username !== '' ? p.username : 'operator';
      return {} as T;
    }
    if (method === 'captcha.generate') {
      return {
        captchaId: `mock-${Date.now()}`,
        // 内联 SVG，避免开发态再依赖网络；真后端给的是 `data:image/png;base64,…`
        captchaImage:
          'data:image/svg+xml;utf8,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" fill="#EEF1F6"/><text x="12" y="32" font-family="monospace" font-size="22" fill="#173344">8 + 5</text></svg>',
          ),
        expireTime: new Date(Date.now() + 120_000).toISOString(),
      } as T;
    }

    const fixture = FIXTURES[method];

    /*
     * 空库态特判（开发态开关）。放在 FIXTURES 之前，因为要覆盖它那份有数据的静态版本。
     * 形状与真后端 `DashboardSummaryDTO` 一致：字段全在，只是值都是 0 / 空数组。
     */
    if (method === 'dashboard.summary' && this.dashboardEmpty) {
      return {
        inventoryTotal: 0,
        todayAlertCount: 0,
        inspectionProgress: 0,
        deviceOnlineCount: 0,
        unprocessedAlerts: [],
        currentTask: null,
      } as T;
    }
    /*
     * 只拦**有状态**的四个告警方法。
     *
     * 注意别写成 `method.startsWith('alert.')`：那会把 `alert.list` 也吞掉，
     * 而列表是无状态的、放在 FIXTURES 里 —— 吞掉之后列表屏只会显示错误态，
     * 表现为"列表是空的、页头说'最近的告警事件'"，很难一眼看出是 mock 的锅。
     */
    if (method === 'alert.detail' || method === 'alert.logs' || method === 'alert.ack' || method === 'alert.status') {
      return this.alertCall<T>(method, params);
    }
    /*
     * 库存域（有状态）。**放在 FIXTURES 之前**，因为它要覆盖 `product.list` 这类
     * FIXTURES 里也有静态版本的键 —— 有状态的那一份才是这一域真正的来源。
     */
    const inventoryHandled = this.domainMock.call<T>(method, params);
    if (inventoryHandled !== undefined) {
      return inventoryHandled;
    }
    /*
     * 「我的」域（消息 / 用户 / 个人资料，同样有状态）。也放在 FIXTURES 之前：
     * 它要覆盖 `user.current`、`message.unreadCount` 这两个 FIXTURES 里也有静态版本的键 ——
     * 静态那份不会变，而这两条恰恰要"标已读之后数字会动"才验得出东西。
     */
    const meHandled = this.meMock.call<T>(method, params);
    if (meHandled !== undefined) {
      return meHandled;
    }
    if (!fixture) {
      throw new BridgeError({
        code: BridgeErrorCode.METHOD_UNKNOWN,
        messageKey: 'bridge.methodNotMocked',
        details: { method },
      });
    }
    return (typeof fixture === 'function' ? (fixture as (p: unknown) => unknown)(params) : fixture) as T;
  }

  /**
   * 告警域的 mock。
   *
   * 为什么它要有**状态**：告警详情的关键行为是"动作按状态决定能不能点"，
   * 以及"确认/处理完/忽略之后按钮要变成不可点、并写出原因"。
   * 一个恒返回 `status: 0` 的假数据会让这条链路怎么点都"成功"，
   * 于是界面真正的分支（已结束、终态不可再改）在开发态永远验不到。
   *
   * 初始状态按序号区分，这样两种分支都能一进门就看到：
   *   9001 / 9002 → 未处理（0）；9003 → 已处理（2）。
   */
  private readonly alertStatus = new Map<number, number>([

    [9001, 0],
    [9002, 0],
    [9003, 2],
  ]);

  private readonly alertLogs = new Map<number, unknown[]>();

  /** 库存域的有状态 mock（商品/仓库/库存/标签/出入库单），见 mock-inventory.ts。 */
  private readonly domainMock = new DomainMock();

  /** 「我的」域的有状态 mock（消息/用户/个人资料），见 mock-me.ts。 */
  private readonly meMock = new MeMock();

  private alertCall<T>(method: string, params: unknown): T {
    const p = (params ?? {}) as { eventId?: number; status?: number; remark?: string };
    const id = typeof p.eventId === 'number' ? p.eventId : 9001;
    const status = this.alertStatus.get(id) ?? 0;

    if (method === 'alert.detail') {
      const base = {
        eventId: id,
        title: id === 9003 ? '未授权移动 · B-02 → C-01' : id === 9002 ? '设备离线 · 读头 04' : '库存异常 · A-03 货位',
        message: id === 9003 ? '出库单 WD-20260101-0007 未登记' : id === 9002 ? '心跳超时 180s' : '实际 18 / 预期 20',
        level: id === 9003 ? 3 : 2,
        sourceModule: id === 9003 ? 'PRODUCT_MOVEMENT' : id === 9002 ? 'DEVICE' : 'INVENTORY',
        isActive: status === 0 || status === 1,
        createTime: '2026-01-01T09:12:00',
        resolvedTime: status === 2 ? '2026-01-01T10:20:00' : undefined,
        resolvedBy: status === 2 ? 1 : undefined,
        extendedData: undefined,
      };
      // 字段名与 DTO 对齐；`isActive` / `resolvedTime` 跟状态走，别让界面看到自相矛盾的数据
      return { ...base, status } as T;
    }

    if (method === 'alert.logs') {
      const rows = [...(this.alertLogs.get(id) ?? [])];
      if (status === 2 && rows.length === 0) {
        rows.push({
          logId: 1,
          handlerId: 1,
          handlerName: '现场操作员',
          goalStatus: 2,
          goalStatusDescription: '已处理',
          remark: '已更换读头并复核',
          handleTime: '2026-01-01T10:20:00',
        });
      }
      return { rows } as T;
    }

    if (method === 'alert.ack') {
      this.alertStatus.set(id, 1);
      this.pushAlertLog(id, 1, '处理中', p.remark ?? '');
      return {} as T;
    }

    if (method === 'alert.status') {
      const next = typeof p.status === 'number' ? p.status : 2;
      this.alertStatus.set(id, next);
      this.pushAlertLog(id, next, next === 2 ? '已处理' : '已忽略', p.remark ?? '');
      return {} as T;
    }

    throw new BridgeError({
      code: BridgeErrorCode.METHOD_UNKNOWN,
      messageKey: 'bridge.methodNotMocked',
      details: { method },
    });
  }

  private pushAlertLog(eventId: number, goalStatus: number, goalStatusDescription: string, remark: string): void {
    const rows = this.alertLogs.get(eventId) ?? [];
    rows.push({
      logId: rows.length + 1,
      handlerId: 1,
      handlerName: '现场操作员',
      goalStatus,
      goalStatusDescription,
      ...(remark === '' ? {} : { remark }),
      handleTime: new Date().toISOString(),
    });
    this.alertLogs.set(eventId, rows);
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

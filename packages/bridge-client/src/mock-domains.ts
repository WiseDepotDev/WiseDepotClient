import { BridgeError, BridgeErrorCode } from './types.js';

/**
 * 库存域的**有状态** mock（开发态专用）。
 *
 * ## 为什么要做成有状态的
 *
 * 无状态的假数据只能证明"页面画出来了"，证明不了任何流程：
 * 新建商品后列表里该多一条、删除后该少一条、单据提交后状态该从"待审批"变"待审核"、
 * 审核通过后三个按钮都该不可点 —— 这些**只有状态会变的 mock 才验得到**。
 * 告警域当初也是这么做的（`alertCall`），这里是同一套思路的库存域版本。
 *
 * 数据形状严格按服务端 DTO（字段名以真后端为准，例如出入库单是
 * `orderStatus`/`orderType` 而不是 `status`/`type`）。
 */
/**
 * 分页参数名 —— **必须与服务端一致**，见 `page()` 的说明。
 * `null` = 服务端这些端点不接分页参数（全量返回）。
 */
type PagingParamName = 'size' | 'pageSize' | null;

interface Product {
  productId: number;
  productName: string;
  productCode: string;
  model: string;
  unit: string;
  createTime: string;
}

interface Warehouse {
  warehouseId: number;
  warehouseName: string;
  warehouseCode: string;
  address: string;
  /** 服务端 `WarehouseDTO` 里本来就有这一项，前端表单也从 V6 之后开始维护它。 */
  description: string;
}

interface Inventory {
  inventoryId: number;
  productId: number;
  productName: string;
  productCode: string;
  warehouseId: number;
  warehouseName: string;
  location: string;
  quantity: number;
  lockedQuantity: number;
  status: number;
  lastCheckTime: string;
  updateTime: string;
}

interface Tag {
  tagId: number;
  barcode: string;
  rfid: string;
  nfcUid: string;
  status: number;
  /**
   * 绑定信息。**显式写成 `| undefined`**：本项目开着 `exactOptionalPropertyTypes`，
   * `productId?: number` 是不允许被赋 `undefined` 的 —— 而"解绑"恰恰要把它清空。
   */
  productId?: number | undefined;
  productName?: string | undefined;
  productCode?: string | undefined;
  createTime: string;
  updateTime: string;
}

interface OrderItem {
  tagId: number;
  productId: number;
  productName: string;
  productCode: string;
  quantity: number;
  locationCode: string;
}

interface StockOrder {
  orderId: number;
  orderNo: string;
  warehouseId: number;
  warehouseName: string;
  orderType: number;
  orderTypeStr: string;
  orderStatus: number;
  orderStatusStr: string;
  totalItems: number;
  remark?: string | undefined;
  createBy: number;
  createdByName: string;
  createTime: string;
  submitTime?: string | undefined;
  items: OrderItem[];
}

/**
 * 巡检（现场域）的 mock 形状。
 *
 * `status` 是数字码（0 待开始 / 1 进行中 / 2 已完成 / 3 已暂停），`statusDesc` 是服务端
 * 给的**文字**—— 真后端在列表接口里实测回的是枚举原文（`COMPLETED`），在有的接口里回中文。
 * 两种都造了一行：界面必须**两种都能显示成中文**（归一化在 `inspectionState.ts`）。
 */
interface InspectionTask {
  taskId: number;
  taskCode: string;
  planId: number;
  planName: string;
  taskType: number;
  taskTypeDesc: string;
  status: number;
  statusDesc: string;
  progress: number;
  totalItems: number;
  inspectedItems: number;
  normalItems: number;
  abnormalItems: number;
  missingItems: number;
  extraItems: number;
  warehouseId: number;
  warehouseName: string;
  deviceId: number;
  deviceName: string;
  targetDistance: number;
  startTime?: string | undefined;
  endTime?: string | undefined;
  createTime: string;
  updateTime: string;
}

/**
 * 巡检计划。字段**严格对齐服务端 `InspectionPlanDTO`**：
 * `planId / planName / deviceId / cronExpression / enabled / createTime / updateTime`。
 *
 * 注意：这里早先写成过 `{ warehouseId, warehouseName }` —— 那是**编的**（服务端 DTO 里没有这两项），
 * 当时只有"新建巡检"拿它当选项列表、没暴露出来。V6 之后要接计划管理屏，必须先把这个形状改对，
 * 否则界面会去找一个服务端根本不返回的字段。
 * `enabled` 在服务端是 `status`（1 启用 / 其它停用），DTO 出口统一成布尔。
 */
interface InspectionPlan {
  planId: number;
  planName: string;
  deviceId?: number | undefined;
  cronExpression: string;
  enabled: boolean;
  createTime: string;
  updateTime: string;
}

/** 盘点差异行：`status` 为 `NORMAL` / `MISSING` / `EXTRA`，`DIFF` 表示数量对不上但标签还在。 */
interface InspectionDiffRow {
  productId: number;
  productName: string;
  productCode: string;
  expectedQuantity: number;
  scannedQuantity: number;
  difference: number;
  status: string;
}

interface InspectionResult {
  resultId: number;
  taskId: number;
  compareTime: string;
  totalItems: number;
  normalItems: number;
  missingItems: number;
  extraItems: number;
  createTime: string;
  progress: number;
  /**
   * 结果状态。**取值口径未实测**：仓里的服务端源码在 `getResult` 里硬编码写 `"COMPLETED"`，
   * 而 React 结果列表屏按 `PENDING` / `CONFIRMED` 两档做筛选 —— 两者对不上。
   * 这里保留界面用得上的两档，好在假桥下验「确认入账」这条交互；
   * 真后端到底给什么值，需要一个真结果样本才能定（已记进执行计划的遗留项）。
   */
  status: string;
  totalScanned: number;
  totalExpected: number;
}

const nowIso = (): string => new Date().toISOString();
const find = <T extends Record<string, unknown>>(list: T[], key: string, value: unknown): T | undefined =>
  list.find((item) => item[key] === value);

export class DomainMock {
  private readonly products: Product[] = [
    { productId: 1, productName: '工业级 RFID 标签', productCode: 'RFID-UHF-01', model: 'UHF-01', unit: '个', createTime: '2026-01-01T09:00:00' },
    { productId: 2, productName: '高强度紧固件 M12', productCode: 'FAST-M12-00', model: 'M12', unit: '箱', createTime: '2026-01-02T09:00:00' },
    { productId: 3, productName: '液压密封组件', productCode: 'HYD-SEAL-22', model: 'SEAL-22', unit: '套', createTime: '2026-01-03T09:00:00' },
  ];

  private readonly warehouses: Warehouse[] = [
    { warehouseId: 1, warehouseName: '华东中心仓', warehouseCode: 'EC-01', address: '上海市青浦区', description: '常温区，负责华东片区' },
    { warehouseId: 2, warehouseName: '华南备件仓', warehouseCode: 'SC-02', address: '广州市黄埔区', description: '备件专区' },
  ];

  private readonly inventory: Inventory[] = [
    { inventoryId: 101, productId: 1, productName: '工业级 RFID 标签', productCode: 'RFID-UHF-01', warehouseId: 1, warehouseName: '华东中心仓', location: 'A-01-08', quantity: 142, lockedQuantity: 14, status: 0, lastCheckTime: '2026-01-05T10:00:00', updateTime: '2026-01-06T10:16:00' },
    { inventoryId: 102, productId: 2, productName: '高强度紧固件 M12', productCode: 'FAST-M12-00', warehouseId: 1, warehouseName: '华东中心仓', location: 'A-03-12', quantity: 860, lockedQuantity: 0, status: 0, lastCheckTime: '2026-01-04T10:00:00', updateTime: '2026-01-06T10:09:00' },
    // 这一行是"库存偏低 + 已锁定"，用来验两个筛选档
    { inventoryId: 103, productId: 3, productName: '液压密封组件', productCode: 'HYD-SEAL-22', warehouseId: 2, warehouseName: '华南备件仓', location: 'B-02-04', quantity: 8, lockedQuantity: 8, status: 1, lastCheckTime: '2026-01-05T09:00:00', updateTime: '2026-01-06T09:42:00' },
  ];

  private readonly tags: Tag[] = [
    { tagId: 1, barcode: 'TAG-0001', rfid: 'E200-0001', nfcUid: '04A1B2C3', status: 1, productId: 1, productName: '工业级 RFID 标签', productCode: 'RFID-UHF-01', createTime: '2026-01-01T09:10:00', updateTime: '2026-01-01T09:10:00' },
    { tagId: 2, barcode: 'TAG-0002', rfid: 'E200-0002', nfcUid: '04A1B2C4', status: 0, createTime: '2026-01-01T09:11:00', updateTime: '2026-01-01T09:11:00' },
    { tagId: 3, barcode: 'TAG-0003', rfid: 'E200-0003', nfcUid: '04A1B2C5', status: 0, createTime: '2026-01-01T09:12:00', updateTime: '2026-01-01T09:12:00' },
  ];

  private readonly orders: StockOrder[] = [
    {
      orderId: 8001,
      orderNo: 'IN-20260101-0900',
      warehouseId: 1,
      warehouseName: '华东中心仓',
      orderType: 0,
      orderTypeStr: 'IN',
      orderStatus: 0,
      orderStatusStr: 'PENDING',
      totalItems: 1,
      createBy: 1,
      createdByName: '现场操作员',
      createTime: '2026-01-01T09:00:00',
      items: [{ tagId: 1, productId: 1, productName: '工业级 RFID 标签', productCode: 'RFID-UHF-01', quantity: 10, locationCode: 'A-01-08' }],
    },
    {
      // 已经提交、等审核的单据：用来验"撤回 / 审核通过 / 驳回"三件事都能点
      orderId: 8002,
      orderNo: 'OUT-20260102-1000',
      warehouseId: 1,
      warehouseName: '华东中心仓',
      orderType: 1,
      orderTypeStr: 'OUT',
      orderStatus: 4,
      orderStatusStr: 'SUBMITTED',
      totalItems: 1,
      createBy: 1,
      createdByName: '现场操作员',
      createTime: '2026-01-02T10:00:00',
      submitTime: '2026-01-02T10:05:00',
      items: [{ tagId: 2, productId: 2, productName: '高强度紧固件 M12', productCode: 'FAST-M12-00', quantity: 3, locationCode: 'A-03-12' }],
    },
    {
      // **没有明细**的待审批单据：用来验"没有明细不能提交"这条服务端约束
      orderId: 8003,
      orderNo: 'IN-20260103-0800',
      warehouseId: 2,
      warehouseName: '华南备件仓',
      orderType: 0,
      orderTypeStr: 'IN',
      orderStatus: 0,
      orderStatusStr: 'PENDING',
      totalItems: 0,
      createBy: 1,
      createdByName: '现场操作员',
      createTime: '2026-01-03T08:00:00',
      items: [],
    },
  ];

  private nextId = 9001;

  /**
   * 设备（现场域）。三台足够覆盖三种状态：在线 / 离线 / 故障。
   *
   * 行走速度与四路电机微调是**只读参数** —— 客户端看得到、没有写接口，
   * 所以界面用文本展示而不是滑块（滑块会暗示一个不存在的能力）。
   */
  private readonly devices = [
    {
      deviceId: 1,
      deviceCode: 'BOT-001',
      deviceName: '搬运机器人 01',
      deviceType: 1,
      deviceTypeName: 'AGV 搬运机器人',
      ipAddress: '192.168.1.11',
      deviceStatus: 1,
      deviceStatusName: '在线',
      lastHeartbeat: '2026-01-06T10:15:00',
      remark: 'A 区货架间作业',
      updateTime: '2026-01-06T10:15:00',
      moveSpeedCmS: 60,
      motorTrimA: 0,
      motorTrimB: 2,
      motorTrimC: -1,
      motorTrimD: 0,
    },
    {
      deviceId: 2,
      deviceCode: 'BOT-002',
      deviceName: '搬运机器人 02',
      deviceType: 1,
      deviceTypeName: 'AGV 搬运机器人',
      ipAddress: '192.168.1.12',
      deviceStatus: 0,
      deviceStatusName: '离线',
      lastHeartbeat: '2026-01-05T18:40:00',
      remark: '停在充电位',
      updateTime: '2026-01-05T18:40:00',
      moveSpeedCmS: 55,
      motorTrimA: 1,
      motorTrimB: 1,
      motorTrimC: 0,
      motorTrimD: -2,
    },
    {
      deviceId: 3,
      deviceCode: 'READER-04',
      deviceName: '读头 04',
      deviceType: 2,
      deviceTypeName: 'RFID 读头',
      ipAddress: '192.168.1.24',
      deviceStatus: 2,
      deviceStatusName: '故障',
      lastHeartbeat: '2026-01-06T09:58:00',
      remark: '心跳超时 180s',
      updateTime: '2026-01-06T09:58:00',
    },
  ];

  /**
   * 巡检（现场域）。**有状态**：开始 / 结束 / 改进度 / 新建 / 补录 / 录结果都会真的改这里的数据，
   * 否则"点了开始按钮状态还是待开始"这种断链在 mock 下永远看不出来。
   */
  private readonly inspectionPlans: InspectionPlan[] = [
    {
      planId: 1,
      planName: '华东中心仓日常盘点',
      deviceId: 3,
      cronExpression: '0 0 8 * * ?',
      enabled: true,
      createTime: '2026-01-01T08:00:00',
      updateTime: '2026-01-06T08:00:00',
    },
    {
      planId: 2,
      planName: '华南备件仓月度盘点',
      deviceId: 1,
      cronExpression: '0 0 9 1 * ?',
      enabled: true,
      createTime: '2026-01-02T08:00:00',
      updateTime: '2026-01-05T08:00:00',
    },
    {
      planId: 3,
      planName: 'A 区货架专项核查',
      deviceId: 2,
      cronExpression: '',
      // 停用一条：让列表能同时验到两种状态
      enabled: false,
      createTime: '2026-01-03T08:00:00',
      updateTime: '2026-01-04T08:00:00',
    },
  ];

  private readonly inspectionTasks: InspectionTask[] = [
    {
      taskId: 501,
      taskCode: 'INS-20260106-01',
      planId: 1,
      planName: '华东中心仓日常盘点',
      taskType: 0,
      taskTypeDesc: '日常盘点',
      status: 1,
      // 真后端列表 DTO 给的就是这个枚举原文（`InspectionApplicationService` 的 status→String 映射），
      // 界面必须把它译成中文
      statusDesc: 'IN_PROGRESS',
      progress: 45,
      totalItems: 120,
      inspectedItems: 54,
      normalItems: 50,
      abnormalItems: 4,
      missingItems: 3,
      extraItems: 1,
      warehouseId: 1,
      warehouseName: '华东中心仓',
      deviceId: 3,
      deviceName: '读头 04',
      targetDistance: 12,
      startTime: '2026-01-06T09:00:00',
      createTime: '2026-01-06T08:30:00',
      updateTime: '2026-01-06T10:12:00',
    },
    {
      taskId: 502,
      taskCode: 'INS-20260106-02',
      planId: 2,
      planName: '华南备件仓月度盘点',
      taskType: 1,
      taskTypeDesc: '循环盘点',
      status: 0,
      statusDesc: 'PENDING',
      progress: 0,
      totalItems: 86,
      inspectedItems: 0,
      normalItems: 0,
      abnormalItems: 0,
      missingItems: 0,
      extraItems: 0,
      warehouseId: 2,
      warehouseName: '华南备件仓',
      deviceId: 1,
      deviceName: '搬运机器人 01',
      targetDistance: 20,
      createTime: '2026-01-06T07:50:00',
      updateTime: '2026-01-06T07:50:00',
    },
    {
      taskId: 503,
      taskCode: 'INS-20260105-04',
      planId: 1,
      planName: '华东中心仓日常盘点',
      taskType: 0,
      taskTypeDesc: '日常盘点',
      status: 2,
      statusDesc: 'COMPLETED',
      progress: 100,
      totalItems: 96,
      inspectedItems: 91,
      normalItems: 85,
      abnormalItems: 6,
      missingItems: 5,
      extraItems: 1,
      warehouseId: 1,
      warehouseName: '华东中心仓',
      deviceId: 3,
      deviceName: '读头 04',
      targetDistance: 18,
      startTime: '2026-01-05T14:00:00',
      endTime: '2026-01-05T15:20:00',
      createTime: '2026-01-05T13:30:00',
      updateTime: '2026-01-05T15:20:00',
    },
    {
      taskId: 504,
      taskCode: 'INS-20260105-05',
      planId: 3,
      planName: 'A 区货架专项核查',
      taskType: 2,
      taskTypeDesc: '专项核查',
      status: 3,
      // 这一行给的是中文：走"服务端中文描述原样信任"那条分支
      statusDesc: '已暂停',
      progress: 30,
      totalItems: 40,
      inspectedItems: 12,
      normalItems: 12,
      abnormalItems: 0,
      missingItems: 0,
      extraItems: 0,
      warehouseId: 1,
      warehouseName: '华东中心仓',
      deviceId: 2,
      deviceName: '搬运机器人 02',
      targetDistance: 8,
      startTime: '2026-01-05T16:00:00',
      createTime: '2026-01-05T15:40:00',
      updateTime: '2026-01-05T16:25:00',
    },
  ];

  /** 差异明细按任务分表：501 有差异（三种判定各一行），502 还没有（空态）。 */
  private readonly inspectionDiffs: Record<number, InspectionDiffRow[]> = {
    501: [
      { productId: 1, productName: '工业级 RFID 标签', productCode: 'RFID-UHF-01', expectedQuantity: 40, scannedQuantity: 40, difference: 0, status: 'NORMAL' },
      { productId: 2, productName: '高强度紧固件 M12', productCode: 'FAST-M12-00', expectedQuantity: 30, scannedQuantity: 27, difference: -3, status: 'MISSING' },
      { productId: 3, productName: '液压密封组件', productCode: 'HYD-SEAL-22', expectedQuantity: 10, scannedQuantity: 11, difference: 1, status: 'EXTRA' },
      { productId: 1, productName: '工业级 RFID 标签', productCode: 'RFID-UHF-01', expectedQuantity: 20, scannedQuantity: 22, difference: 2, status: 'DIFF' },
    ],
    503: [
      { productId: 2, productName: '高强度紧固件 M12', productCode: 'FAST-M12-00', expectedQuantity: 50, scannedQuantity: 45, difference: -5, status: 'MISSING' },
    ],
  };

  private readonly inspectionResults: InspectionResult[] = [
    {
      resultId: 9001,
      taskId: 503,
      compareTime: '2026-01-05T15:20:00',
      totalItems: 96,
      normalItems: 85,
      missingItems: 5,
      extraItems: 1,
      createTime: '2026-01-05T15:21:00',
      progress: 100,
      status: 'PENDING',
      totalScanned: 91,
      totalExpected: 96,
    },
    {
      resultId: 9002,
      taskId: 501,
      compareTime: '2026-01-04T17:00:00',
      totalItems: 110,
      normalItems: 108,
      missingItems: 2,
      extraItems: 0,
      createTime: '2026-01-04T17:02:00',
      progress: 100,
      status: 'CONFIRMED',
      totalScanned: 110,
      totalExpected: 110,
    },
  ];

  /** 手动补录的流水（追加，不覆盖）：验"补录后任务已扫数真的涨了"。 */
  private readonly manualRecords: { taskId: number; rfid: string; tid: string; remark: string; createTime: string }[] = [];

  private readonly next = (): number => {
    this.nextId += 1;
    return this.nextId;
  };

  /**
   * 分页。**参数名由调用方按服务端事实显式指定**（`'pageSize'` / `'size'` / `null`）。
   *
   * 为什么不"两个名字都认"：这里原先两个都认，注释还写着"`inventory.list` 那两个是 `size`
   * （`real-smoke.mjs` 实测发 `size` 就翻得动页）"。**那条结论是错的，而且"实测"实测的是假桥自己**：
   * 真后端只有 `pageSize`（`InventoryController:149` / `ProductController` / `TagController:112`），
   * 发 `size` 被静默忽略 → 真机永远 10 条/页；而假桥因为"两个都认"，开发态一切正常。
   *
   * 2026-10-03 对真后端实测钉死了这件事（`tools/bench/inventory-tag-probe.mjs`）：
   * `GET /api/tag?size=1` → 7 条（就是全部，参数被忽略）；`?pageSize=1` → 1 条。
   *
   * 所以假桥现在**只认调用方声明的那个名字**：比服务端宽容的假桥会掩盖真机故障，
   * 这是本仓已经付过多次学费的一类偏差。
   */
  private page<T>(rows: T[], params: unknown, paramName: PagingParamName): { rows: T[]; total: number } {
    const p = (params ?? {}) as Record<string, unknown>;
    const page = typeof p['page'] === 'number' && (p['page'] as number) > 0 ? (p['page'] as number) : 1;
    if (paramName === null) {
      // 服务端这些端点根本不接分页参数（如 `warehouse.list` / `device.list` / `inspection.planList`），
      // 全量返回 —— 假桥也不许自作主张截断，否则开发态"翻得动页"、真机只有一页。
      return { rows, total: rows.length };
    }
    const raw = p[paramName];
    const size = typeof raw === 'number' && raw > 0 ? raw : 20;
    return { rows: rows.slice((page - 1) * size, page * size), total: rows.length };
  }

  /** 返回 `undefined` 表示"这个方法不归库存域管"，交给别的 mock 处理。 */
  call<T>(method: string, params: unknown): T | undefined {
    const p = (params ?? {}) as Record<string, unknown>;
    const id = (key: string): number | undefined => {
      const value = p[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    };

    switch (method) {
      // ---- 库存 ----
      case 'inventory.list':
        return this.page(this.inventory, params, 'pageSize') as T;
      /**
       * 服务端搜索。**语义照抄**（读 `InventoryController#search` + `InventoryApplicationService` 得来）：
       *   · `keyword` 与 `type` 都是必填；`type` 只认 `PRODUCT` / `LOCATION`，**其它值回空数组**（不是报错）；
       *   · `PRODUCT` → 按**商品名**查商品，且服务端硬截断前 100 条；
       *   · `LOCATION` → 名字像"按货位"，但代码是 `findByNameContaining(keyword)` 再取这些商品的库存行，
       *     也就是**按商品名匹配的库存全量**（不分区、不截断）。
       * 假桥必须复刻这三点，否则界面会以为"服务端能按货位搜"——那正是最容易写出假功能的地方。
       */
      case 'inventory.search': {
        const keyword = String(p['keyword'] ?? '').trim();
        const type = String(p['type'] ?? '').toUpperCase();
        if (keyword === '') {
          return [] as unknown as T;
        }
        const matchedProducts = this.products.filter((x) => x.productName.includes(keyword));
        if (type === 'PRODUCT') {
          return matchedProducts.slice(0, 100) as unknown as T;
        }
        if (type === 'LOCATION') {
          const ids = matchedProducts.map((x) => x.productId);
          return this.inventory.filter((inv) => ids.includes(inv.productId)) as unknown as T;
        }
        return [] as unknown as T;
      }
      case 'inventory.detail': {
        const row = this.inventory.find((r) => r.inventoryId === id('inventoryId'));
        return (row ?? this.inventory[0]) as T;
      }
      case 'inventory.lock':
      case 'inventory.unlock': {
        const row = this.inventory.find((r) => r.inventoryId === id('inventoryId'));
        const qty = id('quantity') ?? 0;
        if (!row) {
          throw new BridgeError({ code: BridgeErrorCode.PARAMS_INVALID, messageKey: 'bridge.paramsInvalid' });
        }
        if (method === 'inventory.lock') {
          row.lockedQuantity += qty;
          row.status = 1;
        } else {
          row.lockedQuantity = Math.max(0, row.lockedQuantity - qty);
          row.status = row.lockedQuantity > 0 ? 1 : 0;
        }
        row.updateTime = nowIso();
        return {} as T;
      }

      // ---- 商品 ----
      case 'product.list':
        return this.page(this.products, params, 'pageSize') as T;
      case 'product.create': {
        const name = String(p['productName'] ?? '');
        const code = String(p['productCode'] ?? '');
        if (name === '' || code === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '商品名称与编码不能为空' });
        }
        this.products.unshift({
          productId: this.next(),
          productName: name,
          productCode: code,
          model: String(p['model'] ?? ''),
          unit: String(p['unit'] ?? ''),
          createTime: nowIso(),
        });
        return {} as T;
      }
      /**
       * 商品更新。**语义照抄服务端 `InventoryApplicationService#updateProduct`**（这是关键）：
       *   · 商品不存在 → NOT_FOUND「产品不存在」；
       *   · `productName` / `productCode` / `unit` **为空或空白 = 保留原值**（部分更新，不是覆盖）；
       *   · `productCode` 为空且库里原本也没有编码 → 服务端会生成 `"P" + 毫秒`；
       *   · `model` **只要不是 null 就写**（所以传空串是"清空型号"，与上面三个不一样）。
       * 少写"空值保留"这一条，界面就会出现"我只改了单位，名字却被清空了"——而且是静默的。
       */
      case 'product.update': {
        const row = this.products.find((x) => x.productId === id('productId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '产品不存在' });
        }
        const name = p['productName'];
        if (typeof name === 'string' && name.trim() !== '') {
          row.productName = name;
        }
        const code = p['productCode'];
        if (typeof code === 'string' && code.trim() !== '') {
          row.productCode = code;
        } else if (row.productCode.trim() === '') {
          row.productCode = `P${Date.now()}`;
        }
        if (p['model'] !== undefined && p['model'] !== null) {
          row.model = String(p['model']);
        }
        const unit = p['unit'];
        if (typeof unit === 'string' && unit.trim() !== '') {
          row.unit = unit;
        }
        return { ...row } as T;
      }
      case 'product.delete': {
        const productId = id('productId');
        const index = this.products.findIndex((x) => x.productId === productId);
        if (index < 0) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '商品不存在' });
        }
        // 被库存引用的商品不许删 —— 与真后端的引用校验同类
        if (this.inventory.some((r) => r.productId === productId)) {
          throw new BridgeError({ code: 'VAL-0002', messageKey: 'error.validation', details: '该商品已有库存记录，不能删除' });
        }
        this.products.splice(index, 1);
        return {} as T;
      }

      // ---- 仓库 ----
      case 'warehouse.list':
        return this.page(this.warehouses, params, null) as T;
      case 'warehouse.create': {
        const name = String(p['warehouseName'] ?? '');
        const code = String(p['warehouseCode'] ?? '');
        if (name === '' || code === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '仓库名称与编码不能为空' });
        }
        this.warehouses.unshift({
          warehouseId: this.next(),
          warehouseName: name,
          warehouseCode: code,
          address: String(p['address'] ?? ''),
          description: String(p['description'] ?? ''),
        });
        return {} as T;
      }
      /**
       * 仓库更新。**语义与商品不一样，别照抄**（`WarehouseApplicationService#updateWarehouse`）：
       * 四个字段都是 **`!= null` 就写** —— 传空串等于**清空**该字段，而不是"保留原值"
       * （商品那边 `productName/productCode/unit` 用的是 `isBlank`，空串/空白 = 保留）。
       * 把两者写成同一个，界面上就会出现"清空地址没生效"或"只改名字却把地址擦了"这类静默差异。
       */
      case 'warehouse.update': {
        // 路径参数名是 id（契约 /api/warehouse/{id}），与删除一致
        const row = this.warehouses.find((x) => x.warehouseId === id('id'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '仓库不存在' });
        }
        if (p['warehouseName'] !== undefined && p['warehouseName'] !== null) {
          row.warehouseName = String(p['warehouseName']);
        }
        if (p['warehouseCode'] !== undefined && p['warehouseCode'] !== null) {
          row.warehouseCode = String(p['warehouseCode']);
        }
        if (p['address'] !== undefined && p['address'] !== null) {
          row.address = String(p['address']);
        }
        if (p['description'] !== undefined && p['description'] !== null) {
          row.description = String(p['description']);
        }
        return { ...row } as T;
      }
      case 'warehouse.delete': {
        // 参数名是 id（契约 /api/warehouse/{id}）
        const warehouseId = id('id');
        const index = this.warehouses.findIndex((x) => x.warehouseId === warehouseId);
        if (index < 0) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '仓库不存在（注意删除端点的参数名是 id）' });
        }
        this.warehouses.splice(index, 1);
        return {} as T;
      }

      // ---- 标签 ----
      case 'tag.list':
        return this.page(this.tags, params, 'pageSize') as T;
      case 'tag.detail': {
        const row = this.tags.find((t) => t.tagId === id('tagId'));
        return (row ?? this.tags[0]) as T;
      }
      case 'tag.byCode': {
        const code = String(p['code'] ?? '');
        const row = this.tags.find((t) => t.barcode === code || t.rfid === code || t.nfcUid === code);
        if (!row) {
          // 扫到不存在的编码是真实现场会遇到的：如实报错，让界面画错误态
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: `没有找到编码 ${code} 对应的标签` });
        }
        return row as T;
      }
      case 'tag.batchBindWithCaptcha': {
        const tagIds = Array.isArray(p['tagIds']) ? (p['tagIds'] as number[]) : [];
        const productId = id('productId');
        const captchaCode = String(p['captchaCode'] ?? '').trim();
        if (captchaCode === '') {
          throw new BridgeError({ code: 'AUTH-0003', messageKey: 'error.captcha', details: '验证码不能为空' });
        }
        const product = this.products.find((x) => x.productId === productId);
        for (const t of this.tags) {
          if (tagIds.includes(t.tagId)) {
            t.status = 1;
            t.productId = product?.productId;
            t.productName = product?.productName;
            t.productCode = product?.productCode;
            t.updateTime = nowIso();
          }
        }
        return {} as T;
      }
      case 'tag.batchUnbind': {
        const tagIds = Array.isArray(p['tagIds']) ? (p['tagIds'] as number[]) : [];
        for (const t of this.tags) {
          if (tagIds.includes(t.tagId)) {
            t.status = 0;
            t.productId = undefined;
            t.productName = undefined;
            t.productCode = undefined;
            t.updateTime = nowIso();
          }
        }
        return {} as T;
      }

      // ---- 出入库单 ----
      case 'stockOrder.list':
        return this.page([...this.orders].reverse(), params, 'size') as T;
      case 'stockOrder.detail': {
        const row = this.orders.find((o) => o.orderId === id('orderId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '单据不存在' });
        }
        return row as T;
      }
      case 'stockOrder.create': {
        const orderNo = String(p['orderNo'] ?? '').trim();
        const warehouseId = id('warehouseId');
        const createBy = id('createBy');
        // 服务端不生成单号：真后端实测不给就报 VAL-0001
        if (orderNo === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '单据编号不能为空' });
        }
        if (warehouseId === undefined) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '目的仓库不能为空' });
        }
        if (createBy === undefined) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '建单人不能为空' });
        }
        const typeCode = String(p['orderType'] ?? 'IN').toUpperCase() === 'OUT' ? 1 : 0;
        const warehouse = this.warehouses.find((w) => w.warehouseId === warehouseId);
        const created: StockOrder = {
          orderId: this.next(),
          orderNo,
          warehouseId,
          warehouseName: warehouse?.warehouseName ?? '未命名仓库',
          orderType: typeCode,
          orderTypeStr: typeCode === 1 ? 'OUT' : 'IN',
          orderStatus: 0,
          orderStatusStr: 'PENDING',
          totalItems: 0,
          createBy,
          createdByName: '现场操作员',
          createTime: nowIso(),
          items: [],
          ...(typeof p['remark'] === 'string' && p['remark'] !== '' ? { remark: p['remark'] } : {}),
        };
        this.orders.push(created);
        return created as T;
      }
      /**
       * 明细增删。两道闸门逐字照抄服务端 `InOutApplicationService#addItem/removeItem`：
       *  1. 单据必须存在（「出入库单不存在」）；
       *  2. 状态必须是 **PENDING(0) 或 REJECTED(5)**（「只有待处理或已驳回的单据可以添加/删除明细」）。
       * 另外两点也照抄：
       *  · 添加时**只从标签取商品**（`detail.setProductId(tag.getProductId())`）——
       *    请求里的 `productName` / `quantity` / `locationCode` 服务端根本不读，界面也就别让用户填；
       *  · 加一件 `totalItems + 1`、删一件 `totalItems - 1`（明细按标签逐件记）。
       */
      case 'stockOrder.addItem': {
        const order = this.orders.find((o) => o.orderId === id('orderId'));
        if (!order) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '出入库单不存在' });
        }
        if (order.orderStatus !== 0 && order.orderStatus !== 5) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '只有待处理或已驳回的单据可以添加明细' });
        }
        const tagId = id('tagId');
        const tag = this.tags.find((t) => t.tagId === tagId);
        if (!tag) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '标签不存在' });
        }
        order.items.push({
          tagId: tag.tagId,
          productId: tag.productId ?? 0,
          productName: tag.productName ?? '未绑定商品',
          productCode: tag.productCode ?? '',
          quantity: 1,
          locationCode: '',
        });
        order.totalItems += 1;
        return order as T;
      }
      case 'stockOrder.removeItem': {
        const order = this.orders.find((o) => o.orderId === id('orderId'));
        if (!order) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '出入库单不存在' });
        }
        if (order.orderStatus !== 0 && order.orderStatus !== 5) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '只有待处理或已驳回的单据可以删除明细' });
        }
        const tagId = id('tagId');
        const index = order.items.findIndex((x) => x.tagId === tagId);
        if (index < 0) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '明细不存在' });
        }
        order.items.splice(index, 1);
        order.totalItems -= 1;
        return {} as T;
      }
      case 'stockOrder.submit': {        const row = this.orders.find((o) => o.orderId === id('orderId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '单据不存在' });
        }
        // 服务端两个分支：状态必须是非 PENDING/REJECTED，且**必须要有明细**
        if (row.orderStatus !== 0 && row.orderStatus !== 5) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '只有待处理或已驳回的单据可以提交' });
        }
        if (row.items.length === 0) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '单据无明细，无法提交' });
        }
        row.orderStatus = 4;
        row.orderStatusStr = 'SUBMITTED';
        row.submitTime = nowIso();
        return {} as T;
      }
      case 'stockOrder.withdraw': {
        const row = this.orders.find((o) => o.orderId === id('orderId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '单据不存在' });
        }
        if (row.orderStatus !== 4) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '只有待审核的单据可以撤回' });
        }
        row.orderStatus = 0;
        row.orderStatusStr = 'PENDING';
        row.submitTime = undefined;
        return {} as T;
      }
      case 'stockOrder.audit': {
        const row = this.orders.find((o) => o.orderId === id('orderId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '单据不存在' });
        }
        if (row.orderStatus !== 4) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '只有待审核的单据可以进行审核' });
        }
        const approved = p['approved'] === true;
        row.orderStatus = approved ? 1 : 5;
        row.orderStatusStr = approved ? 'APPROVED' : 'REJECTED';
        if (typeof p['reason'] === 'string' && p['reason'] !== '') {
          row.remark = p['reason'];
        }
        return {} as T;
      }

      // ---- 设备（现场域）----
      case 'device.list':
        return this.page(this.devices, params, null) as T;
      case 'device.statistics':
        return {
          totalCount: this.devices.length,
          onlineCount: this.devices.filter((d) => d.deviceStatus === 1).length,
        } as T;
      case 'device.detail': {
        const row = this.devices.find((d) => d.deviceId === id('deviceId'));
        return (row ?? this.devices[0]) as T;
      }
      case 'device.byCode': {
        // 参数名是 deviceCode（契约里就是这个），不是 code
        const code = String(p['deviceCode'] ?? '');
        const row = this.devices.find((d) => d.deviceCode === code);
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: `没有找到编号 ${code} 的设备` });
        }
        return row as T;
      }

      // ---- 巡检（现场域）----
      /**
       * 计划列表。服务端控制器还接受 `planType` / `warehouseId` 两个过滤参数，
       * 但 `InspectionPlanDTO` 里**没有**这两个字段 —— 假桥不去发明它们，只认 `enabled`。
       */
      case 'inspection.planList': {
        const enabled = p['enabled'];
        const rows =
          typeof enabled === 'boolean' ? this.inspectionPlans.filter((x) => x.enabled === enabled) : this.inspectionPlans;
        return this.page(rows, params, null) as T;
      }
      case 'inspection.planDetail': {
        const row = this.inspectionPlans.find((x) => x.planId === id('planId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检计划不存在' });
        }
        return row as T;
      }
      /**
       * 新建计划。服务端**只校验一件事**：计划名不能重复（`巡检计划名称已存在`）；
       * 建出来的计划一律 `status=1`（启用）。假桥照抄，不额外发明"名称必填"之类的服务端没有的规则
       * （界面侧仍然必填 —— 那是界面自己的口径，不是服务端的）。
       */
      case 'inspection.planCreate': {
        const planName = String(p['planName'] ?? '');
        if (this.inspectionPlans.some((x) => x.planName === planName)) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '巡检计划名称已存在' });
        }
        const created: InspectionPlan = {
          planId: this.next(),
          planName,
          deviceId: id('deviceId'),
          cronExpression: String(p['cronExpression'] ?? ''),
          enabled: true,
          createTime: nowIso(),
          updateTime: nowIso(),
        };
        this.inspectionPlans.unshift(created);
        return created as T;
      }
      /**
       * 更新计划：`planName` / `deviceId` / `cronExpression` 都是 **`!= null` 才写**，
       * `enabled` 映射到服务端的 `status`（1 启用 / 0 停用）。计划不存在 →「巡检计划不存在」。
       */
      case 'inspection.planUpdate': {
        const row = this.inspectionPlans.find((x) => x.planId === id('planId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检计划不存在' });
        }
        if (p['planName'] !== undefined && p['planName'] !== null) {
          row.planName = String(p['planName']);
        }
        if (p['deviceId'] !== undefined && p['deviceId'] !== null) {
          row.deviceId = id('deviceId');
        }
        if (p['cronExpression'] !== undefined && p['cronExpression'] !== null) {
          row.cronExpression = String(p['cronExpression']);
        }
        if (typeof p['enabled'] === 'boolean') {
          row.enabled = p['enabled'];
        }
        row.updateTime = nowIso();
        return { ...row } as T;
      }
      case 'inspection.planDelete': {
        const index = this.inspectionPlans.findIndex((x) => x.planId === id('planId'));
        if (index < 0) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检计划不存在' });
        }
        this.inspectionPlans.splice(index, 1);
        return {} as T;
      }
      case 'inspection.taskPage':
        return this.page(this.inspectionTasks, params, 'pageSize') as T;
      case 'inspection.taskDetail': {
        const row = this.inspectionTasks.find((t) => t.taskId === id('taskId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检任务不存在' });
        }
        return row as T;
      }
      case 'inspection.taskDiff': {
        const taskId = id('taskId') ?? -1;
        return (this.inspectionDiffs[taskId] ?? []) as unknown as T;
      }
      case 'inspection.taskStatus': {
        const row = this.inspectionTasks.find((t) => t.taskId === id('taskId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检任务不存在' });
        }
        /**
         * **只认 `IN_PROGRESS` 与 `COMPLETED`** —— 这是 `InspectionApplicationService#updateTaskStatus`
         * 的唯一两个分支，`status` 初值是 `0`（PENDING），也就是说**传错值不会报错，
         * 而是静默把任务重置回"待执行"**。
         *
         * React 版发的正是 `RUNNING`（`InspectionTaskDetailScreen.tsx:182,425`），
         * 于是"开始执行"在真后端上等于"把任务打回待执行"，而那条 bench 只断言
         * "不是 HTTP-400"，所以一直没被发现。这里**照抄这个坑**：谁把值传错，
         * smoke 里就会看到芯片没变成"进行中" —— 让它在假桥下也炸得出来。
         */
        const next = String(p['status'] ?? '').toUpperCase();
        if (next === 'IN_PROGRESS') {
          row.status = 1;
          row.statusDesc = 'IN_PROGRESS';
          if (row.startTime === undefined) {
            row.startTime = nowIso();
          }
        } else if (next === 'COMPLETED') {
          row.status = 2;
          row.statusDesc = 'COMPLETED';
          row.progress = 100;
          row.endTime = nowIso();
        } else {
          row.status = 0;
          row.statusDesc = 'PENDING';
        }
        row.updateTime = nowIso();
        return {} as T;
      }
      case 'inspection.taskProgress': {
        const row = this.inspectionTasks.find((t) => t.taskId === id('taskId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检任务不存在' });
        }
        const progress = p['progress'];
        if (typeof progress !== 'number' || !Number.isFinite(progress)) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '进度必须是数字' });
        }
        row.progress = Math.max(0, Math.min(100, Math.round(progress)));
        const scanned = p['scannedCount'];
        if (typeof scanned === 'number' && Number.isFinite(scanned) && scanned >= 0) {
          row.inspectedItems = Math.round(scanned);
        }
        row.updateTime = nowIso();
        return {} as T;
      }
      case 'inspection.taskCreate': {
        /**
         * 必填项只有仓库：`tools/bench/real-inspection-write.mjs` 实测的建任务 payload 是
         * `{ deviceId, warehouseId, targetDistance }` —— **没有 planId**，所以这里也不强求计划。
         * 设备与目标距离可以为空（界面允许不指派设备）。
         */
        const warehouseId = id('warehouseId');
        if (warehouseId === undefined) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '盘点仓库不能为空' });
        }
        const planId = id('planId');
        const plan = this.inspectionPlans.find((x) => x.planId === planId);
        const warehouse = this.warehouses.find((w) => w.warehouseId === warehouseId);
        if (!warehouse) {
          // 服务层原话：`InspectionApplicationService` 先判空再判存在
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '仓库不存在' });
        }
        const device = this.devices.find((d) => d.deviceId === id('deviceId'));
        const taskId = this.next();
        const created: InspectionTask = {
          taskId,
          taskCode: `INS-2026-${String(taskId).padStart(4, '0')}`,
          planId: planId ?? 0,
          planName: plan?.planName ?? '未关联计划',
          taskType: 0,
          taskTypeDesc: '日常盘点',
          status: 0,
          statusDesc: 'PENDING',
          progress: 0,
          totalItems: 0,
          inspectedItems: 0,
          normalItems: 0,
          abnormalItems: 0,
          missingItems: 0,
          extraItems: 0,
          warehouseId,
          warehouseName: warehouse?.warehouseName ?? '未命名仓库',
          deviceId: device?.deviceId ?? 0,
          deviceName: device?.deviceName ?? '未指派设备',
          targetDistance: id('targetDistance') ?? 0,
          createTime: nowIso(),
          updateTime: nowIso(),
        };
        this.inspectionTasks.unshift(created);
        return created as T;
      }
      case 'inspection.manualRecord': {
        const row = this.inspectionTasks.find((t) => t.taskId === id('taskId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检任务不存在' });
        }
        /**
         * **实测的服务端规则**（`real-inspection-write.mjs` 第 7 步，跑两次才定位准）：
         * 只允许对**已完成**的任务补录。判据不是"参数没送到"，而是业务拒绝 ——
         * 所以这里连服务端那句原话一起复刻，界面才有可能把它展示给现场人员。
         */
        if (row.status !== 2) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '只能对已完成的巡检任务进行补录' });
        }
        const raw = Array.isArray(p['items']) ? (p['items'] as unknown[]) : [];
        if (raw.length === 0) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '补录明细不能为空' });
        }
        for (const item of raw) {
          const record = (item ?? {}) as Record<string, unknown>;
          const rfid = String(record['rfid'] ?? '').trim();
          if (rfid === '') {
            throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '每一行都要填 RFID 编码' });
          }
          this.manualRecords.push({
            taskId: row.taskId,
            rfid,
            tid: String(record['tid'] ?? '').trim(),
            remark: String(record['remark'] ?? '').trim(),
            createTime: nowIso(),
          });
        }
        /**
         * 补录会**触发服务端重算计数**（实测：补录一行后 `normalItems` 从 8 变 0 ——
         * 补录条目的 RFID 不在盘点计划的期望明细里，重算时不计入"正常"）。
         * 这里按同一口径重算，好让界面必须重新拉任务详情才看得到真实数字。
         */
        row.inspectedItems = this.manualRecords.filter((r) => r.taskId === row.taskId).length;
        row.normalItems = 0;
        row.updateTime = nowIso();
        return {} as T;
      }
      case 'inspection.resultList': {
        /**
         * 真后端方法是 `listResults(taskId, warehouseId, status)`：**支持按任务过滤**，
         * 而且**不分页**（返回的是 `List<InspectionResultDTO>`，没有 page/pageSize 参数）。
         */
        const taskId = id('taskId');
        const warehouseId = id('warehouseId');
        const status = String(p['status'] ?? '').toUpperCase();
        return this.inspectionResults.filter((r) => {
          if (taskId !== undefined && r.taskId !== taskId) {
            return false;
          }
          if (warehouseId !== undefined) {
            const task = this.inspectionTasks.find((t) => t.taskId === r.taskId);
            if (task?.warehouseId !== warehouseId) {
              return false;
            }
          }
          if (status !== '' && r.status.toUpperCase() !== status) {
            return false;
          }
          return true;
        }) as unknown as T;
      }
      case 'inspection.resultDetail': {
        const row = this.inspectionResults.find((r) => r.resultId === id('resultId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检结果不存在' });
        }
        return row as T;
      }
      case 'inspection.resultCreate': {
        const task = this.inspectionTasks.find((t) => t.taskId === id('taskId'));
        if (!task) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检任务不存在' });
        }
        const keys = ['totalItems', 'normalItems', 'abnormalItems', 'missingItems', 'extraItems'] as const;
        const num: Record<string, number> = {};
        for (const key of keys) {
          const value = p[key];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '各数量必须是非负数字' });
          }
          num[key] = Math.round(value);
        }
        const total = num['totalItems'] ?? 0;
        const normal = num['normalItems'] ?? 0;
        const abnormal = num['abnormalItems'] ?? 0;
        const created: InspectionResult = {
          resultId: this.next(),
          taskId: task.taskId,
          compareTime: nowIso(),
          totalItems: total,
          normalItems: normal,
          missingItems: num['missingItems'] ?? 0,
          extraItems: num['extraItems'] ?? 0,
          createTime: nowIso(),
          progress: 100,
          status: 'PENDING',
          totalScanned: normal + abnormal,
          totalExpected: total,
        };
        this.inspectionResults.unshift(created);
        // 录入结果 = 这次盘点收口：任务跟着变成已完成，数字与结果对齐
        task.status = 2;
        task.statusDesc = 'COMPLETED';
        task.progress = 100;
        task.endTime = nowIso();
        task.totalItems = total;
        task.normalItems = normal;
        task.abnormalItems = abnormal;
        task.missingItems = created.missingItems;
        task.extraItems = created.extraItems;
        task.inspectedItems = created.totalScanned;
        task.updateTime = nowIso();
        return created as T;
      }
      case 'inspection.resultConfirm': {
        const row = this.inspectionResults.find((r) => r.resultId === id('resultId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '巡检结果不存在' });
        }
        /**
         * 真后端这个端点目前是**空实现**（`confirmResult` 拿个 `Map` body 直接 `success()`，
         * 连 `resultId` 都只做路径回显），所以这里也**不造"重复确认会被拒"这种服务端规则** ——
         * 只把假数据的这条记录翻成已入账，好让界面上的状态变化能被验到。
         */
        row.status = 'CONFIRMED';
        return {} as T;
      }

      default:
        return undefined;
    }
  }
}

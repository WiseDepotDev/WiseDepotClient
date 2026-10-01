/**
 * 信息架构：**四域 + 推入的屏**（与 React 版 `packages/shells/src/navigation.ts` 同一套口径）。
 *
 * 与旧版的关系：旧 `AppRoute.kt` 是 19 条扁平目的地 + 19 个 `NavFlags` 布尔 + 双顺序；
 * 这套模型**不复用**它。这里只有两层：
 *
 *  · **导航叶子**（`DOMAINS[].children`）：一级目的地，进侧栏 / 底栏。它的 id 是桥方法 id，
 *    因此"壳里写了一个后端不存在的域"这种错误在**类型层面**就暴露（`DomainId` 取自契约）。
 *  · **推入的屏**（`DESTINATIONS`）：详情类目的地，**不占导航项**，只能被列表点行或扫码推进来。
 *    曾经把"标签详情""单据详情"都塞进导航叶子，结果库存域长出 8 个导航项、手机上要横滚才看全 ——
 *    它们在信息架构里本来就该在下一层。
 *
 * 域分组标签（运营 / 库存 / 现场 / 管理）取自参考图，但**可点项必须来自真实 IA**：
 * 参考图里的"盘点任务""车辆管理""基础设置"在本仓不存在，不新增。
 */
export type DomainId = 'overview' | 'inventory' | 'field' | 'me';

export interface NavLeaf {
  readonly id: string;
  /** 页面标题（业务语言）。 */
  readonly label: string;
  /** 该页主用的桥方法 id —— 同时是路由 name。 */
  readonly primaryMethod: string;
  /** 路由路径（hash 路由）。 */
  readonly path: string;
  /** 手机分段控件 / 入口列表里的短标签。 */
  readonly short: string;
}

export interface NavDomain {
  readonly id: DomainId;
  /** 侧栏分组标签。 */
  readonly label: string;
  /** 手机底栏标签。 */
  readonly short: string;
  readonly children: readonly NavLeaf[];
}

export const DOMAINS: readonly NavDomain[] = [
  {
    id: 'overview',
    label: '运营',
    short: '概览',
    children: [
      { id: 'dashboard', label: '看板', short: '看板', primaryMethod: 'dashboard.summary', path: '/overview/dashboard' },
      { id: 'alerts', label: '告警中心', short: '告警', primaryMethod: 'alert.list', path: '/overview/alerts' },
    ],
  },
  {
    id: 'inventory',
    label: '库存',
    short: '库存',
    children: [
      { id: 'inventory', label: '库存查询', short: '库存', primaryMethod: 'inventory.list', path: '/inventory/inventory' },
      { id: 'products', label: '商品管理', short: '商品', primaryMethod: 'product.list', path: '/inventory/products' },
      { id: 'tags', label: '标签管理', short: '标签', primaryMethod: 'tag.list', path: '/inventory/tags' },
      {
        id: 'stock-orders',
        label: '出入库单',
        short: '单据',
        primaryMethod: 'stockOrder.list',
        path: '/inventory/stock-orders',
      },
      {
        id: 'stock-order-create',
        label: '新建出入库单',
        short: '新建单据',
        primaryMethod: 'stockOrder.create',
        path: '/inventory/stock-orders/new',
      },
      {
        id: 'warehouses',
        label: '仓库管理',
        short: '仓库',
        primaryMethod: 'warehouse.list',
        path: '/inventory/warehouses',
      },
    ],
  },
  {
    id: 'field',
    label: '现场',
    short: '现场',
    children: [
      {
        id: 'inspection-plans',
        label: '巡检计划',
        short: '计划',
        primaryMethod: 'inspection.planList',
        path: '/field/inspection-plans',
      },
      {
        id: 'inspections',
        label: '巡检任务',
        short: '巡检',
        primaryMethod: 'inspection.taskPage',
        path: '/field/inspections',
      },
      {
        id: 'inspection-create',
        label: '新建巡检',
        short: '新建巡检',
        primaryMethod: 'inspection.taskCreate',
        path: '/field/inspections/new',
      },
      {
        id: 'inspection-result',
        label: '录入结果',
        short: '录结果',
        primaryMethod: 'inspection.resultCreate',
        path: '/field/inspections/results/new',
      },
      {
        id: 'inspection-manual',
        label: '手动补录',
        short: '补录',
        primaryMethod: 'inspection.manualRecord',
        path: '/field/inspections/manual',
      },
      { id: 'devices', label: '设备管理', short: '设备', primaryMethod: 'device.list', path: '/field/devices' },
    ],
  },
  {
    id: 'me',
    label: '管理',
    short: '我的',
    children: [
      { id: 'messages', label: '消息', short: '消息', primaryMethod: 'message.list', path: '/me/messages' },
      { id: 'users', label: '用户管理', short: '用户', primaryMethod: 'user.list', path: '/me/users' },
      {
        id: 'permissions',
        label: '权限管理',
        short: '权限',
        primaryMethod: 'permission.list',
        path: '/me/permissions',
      },
      { id: 'profile', label: '个人设置', short: '设置', primaryMethod: 'profile.get', path: '/me/profile' },
    ],
  },
];

/** 推入的屏：由别的屏推入，不占导航项。 */
export interface Destination {
  readonly method: string;
  readonly label: string;
  /**
   * 路径模板。`:x` 段是路由参数。
   *
   * 注意：**必须与叶子的静态路径不冲突**。同一父路径下静态段要排在参数段之前
   * （例如 `/inventory/stock-orders/new` 必须在 `/inventory/stock-orders/:orderId` 之前），
   * 这条由 `check:navigation` 在构建期验证 —— 顺序错了用户点到的是"新建"，不是详情。
   */
  readonly path: string;
  readonly paramKeys: readonly string[];
}

export const DESTINATIONS: readonly Destination[] = [
  { method: 'alert.detail', label: '告警详情', path: '/overview/alerts/:alertId', paramKeys: ['alertId'] },
  {
    method: 'inventory.detail',
    label: '库存详情',
    path: '/inventory/inventory/:inventoryId',
    paramKeys: ['inventoryId'],
  },
  { method: 'tag.detail', label: '标签详情', path: '/inventory/tags/:tagId', paramKeys: ['tagId'] },
  { method: 'tag.byCode', label: '标签详情', path: '/inventory/tags/code/:code', paramKeys: ['code'] },
  {
    method: 'stockOrder.detail',
    label: '单据详情',
    path: '/inventory/stock-orders/:orderId',
    paramKeys: ['orderId'],
  },
  { method: 'device.detail', label: '设备详情', path: '/field/devices/:deviceId', paramKeys: ['deviceId'] },
  {
    method: 'device.byCode',
    label: '设备详情',
    // 与 `:deviceId` 不同段数，不会互相抢先匹配；`code` 段映射到接口的 `deviceCode` 参数
    path: '/field/devices/code/:code',
    paramKeys: ['code'],
  },
  {
    method: 'inspection.resultList',
    label: '巡检结果',
    /**
     * 结果列表是**推入的屏**，不占导航项：它天然按任务过滤（`?taskId=`），
     * 从任务详情或"录入结果"提交后推进来。
     *
     * **必须排在 `inspection.taskDetail` 之前**：两者段数相同
     * （`/field/inspections/results` 与 `/field/inspections/:taskId`），
     * 静态段排在参数段之后就会被 `:taskId='results'` 吃掉。
     * `/field/inspections/results/:resultId` 段数不同，位置无所谓。
     */
    path: '/field/inspections/results',
    paramKeys: [],
  },
  {
    method: 'inspection.taskDetail',
    label: '巡检任务详情',
    path: '/field/inspections/:taskId',
    paramKeys: ['taskId'],
  },
  {
    method: 'inspection.resultDetail',
    label: '巡检结果详情',
    path: '/field/inspections/results/:resultId',
    paramKeys: ['resultId'],
  },
  { method: 'message.detail', label: '消息详情', path: '/me/messages/:messageId', paramKeys: ['messageId'] },
  { method: 'user.detail', label: '用户详情', path: '/me/users/:userId', paramKeys: ['userId'] },
];

/** 扫码的落点：扫到一个标签编码之后去哪一屏（**唯一出处**，两个壳都引用它）。 */
export const SCAN_TARGET_METHOD = 'tag.byCode';

export function domainOf(id: DomainId): NavDomain {
  const found = DOMAINS.find((d) => d.id === id);
  if (!found) {
    throw new Error(`未知的一级域：${id}`);
  }
  return found;
}

export function findLeafByMethod(method: string): { domain: NavDomain; leaf: NavLeaf } | undefined {
  for (const domain of DOMAINS) {
    const leaf = domain.children.find((c) => c.primaryMethod === method);
    if (leaf) {
      return { domain, leaf };
    }
  }
  return undefined;
}

export function destinationOf(method: string): Destination | undefined {
  return DESTINATIONS.find((d) => d.method === method);
}

/** 一个目的地是否可达：要么是导航叶子，要么在 DESTINATIONS 里。 */
export function canReach(method: string): boolean {
  return findLeafByMethod(method) !== undefined || destinationOf(method) !== undefined;
}

/** 全部可达方法 id（叶子 + 目的地）。路由表必须是它的子集。 */
export function allReachableMethods(): readonly string[] {
  return [...DOMAINS.flatMap((d) => d.children.map((c) => c.primaryMethod)), ...DESTINATIONS.map((d) => d.method)];
}

/** 一条可搜索的导航项（顶栏「页面跳转」用）。 */
export interface NavEntry {
  readonly method: string;
  readonly label: string;
  readonly path: string;
  readonly domainLabel: string;
  readonly detail: boolean;
}

/**
 * 扁平化的导航项清单（叶子 + 目的地）。
 *
 * 用途是顶栏的**页面跳转搜索**：它搜的是"页面名字"，是本地的一张表，
 * **不搜业务数据** —— 本仓没有全局数据搜索方法，把两者混在一起会让用户
 * 以为"搜不到=没有这条数据"。
 */
export function allNavEntries(): readonly NavEntry[] {
  const entries: NavEntry[] = [];
  for (const domain of DOMAINS) {
    for (const leaf of domain.children) {
      entries.push({
        method: leaf.primaryMethod,
        label: leaf.label,
        path: leaf.path,
        domainLabel: domain.label,
        detail: false,
      });
    }
  }
  for (const dest of DESTINATIONS) {
    entries.push({
      method: dest.method,
      label: dest.label,
      path: dest.path.replace(/:[A-Za-z0-9_]+/g, ''),
      domainLabel: '详情',
      detail: true,
    });
  }
  return entries;
}

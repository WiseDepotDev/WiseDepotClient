import type { BridgeDomain } from '@wise/contract';
import type { ScreenParams } from '@wise/features';

/**
 * 信息架构：**四域 + 系统域**。
 *
 * 与旧版的关系：旧 `AppRoute.kt` 是 19 条扁平目的地 + `NavFlags` 19 个布尔 + 双顺序
 * （`renderOrder`/`backOrder`），新架构**不复用**那套模型。这里只保留一层展开：
 * 域 → 域内页面。域 id 直接取自契约生成物的 `BridgeDomain`，
 * 因此"壳里写了一个后端不存在的域"这种错误在**编译期**就会暴露。
 */
export type DomainId = Exclude<BridgeDomain, 'system'>;

export interface NavLeaf {
  readonly id: string;
  /** 页面标题（中文，与后端 DTO 的 desc 字段无关）。 */
  readonly label: string;
  /** 该页主用的桥方法 id，用于在占位屏上显示"这一屏将调用什么"。 */
  readonly primaryMethod: string;
}

export interface NavDomain {
  readonly id: DomainId;
  readonly label: string;
  /** 手机底栏用的短标签。 */
  readonly short: string;
  readonly children: readonly NavLeaf[];
}

/** 四域顺序即导航顺序（手机底栏 = 桌面侧栏一级项）。 */
export const DOMAINS: readonly NavDomain[] = [
  {
    id: 'overview',
    label: '概览',
    short: '概览',
    children: [
      { id: 'dashboard', label: '看板', primaryMethod: 'dashboard.summary' },
      { id: 'alerts', label: '告警中心', primaryMethod: 'alert.list' },
    ],
  },
  {
    id: 'inventory',
    label: '库存',
    short: '库存',
    children: [
      { id: 'inventory', label: '库存查询', primaryMethod: 'inventory.list' },
      { id: 'products', label: '商品管理', primaryMethod: 'product.list' },
      { id: 'tags', label: '标签管理', primaryMethod: 'tag.list' },
      // 标签详情**不是**导航项：它由「标签管理」点一行、或扫码枪扫到编码推入（见 DESTINATIONS）
      { id: 'stock-orders', label: '出入库单', primaryMethod: 'stockOrder.list' },
      { id: 'stock-order-create', label: '新建出入库单', primaryMethod: 'stockOrder.create' },
      // 单据详情同理：由列表点一行推入，不占导航项
      { id: 'warehouses', label: '仓库管理', primaryMethod: 'warehouse.list' },
      { id: 'warehouses', label: '仓库管理', primaryMethod: 'warehouse.list' },
    ],
  },
  {
    id: 'field',
    label: '现场',
    short: '现场',
    children: [
      { id: 'inspections', label: '巡检任务', primaryMethod: 'inspection.taskPage' },
      // 现场域的"写"入口。旧 APP 把建任务/补录藏在列表页的浮动按钮里，
      // 新架构里**每个屏就是一条导航项**（壳不知道屏内还有什么），所以显式列出来。
      { id: 'inspection-create', label: '新建巡检', primaryMethod: 'inspection.taskCreate' },
      { id: 'inspection-result', label: '录入结果', primaryMethod: 'inspection.resultCreate' },
      { id: 'inspection-manual', label: '手动补录', primaryMethod: 'inspection.manualRecord' },
      { id: 'devices', label: '设备管理', primaryMethod: 'device.list' },
    ],
  },
  {
    id: 'me',
    label: '我的',
    short: '我的',
    children: [
      { id: 'messages', label: '消息', primaryMethod: 'message.list' },
      { id: 'users', label: '用户管理', primaryMethod: 'user.list' },
      { id: 'profile', label: '个人设置', primaryMethod: 'profile.get' },
    ],
  },
];

export function domainById(id: DomainId): NavDomain {
  const found = DOMAINS.find((d) => d.id === id);
  if (!found) {
    throw new Error(`未知的一级域：${id}`);
  }
  return found;
}

/** 登录不在一级域内（system 域），单独给一个初始目的地。 */
export const LOGIN_ROUTE = { id: 'login', label: '登录', primaryMethod: 'auth.login' } as const;

/**
 * **扫码的落点**：扫到一个标签编码之后要跳到哪一屏。
 *
 * 单独写成常量而不是散在壳里写死字符串：这是"扫码到底去哪"这个产品决策的
 * 唯一出处，改落点只改这里一处（两个壳都引用它）。
 */
export const SCAN_TARGET_METHOD = 'tag.detail';

/** 按桥方法 id 找导航项（找不到返回 undefined，调用方自己决定兜底）。 */
export function findLeafByMethod(method: string): { domain: DomainId; leaf: NavLeaf } | undefined {
  for (const d of DOMAINS) {
    const leaf = d.children.find((c) => c.primaryMethod === method);
    if (leaf) {
      return { domain: d.id, leaf };
    }
  }
  return undefined;
}

/**
 * **可被"推进去"的屏**：详情类目的地。
 *
 * 它们**不进导航栏**，只能从别的屏跳过来（列表点一行、扫到一个码）。
 *
 * 为什么要把这件事显式列出来：在这之前，一个屏想可达就只能占一条导航叶子 ——
 * 于是"标签详情""单据详情"这类屏都被塞进侧栏/底栏，库存域因此长出 8 个导航项，
 * 手机上要横向滚动才看得全。详情屏在信息架构里本来就该在**下一层**，
 * 而不是和它的列表页平级。
 *
 * `label` 是推入后的页头标题（推入的屏由壳来显示返回，标题也就由壳来给）。
 */
export interface Destination {
  readonly method: string;
  readonly label: string;
}

export const DESTINATIONS: readonly Destination[] = [
  { method: 'tag.detail', label: '标签详情' },
  { method: 'tag.byCode', label: '标签详情' },
  { method: 'stockOrder.detail', label: '单据详情' },
  { method: 'device.detail', label: '设备详情' },
  { method: 'inspection.taskDetail', label: '巡检任务详情' },
  { method: 'alert.detail', label: '告警详情' },
  { method: 'inventory.detail', label: '库存详情' },
  { method: 'message.detail', label: '消息详情' },
  { method: 'user.detail', label: '用户详情' },
];

export function destinationOf(method: string): Destination | undefined {
  return DESTINATIONS.find((d) => d.method === method);
}

/** 一个目的地是否可达：要么是导航叶子，要么在 `DESTINATIONS` 里。 */
export function canReach(method: string): boolean {
  return findLeafByMethod(method) !== undefined || destinationOf(method) !== undefined;
}

/**
 * 屏的**挂载键**：目的地 + 它的**全部**参数。
 *
 * 为什么要它：同一屏组件被复用时 React 会保留上一份 state（查询结果、已选行），
 * 现场表现为"推了新的目标却还是旧内容"。
 *
 * 踩过的坑：第一版只把 `code`/`orderId` 拼进 key（当时只有这两种参数），
 * 后来加了 `tagId`/`deviceId`/`taskId`/`resultId` —— 这些变化**不会**触发重挂载。
 * 所以现在把参数整个序列化进 key，加新参数不必再记得改这里。
 */
export function screenKey(id: string, params: ScreenParams | undefined): string {
  const entries = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? id : `${id}#${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

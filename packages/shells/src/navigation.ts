import type { BridgeDomain } from '@wise/contract';

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
      { id: 'stock-orders', label: '出入库单', primaryMethod: 'stockOrder.list' },
      { id: 'warehouses', label: '仓库管理', primaryMethod: 'warehouse.list' },
    ],
  },
  {
    id: 'field',
    label: '现场',
    short: '现场',
    children: [
      { id: 'inspections', label: '巡检任务', primaryMethod: 'inspection.taskPage' },
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

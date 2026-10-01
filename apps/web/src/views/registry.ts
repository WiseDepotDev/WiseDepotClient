import type { Component } from 'vue';

/**
 * 屏注册表：**桥方法 id → 屏组件**。
 *
 * 逐域迁移：每屏只加一行，不需要动壳、也不需要动路由表 ——
 * 这是"壳不该知道业务屏有哪些"这条约束的落点。
 *
 * 同一个屏可以被多个方法 id 复用（`tag.detail` 与 `tag.byCode` 就是同一屏的两种入口）。
 *
 * 已迁入：
 *  · 概览域：看板 / 告警中心 / 告警详情
 *  · 库存域：库存查询 / 库存详情 / 商品 / 仓库 / 标签 / 标签详情 / 单据列表 / 新建单据 / 单据详情
 *  · 现场域：设备列表 / 设备详情 / 巡检任务列表 / 巡检任务详情 / 新建巡检 / 巡检结果列表 / 录入结果 / 手动补录
 *  · 我的域：消息中心 / 消息详情 / 用户管理 / 用户详情 / 个人设置
 */
export const SCREEN_REGISTRY: Readonly<Record<string, () => Promise<unknown>>> = {
  // ---- overview ----
  'dashboard.summary': () => import('./overview/DashboardView.vue'),
  'alert.list': () => import('./overview/AlertListView.vue'),
  'alert.detail': () => import('./overview/AlertDetailView.vue'),

  // ---- inventory ----
  'inventory.list': () => import('./inventory/InventoryListView.vue'),
  'inventory.detail': () => import('./inventory/InventoryDetailView.vue'),
  'product.list': () => import('./inventory/ProductListView.vue'),
  'warehouse.list': () => import('./inventory/WarehouseListView.vue'),
  'tag.list': () => import('./inventory/TagListView.vue'),
  // 扫码落点与列表点进来的详情是**同一屏**：只是取数方式不同（byCode / detail）
  'tag.detail': () => import('./inventory/TagDetailView.vue'),
  'tag.byCode': () => import('./inventory/TagDetailView.vue'),
  'stockOrder.list': () => import('./inventory/StockOrderListView.vue'),
  'stockOrder.create': () => import('./inventory/StockOrderCreateView.vue'),
  'stockOrder.detail': () => import('./inventory/StockOrderDetailView.vue'),

  // ---- field ----
  'device.list': () => import('./field/DeviceListView.vue'),
  'device.detail': () => import('./field/DeviceDetailView.vue'),
  'device.byCode': () => import('./field/DeviceDetailView.vue'),
  // 巡检：计划 / 列表 / 详情 / 新建 / 结果列表 / 录入结果 / 手动补录
  'inspection.planList': () => import('./field/InspectionPlanListView.vue'),
  'inspection.taskPage': () => import('./field/InspectionTaskListView.vue'),
  'inspection.taskDetail': () => import('./field/InspectionTaskDetailView.vue'),
  'inspection.taskCreate': () => import('./field/InspectionTaskCreateView.vue'),
  'inspection.resultList': () => import('./field/InspectionResultListView.vue'),
  // 结果详情与结果列表是**同一屏**（React 版 `registry.tsx:126` 也是这么映射的）：
  // 差异明细是列表屏里的一个面板，`?resultId` / `:resultId` 只是"进来就选中哪一条"。
  'inspection.resultDetail': () => import('./field/InspectionResultListView.vue'),
  'inspection.resultCreate': () => import('./field/InspectionResultCreateView.vue'),
  'inspection.manualRecord': () => import('./field/InspectionManualRecordView.vue'),

  // ---- me ----
  'message.list': () => import('./me/MessageListView.vue'),
  'message.detail': () => import('./me/MessageDetailView.vue'),
  'user.list': () => import('./me/UserListView.vue'),
  // 用户详情与用户列表是**同一屏**（React `registry.tsx:139` 也是这么映射的）：明细是列表屏里的一个面板
  'user.detail': () => import('./me/UserListView.vue'),
  'profile.get': () => import('./me/ProfileView.vue'),
} as Readonly<Record<string, () => Promise<unknown>>>;

export function screenFor(method: string): (() => Promise<unknown>) | undefined {
  return SCREEN_REGISTRY[method];
}

/** 已迁入的桥方法 id（供门禁与对照清单使用）。 */
export const MIGRATED_METHODS: readonly string[] = Object.keys(SCREEN_REGISTRY);

/** 类型占位：让 `Component` 的 import 不被摇掉（路由表用函数式组件，不需要它）。 */
export type ScreenComponent = Component;

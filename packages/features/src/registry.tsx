import type { Bridge } from '@wise/bridge-client';
import { Card, Mono, Section, Stack } from '@wise/patterns';
import { DashboardScreen } from './overview/DashboardScreen.js';
import { AlertListScreen } from './overview/AlertListScreen.js';
import { InventoryListScreen } from './inventory/InventoryListScreen.js';
import { ProductListScreen } from './inventory/ProductListScreen.js';
import { WarehouseListScreen } from './inventory/WarehouseListScreen.js';
import { StockOrderListScreen } from './inventory/StockOrderListScreen.js';
import { TagListScreen } from './inventory/TagListScreen.js';
import { TagDetailScreen } from './inventory/TagDetailScreen.js';
import { DeviceListScreen } from './field/DeviceListScreen.js';
import { DeviceDetailScreen } from './field/DeviceDetailScreen.js';
import { InspectionTaskListScreen } from './field/InspectionTaskListScreen.js';
import { InspectionTaskDetailScreen } from './field/InspectionTaskDetailScreen.js';
import { InspectionResultListScreen } from './field/InspectionResultListScreen.js';
import { InspectionTaskCreateScreen } from './field/InspectionTaskCreateScreen.js';
import { InspectionResultCreateScreen } from './field/InspectionResultCreateScreen.js';
import { InspectionManualRecordScreen } from './field/InspectionManualRecordScreen.js';
import { MessageListScreen } from './me/MessageListScreen.js';
import { MessageDetailScreen } from './me/MessageDetailScreen.js';
import { UserListScreen } from './me/UserListScreen.js';
import { ProfileScreen } from './me/ProfileScreen.js';

/**
 * 屏参数：壳 → 屏的**只读字符串袋**。
 *
 * 为什么需要它：屏原先只接收 `bridge`，于是"带着一个具体对象进屏"这件事做不到 ——
 * 扫码枪扫到一个标签编码，却没有任何办法把它交给标签详情屏，
 * 用户只能看着一个空白的详情屏再手输一遍。
 *
 * 刻意做成"扁平的字符串袋"而不是强类型路由：本仓还没有路由层，
 * 引入它要连带解决深链、返回栈、参数序列化，那是另一件事。
 * 一个只有字符串的袋子够用，而且**加了新参数不需要动任何已有屏**
 * （屏签名里的 `screenParams` 是可选的，老屏照旧只声明 `bridge`）。
 */
export interface ScreenParams {
  readonly [key: string]: string | undefined;
}

/**
 * 屏注册表：**桥方法 id → 屏组件**。
 *
 * 为什么用注册表而不是在壳里写 `if/switch`：
 *  · 壳（布局）不该知道业务屏有哪些 —— 那是 features 的知识；
 *  · W5–W7 逐域迁移时，**每一屏就是加一行**，不需要动壳；
 *  · 没登记的方法自动落到"待迁入"占位，`docs/feature-parity.md` 的清单与它一一对应，
 *    漏迁会以"占位屏"的形式显式存在，而不是悄悄消失。
 */
export type ScreenComponent = (props: {
  bridge: Bridge;
  screenParams?: ScreenParams | undefined;
}) => React.ReactElement;

const REGISTRY: Readonly<Record<string, ScreenComponent>> = {
  'dashboard.summary': DashboardScreen,
  'alert.list': AlertListScreen,
  // W5 库存域：列表屏先迁 —— 它是操作员每天打开最多的那一屏
  'inventory.list': InventoryListScreen,
  // 搜索是同一个屏的另一种取数方式（服务端筛选），先复用列表屏
  'inventory.search': InventoryListScreen,
  // 商品主数据（标准 CRUD 屏的样板）
  'product.list': ProductListScreen,
  // 仓库（第二个 CRUD 屏，结构同上；第三个出现时再抽通用组件）
  'warehouse.list': WarehouseListScreen,
  // 出入库单：建单入口走 BottomActionBar（表单屏不允许"滚到底找按钮"）
  'stockOrder.list': StockOrderListScreen,
  // 标签：本域唯一带批量操作与验证码的屏
  'tag.list': TagListScreen,
  // 标签详情：**扫码枪的落点**（扫到的编码经 screenParams.code 送进来）。
  // 两种查询入口在同一屏上，所以两条都指向它。
  'tag.detail': TagDetailScreen,
  'tag.byCode': TagDetailScreen,

  // ---- W6 field 域：设备与巡检 ----
  // 设备列表是现场作业的入口；详情复用同一屏的取数（点行内联展开），故两条都指向它
  'device.list': DeviceListScreen,
  'device.detail': DeviceDetailScreen,
  // 巡检任务：列表 + 分页取数是同屏两种取数方式（与 inventory.search 同理）
  'inspection.taskList': InspectionTaskListScreen,
  'inspection.taskPage': InspectionTaskListScreen,
  // 详情屏承载状态流转（taskStatus/taskProgress/taskDiff），三条入口都落到它
  'inspection.taskDetail': InspectionTaskDetailScreen,
  'inspection.taskStatus': InspectionTaskDetailScreen,
  'inspection.taskDiff': InspectionTaskDetailScreen,
  // 巡检结果：列表 + 确认（确认走 ConfirmDialog）
  'inspection.resultList': InspectionResultListScreen,
  'inspection.resultDetail': InspectionResultListScreen,
  'inspection.resultConfirm': InspectionResultListScreen,
  // ---- 现场域的"写"入口（此前只有看没有录）----
  'inspection.taskCreate': InspectionTaskCreateScreen,
  'inspection.resultCreate': InspectionResultCreateScreen,
  'inspection.manualRecord': InspectionManualRecordScreen,

  // ---- W7 me 域：消息 / 用户 / 个人资料 ----
  // 未读数不是独立目的地，它就是列表页的角标数据源 —— 指向同一屏
  'message.list': MessageListScreen,
  'message.unreadCount': MessageListScreen,
  'message.detail': MessageDetailScreen,
  'user.list': UserListScreen,
  'user.detail': UserListScreen,
  'profile.get': ProfileScreen,
  'profile.settings': ProfileScreen,
};

export function screenFor(primaryMethod: string): ScreenComponent | undefined {
  return REGISTRY[primaryMethod];
}

/** 已迁入的桥方法 id 列表（供对照清单与测试使用）。 */
export const MIGRATED_METHODS: readonly string[] = Object.keys(REGISTRY);

/**
 * 未迁入时的占位。
 *
 * **业务用户永远不该看到技术术语**（用户实测反馈：页面直接显示
 * `inventory.list` 与"W5–W7 逐域迁入""令牌"这类开发内部文案，
 * 给人的感知是"功能未完成/系统异常"）。
 *
 * 因此这里给的是业务语言；方法 id 只在**开发态**追加一行，
 * 方便对照迁移清单 —— 生产构建里那段不会存在（`import.meta.env.DEV` 被静态替换掉）。
 */
export function NotMigratedScreen({ method }: { method: string }): React.ReactElement {
  const dev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  return (
    <Section title="功能上线中">
      <Card>
        <Stack tight>
          <span>该功能正在上线中，暂时无法使用。</span>
          <span className="w-muted">如需使用，请联系管理员了解上线时间。</span>
          {dev ? <Mono>{`dev-only: ${method}`}</Mono> : null}
        </Stack>
      </Card>
    </Section>
  );
}

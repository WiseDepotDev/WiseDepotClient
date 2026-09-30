import type { Bridge } from '@wise/bridge-client';
import { Card, Mono, Section, Stack } from '@wise/patterns';
import { DashboardScreen } from './overview/DashboardScreen.js';
import { AlertListScreen } from './overview/AlertListScreen.js';
import { InventoryListScreen } from './inventory/InventoryListScreen.js';
import { ProductListScreen } from './inventory/ProductListScreen.js';
import { WarehouseListScreen } from './inventory/WarehouseListScreen.js';
import { StockOrderListScreen } from './inventory/StockOrderListScreen.js';

/**
 * 屏注册表：**桥方法 id → 屏组件**。
 *
 * 为什么用注册表而不是在壳里写 `if/switch`：
 *  · 壳（布局）不该知道业务屏有哪些 —— 那是 features 的知识；
 *  · W5–W7 逐域迁移时，**每一屏就是加一行**，不需要动壳；
 *  · 没登记的方法自动落到"待迁入"占位，`docs/feature-parity.md` 的清单与它一一对应，
 *    漏迁会以"占位屏"的形式显式存在，而不是悄悄消失。
 */
export type ScreenComponent = (props: { bridge: Bridge }) => React.ReactElement;

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

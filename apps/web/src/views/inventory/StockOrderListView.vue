<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useNavStore, useResource } from '@wise/stores';
import {
  ActionDock,
  FilterBar,
  MasterDetail,
  PageHeader,
  PaginationBar,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  useViewport,
  type ColumnDef,
} from '@wise/ui';
import { orderStatusOf, orderStatusText, orderTypeOf, orderTypeText } from './stockOrderState.js';

import StockOrderDetailPanel from './StockOrderDetailPanel.vue';

/**
 * 出入库单列表（`stockOrder.list`）。
 *
 * ## 两点必须记住的事
 *
 * 1. **字段名是 `orderStatus` / `orderType`（外加 `orderStatusStr` / `orderTypeStr`）**，
 *    不是 `status` / `type` —— DTO 里确实有 `status`/`type` 两个键，但**从来没被填过**。
 *    取错只会拿到 undefined，然后每一行都走兜底分支（旧版真发生这件事，见 stockOrderState.ts 的注释）。
 * 2. **状态筛选是客户端的**（服务端该方法只吃 page/size），所以标注必须写"筛选本页"。
 *
 * 建单入口在这里，但**建单表单不在这里**：服务端要求 `orderNo`（不生成）与 `createBy`，
 * 内联一个只有 `{warehouseId, remark}` 的表单永远是失败的（真实错误 `VAL-0001 单据编号不能为空`）。
 * 建单只有一个属主 —— 专门的建单屏。
 *
 * ## 主从视图（桌面宽档）
 *
 * 宽档时左列表右详情并排；窄屏与手机维持"点行进详情路由"。详情内容本身在
 * `StockOrderDetailPanel` 里，本屏只负责"选了哪一张"。
 */
interface StockOrderRow {
  readonly orderId?: number;
  readonly orderNo?: string;
  readonly orderType?: number | string;
  readonly orderTypeStr?: string;
  readonly orderStatus?: number | string;
  readonly orderStatusStr?: string;
  readonly warehouseName?: string;
  readonly createTime?: string;
  readonly createdByName?: string;
  readonly createByName?: string;
  readonly totalItems?: number;
}

const PAGE_SIZE = 20;
type StatusFilter = 'all' | 'pending' | 'submitted' | 'approved' | 'completed';

const router = useRouter();
const nav = useNavStore();
const view = nav.viewStateOf('stockOrder.list');
const statusFilter = ref<StatusFilter>('all');

const filters = [
  {
    key: 'status',
    label: '单据状态',
    options: [
      { value: 'pending', label: '待审批' },
      { value: 'submitted', label: '待审核' },
      { value: 'approved', label: '已审批' },
      { value: 'completed', label: '已完成' },
    ],
  },
];
const filterValues = computed(() => ({ status: statusFilter.value === 'all' ? '' : statusFilter.value }));

const params = computed(() => ({ page: view.page, size: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('stockOrder.list', params);
const rows = computed(() => asList<StockOrderRow>(data.value));
const total = computed(() => asTotal(data.value));

const visibleRows = computed(() =>
  statusFilter.value === 'all' ? rows.value : rows.value.filter((r) => orderStatusOf(r) === statusFilter.value),
);

/**
 * 状态色调：完整列定义与主从精简列定义共用一份，避免两边漂移成"同一个状态两种颜色"。
 *
 * 色调按服务端归一化后的状态给（`orderStatusOf`），不按原始数字码 —— 码表含义会变，
 * 而归一化后的状态是状态机判据用的那一份。
 */
function statusToneOf(row: StockOrderRow): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  switch (orderStatusOf(row)) {
    case 'completed':
      return 'success';
    case 'approved':
      return 'info';
    case 'submitted':
      return 'warning';
    case 'rejected':
      return 'danger';
    default:
      return 'neutral';
  }
}

const columns: readonly ColumnDef<StockOrderRow>[] = [
  { key: 'orderNo', title: '单号', type: 'mono', width: 190, compact: 'primary', value: (r) => r.orderNo ?? '' },
  {
    key: 'orderType',
    title: '类型',
    width: 90,
    compact: 'secondary',
    value: (r) => orderTypeText(r),
  },
  { key: 'warehouseName', title: '仓库', width: 150 },
  {
    key: 'orderStatus',
    title: '状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => orderStatusText(r),
    tone: (r) => statusToneOf(r),
  },
  {
    key: 'createdByName',
    title: '建单人',
    width: 120,
    value: (r) => r.createdByName ?? r.createByName ?? '未登记',
  },
  {
    key: 'totalItems',
    title: '明细',
    type: 'mono',
    width: 90,
    align: 'right',
    value: (r) => String(r.totalItems ?? 0),
  },
  { key: 'createTime', title: '创建时间', type: 'mono', width: 140, value: (r) => shortTime(r.createTime) },
];

/*
 * ---------------------------------------------------------------- 主从视图
 *
 * 为什么宽档点行只改组件状态、不 push 详情路由：本仓 `<RouterView :key="route.fullPath">`
 * 会强制整树重挂 —— 走了详情路由，左栏会被销毁重建（状态筛选档、页码、滚动位置全丢），
 * 表现是"点一行整屏闪一下"。所以宽档点行只设 `selectedId`。
 *
 * 为什么窄档那条老路必须原样留着：手机上并排两个栏目谁都看不清，
 * 而且按 hash 导航是深链 / 扫码 / 返回键的基础。
 *
 * 为什么主从要另备一套列定义：主从左栏只有约 700px，而完整列定义的固定宽
 * （190+90+150+110+120+90+140）已经接近 900px —— 硬塞虽然会被左栏自己的横向滚动接住，
 * 但每行都得左右拖才看得全，"选一张单"这件事反而更慢。所以主从只留最要紧的四列：
 * 单号 / 类型 / 状态 / 创建时间。
 */
const { isWide } = useViewport();
const selectedId = ref<number | undefined>(undefined);

/** 主从版列定义：单号 / 类型 / 状态 / 时间。仓库、建单人、明细数留给完整视图。 */
const masterColumns: readonly ColumnDef<StockOrderRow>[] = [
  { key: 'orderNo', title: '单号', type: 'mono', width: 180, compact: 'primary', value: (r) => r.orderNo ?? '' },
  {
    key: 'orderType',
    title: '类型',
    width: 80,
    compact: 'secondary',
    value: (r) => orderTypeText(r),
  },
  {
    key: 'orderStatus',
    title: '状态',
    type: 'status',
    width: 100,
    compact: 'chip',
    value: (r) => orderStatusText(r),
    tone: (r) => statusToneOf(r),
  },
  { key: 'createTime', title: '创建时间', type: 'mono', width: 140, value: (r) => shortTime(r.createTime) },
];

const activeColumns = computed(() => (isWide.value ? masterColumns : columns));

function onFilter(next: Record<string, string>): void {
  const value = next.status ?? '';
  statusFilter.value = (['pending', 'submitted', 'approved', 'completed'].includes(value) ? value : 'all') as StatusFilter;
  view.page = 1;
}

function openDetail(row: StockOrderRow): void {
  if (row.orderId === undefined) {
    return;
  }
  if (isWide.value) {
    selectedId.value = row.orderId;
    return;
  }
  void router.push({ name: 'stockOrder.detail', params: { orderId: String(row.orderId) } });
}

function goCreate(): void {
  void router.push({ name: 'stockOrder.create' });
}

/** 只看得出类型的行也用得上：类型信息在列表里是操作性信息（入还是出）。 */
const typeHint = computed(() => rows.value.filter((r) => orderTypeOf(r) === 'unknown').length);
</script>

<template>
  <div class="w-page">
    <PageHeader title="出入库单" :note="total !== undefined ? `共 ${total} 张单据` : '按状态筛选与查看明细'">
      <template #actions>
        <!-- 桌面档留在页头；手机档移到底部动作条 -->
        <ElButton class="w-hide-compact" size="large" type="primary" @click="goCreate">新建出入库单</ElButton>
      </template>
    </PageHeader>

    <FilterBar :model-value="filterValues" :filters="filters" @update:model-value="onFilter" @reset="() => (statusFilter = 'all')" />

    <MasterDetail>
      <template #list>
        <SectionBlock title="单据列表">
          <StateHost
            :loading="loading"
            :error="error"
            :error-text="error ? humanize(error) : undefined"
            :empty="visibleRows.length === 0"
            empty-text="没有符合条件的单据。可以点右上角新建一张出入库单。"
            skeleton="list"
            @retry="reload"
          >
            <p v-if="typeHint > 0" class="w-order-warn" role="status">
              有 {{ typeHint }} 张单据的类型没上报，列表里显示为「类型未登记」。这不影响点进去看明细。
            </p>
            <ResponsiveDataView
              :columns="activeColumns"
              :rows="visibleRows"
              :row-key="(r: StockOrderRow) => String(r.orderId ?? r.orderNo ?? '')"
              clickable
              @row-click="openDetail"
            />
            <PaginationBar
              :page="view.page"
              :page-size="PAGE_SIZE"
              :total="total ?? rows.length"
              :loading="loading"
              @update:page="(p: number) => (view.page = p)"
            />
          </StateHost>
        </SectionBlock>
      </template>
      <template #detail>
        <!--
          右栏：选中了才渲染面板（没选中时不发一个必然是空的请求），
          并用 `:key` 强制换项时重挂 —— 面板内部按单号取了数据，
          不重挂会带着上一张单的内容继续画。未选中时给一句话说明怎么用，
          而不是留一片空白 —— 空白会让人以为"右栏坏了"，而它其实只是在等一次点击。
        -->
        <StockOrderDetailPanel v-if="selectedId !== undefined" :key="selectedId" inline :order-id="selectedId" />
        <div v-else class="w-order__pick">从左边点一张单据，这里显示它的明细与可做的操作。</div>
      </template>
    </MasterDetail>

    <ActionDock>
      <ElButton class="w-show-compact-only w-actiondock__block" size="large" type="primary" @click="goCreate">
        新建出入库单
      </ElButton>
    </ActionDock>
  </div>
</template>

<style scoped>
/* 主从右栏"还没选"时的提示：muted 小字 + 虚线框，明说它在等一次点击。 */
.w-order__pick {
  padding: var(--w-space-card-padding);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
  background: var(--w-color-surface-alt);
  border: 1px dashed var(--w-color-outline);
  border-radius: var(--w-radius-card);
}

.w-order-warn {
  margin: 0 0 var(--w-space-inline-gap);
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-warning-text);
  background: var(--w-state-warning-fill);
  color: var(--w-state-warning-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>

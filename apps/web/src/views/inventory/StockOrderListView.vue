<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useNavStore, useResource } from '@wise/stores';
import { FilterBar, PageHeader, PaginationBar, ResponsiveDataView, SectionBlock, StateHost, type ColumnDef } from '@wise/ui';
import { orderStatusOf, orderStatusText, orderTypeOf, orderTypeText } from './stockOrderState.js';

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
    tone: (r) => {
      switch (orderStatusOf(r)) {
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
    },
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

function onFilter(next: Record<string, string>): void {
  const value = next.status ?? '';
  statusFilter.value = (['pending', 'submitted', 'approved', 'completed'].includes(value) ? value : 'all') as StatusFilter;
  view.page = 1;
}

function openDetail(row: StockOrderRow): void {
  if (row.orderId !== undefined) {
    void router.push({ name: 'stockOrder.detail', params: { orderId: String(row.orderId) } });
  }
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
        <ElButton class="w-hide-compact" size="large" :loading="loading" @click="reload">刷新</ElButton>
        <ElButton size="large" type="primary" @click="goCreate">新建出入库单</ElButton>
      </template>
    </PageHeader>

    <FilterBar :model-value="filterValues" :filters="filters" @update:model-value="onFilter" @reset="() => (statusFilter = 'all')" />

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
          :columns="columns"
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
  </div>
</template>

<style scoped>
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

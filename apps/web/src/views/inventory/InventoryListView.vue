<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useNavStore, useResource } from '@wise/stores';
import {
  FilterBar,
  PageHeader,
  PaginationBar,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  StatusChip,
  type ColumnDef,
} from '@wise/ui';

/**
 * 库存查询（`inventory.list`）。
 *
 * ## 三条从 React 版继承的约束
 *
 * 1. **关键词是客户端筛选，不是服务端搜索** —— 所以筛选条上必须写清"筛选本页"，
 *    否则用户会以为"搜不到 = 没有这条库存"。（服务端搜索走 `inventory.search`，
 *    目前没有屏接它，属于二期候选。）
 * 2. **列表行首列是商品编码（等宽）**：操作员靠它对单，不能被截断。
 * 3. **四态由 StateHost 保证**，空态的文案要分两种：有筛选条件 vs 真的没数据
 *    （"没有符合条件"和"暂无库存，去商品管理新增"指向完全不同的下一步）。
 */
interface InventoryRow {
  readonly inventoryId?: number;
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly quantity?: number;
  readonly warehouseName?: string;
  readonly location?: string;
  readonly status?: number;
  readonly updateTime?: string;
}

const PAGE_SIZE = 20;
type StockFilter = 'all' | 'low' | 'locked';

const router = useRouter();
const nav = useNavStore();
const view = nav.viewStateOf('inventory.list');

const keyword = ref('');
const applied = ref('');
const filter = ref<StockFilter>('all');

const filterValues = computed(() => ({ stock: filter.value === 'all' ? '' : filter.value }));
const filters = [
  { key: 'stock', label: '库存状态', options: [{ value: 'low', label: '库存偏低' }, { value: 'locked', label: '已锁定' }] },
];

const params = computed(() => ({ page: view.page, size: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('inventory.list', params);

const all = computed(() => asList<InventoryRow>(data.value));
const total = computed(() => asTotal(data.value));

/** 客户端筛选：关键词命中商品名/编码/货位；库存量按档过滤。 */
const rows = computed(() =>
  all.value.filter((r) => {
    if (applied.value !== '') {
      const hay = `${r.productName ?? ''}${r.productCode ?? ''}${r.location ?? ''}`.toLowerCase();
      if (!hay.includes(applied.value.toLowerCase())) {
        return false;
      }
    }
    const q = r.quantity ?? 0;
    if (filter.value === 'low') {
      return q > 0 && q <= 10;
    }
    if (filter.value === 'locked') {
      return r.status === 1;
    }
    return true;
  }),
);

const emptyText = computed(() =>
  applied.value !== '' || filter.value !== 'all'
    ? '没有符合条件的库存记录，试试换个关键词或切回「全部」。'
    : '暂无库存数据。请点击右上角刷新，或前往「商品管理」新增商品后再入库。',
);

function onFilter(next: Record<string, string>): void {
  filter.value = (next.stock === 'low' || next.stock === 'locked' ? next.stock : 'all') as StockFilter;
  view.page = 1;
}

function onSearch(): void {
  applied.value = keyword.value.trim();
  view.page = 1;
}

function resetFilters(): void {
  keyword.value = '';
  applied.value = '';
  filter.value = 'all';
  view.page = 1;
}

const columns: readonly ColumnDef<InventoryRow>[] = [
  { key: 'productName', title: '商品', compact: 'primary' },
  { key: 'productCode', title: '商品编码', type: 'mono', width: 150, value: (r) => r.productCode ?? '' },
  { key: 'location', title: '货位', type: 'mono', width: 110, compact: 'secondary' },
  { key: 'warehouseName', title: '仓库', width: 140 },
  { key: 'quantity', title: '数量', type: 'mono', width: 100, align: 'right', value: (r) => String(r.quantity ?? 0) },
  {
    key: 'status',
    title: '状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => (r.status === 1 ? '已锁定' : '正常'),
    tone: (r) => (r.status === 1 ? 'warning' : 'success'),
  },
  { key: 'updateTime', title: '更新时间', type: 'mono', width: 140, value: (r) => shortTime(r.updateTime) },
];

function openDetail(row: InventoryRow): void {
  if (row.inventoryId !== undefined) {
    void router.push({ name: 'inventory.detail', params: { inventoryId: String(row.inventoryId) } });
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="库存查询" :note="total !== undefined ? `共 ${total} 条库存记录` : '按商品、编码或货位查找'">
      <template #actions>
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
      </template>
    </PageHeader>

    <div class="w-toolbar">
      <ElInput
        v-model="keyword"
        size="large"
        clearable
        class="w-inventory__search"
        placeholder="商品名 / 编码 / 货位"
        @keydown.enter="onSearch"
      />
      <ElButton size="large" type="primary" @click="onSearch">查找</ElButton>
      <span class="w-inventory__scope">筛选本页</span>
    </div>

    <FilterBar :model-value="filterValues" :filters="filters" @update:model-value="onFilter" @reset="resetFilters" />

    <SectionBlock :title="`库存列表${applied ? `（含「${applied}」）` : ''}`">
      <StateHost
        :loading="loading"
        :error="error"
        :error-text="error ? humanize(error) : undefined"
        :empty="rows.length === 0"
        :empty-text="emptyText"
        skeleton="list"
        @retry="reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: InventoryRow) => String(r.inventoryId ?? `${r.productCode}-${r.location}`)"
          clickable
          @row-click="openDetail"
        />
        <PaginationBar
          :page="view.page"
          :page-size="PAGE_SIZE"
          :total="total ?? all.length"
          :loading="loading"
          @update:page="(p: number) => (view.page = p)"
        />
      </StateHost>
    </SectionBlock>
  </div>
</template>

<style scoped>
.w-inventory__search {
  max-width: var(--w-space-detail-column-width);
}

/* 作用域标注常驻可见：它决定用户对"搜不到"的理解 */
.w-inventory__scope {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
}
</style>

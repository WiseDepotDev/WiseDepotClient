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

// **`pageSize`，不是 `size`**：`InventoryController:149` 只认 `pageSize`（发 `size` 被静默忽略 →
// 永远 10 条/页）。同一批的 `alert.list` / `stockOrder.list` / `user.list` 反而是 `size` ——
// 真后端不是一个口径，逐个按接口核过，证据见 `tools/bench/inventory-tag-probe.mjs`。
const params = computed(() => ({ page: view.page, pageSize: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('inventory.list', params);

const all = computed(() => asList<InventoryRow>(data.value));
const total = computed(() => asTotal(data.value));

/*
 * ---------------------------------------------------------------- 服务端搜索
 *
 * 只在**有关键词时**发（`enabled` 门控），发的是 `inventory.search`。
 *
 * 为什么必须知道这个接口的真实语义（读服务端源码得到的，不是猜的）：
 *   · 它要求 `keyword` + `type`（`PRODUCT` / `LOCATION`），**其它 type 一律回空数组**；
 *   · `type=LOCATION` 走的是 `searchInventoryByLocation` —— 名字像"按货位搜"，
 *     实际代码是 `productRepository.findByNameContaining(keyword)` 再取这些商品的库存行，
 *     也就是**按商品名匹配、返回全量、不分区**；
 *   · `type=PRODUCT` 是按商品名查商品，且**硬截断前 100 条**。
 *
 * 所以这里只把它用在它真的能做的事上：**按商品名跨页搜库存**。
 * 关键词是编码/货位时服务端必然不命中，那种情况老实回退到"本页筛选"并把口径写在界面上 ——
 * 不假装"就是没有"，因为货位/编码确实可能就在别的页上。
 */
const searchParams = computed(() =>
  applied.value === '' ? {} : { keyword: applied.value, type: 'LOCATION' },
);
/**
 * `enabled` 必须是**响应式**的：写 `applied.value !== ''` 会当场求值成常量 `false`，
 * 之后永远不发请求（界面只显示空态、不报错也不转圈）—— 这条被 `check:enabled-option` 拦过一次。
 */
const hasKeyword = computed(() => applied.value !== '');
const search = useResource<unknown>('inventory.search', searchParams, { enabled: hasKeyword });
const searched = computed(() => asList<InventoryRow>(search.data.value));

/** 服务端这次到底命中了没有（决定用哪套口径、写哪句标签）。 */
const serverHit = computed(() => search.data.value !== undefined && searched.value.length > 0);

/** 关键词在**本页**的命中（服务端不命中时的回退口径）。 */
function keywordHits(row: InventoryRow): boolean {
  if (applied.value === '') {
    return true;
  }
  const hay = `${row.productName ?? ''}${row.productCode ?? ''}${row.location ?? ''}`.toLowerCase();
  return hay.includes(applied.value.toLowerCase());
}

/** 库存量档位过滤（与服务端搜索无关，两套口径都要过这一关）。 */
function stockHits(row: InventoryRow): boolean {
  const q = row.quantity ?? 0;
  if (filter.value === 'low') {
    return q > 0 && q <= 10;
  }
  if (filter.value === 'locked') {
    return row.status === 1;
  }
  return true;
}

/**
 * 三档口径，互斥且都能说出理由：
 *   1. 没有关键词 → 服务端分页列表 + 档位过滤（原行为）
 *   2. 有关键词且服务端命中 → 服务端返回的**跨页**结果 + 档位过滤
 *   3. 有关键词但服务端没命中 → 回退到本页筛选（界面会写明"服务端没有商品名匹配"）
 */
const rows = computed(() => {
  const source = applied.value === '' ? all.value : serverHit.value ? searched.value : all.value;
  return source.filter((r) => stockHits(r) && (serverHit.value ? true : keywordHits(r)));
});

/** 当前**生效的那一路**取数状态：三态必须跟着它走，否则会出现"错的是 A、画的是 B"。 */
const activeLoading = computed(() => (applied.value !== '' ? search.loading.value : loading.value));
const activeError = computed(() => (applied.value !== '' ? search.error.value : error.value));
function activeReload(): void {
  if (applied.value !== '') {
    search.reload();
    return;
  }
  reload();
}

/** 搜索口径必须写在界面上：只按商品名、且服务端没命中时会退到本页。 */
const scopeText = computed(() => {
  if (applied.value === '') {
    return '筛选本页';
  }
  if (search.loading.value) {
    return `正在按商品名搜索「${applied.value}」…`;
  }
  if (serverHit.value) {
    return `服务端按商品名搜索「${applied.value}」· 跨页 ${searched.value.length} 条`;
  }
  return `服务端没有商品名匹配；下面是本页含「${applied.value}」的记录`;
});

const emptyText = computed(() => {
  if (applied.value !== '') {
    return `全库与本页都没有商品名含「${applied.value}」的库存。服务端只按商品名搜索，试试换个商品名。`;
  }
  if (filter.value !== 'all') {
    return '没有符合条件的库存记录，试试切回「全部」。';
  }
  /*
   * 空库必须指对路。
   *
   * 原先写的是"前往「商品管理」新增商品后再入库"——**两个问题**：
   *   1. 商品管理里没有"入库"这个动作，用户去了会发现无路可走；
   *   2. 库存的真正来源是**出入库单流转**（`InOutApplicationService#processInventory`），
   *      而 `inventory.create` 在真后端上根本建不出来（2026-10-03 实测固定 400
   *      「仓库ID不能为空」：实体 `Inventory.java:20` 是 `@NotNull`，而服务层从不 `setWarehouseId`）。
   * 所以这里只能指向唯一走得通的那条路。
   */
  return '还没有库存记录。库存由出入库单执行后自动记账 —— 去「出入库单」新建一张单并提交审核，完成后这里会出现对应记录。';
});

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
        <!-- 刷新的是**当前生效的那一路**：有关键词时刷的是搜索结果，不是分页列表 -->
        <ElButton size="large" :loading="activeLoading" @click="activeReload">刷新</ElButton>
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
      <!-- 搜索口径写在界面上：服务端只按商品名搜，没命中时退到本页 -->
      <span class="w-inventory__scope">{{ scopeText }}</span>
    </div>

    <FilterBar :model-value="filterValues" :filters="filters" @update:model-value="onFilter" @reset="resetFilters" />

    <SectionBlock :title="`库存列表${applied ? `（含「${applied}」）` : ''}`">
      <StateHost
        :loading="activeLoading"
        :error="activeError"
        :error-text="activeError ? humanize(activeError) : undefined"
        :empty="rows.length === 0"
        :empty-text="emptyText"
        skeleton="list"
        @retry="activeReload"
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

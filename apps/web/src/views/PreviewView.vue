<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton } from 'element-plus';
import {
  ActionDock,
  ConfirmDialog,
  FilterBar,
  KeyValuePanel,
  MetricGrid,
  PageHeader,
  PaginationBar,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  StatusChip,
  type ColumnDef,
  type FilterValues,
  type MetricItem,
  type UiError,
} from '@wise/ui';

/**
 * 组件预览页（**仅开发态**）。
 *
 * 为什么值得单独一页：设计系统必须先于业务屏验收。25 个屏各写一套按钮/表格的结果
 * 是"每屏都差一点"，而差在哪一屏都看不出来。这里把每个组件 × 四态 × 两种布局
 * 摆在一起，改一处立刻能看到影响面。
 *
 * 这里的数据是**本页自用的假数据**，用于展示组件形态；它不属于任何业务屏，
 * 也不会被业务代码引用（业务屏一律从 store 取真实 DTO）。
 */

interface Row {
  readonly code: string;
  readonly name: string;
  readonly bin: string;
  readonly stock: string;
  readonly status: string;
  readonly statusTone: 'success' | 'warning' | 'danger';
  readonly updated: string;
}

const rows: readonly Row[] = [
  { code: 'RFID-UHF-01', name: '工业级 RFID 标签', bin: 'A-01-08', stock: '128 / 142', status: '低库存', statusTone: 'danger', updated: '10:16' },
  { code: 'FAST-M12-00', name: '高强度紧固件 M12', bin: 'A-03-12', stock: '860 / 860', status: '正常', statusTone: 'success', updated: '10:09' },
  { code: 'HYD-SEAL-22', name: '液压密封组件', bin: 'B-02-04', stock: '42 / 54', status: '待补货', statusTone: 'warning', updated: '09:42' },
  { code: 'LUBE-HT-05', name: '耐高温润滑脂', bin: 'C-01-03', stock: '216 / 216', status: '正常', statusTone: 'success', updated: '09:35' },
];

const columns: readonly ColumnDef<Row>[] = [
  { key: 'name', title: '物料', compact: 'primary' },
  { key: 'code', title: '物料编码', type: 'mono' },
  { key: 'bin', title: '库位', type: 'mono', compact: 'secondary', value: (r) => `${r.bin} · 可用 ${r.stock}` },
  { key: 'stock', title: '可用 / 在库', type: 'mono', align: 'right' },
  { key: 'status', title: '状态', type: 'status', width: 110, compact: 'chip', tone: (r) => r.statusTone },
  { key: 'updated', title: '更新时间', type: 'mono', width: 100 },
];

const metrics: readonly MetricItem[] = [
  { key: 'total', label: '库存品类', value: '1,284', tone: 'info' },
  { key: 'in', label: '今日入库', value: '326', tone: 'success' },
  { key: 'warn', label: '库存预警', value: '18', tone: 'warning' },
  { key: 'abnormal', label: '待处理异常', value: '6', tone: 'danger' },
];

const kvItems = [
  { key: 'code', label: '物料编码', value: 'RFID-UHF-01', mono: true },
  { key: 'stock', label: '当前库存', value: '142 件', mono: true },
  { key: 'available', label: '可用库存', value: '128 件', mono: true },
  { key: 'safety', label: '安全库存', value: null },
  { key: 'bin', label: '默认库位', value: 'A-01-08', mono: true },
];

const filters = [
  { key: 'category', label: '全部类目', options: [{ value: 'a', label: '紧固件' }, { value: 'b', label: '密封件' }] },
  { key: 'zone', label: '库区', options: [{ value: 'a', label: 'A 区' }, { value: 'b', label: 'B 区' }] },
];

const filterValues = ref<FilterValues>({ category: '', zone: '' });
const searchPage = ref('');
const searchServer = ref('');
const page = ref(1);
const mode = ref<'auto' | 'table' | 'cards'>('auto');
const confirmShow = ref(false);

const demoError: UiError = { code: 'BRIDGE_BACKEND_UNREACHABLE', messageKey: 'bridge.backendUnreachable' };

const allTones = computed(() => [
  { text: '正常', tone: 'success' as const },
  { text: '待补货', tone: 'warning' as const },
  { text: '低库存', tone: 'danger' as const },
  { text: '上线中', tone: 'info' as const },
  { text: '已归档', tone: 'neutral' as const },
]);
</script>

<template>
  <main class="w-page">
    <PageHeader title="组件预览" note="仅开发态可用 · 数据为本页自用示例，不代表任何业务字段">
      <template #actions>
        <StatusChip text="密度 · 标准" tone="info" />
      </template>
    </PageHeader>

    <SectionBlock title="指标（只渲染真实字段）">
      <MetricGrid :items="metrics" />
    </SectionBlock>

    <SectionBlock title="状态芯片（文字用 state-*-text，底色用 state-*-fill）">
      <div class="w-toolbar">
        <StatusChip v-for="t in allTones" :key="t.text" :text="t.text" :tone="t.tone" />
      </div>
    </SectionBlock>

    <SectionBlock title="响应式数据视图（同一份列定义：桌面表格 / 手机卡片）">
      <div class="w-toolbar">
        <ElButton :type="mode === 'auto' ? 'primary' : 'default'" size="large" @click="mode = 'auto'">自动</ElButton>
        <ElButton :type="mode === 'table' ? 'primary' : 'default'" size="large" @click="mode = 'table'">表格</ElButton>
        <ElButton :type="mode === 'cards' ? 'primary' : 'default'" size="large" @click="mode = 'cards'">卡片</ElButton>
      </div>
      <ResponsiveDataView
        :columns="columns"
        :rows="rows"
        :row-key="(r: Row) => r.code"
        :mode="mode"
        clickable
      />
      <PaginationBar v-model:page="page" :page-size="20" :total="1284" />
    </SectionBlock>

    <SectionBlock title="筛选条（搜索作用域必须标注）">
      <FilterBar
        v-model="filterValues"
        :filters="filters"
        :search="searchPage"
        search-placeholder="搜索物料、批次或库位"
        search-scope="page"
        @update:search="(v: string) => (searchPage = v)"
      />
      <FilterBar
        v-model="filterValues"
        :filters="filters"
        :search="searchServer"
        search-placeholder="搜索物料编码"
        search-scope="server"
        @update:search="(v: string) => (searchServer = v)"
      />
    </SectionBlock>

    <SectionBlock title="四态（互斥且穷尽）">
      <div class="w-preview-grid">
        <div>
          <p class="w-preview-caption">加载 · 列表</p>
          <StateHost loading skeleton="list" />
        </div>
        <div>
          <p class="w-preview-caption">加载 · 卡片</p>
          <StateHost loading skeleton="card" />
        </div>
        <div>
          <p class="w-preview-caption">空</p>
          <StateHost empty empty-text="这个仓库还没有入库记录" />
        </div>
        <div>
          <p class="w-preview-caption">错（等宽错误码 + 重试）</p>
          <StateHost :error="demoError" @retry="() => undefined" />
        </div>
        <div>
          <p class="w-preview-caption">内容</p>
          <StateHost>
            <KeyValuePanel :items="kvItems" />
          </StateHost>
        </div>
      </div>
    </SectionBlock>

    <SectionBlock title="危险操作确认（焦点圈闭 / Esc / 关闭后焦点归还）">
      <ElButton size="large" type="danger" @click="confirmShow = true">删除标签（演示）</ElButton>
      <ConfirmDialog
        :show="confirmShow"
        title="确认删除"
        text="删除后该标签需要重新绑定。此操作不可撤销。"
        confirm-text="删除"
        danger
        @confirm="confirmShow = false"
        @cancel="confirmShow = false"
      />
    </SectionBlock>

    <ActionDock>
      <ElButton size="large">次要动作</ElButton>
      <ElButton size="large" type="primary">主操作</ElButton>
    </ActionDock>
  </main>
</template>

<style scoped>
.w-preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--w-size-card-min-width), 1fr));
  gap: var(--w-space-group-gap);
}

.w-preview-caption {
  margin: 0 0 var(--w-space-inline-gap);
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
}
</style>

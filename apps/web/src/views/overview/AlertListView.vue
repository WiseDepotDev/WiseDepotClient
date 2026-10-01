<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useNavStore, useResource } from '@wise/stores';
import {
  FilterBar,
  PageHeader,
  PaginationBar,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  type ColumnDef,
  type FilterDef,
  type FilterValues,
} from '@wise/ui';
import { alertStateOf, alertStateText, alertStateTone, levelText, levelTone, type AlertItem } from './alertState.js';

/**
 * 告警中心（`alert.list`）。
 *
 * 分页参数沿用旧版（`page` 从 1 开始、`size`），**不改接口**。
 *
 * 页面状态（页码 + 筛选）放进 `useNavStore`：桌面 ↔ 手机切换时会换壳，
 * 如果这些状态留在组件里，现场就会出现"手机筛了未处理，插上显示器变成全部"。
 */
const PAGE_SIZE = 20;

const router = useRouter();
const nav = useNavStore();
/** 每屏一份视图状态：切走再回来页码与筛选还在（同一会话内） */
const view = nav.viewStateOf('alert.list');

const statusFilter = computed(() => view.filters.status ?? '');

const filters: readonly FilterDef[] = [
  { key: 'status', label: '状态', options: [{ value: '0', label: '未处理' }] },
];

const params = computed(() => ({
  page: view.page,
  size: PAGE_SIZE,
  ...(statusFilter.value === '' ? {} : { status: Number(statusFilter.value) }),
}));

const { data, loading, error, reload } = useResource<unknown>('alert.list', params);

const rows = computed(() => asList<AlertItem>(data.value));
const total = computed(() => asTotal(data.value));

const filterValues = computed<FilterValues>(() => ({ status: statusFilter.value }));

function onFilter(next: FilterValues): void {
  view.filters = { ...view.filters, ...next };
  // 换筛选必须回到第 1 页：留在第 7 页会看到"空列表"，用户以为是没数据
  view.page = 1;
}

function resetFilters(): void {
  view.filters = {};
  view.page = 1;
}

const columns: readonly ColumnDef<AlertItem>[] = [
  { key: 'title', title: '告警', compact: 'primary' },
  { key: 'eventId', title: '序号', type: 'mono', width: 100, value: (r) => (r.eventId === undefined ? '' : `#${r.eventId}`) },
  { key: 'message', title: '说明', compact: 'secondary' },
  { key: 'createTime', title: '发生时间', type: 'mono', width: 140, value: (r) => shortTime(r.createTime) },
  {
    key: 'status',
    title: '处理状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => alertStateText(alertStateOf(r)),
    tone: (r) => alertStateTone(alertStateOf(r)),
  },
  { key: 'level', title: '等级', type: 'status', width: 100, value: (r) => levelText(r.level), tone: (r) => levelTone(r.level) },
];

function openAlert(row: AlertItem): void {
  if (row.eventId !== undefined) {
    void router.push({ name: 'alert.detail', params: { alertId: String(row.eventId) } });
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="告警中心" :note="total !== undefined ? `共 ${total} 条` : '最近的告警事件'">
      <template #actions>
        <ElButton class="w-hide-compact" size="large" :loading="loading" @click="reload">刷新</ElButton>
      </template>
    </PageHeader>

    <FilterBar :model-value="filterValues" :filters="filters" @update:model-value="onFilter" @reset="resetFilters" />

    <SectionBlock title="告警列表">
      <StateHost
        :loading="loading"
        :error="error"
        :error-text="error ? humanize(error) : undefined"
        :empty="rows.length === 0"
        empty-text="没有符合条件的告警"
        skeleton="list"
        @retry="reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: AlertItem) => String(r.eventId ?? '')"
          clickable
          @row-click="openAlert"
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

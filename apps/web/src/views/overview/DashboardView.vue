<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton } from 'element-plus';
import { asList, humanize, shortTime, useResource } from '@wise/stores';
import {
  KeyValuePanel,
  MetricGrid,
  PageHeader,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  StatusChip,
  type ColumnDef,
  type KeyValueItem,
  type MetricItem,
} from '@wise/ui';
import { levelText, levelTone, type AlertItem } from './alertState.js';

/**
 * 看板（`dashboard.summary`）。
 *
 * 数据形状来自真后端 `DashboardSummaryDTO`：
 * `{inventoryTotal, todayAlertCount, inspectionProgress, deviceOnlineCount, unprocessedAlerts[], currentTask}`
 *
 * 三条从 React 版继承下来的约束：
 *  1. **四态由 StateHost 保证**（加载/空/错/内容互斥穷尽），屏只写内容态；
 *  2. **只渲染真实字段**：没有同比、没有趋势线、没有迷你图 —— 那些都要历史数据链路；
 *  3. **不摆假数据**：现场真机上付过学费，写死的行会被操作员当成真库存。
 */
interface DashboardSummary {
  readonly inventoryTotal?: number;
  readonly todayAlertCount?: number;
  readonly inspectionProgress?: number;
  readonly deviceOnlineCount?: number;
  readonly unprocessedAlerts?: readonly AlertItem[];
  readonly currentTask?: {
    readonly taskCode?: string;
    readonly taskName?: string;
    readonly progress?: number;
    readonly inspectedItems?: number;
    readonly totalItems?: number;
  } | null;
}

const router = useRouter();
const { data, loading, error, reload } = useResource<DashboardSummary>('dashboard.summary');

const alerts = computed(() => asList<AlertItem>(data.value?.unprocessedAlerts));
const task = computed(() => data.value?.currentTask ?? null);
const isEmpty = computed(() => data.value === undefined);

const metrics = computed<MetricItem[]>(() => [
  { key: 'inventory', label: '库存总量', value: String(data.value?.inventoryTotal ?? 0), tone: 'info' },
  { key: 'alerts', label: '今日告警', value: String(data.value?.todayAlertCount ?? 0), tone: 'warning' },
  { key: 'inspection', label: '巡检进度', value: `${data.value?.inspectionProgress ?? 0}%`, tone: 'success' },
  { key: 'devices', label: '设备在线', value: String(data.value?.deviceOnlineCount ?? 0), tone: 'neutral' },
]);

const taskItems = computed<KeyValueItem[]>(() => {
  const t = task.value;
  if (t === null) {
    return [];
  }
  return [
    { key: 'code', label: '任务号', value: t.taskCode ?? null, mono: true },
    { key: 'name', label: '任务名', value: t.taskName ?? null },
    {
      key: 'progress',
      label: '进度',
      value:
        t.totalItems !== undefined && t.totalItems > 0
          ? `${t.progress ?? 0}%（${t.inspectedItems ?? 0}/${t.totalItems}）`
          : `${t.progress ?? 0}%`,
      mono: true,
    },
  ];
});

/** 未处理告警：主文案 + 时间（等宽）+ 等级芯片。手机卡片用同一份列定义。 */
const alertColumns: readonly ColumnDef<AlertItem>[] = [
  { key: 'title', title: '告警', compact: 'primary' },
  {
    key: 'createTime',
    title: '时间',
    type: 'mono',
    width: 140,
    compact: 'secondary',
    value: (r) => shortTime(r.createTime),
  },
  {
    key: 'level',
    title: '等级',
    type: 'status',
    width: 100,
    compact: 'chip',
    value: (r) => levelText(r.level),
    tone: (r) => levelTone(r.level),
  },
];

function openAlert(row: AlertItem): void {
  if (row.eventId !== undefined) {
    void router.push({ name: 'alert.detail', params: { alertId: String(row.eventId) } });
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="看板" note="库存、告警、巡检与设备的实时汇总">
      <template #actions>
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
      </template>
    </PageHeader>

    <StateHost
      :loading="loading"
      :error="error"
      :error-text="error ? humanize(error) : undefined"
      :empty="isEmpty"
      skeleton="card"
      empty-text="暂无看板数据"
      @retry="reload"
    >
      <MetricGrid :items="metrics" />

      <div class="w-overview-grid">
        <SectionBlock title="当前任务">
          <div class="w-card">
            <KeyValuePanel v-if="taskItems.length > 0" :items="taskItems" />
            <span v-else class="w-overview-muted">当前没有进行中的巡检任务</span>
          </div>
        </SectionBlock>

        <SectionBlock :title="`未处理告警（${alerts.length}）`">
          <StateHost
            :empty="alerts.length === 0"
            empty-text="没有未处理的告警"
            skeleton="list"
          >
            <ResponsiveDataView
              :columns="alertColumns"
              :rows="alerts"
              :row-key="(r: AlertItem) => String(r.eventId ?? '')"
              clickable
              @row-click="openAlert"
            />
          </StateHost>
        </SectionBlock>
      </div>
    </StateHost>
  </div>
</template>

<style scoped>
.w-overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--w-size-card-min-width), 1fr));
  gap: var(--w-space-section-gap);
}

/* 卡片容器复用 @wise/ui 的卡片观感；这里是内容容器，不再嵌套卡片 */
.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-overview-muted {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-size);
}
</style>

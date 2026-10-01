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

/*
 * 0 必须能自证。
 *
 * 真机联调时对着 4 个 0 分不清两件事：**库里真的没有** 还是 **字段没接对**。
 * 这两种 0 在画面上长得一模一样，而它们的处置方式完全相反（一个去入数据、
 * 一个去修代码）—— 所以凡是 0，就把"为什么是 0"用一句话写出来。
 *
 * 依据全部来自本屏这一份 `dashboard.summary`（不额外发请求，不改契约）：
 * 2026-10-01 实测真后端就是这样返回的（库存表 0 条 / 设备 3 台全离线 / 当天无新告警）。
 */
const metrics = computed<MetricItem[]>(() => {
  const total = data.value?.inventoryTotal ?? 0;
  const alertsToday = data.value?.todayAlertCount ?? 0;
  const progress = data.value?.inspectionProgress ?? 0;
  const online = data.value?.deviceOnlineCount ?? 0;
  const pending = alerts.value.length;
  return [
    {
      key: 'inventory',
      label: '库存总量',
      value: String(total),
      tone: 'info',
      ...(total === 0 ? { note: '库存表还没有数据' } : {}),
    },
    {
      key: 'alerts',
      label: '今日告警',
      value: String(alertsToday),
      tone: 'warning',
      // 今天没有新告警，但历史未处理的还挂着 —— 这两句不能混成一句，否则会被读成"没有告警"
      ...(alertsToday === 0
        ? { note: pending > 0 ? `另有 ${pending} 条未处理告警` : '今天还没有新告警' }
        : {}),
    },
    {
      key: 'inspection',
      label: '巡检进度',
      value: `${progress}%`,
      tone: 'success',
      // 进度由服务端按"进行中的任务"写入；没有进行中任务时它就是 0，需要说明来由
      ...(progress === 0 && task.value === null ? { note: '当前没有进行中的任务' } : {}),
    },
    {
      key: 'devices',
      label: '设备在线',
      value: String(online),
      tone: 'neutral',
      ...(online === 0 ? { note: '当前没有在线设备' } : {}),
    },
  ];
});

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
        <ElButton class="w-hide-compact" size="large" :loading="loading" @click="reload">刷新</ElButton>
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

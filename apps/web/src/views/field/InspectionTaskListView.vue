<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { asList, asTotal, humanize, shortTime, useNavStore, useResource } from '@wise/stores';
import {
  PageHeader,
  PaginationBar,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  type ColumnDef,
  type StatusTone,
} from '@wise/ui';
import { taskStateOf, taskStateText, type TaskState } from './inspectionState.js';

/**
 * 巡检任务列表 —— 现场作业的入口：看一眼"今天有哪些盘点要做、做到哪了"，然后点进详情。
 * 语义逐条对齐 `packages/features/src/field/InspectionTaskListScreen.tsx`。
 *
 * 三条从 React 版带过来的决定（都对应踩过的坑，不是新设计）：
 *
 * 1. **每页条数的参数名只有 `pageSize`**：真后端 `InspectionController` 的
 *    `/api/inspection/task/page` 声明的是 `@RequestParam("page")` + `@RequestParam("pageSize")`（默认 10）。
 *    照抄库存域那套 `size` 会被服务端**直接丢掉**：界面以为一页 20 条、实际只回 10 条，而且不报错 ——
 *    现场表现只是"每页条数不对、翻页看着乱"，属于最难查的一类错。
 * 2. **筛选按「全部 / 进行中 / 已完成」表达**，而不是把服务端的英文状态名抛给用户：
 *    现场人员不认识 `COMPLETED` 这类词，只认识"做完了没有"。
 *    状态判定与文案统一走 `./inspectionState`（列表屏与详情屏共用一份，避免两处各错一次）。
 * 3. **搜索只在已取回的这一页里过滤**（该方法没有关键字参数），所以工具条上必须写清「筛选本页」——
 *    否则用户会把"这一页里没有"读成"整个仓库里没有"。
 */
interface TaskRow {
  readonly taskId?: number;
  readonly taskCode?: string;
  readonly planId?: number;
  readonly planName?: string;
  readonly taskType?: number;
  readonly taskTypeDesc?: string;
  readonly status?: number;
  readonly statusDesc?: string;
  readonly progress?: number;
  readonly totalItems?: number;
  readonly inspectedItems?: number;
  readonly normalItems?: number;
  readonly abnormalItems?: number;
  readonly missingItems?: number;
  readonly extraItems?: number;
  readonly warehouseName?: string;
  readonly deviceName?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly createTime?: string;
}

type TaskFilter = 'all' | 'running' | 'done';

const PAGE_SIZE = 20;

const router = useRouter();
/** 页码放导航 store：切断点、来回进出这一屏都不该把用户踹回第一页。 */
const nav = useNavStore();
const view = nav.viewStateOf('inspection.taskPage');

const keyword = ref('');
const applied = ref('');
const filter = ref<TaskFilter>('all');

const params = computed(() => ({ page: view.page, pageSize: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('inspection.taskPage', params);

const all = computed(() => asList<TaskRow>(data.value));
const total = computed(() => asTotal(data.value));

/** 巡检类型：服务端译好的描述优先，缺了才按数字码兜底。 */
function typeText(task: TaskRow): string {
  if (task.taskTypeDesc) {
    return task.taskTypeDesc;
  }
  switch (task.taskType) {
    case 0:
      return '全仓盘点';
    case 1:
      return '抽检';
    case 2:
      return '循环盘点';
    default:
      return '类型未登记';
  }
}

/** 状态芯片语气：done 已完成 / running 进行中 / paused 已暂停 / pending 待开始 / unknown 未上报。 */
function stateTone(state: TaskState): StatusTone {
  switch (state) {
    case 'done':
      return 'success';
    case 'running':
      return 'warning';
    case 'paused':
      return 'neutral';
    case 'pending':
      return 'info';
    default:
      return 'neutral';
  }
}

/** 进度：有总项数就带上"已盘 / 共"，没有就只给百分比。 */
function progressText(task: TaskRow): string {
  const percent = `${task.progress ?? 0}%`;
  if (task.totalItems === undefined) {
    return percent;
  }
  return `${percent}（${task.inspectedItems ?? 0}/${task.totalItems}）`;
}

const columns: readonly ColumnDef<TaskRow>[] = [
  { key: 'taskCode', title: '任务号', type: 'mono', width: 170, compact: 'primary', value: (r) => r.taskCode ?? '任务号未登记' },
  { key: 'planName', title: '巡检计划', compact: 'secondary', value: (r) => r.planName ?? '未关联巡检计划' },
  { key: 'taskType', title: '巡检类型', width: 110, value: (r) => typeText(r) },
  { key: 'warehouseName', title: '执行仓库', width: 150, value: (r) => r.warehouseName ?? '仓库未登记' },
  { key: 'deviceName', title: '执行设备', width: 130, value: (r) => r.deviceName ?? '未指定设备' },
  { key: 'progress', title: '进度', type: 'mono', width: 150, align: 'right', value: (r) => progressText(r) },
  {
    key: 'startTime',
    title: '开始时间',
    type: 'mono',
    width: 140,
    value: (r) => (r.startTime ? shortTime(r.startTime) : '未开始'),
  },
  {
    key: 'status',
    title: '状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => taskStateText(r),
    tone: (r) => stateTone(taskStateOf(r)),
  },
];

/**
 * 本页可见行。
 *
 * `?? ''` 是必需的：真后端对没填的字段回的是 `null` 而不是 `undefined`，
 * 只判 `!== undefined` 会让拼串给出 "null"，`.includes()` 也会在 null 上炸。
 */
const rows = computed(() =>
  all.value.filter((t) => {
    const state = taskStateOf(t);
    if (filter.value === 'running' && state !== 'running') {
      return false;
    }
    if (filter.value === 'done' && state !== 'done') {
      return false;
    }
    if (applied.value !== '') {
      const hay = `${t.taskCode ?? ''}${t.planName ?? ''}${t.warehouseName ?? ''}${t.deviceName ?? ''}`.toLowerCase();
      if (!hay.includes(applied.value.toLowerCase())) {
        return false;
      }
    }
    return true;
  }),
);

const note = computed(() => (total.value !== undefined ? `共 ${total.value} 个任务` : '盘点任务的执行进度与结果入口'));

/** 空态要讲清"为什么空"：没数据 vs 被筛掉，是两件事、两条出路。 */
const emptyText = computed(() =>
  applied.value !== '' || filter.value !== 'all'
    ? '没有符合条件的巡检任务，试试换个关键字，或切回「全部」。'
    : '还没有巡检任务。请联系管理员在后台创建巡检计划并下发任务，任务下发后会出现在这里。',
);

function onSearch(): void {
  applied.value = keyword.value.trim();
  view.page = 1;
}

function setFilter(next: TaskFilter): void {
  filter.value = next;
  // 换筛选条件必须回第一页：留在第 3 页看新条件的"空结果"是纯粹的自找困惑
  view.page = 1;
}

function resetFilters(): void {
  keyword.value = '';
  applied.value = '';
  filter.value = 'all';
  view.page = 1;
}

/** 整行点一下 = 去下一层看这个任务；序号缺失的行点了什么都不做（详情只认数字序号）。 */
function openDetail(row: TaskRow): void {
  if (row.taskId === undefined) {
    return;
  }
  void router.push({ name: 'inspection.taskDetail', params: { taskId: String(row.taskId) } });
}

function goCreate(): void {
  void router.push({ name: 'inspection.taskCreate' });
}

function onPageChange(page: number): void {
  view.page = page;
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="巡检任务" :note="note">
      <template #actions>
        <ElButton class="w-hide-compact" size="large" :loading="loading" @click="reload">刷新</ElButton>
        <ElButton size="large" type="primary" @click="goCreate">新建巡检</ElButton>
      </template>
    </PageHeader>

    <div class="w-toolbar">
      <ElInput
        v-model="keyword"
        size="large"
        clearable
        class="w-inspection-list__search"
        :prefix-icon="Search"
        placeholder="任务号 / 计划名 / 仓库 / 设备"
        @keydown.enter="onSearch"
      />
      <div class="w-chips">
        <button type="button" class="w-chip-item" :class="{ 'w-chip-item--active': filter === 'all' }" @click="setFilter('all')">
          全部
        </button>
        <button type="button" class="w-chip-item" :class="{ 'w-chip-item--active': filter === 'running' }" @click="setFilter('running')">
          进行中
        </button>
        <button type="button" class="w-chip-item" :class="{ 'w-chip-item--active': filter === 'done' }" @click="setFilter('done')">
          已完成
        </button>
        <button v-if="applied !== '' || filter !== 'all'" type="button" class="w-chip-item" @click="resetFilters">清空筛选</button>
      </div>
      <span class="w-inspection-list__scope">筛选本页 · 搜索框回车</span>
    </div>

    <SectionBlock :title="`任务列表${applied ? `（含「${applied}」）` : ''}`">
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
          :row-key="(r: TaskRow) => String(r.taskId ?? r.taskCode ?? '')"
          clickable
          @row-click="openDetail"
        />
      </StateHost>
      <!--
        分页条与"本页 N 个任务"在状态宿主**外面**（与 React 版一致）。
        放进去就会被三态一起藏掉：列表恰好空/错的时候，分页条是用户唯一还在的出口，
        藏了就只能靠「全部」或「查找」回第 1 页 —— 该留的导航控件不该跟着内容消失。
      -->
      <PaginationBar
        :page="view.page"
        :page-size="PAGE_SIZE"
        :total="total ?? all.length"
        :loading="loading"
        @update:page="onPageChange"
      />
      <p class="w-inspection-list__count">{{ `本页 ${rows.length} 个任务` }}</p>
    </SectionBlock>
  </div>
</template>

<style scoped>
.w-inspection-list__search {
  max-width: var(--w-space-detail-column-width);
}

/* 作用域标注必须常驻可见：它决定用户对"搜不到"的理解 */
.w-inspection-list__scope {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  white-space: nowrap;
}

.w-inspection-list__count {
  margin: var(--w-space-inline-gap) 0 0;
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  font-variant-numeric: tabular-nums;
}
</style>

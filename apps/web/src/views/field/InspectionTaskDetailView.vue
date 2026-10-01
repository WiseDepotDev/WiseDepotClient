<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { asList, humanize, shortTime, useMutation, useResource, type BridgeErrorLike } from '@wise/stores';
import {
  ActionDock,
  ConfirmDialog,
  KeyValuePanel,
  PageHeader,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  StatusChip,
  type ColumnDef,
  type KeyValueItem,
  type StatusTone,
} from '@wise/ui';
import { taskStateOf, taskStateText, type TaskState } from './inspectionState.js';

/**
 * 巡检任务详情 —— 把"一个巡检任务"讲完整：进度 → 物料差异 → 可以做的动作。
 * 语义逐条对齐 `packages/features/src/field/InspectionTaskDetailScreen.tsx`。
 *
 * 四条从 React 版带过来的决定（都对应踩过的坑，不是新设计）：
 *
 * 1. **进度不用进度条画，用数字 + 芯片**：现场是强光下看屏，细进度条看不清；
 *    百分比数字配"已盘 / 共"更有用，也不引入新的视觉元素。
 * 2. **状态动作是不可逆操作**：结束任务之后差异会被确认为账实结果，
 *    所以走 `ConfirmDialog` 二次确认（点一下就生效的操作在现场是不允许的）。
 * 3. **差异按「盘亏 / 盘盈 / 相符」翻译**：`MISSING` / `EXTRA` 这类英文枚举只在服务端有意义。
 * 4. **任务序号参数要从字符串转数字**：路由参数是字符串袋，转不出正整数就当"没有目标"，
 *    不发一个必然是错的请求（服务端只认数字序号），也不把英文枚举画到界面上
 *    （状态文案统一走 `./inspectionState`）。
 *
 * 一处**有意偏离 React 版**（真后端源码为准，见 `InspectionApplicationService#updateTaskStatus`）：
 * 「开始执行」发给服务端的值必须是 `IN_PROGRESS` —— 服务端只认 `IN_PROGRESS` / `COMPLETED`，
 * 且**没有 else 分支、不报错**，传其它值会被静默置回 `PENDING`（待执行），
 * 界面上只表现为"点了开始、状态没变"。界面文案仍然是"开始执行"，那是给现场人员看的说法。
 */
interface TaskDetail {
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
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly deviceId?: number;
  readonly deviceName?: string;
  readonly targetDistance?: number;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly createTime?: string;
  readonly updateTime?: string;
}

interface DiffRow {
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly expectedQuantity?: number;
  readonly scannedQuantity?: number;
  readonly difference?: number;
  readonly status?: string;
}

/**
 * 二次确认框里"要做哪件事"。
 *
 * 取值就是**发给服务端的原值**（`IN_PROGRESS` / `COMPLETED`），不做一层界面语义词映射 ——
 * 少一层映射就少一处"界面以为在开始、实际被静默置回待执行"的机会。
 */
type PendingStatus = 'IN_PROGRESS' | 'COMPLETED';

const route = useRoute();
const router = useRouter();

/**
 * 路由参数 → 任务序号。
 *
 * `noUncheckedIndexedAccess` 下 `params['taskId']` 本来就可能是 `string[]`，
 * 再叠上"路由段可能是空的"，所以这里自己兜全：只要不是正数就返回 `undefined`。
 */
const initialTaskId = ((): number | undefined => {
  const raw = route.params['taskId'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(String(text).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
})();

const idInput = ref('');
const selectedId = ref<number | undefined>(initialTaskId);
const lookupError = ref<string | undefined>(undefined);
const onlyAbnormal = ref(false);
const pendingStatus = ref<PendingStatus | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);

const hasTarget = computed(() => selectedId.value !== undefined);
/** 参数没准备好时用 `enabled` 表达，**不要**拿 `params === undefined` 兼表两义。 */
const detailParams = computed(() => (selectedId.value === undefined ? {} : { taskId: selectedId.value }));

const {
  data: taskData,
  loading: taskLoading,
  error: taskError,
  reload: reloadTask,
} = useResource<unknown>('inspection.taskDetail', detailParams, { enabled: hasTarget });

const {
  data: diffData,
  loading: diffLoading,
  error: diffError,
  reload: reloadDiff,
} = useResource<unknown>('inspection.taskDiff', detailParams, { enabled: hasTarget });

/**
 * 状态流转（开始 / 结束）：写操作一律走 `useMutation`，不做乐观更新 ——
 * 服务端有状态机，回滚会误导操作员。
 */
const statusMutation = useMutation<unknown>('inspection.taskStatus');
const progressMutation = useMutation<unknown>('inspection.taskProgress');
const busy = computed(() => statusMutation.pending.value || progressMutation.pending.value);

function hasDetail(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/** 详情接口两种形状都出现过：直接给对象，或包一层 `rows`。两种都接住。 */
function detailOf(value: unknown): TaskDetail | undefined {
  if (!hasDetail(value)) {
    return undefined;
  }
  const list = asList<TaskDetail>(value);
  const first = list[0];
  return first !== undefined ? first : (value as TaskDetail);
}

const task = computed<TaskDetail | undefined>(() => detailOf(taskData.value));
const diffs = computed(() => asList<DiffRow>(diffData.value));
const abnormalCount = computed(() => diffs.value.filter(isAbnormalDiff).length);
const shownDiffs = computed(() => (onlyAbnormal.value ? diffs.value.filter(isAbnormalDiff) : diffs.value));
const state = computed<TaskState>(() => (task.value === undefined ? 'unknown' : taskStateOf(task.value)));
const stateText = computed(() => (task.value === undefined ? '' : taskStateText(task.value)));

/** 巡检类型：服务端译好的描述优先，缺了才按数字码兜底。 */
function typeText(t: TaskDetail): string {
  if (t.taskTypeDesc) {
    return t.taskTypeDesc;
  }
  switch (t.taskType) {
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

function stateTone(value: TaskState): StatusTone {
  switch (value) {
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

/** 服务端可能给 `null`，所以判空要连 `null` 一起判。 */
function optionalNumber(value: number | null | undefined): string {
  return value === undefined || value === null ? '—' : String(value);
}

function differenceText(diff: DiffRow): string {
  const raw = diff.difference ?? 0;
  if (raw === 0) {
    return '账实相符';
  }
  return raw < 0 ? `盘亏 ${Math.abs(raw)}` : `盘盈 ${raw}`;
}

/** 差异项是否属于"需要人处理"的那一类。服务端给了枚举就用枚举，没给就退回数量差。 */
function isAbnormalDiff(diff: DiffRow): boolean {
  const status = (diff.status ?? '').toUpperCase();
  if (status === 'MISSING' || status === 'EXTRA') {
    return true;
  }
  if (status === 'NORMAL') {
    return false;
  }
  return (diff.difference ?? 0) !== 0;
}

function diffChipText(diff: DiffRow): string {
  const status = (diff.status ?? '').toUpperCase();
  if (status === 'MISSING' || (diff.difference ?? 0) < 0) {
    return '盘亏';
  }
  if (status === 'EXTRA' || (diff.difference ?? 0) > 0) {
    return '盘盈';
  }
  return '相符';
}

function diffChipTone(diff: DiffRow): StatusTone {
  const status = (diff.status ?? '').toUpperCase();
  if (status === 'MISSING' || (diff.difference ?? 0) < 0) {
    return 'danger';
  }
  if (status === 'EXTRA' || (diff.difference ?? 0) > 0) {
    return 'warning';
  }
  return 'success';
}

function diffRowKey(row: DiffRow): string {
  return String(row.productId ?? row.productCode ?? '');
}

const pageTitle = computed(() => (task.value?.taskCode ? `巡检任务 ${task.value.taskCode}` : '巡检任务详情'));

const pageNote = computed(() => {
  const t = task.value;
  if (t === undefined) {
    return '查看任务进度、物料差异，并推进任务状态';
  }
  return `${t.planName ?? '未关联计划'} · ${typeText(t)} · ${stateText.value}`;
});

const infoItems = computed<KeyValueItem[]>(() => {
  const t = task.value;
  if (t === undefined) {
    return [];
  }
  const quantityUnknown = t.inspectedItems === undefined && t.totalItems === undefined;
  return [
    { key: 'taskCode', label: '任务号', value: t.taskCode ?? '未登记', mono: true },
    { key: 'planName', label: '巡检计划', value: t.planName ?? '未关联计划' },
    { key: 'taskType', label: '巡检类型', value: typeText(t) },
    { key: 'warehouseName', label: '执行仓库', value: t.warehouseName ?? '未登记', mono: true },
    { key: 'deviceName', label: '执行设备', value: t.deviceName ?? '未指定设备' },
    {
      key: 'quantity',
      label: '盘点数量',
      value: `已盘 ${t.inspectedItems ?? 0} / 共 ${t.totalItems ?? 0}${quantityUnknown ? ' 数量未上报' : ''}`,
    },
    {
      key: 'normalAbnormal',
      label: '正常 / 异常',
      value: `${optionalNumber(t.normalItems)} / ${optionalNumber(t.abnormalItems)}`,
    },
    {
      key: 'startTime',
      label: '开始时间',
      value: t.startTime ? shortTime(t.startTime) : '尚未开始，可在下方「开始执行」',
    },
    { key: 'endTime', label: '结束时间', value: t.endTime ? shortTime(t.endTime) : '尚未结束' },
  ];
});

const taskEmptyText = computed(() =>
  hasTarget.value
    ? '没有找到这个巡检任务。请核对任务序号，或回到「巡检任务」列表重新选择。'
    : '还没有选择任务。请在上方输入任务序号后点「查询」。',
);

const diffTitle = computed(() => `物料差异${diffs.value.length > 0 ? `（${diffs.value.length} 项）` : ''}`);

const diffEmptyText = computed(() =>
  onlyAbnormal.value
    ? '这个任务目前没有盘盈或盘亏的物料，账实一致。'
    : '这个任务还没有产生差异明细。任务开始盘点并上传数据后，这里会逐项列出盘点结果。',
);

const diffColumns: readonly ColumnDef<DiffRow>[] = [
  {
    key: 'productCode',
    title: '商品编码',
    type: 'mono',
    width: 160,
    compact: 'primary',
    value: (r) => r.productCode ?? '编码未登记',
  },
  { key: 'productName', title: '物料名称', compact: 'secondary', value: (r) => r.productName ?? '未命名物料' },
  { key: 'expectedQuantity', title: '预期数量', type: 'mono', width: 110, align: 'right', value: (r) => String(r.expectedQuantity ?? 0) },
  { key: 'scannedQuantity', title: '实扫数量', type: 'mono', width: 110, align: 'right', value: (r) => String(r.scannedQuantity ?? 0) },
  { key: 'difference', title: '差异', width: 140, value: (r) => differenceText(r) },
  {
    key: 'status',
    title: '判定',
    type: 'status',
    width: 100,
    compact: 'chip',
    value: (r) => diffChipText(r),
    tone: (r) => diffChipTone(r),
  },
];

/**
 * 按序号查任务。
 *
 * 校验比 React 版**收紧到整数**（有意偏离，Vue 侧收紧）：提示语写的就是「正整数」，
 * 而 React 只判 `> 0`，于是 `12.5` 会被放行、再被服务端回一句"任务不存在" ——
 * 让用户按提示语改正，比让他去猜服务端为什么说没有这个任务要好。报错文案一字未改。
 */
function openById(): void {
  const id = Number(idInput.value.trim());
  if (!Number.isInteger(id) || id <= 0) {
    lookupError.value = '请输入正确的任务序号（正整数）';
    return;
  }
  lookupError.value = undefined;
  actionError.value = undefined;
  notice.value = undefined;
  selectedId.value = id;
}

function openStatus(next: PendingStatus): void {
  pendingStatus.value = next;
}

function cancelStatus(): void {
  pendingStatus.value = undefined;
}

function confirmStatus(): void {
  void runStatusChange();
}

async function runStatusChange(): Promise<void> {
  const next = pendingStatus.value;
  pendingStatus.value = undefined;
  const id = selectedId.value;
  if (next === undefined || id === undefined) {
    return;
  }
  actionError.value = undefined;
  try {
    /*
     * `next` 就是发给服务端的原值：开始是 `IN_PROGRESS`、结束是 `COMPLETED`。
     * 服务端只认这两个（`InspectionApplicationService#updateTaskStatus`），
     * 而且**没有 else 分支也不会报错** —— 传其它值会被静默置回 `PENDING`（待执行）：
     * 界面上只看到"点了开始、状态没变 / 变回待开始"（React 版发的那个旧值就踩在这里）。
     */
    await statusMutation.run({ taskId: id, status: next });
    notice.value = next === 'IN_PROGRESS' ? '任务已开始执行。' : '任务已结束，正在汇总盘点结果。';
    reloadTask();
    reloadDiff();
  } catch (e) {
    actionError.value = humanize(e as BridgeErrorLike);
  }
}

async function reportProgress(): Promise<void> {
  const id = selectedId.value;
  if (id === undefined) {
    return;
  }
  actionError.value = undefined;
  try {
    await progressMutation.run({
      taskId: id,
      // 进度只能是 0..100：越界的值服务端会拒，但更糟的是界面上先画出一个不可能的数
      progress: Math.max(0, Math.min(100, task.value?.progress ?? 0)),
      scannedCount: task.value?.inspectedItems ?? 0,
    });
    notice.value = '进度已保存，现场设备与后台会同步看到最新进度。';
    reloadTask();
  } catch (e) {
    actionError.value = humanize(e as BridgeErrorLike);
  }
}

/**
 * 结果与补录的入口。
 *
 * 只给**入口链接**，本屏不拉结果：真后端的结果列表本来就支持按任务过滤
 * （`listResults(taskId, …)`），结果详情由结果列表点行进入 —— 详情屏多发一次
 * "只为了找一个 resultId"的请求就是白拉的流量。
 */
function goResultList(): void {
  const id = selectedId.value;
  if (id === undefined) {
    return;
  }
  void router.push({ name: 'inspection.resultList', query: { taskId: String(id) } });
}

function goManualRecord(): void {
  const id = selectedId.value;
  if (id === undefined) {
    return;
  }
  void router.push({ name: 'inspection.manualRecord', query: { taskId: String(id) } });
}
</script>

<template>
  <div class="w-page">
    <PageHeader :title="pageTitle" :note="pageNote">
      <template #actions>
        <ElButton size="large" type="primary" :disabled="!hasTarget || busy" :loading="taskLoading" @click="reloadTask">
          刷新
        </ElButton>
      </template>
    </PageHeader>

    <SectionBlock title="查看某个任务">
      <div class="w-inspection-detail__card">
        <div class="w-toolbar">
          <span class="w-inspection-detail__label">任务序号</span>
          <ElInput
            v-model="idInput"
            size="large"
            clearable
            class="w-inspection-detail__id-input"
            placeholder="如：501"
            @keydown.enter="openById"
          />
          <ElButton size="large" @click="openById">查询</ElButton>
        </div>
        <p v-if="lookupError" class="w-inspection-detail__error" role="alert">{{ lookupError }}</p>
        <p class="w-inspection-detail__hint">也可以从「巡检任务」列表点选一个任务直接进来。</p>
      </div>
    </SectionBlock>

    <p v-if="actionError" class="w-inspection-detail__error" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="w-inspection-detail__notice" role="status">{{ notice }}</p>

    <SectionBlock title="任务信息">
      <div class="w-inspection-detail__card">
        <StateHost
          :loading="taskLoading"
          :error="taskError"
          :error-text="taskError ? humanize(taskError) : undefined"
          :empty="task === undefined"
          :empty-text="taskEmptyText"
          skeleton="detail"
          @retry="reloadTask"
        >
          <div class="w-inspection-detail__chips">
            <StatusChip :text="stateText" :tone="stateTone(state)" />
            <StatusChip :text="`已完成 ${task?.progress ?? 0}%`" tone="neutral" />
            <StatusChip v-if="abnormalCount > 0" :text="`${abnormalCount} 项物料有差异`" tone="warning" />
          </div>
          <KeyValuePanel :items="infoItems" />
        </StateHost>
      </div>
    </SectionBlock>

    <SectionBlock :title="diffTitle">
      <StateHost
        :loading="diffLoading"
        :error="diffError"
        :error-text="diffError ? humanize(diffError) : undefined"
        :empty="shownDiffs.length === 0"
        :empty-text="diffEmptyText"
        skeleton="list"
        @retry="reloadDiff"
      >
        <ResponsiveDataView :columns="diffColumns" :rows="shownDiffs" :row-key="diffRowKey" />
      </StateHost>
      <div class="w-toolbar">
        <ElButton size="large" @click="onlyAbnormal = !onlyAbnormal">
          {{ onlyAbnormal ? '显示全部物料' : `只看有差异的（${abnormalCount}）` }}
        </ElButton>
      </div>
    </SectionBlock>

    <SectionBlock title="结果与补录">
      <div class="w-inspection-detail__entries">
        <ElButton size="large" :disabled="!hasTarget" @click="goResultList">巡检结果列表</ElButton>
        <ElButton size="large" :disabled="!hasTarget" @click="goManualRecord">手动补录</ElButton>
      </div>
    </SectionBlock>

    <ActionDock>
      <ElButton
        size="large"
        :disabled="!hasTarget || busy || state === 'running' || state === 'done'"
        @click="openStatus('IN_PROGRESS')"
      >
        开始执行
      </ElButton>
      <ElButton size="large" :disabled="!hasTarget || busy || state !== 'running'" @click="reportProgress">
        保存当前进度
      </ElButton>
      <ElButton
        size="large"
        type="danger"
        :disabled="!hasTarget || busy || state === 'done' || state === 'pending'"
        @click="openStatus('COMPLETED')"
      >
        {{ busy ? '处理中…' : '结束任务' }}
      </ElButton>
    </ActionDock>

    <ConfirmDialog
      :show="pendingStatus !== undefined"
      :title="pendingStatus === 'IN_PROGRESS' ? '开始执行任务' : '结束任务'"
      :danger="pendingStatus === 'COMPLETED'"
      :confirm-text="pendingStatus === 'IN_PROGRESS' ? '开始执行' : '结束任务'"
      :pending="busy"
      @confirm="confirmStatus"
      @cancel="cancelStatus"
    >
      <p class="w-inspection-detail__confirm">
        {{
          pendingStatus === 'IN_PROGRESS'
            ? '任务将切换为「进行中」，巡检设备随后按计划开始盘点。'
            : '结束后将以当前盘点数据作为账实差异结果，差异明细会进入待确认状态，操作不可撤销。'
        }}
      </p>
      <p class="w-inspection-detail__hint">
        {{ `任务号 ${task?.taskCode ?? '未登记'} · 已完成 ${task?.progress ?? 0}%` }}
      </p>
      <p v-if="actionError" class="w-inspection-detail__error" role="alert">{{ actionError }}</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.w-inspection-detail__card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-inspection-detail__label {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  white-space: nowrap;
}

/* 任务序号是机器数据：等宽字体，避免 0/O 误读 */
.w-inspection-detail__id-input {
  max-width: var(--w-size-card-min-width);
  font-family: var(--w-font-mono);
}

.w-inspection-detail__hint {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-detail__error {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-detail__notice {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-success-text);
  background: var(--w-state-success-fill);
  color: var(--w-state-success-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
}

.w-inspection-detail__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  margin-bottom: var(--w-space-group-gap);
}

.w-inspection-detail__entries {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
}

.w-inspection-detail__confirm {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}
</style>

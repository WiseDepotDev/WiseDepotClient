<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { asList, humanize, useMutation, useResource, type BridgeErrorLike } from '@wise/stores';
import { ActionDock, ConfirmDialog, KeyValuePanel, PageHeader, SectionBlock, StateHost, StatusChip, type KeyValueItem, type StatusTone } from '@wise/ui';
import { taskStateOf, taskStateText, type TaskState } from './inspectionState.js';

/**
 * 手动补录巡检明细 —— 解决现场最常见的意外：**漏扫**。
 * 语义逐条对齐 `packages/features/src/field/InspectionManualRecordScreen.tsx`。
 *
 * 四条从 React 版带过来的决定（都对应踩过的坑，不是新设计）：
 *
 * 1. **一屏能连扫多行**：现场是拿扫码枪连续扫，所以「回车 = 新增一行并聚焦到它」。
 *    每行只有 NFC 编号常显，TID 与备注收在开关后面 —— 它们是少数情况才填的字段，
 *    常显会把一屏挤到只能看到两行。
 * 2. **删除是一颗真正的按钮**（触摸目标不小于 48），不是行尾的小叉：戴着手套点小图标点不中。
 * 3. **前置条件是"任务已完成"，且在填一堆行之前就说清楚**：
 *    真后端 `InspectionApplicationService` 只允许对**已完成**的任务补录，
 *    未完成时业务拒绝的原话是「只能对已完成的巡检任务进行补录」。
 *    与其让操作员扫完十条再被后台拒绝，不如在这里先拦住并把原话摆出来。
 * 4. **没填任务序号就不发任何请求**：没有目标时取任务信息、提交补录都是注定失败的往返。
 *
 * 一处**真后端才有的后果**（React 版只弹了个成功提示，漏了这步）：
 * 补录会**触发服务端重算计数**（实测 `normalItems` 从 8 变 0），所以提交成功后
 * **必须重新拉任务详情**，否则屏上还是补录前的数字。
 */

interface TaskSummary {
  readonly taskId?: number;
  readonly taskCode?: string;
  readonly planName?: string;
  readonly warehouseName?: string;
  readonly deviceName?: string;
  readonly status?: number;
  readonly statusDesc?: string;
  readonly progress?: number;
  readonly totalItems?: number;
  readonly inspectedItems?: number;
  readonly abnormalItems?: number;
}

/** 补录表单的一行。`key` 服务渲染稳定性，也是"把焦点送到刚加的那一行"用的地址。 */
interface RecordRow {
  readonly key: string;
  readonly rfid: string;
  readonly tid: string;
  readonly remark: string;
}

interface RowPatch {
  readonly rfid?: string;
  readonly tid?: string;
  readonly remark?: string;
}

interface ManualItem {
  readonly rfid: string;
  readonly tid?: string;
  readonly remark?: string;
}

function hasContent(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/**
 * 详情接口两种形状都出现过：直接给对象，或包一层列表。
 * 取不到时返回 `undefined`，与"任务不存在"分开处理（后者要显示后台的原话）。
 */
function taskSummaryOf(value: unknown): TaskSummary | undefined {
  if (!hasContent(value)) {
    return undefined;
  }
  const first = asList<TaskSummary>(value)[0];
  return first !== undefined ? first : (value as TaskSummary);
}

/** 序号解析：空 = 没填，正整数 = 可用，其余都是"填错了"。 */
function parseId(raw: string): { kind: 'empty' | 'ok' | 'invalid'; id: number | undefined } {
  const text = raw.trim();
  if (text === '') {
    return { kind: 'empty', id: undefined };
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { kind: 'invalid', id: undefined };
  }
  return { kind: 'ok', id: parsed };
}

/** 一行 → 一条补录明细。可选字段留空时**不放进明细**，而不是发空字符串（后台要区分没填与填了空）。 */
function itemOf(row: RecordRow): ManualItem {
  const rfid = row.rfid.trim();
  const tid = row.tid.trim();
  const remark = row.remark.trim();
  const item: ManualItem = { rfid };
  const withTid: ManualItem = tid === '' ? item : { rfid, tid };
  return remark === '' ? withTid : { ...withTid, remark };
}

const route = useRoute();
const router = useRouter();

/** 从任务详情或结果屏推进来时带 `?taskId=`：带上就直接查这个任务，少一次手输。 */
const queryTaskId = ((): number | undefined => {
  const raw = route.query['taskId'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string') {
    return undefined;
  }
  return parseId(text).id;
})();

const taskInput = ref(queryTaskId === undefined ? '' : String(queryTaskId));
const taskError = ref<string | undefined>(undefined);
const rows = ref<readonly RecordRow[]>([{ key: 'row-1', rfid: '', tid: '', remark: '' }]);
const expanded = ref<readonly string[]>([]);
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);
/**
 * 「缺 NFC 编号」的行内错误只在**用户试着提交过**之后才显出来（React 版的 `tried`）。
 * 一进屏就把每一行标红，会让人以为是自己弄错了。
 */
const tried = ref(false);
const pending = ref(false);

/**
 * 行输入框实例表：扫码枪就是键盘，焦点在哪就扫进哪一行，
 * 所以「新增一行」之后要把焦点送到刚加的那一行（用 `nextTick` 等 DOM 落地）。
 * **首屏不抢焦点** —— 用户可能是先来看任务状态的。
 */
const rowInputs = new Map<string, unknown>();
let seq = 1;

function setRowInput(key: string, instance: unknown): void {
  if (instance === null) {
    rowInputs.delete(key);
    return;
  }
  rowInputs.set(key, instance);
}

/** `ElInput` 暴露的 `focus()`；按结构判一下，避免把组件实例断言成某个内部类型。 */
function focusRow(key: string): void {
  const instance = rowInputs.get(key) as { focus?: () => void } | undefined;
  if (typeof instance?.focus === 'function') {
    instance.focus();
  }
}

/**
 * 输入框里**当前**解析出来的序号（二次确认框用它回显；真正提交用的是 `selectedId`，
 * 也就是"上次点过查询"的那个任务 —— 两者可能不同，因为用户改了数字没点查询）。
 */
const typedTaskId = computed(() => parseId(taskInput.value).id);
const selectedId = ref<number | undefined>(queryTaskId);
const hasTask = computed(() => selectedId.value !== undefined);

/** 参数没准备好时用 `enabled` 表达，**不要**拿 `params === undefined` 兼表两义。 */
const taskParams = computed(() => (selectedId.value === undefined ? {} : { taskId: selectedId.value }));

const {
  data: taskData,
  loading: taskLoading,
  error: taskError_,
  reload: reloadTask,
} = useResource<unknown>('inspection.taskDetail', taskParams, { enabled: hasTask });

const task = computed(() => taskSummaryOf(taskData.value));
const taskState = computed<TaskState>(() => (task.value === undefined ? 'unknown' : taskStateOf(task.value)));
const taskStateText_ = computed(() => (task.value === undefined ? '' : taskStateText(task.value)));

/** 前置条件：补录只对已完成的巡检任务开放。宁可在这里就拦住，也不要让人扫完十条才被拒。 */
const canRecord = computed(() => hasTask.value && task.value !== undefined && taskState.value === 'done');

const blockedText = computed(() =>
  hasTask.value && !taskLoading.value && task.value !== undefined && taskState.value !== 'done'
    ? `这个任务当前是「${taskStateText_.value}」。`
    : undefined,
);

/** 按钮为什么不能点，就写在按钮旁边：现场不会去猜一个灰掉的按钮。 */
const gateText = computed(() => {
  if (!hasTask.value) {
    return '请先填写任务序号';
  }
  if (taskLoading.value) {
    return '正在确认任务状态…';
  }
  if (task.value === undefined) {
    return '还没有取到任务信息，界面会自动重取；也可以再点一次「查询」';
  }
  if (taskState.value === 'done') {
    return undefined;
  }
  return '任务未完成，暂不能补录';
});

const missingRows = computed(() =>
  rows.value.map((row, index) => (row.rfid.trim() === '' ? index + 1 : 0)).filter((index) => index > 0),
);
const rowsReady = computed(() => rows.value.length > 0 && missingRows.value.length === 0);

/**
 * 重复项提示。
 *
 * React 版**没有**判重，服务端也没有对应的拒绝（它只是逐条插入），
 * 所以这里只做**不拦提交**的提醒：现场用扫码枪连扫时最容易把同一张标签扫两遍，
 * 说一句比事后对着差异明细查半天便宜。
 */
const duplicateRfids = computed(() => {
  const seen = new Map<string, number>();
  for (const row of rows.value) {
    const rfid = row.rfid.trim();
    if (rfid === '') {
      continue;
    }
    seen.set(rfid, (seen.get(rfid) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([rfid]) => rfid);
});

/** 二次确认里报前几条编号：补录会改变账实差异，让操作员能对着标签核对一眼。 */
const previewRfids = computed(() => rows.value.slice(0, 3).map((row) => row.rfid.trim()));
const previewText = computed(() =>
  rows.value.length > previewRfids.value.length
    ? `${previewRfids.value.join('、')} 等 ${rows.value.length} 条`
    : previewRfids.value.join('、'),
);

const taskEmptyText = computed(() =>
  hasTask.value
    ? '没有找到这个任务。请核对任务序号，或先到「巡检任务」里确认任务已经建好。'
    : '还没有填任务序号。填上要补录的任务序号，这里会显示它的状态。',
);

const infoItems = computed<KeyValueItem[]>(() => {
  const t = task.value;
  return [
    { key: 'taskCode', label: '任务号', value: t?.taskCode ?? '未登记', mono: true },
    { key: 'planName', label: '巡检计划', value: t?.planName ?? '未关联计划' },
    { key: 'warehouseName', label: '执行仓库', value: t?.warehouseName ?? '未登记', mono: true },
    { key: 'deviceName', label: '执行设备', value: t?.deviceName ?? '未指定设备' },
    { key: 'inspected', label: '已盘数量', value: `${t?.inspectedItems ?? 0} / 共 ${t?.totalItems ?? 0}`, mono: true },
  ];
});

/** 状态芯片语气与「巡检任务详情」屏保持一致（done 绿 / running 橙 / paused 红 / 其余灰）。 */
const stateTone = computed<StatusTone>(() => {
  switch (taskState.value) {
    case 'done':
      return 'success';
    case 'running':
      return 'warning';
    case 'paused':
      return 'danger';
    default:
      return 'neutral';
  }
});

const recordMutation = useMutation<unknown>('inspection.manualRecord');
const busy = computed(() => recordMutation.pending.value);

function emptyRow(key: string): RecordRow {
  return { key, rfid: '', tid: '', remark: '' };
}

function updateRow(key: string, patch: RowPatch): void {
  rows.value = rows.value.map((row) =>
    row.key === key
      ? {
          key: row.key,
          rfid: patch.rfid ?? row.rfid,
          tid: patch.tid ?? row.tid,
          remark: patch.remark ?? row.remark,
        }
      : row,
  );
}

function isExpanded(key: string): boolean {
  return expanded.value.includes(key);
}

function toggleExtra(key: string): void {
  expanded.value = isExpanded(key) ? expanded.value.filter((k) => k !== key) : [...expanded.value, key];
}

/** 新增一行并把焦点送过去：扫码枪连扫时，加完就要能直接扫下一条。 */
function addRow(): void {
  if (busy.value) {
    return;
  }
  seq += 1;
  const key = `row-${seq}`;
  rows.value = [...rows.value, emptyRow(key)];
  void nextTick(() => focusRow(key));
}

function removeRow(key: string): void {
  if (busy.value) {
    return;
  }
  rowInputs.delete(key);
  expanded.value = expanded.value.filter((k) => k !== key);
  const remaining = rows.value.filter((row) => row.key !== key);
  if (remaining.length === 0) {
    // 永远留一行：整屏没有行的话，操作员还得先点「新增一行」才能继续
    seq += 1;
    const fresh = `row-${seq}`;
    rows.value = [emptyRow(fresh)];
    void nextTick(() => focusRow(fresh));
    return;
  }
  rows.value = remaining;
}

function clearRows(): void {
  if (busy.value) {
    return;
  }
  seq += 1;
  const fresh = `row-${seq}`;
  rowInputs.clear();
  expanded.value = [];
  rows.value = [emptyRow(fresh)];
  actionError.value = undefined;
  notice.value = undefined;
  tried.value = false;
  void nextTick(() => focusRow(fresh));
}

/**
 * 按序号换任务：路由参数只是"第一次进来时的默认值"，之后以输入框为准。
 * 校验比 React 版**收紧到整数**（有意偏离）：提示语写的就是「大于 0 的整数」。
 */
function openTask(): void {
  const parsed = parseId(taskInput.value);
  if (parsed.kind === 'invalid') {
    taskError.value = '任务序号要填大于 0 的整数，例如 501';
    return;
  }
  taskError.value = undefined;
  actionError.value = undefined;
  notice.value = undefined;
  selectedId.value = parsed.id;
}

/** 打开二次确认前的两道业务闸门：没有任务、任务没完成，都在这里说清楚。 */
function openConfirm(): void {
  if (!hasTask.value) {
    actionError.value = '请先填写任务序号，再补录明细。';
    return;
  }
  if (!canRecord.value) {
    actionError.value =
      '这个任务还没有完成，补录只对已完成的巡检任务开放。请先把任务做完，再回来补录漏扫的标签。';
    return;
  }
  if (!rowsReady.value) {
    tried.value = true;
    actionError.value = `第 ${missingRows.value.join('、')} 行还没有 NFC 编号，请扫码或手动输入后再提交。`;
    return;
  }
  actionError.value = undefined;
  pending.value = true;
}

async function submit(): Promise<void> {
  pending.value = false;
  const id = selectedId.value;
  if (id === undefined) {
    actionError.value = '请先填写任务序号，再补录明细。';
    return;
  }
  if (!canRecord.value) {
    actionError.value =
      '这个任务还没有完成，补录只对已完成的巡检任务开放。请先把任务做完，再回来补录漏扫的标签。';
    return;
  }
  if (!rowsReady.value) {
    tried.value = true;
    actionError.value = `第 ${missingRows.value.join('、')} 行还没有 NFC 编号，请扫码或手动输入后再提交。`;
    return;
  }
  const items = rows.value.map(itemOf);
  const count = items.length;
  actionError.value = undefined;
  notice.value = undefined;
  try {
    // taskId 必须和明细一起放在提交体里；契约把路径参数也保留在 body（`keepPathParamsInBody`）
    await recordMutation.run({ taskId: id, items });
    notice.value = `已把 ${count} 条明细补录到任务 ${id}。`;
    /*
     * 补录会触发服务端重算计数（实测 `normalItems` 从 8 变 0）：
     * **必须重新拉任务详情**，否则屏上还显示补录前的数字，会让人以为补录没生效。
     */
    reloadTask();
    seq += 1;
    const fresh = `row-${seq}`;
    rowInputs.clear();
    expanded.value = [];
    rows.value = [emptyRow(fresh)];
    tried.value = false;
    void nextTick(() => focusRow(fresh));
  } catch (e) {
    actionError.value = humanize(e as BridgeErrorLike);
  }
}

function goTaskDetail(): void {
  const id = selectedId.value;
  if (id !== undefined) {
    void router.push({ name: 'inspection.taskDetail', params: { taskId: String(id) } });
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="手动补录巡检明细" note="把漏扫的 NFC 标签补录进已完成的巡检任务，一行一个标签">
      <template #actions>
        <ElButton size="large" :disabled="busy" @click="addRow">新增一行</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError" class="w-inspection-manual__error" role="alert">{{ actionError }}</p>

    <SectionBlock v-if="notice" title="补录结果">
      <div class="w-inspection-manual__card">
        <p class="w-inspection-manual__notice" role="status">{{ notice }}</p>
        <p class="w-inspection-manual__hint">接着扫下一批即可，下面的行已经清空。</p>
        <ElButton v-if="hasTask" size="large" type="primary" @click="goTaskDetail">回到任务详情</ElButton>
      </div>
    </SectionBlock>

    <SectionBlock title="补录到哪个任务">
      <div class="w-inspection-manual__card">
        <p class="w-inspection-manual__label">任务序号 *</p>
        <div class="w-inspection-manual__row">
          <ElInput
            v-model="taskInput"
            size="large"
            clearable
            class="w-inspection-manual__id-input"
            placeholder="如：501"
            @keydown.enter="openTask"
          />
          <ElButton size="large" @click="openTask">查询</ElButton>
        </div>
        <p v-if="taskError" class="w-inspection-manual__field-error" role="alert">{{ taskError }}</p>
        <p class="w-inspection-manual__hint">
          补录只对已完成的巡检任务开放。任务完成后才能在任务详情里补录漏扫的标签。
        </p>

        <StateHost
          :loading="taskLoading"
          :error="taskError_ ?? null"
          :error-text="taskError_ ? humanize(taskError_) : undefined"
          :empty="task === undefined"
          :empty-text="taskEmptyText"
          skeleton="detail"
          @retry="reloadTask"
        >
          <div class="w-inspection-manual__chips">
            <StatusChip :text="taskStateText_" :tone="stateTone" />
            <StatusChip :text="`已完成 ${task?.progress ?? 0}%`" tone="neutral" />
            <StatusChip :text="`异常 ${task?.abnormalItems ?? 0} 项`" tone="neutral" />
          </div>
          <KeyValuePanel :items="infoItems" />
          <p v-if="blockedText" class="w-inspection-manual__error" role="alert">
            {{ `${blockedText}补录只对已完成的巡检任务开放，请先把任务做完再回来补录。` }}
          </p>
        </StateHost>
      </div>
    </SectionBlock>

    <SectionBlock :title="`补录明细（${rows.length} 行）`">
      <div class="w-inspection-manual__stack">
        <div v-for="(row, index) in rows" :key="row.key" class="w-inspection-manual__card">
          <div class="w-inspection-manual__row">
            <StatusChip :text="`第 ${index + 1} 行`" tone="neutral" />
            <span class="w-inspection-manual__hint">扫码枪扫标签，或手动输入编号</span>
            <ElButton size="large" type="danger" :disabled="busy" @click="removeRow(row.key)">删除该行</ElButton>
          </div>
          <p class="w-inspection-manual__label">NFC 编号 *</p>
          <ElInput
            :key="`rfid-${row.key}`"
            :ref="(el: unknown) => setRowInput(row.key, el)"
            :model-value="row.rfid"
            size="large"
            class="w-inspection-manual__id-input"
            placeholder="扫码或手输，如：E2003412012345"
            @update:model-value="(value: string) => updateRow(row.key, { rfid: value })"
            @keydown.enter.prevent="addRow"
          />
          <p v-if="row.rfid.trim() === '' && tried" class="w-inspection-manual__field-error" role="alert">
            这一行还缺 NFC 编号，扫一下标签或手动输入
          </p>
          <div class="w-inspection-manual__row">
            <ElButton size="large" @click="toggleExtra(row.key)">
              {{ isExpanded(row.key) ? '收起 TID / 备注' : '补充 TID / 备注' }}
            </ElButton>
          </div>
          <div v-if="isExpanded(row.key)" class="w-inspection-manual__stack">
            <p class="w-inspection-manual__label">TID（选填）</p>
            <ElInput
              :model-value="row.tid"
              size="large"
              class="w-inspection-manual__id-input"
              placeholder="扫到的 TID，没有就留空"
              @update:model-value="(value: string) => updateRow(row.key, { tid: value })"
            />
            <p class="w-inspection-manual__label">备注（选填）</p>
            <ElInput
              :model-value="row.remark"
              size="large"
              placeholder="如：标签破损，人工确认"
              @update:model-value="(value: string) => updateRow(row.key, { remark: value })"
            />
          </div>
        </div>
      </div>

      <div class="w-inspection-manual__row">
        <ElButton size="large" :disabled="busy" @click="addRow">新增一行</ElButton>
        <ElButton size="large" :disabled="busy" @click="clearRows">清空全部</ElButton>
      </div>

      <!-- 不拦提交的提醒：服务端不做去重，重复扫到的标签只会静默多算一条 -->
      <p v-if="duplicateRfids.length > 0" class="w-inspection-manual__warn" role="status">
        {{ `以下 NFC 编号出现了多次：${duplicateRfids.join('、')}。请确认不是把同一张标签扫了两遍。` }}
      </p>
    </SectionBlock>

    <ActionDock>
      <!-- 按钮为什么不能点，就写在按钮旁边 -->
      <span class="w-inspection-manual__hint">{{ gateText ?? `${rows.length} 行 · ${missingRows.length} 行待扫` }}</span>
      <ElButton size="large" type="primary" :loading="busy" :disabled="busy || !canRecord" @click="openConfirm">
        {{ busy ? '提交中…' : '提交补录' }}
      </ElButton>
    </ActionDock>

    <ConfirmDialog
      :show="pending"
      title="提交补录明细"
      :danger="true"
      confirm-text="确认补录"
      :pending="busy"
      @confirm="submit"
      @cancel="pending = false"
    >
      <p class="w-inspection-manual__confirm">
        {{ `将把 ${rows.length} 条明细补录到任务 ${typedTaskId !== undefined ? typedTaskId : '未填'}。` }}
      </p>
      <p class="w-inspection-manual__hint">{{ `待补录：${previewText}` }}</p>
      <p class="w-inspection-manual__hint">
        补录会把这些标签计入该任务的盘点明细，可能改变它的账实差异。此操作不可撤销。
      </p>
      <p v-if="actionError" class="w-inspection-manual__error" role="alert">{{ actionError }}</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.w-inspection-manual__stack {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-group-gap);
}

.w-inspection-manual__card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-inspection-manual__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  margin-top: var(--w-space-inline-gap);
}

.w-inspection-manual__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  margin-bottom: var(--w-space-group-gap);
}

.w-inspection-manual__label {
  margin: var(--w-space-inline-gap) 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-label-medium-size);
  font-weight: var(--w-type-label-medium-weight);
}

/* NFC / TID 是机器数据：等宽 + 表格数字，避免 0/O、1/l 误读 */
.w-inspection-manual__id-input {
  width: 100%;
  font-family: var(--w-font-mono);
}

.w-inspection-manual__hint {
  margin: 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-manual__field-error {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-manual__error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-inspection-manual__warn {
  margin: var(--w-space-inline-gap) 0 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-warning-text);
  background: var(--w-state-warning-fill);
  color: var(--w-state-warning-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-inspection-manual__notice {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface);
  font-size: var(--w-type-body-size);
}

.w-inspection-manual__confirm {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}
</style>

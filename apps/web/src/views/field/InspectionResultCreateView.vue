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
  SectionBlock,
  StateHost,
  StatusChip,
  type KeyValueItem,
  type StatusTone,
} from '@wise/ui';
import { taskStateOf, taskStateText, type TaskState } from './inspectionState.js';

/**
 * 录入巡检结果 —— 现场域巡检的「写」入口：把这次盘点的数量记到任务上。
 * 语义逐条对齐 `packages/features/src/field/InspectionResultCreateScreen.tsx`。
 *
 * 四条从 React 版带过来的决定（都对应踩过的坑，不是新设计）：
 *
 * 1. **不让操作员做算术**：界面上填「应有总数 / 实扫数量 / 其中正常 / 盘亏 / 盘盈」，
 *    「异常」作为只读派生值显示为 `实扫 − 正常`。这是刻意的 —— 后台按
 *    `实扫 = 正常 + 异常` 记账，让操作员自己算一个"异常"出来，
 *    就是让他在现场做一道减法题，而现场最贵的是时间和手。
 * 2. **会算错的地方当场拦住**：`实扫 < 正常` 时异常会是负数，这在业务上不可能，
 *    此时禁止提交并说明原因；任一计数为负、或不是整数，同样禁止提交。
 * 3. **二次确认里把数字再说一遍**：入账不可撤销，确认框不是"点一下"的过场，
 *    而是让他再核对一次任务与数量。
 * 4. **没有任务序号就不取数**：带缺参的请求到后端必然被拒，白白占一次往返，
 *    日志里还会看着像"这一屏一直在报错"（`useResource` 的 `enabled` 就是为此存在）。
 *
 * 一处**真后端契约的事实**（`BridgeContract`：`inspection.resultCreate` 是 `paramStyle: 'query'`）：
 * 六个计数走查询串而不是请求体，所以这里只把值交给 `useMutation` —— **位置由桥按契约拼**，
 * 视图里不要自己拼 URL、也不要传 `null`/空字符串冒充"没填"（服务端按非负整数解析）。
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
  readonly normalItems?: number;
}

/** 一次提交的完整摘要：服务端回传的编号 + 操作员填的数量（回传缺项时不给空）。 */
interface SubmittedSummary {
  readonly resultId: number | undefined;
  /** 服务端认的落点任务（它回传了就以它为准，没回传就是操作员填的那个）。 */
  readonly taskId: number;
  readonly compareTime: string | undefined;
  readonly total: number;
  readonly inspected: number;
  readonly normal: number;
  readonly abnormal: number;
  readonly missing: number;
  readonly extra: number;
}

type CountParse =
  | { readonly kind: 'ok'; readonly value: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'notInteger' }
  | { readonly kind: 'negative' };

function hasContent(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/** 详情接口两种形状都出现过：直接给对象，或包一层列表。两种都接住。 */
function taskSummaryOf(value: unknown): TaskSummary | undefined {
  if (!hasContent(value)) {
    return undefined;
  }
  const first = asList<TaskSummary>(value)[0];
  return first !== undefined ? first : (value as TaskSummary);
}

/** 序号解析：空 = 还没填，正整数 = 可用，其余都是"填错了"。 */
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

/** 计数解析：空 = 还没填，非负整数 = 可用，其余分成"不是整数"和"负数"两种说法。 */
function parseCount(raw: string): CountParse {
  const text = raw.trim();
  if (text === '') {
    return { kind: 'empty' };
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { kind: 'notInteger' };
  }
  if (parsed < 0) {
    return { kind: 'negative' };
  }
  return { kind: 'ok', value: parsed };
}

function countErrorText(parsed: CountParse, label: string): string | undefined {
  switch (parsed.kind) {
    case 'empty':
      return `请填写${label}，没有就填 0`;
    case 'notInteger':
      return `${label}要填 0 或正整数，不要带单位或小数点`;
    case 'negative':
      return `${label}不能是负数，请核对现场数据`;
    case 'ok':
      return undefined;
  }
}

function countText(parsed: CountParse): string {
  return parsed.kind === 'ok' ? String(parsed.value) : '—';
}

/**
 * 从入账返回里读出结果序号与比对时间；读不到不是失败，界面上会给出兜底说法。
 *
 * 字段名做兜底（`resultId` / `id`、`compareTime` / `createTime`）是**刻意**的：
 * 返回形状一旦不同，这一屏就只剩"提交成功了"这一句空话。
 */
function resultSummaryOf(value: unknown): { resultId: number | undefined; taskId: number | undefined; compareTime: string | undefined } | undefined {
  if (!hasContent(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nested = record['data'] ?? record['result'];
  const source =
    nested !== undefined && nested !== null && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : record;
  const rawId = source['resultId'] ?? source['id'];
  const rawTaskId = source['taskId'];
  const rawTime = source['compareTime'] ?? source['createTime'];
  const resultId = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : undefined;
  const taskId = typeof rawTaskId === 'number' && Number.isFinite(rawTaskId) ? rawTaskId : undefined;
  const compareTime = typeof rawTime === 'string' && rawTime.trim() !== '' ? rawTime : undefined;
  return resultId === undefined && taskId === undefined && compareTime === undefined
    ? undefined
    : { resultId, taskId, compareTime };
}

const route = useRoute();
const router = useRouter();

/** 从任务详情 / 结果列表推进来时带 `?taskId=`：带上就直接查这个任务，少一次手输。 */
const queryTaskId = ((): number | undefined => {
  const raw = route.query['taskId'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  return typeof text === 'string' ? parseId(text).id : undefined;
})();

const taskInput = ref(queryTaskId === undefined ? '' : String(queryTaskId));
const taskError = ref<string | undefined>(undefined);
const totalInput = ref('');
const inspectedInput = ref('');
const normalInput = ref('');
const missingInput = ref('');
const extraInput = ref('');
const pending = ref(false);
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);
const submitted = ref<SubmittedSummary | undefined>(undefined);

const typedTaskId = computed(() => parseId(taskInput.value).id);
/** 真正提交用的是"上次点过查询"的那个任务（`selectedId`），输入框里的 `typedTaskId` 只是回的显。 */
const selectedId = ref<number | undefined>(queryTaskId);
const hasTask = computed(() => selectedId.value !== undefined);

/** 参数没准备好时用 `enabled` 表达，**不要**拿 `params === undefined` 兼表两义。 */
const taskParams = computed<Record<string, unknown>>(() =>
  selectedId.value === undefined ? {} : { taskId: selectedId.value },
);

const {
  data: taskData,
  loading: taskLoading,
  error: taskError_,
  reload: reloadTask,
} = useResource<unknown>('inspection.taskDetail', taskParams, { enabled: hasTask });

const task = computed(() => taskSummaryOf(taskData.value));
const taskState = computed<TaskState>(() => (task.value === undefined ? 'unknown' : taskStateOf(task.value)));
const taskStateText_ = computed(() => (task.value === undefined ? '' : taskStateText(task.value)));

const total = computed(() => parseCount(totalInput.value));
const inspected = computed(() => parseCount(inspectedInput.value));
const normal = computed(() => parseCount(normalInput.value));
const missing = computed(() => parseCount(missingInput.value));
const extra = computed(() => parseCount(extraInput.value));

/** 异常 = 实扫 − 正常：由后台的记账口径反推出来的派生值，不让操作员填。 */
const abnormal = computed<number | undefined>(() =>
  inspected.value.kind === 'ok' && normal.value.kind === 'ok' ? inspected.value.value - normal.value.value : undefined,
);
const abnormalTooSmall = computed(() => abnormal.value !== undefined && abnormal.value < 0);
/**
 * 「实扫 < 正常」的**字段级**提示。
 *
 * 渲染位置跟 React 一致（「数量汇总」卡片里、紧挨着"异常（自动算出）"下面）：
 * 那里是操作员唯一能看到"异常 = 实扫 − 正常"这个算式的地方，
 * 错误信息摆在算式旁边，比挂在上面的数字输入框下面更容易当场改对。
 *
 * 两句文案是**两个层级、不矛盾**（React 原文）：
 *  · 字段级（这里）：说清"错在哪、为什么"，让人当场把数字改对；
 *  · 提交级（`openConfirm` / `submit` 里的 `actionError`）：只有一句简短的交待，
 *    因为此时人已经点过提交、只需要知道"就是这两个数的问题"。
 * 所以不要把它们合并成一句，也不要两处都塞同一句。
 */
const abnormalError = computed(() =>
  abnormalTooSmall.value
    ? '实扫数量比其中正常还少，异常件数会变成负数。请核对这两个数：正常一定是实扫的一部分。'
    : undefined,
);

const countsReady = computed(
  () =>
    total.value.kind === 'ok' &&
    inspected.value.kind === 'ok' &&
    normal.value.kind === 'ok' &&
    missing.value.kind === 'ok' &&
    extra.value.kind === 'ok',
);
const formReady = computed(() => hasTask.value && countsReady.value && !abnormalTooSmall.value);

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

/** 状态芯片语气与现场域其它屏保持一致（done 绿 / running 橙 / paused 灰 / 其余灰）。 */
const stateTone = computed<StatusTone>(() => {
  switch (taskState.value) {
    case 'done':
      return 'success';
    case 'running':
      return 'warning';
    default:
      return 'neutral';
  }
});

const taskEmptyText = computed(() =>
  hasTask.value
    ? '没有找到这个任务。请核对任务序号，或先到「巡检任务」里确认任务已经建好。'
    : '还没有填任务序号。填上本次盘点的任务序号，这里会显示它的信息。',
);

const createMutation = useMutation<unknown>('inspection.resultCreate');
const busy = computed(() => createMutation.pending.value);

/** 按序号换任务：路由参数只是"第一次进来时的默认值"，之后以输入框为准。 */
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

/** 打开二次确认前的三道闸门：没有任务、数量没填好、实扫小于正常，都在这里说清楚。 */
function openConfirm(): void {
  if (selectedId.value === undefined) {
    actionError.value = '请先填写任务序号，再提交巡检结果。';
    return;
  }
  if (!countsReady.value) {
    actionError.value = '还有没填好或填错的数量，请按字段下方的提示改正后再提交。';
    return;
  }
  if (abnormalTooSmall.value) {
    // 提交级短句：字段下面已经用长句解释了原因，这里只交待"就是这两个数的问题"
    actionError.value = '实扫数量不能小于其中正常，请先核对这两个数。';
    return;
  }
  actionError.value = undefined;
  pending.value = true;
}

async function submit(): Promise<void> {
  pending.value = false;
  const id = selectedId.value;
  const totalParsed = total.value;
  const inspectedParsed = inspected.value;
  const normalParsed = normal.value;
  const missingParsed = missing.value;
  const extraParsed = extra.value;
  if (
    id === undefined ||
    totalParsed.kind !== 'ok' ||
    inspectedParsed.kind !== 'ok' ||
    normalParsed.kind !== 'ok' ||
    missingParsed.kind !== 'ok' ||
    extraParsed.kind !== 'ok'
  ) {
    actionError.value = '还有没填好或填错的数量，请按字段下方的提示改正后再提交。';
    return;
  }
  /*
   * 异常在这里再算一遍（而不是读 `abnormal`）：
   * 上面已把五个计数收成局部常量，重新算一次比依赖 computed 的时序更直白，
   * 也保证"提交的数字"与"确认框里展示的数字"来自同一份值。
   */
  const abnormalValue = inspectedParsed.value - normalParsed.value;
  if (abnormalValue < 0) {
    // 与 `openConfirm` 同一句提交级短句：确认框开着时数据被改动，也要给同一条交待
    actionError.value = '实扫数量不能小于其中正常，请先核对这两个数。';
    return;
  }
  actionError.value = undefined;
  notice.value = undefined;
  try {
    /*
     * 六个计数（含 taskId）都是**查询参数**：契约 `paramStyle: 'query'`，
     * 位置由桥拼，视图只负责给值。`abnormalItems` 是推导值，不让操作员填。
     */
    const value = await createMutation.run({
      taskId: id,
      totalItems: totalParsed.value,
      normalItems: normalParsed.value,
      abnormalItems: abnormalValue,
      missingItems: missingParsed.value,
      extraItems: extraParsed.value,
    });
    const server = resultSummaryOf(value);
    submitted.value = {
      resultId: server?.resultId,
      // 服务端回传了落点任务就以它为准：它才是真正被记上账的那个任务
      taskId: server?.taskId ?? id,
      compareTime: server?.compareTime,
      total: totalParsed.value,
      inspected: inspectedParsed.value,
      normal: normalParsed.value,
      abnormal: abnormalValue,
      missing: missingParsed.value,
      extra: extraParsed.value,
    };
    notice.value = '巡检结果已记账：任务标记为已完成，盘点数量与差异已成为账实结论。';
    /*
     * 入账会把任务置为已完成并写回各计数（真后端 `InspectionApplicationService`），
     * 所以**必须重新拉任务详情**，否则上面那张任务卡片还是入账前的数字。
     */
    reloadTask();
  } catch (e) {
    actionError.value = humanize(e as BridgeErrorLike);
  }
}

function goResultList(): void {
  const id = selectedId.value;
  if (id === undefined) {
    return;
  }
  void router.push({ name: 'inspection.resultList', query: { taskId: String(id) } });
}

/**
 * Element Plus 的属性整块给、且放宽成 `any`。
 *
 * `ElInput` 的 props 类型在 `vue-tsc` 下解不开，逐属性写会被当成"属性定义对象"校验而报错。
 * 运行期完全一样 —— 这是**类型层绕行**，不是行为差异。
 */
function anyProps(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}

/** 计数输入框：数字键盘 + 等宽（现场多数是带数字键盘的平板，数量要纵向对齐才好核对）。 */
function countFieldProps(label: string): Record<string, unknown> {
  return {
    size: 'large',
    clearable: true,
    inputmode: 'numeric',
    'aria-label': label,
    class: 'w-inspection-result-create__count-input',
  };
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="录入巡检结果" note="把这次盘点的数量记到对应的巡检任务上；提交后任务即完成，差异不可撤销">
      <template #actions>
        <ElButton size="large" :disabled="!hasTask || busy" :loading="taskLoading" @click="reloadTask">刷新</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError" class="w-inspection-result-create__error" role="alert">{{ actionError }}</p>

    <SectionBlock v-if="submitted" title="提交结果">
      <div class="w-inspection-result-create__card">
        <p class="w-inspection-result-create__notice" role="status">
          {{ notice ?? '巡检结果已记账。' }}
        </p>
        <KeyValuePanel
          :items="[
            { key: 'resultId', label: '结果序号', value: submitted.resultId !== undefined ? String(submitted.resultId) : '后台没有回传', mono: true },
            { key: 'taskId', label: '计入任务', value: String(submitted.taskId), mono: true },
            { key: 'compareTime', label: '比对时间', value: submitted.compareTime ? shortTime(submitted.compareTime) : '后台没有回传比对时间', mono: true },
            { key: 'total', label: '应有总数', value: String(submitted.total), mono: true },
            { key: 'inspected', label: '实扫数量', value: String(submitted.inspected), mono: true },
            { key: 'normal', label: '其中正常', value: String(submitted.normal), mono: true },
            { key: 'abnormal', label: '异常', value: String(submitted.abnormal), mono: true },
            { key: 'missing', label: '盘亏（少了）', value: String(submitted.missing), mono: true },
            { key: 'extra', label: '盘盈（多了）', value: String(submitted.extra), mono: true },
          ]"
        />
        <p class="w-inspection-result-create__hint">
          需要复核或导出报表，请到「巡检结果」里按结果序号或任务序号查看。
        </p>
        <ElButton size="large" type="primary" @click="goResultList">查看巡检结果</ElButton>
      </div>
    </SectionBlock>

    <SectionBlock title="记到哪个任务">
      <div class="w-inspection-result-create__card">
        <p class="w-inspection-result-create__label">任务序号 *</p>
        <div class="w-inspection-result-create__row">
          <ElInput
            v-model="taskInput"
            v-bind="anyProps({ size: 'large', clearable: true, inputmode: 'numeric', class: 'w-inspection-result-create__id-input', placeholder: '如：501' })"
            @keydown.enter="openTask"
          />
          <ElButton size="large" @click="openTask">查询</ElButton>
        </div>
        <p v-if="taskError" class="w-inspection-result-create__field-error" role="alert">{{ taskError }}</p>
        <p class="w-inspection-result-create__hint">
          任务序号决定这份结果记到哪个任务上。填错会把盘点数据记到别的任务里，提交前请核对下面这张卡片。
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
          <div class="w-inspection-result-create__chips">
            <StatusChip :text="taskStateText_" :tone="stateTone" />
            <StatusChip :text="`已完成 ${task?.progress ?? 0}%`" tone="neutral" />
          </div>
          <KeyValuePanel :items="infoItems" />
          <p v-if="taskState === 'done'" class="w-inspection-result-create__hint">
            这个任务已经记过一次盘点结果。再次提交会把它的盘点数量更新成这次填的值，请确认这是复核后的正确数据。
          </p>
        </StateHost>
      </div>
    </SectionBlock>

    <SectionBlock title="本次盘点数量">
      <div class="w-inspection-result-create__card">
        <div class="w-inspection-result-create__field">
          <p class="w-inspection-result-create__label">应有总数 *</p>
          <ElInput v-model="totalInput" v-bind="anyProps(countFieldProps('应有总数'))" placeholder="如：200" />
          <p v-if="countErrorText(total, '应有总数')" class="w-inspection-result-create__field-error" role="alert">
            {{ countErrorText(total, '应有总数') }}
          </p>
          <p class="w-inspection-result-create__hint">仓库账面上，这个任务应该有多少件。</p>
        </div>

        <div class="w-inspection-result-create__field">
          <p class="w-inspection-result-create__label">实扫数量 *</p>
          <ElInput v-model="inspectedInput" v-bind="anyProps(countFieldProps('实扫数量'))" placeholder="如：198" />
          <p v-if="countErrorText(inspected, '实扫数量')" class="w-inspection-result-create__field-error" role="alert">
            {{ countErrorText(inspected, '实扫数量') }}
          </p>
          <p class="w-inspection-result-create__hint">这次现场实际扫到的件数。它等于「其中正常」加上异常件数。</p>
        </div>

        <div class="w-inspection-result-create__field">
          <p class="w-inspection-result-create__label">其中正常 *</p>
          <ElInput v-model="normalInput" v-bind="anyProps(countFieldProps('其中正常'))" placeholder="如：190" />
          <p v-if="countErrorText(normal, '其中正常')" class="w-inspection-result-create__field-error" role="alert">
            {{ countErrorText(normal, '其中正常') }}
          </p>
          <p class="w-inspection-result-create__hint">实扫到的件数里，账实相符的件数。</p>
        </div>

        <div class="w-inspection-result-create__field">
          <p class="w-inspection-result-create__label">盘亏 *</p>
          <ElInput v-model="missingInput" v-bind="anyProps(countFieldProps('盘亏'))" placeholder="如：2" />
          <p v-if="countErrorText(missing, '盘亏')" class="w-inspection-result-create__field-error" role="alert">
            {{ countErrorText(missing, '盘亏') }}
          </p>
          <p class="w-inspection-result-create__hint">账面上有、这次没扫到的件数；没有就填 0。</p>
        </div>

        <div class="w-inspection-result-create__field">
          <p class="w-inspection-result-create__label">盘盈 *</p>
          <ElInput v-model="extraInput" v-bind="anyProps(countFieldProps('盘盈'))" placeholder="如：0" />
          <p v-if="countErrorText(extra, '盘盈')" class="w-inspection-result-create__field-error" role="alert">
            {{ countErrorText(extra, '盘盈') }}
          </p>
          <p class="w-inspection-result-create__hint">不在账面上、这次却扫到的件数；没有就填 0。</p>
        </div>
      </div>
    </SectionBlock>

    <SectionBlock title="数量汇总">
      <div class="w-inspection-result-create__card">
        <div class="w-inspection-result-create__row">
          <span class="w-inspection-result-create__label">异常（自动算出）</span>
          <StatusChip
            :text="abnormal === undefined ? '填好实扫与其中正常后自动算出' : String(abnormal)"
            :tone="abnormalTooSmall ? 'danger' : 'neutral'"
          />
        </div>
        <p class="w-inspection-result-create__hint">
          异常不用手填：后台按「实扫 = 其中正常 + 异常」记账，这里按「实扫 − 正常」自动算出。异常件数不能是负数。
        </p>
        <p v-if="abnormalError" class="w-inspection-result-create__error" role="alert">{{ abnormalError }}</p>
      </div>
    </SectionBlock>

    <!-- 主操作钉在底部：表单滚多长都不用找它 -->
    <ActionDock>
      <!-- 按钮为什么不能点，就写在按钮旁边：现场不会去猜一个灰掉的按钮 -->
      <span class="w-inspection-result-create__hint">
        {{ `计入任务 ${hasTask ? selectedId : '未填'} · 异常 ${abnormal !== undefined ? abnormal : '—'} 件` }}
      </span>
      <span v-if="!hasTask" class="w-inspection-result-create__hint">还缺任务序号：填上并点「查询」后才能提交。</span>
      <span v-else-if="!countsReady" class="w-inspection-result-create__hint">还有数量没填好，按字段下方的提示改正后可提交。</span>
      <span v-else-if="abnormalTooSmall" class="w-inspection-result-create__hint">
        实扫数量比其中正常还少，先核对「实扫数量」和「其中正常」这两个数。
      </span>
      <ElButton
        size="large"
        type="primary"
        :loading="busy"
        :disabled="busy || !formReady"
        aria-label="提交巡检结果"
        @click="openConfirm"
      >
        {{ busy ? '提交中…' : '提交结果' }}
      </ElButton>
    </ActionDock>

    <ConfirmDialog
      :show="pending"
      title="提交巡检结果"
      :danger="true"
      confirm-text="确认入账"
      :pending="busy"
      @confirm="submit"
      @cancel="pending = false"
    >
      <p class="w-inspection-result-create__confirm">
        {{
          `把任务 ${selectedId !== undefined ? selectedId : '未填'} 记成：应有 ${countText(total)} 件，实扫 ${countText(
            inspected,
          )} 件，其中正常 ${countText(normal)} 件，异常 ${abnormal !== undefined ? abnormal : '—'} 件，盘亏 ${countText(
            missing,
          )} 件，盘盈 ${countText(extra)} 件。`
        }}
      </p>
      <p class="w-inspection-result-create__hint">
        提交后任务会标记为已完成，盘点数量与差异成为账实结论，并可能触发库存调整。此操作不可撤销。
      </p>
      <p v-if="actionError" class="w-inspection-result-create__error" role="alert">{{ actionError }}</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.w-inspection-result-create__card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-inspection-result-create__field {
  padding: var(--w-space-list-item-v) 0;
  border-bottom: 1px solid var(--w-color-outline-subtle);
}

.w-inspection-result-create__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
}

.w-inspection-result-create__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  margin-bottom: var(--w-space-group-gap);
}

.w-inspection-result-create__label {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-label-medium-size);
  font-weight: var(--w-type-label-medium-weight);
}

/* 序号与数量都是机器数据：等宽 + 表格数字，避免 0/O、1/l 误读 */
.w-inspection-result-create__id-input,
.w-inspection-result-create__count-input {
  width: 100%;
  font-family: var(--w-font-mono);
}

.w-inspection-result-create__hint {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-result-create__field-error {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-result-create__error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-inspection-result-create__notice {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface);
  font-size: var(--w-type-body-size);
}

.w-inspection-result-create__confirm {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}
</style>

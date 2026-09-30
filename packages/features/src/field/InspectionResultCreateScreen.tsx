import { useState } from 'react';
import {
  BottomActionBar,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  Dot,
  Field,
  Input,
  KeyValue,
  ListStateHost,
  Mono,
  PageHeader,
  Section,
  Stack,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, humanize, shortTime } from '../shared/api.js';

/**
 * 录入巡检结果（field/inspection 的"写"入口之一）。
 *
 * 这一屏是**不可逆的入账动作**：提交后任务被标记为已完成、盘点数量写进任务、
 * 差异成为账实结论。因此它做了三件事：
 *
 * 1. **不让操作员做算术**：界面上填「应有总数 / 实扫数量 / 其中正常 / 盘亏 / 盘盈」，
 *    「异常」作为只读派生值显示为 `实扫 − 正常`。这是刻意的 —— 后台按
 *    `实扫 = 正常 + 异常` 记账，让操作员自己算一个"异常"出来，
 *    就是让他在现场做一道减法题，而现场最贵的是时间和手。
 * 2. **会算错的地方当场拦住**：`实扫 < 正常` 时异常会是负数，这在业务上不可能，
 *    此时禁止提交并说明原因；任一计数为负、或不是整数，同样禁止提交。
 * 3. **二次确认里把数字再说一遍**：入账不可撤销，确认框不是"点一下"的过场，
 *    而是让他再核对一次任务与数量（ui-spec §3.1）。
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

type TaskState = 'pending' | 'running' | 'done' | 'paused' | 'unknown';

/**
 * 任务状态归一化 —— 与「巡检任务详情」屏同一套口径（先看状态名，再看状态码）。
 * 同一件事在同一个域里必须只有一种解释，否则两屏对同一个任务会给出不同结论。
 */
function stateOf(task: TaskSummary | undefined): TaskState {
  const desc = task?.statusDesc ?? '';
  if (desc.includes('完成')) {
    return 'done';
  }
  if (desc.includes('进行') || desc.includes('执行中')) {
    return 'running';
  }
  if (desc.includes('暂停') || desc.includes('中止')) {
    return 'paused';
  }
  switch (task?.status) {
    case 0:
      return 'pending';
    case 1:
      return 'running';
    case 2:
      return 'done';
    case 3:
      return 'paused';
    default:
      return 'unknown';
  }
}

function stateText(task: TaskSummary | undefined): string {
  if (task?.statusDesc) {
    return task.statusDesc;
  }
  switch (stateOf(task)) {
    case 'pending':
      return '待开始';
    case 'running':
      return '进行中';
    case 'done':
      return '已完成';
    case 'paused':
      return '已暂停';
    default:
      return '状态未上报';
  }
}

function StateChip({ task }: { task: TaskSummary | undefined }): React.ReactElement {
  const state = stateOf(task);
  if (state === 'done') {
    return (
      <Chip tone="ok">
        <Dot tone="ok" />
        {stateText(task)}
      </Chip>
    );
  }
  if (state === 'running') {
    return (
      <Chip tone="info">
        <Dot tone="ok" />
        {stateText(task)}
      </Chip>
    );
  }
  if (state === 'paused') {
    return (
      <Chip tone="danger">
        <Dot tone="bad" />
        {stateText(task)}
      </Chip>
    );
  }
  return (
    <Chip tone="neutral">
      <Dot tone="idle" />
      {stateText(task)}
    </Chip>
  );
}

function hasContent(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

function taskSummaryOf(value: unknown): TaskSummary | undefined {
  if (!hasContent(value)) {
    return undefined;
  }
  const list = asList<TaskSummary>(value);
  return list.length > 0 ? list[0] : (value as TaskSummary);
}

type IdParse =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ok'; readonly id: number }
  | { readonly kind: 'invalid' };

function parseId(raw: string): IdParse {
  const text = raw.trim();
  if (text === '') {
    return { kind: 'empty' };
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', id: parsed };
}

type CountParse =
  | { readonly kind: 'ok'; readonly value: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'notInteger' }
  | { readonly kind: 'negative' };

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

interface ResultSummary {
  readonly resultId: number | undefined;
  readonly taskId: number | undefined;
  readonly compareTime: string | undefined;
}

function numberIn(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function stringIn(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

/** 从入账返回里读出结果序号与比对时间；读不到不是失败，界面上会给出兜底说法。 */
function resultSummaryOf(value: unknown): ResultSummary | undefined {
  if (!hasContent(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nested = record['data'] ?? record['result'];
  const source =
    nested !== undefined && nested !== null && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : record;
  const summary: ResultSummary = {
    resultId: numberIn(source, ['resultId', 'id']),
    taskId: numberIn(source, ['taskId']),
    compareTime: stringIn(source, ['compareTime', 'createTime']),
  };
  return summary.resultId === undefined && summary.compareTime === undefined ? undefined : summary;
}

/** 本次提交的完整摘要：服务端回传的编号 + 操作员填的数量（回传缺项时不给空）。 */
interface SubmittedSummary {
  readonly resultId: number | undefined;
  readonly taskId: number;
  readonly compareTime: string | undefined;
  readonly total: number;
  readonly inspected: number;
  readonly normal: number;
  readonly abnormal: number;
  readonly missing: number;
  readonly extra: number;
}

/** 一个计数输入 + 它的业务解释（现场最常问的是"这个数到底指什么"）。 */
function CountField({
  label,
  hint,
  placeholder,
  value,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}): React.ReactElement {
  return (
    <Stack tight>
      <Field label={label} error={error}>
        <Input value={value} onChange={onChange} placeholder={placeholder} mono ariaLabel={label} />
      </Field>
      <span className="w-muted">{hint}</span>
    </Stack>
  );
}

export function InspectionResultCreateScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [taskInput, setTaskInput] = useState('');
  const [totalInput, setTotalInput] = useState('');
  const [inspectedInput, setInspectedInput] = useState('');
  const [normalInput, setNormalInput] = useState('');
  const [missingInput, setMissingInput] = useState('');
  const [extraInput, setExtraInput] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState<SubmittedSummary | undefined>(undefined);

  const taskParsed = parseId(taskInput);
  const taskId = taskParsed.kind === 'ok' ? taskParsed.id : undefined;
  const hasTask = taskId !== undefined;

  // 没有任务序号就不取数：带缺参的请求到后端必然被拒，白白占一次往返，
  // 日志里还会看着像"这一屏一直在报错"（useBridgeCall 的 enabled 就是为此存在）。
  const taskCall = useBridgeCall<unknown>(
    bridge,
    'inspection.taskDetail',
    hasTask ? { taskId } : undefined,
    { enabled: hasTask },
  );
  const task = taskSummaryOf(taskCall.data);
  const taskState = stateOf(task);
  const taskError = taskParsed.kind === 'invalid' ? '任务序号要填大于 0 的整数，例如 501' : undefined;

  const total = parseCount(totalInput);
  const inspected = parseCount(inspectedInput);
  const normal = parseCount(normalInput);
  const missing = parseCount(missingInput);
  const extra = parseCount(extraInput);

  // 异常 = 实扫 − 正常：由后台的记账口径反推出来的派生值，不让操作员填
  const abnormal = inspected.kind === 'ok' && normal.kind === 'ok' ? inspected.value - normal.value : undefined;
  const abnormalTooSmall = abnormal !== undefined && abnormal < 0;
  const abnormalError = abnormalTooSmall
    ? '实扫数量比其中正常还少，异常件数会变成负数。请核对这两个数：正常一定是实扫的一部分。'
    : undefined;

  const countsReady =
    total.kind === 'ok' &&
    inspected.kind === 'ok' &&
    normal.kind === 'ok' &&
    missing.kind === 'ok' &&
    extra.kind === 'ok';
  const formReady = hasTask && countsReady && !abnormalTooSmall;

  const openConfirm = (): void => {
    if (taskId === undefined) {
      setActionError('请先填写任务序号，再提交巡检结果。');
      return;
    }
    if (!countsReady) {
      setActionError('还有没填好或填错的数量，请按字段下方的提示改正后再提交。');
      return;
    }
    if (abnormalTooSmall) {
      setActionError('实扫数量不能小于其中正常，请先核对这两个数。');
      return;
    }
    setActionError(undefined);
    setPending(true);
  };

  const submit = async (): Promise<void> => {
    setPending(false);
    if (taskId === undefined || total.kind !== 'ok' || inspected.kind !== 'ok' || normal.kind !== 'ok' || missing.kind !== 'ok' || extra.kind !== 'ok') {
      setActionError('还有没填好或填错的数量，请按字段下方的提示改正后再提交。');
      return;
    }
    const abnormalValue = inspected.value - normal.value;
    if (abnormalValue < 0) {
      setActionError('实扫数量不能小于其中正常，请先核对这两个数。');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      const value = await bridge.call<unknown>('inspection.resultCreate', {
        taskId,
        totalItems: total.value,
        normalItems: normal.value,
        abnormalItems: abnormalValue,
        missingItems: missing.value,
        extraItems: extra.value,
      });
      const server = resultSummaryOf(value);
      setSubmitted({
        resultId: server?.resultId,
        taskId: server?.taskId ?? taskId,
        compareTime: server?.compareTime,
        total: total.value,
        inspected: inspected.value,
        normal: normal.value,
        abnormal: abnormalValue,
        missing: missing.value,
        extra: extra.value,
      });
      setNotice('巡检结果已记账：任务标记为已完成，盘点数量与差异已成为账实结论。');
      taskCall.reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="录入巡检结果"
        subtitle="把这次盘点的数量记到对应的巡检任务上；提交后任务即完成，差异不可撤销"
        actions={
          <Button ariaLabel="刷新任务信息" disabled={!hasTask || busy} onClick={taskCall.reload}>
            刷新
          </Button>
        }
      />

      {actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      {submitted ? (
        <Section title="提交结果">
          <Card>
            <Stack tight>
              <span>{notice ?? '巡检结果已记账。'}</span>
              <KeyValue
                k="结果序号"
                v={<Mono>{submitted.resultId !== undefined ? String(submitted.resultId) : '后台没有回传'}</Mono>}
              />
              <KeyValue k="计入任务" v={<Mono>{String(submitted.taskId)}</Mono>} />
              <KeyValue k="应有总数" v={submitted.total} />
              <KeyValue k="实扫数量" v={submitted.inspected} />
              <KeyValue k="其中正常" v={submitted.normal} />
              <KeyValue k="异常" v={submitted.abnormal} />
              <KeyValue k="盘亏（少了）" v={submitted.missing} />
              <KeyValue k="盘盈（多了）" v={submitted.extra} />
              <KeyValue
                k="比对时间"
                v={submitted.compareTime ? shortTime(submitted.compareTime) : '后台没有回传比对时间'}
              />
              <span className="w-muted">
                需要复核或导出报表，请到「巡检结果」里按结果序号或任务序号查看。
              </span>
            </Stack>
          </Card>
        </Section>
      ) : null}

      <Section title="记到哪个任务">
        <Card>
          <Stack>
            <Field label="任务序号 *" error={taskError}>
              <Input value={taskInput} onChange={setTaskInput} placeholder="如：501" mono ariaLabel="任务序号 *" />
            </Field>
            <span className="w-muted">
              任务序号决定这份结果记到哪个任务上。填错会把盘点数据记到别的任务里，提交前请核对下面这张卡片。
            </span>
            <ListStateHost
              loading={taskCall.loading}
              error={taskCall.error ? { code: taskCall.error.code, text: humanize(taskCall.error) } : undefined}
              items={task ? [task] : []}
              emptyText={
                hasTask
                  ? '没有找到这个任务。请核对任务序号，或先到「巡检任务」里确认任务已经建好。'
                  : '还没有填任务序号。填上本次盘点的任务序号，这里会显示它的信息。'
              }
              onRetry={taskCall.reload}
            >
              {(items) => {
                const t = items[0];
                return (
                  <Stack tight>
                    <Toolbar>
                      <StateChip task={t} />
                      <span className="w-chip w-mono">{`已完成 ${t?.progress ?? 0}%`}</span>
                    </Toolbar>
                    <KeyValue k="任务号" v={<Mono>{t?.taskCode ?? '未登记'}</Mono>} />
                    <KeyValue k="巡检计划" v={t?.planName ?? '未关联计划'} />
                    <KeyValue k="执行仓库" v={<Mono>{t?.warehouseName ?? '未登记'}</Mono>} />
                    <KeyValue k="执行设备" v={t?.deviceName ?? '未指定设备'} />
                    <KeyValue k="已盘数量" v={`${t?.inspectedItems ?? 0} / 共 ${t?.totalItems ?? 0}`} />
                    {taskState === 'done' ? (
                      <span className="w-muted">
                        这个任务已经记过一次盘点结果。再次提交会把它的盘点数量更新成这次填的值，请确认这是复核后的正确数据。
                      </span>
                    ) : null}
                  </Stack>
                );
              }}
            </ListStateHost>
          </Stack>
        </Card>
      </Section>

      <Section title="本次盘点数量">
        <Stack>
          <CountField
            label="应有总数 *"
            hint="仓库账面上，这个任务应该有多少件。"
            placeholder="如：200"
            value={totalInput}
            onChange={setTotalInput}
            error={countErrorText(total, '应有总数')}
          />
          <CountField
            label="实扫数量 *"
            hint="这次现场实际扫到的件数。它等于「其中正常」加上异常件数。"
            placeholder="如：198"
            value={inspectedInput}
            onChange={setInspectedInput}
            error={countErrorText(inspected, '实扫数量')}
          />
          <CountField
            label="其中正常 *"
            hint="实扫到的件数里，账实相符的件数。"
            placeholder="如：190"
            value={normalInput}
            onChange={setNormalInput}
            error={countErrorText(normal, '其中正常')}
          />
          <CountField
            label="盘亏 *"
            hint="账面上有、这次没扫到的件数；没有就填 0。"
            placeholder="如：2"
            value={missingInput}
            onChange={setMissingInput}
            error={countErrorText(missing, '盘亏')}
          />
          <CountField
            label="盘盈 *"
            hint="不在账面上、这次却扫到的件数；没有就填 0。"
            placeholder="如：0"
            value={extraInput}
            onChange={setExtraInput}
            error={countErrorText(extra, '盘盈')}
          />
        </Stack>
      </Section>

      <Section title="数量汇总">
        <Card>
          <Stack tight>
            <KeyValue
              k="异常（自动算出）"
              v={<Mono>{abnormal === undefined ? '填好实扫与其中正常后自动算出' : String(abnormal)}</Mono>}
            />
            <span className="w-muted">
              异常不用手填：后台按「实扫 = 其中正常 + 异常」记账，这里按「实扫 − 正常」自动算出。异常件数不能是负数。
            </span>
            {abnormalError ? (
              <div className="w-state w-state--error">
                <span>{abnormalError}</span>
              </div>
            ) : null}
          </Stack>
        </Card>
      </Section>

      <BottomActionBar>
        <span className="w-muted w-mono">
          {`${hasTask ? `任务 ${taskId}` : '未填任务序号'} · 应盘 ${countText(total)} · 实扫 ${countText(inspected)}`}
        </span>
        <Button
          variant="primary"
          block
          ariaLabel="提交巡检结果"
          disabled={busy || !formReady}
          onClick={openConfirm}
        >
          {busy ? '提交中…' : '提交结果'}
        </Button>
      </BottomActionBar>

      <ConfirmDialog
        open={pending}
        title="提交巡检结果"
        danger
        confirmLabel="确认入账"
        message={
          <Stack>
            <span>
              {`把任务 ${taskId !== undefined ? taskId : '未填'} 记成：应有 ${countText(total)} 件，实扫 ${countText(
                inspected,
              )} 件，其中正常 ${countText(normal)} 件，异常 ${abnormal !== undefined ? abnormal : '—'} 件，盘亏 ${countText(
                missing,
              )} 件，盘盈 ${countText(extra)} 件。`}
            </span>
            <span className="w-muted">
              提交后任务会标记为已完成，盘点数量与差异成为账实结论，并可能触发库存调整。此操作不可撤销。
            </span>
            {actionError ? <span className="w-state w-state--error">{actionError}</span> : null}
          </Stack>
        }
        onConfirm={() => void submit()}
        onCancel={() => setPending(false)}
      />
    </Stack>
  );
}

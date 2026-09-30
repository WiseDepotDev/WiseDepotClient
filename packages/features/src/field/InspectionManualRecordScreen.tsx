import { useEffect, useRef, useState } from 'react';
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
import { asList, humanize } from '../shared/api.js';
import { taskStateOf, taskStateText, type TaskState } from './inspectionState.js';

/**
 * 手动补录巡检明细（field/inspection 的"写"入口之一）。
 *
 * 解决的是现场最常见的意外：**漏扫**。任务已经跑完，账面上却少了几个标签，
 * 这时需要把漏掉的 NFC 标签人工补进任务里。
 *
 * 四条刻意的选择：
 * 1. **一屏能连扫多行**：现场是拿扫码枪连续扫，焦点必须在"刚加的那一行的 NFC 输入框"上。
 *    因此每行只有 NFC 编号是常显的，TID 与备注收在「补充 TID / 备注」按钮后面
 *    （它们是少数情况才填的字段，常显会把一屏挤到只能看到两行）。
 *    行与行之间不用折叠 —— 展开哪一行是行自己记着的，不影响别的行。
 * 2. **删除是一颗真正的按钮**（触摸目标不小于 48），不是行尾的小叉：戴着手套点小图标点不中。
 * 3. **前置条件是"任务已完成"**：补录只对已完成的巡检任务开放，这一点在填一堆行之前就说清楚，
 *    而不是让操作员扫完十条再被后台拒绝。状态口径与「巡检任务详情」屏一致
 *    （先看状态名、再看状态码），同一个任务在同一个域里不允许有两种结论。
 * 4. **没填任务序号就不发任何请求**：没有目标时取任务信息、提交补录都是注定失败的往返。
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

/**
 * 任务状态归一化统一在 ./inspectionState.ts —— 现场域所有涉及任务状态的屏共用一份。
 *
 * 这屏原本有一份本地副本，而"同口径"靠的是人手同步；服务端 `statusDesc` 实测会给
 * 枚举原文（`COMPLETED`），本地副本无条件信任它，就把大写英文画到了界面上。
 * 共享模块的口径是「先翻译已知枚举 → 再信任中文描述 → 最后按状态码兜底」。
 */
function stateOf(task: TaskSummary | undefined): TaskState {
  return taskStateOf(task ?? {});
}

function stateText(task: TaskSummary | undefined): string {
  return taskStateText(task ?? {});
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

/** 补录表单的一行。`key` 只服务于渲染稳定性与"聚焦到刚加的那一行"。 */
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
  rfid: string;
  tid?: string;
  remark?: string;
}

/** 一行 → 一条补录明细。空的可选字段**不放进明细**，而不是发空字符串（后台要区分没填与填了空）。 */
function itemOf(row: RecordRow): ManualItem {
  const rfid = row.rfid.trim();
  const tid = row.tid.trim();
  const remark = row.remark.trim();
  const item: ManualItem = { rfid };
  if (tid !== '') {
    item.tid = tid;
  }
  if (remark !== '') {
    item.remark = remark;
  }
  return item;
}

function emptyRow(key: string): RecordRow {
  return { key, rfid: '', tid: '', remark: '' };
}

export function InspectionManualRecordScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [taskInput, setTaskInput] = useState('');
  const [rows, setRows] = useState<readonly RecordRow[]>(() => [emptyRow('row-1')]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const seq = useRef(1);
  const rowHosts = useRef(new Map<string, HTMLDivElement>());

  const taskParsed = parseId(taskInput);
  const taskId = taskParsed.kind === 'ok' ? taskParsed.id : undefined;
  const hasTask = taskId !== undefined;
  const taskError = taskParsed.kind === 'invalid' ? '任务序号要填大于 0 的整数，例如 501' : undefined;

  // 没有任务序号就不取数：补录的目标都没定，取回来的任务信息也没有意义
  const taskCall = useBridgeCall<unknown>(
    bridge,
    'inspection.taskDetail',
    hasTask ? { taskId } : undefined,
    { enabled: hasTask },
  );
  const task = taskSummaryOf(taskCall.data);
  const taskState = stateOf(task);

  // 前置条件：补录只对已完成的巡检任务开放。宁可在这里就拦住，也不要让操作员扫完十条才被拒
  const canRecord = hasTask && task !== undefined && taskState === 'done';
  const blockedText =
    hasTask && !taskCall.loading && task !== undefined && taskState !== 'done'
      ? `这个任务当前是「${stateText(task)}」。`
      : undefined;
  const gateText = !hasTask
    ? '请先填写任务序号'
    : taskCall.loading
      ? '正在确认任务状态…'
      : task === undefined
        ? '还没有取到任务信息，请点「刷新」重试'
        : taskState === 'done'
          ? undefined
          : '任务未完成，暂不能补录';

  // 新加入的行自动聚焦到它的 NFC 编号输入框：扫码枪就是键盘，焦点在哪就扫进哪一行。
  // （@wise/patterns 的 Input 没有暴露 autoFocus / ref，所以这里用行容器 ref 找到该行的第一个输入框，
  //   不新增控件、也不改组件库。）
  useEffect(() => {
    if (focusKey === undefined) {
      return;
    }
    const host = rowHosts.current.get(focusKey);
    const target = host?.querySelector('input');
    if (target instanceof HTMLInputElement) {
      target.focus();
    }
  }, [focusKey]);

  const missingRows = rows
    .map((row, index) => (row.rfid.trim() === '' ? index + 1 : 0))
    .filter((index) => index > 0);
  const rowsReady = rows.length > 0 && missingRows.length === 0;
  // 二次确认里报前几条编号：入账不可撤销，让操作员能对着标签核对一眼
  const previewItems = rows.slice(0, 3).map((row) => row.rfid.trim());
  const previewText =
    rows.length > previewItems.length
      ? `${previewItems.join('、')} 等 ${rows.length} 条`
      : previewItems.join('、');

  const updateRow = (key: string, patch: RowPatch): void => {
    setRows((prev) =>
      prev.map((row) =>
        row.key === key
          ? {
              key: row.key,
              rfid: patch.rfid !== undefined ? patch.rfid : row.rfid,
              tid: patch.tid !== undefined ? patch.tid : row.tid,
              remark: patch.remark !== undefined ? patch.remark : row.remark,
            }
          : row,
      ),
    );
  };

  const addRow = (): void => {
    seq.current += 1;
    const key = `row-${seq.current}`;
    setRows((prev) => [...prev, emptyRow(key)]);
    setFocusKey(key);
  };

  const removeRow = (key: string): void => {
    const remaining = rows.filter((row) => row.key !== key);
    rowHosts.current.delete(key);
    setExpanded((prev) => {
      if (!prev.has(key)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (remaining.length === 0) {
      // 永远留一行：整屏没有行的话，操作员还得先点「新增一行」才能继续
      seq.current += 1;
      const fresh = `row-${seq.current}`;
      setRows([emptyRow(fresh)]);
      setFocusKey(fresh);
      return;
    }
    setRows(remaining);
  };

  const clearRows = (): void => {
    seq.current += 1;
    const fresh = `row-${seq.current}`;
    rowHosts.current.clear();
    setExpanded(new Set());
    setRows([emptyRow(fresh)]);
    setTried(false);
    setActionError(undefined);
    setNotice(undefined);
    setFocusKey(fresh);
  };

  const toggleExtra = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const openConfirm = (): void => {
    if (!hasTask) {
      setActionError('请先填写任务序号，再补录明细。');
      return;
    }
    if (!canRecord) {
      setActionError('这个任务还没有完成，补录只对已完成的巡检任务开放。请先把任务做完，再回来补录漏扫的标签。');
      return;
    }
    setTried(true);
    if (!rowsReady) {
      setActionError(`第 ${missingRows.join('、')} 行还没有 NFC 编号，请扫码或手动输入后再提交。`);
      return;
    }
    setActionError(undefined);
    setPending(true);
  };

  const submit = async (): Promise<void> => {
    setPending(false);
    if (taskId === undefined) {
      setActionError('请先填写任务序号，再补录明细。');
      return;
    }
    if (!canRecord) {
      setActionError('这个任务还没有完成，补录只对已完成的巡检任务开放。请先把任务做完，再回来补录漏扫的标签。');
      return;
    }
    if (!rowsReady) {
      setTried(true);
      setActionError(`第 ${missingRows.join('、')} 行还没有 NFC 编号，请扫码或手动输入后再提交。`);
      return;
    }
    const items = rows.map(itemOf);
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      await bridge.call('inspection.manualRecord', { taskId, items });
      setNotice(`已把 ${items.length} 条明细补录到任务 ${taskId}。`);
      // 补录完清空成一行并重新聚焦：现场是一批一批扫
      seq.current += 1;
      const fresh = `row-${seq.current}`;
      rowHosts.current.clear();
      setExpanded(new Set());
      setRows([emptyRow(fresh)]);
      setTried(false);
      setFocusKey(fresh);
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
        title="手动补录巡检明细"
        subtitle="把漏扫的 NFC 标签补录进已完成的巡检任务，一行一个标签"
        actions={
          <>
            <Button ariaLabel="新增一行补录明细" disabled={busy} onClick={addRow}>
              新增一行
            </Button>
            <Button ariaLabel="刷新任务信息" disabled={!hasTask || busy} onClick={taskCall.reload}>
              刷新
            </Button>
          </>
        }
      />

      {actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      {notice ? (
        <Card>
          <Stack tight>
            <span>{notice}</span>
            <span className="w-muted">
              接着扫下一批即可，下面的行已经清空。要看补录后的差异，请到「巡检任务」打开这个任务。
            </span>
          </Stack>
        </Card>
      ) : null}

      <Section title="补录到哪个任务">
        <Card>
          <Stack>
            <Field label="任务序号 *" error={taskError}>
              <Input
                value={taskInput}
                onChange={setTaskInput}
                placeholder="如：501"
                mono
                ariaLabel="任务序号 *"
              />
            </Field>
            <span className="w-muted">
              补录只对已完成的巡检任务开放。任务完成后才能在任务详情里补录漏扫的标签。
            </span>
            <ListStateHost
              loading={taskCall.loading}
              error={taskCall.error ? { code: taskCall.error.code, text: humanize(taskCall.error) } : undefined}
              items={task ? [task] : []}
              emptyText={
                hasTask
                  ? '没有找到这个任务。请核对任务序号，或先到「巡检任务」里确认任务已经建好。'
                  : '还没有填任务序号。填上要补录的任务序号，这里会显示它的状态。'
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
                      <span className="w-chip w-mono">{`异常 ${t?.abnormalItems ?? 0} 项`}</span>
                    </Toolbar>
                    <KeyValue k="任务号" v={<Mono>{t?.taskCode ?? '未登记'}</Mono>} />
                    <KeyValue k="巡检计划" v={t?.planName ?? '未关联计划'} />
                    <KeyValue k="执行仓库" v={<Mono>{t?.warehouseName ?? '未登记'}</Mono>} />
                    <KeyValue k="执行设备" v={t?.deviceName ?? '未指定设备'} />
                    <KeyValue k="已盘数量" v={`${t?.inspectedItems ?? 0} / 共 ${t?.totalItems ?? 0}`} />
                    {blockedText !== undefined ? (
                      <div className="w-state w-state--error">
                        <span>{`${blockedText}补录只对已完成的巡检任务开放，请先把任务做完再回来补录。`}</span>
                      </div>
                    ) : null}
                  </Stack>
                );
              }}
            </ListStateHost>
          </Stack>
        </Card>
      </Section>

      <Section title={`补录明细（${rows.length} 行）`}>
        <Stack>
          {rows.map((row, index) => (
            <Card key={row.key}>
              <div
                ref={(el) => {
                  if (el === null) {
                    rowHosts.current.delete(row.key);
                  } else {
                    rowHosts.current.set(row.key, el);
                  }
                }}
              >
                <Stack>
                  <Toolbar>
                    <Chip tone="neutral">
                      <Dot tone="idle" />
                      {`第 ${index + 1} 行`}
                    </Chip>
                    <span className="w-muted">扫码枪扫标签，或手动输入编号</span>
                    <Button
                      variant="danger"
                      ariaLabel={`删除第 ${index + 1} 行`}
                      disabled={busy}
                      onClick={() => removeRow(row.key)}
                    >
                      删除该行
                    </Button>
                  </Toolbar>
                  <Field
                    label="NFC 编号 *"
                    error={tried && row.rfid.trim() === '' ? '这一行还缺 NFC 编号，扫一下标签或手动输入' : undefined}
                  >
                    <Input
                      value={row.rfid}
                      onChange={(value) => updateRow(row.key, { rfid: value })}
                      placeholder="扫码或手输，如：E2003412012345"
                      mono
                      ariaLabel={`第 ${index + 1} 行的 NFC 编号`}
                      onEnter={addRow}
                    />
                  </Field>
                  <Toolbar>
                    <Button
                      ariaLabel={expanded.has(row.key) ? `收起第 ${index + 1} 行的补充信息` : `展开第 ${index + 1} 行的补充信息`}
                      onClick={() => toggleExtra(row.key)}
                    >
                      {expanded.has(row.key) ? '收起 TID / 备注' : '补充 TID / 备注'}
                    </Button>
                  </Toolbar>
                  {expanded.has(row.key) ? (
                    <Stack>
                      <Field label="TID（选填）">
                        <Input
                          value={row.tid}
                          onChange={(value) => updateRow(row.key, { tid: value })}
                          placeholder="扫到的 TID，没有就留空"
                          mono
                          ariaLabel={`第 ${index + 1} 行的 TID`}
                        />
                      </Field>
                      <Field label="备注（选填）">
                        <Input
                          value={row.remark}
                          onChange={(value) => updateRow(row.key, { remark: value })}
                          placeholder="如：标签破损，人工确认"
                          ariaLabel={`第 ${index + 1} 行的备注`}
                        />
                      </Field>
                    </Stack>
                  ) : null}
                </Stack>
              </div>
            </Card>
          ))}
        </Stack>
        <Toolbar>
          <Button ariaLabel="再新增一行补录明细" disabled={busy} onClick={addRow}>
            新增一行
          </Button>
          <Button ariaLabel="清空所有补录明细" disabled={busy} onClick={clearRows}>
            清空全部
          </Button>
        </Toolbar>
      </Section>

      <BottomActionBar>
        {/* 按钮为什么不能点，就写在按钮旁边：现场不会去猜一个灰掉的按钮 */}
        {gateText !== undefined ? (
          <span className="w-muted">{gateText}</span>
        ) : (
          <span className="w-muted w-mono">{`${rows.length} 行 · ${missingRows.length} 行待扫`}</span>
        )}
        <Button
          variant="primary"
          block
          ariaLabel="提交补录明细"
          disabled={busy || !canRecord}
          onClick={openConfirm}
        >
          {busy ? '提交中…' : '提交补录'}
        </Button>
      </BottomActionBar>

      <ConfirmDialog
        open={pending}
        title="提交补录明细"
        danger
        confirmLabel="确认补录"
        message={
          <Stack>
            <span>
              {`将把 ${rows.length} 条明细补录到任务 ${taskId !== undefined ? taskId : '未填'}。`}
            </span>
            <span className="w-muted">
              {`待补录：${previewText}`}
            </span>
            <span className="w-muted">
              补录会把这些标签计入该任务的盘点明细，可能改变它的账实差异。此操作不可撤销。
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

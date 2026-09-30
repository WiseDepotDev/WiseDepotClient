import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataList,
  DataRow,
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
 * 巡检任务详情（field/inspection 任务详情）。
 *
 * 这一屏把"一个巡检任务"讲完整：进度 → 物料差异 → 可以做的动作。
 *
 * 三条刻意的选择：
 * 1. **进度不用进度条画，用数字 + 芯片**：现场是强光下看屏，细进度条看不清；
 *    百分比数字配已盘/总数更有用，也不引入新的视觉元素。
 * 2. **状态动作是"不可逆操作"**：结束任务之后差异会被确认为账实结果，
 *    因此这里用 ConfirmDialog 二次确认（ui-spec §3.1 不允许点一下就生效）。
 * 3. **差异按"盘亏 / 盘盈 / 正常"翻译**：`MISSING` / `EXTRA` 这类英文枚举
 *    只在服务端有意义，界面上给的是仓库人员用的词。
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

type TaskState = 'pending' | 'running' | 'done' | 'paused' | 'unknown';

function hasDetail(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

function detailOf(value: unknown): TaskDetail | undefined {
  if (!hasDetail(value)) {
    return undefined;
  }
  const list = asList<TaskDetail>(value);
  return list.length > 0 ? list[0] : (value as TaskDetail);
}

function stateOf(task: TaskDetail): TaskState {
  const desc = task.statusDesc ?? '';
  if (desc.includes('完成')) {
    return 'done';
  }
  if (desc.includes('进行') || desc.includes('执行中')) {
    return 'running';
  }
  if (desc.includes('暂停') || desc.includes('中止')) {
    return 'paused';
  }
  switch (task.status) {
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

function stateText(task: TaskDetail): string {
  if (task.statusDesc) {
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

function typeText(task: TaskDetail): string {
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

function optionalNumber(value: number | undefined): string {
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

function DiffChip({ diff }: { diff: DiffRow }): React.ReactElement {
  const status = (diff.status ?? '').toUpperCase();
  if (status === 'MISSING' || (diff.difference ?? 0) < 0) {
    return (
      <Chip tone="danger">
        <Dot tone="bad" />
        盘亏
      </Chip>
    );
  }
  if (status === 'EXTRA' || (diff.difference ?? 0) > 0) {
    return (
      <Chip tone="warn">
        <Dot tone="warn" />
        盘盈
      </Chip>
    );
  }
  return (
    <Chip tone="ok">
      <Dot tone="ok" />
      相符
    </Chip>
  );
}

export function InspectionTaskDetailScreen({
  bridge,
  taskId,
  onBack,
}: {
  bridge: Bridge;
  taskId?: number | undefined;
  onBack?: (() => void) | undefined;
}): React.ReactElement {
  const [idInput, setIdInput] = useState('');
  const [selectedId, setSelectedId] = useState<number | undefined>(taskId);
  const [lookupError, setLookupError] = useState<string | undefined>(undefined);
  const [onlyAbnormal, setOnlyAbnormal] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<'RUNNING' | 'COMPLETED' | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const hasTarget = selectedId !== undefined;
  const params = selectedId !== undefined ? { taskId: selectedId } : undefined;

  const detailCall = useBridgeCall<unknown>(bridge, 'inspection.taskDetail', params, { enabled: hasTarget });
  const diffCall = useBridgeCall<unknown>(bridge, 'inspection.taskDiff', params, { enabled: hasTarget });

  const task = detailOf(detailCall.data);
  const diffs = asList<DiffRow>(diffCall.data);
  const shownDiffs = onlyAbnormal ? diffs.filter(isAbnormalDiff) : diffs;
  const abnormalCount = diffs.filter(isAbnormalDiff).length;
  const state = task ? stateOf(task) : 'unknown';

  const openById = (): void => {
    const id = Number(idInput.trim());
    if (!Number.isFinite(id) || id <= 0) {
      setLookupError('请输入正确的任务序号（正整数）');
      return;
    }
    setLookupError(undefined);
    setActionError(undefined);
    setNotice(undefined);
    setSelectedId(id);
  };

  const runStatusChange = async (): Promise<void> => {
    const next = pendingStatus;
    setPendingStatus(undefined);
    if (next === undefined || selectedId === undefined) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('inspection.taskStatus', { taskId: selectedId, status: next });
      setNotice(next === 'RUNNING' ? '任务已开始执行。' : '任务已结束，正在汇总盘点结果。');
      detailCall.reload();
      diffCall.reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const reportProgress = async (): Promise<void> => {
    if (selectedId === undefined) {
      return;
    }
    const next = task?.progress ?? 0;
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('inspection.taskProgress', {
        taskId: selectedId,
        progress: Math.max(0, Math.min(100, next)),
        scannedCount: task?.inspectedItems ?? 0,
      });
      setNotice('进度已保存，现场设备与后台会同步看到最新进度。');
      detailCall.reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title={task?.taskCode ? `巡检任务 ${task.taskCode}` : '巡检任务详情'}
        subtitle={
          task
            ? `${task.planName ?? '未关联计划'} · ${typeText(task)} · ${stateText(task)}`
            : '查看任务进度、物料差异，并推进任务状态'
        }
        actions={
          <>
            {onBack ? (
              <Button ariaLabel="返回任务列表" onClick={onBack}>
                返回列表
              </Button>
            ) : null}
            <Button variant="primary" ariaLabel="刷新任务详情" disabled={!hasTarget || busy} onClick={detailCall.reload}>
              刷新
            </Button>
          </>
        }
      />

      <Section title="查看某个任务">
        <Card>
          <Stack>
            <Toolbar>
              <Field label="任务序号">
                <Input value={idInput} onChange={setIdInput} onEnter={openById} placeholder="如：501" mono />
              </Field>
              <Button ariaLabel="查询任务" onClick={openById}>
                查询
              </Button>
            </Toolbar>
            {lookupError ? (
              <div className="w-state w-state--error">
                <span>{lookupError}</span>
              </div>
            ) : null}
            <span className="w-muted">也可以从「巡检任务」列表点选一个任务直接进来。</span>
          </Stack>
        </Card>
      </Section>

      {actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      {notice ? (
        <Card>
          <span>{notice}</span>
        </Card>
      ) : null}

      <Section title="任务信息">
        <Card>
          <ListStateHost
            loading={detailCall.loading}
            error={
              detailCall.error ? { code: detailCall.error.code, text: humanize(detailCall.error) } : undefined
            }
            items={task ? [task] : []}
            emptyText={
              hasTarget
                ? '没有找到这个巡检任务。请核对任务序号，或回到「巡检任务」列表重新选择。'
                : '还没有选择任务。请在上方输入任务序号后点「查询」。'
            }
            onRetry={detailCall.reload}
          >
            {(items) => {
              const t = items[0] ?? {};
              return (
                <Stack tight>
                  <Toolbar>
                    {state === 'done' ? (
                      <Chip tone="ok">
                        <Dot tone="ok" />
                        {stateText(t)}
                      </Chip>
                    ) : state === 'running' ? (
                      <Chip tone="info">
                        <Dot tone="ok" />
                        {stateText(t)}
                      </Chip>
                    ) : state === 'paused' ? (
                      <Chip tone="danger">
                        <Dot tone="bad" />
                        {stateText(t)}
                      </Chip>
                    ) : (
                      <Chip tone="neutral">
                        <Dot tone="idle" />
                        {stateText(t)}
                      </Chip>
                    )}
                    <span className="w-chip w-mono">{`已完成 ${t.progress ?? 0}%`}</span>
                    {abnormalCount > 0 ? (
                      <Chip tone="warn">
                        <Dot tone="warn" />
                        {`${abnormalCount} 项物料有差异`}
                      </Chip>
                    ) : null}
                  </Toolbar>
                  <KeyValue k="任务号" v={<Mono>{t.taskCode ?? '未登记'}</Mono>} />
                  <KeyValue k="巡检计划" v={t.planName ?? '未关联计划'} />
                  <KeyValue k="巡检类型" v={typeText(t)} />
                  <KeyValue k="执行仓库" v={<Mono>{t.warehouseName ?? '未登记'}</Mono>} />
                  <KeyValue k="执行设备" v={t.deviceName ?? '未指定设备'} />
                  <KeyValue
                    k="盘点数量"
                    v={
                      <>
                        {`已盘 ${t.inspectedItems ?? 0} / 共 ${t.totalItems ?? 0}`}
                        {t.inspectedItems === undefined && t.totalItems === undefined ? (
                          <span className="w-muted"> 数量未上报</span>
                        ) : null}
                      </>
                    }
                  />
                  <KeyValue k="正常 / 异常" v={`${optionalNumber(t.normalItems)} / ${optionalNumber(t.abnormalItems)}`} />
                  <KeyValue
                    k="开始时间"
                    v={t.startTime ? shortTime(t.startTime) : '尚未开始，可在下方「开始执行」'}
                  />
                  <KeyValue k="结束时间" v={t.endTime ? shortTime(t.endTime) : '尚未结束'} />
                </Stack>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Section title={`物料差异${diffs.length > 0 ? `（${diffs.length} 项）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={diffCall.loading}
            error={diffCall.error ? { code: diffCall.error.code, text: humanize(diffCall.error) } : undefined}
            items={shownDiffs}
            emptyText={
              onlyAbnormal
                ? '这个任务目前没有盘盈或盘亏的物料，账实一致。'
                : '这个任务还没有产生差异明细。任务开始盘点并上传数据后，这里会逐项列出盘点结果。'
            }
            onRetry={diffCall.reload}
          >
            {(items) => (
              <DataList>
                {items.map((d) => (
                  <DataRow
                    key={d.productId ?? d.productCode}
                    id={d.productCode ?? '编码未登记'}
                    main={d.productName ?? '未命名物料'}
                    sub={
                      <>
                        <span className="w-mono">{`预期 ${d.expectedQuantity ?? 0}`}</span>
                        <span className="w-mono">{` · 实扫 ${d.scannedQuantity ?? 0}`}</span>
                        <span className="w-muted">{` · ${differenceText(d)}`}</span>
                      </>
                    }
                    trailing={<DiffChip diff={d} />}
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
        <Toolbar>
          <Button ariaLabel="切换差异筛选" onClick={() => setOnlyAbnormal((v) => !v)}>
            {onlyAbnormal ? '显示全部物料' : `只看有差异的（${abnormalCount}）`}
          </Button>
        </Toolbar>
      </Section>

      <Toolbar>
        <Button
          ariaLabel="开始执行任务"
          disabled={!hasTarget || busy || state === 'running' || state === 'done'}
          onClick={() => setPendingStatus('RUNNING')}
        >
          开始执行
        </Button>
        <Button
          ariaLabel="保存当前进度"
          disabled={!hasTarget || busy || state !== 'running'}
          onClick={() => void reportProgress()}
        >
          保存当前进度
        </Button>
        <Button
          variant="danger"
          ariaLabel="结束任务"
          disabled={!hasTarget || busy || state === 'done' || state === 'pending'}
          onClick={() => setPendingStatus('COMPLETED')}
        >
          {busy ? '处理中…' : '结束任务'}
        </Button>
      </Toolbar>

      <ConfirmDialog
        open={pendingStatus !== undefined}
        title={pendingStatus === 'RUNNING' ? '开始执行任务' : '结束任务'}
        danger={pendingStatus !== 'RUNNING'}
        confirmLabel={pendingStatus === 'RUNNING' ? '开始执行' : '结束任务'}
        message={
          <Stack>
            <span>
              {pendingStatus === 'RUNNING'
                ? '任务将切换为「进行中」，巡检设备随后按计划开始盘点。'
                : '结束后将以当前盘点数据作为账实差异结果，差异明细会进入待确认状态，操作不可撤销。'}
            </span>
            <span className="w-muted">
              {`任务号 ${task?.taskCode ?? '未登记'} · 已完成 ${task?.progress ?? 0}%`}
            </span>
            {actionError ? (
              <span className="w-state w-state--error">{actionError}</span>
            ) : null}
          </Stack>
        }
        onConfirm={() => void runStatusChange()}
        onCancel={() => setPendingStatus(undefined)}
      />
    </Stack>
  );
}

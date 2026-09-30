import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataList,
  DataRow,
  Dot,
  KeyValue,
  ListStateHost,
  Mono,
  PageHeader,
  SearchField,
  Section,
  Stack,
  TabStrip,
  TabStripItem,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, humanize, shortTime } from '../shared/api.js';

/**
 * 巡检结果列表（field/inspection 结果）。
 *
 * 这一屏是"盘点做完之后"的落点：看每个任务盘出了什么，并把结果确认下来。
 *
 * 两条刻意的选择：
 * 1. **确认是不可逆操作** —— 确认之后盘点差异就成为账实结论、可能触发库存调整，
 *    因此走 ConfirmDialog 二次确认，且二次确认里把"哪个任务、差异多少"再说一遍，
 *    避免用户在列表里点错行；
 * 2. **未确认的结果默认排在前面**（服务端顺序之上再做一次稳定分组）：
 *    这条屏的主要工作就是"把没确认的确认掉"，让待办先露头。
 */

interface ResultRow {
  readonly resultId?: number;
  readonly taskId?: number;
  readonly compareTime?: string;
  readonly totalItems?: number;
  readonly normalItems?: number;
  readonly missingItems?: number;
  readonly extraItems?: number;
  readonly createTime?: string;
  readonly progress?: number;
  readonly status?: string;
  readonly totalScanned?: number;
  readonly totalExpected?: number;
}

type ResultFilter = 'all' | 'pending' | 'confirmed';

function isConfirmed(result: ResultRow): boolean {
  const status = (result.status ?? '').toUpperCase();
  return status === 'CONFIRMED' || status === 'DONE' || status === 'COMPLETED' || status === '已确认';
}

function statusText(result: ResultRow): string {
  if (!result.status) {
    return '待确认';
  }
  if (isConfirmed(result)) {
    return '已确认';
  }
  const status = result.status.toUpperCase();
  if (status === 'PENDING') {
    return '待确认';
  }
  return result.status;
}

function abnormalCount(result: ResultRow): number {
  return (result.missingItems ?? 0) + (result.extraItems ?? 0);
}

function ResultStateChip({ result }: { result: ResultRow }): React.ReactElement {
  if (isConfirmed(result)) {
    return (
      <Chip tone="ok">
        <Dot tone="ok" />
        已确认
      </Chip>
    );
  }
  return (
    <Chip tone="warn">
      <Dot tone="warn" />
      待确认
    </Chip>
  );
}

export function InspectionResultListScreen({
  bridge,
  resultId,
}: {
  bridge: Bridge;
  resultId?: number | undefined;
}): React.ReactElement {
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [filter, setFilter] = useState<ResultFilter>('all');
  const [selected, setSelected] = useState<ResultRow | undefined>(undefined);
  const [pendingConfirm, setPendingConfirm] = useState<ResultRow | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<number | undefined>(resultId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const listCall = useBridgeCall<unknown>(bridge, 'inspection.resultList', {});
  const detailId = selected?.resultId ?? selectedId;
  const detailCall = useBridgeCall<unknown>(
    bridge,
    'inspection.resultDetail',
    detailId !== undefined ? { resultId: detailId } : undefined,
  );

  const all = asList<ResultRow>(listCall.data);
  const rows = all
    .filter((r) => {
      if (filter === 'pending' && isConfirmed(r)) {
        return false;
      }
      if (filter === 'confirmed' && !isConfirmed(r)) {
        return false;
      }
      if (applied) {
        const hay = `${r.taskId ?? ''}${r.resultId ?? ''}${r.status ?? ''}`;
        if (!hay.toLowerCase().includes(applied.toLowerCase())) {
          return false;
        }
      }
      return true;
    })
    // 未确认的排前面：这一屏的主要工作就是把待确认的结果处理掉
    .slice()
    .sort((a, b) => Number(isConfirmed(a)) - Number(isConfirmed(b)));

  const pendingCount = all.filter((r) => !isConfirmed(r)).length;
  const detail = detailCall.data as ResultRow | undefined;
  const shown: ResultRow | undefined =
    detail && typeof detail === 'object' && Object.keys(detail).length > 0 ? detail : selected;

  const runConfirm = async (): Promise<void> => {
    const target = pendingConfirm;
    setPendingConfirm(undefined);
    if (target?.resultId === undefined) {
      setActionError('这条结果缺少序号，请刷新后重试');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('inspection.resultConfirm', { resultId: target.resultId });
      setNotice('结果已确认，盘点差异已作为账实结论记录。');
      listCall.reload();
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
        title="巡检结果"
        subtitle={
          all.length > 0
            ? `共 ${all.length} 条结果，待确认 ${pendingCount} 条`
            : '每次盘点完成后生成的结果与差异'
        }
        actions={
          <Button ariaLabel="刷新结果" onClick={listCall.reload}>
            刷新
          </Button>
        }
      />

      <SearchField
        value={keyword}
        onChange={setKeyword}
        onSearch={() => setApplied(keyword)}
        placeholder="任务序号 / 结果序号"
      />

      <TabStrip>
        <TabStripItem label="全部" active={filter === 'all'} onClick={() => setFilter('all')} />
        <TabStripItem label="待确认" active={filter === 'pending'} onClick={() => setFilter('pending')} />
        <TabStripItem label="已确认" active={filter === 'confirmed'} onClick={() => setFilter('confirmed')} />
      </TabStrip>

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

      <Section title={`结果列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={listCall.loading}
            error={
              listCall.error ? { code: listCall.error.code, text: humanize(listCall.error) } : undefined
            }
            items={rows}
            emptyText={
              applied || filter !== 'all'
                ? '没有符合条件的结果，试试换个关键字，或切回「全部」。'
                : '还没有巡检结果。请先在「巡检任务」里完成一次盘点，盘点数据上传后这里会自动生成结果。'
            }
            onRetry={listCall.reload}
          >
            {(items) => (
              <DataList>
                {items.map((r) => (
                  <DataRow
                    key={r.resultId ?? `task-${r.taskId}`}
                    id={r.resultId !== undefined ? `结果 ${r.resultId}` : '结果序号未登记'}
                    main={
                      <>
                        {`任务 ${r.taskId ?? '未关联'}`}
                        <span className="w-muted">
                          {' · '}
                          {r.compareTime ? shortTime(r.compareTime) : '比对时间未记录'}
                        </span>
                      </>
                    }
                    sub={
                      <>
                        <span className="w-mono">{`应盘 ${r.totalExpected ?? r.totalItems ?? 0}`}</span>
                        <span className="w-mono">{` · 实扫 ${r.totalScanned ?? 0}`}</span>
                        <span className="w-muted">
                          {' · 正常 '}
                          {r.normalItems ?? 0}
                          {'，盘亏 '}
                          {r.missingItems ?? 0}
                          {'，盘盈 '}
                          {r.extraItems ?? 0}
                        </span>
                      </>
                    }
                    trailing={
                      <>
                        <ResultStateChip result={r} />
                        {isConfirmed(r) ? null : (
                          <Button
                            variant="danger"
                            ariaLabel={`确认任务 ${r.taskId ?? ''} 的巡检结果`}
                            disabled={busy}
                            onClick={() => {
                              setSelected(r);
                              setPendingConfirm(r);
                            }}
                          >
                            确认
                          </Button>
                        )}
                      </>
                    }
                    active={selected?.resultId !== undefined && selected.resultId === r.resultId}
                    onSelect={() => {
                      setSelected(r);
                      setSelectedId(r.resultId);
                      setNotice(undefined);
                    }}
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
      </Section>

      <Section title="结果明细">
        <Card>
          <ListStateHost
            loading={detailCall.loading}
            error={
              detailCall.error ? { code: detailCall.error.code, text: humanize(detailCall.error) } : undefined
            }
            items={shown ? [shown] : []}
            emptyText="还没有选择结果。点上面任意一条结果，这里会显示它的盘点数量与差异构成。"
            onRetry={detailCall.reload}
          >
            {(items) => {
              const r = items[0] ?? {};
              return (
                <Stack tight>
                  <Toolbar>
                    <ResultStateChip result={r} />
                    <span className="w-chip w-mono">{`已完成 ${r.progress ?? 0}%`}</span>
                  </Toolbar>
                  <KeyValue k="结果序号" v={<Mono>{r.resultId !== undefined ? String(r.resultId) : '未登记'}</Mono>} />
                  <KeyValue k="所属任务" v={<Mono>{r.taskId !== undefined ? String(r.taskId) : '未关联'}</Mono>} />
                  <KeyValue k="比对时间" v={r.compareTime ? shortTime(r.compareTime) : '未记录'} />
                  <KeyValue k="生成时间" v={r.createTime ? shortTime(r.createTime) : '未记录'} />
                  <KeyValue k="应盘数量" v={r.totalExpected ?? r.totalItems ?? 0} />
                  <KeyValue k="实扫数量" v={r.totalScanned ?? 0} />
                  <KeyValue k="账实相符" v={r.normalItems ?? 0} />
                  <KeyValue k="盘亏（少了）" v={r.missingItems ?? 0} />
                  <KeyValue k="盘盈（多了）" v={r.extraItems ?? 0} />
                  <KeyValue k="当前状态" v={statusText(r)} />
                  {abnormalCount(r) > 0 ? (
                    <span className="w-muted">
                      {`这条结果有 ${abnormalCount(r)} 项差异，确认后会作为账实结论记录，请在确认前核对差异明细。`}
                    </span>
                  ) : (
                    <span className="w-muted">这条结果账实相符，可以直接确认。</span>
                  )}
                </Stack>
              );
            }}
          </ListStateHost>
        </Card>
        <Toolbar>
          <Button
            variant="danger"
            ariaLabel="确认选中的巡检结果"
            disabled={!shown || isConfirmed(shown) || busy}
            onClick={() => setPendingConfirm(shown)}
          >
            {busy ? '确认中…' : '确认这条结果'}
          </Button>
        </Toolbar>
      </Section>

      <ConfirmDialog
        open={pendingConfirm !== undefined}
        title="确认巡检结果"
        danger
        confirmLabel="确认结果"
        message={
          <Stack>
            <span>
              {`确认后，任务 ${pendingConfirm?.taskId ?? '未关联'} 的盘点差异将作为账实结论记录，并可能触发库存调整，此操作不可撤销。`}
            </span>
            <span className="w-muted">
              {`盘亏 ${pendingConfirm?.missingItems ?? 0} 项，盘盈 ${pendingConfirm?.extraItems ?? 0} 项，账实相符 ${pendingConfirm?.normalItems ?? 0} 项。`}
            </span>
            {actionError ? <span className="w-state w-state--error">{actionError}</span> : null}
          </Stack>
        }
        onConfirm={() => void runConfirm()}
        onCancel={() => setPendingConfirm(undefined)}
      />
    </Stack>
  );
}

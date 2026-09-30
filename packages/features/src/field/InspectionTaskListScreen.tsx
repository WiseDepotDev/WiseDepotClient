import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataList,
  DataRow,
  Dot,
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
import { asList, asTotal, humanize, shortTime } from '../shared/api.js';
import { taskStateOf, taskStateText, type TaskState } from './inspectionState.js';
import type { Navigator } from '../registry.js';

/**
 * 巡检任务列表（field/inspection 任务）。
 *
 * 这一屏是现场作业的**入口**：看一眼"今天有哪些盘点要做、做到哪了"，然后点进详情。
 * 两个刻意的决定：
 *
 * 1. **分页用服务端的 page / pageSize**，不是库存域那套 page / size ——
 *    巡检任务接口的每页条数参数名就是 pageSize，照抄库存的参数名会让第二页永远取回第一页，
 *    而且这种错在界面上看不出来（只是"下一页点了没反应"）。
 * 2. **筛选按"进行中 / 已完成"表达**，而不是把服务端的英文状态名抛给用户。
 *    现场人员不认识 `COMPLETED` 这类词，只认识"做完了没有"。
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

/**
 * 任务状态归一化。
 *
 * 服务端两个形状都出现过：列表 DTO 给数字（0 待执行 / 1 进行中 / 2 已完成），
 * 详情与状态更新接口给英文串（PENDING / RUNNING / COMPLETED）。
 * 这里统一成"业务语言"，界面上只出现人话。
 */
// 状态判定与文案统一在 ./inspectionState.ts —— 详情屏用的是同一份。
// 曾经两屏各抄一份，于是两处都犯了同一个错（把服务端的枚举原文 `COMPLETED` 直接画到界面上）。
function stateOf(task: TaskRow): TaskState {
  return taskStateOf(task);
}

function stateText(task: TaskRow): string {
  return taskStateText(task);
}

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

function TaskStateChip({ task }: { task: TaskRow }): React.ReactElement {
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

export function InspectionTaskListScreen({
  bridge,
  onNavigate,
}: {
  bridge: Bridge;
  onNavigate?: Navigator | undefined;
}): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('all');

  // 每页条数的参数名是 pageSize（契约里 /api/inspection/task/page 就是这个名字）
  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'inspection.taskPage', {
    page,
    pageSize: PAGE_SIZE,
  });

  const all = asList<TaskRow>(data);
  const total = asTotal(data);
  const rows = all.filter((t) => {
    const state = stateOf(t);
    if (filter === 'running' && state !== 'running') {
      return false;
    }
    if (filter === 'done' && state !== 'done') {
      return false;
    }
    if (applied) {
      const hay = `${t.taskCode ?? ''}${t.planName ?? ''}${t.warehouseName ?? ''}${t.deviceName ?? ''}`.toLowerCase();
      if (!hay.includes(applied.toLowerCase())) {
        return false;
      }
    }
    return true;
  });
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : all.length === PAGE_SIZE;

  return (
    <Stack>
      <PageHeader
        title="巡检任务"
        subtitle={total !== undefined ? `共 ${total} 个任务` : '盘点任务的执行进度与结果入口'}
        actions={
          <Button ariaLabel="刷新任务" onClick={reload}>
            刷新
          </Button>
        }
      />

      <SearchField
        value={keyword}
        onChange={setKeyword}
        onSearch={() => {
          setApplied(keyword);
          setPage(1);
        }}
        placeholder="任务号 / 计划名 / 仓库 / 设备"
      />

      <TabStrip>
        <TabStripItem
          label="全部"
          active={filter === 'all'}
          onClick={() => {
            setFilter('all');
            setPage(1);
          }}
        />
        <TabStripItem
          label="进行中"
          active={filter === 'running'}
          onClick={() => {
            setFilter('running');
            setPage(1);
          }}
        />
        <TabStripItem
          label="已完成"
          active={filter === 'done'}
          onClick={() => {
            setFilter('done');
            setPage(1);
          }}
        />
      </TabStrip>

      <Section title={`任务列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText={
              applied || filter !== 'all'
                ? '没有符合条件的巡检任务，试试换个关键字，或切回「全部」。'
                : '还没有巡检任务。请联系管理员在后台创建巡检计划并下发任务，任务下发后会出现在这里。'
            }
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((t) => (
                  <DataRow
                    key={t.taskId ?? t.taskCode}
                    id={t.taskCode ?? '任务号未登记'}
                    main={t.planName ?? '未关联巡检计划'}
                    sub={
                      <>
                        <span>{typeText(t)} · </span>
                        <span className="w-mono">{t.warehouseName ?? '仓库未登记'}</span>
                        <span className="w-muted"> · {t.deviceName ?? '未指定设备'}</span>
                        <span className="w-muted">
                          {' · 进度 '}
                          {t.progress ?? 0}
                          {'%'}
                          {t.totalItems !== undefined ? `（${t.inspectedItems ?? 0}/${t.totalItems}）` : ''}
                        </span>
                        <span className="w-muted"> · 开始 {t.startTime ? shortTime(t.startTime) : '未开始'}</span>
                      </>
                    }
                    trailing={<TaskStateChip task={t} />}
                    /*
                     * 整行点一下 = 去下一层看这个任务（返回由外壳负责）。
                     * 序号缺失的行点了什么都不做：详情屏只认数字序号。
                     */
                    onSelect={() => {
                      if (t.taskId === undefined) {
                        return;
                      }
                      onNavigate?.({ method: 'inspection.taskDetail', params: { taskId: String(t.taskId) } });
                    }}
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
      </Section>

      <Toolbar>
        <Button ariaLabel="上一页" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          上一页
        </Button>
        <span className="w-chip w-mono">{`第 ${page} 页`}</span>
        <Button ariaLabel="下一页" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
        <Mono>{`本页 ${rows.length} 个任务`}</Mono>
      </Toolbar>
    </Stack>
  );
}

export type { TaskRow };

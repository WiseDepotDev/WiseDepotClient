import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataList,
  DataRow,
  Dot,
  Mono,
  PageHeader,
  Section,
  Stack,
  Toolbar,
  ListStateHost,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, asTotal, humanize, shortTime } from '../shared/api.js';
import type { Navigator } from '../registry.js';
import { LevelChip } from './DashboardScreen.js';

/**
 * 告警中心（overview/alerts）。
 *
 * 与看板的差别只在"列表是主体"：分页、下拉刷新位、行内等级与状态下发。
 * 分页参数沿用旧版（`page` 从 1 开始、`size`），**不改接口**。
 */

interface AlertItem {
  readonly eventId: number;
  readonly title: string;
  readonly message?: string;
  readonly level: number;
  readonly status?: number;
  readonly sourceModule?: string;
  readonly createTime?: string;
}

const PAGE_SIZE = 20;

export function AlertListScreen({
  bridge,
  onNavigate,
}: {
  bridge: Bridge;
  onNavigate?: Navigator | undefined;
}): React.ReactElement {
  const [page, setPage] = useState(1);
  const [onlyUnhandled, setOnlyUnhandled] = useState(false);

  const params = onlyUnhandled ? { page, size: PAGE_SIZE, status: 0 } : { page, size: PAGE_SIZE };
  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'alert.list', params);

  const rows = asList<AlertItem>(data);
  const total = asTotal(data);
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : rows.length === PAGE_SIZE;

  return (
    <Stack>
      <PageHeader
        title="告警中心"
        subtitle={total !== undefined ? `共 ${total} 条` : '最近的告警事件'}
        actions={
          <Button ariaLabel="刷新" onClick={reload}>
            刷新
          </Button>
        }
      />

      <Toolbar>
        <Chip tone={onlyUnhandled ? 'warn' : 'neutral'}>
          <Dot tone={onlyUnhandled ? 'warn' : 'idle'} />
          {onlyUnhandled ? '只看未处理' : '全部'}
        </Chip>
        <Button
          ariaLabel="切换筛选"
          onClick={() => {
            setOnlyUnhandled((v) => !v);
            setPage(1);
          }}
        >
          {onlyUnhandled ? '显示全部' : '只看未处理'}
        </Button>
      </Toolbar>

      <Section title="告警列表">
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText="没有符合条件的告警"
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((a) => (
                  <DataRow
                    key={a.eventId}
                    id={`#${a.eventId}`}
                    /*
                     * 整行点一下 = 进告警详情。
                     * 用条件展开而不是 `onSelect={cond ? undefined : fn}`：
                     * 本仓开了 `exactOptionalPropertyTypes`，显式传 undefined 编译不过。
                     */
                    {...(a.eventId === undefined
                      ? {}
                      : {
                          onSelect: () =>
                            onNavigate?.({ method: 'alert.detail', params: { eventId: String(a.eventId) } }),
                        })}
                    main={a.title}
                    sub={
                      <>
                        {a.message ? <span>{a.message} · </span> : null}
                        <span className="w-mono">{shortTime(a.createTime)}</span>
                        {a.sourceModule ? <span className="w-muted"> · {a.sourceModule}</span> : null}
                      </>
                    }
                    trailing={
                      <>
                        {a.status === 0 ? <Chip tone="warn">未处理</Chip> : <Chip tone="ok">已处理</Chip>}
                        <LevelChip level={a.level} />
                      </>
                    }
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
        <span className="w-mono">第 {page} 页</span>
        <Button ariaLabel="下一页" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
        {rows.length > 0 ? <Mono>{`本页 ${rows.length} 条`}</Mono> : null}
      </Toolbar>
    </Stack>
  );
}

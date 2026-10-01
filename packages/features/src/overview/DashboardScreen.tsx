import {
  Card,
  DataList,
  DataRow,
  Dot,
  Chip,
  KeyValue,
  KpiCard,
  ListStateHost,
  Mono,
  PageHeader,
  Section,
  Stack,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { humanize, asList, shortTime } from '../shared/api.js';

/**
 * 看板（overview/dashboard）。
 *
 * 数据形状来自真后端 `DashboardSummaryDTO`：
 * `{inventoryTotal, todayAlertCount, inspectionProgress, deviceOnlineCount, unprocessedAlerts[], currentTask}`
 *
 * 取数一律走 `ListStateHost`，因此"加载 / 空 / 错 / 内容"四态是**结构上必然存在**的 ——
 * 这一屏是 W5 的第一个样板，后面各域照它写。
 */

interface AlertItem {
  readonly eventId: number;
  readonly title: string;
  readonly message?: string;
  readonly level: number;
  readonly status?: number;
  readonly createTime?: string;
}

interface DashboardSummary {
  readonly inventoryTotal?: number;
  readonly todayAlertCount?: number;
  readonly inspectionProgress?: number;
  readonly deviceOnlineCount?: number;
  readonly unprocessedAlerts?: readonly AlertItem[];
  readonly currentTask?: {
    readonly taskCode?: string;
    readonly taskName?: string;
    readonly progress?: number;
    readonly inspectedItems?: number;
    readonly totalItems?: number;
  } | null;
}

export function DashboardScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const { loading, data, error, reload } = useBridgeCall<DashboardSummary>(bridge, 'dashboard.summary');

  const alerts = asList<AlertItem>(data?.unprocessedAlerts);
  const task = data?.currentTask ?? null;

  return (
    <Stack>
      <PageHeader
        title="看板"
        subtitle="库存、告警、巡检与设备的实时汇总"
        actions={
          <span className="w-chip">
            <Dot tone={error ? 'bad' : loading ? 'warn' : 'ok'} />
            {error ? '取数失败' : loading ? '加载中' : '实时'}
          </span>
        }
      />

      <ListStateHost
        loading={loading}
        error={error ? { code: error.code, text: humanize(error) } : undefined}
        items={data ? [data] : []}
        emptyText="暂无看板数据"
        onRetry={reload}
      >
        {() => (
          <div className="w-metric-grid">
            <KpiCard className="w-metric-card" value={data?.inventoryTotal ?? 0} label="库存总量" />
            <KpiCard className="w-metric-card" value={data?.todayAlertCount ?? 0} label="今日告警" />
            <KpiCard className="w-metric-card" value={`${data?.inspectionProgress ?? 0}%`} label="巡检进度" />
            <KpiCard className="w-metric-card" value={data?.deviceOnlineCount ?? 0} label="设备在线" />
          </div>
        )}
      </ListStateHost>

      <div className="w-dashboard-grid">
        <Section title="当前任务">
          <Card>
            {task?.taskCode ? (
              <>
                <KeyValue k="任务号" v={<Mono>{task.taskCode}</Mono>} />
                <KeyValue k="任务名" v={task.taskName ?? '—'} />
                <KeyValue
                  k="进度"
                  v={
                    <>
                      {task.progress ?? 0}%
                      {task.totalItems ? (
                        <span className="w-muted">
                          {' '}
                          （{task.inspectedItems ?? 0}/{task.totalItems}）
                        </span>
                      ) : null}
                    </>
                  }
                />
              </>
            ) : (
              <span className="w-muted">当前没有进行中的巡检任务</span>
            )}
          </Card>
        </Section>

        <Section title={`未处理告警（${alerts.length}）`}>
          <Card flush>
            <ListStateHost
              loading={loading}
              error={error ? { code: error.code, text: humanize(error) } : undefined}
              items={alerts}
              emptyText="没有未处理的告警"
              onRetry={reload}
            >
              {(items) => (
                <DataList className="w-operational-list">
                  {items.map((a) => (
                    <DataRow
                      key={a.eventId}
                      id={`#${a.eventId}`}
                      main={a.title}
                      sub={shortTime(a.createTime)}
                      trailing={<LevelChip level={a.level} />}
                    />
                  ))}
                </DataList>
              )}
            </ListStateHost>
          </Card>
        </Section>
      </div>
    </Stack>
  );
}

/**
 * 告警等级芯片。
 *
 * 等级取值按旧版 `AlertLevel`：1/2/3 递增严重程度。
 * 颜色走**语义令牌**（`--w-fill-*` 作底、`--w-state-*` 作字），不写死色值 ——
 * 这条是 ui-spec §5 的硬规则，也是旧仓花了两批才收干净的地方。
 */
export function LevelChip({ level }: { level: number }): React.ReactElement {
  if (level >= 3) {
    return (
      <Chip tone="danger">
        <Dot tone="bad" />
        严重
      </Chip>
    );
  }
  if (level === 2) {
    return (
      <Chip tone="warn">
        <Dot tone="warn" />
        警告
      </Chip>
    );
  }
  return (
    <Chip tone="info">
      <Dot tone="idle" />
      提示
    </Chip>
  );
}

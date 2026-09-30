import { useEffect, useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import { BridgeError } from '@wise/bridge-client';
import {
  Card,
  Chip,
  DataList,
  DataRow,
  Dot,
  Grid,
  KeyValue,
  KpiCard,
  ListStateHost,
  Mono,
  Section,
  Stack,
} from '@wise/patterns';
import type { NavLeaf } from './navigation.js';
import { useBridgeCall } from './useBridgeCall.js';

interface DashboardSummary {
  readonly inventoryTotal: number;
  readonly todayAlertCount: number;
  readonly inspectionProgress: number;
  readonly deviceOnlineCount: number;
  readonly unprocessedAlerts?: readonly {
    readonly eventId: number;
    readonly title: string;
    readonly level: number;
    readonly createTime?: string;
  }[];
  readonly currentTask?: { readonly taskCode?: string; readonly progress?: number } | undefined;
}

/**
 * 页面内容。
 *
 * W1/W3 阶段只有"看板"做**真实取数**，其余页给四态占位 —— 目的是让每一步的验收物都是
 * "一条打通的链路"，而不是一堆好看的空壳。所有取数容器走 `ListStateHost`，
 * 因此"加载 / 空 / 错 / 内容"四种状态是**结构上必然存在**的，不靠作者记得写。
 */
export function PageBody({ bridge, leaf }: { bridge: Bridge; leaf: NavLeaf }): React.ReactElement {
  if (leaf.primaryMethod === 'dashboard.summary') {
    return <Dashboard bridge={bridge} />;
  }
  return (
    <Section title="待迁入">
      <Card>
        <Stack tight>
          <Mono>{leaf.primaryMethod}</Mono>
          <span className="w-muted">该页在 W5–W7 逐域迁入；当前占位用于验证外壳、导航与令牌。</span>
        </Stack>
      </Card>
    </Section>
  );
}

function Dashboard({ bridge }: { bridge: Bridge }): React.ReactElement {
  const { loading, data, error, reload } = useBridgeCall<DashboardSummary>(bridge, 'dashboard.summary');

  const alerts = data?.unprocessedAlerts ?? [];

  return (
    <Stack>
      <ListStateHost
        loading={loading}
        error={error ? { code: error.code, text: humanize(error) } : undefined}
        items={data ? [data] : []}
        emptyText="暂无看板数据"
        onRetry={reload}
      >
        {() => (
          <Grid>
            <KpiCard value={data?.inventoryTotal ?? 0} label="库存总量" />
            <KpiCard value={data?.todayAlertCount ?? 0} label="今日告警" />
            <KpiCard value={`${data?.inspectionProgress ?? 0}%`} label="巡检进度" />
            <KpiCard value={data?.deviceOnlineCount ?? 0} label="设备在线" />
          </Grid>
        )}
      </ListStateHost>

      {data?.currentTask?.taskCode ? (
        <Section title="当前任务">
          <Card>
            <KeyValue k="任务号" v={<Mono>{data.currentTask.taskCode}</Mono>} />
            <KeyValue k="进度" v={`${data.currentTask.progress ?? 0}%`} />
          </Card>
        </Section>
      ) : null}

      <Section title="未处理告警">
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={alerts}
            emptyText="没有未处理的告警"
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((a) => (
                  <DataRow
                    key={a.eventId}
                    id={`#${a.eventId}`}
                    main={a.title}
                    sub={a.createTime}
                    trailing={
                      <Chip tone={a.level >= 2 ? 'warn' : 'info'}>
                        <Dot tone={a.level >= 2 ? 'bad' : 'warn'} />
                        {a.level >= 2 ? '高' : '中'}
                      </Chip>
                    }
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
      </Section>

      <ScanFeed bridge={bridge} />
    </Stack>
  );
}

/** 文案映射在 Web 侧（桥只给码，延续"谁展示谁拥有"）。 */
function humanize(error: BridgeError): string {
  if (error.messageKey === 'bridge.backendUnreachable') {
    return '后端不可达，请检查网络或服务状态';
  }
  if (error.messageKey === 'error_session_expired') {
    return '登录已过期，请重新登录';
  }
  return '取数失败';
}

/** 扫码事件流：验证 `evt` 通道（订阅 / 解绑 / 重连后重订阅）。 */
function ScanFeed({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [codes, setCodes] = useState<readonly string[]>([]);

  useEffect(
    () =>
      bridge.subscribe('scan.code', (payload) => {
        const code = (payload as { code?: string } | undefined)?.code;
        if (code) {
          setCodes((prev) => [code, ...prev].slice(0, 5));
        }
      }),
    [bridge],
  );

  return (
    <Section title="最近扫码（事件通道）">
      <Card flush>
        {codes.length === 0 ? (
          <div className="w-state">
            <span>等待事件…</span>
          </div>
        ) : (
          <DataList>
            {codes.map((c) => (
              <DataRow key={c} id={c} main="扫码" />
            ))}
          </DataList>
        )}
      </Card>
    </Section>
  );
}

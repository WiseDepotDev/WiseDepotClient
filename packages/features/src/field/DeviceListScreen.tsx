import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataList,
  DataRow,
  Dot,
  Grid,
  KpiCard,
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
 * 设备管理（field/device）。
 *
 * 现场域的第一个屏：把"机器现在到底在不在线"讲清楚。
 * 三件事与库存域的列表屏刻意不同：
 * 1. **在线统计放在最上面**：操作员打开这一屏 90% 是为了确认"车/读头还在不在"，
 *    先给结论（在线几台、离线几台），再给可逐条查的名单；
 * 2. **筛选走 TabStrip**（全部/在线/离线）：这是三种平级视图，不是动作，
 *    别拿一排按钮当页签用（ui-spec §9 的组件语义分工）；
 * 3. **行内不放小图标按钮**：整行可点进详情，触控目标由行自身保证。
 *
 * 设备凭据（设备口令、刷新凭据）**不在这一屏展示** —— 它们只在设备端使用，
 * 出现在管理界面上既是安全问题也没有业务价值。
 */

interface DeviceRow {
  readonly deviceId?: number;
  readonly deviceCode?: string;
  readonly deviceName?: string;
  readonly deviceType?: number;
  readonly deviceTypeName?: string;
  readonly ipAddress?: string;
  readonly deviceStatus?: number;
  readonly deviceStatusName?: string;
  readonly lastHeartbeat?: string;
  readonly remark?: string;
}

type DeviceFilter = 'all' | 'online' | 'offline';

/** 心跳超过这个时长就按"失联"提示（秒）。现场心跳间隔为分钟级，取 5 分钟。 */
const HEARTBEAT_STALE_SECONDS = 300;

function deviceTypeText(r: DeviceRow): string {
  if (r.deviceTypeName) {
    return r.deviceTypeName;
  }
  switch (r.deviceType) {
    case 0:
      return '读头';
    case 1:
      return '摄像头';
    case 2:
      return '巡检车';
    default:
      return '类型未登记';
  }
}

/** 在线判定：服务端给了状态名就以它为准，否则退回状态码（0 离线 / 1 在线 / 2 故障）。 */
function isOnline(r: DeviceRow): boolean {
  if (r.deviceStatusName) {
    return r.deviceStatusName.includes('在线') && !r.deviceStatusName.includes('离线');
  }
  return r.deviceStatus === 1;
}

function statusText(r: DeviceRow): string {
  if (r.deviceStatusName) {
    return r.deviceStatusName;
  }
  switch (r.deviceStatus) {
    case 0:
      return '离线';
    case 1:
      return '在线';
    case 2:
      return '故障';
    default:
      return '状态未上报';
  }
}

function isFault(r: DeviceRow): boolean {
  return r.deviceStatus === 2 || (r.deviceStatusName ?? '').includes('故障');
}

/** 心跳距今多久。没有心跳记录时给业务语言，不显示空白。 */
function heartbeatText(iso: string | undefined): string {
  if (!iso) {
    return '还没有收到心跳';
  }
  const t = Date.parse(iso.replace(' ', 'T'));
  if (Number.isNaN(t)) {
    return shortTime(iso);
  }
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < HEARTBEAT_STALE_SECONDS) {
    return `${Math.round(seconds / 60)} 分钟前`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)} 小时前（已失联）`;
  }
  return `${Math.round(seconds / 86_400)} 天前（已失联）`;
}

function DeviceStatusChip({ device }: { device: DeviceRow }): React.ReactElement {
  if (isFault(device)) {
    return (
      <Chip tone="danger">
        <Dot tone="bad" />
        {statusText(device)}
      </Chip>
    );
  }
  if (isOnline(device)) {
    return (
      <Chip tone="ok">
        <Dot tone="ok" />
        {statusText(device)}
      </Chip>
    );
  }
  return (
    <Chip tone="warn">
      <Dot tone="warn" />
      {statusText(device)}
    </Chip>
  );
}

export function DeviceListScreen({
  bridge,
  onOpenDevice,
}: {
  bridge: Bridge;
  onOpenDevice?: ((device: DeviceRow) => void) | undefined;
}): React.ReactElement {
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [filter, setFilter] = useState<DeviceFilter>('all');

  // 设备总数不大（现场是几十台），一次取回后本地筛选，避免"点一下筛选取一次数"
  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'device.list', {});

  // 统计是**辅助**数据：它失败时列表仍然可用，因此不阻断渲染，只在一旁显示取不到
  const {
    loading: statLoading,
    data: statData,
    error: statError,
  } = useBridgeCall<unknown>(bridge, 'device.statistics', {});

  const all = asList<DeviceRow>(data);
  const rows = all.filter((r) => {
    if (filter === 'online' && !isOnline(r)) {
      return false;
    }
    if (filter === 'offline' && isOnline(r)) {
      return false;
    }
    if (applied) {
      const hay = `${r.deviceName ?? ''}${r.deviceCode ?? ''}${r.ipAddress ?? ''}${r.remark ?? ''}`.toLowerCase();
      if (!hay.includes(applied.toLowerCase())) {
        return false;
      }
    }
    return true;
  });

  const onlineCount = all.filter(isOnline).length;
  const stat = (statData ?? {}) as Record<string, unknown>;
  const statOnline =
    typeof stat.onlineCount === 'number'
      ? stat.onlineCount
      : typeof stat.onlineDevices === 'number'
        ? stat.onlineDevices
        : undefined;

  return (
    <Stack>
      <PageHeader
        title="设备管理"
        subtitle={
          all.length > 0
            ? `共 ${all.length} 台，在线 ${onlineCount} 台，离线 ${all.length - onlineCount} 台`
            : '巡检车、读头与摄像头的在线状态'
        }
        actions={
          <Button ariaLabel="刷新设备" onClick={reload}>
            刷新
          </Button>
        }
      />

      <Grid>
        <KpiCard value={all.length} label="设备总数" />
        <KpiCard value={onlineCount} label="当前在线" />
        <KpiCard value={Math.max(0, all.length - onlineCount)} label="离线或故障" />
        <KpiCard
          value={statOnline ?? (statLoading ? '—' : onlineCount)}
          label={statError ? '在线（统计不可用）' : '在线（服务端统计）'}
        />
      </Grid>

      <SearchField
        value={keyword}
        onChange={setKeyword}
        onSearch={() => setApplied(keyword)}
        placeholder="设备名 / 设备编号 / 网络地址"
      />

      <TabStrip>
        <TabStripItem label="全部" active={filter === 'all'} onClick={() => setFilter('all')} />
        <TabStripItem label="在线" active={filter === 'online'} onClick={() => setFilter('online')} />
        <TabStripItem label="离线 / 故障" active={filter === 'offline'} onClick={() => setFilter('offline')} />
      </TabStrip>

      <Section title={`设备列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText={
              applied || filter !== 'all'
                ? '没有符合条件的设备，试试换个关键字，或切回「全部」查看所有设备。'
                : '还没有登记设备。请联系管理员在后台添加设备，并在设备通电联网后回到本页点「刷新」确认它已上线。'
            }
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((d) => (
                  <DataRow
                    key={d.deviceId ?? d.deviceCode}
                    id={d.deviceCode ?? '编号未登记'}
                    main={d.deviceName ?? '未命名设备'}
                    sub={
                      <>
                        <span>{deviceTypeText(d)} · </span>
                        <span className="w-mono">{d.ipAddress ?? '网络地址未登记'}</span>
                        <span className="w-muted"> · 心跳 {heartbeatText(d.lastHeartbeat)}</span>
                      </>
                    }
                    trailing={<DeviceStatusChip device={d} />}
                    onSelect={() => onOpenDevice?.(d)}
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
      </Section>

      <Toolbar>
        <span className="w-muted">
          点任意一行查看该设备的详情与心跳记录；设备离线时请先确认它已通电联网。
        </span>
        <Mono>{`本页 ${rows.length} 台`}</Mono>
      </Toolbar>
    </Stack>
  );
}

export type { DeviceRow };

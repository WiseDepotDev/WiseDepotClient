import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataList,
  DataRow,
  Dot,
  Field,
  Input,
  KeyValue,
  ListStateHost,
  Mono,
  PageHeader,
  SearchField,
  Section,
  Stack,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, humanize, shortTime } from '../shared/api.js';
import type { ScreenParams } from '../registry.js';

/**
 * 设备详情（field/device 详情）。
 *
 * 一屏回答三个现场问题：
 * 1. **它是谁** —— 名称、编号、类型、网络地址；
 * 2. **它现在好不好** —— 在线状态 + 最近一次心跳距现在多久（失联要一眼看出来）；
 * 3. **它记得什么** —— 备注、登记时间，以及巡检车的行走速度与四轮微调值。
 *
 * 取数上有一处刻意的取舍：**先按编号查，编号也没有才按系统编号查**。
 * 现场拿到的是贴在机器上的编号（人眼可读），系统编号只有后台才有；
 * 因此把"编号"当主入口，这样现场人员不需要先查一次表才能点进详情。
 *
 * 设备凭据类字段**不展示**：它们只供设备端使用，出现在人工界面上没有业务价值。
 */

interface DeviceDetail {
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
  readonly createTime?: string;
  readonly updateTime?: string;
  readonly moveSpeedCmS?: number;
  readonly motorTrimA?: number;
  readonly motorTrimB?: number;
  readonly motorTrimC?: number;
  readonly motorTrimD?: number;
}

const HEARTBEAT_STALE_SECONDS = 300;

function hasDetail(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

function detailOf(value: unknown): DeviceDetail | undefined {
  if (!hasDetail(value)) {
    return undefined;
  }
  const list = asList<DeviceDetail>(value);
  return list.length > 0 ? list[0] : (value as DeviceDetail);
}

function statusText(d: DeviceDetail): string {
  if (d.deviceStatusName) {
    return d.deviceStatusName;
  }
  switch (d.deviceStatus) {
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

function typeText(d: DeviceDetail): string {
  if (d.deviceTypeName) {
    return d.deviceTypeName;
  }
  switch (d.deviceType) {
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

function isOnline(d: DeviceDetail): boolean {
  if (d.deviceStatusName) {
    return d.deviceStatusName.includes('在线') && !d.deviceStatusName.includes('离线');
  }
  return d.deviceStatus === 1;
}

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
    return `${Math.round(seconds / 3600)} 小时前，已超过免打扰时长，建议现场确认设备供电与网络`;
  }
  return `${Math.round(seconds / 86_400)} 天前，设备已长时间失联，请联系管理员排查`;
}

function numberText(value: number | undefined, unit: string): string {
  return value === undefined || value === null ? '未登记' : `${value}${unit}`;
}

export function DeviceDetailScreen({
  bridge,
  screenParams,
}: {
  bridge: Bridge;
  screenParams?: ScreenParams | undefined;
}): React.ReactElement {
  // 屏参数是字符串袋 → 设备编号原样可用，设备序号要自己转数字；
  // 序号转不出来就当"没有这个目标"，不发一个必然是错的请求。
  const paramCode = screenParams?.deviceCode;
  const rawDeviceId = screenParams?.deviceId;
  const parsedDeviceId = rawDeviceId !== undefined ? Number(rawDeviceId) : Number.NaN;
  const paramId = Number.isFinite(parsedDeviceId) && parsedDeviceId > 0 ? parsedDeviceId : undefined;

  const [codeInput, setCodeInput] = useState(paramCode ?? '');
  const [idInput, setIdInput] = useState('');
  // 显式带 `| undefined`：本仓开了 `exactOptionalPropertyTypes`，
  // "把外部传来的可选编号原样放进可选项"只有这样才能成立
  const [lookup, setLookup] = useState<{ code?: string | undefined; id?: number | undefined }>({
    code: paramCode,
    id: paramId,
  });
  const [lookupError, setLookupError] = useState<string | undefined>(undefined);

  const hasTarget = Boolean(lookup.code) || lookup.id !== undefined;
  // `enabled`：没有查询目标时不发请求。否则每次进这一屏都会向真后端发两次注定失败的调用
  // （缺 deviceId/deviceCode），日志里看着像"这个屏一直在报错"。
  const byCode = useBridgeCall<unknown>(
    bridge,
    'device.byCode',
    lookup.code ? { deviceCode: lookup.code } : undefined,
    { enabled: Boolean(lookup.code) },
  );
  const byId = useBridgeCall<unknown>(
    bridge,
    'device.detail',
    lookup.id !== undefined && !lookup.code ? { deviceId: lookup.id } : undefined,
    { enabled: lookup.id !== undefined && !lookup.code },
  );

  // 有编号时以编号查询为准（现场贴的就是编号），否则回落到系统编号查询
  const active = lookup.code ? byCode : byId;
  const detail = detailOf(active.data);
  const loading = hasTarget ? active.loading : false;
  const error = hasTarget ? active.error : undefined;
  const reload = (): void => {
    active.reload();
  };

  const openByCode = (): void => {
    const code = codeInput.trim();
    if (!code) {
      setLookupError('请输入设备编号后再查询');
      return;
    }
    setLookupError(undefined);
    setLookup({ code });
  };

  const openById = (): void => {
    const id = Number(idInput.trim());
    if (!Number.isFinite(id) || id <= 0) {
      setLookupError('请输入正确的设备序号（正整数）');
      return;
    }
    setLookupError(undefined);
    setLookup({ id });
  };

  return (
    <Stack>
      <PageHeader
        title={detail?.deviceName ?? '设备详情'}
        subtitle={
          detail?.deviceCode
            ? `设备编号 ${detail.deviceCode} · ${typeText(detail)}`
            : '查看某台设备的在线状态、心跳与参数'
        }
        actions={
          <Button variant="primary" ariaLabel="刷新设备详情" disabled={!hasTarget} onClick={reload}>
            刷新
          </Button>
        }
      />

      <Section title="按设备编号查询">
        <Card>
          <Stack>
            <SearchField value={codeInput} onChange={setCodeInput} onSearch={openByCode} placeholder="设备编号（机器标签上的编号）" />
            <Toolbar>
              <Field label="或者按设备序号查询">
                <Input value={idInput} onChange={setIdInput} onEnter={openById} placeholder="如：12" mono />
              </Field>
              <Button ariaLabel="查询设备" onClick={openById}>
                查询
              </Button>
            </Toolbar>
            {lookupError ? (
              <div className="w-state w-state--error">
                <span>{lookupError}</span>
              </div>
            ) : null}
          </Stack>
        </Card>
      </Section>

      <Section title="设备信息">
        <Card>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={detail ? [detail] : []}
            emptyText={
              hasTarget
                ? '没有找到这台设备。请核对编号是否正确，或联系管理员确认设备已在后台登记。'
                : '还没有选择设备。请在上方输入设备编号后点「查询」，或从设备列表点选一台设备。'
            }
            onRetry={reload}
          >
            {(items) => {
              const d = items[0] ?? {};
              return (
                <Stack tight>
                  <Toolbar>
                    {isOnline(d) ? (
                      <Chip tone="ok">
                        <Dot tone="ok" />
                        {statusText(d)}
                      </Chip>
                    ) : (
                      <Chip tone="warn">
                        <Dot tone="warn" />
                        {statusText(d)}
                      </Chip>
                    )}
                    <span className="w-muted">{`心跳 ${heartbeatText(d.lastHeartbeat)}`}</span>
                    {d.lastHeartbeat ? <Mono>{shortTime(d.lastHeartbeat)}</Mono> : null}
                  </Toolbar>
                  <KeyValue k="设备名称" v={d.deviceName ?? '未命名设备'} />
                  <KeyValue k="设备编号" v={<Mono>{d.deviceCode ?? '未登记'}</Mono>} />
                  <KeyValue k="设备类型" v={typeText(d)} />
                  <KeyValue k="网络地址" v={<Mono>{d.ipAddress ?? '未登记'}</Mono>} />
                  <KeyValue k="登记时间" v={d.createTime ? shortTime(d.createTime) : '未登记'} />
                  <KeyValue k="最近更新" v={d.updateTime ? shortTime(d.updateTime) : '暂无更新记录'} />
                  <KeyValue k="备注" v={d.remark ?? '没有备注'} />
                </Stack>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Section title="行走参数">
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={detail ? [detail] : []}
            emptyText="查询到设备后，这里会显示它的行走速度与四轮微调值（仅巡检车有这些参数）。"
            onRetry={reload}
          >
            {(items) => {
              const d = items[0] ?? {};
              return (
                <DataList>
                  <DataRow main="行走速度" sub="设备按此速度沿货架行进" trailing={<Mono>{numberText(d.moveSpeedCmS, ' 厘米/秒')}</Mono>} />
                  <DataRow main="车轮微调 A" sub="数值越大该轮出力越多" trailing={<Mono>{numberText(d.motorTrimA, '')}</Mono>} />
                  <DataRow main="车轮微调 B" sub="数值越大该轮出力越多" trailing={<Mono>{numberText(d.motorTrimB, '')}</Mono>} />
                  <DataRow main="车轮微调 C" sub="数值越大该轮出力越多" trailing={<Mono>{numberText(d.motorTrimC, '')}</Mono>} />
                  <DataRow main="车轮微调 D" sub="数值越大该轮出力越多" trailing={<Mono>{numberText(d.motorTrimD, '')}</Mono>} />
                </DataList>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Toolbar>
        <span className="w-muted">
          参数由设备端上报。如需修改，请联系管理员在后台下发，不要在本页直接改动运行中的设备。
        </span>
      </Toolbar>
    </Stack>
  );
}

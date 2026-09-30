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
import { LevelChip } from './DashboardScreen.js';
import type { ScreenParams } from '../registry.js';

/**
 * 告警详情（overview/alerts 的单条告警页面）。
 *
 * 这一屏按"现场会问的三个问题"排顺序：
 * 1. **出了什么事** —— 标题、内容、等级、来源模块、产生时间；
 * 2. **谁在处理** —— 处理记录（什么时候、谁、留下什么说明、结果是什么）；
 * 3. **我现在能做什么** —— 确认收到 / 处理完成 / 忽略；做不了的按钮要写明为什么。
 *
 * 四条刻意的选择：
 *
 * 1. **状态码表不新造**：取值只认服务端枚举 `AlertStatus`（0 未处理 / 1 处理中 /
 *    2 已处理 / 3 已忽略）。归一化接住三种形状（数字码、枚举名、服务端已经译好的中文），
 *    认不出就如实说"状态未上报"，不猜一个最像的状态。等级芯片**直接复用列表屏的
 *    `LevelChip`**，避免同一件事在两屏上长出两套说法。
 *
 * 2. **动作按状态决定，不能做的把原因写在按钮旁边**：服务端 `acknowledgeAlert` 对
 *    非「未处理」的告警**没有任何副作用地直接返回**（"如果已经是处理状态，则无需重复ACK"），
 *    而 `updateAlertStatus` 对状态流转**不做任何校验**（照请求里的数字写库）。
 *    也就是说"这一步能不能点"只有界面说得清 —— 让操作员点一下才发现没反应，
 *    等于把服务端的实现细节丢给用户。
 *
 * 3. **结束类动作不可撤销，走二次确认**：记为「已处理」时服务端同时写下解除时间、
 *    记录解除人并把告警置为非活跃；「已忽略」同样是终态（本屏不提供"重新打开"，
 *    因为服务端没有这个能力，摆一个点了没用的按钮比没有按钮更糟）。
 *
 * 4. **忽略必须写原因**：原因会进处理记录（服务端写进处理日志的 `remark`）。
 *    忽略一条告警而不说为什么，下一个翻记录的人只会看到一个没有解释的「已忽略」。
 */

interface AlertDetail {
  readonly eventId?: number;
  readonly title?: string;
  readonly message?: string;
  readonly level?: number;
  /** 可能给数字码，也可能给枚举名 —— 归一化在下面统一处理。 */
  readonly status?: number | string;
  readonly sourceModule?: string;
  readonly isActive?: boolean;
  readonly createTime?: string;
  readonly resolvedTime?: string;
  readonly resolvedBy?: number;
  readonly extendedData?: string;
}

interface HandleLog {
  readonly logId?: number;
  readonly handlerId?: number;
  readonly handlerName?: string;
  readonly goalStatus?: number | string;
  readonly goalStatusDescription?: string;
  readonly remark?: string;
  readonly handleTime?: string;
}

export type AlertState = 'pending' | 'processing' | 'resolved' | 'ignored' | 'unknown';

/** 服务端 `AlertStatus`：PENDING(0) / PROCESSING(1) / RESOLVED(2) / IGNORED(3)。 */
const STATE_BY_CODE: Readonly<Record<number, AlertState>> = {
  0: 'pending',
  1: 'processing',
  2: 'resolved',
  3: 'ignored',
};

/** 服务端同义的另外两种写法：枚举名与它译好的中文（`statusDescription` 就是这四个词）。 */
const STATE_BY_TEXT: Readonly<Record<string, AlertState>> = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  RESOLVED: 'resolved',
  IGNORED: 'ignored',
  未处理: 'pending',
  处理中: 'processing',
  已处理: 'resolved',
  已忽略: 'ignored',
};

/** 先按数字码，再按文本（"1" 这种字符串也当数字码处理）。 */
function normalize(value: unknown): { code?: number; text?: string } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { code: value };
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const t = value.trim();
    const asNumber = Number(t);
    return Number.isFinite(asNumber) ? { code: asNumber } : { text: t.toUpperCase() };
  }
  return {};
}

export interface AlertStateFields {
  /** 服务端 `AlertDTO.status`（数字码或枚举名，两种形状都见过）。 */
  readonly status?: unknown;
}

export function alertStateOf(alert: AlertStateFields | undefined): AlertState {
  const { code, text } = normalize(alert?.status);
  if (code !== undefined) {
    const byCode = STATE_BY_CODE[code];
    if (byCode !== undefined) {
      return byCode;
    }
  }
  if (text !== undefined) {
    const byText = STATE_BY_TEXT[text];
    if (byText !== undefined) {
      return byText;
    }
  }
  return 'unknown';
}

export function alertStateText(state: AlertState): string {
  switch (state) {
    case 'pending':
      return '未处理';
    case 'processing':
      return '处理中';
    case 'resolved':
      return '已处理';
    case 'ignored':
      return '已忽略';
    default:
      return '状态未上报';
  }
}

function stateTone(state: AlertState): 'neutral' | 'info' | 'ok' | 'warn' | 'danger' {
  switch (state) {
    case 'pending':
      return 'warn';
    case 'processing':
      return 'info';
    case 'resolved':
      return 'ok';
    default:
      return 'neutral';
  }
}

function stateDotTone(state: AlertState): 'ok' | 'warn' | 'bad' | 'idle' {
  switch (state) {
    case 'pending':
      return 'warn';
    case 'processing':
    case 'resolved':
      return 'ok';
    default:
      return 'idle';
  }
}

function StateChip({ state }: { state: AlertState }): React.ReactElement {
  return (
    <Chip tone={stateTone(state)}>
      <Dot tone={stateDotTone(state)} />
      {alertStateText(state)}
    </Chip>
  );
}

/**
 * 来源模块 → 业务语言。
 *
 * 取值来自服务端的实际写入点（`AlertApplicationService` 的统计口径与
 * `AlertRuleService` 的四条规则 + 手动创建）。认不出的原样显示，不翻译成猜的词。
 */
const MODULE_TEXT: Readonly<Record<string, string>> = {
  DEVICE: '设备',
  INVENTORY: '库存',
  RFID_VIDEO: '识别与视频比对',
  PRODUCT_MOVEMENT: '商品移动',
  SYSTEM: '系统',
  MANUAL: '人工上报',
};

function sourceModuleText(alert: AlertDetail | undefined): string {
  const raw = alert?.sourceModule;
  if (raw === undefined || raw.trim() === '') {
    return '来源未登记';
  }
  const key = raw.trim().toUpperCase();
  return MODULE_TEXT[key] ?? raw;
}

function timeText(value: string | undefined, fallback: string): string {
  const t = shortTime(value);
  return t === '' ? fallback : t;
}

function hasDetail(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/** 详情接口可能直接给一条告警，也可能裹一层（两种形状都见过），这里都接住。 */
function detailOf(value: unknown): AlertDetail | undefined {
  if (!hasDetail(value)) {
    return undefined;
  }
  const list = asList<AlertDetail>(value);
  return list.length > 0 ? list[0] : (value as AlertDetail);
}

/**
 * 扩展信息里的设备名。
 *
 * 服务端**没有给结构化字段**：设备离线告警把设备写成了一句人话
 * （`AlertRuleService.createDeviceOfflineAlert` 拼的 `message`：
 * "设备：{名称}（{类型}）离线，最后心跳时间：…"），而 `extendedData` 这条扩展信息
 * 在后端从来没被写入过。所以这里只做"有就用"：将来后端补上结构化字段，这一行自动就好了；
 * 现在取不到就如实说未登记，让人去看「告警内容」——不编一个看起来像设备名的东西。
 */
function deviceFromExtendedData(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const o = parsed as Record<string, unknown>;
  const name = typeof o.deviceName === 'string' && o.deviceName.trim() !== '' ? o.deviceName.trim() : undefined;
  const code = typeof o.deviceCode === 'string' && o.deviceCode.trim() !== '' ? o.deviceCode.trim() : undefined;
  if (name !== undefined && code !== undefined) {
    return `${name}（编号 ${code}）`;
  }
  return name ?? code;
}

function deviceText(alert: AlertDetail | undefined): string {
  const fromExtra = deviceFromExtendedData(alert?.extendedData);
  if (fromExtra !== undefined) {
    return fromExtra;
  }
  return '没有单独登记设备，设备信息写在「告警内容」里';
}

function activeText(alert: AlertDetail | undefined): string {
  if (alert?.isActive === true) {
    return '仍在发生';
  }
  if (alert?.isActive === false) {
    return '已经不再发生';
  }
  return '未上报';
}

/** 处理记录的结果：服务端已经译好的中文优先，认不出才退回码表。 */
function logResultText(log: HandleLog): string {
  const named = log.goalStatusDescription;
  if (typeof named === 'string' && named.trim() !== '') {
    return named.trim();
  }
  const raw = log.goalStatus;
  if (raw === undefined || raw === null) {
    return '结果未上报';
  }
  const state = alertStateOf({ status: raw });
  return state === 'unknown' ? '结果未上报' : alertStateText(state);
}

function logStateOf(log: HandleLog): AlertState {
  const named = log.goalStatusDescription;
  if (typeof named === 'string' && named.trim() !== '') {
    const byText = STATE_BY_TEXT[named.trim()];
    if (byText !== undefined) {
      return byText;
    }
  }
  return alertStateOf({ status: log.goalStatus });
}

/**
 * 一次待确认的动作。
 *
 * 与出入库单详情屏同一套写法：确认弹窗的标题、按钮文案、请求体、成功提示都跟着动作走，
 * 用同一个枚举驱动就不会出现"弹窗说的是忽略、实际发的是处理完成"这种只在生产环境现身的错位。
 */
type PendingAction = { readonly kind: 'ack' } | { readonly kind: 'resolve' } | { readonly kind: 'ignore' };

/** 已处理 / 已忽略 = 终态（服务端没有"重新打开"，本屏也不假装有）。 */
const FINAL_STATES: readonly AlertState[] = ['resolved', 'ignored'];

export function AlertDetailScreen({
  bridge,
  screenParams,
}: {
  bridge: Bridge;
  screenParams?: ScreenParams | undefined;
}): React.ReactElement {
  // 屏参数是字符串袋 → 告警序号要自己转数字；转不出来就当"没有这个目标"，
  // 不发一个必然是错的请求（服务端只认数字序号）。
  const rawEventId = screenParams?.eventId;
  const parsedEventId = rawEventId === undefined ? Number.NaN : Number(rawEventId.trim());
  const eventId = Number.isFinite(parsedEventId) && parsedEventId > 0 ? parsedEventId : undefined;
  const hasTarget = eventId !== undefined;

  const [pending, setPending] = useState<PendingAction | undefined>(undefined);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const params = eventId !== undefined ? { eventId } : undefined;

  // `enabled`：没有目标时不发请求 —— 缺参数的调用到服务端必然是错，
  // 白占一次往返，还会在日志里装成"这一屏一直在报错"。
  const detailCall = useBridgeCall<unknown>(bridge, 'alert.detail', params, { enabled: hasTarget });
  const logsCall = useBridgeCall<unknown>(bridge, 'alert.logs', params, { enabled: hasTarget });

  const alert = detailOf(detailCall.data);
  const logs = asList<HandleLog>(logsCall.data);
  const state = alertStateOf(alert);

  const reloadAll = (): void => {
    detailCall.reload();
    logsCall.reload();
  };

  const canAck = state === 'pending';
  const canFinish = state === 'pending' || state === 'processing';

  const ackReason =
    state === 'unknown'
      ? '这条告警没有带状态信息，先刷新一次；如果一直没有状态，请联系管理员核对这条告警。'
      : '已经确认过了 —— 确认只登记一次，不会重复记录。';
  const finishReason =
    state === 'unknown'
      ? '这条告警没有带状态信息，先刷新一次；如果一直没有状态，请联系管理员核对这条告警。'
      : `这条告警已经结束（${alertStateText(state)}），不能再改状态；如果问题又出现了，请让上报的一方重新发一条告警。`;

  const closeDialog = (): void => {
    setPending(undefined);
    setRemark('');
  };

  const openDialog = (action: PendingAction): void => {
    setActionError(undefined);
    setNotice(undefined);
    setRemark('');
    setPending(action);
  };

  const runAction = async (): Promise<void> => {
    const action = pending;
    if (action === undefined || eventId === undefined) {
      closeDialog();
      return;
    }

    if (action.kind === 'ack') {
      setBusy(true);
      setActionError(undefined);
      setNotice(undefined);
      try {
        await bridge.call('alert.ack', { eventId });
        setNotice('已确认收到，这条告警记为「处理中」。处理完记得回到这里点「处理完成」。');
        closeDialog();
        reloadAll();
      } catch (e) {
        setActionError(humanize(e as never));
      } finally {
        setBusy(false);
      }
      return;
    }

    const text = remark.trim();
    if (action.kind === 'ignore' && text.length < 2) {
      setActionError('请写清楚忽略的原因（至少 2 个字），下一个翻记录的人要照着它判断。');
      return;
    }

    // 只带服务端认识的字段；没填说明就不发这个键（服务端写进处理记录的 remark）
    const body: { eventId: number; status: number; remark?: string } = {
      eventId,
      status: action.kind === 'resolve' ? 2 : 3,
    };
    if (text.length > 0) {
      body.remark = text;
    }

    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      await bridge.call('alert.status', body);
      setNotice(
        action.kind === 'resolve'
          ? '已记为「处理完成」，解除时间已经记下，这条告警不再计入待处理。'
          : '已忽略这条告警，忽略原因已写进处理记录。',
      );
      closeDialog();
      reloadAll();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const dialogTitle =
    pending === undefined
      ? ''
      : pending.kind === 'ack'
        ? '确认收到这条告警'
        : pending.kind === 'resolve'
          ? '把这条告警记为已处理'
          : '忽略这条告警';

  const dialogConfirmLabel =
    pending === undefined ? '确认' : pending.kind === 'ack' ? '确认收到' : pending.kind === 'resolve' ? '处理完成' : '忽略';

  return (
    <Stack>
      <PageHeader
        title={alert?.title ?? '告警详情'}
        subtitle={
          alert
            ? `#${alert.eventId ?? eventId ?? '编号未登记'} · ${sourceModuleText(alert)} · ${alertStateText(state)}`
            : '查看一条告警的详细情况、处理记录与可做的操作'
        }
        actions={
          <Button variant="primary" ariaLabel="刷新告警详情" disabled={!hasTarget || busy} onClick={reloadAll}>
            刷新
          </Button>
        }
      />

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

      <Section title="告警信息">
        <Card>
          <ListStateHost
            loading={detailCall.loading}
            error={detailCall.error ? { code: detailCall.error.code, text: humanize(detailCall.error) } : undefined}
            items={alert ? [alert] : []}
            emptyText={
              hasTarget
                ? '没有找到这条告警。请回到「告警中心」重新点选一条，或核对编号是否正确。'
                : '没有收到要打开的告警。请回到「告警中心」，点一条告警进来查看详情。'
            }
            onRetry={detailCall.reload}
          >
            {(items) => {
              const a = items[0] ?? {};
              return (
                <Stack tight>
                  <Toolbar>
                    <StateChip state={state} />
                    {typeof a.level === 'number' ? (
                      <LevelChip level={a.level} />
                    ) : (
                      <Chip tone="neutral">
                        <Dot tone="idle" />
                        等级未上报
                      </Chip>
                    )}
                    <Mono>{a.eventId !== undefined ? `#${a.eventId}` : '编号未登记'}</Mono>
                  </Toolbar>
                  <KeyValue k="告警标题" v={a.title ?? '标题未登记'} />
                  <KeyValue k="告警内容" v={a.message ?? '没有填写内容'} />
                  <KeyValue
                    k="告警等级"
                    v={
                      typeof a.level === 'number' ? (
                        <LevelChip level={a.level} />
                      ) : (
                        '等级未上报，可向管理员核对该条告警的登记信息'
                      )
                    }
                  />
                  <KeyValue k="当前状态" v={alertStateText(state)} />
                  <KeyValue k="来源模块" v={sourceModuleText(a)} />
                  <KeyValue k="关联设备" v={deviceText(a)} />
                  <KeyValue k="是否仍在发生" v={activeText(a)} />
                  <KeyValue k="产生时间" v={timeText(a.createTime, '时间未记录')} />
                  <KeyValue
                    k="解除时间"
                    v={a.resolvedTime ? timeText(a.resolvedTime, '时间未记录') : '还没有解除'}
                  />
                  <KeyValue
                    k="解除人"
                    v={a.resolvedBy !== undefined ? `编号 ${a.resolvedBy}` : '解除人未记录'}
                  />
                </Stack>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Section title={`处理记录${logs.length > 0 ? `（${logs.length} 条）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={logsCall.loading}
            error={logsCall.error ? { code: logsCall.error.code, text: humanize(logsCall.error) } : undefined}
            items={logs}
            emptyText={
              hasTarget
                ? '这条告警还没有处理记录。确认收到或处理后，这里会按时间列出每一步。'
                : '没有收到要打开的告警。请回到「告警中心」，点一条告警进来查看它的处理记录。'
            }
            onRetry={logsCall.reload}
          >
            {(items) => (
              <DataList>
                {items.map((l, index) => {
                  const logState = logStateOf(l);
                  return (
                    <DataRow
                      key={l.logId ?? `${l.handleTime ?? 'time'}-${index}`}
                      id={l.handleTime ? timeText(l.handleTime, '时间未记录') : '时间未记录'}
                      main={l.handlerName ?? '处理人未记录'}
                      sub={
                        l.remark && l.remark.trim() !== '' ? (
                          <span className="w-muted">{l.remark}</span>
                        ) : (
                          <span className="w-muted">没有留下说明</span>
                        )
                      }
                      trailing={
                        <Chip tone={stateTone(logState)}>
                          <Dot tone={stateDotTone(logState)} />
                          {logResultText(l)}
                        </Chip>
                      }
                    />
                  );
                })}
              </DataList>
            )}
          </ListStateHost>
        </Card>
        <div className="w-state">
          <span>
            处理记录由系统按时间登记。某一行的处理人是「处理人未记录」，表示这条记录没有带处理人信息（例如系统自动登记的那一步）。
          </span>
        </div>
      </Section>

      <Section title="可以做的操作">
        <Card>
          <Stack>
            <Toolbar>
              <Button
                variant="primary"
                ariaLabel="确认收到这条告警"
                disabled={!hasTarget || busy || !canAck}
                onClick={() => openDialog({ kind: 'ack' })}
              >
                确认收到
              </Button>
              <Button
                ariaLabel="把这条告警记为已处理"
                disabled={!hasTarget || busy || !canFinish}
                onClick={() => openDialog({ kind: 'resolve' })}
              >
                处理完成
              </Button>
              <Button
                variant="danger"
                ariaLabel="忽略这条告警"
                disabled={!hasTarget || busy || !canFinish}
                onClick={() => openDialog({ kind: 'ignore' })}
              >
                忽略
              </Button>
            </Toolbar>
            {/* 不能做的动作把原因写在旁边：让操作员点了才知道不行，是把服务端的实现细节丢给他 */}
            <Stack tight>
              <span className="w-muted">
                {canAck
                  ? '确认收到：记为「处理中」，表示已经有人接手，处理记录里会留下这一步。'
                  : `确认收到：暂时不能做 —— ${ackReason}`}
              </span>
              <span className="w-muted">
                {canFinish
                  ? '处理完成：确认问题已经解决，会记下解除时间，这条告警不再计入待处理。'
                  : `处理完成：暂时不能做 —— ${finishReason}`}
              </span>
              <span className="w-muted">
                {canFinish
                  ? '忽略：确认这条告警不需要处理（例如重复上报、现场核对为误报），需要在弹窗里写清楚原因。'
                  : `忽略：暂时不能做 —— ${finishReason}`}
              </span>
              {FINAL_STATES.includes(state) ? (
                <span className="w-muted">
                  这条告警已经结束，本页只保留它的记录。全部告警请回到「告警中心」查看。
                </span>
              ) : null}
            </Stack>
          </Stack>
        </Card>
      </Section>

      <ConfirmDialog
        open={pending !== undefined}
        title={dialogTitle}
        danger={pending !== undefined && pending.kind !== 'ack'}
        confirmLabel={dialogConfirmLabel}
        message={
          <Stack>
            <span>
              {pending?.kind === 'ack'
                ? '确认后这条告警记为「处理中」，表示已经有人接手。这一步只为登记，不影响它是否仍然发生。'
                : pending?.kind === 'resolve'
                  ? '确认后这条告警记为「已处理」，并记下解除时间，之后不能再改状态。'
                  : '忽略后这条告警记为「已忽略」，之后不能再改状态，原因会留在处理记录里。'}
            </span>
            <span className="w-muted">
              {`${alert?.title ?? '标题未登记'} · ${sourceModuleText(alert)} · ${alertStateText(state)}`}
            </span>
            {pending?.kind === 'ignore' ? (
              <Field label="忽略原因 *">
                <Input
                  value={remark}
                  onChange={setRemark}
                  placeholder="如：现场核对为重复上报，实物数量正确"
                  ariaLabel="忽略原因"
                />
              </Field>
            ) : null}
            {pending?.kind === 'resolve' ? (
              <Field label="处理说明（可不填）">
                <Input
                  value={remark}
                  onChange={setRemark}
                  placeholder="如：已重新固定货位并把数量补回"
                  ariaLabel="处理说明"
                />
              </Field>
            ) : null}
            {actionError ? <span className="w-state w-state--error">{actionError}</span> : null}
          </Stack>
        }
        onConfirm={() => void runAction()}
        onCancel={closeDialog}
      />
    </Stack>
  );
}

/**
 * 服务端规则（照抄 `AlertApplicationService` / `AlertController`，改动要同步这里）：
 *
 * · 查询详情：`GET /api/alerts/{eventId}` —— "成功返回200；告警不存在返回404"；
 *   服务端实现：找不到时抛 `NOT_FOUND("告警不存在")`。
 * · 确认告警：`POST /api/alerts/{eventId}/ack` —— "快速确认告警。成功返回200；
 *   告警不存在返回404"。服务端实现：**已经是处理状态（status != 0）时直接 return**，
 *   不写库、不记日志、也不报错；只有 status == 0 才置 status=1，
 *   并写一条处理记录（goalStatus=1、remark="快速确认"、处理人固定写成编号 1、时间取当前）。
 *   所以「确认收到」在界面上的可用条件就是"当前未处理"，重复点没有任何意义。
 * · 更新状态：`PUT /api/alerts/{eventId}/status`（请求体 status / handlerId / remark）——
 *   "成功返回200；告警不存在返回404；参数错误返回400"。服务端实现：status 为空 → 拒绝
 *   （"告警状态不能为空"）；否则**照请求里的数字直接写库，不校验状态流转**；
 *   只有当 status == 2 时额外记下 resolvedBy（取请求里的 handlerId）、resolvedTime（当前时间）
 *   并把 isActive 置为 false；status 为 3（已忽略）不改 isActive。
 *   之后同样写一条处理记录（goalStatus=请求状态、remark=请求 remark、处理人=请求 handlerId）。
 *   本屏据此把「处理完成」= status 2、「忽略」= status 3，且只允许从未处理/处理中发起。
 * · 状态码：0 未处理 / 1 处理中 / 2 已处理 / 3 已忽略（`AlertStatus` 枚举）。
 * · 等级码：0 提示 / 1 一般 / 2 严重 / 3 紧急（`AlertLevel` 枚举）。
 *   列表屏的等级芯片口径是 1/2/3 递增（>=3 严重、=2 警告、其余提示），本屏沿用同一组件。
 * · 处理记录：`GET /api/alerts/{eventId}/logs` —— 返回 `{total, rows[]}`，每行
 *   `{logId, eventId, handlerId, handlerName, goalStatus, goalStatusDescription, remark, handleTime}`；
 *   handlerName 由服务端按 handlerId 查用户表得到，查不到就是空。
 * · 本屏**不代替用户填处理人**：状态更新请求里不带 handlerId，因此这类记录在处理记录里
 *   会显示"处理人未记录"。要带上处理人，需要先取当前登录用户的编号再随请求一起发。
 * · 关联设备：服务端没有任何结构化设备字段（设备信息写在 `message` 这句人话里，
 *   `extendedData` 从未被写入），因此本屏优先从扩展信息里取结构化字段、取不到就如实说明。
 */

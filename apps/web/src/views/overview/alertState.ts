import { asList, shortTime } from '@wise/stores';
import type { StatusTone } from '@wise/ui';

/**
 * 告警域的业务规则（从 React 版 `AlertDetailScreen.tsx` **逐条搬过来**，没有重新发明）。
 *
 * ## 为什么状态归一化要吃掉三种形状
 *
 * 服务端同一个语义有三种写法都见过：数字码（`AlertStatus` 0/1/2/3）、枚举名
 * （`PENDING`/`PROCESSING`/…）、以及译好的中文（`未处理`/`处理中`/…，
 * `statusDescription` 就是这四个词）。只认一种的后果是**同一条告警在不同接口
 * 下显示成不同状态**，而排障的人会以为是数据错乱。
 */

export interface AlertItem {
  readonly eventId?: number;
  readonly title?: string;
  readonly message?: string;
  readonly level?: number;
  readonly status?: number | string;
  readonly sourceModule?: string;
  readonly createTime?: string;
}

export interface AlertDetail extends AlertItem {
  readonly isActive?: boolean;
  readonly resolvedTime?: string;
  readonly resolvedBy?: number;
  readonly extendedData?: string;
}

export interface HandleLog {
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

export function alertStateOf(alert: { readonly status?: unknown } | undefined): AlertState {
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

export function alertStateTone(state: AlertState): StatusTone {
  switch (state) {
    case 'pending':
      return 'warning';
    case 'processing':
      return 'info';
    case 'resolved':
      return 'success';
    case 'ignored':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/* ---------- 等级 ---------- */

/** 等级取值按旧版 `AlertLevel`：1/2/3 递增严重程度。 */
export function levelText(level: number | undefined): string {
  if (level === undefined) {
    return '等级未上报';
  }
  if (level >= 3) {
    return '严重';
  }
  if (level === 2) {
    return '警告';
  }
  return '提示';
}

export function levelTone(level: number | undefined): StatusTone {
  if (level === undefined) {
    return 'neutral';
  }
  if (level >= 3) {
    return 'danger';
  }
  if (level === 2) {
    return 'warning';
  }
  return 'info';
}

/* ---------- 来源模块 ---------- */

/**
 * 来源模块 → 业务语言。
 *
 * 取值来自服务端的实际写入点（`AlertApplicationService` 的统计口径与
 * `AlertRuleService` 的四条规则 + 手动创建）。**认不出的原样显示**，不翻译成猜的词。
 */
const MODULE_TEXT: Readonly<Record<string, string>> = {
  DEVICE: '设备',
  INVENTORY: '库存',
  RFID_VIDEO: '识别与视频比对',
  PRODUCT_MOVEMENT: '商品移动',
  SYSTEM: '系统',
  MANUAL: '人工上报',
};

export function sourceModuleText(raw: string | null | undefined): string {
  // `?? ''` 而不是只判 undefined：**真后端会把没填的字段回成 `null`**，
  // 只判 undefined 会让 `raw.trim()` 在 null 上抛 TypeError（真机实测时才发现）。
  const text = raw ?? '';
  if (text.trim() === '') {
    return '来源未登记';
  }
  const key = text.trim().toUpperCase();
  return MODULE_TEXT[key] ?? text;
}

/* ---------- 详情形状 ---------- */

function hasKeys(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/** 详情接口可能直接给一条告警，也可能裹一层（两种形状都见过），这里都接住。 */
export function alertDetailOf(value: unknown): AlertDetail | undefined {
  if (!hasKeys(value)) {
    return undefined;
  }
  const list = asList<AlertDetail>(value);
  return list.length > 0 ? list[0] : (value as AlertDetail);
}

/**
 * 扩展信息里的设备名。
 *
 * 服务端**没有给结构化字段**：设备离线告警把设备写成了一句人话（拼在 `message` 里），
 * 而 `extendedData` 在后端从来没被写入过。所以这里只做"有就用"：
 * 将来后端补上结构化字段，这一行自动就好了；现在取不到就**如实说未登记**，
 * 让人去看「告警内容」—— 不编一个看起来像设备名的东西。
 */
export function deviceFromExtendedData(raw: string | null | undefined): string | undefined {
  // 同样要接住 null（真后端对空字段给 null，不是 undefined）
  const text = raw ?? '';
  if (text.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
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

export function deviceText(alert: AlertDetail | undefined): string {
  const fromExtra = deviceFromExtendedData(alert?.extendedData);
  return fromExtra ?? '没有单独登记设备，设备信息写在「告警内容」里';
}

export function activeText(alert: AlertDetail | undefined): string {
  if (alert?.isActive === true) {
    return '仍在发生';
  }
  if (alert?.isActive === false) {
    return '已经不再发生';
  }
  return '未上报';
}

export function timeText(value: string | undefined, fallback: string): string {
  const t = shortTime(value);
  return t === '' ? fallback : t;
}

/* ---------- 处理记录 ---------- */

/** 处理记录的结果：服务端已经译好的中文优先，认不出才退回码表。 */
export function logResultText(log: HandleLog): string {
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

export function logStateOf(log: HandleLog): AlertState {
  const named = log.goalStatusDescription;
  if (typeof named === 'string' && named.trim() !== '') {
    const byText = STATE_BY_TEXT[named.trim()];
    if (byText !== undefined) {
      return byText;
    }
  }
  return alertStateOf({ status: log.goalStatus });
}

/* ---------- 动作可达性 ---------- */

export type AlertActionKind = 'ack' | 'resolve' | 'ignore';

/** 已处理 / 已忽略 = 终态（服务端没有"重新打开"，本屏也不假装有）。 */
export const FINAL_STATES: readonly AlertState[] = ['resolved', 'ignored'];

/**
 * 这一步能不能点，以及**不能点时把原因说清楚**。
 *
 * 为什么这条必须由界面负责：服务端 `acknowledgeAlert` 对非「未处理」的告警
 * **没有任何副作用地直接返回**（"如果已经是处理状态，则无需重复ACK"），
 * 而 `updateAlertStatus` 对状态流转**不做任何校验**（照请求里的数字写库）。
 * 也就是说"能不能点"只有界面说得清 —— 让操作员点一下才发现没反应，
 * 等于把服务端的实现细节丢给用户。
 */
export interface ActionAvailability {
  readonly enabled: boolean;
  /** 不可点时的原因（会显示在按钮旁边）。 */
  readonly reason: string;
}

const UNKNOWN_REASON = '这条告警没有带状态信息，先刷新一次；如果一直没有状态，请联系管理员核对这条告警。';

export function alertActionsOf(state: AlertState): Readonly<Record<AlertActionKind, ActionAvailability>> {
  const canAck = state === 'pending';
  const canFinish = state === 'pending' || state === 'processing';
  return {
    ack: {
      enabled: canAck,
      reason: state === 'unknown' ? UNKNOWN_REASON : '已经确认过了 —— 确认只登记一次，不会重复记录。',
    },
    resolve: {
      enabled: canFinish,
      reason:
        state === 'unknown'
          ? UNKNOWN_REASON
          : `这条告警已经结束（${alertStateText(state)}），不能再改状态；如果问题又出现了，请让上报的一方重新发一条告警。`,
    },
    ignore: {
      enabled: canFinish,
      reason:
        state === 'unknown'
          ? UNKNOWN_REASON
          : `这条告警已经结束（${alertStateText(state)}），不能再改状态；如果问题又出现了，请让上报的一方重新发一条告警。`,
    },
  };
}

/** 一次动作的展示文案（标题/按钮/成功提示/请求体由同一个枚举驱动）。 */
export interface ActionMeta {
  readonly title: string;
  readonly confirmText: string;
  readonly successText: string;
  readonly needsRemark: boolean;
  readonly danger: boolean;
  /** 状态码：ack 走另一个方法，这里只给 status。 */
  readonly status: number | undefined;
}

export function actionMetaOf(kind: AlertActionKind): ActionMeta {
  switch (kind) {
    case 'ack':
      return {
        title: '确认收到这条告警',
        confirmText: '确认收到',
        successText: '已确认收到，这条告警记为「处理中」。处理完记得回到这里点「处理完成」。',
        needsRemark: false,
        danger: false,
        status: undefined,
      };
    case 'resolve':
      return {
        title: '把这条告警记为已处理',
        confirmText: '处理完成',
        successText: '已记为「处理完成」，解除时间已经记下，这条告警不再计入待处理。',
        needsRemark: true,
        danger: false,
        status: 2,
      };
    default:
      return {
        title: '忽略这条告警',
        confirmText: '忽略',
        successText: '已忽略这条告警，忽略原因已写进处理记录。',
        needsRemark: true,
        danger: true,
        status: 3,
      };
  }
}

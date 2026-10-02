/**
 * `@wise/ui` 的公共类型。
 *
 * ## 为什么这里**不**从 `@wise/bridge-client` import 错误类型
 *
 * `@wise/ui` 是纯展示层：不认识桥、也不认识 store（由 `check:store` 静态保证）。
 * 桥错误在这里只用**结构**描述 —— `BridgeError` 天然满足 `UiError`，
 * 于是门禁可以是一条简单的字符串扫描，而调用方也不必做转换。
 */

/** 桥错误的结构影子（`BridgeError` 直接可传）。 */
export interface UiError {
  readonly code: string;
  readonly messageKey?: string | undefined;
  readonly retryable?: boolean | undefined;
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export type ColumnType = 'text' | 'mono' | 'status';

/**
 * 手机卡片把一个列放在哪个位置。
 *
 * 这是 `ResponsiveDataView` 能"同一份列定义、两端不同渲染"的关键：
 * 桌面表格按列顺序全展示，手机卡片只挑得出来的那几列（主标识 / 主文案 / 次要信息 / 状态芯片）。
 */
export type CompactSlot = 'primary' | 'secondary' | 'chip' | 'hidden';

export interface ColumnDef<T> {
  readonly key: string;
  readonly title: string;
  /** 默认 `text`；`mono` = 等宽（单号/条码/RFID，纵向要对齐）；`status` = 状态芯片。 */
  readonly type?: ColumnType | undefined;
  readonly width?: number | undefined;
  readonly align?: 'left' | 'right' | undefined;
  /** 取值器；缺省读 `row[key]`。返回 `null` 表示"这一行没有这一项"。 */
  readonly value?: ((row: T) => string | null | undefined) | undefined;
  /** `type: 'status'` 时的语义色。 */
  readonly tone?: ((row: T) => StatusTone) | undefined;
  /** 手机卡片里的位置；缺省 `hidden`（不挤在卡片上）。 */
  readonly compact?: CompactSlot | undefined;
}

export interface MetricItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** 副标题只能来自真实字段；没有就不传（**不要**编"较昨日 +18"）。 */
  readonly note?: string | undefined;
  readonly tone?: StatusTone | undefined;
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterDef {
  readonly key: string;
  readonly label: string;
  readonly options: readonly FilterOption[];
  /** 缺省第一项；`''` 表示"全部"。 */
  readonly defaultValue?: string | undefined;
}

export type FilterValues = Readonly<Record<string, string>>;

export interface KeyValueItem {
  readonly key: string;
  readonly label: string;
  readonly value: string | null | undefined;
  /** 值是否等宽展示（单号 / 时间 / 数量）。 */
  readonly mono?: boolean | undefined;
  readonly tone?: StatusTone | undefined;
}

export interface PageAction {
  readonly key: string;
  readonly label: string;
  readonly primary?: boolean | undefined;
  readonly danger?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * 把桥错误翻成人话。
 *
 * 桥只下发布 `code` / `messageKey`（不下发文案），映射在展示侧做 —— 沿用旧仓
 * 「谁展示谁拥有」的口径。未命中时给"带错误码的兜底句"，因为**错误码本身是证据**：
 * 排障时用户念出来就能定位，比"操作失败"有用得多。
 */
export function errorTextOf(error: UiError | null | undefined, fallback = '操作未成功'): string {
  if (!error) {
    return fallback;
  }
  switch (error.messageKey) {
    case 'bridge.backendUnreachable':
      return '后端不可达，请检查网络或服务状态';
    case 'error_session_expired':
      return '登录已过期，请重新登录';
    case 'bridge.bootstrapMalformed':
      return '本地服务未就绪，请完全退出应用后重新打开';
    case 'bridge.methodNotMocked':
      return '该功能在开发态假桥下不可用';
    /*
     * 相机扫码（B1）的三个码。它们既可能来自桥（Kotlin `BridgeErrorCodes`），
     * 也可能来自 Web 侧 `getUserMedia` 失败后的映射（见 `scan-stream.ts`）——
     * 用户看到的是同一句话，因为**出路是同一件事**：去系统设置 / 把占用相机的程序关掉。
     */
    case 'scan.cameraUnavailable':
      return '没有可用的摄像头';
    case 'scan.cameraDenied':
      return '相机权限被拒绝，请在系统设置里允许使用相机';
    case 'scan.cameraBusy':
      return '摄像头正被其它程序占用';
    default:
      return `${fallback}（${error.code}）`;
  }
}

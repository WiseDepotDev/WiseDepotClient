/**
 * 协议类型：与 `bridge/protocol/src/main/kotlin/.../BridgeFrame.kt` 一一对应。
 *
 * 这里刻意**手写**这四个类型而不是从 Kotlin 生成：帧结构的字段数固定（v/type/id/method/params…），
 * 生成器带来的收益不抵复杂度；真正需要单一来源的是**方法表**（167 条），那份已由
 * `@wise/contract` 从服务端注解生成。若帧结构发生不兼容变化，协议版本必须 +1，这里同步改。
 */

/** 与 `BridgeProtocol.VERSION` 一致。 */
export const BRIDGE_PROTOCOL_VERSION = 3 as const;

/** 单帧上限，与 `BridgeProtocol.MAX_FRAME_BYTES` 一致。 */
export const MAX_FRAME_BYTES = 256 * 1024;

/** 引导文件路径，与 `BridgeProtocol.BOOTSTRAP_PATH` 一致。 */
export const BOOTSTRAP_PATH = '/__bridge.json';

/** 握手路径，与 `BridgeProtocol.HANDSHAKE_PATH` 一致。 */
export const HANDSHAKE_PATH = '/bridge';

/** 引导契约：Web 启动后读到的第一份数据，见 Kotlin 侧 `BridgeBootstrap`。 */
export interface BridgeBootstrap {
  /** 桥监听的 loopback 临时端口。 */
  readonly port: number;
  /** 本次启动新生成的一次性握手 token。 */
  readonly token: string;
  readonly platform: string;
  readonly ver: string;
  readonly protocol: number;
  readonly capabilities: readonly string[];
}

/** 桥错误：`code` 是桥错误码或后端原样透传的 `RES-xxxx`；文案不下发，只给 messageKey。 */
export interface BridgeErrorPayload {
  readonly code: string;
  readonly messageKey?: string;
  readonly retryable?: boolean;
  readonly details?: unknown;
}

export interface ReqMeta {
  readonly screen?: string;
  readonly requestId?: string;
}

export interface ResMeta {
  readonly ts?: number;
  readonly cache?: 'hit' | 'miss';
  readonly traceId?: string;
}

export interface ReqFrame {
  readonly v: number;
  readonly type: 'req';
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
  readonly meta?: ReqMeta;
}

export interface ResFrame {
  readonly v: number;
  readonly type: 'res';
  readonly id: string;
  readonly ok: true;
  readonly data?: unknown;
  readonly meta?: ResMeta;
}

export interface ErrFrame {
  readonly v: number;
  readonly type: 'err';
  readonly id: string;
  readonly error: BridgeErrorPayload;
}

export interface EvtFrame {
  readonly v: number;
  readonly type: 'evt';
  readonly topic: string;
  readonly data?: unknown;
}

export type BridgeFrame = ReqFrame | ResFrame | ErrFrame | EvtFrame;

/** 桥错误码，与 Kotlin `BridgeErrorCodes` 一致。 */
export const BridgeErrorCode = {
  METHOD_UNKNOWN: 'BRIDGE_METHOD_UNKNOWN',
  PARAMS_INVALID: 'BRIDGE_PARAMS_INVALID',
  UNAUTHORIZED: 'BRIDGE_UNAUTHORIZED',
  FRAME_TOO_LARGE: 'BRIDGE_FRAME_TOO_LARGE',
  RATE_LIMITED: 'BRIDGE_RATE_LIMITED',
  BACKEND_UNREACHABLE: 'BRIDGE_BACKEND_UNREACHABLE',
  INTERNAL: 'BRIDGE_INTERNAL',
} as const;

/** 平台能力 id，与 Kotlin `BridgeCapabilities` 一致。 */
export const Capability = {
  PLATFORM_DESKTOP: 'desktop',
  PLATFORM_MOBILE: 'mobile',
  SCAN_CAMERA: 'scan.camera',
  SCAN_GUN_KEYBOARD: 'scan.gun.keyboard',
  SCAN_GUN_SERIAL: 'scan.gun.serial',
  NFC_READ: 'nfc.read',
  RFID_READER: 'rfid.reader',
  PRINT_LABEL: 'print.label',
  PRINT_SYSTEM: 'print.system',
  WINDOW_CONTROL: 'window.control',
  WINDOW_MULTI: 'window.multi',
  FILE_DIALOG: 'file.dialog',
  SECURE_STORE: 'storage.secure',
  OFFLINE_QUEUE: 'offline.queue',
} as const;

/** 调用失败时抛出的错误类型（不要用裸 Error，UI 要按 code 分支）。 */
export class BridgeError extends Error {
  readonly code: string;
  readonly messageKey: string | undefined;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(payload: BridgeErrorPayload) {
    super(payload.messageKey ?? payload.code);
    this.name = 'BridgeError';
    this.code = payload.code;
    this.messageKey = payload.messageKey;
    this.retryable = payload.retryable ?? false;
    this.details = payload.details;
  }
}

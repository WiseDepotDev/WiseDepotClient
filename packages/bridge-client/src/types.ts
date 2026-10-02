/**
 * 协议类型：与 `bridge/protocol/src/main/kotlin/.../BridgeFrame.kt` 一一对应。
 *
 * 这里刻意**手写**这四个类型而不是从 Kotlin 生成：帧结构的字段数固定（v/type/id/method/params…），
 * 生成器带来的收益不抵复杂度；真正需要单一来源的是**方法表**（167 条），那份已由
 * `@wise/contract` 从服务端注解生成。若帧结构发生不兼容变化，协议版本必须 +1，这里同步改。
 */

/** 与 `BridgeProtocol.VERSION` 一致。v4 起线格式是全二进制帧（见 `wire.ts`）。 */
export const BRIDGE_PROTOCOL_VERSION = 4 as const;

/** 控制面正文上限，与 `BridgeProtocol.MAX_FRAME_BYTES` 一致。 */
export const MAX_FRAME_BYTES = 256 * 1024;

/** 数据面（`bin`）正文上限，与 `BridgeProtocol.MAX_BIN_BYTES` 一致。 */
export const MAX_BIN_BYTES = 8 * 1024 * 1024;

/** 引导文件路径，与 `BridgeProtocol.BOOTSTRAP_PATH` 一致。 */
export const BOOTSTRAP_PATH = '/__bridge.json';

/** 握手路径，与 `BridgeProtocol.HANDSHAKE_PATH` 一致。 */
export const HANDSHAKE_PATH = '/bridge';

/**
 * 会话失效事件主题，与 `SessionManager.EVENT_SESSION_EXPIRED` 一致。
 *
 * 为什么需要这条推送：桥清掉令牌时，界面正停在"已登录"的画面上，而
 * `bridge.session` 只在挂载时被问过一次。没有推送，界面就永远不知道会话没了 ——
 * 它会继续发请求，而后端对无令牌的请求先撞签名过滤器，回一个**误导性的**
 * 「缺少必要的签名参数」400（真因是"没登录"）。
 *
 * 这是跨语言的线上契约串，改一边必须同时改另一边。
 */
export const BRIDGE_EVENT_SESSION_EXPIRED = 'session.expired';

/** 引导契约：Web 启动后读到的第一份数据，见 Kotlin 侧 `BridgeBootstrap`。 */
export interface BridgeBootstrap {
  /**
   * 桥监听的主机地址。**页面不该假设 127.0.0.1** ——
   * WSA 上必须连 loopback0 的点对点地址（它把发往 127.0.0.1 的包从那条链路送出去）。
   * 可选只是为了兼容旧宿主。
   */
  readonly host?: string;
  /** 桥监听的临时端口。 */
  readonly port: number;
  /** 本次启动新生成的一次性握手 token。 */
  readonly token: string;
  readonly platform: string;
  readonly ver: string;
  readonly protocol: number;
  readonly capabilities: readonly string[];
  /**
   * 本壳实际执行的上限（v4 新增）。
   *
   * 为什么要下发：客户端在**发之前**就能判断"这个 6MiB 的图片能不能走帧内"，
   * 而不是靠撞上限来学习（后者在 v3 里表现为"只发了张图，却收到 FRAME_TOO_LARGE"）。
   * 可选是为了兼容旧宿主。
   */
  readonly limits?: {
    readonly textMaxBytes: number;
    readonly binMaxBytes: number;
  };
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

/**
 * 帧的内存模型。
 *
 * v4 起 `v` / `type` / `id` / `ok` **不在线上**（它们在 12 字节帧头里，见 `wire.ts`）：
 * 这里的 `type` 是解码器按 kind 填上的**内存判别字段**，让调用点的 `switch (frame.type)` 保持可读；
 * 成功与否由 `type === 'res'` 唯一表达（v3 的 `ok` 是同一事实的第二份副本，已删）。
 */
export interface ReqFrame {
  readonly type: 'req';
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
  readonly meta?: ReqMeta;
}

export interface ResFrame {
  readonly type: 'res';
  readonly id: string;
  readonly data?: unknown;
  readonly meta?: ResMeta;
}

export interface ErrFrame {
  readonly type: 'err';
  readonly id: string;
  readonly error: BridgeErrorPayload;
}

export interface EvtFrame {
  readonly type: 'evt';
  readonly topic: string;
  readonly data?: unknown;
}

/**
 * 数据面（`bin`）帧。
 *
 * 本批**没有任何方法用它** —— 只是让"壳真的发了 bin"这件事不会把前端打崩。
 * 等第一个真实消费方（大图/摄像头帧）落地时再补渲染路径。
 */
export interface BinFrame {
  readonly type: 'bin';
  readonly id: string;
  readonly body: Uint8Array;
  readonly final: boolean;
}

export type BridgeFrame = ReqFrame | ResFrame | ErrFrame | EvtFrame | BinFrame;

/** 桥错误码，与 Kotlin `BridgeErrorCodes` 一致。 */
export const BridgeErrorCode = {
  METHOD_UNKNOWN: 'BRIDGE_METHOD_UNKNOWN',
  PARAMS_INVALID: 'BRIDGE_PARAMS_INVALID',
  UNAUTHORIZED: 'BRIDGE_UNAUTHORIZED',
  FRAME_TOO_LARGE: 'BRIDGE_FRAME_TOO_LARGE',
  /**
   * 线格式不认识（v3 的文本帧、帧头 magic/版本不对…）。
   *
   * 单列一个码因为它要告诉用户的是"客户端与壳不是同一版协议"，
   * 而不是"参数写错了" —— 两者的处理人不同。
   */
  WIRE_MODE: 'BRIDGE_WIRE_MODE',
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

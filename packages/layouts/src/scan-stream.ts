/**
 * 相机取景流的生命周期与错误映射（B1 / S2b）。
 *
 * ## 为什么这层是纯逻辑 + 注入
 *
 * 相机这块最容易出的不是"画面不对"，而是**流没停**（关掉取景层流还在跑、切页后摄像头指示灯还亮）
 * 与**错误说不清**（`NotAllowedError` 与 `NotFoundError` 给用户的出路完全不同）。
 * 这两件事都能在不启浏览器的情况下测：把 `mediaDevices` 与"流"注入进来，
 * `tools/check/check-scan-stream.mjs` 用假件把每条分支跑一遍。
 *
 * ## 错误码为什么用 BRIDGE_CAMERA_*
 *
 * 这三个码在 Kotlin `BridgeErrorCodes` 里（B1/S1a 新增）。Web 侧本地失败**复用同一套词**，
 * 是为了让界面只有一张错误→出路的映射表：不管失败发生在壳里还是浏览器里，
 * 用户看到的是同一句话、同一个"下一步"。
 */

/** 与本模块相关的三个相机错误码（值必须与 Kotlin `BridgeErrorCodes` 一致）。 */
export const CAMERA_ERROR = {
  UNAVAILABLE: 'BRIDGE_CAMERA_UNAVAILABLE',
  DENIED: 'BRIDGE_CAMERA_DENIED',
  BUSY: 'BRIDGE_CAMERA_BUSY',
} as const;

export type CameraErrorCode = (typeof CAMERA_ERROR)[keyof typeof CAMERA_ERROR];

/** 界面需要的全部信息：码 + messageKey + 能不能重试。 */
export interface CameraFailure {
  readonly code: CameraErrorCode;
  readonly messageKey: string;
  /** 只有"被占用"这类**换一下就能成**的情况才给重试按钮。 */
  readonly retryable: boolean;
}

/** 可注入的最小 `mediaDevices` 形状。 */
export interface CameraMediaLike {
  getUserMedia?: (constraints: {
    video: { deviceId?: { exact: string }; width?: { ideal: number }; height?: { ideal: number } } | true;
  }) => Promise<MediaStreamLike>;
}

/**
 * 取景分辨率（`ideal`，不是 `exact`）。
 *
 * 为什么要提要求：不写就是浏览器给什么是什么（常见 640×480），而**密集的一维码
 * （Code128 长串、EAN-13 小区）在 640 宽下每根条可能只有 1~2 像素**，
 * 解码器容错窗口很窄 —— 现场感受就是"明明对准了却扫不出来"。
 * `ideal` 是"尽量给"，给不了也不报错，所以不会让低端设备开不了流。
 */
const PREFERRED_WIDTH = 1280;
const PREFERRED_HEIGHT = 720;

/** 可注入的最小"流"形状（真的是 `MediaStream` 时结构兼容）。 */
export interface MediaStreamLike {
  getTracks: () => readonly MediaStreamTrackLike[];
}

export interface MediaStreamTrackLike {
  stop: () => void;
}

/**
 * `DOMException.name` → 相机错误。
 *
 * 映射依据（Chromium 实测）：
 *  - `NotFoundError` / `DevicesNotFoundError`：请求的 deviceId 不存在（**拔了就是这条**）；
 *  - `NotAllowedError` / `SecurityError`：用户拒绝、系统策略、或非安全上下文；
 *  - `NotReadableError` / `TrackStartError` / `AbortError`：设备被别的程序独占。
 *
 * 拿不准的名字一律归到 `UNAVAILABLE`（**可重试**）——把"未知失败"说成"权限被拒"会让用户
 * 去翻系统设置，而问题根本不在那里。
 */
export function mapCameraError(error: unknown): CameraFailure {
  const name = errorName(error);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: CAMERA_ERROR.DENIED,
        messageKey: 'scan.cameraDenied',
        retryable: false,
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        code: CAMERA_ERROR.BUSY,
        messageKey: 'scan.cameraBusy',
        retryable: true,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        code: CAMERA_ERROR.UNAVAILABLE,
        messageKey: 'scan.cameraUnavailable',
        retryable: true,
      };
    default:
      return {
        code: CAMERA_ERROR.UNAVAILABLE,
        messageKey: 'scan.cameraUnavailable',
        retryable: true,
      };
  }
}

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return '';
}

/** 一次 start 的结论（不抛异常：调用方按 `ok` 分支，界面不会因为漏 try 而白屏）。 */
export type CameraStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: CameraFailure };

/**
 * 取景会话：**保证任意时刻最多一条流**，且三种收尾路径都停得掉。
 *
 * 为什么需要一个持有者而不是散在组件里：`getUserMedia` 的失败与组件的卸载是**两条独立的时序**
 * （用户可能连点两次"扫码"，也可能开着取景直接切页）。没有一个统一持有者时，
 * 典型后果是"第二次 start 把第一条流覆盖掉，第一条的 tracks 永远没人 stop" ——
 * 摄像头指示灯一直亮着。
 */
export class CameraSession {
  private stream: MediaStreamLike | null = null;

  /** 当前是否有活着的流。 */
  get active(): boolean {
    return this.stream !== null;
  }

  /**
   * 当前流 —— 取景层要把它接到 `<video>.srcObject` 上。
   *
   * 暴露它而不是"让取景层自己调 `getUserMedia`"：那样就有**两个**持有者，
   * 而"谁负责停"这件事一旦分成两处，必然出现"关了层流还在跑"。
   */
  get mediaStream(): MediaStreamLike | null {
    return this.stream;
  }

  /**
   * 开一条流。
   *
   * **只在成功后才替换**：失败时保留原有流（若本来就在取景，一次"换摄像头"失败不该把画面弄黑）。
   */
  async start(
    media: CameraMediaLike | undefined | null,
    deviceId: string | null,
  ): Promise<CameraStartResult> {
    if (typeof media?.getUserMedia !== 'function') {
      return {
        ok: false,
        failure: {
          code: CAMERA_ERROR.UNAVAILABLE,
          messageKey: 'scan.cameraUnavailable',
          retryable: false,
        },
      };
    }
    const constraints =
      deviceId === null
        ? { video: { width: { ideal: PREFERRED_WIDTH }, height: { ideal: PREFERRED_HEIGHT } } as const }
        : {
            video: {
              deviceId: { exact: deviceId },
              width: { ideal: PREFERRED_WIDTH },
              height: { ideal: PREFERRED_HEIGHT },
            },
          };
    let next: MediaStreamLike;
    try {
      next = await media.getUserMedia(constraints);
    } catch (e) {
      return { ok: false, failure: mapCameraError(e) };
    }
    // 成功之后才丢掉旧的：先停旧流会在"新流也失败"时留下黑屏
    this.stop();
    this.stream = next;
    return { ok: true };
  }

  /** 停流。**幂等**：没在取景时调用不报错（切页/关层/失焦三处都会调它）。 */
  stop(): void {
    const current = this.stream;
    this.stream = null;
    if (!current) {
      return;
    }
    for (const track of current.getTracks()) {
      try {
        track.stop();
      } catch {
        // 单条 track 停不掉不该影响其它 track（也不该让"关掉取景"这个动作失败）
      }
    }
  }
}

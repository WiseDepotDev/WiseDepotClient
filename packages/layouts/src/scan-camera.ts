/**
 * 摄像头枚举与选择（桌面相机扫码 B1 / S2a）。
 *
 * ## 为什么这些逻辑在 Web 侧，而不是桥方法
 *
 * Electron **主进程没有 `mediaDevices`**：枚举只能发生在渲染进程
 * （`navigator.mediaDevices.enumerateDevices()`），而且 `label` 只在**拿到权限后**才非空。
 * 桥（Kotlin 宿主）与 Electron 主进程都看不到设备列表 —— 让它们转发就是插入一个中间商。
 * 详见 `docs/superpowers/plans/2026-10-05-desktop-camera-scan-brief.md` §8。
 *
 * ## 为什么这个文件零依赖
 *
 * 它是纯函数 + 两个浏览器全局（`mediaDevices` / `localStorage`）的**注入**，
 * 所以 `tools/check/check-scan-camera.mjs` 能用假对象把它整条逻辑跑一遍
 * （不必起浏览器、不必起宿主）——"能不能选到正确的摄像头"这种事不该只能靠真机试出来。
 */

/** 下拉里的一项。 */
export interface CameraOption {
  /** `deviceId`；Chromium 在未授权时也会给（只是 label 为空）。 */
  readonly id: string;
  /** 展示名：`label` 为空时兜底成"摄像头 N"（见 [toCameraOptions]）。 */
  readonly label: string;
  /** 枚举顺序（从 0 起），仅用于兜底命名与调试。 */
  readonly index: number;
}

/** 选择结果落在哪个键上。**放在 Web 侧**：流本来就是 Web 开的，壳不需要知道。 */
export const CAMERA_STORAGE_KEY = 'wise.scan.cameraId';

/** `enumerateDevices` 的最小形状（便于测试注入假的）。 */
export interface MediaDevicesLike {
  enumerateDevices?: () => Promise<readonly MediaDeviceLike[]>;
}

export interface MediaDeviceLike {
  readonly kind?: string;
  readonly deviceId?: string;
  readonly label?: string;
}

/** 本浏览器是否具备枚举能力（`navigator.mediaDevices` 在非安全上下文里可能不存在）。 */
export function canEnumerateCameras(media: MediaDevicesLike | undefined | null): boolean {
  return typeof media?.enumerateDevices === 'function';
}

/**
 * 设备列表 → 下拉选项。
 *
 * 两条规则：只取 `videoinput`；**`label` 为空时兜底成"摄像头 N"**——
 * Chromium 在用户授权之前不给设备名（实测为空串），直接显示空串的下拉等于让人瞎选。
 */
export function toCameraOptions(devices: readonly MediaDeviceLike[]): CameraOption[] {
  const out: CameraOption[] = [];
  for (const device of devices) {
    if (device.kind !== 'videoinput') {
      continue;
    }
    const id = device.deviceId ?? '';
    if (id === '') {
      continue;
    }
    const index = out.length;
    const label = (device.label ?? '').trim();
    out.push({ id, label: label === '' ? `摄像头 ${index + 1}` : label, index });
  }
  return out;
}

/** 枚举摄像头；不可用或抛错时返回空数组（调用方据此显示"没有可用的摄像头"）。 */
export async function listCameras(
  media: MediaDevicesLike | undefined | null,
): Promise<CameraOption[]> {
  if (!canEnumerateCameras(media)) {
    return [];
  }
  try {
    const devices = await media!.enumerateDevices!();
    return toCameraOptions(devices);
  } catch {
    // 权限被拒时 Chromium 也会抛 —— 这里不吞掉"是什么错"，只把"没有列表"这个事实交出去；
    // 具体错误由真正开流的那一步（getUserMedia）映射成 BRIDGE_CAMERA_* 给用户看。
    return [];
  }
}

/** 读回上次的选择。`localStorage` 不可用（隐私模式）时返回 null，不抛。 */
export function readSelectedCameraId(storage: Storage | undefined | null): string | null {
  if (!storage) {
    return null;
  }
  try {
    const value = storage.getItem(CAMERA_STORAGE_KEY);
    return value && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/** 记住选择；传 null 表示"清掉选择、回到默认"。存储不可用时静默失败（不打断扫码）。 */
export function writeSelectedCameraId(storage: Storage | undefined | null, id: string | null): void {
  if (!storage) {
    return;
  }
  try {
    if (id === null || id === '') {
      storage.removeItem(CAMERA_STORAGE_KEY);
    } else {
      storage.setItem(CAMERA_STORAGE_KEY, id);
    }
  } catch {
    // 隐私模式/配额满：记不住就记不住，不该因此让相机用不了
  }
}

/** 选择解析的结论；`fellBack` 用来在界面上说一句"上次那台不在了，已切到 XX"。 */
export interface CameraSelection {
  readonly camera: CameraOption | null;
  /** true 表示保存的那台已经不在列表里（拔了/换了），调用方应回写选择。 */
  readonly fellBack: boolean;
}

/**
 * 把"保存的选择"解析成列表里的一项。
 *
 * **设备被拔掉是最常见的一种正常情况**（不是错误）：这时回退到第一台并回报 `fellBack`，
 * 让界面说清楚"上次用的那台不在了"，而不是继续拿着一个不存在的 deviceId 去开流
 * ——那样 `getUserMedia` 会抛 `OverconstrainedError`，用户看到的却是一句莫名其妙的失败。
 */
export function resolveSelectedCamera(
  options: readonly CameraOption[],
  savedId: string | null,
): CameraSelection {
  if (options.length === 0) {
    return { camera: null, fellBack: false };
  }
  if (savedId !== null) {
    const hit = options.find((o) => o.id === savedId);
    if (hit) {
      return { camera: hit, fellBack: false };
    }
    return { camera: options[0]!, fellBack: true };
  }
  return { camera: options[0]!, fellBack: false };
}

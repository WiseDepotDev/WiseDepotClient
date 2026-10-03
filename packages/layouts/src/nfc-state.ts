/**
 * NFC 四态的**纯逻辑**（B3/S4）。
 *
 * 为什么单独一个模块：这一片里真正会写错、又**不会报错**的是"收到什么事件该显示什么"——
 *
 *  - 没有 `nfc.read` 能力 → **一个像素都不画**（画了就是"贴了没反应"的入口）；
 *  - `unsupported` → 同样不画（那条路没有出路，只能换设备）；
 *  - `off` 与"就绪"是**两种出路**，文案也不能是同一句；
 *  - 壳将来多一个状态取值时，界面要**保持原状**而不是清空（降级要往"还能用"的方向降）。
 *
 * 做法与相机那一套相同（`scan-camera.ts` / `scan-stream.ts`）：判定放在零依赖模块里，
 * `NfcStatus.vue` 只负责画 —— 于是门禁能用 `esbuild + node` 把**真模块**跑一遍
 * （见 `tools/check/check-nfc.mjs` 第 8 节），而不是对着源文本说"代码里有这几个词"。
 *
 * **这个文件不许 import 任何东西**：门禁把它转成 `data:` URL 直接执行，裸导入在那里解析不了。
 * 因此下面三个契约串是字面量，由门禁去比对 `@wise/bridge-client` 与 Kotlin 的常量。
 */

/** 与 Kotlin `NfcReaderState.EVENT_*` / TS `BRIDGE_EVENT_NFC_*` 逐字一致。 */
export const NFC_EVENT_TAG = 'nfc.tag';
export const NFC_EVENT_STATE = 'nfc.state';

/** 与 `Capability.NFC_READ` 逐字一致。 */
export const NFC_CAPABILITY = 'nfc.read';

/** 与 `LocalMethod.NFC_OPEN_SETTINGS` 逐字一致。 */
export const NFC_OPEN_SETTINGS = 'nfc.openSettings';

export type NfcPhase = 'ready' | 'off' | 'unsupported';

export interface NfcTag {
  readonly id: string;
  readonly tech: string;
  readonly at: number;
}

function readField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

function readString(payload: unknown, key: string): string | null {
  const value = readField(payload, key);
  return typeof value === 'string' ? value : null;
}

/**
 * 壳报来的状态取值 → 界面状态。
 *
 * **不认识的一律回 `null`**（而不是兜底成 `ready` 或 `off`）：调用方据此保持原状 ——
 * "多了一个我不认识的取值"不该把界面清空，也不该让它假装就绪。
 */
export function nfcPhaseOf(payload: unknown): NfcPhase | null {
  const state = readString(payload, 'state');
  if (state === 'on') {
    return 'ready';
  }
  if (state === 'off') {
    return 'off';
  }
  if (state === 'unsupported') {
    return 'unsupported';
  }
  return null;
}

/** 当前状态 + 一条 `nfc.state` → 下一个状态；取值不认识就**不动**。 */
export function nextNfcPhase(current: NfcPhase, payload: unknown): NfcPhase {
  return nfcPhaseOf(payload) ?? current;
}

/**
 * 要不要画 NFC 入口。
 *
 * 两个条件缺一不可：宿主声明了能力**且**这台机器不是"没有硬件"。
 * （后者本来就不会声明能力，但真出现"声明了却是 unsupported"时也不该画 ——
 * 那种矛盾的正确处置是**什么都不画**，而不是画一个死入口。）
 */
export function shouldRenderNfc(capable: boolean, phase: NfcPhase): boolean {
  return capable && phase !== 'unsupported';
}

/**
 * `nfc.tag` → 标签卡数据。
 *
 * 没有 id 的标签事件是坏数据：回 `null`（不画一张空白卡片 —— 那比不显示更让人困惑）。
 * `tech` 缺了给 `Unknown`（与壳侧的兜底一致）；`at` 缺了用当前时间，只用于展示。
 */
export function nfcTagOf(payload: unknown): NfcTag | null {
  const id = readString(payload, 'id');
  if (id === null || id === '') {
    return null;
  }
  const at = readField(payload, 'at');
  return {
    id,
    tech: readString(payload, 'tech') ?? 'Unknown',
    at: typeof at === 'number' ? at : Date.now(),
  };
}

/**
 * `nfc.openSettings` 的返回值算不算"真的打开了"。
 *
 * 只有**明确的** `opened: true` 才算。其余（false / undefined / 调用抛错 / 老壳没有这个方法）
 * 一律算"没打开"，界面据此改口说"请手动到系统设置里开启" ——
 * 假装成功的话，用户看到的就是"点了没反应"。
 */
export function openSettingsSucceeded(result: unknown): boolean {
  return readField(result, 'opened') === true;
}

/**
 * 条码识别：引擎选择与结果归一化（B1 / S2b2）。
 *
 * ## 为什么先做这一层，而不是直接写取景组件
 *
 * "用哪个引擎"与"结果怎么归一"是这一片里**唯一会写错又看不出来**的部分：
 *  - `BarcodeDetector` 在 Chromium 里**不保证存在**（部分构建缺 codec，Electron 版本之间也有差异），
 *    所以回退路径是**必需**的，而不是优化；
 *  - 各引擎给的字面量不一样（`code_128` / `code128` / `CODE_128`、空 `rawValue`），
 *    上游事件里 `symbology` 只有一个形状（`docs/protocol.md` §3 的 `scan.code`）。
 *
 * 这两件事都能在不启浏览器、不装 ZXing 的情况下测完（注入一个假 detector 即可），
 * 所以先把它做成零依赖模块；真正的 `import('zxing-wasm')` 与取景组件在 S2b3 里接。
 */

/** 归一化之后的识别结果（上游 `evt scan.code` 的形状）。 */
export interface BarcodeHit {
  readonly code: string;
  /** 小写、去下划线：`code_128` → `code128`（与既有 scan 事件的口径一致）。 */
  readonly symbology: string;
}

/** 可注入的最小 detector 形状（真的是 `BarcodeDetector` 时结构兼容）。 */
export interface BarcodeDetectorLike {
  detect: (source: unknown) => Promise<readonly BarcodeLike[]>;
}

export interface BarcodeLike {
  readonly rawValue?: string;
  readonly format?: string;
}

/** 用哪个引擎。`none` 是**必须能表达出来的状态**：界面要能说"这台机器不支持扫码识别"。 */
export type DecoderKind = 'barcode-detector' | 'zxing-wasm' | 'none';

/**
 * 选引擎：**优先浏览器内置**。
 *
 * 为什么内置优先：零依赖、零额外下载体积、且与页面同在一个进程里（不必为一次识别额外解码图片）。
 * 回退只在"内置不存在"时启用 —— 这也是为什么 ZXing 必须**懒加载**：
 * 为一个可能用不到的能力给主包增重是不划算的。
 */
export function pickDecoderKind(
  hasNativeDetector: boolean,
  hasZxingFallback: boolean,
): DecoderKind {
  if (hasNativeDetector) {
    return 'barcode-detector';
  }
  if (hasZxingFallback) {
    return 'zxing-wasm';
  }
  return 'none';
}

/** 字面量归一化：小写 + 去掉下划线/空格，让 `code_128` 与 `CODE 128` 落到同一个值。 */
export function normaliseSymbology(format: string | undefined): string {
  return (format ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * 从一次 detect 的原始结果里取第一条**可用**的码。
 *
 * 三条纪律：
 *  1. `rawValue` 为空串/全空白的项**跳过**（引擎会返回"看到了条码但读不出值"的占位项）；
 *  2. 取到就返回**第一条**，不做"最可信"之类的排序 —— 一个取景框里出现多个条码时，
 *     选哪个是 UX 问题，不该藏在识别层里猜；
 *  3. 首尾空白去掉（有的引擎会把静区当内容带出来），这是唯一一处对码值做的改写。
 */
export function firstCode(results: readonly BarcodeLike[] | null | undefined): BarcodeHit | null {
  if (!results) {
    return null;
  }
  for (const item of results) {
    const code = (item?.rawValue ?? '').trim();
    if (code !== '') {
      return { code, symbology: normaliseSymbology(item?.format) };
    }
  }
  return null;
}

/**
 * 跑一次识别。
 *
 * 返回 `null` 表示"这一帧里没有可用结果"（**不是**错误）——取景是连续调用它的，
 * 抛异常会让每一帧都变成一次错误上报。只有"引擎本身不可用"才是错误，那由
 * [pickDecoderKind] 在更外层表达成 `none`。
 *
 * `onError` 是 B1/S2b4 加的**诊断出口**：原先这里 `catch {}` 把一切都吞了，
 * 于是"引擎每次都抛错"和"画面里就是没有码"在界面上完全无法区分 ——
 * 现场看到的就是"给了条码没反应"。吞异常可以（取景不该被一次解码失败打断），
 * 但**必须留一条能说出原因的路**。
 */
export async function detectOnce(
  detector: BarcodeDetectorLike | null | undefined,
  source: unknown,
  onError?: (error: unknown) => void,
): Promise<BarcodeHit | null> {
  if (typeof detector?.detect !== 'function') {
    return null;
  }
  try {
    return firstCode(await detector.detect(source));
  } catch (e) {
    onError?.(e);
    return null;
  }
}

/**
 * 识别引擎的构造（B1/S2b3）。
 *
 * ## 这一层解决的问题
 *
 * `scan-decode.ts` 只回答"**该用哪个**引擎"（纯判断），这一层回答"**怎么造出来**"：
 * 内置 `BarcodeDetector` 与 ZXing-wasm 的构造方式、参数、结果形状都不一样，
 * 而取景层只想要一个统一的 `detect(source)`。
 *
 * ## 为什么依赖是"注入"的
 *
 * 真实环境里的两样东西在这里都是参数：
 *  · `nativeCtor` —— `globalThis.BarcodeDetector` 在某些 Chromium 构建里**不存在**，
 *    而且它对不认识的格式名会**直接抛异常**（不是静默忽略）；
 *  · `loadZxing` —— 回退引擎是**动态加载**的（见 `scan-zxing.ts`），只在内置缺失时才走。
 *
 * 注入之后 `tools/check/check-scan-engines.mjs` 能用假件把每条分支跑一遍 ——
 * "内置抛异常时有没有真的落到回退"这种事不该只能靠一台缺 codec 的机器试出来。
 *
 * ## 两组格式名的对称性
 *
 * 内置按小写下划线（`code_128`），ZXing 按它自己的写法（`Code128`）。两组名字**必须指向
 * 同一批码制** —— 否则同一张条码在两条路径上会得到不同的 `symbology`，
 * 而事件里 `symbology` 只有一个形状（`docs/protocol.md` §3）。
 * 经 `normaliseSymbology` 归一化后两组逐项相等，这条由门禁钉住。
 */
import {
  pickDecoderKind,
  type BarcodeDetectorLike,
  type BarcodeLike,
  type DecoderKind,
} from './scan-decode.js';

/**
 * 内置 `BarcodeDetector` 认得的格式名。
 *
 * 只列**一维码 + 二维码里现场真会遇到的**：工业标签以 Code128 / EAN-13 / QR 为主。
 * 要求引擎支持的格式越多，遇到"某个名字这台构建不认"而整体构造失败的概率越大，
 * 所以宁少勿滥（`createNativeDecoder` 里对构造失败的处理见注释）。
 */
export const NATIVE_FORMATS = [
  'code_128',
  'code_39',
  'ean_13',
  'ean_8',
  'itf',
  'qr_code',
  'upc_a',
  'upc_e',
  'codabar',
  'data_matrix',
] as const;

/** ZXing 的格式名。与 [NATIVE_FORMATS] **逐项同义**（顺序一一对应）。 */
export const ZXING_FORMATS = [
  'Code128',
  'Code39',
  'EAN-13',
  'EAN-8',
  'ITF',
  'QRCode',
  'UPC-A',
  'UPC-E',
  'Codabar',
  'DataMatrix',
] as const;

/** `BarcodeDetector` 的构造签名（只写用得到的那一部分）。 */
export interface BarcodeDetectorCtor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
}

/** ZXing `readBarcodes` 的返回项（只写用得到的字段）。 */
export interface ZxingReadResult {
  readonly text?: string;
  readonly format?: string;
}

/** ZXing reader 模块的**最小**形状：这一个方法就是回退路径的全部依赖面。 */
export interface ZxingReaderModule {
  readBarcodes: (
    input: unknown,
    options?: { formats?: readonly string[] },
  ) => Promise<readonly ZxingReadResult[]>;
}

export interface ScanEngineDeps {
  /** `globalThis.BarcodeDetector`；没有就传 `null`。 */
  readonly nativeCtor?: BarcodeDetectorCtor | null;
  /** 动态加载回退引擎；**不传 = 这个环境没有回退**（结果是 `none`，界面据实说明）。 */
  readonly loadZxing?: (() => Promise<ZxingReaderModule | null>) | null;
}

/** 选出来的引擎：`kind === 'none'` 时 `detector` 必为 `null`。 */
export interface ScanEngine {
  readonly kind: DecoderKind;
  readonly detector: BarcodeDetectorLike | null;
}

/**
 * 造内置引擎。
 *
 * **构造失败返回 `null` 而不是抛**：Chromium 对不认识的格式名会抛
 * （不同版本支持的格式集合不完全一样），而这属于"内置这条路的某个子集不可用"，
 * 应该**落到回退**，而不是让整个扫码入口变成一句错误。
 */
export function createNativeDecoder(
  ctor: BarcodeDetectorCtor | null | undefined,
  formats: readonly string[] = NATIVE_FORMATS,
): BarcodeDetectorLike | null {
  if (typeof ctor !== 'function') {
    return null;
  }
  try {
    return new ctor({ formats: [...formats] });
  } catch {
    return null;
  }
}

/** ZXing 只吃 `Blob | ArrayBuffer | Uint8Array | ImageData` —— **不认识 `<video>`**。 */
type FrameSource = { videoWidth?: number; videoHeight?: number } | null | undefined;

/**
 * 把一帧画面转成 `ImageData`（仅 ZXing 路径需要）。
 *
 * 为什么必须有这一步：内置 `BarcodeDetector.detect()` 可以直接吃 `<video>`，
 * 而 ZXing 不行 —— 取景层如果两套写法各写一份，回退路径就只有在真机上才可能被发现是坏的。
 * 这里用**一张复用的 canvas**（每帧新建会把 60fps 变成 GC 压力），画布尺寸跟着视频走。
 *
 * 返回 `null` 表示"这一帧还不成画"（视频刚开、`videoWidth` 还是 0）—— 不是错误，
 * 取景循环下一帧再来。
 */
export function frameToImageData(
  source: unknown,
  canvas: { current: HTMLCanvasElement | null },
): ImageData | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const video = source as FrameSource;
  const width = Math.floor(video?.videoWidth ?? 0);
  const height = Math.floor(video?.videoHeight ?? 0);
  if (width <= 0 || height <= 0) {
    return null;
  }
  let el = canvas.current;
  if (el === null) {
    el = document.createElement('canvas');
    canvas.current = el;
  }
  if (el.width !== width || el.height !== height) {
    el.width = width;
    el.height = height;
  }
  const ctx = el.getContext('2d');
  if (ctx === null) {
    return null;
  }
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * 造回退引擎：把 ZXing 的 `readBarcodes` 包成与内置同形的 `detect`。
 *
 * 结果**不在这里归一化**（那是 `firstCode` / `normaliseSymbology` 的活），
 * 只做名称翻译：`text` → `rawValue`、`format` → `format`。
 */
export function createZxingDecoder(
  module: ZxingReaderModule | null | undefined,
  formats: readonly string[] = ZXING_FORMATS,
): BarcodeDetectorLike | null {
  if (typeof module?.readBarcodes !== 'function') {
    return null;
  }
  const canvas: { current: HTMLCanvasElement | null } = { current: null };
  return {
    detect: async (source: unknown): Promise<readonly BarcodeLike[]> => {
      const frame = frameToImageData(source, canvas);
      if (frame === null) {
        return [];
      }
      const results = await module.readBarcodes(frame, { formats: [...formats] });
      return (results ?? []).map((item) => ({
        rawValue: item?.text ?? '',
        format: item?.format ?? '',
      }));
    },
  };
}

/**
 * 按"内置优先、回退其次、都没有要说得出没有"选并造引擎。
 *
 * 回退加载失败（模块缺失 / wasm 拉不到）**不抛**：结果是 `none`，
 * 界面据此说一句"这台设备不支持扫码识别" —— 一个说得出话的失败，
 * 好过一个点了没反应的入口（见 brief §7.2）。
 */
export async function openScanDecoder(deps: ScanEngineDeps): Promise<ScanEngine> {
  const native = createNativeDecoder(deps.nativeCtor);
  const hasFallback = typeof deps.loadZxing === 'function';
  const kind = pickDecoderKind(native !== null, hasFallback);

  if (kind === 'barcode-detector') {
    return { kind, detector: native };
  }
  if (kind === 'zxing-wasm' && typeof deps.loadZxing === 'function') {
    let module: ZxingReaderModule | null = null;
    try {
      module = (await deps.loadZxing()) ?? null;
    } catch {
      module = null;
    }
    const detector = createZxingDecoder(module);
    // 加载到了模块但形状不对（版本不匹配）同样按"没有引擎"处理，不假装能用
    return detector === null ? { kind: 'none', detector: null } : { kind: 'zxing-wasm', detector };
  }
  return { kind: 'none', detector: null };
}

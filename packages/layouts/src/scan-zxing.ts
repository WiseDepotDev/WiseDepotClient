/**
 * 回退识别引擎的**真实加载**（B1/S2b3）。
 *
 * 这个文件是整个扫码链路里唯一接触"环境"的地方：读 `globalThis.BarcodeDetector`、
 * 动态 `import('zxing-wasm/reader')`、把 wasm 指向**打包进来的那一份**。
 * 其余部分（引擎选择、结果归一化、取景会话）都是纯逻辑，因此都能在 Node 里跑门禁。
 *
 * ## 为什么必须显式覆盖 `locateFile`
 *
 * zxing-wasm **默认从 jsDelivr CDN 拉 wasm**（它的 `PrepareZXingModuleOptions` 文档原话）。
 * 本项目是装在现场机器上的应用：断网、内网、无外网出口是常态 ——
 * 留着默认值等于"回退路径只在有网时存在"，而那正是最需要它的场合。
 * 所以这里用 `?url` 让 Vite 把 `zxing_reader.wasm` 当**本地资源**发出去，
 * 再把 `locateFile` 指到它。
 *
 * ## 为什么是动态 `import()`
 *
 * 回退只在"这台 Chromium 没有内置 `BarcodeDetector`"时才走（`scan-decode.ts` 的判定）。
 * 静态 import 会把这套 wasm 打进主包 —— 为一个大概率用不到的能力给首屏增重是不划算的。
 * 动态 import 让它落成**独立 chunk**，首屏预算（`check:budget`）不受影响。
 */
import type { BarcodeDetectorCtor, ZxingReaderModule } from './scan-engines.js';

/**
 * 取内置识别器构造器。
 *
 * 判定落在**这个全局对象**上，而不是"平台是不是 Electron"上：同一份 Web 产物
 * 也被手机 WebView 加载，而手机不声明 `scan.camera`（`MainActivity.kt` 的撤销）
 * —— 能力位负责说"能不能用"，这里只负责说"这台浏览器的这个 API 在不在"。
 */
export function nativeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof ctor === 'function' ? (ctor as BarcodeDetectorCtor) : null;
}

/**
 * 加载 ZXing reader；**任何失败都返回 `null`**（模块缺失、wasm 404、版本不符）。
 *
 * 返回 `null` 不抛是有意的：调用方（`openScanDecoder`）据此得到 `none`，
 * 界面说一句"这台设备不支持扫码识别" —— 说得出话的失败好过点了没反应的按钮。
 */
export async function loadZxingReader(): Promise<ZxingReaderModule | null> {
  try {
    const [reader, wasm] = await Promise.all([
      import('zxing-wasm/reader'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ]);
    reader.prepareZXingModule({
      overrides: { locateFile: () => wasm.default },
    });
    return {
      // 形状翻译（他们的 `readBarcodes` → 我们的最小依赖面）：
      // 参数收窄在适配器里做完，外面的取景层只认 `detect(source)`。
      readBarcodes: (input, options) => reader.readBarcodes(input as Blob, options as never),
    };
  } catch (error) {
    // 静默降级到"没有引擎"，但要留下线索：现场排障时这条日志是唯一能说明
    // "回退为什么没生效"的证据（CDN 被墙 / 资源没进包 / 版本不符，三者完全不同）。
    console.warn('[scan] ZXing 回退引擎加载失败，本次只能依赖内置识别器', error);
    return null;
  }
}

#!/usr/bin/env node
/*
 * check-scan-engines.mjs —— 识别引擎构造与取景层接线的门禁（B1/S2b3）。
 *
 * 这一片有两类错误在真机上很难复现，必须在这里钉死：
 *
 *   1. **引擎分支走错**：内置 `BarcodeDetector` 在某些 Chromium 构建里不存在
 *      （或对不认识的格式名直接抛异常）。"内置不可用时有没有真的落到回退"
 *      只有在缺 codec 的机器上才会暴露 —— 用假件跑真模块，每条分支都能验。
 *   2. **两组格式名不对称**：内置按 `code_128`、ZXing 按 `Code128`。
 *      两组名字如果指向的不是同一批码制，同一张条码在两条路径上会得到不同的 `symbology`。
 *
 * 另外三条**结构性**断言（扫源码，不跑浏览器）：入口只由能力位决定、
 * 错误态必须有出路、回退引擎必须是**动态**加载 —— 它们都是"写错了也能构建通过"的那一类。
 */
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LAYOUTS = path.join(ROOT, 'packages', 'layouts', 'src');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  }
}

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-scan-engines-'));
const outFile = path.join(outDir, 'engines.cjs');

try {
  /*
   * 用 esbuild **打包**（而不是只 transform）：`scan-engines.ts` 真的 import 了
   * `./scan-decode.js`，只做语法转换的话那条相对导入在 Node 里解析不到。
   * 入口用 stdin：一次把两个模块都导出，免得打两份包、两份状态。
   */
  await build({
    stdin: {
      contents: "export * from './scan-engines.js';\nexport * from './scan-decode.js';\n",
      resolveDir: LAYOUTS,
      loader: 'ts',
    },
    outfile: outFile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
  });

  const {
    NATIVE_FORMATS,
    ZXING_FORMATS,
    createNativeDecoder,
    createZxingDecoder,
    openScanDecoder,
    detectOnce,
    normaliseSymbology,
    firstCode,
  } = await import(pathToFileURL(outFile).href);

  console.log('--- 1. 两组格式名必须指向同一批码制（否则 symbology 会分叉） ---');
  check('两组格式名数量一致', NATIVE_FORMATS.length === ZXING_FORMATS.length, `${NATIVE_FORMATS.length} vs ${ZXING_FORMATS.length}`);
  const pairs = NATIVE_FORMATS.map((native, i) => [native, ZXING_FORMATS[i]]);
  const mismatched = pairs.filter(([n, z]) => normaliseSymbology(n) !== normaliseSymbology(z));
  check(
    '逐项归一化后相等（code_128 ⇄ Code128、qr_code ⇄ QRCode …）',
    mismatched.length === 0,
    mismatched.map(([n, z]) => `${n} ≠ ${z}`).join(', '),
  );
  check('一维码与二维码都在覆盖范围内', NATIVE_FORMATS.includes('code_128') && NATIVE_FORMATS.includes('qr_code'));

  console.log('--- 2. 内置引擎：没有就 null，构造失败也 null（落到回退，不是报错） ---');
  check('没有构造器 → null', createNativeDecoder(null) === null && createNativeDecoder(undefined) === null);
  let nativeOptions = null;
  class FakeDetector {
    constructor(options) {
      nativeOptions = options;
      this.detect = async () => [];
    }
  }
  const native = createNativeDecoder(FakeDetector);
  check('有构造器 → 造得出带 detect 的引擎', typeof native?.detect === 'function');
  check('格式名按内置写法传进去', JSON.stringify(nativeOptions?.formats) === JSON.stringify([...NATIVE_FORMATS]), JSON.stringify(nativeOptions));
  class ExplodingDetector {
    constructor() {
      throw new Error('unsupported formats: itf');
    }
  }
  check('构造器抛异常（这台构建不认某个格式名）→ null，不把整个入口变成错误', createNativeDecoder(ExplodingDetector) === null);

  console.log('--- 3. ZXing 适配器：形状翻译 + 没有画面时不炸 ---');
  check('没有模块 → null', createZxingDecoder(null) === null && createZxingDecoder({}) === null);
  const seenOptions = [];
  const zxing = createZxingDecoder({
    readBarcodes: async (input, options) => {
      seenOptions.push({ input, options });
      return [
        { text: '', format: 'Code128' },
        { text: 'TAG-0001', format: 'Code128' },
      ];
    },
  });
  check('模块形状对 → 造得出引擎', typeof zxing?.detect === 'function');
  /*
   * Node 里没有 `document`（也就没有 canvas），ZXing 又**不认识 `<video>`** ——
   * 所以这里必然拿不到帧。断言的是"拿不到帧 = 空结果"，而不是抛异常：
   * 取景循环每 200ms 调一次，抛出来会把每一帧变成一次错误上报。
   */
  const noFrame = await zxing.detect({ videoWidth: 640, videoHeight: 480 });
  check('取不到帧 → 返回空数组（不是抛）', Array.isArray(noFrame) && noFrame.length === 0, JSON.stringify(noFrame));
  check('取不到帧时**不去调**引擎（不做无用的 wasm 往返）', seenOptions.length === 0, `调用次数=${seenOptions.length}`);
  check(
    '空的 rawValue 交给上层跳过（归一化不在这层做）',
    firstCode([{ rawValue: '', format: 'Code128' }, { rawValue: 'TAG-0001', format: 'Code128' }])?.code === 'TAG-0001',
  );

  console.log('--- 4. 选引擎：内置优先、回退其次、都没有要说得出没有 ---');
  let zxingLoads = 0;
  const zxingModule = { readBarcodes: async () => [] };
  const bothAvailable = await openScanDecoder({
    nativeCtor: FakeDetector,
    loadZxing: async () => {
      zxingLoads += 1;
      return zxingModule;
    },
  });
  check('有内置 → kind=barcode-detector', bothAvailable.kind === 'barcode-detector' && bothAvailable.detector !== null);
  check('有内置时**不加载**回退（不给主包白增重）', zxingLoads === 0, `加载次数=${zxingLoads}`);

  const fallback = await openScanDecoder({ nativeCtor: null, loadZxing: async () => { zxingLoads += 1; return zxingModule; } });
  check('没内置 + 有回退 → kind=zxing-wasm', fallback.kind === 'zxing-wasm' && fallback.detector !== null);
  check('此时才加载回退', zxingLoads === 1, `加载次数=${zxingLoads}`);

  const explodedNative = await openScanDecoder({ nativeCtor: ExplodingDetector, loadZxing: async () => zxingModule });
  check('内置构造失败 → **落到回退**（而不是说"这台机器不支持"）', explodedNative.kind === 'zxing-wasm');

  const brokenLoader = await openScanDecoder({
    nativeCtor: null,
    loadZxing: async () => {
      throw new Error('wasm 404');
    },
  });
  check('回退加载抛错 → kind=none（不把异常抛给界面）', brokenLoader.kind === 'none' && brokenLoader.detector === null);
  const nullLoader = await openScanDecoder({ nativeCtor: null, loadZxing: async () => null });
  check('回退返回空（模块缺失）→ kind=none', nullLoader.kind === 'none');
  const wrongShape = await openScanDecoder({ nativeCtor: null, loadZxing: async () => ({ nope: true }) });
  check('回退形状不对（版本不匹配）→ kind=none，不假装能用', wrongShape.kind === 'none');
  const nothing = await openScanDecoder({ nativeCtor: null, loadZxing: null });
  check('既没有内置也没有回退 → kind=none 且不抛', nothing.kind === 'none' && nothing.detector === null);
  check('none 时 detectOnce 安全返回 null', (await detectOnce(nothing.detector, {})) === null);

  console.log('--- 5. 结构断言：入口只由能力位决定、错误态有出路、回退必须懒加载 ---');
  const appFrame = readFileSync(path.join(LAYOUTS, 'AppFrame.vue'), 'utf8');
  const panel = readFileSync(path.join(LAYOUTS, 'CameraScanPanel.vue'), 'utf8');
  const zxingSrc = readFileSync(path.join(LAYOUTS, 'scan-zxing.ts'), 'utf8');

  check(
    "AppFrame 的扫码入口由能力位决定（bridge.supports('scan.camera')）",
    /bridge\.supports\(\s*'scan\.camera'\s*\)/.test(appFrame),
  );
  check(
    '入口**没有**写成"平台是桌面"（那会在 B2 落地后留下走不到的分支）',
    !/platform\s*===\s*'desktop'/.test(appFrame) && !/isCompact\s*&&\s*canScanCamera/.test(appFrame),
  );
  check('取景层是 v-if 挂载（关掉即卸载，卸载路径统一停流）', /<CameraScanPanel\s+v-if="cameraOpen"/.test(appFrame));
  check('切页会关掉取景层（brief §4 纪律③的"切页"一处）', /watch\(\s*\(\)\s*=>\s*route\.fullPath/.test(appFrame));
  check('命中后走的是与扫码枪同一条路由', /function onCameraCode[\s\S]{0,120}handleScan\(code\)/.test(appFrame));
  check('结果卡两端都画（相机只有桌面声明，只画手机等于扫到了不显示）', /<ScanResultCard\s*\/>/.test(appFrame));

  check('打开时枚举设备并解析上次选择', /listCameras\(/.test(panel) && /resolveSelectedCamera\(/.test(panel));
  check('设备被拔掉时回写选择（不每次重新回退）', /if\s*\(fellBack\)[\s\S]{0,160}writeSelectedCameraId/.test(panel));
  check('卸载时停流（关闭层 / 切页都到这里）', /onBeforeUnmount\([\s\S]{0,400}finish\(\)/.test(panel));
  check('失焦停流', /addEventListener\(\s*'blur'/.test(panel));
  check('页面不可见停流', /visibilitychange/.test(panel) && /visibilityState\s*===\s*'hidden'/.test(panel));
  check('停流走同一个收尾函数（三条时机不各写一份）', (panel.match(/function finish\(/g) ?? []).length === 1 && /session\.stop\(\)/.test(panel));
  check(
    '关层与开流赛跑时不留野流（异步流程在 await 之后检查卸载标志）',
    /let disposed = false/.test(panel) &&
      /disposed = true/.test(panel) &&
      (panel.match(/if \(disposed\)/g) ?? []).length >= 3,
    `if (disposed) 出现 ${(panel.match(/if \(disposed\)/g) ?? []).length} 次`,
  );
  check('错误态有"重试"出路（仅当可重试）', /failure\?\.retryable[\s\S]{0,200}重试/.test(panel));
  check('错误态有"关闭"出路（无条件）', /@click="close"/.test(panel) && panel.includes('关闭'));
  check('"换一个摄像头"只在宿主声明 scan.camera.select 时出现', /supports\(\s*'scan\.camera\.select'\s*\)/.test(panel) && /canSelect/.test(panel));
  check('没有识别器时有独立文案（与"相机打不开"分开说）', /engineMissing/.test(panel) && panel.includes('不支持扫码识别'));
  check('错误文案走展示侧映射（不下发文案）', !/messageKey\s*===\s*'/.test(panel) && /errorTextOf\(/.test(panel));

  check('回退引擎走动态 import()（拿得到模块句柄、又不必静态进主包）', /import\(\s*'zxing-wasm\/reader'\s*\)/.test(zxingSrc));
  check('没有把 zxing-wasm 静态 import 进来', !/^import[^\n]*from\s*'zxing-wasm/m.test(zxingSrc));
  check(
    'wasm 指向**打包进来的那一份**（默认是 jsDelivr CDN，断网现场等于没有回退）',
    /zxing_reader\.wasm\?url/.test(zxingSrc) && /locateFile/.test(zxingSrc),
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const total = pass + fail;
if (fail > 0) {
  console.error(`check-scan-engines FAIL：${fail}/${total} 项未通过`);
  process.exit(1);
}
console.log(`check-scan-engines OK: ${total} 项（引擎分支 / 格式名对称 / 懒加载与本地 wasm / 入口与错误态结构）`);

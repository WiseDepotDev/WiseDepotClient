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
    frameToImageData,
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

  console.log('--- 5. 端到端（进程内）：假 canvas + **真 zxing**，把整条管线跑一遍 ---');
  /*
   * 这一段是"给了条码没反应"这个反馈的正面回答。
   *
   * 为什么能在这里跑真引擎：`readBarcodes` 认 `{data,width,height}` 形状的 ImageData
   * （Node 里没有 ImageData 类也能用），而 `zxing-wasm` 在 Node 下会从包里读 wasm 文件。
   * 于是"video → canvas → getImageData → 适配器 → 引擎 → 归一化"整条链可以在**进程内**验完，
   * 不必等一台有摄像头的机器、也不必拿实物条码。
   *
   * 条空图案不是手写的：它来自 `zxing-wasm` 的 writer 生成的 Code128「TAG-0001」的 SVG，
   * 而下面这条断言本身就是"它能不能被解回原值"的证明（图案错了这条会红）。
   */
  const BARS = [
    [10, 2], [13, 1], [16, 1], [21, 2], [24, 3], [30, 1], [32, 1], [34, 1], [38, 2], [43, 2],
    [46, 1], [50, 1], [54, 1], [57, 2], [60, 3], [65, 1], [67, 3], [71, 4], [76, 2], [79, 2],
    [83, 2], [87, 2], [91, 2], [94, 2], [98, 1], [100, 2], [104, 1], [109, 2], [114, 3], [118, 1],
    [120, 2],
  ];
  const SCALE = 3;
  const frameWidth = 132 * SCALE;
  const frameHeight = 50 * SCALE;
  const pixels = new Uint8ClampedArray(frameWidth * frameHeight * 4).fill(255);
  for (const [x, w] of BARS) {
    for (let px = x * SCALE; px < (x + w) * SCALE; px += 1) {
      for (let y = 0; y < frameHeight; y += 1) {
        const i = (y * frameWidth + px) * 4;
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 255;
      }
    }
  }

  /*
   * 假 DOM：`frameToImageData` 要的只是"能 createElement、能 drawImage、能 getImageData"。
   * 断言点在于**它取了视频的真实尺寸、并按那个尺寸取像素** —— 尺寸接错的话，
   * 现实里表现就是"画面明明有码却永远解不出"。
   */
  const drawCalls = [];
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (source, x, y, w, h) => drawCalls.push({ source, w, h }),
      getImageData: (x, y, w, h) => ({ data: pixels, width: w, height: h, colorSpace: 'srgb' }),
    }),
  };
  globalThis.document = { createElement: () => fakeCanvas };

  const fakeVideo = { videoWidth: frameWidth, videoHeight: frameHeight, tag: 'video' };
  const frame = frameToImageData(fakeVideo, { current: null });
  check(
    '真实管线：按视频尺寸画一帧并取回同样尺寸的像素',
    frame !== null && frame.width === frameWidth && frame.height === frameHeight && drawCalls.length === 1 && drawCalls[0].source === fakeVideo,
    JSON.stringify({ frame: frame === null ? null : { w: frame.width, h: frame.height }, drawCalls: drawCalls.length }),
  );
  check('画面还没出来时返回 null（不去空跑引擎）', frameToImageData({ videoWidth: 0, videoHeight: 0 }, { current: null }) === null);

  const { readBarcodes } = await import(
    pathToFileURL(path.join(ROOT, 'packages/layouts/node_modules/zxing-wasm/dist/es/reader/index.js')).href
  );
  const realDecoder = createZxingDecoder({ readBarcodes });
  const realHit = await detectOnce(realDecoder, fakeVideo);
  check(
    '真实管线：**真引擎解出 Code128「TAG-0001」**（symbology 也归一化成 code128）',
    realHit !== null && realHit.code === 'TAG-0001' && realHit.symbology === 'code128',
    JSON.stringify(realHit),
  );
  const plainHit = await detectOnce(createZxingDecoder({ readBarcodes: async () => [{ text: '', format: 'Code128' }] }), fakeVideo);
  check('画面里没有码时返回 null（不是错误）', plainHit === null);
  delete globalThis.document;

  console.log('--- 6. 结构断言：入口只由能力位决定、错误态有出路、回退必须懒加载 ---');
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
  check('取景层是 v-if 挂载（关掉即卸载，卸载路径统一停流）', /<CameraScanPanel\s+v-if="scan\.cameraOpen"/.test(appFrame));
  check('切页会关掉取景层（brief §4 纪律③的"切页"一处）', /watch\(\s*\(\)\s*=>\s*route\.fullPath/.test(appFrame));
  check(
    '命中后先问"有没有字段/页面接它"，没人接才走兜底路由',
    /deliverCameraCode\(code\)/.test(appFrame) && /routeCameraScan\(code\)/.test(appFrame),
  );
  check('结果卡两端都画（相机只有桌面声明，只画手机等于扫到了不显示）', /<ScanResultCard\s*\/>/.test(appFrame));

  check(
    '打开时枚举设备并解析上次选择',
    /listCameras\(/.test(panel) && /resolveSelectedCamera\(/.test(panel),
  );
  /*
   * **首次授权前不要带 `deviceId: {exact}`**：那时 `enumerateDevices()` 给的 deviceId
   * 是不可用的占位值，带上 `exact` 会抛 `OverconstrainedError` —— 全新机器第一次点扫码
   * 正是这个状态，表现就是"点了没反应"。只有用户真的选过那一枚才钉 deviceId。
   */
  check(
    '只有用户选过的摄像头才用 deviceId 钉住（首次授权前枚举出来的 deviceId 不可用）',
    /pinned/.test(panel) && /session\.start\(media, pinned \? camera\.id : null\)/.test(panel),
  );
  check('设备被拔掉时回写选择（不每次重新回退）', /if\s*\(fellBack\)[\s\S]{0,160}writeSelectedCameraId/.test(panel));
  check('卸载时停流（关闭层 / 切页都到这里）', /onBeforeUnmount\([\s\S]{0,400}finish\(\)/.test(panel));
  check('失焦停流', /addEventListener\(\s*'blur'/.test(panel));
  check('页面不可见停流', /visibilitychange/.test(panel) && /visibilityState\s*===\s*'hidden'/.test(panel));
  check('停流走同一个收尾函数（三条时机不各写一份）', (panel.match(/function finish\(/g) ?? []).length === 1 && /session\.stop\(\)/.test(panel));
  /*
   * 取景框**不许有遮罩**：第一版用 `box-shadow: 0 0 0 100vmax var(--el-mask-color)` 做了个
   * "只亮中间"的效果，用户实测反馈是"展示的区域有一层白色屏蔽罩"—— 现场要看清画面。
   */
  check(
    '取景框没有任何遮罩（用户实测反馈过"白色屏蔽罩"）',
    // 只看**样式声明**：注释里正解释着"第一版为什么用了遮罩"，那是要留下的
    !/^\s*box-shadow\s*:/m.test(panel.replace(/\/\*[\s\S]*?\*\//g, '')),
    '取景层里出现了 box-shadow 声明',
  );
  check(
    '现场可见性：引擎种类 / 已取帧数 / 上一次引擎报错都摆在界面上',
    /engineKind/.test(panel) && /frames\.value \+= 1/.test(panel) && /已取 \$\{frames\.value\} 帧/.test(panel) && /识别出错/.test(panel),
  );
  check(
    '引擎报错不再被静默吞掉（detectOnce 有诊断出口）',
    /onError\?\.\(e\)/.test(readFileSync(path.join(LAYOUTS, 'scan-decode.ts'), 'utf8')),
  );
  check(
    '相机扫码**不走**"有人正在打字"那一支（否则结果会被静默丢掉）',
    /routeCameraScan/.test(readFileSync(path.join(LAYOUTS, 'AppFrame.vue'), 'utf8')),
  );
  check(
    '条形码输入框自带相机图标（BarcodeScanField）且同样由能力位把关',
    /supports\(\s*'scan\.camera'\s*\)/.test(readFileSync(path.join(LAYOUTS, 'BarcodeScanField.vue'), 'utf8')) &&
      /openCamera\(/.test(readFileSync(path.join(LAYOUTS, 'BarcodeScanField.vue'), 'utf8')),
  );
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
  /*
   * **CSP 必须放行 WebAssembly 编译**（这一条来自 2026-10-05 的真机复现）。
   *
   * Chromium 只在 CSP 显式写了 `'wasm-unsafe-eval'`（或 `'unsafe-eval'`）时才肯编译 wasm；
   * 而 Windows 上 Chromium **没有** `BarcodeDetector`（Shape Detection 的条码识别只在
   * macOS / Android / ChromeOS 提供），所以 wasm 被挡 = 扫码永远识别不出任何东西，
   * 界面上只表现为"给了条码没反应"。这一条 Node 侧的门禁抓不到（Node 没有 CSP），
   * 必须在这里钉住 `index.html` 的 CSP 字面量。
   */
  const indexHtml = readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8');
  check(
    "CSP 的 script-src 带 'wasm-unsafe-eval'（否则识别引擎在真机上起不来）",
    /script-src[^"]*'wasm-unsafe-eval'/.test(indexHtml),
    'index.html 的 script-src 少了 wasm-unsafe-eval —— 相机扫码会"点了没反应"',
  );
  check(
    'CSP 没有顺手放行 JS 的 eval（只放 wasm 编译）',
    !/script-src[^"]*'unsafe-eval'/.test(indexHtml),
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

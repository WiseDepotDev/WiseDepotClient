#!/usr/bin/env node
/*
 * check-scan-decode.mjs —— 条码识别引擎选择与结果归一化的门禁（B1/S2b2）。
 *
 * 为什么值得单独一条门禁：`BarcodeDetector` **不保证存在**（部分 Chromium 构建缺 codec），
 * 而"没有引擎"必须能被界面说成一句话（而不是静默什么都不发生）；
 * 各引擎给的字面量又不一致（`code_128` / `CODE 128` / 空 rawValue）。
 * 用假 detector 跑真模块，每条分支都能验。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'packages/layouts/src/scan-decode.ts');
const js = transformSync(readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'esm' }).code;
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const { pickDecoderKind, normaliseSymbology, firstCode, detectOnce } = mod;

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

console.log('--- 1. 引擎选择：内置优先，回退只在缺内置时启用，都没有要说得出"没有" ---');
check('有内置 → barcode-detector', pickDecoderKind(true, true) === 'barcode-detector');
check('有内置时**不**用回退（不给主包白增重）', pickDecoderKind(true, false) === 'barcode-detector');
check('没内置但有回退 → zxing-wasm', pickDecoderKind(false, true) === 'zxing-wasm');
check('都没有 → none（界面据此说"这台机器不支持扫码识别"）', pickDecoderKind(false, false) === 'none');

console.log('--- 2. 字面量归一化：不同引擎的写法落到同一个值 ---');
for (const [input, expected] of [
  ['code_128', 'code128'],
  ['CODE_128', 'code128'],
  ['code 128', 'code128'],
  ['qr_code', 'qrcode'],
  ['  ean-13  ', 'ean13'],
  ['', ''],
  [undefined, ''],
]) {
  check(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, normaliseSymbology(input) === expected, normaliseSymbology(input));
}

console.log('--- 3. 取第一条可用结果：跳过空值、去空白、不猜"最可信" ---');
check('空数组 → null', firstCode([]) === null);
check('null/undefined 不炸', firstCode(null) === null && firstCode(undefined) === null);
check(
  '跳过 rawValue 为空的占位项',
  firstCode([{ rawValue: '', format: 'code_128' }, { rawValue: 'TAG-0001', format: 'code_128' }])?.code === 'TAG-0001',
);
check(
  '全空白也跳过',
  firstCode([{ rawValue: '   ', format: 'qr_code' }, { rawValue: 'X' }])?.code === 'X',
);
check(
  '首尾空白去掉（有的引擎会把静区当内容带出来）',
  firstCode([{ rawValue: '  TAG-9  ', format: 'code_128' }])?.code === 'TAG-9',
  JSON.stringify(firstCode([{ rawValue: '  TAG-9  ', format: 'code_128' }])),
);
check(
  'symbology 随第一条一起归一化',
  firstCode([{ rawValue: 'A', format: 'code_128' }])?.symbology === 'code128',
);
check(
  '多个条码时取第一条（选哪条是 UX，不在识别层猜）',
  firstCode([{ rawValue: 'FIRST', format: 'qr_code' }, { rawValue: 'SECOND', format: 'qr_code' }])?.code === 'FIRST',
);
check('没有 format 也不炸', firstCode([{ rawValue: 'A' }])?.symbology === '');

console.log('--- 4. 单帧识别：没有结果不等于错误，引擎抛错也不外溢 ---');
const okDetector = { detect: async () => [{ rawValue: 'TAG-1', format: 'ean_13' }] };
const emptyDetector = { detect: async () => [] };
const brokenDetector = { detect: async () => { throw new Error('decoder exploded'); } };
check('识别到 → 返回命中', (await detectOnce(okDetector, {}))?.code === 'TAG-1');
check('这一帧没有码 → null（不是错误）', (await detectOnce(emptyDetector, {})) === null);
check('引擎抛错 → null（连续取景里不许把每帧都变成错误）', (await detectOnce(brokenDetector, {})) === null);
check('没有 detector → null', (await detectOnce(undefined, {})) === null && (await detectOnce({}, {})) === null);

const total = pass + fail;
if (fail > 0) {
  console.error(`check-scan-decode FAIL：${fail}/${total} 项未通过`);
  process.exit(1);
}
console.log(`check-scan-decode OK: ${total} 项（引擎选择 / 字面量归一化 / 空值跳过 / 单帧不炸）`);

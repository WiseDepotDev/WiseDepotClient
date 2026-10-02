#!/usr/bin/env node
/*
 * check-scan-camera.mjs —— 摄像头枚举与选择的门禁（B1/S2a）。
 *
 * 为什么用"假 mediaDevices + 假 localStorage 跑真模块"而不是源文本断言：
 * 这一片全是**分支逻辑**（未授权时 label 为空、保存的设备已被拔掉、隐私模式读不到存储…），
 * 源文本断言只能证明"代码里有这几个词"，证明不了"选到的是对的那一台"。
 * 模块本身零依赖，所以 esbuild 去掉类型后可以直接在 Node 里执行。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'packages/layouts/src/scan-camera.ts');

const js = transformSync(readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'esm' }).code;
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const { CAMERA_STORAGE_KEY, canEnumerateCameras, toCameraOptions, listCameras, readSelectedCameraId, writeSelectedCameraId, resolveSelectedCamera } = mod;

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

/** 极简 localStorage 假件：能记能删，可模拟"隐私模式抛错"。 */
function fakeStorage({ throwOnUse = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => {
      if (throwOnUse) throw new Error('denied');
      return map.has(k) ? map.get(k) : null;
    },
    setItem: (k, v) => {
      if (throwOnUse) throw new Error('denied');
      map.set(k, String(v));
    },
    removeItem: (k) => {
      if (throwOnUse) throw new Error('denied');
      map.delete(k);
    },
    _dump: () => Object.fromEntries(map),
  };
}

console.log('--- 1. 枚举能力判定 ---');
check('没有 mediaDevices → 不支持枚举', canEnumerateCameras(undefined) === false);
check('mediaDevices 无 enumerateDevices → 不支持', canEnumerateCameras({}) === false);
check('有 enumerateDevices → 支持', canEnumerateCameras({ enumerateDevices: async () => [] }) === true);

console.log('--- 2. 只取 videoinput，且 label 为空时兜底 ---');
const options = toCameraOptions([
  { kind: 'audioinput', deviceId: 'mic-1', label: '麦克风' },
  { kind: 'videoinput', deviceId: 'cam-1', label: '' },
  { kind: 'videoinput', deviceId: 'cam-2', label: '  罗技 C920  ' },
  { kind: 'videoinput', deviceId: '', label: '没有 id 的假货' },
]);
check('音频输入被排除', options.length === 2, `实得 ${options.length}`);
check('空 label 兜底成"摄像头 1"', options[0].label === '摄像头 1', options[0].label);
check('有 label 时去掉首尾空白并原样保留', options[1].label === '罗技 C920', options[1].label);
check('没有 deviceId 的设备被丢弃', options.every((o) => o.id !== ''));

console.log('--- 3. 枚举失败不炸（权限被拒时 Chromium 会抛） ---');
const threw = await listCameras({
  enumerateDevices: async () => {
    throw new Error('NotAllowedError');
  },
});
check('抛错时返回空列表而不是把异常抛给界面', Array.isArray(threw) && threw.length === 0);
check('不支持时也返回空列表', (await listCameras(undefined)).length === 0);

console.log('--- 4. 选择的读写与隐私模式 ---');
const storage = fakeStorage();
writeSelectedCameraId(storage, 'cam-2');
check('写进去能读回来', readSelectedCameraId(storage) === 'cam-2');
check('用的键是约定值', storage._dump()[CAMERA_STORAGE_KEY] === 'cam-2');
writeSelectedCameraId(storage, null);
check('传 null 表示清掉选择', readSelectedCameraId(storage) === null, `${readSelectedCameraId(storage)}`);
const denied = fakeStorage({ throwOnUse: true });
check('存储不可用时读返回 null', readSelectedCameraId(denied) === null);
writeSelectedCameraId(denied, 'cam-1'); // 不应抛
check('存储不可用时写不抛', true);
check('没有 storage 时也不抛', readSelectedCameraId(undefined) === null);

console.log('--- 5. 选择解析：设备被拔掉是"正常情况"，要回退并说明 ---');
const two = toCameraOptions([
  { kind: 'videoinput', deviceId: 'cam-1', label: '内置' },
  { kind: 'videoinput', deviceId: 'cam-2', label: '外接' },
]);
const hit = resolveSelectedCamera(two, 'cam-2');
check('保存的那台还在 → 命中且不回报回退', hit.camera.id === 'cam-2' && hit.fellBack === false);
const gone = resolveSelectedCamera(two, 'cam-9');
check('保存的那台不在 → 回退到第一台并回报', gone.camera.id === 'cam-1' && gone.fellBack === true);
const fresh = resolveSelectedCamera(two, null);
check('从没选过 → 第一台、不回报回退', fresh.camera.id === 'cam-1' && fresh.fellBack === false);
const none = resolveSelectedCamera([], 'cam-1');
check('一台都没有 → camera 为 null（界面据此显示"没有可用的摄像头"）', none.camera === null);

const total = pass + fail;
if (fail > 0) {
  console.error(`check-scan-camera FAIL：${fail}/${total} 项未通过`);
  process.exit(1);
}
console.log(`check-scan-camera OK: ${total} 项（枚举能力 / label 兜底 / 失败不炸 / 隐私模式 / 设备被拔回退）`);

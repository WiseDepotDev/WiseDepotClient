#!/usr/bin/env node
/*
 * check-scan-stream.mjs —— 相机取景会话与错误映射的门禁（B1/S2b）。
 *
 * 两条最容易出事的路径都在这里被钉住：
 *   1. **流没停**（关掉取景/切页后摄像头指示灯还亮、或第二次 start 把第一条流覆盖掉）；
 *   2. **错误说不清**（NotAllowedError 与 NotFoundError 给用户的出路完全不同）。
 * 用假 mediaDevices + 假流跑真模块，所以每条分支都能验，不必靠真机试。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'packages/layouts/src/scan-stream.ts');
const js = transformSync(readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'esm' }).code;
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const { CAMERA_ERROR, mapCameraError, CameraSession } = mod;

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

/** 假流：记录每条 track 的 stop 次数（"流有没有停"是这一片最关键的断言）。 */
function fakeStream(label) {
  const tracks = [
    { kind: 'video', stopped: 0, stop() { this.stopped += 1; } },
    { kind: 'audio', stopped: 0, stop() { this.stopped += 1; } },
  ];
  return { label, tracks, getTracks: () => tracks };
}

function domException(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}

console.log('--- 1. DOMException.name → 错误码（三个码的出路不同） ---');
check('NotAllowedError → DENIED（不可重试，要去系统设置）', mapCameraError(domException('NotAllowedError')).code === CAMERA_ERROR.DENIED && mapCameraError(domException('NotAllowedError')).retryable === false);
check('SecurityError → DENIED', mapCameraError(domException('SecurityError')).code === CAMERA_ERROR.DENIED);
check('NotReadableError → BUSY（可重试）', mapCameraError(domException('NotReadableError')).code === CAMERA_ERROR.BUSY && mapCameraError(domException('NotReadableError')).retryable === true);
check('TrackStartError → BUSY', mapCameraError(domException('TrackStartError')).code === CAMERA_ERROR.BUSY);
check('NotFoundError → UNAVAILABLE（设备被拔了）', mapCameraError(domException('NotFoundError')).code === CAMERA_ERROR.UNAVAILABLE);
check('DevicesNotFoundError → UNAVAILABLE', mapCameraError(domException('DevicesNotFoundError')).code === CAMERA_ERROR.UNAVAILABLE);
check('未知错误名 → UNAVAILABLE 且可重试（不许归到"权限被拒"）', mapCameraError(domException('SomethingNewError')).code === CAMERA_ERROR.UNAVAILABLE && mapCameraError(domException('SomethingNewError')).retryable === true);
check('非对象错误也不炸', mapCameraError('boom').code === CAMERA_ERROR.UNAVAILABLE);
check('三个码都带 messageKey（文案由 Web 侧 i18n 出）', [mapCameraError(domException('NotAllowedError')), mapCameraError(domException('NotReadableError')), mapCameraError(domException('NotFoundError'))].every((f) => typeof f.messageKey === 'string' && f.messageKey.startsWith('scan.')));

console.log('--- 2. 开流：只在成功后替换，失败保留原画面 ---');
const s1 = fakeStream('first');
const s2 = fakeStream('second');
let calls = [];
const media = {
  getUserMedia: async (constraints) => {
    calls.push(constraints);
    return s2;
  },
};
const session = new CameraSession();
check('初始没有流', session.active === false);
const first = await session.start({ getUserMedia: async () => s1 }, 'cam-1');
check('第一次 start 成功', first.ok === true && session.active === true);
const withDevice = calls;
await session.start(media, 'cam-2');
check('第二次 start 成功后会停掉第一条流', s1.tracks.every((t) => t.stopped === 1), JSON.stringify(s1.tracks.map((t) => t.stopped)));
check('旧流已不再是当前流', session.active === true);
check('显式传了 deviceId 时约束里带 exact', JSON.stringify(withDevice[0]) === JSON.stringify({ video: { deviceId: { exact: 'cam-2' } } }), JSON.stringify(withDevice[0]));

const failingMedia = { getUserMedia: async () => { throw domException('NotReadableError'); } };
const before = session.active;
const failed = await session.start(failingMedia, null);
check('start 失败返回 failure 而不是抛', failed.ok === false && failed.failure.code === CAMERA_ERROR.BUSY);
check('start 失败后仍在取景（不把已有画面弄黑）', session.active === true && before === true);

console.log('--- 3. 停流：幂等、每条 track 都停、单独 track 抛错不影响其它 ---');
session.stop();
check('stop 之后 active=false', session.active === false);
check('第二条流的每条 track 都被停掉', s2.tracks.every((t) => t.stopped === 1), JSON.stringify(s2.tracks.map((t) => t.stopped)));
session.stop();
check('重复 stop 不报错（切页/关层/失焦三处都会调）', session.active === false);
// 注意：track 数组必须**只建一次**并稳定返回。第一版写成每次 getTracks() 都新建对象，
// 于是 stop() 停的是 A 组、断言看的是 B 组 —— 红的是测试而不是模块（模块逐条 try/catch 是对的）。
const mixedTracks = [
  { stop: () => { throw new Error('track already dead'); } },
  { stopped: 0, stop() { this.stopped += 1; } },
];
const mixed = { getTracks: () => mixedTracks };
const mixedSession = new CameraSession();
await mixedSession.start({ getUserMedia: async () => mixed }, null);
mixedSession.stop();
check('一条 track 停不掉不影响其它 track 被停', mixedTracks[1].stopped === 1);

console.log('--- 4. 没有 mediaDevices / 没有 getUserMedia ---');
const noMedia = new CameraSession();
const r1 = await noMedia.start(undefined, null);
check('没有 mediaDevices → UNAVAILABLE 且不可重试', r1.ok === false && r1.failure.code === CAMERA_ERROR.UNAVAILABLE && r1.failure.retryable === false);
const r2 = await new CameraSession().start({}, null);
check('mediaDevices 无 getUserMedia → UNAVAILABLE', r2.ok === false && r2.failure.code === CAMERA_ERROR.UNAVAILABLE);
const noDevice = new CameraSession();
await noDevice.start(media, null);
check('deviceId=null 时不带 exact 约束（用系统默认）', JSON.stringify(calls[calls.length - 1]) === JSON.stringify({ video: true }), JSON.stringify(calls[calls.length - 1]));

const total = pass + fail;
if (fail > 0) {
  console.error(`check-scan-stream FAIL：${fail}/${total} 项未通过`);
  process.exit(1);
}
console.log(`check-scan-stream OK: ${total} 项（错误映射 / 只在成功后替换 / 停流幂等 / 单 track 失败隔离 / 无设备）`);

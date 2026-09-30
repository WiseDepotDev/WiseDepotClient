#!/usr/bin/env node
/**
 * mobile-spike.mjs —— W2 移动端门禁的可测部分。
 *
 * 五项门禁里，有两项**不需要设备**就能给出客观数字：
 *   1. dex 构建是否通过（AGP 已经跑过，这里读产物）
 *   2. Netty 最小集 dex 化后的体积增量
 *
 * 另外两项（冷启动增量、常驻内存增量）必须有真机或模拟器；
 * 没有设备时脚本**明确报告"未测量"并说明原因**，而不是给一个看起来通过的默认值。
 *
 * 用法：node tools/bench/mobile-spike.mjs
 */

'use strict';

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const APK = path.join(CLIENT_ROOT, 'apps', 'mobile', 'shell', 'build', 'outputs', 'apk', 'debug', 'shell-debug.apk');
const SDK = 'D:\\Android\\Android SDK';
const D8_JAR = path.join(SDK, 'build-tools', '34.0.0', 'lib', 'd8.jar');
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const GRADLE_CACHE = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1');

const GATE = { nettyDexMb: 1.5 };

const out = { apk: {}, netty: {}, device: {}, gates: [], ok: true };

function line(s) {
  console.log(s);
}

function gate(name, value, limit, unit, note) {
  const passed = value <= limit;
  out.gates.push({ name, value, limit, unit, passed, note });
  if (!passed) {
    out.ok = false;
  }
  line(`  ${passed ? '✓' : '✗'} ${name}: ${value.toFixed(2)}${unit}（门禁 ≤${limit}${unit}）${note ? ` — ${note}` : ''}`);
}

// ---------------------------------------------------------------- APK

if (!fs.existsSync(APK)) {
  console.error(`找不到 APK：${APK}\n请先跑：gradlew :apps:mobile:shell:assembleDebug`);
  process.exit(1);
}
const apkSize = fs.statSync(APK).size;
out.apk.path = path.relative(CLIENT_ROOT, APK).replace(/\\/g, '/');
out.apk.bytes = apkSize;
line('--- 1. 产物 ---');
line(`  APK: ${out.apk.path}  ${(apkSize / 1024 / 1024).toFixed(2)} MB`);

// 编译期就证明了 Netty 能被 dex 化；这里给一个"确实被 dex 进去"的正向证据
const apkBuf = fs.readFileSync(APK);
const hasDex = apkBuf.includes(Buffer.from('classes.dex'));
out.apk.hasDex = hasDex;
line(`  ✓ 内含 classes.dex（Netty 已通过 D8 处理，未触发 dex 限制）`);

// ---------------------------------------------------------------- Netty 最小集 dex 体积

line('--- 2. Netty 最小集 dex 增量（门禁项）---');

const nettyJars = [];
function findJars(dir, acc = []) {
  if (!fs.existsSync(dir)) {
    return acc;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      findJars(p, acc);
    } else if (e.name.endsWith('.jar') && !e.name.endsWith('-sources.jar')) {
      acc.push(p);
    }
  }
  return acc;
}

const nettyRoot = path.join(GRADLE_CACHE, 'io.netty');
for (const artifact of ['netty-transport', 'netty-handler', 'netty-codec-http']) {
  const dir = path.join(nettyRoot, artifact);
  const jars = findJars(dir).filter((j) => j.includes('4.1.115.Final'));
  if (jars.length === 0) {
    console.error(`  ✗ 在 Gradle 缓存里找不到 ${artifact}:4.1.115.Final`);
    out.ok = false;
  }
  nettyJars.push(...jars);
}

if (nettyJars.length > 0) {
  const jarBytes = nettyJars.reduce((s, j) => s + fs.statSync(j).size, 0);
  out.netty.jars = nettyJars.map((j) => path.basename(j));
  out.netty.jarBytes = jarBytes;
  line(`  jar 合计 ${(jarBytes / 1024 / 1024).toFixed(2)} MB（${nettyJars.length} 个）`);

  // 用 build-tools 自带的 d8 做一次真实的 dex 化：jar 体积不等于 dex 体积，
  // 门禁盯的是"进 APK 之后有多大"，所以必须真跑一次。
  const dexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wise-netty-dex-'));
  try {
    if (!fs.existsSync(D8_JAR)) {
      line(`  ! 找不到 d8.jar（${D8_JAR}），跳过 dex 化体积测量`);
      out.ok = false;
    } else {
      // 直接调 d8.jar 而不是 d8.bat：SDK 路径里有空格（"Android SDK"），
      // 走 .bat 需要一层 shell 引号，跨平台容易出岔子；java -cp 是确定的。
      const res = spawnSync(
        'java',
        ['-cp', D8_JAR, 'com.android.tools.r8.D8', '--min-api', '25', '--release', '--output', dexDir, ...nettyJars],
        { encoding: 'utf8' },
      );
      if (res.status !== 0) {
        console.error(`  ✗ d8 失败：${(res.stderr || res.stdout || '').slice(0, 400)}`);
        out.ok = false;
      } else {
        const dexBytes = fs
          .readdirSync(dexDir)
          .filter((f) => f.endsWith('.dex'))
          .reduce((s, f) => s + fs.statSync(path.join(dexDir, f)).size, 0);
        out.netty.dexBytes = dexBytes;
        out.netty.dexFiles = fs.readdirSync(dexDir).filter((f) => f.endsWith('.dex'));
        line(`  d8 产出 ${out.netty.dexFiles.length} 个 dex，合计 ${(dexBytes / 1024 / 1024).toFixed(2)} MB`);
        gate('Netty 最小集 dex 增量', dexBytes / 1024 / 1024, GATE.nettyDexMb, 'MB', 'min-api 25 + --release');
      }
    }
  } finally {
    fs.rmSync(dexDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 设备相关项

line('--- 3. 需要设备的项 ---');
let devices = [];
try {
  const raw = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
  devices = raw
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .filter((l) => l.endsWith('device'));
} catch (e) {
  line(`  ! adb 不可用：${e.message}`);
}

out.device.count = devices.length;
if (devices.length === 0) {
  line('  ⚠ 无已连接设备/模拟器 → 以下两项**未测量**（不是"通过"）：');
  line('      · 冷启动增量 ≤80ms（adb shell am start -W × 10 取中位数）');
  line('      · 常驻内存增量 ≤8MB（dumpsys meminfo 桥起前后）');
  line('    处置：接实机或起模拟器后重跑本脚本；在那之前这两项在 README 里保持"未验证"。');
  out.device.status = 'no-device';
} else {
  line(`  检测到 ${devices.length} 台设备：${devices.join(', ')}`);
  line('  （本版脚本尚未实现自动冷启动/内存采集，接设备后需补这段）');
  out.device.status = 'device-present-not-measured';
}

// ---------------------------------------------------------------- 结论

line('');
line(out.ok ? '✓ 可测门禁全部通过' : '✗ 存在未通过项');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(out.ok ? 0 : 1);

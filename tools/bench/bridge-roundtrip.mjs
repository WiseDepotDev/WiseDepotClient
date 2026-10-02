#!/usr/bin/env node
/**
 * bridge-roundtrip.mjs —— W2 的桥验收与性能门禁（桌面侧）。
 *
 * 它**不 mock 任何东西**：真的 spawn 一个 JVM 进程跑 `:bridge:host-desktop`，
 * 真的走 stdout 握手，真的用 WebSocket 连上去发帧。因此它同时是：
 *   1. 桌面宿主生命周期的证据（握手 / shutdown / 退出）；
 *   2. 协议与白名单的证据（鉴权、内建方法、未知方法、后端不可达、限流）；
 *   3. 性能门禁的证据（握手耗时、loopback 往返 p50/p95）。
 *
 * 用法：
 *   node tools/bench/bridge-roundtrip.mjs                 # 全量：功能 + 1000 次往返
 *   node tools/bench/bridge-roundtrip.mjs --count 200     # 少跑几次
 *   node tools/bench/bridge-roundtrip.mjs --json          # 只输出 JSON（给 CI 用）
 */

'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { sendReq, decodeFrame, WIRE_PROTOCOL_VERSION } from '../lib/bridge-wire.mjs';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const MAIN_CLASS = 'com.huicang.wise.bridge.host.desktop.MainKt';

const ARGV = process.argv.slice(2);
const JSON_ONLY = ARGV.includes('--json');
const COUNT = Number((ARGV[ARGV.indexOf('--count') + 1] ?? '').replace(/^--.*/, '')) || 1000;

/**
 * 传输实现：`--transport plain` 用自写 RFC6455（手机侧），缺省 Netty（桌面侧）。
 * 加这个开关的目的就是**同一套用例跑两条传输**，证明"换传输不改语义"。
 */
const TRANSPORT_ARGS = (() => {
  const i = ARGV.indexOf('--transport');
  return i >= 0 && ARGV[i + 1] ? ['--transport', ARGV[i + 1]] : [];
})();

/** 门禁阈值（与 docs/architecture.md §10 一致）。 */
const GATE = {
  handshakeMs: 700,
  p50Ms: 5,
  p95Ms: 20,
};

const results = { tests: [], perf: {}, gates: [], ok: true };

function log(...xs) {
  if (!JSON_ONLY) {
    console.log(...xs);
  }
}

function record(name, passed, detail) {
  results.tests.push({ name, passed, detail });
  if (!passed) {
    results.ok = false;
  }
  log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

function gate(name, value, limit, unit) {
  const passed = value <= limit;
  results.gates.push({ name, value, limit, unit, passed });
  if (!passed) {
    results.ok = false;
  }
  log(`  ${passed ? '✓' : '✗'} ${name}: ${value.toFixed(2)}${unit}（门禁 ≤${limit}${unit}）`);
}

// ---------------------------------------------------------------- 宿主

class Host {
  constructor(extraArgs) {
    this.child = null;
    this.extraArgs = extraArgs;
    this.handshake = null;
    this.stderr = '';
  }

  async start() {
    if (!fs.existsSync(LIB_DIR)) {
      throw new Error(`找不到宿主产物：${LIB_DIR}\n请先跑：gradlew :bridge:host-desktop:installDist "-Pwise.skipAndroid"`);
    }
    const classpath = path.join(LIB_DIR, '*');
    const t0 = Date.now();
    this.child = spawn('java', ['-cp', classpath, MAIN_CLASS, ...this.extraArgs, ...TRANSPORT_ARGS], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.on('data', (d) => {
      this.stderr += d.toString();
    });

    this.handshake = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`握手超时（8s）。stderr:\n${this.stderr}`)), 8000);
      this.child.stdout.on('data', (d) => {
        buf += d.toString();
        const line = buf.split('\n').find((l) => l.trim().startsWith('{'));
        if (line) {
          clearTimeout(timer);
          resolve({ ...JSON.parse(line), handshakeMs: Date.now() - t0 });
        }
      });
      this.child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`宿主提前退出 code=${code}\nstderr:\n${this.stderr}`));
      });
    });
    return this.handshake;
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      return this.child?.exitCode ?? null;
    }
    const exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
    this.child.stdin.write('shutdown\n');
    return await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  }
}

// ---------------------------------------------------------------- WS 客户端

function openSocket(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    // 必须显式处理 onclose：服务端在握手阶段关闭时只有 onclose（没有 onerror），
    // 不处理就会退化成"5 秒后超时"，把真实失败原因吞掉。
    ws.onclose = (ev) => {
      clearTimeout(timer);
      reject(new Error(`ws 被服务端关闭 code=${ev.code} reason=${ev.reason || '(空)'}`));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws 连接错误'));
    };
  });
}

/** 一次请求/响应；返回 {frame} 或 {timeout:true}。 */
function call(ws, id, method, params, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    const onMessage = (ev) => {
      const frame = decodeFrame(new Uint8Array(ev.data));
      if (frame.id !== id) {
        return;
      }
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve({ frame });
    };
    ws.addEventListener('message', onMessage);
    sendReq(ws, id, method, params);
  });
}

// ---------------------------------------------------------------- 用例

/**
 * 取一个**刚被释放、确定没人监听**的端口。
 *
 * 为什么不能写死 18080：本机恰好有东西监听它（实测返回 HTTP 400），
 * 于是"后端不可达"的用例会变成"后端返回 400"，测的就不是要测的东西了。
 * 这类"环境里恰好有东西"的假阳性，必须用运行时探测消掉。
 */
async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function functionalSuite() {
  log('--- 1. 鉴权与生命周期（默认限流 50/s）---');
  const dead = await closedPort();
  const host = new Host(['--backend', `http://127.0.0.1:${dead}`, '--ver', '1.0.0-bench', '--capabilities', 'storage.secure']);
  const hs = await host.start();
  results.perf.handshakeMs = hs.handshakeMs;
  record('宿主经 stdout 完成握手并给出临时端口', Number.isInteger(hs.port) && hs.port > 0, `port=${hs.port}`);
  gate('桌面桥握手（spawn → handshake）', hs.handshakeMs, GATE.handshakeMs, 'ms');

  // 错误 token 必须被拒
  let rejected = false;
  try {
    const bad = await openSocket(hs.port, 'wrong-token');
    bad.close();
  } catch {
    rejected = true;
  }
  record('错误 token 被拒绝', rejected);

  const ws = await openSocket(hs.port, hs.token);
  record('正确 token 建立连接', ws.readyState === WebSocket.OPEN);

  const ping = await call(ws, '1', 'bridge.ping');
  record(
    '内建方法 bridge.ping 可用',
    ping.frame?.type === 'res' &&
      ping.frame.data?.protocol === WIRE_PROTOCOL_VERSION &&
      ping.frame.data?.platform === 'desktop',
    JSON.stringify(ping.frame?.data ?? ping.frame),
  );

  const caps = await call(ws, '2', 'bridge.capabilities');
  record(
    '内建方法 bridge.capabilities 回能力表',
    caps.frame?.type === 'res' && Array.isArray(caps.frame.data?.capabilities),
    JSON.stringify(caps.frame?.data ?? caps.frame),
  );

  const unknown = await call(ws, '3', 'definitely.not.a.method');
  record(
    '未登记方法被白名单拒绝（桥不是通用透传）',
    unknown.frame?.type === 'err' && unknown.frame.error?.code === 'BRIDGE_METHOD_UNKNOWN',
    JSON.stringify(unknown.frame?.error ?? unknown.frame),
  );

  const badParams = await call(ws, '4', 'inventory.detail', { wrong: 'x' });
  record(
    '缺路径参数判为 BRIDGE_PARAMS_INVALID',
    badParams.frame?.type === 'err' && badParams.frame.error?.code === 'BRIDGE_PARAMS_INVALID',
    JSON.stringify(badParams.frame?.error ?? badParams.frame),
  );

  const unreachable = await call(ws, '5', 'inventory.list', { page: 1, size: 20 });
  record(
    '真契约方法走后端，后端不可达→ BRIDGE_BACKEND_UNREACHABLE（可重试）',
    unreachable.frame?.type === 'err' &&
      unreachable.frame.error?.code === 'BRIDGE_BACKEND_UNREACHABLE' &&
      unreachable.frame.error?.retryable === true,
    JSON.stringify(unreachable.frame?.error ?? unreachable.frame),
  );

  // 限流：默认 50/s + burst 100，连打 200 次必然命中
  let limited = 0;
  for (let i = 0; i < 200; i += 1) {
    const r = await call(ws, `rl-${i}`, 'bridge.ping');
    if (r.frame?.type === 'err' && r.frame.error?.code === 'BRIDGE_RATE_LIMITED') {
      limited += 1;
    }
  }
  record('限流生效（连打 200 次出现 BRIDGE_RATE_LIMITED）', limited > 0, `命中 ${limited} 次`);

  ws.close();
  const code = await host.stop();
  record('stdin 收到 shutdown 后正常退出', code === 0, `exit=${code}`);
}

async function perfSuite() {
  log('--- 2. loopback 往返性能（限流放宽到 100k/s）---');
  const dead = await closedPort();
  const host = new Host(['--backend', `http://127.0.0.1:${dead}`, '--ver', '1.0.0-bench', '--max-rps', '100000']);
  const hs = await host.start();
  const ws = await openSocket(hs.port, hs.token);

  // 预热：JIT 之前的数据不该进统计
  for (let i = 0; i < 50; i += 1) {
    await call(ws, `w-${i}`, 'bridge.ping');
  }

  const samples = [];
  for (let i = 0; i < COUNT; i += 1) {
    const t0 = performance.now();
    const r = await call(ws, `p-${i}`, 'bridge.ping');
    const dt = performance.now() - t0;
    if (r.frame?.type === 'res') {
      samples.push(dt);
    }
  }
  ws.close();
  await host.stop();

  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  results.perf.roundTrips = samples.length;
  results.perf.p50Ms = at(0.5);
  results.perf.p95Ms = at(0.95);
  results.perf.p99Ms = at(0.99);
  results.perf.minMs = samples[0];
  results.perf.maxMs = samples[samples.length - 1];

  log(`  样本 ${samples.length} 次：p50=${at(0.5).toFixed(2)}ms p95=${at(0.95).toFixed(2)}ms p99=${at(0.99).toFixed(2)}ms`);
  gate('loopback 往返 p50', at(0.5), GATE.p50Ms, 'ms');
  gate('loopback 往返 p95', at(0.95), GATE.p95Ms, 'ms');
}

/**
 * 真后端套件（可选）：把桥接到**真实运行的 WiseDeoptServer** 上。
 *
 * 这是 W2 最有价值的一条证据：它一次性证明了"信封能被后端接受 / 响应能解回 payload.data"，
 * 也就是"不改后端"这句话在真实服务上是成立的，而不只是我自己的 mock 上成立。
 *
 * 用到的两个端点都是无需登录也能区分行为的：
 *   - `captcha.generate`：公开端点，成功路径（顺带验证一个几 KB 的 base64 大帧）
 *   - `dashboard.summary`：需要鉴权，未登录必然 401 → 验证 401 → error_session_expired 的映射
 */
async function realBackendSuite(backendUrl) {
  log(`--- 3. 真后端端到端（${backendUrl}）---`);
  const host = new Host(['--backend', backendUrl, '--ver', '1.0.0-bench']);
  const hs = await host.start();
  const ws = await openSocket(hs.port, hs.token);

  const captcha = await call(ws, 'r1', 'captcha.generate', { type: 'math' }, 15000);
  const data = captcha.frame?.data ?? {};
  record(
    '真后端：captcha.generate 经桥返回 payload.data',
    captcha.frame?.type === 'res' && typeof data.captchaId === 'string' && String(data.captchaImage ?? '').startsWith('data:image'),
    captcha.frame?.type === 'res'
      ? `captchaId=${String(data.captchaId).slice(0, 8)}… image=${String(data.captchaImage).length} 字节`
      : JSON.stringify(captcha.frame),
  );

  const dashboard = await call(ws, 'r2', 'dashboard.summary', undefined, 15000);
  const err = dashboard.frame?.error ?? {};
  // 真实行为（W2 实测）：后端 RequestSignatureFilter 对**没有 Bearer** 的请求要求 X-Signature/X-Timestamp/X-Nonce 头，
  // 而它拒的时候回的是**扁平错误体**（`{"code":400,…}`，不是统一信封），
  // 因此桥只能判到 HTTP 层 → `HTTP-400`。这正是"不带令牌就别指望 401"的原因。
  record(
    '真后端：无 Bearer → 后端签名过滤器 400（非信封体，桥退到 HTTP-400）',
    dashboard.frame?.type === 'err' && err.code === 'HTTP-400',
    JSON.stringify(dashboard.frame?.error ?? dashboard.frame),
  );
  ws.close();
  await host.stop();

  // 带 Bearer 时后端跳过签名校验，请求进到鉴权层。
  // 实测：**令牌无效时后端回 HTTP 200 + 业务码 AUTH-0002**（不是 401），
  // 因此桥按"业务错误"透传该码，文案由 Web 侧按码映射（延续"谁展示谁拥有"）。
  const authed = new Host(['--backend', backendUrl, '--ver', '1.0.0-bench', '--access-token', 'invalid-token-for-bench']);
  const hs2 = await authed.start();
  const ws2 = await openSocket(hs2.port, hs2.token);
  const expired = await call(ws2, 'r3', 'dashboard.summary', undefined, 15000);
  record(
    '真后端：带无效令牌 → 业务码 AUTH-0002 原样透传（桥不发明文案）',
    expired.frame?.type === 'err' && String(expired.frame.error?.code).startsWith('AUTH-'),
    JSON.stringify(expired.frame?.error ?? expired.frame),
  );
  ws2.close();
  await authed.stop();
}

async function main() {
  log('=== W2 桌面桥验收与性能门禁 ===');
  await functionalSuite();
  await perfSuite();
  const backendIdx = ARGV.indexOf('--backend-url');
  if (backendIdx >= 0 && ARGV[backendIdx + 1]) {
    await realBackendSuite(ARGV[backendIdx + 1]);
  } else {
    log('--- 3. 真后端端到端：跳过（未传 --backend-url）---');
  }
  log('');
  log(results.ok ? '✓ 全部通过' : '✗ 存在未通过项');

  if (JSON_ONLY) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  }
  process.exit(results.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`bench 失败：${e.message}`);
  process.exit(1);
});

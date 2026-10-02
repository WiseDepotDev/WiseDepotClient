#!/usr/bin/env node
/**
 * real-smoke.mjs —— **真后端**全链路冒烟（W3 欠的最后一项）。
 *
 * 与 w3-session.mjs 的分工：
 *   · w3-session 用**可脚本化假后端**把边界逼死（令牌截留、续期时序）；
 *   · 本脚本用**真实运行的 WiseDeoptServer** 走一遍真流程，证明"接口对得上、字段对得上"。
 *
 * 登录要过验证码，而验证码是给人看的图 —— 这里从后端自己的 Redis 读答案，
 * 目的**不是**绕过验证码，而是让"登录后的每一步"可以在无人值守下被自动回归。
 * （生产环境当然不该有这条路径；它是测试基础设施，跑在本机开发栈上。）
 *
 * 凭据一律从 `deploy/.env.local` 读，脚本里不出现任何口令（STD-SEC-01 零硬编码）。
 *
 * 用法：
 *   node tools/bench/real-smoke.mjs                 # 用默认账号
 *   node tools/bench/real-smoke.mjs --user admin    # 指定账号前缀（对应 WD_ADMIN_PASSWORD）
 */

'use strict';

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { sendReq, decodeFrame } from '../lib/bridge-wire.mjs';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(CLIENT_ROOT, '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const MAIN_CLASS = 'com.huicang.wise.bridge.host.desktop.MainKt';
const ENV_FILE = path.join(WORKSPACE_ROOT, 'deploy', '.env.local');

const ARGV = process.argv.slice(2);
const BACKEND = ARGV.includes('--backend') ? ARGV[ARGV.indexOf('--backend') + 1] : 'http://127.0.0.1:18080';
const USER_KIND = (ARGV.includes('--user') ? ARGV[ARGV.indexOf('--user') + 1] : 'operator').toUpperCase();
/** 账号名不总是等于口令前缀（这里两者当前一致，但不要把它们绑死）。 */
const USERNAME = USER_KIND.toLowerCase();

const results = [];
let ok = true;

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  if (!passed) {
    ok = false;
  }
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 本地凭据

function readEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`找不到 ${ENV_FILE}（含 Redis 与初始账号口令；见 deploy/.env.local.example）`);
  }
  const map = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) {
      map[m[1]] = m[2];
    }
  }
  return map;
}

function redisGet(key, password) {
  const out = execFileSync(
    'docker',
    ['exec', 'wd-local-redis', 'redis-cli', '-a', password, '--no-auth-warning', 'GET', key],
    { encoding: 'utf8' },
  );
  return out.trim();
}

// ---------------------------------------------------------------- 桥

async function startBridge() {
  const child = spawn('java', ['-cp', path.join(LIB_DIR, '*'), MAIN_CLASS, '--backend', BACKEND, '--ver', '1.0.0-smoke'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  const handshake = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`握手超时\n${stderr}`)), 8000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.once('exit', (c) => reject(new Error(`宿主提前退出 code=${c}\n${stderr}`)));
  });
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${handshake.port}/bridge?token=${encodeURIComponent(handshake.token)}`);
    s.binaryType = 'arraybuffer';
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error('ws 连接失败'));
    s.onclose = (e) => reject(new Error(`ws 关闭 code=${e.code}`));
  });
  return { child, handshake, ws };
}

function call(ws, id, method, params, timeoutMs = 20000) {
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

/** 令牌泄漏检查：任何一帧里出现 token/accessToken/refreshToken 的非空值都算失败。 */
function leaksToken(frame) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') {
      return false;
    }
    if (Array.isArray(v)) {
      return v.some(walk);
    }
    return Object.entries(v).some(([k, val]) => {
      if (/^(access|refresh)?token$/i.test(k)) {
        return typeof val === 'string' && val.length > 0;
      }
      return walk(val);
    });
  };
  return walk(frame);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!fs.existsSync(LIB_DIR)) {
    throw new Error(`找不到宿主产物：${LIB_DIR}\n请先跑 gradlew :bridge:host-desktop:installDist`);
  }
  const env = readEnv();
  const redisPwd = env.WD_REDIS_PASSWORD;
  const password = env[`WD_${USER_KIND}_PASSWORD`];
  const username = USERNAME;
  if (!redisPwd || !password) {
    throw new Error(`deploy/.env.local 缺少 WD_REDIS_PASSWORD 或 WD_${USER_KIND}_PASSWORD`);
  }

  console.log(`=== 真后端冒烟（${BACKEND}，账号 ${username}）===`);
  const { child, ws } = await startBridge();
  const frames = [];

  try {
    console.log('--- 1. 未登录 ---');
    const s0 = await call(ws, 'r0', 'bridge.session');
    frames.push(s0.frame);
    record('bridge.session 未登录', s0.frame?.data?.authenticated === false, JSON.stringify(s0.frame?.data));

    console.log('--- 2. 真验证码 ---');
    const cap = await call(ws, 'r1', 'captcha.generate', { type: 'math' });
    frames.push(cap.frame);
    const captchaId = cap.frame?.data?.captchaId;
    const image = String(cap.frame?.data?.captchaImage ?? '');
    record('captcha.generate 返回真验证码', cap.frame?.type === 'res' && Boolean(captchaId) && image.startsWith('data:image'), `id=${String(captchaId).slice(0, 8)}… 图 ${image.length} 字节`);

    const code = redisGet(`captcha:${captchaId}`, redisPwd);
    record('从后端自己的 Redis 取到验证码答案（测试基础设施，非生产路径）', /^[A-Za-z0-9]{4,6}$/.test(code), `code=${code}`);

    console.log('--- 3. 真登录 ---');
    const login = await call(ws, 'r2', 'auth.login', { username, password, captchaId, captchaCode: code });
    frames.push(login.frame);
    record('auth.login 成功', login.frame?.type === 'res', login.frame?.type === 'res' ? `username=${login.frame.data?.username}` : JSON.stringify(login.frame));
    record('登录响应**不含令牌**', !leaksToken(login.frame), JSON.stringify(login.frame?.data));

    const s1 = await call(ws, 'r3', 'bridge.session');
    frames.push(s1.frame);
    record('登录后 bridge.session.authenticated = true', s1.frame?.data?.authenticated === true, JSON.stringify(s1.frame?.data));

    console.log('--- 4. 真数据 ---');
    const dash = await call(ws, 'r4', 'dashboard.summary');
    frames.push(dash.frame);
    record(
      'dashboard.summary 返回真看板数据',
      dash.frame?.type === 'res' && typeof dash.frame.data?.inventoryTotal === 'number',
      dash.frame?.type === 'res'
        ? `库存 ${dash.frame.data.inventoryTotal} / 今日告警 ${dash.frame.data.todayAlertCount} / 设备在线 ${dash.frame.data.deviceOnlineCount}`
        : JSON.stringify(dash.frame),
    );

    const inv = await call(ws, 'r5', 'inventory.list', { page: 1, size: 5 });
    frames.push(inv.frame);
    const rows = inv.frame?.data?.rows;
    record(
      'inventory.list 分页查询返回真数据（证明路径参数/查询串拆分对真后端成立）',
      inv.frame?.type === 'res' && Array.isArray(rows),
      inv.frame?.type === 'res' ? `total=${inv.frame.data?.total} rows=${rows.length}` : JSON.stringify(inv.frame),
    );

    // `user.list` 需要用户管理权限。用 operator 跑时它**应当被拒**——
    // 这条不是"跑不通"，而是"授权链在桥的路径上没有被绕过"的正向证据：
    // 桥只是转发，权限判定仍然完全由后端的 @RequiresPermission 负责。
    // 想要非空真数据就换 admin 跑：`--user admin`。
    const users = await call(ws, 'r6', 'user.list', { page: 1, size: 5 });
    frames.push(users.frame);
    const userRows = users.frame?.data?.items ?? users.frame?.data?.rows;
    if (username === 'operator') {
      record(
        'operator 调 user.list **被拒**（鉴权在真后端生效，桥不绕过权限）',
        users.frame?.type === 'err' && String(users.frame.error?.code).startsWith('AUTH-'),
        JSON.stringify(users.frame?.error ?? users.frame?.data),
      );
    } else {
      record(
        'admin 调 user.list 返回**非空**真数据（空库也能验出值是否正确）',
        users.frame?.type === 'res' && Array.isArray(userRows) && userRows.length > 0,
        users.frame?.type === 'res'
          ? `${Array.isArray(userRows) ? userRows.length : '?'} 个账号：${(userRows ?? []).map((u) => u.username).join(', ')}`
          : JSON.stringify(users.frame),
      );
    }

    console.log('--- 5. 登出 ---');
    const out = await call(ws, 'r7', 'auth.logout');
    frames.push(out.frame);
    const s2 = await call(ws, 'r8', 'bridge.session');
    frames.push(s2.frame);
    record('登出后会话清空', s2.frame?.data?.authenticated === false, JSON.stringify(s2.frame?.data));

    console.log('--- 6. 全程无令牌泄漏 ---');
    const leaked = frames.filter((f) => f && leaksToken(f));
    record('所有响应帧里都没有非空令牌字段', leaked.length === 0, leaked.length === 0 ? `检查 ${frames.length} 帧` : `${leaked.length} 帧可疑`);
  } finally {
    ws.close();
    child.stdin.write('shutdown\n');
    await new Promise((r) => setTimeout(r, 400));
    child.kill();
  }

  console.log('');
  console.log(ok ? '✓ 真后端冒烟全部通过' : '✗ 存在未通过项');
  console.log(JSON.stringify({ ok, backend: BACKEND, user: username, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`真后端冒烟失败：${e.message}`);
  process.exit(1);
});

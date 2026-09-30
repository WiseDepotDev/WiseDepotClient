#!/usr/bin/env node
/**
 * w3-session.mjs —— W3 会话与令牌截留的验收。
 *
 * 为什么用**假后端**而不是真后端：真后端的登录要过验证码，而"令牌有没有漏给 JS"这件事
 * 必须能被**确定性**地断言（真验证码不可控，测不出边界）。因此这里起一个本地 HTTP 服务，
 * 精确控制登录响应、令牌有效期与失败时机，把桥的行为逼到墙角。
 *
 * 验的是方案里安全含义最重的一条：
 *   **令牌只允许存在于桥进程内，任何进出的 JSON 都会被扫一遍。**
 *
 * 用法：node tools/bench/w3-session.mjs
 */

'use strict';

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const MAIN_CLASS = 'com.huicang.wise.bridge.host.desktop.MainKt';

const ACCESS_V1 = 'ACCESS-TOKEN-V1-SECRET';
const ACCESS_V2 = 'ACCESS-TOKEN-V2-SECRET';
const REFRESH_V1 = 'REFRESH-TOKEN-V1-SECRET';

const results = [];
let ok = true;

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  if (!passed) {
    ok = false;
  }
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 假后端

/**
 * 状态机由 `state` 控制，让用例可以精确制造"令牌失效 → 续期 → 重放"的时序。
 * `seen` 记录桥实际发来的请求，用来证明"桥把令牌带上了"（而不是碰巧成功）。
 */
const state = { accessToken: ACCESS_V1, refreshToken: REFRESH_V1, rejectNext: false, refreshCalls: 0 };
const seen = [];

function envelope(data) {
  return JSON.stringify({
    header: { request_id: `fake-${Date.now()}`, packet_type: 'UNKNOWN', timestamp: Date.now() },
    payload: { code: 'RES-0000', message: '处理成功', data },
  });
}

function fail(code) {
  return JSON.stringify({ header: {}, payload: { code, errorCode: code, message: '失败', data: null } });
}

function startFakeBackend() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const auth = req.headers.authorization ?? '';
      seen.push({ url: req.url, auth, body: body.slice(0, 200) });
      res.setHeader('content-type', 'application/json; charset=utf-8');

      if (req.url.startsWith('/api/auth/login')) {
        res.end(
          envelope({
            accessToken: state.accessToken,
            refreshToken: state.refreshToken,
            username: 'operator',
            passwordChangeRequired: false,
          }),
        );
        return;
      }

      if (req.url.startsWith('/api/auth/refresh-token')) {
        state.refreshCalls += 1;
        const provided = JSON.parse(body || '{}')?.payload?.data?.refreshToken;
        if (provided !== state.refreshToken) {
          res.end(fail('AUTH-0003'));
          return;
        }
        const rotated = state.accessToken === ACCESS_V1 ? ACCESS_V2 : ACCESS_V1;
        state.accessToken = rotated;
        res.end(envelope({ accessToken: rotated, refreshToken: state.refreshToken, username: 'operator' }));
        return;
      }

      if (req.url.startsWith('/api/auth/logout')) {
        res.end(envelope({}));
        return;
      }

      if (req.url.startsWith('/api/dashboard/summary')) {
        if (state.rejectNext) {
          state.rejectNext = false;
          res.end(fail('AUTH-0002'));
          return;
        }
        if (auth !== `Bearer ${state.accessToken}`) {
          res.end(fail('AUTH-0002'));
          return;
        }
        res.end(envelope({ inventoryTotal: 42, todayAlertCount: 1, inspectionProgress: 50, deviceOnlineCount: 8 }));
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------------------------------------------------------------- 桥进程 + WS

async function startBridge(backendPort) {
  const child = spawn(
    'java',
    ['-cp', path.join(LIB_DIR, '*'), MAIN_CLASS, '--backend', `http://127.0.0.1:${backendPort}`, '--ver', '1.0.0-w3'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
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
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error('ws 连接失败'));
    s.onclose = (e) => reject(new Error(`ws 关闭 code=${e.code}`));
  });
  return { child, handshake, ws };
}

function call(ws, id, method, params) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 8000);
    const onMessage = (ev) => {
      const frame = JSON.parse(String(ev.data));
      if (frame.id !== id) {
        return;
      }
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve({ frame });
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ v: 3, type: 'req', id, method, ...(params ? { params } : {}) }));
  });
}

function containsSecret(frame) {
  const text = JSON.stringify(frame);
  return [ACCESS_V1, ACCESS_V2, REFRESH_V1].some((s) => text.includes(s));
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!fs.existsSync(LIB_DIR)) {
    throw new Error(`找不到宿主产物：${LIB_DIR}\n请先跑 gradlew :bridge:host-desktop:installDist`);
  }
  const { server, port: backendPort } = await startFakeBackend();
  const { child, ws } = await startBridge(backendPort);

  try {
    console.log('--- 1. 登录前的会话状态 ---');
    const before = await call(ws, 's0', 'bridge.session');
    record('未登录时 bridge.session.authenticated = false', before.frame?.data?.authenticated === false, JSON.stringify(before.frame?.data));

    console.log('--- 2. 登录与**令牌截留** ---');
    const login = await call(ws, 's1', 'auth.login', {
      username: 'operator',
      password: 'x',
      captchaId: 'cid',
      captchaCode: '0000',
    });
    record('auth.login 经桥调用成功', login.frame?.type === 'res', login.frame?.type ?? JSON.stringify(login.frame));
    record(
      '**响应里没有任何令牌**（accessToken / refreshToken 及其值全部不可见）',
      !containsSecret(login.frame) &&
        login.frame?.data?.accessToken === null &&
        login.frame?.data?.refreshToken === null,
      JSON.stringify(login.frame?.data),
    );
    record('身份字段照常下发（UI 需要知道"谁登录了"）', login.frame?.data?.username === 'operator', JSON.stringify(login.frame?.data));

    const after = await call(ws, 's2', 'bridge.session');
    record(
      '登录后 bridge.session 反映已认证（令牌存于桥内）',
      after.frame?.data?.authenticated === true && after.frame?.data?.username === 'operator',
      JSON.stringify(after.frame?.data),
    );
    record('bridge.session 自身也不含令牌', !containsSecret(after.frame));

    console.log('--- 3. 桥把令牌带上了（而不是碰巧成功）---');
    const dash = await call(ws, 's3', 'dashboard.summary');
    record(
      '受保护方法成功，且假后端确实收到 Bearer 令牌',
      dash.frame?.type === 'res' && seen.some((s) => s.url.includes('dashboard') && s.auth === `Bearer ${ACCESS_V1}`),
      `inventoryTotal=${dash.frame?.data?.inventoryTotal}`,
    );

    console.log('--- 4. 令牌失效 → 自动续期 → 重放一次 ---');
    state.rejectNext = true;
    state.accessToken = state.accessToken; // 保持 v1，让场景可控
    const refreshBefore = state.refreshCalls;
    const dash2 = await call(ws, 's4', 'dashboard.summary');
    record(
      '令牌失效时自动续期并重放，UI 无感',
      dash2.frame?.type === 'res' && state.refreshCalls === refreshBefore + 1,
      `refresh 调用 ${state.refreshCalls - refreshBefore} 次，结果 ${dash2.frame?.type}`,
    );
    record('续期后的重放带的是**新**令牌', seen.some((s) => s.url.includes('dashboard') && s.auth === `Bearer ${state.accessToken}`), state.accessToken);

    console.log('--- 5. 登出清会话 ---');
    const logout = await call(ws, 's5', 'auth.logout');
    record('auth.logout 调用成功', logout.frame?.type === 'res', logout.frame?.type ?? JSON.stringify(logout.frame));
    const afterLogout = await call(ws, 's6', 'bridge.session');
    record('登出后 authenticated = false', afterLogout.frame?.data?.authenticated === false, JSON.stringify(afterLogout.frame?.data));
  } finally {
    ws.close();
    child.stdin.write('shutdown\n');
    await new Promise((r) => setTimeout(r, 400));
    child.kill();
    server.close();
  }

  console.log('');
  console.log(ok ? '✓ W3 会话与令牌截留全部通过' : '✗ 存在未通过项');
  console.log(JSON.stringify({ ok, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`w3-session bench 失败：${e.message}`);
  process.exit(1);
});

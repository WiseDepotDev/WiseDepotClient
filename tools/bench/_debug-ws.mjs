#!/usr/bin/env node
/**
 * _debug-ws.mjs —— 用 CDP 的 **Network 域**盯一次 WebSocket 的完整生命周期。
 *
 * 为什么需要它：前几次排查都是靠 logcat 里的 CONSOLE 记录，而"日志里什么都没有"
 * 恰恰是最难判断的状态 —— 可能是连上了（无错误可打），也可能是根本没发起。
 * Network 域会把协议层的每一步都报出来：
 *   webSocketCreated → webSocketWillSendHandshakeRequest → webSocketHandshakeResponseReceived
 *   → webSocketFrameReceived/… 或 webSocketFrameError / webSocketClosed
 * 卡在哪一步一目了然。
 *
 * 用法：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *       node tools/bench/_debug-ws.mjs
 */

'use strict';

const events = [];
const byMethod = (m) => events.filter((e) => e.method === m);

const res = await fetch('http://127.0.0.1:9222/json');
const page = (await res.json()).find((t) => t.type === 'page');
if (!page) {
  console.error('没有 page 目标');
  process.exit(1);
}
console.log(`目标：${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method && m.method.startsWith('Network.webSocket')) {
    events.push(m);
  }
  if (m.method === 'Log.entryAdded') {
    events.push({ method: 'Log.entryAdded', params: m.params });
  }
};

ws.onopen = async () => {
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');

  // 从页面里发起一次与 bridge-client 完全相同的连接
  const start = await send('Runtime.evaluate', {
    expression: `(async () => {
      const r = await fetch('/__bridge.json', { cache: 'no-store' });
      const b = await r.json();
      const url = 'ws://' + (b.host || '127.0.0.1') + ':' + b.port + '/bridge?token=' + encodeURIComponent(b.token);
      window.__wsUrl = url;
      window.__wsState = 'pending';
      try {
        const s = new WebSocket(url);
        window.__ws = s;
        s.onopen = () => { window.__wsState = 'open'; };
        s.onerror = () => { window.__wsState = 'error'; };
        s.onclose = (e) => { window.__wsState = 'close:' + e.code + ':' + (e.reason || ''); };
      } catch (e) { window.__wsState = 'throw:' + e.message; }
      return JSON.stringify({ url, readyStateNow: window.__ws ? window.__ws.readyState : -1 });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('发起：', start.result?.result?.value);

  await new Promise((r) => setTimeout(r, 5000));

  const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ state: window.__wsState, readyState: window.__ws ? window.__ws.readyState : -1 })`,
    returnByValue: true,
  });
  console.log('5 秒后：', state.result?.result?.value);

  console.log('--- WebSocket 协议层事件 ---');
  if (events.length === 0) {
    console.log('  （一条都没有 —— 说明连接根本没发起，或 Network 域没捕获到）');
  }
  for (const e of events) {
    const p = e.params || {};
    if (e.method === 'Log.entryAdded') {
      console.log(`  [log] ${p.entry?.text?.slice(0, 240)}`);
      continue;
    }
    const detail =
      e.method === 'Network.webSocketCreated'
        ? p.url
        : e.method === 'Network.webSocketWillSendHandshakeRequest'
          ? JSON.stringify(p.request?.headers ?? {})
          : e.method === 'Network.webSocketHandshakeResponseReceived'
            ? `status=${p.response?.status} ${p.response?.statusText}`
            : e.method === 'Network.webSocketFrameError'
              ? p.errorMessage
              : e.method === 'Network.webSocketClosed'
                ? `code=${p.code}`
                : JSON.stringify(p).slice(0, 160);
    console.log(`  ${e.method.replace('Network.', '')}  ${detail}`);
  }

  ws.close();
  process.exit(0);
};

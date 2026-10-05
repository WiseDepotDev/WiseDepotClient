#!/usr/bin/env node
/**
 * _debug-cdp.mjs —— 通过 Chrome DevTools Protocol 进**页面内部**取证。
 *
 * 为什么需要它：WebView 的白屏在 logcat 里什么都看不到（没有 CSP 报错、没有 JS 报错、也没有
 * "连不上"的日志）。CDP 是唯一能问"页面自己到底遇到了什么"的通道：
 * 它既能看到 `document.body.innerText`（渲染到了哪一步），也能看到 Log 域里的
 * Mixed Content / CSP 违规条目 —— 这两类问题在 logcat 里是**静默**的。
 *
 * 用法（先 adb forward）：
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   node tools/bench/_debug-cdp.mjs        # 自动从 http://127.0.0.1:9222/json 取目标
 */

'use strict';

const CDP_PORT = process.env.CDP_PORT ?? '9222';

const DIAG = `
(async () => {
  const out = { bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) };
  out.origin = location.origin;
  try {
    const res = await fetch('/__bridge.json', { cache: 'no-store' });
    out.bootStatus = res.status;
    if (res.ok) {
      const boot = await res.json();
      out.port = boot.port;
      out.host = boot.host;
      out.protocol = boot.protocol;
      out.wsResult = await new Promise(async (resolve) => {
        const t = setTimeout(() => resolve('timeout'), 6000);
        try {
          // 用引导下发的 host，**不要硬编码 127.0.0.1** ——
          // WSA 上必须连 loopback0 的点对点地址，硬编码会让探测本身失败（这不是应用的问题）。
          const host = boot.host || '127.0.0.1';
          /*
           * v5：URL 上**没有任何凭据**，但必须带客户端临时公钥（参数 k），否则服务端按
           * "缺少客户端公钥"回 400 —— 那会让这条诊断在一切正常时也报失败。
           *
           * 这里只生成一对临时密钥（**不做 ECDH、不做 KDF**）：本探针要看的是
           * "loopback + CSP + 升级 + 服务端的 hello"这一段，完整的加密调用由
           * tools/bench/bridge-roundtrip.mjs 与桌面自检负责。
           *
           * 注意：本段是注入到页面里的字符串，不能出现反引号（会截断外层模板串）。
           */
          const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
          const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
          const k = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
          const s = new WebSocket('ws://' + host + ':' + boot.port + '/bridge?k=' + k);
          s.binaryType = 'arraybuffer';
          s.onopen = () => { out.wsOpen = true; };
          s.onmessage = (e) => {
            clearTimeout(t);
            const size = e.data?.byteLength ?? String(e.data).length;
            resolve('第一条帧 ' + size + 'B（v5：应当是明文 hello）');
            s.close();
          };
          s.onerror = () => { clearTimeout(t); resolve('onerror（无 detail，典型于混合内容/CSP 拦截）'); };
          s.onclose = (e) => { clearTimeout(t); resolve('close code=' + e.code + ' reason=' + e.reason); };
        } catch (err) { clearTimeout(t); resolve('throw:' + err.message); }
      });
    }
  } catch (e) { out.fetchError = String(e); }
  return JSON.stringify(out);
})()
`;

const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('没有 page 目标：', JSON.stringify(targets));
  process.exit(1);
}
console.log(`目标：${page.title} ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`.slice(0, 300));
  }
};

ws.onerror = (e) => {
  console.error('CDP 连接失败', e?.message ?? '');
  process.exit(1);
};

ws.onopen = async () => {
  await send('Runtime.enable');
  await send('Log.enable');

  const r = await send('Runtime.evaluate', { expression: DIAG, awaitPromise: true, returnByValue: true });
  const value = r.result?.result?.value;
  if (value) {
    try {
      console.log('--- 页面自述 ---');
      console.log(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      console.log('原始返回：', value);
    }
  } else {
    console.log('evaluate 未返回：', JSON.stringify(r.result ?? r).slice(0, 400));
  }

  // 给 Log 域一点时间把已有的违规条目补齐
  await new Promise((r2) => setTimeout(r2, 1500));
  console.log('--- 浏览器日志（Mixed Content / CSP 违规都在这里）---');
  if (logs.length === 0) {
    console.log('（无）');
  } else {
    for (const l of logs) {
      console.log('  ' + l);
    }
  }
  ws.close();
  process.exit(0);
};

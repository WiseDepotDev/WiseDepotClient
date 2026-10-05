#!/usr/bin/env node
/**
 * _debug-layout.mjs —— 通过 CDP 取**布局事实**：视口尺寸、落到哪套外壳、DOM 结构。
 *
 * 为什么需要它："界面难看/横屏"这类描述无法直接定位 —— 可能是档位选错了（手机壳被拉到宽屏上），
 * 也可能是档位对了但组件本身没做够。这两者要改的地方完全不同，必须先分清。
 *
 * 用法：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *       node tools/bench/_debug-layout.mjs
 */

'use strict';

const PROBE = `
JSON.stringify({
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  screen: { w: screen.width, h: screen.height, orientation: (screen.orientation && screen.orientation.type) || 'n/a' },
  shell: (document.querySelector('.w-root') || {}).className || '(未渲染)',
  hasTabBar: !!document.querySelector('.w-tabbar'),
  hasSidebar: !!document.querySelector('.w-sidebar'),
  verifyRow: (() => {
    // 图形验证码整条链路已删除；这里量的是它的替代品（点一下按钮、零输入）
    const row = document.querySelector('[data-testid="human-verify"]');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return {
      row: [Math.round(r.width), Math.round(r.height)],
      state: row.getAttribute('data-state') || row.className,
    };
  })(),
  tabbarPlaceholderIcons: document.querySelectorAll('.w-tabbar__item span[aria-hidden]').length,
  shellRect: (() => { const e = document.querySelector('.w-root'); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
  rootFontSize: getComputedStyle(document.documentElement).fontSize,
  bodyFont: getComputedStyle(document.body).fontFamily,
  appBarHeight: (() => { const e = document.querySelector('.w-appbar'); return e ? Math.round(e.getBoundingClientRect().height) : null; })(),
  bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
  outline: [...document.querySelectorAll('.w-root *')].slice(0, 40)
    .map(e => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : ''))
    .join(' | ')
})
`;

const res = await fetch('http://127.0.0.1:9222/json');
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('没有 page 目标');
  process.exit(1);
}

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
  }
};

ws.onopen = async () => {
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const v = r.result?.result?.value;
  if (!v) {
    console.log('取值失败：', JSON.stringify(r.result ?? r).slice(0, 400));
  } else {
    const o = JSON.parse(v);
    for (const [k, val] of Object.entries(o)) {
      if (k === 'outline') {
        console.log(`outline    : ${val}`);
      } else {
        console.log(`${k.padEnd(10)} : ${typeof val === 'object' ? JSON.stringify(val) : val}`);
      }
    }
  }
  ws.close();
  process.exit(0);
};

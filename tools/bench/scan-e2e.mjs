#!/usr/bin/env node
/**
 * scan-e2e.mjs —— 扫码枪的**真机端到端**验证（Android 壳 + 真 WebView）。
 *
 * 验证的不是"识别算法对不对"（那是 check-scan 的活，纯逻辑、确定性），
 * 而是**接起来之后还通不通**：
 *
 *   按键流 → useScanGun 识别 → 外壳跳到标签详情 → screenParams.code 传进屏 → 屏真的去查了
 *
 * 为什么用 CDP 派发合成按键，而不是 `adb shell input text`：
 *   · `input text` 的注入间隔不受控，识别阈值（50ms）附近的结果不可复现；
 *   · 合成按键能精确控制相邻时间戳，还能**顺便验一遍反向用例**（人手速度不该触发）。
 * 两者都跑：合成按键负责确定性，真 adb 注入负责"真键盘事件也走同一条路"。
 *
 * 前置：WSA 上壳已启动并登录；WebView 调试已开（MainActivity 里开了）。
 * 用法：node tools/bench/scan-e2e.mjs
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const PORT = 9223;

function adb(args) {
    return execFileSync('adb', args, { encoding: 'utf8' });
}

const socket = adb(['shell', 'cat', '/proc/net/unix'])
    .split('\n')
    .map((l) => /@(webview_devtools_remote_\d+)/.exec(l)?.[1])
    .filter(Boolean)[0];
if (!socket) {
    console.error('✗ 找不到 WebView devtools socket（壳没在跑，或没开调试）');
    process.exit(1);
}
adb(['forward', `tcp:${PORT}`, `localabstract:${socket}`]);

const targets = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/json`)).text());
const page = targets.find((t) => t.type === 'page');
if (!page) {
    console.error('✗ 没有 page 目标：', JSON.stringify(targets.map((t) => t.type)));
    process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
});

let seq = 0;
function evaluate(expression, awaitPromise = false) {
    const id = ++seq;
    return new Promise((resolve) => {
        const onMessage = (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id !== id) return;
            ws.removeEventListener('message', onMessage);
            resolve(m.result?.result?.value ?? m.result?.result?.description ?? m.error?.message);
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise },
        }));
    });
}

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures += 1;
}

/**
 * 在页面里派发一段按键流。
 *
 * 两个用例故意用不同的时间语义：
 *   · 人手速度 —— 每个事件之间**真实睡 120ms**，让浏览器给出拉开的时间戳；
 *   · 扫码枪速度 —— 同一个同步循环里派发，时间戳几乎相同（真实枪是 1–5ms）。
 * 判据是 `event.timeStamp` 的间隔，所以这两种写法直接对应"打字"与"扫码"。
 */

/** 读取当前页面可见文案 + 输入框里的值，用来判断"跳到哪一屏、在查什么"。 */
function readState() {
    return evaluate(`(() => {
      const inputs = [...document.querySelectorAll('input')].map((i) => i.value).filter(Boolean);
      return JSON.stringify({
        text: (document.body.innerText || '').replace(/\\n+/g, ' | ').slice(0, 220),
        inputs,
      });
    })()`);
}

const CODE = 'TAG-SCAN-E2E-1';

console.log('=== 扫码枪真机端到端 ===');

try {
    // 先回到一个确定的位置：切到「概览」域，确保不是恰好在标签页上
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.w-tabbar__item')].find((el) => (el.textContent || '').includes('概览'));
      if (tab) tab.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 800));

    // ---- 1. 反向用例：人手速度不该触发 ----
    // 用真实时间派发（每个事件之间睡 120ms），让 timeStamp 拉开成"打字"的节奏。
    console.log('--- 1. 人手速度（120ms/字符）不应触发扫码 ---');
    const slow = `(async () => {
      for (const ch of ${JSON.stringify('HUMANTYPING')}) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 120));
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`;
    await evaluate(slow, true);
    await new Promise((r) => setTimeout(r, 500));
    let state = JSON.parse(await readState());
    check(
        '人手速度打字后没有跳到标签详情',
        !state.text.includes('标签详情') && !state.inputs.includes('HUMANTYPING'),
        state.text.slice(0, 90),
    );

    // ---- 2. 正向用例：扫码枪速度应当触发并跳转 ----
    console.log(`--- 2. 扫码枪速度（3ms/字符）扫 ${CODE} 应触发并跳转 ---`);
    // 真实时间上快速连续派发，让浏览器给它们相近的时间戳
    const fast = `(async () => {
      for (const ch of ${JSON.stringify(CODE)}) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`;
    await evaluate(fast, true);
    await new Promise((r) => setTimeout(r, 1200));
    state = JSON.parse(await readState());
    check(
        '扫到的编码进了标签详情屏（屏参数送达）',
        state.inputs.includes(CODE),
        `inputs=${JSON.stringify(state.inputs)} 文案=${state.text.slice(0, 90)}`,
    );
    check(
        '确实跳到了标签详情这一屏',
        state.text.includes('标签详情') || state.text.includes('标签信息'),
        state.text.slice(0, 120),
    );

    // ---- 3. 反向：连扫两次不同的码，屏要跟着换（key 复用的坑）----
    console.log('--- 3. 连扫两个不同的码，屏要跟着换 ---');
    const SECOND = 'TAG-SCAN-E2E-2';
    const fast2 = `(async () => {
      for (const ch of ${JSON.stringify(SECOND)}) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`;
    await evaluate(fast2, true);
    await new Promise((r) => setTimeout(r, 1200));
    state = JSON.parse(await readState());
    check(
        '第二次扫码换掉了屏上的编码（同一屏组件必须重新挂载）',
        state.inputs.includes(SECOND),
        `inputs=${JSON.stringify(state.inputs)}`,
    );
} finally {
    ws.close();
}

console.log('');
if (failures > 0) {
    console.error(`scan-e2e: ${failures} 项失败`);
    process.exit(1);
}
console.log('scan-e2e OK: 扫码识别 → 跳转 → 屏参数 → 换码都通');

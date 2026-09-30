#!/usr/bin/env node
/**
 * check-transport-timeout.mjs —— 桥传输的**超时兜底**回归护栏。
 *
 * ## 为什么需要它
 *
 * 用户报的现象是"打开一直转加载动画，切走再切回来才有内容"。根因在传输层：
 *
 *   1. 原先 `call()` 是 `await ensureOpen()` **之后**才起计时器 ——
 *      **建连阶段完全没有超时**；
 *   2. WebSocket 可能既不 `onopen` 也不 `onclose`（对端丢包、黑洞地址、
 *      或 WSA 的 loopback0 把包吞了），而 OS 的 TCP 连接超时是**分钟级**。
 *
 * 两者相加：第一个请求永远不 settle → 界面永远转骨架、连报错都没有；
 * 而"切走再切回来"因为连接已经建好，就正常了 —— 与用户描述完全吻合。
 *
 * 这个脚本把"永远挂着"变成可测的断言：指向一个黑洞地址，
 * 调用**必须**在预算内以可重试的错误结束，而不是无限等待。
 *
 * 之所以能在 Node 里跑：`transport.ts` 里已不再依赖 `window.*`（改用 `globalThis.*`），
 * 而 Node 24 自带全局 `WebSocket`。
 *
 * 用法：node tools/check/check-transport-timeout.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'bridge-client', 'src', 'transport.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-transport-'));
const outFile = path.join(outDir, 'transport.cjs');

let failures = 0;
let total = 0;
function check(name, passed, detail) {
    total += 1;
    if (passed) {
        console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
        return;
    }
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
    failures += 1;
}

try {
    await build({
        entryPoints: [ENTRY],
        outfile: outFile,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        logLevel: 'warning',
    });
    const { WebSocketTransport } = await import(pathToFileURL(outFile).href);

    if (typeof globalThis.WebSocket !== 'function') {
        console.error('✗ 当前 Node 没有全局 WebSocket（需要 Node 22+）');
        process.exit(1);
    }

    // ---- 1. 建连悬停：既不 onopen 也不 onclose ----
    //
    // 这是要复现的真实故障形态（对端丢包 / 黑洞地址 / 容器里的 loopback 被吞）。
    // 用真实网络测不出来：指向黑洞地址时 Node 会**立刻**返回不可达（实测 221ms），
    // 走的是"重连放弃"分支而不是"建连超时"。所以这里注入一个什么都不做的 WebSocket，
    // 精确模拟"连接挂在那里"。
    {
        const RealWebSocket = globalThis.WebSocket;
        globalThis.WebSocket = class {
            // **必须给全静态常量与 readyState**：`ensureOpen()` 里判的是
            // `this.socket?.readyState === WebSocket.OPEN` —— 少了这两个，
            // 该判断会变成 `undefined === undefined` → 直接返回，
            // 于是根本走不到建连路径，用例会"为错误的理由通过"（踩过一次）。
            static OPEN = 1;
            static CONNECTING = 0;
            static CLOSING = 2;
            static CLOSED = 3;
            readyState = 0;
            constructor() {
                /* 故意什么都不做：不 onopen、不 onclose、不 onerror */
            }
            close() {
                /* 也不回调 */
            }
            send() {
                /* 不会走到 */
            }
        };
        try {
            const budget = 3000;
            const t = new WebSocketTransport(
                { port: 9, token: 'x', host: '127.0.0.1' },
                { callTimeoutMs: budget, connectTimeoutMs: 500, maxBackoffMs: 50, maxAttempts: 3 },
            );
            const started = Date.now();
            let outcome = 'hang';
            try {
                await t.call('bridge.session');
                outcome = 'resolved';
            } catch (e) {
                outcome = e?.messageKey ?? e?.code ?? 'rejected';
            }
            const elapsed = Date.now() - started;
            t.close();
            check(
                '建连悬停时调用仍然结束（这就是"永远转骨架"的根因）',
                outcome !== 'hang' && elapsed < budget + 1500,
                `${elapsed}ms 结束，结果：${outcome}`,
            );
            // **必须精确到建连超时**：如果这里接受 `bridge.timeout`，
            // 那用例在"建连超时根本没生效、只是被调用超时兜住"时也会通过。
            check(
                '是**建连超时**先兜住的（而不是等到整次调用超时）',
                outcome === 'bridge.connectTimeout' && elapsed < 2000,
                `${elapsed}ms，结果：${outcome}`,
            );
        } finally {
            globalThis.WebSocket = RealWebSocket;
        }
    }

    // ---- 2. 连上了但服务端不回：按"调用超时"结束（预算覆盖发送之后那一段）----
    {
        const RealWebSocket = globalThis.WebSocket;
        globalThis.WebSocket = class {
            onopen = null;
            onclose = null;
            onmessage = null;
            onerror = null;
            constructor() {
                // 异步触发 onopen，模拟"连上了"，但之后永远不回任何帧
                setTimeout(() => this.onopen?.({}), 0);
            }
            close() {}
            send() {}
        };
        try {
            const budget = 700;
            const t = new WebSocketTransport(
                { port: 9, token: 'x', host: '127.0.0.1' },
                { callTimeoutMs: budget, connectTimeoutMs: 5000, maxBackoffMs: 50, maxAttempts: 1 },
            );
            const started = Date.now();
            let outcome = 'hang';
            try {
                await t.call('bridge.session');
                outcome = 'resolved';
            } catch (e) {
                outcome = e?.messageKey ?? e?.code ?? 'rejected';
            }
            const elapsed = Date.now() - started;
            t.close();
            check(
                '连上但不回复时按调用超时结束',
                outcome === 'bridge.timeout' && elapsed >= budget - 100 && elapsed < budget + 1200,
                `${elapsed}ms 结束，结果：${outcome}`,
            );
        } finally {
            globalThis.WebSocket = RealWebSocket;
        }
    }

    // ---- 3. 端口没人监听（真实网络，立刻 ECONNREFUSED）：走重连退避也要收敛 ----
    {
        const t = new WebSocketTransport(
            { port: 9, token: 'x', host: '127.0.0.1' },
            { callTimeoutMs: 5000, connectTimeoutMs: 500, maxBackoffMs: 100, maxAttempts: 3 },
        );
        const started = Date.now();
        let settled = false;
        try {
            await t.call('bridge.session');
        } catch {
            settled = true;
        }
        const elapsed = Date.now() - started;
        t.close();
        check('端口无人监听时也会收敛（不会无限重连）', settled, `${elapsed}ms`);
    }
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`check-transport-timeout: ${failures}/${total} 个用例失败`);
    process.exit(1);
}
console.log(`check-transport-timeout OK: ${total} 个用例（建连超时兜底 / 拒绝后收敛）`);

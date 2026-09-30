#!/usr/bin/env node
/**
 * query-param-probe.mjs —— 验证「参数走 query 还是 body」这件事**真的按契约执行**。
 *
 * 背景：服务端有 11 个 POST/PUT 端点用 `@RequestParam` 取值，而 `@RequestParam`
 * 只认 query string / form body，不认 JSON body。桥若按 HTTP 方法一刀切发 body，
 * 这些端点会永远 400，界面上只表现为「点了没反应」——最难查的一类故障。
 *
 * 为什么不去打真后端验证：那需要构造一个"合法到能通过参数绑定、又无害到不写库"
 * 的请求，很难同时满足。本脚本改为让桥对着一个**记录请求的假后端**发一次，
 * 直接断言 URL 与 body 的形状 —— 这才是本次改动真正负责的东西，且完全无副作用。
 *
 * 断言：
 *   1. 契约标 query 的方法 → 参数出现在 URL query 上，且**路径参数不进 query**；
 *   2. 这些方法的 body 是空 JSON 占位（OkHttp 不允许 POST/PUT 不带 body）；
 *   3. 契约标 body 的方法 → 参数在 JSON 信封 body 里，URL 上没有 query；
 *   4. 两者的响应都能被正常解析（证明"不发信封 body"不会把响应链路带坏）。
 *
 * 用法：node tools/bench/query-param-probe.mjs
 */

'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const MAIN_CLASS = 'com.huicang.wise.bridge.host.desktop.MainKt';
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');

/** 契约表里全部方法（从生成物读，不手抄）。 */
function readMethods() {
    const text = fs.readFileSync(CONTRACT_TS, 'utf8');
    const re =
        /\{ id: '([^']+)', domain: '[^']+', httpMethod: '([^']+)', path: '([^']+)', packetType: '[^']+', curated: (?:true|false), paramStyle: '([^']+)' \}/g;
    return [...text.matchAll(re)].map((m) => ({ id: m[1], httpMethod: m[2], path: m[3], paramStyle: m[4] }));
}

const results = [];
let ok = true;
function record(name, passed, detail) {
    results.push({ name, passed });
    if (!passed) ok = false;
    console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

/** 记录型假后端：把每次请求原样存下来，并回一个合法信封。 */
function startRecorder() {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            seen.push({
                method: req.method,
                url: req.url,
                query: Object.fromEntries(new URL(req.url, 'http://x').searchParams),
                body,
                contentType: req.headers['content-type'] ?? '',
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ header: { packet_type: 'RESP' }, payload: { code: 'RES-0000', data: { echoed: true } } }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
    });
}

async function startBridge(backendUrl) {
    const child = spawn(
        'java',
        ['-cp', path.join(LIB_DIR, '*'), MAIN_CLASS, '--backend', backendUrl, '--ver', '1.0.0-queryprobe'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const handshake = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`握手超时\n${stderr}`)), 10000);
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
    });
    return { child, ws };
}

function callBridge(ws, id, method, params, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
        const onMessage = (ev) => {
            const frame = JSON.parse(String(ev.data));
            if (frame.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            resolve({ frame });
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ v: 3, type: 'req', id, method, ...(params ? { params } : {}) }));
    });
}

/** 用契约里的路径模板造一组"看得见来源"的参数：路径参数 + 一个剩余参数。 */
function probeParams(m) {
    const pathNames = [...m.path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    const p = {};
    for (const n of pathNames) {
        p[n] = /id$/i.test(n) ? 4242 : 'PROBE';
    }
    // 其余参数名从 overlay 的原因文本里拿不到，这里用"标记值"即可：
    // 我们断言的是"这个值出现在 URL 上还是 body 里"，来源不重要。
    p.__probe = 'MARKER';
    return p;
}

async function main() {
    if (!fs.existsSync(LIB_DIR)) {
        throw new Error(`找不到宿主产物：${LIB_DIR}\n请先跑 gradlew :bridge:host-desktop:installDist`);
    }
    const methods = readMethods();
    const queryMethods = methods.filter((m) => m.paramStyle === 'query' && ['POST', 'PUT', 'PATCH'].includes(m.httpMethod));
    // 对照组：同样有路径参数的 body 风格方法（证明 query 行为不是"所有请求都这样"）
    const bodyMethods = methods
        .filter((m) => m.paramStyle === 'body' && m.path.includes('{'))
        .slice(0, 3);

    console.log(`=== 参数去向探测（契约 query 风格 ${queryMethods.length} 条 / 对照 body 风格 ${bodyMethods.length} 条）===`);
    const rec = await startRecorder();
    const { child, ws } = await startBridge(`http://127.0.0.1:${rec.port}`);

    try {
        let n = 0;
        for (const m of queryMethods) {
            const params = probeParams(m);
            const before = rec.seen.length;
            const r = await callBridge(ws, `q${n++}`, m.id, params);
            const req = rec.seen[before];
            const pathNames = [...m.path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);

            if (!req) {
                record(`${m.id} 发出了请求`, false, JSON.stringify(r.frame ?? r));
                continue;
            }
            const markerInQuery = Object.values(req.query).includes('MARKER');
            const pathParamsLeaked = pathNames.some((p) => p in req.query);
            const bodyIsEmptyJson = req.body === '{}';
            const responded = r.frame?.type === 'res';

            record(
                `${m.id}（${m.httpMethod}）参数走 query 且路径参数未泄漏`,
                markerInQuery && !pathParamsLeaked && responded,
                `query=${JSON.stringify(req.query)} body=${JSON.stringify(req.body)} 帧=${r.frame?.type ?? 'timeout'}`,
            );
            record(`${m.id} body 是空 JSON 占位（未发信封）`, bodyIsEmptyJson, `body=${JSON.stringify(req.body)}`);
        }

        console.log('--- 对照组：body 风格方法 ---');
        for (const m of bodyMethods) {
            const params = probeParams(m);
            const before = rec.seen.length;
            await callBridge(ws, `b${n++}`, m.id, params);
            const req = rec.seen[before];
            if (!req) {
                record(`${m.id} 发出了请求`, false);
                continue;
            }
            const markerInBody = req.body.includes('MARKER');
            const noQuery = Object.keys(req.query).length === 0;
            record(
                `${m.id}（${m.httpMethod}）参数走 JSON body 且 URL 无 query`,
                markerInBody && noQuery,
                `query=${JSON.stringify(req.query)} body=${req.body.slice(0, 90)}…`,
            );
        }
    } finally {
        ws.close();
        child.kill();
        rec.server.close();
    }

    const failed = results.filter((r) => !r.passed).length;
    console.log('');
    if (failed > 0) {
        console.error(`query-param-probe: ${failed}/${results.length} 项失败`);
        process.exit(1);
    }
    console.log(`query-param-probe OK: ${results.length} 项全部通过`);
}

await main();

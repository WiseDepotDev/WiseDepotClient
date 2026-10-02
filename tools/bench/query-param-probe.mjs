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
 * 用法：
 *   node tools/bench/query-param-probe.mjs            # 形状探测（记录型假后端，无需真后端）
 *   node tools/bench/query-param-probe.mjs --real     # 再补一记真后端判别（需 WiseDeoptServer 在跑）
 */

'use strict';

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { sendReq, decodeFrame } from '../lib/bridge-wire.mjs';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(CLIENT_ROOT, '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const MAIN_CLASS = 'com.huicang.wise.bridge.host.desktop.MainKt';
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const ENV_FILE = path.join(WORKSPACE_ROOT, 'deploy', '.env.local');

/** 契约表里全部方法（从生成物读，不手抄）。 */
function readMethods() {
    const text = fs.readFileSync(CONTRACT_TS, 'utf8');
    const re =
        /\{ id: '([^']+)', domain: '[^']+', httpMethod: '([^']+)', path: '([^']+)', packetType: '[^']+', curated: (?:true|false), paramStyle: '([^']+)', keepPathParamsInBody: (?:true|false) \}/g;
    const methods = [...text.matchAll(re)].map((m) => ({ id: m[1], httpMethod: m[2], path: m[3], paramStyle: m[4] }));
    // **解析不到就直接失败，不要退化成"0 个用例全部通过"。**
    // 踩过：给契约条目加了一个字段，这里的正则对不上，于是扫描结果为空，
    // 脚本照样打印 "OK: 0 项全部通过" —— 一个什么都没验证的绿灯，比红灯危险得多。
    if (methods.length === 0) {
        throw new Error(
            `没有从契约生成物里解析出任何方法（正则与条目格式不匹配？）：${CONTRACT_TS}\n` +
            '条目形如 { id: …, domain: …, httpMethod: …, path: …, packetType: …, curated: …, paramStyle: …, keepPathParamsInBody: … }',
        );
    }
    return methods;
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
        s.binaryType = 'arraybuffer';
        s.onopen = () => resolve(s);
        s.onerror = () => reject(new Error('ws 连接失败'));
    });
    return { child, ws };
}

function callBridge(ws, id, method, params, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
        const onMessage = (ev) => {
            const frame = decodeFrame(new Uint8Array(ev.data));
            if (frame.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            resolve({ frame });
        };
        ws.addEventListener('message', onMessage);
        sendReq(ws, id, method, params);
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

// ---------------------------------------------------------------- 真后端判别

function readEnv() {
    const map = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) map[m[1]] = m[2];
    }
    return map;
}

function redisGet(key, password) {
    return execFileSync(
        'docker',
        ['exec', 'wd-local-redis', 'redis-cli', '-a', password, '--no-auth-warning', 'GET', key],
        { encoding: 'utf8' },
    ).trim();
}

/**
 * 真后端判别：挑一个"参数没绑上会 400、绑上了会是别的码"的端点。
 *
 * `POST /api/inventories/{inventoryId}/lock` 是理想候选 —— 它的 `@RequestParam("quantity")`
 * 是必填的，而**主键不存在**时服务端明确返回 404（见 InventoryController 的接口说明）。
 * 于是两种结果一眼可分，且**完全不写库**：
 *   · 修好之前：Spring 报 "Required request parameter 'quantity' is not present" → HTTP-400
 *   · 修好之后：参数绑上了，业务走到 404
 *
 * 登录要过验证码，答案从后端自己的 Redis 读（测试基础设施，见 real-smoke.mjs 的说明）。
 */
async function realDifferential() {
    const backend = 'http://127.0.0.1:18080';
    const env = readEnv();
    console.log(`=== 真后端判别（${backend}）===`);

    const { child, ws } = await startBridge(backend);
    try {
        const cap = await callBridge(ws, 'c1', 'captcha.generate', { type: 'math' });
        const captchaId = cap.frame?.data?.captchaId;
        const code = redisGet(`captcha:${captchaId}`, env.WD_REDIS_PASSWORD);
        const login = await callBridge(ws, 'c2', 'auth.login', {
            username: 'operator',
            password: env.WD_OPERATOR_PASSWORD,
            captchaId,
            captchaCode: code,
        });
        record('真登录成功', login.frame?.type === 'res', `username=${login.frame?.data?.username}`);

        // inventoryId 用一个不可能存在的主键：服务端会返回"库存不存在"，
        // 既证明了 @RequestParam 绑定成功，又不会改动任何数据。
        const r = await callBridge(ws, 'c3', 'inventory.lock', { inventoryId: -1, quantity: 1 });
        const raw = JSON.stringify(r.frame ?? r);
        // err 帧的形状是 { type:'err', error:{ code, retryable } } —— 注意 code 在 error 里，不在顶层。
        const errCode = String(r.frame?.error?.code ?? '');
        record(
            'inventory.lock 的参数被服务端接受（不再是 HTTP-400）',
            errCode !== 'HTTP-400' && r.frame?.type !== 'timeout',
            `HTTP-400 表示 @RequestParam("quantity") 没收到值；实际 ${raw}`,
        );
        record(
            '响应来自业务层（RES-0004 资源不存在），证明请求已经越过 Spring 的参数绑定',
            errCode === 'RES-0004',
            `期望 RES-0004（ErrorCode.NOT_FOUND，HTTP 404），实际 ${errCode}`,
        );
    } finally {
        ws.close();
        child.kill();
    }

    const failed = results.filter((r) => !r.passed).length;
    console.log('');
    if (failed > 0) {
        console.error(`query-param-probe --real: ${failed}/${results.length} 项失败`);
        process.exit(1);
    }
    console.log(`query-param-probe --real OK: ${results.length} 项全部通过`);
}

async function main() {
    if (!fs.existsSync(LIB_DIR)) {
        throw new Error(`找不到宿主产物：${LIB_DIR}\n请先跑 gradlew :bridge:host-desktop:installDist`);
    }
    if (process.argv.includes('--real')) {
        await realDifferential();
        return;
    }
    const methods = readMethods();
    const queryMethods = methods.filter((m) => m.paramStyle === 'query' && ['POST', 'PUT', 'PATCH'].includes(m.httpMethod));
    // 对照组：同样有路径参数的 body 风格方法（证明 query 行为不是"所有请求都这样"）
    const bodyMethods = methods
        .filter((m) => m.paramStyle === 'body' && m.path.includes('{'))
        .slice(0, 3);

    console.log(`=== 参数去向探测（契约 query 风格 ${queryMethods.length} 条 / 对照 body 风格 ${bodyMethods.length} 条）===`);
    // 契约里 query 风格的方法**必须**有一批（11 个 @RequestParam 端点）。
    // 数量掉到 0 说明选法或契约变了，不能让脚本继续跑成一个空绿灯。
    if (queryMethods.length === 0 || bodyMethods.length === 0) {
        console.error(
            `✗ 探测对象为空（query=${queryMethods.length} body=${bodyMethods.length}）：` +
            '要么契约里没有 query 风格方法，要么解析逻辑失效了。不继续。',
        );
        process.exit(1);
    }
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

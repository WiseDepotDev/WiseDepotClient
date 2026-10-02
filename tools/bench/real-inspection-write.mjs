#!/usr/bin/env node
/**
 * real-inspection-write.mjs —— 巡检**写链路**的真后端验证。
 *
 * 为什么单独写一个：这三个方法里有三个属于"服务端用 @RequestParam 取值、
 * 桥必须把参数拼进 query"的那批（`inspection.taskStatus` / `taskProgress` / `resultCreate`）。
 * 之前的 `query-param-probe --real` 只证明了**一个**方法（inventory.lock）能越过参数绑定；
 * 这里把整条巡检写流程真跑一遍，证明那批方法在**真实业务动作**里都通。
 *
 * 流程（每步都断言，失败即停不再往下走）：
 *   取设备/仓库 → 建任务 → 置为执行中 → 上报进度 → 手动补录 → 录入结果 → 回读
 *
 * 它会**真的往开发后端写数据**（一条巡检任务 + 一条补录明细 + 一条结果）。
 * 这是刻意的：只读的验证证明不了"写接口的参数真的被服务端收到了"。
 *
 * 用法：node tools/bench/real-inspection-write.mjs [--user operator]
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
const USER_KIND = (ARGV.includes('--user') ? ARGV[ARGV.indexOf('--user') + 1] : 'admin').toUpperCase();

const results = [];
let ok = true;

function record(name, passed, detail) {
    results.push({ name, passed, detail });
    if (!passed) ok = false;
    console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
    return passed;
}

function readEnv() {
    if (!fs.existsSync(ENV_FILE)) throw new Error(`找不到 ${ENV_FILE}`);
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

async function startBridge() {
    const child = spawn(
        'java',
        ['-cp', path.join(LIB_DIR, '*'), MAIN_CLASS, '--backend', BACKEND, '--ver', '1.0.0-inspwrite'],
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

function call(ws, id, method, params, timeoutMs = 20000) {
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

/** err 帧的形状是 { type:'err', error:{ code, retryable } } —— code 在 error 里，不在顶层。 */
const errCodeOf = (frame) => String(frame?.error?.code ?? '');
const isOk = (frame) => frame?.type === 'res';
const rowsOf = (frame) => {
    const d = frame?.data;
    if (Array.isArray(d)) return d;
    for (const k of ['rows', 'content', 'items', 'list', 'records']) {
        if (Array.isArray(d?.[k])) return d[k];
    }
    return [];
};

async function main() {
    if (!fs.existsSync(LIB_DIR)) {
        throw new Error(`找不到宿主产物：${LIB_DIR}\n请先跑 gradlew :bridge:host-desktop:installDist`);
    }
    const env = readEnv();
    const password = env[`WD_${USER_KIND}_PASSWORD`];
    if (!env.WD_REDIS_PASSWORD || !password) {
        throw new Error(`deploy/.env.local 缺少 WD_REDIS_PASSWORD 或 WD_${USER_KIND}_PASSWORD`);
    }

    console.log(`=== 巡检写链路真后端验证（${BACKEND}，账号 ${USER_KIND.toLowerCase()}）===`);
    const { child, ws } = await startBridge();

    try {
        const cap = await call(ws, 'i0', 'captcha.generate', { type: 'math' });
        const code = redisGet(`captcha:${cap.frame?.data?.captchaId}`, env.WD_REDIS_PASSWORD);
        const login = await call(ws, 'i1', 'auth.login', {
            username: USER_KIND.toLowerCase(),
            password,
            captchaId: cap.frame?.data?.captchaId,
            captchaCode: code,
        });
        if (!record('登录', isOk(login.frame), isOk(login.frame) ? 'ok' : errCodeOf(login.frame))) {
            return;
        }

        console.log('--- 1. 取真实的设备与仓库编号 ---');
        // 为什么必须先取：服务端 createTask 里 `deviceRepository.findById(request.getDeviceId())`
        // 是**必填**（传 null 直接抛 SYS-0001），warehouseId 也显式校验"不能为空 + 必须存在"。
        // 这两项在界面上是选择项，所以先确认开发后端里确实有可选的数据。
        const dev = await call(ws, 'i2a', 'device.list', {});
        const wh = await call(ws, 'i2b', 'warehouse.list', {});
        const devices = rowsOf(dev.frame);
        const warehouses = rowsOf(wh.frame);
        const deviceId = devices[0]?.deviceId ?? devices[0]?.id;
        const warehouseId = warehouses[0]?.warehouseId ?? warehouses[0]?.id;
        record(
            '后端有可选的设备与仓库（建任务的前置条件）',
            deviceId !== undefined && warehouseId !== undefined,
            `设备 ${devices.length} 台（首个 id=${deviceId}）／仓库 ${warehouses.length} 个（首个 id=${warehouseId}）`,
        );
        if (deviceId === undefined || warehouseId === undefined) {
            return;
        }

        console.log('--- 2. 建任务（body 风格）---');
        const create = await call(ws, 'i2', 'inspection.taskCreate', {
            deviceId,
            warehouseId,
            targetDistance: 10.0,
        });
        const taskId = create.frame?.data?.taskId ?? create.frame?.data?.id;
        record(
            'inspection.taskCreate 返回任务编号',
            isOk(create.frame) && taskId !== undefined,
            isOk(create.frame) ? `taskId=${taskId}` : `${errCodeOf(create.frame)} ${JSON.stringify(create.frame?.data ?? {})}`,
        );
        if (taskId === undefined) {
            return;
        }

        console.log('--- 3. 故意被业务拒绝一次，验证服务端原因能到前端 ---');
        // 此时任务刚建好（待执行），补录必然被拒。我们断言的不是"被拒"，
        // 而是 err 帧里**带着服务端那句原因** —— 否则界面上只会显示「操作未完成（VAL-0001）」，
        // 用户看不懂发生了什么。这条通道就是为它加的（BackendErrorCodes.detailFor）。
        const rejected = await call(ws, 'i2c', 'inspection.manualRecord', {
            taskId,
            items: [{ rfid: `PROBE-${taskId}-early` }],
        });
        const detailText = String(rejected.frame?.error?.details ?? '');
        record(
            '被业务拒绝时 err 帧带上了服务端原因（details）',
            rejected.frame?.type === 'err' && detailText.includes('只能对已完成的巡检任务进行补录'),
            `code=${errCodeOf(rejected.frame)} details=${detailText || '(空)'}`,
        );

        console.log('--- 4. 置为执行中（PUT，服务端 @RequestParam("status") —— 必须走 query）---');
        const st = await call(ws, 'i3', 'inspection.taskStatus', { taskId, status: 'RUNNING' });
        record(
            'inspection.taskStatus 被服务端接受（不是 HTTP-400）',
            isOk(st.frame),
            isOk(st.frame) ? 'ok' : errCodeOf(st.frame),
        );

        console.log('--- 4. 上报进度（PUT，@RequestParam("progress")）---');
        const pg = await call(ws, 'i4', 'inspection.taskProgress', { taskId, progress: 50, scannedCount: 3 });
        record('inspection.taskProgress 被服务端接受', isOk(pg.frame), isOk(pg.frame) ? 'ok' : errCodeOf(pg.frame));

        console.log('--- 5. 录入结果（POST，6 个 @RequestParam —— 必须走 query）---');
        const rc = await call(ws, 'i6', 'inspection.resultCreate', {
            taskId,
            totalItems: 10,
            normalItems: 8,
            abnormalItems: 2,
            missingItems: 1,
            extraItems: 1,
        });
        record(
            'inspection.resultCreate 被服务端接受（不是 HTTP-400）',
            isOk(rc.frame),
            isOk(rc.frame) ? 'ok' : errCodeOf(rc.frame),
        );

        console.log('--- 6. 回读（补录之前）---');
        const after = await call(ws, 'i8', 'inspection.taskDetail', { taskId });
        const t1 = after.frame?.data ?? {};
        record(
            '录入结果后回读到刚写入的计数',
            isOk(after.frame) && Number(t1.totalItems) === 10 && Number(t1.normalItems) === 8,
            `status=${t1.status} total=${t1.totalItems} normal=${t1.normalItems} abnormal=${t1.abnormalItems}`,
        );

        console.log('--- 7. 手动补录（body 风格；**必须在录入结果之后**）---');
        // 业务规则（实测两次才定位准）：
        //   · 服务端只允许对**已完成**的任务补录。任务在上一步 resultCreate 之后变成 status=2，
        //     所以顺序不能反 —— 反了拿到的是 VAL-0001「只能对已完成的巡检任务进行补录」，
        //     而不是参数错误，很容易误判成"参数没送到"。
        //   · 补录会**触发服务端重算计数**（下面第二次回读会看到 normal 从 8 变 0）。
        //     这是真实行为，不是缺陷；界面在补录成功后必须重新拉取任务详情。
        const mr = await call(ws, 'i5', 'inspection.manualRecord', {
            taskId,
            items: [{ rfid: `PROBE-${taskId}-1`, tid: 'PROBE-TID', remark: '真后端写链路验证' }],
        });
        record('inspection.manualRecord 被服务端接受', isOk(mr.frame), isOk(mr.frame) ? 'ok' : errCodeOf(mr.frame));

        console.log('--- 8. 再回读，确认补录触发了重算 ---');
        const again = await call(ws, 'i9', 'inspection.taskDetail', { taskId });
        const t2 = again.frame?.data ?? {};
        record(
            '补录后任务仍是已完成，且计数被服务端重算',
            isOk(again.frame) && Number(t2.status) === 2,
            `status=${t2.status} total=${t2.totalItems} normal=${t2.normalItems} abnormal=${t2.abnormalItems}（补录前 normal=${t1.normalItems}）`,
        );
    } finally {
        ws.close();
        child.kill();
    }

    const failed = results.filter((r) => !r.passed).length;
    console.log('');
    if (failed > 0) {
        console.error(`real-inspection-write: ${failed}/${results.length} 项失败`);
        process.exit(1);
    }
    console.log(`real-inspection-write OK: ${results.length} 项全部通过`);
}

await main();

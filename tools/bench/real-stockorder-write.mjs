#!/usr/bin/env node
/**
 * real-stockorder-write.mjs —— 出入库单**写链路**的真后端验证。
 *
 * 为什么值得单独写：`stockOrder.create` 有两个字段是**客户端必须自己给**的
 * （`orderNo` 服务端不生成、`createBy` 要当前用户 id），而这两个都是
 * "不给就 400/参数错误"的那类 —— 与 `inspection.manualRecord` 的 taskId 同一类坑。
 * 只读代码看不出"到底能不能建出来"，必须真建一单。
 *
 * 顺带把**状态流转规则**实测出来（哪个状态允许 submit/audit/withdraw），
 * 而不是只看服务端源码里的分支 —— 界面的按钮禁用逻辑要按实测口径写。
 *
 * 它会真的往开发后端写数据（一到两张出入库单）。
 *
 * 用法：node tools/bench/real-stockorder-write.mjs
 */

'use strict';

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(CLIENT_ROOT, '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const MAIN_CLASS = 'com.huicang.wise.bridge.host.desktop.MainKt';
const ENV_FILE = path.join(WORKSPACE_ROOT, 'deploy', '.env.local');

const ARGV = process.argv.slice(2);
const BACKEND = ARGV.includes('--backend') ? ARGV[ARGV.indexOf('--backend') + 1] : 'http://127.0.0.1:18080';

const results = [];
function record(name, passed, detail) {
    results.push({ name, passed, detail });
    console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
    return passed;
}

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

async function startBridge() {
    const child = spawn(
        'java',
        ['-cp', path.join(LIB_DIR, '*'), MAIN_CLASS, '--backend', BACKEND, '--ver', '1.0.0-stockorder'],
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

function call(ws, id, method, params, timeoutMs = 20000) {
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

const isOk = (f) => f?.type === 'res';
const errOf = (f) => `${f?.error?.code ?? ''}${f?.error?.details ? `（${f.error.details}）` : ''}`;
const rowsOf = (f) => {
    const d = f?.data;
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
    if (!env.WD_REDIS_PASSWORD || !env.WD_ADMIN_PASSWORD) {
        throw new Error('deploy/.env.local 缺少 WD_REDIS_PASSWORD 或 WD_ADMIN_PASSWORD');
    }

    console.log(`=== 出入库单写链路验证（${BACKEND}）===`);
    const { child, ws } = await startBridge();

    try {
        const cap = await call(ws, 'o0', 'captcha.generate', { type: 'math' });
        const code = redisGet(`captcha:${cap.frame?.data?.captchaId}`, env.WD_REDIS_PASSWORD);
        const login = await call(ws, 'o1', 'auth.login', {
            username: 'admin',
            password: env.WD_ADMIN_PASSWORD,
            captchaId: cap.frame?.data?.captchaId,
            captchaCode: code,
        });
        if (!record('登录', isOk(login.frame), isOk(login.frame) ? 'ok' : errOf(login.frame))) {
            return;
        }

        console.log('--- 1. 建单的前置条件：当前用户 + 仓库 ---');
        const me = await call(ws, 'o2a', 'user.current', {});
        const userId = me.frame?.data?.userId ?? me.frame?.data?.id;
        const wh = await call(ws, 'o2b', 'warehouse.list', {});
        const warehouses = rowsOf(wh.frame);
        const warehouseId = warehouses[0]?.warehouseId ?? warehouses[0]?.id;
        record(
            '拿得到 createBy（当前用户）与 warehouseId',
            userId !== undefined && warehouseId !== undefined,
            `userId=${userId} 仓库 ${warehouses.length} 个（首个 id=${warehouseId}）`,
        );
        if (userId === undefined || warehouseId === undefined) {
            return;
        }

        console.log('--- 2. 缺少单号应当被拒（证明 orderNo 真的必须由客户端给）---');
        const noNo = await call(ws, 'o3', 'stockOrder.create', { warehouseId, orderType: 'IN', createBy: userId });
        record(
            '不传 orderNo 会被拒绝（这条决定了界面必须给默认单号）',
            !isOk(noNo.frame),
            isOk(noNo.frame) ? '**居然成功了** —— 那服务端并没有强制单号' : errOf(noNo.frame),
        );

        console.log('--- 3. 正常建单 ---');
        const orderNo = `E2E-${Date.now()}`;
        const created = await call(ws, 'o4', 'stockOrder.create', {
            orderNo,
            warehouseId,
            orderType: 'OUT',
            createBy: userId,
            remark: '真后端写链路验证（可删）',
        });
        const orderId = created.frame?.data?.orderId ?? created.frame?.data?.id;
        record(
            'stockOrder.create 返回单据编号',
            isOk(created.frame) && orderId !== undefined,
            isOk(created.frame) ? `orderId=${orderId} orderNo=${created.frame?.data?.orderNo}` : errOf(created.frame),
        );
        if (orderId === undefined) {
            return;
        }

        console.log('--- 3b. 列表行的字段名（列表屏取错字段就会显示空白）---');
        const list = await call(ws, 'o4b', 'stockOrder.list', { page: 1, pageSize: 5 });
        const firstRow = rowsOf(list.frame)[0];
        console.log(`      列表首行：${JSON.stringify(firstRow)}`);
        record(
            '列表行里状态字段是 orderStatus（不是 status）',
            firstRow !== undefined && 'orderStatus' in firstRow,
            firstRow ? `有 orderStatus=${firstRow.orderStatus}；有 status=${'status' in firstRow}` : '列表为空，无法判断',
        );

        console.log('--- 4. 回读详情 ---');
        const detail = await call(ws, 'o5', 'stockOrder.detail', { orderId });
        const d = detail.frame?.data ?? {};
        record(
            '单据详情回读到刚建的单（单号对得上）',
            isOk(detail.frame) && d.orderNo === orderNo,
            `orderNo=${d.orderNo}`,
        );
        // 这段是**刻意把整个响应体打出来**的：DTO 里同时存在
        // `type`(Short)/`orderType`(String) 与 `status`(Short)/`orderStatus`(String) 两套字段，
        // 而服务端只会填其中一套。界面取错了那套就会显示空白 —— 靠读转换代码不如直接看回来什么。
        console.log(`      完整响应：${JSON.stringify(d)}`);
        const statusValue = d.orderStatus ?? d.status;
        record(
            '状态字段确实有值（界面按 orderStatus 优先取）',
            statusValue !== undefined,
            `orderStatus=${d.orderStatus} status=${d.status}`,
        );
        console.log(`      类型：orderType=${d.orderType} type=${d.type}`);

        console.log('--- 5. 实测状态流转：submit（提交）---');
        const submitted = await call(ws, 'o6', 'stockOrder.submit', { orderId });
        record(
            'submit 的结果（界面按钮的禁用逻辑要按这个实测口径写）',
            true,
            isOk(submitted.frame) ? '成功' : `被拒：${errOf(submitted.frame)}`,
        );
        const afterSubmit = await call(ws, 'o7', 'stockOrder.detail', { orderId });
        const s2 = afterSubmit.frame?.data ?? {};
        console.log(`      submit 之后：status=${s2.status}`);

        console.log('--- 6. 实测状态流转：audit（审核）---');
        const audited = await call(ws, 'o8', 'stockOrder.audit', { orderId, approved: true });
        record('audit 的结果', true, isOk(audited.frame) ? '成功' : `被拒：${errOf(audited.frame)}`);
        const afterAudit = await call(ws, 'o9', 'stockOrder.detail', { orderId });
        const s3 = afterAudit.frame?.data ?? {};
        console.log(`      audit 之后：status=${s3.status}`);
    } finally {
        ws.close();
        child.kill();
    }

    // 这一条脚本不断言"某动作成功"，因为它的目的是**把口径测出来**。
    // 失败只可能来自前置条件（登录/建单）没成立。
    const failed = results.filter((r) => !r.passed).length;
    console.log('');
    if (failed > 0) {
        console.error(`real-stockorder-write: ${failed}/${results.length} 项失败`);
        process.exit(1);
    }
    console.log(`real-stockorder-write OK: ${results.length} 项通过（含状态流转实测）`);
}

await main();

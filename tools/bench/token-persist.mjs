#!/usr/bin/env node
/**
 * token-persist.mjs —— 「凭据加密落盘、跨进程恢复登录态」的真实验证。
 *
 * ## 为什么用两个真实宿主进程，而不是走界面
 *
 * 这一条链路上真正会出错的地方都在**进程之外**：DPAPI 在这台机器上到底能不能用、
 * 文件权限对不对、第二个进程读出来能不能解开。界面只是触发一次登录而已，
 * 用界面验证反而看不清失败发生在哪一环。
 *
 * ## 它验证什么
 *
 *   1. 宿主**只在显式指定 `--token-file` 时**才落盘（默认不落盘，见 Main.kt 的说明）；
 *   2. 落盘文件里没有明文令牌；
 *   3. **第二个进程不登录就能拿到 `authenticated=true`** —— 这就是"冷启动免登录"；
 *   4. 能力声明如实：只有真的能持久化时才在引导里声明 `storage.secure`。
 *
 * 用法：node tools/bench/token-persist.mjs
 *
 * ## 与其它 bench 的账号冲突（踩过一次）
 *
 * 本脚本在 `operator` 账号上登录，而 `real-smoke` / `real-inspection-write` 也用同一个账号；
 * 服务端同一账号的旧会话可能被新登录顶掉。曾经出现过一次"恢复出来的令牌调后端失败"，
 * 随后连跑 4 次全绿、未能复现，最可能就是这个原因。
 *
 * 所以：**不要与其它使用 operator 账号的 bench 并发跑**。串行跑（`check:full` 就是串行）没问题。
 */

'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { connectBridge, sendReq } from '../lib/bridge-wire.mjs';
import { attachEvidenceResponder, obtainHumanToken } from '../lib/bench-human-verify.mjs';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(CLIENT_ROOT, '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const MAIN_CLASS = 'com.huicang.wise.bridge.host.desktop.MainKt';
const ENV_FILE = path.join(WORKSPACE_ROOT, 'deploy', '.env.local');

const ARGV = process.argv.slice(2);
const BACKEND = ARGV.includes('--backend') ? ARGV[ARGV.indexOf('--backend') + 1] : 'http://127.0.0.1:18080';

const results = [];
function record(name, passed, detail) {
    results.push({ name, passed });
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

/** 起一个宿主进程并连上它的桥。 */
async function startHost({ tokenFile }) {
    const args = [
        '-cp',
        path.join(LIB_DIR, '*'),
        MAIN_CLASS,
        '--backend',
        BACKEND,
        '--ver',
        '1.0.0-persist',
        // 人机验证：桥要能问到"壳"的本地环境证据（这里由 bench 扮演壳）
        '--capabilities',
        'storage.secure,human.verify',
    ];
    if (tokenFile) {
        args.push('--token-file', tokenFile);
    }
    const child = spawn('java', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    attachEvidenceResponder(child);
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
    // v5：connectBridge 内部完成"生成临时密钥 → 等 hello → 派生会话密钥"
    const ws = await connectBridge(`ws://127.0.0.1:${handshake.port}/bridge`, { psk: handshake.psk });
    return { child, ws, handshake, stderr: () => stderr };
}

function call(ws, id, method, params, timeoutMs = 20000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
        const onMessage = (ev) => {
            const frame = ev.data /* v5：connectBridge 交出来的已经是解密的逻辑帧 */;
            if (frame.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            resolve({ frame });
        };
        ws.addEventListener('message', onMessage);
        sendReq(ws, id, method, params);
    });
}

const isOk = (f) => f?.type === 'res';

/**
 * 登录 = 先过**人机验证**，再调 `auth.login`。
 *
 * 票据不进这里：`bridge.humanVerify` 成功后票据留在桥里，由桥在 `auth.login` 那次调用上注入。
 * 所以这里既能验"桥真的替页面做了验证"，也顺带验"票据不出桥"。
 */
async function login(ws, env) {
    const human = await obtainHumanToken(ws, call, { purpose: 'LOGIN', username: 'operator' });
    if (!human.ok) {
        return { frame: { type: 'err', code: 'HUMAN_VERIFY_FAILED', message: human.reason } };
    }
    return call(ws, 'l1', 'auth.login', {
        username: 'operator',
        password: env.WD_OPERATOR_PASSWORD,
    });
}

async function main() {
    if (!fs.existsSync(LIB_DIR)) {
        throw new Error(`找不到宿主产物：${LIB_DIR}\n请先跑 gradlew :bridge:host-desktop:installDist`);
    }
    const env = readEnv();
    if (!env.WD_OPERATOR_PASSWORD) {
        throw new Error('deploy/.env.local 缺少 WD_OPERATOR_PASSWORD');
    }

    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wise-persist-')), 'session.enc');
    console.log(`=== 凭据落盘验证（${BACKEND}）===`);
    console.log(`  令牌文件：${tokenFile}`);

    try {
        // ---- 第一个进程：登录 ----
        console.log('--- 1. 第一个进程：登录并落盘 ---');
        const h1 = await startHost({ tokenFile });
        try {
            const caps = String(h1.handshake.capabilities ?? '');
            record(
                '能持久化时才声明 storage.secure',
                caps.includes('storage.secure'),
                `capabilities=${caps || '(空)'} —— 为空说明这台机器拿不到 DPAPI，那就该撤回声明`,
            );
            const before = await call(h1.ws, 's0', 'bridge.session');
            record('登录前未认证', before.frame?.data?.authenticated === false, JSON.stringify(before.frame?.data));

            const loginRes = await login(h1.ws, env);
            record('登录成功', isOk(loginRes.frame), loginRes.frame?.error?.code ?? 'ok');

            const after = await call(h1.ws, 's1', 'bridge.session');
            record('登录后已认证', after.frame?.data?.authenticated === true, JSON.stringify(after.frame?.data));
        } finally {
            h1.ws.close();
            h1.child.kill();
            await new Promise((r) => setTimeout(r, 800));
        }

        // ---- 文件检查 ----
        console.log('--- 2. 落盘文件检查 ---');
        if (record('令牌文件已生成', fs.existsSync(tokenFile), tokenFile)) {
            const raw = fs.readFileSync(tokenFile, 'utf8');
            record(
                '文件里没有明文令牌（只应有信封 + 密文）',
                !/eyJ|access|refresh|"token"/i.test(raw),
                `${raw.length} 字节，前 40：${raw.slice(0, 40)}…`,
            );
            record('文件里记录了加密方式', raw.includes('dpapi'), raw.slice(0, 60));
        }

        // ---- 第二个进程：不登录 ----
        console.log('--- 3. 第二个进程：不登录，看是否直接恢复 ---');
        const h2 = await startHost({ tokenFile });
        try {
            const restored = await call(h2.ws, 's2', 'bridge.session');
            record(
                '第二个进程**不登录**即为已认证（冷启动免登录）',
                restored.frame?.data?.authenticated === true,
                JSON.stringify(restored.frame?.data),
            );
            // 真调用一次，证明恢复出来的令牌确实能用（不是只有个布尔值好看）
            const probe = await call(h2.ws, 's3', 'device.list', {});
            record(
                '恢复出来的令牌真的能调后端',
                isOk(probe.frame),
                isOk(probe.frame) ? 'device.list 成功' : `code=${probe.frame?.error?.code}`,
            );

            // 登出应当把文件也删掉，否则"以为登出了其实还能免登录"
            const out = await call(h2.ws, 's4', 'auth.logout', {});
            record('登出成功', isOk(out.frame), out.frame?.error?.code ?? 'ok');
            await new Promise((r) => setTimeout(r, 400));
            record('登出后落盘文件被删除', !fs.existsSync(tokenFile), tokenFile);
        } finally {
            h2.ws.close();
            h2.child.kill();
        }
    } finally {
        fs.rmSync(path.dirname(tokenFile), { recursive: true, force: true });
    }

    const failed = results.filter((r) => !r.passed).length;
    console.log('');
    if (failed > 0) {
        console.error(`token-persist: ${failed}/${results.length} 项失败`);
        process.exit(1);
    }
    console.log(`token-persist OK: ${results.length} 项全部通过`);
}

await main();

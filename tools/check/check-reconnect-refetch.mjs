#!/usr/bin/env node
/**
 * check-reconnect-refetch.mjs —— 「打开一直转加载动画」的回归。
 *
 * 这一条被修过两次：
 *   1. 第一轮修的是传输层**建连没有超时**（WebSocket 既不 onopen 也不 onclose 时永远挂着）；
 *   2. 用户复报"还在出现"，第二轮才发现**恢复规则只覆盖了错误态**：
 *      连接断掉时正在飞的请求注定失败，却要等满 callTimeoutMs 才 reject ——
 *      连接 1 秒就恢复了，屏幕还得空转十几秒，用户看到的仍然是"卡加载"。
 *
 * 所以这里钉住的是**判据本身**：连接打开时，凡是"还没落地"的屏都要重取，
 * 而不只是"已经失败"的屏；同时不能变成"每次重连所有屏一起重取"。
 *
 * 用 esbuild 打一次包再 import（本仓没有 ts 运行时，esbuild 已是依赖）。
 *
 * 用法：node tools/check/check-reconnect-refetch.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'bridge-client', 'src', 'transport.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-refetch-'));
const outFile = path.join(outDir, 'transport.cjs');

let failures = 0;
let total = 0;

function check(name, condition, detail) {
    total += 1;
    if (condition) {
        console.log(`  ✓ ${name}`);
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

    const { shouldRefetchOnOpen } = await import(pathToFileURL(outFile).href);
    if (typeof shouldRefetchOnOpen !== 'function') {
        console.error('✗ transport.ts 没有导出 shouldRefetchOnOpen');
        process.exit(1);
    }

    // ---- 1. 已经失败的屏：连上就重来 ----
    check(
        '错误态 + 连接打开 → 重取',
        shouldRefetchOnOpen('open', { failed: true, pending: false }) === true,
    );

    // ---- 2. 还在飞的调用：必须重取（本轮修的正是这里） ----
    check(
        '仍在取数（未落地）+ 连接打开 → 重取',
        shouldRefetchOnOpen('open', { failed: false, pending: true }) === true,
        '为 false 说明"卡加载"会继续：连接已恢复，屏幕却要等原调用超时才动',
    );

    // ---- 3. 已有数据、也没在取数：不要重取（防"每次重连全体风暴"） ----
    check(
        '已有数据且不在取数 → 不重取',
        shouldRefetchOnOpen('open', { failed: false, pending: false }) === false,
        '为 true 说明每次重连都会让所有在用屏一起重新请求',
    );

    // ---- 4. 非 open 状态一律不触发（重连中/已放弃都不算"恢复了"） ----
    for (const s of ['idle', 'connecting', 'reconnecting', 'closed']) {
        check(
            `${s} → 不重取`,
            shouldRefetchOnOpen(s, { failed: true, pending: true }) === false,
        );
    }

    // ---- 5. 两种条件同时成立也只算一次恢复（同一帧只前进一次） ----
    check(
        '既失败又在取数 → 仍是"要重取"（不是两次）',
        shouldRefetchOnOpen('open', { failed: true, pending: true }) === true,
    );
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`check-reconnect-refetch: ${failures}/${total} 个用例失败`);
    process.exit(1);
}
console.log(`check-reconnect-refetch OK: ${total} 个用例（连接恢复后的重取判据 / 不产生全体重取风暴）`);

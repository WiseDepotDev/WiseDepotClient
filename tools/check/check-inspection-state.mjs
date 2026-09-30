#!/usr/bin/env node
/**
 * check-inspection-state.mjs —— 巡检任务状态归一化的回归护栏。
 *
 * 为什么单独测它：这段判定**靠截图证明不了** —— 列表屏在服务端渲染时没有数据，
 * 而真机上要等到某个具体任务的 `statusDesc` 恰好是枚举原文时才会看出问题
 * （实测就是这样发现的：界面上出现了大写的 `COMPLETED`）。
 *
 * 它容易出错的地方很具体：服务端同一个概念有三种形状 ——
 * 数字码（0/1/2/3）、中文描述（"已完成"）、**枚举原文**（`COMPLETED`）。
 * 无条件信任 `statusDesc` 就会把英文枚举画到界面上；
 * 反过来完全不用 `statusDesc` 又会丢掉服务端给的中文文案。
 *
 * 用 esbuild 打一次包再 import（本仓没有 ts 运行时，esbuild 已是依赖）。
 *
 * 用法：node tools/check/check-inspection-state.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'features', 'src', 'field', 'inspectionState.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-insp-state-'));
const outFile = path.join(outDir, 'inspectionState.cjs');

const CASES = [
    // [说明, 输入, 期望状态, 期望文案]
    ['数字码 0', { status: 0 }, 'pending', '待开始'],
    ['数字码 1', { status: 1 }, 'running', '进行中'],
    ['数字码 2', { status: 2 }, 'done', '已完成'],
    ['数字码 3', { status: 3 }, 'paused', '已暂停'],
    ['中文描述原样信任', { status: 2, statusDesc: '已完成' }, 'done', '已完成'],
    ['中文描述（进行中）', { status: 1, statusDesc: '执行中' }, 'running', '执行中'],
    // ↓ 这就是真机上踩到的那条：列表接口把枚举原文塞在 statusDesc 里
    ['枚举原文 COMPLETED 不直接上界面', { statusDesc: 'COMPLETED' }, 'done', '已完成'],
    ['枚举原文 RUNNING 不直接上界面', { statusDesc: 'RUNNING' }, 'running', '进行中'],
    ['枚举原文 PENDING 不直接上界面', { statusDesc: 'PENDING' }, 'pending', '待开始'],
    ['枚举原文带连字符', { statusDesc: 'in-progress' }, 'running', '进行中'],
    ['枚举原文优先于缺失的数字码', { statusDesc: 'COMPLETED' }, 'done', '已完成'],
    ['数字码与枚举冲突时以枚举为准', { status: 0, statusDesc: 'COMPLETED' }, 'done', '已完成'],
    ['什么都没有', {}, 'unknown', '状态未上报'],
    ['未知枚举回落数字码', { status: 2, statusDesc: 'SOMETHING_NEW' }, 'done', '已完成'],
];

let failures = 0;

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

    const mod = await import(pathToFileURL(outFile).href);
    const { taskStateOf, taskStateText } = mod;

    if (typeof taskStateOf !== 'function' || typeof taskStateText !== 'function') {
        console.error('✗ inspectionState.ts 没有导出 taskStateOf / taskStateText');
        process.exit(1);
    }

    for (const [name, input, wantState, wantText] of CASES) {
        const gotState = taskStateOf(input);
        const gotText = taskStateText(input);
        if (gotState !== wantState || gotText !== wantText) {
            console.error(
                `✗ ${name}：期望 ${wantState}/${wantText}，实际 ${gotState}/${gotText}（输入 ${JSON.stringify(input)}）`,
            );
            failures += 1;
            continue;
        }
        // 额外断言：界面上**永远**不该出现全大写 ASCII 的状态文案
        if (/^[A-Z][A-Z0-9_]*$/.test(gotText)) {
            console.error(`✗ ${name}：状态文案是枚举原文「${gotText}」，不该画到界面上`);
            failures += 1;
        }
    }
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`check-inspection-state: ${failures}/${CASES.length} 个用例失败`);
    process.exit(1);
}
console.log(`check-inspection-state OK: ${CASES.length} 个用例（数字码 / 中文描述 / 枚举原文三种形状）`);

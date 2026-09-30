#!/usr/bin/env node
/**
 * check-scan.mjs —— 扫码枪识别核心的回归护栏。
 *
 * 这段逻辑的两类错误都会以"现场说不清"的形式出现：
 *   · **漏判** → 扫码没反应，会被当成"枪坏了"或"APP 有问题"；
 *   · **误判** → 人正常打字时突然弹出一个扫码结果。
 * 两者都很难在真机上稳定复现，所以边界必须在这里钉死。
 *
 * 用 esbuild 打一次包再 import（本仓没有 ts 运行时，esbuild 已是依赖）。
 *
 * 用法：node tools/check/check-scan.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'scan', 'src', 'assembler.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-scan-'));
const outFile = path.join(outDir, 'assembler.cjs');

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

/** 按给定的字符间隔喂入一串字符，返回没被 ignored 的步进序列。 */
function feed(assembler, text, { startAt = 1000, gapMs = 3 } = {}) {
    const steps = [];
    let at = startAt;
    for (const ch of text) {
        steps.push({ ch, at, step: assembler.push(ch, at) });
        at += gapMs;
    }
    return { steps, nextAt: at };
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

    const { ScanAssembler } = await import(pathToFileURL(outFile).href);
    if (typeof ScanAssembler !== 'function') {
        console.error('✗ assembler.ts 没有导出 ScanAssembler');
        process.exit(1);
    }

    // ---- 1. 扫码枪：3ms 间隔 + Enter ----
    {
        const a = new ScanAssembler();
        const { nextAt } = feed(a, 'TAG-000123');
        const end = a.push('Enter', nextAt);
        check(
            '扫码枪高速连打 + Enter → 识别出完整条码',
            end.kind === 'scan' && end.code === 'TAG-000123',
            JSON.stringify(end),
        );
    }

    // ---- 2. 人打字：120ms 间隔 + Enter → 绝不能识别 ----
    {
        const a = new ScanAssembler();
        const { nextAt } = feed(a, 'TAG-000123', { gapMs: 120 });
        const end = a.push('Enter', nextAt);
        check(
            '人手打字（120ms/字符）不会被误判成扫码',
            end.kind === 'discarded',
            JSON.stringify(end),
        );
    }

    // ---- 3. 人打字后接着扫码：只能识别出扫的那一段 ----
    {
        const a = new ScanAssembler();
        const t = feed(a, 'ab', { gapMs: 200 });
        const { nextAt } = feed(a, 'RFID-99', { startAt: t.nextAt + 3000, gapMs: 2 });
        const end = a.push('Enter', nextAt);
        check(
            '先打字后扫码：只识别扫码那一段，不含之前打的字符',
            end.kind === 'scan' && end.code === 'RFID-99',
            JSON.stringify(end),
        );
    }

    // ---- 4. 太短不算扫码 ----
    {
        const a = new ScanAssembler();
        const { nextAt } = feed(a, 'ABC');
        const end = a.push('Enter', nextAt);
        check('长度不足（3 < 4）即使有终止符也不算扫码', end.kind === 'discarded', JSON.stringify(end));
    }

    // ---- 5. 空缓冲按终止符 ----
    {
        const a = new ScanAssembler();
        check('空缓冲按 Enter 不产生扫码', a.push('Enter', 5000).kind === 'discarded');
    }

    // ---- 6. 组合键/非字符键不参与组码 ----
    {
        const a = new ScanAssembler();
        const t = feed(a, 'RFID');
        a.push('Shift', t.nextAt);
        const { nextAt } = feed(a, '1234', { startAt: t.nextAt + 1 });
        a.push('ArrowLeft', nextAt);
        const end = a.push('Enter', nextAt + 1);
        check(
            'Shift / ArrowLeft 等非字符键不进入条码内容',
            end.kind === 'scan' && end.code === 'RFID1234',
            JSON.stringify(end),
        );
    }

    // ---- 7. 长间隔会把两段切开（而不是接起来）----
    {
        const a = new ScanAssembler();
        const t = feed(a, 'AB');
        // 停顿远超阈值后重新开始
        const { nextAt } = feed(a, 'CDEF', { startAt: t.nextAt + 5000 });
        const end = a.push('Enter', nextAt);
        check(
            '停顿超过阈值后重新开始一段，不会把两段拼成一个码',
            end.kind === 'scan' && end.code === 'CDEF',
            JSON.stringify(end),
        );
    }

    // ---- 8. Tab 也是终止符（部分枪会配成 Tab）----
    {
        const a = new ScanAssembler();
        const { nextAt } = feed(a, 'NFC-7777');
        const end = a.push('Tab', nextAt);
        check('Tab 可作终止符', end.kind === 'scan' && end.code === 'NFC-7777', JSON.stringify(end));
    }

    // ---- 9. 没有终止符就不会成码（避免"半截码"被当成扫码）----
    {
        const a = new ScanAssembler();
        feed(a, 'LONGCODE-WITHOUT-ENTER');
        check(
            '只有连打、没有终止符时不产生扫码',
            a.pending === 'LONGCODE-WITHOUT-ENTER',
            `pending=${a.pending}`,
        );
    }

    // ---- 10. 超长输入被丢弃，且**尾部不得被当成一个短码** ----
    {
        const a = new ScanAssembler({ maxLength: 16 });
        const { nextAt } = feed(a, 'X'.repeat(40));
        const end = a.push('Enter', nextAt);
        check(
            '超长输入整段作废（尾部不会变成"一个短码"）',
            end.kind === 'discarded',
            `${JSON.stringify(end)} —— 若这里是 scan，说明被截断的条码会被当成有效扫码提交`,
        );
    }

    // ---- 10b. 作废只限本段：停顿之后必须能正常再扫 ----
    {
        const a = new ScanAssembler({ maxLength: 16 });
        const t = feed(a, 'X'.repeat(40));
        a.push('Enter', t.nextAt);
        const { nextAt } = feed(a, 'GOOD-1234', { startAt: t.nextAt + 5000, gapMs: 3 });
        const end = a.push('Enter', nextAt);
        check(
            '一次异常输入不会把之后的扫码一起吃掉',
            end.kind === 'scan' && end.code === 'GOOD-1234',
            JSON.stringify(end),
        );
    }

    // ---- 11. 阈值可调：把 maxGapMs 放宽后，慢一点的枪也能识别 ----
    {
        const a = new ScanAssembler({ maxGapMs: 200 });
        const { nextAt } = feed(a, 'SLOW-GUN', { gapMs: 150 });
        const end = a.push('Enter', nextAt);
        check('maxGapMs 可放宽以适配低端扫码枪', end.kind === 'scan' && end.code === 'SLOW-GUN', JSON.stringify(end));
    }

    // ---- 12. reset() 之后不会把之前的内容算进来 ----
    {
        const a = new ScanAssembler();
        const t = feed(a, 'OLDPART');
        a.reset();
        const { nextAt } = feed(a, 'NEW-123', { startAt: t.nextAt + 1 });
        const end = a.push('Enter', nextAt);
        check('reset() 清空缓冲', end.kind === 'scan' && end.code === 'NEW-123', JSON.stringify(end));
    }
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`check-scan: ${failures}/${total} 个用例失败`);
    process.exit(1);
}
console.log(`check-scan OK: ${total} 个用例（扫码枪识别 / 人手打字不误判 / 边界与可调阈值）`);

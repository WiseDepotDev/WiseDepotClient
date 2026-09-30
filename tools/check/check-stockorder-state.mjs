#!/usr/bin/env node
/**
 * check-stockorder-state.mjs —— 出入库单类型/状态归一化的回归护栏。
 *
 * 为什么必须有它：这段映射在生产代码里**同时错了三处**，而且一处都看不出来 ——
 *   · 读的字段名是 `status`，服务端返回的是 `orderStatus` ⇒ 状态永远是兜底值；
 *   · 类型码映射反了（`1` 被当成"入库"，实际是 `OUTBOUND(1,"出库")`）⇒ **入库和出库显示反**；
 *   · 状态码映射也反了（`0` 被当成"草稿"，实际是 `PENDING(0,"待审批")`）。
 * 三处都不会被渲染用例发现（服务端渲染时没有数据），只能靠真后端回读或这里的用例。
 *
 * 用 esbuild 打一次包再 import（本仓没有 ts 运行时，esbuild 已是依赖）。
 *
 * 用法：node tools/check/check-stockorder-state.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'features', 'src', 'inventory', 'stockOrderState.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-stockorder-'));
const outFile = path.join(outDir, 'stockOrderState.cjs');

let failures = 0;
let total = 0;
function check(name, actual, expected) {
    total += 1;
    if (actual === expected) {
        console.log(`  ✓ ${name}`);
        return;
    }
    console.error(`  ✗ ${name} —— 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
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
    const m = await import(pathToFileURL(outFile).href);
    const { orderTypeOf, orderTypeText, orderStatusOf, orderStatusText, canSubmit, canAudit, canWithdraw, canEditItems } = m;

    // ---- 类型：真实响应就是 { orderType: 1, orderTypeStr: "OUT" } ----
    console.log('--- 类型 ---');
    check('orderType=0 → 入库（后端 INBOUND(0)）', orderTypeText({ orderType: 0 }), '入库');
    check('orderType=1 → 出库（后端 OUTBOUND(1)）', orderTypeText({ orderType: 1 }), '出库');
    check('orderTypeStr="OUT" → 出库', orderTypeOf({ orderTypeStr: 'OUT' }), 'outbound');
    check('orderTypeStr="IN" → 入库', orderTypeOf({ orderTypeStr: 'IN' }), 'inbound');
    check('两个字段冲突时以可读串为准', orderTypeOf({ orderType: 0, orderTypeStr: 'OUT' }), 'outbound');
    check('字符串数字码也认', orderTypeOf({ orderType: '1' }), 'outbound');
    check('类型缺失 → unknown（不是默认成入库）', orderTypeOf({}), 'unknown');
    check(
        '**取 `type` 字段拿不到类型**（服务端从不填它）',
        orderTypeOf({ type: 1 }),
        'unknown',
    );

    // ---- 状态：真实响应是 { orderStatus: 0, orderStatusStr: "PENDING" } ----
    console.log('--- 状态 ---');
    check('orderStatus=0 → 待审批', orderStatusText({ orderStatus: 0 }), '待审批');
    check('orderStatus=1 → 已审批', orderStatusText({ orderStatus: 1 }), '已审批');
    check('orderStatus=2 → 已完成', orderStatusText({ orderStatus: 2 }), '已完成');
    check('orderStatus=3 → 已取消', orderStatusText({ orderStatus: 3 }), '已取消');
    check('orderStatus=4 → 待审核', orderStatusText({ orderStatus: 4 }), '待审核');
    check('orderStatus=5 → 已驳回', orderStatusText({ orderStatus: 5 }), '已驳回');
    check('orderStatusStr="PENDING" → 待审批', orderStatusOf({ orderStatusStr: 'PENDING' }), 'pending');
    check('PROCESSING 与后端一致地映射成已审批', orderStatusOf({ orderStatusStr: 'PROCESSING' }), 'approved');
    check('状态缺失 → unknown', orderStatusOf({}), 'unknown');
    check('**取 `status` 字段拿不到状态**（这正是原 bug）', orderStatusOf({ status: 0 }), 'unknown');

    // ---- 流转 ----
    console.log('--- 流转规则（依据真后端实测）---');
    check('待审批 + 有明细 → 可提交', canSubmit({ orderStatus: 0 }, 2), true);
    check('待审批 + **无明细** → 不可提交（实测：单据无明细，无法提交）', canSubmit({ orderStatus: 0 }, 0), false);
    check('已完成 → 不可提交', canSubmit({ orderStatus: 2 }, 3), false);
    check('待审核 → 可审核（实测：只有待审核的单据可以审核）', canAudit({ orderStatus: 4 }), true);
    check('待审批 → 不可审核', canAudit({ orderStatus: 0 }), false);
    check('**待审批 → 不可撤回**（服务端只允许待审核撤回）', canWithdraw({ orderStatus: 0 }), false);
    check('待审核 → 可撤回', canWithdraw({ orderStatus: 4 }), true);
    check('已完成 → 不可撤回', canWithdraw({ orderStatus: 2 }), false);
    check('已驳回 + 有明细 → 可再次提交', canSubmit({ orderStatus: 5 }, 1), true);
    check('待审批 → 可增删明细', canEditItems({ orderStatus: 0 }), true);
    check('待审核 → 不可增删明细', canEditItems({ orderStatus: 4 }), false);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`check-stockorder-state: ${failures}/${total} 个用例失败`);
    process.exit(1);
}
console.log(`check-stockorder-state OK: ${total} 个用例（类型码 / 状态码 / 字段名 / 流转规则）`);

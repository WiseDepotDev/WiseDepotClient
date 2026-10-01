#!/usr/bin/env node
/**
 * check-inspection-mock.mjs —— 现场域巡检**假桥**的状态机护栏。
 *
 * ## 为什么值得单独写一条
 *
 * 有状态 mock 的价值不是"页面画得出来"，而是**流程断链能在一个不连后端的地方被抓住**。
 * 巡检这条链路上有三处规则是**从服务端源码里读出来的**，而且都是"不报错、只静默做错事"的类型，
 * 靠肉眼看界面根本发现不了：
 *
 * 1. `taskStatus` **只认 `IN_PROGRESS` / `COMPLETED`**（`InspectionApplicationService#updateTaskStatus`
 *    的 `status` 初值是 0/PENDING，没有 else 分支）—— 传 `RUNNING` 会被静默重置回"待执行"。
 *    React 版就是传的 `RUNNING`，而那条真后端 bench 只断言"不是 HTTP-400"，所以一直没暴露。
 * 2. `manualRecord` **只允许对已完成的任务补录**，且补录会**触发服务端重算**（实测 normal 8 → 0）。
 * 3. `createTask` 的 DTO 上一个校验注解都没有，真正卡住的是**服务层的仓库判空 + 仓库存在**。
 *
 * 这三条一旦在 mock 里写松，界面上就会是"看起来成功了"，而真机上是另一回事。
 *
 * 用 esbuild 打一次包再 import（本仓没有 ts 运行时，esbuild 已是依赖）。
 *
 * 用法：node tools/check/check-inspection-mock.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'bridge-client', 'src', 'mock-domains.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-insp-mock-'));
const outFile = path.join(outDir, 'mock-domains.cjs');

let passed = 0;
const failures = [];

function check(what, ok, detail = '') {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${what}${detail === '' ? '' : ` —— ${detail}`}`);
}

/** 调一次假桥；把抛出来的 BridgeError 作为返回值，方便断言"拒绝了、以及拒绝的理由"。 */
function call(mock, method, params) {
  try {
    return { ok: true, value: mock.call(method, params) };
  } catch (error) {
    return { ok: false, code: error?.code, details: String(error?.details ?? ''), message: String(error?.message ?? '') };
  }
}

try {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
    outfile: outFile,
  });

  const mod = await import(pathToFileURL(outFile).href);
  const DomainMock = mod.DomainMock;
  if (typeof DomainMock !== 'function') {
    console.error('✗ mock-domains.ts 没有导出 DomainMock');
    process.exit(1);
  }

  const rowsOf = (value) => (Array.isArray(value?.rows) ? value.rows : []);

  // ---- 1. 分页：taskPage 认 pageSize（默认 10 那个坑），不是 size ----
  {
    const mock = new DomainMock();
    const page1 = call(mock, 'inspection.taskPage', { page: 1, pageSize: 2 });
    check('taskPage 认 pageSize（第 1 页 2 条）', page1.ok && rowsOf(page1.value).length === 2, JSON.stringify(page1).slice(0, 120));
    check('taskPage 回总数（4 个任务）', page1.ok && page1.value.total === 4, `total=${page1.value?.total}`);
    const page2 = call(mock, 'inspection.taskPage', { page: 2, pageSize: 2 });
    check(
      'taskPage 第 2 页换了内容（服务端分页真的生效）',
      page2.ok && rowsOf(page2.value)[0]?.taskId !== rowsOf(page1.value)[0]?.taskId,
      `${rowsOf(page1.value)[0]?.taskId} vs ${rowsOf(page2.value)[0]?.taskId}`,
    );
  }

  // ---- 2. 状态：只认 IN_PROGRESS / COMPLETED；跑偏的值会静默重置 ----
  {
    const mock = new DomainMock();
    const before = call(mock, 'inspection.taskDetail', { taskId: 502 }).value;
    check('502 初始是待开始', before.status === 0 && before.statusDesc === 'PENDING', `status=${before.status}`);

    const wrong = call(mock, 'inspection.taskStatus', { taskId: 501, status: 'RUNNING' });
    const afterWrong = call(mock, 'inspection.taskDetail', { taskId: 501 }).value;
    check('传 RUNNING 不报错（服务端就是不报错）', wrong.ok === true);
    check(
      '传 RUNNING 会把任务静默重置成待开始 —— 假桥必须复刻这个坑',
      afterWrong.status === 0 && afterWrong.statusDesc === 'PENDING',
      `status=${afterWrong.status}/${afterWrong.statusDesc}`,
    );

    const right = call(mock, 'inspection.taskStatus', { taskId: 502, status: 'IN_PROGRESS' });
    const afterRight = call(mock, 'inspection.taskDetail', { taskId: 502 }).value;
    check('传 IN_PROGRESS 被接受', right.ok === true, JSON.stringify(right).slice(0, 120));
    check(
      'IN_PROGRESS 才是"开始执行"：状态变进行中且写开始时间',
      afterRight.status === 1 && afterRight.statusDesc === 'IN_PROGRESS' && typeof afterRight.startTime === 'string',
      `status=${afterRight.status} startTime=${afterRight.startTime}`,
    );

    const done = call(mock, 'inspection.taskStatus', { taskId: 502, status: 'COMPLETED' });
    const afterDone = call(mock, 'inspection.taskDetail', { taskId: 502 }).value;
    check(
      'COMPLETED 收口：状态已完成、进度 100、有结束时间',
      done.ok && afterDone.status === 2 && afterDone.progress === 100 && typeof afterDone.endTime === 'string',
      `status=${afterDone.status} progress=${afterDone.progress}`,
    );
  }

  // ---- 3. 进度：clamp 到 0..100，scannedCount 会写回 ----
  {
    const mock = new DomainMock();
    call(mock, 'inspection.taskProgress', { taskId: 501, progress: 150, scannedCount: 54 });
    const high = call(mock, 'inspection.taskDetail', { taskId: 501 }).value;
    check('进度 150 被夹到 100', high.progress === 100, `progress=${high.progress}`);
    call(mock, 'inspection.taskProgress', { taskId: 501, progress: -5 });
    const low = call(mock, 'inspection.taskDetail', { taskId: 501 }).value;
    check('进度 -5 被夹到 0', low.progress === 0, `progress=${low.progress}`);
    const bad = call(mock, 'inspection.taskProgress', { taskId: 501, progress: 'x' });
    check('进度不是数字 → VAL-0001', bad.ok === false && bad.code === 'VAL-0001', JSON.stringify(bad).slice(0, 120));
    const missing = call(mock, 'inspection.taskProgress', { taskId: 9999, progress: 10 });
    check('改不存在的任务 → RES-0004', missing.ok === false && missing.code === 'RES-0004', String(missing.code));
  }

  // ---- 4. 建任务：DTO 没校验，卡人的是服务层的仓库判空 + 存在 ----
  {
    const mock = new DomainMock();
    const noWarehouse = call(mock, 'inspection.taskCreate', { deviceId: 1, targetDistance: 10 });
    check('不传仓库 → VAL-0001「盘点仓库不能为空」', noWarehouse.ok === false && noWarehouse.code === 'VAL-0001', JSON.stringify(noWarehouse).slice(0, 140));

    const ghost = call(mock, 'inspection.taskCreate', { warehouseId: 999 });
    check('仓库不存在 → RES-0004「仓库不存在」', ghost.ok === false && ghost.code === 'RES-0004', JSON.stringify(ghost).slice(0, 140));

    const created = call(mock, 'inspection.taskCreate', { warehouseId: 1, deviceId: 3, targetDistance: 12.5 });
    check('合法建任务返回 taskId', created.ok && typeof created.value?.taskId === 'number', JSON.stringify(created).slice(0, 140));
    const list = call(mock, 'inspection.taskPage', { page: 1, pageSize: 20 });
    check('新建的任务出现在列表最前面', rowsOf(list.value)[0]?.taskId === created.value?.taskId, `first=${rowsOf(list.value)[0]?.taskId}`);
    check('新任务默认待开始、进度 0', created.value?.status === 0 && created.value?.progress === 0);
    check('仓库名与设备名跟着带上（不是空壳）', created.value?.warehouseName === '华东中心仓' && created.value?.deviceName === '读头 04', `${created.value?.warehouseName}/${created.value?.deviceName}`);
  }

  // ---- 5. 差异明细：有就是有，没有就是空数组（不是 undefined） ----
  {
    const mock = new DomainMock();
    const has = call(mock, 'inspection.taskDiff', { taskId: 501 });
    check('501 有 4 行差异', has.ok && Array.isArray(has.value) && has.value.length === 4, `len=${has.value?.length}`);
    const missing = has.value.find((r) => r.status === 'MISSING');
    check('盘亏行的 difference 是负数', missing !== undefined && missing.difference < 0, `diff=${missing?.difference}`);
    const empty = call(mock, 'inspection.taskDiff', { taskId: 502 });
    check('没有差异的任务回空数组（界面走空态，不是错误态）', empty.ok && Array.isArray(empty.value) && empty.value.length === 0, JSON.stringify(empty).slice(0, 120));
  }

  // ---- 6. 补录：只允许已完成；补录会重算计数 ----
  {
    const mock = new DomainMock();
    const early = call(mock, 'inspection.manualRecord', { taskId: 501, items: [{ rfid: 'PROBE-1' }] });
    check(
      '对进行中的任务补录 → VAL-0001，且带上服务端那句原话',
      early.ok === false && early.code === 'VAL-0001' && early.details.includes('只能对已完成的巡检任务进行补录'),
      JSON.stringify(early).slice(0, 160),
    );

    const noRfid = call(mock, 'inspection.manualRecord', { taskId: 503, items: [{ tid: 'T-1' }] });
    check('补录行缺 RFID → VAL-0001', noRfid.ok === false && noRfid.code === 'VAL-0001', JSON.stringify(noRfid).slice(0, 140));

    const emptyItems = call(mock, 'inspection.manualRecord', { taskId: 503, items: [] });
    check('空明细 → VAL-0001', emptyItems.ok === false && emptyItems.code === 'VAL-0001');

    const ok = call(mock, 'inspection.manualRecord', {
      taskId: 503,
      items: [
        { rfid: 'PROBE-A', tid: 'TID-A', remark: '现场补录' },
        { rfid: 'PROBE-B' },
      ],
    });
    check('对已完成的任务补录成功', ok.ok === true, JSON.stringify(ok).slice(0, 140));
    const after = call(mock, 'inspection.taskDetail', { taskId: 503 }).value;
    check('补录后仍是已完成', after.status === 2, `status=${after.status}`);
    check('补录触发重算：已扫数 = 补录条数', after.inspectedItems === 2, `inspected=${after.inspectedItems}`);
    check(
      '补录触发重算：不代表"正常"（实测 normal 8 → 0）',
      after.normalItems === 0,
      `normal=${after.normalItems}`,
    );
  }

  // ---- 7. 录入结果：写回计数并把任务收口 ----
  {
    const mock = new DomainMock();
    const bad = call(mock, 'inspection.resultCreate', { taskId: 501, totalItems: -1, normalItems: 0, abnormalItems: 0, missingItems: 0, extraItems: 0 });
    check('负数计数 → VAL-0001', bad.ok === false && bad.code === 'VAL-0001', JSON.stringify(bad).slice(0, 120));

    const ghost = call(mock, 'inspection.resultCreate', { taskId: 9999, totalItems: 1, normalItems: 1, abnormalItems: 0, missingItems: 0, extraItems: 0 });
    check('给不存在的任务录结果 → RES-0004', ghost.ok === false && ghost.code === 'RES-0004');

    const created = call(mock, 'inspection.resultCreate', {
      taskId: 502,
      totalItems: 10,
      normalItems: 8,
      abnormalItems: 2,
      missingItems: 1,
      extraItems: 1,
    });
    check('录入结果返回 resultId', created.ok && typeof created.value?.resultId === 'number', JSON.stringify(created).slice(0, 140));
    check('结果里记下了实扫数（正常 + 异常）', created.value?.totalScanned === 10 && created.value?.totalExpected === 10, `scanned=${created.value?.totalScanned}`);
    const task = call(mock, 'inspection.taskDetail', { taskId: 502 }).value;
    check(
      '录入结果后任务收口：已完成 + 计数写回',
      task.status === 2 && task.totalItems === 10 && task.normalItems === 8 && task.abnormalItems === 2,
      `status=${task.status} total=${task.totalItems} normal=${task.normalItems}`,
    );
  }

  // ---- 8. 结果列表：支持按任务过滤、不分页 ----
  {
    const mock = new DomainMock();
    const all = call(mock, 'inspection.resultList', {});
    check('结果列表不分页（直接回数组）', Array.isArray(all.value) && all.value.length === 2, `len=${all.value?.length}`);
    const byTask = call(mock, 'inspection.resultList', { taskId: 503 });
    check(
      '按任务过滤（服务端真的支持 taskId）',
      Array.isArray(byTask.value) && byTask.value.length === 1 && byTask.value[0]?.taskId === 503,
      JSON.stringify(byTask.value)?.slice(0, 140),
    );
    const none = call(mock, 'inspection.resultList', { taskId: 777 });
    check('过滤不到就回空数组', Array.isArray(none.value) && none.value.length === 0);
  }

  // ---- 9. 结果确认：服务端是空实现，假桥只翻本地状态，不编造"重复确认会被拒" ----
  {
    const mock = new DomainMock();
    const before = call(mock, 'inspection.resultDetail', { resultId: 9001 }).value;
    check('9001 初始待确认', before.status === 'PENDING', `status=${before.status}`);
    const first = call(mock, 'inspection.resultConfirm', { resultId: 9001 });
    const after = call(mock, 'inspection.resultDetail', { resultId: 9001 }).value;
    check('确认后本地状态变已入账', first.ok && after.status === 'CONFIRMED', `status=${after.status}`);
    const second = call(mock, 'inspection.resultConfirm', { resultId: 9001 });
    check('重复确认仍然成功（不造服务端没有的规则）', second.ok === true);
  }

  // ---- 10. 选项来源与其它域不打架 ----
  {
    const mock = new DomainMock();
    const plans = call(mock, 'inspection.planList', {});
    check('计划选项可读', rowsOf(plans.value).length === 3, `rows=${rowsOf(plans.value).length}`);
    check('不属于巡检域的方法仍然回 undefined（交给别的 mock）', mock.call('inventory.list', {}) !== undefined && mock.call('nope.nope', {}) === undefined);
  }

  // ---- 11. 巡检计划 CRUD：形状对齐服务端 DTO + 名称唯一 + != null 更新 ----
  {
    const mock = new DomainMock();
    const list = call(mock, 'inspection.planList', {});
    const first = rowsOf(list.value)[0];
    check(
      '计划字段与服务端 InspectionPlanDTO 对齐（planName/deviceId/cronExpression/enabled）',
      first?.planName === '华东中心仓日常盘点' && first?.deviceId === 3 && first?.cronExpression === '0 0 8 * * ?' && first?.enabled === true,
      JSON.stringify(first ?? {}).slice(0, 160),
    );
    check(
      '**没有编造 warehouseId/warehouseName**（早先假桥里就有这两个不存在的字段）',
      first?.warehouseId === undefined && first?.warehouseName === undefined,
      JSON.stringify(first ?? {}).slice(0, 160),
    );
    check('停用状态能表达出来（列表里有一条 enabled=false）', rowsOf(list.value).some((x) => x.enabled === false));

    const ghost = call(mock, 'inspection.planDetail', { planId: 9999 });
    check('查不存在的计划 → RES-0004「巡检计划不存在」', ghost.ok === false && ghost.code === 'RES-0004' && ghost.details.includes('巡检计划不存在'));

    const dup = call(mock, 'inspection.planCreate', { planName: '华东中心仓日常盘点' });
    check('计划名重复 → 拒绝，且带服务端原话', dup.ok === false && dup.details.includes('巡检计划名称已存在'), dup.details);

    const created = call(mock, 'inspection.planCreate', { planName: '冒烟新计划', deviceId: 2, cronExpression: '0 0 7 * * ?' });
    check('新建计划成功并回 planId', created.ok && typeof created.value?.planId === 'number', JSON.stringify(created).slice(0, 120));
    check('**新建的计划一律启用**（服务端 `status=1`，不看请求）', created.value?.enabled === true, `enabled=${created.value?.enabled}`);
    check('新计划出现在列表最前面', rowsOf(call(mock, 'inspection.planList', {}).value)[0]?.planId === created.value?.planId);

    const renamed = call(mock, 'inspection.planUpdate', { planId: 1, planName: '华东日常盘点（改）' });
    check('只改名字：其它字段保持原值（`!= null` 才写）', renamed.value?.planName === '华东日常盘点（改）' && renamed.value?.deviceId === 3 && renamed.value?.cronExpression === '0 0 8 * * ?', JSON.stringify(renamed.value ?? {}).slice(0, 160));
    const disabled = call(mock, 'inspection.planUpdate', { planId: 1, enabled: false });
    check('能停用（enabled → 服务端的 status）', disabled.value?.enabled === false, `enabled=${disabled.value?.enabled}`);
    const ghostUpdate = call(mock, 'inspection.planUpdate', { planId: 9999, planName: 'x' });
    check('更新不存在的计划 → RES-0004', ghostUpdate.ok === false && ghostUpdate.code === 'RES-0004');

    const beforeCount = rowsOf(call(mock, 'inspection.planList', {}).value).length;
    const removed = call(mock, 'inspection.planDelete', { planId: created.value.planId });
    check('删除计划成功', removed.ok === true);
    check('列表少了一条', rowsOf(call(mock, 'inspection.planList', {}).value).length === beforeCount - 1);
    check('删不存在的计划 → RES-0004', call(mock, 'inspection.planDelete', { planId: created.value.planId }).ok === false);
  }
} catch (error) {
  console.error(`✗ 假桥护栏执行失败：${error?.stack ?? error}`);
  process.exit(1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`✗ ${f}`);
  }
  console.error(`check-inspection-mock: ${failures.length}/${passed + failures.length} 个用例失败`);
  process.exit(1);
}
console.log(`check-inspection-mock OK: ${passed} 个用例（分页口径 / 状态值 / 补录闸门 / 结果收口 / 过滤）`);

#!/usr/bin/env node
/**
 * check-page-params.mjs —— **分页参数名必须与服务端一致**。
 *
 * ## 为什么需要这条护栏
 *
 * 真后端不是一个口径（2026-10-03 逐个 Controller 核过）：
 *
 * | 桥方法 | 服务端参数名 | 证据 |
 * | --- | --- | --- |
 * | `alert.list` | `size` | `AlertController.java:83` |
 * | `stockOrder.list` | `size` | `InOutController.java:52` |
 * | `user.list` | `size` | `UserController.java:101` |
 * | `message.list` | `size` | `MessageQueryRequest{page,size}`（0 基） |
 * | `inventory.list` / `inventory.listAll` | `pageSize` | `InventoryController.java:149,246,276` |
 * | `product.list` | `pageSize` | `InventoryController.java:149`（`/api/inventories/products`） |
 * | `tag.list` / `tag.byProduct` / `tag.search` | `pageSize` | `TagController.java:112,128,191` |
 * | `inspection.taskPage` | `pageSize` | `InspectionController.java:138` |
 * | `warehouse.list` / `device.list` / `inspection.planList` | **不接分页参数** | `WarehouseController.java:34`、`DeviceController.java:96`、`InspectionController.java:73` |
 *
 * 发错名字的后果是**静默的**：Spring 忽略未知 query 参数，退回默认每页 10 条 ——
 * 界面上不报错、不空白，只是"翻页永远停在 10 条"。而假桥原先**两个名字都认**，
 * 于是开发态一切正常、真机上不对（那批屏的注释里甚至写着"实测发 `size` 就翻得动页"——
 * 实测的是假桥）。
 *
 * 真后端实测钉死（`tools/bench/inventory-tag-probe.mjs`）：
 * `GET /api/tag?size=1` → 7 条（全部，参数被忽略）；`?pageSize=1` → 1 条。
 *
 * ## 它校验什么、不校验什么
 *
 * · **校验**：事实表里登记了参数名的方法 —— 客户端传的必须就是那一个名字；
 * · **只警告**：事实表里是"不接分页参数"的方法 —— 传了会被忽略（行为无害），
 *   但如果屏上因此画出了分页条，那条分页条是假的。清理它要同时改屏上的分页 UI，
 *   属于另一件事，所以这里只提示、不判失败。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 服务端事实表：桥方法 → 分页参数名（`null` = 服务端不接分页参数）。 */
const SERVER_PAGING = {
  'alert.list': 'size',
  'stockOrder.list': 'size',
  'user.list': 'size',
  'message.list': 'size',
  'inventory.list': 'pageSize',
  'inventory.listAll': 'pageSize',
  'product.list': 'pageSize',
  'tag.list': 'pageSize',
  'tag.byProduct': 'pageSize',
  'tag.search': 'pageSize',
  'inspection.taskPage': 'pageSize',
  'warehouse.list': null,
  'device.list': null,
  'inspection.planList': null,
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith('.vue')) out.push(full);
  }
  return out;
}

/** 注释里的说明文字不算代码 —— 本文件的表里就写着 `size`，不剥注释会自己命中自己。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const files = [...walk(path.join(ROOT, 'apps', 'web', 'src')), ...walk(path.join(ROOT, 'packages'))];

/**
 * 每页条数的两种写法。**必须排除字符串值**：Element Plus 的 `size: 'large'` 遍地都是，
 * 把那个当成"分页参数名"会让这条护栏到处误报 —— 而误报的门禁会被关掉，比没有更糟。
 *
 * 注意负向断言里必须再吃一次 `\s*`：写成 `size\s*:\s*(?!['"\`])` 会**回溯**——
 * `\s*` 先吃掉空格、断言失败，再退回去只吃 0 个空格、断言就成功了，于是 `size: 'large'` 照样命中。
 * 第一版就是这么写的，`TagListView` 因此被误报。
 */
const SIZE_KEY = /(^|[{,\s])size\s*:(?!\s*['"`])/m;
const PAGESIZE_KEY = /(^|[{,\s])pageSize\s*:(?!\s*['"`])/m;

const failures = [];
const warnings = [];
let checked = 0;

for (const file of files) {
  const code = stripComments(readFileSync(file, 'utf8'));
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  /*
   * **按文件判定，不按调用点窗口**。
   *
   * 分页参数往往不在 `useResource('x.list', { … })` 的字面量里，而是先写成
   * `const params = computed(() => ({ page, pageSize: PAGE_SIZE }))` 再传进去 —— 按窗口扫会
   * 一个都扫不到（第一版就是这样：48 个文件只扫出 3 处）。这些屏一个文件只用一种分页口径，
   * 所以按文件判定既准又简单；如果哪天真出现"一个文件混用两种口径"，下面的 `expected`
   * 会算出多个值，脚本选择**跳过并提示**，而不是猜。
   */
  const methods = Object.keys(SERVER_PAGING).filter((m) => code.includes(`'${m}'`));
  if (methods.length === 0) continue;

  const hasSize = SIZE_KEY.test(code);
  const hasPageSize = PAGESIZE_KEY.test(code);
  if (!hasSize && !hasPageSize) continue;

  const actual = hasPageSize && hasSize ? 'both' : hasPageSize ? 'pageSize' : 'size';
  const expectedSet = new Set(methods.map((m) => SERVER_PAGING[m]));
  const paginating = methods.filter((m) => SERVER_PAGING[m] !== null);
  checked += 1;

  const nonPaging = methods.filter((m) => SERVER_PAGING[m] === null);
  if (nonPaging.length > 0) {
    warnings.push(
      `${rel} 用到 '${nonPaging.join("', '")}'（服务端不接分页参数，传了会被忽略；若屏上有分页条，那是假的）`,
    );
  }

  if (paginating.length === 0) continue; // 整屏都不接分页参数：上面已提示，不判失败

  if (actual === 'both') {
    failures.push(`${rel} 同时出现 size 与 pageSize；'${paginating.join("', '")}' 服务端只认 ${[...expectedSet].join(' / ')}`);
    continue;
  }
  const expected = SERVER_PAGING[paginating[0]];
  if (!expectedSet.has(actual) || expectedSet.size > 1) {
    failures.push(
      `${rel} 传了 ${actual}，但 '${paginating.join("', '")}' 服务端只认 ${[...expectedSet].join(' / ')}`,
    );
  }
}

for (const w of warnings) console.warn(`  ! ${w}`);
if (failures.length > 0) {
  console.error(`check-page-params FAIL：${failures.length} 处分页参数名与服务端不一致`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(
  `check-page-params OK: 扫描 ${files.length} 个 .vue，${checked} 个含分页参数的文件全部与服务端参数名一致` +
    (warnings.length > 0 ? `（${warnings.length} 处"服务端不接分页参数"的提示，见上）` : ''),
);

#!/usr/bin/env node
/**
 * check-inventory-mock.mjs —— 库存**服务端搜索**（`inventory.search`）假桥的语义护栏。
 *
 * ## 为什么值得单独一条
 *
 * 这个接口的语义与它的名字**不一致**，而且服务端源码里写得明明白白：
 *   · `keyword` + `type` 都必填，`type` 只认 `PRODUCT` / `LOCATION`，**其它值回空数组**（不报错）；
 *   · `PRODUCT` → 按商品名查商品，**硬截断前 100 条**；
 *   · `LOCATION` → 方法名是 `searchInventoryByLocation`（像"按货位搜"），
 *     但实现是 `productRepository.findByNameContaining(keyword)` 再取这些商品的库存行 ——
 *     **按商品名匹配的库存全量**，既不按货位、也不分区。
 *
 * 如果假桥写得比服务端"更聪明"（比如真的支持按货位/编码模糊匹配），
 * 界面就会在开发态一切正常、到真机上搜不到东西 —— 典型的假功能。
 * 这条护栏钉住的正是"**假桥和服务端一样笨**"。
 *
 * 用 esbuild 打一次包再 import（本仓没有 ts 运行时，esbuild 已是依赖）。
 *
 * 用法：node tools/check/check-inventory-mock.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'bridge-client', 'src', 'mock-domains.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-inv-mock-'));
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

function call(mock, method, params) {
  try {
    return { ok: true, value: mock.call(method, params) };
  } catch (error) {
    return { ok: false, code: error?.code, details: String(error?.details ?? '') };
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

  const { DomainMock } = await import(pathToFileURL(outFile).href);
  if (typeof DomainMock !== 'function') {
    console.error('✗ mock-domains.ts 没有导出 DomainMock');
    process.exit(1);
  }

  // ---- 1. 必填与 type 白名单 ----
  {
    const mock = new DomainMock();
    check('空关键词回空数组（服务端就是这么写的）', call(mock, 'inventory.search', { keyword: '', type: 'LOCATION' }).value.length === 0);
    check('空关键词 + PRODUCT 也回空数组', call(mock, 'inventory.search', { keyword: '  ', type: 'PRODUCT' }).value.length === 0);
    check(
      '不认识的 type 回空数组，而不是报错（服务端 `return List.of()`）',
      call(mock, 'inventory.search', { keyword: '密封', type: 'SOMETHING' }).value.length === 0,
    );
    check(
      'type 大小写不敏感（服务端用 equalsIgnoreCase）',
      call(mock, 'inventory.search', { keyword: '密封', type: 'location' }).value.length > 0,
    );
  }

  // ---- 2. LOCATION：按**商品名**匹配库存，且不分区 ----
  {
    const mock = new DomainMock();
    const byName = call(mock, 'inventory.search', { keyword: '密封', type: 'LOCATION' });
    check('LOCATION 按商品名命中库存', Array.isArray(byName.value) && byName.value.length === 1, `len=${byName.value?.length}`);
    check('命中的确实是那个商品的库存行', byName.value[0]?.productName === '液压密封组件', byName.value[0]?.productName);

    const byCode = call(mock, 'inventory.search', { keyword: 'HYD-SEAL-22', type: 'LOCATION' });
    check(
      '**按商品编码搜不到**（服务端只 findByNameContaining —— 不要做得更聪明）',
      byCode.value.length === 0,
      `len=${byCode.value.length}`,
    );
    const byLocation = call(mock, 'inventory.search', { keyword: 'B-02-04', type: 'LOCATION' });
    check(
      '**按货位搜不到**（尽管方法名叫 searchInventoryByLocation）',
      byLocation.value.length === 0,
      `len=${byLocation.value.length}`,
    );
    const byWarehouse = call(mock, 'inventory.search', { keyword: '华东中心仓', type: 'LOCATION' });
    check('**按仓库搜不到**（同上）', byWarehouse.value.length === 0, `len=${byWarehouse.value.length}`);

    const partial = call(mock, 'inventory.search', { keyword: '紧固件', type: 'LOCATION' });
    check('商品名取子串即可命中（包含匹配，不是全等）', partial.value.length === 1, `len=${partial.value.length}`);
  }

  // ---- 3. PRODUCT：回的是**商品**，不是库存行 ----
  {
    const mock = new DomainMock();
    const products = call(mock, 'inventory.search', { keyword: '密封', type: 'PRODUCT' });
    check('PRODUCT 回商品列表', Array.isArray(products.value) && products.value.length === 1, `len=${products.value?.length}`);
    check('回的是商品形状（有 productCode，没有 inventoryId）', products.value[0]?.productCode === 'HYD-SEAL-22' && products.value[0]?.inventoryId === undefined, JSON.stringify(products.value[0] ?? {}).slice(0, 80));
    const none = call(mock, 'inventory.search', { keyword: '不存在的商品', type: 'PRODUCT' });
    check('搜不到就回空数组（不是报错）', none.ok && none.value.length === 0);
  }

  // ---- 4. 不分区：命中全量，而不是"当前页那几条" ----
  {
    const mock = new DomainMock();
    const rows = call(mock, 'inventory.search', { keyword: '密封', type: 'LOCATION' }).value;
    check('搜索结果是**裸数组**（服务端返回 List，不是分页对象）', Array.isArray(rows));
    check('返回的行带完整字段（界面直接用，不需要再逐条取详情）', rows[0]?.warehouseName === '华南备件仓' && rows[0]?.location === 'B-02-04', `${rows[0]?.warehouseName}/${rows[0]?.location}`);
  }
} catch (error) {
  console.error(`✗ 护栏执行失败：${error?.stack ?? error}`);
  process.exit(1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`✗ ${f}`);
  }
  console.error(`check-inventory-mock: ${failures.length}/${passed + failures.length} 个用例失败`);
  process.exit(1);
}
console.log(`check-inventory-mock OK: ${passed} 个用例（必填/type 白名单 / 只按商品名 / PRODUCT 回商品 / 不分区裸数组）`);

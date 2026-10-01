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

  // ---- 5. 商品更新：**部分更新**语义（空值保留原值，model 例外） ----
  {
    const mock = new DomainMock();
    const ghost = call(mock, 'product.update', { productId: 99999, productName: 'x' });
    check(
      '更新不存在的商品 → RES-0004「产品不存在」',
      ghost.ok === false && ghost.code === 'RES-0004' && ghost.details.includes('产品不存在'),
      JSON.stringify(ghost).slice(0, 140),
    );

    // 只改单位：名称/编码/型号**必须保持原值**（部分更新）
    const partial = call(mock, 'product.update', { productId: 1, unit: '箱' });
    check('只传 unit 也能成功', partial.ok === true, JSON.stringify(partial).slice(0, 120));
    check(
      '**没传的字段保持原值**（不是被清空）',
      partial.value?.productName === '工业级 RFID 标签' &&
        partial.value?.productCode === 'RFID-UHF-01' &&
        partial.value?.model === 'UHF-01',
      JSON.stringify(partial.value ?? {}).slice(0, 120),
    );
    check('传了的字段真的改了', partial.value?.unit === '箱');

    // 空白字符串同样算"没传"（服务端用 isBlank 判）
    const blank = call(mock, 'product.update', { productId: 1, productName: '   ', productCode: '', unit: '' });
    check(
      '空白字符串 = 保留原值（服务端用 isBlank 判，不是"清空"）',
      blank.value?.productName === '工业级 RFID 标签' && blank.value?.productCode === 'RFID-UHF-01' && blank.value?.unit === '箱',
      JSON.stringify(blank.value ?? {}).slice(0, 120),
    );

    // model 是例外：不是 null 就写 → 空串等于清空型号
    const clearModel = call(mock, 'product.update', { productId: 1, model: '' });
    check('model 传空串 → 清空型号（其它三个字段不是这个规则）', clearModel.value?.model === '', `model=${clearModel.value?.model}`);

    // 改名 + 改编码，然后**读回来**（防止只回显不落库）
    const renamed = call(mock, 'product.update', { productId: 1, productName: '工业级 RFID 标签（新版）', productCode: 'RFID-UHF-02' });
    check(
      '改名与改编码生效',
      renamed.value?.productName === '工业级 RFID 标签（新版）' && renamed.value?.productCode === 'RFID-UHF-02',
      JSON.stringify(renamed.value ?? {}).slice(0, 120),
    );
    const reread = call(mock, 'product.list', {}).value.rows.find((r) => r.productId === 1);
    check('再查列表是新值（写真的落到数据上了）', reread?.productName === '工业级 RFID 标签（新版）', JSON.stringify(reread ?? {}).slice(0, 120));

    // 搜索按商品名匹配 —— 改名之后旧名不该再命中（避免"搜到幽灵"）
    const oldWord = call(mock, 'inventory.search', { keyword: '工业级 RFID 标签', type: 'PRODUCT' }).value;
    check('改名后旧名不再被搜到（数据只有一份）', Array.isArray(oldWord) && oldWord.every((x) => x.productName !== '工业级 RFID 标签'), JSON.stringify(oldWord).slice(0, 100));
  }

  // ---- 6. 仓库更新：与商品**相反**的语义（`!= null` 就写 → 空串是清空） ----
  {
    const mock = new DomainMock();
    const ghost = call(mock, 'warehouse.update', { id: 99999, warehouseName: 'x' });
    check('更新不存在的仓库 → RES-0004「仓库不存在」', ghost.ok === false && ghost.code === 'RES-0004' && ghost.details.includes('仓库不存在'), JSON.stringify(ghost).slice(0, 140));
    check('路径参数名是 **id**（不是 warehouseId）', call(mock, 'warehouse.update', { warehouseId: 1, warehouseName: 'x' }).ok === false, '用 warehouseId 竟然成功了 —— 参数名接错');

    const renamed = call(mock, 'warehouse.update', { id: 1, warehouseName: '华东中心仓（新）', warehouseCode: 'EC-01A' });
    check('改名与改编码生效', renamed.ok && renamed.value?.warehouseName === '华东中心仓（新）' && renamed.value?.warehouseCode === 'EC-01A', JSON.stringify(renamed.value ?? {}).slice(0, 120));
    check(
      '**没传的字段保持原值**（这一次是"没传"，不是"传空"）',
      renamed.value?.address === '上海市青浦区' && renamed.value?.description === '常温区，负责华东片区',
      JSON.stringify(renamed.value ?? {}).slice(0, 140),
    );

    const cleared = call(mock, 'warehouse.update', { id: 1, address: '', description: '' });
    check(
      '**传空串 = 清空**（与商品屏相反：商品那边空串是保留）',
      cleared.value?.address === '' && cleared.value?.description === '',
      JSON.stringify(cleared.value ?? {}).slice(0, 140),
    );

    const reread = call(mock, 'warehouse.list', {}).value.rows.find((w) => w.warehouseId === 1);
    check('再查列表是新值（写真的落到数据上了）', reread?.warehouseName === '华东中心仓（新）' && reread?.address === '', JSON.stringify(reread ?? {}).slice(0, 140));
    check('新建仓库带上了描述字段（DTO 里本来就有，之前界面没维护）', call(mock, 'warehouse.create', { warehouseName: '临时仓', warehouseCode: 'TMP-9', description: '临时' }).ok === true && call(mock, 'warehouse.list', {}).value.rows[0]?.description === '临时', 'description 没被写入');
  }

  // ---- 7. 单据明细增删：状态闸门 + 只从标签取商品 + 项数同步 ----
  {
    const mock = new DomainMock();
    /*
     * 用 **tagId 3**：8001 的种子明细里已经有 tag 1（`items: [{tagId: 1, …}]`），
     * 拿 tag 1 测"加一条再删一条"会变成"加重复项、删掉其中一条"，断言会自相矛盾（第一次写就是这么错的）。
     */
    const FREE_TAG = 3;
    // 8001 待审批（PENDING=0）→ 允许；8002 待审核（SUBMITTED=4）→ 拒绝
    const allowed = call(mock, 'stockOrder.addItem', { orderId: 8001, tagId: FREE_TAG });
    check('待审批单据可以添加明细', allowed.ok === true, JSON.stringify(allowed).slice(0, 120));
    check('返回的是整张单据（服务端回 StockOrderDTO）', allowed.value?.orderId === 8001, JSON.stringify(allowed.value ?? {}).slice(0, 80));
    const order = call(mock, 'stockOrder.detail', { orderId: 8001 }).value;
    check('明细真的多了一条', order.items.some((x) => x.tagId === FREE_TAG), JSON.stringify(order.items).slice(0, 140));

    const denied = call(mock, 'stockOrder.addItem', { orderId: 8002, tagId: FREE_TAG });
    check(
      '已提交（待审核）的单据**不能**加明细，且带服务端原话',
      denied.ok === false && denied.code === 'VAL-0001' && denied.details.includes('只有待处理或已驳回的单据可以添加明细'),
      JSON.stringify(denied).slice(0, 160),
    );
    const deniedRemove = call(mock, 'stockOrder.removeItem', { orderId: 8002, tagId: FREE_TAG });
    check('同理不能删明细', deniedRemove.ok === false && deniedRemove.details.includes('可以删除明细'), deniedRemove.details);

    const noOrder = call(mock, 'stockOrder.addItem', { orderId: 99999, tagId: FREE_TAG });
    check('单据不存在 → RES-0004「出入库单不存在」', noOrder.ok === false && noOrder.code === 'RES-0004' && noOrder.details.includes('出入库单不存在'));
    const noTag = call(mock, 'stockOrder.addItem', { orderId: 8001, tagId: 99999 });
    check('标签不存在 → RES-0004「标签不存在」', noTag.ok === false && noTag.code === 'RES-0004' && noTag.details.includes('标签不存在'));

    const before = call(mock, 'stockOrder.detail', { orderId: 8001 }).value.totalItems;
    const removed = call(mock, 'stockOrder.removeItem', { orderId: 8001, tagId: FREE_TAG });
    check('待审批单据可以移除明细', removed.ok === true, JSON.stringify(removed).slice(0, 120));
    const after = call(mock, 'stockOrder.detail', { orderId: 8001 }).value;
    check(
      '移除后明细不见了，且项数同步减一（服务端就是这么做的）',
      !after.items.some((x) => x.tagId === FREE_TAG) && after.totalItems === before - 1,
      `totalItems ${before} → ${after.totalItems}`,
    );
    const removeGhost = call(mock, 'stockOrder.removeItem', { orderId: 8001, tagId: FREE_TAG });
    check('再删同一条 → RES-0004「明细不存在」', removeGhost.ok === false && removeGhost.details.includes('明细不存在'));
    check('种子那条 tag 1 没被误删', call(mock, 'stockOrder.detail', { orderId: 8001 }).value.items.some((x) => x.tagId === 1));
  }

  // ---- 8. 标签读写：**假桥必须和服务端一样笨**（这几条的判据全部来自真后端实测） ----
  {
    const mock = new DomainMock();

    // 8.1 batchUnbind / batchQuery 在真后端上结构性不可达（两种 body 形态都 400）——
    //     假桥原先能正常批量解绑，于是开发态一切正常、真机上怎么点都失败。
    const batchUnbind = call(mock, 'tag.batchUnbind', { tagIds: [1] });
    check(
      '假桥复刻 tag.batchUnbind 的不可达（服务端要裸数组、网关要信封 → 两态都 400）',
      batchUnbind.ok === false && batchUnbind.code === 'VAL-REQUEST-1001',
      JSON.stringify(batchUnbind).slice(0, 120),
    );
    const batchQuery = call(mock, 'tag.batchQuery', { barcodes: ['X'] });
    check('tag.batchQuery 同族，同样不可达', batchQuery.ok === false && batchQuery.code === 'VAL-REQUEST-1001', JSON.stringify(batchQuery).slice(0, 120));

    // 8.2 新建：三个标识至少一个；**带 productId 时 status 仍是 0**（服务端不按商品推导状态）
    // 用**假桥里真实存在的第一个 productId**：写死 7 是不行的（真后端首个商品恰好是 7，假桥不是）——
    // 这次一开始就是写死了 7，`tag.bind` 因"商品不存在"失败，而断言 detail 写的是
    // `JSON.stringify(bound.value ?? {})`，失败分支只打印出一个 `{}`，看不出真因。
    const PRODUCT_ID = call(mock, 'product.list', { page: 1, pageSize: 1 }).value.rows[0].productId;
    const empty = call(mock, 'tag.create', {});
    check('三个标识全空 → 拒绝', empty.ok === false, JSON.stringify(empty).slice(0, 120));
    const created = call(mock, 'tag.create', { barcode: 'T-CHECK-1', productId: PRODUCT_ID });
    check('新建标签成功并回 DTO', created.ok === true && typeof created.value?.tagId === 'number', JSON.stringify(created).slice(0, 140));
    check(
      '带 productId 建出来的标签 status 仍是 0（"有商品却显示未绑定"的根源）',
      created.value?.status === 0,
      `status=${created.value?.status}`,
    );
    const newId = created.value.tagId;

    // 8.3 绑定：productId 是查询参数；绑定后 status 被服务端**强制覆写**成 1
    const bindNoProduct = call(mock, 'tag.bind', { tagId: newId });
    check('tag.bind 缺 productId → 报"缺少必需的请求参数"', bindNoProduct.ok === false && bindNoProduct.details.includes('productId'), bindNoProduct.details);
    const bound = call(mock, 'tag.bind', { tagId: newId, productId: PRODUCT_ID });
    check(
      '绑定成功且 status 被覆写为 1',
      bound.ok === true && bound.value?.status === 1,
      bound.ok ? JSON.stringify(bound.value ?? {}).slice(0, 120) : `失败 ${bound.code} ${bound.details}`,
    );

    // 8.4 改标识：**空白串 = 清空**（与 product.update 的"空白=保留"相反）
    const blanked = call(mock, 'tag.update', { tagId: newId, barcode: '' });
    check(
      'tag.update 的空白串 = 清空（不是"保留原值"）',
      blanked.ok === true && (blanked.value?.barcode === undefined || blanked.value?.barcode === null),
      `barcode=${JSON.stringify(blanked.value?.barcode)}`,
    );
    const kept = call(mock, 'tag.update', { tagId: newId, rfid: 'RFID-CHECK' });
    check('没传的字段保留原值（缺省 = 保留）', kept.ok === true && kept.value?.nfcUid === undefined, JSON.stringify(kept.value ?? {}).slice(0, 120));

    // 8.5 解绑：清 productId 并打回 status 0
    const unbound = call(mock, 'tag.unbind', { tagId: newId });
    check(
      '解绑后 productId 清空、status 回 0',
      unbound.ok === true && (unbound.value?.productId ?? null) === null && unbound.value?.status === 0,
      JSON.stringify(unbound.value ?? {}).slice(0, 120),
    );

    // 8.6 删除：成功时 payload.data 是 **null**（不是 {}）——别拿"拿到对象"当成功判据
    const deleted = call(mock, 'tag.delete', { tagId: newId });
    check('删除成功且 data 为 null（服务端是 success(null)）', deleted.ok === true && deleted.value === null, JSON.stringify(deleted).slice(0, 120));
    const gone = call(mock, 'tag.detail', { tagId: newId });
    check('删掉的标签查不到了（假桥的 detail 有兜底，所以这里只要求找不到刚建的那条）', gone.value?.tagId !== newId, JSON.stringify(gone.value ?? {}).slice(0, 120));
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

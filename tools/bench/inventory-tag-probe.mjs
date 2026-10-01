#!/usr/bin/env node
/**
 * inventory-tag-probe.mjs —— 把「库存 / 标签主数据 CRUD」这批接口在**真后端**上打一遍。
 *
 * ## 为什么需要它（而不是只读源码）
 *
 * 这批接口的语义**读源码能读出来，但结论会互相打架**：
 *   · `inventory.create` 的 `warehouseId` 被服务层完全忽略，而 `inventory.warehouse_id`
 *     在两份 schema 快照里都是 `NOT NULL` → 推断"必 500"，但这是**推断**；
 *   · `tag.unbind` 依赖 `product_tag.product_id` 可空，而 `wise_depot.sql:426` 写的是 NOT NULL、
 *     `p205-schema-snapshot.sql:265` 写的是可空，补丁只改了另外三个列；
 *   · `tag.batchUnbind` / `tag.batchQuery` 服务端签名是 `@RequestBody List<...>`（整个 body 就是数组），
 *     而桥的信封 `payload.data` 只能是 JSON 对象 → 推断"必 400"，同样是推断。
 *
 * 推断不能当判据。这个脚本给的是**真后端的实际回答**，并且在结束时把探针数据删干净。
 *
 * ## 用法
 *
 *   node tools/bench/inventory-tag-probe.mjs            # 只读探测（不改任何数据）
 *   node tools/bench/inventory-tag-probe.mjs --write    # 追加写探测（创建探针数据 → 用完删除）
 *   node tools/bench/inventory-tag-probe.mjs --base http://127.0.0.1:18080
 *
 * 前置：WiseDeoptServer 在跑（默认 `http://127.0.0.1:8080`），且 `deploy/.env.local` 里有
 * Redis 口令（登录要过图形验证码，答案由服务端明文写进 Redis —— 这是本仓测试基础设施的既有做法）。
 *
 * **不打印任何密钥。**
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENV_FILE = path.resolve(CLIENT_ROOT, '..', 'deploy', '.env.local');
const REDIS_CONTAINER = process.env.WISE_REDIS_CONTAINER || 'wd-local-redis';

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argValue = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const BASE = (argValue('--base', process.env.WISE_BASE_URL || 'http://127.0.0.1:8080')).replace(/\/$/, '');
const WRITE = hasFlag('--write');

let passed = 0;
let failed = 0;
function record(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}
/** 只要证据、不下结论的观察项（打印但不计入通过/失败）。 */
function observe(name, detail) {
  console.log(`  · ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 基础设施

function readEnv() {
  const map = {};
  if (!fs.existsSync(ENV_FILE)) return map;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

/** 验证码答案是明文存 Redis 的（`captcha:<uuid>`），这是仓库其它 bench 一直在用的取法。 */
function redisGet(key, password) {
  return execFileSync(
    'docker',
    ['exec', REDIS_CONTAINER, 'redis-cli', '-a', password, '--no-auth-warning', 'GET', key],
    { encoding: 'utf8' },
  ).trim();
}

const envelope = (data) => ({ header: { requestId: 'probe', timestamp: Date.now() }, payload: { data } });

async function http(method, urlPath, { token, body, rawBody } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(rawBody);
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(envelope(body));
  }
  const res = await fetch(BASE + urlPath, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留 text 供观察 */
  }
  return { status: res.status, code: json?.payload?.code ?? null, message: json?.payload?.message ?? null, data: json?.payload?.data, text: text.slice(0, 300) };
}

/** 一句话把一次调用说清楚，用于 observe/record 的 detail。 */
const brief = (r) => `HTTP ${r.status} code=${r.code ?? '-'} ${r.message ?? r.text.slice(0, 80)}`;

async function signIn(env) {
  const cap = await http('POST', '/api/captcha/generate', { body: {} });
  const captchaId = cap.data?.captchaId;
  if (!captchaId) throw new Error(`生成验证码失败：${cap.text}`);
  const code = redisGet(`captcha:${captchaId}`, env.WD_REDIS_PASSWORD);
  const login = await http('POST', '/api/auth/login', {
    body: { username: 'admin', password: process.env.WISE_ADMIN_PASSWORD || 'Wise-Admin-2026!', captchaId, captchaCode: code },
  });
  const token = login.data?.accessToken;
  if (!token) throw new Error(`登录失败：${brief(login)}`);
  return token;
}

// ---------------------------------------------------------------- 只读探测

async function readOnly(token) {
  console.log('\n=== 只读探测（不改任何数据）===');

  /*
   * 分页参数名：后端读 `pageSize`，而客户端 4 个屏都在传 `size`（被静默忽略 → 永远 10 条/页）。
   * 判据用 `pageSize=1` / `size=1` 对比：生效的那个只回 1 条。
   */
  const bySize = await http('GET', '/api/tag?page=1&size=1', { token });
  const byPageSize = await http('GET', '/api/tag?page=1&pageSize=1', { token });
  /** 列表响应可能是裸数组，也可能是分页对象；三种形状都认，避免"取错路径 → 误判为空"。 */
  const rowsOf = (r) => (Array.isArray(r.data) ? r.data : r.data?.rows ?? r.data?.items ?? r.data?.list ?? []);
  const n = (r) => rowsOf(r).length;
  observe('tag.list?size=1', `${n(bySize)} 条（${brief(bySize)}）`);
  observe('tag.list?pageSize=1', `${n(byPageSize)} 条（${brief(byPageSize)}）`);
  record(
    '分页参数名裁决：后端只认 pageSize（size 被静默忽略）',
    n(byPageSize) < n(bySize) && n(byPageSize) === 1,
    `size→${n(bySize)} 条 / pageSize→${n(byPageSize)} 条`,
  );

  const tags = await http('GET', '/api/tag?page=1&pageSize=5', { token });
  const firstTag = rowsOf(tags)[0] ?? null;
  observe('tag.list 响应形状', `keys=${tags.data && !Array.isArray(tags.data) ? Object.keys(tags.data).join(',') : 'array'}`);
  if (firstTag) {
    observe('tag 列表首条字段', Object.keys(firstTag).join(','));
    record(
      'ProductTagDTO.productCode 恒为 null（toProductTagDTO 从不赋值）',
      firstTag.productCode === null || firstTag.productCode === undefined,
      `productCode=${JSON.stringify(firstTag.productCode)} productName=${JSON.stringify(firstTag.productName)}`,
    );
  } else {
    observe('tag 列表为空，跳过 productCode 观察');
  }

  const products = await http('GET', '/api/inventories/products?page=1&pageSize=1', { token });
  const firstProduct = rowsOf(products)[0] ?? null;
  observe('product 列表', firstProduct ? `首个 productId=${firstProduct.productId ?? firstProduct.id} code=${firstProduct.productCode ?? firstProduct.code}` : brief(products));

  const warehouses = await http('GET', '/api/warehouse?page=1&pageSize=1', { token });
  const firstWarehouse = rowsOf(warehouses)[0] ?? null;
  observe('warehouse 列表', firstWarehouse ? `首个 warehouseId=${firstWarehouse.warehouseId ?? firstWarehouse.id} name=${firstWarehouse.warehouseName ?? firstWarehouse.name}` : brief(warehouses));

  const perms = await http('GET', '/api/permissions', { token });
  record('permission.list 返回裸数组（不分页）', perms.status === 200 && Array.isArray(perms.data), `${Array.isArray(perms.data) ? `${perms.data.length} 条` : typeof perms.data} ${brief(perms)}`);
  if (Array.isArray(perms.data) && perms.data[0]) {
    observe('permission 首条字段', Object.keys(perms.data[0]).join(','));
    observe('permission 首条内容', JSON.stringify(perms.data[0]).slice(0, 200));
  }

  const tree = await http('GET', '/api/permissions/tree', { token });
  const treeRoots = Array.isArray(tree.data) ? tree.data : [];
  const anyChildren = treeRoots.some((x) => Array.isArray(x?.children) && x.children.length > 0);
  record(
    'permission.tree 实际等于 list（无 parentId → 全是根、没有 children）',
    treeRoots.length === (Array.isArray(perms.data) ? perms.data.length : -1) && !anyChildren,
    `tree ${treeRoots.length} 个根 / children 非空=${anyChildren} / ${brief(tree)}`,
  );

  return { firstProduct, firstWarehouse, rowsOf };
}

// ---------------------------------------------------------------- 写探测

async function writeProbes(token, { firstProduct, firstWarehouse, rowsOf }) {
  console.log('\n=== 写探测（--write：创建探针数据并在结束时删除）===');
  const stamp = String(Date.now()).slice(-9);
  const cleanup = [];

  try {
    // ---- inventory.create ----
    // **必须用真库里存在的 productId**：不存在时后端回的是「产品不存在」，那会把"接口本身能不能用"
    // 这个问题搅混（我们要判断的是 `warehouseId` 那条路径）。
    const realProductId = firstProduct?.productId ?? firstProduct?.id ?? 1;
    const realWarehouseId = firstWarehouse?.warehouseId ?? firstWarehouse?.id ?? 1;

    // 先按"界面最少该填什么"试一次：不带 warehouseId。
    // 真后端实测回的是 `VAL-0001 请求参数校验失败: 仓库ID不能为空`（**不是**源码推断的 500）——
    // 也就是说服务层确实有一条仓库校验，简报只引到了 productId/quantity 那两行。
    const noWarehouse = await http('POST', '/api/inventories', { token, body: { productId: realProductId, quantity: 7 } });
    record('inventory.create 不带 warehouseId 会被校验拦下（仓库ID必填）', noWarehouse.code !== 'RES-0000', brief(noWarehouse));

    // 再带上一个真库里的 warehouseId —— 这一步才回答"这接口到底能不能用"。
    const created = await http('POST', '/api/inventories', { token, body: { productId: realProductId, warehouseId: realWarehouseId, quantity: 7 } });
    if (created.code === 'RES-0000') {
      cleanup.push(['inventory', created.data?.inventoryId]);
      record('inventory.create 带 warehouseId 能建出库存明细（服务层仍不写该字段，但插入前会兜住？）', true, `${brief(created)}`);
      observe('新建库存 DTO', JSON.stringify(created.data).slice(0, 260));
      const invId = created.data?.inventoryId;
      const upd = await http('PUT', `/api/inventories/${invId}`, { token, body: { quantity: 0 } });
      record('inventory.update 的 quantity:0 是"真写 0"（不是"没传"）', upd.code === 'RES-0000' && upd.data?.quantity === 0, brief(upd));
      const badUpd = await http('PUT', `/api/inventories/${invId}`, { token, body: { quantity: '' } });
      record('inventory.update 传空串直接 400（数字字段没有"空白串=保留"这套语义）', badUpd.status === 400, brief(badUpd));
    } else {
      record(
        'inventory.create 在真后端上可用（带 warehouseId 也不行 → 界面不该提供这个按钮）',
        false,
        `${brief(created)} ← warehouseId 必填却从不写库（InventoryApplicationService#createInventory 不 setWarehouseId）`,
      );
    }

    // ---- tag.create ----
    const tag = await http('POST', '/api/tag', { token, body: { barcode: `PROBE-${stamp}`, nfcUid: `NFC-${stamp}` } });
    const tagId = tag.data?.tagId ?? tag.data?.id;
    if (tagId === undefined) {
      record('tag.create 能建出标签', false, brief(tag));
      return;
    }
    cleanup.push(['tag', tagId]);
    record('tag.create 能建出标签', true, `tagId=${tagId} ${brief(tag)}`);
    record('tag.create 不带 productId 时 status 仍是 0（"有商品却显示未绑定"的根源）', tag.data?.status === 0, `status=${JSON.stringify(tag.data?.status)}`);

    // ---- tag.bind：productId 在 query ----
    const productId = firstProduct?.productId ?? firstProduct?.id ?? 1;    const bindByQuery = await http('POST', `/api/tag/${tagId}/bind?productId=${productId}`, { token });
    record('tag.bind 的 productId 走 query（服务端 @RequestParam）', bindByQuery.code === 'RES-0000', `${brief(bindByQuery)}`);
    const bindByBody = await http('POST', `/api/tag/${tagId}/bind`, { token, body: { productId } });
    record('tag.bind 按 body 传 productId 会被拒（对照，证明上一条不是"怎么传都行"）', bindByBody.code !== 'RES-0000', brief(bindByBody));

    const afterBind = await http('GET', `/api/tag/${tagId}`, { token });
    observe('绑定后 tag', `status=${afterBind.data?.status} productId=${afterBind.data?.productId}`);

    // ---- tag.update：空白串 = 清空？----
    const blank = await http('PUT', `/api/tag/${tagId}`, { token, body: { barcode: '' } });
    record('tag.update 的空白串 = 清空（不是"保留原值"）', blank.code === 'RES-0000' && (blank.data?.barcode === null || blank.data?.barcode === ''), `${brief(blank)} barcode=${JSON.stringify(blank.data?.barcode)}`);

    // ---- tag.unbind ----
    const unbind = await http('POST', `/api/tag/${tagId}/unbind`, { token });
    record('tag.unbind 能被服务端接受', unbind.code === 'RES-0000', `${brief(unbind)} ← 失败说明 product_tag.product_id 是 NOT NULL`);
    const afterUnbind = await http('GET', `/api/tag/${tagId}`, { token });
    observe('解绑后 tag.detail', `status=${afterUnbind.data?.status} productId=${afterUnbind.data?.productId}`);

    /*
     * 缓存裁决：`getTag` 带 `@Cacheable(prefix="tag", timeout=1800)`，而 update/delete/bind/unbind
     * 上**都没有 `@CacheEvict`**。所以上面那次 `tag.detail` 很可能读到的是**旧值**。
     * 用列表（另一条不走该缓存的读路径）复核，才能分清"写没生效"与"读到缓存"——
     * 这两件事在界面上长得一模一样（改完还是旧值），但处置方式完全不同。
     */
    const listAfter = await http('GET', '/api/tag?page=1&pageSize=50', { token });
    const rowAfter = rowsOf(listAfter).find((t) => String(t.tagId ?? t.id) === String(tagId)) ?? null;
    observe('解绑后 tag.list 里的同一条', rowAfter ? `status=${rowAfter.status} productId=${rowAfter.productId} barcode=${JSON.stringify(rowAfter.barcode)}` : '列表里找不到');

    const detailStale = afterUnbind.data?.productId !== null && rowAfter?.productId === null;
    const listStale = afterUnbind.data?.productId === null && rowAfter?.productId !== null;
    if (detailStale) {
      record('tag 写操作不失效 @Cacheable ⇒ tag.detail 会返回旧值（界面"改完还是旧值"的真因）', true, 'detail 仍是旧值 / list 是真实值');
    } else if (listStale) {
      record('tag.detail 比 tag.list 更新（与"缓存返回旧值"的推断相反，需要重新查）', false, 'detail 是真实值 / list 是旧值');
    } else {
      observe('缓存陈旧性本次没复现', `detail.productId=${afterUnbind.data?.productId} list.productId=${rowAfter?.productId}`);
    }

    // ---- tag.batchUnbind / tag.batchQuery：两种 body 形态 ----
    const asEnvelope = await http('POST', '/api/tag/batch-unbind', { token, body: { tagIds: [tagId] } });
    observe('tag.batchUnbind 传对象 {tagIds:[…]}', brief(asEnvelope));
    const asRawArray = await http('POST', '/api/tag/batch-unbind', { token, rawBody: [tagId] });
    observe('tag.batchUnbind 传裸数组 [id]', brief(asRawArray));
    record(
      'tag.batchUnbind 两种形态都调不通（桥的信封装不下对象、裸数组又被信封校验拦掉）⇒ 结构性不可达',
      asEnvelope.code !== 'RES-0000' && asRawArray.code !== 'RES-0000',
      `对象→${asEnvelope.code} / 裸数组→${asRawArray.code}`,
    );

    const queryObj = await http('POST', '/api/tag/batch-query', { token, body: { barcodes: ['PROBE-X'] } });
    const queryArr = await http('POST', '/api/tag/batch-query', { token, rawBody: ['PROBE-X'] });
    record(
      'tag.batchQuery 与 batchUnbind 同族（两种形态都调不通）',
      queryObj.code !== 'RES-0000' && queryArr.code !== 'RES-0000',
      `对象→${queryObj.code} / 裸数组→${queryArr.code}`,
    );
  } finally {
    // ---- 清理：探针数据必须删干净（删不掉就大声报出来，不能悄悄留下垃圾）----
    for (const [kind, id] of cleanup.reverse()) {
      const url = kind === 'tag' ? `/api/tag/${id}` : `/api/inventories/${id}`;
      const del = await http('DELETE', url, { token });
      const gone = await http('GET', url, { token });
      const ok = del.code === 'RES-0000' || gone.code === 'RES-0004';
      record(`清理探针数据 ${kind}#${id}`, ok, `${brief(del)} / 复查 ${brief(gone)}`);
    }
  }
}

// ---------------------------------------------------------------- main

const env = readEnv();
console.log(`=== 库存 / 标签 / 权限 真后端探针（${BASE}${WRITE ? '，含写探测' : '，只读'}）===`);
if (!env.WD_REDIS_PASSWORD) {
  console.error(`✗ 读不到 Redis 口令（${ENV_FILE} 里的 WD_REDIS_PASSWORD），登录要过验证码，无法继续。`);
  process.exit(2);
}

const token = await signIn(env);
record('真登录成功', true, `token 长度 ${String(token).length}`);

const { firstProduct, firstWarehouse, rowsOf } = await readOnly(token);
if (WRITE) await writeProbes(token, { firstProduct, firstWarehouse, rowsOf });
else console.log('\n（写探测被跳过：加 --write 才跑）');

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);

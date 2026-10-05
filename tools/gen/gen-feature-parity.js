#!/usr/bin/env node
/**
 * gen-feature-parity.js —— 生成「功能对照清单」（W0 交付物）。
 *
 * 为什么需要它：重构最大的风险不是技术，而是**漏迁**。旧 APP 有 29 个屏、19 条路由、
 * 169 个后端端点；逐域替换（W5–W7）时必须有一份"旧屏 → 新域 → 桥方法"的机器可核对清单，
 * 而不是靠人回忆。
 *
 * 输入（全部只读）：
 *   - 归档区 `.archive/wise-depot-android-refactor`：AppRoute.kt（路由目录）+ 全部 *Screen.kt
 *   - 生成物 `packages/contract/src/generated/bridgeContract.ts`：桥方法表
 * 输出：
 *   - `docs/feature-parity.md`
 *
 * 用法：
 *   node tools/gen/gen-feature-parity.js            # 生成/覆盖
 *   node tools/gen/gen-feature-parity.js --check    # 只校验
 *
 * 注：本文件刻意**不在模板字符串里写反引号字面量**（会终止模板），
 * 需要输出 Markdown 行内代码时统一用 BT 常量拼接。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BT = String.fromCharCode(96); // `

const GEN_DIR = __dirname;
const CLIENT_ROOT = path.resolve(GEN_DIR, '..', '..');
const WORKSPACE_ROOT = path.resolve(CLIENT_ROOT, '..');
const LEGACY_ROOT = path.join(WORKSPACE_ROOT, '.archive', 'wise-depot-android-refactor');
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const REGISTRY_TS = path.join(CLIENT_ROOT, 'apps', 'web', 'src', 'views', 'registry.ts');
const OVERLAY_JSON = path.join(CLIENT_ROOT, 'tools', 'gen', 'bridge-overlay.json');
const OUT = path.join(CLIENT_ROOT, 'docs', 'feature-parity.md');

const MODE = process.argv.includes('--check') ? 'check' : 'write';

/** 行内代码 */
const code = (s) => BT + s + BT;

/** 旧路由 id / 屏名 → 新一级域。关键字按顺序匹配，先命中者胜。 */
const DOMAIN_RULES = [
    [/^(inventory|tag|product|stock)/i, 'inventory'],
    [/^(alert|dashboard)/i, 'overview'],
    [/^(device|inspection|warehouse)/i, 'field'],
    [/^(message|user|profile)/i, 'me'],
    [/^(login|nfc|auth)/i, 'system（登录不在一级域内）'],
];

function domainOf(name) {
    const bare = name.replace(/^\/+/, '').split('/')[0];
    for (const [re, domain] of DOMAIN_RULES) {
        if (re.test(bare)) {
            return domain;
        }
    }
    return '**待归类**';
}

/** 读旧仓的 AppRoute.kt，取出路由 id 集合 */
function readLegacyRoutes() {
    const file = path.join(
        LEGACY_ROOT, 'app', 'src', 'main', 'java', 'com', 'huicang', 'wise', 'ui', 'navigation', 'AppRoute.kt');
    if (!fs.existsSync(file)) {
        throw new Error(`归档区找不到 AppRoute.kt：${file}\n（归档是否被移动过？见 .archive/ARCHIVE.md）`);
    }
    const text = fs.readFileSync(file, 'utf8');
    const ids = [...text.matchAll(/override val id: String = "([^"]+)"/g)].map((m) => m[1]);
    return [...new Set(ids)].sort();
}

/** 递归列目录（跳过构建产物与 .git） */
function walk(dir, out = []) {
    if (!fs.existsSync(dir)) {
        return out;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'build' || e.name === '.git' || e.name === '.gradle') {
                continue;
            }
            walk(p, out);
        } else {
            out.push(p);
        }
    }
    return out;
}

/** 全部旧屏（相对归档根 + 行数） */
function readLegacyScreens() {
    const files = walk(LEGACY_ROOT).filter((f) => f.endsWith('Screen.kt'));
    return files
        .map((f) => ({
            rel: path.relative(LEGACY_ROOT, f).replace(/\\/g, '/'),
            name: path.basename(f),
            lines: fs.readFileSync(f, 'utf8').split('\n').length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** 读桥方法表（从生成物里抓三元组） */
function readBridgeMethods() {
    if (!fs.existsSync(CONTRACT_TS)) {
        throw new Error(`找不到契约生成物：${CONTRACT_TS}\n请先跑 \`pnpm gen:contract\`。`);
    }
    const text = fs.readFileSync(CONTRACT_TS, 'utf8');
    const re =
        /\{ id: '([^']+)', domain: '([^']+)', httpMethod: '([^']+)', path: '([^']+)', packetType: '([^']+)', curated: (?:true|false), paramStyle: '([^']+)', keepPathParamsInBody: (?:true|false) \}/g;
    return [...text.matchAll(re)].map((m) => ({
        id: m[1],
        domain: m[2],
        httpMethod: m[3],
        path: m[4],
        packetType: m[5],
        paramStyle: m[6],
    }));
}

/**
 * `apps/web/src/views/registry.ts` 里**已登记**的桥方法 id —— 迁移状态的唯一判据。
 *
 * 为什么读源码而不是读一份手写的进度表：手写表会和代码漂移，
 * 而漂移的方向永远是"文档说迁完了、代码还没接"。读注册表则相反：
 * 谁把屏接进去，状态就自己变；没接就一直显示缺口。
 */
function readRegistryMethods() {
    if (!fs.existsSync(REGISTRY_TS)) {
        throw new Error(`找不到屏注册表：${REGISTRY_TS}`);
    }
    const text = fs.readFileSync(REGISTRY_TS, 'utf8');
    const at = text.indexOf('SCREEN_REGISTRY');
    if (at < 0) {
        throw new Error('registry.ts 里找不到 `SCREEN_REGISTRY` 声明，生成器需要同步更新。');
    }
    const body = text.slice(at);
    // Vue 注册表每一行长这样：`'message.list': () => import('./me/MessageListView.vue'),`
    return new Set([...body.matchAll(/^\s*'([^']+)':\s*\(\)\s*=>/gm)].map((m) => m[1]));
}

/**
 * 旧屏 → 新屏与它所依赖的桥方法。
 *
 * `methods` 只写**这一屏真正要用到的**方法（主方法 + 关键辅助方法），
 * 不写"理论上相关"的全部方法 —— 否则状态会被无关方法拖住，永远显示未迁完。
 * 旧屏若在新架构里不存在对应物（相机扫码、NFC 登录…），用 `note` 说明去向，
 * **不允许留空**：留空等于"忘了"，而忘了正是这份清单要防的事。
 */
const LEGACY_SCREEN_MAP = {
    'AlertDetailScreen.kt': { file: 'overview/AlertDetailView.vue', methods: ['alert.detail'] },
    'AlertListScreen.kt': { file: 'overview/AlertListView.vue', methods: ['alert.list'] },
    'CameraScanScreen.kt': { note: '壳能力（相机 + 解码在原生侧），不映射桥方法' },
    'CreateInspectionTaskScreen.kt': { file: 'field/InspectionTaskCreateView.vue', methods: ['inspection.taskCreate'] },
    'DashboardScreen.kt': { file: 'overview/DashboardView.vue', methods: ['dashboard.summary'] },
    'DeviceDetailScreen.kt': { file: 'field/DeviceDetailView.vue', methods: ['device.detail'] },
    'DeviceListScreen.kt': { file: 'field/DeviceListView.vue', methods: ['device.list'] },
    'InspectionDetailScreen.kt': { file: 'field/InspectionTaskDetailView.vue', methods: ['inspection.taskDetail'] },
    'InspectionListScreen.kt': { file: 'field/InspectionTaskListView.vue', methods: ['inspection.taskList'] },
    'InventoryDetailScreen.kt': { file: 'inventory/InventoryDetailView.vue', methods: ['inventory.detail'] },
    'InventoryManagementScreen.kt': { file: 'inventory/InventoryListView.vue', methods: ['inventory.list'] },
    'InventoryScreen.kt': { file: 'inventory/InventoryListView.vue', methods: ['inventory.list'] },
    'InventorySearchScreen.kt': { file: 'inventory/InventoryListView.vue', methods: ['inventory.search'] },
    'LoginScreen.kt': {
        file: 'auth/LoginView.vue',
        methods: [],
        outside: '登录屏不是可导航目的地，由 App.vue 的会话闸门直接渲染，因此不登记在屏注册表里',
    },
    'MainScreen.kt': { note: '被 AppFrame.vue 的桌面/手机两套布局取代（壳不再是一个屏）' },
    'ManualRecordScreen.kt': { file: 'field/InspectionManualRecordView.vue', methods: ['inspection.manualRecord'] },
    'MessageDetailScreen.kt': { file: 'me/MessageDetailView.vue', methods: ['message.detail'] },
    'MessageListScreen.kt': { file: 'me/MessageListView.vue', methods: ['message.list'] },
    'NfcLoginScreen.kt': { note: '壳能力（NFC 读取在原生侧），不映射桥方法' },
    // 商品屏现在也承担**编辑**（`product.update`）—— V6 之后补上的能力，写进映射免得文档落后于代码
    'ProductManagementScreen.kt': { file: 'inventory/ProductListView.vue', methods: ['product.list', 'product.update'] },
    'ProfileScreen.kt': { file: 'me/ProfileView.vue', methods: ['profile.get'] },
    'SkeletonScreen.kt': { note: '被 ListStateHost 四态（加载/错误/空/有数据）取代' },
    'StockOrderCreateScreen.kt': { file: 'inventory/StockOrderCreateView.vue', methods: ['stockOrder.create'] },
    'StockOrderDetailScreen.kt': { file: 'inventory/StockOrderDetailView.vue', methods: ['stockOrder.detail'] },
    'StockOrderListScreen.kt': { file: 'inventory/StockOrderListView.vue', methods: ['stockOrder.list'] },
    'TagDetailScreen.kt': { file: 'inventory/TagDetailView.vue', methods: ['tag.detail'] },
    'TagManagementScreen.kt': { file: 'inventory/TagListView.vue', methods: ['tag.list'] },
    'UserManagementScreen.kt': { file: 'me/UserListView.vue', methods: ['user.list'] },
    'WarehouseManagementScreen.kt': { file: 'inventory/WarehouseListView.vue', methods: ['warehouse.list', 'warehouse.update'] },
};

/** 旧路由 id → 它落到的桥方法（19 条扁平目的地，覆盖必须完整）。 */
const ROUTE_MAP = {
    'alert/detail': ['alert.detail'],
    'alert/list': ['alert.list'],
    'device/detail': ['device.detail'],
    'device/list': ['device.list'],
    'inspection/create': ['inspection.taskCreate'],
    'inspection/detail': ['inspection.taskDetail'],
    'inspection/list': ['inspection.taskList'],
    'inventory/detail': ['inventory.detail'],
    'inventory/management': ['inventory.list'],
    'inventory/product': ['product.list'],
    'inventory/search': ['inventory.search'],
    'inventory/tag': ['tag.list'],
    'message/detail': ['message.detail'],
    'message/list': ['message.list'],
    'stock/create': ['stockOrder.create'],
    'stock/detail': ['stockOrder.detail'],
    'stock/list': ['stockOrder.list'],
    'user/management': ['user.list'],
    'warehouse/management': ['warehouse.list'],
};

/** 一条迁移状态单元格。三态必须能一眼分开：全绿 / 有缺口（列出缺哪个）/ 全缺。 */
function migrationCell(entry, migrated) {
    if (!entry) {
        return '**未登记映射**（生成器的 LEGACY_SCREEN_MAP 缺这一项）';
    }
    if (entry.note) {
        return entry.note;
    }
    if (entry.outside) {
        return `已迁 · ${code(entry.file)}（${entry.outside}）`;
    }
    const need = entry.methods ?? [];
    const missing = need.filter((m) => !migrated.has(m));
    const where = entry.file ? code(entry.file) : '（未填新屏路径）';
    if (missing.length === 0) {
        return `已迁 · ${where}`;
    }
    if (missing.length === need.length) {
        return `待迁（需 ${missing.map(code).join(' / ')}）`;
    }
    return `部分迁 · ${where}（缺 ${missing.map(code).join(' / ')}）`;
}

function render() {
    const routes = readLegacyRoutes();
    const screens = readLegacyScreens();
    const methods = readBridgeMethods();
    const migrated = readRegistryMethods();

    const byDomain = new Map();
    for (const m of methods) {
        if (!byDomain.has(m.domain)) {
            byDomain.set(m.domain, []);
        }
        byDomain.get(m.domain).push(m);
    }
    const domains = [...byDomain.keys()].sort();

    const L = [];
    const push = (...xs) => L.push(...xs);

    push('# 功能对照清单（旧 APP → WiseDepotClient）');
    push('');
    push('> **本文件由 ' + code('tools/gen/gen-feature-parity.js') + ' 生成，禁止手改。**');
    push('> 重跑：' + code('pnpm gen:parity') + '；校验：' + code('pnpm gen:parity --check') + '。');
    push('> 「迁移状态」**不是人回填的**：它由 ' + code('apps/web/src/views/registry.ts') +
        ' 里已登记的桥方法机械推导。接一屏，状态自己变；没接，就一直显示缺口。');
    push('');
    push('## 0. 口径与来源');
    push('');
    push('| 项 | 数量 | 来源 |');
    push('| --- | --- | --- |');
    push(`| 旧 APP 屏文件（*Screen.kt） | ${screens.length} | 归档区全量扫描 |`);
    push(`| 旧 APP 路由 id（AppRoute.kt） | ${routes.length} | 归档区 ${code('AppRoute.kt')} |`);
    push(`| 桥方法（暴露给 Web） | ${methods.length} | ${code('packages/contract/src/generated/bridgeContract.ts')} |`);
    push('');
    push('说明：旧路由 id 是 19 条扁平目的地，新架构按四域重设计（见 ' + code('docs/architecture.md') +
        ' §信息架构），**不复用旧 NavFlags 语义**；因此下表是"功能归属"对照，不是"路由一一映射"。');
    push('');
    push('## 1. 旧屏清单');
    push('');
    push('| # | 屏文件 | 行数 | 新域 | 迁移状态 |');
    push('| --- | --- | --- | --- | --- |');
    screens.forEach((s, i) => {
        push(`| ${i + 1} | ${code(s.rel)} | ${s.lines} | ${domainOf(s.name.replace('Screen.kt', ''))} | ${
            migrationCell(LEGACY_SCREEN_MAP[s.name], migrated)} |`);
    });
    push('');
    push('## 2. 旧路由目录（AppRoute.kt）');
    push('');
    push('| # | 路由 id | 新域 | 迁移状态 |');
    push('| --- | --- | --- | --- |');
    routes.forEach((r, i) => {
        push(`| ${i + 1} | ${code(r)} | ${domainOf(r)} | ${migrationCell({ methods: ROUTE_MAP[r] }, migrated)} |`);
    });
    push('');
    push('## 3. 桥方法按域分布');
    push('');
    push('| 域 | 方法数 |');
    push('| --- | --- |');
    for (const d of domains) {
        push(`| ${d} | ${byDomain.get(d).length} |`);
    }
    push(`| **合计** | **${methods.length}** |`);
    push('');
    domains.forEach((d, i) => {
        push(`### 3.${i + 1} ${d}`);
        push('');
        push('| 方法 id | HTTP | 路径 | packet_type |');
        push('| --- | --- | --- | --- |');
        for (const m of byDomain.get(d).slice().sort((a, b) => a.id.localeCompare(b.id))) {
            push(`| ${code(m.id)} | ${m.httpMethod} | ${code(m.path)} | ${m.packetType} |`);
        }
        push('');
    });
    push('## 4. 需要在桥侧特殊处理的端点');
    push('');
    push('| 方法 | 原因 | 处置 |');
    push('| --- | --- | --- |');
    push(`| ${code('inspection.resultPdf')} | 返回 PDF 字节流，不是 JSON | 桥取回后落盘并换发一次性 URL，走带外 HTTP 下载，不进 WS 帧 |`);
    push(`| ${code('file.download')} | 同上（文件流） | 同上 |`);
    push(`| ${code('file.upload')} / ${code('oss.fileCreate')} / ${code('device.logUpload')} | 请求体是 multipart，且可能很大 | 由壳侧组装 multipart；Web 只传本地文件句柄或分片句柄 |`);
    push('');
    push('## 5. 刻意不暴露的端点（白名单的减法）');
    push('');
    push('| 方法 | 路径 | 原因 |');
    push('| --- | --- | --- |');
    push(`| ${code('auth.refreshToken')} | ${code('POST /api/auth/refresh-token')} | 刷新令牌由桥内部完成；令牌不得进入 JS 上下文 |`);
    push(`| ${code('health.minio')} | ${code('GET /api/health/minio')} | 运维接口，客户端无用 |`);
    push('');
    push('> 减法记在 ' + code('tools/gen/bridge-overlay.json') + ' 的 ' + code('hidden') +
        '，改动会出现在生成物的 ' + code('excluded') + ' 列表里，删不掉也藏不住。');
    push('');

    // ---- 5.1 参数走 query 的方法（服务端 @RequestParam 与桥的默认口径不一致）----
    const overlay = JSON.parse(fs.readFileSync(OVERLAY_JSON, 'utf8'));
    const queryReasons = Object.fromEntries(
        Object.entries(overlay.queryParams || {}).filter(([k]) => !k.startsWith('_')),
    );
    const queryStyle = methods.filter((m) => m.paramStyle === 'query' && ['POST', 'PUT', 'PATCH'].includes(m.httpMethod));
    push('## 5.1 参数必须走 query string 的方法（' + queryStyle.length + ' 条）');
    push('');
    push('这些端点的 HTTP 方法是 POST/PUT/PATCH，但服务端用 ' + code('@RequestParam') +
        ' 取值 —— 而 ' + code('@RequestParam') + ' **只认 query string，不认 JSON body**。');
    push('桥按 HTTP 方法一刀切发 body 的话，它们必然 400，界面上只表现为「点了没反应」。');
    push('因此契约表给它们标 ' + code("paramStyle: 'query'") + '：拼 query 且**不发 body**。');
    push('');
    push('| 方法 id | HTTP | 路径 | 服务端为什么只认 query |');
    push('| --- | --- | --- | --- |');
    for (const m of queryStyle) {
        push(`| ${code(m.id)} | ${m.httpMethod} | ${code(m.path)} | ${queryReasons[m.id] ?? '**缺原因说明**（overlay.queryParams）'} |`);
    }
    push('');
    push('> 这份清单**不是手抄的**：契约生成器直接扫服务端控制器的 ' + code('@RequestParam') +
        '，漏登记一条就构建失败（' + code('pnpm check:contract') + '）。');
    push('');

    // ---- 5.2 body 里必须同时带路径参数的方法 ----
    const bodyPathReasons = Object.fromEntries(
        Object.entries(overlay.bodyPathParams || {}).filter(([k]) => !k.startsWith('_')),
    );
    const bodyPathIds = Object.keys(bodyPathReasons);
    push('## 5.2 body 里必须同时带路径参数的方法（' + bodyPathIds.length + ' 条）');
    push('');
    if (bodyPathIds.length === 0) {
        push('（无）');
    } else {
        push('桥默认把路径参数从 body 里剔掉 —— 同一个值没必要发两遍。');
        push('但下列端点的服务端 DTO 把路径参数**又声明了一次**并加了 ' + code('@NotNull') +
            '，而控制器里的 ' + code('request.setXxx(路径参数)') + ' 在参数绑定**之后**才执行，');
        push('救不了 ' + code('@Valid') + '：客户端不把值放进 body 就必然校验失败（表现为「参数错误」）。');
        push('');
        push('| 方法 id | HTTP | 路径 | 服务端为什么要求两处都带 |');
        push('| --- | --- | --- | --- |');
        for (const id of bodyPathIds) {
            const m = methods.find((x) => x.id === id);
            push(`| ${code(id)} | ${m ? m.httpMethod : '?'} | ${code(m ? m.path : '?')} | ${bodyPathReasons[id]} |`);
        }
    }
    push('');

    // ---- 6. 迁移进度（机械统计，不是人写的汇报）----
    const bucket = { done: 0, partial: 0, todo: 0, other: 0 };
    const unmapped = [];
    for (const s of screens) {
        const entry = LEGACY_SCREEN_MAP[s.name];
        if (!entry) {
            unmapped.push(s.name);
            continue;
        }
        if (entry.note) {
            bucket.other += 1;
            continue;
        }
        if (entry.outside) {
            bucket.done += 1;
            continue;
        }
        const need = entry.methods ?? [];
        const missing = need.filter((m) => !migrated.has(m));
        if (missing.length === 0) {
            bucket.done += 1;
        } else if (missing.length === need.length) {
            bucket.todo += 1;
        } else {
            bucket.partial += 1;
        }
    }
    const routeMissing = routes.filter((r) => (ROUTE_MAP[r] ?? ['?']).some((m) => !migrated.has(m)));
    const unmappedRoutes = routes.filter((r) => !ROUTE_MAP[r]);

    push('## 6. 迁移进度（机械统计）');
    push('');
    push('| 口径 | 数量 |');
    push('| --- | --- |');
    push(`| 旧屏总数 | ${screens.length} |`);
    push(`| ├ 已迁（依赖的桥方法全部已登记） | ${bucket.done} |`);
    push(`| ├ 部分迁（新屏在了，但还有方法没接） | ${bucket.partial} |`);
    push(`| ├ 待迁（一个方法都没接） | ${bucket.todo} |`);
    push(`| └ 无对应物（壳能力 / 被取代） | ${bucket.other} |`);
    push(`| 旧路由已覆盖 | ${routes.length - routeMissing.length} / ${routes.length} |`);
    push(`| 已登记屏（registry 条目数） | ${migrated.size} |`);
    push('');
    if (unmapped.length === 0) {
        push('✓ 每一块旧屏都在 ' + code('LEGACY_SCREEN_MAP') + ' 里有归宿（含"无对应物"的说明），无遗漏。');
    } else {
        push('✗ **以下旧屏未登记归宿**（新增/改名旧屏后必须补 ' + code('LEGACY_SCREEN_MAP') + '）：');
        push('');
        for (const n of unmapped) {
            push(`- ${code(n)}`);
        }
    }
    if (unmappedRoutes.length > 0) {
        push('');
        push('✗ **以下旧路由未登记归宿**：' + unmappedRoutes.map(code).join(' / '));
    }
    push('');
    return L.join('\n');
}

const content = render();

if (MODE === 'check') {
    if (!fs.existsSync(OUT)) {
        console.error('✗ 缺少 docs/feature-parity.md，请先跑 `pnpm gen:parity`。');
        process.exit(1);
    }
    const cur = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    if (cur !== content) {
        console.error('✗ docs/feature-parity.md 与源码不一致，请重跑 `pnpm gen:parity`。');
        process.exit(1);
    }
    console.log('gen-feature-parity OK: 与归档区 + 契约生成物一致');
    process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, content, 'utf8');
console.log(`gen-feature-parity: 已写入 ${path.relative(CLIENT_ROOT, OUT).replace(/\\/g, '/')}`);

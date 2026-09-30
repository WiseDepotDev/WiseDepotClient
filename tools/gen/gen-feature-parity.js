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
        /\{ id: '([^']+)', domain: '([^']+)', httpMethod: '([^']+)', path: '([^']+)', packetType: '([^']+)', curated: (?:true|false) \}/g;
    return [...text.matchAll(re)].map((m) => ({
        id: m[1],
        domain: m[2],
        httpMethod: m[3],
        path: m[4],
        packetType: m[5],
    }));
}

function render() {
    const routes = readLegacyRoutes();
    const screens = readLegacyScreens();
    const methods = readBridgeMethods();

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
    push('> 「迁移状态」由 W5–W7 逐域推进时在验收记录里回填，本文件只固定"有哪些、归哪域"。');
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
        push(`| ${i + 1} | ${code(s.rel)} | ${s.lines} | ${domainOf(s.name.replace('Screen.kt', ''))} | 待迁（W5–W7） |`);
    });
    push('');
    push('## 2. 旧路由目录（AppRoute.kt）');
    push('');
    push('| # | 路由 id | 新域 | 迁移状态 |');
    push('| --- | --- | --- | --- |');
    routes.forEach((r, i) => {
        push(`| ${i + 1} | ${code(r)} | ${domainOf(r)} | 待迁（W5–W7） |`);
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
    push(`| ${code('captcha.generate')} | 响应含验证码图片 | 由桥落成 data URL / blob URL，Web 不直接背 base64 字符串 |`);
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

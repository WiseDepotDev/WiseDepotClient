#!/usr/bin/env node
/**
 * check-ui-language.js —— 界面文案与内联样式门禁。
 *
 * 为什么需要它：这两类问题**编译得过、渲染得出、测试全绿**，只有真机上人眼才看得见 ——
 * 而用户第一次装到手机上给的反馈恰好就是这两条：
 *   · "页面直接显示 inventory.list 与「W5–W7 逐域迁入」「令牌」这类开发内部文案，
 *     给人的感知是功能未完成 / 系统异常"；
 *   · 内联 `style={{ color: '#fff' }}` 绕开令牌，于是两套壳的观感悄悄分叉。
 *
 * 抓三类：
 *   1. **桥方法 id 泄漏到界面**：JSX 文本或文案属性里出现 `device.list` 这种契约 id；
 *   2. **开发黑话泄漏到界面**：令牌 / W5–W7 / 待迁 / 尚未实现 / undefined / NaN / bridge / WebSocket；
 *   3. **内联写死取值**：TSX 里出现 `#rrggbb` 或 `12px`（`check-css-vars` 只管 CSS，管不到这里）。
 *
 * 例外必须**显式标注**：在违规行或其上一行写 `ui-language-ok: 理由`，
 * 否则门禁失败。默许例外=规则失效，所以不提供配置文件级别的白名单。
 *
 * 扫描范围：packages/*\/src 与 apps/*\/src 下的 *.tsx（跳过 node_modules / dist / build）。
 *
 * 用法：
 *   node tools/check/check-ui-language.js
 *   node tools/check/check-ui-language.js --verbose   # 同时打印扫描文件数与比对的方法 id 数
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const SCAN_ROOTS = ['packages', 'apps'];
const SKIP_DIR = new Set(['node_modules', 'build', 'dist', 'generated', '.git', 'release', 'coverage']);

/** 例外标注。同一行或上一行出现即放行。 */
const EXEMPT_MARK = /ui-language-ok:\s*\S/;

/** 开发黑话：命中即失败（在界面文案里，它们对一个仓库操作员没有任何意义）。 */
const JARGON = [
    [/令牌/, '「令牌」是开发术语，用户看不懂'],
    [/\bW[5-9]\b|\bW1[0-2]\b/, '「W5–W7」是内部里程碑编号'],
    [/待迁|未迁入|尚未实现|开发中(?!的)/, '「待迁 / 尚未实现」等于告诉用户功能没做完'],
    [/\bbridge\b|桥接层|本地桥|本机桥|宿主进程/, '「bridge / 本地桥 / 宿主进程」是架构术语'],
    [/\bWebSocket\b|\bws:\/\//i, '「WebSocket / ws://」是协议术语'],
    [/\bundefined\b|\bNaN\b|\bnull\b/, '未取到值时不该把 JS 字面量渲染给用户'],
    [/\bHTTP\s?\d{3}\b|\b[A-Z]{3,}-\d{4}\b/, '错误码要翻成人话（见 shared/api.ts 的 humanize）'],
    [/\bscreenFor\b|\bprimaryMethod\b|\bregistry\b/, '注册表 / 路由内部名不该出现在界面'],
];

/** 内联写死取值：颜色与尺寸（0/1px/2px 与百分比、关键字放行）。 */
const ALLOWED_LITERAL_PX = new Set(['0px', '1px', '2px']);

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) {
        return out;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIR.has(e.name)) {
            continue;
        }
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            walk(p, out);
        } else if (e.name.endsWith('.tsx') && !e.name.endsWith('.d.tsx')) {
            out.push(p);
        }
    }
    return out;
}

/** 契约里的桥方法 id 全集 —— 界面上一旦出现，必是内部信息泄漏。 */
function readMethodIds() {
    if (!fs.existsSync(CONTRACT_TS)) {
        console.error('✗ 缺少 packages/contract/src/generated/bridgeContract.ts，请先跑 `pnpm gen:contract`。');
        process.exit(1);
    }
    const text = fs.readFileSync(CONTRACT_TS, 'utf8');
    return new Set([...text.matchAll(/\{ id: '([^']+)', domain:/g)].map((m) => m[1]));
}

/** 去掉注释，避免注释里的说明文字被当成界面文案。 */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** 偏移 → 行号（1 起）。 */
function lineAt(text, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i += 1) {
        if (text[i] === '\n') {
            line += 1;
        }
    }
    return line;
}

const COPY_PROPS =
    /\b(title|subtitle|label|placeholder|emptyText|confirmLabel|cancelLabel|message|description|hint|ariaLabel|tooltip|main|sub|brand|caption|note)\s*[:=]\s*(?:\{)?\s*['"`]([^'"`]*)['"`]/g;

/**
 * **绝不允许被送进"演示性属性"的标识符**。
 *
 * 为什么单独列出而不是靠上面的正则：`{leaf.primaryMethod}` 是 JSX **表达式**，
 * 不是文本节点、也不是字符串字面量，上面两条通道都抓不到它 —— 于是
 * DesktopShell 里那份 `main="占位行" sub={leaf.primaryMethod}` 的假数据
 * 躲过了本门禁，在真机上被用户一眼看见（`#0001 占位行 device.list`）。
 *
 * **只查演示性属性**（值会被直接画到屏幕上的那些）。不查任意 props：
 * `systematic` 地禁 `primaryMethod` 会误伤 `PageBody` 的
 * `notMigrated ? <NotMigratedScreen method={leaf.primaryMethod} />` ——
 * 那是把 id 传给组件、且只在 DEV 分支渲染，属于合法用法。
 * 正则分不清"这个 prop 会不会被渲染"，所以把范围限制在**确定会被渲染**的那一批。
 */
const NEVER_RENDER = ['primaryMethod'];
const RENDER_PROPS =
    'main|sub|title|subtitle|label|placeholder|emptyText|confirmLabel|message|caption|note|ariaLabel|brand';

const METHOD_IDS = readMethodIds();
const files = SCAN_ROOTS.flatMap((r) => walk(path.join(CLIENT_ROOT, r)));
let problems = 0;

function report(rel, line, message, snippet) {
    console.error(`✗ ${rel}:${line} ${message}\n    …${snippet.trim().slice(0, 120)}`);
    problems += 1;
}

for (const file of files) {
    const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
    const rawText = fs.readFileSync(file, 'utf8');
    const text = stripComments(rawText);
    const rawLines = rawText.split('\n');

    /** 该行是否被显式豁免（本行或上一行有标注）。 */
    const exempt = (line) =>
        EXEMPT_MARK.test(rawLines[line - 1] ?? '') || EXEMPT_MARK.test(rawLines[line - 2] ?? '');

    // 待检查的「界面可见文本」：JSX 文本子节点 + 文案属性值
    const candidates = [];

    // JSX 文本子节点：**必须真的是 `<标签>文本</标签>` 的形状**。
    //
    // 为什么不用宽松的 `>文本<`：那样会把「两个比较运算符之间恰好夹了中文字符串」的**代码**
    // 也当成文案。踩过一次：`useRef(new Map<string, HTMLDivElement>())` 附近的代码块
    // 被切出一段含中文的"文本"，报了 `undefined` —— 一个纯粹的误报，
    // 而误报会让门禁失去可信度（"反正它老报错"）。
    //
    // 配套取舍：只收含中日韩字符的。英文文案请走下面的文案属性通道
    // （title / label / ariaLabel …），那里是字符串字面量，判定是确定的。
    for (const m of text.matchAll(/<([A-Za-z][\w.]*)(?:\s[^<>]*)?>\s*([^<>{}]*[\u4e00-\u9fff][^<>{}]*?)\s*<\//g)) {
        candidates.push({ value: m[2], index: m.index });
    }
    // 文案属性
    for (const m of text.matchAll(COPY_PROPS)) {
        candidates.push({ value: m[2], index: m.index });
    }

    for (const c of candidates) {
        const line = lineAt(text, c.index);
        if (exempt(line)) {
            continue;
        }
        const value = c.value;

        // 1. 桥方法 id
        for (const id of METHOD_IDS) {
            if (value.includes(id)) {
                report(rel, line, `界面文案里出现了桥方法 id「${id}」`, value);
            }
        }

        // 2. 开发黑话
        for (const [re, why] of JARGON) {
            const hit = re.exec(value);
            if (hit) {
                report(rel, line, `${why}（命中「${hit[0]}」）`, value);
                break;
            }
        }
    }

    for (const id of NEVER_RENDER) {
        // (a) 作为演示性属性的表达式值：sub={leaf.primaryMethod}
        // (b) 作为 JSX 子表达式：<Mono>{leaf.primaryMethod}</Mono>
        const patterns = [
            new RegExp(`\\b(?:${RENDER_PROPS})\\s*=\\s*\\{[^}]*\\b${id}\\b[^}]*\\}`, 'g'),
            // 子表达式要求**整个表达式就是它**：`>{leaf.primaryMethod}<`。
            // 不能放宽成"表达式里出现它"——`{leaf.primaryMethod === 'auth.login' ? … }`
            // 是在做比较（MobileShell 就是这么用的），渲染出来的是布尔分支而不是 id。
            new RegExp(`<([A-Za-z][\\w.]*)(?:\\s[^<>]*)?>\\s*\\{\\s*[\\w.]*\\b${id}\\b\\s*\\}\\s*<\\/`, 'g'),
        ];
        for (const re of patterns) {
            for (const m of text.matchAll(re)) {
                const line = lineAt(text, m.index);
                if (exempt(line)) {
                    continue;
                }
                report(rel, line, `把内部元数据 ${id} 画到了界面上（用户看不懂，且会泄漏实现细节）`, m[0]);
            }
        }
    }

    // 3. 内联写死取值（整行扫描；JSX 里出现 hex/px 字面量基本只有 style 一种来源）
    text.split('\n').forEach((line, i) => {
        const lineNo = i + 1;
        if (exempt(lineNo) || EXEMPT_MARK.test(line)) {
            return;
        }
        // 只查「出现在 JSX 属性或对象字面量里的字符串」，排除 import/类型/注释
        for (const m of line.matchAll(/['"`]([^'"`]*)['"`]/g)) {
            const v = m[1];
            const hex = /\B#[0-9A-Fa-f]{3,8}\b/.exec(v);
            if (hex) {
                report(rel, lineNo, `内联写死了颜色 ${hex[0]}（应使用 --w-color-* 令牌类）`, line);
                continue;
            }
            const px = [...v.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px/g)].find(
                (p) => !ALLOWED_LITERAL_PX.has(`${p[1]}px`),
            );
            if (px) {
                report(rel, lineNo, `内联写死了尺寸 ${px[0]}（应使用 --w-dp-* / --w-space-* 令牌类）`, line);
            }
        }
    });
}

if (problems > 0) {
    console.error(`\ncheck-ui-language: 扫描 ${files.length} 个 TSX，发现 ${problems} 处问题。`);
    console.error('若确属例外，请在违规行或其上一行加注释：ui-language-ok: <理由>');
    process.exit(1);
}
const detail = process.argv.includes('--verbose')
    ? `，比对 ${METHOD_IDS.size} 个桥方法 id + ${JARGON.length} 条黑话规则`
    : '';
console.log(`check-ui-language OK: 扫描 ${files.length} 个 TSX${detail}，界面文案与内联样式合规`);

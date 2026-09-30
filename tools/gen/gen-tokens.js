#!/usr/bin/env node
/**
 * gen-tokens.js —— 把旧 Compose 主题的**取值**导出为 Web 设计令牌（W1 交付物）。
 *
 * 为什么要生成而不是重写一份：
 *   旧仓 `core/ui/theme/*` 已经过一次完整治理（P3-22/B1 建令牌层、P3-12 收口硬编码色），
 *   取值本身是有依据的（状态色文字变体的对比度读数都写在注释里）。
 *   如果 Web 侧手抄一份，第一周就会漂移；因此这里是**一次性导出 + 此后以 tokens.json 为准**。
 *
 * 输入（只读，全部在归档区）：
 *   Color.kt / WiseDColors.kt / Dimens.kt / Spacing.kt / Motion.kt / Elevations.kt / Shape.kt / Type.kt
 * 输出：
 *   packages/tokens/src/generated/tokens.json   机器可读的唯一来源
 *   packages/tokens/src/generated/tokens.css    CSS 变量（亮/暗 + 媒体查询）
 *   packages/tokens/src/generated/tokens.ts     类型化常量（数值给 JS 用，颜色给 var() 用）
 *
 * 用法：
 *   node tools/gen/gen-tokens.js            # 生成
 *   node tools/gen/gen-tokens.js --check    # 只校验（漂移即退出 1）
 *   node tools/gen/gen-tokens.js --report   # 只打印统计
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GEN_DIR = __dirname;
const CLIENT_ROOT = path.resolve(GEN_DIR, '..', '..');
const WORKSPACE_ROOT = path.resolve(CLIENT_ROOT, '..');
const THEME_DIR = path.join(
    WORKSPACE_ROOT, '.archive', 'wise-depot-android-refactor',
    'core', 'ui', 'src', 'main', 'java', 'com', 'huicang', 'wise', 'ui', 'theme');

const OUT_DIR = path.join(CLIENT_ROOT, 'packages', 'tokens', 'src', 'generated');
const OUT_JSON = path.join(OUT_DIR, 'tokens.json');
const OUT_CSS = path.join(OUT_DIR, 'tokens.css');
const OUT_TS = path.join(OUT_DIR, 'tokens.ts');

const MODE = process.argv.includes('--check') ? 'check'
    : process.argv.includes('--report') ? 'report' : 'write';

// ---------------------------------------------------------------- 读取

function readThemeFile(name) {
    const file = path.join(THEME_DIR, name);
    if (!fs.existsSync(file)) {
        throw new Error(`归档区找不到主题文件：${file}\n（归档是否被移动过？见 .archive/ARCHIVE.md）`);
    }
    return fs.readFileSync(file, 'utf8');
}

/** 去掉行注释与块注释（注释里大量出现 `Color(0x…)` 与 `N.dp` 的说明文字，必须清掉） */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------- 颜色

/** `Color(0xAARRGGBB)` → `#RRGGBB`（alpha 非 FF 时给 `#RRGGBBAA`） */
function composeColorToCss(hex) {
    const h = hex.replace(/^0x/i, '').toUpperCase().padStart(8, '0');
    const alpha = h.slice(0, 2);
    const rgb = h.slice(2);
    return alpha === 'FF' ? `#${rgb}` : `#${rgb}${alpha}`;
}

/** 解析 Color.kt：常量表 + 别名表（别名要能链式解析，如 md_theme_light_surfaceTint = WiseBBlue） */
function parseColorKt(src) {
    const text = stripComments(src);
    const consts = new Map();
    const aliases = new Map();

    for (const m of text.matchAll(/val\s+([A-Za-z_][\w]*)\s*=\s*Color\(0x([0-9A-Fa-f]{6,8})\)/g)) {
        consts.set(m[1], composeColorToCss(m[2]));
    }
    for (const m of text.matchAll(/val\s+([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\s*(?:\n|$)/g)) {
        aliases.set(m[1], m[2]);
    }

    const resolve = (name, seen = new Set()) => {
        if (consts.has(name)) {
            return consts.get(name);
        }
        if (aliases.has(name) && !seen.has(name)) {
            seen.add(name);
            return resolve(aliases.get(name), seen);
        }
        throw new Error(`颜色 ${name} 无法解析（既不是 Color(0x…) 也不是已定义的别名）`);
    };

    return { consts, aliases, resolve };
}

// ---------------------------------------------------------------- 尺寸 / 形状 / 动效

/** 解析 `val DpN = N.dp` */
function parseDimens(src) {
    const out = new Map();
    for (const m of stripComments(src).matchAll(/val\s+(Dp\d+)\s*=\s*(\d+)\.dp/g)) {
        out.set(m[1], Number(m[2]));
    }
    return out;
}

/** 解析语义间距：`val X = Dimens.DpN` */
function parseSpacing(src, dimens) {
    const out = new Map();
    for (const m of stripComments(src).matchAll(/val\s+([A-Za-z_][\w]*)\s*=\s*Dimens\.(Dp\d+)/g)) {
        const v = dimens.get(m[2]);
        if (v === undefined) {
            throw new Error(`Spacing.${m[1]} 引用了不存在的 ${m[2]}`);
        }
        out.set(m[1], v);
    }
    return out;
}

/** 解析 Elevations：`val List: Dp = 0.dp` / `val Card: Dp = 1.dp` / `val Overlay: Dp = Dimens.Dp6` */
function parseElevations(src, dimens) {
    const out = new Map();
    const text = stripComments(src);
    for (const m of text.matchAll(/val\s+([A-Za-z_][\w]*)\s*:\s*Dp\s*=\s*(?:(\d+)\.dp|Dimens\.(Dp\d+))/g)) {
        const v = m[2] !== undefined ? Number(m[2]) : dimens.get(m[3]);
        if (v === undefined) {
            throw new Error(`Elevations.${m[1]} 引用了不存在的 ${m[3]}`);
        }
        out.set(m[1], v);
    }
    return out;
}

/** 解析 Shapes(...) 与兼容别名 */
function parseShapes(src) {
    const named = new Map();
    const aliases = new Map();
    const text = stripComments(src);

    // 块结束是行首（缩进后）的 `)`，用「换行 + 缩进 + 右括号」定位，避免被内层 RoundedCornerShape(..) 的右括号截断
    const block = /Shapes\(([\s\S]*?)\n\s*\)/.exec(text);
    if (block) {
        for (const m of block[1].matchAll(/(\w+)\s*=\s*RoundedCornerShape\((\d+)\.dp\)/g)) {
            named.set(m[1], Number(m[2]));
        }
    }
    for (const m of text.matchAll(/val\s+([A-Za-z_][\w]*)\s*=\s*RoundedCornerShape\((\d+)\.dp\)/g)) {
        aliases.set(m[1], Number(m[2]));
    }
    return { named, aliases };
}

/** 解析 Motion：`const val FAST_MS: Int = 150` */
function parseMotion(src) {
    const out = new Map();
    for (const m of stripComments(src).matchAll(/const\s+val\s+([A-Z_]+)\s*:\s*Int\s*=\s*(\d+)/g)) {
        out.set(m[1], Number(m[2]));
    }
    return out;
}

/** 解析 Type.kt：每个 TextStyle 的 fontWeight/fontSize/lineHeight/letterSpacing */
const FONT_WEIGHTS = {
    Thin: 100, ExtraLight: 200, Light: 300, Normal: 400, Medium: 500,
    SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900,
};

function parseTypography(src) {
    const text = stripComments(src);
    const out = new Map();
    const styleRe = /(\w+)\s*=\s*TextStyle\(([\s\S]*?)\n\s*\)/g;
    for (const m of text.matchAll(styleRe)) {
        const body = m[2];
        const num = (re) => {
            const x = re.exec(body);
            return x ? Number(x[1]) : undefined;
        };
        const weight = /fontWeight\s*=\s*FontWeight\.(\w+)/.exec(body);
        out.set(m[1], {
            fontWeight: weight ? FONT_WEIGHTS[weight[1]] : 400,
            fontSize: num(/fontSize\s*=\s*(-?[\d.]+)\.sp/),
            lineHeight: num(/lineHeight\s*=\s*(-?[\d.]+)\.sp/),
            letterSpacing: num(/letterSpacing\s*=\s*\(?(-?[\d.]+)\)?\.sp/),
        });
    }
    return out;
}

/** 解析 WiseDColors 的亮/暗调色板：`slot = SomeColorConst` */
function parseWiseDPalette(src, resolveColor) {
    const text = stripComments(src);
    const read = (name) => {
        const re = new RegExp(`${name}\\s*=\\s*WiseDColorPalette\\(([\\s\\S]*?)\\n\\s*\\)`);
        const m = re.exec(text);
        if (!m) {
            throw new Error(`找不到 ${name} 调色板`);
        }
        const out = new Map();
        for (const g of m[1].matchAll(/(\w+)\s*=\s*([A-Za-z_][\w]*)/g)) {
            out.set(g[1], resolveColor(g[2]));
        }
        return out;
    };
    return { light: read('LightWiseDColors'), dark: read('DarkWiseDColors') };
}

// ---------------------------------------------------------------- 组装

/** camelCase / PascalCase → kebab-case */
function kebab(s) {
    return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function build() {
    const colorSrc = readThemeFile('Color.kt');
    const { consts, aliases, resolve } = parseColorKt(colorSrc);

    const dimens = parseDimens(readThemeFile('Dimens.kt'));
    const spacing = parseSpacing(readThemeFile('Spacing.kt'), dimens);
    const elevations = parseElevations(readThemeFile('Elevations.kt'), dimens);
    const shapes = parseShapes(readThemeFile('Shape.kt'));
    const motion = parseMotion(readThemeFile('Motion.kt'));
    const typography = parseTypography(readThemeFile('Type.kt'));
    const wiseD = parseWiseDPalette(readThemeFile('WiseDColors.kt'), resolve);

    // Material3 颜色槽位：md_theme_light_X / md_theme_dark_X
    // 注意要同时遍历别名表：`md_theme_light_primary = WiseBBlue` 这类槽位只出现在别名里
    const scheme = new Map();
    for (const name of [...consts.keys(), ...aliases.keys()]) {
        for (const m of [/^md_theme_light_(\w+)$/.exec(name), /^md_theme_dark_(\w+)$/.exec(name)]) {
            if (!m) {
                continue;
            }
            const key = m[1];
            if (!scheme.has(key)) {
                scheme.set(key, {});
            }
            scheme.get(key)[name.includes('_light_') ? 'light' : 'dark'] = resolve(name);
        }
    }
    for (const [key, v] of scheme) {
        if (!v.light || !v.dark) {
            throw new Error(`颜色槽位 ${key} 缺少亮色或暗色取值`);
        }
    }

    // 实体状态色（只保证"作底 + 白字"）与文字变体（对比度安全，随主题）
    const statusFills = {};
    for (const n of ['StatusGreen', 'StatusRed', 'StatusOrange', 'StatusAmber', 'StatusYellow', 'StatusBlue',
        'InfoContainerBlue', 'ErrorContainer', 'NeutralGray', 'SuccessColor', 'WarningColor', 'InfoColor', 'ErrorColor']) {
        if (consts.has(n)) {
            statusFills[n] = resolve(n);
        }
    }
    const accents = {};
    for (const n of ['AccentCoral', 'AccentTeal']) {
        if (consts.has(n)) {
            accents[n] = resolve(n);
        }
    }

    // 旧 iOS 命名调色板：**导出到 json 留档，但不生成 CSS 变量**
    // （旧仓纪律：业务层禁止直接引用 IOSSystem*）
    const legacy = {};
    for (const n of consts.keys()) {
        if (/^IOS/.test(n)) {
            legacy[n] = consts.get(n);
        }
    }

    return {
        source: 'WiseDepotApp/wise-depot-android-refactor/core/ui/src/main/java/com/huicang/wise/ui/theme',
        scheme: Object.fromEntries([...scheme.entries()].sort()),
        stateText: {
            light: Object.fromEntries(wiseD.light),
            dark: Object.fromEntries(wiseD.dark),
        },
        statusFills,
        accents,
        legacy,
        dimens: Object.fromEntries([...dimens.entries()].sort((a, b) => a[1] - b[1])),
        spacing: Object.fromEntries(spacing),
        radius: Object.fromEntries(shapes.named),
        radiusAliases: Object.fromEntries(shapes.aliases),
        elevation: Object.fromEntries(elevations),
        motion: Object.fromEntries(motion),
        typography: Object.fromEntries(typography),
    };
}

// ---------------------------------------------------------------- 渲染

/** 主题相关的 CSS 变量（同一批名字，亮/暗两组值） */
const THEMED_VARS = () => [
    ...Object.keys(buildCache.scheme).map((k) => [`color-${kebab(k)}`, buildCache.scheme[k].light, buildCache.scheme[k].dark]),
    ...Object.keys(buildCache.stateText.light).map((k) => [`state-${kebab(k)}`, buildCache.stateText.light[k], buildCache.stateText.dark[k]]),
];

let buildCache = null;

function renderCss(t) {
    buildCache = t;
    const L = [];
    const push = (...xs) => L.push(...xs);

    push('/* AUTO-GENERATED FROM .archive/.../core/ui/theme/*.kt — DO NOT EDIT');
    push(' * 生成器：WiseDepotClient/tools/gen/gen-tokens.js');
    push(' *');
    push(' * 1dp 在 CSS 里就是 1px（Compose 的 dp 是密度无关像素，Web 里等价物是 px 的默认缩放）。');
    push(' * 主题切换：优先跟系统；显式设置 [data-theme="light"|"dark"] 时以显式为准。');
    push(' */');
    push('');
    push(':root {');

    const themed = THEMED_VARS();
    for (const [name, light] of themed) {
        push(`  --w-${name}: ${light};`);
    }

    push('');
    push('  /* 状态**填充**色：只保证"作底 + 白字"的对比，不要拿来当文字色（当文字用 --w-state-*）。 */');
    for (const [k, v] of Object.entries(t.statusFills)) {
        push(`  --w-fill-${kebab(k)}: ${v};`);
    }
    for (const [k, v] of Object.entries(t.accents)) {
        push(`  --w-accent-${kebab(k)}: ${v};`);
    }

    push('');
    push('  /* 中性刻度（Dimens）：键名 Dp16 → --w-dp-16 */');
    for (const [k, v] of Object.entries(t.dimens)) {
        push(`  --w-dp-${k.replace(/^Dp/, '')}: ${v}px;`);
    }

    push('');
    push('  /* 语义间距（Spacing） */');
    for (const [k, v] of Object.entries(t.spacing)) {
        push(`  --w-space-${kebab(k)}: ${v}px;`);
    }

    push('');
    push('  /* 圆角（Shapes） */');
    for (const [k, v] of Object.entries(t.radius)) {
        push(`  --w-radius-${kebab(k)}: ${v}px;`);
    }

    push('');
    push('  /* 阴影刻度（Elevations：列表不用阴影，靠 1px 描边分层） */');
    for (const [k, v] of Object.entries(t.elevation)) {
        push(`  --w-elevation-${kebab(k)}: ${v}px;`);
    }

    push('');
    push('  /* 动效（只用于状态变化，不做装饰动画） */');
    for (const [k, v] of Object.entries(t.motion)) {
        push(`  --w-motion-${kebab(k).replace(/-ms$/, '')}: ${v}ms;`);
    }

    push('');
    push('  /* 字号/行高/字距/字重 */');
    for (const [k, v] of Object.entries(t.typography)) {
        push(`  --w-type-${kebab(k)}-size: ${v.fontSize}px;`);
        push(`  --w-type-${kebab(k)}-line: ${v.lineHeight}px;`);
        push(`  --w-type-${kebab(k)}-tracking: ${v.letterSpacing}px;`);
        push(`  --w-type-${kebab(k)}-weight: ${v.fontWeight};`);
    }
    push('}');
    push('');

    push('[data-theme="dark"] {');
    for (const [name, , dark] of themed) {
        push(`  --w-${name}: ${dark};`);
    }
    push('}');
    push('');
    push('@media (prefers-color-scheme: dark) {');
    push('  :root:not([data-theme="light"]) {');
    for (const [name, , dark] of themed) {
        push(`    --w-${name}: ${dark};`);
    }
    push('  }');
    push('}');
    push('');
    push('/* 触控与布局下界（来自旧仓 Spacing.TouchTargetMin 与三档断点） */');
    push(':root {');
    push(`  --w-touch-target-min: ${t.spacing.TouchTargetMin}px;`);
    push(`  --w-breakpoint-compact-max: ${t.dimens.Dp600 - 1}px;`);
    push(`  --w-breakpoint-medium-max: ${t.dimens.Dp840 - 1}px;`);
    push(`  --w-content-max-width: ${t.dimens.Dp720}px;`);
    push('}');
    push('');
    return L.join('\n');
}

function renderTs(t) {
    const L = [];
    const push = (...xs) => L.push(...xs);
    const q = (s) => `'${s}'`;

    push('// AUTO-GENERATED FROM .archive/.../core/ui/theme/*.kt — DO NOT EDIT');
    push('// 生成器：WiseDepotClient/tools/gen/gen-tokens.js');
    push('//');
    push('// 颜色一律给出 CSS 变量引用（var(--w-…)）——亮/暗切换由 CSS 层负责，JS 不需要知道主题。');
    push('// 数值型令牌（间距/圆角/字号）同时给出 px 数字，供 canvas、打印、虚拟滚动计算使用。');
    push('');
    push(`export const TOKEN_SOURCE = ${q(t.source)};`);
    push('');
    push('/** 令牌对应的 CSS 变量名（需要动态拼变量时用）。 */');
    push('export const CSS_VAR = {');
    push('  color: {');
    for (const k of Object.keys(t.scheme)) {
        push(`    ${k}: ${q(`--w-color-${kebab(k)}`)},`);
    }
    push('  },');
    push('  state: {');
    for (const k of Object.keys(t.stateText.light)) {
        push(`    ${k}: ${q(`--w-state-${kebab(k)}`)},`);
    }
    push('  },');
    push('  fill: {');
    for (const k of Object.keys(t.statusFills)) {
        push(`    ${k}: ${q(`--w-fill-${kebab(k)}`)},`);
    }
    push('  },');
    push('} as const;');
    push('');
    push('/** 颜色令牌的 var() 引用。用法：`style={{ color: color.state.dangerText }}`。 */');
    push('export const color = {');
    push('  scheme: {');
    for (const k of Object.keys(t.scheme)) {
        push(`    ${k}: ${q(`var(--w-color-${kebab(k)})`)},`);
    }
    push('  },');
    push('  state: {');
    for (const k of Object.keys(t.stateText.light)) {
        push(`    ${k}: ${q(`var(--w-state-${kebab(k)})`)},`);
    }
    push('  },');
    push('  fill: {');
    for (const k of Object.keys(t.statusFills)) {
        push(`    ${k}: ${q(`var(--w-fill-${kebab(k)})`)},`);
    }
    push('  },');
    push('  accent: {');
    for (const k of Object.keys(t.accents)) {
        push(`    ${k}: ${q(`var(--w-accent-${kebab(k)})`)},`);
    }
    push('  },');
    push('} as const;');
    push('');
    push(`export const space = ${JSON.stringify(t.spacing, null, 2)} as const;`);
    push('');
    push(`export const radius = ${JSON.stringify(t.radius, null, 2)} as const;`);
    push('');
    push(`export const elevation = ${JSON.stringify(t.elevation, null, 2)} as const;`);
    push('');
    push('export const motion = {');
    for (const [k, v] of Object.entries(t.motion)) {
        push(`  ${k.replace(/_MS$/, '')}: ${v},`);
    }
    push('} as const;');
    push('');
    push('export const type = {');
    for (const [k, v] of Object.entries(t.typography)) {
        push(`  ${k}: { fontSize: ${v.fontSize}, lineHeight: ${v.lineHeight}, letterSpacing: ${v.letterSpacing}, fontWeight: ${v.fontWeight} },`);
    }
    push('} as const;');
    push('');
    push(`export const breakpoint = { compactMax: ${t.dimens.Dp600 - 1}, mediumMax: ${t.dimens.Dp840 - 1}, contentMaxWidth: ${t.dimens.Dp720}, touchTargetMin: ${t.spacing.TouchTargetMin} } as const;`);
    push('');
    push('/** 亮色绝对值（canvas / 打印 / 单测用；常规组件请用 var() 引用）。 */');
    push('export const rawColor = {');
    push('  scheme: {');
    for (const [k, v] of Object.entries(t.scheme)) {
        push(`    ${k}: ${q(v.light)},`);
    }
    push('  },');
    push('  darkScheme: {');
    for (const [k, v] of Object.entries(t.scheme)) {
        push(`    ${k}: ${q(v.dark)},`);
    }
    push('  },');
    push('  stateText: {');
    for (const [k, v] of Object.entries(t.stateText.light)) {
        push(`    ${k}: ${q(v)},`);
    }
    push('  },');
    push('  darkStateText: {');
    for (const [k, v] of Object.entries(t.stateText.dark)) {
        push(`    ${k}: ${q(v)},`);
    }
    push('  },');
    push('} as const;');
    push('');
    return L.join('\n');
}

// ---------------------------------------------------------------- 主流程

function main() {
    if (!fs.existsSync(THEME_DIR)) {
        console.error(`找不到主题目录：${THEME_DIR}`);
        process.exit(1);
    }

    const tokens = build();
    const json = JSON.stringify(tokens, null, 2) + '\n';
    const css = renderCss(tokens);
    const ts = renderTs(tokens);

    if (MODE === 'report') {
        console.log(`颜色槽位 ${Object.keys(tokens.scheme).length}（亮/暗各一套）`);
        console.log(`状态语义色 ${Object.keys(tokens.stateText.light).length}（随主题）`);
        console.log(`中性刻度 ${Object.keys(tokens.dimens).length} / 语义间距 ${Object.keys(tokens.spacing).length} / 圆角 ${Object.keys(tokens.radius).length}`);
        console.log(`字号档 ${Object.keys(tokens.typography).length}；旧 iOS 调色板 ${Object.keys(tokens.legacy).length}（仅留档，不生成 CSS）`);
        return;
    }

    if (MODE === 'check') {
        let ok = true;
        for (const [file, want, label] of [[OUT_JSON, json, 'tokens.json'], [OUT_CSS, css, 'tokens.css'], [OUT_TS, ts, 'tokens.ts']]) {
            if (!fs.existsSync(file)) {
                console.error(`✗ 缺少生成物（${label}）：${path.relative(CLIENT_ROOT, file)}`);
                ok = false;
                continue;
            }
            if (fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== want) {
                console.error(`✗ 生成物与主题源码不一致（${label}）：${path.relative(CLIENT_ROOT, file)}`);
                ok = false;
            }
        }
        if (ok) {
            console.log(`gen-tokens OK: 颜色槽位 ${Object.keys(tokens.scheme).length} / 状态色 ${Object.keys(tokens.stateText.light).length} / 刻度 ${Object.keys(tokens.dimens).length} / 字号 ${Object.keys(tokens.typography).length}`);
        }
        process.exit(ok ? 0 : 1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_JSON, json, 'utf8');
    fs.writeFileSync(OUT_CSS, css, 'utf8');
    fs.writeFileSync(OUT_TS, ts, 'utf8');
    console.log('gen-tokens: 已写入');
    for (const f of [OUT_JSON, OUT_CSS, OUT_TS]) {
        console.log(`  ${path.relative(CLIENT_ROOT, f).replace(/\\/g, '/')}`);
    }
    console.log(`  颜色槽位 ${Object.keys(tokens.scheme).length} / 状态色 ${Object.keys(tokens.stateText.light).length} / 刻度 ${Object.keys(tokens.dimens).length} / 语义间距 ${Object.keys(tokens.spacing).length} / 圆角 ${Object.keys(tokens.radius).length} / 字号 ${Object.keys(tokens.typography).length}`);
}

main();

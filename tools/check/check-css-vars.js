#!/usr/bin/env node
/**
 * check-css-vars.js —— 令牌使用门禁。
 *
 * 抓两类错误，它们都不会被 TypeScript 或构建发现，只会在运行时表现为"样式没生效"：
 *   1. **引用了不存在的令牌**：`var(--w-space-RowGap)` 写错一个字母，页面只是悄悄变难看；
 *   2. **绕开令牌写死取值**：业务 CSS 里出现 hex 或字面量 px —— 这正是旧仓花了几十批
 *      才收干净的东西（764 处 colorScheme / 709 处 Dimens），Web 侧不能重犯。
 *
 * 扫描范围：packages/ 与 apps/ 下的 *.css（不含生成的 tokens.css 自身）。
 *
 * 用法：
 *   node tools/check/check-css-vars.js          # 校验，发现问题退出 1
 *   node tools/check/check-css-vars.js --list   # 同时列出已定义的令牌名
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const TOKENS_CSS = path.join(CLIENT_ROOT, 'packages', 'tokens', 'src', 'generated', 'tokens.css');
const SCAN_ROOTS = ['packages', 'apps'];
const SKIP_DIR = new Set(['node_modules', 'build', 'dist', 'generated', '.git', 'release']);

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
        } else if (e.name.endsWith('.css')) {
            out.push(p);
        }
    }
    return out;
}

if (!fs.existsSync(TOKENS_CSS)) {
    console.error('✗ 缺少 tokens.css，请先跑 `pnpm gen:tokens`。');
    process.exit(1);
}

const tokenCss = fs.readFileSync(TOKENS_CSS, 'utf8');
const defined = new Set([...tokenCss.matchAll(/^\s*(--w-[a-z0-9-]+):/gm)].map((m) => m[1]));

// 允许写死取值的例外：0 与 1px 边框、百分比、以及关键字
const ALLOWED_LITERAL_PX = new Set(['0', '1px', '2px']);

const files = SCAN_ROOTS.flatMap((r) => walk(path.join(CLIENT_ROOT, r)));
let problems = 0;

for (const file of files) {
    const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
        const where = `${rel}:${i + 1}`;

        for (const m of line.matchAll(/var\((--w-[a-z0-9-]+)/g)) {
            if (!defined.has(m[1])) {
                console.error(`✗ ${where} 引用了未定义的令牌 ${m[1]}`);
                problems += 1;
            }
        }

        // 属性行上的字面量取值（跳过 var() 与 @media 断点）
        const decl = /^\s*[a-z-]+\s*:\s*([^;]+);/.exec(line);
        if (decl && !line.includes('var(--w-') && !line.trim().startsWith('/*') && !line.includes('@media')) {
            const value = decl[1];
            const hex = /\B#[0-9A-Fa-f]{3,8}\b/.exec(value);
            if (hex) {
                console.error(`✗ ${where} 写死了颜色 ${hex[0]}（应使用 var(--w-color-…)）`);
                problems += 1;
            }
            for (const px of value.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px/g)) {
                if (!ALLOWED_LITERAL_PX.has(`${px[1]}px`)) {
                    console.error(`✗ ${where} 写死了尺寸 ${px[0]}（应使用 var(--w-dp-…) 或 var(--w-space-…)）`);
                    problems += 1;
                }
            }
        }
    });
}

if (process.argv.includes('--list')) {
    console.log(`已定义令牌 ${defined.size} 个：`);
    for (const t of [...defined].sort()) {
        console.log(`  ${t}`);
    }
}

const scanned = files.length;
if (problems > 0) {
    console.error(`check-css-vars: 扫描 ${scanned} 个 CSS 文件，发现 ${problems} 处问题。`);
    process.exit(1);
}
console.log(`check-css-vars OK: 扫描 ${scanned} 个 CSS 文件，令牌定义 ${defined.size} 个，无未定义引用、无写死取值`);

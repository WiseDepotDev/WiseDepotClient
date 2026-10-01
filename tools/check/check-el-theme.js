#!/usr/bin/env node
/**
 * check-el-theme.js —— Element Plus 主题接入纪律。
 *
 * 抓三类**构建不会发现、只会在界面里表现为"颜色不对"**的问题：
 *
 * 1. **组件里写死颜色**：EP 的主题是 CSS 变量，但组件里一旦写 `#087C75`，
 *    换主题时就漏了这一处。所以 `.vue` / `.ts` 里的颜色字面量必须在这里拦下；
 *    唯一允许出现颜色的地方是生成物（由 `theme.json` 生成，不是手写）。
 *
 * 2. **主题覆盖缺键**：EP 的悬停/禁用/浅底都用 `--el-*-light-3/5/7/8/9` 这几档，
 *    少覆盖一档就会在那个位置漏出 **EP 默认蓝**（这与早期 Naive 时代
 *    "只覆盖 primary 漏 40 处默认色"是同一类问题）。
 *
 * 3. **浅色档单调性**：`light-3` 必须比 `light-9` 深。生成器第一版把比例写反了，
 *    悬停态与浅底全部倒过来 —— 不会报错，只会"看起来怪"。这里用颜色亮度断言钉住。
 *
 * 用法：node tools/check/check-el-theme.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['packages/ui/src', 'packages/layouts/src', 'packages/views/src', 'apps/web/src'];
const SCAN_EXT = new Set(['.vue', '.ts']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', 'spike', 'smoke']);
const THEME_FILE = path.join(CLIENT_ROOT, 'packages/tokens', 'src', 'generated', 'theme.el.css');

/** 必需覆盖键（每条都对应一种视觉状态，不是凭感觉列的）。 */
const REQUIRED_KEYS = [
  '--el-color-primary',
  '--el-color-primary-light-3',
  '--el-color-primary-light-5',
  '--el-color-primary-light-7',
  '--el-color-primary-light-8',
  '--el-color-primary-light-9',
  '--el-color-primary-dark-2',
  '--el-color-success',
  '--el-color-success-light-9',
  '--el-color-warning',
  '--el-color-warning-light-9',
  '--el-color-danger',
  '--el-color-danger-light-9',
  '--el-color-error',
  '--el-color-error-light-9',
  '--el-color-info',
  '--el-color-info-light-9',
  '--el-text-color-primary',
  '--el-text-color-regular',
  '--el-text-color-secondary',
  '--el-text-color-placeholder',
  '--el-border-color',
  '--el-border-color-light',
  '--el-bg-color',
  '--el-bg-color-page',
  '--el-bg-color-overlay',
  '--el-fill-color-light',
  '--el-fill-color-blank',
  '--el-border-radius-base',
  '--el-border-radius-small',
  '--el-font-family',
  '--el-font-size-base',
  // 触控目标：EP 默认 large 是 40px，低于现场要求的 48px
  '--el-component-size-large',
];

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
    } else if (SCAN_EXT.has(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

const luminance = (hex) => {
  const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
};

let problems = 0;

// ---- 1. 组件里不许写颜色 ----
const files = SCAN_ROOTS.flatMap((r) => walk(path.join(CLIENT_ROOT, r)));
let scanned = 0;
for (const file of files) {
  const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
  scanned += 1;
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      return;
    }
    const hex = /\B#[0-9A-Fa-f]{3,8}\b/.exec(line);
    if (hex) {
      console.error(`✗ ${rel}:${i + 1} 出现颜色字面量 ${hex[0]} —— 必须走令牌（theme.json → theme.el.css）`);
      problems += 1;
    }
  });
}

// ---- 2. 必需覆盖键 ----
if (!fs.existsSync(THEME_FILE)) {
  console.error('✗ 缺少 packages/tokens/src/generated/theme.el.css，请先跑 `pnpm gen:theme`。');
  process.exit(1);
}
const themeCss = fs.readFileSync(THEME_FILE, 'utf8');
const defined = new Map();
for (const m of themeCss.matchAll(/^\s*(--el-[a-z0-9-]+):\s*([^;]+);/gm)) {
  defined.set(m[1], m[2].trim());
}
for (const key of REQUIRED_KEYS) {
  if (!defined.has(key)) {
    console.error(`✗ 主题缺少必需覆盖键 ${key}（EP 会在对应状态漏出默认色）`);
    problems += 1;
  }
}

// ---- 3. 浅色档单调性 ----
for (const family of ['primary', 'success', 'warning', 'danger', 'info']) {
  const shades = [3, 5, 7, 9]
    .map((n) => ({ n, value: defined.get(`--el-color-${family}-light-${n}`) }))
    .filter((x) => typeof x.value === 'string' && x.value.startsWith('#'));
  for (let i = 1; i < shades.length; i += 1) {
    const prev = shades[i - 1];
    const cur = shades[i];
    if (luminance(prev.value) >= luminance(cur.value)) {
      console.error(
        `✗ ${family} 的浅色档不单调：light-${prev.n}(${prev.value}) 不比 light-${cur.n}(${cur.value}) 深 —— 悬停/浅底会看起来反的`,
      );
      problems += 1;
    }
  }
}

if (problems > 0) {
  console.error(`check-el-theme: 扫描 ${scanned} 个文件，发现 ${problems} 处问题。`);
  process.exit(1);
}
console.log(
  `check-el-theme OK: 扫描 ${scanned} 个文件无颜色字面量；--el-* 覆盖键 ${REQUIRED_KEYS.length} 项齐全、浅色档单调`,
);

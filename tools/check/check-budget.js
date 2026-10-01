#!/usr/bin/env node
/**
 * check-budget.js —— 首屏体积门禁（**按实测重新标定的口径**）。
 *
 * ## 为什么口径变了
 *
 * 旧预算是"首屏 JS ≤250KB gzip"，那是 React + 手写组件的时代定的。
 * Spike C（docs/superpowers/plans/2026-10-02-v1-spikes.md）实测：
 *   vue+router+pinia 33.1KB · 登录最小集 88.8KB · +DataTable 75.8KB · +Select+DatePicker 70.5KB
 *   · 列表页 204.7KB · 列表页+双壳 217KB
 * 也就是说 250KB 这个总数**一个列表页就快用光了**。所以拆成两条：
 *
 *   ① 首屏（index.html 直接引到的资源）≤ 150KB gzip   —— 实测登录路由 ≈127KB
 *   ② 任一 chunk ≤ 130KB gzip                        —— 实测列表页增量 115.9KB
 *
 * ## "首屏必须是首屏"
 *
 * 这条门禁的另一半作用是**逼出路由级懒加载**：如果谁把列表页静态 import 进入口，
 * ①就会立刻爆。这是有意的 —— 它把"别忘了懒加载"从口头约定变成构建失败。
 *
 * 用法：pnpm build && node tools/check/check-budget.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(CLIENT_ROOT, 'apps', 'web', 'dist');
const FIRST_SCREEN_LIMIT_KB = 150;
const CHUNK_LIMIT_KB = 130;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('✗ 找不到 apps/web/dist/index.html，请先跑 `pnpm build`。');
  process.exit(1);
}

const gzipKb = (file) => zlib.gzipSync(fs.readFileSync(file)).length / 1024;

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

/** index.html 直接引到的资源就是首屏（Vite 会把入口依赖写成 modulepreload / stylesheet）。 */
const refs = new Set();
for (const m of html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)) {
  refs.add(m[1]);
}

let problems = 0;

const firstScreen = [...refs]
  .map((rel) => ({ rel, kb: gzipKb(path.join(DIST, rel)) }))
  .sort((a, b) => b.kb - a.kb);
const firstTotal = firstScreen.reduce((a, b) => a + b.kb, 0);

console.log('首屏资源（index.html 直接引用）：');
for (const f of firstScreen) {
  console.log(`  ${f.rel.padEnd(46)} ${f.kb.toFixed(1).padStart(7)} KB gzip`);
}
console.log(`  合计 ${firstTotal.toFixed(1)} KB gzip（上限 ${FIRST_SCREEN_LIMIT_KB}）`);

if (firstTotal > FIRST_SCREEN_LIMIT_KB) {
  console.error(
    `✗ 首屏 ${firstTotal.toFixed(1)}KB 超过 ${FIRST_SCREEN_LIMIT_KB}KB —— 检查是否有路由忘了写成动态 import。`,
  );
  problems += 1;
}

/*
 * 首屏不许出现 DataTable / DatePicker 的样式片段。
 *
 * 这是个**启发式**：naive-ui 的样式由 css-render 以字符串形式打进 JS，
 * 类名（`.n-data-table` / `.n-date-panel`）会原样出现在包里。
 * 它可能漏判，但不会误伤 —— 只要这两串没出现，就确实没把它们打进首屏。
 */
const firstJs = firstScreen.filter((f) => f.rel.endsWith('.js')).map((f) => path.join(DIST, f.rel));
const firstText = firstJs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
for (const marker of ['n-data-table', 'n-date-panel', 'n-date-picker']) {
  if (firstText.includes(marker)) {
    console.error(`✗ 首屏 JS 里出现 ${marker} —— DataTable / DatePicker 必须留在懒加载路由里`);
    problems += 1;
  }
}

const assetsDir = path.join(DIST, 'assets');
const chunks = fs
  .readdirSync(assetsDir)
  .filter((n) => n.endsWith('.js'))
  .map((n) => ({ rel: `assets/${n}`, kb: gzipKb(path.join(assetsDir, n)) }))
  .sort((a, b) => b.kb - a.kb);

console.log('\n全部 JS chunk：');
for (const c of chunks) {
  const flag = c.kb > CHUNK_LIMIT_KB ? ' ✗' : '';
  console.log(`  ${c.rel.padEnd(46)} ${c.kb.toFixed(1).padStart(7)} KB gzip${flag}`);
  if (c.kb > CHUNK_LIMIT_KB) {
    problems += 1;
  }
}

if (problems > 0) {
  console.error(`check-budget: 发现 ${problems} 处超限。`);
  process.exit(1);
}
console.log(
  `check-budget OK: 首屏 ${firstTotal.toFixed(1)}KB ≤ ${FIRST_SCREEN_LIMIT_KB}KB；` +
    `${chunks.length} 个 chunk 全部 ≤ ${CHUNK_LIMIT_KB}KB；首屏无 DataTable/DatePicker`,
);

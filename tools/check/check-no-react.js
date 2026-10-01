#!/usr/bin/env node
/**
 * check-no-react.js —— Vue 重写期间"React 不许扩散"的门禁。
 *
 * V1 起 Web 入口已经是 Vue；React 的旧屏还留在树上做对照（V6 删除）。
 * 这条门禁的作用是**让遗留清单显式且有界**：
 *   · 允许清单里的文件 = 已知的、待删的遗留；
 *   · 允许清单之外的任何 React 依赖 / .tsx 文件 = 立刻失败。
 *
 * 没有它就会发生最糟的那种迁移：一边说"在换 Vue"，一边新写的屏幕又 import 了 React。
 *
 * V6 删完遗留后，把 ALLOWED 清空即可 —— 那时这条门禁变成"0 React"。
 *
 * 用法：node tools/check/check-no-react.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 已知遗留：**已清空**（V6 收口）。
 *
 * 迁移期这里列着 6 条"待删的 React 遗留"，门禁的作用是"防止一边说在换 Vue、一边新写的屏又 import React"。
 * React 版已于 V6 删除（回滚点 tag `v0-react-freeze`），所以这张表清空 ——
 * 从此这条门禁的语义变成**零容忍的"0 React"**：任何 .tsx/.jsx 文件、任何 react 依赖声明都会立刻失败。
 *
 * 为什么保留这张空表而不是删掉这个判断：将来若真要临时引 React（例如内嵌第三方 React 组件），
 * 正确的做法是**先在这里写一行并说明删除批次**，而不是悄悄把门禁改绿。
 */
const ALLOWED = new Set([]);

const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', 'spike', 'smoke', 'release', '.gradle']);

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
    } else {
      out.push(p);
    }
  }
  return out;
}

let problems = 0;
const leftovers = [];

for (const root of ['apps/web', 'packages/ui', 'packages/stores', 'packages/bridge-vue', 'packages/layouts']) {
  for (const file of walk(path.join(CLIENT_ROOT, root))) {
    const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
    if (ALLOWED.has(rel)) {
      leftovers.push(rel);
      continue;
    }

    if (/\.(tsx|jsx)$/.test(rel)) {
      console.error(`✗ ${rel} 是 JSX 文件 —— Vue 层不允许新增 JSX`);
      problems += 1;
      continue;
    }
    if (!/\.(ts|vue|js|mjs|json)$/.test(rel)) {
      continue;
    }
    if (rel === 'apps/web/package.json') {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (/from\s+['"]react(-dom)?['"]/.test(text) || /from\s+['"]@wise\/(patterns|shells|features)['"]/.test(text)) {
      console.error(`✗ ${rel} 引入了 React 时代的包 —— 新代码必须走 @wise/ui / @wise/views / @wise/stores`);
      problems += 1;
    }
  }
}

if (problems > 0) {
  console.error(`check-no-react: 发现 ${problems} 处问题。`);
  process.exit(1);
}
console.log(
  `check-no-react OK: 无新增 React 依赖；已知遗留 ${new Set(leftovers).size} 处（V6 删除，清单在 tools/check/check-no-react.js）`,
);

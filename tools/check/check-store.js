#!/usr/bin/env node
/**
 * check-store.js —— 分层纪律：**组件不许直接碰桥**。
 *
 * 两条规则的来源是设计稿决策 D3（Pinia 是客户端状态的唯一所有者）：
 *
 * 1. `.vue` / `packages/ui` 里出现 `bridge.call(`：说明这一屏自己取了数，
 *    于是缓存、去重、重连重取全都不生效 —— React 时代正是这样长出 25 份取数逻辑的。
 *    取数只能经 `useResource` / 资源 store。
 *
 * 2. `packages/ui` import `@wise/bridge-client` / `@wise/stores`：
 *    设计系统一旦认识数据层，"组件库"就变成了"业务库"，25 个屏的复用就失效了。
 *    `@wise/ui` 只认识结构类型（`UiError` 等）。
 *
 * 用法：node tools/check/check-store.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const UI_ROOT = path.join(CLIENT_ROOT, 'packages', 'ui');
const LAYOUTS_ROOT = path.join(CLIENT_ROOT, 'packages', 'layouts');
const APP_SRC = path.join(CLIENT_ROOT, 'apps', 'web', 'src');
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', 'spike', 'smoke']);
const DATA_LAYER_IMPORTS = ["@wise/bridge-client", "@wise/stores"];

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
let scanned = 0;

// 规则 1：组件里不许直接调桥
for (const file of [...walk(UI_ROOT), ...walk(LAYOUTS_ROOT), ...walk(APP_SRC)]) {
  if (!file.endsWith('.vue')) {
    continue;
  }
  scanned += 1;
  const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (/\bbridge\s*\.\s*call\s*\(/.test(line) || /\bbridgeStore\s*\.\s*call\s*\(/.test(line)) {
      console.error(`✗ ${rel}:${i + 1} 组件里直接调桥 —— 取数要走 useResource / 资源 store`);
      problems += 1;
    }
  });
}

// 规则 2：设计系统不认识数据层
for (const file of walk(UI_ROOT)) {
  if (!/\.(ts|vue)$/.test(file)) {
    continue;
  }
  const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  for (const dep of DATA_LAYER_IMPORTS) {
    if (new RegExp(`from\\s+['"]${dep.replace(/[/@]/g, '\\$&')}`).test(text)) {
      console.error(`✗ ${rel} import 了 ${dep} —— @wise/ui 必须与数据层解耦`);
      problems += 1;
    }
  }
}

/**
 * 迁移期的**副本不许漂移**。
 *
 * `stockOrderState.ts` / `inspectionState.ts` 是纯业务规则（类型/状态归一化 + 状态流转），没有框架依赖，
 * 所以 Vue 版是**逐字节拷贝**过来的。两份并存期间，任何一方被改动而另一方没跟上，
 * 就会出现"同一个单据/任务在两个壳里状态不一样"—— 而 `check:stockorder` 只盯着 React 那份。
 * 这里把它们钉成一致；React 版删除（V6）后这条自动失效。
 */
const RULE_PAIRS = [
  ['packages/features/src/inventory/stockOrderState.ts', 'apps/web/src/views/inventory/stockOrderState.ts'],
  ['packages/features/src/field/inspectionState.ts', 'apps/web/src/views/field/inspectionState.ts'],
];
for (const [a, b] of RULE_PAIRS) {
  const pa = path.join(CLIENT_ROOT, a);
  const pb = path.join(CLIENT_ROOT, b);
  if (!fs.existsSync(pa) || !fs.existsSync(pb)) {
    continue; // 任一侧已被删除（V6 收尾），不再要求一致
  }
  if (!fs.readFileSync(pa).equals(fs.readFileSync(pb))) {
    console.error(`✗ ${a} 与 ${b} 内容不一致 —— 纯规则模块的副本必须逐字节相同`);
    problems += 1;
  }
}

if (problems > 0) {
  console.error(`check-store: 扫描 ${scanned} 个 .vue，发现 ${problems} 处问题。`);
  process.exit(1);
}
console.log(`check-store OK: 扫描 ${scanned} 个 .vue，无组件直连桥；@wise/ui 未依赖数据层`);

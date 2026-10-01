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

/*
 * V6 收口：「两份副本不许漂移」这条规则**已退役**（不是被删掉，而是它守的对象没有了）。
 *
 * 迁移期 `stockOrderState.ts` / `inspectionState.ts` 在 React 与 Vue 各存一份（纯规则、无框架依赖），
 * 靠逐字节比对防止"同一个单据/任务在两个壳里判定不一样"。React 版已删（回滚点 tag `v0-react-freeze`），
 * **唯一所有者是 `apps/web/src/views/**` 那一份**，由 `check:stockorder` / `check:state` 直接测。
 *
 * 为什么不留着：留着的话两侧文件少一边时循环会 `continue` ——
 * 那是一条**永远绿的假门禁**，比没有更糟（它会让人以为"副本一致性"还被守着）。
 * 将来若又出现第二份副本，正确做法是重新写一条**会在不一致时失败**的比对，
 * 而不是把这段恢复回来（它现在的语义已经是"任一侧不存在就跳过"）。
 */

if (problems > 0) {
  console.error(`check-store: 扫描 ${scanned} 个 .vue，发现 ${problems} 处问题。`);
  process.exit(1);
}
console.log(`check-store OK: 扫描 ${scanned} 个 .vue，无组件直连桥；@wise/ui 未依赖数据层`);

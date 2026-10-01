#!/usr/bin/env node
/**
 * check-navigation-web.js —— Vue 版导航可达性门禁。
 *
 * ## 它拦的是什么
 *
 * 屏请求导航时写的是一个**字符串方法 id**，拼错一字符不会编译失败、不会抛异常，
 * 用户看到的是"点了没反应"或"跳错屏" —— 这是最难查的一类故障。所以要在构建期把
 * 导航模型与契约对一遍。
 *
 * ## 与 React 版 check-navigation.mjs 的关系
 *
 * React 版扫的是 `.tsx` 里的 `onNavigate({ method: '…' })` 字面量。
 * Vue 版的路由表是**由导航模型生成**的（`apps/web/src/router/routes.ts` 里
 * `DOMAINS.flatMap` / `DESTINATIONS.map`），所以"路由覆盖了哪些方法"是结构性成立的，
 * 这里改为校验**导航模型自身**的正确性：
 *
 *   1. 叶子 / 目的地的方法 id 唯一；
 *   2. 每个方法 id 都在生成契约里存在（改契约后漏改导航会被抓出来）；
 *   3. 路径唯一，且**叶子路径与目的地路径不相等**；
 *   4. 目的地路径里的 `:param` 段与 `paramKeys` 一一对应（少一个，路由参数就取不到）。
 *
 * 路由**匹配顺序**（静态段必须排在参数段之前）不看静态文本 ——
 * 它由 `routes.ts` 里"叶子先于目的地"的展开顺序保证，并由 smoke 里的
 * 行为断言（访问 `/inventory/stock-orders/new` 必须是"新建出入库单"）钉死。
 *
 * 用法：node tools/check/check-navigation-web.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const NAV_TS = path.join(CLIENT_ROOT, 'packages', 'layouts', 'src', 'navigation.ts');
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const ROUTES_TS = path.join(CLIENT_ROOT, 'apps', 'web', 'src', 'router', 'routes.ts');

let problems = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  problems += 1;
};

const navText = fs.readFileSync(NAV_TS, 'utf8');

/** 叶子：DOMAINS 里每条的 `primaryMethod: '…'` 与紧邻的 `path: '…'` */
const leafBlock = /export const DOMAINS[\s\S]*?=\s*\[([\s\S]*?)\n\];/.exec(navText)?.[1] ?? '';
const leafMethods = [...leafBlock.matchAll(/primaryMethod:\s*'([^']+)'/g)].map((m) => m[1]);
const leafPaths = [...leafBlock.matchAll(/primaryMethod:\s*'[^']+',\s*path:\s*'([^']+)'/g)].map((m) => m[1]);

/** 目的地块 */
/**
 * 目的地块。
 *
 * **必须锚定 `export const DESTINATIONS`**：文件顶部的文档注释里也提到了 DESTINATIONS，
 * 用裸 `DESTINATIONS[\s\S]*?= \[` 会先匹配到 `DOMAINS` 的赋值，于是"目的地"变成整份叶子表
 * （第一版就是这么写的，结果报了 33 个假问题）。这类门禁自己出错比不写更糟。
 */
const destBlock = /export const DESTINATIONS[\s\S]*?=\s*\[([\s\S]*?)\n\];/.exec(navText)?.[1] ?? '';
const destMethods = [...destBlock.matchAll(/method:\s*'([^']+)'/g)].map((m) => m[1]);
const destPaths = [...destBlock.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
const destParams = [...destBlock.matchAll(/paramKeys:\s*\[([^\]]*)\]/g)].map((m) =>
  [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
);

function checkUnique(values, label) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) {
      fail(`${label} 存在重复项：${v}`);
    }
    seen.add(v);
  }
}

checkUnique(leafMethods, '导航叶子方法');
checkUnique(destMethods, '导航目的地方法');
checkUnique([...leafPaths, ...destPaths], '导航路径');

if (leafPaths.length !== leafMethods.length) {
  fail(`叶子路径数（${leafPaths.length}）与方法数（${leafMethods.length}）不一致 —— 有一条叶子没写 path`);
}
if (destPaths.length !== destMethods.length) {
  fail(`目的地路径数（${destPaths.length}）与方法数（${destMethods.length}）不一致`);
}
if (destParams.length !== destMethods.length) {
  fail(`目的地 paramKeys 数（${destParams.length}）与方法数（${destMethods.length}）不一致`);
}

// ---- 1. 方法 id 必须在契约里 ----
const contractText = fs.readFileSync(CONTRACT_TS, 'utf8');
const contractIds = new Set([...contractText.matchAll(/\{ id: '([^']+)', domain:/g)].map((m) => m[1]));
for (const m of [...leafMethods, ...destMethods]) {
  if (!contractIds.has(m)) {
    fail(`导航引用了契约里不存在的方法 id：${m}`);
  }
}

// ---- 2. 叶子路径与目的地路径不得相等（相等会让详情盖掉列表） ----
for (const p of leafPaths) {
  if (destPaths.includes(p)) {
    fail(`路径 ${p} 同时是叶子与目的地 —— 详情会盖掉列表页`);
  }
}

// ---- 3. 目的地路径的 :param 段必须与 paramKeys 一一对应 ----
destPaths.forEach((p, i) => {
  const inPath = [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();
  const declared = [...(destParams[i] ?? [])].sort();
  if (inPath.join(',') !== declared.join(',')) {
    fail(`目的地 ${destMethods[i]} 的路径参数 [${inPath.join(', ')}] 与 paramKeys [${declared.join(', ')}] 不一致`);
  }
});

// ---- 4. 路由表的展开顺序（静态段先于参数段）是结构性保证，这里只核它还在 ----
const routesText = fs.readFileSync(ROUTES_TS, 'utf8');
const leafIdx = routesText.indexOf('...leafRoutes');
const destIdx = routesText.indexOf('...destinationRoutes');
if (leafIdx < 0 || destIdx < 0 || leafIdx > destIdx) {
  fail('routes.ts 里叶子路由必须排在目的地路由之前 —— 否则 /inventory/stock-orders/new 会被 /:orderId 抢先匹配');
}

// ---- 5. 已迁入的屏必须在可达集合里（V4 逐域迁移）----
const REGISTRY_TS = path.join(CLIENT_ROOT, 'apps', 'web', 'src', 'views', 'registry.ts');
const regText = fs.readFileSync(REGISTRY_TS, 'utf8');
const regBody = regText.slice(regText.indexOf('SCREEN_REGISTRY'));
const registered = [...regBody.matchAll(/^\s*'([^']+)':\s*\(\)/gm)].map((m) => m[1]);
const reachable = new Set([...leafMethods, ...destMethods]);
for (const m of registered) {
  if (!reachable.has(m)) {
    fail(`屏注册表里的 ${m} 既不是导航叶子也不是目的地 —— 它永远不会被路由用到（用户点不到）`);
  }
}
const pending = [...reachable].filter((m) => !registered.includes(m));

if (problems > 0) {
  console.error(`\ncheck-navigation-web: ${problems} 处问题（叶子 ${leafMethods.length} / 目的地 ${destMethods.length}）`);
  process.exit(1);
}
console.log(
  `check-navigation-web OK: 叶子 ${leafMethods.length} 个、目的地 ${destMethods.length} 个，` +
    `方法 id 全在契约内、路径唯一、参数一致、静态段先于参数段；已迁入屏 ${registered.length} 个`,
);
if (pending.length > 0) {
  console.log(`  提示：以下可达目的地还没有对应的屏（会落到"功能上线中"占位，不是错误）：${pending.length} 个`);
}

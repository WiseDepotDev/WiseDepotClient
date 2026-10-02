#!/usr/bin/env node
/*
 * check-protocol-version.mjs —— 桥协议版本的**跨语言对账**门禁。
 *
 * ## 为什么需要它
 *
 * 2026-10-02 实测事故：协议从 v3 升到 v4 时改了四处里的三处，漏掉的是**桌面壳自己**
 * 那份（`apps/desktop/src/webAssets.ts` 把版本写进 `__bridge.json`）。后果不是构建失败，
 * 而是**应用直接停在"应用与本地服务版本不一致"的启动失败屏** ——
 * 现象出现在用户面前，而根因在四个互不相识的文件里。
 *
 * 这类"同一个事实存在多份副本"的东西，靠人记是记不住的（本次就是活证据），
 * 所以按 `check-timeout-budget.mjs` 的体例做一条**跨语言对账**：四处必须相等，
 * 任一处缺失也报错（缺失往往就是"新加了一处而没登记"）。
 *
 * ## 四处定义（每一处都必须能被这条门禁找到）
 *
 *   1. Kotlin  `BridgeProtocol.VERSION`            —— 线格式的**权威**
 *   2. TS      `BRIDGE_PROTOCOL_VERSION`           —— 页面（Web 产物）期望值
 *   3. 工具    `WIRE_PROTOCOL_VERSION`             —— bench/check 工具的期望值
 *   4. 桌面壳  `webAssets.ts` 写进引导文件的 `protocol`
 *
 * 手机壳**不在这份清单里**：它走 Kotlin `BridgeBootstrap` 的默认值（= 第 1 处），没有独立副本。
 *
 * 用法：node tools/check/check-protocol-version.mjs
 * 退出码：0 = 一致；1 = 不一致或有定义找不到。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * 每一处：名字 + 文件 + 提取版本号的**窄正则**。
 *
 * 正则刻意写窄（连类型标注一起匹配）：宽正则会误命中注释里的举例，
 * 那会让这条门禁在"只是文档提了一嘴"时假绿。
 */
const DEFINITIONS = [
  {
    name: 'Kotlin BridgeProtocol.VERSION',
    file: 'bridge/protocol/src/main/kotlin/com/huicang/wise/bridge/protocol/BridgeProtocol.kt',
    pattern: /const val VERSION: Int = (\d+)/,
  },
  {
    name: 'TS BRIDGE_PROTOCOL_VERSION',
    file: 'packages/bridge-client/src/types.ts',
    pattern: /export const BRIDGE_PROTOCOL_VERSION = (\d+) as const/,
  },
  {
    name: '工具 WIRE_PROTOCOL_VERSION',
    file: 'tools/lib/bridge-wire.mjs',
    pattern: /export const WIRE_PROTOCOL_VERSION = (\d+);/,
  },
  {
    name: '桌面壳引导 protocol',
    file: 'apps/desktop/src/webAssets.ts',
    // 该文件里还有别的 protocol（Electron 的 scheme 注册），所以锚死 "protocol: <数字>,"
    pattern: /protocol: (\d+),/,
  },
];

const found = [];
let failed = false;

for (const def of DEFINITIONS) {
  const full = path.join(ROOT, def.file);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch (e) {
    console.error(`✗ ${def.name}：读不到文件 ${def.file}（${e.message}）`);
    failed = true;
    continue;
  }
  const m = text.match(def.pattern);
  if (!m) {
    console.error(
      `✗ ${def.name}：在 ${def.file} 里找不到版本号定义。\n` +
        `  如果你刚新增了一处"写协议版本的地方"，请把它登记到本脚本的 DEFINITIONS 里 —— ` +
        `"定义找不到"和"版本不一致"一样必须红。`,
    );
    failed = true;
    continue;
  }
  found.push({ name: def.name, file: def.file, version: Number(m[1]) });
}

const versions = new Set(found.map((f) => f.version));
for (const f of found) {
  console.log(`  · ${f.name} = ${f.version}  (${f.file})`);
}

if (failed) {
  console.error('check-protocol-version FAIL：有定义缺失（见上）。');
  process.exit(1);
}
if (versions.size !== 1) {
  console.error(
    `check-protocol-version FAIL：四处定义不一致 —— ${[...versions].join(' / ')}。\n` +
      `  协议版本必须处处相等：不一致时应用会停在"应用与本地服务版本不一致"的启动失败屏，` +
      `而错误现象与根因相隔四个文件。`,
  );
  process.exit(1);
}

console.log(`check-protocol-version OK: ${found.length} 处定义一致（protocol=${[...versions][0]}）`);

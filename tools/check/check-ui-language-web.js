#!/usr/bin/env node
/**
 * check-ui-language-web.js —— Vue 界面的**文案纪律**门禁。
 *
 * 对应 React 侧的 `check-ui-language.mjs`（它只扫 .tsx，看不见 .vue）。
 * 两条规则都来自真实返工：
 *
 * 1. **方法 id 不能出现在界面上**。用户实测反馈过：页面直接显示 `inventory.list`、
 *    "W5–W7 逐域迁入"、"令牌"这类开发文案，给人的感知是"系统没做完 / 坏了"。
 *    业务用户永远不该看到技术术语。
 * 2. **内联样式里不许写死颜色/尺寸**：.vue 的 `style="…"` 不会被 check:css 扫到，
 *    所以在这里补一刀（Naive 的主题覆盖由 check:naive 管，两者不重叠）。
 *
 * 扫描范围：`apps/web/src/**\/*.vue` 的**文本节点**（`>文本<`）。
 * 只看文本节点是有意的：class 名（`w-mono`）与属性值不该被当成用户可见文案。
 *
 * 用法：node tools/check/check-ui-language-web.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const APP_SRC = path.join(CLIENT_ROOT, 'apps', 'web', 'src');
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git']);

/** 开发黑话：业务用户读到只会更困惑。 */
const JARGON = [
  [/\bW[0-9]\b/, '里程碑编号（如 W5）'],
  [/\bW[0-9]–W[0-9]\b/, '里程碑区间'],
  [/\bmock\b/i, 'mock 一词'],
  [/\bBRIDGE_[A-Z_]+\b/, '桥错误码'],
  [/\bpackages\//, '仓库路径'],
  [/\.tsx\b/, '源文件后缀'],
  [/\bTODO\b|\bFIXME\b/, '待办标记'],
  [/桥方法|桥协议|协议版本/, '桥的技术术语'],
  [/dev-only/, '开发态标记'],
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
    } else if (e.name.endsWith('.vue')) {
      out.push(p);
    }
  }
  return out;
}

const contractText = fs.readFileSync(CONTRACT_TS, 'utf8');
const contractIds = new Set([...contractText.matchAll(/\{ id: '([^']+)', domain:/g)].map((m) => m[1]));

let problems = 0;
const files = walk(APP_SRC);
let textNodes = 0;

for (const file of files) {
  const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  // 去掉 script / style 块：那里的字符串不是用户可见文案
  const template = raw
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '');

  for (const m of template.matchAll(/>([^<>]+)</g)) {
    const node = m[1];
    if (node.includes('{{')) {
      continue; // 插值表达式：里面是标识符，不是文案
    }
    const text = node.trim();
    if (text === '') {
      continue;
    }
    textNodes += 1;

    for (const [re, label] of JARGON) {
      if (re.test(text)) {
        console.error(`✗ ${rel} 文案里出现${label}：「${text.slice(0, 60)}」`);
        problems += 1;
      }
    }
    for (const id of contractIds) {
      if (text.includes(id)) {
        console.error(`✗ ${rel} 文案里出现桥方法 id「${id}」—— 业务用户不该看到技术术语`);
        problems += 1;
      }
    }
  }

  // 内联样式里的写死取值（style="color:#fff" / style="width:280px"）
  for (const m of raw.matchAll(/style="([^"]*)"/g)) {
    const style = m[1];
    if (style.includes('var(--w-')) {
      continue;
    }
    const hex = /\B#[0-9A-Fa-f]{3,8}\b/.exec(style);
    if (hex) {
      console.error(`✗ ${rel} 内联样式写死颜色 ${hex[0]}`);
      problems += 1;
    }
    for (const px of style.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px/g)) {
      if (!['0px', '1px', '2px'].includes(px[0])) {
        console.error(`✗ ${rel} 内联样式写死尺寸 ${px[0]}`);
        problems += 1;
      }
    }
  }
}

if (problems > 0) {
  console.error(`check-ui-language-web: 扫描 ${files.length} 个 .vue（${textNodes} 个文本节点），发现 ${problems} 处问题。`);
  process.exit(1);
}
console.log(
  `check-ui-language-web OK: 扫描 ${files.length} 个 .vue 的 ${textNodes} 个文本节点，无方法 id、无开发黑话、无内联写死取值`,
);

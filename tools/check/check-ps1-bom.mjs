#!/usr/bin/env node
/*
 * check-ps1-bom.mjs —— 仓库里**每一个** `.ps1` 都必须带 UTF-8 BOM。
 *
 * ## 为什么这是一条门禁而不是"注意一下"
 *
 * `pnpm desktop:smoke` / `pnpm notify:smoke` / `pnpm smoke:nfc-device` 走的是
 * `powershell -File`（Windows PowerShell 5.1）。**没有 BOM 时它按当前 ANSI 代码页读文件**，
 * 于是 UTF-8 的中文注释被当成 GBK：字符数变少、字节串位，连字符串的收尾引号都可能被吞掉，
 * 报出来的却是"第 89 行少一个引号""Unexpected token"这种与真因毫不相干的错 ——
 * 你会去检查那一行的语法，而那一行根本没问题。
 *
 * ## 这个坑已经发生过三次
 *
 * 1. 先写 `nfc-device-check.ps1`、后补 BOM（当时只给这一个文件加了断言）；
 * 2. 一次 edit 又把它的 BOM 弄掉（同一个断言抓回来）；
 * 3. 2026-10-07 给 `desktop.ps1` 加 `-NotifySmoke` 时**同一个坑第三次**踩响 ——
 *    而那时断言只盯着 NFC 那一个文件，所以它是**绿的**，红的是运行时的 PowerShell。
 *
 * 所以断言从"某一个脚本"扩到"所有脚本"：这类错误的成本与文件个数无关，
 * 而发现它的成本与"有没有恰好覆盖到那个文件"强相关。
 *
 * 注：`edit`/`write` 之类的工具写文件时通常不带 BOM，所以改完 `.ps1` 要**显式补回来**：
 *     $p='scripts/xxx.ps1'
 *     $t=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($p))
 *     [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($true)))
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 递归找出所有 `.ps1`（跳过产物与依赖目录 —— 那些不归我们管）。 */
function findScripts(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist' || entry.name === '.gradle') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findScripts(full, out);
    } else if (entry.name.endsWith('.ps1')) {
      out.push(full);
    }
  }
  return out;
}

const scripts = findScripts(CLIENT_ROOT).sort();
let problems = 0;
console.log('check-ps1-bom：');

if (scripts.length === 0) {
  // 一个都没扫到 ⇒ 门禁自己失效了。静默通过是最坏的结果。
  console.error('  ✗ 一个 .ps1 都没扫到 —— 门禁自己要能定位，不能静默通过');
  process.exit(1);
}

for (const file of scripts) {
  const bytes = readFileSync(file);
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const first = [...bytes.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const short = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
  if (hasBom) {
    console.log(`  ✓ ${short} 带 UTF-8 BOM`);
  } else {
    problems += 1;
    console.error(`  ✗ ${short} 没有 UTF-8 BOM（前三个字节 ${first}）—— powershell 5.1 会按 ANSI 读它`);
  }
}

// 顺带挡住"把脚本藏进子目录、或 .ps1 大小写不一"这类漏扫（Windows 上大小写不敏感）
const unexpected = scripts.filter((f) => !/\.ps1$/i.test(f));
if (unexpected.length > 0) {
  problems += 1;
  console.error(`  ✗ 有文件绕过了后缀判据：${unexpected.map((f) => path.basename(f)).join('、')}`);
}

if (problems > 0) {
  console.error(`check-ps1-bom: ${scripts.length} 个脚本，${problems} 处不满足。`);
  process.exit(1);
}
console.log(`check-ps1-bom OK: ${scripts.length} 个 .ps1 全部带 BOM（powershell 5.1 才不会把中文读成乱码）`);

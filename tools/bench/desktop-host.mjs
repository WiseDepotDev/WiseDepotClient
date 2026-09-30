#!/usr/bin/env node
/**
 * desktop-host.mjs —— 桌面宿主逻辑的验收（不需要拉起 Electron）。
 *
 * 用与 `check-shell-render` 相同的手法：拿已有的 esbuild 把 TS 入口打成一次性 CJS 再跑。
 * 验的是"最容易错、也最值得单独验"的三块：
 *   子进程生命周期（握手/崩溃重启/优雅停止）、引导响应契约、静态资源解析与路径穿越防线。
 *
 * 用法：node tools/bench/desktop-host.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'tools', 'bench', 'desktop-host-entry.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-desktop-bench-'));
const outFile = path.join(outDir, 'entry.cjs');

// 仓库根通过环境变量传给被打包的入口：CJS 产物里 import.meta 不可用，
// 而它的 __dirname 是临时目录，都不能用来定位仓库。
process.env.WISE_CLIENT_ROOT = CLIENT_ROOT;

try {
  await build({
    entryPoints: [ENTRY],
    outfile: outFile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    logLevel: 'warning',
    // electron 不参与这份验收（验的是 Electron 之外的逻辑）
    external: ['electron'],
  });
  await import(pathToFileURL(outFile).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

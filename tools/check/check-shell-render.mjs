#!/usr/bin/env node
/**
 * check-shell-render.mjs —— 用 esbuild 把 shell-render-entry.tsx 打成一次性 Node 包并执行。
 *
 * 为什么绕这一圈：外壳是 .tsx（React），本仓库没有引入 ts-node/tsx/vitest 这类运行时，
 * 而 **esbuild 已经是依赖**（vite 带的）。用它做一次"打包 + 运行"，等于零新增依赖地拿到
 * "两套外壳能真实渲染"的证据。
 *
 * 用法：node tools/check/check-shell-render.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'tools', 'check', 'shell-render-entry.tsx');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-shell-render-'));
// 打成 CJS 而不是 ESM：react-dom/server 是 CJS 且内部 require('util')，
// 打成 ESM 会撞上 "Dynamic require of \"util\" is not supported"。
const outFile = path.join(outDir, 'entry.cjs');

try {
  await build({
    entryPoints: [ENTRY],
    outfile: outFile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    // react / react-dom 走真实依赖（要的是真实渲染，不是打桩）
    external: [],
    jsx: 'automatic',
    logLevel: 'warning',
  });

  await import(pathToFileURL(outFile).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

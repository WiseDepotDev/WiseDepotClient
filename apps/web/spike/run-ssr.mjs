/**
 * Spike A 跑手：把 SSR 入口打成自包含 ESM，再在 node 里执行。
 *
 * 跑法：node apps/web/spike/run-ssr.mjs             概要
 *       $env:SPIKE_VERBOSE=1; node ...              额外打印 sider/menu 的内联 CSS 变量
 */
import { build } from 'vite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'ssr-dist');

rmSync(outDir, { recursive: true, force: true });

await build({
  configFile: resolve(here, 'vite.spike.config.ts'),
  root: here,
  logLevel: 'warn',
  build: {
    ssr: 'naive-ssr-runner.ts',
    outDir: 'ssr-dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'ssr.mjs' } },
  },
});

const mod = await import(pathToFileURL(resolve(outDir, 'ssr.mjs')).href);
const report = await mod.runAll();

mkdirSync(resolve(here, 'results'), { recursive: true });
writeFileSync(resolve(here, 'results/spike-a-ssr.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('=== Spike A：SSR 样式收集 + themeOverrides ===');
for (const r of [report.partial, report.full, report.withInverted]) {
  console.log(`\n[${r.label}]`);
  console.log(`  collect() 产出 CSS      : ${r.cssBytes} bytes -> ${r.collectWorks ? 'OK' : '空！'}`);
  console.log(`  primary #087C75         : css=${r.primaryTokenInCss} html=${r.primaryTokenInHtml}`);
  console.log(`  侧栏底 #102E3E 生效     : ${r.menuNavBgApplied}`);
  console.log(`  侧栏次要字 #B9CDD5 生效 : ${r.navMutedTextApplied}`);
  console.log(`  --n-height:48px 生效    : ${r.heightLarge48Applied}`);
  console.log(`  NDataTable / NMenu 渲染 : ${r.tableRendered} / ${r.menuRendered}`);
  console.log(`  Naive 默认色泄漏总处数  : ${r.leakTotal}`);
  for (const l of r.leakedNaiveDefaults) console.log(`      ${l.hex} x ${l.count}`);
  if (process.env.SPIKE_VERBOSE) {
    console.log(`  Sider 内联变量: ${r.siderStyleVars}`);
    console.log(`  Menu  内联变量: ${r.menuStyleVars}`);
  }
}
console.log('\n结果 JSON: apps/web/spike/results/spike-a-ssr.json');

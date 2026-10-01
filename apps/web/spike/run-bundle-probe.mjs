/**
 * 体积探针：分别打包三个层级的 Naive 组件集合，量首屏预算（设计稿风险 R2）。
 *
 * 每次都是**独立**的一次 build（不是多入口共享 chunk），所以每个数字都是
 * "如果首屏只加载这一套"的真实代价。
 *
 * 跑法：node apps/web/spike/run-bundle-probe.mjs
 */
import { build } from 'vite';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const PROBES = [
  { name: 'lean（登录/首屏最小集）', entry: 'probe/lean.ts' },
  { name: 'lean + DataTable + Pagination', entry: 'probe/dtable.ts' },
  { name: 'lean + Select + DatePicker', entry: 'probe/picker.ts' },
  { name: 'list（列表页：DataTable+Select+DatePicker+Drawer）', entry: 'probe/list.ts' },
  { name: 'shell（双壳：+Layout+Sider+Menu+Badge+Tooltip）', entry: 'probe/shell.ts' },
];

const collect = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
};

const results = [];
for (const probe of PROBES) {
  const outDir = resolve(here, `.probe-dist/${probe.entry.replace(/[/.]/g, '_')}`);
  rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: resolve(here, 'vite.spike.config.ts'),
    root: here,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: { probe: resolve(here, probe.entry) },
        output: { entryFileNames: 'probe.js', format: 'es' },
      },
    },
  });
  const files = collect(outDir).filter((f) => f.endsWith('.js'));
  const raw = files.reduce((a, f) => a + statSync(f).size, 0);
  const gzip = files.reduce((a, f) => a + gzipSync(readFileSync(f)).length, 0);
  results.push({ name: probe.name, entry: probe.entry, rawKB: +(raw / 1024).toFixed(1), gzipKB: +(gzip / 1024).toFixed(1) });
}

/** vue 基线：只有 vue + vue-router + pinia，不含任何 UI 库。 */
const baseOut = resolve(here, '.probe-dist/base');
rmSync(baseOut, { recursive: true, force: true });
mkdirSync(resolve(here, 'probe'), { recursive: true });
writeFileSync(
  resolve(here, 'probe/base.ts'),
  `import { createApp, h } from 'vue';\nimport { createRouter, createWebHashHistory } from 'vue-router';\nimport { createPinia } from 'pinia';\nconst app = createApp({ render: () => h('div') });\napp.use(createPinia());\napp.use(createRouter({ history: createWebHashHistory(), routes: [{ path: '/', component: { render: () => h('div') } }] }));\napp.mount(document.createElement('div'));\n`,
  'utf8',
);
await build({
  configFile: resolve(here, 'vite.spike.config.ts'),
  root: here,
  logLevel: 'silent',
  build: {
    outDir: baseOut,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: { probe: resolve(here, 'probe/base.ts') },
      output: { entryFileNames: 'probe.js', format: 'es' },
    },
  },
});
const baseFiles = collect(baseOut).filter((f) => f.endsWith('.js'));
const baseGzip = baseFiles.reduce((a, f) => a + gzipSync(readFileSync(f)).length, 0);
const base = { name: 'base（vue+vue-router+pinia，无 UI 库）', rawKB: 0, gzipKB: +(baseGzip / 1024).toFixed(1) };

mkdirSync(resolve(here, 'results'), { recursive: true });
writeFileSync(
  resolve(here, 'results/spike-c-bundle.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), budgetKB: 250, base, probes: results }, null, 2),
  'utf8',
);

console.log('=== 体积探针（gzip，产品首屏预算 250KB）===');
console.log(`  ${base.name.padEnd(46)} ${String(base.gzipKB).padStart(7)} KB`);
const byName = {};
for (const r of results) {
  console.log(`  ${r.name.padEnd(46)} ${String(r.gzipKB).padStart(7)} KB   (raw ${r.rawKB} KB)`);
  byName[r.entry] = r.gzipKB;
}
const lean = byName['probe/lean.ts'] ?? 0;
console.log('\n--- 相对 lean 的增量（谁在吃预算）---');
for (const r of results) {
  if (r.entry === 'probe/lean.ts') continue;
  console.log(`  ${r.name.padEnd(46)} ${(r.gzipKB - lean >= 0 ? '+' : '') + (r.gzipKB - lean).toFixed(1)} KB`);
}
console.log('\n结果 JSON: apps/web/spike/results/spike-c-bundle.json');

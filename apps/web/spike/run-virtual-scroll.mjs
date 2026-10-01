/**
 * Spike B 跑手：vite build → 本地静态服务 → 无头 Chrome（CDP）→ 取真实滚帧数据。
 *
 * 跑法：node apps/web/spike/run-virtual-scroll.mjs
 */
import { build } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Cdp, launchChrome, sleep } from './lib/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
const PORT = 5199;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

console.log('1/4 vite build（spike 配置，与产品构建隔离）…');
await build({ configFile: resolve(here, 'vite.spike.config.ts'), root: here, logLevel: 'silent' });

/** 顺手量一下"只用到这些 Naive 组件"时的产物体积 —— 设计稿风险 R2 的直接证据。 */
const assets = [];
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else assets.push(p);
  }
};
await walk(dist);
const bundle = [];
for (const p of assets) {
  const buf = await readFile(p);
  const gz = gzipSync(buf).length;
  bundle.push({
    file: p.slice(dist.length + 1).replace(/\\/g, '/'),
    rawBytes: buf.length,
    gzipBytes: gz,
  });
}
bundle.sort((a, b) => b.gzipBytes - a.gzipBytes);

console.log('2/4 起本地静态服务…');
const server = createHttpServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const rel = url === '/' || url === '' ? '/index.html' : url;
  try {
    const buf = await readFile(join(dist, decodeURIComponent(rel)));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

console.log('3/4 启动无头 Chrome 并连 CDP…');
const chrome = await launchChrome({ port: 9333 });
const cdp = await Cdp.connect(chrome.wsUrl);

const pageErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => {
  pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '未知');
});

const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/` });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
cdp.sessionId = sessionId;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

// 等页面把 __spike 挂上（首屏含 naive-ui，给足时间）
let ready = false;
for (let i = 0; i < 120; i += 1) {
  const probe = await cdp.evaluate('({ hook: typeof window.__spike, state: document.readyState, rows: document.querySelectorAll(".n-data-table-tr").length })', { awaitPromise: false });
  if (probe?.hook === 'function' && probe.rows > 0) {
    ready = true;
    break;
  }
  await sleep(500);
}

console.log('4/4 测量 1000 行虚拟滚动…');
let result = null;
if (ready) {
  result = await cdp.evaluate('window.__spike()');
}

const report = {
  generatedAt: new Date().toISOString(),
  chrome: chrome.exe,
  viewport: '1440x900 (headless=new, 后台节流已关闭)',
  ready,
  pageErrors,
  bundleGzipTotal: bundle.reduce((a, b) => a + b.gzipBytes, 0),
  bundle,
  result,
};
mkdirSync(resolve(here, 'results'), { recursive: true });
writeFileSync(resolve(here, 'results/spike-b-virtual-scroll.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('\n=== Spike B：NDataTable 虚拟滚动（1000 行） ===');
if (!result) {
  console.log(`  页面未就绪。pageErrors=${JSON.stringify(pageErrors)}`);
} else {
  console.log(`  渲染总行数            : ${result.totalRows}`);
  console.log(`  首帧 DOM 行数         : ${result.domRowsFirstPaint}`);
  console.log(`  滚动中 DOM 行数峰值   : ${result.domRowsMax}`);
  console.log(`  首行实际高度          : ${result.firstRowHeightPx}px（令牌要求 48）`);
  console.log(`  挂载耗时              : ${result.mountedMs}ms`);
  console.log(`  虚拟内容总高          : ${result.scrollHeight}px`);
  console.log(`  滚动帧 p50 / p95 / max: ${result.frameP50} / ${result.frameP95} / ${result.frameMax} ms`);
  console.log(`  超 20ms 的帧（真卡顿）: ${result.framesOver20} / ${result.frameCount}`);
}
if (pageErrors.length) console.log(`  页面异常: ${pageErrors.join(' | ')}`);
console.log('\n--- 产物体积（仅这一个 spike 页面用到的 Naive 组件）---');
for (const b of bundle) {
  console.log(`  ${b.file}  raw ${(b.rawBytes / 1024).toFixed(1)}KB  gzip ${(b.gzipBytes / 1024).toFixed(1)}KB`);
}
console.log(`  合计 gzip: ${(report.bundleGzipTotal / 1024).toFixed(1)}KB（产品首屏预算 250KB）`);

cdp.close();
chrome.stop();
server.close();
console.log(`\n结果 JSON: apps/web/spike/results/spike-b-virtual-scroll.json`);

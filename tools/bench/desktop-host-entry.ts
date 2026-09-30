import path from 'node:path';
import process from 'node:process';
import { BridgeProcess, type BridgeHandshake } from '../../apps/desktop/src/bridgeProcess.js';
import { bootstrapResponse, resolveWebAsset } from '../../apps/desktop/src/webAssets.js';

/**
 * 桌面宿主逻辑的验收入口（由 tools/bench/desktop-host.mjs 用 esbuild 打包后执行）。
 *
 * 它对着**真的** Gradle 产物跑（真 JVM、真 stdout 握手），因此能验到 Electron 之外的一切：
 * 握手、退出、**崩溃重启**、引导响应、静态资源解析与路径穿越防线。
 * 只有"窗口/菜单/打包"这部分留给人工或 E2E。
 */

// 仓库根由 runner 通过环境变量传入。
// 为什么不用 import.meta.dirname：这份入口会被 esbuild 打成 CJS 再执行，
// 而打包产物的 __dirname 是临时目录、import.meta 在 CJS 里为空。
const CLIENT_ROOT = process.env.WISE_CLIENT_ROOT ?? process.cwd();
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');
const WEB_ROOT = path.join(CLIENT_ROOT, 'apps', 'web', 'dist');

const results: { name: string; passed: boolean; detail?: string }[] = [];
let ok = true;

function record(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed, ...(detail ? { detail } : {}) });
  if (!passed) {
    ok = false;
  }
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

function makeProcess(): BridgeProcess {
  return new BridgeProcess({
    classpath: path.join(LIB_DIR, '*'),
    mainClass: 'com.huicang.wise.bridge.host.desktop.MainKt',
    backendUrl: 'http://127.0.0.1:1',
    version: '1.0.0-desktop-bench',
    jvmArgs: ['-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Xms16m', '-Xmx256m'],
    restart: { maxRestarts: 2, baseBackoffMs: 200, maxBackoffMs: 800 },
  });
}

async function main(): Promise<void> {
  console.log('--- 1. 子进程生命周期（真 JVM）---');
  const bridge = makeProcess();
  const states: string[] = [];
  bridge.on('state', (s: string) => states.push(s));

  const t0 = Date.now();
  const hs: BridgeHandshake = await bridge.start();
  record('启动并完成 stdout 握手', hs.port > 0 && hs.token.length > 30, `port=${hs.port} pid=${hs.pid} ${Date.now() - t0}ms`);
  record('状态机走过 starting → running', states.includes('starting') && states.includes('running'), states.join(' → '));

  console.log('--- 2. 引导响应（与手机壳同一份契约）---');
  const ready = bootstrapResponse(hs);
  const parsed = JSON.parse(ready.body) as { port: number; protocol: number; capabilities: string[] };
  record(
    '桥就绪时 __bridge.json 回 200 且字段齐全',
    ready.status === 200 && parsed.port === hs.port && parsed.protocol === 3 && Array.isArray(parsed.capabilities),
    `status=${ready.status} protocol=${parsed.protocol} capabilities=${JSON.stringify(parsed.capabilities)}`,
  );
  const notReady = bootstrapResponse(null);
  record('桥未就绪时回 503（不是 404、也不是空 200）', notReady.status === 503, `status=${notReady.status}`);

  console.log('--- 3. Web 产物解析与路径穿越防线 ---');
  const index = resolveWebAsset(WEB_ROOT, '/index.html');
  record('命中 index.html 并给出正确 content-type', index !== null && index.contentType.startsWith('text/html'), index?.contentType);
  const jsAsset = resolveWebAsset(WEB_ROOT, `/assets/${(index ? '' : '')}${firstJs()}`);
  record('命中 JS 资源', jsAsset !== null && jsAsset.contentType.startsWith('text/javascript'), jsAsset?.contentType);

  const traversals = [
    '../package.json',
    '../../package.json',
    '..%2f..%2fpackage.json',
    '/../package.json',
    'assets/../../../package.json',
    'a\0b',
  ];
  for (const t of traversals) {
    const r = resolveWebAsset(WEB_ROOT, t);
    record(`穿越尝试被拒：${JSON.stringify(t)}`, r === null, r ? `被解析到 ${r.absolutePath}` : 'null');
  }
  record('目录（非普通文件）不被当作资源', resolveWebAsset(WEB_ROOT, '/assets') === null);

  console.log('--- 4. 崩溃重启 ---');
  const portBefore = hs.port;
  const restarted = new Promise<BridgeHandshake>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('重启超时')), 15000);
    bridge.once('ready', (next: BridgeHandshake) => {
      clearTimeout(timer);
      resolve(next);
    });
  });
  process.kill(hs.pid);
  const next = await restarted;
  record(
    '子进程被杀后自动重启并拿到**新端口/新 token**',
    next.port !== portBefore && next.token !== hs.token,
    `${portBefore} → ${next.port}`,
  );
  record('重启期间状态机经过 restarting', states.includes('restarting'), states.join(' → '));

  console.log('--- 5. 优雅停止与"不自复活"---');
  const exitCode = await bridge.stop();
  record('stdin shutdown 后正常退出', exitCode === 0, `exit=${exitCode}`);
  await new Promise((r) => setTimeout(r, 1200));
  record('停止后不再重启（主动停止不算崩溃）', bridge.state === 'stopped', `state=${bridge.state}`);

  console.log('');
  console.log(ok ? '✓ 桌面宿主逻辑全部通过' : '✗ 存在未通过项');
  console.log(JSON.stringify({ ok, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

/** 从 web dist 里取一个真实的 JS 文件名（避免把 build hash 写死在脚本里）。 */
function firstJs(): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = path.join(WEB_ROOT, 'assets');
  const js = fs.readdirSync(dir).find((f) => f.endsWith('.js'));
  if (!js) {
    throw new Error(`web dist 里没有 JS 产物：${dir}`);
  }
  return js;
}

void main().catch((e: Error) => {
  console.error(`desktop-host bench 失败：${e.message}`);
  process.exit(1);
});

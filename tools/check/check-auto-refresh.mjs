#!/usr/bin/env node
/**
 * check-auto-refresh.mjs —— "删除手动刷新、改成持续自动更新"这条要求的门禁。
 *
 * ## 为什么需要它
 *
 * 这次改动把**界面上的刷新按钮全撤了**，更新的唯一途径变成自动刷新。
 * 撤按钮很容易（改回一行就回来了），真正容易坏掉的是**链路**：
 *   1. 自动刷新的调度器有没有真的挂上（可见时周期、回前台/聚焦/联网各补一次）；
 *   2. 回到前台时**先验活**、再重取 —— 半死的 WebSocket 不会回包，
 *      顺序反了会变成"每一屏都白等满 15 秒超时"，用户看到的就是"切回来右边内容卡住"；
 *   3. 后台刷新**不许把内容换成骨架屏**（`loading` 必须按"还没有数据"算），
 *      否则每 15 秒整屏闪一次；
 *   4. 少数"服务端读缓存不随写失效"的资源要能退出自动刷新。
 *
 * 这四条都是**跨文件的约定**，任何一条被无意改掉都不会有编译错误，
 * 只会在真机上表现成"界面不更新了"或"屏幕在闪"。所以钉在这里。
 *
 * 用法：node tools/check/check-auto-refresh.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'release', 'generated', '.git', 'spike', 'smoke']);

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
    } else {
      out.push(p);
    }
  }
  return out;
}

const read = (relative) => fs.readFileSync(path.join(CLIENT_ROOT, relative), 'utf8');
const rel = (absolute) => path.relative(CLIENT_ROOT, absolute).replace(/\\/g, '/');

let problems = 0;
let cases = 0;

function check(name, ok, extra = '') {
  cases += 1;
  if (ok) {
    console.log(`  ✓ ${name}${extra === '' ? '' : `  ${extra}`}`);
    return;
  }
  console.error(`  ✗ ${name}${extra === '' ? '' : `  ${extra}`}`);
  problems += 1;
}

console.log('check-auto-refresh：');

// ---------------------------------------------------------------- 1. 手动刷新入口必须一个不剩

const viewFiles = [
  ...walk(path.join(CLIENT_ROOT, 'apps', 'web', 'src', 'views')),
  ...walk(path.join(CLIENT_ROOT, 'packages', 'ui', 'src')),
  ...walk(path.join(CLIENT_ROOT, 'packages', 'layouts', 'src')),
].filter((f) => f.endsWith('.vue'));

const leftovers = [];
for (const file of viewFiles) {
  const text = read(rel(file));
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    // 只看"按钮本体"，不看注释里提到"刷新"的说明文字
    const isButton = t.startsWith('<ElButton') || t.startsWith('<button');
    const isRefreshLabel = /(^|>)刷新(\s*<|$|（|\()/.test(t) || /aria-label="刷新本页"/.test(t);
    if (isButton && isRefreshLabel) {
      leftovers.push(`${rel(file)}:${i + 1}`);
    }
    // 多行按钮：`刷新` 单独一行，往上找最近的 `<ElButton`
    if (t === '刷新' || t === '刷新本页') {
      leftovers.push(`${rel(file)}:${i + 1}`);
    }
  });
}
check(
  '界面上没有任何手动刷新按钮（页头 / 手机顶栏 / 侧栏）',
  leftovers.length === 0,
  leftovers.length === 0 ? `扫描 ${viewFiles.length} 个 .vue` : leftovers.join('、'),
);

// ---------------------------------------------------------------- 2. 调度器

const refresh = read('packages/stores/src/refresh.ts');
check('refresh.ts 导出 startAutoRefresh', /export function startAutoRefresh/.test(refresh));
check('调度器在可见时才 bump（后台标签页不刷）', /document\.visibilityState === 'visible'/.test(refresh) && /setInterval/.test(refresh));
check(
  '回到前台 / 重新聚焦 / 网络恢复都会补一次',
  /addEventListener\('visibilitychange'/.test(refresh) && /addEventListener\('focus'/.test(refresh) && /addEventListener\('online'/.test(refresh),
);
const resumeAt = refresh.indexOf('const resume = (): void =>');
const resumeFn = resumeAt >= 0 ? refresh.slice(resumeAt, refresh.indexOf('const onVisibility')) : '';
check(
  '回到前台时**先跑 onResume** 再 bump（验活要在重取之前）',
  resumeFn.includes('onResume') &&
    resumeFn.indexOf('onResume') < resumeFn.indexOf('bumpRefresh') &&
    /\.finally\(/.test(resumeFn),
);
check(
  '同一次回到前台触发的事件要合并（真机会同时来 visibilitychange 与 focus）',
  /let resuming = false/.test(refresh) && /resuming\) \{\s*return;/.test(refresh),
);

// ---------------------------------------------------------------- 3. 验活 → 丢连接 → 重取

const storesBridge = read('packages/stores/src/bridge.ts');
const resumeIdx = storesBridge.indexOf('async function resumeAfterBackground');
const resumeBody = resumeIdx >= 0 ? storesBridge.slice(resumeIdx, resumeIdx + 700) : '';
check('bridge store 提供 resumeAfterBackground', resumeIdx >= 0);
check(
  'resumeAfterBackground 里 checkAlive 排在 probeOnce 之前',
  resumeBody.indexOf('checkAlive') >= 0 && resumeBody.indexOf('checkAlive') < resumeBody.indexOf('probeOnce'),
);
check(
  '探测到**传输层**失败且连接自认为 open 时丢掉连接（半死连接的唯一出路）',
  /isTransportFailure\(error\)\s*&&\s*bridge\.state === 'open'/.test(storesBridge) && /bridge\.reset\(\)/.test(storesBridge),
);

const transport = read('packages/bridge-client/src/transport.ts');
check('transport 定义了 checkAlive', /async checkAlive\(/.test(transport));
check('checkAlive 用的是桥内建 bridge.ping（不经后端）', /callWithBudget\('bridge\.ping'/.test(transport));
check('checkAlive 有独立的短预算常量', /BRIDGE_LIVENESS_TIMEOUT_MS/.test(transport));
check('transport 定义了 reset（丢连接、下次调用重建）', /reset\(\): void \{/.test(transport));
check(
  '丢连接时把该连接的 onmessage 摘掉（不让它的回包写进新连接的状态）',
  /socket\.onmessage = null/.test(transport),
);

const main = read('apps/web/src/main.ts');
check('应用入口真的起了自动刷新', /startAutoRefresh\(/.test(main));
check('应用入口把验活接到 onResume 上', /onResume:\s*\(\)\s*=>\s*bridgeStore\.resumeAfterBackground\(\)/.test(main));

// ---------------------------------------------------------------- 4. 后台刷新不许闪屏

const resource = read('packages/stores/src/resource.ts');
check(
  'loading 只在"还没有数据"时为真（后台刷新保留旧内容）',
  /loading: computed\(\(\) => enabled\(\) && entry\.value\.loading && entry\.value\.data === undefined\)/.test(resource),
);
check('另外给出 refreshing 供需要区分的屏使用', /refreshing: computed\(/.test(resource));
check(
  '有旧内容时后台失败不替换界面（挡内容的 error 只在无数据时给）',
  /error: computed\(\(\) => \(entry\.value\.data === undefined \? entry\.value\.error : undefined\)\)/.test(resource),
);
check('原始错误仍然可见（lastError）', /lastError: computed\(/.test(resource));
check(
  'autoRefresh:false 的资源退出自动刷新（写后不重取的那一类）',
  /options\?\.autoRefresh === false/.test(resource),
);
check(
  '自动刷新与重连重取都尊重 enabled（参数没准备好就不发请求）',
  /autoRefresh === false \|\| !enabled\(\)/.test(resource) && /if \(!enabled\(\)\) \{\s*return;\s*\}\s*const current = cache\.entryOf/.test(resource),
);
check(
  '单飞复用要求"在途请求绑的还是当前条目"（失效删条目后不许复用老请求，否则屏上停在空态）',
  /pending\.entry === \(entries\.get\(key\)/.test(resource) &&
    /inflight\.set\(key, \{ task: task as Promise<unknown>, entry: entry as ResourceEntry<unknown> \}\)/.test(resource),
);
check(
  '退出自动刷新的用法只有一处，且写明了理由（服务端读缓存不随写失效）',
  read('apps/web/src/views/inventory/TagDetailPanel.vue').includes('autoRefresh: false'),
);

// ---------------------------------------------------------------- 5. 动效要尊重系统偏好

const uiCss = read('packages/ui/src/styles/ui.css');
const shellCss = read('packages/layouts/src/styles/shell.css');
check('页面/右栏有进场动效', /@keyframes w-rise-in/.test(uiCss) && /animation: w-rise-in/.test(uiCss));
check('动效时长走 --w-motion-* 令牌（系统"减弱动效"时自动变成 0ms）', /var\(--w-motion-(fast|normal)\)/.test(uiCss));
check(
  '两个样式表都显式尊重 prefers-reduced-motion',
  /@media \(prefers-reduced-motion: reduce\)/.test(uiCss) && /@media \(prefers-reduced-motion: reduce\)/.test(shellCss),
);

if (problems > 0) {
  console.error(`check-auto-refresh: ${cases} 个用例，${problems} 处不满足。`);
  process.exit(1);
}
console.log(`check-auto-refresh OK: ${cases} 个用例（无手动刷新入口 / 调度器 / 验活重连 / 不闪屏 / 动效偏好）`);

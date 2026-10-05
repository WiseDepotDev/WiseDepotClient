import path from 'node:path';
import process from 'node:process';
import { BridgeProcess, type BridgeHandshake } from '../../apps/desktop/src/bridgeProcess.js';
import { bootstrapResponse, resolveWebAsset } from '../../apps/desktop/src/webAssets.js';
// 页面侧期望的协议版本：桌面壳写进引导的那份必须与它一致
// （`check:protocol-version` 把这一致性做成了门禁，这里再验一次"真的写进去了"）
import { BRIDGE_PROTOCOL_VERSION } from '../../packages/bridge-client/src/types.js';
// 假后端与桌面壳的通知自检**共用同一份**（见 notifyStub.ts 的说明）
import { silentStubMessage, startNotifyStub } from '../../apps/desktop/src/notifyStub.js';
// 真加密客户端：第 7 节要用它调 `bridge.humanVerify`（不是"直接构造一条帧"）
import { connectBridge, encodeFrame } from '../lib/bridge-wire.mjs';

/**
 * 桌面宿主逻辑的验收入口（由 tools/bench/desktop-host.mjs 用 esbuild 打包后执行）。
 *
 * 它对着**真的** Gradle 产物跑（真 JVM、真 stdout 握手），因此能验到 Electron 之外的一切：
 * 握手、退出、**崩溃重启**、引导响应、静态资源解析与路径穿越防线，
 * **新消息通知这条链的端到端**（第 6 节），以及**人机验证这条链的端到端**（第 7 节）。
 * 只有"窗口/菜单/打包/系统真的弹了一个气泡"这部分留给人工或 E2E。
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
  record('启动并完成 stdout 握手', hs.port > 0 && hs.psk.length > 30, `port=${hs.port} pid=${hs.pid} ${Date.now() - t0}ms`);
  record('状态机走过 starting → running', states.includes('starting') && states.includes('running'), states.join(' → '));

  console.log('--- 2. 引导响应（与手机壳同一份契约）---');
  const ready = bootstrapResponse(hs);
  const parsed = JSON.parse(ready.body) as { port: number; protocol: number; capabilities: string[] };
  record(
    '桥就绪时 __bridge.json 回 200 且字段齐全',
    ready.status === 200 &&
      parsed.port === hs.port &&
      parsed.protocol === BRIDGE_PROTOCOL_VERSION &&
      Array.isArray(parsed.capabilities),
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
    '子进程被杀后自动重启并拿到**新端口/新 psk**',
    next.port !== portBefore && next.psk !== hs.psk,
    `${portBefore} → ${next.port}`,
  );
  record('重启期间状态机经过 restarting', states.includes('restarting'), states.join(' → '));

  console.log('--- 5. 优雅停止与"不自复活"---');
  const exitCode = await bridge.stop();
  record('stdin shutdown 后正常退出', exitCode === 0, `exit=${exitCode}`);
  await new Promise((r) => setTimeout(r, 1200));
  record('停止后不再重启（主动停止不算崩溃）', bridge.state === 'stopped', `state=${bridge.state}`);

  await notifyChannelCheck();
  await humanVerifyCheck();

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

// ---------------------------------------------------------------- 第 6 节：通知链

/** 桥发给壳的一条事件行（`{"v":1,"type":"event","topic":…,"data":…}`）。 */
interface BridgeEvent {
  topic: string;
  data: {
    count?: number;
    audible?: boolean;
    latest?: { id?: string; title?: string; body?: string; type?: string; priority?: number; at?: string };
  } | null;
}

/**
 * 假后端：**与 `apps/desktop/src/notifyStub.ts` 共用同一份**。
 *
 * 它一开始是在这里内联的（`main.ts` 那边又抄了一份），于是"假后端少了哪个接口"
 * 有两个地方要说 —— 第一次踩坑就是消息详情屏要的 `message.detail` 没实现，
 * 点通知跳过去只看到 `NOT-FOUND`，看起来像深链坏了。现在只有一份。
 */
async function startStubBackend() {
  return await startNotifyStub({ idPrefix: 'BENCH' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等到 `pick()` 有值，或超时返回 null（**超时是失败，不是"跳过"**）。 */
async function waitFor<T>(pick: () => T | undefined, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pick();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(50);
  }
}

/**
 * 第 6 节：新消息通知这条链的端到端验收。
 *
 * 这条链有四段，前三段都**只能在这里验**（静态门禁只能证明"代码写了"）：
 *   后端未读涨 → 桥轮询发现 → stdout 上一行 `type:"event"` → `BridgeProcess` 的 `on('event')`
 *
 * 最后一段"系统真的弹了气泡"验不到（要真桌面），不在这里假装验过 ——
 * 那一步在 `pnpm notify:smoke`（真 Electron，会真的弹两个气泡）。
 */
async function notifyChannelCheck(): Promise<void> {
  console.log('--- 6. 通知事件通道（stub 后端 → 桥 → stdout 事件行）---');
  const stub = await startStubBackend();
  const notify = new BridgeProcess({
    classpath: path.join(LIB_DIR, '*'),
    mainClass: 'com.huicang.wise.bridge.host.desktop.MainKt',
    backendUrl: stub.url,
    version: '1.0.0-notify-bench',
    jvmArgs: ['-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Xms16m', '-Xmx256m'],
    // 轮询压到 250ms：默认 10 秒会让这个用例等十几秒，慢门禁的下场是被跳过
    extraArgs: [
      '--access-token',
      'bench-token',
      '--notify-poll-ms',
      '250',
      '--capabilities',
      'storage.secure,notify.system',
    ],
  });

  const events: BridgeEvent[] = [];
  notify.on('event', (e: BridgeEvent) => events.push(e));

  try {
    const hs = await notify.start();
    record('通知验收用的桥也能正常起（拿到端口与 psk）', hs.port > 0 && hs.psk.length > 30, `port=${hs.port}`);

    // 等"基线已经播过"：至少要看到轮询真的发生了，否则下面那条断言是空的
    const polled = await waitFor(() => (stub.calls.count >= 1 ? true : undefined), 8000);
    record(
      '登录态下桥真的在轮询未读数（不是"没跑所以不弹"）',
      polled === true && stub.calls.user >= 1,
      `user.current=${stub.calls.user} unread-count=${stub.calls.count}`,
    );
    record('开桥不会为历史未读补弹通知（基线播种）', events.length === 0, `事件 ${events.length} 条`);

    stub.setUnread(1);
    const first = await waitFor(() => events[0], 8000);
    record(
      '未读从 0 涨到 1 ⇒ 弹一条 notify.message',
      first !== null && first.topic === 'notify.message',
      first === null ? '超时没有事件' : `topic=${first.topic}`,
    );
    record(
      '事件带的是**最新那条**的标题/正文/类型（不是只报一个数字）',
      first !== null &&
        first.data?.latest?.id === 'BENCH-MSG-1' &&
        first.data?.latest?.title === '设备异常' &&
        first.data?.latest?.body === '读头 3 已离线' &&
        first.data?.latest?.type === 'ALERT',
      JSON.stringify(first?.data?.latest ?? null),
    );
    record(
      'priority>=1 ⇒ 标成"有声"（后端只有告警/巡检这么设）',
      first !== null && first.data?.audible === true && first.data?.count === 1,
      `audible=${String(first?.data?.audible)} count=${String(first?.data?.count)}`,
    );
    record('取最新一条走的是 message.list（拿到标题才可能）', stub.calls.list >= 1, `list=${stub.calls.list}`);

    // 去重：同一条消息在后续若干个轮询周期里**不能再弹**
    await sleep(1200);
    record('同一条消息只弹一次（后续轮询不重复）', events.length === 1, `事件 ${events.length} 条`);

    // 策略表第二种落点：priority==0 ⇒ 弹但静默
    stub.setUnread(2, silentStubMessage('BENCH'));
    const second = await waitFor(() => events[1], 8000);
    record(
      '再来一条新消息 ⇒ 再弹一次（去重不能把新消息一起吃掉）',
      second !== null && second.data?.latest?.id === 'BENCH-MSG-2',
      second === null ? '超时没有第二条事件' : `id=${String(second.data?.latest?.id)}`,
    );
    record(
      'priority==0 ⇒ 弹但静默（silent，不进声音/震动渠道）',
      second !== null && second.data?.audible === false && second.data?.count === 2,
      `audible=${String(second?.data?.audible)} count=${String(second?.data?.count)}`,
    );

    // 轮询必须是**持续的**：只跑一轮就断的实现（例如异常把调度器吃掉）也能通过上面所有断言
    const beforeStop = stub.calls.count;
    await sleep(600);
    record(
      '轮询是"持续"的（不是只在第一轮跑一次就断）',
      stub.calls.count > beforeStop,
      `${beforeStop} → ${stub.calls.count}`,
    );
  } finally {
    await notify.stop();
    await stub.close();
  }
}

// ---------------------------------------------------------------- 第 7 节：人机验证链

/**
 * 发一条请求并等它的应答（工具侧的 `connectBridge` 给的是"像 WebSocket 的句柄"，
 * 没有 promise 版的 call，所以这里按帧自己配对）。
 *
 * **`ev.data` 已经是逻辑帧**：`connectBridge` 在内部的 `ws.onmessage` 里就解封并
 * `decodeFrame` 过了。我第一版在这里又 `openFrame` 了一次，异常被 catch 吞掉，
 * 表现成"桥明明回了、客户端却等到超时" —— 所以这里只读字段，不再解一次。
 */
function callOnce(
  wire: {
    send: (bytes: Uint8Array) => void;
    addEventListener: (t: string, cb: (ev: { data: unknown }) => void) => void;
  },
  id: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${method} 的应答超时（${timeoutMs}ms）`)), timeoutMs);
    wire.addEventListener('message', (ev: { data: unknown }) => {
      const frame = ev.data as { type?: string; id?: string; data?: Record<string, unknown>; error?: unknown };
      if (frame.type === 'res' && frame.id === id) {
        clearTimeout(timer);
        resolve(frame.data ?? null);
      }
      // 错误也要**立刻**返回原因：只等 `res` 会把"被拒了"伪装成"超时"，那是最难查的假象
      if (frame.type === 'err' && frame.id === id) {
        clearTimeout(timer);
        reject(new Error(`桥回了错误：${JSON.stringify(frame.error ?? null)}`));
      }
    });
    wire.send(encodeFrame({ type: 'req', id, method, params }));
  });
}

/**
 * 第 7 节：人机验证那条链的端到端验收（S2b 新增的"桥问壳答"协议）。
 *
 * 这一节验的是**别处验不到的一段**：桥要向**壳**（父进程）索要本地环境证据。所以 bench
 * 扮演父进程：它必须像 Electron 主进程那样回一条带同样 id 的答复，然后才看得到验证走完。
 *
 * 断了任何一段都会红：
 *   · 桥没发 `evidence-request` / 壳不回 ⇒ 桥按空证据继续，服务端永远收不到 `shellPackaged`；
 *   · 桥没把证据放进 `human.verify` 的请求体 ⇒ 最后那条断言红；
 *   · 没签名 / 没公钥 ⇒ 真服务端会拒，这里用假后端也照样断言字段在不在。
 */
async function humanVerifyCheck(): Promise<void> {
  console.log('--- 7. 人机验证（桥问壳答 + 设备密钥签名 + 票据）---');
  const stub = await startStubBackend();
  const notify = new BridgeProcess({
    classpath: path.join(LIB_DIR, '*'),
    mainClass: 'com.huicang.wise.bridge.host.desktop.MainKt',
    backendUrl: stub.url,
    version: '1.0.0-human-bench',
    jvmArgs: ['-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Xms16m', '-Xmx256m'],
    extraArgs: [
      '--access-token',
      'bench-token',
      '--notify-poll-ms',
      '0',
      '--capabilities',
      'storage.secure,human.verify',
    ],
    // 这里就是"壳"：桥问什么，这里答什么（与 Electron 主进程的 desktopEvidence 同一形状）
    evidenceProvider: () => ({ shellPackaged: true, debugAttached: false }),
  });
  // 桥的 stderr 原样转发（这一节排障时它是唯一的线索，不许吞掉）
  notify.on('log', (line: string) => {
    if (/human|人机|设备密钥/.test(line)) {
      console.log(`    ${line.trim()}`);
    }
  });

  try {
    const hs = await notify.start();
    record('人机验证用的桥起得来（拿到端口与 psk）', hs.port > 0 && hs.psk.length > 30, `port=${hs.port}`);

    // 用**真**加密客户端调 `bridge.humanVerify`（内建方法，票据留在桥里，不回给页面）
    const wire = await connectBridge(`ws://127.0.0.1:${hs.port}/bridge`, { psk: hs.psk });
    const answer = await callOnce(wire, 'human-1', 'bridge.humanVerify', { purpose: 'LOGIN', username: 'operator' });
    wire.close();

    record('`bridge.humanVerify` 能调通（真加密连接 + 内建方法）', answer?.ok === true, JSON.stringify(answer));
    record(
      '桥真的走了"申请挑战 → 提交验证"两步',
      stub.calls.challenge >= 1 && stub.calls.verify >= 1,
      `challenge=${stub.calls.challenge} verify=${stub.calls.verify}`,
    );

    const body = stub.lastHumanVerify.current;
    record(
      '`human.verify` 带了设备公钥与签名（不是光着提交的）',
      typeof body?.signature === 'string' && typeof body?.devicePublicKey === 'string',
      Object.keys(body ?? {}).join(', '),
    );
    record(
      '公钥 130 hex、指纹 32 hex（服务端会重算指纹比对）',
      String(body?.devicePublicKey ?? '').length === 130 && String(body?.deviceKeyId ?? '').length === 32,
      `pub=${String(body?.devicePublicKey ?? '').length} keyId=${String(body?.deviceKeyId ?? '').length}`,
    );
    record(
      '**壳的证据真的到了服务端**（`shellPackaged` 来自 evidenceProvider）',
      (body?.evidence as { shellPackaged?: boolean } | undefined)?.shellPackaged === true,
      JSON.stringify(body?.evidence ?? null),
    );
    record('提交里带 purpose（服务端据此判用途，票据不能串用）', body?.purpose === 'LOGIN', String(body?.purpose));
  } finally {
    await notify.stop();
    await stub.close();
  }
}

void main().catch((e: Error) => {
  console.error(`desktop-host bench 失败：${e.message}`);
  process.exit(1);
});

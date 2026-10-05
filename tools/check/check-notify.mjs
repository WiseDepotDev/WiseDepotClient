#!/usr/bin/env node
/**
 * check-notify.mjs —— **系统级消息通知**的门禁。
 *
 * ## 为什么需要它
 *
 * 通知这条链横跨四个地方，而且**任何一处单独改坏了都不会有编译错误**：
 *
 * ```
 * 桥（Kotlin）UnreadNotifier ──事件──▶ 壳（Android 同进程 / 桌面走 stdout 行）
 *                                          └─▶ 系统通知（渠道 / 权限 / 点击深链）
 * ```
 *
 * 最容易静默失效的六件事：
 *   1. 能力声明与实现脱节（声明了却弹不出来，或者能弹但界面不知道）；
 *   2. Android 13+ 没声明 `POST_NOTIFICATIONS`，或没建通知**渠道**（渠道不存在＝通知静默消失）；
 *   3. Windows 上没设 AppUserModelId（未打包的 Electron **静默不显示** toast）；
 *   4. 有人图省事把渲染进程的通知权限打开 —— 那会让"弹通知"出现两个所有者；
 *   5. 深链前缀三处不一致（点了通知跳到 404 或首页）；
 *   6. **后端新增 `MessageType` 枚举值而客户端没有落点** → 从此那类消息一声不响。
 *
 * 用法：node tools/check/check-notify.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(CLIENT_ROOT, relative), 'utf8');

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

console.log('check-notify：');

const notifier = read('bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/UnreadNotifier.kt');
const bridgeServer = read('bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/BridgeServer.kt');

// ---------------------------------------------------------------- 1. 桥侧：轮询与去重

check('桥侧有未读轮询器（UnreadNotifier）', /class UnreadNotifier/.test(notifier));
check(
  '轮询靶子是最便宜的 message.unreadCount（不是每次拉整张列表）',
  /UNREAD_COUNT: String = "message\.unreadCount"/.test(notifier),
);
check(
  '事件 topic 是 notify.message',
  /TOPIC_MESSAGE: String = "notify\.message"/.test(notifier),
);
check(
  '**第一次轮询只播种基线**（不然一开应用就为历史消息刷一串通知）',
  /baselineSeeded/.test(notifier) && /只播种/.test(notifier),
);
check('按消息 id 去重（同一条只弹一次）', /notified\.add\(id\)/.test(notifier));
check(
  '未登录一个请求都不发（否则 401 刷屏）',
  /if \(!session\.authenticated\)/.test(notifier),
);
check(
  '轮询间隔默认 10 秒，且 0 = 关闭（测试/bench 不为后台流量买单）',
  /val notifyPollMs: Long = 10_000/.test(bridgeServer) && /if \(pollMs <= 0/.test(notifier),
);
check(
  '桥有进程内事件观察者钩子（壳不是 WebSocket 客户端）',
  /fun onEvent\(handler: \(String, JsonElement\?\) -> Unit\)/.test(bridgeServer) && /eventObservers/.test(bridgeServer),
);
check(
  '"有人在用"时立刻补算一次（kick），且节流 —— 否则一次界面刷新会自己打自己',
  /fun kick\(\)/.test(notifier) && /KICK_MIN_INTERVAL_MS/.test(notifier),
);

// ---- 1.1 八类 MessageType 都必须有落点（后端加枚举值 ⇒ 这里必须红）----
const messageTypes = ['SYSTEM', 'TASK', 'INVENTORY', 'APPROVAL', 'REMINDER', 'NOTIFICATION', 'ALERT', 'INSPECTION'];
const missing = messageTypes.filter((t) => !notifier.includes(`"${t}"`));
check(
  '八类 MessageType 在策略里都有落点（后端新增枚举值时不许静默失效）',
  missing.length === 0,
  missing.length === 0 ? `${messageTypes.length} 类齐全` : `缺 ${missing.join('、')}`,
);
check(
  '未知 type 也仍然发事件（宁多勿漏）',
  /else -> "未知类型"/.test(notifier) && /未知 type 也要说|未知类型也返回 notify=true|宁可多弹/.test(notifier),
);
check(
  'policy 缺省 notify=true（缺字段不弹是最难发现的一类退化）',
  /val notify: Boolean = true/.test(notifier),
);

// ---------------------------------------------------------------- 2. 桌面壳

const desktopProc = read('apps/desktop/src/bridgeProcess.ts');
const desktopMain = read('apps/desktop/src/main.ts');
const desktopNotify = read('apps/desktop/src/notifications.ts');

/*
 * 通知自检的入口（`pnpm notify:smoke`）必须一直在。
 *
 * 它验的是这个门禁**验不到的那一半**：真 Electron + 真桥 + 真 Windows toast。
 * 一个只能靠"记得手动跑"的脚本会烂掉 —— 所以这里只钉三件事：主进程认这个开关、
 * 启动脚本会把它传下去、npm script 有名字。至于"气泡有没有出现在屏幕上"，只能人看。
 */
const desktopScript = read('scripts/desktop.ps1');
const pkgJsonRaw = read('package.json');
const notifyStubTs = read('apps/desktop/src/notifyStub.ts');
const benchEntryTs = read('tools/bench/desktop-host-entry.ts');
check(
  '主进程认 `--notify-smoke`（真机通知自检的开关）',
  /NOTIFY_SMOKE\s*=\s*process\.argv\.includes\('--notify-smoke'\)/.test(desktopMain),
);
check(
  '启动脚本把 `-NotifySmoke` 透传给 Electron（否则开关传不进去）',
  /\[switch\]\$NotifySmoke/.test(desktopScript) && /\$args \+= '--notify-smoke'/.test(desktopScript),
);
check(
  '`pnpm notify:smoke` 存在（想亲眼看一次气泡时有入口）',
  /"notify:smoke"/.test(pkgJsonRaw),
);
check(
  '自检用的假后端回**真信封**（否则验的是"能不能骗过桥的解析"）',
  /payload: \{ code: 'RES-0000'/.test(notifyStubTs) && /RES-0000/.test(notifyStubTs),
);
check(
  '假后端是**共享一份**的（桌面自检与 bench:desktop 都 import 它，不许各抄一份）',
  /from '\.\/notifyStub'/.test(desktopMain) &&
    /from '\.\.\/\.\.\/apps\/desktop\/src\/notifyStub\.js'/.test(benchEntryTs) &&
    !/const send = \(data: unknown\)/.test(benchEntryTs),
);
check(
  '假后端实现了**详情屏要的那两个接口**（缺了就会出现"点通知跳过去是 NOT-FOUND"）',
  // ① 详情：`/api/messages/{messageId}`；② 已读：`/api/messages/{messageId}/read`
  /url\.pathname\.startsWith\('\/api\/messages\/'\)/.test(notifyStubTs) && /endsWith\('\/read'\)/.test(notifyStubTs),
);
check(
  '假后端对未实现的路径**显眼地失败**（STUB-NOT-IMPLEMENTED，不是静默 200 空对象）',
  /STUB-NOT-IMPLEMENTED/.test(notifyStubTs),
);

check(
  '桌面壳声明 notify.system 能力（声明即承诺）',
  /notify\.system/.test(desktopProc),
);
check(
  '桥事件经 stdout 事件行送到主进程（握手行之后仍然继续解析）',
  /parsed\.type === 'event'/.test(desktopProc) && /this\.emit\('event'/.test(desktopProc),
);
check(
  '**主进程**弹通知（不是渲染进程的 Notification API）',
  /new Notification\(options\)/.test(desktopNotify) && /from 'electron'/.test(desktopNotify),
);
check(
  'Windows 上设了 AppUserModelId（未打包的 Electron 不设它 toast 静默不显示）',
  /setAppUserModelId\(/.test(desktopMain),
);
check(
  '前台可见时不弹（界面自己会刷新）',
  /win\.isVisible\(\)\s*&&\s*win\.isFocused\(\)/.test(desktopNotify),
);
check(
  '按 audible 决定静不静音（priority>=1 才有声）',
  /silent = event\.audible !== true/.test(desktopNotify),
);
check(
  '点击通知用 location.hash 深链（loadURL 会整页重载、丢掉登录态）',
  /location\.hash = '#\$\{MESSAGE_ROUTE_PREFIX\}/.test(desktopNotify),
);
check(
  '桌面权限处理器**仍然只放行 media**（防止出现两个通知所有者）',
  /allowed = permission === 'media' && isOurOrigin\(asking\)/.test(desktopMain),
);

// ---------------------------------------------------------------- 3. Android 壳

const manifest = read('apps/mobile/shell/src/main/AndroidManifest.xml');
const androidNotify = read('apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/MessageNotifier.kt');
const shellBridge = read('apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/ShellBridge.kt');
const mainActivity = read('apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/MainActivity.kt');

check('Android 清单声明 POST_NOTIFICATIONS（13+ 是运行时权限）', /POST_NOTIFICATIONS/.test(manifest));
check(
  '两个通知渠道（有声 / 静默）且真的建了（渠道不存在＝通知静默消失）',
  /CHANNEL_AUDIBLE/.test(androidNotify) && /CHANNEL_SILENT/.test(androidNotify) && /createNotificationChannel/.test(androidNotify) && /IMPORTANCE_HIGH/.test(androidNotify),
);
check(
  'Android 用 NotificationManager 弹，并在无权限 / 前台时不弹（返回 false 可解释）',
  /NotificationManagerCompat\.from\(context\)\.notify/.test(androidNotify) && /permissionGranted\(context\)/.test(androidNotify) && /if \(foreground\)/.test(androidNotify),
);
check(
  'Android 声明 notify.system，且权限被拒时**撤回**能力声明',
  /BridgeCapabilities\.NOTIFY_SYSTEM/.test(shellBridge) && /revokeCapability\(\s*com\.huicang\.wise\.bridge\.protocol\.BridgeCapabilities\.NOTIFY_SYSTEM/.test(mainActivity),
);
check(
  'Android 请求通知权限（13+）并在 onNewIntent 处理深链（否则第二次点通知没反应）',
  /POST_NOTIFICATIONS/.test(mainActivity) && /override fun onNewIntent/.test(mainActivity),
);
check(
  '前台标志由 onResume/onPause 维护（前台不弹系统通知）',
  /ShellBridge\.foreground = true/.test(mainActivity) && /ShellBridge\.foreground = false/.test(mainActivity),
);
check(
  '壳订阅桥的 notify.message 事件（同进程，不经过 WebView）',
  /instance\.onEvent/.test(shellBridge) && /UnreadNotifier\.TOPIC_MESSAGE/.test(shellBridge),
);

// ---------------------------------------------------------------- 4. 深链前缀三处一致

const navigation = read('packages/layouts/src/navigation.ts');
const navPathMatch = navigation.match(/primaryMethod: 'message\.list',\s*path: '([^']+)'/);
const navPath = navPathMatch ? navPathMatch[1] : '';
const desktopPrefix = (desktopNotify.match(/MESSAGE_ROUTE_PREFIX[^=]*=\s*'([^']+)'/) ?? [])[1] ?? '';
const androidPrefix = (androidNotify.match(/MESSAGE_ROUTE_PREFIX: String = "([^"]+)"/) ?? [])[1] ?? '';
check(
  '深链前缀三处一致（Web 路由 / 桌面壳 / Android 壳）',
  navPath !== '' && desktopPrefix === `${navPath}/` && androidPrefix === `${navPath}/`,
  `导航 ${navPath} · 桌面 ${desktopPrefix} · 安卓 ${androidPrefix}`,
);

// ---------------------------------------------------------------- 5. 两个壳都不要自己再定义轮询间隔

check(
  '轮询间隔只有桥一个所有者（两个壳都不许各写一个默认值）',
  !/notifyPollMs\s*=/.test(desktopProc) && !/notifyPollMs\s*=/.test(shellBridge) && !/notifyPollMs\s*=/.test(androidNotify),
);

// ---------------------------------------------------------------- 6. 端到端才逼得出来的两个真 bug
//
// 这一节的两条都是"代码看起来完全正常、静态上无从判断、只有真跑一遍才露出来"的坑。
// 它们各自被 `pnpm bench:desktop` 第 6 节抓住过一次，这里再钉成静态门禁：
// 门禁便宜，所以宁可重复一句话，也不要再让它们回来。

/*
 * 6.1 观察者不能被"没有 WebSocket 连接"挡掉。
 *
 * `emit()` 原先在 `channels.isEmpty()` 时直接 return，于是**页面还没连上 / 窗口已经关掉**时
 * 壳一次都收不到 —— 而"应用不在前台"正是系统通知唯一有意义的场景：通知静默消失，
 * 没有日志、没有报错。判据是**顺序**：观察者那一段必须出现在任何早退之前。
 *
 * 比较前先去掉注释：这段代码的注释里**本来就在讲** `channels.isEmpty()` 与 `return`
 * （解释这个 bug 曾经长什么样），不去掉就会拿注释当代码 —— 门禁自己被骗，比没有门禁更糟。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const emitBody = (bridgeServer.match(/fun emit\([\s\S]*?\n    \}/) ?? [''])[0];
const emitCode = stripComments(emitBody);
const observerAt = emitCode.indexOf('eventObservers');
const earlyExits = ['return', 'channels.isEmpty()', 'plain?.let']
  .map((needle) => emitCode.indexOf(needle))
  .filter((i) => i >= 0);
const firstExitAt = earlyExits.length === 0 ? -1 : Math.min(...earlyExits);
check(
  'emit() 里观察者先于任何早退（没连 WebSocket 时壳也要收到通知）',
  emitBody !== '' && observerAt >= 0 && (firstExitAt === -1 || observerAt < firstExitAt),
  emitBody === '' ? '找不到 emit()（门禁自己要能定位，不能静默通过）' : `观察者@${observerAt} 首个早退@${firstExitAt}`,
);

/*
 * 6.2 宿主 stdout 必须是 UTF-8。
 *
 * JVM 默认用平台编码（Windows 中文机是 GBK）写 stdout，而父进程按 UTF-8 逐行读 ——
 * 中文标题到壳里就是乱码，通知弹出来但文案不可读。握手那行纯 ASCII，所以这个 bug
 * 在只看握手的验收里永远不出现。
 */
const hostMainKt = read('bridge/host-desktop/src/main/kotlin/com/huicang/wise/bridge/host/desktop/Main.kt');
check(
  '宿主把 stdout/stderr 显式设成 UTF-8（否则中文标题到壳里是乱码）',
  /System\.setOut\(PrintStream\(FileOutputStream\(FileDescriptor\.out\),\s*true,\s*"UTF-8"\)\)/.test(hostMainKt) &&
    /System\.setErr\(PrintStream\(FileOutputStream\(FileDescriptor\.err\),\s*true,\s*"UTF-8"\)\)/.test(hostMainKt),
);

if (problems > 0) {
  console.error(`check-notify: ${cases} 个用例，${problems} 处不满足。`);
  process.exit(1);
}
console.log(`check-notify OK: ${cases} 个用例（桥轮询与去重 / 八类落点 / 桌面 Toast / 安卓渠道与权限 / 深链一致）`);

import { app, BrowserWindow, Menu, Notification, protocol, net, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { BridgeProcess, type BridgeHandshake } from './bridgeProcess';
import { bootstrapResponse, resolveWebAsset } from './webAssets';
import { notifyMessage, MESSAGE_ROUTE_PREFIX, type NotifyMessageEvent } from './notifications';
import { silentStubMessage, startNotifyStub as startNotifyStubShared, type NotifyStub } from './notifyStub';
import { desktopEvidence } from './humanVerify';

/**
 * 桌面宿主主进程。
 *
 * 它只做四件事：**spawn 桥进程 / 供 Web 产物 / 供 `__bridge.json` / 管生命周期**。
 * 业务能力一律在桥里（架构不变式 2：Web 与原生之间只有 WS 一条契约，这里没有例外）。
 *
 * 启动顺序刻意是"**并行**"而不是串行（性能预算：冷启动到可交互 ≤2.5s）：
 * 建窗与 spawn 桥同时进行，窗口先显示"正在连接本地桥"，握手完成后再由 Web 自己去连。
 */

/** 自定义协议名。它同时是 Origin 白名单里的一项（`app://wise`），两端必须一致。 */
const SCHEME = 'app';
const HOST = 'wise';
const ORIGIN = `${SCHEME}://${HOST}`;

/**
 * **必须在 app ready 之前**把自定义协议登记为"标准 + 安全 + 支持 fetch"。
 *
 * 不登记的话，`loadURL('app://wise/index.html')` 能成功，但渲染进程里
 * `fetch('app://wise/__bridge.json')` 会直接抛 `Failed to fetch` ——
 * 这正是 W3 首次跑 Windows 自检时踩到的现象（页面一片空白、控制台只有一句 Failed to fetch）。
 *
 * 四个特权各自的作用：
 *   standard     —— 有正常的 origin 语义（否则 origin 是 opaque，CSP 与相对路径都会怪怪的）
 *   secure       —— 算安全上下文（WebSocket、Crypto 等 API 才可用）
 *   supportFetchAPI —— 允许 fetch/XHR（引导接口就靠它）
 *   corsEnabled  —— 让 CORS 规则生效而不是一律拒绝
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/** 打包后 Web 产物在 resources/web；开发态在 ../../web/dist。 */
function resolveWebRoot(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'web');
  if (fs.existsSync(packaged)) {
    return packaged;
  }
  return path.resolve(__dirname, '..', '..', 'web', 'dist');
}

/**
 * Code128「TAG-0001」的条空图案（`[x, 宽度]`，画布 132×50）。
 *
 * 由 `zxing-wasm` 的 writer 生成（`writeBarcode('TAG-0001', {format:'Code128'})` 的 SVG 路径），
 * 并且**用 reader 解回过原值**才写进这里 —— 自检拿它当"真条码"，图案错了会让断言永远红。
 */
const SCAN_BARCODE_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [10, 2], [13, 1], [16, 1], [21, 2], [24, 3], [30, 1], [32, 1], [34, 1], [38, 2], [43, 2],
  [46, 1], [50, 1], [54, 1], [57, 2], [60, 3], [65, 1], [67, 3], [71, 4], [76, 2], [79, 2],
  [83, 2], [87, 2], [91, 2], [94, 2], [98, 1], [100, 2], [104, 1], [109, 2], [114, 3], [118, 1],
  [120, 2],
];

/**
 * 找出打包出来的 ZXing wasm（回退识别引擎的字节）。
 *
 * 自检据此断言"那 953KB 真的随包发出、并且能被 `app://` 读到"：
 * zxing-wasm **默认从 jsDelivr CDN 拉 wasm**，而装在现场机器上的应用断网是常态 ——
 * 于是"回退路径在离线机器上走不走得通"必须是一条**能红**的断言，而不是一句注释。
 */
function findZxingWasm(): string | null {
  try {
    const dir = path.join(resolveWebRoot(), 'assets');
    const hit = fs.readdirSync(dir).find((n) => n.startsWith('zxing_reader') && n.endsWith('.wasm'));
    return hit === undefined ? null : `assets/${hit}`;
  } catch {
    // 产物还没构建（或结构变了）：返回 null，自检那条断言会红，而不是静默跳过
    return null;
  }
}

/**
 * 找出回退识别引擎的**代码 chunk**（`import('zxing-wasm/reader')` 的产物）。
 *
 * 自检会真的把它 `import()` 一次，断言 `readBarcodes` / `prepareZXingModule` 都在 ——
 * 这证明"回退路径的模块在 `app://` 下加载得起来、API 形状与适配器一致"，
 * 也就是**真机解码前的最后一环**（真正的解码要一张实物条码，那一步只能人工走查）。
 *
 * 判据用 `readBarcodesFromPixmap`：它是 wasm 胶水层挂在模块对象上的**属性名**
 * （压缩不会改名），比"找文件名里有 zxing 的那个"稳。
 */
function findZxingReaderChunk(): string | null {
  try {
    const dir = path.join(resolveWebRoot(), 'assets');
    const hit = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.js'))
      .find((n) => fs.readFileSync(path.join(dir, n), 'utf8').includes('readBarcodesFromPixmap'));
    return hit === undefined ? null : `assets/${hit}`;
  } catch {
    return null;
  }
}

/** 打包后 jlink 运行时在 resources/runtime；开发态直接用 PATH 里的 java + Gradle 产物。 */
function resolveBridgeCommand(): { javaCommand: string; classpath: string } {
  const runtimeJava = path.join(process.resourcesPath ?? '', 'runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const packagedLib = path.join(process.resourcesPath ?? '', 'bridge', 'lib', '*');
  if (fs.existsSync(runtimeJava) && fs.existsSync(path.dirname(packagedLib))) {
    return { javaCommand: runtimeJava, classpath: packagedLib };
  }
  return {
    javaCommand: 'java',
    classpath: path.resolve(__dirname, '..', '..', '..', 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib', '*'),
  };
}

let bridge: BridgeProcess | null = null;
let handshake: BridgeHandshake | null = null;

/**
 * 已经处理过的通知事件（最近 50 条）。
 *
 * 生产路径只多了一次 push（可忽略），换来的是**排障与自检看得见的证据**：
 * 现场只有 `[notify] 已弹系统通知` 一行，问"弹的是哪一条、文案对不对"就没法回答了。
 */
const notifyHistory: { data: NotifyMessageEvent; shown: boolean }[] = [];
let mainWindow: BrowserWindow | null = null;

/**
 * `app://wise` 的判据。
 *
 * **不能用 `new URL(url).origin`**：`app:` 不是 URL 标准里的 special scheme，
 * 主进程（Node 的 URL 实现）会给它返回**字符串 `'null'`**（Chromium 里才是真正的 origin）。
 * 第一版就是这么写的，自检第一次跑就红了：
 * `[perm] media 请求（null）→ 拒绝` —— 于是相机永远打不开，而"点了没反应"正是要避免的那个表现。
 */
function isOurOrigin(value: string): boolean {
  return value === ORIGIN || value.startsWith(`${ORIGIN}/`);
}

/**
 * 权限决定的流水账（B1/S2c）。
 *
 * 自检据此断言"处理器**真的被调用过**"，而不是"这段代码写了就算" ——
 * 相机权限这类东西最容易的状态就是"代码在、但根本没走到"。
 */
const permissionLog: string[] = [];

/**
 * 权限处理器：**只放行本应用 origin 的 `media`**。
 *
 * ## 为什么必须显式写（brief §7.1 / §8.3）
 *
 * 相机扫码的整条链路里，唯一会触发权限请求的就是 `getUserMedia`。
 * 没有处理器时，"被拒"与"失败"对用户是同一个表现：点了没反应 ——
 * 本项目在手机 WebView 上已经吃过一次同类（`MainActivity.kt:203` 因此主动撤销了能力）。
 *
 * ## 三条规矩
 *
 * 1. **只放行 `media`**：这是个装本地产物的壳，渲染进程不需要剪贴板/定位/通知；
 *    "一律放行"等于把本地应用变成一个任何被注入脚本都能开摄像头的东西。
 * 2. **只放行 `app://wise`**：窗口里不该有第二个 origin（外链一律交给系统浏览器）。
 * 3. **记录决定**：现场排障时要能分清"我们自己拒了"还是"系统拒了"，
 *    所以每次请求都留一行 `[perm]` 日志，并进 [permissionLog] 供自检读。
 */
function registerPermissionHandlers(): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    // 用完整 URL 判（请求处理器拿到的是 webContents 当前的 URL）
    const asking = webContents?.getURL() ?? '';
    const allowed = permission === 'media' && isOurOrigin(asking);
    permissionLog.push(`${permission}@${asking === '' ? 'unknown' : asking}=${allowed ? 'allow' : 'deny'}`);
    // 日志走主进程 stdout：`scripts/desktop.ps1` 会原样打出来，
    // 用户说"相机点了没反应"时，先看这一行有没有出现、是 allow 还是 deny。
    console.log(`[perm] ${permission} 请求（${asking === '' ? 'unknown' : asking}）→ ${allowed ? '允许' : '拒绝'}`);
    callback(allowed);
  });

  /*
   * `setPermissionCheckHandler` 管的是**同步检查**：`navigator.permissions.query`、
   * 以及部分 Chromium 版本在真正开流之前的预检。
   *
   * 两条处理器判据必须**完全一致**，否则会出现"query 说 granted、开流却失败"
   * 这种最难查的组合（页面据此显示的东西和实际能力对不上）。
   * 注意这一条拿到的是 **origin**（`app://wise`），不是完整 URL。
   */
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permission === 'media' && isOurOrigin(requestingOrigin));
}

async function startBridge(): Promise<void> {
  const { javaCommand, classpath } = resolveBridgeCommand();
  bridge = new BridgeProcess({
    javaCommand,
    classpath,
    mainClass: 'com.huicang.wise.bridge.host.desktop.MainKt',
    backendUrl: process.env.WISE_BACKEND_URL ?? 'http://127.0.0.1:18080',
    version: app.getVersion(),
    // 令牌落盘**必须由真正的宿主显式指定**，而不是宿主自己猜一个路径。
    //
    // 为什么：所有 bench / 冒烟脚本都会 spawn 同一个宿主 jar。如果落盘路径是写死的默认值，
    // 那些脚本一旦登录就会把凭据写进**用户的会话文件** —— 下次开应用会莫名其妙地
    // 以 operator 身份登着。所以宿主的默认行为是"不落盘"，持久化由这里opt-in。
    //
    // 落点用 Electron 的 userData：那是这个应用自己的、按用户隔离的目录，
    // 比在 LOCALAPPDATA 下再拼一个名字更不容易和别的东西撞。
    //
    // **自检模式不落盘**：自检断言"应当渲染出登录屏"，而那要求桥是未登录状态。
    // 一旦沿用用户的会话文件，这个断言就变成"取决于这台机器上有没有登录过" ——
    // 自检必须封闭可重复，不能依赖环境（踩过一次：登录过之后自检就红了）。
    extraArgs: NOTIFY_SMOKE
      ? [
          // 通知自检：**预置一个令牌**让桥认为已登录（否则它一个请求都不发），
          // 并把轮询压到 400ms —— 10 秒一轮的自检要等十几秒，慢门禁的下场是被跳过。
          '--access-token',
          'notify-smoke',
          '--notify-poll-ms',
          '400',
        ]
      : SMOKE
        ? []
        : [
            '--token-file',
            join(app.getPath('userData'), 'bridge-session.enc'),
            // 设备密钥与令牌分开存（生命周期不同：登出清令牌，不该顺手清掉设备身份）
            '--device-key-file',
            join(app.getPath('userData'), 'bridge-device-key.enc'),
          ],
    /*
     * 桥问壳要"本地环境证据"时由这里回答（人机验证用）。
     *
     * 为什么必须在**主进程**：`app.isPackaged` 与启动开关都只在这里可见；
     * 页面拿不到，也因此没法伪造它们（虽然它们本身也只是证据，见 `humanVerify.ts`）。
     */
    evidenceProvider: desktopEvidence,
    // jlink + AppCDS 的启动优化放在这里，而不是写死在宿主里：
    // 宿主是"一份"，它的启动参数属于"桌面这一侧的托管方式"。
    //
    // `-Dfile.encoding=UTF-8` 等三项不是可选项：JVM 在中文 Windows 上默认用 GBK 写 stderr，
    // 而主进程按 UTF-8 解码 —— 结果是**桥的中文日志全部变成乱码**，
    // 刚加的排障日志（自检/握手被拒/前端已连接）等于白打。
    jvmArgs: [
      '-XX:+UseSerialGC',
      '-XX:TieredStopAtLevel=1',
      '-Xms16m',
      '-Xmx256m',
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
    ],
  });

  // 不重复加前缀：桥自己的日志已经以 `[bridge] ` 开头（那是它写给人看的一部分），
  // 再套一层会变成 `[bridge] [bridge] …` —— 噪音虽小，但每条日志都多一层。
  bridge.on('log', (line: string) => console.log(line.trimEnd()));
  bridge.on('exit', (info: { code: number | null; intentional: boolean }) => {
    if (!info.intentional) {
      console.error(`[bridge] 桥进程异常退出 code=${info.code}`);
    }
    handshake = null;
  });
  /*
   * 桥的事件 → **系统通知**。
   *
   * 为什么不走渲染进程：通知最该出现的时刻界面不在前台，那时页面 JS 可能已被节流/冻结；
   * 而且主进程的 Notification 不需要权限（渲染进程那条路被权限处理器有意挡着，见 `registerPermissionHandlers`）。
   */
  bridge.on('event', (event: { topic: string; data: unknown }) => {
    if (event.topic !== 'notify.message') {
      return;
    }
    const data = (event.data ?? {}) as NotifyMessageEvent;
    const shown = notifyMessage({ window: mainWindow }, data);
    // "没弹"必须能解释：前台可见时不弹是**故意**的
    console.log(`[notify] ${shown ? '已弹系统通知' : '未弹（前台可见 / 缺标题）'}`);
    /*
     * 留一份证据。
     *
     * `[notify]` 那行只说"弹/没弹"，而 `--notify-smoke` 要断言的是"弹的是哪一条、文案有没有乱码"。
     * 记下来比事后猜便宜：真机现场只有这一份日志。
     */
    notifyHistory.push({ data, shown });
    if (notifyHistory.length > 50) {
      notifyHistory.shift();
    }
  });

  handshake = await bridge.start();
  console.log(`[bridge] ready port=${handshake.port} pid=${handshake.pid}`);
}

function registerAppProtocol(): void {
  const webRoot = resolveWebRoot();
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);

    // 引导接口：与手机壳同一条路径、同一份契约（未就绪回 503）
    if (url.pathname === '/__bridge.json') {
      const res = bootstrapResponse(handshake);
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': res.contentType, 'cache-control': 'no-store' },
      });
    }

    const asset = resolveWebAsset(webRoot, url.pathname);
    if (!asset) {
      return new Response('Not Found', { status: 404 });
    }
    return await net.fetch(`file://${asset.absolutePath.replace(/\\/g, '/')}`);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    backgroundColor: '#F5F7FB',
    show: false,
    webPreferences: {
      // 桥是唯一通道，因此渲染进程不需要任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      /*
       * **关掉后台节流**（v5 起必需）。
       *
       * 桥会把读空闲超过 60 秒的连接关掉，而客户端的"保活"是后台才发的
       * （`BRIDGE_KEEPALIVE_INTERVAL_MS`，见 transport.ts）：Chromium 对隐藏页面有定时器节流
       * ——隐藏 5 分钟后会降到约**每分钟一次**，那样保活就赶不上 60 秒的读空闲，
       * 切回来照样是一次重连。关掉节流之后保活才真的每 30 秒发得出去，
       * 于是"切到后台再切回来"不再需要重连。
       *
       * 代价：窗口被遮挡/最小化时这个渲染进程不再被降频。本应用只有一个窗口、
       * 且后台时几乎不干活（探测与自动刷新在不可见时本来就停），所以划得来。
       */
      backgroundThrottling: false,
    },
  });

  /*
   * 开发者快捷键：F12 / Ctrl+Shift+I 开关 DevTools，F5 / Ctrl+R 重载页面。
   *
   * 为什么必须自己绑：本应用刻意去掉了菜单栏（Menu.setApplicationMenu(null)），
   * 而 **Electron 默认不绑任何这些快捷键** —— 不写这一段，按 F12/F5 是没有任何反应的
   * （实测"按 F12 没反应"，原因在这里，不是环境或权限问题）。
   *
   * 用 before-input-event 而不是菜单 accelerator：accelerator 依赖菜单项，
   * 而这里只要求"焦点在窗口里时生效"。
   */
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') {
      return;
    }
    const key = input.key.toLowerCase();
    const toggleDevTools = input.key === 'F12' || (input.control && input.shift && key === 'i');
    const reload = input.key === 'F5' || (input.control && key === 'r');
    if (toggleDevTools) {
      mainWindow?.webContents.toggleDevTools();
    } else if (reload) {
      mainWindow?.webContents.reload();
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链一律交给系统浏览器，不在应用窗口里导航（这是个装本地产物的壳，不是浏览器）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`${ORIGIN}/index.html`);
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  /*
   * Windows 的 toast 身份：**未打包的 Electron 必须显式设**，否则通知静默不显示
   * （不是报错、不是抛异常，是"什么都没发生" —— 这类问题最难查）。
   * 用 `package.json` 的 `build.appId` 同一个值，打包态与开发态表现一致。
   */
  app.setAppUserModelId('com.huicang.wise.depot');
  // 权限处理器必须在**建窗之前**装好：窗口一建出来页面就可能开始请求（冷启动很快）
  registerPermissionHandlers();
  registerAppProtocol();
  /*
   * 通知自检要在 `startBridge()` **之前**把假后端起好：桥一 spawn 就会去轮询，
   * 那时 `WISE_BACKEND_URL` 必须已经指向假后端（否则它去连真后端，也就不会有新消息）。
   */
  if (NOTIFY_SMOKE) {
    const stub = await startNotifyStub();
    notifyStub = stub;
    process.env.WISE_BACKEND_URL = stub.url;
    console.log(`[notify-smoke] 假后端就绪：${stub.url}`);
  }
  // 并行：不 await 桥，窗口先起来（桥就绪前 Web 会拿到 503 并显示"连接中"）
  const bridgeStartup = startBridge().catch((e: Error) => {
    console.error(`[bridge] 启动失败：${e.message}`);
  });
  await createWindow();
  await bridgeStartup;
  if (NOTIFY_SMOKE) {
    await runNotifySmoke();
    return;
  }
  if (SMOKE) {
    await runSmoke();
  }
});

/**
 * `--smoke`：**Windows 端到端自检**（真 Electron + 真 app:// + 真桥子进程）。
 *
 * 为什么需要它：桥的逻辑早已在纯 Node 下验过（`pnpm bench:desktop`），
 * 但那证明不了"Electron 把页面装起来、页面通过 app:// 拿到引导、再连上桥"这条链。
 * 本模式把断言放进**渲染进程**里跑（它才是真正的消费者），结果打到 stdout 并据此定退出码，
 * 因此可以无人值守地回归。
 *
 * 定义在文件前部：`startBridge()` 需要它来决定要不要落盘令牌。
 */
const SMOKE = process.argv.includes('--smoke');

/**
 * `--notify-smoke`：**系统通知这一片的真机自检**（真 Electron + 真桥子进程 + 真 Windows toast）。
 *
 * 为什么需要它：`pnpm bench:desktop` 已经能证明"事件到了壳"，但它用的是**改过的入口**，
 * 证明不了 `main.ts` 接线这一段；而"气泡到底出没出来"只有 Windows 说了算。
 * 本模式起一个**假后端**（见 `startNotifyStub`），把轮询压到 400ms，真的走一遍
 * 后端 → 桥 → stdout → `notifyMessage` → `new Notification().show()`，并把结论打成 JSON。
 *
 * **它会真的弹两个气泡到你的屏幕上**（一个有声、一个静默），这是重点，不是副作用。
 */
const NOTIFY_SMOKE = process.argv.includes('--notify-smoke');

async function runSmoke(): Promise<void> {
  const win = mainWindow;
  if (!win) {
    console.error('[smoke] 窗口不存在');
    app.exit(1);
    return;
  }
  win.webContents.on('console-message', (...args: unknown[]) => {
    const last = args[args.length - 1];
    const first = args[0] as { message?: string } | undefined;
    const text = typeof last === 'string' ? last : (first?.message ?? '');
    console.log(`[renderer] ${text}`);
  });

  // 页面要等引导与桥都就绪，因此轮询而不是一次性读
  // 两个探针 URL 都必须是**绝对**的：`import()` 在注入的脚本里没有基准 URL，
  // 传 'assets/xxx.js' 会被当成裸模块名（第一版就是这么写的，自检直接报
  // `Failed to resolve module specifier 'assets/index-….js'`）。
  const zxingWasm = findZxingWasm();
  const zxingChunk = findZxingReaderChunk();
  /*
   * v5：自检用的加密 ping 探针是**预打包**的（`dist/smoke-ping.js`，见 `src/smokePing.ts`）。
   * 注入脚本是字符串、拿不到页面模块图，所以把 bundle 文本拼在最前面 ——
   * 于是自检与页面用的是同一套 seal/wire 实现，不存在"第四份线实现"。
   */
  const smokePingBundle = fs.readFileSync(path.join(__dirname, 'smoke-ping.js'), 'utf8');
  const probe = `
    ${smokePingBundle}
    (async () => {
      const ZXING_WASM = ${JSON.stringify(zxingWasm === null ? null : `${ORIGIN}/${zxingWasm}`)};
      const ZXING_CHUNK = ${JSON.stringify(zxingChunk === null ? null : `${ORIGIN}/${zxingChunk}`)};
      const SCAN_BARS = ${JSON.stringify(SCAN_BARCODE_PATTERN)};
      const deadline = Date.now() + 15000;
      let res = null, boot = null;
      while (Date.now() < deadline) {
        res = await fetch('/__bridge.json', { cache: 'no-store' });
        if (res.ok) { boot = await res.json(); break; }
        await new Promise(r => setTimeout(r, 300));
      }
      let ping = null;
      if (boot) {
        /*
         * v5：ping 探针**不再自带线实现**，而是用与页面同一套的共享实现
         * （src/smokePing.ts → 预打包成 dist/smoke-ping.js，由本脚本拼进注入源码）。
         *
         * 为什么必须这样：加密之后手搓一份就等于再写一遍 ECDH + AES-GCM ——
         * "加密层只有三份实现"那条纪律会被一份诊断代码作废；而这份诊断恰恰是
         * 用来证明"真环境里真的能连上桥"的，它自己不能是第四套协议。
         *
         * 注意：本段是注入到页面里的**字符串**，不能出现反引号（会截断外层模板串）。
         */
        ping = await globalThis.__wiseSmokePing.smokePing({ port: boot.port, psk: boot.psk });
      }
      /*
       * 相机链路（B1/S2c）：**在真机、真 app:// origin、真权限处理器下开一次流**。
       *
       * 为什么这一段必须真开流：getUserMedia 失败的方式就是"什么都不发生"，
       * 而它失败的原因分布在三处完全不同的地方 —— 权限处理器（我们自己）、
       * Chromium 的策略（自动播放/安全上下文）、Windows 的隐私开关。
       * 只有真的拿到一条 running 的 track、再停掉看到 ended，这三处才算都验过。
       *
       * 这台机器没有摄像头时**不是通过、是跳过**（见下面 skipped 的分账）：
       * "没有设备所以没验"和"验过了没问题"必须是两句不同的话。
       *
       * 注意：本段是**注入到页面里的字符串**，里面不能出现反引号（会截断外层模板串）。
       */
      const camera = { state: 'unknown' };
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
          camera.state = 'no-api';
        } else {
          const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
          camera.count = devices.length;
          camera.named = devices.filter(d => d.label !== '').length;
          camera.decoderNative = typeof BarcodeDetector !== 'undefined';
          camera.decoderFormats = false;
          if (camera.decoderNative) {
            try { new BarcodeDetector({ formats: ['code_128', 'ean_13', 'qr_code'] }); camera.decoderFormats = true; } catch (e) { camera.decoderFormats = false; }
          }
          if (devices.length === 0) {
            camera.state = 'no-device';
          } else {
            camera.state = 'ready';
            const first = devices[0];
            const constraints = first.deviceId ? { video: { deviceId: { exact: first.deviceId } } } : { video: true };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const track = stream.getVideoTracks()[0];
            camera.started = true;
            camera.readyState = track ? track.readyState : 'none';
            stream.getTracks().forEach(t => t.stop());
            await new Promise(r => setTimeout(r, 150));
            camera.afterStop = track ? track.readyState : 'none';
          }
        }
      } catch (e) {
        camera.started = false;
        camera.error = e && e.name ? e.name : String(e);
      }

      /* 回退识别引擎的字节是否**随包发出**（离线现场的唯一保障）：默认是 CDN，见 scan-zxing.ts */
      let zxing = null;
      if (ZXING_WASM) {
        try {
          const res2 = await fetch(ZXING_WASM);
          const buf = await res2.arrayBuffer();
          zxing = { status: res2.status, bytes: buf.byteLength };
        } catch (e) {
          zxing = { status: 0, bytes: 0, error: String(e) };
        }
      }

      /*
       * 回退引擎的**模块**能不能在 app:// 下加载、API 形状对不对（真机解码前的最后一环）。
       * 这里只 import，不实例化 wasm —— 真正的解码要一张实物条码，那一步是人工走查。
       */
      let zxingApi = null;
      if (ZXING_CHUNK) {
        try {
          const mod = await import(ZXING_CHUNK);
          zxingApi = {
            loaded: true,
            readBarcodes: typeof mod.readBarcodes === 'function',
            prepare: typeof mod.prepareZXingModule === 'function',
          };
        } catch (e) {
          zxingApi = { loaded: false, error: String(e) };
        }
      }

      /*
       * ============ 真环境（app://）里**真的编译 wasm 并解出一张条码** ============
       *
       * 为什么必须有这一段（2026-10-05 的真机教训）：下面两条断言（chunk 能 import、
       * wasm 能 fetch 到 953KB）**都不足以说明识别能用** —— 真机上真正的拦路虎是
       * CSP 不让编译 WebAssembly（页面只写 script-src 'self' 时 Chromium 直接拒），
       * 而 Windows 上又没有内置 BarcodeDetector，于是"引擎永远起不来"，
       * 表现就是用户报的"给了条码没反应"：Node 侧门禁（没有 CSP）和"字节能读到"都会是绿的。
       *
       * 所以这里把三件事一次验完：模块加载 → wasm 编译 → 解出码值。
       */
      let zxingDecode = null;
      if (ZXING_CHUNK && ZXING_WASM) {
        try {
          const mod = await import(ZXING_CHUNK);
          mod.prepareZXingModule({ overrides: { locateFile: () => ZXING_WASM } });
          const src = document.createElement('canvas');
          src.width = 132;
          src.height = 50;
          const sctx = src.getContext('2d');
          sctx.fillStyle = '#fff';
          sctx.fillRect(0, 0, 132, 50);
          sctx.fillStyle = '#000';
          for (const b of SCAN_BARS) sctx.fillRect(b[0], 0, b[1], 50);
          const big = document.createElement('canvas');
          big.width = 132 * 3;
          big.height = 150;
          const bctx = big.getContext('2d');
          bctx.imageSmoothingEnabled = false;
          bctx.drawImage(src, 0, 0, big.width, big.height);
          const frame = bctx.getImageData(0, 0, big.width, big.height);
          const out = await mod.readBarcodes(frame, { formats: ['Code128', 'Code39', 'EAN-13', 'EAN-8', 'ITF', 'QRCode', 'UPC-A', 'UPC-E', 'Codabar', 'DataMatrix'] });
          zxingDecode = {
            ok: out.some(r => r.isValid && r.text === 'TAG-0001'),
            text: out.length > 0 ? out[0].text : '',
            error: out.length > 0 ? out[0].error : '',
          };
        } catch (e) {
          zxingDecode = { ok: false, error: e && e.message ? e.message : String(e) };
        }
      }

      // UI 断言必须**轮询**：读一次就断言等于在测"我的探测够不够快"，
      // 而不是在测"界面最终有没有渲染出来"（W3 首次跑时就栽在这上面）。
      const uiDeadline = Date.now() + 12000;
      let body = document.body.innerText.replace(/\\s+/g, ' ');
      while (Date.now() < uiDeadline && !/验证码|概览|本地桥不可用/.test(body)) {
        await new Promise(r => setTimeout(r, 250));
        body = document.body.innerText.replace(/\\s+/g, ' ');
      }

      /*
       * ============ 端到端不在这里 ============
       *
       * 曾经想在这里点开取景层、喂一张合成条码来验证"画面 → 结果"整条链，
       * 但**登录屏不套外壳**（routes.ts 里 /login 是独立路由，AppFrame 是它的兄弟），
       * 所以未登录时页面上根本没有扫码入口 —— 点不到。
       *
       * 这条链现在分两处验，各自都在能走到的地方：
       *   · tools/check/check-scan-engines.mjs：注入假 canvas + **真 zxing**，
       *     把 "video → canvas → ImageData → 引擎 → 归一化" 整条管线跑一遍并断言解出码值；
       *   · apps/web/smoke/check-web-smoke.mjs（mock 桥、真 Chrome、已登录）：
       *     在标签管理的条形码输入框上真的点一次相机图标，断言码值**落进那个输入框**。
       */

      return JSON.stringify({
        origin: location.origin,
        indexStatus: res ? res.status : null,
        bootPort: boot ? boot.port : null,
        bootPlatform: boot ? boot.platform : null,
        capabilities: boot ? boot.capabilities : null,
        protocol: boot ? boot.protocol : null,
        pingType: ping ? ping.type : null,
        pingPlatform: ping && ping.data ? ping.data.platform : null,
        camera: camera,
        zxingApi: zxingApi,
        zxingDecode: zxingDecode,
        zxing: zxing,
        bodyText: body.slice(0, 300),
      });
    })()
  `;

  const raw = (await win.webContents.executeJavaScript(probe, true)) as string;
  console.log(`[smoke] ${raw}`);
  const r = JSON.parse(raw) as Record<string, unknown>;
  const capabilities = Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [];
  const camera = (r.camera ?? {}) as Record<string, unknown>;
  const zxing = r.zxing as { status?: number; bytes?: number } | null;
  const zxingApi = r.zxingApi as { loaded?: boolean; readBarcodes?: boolean; prepare?: boolean } | null;
  const zxingDecode = r.zxingDecode as { ok?: boolean; text?: string; error?: string } | null;
  const checks: Array<[string, boolean]> = [
    ['页面来自 app://wise origin', String(r.origin ?? '') === 'app://wise'],
    ['app://wise/__bridge.json 回 200', r.indexStatus === 200],
    [
      '引导给出临时端口与协议版本',
      // 只断言**结构**，不写死版本号：版本号写在这里就是第三份副本，
      // 而真正的兼容性判定在页面侧（不符就停在启动失败屏，见 apps/web/src/boot.ts）。
      typeof r.bootPort === 'number' && typeof r.protocol === 'number',
    ],
    ['引导标注平台为 desktop', r.bootPlatform === 'desktop'],
    ['渲染进程能连上桥并收到 res', r.pingType === 'res' && r.pingPlatform === 'desktop'],
    ['页面渲染出登录屏（未登录状态）', typeof r.bodyText === 'string' && r.bodyText.includes('验证码')],
    /*
     * 相机能力位（B1/S2c）：宿主声明了两条，Web 侧的取景与选择才有入口。
     * 这两条**必须**在引导里出现 —— 少一条的表现是"扫码按钮不见了"，
     * 而那正是最难从现象反推到原因的一类。
     */
    ['引导声明 scan.camera', capabilities.includes('scan.camera')],
    ['引导声明 scan.camera.select', capabilities.includes('scan.camera.select')],
    /* 回退识别引擎的 wasm 随包发出 —— 断言的不是"代码写了"，是"字节在产物里" */
    ['ZXing wasm 随包发出且可被 app:// 读到（不是走 CDN）', zxing !== null && zxing.status === 200 && (zxing.bytes ?? 0) > 500_000],
    /* 模块本身在 app:// 下加载得起来、API 形状与适配器一致（真机解码前的最后一环） */
    [
      'ZXing 回退模块可加载且导出 readBarcodes / prepareZXingModule',
      zxingApi !== null && zxingApi.loaded === true && zxingApi.readBarcodes === true && zxingApi.prepare === true,
    ],
    /*
     * **最关键的一条**：在真环境的 CSP 下 wasm 真的编译得出来、真的解得出码值。
     *
     * 它抓的是"模块能加载、字节能读到，但引擎被 CSP 拦住"这种**只看前两条会全绿**的故障 ——
     * 而那正是"给了条码没反应"的真身（Windows 没有内置识别器，回退就是唯一路径）。
     */
    [
      '真环境（app:// + CSP）里 wasm 能编译并解出条码 TAG-0001',
      zxingDecode !== null && zxingDecode.ok === true,
      zxingDecode === null ? '没跑到' : `text=${zxingDecode.text ?? ''} error=${(zxingDecode.error ?? '').slice(0, 160)}`,
    ],
  ];

  /*
   * **跳过 ≠ 通过**（沿用 2026-10-01 计划 Task 6 的口径）。
   *
   * 相机这一段依赖"这台机器真有摄像头、且没被别的程序占着"。把这类情况算成通过，
   * 就等于让自检在没验过的机器上永远是绿的 —— 那比没有这条断言更糟。
   */
  const skipped: string[] = [];
  if (camera.state === 'no-api') {
    skipped.push('本机没有 mediaDevices：相机取景未验');
  } else if (camera.state === 'no-device') {
    skipped.push('本机没有摄像头：相机取景未验');
  } else if (camera.state === 'ready' && camera.started === false) {
    const name = String(camera.error ?? '');
    // "被别的程序占着"是环境冲突，不是本应用的问题 —— 但它必须被**说出来**
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      skipped.push(`摄像头被其它程序占用（${name}）：相机取景未验`);
    } else {
      checks.push([`getUserMedia 被允许（权限处理器生效） —— 实际失败：${name || '未知'}`, false]);
    }
  } else if (camera.state === 'ready') {
    checks.push(['枚举到摄像头（真机上真的走了一遍枚举）', typeof camera.count === 'number' && camera.count >= 1]);
    checks.push(['getUserMedia 被允许（权限处理器生效）', camera.started === true]);
    // **`live` 是规范里"这条 track 活着"的那个值**（不是 `running`）：
    // `MediaStreamTrack.readyState` 只有 `live` / `ended` 两个取值。
    checks.push(['取到画面（track 处于 live）', camera.readyState === 'live']);
    // 关层/失焦/切页三条路的终点都是这里：track 必须真的 ended
    checks.push(['停流后 track 已 ended（摄像头指示灯不该还亮着）', camera.afterStop === 'ended']);
    // 权限处理器**真的被调用过**：只写代码不走一遍，等于没验
    checks.push([
      '权限处理器被调用并记录了决定',
      permissionLog.some((line) => line.startsWith('media@')),
      // 附上流水账，现场排障时这一行就是证据
    ]);
    if (camera.decoderFormats === true) {
      checks.push(['内置 BarcodeDetector 能按我们的格式名构造', true]);
    } else {
      /*
       * **实测（本机 Electron 33 / Windows）：`BarcodeDetector` 根本不存在。**
       * Chromium 的 Shape Detection 只在 macOS / Android / ChromeOS 提供条码识别，
       * Windows 与 Linux 不提供 —— 也就是说现场机器上真正干活的**是 ZXing 回退路径**，
       * 它不是"以防万一"，是主路径。所以它的字节与模块形状在下面两条断言里单独验。
       * 唯一没自动化的是"拿一张实物条码解出码值"，那一步只能人工走查。
       */
      skipped.push(
        camera.decoderNative === true
          ? '内置 BarcodeDetector 不认我们的格式名：内置引擎未验'
          : '本机 Chromium 没有 BarcodeDetector（Windows 不提供）→ 现场走回退引擎；真条码解码需人工走查',
      );
    }
  }

  let ok = true;
  for (const [name, passed] of checks) {
    if (!passed) {
      ok = false;
    }
    console.log(`  ${passed ? '✓' : '✗'} ${name}`);
  }
  for (const reason of skipped) {
    // 用 `-` 而不是 `✓`：跳过就是跳过，肉眼要能一眼区分
    console.log(`  - 跳过：${reason}`);
  }
  console.log(`[perm] 流水账：${permissionLog.length === 0 ? '（本次没有权限请求）' : permissionLog.join(' | ')}`);
  const summary = `${checks.length} 项通过${skipped.length === 0 ? '' : `，${skipped.length} 项跳过`}`;
  console.log(ok ? `✓ Windows 端到端自检通过（${summary}）` : `✗ Windows 端到端自检失败（${summary}）`);
  app.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- 通知自检（--notify-smoke）

/** 假后端的句柄（只在 `--notify-smoke` 下存在）。 */
let notifyStub: NotifyStub | null = null;

/**
 * 通知自检用的**假后端**：见 `notifyStub.ts`。
 *
 * 它**必须与 `bench:desktop` 共用同一份**：这条链上缺哪个接口，两个自检要同时知道。
 * （第一次踩坑就是这样：点通知跳到消息详情屏时详情屏要 `message.detail`，
 * 而当时内联在这里的那段只实现了轮询要的三个接口，界面于是显示 `NOT-FOUND`。）
 */
async function startNotifyStub(): Promise<NotifyStub> {
  return await startNotifyStubShared({ idPrefix: 'SMOKE' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
 * `--notify-smoke` 的正文：**真的弹两个气泡**，并把结论打成 JSON（退出码即结论）。
 *
 * 四段都要验，而且顺序就是消息到来时的真实顺序：
 *   1. 桥在轮询（不是"没跑所以不弹"）；基线播种期间**不许**弹历史消息；
 *   2. 未读涨 ⇒ 真 Windows toast（有声：`ALERT` + `priority=1`）；
 *   3. 再来一条 ⇒ 静默 toast（`SYSTEM` + `priority=0`），且中文文案没乱码；
 *   4. 点击路径：用**注入的假 Notification** 走一遍 `notifyMessage` 的真实代码，
 *      断言点击会 `restore/show/focus` 并把 `location.hash` 改成 `#/me/messages/<id>`
 *      —— 真点一下气泡要人手，但"点了以后会发生什么"可以自动化。
 */
async function runNotifySmoke(): Promise<void> {
  const win = mainWindow;
  const stub = notifyStub;
  const checks: [string, boolean][] = [];

  // 窗口必须**不可见**，否则 `notifyMessage` 会因为"前台可见"而故意不弹（那是设计行为）
  win?.hide();
  await sleep(300);

  if (!stub) {
    console.error('[notify-smoke] 假后端没起来，无法继续');
    app.exit(1);
    return;
  }
  if (!win) {
    console.error('[notify-smoke] 窗口不存在');
    app.exit(1);
    return;
  }

  checks.push(['Electron 报告本机支持系统通知（Notification.isSupported）', Notification.isSupported()]);
  checks.push(['窗口已隐藏（前台可见时**故意不弹**，所以自检必须让出前台）', !win.isVisible()]);

  // 1. 轮询真的在跑：至少要看到一次 unread-count，否则后面的"没弹"是空的
  const polled = await waitFor(() => (stub.calls.count >= 1 ? true : undefined), 10_000);
  checks.push(['桥在轮询未读数（已登录 + 假后端可达）', polled === true]);
  checks.push(['开窗期间不为历史未读补弹通知（基线播种）', notifyHistory.length === 0]);

  // 2. 有声通知
  stub.setUnread(1);
  const first = await waitFor(() => notifyHistory[0], 10_000);
  checks.push(['未读 0 → 1 ⇒ 真的调了 Notification.show()（有声）', first !== null && first.shown === true]);
  checks.push([
    '中文标题/正文原样到达（不是乱码：`设备异常` / `读头 3 已离线`）',
    first?.data.latest?.title === '设备异常' && first?.data.latest?.body === '读头 3 已离线',
  ]);
  checks.push(['事件标了 audible（有声渠道）', first?.data.audible === true]);
  console.log('[notify-smoke] 第 1 个气泡应该已经出现在屏幕上：设备异常 / 读头 3 已离线（有声）');
  await sleep(2500);

  /*
   * **第一个气泡可能已经被人点过了。**
   *
   * 点它会走 `notifyMessage` 的点击路径：`restore → show → focus`，也就是窗口被拉回前台 ——
   * 那是设计（点通知当然要唤起应用）。但"前台可见时不弹"也是设计，于是
   * **后面那条"再弹一次"会被正确地抑制**，自检就红了。
   *
   * 这不是 bug，是断言漏了"人在旁边"这个变量。所以：把这次观察打出来（它是"点击深链真的生效过"
   * 的证据，比一句"通过"值钱），然后**重新让出前台**，让后面两条断言有确定的初始状态。
   */
  if (win.isVisible()) {
    console.log('[notify-smoke] 观察到：窗口已回到前台 —— 说明第 1 个气泡被点过，点击路径真的生效了');
  }
  win.hide();
  await sleep(200);

  // 3. 静默通知
  stub.setUnread(2, silentStubMessage('SMOKE'));
  const second = await waitFor(() => notifyHistory[1], 10_000);
  checks.push(['再来一条 ⇒ 再弹一次（去重不吃新消息）', second !== null && second.shown === true]);
  checks.push(['priority=0 ⇒ 静默（audible=false，不带声音）', second?.data.audible === false]);
  checks.push(['同一条消息不重复弹', notifyHistory.length === 2]);
  console.log('[notify-smoke] 第 2 个气泡应该也出现了：系统维护通知 / 今晚 23:00 例行维护（静默）');

  // 4. 点击路径：真实函数 + 注入的假 Notification（真点气泡要人手，逻辑不必等）
  const captured: { title: string; body: string; silent: boolean }[] = [];
  let clicked: (() => void) | null = null;
  const executed: string[] = [];
  const restored: string[] = [];
  const fakeWindow = {
    isVisible: () => true,
    isFocused: () => false,
    isMinimized: () => true,
    restore: () => restored.push('restore'),
    show: () => restored.push('show'),
    focus: () => restored.push('focus'),
    webContents: { executeJavaScript: (code: string) => executed.push(code) },
  };
  const clickShown = notifyMessage(
    {
      window: fakeWindow as unknown as BrowserWindow,
      createNotification: (options) => {
        captured.push(options);
        return {
          show: () => undefined,
          on: (event: 'click', handler: () => void) => {
            if (event === 'click') {
              clicked = handler;
            }
          },
        };
      },
    },
    { audible: true, latest: { id: 'SMOKE-MSG-1', title: '设备异常', body: '读头 3 已离线' } },
  );
  clicked?.();
  checks.push(['点击路径：`notifyMessage` 在最小化+失焦时也弹（只有聚焦可见才抑制）', clickShown === true]);
  checks.push(['点击路径：参数原样传给系统通知（标题/正文/有声）', captured.length === 1 && captured[0]?.silent === false && captured[0]?.title === '设备异常']);
  checks.push([
    '点击路径：唤起窗口（restore → show → focus，顺序不能反）',
    restored.join('→') === 'restore→show→focus',
  ]);
  checks.push([
    `点击路径：深链改成 #${MESSAGE_ROUTE_PREFIX}SMOKE-MSG-1（不重载页面）`,
    executed.length === 1 && executed[0] === `location.hash = '#${MESSAGE_ROUTE_PREFIX}SMOKE-MSG-1'`,
  ]);

  let ok = true;
  for (const [name, passed] of checks) {
    if (!passed) {
      ok = false;
    }
    console.log(`  ${passed ? '✓' : '✗'} ${name}`);
  }
  console.log(
    `[notify-smoke] ${ok ? '通过' : '失败'}（${checks.filter(([, p]) => p).length}/${checks.length}）` +
      ` 轮询 user.current=${stub.calls.user} unread-count=${stub.calls.count} list=${stub.calls.list}`,
  );

  /*
   * 不立刻退出：气泡是**给人看的**，程序秒退的话你可能什么都没看到。
   * 这段时间也是"点一下气泡看看会不会唤起窗口"的窗口期 ——
   * 注意**必须在这段时间内点**：自检一退出，假后端就没了，那时点气泡会拿真后端去解析
   * `SMOKE-MSG-1`（结果当然是"这条消息已经不在了"）。
   *
   * `WISE_NOTIFY_SMOKE_HOLD_MS` 可以把这个窗口拉长（人工确认时用 30000 更从容）。
   */
  const holdMs = Number(process.env.WISE_NOTIFY_SMOKE_HOLD_MS ?? 12_000);
  console.log(
    `[notify-smoke] 保持 ${Math.round(holdMs / 1000)} 秒：请看一眼屏幕上的两个气泡，` +
      '并在这段时间内**点一下第 1 个**（应唤起应用并停在消息详情，正文就是"读头 3 已离线"）…',
  );
  await sleep(holdMs);

  /*
   * **点击深链的取证**（观察，不是断言）。
   *
   * "屏幕上出现了一个气泡""点下去跳到了详情屏"这两件事自动化替代不了；
   * 但"点下去之后详情屏**真的取到了哪一条**"是可以量的：详情屏挂载时会请求
   * `message.detail` 并顺手调一次 `message.markRead`。所以这里把假后端收到的调用打出来 ——
   * 有人点过就会出现 `detail=1`，而"正文是不是那条消息"由假后端返回的内容决定。
   * 没人点的时候它是 0，那不算失败（这条链不依赖人手），只是没有这一步的取证。
   */
  const clickedThrough = stub.calls.detail >= 1;
  console.log(
    `[notify-smoke] 点击取证：message.detail=${stub.calls.detail} message.markRead=${stub.calls.markRead}` +
      ` 已读集合=[${[...stub.readIds].join(', ') || '空'}] 窗口被拉起=${win.isVisible()}`,
  );
  console.log(
    clickedThrough
      ? '[notify-smoke] ⇒ 有人点过气泡，且详情屏真的向假后端要过那条消息（深链与路由都生效）'
      : '[notify-smoke] ⇒ 本次没有人点气泡；这一步的取证为空（不是失败，只是没验）',
  );

  /*
   * 让 stdout **排空**再退出。
   *
   * `app.exit()` 是立刻终止进程：上面两行取证日志写在它前面，但它们还在管道缓冲里，
   * 父进程（PowerShell / CI）**一行都收不到** —— 现场表现是"日志停在'保持 60 秒'那句"。
   * 这一停也顺手给了假后端一个干净的关闭窗口。
   */
  await sleep(400);

  await stub.close();
  app.exit(ok ? 0 : 1);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 退出清理：先请桥自己退（stdin shutdown），超时再强杀。
// 注意这只是"优雅路径"——真正的兜底是桥自己的 stdin EOF 检测（Electron 崩了也能收尸）。
app.on('before-quit', (event) => {
  if (!bridge || bridge.state === 'stopped' || bridge.state === 'failed') {
    return;
  }
  event.preventDefault();
  void bridge.stop().finally(() => app.exit(0));
});

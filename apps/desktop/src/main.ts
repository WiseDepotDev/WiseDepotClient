import { app, BrowserWindow, Menu, protocol, net, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { BridgeProcess, type BridgeHandshake } from './bridgeProcess';
import { bootstrapResponse, resolveWebAsset } from './webAssets';

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
let mainWindow: BrowserWindow | null = null;

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
    extraArgs: SMOKE ? [] : ['--token-file', join(app.getPath('userData'), 'bridge-session.enc')],
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
  registerAppProtocol();
  // 并行：不 await 桥，窗口先起来（桥就绪前 Web 会拿到 503 并显示"连接中"）
  const bridgeStartup = startBridge().catch((e: Error) => {
    console.error(`[bridge] 启动失败：${e.message}`);
  });
  await createWindow();
  await bridgeStartup;
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
  const probe = `
    (async () => {
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
         * 诊断探针：**自带一份最小的 v4 帧编解码**。
         *
         * 为什么自带：探针是注入到页面里执行的**字符串**，拿不到页面模块图里的 wire.ts；
         * 而它必须说真话 —— 不能因为"编不出 v4 帧"就假装通过（那正是协议升版时最容易漏的地方）。
         * 生产路径上 wire 只有三份实现（Kotlin / TS / 工具），这里是**诊断用**的第四份，
         * 只覆盖 ping 一个方向；帧头布局变更时随自检一起改（跑 pnpm desktop:smoke 会立刻红）。
         */
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        const buildReq = (id, method) => {
          const body = enc.encode(JSON.stringify({ method }));
          const idb = enc.encode(id);
          const out = new Uint8Array(12 + idb.length + body.length);
          out[0] = 0x57; out[1] = 0x42; out[2] = 4; out[3] = 1; out[4] = 1; out[5] = 0;
          out[6] = idb.length & 0xff; out[7] = 0;
          new DataView(out.buffer).setUint32(8, body.length, true);
          out.set(idb, 12); out.set(body, 12 + idb.length);
          return out;
        };
        const parseFrame = (buf) => {
          const b = new Uint8Array(buf);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          const idLen = v.getUint16(6, true);
          const bodyLen = v.getUint32(8, true);
          return {
            kind: b[3],
            id: dec.decode(b.subarray(12, 12 + idLen)),
            json: JSON.parse(dec.decode(b.subarray(12 + idLen, 12 + idLen + bodyLen))),
          };
        };
        ping = await new Promise((resolve) => {
          const ws = new WebSocket('ws://127.0.0.1:' + boot.port + '/bridge?token=' + encodeURIComponent(boot.token));
          ws.binaryType = 'arraybuffer';
          const timer = setTimeout(() => resolve({ error: 'ws timeout' }), 5000);
          ws.onopen = () => ws.send(buildReq('smoke-1', 'bridge.ping'));
          ws.onmessage = (e) => {
            try {
              const f = parseFrame(e.data);
              if (f.id === 'smoke-1') { clearTimeout(timer); resolve({ type: f.kind === 2 ? 'res' : 'kind-' + f.kind, data: f.json.data }); ws.close(); }
            } catch { /* 解不出来的帧不参与断言 */ }
          };
          ws.onerror = () => { clearTimeout(timer); resolve({ error: 'ws error' }); };
        });
      }
      // UI 断言必须**轮询**：读一次就断言等于在测"我的探测够不够快"，
      // 而不是在测"界面最终有没有渲染出来"（W3 首次跑时就栽在这上面）。
      const uiDeadline = Date.now() + 12000;
      let body = document.body.innerText.replace(/\\s+/g, ' ');
      while (Date.now() < uiDeadline && !/验证码|概览|本地桥不可用/.test(body)) {
        await new Promise(r => setTimeout(r, 250));
        body = document.body.innerText.replace(/\\s+/g, ' ');
      }
      return JSON.stringify({
        origin: location.origin,
        indexStatus: res ? res.status : null,
        bootPort: boot ? boot.port : null,
        bootPlatform: boot ? boot.platform : null,
        capabilities: boot ? boot.capabilities : null,
        protocol: boot ? boot.protocol : null,
        pingType: ping ? ping.type : null,
        pingPlatform: ping && ping.data ? ping.data.platform : null,
        bodyText: body.slice(0, 300),
      });
    })()
  `;

  const raw = (await win.webContents.executeJavaScript(probe, true)) as string;
  console.log(`[smoke] ${raw}`);
  const r = JSON.parse(raw) as Record<string, unknown>;
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
  ];
  let ok = true;
  for (const [name, passed] of checks) {
    if (!passed) {
      ok = false;
    }
    console.log(`  ${passed ? '✓' : '✗'} ${name}`);
  }
  console.log(ok ? '✓ Windows 端到端自检通过' : '✗ Windows 端到端自检失败');
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

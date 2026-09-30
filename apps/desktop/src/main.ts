import { app, BrowserWindow, protocol, net, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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
    // jlink + AppCDS 的启动优化放在这里，而不是写死在宿主里：
    // 宿主是"一份"，它的启动参数属于"桌面这一侧的托管方式"。
    jvmArgs: ['-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Xms16m', '-Xmx256m'],
  });

  bridge.on('state', (s) => mainWindow?.webContents.send('bridge-state', s));
  bridge.on('log', (line: string) => console.log(`[bridge] ${line.trimEnd()}`));
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
  registerAppProtocol();
  // 并行：不 await 桥，窗口先起来（桥就绪前 Web 会拿到 503 并显示"连接中"）
  const bridgeStartup = startBridge().catch((e: Error) => {
    console.error(`[bridge] 启动失败：${e.message}`);
  });
  await createWindow();
  await bridgeStartup;
});

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

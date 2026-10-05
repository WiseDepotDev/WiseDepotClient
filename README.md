# WiseDepotClient

慧仓智控客户端：一套 Vue 3 Web UI 加一份 Kotlin/Netty 桥。桌面端由 Electron 承载，手机端由 Android 壳承载，
两端复用同一份桥实现与同一份 Web 产物；后端为 `WiseDeoptServer`。

## 架构

```
Vue 3 Web UI ── WebSocket ──► Kotlin/Netty 桥（唯一实现）── HTTPS 信封 ──► WiseDeoptServer
                              ├ 桌面：Electron 子进程（jlink JVM）
                              └ 手机：Android :shell 进程内
```

- 桥只实现一份，协议模块不依赖 Netty 与 Android，可作为纯 JVM 单测与契约测试的靶子。
- Web 产物只构建一次，桌面（`app://`）与手机（`WebViewAssetLoader`）共用。

## 技术栈

- Web：Vue 3 + TypeScript + Vite + Element Plus + Pinia + vue-router
- 桥：Kotlin + Netty + OkHttp + kotlinx.serialization（Gradle 多模块）
- 宿主：Electron（桌面）、Android WebView 宿主 + 进程内桥（手机）
- 工程：pnpm workspace（JS 侧）+ Gradle（JVM / Android 侧）

## 目录结构

```
bridge/            桥：protocol / backend / capability / server / host-desktop
apps/web           唯一 Web 产物（Vue 3）
apps/desktop       Electron 壳：主进程、jlink runtime、打包
apps/mobile        Android 壳：WebView 宿主 + 进程内桥 + 平台能力适配
packages/          bridge-client / bridge-vue / contract(生成) / layouts / scan / stores / tokens / ui
tools/             契约与令牌生成器、校验脚本、联调脚本
```

## 环境要求

Node.js ≥ 20、pnpm 11、JDK 21；构建 Android 壳另需 Android SDK 与 AGP。

## 构建与运行

```powershell
pnpm install
pnpm dev          # Web 开发态：无宿主时回退到 mock 桥
pnpm build        # Web 产物 → apps/web/dist
pnpm typecheck    # vue-tsc --noEmit
pnpm check        # 契约 / 令牌 / 主题 / 协议等离线门禁

# 桥（纯 JVM 侧，不依赖 Android 工具链）
.\gradlew.bat :bridge:protocol:test "-Pwise.skipAndroid"

# 手机壳（需要 Android SDK）
.\gradlew.bat :apps:mobile:shell:assembleDebug
```

本地配置（Android SDK 路径、签名口令）与密钥库文件不入库，见 `.gitignore`。

## 许可证

本项目采用 **AGPL-3.0** 许可证（见 `LICENSE`）：

- 使用源代码或其修改版本时，须遵守 AGPL-3.0 条款；
- 以网络部署或提供服务的方式使用本项目，须公开对应源代码；
- 严禁任何形式的商业用途，如需商业合作须事先取得作者书面授权。

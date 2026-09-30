# WiseDepotClient

慧仓智控**新客户端**：一套 React Web UI + **一份** Kotlin/Netty 桥，桌面由 Electron 承载、手机由 Android 壳承载。
后端（`WiseDeoptServer`）**零改动**。

> 上一代客户端（Compose 原生、18 模块、29 屏）已冻结归档，见 [docs/legacy.md](./docs/legacy.md)。
> 本仓库**不引用**旧仓库的任何产物（无 submodule、无 Gradle include、无拷贝源码）。

```
React 19 Web UI ── WS(Netty) ──► Kotlin 桥（唯一实现）── HTTPS 信封 ──► WiseDeoptServer
                  127.0.0.1:随机端口        ├ 桌面：Electron 子进程 jlink JVM
                                            └ 手机：Android :shell 进程内
```

- 架构与决策：[docs/architecture.md](./docs/architecture.md)
- 桥协议 v3：[docs/protocol.md](./docs/protocol.md)
- 设计令牌（导出与纪律）：[docs/tokens.md](./docs/tokens.md)
- 功能对照清单（生成物）：[docs/feature-parity.md](./docs/feature-parity.md)

## 目录

```
bridge/            一份桥，两端复用（protocol / backend / capability / server / host-desktop）
apps/web           React 19 + TS + Vite（唯一 Web 产物）
apps/desktop       Electron 主进程 + jlink runtime 构建 + electron-builder
apps/mobile        独立 Android :shell（WebView 宿主 + 进程内桥 + 平台能力适配）
packages/          tokens / contract(生成) / bridge-client / core / primitives / patterns / shells / features
tools/gen/         契约生成器与功能对照清单生成器
docs/              架构、协议、归档、对照清单
```

## 构建与门禁

```powershell
# 契约 + 令牌 + 样式门禁（不需要 Android SDK；生成器只需 node）
pnpm check                      # = check:contract + check:contract:legacy + check:parity + check:tokens + check:css

# 生成物与源码不同步时（改了服务端注解 / bridge-overlay.json / 归档主题之后）
pnpm gen:contract               # 重新生成 Kotlin 注册表 + TS 类型
pnpm gen:parity                 # 重新生成功能对照清单
pnpm gen:tokens                 # 重新导出设计令牌（CSS 变量 + TS 常量）

# Web 产物
pnpm install
pnpm typecheck                  # tsc --noEmit（含 packages/* 的源码）
pnpm build                      # vite build → apps/web/dist（首屏 JS 预算 ≤250KB gzip）
pnpm dev                        # 开发态：无宿主时自动回退到 mock 桥（界面会显式标注）

# 桥的纯 JVM 侧（不碰 Android 工具链；已实测可跑）
.\gradlew.bat :bridge:protocol:test "-Pwise.skipAndroid"
.\gradlew.bat :bridge:host-desktop:build "-Pwise.skipAndroid"

# 手机壳（需要 Android SDK，路径写在未入库的 local.properties）—— W2 首次构建
.\gradlew.bat :apps:mobile:shell:assembleDebug
```

> PowerShell 里 `-Pwise.skipAndroid` 必须加引号，否则会被 PowerShell 拆成 `.skipAndroid` 任务名。
>
> 本机 JDK 只有 21（无 17），因此**不使用 `jvmToolchain`**：改用"当前 JDK 编译 + 产出 Java 17 字节码"
> （见根 `build.gradle.kts` 的 subprojects 约定），效果对 Android 消费方等价且不引入工具链下载依赖。

版本号只在 `gradle/libs.versions.toml` 一处（STD-VER-01）；模块脚本里出现字面版本号即违规。

## 当前进度

| 批 | 状态 |
| --- | --- |
| **W0** 归档旧版 + 建仓 + 契约生成器 + 功能对照清单 | ✅ 已完成 |
| **W1** 令牌导出 + React 工程 + 两套 UI 外壳 + 引导链路 | ✅ 已完成 |
| W2 双端 Netty 桥（Electron 子进程 / Android 进程内）+ 传输 Spike 门禁 | ⏳ |
| W3 最小闭环（登录 → 看板） | ⏳ |
| W4 primitives + patterns | ⏳ |
| W5–W7 逐域替换 overview → inventory → field → me | ⏳ |
| W8 设备能力下沉 | ⏳ |
| W9 收口与出包 | ⏳ |

### W0 验收证据

| 证据 | 命令 | 结果 |
| --- | --- | --- |
| 契约无漂移 | `pnpm check:contract` | 167 条暴露方法 + 2 条不暴露，生成物与控制器一致 |
| 与旧 APP 契约一致 | `pnpm check:contract:legacy` | 旧仓 169 端点 / 新桥 169 端点，端点集合一致、`packet_type` 逐条一致 |
| 功能清单同步 | `pnpm check:parity` | 旧 29 屏 / 19 路由 → 四域 + 167 方法，与归档区一致 |
| 协议层可编译可测 | `gradlew :bridge:protocol:test` | `BridgeFrameCodecTest` **5 tests / 0 failures / 0 errors** |
| 全部桥模块可构建 | `gradlew :bridge:host-desktop:build :bridge:server:build` | BUILD SUCCESSFUL（Netty / OkHttp / kotlinx.serialization 均解析成功） |

### W1 验收证据

| 证据 | 命令 | 结果 |
| --- | --- | --- |
| 令牌无漂移 | `pnpm check:tokens` | 27 颜色槽位（亮/暗）× 8 状态色 × 30 刻度 × 11 语义间距 × 5 圆角 × 12 字号档，与归档主题一致 |
| 令牌纪律 | `pnpm check:css` | 149 个令牌定义，38 处引用全部命中，**0 处 hex / 0 处字面量尺寸** |
| 两套外壳可渲染 | `pnpm check:render` | MobileShell / DesktopShell 用 React 服务端渲染真跑一遍，结构断言全过；**无 `scan.camera` 能力时不画扫码入口**（证明能力表驱动，而非平台字符串驱动） |
| 类型安全 | `pnpm typecheck` | `tsc --noEmit` 通过（严格模式 + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`） |
| 可构建 | `pnpm build` | `vite build` 成功，46 模块 |
| **体积门禁** | 构建输出 | 首屏 JS **75.65 kB gzip**（17.19 + 223.05 kB raw），预算 250 kB —— 余量 70% |
| 产物可服务 | `vite preview` + HTTP | `index.html` 200；CSS/JS 三个资源全部 200，资源路径为**相对路径**（`app://` 与 `appassets` 协议必需） |

尚未验证（属 W2，已定阈值）：宿主进程（Electron / Android）与 `__bridge.json` 的真实供给、
Android 壳编译、Netty 在 Android 上的 dex/启动/内存/APK 增量门禁、真机渲染走查。

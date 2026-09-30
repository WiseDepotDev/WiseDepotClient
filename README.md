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
# 契约门禁（W0 已可跑，不需要 Android SDK / 不需要联网）
pnpm check                      # = check:contract + check:contract:legacy + check:parity

# 生成物与源码不同步时（改了服务端注解或 bridge-overlay.json 之后）
pnpm gen:contract               # 重新生成 Kotlin 注册表 + TS 类型
pnpm gen:parity                 # 重新生成功能对照清单

# 桥的纯 JVM 侧（不碰 Android 工具链）
./gradlew :bridge:protocol:test -Pwise.skipAndroid

# 手机壳（需要 Android SDK，路径写在未入库的 local.properties）
./gradlew :apps:mobile:shell:assembleDebug
```

版本号只在 `gradle/libs.versions.toml` 一处（STD-VER-01）；模块脚本里出现字面版本号即违规。

## 当前进度

| 批 | 状态 |
| --- | --- |
| **W0** 归档旧版 + 建仓 + 契约生成器 + 功能对照清单 | ✅ 已完成 |
| W1 令牌导出 + React 工程 + 两壳空壳 + `__bridge.json` 引导 | ⏳ |
| W2 双端 Netty 桥 + 移动端传输 Spike 门禁 | ⏳ |
| W3 最小闭环（登录 → 看板） | ⏳ |
| W4 primitives + patterns | ⏳ |
| W5–W7 逐域替换 overview → inventory → field → me | ⏳ |
| W8 设备能力下沉 | ⏳ |
| W9 收口与出包 | ⏳ |

W0 的验收证据：`pnpm check` 全绿，且 `check:contract:legacy` 报告
**旧仓 169 个端点 / 新桥 169 个端点、packet_type 逐条一致**。

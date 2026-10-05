# WiseDepotClient 架构

> 本文件是**已拍板方案**的落盘版（架构方案 v3）。任何与实现不一致的地方，以本文件为准并改本文件。
> 上一代客户端已冻结归档，见 [legacy.md](./legacy.md)。

## 0. 一句话

把慧仓智控客户端从「Compose 原生 UI」重构为「**React Web UI + 一份 Kotlin/Netty 桥**」，
桌面由 Electron 承载、手机由 Android 壳承载，**后端零改动**。

```
React 19 Web UI  ── WS(Netty) ──►  Kotlin 桥（唯一实现）  ── HTTPS 信封 ──►  WiseDeoptServer（零改动）
                   127.0.0.1:随机端口
  桌面宿主：Electron 主进程 spawn jlink JVM 桥（独立进程）
  手机宿主：Android :shell 进程内托管同一份桥
```

## 1. 四条不变式

违反其中任何一条都算架构回归，评审时必须拦下。

**不变式 1 —— 桥只有一份。**
`bridge/*` 是纯 Kotlin(JVM) 模块。桌面侧由 Electron 主进程以**子进程**方式启动一个 jlink JVM 运行它；
手机侧把它作为普通依赖编译进 APK 并在进程内托管。没有 Node 版桥，没有第二套协议实现。

**不变式 2 —— Web 与原生之间的唯一契约是 WS。**
不用 `preload` 暴露业务能力，不用 `addJavascriptInterface`。窗口最小化、扫码、NFC、打印、文件选择，
一律是桥方法。平台差异**只**表现为方法在不在 `capabilities` 里，不表现为两套代码路径。

**不变式 3 —— 传输在端口后面。**
`TransportPort` / `BackendPort` / `CapabilityPort` 把 Netty、OkHttp、平台能力隔开（STD-ARCH-05）。
若 Netty 在 Android 上实测不达标，**只换手机侧传输实现**，桌面侧与协议层零改动。

**不变式 4 —— 这条 WS 上除了 `hello` 没有明文。**
v5 起每一帧都用 **AES-256-GCM** 密封，密钥来自**每条连接各自的临时 ECDH**（P-256，
用完即弃 ⇒ 前向保密）；`psk` 不再出现在握手 URL 上，只作为 KDF 的输入参与派生
（详见 [protocol.md](./protocol.md) §1.2）。所以"同机另一个进程读到了那条 URL"不再等于
"拿到了接入凭据"—— 它只拿到一个公钥。代价是多一次协商与 28 字节/帧，换来的是
**流量本身也不可读**（业务令牌本来就不出桥，但库存、巡检结果、条码内容原来都在明文里）。

## 2. 模块与依赖方向

```
bridge/protocol      kotlin-jvm，仅 kotlinx.serialization。帧模型/编解码/方法注册表（生成物）
bridge/backend       依赖 protocol + OkHttp。统一信封、REQUEST-ID、令牌刷新、缓存、重试
bridge/capability    依赖 protocol。能力**端口**（接口 + DTO），无平台实现
bridge/server        依赖 protocol/backend/capability + Netty。握手、会话、分发、限流、背压
bridge/host-desktop  依赖以上全部。JVM main()：绑端口 → stdout 握手 → 服务；桌面能力适配
apps/mobile/shell    Android。WebView 宿主 + 进程内桥 + 平台能力适配 + __bridge.json
apps/web             React 19 + TS + Vite（唯一 Web 产物，两宿主共用）
apps/desktop         Electron 主进程 + jlink runtime 构建 + electron-builder
packages/*           tokens / contract(生成) / bridge-client / core / primitives / patterns / shells / features
```

依赖方向严格单向：`protocol ← backend/capability/server ← host-desktop / apps:mobile:shell`。
`bridge/protocol` 不含 Netty、不含 Android、不含网络，因此它是**纯 JVM 单测与契约测试的靶子**。

**纪律**：`bridge/*` 只允许使用 Android API 25+ 存在的 `java.*` API（禁 `java.lang.management` 之类）。
CI 中「任一 bridge 模块变更 → 强制编译 Android 模块」把这条纪律变成门禁而非口头约定。

## 3. 技术选型与理由

| 决策 | 选择 | 理由 | 被否方案 |
| --- | --- | --- | --- |
| 手机宿主 | 现有 Android 壳 + WebView | 零新运行时；扫码/NFC/相机/离线库都是现成能力 | Capacitor（多养一套 iOS 工具链） |
| 桌面宿主 | Electron | 用户指定；跨平台打包成熟 | 见 §9 的 JCEF 备注 |
| 桌面桥运行方式 | **子进程 jlink JVM** | 让"桥只有一份"成立；崩溃隔离；Electron 只有 UI 职责 | Node 侧重写一份桥（必然漂移） |
| 传输 | **Netty（两端一致）** | 用户指定；两端同版本同代码，行为一致 | Node `ws`（只能桌面用） |
| HTTP 客户端 | OkHttp | **同时存在于 JVM 与 Android**，后端层一份代码两端跑 | 桌面用 JDK HttpClient + 手机用 OkHttp（两套） |
| 序列化 | kotlinx.serialization | 编译期、协程友好、双端一致；旧版 Gson 随之退役 | Gson |
| Web 框架 | **React 19 + TS + Vite** | 22 处长列表的虚拟化生态、并发渲染保输入 60fps、TanStack Query 承载离线缓存、Radix 无障碍、Compiler 减手工 memo | Vue 3（冷启动体积略优，但数据密集生态弱） |
| 协程 | kotlinx.coroutines | 双端一致 | — |

> Web 框架的诚实附注：框架本身差距 <5%，决定权在承载的工作负载（密集表格 / 虚拟滚动 / 表单 / 离线缓存）。
> 桥接契约与框架无关，若后续发现团队 Vue 生产力明显更高，切换成本被限制在 `apps/web` 与 `packages/shells` 内。

## 4. Netty 最小集（手机侧硬约束）

```kotlin
implementation("io.netty:netty-transport:4.1.115.Final")
implementation("io.netty:netty-handler:4.1.115.Final")
implementation("io.netty:netty-codec-http:4.1.115.Final")   // 只为 WS 握手
// 禁止：netty-codec-http2 / netty-tcnative-* / netty-transport-native-* / netty-codec-dns
```

Pipeline：`HttpServerCodec → HttpObjectAggregator(64KB) → WebSocketServerProtocolHandler(BridgeProtocol.HANDSHAKE_PATH) → BridgeFrameHandler`。

Android 侧的已知摩擦（**必须实测，不许假设**）：

| 问题 | 处置 |
| --- | --- |
| 无 `java.lang.management` | `-dontwarn`（见 `apps/mobile/shell/proguard-rules.pro`） |
| R8 吃掉反射入口 | 整包 keep + keepnames |
| Netty 版本探测资源被剥离 | `packaging.resources.pickFirsts` + keep resourcefiles |
| Java 8+ 并发 API | `isCoreLibraryDesugaringEnabled = true` |
| 线程与内存 | boss/worker **复用同一个** `NioEventLoopGroup(1)`（loopback 单客户端） |

**W2 移动端传输 Spike 门禁**（不达标则**只**换手机侧传输，候选顺序：Ktor CIO → 自写 RFC6455）：

| 指标 | 阈值 | 测量 |
| --- | --- | --- |
| Dex 构建 | 成功，无 dontwarn 失败 | `./gradlew :apps:mobile:shell:assembleRelease` |
| APK 增量 | ≤ 1.5MB | 有/无 Netty 两次产物对比 |
| 冷启动增量 | ≤ 80ms | `adb shell am start -W` × 10 取中位数 |
| 常驻内存增量 | ≤ 8MB | `dumpsys meminfo` 桥起前后 |
| 桥往返 p95 | ≤ 20ms | `tools/bench/bridge-roundtrip` 1000 次 |

## 5. 进程模型与生命周期

| | 桌面 | 手机 |
| --- | --- | --- |
| 桥位置 | Electron 主进程的**子进程**（jlink JVM） | **同进程**（`:shell` 内） |
| 启动 | 建窗与 spawn 桥**并行**，UI 显示"连接中"骨架 | WebView 加载与 Netty init 并行（`Dispatchers.IO`） |
| 握手 | 桥**从 stdout** 输出首行 JSON（`psk` 不走 argv，argv 对本机其他用户可见） | 壳内直接持有 |
| 终止 | `before-quit` → stdin 发 shutdown → 2s 超时 → kill 进程树 | 随进程结束 |
| 异常 | 子进程崩溃 → 指数退避重启（≤3 次）+ 通知 UI 重连 | 桥异常 → 重建 EventLoopGroup |

桌面握手载荷：

stdout 上是**行分隔 JSON**，一条流里两种行，靠 `type` 区分（不靠"猜字段"）：

```jsonc
{"v":1,"type":"handshake","host":"127.0.0.1","port":51234,"psk":"<32字节base64url>","pid":1234,"ver":"1.0.0"}
{"v":1,"type":"event","topic":"notify.message","data":{ … }}   // 见 §5.1
```

JVM 启动优化：jlink 精简运行时 + AppCDS（`-XX:SharedArchiveFile`）+ `-XX:+UseSerialGC -XX:TieredStopAtLevel=1` + `-Xms16m -Xmx256m`。

### 5.1 桥 → 壳的事件通道（系统通知）

系统的"新消息通知"**不经 Web**：桥发现新消息后直接把事件推给**壳进程**，由壳弹
Windows Toast / Android 通知栏。理由有两个，都不是省事：

- **页面弹不了系统通知**。后台标签页里的 `Notification` 在两端都不可靠（手机 WebView 后台
  会冻结 JS，桌面隐藏窗口的定时器被节流到 ~1 次/分钟），而"应用在后台时收到消息"恰恰是通知
  唯一有价值的场景。
- **"什么算新消息"只能有一个 owner**。两个壳各自算一遍，就会出现"桌面弹了、手机也弹了、
  而用户刚读过的那条又弹一次"。所以判定只在桥里做一次（`UnreadNotifier`），壳只负责展示。

```text
message.unreadCount（后端）
        ▲ 轮询 10s + 有业务流量时 kick()
        │
   ┌────┴──────────────────────────┐
   │ 桥 UnreadNotifier             │  ① 基线播种 → 比对 → 去重
   │  BridgeServer.emit(topic,…)   │  ② 发 topic=notify.message 的事件
   └────┬────────────────────┬─────┘
        │ 进程内 onEvent      │ stdout 事件行
   ┌────▼──────────┐    ┌────▼──────────────────┐
   │ Android 壳     │    │ Electron 主进程        │
   │ NotificationMgr│    │ new Notification()     │
   └───────────────┘    └───────────────────────┘
     点击 → 唤起应用 + 跳到 #/me/messages/:id（两个壳各自持有 MESSAGE_ROUTE_PREFIX 常量）
```

| 项 | 决定 |
| --- | --- |
| 通知源 | **只有消息表**。后端 8 类 `MessageType` 全部经同一个 `MessageController.createMessage` 落库，所以客户端只盯 `message.unreadCount` + `message.list` 两个接口，不按类型各开一条路 |
| 轮询间隔 | `BridgeServerConfig.notifyPollMs`，默认 **10_000**；`0` = 关闭（测试/bench 用，否则后台流量会污染断言） |
| 实时性补充 | `UnreadNotifier.kick()`：桥每次转发完一个业务请求、或收到 `message.markRead` / `markAllRead` / `clear` 后立即重算一次（节流 ≥2s）。所以"有人正在用"时反应 ≤2s，空闲时才是 10s 一次 |
| 未登录 | `session.authenticated == false` ⇒ **一个请求都不发**（否则 401 刷屏） |
| 基线 | 第一次轮询只记基线不通知（否则开应用就弹一堆历史消息） |
| 去重 | 进程内有界集合（最近 200 个 id），**不落盘**（落盘要加密，收益低） |
| 档位 | `priority >= 1` ⇒ 有声（横幅 + 声音/震动）；否则静默。未知 `type` 仍会弹（静默）并记一行日志 —— **宁可多弹一条静默通知，也不要静默吞掉一条消息** |
| 前台 | 窗口可见且聚焦（手机：`onResume`）⇒ 不弹，界面自己会刷新 |
| 点击 | `#/me/messages/:id`。桌面用 `location.hash` 改深链（不重载页面，保住内存里的会话），手机走 `PendingIntent` + `onNewIntent` 推 hash |
| 能力位 | 两个壳都声明 `notify.system`（"声明即承诺"：界面据此才知道这台机器会弹通知） |

**为什么不做成"告警"的第二条路**：后端如果新增一条独立的告警推送通道，就会出现两个通知源，
用户会收到两条内容相同的通知。要告警就**往消息表写一条 `ALERT` 消息**，自动走这条路。

**已知边界（如实记录）**：Android WebView 在后台可能冻结 JS，桥的轮询随之停摆（进程没死，
只是没在跑）。所以手机端通知是**尽力而为**：系统在杀应用之前先弹出来的能弹，长期后台不保证。
真正需要"必达"的推送，得走 FCM/厂商推送通道，那是另一条立项。

### 5.2 「点一下按钮」的人机验证（2026-10-07，替代图形验证码）

图形验证码**整条链路已删除**（用户决策，见 `docs/superpowers/plans/2026-10-07-human-verification.md`）。
现在登录 / 批量绑定 / 删除用户三个入口都是"点一下按钮、零输入"，分三层，**判决权只在最里面那层**：

```text
页面（HumanVerifyField.vue）      点一下 → gestureTracker 采轨迹统计量
        │ bridge.humanVerify（内建方法）
        ▼
桥（HumanVerifyCollector）        本机 P-256 密钥签名 + 计算量证明（PoW）
        │ 问壳要"只有壳看得见的事实"          ← DesktopEvidenceChannel（stdin/stdout）
        ▼                                  ← AndroidEvidence（进程内）
服务端（HumanVerifyApplicationService）  风险规则 R1–R9 + 验签 + 验 PoW + 发**一次性票据**
        │ humanToken（120s，用途绑定，用后即删）
        ▼
桥（HumanTokenHolder）            票据**只留在桥里**，在 auth.login / tag.batchBind /
                                  user.deleteWithVerify 那一次调用上注入
```

| 项 | 决定 |
| --- | --- |
| 放行判据 | **服务端票据 + 风险规则 + 计算量证明**。页面与壳提供的"本地环境证据"只是**输入**，服务端可以完全不采信（它只用来提难度与留审计） |
| 票据不进 JS | 与业务令牌同一待遇：页面拿不到 `humanToken`。页面一旦能拿到，一次 XSS 就能把它挪用去删用户 |
| 一个效果一条路 | 校验写在 **Service 层**（不是 Controller），且**删掉了无守卫的孪生端点**（`DELETE /api/users/{id}`、无票的 `/batch-bind`、`/batch-bind-with-captcha`）—— 那是图形码时代真实存在的绕道 |
| 升级只提成本 | R5/R6（发布包/调试器/采样不足/轨迹瞬移）升到 22 bit **但照发挑战**；R2/R3（账号锁定、IP 封禁）才真的冷却。算不完 PoW 时服务端给同一 IP 记一次降档（R8），桥自动重试一次 —— **不允许任何人被永久挡在门外**（图形码删了，没有第二条路） |
| 能力位 | 两个壳都声明 `human.verify`，并且各自真的实现了 `HumanVerifyPort`（桌面走 stdin/stdout "桥问壳答"，手机进程内） |
| 门禁 | `pnpm check:human-verify`（跨仓静态门禁，覆盖上面每一条；`--selftest` 用 6 种"当年的坏法"证明它会红） |

## 6. 统一引导：`__bridge.json`

Web 产物第一步固定请求**应用自身 origin** 上的 `__bridge.json`，这是两端唯一的引导路径：

| 宿主 | origin | 实现 |
| --- | --- | --- |
| 桌面 | `app://wise/__bridge.json` | Electron `protocol.handle('app', …)` 动态生成 |
| 手机 | `https://appassets.androidplatform.net/__bridge.json` | `WebViewAssetLoader` 动态生成 |

响应体即 `BridgeBootstrap`（见 `bridge/protocol/.../BridgeBootstrap.kt`）：
`{host, port, psk, platform, ver, protocol, capabilities[], limits}`。

`psk` 是 v5 起的**预共享密钥**（v4 里叫 `token`）：只在这里出现一次，业务令牌永不进入 JS 上下文。
它**不再挂在 WebSocket URL 上** —— URL 只带客户端临时公钥 `?k=<hex>`，密钥经 ECDH 派生（见
[protocol.md](./protocol.md)）。所以 `__bridge.json` 是这台机器上唯一一句"明文密钥"，它的
保护边界就是"本机 + 应用自身 origin"。

## 7. 信息架构（不复用旧导航）

旧版是 `AppRoute.kt` 的 19 条扁平路由 + `NavFlags` 的 19 个布尔 + `renderOrder/backOrder` 双顺序。
新架构重设计为四域：

| 一级域 | 二级 | 旧功能归属 |
| --- | --- | --- |
| **overview** | 看板、告警中心 | Dashboard、Alert* |
| **inventory** | 库存、商品、标签、出入库单、仓库 | Inventory*、Product*、Tag*、StockOrder*、Warehouse* |
| **field** | 巡检、设备 | Inspection*、Device* |
| **me** | 消息、用户、设置 | Message*、User*、Profile |
| system | 登录/验证码/文件/报表/i18n/同步 | 不占一级导航位 |

移动端用 tab + 域内二级抽屉；桌面端用 sidebar 展开三级。
逐屏/逐端点的迁移对照见 [feature-parity.md](./feature-parity.md)（生成物）。

## 8. 双端 UI 的落地方式

四层结构，业务与数据只用一份：

| 层 | 内容 | 是否分端 |
| --- | --- | --- |
| `tokens` | 颜色/间距/圆角/字号/动效**取值** | 共用（唯一来源，从旧 `core/ui/theme` 一次性导出） |
| `primitives` | Button/Input/Card/Chip/Table/Mono… | 共用 |
| `patterns` | StateContainer(四态)/PagedList/MasterDetail/BottomActionBar/SectionCard… | 共用，布局策略可插拔 |
| `shells` | MobileShell / DesktopShell | **分端**（唯一分叉层） |
| `features` | 四个域的屏 | 共用 |

断点沿用旧仓已拍板的三档（Compact <600dp / Medium 600–839 / Expanded ≥840），
视觉方向沿用已拍板的「工业仓储控制台」：高对比、大触控（≥48dp，主按钮 ≥56dp）、低动效、机器数据等宽。

| 能力 | MobileShell | DesktopShell |
| --- | --- | --- |
| 扫码 | 硬件扫码枪 `dispatchKeyEvent` + 相机 ML Kit | 串口扫码枪（serialport） |
| NFC / RFID | 真机 NFC + RFID 读头 | 仅展示 |
| 打印 | 蓝牙标签机 | ESC/POS / 系统打印 |
| 窗口 | 全屏、手势返回 | 多窗口/多标签、置顶、快捷键 |
| 离线 | Room 队列 | 本地 SQLite/IndexedDB 队列 |

## 9. 桌面携带 JVM 的代价（如实记录）

桌面既然必须携带 JVM，Electron 就变成"额外约 150MB 只为一个浏览器窗口"。
技术等价替代是 **JCEF（JVM 内嵌 Chromium）**：单进程、单语言、去掉 Node 层，React 产物与协议全部不变。
**当前决策：维持 Electron**（用户指定）；JCEF 仅作为可选优化记录在案，切换不影响 `packages/*` 与 `bridge/*`。

## 10. 性能预算（全部可测）

| 层 | 指标 | 门禁 | 手段 |
| --- | --- | --- | --- |
| 桌面桥 | 握手（spawn → ready） | ≤700ms | jlink + AppCDS + 并行启动 |
| 桌面端 | 冷启动到可交互 | ≤2.5s | 骨架屏 + 连接中态 |
| 手机桥 | 冷启动增量 / 内存增量 / APK 增量 | ≤80ms / ≤8MB / ≤1.5MB | W2 Spike 门禁 |
| 桥 | req/res 往返 p50 / p95 | ≤5ms / ≤20ms | `tools/bench/bridge-roundtrip` |
| Web | 首屏 JS(gzip) / TTI(桌面 / 中端安卓) | ≤250KB / ≤1.2s / ≤2.5s | 路由级分包 + visualizer |
| Web | 长列表滚动 99 分位帧 | ≤16.6ms（中端机 ≤24ms） | 虚拟滚动 + `content-visibility` + `dumpsys gfxinfo framestats` |
| Web | 内存峰值 | ≤180MB / ≤120MB | DevTools / `dumpsys meminfo` |

## 11. 分批计划

| 批 | 内容 | DoD |
| --- | --- | --- |
| **W0** | 归档旧版 + 建仓 + 契约生成器 + 功能对照清单 | 生成器与旧 `PacketTypeMap` 逐条一致；对照清单生成 |
| **W1** | 令牌导出 + React 工程 + 两壳空壳 + `__bridge.json` 引导 | 双端跑起空壳；体积门禁达标 |
| **W2** | 双端 Netty 桥：握手/鉴权/白名单/限流 + Spike 门禁 | §4 五项阈值全达标 |
| **W3** | 最小闭环：登录（含验证码）→ 看板 | 双端真实拉数；往返 p95 达标 |
| **W4** | primitives + patterns（四态 + 虚拟列表） | 组件预览可达；语义与旧版一一对应 |
| **W5–W7** | 逐域替换 overview → inventory → field → me（每域一运行时开关） | 每域双端 E2E 绿 + 性能门禁绿 |
| **W8** | 能力下沉：扫码/相机/NFC/打印/文件/离线队列/窗口控制 | 真机 + WSA 冒烟绿 |
| **W9** | 收口：双端出包（NSIS/MSI + APK/AAB）、文档与验收记录 | 全部门禁绿 |

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Netty 在 Android dex/启动/内存不达标 | W2 硬门禁；**只**换手机侧传输（不变式 3 保证不污染桌面） |
| 桌面多一个 JVM：体积 + 启动 | jlink 精简运行时 + AppCDS + 并行启动；握手门禁 ≤700ms |
| 子进程变僵尸（Electron 崩溃） | job object / `taskkill /T` 兜底 + `before-quit` 双重清理 + 启动时清扫残留 pid |
| 安装包需携带 jlink runtime | 放 `extraResources`（**不进 asar**），路径由主进程解析并校验存在性 |
| `bridge/*` 误用桌面-only API | CI 强制：bridge 变更必编译 Android 模块 |
| Windows 防火墙弹窗（JVM 监听） | 绑 127.0.0.1 通常不触发；若触发，安装器预置入站规则或文档说明 |
| 双端能力差异被写成两套代码 | 不变式 2：差异只体现在 `capabilities` 列表 |
| 新仓库与旧版并行期需求双改 | 旧版冻结分支只修阻断缺陷；新功能一律进本仓库 |
| 从零设计导致既有业务规则漏迁 | [feature-parity.md](./feature-parity.md) 逐条打勾（生成物，漏一条就被生成器暴露） |

## 13. 回滚

- **旧客户端**：`.archive/wise-depot-android-refactor`（tag `archive/app-v1-final`）+ 全量 bundle。见 [legacy.md](./legacy.md)。
- **本仓库**：W0–W2 全是新增，revert 提交即可；W5–W7 逐域有运行时开关，翻开关回退。
- 无数据迁移、无接口版本变更、后端零改动。

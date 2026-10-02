# 排障记录：WSA / Android 上的"页面连不上桥"

> 这一轮在 WSA 上清掉了**六层**故障，每一层都是真的、每一层都只能靠日志逼出来。
> 本文只留**可复用的部分**：检查清单、平台差异备忘、排障工具。
> 事故经过与逐层证据见 [real-smoke.md](./real-smoke.md)。

---

## 一、六层故障（按被发现的顺序）

| # | 层 | 真相 | 谁的问题 |
| --- | --- | --- | --- |
| 1 | **绑定地址** | WSA 把发往 `127.0.0.1` 的包从 `loopback0` 那条点对点链路送出去（好让 Windows 宿主访问 Android 服务），导致 VM 内部连不上**自己**监听的端口 | 环境 + 我们的硬编码 |
| 2 | **CSP** | `index.html` 的 `connect-src` 写死 `ws://127.0.0.1:*` | 我们的 |
| 3 | **混合内容** | 页面 https + 明文 ws，而 Chromium 的豁免**只覆盖 `127.0.0.1`/`localhost` 这两个名字**，`169.254.x` 不在内 | 我们的 |
| 4 | **明文策略（NSC）** | `network_security_config.xml` 白名单缺桥的地址 | 我们的 |
| 5 | **`PathTemplate` 的正则** | `Regex("\\{([^}]+)}")` 在 Android 的 `java.util.regex` 下抛 `PatternSyntaxException`（桌面 JVM 合法），且在**类初始化**时炸 | 我们的 |
| 6 | 兜底把异常吞掉 | 见下面第四节 —— 它让第 5 层多花了两轮 | 我们的 |

> 第 1 层还顺手解释了一个更早的困惑：**WSA 里 VM 的 `127.0.0.1` 指向宿主**。
> 所以"页面连 `127.0.0.1:port` 连不上自己刚起的桥"是必然的 —— 那个地址根本不是自己。

---

## 二、下次遇到"页面连不上桥"，按这个顺序查

顺序是**从便宜到贵**，且每一步都能把范围切一半：

1. **看桥起没起、绑在哪**
   `[bridge] 桥已启动：<host>:<port>` —— 没有这行就别往下查页面。
2. **看自检**
   `[bridge] 绑定 <host>:<port>，自检：本进程回连 -> 成功|失败（异常类型）`
   - **失败** → `bind()` 没真的在监听，与传输实现无关，**别去改传输**（我在 WSA 上白试过一次）；
   - **成功** → 端口真的在监听，继续往下。
3. **看 TCP 与握手是不是都到了**
   `[bridge] TCP 已连接：…` 与 `[bridge] WebSocket 握手完成：…` 是**两条**日志。
   只有前者 = 协议没谈成；只有后者不存在 = 页面根本没来。
4. **看页面侧被什么拦了**（logcat 里常常是"静默"的，得用 CDP）
   `node tools/bench/_debug-ws.mjs` —— CDP 的 Network 域会把协议层每一步报出来。
   这一步才知道是 CSP、混合内容、还是明文策略。
5. **看兜底异常的原因链**
   `[bridge] 分发异常 method=…：<类>: <消息> ← <原因>: <消息> @ <栈帧>`

---

## 二·补 「打开一直转加载动画」

现象：应用刚起来第一屏一直转骨架，**切走再切回来就好了**。

这条的特征是"切换能治好"，说明**连接本身没问题，是第一个请求的时序问题**。
先按顺序排除：

1. **看是不是页面压根没连上** —— 用第一节的 1~3 步。桥没起、自检失败、握手没完成，
   那是别的问题，别往这里靠。
2. **看接口日志有没有到后端** —— 桥侧会在请求时打日志。**完全没有** = 请求根本没发出去，
   问题在传输层而不是业务屏（这就是本次的真实情况）。
3. **量一下 DOM，别只看截图**：
   `node tools/bench/scan-e2e.mjs` 里有取 CDP 的样板；
   看 `.w-skeleton` 的数量与 `document.body.innerText`。
   骨架还在 = 调用没 settle（不是没触发）。

### 根因（2026-09 实测修掉）

`WebSocketTransport.call()` 原先先 `await ensureOpen()` **再**起计时器 ——
**建连阶段没有超时**。而 WebSocket 可能既不 `onopen` 也不 `onclose`
（丢包 / 黑洞地址 / WSA 的 loopback0 吞包），此时 OS 的 TCP 连接超时是**分钟级**，
于是第一个请求永远不 settle：界面永远转，连报错都没有。
切换之所以能治好，是因为那时连接已经建好了。

修法见 `packages/bridge-client/src/transport.ts`：
单次建连有 `connectTimeoutMs`（默认 6s），**放弃后交给重连逻辑**（保住自愈），
整次调用由 `callTimeoutMs` 兜底；`useBridgeCall` 在连接恢复时自动重取。

回归：`pnpm check:transport`（注入一个既不 onopen 也不 onclose 的 WebSocket 来复现，
并断言"挂住的连接被按上限放弃并**重试过多次**"）。

### 第二轮：用户复报"还在出现"——修的是另一半

第一轮只让调用**有了上限**，没让它**早点结束**。真正的形态是：

1. 连接断了 / 还没建好，一个请求已经在飞；
2. 这个请求**对端已经没了，注定失败**，但它要等满 `callTimeoutMs`（15s）才 reject；
3. 连接其实 1 秒就恢复了 —— 可屏幕还得空转十几秒。

用户看到的仍然是"卡加载"，只是这次有个上限。第一轮的恢复规则只写了
**"当前处于错误态"** 才重取，而这时请求**还没落地**，压根不在错误态。

修法（`packages/bridge-client/src/transport.ts` 的 `shouldRefetchOnOpen`）：
判据从"已经失败了"改成**"这次调用是在连接断开时发出去的"** —— 它绑的那条连接已经不在，
连上就该作废重来。

**判据不能写成"还在等就重取"**：那样每次 `open` 都会重取，而重取又处在"还在等"状态，
连接抖动比调用返回还快时这一屏**永远 settle 不了** —— 把偶发卡顿放大成永久骨架屏。
写成"断开时发出的"之后，重取的那一次是在 open 下发出的，不会再触发下一次：
**每次断线最多重取一次**。连上之后再断的走错误态那一路（传输层 `failPending` 会 reject 它）。

顺带收掉一处**重复拥有者**：`packages/features/src/session.ts` 自己手抄了一份取数逻辑，
抄漏的正是这条恢复规则。而 `bridge.session` 是进程里的**第一个**请求，
最容易撞上连接没建好 —— 它卡住时用户停在「正在读取会话…」，
**那时还没有任何页面可切**，连"切走再切回来"这条自救路径都不存在。
现在它直接用 `useBridgeCall`：这类规则只该有一个拥有者。

回归：`pnpm check:refetch`（钉住判据本身：未落地要重取、已有数据不重取、非 open 不触发）。

> 教训：第一次修完要问一句"**还有哪条路径会让用户看到同一个现象**"，
> 而不是"我修的那条路径还通不通"。现象被消灭才算修完，路径被改善不算。

### 第三轮：不转了，但变成"没有原因的超时"

第二轮修完，用户复报的形状变了 —— 这一屏不再永远转骨架，而是：

```
BRIDGE_BACKEND_UNREACHABLE
请求超时，可重试
[重试]
```

**先看这条错误是谁给的**：`bridge.timeout` 是 `WebSocketTransport` 的 `callTimeoutMs`
到点后自己造的码，不是后端回的。所以第一件事不是去查后端为什么慢，
而是查**为什么轮不到后端说话**。

查到的是超时层级反了：

```
后端读超时 20s   >   Web 侧调用总预算 15s
```

外层比内层短，于是**永远轮不到后端先失败**。后果不只是慢，是**信息丢失**：
OkHttp 还没抛，`OkHttpBackend` 里那个把失败原因写进日志的 `catch` 根本到不了，
桥侧一行失败记录都没有 —— 用户看到"超时"，排障看到空白。第三轮之所以卡住，
就是因为它表现为"一个没有原因的超时"。

修法：把超时改成一条**严格递增**的链，内层永远先说话：

| 层 | 位置 | 值 |
| --- | --- | --- |
| 建连 | `OkHttpBackend.CONNECT_TIMEOUT_MS` | 5s |
| 读写 | `OkHttpBackend.IO_TIMEOUT_MS` | 8s |
| **后端整次调用** | `OkHttpBackend.CALL_TIMEOUT_MS`（`callTimeout`） | 10s |
| **Web 侧调用** | `transport.ts` 的 `BRIDGE_CALL_TIMEOUT_MS` | 15s |

旧版漏掉的正是 `callTimeout` 这一项 —— 它才是"整次调用"的上限，
没有它，读超时可以一层层叠加到远超外层预算。留 5s 余量，
外层那个 15s 就只在**桥自己卡住**时才出现，那时它才是准确的信息。

> 这条链的两个数分居两份源码（Kotlin / TypeScript）。**出事的那一版每一边单看都没毛病，是关系错了**，
> 所以回归必须跨语言对账：`pnpm check:timeout-budget` 只测关系（内层 < 外层、余量 ≥ 3s、
> 配置真的用上了 `callTimeout`），单改一边就红。
> Kotlin 侧另有 `TimeoutBudgetTest`：数值 + **行为**（服务端不回复时，先抛的必须是读超时）。

**这一轮的方法论**：错误码是谁造的，决定了该往哪查。
`bridge.timeout` 出现在界面上时，后端**可能根本没被责怪过** ——
先去确认"这条错误是外层自己造的，还是内层报上来的"。

### 第四轮：`HTTP-400`「请求被拒绝（可能缺少签名或参数）」

第三轮修完之后，报错变得**准确**了，于是第四轮看到的是真因：

```
HTTP-400
请求被拒绝（可能缺少签名或参数）
```

配合后端日志：

```
RequestSignatureFilter : Missing signature headers: Signature=null, Timestamp=null, Nonce=null, URI=/api/warehouse
GET /api/warehouse -> 400 (0 ms)
GET /api/device    -> 200 (1 ms)          ← 这条在白名单里
```

**第一件事是读过滤器，而不是猜签名怎么算。** 读 `RequestSignatureFilter` 第 41~45 行：

```java
String authorization = request.getHeader("Authorization");
if (authorization != null && authorization.startsWith("Bearer ")) {
    filterChain.doFilter(request, response);   // 有 Bearer 就整段跳过签名校验
    return;
}
```

**带 `Authorization: Bearer` 的请求根本不校验签名。** 所以这条 400 只有一个含义：
**这条请求没带 Bearer**。而 `/api/device` 之所以 200，是因为它在 `isExcludedPath`
的白名单里，跟签名无关 —— 光看两条日志的差别会得出错误结论。

再往上游追，桥侧是这么发的：

```kotlin
tokens.accessToken()?.let { requestBuilder.header("Authorization", "Bearer $it") }
```

`accessToken()` 为 null → 不发这个头。**也就是：桥里已经没有会话了。**

### 真因：令牌被清掉之后，界面还在"已登录"的画面上

```
后端令牌过期
  → 请假（refreshToken）也失败
  → SessionManager.markExpired() → clear()      ← 令牌没了
  → 但界面停在已登录的画面（bridge.session 只在挂载时问过一次，没有任何推送）
  → 后续请求不带 Authorization
  → 非白名单端点撞上签名过滤器 → 误导性的 400
```

`SessionManager.authenticated` 与出站请求用的是**同一个令牌**，所以这两个状态本该一致；
不一致的原因是**失效没有被上报**：桥里有 `BridgeServer.emit()`（通道早就有了），
但**没有人接**。

修法（两端，同一个 bug 类）：

1. `SessionManager.EVENT_SESSION_EXPIRED = "session.expired"`；
   `BridgeDispatcher` 新增 `onSessionExpired` 回调（分发器不该知道 WebSocket 长什么样，
   所以由 `BridgeServer` 注入，接到 `emit(...)` 上）；
2. Web 侧 `useSession` 订阅它 → `reload()` → 重新问 `bridge.session` →
   拿到 `authenticated: false` → `App.tsx` 的会话门切回登录屏。
   **登录判定的唯一来源仍然是 `bridge.session`**，前端不自己推断。
3. 顺带把 `humanize` 里 `HTTP-400` 的文案从「可能缺少签名或参数」改成
   不预设原因、但可执行的下一步 —— 那句话正是把用户和排障一起带偏的东西。

回归：`pnpm check:session`（钉住的三处缺一不可，而且**都不会报错**）：
跨语言的主题串必须相同、装配点必须接上（**当初缺的就是这一环**）、
`useSession` 必须真的订阅、`humanize` 必须给出"重新登录"的指引。

**这一轮的方法论**：一条错误信息看起来"很像某个原因"，不等于它就是那个原因。
先读**产生这条错误的那段代码**（这里是过滤器的 `Bearer` 短路），
它往往把可能性收敛到一个很窄的答案上 —— 比对着日志猜快得多。

---

## 三、Android 平台差异备忘（都是实测踩出来的）

| 项 | 记住这一条 |
| --- | --- |
| `java.util.regex` | **与 JVM 不完全兼容**：同一个正则在桌面合法、在 Android 崩。**简单解析别用正则** |
| 类初始化异常 | `ExceptionInInitializerError` / `NoClassDefFoundError` 的 `message` **是 null**，原因在 `cause` 里；只说"某个类炸了"，**不说哪个类** —— 必须打原因链与栈 |
| `network_security_config` | `<domain>` **对 IP 字面量生效且精确**（我一度以为不生效，因此排除了正确方向） |
| 混合内容豁免 | 只覆盖 `127.0.0.1` / `localhost` 这些**名字**；换成任何别的 IP（含 `169.254.x`）就会被拦 |
| WebView 资源加载 | `WebViewAssetLoader` 只剥掉**注册时用的那个前缀**，注册在 `/` 就要自己剥 `assets/` |
| 自由窗口下的方向锁 | WSA 用 `mode=freeform` 跑应用，**Android 会忽略 `screenOrientation`**，必须同时 `resizeableActivity="false"` |
| WSA 的 loopback | VM 的 `127.0.0.1` 指向**宿主**；VM 内部要互相通信得用 `loopback0` 的点对点地址 |

---

## 四、三条方法论（比具体故障更值钱）

### 1. 兜底必须说话，而且要把原因链说完

原始写法：
```kotlin
runCatching { dispatch(...) }.getOrElse { Failed(INTERNAL, "bridge.internal") }
```
异常被**完全吞掉**，页面只说"取数失败"。结果是开始猜 —— 我先猜混合内容、再猜 CSP、
再猜 Netty、再猜 OkHttp，**四次都错**。

改成打完整原因链 + 栈之后，一次就定位到 `PathTemplate` 的某个正则。

> 规则：**捕获异常却不记录原因，等于把排障成本转嫁给未来的自己。**
> 帧上仍然只回错误码（不下发内部细节），但日志里必须留下"哪个类、哪一行、为什么"。

### 2. 里程碑日志要拆开，不能合并

`channelActive` 打的那条曾写成"前端已连接"，于是 **TCP accept 被读成了"协议谈成"**，
我据此报了一个假的"WSA 上第一次打通"。

现在拆成两条，且顺序固定：
```
[bridge] TCP 已连接：…            ← 只证明 accept
[bridge] WebSocket 握手完成：…     ← 才证明协议谈成
```

### 3. 用错误的仪表去量，比问题本身更糟

诊断脚本 `_debug-cdp.mjs` 里**自己也硬编码了 `127.0.0.1`**，
于是它的探测一直失败 —— 差一点又把我带向"应用有问题"的方向。

> 规则：**诊断工具与被测对象共用同一个假设时，它证明不了任何东西。**

---

## 五、排障工具

| 工具 | 用途 |
| --- | --- |
| `tools/bench/bridge-roundtrip.mjs` | 桥的功能 + 性能门禁（`--transport plain` 可切自写 RFC6455 实现对照） |
| `tools/bench/w3-session.mjs` | 令牌截留 / 自动续期（可脚本化假后端，确定性边界） |
| `tools/bench/real-smoke.mjs` | 真后端全链路（真验证码 → 真登录 → 真数据） |
| `tools/bench/desktop-host.mjs` | 桌面宿主逻辑（子进程生命周期 / 路径穿越防线） |
| `tools/bench/mobile-spike.mjs` | APK 与 Netty dex 增量门禁（无设备时明确标记未测量） |
| **`tools/bench/_debug-ws.mjs`** | **CDP Network 域盯 WebSocket 生命周期** —— 白屏/连不上类问题的第一选择 |
| `tools/bench/_debug-cdp.mjs` | 页面内部取证：渲染文本、引导内容、浏览器日志（CSP/混合内容在这里才可见） |
| `tools/bench/_debug-layout.mjs` | 布局事实：视口、档位、控件盒模型（"被挤扁"这类只能量尺寸确认） |
| `tools/bench/_debug-backend.mjs` | 直连后端，对照 GET/POST 与有无信封的差异 |
| **`tools/check/check-transport-timeout.mjs`** | 建连悬停 / 连上不回 / 端口拒绝 —— **"打开一直转"的第一选择**（注入假 WebSocket，无需网络） |

---

## 六、相机扫码：这台机器上 WebView 一开相机就把应用带走

现象：在 WSA 上点「扫码」，取景层正常出现、画面**真的出帧**，然后整个应用消失。

### 1. 先分清"谁崩了"—— 进程归属决定能不能自救

```
F chromium: [FATAL:jni_android.cc(289)] Please include Java exception stack in crash report
F libc    : Fatal signal 5 (SIGTRAP) … in tid 13779 (Chrome_InProcGp), pid 13700 (ang.wise.client)
I ActivityManager: Process com.huicang.wise.client (pid 13700) has died: prcp TOP
```

关键在 `Chrome_InProcGp` 与 `pid …(ang.wise.client)`：崩的是**我们进程内**的 GPU 线程。
所以 `WebViewClient.onRenderProcessGone` **一次都不会被调用** —— 那个回调是给
"渲染进程（独立沙箱进程）挂了"用的。**没有回调，就没有事后自救的余地。**

> 规则：区分"渲染进程崩"与"本进程崩"，是决定修复方案的唯一前提。
> 前者可以重建 WebView；后者只能**事先留痕**。

### 2. 修复：面包屑 + 如实撤回能力

1. 页面在调用 `getUserMedia` **之前**先请求 `__camera-begin`（同源拦截，不出进程），
   宿主据此同步落盘一个标记（`SharedPreferences.commit()`，不能是 `apply()` —— 下一行进程可能就没了）；
2. 取景收起时页面请求 `__camera-done`，宿主清掉标记；
3. 启动时若标记仍在 = 上次"开相机"没有收尾 → **不声明 `scan.camera`**，
   界面上不出现扫码入口（见 `CameraSafety` / `ShellApplication`）。

标记与 **WebView 版本**绑定：崩的是那个版本，不是这台机器的永久属性，升级后自动重新尝试。

### 3. 踩过的坑：别拿"进行中"的信号当判据

第一版把"取流成功"当成了"这条路通了"，于是标记在崩溃前就被清掉，**白修一轮**。
第二版改用"画面出帧"，仍然错 —— 实测取流成功、`play()` 成功、`waitForFrames` 也返回了，
崩溃发生在**出帧之后**（日志里 `相机取景正常，已清除…` 与 `[FATAL:jni_android.cc(289)]`
在**同一毫秒**）。

> 规则：只有"从开到关全程没出事"（用户收起取景）才能证明这条路是通的。
> 任何"进行中"的观测都只是**尚未崩溃**，不是**不会崩溃**。

### 4. 顺带修掉的两个死控件

这一轮同时清掉两个"点了没反应"的按钮 —— 它们比缺少功能更糟，因为它们消耗信任：

- `MobileShell` 的 AppBar 里有个扫码按钮，**只有外观没有 `onClick`**（能力声明了、界面画了、没人接）；
- 登录屏在 `ActionBar` 里**又**摆了一个「登录」，而真正的提交按钮在屏内 ——
  重复且是死的。

> 规则：**能力声明即承诺**。声明了 `scan.camera` 就必须有一条真的能走通的路径；
> 走不通时应撤回声明（本节的机制），而不是留一个静默的按钮。

---

## 七、桌面端相机扫码（B1）：点了没反应时按顺序看这四处

桌面与手机不是同一条路：手机是 WebView 崩（上一节），桌面是 **Electron 主进程的权限处理器 +
Chromium 的 `getUserMedia`**，不会崩，但失败方式同样安静。

### 0. 先看取景层底部那行**诊断**（2026-10-05 新增）

取景层右下角常驻一行小字，它把这四种"看起来一模一样"的情况分开：

```
回退识别 · 已取 125 帧              ← 引擎在工作，画面也在进来（那就是画面里没有码）
回退识别 · 画面还没进来              ← videoWidth 还是 0：流没接上 / 播放被策略挡了
无识别引擎                          ← 这台设备既没有 BarcodeDetector，回退也没加载起来
回退识别 · 已取 12 帧 · 识别出错：…   ← **最值得看的一行**，原因原文在这里
```

### 0.1 "识别出错"里如果是 `CompileError: WebAssembly.instantiate() … violates the following Content Security policy`

**这是 B1 上线后真实踩到的第一个"给了条码没反应"**，2026-10-05 定位：

- Windows 上 Chromium **没有** `BarcodeDetector`（Shape Detection 的条码识别只在
  macOS / Android / ChromeOS 提供），所以现场干活的是 **ZXing-wasm**；
- Chromium 只在 CSP 显式写了 **`'wasm-unsafe-eval'`**（或 `'unsafe-eval'`）时才肯编译 wasm；
- 而 `apps/web/index.html` 的 CSP 当时只有 `script-src 'self'` → wasm 编译被拒 →
  **引擎永远起不来**，界面上只表现为"给了条码没反应"。

> 为什么它藏了这么久：**Node 侧门禁没有 CSP**（能解出码）、**"模块能 import / wasm 字节能读到"
> 也全绿** —— 只有"在真浏览器/真宿主的 CSP 下真的编译一次"才能抓到。
> 现在 `pnpm desktop:smoke` 会在真环境里编译一次 wasm 并解一张合成分辨率条码
> （`check:scan-engines` 同时钉住 `index.html` 里的那串 CSP 字面量）。

### 1. 第一步：看主进程那一行 `[perm]`

```
[perm] media 请求（app://wise/index.html#/login）→ 允许
[perm] media 请求（null）→ 拒绝          ← 这一行就是"点了没反应"的现场
```

- **没有这一行** = 页面根本没请求到权限（取景层没打开，或者按钮压根没画出来 → 先查能力位）；
- **`→ 允许` 但画面还是黑的** = 问题在渲染进程（`<video>` 少了 `muted`、或预览被自动播放策略挡了）；
- **`（null）→ 拒绝`** = origin 判据写错了。**`app:` 不是 URL 标准里的 special scheme**，
  主进程里 `new URL('app://wise/index.html').origin` 会返回**字符串 `'null'`**（Chromium 里才是
  `app://wise`）。判据必须用整串比较（`main.ts` 的 `isOurOrigin`）——
  这条坑在 B1/S2c 第一次跑自检时就被抓到了（`check:desktop-camera` 现在有回归护栏）。

### 2. 界面上三句话分别对应什么

| 界面提示 | 真实原因 | 用户的下一步 |
| --- | --- | --- |
| 没有可用的摄像头 | 枚举到 0 枚（真没有 / 被系统禁了） | 接一个 / 查设备管理器 |
| 相机权限被拒绝 | `NotAllowedError`（Windows 隐私设置、或策略拒绝） | 系统设置里允许相机 |
| 摄像头正被其它程序占用 | `NotReadableError`（会议软件抢着） | 关掉那个程序再点重试 |

三句都带出路（重试 / 换一个摄像头 / 关闭），**没有死状态**；换摄像头只在真的有两枚时才画。

### 2.1 入口在哪：条形码输入框里的相机图标

扫码的入口**在条形码输入框右端**（`BarcodeScanField`：新建标签、修改标签标识等），
点它 → 取景 → 扫到码**直接填进那个框**（不跳页、不弹结果卡）。
顶部命令栏那个「相机扫码」是全局兜底（当前屏没有条码框时用，扫完跳标签详情）。
两者都只在宿主声明 `scan.camera` 时出现。

### 3. Windows 上没有 `BarcodeDetector`

Chromium 的 Shape Detection 只在 macOS / Android / ChromeOS 提供条码识别，**Windows 不提供**。
所以现场机器上真正干活的是 **ZXing 回退路径**（不是"以防万一"）：

- 它的字节必须是**随包发出的资产**（`zxing_reader-*.wasm`，约 953KB）。
  zxing-wasm 默认从 jsDelivr **CDN** 拉 wasm —— 断网现场会表现为"取景正常但永远识别不出"；
  `scan-zxing.ts` 用 `?url` 覆盖了 `locateFile`，自检里有一条断言钉住"字节在产物里且 app:// 可读"。
- 排障时可看这条日志：`[scan] ZXing 回退引擎加载失败…`（模块缺失 / wasm 404 / 版本不符）。

### 4. 自检能替你验到哪一步

`pnpm desktop:smoke` 会**真的开一次流**：枚举 → `getUserMedia` → track `live` → 停流后 `ended`，
并断言权限处理器**真的被调用过**（不是"代码写了就算"）。

两种"跳过"（**不算通过**）：本机没有摄像头、摄像头被其它程序占用。
唯一仍需人工的是"拿一张实物条码解出码值" —— 相机拍不出条码这件事，自动化替代不了。

> 规则：**跳过 ≠ 通过**。让自检在没验过的机器上永远是绿的，比没有这条断言更糟。


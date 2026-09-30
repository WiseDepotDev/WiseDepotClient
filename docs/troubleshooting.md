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

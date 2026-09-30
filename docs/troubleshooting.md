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

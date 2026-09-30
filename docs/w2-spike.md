# W2 传输 Spike 与验收记录

> 验收脚本：`tools/bench/bridge-roundtrip.mjs`（**不 mock 任何东西**：真 spawn JVM、真 stdout 握手、真 WebSocket）
> 复现：`node tools/bench/bridge-roundtrip.mjs --count 1000 --backend-url http://127.0.0.1:18080`

## 0. 本批范围

| 项 | 状态 |
| --- | --- |
| **W2-a** 单份 Netty 桥（协议/后端/传输/分发）+ 桌面宿主进程 | ✅ 本批完成并实测 |
| **W2-b** Electron 宿主（`app://` + spawn + 生命周期）+ Android 壳 + 移动端五项 Spike | ⏳ 下一增量 |

## 1. 实测结果（全部通过）

| 用例 | 结果 |
| --- | --- |
| 宿主经 stdout 完成握手并给出临时端口 | ✓ 端口由系统分配 |
| 错误 token 被拒绝 | ✓ |
| 正确 token 建立连接 | ✓ |
| `bridge.ping` 内建方法 | ✓ 返回 `{protocol:3, platform:"desktop", ver}` |
| `bridge.capabilities` 内建方法 | ✓ 返回能力表 |
| 未登记方法被白名单拒绝 | ✓ `BRIDGE_METHOD_UNKNOWN`（**桥不是通用 HTTP 透传**） |
| 缺路径参数 | ✓ `BRIDGE_PARAMS_INVALID` |
| 契约方法走后端、后端不可达 | ✓ `BRIDGE_BACKEND_UNREACHABLE` + `retryable:true` |
| 限流（连打 200 次） | ✓ 命中 98 次 `BRIDGE_RATE_LIMITED` |
| stdin 收到 `shutdown` 后退出 | ✓ exit=0 |

### 真后端端到端（`http://127.0.0.1:18080` 上真实运行的 WiseDeoptServer）

| 用例 | 结果 |
| --- | --- |
| `captcha.generate` 经桥返回 `payload.data` | ✓ 真 captchaId + 1.2KB base64 图（顺带验证了几 KB 的帧） |
| 无 `Bearer` 调用受保护方法 | ✓ 后端签名过滤器 `400`（扁平错误体，桥退到 `HTTP-400`） |
| 带无效令牌调用受保护方法 | ✓ 后端业务码 `AUTH-0002` 原样透传 |

### 性能门禁（`docs/architecture.md` §10）

| 指标 | 实测 | 门禁 | 余量 |
| --- | --- | --- | --- |
| 桌面桥握手（spawn → stdout 握手） | **445–470ms** | ≤700ms | 36% |
| loopback 往返 p50 | **0.26–0.36ms** | ≤5ms | **14×** |
| loopback 往返 p95 | **0.53–0.64ms** | ≤20ms | **31×** |
| p99 / min / max（1000 样本） | 0.69 / 0.07 / 2.6ms | — | — |

> 结论：**loopback 的传输层不是瓶颈**（余量两位数倍数）。性能预算真正要盯的是
> 渲染（虚拟滚动 / 帧时间）与后端的响应时间，而不是这条本地 socket。

## 2. 本批踩到并修掉的三个真问题

这三个都是"只在真跑时才暴露"的类型，值得写下来——它们分别能吃掉半天到一天。

### 2.1 `getLoopbackAddress()` 返回 `::1`，绑上了却连不上

`InetAddress.getLoopbackAddress()` 在双栈机器上可能给 `::1`，而引导文件与 Web 侧固定连 `127.0.0.1`。
表现极具迷惑性：**服务端 `bind().sync()` 成功、端口正确、日志无异常**，客户端却 `ECONNREFUSED`。

**处置**：`BridgeProtocol.LOOPBACK_HOST = "127.0.0.1"` 作为绑定与连接的**唯一**地址来源。

### 2.2 握手请求的 `?token=` 让 Netty 的握手处理器静默挂起

`WebSocketServerProtocolHandler` 对 `websocketPath` 做的是 **URI 精确匹配**，而浏览器的 WebSocket API
**无法设置自定义头**，token 只能挂在查询串上 → `/bridge?token=…` 匹配不上 `/bridge`。

表现：处理器**既不响应也不报错**（请求被 `fireChannelRead` 丢给下游无人处理），
客户端"连上了但永远等不到响应"。

**处置**：鉴权处理器校验通过后把 URI 收敛成裸路径（`msg.setUri(HANDSHAKE_PATH)`）。
顺带：握手被拒时打 stderr 留痕——静默拒绝会让"连不上"无法诊断。

### 2.3 诊断脚本自己把宿主"杀死"了

`Start-Process -RedirectStandardOutput` 不保留 stdin，而宿主的退出条件是 **stdin EOF**（父进程死了就退）。
于是宿主的 stdin 立刻 EOF → 打印完握手就退出 → 诊断看到的是"ECONNREFUSED"。
后来把诊断改成**自己 spawn 并保持 stdin 打开**（`tools/bench/_debug-handshake.mjs`）才拿到真相。

**教训**：验收脚本必须自己控制生命周期；"看起来是网络问题"的现象也可能是进程生命周期问题。

## 3. 关于真后端的两个必须记住的发现

### 3.1 后端有请求签名过滤器，`Bearer` 是它的旁路

`WiseDeoptServer/.../security/RequestSignatureFilter.java`：
带 `Authorization: Bearer …` 的请求**直接跳过**签名校验；否则要求 `X-Signature` / `X-Timestamp` / `X-Nonce` 三个头。

对桥的含义（已实现）：**一旦持有令牌，每个请求都必须带 Bearer**——这本来就是我们的口径，
但现在是"因为后端要"，而不是"因为习惯"。

**未登录前只有排除表里的路径可用**（登录、验证码、`/api/device`、`/api/inspection`、
`/api/inventories/all`、`/api/rfid/report` 等）。W3 的登录流程必须落在这张表内。

### 3.2 令牌无效时后端回的是 **HTTP 200 + 业务码 `AUTH-0002`**，不是 401

因此桥把业务码原样透传，**不发明 `messageKey`**；文案由 Web 侧按码映射
（延续旧仓"谁展示谁拥有"的口径）。
桥里那条 `status == 401 → error_session_expired` 的分支保留为**防御性**路径（网关/代理可能发 401），
但它不是本后端的实际行为——不要把它当成主路径来设计 UI。

## 4. 归档下来的诊断工具

| 脚本 | 用途 |
| --- | --- |
| `tools/bench/bridge-roundtrip.mjs` | 验收 + 性能门禁（`--count` / `--backend-url` / `--json`） |
| `tools/bench/_debug-handshake.mjs` | 裸 HTTP 升级诊断：直接看服务端返回 101 / 4xx / 无响应 |
| `tools/bench/_debug-backend.mjs` | 直接打后端，对比 GET/POST 与有无信封体的差异 |

## 5. W2-b 待办（下一增量）

1. **Electron 宿主**：`app://` 协议处理器（供 Web 产物 + 动态 `__bridge.json`）、spawn jlink JVM、
   stdout 握手、退出清理、子进程崩溃退避重启；
2. **Android 壳**：`:apps:mobile:shell` 首次编译、`WebViewAssetLoader` 供 `__bridge.json`、
   进程内启动 `BridgeServer`；
3. **移动端五项 Spike 门禁**：dex 构建 / APK 增量 ≤1.5MB / 冷启动增量 ≤80ms /
   常驻内存增量 ≤8MB（APK 与内存两项需真机或模拟器）；
4. `:bridge:protocol` 与 `:bridge:backend` 的纯 JVM 单测补齐（`PathTemplate`、`Envelope`、`BridgeDispatcher`）。

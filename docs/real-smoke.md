# 真后端冒烟记录（W3 收尾）

> 脚本：`node tools/bench/real-smoke.mjs [--user operator|admin] [--backend URL]`
> 目标后端：`http://127.0.0.1:18080`（本机 docker 栈之上的真实 WiseDeoptServer）

## 0. 为什么现在能自动化

登录要过验证码，而验证码是给人看的图 —— 原先它是"必须人工"的那一步。
本机后端把验证码存在**自己的 Redis**里（键名 `captcha:<captchaId>`），
因此测试可以从那里读答案。

> **这不是绕过漏洞，是测试基础设施**：它只用于本机开发栈上的自动回归。
> 生产环境不该有这条路径；脚本本身也不硬编码任何口令——
> Redis 口令与账号口令都从 `deploy/.env.local` 读（STD-SEC-01 零硬编码）。

## 1. 实测结果

两个账号各跑一遍，**均 11/11 通过**。

| 用例 | operator | admin |
| --- | --- | --- |
| `bridge.session` 未登录 | ✓ | ✓ |
| `captcha.generate` 返回真验证码（`data:image/png;base64`，约 1.3–1.5KB） | ✓ | ✓ |
| 从后端自己的 Redis 取到答案 | ✓ | ✓ |
| **`auth.login` 真登录成功** | ✓ `operator` | ✓ `admin` |
| **登录响应不含令牌** | ✓ | ✓ |
| 登录后 `bridge.session.authenticated = true` | ✓ | ✓ |
| `dashboard.summary` 返回真看板数据 | ✓ 库存 0 / 告警 0 / 在线 0 | ✓ 同 |
| `inventory.list` 分页真数据（路径/查询串拆分对真后端成立） | ✓ total=0 | ✓ total=0 |
| `user.list` | ✓ **被拒 `AUTH-0005`**（operator 无用户管理权限） | ✓ **2 个账号：operator, admin** |
| 登出后会话清空 | ✓ | ✓ |
| **全程 9 帧无令牌泄漏** | ✓ | ✓ |

### 三个值得单独记的结论

1. **`user.list` 被拒是正向证据，不是失败。** 桥只做转发，权限判定仍然完全由后端的
   `@RequiresPermission` 负责 —— 这条用例证明了**授权链在桥的路径上没有被绕过**。
   想看非空数据就换 `--user admin`。
2. **空库也能验出"形状对"，但验不出"值对"。** `dashboard`/`inventory` 在本地空库上返回 0，
   因此补了 `user.list`（账号由 `DataInitializer` 播种，必有数据）来验证真值。
3. **登录响应里的 `accessToken`/`refreshToken` 位置是 `null` 而不是缺字段**——
   形状稳定，前端不需要处理"有没有这个 key"。

## 2. Windows（Electron）端到端：**已通过**

`pnpm --filter @wise/desktop build` 后运行：

```powershell
$env:WISE_BACKEND_URL='http://127.0.0.1:18080'
cd apps\desktop; .\node_modules\.bin\electron.cmd . --smoke
```

`--smoke` 把断言放进**渲染进程**里跑（它才是真正的消费者）：

| 断言 | 结果 |
| --- | --- |
| 页面来自 `app://wise` origin | ✓ |
| `app://wise/__bridge.json` 回 200 | ✓ |
| 引导给出临时端口与协议版本 3 | ✓ |
| 引导标注平台 `desktop` | ✓ |
| 渲染进程能连上桥并收到 `res` | ✓ |
| **页面渲染出登录屏** | ✓ `慧仓智控 · WiseDepot 账号 密码 验证码 换一张 登录 …` |

### 这一批在 Windows 上暴露并修掉的两个真 bug

**① 自定义协议没登记特权 → 渲染进程 `fetch` 直接失败**
`loadURL('app://wise/index.html')` 能成功，但 `fetch('app://wise/__bridge.json')` 抛 `Failed to fetch`，
页面一片空白。修法：app ready 之前 `protocol.registerSchemesAsPrivileged([{ scheme:'app',
privileges:{ standard:true, secure:true, supportFetchAPI:true, corsEnabled:true, stream:true } }])`。

**② 把"宿主尚未就绪"当成了致命错误 → 两端同时白屏**
两个宿主都是刻意并行启动的（桌面 spawn 桥的同时建窗、手机在 `Application.onCreate` 里异步起桥），
所以页面第一次读引导拿到 **503 是必然事件**。而 `createBridge` 原先直接判定"没有可用的桥"并**永不重试**，
界面停在错误页。修法：`createBridge` 增加有界等待（宿主式 15s / 开发态 1.2s），读到 503 就重试。
**这一条同时是 Android 那条现象的根因。**

## 3. Android（WSA）端到端：**部分通过**

`adb connect 127.0.0.1:58526` 已可用（WSA 无线调试打开后）。安装并启动后：

| 环节 | 结果 |
| --- | --- |
| APK 安装 / 启动 | ✓ |
| **桥在 Android 进程内启动** | ✓ `桥已启动：127.0.0.1:38943，后端 http://127.0.0.1:18080/` |
| **页面加载完成** | ✓ `页面加载完成：https://appassets.androidplatform.net/assets/web/index.html` |
| **页面 JS 执行并请求引导** | ✓ `首次供给 __bridge.json（桥已就绪）` |
| 冷启动（3 次 `am start -W`） | **445 / 457 / 517 ms** |
| **前端连上桥** | ✗ **未出现** `前端已连接` 日志 |

### 这一批在 Android 上暴露并修掉的两个真 bug

**③ Web 资产前缀没剥对 → `ERR_INVALID_RESPONSE`（用户截图里那个白屏）**
`WebViewAssetLoader` 只剥掉**注册时用的那个前缀**。注册在 `/` 时处理器收到的是 `assets/web/index.html`，
而 `AssetsPathHandler.handle(path)` 把这个字符串**原样**交给 `AssetManager.open()`，
于是它去找 `assets/assets/web/index.html` → `FileNotFoundException`。
修法：在处理器里显式剥掉 `assets/` 前缀。定位靠的是 logcat 里那条
`E WebViewAssetLoader: java.io.FileNotFoundException: assets/web/index.html`。

**④ 桥的日志在 Android 上抓不到**
`:bridge:*` 是平台无关模块，只能写 stderr —— 而 stderr 在 Android 上不保证进 logcat，
于是"桥明明在跑、日志一片空白"。修法：加 `BridgeLog` 端口，手机宿主接管为 `android.util.Log`
（进 logcat），桌面保持 stderr。**没有它，上面那条链路日志根本看不到。**

### 仍未通过的一项：**Netty 在 Android 上"绑定成功但监听不存在"**

用 CDP 进页面内部取证（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` +
`node tools/bench/_debug-cdp.mjs`），拿到的**事实**：

```
bodyText : 慧仓智控 · WiseDepot 账号 密码 验证码 换一张 验证码加载失败（BRIDGE_BACKEND_UNREACHABLE） 登录 …
origin   : https://appassets.androidplatform.net
bootStatus: 200      port: 39169      protocol: 3
wsResult : onerror
浏览器日志: WebSocket connection to 'ws://127.0.0.1:39169/bridge?token=…' failed:
            Error in connection establishment: net::ERR_CONNECTION_REFUSED
```

三条由证据得出的结论：

1. **登录屏其实已经渲染出来了**（`账号 密码 验证码 换一张 登录`）——白屏是引导 503 那个 bug 造成的，
   已修。**之前的"Android 白屏"与"连不上"是两件事。**
2. **`ERR_CONNECTION_REFUSED` 证伪了"混合内容/CSP 拦截"的假设。**
   loopback 本来就是 Chromium 的混合内容豁免，我先前那个判断是错的——**幸亏没有按它去重构**。
3. **端口上确实没有监听**：从容器 shell 直连同一端口同样被拒
   （`toybox nc 127.0.0.1 <port>` → `Connection refused`），而此刻：

   | 观测 | 值 |
   | --- | --- |
   | 桥的启动日志 | `桥已启动：127.0.0.1:38819` |
   | 应用进程 | 存活（pid 未变） |
   | 崩溃 / OOM / ANR | 无 |
   | 该端口的监听 | **不存在** |

即：`bootstrap.bind(...).sync()` 返回成功、`localAddress().port` 也拿到了，
**但事件循环随后消失，channel 被关闭**。

这与 `docs/architecture.md` §4 预先写下的风险**完全对上**：
> Netty 在 Android 上是"非官方支持"，必须实测而不是假设。

W2 的五项 Spike 门禁里，**dex 构建**与**体积**过了，但**功能性的那一项（真机可连）没过** ——
而它恰恰是最重要的。因此现在触发预案，且预案**只换手机侧传输**：

> 不变式 3 的兑现：`TransportPort` 把传输隔开了，改手机侧传输**不动**协议层、
> 不动 backend、不动桌面宿主、更不动 Web。候选按顺序：
> 1. **自写 RFC6455 over `ServerSocket`**（约 200 行，零新依赖，与仓库"不轻易加依赖"的惯例一致）；
> 2. **Ktor CIO WebSockets**（Kotlin 原生、协程、Android 友好，代价是一个新依赖）。

### 这一项**不影响**的部分

桌面桥（W2-a 全部用例）、真后端全链路（`real-smoke.mjs`）、Windows 端到端（上面 §2）全绿——
因为它们都不经过 Android 的 Netty 事件循环。

## 4. 真机（实体 Android 设备）

未接实体设备。WSA 已可用，命令与上面一致（`adb install -r …` 后启动 `MainActivity`）。

> **注意**：`applicationId` 是 `com.huicang.wise.client`，而 `namespace` 是 `com.huicang.wise.client.shell`，
> 因此 `am start` 必须用**全限定类名**：
> `adb shell am start -n com.huicang.wise.client/com.huicang.wise.client.shell.MainActivity`
> 用 `.MainActivity` 会报 "Activity class does not exist"。

## 3. 已经验到的替代证据（在无设备情况下能拿到的最强证据）

`mobile-spike` 与 APK 内容检查：

| 项 | 实测 |
| --- | --- |
| APK 编译 | BUILD SUCCESSFUL |
| **Netty 最小集 dex 增量** | **1.23MB**（门禁 ≤1.5MB） |
| APK 内含当前 Web 产物 | ✓ `assets/web/index.html` + `index-Dv9HOiKH.js`(24KB) + `index-DbIAxajp.css`(17KB) + `vendor-react.js`(223KB) |
| dex 文件 | 8 个（classes.dex 10.2MB + classes2–8） |
| **`__bridge.json` 没有被烘进包** | ✓（它是宿主动态生成的，烘进去反而说明实现错了） |

> 也就是说：**"装了什么"已经查清，欠的只是"在 Android 上跑起来"这一步。**

## 4. 复现命令

```powershell
# 静态门禁（不需要 Gradle）
pnpm check

# 桥的验收（需要先 gradlew :bridge:host-desktop:installDist）
pnpm bench            # 真 spawn JVM：鉴权 / 白名单 / 限流 / 往返性能
pnpm bench:w3         # 假后端：令牌截留 / 自动续期重放（确定性边界）
node tools/bench/real-smoke.mjs            # 真后端：operator 视角
node tools/bench/real-smoke.mjs --user admin  # 真后端：admin 视角（非空数据）

# 桌面与移动
pnpm bench:desktop    # 子进程生命周期 + 路径穿越防线
pnpm bench:mobile     # APK 与 Netty dex 门禁（无设备时明确标记"未测量"）
```

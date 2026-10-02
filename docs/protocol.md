# 桥协议 v4

> 实现见 `bridge/protocol/src/main/kotlin/com/huicang/wise/bridge/protocol/`。
> 本文是规范；代码与本文不一致时，先改本文再改代码（或在本文记一次修正）。
>
> v4 与 v3 的关系：**帧格式全换、方法语义全不动**。167 条方法的 id/路径/参数去向/错误码口径
> 与 v3 逐条相同，换掉的只有"这些语义怎么装进线上字节"。两个端侧实现
> （`packages/bridge-client/src/wire.ts`、`tools/lib/bridge-wire.mjs`）与本文必须有同一份帧头定义。

## 1. 传输与握手

| 项 | 规定 |
| --- | --- |
| 地址 | `ws://127.0.0.1:{port}`，**只绑 loopback**，端口由系统分配（`port=0`）后经引导文件回填 |
| 路径 | `BridgeProtocol.HANDSHAKE_PATH` = `/bridge` |
| 鉴权 | 查询串 `?token=<token>`；token 每次启动新生成 256-bit，握手校验一次后绑定会话 |
| Origin | 白名单：`app://wise`（桌面）、`https://appassets.androidplatform.net`（手机）。不匹配立即断连 |
| **线格式** | **二进制消息**（WebSocket opcode `0x2`）+ 12 字节定长帧头（见 §3）。**文本帧一律拒**，回 `BRIDGE_WIRE_MODE` |
| 控制面正文上限 | `MAX_FRAME_BYTES` = 256KB，超限回 `BRIDGE_FRAME_TOO_LARGE` |
| 数据面正文上限 | `MAX_BIN_BYTES` = 8MiB（`bin` 帧） |
| 结构上限 | 控制面 1MiB / 数据面 8MiB，由 `WireReader` **按帧头里的 kind** 判定；超限不再累积正文并断开连接（为它分配内存不值得） |

**握手被拒时没有帧**：HTTP 层回 401/403，响应体是一句普通 JSON
（`{"code":"BRIDGE_UNAUTHORIZED","messageKey":"bridge.handshakeRejected"}`），
不是帧 —— 那时还没有任何帧存在（浏览器的 `WebSocket` API 也不会把它交给 JS）。

### 1.1 为什么从"文本帧 JSON"换成"二进制帧 + 定长头"

- **版本与判别字段必须只有一处**：v3 把 `v`/`type`/`id` 写在正文里，于是"线格式"同时存在于
  正文结构与解析代码两处，两条传输各写一份编解码 —— 它们已经真实漂移过一次
  （同一个二进制帧在 Netty 侧回结构化错误、在自写传输里被静默丢弃）。v4 把
  版本/类型/id 全部收进帧头，正文只剩下语义，**线格式只有一处定义**。
- **中等二进制对象不必再走带外**：v3 把所有超过 256KB 的东西都推给一次性 URL（多一条网络路径、
  多一套失效与鉴权语义）。v4 开了数据面（8MiB），照片/截图这类对象可以直接进帧。
- **不做的三件事**（写在这里省得下次再讨论）：不换 CBOR/protobuf（没有体积问题，且会作废
  167 条方法的 JSON schema 与生成器）、不启用 `permessage-deflate`（loopback 上 CPU 换不到带宽）、
  不做多路复用与 credit 流控（单客户端单连接，且已有连接数/并发上限与限流）。

## 2. 引导

Web 产物的第一步是读**自身 origin** 上的 `__bridge.json`：

```jsonc
{
  "port": 51234,
  "token": "…",
  "platform": "desktop",          // 或 "mobile"
  "ver": "1.0.0",                 // 产品版本
  "protocol": 4,                  // 协议版本；不匹配直接报错，不静默降级
  "capabilities": ["scan.camera", "nfc.read", "print.label", "window.control"],
  "limits": {                     // v4 新增：本壳实际执行的上限（客户端在发之前就能判断）
    "textMaxBytes": 262144,
    "binMaxBytes": 8388608
  }
}
```

`capabilities` 的取值见 `BridgeCapabilities`。**UI 判定平台差异只能看能力表，不许判断 `platform` 字符串。**

**协商只在引导文件做**：不引入 in-band `hello`/`welcome` 帧 —— 那会变成**两个协商 owner**。
版本不符仍然是**明确失败**（半兼容的半可用状态比明确失败更难查）。

## 3. 帧头与五类帧

### 3.1 帧头（12 字节定长，全部小端）

```text
偏移 长度 字段     说明
 0    2  magic    'W','B'（0x57 0x42）—— 认不出直接拒，不做猜测
 2    1  ver      协议版本（= 4）
 3    1  kind     1=req 2=res 3=err 4=evt 0x10=bin
 4    1  flags    bit0 FINAL；其余位**保留**，见到未知位必须报错（不许当没看见）
 5    1  hdrExt   扩展头字节数（本版本恒 0；非 0 必须报错，不许跳过）
 6    2  idLen    关联 id 的字节数（≤255）
 8    4  bodyLen  正文字节数
12  idLen  id      UTF-8；与 req 的 id 同域 ⇒ 同一个 id 就能把响应和请求对上
    hdrExt 扩展头   （预留）
    bodyLen 正文    控制帧是 UTF-8 JSON；`bin` 是不透明字节
```

三条纪律：

1. **id 只在帧头**。数据面必须能只靠头部与请求对上；两处各存一份必然会写出"头体不一致"的 bug。
2. **未知 flags 位与非 0 扩展头必须报错**。将来真的加位时，"旧壳读到新帧"应当是明确失败，
   而不是静默按旧语义解析 —— 那正是最难查的一类线上事故。
3. **长度必须自洽**（`12 + idLen + bodyLen == 实际字节数`），不自洽即 `BAD_LENGTH`。

### 3.2 正文（只有语义，没有版本/判别/id/ok）

```jsonc
// req 正文
{"method":"inventory.list","params":{"page":1,"size":20},"meta":{"screen":"inventory/list","requestId":"1731-9a2f"}}

// res 正文 —— 成功由 kind 表达，**没有 ok 字段**（那是同一事实的第二份副本）
{"data":{"rows":[],"total":0},"meta":{"ts":1731000000,"cache":"miss","traceId":"1731-9a2f"}}

// err 正文
{"error":{"code":"RES-4010","messageKey":"error_session_expired","retryable":false}}

// evt 正文 —— 事件没有 id（编码时 idLen = 0）
{"topic":"scan.code","data":{"code":"TAG-0001","symbology":"code128"}}

// bin 正文 —— 不透明字节，不做 base64；同一个 id 的多条按到达顺序拼接
<bytes>
```

### 3.3 `bin`（数据面）

- 用于**中等的二进制对象**（照片、截图、验证码原图…）：省掉 base64 的 +33% 与第二通道。
- `final = false` 表示后面还有同 id 的分片；WebSocket 保证消息有序，所以协议里**不需要序号或窗口协商**。
- 接收方对同一个 id 的累积不得超过上限 ×2，超出即回 `err` 并丢弃 —— 背压做在"上限"上。
- 超过 8MiB、或需要边下边显示（录像、大导出件）**仍走带外一次性 URL**（见 §6）。
- **本版本没有任何方法使用数据面**：机制与上限已就位（能力位 `limits.binMaxBytes`），
  等第一个真实消费方落地再逐条开启 —— "能力声称有、实际用不上"比不声明更糟。

## 4. 方法表（白名单）

- 方法 id 与 `httpMethod`/`path`/`packetType` 的对应关系由 `tools/gen/gen-bridge-contract.js` 生成，
  源头是服务端控制器的 `@ApiPacketType` 注解，策展层是 `tools/gen/bridge-overlay.json`。
- 共 167 条暴露方法，2 条刻意不暴露（见 [feature-parity.md](./feature-parity.md) §5）。
- **桥不是通用 HTTP 透传**：不在表里的 method 一律回 `BRIDGE_METHOD_UNKNOWN`。
  理由：Web 层一旦 XSS，透传等于拿到任意后端接口（含 `/api/users`、`/api/permissions`、`/api/roles`）。
- 参数校验：`params` 过 schema；不通过回 `BRIDGE_PARAMS_INVALID`。
- **参数去向（`paramStyle`）**：契约里每条方法都带 `paramStyle: 'body' | 'query'`。
  - `body`（默认）：扣掉路径参数后的剩余参数进 JSON 信封 body，URL 上不带 query；
  - `query`：剩余参数拼进 URL query string，且**不发信封 body**（发空 `{}` 占位，
    因为 OkHttp 不允许 POST/PUT/PATCH 不带 body）。GET/DELETE 天然是 `query`。
  - 为什么要有这个字段：服务端有 **11 个** POST/PUT/PATCH 端点在用 `@RequestParam` 取值，
    而 `@RequestParam` **只认 query string / form body，不认 JSON body**。桥若按 HTTP 方法
    一刀切发 body，这些端点会永远 400，而界面上只表现为「点了没反应」。
  - 登记在 `tools/gen/bridge-overlay.json` 的 `queryParams`（每个都要写服务端为什么只认 query）。
    **不是手抄的**：生成器直接扫服务端控制器的 `@RequestParam`，漏登记一条就构建失败。
  - 回归证据：`pnpm bench:querystyle`（让桥对着记录型假后端发一次，断言 URL 与 body 的形状，
    25 项；无副作用，不碰真数据）。
- **路径参数是否同时进 body（`keepPathParamsInBody`）**：默认 `false`。
  桥默认把路径参数从 body 里剔掉（同一个值没必要发两遍），但服务端有一类 DTO 会把路径参数
  **再声明一次并加 `@NotNull`**，而控制器里的 `request.setTaskId(taskId)` 在参数绑定**之后**
  才执行 —— 救不了 `@Valid`，客户端不放进 body 就必然校验失败。
  登记在 `bridge-overlay.json` 的 `bodyPathParams`（要写清服务端为什么要求两处都带），
  生成期校验 id 存在、方法有 body、路径里真有路径参数。见 [feature-parity.md](./feature-parity.md) §5.2。
- **内建方法（不走后端、不进契约表）**：`bridge.ping` / `bridge.capabilities` / `bridge.session`
  / `bridge.metrics`。实现在 `BridgeBuiltins` + `BridgeDispatcher.dispatchBuiltin`，
  白名单是"内建 ∪ 本机 ∪ 契约"三段并集。
  - `bridge.ping`：宿主版本、平台与协议版本，UI 用它做"桥是否活着"（客户端回前台时也用它验活）。
  - `bridge.metrics`：**桥自己的运行观测**（按方法的次数/失败/最近耗时/p50 近似/max/avg），
    只读、不下发任何令牌或配置。它回答的是"慢在桥上还是慢在后端"——
    界面右上角那个耗时是端到端总耗时，分不出这两者。

## 5. 错误码

桥自己的错误（前缀 `BRIDGE_`，见 `BridgeErrorCodes`）：

| 码 | 含义 |
| --- | --- |
| `BRIDGE_METHOD_UNKNOWN` | 方法不在白名单内 |
| `BRIDGE_PARAMS_INVALID` | 参数未过 schema，或帧结构合法但不是一条合法请求 |
| `BRIDGE_UNAUTHORIZED` | 握手 token / Origin 校验失败 |
| `BRIDGE_FRAME_TOO_LARGE` | 正文超过**该平面**的策略上限（回带 id 的错误，不断开） |
| `BRIDGE_WIRE_MODE` | **线格式不认识**：v3 的文本帧、magic/版本不对、未知 kind/flags、非 0 扩展头 |
| `BRIDGE_RATE_LIMITED` | 单连接限流命中 |
| `BRIDGE_BACKEND_UNREACHABLE` | 后端不可达（网络层错误，非业务错误） |
| `BRIDGE_INTERNAL` | 壳内部异常（兜底，唯一入口） |

**为什么 `BRIDGE_WIRE_MODE` 不复用 `BRIDGE_PARAMS_INVALID`**：这两件事的**处理人不同**。
参数错是调用方写错了业务参数；线格式错是**客户端与壳不是同一版协议** ——
用户和开发者需要看到的是"重新装一次/换回匹配的版本"，而不是"参数不合法"。

后端错误**原样透传**后端编码（如 `RES-4010`）。

**`err.details`（业务拒绝原因）**：内容由**服务端**给出，不是桥写的文案，因此不违反
"桥不下发文案"的原则。用于那些 Web 无从映射的拒绝 —— 实测 `VAL-0001` 的原话是
「只能对已完成的巡检任务进行补录」，让用户看到「操作未完成（VAL-0001）」等于什么都没说。

约束（在桥侧强制，见 `BackendErrorCodes.detailFor`）：

- **白名单前缀**才放行：`RES-` / `VAL-` / `AUTH-` / `BIZ-`。
  5xx 的响应体可能含堆栈、SQL 片段或内部路径，**默认不放行才安全**；
  漏掉一个业务前缀的代价只是"少了一句解释"。
- 截断到 120 字符并压平换行。
- Web 侧 `humanize()` 的顺序是：`messageKey` 映射 → 已知码 → `details` → 兜底码。
  **已知码优先于 details**，保证同一类错误在界面上措辞一致。

**文案不下发**：只给 `messageKey`，由 Web 侧 i18n 解析。
这延续旧版"谁展示谁拥有"的口径（旧仓 `ApiResponseHandler` 里 401 不带文案的同一决定）。

## 6. 大对象与二进制（带外通道仍保留）

| 场景 | 做法 |
| --- | --- |
| 中等二进制（照片、截图、验证码原图） | v4 **数据面** `bin` 帧（≤8MiB），省掉 base64 与第二通道 |
| 超出 8MiB、或需要边下边显示（录像、大导出件、PDF） | 桥落盘 → 返回 `{"url":"…","expiresIn":30}` 一次性 URL → Web 用普通 HTTP 取（HTTP Range 比帧更适合流式） |
| 上传（`file.upload` / `oss.fileCreate` / `device.logUpload`） | Web 传本地句柄或分片句柄，壳侧组装 multipart 并直传；二进制分片走 `bin`（同 id，`final` 标末片） |

带外通道**不是**过渡方案：把大对象塞进帧会让内存与背压同时失控，帧上限正是为了把它们挡在外面。

## 7. 事件（`evt`）与背压

- 进度类事件（`upload.progress` 等）节流到 **≤10Hz**（`BridgeProtocol.EVENT_MIN_INTERVAL_MS`）。
- 事件 topic 命名 `域.动作`，与方法的域前缀一致。事件**没有 id**（`idLen = 0`）。
- 壳侧对单连接做限流；命中回 `BRIDGE_RATE_LIMITED`。
- **被拒的帧在进协程之前就地回写**（`BridgeCallHandler.preflight` 同步完成解析/限额/限流），
  于是失控页面刷过来的帧不会堆在协程队列里。

## 8. 版本演进

- 不兼容改动：`BridgeProtocol.VERSION` +1，并在本文记一节变更说明。
- 兼容改动（新增方法/新增事件/新增可选正文字段）：不必升版本，但生成物必须重跑并提交。
- **协议版本不匹配时，Web 侧直接报错**，不做静默降级——半兼容的半可用状态比明确失败更难查。
- **线格式只有三份实现**（Kotlin `BridgeWire.kt` / TS `wire.ts` / 工具 `bridge-wire.mjs`），
  且三份都以本文 §3 为准。改帧头必须三份同时改，并跑 `pnpm check:bridge` 与 `pnpm bench`。

## 9. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v3 | W0 冻结 | 初版：四类帧、`__bridge.json` 引导、167 条方法白名单、带外大对象通道 |
| v3 | W6/W7 | 方法表新增 `paramStyle` 字段（`body`/`query`）：11 个服务端用 `@RequestParam` 的 POST/PUT 端点改走 query。**帧格式与版本号不变**，老 Web 产物仍能跑，只是这些方法调不通 |
| v3 | W8 | 方法表新增 `keepPathParamsInBody`（默认 false）；启用 `err.details` 承载服务端业务拒绝原因（白名单前缀 + 截断）。两者都是**新增可选字段**，老产物不受影响 |
| v4 | 2026-10-04 | **不兼容**：线格式改为"二进制消息 + 12 字节定长帧头"，`v`/`type`/`id` 收进帧头、正文删掉 `ok`；新增数据面 `bin`（≤8MiB）与 `limits` 下发；新增 `BRIDGE_WIRE_MODE`；成帧装配收口为唯一实现 `WireReader`（两条传输只负责读写 WebSocket 消息）。**167 条方法语义与 §4/§5/§6 的口径逐条不变** |

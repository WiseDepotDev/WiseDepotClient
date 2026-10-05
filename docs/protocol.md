# 桥协议 v5

> 实现见 `bridge/protocol/src/main/kotlin/com/huicang/wise/bridge/protocol/`。
> 本文是规范；代码与本文不一致时，先改本文再改代码（或在本文记一次修正）。
>
> **v5 与 v4 的关系**：**线上帧内容全部加密**（临时 ECDH P-256 + AES-256-GCM，见 §1.2），
> 而 v4 的一切语义**逐条不动** —— 167 条方法、帧头布局、五类帧、错误码口径、
> `?k=` 之外的握手路径都没变。密文里装的就是**逐字节的 v4 消息**（§3.4），
> 所以 `decode` 与业务代码一行都不用改。
>
> v4 与 v3 的关系：**帧格式全换、方法语义全不动**。167 条方法的 id/路径/参数去向/错误码口径
> 与 v3 逐条相同，换掉的只有"这些语义怎么装进线上字节"。三个端侧实现
> （`packages/bridge-client/src/wire.ts`、`tools/lib/bridge-wire.mjs`、Kotlin `BridgeWire.kt`）
> 与本文必须有同一份帧头定义；**加密之后又多了三份 crypto 实现**（§1.2 末尾），
> 它们靠一组冻结向量对齐。

## 1. 传输与握手

| 项 | 规定 |
| --- | --- |
| 地址 | `ws://127.0.0.1:{port}`，**只绑 loopback**，端口由系统分配（`port=0`）后经引导文件回填 |
| 路径 | `BridgeProtocol.HANDSHAKE_PATH` = `/bridge` |
| **密钥材料** | 查询串 `?k=<hex 客户端临时公钥>`（未压缩点，65 字节 → 130 个 hex 字符）。**URL 里没有凭据** —— v4 的 `?token=` 已删除（§1.2） |
| 鉴权 | 双向：① `psk` 参与密钥派生（错 psk ⇒ 双方派生出的密钥不同 ⇒ 第一条密文就 tag 失败）；② `hello` 帧里的公钥必须在曲线上（不在曲线上立即断，不做 ECDH） |
| Origin | 白名单：`app://wise`（桌面）、`https://appassets.androidplatform.net`（手机）。不匹配立即断连 |
| **线格式** | **二进制消息**（WebSocket opcode `0x2`）+ 12 字节定长帧头（见 §3）。**文本帧一律拒**，回 `BRIDGE_WIRE_MODE` |
| **帧内容的封装** | 除 `hello` 外**每一帧都是密文**（flags bit1 = `ENC`）。收到"明文的非 hello 帧"回 `BRIDGE_CRYPTO_FAILED` 并断连 |
| **预认证截止** | 建连后 **1500ms** 内必须收到合法的首个密文帧，否则断连。最多同时 4 条处于"已升级、未认证"的连接（`PreAuthGate`） |
| 控制面正文上限 | `MAX_FRAME_BYTES` = 256KB，超限回 `BRIDGE_FRAME_TOO_LARGE` |
| 数据面正文上限 | `MAX_BIN_BYTES` = 8MiB（`bin` 帧） |
| 结构上限 | 控制面 1MiB / 数据面 8MiB，由 `WireReader` **按帧头里的 kind** 判定；超限不再累积正文并断开连接（为它分配内存不值得） |
| 密文上限 | 明文上限 **+295 字节**（12 外头 + 255 id + 28 封装开销），由 `BridgeWire.sealedHardLimitFor(kind)` 给出 |

**握手被拒时没有帧**：HTTP 层回 401/403，响应体是一句普通 JSON
（`{"code":"BRIDGE_UNAUTHORIZED","messageKey":"bridge.handshakeRejected"}`），
不是帧 —— 那时还没有任何帧存在（浏览器的 `WebSocket` API 也不会把它交给 JS）。

**为什么 `?k=` 非法必须立刻拒**：它是**未经认证的输入**，而 ECDH 对"不在曲线上的点"
是出了名的容易写出小群攻击。所以先 `BridgeCrypto.isOnCurve(...)`，不合法就地断开，
连 `hello` 都不回（回一条错误反而是在告诉对方"这个点我接受了")。

### 1.1 为什么从"文本帧 JSON"换成"二进制帧 + 定长头"

- **版本与判别字段必须只有一处**：v3 把 `v`/`type`/`id` 写在正文里，于是"线格式"同时存在于
  正文结构与解析代码两处，两条传输各写一份编解码 —— 它们已经真实漂移过一次
  （同一个二进制帧在 Netty 侧回结构化错误、在自写传输里被静默丢弃）。v4 把
  版本/类型/id 全部收进帧头，正文只剩下语义，**线格式只有一处定义**。
- **中等二进制对象不必再走带外**：v3 把所有超过 256KB 的东西都推给一次性 URL（多一条网络路径、
  多一套失效与鉴权语义）。v4 开了数据面（8MiB），照片/截图这类对象可以直接进帧。
- **不做的三件事**（写在这里省得下次再讨论）：不换 CBOR/protobuf（没有体积问题，且会作废
  165 条方法的 JSON schema 与生成器）、不启用 `permessage-deflate`（loopback 上 CPU 换不到带宽）、
  不做多路复用与 credit 流控（单客户端单连接，且已有连接数/并发上限与限流）。

### 1.2 端到端加密（v5）

**要解决的问题**：v4 把 `token` 挂在握手 URL 上（`ws://127.0.0.1:PORT/bridge?token=…`），
而且**整条链路的帧内容都是明文**。同机另一个进程只要能读到那个 URL（进程命令行、代理日志、
崩溃转储、浏览器 DevTools 的 Network 面板）就能冒充页面接入桥；读不到 URL 也能被动观察流量
（业务令牌虽然不出桥，但库存、巡检结果、条码内容全在明文里）。

**做法（一句话）**：建连时用临时 ECDH（P-256）协商出一对**一次性**密钥，
此后**每一帧**都用 AES-256-GCM 密封；`psk` 不再上线，而是作为 KDF 的输入参与派生。

| 步骤 | 细节 |
| --- | --- |
| ① 客户端生成临时密钥对 | `BridgeCrypto.generateEphemeral()`，P-256，每次建连**都是新的**（这就是前向保密） |
| ② URL 只带公钥 | `ws://127.0.0.1:{port}/bridge?k=<hex 未压缩点>`。没有凭据，所以**日志/命令行里泄露它等于没泄露** |
| ③ 第一条帧是明文 `hello` | 幂等的 key material 帧，正文 `{"k":"<hex 公钥>"}`。**它是唯一允许明文的帧**（此时还没有密钥可读它） |
| ④ 双方各算一份共享密钥 | `ECDH(client_priv, server_priv)`；服务端的临时密钥对是**每条连接**新生成的 |
| ⑤ KDF | `HMAC-SHA256`，输入 = `shared ‖ "wd-bridge/v5/kdf" ‖ "c"‖server_pub ‖ "s"‖client_pub`，输出两个方向的密钥：`wd-bridge/v5/c2s`、`wd-bridge/v5/s2c`（32 字节各一） |
| ⑥ 帧密封 | AES-256-GCM。**nonce = `dir(1) ‖ seq(8, 大端) ‖ 0x00 0x00 0x00`**（`dir`：1=c2s，2=s2c），nonce **随正文上线**（正文前 12 字节），tag 16 字节跟在密文后 |
| ⑦ AAD | **外层 12 字节帧头 + id** —— 于是"改帧头"必然表现为 tag 失败，不需要额外校验 |
| ⑧ 防重放 | 每方向一个单调递增 `seq`。收到的 `seq` 必须**严格递增**；缺口 ≤ `MAX_SEQ_GAP`（4096）时允许（WebSocket 有序，缺口服从"丢帧即断连"的既有语义），**回退或重复直接断连** |

**psk 的约束**：`BridgeCrypto.MIN_PSK_BYTES = 16`。三个实现都**在派生之前**校验长度
（太短的 psk 会把密钥强度拖到 psk 上）。它只在引导文件里出现一次，不写进 URL、不进日志。

**前向保密到什么程度（如实说）**：抓到"某一次的 hello 公钥 + 那次会话的全部密文"的人，
拿到 psk 也解不开那次会话（临时私钥用完即弃）。但**拿到 psk 的人可以主动中间人**：
它可以自己扮演客户端去连桥。所以 psk 的保密边界仍然是"本机 + 引导文件的访问控制"，
加密层解决的是"流量与 URL 被看到"，不是"本机已被完全攻陷"。

**三份 crypto 实现靠冻结向量对齐**：

| 实现 | 位置 |
| --- | --- |
| Kotlin（生产） | `bridge/protocol/.../BridgeCrypto.kt` + `BridgeWire.kt` |
| TypeScript（页面） | `packages/bridge-client/src/seal.ts` |
| Node（工具/bench） | `tools/lib/bridge-wire.mjs` |

它们**不许各写一套"顺手实现"**：`bridge-crypto-vectors.json` 是一组固定输入 → 固定输出
（ECDH 共享密钥、派生密钥、nonce、密文、tag），
`pnpm check:crypto-vectors` 逐条比对三份实现（81 项）；Kotlin 侧另有 `BridgeCryptoTest`。
**改 crypto 必须同时改向量**，否则门禁红 —— 这正是"三份实现不许漂移"的机制保证。


## 2. 引导

Web 产物的第一步是读**自身 origin** 上的 `__bridge.json`：

```jsonc
{
  "port": 51234,
  "psk": "…",                     // v5：**预共享密钥**（v4 里叫 token）。只在这里出现，不挂 URL
  "platform": "desktop",          // 或 "mobile"
  "ver": "1.0.0",                 // 产品版本
  "protocol": 5,                  // 协议版本；不匹配直接报错，不静默降级
  "capabilities": ["scan.camera", "nfc.read", "print.label", "window.control", "notify.system"],
  "limits": {                     // v4 新增：本壳实际执行的上限（客户端在发之前就能判断）
    "textMaxBytes": 262144,
    "binMaxBytes": 8388608
  }
}
```

`capabilities` 的取值见 `BridgeCapabilities`。**UI 判定平台差异只能看能力表，不许判断 `platform` 字符串。**

**协商不在引导文件里做（v5 修正）**：版本仍然是"引导文件里的 `protocol` 不符就明确失败"，
但 v5 多了一次**线上的密钥协商**（§1.2 的 `hello`）。两者的分工是清楚的：
引导文件管"我们是不是一版协议"，`hello` 管"这一条连接的密钥是什么"——
**`hello` 不承担任何版本协商**（它没有 `v` 字段，也不用它做兼容判断）。

## 3. 帧头与五类帧

### 3.1 帧头（12 字节定长，全部小端）

```text
偏移 长度 字段     说明
 0    2  magic    'W','B'（0x57 0x42）—— 认不出直接拒，不做猜测
 2    1  ver      协议版本（= 5）
 3    1  kind     1=req 2=res 3=err 4=evt 5=hello 0x10=bin
 4    1  flags    bit0 FINAL；bit1 ENC（v5）；其余位**保留**，见到未知位必须报错（不许当没看见）
 5    1  hdrExt   扩展头字节数（本版本恒 0；非 0 必须报错，不许跳过）
 6    2  idLen    关联 id 的字节数（≤255）
 8    4  bodyLen  正文字节数
12  idLen  id      UTF-8；与 req 的 id 同域 ⇒ 同一个 id 就能把响应和请求对上
    hdrExt 扩展头   （预留）
    bodyLen 正文    控制帧是 UTF-8 JSON；`bin` 是不透明字节；**ENC 帧是"nonce ‖ 密文 ‖ tag"**（§3.4）
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

### 3.4 密文帧（`ENC`）与 `hello`

**除 `hello` 之外，v5 的每一帧都是密文帧**：`flags.bit1 = 1`，正文 = `nonce(12) ‖ 密文 ‖ tag(16)`。

```text
外层（明文，接收方在没有密钥时也能读）   magic | ver=5 | kind | FINAL|ENC | 0 | idLen | bodyLen | id
                                        ↑ 这 12 字节 + id 就是 AAD：改它一定 tag 失败
外层正文（密文）                        nonce(12) ‖ AES-256-GCM(内层整帧) ‖ tag(16)
内层（逐字节的 v4 消息）                 magic | ver=5 | kind | FINAL | 0 | idLen | bodyLen | id | 正文
                                        ↑ kind 与 id 必须与外层一致（外层头是明文，这条得自己补）
```

三条容易写错的：

1. **`hello` 不许被加密**。它是"还没有密钥"时唯一能读的帧，封装它等于谁也读不了；
   库里对这条是硬拒（`sealMessage` 遇到 hello 直接抛）。
2. **内外 `kind` 与 `id` 必须一致**。外层头是明文，所以接收方必须自己补这条一致性检查
   （`openMessage` 做），否则攻击者可以"外层说这是 `res`、内层其实是 `err`"。
3. **长度关系**：`外层 bodyLen = 内层整帧长度 + 28`。上限判定用 `sealedHardLimitFor(kind)`
   （明文上限 +295），**不是**明文上限 —— 否则一条合法的最大密文帧会被误判成超限。

`hello` 帧的正文：`{"k":"<hex 未压缩公钥>"}`，`idLen` 必须为 0（它没有请求可关联）。

## 4. 方法表（白名单）

- 方法 id 与 `httpMethod`/`path`/`packetType` 的对应关系由 `tools/gen/gen-bridge-contract.js` 生成，
  源头是服务端控制器的 `@ApiPacketType` 注解，策展层是 `tools/gen/bridge-overlay.json`。
- 共 165 条暴露方法，2 条刻意不暴露（见 [feature-parity.md](./feature-parity.md) §5）。
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
- **本机方法（不走后端、不进契约表，由宿主实现）**：目前只有一条 —— `nfc.openSettings`
  （跳系统 NFC 设置页，返回 `{opened:boolean}`）。
  - id 的**单一出处**是 `BridgeLocalMethods`；宿主用 `LocalMethodPort.methodIds` 声明
    自己实现了哪些，`BridgeDispatcher` 按"内建 ∪ 本机 ∪ 契约"并集放行。
  - **声明即承诺在这里同样成立**：登记了却没实现的方法会回 `BRIDGE_INTERNAL`
    （比"方法不存在"更难查 —— 它看起来像调用成功后的内部错误），所以宿主只登记真的实现的那几条。
  - 为什么 NFC 只有这一个方法、**没有** `nfc.start` / `nfc.stop`：与相机流同一条教训 ——
    "自动使用"由壳在 `onResume` 开、`onPause` 关，做成方法就是**双所有者**
    （壳以为在扫、Web 以为停了）。Web 只消费下面那两个事件。
- **NFC 事件（B3）**：`nfc.tag`（`{id, tech, at}`，读到标签）与 `nfc.state`
  （`{state: 'on'|'off'|'unsupported'}`，没有标签时界面也要能说清状态）。

## 5. 错误码

桥自己的错误（前缀 `BRIDGE_`，见 `BridgeErrorCodes`）：

| 码 | 含义 |
| --- | --- |
| `BRIDGE_METHOD_UNKNOWN` | 方法不在白名单内 |
| `BRIDGE_PARAMS_INVALID` | 参数未过 schema，或帧结构合法但不是一条合法请求 |
| `BRIDGE_UNAUTHORIZED` | 握手被拒：Origin 不在白名单，或 `?k=` 缺失/不在曲线上（HTTP 401/403，没有帧） |
| `BRIDGE_CRYPTO_FAILED` | **v5**：收到明文的非 `hello` 帧、tag 校验失败、序号回退/重放、hello 的公钥不合法。**一律断连** |
| `BRIDGE_FRAME_TOO_LARGE` | 正文超过**该平面**的策略上限（回带 id 的错误，不断开） |
| `BRIDGE_WIRE_MODE` | **线格式不认识**：v3 的文本帧、magic/版本不对、未知 kind/flags、非 0 扩展头 |
| `BRIDGE_RATE_LIMITED` | 单连接限流命中 |
| `BRIDGE_BACKEND_UNREACHABLE` | 后端不可达（网络层错误，非业务错误） |
| `BRIDGE_INTERNAL` | 壳内部异常（兜底，唯一入口） |

**为什么 `BRIDGE_CRYPTO_FAILED` 与 `BRIDGE_WIRE_MODE` 分开**：处理人不同。线格式错是
"客户端与壳不是同一版协议"（重新装一次）；加密失败是"这一条连接不可信，或者两端密钥材料不一致"
（可能有人在中间，也可能是引导文件过期了 —— 需要重新读 `__bridge.json` 再连）。
两者都断连，但给用户的话完全不同。

**为什么 `BRIDGE_WIRE_MODE` 不复用 `BRIDGE_PARAMS_INVALID`**：这两件事的**处理人不同**。
参数错是调用方写错了业务参数；线格式错是**客户端与壳不是同一版协议** ——
用户和开发者需要看到的是"重新装一次/换回匹配的版本"，而不是"参数不合法"。

**设备类错误按"出路"分开，不合成一个**：

| 码 | 含义 | 出路 |
| --- | --- | --- |
| `BRIDGE_CAMERA_UNAVAILABLE` | 没有可用摄像头 / 被占用后仍拿不到流 | 换设备或放弃 |
| `BRIDGE_CAMERA_DENIED` | 相机权限被拒 | 去系统设置里允许 |
| `BRIDGE_CAMERA_BUSY` | 摄像头被其它程序独占 | 关掉别的程序再重试 |
| `BRIDGE_NFC_UNSUPPORTED` | 本机没有 NFC 硬件 | **没有出路**（换设备）；壳不声明 `nfc.read`、界面不画入口 |
| `BRIDGE_NFC_DISABLED` | 有硬件但系统里关着 | **有出路**：调本机方法 `nfc.openSettings` 去开 |

合成一个码的代价是界面只能说一句"设备不可用"，用户不知道下一步该干什么。

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
- **v5 起还有一组"三份"是加密**（Kotlin `BridgeCrypto.kt` / TS `seal.ts` / 工具 `bridge-wire.mjs`）。
  它们和线格式一样危险（漂移的表现是"有时连得上、有时连不上"），但**不能被 review 看住** ——
  nonce 少一位、KDF 里少拼一个标签、AAD 少算一个字节，代码全都"看起来对"。
  所以 v5 的机制是**冻结向量**：`bridge-crypto-vectors.json` 固定输入 → 固定输出，
  `pnpm check:crypto-vectors` 逐条比对（81 项），Kotlin 另跑 `BridgeCryptoTest`。
  **改 crypto 必须同时改向量**；只改一边，门禁红。

## 9. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v3 | W0 冻结 | 初版：四类帧、`__bridge.json` 引导、167 条方法白名单、带外大对象通道 |
| v3 | W6/W7 | 方法表新增 `paramStyle` 字段（`body`/`query`）：11 个服务端用 `@RequestParam` 的 POST/PUT 端点改走 query。**帧格式与版本号不变**，老 Web 产物仍能跑，只是这些方法调不通 |
| v3 | W8 | 方法表新增 `keepPathParamsInBody`（默认 false）；启用 `err.details` 承载服务端业务拒绝原因（白名单前缀 + 截断）。两者都是**新增可选字段**，老产物不受影响 |
| v4 | 2026-10-04 | **不兼容**：线格式改为"二进制消息 + 12 字节定长帧头"，`v`/`type`/`id` 收进帧头、正文删掉 `ok`；新增数据面 `bin`（≤8MiB）与 `limits` 下发；新增 `BRIDGE_WIRE_MODE`；成帧装配收口为唯一实现 `WireReader`（两条传输只负责读写 WebSocket 消息）。**167 条方法语义与 §4/§5/§6 的口径逐条不变** |
| v4 | 2026-10-05 | **兼容新增**（帧格式与版本号不变）：本机方法 `nfc.openSettings`（`BridgeLocalMethods`，宿主实现）；NFC 两个错误码 `BRIDGE_NFC_UNSUPPORTED` / `BRIDGE_NFC_DISABLED` 与两个事件 topic `nfc.tag` / `nfc.state`。本机方法不进生成的契约表（生成物重跑后 167 条不变） |
| **v5** | 2026-10-06 | **不兼容**：**帧内容全加密**（临时 ECDH P-256 + AES-256-GCM，§1.2）。`token` 改名 `psk` 并**从握手 URL 上删除**（URL 只带 `?k=<客户端公钥>`）；新增 `hello` 帧（kind 5，唯一允许明文）与 `flags.bit1 = ENC`；新增错误码 `BRIDGE_CRYPTO_FAILED`；新增预认证截止（1500ms / 池 4）；密文上限 = 明文上限 +295。**167 条方法与 §4/§5/§6 的口径逐条不变**；密文里装的就是逐字节的 v4 消息，所以业务代码零改动 |
| v5 | 2026-10-07 | **兼容新增**（帧格式与版本号不变）：能力位 `notify.system`（两个壳据此声明"这台机器会弹系统通知"）与事件 topic `notify.message`（正文 `{count, audible, latest{id,title,body,type,priority,at}}`，**不含令牌、不含收件人**）。新消息由桥轮询 `message.unreadCount` 发现，两个壳各自弹系统通知 |
| v5 | 2026-10-07 | **不兼容（方法表）**：**图形验证码整体删除**，人机验证落地（点一下按钮、零输入）。契约变化：删 `captcha.generate` / `captcha.verify` / `tag.batchBindWithCaptcha` / `user.delete`（**那条无验证的 DELETE 是安全洞**）；`user.deleteWithCaptcha` 改名 `user.deleteWithVerify`（`POST /api/users/{userId}/delete`）；`auth.login` / `tag.batchBind` / `user.deleteWithVerify` 的请求体改带 **`humanToken`**（必填、一次性、由桥注入）。方法表 169 → **165**。三个入口的人机验证校验**下沉到 Service 层**，`DELETE /users/{id}` 与无票的 `batch-bind` 两条孪生路径同批删除 |

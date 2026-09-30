# 桥协议 v3

> 实现见 `bridge/protocol/src/main/kotlin/com/huicang/wise/bridge/protocol/`。
> 本文是规范；代码与本文不一致时，先改本文再改代码（或在本文记一次修正）。

## 1. 传输与握手

| 项 | 规定 |
| --- | --- |
| 地址 | `ws://127.0.0.1:{port}`，**只绑 loopback**，端口由系统分配（`port=0`）后经引导文件回填 |
| 路径 | `BridgeProtocol.HANDSHAKE_PATH` = `/bridge` |
| 鉴权 | 查询串 `?token=<token>`；token 每次启动新生成 256-bit，握手校验一次后绑定会话 |
| Origin | 白名单：`app://wise`（桌面）、`https://appassets.androidplatform.net`（手机）。不匹配立即断连 |
| 帧类型 | 文本帧（JSON）；二进制帧保留不用 |
| 单帧上限 | `MAX_FRAME_BYTES` = 256KB，超限回 `BRIDGE_FRAME_TOO_LARGE` |

## 2. 引导

Web 产物的第一步是读**自身 origin** 上的 `__bridge.json`：

```jsonc
{
  "port": 51234,
  "token": "…",
  "platform": "desktop",          // 或 "mobile"
  "ver": "1.0.0",                 // 产品版本
  "protocol": 3,                  // 协议版本；不匹配直接报错，不静默降级
  "capabilities": ["scan.camera", "nfc.read", "print.label", "window.control"]
}
```

`capabilities` 的取值见 `BridgeCapabilities`。**UI 判定平台差异只能看能力表，不许判断 `platform` 字符串。**

## 3. 四类帧

```jsonc
// req —— Web → 壳
{"v":3,"type":"req","id":"7f3a-1","method":"inventory.list","params":{"page":1,"size":20},
 "meta":{"screen":"inventory/list","requestId":"1731-9a2f"}}

// res —— 壳 → Web（成功）。data 就是后端 payload.data，已解析
{"v":3,"type":"res","id":"7f3a-1","ok":true,"data":{"rows":[],"total":0},
 "meta":{"ts":1731000000,"cache":"miss","traceId":"1731-9a2f"}}

// err —— 壳 → Web（失败）
{"v":3,"type":"err","id":"7f3a-1","error":{"code":"RES-4010","messageKey":"error_session_expired","retryable":false}}

// evt —— 壳 → Web（推送）
{"v":3,"type":"evt","topic":"scan.code","data":{"code":"TAG-0001","symbology":"code128"}}
```

两个不可动摇的细节：

1. **版本字段名是 `v`，判别字段名是 `type`。** 由 `BridgeCodec.json` 的 `classDiscriminator = "type"` 与
   `@SerialName("v")` 固定，`BridgeFrameCodecTest` 守着（它同时断言线格式里不出现 `version` 这个键）。
2. **`encodeDefaults = true`。** 否则 `v` 会变成可选字段，版本协商失去依据。

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

## 5. 错误码

桥自己的错误（前缀 `BRIDGE_`，见 `BridgeErrorCodes`）：
`BRIDGE_METHOD_UNKNOWN` / `BRIDGE_PARAMS_INVALID` / `BRIDGE_UNAUTHORIZED` /
`BRIDGE_FRAME_TOO_LARGE` / `BRIDGE_RATE_LIMITED` / `BRIDGE_BACKEND_UNREACHABLE` / `BRIDGE_INTERNAL`。

后端错误**原样透传**后端编码（如 `RES-4010`）。

**文案不下发**：只给 `messageKey`，由 Web 侧 i18n 解析。
这延续旧版"谁展示谁拥有"的口径（旧仓 `ApiResponseHandler` 里 401 不带文案的同一决定）。

## 6. 大对象与二进制（带外通道）

任何超过帧上限或本身是二进制的数据都不进 WS 帧：

| 场景 | 做法 |
| --- | --- |
| 导出 PDF（`inspection.resultPdf`）、文件下载（`file.download`） | 桥落盘 → 返回 `{"url":"…","expiresIn":30}` 一次性 URL → Web 用普通 HTTP 取 |
| 上传（`file.upload` / `oss.fileCreate` / `device.logUpload`） | Web 传本地句柄或分片句柄，壳侧组装 multipart 并直传 |
| 验证码图片（`captcha.generate`） | 桥落成 data URL / blob URL 后回给 Web，Web 不直接背 base64 字符串 |

## 7. 事件（`evt`）与背压

- 进度类事件（`upload.progress` 等）节流到 **≤10Hz**（`BridgeProtocol.EVENT_MIN_INTERVAL_MS`）。
- 事件 topic 命名 `域.动作`，与方法的域前缀一致。
- 壳侧对单连接做限流；命中回 `BRIDGE_RATE_LIMITED`。

## 8. 版本演进

- 不兼容改动：`BridgeProtocol.VERSION` +1，并在本文记一节变更说明。
- 兼容改动（新增方法/新增事件/新增可选字段）：不必升版本，但生成物必须重跑并提交。
- **协议版本不匹配时，Web 侧直接报错**，不做静默降级——半兼容的半可用状态比明确失败更难查。

## 9. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v3 | W0 冻结 | 初版：四类帧、`__bridge.json` 引导、167 条方法白名单、带外大对象通道 |
| v3 | W6/W7 | 方法表新增 `paramStyle` 字段（`body`/`query`）：11 个服务端用 `@RequestParam` 的 POST/PUT 端点改走 query。**帧格式与版本号不变**，老 Web 产物仍能跑，只是这些方法调不通 |

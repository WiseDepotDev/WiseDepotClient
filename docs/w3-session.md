# W3 会话与令牌截留（桥侧）

> 验收：`pnpm bench:w3`（用**可脚本化的假后端**把桥逼到边界，而不是靠真验证码碰运气）
> 实现：`bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/SessionManager.kt`

## 0. 范围

| 项 | 状态 |
| --- | --- |
| **W3-a** 桥侧会话：令牌截留、`bridge.session`、自动续期重放、登出本地先行 | ✅ 本批完成并实测 |
| **W3-b** Web 侧登录屏（验证码展示 → 账号密码 → 看板） | ⏳ 下一增量 |

## 1. 唯一要记的规则

> **令牌只允许存在于桥进程内。任何进出的 JSON 都会被扫一遍。**

做法不是"针对 `auth.login` 特判"——那样加一个新接口就漏。而是**按字段名递归剥离**：
无论哪个方法、嵌套多深，只要出现 `accessToken` / `refreshToken`，一律取出存进 `TokenStore`
并从返回给 Web 的报文里删除（位置填 `null`，保持对象形状稳定，前端不需要处理缺字段）。

这样"漏了一个新接口"不会升级成"漏了一个令牌"。

## 2. 实测结果（11/11 通过）

| 用例 | 结果 |
| --- | --- |
| 未登录时 `bridge.session.authenticated = false` | ✓ |
| `auth.login` 经桥调用成功 | ✓ |
| **响应里没有任何令牌**（`accessToken`/`refreshToken` 及其字面值全部不可见） | ✓ |
| 身份字段照常下发（`username` / `passwordChangeRequired`） | ✓ |
| 登录后 `bridge.session` 反映已认证 | ✓ |
| `bridge.session` 自身也不含令牌 | ✓ |
| **受保护方法成功，且假后端确实收到 `Bearer` 令牌**（证明桥把令牌带上了，而不是碰巧成功） | ✓ |
| **令牌失效 → 自动续期 → 重放一次**，UI 无感（refresh 恰好调用 1 次） | ✓ |
| 续期后的重放带的是**新**令牌 | ✓ |
| `auth.logout` 调用成功 | ✓ |
| 登出后 `authenticated = false` | ✓ |

## 3. 三个设计细节（都不是随手写的）

### 3.1 续期只做一次，且只在"本来持有令牌"时做

令牌失效时：`refreshToken` 续期 → **重放一次**原请求 → 仍失败就报错。
不做无限重试（续期失败时会把后端打成死循环），也不会在"未登录"时触发续期
（否则"密码错误"会白白变成一次续期请求）。

续期走的是契约里的**隐藏项** `auth.refreshToken`（`BridgeContract.excluded`）——
它对 Web 不可见，因为这是桥的内部行为，不是 UI 能发起的能力。

### 3.2 登出**本地先行**（本批实测暴露并修掉的设计漏洞）

第一轮验收时登出失败：假后端没实现 `/api/auth/logout`，而桥把"后端失败"当成了"没登出"，
于是 `authenticated` 仍然是 `true`。

这是真漏洞：**一台离线设备会永远停在"已登录"**。修法是登出类方法无论后端结果如何都清掉桥内会话，
但**返回值仍如实反映后端结果**（服务端会话可能还活着，不能骗 UI）。
两条合起来才是对的：本地一定能登出，同时 UI 知道服务端那边是否真的登出了。

### 3.3 续期加锁

并发请求同时发现令牌过期时只续一次（与旧仓 `AuthTokenRefresher` 同一意图）。
没有锁的话，N 个并发请求会打 N 次续期，而后端的 refresh 通常是一次性令牌——互相把对方作废。

## 4. 与真后端的关系（W2 已查清，W3 直接沿用）

- 后端 `RequestSignatureFilter` 用 `Authorization: Bearer` 当旁路 → **持令牌后每个请求都必须带 Bearer**（桥本来就这么做）；
- 令牌无效时后端回 **HTTP 200 + 业务码 `AUTH-0002`**，不是 401 → `isAuthFailure` 同时认 `AUTH*` 与 `HTTP-401`
  两种形态，后者留给网关/代理；
- 未登录前只有签名过滤器的排除表内路径可用（登录、验证码、`/api/device`、`/api/inspection`、
  `/api/inventories/all`、`/api/rfid/report`）——W3-b 的登录流必须落在这张表内。

## 5. 待办（W3-b）

1. Web 登录屏：验证码（`captcha.generate` 返回 `data:image/png;base64,…` 直接可渲染）→ 账号密码 → 提交；
2. 登录成功后按 `bridge.session` 决定去留，`expired` 为真时跳回登录；
3. 首页从 `dashboard.summary` 拉真数（`ListStateHost` 的四态已经就位）；
4. 真机/真后端冒烟：走一遍"验证码 → 登录 → 看板"，记录在验收表里。

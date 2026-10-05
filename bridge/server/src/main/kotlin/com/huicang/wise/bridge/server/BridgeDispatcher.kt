package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendPort
import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.backend.ParamStyle
import com.huicang.wise.bridge.capability.LocalMethodPort
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeBuiltins
import com.huicang.wise.bridge.protocol.BridgeContract
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeProtocol
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 方法分发：**唯一**决定"这个方法能不能被调用、由谁处理"的地方。
 *
 * 白名单是三段的并集：
 *  1. 内建方法（[BridgeBuiltins]，固定四个，测试里断言不与契约重名）；
 *  2. 本机方法（宿主声明的 [LocalMethodPort]）；
 *  3. 契约方法（[BridgeContract]，由服务端注解生成）。
 *
 * 不在这三段里的方法一律 `BRIDGE_METHOD_UNKNOWN` —— 桥**不是**通用 HTTP 透传。
 * 这条是本方案的安全红线：Web 层一旦 XSS，透传等于拿到任意后端接口。
 */
class BridgeDispatcher(
    private val backend: BackendPort,
    private val platform: PlatformPort,
    private val local: LocalMethodPort? = null,
    private val session: SessionManager,
    /**
     * 会话失效时的通知出口。
     *
     * 为什么必须由外面注入：分发器只负责"这个方法谁来处理"，它**不该知道**
     * WebSocket 长什么样（那是传输层的事）。装配点在 `BridgeServer`，
     * 它把这个回调接到 `emit(SessionManager.EVENT_SESSION_EXPIRED)` 上。
     *
     * 缺了它的后果是实测出来的：桥里已经没有会话，界面却还在已登录的画面上
     * 继续发请求，而后端对无令牌请求给的是**误导性的**「缺少必要的签名参数」。
     * 详见 `SessionManager.EVENT_SESSION_EXPIRED`。
     */
    private val onSessionExpired: () -> Unit = {},
    /** 指标：按方法记次数/失败/耗时。默认给一个不共享的实例，测试不必关心它。 */
    private val metrics: BridgeMetrics = BridgeMetrics(),
    /**
     * 人机验证票据的持有者：注入用的就是它（**票据不进 JS 上下文**）。
     *
     * 票据的"拿"与"用"必须发生在同一处，这一处就是分发器 —— 页面只请求验证，拿不到票据。
     */
    private val humanTokens: HumanTokenHolder = HumanTokenHolder(),
    /**
     * 人机验证执行器（`bridge.humanVerify` 的实际干活者）。
     *
     * 为什么是"取它的函数"而不是它本身：执行器要调 `dispatch(...)` 去访问后端，
     * 于是两者互相引用。用 lambda **在调用时**取值即可打破这个环
     * （与 `onSessionExpired` 同一个手法，那时字段已经就位）。
     * 宿主没接证据来源时它是 null ⇒ `bridge.humanVerify` 明确报不可用，而不是静默失败。
     */
    private val humanVerifyProvider: () -> HumanVerifyCollector? = { null },
) {
    suspend fun dispatch(
        method: String,
        params: JsonElement?,
        requestId: String,
    ): BackendResult {
        val started = metrics.start()
        val outcome = dispatchInner(method, params, requestId)
        metrics.record(method, outcome is BackendResult.Ok, metrics.elapsedMs(started))
        return outcome
    }

    private suspend fun dispatchInner(
        method: String,
        params: JsonElement?,
        requestId: String,
    ): BackendResult {
        if (method in BridgeBuiltins.all) {
            return dispatchBuiltin(method, params)
        }

        local?.let { port ->
            if (method in port.methodIds) {
                return runCatching { port.invoke(method, params) }
                    .fold(
                        onSuccess = { BackendResult.Ok(it) },
                        onFailure = { BackendResult.Failed(BridgeErrorCodes.INTERNAL, "bridge.localMethodFailed", retryable = false) },
                    )
            }
        }

        val entry =
            BridgeContract.find(method)
                ?: return BackendResult.Failed(
                    BridgeErrorCodes.METHOD_UNKNOWN,
                    "bridge.methodUnknown",
                    retryable = false,
                )

        /*
         * 人机验证票据的注入点（**唯一一处**）。
         *
         * 三个"破坏性/入口"方法各自需要一个**对应用途**的票据：用途不符就不注入，
         * 让服务端去拒绝 —— 桥不替服务端做判定，也不做"凑合用"。
         * 票据从不出现在 JS 里（与业务令牌同一待遇）。
         */
        val purpose = HumanPurposeByMethod[method]
        val effectiveParams =
            if (purpose == null) {
                params
            } else {
                humanTokens.injectInto(params, purpose)
            }

        val call =
            BackendCall(
                httpMethod = entry.httpMethod,
                pathTemplate = entry.path,
                packetType = entry.packetType,
                params = effectiveParams as? JsonObject,
                requestId = requestId,
                paramStyle = when (entry.paramStyle) {
                    BridgeContract.ParamStyle.QUERY -> ParamStyle.QUERY
                    BridgeContract.ParamStyle.BODY -> ParamStyle.BODY
                },
                keepPathParamsInBody = entry.keepPathParamsInBody,
            )

        var result = backend.call(call)

        // 登录态失效 → 用 refreshToken 续期后**重放一次**（只一次，避免续期失败时打成死循环）。
        // 只有"本来持有令牌却失效"才走这条；未登录时的 AUTH 失败（例如密码错）直接透传，
        // 否则会把"密码错误"也变成一次无谓的续期请求。
        if (result is BackendResult.Failed && SessionManager.isAuthFailure(result.code) && session.authenticated) {
            when (session.refresh()) {
                RefreshOutcome.REFRESHED -> result = backend.call(call)

                RefreshOutcome.EXPIRED -> {
                    // 后端明确说凭据不行 → 桥里已经没有会话。**必须告诉界面**，
                    // 否则它会停在"已登录"的画面上继续发请求，而每条请求都会被后端
                    // 以误导性的"缺少签名参数"拒掉（真因是没登录）。
                    session.markExpired()
                    onSessionExpired()
                }

                RefreshOutcome.UNAVAILABLE -> {
                    /*
                     * 续期**没能完成**（网络/超时）—— 既不是成功也不是过期：
                     *  · 不清令牌、不广播 `session.expired`：用户什么都没做错，不该被踢回登录屏；
                     *  · 原样把那次失败交回去（它是 `retryable=true`），由界面按既有口径提示与重试。
                     * 以前这里一律 `markExpired()`，于是"家里网络抖一下"就等于"登录过期"。
                     */
                    BridgeLog.info("[bridge] 续期暂时不可用，保留会话：method=$method")
                }
            }
        }

        // 登出：本地先行（后端不可达也必须能登出），但返回值仍如实反映后端结果
        if (method in SessionManager.LOGOUT_METHODS) {
            session.clear()
        }

        // 令牌截留：出站前扫一遍，`accessToken`/`refreshToken` 一律留在桥里。
        // `raw` 只是让这一步能用一次廉价预检跳过绝大多数响应（见 SessionManager.scrub）。
        return when (result) {
            is BackendResult.Ok -> BackendResult.Ok(session.scrub(result.data, result.raw))
            is BackendResult.Failed -> result
        }
    }

    private suspend fun dispatchBuiltin(
        method: String,
        params: JsonElement?,
    ): BackendResult =
        when (method) {
            BridgeBuiltins.PING ->
                BackendResult.Ok(
                    JsonObject(
                        mapOf(
                            "protocol" to JsonPrimitive(BridgeProtocol.VERSION),
                            "platform" to JsonPrimitive(platform.platform),
                            "ver" to JsonPrimitive(platform.version),
                        ),
                    ),
                )

            BridgeBuiltins.CAPABILITIES ->
                BackendResult.Ok(
                    JsonObject(
                        mapOf(
                            "platform" to JsonPrimitive(platform.platform),
                            "capabilities" to JsonArray(platform.capabilities.sorted().map { JsonPrimitive(it) }),
                        ),
                    ),
                )

            BridgeBuiltins.SESSION -> BackendResult.Ok(session.sessionInfo())

            /*
             * 指标：**本地观测**，不经过后端、也不改协议里任何既有语义。
             *
             * 为什么做成内建方法而不是日志：日志只能"回头看"，而现场需要的是
             * "现在哪条方法慢" —— 一个可以随时拉取的快照，配合 `tools/bench` 能直接对比。
             * 它是只读的（不改任何状态），因此不需要额外的权限检查。
             */
            BridgeBuiltins.METRICS -> BackendResult.Ok(metrics.snapshot())

            /*
             * 人机验证：Web 只**请求**一次验证，**拿不到票据**（票据由桥存着并在业务调用里注入）。
             *
             * 返回 `{ ok, purpose }`；失败时回一个真实错误码，让界面能说清"是环境问题还是被拒了"。
             */
            BridgeBuiltins.HUMAN_VERIFY -> {
                val collector =
                    humanVerifyProvider()
                        ?: return BackendResult.Failed(
                            BridgeErrorCodes.INTERNAL,
                            "bridge.humanVerifyUnavailable",
                            retryable = false,
                        )
                val purpose =
                    (params as? JsonObject)?.get("purpose")?.jsonPrimitive?.contentOrNull
                        ?: return BackendResult.Failed(
                            BridgeErrorCodes.PARAMS_INVALID,
                            "bridge.paramsInvalid",
                            retryable = false,
                        )
                val username = (params as? JsonObject)?.get("username")?.jsonPrimitive?.contentOrNull
                val pageEvidence = (params as? JsonObject)?.get("evidence") as? JsonObject
                val outcome = collector.obtain(purpose, username, pageEvidence)
                if (outcome.ok) {
                    BackendResult.Ok(
                        JsonObject(
                            mapOf(
                                "ok" to JsonPrimitive(true),
                                "purpose" to JsonPrimitive(purpose),
                            ),
                        ),
                    )
                } else {
                    /*
                     * 失败必须**带原因**：以前这里一律回 `BRIDGE_BACKEND_UNREACHABLE` + "请再试一次"，
                     * 于是"后端不是最新版（HTTP-400）""设备签名校验失败（AUTH-HUMAN-1006）"
                     * "账号已锁定（冷却）"三种截然不同的处境在界面上长得一模一样 ——
                     * 唯一正确的处置动作被藏掉了。所以：
                     *   · `code` 优先用**服务端自己的错误码**（界面/排障文档都按它们写）；
                     *   · 只有真到不了后端时才退化成 `BRIDGE_BACKEND_UNREACHABLE`。
                     */
                    BackendResult.Failed(
                        outcome.code ?: BridgeErrorCodes.BACKEND_UNREACHABLE,
                        outcome.messageKey ?: HumanVerifyCollector.KEY_FAILED,
                        retryable = outcome.retryable,
                    )
                }
            }

            else ->
                BackendResult.Failed(BridgeErrorCodes.METHOD_UNKNOWN, "bridge.methodUnknown", retryable = false)
        }

    companion object {
        /**
         * 需要人机验证票据的方法 → 用途。
         *
         * 这张表是**票据注入的唯一依据**：加一个新入口就要在这里加一行，否则它拿不到票据，
         * 服务端会直接拒绝 —— 失败是响亮的，不会静默放开。
         *
         * （`user.deleteWithCaptcha` 那条旧 id 已随图形验证码一起删除：契约里现在只有
         * `user.deleteWithVerify`，留着旧行只会在"方法不存在"时给人错觉。）
         */
        val HumanPurposeByMethod: Map<String, String> =
            mapOf(
                "auth.login" to "LOGIN",
                "tag.batchBind" to "TAG_BATCH_BIND",
                "user.deleteWithVerify" to "USER_DELETE",
            )
    }
}

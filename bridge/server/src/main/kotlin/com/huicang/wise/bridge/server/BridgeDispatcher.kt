package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendErrorCodes
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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 方法分发：**唯一**决定"这个方法能不能被调用、由谁处理"的地方。
 *
 * 白名单是两段的并集：
 *  1. 内建方法（[BridgeBuiltins]，固定三个，测试里断言不与契约重名）；
 *  2. 契约方法（[BridgeContract]，由服务端注解生成，167 条）。
 *
 * 不在这两段里的方法一律 `BRIDGE_METHOD_UNKNOWN` —— 桥**不是**通用 HTTP 透传。
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
) {
    suspend fun dispatch(
        method: String,
        params: JsonElement?,
        requestId: String,
    ): BackendResult {
        if (method in BridgeBuiltins.all) {
            return dispatchBuiltin(method)
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

        val call =
            BackendCall(
                httpMethod = entry.httpMethod,
                pathTemplate = entry.path,
                packetType = entry.packetType,
                params = params as? JsonObject,
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
            result =
                if (session.refresh()) {
                    backend.call(call)
                } else {
                    // 续期也失败了 → 桥里已经没有会话。**必须告诉界面**，
                    // 否则它会停在"已登录"的画面上继续发请求，而每条请求都会被后端
                    // 以误导性的"缺少签名参数"拒掉（真因是没登录）。
                    session.markExpired()
                    onSessionExpired()
                    result
                }
        }

        // 登出：本地先行（后端不可达也必须能登出），但返回值仍如实反映后端结果
        if (method in SessionManager.LOGOUT_METHODS) {
            session.clear()
        }

        // 令牌截留：出站前扫一遍，`accessToken`/`refreshToken` 一律留在桥里。
        return when (result) {
            is BackendResult.Ok -> BackendResult.Ok(session.scrub(result.data))
            is BackendResult.Failed -> result
        }
    }

    private fun dispatchBuiltin(method: String): BackendResult =
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

            else ->
                BackendResult.Failed(BridgeErrorCodes.METHOD_UNKNOWN, "bridge.methodUnknown", retryable = false)
        }

    companion object {
        /** 供测试与文档使用：桥实际接受的全部方法 id。 */
        fun allowedMethodIds(local: LocalMethodPort?): Set<String> =
            BridgeBuiltins.all + BridgeContract.methods.map { it.id } + (local?.methodIds ?: emptySet())

        /** 参数非法（例如 req 帧里 params 不是对象）。 */
        fun invalidParams(messageKey: String): BackendResult =
            BackendResult.Failed(BridgeErrorCodes.PARAMS_INVALID, messageKey, retryable = false)

        /** 后端不可达时的兜底（[BackendErrorCodes] 与 [BridgeErrorCodes] 同值，这里显式引用避免漂移）。 */
        val unreachable: BackendResult
            get() = BackendResult.Failed(BridgeErrorCodes.BACKEND_UNREACHABLE, "bridge.backendUnreachable", retryable = true)
    }
}

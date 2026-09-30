package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendErrorCodes
import com.huicang.wise.bridge.backend.BackendPort
import com.huicang.wise.bridge.backend.BackendResult
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
    private val sessionInfo: () -> JsonElement? = { null },
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

        return backend.call(
            BackendCall(
                httpMethod = entry.httpMethod,
                pathTemplate = entry.path,
                packetType = entry.packetType,
                params = params as? JsonObject,
                requestId = requestId,
            ),
        )
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

            BridgeBuiltins.SESSION -> BackendResult.Ok(sessionInfo() ?: JsonNull)

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

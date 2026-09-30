package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.protocol.BridgeError
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.ErrFrame
import com.huicang.wise.bridge.protocol.ReqFrame
import com.huicang.wise.bridge.protocol.ResFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** 从原始报文里抠出 `"id"`：帧太大还没解析时也要能回一个带 id 的错误。 */
internal val RAW_ID = Regex("\"id\"\\s*:\\s*\"([^\"]{1,64})\"")

/**
 * 一帧请求的完整处理：解析 → 限流 → 分发 → 编码响应。
 *
 * 为什么抽出来：**两种传输（Netty / 纯 socket）必须走完全相同的语义**。
 * 如果各写一份，攻击面就会随实现分叉——例如"忘了做帧大小检查"只会在其中一条路径上出现。
 * 这里返回的是"要回写的帧文本"，因此调用方只需要关心怎么把字符串发出去。
 */
class BridgeCallHandler(
    private val dispatcher: BridgeDispatcher,
) {
    /**
     * @param text 收到的一帧文本
     * @param limiter 该连接的限流器（每连接一个）
     * @return 要回写的帧文本（已编码）
     */
    suspend fun handle(
        text: String,
        limiter: RateLimiter,
    ): String {
        if (text.length > BridgeProtocol.MAX_FRAME_BYTES) {
            return BridgeCodec.encode(
                ErrFrame(
                    id = RAW_ID.find(text)?.groupValues?.get(1) ?: "",
                    error = BridgeError(BridgeErrorCodes.FRAME_TOO_LARGE, "bridge.frameTooLarge"),
                ),
            )
        }

        val parsed = runCatching { BridgeCodec.decode(text) }.getOrNull()
        if (parsed !is ReqFrame) {
            return BridgeCodec.encode(
                ErrFrame(
                    id = RAW_ID.find(text)?.groupValues?.get(1) ?: "",
                    error = BridgeError(BridgeErrorCodes.PARAMS_INVALID, "bridge.notARequestFrame"),
                ),
            )
        }

        if (!limiter.tryAcquire()) {
            return BridgeCodec.encode(
                ErrFrame(id = parsed.id, error = BridgeError(BridgeErrorCodes.RATE_LIMITED, "bridge.rateLimited")),
            )
        }

        val requestId = parsed.meta?.requestId?.takeIf { it.isNotBlank() } ?: parsed.id
        return encodeOutcome(parsed.id, runCatching { dispatcher.dispatch(parsed.method, parsed.params, requestId) }
            .getOrElse { BackendResult.Failed(BridgeErrorCodes.INTERNAL, "bridge.internal", retryable = true) })
    }

    /** 异步版：分发是挂起的，传输层自己决定在哪个作用域里等它。 */
    fun handleAsync(
        text: String,
        limiter: RateLimiter,
        scope: CoroutineScope,
        write: (String) -> Unit,
    ) {
        scope.launch {
            write(handle(text, limiter))
        }
    }

    private fun encodeOutcome(
        id: String,
        outcome: BackendResult,
    ): String =
        when (outcome) {
            is BackendResult.Ok -> BridgeCodec.encode(ResFrame(id = id, data = outcome.data ?: JsonNull))
            is BackendResult.Failed ->
                BridgeCodec.encode(
                    ErrFrame(
                        id = id,
                        error =
                            BridgeError(
                                code = outcome.code,
                                messageKey = outcome.messageKey,
                                retryable = outcome.retryable,
                            ),
                    ),
                )
        }

    /** 供传输层复用的"未就绪"响应（纯 socket 传输在桥没起来时会用到）。 */
    fun unauthorizedFrame(): String =
        BridgeCodec.encode(
            ErrFrame(id = "", error = BridgeError(BridgeErrorCodes.UNAUTHORIZED, "bridge.handshakeRejected")),
        )

    /** 心跳响应：WebSocket 的 ping 要回 pong。 */
    fun pongPayload(): JsonPrimitive = JsonPrimitive("pong")
}

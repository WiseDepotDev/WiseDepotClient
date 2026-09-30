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

/**
 * 从原始报文里抠出 `"id"`：帧太大、还没解析时也要能回一个带 id 的错误。
 *
 * **手写而不是正则**：原先这里是 `Regex("\"id\"\\s*:\\s*\"([^\"]{1,64})\"")`。
 * 同类正则在 Android 的 `java.util.regex` 上已经炸过一次（见 PathTemplate 的注释），
 * 而这个属性只在"超大帧/非法帧"这类罕见路径上才会被初始化 ——
 * 也就是说它是一颗**平时不响、真出事时才响**的地雷，正好落在最不该出问题的地方。
 * 手写扫描没有引擎差异，也更快。
 */
internal fun extractRawId(text: String): String {
    val key = "\"id\""
    var from = text.indexOf(key)
    while (from >= 0) {
        var i = from + key.length
        while (i < text.length && text[i].isWhitespace()) {
            i += 1
        }
        if (i < text.length && text[i] == ':') {
            i += 1
            while (i < text.length && text[i].isWhitespace()) {
                i += 1
            }
            if (i < text.length && text[i] == '"') {
                val end = text.indexOf('"', i + 1)
                if (end > i) {
                    return text.substring(i + 1, end).take(64)
                }
            }
        }
        from = text.indexOf(key, from + 1)
    }
    return ""
}

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
                    id = extractRawId(text),
                    error = BridgeError(BridgeErrorCodes.FRAME_TOO_LARGE, "bridge.frameTooLarge"),
                ),
            )
        }

        val parsed = runCatching { BridgeCodec.decode(text) }.getOrNull()
        if (parsed !is ReqFrame) {
            return BridgeCodec.encode(
                ErrFrame(
                    id = extractRawId(text),
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
        val outcome =
            try {
                dispatcher.dispatch(parsed.method, parsed.params, requestId)
            } catch (e: Throwable) {
                // **兜底必须说话，而且要把原因链说完**。原先这里只回一个 BRIDGE_INTERNAL，异常被完全吞掉 ——
                // 结果是"页面说取数失败、桥什么也没说"，只能靠猜（W3 在 WSA 上就卡在这个盲区）。
                //
                // 只打 `e.message` 也不够：`ExceptionInInitializerError` / `NoClassDefFoundError`
                // 这类异常的 message 恰恰是 **null**，真正的原因藏在 cause 里 ——
                // 实测第一次就撞上了这个，打印出来是一句毫无信息量的 `ExceptionInInitializerError: null`。
                BridgeLog.info("[bridge] 分发异常 method=${parsed.method}：${describe(e)}")
                BackendResult.Failed(BridgeErrorCodes.INTERNAL, "bridge.internal", retryable = true)
            }
        return encodeOutcome(parsed.id, outcome)
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

    /**
     * 把异常的原因链打平成一行的可读文本（`A: m ← B: m ← C: m`），
     * 并附上**最深层原因的 5 帧栈**。
     *
     * 为什么要栈：`ExceptionInInitializerError` / `NoClassDefFoundError` 只说"某个类的静态初始化炸了"，
     * **不说是哪个类**。没有栈就只能知道"有个正则不合法"，知道是哪一行才有得修。
     */
    private fun describe(e: Throwable): String {
        val parts = mutableListOf<String>()
        var cur: Throwable? = e
        var depth = 0
        while (cur != null && depth < 5) {
            parts += "${cur.javaClass.name}: ${cur.message ?: "(无消息)"}"
            cur = cur.cause
            depth += 1
        }
        val deepest = generateSequence(e) { it.cause }.last()
        val frames = deepest.stackTrace.take(5).joinToString(" | ") { "${it.className}.${it.methodName}:${it.lineNumber}" }
        return parts.joinToString(" ← ") + " @ " + frames
    }

    /** 供传输层复用的"未就绪"响应（纯 socket 传输在桥没起来时会用到）。 */
    fun unauthorizedFrame(): String =
        BridgeCodec.encode(
            ErrFrame(id = "", error = BridgeError(BridgeErrorCodes.UNAUTHORIZED, "bridge.handshakeRejected")),
        )

    /** 心跳响应：WebSocket 的 ping 要回 pong。 */
    fun pongPayload(): JsonPrimitive = JsonPrimitive("pong")
}

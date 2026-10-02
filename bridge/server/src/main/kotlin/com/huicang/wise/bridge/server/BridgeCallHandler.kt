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
 * 帧预算：**协议上限**与**传输层硬上限**是两件事，别混。
 *
 *  - [PROTOCOL_LIMIT]：协议承诺的单帧上限（256KB）。超过它**不是**断开理由，
 *    而是**回一条带 id 的 `BRIDGE_FRAME_TOO_LARGE`** —— 界面上才能说清"这条请求太大了"。
 *    判定在 [BridgeCallHandler.preflight] 里（两条传输共用同一份）。
 *  - [HARD_LIMIT]：传输层为了"把错误说清楚"而愿意读进来的硬上限。
 *    超过它就连错误帧都不写了：对方要么是坏的，要么是恶意的，为它分配内存不值得。
 */
object FrameBudget {
    /** == `BridgeProtocol.MAX_FRAME_BYTES`（256KB）。 */
    const val PROTOCOL_LIMIT: Int = BridgeProtocol.MAX_FRAME_BYTES

    /** 4 倍于协议上限：够把"超大帧"这条错误路径走完，又不至于被一次分配拖死。 */
    const val HARD_LIMIT: Int = BridgeProtocol.MAX_FRAME_BYTES * 4
}

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
 * 一帧请求的完整处理：**前置检查（同步）** → **分发（挂起）**。
 *
 * ## 为什么拆成两段（这条是"背压"的落点）
 *
 * 原先只有 `handleAsync()`：不管这帧是不是合法、是不是已经超限、有没有被限流，
 * 一律 `scope.launch { ... }` —— 于是一个失控的页面能把**成千上万条注定被拒的帧**
 * 排进协程队列（内存与调度都被它占着），而限流判定本身还要先做一次 JSON 解析。
 *
 * 现在：
 *  - 大小、解析、限流三件事全是同步且廉价的 → 放在 [preflight]，**不占协程**；
 *  - 被拒的帧**原地回写**（调用方所在线程/事件循环），根本不入队；
 *  - 只有真的要去后端取数的那一步才 `launch`。
 *
 * ## 为什么 `byteLength` 要由调用方传
 *
 * 协议上限是按**字节**算的，而传输层本来就知道字节数（Netty：`frame.content().readableBytes()`；
 * 自写传输：帧头里的 length）。原先这里做 `text.toByteArray(UTF_8).size` ——
 * 为了量个长度，把最大 256KB 的内容**再编码一遍**，纯浪费。
 */
class BridgeCallHandler(
    private val dispatcher: BridgeDispatcher,
) {
    /** 前置检查的结论。 */
    sealed interface Preflight {
        /** 直接回这一帧（超限 / 非法 / 限流），不需要协程，也不进分发。 */
        data class Reject(
            val frame: String,
        ) : Preflight

        /** 通过：参数已解析好，交给 [complete]。 */
        data class Accepted(
            val request: ReqFrame,
            val requestId: String,
        ) : Preflight
    }

    /**
     * 同步前置检查：**能在这里拒绝的，绝不进协程**。
     *
     * @param text 收到的一帧文本
     * @param byteLength 这一帧在**线上**的字节数（由传输层给出，不要再自己编码一遍去量）
     * @param limiter 该连接的限流器（每连接一个）
     */
    fun preflight(
        text: String,
        byteLength: Int,
        limiter: RateLimiter,
    ): Preflight {
        if (byteLength > FrameBudget.PROTOCOL_LIMIT) {
            return Preflight.Reject(
                BridgeCodec.encode(
                    ErrFrame(
                        id = extractRawId(text),
                        error = BridgeError(BridgeErrorCodes.FRAME_TOO_LARGE, "bridge.frameTooLarge"),
                    ),
                ),
            )
        }

        val parsed = runCatching { BridgeCodec.decode(text) }.getOrNull()
        if (parsed !is ReqFrame || parsed.version != BridgeProtocol.VERSION || parsed.id.isBlank() || parsed.method.isBlank()) {
            return Preflight.Reject(
                BridgeCodec.encode(
                    ErrFrame(
                        id = extractRawId(text),
                        error = BridgeError(BridgeErrorCodes.PARAMS_INVALID, "bridge.notARequestFrame"),
                    ),
                ),
            )
        }

        if (!limiter.tryAcquire()) {
            return Preflight.Reject(
                BridgeCodec.encode(
                    ErrFrame(id = parsed.id, error = BridgeError(BridgeErrorCodes.RATE_LIMITED, "bridge.rateLimited")),
                ),
            )
        }

        val requestId = parsed.meta?.requestId?.takeIf { it.isNotBlank() } ?: parsed.id
        return Preflight.Accepted(parsed, requestId)
    }

    /** 真正去后端取数并编码响应（挂起）。 */
    suspend fun complete(
        request: ReqFrame,
        requestId: String,
    ): String {
        val outcome =
            try {
                dispatcher.dispatch(request.method, request.params, requestId)
            } catch (e: Throwable) {
                // **兜底必须说话，而且要把原因链说完**。原先这里只回一个 BRIDGE_INTERNAL，异常被完全吞掉 ——
                // 结果是"页面说取数失败、桥什么也没说"，只能靠猜（W3 在 WSA 上就卡在这个盲区）。
                //
                // 只打 `e.message` 也不够：`ExceptionInInitializerError` / `NoClassDefFoundError`
                // 这类异常的 message 恰恰是 **null**，真正的原因藏在 cause 里 ——
                // 实测第一次就撞上了这个，打印出来是一句毫无信息量的 `ExceptionInInitializerError: null`。
                BridgeLog.info("[bridge] 分发异常 method=${request.method}：${describe(e)}")
                BackendResult.Failed(BridgeErrorCodes.INTERNAL, "bridge.internal", retryable = true)
            }
        return encodeOutcome(request.id, outcome)
    }

    /** 同步版：前置检查 + 分发。测试与需要"一问一答"语义的调用方用它。 */
    suspend fun handle(
        text: String,
        byteLength: Int,
        limiter: RateLimiter,
    ): String =
        when (val checked = preflight(text, byteLength, limiter)) {
            is Preflight.Reject -> checked.frame
            is Preflight.Accepted -> complete(checked.request, checked.requestId)
        }

    /**
     * 异步版：被拒的帧**同步回写**，只有真的要取数的才进协程。
     *
     * @param write 回写一帧的回调（由传输层提供；必须线程安全或由传输层自行加锁）
     */
    fun handleAsync(
        text: String,
        byteLength: Int,
        limiter: RateLimiter,
        scope: CoroutineScope,
        write: (String) -> Unit,
    ) {
        when (val checked = preflight(text, byteLength, limiter)) {
            is Preflight.Reject -> write(checked.frame)
            is Preflight.Accepted ->
                scope.launch {
                    write(complete(checked.request, checked.requestId))
                }
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
                                // 业务拒绝原因（已按白名单前缀过滤 + 截断，见 BackendErrorCodes.detailFor）
                                details = outcome.details?.let { JsonPrimitive(it) },
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

    /** 供传输层复用的"未就绪"响应（自写传输在桥没起来时会用到）。 */
    fun unauthorizedFrame(): String =
        BridgeCodec.encode(
            ErrFrame(id = "", error = BridgeError(BridgeErrorCodes.UNAUTHORIZED, "bridge.handshakeRejected")),
        )
}

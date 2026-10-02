package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.protocol.BridgeError
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeFrame
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.BridgeWire
import com.huicang.wise.bridge.protocol.ErrFrame
import com.huicang.wise.bridge.protocol.ReqFrame
import com.huicang.wise.bridge.protocol.ResFrame
import com.huicang.wise.bridge.protocol.WireDecode
import com.huicang.wise.bridge.protocol.WireFault
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/**
 * 帧预算：**协议上限**与**传输层硬上限**是两件事，别混。
 *
 *  - [PROTOCOL_LIMIT]：控制面承诺的正文上限（256KB）。超过它**不是**断开理由，
 *    而是**回一条带 id 的 `BRIDGE_FRAME_TOO_LARGE`** —— 界面上才能说清"这条请求太大了"。
 *  - 硬上限（[BridgeWire.HARD_CONTROL_BYTES] / [BridgeWire.HARD_BIN_BYTES]）由
 *    消息层装配器 [com.huicang.wise.bridge.protocol.WireReader] 执行：超过它连错误帧
 *    都不一定写得出去（对方要么是坏的，要么是恶意的），为它分配内存不值得。
 *
 * v4 起这两级上限都**分平面**：控制面小（每次交互都走，失控页面撑不爆内存），
 * 数据面大（偶发的二进制对象，不值得为它再开一条带外网络路径）。
 */
object FrameBudget {
    /** == `BridgeProtocol.MAX_FRAME_BYTES`（256KB，控制面正文）。 */
    const val PROTOCOL_LIMIT: Int = BridgeProtocol.MAX_FRAME_BYTES

    /** == `BridgeProtocol.MAX_BIN_BYTES`（8MiB，`bin` 正文）。 */
    const val BIN_LIMIT: Int = BridgeProtocol.MAX_BIN_BYTES

    /**
     * 单个 **WebSocket 帧**在线上允许的最大字节数（Netty 解码器与自写传输的读帧都用它）。
     *
     * 比任何一个**消息**上限都宽松一点：帧上限只是"别为一个撒谎的长度先分配内存"，
     * 真正的消息级判定在共用的 [com.huicang.wise.bridge.protocol.WireReader]。
     */
    const val MAX_FRAME_ON_WIRE: Int =
        BridgeProtocol.MAX_BIN_BYTES + BridgeWire.HEADER_BYTES + BridgeWire.MAX_ID_BYTES
}

/**
 * 一帧请求的完整处理：**前置检查（同步）** → **分发（挂起）**。
 *
 * ## 为什么拆成两段（这条是"背压"的落点）
 *
 * 原先只有 `handleAsync()`：不管这帧是不是合法、是不是已经超限、有没有被限流，
 * 一律 `scope.launch { ... }` —— 于是一个失控的页面能把**成千上万条注定被拒的帧**
 * 排进协程队列（内存与调度都被它占着），而限流判定本身还要先做一次解析。
 *
 * 现在：
 *  - 解析、限额、限流三件事全是同步且廉价的 → 放在 [preflight]，**不占协程**；
 *  - 被拒的帧**原地回写**（调用方所在线程/事件循环），根本不入队；
 *  - 只有真的要去后端取数的那一步才 `launch`。
 *
 * ## v4：这里收发的是**帧**，不是字符串
 *
 * 线上是二进制帧（[BridgeWire]），逻辑帧是 [BridgeFrame]。
 * 让 handler 收发**帧**、由传输层负责编码，好处是"线格式"只有一处实现：
 * 传输层不可能各自发明一套略有差异的编解码（这正是 v3 里两条传输漂移的土壤）。
 */
class BridgeCallHandler(
    private val dispatcher: BridgeDispatcher,
) {
    /** 前置检查的结论。 */
    sealed interface Preflight {
        /** 直接回这一帧（超限 / 非法 / 限流），不需要协程，也不进分发。 */
        data class Reject(
            val frame: BridgeFrame,
        ) : Preflight

        /** 通过：请求已解析好，交给 [complete]。 */
        data class Accepted(
            val request: ReqFrame,
            val requestId: String,
        ) : Preflight
    }

    /**
     * 同步前置检查：**能在这里拒绝的，绝不进协程**。
     *
     * @param message 收到的一条完整消息（已由 [com.huicang.wise.bridge.protocol.WireReader] 装配好）
     * @param limiter 该连接的限流器（每连接一个）
     */
    fun preflight(
        message: ByteArray,
        limiter: RateLimiter,
    ): Preflight {
        val decoded = BridgeWire.decode(message)
        if (decoded is WireDecode.Rejected) {
            return Preflight.Reject(rejectionFor(decoded))
        }
        val frame = (decoded as WireDecode.Ok).frame

        // 控制面正文超过协议上限：回错误而不是断开（界面上才能说清"这条请求太大了"）
        if (decoded.bodyBytes > FrameBudget.PROTOCOL_LIMIT) {
            return Preflight.Reject(
                errorFrame(BridgeWire.headerId(message), BridgeErrorCodes.FRAME_TOO_LARGE, "bridge.frameTooLarge"),
            )
        }

        // v4 只接受请求帧；其余 kind 是"对端搞错了方向"，与 v3 的 notARequestFrame 同义
        if (frame !is ReqFrame || frame.id.isBlank() || frame.method.isBlank()) {
            return Preflight.Reject(
                errorFrame(BridgeWire.headerId(message), BridgeErrorCodes.PARAMS_INVALID, "bridge.notARequestFrame"),
            )
        }

        if (!limiter.tryAcquire()) {
            return Preflight.Reject(errorFrame(frame.id, BridgeErrorCodes.RATE_LIMITED, "bridge.rateLimited"))
        }

        val requestId = frame.meta?.requestId?.takeIf { it.isNotBlank() } ?: frame.id
        return Preflight.Accepted(frame, requestId)
    }

    /** 真正去后端取数并编码响应（挂起）。 */
    suspend fun complete(
        request: ReqFrame,
        requestId: String,
    ): BridgeFrame {
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
        message: ByteArray,
        limiter: RateLimiter,
    ): BridgeFrame =
        when (val checked = preflight(message, limiter)) {
            is Preflight.Reject -> checked.frame
            is Preflight.Accepted -> complete(checked.request, checked.requestId)
        }

    /**
     * 异步版：被拒的帧**同步回写**，只有真的要取数的才进协程。
     *
     * @param write 回写一帧的回调（由传输层提供；必须线程安全或由传输层自行加锁）
     */
    fun handleAsync(
        message: ByteArray,
        limiter: RateLimiter,
        scope: CoroutineScope,
        write: (BridgeFrame) -> Unit,
    ) {
        when (val checked = preflight(message, limiter)) {
            is Preflight.Reject -> write(checked.frame)
            is Preflight.Accepted ->
                scope.launch {
                    write(complete(checked.request, checked.requestId))
                }
        }
    }

    private fun rejectionFor(rejected: WireDecode.Rejected): BridgeFrame =
        when (rejected.fault) {
            // 结构上限命中：语义与"正文超协议上限"一样，都是这条消息太大
            WireFault.TOO_LARGE ->
                errorFrame(rejected.id, BridgeErrorCodes.FRAME_TOO_LARGE, "bridge.frameTooLarge")
            // 其余都是"线格式不认识"：magic/版本/kind/flags/扩展头/长度/正文
            // 单列一个码，因为它要告诉用户的是"客户端与壳不是同一版协议"，不是"参数写错了"
            WireFault.BAD_BODY ->
                errorFrame(rejected.id, BridgeErrorCodes.PARAMS_INVALID, "bridge.notARequestFrame")
            else -> wireModeFrame(rejected.id)
        }

    private fun encodeOutcome(
        id: String,
        outcome: BackendResult,
    ): BridgeFrame =
        when (outcome) {
            is BackendResult.Ok -> ResFrame(id = id, data = outcome.data ?: JsonNull)
            is BackendResult.Failed ->
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
                )
        }

    /** 构造一条错误帧（传输层也要用：文本帧、超大帧、握手失败）。 */
    fun errorFrame(
        id: String,
        code: String,
        messageKey: String,
    ): BridgeFrame = ErrFrame(id = id, error = BridgeError(code = code, messageKey = messageKey))

    /**
     * "线格式不认识"：v3 的文本帧、magic 不对、版本不符、未知 kind/flags、非 0 扩展头。
     *
     * 传 `id` 是为了**尽量**让它对得上号；magic 都不对时为空串（不许乱猜）。
     */
    fun wireModeFrame(id: String): BridgeFrame =
        errorFrame(id, BridgeErrorCodes.WIRE_MODE, "bridge.wireMode")

    /** 供传输层复用的"未就绪"响应（自写传输在桥没起来时会用到）。 */
    fun unauthorizedFrame(): BridgeFrame =
        errorFrame("", BridgeErrorCodes.UNAUTHORIZED, "bridge.handshakeRejected")

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
}

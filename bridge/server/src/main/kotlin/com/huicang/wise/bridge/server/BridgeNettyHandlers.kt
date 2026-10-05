package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeCrypto
import com.huicang.wise.bridge.protocol.BridgeCryptoException
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeFrame
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.BridgeWire
import com.huicang.wise.bridge.protocol.WireRead
import com.huicang.wise.bridge.protocol.WireReader
import io.netty.buffer.Unpooled
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelInboundHandlerAdapter
import io.netty.channel.SimpleChannelInboundHandler
import io.netty.channel.group.ChannelGroup
import io.netty.handler.codec.http.DefaultFullHttpResponse
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpHeaderNames
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.HttpUtil
import io.netty.handler.codec.http.HttpVersion
import io.netty.handler.codec.http.QueryStringDecoder
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame
import io.netty.handler.codec.http.websocketx.CloseWebSocketFrame
import io.netty.handler.codec.http.websocketx.ContinuationWebSocketFrame
import io.netty.handler.codec.http.websocketx.PingWebSocketFrame
import io.netty.handler.codec.http.websocketx.PongWebSocketFrame
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame
import io.netty.handler.codec.http.websocketx.WebSocketFrame
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler
import io.netty.handler.timeout.IdleStateEvent
import io.netty.util.CharsetUtil
import io.netty.util.ReferenceCountUtil
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope

/**
 * Netty 侧的握手：形状与来源校验（[HandshakePolicy]）+ 建立加密会话（v5）。
 *
 * 分工写清楚，避免"以为 Origin 是主防线"：
 * - **身份由加密层证明**（v5）：能产出第一条合法 AEAD 帧的，就是持有 psk 的那一方。
 *   HTTP 层不再有可比较的凭据 —— v4 那个挂 URL 上的 token 已经不再上线。
 * - **Origin 是纵深**：浏览器一定带 Origin，带且不在白名单就拒；不带则放行
 *   （原生客户端与基准脚本不带 Origin，它们也不是浏览器）。
 * - **`?k=` 是密钥材料**（客户端临时公钥）：它不是凭据，但**非法就必须立刻拒** ——
 *   不合法或不在曲线上的点不该进 ECDH。
 * - **预认证池**：升级成功只是"占了一个待认位"（[PreAuthGate]），还要在截止时间内
 *   交出合法密文帧才算真的连上。
 */
class BridgeAuthHandler(
    private val psk: String,
    private val allowedOrigins: Set<String>,
    private val gate: PreAuthGate,
) : ChannelInboundHandlerAdapter() {
    override fun channelRead(
        ctx: ChannelHandlerContext,
        msg: Any,
    ) {
        if (msg is FullHttpRequest) {
            val factory = msg.decoderResult()
            val uri = QueryStringDecoder(msg.uri())
            val origin = msg.headers()[HttpHeaderNames.ORIGIN]

            val decision =
                HandshakePolicy.decide(
                    method = msg.method().name(),
                    path = uri.path(),
                    origin = origin,
                    allowedOrigins = allowedOrigins,
                )
            val rejection =
                when {
                    !factory.isSuccess -> HttpResponseStatus.BAD_REQUEST
                    decision.reject?.first == 403 -> HttpResponseStatus.FORBIDDEN
                    decision.reject?.first == 404 -> HttpResponseStatus.NOT_FOUND
                    decision.reject?.first == 405 -> HttpResponseStatus.METHOD_NOT_ALLOWED
                    decision.reject != null -> HttpResponseStatus.BAD_REQUEST
                    else -> null
                }

            if (rejection != null) {
                // 拒绝握手必须留痕：静默拒绝会让"连不上"变成无法诊断的悬案
                BridgeLog.info("[bridge] 握手被拒 ${rejection.code()}：path=${uri.path()} origin=${origin ?: "(无)"}")
                reject(ctx, rejection)
                ReferenceCountUtil.release(msg)
                return
            }

            /*
             * v5：握手通过之后**就地建立加密会话**。
             *
             * 密钥材料是查询串里的 `?k=`（客户端临时公钥，hex 的未压缩点）；
             * 它缺失/不合法一律 400 拒绝（非法点不该进 ECDH，见 `SealedChannel.handshake`）。
             */
            val clientKeyHex = uri.parameters()["k"]?.firstOrNull()
            val sealed =
                runCatching {
                    SealedChannel.handshake(
                        BridgeCrypto.fromHex(clientKeyHex ?: ""),
                        SealedChannel.pskBytes(psk),
                    )
                }.getOrNull()
            if (sealed == null) {
                BridgeLog.info("[bridge] 握手被拒 400：缺少或非法的客户端公钥（k）")
                reject(ctx, HttpResponseStatus.BAD_REQUEST)
                ReferenceCountUtil.release(msg)
                return
            }

            // 预认证池：满了就明确拒绝（不排队等），否则"连上不说话"就是免费的占位手段
            if (!gate.tryEnter()) {
                BridgeLog.info("[bridge] 预认证连接数已达上限（${gate.pendingCount}），拒绝 ${ctx.channel().remoteAddress()}")
                reject(ctx, HttpResponseStatus.SERVICE_UNAVAILABLE)
                ReferenceCountUtil.release(msg)
                return
            }

            ctx.channel().attr(SEALED_CHANNEL).set(sealed)
            ctx.channel().attr(AUTH_STATE).set(AuthState(gate))

            // 截止时间从**握手完成**开始算（在 BridgeFrameHandler 收到 HandshakeComplete 时调度）

            // 校验通过后把 URI 收敛成裸路径。
            //
            // 为什么必须这么做（W2 实测踩到的坑，代价是一小时的排查）：
            // `WebSocketServerProtocolHandler` 对 websocketPath 做的是 **uri 精确匹配**，
            // 而浏览器的 WebSocket API 无法设置自定义头，参数只能挂在查询串上；
            // 于是 `/bridge?k=…` 匹配不上 `/bridge`，握手处理器**既不响应也不报错**，
            // 客户端表现为"连上了但永远等不到响应"。
            msg.setUri(BridgeProtocol.HANDSHAKE_PATH)
        }
        ctx.fireChannelRead(msg)
    }

    private fun reject(
        ctx: ChannelHandlerContext,
        status: HttpResponseStatus,
    ) {
        // 握手在 HTTP 层就被拒了 —— 这时**还没有任何帧**，所以回的是普通 JSON 错误体，
        // 不是 v4 帧（浏览器的 WebSocket API 不会把它交给 JS，只有工具/测试会看它）。
        val body = """{"code":"${BridgeErrorCodes.UNAUTHORIZED}","messageKey":"bridge.handshakeRejected"}"""
        val content = Unpooled.copiedBuffer(body, CharsetUtil.UTF_8)
        val response =
            DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, content).apply {
                HttpUtil.setContentLength(this, content.readableBytes().toLong())
                headers().set(HttpHeaderNames.CONTENT_TYPE, "application/json; charset=utf-8")
            }
        ctx.writeAndFlush(response).addListener { ctx.close() }
    }
}

/**
 * 帧处理（Netty 侧）：**只负责把字节搬给 [BridgeCallHandler]**。
 *
 * 解析、限流、白名单、分发、编码全部在共用的处理器里 —— 于是"两条传输语义一致"
 * 这件事是**结构保证**的，而不是靠两处代码互相对照维持。
 *
 * ## 这一层自己要做三件事（都是"传输才知道"的）
 *
 * 1. **分片聚合**：RFC6455 允许一条消息拆成多帧，浏览器发大 payload 时就会。
 *    以前第一条分片就被当成完整文本帧去解析，回一句"这不是请求帧"；
 *    而 Netty 侧还有协议处理器的单帧上限兜着 —— 同一个大请求在手机上能用、电脑上不能用。
 * 2. **ping/pong 与 close**：pong 由协议层自动答，这里只处理 ping（回 pong，payload 原样带回）
 *    与 close；`IdleStateEvent`（读空闲）说明对端已经不在了，**主动关**。
 * 3. **背压**：被拒的帧由 [BridgeCallHandler.preflight] **同步**回写，只有真要取数的才进协程 ——
 *    于是失控页面刷过来的帧不会堆在协程队列里。协程跑在一个**有界线程池**上（由 BridgeServer 注入），
 *    不会把 `Dispatchers.IO` 的线程吃光。
 */
class BridgeFrameHandler(
    private val callHandler: BridgeCallHandler,
    private val rateLimiter: RateLimiter,
    private val channels: ChannelGroup,
    /** 分发用的协程作用域：**由 server 统一持有并在 stop() 时取消**（以前是每连接一个、从不取消）。 */
    private val scope: CoroutineScope,
    /** 预认证截止时间（毫秒）：这么久还没交出合法密文帧就关掉（见 [PreAuthGate]）。 */
    private val preAuthDeadlineMs: Long,
) : SimpleChannelInboundHandler<WebSocketFrame>() {
    /** v4：分片装配由共用的 [WireReader] 负责（两条传输同一份实现，不再各写一遍）。 */
    private val reader = WireReader()

    override fun channelActive(ctx: ChannelHandlerContext) {
        // 注意：这一行只证明 **TCP accept 成功**，不证明 WebSocket 握手完成 ——
        // 握手响应由 WebSocketServerProtocolHandler 在更后面发。
        // 两者要分开看，否则"连上了但卡在握手"会被误读成"一切正常"。
        BridgeLog.info("[bridge] TCP 已连接：${ctx.channel().remoteAddress()}")
        super.channelActive(ctx)
    }

    /**
     * WebSocket 握手完成 = **页面真的把协议谈成了**（升级响应已发出并被接受）。
     *
     * 这条与上面的 "TCP 已连接" 成对：只有两条都出现，才能说"前端连上了"。
     * W3 在 WSA 上就因为只看到前者而走错过方向。
     *
     * 同一条方法也承接 `IdleStateEvent`：读空闲说明对端已经不在了，
     * 这里主动关闭 —— 半死连接不该在 `channels` 里留着（它会一直被广播写到）。
     */
    override fun userEventTriggered(
        ctx: ChannelHandlerContext,
        evt: Any,
    ) {
        if (evt is WebSocketServerProtocolHandler.HandshakeComplete) {
            /*
             * v5：握手完成后的**第一条帧必须是 hello**（明文，只承载服务端临时公钥）。
             *
             * 为什么必须由服务端先发：客户端在拿到服务端公钥之前算不出会话密钥，
             * 也就发不出任何密文帧。顺序写在这里（而不是让客户端"先发个空的"）是为了少一个往返。
             */
            val sealed = ctx.channel().attr(SEALED_CHANNEL).get()
            if (sealed != null) {
                ctx.writeAndFlush(BinaryWebSocketFrame(Unpooled.wrappedBuffer(sealed.helloFrame)))
            }

            /*
             * 预认证截止：**从握手完成开始计时**。到期还没交出第一条合法密文帧就关掉 ——
             * 否则"连上就不说话"会一直占着 [PreAuthGate] 的位子。
             *
             * 用 channel 自己的 event loop 调度（不另起线程），到期时再确认一次状态。
             */
            val auth = ctx.channel().attr(AUTH_STATE).get()
            ctx.executor().schedule(
                {
                    if (auth != null && !auth.isAuthenticated && ctx.channel().isActive) {
                        BridgeLog.info(
                            "[bridge] 预认证超时（${preAuthDeadlineMs}ms）没有交出合法密文帧，关闭 ${ctx.channel().remoteAddress()}",
                        )
                        ctx.close()
                    }
                },
                preAuthDeadlineMs,
                TimeUnit.MILLISECONDS,
            )
            // 注意：**认证成功之后才加入广播组**（未认证连接不该被广播写到）
            BridgeLog.info("[bridge] WebSocket 握手完成（待认证）：${evt.requestUri()}")
        }
        if (evt is IdleStateEvent) {
            BridgeLog.info("[bridge] 读空闲超时，关闭半死连接：${ctx.channel().remoteAddress()}")
            channels.remove(ctx.channel())
            ctx.close()
        }
        super.userEventTriggered(ctx, evt)
    }

    override fun channelInactive(ctx: ChannelHandlerContext) {
        channels.remove(ctx.channel())
        // 没认证就断了：把预认证位还回去（否则池会被"连一下就断"的连接耗光）
        val auth = ctx.channel().attr(AUTH_STATE).get()
        if (auth != null && !auth.isAuthenticated) {
            auth.gate.leave()
        }
        reader.reset()
        super.channelInactive(ctx)
    }

    override fun channelRead0(
        ctx: ChannelHandlerContext,
        frame: WebSocketFrame,
    ) {
        when {
            frame is PingWebSocketFrame -> {
                // 协议层不代答入站 ping（只代答出站 ping 的 pong 由对端负责），所以要自己回
                ctx.writeAndFlush(PongWebSocketFrame(frame.content().retain()))
            }

            frame is PongWebSocketFrame -> Unit // 读空闲由 IdleStateHandler 负责，这里无事可做

            frame is CloseWebSocketFrame -> ctx.close()

            frame is TextWebSocketFrame -> {
                // v5 只走二进制帧。收到文本帧说明客户端与壳不是同一版协议 ——
                // 明确回一个码**然后断开**：说清楚比"看起来连上了但什么都不对"好，
                // 而继续留在一条双方理解不一致的连接上没有任何好处。
                sendFrame(ctx, callHandler.wireModeFrame(""))
                ctx.close()
            }

            frame is BinaryWebSocketFrame || frame is ContinuationWebSocketFrame -> {
                val bytes = ByteArray(frame.content().readableBytes())
                frame.content().getBytes(frame.content().readerIndex(), bytes)
                when (val read = reader.accept(bytes, frame.isFinalFragment)) {
                    is WireRead.NeedMore -> Unit

                    is WireRead.Complete -> receiveMessage(ctx, read.message)

                    is WireRead.OverLimit -> {
                        if (!read.needsMore) {
                            sendFrame(
                                ctx,
                                callHandler.errorFrame(
                                    read.id,
                                    BridgeErrorCodes.FRAME_TOO_LARGE,
                                    "bridge.frameTooLarge",
                                ),
                            )
                        }
                        // 超结构上限：对方要么是坏的要么是恶意的，不值得继续读
                        channels.remove(ctx.channel())
                        ctx.close()
                    }
                }
            }

            else -> Unit
        }
    }

    /**
     * 一条完整消息到达（v5：**先解封**再交给共用的处理器）。
     *
     * 三条分支的出路不同，必须分开：
     *  1. **不是密文帧**（ENC=0 又不是 hello）⇒ 两端不是一版 ⇒ 回明文 `BRIDGE_WIRE_MODE` 后关闭。
     *     这里**故意用明文回**：对方的实现连 ENC 位都不认识，回密文它只会看到"连接突然断了"。
     *  2. 解封失败（tag / 序号 / 内外不一致）⇒ 这条连接不可信 ⇒ 断开（回的是**明文**错误帧，
     *     因为此刻我们无法确定对方能解开我们的密文 —— 它连自己那套密钥都不对）。
     *  3. 解封成功 ⇒ 交给 [BridgeCallHandler]（它看到的是**明文**内层帧，与 v4 完全一致）。
     */
    private fun receiveMessage(
        ctx: ChannelHandlerContext,
        message: ByteArray,
    ) {
        val sealed = ctx.channel().attr(SEALED_CHANNEL).get()
        if (sealed == null) {
            sendFrame(ctx, callHandler.wireModeFrame(BridgeWire.headerId(message)))
            ctx.close()
            return
        }
        if (!BridgeWire.isEncrypted(message)) {
            BridgeLog.info("[bridge] 收到未加密的帧（ENC=0），按「两端不是一版协议」处理并断开")
            sendFrame(ctx, callHandler.wireModeFrame(BridgeWire.headerId(message)))
            ctx.close()
            return
        }
        val inner =
            try {
                sealed.open(message)
            } catch (e: BridgeCryptoException) {
                // 只记原因与序号水位，**绝不记密钥/nonce/明文**
                BridgeLog.info(
                    "[bridge] 解封失败（${e.message}）：sent=${sealed.sentSeq()} received=${sealed.receivedSeq()} ⇒ 断开",
                )
                sendFrame(ctx, callHandler.cryptoFailedFrame(BridgeWire.headerId(message)))
                ctx.close()
                return
            }

        // v5：第一条**成功解封**的帧就是认证 —— 还掉预认证位、加入广播组，之后是普通连接
        val auth = ctx.channel().attr(AUTH_STATE).get()
        if (auth != null && auth.markAuthenticated()) {
            auth.gate.leave()
            channels.add(ctx.channel())
            BridgeLog.info("[bridge] 连接已认证：${ctx.channel().remoteAddress()}（预认证池剩 ${auth.gate.pendingCount}）")
        }

        callHandler.handleAsync(inner, rateLimiter, scope) { reply ->
            sendFrame(ctx, reply)
        }
    }

    override fun exceptionCaught(
        ctx: ChannelHandlerContext,
        cause: Throwable,
    ) {
        /*
         * 单个连接出问题不该影响其它连接，也不该把异常打穿到 Netty 默认处理（会刷屏）。
         * 但**必须留下一条**：以前这里是纯 `ctx.close()`，等于把排障线索删掉 ——
         * "连接莫名其妙断了"在现场是没法解释的。
         */
        BridgeLog.info(
            "[bridge] 连接异常关闭 ${ctx.channel().remoteAddress()}：${cause.javaClass.name}: ${cause.message}",
        )
        ctx.close()
    }

    /**
     * 发一帧：**编码、封装、写出只在这里发生**（传输层不自己拼线格式，v3 的漂移就是从这里开始的）。
     *
     * v5：走 [SealedChannel.sealAndSend] —— 取号与写出必须在同一个临界区，
     * 否则并发回复会反过来上线，接收端按"序号回退"把连接丢掉（实测过的现场故障）。
     */
    private fun sendFrame(
        ctx: ChannelHandlerContext,
        frame: BridgeFrame,
    ) {
        if (!ctx.channel().isActive) {
            return
        }
        val sealed = ctx.channel().attr(SEALED_CHANNEL).get()
        if (sealed == null) {
            // 握手没建立（不该发生：没会话的连接不该走到这里）——只留线索，不静默写明文
            BridgeLog.info("[bridge] 连接没有加密封装，丢弃一条出站帧")
            return
        }
        sealed.sealAndSend(frame) { bytes ->
            ctx.writeAndFlush(BinaryWebSocketFrame(Unpooled.wrappedBuffer(bytes)))
        }
    }
}

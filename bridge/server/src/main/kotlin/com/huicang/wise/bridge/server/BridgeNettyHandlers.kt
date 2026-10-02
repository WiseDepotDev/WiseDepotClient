package com.huicang.wise.bridge.server

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
import kotlinx.coroutines.CoroutineScope

/**
 * Netty 侧的握手鉴权：token + Origin。
 *
 * 分工写清楚，避免"以为 Origin 是主防线"：
 * - **token 是主闸**：256-bit、每次启动新生成、校验一次后不再复验；
 * - **Origin 是纵深**：浏览器一定带 Origin，带且不在白名单就拒；不带则放行
 *   （原生客户端与基准脚本不带 Origin，而它们本来就已经持有 token）。
 *
 * **判定本身不在这里**：三项校验走两条传输共用的 [HandshakePolicy] ——
 * 以前是这里与自写传输各写一遍，靠注释与人工对照维持一致；一旦分叉就是安全口径不同。
 */
class BridgeAuthHandler(
    private val token: String,
    private val allowedOrigins: Set<String>,
) : ChannelInboundHandlerAdapter() {
    override fun channelRead(
        ctx: ChannelHandlerContext,
        msg: Any,
    ) {
        if (msg is FullHttpRequest) {
            val factory = msg.decoderResult()
            val uri = QueryStringDecoder(msg.uri())
            val provided = uri.parameters()["token"]?.firstOrNull()
            val origin = msg.headers()[HttpHeaderNames.ORIGIN]

            val decision =
                HandshakePolicy.decide(
                    method = msg.method().name(),
                    path = uri.path(),
                    providedToken = provided,
                    expectedToken = token,
                    origin = origin,
                    allowedOrigins = allowedOrigins,
                )
            val rejection =
                when {
                    !factory.isSuccess -> HttpResponseStatus.BAD_REQUEST
                    decision.reject?.first == 401 -> HttpResponseStatus.UNAUTHORIZED
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

            // 校验通过后把 URI 收敛成裸路径。
            //
            // 为什么必须这么做（W2 实测踩到的坑，代价是一小时的排查）：
            // `WebSocketServerProtocolHandler` 对 websocketPath 做的是 **uri 精确匹配**，
            // 而浏览器的 WebSocket API 无法设置自定义头，token 只能挂在查询串上；
            // 于是 `/bridge?token=…` 匹配不上 `/bridge`，握手处理器**既不响应也不报错**，
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
            channels.add(ctx.channel())
            BridgeLog.info("[bridge] WebSocket 握手完成：${evt.requestUri()}")
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

            frame is TextWebSocketFrame ->
                // v4 只走二进制帧。收到文本帧说明客户端与壳不是同一版协议 ——
                // 明确回一个码，好过"看起来连上了但什么都不对"。
                sendFrame(ctx, callHandler.wireModeFrame(""))

            frame is BinaryWebSocketFrame || frame is ContinuationWebSocketFrame -> {
                val bytes = ByteArray(frame.content().readableBytes())
                frame.content().getBytes(frame.content().readerIndex(), bytes)
                when (val read = reader.accept(bytes, frame.isFinalFragment)) {
                    is WireRead.NeedMore -> Unit

                    is WireRead.Complete ->
                        callHandler.handleAsync(read.message, rateLimiter, scope) { reply ->
                            sendFrame(ctx, reply)
                        }

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

    /** 发一帧：**编码只在这里发生**（传输层不自己拼线格式，v3 的漂移就是从这里开始的）。 */
    private fun sendFrame(
        ctx: ChannelHandlerContext,
        frame: BridgeFrame,
    ) {
        if (!ctx.channel().isActive) {
            return
        }
        ctx.writeAndFlush(BinaryWebSocketFrame(Unpooled.wrappedBuffer(BridgeWire.encode(frame))))
    }
}

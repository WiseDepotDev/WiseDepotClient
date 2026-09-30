package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.protocol.BridgeError
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.ErrFrame
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
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler
import io.netty.util.CharsetUtil
import io.netty.util.ReferenceCountUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Netty 侧的握手鉴权：token + Origin。
 *
 * 分工写清楚，避免"以为 Origin 是主防线"：
 * - **token 是主闸**：256-bit、每次启动新生成、校验一次后不再复验；
 * - **Origin 是纵深**：浏览器一定带 Origin，带且不在白名单就拒；不带则放行
 *   （原生客户端与基准脚本不带 Origin，而它们本来就已经持有 token）。
 *
 * 与纯 socket 传输（[PlainWebSocketServer]）的校验口径**逐条一致** —— 两条传输的行为不能有差异。
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

            val rejection =
                when {
                    !factory.isSuccess -> HttpResponseStatus.BAD_REQUEST
                    uri.path() != BridgeProtocol.HANDSHAKE_PATH -> HttpResponseStatus.NOT_FOUND
                    provided != token -> HttpResponseStatus.UNAUTHORIZED
                    origin != null && origin !in allowedOrigins -> HttpResponseStatus.FORBIDDEN
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
        val body =
            BridgeCodec.encode(
                ErrFrame(id = "", error = BridgeError(code = BridgeErrorCodes.UNAUTHORIZED, messageKey = "bridge.handshakeRejected")),
            )
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
 */
class BridgeFrameHandler(
    private val callHandler: BridgeCallHandler,
    private val rateLimiter: RateLimiter,
    private val channels: ChannelGroup,
) : SimpleChannelInboundHandler<TextWebSocketFrame>() {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun channelActive(ctx: ChannelHandlerContext) {
        channels.add(ctx.channel())
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
     */
    override fun userEventTriggered(
        ctx: ChannelHandlerContext,
        evt: Any,
    ) {
        if (evt is WebSocketServerProtocolHandler.HandshakeComplete) {
            BridgeLog.info("[bridge] WebSocket 握手完成：${evt.requestUri()}")
        }
        super.userEventTriggered(ctx, evt)
    }

    override fun channelInactive(ctx: ChannelHandlerContext) {
        channels.remove(ctx.channel())
        super.channelInactive(ctx)
    }

    override fun channelRead0(
        ctx: ChannelHandlerContext,
        frame: TextWebSocketFrame,
    ) {
        callHandler.handleAsync(frame.text(), rateLimiter, scope) { reply -> sendText(ctx, reply) }
    }

    override fun exceptionCaught(
        ctx: ChannelHandlerContext,
        cause: Throwable,
    ) {
        // 单个连接出问题不该影响其它连接，也不该把异常打穿到 Netty 默认处理（会刷屏）
        ctx.close()
    }

    private fun sendText(
        ctx: ChannelHandlerContext,
        text: String,
    ) {
        if (!ctx.channel().isActive) {
            return
        }
        ctx.writeAndFlush(TextWebSocketFrame(text))
    }
}

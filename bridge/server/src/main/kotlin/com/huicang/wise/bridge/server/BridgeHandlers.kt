package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.protocol.BridgeError
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.ErrFrame
import com.huicang.wise.bridge.protocol.ReqFrame
import com.huicang.wise.bridge.protocol.ResFrame
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
import io.netty.util.CharsetUtil
import io.netty.util.ReferenceCountUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** 从原始报文里抠出 `"id"`，用于"帧太大但还没解析"时也能回一个带 id 的错误。 */
private val RAW_ID = Regex("\"id\"\\s*:\\s*\"([^\"]{1,64})\"")

/** 帧里 `id` 的最大长度（协议未规定，这里给一个防御性上限，防止异常报文撑爆日志）。 */
private const val MAX_ID_LENGTH = 64

/**
 * 握手前的鉴权：token + Origin。
 *
 * 分工写清楚，避免"以为 Origin 是主防线"：
 * - **token 是主闸**：256-bit、每次启动新生成、校验一次后不再复验；
 * - **Origin 是纵深**：浏览器一定带 Origin，带且不在白名单就拒；不带则放行
 *   （原生客户端与基准脚本不带 Origin，而它们本来就已经持有 token）。
 *
 * 为什么不做 401 之外的细粒度拒绝：本地 loopback 上没有可信的"来源"概念，
 * 把复杂度放在 token 上比放在来源判断上更实在。
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
 * 帧处理：解析 → 限流 → 分发 → 回帧。
 *
 * 分发是挂起的（要等后端），因此放在 [scope] 上跑；回写用 `writeAndFlush`，
 * Netty 会把它调度回该 channel 的 event loop，不需要手工切线程。
 */
class BridgeFrameHandler(
    private val dispatcher: BridgeDispatcher,
    private val rateLimiter: RateLimiter,
    private val channels: ChannelGroup,
    private val scope: CoroutineScope,
) : SimpleChannelInboundHandler<TextWebSocketFrame>() {
    override fun channelActive(ctx: ChannelHandlerContext) {
        channels.add(ctx.channel())
        // 连接建立 = "Web 侧真的连上来了"。这条日志是排障链的最后一环：
        // 前面的"宿主已启动 / 引导已供给"都只说明壳和静态资源没问题，
        // 只有它才能区分"页面白屏"与"页面在跑只是没东西显示"。
        BridgeLog.info("[bridge] 前端已连接：${ctx.channel().remoteAddress()}")
        super.channelActive(ctx)
    }

    override fun channelInactive(ctx: ChannelHandlerContext) {
        channels.remove(ctx.channel())
        super.channelInactive(ctx)
    }

    override fun channelRead0(
        ctx: ChannelHandlerContext,
        frame: TextWebSocketFrame,
    ) {
        val text = frame.text()

        if (text.length > BridgeProtocol.MAX_FRAME_BYTES) {
            send(
                ctx,
                ErrFrame(
                    id = RAW_ID.find(text)?.groupValues?.get(1) ?: "",
                    error = BridgeError(BridgeErrorCodes.FRAME_TOO_LARGE, "bridge.frameTooLarge"),
                ),
            )
            return
        }

        val parsed = runCatching { BridgeCodec.decode(text) }.getOrNull()
        if (parsed !is ReqFrame) {
            send(
                ctx,
                ErrFrame(
                    id = RAW_ID.find(text)?.groupValues?.get(1) ?: "",
                    error = BridgeError(BridgeErrorCodes.PARAMS_INVALID, "bridge.notARequestFrame"),
                ),
            )
            return
        }

        if (!rateLimiter.tryAcquire()) {
            send(ctx, ErrFrame(id = parsed.id, error = BridgeError(BridgeErrorCodes.RATE_LIMITED, "bridge.rateLimited")))
            return
        }

        // requestId 优先用调用方给的（UI 的埋点链路），没有就用帧 id —— 保证每帧都有链路标识
        val requestId = parsed.meta?.requestId?.takeIf { it.isNotBlank() } ?: parsed.id
        val id = parsed.id

        scope.launch {
            val outcome =
                try {
                    dispatcher.dispatch(parsed.method, parsed.params, requestId)
                } catch (e: Throwable) {
                    BackendResult.Failed(BridgeErrorCodes.INTERNAL, "bridge.internal", retryable = true)
                }
            when (outcome) {
                is BackendResult.Ok ->
                    send(ctx, ResFrame(id = id, data = outcome.data ?: JsonNull))

                is BackendResult.Failed ->
                    send(
                        ctx,
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
        }
    }

    override fun exceptionCaught(
        ctx: ChannelHandlerContext,
        cause: Throwable,
    ) {
        // 单个连接出问题不该影响其它连接，也不该把异常打穿到 Netty 默认处理（会刷屏）
        ctx.close()
    }

    private fun send(
        ctx: ChannelHandlerContext,
        frame: com.huicang.wise.bridge.protocol.BridgeFrame,
    ) {
        if (!ctx.channel().isActive) {
            return
        }
        ctx.writeAndFlush(TextWebSocketFrame(BridgeCodec.encode(frame)))
    }
}

package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendPort
import com.huicang.wise.bridge.backend.TokenStore
import com.huicang.wise.bridge.capability.LocalMethodPort
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.EvtFrame
import io.netty.bootstrap.ServerBootstrap
import io.netty.channel.Channel
import io.netty.channel.ChannelInitializer
import io.netty.channel.ChannelOption
import io.netty.channel.EventLoopGroup
import io.netty.channel.group.ChannelGroup
import io.netty.channel.group.DefaultChannelGroup
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.HttpObjectAggregator
import io.netty.handler.codec.http.HttpServerCodec
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame
import io.netty.util.concurrent.GlobalEventExecutor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonElement
import java.net.InetAddress
import java.net.InetSocketAddress

/** 允许的 Origin。桌面用自定义协议 `app://wise`，手机用 WebViewAssetLoader 的域。 */
val DEFAULT_ALLOWED_ORIGINS: Set<String> = setOf("app://wise", "https://appassets.androidplatform.net")

data class BridgeServerConfig(
    /** 0 = 由系统分配临时端口（生产口径）。 */
    val port: Int = 0,
    /** 一次性握手 token：**每次启动新生成**，不要复用、不要落盘。 */
    val token: String,
    val backend: BackendPort,
    val platform: PlatformPort,
    val local: LocalMethodPort? = null,
    /** 令牌存储：桥进程内唯一持有令牌的地方（桌面 DPAPI/KeyStore、手机 EncryptedPrefs 落在这后面）。 */
    val tokens: TokenStore,
    val allowedOrigins: Set<String> = DEFAULT_ALLOWED_ORIGINS,
    val maxPerSecond: Int = 50,
    val burst: Int = 100,
    /** 单次 HTTP 帧上限（WebSocket 升级握手是普通 HTTP，也走这个聚合器）。 */
    val maxHttpContentLength: Int = 64 * 1024,
)

/**
 * 桥的**唯一服务端实现**：桌面以独立 JVM 进程跑它，手机在应用进程内跑它。
 *
 * 线程与内存（`docs/architecture.md` §4）：boss 与 worker **复用同一个** `NioEventLoopGroup(1)`——
 * loopback 上只有一个客户端，多开线程纯属浪费，这也是移动端内存门禁（≤8MB）能过的前提之一。
 */
class BridgeServer(
    private val config: BridgeServerConfig,
) {
    private val session = SessionManager(config.tokens, config.backend, config.platform.version)

    private val dispatcher =
        BridgeDispatcher(
            backend = config.backend,
            platform = config.platform,
            local = config.local,
            session = session,
        )

    private val channels: ChannelGroup = DefaultChannelGroup("wise-bridge", GlobalEventExecutor.INSTANCE)
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var group: EventLoopGroup? = null
    private var serverChannel: Channel? = null
    private var actualPort: Int = -1

    /** 实际绑定端口（[BridgeServerConfig.port] 为 0 时由系统分配）。 */
    val port: Int get() = actualPort

    /** 当前连接数（健康检查与测试用）。 */
    val connectionCount: Int get() = channels.size

    /** 同步启动并返回绑定端口；失败抛异常（启动失败必须响亮地失败）。 */
    fun start(): Int {
        val eventLoop = NioEventLoopGroup(1)
        group = eventLoop
        val bootstrap =
            ServerBootstrap()
                .group(eventLoop)
                .channel(NioServerSocketChannel::class.java)
                .option(ChannelOption.SO_REUSEADDR, true)
                .childHandler(
                    object : ChannelInitializer<SocketChannel>() {
                        override fun initChannel(ch: SocketChannel) {
                            ch.pipeline()
                                .addLast(HttpServerCodec())
                                .addLast(HttpObjectAggregator(config.maxHttpContentLength))
                                .addLast(BridgeAuthHandler(config.token, config.allowedOrigins))
                                .addLast(
                                    WebSocketServerProtocolHandler(
                                        BridgeProtocol.HANDSHAKE_PATH,
                                        null,
                                        true,
                                    ),
                                )
                                .addLast(
                                    BridgeFrameHandler(
                                        dispatcher = dispatcher,
                                        rateLimiter = RateLimiter(config.maxPerSecond, config.burst),
                                        channels = channels,
                                        scope = scope,
                                    ),
                                )
                        }
                    },
                )

        // 只绑 loopback：这条线是防"把桥暴露到局域网"的第一道，也是最有效的一道。
        // 地址用显式 IPv4 字面量而不是 getLoopbackAddress()：后者可能给 ::1，
        // 与引导文件里的 127.0.0.1 不一致，表现为"绑上了但客户端连不上"。
        val channel =
            bootstrap
                .bind(InetSocketAddress(InetAddress.getByName(BridgeProtocol.LOOPBACK_HOST), config.port))
                .sync()
                .channel()
        serverChannel = channel
        actualPort = (channel.localAddress() as InetSocketAddress).port
        return actualPort
    }

    /** 向所有连接广播事件（扫码、离线队列变化、上传进度……）。 */
    fun emit(
        topic: String,
        data: JsonElement? = null,
    ) {
        if (channels.isEmpty) {
            return
        }
        channels.writeAndFlush(TextWebSocketFrame(BridgeCodec.encode(EvtFrame(topic = topic, data = data))))
    }

    /** 关停：先关连接，再关 event loop。可重复调用。 */
    fun stop() {
        runCatching { serverChannel?.close()?.sync() }
        runCatching { channels.close()?.await() }
        runCatching { group?.shutdownGracefully() }
        runCatching { scope.cancel() }
        serverChannel = null
        group = null
        actualPort = -1
    }
}

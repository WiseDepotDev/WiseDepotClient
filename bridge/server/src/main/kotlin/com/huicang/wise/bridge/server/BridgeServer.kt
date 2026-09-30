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

/**
 * 允许的 Origin。
 *
 * 桌面是自定义协议 `app://wise`；手机是 `appassets.androidplatform.net` ——
 * **http 与 https 两个都留着**：页面走哪个取决于宿主，而 Origin 校验不该逼着宿主选 https
 * （手机壳用 http，见 MainActivity 里关于混合内容的说明）。
 */
val DEFAULT_ALLOWED_ORIGINS: Set<String> =
    setOf(
        "app://wise",
        "https://appassets.androidplatform.net",
        "http://appassets.androidplatform.net",
    )

/**
 * 传输实现的选择。
 *
 * 两者**语义完全一致**（同一份 [BridgeCallHandler] 做解析/限流/分发/编码），
 * 差别只在"用什么把字节搬出去"。因此换传输不动协议、不动 backend、不动宿主逻辑。
 */
enum class BridgeTransportKind {
    /** Netty：桌面使用（已验证：往返 p50 0.27ms）。 */
    NETTY,

    /**
     * 自写 RFC6455 over `ServerSocket`：**手机使用**。
     *
     * 起因：Netty 在 Android（WSA）上 `bind().sync()` 成功、端口也拿到了，
     * 但随后监听消失（从容器 shell 直连被拒），进程却存活无崩溃。
     * 既然"真机可连"这一项不达标，就按 `docs/architecture.md` §4 的预案换实现。
     */
    PLAIN_SOCKET,
}

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
    /**
     * 绑定地址。**由宿主用 [BridgeHostResolver] 决定**，不要硬编码 127.0.0.1 ——
     * WSA 会把发往 127.0.0.1 的包从点对点链路（`loopback0`）送出去，
     * 导致 VM 内部连不上自己监听的端口（见 [BridgeHostResolver] 的注释）。
     */
    val host: String = "127.0.0.1",
    /** 传输实现；桌面用 NETTY，手机用 PLAIN_SOCKET。 */
    val transport: BridgeTransportKind = BridgeTransportKind.NETTY,
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

    /** 两种传输共用的"一帧怎么处理"（解析/限流/分发/编码）。 */
    private val callHandler = BridgeCallHandler(dispatcher)

    /** 纯 socket 传输（手机）；为 null 表示走 Netty。 */
    private var plain: PlainWebSocketServer? = null

    private var group: EventLoopGroup? = null
    private var serverChannel: Channel? = null
    private var actualPort: Int = -1

    /** 实际绑定端口（[BridgeServerConfig.port] 为 0 时由系统分配）。 */
    val port: Int get() = actualPort

    /** 当前连接数（健康检查与测试用）。 */
    val connectionCount: Int get() = plain?.connectionCount ?: channels.size

    /** 同步启动并返回绑定端口；失败抛异常（启动失败必须响亮地失败）。 */
    fun start(): Int {
        if (config.transport == BridgeTransportKind.PLAIN_SOCKET) {
            val server =
                PlainWebSocketServer(
                    port0 = config.port,
                    host = config.host,
                    token = config.token,
                    allowedOrigins = config.allowedOrigins,
                    maxPerSecond = config.maxPerSecond,
                    burst = config.burst,
                    callHandler = callHandler,
                )
            plain = server
            actualPort = server.start()
            return actualPort
        }
        return startNetty()
    }

    private fun startNetty(): Int {
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
                                        callHandler = callHandler,
                                        rateLimiter = RateLimiter(config.maxPerSecond, config.burst),
                                        channels = channels,
                                    ),
                                )
                        }
                    },
                )

        // 只绑指定地址（桌面/真机是 127.0.0.1，WSA 是 loopback0 的点对点地址）：
        // 这是防"把桥暴露到局域网"的第一道，也是最有效的一道。
        val channel =
            bootstrap
                .bind(InetSocketAddress(InetAddress.getByName(config.host), config.port))
                .sync()
                .channel()
        serverChannel = channel
        actualPort = (channel.localAddress() as InetSocketAddress).port
        // 与纯 socket 传输同一条自检：让"端口到底有没有在监听"这件事**与传输实现无关**。
        BridgeLog.info("[bridge] 绑定 ${config.host}:$actualPort，自检：本进程回连 -> ${LoopbackSelfTest.run(actualPort, config.host)}")
        return actualPort
    }

    /** 向所有连接广播事件（扫码、离线队列变化、上传进度……）。 */
    fun emit(
        topic: String,
        data: JsonElement? = null,
    ) {
        val frame = EvtFrame(topic = topic, data = data)
        plain?.let {
            it.broadcast(frame)
            return
        }
        if (channels.isEmpty) {
            return
        }
        channels.writeAndFlush(TextWebSocketFrame(BridgeCodec.encode(frame)))
    }

    /** 关停：先关连接，再关 event loop。可重复调用。 */
    fun stop() {
        plain?.stop()
        plain = null
        runCatching { serverChannel?.close()?.sync() }
        runCatching { channels.close()?.await() }
        runCatching { group?.shutdownGracefully() }
        runCatching { scope.cancel() }
        serverChannel = null
        group = null
        actualPort = -1
    }
}

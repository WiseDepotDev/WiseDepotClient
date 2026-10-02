package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendPort
import com.huicang.wise.bridge.backend.TokenStore
import com.huicang.wise.bridge.capability.LocalMethodPort
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.BridgeWire
import com.huicang.wise.bridge.protocol.EvtFrame
import io.netty.bootstrap.ServerBootstrap
import io.netty.buffer.Unpooled
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
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler
import io.netty.handler.timeout.IdleStateHandler
import io.netty.util.concurrent.GlobalEventExecutor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonElement
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

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
    /**
     * 同时在跑的分发上限（**有界线程池**）。
     *
     * 为什么要有界：以前每连接的每个帧都 `launch` 到 `Dispatchers.IO`，那个池会为阻塞任务
     * 扩到 64 个线程 —— 桥的核心工作只是"转发一次 HTTP"，用不着，也不该让一个失控页面
     * 把线程吃满。8 个足够（UI 侧真正并发的取数不会有这么多）。
     */
    val maxConcurrentDispatches: Int = 8,
    /**
     * 读空闲多久算"对端不在了"（毫秒）。
     *
     * 正常流量是每 5~10 秒一次调用，60 秒已经非常宽松；它的作用是**把半死连接清掉**：
     * 对端进程被杀（不发 FIN）时，TCP 连接会一直"看起来还在"，
     * 桥如果不清，广播与诊断都会指向一个已经不存在的客户端。
     */
    val readerIdleMs: Long = 60_000,
    /**
     * 自写传输（手机）的服务端 ping 间隔（毫秒）。
     *
     * 必须**小于** [readerIdleMs]，否则永远等不到回音：pong 是刷新"对方还活着"的唯一信号
     * （浏览器 WebSocket API 不能主动发 ping，只能被动回）。
     */
    val plainPingIntervalMs: Long = 20_000,
)

/**
 * 桥的**唯一服务端实现**：桌面以独立 JVM 进程跑它，手机在应用进程内跑它。
 *
 * 线程与内存（`docs/architecture.md` §4）：boss 与 worker **复用同一个** `NioEventLoopGroup(1)`——
 * loopback 上只有一个客户端，多开线程纯属浪费，这也是移动端内存门禁（≤8MB）能过的前提之一。
 *
 * 另一处共享的是**分发用的协程作用域**：它由本类持有、`stop()` 时统一取消。
 * 以前是"每个连接一个 scope 且从不取消"，每次重连都会多留一份 ——
 * 而"切后台再回来"恰恰会不停重连。
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
            // 会话失效 → 广播。界面据此回到登录屏，而不是停在一个"看起来已登录、
            // 点什么都被后端以误导性理由拒绝"的画面上。
            // 用 lambda 捕获 this：emit() 读的是后面才初始化的 plain/channels，
            // 但它在运行时才被调用，那时字段已经就位。
            onSessionExpired = { emit(SessionManager.EVENT_SESSION_EXPIRED) },
        )

    private val channels: ChannelGroup = DefaultChannelGroup("wise-bridge", GlobalEventExecutor.INSTANCE)
    /** 两种传输共用的"一帧怎么处理"（解析/限流/分发/编码）。 */
    private val callHandler = BridgeCallHandler(dispatcher)

    /**
     * 分发用的有界线程池 + 协程作用域。
     *
     * 用固定线程池而不是 `Dispatchers.IO`：桥的每个任务都是一次阻塞 HTTP 调用，
     * 固定 8 个线程足够、也把"一个失控页面的并发"钉死在可解释的上限里。
     */
    private val dispatchExecutor = Executors.newFixedThreadPool(config.maxConcurrentDispatches) { runnable ->
        Thread(runnable, "bridge-dispatch").apply { isDaemon = true }
    }
    private val scope = CoroutineScope(SupervisorJob() + dispatchExecutor.asCoroutineDispatcher())

    /** 纯 socket 传输（手机）；为 null 表示走 Netty。 */
    private var plain: PlainWebSocketServer? = null

    private var group: EventLoopGroup? = null
    private var serverChannel: Channel? = null
    private var actualPort: Int = -1

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
                    idleTimeoutMs = config.readerIdleMs.toInt(),
                    pingIntervalMs = config.plainPingIntervalMs,
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
                                    /*
                                     * 第四个参数是**解码器**的单帧上限。
                                     *
                                     * v4：给到"最大合法帧"（8MiB 数据面正文 + 帧头 + 最大 id），
                                     * 而不是**消息**上限 —— 消息层的结构上限（控制面 1MiB / 数据面 8MiB）
                                     * 由共用的 WireReader 按 kind 判，超了回一条带 id 的
                                     * `BRIDGE_FRAME_TOO_LARGE`；交给解码器拒的话，客户端只会看到
                                     * "连接突然断了"（1009），与自写传输的行为也不一致。
                                     */
                                    WebSocketServerProtocolHandler(
                                        BridgeProtocol.HANDSHAKE_PATH,
                                        null,
                                        true,
                                        FrameBudget.MAX_FRAME_ON_WIRE,
                                    ),
                                )
                                // 读空闲：对端进程被杀（不发 FIN）时 TCP 会一直"看起来还在"，
                                // 连接不清掉就会被一直广播写到，而且诊断也指向不存在的客户端。
                                .addLast(IdleStateHandler(config.readerIdleMs, 0, 0, TimeUnit.MILLISECONDS))
                                .addLast(
                                    BridgeFrameHandler(
                                        callHandler = callHandler,
                                        rateLimiter = RateLimiter(config.maxPerSecond, config.burst),
                                        channels = channels,
                                        scope = scope,
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
        if (channels.isEmpty()) {
            return
        }
        // 同一个 BinaryWebSocketFrame 写给多个 channel 是安全的：
        // DefaultChannelGroup 内部会对引用计数消息做 retainedDuplicate/retain（netty-transport 4.1.115 实测确认）。
        channels.writeAndFlush(BinaryWebSocketFrame(Unpooled.wrappedBuffer(BridgeWire.encode(frame))))
    }

    /**
     * 关停：先关连接，再关 event loop 与分发线程池。可重复调用。
     *
     * `shutdownGracefully(0, 500ms)` 是刻意的：默认的 2 秒静默期会让宿主退出时白等，
     * 而桥的场景是"父进程要马上退出"，不需要优雅到那个程度。
     */
    fun stop() {
        runCatching { plain?.stop() }
        plain = null
        runCatching { serverChannel?.close()?.sync() }
        runCatching { channels.close()?.await() }
        runCatching { group?.shutdownGracefully(0, 500, TimeUnit.MILLISECONDS) }
        runCatching { scope.cancel() }
        runCatching { dispatchExecutor.shutdownNow() }
        serverChannel = null
        group = null
        actualPort = -1
    }
}

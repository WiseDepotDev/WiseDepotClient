package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeCrypto
import com.huicang.wise.bridge.protocol.BridgeCryptoException
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeFrame
import com.huicang.wise.bridge.protocol.BridgeProtocol
import com.huicang.wise.bridge.protocol.BridgeWire
import com.huicang.wise.bridge.protocol.WireKind
import com.huicang.wise.bridge.protocol.WireRead
import com.huicang.wise.bridge.protocol.WireReader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.Collections
import kotlin.concurrent.thread

/**
 * **纯 socket 的 WebSocket 服务端**（自写 RFC6455）——手机端使用。
 *
 * ## 为什么需要它
 *
 * Netty 在 Android 上是"非官方支持"（`docs/architecture.md` §4 预先写下的风险）。
 * W2 的门禁里 dex 与体积都过了，但**真机可连**没过：实测 Netty 在 WSA 上
 * `bind().sync()` 成功、端口也拿到了，**随后监听消失**（从容器 shell 直连被拒），
 * 应用进程却存活、无崩溃。既然功能性那一项不达标，就按预案换实现。
 *
 * 这**不是**"改架构"：不变式 3 早就把传输放在了端口后面，因此本文件是新增，
 * 协议层 / backend / 桌面宿主 / Web 一行都不动。
 *
 * ## 为什么自写而不是引 Ktor
 *
 * - 只要 RFC6455 的一个子集：HTTP 升级 + 文本帧 + ping/pong + close；
 * - 零新依赖（Ktor 会带进一个完整的 HTTP 栈），与仓库"不轻易加依赖"的惯例一致；
 * - 只用 `java.net.*` / `MessageDigest` —— 三者在 Android API 1 就有，
 *   不像 Netty 那样依赖 `sun.misc.Unsafe`、`java.lang.management` 与反射。
 *
 * ## 线程模型（**这里是被返工最多的地方，改动前先读完**）
 *
 * 一个 accept 线程 + **每连接一个读线程** + 一个全局保活线程：
 *
 *  - 读线程阻塞在 `read()` 上，因此必须有 `soTimeout`（[idleTimeoutMs]）：
 *    没有它，WebView 被系统杀掉（不发 FIN）时这个线程会**永久挂住**，
 *    连接还留在 [clients] 里继续被 `broadcast` 写 —— 线程与连接一起泄漏。
 *  - **浏览器不能主动发 ping**（WebSocket API 没有这个能力），所以保活只能由服务端做：
 *    [pingIntervalMs] 发一次 ping，而浏览器的实现会**自动回 pong**（RFC6455 §5.5.2）。
 *    收到任何帧都会刷新 `lastInboundAt`，于是"对端还活着"这件事每 [pingIntervalMs] 被证实一次。
 *  - 保活线程是**一个**（不是每连接一个）：loopback 上客户端只有 WebView 一个或几个，
 *    一个线程轮流 ping 足够，也避免"连接数 × 线程数"的膨胀。
 *  - 连接数有上限（[maxConnections]）：否则"连上就不说话"的进程能一直占线程与 socket。
 */
class PlainWebSocketServer(
    private val port0: Int,
    /** 绑定地址，由宿主用 [BridgeHostResolver] 决定（不要硬编码 127.0.0.1）。 */
    private val host: String,
    /** 预共享密钥（v5；v4 里叫 token）：参与 KDF，**永不上线**。 */
    private val psk: String,
    private val allowedOrigins: Set<String>,
    private val maxPerSecond: Int,
    private val burst: Int,
    private val callHandler: BridgeCallHandler,
    /**
     * 读空闲上限（毫秒）：这么久没有收到任何帧就认为对端死了。
     *
     * 30 秒的依据：正常使用时客户端每 5~10 秒就有一次调用（自动刷新 + 健康探测），
     * 加上服务端 [pingIntervalMs] 的 ping 换 pong，30 秒已经非常宽松。
     */
    private val idleTimeoutMs: Int = 30_000,
    /** 服务端主动 ping 的间隔（毫秒）。必须小于 [idleTimeoutMs]，否则永远等不到回音。 */
    private val pingIntervalMs: Long = 20_000,
    /** 允许同时存在的连接数上限（超出直接关掉新来的，并留一条日志）。 */
    private val maxConnections: Int = 8,
    /** 预认证池（v5）：**与 Netty 侧共用同一个实例**，由 [BridgeServer] 注入。 */
    private val gate: PreAuthGate,
    /**
     * 预认证截止时间（毫秒，v5）：从升级成功起算，这么久还没交出合法密文帧就关掉。
     *
     * 自写传输没有调度器，所以这条**直接用 socket 读超时**实现：认证前 `soTimeout` 就是它，
     * 认证后换回 [idleTimeoutMs]（两行代码，不引入线程/定时器）。
     */
    private val preAuthDeadlineMs: Int = 1_500,
    /**
     * 单个 WebSocket 帧的字节上限（超过就直接断开，连错误帧都不写）。
     *
     * 取"最大合法消息 + 封装开销"：**消息**的结构上限由共用的
     * [com.huicang.wise.bridge.protocol.WireReader] 按 kind 判（v5 起是外层上限 = 内层 + 295），
     * 这里只管"别为一个声称 8MiB、实际 2GB 的帧先分配内存"。
     */
    private val hardLimitBytes: Int = BridgeWire.sealedHardLimitFor(WireKind.BIN),
) {
    private val clients: MutableSet<PlainConnection> = Collections.synchronizedSet(mutableSetOf())
    private val scope = CoroutineScope(SupervisorJob())

    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private var pingThread: Thread? = null

    @Volatile private var boundPort: Int = -1

    /** 建立连接的功能开关：`stop()` 之后 accept 循环与保活循环都靠它退出。 */
    @Volatile private var running = false

    fun start(): Int {
        val socket = ServerSocket()
        socket.reuseAddress = true
        // 显式 IPv4 字面量而不是 getLoopbackAddress()：后者在双栈机器上可能给 ::1，
        // 与引导文件里下发的地址不一致，表现为"绑上了却连不上"（W2 踩过）。
        socket.bind(InetSocketAddress(InetAddress.getByName(host), port0))
        serverSocket = socket
        boundPort = socket.localPort
        running = true

        // 启动自检：绑完立刻从**本进程**回连自己。
        // 这一条把两种完全不同的故障分开：
        //   · 自检失败 → bind 根本没在监听（环境/权限/地址问题，与传输实现无关）；
        //   · 自检成功但外部连不上 → 跨进程可见性问题（网络命名空间/防火墙）。
        // 没有它，"端口连不上"会被一路误判成"传输实现有问题"——
        // W3 在 WSA 上先后怀疑过混合内容、CSP、Netty，最后是这条自检把方向纠正过来的。
        BridgeLog.info("[bridge] 绑定 $host:$boundPort，自检：本进程回连 -> ${LoopbackSelfTest.run(boundPort, host)}")

        acceptThread =
            thread(isDaemon = true, name = "bridge-accept") {
                while (running && !socket.isClosed) {
                    val client =
                        try {
                            socket.accept()
                        } catch (e: IOException) {
                            break
                        }
                    if (clients.size >= maxConnections) {
                        // 不静默：连接数打满是"谁在连"的线索，也解释了客户端为什么握手失败
                        BridgeLog.info("[bridge] 连接数已达上限（$maxConnections），拒绝 ${client.remoteSocketAddress}")
                        runCatching { client.close() }
                        continue
                    }
                    val connection = PlainConnection(client)
                    thread(isDaemon = true, name = "bridge-conn") { connection.run() }
                }
            }

        pingThread =
            thread(isDaemon = true, name = "bridge-ping") {
                while (running) {
                    try {
                        Thread.sleep(pingIntervalMs)
                    } catch (e: InterruptedException) {
                        break
                    }
                    val now = System.currentTimeMillis()
                    // 快照之后再遍历：保活不该持有 clients 锁去做 IO（见 broadcast 的同类说明）
                    for (connection in snapshotClients()) {
                        if (now - connection.lastInboundAt > idleTimeoutMs) {
                            BridgeLog.info("[bridge] 连接空闲超时（${idleTimeoutMs}ms），主动关闭 ${connection.peer}")
                            connection.close()
                        } else {
                            connection.sendPing()
                        }
                    }
                }
            }
        return boundPort
    }

    fun broadcast(frame: BridgeFrame) {
        if (clients.isEmpty()) {
            return
        }
        /*
         * v5：**每条连接各自封装**（加密后各连接的密钥不同，字节必然不同）。
         *
         * 仍然保留"先快照、再出锁写"这条纪律（见下面的历史注释）：一个不读数据的客户端
         * 不能把广播乃至 stop() 拖住。加密只是把"编码一次"变成"逐连接封装一次"。
         */
        for (connection in snapshotClients()) {
            connection.sendFrame(frame)
        }
    }

    fun stop() {
        running = false
        runCatching { serverSocket?.close() }
        for (connection in snapshotClients()) {
            connection.close()
        }
        clients.clear()
        scope.cancel()
        pingThread?.interrupt()
        pingThread = null
        acceptThread = null
        boundPort = -1
    }

    /** 取一份连接快照（锁内只做复制）。 */
    private fun snapshotClients(): List<PlainConnection> = synchronized(clients) { clients.toList() }

    /**
     * 一个客户端连接：先做 HTTP 升级，然后进入帧循环。
     *
     * `lastInboundAt` 由读循环与保活线程共享，用 `@Volatile`（单写多读、允许极短滞后）：
     * 它不是业务状态，只是"多久没听见对方"的近似值。
     */
    private inner class PlainConnection(private val socket: Socket) {
        private val limiter = RateLimiter(maxPerSecond, burst)
        private val writeLock = Any()
        private var out: OutputStream? = null

        /** v5：本连接的加密封装（握手时建立，之后所有帧都从它过）。 */
        private var sealed: SealedChannel? = null

        /** v5：是否已经通过加密认证（第一条成功解封的帧到达时置位）。 */
        @Volatile private var authenticated = false

        /** v5：是否占着预认证位（认证成功或连接关闭时还回去，且只还一次）。 */
        @Volatile private var pendingAuthSlot = false

        @Volatile private var closed = false

        @Volatile var lastInboundAt: Long = System.currentTimeMillis()
            private set

        val peer: String get() = socket.remoteSocketAddress?.toString() ?: "?"

        fun run() {
            try {
                socket.tcpNoDelay = true
                /*
                 * 读超时是这一整段的前提：没有它，对端不发 FIN 时这个线程会永久阻塞。
                 *
                 * v5：**认证前先用预认证截止时间**（1.5s），交出第一条合法密文帧之后再换成
                 * 正常的读空闲上限 —— 于是"连上就不说话"最多占 1.5 秒（见 [PreAuthGate]）。
                 */
                socket.soTimeout = preAuthDeadlineMs
                val input = socket.getInputStream().buffered()
                val output = BufferedOutputStream(socket.getOutputStream())
                out = output

                if (!handshake(input, output)) {
                    close()
                    return
                }

                // v4：分片装配只有一份实现（BridgeWire 的 WireReader），两条传输共用它
                val reader = WireReader()
                while (!closed) {
                    val frame =
                        try {
                            readFrame(input)
                        } catch (e: SocketTimeoutException) {
                            // 认证前超时 = 预认证截止；认证后超时 = 读空闲。两者都判死（双保险）
                            BridgeLog.info(
                                "[bridge] " +
                                    (if (authenticated) "读超时（${idleTimeoutMs}ms）" else "预认证超时（${preAuthDeadlineMs}ms）") +
                                    "，关闭 $peer",
                            )
                            break
                        }
                    if (frame == null) {
                        break
                    }
                    lastInboundAt = System.currentTimeMillis()
                    dispatch(frame, reader)
                }
            } catch (e: IOException) {
                // 客户端断开是常态，不刷屏；但**不是**什么都不记 —— 其它 IOException 仍然要给线索
                if (e !is java.net.SocketException) {
                    BridgeLog.info("[bridge] 连接异常（$peer）：${e.javaClass.simpleName}: ${e.message}")
                }
            } catch (t: Throwable) {
                // 以前这里只 catch IOException：`NegativeArraySizeException` 之类的会直接杀掉读线程，
                // 现场只看到"连接还在、就是不响应"。兜住并说到底发生了什么。
                BridgeLog.info("[bridge] 读循环异常（$peer）：${t.javaClass.name}: ${t.message}")
            } finally {
                clients.remove(this)
                close()
            }
        }

        /**
         * 处理一帧（可能来自分片聚合）。
         *
         * 三条语义与 Netty 侧**逐条一致**（两条传输不能有行为差异）：
         *  - 文本帧 → 交给共用的 [BridgeCallHandler]；
         *  - ping → 回 pong（把 ping 的 payload 原样带回，RFC6455 §5.5.3）；
         *  - close → 结束。
         */
        private fun dispatch(
            frame: WsFrame,
            reader: WireReader,
        ) {
            when (frame.opcode) {
                OPCODE_BINARY, OPCODE_CONTINUATION -> {
                    when (val read = reader.accept(frame.payload, frame.fin)) {
                        is WireRead.NeedMore -> Unit

                        is WireRead.Complete -> receiveMessage(read.message)

                        is WireRead.OverLimit -> {
                            if (!read.needsMore) {
                                sendFrame(
                                    callHandler.errorFrame(
                                        read.id,
                                        BridgeErrorCodes.FRAME_TOO_LARGE,
                                        "bridge.frameTooLarge",
                                    ),
                                )
                            }
                            // 超结构上限：对方要么是坏的要么是恶意的，不再为它读下去
                            close()
                        }
                    }
                }

                OPCODE_TEXT -> {
                    // v5 只走二进制帧。收到文本帧说明客户端与壳不是同一版协议 ——
                    // 明确回一个码**然后断开**（与 Netty 侧逐条一致）。
                    sendFrame(callHandler.wireModeFrame(""))
                    close()
                }

                OPCODE_PING -> sendRawFrame(OPCODE_PONG, frame.payload)
                OPCODE_PONG -> Unit // 保活线程只关心 lastInboundAt，在读到帧时已经刷新
                OPCODE_CLOSE -> close()
                else -> Unit
            }
        }

        /**
         * 一条完整消息到达（v5：**先解封**再交给共用的处理器）。
         *
         * 三条分支与 Netty 侧**逐条一致**（两条传输不能有行为差异，见 [SealedChannel] 的说明）：
         * 非密文帧 ⇒ 明文 `BRIDGE_WIRE_MODE` + 断开；解封失败 ⇒ 明文 `BRIDGE_CRYPTO_FAILED` + 断开；
         * 解封成功 ⇒ 交给 [BridgeCallHandler]（它看到的仍是明文内层帧，与 v4 完全一致）。
         */
        private fun receiveMessage(message: ByteArray) {
            val channel = sealed
            if (channel == null) {
                sendFrame(callHandler.wireModeFrame(BridgeWire.headerId(message)))
                close()
                return
            }
            if (!BridgeWire.isEncrypted(message)) {
                BridgeLog.info("[bridge] 收到未加密的帧（ENC=0），按「两端不是一版协议」处理并断开")
                sendFrame(callHandler.wireModeFrame(BridgeWire.headerId(message)))
                close()
                return
            }
            val inner =
                try {
                    channel.open(message)
                } catch (e: BridgeCryptoException) {
                    // 只记原因与序号水位，**绝不记密钥/nonce/明文**
                    BridgeLog.info(
                        "[bridge] 解封失败（${e.message}）：sent=${channel.sentSeq()} received=${channel.receivedSeq()} ⇒ 断开",
                    )
                    sendFrame(callHandler.cryptoFailedFrame(BridgeWire.headerId(message)))
                    close()
                    return
                }
            callHandler.handleAsync(inner, limiter, scope) { reply ->
                sendFrame(reply)
            }

            /*
             * v5：第一条**成功解封**的帧就是认证。
             *
             * 三件事一起做，顺序不能换：还预认证位 → 读超时换回正常的空闲上限 → 加入广播组。
             * 第三件尤其重要：未认证连接**不该**被广播写到（它可能只是个占位的陌生连接）。
             */
            if (!authenticated) {
                authenticated = true
                if (pendingAuthSlot) {
                    pendingAuthSlot = false
                    gate.leave()
                }
                socket.soTimeout = idleTimeoutMs
                clients.add(this)
                BridgeLog.info("[bridge] 连接已认证：$peer（预认证池剩 ${gate.pendingCount}）")
            }
        }

        /**
         * HTTP 升级握手。
         *
         * 三项校验（方法/路径、Origin、Sec-WebSocket-Key）走**两条传输共用的** [HandshakePolicy]，
         * 因此这里不再自己写一遍判定 —— "两条传输口径一致"从人工对照变成结构保证。
         *
         * v5：升级成功**不等于连上** —— 身份由"第一条合法密文帧"证明，见 [PreAuthGate]。
         */
        private fun handshake(
            input: InputStream,
            output: OutputStream,
        ): Boolean {
            val requestLine = readLine(input) ?: return false
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readLine(input) ?: return false
                if (line.isEmpty()) {
                    break
                }
                val idx = line.indexOf(':')
                if (idx > 0) {
                    headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
                }
            }

            val parts = requestLine.split(' ')
            val target = parts.getOrNull(1) ?: ""
            val query = target.substringAfter('?', "")
            val decision =
                HandshakePolicy.decide(
                    method = parts.getOrNull(0) ?: "",
                    path = target.substringBefore('?'),
                    origin = headers["origin"],
                    allowedOrigins = allowedOrigins,
                    hasWebSocketKey = headers["sec-websocket-key"] != null,
                )
            if (!decision.allowed) {
                val (code, reason) = decision.reject!!
                BridgeLog.info("[bridge] 握手被拒 $code：path=${target.substringBefore('?')} origin=${headers["origin"] ?: "(无)"}")
                // 用枚举里的已知取值（未知码一律 400），杜绝把外部输入拼进响应行
                val status =
                    when (code) {
                        403 -> "Forbidden"
                        404 -> "Not Found"
                        405 -> "Method Not Allowed"
                        else -> "Bad Request"
                    }
                rejectUpgrade(output, code, status)
                return false
            }

            /*
             * v5：握手的第二步 —— 建立加密会话。
             *
             * 密钥材料是查询串里的 `?k=`（客户端临时公钥，hex 未压缩点）；缺失或不在曲线上
             * 一律 400 拒绝（与 Netty 侧同一个判定，走的是同一个 [SealedChannel.handshake]）。
             */
            val channel =
                runCatching {
                    SealedChannel.handshake(
                        BridgeCrypto.fromHex(parseParam(query, "k") ?: ""),
                        SealedChannel.pskBytes(psk),
                    )
                }.getOrNull()
            if (channel == null) {
                BridgeLog.info("[bridge] 握手被拒 400：缺少或非法的客户端公钥（k）")
                val bytes = """{"code":"${BridgeErrorCodes.UNAUTHORIZED}","messageKey":"bridge.handshakeRejected"}""".toByteArray(Charsets.UTF_8)
                output.write(
                    ("HTTP/1.1 400 Bad Request\r\n" +
                        "Content-Type: application/json; charset=utf-8\r\n" +
                        "Content-Length: ${bytes.size}\r\n" +
                        "Connection: close\r\n\r\n").toByteArray(Charsets.UTF_8),
                )
                output.write(bytes)
                output.flush()
                return false
            }
            // 预认证池：满了明确拒绝（不排队）—— "连上不说话"不该是免费的占位手段
            if (!gate.tryEnter()) {
                BridgeLog.info("[bridge] 预认证连接数已达上限（${gate.pendingCount}），拒绝 $peer")
                rejectUpgrade(output, 503, "Service Unavailable")
                return false
            }
            pendingAuthSlot = true
            sealed = channel

            val accept = websocketAccept(headers.getValue("sec-websocket-key"))
            output.write(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n" +
                        "Upgrade: websocket\r\n" +
                        "Connection: Upgrade\r\n" +
                        "Sec-WebSocket-Accept: $accept\r\n\r\n"
                ).toByteArray(Charsets.UTF_8),
            )
            output.flush()
            BridgeLog.info("[bridge] 前端已连接（待认证）：$peer")

            /*
             * v5：握手完成后的**第一条帧必须是 hello**（明文，只承载服务端临时公钥）。
             * 客户端在拿到它之前算不出会话密钥，所以顺序不能反过来。
             */
            sendMessage(channel.helloFrame)
            return true
        }

        /** 回一个 HTTP 拒绝（**还没有任何帧**，所以是普通 JSON 错误体，与 Netty 侧同形）。 */
        private fun rejectUpgrade(
            output: OutputStream,
            code: Int,
            status: String,
        ) {
            val bytes =
                """{"code":"${BridgeErrorCodes.UNAUTHORIZED}","messageKey":"bridge.handshakeRejected"}"""
                    .toByteArray(Charsets.UTF_8)
            output.write(
                ("HTTP/1.1 $code $status\r\n" +
                    "Content-Type: application/json; charset=utf-8\r\n" +
                    "Content-Length: ${bytes.size}\r\n" +
                    "Connection: close\r\n\r\n").toByteArray(Charsets.UTF_8),
            )
            output.write(bytes)
            output.flush()
        }

        /** 从查询串里取一个参数（百分号解码，因为 Web 侧发的是 encodeURIComponent）。 */
        private fun parseParam(
            query: String,
            name: String,
        ): String? =
            query
                .split('&')
                .map { it.split('=', limit = 2) }
                .firstOrNull { it.size == 2 && it[0] == name }
                ?.get(1)
                ?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8) }

        /** 发一条**已编码好的** v4/v5 二进制消息（hello 用它：明文，握手时还没密钥）。 */
        fun sendMessage(bytes: ByteArray) {
            sendRawFrame(OPCODE_BINARY, bytes)
        }

        /**
         * v5：发一条逻辑帧 —— **编码、封装、写出都在这里**（与 Netty 侧同一口径）。
         *
         * 走 [SealedChannel.sealAndSend]：取号与写出在同一个临界区。少了这一条，
         * 并发回复会反过来上线，接收端按"序号回退"丢弃整条连接（实测现场就是"反复重连"）。
         */
        fun sendFrame(frame: BridgeFrame) {
            val channel = sealed
            if (channel == null) {
                BridgeLog.info("[bridge] 连接没有加密封装，丢弃一条出站帧")
                return
            }
            channel.sealAndSend(frame) { bytes -> sendMessage(bytes) }
        }

        /** 保活用：空 payload 的 ping。浏览器会按规范自动回 pong。 */
        fun sendPing() {
            sendRawFrame(OPCODE_PING, EMPTY_PAYLOAD)
        }

        private fun sendRawFrame(
            opcode: Int,
            payload: ByteArray,
        ) {
            val stream = out ?: return
            try {
                synchronized(writeLock) {
                    val header =
                        when {
                            payload.size < 126 -> byteArrayOf((0x80 or opcode).toByte(), payload.size.toByte())
                            payload.size < 65536 ->
                                byteArrayOf(
                                    (0x80 or opcode).toByte(),
                                    126,
                                    (payload.size shr 8).toByte(),
                                    payload.size.toByte(),
                                )

                            else ->
                                ByteArray(10).also { h ->
                                    h[0] = (0x80 or opcode).toByte()
                                    h[1] = 127
                                    val len = payload.size.toLong()
                                    for (i in 0 until 8) {
                                        h[2 + i] = (len shr (8 * (7 - i))).toByte()
                                    }
                                }
                        }
                    stream.write(header)
                    stream.write(payload)
                    stream.flush()
                }
            } catch (e: IOException) {
                close()
            }
        }

        /**
         * 关闭这条连接（幂等）。
         *
         * **先按规范发一个 WebSocket Close 帧，再关 TCP** —— 这一步两条传输必须一致：
         * Netty 侧的 `WebSocketServerProtocolHandler` 会在 `ctx.close()` 时代发 Close 帧，
         * 而这里如果只 `socket.close()`，对端看到的是**异常断开**（浏览器报 1006），
         * 于是"服务端主动关闭"这件在两边语义不同的事，在客户端变成了两种现象。
         * 这是 `pnpm check:bridge` 里那条"两条传输逐条一致"的用例逼出来的。
         */
        fun close() {
            if (!closeOnce.compareAndSet(false, true)) {
                return
            }
            closed = true
            // v5：没认证就关掉 —— 把预认证位还回去，否则"连一下就断"会把池耗光
            if (!authenticated && pendingAuthSlot) {
                pendingAuthSlot = false
                gate.leave()
            }
            runCatching { sendRawFrame(OPCODE_CLOSE, EMPTY_PAYLOAD) }
            runCatching { socket.close() }
        }

        private val closeOnce = java.util.concurrent.atomic.AtomicBoolean(false)
    }

    // ------------------------------------------------------------ 帧编解码

    /** 一个 WebSocket 帧（RFC6455 层面，不含任何桥协议语义）。 */
    private data class WsFrame(
        val opcode: Int,
        val payload: ByteArray,
        /** FIN：这是否为一条消息的最后一片（v4 由共用的 WireReader 按它做装配）。 */
        val fin: Boolean,
        /** 这一片在**线上**的字节数（脱掩码前）。 */
        val byteLength: Int,
    )

    /*
     * v3 这里有一份自写的 `FragmentAccumulator`：按**字符**累积文本、保留 id 嗅探前缀、
     * 超过硬上限就断开。v4 把它删了 —— 分片装配改由
     * `com.huicang.wise.bridge.protocol.WireReader` 统一负责（按 kind 选上限、保留帧头片段抠 id）。
     *
     * 这一处的收益不只是"少一份代码"：v3 那两份实现已经真实漂移过一次
     * （同一个二进制帧在 Netty 侧回结构化错误、在这里被静默丢弃）。
     * 收口之后，"两条传输行为必须逐条一致"从人工对照变成结构保证。
     */


    /**
     * 读一帧。客户端发来的帧**必须**带掩码（RFC6455 §5.1），这里照规矩解掩码。
     *
     * 与旧版的三点差别，都是踩过的坑：
     *  1. 长度字节用 [readByte] 读 —— 旧版直接 `input.read()`，EOF（-1）会被当成字节参与拼装，
     *     算出负长度后抛 `NegativeArraySizeException`（**不是 IOException**），读线程当场死掉；
     *  2. 长度超过 [FrameBudget.HARD_LIMIT] 时抛 IOException（不回错误帧：不值得为它分配内存）；
     *     介于协议上限与硬上限之间的帧**照常读进来**，由 [BridgeCallHandler] 回一条可诊断的错误；
     *  3. 分片要累积（见 [FragmentAccumulator]），FIN 之前不交给分发。
     *
     * @return null 表示对端正常关闭或流结束
     */
    private fun readFrame(input: InputStream): WsFrame? {
        val b0 = readByte(input) ?: return null
        val b1 = readByte(input) ?: return null
        val fin = (b0 and 0x80) != 0
        val opcode = b0 and 0x0F
        val masked = (b1 and 0x80) != 0
        var length = (b1 and 0x7F).toLong()
        if (length == 126L) {
            length = ((readByte(input) ?: throw IOException("truncated length")) shl 8 or
                (readByte(input) ?: throw IOException("truncated length"))).toLong()
        } else if (length == 127L) {
            length = 0
            for (i in 0 until 8) {
                length = (length shl 8) or (readByte(input) ?: throw IOException("truncated length")).toLong()
            }
        }
        if (length < 0 || length > hardLimitBytes.toLong()) {
            throw IOException("frame too large: $length")
        }
        if (!masked) {
            // 客户端帧必须带掩码；不带就是协议错误（不猜、不容忍）
            throw IOException("client frame without mask")
        }
        val mask = readFully(input, 4)
        val payload = readFully(input, length.toInt())
        for (i in payload.indices) {
            payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        }

        val isControlFrame = opcode >= 0x8
        if (isControlFrame) {
            // 控制帧不允许分片（RFC6455 §5.5），也不会参与累积
            return WsFrame(opcode, payload, fin, length.toInt())
        }

        // v4：传输层不再做任何聚合或文本解码 —— 原样把这一片交给共用的 WireReader。
        // 这也顺手修掉一个真实缺陷：v3 把**二进制**帧当文本累积（UTF-8 解码后再按 TEXT 分发），
        // 于同一个二进制帧在 Netty 侧回结构化错误、在这里被静默丢弃。
        return WsFrame(opcode, payload, fin, length.toInt())
    }

    /** 读一个字节；EOF 返回 null（**不要**把它当 0，旧版就是这么坏的）。 */
    private fun readByte(input: InputStream): Int? {
        val value = input.read()
        return if (value < 0) null else value
    }

    private fun readFully(
        input: InputStream,
        size: Int,
    ): ByteArray {
        val buffer = ByteArray(size)
        var read = 0
        while (read < size) {
            val n = input.read(buffer, read, size - read)
            if (n < 0) {
                throw IOException("unexpected end of stream")
            }
            read += n
        }
        return buffer
    }

    /** 读一行（以 CRLF 结尾），返回不含 CRLF 的内容。 */
    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) {
                return if (sb.isEmpty()) null else sb.toString()
            }
            if (c == '\r'.code) {
                input.read()
                return sb.toString()
            }
            sb.append(c.toChar())
        }
    }

    /** `Sec-WebSocket-Accept = base64(sha1(key + GUID))`（RFC6455 §4.2.2）。 */
    private fun websocketAccept(key: String): String {
        val sha1 = MessageDigest.getInstance("SHA-1")
        val digest = sha1.digest((key + WS_GUID).toByteArray(Charsets.UTF_8))
        return base64(digest)
    }

    private companion object {
        const val OPCODE_CONTINUATION = 0x0
        const val OPCODE_TEXT = 0x1
        const val OPCODE_BINARY = 0x2
        const val OPCODE_CLOSE = 0x8
        const val OPCODE_PING = 0x9
        const val OPCODE_PONG = 0xA

        /** 超大消息只留这么长的前缀用于抠 `id`（够用且不占内存）。 */
        const val ID_SNIFF_BYTES = 4096

        /** 保活/控制用：空 payload。 */
        val EMPTY_PAYLOAD = ByteArray(0)

        const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

        /**
         * 自带的 base64 编码器。
         *
         * 为什么不用 `java.util.Base64`：它在 Android 上要 API 26，而本项目 minSdk 是 25。
         * 二十行的实现换掉一个 API 版本约束，值。
         */
        fun base64(data: ByteArray): String {
            val sb = StringBuilder((data.size + 2) / 3 * 4)
            var i = 0
            while (i < data.size) {
                val b0 = data[i].toInt() and 0xFF
                val b1 = if (i + 1 < data.size) data[i + 1].toInt() and 0xFF else 0
                val b2 = if (i + 2 < data.size) data[i + 2].toInt() and 0xFF else 0
                sb.append(B64[b0 shr 2])
                sb.append(B64[((b0 and 0x03) shl 4) or (b1 shr 4)])
                sb.append(if (i + 1 < data.size) B64[((b1 and 0x0F) shl 2) or (b2 shr 6)] else '=')
                sb.append(if (i + 2 < data.size) B64[b2 and 0x3F] else '=')
                i += 3
            }
            return sb.toString()
        }
    }
}

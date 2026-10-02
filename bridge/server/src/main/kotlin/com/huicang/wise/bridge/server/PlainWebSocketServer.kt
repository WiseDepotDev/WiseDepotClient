package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.protocol.BridgeFrame
import com.huicang.wise.bridge.protocol.BridgeProtocol
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
    private val token: String,
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
    /** 单帧硬上限（超过就直接断开，连错误帧都不写）。见 [FrameBudget]。 */
    private val hardLimitBytes: Int = FrameBudget.HARD_LIMIT,
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
        val text = BridgeCodec.encode(frame)
        /*
         * **先快照、再出锁写。**
         *
         * 原先是在 `synchronized(clients)` 里逐个 `sendText`（内含 socket write + flush）：
         * 一个不读数据的客户端就能把整个广播拖住，`stop()`（同样要在锁里关连接）也跟着卡住 ——
         * 桥"关不掉"就是这么来的。锁内只允许做"取快照"这种 O(n) 且不阻塞的事。
         */
        for (connection in snapshotClients()) {
            connection.sendText(text)
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

        @Volatile private var closed = false

        @Volatile var lastInboundAt: Long = System.currentTimeMillis()
            private set

        val peer: String get() = socket.remoteSocketAddress?.toString() ?: "?"

        fun run() {
            try {
                socket.tcpNoDelay = true
                // 读超时是这一整段的前提：没有它，对端不发 FIN 时这个线程会永久阻塞
                socket.soTimeout = idleTimeoutMs
                val input = socket.getInputStream().buffered()
                val output = BufferedOutputStream(socket.getOutputStream())
                out = output

                if (!handshake(input, output)) {
                    close()
                    return
                }
                // 广播只在 token/origin 与 WebSocket 升级都通过之后才加入
                clients.add(this)

                val accumulator = FragmentAccumulator()
                while (!closed) {
                    val frame =
                        try {
                            readFrame(input, accumulator)
                        } catch (e: SocketTimeoutException) {
                            // 30 秒什么都没收到：保活线程会去 ping，这里直接判死（双保险）
                            BridgeLog.info("[bridge] 读超时（${idleTimeoutMs}ms），关闭 $peer")
                            break
                        }
                    if (frame == null) {
                        break
                    }
                    lastInboundAt = System.currentTimeMillis()
                    dispatch(frame)
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
        private fun dispatch(frame: WsFrame) {
            when (frame.opcode) {
                OPCODE_TEXT ->
                    callHandler.handleAsync(frame.text(), frame.byteLength, limiter, scope) { reply ->
                        sendText(reply)
                    }

                OPCODE_CONTINUATION -> Unit // 聚合逻辑已经在 readFrame 里处理完，不会走到这里
                OPCODE_PING -> sendFrame(OPCODE_PONG, frame.payload)
                OPCODE_PONG -> Unit // 保活线程只关心 lastInboundAt，在读到帧时已经刷新
                OPCODE_CLOSE -> close()
                else -> Unit
            }
        }

        /**
         * HTTP 升级握手。
         *
         * 三项校验（方法/路径、一次性 token、Origin）走**两条传输共用的** [HandshakePolicy]，
         * 因此这里不再自己写一遍判定 —— "两条传输口径一致"从人工对照变成结构保证。
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
            val decision =
                HandshakePolicy.decide(
                    method = parts.getOrNull(0) ?: "",
                    path = target.substringBefore('?'),
                    providedToken = parseToken(target.substringAfter('?', "")),
                    expectedToken = token,
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
                        401 -> "Unauthorized"
                        403 -> "Forbidden"
                        404 -> "Not Found"
                        405 -> "Method Not Allowed"
                        else -> "Bad Request"
                    }
                val body = callHandler.unauthorizedFrame()
                val bytes = body.toByteArray(Charsets.UTF_8)
                output.write(
                    ("HTTP/1.1 $code $status\r\n" +
                        "Content-Type: application/json; charset=utf-8\r\n" +
                        "Content-Length: ${bytes.size}\r\n" +
                        "Connection: close\r\n\r\n").toByteArray(Charsets.UTF_8),
                )
                output.write(bytes)
                output.flush()
                return false
            }

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
            BridgeLog.info("[bridge] 前端已连接：$peer")
            return true
        }

        /** 从 `a=1&token=xxx` 里取出 token（百分号解码，因为 Web 侧发的是 encodeURIComponent）。 */
        private fun parseToken(query: String): String? =
            query
                .split('&')
                .map { it.split('=', limit = 2) }
                .firstOrNull { it.size == 2 && it[0] == "token" }
                ?.get(1)
                ?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8) }

        fun sendText(text: String) {
            sendFrame(OPCODE_TEXT, text.toByteArray(Charsets.UTF_8))
        }

        /** 保活用：空 payload 的 ping。浏览器会按规范自动回 pong。 */
        fun sendPing() {
            sendFrame(OPCODE_PING, EMPTY_PAYLOAD)
        }

        private fun sendFrame(
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

        fun close() {
            closed = true
            runCatching { socket.close() }
        }
    }

    // ------------------------------------------------------------ 帧编解码

    /** 一帧（或聚合后的一条消息）。 */
    private data class WsFrame(
        val opcode: Int,
        val payload: ByteArray,
        /** 这条消息在**线上**的字节数（分片场景是各片之和）。 */
        val byteLength: Int,
    ) {
        fun text(): String = payload.toString(Charsets.UTF_8)
    }

    /**
     * 分片累积器（RFC6455 §5.4）。
     *
     * 为什么要它：一条消息**允许**被拆成多帧（浏览器发大 payload 时就会）。
     * 原先的实现在第一条分片上就当成完整文本帧去解析 —— 结果是回一句
     * `bridge.notARequestFrame`（"这不是请求帧"），而真正原因是"它还没发完"。
     * 更糟的是它在 Netty 与自写传输上**表现不同**（Netty 侧由协议处理器兜着），
     * 于是同一个大请求在手机上能用、在电脑上不能用。
     *
     * 两条硬边界：
     *  - 超过 [FrameBudget.PROTOCOL_LIMIT] 之后**不再累积正文**，只留前 [ID_SNIFF_BYTES] 个字符
     *    （够抠出 `id` 好回一条对得上号的错误），并继续把字节数记准；
     *  - 超过 [FrameBudget.HARD_LIMIT] 直接当"不可信对端"断开。
     */
    private class FragmentAccumulator {
        private val head = StringBuilder()
        private var bytes = 0

        /** 追加一片；返回是否已经超过硬上限（调用方据此断开）。 */
        fun append(
            text: String,
            byteLength: Int,
        ): Boolean {
            bytes += byteLength
            if (bytes > FrameBudget.HARD_LIMIT) {
                return true
            }
            // 只保留消息开头的一段用于抠 `id`；**取"还能装下的那一段"**，
            // 而不是"整片装不下就一片都不装"（第一片本身就可能超长，那样 id 会丢）。
            val room = ID_SNIFF_BYTES - head.length
            if (room > 0) {
                head.append(text, 0, minOf(room, text.length))
            }
            return false
        }

        /** 结束一条消息：返回 (用于解析或抠 id 的文本, 线上字节数)。 */
        fun finish(): Pair<String, Int> = head.toString() to bytes

        fun reset() {
            head.setLength(0)
            bytes = 0
        }
    }

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
    private fun readFrame(
        input: InputStream,
        accumulator: FragmentAccumulator,
    ): WsFrame? {
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
            return WsFrame(opcode, payload, length.toInt())
        }

        // 文本/续帧：累积到 FIN 再交出去
        val overHardLimit = accumulator.append(payload.toString(Charsets.UTF_8), length.toInt())
        if (overHardLimit) {
            throw IOException("fragmented message exceeds hard limit")
        }
        if (!fin) {
            // 还没发完：本次不产生"可分发"的帧
            return WsFrame(OPCODE_CONTINUATION, EMPTY_PAYLOAD, 0)
        }
        val (text, byteLength) = accumulator.finish()
        accumulator.reset()
        return WsFrame(if (opcode == OPCODE_CONTINUATION) OPCODE_TEXT else opcode, text.toByteArray(Charsets.UTF_8), byteLength)
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
        const val OPCODE_CLOSE = 0x8
        const val OPCODE_PING = 0x9
        const val OPCODE_PONG = 0xA

        /** 超大消息只留这么长的前缀用于抠 `id`（够用且不占内存）。 */
        const val ID_SNIFF_BYTES = 4096

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

package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.protocol.BridgeFrame
import com.huicang.wise.bridge.protocol.BridgeProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Collections
import kotlin.concurrent.thread

/**
 * **纯 socket 的 WebSocket 服务端**（自写 RFC6455）。
 *
 * ## 为什么需要它
 *
 * Netty 在 Android 上是"非官方支持"（`docs/architecture.md` §4 预先写下的风险）。
 * W2 的门禁里 dex 与体积都过了，但**真机可连**没过：实测 Netty 在 WSA 上
 * `bind().sync()` 成功、端口也拿到了，**随后监听消失**（从容器 shell 直连被拒），
 * 应用进程却存活、无崩溃。既然功能性那一项不达标，就按预案换实现。
 *
 * 这**不是**"改架构"：不变式 3 早就把传输放在了端口后面（[TransportPort]），
 * 因此本文件是新增，协议层 / backend / 桌面宿主 / Web 一行都不动。
 *
 * ## 为什么自写而不是引 Ktor
 *
 * - 只要 RFC6455 的一个子集：HTTP 升级 + 文本帧 + ping/pong + close，**约 300 行**；
 * - 零新依赖（Ktor 会带进一个完整的 HTTP 栈），与仓库"不轻易加依赖"的惯例一致；
 * - 只用 `java.net.ServerSocket` / `Socket` / `MessageDigest` —— 三者在 Android API 1 就有，
 *   不像 Netty 那样依赖 `sun.misc.Unsafe`、`java.lang.management`、`SelectorImpl` 的反射。
 *
 * ## 线程模型
 *
 * 一个 accept 线程 + 每连接一个读线程。loopback 上只有 WebView 一个客户端，
 * 因此这比 Netty 的 event loop 更简单、也更容易在 Android 上解释清楚。
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
) {
    private val clients: MutableSet<PlainConnection> = Collections.synchronizedSet(mutableSetOf())
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null

    @Volatile private var boundPort: Int = -1

    val port: Int get() = boundPort

    val connectionCount: Int get() = clients.size

    fun start(): Int {
        val socket = ServerSocket()
        socket.reuseAddress = true
        // 显式 IPv4 字面量而不是 getLoopbackAddress()：后者在双栈机器上可能给 ::1，
        // 与引导文件里下发的地址不一致，表现为"绑上了却连不上"（W2 踩过）。
        socket.bind(InetSocketAddress(InetAddress.getByName(host), port0))
        serverSocket = socket
        boundPort = socket.localPort

        // 启动自检：绑完立刻从**本进程**回连自己。
        // 这一条把两种完全不同的故障分开：
        //   · 自检失败 → bind 根本没在监听（环境/权限/地址问题，与传输实现无关）；
        //   · 自检成功但外部连不上 → 跨进程可见性问题（网络命名空间/防火墙）。
        // 没有它，"端口连不上"会被一路误判成"传输实现有问题"——
        // W3 在 WSA 上先后怀疑过混合内容、CSP、Netty，最后是这条自检把方向纠正过来的。
        BridgeLog.info("[bridge] 绑定 $host:$boundPort，自检：本进程回连 -> ${LoopbackSelfTest.run(boundPort, host)}")

        acceptThread =
            thread(isDaemon = true, name = "bridge-accept") {
                while (!socket.isClosed) {
                    val client =
                        try {
                            socket.accept()
                        } catch (e: IOException) {
                            break
                        }
                    val connection = PlainConnection(client)
                    clients.add(connection)
                    thread(isDaemon = true, name = "bridge-conn") { connection.run() }
                }
            }
        return boundPort
    }

    fun broadcast(frame: BridgeFrame) {
        if (clients.isEmpty()) {
            return
        }
        val text = BridgeCodec.encode(frame)
        synchronized(clients) {
            for (c in clients.toList()) {
                c.sendText(text)
            }
        }
    }

    fun stop() {
        runCatching { serverSocket?.close() }
        synchronized(clients) {
            for (c in clients.toList()) {
                c.close()
            }
        }
        clients.clear()
        scope.cancel()
        boundPort = -1
    }

    /** 一个客户端连接：先做 HTTP 升级，然后进入帧循环。 */
    private inner class PlainConnection(private val socket: Socket) {
        private val limiter = RateLimiter(maxPerSecond, burst)
        private val writeLock = Any()
        private var out: OutputStream? = null

        @Volatile private var closed = false

        fun run() {
            try {
                socket.tcpNoDelay = true
                val input = socket.getInputStream().buffered()
                val output = BufferedOutputStream(socket.getOutputStream())
                out = output

                if (!handshake(input, output)) {
                    close()
                    return
                }

                while (!closed) {
                    val frame = readFrame(input) ?: break
                    when (frame.opcode) {
                        OPCODE_TEXT -> callHandler.handleAsync(frame.text(), limiter, scope) { reply -> sendText(reply) }
                        OPCODE_PING -> sendFrame(OPCODE_PONG, frame.payload)
                        OPCODE_CLOSE -> break
                        else -> Unit
                    }
                }
            } catch (e: IOException) {
                // 客户端断开是常态，不刷屏
            } finally {
                clients.remove(this)
                close()
            }
        }

        /**
         * HTTP 升级握手。
         *
         * 校验三项：路径、一次性 token、Origin（带了就必须在白名单里）。
         * 与 Netty 路径的口径**逐条一致** —— 两条传输的行为不能有差异。
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
            val path = target.substringBefore('?')
            val query = target.substringAfter('?', "")
            val providedToken = query.split('&').map { it.split('=') }.firstOrNull { it[0] == "token" }?.getOrNull(1)
            val origin = headers["origin"]

            val status =
                when {
                    parts.getOrNull(0) != "GET" -> 405 to "Method Not Allowed"
                    path != BridgeProtocol.HANDSHAKE_PATH -> 404 to "Not Found"
                    providedToken != token -> 401 to "Unauthorized"
                    origin != null && origin !in allowedOrigins -> 403 to "Forbidden"
                    headers["sec-websocket-key"] == null -> 400 to "Bad Request"
                    else -> null
                }
            if (status != null) {
                BridgeLog.info("[bridge] 握手被拒 ${status.first}：path=$path origin=${origin ?: "(无)"}")
                val body = callHandler.unauthorizedFrame()
                val bytes = body.toByteArray(Charsets.UTF_8)
                output.write(
                    ("HTTP/1.1 ${status.first} ${status.second}\r\n" +
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
            BridgeLog.info("[bridge] 前端已连接：${socket.remoteSocketAddress}")
            return true
        }

        fun sendText(text: String) {
            sendFrame(OPCODE_TEXT, text.toByteArray(Charsets.UTF_8))
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

    private data class WsFrame(
        val opcode: Int,
        val payload: ByteArray,
    ) {
        fun text(): String = payload.toString(Charsets.UTF_8)
    }

    /**
     * 读一帧。客户端发来的帧**必须**带掩码（RFC6455 §5.1），这里照规矩解掩码。
     *
     * @return null 表示对端正常关闭或流结束
     */
    private fun readFrame(input: InputStream): WsFrame? {
        val b0 = input.read()
        if (b0 < 0) {
            return null
        }
        val b1 = input.read()
        if (b1 < 0) {
            return null
        }
        val opcode = b0 and 0x0F
        val masked = (b1 and 0x80) != 0
        var length = (b1 and 0x7F).toLong()
        if (length == 126L) {
            length = ((input.read() shl 8) or input.read()).toLong()
        } else if (length == 127L) {
            length = 0
            for (i in 0 until 8) {
                length = (length shl 8) or input.read().toLong()
            }
        }
        if (length > BridgeProtocol.MAX_FRAME_BYTES.toLong()) {
            // 超限不尝试读完（那正是攻击者想要的），直接断开
            throw IOException("frame too large: $length")
        }
        val mask = if (masked) readFully(input, 4) else null
        val payload = readFully(input, length.toInt())
        if (mask != null) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
            }
        }
        return WsFrame(opcode, payload)
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
        const val OPCODE_TEXT = 0x1
        const val OPCODE_CLOSE = 0x8
        const val OPCODE_PING = 0x9
        const val OPCODE_PONG = 0xA
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

package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendPort
import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.backend.TokenStore
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeFrame
import com.huicang.wise.bridge.protocol.BridgeWire
import com.huicang.wise.bridge.protocol.ErrFrame
import com.huicang.wise.bridge.protocol.ReqFrame
import com.huicang.wise.bridge.protocol.ResFrame
import com.huicang.wise.bridge.protocol.WireDecode
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.util.concurrent.CompletionStage
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 桥的测试支撑件。
 *
 * ## 为什么要"假后端 + 真 socket"这一层
 *
 * 桥的问题几乎全出在**边界**上：对端消失、帧被截断、后端暂时不可达、请求堆压。
 * 这些用 mock 掉传输是测不出来的 —— 必须有一个**真 socket 的客户端**连上来，
 * 而且"后端怎么答"要能被测试摆布（回 401 / 回 500 / 干脆不答）。
 * 于是：
 *  · [FakeBackend]：把"后端怎么答"变成测试的输入（[BackendPort] 是桥里唯一出口）；
 *  · [TestWsClient]：用 JDK 自带的 `HttpClient` WebSocket 当客户端 —— 它**会自动回 pong**，
 *    与浏览器行为一致（这正是"服务端主动 ping 探活"能否成立的前提，所以不能用裸 TCP 假装）。
 *
 * ## v4：测试客户端说的是**二进制帧**
 *
 * v3 时这里是 `onText` + 字符串队列；v4 的线上是二进制消息（[BridgeWire]），
 * 所以客户端收 `onBinary` 并累积分片、按共用的 `BridgeWire.decode` 解成**逻辑帧**。
 * 测试因此可以直接断言类型（`assertIs<ErrFrame>`），不必再对 JSON 文本做子串匹配 ——
 * 那正是"线格式一改、断言全废"的根源。
 */
class FakeBackend(
    /** 每一次调用的记录，断言"桥发了什么"用。 */
    val calls: MutableList<BackendCall> = mutableListOf(),
    private var answer: (BackendCall) -> BackendResult = { BackendResult.Ok(null) },
) : BackendPort {
    /** 换一个应答策略（测试中途改也行）。 */
    fun answerWith(block: (BackendCall) -> BackendResult) {
        answer = block
    }

    override suspend fun call(call: BackendCall): BackendResult {
        synchronized(calls) { calls += call }
        return answer(call)
    }
}

/** 内存令牌存储：本模块的测试不关心落盘（那部分在 `:bridge:backend` 已有专门用例）。 */
class FakeTokenStore : TokenStore {
    @Volatile private var access: String? = null
    @Volatile private var refresh: String? = null

    override val persistent: Boolean = false

    override fun accessToken(): String? = access

    override fun refreshToken(): String? = refresh

    override fun update(
        access: String?,
        refresh: String?,
    ) {
        this.access = access
        this.refresh = refresh
    }

    override fun clear() {
        access = null
        refresh = null
    }
}

/** 固定能力/版本的平台端口（桥内只有日志与引导文件会读它）。 */
class FakePlatform(
    override val capabilities: Set<String> = setOf("storage.secure"),
    override val version: String = "0.0.0-test",
) : PlatformPort {
    override val platform: String = "test"
}

/**
 * 一个够用的 WebSocket 客户端（JDK 11+）。
 *
 * 关键特性：**收到 ping 会自动回 pong**（JDK 实现按规范代答），
 * 所以它检验得了"服务端主动 ping 探活"这条设计；裸 TCP 假装客户端就验不了。
 */
class TestWsClient(
    uri: String,
    /** 每收到一帧（已解码）时回调，便于"边收边记"的断言。 */
    private val onFrameHook: ((BridgeFrame) -> Unit)? = null,
) : AutoCloseable {
    private val frames = LinkedBlockingQueue<BridgeFrame>()
    private val closedLatch = CountDownLatch(1)
    private val pending = ByteArrayOutputStream()

    /** 对端关闭时的状态码（-1 表示没拿到）。 */
    @Volatile var closeCode: Int = -1
        private set

    private val socket: WebSocket

    init {
        val listener =
            object : WebSocket.Listener {
                override fun onBinary(
                    webSocket: WebSocket,
                    data: ByteBuffer,
                    last: Boolean,
                ): CompletionStage<*>? {
                    val chunk = ByteArray(data.remaining())
                    data.get(chunk)
                    synchronized(pending) { pending.write(chunk) }
                    if (last) {
                        val bytes = synchronized(pending) { pending.toByteArray().also { pending.reset() } }
                        // 解不出来的入站消息**不入队**：那是"服务端发了非法帧"，由断言自己炸而不是这里静默补一个对象
                        (BridgeWire.decode(bytes) as? WireDecode.Ok)?.let {
                            frames.add(it.frame)
                            onFrameHook?.invoke(it.frame)
                        }
                    }
                    webSocket.request(1)
                    return null
                }

                override fun onClose(
                    webSocket: WebSocket,
                    statusCode: Int,
                    reason: String,
                ): CompletionStage<*>? {
                    closeCode = statusCode
                    closedLatch.countDown()
                    return null
                }

                override fun onError(
                    webSocket: WebSocket,
                    error: Throwable,
                ) {
                    closedLatch.countDown()
                }
            }
        socket =
            HttpClient
                .newHttpClient()
                .newWebSocketBuilder()
                .buildAsync(URI.create(uri), listener)
                .orTimeout(10, TimeUnit.SECONDS)
                .join()
    }

    /** 发一帧（按 v4 线格式编码）。 */
    fun send(frame: BridgeFrame) {
        sendRaw(BridgeWire.encode(frame))
    }

    /** 发一段原始字节 —— 用于"结构不合法的帧"这类用例。 */
    fun sendRaw(bytes: ByteArray) {
        socket.sendBinary(ByteBuffer.wrap(bytes), true).orTimeout(10, TimeUnit.SECONDS).join()
    }

    /** 发一个**文本**帧：v4 只走二进制，这条路径专门用来验收 `BRIDGE_WIRE_MODE`。 */
    fun sendTextRaw(text: String) {
        socket.sendText(text, true).orTimeout(10, TimeUnit.SECONDS).join()
    }

    /** 读一帧；超时返回 null（不抛，方便断言"什么都不该来"）。 */
    fun awaitFrame(timeoutMs: Long = 5_000): BridgeFrame? = frames.poll(timeoutMs, TimeUnit.MILLISECONDS)

    /** 把已收到的帧全部取走（用于"排空"再断言后续）。 */
    fun drain() {
        frames.clear()
    }

    /** 等到对端关闭。 */
    fun awaitClosed(timeoutMs: Long = 5_000): Boolean = closedLatch.await(timeoutMs, TimeUnit.MILLISECONDS)

    /** 主动发一个 ping（验服务端的 pong 路径）。 */
    fun ping() {
        // JDK 的签名收 ByteBuffer（Kotlin 里看到的是平台类型），给一个空 payload 就够
        socket.sendPing(ByteBuffer.allocate(0)).orTimeout(5, TimeUnit.SECONDS).join()
    }

    override fun close() {
        runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "bye").orTimeout(3, TimeUnit.SECONDS).join() }
        runCatching { socket.abort() }
    }
}

/** 组装一条请求帧（测试里到处要用，集中一处便于跟着协议改）。 */
fun reqFrame(
    id: String,
    method: String,
    params: JsonElement? = null,
): BridgeFrame = ReqFrame(id = id, method = method, params = params)

/** 响应/错误帧里的 id（每一处断言都要它，省得各写一遍 `when`）。 */
fun frameId(frame: BridgeFrame?): String? =
    when (frame) {
        is ReqFrame -> frame.id
        is ResFrame -> frame.id
        is ErrFrame -> frame.id
        null -> null
        else -> null
    }

/** 错误码（非错误帧返回 null，让断言自己炸）。 */
fun errCode(frame: BridgeFrame?): String? = (frame as? ErrFrame)?.error?.code

/** 常用：`{"a":1}` 这样的参数对象。 */
fun jsonParams(vararg pairs: Pair<String, Any>): JsonObject =
    JsonObject(
        pairs.associate { (k, v) ->
            k to
                when (v) {
                    is Int -> JsonPrimitive(v)
                    is Long -> JsonPrimitive(v)
                    is Boolean -> JsonPrimitive(v)
                    else -> JsonPrimitive(v.toString())
                }
        },
    )

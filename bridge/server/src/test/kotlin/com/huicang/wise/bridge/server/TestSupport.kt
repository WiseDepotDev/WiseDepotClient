package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendPort
import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.backend.TokenStore
import com.huicang.wise.bridge.capability.PlatformPort
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.util.concurrent.CompletionStage
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 桥的测试支撑件（`:bridge:server` 之前**一个测试都没有**，这份是那套底座）。
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
    /** 缺省在 [onText] 里自动 `request(1)`，让流不因为没请求而停住。 */
    private val onTextHook: ((String) -> Unit)? = null,
) : AutoCloseable {
    private val texts = LinkedBlockingQueue<String>()
    private val closedLatch = CountDownLatch(1)

    /** 对端关闭时的状态码（-1 表示没拿到）。 */
    @Volatile var closeCode: Int = -1
        private set

    private val socket: WebSocket

    init {
        val listener =
            object : WebSocket.Listener {
                override fun onText(
                    webSocket: WebSocket,
                    data: CharSequence,
                    last: Boolean,
                ): CompletionStage<*>? {
                    val text = data.toString()
                    texts.add(text)
                    onTextHook?.invoke(text)
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

    fun send(text: String) {
        socket.sendText(text, true).orTimeout(10, TimeUnit.SECONDS).join()
    }

    /** 读一帧文本；超时返回 null（不抛，方便断言"什么都不该来"）。 */
    fun awaitText(timeoutMs: Long = 5_000): String? = texts.poll(timeoutMs, TimeUnit.MILLISECONDS)

    /** 把已收到的帧全部取走（用于"排空"再断言后续）。 */
    fun drain() {
        texts.clear()
    }

    /** 等到对端关闭。 */
    fun awaitClosed(timeoutMs: Long = 5_000): Boolean = closedLatch.await(timeoutMs, TimeUnit.MILLISECONDS)

    /** 主动发一个 ping（验服务端的 pong 路径）。 */
    fun ping() {
        // JDK 的签名收 ByteBuffer（Kotlin 里看到的是平台类型），给一个空 payload 就够
        socket.sendPing(java.nio.ByteBuffer.allocate(0)).orTimeout(5, TimeUnit.SECONDS).join()
    }

    override fun close() {
        runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "bye").orTimeout(3, TimeUnit.SECONDS).join() }
        runCatching { socket.abort() }
    }
}

/** 组装一句请求帧文本（测试里到处要用，集中一处便于跟着协议改）。 */
fun reqFrame(
    id: String,
    method: String,
    params: JsonElement? = null,
    version: Int = 3,
): String =
    buildJsonObject {
        put("v", JsonPrimitive(version))
        put("type", JsonPrimitive("req"))
        put("id", JsonPrimitive(id))
        put("method", JsonPrimitive(method))
        if (params != null) {
            put("params", params)
        }
    }.toString()

/** 从响应帧里抠出 `id` / `code`，避免每个断言都做一遍 JSON 解析样板。 */
fun frameField(
    text: String?,
    field: String,
): String? {
    if (text == null) {
        return null
    }
    val marker = "\"$field\":\""
    val from = text.indexOf(marker)
    if (from < 0) {
        return null
    }
    val start = from + marker.length
    val end = text.indexOf('"', start)
    return if (end > start) text.substring(start, end) else null
}

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

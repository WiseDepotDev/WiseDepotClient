package com.huicang.wise.bridge.backend

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 后端访问的**唯一实现**，桌面与手机共用。
 *
 * 用 OkHttp 是刻意的选型：它同时存在于 JVM 与 Android 上，因此这一层不需要平台分叉
 * （若桌面用 JDK HttpClient、手机用 OkHttp，就等于同一份语义写两遍，必然漂移）。
 *
 * 三条纪律：
 * 1. 请求体**必须**是统一信封（[Envelope.wrap]），否则后端解包失败；
 * 2. `REQUEST-ID` 头与信封里的 `request_id` **必须是同一个值**（旧仓 STD-CONTRACT-01 规则 1）；
 * 3. 所有失败都变成 [BackendResult.Failed]，**不向上抛异常**——桥的统一兜底只在一处。
 *
 * ## 为什么是 `enqueue` 而不是阻塞 `execute`
 *
 * 原先的写法是 `withContext(Dispatchers.IO) { client.newCall(req).execute() }`：
 * 阻塞调用**不响应取消** —— 连接断开、桥关停、或上层超时放弃时，这次 HTTP 仍然要跑满
 * `callTimeout`（10 秒）才释放线程，而那个线程还占着 `Dispatchers.IO` 的名额。
 * 改成 `enqueue` + `suspendCancellableCoroutine` 之后：取消是**即时**的
 * （`invokeOnCancellation { call.cancel() }`），而且真正在跑的是 OkHttp 自己的调度线程。
 */
class OkHttpBackend(
    baseUrl: String,
    private val tokens: TokenStore,
    private val client: OkHttpClient = defaultClient(),
    private val clock: () -> Long = System::currentTimeMillis,
    /**
     * 失败时的日志出口。
     *
     * 为什么必须有：`BRIDGE_BACKEND_UNREACHABLE` 到了界面上只有一句"后端不可达"，
     * 而**原因**（连接被拒？读超时？DNS？）全在下面那个 catch 里。
     * 实测踩过：WSA 上登录失败只显示一个码，桥的日志里一片空白，只能靠猜。
     * `bridge:backend` 不依赖 `bridge:server`，所以用函数参数注入而不是直接引用 BridgeLog。
     */
    private val log: (String) -> Unit = {},
) : BackendPort {
    private val base: String = baseUrl.trimEnd('/')

    override suspend fun call(call: BackendCall): BackendResult {
        val path =
            PathTemplate.resolve(call.pathTemplate, call.params)
                ?: return BackendResult.Failed(
                    code = BackendErrorCodes.PARAMS_INVALID,
                    messageKey = "bridge.paramsMissingPathParam",
                    retryable = false,
                )

        val rest = PathTemplate.remaining(call.pathTemplate, call.params)
        val wantsBody = call.httpMethod.uppercase() in setOf("POST", "PUT", "PATCH")
        // 契约标了 QUERY 的方法：参数拼 query、**不发信封 body**。
        // 服务端这些端点用的是 @RequestParam，只认 query string（见 BackendCall.paramStyle）。
        val hasBody = wantsBody && call.paramStyle == ParamStyle.BODY

        val urlBuilder = "$base$path".toHttpUrlOrNull()?.newBuilder()
            ?: return BackendResult.Failed(
                code = BackendErrorCodes.INTERNAL,
                messageKey = "bridge.badUrl",
                retryable = false,
            )
        if (!hasBody) {
            for ((k, v) in rest) {
                when (v) {
                    is JsonArray -> v.forEach { item -> (item as? JsonPrimitive)?.content?.let { urlBuilder.addQueryParameter(k, it) } }
                    is JsonPrimitive -> urlBuilder.addQueryParameter(k, v.content)
                    else -> Unit
                }
            }
        }
        val url = urlBuilder.build()

        val body =
            when {
                // 个别端点要求路径参数**同时**出现在 body 里（见 BackendCall.keepPathParamsInBody）：
                // 服务端 DTO 会把它再声明一次并加 @NotNull，而控制器里的 setter 在绑定之后才跑。
                hasBody && call.keepPathParamsInBody ->
                    Envelope.wrap(call.packetType, call.requestId, call.params ?: JsonObject(emptyMap()), clock())
                        .toRequestBody(JSON_MEDIA)
                hasBody -> Envelope.wrap(call.packetType, call.requestId, rest, clock()).toRequestBody(JSON_MEDIA)
                // OkHttp 硬性要求 POST/PUT/PATCH 必须带 body（不带会抛 IllegalArgumentException），
                // 所以"参数走 query"的那些方法要发一个空 JSON 对象占位 —— 服务端没有 @RequestBody，不会去解析它。
                wantsBody -> EMPTY_JSON_BODY.toRequestBody(JSON_MEDIA)
                else -> null
            }

        val requestBuilder = Request.Builder().url(url).header(Envelope.REQUEST_ID_HEADER, call.requestId)
        tokens.accessToken()?.let { requestBuilder.header("Authorization", "Bearer $it") }
        requestBuilder.method(call.httpMethod.uppercase(), body)

        return try {
            val raw = client.newCall(requestBuilder.build()).awaitRaw()
            val text = raw.text
            if (raw.truncated) {
                // 不把超大响应读进堆：明确回一条"太大"，也不让它变成 OOM
                log("后端响应超过 ${MAX_RESPONSE_BYTES / 1024 / 1024}MiB，已截断：path=${call.pathTemplate}")
                return BackendResult.Failed(
                    code = BackendErrorCodes.UNREACHABLE_RESPONSE_TOO_LARGE,
                    messageKey = "bridge.frameTooLarge",
                    retryable = false,
                )
            }
            if (raw.status !in 200..299) {
                return failureFromStatus(raw.status, text)
            }
            val unwrapped =
                Envelope.unwrap(text)
                    ?: return BackendResult.Failed(
                        code = BackendErrorCodes.INTERNAL,
                        messageKey = "bridge.envelopeMalformed",
                        retryable = true,
                    )
            val code = unwrapped.errorCode ?: unwrapped.code
            if (unwrapped.code == Envelope.SUCCESS_CODE) {
                // raw 一起带出去：令牌截留那边靠它做一次廉价预检，跳过绝大多数响应的深度遍历
                BackendResult.Ok(unwrapped.data, raw = text)
            } else {
                BackendResult.Failed(
                    code = code ?: BackendErrorCodes.INTERNAL,
                    messageKey = null,
                    retryable = false,
                    // 业务拒绝的原因只有服务端知道（例：「只能对已完成的巡检任务进行补录」）。
                    // 白名单前缀 + 截断，见 BackendErrorCodes.detailFor。
                    details = BackendErrorCodes.detailFor(code ?: "", unwrapped.message),
                )
            }
        } catch (e: IOException) {
            // 把**原因**打出来：只回一个 BACKEND_UNREACHABLE 到界面，等于让排障从零开始
            log(
                "后端请求失败 method=${call.httpMethod} path=${call.pathTemplate} " +
                    "url=$url：${e.javaClass.simpleName}: ${e.message}" +
                    (e.cause?.let { " ← ${it.javaClass.simpleName}: ${it.message}" } ?: ""),
            )
            BackendResult.Failed(BackendErrorCodes.UNREACHABLE, "bridge.backendUnreachable", retryable = true)
        }
    }

    /** 一次原始响应：状态码 + 已读文本 + 是否因超限被截断。 */
    private class RawResponse(
        val status: Int,
        val text: String,
        val truncated: Boolean,
    )

    /**
     * 让 `Call` 变成可取消的挂起调用，**响应体也在 OkHttp 的线程上读**。
     *
     * 三个细节，都是被测试逼出来的：
     *  1. 协程被取消时 `call.cancel()`：立刻掐掉这条请求，而不是等 `callTimeout`；
     *  2. **体必须在 `onResponse` 里读完**：把 `response.body.string()` 留在协程里读，
     *     它是一段**不可打断**的阻塞读 —— 取消只能让协程结束，连接却还挂着读到超时
     *     （实测：200ms 超时的"取消"要 8 秒才真的回来）。读在 OkHttp 线程上，
     *     `cancel()` 才能真正把连接掐断，读随即以 IOException 结束；
     *  3. 回复到达（或被取消）时协程已经不活跃：**把 body 关掉**，否则连接泄漏在池里。
     */
    private suspend fun Call.awaitRaw(): RawResponse =
        suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { runCatching { cancel() } }
            enqueue(
                object : Callback {
                    override fun onFailure(
                        call: Call,
                        e: IOException,
                    ) {
                        if (continuation.isActive) {
                            continuation.resumeWithException(e)
                        }
                    }

                    override fun onResponse(
                        call: Call,
                        response: Response,
                    ) {
                        // 读取本身也可能因为"被取消"而抛（连接已被 cancel 掐断）→ 统一在这里收口
                        runCatching {
                            response.use { res ->
                                val (text, truncated) = readCapped(res.body)
                                RawResponse(res.code, text, truncated)
                            }
                        }.fold(
                            onSuccess = { if (continuation.isActive) continuation.resume(it) },
                            onFailure = { if (continuation.isActive) continuation.resumeWithException(it) },
                        )
                    }
                },
            )
        }

    /**
     * 读响应体，最多读 [MAX_RESPONSE_BYTES] + 1 字节。
     *
     * **必须循环读**：`source().read(buffer, n)` 只保证"读到了一部分"（socket 分片到达），
     * 一次调用很可能只返回几 KB。原先只读一次就 `readUtf8()`，于是大响应会被当成
     * "半截 JSON" → 报 `bridge.envelopeMalformed`（一个完全不指向真因的错误）。
     * 测试里用 4MiB 响应把它逼出来了。
     *
     * @return (文本, 是否被截断)。截断时文本没有意义、调用方只用来记日志。
     */
    private fun readCapped(body: ResponseBody?): Pair<String, Boolean> {
        if (body == null) {
            return "" to false
        }
        val limit = MAX_RESPONSE_BYTES.toLong() + 1
        val buffer = Buffer()
        val source = body.source()
        var total = 0L
        while (total < limit) {
            val read = source.read(buffer, limit - total)
            if (read == -1L) {
                break
            }
            total += read
        }
        if (total > MAX_RESPONSE_BYTES) {
            return "" to true
        }
        return buffer.readUtf8() to false
    }

    /** HTTP 层失败 → 桥错误码。401 固定映射到 `error_session_expired`（延续旧仓口径）。 */
    private fun failureFromStatus(
        status: Int,
        errorBody: String,
    ): BackendResult {
        val unwrapped = Envelope.unwrap(errorBody)
        val code = unwrapped?.let { it.errorCode ?: it.code } ?: "HTTP-$status"
        val messageKey = if (status == 401) "error_session_expired" else null
        val retryable = status >= 500
        return BackendResult.Failed(
            code = code,
            messageKey = messageKey,
            retryable = retryable,
            details = BackendErrorCodes.detailFor(code, unwrapped?.message),
        )
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /** POST/PUT/PATCH 但参数走 query 时的占位 body（OkHttp 不允许这几种方法不带 body）。 */
        private const val EMPTY_JSON_BODY = "{}"

        /**
         * 单个响应体的读取上限（4 MiB）。
         *
         * 为什么要有：桥的出路是 WebSocket 文本帧，正常情况下几 KB；
         * 一个异常的大响应（或坏掉的后端）会把桥进程的堆吃掉，而"桥挂了"在现场是灾难。
         * 超过就回一条明确的"太大"，而不是 OOM。
         */
        const val MAX_RESPONSE_BYTES: Int = 4 * 1024 * 1024

        /*
         * 三层超时，**必须严格递增**（内层永远先说话）：
         *
         *     建连 5s  <  读写 8s  <  整次调用 10s  <  Web 侧单次调用预算 15s
         *
         * 为什么不是"随便给三个数"：时间到了之后**谁先失败**，决定了界面上能看到什么。
         * 内层先到时，OkHttp 抛出的是具体原因（ConnectException / SocketTimeoutException /
         * UnknownHostException），经由下面的 catch 落成一条**带原因的日志** + 一个可重试的错误码；
         * 外层先到时，Web 侧只会给出 `bridge.timeout`，而桥侧那条日志**一行都不会打**
         * —— 排障就只能靠猜（第三轮用户复报时就是这个形状，见 docs/troubleshooting.md §二·补）。
         *
         * 旧值（`connect 5s / read 20s / write 20s`，且**没有整次调用的上限**）的问题正在这里：
         * 读超时比 Web 侧预算还大，等于后端这一层永远轮不到先失败。
         *
         * 改这三个数要同步改 `packages/bridge-client/src/transport.ts` 的
         * `BRIDGE_CALL_TIMEOUT_MS`，`tools/check/check-timeout-budget.mjs` 会跨语言对账。
         */
        const val CONNECT_TIMEOUT_MS = 5_000L
        const val IO_TIMEOUT_MS = 8_000L
        const val CALL_TIMEOUT_MS = 10_000L

        /**
         * 默认客户端。超时给得比较克制：作业现场的网络抖动多，
         * 但"卡住不返回"比"快速失败 + 重试按钮"更糟（UI 无反馈）。
         */
        fun defaultClient(): OkHttpClient = clientWith(CONNECT_TIMEOUT_MS, IO_TIMEOUT_MS, CALL_TIMEOUT_MS)

        /**
         * 按给定毫秒数装配客户端 —— 只给测试用（同一套装配代码，换一组数）。
         *
         * 为什么留这个口子：`callTimeout` 是**行为**而不是配置项，只有真跑一次才知道它在不在
         * （旧值漏掉的正是它）。拿生产值跑测试要等满 10 秒，所以测试用同一份装配代码、
         * 按比例缩小的一组数，把"**哪一层先失败**"这件事钉住。
         */
        internal fun clientWith(
            connectMs: Long,
            ioMs: Long,
            callMs: Long,
        ): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(connectMs, TimeUnit.MILLISECONDS)
                .readTimeout(ioMs, TimeUnit.MILLISECONDS)
                .writeTimeout(ioMs, TimeUnit.MILLISECONDS)
                .callTimeout(callMs, TimeUnit.MILLISECONDS)
                .build()
    }
}

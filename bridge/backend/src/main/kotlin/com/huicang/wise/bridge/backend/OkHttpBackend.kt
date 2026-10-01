package com.huicang.wise.bridge.backend

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

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

    override suspend fun call(call: BackendCall): BackendResult =
        withContext(Dispatchers.IO) {
            val path =
                PathTemplate.resolve(call.pathTemplate, call.params)
                    ?: return@withContext BackendResult.Failed(
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
                ?: return@withContext BackendResult.Failed(
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

            try {
                client.newCall(requestBuilder.build()).execute().use { response ->
                    val text = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        return@withContext failureFromStatus(response.code, text)
                    }
                    val unwrapped =
                        Envelope.unwrap(text)
                            ?: return@withContext BackendResult.Failed(
                                code = BackendErrorCodes.INTERNAL,
                                messageKey = "bridge.envelopeMalformed",
                                retryable = true,
                            )
                    val code = unwrapped.errorCode ?: unwrapped.code
                    if (unwrapped.code == Envelope.SUCCESS_CODE) {
                        BackendResult.Ok(unwrapped.data)
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

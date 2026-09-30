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
            val hasBody = call.httpMethod.uppercase() in setOf("POST", "PUT", "PATCH")

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
                if (hasBody) {
                    Envelope.wrap(call.packetType, call.requestId, rest, clock()).toRequestBody(JSON_MEDIA)
                } else {
                    null
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
                        BackendResult.Failed(code = code ?: BackendErrorCodes.INTERNAL, messageKey = null, retryable = false)
                    }
                }
            } catch (e: IOException) {
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
        return BackendResult.Failed(code = code, messageKey = messageKey, retryable = retryable)
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /**
         * 默认客户端。超时给得比较克制：作业现场的网络抖动多，
         * 但"卡住不返回"比"快速失败 + 重试按钮"更糟（UI 无反馈）。
         */
        fun defaultClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .writeTimeout(20, TimeUnit.SECONDS)
                .build()
    }
}

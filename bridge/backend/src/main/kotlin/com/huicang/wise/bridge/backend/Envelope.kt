package com.huicang.wise.bridge.backend

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * 统一请求信封（STD-CONTRACT-01 请求侧）。
 *
 * 形状与旧 APP 的 `core/network/Envelope.kt` **逐字一致**——这是"不改后端"的关键：
 * 服务端 `GlobalRequestAdvice` 解包后只把 `payload.data` 交给控制器，
 * 因此桥换掉客户端实现，对后端是完全透明的。
 *
 * ```
 * {"header":{"request_id":"…","packet_type":"AUTH_LOGIN","timestamp":0},
 *  "payload":{"code":"RES-0000","message":"请求","data":{ …原请求体… }}}
 * ```
 */
object Envelope {
    /** 请求侧业务码固定值（schema 要求 payload 必带 code/message）。 */
    const val REQUEST_CODE: String = "RES-0000"

    /** 请求侧提示信息。 */
    const val REQUEST_MESSAGE: String = "请求"

    /** 业务成功码（与旧仓 `ErrorCode.SUCCESS` 同值）。 */
    const val SUCCESS_CODE: String = "RES-0000"

    /** 链路标识 HTTP 头（STD-CONTRACT-01 规则 1）。 */
    const val REQUEST_ID_HEADER: String = "REQUEST-ID"

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    /** 把扁平业务 JSON 包成信封；`data` 为空对象时也照包（后端对空体是宽容的）。 */
    fun wrap(packetType: String, requestId: String, data: JsonObject, nowMillis: Long): String {
        val header =
            buildJsonObject {
                put("request_id", requestId)
                put("packet_type", packetType)
                put("timestamp", nowMillis)
            }
        val payload =
            buildJsonObject {
                put("code", REQUEST_CODE)
                put("message", REQUEST_MESSAGE)
                put("data", data)
            }
        return buildJsonObject {
            put("header", header)
            put("payload", payload)
        }.toString()
    }

    /** 解出的响应信封三要素。 */
    data class Unwrapped(
        val code: String?,
        val errorCode: String?,
        val message: String?,
        val data: kotlinx.serialization.json.JsonElement?,
    )

    /**
     * 解响应信封。`errorCode` 优先于 `code`——旧仓的 `ApiResponseHandler` 就是这个口径
     * （`payload.errorCode ?: payload.code`），保持一致能让错误码在两端可对照。
     */
    fun unwrap(body: String): Unwrapped? =
        runCatching {
            val root = json.parseToJsonElement(body)
            val payload = root.jsonObject["payload"]?.jsonObject ?: return@runCatching null
            Unwrapped(
                code = payload["code"]?.let { (it as? JsonPrimitive)?.contentOrNull },
                errorCode = payload["errorCode"]?.let { (it as? JsonPrimitive)?.contentOrNull },
                message = payload["message"]?.let { (it as? JsonPrimitive)?.contentOrNull },
                data = payload["data"],
            )
        }.getOrNull()
}

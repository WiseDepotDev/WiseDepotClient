package com.huicang.wise.bridge.backend

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** 一次后端调用（由桥根据契约表组装）。 */
data class BackendCall(
    val httpMethod: String,
    /** 路径模板，如 `/api/inventories/{inventoryId}`。 */
    val pathTemplate: String,
    val packetType: String,
    /** 方法参数；路径参数按**同名键**从这里取。 */
    val params: JsonObject?,
    val requestId: String,
    /**
     * 剩余参数（扣掉路径参数之后）的去向。
     *
     * 为什么需要它：服务端有 10 个 POST/PUT 端点用 `@RequestParam` 取值，
     * 而 `@RequestParam` **只认 query string / form body，不认 JSON body**。
     * 按 HTTP 方法一刀切（有 body 就塞 body）会让这些端点永远 400，
     * 界面上只表现为"点了没反应"。契约表为这些方法标 `QUERY`，
     * `OkHttpBackend` 据此拼 query 并**不发 body**。见 `bridge-overlay.json` 的 `queryParams`。
     */
    val paramStyle: ParamStyle = ParamStyle.BODY,
)

/** 剩余参数的去向。与契约生成物的 `ParamStyle` 同源。 */
enum class ParamStyle {
    /** 参数进 JSON 信封 body。 */
    BODY,

    /** 参数拼进 URL query string，且不发 body。 */
    QUERY,
}

/** 后端调用结果。**不抛异常**：所有失败都变成 `Failed`，让桥统一转成 err 帧。 */
sealed interface BackendResult {
    /** `data` 就是后端 `payload.data`，原样交给 Web。 */
    data class Ok(val data: JsonElement?) : BackendResult

    /**
     * @param code 后端业务码（原样透传）或桥/HTTP 层码，如 `HTTP-401`
     * @param messageKey i18n 键，**不下发文案**（延续旧仓"谁展示谁拥有"）
     * @param retryable UI 据此决定是否给"重试"按钮
     */
    data class Failed(
        val code: String,
        val messageKey: String?,
        val retryable: Boolean,
    ) : BackendResult
}

/** 会话令牌的存取。令牌**只活在桥进程内**，永不下发到 JS。 */
interface TokenStore {
    fun accessToken(): String?
    fun refreshToken(): String?
    fun update(access: String?, refresh: String?)
    fun clear()
}

/** 内存实现：W2 用它跑通链路；W3 换成加密落盘（桌面 DPAPI/KeyStore、手机 EncryptedSharedPreferences）。 */
class InMemoryTokenStore : TokenStore {
    @Volatile private var access: String? = null
    @Volatile private var refresh: String? = null

    override fun accessToken(): String? = access

    override fun refreshToken(): String? = refresh

    override fun update(access: String?, refresh: String?) {
        this.access = access
        this.refresh = refresh
    }

    override fun clear() {
        access = null
        refresh = null
    }
}

/** 后端访问端口。实现只有 OkHttp 一份，桌面与手机共用（这也是"单份桥"能成立的原因之一）。 */
interface BackendPort {
    suspend fun call(call: BackendCall): BackendResult
}

/** 桥层错误码（与 `BridgeErrorCodes` 对齐，但这里是后端侧用到的子集）。 */
object BackendErrorCodes {
    const val UNAUTHORIZED: String = "HTTP-401"
    const val FORBIDDEN: String = "HTTP-403"
    const val NOT_FOUND: String = "HTTP-404"
    const val PARAMS_INVALID: String = "BRIDGE_PARAMS_INVALID"
    const val UNREACHABLE: String = "BRIDGE_BACKEND_UNREACHABLE"
    const val INTERNAL: String = "BRIDGE_INTERNAL"
}

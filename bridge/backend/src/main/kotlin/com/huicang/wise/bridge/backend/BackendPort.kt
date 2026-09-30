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
    /**
     * body 里是否**保留路径参数**。
     *
     * 默认 false：同一个值没必要发两遍。为 true 的那几条是因为服务端 DTO 把路径参数
     * 又声明了一次并加了 `@NotNull`，而控制器里的 `request.setTaskId(taskId)` 在
     * 参数绑定**之后**才执行 —— 救不了 `@Valid`，客户端不放进 body 就必然校验失败。
     * 见 `bridge-overlay.json` 的 `bodyPathParams`。
     */
    val keepPathParamsInBody: Boolean = false,
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
        /**
         * 后端**业务拒绝原因**（原样透传的一句中/英文说明），进 err 帧的 `details`。
         *
         * 为什么需要它：桥只给码、文案由 Web 映射是既定原则，但有些拒绝只有服务端才知道原因
         * （实测："只能对已完成的巡检任务进行补录" 落在 `VAL-0001` 上，Web 无从映射）。
         * Web 侧映射不到时就把这句话显示出来，总好过让用户看到「取数失败（VAL-0001）」。
         *
         * **只允许业务码携带**（见 [BackendErrorCodes.DETAIL_ALLOWED_PREFIXES]）：
         * 5xx 的响应体可能含堆栈或 SQL 片段，一律不进 UI。
         */
        val details: String? = null,
    ) : BackendResult
}

/** 会话令牌的存取。令牌**只活在桥进程内**，永不下发到 JS。 */
interface TokenStore {
    /**
     * 凭据是否**跨进程重启**得以保留。
     *
     * 用途只有一个：宿主据此决定要不要声明 `storage.secure` 能力。
     * 内存实现返回 false —— "重启就得重新登录"不满足"安全存储"对用户的承诺，
     * 而声明了做不到的能力比不声明更糟（UI 会据此画出永远不工作的入口）。
     */
    val persistent: Boolean get() = false

    fun accessToken(): String?

    fun refreshToken(): String?

    fun update(access: String?, refresh: String?)

    fun clear()
}

/** 内存实现：测试与"拿不到平台密钥体系"时的兜底（重启后需要重新登录）。 */
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

    /**
     * **允许把后端原文带到界面上的错误码前缀**。
     *
     * 白名单而不是黑名单：5xx 的响应体可能含堆栈、SQL 片段或内部路径，
     * 默认不放行才安全；漏掉一个业务前缀的代价只是"少了一句解释"。
     */
    val DETAIL_ALLOWED_PREFIXES: List<String> = listOf("RES-", "VAL-", "AUTH-", "BIZ-")

    /** 详情截断长度：够放一句业务说明，放不下堆栈。 */
    const val DETAIL_MAX_CHARS: Int = 120

    /** 业务码才带详情；其余一律不带（见 [DETAIL_ALLOWED_PREFIXES]）。 */
    fun detailFor(
        code: String,
        message: String?,
    ): String? {
        val text = message?.trim().orEmpty()
        if (text.isEmpty()) {
            return null
        }
        if (DETAIL_ALLOWED_PREFIXES.none { code.startsWith(it) }) {
            return null
        }
        // 换行会让一句话变成多行，界面上的错误块按行排版，这里压平
        val flat = text.replace(Regex("\\s+"), " ")
        return if (flat.length <= DETAIL_MAX_CHARS) flat else flat.take(DETAIL_MAX_CHARS - 1) + "…"
    }
}

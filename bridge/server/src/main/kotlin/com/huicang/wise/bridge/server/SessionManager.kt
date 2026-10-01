package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendPort
import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.backend.TokenStore
import com.huicang.wise.bridge.protocol.BridgeContract
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 会话管理：**令牌截留**与自动续期。
 *
 * 这是整个方案里安全含义最重的一段代码。规则只有一条：
 *
 * > **令牌只允许存在于桥进程内。任何进出的 JSON 都会被扫一遍。**
 *
 * 做法不是"针对 auth.login 特判"（那样加一个新接口就漏），而是**按字段名递归剥离**：
 * 不管哪个方法、嵌套多深，只要出现 `accessToken` / `refreshToken`，一律取出存进
 * [TokenStore] 并从返回给 Web 的报文里删掉。这样"漏一个新接口"不会变成"漏一个令牌"。
 */
class SessionManager(
    private val tokens: TokenStore,
    private val backend: BackendPort,
    private val ver: String,
) {
    /** 令牌字段名（大小写不敏感）。新增字段只改这里。 */
    private val tokenKeys = setOf("accesstoken", "refreshtoken")

    @Volatile private var username: String? = null

    @Volatile private var passwordChangeRequired: Boolean = false

    /** 登录态失效（后端回 AUTH-* 且无法续期）。UI 据此跳登录。 */
    @Volatile private var expired: Boolean = false

    private val refreshMutex = Mutex()

    val authenticated: Boolean get() = tokens.accessToken() != null

    /** 供 err 帧与 UI 判断是否需要重新登录。 */
    val sessionExpired: Boolean get() = expired

    /**
     * 剥离令牌。
     *
     * @return 剥离后的数据（令牌位置变成 `null`，保持对象形状稳定，前端不需要处理缺字段）
     */
    fun scrub(data: JsonElement?): JsonElement? {
        val scrubbed = scrubValue(data) ?: return null
        // 顺手记录身份信息，供 bridge.session 使用（同样是"从响应里抽"而不是各方法特判）
        if (scrubbed is JsonObject) {
            (scrubbed["username"] as? JsonPrimitive)?.content?.let { username = it }
            (scrubbed["passwordChangeRequired"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()?.let {
                passwordChangeRequired = it
            }
        }
        return scrubbed
    }

    private fun scrubValue(value: JsonElement?): JsonElement? =
        when (value) {
            null -> null
            is JsonObject ->
                JsonObject(
                    value.mapNotNull { (k, v) ->
                        if (k.lowercase() in tokenKeys) {
                            val token = (v as? JsonPrimitive)?.content
                            if (token != null) {
                                if (k.equals("accessToken", true)) {
                                    tokens.update(token, tokens.refreshToken())
                                } else {
                                    tokens.update(tokens.accessToken(), token)
                                }
                            }
                            k to JsonNull
                        } else {
                            k to (scrubValue(v) ?: JsonNull)
                        }
                    }.toMap(),
                )

            is kotlinx.serialization.json.JsonArray -> kotlinx.serialization.json.JsonArray(value.map { scrubValue(it) ?: JsonNull })
            else -> value
        }

    /** `bridge.session` 的返回值：**只有身份，没有令牌**。 */
    fun sessionInfo(): JsonElement =
        JsonObject(
            mapOf(
                "authenticated" to JsonPrimitive(authenticated),
                "username" to (username?.let { JsonPrimitive(it) } ?: JsonNull),
                "passwordChangeRequired" to JsonPrimitive(passwordChangeRequired),
                "expired" to JsonPrimitive(expired),
                "hostVersion" to JsonPrimitive(ver),
            ),
        )

    fun clear() {
        tokens.clear()
        username = null
        passwordChangeRequired = false
    }

    /** 后端判定登录态失效：清令牌并置位，让 UI 能立刻跳登录而不是继续点。 */
    fun markExpired() {
        clear()
        expired = true
    }

    /**
     * 用 refreshToken 续期。
     *
     * 三条细节：
     * 1. **加锁**：并发请求同时发现令牌过期时只续一次（与旧仓 `AuthTokenRefresher` 同一意图）；
     * 2. 续期走的是契约里的**隐藏项** `auth.refreshToken` —— 它对 Web 不可见，
     *    因为这是桥的内部行为，不是 UI 能发起的能力；
     * 3. 续期成功返回 true，调用方据此**重放**原请求一次（且只重放一次）。
     */
    suspend fun refresh(): Boolean =
        refreshMutex.withLock {
            val refreshToken = tokens.refreshToken() ?: return@withLock false
            val route =
                BridgeContract.excluded.firstOrNull { it.id == REFRESH_METHOD_ID }
                    ?: return@withLock false

            val result =
                backend.call(
                    BackendCall(
                        httpMethod = route.httpMethod,
                        pathTemplate = route.path,
                        packetType = route.packetType,
                        params =
                            JsonObject(
                                mapOf("refreshToken" to JsonPrimitive(refreshToken)),
                            ),
                        requestId = "refresh-${System.currentTimeMillis()}",
                    ),
                )
            when (result) {
                is BackendResult.Ok -> {
                    scrub(result.data)
                    if (tokens.accessToken() != null) {
                        expired = false
                        true
                    } else {
                        markExpired()
                        false
                    }
                }

                is BackendResult.Failed -> {
                    markExpired()
                    false
                }
            }
        }

    companion object {
        /**
         * 刷新令牌的**方法 id**（契约里的隐藏项）。
         * 用字符串常量而不是直接索引：`excluded` 里找不到时会走到 `?: return false` 的安全分支。
         */
        const val REFRESH_METHOD_ID: String = "auth.refreshToken"

        /**
         * 会话失效的**事件主题**。
         *
         * 为什么需要它：失效发生时，界面正停在"已登录"的画面上，
         * 而 `bridge.session` 只在挂载时被问过一次 —— 没有推送，界面就永远不知道。
         *
         * 后果实测过（很隐蔽）：桥清掉令牌后，出站请求不再带 `Authorization`，
         * 而非白名单端点会先撞上后端的签名过滤器，回一个
         * **「缺少必要的签名参数」的 400**。那是个误导 —— 真正的原因是"没登录"，
         * 却把用户和排障一起指向"签名是不是配错了"。
         *
         * Web 侧对应的订阅在 `packages/features/src/session.ts`
         * （常量 `@wise/bridge-client` 的 `BRIDGE_EVENT_SESSION_EXPIRED`）。
         * 这是跨语言的线上契约串，改一边必须同时改另一边。
         */
        const val EVENT_SESSION_EXPIRED: String = "session.expired"

        /**
         * 登出类方法：**本地先行**。
         *
         * 为什么要这样：后端不可达时用户仍然必须能登出——否则一台离线设备会永远停在"已登录"。
         * 因此这几个方法无论后端结果如何，都会清掉桥内的会话；
         * 但**返回值仍如实反映后端结果**（服务端会话可能还活着，不能骗 UI）。
         */
        val LOGOUT_METHODS: Set<String> = setOf("auth.logout")

        /** 判断一个后端错误码是否意味着"该续期/该重新登录"。 */
        fun isAuthFailure(code: String): Boolean = code.startsWith("AUTH") || code == "HTTP-401"
    }
}

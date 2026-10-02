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
 * 续期请求的三种结局。
 *
 * **为什么不是布尔**：`false` 曾经同时表示"凭据被拒"和"网络不通"，
 * 而这两件事该做的事完全相反 —— 前者要清会话回登录屏，后者要保住会话。
 * 用一个值把差别丢掉，就会出现"网络抖一下就把用户踢出去"（本轮修掉的正是这条）。
 */
enum class RefreshOutcome {
    /** 续期成功：调用方重放原请求一次。 */
    REFRESHED,

    /** 后端明确拒绝：清会话 + 广播 `session.expired`。 */
    EXPIRED,

    /** 后端暂时答不上来（网络/超时）：**保留会话**，如实把失败交给调用方。 */
    UNAVAILABLE,
}

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

    /**
     * 剥离令牌。
     *
     * @param raw 后端这次响应的**原始文本**（`BackendResult.Ok.raw`）。给了就先用它做一次
     *   廉价预检：不含 `token` 字样的响应**直接原样返回**，省掉整棵 JSON 树的遍历与重建 ——
     *   列表类响应动辄几十 KB，而它们里本来就不可能有令牌字段。
     *   传 null（假后端、测试、老调用方）时退化为"总是深度扫一遍"：**正确性不受影响**，
     *   预检只用于"跳过"，从不改变剥离逻辑本身。
     * @return 剥离后的数据（令牌位置变成 `null`，保持对象形状稳定，前端不需要处理缺字段）
     */
    fun scrub(
        data: JsonElement?,
        raw: String? = null,
    ): JsonElement? {
        if (raw != null && !mightContainToken(raw)) {
            return data
        }
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

    /**
     * 响应文本里**可能**含令牌字段吗（大小写不敏感）。
     *
     * 判据故意宽（只找 `token` 这个词）：它的用途是"决定要不要做全量扫描"，
     * 漏判的后果是**少剥一个令牌**（不可接受），多判的代价只是多扫一次。
     * 于是这条预检只可能"多扫"，不可能"少扫"。
     */
    private fun mightContainToken(raw: String): Boolean = raw.contains("token", ignoreCase = true)

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
     * 四条细节：
     * 1. **加锁**：并发请求同时发现令牌过期时只续一次（与旧仓 `AuthTokenRefresher` 同一意图）；
     * 2. 续期走的是契约里的**隐藏项** `auth.refreshToken` —— 它对 Web 不可见，
     *    因为这是桥的内部行为，不是 UI 能发起的能力；
     * 3. 续期成功返回 [RefreshOutcome.REFRESHED]，调用方据此**重放**原请求一次（且只重放一次）。
     * 4. **失败要分两种**（这是本轮修掉的一个真 bug）：
     *    · 后端**明确拒绝**了这次的凭据（401 / `AUTH-*`）⇒ [RefreshOutcome.EXPIRED]：清令牌、置位、广播，
     *      界面该回登录屏；
     *    · 后端**根本没答上**（网络不可达/超时，`retryable=true`）⇒ [RefreshOutcome.UNAVAILABLE]：
     *      **绝不能当过期**。原先两者都走 `markExpired()`，于是家里网络抖一下、
     *      或"应用从后台回来"那一下，用户就被踢回登录屏 —— 明明什么都没做错。
     */
    suspend fun refresh(): RefreshOutcome =
        refreshMutex.withLock {
            val refreshToken = tokens.refreshToken() ?: return@withLock RefreshOutcome.EXPIRED
            val route =
                BridgeContract.excluded.firstOrNull { it.id == REFRESH_METHOD_ID }
                    ?: return@withLock RefreshOutcome.EXPIRED

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
                    scrub(result.data, result.raw)
                    if (tokens.accessToken() != null) {
                        expired = false
                        RefreshOutcome.REFRESHED
                    } else {
                        RefreshOutcome.EXPIRED
                    }
                }

                is BackendResult.Failed ->
                    // 只有"后端明确说凭据不行"才算过期；网络问题保留会话，让调用方按 retryable 处理
                    if (isAuthFailure(result.code)) {
                        RefreshOutcome.EXPIRED
                    } else {
                        BridgeLog.info(
                            "[bridge] 令牌续期没能完成（${result.code}${result.messageKey?.let { " / $it" } ?: ""}）：" +
                                "按「暂时不可用」处理，保留当前会话",
                        )
                        RefreshOutcome.UNAVAILABLE
                    }
            }
        }

    companion object {
        /**
         * 刷新令牌的**方法 id**（契约里的隐藏项）。
         * 用字符串常量而不是直接索引：`excluded` 里找不到时会走到安全分支。
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

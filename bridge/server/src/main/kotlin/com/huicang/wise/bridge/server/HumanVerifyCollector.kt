package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.capability.HumanVerifyPort
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest

/**
 * 人机验证的**桥侧执行器**：把"点一下"变成一次服务端可判定的验证。
 *
 * 它做四件事，顺序不能换：
 *
 * 1. **采集证据**：壳给的（[HumanVerifyPort]）＋ 页面给的（Web 传进来的 gesture/webview 片段）＋
 *    桥自己知道的（platform / version）。
 * 2. **申请挑战**：`human.challenge`。服务端按风险给出难度，或者要求"冷却后重试一次"。
 * 3. **算计算量证明**：在**硬超时**内找一个满足难度的 nonce；算不完就如实上报 `null`，
 *    由服务端降档再来 —— 不能因为算不完就卡住用户。
 * 4. **签名并提交**：`human.verify` → 拿到一次性票据。
 *
 * ## 票据不交给页面
 *
 * 票据与业务令牌同一待遇：**只留在桥里**，由桥在真正要用的那一次调用里注入
 * （见 [HumanTokenHolder.injectInto]）。理由与"业务令牌不进 JS 上下文"完全一样 ——
 * 页面一旦能拿到票据，一次 XSS 就能把它挪用去删用户。
 *
 * ## 本地证据不是结论
 *
 * [collectEvidence] 组装出来的东西全部是客户端可伪造的，服务端可以完全不采信。
 * 它的作用只有两个：让服务端把难度调高、给审计留线索。放行判据在服务端（见方案 §3）。
 */
class HumanVerifyCollector(
    private val dispatcher: suspend (method: String, params: JsonElement?, requestId: String) -> BackendResult,
    private val platform: PlatformPort,
    private val keys: DeviceKeyStore,
    private val shell: HumanVerifyPort? = null,
    private val tokens: HumanTokenHolder = HumanTokenHolder(),
    /** 计算量证明的时间预算：超了就上报 `null` 让服务端降档，而不是继续算。 */
    private val powBudgetMs: Long = POW_BUDGET_MS,
    private val log: (String) -> Unit = {},
) {
    /**
     * 走完一次人机验证。
     *
     * **返回值必须带原因**：`obtain` 内部的失败点有五种（申请不到挑战 / 冷却重试仍拿不到 /
     * 服务端明确拒绝 / 没算完 PoW / 应答缺字段），它们的**出路完全不同** ——
     * "后端不是最新版"要去重新部署，"设备签名校验失败"要去查签名原文，"账号已锁定"要等窗口。
     * 曾经这些全部被折叠成一个 `BRIDGE_BACKEND_UNREACHABLE` + "请再试一次"，
     * 于是**唯一正确的处置动作被藏掉了**（见 `Outcome` 的注释）。
     *
     * @param purpose `LOGIN` / `TAG_BATCH_BIND` / `USER_DELETE`（与服务端 `HumanPurpose` 同名）
     * @param username 登录用途下的账号（服务端据此查失败次数）
     * @param pageEvidence 页面侧证据片段（可空）
     */
    suspend fun obtain(
        purpose: String,
        username: String? = null,
        pageEvidence: JsonObject? = null,
    ): Outcome {
        val evidence = collectEvidence(pageEvidence)
        val first = challenge(purpose, username, evidence)
        var challenge = first.data
        if (challenge == null) {
            // 申请不到挑战：把**后端自己的答复**带上（HTTP-400 / HTTP-404 / 后端不可达 是三种活）
            return Outcome(
                ok = false,
                code = first.code ?: BridgeErrorCodes.BACKEND_UNREACHABLE,
                messageKey = KEY_CHALLENGE_FAILED,
                retryable = first.retryable,
                detail = "申请挑战失败：${first.code ?: "无错误码"}",
            )
        }

        // 服务端要求"冷却后重试一次"：这是**机会**不是惩罚（图形码已删，人必须还有路可过）
        if (challenge["action"]?.jsonPrimitive?.contentOrNull == ACTION_COOLDOWN) {
            val waitMs = challenge["retryAfterMs"]?.jsonPrimitive?.intOrNull ?: 0
            log("[bridge] 人机验证要求冷却 ${waitMs}ms 后重试一次")
            delay(waitMs.coerceIn(0, MAX_COOLDOWN_MS).toLong())
            // 用同一份证据重新申请：难度由服务端按当时的风险重新判定
            val second = challenge(purpose, username, evidence)
            challenge = second.data
            if (challenge == null) {
                return Outcome(
                    ok = false,
                    code = second.code ?: BridgeErrorCodes.BACKEND_UNREACHABLE,
                    messageKey = KEY_CHALLENGE_FAILED,
                    // 冷却后再失败：本次已经等过了，直接重试多半还是"锁定/封禁"，所以不标可重试
                    retryable = false,
                    detail = "冷却重试时仍拿不到挑战：${second.code ?: "无错误码"}",
                )
            }
        }

        var outcome = submit(challenge, purpose, evidence)
        /*
         * 计算量证明没算完 ⇒ **再走一次**。
         *
         * 这条重试是"降档"能生效的另一半：服务端在拒绝时已经给同一个 IP 记了降档标记
         * （R8），下一次挑战因此回到低档；桥这边必须真的再申请一次，否则那个标记永远不会被用掉，
         * 用户看到的就是"点了没反应 / 一直过不去"。
         *
         * 只用一次机会：第二次再失败就如实上报，绝不进循环。
         */
        if (outcome is SubmitOutcome.PowInsufficient) {
            log("[bridge] 计算量证明未完成，按服务端降档再试一次")
            val retry = challenge(purpose, username, evidence)
            val retryChallenge = retry.data
            if (retryChallenge == null) {
                return Outcome(
                    ok = false,
                    code = retry.code ?: BridgeErrorCodes.BACKEND_UNREACHABLE,
                    messageKey = KEY_CHALLENGE_FAILED,
                    retryable = retry.retryable,
                    detail = "降档重试时拿不到挑战：${retry.code ?: "无错误码"}",
                )
            }
            outcome = submit(retryChallenge, purpose, evidence)
        }
        return when (outcome) {
            is SubmitOutcome.Ok ->
                Outcome(ok = true, code = null, messageKey = null, retryable = false, detail = "purpose=$purpose")
            is SubmitOutcome.Rejected ->
                Outcome(
                    ok = false,
                    // **服务端的错误码原样上抛**：界面才能说清是"设备签名校验失败"还是"账号已锁定"
                    code = outcome.code,
                    messageKey = KEY_REJECTED,
                    retryable = false,
                    detail = "服务端拒绝：${outcome.code}",
                )
            is SubmitOutcome.Local ->
                Outcome(ok = false, code = BridgeErrorCodes.INTERNAL, messageKey = KEY_FAILED, retryable = false, detail = outcome.reason)
            // 降过档、再提交一次**仍然**没算完：这次如实上报服务端的码，不再重试（绝不进循环）
            is SubmitOutcome.PowInsufficient ->
                Outcome(
                    ok = false,
                    code = POW_INSUFFICIENT_CODE,
                    messageKey = KEY_REJECTED,
                    retryable = false,
                    detail = "降档重试后仍未算出计算量证明",
                )
        }
    }

    /**
     * 一次人机验证的结果。
     *
     * `code` 优先用**服务端自己的错误码**（`AUTH-HUMAN-xxxx`）而不是桥自造的：那些码是
     * 契约的一部分，界面/排障文档都按它们写（见 `docs/troubleshooting.md` 第九章）。
     */
    data class Outcome(
        val ok: Boolean,
        val code: String?,
        val messageKey: String?,
        val retryable: Boolean,
        val detail: String,
    )

    // ---------------------------------------------------------------- 四步

    /** 证据：壳 + 页面 + 桥自己。**只写知道的字段**（写 false 与"不知道"是两件事）。 */
    suspend fun collectEvidence(pageEvidence: JsonObject?): JsonObject {
        val shellEvidence = runCatching { shell?.environmentEvidence() }.getOrNull() ?: JsonObject(emptyMap())
        return buildJsonObject {
            put("version", JsonPrimitive(EVIDENCE_VERSION))
            put("platform", JsonPrimitive(platform.platform))
            put("clientVersion", JsonPrimitive(platform.version))
            // 壳的片段优先（它读的是进程/包级别的事实，页面伪造不了）
            shellEvidence.forEach { (key, value) -> put(key, value) }
            pageEvidence?.forEach { (key, value) -> if (key !in shellEvidence) put(key, value) }
        }
    }

    /**
     * 申请挑战。
     *
     * 返回 `ChallengeAttempt` 而不是 `JsonObject?`：**"为什么没拿到"必须能一路传到界面**。
     * 后端不可达（`BRIDGE_BACKEND_UNREACHABLE`）与后端答了 400（`HTTP-400`）是两件完全不同的事，
     * 而 400 里还分"没有这个接口（后端不是最新版）"与"签名/参数被拒"。
     */
    private suspend fun challenge(
        purpose: String,
        username: String?,
        evidence: JsonObject,
    ): ChallengeAttempt {
        val params =
            buildJsonObject {
                put("purpose", JsonPrimitive(purpose))
                username?.let { put("username", JsonPrimitive(it)) }
                put("platform", JsonPrimitive(platform.platform))
                put("clientVersion", JsonPrimitive(platform.version))
                put("evidence", evidence)
            }
        return when (val result = dispatcher(CHALLENGE_METHOD, params, "human-challenge")) {
            is BackendResult.Ok -> {
                val data = result.data as? JsonObject
                if (data == null) {
                    log("[bridge] 挑战应答不是对象，无法解析")
                    ChallengeAttempt(null, BridgeErrorCodes.INTERNAL, false)
                } else {
                    ChallengeAttempt(data, null, false)
                }
            }
            is BackendResult.Failed -> {
                log("[bridge] 申请人机验证挑战失败：${result.code}")
                ChallengeAttempt(null, result.code, result.retryable)
            }
        }
    }

    /** 一次"申请挑战"的结果：要么拿到挑战，要么带上**后端的原错误码**。 */
    private data class ChallengeAttempt(
        val data: JsonObject?,
        val code: String?,
        val retryable: Boolean,
    )

    private suspend fun submit(
        challenge: JsonObject,
        purpose: String,
        evidence: JsonObject,
    ): SubmitOutcome {
        val challengeId = challenge["challengeId"]?.jsonPrimitive?.contentOrNull ?: return SubmitOutcome.Local("挑战缺 challengeId")
        val difficulty = challenge["difficultyBits"]?.jsonPrimitive?.intOrNull ?: 0
        val nonce = solveProofOfWork(challengeId, difficulty)
        if (difficulty > 0 && nonce == null) {
            // 算不完也要**如实**提交一次：服务端据此记下降档标记（R8），下一次挑战回到低档。
            // 直接报失败是不对的 —— 那是把"这台机器慢"变成"这个人过不去"。
            log("[bridge] ${powBudgetMs}ms 内没算出 $difficulty 位的计算量证明，如实上报等降档")
        }

        val signedText = keys.signedText(challengeId, purpose, nonce)
        val params =
            buildJsonObject {
                put("challengeId", JsonPrimitive(challengeId))
                put("purpose", JsonPrimitive(purpose))
                put("evidence", evidence)
                put("powNonce", nonce?.let { JsonPrimitive(it) } ?: JsonNull)
                put("deviceKeyId", JsonPrimitive(keys.keyId))
                put("devicePublicKey", JsonPrimitive(keys.publicKeyHex))
                put("signature", JsonPrimitive(keys.sign(signedText)))
                put("clientTime", JsonPrimitive(System.currentTimeMillis()))
            }
        return when (val result = dispatcher(VERIFY_METHOD, params, "human-verify")) {
            is BackendResult.Ok -> {
                val token = (result.data as? JsonObject)?.get("humanToken")?.jsonPrimitive?.contentOrNull
                val expires = (result.data as? JsonObject)?.get("expiresIn")?.jsonPrimitive?.intOrNull ?: 120
                if (token.isNullOrBlank()) {
                    SubmitOutcome.Local("验证应答里没有 humanToken")
                } else {
                    tokens.put(purpose, token, expires)
                    log("[bridge] 人机验证通过（purpose=$purpose，票据有效期 ${expires}s）")
                    SubmitOutcome.Ok
                }
            }
            is BackendResult.Failed -> {
                log("[bridge] 人机验证未通过：${result.code}")
                if (result.code == POW_INSUFFICIENT_CODE) {
                    SubmitOutcome.PowInsufficient
                } else {
                    SubmitOutcome.Rejected(result.code)
                }
            }
        }
    }

    /**
     * 找 nonce：`SHA-256(challengeId|nonce|keys.keyId)` 需命中 `bits` 个前导零 bit。
     *
     * **必须在预算内返回**：超时返回 `null` 是正常路径（服务端会降档），
     * 不是错误 —— 低端机上 22 位要算几百万次哈希，硬扛只会让用户以为卡死了。
     */
    fun solveProofOfWork(
        challengeId: String,
        bits: Int,
    ): String? {
        if (bits <= 0) {
            return "0"
        }
        val deadline = System.nanoTime() + powBudgetMs * 1_000_000
        var counter = 0L
        while (System.nanoTime() < deadline) {
            val nonce = counter.toString(36)
            val digest = sha256("$challengeId|$nonce|${keys.keyId}")
            if (leadingZeroBits(digest) >= bits) {
                return nonce
            }
            counter += 1
        }
        return null
    }

    private fun fail(reason: String): Boolean {
        log("[bridge] $reason")
        return false
    }
    /**
     * 提交的结果。**必须区分三种**：
     *   · 成功；
     *   · "算不完" —— 要按服务端的降档标记再试一次（R8）；
     *   · 服务端**明确拒绝** —— 重试只会重复同一次拒绝（还可能把"密码错"刷成限流），
     *     而且它的错误码要原样上抛给界面；
     *   · 本地就失败了（应答缺字段等）—— 与后端无关。
     */
    private sealed interface SubmitOutcome {
        data object Ok : SubmitOutcome

        data object PowInsufficient : SubmitOutcome

        data class Rejected(val code: String?) : SubmitOutcome

        data class Local(val reason: String) : SubmitOutcome
    }

    private fun sha256(text: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))

    private fun leadingZeroBits(bytes: ByteArray): Int {
        var bits = 0
        for (byte in bytes) {
            if (byte.toInt() == 0) {
                bits += 8
                continue
            }
            return bits + Integer.numberOfLeadingZeros(byte.toInt() and 0xFF) - 24
        }
        return bits
    }

    companion object {
        /** 服务端 `HumanVerifyApplicationService` 的两个方法 id。 */
        const val CHALLENGE_METHOD: String = "human.challenge"

        const val VERIFY_METHOD: String = "human.verify"

        const val ACTION_COOLDOWN: String = "cooldown"

        /**
         * "拿不到挑战" —— 后端不可达、后端不是最新版（没有这两个接口）、或参数/签名被拒。
         *
         * 与 `KEY_REJECTED` 分开：这一类的出路是**修环境**（重启/重新部署后端），
         * 而"服务端拒绝了这次验证"的出路是查设备签名或等锁定窗口。
         */
        const val KEY_CHALLENGE_FAILED: String = "bridge.humanVerifyChallengeFailed"

        /** "服务端明确拒绝了这次验证" —— `code` 里带的是服务端自己的 `AUTH-HUMAN-xxxx`。 */
        const val KEY_REJECTED: String = "bridge.humanVerifyRejected"

        /** 桥自己这侧没走完（应答缺字段等）。 */
        const val KEY_FAILED: String = "bridge.humanVerifyFailed"

        /**
         * 服务端 `ErrorCode.HUMAN_POW_INSUFFICIENT` 的线上码。
         *
         * 桥必须认得它，才能把"这台机器算不完"与"验证没过"区分开：前者要按降档再试一次，
         * 后者重试是白费（还可能把密码错刷成限流）。
         */
        const val POW_INSUFFICIENT_CODE: String = "AUTH-HUMAN-1007"

        /** 计算量证明的时间预算（服务端按 400ms 设计，两边不要各写一个数）。 */
        const val POW_BUDGET_MS: Long = 400

        /** 冷却等待的上限：服务端说了算，但客户端不能被一个坏值卡住界面。 */
        const val MAX_COOLDOWN_MS: Int = 10_000

        /** 证据结构版本；服务端 `HumanEvidence.version` 对齐。 */
        private const val EVIDENCE_VERSION = 1
    }
}

/**
 * 人机验证票据的持有者：**票据不进 JS 上下文**，由桥在需要的那一次调用里注入。
 *
 * 三个业务方法（登录 / 批量绑定 / 删除用户）各要一个**对应用途**的票据；
 * 用途不符一律不注入 —— 否则一次登录验证就能被拿去删用户。
 */
class HumanTokenHolder {
    private data class Entry(
        val purpose: String,
        val token: String,
        val expiresAt: Long,
    )

    private var entry: Entry? = null

    fun put(
        purpose: String,
        token: String,
        expiresInSeconds: Int,
    ) {
        entry = Entry(purpose, token, System.currentTimeMillis() + expiresInSeconds * 1000L)
    }

    /** 票据是否可用于该用途（过期即视为没有；过期的票据不许被"凑合用"）。 */
    fun has(purpose: String): Boolean {
        val current = entry ?: return false
        return current.purpose == purpose && current.expiresAt > System.currentTimeMillis()
    }

    fun clear() {
        entry = null
    }

    /**
     * 给一次业务调用的参数注入 `humanToken`。
     *
     * - 用途不符 / 没有票据 / 已过期 ⇒ **原样返回**（让服务端去拒绝，客户端不"猜"）；
     * - 调用方已经自己带了 `humanToken` ⇒ 不覆盖。
     */
    fun injectInto(
        params: JsonElement?,
        purpose: String,
    ): JsonElement? {
        val current = entry ?: return params
        if (current.purpose != purpose || current.expiresAt <= System.currentTimeMillis()) {
            return params
        }
        val base = params as? JsonObject ?: JsonObject(emptyMap())
        if (base.containsKey("humanToken")) {
            return base
        }
        return JsonObject(base.toMutableMap().apply { put("humanToken", JsonPrimitive(current.token)) })
    }
}

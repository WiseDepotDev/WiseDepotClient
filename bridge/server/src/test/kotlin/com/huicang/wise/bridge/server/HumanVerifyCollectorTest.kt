package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.backend.SecretCodec
import com.huicang.wise.bridge.capability.HumanVerifyPort
import com.huicang.wise.bridge.capability.PlatformPort
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger

/**
 * [HumanVerifyCollector] 与 [DeviceKeyStore] 的可执行证据。
 *
 * 这里钉住的四件事，任何一条错了表现都是"线上偶发验证不过"，而那种错误最难查：
 *
 * 1. **签名能被独立验证**（用 JCA 从公钥复算，不复用桥自己的代码）；
 * 2. **指纹 = 公钥哈希**（服务端会重算并比对，不一致就是 400）；
 * 3. **计算量证明真的达标**（独立实现一遍前导零 bit 的判定）；
 * 4. **算不完时如实上报 `null`**，而不是"因为算不完所以放行/卡死"。
 */
class HumanVerifyCollectorTest {
    private val platform =
        object : PlatformPort {
            override val platform: String = "desktop"
            override val version: String = "9.9.9-test"
            override val capabilities: Set<String> = emptySet()
        }

    /** 计算量证明的"难度很低"档：测试不该为了验逻辑跑几百万次哈希。 */
    private val easyBits = 8

    private fun collector(
        keys: DeviceKeyStore = DeviceKeyStore(),
        shell: HumanVerifyPort? = null,
        answer: (String, JsonObject) -> BackendResult,
    ): HumanVerifyCollector {
        val collectorRef = arrayOfNulls<HumanVerifyCollector>(1)
        val result =
            HumanVerifyCollector(
                dispatcher = { method, params, _ ->
                    answer(method, (params as? JsonObject) ?: JsonObject(emptyMap()))
                },
                platform = platform,
                keys = keys,
                shell = shell,
                powBudgetMs = 2_000,
                log = {},
            )
        collectorRef[0] = result
        return result
    }

    /** 一个"真后端"的最小替身：挑战给低难度，验证时**真的**校验签名与 PoW。 */
    private fun realishBackend(keys: DeviceKeyStore): Pair<AtomicInteger, (String, JsonObject) -> BackendResult> {
        val verifyCalls = AtomicInteger()
        val answer = { method: String, params: JsonObject ->
            when (method) {
                HumanVerifyCollector.CHALLENGE_METHOD ->
                    BackendResult.Ok(
                        buildJsonObject {
                            put("challengeId", JsonPrimitive("ch-1"))
                            put("action", JsonPrimitive("verify"))
                            put("difficultyBits", JsonPrimitive(easyBits))
                        },
                    )
                else -> {
                    verifyCalls.incrementAndGet()
                    val challengeId = params["challengeId"]!!.jsonPrimitive.content
                    val nonce = params["powNonce"]?.jsonPrimitive?.content
                    val keyId = params["deviceKeyId"]!!.jsonPrimitive.content
                    val signature = params["signature"]!!.jsonPrimitive.content
                    val signedText = "$challengeId|LOGIN|${nonce ?: ""}|$keyId"
                    val ok = nonce != null && verifySignature(keys, signedText, signature) && powOk(challengeId, nonce, keyId)
                    if (ok) {
                        BackendResult.Ok(
                            buildJsonObject {
                                put("humanToken", JsonPrimitive("tok-1"))
                                put("expiresIn", JsonPrimitive(120))
                            },
                        )
                    } else {
                        BackendResult.Failed("AUTH-HUMAN-1006", "bridge.humanSignatureInvalid", retryable = false)
                    }
                }
            }
        }
        return verifyCalls to answer
    }

    // ---------------------------------------------------------------- 密钥

    @Test
    fun `指纹必须是公钥的哈希前缀`() {
        val keys = DeviceKeyStore()
        val expected =
            MessageDigest
                .getInstance("SHA-256")
                .digest(hexToBytes(keys.publicKeyHex))
                .joinToString("") { "%02x".format(it) }
                .substring(0, 32)

        assertEquals(expected, keys.keyId)
        assertEquals(130, keys.publicKeyHex.length)
        assertTrue(keys.publicKeyHex.startsWith("04"))
    }

    @Test
    fun `签名能被独立验证，篡改原文则验不过`() {
        val keys = DeviceKeyStore()
        val text = keys.signedText("ch-1", "LOGIN", "n1")

        assertTrue(verifySignature(keys, text, keys.sign(text)), "正常原文必须验得过")
        assertFalse(verifySignature(keys, text, keys.sign(text + "x")), "签名与原文不匹配时必须失败")
        assertFalse(verifySignature(keys, text + "x", keys.sign(text)), "原文被改也必须失败")
    }

    @Test
    fun `落盘后重启还是同一把钥匙（加密封存可解）`() {
        val dir = Files.createTempDirectory("wise-device-key")
        val file = dir.resolve("device-key.enc")
        val codec = PlainTestCodec()

        val first = DeviceKeyStore(file, codec)
        val second = DeviceKeyStore(file, codec)

        assertEquals(first.keyId, second.keyId)
        assertEquals(first.publicKeyHex, second.publicKeyHex)
        Files.deleteIfExists(file)
        Files.deleteIfExists(dir)
    }

    @Test
    fun `拿不到平台密钥体系时退回内存（不写明文文件）`() {
        val dir = Files.createTempDirectory("wise-device-key-plain")
        val file = dir.resolve("device-key.enc")

        val first = DeviceKeyStore(file, codec = null)
        val second = DeviceKeyStore(file, codec = null)

        assertFalse(Files.exists(file), "没有 codec 时绝不允许写出文件")
        assertTrue(first.keyId != second.keyId, "退回内存时重启换一把（代价是设备识别退化，这是接受的行为）")
        Files.deleteIfExists(dir)
    }

    // ---------------------------------------------------------------- 计算量证明

    @Test
    fun `计算量证明真的满足难度（用独立实现判定）`() {
        val keys = DeviceKeyStore()
        val collector = collector(keys) { _, _ -> BackendResult.Ok(JsonObject(emptyMap())) }

        val nonce = collector.solveProofOfWork("ch-1", easyBits)

        assertNotNull(nonce)
        assertTrue(powOk("ch-1", nonce!!, keys.keyId), "算出来的 nonce 必须真的达标")
    }

    @Test
    fun `难度为 0 时不做计算量证明`() {
        val collector = collector { _, _ -> BackendResult.Ok(JsonObject(emptyMap())) }

        assertEquals("0", collector.solveProofOfWork("ch-1", 0))
    }

    @Test
    fun `难度高到算不完时返回 null（不许假装算出来了）`() {
        val collector =
            HumanVerifyCollector(
                dispatcher = { _, _, _ -> BackendResult.Ok(JsonObject(emptyMap())) },
                platform = platform,
                keys = DeviceKeyStore(),
                powBudgetMs = 30,
            )

        // 40 位前导零：30ms 内不可能算出来（期望 2^40 次哈希）
        assertNull(collector.solveProofOfWork("ch-1", 40))
    }

    @Test
    fun `算不完也照常提交（让服务端降档，而不是把慢机器判成过不去）`() = runBlocking {
        val keys = DeviceKeyStore()
        val seen = mutableListOf<JsonObject>()
        val collector =
            HumanVerifyCollector(
                dispatcher = { method, params, _ ->
                    val body = (params as? JsonObject) ?: JsonObject(emptyMap())
                    seen.add(body)
                    when (method) {
                        HumanVerifyCollector.CHALLENGE_METHOD ->
                            BackendResult.Ok(
                                buildJsonObject {
                                    put("challengeId", JsonPrimitive("ch-1"))
                                    put("action", JsonPrimitive("verify"))
                                    put("difficultyBits", JsonPrimitive(40))
                                },
                            )
                        else ->
                            BackendResult.Ok(
                                buildJsonObject {
                                    put("humanToken", JsonPrimitive("tok"))
                                    put("expiresIn", JsonPrimitive(120))
                                },
                            )
                    }
                },
                platform = platform,
                keys = keys,
                powBudgetMs = 20,
            )

        assertTrue(collector.obtain("LOGIN", "u1").ok)
        val verifyBody = seen.last()
        assertEquals(
            kotlinx.serialization.json.JsonNull,
            verifyBody["powNonce"],
            "算不完时必须上报 null，服务端据此降档",
        )
        assertNotNull(verifyBody["signature"])
    }

    // ---------------------------------------------------------------- 证据与流程

    @Test
    fun `证据包含壳的片段，且壳的字段优先于页面（页面伪造不了壳的事实）`() {
        val shell =
            object : HumanVerifyPort {
                override suspend fun environmentEvidence(): JsonObject =
                    buildJsonObject {
                        put("shellPackaged", JsonPrimitive(true))
                        put("headless", JsonPrimitive(false))
                    }
            }
        val collector = collector(shell = shell) { _, _ -> BackendResult.Ok(JsonObject(emptyMap())) }
        val page =
            buildJsonObject {
                put("webdriver", JsonPrimitive(false))
                put("gestureSamples", JsonPrimitive(37))
                put("headless", JsonPrimitive(true))
            }

        val evidence = runBlocking { collector.collectEvidence(page) }

        assertEquals("desktop", evidence["platform"]!!.jsonPrimitive.content)
        assertEquals(true, evidence["shellPackaged"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(37, evidence["gestureSamples"]!!.jsonPrimitive.content.toInt())
        assertEquals(
            "false",
            evidence["headless"]!!.jsonPrimitive.content,
            "壳说 false 时页面说 true 不算数",
        )
    }

    @Test
    fun `壳拿不出证据时不影响验证流程（证据是输入，不是前置条件）`() {
        val shell =
            object : HumanVerifyPort {
                override suspend fun environmentEvidence(): JsonObject = throw IllegalStateException("壳还没就绪")
            }
        val keys = DeviceKeyStore()
        val (_, answer) = realishBackend(keys)
        val collector = collector(keys = keys, shell = shell, answer = answer)

        assertTrue(runBlocking { collector.obtain("LOGIN", "u1") }.ok)
    }

    @Test
    fun `正常路径：挑战 → 计算量证明 → 签名 → 拿到票据`() {
        val keys = DeviceKeyStore()
        val (verifyCalls, answer) = realishBackend(keys)
        val collector = collector(keys = keys, answer = answer)

        val ok = runBlocking { collector.obtain("LOGIN", "u1") }.ok

        assertTrue(ok)
        assertEquals(1, verifyCalls.get())
    }

    @Test
    fun `冷却动作会等待后重试一次（第二次成功即通过）`() = runBlocking {
        val keys = DeviceKeyStore()
        val challengeCalls = AtomicInteger()
        val collector =
            HumanVerifyCollector(
                dispatcher = { method, params, _ ->
                    when (method) {
                        HumanVerifyCollector.CHALLENGE_METHOD -> {
                            val nth = challengeCalls.incrementAndGet()
                            if (nth == 1) {
                                BackendResult.Ok(
                                    buildJsonObject {
                                        put("challengeId", JsonPrimitive("ch-1"))
                                        put("action", JsonPrimitive("cooldown"))
                                        put("retryAfterMs", JsonPrimitive(20))
                                        put("difficultyBits", JsonPrimitive(22))
                                    },
                                )
                            } else {
                                BackendResult.Ok(
                                    buildJsonObject {
                                        put("challengeId", JsonPrimitive("ch-2"))
                                        put("action", JsonPrimitive("verify"))
                                        put("difficultyBits", JsonPrimitive(0))
                                    },
                                )
                            }
                        }
                        else -> {
                            // 校验第二次的挑战 id 与签名原文一致（不是拿第一次的挑战去签）
                            val body = params as JsonObject
                            assertEquals("ch-2", body["challengeId"]!!.jsonPrimitive.content)
                            BackendResult.Ok(
                                buildJsonObject {
                                    put("humanToken", JsonPrimitive("tok-2"))
                                    put("expiresIn", JsonPrimitive(120))
                                },
                            )
                        }
                    }
                },
                platform = platform,
                keys = keys,
                powBudgetMs = 200,
                log = {},
            )

        assertTrue(collector.obtain("LOGIN", "u1").ok)
        assertEquals(2, challengeCalls.get(), "冷却后必须重新申请挑战（难度由服务端重新判定）")
    }

    @Test
    fun `服务端说计算量证明不达标 ⇒ 重新申请挑战（拿降档难度）再提交一次`() = runBlocking {
        val keys = DeviceKeyStore()
        val challengeCalls = AtomicInteger()
        val verifyCalls = AtomicInteger()
        val collector =
            HumanVerifyCollector(
                dispatcher = { method, params, _ ->
                    when (method) {
                        HumanVerifyCollector.CHALLENGE_METHOD -> {
                            // 第一次是"坏环境 ⇒ 22 bit"（慢机器必然算不完），
                            // 服务端据此给同一个 IP 记了降档标记，第二次就该是 12 bit
                            val nth = challengeCalls.incrementAndGet()
                            BackendResult.Ok(
                                buildJsonObject {
                                    put("challengeId", JsonPrimitive("ch-$nth"))
                                    put("action", JsonPrimitive("verify"))
                                    put("difficultyBits", JsonPrimitive(if (nth == 1) 40 else 12))
                                },
                            )
                        }
                        else -> {
                            verifyCalls.incrementAndGet()
                            if (verifyCalls.get() == 1) {
                                BackendResult.Failed(
                                    HumanVerifyCollector.POW_INSUFFICIENT_CODE,
                                    "bridge.humanPowInsufficient",
                                    retryable = false,
                                )
                            } else {
                                BackendResult.Ok(
                                    buildJsonObject {
                                        put("humanToken", JsonPrimitive("tok-2"))
                                        put("expiresIn", JsonPrimitive(120))
                                    },
                                )
                            }
                        }
                    }
                },
                platform = platform,
                keys = keys,
                powBudgetMs = 20,
                log = {},
            )

        assertTrue(collector.obtain("LOGIN", "u1").ok, "降档后必须能过：否则慢机器上的用户永远进不来")
        assertEquals(2, challengeCalls.get(), "必须重新申请挑战 —— 服务端的降档标记只在**下一次挑战**上生效")
        assertEquals(2, verifyCalls.get())
    }

    @Test
    fun `别的失败不会被重试（免得把密码错刷成限流）`() = runBlocking {
        val keys = DeviceKeyStore()
        val challengeCalls = AtomicInteger()
        val verifyCalls = AtomicInteger()
        val collector =
            HumanVerifyCollector(
                dispatcher = { method, _, _ ->
                    if (method == HumanVerifyCollector.CHALLENGE_METHOD) {
                        challengeCalls.incrementAndGet()
                        BackendResult.Ok(
                            buildJsonObject {
                                put("challengeId", JsonPrimitive("ch-1"))
                                put("action", JsonPrimitive("verify"))
                                put("difficultyBits", JsonPrimitive(12))
                            },
                        )
                    } else {
                        verifyCalls.incrementAndGet()
                        BackendResult.Failed("AUTH-HUMAN-1006", "bridge.humanSignatureInvalid", retryable = false)
                    }
                },
                platform = platform,
                keys = keys,
                powBudgetMs = 200,
                log = {},
            )

        assertFalse(collector.obtain("LOGIN", "u1").ok)
        assertEquals(1, challengeCalls.get(), "签名不对外加重试没有意义")
        assertEquals(1, verifyCalls.get())
    }

    @Test
    fun `服务端拒绝时把它的错误码原样上抛（不许折叠成一个「请再试一次」）`() = runBlocking {
        val keys = DeviceKeyStore()
        val collector =
            HumanVerifyCollector(
                dispatcher = { method, _, _ ->
                    if (method == HumanVerifyCollector.CHALLENGE_METHOD) {
                        BackendResult.Ok(
                            buildJsonObject {
                                put("challengeId", JsonPrimitive("ch-1"))
                                put("action", JsonPrimitive("verify"))
                                put("difficultyBits", JsonPrimitive(12))
                            },
                        )
                    } else {
                        BackendResult.Failed("AUTH-HUMAN-1006", "bridge.humanSignatureInvalid", retryable = false)
                    }
                },
                platform = platform,
                keys = keys,
                powBudgetMs = 200,
                log = {},
            )

        val outcome = collector.obtain("LOGIN", "u1")

        assertFalse(outcome.ok)
        // 这条断言就是"界面能不能说清问题"的全部：`AUTH-HUMAN-1006` 指向"查签名原文"，
        // 而 `BRIDGE_BACKEND_UNREACHABLE` 指向"去查后端活没活" —— 两者的处置动作完全相反。
        assertEquals("AUTH-HUMAN-1006", outcome.code, "服务端的错误码必须原样上抛")
        assertEquals(HumanVerifyCollector.KEY_REJECTED, outcome.messageKey)
        assertFalse(outcome.retryable, "设备签名不对外再加可重试标记只会让人白点")
    }

    @Test
    fun `后端不是最新版（申请挑战就 400）⇒ 带上 HTTP-400，而不是「不可达」`() = runBlocking {
        val keys = DeviceKeyStore()
        val collector =
            HumanVerifyCollector(
                // 2026-10-05 实测：未部署新代码的后端对 /api/human/challenge 回
                // 400 缺少必要的签名参数（老版本的签名白名单里没有 /api/human/**）
                dispatcher = { _, _, _ ->
                    BackendResult.Failed("HTTP-400", null, retryable = false)
                },
                platform = platform,
                keys = keys,
                powBudgetMs = 200,
                log = {},
            )

        val outcome = collector.obtain("LOGIN", "u1")

        assertFalse(outcome.ok)
        assertEquals("HTTP-400", outcome.code, "要把后端真实的答复带出去（后端是活的，只是不认这个接口）")
        assertEquals(HumanVerifyCollector.KEY_CHALLENGE_FAILED, outcome.messageKey)
    }

    @Test
    fun `验证失败时不留票据（下一次调用不会被一张坏票据污染）`() {
        val collector =
            collector { method, _ ->
                when (method) {
                    HumanVerifyCollector.CHALLENGE_METHOD ->
                        BackendResult.Ok(
                            buildJsonObject {
                                put("challengeId", JsonPrimitive("ch-1"))
                                put("action", JsonPrimitive("verify"))
                                put("difficultyBits", JsonPrimitive(0))
                            },
                        )
                    else -> BackendResult.Failed("AUTH-HUMAN-1006", "bridge.humanSignatureInvalid", retryable = false)
                }
            }

        assertFalse(runBlocking { collector.obtain("LOGIN", "u1") }.ok)
    }

    // ---------------------------------------------------------------- 票据注入

    @Test
    fun `票据按用途注入，缺用途就不注入（让服务端去拒绝）`() {
        val holder = HumanTokenHolder()
        holder.put("USER_DELETE", "tok-delete", 120)

        val injected = holder.injectInto(JsonObject(mapOf("userId" to JsonPrimitive(7))), "USER_DELETE")
        assertEquals("tok-delete", (injected as JsonObject)["humanToken"]!!.jsonPrimitive.content)

        val other = holder.injectInto(JsonObject(mapOf("username" to JsonPrimitive("u1"))), "LOGIN")
        assertNull(other!!.jsonObject["humanToken"], "用途不符时不许注入")
    }

    @Test
    fun `过期票据视为没有`() {
        val holder = HumanTokenHolder()
        holder.put("LOGIN", "tok", -1)

        assertFalse(holder.has("LOGIN"))
        assertNull((holder.injectInto(JsonObject(emptyMap()), "LOGIN") as JsonObject)["humanToken"])
    }

    @Test
    fun `调用方自己带了 humanToken 时不覆盖`() {
        val holder = HumanTokenHolder()
        holder.put("LOGIN", "from-bridge", 120)

        val params = JsonObject(mapOf("humanToken" to JsonPrimitive("from-caller")))
        val injected = holder.injectInto(params, "LOGIN") as JsonObject

        assertEquals("from-caller", injected["humanToken"]!!.jsonPrimitive.content)
    }

    // ---------------------------------------------------------------- 测试用的小工具

    /** 测试用的"加密"：只做可逆交换，**不是**产品代码（产品用 DPAPI/Keystore）。 */
    private class PlainTestCodec : SecretCodec {
        override val id: String = "plain-test"

        override fun seal(plain: ByteArray): ByteArray = plain.reversedArray()

        override fun open(sealed: ByteArray): ByteArray = sealed.reversedArray()
    }

    /**
     * 用 JCA 从**桥发出去的那串 hex** 独立验证签名。
     *
     * 刻意不复用桥自己的签名/编码代码：这里走的正是**服务端**要走的路
     * （把未压缩点重建成公钥），所以它同时证明了两件事 —— 签名对、以及那串 hex 服务端能用。
     */
    private fun verifySignature(
        keys: DeviceKeyStore,
        text: String,
        signatureBase64: String,
    ): Boolean =
        runCatching {
            val point = hexToBytes(keys.publicKeyHex)
            val x = java.math.BigInteger(1, point.copyOfRange(1, 33))
            val y = java.math.BigInteger(1, point.copyOfRange(33, 65))
            val parameters = java.security.AlgorithmParameters.getInstance("EC")
            parameters.init(java.security.spec.ECGenParameterSpec("secp256r1"))
            val spec = parameters.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
            val publicKey =
                KeyFactory.getInstance("EC").generatePublic(
                    java.security.spec.ECPublicKeySpec(java.security.spec.ECPoint(x, y), spec),
                )
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(publicKey)
            verifier.update(text.toByteArray(Charsets.UTF_8))
            verifier.verify(Base64.getDecoder().decode(signatureBase64))
        }.getOrDefault(false)

    /** 独立实现前导零 bit 判定。 */
    private fun powOk(
        challengeId: String,
        nonce: String,
        keyId: String,
    ): Boolean {
        val digest =
            MessageDigest
                .getInstance("SHA-256")
                .digest("$challengeId|$nonce|$keyId".toByteArray(Charsets.UTF_8))
        var bits = 0
        for (byte in digest) {
            if (byte.toInt() == 0) {
                bits += 8
                continue
            }
            bits += Integer.numberOfLeadingZeros(byte.toInt() and 0xFF) - 24
            break
        }
        return bits >= easyBits
    }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}

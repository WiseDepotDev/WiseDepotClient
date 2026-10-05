package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.SecretCodec
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * 设备密钥：**每台设备一把 P-256 私钥**，用来给人机验证的那次挑战签名。
 *
 * ## 它是什么、不是什么
 *
 * 它是"同一台设备在同一次挑战上签了字"的证明 —— **不是身份，也不授予任何权限**。
 * 拿到它不能免密登录、不能替代业务令牌；服务端只用它确认"签名来自同一台设备"。
 * 这一点必须写在最上面：不然下一步就会有人拿它做"记住这台设备、免验证 30 天"。
 *
 * ## 为什么落盘、又为什么必须加密
 *
 * 不落盘 ⇒ 每次重启换一把钥匙，服务端的"设备"维度失去意义（R4 新设备规则会一直命中）。
 * 明文落盘 ⇒ 等于把这台机器变成一张通行证。所以复用令牌那一套 [SecretCodec]
 * （桌面 DPAPI、手机 Keystore）；**拿不到平台密钥体系时退回内存**（重启换一把，
 * 代价只是设备识别退化）——这与 `PersistentTokenStore` 同一口径：宁可退化，不写明文。
 *
 * ## 签名原文（三端必须逐字一致）
 *
 * ```text
 * challengeId + "|" + purpose + "|" + powNonce(可为空串) + "|" + deviceKeyId
 * ```
 */
class DeviceKeyStore(
    private val file: Path? = null,
    private val codec: SecretCodec? = null,
    private val log: (String) -> Unit = {},
) {
    private val keyPair: KeyPair = load() ?: generate()

    /** 未压缩点（`04 ‖ X ‖ Y`，65 字节）的 hex —— 服务端用它重建公钥。 */
    val publicKeyHex: String = encodeUncompressed(keyPair.public as ECPublicKey)

    /**
     * 设备指纹：公钥 SHA-256 的前 16 字节（32 个 hex 字符）。
     *
     * **必须是公钥的哈希**：服务端会重算它并与请求里的 `deviceKeyId` 比对，
     * 于是"用 A 的指纹配 B 的签名"会被当场拒掉（服务端那侧有对应用例）。
     */
    val keyId: String = sha256Hex(hexToBytes(publicKeyHex)).substring(0, 32)

    /** 对签名原文签名（ECDSA-SHA256，base64）。 */
    fun sign(text: String): String {
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(keyPair.private)
        signer.update(text.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(signer.sign())
    }

    /** 拼接签名原文。**只允许在这一处拼**：三端不一致的表现是"签名永远验不过"。 */
    fun signedText(
        challengeId: String,
        purpose: String,
        powNonce: String?,
    ): String = "$challengeId|$purpose|${powNonce ?: ""}|$keyId"

    // ---------------------------------------------------------------- 持久化

    private fun load(): KeyPair? {
        val target = file ?: return null
        val encryptor = codec ?: return null
        if (!Files.exists(target)) {
            return null
        }
        return runCatching {
            val plain = encryptor.open(Files.readAllBytes(target)) ?: return@runCatching null
            val json = String(plain, Charsets.UTF_8)
            val privateB64 = field(json, "privateKey") ?: return@runCatching null
            val publicB64 = field(json, "publicKey") ?: return@runCatching null
            val factory = KeyFactory.getInstance("EC")
            KeyPair(
                factory.generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(publicB64))),
                factory.generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(privateB64))),
            )
        }
            .onFailure {
                // 解不开的原因很多（换机器、换用户、清过密钥），但处置都一样：当没有，换一把新的。
                // 刻意**不删**这个文件：删是不可逆的，而留着它下次会被直接覆盖。
                log("[bridge] 设备密钥解不开（换机器/换用户/清过密钥），本次换一把新的：${it.message}")
            }
            .getOrNull()
    }

    private fun generate(): KeyPair {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        persist(pair)
        return pair
    }

    private fun persist(pair: KeyPair) {
        val target = file ?: return
        val encryptor = codec ?: return
        runCatching {
            val encodedPrivate = Base64.getEncoder().encodeToString(pair.private.encoded)
            val encodedPublic = Base64.getEncoder().encodeToString(pair.public.encoded)
            val json = """{"codec":"${encryptor.id}","privateKey":"$encodedPrivate","publicKey":"$encodedPublic"}"""
            val sealed = encryptor.seal(json.toByteArray(Charsets.UTF_8))
            target.parent?.let { Files.createDirectories(it) }
            // 原子写：半截文件的表现是"每次重启换一把新钥匙"，而这种退化不会有任何报错
            val temp = target.resolveSibling("${target.fileName}.tmp")
            Files.write(temp, sealed)
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
        }
            .onFailure { log("[bridge] 设备密钥落盘失败（退回内存，重启会换一把）：${it.message}") }
    }

    /** 最少依赖地抠出一个字符串字段（不为两个字段引入 JSON 依赖）。 */
    private fun field(
        json: String,
        name: String,
    ): String? {
        val marker = "\"$name\":\""
        val start = json.indexOf(marker)
        if (start < 0) {
            return null
        }
        val from = start + marker.length
        val end = json.indexOf('"', from)
        return if (end > from) json.substring(from, end) else null
    }

    private fun encodeUncompressed(public: ECPublicKey): String {
        val x = toFixed(public.w.affineX.toByteArray(), 32)
        val y = toFixed(public.w.affineY.toByteArray(), 32)
        val out = ByteArray(65)
        out[0] = 0x04
        x.copyInto(out, 1)
        y.copyInto(out, 33)
        return out.joinToString("") { "%02x".format(it) }
    }

    private fun toFixed(
        value: ByteArray,
        length: Int,
    ): ByteArray {
        if (value.size == length) {
            return value
        }
        val out = ByteArray(length)
        val copy = minOf(value.size, length)
        value.copyInto(out, length - copy, value.size - copy, value.size)
        return out
    }

    private fun sha256Hex(input: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(input).joinToString("") { "%02x".format(it) }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}

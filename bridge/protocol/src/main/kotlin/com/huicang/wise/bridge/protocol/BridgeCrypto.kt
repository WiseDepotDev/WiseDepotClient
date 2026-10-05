package com.huicang.wise.bridge.protocol

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 协议 v5 的**加密原语**：临时 ECDH（P-256）+ HMAC-SHA256 域分隔 KDF + AES-256-GCM。
 *
 * 本文件是加密层的**唯一实现**（Kotlin 侧）。另外两份同口径实现：
 * `packages/bridge-client/src/seal.ts`（WebCrypto）与 `tools/lib/bridge-wire.mjs`（node:crypto）。
 * 三份必须逐位一致 —— 由 `bridge-crypto-vectors.json` 与
 * `tools/check/check-bridge-crypto-vectors.mjs` 钉住（与 `check-protocol-version` 同体例）。
 *
 * 这里**不含任何线格式**（帧头/外层封装在 [BridgeWire]，S2 落地）：
 * 输入输出都是"明文 / 密文 / AAD"这些字节，因此可以在纯 JVM 单测里被穷举，
 * 也可以被 Kotlin / TS / Node 三种语言同时消费同一组向量。
 *
 * ## 算法为什么是这三个（受 minSdk 25 约束，不是随便挑的）
 *
 * | 候选 | 结论 |
 * | --- | --- |
 * | AES-256-GCM | ✅ `AES/GCM/NoPadding` API 19+；WebCrypto 与 Node 原生；两端有硬件加速 |
 * | ChaCha20-Poly1305 | ✗ Android JCA 要 API 28 |
 * | ECDH P-256 | ✅ `KeyPairGenerator("EC")` + `KeyAgreement("ECDH")` API 11+；WebCrypto `ECDH/P-256`；Node `createECDH('prime256v1')` |
 * | X25519 | ✗ `XDH` 要 API 33 |
 * | HKDF | ✗ JCA 无内置 ⇒ 用 HMAC 域分隔 KDF（下面三段式，三端都能逐位对齐） |
 * | base64url 编码公钥 | ✗ `java.util.Base64` 要 API 26 ⇒ 公钥走 hex |
 *
 * 见 `docs/superpowers/plans/2026-10-06-bridge-ws-encryption-v5.md`。
 */
object BridgeCrypto {
    /** AEAD tag 长度（GCM 固定 128 位）。 */
    const val TAG_BYTES: Int = 16

    /** nonce 长度（GCM 标准 96 位）。 */
    const val NONCE_BYTES: Int = 12

    /** 对称密钥长度（AES-256）。 */
    const val KEY_BYTES: Int = 32

    /**
     * psk 的最小长度。
     *
     * 为什么不是"必须等于 32"：psk 是**引导文件里 psk 的 ASCII 字节**
     * （base64url 的 32 字节 ⇒ 43 个字符）。HMAC 的密钥可以是任意长度（RFC 2104），
     * 这里只拦"明显不是密钥"的输入（空串、占位符）。熵仍是 256 bit。
     */
    const val MIN_PSK_BYTES: Int = 16

    /** 未压缩点编码长度：`0x04 ‖ X(32) ‖ Y(32)`。 */
    const val PUBLIC_KEY_BYTES: Int = 65

    /** ECDH 共享秘密长度（P-256 的 X 坐标）。 */
    const val SHARED_SECRET_BYTES: Int = 32

    /**
     * 一条**密文正文**相对明文的开销：nonce 12 + tag 16。
     *
     * nonce 随正文一起上线（见 [seal] 的说明），外层帧头那 12 字节另算 ——
     * 结构硬上限的换算必须把两者都算上，算漏了的表现是"大图偶尔发不出去"。
     */
    const val SEAL_BODY_OVERHEAD_BYTES: Int = NONCE_BYTES + TAG_BYTES

    /** 方向字节：客户端 → 壳。 */
    const val DIR_CLIENT_TO_SERVER: Int = 0x01

    /** 方向字节：壳 → 客户端。 */
    const val DIR_SERVER_TO_CLIENT: Int = 0x02

    /**
     * 允许的序号跳跃上限（防重放时用）。
     *
     * 为什么允许跳号而不是要求"恰好 +1"：序号的自增与"谁先写到线上"**不是同一件事**
     * （Netty 侧广播可能从任意线程发起、手机侧广播在 `writeLock` 里发）。
     * 要求严格连续会把"两个线程的写序相反"变成**协议级断连**；
     * 而只要序号单调递增就不可能重放，所以这里只要求单调 + 有界。
     */
    const val MAX_SEQ_GAP: Long = 4096L

    private const val CURVE = "secp256r1"
    private const val KDF_LABEL = "wd-bridge/v5/kdf"
    private const val LABEL_CLIENT_SIDE = "c"
    private const val LABEL_SERVER_SIDE = "s"
    private const val LABEL_C2S = "wd-bridge/v5/c2s"
    private const val LABEL_S2C = "wd-bridge/v5/s2c"

    private val TWO = BigInteger.valueOf(2)
    private val THREE = BigInteger.valueOf(3)

    /**
     * P-256 域参数：从一次"生成密钥对"里取，而不是 `AlgorithmParameters.getInstance("EC")`
     * ——两条路都标准，但前者在所有 provider 上都成立，不依赖"某个 provider 是否实现了 EC 的 AlgorithmParameters"。
     */
    private val curve: ECParameterSpec by lazy {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec(CURVE))
        (generator.generateKeyPair().public as java.security.interfaces.ECPublicKey).params
    }

    // ---------------------------------------------------------------- 编解码

    private const val HEX = "0123456789abcdef"

    /** 字节 → 小写 hex。用于公钥上线、日志与测试向量（**不用于密钥**，见文件头的日志纪律）。 */
    fun hex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            sb.append(HEX[v ushr 4]).append(HEX[v and 0x0F])
        }
        return sb.toString()
    }

    /** 小写/大写 hex → 字节。非法输入抛 [BridgeCryptoException]（不返回 null：调用方必须处理）。 */
    fun fromHex(text: String): ByteArray {
        if (text.length % 2 != 0) {
            throw BridgeCryptoException("hex 长度必须是偶数：${text.length}")
        }
        val out = ByteArray(text.length / 2)
        for (i in out.indices) {
            val hi = hexDigit(text[i * 2])
            val lo = hexDigit(text[i * 2 + 1])
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    private fun hexDigit(c: Char): Int =
        when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + 10
            in 'A'..'F' -> c - 'A' + 10
            else -> throw BridgeCryptoException("非法 hex 字符：$c")
        }

    /**
     * nonce：`dir(1) ‖ seq(8，大端) ‖ 0x00 0x00 0x00`。
     *
     * 明确写出来（而不是留给三个实现各自"顺手拼一个"）—— nonce 布局不一致的表现是
     * "本地全绿、真机全挂"，而且没有任何可读的错误。
     */
    fun nonce(
        direction: Int,
        seq: Long,
    ): ByteArray {
        val out = ByteArray(NONCE_BYTES)
        out[0] = direction.toByte()
        for (i in 0 until 8) {
            out[1 + i] = ((seq ushr (8 * (7 - i))) and 0xFF).toByte()
        }
        return out
    }

    /** 从上线字节里读 nonce（前 [NONCE_BYTES] 字节）。 */
    fun nonceOf(
        direction: Int,
        sealed: ByteArray,
    ): Long {
        if (sealed.size < SEAL_BODY_OVERHEAD_BYTES) {
            throw BridgeCryptoException("密文正文太短：${sealed.size}")
        }
        if (sealed[0].toInt() and 0xFF != direction) {
            throw BridgeCryptoException("方向字节不符：期望 $direction 实得 ${sealed[0].toInt() and 0xFF}")
        }
        var seq = 0L
        for (i in 0 until 8) {
            seq = (seq shl 8) or (sealed[1 + i].toLong() and 0xFF)
        }
        return seq
    }

    // ---------------------------------------------------------------- ECDH

    /** 一次性的 P-256 密钥对（**每次建连**新生成，这就是前向保密的来源）。 */
    class Ephemeral(
        /** 未压缩点：`0x04 ‖ X ‖ Y`（65 字节，上线用 hex）。 */
        val publicKey: ByteArray,
        val privateKey: PrivateKey,
    )

    fun generateEphemeral(): Ephemeral {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec(CURVE))
        val pair = generator.generateKeyPair()
        return Ephemeral(encodePoint(pair.public as java.security.interfaces.ECPublicKey), pair.private)
    }

    fun privateKeyFromPkcs8(bytes: ByteArray): PrivateKey =
        KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(bytes))

    /**
     * 由私钥**标量**构造私钥。
     *
     * 只给测试向量用（`bridge-crypto-vectors.json` 里给的是标量，三端才能各自复算出同一个 `Z`）。
     * 生产路径只有 [generateEphemeral] —— 那里用的是 `KeyPairGenerator`，私钥从不以字节形式存在。
     */
    internal fun privateKeyFromScalar(scalar: ByteArray): PrivateKey {
        if (scalar.size != 32) {
            throw BridgeCryptoException("P-256 私钥标量必须是 32 字节，实得 ${scalar.size}")
        }
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), curve))
    }

    /** P-256 域参数（测试向量与 `?k=` 校验共用）。 */
    internal fun curveParameters(): ECParameterSpec = curve

    /** `0x04 ‖ X ‖ Y`。 */
    fun encodePoint(key: java.security.interfaces.ECPublicKey): ByteArray {
        val out = ByteArray(PUBLIC_KEY_BYTES)
        out[0] = 0x04
        copyFixed(key.w.affineX, out, 1, 32)
        copyFixed(key.w.affineY, out, 33, 32)
        return out
    }

    private fun copyFixed(
        value: BigInteger,
        out: ByteArray,
        offset: Int,
        length: Int,
    ) {
        val raw = value.toByteArray()
        // BigInteger 是**有符号大端**：可能多一个 0x00 前导字节，也可能短于 length
        val start = if (raw.size > length) raw.size - length else 0
        val count = raw.size - start
        raw.copyInto(out, offset + (length - count), start, raw.size)
    }

    /**
     * 点是否落在 P-256 上（且编码合法）。
     *
     * **必须在做 ECDH 之前判**：`?k=` 是未经认证的输入，一个不在曲线上的点要么让
     * 某些 provider 抛异常、要么（更糟）落进实现相关的分支。判一次只有几次大数乘法。
     */
    fun isOnCurve(publicKey: ByteArray): Boolean {
        if (publicKey.size != PUBLIC_KEY_BYTES || publicKey[0].toInt() != 0x04) {
            return false
        }
        val field = curve.curve.field as? ECFieldFp ?: return false
        val p = field.p
        val x = BigInteger(1, publicKey.copyOfRange(1, 33))
        val y = BigInteger(1, publicKey.copyOfRange(33, 65))
        if (x >= p || y >= p) {
            return false
        }
        val left = y.modPow(TWO, p)
        val right = (x.modPow(THREE, p) + curve.curve.a.multiply(x) + curve.curve.b).mod(p)
        return left == right
    }

    private fun publicKeyOf(raw: ByteArray): java.security.interfaces.ECPublicKey {
        if (!isOnCurve(raw)) {
            throw BridgeCryptoException("公钥不是合法的 P-256 未压缩点")
        }
        val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, curve)) as java.security.interfaces.ECPublicKey
    }

    /** `Z`：ECDH 共享秘密（P-256 的 X 坐标，32 字节）。 */
    fun sharedSecret(
        privateKey: PrivateKey,
        peerPublicKey: ByteArray,
    ): ByteArray {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(publicKeyOf(peerPublicKey), true)
        val z = agreement.generateSecret()
        if (z.size != SHARED_SECRET_BYTES) {
            throw BridgeCryptoException("ECDH 共享秘密长度异常：${z.size}")
        }
        return z
    }

    fun sharedSecret(
        ephemeral: Ephemeral,
        peerPublicKey: ByteArray,
    ): ByteArray = sharedSecret(ephemeral.privateKey, peerPublicKey)

    // ---------------------------------------------------------------- KDF

    /** 一条连接的三个密钥（P-256 每次建连新生成 ⇒ 这三个值每条连接都不同）。 */
    class SessionKeys(
        /** 连接密钥（只用于派生下面两个，不直接加密）。 */
        val connection: ByteArray,
        val clientToServer: ByteArray,
        val serverToClient: ByteArray,
    )

    /**
     * ```text
     * K_conn = HMAC-SHA256(psk, "wd-bridge/v5/kdf" ‖ "c" ‖ clientPub ‖ "s" ‖ serverPub ‖ Z)
     * K_c2s  = HMAC-SHA256(K_conn, "wd-bridge/v5/c2s")
     * K_s2c  = HMAC-SHA256(K_conn, "wd-bridge/v5/s2c")
     * ```
     *
     * 三条设计理由（改这里之前先读完）：
     *  1. **psk 必须参与**：裸 ECDH 不认证对端，任何中间人都能各自换一套密钥；
     *     把 psk 当 HMAC 的**密钥**混进去，没有 psk 的一方连密钥都算不出来；
     *  2. **前向保密仍然成立**：psk 是密钥、Z 是被混入的数据 —— 事后泄露 psk 也解不开历史会话；
     *  3. **transcript 绑定**：两个公钥都进 KDF，避免"未知密钥共享"，且两端 transcript 不一致
     *     必然表现为 tag 失败（可诊断），而不是"能连但数据是错的"。
     */
    fun sessionKeys(
        psk: ByteArray,
        clientPublicKey: ByteArray,
        serverPublicKey: ByteArray,
        shared: ByteArray,
    ): SessionKeys {
        // psk 是**引导文件里的 psk 的 ASCII 字节**（43 个字符 = 256 bit 熵），不是 32 字节的原始密钥：
        // HMAC 的密钥本来就可以是任意长度（RFC 2104），这里只拦"明显不对"的输入
        require(psk.size >= MIN_PSK_BYTES) { "psk 至少 $MIN_PSK_BYTES 字节，实得 ${psk.size}" }
        require(clientPublicKey.size == PUBLIC_KEY_BYTES) { "clientPub 必须是 $PUBLIC_KEY_BYTES 字节" }
        require(serverPublicKey.size == PUBLIC_KEY_BYTES) { "serverPub 必须是 $PUBLIC_KEY_BYTES 字节" }
        require(shared.size == SHARED_SECRET_BYTES) { "Z 必须是 $SHARED_SECRET_BYTES 字节" }

        val transcript =
            KDF_LABEL.toByteArray(Charsets.UTF_8) +
                LABEL_CLIENT_SIDE.toByteArray(Charsets.UTF_8) +
                clientPublicKey +
                LABEL_SERVER_SIDE.toByteArray(Charsets.UTF_8) +
                serverPublicKey +
                shared
        val connection = hmac(psk, transcript)
        return SessionKeys(
            connection = connection,
            clientToServer = hmac(connection, LABEL_C2S.toByteArray(Charsets.UTF_8)),
            serverToClient = hmac(connection, LABEL_S2C.toByteArray(Charsets.UTF_8)),
        )
    }

    // ---------------------------------------------------------------- AEAD

    /**
     * 加密：`nonce(12) ‖ 密文 ‖ tag(16)`。
     *
     * **nonce 为什么要上线（而不是"由序号推导、一个字节都不发"）**：
     * 推导方案要求"序号的自增顺序 == 写到线上的顺序"这条跨线程不变式，
     * 而广播确实可能从任意线程发起；一旦违反，接收端会因为等不到"恰好 +1"而**断连** ——
     * 一个很难复现的时序 bug 直接升级成协议级故障。
     * 12 字节在 loopback 上没有任何意义（同一个理由见 [BridgeWire] 文件头"不做 varint"），
     * 但换来的是"只要求序号单调"这个**容易验证**的不变式。
     * 序号自增用 [AtomicLong]：并发下不重复（重复 = 同密钥同 nonce = 灾难）。
     */
    fun seal(
        key: ByteArray,
        direction: Int,
        seq: Long,
        plaintext: ByteArray,
        aad: ByteArray,
    ): ByteArray {
        require(key.size == KEY_BYTES) { "密钥必须是 $KEY_BYTES 字节" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce(direction, seq)))
        if (aad.isNotEmpty()) {
            cipher.updateAAD(aad)
        }
        val body = cipher.doFinal(plaintext)
        return nonce(direction, seq) + body
    }

    /** 解密。tag 失败 / 长度不对 / 方向不符都抛 [BridgeCryptoException]。 */
    fun open(
        key: ByteArray,
        direction: Int,
        sealed: ByteArray,
        aad: ByteArray,
    ): ByteArray {
        require(key.size == KEY_BYTES) { "密钥必须是 $KEY_BYTES 字节" }
        val seq = nonceOf(direction, sealed)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce(direction, seq)))
        if (aad.isNotEmpty()) {
            cipher.updateAAD(aad)
        }
        return try {
            cipher.doFinal(sealed, NONCE_BYTES, sealed.size - NONCE_BYTES)
        } catch (e: Exception) {
            throw BridgeCryptoException("密文校验失败（tag 不符或已损坏）", e)
        }
    }

    // ---------------------------------------------------------------- 会话

    /** 本端在连接里的角色：决定"出站用哪把密钥、nonce 的方向字节是几"。 */
    enum class Role {
        CLIENT,
        SERVER,
    }

    /**
     * 一条连接的加密会话：**持有三把密钥 + 两个方向的序号水位**。
     *
     * 生命周期与连接一致（`transport.ts` 每次重连、Netty/自写传输每个 channel 各一个），
     * 不复用、不跨连接 —— 跨连接复用会重用 `(key, nonce)`，那是 GCM 的致命用法。
     */
    class Session(
        private val keys: SessionKeys,
        private val role: Role,
    ) {
        private val outboundSeq = AtomicLong(0L)
        private var inboundSeq = 0L

        /** 出站密钥（本端方向）。 */
        val outboundKey: ByteArray
            get() = if (role == Role.CLIENT) keys.clientToServer else keys.serverToClient

        /** 入站密钥（对端方向）。 */
        val inboundKey: ByteArray
            get() = if (role == Role.CLIENT) keys.serverToClient else keys.clientToServer

        /** 本端方向字节（nonce 的第一字节）。 */
        val outboundDirection: Int
            get() = if (role == Role.CLIENT) BridgeCrypto.DIR_CLIENT_TO_SERVER else BridgeCrypto.DIR_SERVER_TO_CLIENT

        /** 已发出的最大序号（诊断用）。 */
        val sentSeq: Long
            get() = outboundSeq.get()

        /** 已接收的最大序号（诊断用）。 */
        val receivedSeq: Long
            get() = inboundSeq

        fun seal(
            plaintext: ByteArray,
            aad: ByteArray,
        ): ByteArray =
            BridgeCrypto.seal(
                outboundKey,
                outboundDirection,
                outboundSeq.incrementAndGet(),
                plaintext,
                aad,
            )

        /**
         * 解密并做防重放：方向字节必须是对端方向，序号必须**严格单调递增**且有界。
         *
         * 重放（序号已被消费）与跳号过大都在这里被拒 —— 这条是"帧不可重放"的唯一落点。
         */
        fun open(
            sealed: ByteArray,
            aad: ByteArray,
        ): ByteArray {
            val peerDirection =
                if (role == Role.CLIENT) {
                    BridgeCrypto.DIR_SERVER_TO_CLIENT
                } else {
                    BridgeCrypto.DIR_CLIENT_TO_SERVER
                }
            val seq = BridgeCrypto.nonceOf(peerDirection, sealed)
            if (seq <= inboundSeq) {
                throw BridgeCryptoException("序号回退/重放：已收到 $inboundSeq，又收到 $seq")
            }
            if (seq - inboundSeq > BridgeCrypto.MAX_SEQ_GAP) {
                throw BridgeCryptoException("序号跳跃过大：$inboundSeq → $seq")
            }
            val plaintext = BridgeCrypto.open(inboundKey, peerDirection, sealed, aad)
            inboundSeq = seq
            return plaintext
        }
    }

    // ---------------------------------------------------------------- 内部

    private fun hmac(
        key: ByteArray,
        message: ByteArray,
    ): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }
}

/**
 * 加密层自己的失败。
 *
 * 为什么单开一个异常而不是复用 `IllegalStateException`：调用方要区分
 * "密文不可信 ⇒ 断开这条连接"与"我们自己写错了参数 ⇒ 这是 bug"。
 * 前者是**对端（或中间人）**造成的，后者是**本端**造成的 —— 出路完全不同。
 */
class BridgeCryptoException(
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

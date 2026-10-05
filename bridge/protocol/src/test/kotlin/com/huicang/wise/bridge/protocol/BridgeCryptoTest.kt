package com.huicang.wise.bridge.protocol

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * 加密原语的可执行证据（协议 v5）。
 *
 * 权威是冻结的 `bridge-crypto-vectors.json`（不再是人在这里重算一遍）：
 * Kotlin / TS(`seal.ts`) / 工具(`bridge-wire.mjs`) 三份实现都必须复算出同一份密文。
 * 向量里给的私钥是**标量**（三端都能各自复算 `Z`）；AAD 用的是真实的外层帧头 ‖ id，
 * 所以这份文件同时把"外层封装的输入是什么"钉死了。
 */
class BridgeCryptoTest {
    private val vectors = CryptoVectors.data

    @Test
    fun `hex 往返：公钥这种 65 字节的点不带任何前导零丢失`() {
        val clientPub = CryptoVectors.clientPublicKey
        assertContentEquals(clientPub, BridgeCrypto.fromHex(BridgeCrypto.hex(clientPub)))
        assertEquals(65, clientPub.size)
        assertEquals(vectors.clientPublicKeyHex, BridgeCrypto.hex(clientPub), "hex 必须是小写且逐字符相同")
    }

    @Test
    fun `向量：ECDH 两个方向给出同一个 Z，且逐字节等于冻结值`() {
        val z1 = BridgeCrypto.sharedSecret(CryptoVectors.clientPrivate, CryptoVectors.serverPublicKey)
        val z2 = BridgeCrypto.sharedSecret(CryptoVectors.serverPrivate, CryptoVectors.clientPublicKey)
        assertContentEquals(z1, z2, "ECDH 必须对称（否则两端算出的密钥不同）")
        assertContentEquals(CryptoVectors.sharedSecret, z1, "Z 与向量不一致")
    }

    @Test
    fun `向量：KDF 三把密钥逐字节一致`() {
        val keys = CryptoVectors.keys()
        assertContentEquals(BridgeCrypto.fromHex(vectors.connectionKeyHex), keys.connection, "K_conn")
        assertContentEquals(BridgeCrypto.fromHex(vectors.clientToServerKeyHex), keys.clientToServer, "K_c2s")
        assertContentEquals(BridgeCrypto.fromHex(vectors.serverToClientKeyHex), keys.serverToClient, "K_s2c")
        assertEquals(32, keys.connection.size)
    }

    @Test
    fun `向量：每一条密文逐字节一致（nonce 上线、tag 追加在末尾）`() {
        val keys = CryptoVectors.keys()
        for (case in vectors.cases) {
            val plaintext = BridgeCrypto.fromHex(case.plaintextHex)
            val aad = BridgeCrypto.fromHex(case.aadHex)
            val key = if (case.dir == BridgeCrypto.DIR_CLIENT_TO_SERVER) keys.clientToServer else keys.serverToClient
            val sealed = BridgeCrypto.seal(key, case.dir, case.seq, plaintext, aad)
            assertEquals(case.sealedHex, BridgeCrypto.hex(sealed), "密文与向量不一致：${case.name}")
            // nonce 必须原样在正文最前面（三端各自"顺手拼一个"就会在这里分叉）
            assertContentEquals(
                BridgeCrypto.nonce(case.dir, case.seq),
                sealed.copyOfRange(0, BridgeCrypto.NONCE_BYTES),
                "nonce 布局不一致：${case.name}",
            )
            assertEquals(case.seq, BridgeCrypto.nonceOf(case.dir, sealed), "序号必须能从正文读回来")
        }
    }

    @Test
    fun `向量：每条密文都能解回原明文（另一端的角度）`() {
        val keys = CryptoVectors.keys()
        for (case in vectors.cases) {
            val key = if (case.dir == BridgeCrypto.DIR_CLIENT_TO_SERVER) keys.clientToServer else keys.serverToClient
            val plain = BridgeCrypto.open(key, case.dir, BridgeCrypto.fromHex(case.sealedHex), BridgeCrypto.fromHex(case.aadHex))
            assertEquals(case.plaintextHex, BridgeCrypto.hex(plain), "解出来的明文不对：${case.name}")
        }
    }

    @Test
    fun `篡改任意一位都会被拒（密文、tag、AAD、方向都算）`() {
        val keys = CryptoVectors.keys()
        val case = vectors.cases.first { it.dir == BridgeCrypto.DIR_CLIENT_TO_SERVER }
        val aad = BridgeCrypto.fromHex(case.aadHex)
        val sealed = BridgeCrypto.fromHex(case.sealedHex)

        // 正文最后一位（tag 里）
        val tagFlipped = sealed.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0x01).toByte() }
        assertFailsWith<BridgeCryptoException>("改 tag 必须被发现") {
            BridgeCrypto.open(keys.clientToServer, case.dir, tagFlipped, aad)
        }

        // 密文中间（nonce 之后、tag 之前）
        val bodyFlipped = sealed.copyOf().also { it[BridgeCrypto.NONCE_BYTES + 1] = (it[BridgeCrypto.NONCE_BYTES + 1].toInt() xor 0x80).toByte() }
        assertFailsWith<BridgeCryptoException>("改密文必须被发现") {
            BridgeCrypto.open(keys.clientToServer, case.dir, bodyFlipped, aad)
        }

        // AAD 改一位（外层帧头被改 → 必须失败）
        val aadFlipped = aad.copyOf().also { it[3] = (it[3].toInt() xor 0x01).toByte() }
        assertFailsWith<BridgeCryptoException>("AAD 不在密文里，必须靠 AEAD 兜住") {
            BridgeCrypto.open(keys.clientToServer, case.dir, sealed, aadFlipped)
        }

        // 方向字节不符（同一把密钥、另一个方向）
        assertFailsWith<BridgeCryptoException> {
            BridgeCrypto.open(keys.clientToServer, BridgeCrypto.DIR_SERVER_TO_CLIENT, sealed, aad)
        }
    }

    @Test
    fun `错误密钥解不开（psk 不对就是两把完全不同的密钥）`() {
        val wrong = BridgeCrypto.sessionKeys(ByteArray(32) { 0x7F }, CryptoVectors.clientPublicKey, CryptoVectors.serverPublicKey, CryptoVectors.sharedSecret)
        val case = vectors.cases.first()
        assertFailsWith<BridgeCryptoException> {
            BridgeCrypto.open(wrong.clientToServer, case.dir, BridgeCrypto.fromHex(case.sealedHex), BridgeCrypto.fromHex(case.aadHex))
        }
    }

    @Test
    fun `不在曲线上的点在做 ECDH 之前就被拒`() {
        val clientPub = CryptoVectors.clientPublicKey
        assertTrue(BridgeCrypto.isOnCurve(clientPub), "向量里的公钥必须在曲线上")
        assertTrue(BridgeCrypto.isOnCurve(CryptoVectors.serverPublicKey))

        val notOnCurve = clientPub.copyOf().also { it[64] = (it[64].toInt() xor 0x01).toByte() }
        assertTrue(!BridgeCrypto.isOnCurve(notOnCurve), "改一位就离开曲线（P-256 上没有别的点这么巧）")
        assertFailsWith<BridgeCryptoException>("非法点不得进入 ECDH") {
            BridgeCrypto.sharedSecret(CryptoVectors.clientPrivate, notOnCurve)
        }
        assertTrue(!BridgeCrypto.isOnCurve(ByteArray(65)), "全零点（无穷远点的伪装）必须被拒")
        assertTrue(!BridgeCrypto.isOnCurve(clientPub.copyOfRange(0, 64)), "长度不对必须被拒")
        assertTrue(!BridgeCrypto.isOnCurve(clientPub.copyOf().also { it[0] = 0x05 }), "只有 0x04 未压缩点被接受")
    }

    @Test
    fun `会话：拒绝重放，拒绝过大的跳号，方向必须是对端`() {
        val sender = CryptoVectors.session(BridgeCrypto.Role.CLIENT)
        val receiver = CryptoVectors.session(BridgeCrypto.Role.SERVER)
        val aad = ByteArray(0)

        val first = sender.seal("hello".toByteArray(), aad)
        assertEquals("hello", String(receiver.open(first, aad)))

        // 重放同一条（序号已被消费）
        assertFailsWith<BridgeCryptoException> { receiver.open(first, aad) }

        // 跳号过大
        val far =
            BridgeCrypto.seal(
                CryptoVectors.keys().clientToServer,
                BridgeCrypto.DIR_CLIENT_TO_SERVER,
                BridgeCrypto.MAX_SEQ_GAP + 5,
                ByteArray(0),
                aad,
            )
        assertFailsWith<BridgeCryptoException> { receiver.open(far, aad) }

        // 用对端的密钥方向伪造（本端方向）→ 方向字节不符
        val ownDirection = BridgeCrypto.seal(CryptoVectors.keys().clientToServer, BridgeCrypto.DIR_CLIENT_TO_SERVER, 3, ByteArray(0), aad)
        assertFailsWith<BridgeCryptoException> { CryptoVectors.session(BridgeCrypto.Role.CLIENT).open(ownDirection, aad) }

        // 正常连续两条仍然可用
        assertEquals("world", String(sender.open(receiver.seal("world".toByteArray(), aad), aad)))
    }

    @Test
    fun `psk 用引导里 token 的 ASCII 字节（43 个字符，不是 32 字节）`() {
        /*
         * 这条是 S3 实测逼出来的：引导里的 token 是 base64url 的 32 字节 ⇒ **43 个 ASCII 字符**，
         * 而最早的实现要求 psk 恰好 32 字节 —— 于是**所有真实连接都握手失败**（生产路径全挂，
         * 只有用 32 字节 psk 的单测是绿的）。
         * HMAC 的密钥本来就可以任意长度（RFC 2104），这里把"真实形状"钉住。
         */
        val tokenAscii = BridgeCrypto.sessionKeys(
            "Qw3rTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefg".toByteArray(Charsets.UTF_8),
            CryptoVectors.clientPublicKey,
            CryptoVectors.serverPublicKey,
            CryptoVectors.sharedSecret,
        )
        assertEquals(32, tokenAscii.connection.size, "KDF 输出永远是 32 字节（AES-256）")
        assertEquals(43, "Qw3rTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefg".length, "token 的形状：43 个字符")

        // 太短一律拒（占位符/空串不该被当成密钥）
        assertFailsWith<IllegalArgumentException> {
            BridgeCrypto.sessionKeys(ByteArray(8), CryptoVectors.clientPublicKey, CryptoVectors.serverPublicKey, CryptoVectors.sharedSecret)
        }
    }

    @Test
    fun `每连接一套临时密钥：同一段明文在不同连接上的密文不同`() {
        val a = BridgeCrypto.generateEphemeral()
        val b = BridgeCrypto.generateEphemeral()
        assertTrue(!a.publicKey.contentEquals(b.publicKey), "两次生成的公钥不应相同")
        assertTrue(BridgeCrypto.isOnCurve(a.publicKey) && BridgeCrypto.isOnCurve(b.publicKey))

        val zA = BridgeCrypto.sharedSecret(a, CryptoVectors.serverPublicKey)
        val zB = BridgeCrypto.sharedSecret(b, CryptoVectors.serverPublicKey)
        assertTrue(!zA.contentEquals(zB), "不同临时私钥必须给出不同的 Z（前向保密的前提）")

        // 同一个 psk、同一个序号、同一段明文 → 密钥不同 ⇒ 密文不同
        val keysA = BridgeCrypto.sessionKeys(CryptoVectors.psk, a.publicKey, CryptoVectors.serverPublicKey, zA)
        val keysB = BridgeCrypto.sessionKeys(CryptoVectors.psk, b.publicKey, CryptoVectors.serverPublicKey, zB)
        val sealedA = BridgeCrypto.seal(keysA.clientToServer, BridgeCrypto.DIR_CLIENT_TO_SERVER, 1, "ping".toByteArray(), ByteArray(0))
        val sealedB = BridgeCrypto.seal(keysB.clientToServer, BridgeCrypto.DIR_CLIENT_TO_SERVER, 1, "ping".toByteArray(), ByteArray(0))
        assertTrue(!sealedA.contentEquals(sealedB), "重连换密钥 ⇒ 相同 (seq, 明文) 的密文必须不同")
    }

    @Test
    fun `域参数就是 P-256（曲线与阶都锁住，防止悄悄换了曲线）`() {
        val params = BridgeCrypto.curveParameters()
        assertEquals(256, params.curve.field.fieldSize)
        assertEquals(
            "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
            params.order.toString(16),
            "P-256 的阶",
        )
    }
}

package com.huicang.wise.bridge.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * v5 **加密封装**的可执行证据。
 *
 * 封装规则只有一句话：**外层 12 字节头是明文，正文是"内层整帧"的密文**；
 * AAD = 外层头 ‖ id。内层逐字节就是一条 v4 消息，所以 `decode` 与 167 条方法一行都不用改。
 *
 * 这里钉住四件事（每一件都对应一种"线上很难查"的故障）：
 *  1. **逐字节与冻结向量一致** —— 三份实现（Kotlin / TS / 工具）的封装必须产出同一段字节；
 *  2. **内外一致性** —— 外层头明文，所以它必须与内层说的完全一致（kind / id）；
 *  3. **只有 hello 可以明文** —— 其余帧 ENC=0 一律拒（不许"看起来连上了"）；
 *  4. **结构上限要算上封装开销** —— 少算 295 的表现是"大图偶尔发不出去"。
 */
class BridgeSealedFrameTest {
    private val vectors = CryptoVectors.data

    @Test
    fun `向量：c2s 每条整帧逐字节一致，且能解回同一条内层消息`() {
        val sender = CryptoVectors.session(BridgeCrypto.Role.CLIENT)
        val receiver = CryptoVectors.session(BridgeCrypto.Role.SERVER)

        for (frame in vectors.frames.clientToServer) {
            val inner = BridgeCrypto.fromHex(frame.innerHex)
            val outer = BridgeWire.sealMessage(inner, sender)
            assertEquals(frame.outerHex, BridgeCrypto.hex(outer), "外层字节与向量不一致：${frame.name}")
            assertTrue(BridgeWire.isEncrypted(outer), "外层必须是密文帧：${frame.name}")

            assertContentEquals(inner, BridgeWire.openMessage(BridgeCrypto.fromHex(frame.outerHex), receiver), "开出来的内层不一致：${frame.name}")
        }
    }

    @Test
    fun `向量：s2c 每条整帧逐字节一致（另一方向、含 res err evt）`() {
        val sender = CryptoVectors.session(BridgeCrypto.Role.SERVER)
        val receiver = CryptoVectors.session(BridgeCrypto.Role.CLIENT)

        for (frame in vectors.frames.serverToClient) {
            val inner = BridgeCrypto.fromHex(frame.innerHex)
            assertEquals(frame.outerHex, BridgeCrypto.hex(BridgeWire.sealMessage(inner, sender)), "外层字节与向量不一致：${frame.name}")
            assertContentEquals(inner, BridgeWire.openMessage(BridgeCrypto.fromHex(frame.outerHex), receiver), "开出来的内层不一致：${frame.name}")
        }
    }

    @Test
    fun `整条链路：外层密文 → 打开 → 解码出原来的语义（req bin res err evt）`() {
        // c2s：req 与 bin
        val server = CryptoVectors.session(BridgeCrypto.Role.SERVER)
        val req = assertIs<ReqFrame>(decodeSealed(vectors.frames.clientToServer[0].outerHex, server))
        assertEquals("bridge.ping", req.method)
        assertEquals("c-1", req.id)

        val bin = assertIs<BinFrame>(decodeSealed(vectors.frames.clientToServer[1].outerHex, server))
        assertContentEquals(byteArrayOf(0, 1, 0xFE.toByte(), 0xFF.toByte(), 0x7F, 0x80.toByte()), bin.body)
        assertEquals("u-9", bin.id)

        // s2c：res / err / evt
        val client = CryptoVectors.session(BridgeCrypto.Role.CLIENT)
        val res = assertIs<ResFrame>(decodeSealed(vectors.frames.serverToClient[0].outerHex, client))
        assertEquals("c-1", res.id)
        assertEquals(buildJsonObject { put("pong", true) }, res.data)

        val err = assertIs<ErrFrame>(decodeSealed(vectors.frames.serverToClient[1].outerHex, client))
        assertEquals(BridgeErrorCodes.METHOD_UNKNOWN, err.error.code)

        val evt = assertIs<EvtFrame>(decodeSealed(vectors.frames.serverToClient[2].outerHex, client))
        assertEquals("scan.code", evt.topic)
        assertEquals("", BridgeWire.headerId(BridgeCrypto.fromHex(vectors.frames.serverToClient[2].innerHex)), "事件帧没有 id")
    }

    @Test
    fun `外层头是明文：改它一定失败（AAD），改内层也一定失败（tag）`() {
        val receiver = CryptoVectors.session(BridgeCrypto.Role.SERVER)
        val outer = BridgeCrypto.fromHex(vectors.frames.clientToServer[0].outerHex)

        // 外层 kind 被改（AAD 变了）
        val kindTampered = outer.copyOf().also { it[3] = 0x02 }
        assertFailsWith<BridgeCryptoException>("改外层 kind 必须被发现") { BridgeWire.openMessage(kindTampered, receiver) }

        // 外层 id 被改（AAD 变了）
        val idTampered = outer.copyOf().also { it[BridgeWire.HEADER_BYTES] = 0x62 }
        assertFailsWith<BridgeCryptoException>("改外层 id 必须被发现") { BridgeWire.openMessage(idTampered, receiver) }

        // 外层 bodyLen 被改（长度不自洽）
        val lenTampered = outer.copyOf().also { it[8] = (it[8] + 1).toByte() }
        assertFailsWith<BridgeCryptoException>("改外层长度必须被发现") { BridgeWire.openMessage(lenTampered, receiver) }

        // 内层密文被改
        val bodyTampered = outer.copyOf().also { it[BridgeWire.HEADER_BYTES + 3 + 13] = (it[BridgeWire.HEADER_BYTES + 3 + 13].toInt() xor 0x01).toByte() }
        assertFailsWith<BridgeCryptoException>("改密文必须被发现") { BridgeWire.openMessage(bodyTampered, receiver) }
    }

    @Test
    fun `内外一致性：外层头说 res 而内层是 req —— tag 对得上也必须拒`() {
        val inner = BridgeWire.encode(ReqFrame(id = "c-1", method = "bridge.ping"))
        val innerKind = WireKind.REQ
        val forgedKind = WireKind.RES
        val id = "c-1".toByteArray(Charsets.UTF_8)
        val bodyLen = inner.size + BridgeCrypto.SEAL_BODY_OVERHEAD_BYTES

        // 手工拼一个"外层 kind=RES、内层 kind=REQ"的帧：tag 用**真会话**算，所以 tag 本身是对的
        val header = ByteArray(BridgeWire.HEADER_BYTES)
        header[0] = 0x57
        header[1] = 0x42
        header[2] = BridgeProtocol.VERSION.toByte()
        header[3] = forgedKind.toByte()
        header[4] = (BridgeWire.FLAG_FINAL or BridgeWire.FLAG_ENC).toByte()
        header[5] = 0
        header[6] = id.size.toByte()
        header[7] = 0
        header[8] = (bodyLen and 0xFF).toByte()
        header[9] = ((bodyLen ushr 8) and 0xFF).toByte()
        header[10] = ((bodyLen ushr 16) and 0xFF).toByte()
        header[11] = ((bodyLen ushr 24) and 0xFF).toByte()

        val sender = CryptoVectors.session(BridgeCrypto.Role.CLIENT)
        val sealed = sender.seal(inner, header + id)
        val forged = header + id + sealed

        assertEquals(innerKind, inner[3].toInt() and 0xFF, "内层确实是 req")
        assertEquals(forgedKind, forged[3].toInt() and 0xFF, "外层被写成了 res")
        assertFailsWith<BridgeCryptoException>("内外 kind 不一致必须拒，而不是按外层处理") {
            BridgeWire.openMessage(forged, CryptoVectors.session(BridgeCrypto.Role.SERVER))
        }
    }

    @Test
    fun `只有 hello 可以是明文：其余帧 ENC=0 一律拒`() {
        val receiver = CryptoVectors.session(BridgeCrypto.Role.SERVER)
        val inner = BridgeCrypto.fromHex(vectors.frames.clientToServer[0].innerHex) // 明文 req
        assertTrue(!BridgeWire.isEncrypted(inner), "明文帧不是密文帧")
        assertFailsWith<BridgeCryptoException>("v5 里非 hello 的明文帧必须拒") { BridgeWire.openMessage(inner, receiver) }
    }

    @Test
    fun `hello：唯一允许明文的帧，且不能被加密`() {
        val serverKey = BridgeCrypto.hex(CryptoVectors.serverPublicKey)
        val hello = BridgeWire.encode(HelloFrame(serverKey))
        assertTrue(BridgeWire.isHelloFrame(hello), "hello 的 kind/ENC/idLen 三项必须都对")
        assertTrue(!BridgeWire.isEncrypted(hello), "hello 是明文帧")
        assertEquals(WireKind.HELLO, hello[3].toInt() and 0xFF)
        assertEquals(0, hello[4].toInt() and BridgeWire.FLAG_ENC, "hello 不能带 ENC 位")
        assertEquals(0, hello[4].toInt() and 0xFC, "hello 不能带未知 flags 位")

        val decoded = assertIs<HelloFrame>(assertIs<WireDecode.Ok>(BridgeWire.decode(hello)).frame)
        assertEquals(serverKey, decoded.publicKeyHex)
        assertTrue(BridgeCrypto.isOnCurve(BridgeCrypto.fromHex(decoded.publicKeyHex)), "hello 里带的必须是合法 P-256 点")

        // 把 hello 交给封装必须在本地就被拒（它是"还没有密钥"时唯一能读的帧）
        assertFailsWith<BridgeCryptoException> { BridgeWire.sealMessage(hello, CryptoVectors.session(BridgeCrypto.Role.SERVER)) }
    }

    @Test
    fun `叠两层封装被拒（内层本身不能是密文）`() {
        val sender = CryptoVectors.session(BridgeCrypto.Role.CLIENT)
        val once = BridgeWire.sealMessage(BridgeCrypto.fromHex(vectors.frames.clientToServer[0].innerHex), sender)
        assertFailsWith<BridgeCryptoException> { BridgeWire.sealMessage(once, sender) }
    }

    @Test
    fun `重放：同一条外层帧开第二次必须被拒`() {
        val receiver = CryptoVectors.session(BridgeCrypto.Role.SERVER)
        val outer = BridgeCrypto.fromHex(vectors.frames.clientToServer[0].outerHex)
        BridgeWire.openMessage(outer, receiver)
        assertFailsWith<BridgeCryptoException> { BridgeWire.openMessage(outer, receiver) }
    }

    @Test
    fun `结构上限把封装开销算进去：v5 比 v4 多 295`() {
        assertEquals(295, BridgeWire.SEALED_OVERHEAD_BYTES, "外层头 12 + 最大 id 255 + nonce 12 + tag 16")
        for (kind in listOf(WireKind.REQ, WireKind.RES, WireKind.ERR, WireKind.EVT, WireKind.HELLO, WireKind.BIN)) {
            assertEquals(
                BridgeWire.hardLimitFor(kind) + 295,
                BridgeWire.sealedHardLimitFor(kind),
                "kind=$kind 的外层上限必须是内层上限 + 295",
            )
        }
        assertTrue(BridgeWire.sealedHardLimitFor(WireKind.BIN) > BridgeWire.sealedHardLimitFor(WireKind.REQ))
    }

    private fun decodeSealed(
        outerHex: String,
        session: BridgeCrypto.Session,
    ): BridgeFrame = assertIs<WireDecode.Ok>(BridgeWire.decode(BridgeWire.openMessage(BridgeCrypto.fromHex(outerHex), session))).frame
}

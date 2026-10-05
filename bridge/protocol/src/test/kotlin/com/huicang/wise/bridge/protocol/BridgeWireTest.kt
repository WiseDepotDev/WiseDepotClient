package com.huicang.wise.bridge.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * v4/v5 线格式的可执行证据（帧头部分）。
 *
 * v3 的 `BridgeFrameCodecTest` 钉的是"`v` / `type` 这两个键名必须出现在 JSON 里"；
 * v4 把版本、判别字段与 id 全部搬进 12 字节帧头，所以这里钉的是**字节布局**与
 * **拒绝路径**——线格式只有一处定义（[BridgeWire]），这里就是它的规格。
 * v5 起多了 `ENC` 位与 `hello` 帧，加密封装本身在 [BridgeSealedFrameTest] 里钉。
 */
class BridgeWireTest {
    @Test
    fun `帧头逐字节固定：magic 版本 kind flags hdrExt 长度都是约定值`() {
        val bytes = BridgeWire.encode(ReqFrame(id = "c-1", method = "device.list"))

        // magic 'W','B' / ver=5 / kind=REQ(1) / flags=FINAL(1) / hdrExt=0 / idLen=3(小端)
        assertContentEquals(
            byteArrayOf(0x57, 0x42, 5, 0x01, 0x01, 0x00, 0x03, 0x00),
            bytes.copyOfRange(0, 8),
            "帧头前 8 字节是整个协议的锚点，不允许漂",
        )
        val bodyLen = bytes.size - BridgeWire.HEADER_BYTES - 3
        assertContentEquals(
            byteArrayOf(
                (bodyLen and 0xFF).toByte(),
                ((bodyLen ushr 8) and 0xFF).toByte(),
                ((bodyLen ushr 16) and 0xFF).toByte(),
                ((bodyLen ushr 24) and 0xFF).toByte(),
            ),
            bytes.copyOfRange(8, 12),
            "bodyLen 必须是**小端 u32**",
        )
        assertEquals("c-1", String(bytes, BridgeWire.HEADER_BYTES, 3, Charsets.UTF_8))
    }

    @Test
    fun `各类帧往返后不串味，且 bin 的 final 标志保真`() {
        val frames: List<BridgeFrame> =
            listOf(
                ReqFrame(id = "1", method = "device.list"),
                ResFrame(id = "1", data = buildJsonObject { put("total", 3) }, meta = ResMeta(ts = 1L, cache = "miss")),
                ErrFrame(id = "1", error = BridgeError(code = BridgeErrorCodes.METHOD_UNKNOWN)),
                EvtFrame(topic = "scan.code", data = buildJsonObject { put("code", "TAG-0001") }),
                BinFrame(id = "1", body = byteArrayOf(1, 2, 3), final = false),
                HelloFrame(publicKeyHex = "04" + "ab".repeat(64)),
            )

        val decoded = frames.map { assertIs<WireDecode.Ok>(BridgeWire.decode(BridgeWire.encode(it))).frame }

        assertIs<ReqFrame>(decoded[0])
        assertIs<ResFrame>(decoded[1])
        assertIs<ErrFrame>(decoded[2])
        assertIs<EvtFrame>(decoded[3])
        val bin = assertIs<BinFrame>(decoded[4])
        assertContentEquals(byteArrayOf(1, 2, 3), bin.body)
        assertEquals("1", bin.id, "数据面必须能只靠帧头与请求对上")
        assertTrue(!bin.final, "FINAL 标志必须真的写到线上")
        assertEquals("04" + "ab".repeat(64), assertIs<HelloFrame>(decoded[5]).publicKeyHex, "hello 只搬公钥，别的什么都不带")
    }

    @Test
    fun `正文里不再出现 版本 判别 id ok —— 它们已经搬进帧头`() {
        val bytes = BridgeWire.encode(ResFrame(id = "7f3a-1", data = buildJsonObject { put("total", 3) }))
        val body = String(bytes, BridgeWire.HEADER_BYTES + 5, bytes.size - BridgeWire.HEADER_BYTES - 5, Charsets.UTF_8)

        assertTrue(!body.contains("\"v\":"), "版本在帧头，正文里不该再有一份：$body")
        assertTrue(!body.contains("\"type\":"), "判别字段在帧头，正文里不该再有一份：$body")
        assertTrue(!body.contains("\"id\":"), "id 只在帧头，两处各存一份必然写出不一致：$body")
        assertTrue(!body.contains("\"ok\":"), "成功由 kind 表达，ok 是第二份事实：$body")
        assertTrue(body.contains("\"total\":3"), "语义字段必须原样保留：$body")
    }

    @Test
    fun `结构不合法的帧按原因分档拒绝，且尽力带上 id`() {
        val good = BridgeWire.encode(ReqFrame(id = "keep", method = "device.list"))

        // magic 不对：连 id 都不该乱猜
        val badMagic = good.copyOf()
        badMagic[0] = 0x00
        assertEquals(WireFault.BAD_MAGIC, assertIs<WireDecode.Rejected>(BridgeWire.decode(badMagic)).fault)
        assertEquals("", assertIs<WireDecode.Rejected>(BridgeWire.decode(badMagic)).id)

        // 版本不对：宁可不认，也不静默按别的版本解析
        val badVer = good.copyOf()
        badVer[2] = 3
        assertEquals(WireFault.BAD_VERSION, assertIs<WireDecode.Rejected>(BridgeWire.decode(badVer)).fault)

        // 未知 kind
        val badKind = good.copyOf()
        badKind[3] = 0x7F
        assertEquals(WireFault.BAD_KIND, assertIs<WireDecode.Rejected>(BridgeWire.decode(badKind)).fault)

        // 未知 flags 位：必须报错，不许当没看见（否则将来加位就是静默不兼容）
        val badFlags = good.copyOf()
        badFlags[4] = 0x04
        assertEquals(WireFault.BAD_FLAGS, assertIs<WireDecode.Rejected>(BridgeWire.decode(badFlags)).fault)

        // ENC 位出现在**明文/内层**帧上也是 BAD_FLAGS：这一层只解明文，密文要先过 openMessage
        val encOnPlain = good.copyOf()
        encOnPlain[4] = (BridgeWire.FLAG_FINAL or BridgeWire.FLAG_ENC).toByte()
        assertEquals(WireFault.BAD_FLAGS, assertIs<WireDecode.Rejected>(BridgeWire.decode(encOnPlain)).fault)

        // 扩展头非 0：本版本不支持，必须报错而不是跳过
        val badExt = good.copyOf()
        badExt[5] = 1
        assertEquals(WireFault.BAD_EXT, assertIs<WireDecode.Rejected>(BridgeWire.decode(badExt)).fault)

        // 头都不完整
        assertEquals(WireFault.TRUNCATED, assertIs<WireDecode.Rejected>(BridgeWire.decode(good.copyOf(8))).fault)

        // 声明长度与实际不符（截断的正文）
        assertEquals(WireFault.BAD_LENGTH, assertIs<WireDecode.Rejected>(BridgeWire.decode(good.copyOf(good.size - 1))).fault)

        // 正文不是合法 JSON
        val badBody = good.copyOf()
        for (i in BridgeWire.HEADER_BYTES + 4 until badBody.size) {
            badBody[i] = '{'.code.toByte()
        }
        assertEquals(WireFault.BAD_BODY, assertIs<WireDecode.Rejected>(BridgeWire.decode(badBody)).fault)

        // 拒绝时也要能把 id 告诉调用方（否则界面只能显示"帧坏了"）
        assertEquals("keep", BridgeWire.headerId(good))
    }

    @Test
    fun `控制面与数据面的结构上限不同：控制面小、数据面大`() {
        assertTrue(
            BridgeWire.hardLimitFor(WireKind.BIN) > BridgeWire.hardLimitFor(WireKind.REQ),
            "数据面就是为中等二进制对象开的通道，上限必须比控制面大",
        )
        assertEquals(
            BridgeWire.HARD_CONTROL_BYTES,
            BridgeProtocol.MAX_FRAME_BYTES * 4,
            "控制面的结构上限是它的策略上限的 4 倍：够把错误路径走完，又不至于被一次分配拖死",
        )
        assertEquals(BridgeProtocol.MAX_BIN_BYTES, BridgeWire.hardLimitFor(WireKind.BIN))
    }
}

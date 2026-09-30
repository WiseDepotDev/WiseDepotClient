package com.huicang.wise.bridge.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * 帧编解码的往返测试。
 *
 * 这是"协议冻结"的可执行证据：字段名（`v` 而不是 `version`、判别字段 `type`）、
 * 默认值是否真的写进报文、四类帧能否互不串味，全部在这里被固定下来。
 */
class BridgeFrameCodecTest {
    @Test
    fun `req 帧的判别字段是 type 且版本字段是 v`() {
        val frame = ReqFrame(id = "c-1", method = "inventory.list", params = buildJsonObject { put("page", 1) })

        val text = BridgeCodec.encode(frame)

        assertTrue(text.contains("\"type\":\"req\""), "缺少判别字段：$text")
        assertTrue(text.contains("\"v\":${BridgeProtocol.VERSION}"), "版本字段必须真的写到网络上去：$text")
        assertTrue(!text.contains("\"version\""), "线格式里不允许出现 version 这个键名：$text")
    }

    @Test
    fun `四类帧往返后类型不串味`() {
        val frames: List<BridgeFrame> =
            listOf(
                ReqFrame(id = "1", method = "device.list"),
                ResFrame(id = "1", data = buildJsonObject { put("total", 3) }, meta = ResMeta(ts = 1L, cache = "miss")),
                ErrFrame(id = "1", error = BridgeError(code = BridgeErrorCodes.METHOD_UNKNOWN)),
                EvtFrame(topic = "scan.code", data = buildJsonObject { put("code", "TAG-0001") }),
            )

        val decoded = frames.map { BridgeCodec.decode(BridgeCodec.encode(it)) }

        assertIs<ReqFrame>(decoded[0])
        assertIs<ResFrame>(decoded[1])
        assertIs<ErrFrame>(decoded[2])
        assertIs<EvtFrame>(decoded[3])
    }

    @Test
    fun `res 帧的 data 原样保留后端 payload_data`() {
        val backendData =
            buildJsonObject {
                put("rows", 7)
                put("total", 42)
            }

        val decoded = BridgeCodec.decode(BridgeCodec.encode(ResFrame(id = "1", data = backendData)))

        assertEquals(backendData, assertIs<ResFrame>(decoded).data)
    }

    @Test
    fun `bootstrap 的能力判定用的是能力表而不是平台字符串`() {
        val bootstrap =
            BridgeBootstrap(
                port = 51234,
                token = "t",
                platform = BridgeCapabilities.PLATFORM_MOBILE,
                ver = "1.0.0",
                capabilities = listOf(BridgeCapabilities.SCAN_CAMERA, BridgeCapabilities.NFC_READ),
            )

        assertTrue(bootstrap.supports(BridgeCapabilities.NFC_READ))
        assertTrue(!bootstrap.supports(BridgeCapabilities.SCAN_GUN_SERIAL))
        assertTrue(!bootstrap.supports(BridgeCapabilities.WINDOW_MULTI))
    }

    @Test
    fun `共同能力集必须是手机与桌面都能满足的子集`() {
        // 这条断言的意义：UI 可以无条件使用 common 里的能力，
        // 因此任何人往 common 里塞平台专属能力时，测试会先炸。
        assertEquals(setOf(BridgeCapabilities.SECURE_STORE, BridgeCapabilities.OFFLINE_QUEUE, BridgeCapabilities.PRINT_SYSTEM), BridgeCapabilities.common)
    }
}

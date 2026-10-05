package com.huicang.wise.bridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** 引导契约：能力判定与 v4 上限下发。 */
class BridgeBootstrapTest {
    @Test
    fun `能力判定用的是能力表而不是平台字符串`() {
        val bootstrap =
            BridgeBootstrap(
                port = 51234,
                psk = "t",
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
        //
        // 曾经这里断言的是 `{storage.secure, offline.queue, print.system}` ——
        // 而两个壳一项都没实现后两个。断言"常量等于某个值"挡不住**常量本身在说谎**，
        // 所以这里改成对齐两个壳的真实声明（见 ShellBridge.kt 与 desktop 的 --capabilities）。
        assertEquals(
            setOf(BridgeCapabilities.SECURE_STORE, BridgeCapabilities.SCAN_GUN_KEYBOARD),
            BridgeCapabilities.common,
        )
    }

    @Test
    fun `v4 上限随引导下发，客户端不必硬编码常量`() {
        val bootstrap =
            BridgeBootstrap(port = 1, psk = "t", platform = BridgeCapabilities.PLATFORM_DESKTOP, ver = "1.0.0")

        assertEquals(BridgeProtocol.MAX_FRAME_BYTES, bootstrap.limits.textMaxBytes)
        assertEquals(BridgeProtocol.MAX_BIN_BYTES, bootstrap.limits.binMaxBytes)
        assertTrue(bootstrap.limits.binMaxBytes > bootstrap.limits.textMaxBytes)
    }

    @Test
    fun `协议版本是 5 且与线格式同源`() {
        assertEquals(5, BridgeProtocol.VERSION, "v5 是「帧内容加密」这一版，版本号必须跟着走")
    }
}

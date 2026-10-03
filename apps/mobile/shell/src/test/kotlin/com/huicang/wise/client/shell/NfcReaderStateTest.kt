package com.huicang.wise.client.shell

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * NFC 纯逻辑单测（B3/S2 + S3）：三态判定、去抖、事件载荷、本机方法表。
 *
 * ## 为什么这一份单测值得先修门禁再写
 *
 * S2a 时写过一份同样的测试，跑 `:apps:mobile:shell:testDebugUnitTest` 得到
 * **BUILD SUCCESSFUL 而 `build/test-results` 是空的** —— Android 模块默认按 JUnit4
 * 发现用例，JUnit5 的 `@Test` 被静默跳过。当时为了不与相机会话抢 `build.gradle.kts`
 * 而把测试删了。现在（S3/S4 收口）补上 `useJUnitPlatform()` 并把测试加回来。
 *
 * **"测试跑起来了"这件事本身需要有证据**：`check-nfc.mjs` 会静态核对
 * `useJUnitPlatform()` 在、且这里的用例数 > 0；真正跑起来的计数由
 * `build/test-results/testDebugUnitTest` 下的 `tests=` 给出（见 brief §8 记账）。
 *
 * 这一层刻意不碰任何 android 类（`NfcReader` 那部分只能真机验），
 * 于是可以在 JVM 上把"容易写错却不会报错"的那些情形穷举：
 *  - "没有硬件但系统开关是 on" 判成 DISABLED 会画出一个**用户开不了**的「去开启」；
 *  - 不做去抖**不会崩**，只会让界面被同一张卡刷屏 —— 正因为不崩才最容易被漏掉。
 */
class NfcReaderStateTest {
    // ---- 三态判定 ----

    @Test
    fun `没有硬件就是 UNSUPPORTED，哪怕系统开关报的是已开启`() {
        // 这个组合在真机上会出现（适配器为 null 而某个 ROM 的开关状态是 on）。
        // 判成 DISABLED 的后果是界面给出「去开启」—— 一条用户点了也没用的出路。
        assertEquals(NfcAvailability.UNSUPPORTED, NfcReaderState.decide(adapterPresent = false, adapterEnabled = true))
        assertEquals(NfcAvailability.UNSUPPORTED, NfcReaderState.decide(adapterPresent = false, adapterEnabled = false))
    }

    @Test
    fun `有硬件但关着是 DISABLED（有出路），开着是 READY`() {
        assertEquals(NfcAvailability.DISABLED, NfcReaderState.decide(adapterPresent = true, adapterEnabled = false))
        assertEquals(NfcAvailability.READY, NfcReaderState.decide(adapterPresent = true, adapterEnabled = true))
    }

    // ---- 错误码与状态载荷：跨语言线上串，逐字钉住 ----

    @Test
    fun `错误码与 TS 侧 BridgeErrorCode 逐字一致，且 READY 没有错误码`() {
        assertEquals("BRIDGE_NFC_UNSUPPORTED", NfcReaderState.errorCodeFor(NfcAvailability.UNSUPPORTED))
        assertEquals("BRIDGE_NFC_DISABLED", NfcReaderState.errorCodeFor(NfcAvailability.DISABLED))
        assertNull(NfcReaderState.errorCodeFor(NfcAvailability.READY))
    }

    @Test
    fun `状态载荷只有 on off unsupported 三种取值`() {
        assertEquals("unsupported", NfcReaderState.statePayloadFor(NfcAvailability.UNSUPPORTED))
        assertEquals("off", NfcReaderState.statePayloadFor(NfcAvailability.DISABLED))
        assertEquals("on", NfcReaderState.statePayloadFor(NfcAvailability.READY))
    }

    @Test
    fun `事件 topic 与 TS 侧 BRIDGE_EVENT_NFC 逐字一致`() {
        assertEquals("nfc.tag", NfcReaderState.EVENT_TAG)
        assertEquals("nfc.state", NfcReaderState.EVENT_STATE)
    }

    // ---- 事件载荷（Web 侧唯一的输入，键名写错的表现是界面永远停在"未知"）----

    @Test
    fun `nfc_state 载荷是 {state}，键名与取值都不能变`() {
        val payload = NfcReaderState.stateEventPayload(NfcAvailability.DISABLED)
        assertEquals(setOf("state"), payload.keys)
        assertEquals("off", payload["state"]?.jsonPrimitive?.content)
    }

    @Test
    fun `nfc_tag 载荷是 {id, tech, at}，at 是毫秒数字`() {
        val payload = NfcReaderState.tagEventPayload("04a1b2c3", "NfcA", 1_731_000_000_000L)
        assertEquals(setOf("id", "tech", "at"), payload.keys)
        assertEquals("04a1b2c3", payload["id"]?.jsonPrimitive?.content)
        assertEquals("NfcA", payload["tech"]?.jsonPrimitive?.content)
        assertEquals(1_731_000_000_000L, payload["at"]?.jsonPrimitive?.content?.toLong())
    }

    // ---- 去抖：同一张静止的卡会被 ReaderCallback 连续回调 ----

    @Test
    fun `同一张卡在窗口内只上报一次`() {
        val debouncer = NfcDebouncer()
        assertTrue(debouncer.shouldReport("aa", 0))
        assertTrue(!debouncer.shouldReport("aa", 50), "50ms 后的同一次连击不该上报")
        assertTrue(!debouncer.shouldReport("aa", 1_499))
    }

    @Test
    fun `窗口边界按小于判，正好一个窗口后算新的一次`() {
        val debouncer = NfcDebouncer(windowMs = 1_500)
        assertTrue(debouncer.shouldReport("aa", 0))
        assertTrue(!debouncer.shouldReport("aa", 1_499))
        assertTrue(debouncer.shouldReport("aa", 1_500), "抬起再贴一次仍应是新的一次")
    }

    @Test
    fun `换了一张卡立刻上报（那不是连击，是真实事件）`() {
        val debouncer = NfcDebouncer()
        assertTrue(debouncer.shouldReport("aa", 0))
        assertTrue(debouncer.shouldReport("bb", 10))
        // 再回到 aa：上一张是 bb，所以也算"换了一张"
        assertTrue(debouncer.shouldReport("aa", 20))
    }

    @Test
    fun `切后台 reset 之后，同一张卡立刻算新的一次`() {
        val debouncer = NfcDebouncer()
        assertTrue(debouncer.shouldReport("aa", 0))
        assertTrue(!debouncer.shouldReport("aa", 100))
        debouncer.reset()
        assertTrue(debouncer.shouldReport("aa", 120), "停了十分钟再贴同一张，不该被当成连击")
    }

    // ---- 系统开关被拨动（通知栏那枚开关不会 pause Activity）----

    @Test
    fun `系统开关被拨动：开着就重连，关着必须先停再报状态`() {
        assertEquals(NfcAdapterChangeAction.RECONNECT, NfcReaderState.actionAfterAdapterChange(NfcAvailability.READY))
        /*
         * 这两条是同一个陷阱：**只重新 start() 不够**。
         * 关掉时 `NfcReader.reading` 还立着 true（我们没 stop），而系统那边已经丢了 reader mode；
         * 等 NFC 再打开，start() 会以为"已经在读"而不再注册 —— 表现是界面说"就绪"、贴卡没反应。
         */
        assertEquals(NfcAdapterChangeAction.STOP_THEN_REPORT, NfcReaderState.actionAfterAdapterChange(NfcAvailability.DISABLED))
        assertEquals(NfcAdapterChangeAction.STOP_THEN_REPORT, NfcReaderState.actionAfterAdapterChange(NfcAvailability.UNSUPPORTED))
    }

    // ---- 本机方法表（B3/S3）----

    @Test
    fun `本机方法表登记 nfc_openSettings，字符串与协议层常量逐字一致`() {
        val methods = NfcLocalMethods()
        assertEquals(setOf("nfc.openSettings"), methods.methodIds)
        assertEquals(
            com.huicang.wise.bridge.protocol.BridgeLocalMethods.NFC_OPEN_SETTINGS,
            methods.methodIds.single(),
        )
    }

    @Test
    fun `没有前台 reader 时 openSettings 如实回 {opened=false}，不假装成功`() {
        NfcReaderHost.attach(null)
        val payload = runBlocking { NfcLocalMethods().invoke("nfc.openSettings", null) }
        assertEquals(setOf("opened"), (payload as JsonObject).keys)
        assertEquals(false, payload["opened"]?.jsonPrimitive?.content?.toBoolean())
    }

    @Test
    fun `没登记的方法一律抛出（白名单是三段并集，本机这一段不许自己放行）`() {
        assertFailsWith<IllegalArgumentException> {
            runBlocking { NfcLocalMethods().invoke("nfc.start", JsonPrimitive("x")) }
        }
    }
}

package com.huicang.wise.bridge.protocol

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonPrimitive

/**
 * 消息层分片装配的回归。
 *
 * 这是 v3 那条"两条传输行为必须逐条一致"纪律的**结构性落点**：
 * 装配只有一份实现，所以"两面行为不一致"这类 bug 从"要靠人对"
 * 变成"要么一起对、要么一起错"。
 */
class WireReaderTest {
    @Test
    fun `单个分片直接产出完整消息`() {
        val message = BridgeWire.encode(ReqFrame(id = "1", method = "device.list"))
        val reader = WireReader()

        val result = assertIs<WireRead.Complete>(reader.accept(message, last = true))

        assertContentEquals(message, result.message)
    }

    @Test
    fun `多个分片按到达顺序拼接`() {
        val message = BridgeWire.encode(ReqFrame(id = "2", method = "device.list", params = JsonPrimitive("abcdef")))
        val split = 17
        val reader = WireReader()

        assertEquals(WireRead.NeedMore, reader.accept(message.copyOfRange(0, split), last = false))
        val result = assertIs<WireRead.Complete>(reader.accept(message.copyOfRange(split, message.size), last = true))

        assertContentEquals(message, result.message)
    }

    @Test
    fun `控制面超过结构上限：按帧头里的 kind 早拒，并保留 id 供错误回包`() {
        val huge =
            BridgeWire.encode(
                ReqFrame(id = "big", method = "m", params = JsonPrimitive("x".repeat(2 * 1024 * 1024))),
            )
        val result = assertIs<WireRead.OverLimit>(WireReader().accept(huge, last = true))

        assertTrue(!result.needsMore, "已经是最后一片，可以立刻回错误")
        assertEquals("big", result.id, "超大帧的错误也必须能对上号（v3 的教训）")
    }

    @Test
    fun `数据面在上限之内：即使大于控制面上限也放行`() {
        val body = ByteArray(300 * 1024) { 7 }
        val message = BridgeWire.encode(BinFrame(id = "3", body = body))

        assertTrue(
            message.size > BridgeProtocol.MAX_FRAME_BYTES,
            "这条用例的前提就是它超过了控制面上限（本测试才有意义）",
        )
        val result = assertIs<WireRead.Complete>(WireReader().accept(message, last = true))

        assertContentEquals(message, result.message)
    }

    @Test
    fun `reset 之后不会把上一条消息的字节带进来`() {
        val reader = WireReader()
        val first = BridgeWire.encode(ReqFrame(id = "a", method = "m"))
        reader.accept(first.copyOfRange(0, 5), last = false)

        reader.reset()
        val second = BridgeWire.encode(ReqFrame(id = "b", method = "m"))
        val result = assertIs<WireRead.Complete>(reader.accept(second, last = true))

        assertContentEquals(second, result.message, "reset 之后必须从 0 开始，否则两条消息会被粘在一起")
    }

    @Test
    fun `kind 还没读到时按控制面的较小上限保守处理`() {
        val reader = WireReader()
        // 只给 2 个字节：连 kind 都不知道，此时不该为它预留 8MiB
        assertEquals(WireRead.NeedMore, reader.accept(byteArrayOf(0x57, 0x42), last = false))
        assertEquals(2, reader.bytes)
    }
}

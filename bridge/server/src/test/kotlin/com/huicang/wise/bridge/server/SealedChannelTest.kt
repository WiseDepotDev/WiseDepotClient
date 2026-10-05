package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeCrypto
import com.huicang.wise.bridge.protocol.BridgeCryptoException
import com.huicang.wise.bridge.protocol.BridgeWire
import com.huicang.wise.bridge.protocol.HelloFrame
import com.huicang.wise.bridge.protocol.ResFrame
import com.huicang.wise.bridge.protocol.WireDecode
import java.util.Collections
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * [SealedChannel] 的**发送序**不变量：**取号与写出必须在同一个临界区**。
 *
 * ## 这条测试来自一次真实的现场故障
 *
 * 加密刚上线时，界面反复"正在重连本地服务"，控制台里刷的是：
 *
 * ```
 * [bridge] 加解密失败，已丢弃这条连接：序号回退/重放：已收到 27，又收到 26
 * ```
 *
 * 原因不是密钥、也不是重放攻击，而是**服务端把两条并发回复写反了**：
 * `seal()` 取号与 `write()` 是两步，中间一次线程切换就能让 27 先上线、26 后上线；
 * 而接收端按"单调递增"判重放，于是**把整条连接丢掉**。
 *
 * 现场的触发条件是"页面并发发几个请求"（看板/列表同时拉数），所以它是必现的、不是偶发。
 */
class SealedChannelTest {
    private val psk = "test-psk-0123456789".toByteArray(Charsets.UTF_8)

    /**
     * 建一条"服务端 → 客户端"的配对：返回服务端的 [SealedChannel] 与客户端的会话。
     *
     * 顺带把 [SealedChannel.handshake] 走通一遍（hello 里的公钥能被拿去算同一把会话密钥）。
     */
    private fun pair(): Pair<SealedChannel, BridgeCrypto.Session> {
        val clientEcdh = BridgeCrypto.generateEphemeral()
        val server = SealedChannel.handshake(clientEcdh.publicKey, psk)
        val hello = assertInstanceOf(HelloFrame::class.java, assertInstanceOf(WireDecode.Ok::class.java, BridgeWire.decode(server.helloFrame)).frame)
        val serverPublicKey = BridgeCrypto.fromHex(hello.publicKeyHex)
        val shared = BridgeCrypto.sharedSecret(clientEcdh, serverPublicKey)
        val keys = BridgeCrypto.sessionKeys(psk, clientEcdh.publicKey, serverPublicKey, shared)
        return server to BridgeCrypto.Session(keys, BridgeCrypto.Role.CLIENT)
    }

    /**
     * 从**外层**消息里读出 nonce 的序号。
     *
     * 外层 = `12 字节头 + id + [nonce(12) ‖ 密文 ‖ tag]`，所以序号要从**正文**里读
     * （直接对外层调 `nonceOf` 会读到 magic 的第一个字节 —— 第一版就是这么写错的）。
     */
    private fun seqOfOuter(outer: ByteArray): Long {
        val idLen = (outer[6].toInt() and 0xFF) or ((outer[7].toInt() and 0xFF) shl 8)
        val body = outer.copyOfRange(BridgeWire.HEADER_BYTES + idLen, outer.size)
        return BridgeCrypto.nonceOf(BridgeCrypto.DIR_SERVER_TO_CLIENT, body)
    }

    @Test
    fun `并发 sealAndSend：线序与序号序必须一致（8 线程 × 50 条）`() {
        val (server, _) = pair()
        val wireOrder = Collections.synchronizedList(mutableListOf<Long>())

        val threads =
            (1..8).map {
                Thread {
                    repeat(50) {
                        server.sealAndSend(ResFrame(id = "c-$it")) { bytes ->
                            // 记录"写出去的那一帧"的序号 —— 这就是对端会看到的顺序
                            wireOrder += seqOfOuter(bytes)
                        }
                    }
                }
            }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        assertEquals(400, wireOrder.size, "8 × 50 条都要写出去")
        assertEquals(400L, server.sentSeq(), "序号不能重复也不能跳（取号在临界区里）")
        assertTrue(
            wireOrder.toList() == wireOrder.sorted(),
            "线序必须非递减，否则接收端会判成「序号回退」把连接丢掉：${wireOrder.take(20)}…",
        )
    }

    @Test
    fun `对照：封装与写分开就会乱序，接收端按序号回退拒绝`() {
        val (server, client) = pair()

        // 手动分开两步，并**故意**按相反顺序写出（这正是并发下会真实发生的事）
        val first = server.seal(ResFrame(id = "c-1"))
        val second = server.seal(ResFrame(id = "c-2"))
        assertEquals(seqOfOuter(first) + 1, seqOfOuter(second), "两次取号是连续的")

        // 先到 2、后到 1（真实线序）
        BridgeWire.openMessage(second, client)
        assertThrows(BridgeCryptoException::class.java, { BridgeWire.openMessage(first, client) }, "序号回退必须被拒 —— 这就是那条现场日志")
    }

    @Test
    fun `正常顺序：配对的两端能一来一往`() {
        val (server, client) = pair()
        val bytes = server.sealAndSend(ResFrame(id = "c-1")) { it }
        val frame = assertInstanceOf(WireDecode.Ok::class.java, BridgeWire.decode(BridgeWire.openMessage(bytes, client))).frame
        assertEquals("c-1", assertInstanceOf(ResFrame::class.java, frame).id)
        assertEquals(1L, server.sentSeq())
        assertEquals(1L, client.receivedSeq)
    }
}

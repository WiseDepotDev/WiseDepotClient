package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * 桥服务端的"金丝雀"：**先把现有行为钉住，再改实现**。
 *
 * 这一批测试的意义不在于覆盖多少分支，而在于：
 *  1. 让 `:bridge:server` 从"零测试"变成**有可用的端到端底座**（真 socket + 假后端）；
 *  2. 之后每一次重构（连接生命周期、背压、会话判定）都有一条"改坏了当场红"的线；
 *  3. 两条传输**用同一份断言**过一遍 —— 这正是仓库一直在强调的"语义一致"，
 *     以前只能靠人对着两份代码看。
 */
class BridgeCanaryTest {
    private fun server(
        transport: BridgeTransportKind,
        backend: FakeBackend = FakeBackend(),
        tokens: FakeTokenStore = FakeTokenStore(),
    ): BridgeServer {
        val config =
            BridgeServerConfig(
                port = 0,
                token = TEST_TOKEN,
                backend = backend,
                platform = FakePlatform(),
                tokens = tokens,
                transport = transport,
                host = "127.0.0.1",
            )
        return BridgeServer(config)
    }

    private fun withServer(
        transport: BridgeTransportKind,
        block: (BridgeServer, Int, FakeBackend) -> Unit,
    ) {
        val backend = FakeBackend()
        val srv = server(transport, backend)
        val port = srv.start()
        try {
            block(srv, port, backend)
        } finally {
            srv.stop()
        }
    }

    private fun wsUrl(port: Int) = "ws://127.0.0.1:$port/bridge?token=$TEST_TOKEN"

    @Test
    fun `内建 bridge_ping 在两条传输上都答同一个形状`() {
        for (transport in BridgeTransportKind.entries) {
            withServer(transport) { _, port, _ ->
                TestWsClient(wsUrl(port)).use { client ->
                    client.send(reqFrame("p1", "bridge.ping"))
                    val reply = client.awaitFrame()
                    assertNotNull(reply, "$transport：内建方法没有应答")
                    assertEquals("p1", frameId(reply), "$transport：id 必须原样带回")
                    val res = reply as? com.huicang.wise.bridge.protocol.ResFrame
                    assertNotNull(res, "$transport：应当是 res 帧，实得 $reply")
                    val data = res!!.data.toString()
                    assertTrue(data.contains("\"protocol\":4"), "$transport：ping 要回协议版本，实得 $data")
                }
            }
        }
    }

    @Test
    fun `未登记的方法一律 BRIDGE_METHOD_UNKNOWN（桥不是通用透传）`() {
        for (transport in BridgeTransportKind.entries) {
            withServer(transport) { _, port, backend ->
                TestWsClient(wsUrl(port)).use { client ->
                    client.send(reqFrame("m1", "definitely.not.a.method"))
                    val reply = client.awaitFrame()
                    assertEquals("m1", frameId(reply))
                    assertEquals(
                        BridgeErrorCodes.METHOD_UNKNOWN,
                        errCode(reply),
                        "$transport：未知方法必须被拒绝且不错打到后端",
                    )
                    assertTrue(backend.calls.isEmpty(), "$transport：未知方法不该产生后端调用")
                }
            }
        }
    }

    @Test
    fun `非法帧与超限帧都给出可诊断的错误码，而不是断开`() {
        for (transport in BridgeTransportKind.entries) {
            withServer(transport) { _, port, _ ->
                TestWsClient(wsUrl(port)).use { client ->
                    // 1) 结构不合法的二进制消息（magic 不对）
                    client.sendRaw(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14))
                    assertEquals(
                        BridgeErrorCodes.WIRE_MODE,
                        errCode(client.awaitFrame()),
                        "$transport：结构不合法的帧要回 WIRE_MODE",
                    )

                    // 2) v3 的文本帧：v4 明确拒绝，不静默兼容（半兼容比明确失败更难查）
                    client.sendTextRaw("""{"v":3,"type":"req","id":"legacy","method":"bridge.ping"}""")
                    assertEquals(
                        BridgeErrorCodes.WIRE_MODE,
                        errCode(client.awaitFrame()),
                        "$transport：文本帧要回 WIRE_MODE",
                    )

                    // 3) 控制面正文超协议上限：必须拒，且回一条**带 id** 的错误（超大帧也要能对上号）
                    val huge = "x".repeat(com.huicang.wise.bridge.protocol.BridgeProtocol.MAX_FRAME_BYTES + 64)
                    client.send(reqFrame("big-1", "bridge.ping", jsonParams("pad" to huge)))
                    val tooLarge = client.awaitFrame()
                    assertEquals(
                        BridgeErrorCodes.FRAME_TOO_LARGE,
                        errCode(tooLarge),
                        "$transport：超限帧要回 FRAME_TOO_LARGE",
                    )
                    assertEquals("big-1", frameId(tooLarge), "$transport：超限也要能认出是哪一条")
                }
            }
        }
    }

    @Test
    fun `契约方法按白名单打到后端，并把 data 原样带回`() {
        withServer(BridgeTransportKind.NETTY) { _, port, backend ->
            backend.answerWith { BackendResult.Ok(JsonPrimitive("pong-from-backend")) }
            TestWsClient(wsUrl(port)).use { client ->
                client.send(reqFrame("c1", "dashboard.summary"))
                val reply = client.awaitFrame()
                assertEquals("c1", frameId(reply))
                val res = reply as? com.huicang.wise.bridge.protocol.ResFrame
                assertNotNull(res, "NETTY：应当是 res 帧")
                assertTrue(res!!.data.toString().contains("pong-from-backend"), "后端 data 要透传，实得 ${res.data}")
                assertEquals(1, backend.calls.size)
                // 走的是契约里的路径模板，而不是把方法名当路径发出去
                val expectedPath = com.huicang.wise.bridge.protocol.BridgeContract.find("dashboard.summary")!!.path
                assertEquals(expectedPath, backend.calls.first().pathTemplate)
            }
        }
    }

    @Test
    fun `握手 token 不对时两条传输都拒（401）且不建立会话`() {
        for (transport in BridgeTransportKind.entries) {
            withServer(transport) { _, port, _ ->
                val failed =
                    runCatching {
                        TestWsClient("ws://127.0.0.1:$port/bridge?token=wrong-token").use { it.send(reqFrame("x", "bridge.ping")) }
                    }
                assertTrue(failed.isFailure, "$transport：错误 token 不该握手成功")
            }
        }
    }

    private companion object {
        const val TEST_TOKEN = "test-token-0123456789"
    }
}

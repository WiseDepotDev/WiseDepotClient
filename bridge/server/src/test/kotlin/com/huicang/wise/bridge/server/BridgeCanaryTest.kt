package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import com.huicang.wise.bridge.protocol.BridgeProtocol
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
        preAuthMaxPending: Int = com.huicang.wise.bridge.server.PreAuthGate.DEFAULT_MAX_PENDING,
        preAuthDeadlineMs: Long = 1_500,
    ): BridgeServer {
        val config =
            BridgeServerConfig(
                port = 0,
                psk = TEST_TOKEN,
                backend = backend,
                platform = FakePlatform(),
                tokens = tokens,
                transport = transport,
                host = "127.0.0.1",
                preAuthMaxPending = preAuthMaxPending,
                preAuthDeadlineMs = preAuthDeadlineMs,
                /*
                 * 关掉未读轮询。它是**后台定时任务**：开着的话每条业务请求都会触发一次
                 * `kick()` 补算，于是假后端的 `calls` 里会多出 `user.current` —— 那些
                 * "只准打一次后端"的断言会变成假阳性。轮询器自己的行为由 `UnreadNotifierTest` 验。
                 */
                notifyPollMs = 0,
            )
        return BridgeServer(config)
    }

    /** 起来一个服务器、跑一段、再关掉（WS URL 里 v5 起**不带任何凭据**）。 */
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

    private fun wsUrl(port: Int) = "ws://127.0.0.1:$port/bridge"

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
                    /*
                     * 版本号从权威处取，**不写死**：这里原先写的是 `"protocol":4`，
                     * 协议升到 5 时当场红了一遍 —— 而这类"同一个事实的第二份副本"
                     * 正是 `pnpm check:protocol-version` 存在的理由（那条门禁覆盖 4 处定义，
                     * 覆盖不到测试里的断言，所以断言自己必须去权威处取值）。
                     */
                    assertTrue(
                        data.contains("\"protocol\":${BridgeProtocol.VERSION}"),
                        "$transport：ping 要回协议版本，实得 $data",
                    )
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
    fun `非法帧与超限帧都给出可诊断的错误码`() {
        for (transport in BridgeTransportKind.entries) {
            /*
             * v5：三条用例**各用一条连接**。
             *
             * 为什么不再共用一条：v5 里"不是密文帧"（结构不合法、或 v3 的文本帧）意味着
             * **两端不是同一版协议** —— 说清楚（回 WIRE_MODE）之后就断开，这是刻意的
             * （半兼容的"看起来还能用"比明确失败更难查）。共用连接会让第二条断言读到 null。
             */
            withServer(transport) { _, port, _ ->
                TestWsClient(wsUrl(port)).use { client ->
                    // 1) 结构不合法的二进制消息（magic 不对）
                    client.sendRaw(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14))
                    assertEquals(
                        BridgeErrorCodes.WIRE_MODE,
                        errCode(client.awaitFrame()),
                        "$transport：结构不合法的帧要回 WIRE_MODE",
                    )
                    assertTrue(client.awaitClosed(), "$transport：不是一版协议就该断，而不是继续猜")
                }
            }

            withServer(transport) { _, port, _ ->
                TestWsClient(wsUrl(port)).use { client ->
                    // 2) v3 的文本帧：v5 明确拒绝，不静默兼容（半兼容比明确失败更难查）
                    client.sendTextRaw("""{"v":3,"type":"req","id":"legacy","method":"bridge.ping"}""")
                    assertEquals(
                        BridgeErrorCodes.WIRE_MODE,
                        errCode(client.awaitFrame()),
                        "$transport：文本帧要回 WIRE_MODE",
                    )
                }
            }

            withServer(transport) { _, port, _ ->
                TestWsClient(wsUrl(port)).use { client ->
                    // 3) 控制面正文超协议上限：必须拒，且回一条**带 id** 的错误（超大帧也要能对上号）
                    //    注意这条**不**断开：它是"这条请求太大了"，不是"两端不是一版"
                    val huge = "x".repeat(BridgeProtocol.MAX_FRAME_BYTES + 64)
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
    fun `psk 不对时两条传输都断开（升级能成，但第一条帧解不开）`() {
        /*
         * v5：**身份不再由 URL 承载**，所以"错的 psk"不再表现为握手 401 ——
         * 升级会成功（HTTP 层没有凭据可比），然后第一条密文帧解不开，服务端按
         * "这条连接不可信"（BRIDGE_CRYPTO_FAILED）关掉它。
         *
         * 这条用例证明的正是这件事：**没有 psk 就一句话也说不成**。
         */
        for (transport in BridgeTransportKind.entries) {
            withServer(transport) { _, port, _ ->
                TestWsClient("ws://127.0.0.1:$port/bridge", "wrong-psk-0123456789").use { client ->
                    client.send(reqFrame("x", "bridge.ping"))
                    // 服务端会关掉它：客户端**不该**拿到任何能解开的帧
                    assertTrue(client.awaitClosed(), "$transport：拿错 psk 的连接必须被断开")
                    assertEquals(null, client.awaitFrame(timeoutMs = 300), "$transport：不该收到可解的回复")
                }
            }
        }
    }

    @Test
    fun `连上不说话：预认证池满则拒、截止到点则关、位子会还回来`() {
        /*
         * v5 的预认证池防的就是这件事：升级成功但一条帧都不发（占位）。
         * 两条传输各用各的机制（Netty 用 event loop 调度、自写传输用 socket 读超时），
         * 但**行为必须一样**。这里把池压到 1 位，于是三件事都能被观察到：
         *   ① 第一位被占住时，第二条连接**升级就被拒**（503，不排队等）；
         *   ② 占位那位在截止时间到点后被关掉；
         *   ③ 位子**还回来了** —— 关掉之后新连接能正常认证（否则池会被"连一下就断"耗光）。
         */
        for (transport in BridgeTransportKind.entries) {
            val srv = server(transport, preAuthMaxPending = 1, preAuthDeadlineMs = 600)
            val port = srv.start()
            try {
                val url = "ws://127.0.0.1:$port/bridge"
                val idle = TestWsClient(url, TEST_TOKEN)
                val second = runCatching { TestWsClient(url, TEST_TOKEN).close() }
                assertTrue(second.isFailure, "$transport：预认证池满时第二条连接必须被拒（503）")

                assertTrue(idle.awaitClosed(timeoutMs = 5_000), "$transport：预认证到点必须被关闭")
                idle.close()

                TestWsClient(url, TEST_TOKEN).use { client ->
                    client.send(reqFrame("p1", "bridge.ping"))
                    assertNotNull(client.awaitFrame(), "$transport：位子还回来之后应当能正常认证")
                }
            } finally {
                srv.stop()
            }
        }
    }

}

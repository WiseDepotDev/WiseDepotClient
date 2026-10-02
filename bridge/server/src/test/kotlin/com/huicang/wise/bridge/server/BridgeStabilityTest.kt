package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendErrorCodes
import com.huicang.wise.bridge.backend.BackendResult
import com.huicang.wise.bridge.protocol.BridgeErrorCodes
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.Socket
import java.util.Base64

/**
 * 桥的**稳定性**用例：半死连接、会话判定、背压、观测。
 *
 * 这一组是本轮返工的重点，每条都对应一处"现场真的会疼"的行为：
 *  · 手机切后台后连接半死（WebView 被杀、不发 FIN）→ 必须被回收，否则线程与连接一起泄漏；
 *  · 网络抖动/后端暂时不可达 → **不许**把用户踢回登录屏；
 *  · 失控页面狂发请求 → 必须被就地拒绝，而不是把协程队列堆起来；
 *  · 慢在哪条方法上 → 必须能拉出来看（`bridge.metrics`）。
 */
class BridgeStabilityTest {
    private fun server(
        transport: BridgeTransportKind = BridgeTransportKind.PLAIN_SOCKET,
        backend: FakeBackend = FakeBackend(),
        tokens: FakeTokenStore = FakeTokenStore(),
        readerIdleMs: Long = 60_000,
        pingIntervalMs: Long = 20_000,
        maxPerSecond: Int = 50,
        burst: Int = 100,
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
                readerIdleMs = readerIdleMs,
                plainPingIntervalMs = pingIntervalMs,
                maxPerSecond = maxPerSecond,
                burst = burst,
            )
        return BridgeServer(config)
    }

    /**
     * 半死连接必须被回收。
     *
     * 模拟方式刻意"笨"：自己写一个 **HTTP 升级成功但之后什么都不回** 的裸 socket
     * （WebView 被系统杀掉就是这样：没有 FIN、没有 close、也不再回 pong）。
     * 服务端必须在读空闲上限内把它关掉 —— 否则它的读线程会永久挂在 `read()` 上，
     * 连接还留在广播列表里。
     */
    @Test
    fun `半死连接在读空闲上限内被服务端关闭（不死等、不泄漏）`() {
        val srv = server(readerIdleMs = 800, pingIntervalMs = 300)
        val port = srv.start()
        try {
            Socket("127.0.0.1", port).use { raw ->
                raw.soTimeout = 5_000
                val out = raw.getOutputStream()
                val key = Base64.getEncoder().encodeToString(ByteArray(16) { 7 })
                out.write(
                    (
                        "GET /bridge?token=$TEST_TOKEN HTTP/1.1\r\n" +
                            "Host: 127.0.0.1\r\n" +
                            "Upgrade: websocket\r\n" +
                            "Connection: Upgrade\r\n" +
                            "Sec-WebSocket-Key: $key\r\n" +
                            "Sec-WebSocket-Version: 13\r\n\r\n"
                    ).toByteArray(),
                )
                out.flush()
                // 读掉 101 响应头（读到空行为止）
                val reader = BufferedReader(InputStreamReader(raw.getInputStream()))
                assertTrue(reader.readLine()!!.startsWith("HTTP/1.1 101"), "握手应当成功")
                while (reader.readLine()?.isNotEmpty() == true) {
                    // 跳过响应头
                }

                // 之后什么都不回：服务端应当在 idle（800ms）之后关闭这条连接。
                // 允许 ping 帧先来（那是保活，不是问题），只要最终读到 EOF/关闭即可。
                val deadline = System.currentTimeMillis() + 4_000
                var closed = false
                while (System.currentTimeMillis() < deadline && !closed) {
                    val b = runCatching { raw.getInputStream().read() }.getOrElse { -1 }
                    if (b < 0) {
                        closed = true
                    }
                }
                assertTrue(closed, "半死连接必须被关闭（读空闲 800ms），否则线程会一直挂着")
            }
        } finally {
            srv.stop()
        }
    }

    /**
     * 续期"没能完成"（网络/超时）**不许**被当成登录过期。
     *
     * 这是本轮修掉的一个真 bug：原先 `refresh()` 只要失败就 `markExpired()`
     * ——家里网络抖一下、或应用刚从后台回来那一下，用户就被踢回登录屏。
     */
    @Test
    fun `续期遇到网络失败时保留会话、不广播过期`() {
        val tokens = FakeTokenStore().apply { update("access-old", "refresh-1") }
        val backend =
            FakeBackend().apply {
                answerWith { call ->
                    if (call.pathTemplate.endsWith("/refresh-token")) {
                        // 后端不可达：这是"暂时不可用"，不是"凭据被拒"
                        BackendResult.Failed(BackendErrorCodes.UNREACHABLE, "bridge.backendUnreachable", retryable = true)
                    } else {
                        BackendResult.Failed("AUTH-0001", null, retryable = false)
                    }
                }
            }
        val srv = server(transport = BridgeTransportKind.PLAIN_SOCKET, backend = backend, tokens = tokens)
        val port = srv.start()
        try {
            TestWsClient("ws://127.0.0.1:$port/bridge?token=$TEST_TOKEN").use { client ->
                // 受契约保护的方法：随便挑一条 AUTH 失败会触发续期路径的
                client.send(reqFrame("r1", "dashboard.summary"))
                val reply = client.awaitText()
                assertTrue(reply!!.contains("AUTH-0001"), "原失败要如实回给界面，实得 $reply")
                assertNotNull(tokens.accessToken(), "网络类续期失败不得清掉令牌")
                assertEquals("refresh-1", tokens.refreshToken())
                // 也不该广播 session.expired（那是"回登录屏"的信号）
                assertNull(client.awaitText(600), "不该推送 session.expired")
            }
        } finally {
            srv.stop()
        }
    }

    /** 反过来：后端**明确拒绝**凭据时，必须清会话并广播 `session.expired`。 */
    @Test
    fun `续期被后端明确拒绝时清会话并广播过期事件`() {
        val tokens = FakeTokenStore().apply { update("access-old", "refresh-1") }
        val backend =
            FakeBackend().apply {
                answerWith { call ->
                    if (call.pathTemplate.endsWith("/refresh-token")) {
                        BackendResult.Failed("AUTH-0002", "error_session_expired", retryable = false)
                    } else {
                        BackendResult.Failed("AUTH-0001", null, retryable = false)
                    }
                }
            }
        val srv = server(transport = BridgeTransportKind.PLAIN_SOCKET, backend = backend, tokens = tokens)
        val port = srv.start()
        try {
            TestWsClient("ws://127.0.0.1:$port/bridge?token=$TEST_TOKEN").use { client ->
                client.send(reqFrame("r2", "dashboard.summary"))
                /*
                 * 两条消息都要到，**但顺序不做假设**：
                 * `session.expired` 是分发过程中广播的，而 err 帧是分发返回后才编码回写的 ——
                 * 实测事件会先到。断言"顺序"会把一个正确的实现判红（这条一开始就是这么红的）。
                 */
                val seen = mutableListOf<String>()
                val deadline = System.currentTimeMillis() + 5_000
                while (System.currentTimeMillis() < deadline) {
                    val frame = client.awaitText(500) ?: break
                    seen += frame
                    if (seen.any { it.contains("AUTH-0001") } && seen.any { it.contains(SessionManager.EVENT_SESSION_EXPIRED) }) {
                        break
                    }
                }
                assertTrue(seen.any { it.contains("AUTH-0001") }, "原失败要如实回给界面，实得 $seen")
                assertTrue(
                    seen.any { it.contains(SessionManager.EVENT_SESSION_EXPIRED) },
                    "凭据被拒必须广播 session.expired，实得 $seen",
                )
                assertNull(tokens.accessToken(), "凭据被拒要清令牌")
            }
        } finally {
            srv.stop()
        }
    }

    /**
     * 限流必须在**进协程之前**生效（背压）。
     *
     * 判据有两条：被拒的请求**没有打到后端**，而且每一帧都收到了
     * `BRIDGE_RATE_LIMITED`（不是被静默丢掉、也不是把队列堆起来）。
     */
    @Test
    fun `超出限流的帧被就地拒绝且不惊动后端`() {
        val backend = FakeBackend().apply { answerWith { BackendResult.Ok(JsonPrimitive("ok")) } }
        val srv = server(backend = backend, maxPerSecond = 1, burst = 1)
        val port = srv.start()
        try {
            TestWsClient("ws://127.0.0.1:$port/bridge?token=$TEST_TOKEN").use { client ->
                client.send(reqFrame("k1", "dashboard.summary"))
                assertTrue(client.awaitText()!!.contains("\"type\":\"res\""))
                for (i in 2..4) {
                    client.send(reqFrame("k$i", "dashboard.summary"))
                }
                val rejects = (1..3).map { client.awaitText(2_000) }
                assertTrue(
                    rejects.all { it != null && it.contains(BridgeErrorCodes.RATE_LIMITED) },
                    "每一帧都要拿到明确拒绝，实得 $rejects",
                )
                assertEquals(1, backend.calls.size, "被限流的帧不得打到后端")
            }
        } finally {
            srv.stop()
        }
    }

    /** `bridge.metrics` 要能看出"哪条方法被调过、快不快"。 */
    @Test
    fun `bridge_metrics 暴露按方法的次数与耗时`() {
        val backend = FakeBackend().apply { answerWith { BackendResult.Ok(JsonPrimitive("x")) } }
        val srv = server(backend = backend)
        val port = srv.start()
        try {
            TestWsClient("ws://127.0.0.1:$port/bridge?token=$TEST_TOKEN").use { client ->
                client.send(reqFrame("a1", "dashboard.summary"))
                client.awaitText()
                client.send(reqFrame("a2", "bridge.metrics"))
                val snapshot = client.awaitText()
                assertNotNull(snapshot)
                assertTrue(snapshot!!.contains("\"methods\""), "要带方法表，实得 ${snapshot.take(160)}")
                assertTrue(snapshot.contains("dashboard.summary"), "被调过的方法要出现在指标里")
                assertTrue(snapshot.contains("\"count\":1"), "次数要对，实得 ${snapshot.take(200)}")
            }
        } finally {
            srv.stop()
        }
    }

    /** 令牌截留：带 `accessToken` 的响应必须被剥离并留在桥里（含预检跳过之后仍然剥）。 */
    @Test
    fun `响应里的令牌被剥离且存进桥内`() {
        val tokens = FakeTokenStore()
        val backend =
            FakeBackend().apply {
                answerWith {
                    BackendResult.Ok(
                        buildJsonObject {
                            put("username", JsonPrimitive("operator"))
                            put("accessToken", JsonPrimitive("a-token"))
                            put("refreshToken", JsonPrimitive("r-token"))
                        } as JsonObject,
                        raw = """{"code":"RES-0000","data":{"username":"operator","accessToken":"a-token","refreshToken":"r-token"}}""",
                    )
                }
            }
        val srv = server(backend = backend, tokens = tokens)
        val port = srv.start()
        try {
            TestWsClient("ws://127.0.0.1:$port/bridge?token=$TEST_TOKEN").use { client ->
                client.send(reqFrame("s1", "dashboard.summary"))
                val reply = client.awaitText()
                assertFalse(reply!!.contains("a-token"), "令牌不得下发到 Web，实得 $reply")
                assertFalse(reply.contains("r-token"), "刷新令牌不得下发到 Web")
                assertEquals("a-token", tokens.accessToken())
                assertEquals("r-token", tokens.refreshToken())
            }
        } finally {
            srv.stop()
        }
    }

    private companion object {
        const val TEST_TOKEN = "test-token-0123456789"
    }
}

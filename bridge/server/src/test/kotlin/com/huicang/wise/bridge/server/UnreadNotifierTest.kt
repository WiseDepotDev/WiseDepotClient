package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.backend.BackendCall
import com.huicang.wise.bridge.backend.BackendErrorCodes
import com.huicang.wise.bridge.backend.BackendResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * [UnreadNotifier] 的可执行证据。
 *
 * 这一层管的是"什么算一条该通知的新消息"，四条最容易错的地方都在这里钉住：
 *   1. **不为历史消息补弹**（登录后第一次只播种基线）；
 *   2. 同一条只弹一次（按 id 去重）；
 *   3. **未知 type 也要发**（后端加枚举值时客户端不能一声不响）；
 *   4. 未登录**一个请求都不发**。
 *
 * 用真 `BridgeDispatcher` + `FakeBackend`（不是 mock 框架）：这条路本来就要经过
 * 参数去向（query/body）、令牌注入与错误映射，假掉它就等于没验。
 */
class UnreadNotifierTest {
    /** 一个"按路径回答"的假后端：未读数与消息列表由测试摆布。 */
    private class FakeMessageBackend {
        var unread: Int = 0
        var rows: MutableList<JsonObject> = mutableListOf()
        var failUnread: BackendResult.Failed? = null

        /** 打过的路径（**不能叫 calls**：`FakeBackend` 自己有个 `calls`，会把 `+=` 抢过去）。 */
        val paths: MutableList<String> = mutableListOf()

        fun port(): FakeBackend =
            FakeBackend().apply {
                answerWith { call: BackendCall ->
                    paths.add(call.pathTemplate)
                    when {
                        call.pathTemplate.endsWith("/users/current") ->
                            BackendResult.Ok(
                                buildJsonObject {
                                    put("userId", JsonPrimitive(7))
                                    put("username", JsonPrimitive("operator"))
                                },
                            )
                        call.pathTemplate.endsWith("/messages/unread-count") ->
                            failUnread ?: BackendResult.Ok(JsonPrimitive(unread))
                        call.pathTemplate.endsWith("/messages") -> BackendResult.Ok(JsonArray(rows.toList()))
                        else -> BackendResult.Failed("RES-0004", null, retryable = false)
                    }
                }
            }
    }

    private fun row(
        id: String,
        type: String = "ALERT",
        priority: Int = 1,
        title: String = "读头 04 心跳超时",
        content: String = "设备 5 分钟未上报",
    ): JsonObject =
        buildJsonObject {
            put("id", JsonPrimitive(id))
            put("title", JsonPrimitive(title))
            put("content", JsonPrimitive(content))
            put("type", JsonPrimitive(type))
            put("priority", JsonPrimitive(priority))
            put("createTime", JsonPrimitive("2026-10-07T10:00:00"))
            put("isRead", JsonPrimitive(false))
        }

    private class Harness(
        authenticated: Boolean,
        backend: FakeMessageBackend,
    ) {
        val tokens = FakeTokenStore().apply { if (authenticated) update("access-token", "refresh-token") }
        val backendPort = backend.port()
        val session = SessionManager(tokens, backendPort, "1.0.0-test")
        val dispatcher = BridgeDispatcher(backendPort, FakePlatform(), null, session)
        val events = mutableListOf<Pair<String, JsonElement?>>()
        val notifier =
            UnreadNotifier(
                dispatcher = dispatcher,
                session = session,
                scope = CoroutineScope(kotlinx.coroutines.SupervisorJob()),
                pollMs = 0, // 手动驱动 pollOnce()，不起定时器
                emit = { topic, data -> events += topic to data },
            )
    }

    @Test
    fun `第一次轮询只播种基线，不为历史消息弹通知`() {
        val backend = FakeMessageBackend().apply { unread = 3; rows.add(row("m-3")) }
        val h = Harness(authenticated = true, backend = backend)
        runBlocking { h.notifier.pollOnce() }
        assertTrue(h.events.isEmpty(), "第一次轮询不许弹（否则开应用就刷一串历史通知）")
        assertEquals(1L, h.notifier.polls, "该发的是 unread-count（外加一次 user.current）")
    }

    @Test
    fun `未读变多 ⇒ 弹一条，带最新消息的标题与类型`() {
        val backend = FakeMessageBackend().apply { unread = 0; rows.add(row("m-1")) }
        val h = Harness(authenticated = true, backend = backend)
        runBlocking {
            h.notifier.pollOnce() // 播种：0
            backend.unread = 1
            backend.rows.add(0, row("m-9", type = "INSPECTION", title = "巡检任务已下发"))
            h.notifier.pollOnce()
        }
        assertEquals(1, h.events.size, "应当正好弹一条")
        val (topic, data) = h.events.single()
        assertEquals(UnreadNotifier.TOPIC_MESSAGE, topic)
        val latest = data!!.jsonObject["latest"]!!.jsonObject
        assertEquals("m-9", latest["id"]!!.jsonPrimitive.content)
        assertEquals("巡检任务已下发", latest["title"]!!.jsonPrimitive.content)
        assertEquals("INSPECTION", latest["type"]!!.jsonPrimitive.content)
        assertTrue(data.jsonObject["audible"]!!.jsonPrimitive.content.toBoolean(), "priority=1 应当是有声的")
    }

    @Test
    fun `计数不变或同一条消息重复出现 ⇒ 不再弹`() {
        val backend = FakeMessageBackend().apply { unread = 1; rows.add(row("m-1")) }
        val h = Harness(authenticated = true, backend = backend)
        runBlocking {
            h.notifier.pollOnce() // 播种 1
            backend.unread = 2
            backend.rows.add(0, row("m-2"))
            h.notifier.pollOnce() // 弹 m-2
            h.notifier.pollOnce() // 计数不变
            backend.unread = 3
            h.notifier.pollOnce() // 计数涨了，但列表最新还是 m-2（后端把计数算重）
        }
        assertEquals(1, h.events.size, "同一个 id 只弹一次")
    }

    @Test
    fun `未读数变小（已读或清空）只更新水位，不弹`() {
        val backend = FakeMessageBackend().apply { unread = 5; rows.add(row("m-5")) }
        val h = Harness(authenticated = true, backend = backend)
        runBlocking {
            h.notifier.pollOnce() // 播种 5
            backend.unread = 0
            h.notifier.pollOnce() // 已读光了
            backend.unread = 1
            backend.rows.add(0, row("m-6"))
            h.notifier.pollOnce() // 真正的新消息：仍然要弹
        }
        assertEquals(1, h.events.size)
        assertEquals("m-6", h.events.single().second!!.jsonObject["latest"]!!.jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `未知 type 也要发事件（静默）—— 后端加枚举值时不能一声不响`() {
        val backend = FakeMessageBackend().apply { unread = 0; rows.add(row("m-1")) }
        val h = Harness(authenticated = true, backend = backend)
        runBlocking {
            h.notifier.pollOnce()
            backend.unread = 1
            backend.rows.add(0, row("m-7", type = "SOMETHING_NEW", priority = 0, title = "新类型消息"))
            h.notifier.pollOnce()
        }
        assertEquals(1, h.events.size, "未知 type 必须仍然通知（宁可多弹一次静默的，也不要漏）")
        val data = h.events.single().second!!.jsonObject
        assertEquals("false", data["audible"]!!.jsonPrimitive.content, "priority=0 ⇒ 静默")
    }

    @Test
    fun `未登录：一个请求都不发`() {
        val backend = FakeMessageBackend()
        val h = Harness(authenticated = false, backend = backend)
        runBlocking {
            h.notifier.pollOnce()
            h.notifier.pollOnce()
        }
        assertTrue(backend.paths.isEmpty(), "没登录就不该问后端（否则 401 刷屏）：${backend.paths}")
        assertTrue(h.events.isEmpty())
        assertEquals(0L, h.notifier.polls)
    }

    @Test
    fun `查询失败（后端不可达）不抛、也不弹`() {
        val backend = FakeMessageBackend().apply { failUnread = BackendResult.Failed(BackendErrorCodes.UNREACHABLE, "bridge.backendUnreachable", retryable = true) }
        val h = Harness(authenticated = true, backend = backend)
        runBlocking {
            h.notifier.pollOnce()
            assertTrue(h.events.isEmpty())
        }
    }

    @Test
    fun `登出后基线作废：重新登录只播种，不拿旧水位比较`() {
        val backend = FakeMessageBackend().apply { unread = 9; rows.add(row("m-9")) }
        val h = Harness(authenticated = true, backend = backend)
        runBlocking {
            h.notifier.pollOnce() // 播种 9
            h.tokens.clear() // 登出
            h.notifier.pollOnce() // 未登录 ⇒ 基线作废，且一个请求都不发
            h.tokens.update("t2", "r2") // 重新登录（另一个账号）
            backend.unread = 1 // 新账号只有 1 条未读
            backend.rows.add(0, row("m-1"))
            h.notifier.pollOnce() // 必须"只播种"：旧水位 9 会让它误判成"变少"，从此漏弹
        }
        assertTrue(h.events.isEmpty(), "重新登录不该为已有的那 1 条弹通知（那是历史消息）")
        assertEquals(2L, h.notifier.polls, "未登录那次不该累加（它连请求都没发）")
    }

    @Test
    fun `策略：priority 决定有没有声音，八类都有归类名`() {
        assertTrue(UnreadNotifier.policyOf("ALERT", 1).audible, "告警 priority=1 要有声")
        assertTrue(UnreadNotifier.policyOf("INSPECTION", 1).audible)
        assertTrue(!UnreadNotifier.policyOf("SYSTEM", 0).audible, "系统公告默认静默")
        assertTrue(UnreadNotifier.policyOf("SYSTEM", null).notify, "缺 priority 也要弹（静默）")
        assertTrue(UnreadNotifier.policyOf("WHATEVER_NEW", 0).notify, "未知类型也要弹")
        // 八类枚举值都必须有落点（后端 `MessageType` 的当前全集）
        val known = listOf("SYSTEM", "TASK", "INVENTORY", "APPROVAL", "REMINDER", "NOTIFICATION", "ALERT", "INSPECTION")
        for (type in known) {
            assertTrue(UnreadNotifier.policyOf(type, 0).name != "未知类型", "$type 在策略里没有落点")
        }
    }

    @Test
    fun `kick 有节流：2 秒内不会连打`() {
        val backend = FakeMessageBackend().apply { unread = 0 }
        val h = Harness(authenticated = true, backend = backend)
        // pollMs = 0（测试不开定时器）⇒ kick 是空操作；这条断言钉住"关掉轮询时 kick 也不许发"
        h.notifier.start()
        h.notifier.kick()
        h.notifier.kick()
        assertTrue(backend.paths.isEmpty(), "notifyPollMs = 0 时不该有任何后台请求：${backend.paths}")
        h.notifier.stop()
    }
}

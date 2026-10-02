package com.huicang.wise.bridge.backend

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * 后端访问层的**加固**用例：可取消、响应体上限、模板解析缓存。
 *
 * 三条都是本轮新增的行为，各对应一处"现场会疼"的地方：
 *  · 取消不生效 → 连接断了/桥关停了，那次 HTTP 还要跑满 10 秒才释放线程；
 *  · 响应体没有上限 → 一个异常大的响应把桥进程的堆吃掉；
 *  · 模板每次重新解析 → 每条请求都白做一遍 split 与 Set 构造（热路径）。
 */
class BackendHardeningTest {
    private lateinit var server: MockWebServer

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterEach
    fun tearDown() {
        runCatching { server.shutdown() }
    }

    private fun backend(
        ioMs: Long = 8_000,
        callMs: Long = 10_000,
    ): OkHttpBackend =
        OkHttpBackend(
            baseUrl = server.url("/").toString(),
            tokens = InMemoryTokenStore(),
            client = OkHttpBackend.clientWith(connectMs = 1_000, ioMs = ioMs, callMs = callMs),
        )

    private fun successBody(data: String = "\"ok\"") =
        """{"header":{"timestamp":1,"request_id":"r","packet_type":"0x1201"},"payload":{"code":"RES-0000","message":"成功","data":$data,"errorCode":null}}"""

    private fun getCall(path: String = "/api/things") =
        BackendCall(httpMethod = "GET", pathTemplate = path, packetType = "0x1201", params = null, requestId = "req-1")

    /** 取消必须**即时**生效：不等满 callTimeout 就返回。 */
    @Test
    fun `协程被取消时这次 HTTP 立刻结束（不等到整次调用超时）`() {
        // 服务端故意不回（body 延迟 10 秒），而整次调用预算是 10 秒
        server.enqueue(MockResponse().setBodyDelay(10, java.util.concurrent.TimeUnit.SECONDS).setBody(successBody()))
        val started = System.currentTimeMillis()
        val outcome =
            runBlocking {
                withTimeoutOrNull(200) {
                    backend().call(getCall())
                }
            }
        val elapsed = System.currentTimeMillis() - started
        assertTrue(outcome == null, "超时应当取消这次调用，实得 $outcome")
        assertTrue(elapsed < 3_000, "取消要即时生效（不等满 10 秒预算），实测 ${elapsed}ms")
    }

    /** 超大响应要变成一条明确错误，而不是把堆吃掉。 */
    @Test
    fun `响应体超过上限时回明确错误而不是读进堆`() {
        val huge = "x".repeat(OkHttpBackend.MAX_RESPONSE_BYTES + 1024)
        server.enqueue(MockResponse().setBody("""{"payload":{"code":"RES-0000","data":"$huge"}}"""))
        val result = runBlocking { backend().call(getCall()) }
        assertTrue(result is BackendResult.Failed, "应当是一条失败，实得 $result")
        assertEquals(BackendErrorCodes.UNREACHABLE_RESPONSE_TOO_LARGE, (result as BackendResult.Failed).code)
        assertEquals("bridge.frameTooLarge", result.messageKey)
    }

    /** 正常响应要带上 `raw`（令牌截留的廉价预检靠它）。 */
    @Test
    fun `成功响应带回原始文本供上层做廉价预检`() {
        server.enqueue(MockResponse().setBody(successBody()))
        val result = runBlocking { backend().call(getCall()) }
        assertTrue(result is BackendResult.Ok)
        assertNotNull((result as BackendResult.Ok).raw, "raw 不得为空")
        assertTrue(result.raw!!.contains("RES-0000"))
    }

    /** 并发取消：一个被取消不影响另一个（桥里同时会有多条在跑）。 */
    @Test
    fun `一条被取消不影响另一条正常返回`() = runBlocking {
        server.enqueue(MockResponse().setBodyDelay(5, java.util.concurrent.TimeUnit.SECONDS).setBody(successBody()))
        server.enqueue(MockResponse().setBody(successBody()))
        val slow = async(Dispatchers.IO) { backend().call(getCall("/api/slow")) }
        delay(100)
        slow.cancel()
        val fast = backend().call(getCall("/api/fast"))
        assertTrue(fast is BackendResult.Ok, "另一条必须正常返回，实得 $fast")
        assertTrue(slow.isCancelled)
    }

    /** 模板解析缓存：结果与"每次重新解析"完全一致，且不含参数时走快路径。 */
    @Test
    fun `路径模板缓存后行为不变（含无参数方法的快路径）`() {
        val params = JsonObject(mapOf("inventoryId" to JsonPrimitive(42), "keyword" to JsonPrimitive("螺丝")))

        assertEquals("/api/inventories/42", PathTemplate.resolve("/api/inventories/{inventoryId}", params))
        assertEquals("/api/inventories/42", PathTemplate.resolve("/api/inventories/{inventoryId}", params))
        // 没有参数段：原样返回（而且应当是同一个字符串内容）
        assertEquals("/api/inventories", PathTemplate.resolve("/api/inventories", params))
        // 剩余参数：路径参数被剔除，其它保留
        assertEquals(setOf("keyword"), PathTemplate.remaining("/api/inventories/{inventoryId}", params).keys)
        // 无参数段时原样返回同一个对象（不做无谓的过滤拷贝）
        assertTrue(PathTemplate.remaining("/api/inventories", params) === params)
        // 缺路径参数仍然是"非法"，不猜测
        assertEquals(null, PathTemplate.resolve("/api/inventories/{inventoryId}", JsonObject(emptyMap())))
        // 参数名列表按出现顺序去重
        assertEquals(listOf("a", "b"), PathTemplate.parameterNames("/x/{a}/{b}/{a}"))
    }
}

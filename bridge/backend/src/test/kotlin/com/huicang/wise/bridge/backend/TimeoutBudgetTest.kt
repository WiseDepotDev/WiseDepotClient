package com.huicang.wise.bridge.backend

import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * 超时预算链的测试。
 *
 * ## 为什么这段值得单独测
 *
 * 出事的那一版**每一个数单看都合理**（建连 5s、读写 20s），坏的是**关系**：
 * 读超时（20s）比 Web 侧调用总预算（15s）还大，于是后端这一层**永远轮不到先失败**。
 * 后果不是"慢"，是**信息丢失** —— OkHttp 还没抛，Web 侧已经超时了，
 * `OkHttpBackend` 里那个把失败原因写进日志的 catch 根本到不了。
 * 用户看到"请求超时，可重试"，桥的日志里一行失败记录都没有。
 *
 * 所以这里测两件事：
 *
 * 1. **数值**（[defaultClientBudget]）—— 生产默认值就是这条链，别被改回去；
 * 2. **行为**（[innerLayerFailsFirst]）—— "内层先失败"不是靠读代码相信的，
 *    真跑一次：服务端不回，先抛的必须是读超时（而不是整次调用超时）。
 *
 * 数值断言挡不住"关系被人反过来"的情况，行为断言挡不住"值被悄悄改小"的情况，
 * 两条一起才完整。跨语言的那一条（后端 < Web）在
 * `tools/check/check-timeout-budget.mjs` —— 那个数在 TS 里，Kotlin 测试看不到它。
 */
class TimeoutBudgetTest {
    @Test
    @DisplayName("生产默认客户端的超时就是预算链：建连 5s / 读写 8s / 整次 10s")
    fun defaultClientBudget() {
        val client = OkHttpBackend.defaultClient()

        assertEquals(
            OkHttpBackend.CONNECT_TIMEOUT_MS,
            client.connectTimeoutMillis.toLong(),
            "建连超时被改了；改它要同步 tools/check/check-timeout-budget.mjs",
        )
        assertEquals(
            OkHttpBackend.IO_TIMEOUT_MS,
            client.readTimeoutMillis.toLong(),
            "读超时被改了：它一旦 >= Web 侧预算，后端就再也轮不到先失败（第三轮的根因）",
        )
        assertEquals(OkHttpBackend.IO_TIMEOUT_MS, client.writeTimeoutMillis.toLong(), "写超时被改了")
        assertEquals(
            OkHttpBackend.CALL_TIMEOUT_MS,
            client.callTimeoutMillis.toLong(),
            "整次调用超时被改了；**这一项是旧版漏掉的**，缺了它读超时就可以无限叠加",
        )

        // 关系本身也断言一遍：即使有人把三个数一起改，顺序也不能反过来。
        assertTrue(client.connectTimeoutMillis < client.readTimeoutMillis, "建连必须小于读写")
        assertTrue(
            client.readTimeoutMillis < client.callTimeoutMillis,
            "读写必须小于整次调用，否则整次调用先超时 → 又变成没有原因的超时",
        )
    }

    @Test
    @DisplayName("服务端不回复时**内层先失败**：抛读超时（SocketTimeoutException），不是整次调用超时")
    fun innerLayerFailsFirst() {
        MockWebServer().use { server ->
            // 先给头、再拖 body：让"读"这一个动作真的超时（而不是连接没建立）。
            server.enqueue(
                MockResponse()
                    .setBody("{}")
                    .setBodyDelay(3, TimeUnit.SECONDS),
            )
            server.start()

            /*
             * 用同一套装配代码、按比例缩小的一组数。
             * 关键是**两个内层都远小于整次调用**：这样"谁先抛"才有区分度。
             */
            val client = OkHttpBackend.clientWith(connectMs = 500, ioMs = 400, callMs = 5_000)

            val started = System.currentTimeMillis()
            val thrown =
                try {
                    client.newCall(Request.Builder().url(server.url("/probe")).build()).execute().use {
                        it.body?.string()
                    }
                    null
                } catch (e: IOException) {
                    e
                }
            val elapsed = System.currentTimeMillis() - started

            assertTrue(
                thrown is SocketTimeoutException,
                "期望读超时先抛（内层先说话），实际是 ${thrown?.javaClass?.simpleName}: ${thrown?.message}",
            )
            // 若整次调用先超时，这里会接近 5000ms；内层先超时应当明显早于它。
            assertTrue(
                elapsed < 3_000,
                "失败发生在 ${elapsed}ms，说明等的是整次调用预算而不是读超时",
            )
        }
    }
}

package com.huicang.wise.bridge.server

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 桥内指标：**每次方法调用一行账**。
 *
 * ## 为什么要有它
 *
 * 界面右上角那个"18ms"是 Web 侧量的**端到端**耗时（页面 → 桥 → 后端 → 回来），
 * 它回答不了"慢在桥上还是慢在后端"：
 *  · 后端自己报 800ms vs 桥转发花了 800ms，是两种完全不同的现场问题；
 *  · 某一条方法偶发 3 秒，也需要先知道**是哪一条**才谈得上修。
 *
 * 所以这里按方法记：次数、失败数、最近一次的耗时、以及**最近 64 次的中位数**（p50 近似）。
 *
 * ## 三条刻意的取舍（都是"别让观测本身变成负担"）
 *
 * 1. **不引依赖、不上报**：只有内存里的一张表，通过内建方法 `bridge.metrics` 拉取。
 *    桥是本地进程，观测数据没必要走网络。
 * 2. **有界**：每个方法固定 64 槽环形缓冲（方法与契约同阶，最多 100 多个），
 *    不随请求数增长 —— 观测不该成为内存泄漏的来源。
 * 3. **无锁热路径**：全部用 `Atomic*`，不互相加锁。代价是快照**不保证是同一瞬间的一致视图**
 *    （某一项可能刚被更新），这对"看趋势"这件事无影响，换来的是热路径零争用。
 *
 * 时钟由构造参数注入，测试可以给定确定的时间序列。
 */
class BridgeMetrics(
    private val clock: () -> Long = System::nanoTime,
    private val startedAtMs: Long = System.currentTimeMillis(),
) {
    /** 单个方法的账。 */
    private class Entry {
        val count = AtomicLong()
        val failed = AtomicLong()
        val totalMs = AtomicLong()
        val maxMs = AtomicLong()

        /** 最近 [RING] 次的耗时（毫秒）；只用于估中位数，不保留明细。 */
        val ring = LongArray(RING)
        val cursor = AtomicInteger()

        fun record(
            ok: Boolean,
            durationMs: Long,
        ) {
            count.incrementAndGet()
            if (!ok) {
                failed.incrementAndGet()
            }
            totalMs.addAndGet(durationMs)
            maxMs.updateAndGet { current -> if (durationMs > current) durationMs else current }
            val slot = cursor.getAndIncrement() % RING
            ring[slot] = durationMs
        }

        /** 中位数（近似）：取已写入样本的中位，样本不足时按已有样本算。 */
        fun p50Ms(): Long {
            val filled = minOf(count.get(), RING.toLong()).toInt()
            if (filled == 0) {
                return 0
            }
            val samples = ring.copyOf(filled).sortedArray()
            return samples[filled / 2]
        }
    }

    private val byMethod = ConcurrentHashMap<String, Entry>()

    /** 开始计时（返回一个不透明的起点，交给 [elapsedMs] 换算）。 */
    fun start(): Long = clock()

    /** 从起点换算成毫秒。 */
    fun elapsedMs(start: Long): Long = (clock() - start) / 1_000_000

    /**
     * 记一次调用。
     *
     * @param method 方法 id（内建方法也记，这样"桥自己花的时间"同样看得见）
     * @param ok 是否成功（后端业务拒绝算失败：那是用户会看到红字的那一类）
     * @param durationMs 桥内耗时（毫秒）
     */
    fun record(
        method: String,
        ok: Boolean,
        durationMs: Long,
    ) {
        byMethod.computeIfAbsent(method) { Entry() }.record(ok, durationMs)
    }

    /**
     * 快照：给 `bridge.metrics` 用。
     *
     * 结构（字段名用驼峰，与帧内其它 camelCase 一致）：
     * ```json
     * {
     *   "uptimeMs": 123456,
     *   "totalCalls": 42, "totalFailed": 1,
     *   "methods": {
     *     "tag.list": { "count": 12, "failed": 0, "lastMs": 3, "p50Ms": 3, "maxMs": 9, "avgMs": 4 }
     *   }
     * }
     * ```
     * 按调用次数倒序输出：最忙的排前面，看问题不用翻。
     */
    fun snapshot(): JsonObject {
        val methods =
            byMethod.entries
                .sortedByDescending { it.value.count.get() }
                .associate { (method, entry) ->
                    val count = entry.count.get()
                    method to
                        JsonObject(
                            mapOf(
                                "count" to JsonPrimitive(count),
                                "failed" to JsonPrimitive(entry.failed.get()),
                                "lastMs" to JsonPrimitive(entry.ring[((entry.cursor.get() - 1).mod(RING))]),
                                "p50Ms" to JsonPrimitive(entry.p50Ms()),
                                "maxMs" to JsonPrimitive(entry.maxMs.get()),
                                "avgMs" to JsonPrimitive(if (count == 0L) 0L else entry.totalMs.get() / count),
                            ),
                        )
                }
        val totalCalls = byMethod.values.sumOf { it.count.get() }
        val totalFailed = byMethod.values.sumOf { it.failed.get() }
        return JsonObject(
            mapOf(
                "uptimeMs" to JsonPrimitive(System.currentTimeMillis() - startedAtMs),
                "totalCalls" to JsonPrimitive(totalCalls),
                "totalFailed" to JsonPrimitive(totalFailed),
                "methods" to JsonObject(methods),
            ),
        )
    }

    private companion object {
        /** 每个方法保留的样本数：64 个足够估中位数，也足够小到可以忽略内存。 */
        const val RING = 64
    }
}

package com.huicang.wise.bridge.server

/**
 * 令牌桶限流（单连接）。
 *
 * 为什么单连接也要限流：桥的 client 是**同一个进程里的 WebView**，
 * 一个渲染循环失控（或一段死循环代码）就能把后端打满。默认 50 req/s、突发 100
 * 对真实 UI 是宽裕的，但能在异常时把伤害限制住。
 */
class RateLimiter(
    private val maxPerSecond: Int,
    private val burst: Int,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    private var tokens: Double = burst.toDouble()
    private var lastNanos: Long = nanoTime()

    @Synchronized
    fun tryAcquire(): Boolean {
        val now = nanoTime()
        val elapsed = (now - lastNanos).coerceAtLeast(0) / 1_000_000_000.0
        lastNanos = now
        tokens = (tokens + elapsed * maxPerSecond).coerceAtMost(burst.toDouble())
        if (tokens < 1.0) {
            return false
        }
        tokens -= 1.0
        return true
    }
}

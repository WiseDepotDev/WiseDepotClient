package com.huicang.wise.bridge.host.desktop

import com.huicang.wise.bridge.capability.HumanVerifyPort
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * 桌面的**证据通道**：桥问、Electron 主进程答。
 *
 * ## 为什么需要一条新的往返
 *
 * "是不是发布包""有没有挂调试器"只存在于 **Electron 主进程**；而需要它们的是 **桥**（JVM 子进程）。
 * 已有的控制通道是**单向**的：事件只能桥 → 壳，`shutdown` 只能壳 → 桥。
 * 所以补一条**带 id** 的请求/响应：
 *
 * ```text
 * 桥 → 壳（stdout）：{"v":1,"type":"evidence-request","id":"ev-1"}
 * 壳 → 桥（stdin）： {"v":1,"id":"ev-1","data":{"shellPackaged":true,"debugAttached":false}}
 * ```
 *
 * ## 三条纪律
 *
 * 1. **超时不能变成拒绝**：壳没答就返回**空证据**（[EMPTY]）。证据是服务端的**输入**，
 *    不是验证的前置条件 —— 拿不到证据就"验证不过"，等于让一个壳的 bug 把用户锁在门外。
 * 2. **一条请求一个 id**：并发多次验证时不能互相顶包（用 map 而不是"当前请求"）。
 * 3. **不许回"结论"**：这里只搬事实字段，判定在服务端。
 */
class DesktopEvidenceChannel(
    private val write: (JsonObject) -> Unit,
    private val timeoutMs: Long = 1_500,
) : HumanVerifyPort {
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()

    private val counter = AtomicLong()

    override suspend fun environmentEvidence(): JsonObject {
        val id = "ev-${counter.incrementAndGet()}"
        val deferred = CompletableDeferred<JsonObject>()
        pending[id] = deferred
        write(
            buildJsonObject {
                put("v", JsonPrimitive(1))
                put("type", JsonPrimitive("evidence-request"))
                put("id", JsonPrimitive(id))
            },
        )
        val answer = withTimeoutOrNull(timeoutMs) { deferred.await() }
        pending.remove(id)
        return answer ?: EMPTY
    }

    /** 父进程回了这一条（由 stdin 循环调用）。id 不认识就忽略 —— 可能是上一次超时后迟到的答复。 */
    fun complete(
        id: String,
        data: JsonObject?,
    ) {
        pending.remove(id)?.complete(data ?: EMPTY)
    }

    private companion object {
        /** 壳没答时的空证据：字段一个都不写（写 `false` 与"不知道"是两件事）。 */
        val EMPTY: JsonObject = JsonObject(emptyMap())
    }
}

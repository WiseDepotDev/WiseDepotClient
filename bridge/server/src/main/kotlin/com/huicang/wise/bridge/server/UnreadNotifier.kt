package com.huicang.wise.bridge.server

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * **未读消息轮询器**：桥持续问后端"有几条未读"，有新消息就发一条
 * [TOPIC_MESSAGE] 事件，由两个壳在**系统层面**弹通知。
 *
 * ## 为什么轮询在桥里
 *
 * 访问令牌只存在于桥进程内（[SessionManager] 是唯一持有者），Web 层拿不到 ——
 * 所以"持续调后端接口"只能落在桥里。而"弹系统通知"必须在壳里（通知最该出现的时刻
 * 恰恰是界面不在前台，那时页面 JS 可能被冻结）。桥只负责**发现新消息**，
 * 怎么弹、弹不弹由壳决定。
 *
 * ## 四条容易踩的坑（都由这里兜住）
 *
 * 1. **不为历史消息补弹**：登录后的**第一次**轮询只播种基线，不通知；
 * 2. **同一条只弹一次**：按消息 id 去重（有界集合，不落盘）；
 * 3. **未登录一个请求都不发**：`/unread-count` 需要 `receiverId`，而且没登录时问它
 *    只会得到 401；登出/过期后自动停，下次登录重新播种；
 * 4. **未知 type 也要说**：后端将来加一个枚举值，界面上不能就此"一声不响"
 *    （默认静默通知 + 一条日志，见 [policyOf]）。
 *
 * ## 间隔与"补算"
 *
 * 定时轮询是 [notifyPollMs]（默认 10 秒）；而"有人正在用"的时刻由 [kick] 立即补算一次
 * （每次桥转发过一次业务请求后调用，节流见 [KICK_MIN_INTERVAL_MS]）——
 * 于是平均负载还是 10 秒一次，但用户刚做完动作时反应是秒级。
 */
class UnreadNotifier(
    private val dispatcher: BridgeDispatcher,
    private val session: SessionManager,
    private val scope: CoroutineScope,
    /** 轮询间隔（毫秒）。`0` = 完全不轮询（测试与 bench 用它，避免后台流量）。 */
    private val pollMs: Long,
    /** 事件出口（由 [BridgeServer] 注入 = `emit`）。 */
    private val emit: (String, JsonElement?) -> Unit,
) {
    /** 通知策略：一类消息该不该响。 */
    data class Policy(
        /** 是否在系统层面弹（目前恒 true：未知类型也弹，宁多勿漏）。 */
        val notify: Boolean = true,
        /** 是否**有声**（横幅 + 声音/震动）；false = 静默只进通知栏。 */
        val audible: Boolean,
        /** 给日志用的归类名。 */
        val name: String,
    )

    private var timer: ScheduledExecutorService? = null

    /** 是否已经播种过基线（登录后第一次轮询只记录，不通知）。 */
    private var baselineSeeded = false

    private var lastCount: Int = -1

    /** 已经通知过的消息 id（有界，避免无限增长）。 */
    private val notified = LinkedHashSet<String>()

    /** 当前用户的数值 id（`/unread-count` 要它，而它只能从 `user.current` 拿到）。 */
    private var receiverId: Long? = null

    private var lastKickAt: Long = 0L

    @Volatile private var running = false

    /** 诊断计数（`bridge.metrics` 之外的一点点可观测性；不含任何内容）。 */
    @Volatile var polls: Long = 0
        private set

    @Volatile var notifications: Long = 0
        private set

    fun start() {
        if (pollMs <= 0 || running) {
            return
        }
        running = true
        val scheduler =
            Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "bridge-notify").apply { isDaemon = true }
            }
        timer = scheduler
        scheduler.scheduleWithFixedDelay(
            { scope.launch { pollOnce() } },
            pollMs,
            pollMs,
            TimeUnit.MILLISECONDS,
        )
        BridgeLog.info("[bridge] 未读消息轮询已启动，间隔 ${pollMs}ms")
    }

    fun stop() {
        running = false
        timer?.shutdownNow()
        timer = null
    }

    /**
     * "有人正在用"时立即补算一次（桥每转发一条业务请求就调它）。
     *
     * 节流到 [KICK_MIN_INTERVAL_MS]：一次界面刷新会打十几条请求，不节流就成了自己打自己。
     */
    fun kick() {
        if (pollMs <= 0 || !running) {
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastKickAt < KICK_MIN_INTERVAL_MS) {
            return
        }
        lastKickAt = now
        scope.launch { pollOnce() }
    }

    /** 会话状态变了（登出/过期/换账号）⇒ 基线作废，下次登录重新播种。 */
    fun onSessionCleared() {
        baselineSeeded = false
        lastCount = -1
        receiverId = null
        synchronized(notified) { notified.clear() }
    }

    /** 一次轮询（`internal` 是为了测试能手动驱动它，不必等定时器）。 */
    internal suspend fun pollOnce() {
        if (!session.authenticated) {
            onSessionCleared()
            return
        }
        val userId = receiverId ?: fetchReceiverId() ?: return
        polls += 1
        val count = fetchUnreadCount(userId) ?: return

        if (!baselineSeeded) {
            // 登录后的第一次：**只播种**。否则开应用就会为历史消息补弹一串通知。
            baselineSeeded = true
            lastCount = count
            BridgeLog.info("[bridge] 未读消息基线：$count 条（不通知历史消息）")
            return
        }

        if (count <= lastCount) {
            // 变少（已读/清空）也要跟着降，否则下次真正的新消息会被这个虚高的水位吃掉
            lastCount = count
            return
        }

        lastCount = count
        val latest = fetchLatest(userId)
        if (latest == null) {
            return
        }
        val id = latest["id"]?.jsonPrimitive?.contentOrNullSafe()
        if (id == null) {
            BridgeLog.info("[bridge] 未读增加了但最新一条没有 id，跳过通知")
            return
        }
        synchronized(notified) {
            if (!notified.add(id)) {
                // 同一个 id 又出现（例如后端把计数算重）：不重复弹
                return
            }
            while (notified.size > MAX_REMEMBERED) {
                val oldest = notified.iterator().next()
                notified.remove(oldest)
            }
        }

        val type = latest["type"]?.jsonPrimitive?.contentOrNullSafe() ?: ""
        val policy = policyOf(type, latest["priority"]?.jsonPrimitive?.intOrNullSafe())
        if (!policy.notify) {
            return
        }
        notifications += 1
        emit(TOPIC_MESSAGE, messageEvent(count, latest, policy))
        BridgeLog.info(
            "[bridge] 新消息通知：id=$id type=${type.ifEmpty { "(空)" }} 归类=${policy.name} 有声=${policy.audible} 未读=$count",
        )
    }

    // ---------------------------------------------------------------- 取数

    private suspend fun fetchReceiverId(): Long? {
        val result = dispatcher.dispatch(USER_CURRENT, null, "notify-user")
        val data = (result as? com.huicang.wise.bridge.backend.BackendResult.Ok)?.data ?: return null
        val id = (data as? JsonObject)?.get("userId")?.jsonPrimitive?.longOrNullSafe()
        if (id == null) {
            BridgeLog.info("[bridge] 拿不到当前用户 id（user.current），本轮不轮询未读数")
            return null
        }
        receiverId = id
        return id
    }

    private suspend fun fetchUnreadCount(userId: Long): Int? {
        val params = JsonObject(mapOf("receiverId" to JsonPrimitive(userId)))
        val result = dispatcher.dispatch(UNREAD_COUNT, params, "notify-count")
        return when (result) {
            // 后端回 `ApiResponse<Integer>` ⇒ payload.data 就是一个数字
            is com.huicang.wise.bridge.backend.BackendResult.Ok -> result.data?.jsonPrimitive?.intOrNullSafe()
            is com.huicang.wise.bridge.backend.BackendResult.Failed -> {
                // 认证类失败不刷屏（会话过期那条路已经由 SessionManager 处理）
                if (!SessionManager.isAuthFailure(result.code)) {
                    BridgeLog.info("[bridge] 未读数查询失败：${result.code}")
                }
                null
            }
        }
    }

    private suspend fun fetchLatest(userId: Long): JsonObject? {
        // 服务端 `message.list` 是**裸数组 + 0 基分页**（见 mock 与 docs/standards 的实测记录）
        val params =
            JsonObject(
                mapOf(
                    "receiverId" to JsonPrimitive(userId),
                    "page" to JsonPrimitive(0),
                    "size" to JsonPrimitive(1),
                ),
            )
        val result = dispatcher.dispatch(LIST_METHOD, params, "notify-latest")
        val data = (result as? com.huicang.wise.bridge.backend.BackendResult.Ok)?.data ?: return null
        val array = data as? JsonArray ?: return null
        return array.firstOrNull() as? JsonObject
    }

    /** 事件正文：只放壳展示需要的东西，**不含令牌、不含收件人**。 */
    private fun messageEvent(
        count: Int,
        latest: JsonObject,
        policy: Policy,
    ): JsonElement {
        fun text(key: String): JsonElement = latest[key] ?: JsonNull
        return JsonObject(
            mapOf(
                "count" to JsonPrimitive(count),
                "audible" to JsonPrimitive(policy.audible),
                "latest" to
                    JsonObject(
                        mapOf(
                            "id" to text("id"),
                            "title" to text("title"),
                            "body" to text("content"),
                            "type" to text("type"),
                            "priority" to (latest["priority"] ?: JsonPrimitive(0)),
                            "at" to text("createTime"),
                        ),
                    ),
            ),
        )
    }

    companion object {
        /** 事件 topic：`域.动作`。 */
        const val TOPIC_MESSAGE: String = "notify.message"

        /** 当前用户（拿 `receiverId` 用）。 */
        const val USER_CURRENT: String = "user.current"

        /** 未读数（一次 COUNT，最便宜的轮询靶子）。 */
        const val UNREAD_COUNT: String = "message.unreadCount"

        /** 取最新一条的标题/正文。 */
        const val LIST_METHOD: String = "message.list"

        /** `kick()` 的节流：2 秒内不重复补算。 */
        const val KICK_MIN_INTERVAL_MS: Long = 2_000

        /** 去重集合的上限。 */
        const val MAX_REMEMBERED: Int = 200

        /**
         * 通知策略：**默认静默，重要的才响**。
         *
         * `priority >= 1` ⇒ 有声（后端目前只有"巡检下发"与"设备异常"两处设了 1）；
         * 其余（含未知 type）⇒ 弹但静默。
         *
         * **未知 type 也返回 notify=true**：宁可多弹一次静默通知，也不要"后端新增枚举值、
         * 客户端从此一声不响" —— 那是最难发现的一类退化（见 `check-notify` 的第 7 条门禁）。
         */
        fun policyOf(
            type: String,
            priority: Int?,
        ): Policy {
            val audible = (priority ?: 0) >= 1
            val name =
                when (type.uppercase()) {
                    "ALERT" -> "设备/库存告警"
                    "INSPECTION" -> "巡检任务"
                    "APPROVAL" -> "待审批"
                    "TASK" -> "任务"
                    "INVENTORY" -> "库存"
                    "REMINDER" -> "提醒"
                    "NOTIFICATION" -> "通知"
                    "SYSTEM" -> "系统"
                    else -> "未知类型"
                }
            return Policy(notify = true, audible = audible, name = name)
        }
    }
}

/*
 * 一组"JSON 取值不炸"的小助手。
 *
 * 为什么不直接在调用点 `as? JsonPrimitive` + `.int`：`JsonPrimitive.int` 遇到
 * `"3"`（字符串数字，后端有时这么回）会抛；而这条路径在**后台线程**上跑，
 * 抛出去只会变成一条没人看的线程异常，通知则静默消失。
 */
private fun JsonPrimitive.contentOrNullSafe(): String? = runCatching { content }.getOrNull()

private fun JsonPrimitive.intOrNullSafe(): Int? =
    runCatching { int }.getOrNull() ?: runCatching { content.toDouble().toInt() }.getOrNull()

private fun JsonPrimitive.longOrNullSafe(): Long? =
    runCatching { long }.getOrNull() ?: runCatching { content.toDouble().toLong() }.getOrNull()

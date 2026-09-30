package com.huicang.wise.bridge.backend

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 路径模板解析：把 `{name}` 段换成实参。
 *
 * 为什么参数拆分要有一条**明确规则**而不是"看情况"：
 * 后端既有路径参数（`/api/inventories/{inventoryId}`）、又有查询参数、又有请求体。
 * 桥侧只有一份 `params` 对象，所以规则必须写死并可被单测穷举：
 *  - 模板里出现过的名字 → 走**路径**；
 *  - 其余参数：GET/DELETE → 走**查询串**，POST/PUT/PATCH → 走**请求体**；
 *  - 缺路径参数 → 直接判参数非法（不猜测、不用空串兜底）。
 */
object PathTemplate {
    /**
     * 按 `/` 分段，不去碰正则。
     *
     * **为什么不用 Regex**（W3 在 WSA 上撞出来的教训）：
     * 原先这里写的是 `Regex("\\{([^}]+)}")`，它在桌面 JVM 上完全合法，
     * 但在 **Android 的 `java.util.regex` 实现**下直接抛
     * `PatternSyntaxException: Syntax error in regexp pattern near index 10`
     * —— 而且是**类初始化时**炸，表现为 `ExceptionInInitializerError`，
     * 只看到"某个类的静态初始化失败"，连是哪一行都不说。
     *
     * 排查代价很高（先后怀疑过混合内容、CSP、Netty、OkHttp，都错了）。
     * 结论：**这种简单到不值得用正则的解析就手写**——少一个引擎差异源，也更快。
     *
     * 判据：整段形如 `{name}` 才算参数；`{id:\d+}` 这种带约束的写法由生成器归一化成 `{id}`。
     */
    private fun segments(template: String): List<String> = template.split('/')

    private fun paramName(segment: String): String? =
        if (segment.length > 2 && segment.startsWith("{") && segment.endsWith("}")) {
            segment.substring(1, segment.length - 1)
        } else {
            null
        }

    /** 模板里的参数名（按出现顺序，去重）。 */
    fun parameterNames(template: String): List<String> =
        segments(template).mapNotNull { paramName(it) }.distinct()

    /**
     * 替换路径参数。
     *
     * @return 解析后的路径；缺少参数时返回 null（调用方转成 [BackendErrorCodes.PARAMS_INVALID]）
     */
    fun resolve(
        template: String,
        params: JsonObject?,
    ): String? {
        var missing = false
        val resolved =
            segments(template).joinToString("/") { segment ->
                val name = paramName(segment)
                if (name == null) {
                    segment
                } else {
                    val value = (params?.get(name) as? JsonPrimitive)?.content
                    if (value == null) {
                        missing = true
                        segment
                    } else {
                        value
                    }
                }
            }
        return if (missing) null else resolved
    }

    /** 去掉路径参数后剩下的参数（查询串或请求体用）。 */
    fun remaining(
        template: String,
        params: JsonObject?,
    ): JsonObject {
        if (params == null) {
            return JsonObject(emptyMap())
        }
        val pathNames = parameterNames(template).toSet()
        return JsonObject(params.filterKeys { it !in pathNames })
    }
}

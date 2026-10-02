package com.huicang.wise.bridge.backend

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.ConcurrentHashMap

/**
 * 路径模板解析：把 `{name}` 段换成实参。
 *
 * ## 为什么参数拆分要有一条**明确规则**而不是"看情况"
 *
 * 后端既有路径参数（`/api/inventories/{inventoryId}`）、又有查询参数、又有请求体。
 * 桥侧只有一份 `params` 对象，所以规则必须写死并可被单测穷举：
 *  - 模板里出现过的名字 → 走**路径**；
 *  - 其余参数：GET/DELETE → 走**查询串**，POST/PUT/PATCH → 走**请求体**；
 *  - 缺路径参数 → 直接判参数非法（不猜测、不用空串兜底）。
 *
 * ## 为什么要缓存解析结果
 *
 * 模板来自契约表：**固定的一百多条字符串**，而 [resolve] 与 [remaining] 是**每次请求**都要走的。
 * 原先每次都 `split('/')` 两遍、造一遍 Set —— 纯重复劳动。缓存之后每个模板只解析一次，
 * 键空间由契约决定（有界），不会随请求数增长。
 */
object PathTemplate {
    /**
     * 一个模板的解析结果。
     *
     * @param segments 按 `/` 切好的段（含参数段原样保留）
     * @param names 参数名（按出现顺序，去重）—— 给 `parameterNames` 与诊断用
     * @param nameSet 参数名集合 —— 给 [remaining] 过滤用（避免每次请求重建 Set）
     * @param hasParams 是否含参数段：false 时 [resolve] 可以完全不做替换
     */
    private class Parsed(
        val segments: List<String>,
        val names: List<String>,
        val nameSet: Set<String>,
        val hasParams: Boolean,
    )

    private val cache = ConcurrentHashMap<String, Parsed>()

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
    private fun parse(template: String): Parsed =
        cache.computeIfAbsent(template) { t ->
            val segments = t.split('/')
            val names = segments.mapNotNull { paramName(it) }.distinct()
            Parsed(segments, names, names.toSet(), names.isNotEmpty())
        }

    private fun paramName(segment: String): String? =
        if (segment.length > 2 && segment.startsWith("{") && segment.endsWith("}")) {
            segment.substring(1, segment.length - 1)
        } else {
            null
        }

    /** 模板里的参数名（按出现顺序，去重）。 */
    fun parameterNames(template: String): List<String> = parse(template).names

    /**
     * 替换路径参数。
     *
     * @return 解析后的路径；缺少参数时返回 null（调用方转成 [BackendErrorCodes.PARAMS_INVALID]）
     */
    fun resolve(
        template: String,
        params: JsonObject?,
    ): String? {
        val parsed = parse(template)
        if (!parsed.hasParams) {
            // 绝大多数方法没有路径参数：直接返回模板，连 joinToString 都省掉
            return template
        }
        var missing = false
        val resolved =
            parsed.segments.joinToString("/") { segment ->
                val name = paramName(segment)
                if (name == null) {
                    segment
                } else {
                    val value = (params?.get(name) as? JsonPrimitive)?.content
                    if (value == null) {
                        missing = true
                        segment
                    } else {
                        encodePathSegment(value)?.also { encoded ->
                            if (encoded.isEmpty()) {
                                missing = true
                            }
                        } ?: run {
                            missing = true
                            segment
                        }
                    }
                }
            }
        return if (missing) null else resolved
    }

    /**
     * Encode one URL path segment without allowing a parameter to change the route
     * boundary. Query delimiters, slashes, controls and dot segments are rejected
     * instead of being silently normalized by the HTTP client.
     */
    private fun encodePathSegment(value: String): String? {
        if (value == "." || value == ".." || value.any { it.code < 0x20 || it.code == 0x7F }) {
            return null
        }
        if (value.any { it == '/' || it == '?' || it == '#' }) {
            return null
        }
        val bytes = value.toByteArray(Charsets.UTF_8)
        val out = StringBuilder(bytes.size)
        for (byte in bytes) {
            val c = byte.toInt() and 0xFF
            if ((c in 'a'.code..'z'.code) ||
                (c in 'A'.code..'Z'.code) ||
                (c in '0'.code..'9'.code) ||
                c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code
            ) {
                out.append(c.toChar())
            } else {
                out.append('%')
                out.append(HEX[c ushr 4])
                out.append(HEX[c and 0x0F])
            }
        }
        return out.toString()
    }

    /** 去掉路径参数后剩下的参数（查询串或请求体用）。 */
    fun remaining(
        template: String,
        params: JsonObject?,
    ): JsonObject {
        if (params == null) {
            return JsonObject(emptyMap())
        }
        val parsed = parse(template)
        if (!parsed.hasParams) {
            // 没有路径参数时就是原样，不必再 filter 一遍（最常见的路径）
            return params
        }
        return JsonObject(params.filterKeys { it !in parsed.nameSet })
    }

    private const val HEX = "0123456789ABCDEF"
}

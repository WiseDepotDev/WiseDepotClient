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
    private val PARAM = Regex("\\{([^}]+)}")

    /** 模板里的参数名（按出现顺序，去重）。 */
    fun parameterNames(template: String): List<String> =
        PARAM.findAll(template).map { it.groupValues[1] }.distinct().toList()

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
        val path =
            PARAM.replace(template) { m ->
                val name = m.groupValues[1]
                val value = (params?.get(name) as? JsonPrimitive)?.content
                if (value == null) {
                    missing = true
                    m.value
                } else {
                    value
                }
            }
        return if (missing) null else path
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

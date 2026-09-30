package com.huicang.wise.bridge.protocol

/**
 * 桥**内建方法**（不经过后端、也不进生成的契约表）。
 *
 * 为什么单独一块而不是塞进 `BridgeContract`：
 * 契约表是"后端路由的镜像"，由服务端注解生成；内建方法压根没有对应路由，
 * 混进去会破坏"生成物 == 后端接口集合"这条不变量（`--verify-legacy` 就靠它做交叉校验）。
 * 代价是白名单变成两处，因此这里的集合被刻意压到最小，并在测试里断言"不与契约重名"。
 */
object BridgeBuiltins {
    /** 健康探测：返回宿主版本与平台，UI 用它做"桥是否活着"。 */
    const val PING: String = "bridge.ping"

    /** 能力表：与引导文件同内容，但可在运行中重新拉取。 */
    const val CAPABILITIES: String = "bridge.capabilities"

    /** 当前会话身份（谁登录了、有哪些权限点）。令牌本身永不下发。 */
    const val SESSION: String = "bridge.session"

    val all: Set<String> = setOf(PING, CAPABILITIES, SESSION)
}

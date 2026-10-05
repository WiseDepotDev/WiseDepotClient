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

    /**
     * 桥内指标：按方法记次数/失败/耗时（含 p50 近似）。
     *
     * 为什么也要做成内建：它是**桥自己的运行观测**，没有任何后端路由与之对应，
     * 混进契约表会破坏"生成物 == 后端接口集合"这条不变量
     * （`gen-bridge-contract --verify-legacy` 就靠它做交叉校验）。
     *
     * 只读、不改状态、也不下发任何令牌或配置，因此不需要额外权限。
     */
    const val METRICS: String = "bridge.metrics"

    /**
     * 人机验证：让 Web **请求**一次验证（`{purpose, username?, evidence?}` → `{ok}`）。
     *
     * 为什么是内建方法而不是后端路由：它跨了"客户端网络"这一层 ——
     * 桥要先向壳要证据、再算计算量证明、然后用设备私钥签名，最后才调后端的
     * `human.challenge` / `human.verify`。把它做成一条后端路由等于让 Web 自己去做这三件事，
     * 而其中两件（设备私钥、壳证据）Web 根本做不到。
     *
     * **返回里没有票据**：票据留在桥里，由桥在业务调用时注入（见 `HumanPurposeByMethod`）。
     */
    const val HUMAN_VERIFY: String = "bridge.humanVerify"

    val all: Set<String> = setOf(PING, CAPABILITIES, SESSION, METRICS, HUMAN_VERIFY)
}

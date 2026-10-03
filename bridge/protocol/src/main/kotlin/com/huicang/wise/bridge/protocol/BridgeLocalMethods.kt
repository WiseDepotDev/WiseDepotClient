package com.huicang.wise.bridge.protocol

/**
 * 桥**本机方法** id 表（宿主实现、不经过后端、也不进生成的契约表）。
 *
 * 与 [BridgeBuiltins] 的区别只在"谁来处理"：
 *  - 内建（[BridgeBuiltins]）：**桥自己**处理（验活、能力表、会话、指标）；
 *  - 本机（这里）：**宿主**处理 —— 只有宿主能做那件事，桥既不认识也不该认识它。
 *
 * 分发白名单是三段并集（见 `BridgeDispatcher`）：内建 ∪ 本机（宿主用
 * `LocalMethodPort.methodIds` 声明）∪ 契约。因此这里只是**id 的单一出处**：
 * 它不等于"这台宿主已经实现了"，宿主仍然要按"声明即承诺"自己决定登记哪些
 * （登记了做不到的 = 调用回 `BRIDGE_INTERNAL`，比"方法不存在"更难查）。
 *
 * ## 为什么本机方法也要一处常量、而不是在宿主里写字符串
 *
 * 方法 id 是**跨语言线上契约串**：Web 侧 `bridge.call('nfc.openSettings')` 与这里
 * 必须逐字一致，而拼错一个字母的表现是 `BRIDGE_METHOD_UNKNOWN`（看起来像"桥没实现"）。
 * 所以它和错误码、事件 topic 同规格：Kotlin 常量 + TS 常量 + 一条门禁逐字比对。
 */
object BridgeLocalMethods {
    /**
     * 跳到系统 NFC 设置页（B3）。返回 `{opened:boolean}`。
     *
     * 为什么必须是本机方法：**只有壳能跳系统设置页**，Web 侧做不到；
     * 而它没有对应的后端路由，所以不能进契约表（那会破坏
     * "生成物 == 后端接口集合"这条不变量，`--verify-legacy` 就靠它做交叉校验）。
     *
     * 为什么只加这一个方法、没有 `nfc.start`/`nfc.stop`：与相机流同一条教训 ——
     * "自动使用"由壳在 `onResume` 开、`onPause` 关，做成方法就是**双所有者**
     * （壳以为在扫、Web 以为停了）。Web 只消费 `nfc.tag` / `nfc.state` 事件。
     */
    const val NFC_OPEN_SETTINGS: String = "nfc.openSettings"

    /** 本机方法表的全部 id（宿主按实现能力取子集登记）。 */
    val all: Set<String> = setOf(NFC_OPEN_SETTINGS)
}

package com.huicang.wise.bridge.protocol

import kotlinx.serialization.Serializable

/**
 * 引导契约：Web 产物启动后读到的**第一份数据**。
 *
 * 两端同一条路径（架构不变式 2），避免 preload / addJavascriptInterface 这类平台分叉：
 * - 桌面：Electron `protocol.handle("app", …)` 动态生成 `app://wise/__bridge.json`
 * - 手机：`WebViewAssetLoader` 动态生成 `https://appassets.androidplatform.net/__bridge.json`
 *
 * **token 只在这里出现一次**，此后 Web 的每次 WS 握手带上它；业务令牌永不进入 JS 上下文。
 */
@Serializable
data class BridgeBootstrap(
    /** 桥监听的 loopback 临时端口。 */
    val port: Int,
    /** 本次启动新生成的一次性握手 token（256-bit）。 */
    val token: String,
    /** [BridgeCapabilities.PLATFORM_DESKTOP] 或 [BridgeCapabilities.PLATFORM_MOBILE]。 */
    val platform: String,
    /** 宿主版本号，与 [BridgeProtocol.VERSION] 区分：前者是产品版本，后者是协议版本。 */
    val ver: String,
    /** 协议版本，Web 启动时校验，不匹配直接报错而不是静默降级。 */
    val protocol: Int = BridgeProtocol.VERSION,
    /** 本平台实际具备的能力 id 列表（见 [BridgeCapabilities]）。 */
    val capabilities: List<String> = emptyList(),
) {
    /** 能力判定。UI 用它启用/隐藏功能，而不是判断 `platform == "desktop"`。 */
    fun supports(capability: String): Boolean = capability in capabilities
}

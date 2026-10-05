package com.huicang.wise.bridge.protocol

import kotlinx.serialization.Serializable

/**
 * 引导契约：Web 产物启动后读到的**第一份数据**。
 *
 * 两端同一条路径（架构不变式 2），避免 preload / addJavascriptInterface 这类平台分叉：
 * - 桌面：Electron `protocol.handle("app", …)` 动态生成 `app://wise/__bridge.json`
 * - 手机：`WebViewAssetLoader` 动态生成 `https://appassets.androidplatform.net/__bridge.json`
 *
 * **psk 只在这里出现一次，而且永不上线**（v5）：它用于派生会话密钥（见 `BridgeCrypto`），
 * 不再像 v4 那样挂在 WebSocket 的查询串上 —— 于是"握手被谁看见了"不再等于"密钥泄露"。
 * 业务令牌永不进入 JS 上下文（那条纪律不变，见 `SessionManager`）。
 */
@Serializable
data class BridgeBootstrap(
    /** 桥监听的 loopback 临时端口。 */
    val port: Int,
    /**
     * 页面应该连的**主机地址**。
     *
     * 为什么要下发它、而不是让页面假设 `127.0.0.1`：只有宿主知道自己绑在哪。
     * WSA 上必须绑 `loopback0` 的点对点地址 —— 因为 WSA 把发往 127.0.0.1 的包
     * 从那条链路送出去（好让 Windows 宿主能访问 Android 服务），导致 VM 内部连不上自己。
     * 把"环境假设"固化进协议，等于把某个平台的特例变成所有平台的规则。
     */
    val host: String = BridgeProtocol.LOOPBACK_HOST,
    /**
     * **预共享密钥**（v5；v4 里叫 `token`）：每次启动新生成 256-bit，base64url 后是 43 个字符。
     *
     * 两个用途，且只有两个：① 参与 KDF（`K_conn = HMAC(psk, …)`，没有它算不出会话密钥）；
     * ② 因此"能产出合法 AEAD 帧"就是身份证明 —— 握手 URL 上不需要再放任何凭据。
     */
    val psk: String,
    /** [BridgeCapabilities.PLATFORM_DESKTOP] 或 [BridgeCapabilities.PLATFORM_MOBILE]。 */
    val platform: String,
    /** 宿主版本号，与 [BridgeProtocol.VERSION] 区分：前者是产品版本，后者是协议版本。 */
    val ver: String,
    /** 协议版本，Web 启动时校验，不匹配直接报错而不是静默降级。 */
    val protocol: Int = BridgeProtocol.VERSION,
    /** 本平台实际具备的能力 id 列表（见 [BridgeCapabilities]）。 */
    val capabilities: List<String> = emptyList(),
    /**
     * 本壳实际执行的上限（v4）。
     *
     * 为什么要下发而不是让客户端硬编码常量：客户端在**发之前**就能判断
     * "这个 6MiB 的图片能不能走帧内"，而不是靠撞上限来学习 —— 后者在 v3 里表现为
     * "明明只是发了张图，却收到一条 BRIDGE_FRAME_TOO_LARGE"。
     */
    val limits: BridgeLimits = BridgeLimits(),
) {
    /** 能力判定。UI 用它启用/隐藏功能，而不是判断 `platform == "desktop"`。 */
    fun supports(capability: String): Boolean = capability in capabilities
}

/** 线格式上限（字节）。默认值就是协议常量，壳只在确有理由时才收紧。 */
@Serializable
data class BridgeLimits(
    /** 控制面正文上限（`req`/`res`/`err`/`evt`）。 */
    val textMaxBytes: Int = BridgeProtocol.MAX_FRAME_BYTES,
    /** 数据面（`bin`）正文上限。 */
    val binMaxBytes: Int = BridgeProtocol.MAX_BIN_BYTES,
)

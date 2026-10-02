package com.huicang.wise.bridge.protocol

/**
 * 桥协议的**常量与边界**（协议 v3 的冻结面）。
 *
 * 这一层不含 Netty、不含 Android、不含网络，因此它可以在纯 JVM 单测里被穷举，
 * 也是契约一致性测试（Kotlin 注册表 ↔ TS 客户端）的公共靶子。
 *
 * 见 `docs/protocol.md`。
 */
object BridgeProtocol {
    /**
     * 协议版本。任何不兼容改动都要 +1，并在 docs/protocol.md 里记变更。
     *
     * v4：**全二进制线格式**（12 字节帧头，见 [BridgeWire]）。v3 的文本帧 JSON 信封不再使用，
     * 收到文本帧一律回 [BridgeErrorCodes.WIRE_MODE] 而不是静默兼容 —— 半兼容的"看起来能用"
     * 比明确失败更难查（与 `__bridge.json` 版本不符就报错是同一条纪律）。
     */
    const val VERSION: Int = 4

    /** WebSocket 握手路径（宿主绑定在 loopback 的临时端口上）。 */
    const val HANDSHAKE_PATH: String = "/bridge"

    /**
     * 绑定与连接的**固定** loopback 地址。
     *
     * 为什么不直接用 `InetAddress.getLoopbackAddress()`：它在双栈机器上可能返回 `::1`，
     * 而引导文件与 Web 侧固定连 `127.0.0.1` —— 两者不一致的表现是"端口明明绑上了，
     * 客户端却 ECONNREFUSED"，且只在部分机器上复现。（W2 实测踩到过一次，见
     * `tools/bench/bridge-roundtrip.mjs` 的握手用例。）
     */
    const val LOOPBACK_HOST: String = "127.0.0.1"

    /** 引导文件路径：由宿主在**应用自身 origin** 上动态生成，Web 产物第一步读它。 */
    const val BOOTSTRAP_PATH: String = "/__bridge.json"

    /**
     * **控制面**正文上限 256KB（`req`/`res`/`err`/`evt`）。
     *
     * 超过它的数据（录像、大导出件、PDF）一律走带外 `file.*` / `oss.*` 方法换取
     * 一次性 URL，用普通 HTTP 取，避免把 WS 帧撑大（背压与内存都在这里失控）。
     * 中等的二进制对象（照片、截图、验证码原图）走数据面 [MAX_BIN_BYTES]。
     */
    const val MAX_FRAME_BYTES: Int = 256 * 1024

    /**
     * **数据面**（`bin`）正文上限 8MiB。
     *
     * 为什么单开一个更大的上限、而不是把 256KB 抬上去：控制面是**每次交互都走**的通道，
     * 它的上限要小到"失控的页面撑不爆内存"；而二进制对象是**偶发**的，
     * 用同一个上限会逼着每个中等对象都去走带外 URL（多一条网络路径、多一套失效与鉴权语义）。
     *
     * 上限**由 `__bridge.json` 的 `limits` 下发**：客户端在**发之前**就知道能不能发，
     * 不用靠撞上限来学习。
     */
    const val MAX_BIN_BYTES: Int = 8 * 1024 * 1024

    /** 进度类事件的最低间隔，防止上传/导出把 UI 刷爆。 */
    const val EVENT_MIN_INTERVAL_MS: Long = 100
}

/**
 * 桥自身的错误码。
 *
 * 约定：**桥只负责自己的错误**；后端返回的业务错误原样透传后端的 `RES-xxxx` 码，
 * 文案不下发、只给 `messageKey`（沿用旧版"谁展示谁拥有"的口径）。
 */
object BridgeErrorCodes {
    /** 方法不在注册表白名单内。桥**不是**通用 HTTP 透传，这是安全红线。 */
    const val METHOD_UNKNOWN: String = "BRIDGE_METHOD_UNKNOWN"

    /**
     * 线格式不认识（v3 的文本帧、帧头 magic/版本不对、未知 kind/flags、非 0 的扩展头…）。
     *
     * 单列一个码而不是复用 `PARAMS_INVALID`：这两件事的**处理人不同** ——
     * 参数错是调用方写错了业务参数；线格式错是**客户端与壳不是同一版协议**，
     * 用户和开发者需要看到的是"重新装一次/换回匹配的版本"，而不是"参数不合法"。
     */
    const val WIRE_MODE: String = "BRIDGE_WIRE_MODE"

    /** 参数未通过 schema 校验。 */
    const val PARAMS_INVALID: String = "BRIDGE_PARAMS_INVALID"

    /** 握手 token 或 Origin 校验失败。 */
    const val UNAUTHORIZED: String = "BRIDGE_UNAUTHORIZED"

    /** 帧超过 [BridgeProtocol.MAX_FRAME_BYTES]。 */
    const val FRAME_TOO_LARGE: String = "BRIDGE_FRAME_TOO_LARGE"

    /** 单连接限流命中。 */
    const val RATE_LIMITED: String = "BRIDGE_RATE_LIMITED"

    /** 后端不可达（网络层错误，非业务错误）。 */
    const val BACKEND_UNREACHABLE: String = "BRIDGE_BACKEND_UNREACHABLE"

    /** 壳内部异常（兜底，唯一入口）。 */
    const val INTERNAL: String = "BRIDGE_INTERNAL"
}

/**
 * 平台能力标识。
 *
 * 平台差异**只**表现为这些 id 在 `capabilities` 列表里出现与否；
 * 不允许出现"桌面一套代码、手机一套代码"（架构不变式 2）。
 */
object BridgeCapabilities {
    const val PLATFORM_DESKTOP: String = "desktop"
    const val PLATFORM_MOBILE: String = "mobile"

    // ---- 采集 ----
    const val SCAN_CAMERA: String = "scan.camera"
    const val SCAN_GUN_KEYBOARD: String = "scan.gun.keyboard"
    const val SCAN_GUN_SERIAL: String = "scan.gun.serial"
    const val NFC_READ: String = "nfc.read"
    const val RFID_READER: String = "rfid.reader"

    // ---- 输出 ----
    const val PRINT_LABEL: String = "print.label"
    const val PRINT_SYSTEM: String = "print.system"

    // ---- 窗口 ----
    const val WINDOW_CONTROL: String = "window.control"
    const val WINDOW_MULTI: String = "window.multi"

    // ---- 存储与离线 ----
    const val FILE_DIALOG: String = "file.dialog"
    const val SECURE_STORE: String = "storage.secure"
    const val OFFLINE_QUEUE: String = "offline.queue"

    /**
     * 桌面与手机都具备的能力（能力表的**共同子集**，UI 可以无条件使用）。
     *
     * 这里曾经写着 `{storage.secure, offline.queue, print.system}` —— **三项里两项是假的**：
     * 两个壳都没实现离线队列，也没实现系统打印，`common` 却替它们打了包票。
     * "常量声称有、实际没有"比不声明更糟：UI 会据此画出永远不工作的入口。
     *
     * 现在的口径：**只列两个壳都真的声明了的能力**。加新项之前先改两个壳的声明。
     */
    val common: Set<String> = setOf(SECURE_STORE, SCAN_GUN_KEYBOARD)
}

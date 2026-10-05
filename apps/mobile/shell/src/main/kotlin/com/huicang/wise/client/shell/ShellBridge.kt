package com.huicang.wise.client.shell

import com.huicang.wise.bridge.backend.OkHttpBackend
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeBootstrap
import com.huicang.wise.bridge.protocol.BridgeCapabilities
import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.server.BridgeServer
import com.huicang.wise.bridge.server.BridgeServerConfig
import com.huicang.wise.bridge.server.DEFAULT_ALLOWED_ORIGINS
import com.huicang.wise.bridge.server.UnreadNotifier
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom
import java.util.Base64

/**
 * 手机平台适配。
 *
 * **只声明真正实现的能力**：虚假能力会让 UI 高高兴兴地画出一个按下去没反应的按钮。
 * 扫码枪（`scan.gun.keyboard`）已实现；相机（B2/CameraX）与打印、离线队列在 W8 接入，
 * 届时在 [ANDROID_CAPABILITIES] 逐个加，UI 自动跟着亮。
 * NFC 读卡（B3）的**实现**已经落地（`NfcReader`），但**声明**还压着 —— 见 [NFC_READ_VERIFIED]。
 */
class AndroidPlatform(
    override val version: String,
    override val capabilities: Set<String> = ANDROID_CAPABILITIES,
) : PlatformPort {
    override val platform: String = BridgeCapabilities.PLATFORM_MOBILE
}

/**
 * Android 宿主声明自己具备的能力。
 *
 * 抽成常量是因为 [ShellBridge] 需要**按实际能不能做到**去过滤它
 * （拿不到 Keystore 时要把 `storage.secure` 摘掉）。
 */
val ANDROID_CAPABILITIES: Set<String> =
    setOf(
        BridgeCapabilities.SECURE_STORE,
        // 键盘式扫码枪：它就是一只 USB HID 键盘，字符直接进 WebView 的 keydown 流，
        // 因此这一项**不需要任何原生代码**（识别逻辑在 @wise/scan，两端共用）。
        BridgeCapabilities.SCAN_GUN_KEYBOARD,
        /*
         * 系统通知（消息）。**声明即承诺**：Android 13+ 用户拒绝通知权限时，
         * [ShellBridge] 会在权限结果回来时**撤回**这一项（见 MainActivity 的权限请求），
         * 于是界面不会留一个"永远不工作的开关"。
         */
        BridgeCapabilities.NOTIFY_SYSTEM,
        /*
         * 人机验证：壳能回答"是不是发布包、有没有挂调试器"（见 `AndroidEvidence`）。
         * **声明即承诺**：它与 `humanVerifyPort` 参数是同一批加的，两者不许只加一个 ——
         * 声明了却拿不出证据，界面会画出一个点了没反应的按钮。
         */
        BridgeCapabilities.HUMAN_VERIFY,
    )

/**
 * `nfc.read` **现在是否可以对外声明**（B3/S4 的唯一开关，当前刻意关着）。
 *
 * ## 为什么实现了还不声明
 *
 * brief §7.2：能力声明即承诺 —— 提前声明就是给用户画一个"贴了没反应"的入口
 * （B1 已经为同类错误推翻过一次设计）。NFC 只能在**真手机**上验（WSA 的 NFC 不可用），
 * 本机没有真机证据，所以这里保持 `false`，界面上连入口都不会出现（brief §4 第一行）。
 *
 * ## 翻转条件（一次真机走查，全绿才翻）
 *
 * 1. 装到有 NFC 的手机上，进入应用 → 贴一张卡 → logcat 出现 `[nfc] 读到标签 id=… tech=…`；
 * 2. 把系统 NFC 关掉再进应用 → 出现 `[nfc] 未进入读卡：DISABLED`；
 * 3. 切后台后另一款 NFC 应用能接管（说明 reader mode 真的关了）。
 *
 * 三条都过 → 把这里改成 `true` 并跑一遍 `pnpm check`（`check:nfc` 会核对声明路径
 * 仍然要求"有硬件"这个条件）。**只改这一行**：能力位、事件、界面都是同一份判据。
 */
const val NFC_READ_VERIFIED: Boolean = false

/**
 * 手机壳的桥宿主：**同一份** [BridgeServer]（与桌面用的完全一样），只是托管方式不同——
 * 这里跑在应用进程内，桌面那边跑在独立 JVM 进程里。
 *
 * 启动是阻塞的（`bind().sync()`），因此必须放到后台线程；同时要把"桥还没起来"这一段
 * 对 WebView 表达清楚，否则 Web 会拿到 503 然后一直转圈。
 */
object ShellBridge {
    @Volatile private var server: BridgeServer? = null

    @Volatile private var bootstrapJson: String? = null

    /**
     * 应用当前是否在前台（由 [MainActivity] 的 `onResume/onPause` 维护）。
     *
     * 用途只有一个：**前台不弹系统通知**（界面自己会在 10 秒内刷新出那条消息）。
     * 用 `@Volatile` 而不是 Lifecycle：这个壳只有一个 Activity，两行更直白。
     */
    @Volatile var foreground: Boolean = false

    /** 桥就绪后才有值；未就绪时引导接口应回 503。 */
    val ready: Boolean get() = server != null

    val handshakeJson: String? get() = bootstrapJson

    /**
     * 广播一条本机事件给所有连接的 WebView（`nfc.tag` / `nfc.state`）。
     *
     * 桥还没起来时**静默丢弃**：事件是"现在是什么状态"，不是要补发的消息 ——
     * 排进队列等桥起来再发反而会让界面收到一条过期的状态。
     *
     * 线程：调用方负责切回主线程（`NfcReader` 的回调来自 binder 线程，
     * 它在 `mainHandler` 上回投，见 `NfcReader` 的说明）。这里只做转发。
     */
    fun emit(
        topic: String,
        data: JsonElement? = null,
    ) {
        server?.emit(topic, data)
    }

    /** 已经定下来的引导内容（端口/psk/地址/版本），能力表可在此基础上变动。 */
    private var bootBase: BootBase? = null

    /** 当前**如实**声明着的能力。 */
    @Volatile private var declared: Set<String> = emptySet()

    /** 桥事件订阅（`notify.message` → 系统通知）；`stop()` 时要退订。 */
    private var notifySubscription: AutoCloseable? = null

    private data class BootBase(
        val port: Int,
        /** v5：预共享密钥（v4 里叫 token）—— 只经引导文件下发，**永不上线**。 */
        val psk: String,
        val host: String,
        val platform: String,
        val version: String,
    )

    /**
     * 撤回一项已经声明过的能力，并**就地重写引导**。
     *
     * 用途是"声明时以为能做到、用起来才发现做不到"：唯一已知的例子是相机
     * （见 [CameraSafety]）。不撤回的话，页面重载后仍然会画出扫码入口，
     * 用户点一次崩一次。
     *
     * 重写而不是"下次启动再说"：引导是页面每次加载都重新拉的（`__bridge.json`），
     * 所以撤回立刻对**这一次重建的 WebView** 生效。
     */
    @Synchronized
    fun revokeCapability(
        capability: String,
        reason: String,
    ) {
        val base = bootBase ?: return
        if (capability !in declared) {
            return
        }
        declared = declared - capability
        bootstrapJson = encode(base, declared)
        android.util.Log.w("WiseShell", "已撤回能力 $capability：$reason")
    }

    private fun encode(
        base: BootBase,
        capabilities: Set<String>,
    ): String =
        BridgeCodec.json.encodeToString(
            BridgeBootstrap.serializer(),
            BridgeBootstrap(
                port = base.port,
                psk = base.psk,
                host = base.host,
                platform = base.platform,
                ver = base.version,
                capabilities = capabilities.sorted(),
            ),
        )

    /** 幂等：重复调用不会起第二个桥（Activity 重建、多入口都靠这个）。 */
    @Synchronized
    fun startIfNeeded(
        /** 应用上下文：弹系统通知要用它（[MessageNotifier]）。 */
        appContext: android.content.Context,
        version: String,
        filesDir: java.io.File,
        hasCamera: Boolean = false,
        hasNfc: Boolean = false,
    ) {
        if (server != null) {
            return
        }
        // 接管桥的日志出口：Android 上 stderr 不保证进 logcat，现场就抓不到桥的日志。
        com.huicang.wise.bridge.server.BridgeLog.sink = { android.util.Log.i("WiseShell", it) }
        // WSA 会把发往 127.0.0.1 的包从 loopback0 送出去，导致 VM 内部连不上自己监听的端口；
        // 因此绑定地址必须**探测**（桌面/真机会得到 127.0.0.1，行为完全不变）。
        val host = com.huicang.wise.bridge.server.BridgeHostResolver.resolve()
        android.util.Log.i("WiseShell", "桥将绑定：$host（候选：${com.huicang.wise.bridge.server.BridgeHostResolver.candidates()}）")
        val psk = newToken()
        val tokens = tokenStore(filesDir)
        // 能力必须**如实**：拿不到 Keystore 就不能声明 storage.secure。
        // 声明了做不到的能力比不声明更糟 —— UI 会据此画出永远不工作的入口。
        val capabilities =
            (
                ANDROID_CAPABILITIES +
                    (if (hasCamera) setOf(BridgeCapabilities.SCAN_CAMERA) else emptySet()) +
                    /*
                     * NFC（B3/S4）：**两个条件同时成立**才声明 ——
                     *  · 有硬件：没有就是"贴了没反应"的入口（手机侧不画入口由能力位决定）；
                     *  · 真机上读到标签这件事已经验过：见 [NFC_READ_VERIFIED]（当前正是它压着不声明）。
                     */
                    (if (hasNfc && NFC_READ_VERIFIED) setOf(BridgeCapabilities.NFC_READ) else emptySet())
            )
                .filter { it != BridgeCapabilities.SECURE_STORE || tokens.persistent }
                .toSet()
        if (!tokens.persistent) {
            android.util.Log.w(
                "WiseShell",
                "本机拿不到 Android Keystore，凭据改为仅存内存（重启后需要重新登录），" +
                    "并已撤回 ${BridgeCapabilities.SECURE_STORE} 能力声明",
            )
        }
        val instance =
            BridgeServer(
                BridgeServerConfig(
                    port = 0,
                    psk = psk,
                    backend =
                        OkHttpBackend(
                            BuildConfig.WISE_BACKEND_URL,
                            tokens,
                            log = { android.util.Log.w("WiseShell", it) },
                        ),
                    platform = AndroidPlatform(version, capabilities),
                    tokens = tokens,
                    // 本机方法表（B3/S3）：NFC 设置页只能由壳跳。它**与后端无关**，
                    // 因此不走契约表 —— 见 `BridgeLocalMethods`。
                    local = NfcLocalMethods(),
                    // 人机验证的本地证据（只有壳看得见的事实）
                    humanVerifyPort = AndroidEvidence(appContext),
                    // 设备密钥：与令牌同一份安全存储口径（Keystore 加密落盘；
                    // 拿不到 Keystore 就不落盘 —— 代价只是服务端视为新设备，绝不写明文）
                    deviceKeyFile =
                        if (AndroidKeystoreCodec.available()) {
                            java.nio.file.Paths.get(java.io.File(filesDir, "bridge-device-key.enc").absolutePath)
                        } else {
                            null
                        },
                    deviceKeyCodec = if (AndroidKeystoreCodec.available()) AndroidKeystoreCodec() else null,
                    allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
                    host = host,
                    // 传输保持与桌面一致（Netty）。曾经因为"WSA 上连不上"改用过纯 socket 实现，
                    // 但启动自检证明**换传输也没用**：bind 成功、本进程回连自己都失败 ——
                    // 那是 WSA 容器的 loopback 环境问题，与传输实现无关。
                    // 纯 socket 实现（BridgeTransportKind.PLAIN_SOCKET）保留为已验证的退路：
                    // 它跑同一套 bench 同样 13/13 通过（见 tools/bench/bridge-roundtrip.mjs --transport plain）。
                ),
            )
        val boundPort = instance.start()
        server = instance

        /*
         * 桥的事件 → **系统通知**（消息）。
         *
         * 为什么在这里订阅（而不是让页面去调）：通知最该出现的时刻是应用在后台，
         * 那时 WebView 里的 JS 可能已经被系统冻结；而桥与壳同进程，
         * 直接订阅 `onEvent` 不依赖页面还活着。
         */
        notifySubscription =
            instance.onEvent { topic, data ->
                if (topic != UnreadNotifier.TOPIC_MESSAGE) {
                    return@onEvent
                }
                val payload = data as? JsonObject ?: return@onEvent
                val latest = payload["latest"] as? JsonObject ?: return@onEvent
                fun text(key: String): String = (latest[key] as? JsonPrimitive)?.content ?: ""
                val id = text("id")
                val title = text("title")
                val audible = (payload["audible"] as? JsonPrimitive)?.content?.toBoolean() ?: false
                val shown =
                    MessageNotifier.show(
                        context = appContext,
                        id = id,
                        title = title,
                        body = text("body"),
                        audible = audible,
                        foreground = foreground,
                    )
                android.util.Log.i(
                    "WiseShell",
                    "[notify] ${if (shown) "已弹系统通知" else "未弹（前台可见 / 无权限 / 缺字段）"} id=$id",
                )
            }
        // 这一行是现场排障的锚点：地址/端口不对或没打印 = 桥根本没起来。
        // 地址必须打印**实际绑定的那个**（WSA 上不是 127.0.0.1），否则日志会把人带偏。
        android.util.Log.i("WiseShell", "桥已启动：$host:$boundPort，后端 ${BuildConfig.WISE_BACKEND_URL}")
        val base =
            BootBase(
                port = boundPort,
                psk = psk,
                host = host,
                platform = AndroidPlatform(version).platform,
                version = version,
            )
        bootBase = base
        declared = capabilities
        bootstrapJson = encode(base, capabilities)
    }

    /**
     * 令牌存储：能用 Keystore 就加密落盘，用不了就退回内存**并如实撤回能力声明**。
     *
     * 为什么宁可"重启重新登录"也不明文落盘：令牌是长期凭据，
     * 明文文件等于把这台机器变成一把钥匙；而重新登录的代价只是几十秒。
     */
    private fun tokenStore(filesDir: java.io.File): com.huicang.wise.bridge.backend.TokenStore {
        if (!AndroidKeystoreCodec.available()) {
            return com.huicang.wise.bridge.backend.InMemoryTokenStore()
        }
        return com.huicang.wise.bridge.backend.PersistentTokenStore(
            filePath = java.io.File(filesDir, "bridge-session.enc").absolutePath,
            codec = AndroidKeystoreCodec(),
            log = { android.util.Log.i("WiseShell", it) },
        )
    }

    fun stop() {
        notifySubscription?.close()
        notifySubscription = null
        server?.stop()
        server = null
        bootstrapJson = null
        bootBase = null
        declared = emptySet()
    }

    private fun newToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

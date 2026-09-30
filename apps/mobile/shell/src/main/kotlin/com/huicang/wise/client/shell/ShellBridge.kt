package com.huicang.wise.client.shell

import com.huicang.wise.bridge.backend.OkHttpBackend
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeBootstrap
import com.huicang.wise.bridge.protocol.BridgeCapabilities
import com.huicang.wise.bridge.protocol.BridgeCodec
import com.huicang.wise.bridge.server.BridgeServer
import com.huicang.wise.bridge.server.BridgeServerConfig
import com.huicang.wise.bridge.server.DEFAULT_ALLOWED_ORIGINS
import java.security.SecureRandom
import java.util.Base64

/**
 * 手机平台适配。
 *
 * **只声明真正实现的能力**：虚假能力会让 UI 高高兴兴地画出一个按下去没反应的按钮。
 * 扫码/相机/NFC/打印/离线队列在 W8 接入，届时在这里逐个加，UI 自动跟着亮。
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
    )

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

    /** 桥就绪后才有值；未就绪时引导接口应回 503。 */
    val ready: Boolean get() = server != null

    val handshakeJson: String? get() = bootstrapJson

    /** 幂等：重复调用不会起第二个桥（Activity 重建、多入口都靠这个）。 */
    @Synchronized
    fun startIfNeeded(
        version: String,
        filesDir: java.io.File,
        hasCamera: Boolean = false,
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
        val token = newToken()
        val tokens = tokenStore(filesDir)
        // 能力必须**如实**：拿不到 Keystore 就不能声明 storage.secure。
        // 声明了做不到的能力比不声明更糟 —— UI 会据此画出永远不工作的入口。
        val capabilities =
            (ANDROID_CAPABILITIES + (if (hasCamera) setOf(BridgeCapabilities.SCAN_CAMERA) else emptySet()))
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
                    token = token,
                    backend = OkHttpBackend(BuildConfig.WISE_BACKEND_URL, tokens),
                    platform = AndroidPlatform(version, capabilities),
                    tokens = tokens,
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
        // 这一行是现场排障的锚点：地址/端口不对或没打印 = 桥根本没起来。
        // 地址必须打印**实际绑定的那个**（WSA 上不是 127.0.0.1），否则日志会把人带偏。
        android.util.Log.i("WiseShell", "桥已启动：$host:$boundPort，后端 ${BuildConfig.WISE_BACKEND_URL}")
        bootstrapJson =
            BridgeCodec.json.encodeToString(
                BridgeBootstrap.serializer(),
                BridgeBootstrap(
                    port = boundPort,
                    token = token,
                    host = host,
                    platform = AndroidPlatform(version).platform,
                    ver = version,
                    capabilities = capabilities.sorted(),
                ),
            )
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
        val file = java.io.File(filesDir, "bridge-session.enc").toPath()
        return com.huicang.wise.bridge.backend.PersistentTokenStore(
            file = file,
            codec = AndroidKeystoreCodec(),
            log = { android.util.Log.i("WiseShell", it) },
        )
    }

    fun stop() {
        server?.stop()
        server = null
        bootstrapJson = null
    }

    private fun newToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

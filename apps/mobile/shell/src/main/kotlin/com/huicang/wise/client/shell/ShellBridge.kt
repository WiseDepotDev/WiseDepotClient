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
    override val capabilities: Set<String> = setOf(BridgeCapabilities.SECURE_STORE),
) : PlatformPort {
    override val platform: String = BridgeCapabilities.PLATFORM_MOBILE
}

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
    fun startIfNeeded(version: String) {
        if (server != null) {
            return
        }
        val token = newToken()
        val tokens = com.huicang.wise.bridge.backend.InMemoryTokenStore()
        val instance =
            BridgeServer(
                BridgeServerConfig(
                    port = 0,
                    token = token,
                    backend = OkHttpBackend(BuildConfig.WISE_BACKEND_URL, tokens),
                    platform = AndroidPlatform(version),
                    tokens = tokens,
                    allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
                ),
            )
        val boundPort = instance.start()
        server = instance
        bootstrapJson =
            BridgeCodec.json.encodeToString(
                BridgeBootstrap.serializer(),
                BridgeBootstrap(
                    port = boundPort,
                    token = token,
                    platform = AndroidPlatform(version).platform,
                    ver = version,
                    capabilities = AndroidPlatform(version).capabilities.sorted(),
                ),
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

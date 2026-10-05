package com.huicang.wise.bridge.host.desktop

import com.huicang.wise.bridge.backend.InMemoryTokenStore
import com.huicang.wise.bridge.backend.OkHttpBackend
import com.huicang.wise.bridge.backend.PersistentTokenStore
import com.huicang.wise.bridge.backend.TokenStore
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeCapabilities
import com.huicang.wise.bridge.server.BridgeHostResolver
import com.huicang.wise.bridge.server.BridgeLog
import com.huicang.wise.bridge.server.BridgeServer
import com.huicang.wise.bridge.server.BridgeServerConfig
import com.huicang.wise.bridge.server.BridgeTransportKind
import com.huicang.wise.bridge.server.DEFAULT_ALLOWED_ORIGINS
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.PrintStream
import java.security.SecureRandom
import java.util.Base64
import kotlin.system.exitProcess

/**
 * 桌面桥宿主：由 Electron 主进程 spawn 的**独立 JVM 进程**。
 *
 * 生命周期只有四步：
 * 1. 绑 127.0.0.1 的临时端口；
 * 2. 生成一次性握手 token，并**从 stdout 输出首行 JSON**（token 不走 argv ——
 *    argv 对本机其它用户可见）；
 * 3. 服务到 stdin 收到 `shutdown`；
 * 4. 退出前优雅关停。
 *
 * 若后端不可达也照常启动：桥的职责是"让 UI 能显示错误"，而不是"后端不通就别启动"。
 */
private data class Args(
    val backend: String,
    val port: Int,
    val version: String,
    val capabilities: Set<String>,
    val origins: Set<String>,
    val maxPerSecond: Int,
    val accessToken: String?,
    val transport: BridgeTransportKind,
    /** 未读轮询间隔（毫秒）。验收脚本会压小它，默认值仍是桥里的 10 秒。 */
    val notifyPollMs: Long,
    /** 绑定地址。桌面缺省 127.0.0.1；WSA 之类的环境需要传点对点地址（见 BridgeHostResolver）。 */
    val host: String,
    /**
     * 令牌加密落盘的位置。**不传就不落盘**（仅内存，重启后需重新登录）。
     * 由真正的宿主显式指定，理由见 [main] 里的说明。
     */
    val tokenFile: String?,
    /**
     * 设备密钥（人机验证签名用）的加密落盘位置。**不传就不落盘**（仅内存，重启换一把）。
     *
     * 与 [tokenFile] 分开：令牌是**凭据**（登出即失效），设备密钥只用于"同一台设备签名"，
     * 两者的生命周期不同 —— 合成一个文件会让"登出清令牌"顺手把设备身份也清掉。
     */
    val deviceKeyFile: String?,
)

private fun parseArgs(argv: Array<String>): Args {
    val map = mutableMapOf<String, String>()
    var i = 0
    while (i < argv.size) {
        val key = argv[i]
        if (key.startsWith("--")) {
            val value = argv.getOrNull(i + 1)?.takeIf { !it.startsWith("--") }
            map[key.removePrefix("--")] = value ?: "true"
            i += if (value != null) 2 else 1
        } else {
            i += 1
        }
    }
    return Args(
        backend = map["backend"] ?: error("缺少 --backend（例：--backend http://10.0.0.7:8080）"),
        port = map["port"]?.toIntOrNull() ?: 0,
        version = map["ver"] ?: "0.0.0-dev",
        // 能力表**只声明已实现的**：虚假能力会让 UI 高高兴兴地画出一个按下去没反应的按钮
        capabilities = (map["capabilities"] ?: BridgeCapabilities.SECURE_STORE).split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet(),
        origins = (map["origins"] ?: DEFAULT_ALLOWED_ORIGINS.joinToString(",")).split(',').map { it.trim() }.toSet(),
        maxPerSecond = map["max-rps"]?.toIntOrNull() ?: 50,
        /**
         * 启动时预置的访问令牌：宿主从安全存储恢复会话时用它（W3），
         * 验收脚本也用它验证"带无效令牌 → 401"这条路径。
         *
         * 注意它出现在 argv 里，因此**只用于测试与本地调试**；真实恢复流程应走 stdin 或安全存储。
         */
        accessToken = map["access-token"]?.takeIf { it.isNotBlank() },
        // 不传 = 不落盘（默认）。见 Args.tokenFile 的说明。
        tokenFile = map["token-file"]?.takeIf { it.isNotBlank() },
        // 不传 = 设备密钥不落盘（重启换一把，服务端会视为新设备）。同上：路径由宿主显式指定。
        deviceKeyFile = map["device-key-file"]?.takeIf { it.isNotBlank() },
        // 桌面默认 Netty；`--transport plain` 用纯 socket 实现，供"两条传输语义一致"的对照验收。
        transport =
            if (map["transport"] == "plain") {
                BridgeTransportKind.PLAIN_SOCKET
            } else {
                BridgeTransportKind.NETTY
            },
        // 不传就自动探测：桌面会得到 127.0.0.1，WSA 会得到 loopback0 的地址
        host = map["host"]?.takeIf { it.isNotBlank() } ?: BridgeHostResolver.resolve(),
        /*
         * 未读轮询间隔。默认 10 秒（见 BridgeServerConfig.notifyPollMs）。
         *
         * 为什么允许宿主覆盖：**这条链的唯一证据只能端到端拿** —— "后端未读涨了 ⇒
         * stdout 上出现一行 notify.message"。而按 10 秒轮询去验，一个用例要等十几秒，
         * 慢门禁的下场是被跳过。验收脚本把它压到几百毫秒（默认值不变）。
         */
        notifyPollMs = map["notify-poll-ms"]?.toLongOrNull() ?: 10_000,
    )
}

/** 桌面平台适配：W2 只声明"结构上已成立"的能力（见 parseArgs 的注释）。 */
private class DesktopPlatform(
    override val version: String,
    override val capabilities: Set<String>,
) : PlatformPort {
    override val platform: String = BridgeCapabilities.PLATFORM_DESKTOP
}

/**
 * 生成本次启动的 **psk**（v5；v4 里叫 token）：256-bit，base64url 后 43 个字符。
 *
 * 它不再挂在握手 URL 上（那是 v4 的做法），只经 stdout → 宿主 → `__bridge.json` 下发给页面。
 */
private fun newPsk(): String {
    val bytes = ByteArray(32)
    SecureRandom().nextBytes(bytes)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

fun main(argv: Array<String>) {
    /*
     * **stdout / stderr 强制 UTF-8**（必须在任何一行输出之前）。
     *
     * 父进程（Electron）按 UTF-8 逐行读 stdout，而 JVM 的 `System.out` 用的是**平台编码** ——
     * Windows 中文机器上是 GBK。于是带中文的事件行（消息标题几乎必然是中文）到壳里就是乱码：
     * 通知条目能弹出来，但文案是"�豸�쳣"这种，而且**任何一层都不会报错**。
     *
     * 这个 bug 藏得住是因为握手那一行（`psk`）纯 ASCII：只要不出现非 ASCII 字符，两条流看起来都对。
     * 逼出它的是 `bench:desktop` 的第 6 节（真中文标题端到端），静态门禁对此无能为力。
     * 日志走 stderr、同理处理（`BridgeLog` 在调用时才读 `System.err`，所以在这里换掉有效）。
     */
    System.setOut(PrintStream(FileOutputStream(FileDescriptor.out), true, "UTF-8"))
    System.setErr(PrintStream(FileOutputStream(FileDescriptor.err), true, "UTF-8"))

    val args = parseArgs(argv)
    val psk = newPsk()

    /**
     * 令牌存储。
     *
     * **默认不落盘**：只有宿主显式传 `--token-file` 时才启用加密持久化。
     * 这个默认值是有意的 —— 所有 bench / 冒烟脚本都会 spawn 同一个宿主 jar，
     * 如果默认就落盘，它们登录后会把凭据写进用户的会话文件，
     * 表现为"下次开应用莫名以别的账号登着"。
     *
     * 能用 DPAPI 就加密；用不了就退回内存**并撤回 `storage.secure` 声明**，
     * **绝不降级成明文落盘**（明文凭据文件比"重启重新登录"危险得多）。
     */
    val tokenFile = args.tokenFile
    val tokens: TokenStore =
        when {
            tokenFile == null -> InMemoryTokenStore()
            DpapiCodec.available() -> {
                // 这行是现场排障的锚点：用户说"每次开都要重新登录"时，
                // 先看这里 —— 没有这行就说明宿主根本没拿到 --token-file（持久化没启用）。
                //
                // 必须走 BridgeLog（stderr）而不是 println：stdout 被握手行占着，
                // 主进程只解析它、不转发它 —— 我第一版用 println，结果这行**根本看不见**。
                BridgeLog.info("凭据将加密保存（DPAPI）：$tokenFile")
                PersistentTokenStore(file = java.nio.file.Paths.get(tokenFile), codec = DpapiCodec()) {
                    BridgeLog.info(it)
                }
            }
            else -> {
                BridgeLog.info("本机拿不到 DPAPI，凭据仅存内存（重启后需要重新登录）")
                InMemoryTokenStore()
            }
        }
    args.accessToken?.let { tokens.update(it, null) }

    /*
     * 设备密钥（人机验证用）。
     *
     * 与令牌同一套口径：**默认不落盘**、只有宿主显式传 `--device-key-file` 才加密保存；
     * 拿不到 DPAPI 就退回内存（重启换一把，代价只是"服务端会认为是新设备"，不影响安全）。
     * 它**不是凭据**：只用来给一次挑战签名，不授予任何权限。
     */
    val deviceKeyFile = args.deviceKeyFile?.let { java.nio.file.Paths.get(it) }
    val deviceKeyCodec = if (deviceKeyFile != null && DpapiCodec.available()) DpapiCodec() else null
    if (deviceKeyFile != null && deviceKeyCodec == null) {
        BridgeLog.info("本机拿不到 DPAPI，设备密钥仅存内存（重启后服务端会视为新设备）")
    }

    // 能力必须**如实**：拿不到加密存储就不能声明 storage.secure ——
    // 声明了做不到的能力比不声明更糟（UI 会据此画出永远不工作的入口）。
    val capabilities =
        if (tokens.persistent) {
            args.capabilities
        } else {
            args.capabilities - BridgeCapabilities.SECURE_STORE
        }

    /*
     * 宿主控制通道（stdout）：**一条 JSON 一行**。
     *
     * 为什么用 stdout：日志走的是 stderr（见 [BridgeLog] 的说明），stdout 上本来就只有
     * 握手那一行 —— 它天然是"父进程与桥之间的控制通道"，不需要再开一条 socket/管道。
     *
     * 三种行：
     *   `{"v":1,"type":"handshake",…}` —— 第一条，父进程据此拿到端口与 psk
     *   `{"v":1,"type":"event","topic":"…","data":{…}}` —— 事件（新消息通知等）
     *   `{"v":1,"type":"evidence-request","id":"…"}` —— 桥向壳要本地环境证据，父进程在 stdin 回同 id
     */
    val stdoutLock = Any()

    fun writeControlLine(json: JsonObject) {
        synchronized(stdoutLock) {
            println(json.toString())
            System.out.flush()
        }
    }

    /*
     * "桥问、壳答"的证据通道。
     *
     * 桌面壳能看见、页面看不见的事实（是不是发布包、有没有挂调试器）只存在于 **Electron 主进程**；
     * 而需要这些事实的是**桥**。已有控制通道是单向的（事件走 stdout、`shutdown` 走 stdin），
     * 所以这里补一条带 id 的请求/响应：桥在 stdout 写 `evidence-request`，
     * 父进程在 stdin 回 `{id, data}`。
     */
    val evidence = DesktopEvidenceChannel(write = { json -> writeControlLine(json) })

    val server =
        BridgeServer(
            BridgeServerConfig(
                port = args.port,
                psk = psk,
                backend = OkHttpBackend(args.backend, tokens),
                platform = DesktopPlatform(args.version, capabilities),
                tokens = tokens,
                allowedOrigins = args.origins,
                transport = args.transport,
                host = args.host,
                maxPerSecond = args.maxPerSecond,
                notifyPollMs = args.notifyPollMs,
                humanVerifyPort = if (BridgeCapabilities.HUMAN_VERIFY in capabilities) evidence else null,
                deviceKeyFile = deviceKeyFile,
                deviceKeyCodec = deviceKeyCodec,
            ),
        )

    val boundPort = server.start()

    // 新消息等事件：壳（Electron 主进程）据此弹**系统通知**
    server.onEvent { topic, data ->
        writeControlLine(
            JsonObject(
                mapOf(
                    "v" to JsonPrimitive(1),
                    "type" to JsonPrimitive("event"),
                    "topic" to JsonPrimitive(topic),
                    "data" to (data ?: JsonNull),
                ),
            ),
        )
    }

    val handshake =
        JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                // 显式标类型：stdout 上现在有两种行，父进程不该靠"猜字段"来区分
                "type" to JsonPrimitive("handshake"),
                "host" to JsonPrimitive(args.host),
                "port" to JsonPrimitive(boundPort),
                "psk" to JsonPrimitive(psk),
                "pid" to JsonPrimitive(ProcessHandle.current().pid()),
                "ver" to JsonPrimitive(args.version),
                "platform" to JsonPrimitive(BridgeCapabilities.PLATFORM_DESKTOP),
                "capabilities" to JsonPrimitive(args.capabilities.sorted().joinToString(",")),
            ),
        )

    // 父进程读这一行完成握手；必须 flush，否则会被块缓冲吞掉
    writeControlLine(handshake)

    Runtime.getRuntime().addShutdownHook(Thread { server.stop() })

    // stdin 收到 shutdown 即退出；stdin 关闭（父进程死了）也退出。
    // 非 shutdown 的行按 JSON 解析：目前只有"证据答复"（`{"v":1,"id":"ev-1","data":{…}}`）。
    val reader = System.`in`.bufferedReader()
    while (true) {
        val line = reader.readLine() ?: break
        val trimmed = line.trim()
        if (trimmed.equals("shutdown", ignoreCase = true)) {
            break
        }
        if (trimmed.startsWith("{")) {
            runCatching {
                val json = Json.parseToJsonElement(trimmed).jsonObject
                val id = json["id"]?.jsonPrimitive?.contentOrNull
                if (id != null) {
                    evidence.complete(id, json["data"] as? JsonObject)
                }
            }.onFailure {
                // 认不出的行只记一条：控制通道**不能因为一行坏输入就退出**
                BridgeLog.info("忽略无法解析的控制行：${trimmed.take(120)}")
            }
        }
    }

    server.stop()
    exitProcess(0)
}

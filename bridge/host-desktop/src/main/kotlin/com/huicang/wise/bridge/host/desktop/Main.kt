package com.huicang.wise.bridge.host.desktop

import com.huicang.wise.bridge.backend.InMemoryTokenStore
import com.huicang.wise.bridge.backend.OkHttpBackend
import com.huicang.wise.bridge.capability.PlatformPort
import com.huicang.wise.bridge.protocol.BridgeCapabilities
import com.huicang.wise.bridge.server.BridgeServer
import com.huicang.wise.bridge.server.BridgeServerConfig
import com.huicang.wise.bridge.server.DEFAULT_ALLOWED_ORIGINS
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
    )
}

/** 桌面平台适配：W2 只声明"结构上已成立"的能力（见 parseArgs 的注释）。 */
private class DesktopPlatform(
    override val version: String,
    override val capabilities: Set<String>,
) : PlatformPort {
    override val platform: String = BridgeCapabilities.PLATFORM_DESKTOP
}

private fun newToken(): String {
    val bytes = ByteArray(32)
    SecureRandom().nextBytes(bytes)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

fun main(argv: Array<String>) {
    val args = parseArgs(argv)
    val token = newToken()
    val tokens = InMemoryTokenStore()
    args.accessToken?.let { tokens.update(it, null) }

    val server =
        BridgeServer(
            BridgeServerConfig(
                port = args.port,
                token = token,
                backend = OkHttpBackend(args.backend, tokens),
                platform = DesktopPlatform(args.version, args.capabilities),
                tokens = tokens,
                allowedOrigins = args.origins,
                maxPerSecond = args.maxPerSecond,
            ),
        )

    val boundPort = server.start()

    val handshake =
        JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                "port" to JsonPrimitive(boundPort),
                "token" to JsonPrimitive(token),
                "pid" to JsonPrimitive(ProcessHandle.current().pid()),
                "ver" to JsonPrimitive(args.version),
                "platform" to JsonPrimitive(BridgeCapabilities.PLATFORM_DESKTOP),
                "capabilities" to JsonPrimitive(args.capabilities.sorted().joinToString(",")),
            ),
        ).toString()

    // 父进程读这一行完成握手；必须 flush，否则会被块缓冲吞掉
    println(handshake)
    System.out.flush()

    Runtime.getRuntime().addShutdownHook(Thread { server.stop() })

    // stdin 收到 shutdown 即退出；stdin 关闭（父进程死了）也退出
    val reader = System.`in`.bufferedReader()
    while (true) {
        val line = reader.readLine() ?: break
        if (line.trim().equals("shutdown", ignoreCase = true)) {
            break
        }
    }

    server.stop()
    exitProcess(0)
}

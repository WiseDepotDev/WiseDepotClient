package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeProtocol
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * 决定**桥绑哪个地址**、以及页面该连哪个地址。
 *
 * ## 为什么不能硬编码 127.0.0.1
 *
 * 原本桥只绑 `127.0.0.1`，页面也只连 `127.0.0.1`。这在桌面与真机上都对，
 * 但在 **WSA** 上必然失败，而原因藏得很深 —— 看它的路由表：
 *
 * ```
 * 127.0.0.1 via 169.254.73.152 dev loopback0 table 127 proto kernel src 127.0.0.1 onlink
 * ```
 *
 * WSA 为了让 **Windows 宿主能通过 127.0.0.1 访问 Android 里的服务**，
 * 把发往 `127.0.0.1` 的包**从 `loopback0` 送出去**（而不是走正常的 `lo`）。
 * 后果：VM 内部往 127.0.0.1 发起的连接回不到本机监听的端口 ——
 * `bind()` 成功、端口正确、进程存活，**连自己都不通**（实测四组对照见 docs/real-smoke.md）。
 *
 * ## 选谁
 *
 * `loopback0` 是宿主↔VM 的**点对点链路**（`/30`），它自己那一头（如 `169.254.73.153`）：
 *   · VM 内部可达 ✓
 *   · 局域网上的其他机器到不了 ✓（`/30` 点对点地址，等价于 loopback 的私密性）
 *
 * 因此它既解决问题，又**不破坏"只绑 loopback"的安全模型** ——
 * 这一点很重要：绑 `0.0.0.0` 或 `10.0.0.23` 也能让页面连上，但那会把桥暴露给整个网段。
 */
object BridgeHostResolver {
    /**
     * @return 应该绑定的地址；找不到候选时返回 [BridgeProtocol.LOOPBACK_HOST]（桌面即此分支）
     */
    fun resolve(): String =
        candidates().firstOrNull() ?: BridgeProtocol.LOOPBACK_HOST

    /** 列出候选地址，便于在日志里解释"为什么选了它"。 */
    fun candidates(): List<String> =
        runCatching {
            NetworkInterface.getNetworkInterfaces()
                .toList()
                .filter { it.isUp && !it.isVirtual }
                .filter { iface -> isPointToPointLoopbackLike(iface.name) }
                .flatMap { iface -> iface.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .map { it.hostAddress }
        }.getOrDefault(emptyList())

    /**
     * `loopback0` 这类接口的判据：名字以 `loopback` 开头但**不是** `lo`。
     *
     * 不用 `isLoopback()`：WSA 的 `loopback0` 挂的是 `169.254.73.153/30`，
     * 系统并不把它当成 loopback 接口（`isLoopback()` 为 false），但它的语义就是"只在本机/本链路可达"。
     */
    private fun isPointToPointLoopbackLike(name: String): Boolean =
        name != "lo" && name.startsWith("loopback")
}

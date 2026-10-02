package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeProtocol

/**
 * 握手校验策略：**两条传输共用同一份判定**。
 *
 * ## 为什么必须抽出来
 *
 * 桥有两条传输：桌面用 Netty、手机用自写的 RFC6455（[PlainWebSocketServer]）。
 * 两边的握手校验以前是**各写一遍**，靠注释与人工对照来保证一致 ——
 * 这种"一致"每次改一处就可能悄悄分叉，而分叉的后果是安全口径不同（例如只在一条路上
 * 少判一次 Origin）。抽成一个策略之后，"一致"变成结构保证：两边都只能调这里。
 *
 * ## 判定的顺序是有意的（先粗后细，且**不泄露信息**）
 *
 * 1. HTTP 方法/路径不对 → 404/405（这些本来就公开）；
 * 2. token 不对 → 401。**用常量时间比较**：这里虽然不是远程攻击面（监听在 loopback），
 *    但"一次性握手 token"是桥的唯一主闸，按长度与字节提前返回没有理由留下；
 * 3. Origin 带了就必须在白名单里 → 403。**不带 Origin 放行**：原生客户端与 bench 脚本
 *    本来就不带，而它们已经持有 token（token 是主闸，Origin 是纵深）。
 */
object HandshakePolicy {
    /** 校验结论。`reject` 为 null 表示通过。 */
    data class Decision(
        /** HTTP 状态码与原因短语，仅用于拒绝时回包。 */
        val reject: Pair<Int, String>? = null,
    ) {
        val allowed: Boolean get() = reject == null
    }

    /**
     * 校验一次 WebSocket 升级请求。
     *
     * @param method HTTP 方法（应为 GET）
     * @param path 去掉查询串后的路径（应为 [BridgeProtocol.HANDSHAKE_PATH]）
     * @param providedToken 查询串里的 token（没有则 null）
     * @param expectedToken 本次启动生成的一次性 token
     * @param origin Origin 头（没有则 null）
     * @param allowedOrigins 允许的 Origin 集合
     * @param hasWebSocketKey 是否带 `Sec-WebSocket-Key`（自写传输要自己判；Netty 由协议处理器判）
     */
    fun decide(
        method: String,
        path: String,
        providedToken: String?,
        expectedToken: String,
        origin: String?,
        allowedOrigins: Set<String>,
        hasWebSocketKey: Boolean = true,
    ): Decision {
        if (method != "GET") {
            return Decision(405 to "Method Not Allowed")
        }
        if (path != BridgeProtocol.HANDSHAKE_PATH) {
            return Decision(404 to "Not Found")
        }
        if (!constantTimeEquals(providedToken, expectedToken)) {
            return Decision(401 to "Unauthorized")
        }
        if (origin != null && origin !in allowedOrigins) {
            return Decision(403 to "Forbidden")
        }
        if (!hasWebSocketKey) {
            return Decision(400 to "Bad Request")
        }
        return Decision()
    }

    /**
     * 常量时间比较。
     *
     * 逐字节 XOR 后累积，最后一次性判 0 —— **不因为长度或首个不同字节提前返回**。
     * 长度不同直接返回 false 是可接受的（token 长度是固定且公开的 43 字符）。
     */
    fun constantTimeEquals(
        a: String?,
        b: String,
    ): Boolean {
        if (a == null || a.length != b.length) {
            return false
        }
        var diff = 0
        for (i in a.indices) {
            diff = diff or (a[i].code xor b[i].code)
        }
        return diff == 0
    }
}

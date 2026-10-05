package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeProtocol
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import io.netty.util.AttributeKey

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
 * ## v5：HTTP 层**不再有凭据可比**
 *
 * v4 时这里要拿查询串里的 `token` 与本次启动的 token 做**常量时间比较**。v5 之后
 * token 不再上线（改叫 `psk`、只存在于引导文件里，见 [BridgeBootstrap]），
 * 于是这一层只剩下"形状与来源"三项，**身份由加密层证明**：
 * 能产出第一条合法 AEAD 帧的，就是持有 psk 的那一方（psk 参与了 KDF）。
 *
 * 这不是"放松"：v4 的 token 挂在 URL 上，会被日志/抓包/历史记录带走；v5 它一次都不上线。
 * 代价是**升级本身不再被拒**，于是未认证连接的占用要靠 [PreAuthGate] 与截止时间兜住
 * （见 `docs/superpowers/plans/2026-10-06-bridge-ws-encryption-v5.md` 的残余风险登记）。
 *
 * ## 判定的顺序（先粗后细）
 *
 * 1. HTTP 方法/路径不对 → 404/405（这些本来就公开）；
 * 2. Origin 带了就必须在白名单里 → 403。**不带 Origin 放行**：原生客户端与 bench 脚本
 *    本来就不带（它们也不是浏览器），这一条只挡"浏览器里别的页面"。
 * 3. 没有 `Sec-WebSocket-Key` → 400（不是一次合法的 WebSocket 升级）。
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
     * @param origin Origin 头（没有则 null）
     * @param allowedOrigins 允许的 Origin 集合
     * @param hasWebSocketKey 是否带 `Sec-WebSocket-Key`（自写传输要自己判；Netty 由协议处理器判）
     */
    fun decide(
        method: String,
        path: String,
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
        if (origin != null && origin !in allowedOrigins) {
            return Decision(403 to "Forbidden")
        }
        if (!hasWebSocketKey) {
            return Decision(400 to "Bad Request")
        }
        return Decision()
    }
}

/**
 * **预认证池**（v5）：还没交出第一条合法密文帧的连接最多几条。
 *
 * ## 为什么需要它
 *
 * v4 里"占一个连接位"要先有 token；v5 把认证挪到了加密层之后，任何本机进程都能
 * 完成 WebSocket 升级 —— 于是"连上就不说话"变成了一个免费的占位手段。
 * 这里给它一个明确的上限（默认 4，独立于正常连接上限 8），配合**预认证截止时间**
 * （[PreAuthGate] 的调用方负责计时）：占位是可能的，但只能占很小一块、而且很快被清掉。
 *
 * 这是**已知代价**，不是漏掉的防线：本地进程本来就能做更糟的事；这一层的目的是
 * 让"随手写个循环占满连接"不成立。
 */
class PreAuthGate(
    private val maxPending: Int = DEFAULT_MAX_PENDING,
) {
    private val pending = AtomicInteger(0)

    /** 当前未认证连接数（诊断用）。 */
    val pendingCount: Int get() = pending.get()

    /** 占一个未认证位；满了返回 false（调用方应明确拒绝，而不是排队等着）。 */
    fun tryEnter(): Boolean {
        while (true) {
            val current = pending.get()
            if (current >= maxPending) {
                return false
            }
            if (pending.compareAndSet(current, current + 1)) {
                return true
            }
        }
    }

    /** 还一个位（认证成功、连接关闭、或握手后续失败时都要还）。 */
    fun leave() {
        pending.updateAndGet { if (it > 0) it - 1 else 0 }
    }

    companion object {
        const val DEFAULT_MAX_PENDING: Int = 4
    }
}

/**
 * 一条连接的**认证状态**（v5）。
 *
 * "认证"只发生一次：第一条**成功解封**的帧到达时。到达之前连接不在广播组里、
 * 也不占正常连接配额；到达之后它就是一个普通连接。
 */
internal class AuthState(
    val gate: PreAuthGate,
) {
    private val authenticated = AtomicBoolean(false)

    val isAuthenticated: Boolean get() = authenticated.get()

    /** @return true 表示**本次调用**完成了认证（调用方据此还掉预认证位、加入广播组）。 */
    fun markAuthenticated(): Boolean = authenticated.compareAndSet(false, true)
}

/** Netty 侧把认证状态挂在 channel 上。 */
internal val AUTH_STATE: AttributeKey<AuthState> = AttributeKey.valueOf("wise.bridge.auth")

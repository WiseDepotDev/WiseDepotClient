package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeProtocol
import java.net.InetSocketAddress
import java.net.Socket

/**
 * 绑完端口后立刻从**本进程**回连自己。
 *
 * 为什么值得专门写一个：（W3 在 WSA 上实测）"Web 连不上桥"先后被误判成
 * 混合内容拦截、CSP、Netty 在 Android 上的缺陷——都不是。这条自检把故障一分为二：
 *
 * - **自检失败** → `bind()` 根本没在监听（环境/权限/地址问题）。既然本进程都连不上，
 *   那和"哪个传输实现"毫无关系，换实现是白费功夫；
 * - **自检成功但外部连不上** → 跨进程可见性问题（网络命名空间 / 防火墙）。
 *
 * 返回人类可读的结果，**包含异常类型与消息**——只打一个"失败"是不够的，
 * 下一次还得再猜一轮。
 */
object LoopbackSelfTest {
    fun run(
        port: Int,
        host: String = BridgeProtocol.LOOPBACK_HOST,
        timeoutMs: Int = 1000,
    ): String =
        runCatching {
            Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs) }
            "成功"
        }.getOrElse { e ->
            "失败（${e::class.simpleName}: ${e.message}）"
        }
}

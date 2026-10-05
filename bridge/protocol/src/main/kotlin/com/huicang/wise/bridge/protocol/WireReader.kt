package com.huicang.wise.bridge.protocol

/**
 * 消息层分片装配：**两条传输共用的唯一实现**。
 *
 * ## 为什么要有它
 *
 * v3 里"把 WebSocket 分片攒成一条完整消息"这件事被实现了**两遍**
 * （Netty 侧的 `fragments` map 与自写传输里的 `FragmentAccumulator`），
 * 于是"两条传输行为必须逐条一致"只能靠人工对照 —— 这条纪律已经真实漏过一次
 * （二进制帧在 Netty 侧回结构化错误、在自写传输里被静默丢弃）。
 * v4 把装配收到这里：传输层只负责"读出/写出一个 WebSocket 消息"，装配与限额只有一份。
 *
 * ## 限额怎么定：**先看 kind，再决定愿意缓冲多少**
 *
 * 结构上限是分 kind 的（控制帧 1MB、`bin` 8MiB）。帧头前 4 个字节里就有 kind，
 * 所以收到 ≥4 字节后就能选对上限；在此之前按**控制面**的较小上限保守处理
 * （宁可对一个还没表明身份的巨型消息早拒，也不要先替它分配 8MB）。
 *
 * 超限时**保留帧头片段**（最多 12 + 255 字节），这样调用方还能回一条**带 id 的错误**，
 * 而不是一句"帧太大了"。
 */
class WireReader {
    private var buffer = ByteArray(INITIAL_CAPACITY)
    private var size = 0
    private var head = ByteArray(0)
    private var kindSeen = -1

    /** 本消息已累积的字节数（诊断用）。 */
    val bytes: Int
        get() = size

    /**
     * 追加一个 WebSocket 分片。
     *
     * @param fragment 分片内容（已脱掩码）
     * @param last 是否是本条消息的最后一片（RFC6455 的 FIN）
     */
    fun accept(
        fragment: ByteArray,
        last: Boolean,
    ): WireRead {
        if (head.size < HEAD_LIMIT) {
            val take = minOf(HEAD_LIMIT - head.size, fragment.size)
            val merged = ByteArray(head.size + take)
            head.copyInto(merged)
            fragment.copyInto(merged, head.size, 0, take)
            head = merged
        }
        if (kindSeen < 0 && head.size >= 4) {
            kindSeen = head[3].toInt() and 0xFF
        }

        val limit = if (kindSeen < 0) FALLBACK_LIMIT else limitFor(kindSeen)
        if (size + fragment.size > limit) {
            // 不再累积正文，但保留头部片段用于回一条带 id 的错误
            size += fragment.size
            return if (last) {
                WireRead.OverLimit(BridgeWire.headerId(head))
            } else {
                WireRead.OverLimit(id = BridgeWire.headerId(head), needsMore = true)
            }
        }

        if (size + fragment.size > buffer.size) {
            var next = buffer.size
            while (next < size + fragment.size) {
                next *= 2
            }
            buffer = buffer.copyOf(next)
        }
        fragment.copyInto(buffer, size)
        size += fragment.size

        if (!last) {
            return WireRead.NeedMore
        }
        val message = buffer.copyOf(size)
        reset()
        return WireRead.Complete(message)
    }

    /** 一条消息收尾（成功或放弃）后必须调用，否则下一条消息会接着上一条累积。 */
    fun reset() {
        size = 0
        head = ByteArray(0)
        kindSeen = -1
    }

    /** 超限错误回包要用的 id（尽力而为；抠不到为空串）。 */
    fun idForError(): String = BridgeWire.headerId(head)

    /**
     * 这条消息的结构上限。
     *
     * v5：装配的是**外层**消息（12 字节头明文 + 密文正文），所以要用
     * [BridgeWire.sealedHardLimitFor]（= 内层上限 + 外层头 + 最大 id + nonce + tag）。
     * 少算这 295 字节的表现是"大图偶尔发不出去"——很难查，所以算术只在 `BridgeWire` 里写一次。
     */
    private fun limitFor(kind: Int): Int = BridgeWire.sealedHardLimitFor(kind)

    private companion object {
        const val INITIAL_CAPACITY = 4096

        /** 头部片段保留上限：12 字节定长头 + 最大 id。 */
        const val HEAD_LIMIT = BridgeWire.HEADER_BYTES + BridgeWire.MAX_ID_BYTES

        /** kind 未知时的保守上限（控制面）。 */
        val FALLBACK_LIMIT = BridgeWire.sealedHardLimitFor(WireKind.REQ)
    }
}

/** 装配结论。 */
sealed interface WireRead {
    /** 还需要更多分片。 */
    object NeedMore : WireRead

    /** 一条完整消息。 */
    data class Complete(val message: ByteArray) : WireRead

    /**
     * 超过结构上限。
     *
     * `needsMore = false` 表示已经是最后一片（可以立刻回错误）；
     * 为 true 时调用方通常直接断开连接（对方要么坏了要么是恶意的，继续读没意义）。
     */
    data class OverLimit(
        val id: String,
        val needsMore: Boolean = false,
    ) : WireRead
}

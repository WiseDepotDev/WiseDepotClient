package com.huicang.wise.bridge.server

import com.huicang.wise.bridge.protocol.BridgeCrypto
import com.huicang.wise.bridge.protocol.BridgeCryptoException
import com.huicang.wise.bridge.protocol.BridgeFrame
import com.huicang.wise.bridge.protocol.BridgeWire
import com.huicang.wise.bridge.protocol.HelloFrame
import io.netty.util.AttributeKey

/**
 * 一条连接的**加密封装**（服务端侧，两条传输共用）。
 *
 * ## 为什么必须抽出来
 *
 * Netty 与自写传输要做的加密动作是完全一样的：拿客户端临时公钥 → 换一套会话密钥 →
 * 发 hello → 之后每帧 seal/open。如果两边各写一遍，"两条传输行为逐条一致"就又回到
 * 靠人工对照 —— 而那件事在这个仓库里已经真实漂移过一次（见 [WireReader] 的注释）。
 * 抽到这里之后，两条传输只能调这几个方法，差异只剩"怎么读写 WebSocket 消息"。
 *
 * ## 顺序是有意的
 *
 * `hello` **必须**是服务端发出的第一条帧，且必须是明文（客户端还没有密钥）。
 * 它之后的一切都走 [seal]／[open]；收到明文帧（ENC=0）说明两端不是一版，
 * 由传输层回 `BRIDGE_WIRE_MODE` 而不是"猜一猜按明文解"。
 */
class SealedChannel private constructor(
    private val session: BridgeCrypto.Session,
    /** 握手 hello 的**已编码字节**（明文，只承载服务端临时公钥）。 */
    val helloFrame: ByteArray,
) {
    /**
     * **封装与写出必须在同一个临界区里**（这是本类最重要的一条不变量）。
     *
     * 为什么：接收端按**单调递增**判重放（`seq > lastSeq`），所以线序必须与序号序一致。
     * 而 `seal()` 与 `write()` 是两件事，中间任何一次线程切换都会让两条并发回复**反过来上线**
     * （实测：客户端收到 27 再收到 26 ⇒ 判成"序号回退" ⇒ 连接被丢弃 ⇒ 界面反复"重连中"）。
     *
     * 传输层的回复来自**协程池里的任意线程**（广播还可能来自别的线程），所以这把锁不是
     * "保险起见"，而是正确性的一部分 —— 加锁范围覆盖"取号 + 写出"，于是谁先拿到锁谁先取号，
     * 线序与序号序永远一致。
     */
    private val sendLock = Any()

    /** 逻辑帧 → 外层密文消息（**只封装、不写出**；要上线请用 [sealAndSend]）。 */
    fun seal(frame: BridgeFrame): ByteArray = BridgeWire.sealMessage(BridgeWire.encode(frame), session)

    /** 封装并**立刻**交给 writer 写出去：取号与写出在同一个临界区（见 [sendLock] 的说明）。 */
    fun <T> sealAndSend(
        frame: BridgeFrame,
        write: (ByteArray) -> T,
    ): T = synchronized(sendLock) { write(seal(frame)) }

    /**
     * 外层密文消息 → 内层明文消息。
     *
     * 失败原因（tag 不符 / 序号回退 / 内外不一致 / 结构不合法）统一抛
     * [BridgeCryptoException]：调用方一律**断开这条连接**并留一条日志 ——
     * "这条连接不可信"没有别的出路（重连即可，重连仍失败才说明两端不是同一份密钥）。
     */
    fun open(message: ByteArray): ByteArray = BridgeWire.openMessage(message, session)

    /** 已发出/已收到的最大序号（诊断用，不含密钥材料）。 */
    fun sentSeq(): Long = session.sentSeq

    fun receivedSeq(): Long = session.receivedSeq

    companion object {
        /**
         * 握手：客户端临时公钥 + 本机 psk → 会话密钥 + 要发回去的 hello。
         *
         * 公钥**先判合法性**再进 ECDH：`?k=` 是未经认证的输入，一个不在曲线上的点
         * 要么让某些 provider 抛奇怪的异常、要么落进实现相关的分支。
         */
        fun handshake(
            clientPublicKey: ByteArray,
            psk: ByteArray,
        ): SealedChannel {
            if (!BridgeCrypto.isOnCurve(clientPublicKey)) {
                throw BridgeCryptoException("客户端公钥不是合法的 P-256 未压缩点")
            }
            val ephemeral = BridgeCrypto.generateEphemeral()
            val shared = BridgeCrypto.sharedSecret(ephemeral, clientPublicKey)
            val keys = BridgeCrypto.sessionKeys(psk, clientPublicKey, ephemeral.publicKey, shared)
            val session = BridgeCrypto.Session(keys, BridgeCrypto.Role.SERVER)
            val hello = BridgeWire.encode(HelloFrame(BridgeCrypto.hex(ephemeral.publicKey)))
            return SealedChannel(session, hello)
        }

        /**
         * 把引导里的 psk 取成字节。
         *
         * 用 **ASCII 字节**而不是 base64 解码：Android API 25 没有 `java.util.Base64`，
         * 而 HMAC 的密钥本来就允许任意长度（psk 的熵仍是 256 bit）。
         */
        fun pskBytes(psk: String): ByteArray = psk.toByteArray(Charsets.UTF_8)
    }
}

/**
 * Netty 侧把会话挂在 channel 上（广播要按连接各自封装，所以必须能按 channel 取回来）。
 *
 * 自写传输不需要 AttributeKey：它每个连接一个对象，直接持有字段。
 */
internal val SEALED_CHANNEL: AttributeKey<SealedChannel> = AttributeKey.valueOf("wise.bridge.sealed")

package com.huicang.wise.bridge.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement

/**
 * v4 二进制帧头（协议 v4 的**唯一线格式**）。
 *
 * ```
 * 偏移  长度  字段     说明
 *  0     2   magic    'W','B'（0x57 0x42）—— 认不出直接拒，不做猜测
 *  2     1   ver      协议版本（BridgeProtocol.VERSION）
 *  3     1   kind     1=req 2=res 3=err 4=evt 0x10=bin
 *  4     1   flags    bit0 FINAL；其余位保留，**见到未知位必须报错**（不许当没看见）
 *  5     1   hdrExt   扩展头字节数（本版本恒 0；非 0 必须报错，不许跳过）
 *  6     2   idLen    关联 id 的字节数（0..255），小端
 *  8     4   bodyLen  正文字节数，小端
 * 12   idLen  id      UTF-8；与 req 的 id 同域 ⇒ 同一个 id 就能把响应和请求对上
 *     hdrExt 扩展头   （预留）
 *     bodyLen 正文    控制帧是 UTF-8 JSON；`bin` 是不透明字节
 * ```
 *
 * ## 为什么固定 12 字节头，而不是 varint / TLV
 *
 * 省下的 6~8 字节在 loopback 上没有意义，换来的是"任何语言一眼能解析、单测能逐字节断言"。
 * 同理**不做 varint**：解析器的复杂度是真成本，字节数不是。
 *
 * ## 为什么 id 只放在帧头
 *
 * 数据面必须能只靠头部把一条二进制消息和它的请求对上。若正文里再放一份 id，
 * 就一定会出现"头里的 id 与正文里的 id 不一致"这种没人能一眼看出的 bug。
 * 同理 v4 删掉了 v3 正文里的 `ok`：成功与否由 `kind` 唯一表达。
 */
object BridgeWire {
    /** 定长头长度。 */
    const val HEADER_BYTES: Int = 12

    const val MAGIC_W: Int = 0x57
    const val MAGIC_B: Int = 0x42

    /** bit0：本条消息的最后一片。 */
    const val FLAG_FINAL: Int = 0x01

    /**
     * bit1：正文是密文（v5）。
     *
     * **只有 `hello` 帧可以是 0**；其余任何帧收到 ENC=0 都是"两端不是一版"，由传输层回
     * [BridgeErrorCodes.WIRE_MODE] 后断开（不是静默按明文解析）。
     */
    const val FLAG_ENC: Int = 0x02

    /** 本版本认识的 flags 位。见到其它位必须报错，不许当没看见。 */
    private const val KNOWN_FLAGS: Int = FLAG_FINAL or FLAG_ENC

    /** id 上限（帧头里是 2 字节字段，但协议只承诺短 id）。 */
    const val MAX_ID_BYTES: Int = 255

    /**
     * 结构上限：超过它的**在解码阶段**就拒（回 `WireFault.TOO_LARGE`），不解析正文。
     *
     * 注意这不是"策略上限"：控制帧 256KB 的策略上限在 [BridgeCallHandler] 的 preflight 里判，
     * 那里才能回一条**带 id 的** `BRIDGE_FRAME_TOO_LARGE`（界面上才能说清"这条请求太大了"）。
     * 这里管的是"根本不值得为它分配内存"。
     */
    const val HARD_CONTROL_BYTES: Int = BridgeProtocol.MAX_FRAME_BYTES * 4

    /** `bin` 的结构上限就是它的策略上限（8MiB）—— 数据面没有"再宽一点好把错误说清"的余地。 */
    const val HARD_BIN_BYTES: Int = BridgeProtocol.MAX_BIN_BYTES

    /**
     * 封装给一条内层消息加上的**最坏**开销：外层头 12 + 最大 id 255 + nonce 12 + tag 16（=295）。
     *
     * 算术只写这一处：`WireReader` 与自写传输的硬上限都必须走 [sealedHardLimitFor]，
     * 各自手抄一遍的表现是"大图偶尔发不出去"，很难查。
     */
    const val SEALED_OVERHEAD_BYTES: Int = HEADER_BYTES + MAX_ID_BYTES + BridgeCrypto.SEAL_BODY_OVERHEAD_BYTES

    /** 编码：逻辑帧 → 线上字节（**明文**；加密帧由 [sealMessage] 产出）。 */
    fun encode(frame: BridgeFrame): ByteArray =
        when (frame) {
            is ReqFrame ->
                control(WireKind.REQ, frame.id, ReqBody(frame.method, frame.params, frame.meta))
            is ResFrame -> control(WireKind.RES, frame.id, ResBody(frame.data, frame.meta))
            is ErrFrame -> control(WireKind.ERR, frame.id, ErrBody(frame.error))
            is EvtFrame -> control(WireKind.EVT, "", EvtBody(frame.topic, frame.data))
            is HelloFrame -> control(WireKind.HELLO, "", HelloBody(frame.publicKeyHex))
            is BinFrame ->
                assemble(
                    kind = WireKind.BIN,
                    id = frame.id.toByteArray(Charsets.UTF_8),
                    flags = if (frame.final) FLAG_FINAL else 0,
                    body = frame.body,
                )
        }

    /**
     * 解码：线上字节 → 逻辑帧。
     *
     * 只做**结构**判定（magic/ver/kind/flags/hdrExt/长度自洽/正文能解析）。
     * "这是不是一个合法请求"（id 非空、method 非空、kind 必须是 req）由调用方判 ——
     * 那是协议语义，不是线格式。
     */
    fun decode(bytes: ByteArray): WireDecode {
        if (bytes.size < HEADER_BYTES) {
            return WireDecode.Rejected(WireFault.TRUNCATED, "")
        }
        if (bytes[0].toInt() and 0xFF != MAGIC_W || bytes[1].toInt() and 0xFF != MAGIC_B) {
            return WireDecode.Rejected(WireFault.BAD_MAGIC, "")
        }
        val id = headerId(bytes)
        if (bytes[2].toInt() and 0xFF != BridgeProtocol.VERSION) {
            return WireDecode.Rejected(WireFault.BAD_VERSION, id)
        }
        val kind = bytes[3].toInt() and 0xFF
        if (!WireKind.isKnown(kind)) {
            return WireDecode.Rejected(WireFault.BAD_KIND, id)
        }
        val flags = bytes[4].toInt() and 0xFF
        if (flags and KNOWN_FLAGS.inv() and 0xFF != 0) {
            return WireDecode.Rejected(WireFault.BAD_FLAGS, id)
        }
        // 这一层解的是**明文/内层**帧：ENC 位一律不允许（密文由 openMessage 先打开）
        if (flags and FLAG_ENC != 0) {
            return WireDecode.Rejected(WireFault.BAD_FLAGS, id)
        }
        if (bytes[5].toInt() and 0xFF != 0) {
            return WireDecode.Rejected(WireFault.BAD_EXT, id)
        }
        val idLen = readU16(bytes, 6)
        val bodyLen = readU32(bytes, 8)
        if (idLen > MAX_ID_BYTES || bodyLen < 0) {
            return WireDecode.Rejected(WireFault.BAD_LENGTH, id)
        }
        if (bodyLen.toLong() > hardLimitFor(kind).toLong()) {
            return WireDecode.Rejected(WireFault.TOO_LARGE, id)
        }
        if (bytes.size != HEADER_BYTES + idLen + bodyLen) {
            return WireDecode.Rejected(WireFault.BAD_LENGTH, id)
        }

        val bodyStart = HEADER_BYTES + idLen
        val body = bytes.copyOfRange(bodyStart, bytes.size)
        val final = flags and FLAG_FINAL != 0

        if (kind == WireKind.BIN) {
            return WireDecode.Ok(BinFrame(id, body, final), bodyLen)
        }
        val text = String(body, Charsets.UTF_8)
        val json = BridgeCodec.json
        val frame: BridgeFrame =
            when (kind) {
                WireKind.REQ -> {
                    val parsed =
                        runCatching { json.decodeFromString(ReqBody.serializer(), text) }.getOrNull()
                            ?: return WireDecode.Rejected(WireFault.BAD_BODY, id)
                    ReqFrame(id, parsed.method, parsed.params, parsed.meta)
                }
                WireKind.RES -> {
                    val parsed =
                        runCatching { json.decodeFromString(ResBody.serializer(), text) }.getOrNull()
                            ?: return WireDecode.Rejected(WireFault.BAD_BODY, id)
                    ResFrame(id, parsed.data, parsed.meta)
                }
                WireKind.ERR -> {
                    val parsed =
                        runCatching { json.decodeFromString(ErrBody.serializer(), text) }.getOrNull()
                            ?: return WireDecode.Rejected(WireFault.BAD_BODY, id)
                    ErrFrame(id, parsed.error)
                }
                WireKind.ERR -> {
                    val parsed =
                        runCatching { json.decodeFromString(ErrBody.serializer(), text) }.getOrNull()
                            ?: return WireDecode.Rejected(WireFault.BAD_BODY, id)
                    ErrFrame(id, parsed.error)
                }
                WireKind.HELLO -> {
                    // hello 的 idLen 必须是 0（它没有请求可关联）——非 0 说明发帧方写错了
                    if (id.isNotEmpty()) {
                        return WireDecode.Rejected(WireFault.BAD_BODY, id)
                    }
                    val parsed =
                        runCatching { json.decodeFromString(HelloBody.serializer(), text) }.getOrNull()
                            ?: return WireDecode.Rejected(WireFault.BAD_BODY, id)
                    HelloFrame(parsed.k)
                }
                else -> {
                    val parsed =
                        runCatching { json.decodeFromString(EvtBody.serializer(), text) }.getOrNull()
                            ?: return WireDecode.Rejected(WireFault.BAD_BODY, id)
                    EvtFrame(parsed.topic, parsed.data)
                }
            }
        return WireDecode.Ok(frame, bodyLen)
    }

    /** 这条 kind 的结构上限（入站方向用它决定愿意缓冲多少）。 */
    fun hardLimitFor(kind: Int): Int =
        if (kind == WireKind.BIN) HARD_BIN_BYTES else HARD_CONTROL_BYTES

    /**
     * 这条 kind 的**外层（含封装）**结构上限：`hardLimitFor(kind) + 295`。
     *
     * 两个上限的用途不同，不能合成一个：
     *  · [hardLimitFor] 用在内层（`decode` 判正文长度、`sealMessage` 判被封装的东西有多大）；
     *  · 这个用在**外层整条消息**上（`WireReader` 按 kind 决定愿意缓冲多少、
     *    自写传输的单帧上限），因为外层还要多出外层头 + 最大 id + nonce + tag。
     */
    fun sealedHardLimitFor(kind: Int): Int = hardLimitFor(kind) + SEALED_OVERHEAD_BYTES

    // ---------------------------------------------------------------- v5 加密封装

    /**
     * 把一条**完整的内层消息**封装成外层密文消息。
     *
     * 外层头是明文（`kind` 要让接收端在解密前就能选限额；`id` 要让解密失败时还能回一条带 id
     * 的错误），AAD 就是"外层 12 字节头 ‖ id" —— 于是帧头被篡改一定表现为 tag 失败。
     *
     * 长度关系：`外层 bodyLen = 内层整帧长度 + 28（nonce+tag）`。
     * 内层是**逐字节的 v4 消息**，所以 `decode` 与 167 条方法一行都不用改。
     */
    fun sealMessage(
        inner: ByteArray,
        session: BridgeCrypto.Session,
    ): ByteArray {
        if (inner.size < HEADER_BYTES) {
            throw BridgeCryptoException("内层消息太短：${inner.size}")
        }
        val kind = inner[3].toInt() and 0xFF
        if (!WireKind.isKnown(kind)) {
            throw BridgeCryptoException("内层 kind 未知：$kind")
        }
        if (kind == WireKind.HELLO) {
            // hello 必须是明文（它是"还没建立密钥"时唯一能读的帧），不允许被封装
            throw BridgeCryptoException("hello 帧不允许被加密")
        }
        val innerFlags = inner[4].toInt() and 0xFF
        if (innerFlags and FLAG_ENC != 0) {
            throw BridgeCryptoException("内层消息本身不能是密文（会叠两层封装）")
        }
        val idLen = readU16(inner, 6)
        if (inner.size != HEADER_BYTES + idLen + readU32(inner, 8)) {
            throw BridgeCryptoException("内层消息长度不自洽")
        }

        val bodyLen = inner.size + BridgeCrypto.SEAL_BODY_OVERHEAD_BYTES
        val outer = ByteArray(HEADER_BYTES + idLen + bodyLen)
        outer[0] = MAGIC_W.toByte()
        outer[1] = MAGIC_B.toByte()
        outer[2] = BridgeProtocol.VERSION.toByte()
        outer[3] = kind.toByte()
        outer[4] = (FLAG_FINAL or FLAG_ENC).toByte()
        outer[5] = 0
        writeU16(outer, 6, idLen)
        writeU32(outer, 8, bodyLen)
        inner.copyInto(outer, HEADER_BYTES, HEADER_BYTES, HEADER_BYTES + idLen)

        val aad = outer.copyOfRange(0, HEADER_BYTES + idLen)
        session.seal(inner, aad).copyInto(outer, HEADER_BYTES + idLen)
        return outer
    }

    /**
     * 打开一条外层密文消息，返回**内层完整消息**。
     *
     * 做的判定：外层结构（magic/版本/flags/hdrExt/长度自洽）、tag 与序号（走 [BridgeCrypto.Session]）、
     * 以及内外一致性（kind、id 必须相同）—— 最后一条是"外层头是明文"的代价，必须自己补上。
     * 任何一项不对都抛 [BridgeCryptoException]，调用方据此断开（不是"猜一猜继续"）。
     */
    fun openMessage(
        outer: ByteArray,
        session: BridgeCrypto.Session,
    ): ByteArray {
        if (outer.size < HEADER_BYTES) {
            throw BridgeCryptoException("外层消息太短：${outer.size}")
        }
        if (outer[0].toInt() and 0xFF != MAGIC_W || outer[1].toInt() and 0xFF != MAGIC_B) {
            throw BridgeCryptoException("外层 magic 不对")
        }
        if (outer[2].toInt() and 0xFF != BridgeProtocol.VERSION) {
            throw BridgeCryptoException("外层版本不是 ${BridgeProtocol.VERSION}")
        }
        val kind = outer[3].toInt() and 0xFF
        if (!WireKind.isKnown(kind) || kind == WireKind.HELLO) {
            throw BridgeCryptoException("外层 kind 非法：$kind")
        }
        val flags = outer[4].toInt() and 0xFF
        if (flags and KNOWN_FLAGS.inv() and 0xFF != 0) {
            throw BridgeCryptoException("外层 flags 有未知位：$flags")
        }
        if (flags and FLAG_ENC == 0) {
            throw BridgeCryptoException("外层不是密文帧（ENC=0）")
        }
        if (outer[5].toInt() and 0xFF != 0) {
            throw BridgeCryptoException("外层 hdrExt 必须为 0")
        }
        val idLen = readU16(outer, 6)
        val bodyLen = readU32(outer, 8)
        if (idLen > MAX_ID_BYTES || bodyLen < 0 || outer.size != HEADER_BYTES + idLen + bodyLen) {
            throw BridgeCryptoException("外层长度不自洽")
        }

        val aad = outer.copyOfRange(0, HEADER_BYTES + idLen)
        val inner = session.open(outer.copyOfRange(HEADER_BYTES + idLen, outer.size), aad)

        // 内外一致性：外层头是明文（为了限额与错误关联），所以它必须与内层说的完全一致
        if (inner.size < HEADER_BYTES) {
            throw BridgeCryptoException("内层消息太短（外层头与内层不一致）")
        }
        if (inner[3].toInt() and 0xFF != kind) {
            throw BridgeCryptoException("内外 kind 不一致")
        }
        val innerIdLen = readU16(inner, 6)
        if (innerIdLen != idLen) {
            throw BridgeCryptoException("内外 idLen 不一致")
        }
        for (i in 0 until idLen) {
            if (inner[HEADER_BYTES + i] != outer[HEADER_BYTES + i]) {
                throw BridgeCryptoException("内外 id 不一致")
            }
        }
        return inner
    }

    /**
     * 这条消息是不是密文帧（v5 里除 hello 之外都必须成立）。
     *
     * 给传输层用：先便宜地判一下，再把"收到明文的非 hello 帧"回成
     * [BridgeErrorCodes.WIRE_MODE]（两端不是一版），而不是扔进解密里变成 tag 失败。
     */
    fun isEncrypted(bytes: ByteArray): Boolean =
        bytes.size >= HEADER_BYTES &&
            bytes[0].toInt() and 0xFF == MAGIC_W &&
            bytes[1].toInt() and 0xFF == MAGIC_B &&
            bytes[4].toInt() and FLAG_ENC != 0

    /** hello 帧是不是"合法的明文 hello"（kind/ENC/idLen 三项）。 */
    fun isHelloFrame(bytes: ByteArray): Boolean =
        bytes.size >= HEADER_BYTES &&
            bytes[0].toInt() and 0xFF == MAGIC_W &&
            bytes[1].toInt() and 0xFF == MAGIC_B &&
            bytes[3].toInt() and 0xFF == WireKind.HELLO &&
            bytes[4].toInt() and FLAG_ENC == 0 &&
            readU16(bytes, 6) == 0

    /**
     * 尽力从帧头抠 id —— **帧坏了也要能回一条带 id 的错误**。
     *
     * 与 v3 的手写 JSON 扫描相比这里简单得多：id 就在定长头后面，长度自洽就能取。
     * 取不到（头不完整、magic 不对、idLen 离谱）返回空串，调用方照旧回一条 id 为空的错误。
     */
    fun headerId(bytes: ByteArray): String {
        if (bytes.size < HEADER_BYTES) {
            return ""
        }
        if (bytes[0].toInt() and 0xFF != MAGIC_W || bytes[1].toInt() and 0xFF != MAGIC_B) {
            return ""
        }
        val idLen = readU16(bytes, 6)
        if (idLen <= 0 || idLen > MAX_ID_BYTES || bytes.size < HEADER_BYTES + idLen) {
            return ""
        }
        return String(bytes, HEADER_BYTES, idLen, Charsets.UTF_8)
    }

    private inline fun <reified T> control(kind: Int, id: String, body: T): ByteArray =
        assemble(kind, id.toByteArray(Charsets.UTF_8), FLAG_FINAL, encodeBody(body))

    private inline fun <reified T> encodeBody(body: T): ByteArray =
        BridgeCodec.json.encodeToString(body).toByteArray(Charsets.UTF_8)

    private fun assemble(kind: Int, id: ByteArray, flags: Int, body: ByteArray): ByteArray {
        val out = ByteArray(HEADER_BYTES + id.size + body.size)
        out[0] = MAGIC_W.toByte()
        out[1] = MAGIC_B.toByte()
        out[2] = BridgeProtocol.VERSION.toByte()
        out[3] = kind.toByte()
        out[4] = flags.toByte()
        out[5] = 0
        writeU16(out, 6, id.size)
        writeU32(out, 8, body.size)
        id.copyInto(out, HEADER_BYTES)
        body.copyInto(out, HEADER_BYTES + id.size)
        return out
    }

    private fun writeU16(out: ByteArray, at: Int, value: Int) {
        out[at] = (value and 0xFF).toByte()
        out[at + 1] = ((value ushr 8) and 0xFF).toByte()
    }

    private fun writeU32(out: ByteArray, at: Int, value: Int) {
        out[at] = (value and 0xFF).toByte()
        out[at + 1] = ((value ushr 8) and 0xFF).toByte()
        out[at + 2] = ((value ushr 16) and 0xFF).toByte()
        out[at + 3] = ((value ushr 24) and 0xFF).toByte()
    }

    private fun readU16(bytes: ByteArray, at: Int): Int =
        (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8)

    /** 读到 u32；超过 Int 能表示的范围时返回 -1（调用方按"长度不合法"处理）。 */
    private fun readU32(bytes: ByteArray, at: Int): Int {
        val value =
            (bytes[at].toLong() and 0xFF) or
                ((bytes[at + 1].toLong() and 0xFF) shl 8) or
                ((bytes[at + 2].toLong() and 0xFF) shl 16) or
                ((bytes[at + 3].toLong() and 0xFF) shl 24)
        return if (value > Int.MAX_VALUE) -1 else value.toInt()
    }
}

/** 帧头上的 kind。 */
object WireKind {
    const val REQ: Int = 0x01
    const val RES: Int = 0x02
    const val ERR: Int = 0x03
    const val EVT: Int = 0x04

    /** 握手 hello（v5）：唯一允许明文的帧，方向固定"壳 → 客户端"。 */
    const val HELLO: Int = 0x05

    /** 二进制对象/分片（数据面）。 */
    const val BIN: Int = 0x10

    fun isKnown(kind: Int): Boolean =
        kind == REQ || kind == RES || kind == ERR || kind == EVT || kind == HELLO || kind == BIN
}

/** 解码失败的结构原因。 */
enum class WireFault {
    BAD_MAGIC,
    BAD_VERSION,
    BAD_KIND,
    BAD_FLAGS,
    BAD_EXT,
    BAD_LENGTH,
    TOO_LARGE,
    TRUNCATED,
    BAD_BODY,
}

/** 解码结论。 */
sealed interface WireDecode {
    /**
     * 解码成功。
     *
     * `bodyBytes` 一并给出：调用方要按**正文**（而不是整条消息）判策略上限，
     * 而"整条消息减帧头减 id"这件事只有这里知道，让每个调用方各自算一遍迟早会算错。
     */
    data class Ok(
        val frame: BridgeFrame,
        val bodyBytes: Int,
    ) : WireDecode

    /** 结构不合法；`id` 是尽力从帧头抠出来的关联 id（抠不到为空串）。 */
    data class Rejected(val fault: WireFault, val id: String) : WireDecode
}

// ---------------------------------------------------------------- 正文 DTO

/** `req` 正文。**没有 `v`/`type`/`id`** —— 它们都在帧头。 */
@Serializable
data class ReqBody(
    val method: String,
    val params: JsonElement? = null,
    val meta: ReqMeta? = null,
)

/** `res` 正文。**没有 `ok`** —— 成功由 `kind` 表达。 */
@Serializable
data class ResBody(
    val data: JsonElement? = null,
    val meta: ResMeta? = null,
)

/** `err` 正文。 */
@Serializable
data class ErrBody(val error: BridgeError)

/** `evt` 正文。 */
@Serializable
data class EvtBody(
    val topic: String,
    val data: JsonElement? = null,
)

/**
 * `hello` 正文（v5）：只放服务端临时公钥。
 *
 * 用 JSON 而不是原始字节：与其它控制帧同一种形状，日志与三份实现都能直接读懂；
 * 130 个 hex 字符的开销在 loopback 上没有意义（与"不做 varint"同一条理由）。
 */
@Serializable
data class HelloBody(val k: String)

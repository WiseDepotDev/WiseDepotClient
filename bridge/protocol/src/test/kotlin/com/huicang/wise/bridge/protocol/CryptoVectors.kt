package com.huicang.wise.bridge.protocol

import kotlinx.serialization.Serializable

/**
 * 冻结向量（`src/test/resources/bridge-crypto-vectors.json`）的读取入口。
 *
 * 加密层有三份实现（Kotlin / TS `seal.ts` / 工具 `bridge-wire.mjs`），
 * 而**权威只有这一份文件**：三端都要复算出同一组字节，任一端漂了就红
 * （与 `pnpm check:protocol-version` 同一体例 —— 那句注释里记着一次真实的漏改事故）。
 *
 * 为什么抽成一个 fixture 而不是各测试自己解析：`BridgeCryptoTest`（原语）与
 * `BridgeSealedFrameTest`（整帧封装）用的是同一份文件的不同部分，
 * 各写一份解析就是"同一个事实的第二份副本"。
 */
internal object CryptoVectors {
    /** 原语用例：给定 AAD 与明文，密文必须逐字节一致。 */
    @Serializable
    data class Case(
        val name: String,
        val dir: Int,
        val seq: Long,
        val aadHex: String,
        val plaintextHex: String,
        val sealedHex: String,
    )

    /** 整帧用例：内层整帧（明文）与外层密文帧必须逐字节一致。 */
    @Serializable
    data class FrameCase(
        val name: String,
        val seq: Long,
        val innerHex: String,
        val outerHex: String,
    )

    @Serializable
    data class Frames(
        val clientToServer: List<FrameCase>,
        val serverToClient: List<FrameCase>,
    )

    @Serializable
    data class Data(
        val pskHex: String,
        val clientPrivateScalarHex: String,
        val clientPublicKeyHex: String,
        val serverPrivateScalarHex: String,
        val serverPublicKeyHex: String,
        val sharedSecretHex: String,
        val connectionKeyHex: String,
        val clientToServerKeyHex: String,
        val serverToClientKeyHex: String,
        val cases: List<Case>,
        val frames: Frames,
    )

    val data: Data by lazy {
        val stream =
            CryptoVectors::class.java.getResourceAsStream("/bridge-crypto-vectors.json")
                ?: error("找不到 bridge-crypto-vectors.json（它在 src/test/resources 下）")
        // 复用全仓唯一的那份 JSON 配置（`BridgeCodec.json`），不再另建实例
        BridgeCodec.json.decodeFromString(Data.serializer(), stream.readBytes().toString(Charsets.UTF_8))
    }

    val psk: ByteArray get() = BridgeCrypto.fromHex(data.pskHex)
    val clientPublicKey: ByteArray get() = BridgeCrypto.fromHex(data.clientPublicKeyHex)
    val serverPublicKey: ByteArray get() = BridgeCrypto.fromHex(data.serverPublicKeyHex)
    val sharedSecret: ByteArray get() = BridgeCrypto.fromHex(data.sharedSecretHex)
    val clientPrivate: java.security.PrivateKey
        get() = BridgeCrypto.privateKeyFromScalar(BridgeCrypto.fromHex(data.clientPrivateScalarHex))
    val serverPrivate: java.security.PrivateKey
        get() = BridgeCrypto.privateKeyFromScalar(BridgeCrypto.fromHex(data.serverPrivateScalarHex))

    fun keys(): BridgeCrypto.SessionKeys =
        BridgeCrypto.sessionKeys(psk, clientPublicKey, serverPublicKey, sharedSecret)

    /** 新开一条连接的会话（每次调用都是**新**会话：序号各自从 1 起）。 */
    fun session(role: BridgeCrypto.Role): BridgeCrypto.Session = BridgeCrypto.Session(keys(), role)
}

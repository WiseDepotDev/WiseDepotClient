package com.huicang.wise.client.shell

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.huicang.wise.bridge.backend.SecretCodec
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore 加解密（AES-256-GCM）。
 *
 * ## 为什么不自己保管密钥
 *
 * 密钥由 Android Keystore 生成并托管：应用**拿不到密钥字节**，只能请求它做加解密
 * （有 TEE/StrongBox 的机器上密钥根本不出安全硬件）。这样就没有"密钥和密文躺在同一个目录"
 * 这种假加密 —— 那种做法只是把明文换成了另一种编码。
 *
 * 之所以不用 `EncryptedSharedPreferences`：它要把 androidx.security 拉进来，
 * 而那套库的版本与 compileSdk 34 有约束（见 gradle/libs.versions.toml 的说明），
 * 而这里需要的功能（Keystore AES/GCM）本身就在系统 API 里。
 *
 * ## 密文自带 IV
 *
 * GCM 每次加密都必须用新的 IV。这里把 IV 连同它的长度一起前置到密文里，
 * 解密时按记录的长度切分 —— 不写死 12 字节，因为 IV 长度是**加密时**才能确定的。
 */
class AndroidKeystoreCodec(private val alias: String = DEFAULT_ALIAS) : SecretCodec {
    override val id: String = "android-keystore"

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun key(): SecretKey {
        val ks = keyStore()
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // 不要求用户认证：桥要在应用启动时静默恢复登录态，
                // 弹指纹/密码会变成"每次开应用先解锁一次"，现场不现实。
                .build(),
        )
        return generator.generateKey()
    }

    override fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val body = cipher.doFinal(plain)
        return byteArrayOf(iv.size.toByte()) + iv + body
    }

    override fun open(sealed: ByteArray): ByteArray? =
        runCatching {
            require(sealed.size > 1) { "密文过短" }
            val ivLength = sealed[0].toInt()
            require(ivLength in 1..32 && sealed.size > 1 + ivLength) { "IV 长度不合理" }
            val iv = sealed.copyOfRange(1, 1 + ivLength)
            val body = sealed.copyOfRange(1 + ivLength, sealed.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.doFinal(body)
        }.getOrNull()

    companion object {
        private const val PROVIDER = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val DEFAULT_ALIAS = "wise-bridge-session"

        /**
         * 这台设备能不能用 Keystore。
         *
         * 不能时调用方**必须退回内存存储并撤回 `storage.secure` 声明** ——
         * 绝不降级成明文落盘（明文凭据文件比"重启重新登录"危险得多）。
         */
        fun available(): Boolean =
            runCatching {
                val probe = AndroidKeystoreCodec("wise-bridge-probe")
                probe.open(probe.seal("probe".toByteArray()))?.contentEquals("probe".toByteArray()) == true
            }.getOrDefault(false)
    }
}

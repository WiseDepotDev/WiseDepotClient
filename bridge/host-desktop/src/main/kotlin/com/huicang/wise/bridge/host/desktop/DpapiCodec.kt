package com.huicang.wise.bridge.host.desktop

import com.huicang.wise.bridge.backend.SecretCodec
import com.sun.jna.Platform
import com.sun.jna.platform.win32.Crypt32Util

/**
 * Windows DPAPI 加解密。
 *
 * ## 为什么是 DPAPI
 *
 * 令牌要落盘跨重启恢复，而落盘必须加密（见 `PersistentTokenStore` 的注释）。
 * Windows 上做这件事的标准做法就是 DPAPI：密钥由**用户账户**派生并托管在系统里，
 * 应用不需要自己保管任何密钥 —— 也就没有"密钥和密文放在同一个目录"这种假加密。
 * Electron 的 `safeStorage` 底下用的也是它。
 *
 * `CRYPTPROTECT_UI_FORBIDDEN`：绝不弹系统对话框。这是个后台进程，
 * 弹窗没人点，而阻塞会表现为"应用卡住不响应"。
 *
 * ## 换机器/换用户会解不开
 *
 * 那是 DPAPI 的设计意图，不是缺陷。`open` 此时返回 `null`，
 * 上层按"未登录"处理（重新登录一次即可）。
 */
class DpapiCodec : SecretCodec {
    override val id: String = "dpapi"

    override fun seal(plain: ByteArray): ByteArray =
        // 实际签名（`javap com.sun.jna.platform.win32.Crypt32Util` 得到的，别凭记忆写）：
        //   cryptProtectData(byte[]) / (byte[], int dwFlags) / (byte[], byte[] entropy, int, String lpUser, PROMPTSTRUCT)
        // 这里用 `(byte[], int)`：不加额外熵 = 只依赖当前用户的主密钥。
        // 我凭记忆连写错两次（一次 6 参、一次 5 参），两次都是编译器拦下的。
        Crypt32Util.cryptProtectData(plain, CRYPTPROTECT_UI_FORBIDDEN)

    override fun open(sealed: ByteArray): ByteArray? =
        runCatching {
            Crypt32Util.cryptUnprotectData(sealed, CRYPTPROTECT_UI_FORBIDDEN)
        }.getOrNull()

    companion object {
        private const val CRYPTPROTECT_UI_FORBIDDEN = 0x1

        /**
         * 这个宿主能不能提供 DPAPI。
         *
         * 不能时调用方**必须退回内存存储并撤回 `storage.secure` 声明** ——
         * 而不是"降级成明文落盘"：明文凭据文件比重新登录一次危险得多。
         */
        fun available(): Boolean {
            if (!Platform.isWindows()) {
                return false
            }
            return runCatching {
                val probe = "wise-bridge-probe".toByteArray()
                Crypt32Util.cryptUnprotectData(
                    Crypt32Util.cryptProtectData(probe, CRYPTPROTECT_UI_FORBIDDEN),
                    CRYPTPROTECT_UI_FORBIDDEN,
                ).contentEquals(probe)
            }.getOrDefault(false)
        }
    }
}

package com.huicang.wise.bridge.backend

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * 令牌落盘的边界测试。
 *
 * 这里覆盖的是**跨平台共享的那部分**（格式 / 原子写 / 损坏容错）；
 * 各平台的加解密（Keystore / DPAPI）在真机上验。
 *
 * 之所以值得单独测：这段代码的失败模式都是"静默"的 ——
 * 写坏了不报错、读不出来也不报错，用户看到的现象只有一句"又要重新登录"。
 */
class PersistentTokenStoreTest {
    /** 无依赖的假编解码：把字节取反。足以验证"存进去能读出来"与"存的是密文不是明文"。 */
    private class XorCodec(
        override val id: String = "xor-test",
        private val failSeal: Boolean = false,
        private val failOpen: Boolean = false,
    ) : SecretCodec {
        override fun seal(plain: ByteArray): ByteArray {
            if (failSeal) error("模拟加密失败（设备密钥不可用）")
            return plain.map { (it.toInt() xor 0x5A).toByte() }.toByteArray()
        }

        override fun open(sealed: ByteArray): ByteArray? {
            if (failOpen) return null
            return sealed.map { (it.toInt() xor 0x5A).toByte() }.toByteArray()
        }
    }

    private fun store(file: Path, codec: SecretCodec = XorCodec(), logs: MutableList<String> = mutableListOf()) =
        PersistentTokenStore(file, codec) { logs += it }

    @Test
    @DisplayName("落盘后新建实例能恢复会话（这就是\"冷启动免登录\"的全部机制）")
    fun roundTrip(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        val first = store(file)
        first.update("access-1", "refresh-1")
        assertTrue(Files.exists(file), "update 之后应当有文件落地")

        val second = store(file)
        assertEquals("access-1", second.accessToken())
        assertEquals("refresh-1", second.refreshToken())
        assertTrue(second.persistent)
    }

    @Test
    @DisplayName("文件里不是明文 —— 令牌值不能直接出现在磁盘上")
    fun notPlaintext(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        store(file).update("SUPER-SECRET-TOKEN", "SUPER-SECRET-REFRESH")
        val raw = String(Files.readAllBytes(file))
        assertFalse(raw.contains("SUPER-SECRET-TOKEN"), "明文令牌出现在文件里：$raw")
        assertFalse(raw.contains("SUPER-SECRET-REFRESH"), "明文 refresh 出现在文件里：$raw")
        assertTrue(raw.contains("xor-test"), "文件里应当记录加密方式，便于识别不匹配")
    }

    @Test
    @DisplayName("clear() 之后文件消失，新实例读不到任何令牌")
    fun clearRemovesFile(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        val s = store(file)
        s.update("a", "r")
        s.clear()
        assertFalse(Files.exists(file), "clear 之后文件应当被删掉")
        assertNull(store(file).accessToken())
    }

    @Test
    @DisplayName("文件损坏 → 当作未登录，不抛异常，且**不删文件**")
    fun corruptFileIsTolerated(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        Files.write(file, "这不是 JSON".toByteArray())
        val logs = mutableListOf<String>()
        val s = store(file, XorCodec(), logs)
        assertNull(s.accessToken())
        assertNull(s.refreshToken())
        assertTrue(Files.exists(file), "读不出来的文件不该被删掉（删是不可逆的，而留下不影响使用）")
        assertTrue(logs.isNotEmpty(), "必须留下日志说明为什么没恢复 —— 静默失败最难查")
    }

    @Test
    @DisplayName("加密方式不匹配 → 当作未登录（换了实现或拷了别处的文件）")
    fun codecMismatchIsTolerated(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        store(file, XorCodec(id = "old-codec")).update("a", "r")
        assertNull(store(file, XorCodec(id = "new-codec")).accessToken())
    }

    @Test
    @DisplayName("解不开（换机器/换用户）→ 当作未登录，不崩")
    fun undecryptableIsTolerated(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        store(file, XorCodec(id = "c")).update("a", "r")
        assertNull(store(file, XorCodec(id = "c", failOpen = true)).accessToken())
    }

    @Test
    @DisplayName("加密失败 → 内存里仍然可用，但不落盘（绝不降级成明文）")
    fun sealFailureDoesNotFallBackToPlaintext(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        val logs = mutableListOf<String>()
        val s = store(file, XorCodec(failSeal = true), logs)
        s.update("access-x", "refresh-x")
        assertEquals("access-x", s.accessToken(), "加密失败不该影响本次会话")
        assertFalse(Files.exists(file), "加密失败时绝不能写出未加密的文件")
        assertTrue(logs.any { it.contains("加密失败") }, "必须说明为何没落盘：$logs")
    }

    @Test
    @DisplayName("只更新一个令牌时，另一个保持原值（续期只换 access 的场景）")
    fun partialUpdateKeepsOther(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        val s = store(file)
        s.update("access-1", "refresh-1")
        s.update("access-2", s.refreshToken())
        val again = store(file)
        assertEquals("access-2", again.accessToken())
        assertEquals("refresh-1", again.refreshToken())
    }

    @Test
    @DisplayName("update(null, null) 等价于 clear（登录流程里可能走到）")
    fun nullUpdateErases(@TempDir dir: Path) {
        val file = dir.resolve("session.enc")
        val s = store(file)
        s.update("a", "r")
        s.update(null, null)
        assertFalse(Files.exists(file))
    }

    @Test
    @DisplayName("内存实现必须自报 persistent=false —— 能力声明靠它，不能撒谎")
    fun inMemoryIsNotPersistent() {
        assertFalse(InMemoryTokenStore().persistent, "内存存储若自报 persistent，宿主就会错误地声明 storage.secure")
    }
}

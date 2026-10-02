package com.huicang.wise.bridge.backend

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.Base64

/**
 * "把明文封起来 / 打开" —— 各宿主唯一需要自己实现的一小块。
 *
 * 为什么只抽这一小块：落盘格式、原子写、损坏容错、并发这些**容易写错又不分平台**的部分
 * 全部集中在 [PersistentTokenStore] 里（也因此能在 JVM 上直接单测）；
 * 各平台真正的差异只有"用哪个密钥体系"，所以那部分才做成接口。
 *
 * 实现约定：`open` 解不开时必须返回 `null` 而**不是抛异常** ——
 * 换机器、换用户、清过密钥都会让旧密文解不开，那是正常情况（重新登录一次），
 * 不是崩溃理由。
 */
interface SecretCodec {
    /** 写进文件里的标识：换实现/换算法时要能识别出"这不是我加的密"。 */
    val id: String

    fun seal(plain: ByteArray): ByteArray

    fun open(sealed: ByteArray): ByteArray?
}

/**
 * 令牌落盘（加密）。
 *
 * ## 为什么必须加密
 *
 * 令牌是**长期凭据**：文件里躺着一个 refreshToken，等于把这台机器变成一把钥匙。
 * 所以这里不提供"明文落盘"的选项 —— 拿不到平台密钥体系时宁可**退回内存存储**
 * （代价是重启要重新登录），也不写明文文件。
 *
 * ## 损坏一律当"未登录"，不清文件
 *
 * 解不开的原因很多（换了机器、换了用户、密钥被清、文件被改），
 * 但它们的正确处理都一样：**当作没登录**，让用户重新登录一次。
 * 这里刻意**不删除**读不出来的文件：删除是不可逆的，而留下的坏文件不影响使用
 * （下次登录会直接覆盖它），却能在排障时说明"当时是有东西的"。
 */
class PersistentTokenStore(
    private val file: Path,
    private val codec: SecretCodec,
    private val log: (String) -> Unit = {},
) : TokenStore {
    /** Android API 25 compatible entry point; path conversion stays in this JVM-shared module. */
    constructor(
        filePath: String,
        codec: SecretCodec,
        log: (String) -> Unit = {},
    ) : this(java.nio.file.Paths.get(filePath), codec, log)

    @Volatile private var access: String? = null
    @Volatile private var refresh: String? = null
    private val writeLock = Any()

    override val persistent: Boolean = true

    init {
        load()
    }

    private fun load() {
        if (!Files.exists(file)) {
            return
        }
        val raw =
            runCatching { Files.readAllBytes(file) }.getOrElse {
                log("令牌文件读不出来（${it.javaClass.simpleName}），按未登录处理")
                return
            }
        val envelope =
            runCatching { JSON.parseToJsonElement(String(raw, StandardCharsets.UTF_8)).jsonObject }
                .getOrElse {
                    log("令牌文件不是合法信封，按未登录处理（文件保留）")
                    return
                }

        val fileCodec = envelope["codec"]?.jsonPrimitive?.content
        if (fileCodec != codec.id) {
            // 典型场景：换了实现，或把别处的文件拷了过来
            log("令牌文件的加密方式（${fileCodec ?: "?"}）与当前（${codec.id}）不一致，按未登录处理")
            return
        }

        val sealed =
            runCatching { Base64.getDecoder().decode(envelope["data"]?.jsonPrimitive?.content ?: "") }
                .getOrElse {
                    log("令牌文件里的密文不是合法 base64，按未登录处理")
                    return
                }
        // 解不开 = open 返回 null（实现约定），不抛
        val plain = codec.open(sealed) ?: run {
            log("令牌解不开（换了机器/用户，或密钥被清），按未登录处理")
            return
        }
        val obj = runCatching { JSON.parseToJsonElement(String(plain, StandardCharsets.UTF_8)).jsonObject }
            .getOrElse {
                log("令牌明文不是合法 JSON，按未登录处理")
                return
            }
        access = obj["access"]?.jsonPrimitive?.content?.takeIf { it.isNotEmpty() }
        refresh = obj["refresh"]?.jsonPrimitive?.content?.takeIf { it.isNotEmpty() }
        if (access != null) {
            log("已从本机恢复登录态（凭据 ${codec.id} 加密保存）")
        }
    }

    override fun accessToken(): String? = access

    override fun refreshToken(): String? = refresh

    override fun update(
        access: String?,
        refresh: String?,
    ) {
        this.access = access
        this.refresh = refresh
        if (access == null && refresh == null) {
            erase()
            return
        }
        persist()
    }

    override fun clear() {
        access = null
        refresh = null
        erase()
    }

    private fun persist() {
        val plain =
            buildJsonObject {
                this@PersistentTokenStore.access?.let { put("access", JsonPrimitive(it)) }
                this@PersistentTokenStore.refresh?.let { put("refresh", JsonPrimitive(it)) }
            }.toString().toByteArray(StandardCharsets.UTF_8)

        val sealed =
            runCatching { codec.seal(plain) }.getOrElse {
                // 加密失败就得放弃落盘 —— 绝不能降级成明文
                log("令牌加密失败（${it.javaClass.simpleName}），本次不落盘：重启后需要重新登录")
                return
            }
        val envelope =
            buildJsonObject {
                put("v", JsonPrimitive(FORMAT_VERSION))
                put("codec", JsonPrimitive(codec.id))
                put("data", JsonPrimitive(Base64.getEncoder().encodeToString(sealed)))
            }.toString().toByteArray(StandardCharsets.UTF_8)

        synchronized(writeLock) {
            runCatching {
                file.parent?.let { Files.createDirectories(it) }
                restrictToOwner(file.parent)
                // 先写临时文件再原子替换：进程在写一半时被杀，留下的是**旧文件**而不是半个新文件
                val tmp = file.resolveSibling(file.fileName.toString() + ".tmp")
                Files.write(tmp, envelope)
                restrictToOwner(tmp)
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            }.onFailure {
                log("令牌落盘失败（${it.javaClass.simpleName}）：重启后需要重新登录")
            }
        }
    }

    private fun erase() {
        synchronized(writeLock) {
            runCatching { Files.deleteIfExists(file) }
                .onFailure { log("令牌文件删除失败（${it.javaClass.simpleName}）") }
        }
    }

    /**
     * 只有属主可读写的权限。
     *
     * Windows 上 `setPosixFilePermissions` 会抛 `UnsupportedOperationException` ——
     * 这是**预期内**的：那边的保护来自 DPAPI 加密与用户目录本身，
     * 所以这里吞掉失败而不是让落盘整个失败。
     */
    private fun restrictToOwner(path: Path?) {
        if (path == null) {
            return
        }
        runCatching {
            if (Files.getFileStore(path).supportsFileAttributeView("posix")) {
                Files.setPosixFilePermissions(
                    path,
                    java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"),
                )
            }
        }
    }

    companion object {
        const val FORMAT_VERSION: Int = 1

        private val JSON = Json { ignoreUnknownKeys = true }

    }
}

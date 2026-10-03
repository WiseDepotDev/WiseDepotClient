package com.huicang.wise.client.shell

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.nfc.NfcAdapter
import android.nfc.NfcManager
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings

/**
 * NFC 读卡（B3 / S2b）：把 Android 的 reader mode 包成一个可由 `MainActivity` 开关的对象。
 *
 * ## 与 [NfcReaderState] 的分工
 *
 * 三态判定与去抖是**纯逻辑**（在那边，可在 JVM 上穷举）；这里只做"必须真机才能验"的部分：
 * 取 `NfcAdapter`、`enableReaderMode`、把回调切回主线程、把 tag 变成可下发的事件载荷。
 *
 * ## 三条 Android 侧的硬事实（brief §3 记过，这里落成代码）
 *
 * 1. **用 `enableReaderMode` 而不是前台派发**：后者要过系统的 NDEF 解析链，表现是"读到了但要等几秒"。
 * 2. **`ReaderCallback` 在 binder 线程回调** —— 碰桥/UI 必须切回主线程，否则是在别的线程上碰宿主状态。
 * 3. **同一张静止的卡会连续回调** —— 去抖放在 [NfcDebouncer]（不崩、只是刷屏，最容易被漏）。
 */
class NfcReader(
    private val activity: Activity,
    /** 读到一张**通过去抖**的卡：`(hexId, tech, atMs)`。 */
    private val onTag: (id: String, tech: String, atMs: Long) -> Unit,
    /** 状态变化：载荷取值见 [NfcReaderState.statePayloadFor]。 */
    private val onState: (payload: String) -> Unit,
    private val log: (String) -> Unit = {},
) {
    private val adapter: NfcAdapter? = resolveAdapter(activity)
    private val debouncer = NfcDebouncer()
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile private var reading = false

    /** 当前可用性（硬件是否存在 / 系统是否开着）。 */
    val availability: NfcAvailability
        get() =
            NfcReaderState.decide(
                adapterPresent = adapter != null,
                adapterEnabled = adapter?.isEnabled == true,
            )

    /**
     * 开始读。**幂等**：已经在读就只回报一次状态，不重复 `enableReaderMode`。
     *
     * @return 本次的可用性；非 [NfcAvailability.READY] 时不会进入读卡状态，
     *   调用方据此回 `BRIDGE_NFC_UNSUPPORTED` / `BRIDGE_NFC_DISABLED` 并让界面给对应出路。
     */
    fun start(): NfcAvailability {
        val state = availability
        if (state != NfcAvailability.READY) {
            log("[nfc] 未进入读卡：$state")
            mainHandler.post { onState(NfcReaderState.statePayloadFor(state)) }
            return state
        }
        if (reading) {
            return state
        }
        val current = adapter
        if (current == null) {
            return NfcAvailability.UNSUPPORTED
        }
        try {
            current.enableReaderMode(
                activity,
                { tag ->
                    // binder 线程：**先算完纯数据，再切主线程**去碰桥/UI
                    val payload = tag?.let { toPayload(it) }
                    if (payload != null) {
                        mainHandler.post { onTag(payload.first, payload.second, System.currentTimeMillis()) }
                    }
                },
                READER_FLAGS,
                Bundle().apply {
                    // 100ms 的存在性检查：默认 125ms 会让"卡一直贴着"时回调更密（去抖能兜，
                    // 但少一次回调少一次跨线程投递）
                    putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 100)
                },
            )
            reading = true
            log("[nfc] 已进入读卡（reader mode）")
        } catch (e: Throwable) {
            // 部分定制 ROM 在 NFC 服务异常时会抛 —— 不吞掉，回一条明确状态
            reading = false
            log("[nfc] enableReaderMode 失败：${e.javaClass.simpleName}: ${e.message}")
        }
        return state
    }

    /** 停止读卡。**幂等**（`onPause` 与显式停止都会调）。 */
    fun stop() {
        debouncer.reset()
        if (!reading) {
            return
        }
        reading = false
        runCatching { adapter?.disableReaderMode(activity) }
            .onFailure { log("[nfc] disableReaderMode 失败：${it.javaClass.simpleName}") }
        log("[nfc] 已停止读卡")
    }

    /**
     * 跳到系统 NFC 设置页（界面「去开启」按钮的落点）。
     *
     * 为什么必须由壳做：Web 侧打不开系统设置。返回 `false` 表示**没能打开** ——
     * 调用方应如实回报，而不是假装成功（"点了没反应"就是这么来的）。
     */
    fun openSettings(): Boolean =
        runCatching {
            val intent = Intent(Settings.ACTION_NFC_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            true
        }.getOrElse {
            log("[nfc] 打开 NFC 设置页失败：${it.javaClass.simpleName}: ${it.message}")
            false
        }

    /**
     * 是否应当上报这次卡（含去抖）。
     *
     * 抽成方法暴露给测试与诊断：真机上"贴了同一张卡十次被报了十次"正是靠它定位的。
     */
    fun shouldReport(
        id: String,
        nowMs: Long,
    ): Boolean = debouncer.shouldReport(id, nowMs)

    private fun toPayload(tag: Tag): Pair<String, String>? {
        val id = tag.id ?: return null
        if (id.isEmpty()) {
            return null
        }
        if (!shouldReport(hex(id), System.currentTimeMillis())) {
            return null
        }
        return hex(id) to techName(tag)
    }

    private fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0F])
        }
        return out.toString()
    }

    /** 技术名：取第一个非 `android.nfc.tech.` 前缀的短名（如 `NfcA`）；取不到给 `Unknown`。 */
    private fun techName(tag: Tag): String =
        tag.techList
            .asSequence()
            .map { it.substringAfterLast('.') }
            .firstOrNull { it.isNotEmpty() }
            ?: "Unknown"

    private companion object {
        /**
         * 读 A/B/F/V 四类（覆盖绝大多数门禁卡与标签）。
         *
         * 加 `FLAG_SKIP_NDEF_CHECK`：我们只用 `tag.id` 与技术名，不读 NDEF 内容 ——
         * 让系统先做一次 NDEF 解析只会让回调变慢（brief §3 第 1 条）。
         */
        val READER_FLAGS: Int =
            NfcAdapter.FLAG_READER_NFC_A or
                NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_NFC_F or
                NfcAdapter.FLAG_READER_NFC_V or
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK

        const val HEX = "0123456789abcdef"

        /**
         * 取 `NfcAdapter`。
         *
         * API 30 起 `NfcAdapter.getDefaultAdapter` 已废弃（改用 `NfcManager`）——
         * 分版本走，避免在废弃 API 上留下编译告警（本仓对告警是认真的）。
         */
        fun resolveAdapter(context: Context): NfcAdapter? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                context.getSystemService(NfcManager::class.java)?.defaultAdapter
            } else {
                @Suppress("DEPRECATION")
                NfcAdapter.getDefaultAdapter(context)
            }
    }
}

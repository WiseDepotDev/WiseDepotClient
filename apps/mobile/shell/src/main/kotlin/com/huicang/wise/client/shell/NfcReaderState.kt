package com.huicang.wise.client.shell

/**
 * NFC 三态判定与事件/错误码映射（B3 / S2）。
 *
 * ## 为什么单独一个文件、且不 import 任何 android 类
 *
 * Android 侧真正难测的是"电波里的事"，而**容易写错却又不报错**的是这两件纯逻辑：
 *  - 三态判定（没有硬件 / 有硬件但系统里关着 / 可用）—— 三种状态给用户的**出路完全不同**；
 *  - 同一张卡的**连续回调去抖** —— 不做的话界面会瞬间收到几十条 `nfc.tag`。
 *
 * 把它们与 `NfcAdapter` 解耦之后，可以用 `NfcReaderStateTest` 在 JVM 上穷举，
 * 不必举着手机反复贴卡。真正的 reader mode 接线留在 `NfcReader`（那部分只能真机验）。
 */
enum class NfcAvailability {
    /** 没有 NFC 硬件：壳**不声明** `nfc.read`，界面连入口都不画。 */
    UNSUPPORTED,

    /** 有硬件但系统里关着：有出路（去系统设置里开启）。 */
    DISABLED,

    /** 已开启：进入前台即开始读。 */
    READY,
}

object NfcReaderState {
    /** 与 Kotlin `BridgeErrorCodes` / TS `BridgeErrorCode` 逐字一致的错误码。 */
    const val ERROR_UNSUPPORTED: String = "BRIDGE_NFC_UNSUPPORTED"
    const val ERROR_DISABLED: String = "BRIDGE_NFC_DISABLED"

    /** 与 TS `BRIDGE_EVENT_NFC_*` 逐字一致的事件 topic（跨语言线上契约串）。 */
    const val EVENT_TAG: String = "nfc.tag"
    const val EVENT_STATE: String = "nfc.state"

    /**
     * 三态判定。
     *
     * 注意参数是"硬件是否存在"而不是 `NfcAdapter` 对象：把 Android 类型挡在外面，
     * 这一层才可以在 JVM 上穷举（也顺便逼调用方**显式**判断硬件，而不是靠 `adapter != null` 蒙）。
     */
    fun decide(
        adapterPresent: Boolean,
        adapterEnabled: Boolean,
    ): NfcAvailability =
        when {
            !adapterPresent -> NfcAvailability.UNSUPPORTED
            !adapterEnabled -> NfcAvailability.DISABLED
            else -> NfcAvailability.READY
        }

    /** 该状态对应的错误码；[NfcAvailability.READY] 没有错误码。 */
    fun errorCodeFor(state: NfcAvailability): String? =
        when (state) {
            NfcAvailability.UNSUPPORTED -> ERROR_UNSUPPORTED
            NfcAvailability.DISABLED -> ERROR_DISABLED
            NfcAvailability.READY -> null
        }

    /** 该状态对应的 `nfc.state` 载荷值（界面据此渲染四种表现）。 */
    fun statePayloadFor(state: NfcAvailability): String =
        when (state) {
            NfcAvailability.UNSUPPORTED -> "unsupported"
            NfcAvailability.DISABLED -> "off"
            NfcAvailability.READY -> "on"
        }
}

/**
 * 去抖：同一张卡在窗口内只上报一次。
 *
 * 依据（Android 实测）：`ReaderCallback` 对**同一张静止的卡**会连续回调，
 * 间隔由读卡循环决定（几十毫秒级）。不做去抖的表现不是崩溃，而是**界面被同一张卡刷屏** ——
 * 正因为"不崩"，它最容易被漏掉，所以放进可单测的这一层。
 *
 * 规则：**id 不同 ⇒ 立刻上报**（换了一张卡是真实事件）；id 相同 ⇒ 窗口内只报一次。
 */
class NfcDebouncer(private val windowMs: Long = DEFAULT_WINDOW_MS) {
    private var lastId: String? = null
    private var lastAtMs: Long? = null

    /** 这一次回调要不要上报。 */
    fun shouldReport(
        id: String,
        nowMs: Long,
    ): Boolean {
        val previousAt = lastAtMs
        val withinWindow =
            previousAt != null && id == lastId && nowMs - previousAt < windowMs
        if (withinWindow) {
            return false
        }
        lastId = id
        lastAtMs = nowMs
        return true
    }

    /** 停读/切后台时清掉，避免"停了十分钟再贴同一张卡"被误判成连击。 */
    fun reset() {
        lastId = null
        lastAtMs = null
    }

    companion object {
        /** 1.5 秒：足够滤掉读卡循环的连击，又短到"抬起再贴一次"仍算新的一次。 */
        const val DEFAULT_WINDOW_MS: Long = 1_500
    }
}

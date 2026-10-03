package com.huicang.wise.client.shell

import com.huicang.wise.bridge.capability.LocalMethodPort
import com.huicang.wise.bridge.protocol.BridgeLocalMethods
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * 当前前台 `Activity` 的 NFC reader —— **本机方法 `nfc.openSettings` 的落点**。
 *
 * ## 为什么需要这一层间接
 *
 * 本机方法由**桥**的分发线程调用，而桥是在 `Application.onCreate` 里起来的，
 * 那时还没有任何 `Activity`（更没有"用户正看着哪一个"）。`NfcReader` 又必须持有
 * 一个 `Activity`（`enableReaderMode`/`startActivity` 都要求）。
 *
 * 于是把"当前那个 reader"放在这里，由 `MainActivity` 的 `onCreate` 挂上、
 * `onDestroy` 摘掉：
 *  - **不长期持有 Activity**：`onDestroy` 时置 `null`，否则旋转/回收会把旧 Activity 漏在
 *    单例里（那是内存泄漏，也是"设置页从已经没了的界面里打开"这类怪象的来源）；
 *  - **没有 reader 时如实返回 false**：`openSettings()` 的语义就是"有没有打开"，
 *    这里不能假装成功（brief §2：返回 `{opened:boolean}`）。
 */
internal object NfcReaderHost {
    @Volatile private var reader: NfcReader? = null

    fun attach(next: NfcReader?) {
        reader = next
    }

    fun openSettings(): Boolean = reader?.openSettings() ?: false
}

/**
 * 手机壳的**本机方法表**（B3/S3）。
 *
 * 白名单是三段并集（内建 ∪ 本机 ∪ 契约，见 `BridgeDispatcher`），这里登记的是中段。
 * `methodIds` 刻意**逐条列举**而不是直接用 [BridgeLocalMethods.all]：
 * 后者是"协议里存在哪些本机方法"，而这里要说的是"**这台宿主实现了哪些**" ——
 * 与能力位同一条纪律（声明即承诺）。登记了却没实现的表现是 `BRIDGE_INTERNAL`，
 * 比"方法不存在"（`BRIDGE_METHOD_UNKNOWN`）更难查：它会让人以为是调用成功后的内部错误。
 *
 * 现在只有一条：`nfc.openSettings`。`nfc.start`/`nfc.stop` **刻意不做成方法**
 * （见 [BridgeLocalMethods.NFC_OPEN_SETTINGS] 的说明：那是双所有者）。
 */
class NfcLocalMethods : LocalMethodPort {
    override val methodIds: Set<String> = setOf(BridgeLocalMethods.NFC_OPEN_SETTINGS)

    override suspend fun invoke(
        methodId: String,
        params: JsonElement?,
    ): JsonElement? =
        when (methodId) {
            // 无参数；返回 `{opened:boolean}` —— 打不开系统设置页时如实回 false，
            // 界面据此说"没能打开，请手动到系统设置里开 NFC"，而不是假装跳过去了。
            BridgeLocalMethods.NFC_OPEN_SETTINGS ->
                buildJsonObject {
                    put("opened", JsonPrimitive(NfcReaderHost.openSettings()))
                }

            else -> throw IllegalArgumentException("未登记的本机方法：$methodId")
        }
}

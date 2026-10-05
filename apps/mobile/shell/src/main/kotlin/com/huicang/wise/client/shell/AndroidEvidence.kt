package com.huicang.wise.client.shell

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Debug
import com.huicang.wise.bridge.capability.HumanVerifyPort
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * 手机壳的**本地环境证据**（人机验证用）。
 *
 * 与桌面那一份（`apps/desktop/src/humanVerify.ts`）对称：回答**只有壳看得见**的事实，
 * 页面侧的（`navigator.webdriver`、指针轨迹）由页面自己采集，两边由桥合并。
 *
 * ## 它是什么、不是什么
 *
 * 这些字段**不是结论**，全部可由本机上的攻击者伪造（改 APK、挂调试器）。
 * 服务端可以完全不采信 —— 放行判据在服务端（票据 + 风险规则 + 计算量证明）。
 * 它们只用于"让服务端把难度调高"与审计。
 *
 * ## 为什么用 `FLAG_DEBUGGABLE` 而不是"比对签名"
 *
 * 比对签名需要把**发布证书的哈希**编进包里（一个 `BuildConfig` 字段 + 构建期注入），
 * 而那件事本身是"声明即承诺"的另一条线（要有人维护那个哈希）。这一版先用可靠且零维护的判据：
 * `ApplicationInfo.FLAG_DEBUGGABLE` 为真 ⇒ 不是发布包。它挡得住"直接装个 debug 包"，
 * 挡不住"改过的 release 包"——后者要靠服务端侧的人工/审计，写在证据里就是假的。
 */
class AndroidEvidence(private val context: Context) : HumanVerifyPort {
    override suspend fun environmentEvidence(): JsonObject =
        buildJsonObject {
            put("shellPackaged", JsonPrimitive(!isDebuggable()))
            put("debugAttached", JsonPrimitive(Debug.isDebuggerConnected() || Debug.waitingForDebugger()))
        }

    private fun isDebuggable(): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}

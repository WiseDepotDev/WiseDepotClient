package com.huicang.wise.client.shell

import android.app.Application
import android.os.Build
import kotlin.concurrent.thread

/**
 * 壳的应用入口：**在进程内把桥拉起来**。
 *
 * 为什么放在 Application 而不是 Activity：
 * 桥是"应用的本地服务"，不是"某个界面的附属品"——Activity 因旋转/回收重建时不该重起一次桥
 * （重起意味着换 token、换端口，Web 侧要重连，用户看到的是无谓的闪断）。
 */
class ShellApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        val version =
            packageManager.getPackageInfo(packageName, 0).versionName
                ?: Build.VERSION.RELEASE
        // 有没有摄像头决定要不要声明 `scan.camera`：没摄像头的设备（部分工业 PDA）
        // 照样要能装能跑，只是界面上不出现扫码入口。
        // 「有摄像头」还不够 —— [CameraSafety] 会记住"上次把相机交给 WebView 时进程没了"，
        // 那种机器上不能一遍遍地去崩，撤销入口才是诚实且可用的做法。
        val hasSystemCamera = packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_ANY)
        val hasCamera = hasSystemCamera && CameraSafety.cameraUsable(this)
        if (hasSystemCamera && !hasCamera) {
            android.util.Log.w(
                TAG,
                "本机上次在打开相机时崩溃过（WebView ${CameraSafety.webViewId(this)}），" +
                    "本次不声明 ${com.huicang.wise.bridge.protocol.BridgeCapabilities.SCAN_CAMERA}；" +
                    "WebView 升级后会自动重新尝试",
            )
        }
        /*
         * NFC（B3/S4）：有没有硬件**只能由适配器回答** —— 少数定制 ROM 上
         * `PackageManager.FEATURE_NFC` 与适配器不一致，而"声明了却做不到"正是不许出现的那种错。
         * 判据复用 `NfcReader` 里那一份分版本逻辑（两处各写一份就是两个所有者）。
         */
        val hasNfc = NfcReader.resolveAdapter(this) != null
        if (hasNfc && !NFC_READ_VERIFIED) {
            // 如实说明"为什么有硬件却不声明"：这条日志就是 S4 收口时那条待办的可查证据
            android.util.Log.w(
                TAG,
                "本机有 NFC 硬件，但 NFC_READ_VERIFIED 还是 false（读到标签尚未在真机验证过），" +
                    "本次不声明 ${com.huicang.wise.bridge.protocol.BridgeCapabilities.NFC_READ}",
            )
        }
        // 绑端口是阻塞调用，放后台线程；WebView 在此期间加载静态资源，
        // 引导接口在桥就绪前回 503，Web 侧拿到的是明确的"尚未就绪"而不是超时。
        thread(name = "shell-bridge-start") {
            runCatching { ShellBridge.startIfNeeded(this, version, filesDir, hasCamera, hasNfc) }
                .onFailure { e -> android.util.Log.e(TAG, "桥启动失败", e) }
        }
    }

    override fun onTerminate() {
        ShellBridge.stop()
        super.onTerminate()
    }

    private companion object {
        const val TAG = "WiseShell"
    }
}

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
        // 绑端口是阻塞调用，放后台线程；WebView 在此期间加载静态资源，
        // 引导接口在桥就绪前回 503，Web 侧拿到的是明确的"尚未就绪"而不是超时。
        thread(name = "shell-bridge-start") {
            runCatching { ShellBridge.startIfNeeded(version) }
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

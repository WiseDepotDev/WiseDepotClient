package com.huicang.wise.bridge.server

/**
 * 桥的日志出口。
 *
 * 为什么需要它：`:bridge:*` 是**平台无关**的模块，不能引用 `android.util.Log`，
 * 于是只能写 stderr —— 而 stderr 在 Android 上**不保证进 logcat**，
 * 结果就是"桥明明在跑，日志却一片空白"（W3 在 WSA 上实测踩到）。
 *
 * 做法与其它端口一致：模块内只保留一个可替换的出口，由宿主在启动时接管。
 * 桌面宿主保持 stderr（Electron 主进程会把它转发到自己的控制台），
 * 手机宿主换成 `android.util.Log`（进 logcat，现场才能抓得到）。
 */
object BridgeLog {
    /** 默认出口：stderr。宿主可以在 `start()` 之前替换它。 */
    @Volatile
    var sink: (String) -> Unit = { System.err.println(it) }

    fun info(message: String) {
        sink(message)
    }
}

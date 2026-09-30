package com.huicang.wise.client.shell

import android.content.Context

/**
 * "这台机器上一开相机就会把壳弄崩" 的记忆。
 *
 * ## 为什么需要它
 *
 * 实测（WSA，WebView 122）：点「扫码」后 `getUserMedia` 拿到相机，随后 WebView 的
 * 进程内 GPU 线程抛 Java 异常，Chromium 直接 `SIGTRAP` 中止：
 *
 * ```
 * F chromium: [FATAL:jni_android.cc(289)] Please include Java exception stack in crash report
 * F libc    : Fatal signal 5 (SIGTRAP) in tid ... (Chrome_InProcGp), pid ... (ang.wise.client)
 * I ActivityManager: Process com.huicang.wise.client (pid ...) has died
 * ```
 *
 * 关键在**进程归属**：崩溃的线程在我们自己的进程里，所以 `WebViewClient.onRenderProcessGone`
 * **不会被调用** —— 那是"渲染进程挂了"的回调，而这里是整个应用进程没了。
 * 既然没有任何回调，唯一的办法就是**在动手之前先留一个面包屑**：
 * 崩了就等于面包屑没被清掉，下次启动据此认定"这台机器不能开相机"。
 *
 * ## 为什么要记 WebView 版本
 *
 * 崩的是那个版本的 WebView，不是这台机器的永久属性。系统更新 WebView 之后
 * 这个结论大概率就不成立了，所以面包屑与版本绑定：版本一变，重新给一次机会。
 * 否则一次崩溃会变成这台机器上**永远**没有扫码。
 *
 * ## 为什么不用"WSA 就禁用"
 *
 * 那是把环境名写进业务判断：真机上完全正常的路径会被一句 `if (WSA)` 废掉，
 * 而且换个模拟器/新版本就对不上了。基于**实测结果**的记忆不关心是谁，
 * 只关心"上次这么干是不是死了"。
 */
object CameraSafety {
    private const val PREFS = "shell-camera-safety"

    /** 记下面包屑时所用 WebView 的标识；不一致就说明 WebView 换过版本了。 */
    private const val KEY_VERSION = "webview-id"

    /** 值为 true = 上次"相机尝试"没有收尾，进程是被它带走的。 */
    private const val KEY_CRASHED = "camera-crashed"

    /**
     * 当前 WebView 的标识（包名 + 版本）。
     *
     * 用 `WebViewCompat` 而不是 `WebView.getCurrentWebViewPackage()`：后者要求 WebView
     * **已经被初始化**，而我们在 `Application.onCreate` 里就要问这个问题 —— 那时它返回
     * null，于是标识会退化成 `unknown`，与崩溃前记下的真实标识对不上，
     * 结果是"以为 WebView 换版本了"，把刚刚才崩过一次的相机又放回去。
     * androidx 的这个封装正是为了"还没初始化也能查到"而存在。
     */
    fun webViewId(context: Context): String =
        runCatching {
            val info = androidx.webkit.WebViewCompat.getCurrentWebViewPackage(context) ?: return UNKNOWN
            "${info.packageName}@${info.versionName}"
        }.getOrDefault(UNKNOWN)

    /**
     * 这台机器的相机能不能交给 WebView 用。
     *
     * 只有**明确看到 WebView 换了版本**才重新给机会。任何一侧读不到版本（`unknown`）
     * 都不算"换了版本"：宁可暂时少一个扫码入口，也不要再崩一次 ——
     * 前者用户还能用扫码枪，后者是当着用户的面把应用打没。
     */
    fun cameraUsable(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_CRASHED, false)) {
            return true
        }
        val stored = prefs.getString(KEY_VERSION, null)
        val current = webViewId(context)
        if (stored == null || stored == UNKNOWN || current == UNKNOWN) {
            return false
        }
        return stored != current
    }

    /**
     * 即将把相机交给 WebView。**必须同步落盘**（`commit` 而不是 `apply`）：
     * 下一行代码就可能把进程带走，异步写等于没写。
     */
    fun beginAttempt(context: Context) {
        context
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_CRASHED, true)
            .putString(KEY_VERSION, webViewId(context))
            .commit()
    }

    /** 相机确实出画面了（或用户主动收起了取景）→ 清掉面包屑：这条路是通的。 */
    fun confirmAlive(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_CRASHED, false)) {
            prefs.edit().putBoolean(KEY_CRASHED, false).apply()
            android.util.Log.i(TAG, "相机取景正常，已清除\"上次可能崩过\"的标记")
        }
    }

    /** 渲染进程确实崩过（`onRenderProcessGone` 走到了）→ 与面包屑同义，直接记下。 */
    fun markUnusable(
        context: Context,
        reason: String,
    ) {
        context
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_CRASHED, true)
            .putString(KEY_VERSION, webViewId(context))
            .commit()
        android.util.Log.w(TAG, "已记下：这台机器上不给 WebView 开相机（$reason）")
    }

    private const val TAG = "WiseShell"
    private const val UNKNOWN = "unknown"
}

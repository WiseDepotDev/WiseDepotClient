package com.huicang.wise.client.shell

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.huicang.wise.bridge.protocol.BridgeProtocol
import java.io.ByteArrayInputStream

/**
 * 手机壳的界面：一个 WebView，装的就是 `apps/web/dist` 那份产物。
 *
 * 三个关键决定：
 *
 * 1. **用 `https://appassets.androidplatform.net` 而不是 `file://`**：
 *    自定义协议是**安全上下文**（secure context），`file://` 不是；而且 `file://` 的
 *    origin 是 opaque 的，WebSocket 与 CSP 都会以奇怪的方式失败。
 *
 * 2. **引导走 `__bridge.json`，不做 JS 注入**：注入 `evaluateJavascript` 有竞态
 *    （页面脚本可能先跑），而"读自己 origin 上的一份 JSON"是天然有序的，
 *    并且与桌面壳走**同一条路径**（架构不变式 2）。
 *
 * 3. **WebView 不开放文件与内容访问**：页面只需要 fetch 自己的资源 + 连回环上的 WS，
 *    多开的每一项能力都是给未来某个 XSS 准备的跳板。
 */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        assetLoader = buildAssetLoader()

        webView =
            WebView(this).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.setSupportMultipleWindows(false)
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                settings.mediaPlaybackRequiresUserGesture = true
                webViewClient = ShellWebViewClient(assetLoader)
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
            }

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setContentView(webView)
        webView.loadUrl(SHELL_INDEX_URL)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    /**
     * 一个兜底的 PathHandler 管全部路径：
     * - `__bridge.json` → 动态生成（桥未就绪时回 503，让 Web 明确显示"连接中"而不是转圈等超时）；
     * - 其余 → 交给 [WebViewAssetLoader.AssetsPathHandler] 读 APK 里的静态产物。
     */
    private fun buildAssetLoader(): WebViewAssetLoader {
        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(this)
        return WebViewAssetLoader.Builder()
            .setDomain(SHELL_DOMAIN)
            .addPathHandler(
                "/",
                object : WebViewAssetLoader.PathHandler {
                    override fun handle(path: String): WebResourceResponse? =
                        if (path == BridgeProtocol.BOOTSTRAP_PATH) {
                            bootstrapResponse()
                        } else {
                            assetsHandler.handle(path)
                        }
                },
            )
            .build()
    }

    private fun bootstrapResponse(): WebResourceResponse {
        val json = ShellBridge.handshakeJson
        if (json == null) {
            // 503 + 空体：Web 侧的 loadBootstrap 把非 2xx 当作"宿主尚未就绪"（见 bootstrap.ts）
            return WebResourceResponse("application/json", "utf-8", 503, "Bridge Not Ready", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        return WebResourceResponse(
            "application/json",
            "utf-8",
            ByteArrayInputStream(json.toByteArray(Charsets.UTF_8)),
        )
    }

    private class ShellWebViewClient(
        private val loader: WebViewAssetLoader,
    ) : WebViewClientCompat() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

        /** 不让任何外链把 WebView 导航走：这是一个装本地产物的壳，不是一个浏览器。 */
        @Deprecated("Deprecated in Java")
        override fun shouldOverrideUrlLoading(
            view: WebView,
            url: String,
        ): Boolean = !url.startsWith(SHELL_ORIGIN)

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean = !isShellUrl(request.url)
    }

    private companion object {
        const val SHELL_DOMAIN = "appassets.androidplatform.net"
        const val SHELL_ORIGIN = "https://appassets.androidplatform.net"
        const val SHELL_INDEX_URL = "$SHELL_ORIGIN/assets/web/index.html"

        fun isShellUrl(uri: Uri): Boolean = uri.toString().startsWith(SHELL_ORIGIN)
    }
}

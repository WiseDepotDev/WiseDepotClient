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

    /** 只在首次供给引导时打一行日志，避免每帧刷屏。 */
    @Volatile private var bootstrapServed = false

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
                /*
                 * 页面走 **https**（见 SHELL_ORIGIN），而桥是 `ws://` ——
                 * 从 https 页面连 ws:// 会被判为混合内容并拦掉。
                 *
                 * 这里是**有意识**地放行：桥只监听 loopback / 点对点地址，不出本机；
                 * 换来的是页面处于**安全上下文**——`getUserMedia`（相机扫码）只在安全上下文里可用，
                 * 之前为了绕开混合内容把页面退成 http，等于把相机这条路堵死了。
                 */
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                webViewClient = ShellWebViewClient(assetLoader)
                /*
                 * 相机扫码要过**两道**授权：网页的 `getUserMedia`（经 onPermissionRequest）
                 * 与系统的运行时权限（CAMERA）。这里把两者串起来 ——
                 * 缺系统权限时先弹系统弹窗，**把它挂起**，授予后再批准网页那一侧。
                 * 不这么做的话用户点一次扫码要按两次，第二次还很容易被当成"点了没反应"。
                 */
                webChromeClient =
                    object : android.webkit.WebChromeClient() {
                        override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                            val wantsCamera =
                                request.resources.contains(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                            if (!wantsCamera) {
                                // 只要不是相机（麦克风等），一律拒绝：这个壳不需要那些能力
                                request.deny()
                                return
                            }
                            if (hasCameraPermission()) {
                                request.grant(request.resources)
                            } else {
                                pendingCameraRequest = request
                                requestCameraPermission()
                            }
                        }
                    }
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

    /** 被挂起的网页相机请求：系统权限弹窗出结果后要回来批准/拒绝它。 */
    private var pendingCameraRequest: android.webkit.PermissionRequest? = null

    private fun hasCameraPermission(): Boolean =
        androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    private fun requestCameraPermission() {
        androidx.core.app.ActivityCompat.requestPermissions(
            this,
            arrayOf(android.Manifest.permission.CAMERA),
            CAMERA_PERMISSION_REQUEST,
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != CAMERA_PERMISSION_REQUEST) {
            return
        }
        val request = pendingCameraRequest
        pendingCameraRequest = null
        if (request == null) {
            return
        }
        // 用户拒了就如实拒绝网页那一侧 —— 网页的 getUserMedia 会拿到 NotAllowedError，
        // 界面显示"没拿到相机权限"，而不是永远转圈。
        if (grantResults.isNotEmpty() && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            request.grant(request.resources)
        } else {
            request.deny()
        }
    }

    /**
     * 一个兜底的 PathHandler 管全部路径：
     * - `__bridge.json` → 动态生成（桥未就绪时回 503，让 Web 明确显示"连接中"而不是转圈等超时）；
     * - 其余 → 交给 [WebViewAssetLoader.AssetsPathHandler] 读 APK 里的静态产物。
     *
     * **为什么要把 `assets/` 前缀手工剥掉**（W3 在 WSA 上实测踩到，日志是
     * `FileNotFoundException: assets/web/index.html`）：
     * `WebViewAssetLoader` 只会剥掉**注册时用的那个前缀**。注册在 `/` 时，
     * 处理器收到的是完整路径（`assets/web/index.html`），而 `AssetsPathHandler.handle(path)`
     * 是把这个字符串**原样**交给 `AssetManager.open()` 的 —— 于是它去找
     * `assets/assets/web/index.html`，必然 FileNotFoundException，界面表现为
     * `ERR_INVALID_RESPONSE`（一个看起来像网络问题、实际是路径问题的东西）。
     * 库自带的用法（注册在 `/assets/`）靠的就是同一件事：前缀被剥掉再交给 AssetManager。
     */
    private fun buildAssetLoader(): WebViewAssetLoader {
        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(this)
        return WebViewAssetLoader.Builder()
            .setDomain(SHELL_DOMAIN)
            // **放行 http**，并且页面就走 http 加载（见 SHELL_ORIGIN）。
            //
            // 为什么不能让它走 https：页面是 https，而桥是明文 `ws://`，
            // Chromium 会按"混合内容"拦掉 —— 它的豁免名单只覆盖 `127.0.0.1` / `localhost`，
            // 而 WSA 上桥必须在 `169.254.73.153`（loopback0 的点对点地址）上，不在名单里。
            //
            // 三条路里选了这条：
            //   · MIXED_CONTENT_ALWAYS_ALLOW —— 一行搞定，但它对**所有**不安全子资源永久放行，
            //     等于给未来任何一次注入留门；
            //   · 桥上 TLS（wss）—— 自签证书 + 忽略证书错误，把"本地回环"复杂化成"半个 PKI"；
            //   · 本地产物走 http —— 页面与桥**同为明文**，压根不存在混合内容。
            //
            // 代价：`http://appassets.androidplatform.net` 不是安全上下文。
            // 本项目不用任何需要安全上下文的 API（无 crypto.subtle / service worker），
            // 一旦将来要用，这条要重新评估。
            .setHttpAllowed(true)
            .addPathHandler(
                "/",
                object : WebViewAssetLoader.PathHandler {
                    override fun handle(path: String): WebResourceResponse? =
                        when {
                            path == BridgeProtocol.BOOTSTRAP_PATH.removePrefix("/") -> bootstrapResponse()
                            path.startsWith(ASSET_PREFIX) -> assetsHandler.handle(path.removePrefix(ASSET_PREFIX))
                            else -> null
                        }
                },
            )
            .build()
    }

    private fun bootstrapResponse(): WebResourceResponse {
        val json = ShellBridge.handshakeJson
        if (json == null) {
            // 503 + 空体：Web 侧的 loadBootstrap 把非 2xx 当作"宿主尚未就绪"（见 bootstrap.ts）
            android.util.Log.i(TAG, "引导尚未就绪（桥还没起来），回 503")
            return WebResourceResponse("application/json", "utf-8", 503, "Bridge Not Ready", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        if (!bootstrapServed) {
            bootstrapServed = true
            android.util.Log.i(TAG, "首次供给 __bridge.json（桥已就绪）")
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

        /**
         * 页面加载完成 = "装进设备后真的跑起来了"。
         *
         * 为什么值得专门打一行日志：没有设备的机器上，这一条是**唯一**能区分
         * "壳启动了但页面白屏"与"页面正常"的信号；而白屏的原因（资源没打进包、
         * 前缀没剥对、引导 503）在日志里看不出任何线索。
         */
        override fun onPageFinished(
            view: WebView,
            url: String,
        ) {
            super.onPageFinished(view, url)
            android.util.Log.i(TAG, "页面加载完成：$url")
        }

        /**
         * 不用 `onReceivedError(view, request, error)`：它在 `WebViewClientCompat` 里是 final。
         * 资源级错误由 `WebViewAssetLoader` 自己记日志（W3 定位白屏靠的就是那条
         * `FileNotFoundException: assets/web/index.html`），这里无需重复。
         */

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
        const val TAG = "WiseShell"
        const val SHELL_DOMAIN = "appassets.androidplatform.net"
        const val CAMERA_PERMISSION_REQUEST = 1001

        /**
         * 页面 origin 用 **https**（安全上下文）。
         *
         * 这条路径改过两次，两边的代价都实测过：
         *  · 最初 https → `ws://` 被判为混合内容拦掉，页面连不上桥；
         *  · 于是退成 http → 页面**不再是安全上下文**，`getUserMedia` 直接不可用
         *    （相机扫码这条路被堵死，且没有任何报错提示）；
         *  · 现在回到 https，并**有意识地**放行混合内容（见 settings.mixedContentMode）——
         *    桥只监听 loopback / 点对点地址，不出本机，这个交换是划算的。
         *
         * 实测（WSA）：`isSecureContext === true`、`navigator.mediaDevices` 可用、
         * `enumerateDevices()` 能列出 videoinput。
         */
        const val SHELL_ORIGIN = "https://appassets.androidplatform.net"
        const val SHELL_INDEX_URL = "$SHELL_ORIGIN/assets/web/index.html"

        /** 静态产物在 APK 里的前缀，与 `WebViewAssetLoader` 的默认约定一致。 */
        const val ASSET_PREFIX = "assets/"

        fun isShellUrl(uri: Uri): Boolean = uri.toString().startsWith(SHELL_ORIGIN)
    }
}

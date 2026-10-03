package com.huicang.wise.client.shell

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.nfc.NfcAdapter
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.huicang.wise.bridge.protocol.BridgeCapabilities
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

    /** WebView 的容器。渲染进程死掉时要把旧 WebView 换成新的，容器让这一步不用重建界面。 */
    private lateinit var root: FrameLayout

    private lateinit var assetLoader: WebViewAssetLoader

    /**
     * NFC 读卡（B3/S3）。
     *
     * **"自动使用"的落点**：`onResume` 开、`onPause` 关 —— 用户不需要点任何东西，
     * 也不需要 Web 来叫它开始（那就成了双所有者：壳以为在扫、Web 以为停了）。
     * 事件（`nfc.tag` / `nfc.state`）经 [ShellBridge.emit] 推给 Web。
     *
     * 注意这里**没有**按 [NFC_READ_VERIFIED] 关掉：本片（S3）的验收就是"真机上能读到"，
     * 而验证的唯一途径是让 reader 真的跑起来（logcat 里的 `[nfc] 读到标签 …`）。
     * 对外**声明**能力是另一件事，由那个开关把关（S4）—— "先实现、后声明"在代码里也是分开的。
     */
    private var nfcReader: NfcReader? = null

    /** 应用是否在前台（`onResume` … `onPause`）。页面加载完成时据此决定要不要补报 NFC 状态。 */
    @Volatile private var nfcForeground = false

    /** 只在首次供给引导时打一行日志，避免每帧刷屏。 */
    @Volatile private var bootstrapServed = false

    /**
     * 上一次把相机交给页面是在什么时候（`elapsedRealtime`，0 = 从来没给过）。
     *
     * 用来判断"渲染进程这次崩，是不是相机干的"：只有崩在刚授权之后的**很短时间内**，
     * 才把账算到相机头上。把两者无限期关联起来会让之后任何一次无关崩溃都顺手废掉扫码。
     */
    @Volatile private var cameraGrantedAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        assetLoader = buildAssetLoader()
        root = FrameLayout(this)
        setContentView(root)
        attachWebView()

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        attachNfcReader()
    }

    /**
     * 造 reader 并挂到 [NfcReaderHost] 上（那里是本机方法 `nfc.openSettings` 的落点）。
     *
     * 构造只做一件有代价的事：取 `NfcAdapter`（很便宜）。真正的 `enableReaderMode`
     * 在 `onResume` 里 —— 那时应用才真的是前台。
     */
    private fun attachNfcReader() {
        val reader =
            NfcReader(
                activity = this,
                onTag = { id, tech, at ->
                    // 这行日志就是 S3 真机验收看的那一行（"进入应用能读到"）
                    android.util.Log.i(TAG, "[nfc] 读到标签 id=$id tech=$tech")
                    ShellBridge.emit(NfcReaderState.EVENT_TAG, NfcReaderState.tagEventPayload(id, tech, at))
                },
                onState = { state ->
                    android.util.Log.i(TAG, "[nfc] 状态：$state")
                    ShellBridge.emit(NfcReaderState.EVENT_STATE, NfcReaderState.stateEventPayload(state))
                },
                log = { android.util.Log.i(TAG, it) },
            )
        nfcReader = reader
        NfcReaderHost.attach(reader)
    }

    /**
     * 回到前台就开始读（brief §3）。
     *
     * 不用 `enableForegroundDispatch` 那种"页面叫一次"的模式，理由见 [NfcReader]：
     * 那条路要过系统的 NDEF 解析链，表现是"读到了但要等几秒"。
     */
    override fun onResume() {
        super.onResume()
        nfcForeground = true
        registerNfcAdapterListener()
        nfcReader?.start()
    }

    /**
     * 离开前台必须关。
     *
     * 不关的后果不是"多费点电"，而是**持着 reader mode 与其它 NFC 应用抢** ——
     * 用户的另一款应用会莫名其妙读不到卡。所以这条与相机停流是同一个规格。
     */
    override fun onPause() {
        nfcForeground = false
        unregisterNfcAdapterListener()
        nfcReader?.stop()
        super.onPause()
    }

    /** 系统 NFC 开关被拨动时重新判定；只在前台挂着（见 [registerNfcAdapterListener]）。 */
    private val nfcAdapterReceiver =
        object : BroadcastReceiver() {
            override fun onReceive(
                context: Context?,
                intent: Intent?,
            ) {
                if (intent?.action != NfcAdapter.ACTION_ADAPTER_STATE_CHANGED) {
                    return
                }
                refreshNfc()
            }
        }

    /** 广播监听是否挂着（`onResume`/`onPause` 成对调用，这里防重复注册与漏注销）。 */
    private var nfcListening = false

    /**
     * 听 `ACTION_ADAPTER_STATE_CHANGED`。
     *
     * **为什么必须有这条广播**：`nfc.state` 原本只在 `onResume` 与"页面加载完成"时报，
     * 而用户从**通知栏那枚开关**拨 NFC 时，Activity 并不会 pause ——
     * 少了这条广播，界面会一直说"请将标签靠近手机背部"（哪怕 NFC 已经关了），
     * 用户贴卡没反应且没有任何提示。
     *
     * 用 `ContextCompat.registerReceiver` 而不是裸 `registerReceiver`：targetSdk 34 起
     * 动态注册必须显式声明导出性，这个兼容方法在各版本上都对（而且不留废弃告警）。
     * `RECEIVER_NOT_EXPORTED` 是正确的选择 —— 我们只收**系统**发的这条广播，
     * 不收别的应用的消息。
     */
    private fun registerNfcAdapterListener() {
        if (nfcListening) {
            return
        }
        ContextCompat.registerReceiver(
            this,
            nfcAdapterReceiver,
            IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        nfcListening = true
    }

    private fun unregisterNfcAdapterListener() {
        if (!nfcListening) {
            return
        }
        nfcListening = false
        // 注销失败不该把 onPause 弄崩（进程正在退出时见过），但它会被记下来
        runCatching { unregisterReceiver(nfcAdapterReceiver) }
            .onFailure { android.util.Log.w(TAG, "[nfc] 注销 NFC 状态广播失败：${it.javaClass.simpleName}") }
    }

    /**
     * 系统里 NFC 被拨动后重新判定 reader 的处置。
     *
     * 判据与"关着时必须先 stop"的理由见 [NfcReaderState.actionAfterAdapterChange] ——
     * 那个 if 看着简单，写错的后果是"再打开 NFC 后贴卡没反应"，所以它被提到了可单测的那一层。
     */
    private fun refreshNfc() {
        val reader = nfcReader ?: return
        android.util.Log.i(TAG, "[nfc] 系统开关变化，重新判定：${reader.availability}")
        when (NfcReaderState.actionAfterAdapterChange(reader.availability)) {
            NfcAdapterChangeAction.RECONNECT -> reader.start()

            NfcAdapterChangeAction.STOP_THEN_REPORT -> {
                reader.stop()
                reader.start()
            }
        }
    }

    /**
     * 页面（重新）加载完成时的 NFC 补报。
     *
     * **为什么需要它**：`nfc.state` 说的是"现在"，而 `ShellBridge.emit` 在桥还没起来时
     * 会**丢弃**它（事件不是要补发的消息）。首次 `onResume` 常常早于桥就绪
     * （桥在 `Application.onCreate` 的后台线程里绑端口），那一条就被丢了 ——
     * 界面会停在默认的"就绪"，而实际系统里 NFC 是关着的：用户贴卡没反应，也没有任何提示。
     * 页面加载完是**唯一一个"Web 已经准备好收事件"的时刻**，在这里补报一次。
     *
     * 顺带覆盖渲染进程崩溃后重建 WebView 的情形（新页面同样会走到这里）。
     */
    private fun warmUpNfc() {
        if (nfcForeground) {
            // start() 幂等：已经在读就只重新报一次状态，不会重复 enableReaderMode
            nfcReader?.start()
        }
    }

    /** 造一个 WebView 并挂上去。渲染进程死掉后重建走的就是这一条。 */
    private fun attachWebView() {
        webView = createWebView()
        root.removeAllViews()
        root.addView(webView)
        webView.loadUrl(SHELL_INDEX_URL)
    }

    private fun createWebView(): WebView =
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
             * 换来的是页面处于**安全上下文**——`getUserMedia`（相机扫码）只在安全上下文里可用。
             */
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            webViewClient = ShellWebViewClient(assetLoader, { view, crashed -> onRendererGone(view, crashed) }) { warmUpNfc() }
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
                        val onlyCamera =
                            request.resources.all { it == android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE }
                        if (!wantsCamera || !onlyCamera || !isShellUrl(request.origin)) {
                            // 只要不是相机（麦克风等），一律拒绝：这个壳不需要那些能力
                            request.deny()
                            return
                        }
                        if (hasCameraPermission()) {
                            grantCamera(request)
                        } else {
                            pendingCameraRequest = request
                            requestCameraPermission()
                        }
                    }
                }
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
        }

    /**
     * 批准网页的相机请求 —— 但**先留下面包屑**。
     *
     * 有些 WebView（实测 WSA 的 122）一开相机就在**本进程**的 GPU 线程里中止，
     * 整个应用进程随之消失，`onRenderProcessGone` 根本没机会被调用。
     * 于是"这次尝试有没有收尾"只能靠事先写下的标记来判断：没被清掉 = 上次是被它带走的。
     * 详见 [CameraSafety]。
     */
    private fun grantCamera(request: android.webkit.PermissionRequest) {
        CameraSafety.beginAttempt(this)
        cameraGrantedAt = SystemClock.elapsedRealtime()
        request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE))
    }

    override fun onDestroy() {
        // 先摘掉 reader 引用再销毁：`NfcReaderHost` 是单例，长期持有一个已经没了的
        // Activity 就是内存泄漏，也会让"去开启"从错误的界面里跳设置页。
        NfcReaderHost.attach(null)
        nfcReader = null
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
            grantCamera(request)
        } else {
            request.deny()
        }
    }

    /**
     * 渲染进程没了 —— 由 [ShellWebViewClient] 转上来，这里是真正的恢复动作。
     *
     * 恢复是**重建一个 WebView 并重新加载**，而不是继续用原来那个：
     * 活下来的 WebView 实例仍然绑在死掉的渲染进程上，之后任何操作都是无响应 ——
     * 用户看到的是"白屏，而且怎么点都没用"，比直接崩掉更难排查。
     *
     * 真机上渲染进程是独立沙箱进程，这条路覆盖的是常态崩溃；
     * 而 WSA 上那次相机崩溃是**进程内** GPU 线程中止，连这个回调都到不了 ——
     * 所以两条路都要有，那条走 [CameraSafety] 的面包屑。
     */
    private fun onRendererGone(
        view: WebView,
        crashed: Boolean,
    ) {
        // 刚把相机交出去就崩 → 这笔账算在相机上，并立刻撤回能力声明：
        // 重建出来的页面不会再画出扫码入口，否则用户点一次崩一次，进死循环。
        val byCamera =
            cameraGrantedAt > 0 && SystemClock.elapsedRealtime() - cameraGrantedAt < CAMERA_BLAME_WINDOW_MS
        if (crashed && byCamera) {
            CameraSafety.markUnusable(this, "授权相机后 ${SystemClock.elapsedRealtime() - cameraGrantedAt}ms 内渲染进程崩溃")
            ShellBridge.revokeCapability(BridgeCapabilities.SCAN_CAMERA, "本机 WebView 打开相机会崩溃")
        }
        android.util.Log.e(TAG, "渲染进程已终止（didCrash=$crashed，疑似相机=$byCamera），正在重建 WebView")
        root.removeView(view)
        view.destroy()
        attachWebView()
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
            /*
             * 放行 http 是 `WebViewAssetLoader` 的开关，而页面**实际走 https**（见 SHELL_ORIGIN）。
             *
             * 两侧的取舍都实测过：
             *  · 页面走 https 而桥是明文 `ws://` → 被判为混合内容拦掉，页面连不上桥；
             *  · 退成 http → 页面**不再是安全上下文**，`getUserMedia` 直接不可用，
             *    而这是**静默**的：没有任何报错，只是"相机用不了"；
             *  · 于是回到 https，并**有意识地**放行混合内容（settings.mixedContentMode）。
             *    桥只监听 loopback / 点对点地址，不出本机，这个交换是划算的。
             *
             * 实测（WSA）：`isSecureContext === true`、`navigator.mediaDevices` 可用、
             * `enumerateDevices()` 能列出 videoinput、`BarcodeDetector` 存在。
             */
            .setHttpAllowed(true)
            .addPathHandler(
                "/",
                object : WebViewAssetLoader.PathHandler {
                    override fun handle(path: String): WebResourceResponse? {
                        // 查询串（防缓存用的 `?_=`）不属于路径，先剥掉再判等
                        val p = path.substringBefore('?')
                        return when (p) {
                            BridgeProtocol.BOOTSTRAP_PATH.removePrefix("/") -> bootstrapResponse()
                            CAMERA_BEGIN_PATH -> cameraBeginResponse()
                            CAMERA_DONE_PATH -> cameraDoneResponse()
                            else ->
                                if (p.startsWith(ASSET_PREFIX)) {
                                    assetsHandler.handle(p.removePrefix(ASSET_PREFIX))
                                } else {
                                    null
                                }
                        }
                    }
                },
            )
            .build()
    }

    /**
     * 页面即将打开相机：[CameraSafety] 记下面包屑。
     *
     * **必须在相机真正打开之前落盘**。反过来的话进程可能已经没了，标记根本没写下去 ——
     * 而这个标记的全部作用就是给"下一次启动"看。
     */
    private fun cameraBeginResponse(): WebResourceResponse {
        CameraSafety.beginAttempt(this)
        return noContent()
    }

    /**
     * 页面收起了取景（扫到了 / 用户取消）：这次从开到关没出事，清掉面包屑。
     *
     * **只有这一条路径会清**。刻意不为"画面出来了"清：实测那台机器上取流成功、
     * 画面也真的出帧，崩在出帧之后 —— 任何进行中的信号都不足以证明这条路是通的。
     * 崩溃时页面发不出这条请求，面包屑就留下了，下次启动据此撤掉扫码入口。
     */
    private fun cameraDoneResponse(): WebResourceResponse {
        CameraSafety.confirmAlive(this)
        return noContent()
    }

    /**
     * 200 + 空体 + 禁缓存。
     *
     * 用 200 而不是 204：204 按语义**不能带实体**，而这里无论如何都要给 `WebResourceResponse`
     * 一个流。回 200 空体是两边都不会误会的写法。
     */
    private fun noContent(): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            200,
            "OK",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0)),
        )

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
        /** 渲染进程终止时的恢复动作；返回值即 `onRenderProcessGone` 的返回值。 */
        private val onGone: (WebView, Boolean) -> Unit,
        /** 页面加载完成（含崩溃后重建的那次）：NFC 状态要在这里补报一次，见 `warmUpNfc`。 */
        private val onLoaded: () -> Unit,
    ) : WebViewClientCompat() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

        /**
         * **返回 true = "我已经处理，别把应用一起杀掉"**；返回默认的 false 会连应用一起终止。
         *
         * `onRenderProcessGone` 是 API 26 加入的，minSdk 25 上系统根本不会调用它 ——
         * 那种机器上行为与本回调存在之前一致（渲染进程崩溃 → 应用退出），
         * 属于已知且可接受的降级，不额外处理。
         */
        override fun onRenderProcessGone(
            view: WebView,
            detail: RenderProcessGoneDetail?,
        ): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                return true
            }
            onGone(view, detail?.didCrash() == true)
            return true
        }

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
            // 页面现在才真的准备好收事件 —— 桥就绪之前丢掉的那条 `nfc.state` 在这里补上
            onLoaded()
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
        ): Boolean = !isShellUrl(Uri.parse(url))

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
         * 授权相机之后多久内崩，才把账算在相机头上。
         *
         * 实测那次：授权到 `SIGTRAP` 约 200ms 量级。给到 10 秒是留出低端机取流更慢的余量；
         * 再放宽就会把"用户扫完码、过一会儿因为别的原因崩了"也算进来。
         */
        const val CAMERA_BLAME_WINDOW_MS = 10_000L

        /** 页面侧的两条存活信号路径（`@wise/scan` 的 useCameraScan 发起）。 */
        const val CAMERA_BEGIN_PATH = "__camera-begin"
        const val CAMERA_DONE_PATH = "__camera-done"

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

        fun isShellUrl(uri: Uri): Boolean =
            uri.scheme == "https" &&
                uri.host == SHELL_DOMAIN &&
                (uri.port == -1 || uri.port == 443)
    }
}

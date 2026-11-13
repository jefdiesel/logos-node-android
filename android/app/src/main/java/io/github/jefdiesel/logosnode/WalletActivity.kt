package io.github.jefdiesel.logosnode

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.concurrent.thread

/**
 * The app's main screen: the web app's own page (the wallet and the node's status), served by its
 * server.py inside this app on 127.0.0.1, in a WebView, with a cream cover while it starts or recovers. The
 * Node screen opens from the page's Settings (web app 0.9.1+, through LogosAndroid.openNode) or, for older
 * web apps and whenever the page is covered, from a Node button.
 */
class WalletActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var web: WebView
    private var fileChosen: ValueCallback<Array<Uri>>? = null
    private var pendingSave: ByteArray? = null
    private val io = java.util.concurrent.Executors.newSingleThreadExecutor()

    /** Fingerprint unlock: the page's window.LogosAndroid.unlockWithFingerprint(), see FingerprintUnlock. */
    private val fingerprint = FingerprintUnlock(
        featureOn = { walletSetting() },
        authenticate = { onDone -> main.post { FingerprintKey.authenticate(this, onDone) } },
        nativeUnlock = { python("native_unlock") },
        turnOff = { python("native_fingerprint_reset") },
        toPage = { js -> main.post { if (FingerprintUnlock.isOwnPage(web.url)) web.evaluateJavascript(js, null) } },
    )

    /** QR scan: the page's window.LogosAndroid.scanQr(), see QrScan. */
    private var scanAnswer: ((QrScan.Result) -> Unit)? = null
    private var cameraAnswer: ((Boolean?) -> Unit)? = null
    private val qr = QrScan(
        cameraAllowed = { checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED },
        askCamera = { onAnswer -> askCamera(onAnswer) },
        openScanner = { onResult ->
            scanAnswer = onResult
            startActivityForResult(Intent(this, ScanActivity::class.java), SCAN_QR)
        },
        pageUrl = { web.url },
        toPage = { js -> web.evaluateJavascript(js, null) },
    )

    /**
     * The camera question, only when the user tapped Scan: one line saying why, then Android's own question.
     * Always through Android's question: when Android has stopped asking (refused for good), it answers
     * "no" at once, and only then is the page told the camera is off. (A one-time grant that ran out, or
     * the question dismissed without an answer, is asked again.)
     */
    private fun askCamera(onAnswer: (Boolean?) -> Unit) {
        var answered = false
        android.app.AlertDialog.Builder(this)
            .setMessage("To scan a QR code the app needs the camera. It uses it only while the scanner is open.")
            .setPositiveButton("Continue") { _, _ ->
                answered = true
                cameraAnswer = onAnswer
                requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
            }
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!answered) onAnswer(null) }
            .show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != CAMERA_REQUEST) return
        val answer = cameraAnswer ?: return
        cameraAnswer = null
        // no result at all: the question was interrupted, a cancel rather than a no
        answer(if (grantResults.isEmpty()) null else grantResults[0] == PackageManager.PERMISSION_GRANTED)
    }

    private fun python(function: String): String? = try {
        com.chaquo.python.Python.getInstance().getModule("logos_embed").callAttr(function)?.toString()
    } catch (e: Exception) {
        Log.e(TAG, "logos_embed.$function failed", e)                 // never holds the token: it failed
        null
    }

    /** native_fingerprint from the wallet's GET /api/wallet; null if it doesn't answer. */
    private fun walletSetting(): Boolean? = try {
        val c = java.net.URL(WalletServer.URL + "api/wallet").openConnection() as java.net.HttpURLConnection
        c.setRequestProperty("Cookie", "${WalletServer.APP_KEY_COOKIE}=${WalletServer.appKey}")
        c.connectTimeout = 2000
        c.readTimeout = 5000
        try {
            org.json.JSONObject(c.inputStream.bufferedReader().readText()).optBoolean("native_fingerprint", false)
        } finally {
            c.disconnect()
        }
    } catch (_: Exception) {
        null
    }

    /** Keeps the Keystore key in step with the setting: made while it is on, deleted when it is off. */
    private fun syncFingerprintKey() = io.execute {
        when (walletSetting()) {
            true -> try { FingerprintKey.ensure() } catch (_: Exception) {}
            false -> FingerprintKey.delete()
            null -> {}
        }
    }

    // ---- the screen: the page, a cream loading cover over it, and the Node button (only when needed) ----

    private lateinit var root: android.widget.FrameLayout
    private lateinit var cover: LinearLayout
    private lateinit var coverText: TextView
    private lateinit var nodeButton: Button
    private val cream by lazy { getColor(R.color.icon_cream) }
    private val ink = Color.rgb(0x14, 0x13, 0x11)
    private var retryMs = WalletPage.FIRST_RETRY_MS

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WalletServer.start(this)
        val dp = resources.displayMetrics.density

        root = android.widget.FrameLayout(this).apply { setBackgroundColor(cream) }
        web = newWebView()
        root.addView(web, android.widget.FrameLayout.LayoutParams(MATCH, MATCH))

        // the loading cover: never a dark or blank screen while the wallet starts, reloads or recovers
        coverText = TextView(this).apply {
            setTextColor(ink); textSize = 16f; gravity = Gravity.CENTER
            setPadding((24 * dp).toInt(), (16 * dp).toInt(), (24 * dp).toInt(), 0)
        }
        cover = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(cream)
            isClickable = true                                   // the page under it can't be touched meanwhile
            addView(android.widget.ImageView(this@WalletActivity).apply {
                setImageResource(R.drawable.ic_launcher_foreground)
            }, LinearLayout.LayoutParams((160 * dp).toInt(), (160 * dp).toInt()))
            addView(coverText)
            addView(Button(this@WalletActivity).apply {
                text = "Node"
                setOnClickListener { openNodeScreen() }
            }, LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = (24 * dp).toInt() })
        }
        root.addView(cover, android.widget.FrameLayout.LayoutParams(MATCH, MATCH))

        // the old way to the Node screen, kept for web apps without a Node row in their Settings (before 0.9.1)
        nodeButton = Button(this).apply {
            text = "Node"
            visibility = View.GONE
            setOnClickListener { openNodeScreen() }
        }
        root.addView(nodeButton, android.widget.FrameLayout.LayoutParams(WRAP, WRAP, Gravity.TOP or Gravity.END))

        Insets.pad(root)                                         // the page starts below the status bar
        setContentView(root)
        setBars(cream)

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        showCover("Starting the wallet…")
        loadWhenReady()
        debugFromIntent(intent)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun newWebView() = WebView(this).apply {
        setBackgroundColor(cream)                                // never a dark default behind the page
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true                        // the page keeps its session in sessionStorage
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        addJavascriptInterface(Bridge(), "LogosAndroid")
        webViewClient = Client()
        webChromeClient = Chrome()
    }

    private fun openNodeScreen() = startActivity(Intent(this, NodeActivity::class.java))

    private fun showCover(text: String) {
        Log.i(TAG, "cover: ${text.lineSequence().first()}")
        coverText.text = text
        cover.visibility = View.VISIBLE
        setBars(cream)
    }

    private fun hideCover() {
        if (cover.visibility == View.VISIBLE) Log.i(TAG, "cover: gone, the page shows")
        cover.visibility = View.GONE
        main.post { runQueuedUnlock() }
    }

    /** The window behind the page (status bar area) in `color`, with status bar icons that read on it. */
    private fun setBars(color: Int) {
        root.setBackgroundColor(color)
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WalletPage.isLight(color)
            window.insetsController?.setSystemBarsAppearance(
                if (light) (android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS) else 0,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            )
        }
    }

    private var waiting = false

    /**
     * Loads the page as soon as the wallet server answers, with the cover up meanwhile. If it doesn't
     * answer, the cover says why (from WalletServer.problem) after 20 s and it keeps trying; the node is
     * not affected either way.
     */
    private fun loadWhenReady() {
        if (waiting) return
        waiting = true
        thread(name = "wallet-wait") {
            var shown = false
            val started = System.currentTimeMillis()
            while (!WalletServer.listening()) {
                val problem = WalletServer.problem
                if (!shown && (problem != null || System.currentTimeMillis() - started > 20_000)) {
                    shown = true
                    val why = problem ?: "It hasn't answered yet (${WalletServer.lastConnectError})."
                    main.post {
                        showCover("The wallet didn't start. $why\n\nThe node is not affected. This screen keeps trying; " +
                            "the full error is in the app's files/wallet/wallet-app.log.")
                    }
                }
                Thread.sleep(500)
            }
            Log.i(TAG, "wallet server answering after ${System.currentTimeMillis() - started} ms")
            main.post {
                // the app key first (android/LOCAL-APIS.md): server.py answers only requests carrying it,
                // and the WebView sends it with every request of the page from then on
                val cookies = CookieManager.getInstance()
                cookies.setAcceptCookie(true)
                cookies.setCookie(WalletServer.URL, WalletServer.appKeyCookie()) { ok ->
                    if (!ok) Log.w(TAG, "the WebView did not take the app key cookie")
                    waiting = false
                    web.loadUrl(WalletServer.URL)
                }
            }
        }
    }

    /** The page failed: cover up, say why, and load it again after a growing pause (1 s up to 10 s). */
    private fun reloadSoon(reason: String) {
        Log.w(TAG, "page: $reason; reloading in $retryMs ms")
        showCover("$reason\nTrying again…")
        main.removeCallbacks(retry)
        main.postDelayed(retry, retryMs)
        retryMs = WalletPage.nextRetry(retryMs)
    }

    private val retry = Runnable { loadWhenReady() }

    /** The renderer died (or was killed): a new WebView, and the page again. */
    private fun replaceWebView(reason: String) {
        Log.w(TAG, "page renderer gone: $reason")
        root.removeView(web)
        try { web.destroy() } catch (_: Exception) {}
        web = newWebView()
        root.addView(web, 0, android.widget.FrameLayout.LayoutParams(MATCH, MATCH))
        backCallback?.let { if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        backCallback = null
        reloadSoon("The page stopped ($reason).")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        debugFromIntent(intent)
    }

    /** Debug builds, from adb: --ez probe true (structure check), --ez crashrenderer true (renderer-loss test). */
    private fun debugFromIntent(intent: Intent?) {
        if (!BuildConfig.DEBUG || intent == null) return
        if (intent.getBooleanExtra("crashrenderer", false)) {
            Log.w(TAG, "debug: crashing the page's renderer on purpose")
            main.postDelayed({ web.loadUrl("chrome://crash") }, 2000)
        }
        if (intent.getBooleanExtra("probe", false) && FingerprintUnlock.isOwnPage(web.url)) {
            main.postDelayed({ web.evaluateJavascript(PROBE) { Log.i(TAG, "probe: $it") } }, 1000)
        }
    }

    private var resumed = false
    private var pendingUnlock = false

    private fun askFingerprint() {
        pendingUnlock = false
        val url = web.url
        io.execute { fingerprint.request(url) }
    }

    /** A fingerprint request the page made while the screen wasn't ready: now, once it is. */
    private fun runQueuedUnlock() {
        if (pendingUnlock && resumed && cover.visibility != View.VISIBLE && FingerprintUnlock.isOwnPage(web.url)) {
            Log.i(TAG, "running the queued fingerprint request")
            askFingerprint()
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        web.onResume()       // the page sees itself visible again (its auto-lock listens for this)
        if (FingerprintUnlock.isOwnPage(web.url)) syncFingerprintKey()
        main.removeCallbacks(watchdog)
        main.postDelayed(watchdog, 10_000)
        main.post { runQueuedUnlock() }
        val nodeFiles = NodeFiles(this)
        thread(name = "open-timer", isDaemon = true) { OpenTimer.measure(nodeFiles) }
    }

    override fun onPause() {
        resumed = false
        web.onPause()        // ... and hidden
        main.removeCallbacks(watchdog)
        super.onPause()
    }


    /** While the screen shows: if the page is up but the wallet stopped answering, cover up and reload. */
    private val watchdog: Runnable = object : Runnable {
        override fun run() {
            val shown = cover.visibility != View.VISIBLE && FingerprintUnlock.isOwnPage(web.url)
            if (shown) {
                io.execute {
                    if (!WalletServer.listening()) main.post { reloadSoon("The wallet stopped answering.") }
                }
            }
            main.postDelayed(this, 10_000)
        }
    }

    /** Whether the page has its own step to go back to (e.g. an open chat), not the "Starting…" placeholder. */
    private fun pageCanGoBack(): Boolean {
        val list = web.copyBackForwardList()
        val i = list.currentIndex
        return i > 0 && isOwnPage(Uri.parse(list.getItemAtIndex(i - 1).url))
    }

    // Android 13+ with a current targetSdk delivers Back through this callback, not onBackPressed. It is
    // registered only while the page has a step to go back to, so Back closes an open chat (the page's own
    // history), and otherwise leaves the app as usual.
    private var backCallback: android.window.OnBackInvokedCallback? = null

    private fun updateBackHandling() {
        if (Build.VERSION.SDK_INT < 33) return
        val want = pageCanGoBack()
        val cb = backCallback
        if (want && cb == null) {
            val c = android.window.OnBackInvokedCallback { if (pageCanGoBack()) web.goBack() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, c)
            backCallback = c
        } else if (!want && cb != null) {
            onBackInvokedDispatcher.unregisterOnBackInvokedCallback(cb)
            backCallback = null
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (pageCanGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    private fun isOwnPage(url: Uri?) =
        url != null && url.scheme == "http" && url.host == "127.0.0.1" && url.port == WalletServer.PORT

    private inner class Client : WebViewClient() {
        // only the wallet's own page opens here; nothing else is loaded
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !isOwnPage(request.url)

        override fun onPageFinished(view: WebView, url: String) {
            if (view !== web || !isOwnPage(Uri.parse(url))) return
            view.evaluateJavascript(SAVE_HOOK, null)
            syncFingerprintKey()
            // the page is only taken as shown once it has content: then the cover goes, the window takes the
            // page's background, and the old Node button shows only for web apps without a Node row in Settings
            view.evaluateJavascript(PAGE_CHECK) { raw ->
                if (view !== web) return@evaluateJavascript
                val check = WalletPage.parseCheck(raw)
                if (check == null || check.children == 0) {
                    reloadSoon("The wallet page came up empty.")
                    return@evaluateJavascript
                }
                retryMs = WalletPage.FIRST_RETRY_MS
                hideCover()
                WalletPage.parseCssColor(check.background)?.let { setBars(it) }
                nodeButton.visibility = if (WalletPage.hasNodeRow(check.version)) View.GONE else View.VISIBLE
                Log.i(TAG, "page shown: web app ${check.version}, ${check.children} elements; " +
                    "Node button ${if (nodeButton.visibility == View.VISIBLE) "shown (no Node row in this web app)" else "hidden (the page's Settings has it)"}")
                if (BuildConfig.DEBUG && intent.getBooleanExtra("probe", false)) {
                    // debug builds started with --ez probe true: the page's structure, in logcat. Never the
                    // page's text (it may show balances, chats or keys): only yes/no facts and element states.
                    main.postDelayed({ view.evaluateJavascript(PROBE) { Log.i(TAG, "probe: $it") } }, 3000)
                }
            }
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            updateBackHandling()                                  // e.g. a chat opened (pushState) or closed
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            Log.w(TAG, "page error ${error.errorCode} ${error.description} for ${request.url} (main frame: ${request.isForMainFrame})")
            if (view === web && request.isForMainFrame) reloadSoon("The wallet page didn't load (${error.description}).")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse) {
            if (view === web && request.isForMainFrame && response.statusCode >= 500) {
                reloadSoon("The wallet answered with an error (${response.statusCode}).")
            }
        }

        // the page's renderer crashed or was killed (e.g. with the wallet's process): never a dead screen
        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            if (view === web) main.post { replaceWebView(if (detail.didCrash()) "it crashed" else "Android stopped it") }
            return true                                          // handled: the app goes on
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            // only the page's warnings and errors, and the debug probe's own lines: never ordinary page logging
            val level = message.messageLevel()
            if (level == ConsoleMessage.MessageLevel.ERROR || level == ConsoleMessage.MessageLevel.WARNING ||
                message.message().startsWith("probe")
            ) {
                Log.i(TAG, "page console $level: ${message.message().take(300)} (${message.sourceId()}:${message.lineNumber()})")
            }
            return true
        }

        // the page's file input (restore a backup): Android's file picker
        override fun onShowFileChooser(
            view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams
        ): Boolean {
            fileChosen?.onReceiveValue(null)
            fileChosen = callback
            return try {
                startActivityForResult(params.createIntent(), PICK_FILE)
                true
            } catch (_: Exception) {
                fileChosen = null
                false
            }
        }
    }

    /** Called from the page (through SAVE_HOOK) when it saves a file, e.g. the wallet backup. */
    /**
     * window.LogosAndroid, on this WebView only. Every call checks that the WebView shows the wallet's
     * own page before doing anything (the WebView loads nothing else, but a call is checked anyway).
     */
    private inner class Bridge {
        /** The Node row in the page's Settings (web app 0.9.1): opens the app's Node screen, nothing else. */
        @JavascriptInterface
        fun openNode() {
            main.post { if (FingerprintUnlock.isOwnPage(web.url)) openNodeScreen() }
        }

        /** The page's fingerprint button (web app 0.7.6). The answer comes back as logosNativeUnlocked/Failed. */
        @JavascriptInterface
        fun unlockWithFingerprint() {
            main.post {
                val own = FingerprintUnlock.isOwnPage(web.url)
                Log.i(TAG, "unlockWithFingerprint called; the wallet's own page: $own")
                if (!own) return@post
                // Android only shows the fingerprint prompt over a resumed, visible screen; a call that comes
                // earlier (the page asks at once on load) waits for that instead of failing silently
                if (!resumed || cover.visibility == View.VISIBLE) {
                    Log.i(TAG, "fingerprint request queued until the screen is resumed and the page shows")
                    pendingUnlock = true
                    return@post
                }
                askFingerprint()
            }
        }

        /**
         * The page's Scan button (web app 0.9.7): the QR scanner. The answer comes back as
         * window.logosScanned(text) or window.logosScanFailed(message); see QrScan.
         */
        @JavascriptInterface
        fun scanQr() {
            main.post {
                Log.i(TAG, "scanQr called; the wallet's own page: ${FingerprintUnlock.isOwnPage(web.url)}")
                qr.request()
            }
        }

        /**
         * Settings > Appearance (web app 0.9.10): the page's background after a theme change, so the window
         * behind it and the system bars' icons match, as they do after each page load (PAGE_CHECK).
         */
        @JavascriptInterface
        fun setTheme(background: String) {
            main.post {
                if (!FingerprintUnlock.isOwnPage(web.url)) return@post
                WalletPage.parseCssColor(background)?.let { setBars(it) }
            }
        }

        /**
         * Settings > Node > Mobile mode: the setting and what it does now, as JSON {mode, profile, pending, now,
         * restart}, from the file the node's service keeps (files/node/mobile-state.json). The default before
         * the service has run once: on.
         */
        @JavascriptInterface
        fun mobileMode(): String =
            (try { NodeFiles(this@WalletActivity).mobileState.readText() } catch (_: Exception) { null })
                ?: org.json.JSONObject().put("mode", MobileMode.DEFAULT.key).put("profile", "").put("pending", false).put("now", "").put("restart", "").toString()

        /** Settings > Node > Mobile mode: on or off. The node's service keeps it; it applies at the node's next start (BATTERY.md). */
        @JavascriptInterface
        fun setMobileMode(mode: String) {
            val m = MobileMode.parse(mode) ?: return
            toNodeService { it.putExtra("mode", m.key) }
        }

        /** Settings > Node > "Restart node now": the service restarts the node on the new setting, or says why not (mobileMode().restart). */
        @JavascriptInterface
        fun restartNode() = toNodeService { it.putExtra("restart", true) }

        private fun toNodeService(extras: (Intent) -> Intent) {
            main.post {
                if (!FingerprintUnlock.isOwnPage(web.url)) return@post
                try {
                    startForegroundService(extras(Intent(this@WalletActivity, NodeService::class.java).setAction(NodeService.ACTION_MOBILE_MODE)))
                } catch (e: Exception) {
                    Log.w(TAG, "mobile mode: couldn't reach the node's service: $e")
                }
            }
        }

        /** Called by SAVE_HOOK when the page saves a file (the wallet backup). */
        @JavascriptInterface
        fun saveFile(name: String, dataUrl: String) {
            val bytes = try {
                Base64.decode(dataUrl.substringAfter(","), Base64.DEFAULT)
            } catch (_: Exception) {
                return
            }
            main.post {
                if (!FingerprintUnlock.isOwnPage(web.url)) return@post
                pendingSave = bytes
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/json")
                    .putExtra(Intent.EXTRA_TITLE, name.ifBlank { "logos-node-wallet-backup.json" })
                startActivityForResult(intent, SAVE_FILE)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            SCAN_QR -> {
                val answer = scanAnswer ?: return
                scanAnswer = null
                val result = ScanActivity.result(resultCode, data)
                // never the scanned text in the log: only what kind of answer it was
                Log.i(TAG, "scan ended: ${result.javaClass.simpleName}")
                answer(result)
            }
            PICK_FILE -> {
                fileChosen?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
                fileChosen = null
            }
            SAVE_FILE -> {
                val bytes = pendingSave
                pendingSave = null
                val uri = data?.data
                if (resultCode != RESULT_OK || uri == null || bytes == null) {
                    Toast.makeText(this, "The file was not saved.", Toast.LENGTH_LONG).show()
                    return
                }
                try {
                    contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
                    Toast.makeText(this, "Saved.", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Toast.makeText(this, "The file could not be saved: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    companion object {
        private const val TAG = "LogosWallet"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

        /** Whether the page has content, its web app version and its background: no page text. */
        private const val PAGE_CHECK = "(function () { var m = document.querySelector('meta[name=\"app-version\"]');" +
            " return JSON.stringify({ v: m ? m.content : '', n: document.body ? document.body.children.length : 0," +
            " bg: document.body ? getComputedStyle(document.body).backgroundColor : '' }); })()"

        /**
         * Debug probe (--ez probe true): the page's structure as yes/no facts and element states, never its
         * text (it may show balances, chats or keys). It looks at the Wallet screen, switches to the Messages
         * tab, waits a second and a half, looks again, and switches back. It opens no chat, unlocks nothing,
         * types nothing, and asks for no fingerprint.
         */
        private val PROBE = """
            (function () {
              const $ = id => document.getElementById(id), shown = e => !!e && !e.hidden && e.offsetParent !== null;
              const r = {};
              try {
                r.version = (document.querySelector('meta[name="app-version"]') || {}).content;
                r.embedded = (document.querySelector('meta[name="app-embedded"]') || {}).content;
                r.bridge = typeof window.LogosAndroid;
                r.viewport = (document.querySelector('meta[name="viewport"]') || {}).content;
                r.vvhSet = !!getComputedStyle(document.documentElement).getPropertyValue("--vvh").trim();
                r.navShown = shown($("nav"));
                r.navButtons = $("nav") ? [...$("nav").querySelectorAll("button")].map(b => b.id) : [];
                r.walletScreenShown = shown($("page-main"));
                // the full-screen lock (web app 0.9.2): only it, with the PIN field, while locked
                r.lockShown = shown($("lock"));
                r.lockForm = shown($("v-locked"));
                r.pinField = !!$("pin");
                r.fingerprintButtonShown = shown($("b-fp"));
                r.messagesScreenShown = shown($("page-msg"));
                // the old "Logos node / running on this device" header (gone in web app 0.9.3): yes/no only
                const visible = document.body ? document.body.innerText : "";
                r.logosNodeVisible = visible.includes("Logos node");
                r.runningOnDeviceVisible = visible.includes("running on this device");
                r.topHeaderShown = shown(document.querySelector("body > header, header"));
                if (r.lockShown) {
                  // the lock screen's own headings and header: app wording, never wallet content
                  r.lockHeaderText = [...$("lock").querySelectorAll("header, h1, h2")].filter(shown)
                    .map(e => e.innerText.trim().slice(0, 80));
                  return JSON.stringify(r);                       // locked: don't touch the tabs
                }
                const msg = $("nav-msg");
                if (msg) msg.click();
                setTimeout(() => {
                  const m = {};
                  try {
                    m.messagesScreenShown = shown($("page-msg"));
                    m.walletScreenHidden = !shown($("page-main"));
                    m.visibleSections = ["mg-locked", "mg-nokey", "mg-home", "mg-newv", "mg-mev"].filter(id => shown($(id)));
                    const page = $("page-msg");
                    // whether a 20+ character hex run is visible anywhere on the Messages screen (yes/no only)
                    m.longHexVisible = page ? /[0-9a-fA-F]{20,}/.test(page.innerText) : null;
                    m.chatOpen = !!document.querySelector("#page-msg .cv, .cv");
                  } catch (e) { m.error = String(e); }
                  console.log("probe messages: " + JSON.stringify(m));
                  const w = $("nav-wallet"); if (w) w.click();
                }, 1500);
              } catch (e) { r.error = String(e); }
              return JSON.stringify(r);
            })()
        """.trimIndent()
        private const val PICK_FILE = 1
        private const val SAVE_FILE = 2
        private const val SCAN_QR = 3
        private const val CAMERA_REQUEST = 4

        /**
         * A WebView ignores the page's way of saving a file (a link to a Blob, clicked). This catches
         * that click and hands the file to the app, which asks where to save it. Reads the Blob in the
         * page (no network), so the page's Content-Security-Policy is not involved.
         */
        private val SAVE_HOOK = """
            (function () {
              if (window.__logosSaveHook) return;
              window.__logosSaveHook = true;
              const blobs = new Map();
              const create = URL.createObjectURL.bind(URL);
              URL.createObjectURL = function (b) { const u = create(b); if (b instanceof Blob) blobs.set(u, b); return u; };
              const click = HTMLAnchorElement.prototype.click;
              HTMLAnchorElement.prototype.click = function () {
                const b = this.href && blobs.get(this.href);
                if (!b || !this.download) return click.call(this);
                const name = this.download, r = new FileReader();
                r.onload = () => LogosAndroid.saveFile(name, String(r.result));
                r.readAsDataURL(b);
              };
            })();
        """.trimIndent()
    }
}

/** Keeps a screen's content clear of the status and navigation bars (edge-to-edge on Android 15+). */
object Insets {
    fun pad(view: View) {
        if (Build.VERSION.SDK_INT < 30) return
        view.setOnApplyWindowInsetsListener { v, insets ->
            val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            insets
        }
    }
}

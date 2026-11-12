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
 * server.py inside this app on 127.0.0.1, in a WebView. A bar above it leads to the Node screen.
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

    private fun python(function: String): String? = try {
        com.chaquo.python.Python.getInstance().getModule("logos_embed").callAttr(function)?.toString()
    } catch (e: Exception) {
        Log.e(TAG, "logos_embed.$function failed", e)                 // never holds the token: it failed
        null
    }

    /** native_fingerprint from the wallet's GET /api/wallet; null if it doesn't answer. */
    private fun walletSetting(): Boolean? = try {
        val c = java.net.URL(WalletServer.URL + "api/wallet").openConnection() as java.net.HttpURLConnection
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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WalletServer.start(this)
        val dark = getColor(R.color.page_dark)
        val pad = (8 * resources.displayMetrics.density).toInt()

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(dark)
            setPadding(pad * 2, 0, pad, 0)
            addView(TextView(this@WalletActivity).apply {
                text = getString(R.string.app_name)
                setTextColor(Color.WHITE)
                textSize = 16f
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(Button(this@WalletActivity).apply {
                text = "Node"
                setOnClickListener { startActivity(Intent(this@WalletActivity, NodeActivity::class.java)) }
            })
        }
        web = WebView(this).apply {
            setBackgroundColor(dark)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true          // the page keeps its session in sessionStorage
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(Bridge(), "LogosAndroid")
            webViewClient = Client()
            webChromeClient = Chrome()
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(dark)
            addView(bar)
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        Insets.pad(root)
        setContentView(root)

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        loadWhenReady()
    }

    private var waiting = false

    private fun message(html: String) = web.loadDataWithBaseURL(
        null, "<body style='background:#11110f;color:#ddd;font:16px sans-serif;padding:24px'>$html</body>",
        "text/html", "utf-8", null
    )

    /**
     * Shows a short wait, then the page as soon as the wallet server answers. If it doesn't, says
     * why (from WalletServer.problem) and keeps trying; the node is not affected either way.
     */
    private fun loadWhenReady() {
        if (waiting) return
        waiting = true
        message("Starting the wallet&hellip;")
        thread(name = "wallet-wait") {
            var shown = false
            val started = System.currentTimeMillis()
            while (!WalletServer.listening()) {
                val problem = WalletServer.problem
                if (!shown && (problem != null || System.currentTimeMillis() - started > 20_000)) {
                    shown = true
                    val why = android.text.Html.escapeHtml(problem ?: "It hasn't answered yet (${WalletServer.lastConnectError}).")
                    main.post {
                        message("The wallet didn't start. $why<br><br>The node is not affected. This screen keeps trying; " +
                            "the full error is in the app's files/wallet/wallet-app.log.")
                    }
                }
                Thread.sleep(500)
            }
            Log.i(TAG, "wallet server answering after ${System.currentTimeMillis() - started} ms")
            main.post {
                waiting = false
                web.loadUrl(WalletServer.URL)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        web.onResume()       // the page sees itself visible again (its auto-lock listens for this)
        if (FingerprintUnlock.isOwnPage(web.url)) syncFingerprintKey()
    }

    override fun onPause() {
        web.onPause()        // ... and hidden
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    private fun isOwnPage(url: Uri?) =
        url != null && url.scheme == "http" && url.host == "127.0.0.1" && url.port == WalletServer.PORT

    private inner class Client : WebViewClient() {
        // only the wallet's own page opens here; nothing else is loaded
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !isOwnPage(request.url)

        override fun onPageFinished(view: WebView, url: String) {
            if (!isOwnPage(Uri.parse(url))) return
            view.evaluateJavascript(SAVE_HOOK, null)
            syncFingerprintKey()
            if (BuildConfig.DEBUG) {
                // debug builds: what the page shows, in logcat, so it can be checked without the screen
                main.postDelayed({
                    view.evaluateJavascript("document.body.innerText.replace(/\\s+/g,' ').slice(0,1500)") {
                        Log.i(TAG, "page text: $it")
                    }
                    // started with --ez probe true: the embedded-mode checks, and one fingerprint request
                    // (with fingerprint unlock off it must fail without a prompt). Never logs a token.
                    if (intent.getBooleanExtra("probe", false)) {
                        view.evaluateJavascript(PROBE) { Log.i(TAG, "probe: $it") }
                        view.evaluateJavascript(PROBE_UNLOCK, null)
                    }
                }, 8000)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            Log.w(TAG, "page error ${error.errorCode} ${error.description} for ${request.url} (main frame: ${request.isForMainFrame})")
            if (request.isForMainFrame) main.postDelayed({ loadWhenReady() }, 1000)
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            Log.i(TAG, "page console ${message.messageLevel()}: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
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
        /** The page's fingerprint button (web app 0.7.6). The answer comes back as logosNativeUnlocked/Failed. */
        @JavascriptInterface
        fun unlockWithFingerprint() {
            main.post {
                val url = web.url
                io.execute { fingerprint.request(url) }
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

        /** Debug probe: the page's embedded mode, the bridge, and the Updates section (logged, see onPageFinished). */
        private val PROBE = """
            (function () {
              const r = {}, $ = id => document.getElementById(id);
              try {
                r.meta = document.querySelector('meta[name="app-embedded"]').content;
                r.bridge = typeof window.LogosAndroid;
                r.bridgeMethods = window.LogosAndroid ? Object.keys(Object.getPrototypeOf(window.LogosAndroid) || {}).concat(Object.keys(window.LogosAndroid)) : [];
                r.EMBEDDED = typeof EMBEDDED === "undefined" ? "n/a" : EMBEDDED;
                r.NATIVE = typeof NATIVE === "undefined" ? "n/a" : NATIVE;
                r.updatesText = $("upd-embedded") && !$("upd-embedded").hidden ? $("upd-embedded").textContent : "(hidden)";
                r.updateControlsHidden = ["upd", "b-upd-check", "m-upd-check", "upd-src"].every(id => !$(id) || $(id).hidden);
                r.footer = ($("footer-talk") || {}).textContent;
              } catch (e) { r.error = String(e); }
              return JSON.stringify(r);
            })()
        """.trimIndent()

        /** Debug probe: one fingerprint request, with the page's answer logged to the console (never the token). */
        private val PROBE_UNLOCK = """
            (function () {
              const failed = window.logosNativeUnlockFailed, unlocked = window.logosNativeUnlocked;
              window.logosNativeUnlockFailed = m => { console.log("probe: unlock failed: " + m); window.logosNativeUnlockFailed = failed; failed && failed(m); };
              window.logosNativeUnlocked = t => { console.log("probe: unlocked (token not logged)"); window.logosNativeUnlocked = unlocked; unlocked(t); };
              window.LogosAndroid.unlockWithFingerprint();
            })()
        """.trimIndent()
        private const val PICK_FILE = 1
        private const val SAVE_FILE = 2

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

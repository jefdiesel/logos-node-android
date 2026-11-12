package io.github.jefdiesel.logosnode

import android.app.Application
import android.content.Context
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * The app runs in two processes. The main one holds the node's service and the Node screen. The
 * ":wallet" one holds the wallet screen and the wallet server (Python), so that nothing that goes
 * wrong in the wallet can take the node down.
 */
class LogosApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (getProcessName().endsWith(WalletServer.PROCESS_SUFFIX)) WalletServer.start(this)
    }
}

object WalletServer {
    /** The embedded wallet's port. The Linux Terminal route uses 8090, so both fit on one phone. */
    const val PORT = 18190
    const val URL = "http://127.0.0.1:$PORT/"
    const val PROCESS_SUFFIX = ":wallet"
    private const val TAG = "LogosWallet"
    @Volatile private var started = false

    /** What went wrong starting the wallet in this process, for the wallet screen; null if nothing. */
    @Volatile var problem: String? = null

    fun dataDir(context: Context) = File(context.filesDir, "wallet")

    /** files/wallet/wallet-app.log: what the app did to start the wallet, and any error in full. */
    fun logFile(context: Context) = File(dataDir(context), "wallet-app.log")

    /** files/wallet/server-crash.log: written by logos_embed.py if server.py stops with an error. */
    fun crashFile(context: Context) = File(dataDir(context), "server-crash.log")

    fun start(context: Context) {
        if (started) return
        started = true
        val app = context.applicationContext
        thread(name = "wallet-start") {
            val t0 = System.currentTimeMillis()
            try {
                dataDir(app).mkdirs()
                log(app, "starting the wallet (app ${BuildConfig.VERSION_NAME}, web app ${BuildConfig.WEB_APP_VERSION})")
                val files = NodeFiles(app)
                files.mkdirs()
                files.linkBinary()
                val web = extractWebApp(app)
                if (!Python.isStarted()) Python.start(AndroidPlatform(app))
                log(app, "Python started in ${System.currentTimeMillis() - t0} ms")
                val env = JSONObject(
                    mapOf(
                        "APP_PORT" to PORT.toString(),
                        "APP_DATA" to dataDir(app).path,
                        "NODE_API" to "http://127.0.0.1:${NodeFiles.API_PORT}",
                        "NODE_BIN" to files.launcher.path,
                        "NODE_CFG" to files.config.path,
                        // the node's service restarts the node when it exits, so stopping it is a restart
                        "NODE_RESTART_CMD" to "pkill -TERM -f '${files.launcher.name} ${files.config.name}'",
                        // the web app's Android mode (0.7.6): no self-update or restart, the app's
                        // fingerprint check instead of passkeys, and the page's texts for the app
                        "APP_EMBEDDED" to "android",
                    )
                ).toString()
                Python.getInstance().getModule("logos_embed").callAttr("start", web.path, env)
                log(app, "server.py started from ${web.path}")
                watchMessaging(app)
            } catch (e: Throwable) {
                fail(app, "the wallet did not start: $e", e)
                return@thread
            }
            // say in the log whether it came up, and if not, why
            val until = System.currentTimeMillis() + 60_000
            while (!listening() && System.currentTimeMillis() < until) Thread.sleep(250)
            if (listening()) {
                log(app, "the wallet answers on $URL, ${System.currentTimeMillis() - t0} ms after starting")
            } else {
                val crash = crashFile(app).takeIf { it.exists() }?.readText()?.trim()?.lines()?.lastOrNull()
                fail(app, "the wallet does not answer on $URL after 60 s (${lastConnectError ?: "no answer"})" +
                    (crash?.let { "; server.py stopped with: $it" } ?: ""), null)
            }
        }
    }

    /**
     * WAKU_API for the web app: set while the messaging node runs (the node service, in the main process,
     * writes files/waku/state.txt), removed while it doesn't. Checked every 5 seconds.
     */
    private fun watchMessaging(context: Context) {
        val state = MessagingFiles(File(context.filesDir, "waku")).state
        thread(name = "wallet-waku-env", isDaemon = true) {
            var last: Boolean? = null
            while (true) {
                val running = try { state.readText().trim() == "running" } catch (_: Exception) { false }
                if (running != last) {
                    try {
                        Python.getInstance().getModule("logos_embed")
                            .callAttr("set_env", "WAKU_API", if (running) MessagingSettings.WAKU_API else null)
                        log(context, if (running) "WAKU_API set: the messaging node runs" else "WAKU_API unset")
                    } catch (e: Exception) {
                        log(context, "couldn't set WAKU_API: $e")
                    }
                    last = running
                }
                Thread.sleep(5000)
            }
        }
    }

    private fun fail(context: Context, message: String, e: Throwable?) {
        problem = message
        log(context, "ERROR " + message + (e?.let { "\n" + Log.getStackTraceString(it) } ?: ""))
        Log.e(TAG, message, e)
    }

    @Synchronized
    fun log(context: Context, message: String) {
        Log.i(TAG, message)
        try {
            val f = logFile(context)
            f.parentFile?.mkdirs()
            if (f.length() > 256 * 1024) f.renameTo(File(f.path + ".1"))
            val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
            f.appendText("$time $message\n")
        } catch (_: Exception) {
        }
    }

    /** For the Node screen (another process): the wallet's state, from its port and its log. */
    fun describe(context: Context): String {
        if (listening()) return "Wallet: answering on 127.0.0.1:$PORT"
        val last = try {
            logFile(context).readLines().lastOrNull { it.isNotBlank() && !it.startsWith(" ") && !it.startsWith("\t") }
        } catch (_: Exception) {
            null
        }
        return if (last != null && last.contains("ERROR")) {
            "Wallet: did not start. ${last.substringAfter("ERROR ").take(300)}\n(full error: files/wallet/wallet-app.log)"
        } else {
            "Wallet: not running (it starts when the app's wallet screen opens)"
        }
    }

    @Volatile var lastConnectError: String? = null

    /** Whether the server answers on its port. */
    fun listening(): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", PORT), 1000) }
        lastConnectError = null
        true
    } catch (e: Exception) {
        lastConnectError = e.toString()
        false
    }

    /**
     * Copies assets/webapp (the repository's app/ folder at build time) to files/webapp, fresh for
     * every installed build, so server.py finds index.html and names/ beside it as on Linux.
     */
    private fun extractWebApp(context: Context): File {
        val dir = File(context.filesDir, "webapp")
        val stamp = File(dir, ".installed-build")
        val build = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (stamp.exists() && stamp.readText() == build) return dir
        dir.deleteRecursively()
        copyAssets(context, "webapp", dir)
        stamp.writeText(build)
        return dir
    }

    private fun copyAssets(context: Context, path: String, to: File) {
        val children = context.assets.list(path).orEmpty()
        if (children.isEmpty()) {
            to.parentFile?.mkdirs()
            context.assets.open(path).use { input -> to.outputStream().use { input.copyTo(it) } }
            return
        }
        to.mkdirs()
        for (child in children) copyAssets(context, "$path/$child", File(to, child))
    }
}

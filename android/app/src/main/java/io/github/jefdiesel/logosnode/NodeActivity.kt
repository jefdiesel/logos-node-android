package io.github.jefdiesel.logosnode

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** The Node screen: Start and Stop, the node's status from its own API, and the end of its log. */
class NodeActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var files: NodeFiles
    private lateinit var log: NodeLog
    private lateinit var processView: TextView
    private lateinit var statusView: TextView
    private lateinit var logView: TextView
    private lateinit var snapshotView: TextView
    private lateinit var revertButton: Button
    private lateinit var messagingSwitch: android.widget.Switch
    private lateinit var messagingView: TextView

    private fun setMessaging(key: String, on: Boolean) {
        NodeService.messagingPrefs(this).edit().putBoolean(key, on).apply()
        // the service re-checks the switches; it starts itself if needed (it stops again when nothing runs)
        if (NodeService.messagingPrefs(this).getBoolean("enabled", false) || NodeService.messaging?.running == true) {
            startForegroundService(Intent(this, NodeService::class.java).setAction(NodeService.ACTION_MESSAGING))
        }
        io.execute { update() }
    }

    /** The messaging node's state, memory and data use, for the screen. */
    private fun messagingText(): String {
        val enabled = NodeService.messagingPrefs(this).getBoolean("enabled", false)
        val m = NodeService.messaging
        val usage = NodeService.messagingUsage ?: DataUsage(MessagingFiles(java.io.File(filesDir, "waku")).usage)
        val today = "Today: ${MessagingPolicy.mb(usage.todayTotal())} of ${MessagingPolicy.mb(MessagingSettings.DAILY_CAP_BYTES)}" +
            " (${MessagingPolicy.mb(usage.todayIn)} in, ${MessagingPolicy.mb(usage.todayOut)} out)."
        if (m == null || (!m.running && !enabled)) return "Off. $today"
        val blocker = NodeService.messagingBlocker
        val state = if (!m.running && blocker != null && blocker != "off") "stopped: $blocker" else m.state
        val s = m.status
        val lines = mutableListOf("State: $state")
        if (m.running) {
            s.rssKb?.let { lines += "Memory: ${it / 1024} MB" }
            lines += "Since start: ${s.bytesIn?.let { MessagingPolicy.mb(it) } ?: "?"} in, ${s.bytesOut?.let { MessagingPolicy.mb(it) } ?: "?"} out"
            if (s.inPerMinute != null && s.outPerMinute != null) {
                lines += "Now: ${MessagingPolicy.mb(s.inPerMinute)}/min in, ${MessagingPolicy.mb(s.outPerMinute)}/min out"
            }
            lines += "API on ${MessagingSettings.WAKU_API}"
        }
        lines += today
        return lines.joinToString("\n")
    }
    private var visible = false

    companion object {
        private const val PICK_SNAPSHOT = 7
    }

    private val refresh = object : Runnable {
        override fun run() {
            if (!visible) return
            io.execute { update() }
            main.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        files = NodeFiles(this)
        log = NodeLog(files.output)
        setContentView(layout().also { Insets.pad(it) })
        // an import cut short by the app being killed, while the node service isn't running: tidy it now
        if (!NodeService.active && !NodeService.importRunning) {
            io.execute {
                StateSwap(files.home).recover()?.let { msg ->
                    try { files.importStatus.writeText(msg) } catch (_: Exception) {}
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        visible = true
        main.post(refresh)
    }

    override fun onPause() {
        visible = false
        main.removeCallbacks(refresh)
        super.onPause()
    }

    private fun layout(): ScrollView {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun text(size: Float, value: String = "") = TextView(this).apply {
            textSize = size
            text = value
            setPadding(0, pad / 2, 0, pad / 2)
            setTextIsSelectable(true)
        }
        column.addView(text(22f, "Node"))
        column.addView(
            text(
                14f,
                "This app is Names Wallet. It runs a Logos blockchain node on this phone: the official release, " +
                    "${BuildConfig.NODE_VERSION}. A fresh install " +
                    "syncs the chain from its first block, and that cannot finish on a phone: the node's memory grows " +
                    "with the chain during the first sync. Start it from a snapshot instead: a tar of a synced node's " +
                    "database, made as the project's docs/start-from-a-synced-database.md describes."
            )
        )
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        buttons.addView(Button(this).apply {
            text = "Start"
            setOnClickListener {
                startForegroundService(Intent(this@NodeActivity, NodeService::class.java).setAction(NodeService.ACTION_START))
                io.execute { update() }
            }
        })
        buttons.addView(Button(this).apply {
            text = "Stop"
            setOnClickListener {
                if (NodeService.active) {
                    startService(Intent(this@NodeActivity, NodeService::class.java).setAction(NodeService.ACTION_STOP))
                }
                io.execute { update() }
            }
        })
        column.addView(buttons)
        processView = text(16f).also { column.addView(it) }
        statusView = text(16f).also { column.addView(it) }

        column.addView(text(18f, "Snapshot"))
        snapshotView = text(14f).also { column.addView(it) }
        column.addView(Button(this).apply {
            text = "Start from a snapshot"
            setOnClickListener {
                if (NodeService.importRunning) return@setOnClickListener
                val pick = Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")                                   // Downloads often types a tar as octet-stream
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                @Suppress("DEPRECATION") startActivityForResult(pick, PICK_SNAPSHOT)
            }
        })
        revertButton = Button(this).apply {
            text = "Go back to the previous state"
            visibility = android.view.View.GONE
            setOnClickListener { confirmRevert() }
        }.also { column.addView(it) }

        column.addView(text(18f, "Messaging node"))
        column.addView(
            text(
                13f,
                "The Logos Messaging (Waku) node relays other people's messages on the network, so it uses a lot " +
                    "of data. It runs only on Wi-Fi or another unmetered network unless you allow mobile data, and stops " +
                    "for the day at ${MessagingPolicy.mb(MessagingSettings.DAILY_CAP_BYTES)}."
            )
        )
        val prefs = NodeService.messagingPrefs(this)
        messagingSwitch = android.widget.Switch(this).apply {
            text = "Messaging node"
            isChecked = prefs.getBoolean("enabled", false)
            setOnCheckedChangeListener { _, on -> setMessaging("enabled", on) }
        }.also { column.addView(it) }
        android.widget.Switch(this).apply {
            text = "Also use mobile data"
            isChecked = prefs.getBoolean("mobile", false)
            setOnCheckedChangeListener { _, on -> setMessaging("mobile", on) }
        }.also { column.addView(it) }
        messagingView = text(14f).also { column.addView(it) }
        column.addView(text(14f, "Log (full log: files/node/output.log)"))
        logView = text(11f).apply { typeface = Typeface.MONOSPACE }.also { column.addView(it) }
        column.addView(
            text(
                11f,
                "Node binary: ${BuildConfig.NODE_VERSION} (${BuildConfig.NODE_VARIANT}), sha256 ${BuildConfig.NODE_SHA256}\n" +
                    "App ${BuildConfig.VERSION_NAME}, wallet ${BuildConfig.WEB_APP_VERSION}. Node API on " +
                    "127.0.0.1:${NodeFiles.API_PORT}, wallet on 127.0.0.1:${WalletServer.PORT}."
            )
        )
        return ScrollView(this).apply { addView(column, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) }
    }

    /** Runs on the io thread; posts the result to the screen. */
    private fun update() {
        val pids = NodeProcesses.pids()
        val processText = if (pids.isEmpty()) {
            "Node process: not running (service: ${NodeService.status})"
        } else {
            "Node process: running, " + pids.joinToString { "pid $it, ${NodeProcesses.rssMb(it) ?: "?"} MB" } +
                " (service: ${NodeService.status})"
        }
        val replay = ReplayInfo.summary(
            try { files.replayInfo.readLines().filter { it.isNotBlank() } } catch (_: Exception) { emptyList() },
            BuildConfig.NODE_VARIANT,
        )
        val statusText = (if (pids.isEmpty()) "" else nodeStatus()) +
            (if (replay.isEmpty()) "" else "\n\nLast start:\n" + replay.joinToString("\n"))
        val walletText = WalletServer.describe(this)
        val logText = log.tail(40)
        val snapshotText = snapshotText()
        val messagingText = messagingText()
        val previous = files.previousState
        val previousLabel = if (previous.isDirectory && !NodeService.importRunning) {
            "Go back to the previous state (from " +
                java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(java.util.Date(previous.lastModified())) + ")"
        } else null
        main.post {
            processView.text = processText + (if (NodeService.mobileSummary.isEmpty()) "" else "\n" + NodeService.mobileSummary) + "\n" + walletText
            statusView.text = statusText
            logView.text = logText
            snapshotView.text = snapshotText
            messagingView.text = messagingText
            revertButton.visibility = if (previousLabel != null) android.view.View.VISIBLE else android.view.View.GONE
            if (previousLabel != null) revertButton.text = previousLabel
        }
    }

    /** The last import or go-back, and what the node is doing with the state now (from its log). */
    private fun snapshotText(): String {
        val last = try {
            files.importStatus.readText().trim()
        } catch (_: Exception) {
            ""
        }
        val tail = log.tail(400)
        val found = Regex("found (\\d+) stored blocks to replay").findAll(tail).lastOrNull()?.groupValues?.get(1)
        val replayed = Regex("(\\d+) blocks replayed").findAll(tail).lastOrNull()
        val replay = when {
            found == null -> ""
            replayed == null || replayed.range.first < tail.lastIndexOf("found $found stored blocks") -> "\nThe node is replaying $found saved blocks."
            else -> "\nThe node replayed ${replayed.groupValues[1]} saved blocks; its height is above."
        }
        return (if (NodeService.importRunning) "Running: " else "") +
            last.ifEmpty { "No snapshot imported yet. The node's state now: ${if (files.state.isDirectory) "present" else "none"}." } + replay
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        if (requestCode != PICK_SNAPSHOT || resultCode != RESULT_OK || uri == null) return
        val name = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: uri.lastPathSegment
        android.app.AlertDialog.Builder(this)
            .setTitle("Start from this snapshot?")
            .setMessage(
                "$name\n\nThe node's database is replaced by the one in this file. The node is stopped for the swap " +
                    "and started again. Its keys and settings are not touched, and the current database is kept so you " +
                    "can go back. You trust whoever made the snapshot for the history up to it."
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Import") { _, _ ->
                try {
                    contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (_: Exception) {
                }
                startForegroundService(
                    Intent(this, NodeService::class.java).setAction(NodeService.ACTION_IMPORT).setData(uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                )
                io.execute { update() }
            }
            .show()
    }

    private fun confirmRevert() {
        android.app.AlertDialog.Builder(this)
            .setTitle("Go back to the previous state?")
            .setMessage(
                "The node is stopped, its current database and the previous one swap places, and it starts again. " +
                    "You can swap back the same way."
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Go back") { _, _ ->
                startForegroundService(Intent(this, NodeService::class.java).setAction(NodeService.ACTION_REVERT))
                io.execute { update() }
            }
            .show()
    }

    private fun nodeStatus(): String = try {
        val info = JSONObject(get("/cryptarchia/info"))
        val c = info.optJSONObject("cryptarchia_info") ?: info
        val net = try {
            JSONObject(get("/network/info"))
        } catch (_: Exception) {
            null
        }
        val peers = net?.optJSONArray("connected_peers")?.length()?.toString()
            ?: net?.opt("n_peers")?.toString() ?: "?"
        "Block height: ${c.opt("height")}\nState: ${c.opt("state")}\nPhase: ${info.opt("phase")}\nPeers: $peers"
    } catch (e: Exception) {
        "Node API not answering yet (${e.javaClass.simpleName}: ${e.message})"
    }

    private fun get(path: String): String {
        val c = URL("http://127.0.0.1:${NodeFiles.API_PORT}$path").openConnection() as HttpURLConnection
        c.connectTimeout = 2000
        c.readTimeout = 3000
        return try {
            c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }
}

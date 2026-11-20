package io.github.jefdiesel.logosnode

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
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
import java.util.concurrent.Executors

/**
 * The Node screen: Start and Stop, the node's status from its own API, and the end of its log. Only while the wallet is
 * unlocked (NodeGate, asking the wallet server through WalletLock): it closes when entered locked, drops to a read-only
 * status view when the wallet locks while it shows, and asks again before every action.
 */
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
    private lateinit var mobileSwitch: android.widget.Switch
    private var syncing = false
    private lateinit var messagingView: TextView
    private lateinit var content: ScrollView
    private lateinit var lockedNote: TextView
    /** Everything but the read-only status: hidden while locked (NodeGate.Screen.READ_ONLY). */
    private val controls = mutableListOf<android.view.View>()
    private var dialog: android.app.AlertDialog? = null
    private val gate = NodeGate { WalletLock.ask(this) }

    /** Shows the screen as the gate says: everything, the read-only status, or nothing (closes). On the main thread. */
    private fun show(screen: NodeGate.Screen) {
        if (isFinishing || isDestroyed) return
        when (screen) {
            NodeGate.Screen.CLOSE -> {
                dialog?.dismiss(); dialog = null
                content.visibility = android.view.View.INVISIBLE
                finish()
            }
            NodeGate.Screen.READ_ONLY -> {
                dialog?.dismiss(); dialog = null
                controls.forEach { it.visibility = android.view.View.GONE }
                revertButton.visibility = android.view.View.GONE
                logView.text = ""
                lockedNote.visibility = android.view.View.VISIBLE
                content.visibility = android.view.View.VISIBLE
            }
            NodeGate.Screen.FULL -> {
                // the switches as stored (a press refused while locked left them as pressed)
                val prefs = NodeService.messagingPrefs(this)
                syncing = true
                messagingSwitch.isChecked = prefs.getBoolean("enabled", false)
                mobileSwitch.isChecked = prefs.getBoolean("mobile", false)
                syncing = false
                controls.forEach { it.visibility = android.view.View.VISIBLE }
                lockedNote.visibility = android.view.View.GONE
                content.visibility = android.view.View.VISIBLE
            }
        }
    }

    /** Runs [action] on the main thread only if the wallet is unlocked right now (asked off the main thread). */
    private fun guarded(action: () -> Unit) {
        io.execute {
            val ok = gate.allowed()
            main.post { if (ok && !isFinishing) action() else show(gate.screen) }
        }
    }

    private fun setMessaging(key: String, on: Boolean) = guarded {
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
            lines += "API on its own socket in the app's files (no TCP port)"
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
            io.execute {
                val screen = gate.refresh()                 // the wallet may have locked meanwhile
                // still in the app: the wallet's own screen went away (it reported "hidden"), this one is in front
                if (screen == NodeGate.Screen.FULL) WalletLock.report(this@NodeActivity, "visible")
                main.post { show(screen) }
                if (screen != NodeGate.Screen.CLOSE) update()
            }
            main.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        files = NodeFiles(this)
        log = NodeLog(files.output)
        content = layout().also { Insets.pad(it) }
        content.visibility = android.view.View.INVISIBLE    // nothing shows until the wallet says it is unlocked
        setContentView(content)
        io.execute { val screen = gate.enter(); main.post { show(screen) } }
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
        // entered again (back from another app, the screen on, the file picker): locked means closed
        io.execute {
            val screen = gate.enter()
            main.post {
                show(screen)
                if (screen == NodeGate.Screen.FULL && visible) {
                    main.removeCallbacks(refresh)
                    main.post(refresh)
                }
            }
        }
    }

    override fun onPause() {
        visible = false
        main.removeCallbacks(refresh)
        super.onPause()
    }

    override fun onStop() {
        // left the app from here (Home, the screen off, another app): the wallet's minute starts. Not when going back
        // to the wallet's own screen (finishing): that screen reports for itself.
        if (!isFinishing && gate.screen == NodeGate.Screen.FULL) io.execute { WalletLock.report(this, "hidden") }
        super.onStop()
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
                "This app is Names Wallet. It runs a Logos blockchain node on this phone: version " +
                    "${BuildConfig.NODE_VERSION}, built from the node's published source" +
                    (when (BuildConfig.NODE_VARIANT) {
                        "api" -> " with one patch that keeps its API private to this app"
                        "patched" -> " with this app's patches (a faster restart, its API private to this app)"
                        else -> ""
                    }) +
                    ". A fresh install " +
                    "syncs the chain from its first block, and that cannot finish on a phone: the node's memory grows " +
                    "with the chain during the first sync. Start it from a snapshot instead: a tar of a synced node's " +
                    "database, made as the project's docs/start-from-a-synced-database.md describes."
            )
        )
        fun control(v: android.view.View) = v.also { controls += it; column.addView(it) }
        lockedNote = text(
            14f,
            "The wallet is locked, so the node's controls and its log are hidden. Go back and unlock the wallet to use them."
        ).apply { visibility = android.view.View.GONE }.also { column.addView(it) }
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        buttons.addView(Button(this).apply {
            text = "Start"
            setOnClickListener {
                guarded {
                    startForegroundService(Intent(this@NodeActivity, NodeService::class.java).setAction(NodeService.ACTION_START))
                    io.execute { update() }
                }
            }
        })
        buttons.addView(Button(this).apply {
            text = "Stop"
            setOnClickListener {
                guarded {
                    if (NodeService.active) {
                        startService(Intent(this@NodeActivity, NodeService::class.java).setAction(NodeService.ACTION_STOP))
                    }
                    io.execute { update() }
                }
            }
        })
        control(buttons)
        processView = text(16f).also { column.addView(it) }
        statusView = text(16f).also { column.addView(it) }

        control(text(18f, "Snapshot"))
        snapshotView = text(14f).also { control(it) }
        control(Button(this).apply {
            text = "Start from a snapshot"
            setOnClickListener {
                if (NodeService.importRunning) return@setOnClickListener
                guarded {
                    val pick = Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*")                                   // Downloads often types a tar as octet-stream
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                    @Suppress("DEPRECATION") startActivityForResult(pick, PICK_SNAPSHOT)
                }
            }
        })
        // not in [controls]: update() shows it only when there is a previous state, and READ_ONLY hides it there
        revertButton = Button(this).apply {
            text = "Go back to the previous state"
            visibility = android.view.View.GONE
            setOnClickListener { guarded { confirmRevert() } }
        }.also { column.addView(it) }

        control(text(18f, "Messaging node"))
        control(
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
            setOnCheckedChangeListener { _, on -> if (!syncing) setMessaging("enabled", on) }
        }.also { control(it) }
        mobileSwitch = android.widget.Switch(this).apply {
            text = "Also use mobile data"
            isChecked = prefs.getBoolean("mobile", false)
            setOnCheckedChangeListener { _, on -> if (!syncing) setMessaging("mobile", on) }
        }.also { control(it) }
        messagingView = text(14f).also { control(it) }
        control(text(14f, "Log (full log: files/node/output.log)"))
        logView = text(11f).apply { typeface = Typeface.MONOSPACE }.also { control(it) }
        column.addView(
            text(
                11f,
                "Node binary: ${BuildConfig.NODE_VERSION} (${BuildConfig.NODE_VARIANT}), sha256 ${BuildConfig.NODE_SHA256}\n" +
                    "App ${BuildConfig.VERSION_NAME}, wallet ${BuildConfig.WEB_APP_VERSION}. Node API " +
                    (if (NodeApi.onSocket) "on its own socket in the app's files (no TCP port)" else "on 127.0.0.1:${NodeFiles.API_PORT}") +
                    ", wallet on 127.0.0.1:${WalletServer.PORT}."
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
        val full = gate.screen == NodeGate.Screen.FULL
        val logText = if (full) log.tail(40) else ""             // never the log while locked
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
            val fullNow = gate.screen == NodeGate.Screen.FULL
            logView.text = if (fullNow) logText else ""
            snapshotView.text = snapshotText
            messagingView.text = messagingText
            revertButton.visibility = if (previousLabel != null && fullNow) android.view.View.VISIBLE else android.view.View.GONE
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
        // the picker may have stayed open past a lock: ask again before offering the import
        guarded { confirmImport(uri) }
    }

    private fun confirmImport(uri: Uri) {
        val name = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: uri.lastPathSegment
        dialog?.dismiss()
        dialog = android.app.AlertDialog.Builder(this)
            .setTitle("Start from this snapshot?")
            .setMessage(
                "$name\n\nThe node's database is replaced by the one in this file. The node is stopped for the swap " +
                    "and started again. Its keys and settings are not touched, and the current database is kept so you " +
                    "can go back. You trust whoever made the snapshot for the history up to it."
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Import") { _, _ ->
                guarded {
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
            }
            .show()
    }

    private fun confirmRevert() {
        dialog?.dismiss()
        dialog = android.app.AlertDialog.Builder(this)
            .setTitle("Go back to the previous state?")
            .setMessage(
                "The node is stopped, its current database and the previous one swap places, and it starts again. " +
                    "You can swap back the same way."
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Go back") { _, _ ->
                guarded {
                    startForegroundService(Intent(this, NodeService::class.java).setAction(NodeService.ACTION_REVERT))
                    io.execute { update() }
                }
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

    /** GET on the node's API (its Unix socket with patch 0002, NodeApi); throws when it doesn't answer 200. */
    private fun get(path: String): String {
        val (code, body) = NodeApi.get(files, path, 3000) ?: throw java.io.IOException("no answer")
        if (code != 200) throw java.io.IOException("HTTP $code")
        return body
    }
}

package io.github.jefdiesel.logosnode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Runs the node binary as a child process and keeps it running: restarts it with a backoff when
 * it exits, and stops it cleanly (SIGTERM, then SIGKILL after 20 s) when the user presses Stop.
 */
class NodeService : Service() {

    companion object {
        const val ACTION_START = "io.github.jefdiesel.logosnode.START"
        const val ACTION_STOP = "io.github.jefdiesel.logosnode.STOP"
        /** Start the node from a snapshot: the intent's data is the tar's content URI (from the file picker). */
        const val ACTION_IMPORT = "io.github.jefdiesel.logosnode.IMPORT"
        /** Swap the node's state with state.previous. */
        const val ACTION_REVERT = "io.github.jefdiesel.logosnode.REVERT"
        /** Debug builds only: the import, against files/scratch-import, never the node's own state. */
        const val ACTION_TEST_IMPORT = "io.github.jefdiesel.logosnode.TEST_IMPORT"
        private const val CHANNEL = "node"
        private const val NOTIFICATION_ID = 1

        /** For the screen: is the service up, and what is it doing. */
        @Volatile var active = false
        @Volatile var status = "stopped"
        /** A snapshot import or a go-back is running in this process. */
        @Volatile var importRunning = false
    }

    private val startLock = Object()
    @Volatile private var hold = false
    @Volatile private var importCancel = false

    private lateinit var files: NodeFiles
    private lateinit var log: NodeLog
    private val main = Handler(Looper.getMainLooper())
    private var supervisor: Thread? = null
    private var monitor: Thread? = null
    @Volatile private var stopRequested = false
    @Volatile private var process: Process? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        files = NodeFiles(this)
        log = NodeLog(files.output)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Node", NotificationManager.IMPORTANCE_LOW)
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                if (importRunning) {
                    importCancel = true
                    log.app("stop requested during a snapshot import: cancelling it")
                }
                stopEverything()
                return START_NOT_STICKY
            }
            ACTION_IMPORT, ACTION_REVERT -> {
                goForeground(if (intent.action == ACTION_IMPORT) "Starting from a snapshot" else "Going back to the previous state")
                startStateJob(intent)
                return START_STICKY
            }
            ACTION_TEST_IMPORT -> {
                goForeground("Test import")
                if (BuildConfig.DEBUG && !importRunning) thread(name = "test-import") { testImport() }
                return START_NOT_STICKY
            }
        }
        // ACTION_START, or a null intent when Android restarts this sticky service
        goForeground(if (intent == null) "Restarted by Android" else "Starting the node")
        if (intent == null) log.app("service restarted by Android")
        if (stopping) {
            // a Stop is still finishing: start again once it has, instead of being cut off by it
            startAfterStop = true
            log.app("start requested while stopping: starting again once stopped")
            return START_STICKY
        }
        stopRequested = false
        ensureSupervisor()
        return START_STICKY
    }

    @Volatile private var stopping = false
    @Volatile private var startAfterStop = false

    private fun ensureSupervisor() = synchronized(startLock) {
        if (stopRequested || supervisor?.isAlive == true) return@synchronized
        active = true
        supervisor = thread(name = "node-supervisor") { supervise() }
        if (monitor?.isAlive != true) monitor = thread(name = "node-monitor", isDaemon = true) { monitorMemory() }
    }

    // ---- snapshot import and going back (Snapshot.kt does the work) ----

    private fun saveImportStatus(text: String) {
        val line = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(java.util.Date()) + " " + text
        log.app("snapshot: $text")
        try {
            files.importStatus.writeText(line)
        } catch (_: Exception) {
        }
    }

    /** Pauses the supervisor and stops the node, and waits until no node process is left. */
    private fun holdNode() {
        synchronized(startLock) { hold = true }
        killNode()
        val until = System.currentTimeMillis() + 30_000
        while (NodeProcesses.pids().isNotEmpty() && System.currentTimeMillis() < until) {
            NodeProcesses.pids().forEach { android.os.Process.sendSignal(it, 15) }
            Thread.sleep(500)
        }
        NodeProcesses.pids().forEach { android.os.Process.sendSignal(it, 9) }
    }

    private fun releaseNode() {
        synchronized(startLock) { hold = false }
        ensureSupervisor()
    }

    private fun startStateJob(intent: Intent) {
        if (importRunning) {
            log.app("snapshot: refused, one is already running")
            return
        }
        importRunning = true
        importCancel = false
        stopRequested = false
        val uri = intent.data
        val action = intent.action
        val lock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "logosnode:import").apply { acquire(3 * 60 * 60_000L) }
        thread(name = "node-import") {
            try {
                val home = files.home
                val message = if (action == ACTION_REVERT) {
                    saveImportStatus("Going back to the previous state")
                    holdNode()
                    try {
                        StateSwap(home).revert()
                    } finally {
                        releaseNode()
                    }
                    "Went back to the previous state. The state it replaced is kept as state.previous."
                } else {
                    if (uri == null) throw SnapshotError("No file was chosen.")
                    val size = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use {
                        if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null
                    }
                    val available = android.os.StatFs(home.path).availableBytes
                    saveImportStatus("Importing a snapshot" + (size?.let { " (${SnapshotImporter.mb(it)} MB)" } ?: ""))
                    SnapshotImporter(home, status = { setStatus(it); files.importStatus.writeText(it) }, cancelled = { importCancel })
                        .run(
                            open = { contentResolver.openInputStream(uri) ?: throw SnapshotError("The chosen file can't be opened.") },
                            size = size, available = available,
                            stopNode = { holdNode() }, startNode = { releaseNode() },
                        )
                }
                saveImportStatus("Done: $message")
            } catch (e: SnapshotError) {
                saveImportStatus("Failed: ${e.message}")
            } catch (e: Exception) {
                saveImportStatus("Failed: $e")
            } finally {
                synchronized(startLock) { hold = false }
                importRunning = false
                if (lock.isHeld) lock.release()
                if (uri != null) try {
                    contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (_: Exception) {
                }
                if (!stopRequested) ensureSupervisor()
            }
        }
    }

    /**
     * Debug builds: the same import code against files/scratch-import (a fake state folder there and
     * the tar at scratch-import/in.tar), with no node stopped or started. Writes scratch-import/result.txt.
     */
    private fun testImport() {
        val root = File(filesDir, "scratch-import")
        val result = File(root, "result.txt")
        importRunning = true
        try {
            File(root, "state").mkdirs()
            File(root, "state/marker").writeText("the scratch state before the test import")
            val tar = File(root, "in.tar")
            val text = try {
                "OK: " + SnapshotImporter(root, status = { log.app("[test import] $it") }).run(
                    open = { tar.inputStream() }, size = tar.length(), available = android.os.StatFs(root.path).availableBytes,
                    stopNode = { log.app("[test import] here the node would stop") },
                    startNode = { log.app("[test import] here the node would start") },
                )
            } catch (e: Exception) {
                "FAILED: ${e.message}"
            }
            val tree = root.walkTopDown().filter { it.isFile }.joinToString("\n") { "${it.relativeTo(root)} ${it.length()}" }
            result.writeText("$text\n$tree\n")
            log.app("[test import] $text")
        } finally {
            importRunning = false
            if (!active) main.post { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
        }
    }

    override fun onDestroy() {
        log.app("service destroyed")
        stopRequested = true
        thread(name = "node-stop-on-destroy") { killNode() }
        active = false
        status = "stopped"
        super.onDestroy()
    }

    private fun goForeground(text: String) {
        val n = notification(text)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, WalletActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, NodeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Logos node")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, android.R.drawable.ic_media_pause), "Stop", stop
                ).build()
            )
            .build()
    }

    private fun setStatus(text: String) {
        status = text
        if (!stopRequested) {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
        }
    }

    private fun stopEverything() {
        log.app("stop requested")
        if (stopping) return
        stopping = true
        stopRequested = true
        setStatus("stopping")
        thread(name = "node-stop") {
            killNode()
            supervisor?.interrupt()
            supervisor?.join(30_000)
            main.post {
                stopping = false
                if (startAfterStop) {                        // Start was pressed while this Stop ran
                    startAfterStop = false
                    stopRequested = false
                    log.app("starting again, as requested during the stop")
                    goForeground("Starting the node")
                    ensureSupervisor()
                    return@post
                }
                active = false
                status = "stopped"
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    private fun supervise() {
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "logosnode:node").apply { acquire() }
        var backoffSeconds = 5L
        try {
            while (!stopRequested) {
                if (hold) {                                  // a snapshot import or go-back has the state
                    if (status != "paused for the snapshot") setStatus("paused for the snapshot")
                    try {
                        Thread.sleep(500)
                    } catch (_: InterruptedException) {
                        if (stopRequested) break
                    }
                    backoffSeconds = 5
                    continue
                }
                val started = System.currentTimeMillis()
                val exit = try {
                    prepare()
                    runNode()
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    log.app("could not run the node: $e")
                    null
                }
                if (stopRequested) break
                if (hold) continue                           // stopped on purpose for the import
                if (System.currentTimeMillis() - started > 10 * 60_000) backoffSeconds = 5
                log.app("node exited (exit code $exit); restarting in $backoffSeconds s")
                setStatus("node exited (code $exit), restarting in $backoffSeconds s")
                try {
                    Thread.sleep(backoffSeconds * 1000)
                } catch (_: InterruptedException) {
                    break
                }
                backoffSeconds = minOf(backoffSeconds * 2, 300)
            }
        } finally {
            wakeLock?.let { if (it.isHeld) it.release() }
            log.app("supervisor stopped")
        }
    }

    /** Folders, fresh keys on the first start, and the config (rewritten each start). */
    private fun prepare() {
        files.mkdirs()
        // an import or go-back cut short when the app was killed: undo or finish it before the node opens the state
        if (!importRunning) StateSwap(files.home).recover()?.let { saveImportStatus(it) }
        val bin = files.binary
        if (!bin.exists()) throw IllegalStateException("node binary missing at ${bin.path}")
        if (!files.keystore.exists()) {
            log.app("first start: creating fresh keys with init-config")
            setStatus("creating keys")
            val p = processBuilder(listOf(bin.path, "init-config", "-o", files.config.path)).start()
            p.inputStream.bufferedReader().forEachLine { log.node(it) }
            val code = p.waitFor()
            log.app("init-config exited with code $code")
            if (code != 0 || !files.keystore.exists()) throw IllegalStateException("init-config failed (code $code)")
        }
        files.writeConfig()
        files.linkBinary()
        // a node left over from an earlier run of the app would hold the database lock and the ports
        for (pid in NodeProcesses.pids()) {
            log.app("stopping a leftover node process $pid")
            android.os.Process.sendSignal(pid, 15)
            Thread.sleep(5000)
            if (NodeProcesses.pids().contains(pid)) android.os.Process.sendSignal(pid, 9)
        }
    }

    private fun processBuilder(command: List<String>) = ProcessBuilder(command)
        .directory(files.home)
        .redirectErrorStream(true)
        .apply {
            environment()["HOME"] = files.home.path
            environment()["TMPDIR"] = files.tmp.path
            environment()["RUST_BACKTRACE"] = "1"
        }

    private fun runNode(): Int {
        val launcher = files.launcher
        log.app("starting ${launcher.path} (node ${BuildConfig.NODE_VERSION}, sha256 ${BuildConfig.NODE_SHA256})")
        val p = synchronized(startLock) {
            if (hold || stopRequested) return -1                    // an import took the state meanwhile
            processBuilder(listOf(launcher.path, files.config.name)).start().also { process = it }
        }
        setStatus("node running")
        try {
            p.inputStream.bufferedReader().forEachLine { log.node(it) }
        } catch (_: Exception) {
        }
        val code = p.waitFor()
        process = null
        return code
    }

    private fun killNode() {
        val p = process ?: return
        log.app("stopping the node (SIGTERM)")
        p.destroy()
        if (!p.waitFor(20, TimeUnit.SECONDS)) {
            log.app("node did not stop within 20 s, killing it")
            p.destroyForcibly()
            p.waitFor(5, TimeUnit.SECONDS)
        }
        log.app("node stopped")
    }

    /** One line a minute with the node's memory, so the log shows how it grows. */
    private fun monitorMemory() {
        while (!stopRequested) {
            try {
                Thread.sleep(60_000)
            } catch (_: InterruptedException) {
                return
            }
            val pids = NodeProcesses.pids()
            if (pids.isNotEmpty()) log.app("node memory: " + pids.joinToString { "pid $it ${NodeProcesses.rssMb(it)} MB" })
        }
    }
}

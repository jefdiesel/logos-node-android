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
        private const val CHANNEL = "node"
        private const val NOTIFICATION_ID = 1

        /** For the screen: is the service up, and what is it doing. */
        @Volatile var active = false
        @Volatile var status = "stopped"
    }

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
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }
        // ACTION_START, or a null intent when Android restarts this sticky service
        goForeground(if (intent == null) "Restarted by Android" else "Starting the node")
        if (supervisor?.isAlive != true) {
            if (intent == null) log.app("service restarted by Android")
            stopRequested = false
            active = true
            supervisor = thread(name = "node-supervisor") { supervise() }
            monitor = thread(name = "node-monitor", isDaemon = true) { monitorMemory() }
        }
        return START_STICKY
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
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
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
        stopRequested = true
        setStatus("stopping")
        thread(name = "node-stop") {
            killNode()
            supervisor?.interrupt()
            supervisor?.join(30_000)
            main.post {
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
        log.app("starting ${files.binary.path} (node ${BuildConfig.NODE_VERSION}, sha256 ${BuildConfig.NODE_SHA256})")
        val p = processBuilder(listOf(files.binary.path, files.config.name)).start()
        process = p
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

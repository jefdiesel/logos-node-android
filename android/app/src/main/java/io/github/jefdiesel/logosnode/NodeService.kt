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

        /** The messaging node switches changed (or the screen wants them re-checked). */
        const val ACTION_MESSAGING = "io.github.jefdiesel.logosnode.MESSAGING"
        /** The messaging node, for the Node screen; null while the service isn't running. */
        @Volatile var messaging: MessagingSupervisor? = null
        @Volatile var messagingBlocker: String? = "off"
        @Volatile var messagingUsage: DataUsage? = null

        fun messagingPrefs(context: android.content.Context) =
            context.getSharedPreferences("messaging", android.content.Context.MODE_PRIVATE)

        /**
         * Mobile mode (android/BATTERY.md): --es mode on|off sets it (the wallet page's Settings > Node does the
         * same), --ez restart true is "Restart node now" (refused while the wallet is busy), and --ez reset true
         * clears the counters (files/node/battery-stats.txt) at the next minute, for a new measurement.
         */
        const val ACTION_MOBILE_MODE = "io.github.jefdiesel.logosnode.MOBILE_MODE"
        /** One line for the Node screen: the setting and what it does now. */
        @Volatile var mobileSummary = ""

        /** Kept by this (the main) process only; the wallet page reads files/node/mobile-state.json. */
        fun mobileMode(context: android.content.Context): MobileMode =
            MobileMode.parse(context.getSharedPreferences("battery", android.content.Context.MODE_PRIVATE).getString("mode", null))
                ?: MobileMode.DEFAULT
    }

    // ---- mobile mode: the node's profile, applied at each node start (Battery.kt, BATTERY.md) ----

    private val batteryWork = java.util.concurrent.Executors.newSingleThreadExecutor()
    private lateinit var stats: BatteryStats
    @Volatile private var lightFailed = false
    @Volatile private var lightQuickExits = 0
    @Volatile private var lastCheckedLight: String? = null
    /** The profile of the node process now running (null when none runs), and the one the next start uses. */
    @Volatile private var runningProfile: NodeProfile? = null
    @Volatile private var startingProfile = NodeProfile.FULL
    @Volatile private var nodeStartedAt = 0L
    /** Set when the service stops the node for "Restart node now": no crash backoff then. */
    @Volatile private var plannedRestart: String? = null
    /** The answer to the last "Restart node now", for the page. */
    @Volatile private var restartAnswer = ""
    private val nodeLines = java.util.concurrent.atomic.AtomicLong()
    private val nodeBytes = java.util.concurrent.atomic.AtomicLong()

    /** For the counters only: is the phone plugged in, is the network unmetered (null: unknown). */
    private fun stickyPlugged(): Boolean? = try {
        registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, -1)?.takeIf { it >= 0 }?.let { it > 0 }
    } catch (_: Exception) {
        null
    }

    private fun unmeteredNow(): Boolean? = try {
        val cm = getSystemService(android.net.ConnectivityManager::class.java)
        cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
            ?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    } catch (_: Exception) {
        null
    }

    private fun readOrNull(f: File): String? = try { if (f.isFile) f.readText() else null } catch (_: Exception) { null }

    /** The `names` signer (libnames.so) runs while a name change is made. */
    private fun namesRunning(): Boolean =
        File("/proc").listFiles { f -> f.name.all(Char::isDigit) }.orEmpty().any { dir ->
            try { File(dir, "cmdline").readText().substringBefore('\u0000').endsWith("/libnames.so") } catch (_: Exception) { false }
        }

    private fun walletBusy(now: Long): String? {
        val w = WalletServer.dataDir(this)
        return WalletBusy.reason(readOrNull(File(w, "wallet-bridge.json")), readOrNull(File(w, "wallet-history.json")), namesRunning(), now)
    }

    /** GET on the node's API (its Unix socket with patch 0002, NodeApi), parsed; null when it doesn't answer. */
    private fun nodeJson(path: String): org.json.JSONObject? = NodeApi.json(files, path)

    private fun chainInfo(): org.json.JSONObject? = nodeJson("/cryptarchia/info")?.let { it.optJSONObject("cryptarchia_info") ?: it }

    /** When the node was first seen Online with no other state seen since (0: not Online now). */
    @Volatile private var onlineSince = 0L

    private fun noteState(state: String?, now: Long) {
        if (state == "Online") { if (onlineSince == 0L) onlineSince = now } else onlineSince = 0L
    }

    /** How long the node has been seen Online without a break, reading it now (-1: not Online). */
    private fun onlineFor(now: Long): Long {
        noteState(chainInfo()?.optString("state"), now)
        return if (onlineSince == 0L) -1L else now - onlineSince
    }

    /** The profile the setting asks for now. */
    private fun wantedProfile() = MobilePolicy.profile(mobileMode(this), lightFailed)

    /** "Restart node now", on the batteryWork thread: restarts the node on the new setting, or says why not. */
    private fun restartNow() {
        val now = System.currentTimeMillis()
        val running = process != null && runningProfile != null
        val pending = running && runningProfile != wantedProfile()
        val busy = if (running && pending) walletBusy(now) else null
        val onlineMs = if (running && pending && busy == null) onlineFor(now) else -1L
        val no = RestartNow.refusal(running, hold || importRunning || stopping || stopRequested, pending, busy, onlineMs)
        if (no != null) {
            restartAnswer = no
            log.app("mobile mode: restart refused: $no")
        } else {
            restartAnswer = "Restarting the node on the new setting; it is back online in about a minute."
            stats.add("restarts_user", 1)
            log.app("mobile mode: restarting the node on the ${wantedProfile().key} profile, as asked")
            plannedRestart = "mobile mode (asked for)"
            killNode()
        }
        publishMobileState()
    }

    /** files/node/mobile-state.json for the wallet page, and the Node screen's line. */
    private fun publishMobileState() {
        val mode = mobileMode(this)
        val running = runningProfile
        val wanted = wantedProfile()
        val pending = running != null && running != wanted
        val now = when {
            running == null -> "The node isn't running; it uses this setting when it starts."
            pending -> "The node runs the ${if (running == NodeProfile.LIGHT) "lighter" else "full"} profile. Applies the next time the node starts."
            else -> "The node runs the ${if (running == NodeProfile.LIGHT) "lighter" else "full"} profile (${MobilePolicy.why(mode, lightFailed)})."
        }
        mobileSummary = "Mobile mode: ${mode.key}. $now"
        try {
            val o = org.json.JSONObject().put("mode", mode.key).put("profile", running?.key ?: "")
                .put("pending", pending).put("now", now).put("restart", restartAnswer)
            files.mobileState.writeText(o.toString())
        } catch (_: Exception) {}
    }

    // ---- the counters (BatteryStats), once a minute from the monitor thread ----

    @Volatile private var resetRequested = false
    private var lastTickAt = 0L
    private val prevTicks = HashMap<Int, Long>()
    private var prevUid: Pair<Long, Long>? = null
    private var prevWaku: Pair<Long, Long>? = null
    private var prevLines = 0L
    private var prevBytes = 0L

    private fun cpuMs(pids: List<Int>, hz: Long): Long {
        var ms = 0L
        for (pid in pids) {
            val t = ProcCpu.ticksOf(pid) ?: continue
            val d = t - (prevTicks[pid] ?: 0L)
            prevTicks[pid] = t
            if (d > 0) ms += d * 1000 / hz
        }
        return ms
    }

    private fun statsTick() {
        try {
            val now = System.currentTimeMillis()
            val plugged = stickyPlugged(); val unmetered = unmeteredNow()
            val p = runningProfile?.key ?: "stopped"
            if (lastTickAt > 0) stats.add("seconds_$p", minOf(now - lastTickAt, 5 * 60_000L) / 1000)
            lastTickAt = now
            val hz = try { android.system.Os.sysconf(android.system.OsConstants._SC_CLK_TCK).takeIf { it > 0 } ?: 100L } catch (_: Exception) { 100L }
            val live = (NodeProcesses.pids() + runnerPids() + android.os.Process.myPid()).toSet()
            prevTicks.keys.retainAll(live)
            val nodeCpu = cpuMs(NodeProcesses.pids(), hz)
            val wakuCpu = cpuMs(runnerPids(), hz)
            stats.add("node_cpu_ms_$p", nodeCpu)
            stats.add("waku_cpu_ms_$p", wakuCpu)
            stats.add("service_cpu_ms_$p", cpuMs(listOf(android.os.Process.myPid()), hz))
            val uid = android.os.Process.myUid()
            val rx = android.net.TrafficStats.getUidRxBytes(uid); val tx = android.net.TrafficStats.getUidTxBytes(uid)
            if (rx >= 0 && tx >= 0) {
                prevUid?.let { (r, t) -> stats.add("uid_rx_bytes_$p", rx - r); stats.add("uid_tx_bytes_$p", tx - t) }
                prevUid = rx to tx
            }
            messagingUsage?.let { u ->
                val w = u.todayIn to u.todayOut
                prevWaku?.let { (r, t) -> stats.add("waku_rx_bytes_$p", w.first - r); stats.add("waku_tx_bytes_$p", w.second - t) }
                prevWaku = w
            }
            val l = nodeLines.get(); val b = nodeBytes.get()
            stats.add("node_log_lines_$p", l - prevLines); stats.add("node_log_bytes_$p", b - prevBytes)
            prevLines = l; prevBytes = b
            // quality, next to the cost: the node's state, height and tip age each minute (battery-samples.csv
            // has one line a minute, to set against a reference node's height at the same times)
            var sample = listOf<Any?>(now / 1000, p, plugged, unmetered)
            if (runningProfile != null) {
                val net = nodeJson("/network/info")
                val c = chainInfo()
                val t = nodeJson("/time/info")
                val peers = net?.optInt("n_peers", -1)
                val tipSlot = c?.optLong("slot", -1L)?.takeIf { it >= 0 }
                val curSlot = t?.optLong("current_slot", -1L)?.takeIf { it >= 0 }
                val slotMs = t?.optLong("slot_duration_ms", 0L)?.takeIf { it > 0 } ?: 1000L
                val tipAgeS = if (tipSlot != null && curSlot != null) maxOf(0L, curSlot - tipSlot) * slotMs / 1000 else null
                stats.set("node_peers", peers); stats.set("node_connections", net?.optInt("n_connections", -1))
                stats.set("node_height", c?.opt("height")); stats.set("node_state", c?.optString("state"))
                if (c != null) noteState(c.optString("state"), now)
                if (tipAgeS != null && c?.optString("state") == "Online") {
                    stats.add("tip_age_samples_$p", 1); stats.add("tip_age_s_sum_$p", tipAgeS)
                    if (tipAgeS > stats.get("tip_age_s_max_$p")) stats.set("tip_age_s_max_$p", tipAgeS)
                }
                sample = sample + listOf(c?.optString("state"), c?.opt("height"), tipSlot, curSlot, tipAgeS, peers)
            } else sample = sample + listOf(null, null, null, null, null, null)
            sample = sample + listOf(nodeCpu, wakuCpu)
            try {
                val csv = File(files.home, "battery-samples.csv")
                if (csv.length() > 2L * 1024 * 1024) { File(csv.path + ".1").delete(); csv.renameTo(File(csv.path + ".1")) }
                if (!csv.exists()) csv.writeText("time,profile,plugged,unmetered,state,height,tip_slot,current_slot,tip_age_s,peers,node_cpu_ms,waku_cpu_ms\n")
                csv.appendText(sample.joinToString(",") { it?.toString() ?: "" } + "\n")
            } catch (_: Exception) {}
            val mode = mobileMode(this)
            stats.set("mode", mode.key); stats.set("profile", p)
            stats.set("plugged", plugged); stats.set("unmetered", unmetered)
            stats.set("light_failed", lightFailed)
            stats.set("why", MobilePolicy.why(mode, lightFailed))
            stats.set("wakelock_held", wakeLock?.isHeld == true)
            stats.set("updated", now)
            if (resetRequested) {
                // this minute's readings are the new starting point; everything counted so far goes
                resetRequested = false
                stats.reset()
                File(files.home, "battery-samples.csv").delete(); File(files.home, "open-times.txt").delete()
                log.app("mobile mode: counters reset")
            }
            stats.save()
        } catch (e: Exception) {
            log.app("mobile mode: counters: $e")
        }
    }

    /**
     * Runs the node binary's own config check (--check-config) on the light config, next to keystore.yaml.
     * The node refuses unknown keys, so a light config it can't read must never become the running one.
     */
    private fun lightConfigOk(swarm: List<String>): Boolean {
        val key = swarm.joinToString("\n")
        if (key == lastCheckedLight) return true
        return try {
            files.writeConfig(swarm, files.checkConfig)
            val p = processBuilder(listOf(files.binary.path, files.checkConfig.name, "--check-config")).start()
            val out = p.inputStream.bufferedReader().readText()
            val done = p.waitFor(60, TimeUnit.SECONDS)
            if (!done) p.destroyForcibly()
            val ok = done && p.exitValue() == 0
            // only the last line, cut short: an error message could quote config values
            if (!ok) log.app("mobile mode: the node refused the light config (${out.trim().lines().lastOrNull()?.take(200)})")
            if (ok) lastCheckedLight = key
            ok
        } catch (e: Exception) {
            log.app("mobile mode: couldn't check the light config: $e")
            false
        } finally {
            files.checkConfig.delete()
        }
    }

    // ---- the messaging (Waku) node: a second child, with its own supervisor (Messaging.kt) ----

    private val messagingWork = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var messagingController: MessagingController? = null
    private var networkCallback: android.net.ConnectivityManager.NetworkCallback? = null
    @Volatile private var metered: Boolean? = null

    private fun messagingEnabled() = messagingPrefs(this).getBoolean("enabled", false)

    private fun replayPrefs() = getSharedPreferences("replay", MODE_PRIVATE)

    private fun setUpMessaging() {
        if (messagingController != null) return
        val mf = MessagingFiles(File(filesDir, "waku"))
        mf.mkdirs()
        // nothing of an earlier run survives the app's process, so a "running" left in the file is stale
        try { mf.state.writeText("stopped: off\n") } catch (_: Exception) {}
        val usage = DataUsage(mf.usage)
        val libDir = applicationInfo.nativeLibraryDir
        val sup = MessagingSupervisor(mf, usage,
            launch = { config ->
                // a runner left over from an earlier run of the app would hold the ports
                runnerPids().forEach { android.os.Process.sendSignal(it, 9) }
                ProcessBuilder(File(libDir, "libwakurunner.so").path, config.path,
                    "--status-every", MessagingSettings.STATUS_EVERY_SECONDS.toString())
                    .directory(mf.dir)
                    .redirectErrorStream(true)
                    .apply {
                        // librln.so has no SONAME, so the loader finds it only on the library path
                        environment()["LD_LIBRARY_PATH"] = libDir
                        environment()["HOME"] = mf.dir.path
                        environment()["TMPDIR"] = File(mf.dir, "tmp").apply { mkdirs() }.path
                    }
                    .start()
            },
            log = { log.app(it) },
            onChange = { updateNotification() })
        messaging = sup
        messagingUsage = usage
        messagingController = MessagingController(usage, { sup.running }, { sup.start() }, { sup.stop(it) })
        messagingWork.execute { killUnownedRunners() }               // nothing runs yet: anything found is an orphan
        guard = thread(name = "messaging-orphan-guard", isDaemon = true) {
            while (true) {
                try { Thread.sleep(60_000) } catch (_: InterruptedException) { return@thread }
                // a stuck supervisor is restarted, orphans go, then the switches are checked again
                messagingWork.execute {
                    try {
                        val m = messaging
                        if (m != null && m.recoverIfStuck()) log.app("messaging: guard restarted a stuck supervisor")
                    } catch (e: Exception) {
                        log.app("messaging: guard: $e")
                    }
                    killUnownedRunners()
                }
                main.post { if (messaging != null) evaluateMessaging() }
            }
        }
    }

    private var guard: Thread? = null

    private fun runnerPids(): List<Int> =
        File("/proc").listFiles { f -> f.name.all(Char::isDigit) }.orEmpty().mapNotNull { dir ->
            val argv0 = try { File(dir, "cmdline").readText().substringBefore('\u0000') } catch (_: Exception) { "" }
            if (argv0.endsWith("/libwakurunner.so")) dir.name.toInt() else null
        }

    /** Re-checks the switches, the network and the day's data use; starts or stops the messaging node. */
    private fun evaluateMessaging() {
        setUpMessaging()
        val enabled = messagingEnabled()
        if (enabled) watchNetwork() else unwatchNetwork()
        val mobile = messagingPrefs(this).getBoolean("mobile", false)
        messagingWork.execute {
            try {
                messagingController?.update(enabled, metered, mobile)
                messagingBlocker = messagingController?.blocker
            } catch (e: Exception) {
                log.app("messaging: $e")
            }
            killUnownedRunners()
            main.post { stopIfIdle() }
        }
    }

    /**
     * The orphan guard: a runner nothing watches costs gigabytes an hour. Whenever the supervisor isn't
     * running (switched off, stopped for a reason, or broken), every messaging runner process is killed:
     * SIGTERM, then SIGKILL after a few seconds. Called at service start, on every switch change, and
     * once a minute.
     */
    private fun killUnownedRunners() {
        // owned = being launched, or the supervisor's handle is of a live process (not just "its thread is alive")
        // only the runners found at the start of this pass: one a new supervisor starts meanwhile is never touched
        val signalled = OrphanGuard.pass(
            owned = { messaging?.ownsRunner == true },
            runnerPids = { runnerPids() },
            signal = { pid, sig -> android.os.Process.sendSignal(pid, sig) },
        )
        if (signalled.isNotEmpty()) log.app("messaging: stopped ${signalled.size} runner process(es) that nothing supervised: $signalled")
    }

    private fun watchNetwork() {
        if (networkCallback != null) return
        val cm = getSystemService(android.net.ConnectivityManager::class.java)
        val cb = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: android.net.Network, caps: android.net.NetworkCapabilities) {
                val m = !caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                if (m != metered) { metered = m; main.post { evaluateMessaging() } }
            }

            override fun onLost(network: android.net.Network) {
                metered = null
                main.post { evaluateMessaging() }
            }
        }
        // the current state first, then changes
        metered = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
            ?.let { !it.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED) }
        cm.registerDefaultNetworkCallback(cb)
        networkCallback = cb
    }

    private fun unwatchNetwork() {
        val cb = networkCallback ?: return
        try { getSystemService(android.net.ConnectivityManager::class.java).unregisterNetworkCallback(cb) } catch (_: Exception) {}
        networkCallback = null
    }

    private fun messagingRunning() = messaging?.running == true

    /** The service stays up while the blockchain node or the messaging node is wanted. */
    private fun stopIfIdle() {
        if (supervisor?.isAlive == true || importRunning || stopping || messagingEnabled() || messagingRunning()) {
            updateNotification()
            return
        }
        active = false
        status = "stopped"
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun updateNotification() {
        val node = if (supervisor?.isAlive == true) status else "node stopped"
        val msg = messaging?.state?.takeIf { messagingEnabled() || messagingRunning() }
        try {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, notification(if (msg != null) "$node · messaging: $msg" else node))
        } catch (_: Exception) {
        }
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
        files.mkdirs()
        stats = BatteryStats(files.batteryStats)
        publishMobileState()
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
            ACTION_MESSAGING -> {
                // debug builds: the switches can be set from adb (--ez enabled true|false, --ez mobile true|false),
                // and --ez break true makes the supervisor get stuck on purpose, leaving its runner unwatched
                // (orphan-guard test: the minute guard should kill the runner and restart the supervisor)
                if (BuildConfig.DEBUG) {
                    val edit = messagingPrefs(this).edit()
                    for (key in listOf("enabled", "mobile")) if (intent.hasExtra(key)) edit.putBoolean(key, intent.getBooleanExtra(key, false))
                    edit.commit()
                    if (intent.getBooleanExtra("break", false)) {
                        messaging?.debugAbandon = true
                        log.app("messaging: debug: supervisor will break at the runner's next line")
                        return START_STICKY
                    }
                }
                goForeground(if (supervisor?.isAlive == true) status else "Messaging node")
                evaluateMessaging()
                return START_STICKY
            }
            ACTION_MOBILE_MODE -> {
                goForeground(if (supervisor?.isAlive == true) status else "Mobile mode")
                if (intent.getBooleanExtra("reset", false)) {
                    resetRequested = true                    // done by the next minute's count, on its thread
                    log.app("mobile mode: counters reset at the next minute")
                }
                val m = MobileMode.parse(intent.getStringExtra("mode"))
                if (m != null && m != mobileMode(this)) {
                    getSharedPreferences("battery", MODE_PRIVATE).edit().putString("mode", m.key).commit()
                    lightFailed = false; lightQuickExits = 0; lastCheckedLight = null
                    restartAnswer = ""
                    log.app("mobile mode set to ${m.key}; it applies the next time the node starts")
                }
                publishMobileState()
                if (intent.getBooleanExtra("restart", false)) batteryWork.execute { restartNow() }
                main.post { stopIfIdle() }
                return START_STICKY
            }
            ACTION_TEST_IMPORT -> {
                goForeground("Test import")
                if (BuildConfig.DEBUG && !importRunning) thread(name = "test-import") { testImport() }
                return START_NOT_STICKY
            }
        }
        // ACTION_START, or a null intent when Android restarts this sticky service
        if (BuildConfig.DEBUG && intent?.getBooleanExtra("fullreplay", false) == true) {
            replayPrefs().edit().putBoolean("full_next", true).commit()     // the next node start replays in full
        }
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
        if (messagingEnabled()) evaluateMessaging()
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
        unwatchNetwork()
        messaging?.let { m -> if (m.running) thread(name = "messaging-stop-on-destroy") { m.stop("the app's service stopped") } }
        messaging = null
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
            .setContentTitle("Names Wallet")
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
                stopIfIdle()                                 // stays up for the messaging node if that's on
            }
        }
    }

    private fun supervise() {
        // the wake lock is held while the supervisor runs the node, including its config check, a profile
        // restart and a crash restart's wait (a phone asleep there could keep the node down past its grace
        // period); it is let go only while a snapshot import holds the node, the import keeping its own lock
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "logosnode:node").apply { setReferenceCounted(false); acquire() }
        var backoffSeconds = 5L
        try {
            while (!stopRequested) {
                if (hold) {                                  // a snapshot import or go-back has the state
                    wakeLock?.let { if (it.isHeld) it.release() }
                    if (status != "paused for the snapshot") setStatus("paused for the snapshot")
                    try {
                        Thread.sleep(500)
                    } catch (_: InterruptedException) {
                        if (stopRequested) break
                    }
                    backoffSeconds = 5
                    continue
                }
                wakeLock?.let { if (!it.isHeld) it.acquire() }
                val started = System.currentTimeMillis()
                val exit = try {
                    prepare()                                // also stops a node left over from an earlier run
                    // the node's API must not be on a TCP port other apps can reach (android/LOCAL-APIS.md)
                    if (NodeApi.onSocket && NodeApi.tcpAnswers()) {
                        blockApi("before the start")
                        null
                    } else {
                        runNode()
                    }
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    log.app("could not run the node: $e")
                    null
                }
                if (stopRequested) break
                if (hold) continue                           // stopped on purpose for the import
                val ranMs = System.currentTimeMillis() - started
                val planned = plannedRestart
                if (planned != null) {                       // mobile mode stopped it for another profile: start at once
                    plannedRestart = null
                    log.app("node stopped for $planned; starting it again now")
                    backoffSeconds = 5
                    continue
                }
                if (lastRunProfile == NodeProfile.LIGHT && ranMs < 90_000) {
                    // a light config that passed the check but stops the node anyway: after two quick exits, full
                    lightQuickExits++
                    if (lightQuickExits >= 2 && !lightFailed) {
                        lightFailed = true
                        stats.set("light_failed", true); stats.save()
                        log.app("mobile mode: the node stopped twice within 90 s on the light profile; using the full profile until the setting changes")
                    }
                } else if (ranMs > 10 * 60_000) lightQuickExits = 0
                if (ranMs > 10 * 60_000) backoffSeconds = 5
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
        // a different node binary than the one that last ran on this state: its first start replays in full
        try {
            val sha = NodeBinaryRecord.sha256(files.binary)
            if (NodeBinaryRecord.check(files.binaryRecord, files.state, sha)) {
                log.app("another node binary ran on this state before (now sha256 ${sha.take(16)}…): replay marker dropped, this start replays in full")
            }
        } catch (e: Exception) {
            // if this can't be checked, don't trust the marker either
            File(files.state, REPLAY_MARKER).delete()
            log.app("couldn't check which node binary ran on this state ($e): replay marker dropped")
        }
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
        // mobile mode: this start's profile, from the setting, the charger and the network (BATTERY.md)
        val mode = mobileMode(this)
        var profile = MobilePolicy.profile(mode, lightFailed)
        val overrides = files.profileOverrideLines()
        fun swarmFor(p: NodeProfile): List<String> {
            val v = NodeProfileConfig.values(p, overrides) ?: run {
                log.app("mobile mode: profile.txt gives gossipsub values the node would refuse; using the ${p.key} defaults")
                NodeProfileConfig.values(p) ?: emptyMap()
            }
            return NodeProfileConfig.swarmLines(v)
        }
        var swarm = swarmFor(profile)
        if (profile == NodeProfile.LIGHT && !lightConfigOk(swarm)) {
            lightFailed = true
            stats.set("light_failed", true); stats.save()
            profile = NodeProfile.FULL
            swarm = swarmFor(profile)
        }
        files.writeConfig(swarm)
        startingProfile = profile
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
        log.app("starting ${launcher.path} (node ${BuildConfig.NODE_VERSION}, ${BuildConfig.NODE_VARIANT}, sha256 ${BuildConfig.NODE_SHA256})")
        // debug builds: a full replay for this one start, asked for from adb (--ez fullreplay true on START)
        val forceFull = BuildConfig.DEBUG && replayPrefs().getBoolean("full_next", false)
        if (forceFull) {
            replayPrefs().edit().putBoolean("full_next", false).commit()
            log.app("this start replays in full: LOGOS_REPLAY_VERIFY=full (asked for from adb)")
        }
        val started = System.currentTimeMillis()
        try { files.replayInfo.delete() } catch (_: Exception) {}
        onlineSince = 0L
        try {
            val p = synchronized(startLock) {
                if (hold || stopRequested) return -1                    // an import took the state meanwhile
                processBuilder(listOf(launcher.path, files.config.name))
                    .apply { if (forceFull) environment()["LOGOS_REPLAY_VERIFY"] = "full" }
                    .apply {
                        // patch 0002: the API on a Unix socket in a 0700 folder, no TCP port; the node stops
                        // rather than open TCP if anything about the socket is wrong
                        if (NodeApi.onSocket) {
                            files.privateApiDir()
                            environment()["LOGOS_API_UNIX_SOCKET"] = files.apiSocket.path
                        }
                    }
                    .start().also { process = it }
            }
            if (NodeApi.onSocket) watchTcp(p)
            runningProfile = startingProfile
            lastRunProfile = startingProfile
            nodeStartedAt = System.currentTimeMillis()
            log.app("node started on the ${startingProfile.key} profile (mobile mode ${mobileMode(this).key})")
            publishMobileState()
            setStatus(if (startingProfile == NodeProfile.LIGHT) "node running (light)" else "node running")
            try {
                p.inputStream.bufferedReader().forEachLine { line ->
                    nodeLines.incrementAndGet(); nodeBytes.addAndGet(line.length + 1L)
                    log.node(line)
                    ReplayInfo.fromLine(line, System.currentTimeMillis() - started)?.let { note ->
                        try { files.replayInfo.appendText(note + "\n") } catch (_: Exception) {}
                    }
                }
            } catch (_: Exception) {
            }
            val code = p.waitFor()
            process = null
            return code
        } finally {
            runningProfile = null
            onlineSince = 0L
            publishMobileState()
        }
    }

    @Volatile private var lastRunProfile: NodeProfile? = null

    /**
     * While [p] runs: 10 s after the start and then every 15 s, check that nothing answers on 127.0.0.1:18180.
     * With the API on its socket nothing should; if something does, the node is stopped and stays off.
     */
    private fun watchTcp(p: Process) = thread(name = "node-tcp-guard", isDaemon = true) {
        try {
            Thread.sleep(10_000)
            while (p.isAlive && !stopRequested) {
                if (NodeApi.tcpAnswers()) {
                    blockApi("while it ran")
                    return@thread
                }
                Thread.sleep(15_000)
            }
        } catch (_: InterruptedException) {
        }
    }

    /** Something answers on 127.0.0.1:18180 in socket mode: stop the node, say so in one line, don't restart it. */
    private fun blockApi(moment: String) {
        log.app("something answers on 127.0.0.1:${NodeFiles.API_PORT} ($moment); the node is stopped and not restarted")
        setStatus(NodeApi.TCP_BLOCK_LINE)
        stopRequested = true
        killNode()
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
            statsTick()
        }
    }
}

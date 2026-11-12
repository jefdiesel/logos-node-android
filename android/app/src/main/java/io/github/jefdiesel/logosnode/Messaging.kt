package io.github.jefdiesel.logosnode

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import java.security.SecureRandom
import java.time.LocalDate
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// The Logos Messaging (Waku) node: a second child process of the node service, off by default.
// The runner and the library come from the waku-build workflow (messaging/README.md). Plain
// Kotlin and org.json only, so it is unit-tested on a computer.

/** Every value the messaging node runs with, in one place. */
object MessagingSettings {
    const val MODE = "Core"
    const val PRESET = "logos.test"
    const val TCP_PORT = 60000
    const val DISCV5_UDP_PORT = 9000
    const val REST_PORT = 18645
    const val REST_ADDRESS = "127.0.0.1"
    const val WAKU_API = "http://$REST_ADDRESS:$REST_PORT"
    /** Seconds between the runner's status lines (traffic metrics come with every second one). */
    const val STATUS_EVERY_SECONDS = 15
    /** Stops the node for the rest of the day once its traffic (in + out) reaches this. */
    const val DAILY_CAP_BYTES = 2_000_000_000L
    /** Stop: SIGTERM, then SIGKILL after this many seconds (the library's stop takes about 20 s). */
    const val STOP_GRACE_SECONDS = 25L

    /**
     * More flat-shape options (top level, next to mode and preset), for a relay that costs less:
     * e.g. "shard" to [5], "filter" to false. Filled in from the measurements of what a smaller relay
     * costs; empty for now.
     */
    val EXTRA: Map<String, Any> = emptyMap()
}

/** The messaging node's folder, files/waku: config.json and nodekey (owner-only), data/, output.log. */
class MessagingFiles(val dir: File) {
    val config = File(dir, "config.json")
    val nodekey = File(dir, "nodekey")
    val data = File(dir, "data")
    val output = File(dir, "output.log")
    val usage = File(dir, "usage.txt")
    /** "running" while the runner runs (its REST API is up then), else "stopped: <reason>"; read by the wallet process. */
    val state = File(dir, "state.txt")

    fun mkdirs() {
        dir.mkdirs(); data.mkdirs()
    }

    /** The node's private key: 32 random bytes, hex, made once and kept. */
    fun nodeKey(random: SecureRandom = SecureRandom()): String {
        val existing = try { nodekey.readText().trim() } catch (_: Exception) { "" }
        if (KEY.matches(existing)) return existing
        val bytes = ByteArray(32).also { random.nextBytes(it) }
        val hex = bytes.joinToString("") { "%02x".format(it) }
        writePrivate(nodekey, hex + "\n")
        return hex
    }

    /**
     * Writes config.json (the library's flat shape) and checks it by parsing it back, so the library
     * never gets a file it can't parse: when it can't, it logs the whole file, key included.
     * Returns null when the file is good, or the problem (never the contents).
     */
    fun writeConfig(key: String): String? {
        val text = MessagingConfig.build(key, data.absolutePath)
        writePrivate(config, text)
        return MessagingConfig.problem(config.readText(), key)
    }

    companion object {
        val KEY = Regex("^[0-9a-f]{64}$")

        /** Writes a file readable and writable by this app only (0600). */
        fun writePrivate(file: File, text: String) {
            val tmp = File(file.path + ".tmp")
            tmp.delete()
            tmp.createNewFile()
            try {
                Files.setPosixFilePermissions(tmp.toPath(), setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
            } catch (_: Exception) {
                tmp.setReadable(false, false); tmp.setReadable(true, true)
                tmp.setWritable(false, false); tmp.setWritable(true, true)
            }
            tmp.writeText(text)
            if (!tmp.renameTo(file)) throw IllegalStateException("couldn't write ${file.name}")
        }
    }
}

object MessagingConfig {
    fun build(key: String, dataPath: String): String {
        val o = JSONObject()
        o.put("mode", MessagingSettings.MODE)
        o.put("preset", MessagingSettings.PRESET)
        o.put("nat", "none")                                        // never ask the router to open ports
        o.put("tcp-port", MessagingSettings.TCP_PORT)
        o.put("discv5-udp-port", MessagingSettings.DISCV5_UDP_PORT)
        o.put("rest", true)
        o.put("rest-address", MessagingSettings.REST_ADDRESS)
        o.put("rest-port", MessagingSettings.REST_PORT)
        o.put("local-storage-path", dataPath)
        o.put("nodekey", key)
        for ((k, v) in MessagingSettings.EXTRA) o.put(k, if (v is List<*>) JSONArray(v) else v)
        return o.toString(2) + "\n"
    }

    /** Null if `text` parses and holds what the node needs (flat shape, our key), else what is wrong. */
    fun problem(text: String, key: String): String? {
        val o = try { JSONObject(text) } catch (_: Exception) { return "the messaging config doesn't parse" }
        if (o.has("messagingOverrides")) return "the messaging config isn't in the flat shape"
        if (o.optString("mode") != MessagingSettings.MODE || o.optString("preset") != MessagingSettings.PRESET) return "the messaging config has the wrong mode or preset"
        if (o.optString("nodekey") != key || !MessagingFiles.KEY.matches(key)) return "the messaging config has no valid node key"
        if (o.optString("rest-address") != MessagingSettings.REST_ADDRESS || o.optInt("rest-port") != MessagingSettings.REST_PORT) return "the messaging config's REST address is wrong"
        if (o.optString("local-storage-path").isEmpty()) return "the messaging config has no storage path"
        return null
    }
}

/** What the runner reports, from its status and metric lines. */
data class MessagingStatus(
    val connection: String? = null,
    val peers: Int? = null,
    val rssKb: Long? = null,
    val bytesIn: Long? = null,
    val bytesOut: Long? = null,
)

object RunnerLines {
    // Every bracket and brace escaped: Android's regex engine (ICU) rejects a bare ']' or '}' that Java accepts.
    private val STATUS = Regex("""\[runner\] status connection=(\S+) connected_peers=(\d+) rss_kb=(\d+)""")
    private val BYTES = Regex("""\[runner\] metric libp2p_network_bytes(?:_total)?\{[^\}]*direction="(in|out)"[^\}]*\}\s+([0-9.eE+]+)""")

    /** The status after `line`, or the same status if the line says nothing about it. */
    fun apply(status: MessagingStatus, line: String): MessagingStatus {
        STATUS.find(line)?.let {
            return status.copy(connection = it.groupValues[1], peers = it.groupValues[2].toInt(), rssKb = it.groupValues[3].toLong())
        }
        BYTES.find(line)?.let {
            val v = it.groupValues[2].toDoubleOrNull()?.toLong() ?: return status
            return if (it.groupValues[1] == "in") status.copy(bytesIn = v) else status.copy(bytesOut = v)
        }
        return status
    }

    /** The line with the node key replaced, so it can't reach the log even if the library prints it. */
    fun redact(line: String, key: String?) = if (key != null && key.isNotEmpty()) line.replace(key, "<nodekey>") else line
}

/**
 * The messaging node's traffic today (local date), across runs, kept in usage.txt. The runner's
 * counters start at zero with each run; [record] adds what grew since the last reading.
 */
class DataUsage(private val file: File, private val today: () -> String = { LocalDate.now().toString() }) {
    var day = ""; private set
    var todayIn = 0L; private set
    var todayOut = 0L; private set
    private var lastIn = 0L
    private var lastOut = 0L

    init { load() }

    private fun load() {
        try {
            val m = file.readLines().mapNotNull { l -> l.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
            day = m["day"] ?: ""; todayIn = m["in"]?.toLong() ?: 0; todayOut = m["out"]?.toLong() ?: 0
        } catch (_: Exception) {
        }
        rollDay()
    }

    private fun rollDay() {
        val d = today()
        if (d != day) { day = d; todayIn = 0; todayOut = 0 }
    }

    /** A new run of the runner: its counters start again from zero. */
    fun newRun() { lastIn = 0; lastOut = 0 }

    @Synchronized
    fun record(totalIn: Long?, totalOut: Long?) {
        rollDay()
        if (totalIn != null) { todayIn += if (totalIn >= lastIn) totalIn - lastIn else totalIn; lastIn = totalIn }
        if (totalOut != null) { todayOut += if (totalOut >= lastOut) totalOut - lastOut else totalOut; lastOut = totalOut }
        try { file.writeText("day=$day\nin=$todayIn\nout=$todayOut\n") } catch (_: Exception) {}
    }

    fun todayTotal(): Long { rollDay(); return todayIn + todayOut }
    fun capReached(cap: Long = MessagingSettings.DAILY_CAP_BYTES) = todayTotal() >= cap
}

/** Whether the messaging node may run now, and if not, why (in words for the screen). */
object MessagingPolicy {
    fun blocker(enabled: Boolean, metered: Boolean?, allowMobile: Boolean, capReached: Boolean): String? = when {
        !enabled -> "off"
        capReached -> "today's data cap of ${mb(MessagingSettings.DAILY_CAP_BYTES)} is reached; it starts again tomorrow"
        metered == null -> "there is no network"
        metered && !allowMobile -> "the phone is on a metered network (mobile data); turn on \"Also use mobile data\" to run it there"
        else -> null
    }

    fun mb(bytes: Long): String = if (bytes >= 1_000_000_000) "%.2f GB".format(bytes / 1e9) else "%.1f MB".format(bytes / 1e6)
}

/**
 * Starts or stops the messaging node when the switch, the network or the day's data use changes.
 * The service calls [update]; [startRunner] and [stopRunner] are the supervisor's.
 */
class MessagingController(
    private val usage: DataUsage,
    private val isRunning: () -> Boolean,
    private val startRunner: () -> Unit,
    private val stopRunner: (reason: String) -> Unit,
) {
    /** Why it isn't running (null while it may run). */
    @Volatile var blocker: String? = "off"; private set

    @Synchronized
    fun update(enabled: Boolean, metered: Boolean?, allowMobile: Boolean) {
        val b = MessagingPolicy.blocker(enabled, metered, allowMobile, usage.capReached())
        blocker = b
        if (b == null) {
            if (!isRunning()) startRunner()
        } else if (isRunning()) {
            stopRunner(b)
        }
    }
}

/**
 * Runs the messaging runner as a child process and keeps it running (restart with a backoff), with
 * its own state, apart from the blockchain node. [launch] starts the runner on the config file.
 * Whatever happens here is caught here: it never reaches the node's supervisor or the wallet.
 */
class MessagingSupervisor(
    private val files: MessagingFiles,
    private val usage: DataUsage,
    private val launch: (config: File) -> Process,
    private val log: (String) -> Unit,
    private val onChange: () -> Unit = {},
    private val random: SecureRandom = SecureRandom(),
) {
    @Volatile var status = MessagingStatus(); private set
    /** "starting", "connected, N peers", "stopped: <reason>" ... for the screen. */
    @Volatile var state = "stopped: off"; private set
    @Volatile private var stopRequested = false
    @Volatile private var process: Process? = null
    private var worker: Thread? = null
    private var key: String? = null

    val running get() = worker?.isAlive == true

    @Synchronized
    fun start() {
        if (worker?.isAlive == true) return
        stopRequested = false
        worker = thread(name = "messaging-supervisor", isDaemon = true) {
            try {
                loop()
            } catch (e: Throwable) {
                // never leave a runner behind that nothing watches or can stop
                process?.let { p -> p.destroy(); if (!p.waitFor(MessagingSettings.STOP_GRACE_SECONDS, TimeUnit.SECONDS)) p.destroyForcibly() }
                process = null
                log("messaging: supervisor error: ${e.javaClass.simpleName}: ${e.message}")
                setState("stopped: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    /** Stops the runner (SIGTERM, then SIGKILL after STOP_GRACE_SECONDS) and the restarts. Blocks until done. */
    fun stop(reason: String) {
        stopRequested = true
        val p = process
        if (p != null) {
            log("messaging: stopping ($reason)")
            p.destroy()
            if (!p.waitFor(MessagingSettings.STOP_GRACE_SECONDS, TimeUnit.SECONDS)) {
                log("messaging: didn't stop in ${MessagingSettings.STOP_GRACE_SECONDS} s, killing it")
                p.destroyForcibly()
                p.waitFor(5, TimeUnit.SECONDS)
            }
        }
        worker?.interrupt()
        worker?.join(10_000)
        setState("stopped: $reason")
    }

    private fun setState(s: String) {
        state = s
        try { files.state.writeText(if (s == "starting" || s.startsWith("connected") || s.startsWith("running")) "running\n" else "$s\n") } catch (_: Exception) {}
        onChange()
    }

    private fun loop() {
        var backoff = 10L
        while (!stopRequested) {
            files.mkdirs()
            val k = files.nodeKey(random).also { key = it }
            files.writeConfig(k)?.let { problem ->
                log("messaging: not started, $problem")
                setState("stopped: $problem")
                return
            }
            if (usage.capReached()) {
                setState("stopped: today's data cap of ${MessagingPolicy.mb(MessagingSettings.DAILY_CAP_BYTES)} is reached")
                return
            }
            usage.newRun()
            status = MessagingStatus()
            setState("starting")
            val started = System.currentTimeMillis()
            val p = try { launch(files.config) } catch (e: Exception) {
                log("messaging: couldn't start the runner: $e")
                setState("stopped: couldn't start the runner")
                return
            }
            process = p
            log("messaging: started")
            try {
                p.inputStream.bufferedReader().forEachLine { raw -> onLine(raw) }
            } catch (_: Exception) {
            }
            val code = p.waitFor()
            process = null
            if (stopRequested) return
            if (System.currentTimeMillis() - started > 10 * 60_000) backoff = 10
            log("messaging: the runner exited (code $code); restarting in $backoff s")
            setState("stopped: exited (code $code), restarting in $backoff s")
            try { Thread.sleep(backoff * 1000) } catch (_: InterruptedException) { return }
            backoff = minOf(backoff * 2, 300)
        }
    }

    private fun onLine(raw: String) {
        val line = RunnerLines.redact(raw, key)
        appendCapped(line)
        val next = RunnerLines.apply(status, line)
        if (next == status) return
        status = next
        if (next.bytesIn != null || next.bytesOut != null) usage.record(next.bytesIn, next.bytesOut)
        val c = next.connection
        setState(if (c != null && c.contains("Connected") && !c.startsWith("Dis")) "connected, ${next.peers ?: 0} peers" else "starting")
        if (usage.capReached() && !stopRequested) {
            // stop from another thread: this one is reading the runner's output
            thread(name = "messaging-cap") { stop("today's data cap of ${MessagingPolicy.mb(MessagingSettings.DAILY_CAP_BYTES)} is reached") }
        }
    }

    private fun appendCapped(line: String) {
        try {
            if (files.output.length() > 2L * 1024 * 1024) {
                val old = File(files.output.path + ".1"); old.delete(); files.output.renameTo(old)
            }
            files.output.appendText(line + "\n")
        } catch (_: Exception) {
        }
    }
}

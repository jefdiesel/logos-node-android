package io.github.jefdiesel.logosnode

import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Mobile mode (android/BATTERY.md): On (the default) runs the node on the light profile, which only cuts what
 * the node sends to other nodes; Off runs the node's own defaults. A change applies the next time the node
 * starts, or at once with "Restart node now"; the app never restarts the node by itself for it. Everything
 * here is plain logic, without Android, so it is unit-tested (BatteryTest).
 */

/** The user's setting. ON is the default. */
enum class MobileMode(val key: String) {
    ON("on"), OFF("off");

    companion object {
        /** "auto" and "light" are the earlier test build's names for On. */
        fun parse(text: String?): MobileMode? = when (text?.trim()) {
            "on", "auto", "light" -> ON
            "off" -> OFF
            else -> null
        }
        val DEFAULT = ON
    }
}

/** The node config in use. */
enum class NodeProfile(val key: String) { FULL("full"), LIGHT("light") }

object MobilePolicy {
    /** On: light, unless the light config failed on this phone (then full until the setting changes). Off: full. */
    fun profile(mode: MobileMode, lightFailed: Boolean): NodeProfile =
        if (mode == MobileMode.ON && !lightFailed) NodeProfile.LIGHT else NodeProfile.FULL

    /** Why, in words, for the screens and the stats file. */
    fun why(mode: MobileMode, lightFailed: Boolean): String = when {
        mode == MobileMode.OFF -> "mobile mode is off"
        lightFailed -> "the light config failed on this phone, so the node's defaults"
        else -> "mobile mode is on"
    }
}

/**
 * "Restart node now" (the user's tap, never automatic): why it is refused, or null to restart. A restart
 * replays the stored blocks (about half a minute of CPU) and the node is not Online for about a minute, so
 * not while the wallet is busy with the node, and not before the node has been Online for a while (it saves
 * its state once a minute; a restart before a saved Online state starts the one-hour bootstrap wait again).
 */
object RestartNow {
    const val ONLINE_SETTLE_MS = 90_000L

    fun refusal(running: Boolean, otherJob: Boolean, pending: Boolean, busy: String?, onlineForMs: Long): String? = when {
        !running -> "The node isn't running. It uses the setting when it starts."
        otherJob -> "A snapshot import or a stop is running."
        !pending -> "The node already runs this setting."
        busy != null -> "Not now: $busy. Try again when it has finished."
        onlineForMs < ONLINE_SETTLE_MS -> "Not yet: the node isn't online long enough, and a restart now would make it wait again. Try again in a few minutes."
        else -> null
    }
}

/**
 * The node config levers per profile. The light profile holds only levers that, by the node's and
 * libp2p's source (BATTERY.md gives the file and line of each), change what the node sends TO OTHERS and
 * nothing it receives, checks or publishes itself: the user's rule is no loss of quality at all.
 * The gossipsub mesh size is NOT changed: the mesh is how blocks reach this phone. It can be tried per
 * phone through profile.txt (BATTERY.md, "Options with a cost").
 */
object NodeProfileConfig {
    /**
     * Light: unsolicited IHAVE gossip from this phone to 3 peers per heartbeat instead of a quarter of all
     * its peers (gossipsub emit_gossip only), and one block download served to others at a time instead of 10.
     */
    val LIGHT: Map<String, String> = linkedMapOf(
        "gossip_lazy" to "3", "gossip_factor" to "0.0",
        "max_inbound_requests" to "1",
    )
    val FULL: Map<String, String> = emptyMap()                 // the node's own defaults, as before

    private val GOSSIP_INTS = setOf("mesh_n", "mesh_n_low", "mesh_n_high", "mesh_outbound_min", "gossip_lazy")
    val KEYS = GOSSIP_INTS + setOf("gossip_factor", "max_inbound_requests")

    /**
     * The values for [profile], with the per-phone test overrides from files/node/profile.txt (lines like
     * `light.mesh_n=3` or `full.max_inbound_requests=2`; unknown keys and bad values are ignored). Null if the
     * result breaks gossipsub's own rule (outbound_min <= low <= n <= high, 2*outbound_min <= n), which would
     * stop the node at start-up.
     */
    fun values(profile: NodeProfile, overrides: List<String> = emptyList()): Map<String, String>? {
        val base = LinkedHashMap(if (profile == NodeProfile.LIGHT) LIGHT else FULL)
        for (line in overrides) {
            val (k, v) = line.split('=', limit = 2).map { it.trim() }.takeIf { it.size == 2 } ?: continue
            val key = k.removePrefix(profile.key + ".").takeIf { k.startsWith(profile.key + ".") } ?: continue
            if (key !in KEYS) continue
            val ok = when (key) {
                "gossip_factor" -> v.toDoubleOrNull()?.let { it in 0.0..1.0 } == true
                "max_inbound_requests" -> v.toIntOrNull()?.let { it in 1..64 } == true
                else -> v.toIntOrNull()?.let { it in 1..64 } == true
            }
            if (ok) base[key] = v
        }
        val mesh = listOf("mesh_n", "mesh_n_low", "mesh_n_high", "mesh_outbound_min")
        if (mesh.any { it in base }) {
            // any mesh value set means all four are written, with the node's defaults (6, 5, 12, 2) for the rest
            val n = base["mesh_n"]?.toInt() ?: 6; val lo = base["mesh_n_low"]?.toInt() ?: 5
            val hi = base["mesh_n_high"]?.toInt() ?: 12; val out = base["mesh_outbound_min"]?.toInt() ?: 2
            if (!(out <= lo && lo <= n && n <= hi) || out * 2 > n) return null
            base["mesh_n"] = "$n"; base["mesh_n_low"] = "$lo"; base["mesh_n_high"] = "$hi"; base["mesh_outbound_min"] = "$out"
        }
        return base
    }

    /** The lines that go under `network: backend:` (4-space indented), or none for the node's defaults. */
    fun swarmLines(values: Map<String, String>): List<String> {
        val gossip = values.filterKeys { it != "max_inbound_requests" }
        val sync = values["max_inbound_requests"]
        if (gossip.isEmpty() && sync == null) return emptyList()
        return listOf("    swarm:") +
            (if (gossip.isEmpty()) emptyList() else listOf("      gossipsub:") + gossip.map { (k, v) -> "        $k: $v" }) +
            (if (sync == null) emptyList() else listOf("      chain_sync:", "        max_inbound_requests: $sync"))
    }
}

/**
 * Whether the wallet is using the node right now, from the wallet's own files (server.py writes them; this
 * app only reads them): a bridge in progress, a send not yet in a block, or a running name change (the
 * `names` signer process). Null when it is free. Old entries don't count, so a
 * record stuck at "pending" can't hold the node on one profile forever.
 */
object WalletBusy {
    /** server.py's BRIDGE_ACTIVE */
    val BRIDGE_ACTIVE = setOf("splitting", "ready", "depositing", "sent")
    const val SEND_MAX_AGE_MS = 60 * 60_000L
    const val BRIDGE_MAX_AGE_MS = 2 * 60 * 60_000L

    fun reason(bridgeJson: String?, historyJson: String?, namesRunning: Boolean, now: Long): String? {
        if (namesRunning) return "a name change is running"
        try {
            if (bridgeJson != null) {
                val b = JSONObject(bridgeJson)
                val updatedMs = (b.optDouble("updated", 0.0) * 1000).toLong()
                if (b.optString("state") in BRIDGE_ACTIVE && now - updatedMs < BRIDGE_MAX_AGE_MS) return "a bridge is in progress"
            }
        } catch (_: Exception) {}
        try {
            if (historyJson != null) {
                val entries = JSONObject(historyJson).optJSONArray("entries")
                if (entries != null) for (i in entries.length() - 1 downTo maxOf(0, entries.length() - 200)) {
                    val e = entries.optJSONObject(i) ?: continue
                    if (e.optString("kind") != "sent" || e.optString("status") != "pending") continue
                    val t = parseTime(e.optString("time")) ?: continue
                    if (now - t < SEND_MAX_AGE_MS) return "a send is waiting for its block"
                }
            }
        } catch (_: Exception) {}
        return null
    }

    /** server.py's history time, "2026-11-13T00:30:00Z" (UTC). */
    fun parseTime(text: String): Long? = try {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(text)?.time
    } catch (_: Exception) {
        null
    }
}

/** CPU time of a process from /proc/<pid>/stat: utime + stime, in clock ticks. */
object ProcCpu {
    fun ticks(statLine: String): Long? {
        // fields after the command name, which is in parentheses and may hold spaces
        val rest = statLine.substringAfterLast(") ", "").split(' ')
        // rest[0] is field 3 (state); utime is field 14, stime field 15
        val u = rest.getOrNull(11)?.toLongOrNull() ?: return null
        val s = rest.getOrNull(12)?.toLongOrNull() ?: return null
        return u + s
    }

    fun ticksOf(pid: Int): Long? = try { ticks(File("/proc/$pid/stat").readText()) } catch (_: Exception) { null }
}

/**
 * The measurement counters, files/node/battery-stats.txt (key=value lines), for reading over adb: time,
 * CPU of each child, the app's network bytes, and the node's log lines, each split by profile, plus the
 * switches, waits and the node's last peers/height/state. Kept across service restarts; reset with the
 * MOBILE_MODE action's `--ez reset true`.
 */
class BatteryStats(private val file: File) {
    val values = LinkedHashMap<String, String>()

    init { load() }

    private fun load() {
        try {
            file.readLines().forEach { l -> l.split('=', limit = 2).takeIf { it.size == 2 }?.let { values[it[0]] = it[1] } }
        } catch (_: Exception) {}
    }

    @Synchronized fun reset() { values.clear(); set("reset_at", System.currentTimeMillis().toString()) }
    @Synchronized fun set(key: String, value: Any?) { values[key] = value?.toString() ?: "" }
    @Synchronized fun add(key: String, delta: Long) { if (delta > 0) values[key] = ((values[key]?.toLongOrNull() ?: 0L) + delta).toString() }
    @Synchronized fun get(key: String): Long = values[key]?.toLongOrNull() ?: 0L

    @Synchronized fun save() {
        try {
            val tmp = File(file.path + ".tmp")
            tmp.writeText(values.entries.joinToString("\n", postfix = "\n") { "${it.key}=${it.value}" })
            tmp.renameTo(file)
        } catch (_: Exception) {}
    }
}

/**
 * Quality: at each opening of the wallet screen, how long until the node answers Online (when the wallet
 * can send), with the age of its latest block then. One line per opening in files/node/open-times.txt.
 */
object OpenTimer {
    private val running = java.util.concurrent.atomic.AtomicBoolean(false)
    const val LIMIT_MS = 180_000L

    private fun get(path: String): JSONObject? = try {
        val c = java.net.URL("http://127.0.0.1:${NodeFiles.API_PORT}$path").openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 2000; c.readTimeout = 4000
        try { if (c.responseCode == 200) JSONObject(c.inputStream.bufferedReader().readText()) else null } finally { c.disconnect() }
    } catch (_: Exception) {
        null
    }

    /** "Online, tip 12 s old", "Bootstrapping, ...", or "no answer". */
    private fun probe(): Pair<String?, Long?> {
        val i = get("/cryptarchia/info")?.let { it.optJSONObject("cryptarchia_info") ?: it } ?: return null to null
        val t = get("/time/info")
        val tip = i.optLong("slot", -1L); val cur = t?.optLong("current_slot", -1L) ?: -1L
        val ms = t?.optLong("slot_duration_ms", 1000L)?.takeIf { it > 0 } ?: 1000L
        return i.optString("state") to (if (tip >= 0 && cur >= 0) maxOf(0L, cur - tip) * ms / 1000 else null)
    }

    fun line(atOpen: Pair<String?, Long?>, usableMs: Long?, then: Pair<String?, Long?>, profile: String): String {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(java.util.Date())
        fun s(p: Pair<String?, Long?>) = "${p.first ?: "no answer"}, tip ${p.second?.let { "$it s" } ?: "?"} old"
        return "$iso profile=$profile at_open=[${s(atOpen)}] " +
            (if (usableMs != null) "online_after_ms=$usableMs then=[${s(then)}]" else "not online within ${LIMIT_MS / 1000} s")
    }

    fun measure(files: NodeFiles) {
        if (!running.compareAndSet(false, true)) return
        try {
            val t0 = System.currentTimeMillis()
            val profile = try { JSONObject(files.mobileState.readText()).optString("profile") } catch (_: Exception) { "" }
            val first = probe()
            var now = first
            while (now.first != "Online" && System.currentTimeMillis() - t0 < LIMIT_MS) {
                Thread.sleep(1000)
                now = probe()
            }
            val ms = if (now.first == "Online") System.currentTimeMillis() - t0 else null
            val f = File(files.home, "open-times.txt")
            if (f.length() > 256 * 1024) f.delete()
            f.appendText(line(first, ms, now, profile) + "\n")
        } catch (_: Exception) {
        } finally {
            running.set(false)
        }
    }
}

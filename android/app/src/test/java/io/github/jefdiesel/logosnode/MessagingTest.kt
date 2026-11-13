package io.github.jefdiesel.logosnode

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom

class MessagingTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun files() = MessagingFiles(tmp.newFolder("waku")).apply { mkdirs() }
    private fun perms(f: File) = PosixFilePermissions.toString(Files.getPosixFilePermissions(f.toPath()))

    // ---- config ----

    @Test fun configIsFlatParsesBackAndIsPrivate() {
        val f = files()
        val key = f.nodeKey()
        assertNull(f.writeConfig(key))
        val o = JSONObject(f.config.readText())
        assertFalse(o.has("messagingOverrides"))
        assertEquals("Core", o.getString("mode")); assertEquals("logos.test", o.getString("preset"))
        // the library's REST API (TCP, reachable by any app) stays off: the runner's own socket instead
        assertEquals(false, o.getBoolean("rest")); assertFalse(o.has("rest-address")); assertFalse(o.has("rest-port"))
        assertEquals("none", o.getString("nat"))
        assertEquals(key, o.getString("nodekey"))
        assertEquals(f.data.absolutePath, o.getString("local-storage-path"))
        // the one-shard relay, at the top level (rc3 ignores these in the structured shape)
        assertEquals("[7]", o.getJSONArray("shard").toString())
        assertEquals(false, o.getBoolean("filter")); assertEquals(false, o.getBoolean("lightpush"))
        assertEquals("rw-------", perms(f.config))
        assertEquals("rw-------", perms(f.nodekey))
    }

    @Test fun configProblemsAreFoundAndNeverQuoteTheFile() {
        val key = "ab".repeat(32)
        val good = MessagingConfig.build(key, "/data")
        assertNull(MessagingConfig.problem(good, key))
        for (bad in listOf(good.dropLast(3), "{\"mode\":\"Core\",\"preset\":\"logos.test\",\"messagingOverrides\":{\"nodekey\":\"$key\"}}",
            good.replace("logos.test", "logos.dev"), good.replace(key, "cd".repeat(32)), JSONObject(good).apply { put("rest", true) }.toString(),
            JSONObject(good).apply { remove("rest") }.toString(), JSONObject(good).apply { put("rest-port", 18645) }.toString(),
            JSONObject(good).apply { remove("shard") }.toString(), JSONObject(good).apply { put("filter", true) }.toString())) {
            val p = MessagingConfig.problem(bad, key)
            assertNotNull(p)
            assertFalse("problem text must not carry the key: $p", p!!.contains(key))
        }
    }

    @Test fun apiSocketFolderIsPrivate() {
        val f = files()
        f.privateApiDir()
        assertEquals("rwx------", perms(f.apiDir))
        assertTrue(f.wakuApi.startsWith("unix:/") && f.wakuApi.endsWith("/api/api.sock"))
    }

    @Test fun nodeKeyIsMadeOnceAndKept() {
        val f = files()
        val k1 = f.nodeKey()
        assertTrue(MessagingFiles.KEY.matches(k1))
        assertEquals(k1, f.nodeKey(SecureRandom()))
        assertEquals(k1, MessagingFiles(f.dir).nodeKey())
        f.nodekey.writeText("not a key")                    // a damaged key file is replaced
        assertTrue(MessagingFiles.KEY.matches(f.nodeKey()))
    }

    // ---- runner lines ----

    @Test fun statusAndTrafficLines() {
        var s = MessagingStatus()
        s = RunnerLines.apply(s, "2026-11-12T15:00:00Z [runner] status connection=Connected connected_peers=28 rss_kb=133000 hwm_kb=140000 threads=20 received=0 sent=0 propagated=0 send_errors=0")
        assertEquals("Connected", s.connection); assertEquals(28, s.peers); assertEquals(133000L, s.rssKb)
        s = RunnerLines.apply(s, "2026-11-12T15:00:00Z [runner] metric libp2p_network_bytes_total{direction=\"in\"} 4.9e+07")
        s = RunnerLines.apply(s, "2026-11-12T15:00:00Z [runner] metric libp2p_network_bytes_total{direction=\"out\"} 31000000.0")
        s = RunnerLines.apply(s, "2026-11-12T15:00:00Z [runner] metric libp2p_network_bytes_created{direction=\"in\"} 1.7e9")
        assertEquals(49_000_000L, s.bytesIn); assertEquals(31_000_000L, s.bytesOut)
        assertEquals("x <nodekey> y", RunnerLines.redact("x ${"ab".repeat(32)} y", "ab".repeat(32)))
    }

    // ---- data use ----

    @Test fun dataUseAddsAcrossRunsAndStartsAgainEachDay() {
        var day = "2026-11-12"
        val file = File(tmp.root, "usage.txt")
        val u = DataUsage(file) { day }
        u.newRun(); u.record(100, 50); u.record(300, 70)
        u.newRun(); u.record(40, 10)                              // a new run's counters start at zero
        assertEquals(340L, u.todayIn); assertEquals(80L, u.todayOut)
        assertEquals(420L, DataUsage(file) { day }.todayTotal())  // kept on disk
        day = "2026-11-13"
        assertEquals(0L, u.todayTotal())
    }

    // ---- policy and controller ----

    @Test fun meteredNetworkStopsIt() {
        val u = DataUsage(File(tmp.root, "u1.txt"))
        var running = false
        val stops = mutableListOf<String>()
        val c = MessagingController(u, { running }, { running = true }, { stops += it; running = false })
        c.update(enabled = true, metered = false, allowMobile = false)
        assertTrue(running)
        c.update(enabled = true, metered = true, allowMobile = false)  // Wi-Fi gone, on mobile data
        assertFalse(running)
        assertTrue(stops.single().contains("metered"))
        c.update(enabled = true, metered = true, allowMobile = true)   // "Also use mobile data" on
        assertTrue(running)
        c.update(enabled = false, metered = false, allowMobile = true)
        assertFalse(running); assertEquals("off", c.blocker)
    }

    @Test fun capStopsItAndKeepsItOffForTheDay() {
        val u = DataUsage(File(tmp.root, "u2.txt")) { "2026-11-12" }
        u.newRun(); u.record(MessagingSettings.DAILY_CAP_BYTES, 0)
        var running = true
        val stops = mutableListOf<String>()
        val c = MessagingController(u, { running }, { running = true }, { stops += it; running = false })
        c.update(enabled = true, metered = false, allowMobile = false)
        assertFalse(running)
        assertTrue(stops.single().contains("data cap"))
    }

    // ---- the supervisor, with real child processes (sh) ----

    private fun runner(script: String): (File) -> Process = { ProcessBuilder("sh", "-c", script).redirectErrorStream(true).start() }

    private fun waitFor(what: String, seconds: Int = 15, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + seconds * 1000
        while (!cond()) {
            if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what")
            Thread.sleep(50)
        }
    }

    @Test fun supervisorNeverLogsTheKey() {
        val f = files()
        val key = f.nodeKey()
        val logs = mutableListOf<String>()
        val s = MessagingSupervisor(f, DataUsage(File(tmp.root, "u3.txt")),
            runner("echo \"config parse error: {\\\"nodekey\\\": \\\"$key\\\"}\"; " +
                "echo '2026-11-12T15:00:00Z [runner] status connection=Connected connected_peers=3 rss_kb=1000'; exec sleep 30"),
            log = { synchronized(logs) { logs += it } })
        s.start()
        waitFor("connected") { s.state.startsWith("running: Connected") }
        assertEquals("running: Connected, 3 peers", s.state)
        assertEquals("running", f.state.readText().trim())
        s.stop("test over")
        val out = f.output.readText()
        assertTrue(out.contains("<nodekey>"))
        assertFalse(out.contains(key))
        assertFalse(logs.any { it.contains(key) })
        assertEquals("stopped: test over", s.state)
        assertTrue(f.state.readText().startsWith("stopped"))
    }

    @Test fun trafficRateIsReported() {
        val f = files()
        val logs = java.util.Collections.synchronizedList(mutableListOf<String>())
        val m = "2026-11-12T15:00:00Z [runner] metric libp2p_network_bytes_total"
        val s = MessagingSupervisor(f, DataUsage(File(tmp.root, "u8.txt")),
            runner("echo '$m{direction=\"in\"} 1000000'; echo '$m{direction=\"out\"} 500000'; sleep 1; " +
                "echo '$m{direction=\"in\"} 1500000'; echo '$m{direction=\"out\"} 750000'; exec sleep 30"),
            log = { logs += it })
        s.start()
        waitFor("rates") { s.status.inPerMinute != null && s.status.outPerMinute != null }
        // 0.5 MB in and 0.25 MB out in about a second: tens of MB a minute, the right order
        assertTrue(s.status.inPerMinute!! in 10_000_000L..40_000_000L)
        assertTrue(s.status.outPerMinute!! in 5_000_000L..20_000_000L)
        assertTrue(logs.any { it.startsWith("messaging: traffic ") })
        s.stop("test over")
    }

    @Test fun capReachedWhileRunningStopsTheRunner() {
        val f = files()
        val s = MessagingSupervisor(f, DataUsage(File(tmp.root, "u4.txt")),
            runner("echo '2026-11-12T15:00:00Z [runner] metric libp2p_network_bytes_total{direction=\"in\"} 2.5e9'; exec sleep 60"),
            log = {})
        s.start()
        waitFor("cap stop", 40) { s.state.contains("data cap") && !s.running }
    }

    @Test fun stuckSupervisorIsSeenAndRestarted() {
        // the phone case: the supervisor loses its runner and stops reading, while the runner keeps running
        val procs = java.util.Collections.synchronizedList(mutableListOf<Process>())
        val s = MessagingSupervisor(files(), DataUsage(File(tmp.root, "u6.txt")),
            { ProcessBuilder("sh", "-c", "while true; do echo '2026-11-12T15:00:00Z [runner] status connection=Connected connected_peers=1 rss_kb=1'; sleep 0.2; done")
                .redirectErrorStream(true).start().also { procs += it } },
            log = {})
        s.start()
        waitFor("connected") { s.state.startsWith("running: Connected") }
        assertTrue(s.ownsRunner); assertFalse(s.stuck)
        s.debugAbandon = true
        waitFor("stuck") { s.stuck }
        assertTrue(s.running)                             // the thread is alive, which is why "running" isn't enough
        assertFalse(s.ownsRunner)                         // so the service's guard treats the runner as an orphan
        assertTrue(procs[0].isAlive)
        assertTrue(s.recoverIfStuck())
        waitFor("relaunched") { procs.size == 2 && s.ownsRunner }
        assertFalse(s.stuck)
        assertFalse(s.recoverIfStuck())
        s.stop("test over")
        assertFalse(s.ownsRunner)
        procs.forEach { it.destroyForcibly() }
    }

    @Test fun guardKillsOnlyTheOrphansItFound() {
        // the phone case: orphan 101 found; while the guard waits, a new supervisor starts runner 202
        val alive = mutableListOf(101)
        val signals = mutableListOf<Pair<Int, Int>>()
        var slept = 0
        val hit = OrphanGuard.pass(
            owned = { false },
            runnerPids = { alive.toList() },
            signal = { pid, sig -> signals += pid to sig },
            graceMs = 1_000,
            sleep = { slept++; if (slept == 1) alive += 202 },     // 101 ignores SIGTERM; 202 appears
        )
        assertEquals(listOf(101), hit)
        assertEquals(listOf(101 to 15, 101 to 9), signals)          // never a signal for 202
    }

    @Test fun guardLeavesAnOwnedRunnerAlone() {
        val signals = mutableListOf<Pair<Int, Int>>()
        assertTrue(OrphanGuard.pass({ true }, { listOf(7) }, { p, s -> signals += p to s }).isEmpty())
        assertTrue(signals.isEmpty())
        // an orphan that goes on SIGTERM gets no SIGKILL
        val alive = mutableListOf(8)
        OrphanGuard.pass({ false }, { alive.toList() }, { p, s -> signals += p to s; if (s == 15) alive.remove(p) }, sleep = {})
        assertEquals(listOf(8 to 15), signals)
    }

    @Test fun aStartingSupervisorOwnsItsRunnerFromTheStart() {
        val f = files()
        val proc = java.util.concurrent.atomic.AtomicReference<Process>()
        val s = MessagingSupervisor(f, DataUsage(File(tmp.root, "u7.txt")),
            { Thread.sleep(1500); ProcessBuilder("sh", "-c", "exec sleep 30").start().also { proc.set(it) } },
            log = {})
        s.start()
        assertTrue("owned while it starts, before any process exists", s.ownsRunner)
        assertFalse(s.stuck)
        waitFor("launched") { proc.get() != null }
        assertTrue(s.ownsRunner)
        s.stop("test over")
        assertFalse(s.ownsRunner)
    }

    @Test fun supervisorIsIndependentOfOtherProcesses() {
        // the "blockchain node": a separate child the messaging supervisor knows nothing about
        val node = ProcessBuilder("sh", "-c", "sleep 60").start()
        val f = files()
        var launches = 0
        val s = MessagingSupervisor(f, DataUsage(File(tmp.root, "u5.txt")),
            { launches++; if (launches == 1) ProcessBuilder("sh", "-c", "exit 9").start() else throw IllegalStateException("launch failed") },
            log = {})
        s.start()
        // the runner died at once (like kill -9); the restart then failed to launch: both stay inside the supervisor
        waitFor("restart attempt", 30) { launches >= 2 && !s.running }
        assertTrue(s.state.startsWith("stopped"))
        assertTrue("the other process is untouched", node.isAlive)
        node.destroy()
    }
}

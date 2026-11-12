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
        assertEquals(true, o.getBoolean("rest")); assertEquals("127.0.0.1", o.getString("rest-address"))
        assertEquals(18645, o.getInt("rest-port")); assertEquals("none", o.getString("nat"))
        assertEquals(key, o.getString("nodekey"))
        assertEquals(f.data.absolutePath, o.getString("local-storage-path"))
        assertEquals("rw-------", perms(f.config))
        assertEquals("rw-------", perms(f.nodekey))
    }

    @Test fun configProblemsAreFoundAndNeverQuoteTheFile() {
        val key = "ab".repeat(32)
        val good = MessagingConfig.build(key, "/data")
        assertNull(MessagingConfig.problem(good, key))
        for (bad in listOf(good.dropLast(3), "{\"mode\":\"Core\",\"preset\":\"logos.test\",\"messagingOverrides\":{\"nodekey\":\"$key\"}}",
            good.replace("logos.test", "logos.dev"), good.replace(key, "cd".repeat(32)), good.replace("18645", "8090"))) {
            val p = MessagingConfig.problem(bad, key)
            assertNotNull(p)
            assertFalse("problem text must not carry the key: $p", p!!.contains(key))
        }
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
        waitFor("connected") { s.state.startsWith("connected") }
        assertEquals("connected, 3 peers", s.state)
        assertEquals("running", f.state.readText().trim())
        s.stop("test over")
        val out = f.output.readText()
        assertTrue(out.contains("<nodekey>"))
        assertFalse(out.contains(key))
        assertFalse(logs.any { it.contains(key) })
        assertEquals("stopped: test over", s.state)
        assertTrue(f.state.readText().startsWith("stopped"))
    }

    @Test fun capReachedWhileRunningStopsTheRunner() {
        val f = files()
        val s = MessagingSupervisor(f, DataUsage(File(tmp.root, "u4.txt")),
            runner("echo '2026-11-12T15:00:00Z [runner] metric libp2p_network_bytes_total{direction=\"in\"} 2.5e9'; exec sleep 60"),
            log = {})
        s.start()
        waitFor("cap stop", 40) { s.state.contains("data cap") && !s.running }
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

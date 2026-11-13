package io.github.jefdiesel.logosnode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BatteryTest {
    @get:Rule val tmp = TemporaryFolder()

    // ---- the setting: which profile ----

    @Test fun onIsLightOffIsFull() {
        assertEquals(NodeProfile.LIGHT, MobilePolicy.profile(MobileMode.ON, lightFailed = false))
        assertEquals(NodeProfile.FULL, MobilePolicy.profile(MobileMode.OFF, lightFailed = false))
        // a light config the node refused (or kept stopping on): full until the setting changes
        assertEquals(NodeProfile.FULL, MobilePolicy.profile(MobileMode.ON, lightFailed = true))
    }

    @Test fun modeParsesAndDefaultsToOn() {
        assertEquals(MobileMode.ON, MobileMode.DEFAULT)
        assertEquals(MobileMode.OFF, MobileMode.parse(" off\n"))
        assertEquals(MobileMode.ON, MobileMode.parse("on"))
        // the earlier test build's names
        assertEquals(MobileMode.ON, MobileMode.parse("auto"))
        assertEquals(MobileMode.ON, MobileMode.parse("light"))
        assertNull(MobileMode.parse("saver"))
        assertNull(MobileMode.parse(null))
    }

    @Test fun whyReadsRight() {
        assertEquals("mobile mode is on", MobilePolicy.why(MobileMode.ON, false))
        assertEquals("mobile mode is off", MobilePolicy.why(MobileMode.OFF, true))
        assertTrue(MobilePolicy.why(MobileMode.ON, true).contains("failed"))
    }

    // ---- "Restart node now": only on the user's tap, and not when it would cost them ----

    @Test fun restartNowOnlyWhenSafe() {
        val ok = RestartNow.ONLINE_SETTLE_MS
        assertNull(RestartNow.refusal(running = true, otherJob = false, pending = true, busy = null, onlineForMs = ok))
        assertNotNull(RestartNow.refusal(running = false, otherJob = false, pending = true, busy = null, onlineForMs = ok))
        assertNotNull(RestartNow.refusal(running = true, otherJob = true, pending = true, busy = null, onlineForMs = ok))
        assertNotNull(RestartNow.refusal(running = true, otherJob = false, pending = false, busy = null, onlineForMs = ok))
        val busy = RestartNow.refusal(running = true, otherJob = false, pending = true, busy = "a bridge is in progress", onlineForMs = ok)
        assertTrue(busy!!, busy.contains("a bridge is in progress"))
        // Online only just now, or not Online: a restart would start the bootstrap wait again
        assertNotNull(RestartNow.refusal(running = true, otherJob = false, pending = true, busy = null, onlineForMs = ok - 1))
        assertNotNull(RestartNow.refusal(running = true, otherJob = false, pending = true, busy = null, onlineForMs = -1))
    }

    // ---- the light config ----

    @Test fun lightChangesOnlyWhatTheNodeSendsToOthers() {
        val v = NodeProfileConfig.values(NodeProfile.LIGHT)!!
        assertEquals(mapOf("gossip_lazy" to "3", "gossip_factor" to "0.0", "max_inbound_requests" to "1"), v)
        // the mesh (how blocks reach the phone) is untouched
        assertFalse(v.keys.any { it.startsWith("mesh_") })
        assertEquals(emptyMap<String, String>(), NodeProfileConfig.values(NodeProfile.FULL))
        assertEquals(emptyList<String>(), NodeProfileConfig.swarmLines(NodeProfileConfig.values(NodeProfile.FULL)!!))
    }

    @Test fun lightLinesSitUnderNetworkBackend() {
        val lines = NodeProfileConfig.swarmLines(NodeProfileConfig.values(NodeProfile.LIGHT)!!)
        assertEquals(
            listOf(
                "    swarm:", "      gossipsub:", "        gossip_lazy: 3", "        gossip_factor: 0.0",
                "      chain_sync:", "        max_inbound_requests: 1",
            ),
            lines,
        )
    }

    @Test fun overridesAreCheckedAgainstGossipsubsRules() {
        // a valid smaller mesh, for a measured run (all four mesh values are then written)
        val v = NodeProfileConfig.values(NodeProfile.LIGHT, listOf("light.mesh_n=4", "light.mesh_n_low=3", "light.mesh_n_high=6"))!!
        assertEquals("4", v["mesh_n"]); assertEquals("3", v["mesh_n_low"]); assertEquals("6", v["mesh_n_high"]); assertEquals("2", v["mesh_outbound_min"])
        // mesh_n 3 with the default outbound minimum 2 breaks 2*outbound <= n: refused, so the caller uses the defaults
        assertNull(NodeProfileConfig.values(NodeProfile.LIGHT, listOf("light.mesh_n=3", "light.mesh_n_low=2")))
        // low above n
        assertNull(NodeProfileConfig.values(NodeProfile.LIGHT, listOf("light.mesh_n_low=7")))
        // other profile's keys, unknown keys and bad values are ignored
        val w = NodeProfileConfig.values(NodeProfile.LIGHT, listOf("full.gossip_lazy=9", "light.node_key=abc", "light.gossip_factor=2", "light.max_inbound_requests=0", "junk"))!!
        assertEquals(NodeProfileConfig.LIGHT, w)
        assertEquals(mapOf("max_inbound_requests" to "4"), NodeProfileConfig.values(NodeProfile.FULL, listOf("full.max_inbound_requests=4")))
    }

    // ---- the wallet is busy ----

    private val now = WalletBusy.parseTime("2026-11-13T01:00:00Z")!!

    @Test fun walletBusyFromItsFiles() {
        assertNull(WalletBusy.reason(null, null, false, now))
        assertEquals("a name change is running", WalletBusy.reason(null, null, true, now))
        val bridge = """{"id":"b1","state":"depositing","from":"aa","updated":${(now - 5 * 60_000) / 1000.0}}"""
        assertEquals("a bridge is in progress", WalletBusy.reason(bridge, null, false, now))
        val oldBridge = """{"id":"b1","state":"sent","updated":${(now - 3 * 60 * 60_000) / 1000.0}}"""
        assertNull(WalletBusy.reason(oldBridge, null, false, now))
        assertNull(WalletBusy.reason("""{"id":"b1","state":"done","updated":${now / 1000.0}}""", null, false, now))
        val hist = """{"version":1,"entries":[{"id":1,"time":"2026-11-13T00:50:00Z","kind":"sent","status":"pending"}],"snapshot":{}}"""
        assertEquals("a send is waiting for its block", WalletBusy.reason(null, hist, false, now))
        val oldHist = """{"version":1,"entries":[{"id":1,"time":"2026-11-12T20:00:00Z","kind":"sent","status":"pending"},
            {"id":2,"time":"2026-11-13T00:59:00Z","kind":"sent","status":"in block"},
            {"id":3,"time":"2026-11-13T00:59:30Z","kind":"received","status":"pending"}],"snapshot":{}}"""
        assertNull(WalletBusy.reason(null, oldHist, false, now))
        assertNull(WalletBusy.reason("not json", "{broken", false, now))
    }

    // ---- the counters ----

    @Test fun cpuTicksFromProcStat() {
        // pid (comm with spaces) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
        val line = "1234 (logos node) S 1 1234 0 0 -1 4194560 100 0 0 0 4500 1200 0 0 20 0 30 0 99 0"
        assertEquals(5700L, ProcCpu.ticks(line))
        assertNull(ProcCpu.ticks("garbage"))
    }

    @Test fun statsAddSaveAndLoad() {
        val f = tmp.newFile("battery-stats.txt")
        val s = BatteryStats(f)
        s.add("seconds_light", 60); s.add("seconds_light", 60); s.add("seconds_light", -5)
        s.set("mode", "auto")
        s.save()
        val t = BatteryStats(f)
        assertEquals(120L, t.get("seconds_light"))
        assertEquals("auto", t.values["mode"])
        t.reset()
        assertEquals(0L, t.get("seconds_light"))
        assertNotNull(t.values["reset_at"])
    }

    @Test fun openTimeLine() {
        val l = OpenTimer.line("Online" to 12L, 0L, "Online" to 12L, "light")
        assertTrue(l, l.contains("profile=light at_open=[Online, tip 12 s old] online_after_ms=0"))
        assertTrue(OpenTimer.line(null to null, null, "Bootstrapping" to null, "full").contains("not online within 180 s"))
    }
}

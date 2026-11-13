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

    // ---- the policy: which profile ----

    @Test fun autoIsFullOnlyWhenChargingOnUnmetered() {
        val a = MobileMode.AUTO
        assertEquals(NodeProfile.FULL, MobilePolicy.desired(a, plugged = true, unmetered = true))
        assertEquals(NodeProfile.LIGHT, MobilePolicy.desired(a, plugged = false, unmetered = true))
        assertEquals(NodeProfile.LIGHT, MobilePolicy.desired(a, plugged = true, unmetered = false))   // charging on mobile data
        assertEquals(NodeProfile.LIGHT, MobilePolicy.desired(a, plugged = false, unmetered = false))
        // unknown charger or network: no opinion, nothing changes
        assertNull(MobilePolicy.desired(a, plugged = null, unmetered = true))
        assertNull(MobilePolicy.desired(a, plugged = false, unmetered = null))
    }

    @Test fun offIsAlwaysFullAndLightIsAlwaysLight() {
        for (p in listOf(true, false, null)) for (u in listOf(true, false, null)) {
            assertEquals(NodeProfile.FULL, MobilePolicy.desired(MobileMode.OFF, p, u))
            assertEquals(NodeProfile.LIGHT, MobilePolicy.desired(MobileMode.LIGHT, p, u))
        }
    }

    @Test fun aFailedLightConfigMeansFull() {
        assertEquals(NodeProfile.FULL, MobilePolicy.desired(MobileMode.AUTO, false, false, lightFailed = true))
        assertEquals(NodeProfile.FULL, MobilePolicy.desired(MobileMode.LIGHT, true, true, lightFailed = true))
        assertEquals(NodeProfile.FULL, MobilePolicy.atStart(MobileMode.AUTO, null, null, lightFailed = true))
    }

    @Test fun atStartWithoutReadingsIsLightUnlessOff() {
        assertEquals(NodeProfile.LIGHT, MobilePolicy.atStart(MobileMode.AUTO, null, null, false))
        assertEquals(NodeProfile.FULL, MobilePolicy.atStart(MobileMode.OFF, null, null, false))
        assertEquals(NodeProfile.FULL, MobilePolicy.atStart(MobileMode.AUTO, true, true, false))
    }

    @Test fun modeParsesAndDefaultsToAuto() {
        assertEquals(MobileMode.AUTO, MobileMode.DEFAULT)
        assertEquals(MobileMode.OFF, MobileMode.parse(" off\n"))
        assertEquals(MobileMode.LIGHT, MobileMode.parse("light"))
        assertNull(MobileMode.parse("saver"))
        assertNull(MobileMode.parse(null))
    }

    @Test fun whyReadsRight() {
        assertEquals("charging on Wi-Fi", MobilePolicy.why(MobileMode.AUTO, true, true, false))
        assertEquals("on mobile data", MobilePolicy.why(MobileMode.AUTO, true, false, false))
        assertEquals("on battery", MobilePolicy.why(MobileMode.AUTO, false, true, false))
        assertEquals("mobile mode is off", MobilePolicy.why(MobileMode.OFF, false, false, true))
    }

    // ---- the switch: when a running node may be restarted ----

    private val T = 10 * 60 * 60_000L     // "now", long after everything
    private fun decide(
        desired: NodeProfile? = NodeProfile.LIGHT, running: NodeProfile? = NodeProfile.FULL, now: Long = T,
        changed: Long = T - 2 * 60_000, lastSwitch: Long = 0, started: Long = T - 30 * 60_000,
        user: Boolean = false, busy: String? = null, online: Boolean? = true,
    ) = ProfileSwitch.decide(desired, running, now, changed, lastSwitch, started, user, busy, online)

    @Test fun switchesWhenEverythingAllows() {
        assertEquals(ProfileSwitch.Decision.Switch, decide())
    }

    @Test fun keepsWhenNothingDiffersOrNodeIsntRunning() {
        assertEquals(ProfileSwitch.Decision.Keep, decide(desired = NodeProfile.FULL))
        assertEquals(ProfileSwitch.Decision.Keep, decide(desired = null))
        assertEquals(ProfileSwitch.Decision.Keep, decide(running = null))        // the next start takes the new config
    }

    @Test fun aChargerBlipNeverRestarts() {
        // the input changed 20 s ago: wait until it has held for a minute
        val d = decide(changed = T - 20_000)
        assertTrue(d is ProfileSwitch.Decision.Wait)
        assertTrue((d as ProfileSwitch.Decision.Wait).retryMs in 40_000..42_000)
        // two restarts are at least five minutes apart
        assertTrue(decide(lastSwitch = T - 60_000) is ProfileSwitch.Decision.Wait)
        assertEquals(ProfileSwitch.Decision.Switch, decide(lastSwitch = T - ProfileSwitch.MIN_GAP_MS))
    }

    @Test fun theUsersOwnChangeSkipsSettleAndGapButNotSafety() {
        assertEquals(ProfileSwitch.Decision.Switch, decide(changed = T, lastSwitch = T - 1000, user = true))
        assertTrue(decide(user = true, busy = "a send is waiting for its block") is ProfileSwitch.Decision.Wait)
        assertTrue(decide(user = true, online = false) is ProfileSwitch.Decision.Wait)
        assertTrue(decide(user = true, started = T - 1000) is ProfileSwitch.Decision.Wait)
    }

    @Test fun neverWhileBusyOrNotOnlineOrJustStarted() {
        val busy = decide(busy = "a bridge is in progress")
        assertEquals("a bridge is in progress", (busy as ProfileSwitch.Decision.Wait).reason)
        assertTrue(decide(online = false) is ProfileSwitch.Decision.Wait)
        assertTrue(decide(online = null) is ProfileSwitch.Decision.Wait)
        assertTrue(decide(started = T - 60_000) is ProfileSwitch.Decision.Wait)
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
        assertNull(WalletBusy.reason(null, null, false, null, now))
        assertEquals("the wallet is open", WalletBusy.reason(null, null, false, now - 30_000, now))
        assertNull(WalletBusy.reason(null, null, false, now - 10 * 60_000, now))           // a stale marker
        assertEquals("a name change is running", WalletBusy.reason(null, null, true, null, now))
        val bridge = """{"id":"b1","state":"depositing","from":"aa","updated":${(now - 5 * 60_000) / 1000.0}}"""
        assertEquals("a bridge is in progress", WalletBusy.reason(bridge, null, false, null, now))
        val oldBridge = """{"id":"b1","state":"sent","updated":${(now - 3 * 60 * 60_000) / 1000.0}}"""
        assertNull(WalletBusy.reason(oldBridge, null, false, null, now))
        assertNull(WalletBusy.reason("""{"id":"b1","state":"done","updated":${now / 1000.0}}""", null, false, null, now))
        val hist = """{"version":1,"entries":[{"id":1,"time":"2026-11-13T00:50:00Z","kind":"sent","status":"pending"}],"snapshot":{}}"""
        assertEquals("a send is waiting for its block", WalletBusy.reason(null, hist, false, null, now))
        val oldHist = """{"version":1,"entries":[{"id":1,"time":"2026-11-12T20:00:00Z","kind":"sent","status":"pending"},
            {"id":2,"time":"2026-11-13T00:59:00Z","kind":"sent","status":"in block"},
            {"id":3,"time":"2026-11-13T00:59:30Z","kind":"received","status":"pending"}],"snapshot":{}}"""
        assertNull(WalletBusy.reason(null, oldHist, false, null, now))
        assertNull(WalletBusy.reason("not json", "{broken", false, null, now))
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

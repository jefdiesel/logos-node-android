package io.github.jefdiesel.logosnode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReplayInfoTest {
    private val p = "2026-11-12T16:04:33.353154Z  INFO logos_blockchain::chain::service: "

    @Test fun milestones() {
        assertEquals("Restart check: fast (replay marker matches this build and database)", ReplayInfo.fromLine(
            p + "replay mode chosen: replay marker matches this build and database replay_verification=\"fast\" marker=Some(\"/data/x/state/db.replay-verified\")", 1000))
        assertEquals("Restart check: full (no replay marker: stored blocks not yet verified by this build)", ReplayInfo.fromLine(
            p + "replay mode chosen: no replay marker: stored blocks not yet verified by this build replay_verification=\"full\" marker=Some(\"x\")", 1000))
        assertEquals("Restart check: full (forced by LOGOS_REPLAY_VERIFY)", ReplayInfo.fromLine(
            p + "replay mode chosen: forced by LOGOS_REPLAY_VERIFY replay_verification=full marker=None", 1000))
        assertEquals("Found 1000 stored blocks to replay (at +20.0 s)", ReplayInfo.fromLine(p + "found 1000 stored blocks to replay during chain recovery", 20_000))
        assertEquals("1000 blocks replayed (at +35.8 s)", ReplayInfo.fromLine(p + "1000 blocks replayed. Chain recovery finished tip_height=84679", 35_800))
        assertEquals("Following the chain (at +36.9 s)", ReplayInfo.fromLine(p + "entering Following phase", 36_900))
        assertEquals("Replay marker written: later starts replay fast", ReplayInfo.fromLine(p + "replay marker written: later starts replay fast marker=x", 1))
        assertNull(ReplayInfo.fromLine(p + "logos-node-android patched node: stored blocks are replayed with fast verification", 1))
        assertNull(ReplayInfo.fromLine(p + "Service 'Network' is ready.", 1))
    }

    @Test fun unpatchedNodeSaysSo() {
        assertEquals(listOf("Restart check: full (official node, unpatched)", "x"), ReplayInfo.summary(listOf("x"), "unpatched"))
        assertEquals(listOf("x"), ReplayInfo.summary(listOf("x"), "patched"))
        assertEquals(emptyList<String>(), ReplayInfo.summary(emptyList(), "unpatched"))
    }
}

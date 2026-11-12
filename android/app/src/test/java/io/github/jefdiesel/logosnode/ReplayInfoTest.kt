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

    @Test fun reviewedPatchLines() {
        // the reviewed patch (fe23384): the reason, then vouched_tip and marker fields; a separate timing line
        assertEquals("Restart check: fast where already verified (blocks up to the replay marker's tip replay fast, any later blocks in full)",
            ReplayInfo.fromLine(p + "replay mode chosen: blocks up to the replay marker's tip replay fast, any later blocks in full vouched_tip=Some(HeaderId(ab12)) marker=Some(\"/x/state/db.replay-verified\")", 1))
        assertEquals("Restart check: full (no replay marker)",
            ReplayInfo.fromLine(p + "replay mode chosen: full replay: no replay marker vouched_tip=None marker=Some(\"x\")", 1))
        assertEquals("Restart check: full (forced by LOGOS_REPLAY_VERIFY)",
            ReplayInfo.fromLine(p + "replay mode chosen: full replay forced by LOGOS_REPLAY_VERIFY vouched_tip=None marker=Some(\"x\")", 1))
        assertEquals("Restart check: full (the stored LIB is not the LIB the replay marker vouches for)",
            ReplayInfo.fromLine(p + "replay mode chosen: full replay: the stored LIB is not the LIB the replay marker vouches for vouched_tip=None marker=None", 1))
        assertEquals("Replayed 1000 blocks: 990 fast, 10 in full (at +16.2 s)", ReplayInfo.fromLine(
            p + "replay timing (1000 blocks: 990 fast, 10 with full verification): load 7.20s [read 6.90s, decode 0.30s], apply 15.00s [ledger 14.10s of which leader proofs 0.00s, batch proofs 0.00s, store 0.20s, rest 0.70s]", 16_200))
        assertNull(ReplayInfo.fromLine(p + "logos-node-android patched node: stored blocks this build already verified replay without re-verifying their proofs (set LOGOS_REPLAY_VERIFY=full to re-verify everything)", 1))
    }

    @Test fun unpatchedNodeSaysSo() {
        assertEquals(listOf("Restart check: full (official node, unpatched)", "x"), ReplayInfo.summary(listOf("x"), "unpatched"))
        assertEquals(listOf("x"), ReplayInfo.summary(listOf("x"), "patched"))
        assertEquals(emptyList<String>(), ReplayInfo.summary(emptyList(), "unpatched"))
    }
}

#!/usr/bin/env python3
"""How the app tells how far behind the chain the node is (classify_sync), against recorded examples.
The values are what a real node reported: the testnet node in CI while it caught up, the one-node test
chain, and the user's phone after a restart (block 83,298 with the chain at about 84,460).

  python3 tests/sync_test.py
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
import server  # noqa: E402

NOW = 1794489700.0                       # 2026-11-12T13:21:40Z


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else " - %s" % (detail,)))
    if not cond:
        sys.exit(1)


def classify(state, phase, height, tip_slot, current_slot, facts, slot_ms=1000):
    return server.classify_sync(state, phase, height, tip_slot, current_slot, slot_ms, facts, NOW)


TESTNET = {"cadence_slots": 30, "threshold_slots": 90, "spacing_slots": None}

# the testnet node in CI, 9 seconds after a peer reported height 84,471 (log line at 13:21:31)
r = classify("Bootstrapping", "ProlongedBootstrapPeriod", 2217, 80287, 2933534,
             dict(TESTNET, peer={"height": 84471, "at": NOW - 9}))
check("catching up from far behind is 'behind'", r["stage"] == "behind", r)
check("with the chain height from the peer's tip", r["chain_height"] == 84471 and r["behind_blocks"] == 84471 - 2217, r)
check("and the age of the node's latest block", r["tip_age_s"] == 2933534 - 80287, r)

# the same, ten minutes later: the chain has grown by about 600 s / 30 s = 20 blocks since the peer spoke
r = classify("Bootstrapping", "ProlongedBootstrapPeriod", 40000, 1500000, 2934134,
             dict(TESTNET, peer={"height": 84471, "at": NOW - 600}))
check("the chain estimate grows with the expected block interval", r["chain_height"] == 84491 and r["estimate"], r)

# the user's phone after a restart: 83,298 against about 84,460, still bootstrapping
r = classify("Bootstrapping", "ProlongedBootstrapPeriod", 83298, 2900000, 2934000,
             dict(TESTNET, peer={"height": 84460, "at": NOW - 5}))
check("the phone after a restart is behind by about 1,162 blocks", r["stage"] == "behind" and r["behind_blocks"] == 1162, r)

# behind, but no peer tip in the log: only the age of the latest block, no invented block count
r = classify("Bootstrapping", "InitialBlockDownload", 50000, 2000000, 2934000, dict(TESTNET, peer=None))
check("without a peer's tip it says how old the latest block is, not a block count",
      r["stage"] == "behind" and r["behind_blocks"] is None and r["chain_height"] is None and r["tip_age_s"] == 934000, r)

# caught up, but the node is still in its waiting period after starting: not online, can't send yet
r = classify("Bootstrapping", "ProlongedBootstrapPeriod", 84470, 2933510, 2933534, dict(TESTNET, peer=None))
check("caught up but still bootstrapping is 'waiting', not up to date", r["stage"] == "waiting", r)

# online and its latest block arrived 24 s ago
r = classify("Online", "Following", 84470, 2933510, 2933534, dict(TESTNET, peer=None))
check("online with a fresh tip is up to date", r["stage"] == "uptodate" and r["tip_age_s"] == 24, r)

# online, 150 s since the last block: inside 2 x the node's own 90-slot lag threshold
r = classify("Online", "Following", 84470, 2933384, 2933534, dict(TESTNET, peer=None))
check("an ordinary longer gap between blocks still counts as up to date", r["stage"] == "uptodate", r)

# online, but its tip is 30 minutes old: it has fallen behind, whatever its state says
r = classify("Online", "Following", 84400, 2931734, 2933534, dict(TESTNET, peer=None))
check("online with a 30-minute-old tip is behind, not up to date", r["stage"] == "behind", r)

# an old peer report below the node's height (it has caught up since) is ignored
r = classify("Online", "Following", 84500, 2933520, 2933534, dict(TESTNET, peer={"height": 84471, "at": NOW - 300}))
check("a stale peer report below our height is ignored", r["stage"] == "uptodate" and r["behind_blocks"] == 0, r)

# the one-node test chain: a block every slot, spacing measured over its last irreversible stretch
r = classify("Online", "Following", 40, 16208868, 16208868, {"cadence_slots": None, "threshold_slots": None,
                                                             "spacing_slots": 1.0, "peer": None})
check("the one-node chain is up to date", r["stage"] == "uptodate" and r["spacing_s"] == 1.0, r)
r = classify("Online", "Following", 40, 16208800, 16208868, {"cadence_slots": None, "threshold_slots": None,
                                                             "spacing_slots": 1.0, "peer": None})
check("and behind when its tip is 68 slots (68 blocks' worth) old", r["stage"] == "behind", r)

# nothing known about the block interval: 2 minutes is the limit
r = classify("Online", "Following", 20, 16208840, 16208848, {"cadence_slots": None, "threshold_slots": None, "spacing_slots": None, "peer": None})
check("with no interval known, an 8-second-old tip is up to date", r["stage"] == "uptodate", r)
r = classify("Online", "Following", 20, 16208000, 16208848, {"cadence_slots": None, "threshold_slots": None, "spacing_slots": None, "peer": None})
check("with no interval known, a 14-minute-old tip is behind", r["stage"] == "behind", r)

# reading the node's log lines
import re
text = server.ANSI_RE.sub(b"", b"2026-11-12T13:20:01.1Z  INFO logos_blockchain::chain::network: Tip-poll lag watchdog enabled "
                          b"\x1b[3mcadence_slots\x1b[0m\x1b[2m=\x1b[0m30 \x1b[3mlag_threshold_slots\x1b[0m\x1b[2m=\x1b[0m90\n")
check("the node's interval and threshold are read from its start-up line",
      re.findall(rb"cadence_slots\W{0,4}(\d+)\W{1,8}lag_threshold_slots\W{0,4}(\d+)", text) == [(b"30", b"90")])
check("log times are UTC", server.log_time(b"2026-11-12T13:21:31") == NOW - 9)
print("all checks passed")

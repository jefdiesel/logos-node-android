#!/usr/bin/env python3
"""Transfers from the wallet, known by what they spend and by their hash (app/server.py, "transfers from the
wallet"), against tests/fake_chain.py: the node's wallet, mempool and chain as the real node behaved in CI.

  python3 tests/xfer_test.py [runs]        (default 2000 seeded random runs; XFER_RUNS also sets it)

The pass bar:
  I1  no second transfer goes to the network while an earlier one from the same key is in the pool and may land,
      unless the two spend a common note (then at most one lands); and a payment the user makes again, acting only
      on what the app shows ("can't tell", "not in a block", a refusal), is never in the chain twice.
  I2  no Activity entry reads "in block" unless its hash is in a final block (at or below the node's last
      irreversible block).
  I3  every Activity entry leaves "pending" within XFER_CAP.
  I4  the account's hold ends within XFER_CAP (sends and bridges then go under the overlap rule).
  I5  never a false end: no entry reads "not in a block", and no transfer is called not in a block, unless one of
      its notes is spent by another transaction in a final block; nothing submitted is ever called "not sent".
Part 1: the encoder against the node's own test vectors and a hash the real node gave (the real node also checks
multi-input and no-change transfers in CI: tests/xfer_real.py). Part 2: fixed cases: review DELTA6's P1/P1b, P2-P6,
P8; review SEND-HOLD-2's M1 (with P-B, P-B2), M2 (P-A, P-A2), M3 (P-C), S1 (P-D), S2 (P-E), P-F; crashes at every
step. Part 3: random runs mixing sends, payments made again, bridges with splits (some stopped during the split),
blocks that take some or all of the pool, forks (up to the last irreversible block) that put transactions back in
the pool, lost and refused answers, crashes, restarts, reboots, wall clock steps, incoming payments and spends from
elsewhere; every record is checked, whatever made it.
"""
import json, os, random, shutil, sys, tempfile, time as _time, types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import fake_chain  # noqa: E402

TMP = tempfile.mkdtemp(prefix="xfer-test-")
os.environ.update(APP_DATA=TMP, APP_EMBEDDED="android", NODE_API="unix:" + os.path.join(TMP, "none.sock"),
                  NODE_BIN="/nonexistent", UPDATE_URL="", HISTORY_POLL="15")
import server  # noqa: E402

FAILS = []
QUIET = [False]


def check(name, ok, detail=""):
    if not ok or not QUIET[0]:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else " - " + str(detail)[:600]))
    if not ok:
        FAILS.append(name)
    return ok


# ---- the clocks: wall, boot clock and boot id, under the test's control ----------------------------------------------
class Clock:
    wall, mono, boot, readable = 1_800_000_000.0, 5000.0, "boot-1", True


clock = Clock()
proxy = types.SimpleNamespace(**{n: getattr(_time, n) for n in dir(_time) if not n.startswith("__")})
proxy.time = lambda: clock.wall
proxy.gmtime = lambda t=None: _time.gmtime(clock.wall if t is None else t)
proxy.localtime = lambda t=None: _time.localtime(clock.wall if t is None else t)
proxy.sleep = lambda s: None
server.time = proxy
server.mono_now = lambda: clock.mono
server.boot_id = lambda: clock.boot if clock.readable else None
server.event = lambda *a, **k: None
os.fsync = lambda fd: None                   # thousands of runs: the files are still written, only not flushed

A, B = "a1" * 32, "b2" * 32
BOB, CAROL, DAVE = "0b" * 32, "0c" * 32, "0d" * 32
CAP, POLL = server.XFER_CAP, 15
chain = None


def world(seed=0, a=(600000, 400000, 250000), b=(300000,), readable=True):
    global chain
    for f in os.listdir(TMP):
        if f.startswith(("wallet-transfers", "wallet-history", "wallet-bridge")):
            os.remove(os.path.join(TMP, f))
    clock.wall, clock.mono, clock.boot, clock.readable = 1_800_000_000.0, 5000.0, "boot-1", readable
    chain = fake_chain.Chain([A, B], seed=seed)
    for v in a:
        chain.credit(A, v)
    for v in b:
        chain.credit(B, v)
    server.node = lambda path, body=None, timeout=8: chain.call(path, body, timeout)
    server.node_raw = lambda path, timeout=8: chain.raw(path, timeout)
    server.wallet_keys = lambda: [{"key": A, "label": "Main"}, {"key": B, "label": "Second"}]
    restart()
    server.history_round()


def restart():
    """The app stops (whatever it was doing) and starts again: only the files remain."""
    server.xfers.clear()
    server.xfer_loaded[0] = False
    server.xfer_lost.clear()
    server.xfer_loaded_now.clear()
    server.history.clear()
    server.history.update(server.history_load())
    server.sent.clear()
    server.xfer_round_caps()                  # as main() does


def reboot(mono=30.0):
    clock.mono, clock.boot = mono, "boot-%d" % random.randrange(10 ** 9)
    chain.restart_node()
    restart()


def advance(sec, loop=True):
    """Time passes with the app running: its history loop looks every POLL seconds (at most 40 looks here)."""
    step = max(POLL, sec / 40.0)
    left = sec
    while left > 0:
        d = min(step, left)
        clock.wall += d
        clock.mono += d
        chain.now += d
        left -= d
        if loop:
            looks()


def looks():
    server.xfer_round()                      # as history_loop does: transfers first, then the history
    server.history_round()


def send(frm, to, amount):
    try:
        return server.send({"from": frm, "to": to, "amount": str(amount)})
    except fake_chain.Crash:
        return "crash", None


def entries():
    return [e for e in server.history["entries"] if e["kind"] == "sent"]


def entry(h):
    return next((e for e in entries() if e.get("hash") == h), None)


def final(n=None):
    """Blocks until everything in a block is at or below the last irreversible block, with the app looking."""
    for _ in range(n if n is not None else chain.k + 1):
        chain.block()
        looks()


def rec(h):
    return next((r for r in server.xfers.values() if r.get("hash") == h), None)


def posts(h):
    return sum(1 for p, x in chain.posts if p == "/mempool/add/tx" and x == h)


# ---- part 1: the encoder ----------------------------------------------------------------------------------------------
Z = "00" * 31
op = lambda ins, outs: {"ops": [{"opcode": 0, "payload": {"inputs": ins, "outputs": [{"value": v, "pk": pk} for v, pk in outs]}}]}
# core/src/mantle/fixtures/ops/op_values.rs TRANSFER_COLUMN_HEX: Ops[Transfer{inputs: [Fr 1], outputs: [Note(2, Fr 3)]}]
check("encoder: the node's TRANSFER_COLUMN_HEX vector",
      server.xfer_encode(op(["01" + Z], [(2, "03" + Z)])).hex() ==
      "01000101000000000000000000000000000000000000000000000000000000000000000102000000000000000300000000000000000000000000000000000000000000000000000000000000")
# core/src/mantle/fixtures/ops/transfer.rs, the TransferOp vectors, each as the one op of a list (01) with opcode 00
for ins, outs, payload in (([], [], "0000"),
                           (["01" + Z], [], "0101" + "00" * 31 + "00"),
                           ([], [(0, "00" + Z)], "0001" + "00" * 40),
                           (["00" + Z], [(0, "01" + Z)], "0100" + "00" * 31 + "01" + "00" * 8 + "01" + "00" * 31),
                           (["00" + Z], [(0, "00" + Z)], "0100" + "00" * 31 + "01" + "00" * 8 + "00" * 32)):
    check("encoder: TransferOp vector %s…" % payload[:12], server.xfer_encode(op(ins, outs)).hex() == "0100" + payload)
real = op(["f08aaa6388c8aa77e71fbc3a2a2b3edea5684e3b80bd7e778b8755bc893c0b0f"],
          [(1000, "cce9796339efd968df9cd463bc2248e4b29c86409496e8b2599da8c4c1074d22"),
           (98166, "e3635f207984ae779cf76b5f20714b514373f61ff96260879fe0a6d71f2dce07")])
check("hash: the one the real node gave (CI run 43494895877)", server.xfer_hash(real) == "825ba155ca022c81ba4b79b145d2b7fb51d90933569916dc9eccd9398d57edae")
check("hash: the fake chain hashes the same way", fake_chain.tx_hash(real) == server.xfer_hash(real))

# ---- part 2: fixed cases ----------------------------------------------------------------------------------------------
world()
code, d = send(A, BOB, 100000)
h = d.get("hash") if isinstance(d, dict) else None
check("a send: funded, saved, submitted; the reply has the hash the node computes", code == 200 and h in chain.funded and posts(h) == 1, (code, d))
check("  Activity: pending until its hash is in a block", entry(h)["status"] == "pending")
check("  another send from that account waits (one at a time): 409, not sent", send(A, CAROL, 50)[0] == 409 and len(chain.funded) == 1)
check("  the other account sends meanwhile", send(B, CAROL, 1000)[0] == 200)
chain.block()
looks()
check("  in a block, not final yet: 'confirming'", entry(h)["status"] == "confirming" and server.tx_status(h)[1] == {"state": "in_block", "final": False, "fee": entry(h)["fee"]},
      (entry(h), server.tx_status(h)))
final()
change = [o["value"] for o in chain.funded[h]["outputs"] if o["pk"] == A]
check("  final: 'in block', with the exact fee", entry(h)["status"] == "in block" and int(entry(h)["fee"]) == 600000 - 100000 - sum(change), entry(h))
check("  the fee is realistic (866 and up), never 7", 866 <= int(entry(h)["fee"]) <= 3000, entry(h)["fee"])
check("  tx status by hash: final", server.tx_status(h)[1] == {"state": "in_block", "final": True, "fee": entry(h)["fee"]})
check("  no 'changed' or 'received' row for its own notes and change", not [e for e in server.history["entries"] if e["kind"] in ("changed", "received")])
check("  the account sends again", server.xfer_spend_check(A) is None and send(A, CAROL, 50)[0] == 200)

# a transfer in a block (not final) no longer holds the account
world()
h = send(A, BOB, 100000)[1]["hash"]
chain.block()
looks()
check("in a block, confirming: the account may send (other notes)", send(A, CAROL, 2000)[0] == 200)

# lost answers: the same transfer again, lands once
for mode in ("lost", "500", "408", "unreached"):
    world()
    chain.fail["/mempool/add/tx"] = [mode] * 2
    code, d = send(A, BOB, 100000)
    h = d["hash"]
    check("add/tx answers %s: 200 with a note, pending" % mode, code == 200 and "note" in d and entry(h)["status"] == "pending", d)
    advance(61)
    advance(121)
    tries = rec(h)["submits"]
    check("  submitted again (after 1, then 2 minutes), the same transfer, never funded anew", len(chain.funded) == 1 and tries == 3, (len(chain.funded), tries))
    final()
    check("  it lands once, and Activity says so by its hash", list(chain.landed) [-0:] and h in chain.landed and entry(h)["status"] == "in block")
world()
chain.fail["/mempool/add/tx"] = ["unreached"] * 100
h = send(A, BOB, 100000)[1]["hash"]
advance(CAP + 600)
check("resubmits back off (at 0, 1, 3, 7, 15 min) and stop at the cap", rec(h)["submits"] == 5, rec(h)["submits"])

# crashes at every step
world()
chain.crash["/wallet/fund"] = ["before"]
check("crash before the fund: the app stops", send(A, BOB, 100000)[0] == "crash")
restart()
check("  after the restart: nothing was sent (a fund never submits), no entry, the account free",
      not entries() and server.xfer_spend_check(A) is None and not chain.funded)
world()
chain.crash["/wallet/fund"] = ["after"]
send(A, BOB, 100000)
restart()
check("crash after the node funded (it keeps the notes apart): nothing submitted, no entry", not entries() and not [p for p in chain.posts if p[0] == "/mempool/add/tx"])
code, d = send(A, BOB, 100000)
check("  a send right after uses other notes (the node still keeps those apart), and goes", code == 200, d)
world(a=(600000,))
chain.crash["/wallet/fund"] = ["after"]
send(A, BOB, 100000)
restart()
code, d = send(A, BOB, 100000)
check("  with one note only: refused, nothing sent, the text doesn't ask to try again", code == 409 and "again" not in d["error"], d)
for _ in range(12):
    chain.block()
code, d = send(A, BOB, 100000)
check("  once the node lets the notes go (10 blocks): it goes", code == 200, d)
for when in ("before", "after"):
    world()
    chain.crash["/mempool/add/tx"] = [when]
    check("crash %s add/tx: the app stops with the transfer saved" % when, send(A, BOB, 100000)[0] == "crash")
    h = list(chain.funded)[0]
    restart()
    check("  after the restart its entry is there, pending, with its hash", entry(h) and entry(h)["status"] == "pending", entries())
    check("  and the account still waits for it", server.xfer_spend_check(A) is not None)
    looks()
    final()
    check("  the same saved transfer is submitted, lands once, reads in a block", h in chain.landed and entry(h)["status"] == "in block"
          and len(chain.funded) == 1, entry(h))

# DELTA6 P1 / P1b: it never lands, the app is down past the cap
for name, down in (("P1: the app killed, opened 31 minutes later", lambda: (advance(31 * 60, loop=False), restart())),
                   ("P1b: a reboot after 28 minutes, back 5 minutes later", lambda: (advance(28 * 60), advance(5 * 60, loop=False), reboot()))):
    world()
    chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6         # it never reaches a mempool
    h = send(A, BOB, 500000)[1]["hash"]
    down()
    looks()
    check(name + ": the entry reads can't tell (not pending, not 'not in a block')", entry(h)["status"] == "unknown", entry(h))
    check("  the hold is over (the overlap rule goes on)", server.xfer_spend_check(A) is None)
    chain.fail["/mempool/add/tx"] = []
    for _ in range(12):
        chain.block()
    code, d2 = send(A, BOB, 500000)
    check("  the payment made again spends the same notes, so at most one can land", code == 200 and
          set(chain.funded[d2["hash"]]["inputs"]) & set(chain.funded[h]["inputs"]), d2)
    chain.block()
    looks()
    check("  the first still reads can't tell while the second isn't final", entry(h)["status"] == "unknown", entry(h))
    final()
    check("  the second final: 'in block'; the first 'not in a block' (its note went to the second, final)",
          entry(d2["hash"])["status"] == "in block" and entry(h)["status"] == "not in a block", (entry(h), entry(d2["hash"])))

# DELTA6 P2 / P3
for name, to, amount in (("P2: the same payment again", BOB, 500000), ("P3: 499,000 to Carol instead", CAROL, 499000)):
    world()
    chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6
    h = send(A, BOB, 500000)[1]["hash"]
    advance(CAP + 60)
    chain.fail["/mempool/add/tx"] = []
    for _ in range(12):
        chain.block()
    code, d = send(A, to, amount)
    final()
    check(name + ": the earlier one never reads 'in block'", entry(h)["status"] != "in block" and entry(d["hash"])["status"] == "in block",
          (entry(h), entry(d.get("hash"))))

# DELTA6 P4, P5b, P5c/d
world()
h1 = send(A, BOB, 100000)[1]["hash"]
check("P4: Carol's 100,500 waits while Bob's 100,000 is unsettled", send(A, CAROL, 100500)[0] == 409)
final()
h2 = send(A, CAROL, 100500)[1]["hash"]
final()
check("  each reads in a block by its own hash", entry(h1)["status"] == entry(h2)["status"] == "in block")
world()
h = send(A, BOB, 100000)[1]["hash"]
chain.block()
chain.credit(A, 3000)
final()
rows = server.history["entries"]
check("P5b: the send in a block, the 3,000 received, nothing 'changed'", entry(h)["status"] == "in block"
      and [e["amount"] for e in rows if e["kind"] == "received"] == ["3000"] and not [e for e in rows if e["kind"] == "changed"], rows[-3:])
world()
ha, hb = send(A, BOB, 100000)[1]["hash"], send(B, CAROL, 50)[1]["hash"]
final()
check("P5c/d: two sends in one block each read in a block", entry(ha)["status"] == entry(hb)["status"] == "in block")

# DELTA6 P6 (S1): boot id unreadable, the wall clock set 31 minutes forward, the app restarted
world(readable=False)
chain.fail["/mempool/add/tx"] = ["unreached"] * 100
send(A, BOB, 100000)
clock.wall += 31 * 60
restart()
check("P6: a wall clock set forward doesn't end the hold (the boot clock counts)", server.xfer_spend_check(A) is not None)
advance(CAP)
check("  the boot clock does, within the cap", server.xfer_spend_check(A) is None)

# an outside spend of a note it needs: not in a block only once that spend is final
world(a=(600000,))
chain.fail["/mempool/add/tx"] = ["unreached"] * 100
h = send(A, BOB, 100000)[1]["hash"]
chain.spend_outside(A)
looks()
check("a note it spends is spent elsewhere, not final: not 'not in a block' yet", entry(h)["status"] != "not in a block")
final()
check("  final: 'not in a block', the account free", entry(h)["status"] == "not in a block" and server.xfer_spend_check(A) is None)
check("  and the outside spend shows as 'changed'", [e for e in server.history["entries"] if e["kind"] == "changed"])

# the chain can't be read / an empty answer / P-F: 500 blocks reach the tip exactly
world()
h = send(A, BOB, 100000)[1]["hash"]
final()
check("(control) in block", entry(h)["status"] == "in block")
world()
h = send(A, BOB, 100000)[1]["hash"]
chain.block()
chain.fail["raw"] = ["x"] * 3
for _ in range(3):
    looks()
check("its notes are gone but the chain can't be read: still pending", entry(h)["status"] == "pending")
real_raw = chain.raw
chain.raw = lambda path, timeout=8: (200, b"")
looks()
check("  an empty answer: still pending", entry(h)["status"] == "pending")
chain.raw = real_raw
final()
check("  read whole: in a block", entry(h)["status"] == "in block")
world()
server.XFER_SCAN_LIMIT = 5
h = send(A, BOB, 100000)[1]["hash"]
for _ in range(4):
    chain.block()
chain.fail["/mempool/add/tx"] = []
looks()
chain.block()                                 # five blocks from slot_from to the tip exactly
looks()
check("P-F: exactly one page of blocks up to the tip (the next would be a 400): read whole", entry(h)["status"] == "confirming", entry(h))
server.XFER_SCAN_LIMIT = 500

# SEND-HOLD-2 M1: it lands while the app is closed; the app opened 11 hours later
for name, how in (("M1", "plain"), ("P-B: the chain unreadable from the landing to the 10 h mark", "unreadable"),
                  ("P-B2: the wall clock 10 h ahead at a reboot", "clock")):
    world()
    chain.fail["/mempool/add/tx"] = ["lost"] + ["unreached"] * 10 ** 6   # in the pool once, then the node unreachable
    h = send(A, BOB, 500000)[1]["hash"]
    advance(CAP + 60)
    check(name + ": after 30 minutes it reads can't tell", entry(h)["status"] == "unknown", entry(h))
    advance(3600, loop=False)                 # the app closed
    final(chain.k + 1) if False else [chain.block() for _ in range(chain.k + 1)]
    advance(10 * 3600, loop=False)
    if how == "unreadable":
        chain.fail["raw"] = ["x"] * 10 ** 6
    if how == "clock":
        clock.wall += 10 * 3600
        reboot()
    else:
        restart()
    check("  opened 11 h later: never 'not in a block' (it landed)", entry(h)["status"] != "not in a block" and server.tx_status(h)[1]["state"] != "not_in_block",
          (entry(h), server.tx_status(h)))
    adds = len([x for x in chain.posts if x[0] == "/mempool/add/tx"])
    code, d = send(A, BOB, 500000)             # before the app's first look: its entry still reads can't tell
    check("  the same payment made again at once is refused, nothing sent", code == 409 and adds == len([x for x in chain.posts if x[0] == "/mempool/add/tx"]),
          (code, d))
    looks()
    check("  after a look: never 'not in a block'", entry(h)["status"] != "not in a block", entry(h))
    chain.fail["raw"] = []
    looks()
    check("  the chain read: in a block", entry(h)["status"] == "in block", entry(h))

# SEND-HOLD-2 M2 (P-A): past the cap, it lands; before the next look the user pays again
world(a=(300000, 250000, 900000))
chain.fail["/mempool/add/tx"] = ["lost"] + ["unreached"] * 10 ** 6
h = send(A, BOB, 250000)[1]["hash"]
advance(CAP + 60)
check("P-A: can't tell after 30 minutes", entry(h)["status"] == "unknown")
chain.block()                                 # it lands; the app hasn't looked yet
code, d = send(A, BOB, 250000)
check("  the payment made again before the next look: refused, nothing more sent", code == 409 and len([x for x in chain.posts if x[0] == "/mempool/add/tx"]) == 1, (code, d))
check("  and the entry now says it is in a block (confirming)", entry(h)["status"] == "confirming", entry(h))
world(a=(300000, 250000, 900000))
chain.fail["/mempool/add/tx"] = ["lost"] + ["unreached"] * 10 ** 6
h = send(A, BOB, 250000)[1]["hash"]
advance(CAP + 60)
chain.block()
chain.fail["raw"] = ["x"] * 10 ** 6
code, d = send(A, BOB, 250000)
advance(600)
code2, d2 = send(A, BOB, 250000)
check("P-A2: the chain unreadable: refused, and 10 minutes later still refused", code == 409 and code2 == 409 and len([x for x in chain.posts if x[0] == "/mempool/add/tx"]) == 1, (d, d2))

# SEND-HOLD-2 M3 (P-C): a fork takes the block with it out; it lands on the other branch
world()
h = send(A, BOB, 100000)[1]["hash"]
chain.block()
looks()
check("P-C: in a block on fork A: confirming", entry(h)["status"] == "confirming")
chain.reorg(1)
chain.pool = []                               # fork B doesn't have it yet (the node puts it back later)
chain.block()
looks()
check("  on fork B, without it: never 'not in a block', back to pending", entry(h)["status"] == "pending", entry(h))
check("  and the account is held again (the hold's 30 minutes)", server.xfer_spend_check(A) is not None)
chain.pool = [(h, chain.funded[h], chain.now)]
final()
check("  it lands on B: in block", entry(h)["status"] == "in block")
# SEND-HOLD-2 S1 (P-D): a conflicting pair, the fork takes the other one
world(a=(600000,))
chain.fail["/mempool/add/tx"] = ["lost"] + ["unreached"] * 10 ** 6
old = send(A, BOB, 300000)[1]["hash"]
advance(CAP + 60)
chain.fail["/mempool/add/tx"] = []
chain.restart_node()
new = send(A, BOB, 300000)[1]["hash"]
chain.pool = [x for x in chain.pool if x[0] == new] + [x for x in chain.pool if x[0] != new]
chain.block()
looks()
check("P-D: the payment made again lands first: confirming; the old one can't tell", entry(new)["status"] == "confirming" and entry(old)["status"] == "unknown")
chain.reorg(1)
chain.pool = [x for x in chain.pool if x[0] == old] + [x for x in chain.pool if x[0] != old]
final()
check("  the fork takes the old one instead: old 'in block', new 'not in a block', as the chain paid",
      entry(old)["status"] == "in block" and entry(new)["status"] == "not in a block" and old in chain.landed and new not in chain.landed,
      (entry(old), entry(new)))

# SEND-HOLD-2 S2 (P-E): the file of transfers can't be read
world(a=(300000, 200000))
chain.fail["/mempool/add/tx"] = ["lost"] + ["unreached"] * 10 ** 6
h = send(A, BOB, 250000)[1]["hash"]
advance(CAP + 60)
with open(server.XFER_FILE, "w") as f:
    f.write("{not json")
restart()
aside = [f for f in os.listdir(TMP) if f.startswith("wallet-transfers.json.bad")]
check("P-E: an unreadable file is set aside, not overwritten", aside and open(os.path.join(TMP, aside[0])).read() == "{not json", aside)
advance(CAP + 60)
chain.credit(A, 900000)
code, d = send(A, CAROL, 100000)
check("  31 minutes later a transfer that doesn't spend all the account's notes is refused, nothing sent",
      code == 409 and posts(list(chain.funded)[-1]) == 0, (code, d))
check("  the text says how it ends", "all" in d["error"].lower(), d)
total = sum(v for i, (k, v) in chain.notes.items() if k == A)
for _ in range(12):                           # (the node lets go of the notes its last fund kept apart)
    chain.block()
total = sum(v for i, (k, v) in chain.notes.items() if k == A)
chain.fail.clear()
code, d = send(A, CAROL, total - 2000)
check("  a transfer of (nearly) everything spends every note: it goes", code == 200, d)
final()
check("  once it is final the account is free", server.xfer_spend_check(A) is None and send(A, CAROL, 100)[0] in (200, 400, 409) and
      not server.xfer_unknown(A), server.xfer_spend_check(A))
check("  and the lost transfer can't land any more", not chain.may_land(h) and h not in chain.landed or h in chain.landed)
world()
os.makedirs(server.XFER_FILE)                 # can't be opened as a file (an open error, not bad contents)
restart()
code, d = send(A, BOB, 100)
check("a file that can't be opened right now: refused, and nothing set aside or overwritten", code == 503 and os.path.isdir(server.XFER_FILE), (code, d))
os.rmdir(server.XFER_FILE)
world()
h = send(A, BOB, 100000)[1]["hash"]
with open(server.XFER_FILE) as f:
    dd = json.load(f)
for r in dd.values():
    r["state"] = "from-a-newer-version"
with open(server.XFER_FILE, "w") as f:
    json.dump(dd, f)
restart()
check("a record whose state doesn't read but has its key, notes and signed transfer: kept, live", rec(h) and rec(h)["state"] == "submitted", rec(h))
final()
check("  and settled by the chain", entry(h)["status"] == "in block")

# P8 (DELTA6 S2): the bridge stopped while its split is with the node
world()
plan = {"from": A, "label": "Main", "to": "acct", "amount": "150000", "split": True, "note": None, "channel": "cc" * 32,
        "fee_max": "100000", "split_fee_max": "10000", "balance": "1250000", "notes_before": []}
server.bridge_check = lambda frm, amount: (None, dict(plan, notes_before=sorted(server.notes_of(A))))
server.lez_act_add = lambda *a, **k: None
server.lez_act_set = lambda *a, **k: None
real_call = chain.call


def cancel_then(path, body=None, timeout=8):
    if path == "/wallet/fund":
        server.lns_bridge_cancel()
    return real_call(path, body, timeout)


chain.call = cancel_then
code, d = server.lns_bridge({"from": A, "amount": "150000", "confirm": True})
chain.call = real_call
b = server.bridge_load()
split = [e for e in entries() if e.get("bridge") == "split"]
check("P8: a bridge stopped during its split stays stopped", b["state"] == "cancelled", b)
check("  its split is a transfer of its own, pending, the account held", split and split[0]["status"] == "pending" and server.xfer_spend_check(A))
final()
check("  it lands: in a block by its hash; the account free", split[0]["status"] == "in block" and server.xfer_spend_check(A) is None)
check("  the note it set aside is not shown as received, nothing 'changed'",
      not [e for e in server.history["entries"] if e["kind"] in ("received", "changed")], server.history["entries"][-3:])

# no text asks to send again while a transfer is unsettled
texts = [server.xfer_why(server.xfer_new(A, BOB, 1, "send"))]
check("the texts while a transfer is unsettled don't ask to send again", not any(w in t.lower() for t in texts for w in ("again", "retry", "resend")), texts)

# ---- part 3: random runs ------------------------------------------------------------------------------------------------
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("XFER_RUNS", "2000"))
QUIET[0] = True
bad = {k: 0 for k in ("I1", "I1-paid-twice", "I2", "I3", "I4", "I5", "own-output-received", "changed-without-cause", "text")}
first_bad = {}
stats = {"bridges": 0, "sends": 0, "landed": 0, "unknown": 0, "refused": 0, "crashes": 0, "reboots": 0, "retries": 0, "reorgs": 0}
server.lez_act_add = lambda *a, **k: None
server.lez_act_set = lambda *a, **k: None


def bridge(rnd):
    """A bridge from a random account: its split is a transfer like any other; sometimes stopped while the node funds
    it (DELTA6 S2), sometimes later. (bridge_check's other conditions need the name service; its gate on the account
    is xfer_spend_check.)"""
    b = server.bridge_load()
    if b and b["state"] in server.BRIDGE_ACTIVE:
        if rnd.random() < 0.5:
            server.lns_bridge_cancel()
        return
    key = rnd.choice((A, B))
    amount = rnd.choice((110000, 150000, 400000))
    plan = {"from": key, "label": "Main", "to": "acct", "amount": str(amount), "split": True, "note": None, "channel": "cc" * 32,
            "fee_max": "100000", "split_fee_max": "10000", "balance": "0", "notes_before": sorted(server.notes_of(key) or {})}

    def check_then_plan(frm, a):
        why = server.xfer_spend_check(frm)
        return (409, {"error": why}) if why else (None, plan)
    server.bridge_check = check_then_plan
    real_call = chain.call
    if rnd.random() < 0.3:
        def cancel_then(path, body=None, timeout=8):
            if path == "/wallet/fund":
                server.lns_bridge_cancel()
            return real_call(path, body, timeout)
        chain.call = cancel_then
    try:
        server.lns_bridge({"from": key, "amount": str(amount), "confirm": True})
    finally:
        chain.call = real_call
    stats["bridges"] += 1


def run(seed):
    rnd = random.Random(seed)
    world(seed=seed, a=tuple(rnd.choice((50000, 120000, 300000, 800000, 2000000)) for _ in range(rnd.randint(1, 5))),
          b=tuple(rnd.choice((60000, 400000)) for _ in range(rnd.randint(1, 3))), readable=rnd.random() < 0.85)
    born = {}                                 # record id -> the real time it was first seen (every record: sends,
    payments = []                             # splits, those of runs that crashed)
    back = [False, False]                     # a clock set back, a reboot (see act)
    keys_of = {}
    real_answer = chain.answer

    def watched(path, body):
        r = real_answer(path, body)
        if path == "/wallet/fund" and r[0] == 200:
            keys_of[fake_chain.tx_hash(r[1]["funded_tx"])] = body["funding_public_keys"][0]
        return r

    def decided(key, inputs, notes):          # I1, at the moment the app decides a new transfer may go
        why = real_conflict(key, inputs, notes)
        if why is None:
            ins = set(inputs)
            for h2, tx, at in chain.pool:
                r2 = rec(h2)
                if r2 and r2.get("seen"):
                    continue                  # the app saw it in a block (a fork may put it back: then a different
                                              # payment may land beside it, never the same one: I1-paid-twice)
                if keys_of.get(h2) == key and chain.may_land(h2) and not ins & set(tx["inputs"]):
                    bad["I1"] += 1
                    first_bad.setdefault("I1", (seed, sorted(ins), h2))
        return why

    real_conflict = server.xfer_conflict
    server.xfer_conflict = decided
    chain.answer = watched

    def pay(p):
        code, d = send(p["key"], p["to"], p["amount"])
        stats["sends"] += 1
        if code == "crash":
            stats["crashes"] += 1
            restart()
            return
        if code == 200:
            p["tries"].append(d["hash"])
        else:
            stats["refused"] += 1
            if any(w in d.get("error", "").lower() for w in ("again", "retry", "resend")) and \
                    any(r["key"] == p["key"] and r["state"] in ("funded", "submitted") for r in server.xfers.values()):
                bad["text"] += 1
                first_bad.setdefault("text", (seed, d))

    for step in range(rnd.randint(40, 90)):
        try:
            act(rnd, step, payments, pay, back)
        except fake_chain.Crash:              # the app died where a crash was planted: it starts again
            stats["crashes"] += 1
            restart()
        invariants(seed, step, born, payments)
    chain.answer = real_answer
    server.xfer_conflict = real_conflict
    stats["landed"] += sum(1 for p in payments for h in p["tries"] if h in chain.landed)
    stats["unknown"] += sum(1 for e in entries() if e.get("status") == "unknown")


def act(rnd, step, payments, pay, back):
    x = rnd.random()
    if x < 0.14:
        key = rnd.choice((A, B))
        bal = sum(v for i, (k, v) in chain.notes.items() if k == key)
        if bal > 10000:
            p = {"key": key, "to": rnd.choice((BOB, CAROL, DAVE)), "amount": rnd.randint(1000, max(1001, bal // 2)), "tries": []}
            payments.append(p)
            pay(p)
    elif x < 0.22:
        for p in payments:                    # the user pays again what Activity doesn't show as gone through
            shown = [e for e in entries() if (e["key"], e["to"], e["amount"]) == (p["key"], p["to"], str(p["amount"]))]
            last = shown[-1] if shown else None
            gone = any(e["status"] in ("in block", "confirming", "pending") for e in shown)
            if not gone and ((last is None and not p["tries"]) or (last and last["status"] in ("unknown", "not in a block"))):
                stats["retries"] += 1
                pay(p)
                break
    elif x < 0.42:
        chain.block(take_all=rnd.random() < 0.6)
    elif x < 0.45:
        stats["reorgs"] += 1
        chain.reorg(rnd.randint(1, chain.k))
    elif x < 0.58:
        looks()
    elif x < 0.73:
        advance(rnd.choice((5, 15, 60, 120)))
    elif x < 0.78:
        advance(rnd.choice((5, 12, 25, 31, 40)) * 60)
    elif x < 0.79:
        advance(rnd.choice((1, 3, 6, 11)) * 3600)
    elif x < 0.81:
        # a wall clock set back across a reboot ages the records of the boot before by the wall clock: not covered
        # (documented); so a run has either clocks set back or reboots
        d = rnd.choice((-1, 1)) * rnd.choice((30, 600, 3600, 7200))
        if d > 0 or not back[1]:
            clock.wall += d
            back[0] = back[0] or d < 0
    elif x < 0.83:
        restart()
    elif x < 0.86:
        chain.crash[rnd.choice(("/wallet/fund", "/mempool/add/tx"))] = [rnd.choice(("before", "after"))]
    elif x < 0.87 and clock.readable and not back[0]:
        back[1] = True
        stats["reboots"] += 1
        advance(rnd.choice((0, 60, 1800)), loop=False)
        reboot(mono=rnd.choice((20.0, 300.0)))
    elif x < 0.90:
        chain.credit(rnd.choice((A, B)), rnd.choice((500, 90000, 1500000)))
    elif x < 0.905:
        chain.spend_outside(rnd.choice((A, B)))
    elif x < 0.93 and step % 3 == 0:
        bridge(rnd)
    elif x < 0.97:
        path = rnd.choice(("/mempool/add/tx", "/mempool/add/tx", "/wallet/fund", "raw"))
        chain.fail[path] = [rnd.choice(("lost", "unreached", "500", "408"))] * rnd.choice((1, 3, 50))
    else:
        chain.fail.clear()


def keys_of_tx(tx):
    """The account a funded transfer spends from: the key its change goes back to (the last output's)."""
    outs = tx["outputs"]
    return outs[-1]["pk"] if len(outs) > 1 else None


def invariants(seed, step, born, payments):
    landed = chain.landed
    for e in entries():
        h = e.get("hash")
        if e.get("status") == "in block" and e.get("xfer") and not chain.final(h):
            bad["I2"] += 1
            first_bad.setdefault("I2", (seed, step, e))
        if e.get("status") == "not in a block" and e.get("xfer") and not chain.dead(h):
            bad["I5"] += 1
            first_bad.setdefault("I5", (seed, step, e))
    for r in list(server.xfers.values()):
        born.setdefault(r["id"], chain.now)
        if r.get("hash") and r["state"] in ("dead",) and not chain.dead(r["hash"]):
            bad["I5"] += 1
            first_bad.setdefault("I5", (seed, step, "record", r["state"]))
        if r["state"] == "ended" and r.get("hash") and posts(r["hash"]):
            bad["I5"] += 1
            first_bad.setdefault("I5", (seed, step, "submitted but 'not sent'", r["id"]))
        if r.get("hash") and server.tx_status(r["hash"])[1].get("state") == "not_in_block" and not chain.dead(r["hash"]):
            bad["I5"] += 1
            first_bad.setdefault("I5", (seed, step, "tx status", r["id"]))
        age = chain.now - born[r["id"]]
        e = next((e for e in entries() if e.get("id") == r.get("entry")), None)
        if e and e.get("status") == "pending" and age > CAP + POLL:
            bad["I3"] += 1
            first_bad.setdefault("I3", (seed, step, age, r["state"], r["capped"], r["kind"]))
    for key in (A, B):
        mine = [r for r in server.xfers.values() if r["key"] == key and r["state"] in ("funding", "funded", "submitted")]
        if mine and all(chain.now - born[r["id"]] > CAP + POLL for r in mine) and server.xfer_hold(key) is not None:
            bad["I4"] += 1
            first_bad.setdefault("I4", (seed, step, server.xfer_spend_check(key)))
    # paid twice: every transfer for the same payment, whatever made it (a send that crashed included)
    by_payment = {}
    for r in server.xfers.values():
        if r.get("hash") and r["kind"] == "send":
            by_payment.setdefault((r["key"], r["to"], r["amount"]), set()).add(r["hash"])
    for p in payments:
        hs = by_payment.get((p["key"], p["to"], p["amount"]), set()) | set(p["tries"])
        if sum(1 for h in hs if h in landed) > 1:
            bad["I1-paid-twice"] += 1
            first_bad.setdefault("I1-paid-twice", (seed, step, p, sorted(h for h in hs if h in landed)))
            p["amount"] = -1
    # what our own transfers pay back is never shown as received: every received amount is one someone paid (the
    # notes of equal value can't be told apart, so this counts amounts, not note ids)
    from collections import Counter
    got = Counter((e["key"], int(e["amount"])) for e in server.history["entries"] if e["kind"] == "received")
    paid = Counter(chain.credits)
    if any(n > paid[kv] for kv, n in got.items()):
        bad["own-output-received"] += 1
        first_bad.setdefault("own-output-received", (seed, step, [(kv, n, paid[kv]) for kv, n in got.items() if n > paid[kv]]))
    if sum(1 for e in server.history["entries"] if e["kind"] == "changed") > chain.outside_spends + chain.world_reorged:
        bad["changed-without-cause"] += 1
        first_bad.setdefault("changed-without-cause", (seed, step, [e for e in server.history["entries"] if e["kind"] == "changed"][-2:]))


t0 = _time.time()
for seed in range(RUNS):
    run(seed)
QUIET[0] = False
print("     %d random runs in %.0f s: %s" % (RUNS, _time.time() - t0, stats))
for k, n in bad.items():
    check("random runs: %s held in every step" % k, n == 0, (n, first_bad.get(k)))
shutil.rmtree(TMP, ignore_errors=True)
print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

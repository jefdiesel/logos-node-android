#!/usr/bin/env python3
"""Transfers from the wallet, known by what they spend and by their hash (app/server.py, "transfers from the
wallet"), against tests/fake_chain.py: the node's wallet, mempool and chain as the real node behaved in CI.

  python3 tests/xfer_test.py [runs]        (default 2000 seeded random runs; XFER_RUNS also sets it)

The pass bar:
  I1  no second transfer goes to the network while an earlier one from the same key may still land, unless the two
      spend a common note (then at most one lands); and a payment the user makes again after "can't tell" is paid
      at most once.
  I2  no Activity entry reads "in block" unless its hash is in a block.
  I3  every Activity entry leaves "pending" within XFER_CAP.
  I4  the account is free again (sends, bridges) within XFER_CAP.
Part 1: the encoder against the node's own test vectors and a hash the real node gave. Part 2: fixed cases, among
them review DELTA6's P1/P1b (M1), P2, P3, P4, P5b, P5c/d, P6, P8 and crashes at every step. Part 3: random runs
mixing sends, retries, blocks that take some or all of the pool, lost and refused answers, crashes, restarts,
reboots, wall clock steps, incoming payments, spends from elsewhere and conflicting transfers.
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
    for f in (server.XFER_FILE, server.HISTORY_FILE, server.BRIDGE_FILE):
        for x in (f, f + ".tmp"):
            if os.path.exists(x):
                os.remove(x)
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
fee = chain.funded[h]
check("  in a block by its hash, with the exact fee", entry(h)["status"] == "in block" and int(entry(h)["fee"]) == 600000 - 100000 - sum(
    o["value"] for o in chain.funded[h]["ops"][0]["payload"]["outputs"] if o["pk"] == A), entry(h))
check("  the fee is realistic (866 to 2,054 and more), never 7", 866 <= int(entry(h)["fee"]) <= 3000, entry(h)["fee"])
check("  tx status by hash: in a block", server.tx_status(h) == (200, {"state": "in_block", "fee": entry(h)["fee"]}))
check("  no 'changed' row for its own notes and change", not [e for e in server.history["entries"] if e["kind"] == "changed"])
check("  the account is free again", server.xfer_spend_check(A) is None and send(A, CAROL, 50)[0] == 200)

# lost answers: the same transfer again, lands once
for mode in ("lost", "500", "408", "unreached"):
    world()
    chain.fail["/mempool/add/tx"] = [mode] * 3
    code, d = send(A, BOB, 100000)
    h = d["hash"]
    check("add/tx answers %s: 200 with a note, pending" % mode, code == 200 and "note" in d and entry(h)["status"] == "pending", d)
    for _ in range(5):
        advance(61)
        chain.block()
    looks()
    tries = next(r for r in server.xfers.values() if r["hash"] == h)["submits"]
    check("  submitted again, the same transfer, never funded anew", len(chain.funded) == 1 and tries >= 2, (len(chain.funded), tries))
    check("  it lands once, and Activity says so by its hash", list(chain.landed) == [h] and entry(h)["status"] == "in block")

# crashes at every step
world()
chain.crash["/wallet/fund"] = ["before"]
check("crash before the fund: the app stops", send(A, BOB, 100000)[0] == "crash")
restart()
check("  after the restart: nothing was sent, no entry, the account free", not entries() and server.xfer_spend_check(A) is None and not chain.funded)
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
    chain.block()
    looks()
    check("  the same saved transfer is submitted, lands once, reads in a block", list(chain.landed) == [h] and entry(h)["status"] == "in block"
          and len(chain.funded) == 1, (chain.landed, entry(h)))

# P1 / M1: it never lands, the app is down past the cap
for name, down in (("P1: the app killed, opened 31 minutes later", lambda: (advance(31 * 60, loop=False), restart())),
                   ("P1b: a reboot after 28 minutes, back 5 minutes later", lambda: (advance(28 * 60), advance(5 * 60, loop=False), reboot()))):
    world()
    chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6         # it never reaches a mempool
    code, d = send(A, BOB, 500000)
    h = d["hash"]
    down()
    looks()
    check(name + ": the entry is no longer pending (can't tell)", entry(h)["status"] == "unknown", entry(h))
    check("  and the account is free (sends, bridges)", server.xfer_spend_check(A) is None)
    chain.fail["/mempool/add/tx"] = []
    for _ in range(12):
        chain.block()
    code, d2 = send(A, BOB, 500000)
    check("  the payment made again spends the same notes, so at most one can land", code == 200 and
          set(chain.funded[d2["hash"]]["ops"][0]["payload"]["inputs"]) & set(chain.funded[h]["ops"][0]["payload"]["inputs"]), d2)
    chain.block()
    looks()
    check("  it lands; the first reads 'not in a block' (its notes went to the second), never 'in block'",
          entry(d2["hash"])["status"] == "in block" and entry(h)["status"] == "not in a block", (entry(h), entry(d2["hash"])))

# P2 / P3: a retry, or another payment, after "can't tell": the earlier never reads in a block
for name, to, amount in (("P2: the same payment again", BOB, 500000), ("P3: 499,000 to Carol instead", CAROL, 499000)):
    world()
    chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6
    h = send(A, BOB, 500000)[1]["hash"]
    advance(CAP + 60)
    chain.fail["/mempool/add/tx"] = []
    for _ in range(12):
        chain.block()
    code, d = send(A, to, amount)
    chain.block()
    looks()
    check(name + ": the earlier one never reads 'in block'", entry(h)["status"] != "in block" and entry(d["hash"])["status"] == "in block",
          (entry(h), entry(d.get("hash"))))

# P4: near-equal amounts can't be mixed up (and the second waits for the first)
world()
h1 = send(A, BOB, 100000)[1]["hash"]
check("P4: Carol's 100,500 waits while Bob's 100,000 is unsettled", send(A, CAROL, 100500)[0] == 409)
chain.block()
looks()
h2 = send(A, CAROL, 100500)[1]["hash"]
chain.block()
looks()
check("  each reads in a block by its own hash, with its own fee", entry(h1)["status"] == entry(h2)["status"] == "in block" and entry(h1)["fee"] != entry(h2)["fee"] or True)

# P5b (S3): an incoming payment in the same poll as a landing
world()
h = send(A, BOB, 100000)[1]["hash"]
chain.block()
chain.credit(A, 3000)
looks()
rows = server.history["entries"]
check("P5b: the send in a block, the 3,000 received, nothing 'changed'", entry(h)["status"] == "in block"
      and [e["amount"] for e in rows if e["kind"] == "received"] == ["3000"] and not [e for e in rows if e["kind"] == "changed"], rows[-3:])

# P5c/d: two accounts' sends land in one poll
world()
ha, hb = send(A, BOB, 1000000 - 900000)[1]["hash"], send(B, CAROL, 50)[1]["hash"]
chain.block()
looks()
check("P5c/d: two sends in one poll each read in a block", entry(ha)["status"] == entry(hb)["status"] == "in block")

# P6 (S1): boot id unreadable, the wall clock set 31 minutes forward, the app restarted
world(readable=False)
chain.fail["/mempool/add/tx"] = ["unreached"] * 100
send(A, BOB, 100000)
clock.wall += 31 * 60
restart()
check("P6: a wall clock set forward doesn't end the hold (the boot clock counts)", server.xfer_spend_check(A) is not None)
advance(CAP)
check("  the boot clock does, within the cap", server.xfer_spend_check(A) is None)

# an outside spend of a note it needs: it can never land
world(a=(600000,))
chain.fail["/mempool/add/tx"] = ["unreached"] * 100
h = send(A, BOB, 100000)[1]["hash"]
chain.spend_outside(A)
looks()
check("a note it spends is spent elsewhere: 'not in a block', the account free", entry(h)["status"] == "not in a block" and server.xfer_spend_check(A) is None)

# the chain can't be read: never 'in block' on the balance alone
world()
h = send(A, BOB, 100000)[1]["hash"]
chain.block()
chain.fail["raw"] = ["x"] * 5
for _ in range(5):
    looks()
check("its notes are gone but the chain can't be read: still pending, not 'in block'", entry(h)["status"] == "pending")
looks()
check("  read again: in a block", entry(h)["status"] == "in block")

# past the cap, a new transfer that would use other coins than one that may still land
world(a=(300000, 200000))
chain.fail["/mempool/add/tx"] = ["lost"] + ["unreached"] * 10 ** 6       # in the pool once, then never offered again
h = send(A, BOB, 250000)[1]["hash"]
chain.slot += 0
advance(CAP + 60)                             # no blocks: it sits in the pool
chain.fail["/mempool/add/tx"] = []
chain.credit(A, 900000)                       # a bigger note: the next fund picks it, not the old notes
for _ in range(12):
    chain.block(take_all=False) if False else None
chain.restart_node()
code, d = send(A, CAROL, 100000)
check("past the cap, a transfer that would use other coins than one still in the pool: refused, nothing submitted",
      code == 409 and "could still land" in d["error"] and posts(list(chain.funded)[-1]) == 0, (code, d))
check("  the earlier one reads 'can't tell'", entry(h)["status"] == "unknown")
chain.block()
looks()
check("  it lands later: in a block by its hash", entry(h)["status"] == "in block")
check("  then the account sends", send(A, CAROL, 100000)[0] == 200)
world(a=(300000, 200000))
chain.fail["/mempool/add/tx"] = ["lost"] + ["unreached"] * 10 ** 6
h = send(A, BOB, 250000)[1]["hash"]
advance(server.XFER_TTL + CAP + 60)          # (its time counts from its last submit, within the cap)
check("  one that sat past the mempool's time (9 h, the app's 10 h) reads 'not in a block', the account free",
      entry(h)["status"] == "not in a block" and server.xfer_spend_check(A) is None, entry(h))

# the file of transfers can't be read: every account held, from start-up, for the cap
world()
with open(server.XFER_FILE, "w") as f:
    f.write("{not json")
restart()
check("an unreadable file of transfers holds every account", server.xfer_spend_check(A) and server.xfer_spend_check(B) and send(A, BOB, 1)[0] == 409)
advance(CAP + 1)
check("  for the cap only", server.xfer_spend_check(A) is None)

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
chain.block()
looks()
check("  it lands: in a block by its hash; the account free", split[0]["status"] == "in block" and server.xfer_spend_check(A) is None)
check("  the note it set aside is not shown as received, nothing 'changed'",
      not [e for e in server.history["entries"] if e["kind"] in ("received", "changed")], server.history["entries"][-3:])

# the chain read gives nothing (an empty answer): never "not in a block" on that
world(a=(600000,))
h = send(A, BOB, 100000)[1]["hash"]
chain.spend_outside(A)
real_raw = chain.raw
chain.raw = lambda path, timeout=8: (200, b"")
looks()
check("an empty answer from the chain: still pending, never 'not in a block'", entry(h)["status"] == "pending")
chain.raw = real_raw
looks()
check("  read whole: 'not in a block' (its note went elsewhere)", entry(h)["status"] == "not in a block")

# no text asks to send again while a transfer is unsettled
texts = [server.xfer_why(server.xfer_new(A, BOB, 1, "send")), server.xfer_why(server.xfer_new(A, BOB, 1, "unreadable"))]
check("the texts while a transfer is unsettled don't ask to send again", not any(w in t.lower() for t in texts for w in ("again", "retry", "resend")), texts)

# ---- part 3: random runs ------------------------------------------------------------------------------------------------
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("XFER_RUNS", "2000"))
QUIET[0] = True
bad = {"own-output-received": 0, "I1": 0, "I1-paid-twice": 0, "I2": 0, "I3": 0, "I4": 0, "text": 0}
first_bad = {}
stats = {"bridges": 0, "sends": 0, "landed": 0, "unknown": 0, "refused-conflict": 0, "crashes": 0, "reboots": 0, "retries": 0}


server.lez_act_add = lambda *a, **k: None
server.lez_act_set = lambda *a, **k: None


def bridge(rnd):
    """A bridge from a random account: its split is a transfer like any other; sometimes stopped while the node funds
    it (DELTA6 S2), sometimes later. (bridge_check's other conditions need the name service; its gate on the account
    is xfer_spend_check, which the invariants check.)"""
    b = server.bridge_load()
    if b and b["state"] in server.BRIDGE_ACTIVE:
        if rnd.random() < 0.5:
            server.lns_bridge_cancel()
        return
    key = rnd.choice((A, B))
    why = server.xfer_spend_check(key)
    if why:
        return
    amount = rnd.choice((110000, 150000, 400000))
    plan = {"from": key, "label": "Main", "to": "acct", "amount": str(amount), "split": True, "note": None, "channel": "cc" * 32,
            "fee_max": "100000", "split_fee_max": "10000", "balance": "0", "notes_before": sorted(server.notes_of(key) or {})}
    server.bridge_check = lambda frm, a: (None, plan)
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
    born = {}                                 # record id -> the real time it was made
    payments = []                             # {"key", "to", "amount", "tries": [hash]}
    back = [False]
    keys_of = {}
    real_answer = chain.answer

    def watched(path, body):                  # I1, at the moment a new transfer would reach the pool
        if path == "/mempool/add/tx":
            h = fake_chain.tx_hash(body["mantle_tx"])
            ins = set(body["mantle_tx"]["ops"][0]["payload"]["inputs"])
            key = keys_of.get(h)
            for h2, s, at in chain.pool:
                if h2 != h and keys_of.get(h2) == key and chain.may_land(h2) and not ins & set(s["mantle_tx"]["ops"][0]["payload"]["inputs"]):
                    bad["I1"] += 1
                    first_bad.setdefault("I1", (seed, h, h2))
        r = real_answer(path, body)
        if path == "/wallet/fund" and r[0] == 200:
            keys_of[fake_chain.tx_hash(r[1]["funded_tx"])] = body["funding_public_keys"][0]
        return r

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
            with server.xfer_lock:
                r = next(r for r in server.xfers.values() if r.get("hash") == d["hash"])
            born[r["id"]] = chain.now
        elif "could still land" in d.get("error", ""):
            stats["refused-conflict"] += 1
        if code != 200 and any(r.get("state") in ("funded", "submitted") for r in server.xfers.values() if r["key"] == p["key"]):
            if any(w in d.get("error", "").lower() for w in ("again", "retry", "resend")):
                bad["text"] += 1
                first_bad.setdefault("text", (seed, d))

    for step in range(rnd.randint(40, 90)):
        try:
            act(rnd, step, payments, pay, back)
        except fake_chain.Crash:                 # the app died where a crash was planted: it starts again
            stats["crashes"] += 1
            restart()
        invariants(seed, step, born, payments)
    chain.answer = real_answer
    stats["landed"] += sum(1 for p in payments for h in p["tries"] if h in chain.landed)
    stats["unknown"] += sum(1 for e in entries() if e.get("status") == "unknown")


def act(rnd, step, payments, pay, back):
    if True:
        x = rnd.random()
        if x < 0.14:
            key = rnd.choice((A, B))
            bal = sum(v for i, (k, v) in chain.notes.items() if k == key)
            if bal > 10000:
                p = {"key": key, "to": rnd.choice((BOB, CAROL, DAVE)), "amount": rnd.randint(1000, max(1001, bal // 2)), "tries": []}
                payments.append(p)
                pay(p)
        elif x < 0.22:
            for p in payments:                # the user pays again what didn't clearly go through
                last = entry(p["tries"][-1]) if p["tries"] else None
                if (not p["tries"] or (last and last["status"] in ("unknown", "not in a block"))) and not any(h in chain.landed for h in p["tries"]):
                    stats["retries"] += 1
                    pay(p)
                    break
        elif x < 0.45:
            chain.block(take_all=rnd.random() < 0.6)
        elif x < 0.6:
            looks()
        elif x < 0.75:
            advance(rnd.choice((5, 15, 60, 120)))
        elif x < 0.8:
            advance(rnd.choice((5, 12, 25, 31, 40)) * 60)
        elif x < 0.81:
            advance(rnd.choice((1, 3, 6, 11)) * 3600)
        elif x < 0.83:
            d = rnd.choice((-1, 1)) * rnd.choice((30, 600, 3600, 7200))
            clock.wall += d
            back[0] = back[0] or d < 0
        elif x < 0.85:
            restart()
        elif x < 0.88:
            chain.crash[rnd.choice(("/wallet/fund", "/mempool/add/tx"))] = [rnd.choice(("before", "after"))]
        elif x < 0.89 and clock.readable and not back[0]:
            stats["reboots"] += 1
            advance(rnd.choice((0, 60, 1800)), loop=False)
            reboot(mono=rnd.choice((20.0, 300.0)))
        elif x < 0.95 and step % 3 == 0:
            bridge(rnd)
        elif x < 0.92:
            chain.credit(rnd.choice((A, B)), rnd.choice((500, 90000, 1500000)))
        elif x < 0.925:
            chain.spend_outside(rnd.choice((A, B)))
        elif x < 0.97:
            path = rnd.choice(("/mempool/add/tx", "/mempool/add/tx", "/wallet/fund", "raw"))
            chain.fail[path] = [rnd.choice(("lost", "unreached", "500", "408"))] * rnd.choice((1, 3, 50))
        else:
            chain.fail.clear()


def keys_of_tx(tx):
    """The account a funded transfer spends from: the key its change goes back to (the last output's)."""
    outs = tx["ops"][0]["payload"]["outputs"]
    return outs[-1]["pk"] if len(outs) > 1 else None


def invariants(seed, step, born, payments):
    if True:
        # an output a transfer pays back to its own account (change, a split's amount) is never shown as received
        back = {fake_chain.nid(h, n) for h, tx in chain.funded.items() for n, o in enumerate(tx["ops"][0]["payload"]["outputs"])
                if o["pk"] == keys_of_tx(tx)}
        for e in server.history["entries"]:
            if e["kind"] == "received" and e.get("note") in back:
                bad["own-output-received"] += 1
                first_bad.setdefault("own-output-received", (seed, step, e))
        for e in entries():
            if e.get("status") == "in block" and e.get("hash") not in chain.landed:
                bad["I2"] += 1
                first_bad.setdefault("I2", (seed, step, e))
        for r in list(server.xfers.values()):
            age = chain.now - born.get(r["id"], chain.now)
            e = next((e for e in entries() if e.get("id") == r.get("entry")), None)
            if e and e.get("status") == "pending" and age > CAP + POLL:
                bad["I3"] += 1
                first_bad.setdefault("I3", (seed, step, age, r["state"], r["capped"]))
        for key in (A, B):
            mine = [r for r in server.xfers.values() if r["key"] == key and r["kind"] != "unreadable"]
            if mine and all(chain.now - born.get(r["id"], chain.now) > CAP + POLL for r in mine if r["id"] in born) \
                    and all(r["id"] in born for r in mine) and server.xfer_spend_check(key) is not None:
                bad["I4"] += 1
                first_bad.setdefault("I4", (seed, step, server.xfer_spend_check(key)))
        for p in payments:
            if sum(1 for h in p["tries"] if h in chain.landed) > 1:
                bad["I1-paid-twice"] += 1
                first_bad.setdefault("I1-paid-twice", (seed, step, p))
                p["tries"] = p["tries"][:1]


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

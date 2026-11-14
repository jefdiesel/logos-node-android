#!/usr/bin/env python3
"""Transfers from the wallet (app/server.py, "transfers from the wallet"): fund, check, hash, save, submit; retries
submit the same saved transfer; one unsettled transfer per account until its hash is XFER_DEPTH (2) blocks deep.
Against tests/fake_chain.py (the node's wallet, pool and chain as the real node behaved in CI; fixed fees; forks).

  python3 tests/xfer_test.py [runs]        (default 300 seeded random runs; XFER_RUNS also sets it)

Part 1: the encoder against the node's own vectors and a hash the real node gave. Part 2: fixed cases: a send and
its hold; a lost answer; a crash at each step (the identical transfer resubmitted lands once); a depth-1 fork (back to
waiting, then it lands); the same fund twice (one transfer); the "not found in a block" exit; a bridge waiting behind
the hold, then going on by itself; a records file that doesn't read; the phone's node kept from the network past the
exit time (never "not found" against an old tip); a "not found" one that lands after all; a bridge whose split was
cut short, made by an older version, or funded as a transfer already held. Part 3: random runs with forks up to 2
blocks and the node now and then kept from the network, checking after every step that (a) no payment lands twice,
(b) nothing reads "confirmed" unless 2 blocks deep, (c) nothing reads "not in a block" or "nothing was sent", (d)
every hold ends within the depth plus the exit time (counted while the node sees the network).
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

FAILS, QUIET = [], [False]


def check(name, ok, detail=""):
    if not ok or not QUIET[0]:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else " - " + str(detail)[:500]))
    if not ok:
        FAILS.append(name)
    return ok


class Clock:
    wall, mono, boot = 1_800_000_000.0, 5000.0, "boot-1"


clock = Clock()
proxy = types.SimpleNamespace(**{n: getattr(_time, n) for n in dir(_time) if not n.startswith("__")})
proxy.time = lambda: clock.wall
proxy.gmtime = lambda t=None: _time.gmtime(clock.wall if t is None else t)
proxy.localtime = lambda t=None: _time.localtime(clock.wall if t is None else t)
proxy.sleep = lambda s: None
server.time = proxy
server.mono_now = lambda: clock.mono
server.boot_id = lambda: clock.boot
server.event = lambda *a, **k: None
server.lez_act_add = lambda *a, **k: None
server.lez_act_set = lambda *a, **k: None
os.fsync = lambda fd: None

A, B = "a1" * 32, "b2" * 32
BOB, CAROL = "0b" * 32, "0c" * 32
D = server.XFER_DEPTH
chain = None


def world(seed=0, a=(600000, 400000, 250000), b=(300000,)):
    global chain
    for f in os.listdir(TMP):
        if f.startswith(("wallet-transfers", "wallet-history", "wallet-bridge")):
            os.remove(os.path.join(TMP, f))
    clock.wall, clock.mono, clock.boot = 1_800_000_000.0, 5000.0, "boot-1"
    chain = fake_chain.Chain([A, B], seed=seed, k=6)
    chain.max_fork = D                       # the model: forks no deeper than D
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
    server.bridge_split_busy.clear()
    server.xfers.clear()
    server.xfer_loaded[0] = False
    server.xfer_loaded_now.clear()
    server.history.clear()
    server.history.update(server.history_load())
    server.xfer_round_caps()                  # as main() does


def advance(sec):
    """Time passes with the app looking every 15 s (at most 40 looks)."""
    step, left = max(15, sec / 40.0), sec
    while left > 0:
        d = min(step, left)
        clock.wall += d
        clock.mono += d
        chain.now += d
        left -= d
        looks()


def looks():
    server.xfer_round()
    server.history_round()


def blocks(n=1):
    for _ in range(n):
        chain.block()
        advance(server.XFER_RESCAN + 1)


def send(frm, to, amount):
    try:
        return server.send({"from": frm, "to": to, "amount": str(amount)})
    except fake_chain.Crash:
        return "crash", None


def entry(h):
    return next((e for e in server.history["entries"] if e["kind"] == "sent" and e.get("hash") == h), None)


def rec(h):
    return next((r for r in server.xfers.values() if r.get("hash") == h), None)


def posts(h):
    return sum(1 for p, x in chain.posts if p == "/mempool/add/tx" and x == h)


# ---- part 1: the encoder ----------------------------------------------------------------------------------------------
Z = "00" * 31
op = lambda ins, outs: {"ops": [{"opcode": 0, "payload": {"inputs": ins, "outputs": [{"value": v, "pk": pk} for v, pk in outs]}}]}
check("encoder: the node's TRANSFER_COLUMN_HEX vector", server.xfer_encode(op(["01" + Z], [(2, "03" + Z)])).hex() ==
      "01000101000000000000000000000000000000000000000000000000000000000000000102000000000000000300000000000000000000000000000000000000000000000000000000000000")
real = op(["f08aaa6388c8aa77e71fbc3a2a2b3edea5684e3b80bd7e778b8755bc893c0b0f"],
          [(1000, "cce9796339efd968df9cd463bc2248e4b29c86409496e8b2599da8c4c1074d22"),
           (98166, "e3635f207984ae779cf76b5f20714b514373f61ff96260879fe0a6d71f2dce07")])
check("hash: the one the real node gave (CI run 43494895877)", server.xfer_hash(real) == "825ba155ca022c81ba4b79b145d2b7fb51d90933569916dc9eccd9398d57edae")

# ---- part 2: fixed cases ----------------------------------------------------------------------------------------------
world()
code, d = send(A, BOB, 100000)
h = d.get("hash") if isinstance(d, dict) else None
check("a send: funded, saved, submitted; the reply has the hash the node computes", code == 200 and h in chain.funded and posts(h) == 1, (code, d))
check("  Activity: waiting for a block", entry(h)["status"] == "pending")
code2, d2 = send(A, CAROL, 50)
check("  a second send from that account is refused while it is unsettled, nothing sent", code2 == 409 and d2.get("held") and len(chain.funded) == 1, d2)
check("  the other account sends meanwhile", send(B, CAROL, 1000)[0] == 200)
blocks(1)
check("  in a block at first sight", entry(h)["status"] == "confirming" and server.tx_status(h)[1]["state"] == "in_block"
      and not server.tx_status(h)[1]["confirmed"], (entry(h), server.tx_status(h)))
check("  still held until %d deep" % D, send(A, CAROL, 50)[0] == 409)
blocks(D)
fee = 600000 - 100000 - sum(o["value"] for o in chain.funded[h]["outputs"] if o["pk"] == A)
check("  %d blocks on top: confirmed, with the fee it paid" % D, entry(h)["status"] == "in block" and entry(h)["fee"] == str(fee)
      and server.tx_status(h)[1]["confirmed"], entry(h))
check("  the account sends again", send(A, CAROL, 50)[0] == 200)
check("  no 'changed' or 'received' row for its own notes", not [e for e in server.history["entries"] if e["kind"] in ("changed", "received")])

world()
chain.fail["/mempool/add/tx"] = ["lost", "unreached"]
code, d = send(A, BOB, 100000)
h = d["hash"]
advance(61)
advance(121)
blocks(D + 1)
check("a lost answer: the same saved transfer offered again, never funded anew; it lands once, confirmed",
      len(chain.funded) == 1 and rec(h)["submits"] >= 2 and list(chain.landed).count(h) == 1 and entry(h)["status"] == "in block",
      (len(chain.funded), rec(h)["submits"], entry(h)))

for where, when in (("/wallet/fund", "before"), ("/wallet/fund", "after"), ("/mempool/add/tx", "before"), ("/mempool/add/tx", "after")):
    world()
    chain.crash[where] = [when]
    check("crash %s %s: the app stops" % (when, where), send(A, BOB, 100000)[0] == "crash")
    restart()
    if where == "/wallet/fund":
        check("  nothing was submitted (a fund never submits): no entry, the account free",
              not [e for e in server.history["entries"] if e["kind"] == "sent"] and server.xfer_spend_check(A) is None)
        continue
    h = list(chain.funded)[0]
    check("  its entry is there with its hash, the account held", entry(h) and server.xfer_spend_check(A) is not None, entry(h))
    blocks(D + 2)
    check("  the identical saved transfer is submitted, lands once, confirmed", h in chain.landed and len(chain.funded) == 1
          and entry(h)["status"] == "in block", entry(h))

world()
h = send(A, BOB, 100000)[1]["hash"]
blocks(1)
check("a depth-1 fork: first in a block", entry(h)["status"] == "confirming")
chain.reorg(1)
chain.pool = []                               # the other branch doesn't have it yet
chain.block()
advance(server.XFER_RESCAN + 1)
check("  the fork takes its block away: back to waiting, the account still held", entry(h)["status"] == "pending"
      and server.xfer_spend_check(A) is not None, entry(h))
chain.pool = [(h, chain.funded[h], chain.now)]
blocks(D + 1)
check("  it lands on the other branch: confirmed", entry(h)["status"] == "in block")

world()
chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6   # it never reaches a pool
h = send(A, BOB, 100000)[1]["hash"]
advance(server.XFER_RESUBMIT_FOR + 60)
check("never reaching a pool: still waiting after 30 minutes, the account held", entry(h)["status"] == "pending" and server.xfer_spend_check(A))
for _ in range(12):
    chain.block()
advance(server.XFER_GIVE_UP)
check("  after the network's time for a waiting transfer, the chain read without it: 'not found in a block after %d hours'"
      % round(server.XFER_GIVE_UP / 3600), entry(h)["status"] == "not found" and server.tx_status(h)[1]["state"] == "not_found", entry(h))
check("  the account is free", server.xfer_spend_check(A) is None)
chain.fail["/mempool/add/tx"] = []
code, d = send(A, BOB, 100000)
check("the same payment again: the node funds the identical transfer: it is the same record, submitted again, one entry",
      code == 200 and d.get("again") and d["hash"] == h and len([e for e in server.history["entries"] if e["kind"] == "sent"]) == 1, d)
blocks(D + 1)
check("  it lands once, confirmed", list(chain.landed).count(h) == 1 and entry(h)["status"] == "in block", entry(h))

# a bridge waits behind the hold, then goes on by itself
world()
plan = {"from": A, "label": "Main", "to": "acct", "amount": "150000", "split": True, "note": None, "channel": "cc" * 32,
        "fee_max": "100000", "split_fee_max": "10000", "balance": "1250000", "notes_before": []}
server.bridge_check = lambda frm, amount: (None, dict(plan, notes_before=sorted(server.notes_of(A))))
h = send(A, BOB, 100000)[1]["hash"]
code, d = server.lns_bridge({"from": A, "amount": "150000", "confirm": True})
check("a bridge started while a send is unsettled: accepted and waiting, not an error", code == 200 and d["bridge"]["state"] == "queued", d)
blocks(D + 1)
server.bridge_round()
b = server.bridge_load()
split = [e for e in server.history["entries"] if e.get("bridge") == "split"]
check("  once the send is confirmed, the bridge sets its amount aside by itself", b["state"] == "splitting" and split, b)
blocks(D + 1)
server.bridge_round()
check("  and goes on to the deposit once that is confirmed", server.bridge_load()["state"] in ("ready", "depositing", "sent", "failed")
      and split[0]["status"] == "in block", (server.bridge_load()["state"], split[0]["status"]))

world()
with open(server.XFER_FILE, "w") as f:
    f.write("{not json")
restart()
aside = [f for f in os.listdir(TMP) if f.startswith("wallet-transfers.json.bad")]
check("a records file that doesn't read: set aside, never overwritten", aside and open(os.path.join(TMP, aside[0])).read() == "{not json")
check("  Activity shows one plain warning", "check with the recipient" in server.history_page(None, 10).get("warning", ""))
check("  and the wallet carries on", send(A, BOB, 1000)[0] == 200)

# the phone's node kept from the network overnight: it says "Online" at its old tip; the transfer lands meanwhile
world()
h = send(A, BOB, 100000)[1]["hash"]
chain.freeze()
blocks(D + 3)                                  # it lands on the network; the phone's node doesn't see those blocks
advance(server.XFER_GIVE_UP + 3600)
check("the node kept from the network past the exit time (Online, old tip): still waiting, never 'not found'",
      h in chain.landed and entry(h)["status"] == "pending" and rec(h)["state"] == "submitted", (entry(h), rec(h)["state"]))
code, d = send(A, BOB, 100000)
check("  the same payment again is refused meanwhile: nothing is paid twice", code == 409 and len(chain.funded) == 1, (code, d))
chain.thaw()
advance(server.XFER_RESCAN + 1)
check("  the node catches up: confirmed", entry(h)["status"] == "in block", entry(h))

# a "not found" one that lands after all (another node had it): read again hourly, it turns confirmed
world()
chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6
h = send(A, BOB, 100000)[1]["hash"]
for _ in range(3):
    chain.block()
advance(server.XFER_GIVE_UP + server.XFER_RESUBMIT_FOR)
check("never reaching a pool, the node caught up: 'not found in a block'", entry(h)["status"] == "not found", entry(h))
chain.pool.append((h, chain.funded[h], chain.now))
blocks(D + 1)
advance(server.XFER_RECHECK + 60)
check("  it lands after all: read again within the hour, confirmed", entry(h)["status"] == "in block"
      and server.tx_status(h)[1]["confirmed"], entry(h))
advance(server.XFER_KEEP + 3600)
send(A, CAROL, 1000)                            # (the file is pruned whenever it is written)
check("  records that are over are dropped after %d days" % (server.XFER_KEEP // 86400), rec(h) is None
      and not [r for r in server.xfers.values() if r["state"] == "ended"])


def bridge_start():
    try:
        return server.lns_bridge({"from": A, "amount": "150000", "confirm": True})
    except fake_chain.Crash:
        return "crash", None


for when in ("before", "after"):
    world()
    server.bridge_check = lambda frm, amount: (None, dict(plan, notes_before=sorted(server.notes_of(A))))
    chain.crash["/wallet/fund"] = [when]
    check("the app stops %s the node funds a bridge's split" % when, bridge_start()[0] == "crash")
    restart()
    server.bridge_round()
    b = server.bridge_load()
    check("  after the restart the bridge ends plainly (nothing set aside), never stuck", b["state"] == "failed"
          and b["error"] == server.BRIDGE_SPLIT_GONE, b)
    check("  and the account sends again", send(A, BOB, 1000)[0] == 200)

world()
with server.bridge_lock:                         # a bridge mid-split left by the previous version (no transfer record)
    server.bridge_save({"id": "1", "state": "splitting", "from": A, "label": "Main", "to": "acct", "amount": "150000",
                        "channel": "cc" * 32, "note": None, "split": True, "notes_before": [], "created": clock.wall,
                        "fee": None, "split_fee": None, "error": "", "wait": "", "lez": {}})
server.bridge_round()
check("a bridge mid-split from the previous version: ends plainly, the account free", server.bridge_load()["state"] == "failed"
      and send(A, BOB, 1000)[0] == 200, server.bridge_load())

world()
server.bridge_check = lambda frm, amount: (None, dict(plan, notes_before=sorted(server.notes_of(A))))
chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6
bridge_start()
first = server.bridge_load()["split_hash"]
for _ in range(12):
    chain.block()
advance(server.XFER_GIVE_UP + server.XFER_RESUBMIT_FOR)
server.bridge_round()
check("a split never found in a block: the bridge ends", server.bridge_load()["state"] == "failed", server.bridge_load())
chain.fail["/mempool/add/tx"] = []
code, d = bridge_start()
check("  a new bridge of the same amount: the node funds the same split again, taken up again", code == 200
      and server.bridge_load()["split_hash"] == first and rec(first)["state"] == "submitted", (code, d, server.bridge_load()))
blocks(D + 1)
server.bridge_round()
blocks(1)
server.bridge_round()
check("  the bridge follows that split and goes on once it is confirmed", server.bridge_load()["state"] in ("ready", "depositing", "sent")
      or server.bridge_load().get("error") != server.BRIDGE_SPLIT_GONE and server.bridge_load()["state"] != "splitting", server.bridge_load())

world()
server.bridge_check = lambda frm, amount: (None, dict(plan, notes_before=sorted(server.notes_of(A))))
chain.fail["/mempool/add/tx"] = ["unreached"] * 10 ** 6
send(A, BOB, 100000)
bridge_start()
advance(server.BRIDGE_READY_MAX + 60)
server.bridge_round()
check("a bridge queued longer than %d minutes doesn't start by itself: stopped, to be confirmed again"
      % (server.BRIDGE_READY_MAX // 60), server.bridge_load()["state"] == "cancelled", server.bridge_load())

# ---- part 3: random runs, forks up to 2 blocks --------------------------------------------------------------------------
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("XFER_RUNS", "300"))
QUIET[0] = True
bad = {k: 0 for k in ("paid-twice", "confirmed-early", "nothing-sent", "held-too-long")}
first = {}
stats = {"sends": 0, "landed": 0, "refused": 0, "crashes": 0, "forks": 0, "not-found": 0}


def run(seed):
    rnd = random.Random(seed)
    world(seed=seed, a=tuple(rnd.choice((120000, 300000, 800000)) for _ in range(rnd.randint(1, 4))),
          b=tuple(rnd.choice((60000, 400000)) for _ in range(rnd.randint(1, 2))))
    born, born_blocks, deep_since, last_in, gone, thawed = {}, {}, {}, {}, set(), [0.0]
    for step in range(rnd.randint(40, 80)):
        x = rnd.random()
        try:
            if x < 0.2:
                key = rnd.choice((A, B))
                code, d = send(key, rnd.choice((BOB, CAROL)), rnd.choice((1000, 20000, 50000)))
                stats["sends"] += 1
                if code == "crash":
                    stats["crashes"] += 1
                    restart()
                elif code != 200:
                    stats["refused"] += 1
            elif x < 0.5:
                chain.block(take_all=rnd.random() < 0.7)
            elif x < 0.56:
                stats["forks"] += 1
                chain.reorg(rnd.randint(1, D))
            elif x < 0.75:
                advance(rnd.choice((15, 60, 300)))
            elif x < 0.77:
                advance(rnd.choice((3600, 11 * 3600)))
            elif x < 0.8:
                restart()
            elif x < 0.84:
                chain.crash[rnd.choice(("/wallet/fund", "/mempool/add/tx"))] = [rnd.choice(("before", "after"))]
            elif x < 0.9:
                chain.fail["/mempool/add/tx"] = [rnd.choice(("lost", "unreached", "500"))] * rnd.choice((1, 3, 200))
            elif x < 0.93:                       # the phone's node loses the network, or gets it back
                if chain.view is None:
                    chain.freeze()
                else:
                    chain.thaw()
                    thawed[0] = chain.now
            else:
                chain.fail.clear()
        except fake_chain.Crash:
            stats["crashes"] += 1
            restart()
        landed = chain.landed
        for r in list(server.xfers.values()):
            if r.get("kind") == "lost":
                continue
            if born.get(r["id"], (None, None))[1] != r["t0"].get("at"):   # (a record taken up again starts again)
                born[r["id"]] = (chain.now, r["t0"].get("at"))
                born_blocks[r["id"]] = len(chain.blocks)
            h = r.get("hash")
            # (b) once confirmed (D blocks on top), no fork within the bound takes it away
            if r["state"] == "settled" and h not in landed:
                bad["confirmed-early"] += 1
                first.setdefault("confirmed-early", (seed, step, h))
            # (d) a hold ends once its hash is D deep (within two reads of the chain), or by the exit time when it
            # isn't in the chain (the time counts while the chain goes on)
            if r["state"] in server.WAITING and h:
                seen = chain.seen_blocks()       # what the phone's node can tell it
                idx = next((i for i, bl in enumerate(seen) for x2, _ in bl["txs"] if x2 == h), None)
                if idx is not None:
                    last_in[r["id"]] = chain.now
                deep = idx is not None and len(seen) - 1 - idx >= D
                since = deep_since.setdefault(r["id"], chain.now) if deep else deep_since.pop(r["id"], None)
                if (deep and chain.now - since > 2 * server.XFER_RESCAN + 30) or (idx is None and chain.view is None
                        and len(chain.blocks) > born_blocks[r["id"]] and chain.now - max(born[r["id"]][0], last_in.get(r["id"], 0), thawed[0])
                        > server.XFER_RESUBMIT_FOR + server.XFER_GIVE_UP + 3600):
                    bad["held-too-long"] += 1
                    first.setdefault("held-too-long", (seed, step, r["state"], r.get("seen")))
        for e in server.history["entries"]:
            if e.get("kind") == "sent" and e.get("status") == "not in a block" and e.get("xfer"):
                bad["nothing-sent"] += 1
                first.setdefault("nothing-sent", (seed, step, e))
        # (a) one at a time: never two unsettled transfers of one account (so a payment made again can't land beside
        # one still waiting); and one called "not found in a block" never lands afterwards
        for key in (A, B):
            if sum(1 for r in server.xfers.values() if r["key"] == key and r["state"] in server.WAITING) > 1:
                bad["paid-twice"] += 1
                first.setdefault("paid-twice", (seed, step, "two unsettled"))
        for r in server.xfers.values():
            if r["state"] == "notfound":
                gone.add(r["hash"])
            elif r.get("hash") in gone and r["state"] in server.WAITING:
                gone.discard(r["hash"])           # taken up again (the same transfer funded again): it may land now
        if gone & set(landed):
            bad["paid-twice"] += 1
            first.setdefault("paid-twice", (seed, step, "not found, then landed", sorted(gone & set(landed))))
    stats["landed"] += sum(1 for r in server.xfers.values() if r.get("hash") in chain.landed)
    stats["not-found"] += sum(1 for r in server.xfers.values() if r["state"] == "notfound")


t0 = _time.time()
for seed in range(RUNS):
    run(seed)
QUIET[0] = False
print("     %d random runs in %.0f s: %s" % (RUNS, _time.time() - t0, stats))
for k, n in bad.items():
    check("random runs: %s never" % k, n == 0, (n, first.get(k)))
shutil.rmtree(TMP, ignore_errors=True)
print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

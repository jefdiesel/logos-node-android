#!/usr/bin/env python3
"""A transfer that may still land is never sent twice (review E5, F1, F5, DELTA4 M1, M2, S1-S5).

  python3 tests/send_unsure_test.py

Imports app/server.py and calls send() (and bridge_check()) with the node's answers replaced. A hold is set before the
transfer goes to the node; only a definite answer about that same transfer drops it (a hash, a refusal the node
answered, a connection the node never took); otherwise it holds for 30 minutes on the boot clock, the send is in
Activity as pending, and every spend from that account is refused. Each of the reviews' probes is a case below.
"""
import json, os, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = tempfile.mkdtemp()
os.environ.update(APP_DATA=DATA, NODE_BIN="/nonexistent", SEND_UNSURE_HOLD_SECONDS="1800")
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

FAILS = []
# (so the test also runs on the code before review DELTA4, to show which cases fail there)
if not hasattr(server, "send_hold_lock"):
    server.send_hold_lock = server.lock
    server.send_hold_new = lambda amount=0, to="", hid=None: {"before": 10_000_000, "amount": amount, "at": time.time(), "mono": time.monotonic(), "id": hid or "x"}
    server._node_reach = threading.local()
    server.boot_id = lambda: ""


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (" - " + str(detail)[:300] if not ok and detail != "" else ""))
    if not ok:
        FAILS.append(name)


A, B, C = "a1" * 32, "b2" * 32, "c3" * 32
state = {"balance": 10_000_000, "answers": [], "posts": 0, "gate": None, "boot": "boot-A"}
server.wallet_keys = lambda: [{"key": A, "label": "Main"}, {"key": C, "label": "Other"}]
server.node_status = lambda: {"state": "Online", "height": 10}
server.balance_of = lambda k: (state["balance"], {})
server.boot_id = lambda: state["boot"]
server.history_save = getattr(server, "history_save", lambda: None)
hashes = iter("%064x" % i for i in range(1, 1000))


def fake_node(path, body=None, timeout=8):
    if path == "/wallet/transactions/transfer-funds":
        state["posts"] += 1
        if state["gate"]:
            state["gate"].wait(10)
        a = state["answers"].pop(0) if state["answers"] else ("hash",)
        if a == ("hash",):
            return 201, {"hash": next(hashes)}
        if a == ("unreached",):
            server._node_reach.refused = True
            return 0, None
        return a
    return 404, None


server.node = fake_node


def send(amount=100, to=B, frm=A):
    return server.send({"from": frm, "to": to, "amount": amount})


def reset():
    with server.send_hold_lock:
        server.send_unsure.clear()
        if hasattr(server, "send_unsure_loaded"):
            server.send_unsure_loaded[0] = True
        getattr(server, "send_holds_save", lambda: None)()
    with server.hist_lock:
        server.history["entries"] = [e for e in server.history["entries"] if e.get("kind") != "sent"]
    state.update(balance=10_000_000, answers=[], posts=0, gate=None, boot="boot-A")


def restart():
    with server.send_hold_lock:
        server.send_unsure.clear()
        if hasattr(server, "send_unsure_loaded"):
            server.send_unsure_loaded[0] = False


def unsure_entries():
    return [e for e in server.history["entries"] if e.get("kind") == "sent" and e.get("unsure")]


# ---- the plain case, and Activity (S2) ------------------------------------------------------------------------------
reset()
state["answers"] = [(0, None)]
code, d = send()
check("no answer: it may have been sent", code == 502 and d.get("unsure") and "may have been sent" in d["error"], (code, d))
check("and it is in Activity, pending, marked unsure (S2)", len(unsure_entries()) == 1 and unsure_entries()[0]["status"] == "pending", unsure_entries())
code, d = send()
check("the next send is refused, saying for how long and where to look (S5)", code == 409 and "about 30 minutes" in d["error"] and "Activity" in d["error"], (code, d))
check("and never reaches the node", state["posts"] == 1, state["posts"])

# ---- M1, P1: an earlier send landing doesn't lift a later unsure one --------------------------------------------------
reset()
state["answers"] = [("hash",), (0, None)]
check("(Bob: sent)", send(100, B)[0] == 200)
check("(Carol: no answer)", send(50, C)[0] == 502)
state["balance"] = 10_000_000 - 107                     # Bob's transfer lands
code, d = send(50, C)
check("M1 P1: Bob's landing doesn't lift the hold on Carol's: the retry is refused", code == 409 and state["posts"] == 2, (code, d, state["posts"]))
# P1b: the same amount twice
reset()
state["answers"] = [("hash",), (0, None)]
send(100, B)
send(100, B)
state["balance"] = 10_000_000 - 107
code, d = send(100, B)
check("M1 P1b: same amount twice, the first lands: the retry is refused", code == 409 and state["posts"] == 2, (code, d, state["posts"]))

# ---- M1, P2: a bridge from the same account is refused while a send is held -------------------------------------------
reset()
lns_file = os.path.join(DATA, "lns-storage.bin")
open(lns_file, "w").close()
server.lns_state = lambda: {"account": "Public/" + "1" * 32}
server.lns_storage = lambda: lns_file
state["answers"] = [(0, None)]
send(100, B)
code, d = server.bridge_check(A, 500_000)
check("M1 P2: no bridge from an account with a send held, saying when it frees", code == 409 and "minutes" in d["error"], (code, d))

# ---- M1, P3: a send pops only its own hold ------------------------------------------------------------------------------
reset()
state["gate"] = threading.Event()
state["answers"] = [("hash",)]
res = {}
t = threading.Thread(target=lambda: res.update(r=send(100, B)))
t.start()
time.sleep(0.3)
with server.send_hold_lock:                              # another send's hold took the place meanwhile
    other = server.send_hold_new(50, C)
    server.send_holds()[A] = other
state["gate"].set()
t.join(10)
check("M1 P3: S1's hash doesn't remove another send's hold", server.send_unsure.get(A, {}).get("id") == other["id"], server.send_unsure.get(A))

# ---- M2: the node's 30 s timeout, and its 500s ---------------------------------------------------------------------------
for answer, name in (((408, ""), "a 408 (the node's own 30 s timeout)"), ((500, "Failed to add tx"), "a 500 'Failed to add tx'"),
                     ((500, {"error": "Failed to add tx: mempool"}), "a 500 'Failed to add tx' as JSON"),
                     ((201, {"note": "accepted"}), "a 2xx without a hash (F5)")):
    reset()
    state["answers"] = [answer]
    code, d = send()
    check("M2: %s is unsure, not refused" % name, code == 502 and d.get("unsure") and "refused" not in d["error"], (code, d))
    check("  and the next send is refused", send()[0] == 409 and state["posts"] == 1, state["posts"])
reset()
state["answers"] = [(500, "insufficient funds")]
code, d = send()
check("another 500 is a refusal, with no hold", code == 502 and not d.get("unsure") and "refused" in d["error"], (code, d))
check("  the next send goes ahead", send()[0] == 200)

# ---- S3: a connection the node never took ---------------------------------------------------------------------------
reset()
state["answers"] = [("unreached",)]
code, d = send()
check("S3: the node didn't take the connection: nothing sent, no hold", code == 503 and "nothing was sent" in d["error"] and not unsure_entries(), (code, d))
check("  the next send goes ahead", send()[0] == 200)

# ---- restarts and the clock ---------------------------------------------------------------------------------------
reset()
state["answers"] = [(0, None)]
send()
restart()
check("the hold survives a restart of the app", send()[0] == 409 and state["posts"] == 1)
check("(on disk, owner-only)", (os.stat(server.SEND_UNSURE_FILE).st_mode & 0o777) == 0o600, oct(os.stat(server.SEND_UNSURE_FILE).st_mode))
with open(server.SEND_UNSURE_FILE) as f:
    held = json.load(f)
held[A]["at"] -= 31 * 60                                # S4: the wall clock moved forward 31 minutes before a restart
with open(server.SEND_UNSURE_FILE, "w") as f:
    json.dump(held, f)
restart()
code, d = send()
check("S4: a clock moved forward before a restart doesn't lift the hold (same boot: the boot clock counts)", code == 409, (code, d))
with server.send_hold_lock:
    server.send_holds()[A]["mono"] -= 1801
code, d = send()
check("after 30 minutes on the boot clock the hold is over", code == 200, (code, d))
check("  and its Activity entry is no longer pending", all(e["status"] != "pending" for e in unsure_entries()), unsure_entries())
reset()
state["answers"] = [(0, None)]
send()
with server.send_hold_lock:
    server.send_holds()[A]["mono"] -= 1700               # almost over in this boot (28 min 20 s)...
    server.send_holds()[A]["at"] -= 1700
    server.send_holds_save()
state["boot"] = "boot-B"                                 # ...then the phone restarts
restart()
code, d = send()
check("after a reboot the hold counts on from the wall time, not a full new 30 minutes (DELTA5 S1)", code == 409 and "about 2 minutes" in d["error"], (code, d))

# ---- S1: the file fails closed --------------------------------------------------------------------------------------
reset()
with open(server.SEND_UNSURE_FILE, "w") as f:
    f.write("{not json")
restart()
code, d = send()
check("S1: a corrupt file holds every account instead of none", code == 409 and state["posts"] == 0 and send(100, A, C)[0] == 409, (code, d))
reset()
good = server.send_hold_new(100, B)
with open(server.SEND_UNSURE_FILE, "w") as f:
    json.dump({C: {"id": "x", "at": "x"}, A: good}, f)
restart()
code, d = send()
check("S1: a bad entry doesn't drop the good one", code == 409 and state["posts"] == 0, (code, d))
check("S1: and the account with the bad entry is held too", send(100, B, C)[0] == 409)
reset()
os.unlink(server.SEND_UNSURE_FILE)
os.mkdir(server.SEND_UNSURE_FILE)                         # the file can't be written
code, d = send()
check("S1: a hold that can't be saved means no send", code == 503 and state["posts"] == 0, (code, d))
os.rmdir(server.SEND_UNSURE_FILE)
with open(server.SEND_UNSURE_FILE + ".tmp", "w") as f:    # a left-over .tmp with a loose mode
    f.write("{}")
os.chmod(server.SEND_UNSURE_FILE + ".tmp", 0o644)
state["answers"] = [(0, None)]
send()
check("S1: the file is 0600 even after a loose left-over .tmp", (os.stat(server.SEND_UNSURE_FILE).st_mode & 0o777) == 0o600)

# ---- the second send while the first waits, and definite answers ------------------------------------------------------
reset()
state["gate"] = threading.Event()
state["answers"] = [(0, None)]
first = {}
t = threading.Thread(target=lambda: first.update(r=send()))
t.start()
time.sleep(0.3)
code, d = send()
check("a second send while the first is on its way is refused", code == 409 and state["posts"] == 1, (code, d))
state["gate"].set()
t.join(10)
reset()
state["answers"] = [(400, "insufficient funds"), ("hash",)]
check("a refusal the node answered: no hold", send()[1].get("unsure") is None)
check("  the next send goes ahead", send()[0] == 200)

# ---- DELTA5 M1: a hashed send and an unsure one from the same account, both land ---------------------------------------
reset()
D = "d4" * 32
notes = {A: {"n1": 10_000_000}, C: {"m1": 5}}
server.notes_of = lambda k: dict(notes[k])
with server.hist_lock:
    server.history["snapshot"] = {}
server.history_round()                                   # the starting point
state["answers"] = [("hash",), (0, None)]
check("(Bob: sent)", send(100, B)[0] == 200)
check("(Carol: no answer)", send(50, D)[0] == 502)
code, d = send(50, D)
check("the 409 doesn't invite a blind retry: it says to check the balance first", code == 409 and "check the balance" in d["error"], d)
notes[A] = {"n2": 10_000_000 - 107}                      # Bob's transfer lands (fee 7)
server.history_round()
notes[A] = {"n3": 10_000_000 - 107 - 57}                 # then Carol's (fee 7)
server.history_round()
sends = {(e["to"], e["amount"]): e for e in server.history["entries"] if e.get("kind") == "sent"}
check("DELTA5 M1: Bob's transfer is in a block, not 'Confirming…' for good", sends[(B, "100")]["status"] == "in block" and sends[(B, "100")]["fee"] == "7", sends.get((B, "100")))
check("DELTA5 M1: Carol's landed transfer is in a block too", sends[(D, "50")]["status"] == "in block", sends.get((D, "50")))
check("  and nothing is left as 'changed'", not [e for e in server.history["entries"] if e.get("kind") == "changed"])
with server.send_hold_lock:
    server.send_holds()[A]["mono"] -= 1801
server.send_holds_sweep()
check("DELTA5 M1: when the hold ends, a landed send stays 'in block' (never 'not in a block')", sends[(D, "50")]["status"] == "in block", sends[(D, "50")])
code, d = server.bridge_check(A, 500_000)
check("DELTA5 M1: and bridging isn't blocked by a pending entry that never settles", "isn't in a block yet" not in str(d) and "may still go through" not in str(d), (code, d))
# an unsure send that never lands: after its hold, "unknown", not "not in a block"
reset()
notes[A] = {"n4": 9_000_000}
with server.hist_lock:
    server.history["snapshot"] = {}
server.history_round()
state["answers"] = [(0, None)]
send(70, D)
with server.send_hold_lock:
    server.send_holds()[A]["mono"] -= 1801
server.send_holds_sweep()                                 # what the history loop does, whether the account is used or not
e70 = [e for e in server.history["entries"] if e.get("kind") == "sent" and e["amount"] == "70"][0]
check("DELTA5 M1: a hold that ends without an answer marks its send 'unknown', not 'not in a block'", e70["status"] == "unknown", e70)
check("DELTA5 S1: and the ended hold is gone without the account being used", A not in server.send_unsure)
notes[A] = {"n5": 9_000_000 - 77}                         # it lands after all
server.history_round()
check("  and if it lands later, it is matched then", e70["status"] == "in block", e70)

# ---- DELTA5 S1: an ended hold never comes back after a reboot; no boot id; old file format; cap ------------------------
reset()
state["answers"] = [(0, None)]
send()
with server.send_hold_lock:
    server.send_holds()[A]["mono"] -= 1801
server.send_holds_sweep()
state["boot"] = "boot-C"
restart()
state["answers"] = [("hash",)]
check("DELTA5 S1: an ended hold stays ended after a reboot", send()[0] == 200)
reset()
state["boot"] = ""                                       # boot_id unreadable: what the app then derives
server.boot_id = lambda: "derived-%d" % round((time.time() - server.mono_now()) / 60)
state["answers"] = [(0, None)]
send()
with server.send_hold_lock:
    server.send_holds()[A]["mono"] -= 1500
    server.send_holds()[A]["at"] -= 1500
    server.send_holds_save()
for i in range(3):
    restart()                                            # three app restarts: the 30 minutes don't start over
code, d = send()
check("DELTA5 S1: without the kernel's boot id, app restarts don't restart the 30 minutes", code == 409 and "about 5 minutes" in d["error"], (code, d))
server.boot_id = lambda: state["boot"]
check("DELTA5 S1: the start-up line says which clock and boot id are used", len(server.send_clock_source()) == 2)
reset()
with open(server.SEND_UNSURE_FILE, "w") as f:
    json.dump({A: {"before": 10_000_000, "amount": 100, "at": time.time() - 600}}, f)   # 1073a9b's format, 10 min old
restart()
code, d = send()
check("an old-format hold counts from its time (about 20 minutes left), not as unreadable", code == 409 and "about 20 minutes" in d["error"] and "couldn't read" not in d["error"], (code, d))
reset()
with open(server.SEND_UNSURE_FILE, "w") as f:
    json.dump({A: {"before": 1, "amount": 1, "at": time.time() - 5 * 86400}}, f)       # an old one, long over
restart()
state["answers"] = [("hash",)]
check("an old-format hold that is long over is dropped", send()[0] == 200)
reset()
state["answers"] = [(0, None)]
send()
with server.send_hold_lock:
    server.send_holds()[A]["mono"] += 1e12               # a stored time ahead of now
check("a hold is never longer than 30 minutes", server.send_hold_left(server.send_holds()[A]) <= 1800)

# ---- DELTA5 S2, S3: the bridge split ------------------------------------------------------------------------------
plan = {"from": A, "label": "Main", "to": "Public/" + "1" * 32, "amount": "500000", "split": True, "fee_max": "1",
        "split_fee_max": "1", "balance": "1", "note": None, "channel": "c" * 64, "notes_before": []}
real_check = server.bridge_check
server.bridge_check = lambda frm, amount: (None, dict(plan))   # as if checked just before a send got held
server.bridge_view = lambda: {}
server.lez_act_add = lambda *a, **k: None
reset()
for f in (server.BRIDGE_FILE,) if hasattr(server, "BRIDGE_FILE") else ():
    try:
        os.unlink(f)
    except FileNotFoundError:
        pass
state["answers"] = [(0, None)]
send()                                                   # a send got held in between
posts = state["posts"]
code, d = server.lns_bridge({"from": A, "amount": "500000", "confirm": True})
check("DELTA5 S2: a bridge whose check ran before a send got held doesn't split", code == 409 and state["posts"] == posts, (code, d, state["posts"]))
for answer, want in (((0, None), "splitting"), ((408, ""), "splitting"), ((400, "bad"), "failed")):
    reset()
    with server.bridge_lock:
        try:
            os.unlink(server.BRIDGE_FILE)
        except Exception:
            pass
    state["answers"] = [answer]
    code, d = server.lns_bridge({"from": A, "amount": "500000", "confirm": True})
    with server.bridge_lock:
        b = server.bridge_load()
    check("DELTA5 S3: a split answered %s: the bridge is %s" % (answer[0], want), b and b["state"] == want, (code, d, b and b.get("state")))
server.bridge_check = real_check

print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

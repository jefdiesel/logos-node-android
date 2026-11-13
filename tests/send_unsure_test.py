#!/usr/bin/env python3
"""A transfer that may still land is never sent twice (review E5, F1, F5).

  python3 tests/send_unsure_test.py

Imports app/server.py and calls send() with the node's answers replaced. A hold is set before the transfer goes to
the node and only a definite answer drops it (a hash, or a refusal the node answered). With no clear answer (status 0:
a timeout or an answer cut short; or a 2xx without a hash) the next send from that account is refused until the
balance has dropped by the held amount or the hold time has passed. Each of the review's bypasses is a case below:
an incoming payment, a second send while the first is still waiting on the node, an odd balance read, a restart of
the app, and a clock set back.
"""
import json, os, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = tempfile.mkdtemp()
os.environ.update(APP_DATA=DATA, NODE_BIN="/nonexistent", SEND_UNSURE_HOLD_SECONDS="1800")
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (" - " + str(detail)[:300] if not ok and detail != "" else ""))
    if not ok:
        FAILS.append(name)


A, B = "a1" * 32, "b2" * 32
state = {"balance": 10000, "answer": (0, None), "posts": 0, "gate": None}
server.wallet_keys = lambda: [{"key": A, "label": "Main"}]
server.node_status = lambda: {"state": "Online", "height": 10}
server.balance_of = lambda k: (state["balance"], {})
server.history_record_send = lambda entry: None


def fake_node(path, body=None, timeout=8):
    if path == "/wallet/transactions/transfer-funds":
        state["posts"] += 1
        if state["gate"]:
            state["gate"].wait(10)              # the node takes its time (up to the 60 s timeout in real life)
        return state["answer"]
    return 404, None


server.node = fake_node
send = lambda amount=100: server.send({"from": A, "to": B, "amount": amount})


def reset(balance=10000):
    with server.lock:
        server.send_unsure.clear()
        getattr(server, "send_holds_save", lambda: None)()     # (tolerates the code before review F1, to show it fail)
    state.update(balance=balance, answer=(0, None), posts=0, gate=None)


def restart():
    """What a restart of the app keeps: only the file."""
    with server.lock:
        server.send_unsure.clear()
        if hasattr(server, "send_unsure_loaded"):
            server.send_unsure_loaded[0] = False


# ---- the plain case ---------------------------------------------------------------------------------------------
reset()
code, d = send()
check("no answer from the node: it says the transfer may have been sent", code == 502 and d.get("unsure") and "may have been sent" in d["error"], (code, d))
code, d = send()
check("the next send from that account is refused", code == 409 and d.get("unsure"), (code, d))
check("and never reaches the node", state["posts"] == 1, state["posts"])

# ---- F1 bypass 1: anyone sends the account a coin -----------------------------------------------------------------
state["balance"] = 10001
code, d = send()
check("an incoming payment doesn't lift the hold (F1)", code == 409 and state["posts"] == 1, (code, d, state["posts"]))
state["balance"] = 10000 - 100 - 7 + 1                       # the held transfer landed (fee 7) and the coin arrived
state["answer"] = (201, {"hash": "cd" * 32})
code, d = send()
check("once the balance shows the held amount gone, sending works again", code == 200 and d.get("hash") == "cd" * 32, (code, d))
check("and a sent transfer leaves no hold", A not in server.send_unsure, server.send_unsure)

# ---- F1 bypass 2: a second send while the first still waits on the node -------------------------------------------
reset()
state["gate"] = threading.Event()
first = {}
t = threading.Thread(target=lambda: first.update(r=send()))
t.start()
time.sleep(0.3)
code, d = send()                                            # a reload or a second tab, meanwhile
check("a second send while the first is still on its way is refused (F1)", code == 409 and state["posts"] == 1, (code, d, state["posts"]))
state["gate"].set()
t.join(10)
check("(the first one: no answer)", first.get("r", (0,))[0] == 502, first.get("r"))

# ---- F1 bypass 3: an odd balance read ----------------------------------------------------------------------------
reset(balance=5_000_000)
send()
state["balance"] = 0                                        # one read of 0 (a node starting, a wallet not caught up)
check("an odd balance read is refused...", send()[0] == 400)
state["balance"] = 5_000_000
code, d = send()
check("...and doesn't lift the hold (F1)", code == 409 and state["posts"] == 1, (code, d, state["posts"]))
state["balance"] = 50                                       # a read far below what the transfer could have cost
code, d = send(10)
check("a balance far below before minus the held amount and the largest fee isn't taken for it landing", code == 409, (code, d))

# ---- F1 bypass 4: the app restarts -------------------------------------------------------------------------------
reset()
send()
restart()
code, d = send()
check("the hold survives a restart of the app (F1)", code == 409 and state["posts"] == 1, (code, d, state["posts"]))
check("(it is on disk, owner-only)", os.path.exists(getattr(server, "SEND_UNSURE_FILE", "/nonexistent")) and (os.stat(server.SEND_UNSURE_FILE).st_mode & 0o077) == 0)
if not hasattr(server, "SEND_UNSURE_FILE"):
    print("%d FAILED (no hold on disk: the code before review F1)" % len(FAILS))
    sys.exit(1)

# ---- the clock -----------------------------------------------------------------------------------------------------
reset()
send()
with open(server.SEND_UNSURE_FILE) as f:
    held = json.load(f)
held[A]["at"] = time.time() + 86400                        # stored before the clock was set back a day
with open(server.SEND_UNSURE_FILE, "w") as f:
    json.dump(held, f)
restart()
code, d = send()
check("a clock set back doesn't stretch the hold beyond 30 minutes", code == 409 and "about 30 minutes" in d["error"], (code, d))
held[A]["at"] = time.time() - 1801                         # an old hold, from before a restart
with open(server.SEND_UNSURE_FILE, "w") as f:
    json.dump(held, f)
restart()
state["answer"] = (201, {"hash": "ef" * 32})
code, d = send()
check("after 30 minutes the hold is over", code == 200, (code, d))
with server.lock:
    server.send_unsure[A] = {"before": 10000, "amount": 100, "at": time.time(), "mono": time.monotonic() - 1801}
code, d = send()
check("within the app, the 30 minutes run on the monotonic clock", code == 200, (code, d))

# ---- F5, and definite answers -------------------------------------------------------------------------------------
reset()
state["answer"] = (201, {"note": "accepted"})
code, d = send()
check("an accepted answer without a hash is 'may have been sent', not 'refused' (F5)", code == 502 and d.get("unsure") and "refused" not in d["error"], (code, d))
check("and it holds", send()[0] == 409)
reset()
state["answer"] = (400, "insufficient funds")
code, d = send()
check("a refusal the node did answer is reported as before", code == 502 and not d.get("unsure") and "refused" in d["error"], (code, d))
state["answer"] = (201, {"hash": "aa" * 32})
check("and leaves no hold: the next send goes ahead", send()[0] == 200)

print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

#!/usr/bin/env python3
"""A transfer the node gave no answer about is not invited twice (review E5).

  python3 tests/send_unsure_test.py

Imports app/server.py and calls send() with the node's answers replaced: no answer (a timeout, or an answer cut
short: node() returns status 0) must say it may have gone through, and the next send from that account is refused
until its balance moves or SEND_UNSURE_HOLD_SECONDS pass. An answer from the node is unaffected.
"""
import os, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.update(APP_DATA=tempfile.mkdtemp(), NODE_BIN="/nonexistent", SEND_UNSURE_HOLD_SECONDS="2")
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (" - " + str(detail)[:300] if not ok and detail != "" else ""))
    if not ok:
        FAILS.append(name)


A, B = "a1" * 32, "b2" * 32
state = {"balance": 10000, "answer": (0, None), "posts": 0}
server.wallet_keys = lambda: [{"key": A, "label": "Main"}]
server.node_status = lambda: {"state": "Online", "height": 10}
server.balance_of = lambda k: (state["balance"], {})
server.history_record_send = lambda entry: None


def fake_node(path, body=None, timeout=8):
    if path == "/wallet/transactions/transfer-funds":
        state["posts"] += 1
        return state["answer"]
    return 404, None


server.node = fake_node
send = lambda amount=100: server.send({"from": A, "to": B, "amount": amount})

code, d = send()
check("no answer from the node: 502, and it says the transfer may have been sent", code == 502 and d.get("unsure") and "may have been sent" in d["error"], (code, d))
code, d = send()
check("the next send from that account is refused while nothing moved", code == 409 and d.get("unsure"), (code, d))
check("and it never reached the node", state["posts"] == 1, state["posts"])
state["balance"] = 9890                                     # the first one landed after all
state["answer"] = (201, {"hash": "cd" * 32})
code, d = send()
check("once the balance moves, sending works again", code == 200 and d.get("hash") == "cd" * 32, (code, d))
state["answer"] = (0, None)
send()
time.sleep(2.2)
state["answer"] = (201, {"hash": "ef" * 32})
code, d = send()
check("or once the hold time has passed", code == 200, (code, d))
state["answer"] = (400, "insufficient funds")
code, d = send()
check("a refusal the node did answer is reported as before, with no hold", code == 502 and not d.get("unsure") and "refused" in d["error"], (code, d))
state["answer"] = (201, {"hash": "aa" * 32})
check("and the next send goes ahead", send()[0] == 200)
print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

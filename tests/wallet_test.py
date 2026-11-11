#!/usr/bin/env python3
"""End-to-end checks of the web app, run in CI against a real node.

  wallet_test.py guard   the wallet's locks: PIN, session, own-page-only, pause after wrong PINs
  wallet_test.py send    a real transfer on a private one-node chain with funded test keys
"""
import json, sys, time, urllib.error, urllib.request

BASE = "http://127.0.0.1:8090"


def call(path, body=None, session=None, origin=BASE, host=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        if origin:
            req.add_header("Origin", origin)
    if session:
        req.add_header("X-Session", session)
    if host:
        req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw, code = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    try:
        return code, json.loads(raw)
    except Exception:
        return code, {"raw": raw.decode(errors="replace")[:200]}


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ((" - " + str(detail)) if detail and not cond else ""))
    if not cond:
        sys.exit(1)


def wait_accounts(session, want=1, tries=30):
    for _ in range(tries):
        code, d = call("/api/wallet/accounts", session=session)
        if code == 200 and len(d.get("accounts", [])) >= want and all(a["balance"] is not None for a in d["accounts"]):
            return d
        time.sleep(4)
    check("the wallet lists its keys with balances", False, d)


def guard():
    code, d = call("/api/status", host="evil.example")
    check("status is readable under any host name", code == 200 and "node" in d, (code, d))
    code, d = call("/api/wallet", host="evil.example")
    check("wallet refuses a request addressed to another host name", code == 403, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "246810"}, origin=None)
    check("wallet refuses a POST with no Origin", code == 403, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "246810"}, origin="https://evil.example")
    check("wallet refuses a POST from another website", code == 403, (code, d))
    code, d = call("/api/wallet")
    check("no PIN is set at first", code == 200 and d.get("pin_set") is False and d.get("unlocked") is False, (code, d))
    code, d = call("/api/wallet/accounts")
    check("accounts are refused before unlocking", code == 401, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "12"})
    check("a short PIN is refused", code == 400, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "246810"})
    check("setting a PIN opens a session", code == 200 and len(d.get("session", "")) == 64, (code, d))
    s = d["session"]
    code, d = call("/api/wallet/setup", {"pin": "111111"})
    check("the PIN can't be set a second time", code == 409, (code, d))
    d = wait_accounts(s)
    main = d["accounts"][0]
    check("the first key is the node's main key, 64 hex characters", main["label"] == "Main" and len(main["key"]) == 64, main)
    code, d = call("/api/wallet/accounts", session="0" * 64)
    check("a made-up session is refused", code == 401, (code, d))
    code, d = call("/api/wallet/send", {"from": main["key"], "to": "xyz", "amount": 5}, session=s)
    check("a malformed address is refused", code == 400, (code, d))
    code, d = call("/api/wallet/send", {"from": "ab" * 32, "to": "cd" * 32, "amount": 5}, session=s)
    check("a 'from' key outside the wallet is refused", code == 400, (code, d))
    code, st = call("/api/status")
    if (st.get("node") or {}).get("state") != "Online":
        code, d = call("/api/wallet/send", {"from": main["key"], "to": "cd" * 32, "amount": 5}, session=s)
        check("sending is refused while the node is not online", code == 409, (code, d))
    code, d = call("/api/wallet/lock", {}, session=s)
    code, d = call("/api/wallet/accounts", session=s)
    check("locking ends the session", code == 401, (code, d))
    for i in range(5):
        code, d = call("/api/wallet/unlock", {"pin": "000000"})
        check("wrong PIN %d is refused" % (i + 1), code == 401, (code, d))
    code, d = call("/api/wallet/unlock", {"pin": "246810"})
    check("after 5 wrong PINs even the right one has to wait", code == 429 and d.get("wait", 0) > 0, (code, d))


def send():
    for _ in range(60):
        code, st = call("/api/status")
        if (st.get("node") or {}).get("state") == "Online":
            break
        time.sleep(3)
    check("the one-node test chain is online", (st.get("node") or {}).get("state") == "Online", st)
    code, d = call("/api/wallet/setup", {"pin": "135790"})
    check("PIN set", code == 200, (code, d))
    s = d["session"]
    accts = wait_accounts(s, want=3)["accounts"]
    for a in accts:
        print("     %-8s %s  %s" % (a["label"], a["key"][:12], a["balance"]))
    rich = max(accts, key=lambda a: int(a["balance"]))
    check("a funded test key exists", int(rich["balance"]) >= 10000, rich)
    to = [a for a in accts if a["key"] != rich["key"] and a["label"] not in ("Main", "Service")][-1]
    amount, rich0, to0 = 1000, int(rich["balance"]), int(to["balance"])
    code, d = call("/api/wallet/send", {"from": rich["key"], "to": to["key"], "amount": rich0 + 1}, session=s)
    check("sending more than the key holds is refused", code == 400, (code, d))
    code, d = call("/api/wallet/send", {"from": rich["key"], "to": to["key"], "amount": amount}, session=s)
    check("the node accepts the transfer", code == 200 and d.get("hash"), (code, d))
    h = d["hash"]
    print("     transaction", h)
    state = {}
    for _ in range(90):
        code, state = call("/api/wallet/tx?hash=" + h, session=s)
        if state.get("state") == "in_block":
            break
        time.sleep(4)
    check("the transfer lands in a block", state.get("state") == "in_block", state)
    fee = int(state["fee"])
    print("     fee paid:", fee)
    check("the fee is positive and small", 0 < fee < 100000, fee)
    after = {a["key"]: int(a["balance"]) for a in wait_accounts(s, want=3)["accounts"]}
    check("the receiver got exactly the amount", after[to["key"]] == to0 + amount, (to0, after[to["key"]]))
    check("the sender paid the amount plus the fee", after[rich["key"]] == rich0 - amount - fee, (rich0, after[rich["key"]]))


if __name__ == "__main__":
    {"guard": guard, "send": send}[sys.argv[1]]()
    print("all checks passed")

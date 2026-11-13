#!/usr/bin/env python3
"""Getting LEZ into the phone's name account (android/NAMES.md, "Getting LEZ"): the faucet, the bridge from the
app's own wallet through the node's HTTP API, the cost of a registration, and the LEZ balance route. Stand-ins
for the node's API, the sequencer, the faucet and the signer; no chain.

  python3 tests/lns_funding_test.py

The stand-in node keeps notes per key and puts a transfer or a deposit in a block only when the test says so,
so every step of a bridge can be looked at, and the app restarted (its loop re-run on the state file) between.
"""
import atexit, http.server, json, os, shutil, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

call, check = W.call, W.check
PIN = "357911"
MAIN, OTHER = "a1" * 32, "b2" * 32
CHANNEL = "01" * 32
W.BASE = "http://127.0.0.1:8097"


def hexid(n):
    return ("%064x" % n)


# ---- the node's HTTP API ---------------------------------------------------------------------------------
class Node:
    notes = {MAIN: {hexid(1): 30000000, hexid(2): 400000}, OTHER: {hexid(3): 5000}}
    next_id = 100
    pending = []                  # [(kind, body, inputs, outputs)] taken, not in a block yet
    posts = []                    # every POST body the app made: (path, body)
    deposit_mode = "ok"           # ok | refuse | hang
    channel_known = True
    lock = threading.Lock()


def node_include():
    """Puts everything taken in a block: inputs leave, outputs appear."""
    with Node.lock:
        for kind, body, inputs, outputs in Node.pending:
            key = body.get("change_public_key")
            for i in inputs:
                Node.notes[key].pop(i, None)
            for k, v in outputs:
                Node.next_id += 1
                Node.notes.setdefault(k, {})[hexid(Node.next_id)] = v
        Node.pending = []


def spend(key, amount, fee, exclude=()):
    """Picks the key's notes (not `exclude`) for amount + fee, largest first: (inputs, change)."""
    picked, total = [], 0
    for i, v in sorted(Node.notes[key].items(), key=lambda kv: -kv[1]):
        if total >= amount + fee:
            break
        if i in exclude or any(i in p[2] for p in Node.pending):
            continue
        picked.append(i)
        total += v
    if total < amount + fee:
        raise ValueError("not enough")
    return picked, total - amount - fee


class NodeH(http.server.BaseHTTPRequestHandler):
    def out(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/cryptarchia/info"):
            return self.out(200, {"height": 500, "slot": 900, "tip": "aa" * 32, "lib": "bb" * 32, "state": "Online", "mode": "Online"})
        if self.path.startswith("/network/info"):
            return self.out(200, {"connected_peers": ["p"]})
        if self.path.startswith("/wallet/") and self.path.endswith("/balance"):
            key = self.path.split("/")[2]
            with Node.lock:
                n = dict(Node.notes.get(key, {}))
            return self.out(200, {"balance": sum(n.values()), "notes": n, "tip": "aa" * 32, "address": key})
        if self.path.startswith("/channel/"):
            if Node.channel_known and self.path == "/channel/" + CHANNEL:
                return self.out(200, {"channel": CHANNEL})
            return self.out(404, {"code": 404, "message": "Channel not found"})
        return self.out(404, {"code": 404, "message": "not here"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Node.posts.append((self.path, body))
        with Node.lock:
            if self.path == "/wallet/transactions/transfer-funds":
                key = body["change_public_key"]
                try:
                    inputs, change = spend(key, body["amount"], 2018)
                except ValueError:
                    return self.out(500, "not enough funds")
                outs = [(body["recipient_public_key"], body["amount"])] + ([(key, change)] if change else [])
                Node.pending.append(("transfer", body, inputs, outs))
                return self.out(201, {"hash": "11" * 32})
            if self.path == "/channel/deposit":
                if Node.deposit_mode == "refuse":
                    return self.out(400, "Fee exceeds maximum")
                if Node.deposit_mode == "5xx":    # the node's own error: it may have taken it all the same
                    return self.out(500, "mempool error")
                if Node.deposit_mode == "hang":
                    self.close_connection = True
                    return                       # no answer at all
                key = body["change_public_key"]
                dep = body["deposit"]["inputs"]
                if any(i not in Node.notes[key] for i in dep):
                    return self.out(500, "note not found")
                fee_in, change = spend(key, 0, 2054, exclude=dep)
                Node.pending.append(("deposit", body, dep + fee_in, [(key, change)] if change else []))
                return self.out(200, {"hash": "22" * 32})
        return self.out(404, {"code": 404})

    def log_message(self, *a):
        pass


# ---- the sequencer and the faucet ------------------------------------------------------------------------
class Seq:
    lez = {"balance": 0}
    version = "0.3"               # 0.3 | 0.4 | unclear
    seen = []


class SeqH(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.startswith("/faucet"):
            return self.faucet(body)
        Seq.seen.append(body.get("method"))
        m, r = body.get("method"), {"jsonrpc": "2.0", "id": body.get("id")}
        if m == "getRecoveryBinding":
            if Seq.version == "0.3":
                r["error"] = {"code": -32601, "message": "Method not found"}
            elif Seq.version == "0.4":
                r["result"] = None
            else:
                r["error"] = {"code": -32000, "message": "busy"}
        elif m == "getChannelId":
            r["result"] = CHANNEL
        elif m == "getAccountBalance":
            r["result"] = Seq.lez["balance"]
        elif m == "sendTransaction":
            p = (body.get("params") or [{}])[0]
            if isinstance(p, dict) and p.get("Public") == "transfer":
                if int(p["amount"]) == 17:    # LEZ arrives while this send goes out: the balance rises
                    Seq.lez["balance"] += 5000 - 17 - 3000
                else:
                    Seq.lez["balance"] -= int(p["amount"]) + 3000
            r["result"] = "cd" * 32
        elif m == "getFeeState":
            r["result"] = {"next_base_fee_exec_ceiling": 9, "next_base_fee_stor_ceiling": 9, "base_fee_exec": 8, "base_fee_stor": 8}
        else:
            r["result"] = None
        self.send(200, r)

    def faucet(self, body):
        Faucet.asked.append(body)
        if Faucet.mode == "ok":
            Seq.lez["balance"] += 2000000
            return self.send(200, {"account": body.get("account"), "amount": "2000000", "tx": "33" * 32})
        if Faucet.mode == "limit":
            return self.send(429, {"error": "this account was funded in the last day"})
        return self.send(502, "<html>bad gateway</html>")

    def send(self, code, obj):
        b = (json.dumps(obj) if not isinstance(obj, str) else obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


class Faucet:
    mode = "ok"
    asked = []


node_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), NodeH)
seq_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SeqH)
for srv in (node_srv, seq_srv):
    threading.Thread(target=srv.serve_forever, daemon=True).start()

# ---- the app, as the Android app runs it -----------------------------------------------------------------
top = tempfile.mkdtemp(prefix="lns-funding-")
atexit.register(shutil.rmtree, top, True)
data, nodecfg, bins = (tempfile.mkdtemp(dir=top) for _ in range(3))
with open(os.path.join(nodecfg, "user_config.yaml"), "w") as f:
    f.write("kms:\n  keystore: keystore.yaml\n")
with open(os.path.join(nodecfg, "keystore.yaml"), "w") as f:
    f.write("public_keys:\n  LeaderFunding: %s\n  SdpFunding: %s\nsecret_keys:\n  LeaderFunding: %s\n" % (MAIN, OTHER, "c3" * 32))
for name, dest in (("fake_node_bin.py", "fake_node_bin.py"), ("fake_names_bin.py", "libnames.so")):
    shutil.copy(os.path.join(HERE, name), os.path.join(bins, dest))
    os.chmod(os.path.join(bins, dest), 0o755)
seq_url = "http://127.0.0.1:%d/" % seq_srv.server_address[1]
os.environ.update(APP_EMBEDDED="android", APP_PORT="8097", APP_DATA=data, NODE_BIN=os.path.join(bins, "fake_node_bin.py"),
                  NODE_CFG=os.path.join(nodecfg, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="",
                  NODE_API="http://127.0.0.1:%d" % node_srv.server_address[1], NAMES_BIN=os.path.join(bins, "libnames.so"),
                  NAMES_RPC_URL=seq_url, LNS_FAUCET_URL=seq_url + "faucet", BRIDGE_POLL="0.2", BRIDGE_GIVE_UP="3", BRIDGE_SLOW="0", BRIDGE_SPLIT_WAIT="2",
                  HISTORY_POLL="1")
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

threading.Thread(target=server.main, daemon=True).start()
for _ in range(80):
    try:
        if call("/api/wallet")[0] == 200:
            break
    except Exception:
        pass
    time.sleep(0.1)
for _ in range(50):
    with server.lock:
        server.keys_cache["at"] = 0.0
    if server.wallet_keys():
        break
    time.sleep(0.1)


def until(what, cond, tries=150, pause=0.1):
    for _ in range(tries):
        v = cond()
        if v:
            return v
        time.sleep(pause)
    check(what, False, bridge())


def bridge():
    return call("/api/wallet/lns", session=s)[1].get("bridge") or {}


def deposits():
    return [b for p, b in Node.posts if p == "/channel/deposit"]


def history():
    return call("/api/wallet/history?limit=50", session=s)[1]["entries"]


s = call("/api/wallet/setup", {"pin": PIN})[1]["session"]

# ---- who may call ----------------------------------------------------------------------------------------
for path in ("/api/wallet/lns/faucet", "/api/wallet/lns/bridge", "/api/wallet/lns/bridge/cancel"):
    check("locked: %s is refused" % path, call(path, {})[0] == 401)
    check("%s needs the app's own page as Origin" % path, call(path, {}, session=s, origin="https://evil.example")[0] == 403)
check("locked: the LEZ balance route is refused", call("/api/wallet/lns/balance")[0] == 401)
code, d = call("/api/wallet/lns/balance", session=s)
check("before a name account: the balance route says there is none", code == 200 and d == {"account": None, "balance": None}, d)
code, d = call("/api/wallet/lns/faucet", {}, session=s)
check("the faucet needs a name account first", code == 409 and "name account first" in d["error"], d)

code, d = call("/api/wallet/lns/account", {}, session=s)
check("the name account is made", code == 200 and d.get("account"), d)
ACCOUNT = d["account"]

# ---- what registering costs ------------------------------------------------------------------------------
cost = until("the cost is read (in the background)", lambda: (call("/api/wallet/lns", session=s)[1].get("cost") or {}).get("need"))
d = call("/api/wallet/lns", session=s)[1]["cost"]
check("the deposit comes from the registry's settings: 1,000,000 (3,000,000 for three characters)",
      d["deposit"] == "1000000" and d["deposit_three"] == "3000000", d)
check("the reserve is the register gas limit at the exec ceiling, plus the bytes at the storage ceiling: 2,263,500",
      d["reserve"] == str(250000 * 9 + 1500 * 9), d)
check("the fees: the gas a commit and a reveal use (23,214 and 165,000) at today's base fee, plus their bytes: 1,513,712",
      d["fees"] == str((23214 + 165000) * 8 + 1000 * 8), d)
check("to start, the account needs the commit's fee at the ceiling, then the deposit and the reserve: 3,485,926",
      d["need"] == str(1000000 + 2263500 + 23214 * 9 + 1500 * 9) == "3485926" and d["need_three"] == "5485926", d)
calls = [json.loads(l) for l in open(os.path.join(data, "fake-names-calls.jsonl"))]
st_calls = [c for c in calls if c["args"] == ["settings"]]
check("`names settings` was asked", bool(st_calls))
check("and left no check folder behind", not [x for x in os.listdir(data) if x.startswith(".lns-check-")])
code, d = call("/api/wallet/lns/balance", session=s)
check("the balance route gives the account and its LEZ balance", code == 200 and d == {"account": ACCOUNT, "balance": "0"}, d)

# ---- the faucet ------------------------------------------------------------------------------------------
code, d = call("/api/wallet/lns/faucet", {}, session=s)
check("the faucet pays the name account and says how much", code == 200 and d["amount"] == "2000000", d)
check("it was asked for the name account, by its id", Faucet.asked[-1] == {"account": ACCOUNT}, Faucet.asked)
Faucet.mode = "limit"
code, d = call("/api/wallet/lns/faucet", {}, session=s)
check("a refusal shows the faucet's own reason", code == 409 and d["error"] == "The faucet says: this account was funded in the last day", d)
Faucet.mode = "down"
code, d = call("/api/wallet/lns/faucet", {}, session=s)
check("an answer that isn't the faucet's is said plainly", code == 502 and "can't read" in d["error"], d)
Faucet.mode = "ok"
Seq.lez["balance"] = 0
server.lns_faucet_last.clear()             # a grant asked for in the last ten minutes is set against a new bridge

# ---- the plan, and refusals that send nothing -------------------------------------------------------------
before = len(Node.posts)
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "1000000"}, session=s)
check("a plan: from Main to the name account, the amount, the fee cap, a split first",
      code == 200 and d["plan"] == {"from": MAIN, "label": "Main", "to": ACCOUNT, "amount": "1000000", "split": True,
                                     "fee_max": "100000", "split_fee_max": "10000", "balance": "30400000"}, d)
check("a plan sends nothing", len(Node.posts) == before)
for body, want in (({"from": MAIN, "amount": "0"}, "above 0"), ({"from": MAIN, "amount": "1e6"}, "whole number"),
                   ({"from": MAIN, "amount": "1_000000"}, "whole number"), ({"from": MAIN, "amount": "+1000000"}, "whole number"),
                   ({"from": MAIN, "amount": "\uff11\uff10\uff10\uff10\uff10\uff10\uff10"}, "whole number"),
                   ({"from": MAIN, "amount": "1,000,000"}, "whole number"), ({"from": MAIN, "amount": 1000000}, "whole number"),
                   ({"from": MAIN, "amount": "109999"}, "at least 110,000"),
                   ({"from": "c3" * 32, "amount": "5"}, "isn't in this wallet"),
                   ({"from": MAIN, "amount": "30350000"}, "more for the fees")):
    code, d = call("/api/wallet/lns/bridge", dict(body, confirm=True), session=s)
    check("refused: %s" % body["amount"], code in (400, 409) and want in d["error"], d)
for version, want in (("0.4", "newer LEZ"), ("unclear", "didn't say which version")):
    Seq.version = version
    code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "1000000", "confirm": True}, session=s)
    check("LEZ %s: refused, %r" % (version, want), code in (409, 502) and want in d["error"], d)
Seq.version = "0.3"
Node.channel_known = False
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "1000000", "confirm": True}, session=s)
check("a channel the node doesn't know: refused", code == 409 and "deposit channel" in d["error"], d)
Node.channel_known = True
check("none of the refusals asked the node to move anything", len(Node.posts) == before, Node.posts[before:])
check("and none left a bridge behind", bridge() == {} or call("/api/wallet/lns", session=s)[1]["bridge"] is None)

# ---- a bridge with a split -------------------------------------------------------------------------------
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "1000000", "confirm": True}, session=s)
check("the bridge starts by setting the amount aside", code == 200 and d["bridge"]["state"] == "splitting", d)
split = Node.posts[-1]
check("the split is a transfer of exactly the amount from Main to Main",
      split[0] == "/wallet/transactions/transfer-funds" and split[1] == {"tip": None, "change_public_key": MAIN,
      "funding_public_keys": [MAIN], "recipient_public_key": MAIN, "amount": 1000000}, split)
code, d = call("/api/wallet/send", {"from": MAIN, "to": OTHER, "amount": "5"}, session=s)
check("Send from Main waits while the bridge uses its notes", code == 409 and "name account" in d["error"], d)
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "500000", "confirm": True}, session=s)
check("one bridge at a time", code == 409 and "under way" in d["error"], d)
time.sleep(1)
check("nothing is deposited before the split is in a block", deposits() == [])
node_include()
until("the split's note appears and the deposit is made", lambda: deposits())
dep = deposits()[0]
note = dep["deposit"]["inputs"][0]
check("the deposit spends one note, of exactly the amount",
      len(dep["deposit"]["inputs"]) == 1 and Node.notes[MAIN].get(note) == 1000000, dep)
check("the deposit's body is the node's: channel, metadata as the account's 32 bytes, Main pays the fee, capped at 100,000",
      dep == {"tip": None, "deposit": {"channel_id": CHANNEL, "inputs": [note], "metadata": list(server.lez_account_bytes(ACCOUNT))},
              "change_public_key": MAIN, "funding_public_keys": [MAIN], "max_tx_fee": 100000}, dep)
check("the metadata is 32 bytes", len(dep["deposit"]["metadata"]) == 32)
b = until("the bridge is sent", lambda: bridge().get("state") == "sent" and bridge())
check("the bridge says the split's fee once the history has it", until("split fee", lambda: bridge().get("split_fee") == "2018"))
code, d = call("/api/wallet/send", {"from": MAIN, "to": OTHER, "amount": "5"}, session=s)
check("still no Send from Main until the deposit is in a block", code == 409, d)
on_disk = json.load(open(server.BRIDGE_FILE))
check("the bridge's state is on disk, owner-only, with the operation id",
      on_disk["state"] == "sent" and (os.stat(server.BRIDGE_FILE).st_mode & 0o777) == 0o600 and len(on_disk["op_id"]) == 64)
node_include()
until("the deposit's note leaves: in a block", lambda: bridge().get("state") == "landed")
for _ in range(60):
    if bridge().get("fee") == "2054":
        break
    time.sleep(0.1)
check("its fee is shown once the history has it", bridge().get("fee") == "2054", (bridge(), [e for e in history() if e["kind"] != "tracking started"]))
code, d = call("/api/wallet/send", {"from": MAIN, "to": OTHER, "amount": "5"}, session=s)
check("Send from Main works again", code == 200, d)
node_include()
Seq.lez["balance"] = 600000
time.sleep(0.8)
check("a rise smaller than the amount isn't the bridge", bridge().get("state") == "landed")
Seq.lez["balance"] = 1600000
until("the name account's balance rises by the amount: arrived", lambda: bridge().get("state") == "arrived")
check("only one deposit was ever made for it", len(deposits()) == 1)
h = until("the history settles", lambda: (lambda e: e if not [x for x in e if x.get("status") == "pending"] else None)(history()))
bridged = [e for e in h if e.get("bridge")]
check("the history has the split and the deposit, both in a block, with their fees",
      sorted((e["bridge"], e["status"], e["fee"]) for e in bridged) == [("deposit", "in block", "2054"), ("split", "in block", "2018")], bridged)
check("and nothing 'changed outside this app'", not [e for e in h if e["kind"] == "changed"], h)

# ---- the faucet while a bridge waits doesn't count as the bridge -------------------------------------------
Seq.lez["balance"] = 0
Node.notes[MAIN][hexid(800)] = 1000000
time.sleep(1.5)                            # the history has seen the note before it is spent
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "1000000", "confirm": True}, session=s)
check("a second bridge: an exact note is there already, so no split", code == 200 and d["plan"]["split"] is False, d)
until("deposited at once", lambda: len(deposits()) == 2)
until("sent", lambda: bridge().get("state") == "sent")
node_include()
until("in a block", lambda: bridge().get("state") == "landed")
code, d = call("/api/wallet/lns/faucet", {}, session=s)        # the stand-in faucet credits 2,000,000 at once
time.sleep(1)
check("a faucet grant is not taken for the bridge", bridge().get("state") == "landed", bridge())
Seq.lez["balance"] += 1000000
until("the bridge's own credit on top: arrived", lambda: bridge().get("state") == "arrived")

# ---- a restart in the middle of the deposit call: never deposited twice ------------------------------------
Node.notes[MAIN][hexid(900)] = 777
with server.bridge_lock:
    b = server.bridge_load()
    b.update(id="restart-1", state="depositing", note=hexid(900), amount="777", deposit_at=time.time())
    server.bridge_save(b)
n = len(deposits())
server.bridge_round()                     # what the loop does first after a start
check("a bridge stopped in the deposit call is taken as sent, unsure", bridge().get("state") == "sent")
time.sleep(1)
check("and nothing is deposited again", len(deposits()) == n)
until("its note still there after the wait: overdue, never 'nothing bridged'", lambda: bridge().get("state") == "overdue", tries=80)
check("it says the note is still in the wallet and it may still land", "may still land" in bridge()["error"] and "nothing" not in bridge()["error"], bridge())
Node.notes[MAIN][hexid(901)] = 777000
time.sleep(1.5)
with server.bridge_lock:
    b = server.bridge_load(); b["amount"] = "777000"; server.bridge_save(b)
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "777000", "confirm": True}, session=s)
check("the same amount again, while that one may still land, is refused", code == 409 and "may still land" in d["error"], d)
Node.notes[MAIN].pop(hexid(901))
Node.notes[MAIN].pop(hexid(900))

# ---- a deposit the node takes but never puts in a block ----------------------------------------------------
Node.notes[MAIN][hexid(801)] = 1000000
time.sleep(1.5)                            # the history has seen the note before it is spent
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "1000000", "confirm": True}, session=s)
check("another bridge starts", code == 200, (d, [e for e in history() if e.get("status") == "pending"]))
until("sent", lambda: bridge().get("state") == "sent")
until("not in a block after the wait: overdue", lambda: bridge().get("state") == "overdue", tries=80)
check("it says the note is still there and may still go through", "may still go through" in bridge()["error"], bridge())
code, d = call("/api/wallet/send", {"from": MAIN, "to": OTHER, "amount": "5"}, session=s)
check("the key is free again", code == 200, d)
node_include()
until("an overdue deposit that lands later is still followed", lambda: bridge().get("state") == "landed")
Node.pending = []

# ---- the node refuses the deposit ---------------------------------------------------------------------------
Node.deposit_mode = "refuse"
Node.notes[MAIN][hexid(802)] = 1000000
time.sleep(1.5)                            # the history has seen the note before it is spent
until("no transfer pending", lambda: not [e for e in history() if e.get("status") == "pending"])
n = len(deposits())
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "1000000", "confirm": True}, session=s)
until("refused by the node: failed", lambda: bridge().get("state") == "failed")
check("it says nothing was bridged, with the node's words", "nothing was bridged" in bridge()["error"] and "Fee exceeds" in bridge()["error"], bridge())
check("the refused deposit leaves no history row", not [e for e in history() if e.get("bridge_id") == bridge()["id"]])
Node.deposit_mode = "ok"

# ---- a split the history can't match (a payment came in the same block) still goes on, after a short wait ----
until("no transfer pending", lambda: not [e for e in history() if e.get("status") == "pending"])
n = len(deposits())
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "234567", "confirm": True}, session=s)
check("a split bridge starts", code == 200 and d["bridge"]["state"] == "splitting", (d, [e for e in server.history["entries"] if e.get("status") == "pending"]))
Node.notes[MAIN][hexid(805)] = 999          # received in the same block as the split: the history can't tell it apart
node_include()
until("the split's note is there, the history couldn't match it, and it goes on anyway", lambda: len(deposits()) == n + 1, tries=100)
check("the split's row is settled, not left pending", until("settled", lambda: not [e for e in history() if e.get("status") == "pending" and e.get("bridge") == "split"]))
node_include()
until("in a block", lambda: bridge().get("state") in ("landed", "arrived"))
until("its rows settled", lambda: not [e for e in history() if e.get("status") == "pending"])

# ---- the node's own error on a deposit: it may still land, never "nothing was bridged" ----
Node.deposit_mode = "5xx"
Node.notes[MAIN][hexid(806)] = 333333
time.sleep(1.5)
until("no transfer pending", lambda: not [e for e in history() if e.get("status") == "pending"])
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "333333", "confirm": True}, session=s)
until("a node server error: taken as sent, unsure", lambda: bridge().get("state") in ("sent", "overdue") and bridge().get("id") == d["bridge"]["id"])
until("then overdue, saying it may still land", lambda: bridge().get("state") == "overdue" and "may still land" in bridge()["error"], tries=80)
Node.deposit_mode = "ok"
Node.notes[MAIN].pop(hexid(806), None)
with server.bridge_lock:
    b = server.bridge_load(); b.update(state="arrived"); server.bridge_save(b)
for e in server.history["entries"]:
    if e.get("status") == "pending":
        e["status"] = "not in a block"

# ---- a split can be stopped before anything is deposited -----------------------------------------------------
code, d = call("/api/wallet/lns/bridge", {"from": MAIN, "amount": "123457", "confirm": True}, session=s)
check("splitting", code == 200 and d["bridge"]["state"] == "splitting", d)
code, d = call("/api/wallet/lns/bridge/cancel", {}, session=s)
check("stopped", code == 200 and d["bridge"]["state"] == "cancelled", d)
code, d = call("/api/wallet/lns/bridge/cancel", {}, session=s)
check("a sent bridge can't be stopped", code == 409)
node_include()
time.sleep(1)
check("no deposit after a stop", not [x for x in deposits() if x["deposit"]["inputs"] and Node.notes[MAIN].get(x["deposit"]["inputs"][0]) == 123457])
check("no pending row left in the history", until("settled", lambda: not [e for e in history() if e.get("status") == "pending"]))
# ---- LEZ Send: a plain transfer from the name account, judged by the balance -------------------------------
TO = "Public/3oRTrDMCWuSfnbUgUJCa1vqoedtUUi4xWmMdfJ4emVZC"
Seq.lez["balance"] = 50000
for body, want in (({"to": TO.lower(), "amount": "5"}, "Public/ and its ID"), ({"to": "Public/" + "1" * 50, "amount": "5"}, "Public/ and its ID"),
                   ({"to": TO + " ", "amount": "5"}, "Public/ and its ID"), ({"to": "Public/" + ACCOUNT, "amount": "5"}, "this name account"),
                   ({"to": TO, "amount": "0"}, "above 0"), ({"to": TO, "amount": "1,000"}, "above 0"), ({"to": TO, "amount": 5}, "above 0"),
                   ({"to": TO, "amount": "40000"}, "Not enough")):
    code, d = call("/api/wallet/lns/send", dict(body, confirm=True), session=s)
    check("LEZ Send refused: %r" % (body,), code in (400, 409) and want in d["error"], d)
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "1000"}, session=s)
check("a plan: from the name account, to, amount, the fee at most the transfer limit at the ceiling plus its bytes",
      code == 200 and d["plan"] == {"from": ACCOUNT, "to": TO[7:], "amount": "1000", "fee_max": str(1000 * 9 + 1500 * 9)}, d)
n_calls = len(open(os.path.join(data, "fake-names-calls.jsonl")).readlines())
check("a plan runs nothing", len(open(os.path.join(data, "fake-names-calls.jsonl")).readlines()) == n_calls)
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "1000", "confirm": True}, session=s)
check("sent through the job runner", code == 200 and d["started"] == "send", d)
j = until("it finishes", lambda: (lambda j: j if j["state"] != "running" else None)(call("/api/wallet/lns", session=s)[1]["job"]))
check("done: the balance dropped by the amount", j["state"] == "done" and j["kind"] == "send" and j["amount"] == "1000", j)
c = [json.loads(l) for l in open(os.path.join(data, "fake-names-calls.jsonl"))][-1]
check("as `names wallet auth-transfer send --from Public/<account> --to Public/<id> --amount 1000`",
      c["args"] == ["wallet", "auth-transfer", "send", "--from", "Public/" + ACCOUNT, "--to", TO, "--amount", "1000"], c)
d = call("/api/wallet/lns", session=s)[1]
check("nothing of the signer's noise in the reply", "abandon" not in json.dumps(d))
check("the LEZ activity has it", any(a["kind"] == "send" and a["state"] == "done" and a["amount"] == "1000" for a in d["activity"]), d["activity"][:3])
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "13", "confirm": True}, session=s)
j = until("the unsure one finishes", lambda: (lambda j: j if j["state"] != "running" else None)(call("/api/wallet/lns", session=s)[1]["job"]))
check("a send the wallet gave up on, with no balance change, says to check before sending again (never 'try again')",
      j["state"] == "failed" and j["error"] == server.LNS_SEND_UNSURE, j)
Seq.lez["balance"] = 50000
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "17", "confirm": True}, session=s)
j = until("the send with LEZ arriving meanwhile finishes", lambda: (lambda j: j if j["state"] != "running" else None)(call("/api/wallet/lns", session=s)[1]["job"]))
check("LEZ arriving while a send goes out doesn't make it look failed: judged by its own transaction (in a block)", j["state"] == "done", j)
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "19", "confirm": True}, session=s)
j = until("the billed one finishes", lambda: (lambda j: j if j["state"] != "running" else None)(call("/api/wallet/lns", session=s)[1]["job"]))
check("a send billed more than its amount but never seen in a block isn't 'Sent': it may still land", j["state"] == "failed" and j["error"] == server.LNS_SEND_UNSURE, j)
check("S-9: it reads as unsure, and is kept as unsure", j["error"] == "May have been sent. Check before sending again." and j.get("unsure") is True
      and call("/api/wallet/lns", session=s)[1]["activity"][0]["state"] == "unsure", j)
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "19", "confirm": True}, session=s)
check("S-9: the same send again is held back for a few minutes", code == 409 and "may have gone out" in d["error"], d)
check("S-6 (B2): that hold is on disk, so a restart keeps it", json.load(open(server.LNS_SEND_UNSURE_FILE)).get("amount") == "19")
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "21", "confirm": True}, session=s)
j = until("the timed-out one finishes", lambda: (lambda j: j if j["state"] != "running" else None)(call("/api/wallet/lns", session=s)[1]["job"]))
check("S-9: handed to the sequencer but its answer lost (no hash printed): unsure, not 'not sent'", j["error"] == server.LNS_SEND_UNSURE and j.get("unsure") is True, j)
server.lns_state_save(reg_pending="alice")
Seq.lez["balance"] = 3600000
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "200000", "confirm": True}, session=s)
check("while a registration is unfinished, what it needs stays", code == 409 and "must stay for registering alice" in d["error"], d)
server.lns_state_save(reg_pending="")
Seq.lez["balance"] = None
server.lns_cost_cache["fees"] = None
code, d = call("/api/wallet/lns/send", {"to": TO, "amount": "5", "confirm": True}, session=s)
check("an unknown balance refuses", code == 502, d)
# ---- an old "ready" never deposits on a later round ----
Node.notes[MAIN][hexid(804)] = 5555
with server.bridge_lock:
    b = server.bridge_load()
    b.update(id="old-1", state="ready", note=hexid(804), amount="5555", to=ACCOUNT, note_seen_at=time.time() - 3600)
    server.bridge_save(b)
n = len(deposits())
server.bridge_round()
check("a ready bridge older than its limit deposits nothing; it is stopped and says so", len(deposits()) == n
      and bridge().get("state") == "cancelled" and "nothing was bridged" in bridge()["error"], bridge())

# ---- a restore of the name account waits while a bridge is on its way ----
with server.bridge_lock:
    b = server.bridge_load(); b.update(id="busy-1", state="sent", note=hexid(804)); server.bridge_save(b)
outcome, msg = server.lns_restore({"storage": "{}", "account": ACCOUNT}, True)
check("a restore while a bridge is on its way: busy", outcome == "busy" and "bridge" in msg, (outcome, msg))
with server.bridge_lock:
    b = server.bridge_load(); b.update(state="arrived"); server.bridge_save(b)

# ---- a bridge whose name account changed since it started deposits nothing ----
Seq.lez["balance"] = 0
Node.deposit_mode = "ok"
Node.notes[MAIN][hexid(803)] = 4444
time.sleep(1.5)
until("no transfer pending", lambda: not [e for e in history() if e.get("status") == "pending"])
with server.bridge_lock:
    b = server.bridge_load()
    b.update(id="moved-1", state="ready", note=hexid(803), amount="4444", to="3oRTrDMCWuSfnbUgUJCa1vqoedtUUi4xWmMdfJ4emVZC", note_seen_at=time.time())
    server.bridge_save(b)
n = len(deposits())
server.bridge_round()
check("a bridge to an account that is no longer this phone's name account deposits nothing, and says so",
      len(deposits()) == n and bridge().get("state") == "failed" and "changed" in bridge()["error"], bridge())
print("all checks passed", flush=True)
os._exit(0)

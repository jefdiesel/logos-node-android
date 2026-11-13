#!/usr/bin/env python3
"""The bridge test network (LEZ 0.4) reader, app/lez04.py, against recorded answers, and its place in the app.

  python3 tests/net04_test.py

Part 1 runs the reader with the network's answers replaced: the real answers recorded on 2026-11-13
(tests/fixtures/net04/recorded.json, from the bridge repository's WALLET-READ.md), an account the network has never
seen, a reset (new channel, lower height, the bridge's Config gone), garbage (not JSON, wrong types, bytes out of range,
trailing bytes, huge numbers, oversized answers, errors) and an unreachable endpoint. Part 2 runs the app as the
Android app does, with the network as a local stand-in, and shows the 0.4 routes never reach a send, the node, the
names service or the 0.3 balances.
"""
import ast, copy, http.server, json, os, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "app")
sys.path.insert(0, APP)
import lez04  # noqa: E402
import atexit, shutil  # noqa: E402

_tmp = []


def mkdtemp():
    """A temporary folder, removed when the test ends."""
    d = tempfile.mkdtemp()
    _tmp.append(d)
    return d


atexit.register(lambda: [shutil.rmtree(d, ignore_errors=True) for d in _tmp])

FAILS = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (" - " + str(detail)[:300] if not ok and detail != "" else ""))
    if not ok:
        FAILS.append(name)


REC = json.load(open(os.path.join(HERE, "fixtures", "net04", "recorded.json")))
OWNER = "CCVd76Tk3WvFb63Wbuu4exMeLRTbSuMWHqxuvysapKnk"
BRIDGE = "JECKBkvoc2e3dC18Wm6zZJEC2BGMwUwLsdZiQzYTnUx7"
NOBODY = lez04.b58encode(bytes([7] * 32))


class Chain:
    """Answers like the bridge test network, from the recording; tests change it."""
    def __init__(self):
        self.channel, self.height = REC["channel"], REC["height"]
        self.accounts = dict(REC["accounts"])
        self.accounts[REC["config_account"]] = REC["config"]
        self.accounts.update(REC["definitions"])
        self.raw = None             # bytes to answer instead (garbage)
        self.status = 200
        self.down = False
        self.calls = []

    def fetch(self, url, body, cap, timeout):
        self.calls.append(body["method"])
        if self.down:
            raise OSError("no answer")
        if self.raw is not None:
            return self.status, self.raw
        m, p = body["method"], body["params"]
        res = self.channel if m == "getChannelId" else self.height if m == "getLastBlockId" else copy.deepcopy(self.accounts.get(p[0]))
        data = json.dumps({"jsonrpc": "2.0", "id": 1, "result": res}).encode()
        if len(data) > cap:
            raise ValueError("answer too big")       # what the wallet's outside fetch does
        return self.status, data


now = [1_800_000_000.0]
data = mkdtemp()
with open(os.path.join(data, "wallet-net04-config.json"), "w") as f:
    json.dump({"rpc_url": "https://lez.example/"}, f)


def reader(chain):
    return lez04.Net04(data, APP, chain.fetch, clock=lambda: now[0])


# ---- ids ---------------------------------------------------------------------------------------------------------------
check("the bridge's Config address comes out as the spec says", lez04.config_address(BRIDGE) == REC["config_account"])
check("an id is taken with Public/ and spaces, and given back canonical", lez04.account_id("  Public/" + OWNER + " ") == OWNER)
for bad, why in (("", "empty"), ("CCVd76Tk3WvFb63Wbuu4exMeLRTbSuMWHqxuvysapKn0", "a 0 (not base58)"), ("O" + OWNER[1:], "an O"),
                 (lez04.b58encode(bytes([7] * 31)), "31 bytes"), (lez04.b58encode(bytes([7] * 33)), "33 bytes"), ("1" + OWNER, "a leading-zero byte more (33 bytes)"),
                 ("1" * 200, "very long"), (None, "not text"), (12345, "a number")):
    try:
        lez04.account_id(bad)
        check("refused: %s" % why, False)
    except ValueError:
        check("refused: %s" % why, True)

# ---- the recorded answers ----------------------------------------------------------------------------------------------
ch = Chain()
n = reader(ch)
check("watching an address", n.watch(OWNER)[0] == 200 and n.watched() == [OWNER])
n.refresh(None)
v = n.view(None)
a = v["accounts"][0]
check("the network is named 'bridge test network'", v["network"] == "bridge test network" and "official" not in json.dumps(v).lower())
check("recorded: the native balance is 23,786,858", a["status"] == "ok" and a["native"] == "23,786,858", a)
toks = {t["symbol"]: t for t in a.get("tokens", [])}
check("recorded: 0.1 wETH, named by its definition", toks.get("wETH", {}).get("amount") == "0.1" and toks["wETH"]["name"] == "Wrapped Sepolia ETH (demo)", toks)
check("recorded: dUSDC listed by the bridge, 0 held", toks.get("dUSDC", {}).get("amount") == "0", toks)
check("it is view-only and says when it was read", a["view_only"] and a["at"] == now[0])
check("private balances are said not to be shown", "not shown yet" in v["private"])
check("no reset or unreachable message", not v["reset"] and not v["unreachable"])

ch2 = Chain()
n2 = lez04.Net04(mkdtemp(), APP, ch2.fetch, clock=lambda: now[0])
n2.refresh(OWNER)
v = n2.view(OWNER)
check("the phone's own account comes first, marked as its own and not view-only",
      v["accounts"] and v["accounts"][0]["own"] and not v["accounts"][0]["view_only"] and v["accounts"][0].get("native") == "23,786,858", v["accounts"])
check("  the default endpoint comes from the config file, not the code", n2.config()["rpc_url"] == "https://lez.nameswallet.app/")

# ---- an account the network has never seen ------------------------------------------------------------------------------
n.watch(NOBODY)
n.refresh(None)
row = [x for x in n.view(None)["accounts"] if x["id"] == NOBODY][0]
check("null: 'Nothing on this network', not an error and not 0", row["status"] == "nothing" and row["text"] == "Nothing on this network" and "native" not in row, row)
n.unwatch(NOBODY)

# ---- unreachable: the last numbers stay, with their time -------------------------------------------------------------------
read_at = now[0]
now[0] += 60
ch.down = True
n.refresh(None)
v = n.view(None)
a = v["accounts"][0]
check("unreachable: says so", v["unreachable"] == "Can't reach the bridge test network now.", v["unreachable"])
check("  and keeps the last numbers with their time (never 0 for something not read)", a["native"] == "23,786,858" and a["at"] == read_at, a)
ch.down = False

# ---- reset: a new channel, a lower height, the Config gone ------------------------------------------------------------------
for name, change in (("a new channel", lambda c: setattr(c, "channel", "ff" * 32)),
                     ("a lower height on the same channel", lambda c: setattr(c, "height", 3)),
                     ("the bridge's Config gone", lambda c: c.accounts.pop(REC["config_account"]))):
    ch = Chain()
    n = reader(ch)
    n.state = {}
    now[0] += 10
    n.refresh(None)                                       # read once as it was
    change(ch)
    ch.accounts[OWNER] = None if name != "a new channel" else ch.accounts[OWNER]
    now[0] += 3601                                        # (the token list is read again at most hourly)
    n.refresh(None)
    v = n.view(None)
    a = v["accounts"][0]
    check("reset by %s: says the network was reset" % name, v["reset"] == lez04.RESET_TEXT, v["reset"])
    check("  and shows no number of the old chain", a.get("native") in (None,) or a["at"] == now[0], a)

# ---- garbage: whatever comes back, the reader says it can't read it and never guesses -------------------------------------
GARBAGE = {
    "not JSON": b"<html>error code: 1010</html>",
    "a JSON-RPC error": json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "Invalid params"}}).encode(),
    "no result": json.dumps({"jsonrpc": "2.0", "id": 1}).encode(),
    "a list": b"[1,2,3]",
}
for name, raw in GARBAGE.items():
    ch = Chain()
    n = reader(ch)
    n.state = {}
    ch.raw = raw
    n.refresh(None)
    check("garbage, %s: unreachable, nothing invented" % name, n.view(None)["unreachable"] and not n.view(None)["accounts"][0].get("native"), n.view(None))
ch = Chain()
n = reader(ch)
n.state = {}
ch.status = 503
n.refresh(None)
check("503: unreachable, and the reader waits before asking again", n.view(None)["unreachable"] and n.backoff_until > now[0])
BAD_ACCOUNTS = {
    "actor_states a list": {"nonce": 1, "data": {"actor_states": [1, 2]}},
    "a byte above 255": {"nonce": 1, "data": {"actor_states": {"1" * 32: [256]}}},
    "a byte as a string": {"nonce": 1, "data": {"actor_states": {"1" * 32: ["1"]}}},
    "a byte as a float": {"nonce": 1, "data": {"actor_states": {"1" * 32: [1.5]}}},
    "a byte as true": {"nonce": 1, "data": {"actor_states": {"1" * 32: [True]}}},
    "a native balance of 17 bytes": {"nonce": 1, "data": {"actor_states": {"1" * 32: [1] * 17}}},
    "a state longer than the cap": {"nonce": 1, "data": {"actor_states": {"1" * 32: [0] * (lez04.STATE_CAP + 1)}}},
    "too many programs": {"nonce": 1, "data": {"actor_states": {str(i): [] for i in range(lez04.MAX_STATES + 1)}}},
    "holdings with trailing bytes": {"nonce": 1, "data": {"actor_states": {"FiooSkDaMZWNq4bFFpVXnDm2d2uoTB5S3cZ7kWhfUW4K": [0, 0, 0, 0, 0, 9]}}},
    "holdings claiming a billion entries": {"nonce": 1, "data": {"actor_states": {"FiooSkDaMZWNq4bFFpVXnDm2d2uoTB5S3cZ7kWhfUW4K": [0, 0, 202, 154, 59]}}},
    "an unknown token tag": {"nonce": 1, "data": {"actor_states": {"FiooSkDaMZWNq4bFFpVXnDm2d2uoTB5S3cZ7kWhfUW4K": [7]}}},
    "data missing": {"nonce": 1},
    "a string": "hello",
}
for name, acct in BAD_ACCOUNTS.items():
    ch = Chain()
    ch.accounts[OWNER] = acct
    n = reader(ch)
    n.state = {}
    n.refresh(None)
    row = n.view(None)["accounts"][0]
    check("garbage account, %s: 'can't read', no number" % name, row["status"] == "unreadable" and "native" not in row, row)
ch = Chain()
ch.accounts[OWNER] = {"nonce": 1, "data": {"actor_states": {"1" * 32: [255] * 16}}}
n = reader(ch)
n.state = {}
n.refresh(None)
check("the largest native balance (2^128-1) is shown exactly, from the integer", n.view(None)["accounts"][0]["native"] == "{:,}".format(2 ** 128 - 1))
cfg = copy.deepcopy(REC["config"])
cfg["data"]["actor_states"][BRIDGE] = cfg["data"]["actor_states"][BRIDGE] + [0]
ch = Chain()
ch.accounts[REC["config_account"]] = cfg
n = reader(ch)
n.state = {}
n.refresh(None)
v = n.view(None)
check("a token list with a trailing byte: 'can't read the bridge's token list', native still shown", v["tokens_error"] and v["accounts"][0]["native"] == "23,786,858" and not v["accounts"][0]["tokens"], v)
cfg = copy.deepcopy(REC["config"])
b = cfg["data"]["actor_states"][BRIDGE]
b[32 + 20 + 8 + 32 + 32 + 32 + 32 + 1 + 64 + 2 + 4 + 20 + 32] = 200             # dUSDC's decimals: 200
ch = Chain()
ch.accounts[REC["config_account"]] = cfg
n = reader(ch)
n.state = {}
n.refresh(None)
check("decimals out of range: the token list isn't read", n.view(None)["tokens_error"])
ch = Chain()
ch.accounts[OWNER] = {"nonce": 1, "data": {"actor_states": {"1" * 32: [0] * 16, "x": [0] * 60000, "y": [0] * 60000, "z": [0] * 60000}}}
n = reader(ch)
n.state = {}
n.refresh(None)
check("an oversized answer: unreachable for that read, nothing invented", n.view(None)["accounts"][0]["status"] != "ok")
n.state = {}
with open(os.path.join(data, "wallet-net04-config.json"), "w") as f:
    json.dump({"rpc_url": "https://lez.example/", "symbols": {"0x0000000000000000000000000000000000000000": "<b>x</b>" * 20}}, f)
ch = Chain()
n = reader(ch)
n.state = {}
n.refresh(None)
check("a symbol is cut to 16 characters", all(len(t["symbol"]) <= 16 for t in n.view(None)["accounts"][0]["tokens"]))
with open(os.path.join(data, "wallet-net04-config.json"), "w") as f:
    json.dump({"rpc_url": "https://lez.example/"}, f)

# ---- polling: at most every 30 s, one read at a time, only when the page looks ------------------------------------------
ch = Chain()
n = reader(ch)
n.state = {}
n.last_try = 0.0
check("the first look starts a read", n.look(None) is True)
time.sleep(0.3)
check("a second look within 30 s doesn't", n.look(None) is False)
now[0] += 31
check("after 30 s it does again", n.look(None) is True)
time.sleep(0.3)
calls = len(ch.calls)
time.sleep(0.5)
check("nothing reads unless the page looks", len(ch.calls) == calls)
check("at most 10 watched addresses", all(n.watch(lez04.b58encode(bytes([i + 1] * 32)))[0] == 200 for i in range(9)) and n.watch(lez04.b58encode(bytes([99] * 32)))[0] == 400)

# ---- the bridge's token list can't be read: it says so, never "none" ----------------------------------------------------------
check("the Config's address isn't pinned in lez04.json: it is derived from the bridge program",
      "config_account" not in json.load(open(os.path.join(APP, "lez04.json"))) and lez04.config_address(BRIDGE) == REC["config_account"])
ch = Chain()
ch.accounts.pop(REC["config_account"])
n = reader(ch)
n.state = {}
now[0] += 10
n.refresh(OWNER)
v = n.view(OWNER)
check("no Config on a first read: 'Bridged tokens can't be listed right now', the native balance still shown",
      v["tokens_error"] == "Bridged tokens can't be listed right now." and v["accounts"][0].get("native") == "23,786,858" and not v["reset"], v)

# ---- a slow read: cut off at its deadline, and meanwhile the view says it can't reach the network --------------------------------
ch = Chain()
n = reader(ch)
try:
    n.rpc("https://lez.example/", "getChannelId", [], time.monotonic() - 1)
    check("a request with no time left isn't made", False)
except lez04.Unreachable:
    check("a request with no time left isn't made", ch.calls == [])
n.refresh(None)
n.reading, n.last_try = True, now[0] - 20
check("a read 20 s in, still within its refresh's 60 s: not 'can't reach' yet", not n.view(None)["unreachable"])
n.reading, n.last_try = True, now[0] - lez04.REFRESH_DEADLINE - 6
v = n.view(None)
check("a read running past its deadline: 'Can't reach the bridge test network now.', the last numbers kept with their time",
      v["unreachable"] == lez04.UNREACHABLE_TEXT and v["read_at"] and v["accounts"] and v["accounts"][0].get("native") == "23,786,858", v)
n.reading = False


class SlowChain(Chain):
    """Each answer takes 0.3 s."""
    def fetch(self, url, body, cap, timeout):
        time.sleep(0.3)
        return Chain.fetch(self, url, body, cap, timeout)


real_deadline = lez04.REFRESH_DEADLINE
lez04.REFRESH_DEADLINE = 0.5
ch = SlowChain()
n = reader(ch)
n.state = {}
t0 = time.monotonic()
n.refresh(None)
lez04.REFRESH_DEADLINE = real_deadline
check("a refresh stops at its own deadline (0.5 s here): 'can't reach', no more requests after it",
      n.state.get("unreachable") == "too slow" and len(ch.calls) <= 3 and time.monotonic() - t0 < 1.5, (n.state.get("unreachable"), ch.calls))

# ---- the module stands apart: it imports and names nothing of the wallet ----------------------------------------------------
tree = ast.parse(open(os.path.join(APP, "lez04.py")).read())
imports = {a.name for node_ in ast.walk(tree) if isinstance(node_, (ast.Import, ast.ImportFrom)) for a in node_.names} | \
          {node_.module for node_ in ast.walk(tree) if isinstance(node_, ast.ImportFrom)}
names = {node_.id for node_ in ast.walk(tree) if isinstance(node_, ast.Name)}
check("lez04 imports only the standard library", imports <= {"hashlib", "json", "os", "threading", "time"}, imports)
check("lez04 names no send, node, names or 0.3 function", not (names & {"send", "node", "server", "lns_send", "lns_bridge", "names_rpc", "balance_of", "fetch_outside", "waku", "messaging_post", "outbox_save", "inbox_save", "store_write"}), names & {"send", "node"})

# ---- part 2: the app, with the network as a local stand-in ------------------------------------------------------------------
chain = Chain()


class RPC(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        code, raw = chain.fetch("", body, 1 << 20, 5)
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def log_message(self, *a):
        pass


rpc = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RPC)
threading.Thread(target=rpc.serve_forever, daemon=True).start()
PORT = 8102 + int(os.environ.get("PORT_SHIFT", "0"))
adata = mkdtemp()
with open(os.path.join(adata, "wallet-net04-config.json"), "w") as f:
    json.dump({"rpc_url": "http://127.0.0.1:%d/" % rpc.server_address[1]}, f)
os.environ.update(APP_EMBEDDED="android", APP_PORT=str(PORT), APP_DATA=adata, NODE_BIN="/nonexistent", UPDATE_URL="",
                  NET04_POLL_SECONDS="0.2")
lez04.POLL = 0.2
import server  # noqa: E402

tripped = []
WIRES = ("send", "node", "lns_send", "lns_bridge", "names_rpc", "balance_of", "bridge_deposit", "history_record_send",
         # the messages: their routes, the messaging node, and every file they keep
         "messaging_post", "messaging_get", "messaging_round", "waku", "outbox_save", "inbox_save", "store_write", "msg_key_save", "msg_key_mark")
missing = [fn for fn in WIRES if not callable(getattr(server, fn, None))]
check("every tripwire has a function to stand in for", not missing, missing)
for fn in WIRES:
    if hasattr(server, fn):
        setattr(server, fn, (lambda name: lambda *a, **k: tripped.append(name) or ((200, {}) if name.startswith("messaging_") else (0, None)))(fn))
server._waku.update(feature=True, thread=True)  # messages on, as in the Android app, without their background loops
threading.Thread(target=server.main, daemon=True).start()
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402
W.BASE = "http://127.0.0.1:%d" % PORT
for _ in range(80):
    try:
        if W.call("/api/wallet")[0] == 200:
            break
    except Exception:
        pass
    time.sleep(0.1)
tripped.clear()
s = W.call("/api/wallet/setup", {"pin": "246827"})[1]["session"]
check("the page loads the 0.4 script in the Android app", "/net04/net04.js" in urllib.request.urlopen(W.BASE + "/").read().decode())
check("the 0.4 routes need the session", W.call("/api/wallet/net04")[0] == 401 and W.call("/api/wallet/net04/watch", {"add": OWNER})[0] == 401)
code, d = W.call("/api/wallet/net04/watch", {"add": "Public/" + OWNER}, session=s)
check("watching through the app", code == 200 and d["id"] == OWNER, d)
check("a bad id is refused", W.call("/api/wallet/net04/watch", {"add": "hello"}, session=s)[0] == 400)
W.call("/api/messages/status", session=s)
check("the tripwires work: a message route reaches them", "messaging_get" in tripped, tripped)
tripped.clear()
before = list(tripped)
W.call("/api/wallet/net04", session=s)
time.sleep(1)
code, v = W.call("/api/wallet/net04", session=s)
check("the app reads the stand-in network", code == 200 and v["accounts"][0].get("native") == "23,786,858", v)
chain.raw = b"\x00garbage" * 1000
time.sleep(0.3)
W.call("/api/wallet/net04", session=s)
time.sleep(0.6)
code, v = W.call("/api/wallet/net04", session=s)
check("garbage from the network is 'can't reach', the old numbers kept", code == 200 and v["unreachable"] and v["accounts"][0].get("native") == "23,786,858", v)
W.call("/api/wallet/net04/watch", {"remove": OWNER}, session=s)


class Trickle(http.server.BaseHTTPRequestHandler):
    """An answer that comes a byte every half second: each byte is within the per-read timeout."""
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200); self.send_header("Content-Length", "100000"); self.end_headers()
        try:
            for _ in range(40):
                self.wfile.write(b" "); self.wfile.flush(); time.sleep(0.5)
        except Exception:
            pass

    def log_message(self, *a):
        pass


import socket  # noqa: E402


def raw_server(behave):
    """A plain TCP server: `behave(conn)` for each connection."""
    ls = socket.socket()
    ls.bind(("127.0.0.1", 0))
    ls.listen(8)

    def loop():
        while True:
            try:
                c, _ = ls.accept()
            except Exception:
                return
            threading.Thread(target=behave, args=(c,), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    return ls


def trickle_status(c):        # the status line, a byte every half second
    try:
        c.recv(65536)
        for ch_ in b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}" * 3:
            c.send(bytes([ch_])); time.sleep(0.5)
    except Exception:
        pass


def silent(c):                # never answers
    try:
        c.recv(65536); time.sleep(30)
    except Exception:
        pass


slow = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Trickle)
threading.Thread(target=slow.serve_forever, daemon=True).start()
for what, port in (("a body trickling in", slow.server_address[1]), ("a status line trickling in", raw_server(trickle_status).getsockname()[1]),
                   ("no answer at all", raw_server(silent).getsockname()[1])):
    t0, err = time.monotonic(), None
    try:
        server.fetch_outside("http://127.0.0.1:%d/" % port, {"x": 1}, cap=1 << 20, timeout=8, total=2)
    except Exception as e:
        err = e
    check("%s: cut off at the request's overall limit (2 s here), not waited for" % what, isinstance(err, TimeoutError) and time.monotonic() - t0 < 3.5, (err, time.monotonic() - t0))
slow.shutdown()
chain.raw = None
code, raw = server.fetch_outside("http://127.0.0.1:%d/" % rpc.server_address[1], {"jsonrpc": "2.0", "id": 1, "method": "getChannelId", "params": []}, cap=1 << 16, total=5)
check("an ordinary answer within the limit comes through", code == 200 and json.loads(raw)["result"] == REC["channel"], raw[:100])
check("nothing on the 0.4 path reached a send, the node, the names service, the 0.3 balances or the messages", not tripped, tripped)
print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

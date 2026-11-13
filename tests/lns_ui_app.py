#!/usr/bin/env python3
"""The app as the Android app runs it, with the stand-in signer (fake_names_bin.py), a stand-in sequencer and
a stand-in node, for tests/lns_ui.mjs. Serves on 127.0.0.1:<port> until killed; prints "ready" when up.

  python3 tests/lns_ui_app.py <port>
"""
import http.server, json, os, shutil, signal, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
port = sys.argv[1]


LEZ = {"balance": 0, "faucet": "ok"}         # the name account's LEZ, and how the faucet answers
NOTES = {"a1" * 32: {"%064x" % 1: 30000000, "%064x" % 2: 400000}}
CHANNEL = "01" * 32
nid = [100]


def later(fn, s=1.0):
    t = threading.Timer(s, fn)
    t.daemon = True
    t.start()


class Seq(http.server.BaseHTTPRequestHandler):
    """The sequencer (JSON-RPC), the faucet (POST /faucet) and the test's controls (POST /ctl/...)."""
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path.startswith("/ctl/lez/"):
            LEZ["balance"] = int(self.path.rsplit("/", 1)[1])
            return self.out(200, {})
        if self.path.startswith("/ctl/faucet/"):
            LEZ["faucet"] = self.path.rsplit("/", 1)[1]
            return self.out(200, {})
        if self.path.startswith("/faucet"):
            if LEZ["faucet"] != "ok":
                return self.out(429, {"error": "this account was funded in the last day"})
            later(lambda: LEZ.update(balance=LEZ["balance"] + 2000000))
            return self.out(200, {"account": body.get("account"), "amount": "2000000", "tx": "33" * 32})

        def answer(c):
            m, r = c.get("method"), {"jsonrpc": "2.0", "id": c.get("id")}
            if m == "getRecoveryBinding":
                r["error"] = {"code": -32601, "message": "Method not found"}
            elif m == "getAccountsNonces":
                r["result"] = [LEZ.get("nonce", 0)]
            elif m == "sendTransaction":
                LEZ["nonce"] = LEZ.get("nonce", 0) + 1
                p = (c.get("params") or [{}])[0]
                if isinstance(p, dict) and p.get("Public") == "transfer":
                    LEZ["balance"] -= int(p["amount"]) + 3000
                r["result"] = "cd" * 32
            else:
                r["result"] = {"getAccountBalance": LEZ["balance"], "getLastBlockId": 7, "getChannelId": CHANNEL,
                               "getFeeState": {"next_base_fee_exec_ceiling": 9, "next_base_fee_stor_ceiling": 9, "base_fee_exec": 8, "base_fee_stor": 8}}.get(m)
            return r
        self.out(200, [answer(c) for c in body] if isinstance(body, list) else answer(body))

    def out(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class Node(Seq):
    """The node's HTTP API: notes of Main, a transfer or a deposit in a block a second later, a deposit credited on
    LEZ a second after that."""
    def do_GET(self):
        if self.path.startswith("/cryptarchia/info"):
            return self.out(200, {"height": 500, "slot": 900, "tip": "aa" * 32, "lib": "bb" * 32, "state": "Online", "mode": "Online"})
        if self.path.startswith("/network/info"):
            return self.out(200, {"connected_peers": ["p"]})
        if self.path.startswith("/wallet/") and self.path.endswith("/balance"):
            n = dict(NOTES.get(self.path.split("/")[2], {}))
            return self.out(200, {"balance": sum(n.values()), "notes": n})
        if self.path == "/channel/" + CHANNEL:
            return self.out(200, {})
        return self.out(404, {"code": 404})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        key = body.get("change_public_key")
        notes = NOTES.get(key, {})
        if self.path == "/wallet/transactions/transfer-funds":
            big = max(notes, key=notes.get)

            def land():
                v = notes.pop(big)
                for amt in (body["amount"], v - body["amount"] - 2018):
                    nid[0] += 1
                    notes["%064x" % nid[0]] = amt
            later(land)
            return self.out(201, {"hash": "11" * 32})
        if self.path == "/channel/deposit":
            dep = body["deposit"]["inputs"][0]
            fee_in = max((i for i in notes if i != dep), key=notes.get)

            def land():
                amount = notes.pop(dep)
                v = notes.pop(fee_in)
                nid[0] += 1
                notes["%064x" % nid[0]] = v - 2054
                later(lambda: LEZ.update(balance=LEZ["balance"] + amount))
            later(land)
            return self.out(200, {"hash": "22" * 32})
        return self.out(404, {"code": 404})


seq = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Seq)
node_api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Node)
for srv in (seq, node_api):
    threading.Thread(target=srv.serve_forever, daemon=True).start()
top = tempfile.mkdtemp(prefix="lns-ui-")                 # everything this run makes, removed on SIGTERM
data, node, bins = (tempfile.mkdtemp(dir=top) for _ in range(3))


def bye(*_):
    shutil.rmtree(top, ignore_errors=True)
    os._exit(0)


signal.signal(signal.SIGTERM, bye)
with open(os.path.join(node, "user_config.yaml"), "w") as f:
    f.write("kms:\n  keystore: keystore.yaml\n")
with open(os.path.join(node, "keystore.yaml"), "w") as f:
    f.write("public_keys:\n  LeaderFunding: %s\n  SdpFunding: %s\nsecret_keys:\n  LeaderFunding: %s\n" % ("a1" * 32, "b2" * 32, "c3" * 32))
for src, dst in (("fake_node_bin.py", "fake_node_bin.py"), ("fake_names_bin.py", "libnames.so")):
    shutil.copy(os.path.join(HERE, src), os.path.join(bins, dst))
    os.chmod(os.path.join(bins, dst), 0o755)
os.environ.update(APP_EMBEDDED="android", APP_PORT=port, APP_DATA=data, NODE_BIN=os.path.join(bins, "fake_node_bin.py"),
                  NODE_CFG=os.path.join(node, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="",
                  NAMES_BIN=os.path.join(bins, "libnames.so"), NAMES_RPC_URL="http://127.0.0.1:%d/" % seq.server_address[1],
                  NODE_API="http://127.0.0.1:%d" % node_api.server_address[1], BRIDGE_POLL="0.5", HISTORY_POLL="1",
                  LNS_FLOW_POLL="0.5", LNS_FLOW_PAUSES="1,1,1,1", LNS_FLOW_GAP="0.5", BRIDGE_SLOW="0", BRIDGE_SPLIT_WAIT="3",
                  LNS_FAUCET_URL="http://127.0.0.1:%d/faucet" % seq.server_address[1])
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

threading.Thread(target=server.main, daemon=True).start()
time.sleep(1)
print("ready %d" % seq.server_address[1], flush=True)
while True:
    time.sleep(3600)

#!/usr/bin/env python3
"""The app as the Android app runs it, with the stand-in signer (fake_names_bin.py), a stand-in sequencer and
a stand-in node, for tests/lns_ui.mjs. Serves on 127.0.0.1:<port> until killed; prints "ready" when up.

  python3 tests/lns_ui_app.py <port>
"""
import http.server, json, os, shutil, signal, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fake_chain import tx_hash  # noqa: E402
port = sys.argv[1]


LEZ = {"balance": 0, "faucet": "ok"}         # the name account's LEZ, and how the faucet answers
NOTES = {"a1" * 32: {"%064x" % 1: 30000000, "%064x" % 2: 400000}}
CHANNEL = "01" * 32
FUNDED, BLOCKS = {}, []                       # transfers /wallet/fund built; blocks: [{"slot", "txs"}]
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
        if self.path.startswith("/cryptarchia/blocks_range"):
            lo = int(self.path.split("slot_from=")[1].split("&")[0])
            raw = "".join(json.dumps({"block": {"header": {"slot": b["slot"], "id": "%064x" % (n + 1), "parent_block": "%064x" % n}, "transactions": [
                {"mantle_tx": {"hash": h, "ops": []}, "ops_proofs": []} for h in b["txs"]]}, "lib_slot": BLOCKS[-1]["slot"]}) + "\n" for n, b in enumerate(BLOCKS) if b["slot"] >= lo).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            return self.wfile.write(raw)
        if self.path.startswith("/cryptarchia/info"):
            return self.out(200, {"height": 500, "slot": 900 + len(BLOCKS), "tip": "aa" * 32, "lib": "bb" * 32, "state": "Online", "mode": "Online"})
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
        if self.path == "/wallet/fund":
            out = body["tx_builder"]["pending_transfer"]["outputs"][0]
            big = max(notes, key=notes.get)
            outs = [dict(out), {"value": notes[big] - out["value"] - 2018, "pk": key}]
            tx = {"ops": [{"opcode": 0, "payload": {"inputs": [big], "outputs": outs}}]}
            FUNDED[tx_hash(tx)] = {"key": key, "input": big, "outs": outs, "done": False}
            return self.out(200, {"tip": "aa" * 32, "funded_tx": tx, "transfer_proof": {"ZkSig": {"pi_a": "aa"}}})
        if self.path == "/mempool/add/tx":
            h = tx_hash(body["mantle_tx"])
            f = FUNDED.get(h)
            if f and not f["done"]:
                f["done"] = True

                def land_tx():
                    n = NOTES.get(f["key"], {})
                    if f["input"] in n:
                        n.pop(f["input"])
                        for o in f["outs"]:
                            nid[0] += 1
                            NOTES.setdefault(o["pk"], {})["%064x" % nid[0]] = o["value"]
                        BLOCKS.append({"slot": 901 + len(BLOCKS), "txs": [h]})
                        for _ in range(2):    # and two blocks on top: confirmed (the app's depth)
                            BLOCKS.append({"slot": 901 + len(BLOCKS), "txs": []})
                later(land_tx)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
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


REC = json.load(open(os.path.join(HERE, "fixtures", "net04", "recorded.json")))
NET04 = {"mode": "ok", "channel": REC["channel"]}
NET04_ACCOUNTS = dict(REC["definitions"], **{REC["config_account"]: REC["config"]})
NET04_ACCOUNTS["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"] = list(REC["accounts"].values())[0]   # the stand-in signer's account
NET04_ACCOUNTS.update(REC["accounts"])


class Net04(Seq):
    """The bridge test network (LEZ 0.4), from the answers recorded in tests/fixtures/net04; POST /ctl/net04/<mode>
    makes it answer as reset (a new channel) or not at all (down)."""
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path.startswith("/ctl/net04/"):
            NET04["mode"] = self.path.rsplit("/", 1)[1]
            if NET04["mode"] == "reset":
                NET04["channel"] = "ee" * 32
            return self.out(200, {})
        if NET04["mode"] == "down":
            return self.out(503, {"error": "down"})
        m, p = body.get("method"), body.get("params") or [None]
        res = NET04["channel"] if m == "getChannelId" else REC["height"] if m == "getLastBlockId" else NET04_ACCOUNTS.get(p[0]) if m == "getAccount" else None
        self.out(200, {"jsonrpc": "2.0", "id": body.get("id"), "result": res})


net04 = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Net04)
threading.Thread(target=net04.serve_forever, daemon=True).start()
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
with open(os.path.join(data, "wallet-net04-config.json"), "w") as f:
    json.dump({"rpc_url": "http://127.0.0.1:%d/" % net04.server_address[1]}, f)
for src, dst in (("fake_node_bin.py", "fake_node_bin.py"), ("fake_names_bin.py", "libnames.so")):
    shutil.copy(os.path.join(HERE, src), os.path.join(bins, dst))
    os.chmod(os.path.join(bins, dst), 0o755)
os.environ.update(APP_EMBEDDED="android", APP_PORT=port, APP_DATA=data, NODE_BIN=os.path.join(bins, "fake_node_bin.py"),
                  NODE_CFG=os.path.join(node, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="",
                  NAMES_BIN=os.path.join(bins, "libnames.so"), NAMES_RPC_URL="http://127.0.0.1:%d/" % seq.server_address[1],
                  NODE_API="http://127.0.0.1:%d" % node_api.server_address[1], BRIDGE_POLL="0.5", HISTORY_POLL="1",
                  LNS_FLOW_POLL="0.5", LNS_FLOW_PAUSES="1,1,1,1", LNS_FLOW_GAP="0.5", LNS_FLOW_RESOLVE_EVERY="0.2,0.5", BRIDGE_SLOW="0", BRIDGE_SPLIT_WAIT="3", XFER_RESCAN_SECONDS="0.5", NET04_POLL_SECONDS="1",
                  LNS_FAUCET_URL="http://127.0.0.1:%d/faucet" % seq.server_address[1])
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

threading.Thread(target=server.main, daemon=True).start()
time.sleep(1)
print("ready %d net04 %d" % (seq.server_address[1], net04.server_address[1]), flush=True)
while True:
    time.sleep(3600)

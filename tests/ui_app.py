#!/usr/bin/env python3
"""The app as the Android app runs it, with the stand-in LEZ 0.4 signer (fake_names04_bin.py), a stand-in LEZ 0.4
network and a stand-in node, for the browser tests (net04_ui, nft04_ui, sign04_ui, lock_ui). Serves on
127.0.0.1:<port> until killed; prints "ready" when up.

  python3 tests/ui_app.py <port>

Without WITH_SIGNER04=1 the phone's LEZ 0.4 wallet is already set up (its first account is OWN04 below); with it, the
test sets it up itself.
"""
import http.server, json, os, shutil, signal, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fake_chain import tx_hash  # noqa: E402
port = sys.argv[1]


NOTES = {"a1" * 32: {"%064x" % 1: 30000000, "%064x" % 2: 400000}}
FUNDED, BLOCKS = {}, []                       # transfers /wallet/fund built; blocks: [{"slot", "txs"}]
nid = [100]


def later(fn, s=1.0):
    t = threading.Timer(s, fn)
    t.daemon = True
    t.start()


class Out(http.server.BaseHTTPRequestHandler):
    def out(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class Node(Out):
    """The node's HTTP API: notes of Main, a transfer in a block a second later."""
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
        return self.out(404, {"code": 404})


REC = json.load(open(os.path.join(HERE, "fixtures", "net04", "recorded.json")))
NET04 = {"mode": "ok", "channel": REC["channel"]}
NET04_ACCOUNTS = dict(REC["definitions"], **{REC["config_account"]: REC["config"]})
NET04_ACCOUNTS["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"] = list(REC["accounts"].values())[0]   # the stand-in signer's account
NET04_ACCOUNTS.update(REC["accounts"])

# Collectibles (tests/nft04_ui.mjs): NFT states read with getAccountView, {account: {program: bytes}}. Under the test's
# NFT program: the phone's account holds the master of "Harbour at dawn" (2 print rights), the recorded Basecamp account
# a copy. The LNS name "alice" (its id as the stand-in signer prints it) is held by the phone's account and has its NFT.
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import hashlib, lez04  # noqa: E402
NFT_PROGRAM, NFT_ART = "ErycMYqXUUtducaYmpHZjRgdbLXchrMiV4NZRnmRDNmu", "HA47ERcmfSbDChGcYfBcC4SKaPQ8pJJnv4wxCLu1ejL5"
_txt = lambda t: len(t.encode()).to_bytes(4, "little") + t.encode()      # noqa: E731
_u128 = lambda n: n.to_bytes(16, "little")                                  # noqa: E731
OWN04 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
NFT_STATES = {
    NFT_ART: {NFT_PROGRAM: b"\0" + _txt("Harbour at dawn") + _u128(3) + b"\0" + _txt("https://img.example.com/harbour.png") + _txt("ada")},
    OWN04: {NFT_PROGRAM: b"\1" + lez04.b58decode(NFT_ART) + _u128(2)},
    "CCVd76Tk3WvFb63Wbuu4exMeLRTbSuMWHqxuvysapKnk": {NFT_PROGRAM: b"\2" + lez04.b58decode(NFT_ART) + b"\1"},
}
_cfg = json.load(open(os.path.join(HERE, "..", "app", "lez04.json")))
_reg, _deeds = _cfg["lns_registry"], _cfg["deed_nft_program"]
_alice = hashlib.sha256(b"fake-id/alice").digest()                            # what fake_names04_bin.py prints for `address alice`
_tag, _nonce = lez04.owner_tag(_alice, OWN04), bytes(range(32))
_def = lez04.deed_definition_address(_reg, _alice, _nonce)
NFT_STATES[lez04.record_address(_reg, _alice)] = {_reg: b"\7" + _tag + (2 ** 64 - 1).to_bytes(8, "little") + _txt("sealed") + b"\0" + b"\1" + lez04.b58decode(_def) + _nonce}
NFT_STATES[lez04.deed_holding_address(_reg, _def, _tag)] = {_deeds: b"\1" + lez04.b58decode(_def) + _u128(1)}
NFT_STATES[_def] = {_deeds: b"\0" + _txt("LNS name deed") + _u128(1) + b"\0" + _txt("https://nameswallet.app/lns/deed.png") + _txt("LNS registry")}


def account_view(account, program):
    """getAccountView: the account's state under one program, from NFT_STATES or the recorded accounts."""
    if account in NFT_STATES:
        st = NFT_STATES[account].get(program)
        return {"nonce": 0, "data": {"actor_states": {} if st is None else {program: list(st)}}}
    a = NET04_ACCOUNTS.get(account)
    if a is None:
        return None
    st = a["data"]["actor_states"].get(program)
    return {"nonce": 0, "data": {"actor_states": {} if st is None else {program: st}}}


# With WITH_SIGNER04=1 (tests/sign04_ui.mjs): the app carries the LEZ 0.4 signer (the stand-in tool,
# fake_names04_bin.py), and the network also answers as tests/fake_chain04.py: balances, sends, NFT moves, a name's
# NFT claimed, the faucet. Accounts it knows are answered from it; the recorded ones as before.
SIGNER04 = os.environ.get("WITH_SIGNER04") == "1"
from fake_chain04 import Chain04  # noqa: E402
CHAIN04 = Chain04()


class Net04(Out):
    """The bridge test network (LEZ 0.4), from the answers recorded in tests/fixtures/net04; POST /ctl/net04/<mode>
    makes it answer as reset (a new channel) or not at all (down)."""
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path.startswith("/ctl/chain04/"):         # (WITH_SIGNER04) set up the stand-in: names, balances, NFTs
            what = self.path.rsplit("/", 1)[1]
            if what == "register":
                CHAIN04.register(body["name"], body["owner"], body.get("deed", False))
            elif what == "balance":
                CHAIN04.balances[body["account"]] = int(body["amount"])
            elif what == "nft":
                CHAIN04.states[(body["account"], body["program"])] = bytes.fromhex(body["hex"])
            elif what == "mode":                           # e.g. "lose_send": a send applied, its answer lost
                CHAIN04.mode = body["mode"]
            return self.out(200, {})
        if SIGNER04 and not self.path.startswith("/ctl/"):
            calls = body if isinstance(body, list) else [body]
            def known(c):
                m, p = c.get("method"), c.get("params") or [None]
                if m in ("sendTransaction", "bridge_faucet", "bridge_faucetInfo", "getAccountBalance", "getFeeState"):
                    return True
                if m == "getAccount":
                    return p[0] in CHAIN04.balances or any(a == p[0] for a, _ in CHAIN04.states)
                if m == "getAccountView" and isinstance(p[0], dict):
                    return (p[0].get("account_id"), p[0].get("program_account_id")) in CHAIN04.states or p[0].get("account_id") in CHAIN04.balances
                return False
            if all(known(c) for c in calls):
                code, raw = CHAIN04.handle(body)
                self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
                self.end_headers(); self.wfile.write(raw)
                return
        if self.path.startswith("/ctl/net04/"):
            NET04["mode"] = self.path.rsplit("/", 1)[1]
            if NET04["mode"] == "reset":
                NET04["channel"] = "ee" * 32
            return self.out(200, {})
        if NET04["mode"] == "down":
            return self.out(503, {"error": "down"})
        m, p = body.get("method"), body.get("params") or [None]
        res = NET04["channel"] if m == "getChannelId" else REC["height"] if m == "getLastBlockId" else NET04_ACCOUNTS.get(p[0]) if m == "getAccount" \
            else account_view(p[0].get("account_id"), p[0].get("program_account_id")) if m == "getAccountView" and isinstance(p[0], dict) else None
        self.out(200, {"jsonrpc": "2.0", "id": body.get("id"), "result": res})


net04 = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Net04)
threading.Thread(target=net04.serve_forever, daemon=True).start()
node_api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Node)
threading.Thread(target=node_api.serve_forever, daemon=True).start()
top = tempfile.mkdtemp(prefix="ui-app-")                 # everything this run makes, removed on SIGTERM
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
for src, dst in (("fake_node_bin.py", "fake_node_bin.py"), ("fake_names04_bin.py", "libnames04.so")):
    shutil.copy(os.path.join(HERE, src), os.path.join(bins, dst))
    os.chmod(os.path.join(bins, dst), 0o755)
# the locked-name list, already here (never downloaded in a test)
os.makedirs(os.path.join(data, ".lez04-wallet", "cache"), mode=0o700)
with open(os.path.join(data, ".lez04-wallet", "cache", "shortlist-9778bed4.bin"), "wb") as f:
    f.write(b"stand-in list")
os.environ["NAMES04_BIN"] = os.path.join(bins, "libnames04.so")
if not SIGNER04:                                         # the phone's LEZ 0.4 wallet, set up already: OWN04 first
    with open(os.path.join(data, ".lez04-wallet", "storage.json"), "w") as f:
        f.write("{}")
    with open(os.path.join(data, "wallet-lez04.json"), "w") as f:
        json.dump({"accounts": [OWN04], "main": OWN04, "public_key": "ab" * 32, "faucet": {"ok": True, "amount": "10000000", "at": 1}}, f)
os.environ.update(APP_EMBEDDED="android", APP_PORT=port, APP_DATA=data, NODE_BIN=os.path.join(bins, "fake_node_bin.py"),
                  NODE_CFG=os.path.join(node, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="",
                  NODE_API="http://127.0.0.1:%d" % node_api.server_address[1], HISTORY_POLL="1",
                  XFER_RESCAN_SECONDS="0.5", NET04_POLL_SECONDS="1", LEZ04_PACE_SECONDS="0.01")
sys.path.insert(0, os.path.join(HERE, "..", "app"))
lez04.POLL = float(os.environ["NET04_POLL_SECONDS"])     # (lez04 was imported above, for the fixtures, before this was set)
lez04.NFT_GAP = 0.0                                      # no pacing against the stand-in
import server  # noqa: E402

threading.Thread(target=server.main, daemon=True).start()
time.sleep(1)
print("ready %d net04 %d" % (node_api.server_address[1], net04.server_address[1]), flush=True)
while True:
    time.sleep(3600)

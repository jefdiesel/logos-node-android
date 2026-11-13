#!/usr/bin/env python3
"""Get this name: the one-tap chained job (android/NAMES.md, "One tap"), with the stand-in signer (which keeps a small
chain file that register and set-text write and `resolve` reads) and a stand-in sequencer. No node, no chain.

  python3 tests/lns_flow_test.py

Checks that one tap goes all the way (account, LEZ, register, blockchain, msg); that it waits for LEZ and carries on
when it arrives; that msg follows when Messages is turned on later; that every step is decided from the chain, so a
stop and restart at any step never sends a change twice; retries with pauses; a name held elsewhere; and that a
restore waits while it runs.
"""
import atexit, http.server, json, os, shutil, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402
import fake_names_bin as FAKE  # noqa: E402

call, check = W.call, W.check
PIN, MAIN = "357911", "a1" * 32
W.BASE = "http://127.0.0.1:8096"
LEZ = {"balance": 0}


class Seq(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        m = body.get("method")
        r = {"jsonrpc": "2.0", "id": body.get("id"),
             "result": {"getAccountBalance": LEZ["balance"], "getLastBlockId": 7, "sendTransaction": "cd" * 32,
                        "getFeeState": {"next_base_fee_exec_ceiling": 9, "next_base_fee_stor_ceiling": 9, "base_fee_exec": 8, "base_fee_stor": 8}}.get(m)}
        data = json.dumps(r).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


seq = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Seq)
threading.Thread(target=seq.serve_forever, daemon=True).start()
top = tempfile.mkdtemp(prefix="lns-flow-")
atexit.register(shutil.rmtree, top, True)
data, node, bins = (tempfile.mkdtemp(dir=top) for _ in range(3))
with open(os.path.join(node, "user_config.yaml"), "w") as f:
    f.write("kms:\n  keystore: keystore.yaml\n")
with open(os.path.join(node, "keystore.yaml"), "w") as f:
    f.write("public_keys:\n  LeaderFunding: %s\n  SdpFunding: %s\nsecret_keys:\n  LeaderFunding: %s\n" % (MAIN, "b2" * 32, "c3" * 32))
for src, dst in (("fake_node_bin.py", "fake_node_bin.py"), ("fake_names_bin.py", "libnames.so")):
    shutil.copy(os.path.join(HERE, src), os.path.join(bins, dst))
    os.chmod(os.path.join(bins, dst), 0o755)
os.environ.update(APP_EMBEDDED="android", APP_PORT="8096", APP_DATA=data, NODE_BIN=os.path.join(bins, "fake_node_bin.py"),
                  NODE_CFG=os.path.join(node, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="",
                  NAMES_BIN=os.path.join(bins, "libnames.so"), NAMES_RPC_URL="http://127.0.0.1:%d/" % seq.server_address[1],
                  LNS_FLOW_POLL="0.2", LNS_FLOW_PAUSES="0.5,0.5,0.5,0.5")
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
calls_file = os.path.join(data, "fake-names-calls.jsonl")
chain_file = os.path.join(data, "fake-chain.json")


def sends(kind=None):
    """The signer's runs that send something, in order."""
    try:
        cs = [json.loads(l)["args"] for l in open(calls_file)]
    except FileNotFoundError:
        return []
    cs = [c for c in cs if c[:1] in (["register"], ["set-text"]) or c[:3] == ["wallet", "auth-transfer", "send"]]
    return [c for c in cs if kind is None or c[0] == kind]


def flow():
    return call("/api/wallet/lns", session=s)[1].get("flow") or {}


def until(what, cond, tries=200, pause=0.1):
    for _ in range(tries):
        v = cond()
        if v:
            return v
        time.sleep(pause)
    check(what, False, flow())


def chain():
    try:
        return json.load(open(chain_file))
    except Exception:
        return {}


s = call("/api/wallet/setup", {"pin": PIN})[1]["session"]
secret = "11" * 32
public = server.x25519(bytes.fromhex(secret), (9).to_bytes(32, "little")).hex()

# ---- who may call ----
check("locked: Get this name is refused", call("/api/wallet/lns/get", {"name": "alice"})[0] == 401)
check("from another page: refused", call("/api/wallet/lns/get", {"name": "alice"}, session=s, origin="https://evil.example")[0] == 403)
for bad in ("al!ce", "-x", "a b", "", "x" * 33, "alice\n", 5):
    check("not a name: %r refused" % bad, call("/api/wallet/lns/get", {"name": bad}, session=s)[0] == 400)

# ---- one tap with no account and no LEZ: the account is made, then it waits for LEZ, then carries on by itself ----
server.msg_key_save({"secret": secret, "public": public, "name": "", "version": 1, "groups": False}, quiet=True)
code, d = call("/api/wallet/lns/get", {"name": "alice"}, session=s)
check("one tap starts it", code == 200 and d["flow"]["name"] == "alice", d)
check("a second tap is refused while it runs", call("/api/wallet/lns/get", {"name": "bob"}, session=s)[0] == 409)
f = until("the account is made by itself, then it waits for LEZ, saying how much", lambda: flow().get("step") == "fund" and flow().get("short") and flow())
need = server.lns_flow_need("alice")
check("what it waits for covers the whole chain: commit, then the most any later step needs held (4,418,..)",
      need == (23214 * 9 + 13500) + 1000000 + (165000 * 9 + 13500) + (65590 * 9 + 13500) + (120000 * 9 + 13500) and f["short"] == str(need), (need, f))
check("its cost: the deposit and the fees of all four transactions at today's base fee",
      f["cost"] == {"deposit": "1000000", "fees": str((23214 + 165000 + 2 * 65590) * 8 + 4 * 500 * 8)}, f["cost"])
check("nothing was sent while it waits", sends() == [], sends())
code, d = call("/api/wallet/restore", {"backup": {}, "password": "x" * 8, "pin": PIN}, session=s)
LEZ["balance"] = need
until("LEZ arrives: it carries on with no tap, all the way", lambda: flow().get("step") == "done", tries=300)
check("one register, one set-text for blockchain, one for msg: nothing more", sends() == [
    ["register", "alice", "--owner", "Public/" + FAKE.ACCOUNT, "--term", "1y", "--wait"],
    ["set-text", "alice", "blockchain", MAIN], ["set-text", "alice", "msg", public]], sends())
check("the chain has both entries", chain()["alice"].get("blockchain") == MAIN and chain()["alice"].get("msg") == public, chain())
check("the phone holds alice, and messages go out under it", server.lns_state()["name"] == "alice" and server.msg_key_load()["name"] == "alice")
d = call("/api/wallet/lns", session=s)[1]
check("the page is told: done, and a backup is due", d["flow"]["step"] == "done" and d["backup_needed"] is True, d["flow"])
with open(os.path.join(data, "wallet-events.log")) as fh:
    log = fh.read()
check("each progress line is in the event log with its time", "lns progress" in log and "lns get done" in log)

# ---- every step is decided from the chain: a stop and start at any step sends nothing twice ----
n = len(sends())
for step in ("register", "blockchain", "msg"):
    server.lns_flow_save(dict(server.lns_flow_load(), step=step, job=None, tries=0, next_at=0))
    with server.lns_lock:
        server.lns_job.update(kind=None, state="idle", started=None)          # as after a restart
    server.lns_flow_round(); server.lns_flow_round(); server.lns_flow_round()
    until("restarted at %s: it finds the step done on chain and goes on" % step, lambda: flow().get("step") == "done")
check("and sent nothing again", len(sends()) == n, sends()[n:])
code, d = call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)
check("Point it at this wallet now is refused before sending: already points here", code == 409 and d.get("already") is True, d)

# ---- Messages off: done without msg; msg follows by itself when Messages is turned on ----
LEZ["balance"] = 20000000                       # bob has three characters: the higher deposit
server.lns_state_save(name="")
os.remove(server.LNS_FLOW_FILE)
real_mk = server.msg_key_load
server.msg_key_load = lambda: None
code, d = call("/api/wallet/lns/get", {"name": "bob"}, session=s)
until("with Messages off it finishes without msg, and says msg comes later", lambda: flow().get("step") == "done" and flow().get("msg_later"))
check("bob: registered and pointed at this wallet; no msg entry", chain()["bob"].get("blockchain") == MAIN and "msg" not in chain()["bob"])
server.msg_key_load = real_mk
server.lns_flow_wake.set()
until("Messages on: the msg entry follows by itself", lambda: chain()["bob"].get("msg") == public and flow().get("step") == "done" and not flow().get("msg_later"))

# ---- a passing failure is tried again after a pause; a final one stops with one line, then Try again ----
server.lns_state_save(name="")
os.remove(server.LNS_FLOW_FILE)
open(os.path.join(data, "fake-settext-fail-once"), "w").close()
code, d = call("/api/wallet/lns/get", {"name": "carol"}, session=s)
until("a set-text that failed once is tried again by itself, and it finishes", lambda: flow().get("step") == "done", tries=300)
check("carol has both entries", chain()["carol"].get("blockchain") == MAIN and chain()["carol"].get("msg") == public)
server.lns_state_save(name="")
os.remove(server.LNS_FLOW_FILE)
code, d = call("/api/wallet/lns/get", {"name": "taken"}, session=s)
until("a name someone holds: it stops with one line, no tries again", lambda: flow().get("step") == "failed")
check("one register only, and the line says why", len(sends("register")) == 4 and "already registered" in flow()["error"], (sends("register"), flow()))
code, d = call("/api/wallet/lns/get/retry", {}, session=s)
check("Try again starts it over", code == 200)
until("and stops again", lambda: flow().get("step") == "failed")
code, d = call("/api/wallet/lns/get/stop", {}, session=s)
check("a stopped one can be cleared", code == 200 and call("/api/wallet/lns", session=s)[1]["flow"] is None)

# ---- I already hold it: the hold is checked on chain, then both entries ----
FAKE_OWNER = FAKE.ACCOUNT
c = chain(); c["dave"] = {"_owner": FAKE_OWNER}; json.dump(c, open(chain_file, "w"))
code, d = call("/api/wallet/lns/get", {"name": "dave", "mode": "link"}, session=s)
until("held: linked, then both entries, no register", lambda: flow().get("step") == "done")
check("dave: no register was sent, both entries set", not [x for x in sends("register") if x[1] == "dave"]
      and chain()["dave"].get("blockchain") == MAIN and chain()["dave"].get("msg") == public)
server.lns_state_save(name="")
os.remove(server.LNS_FLOW_FILE)
c = chain(); c["erin"] = {"_owner": "someoneelse"}; json.dump(c, open(chain_file, "w"))
code, d = call("/api/wallet/lns/get", {"name": "erin", "mode": "link"}, session=s)
until("held by someone else: it stops with one line", lambda: flow().get("step") == "failed" and "doesn't hold erin" in flow()["error"])
check("and nothing was sent for it", not [x for x in sends() if "erin" in x])
os.remove(server.LNS_FLOW_FILE)

# ---- a restore waits while it runs between two changes ----
server.lns_state_save(name="")
LEZ["balance"] = 0
code, d = call("/api/wallet/lns/get", {"name": "frank"}, session=s)
until("waiting for LEZ", lambda: flow().get("step") == "fund")
server.lns_flow_save(dict(server.lns_flow_load(), step="blockchain", next_at=time.time() + 60))
outcome, msg = server.lns_restore({"storage": "{}", "account": FAKE.ACCOUNT}, True)
check("a restore while getting a name is between changes: busy, nothing changed", outcome in ("busy", "unchecked") and (outcome == "busy" or "couldn't" in msg), (outcome, msg))
print("all checks passed", flush=True)
os._exit(0)

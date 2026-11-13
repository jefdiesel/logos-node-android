#!/usr/bin/env python3
"""The phone's own LNS name (android/NAMES.md): the /api/wallet/lns routes, the sequencer forwarder for the
signer, and the name account in the encrypted backup, with a stand-in signer (tests/fake_names_bin.py) and a
stand-in sequencer. No node, no chain.

  python3 tests/lns_test.py

Runs the app the way the Android app does (APP_EMBEDDED=android, server.py imported, main() in a thread) on
127.0.0.1:8099. The fake signer prints a recovery phrase when it makes the wallet, and noise with that phrase
in every registration: the test checks it reaches no reply, no log and no file other than the wallet's own.
"""
import atexit, base64, http.server, json, os, shutil, stat, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402
import fake_names_bin as FAKE  # noqa: E402  (only its constants; importing it runs nothing with no args)

call, check = W.call, W.check
PIN, PASSWORD = "357911", "a long backup password"
MAIN = "a1" * 32
W.BASE = "http://127.0.0.1:8099"

# ---- a stand-in sequencer: answers the methods the signer and the app use, and remembers what it saw -----
seen = []


class Seq(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        answer = lambda c: {"jsonrpc": "2.0", "id": c.get("id"),
                            "result": {"getAccountBalance": 4200000, "getLastBlockId": 7, "sendTransaction": "cd" * 32}.get(c.get("method"))}
        seen.extend(body if isinstance(body, list) else [body])
        data = json.dumps([answer(c) for c in body] if isinstance(body, list) else answer(body)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


seq = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Seq)
threading.Thread(target=seq.serve_forever, daemon=True).start()

# ---- the app, as the Android app runs it, with a node config the fake node reads keys from ---------------
top = tempfile.mkdtemp(prefix="lns-test-")             # everything this run makes, removed at exit
atexit.register(shutil.rmtree, top, True)
data = tempfile.mkdtemp(dir=top)
node = tempfile.mkdtemp(dir=top)
with open(os.path.join(node, "user_config.yaml"), "w") as f:
    f.write("kms:\n  keystore: keystore.yaml\n")
with open(os.path.join(node, "keystore.yaml"), "w") as f:
    f.write("public_keys:\n  LeaderFunding: %s\n  SdpFunding: %s\nsecret_keys:\n  LeaderFunding: %s\n" % (MAIN, "b2" * 32, "c3" * 32))
bins = tempfile.mkdtemp(dir=top)
fake_node = os.path.join(bins, "fake_node_bin.py")
fake_names = os.path.join(bins, "libnames.so")          # named as the app ships it
shutil.copy(os.path.join(HERE, "fake_node_bin.py"), fake_node)
shutil.copy(os.path.join(HERE, "fake_names_bin.py"), fake_names)
os.chmod(fake_node, 0o755)
os.chmod(fake_names, 0o755)
os.environ.update(APP_EMBEDDED="android", APP_PORT="8099", APP_DATA=data, NODE_BIN=fake_node,
                  NODE_CFG=os.path.join(node, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="",
                  NAMES_BIN=fake_names, NAMES_RPC_URL="http://127.0.0.1:%d/" % seq.server_address[1])
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
calls_file = os.path.join(data, "fake-names-calls.jsonl")
for _ in range(50):                          # the node's keys, read once at start through the fake node
    with server.lock:
        server.keys_cache["at"] = 0.0
    if server.wallet_keys():
        break
    time.sleep(0.1)


def calls():
    """The signer's runs that change something (its read-only `resolve` and `settings`, run in the background, left out)."""
    try:
        return [c for c in (json.loads(l) for l in open(calls_file)) if c["args"][:1] not in (["resolve"], ["settings"])]
    except FileNotFoundError:
        return []


def wait_job(s, tries=150):
    for _ in range(tries):
        code, d = call("/api/wallet/lns", session=s)
        if d.get("job", {}).get("state") != "running":
            return d
        time.sleep(0.1)
    check("the job finishes", False, d)


def phrase_nowhere(where):
    """The recovery phrase is in no file of the app's data except the wallet's own storage.json."""
    for top, _, files in os.walk(data):
        for name in files:
            p = os.path.join(top, name)
            if p == os.path.join(server.LNS_HOME, "storage.json"):
                continue
            with open(p, "rb") as f:
                if b"abandon ability" in f.read():
                    check("%s: no recovery phrase in %s" % (where, os.path.relpath(p, data)), False)
    check("%s: the recovery phrase is in no file but the wallet's own" % where, True)


s = call("/api/wallet/setup", {"pin": PIN})[1]["session"]

# ---- who may call ------------------------------------------------------------------------------------------
check("locked: GET /api/wallet/lns is refused", call("/api/wallet/lns")[0] == 401)
check("locked: making the account is refused", call("/api/wallet/lns/account", {})[0] == 401)
check("from another page: refused", call("/api/wallet/lns/account", {}, session=s, origin="http://evil.example")[0] == 403)
check("with no Origin: refused", call("/api/wallet/lns/account", {}, session=s, origin=None)[0] == 403)
check("under another Host name: refused", call("/api/wallet/lns", session=s, host="rebind.example:8099")[0] == 403)
import urllib.request as _u  # noqa: E402
page = lambda: _u.urlopen(W.BASE + "/", timeout=10).read().decode()
check("with the signer the page loads Your name", '<script src="/lns/lns.js"></script>' in page())
check("and /lns/lns.js is served", _u.urlopen(W.BASE + "/lns/lns.js", timeout=10).read().startswith(b"// Your name"))
server.NAMES_BIN = ""
check("without the signer the page doesn't load it", '<script src="/lns/lns.js">' not in page())
try:
    _u.urlopen(W.BASE + "/lns/lns.js", timeout=10)
    check("without the signer /lns/lns.js is 404", False)
except Exception as e:
    check("without the signer /lns/lns.js is 404", getattr(e, "code", None) == 404)
check("without the signer every route is 404", call("/api/wallet/lns", session=s)[0] == 404
      and all(call(p, {}, session=s)[0] == 404 for p in ("/api/wallet/lns/account", "/api/wallet/lns/register", "/api/wallet/lns/name", "/api/wallet/lns/text")))
server.NAMES_BIN = fake_names
server.EMBEDDED = False
check("outside the Android app every route is 404", call("/api/wallet/lns", session=s)[0] == 404
      and call("/api/wallet/lns/account", {}, session=s)[0] == 404)
server.EMBEDDED = True

code, d = call("/api/wallet/lns", session=s)
check("no account yet", code == 200 and d["account"] is None and d["name"] == "" and d["job"]["state"] == "idle", d)
check("it offers this wallet's Main address for blockchain", d["values"]["blockchain"] == MAIN, d)
check("and no messaging address while messages are off", d["values"]["msg"] is None, d)
check("register before the account: refused", call("/api/wallet/lns/register", {"name": "alice"}, session=s)[0] == 409)
check("an entry before the account: refused", call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)[0] == 409)

# ---- the account ---------------------------------------------------------------------------------------------
code, d = call("/api/wallet/lns/account", {}, session=s)
check("the account is made", code == 200 and d.get("account") == FAKE.ACCOUNT, (code, d))
check("the reply holds only the address", set(d) == {"account"}, d)
check("the signer was run as `names wallet account new public`", calls()[-1]["args"] == ["wallet", "account", "new", "public"])
env = calls()[-1]
check("with the app's wallet folder, the forwarder and the registry, and nothing else of the app's environment",
      set(server.lns_env()) == {"PATH", "HOME", "TMPDIR", "LEE_WALLET_HOME_DIR", "LOGOS_NAMES_RPC", "LOGOS_NAMES_PROGRAM", "NO_COLOR", "RUST_BACKTRACE"}
      and set(server.lns_env()) <= set(env["env"]) and not {"APP_DATA", "APP_PORT", "NAMES_BIN", "NODE_BIN", "NAMES_RPC_URL"} & set(env["env"])
      and env["rpc"] == "http://127.0.0.1:8099/lez-rpc/" + server.LNS_RPC_SECRET and env["program"] == server.NAMES_PROGRAM, env)
mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)
check("the wallet folder is 0700", mode(server.LNS_HOME) == 0o700, oct(mode(server.LNS_HOME)))
check("its files are 0600", all(mode(os.path.join(server.LNS_HOME, f)) == 0o600 for f in os.listdir(server.LNS_HOME) if os.path.isfile(os.path.join(server.LNS_HOME, f))),
      {f: oct(mode(os.path.join(server.LNS_HOME, f))) for f in os.listdir(server.LNS_HOME)})
check("a second account is refused", call("/api/wallet/lns/account", {}, session=s)[0] == 409)
code, d = call("/api/wallet/lns", session=s)
check("the account and its balance show", d["account"] == FAKE.ACCOUNT and d["balance"] == "4200000", d)
check("the balance was asked of the name service for that account",
      any({"method": "getAccountBalance", "params": [FAKE.ACCOUNT]}.items() <= c.items() for c in seen[-4:]), seen[-4:])
phrase_nowhere("after making the account")
check("right after making it, the page is asked to prompt for a backup", d["backup_needed"] is True, d)

# ---- register ------------------------------------------------------------------------------------------------
for bad in ("Bad Name", "-x", "a" * 33, "", "alice;rm"):
    check("register refuses %r" % bad, call("/api/wallet/lns/register", {"name": bad}, session=s)[0] == 400)
seen.clear()
code, d = call("/api/wallet/lns/register", {"name": "Alice"}, session=s)
check("register starts", code == 200 and d == {"started": "register"}, (code, d))
d = wait_job(s)
check("register finished", d["job"]["state"] == "done" and d["job"]["kind"] == "register" and d["name"] == "alice", d)
c = calls()[-1]
check("as `names register alice --owner Public/<account> --term 1y --wait`",
      c["args"] == ["register", "alice", "--owner", "Public/" + FAKE.ACCOUNT, "--term", "1y", "--wait"], c)
check("with the register gas limit written first", c["gas"] == 250000, c)
check("its calls reached the sequencer through the forwarder",
      [b["method"] for b in seen if b["method"] not in ("getAccountBalance", "getFeeState")] == ["getLastBlockId", "sendTransaction", "sendTransaction"], seen)
check("only a known progress line is shown", d["job"]["progress"] == "alice is registered", d["job"])
check("nothing of the noise is in the reply", FAKE.FAKE_PHRASE not in json.dumps(d) and "Private/" not in json.dumps(d))
check("a second name is refused", call("/api/wallet/lns/register", {"name": "bob"}, session=s)[0] == 409)

# ---- entries ---------------------------------------------------------------------------------------------------
for bad in ({"entry": "avatar"}, {"entry": "BLOCKCHAIN"}, {}, {"entry": ["msg"]}):
    check("an entry other than blockchain/msg is refused (%s)" % bad, call("/api/wallet/lns/text", bad, session=s)[0] == 400)
code, d = call("/api/wallet/lns/text", {"entry": "blockchain", "value": "ff" * 32}, session=s)
check("blockchain starts", code == 200, (code, d))
d = wait_job(s)
c = calls()[-1]
check("as `names set-text alice blockchain <this wallet's Main>`, whatever value the page sent",
      c["args"] == ["set-text", "alice", "blockchain", MAIN], c)
check("with the entry gas limit", c["gas"] == 120000 and d["job"]["state"] == "done" and d["job"]["entry"] == "blockchain", (c, d))
code, d = call("/api/wallet/lns/text", {"entry": "msg"}, session=s)
check("msg without a messaging address: refused", code == 409 and "messages" in d["error"], (code, d))
secret = "11" * 32
public = server.x25519(bytes.fromhex(secret), (9).to_bytes(32, "little")).hex()
server.msg_key_save({"secret": secret, "public": public, "name": "", "version": 1, "groups": False}, quiet=True)
code, d = call("/api/wallet/lns/text", {"entry": "msg"}, session=s)
d = wait_job(s)
check("msg is set to this phone's messaging address",
      calls()[-1]["args"] == ["set-text", "alice", "msg", public] and d["job"]["state"] == "done", (calls()[-1], d))
check("the page is offered both values now", d["values"] == {"blockchain": MAIN, "msg": public}, d["values"])

# ---- failures and one job at a time ------------------------------------------------------------------------------
check("unlinking the name", call("/api/wallet/lns/name", {"name": ""}, session=s)[1] == {"name": ""})
call("/api/wallet/lns/register", {"name": "taken"}, session=s)
d = wait_job(s)
check("a refused registration says why, as the app's own text", d["job"]["state"] == "failed" and d["job"]["error"] == "taken is already registered", d["job"])
check("and the name stays unset", d["name"] == "", d)
check("and a failed registration no longer holds LEZ back from Send (reg_pending cleared)", "reg_pending" not in server.lns_state() and d["reg_pending"] == "", d.get("reg_pending"))
call("/api/wallet/lns/register", {"name": "leaky"}, session=s)
d = wait_job(s)
check("an error that isn't a known one shows only the app's fixed text",
      d["job"]["state"] == "failed" and d["job"]["error"] == server.LNS_ERROR_OTHER, d["job"])
check("register slow starts", call("/api/wallet/lns/register", {"name": "slow"}, session=s)[0] == 200)
check("while it runs, another change is refused", call("/api/wallet/lns/register", {"name": "slow2"}, session=s)[0] == 409)
check("and linking a name too", call("/api/wallet/lns/name", {"name": "alice"}, session=s)[0] == 409)
check("and making an account", call("/api/wallet/lns/account", {}, session=s)[0] == 409)
time.sleep(0.5)
d = call("/api/wallet/lns", session=s)[1]
check("the running job shows", d["job"]["state"] == "running", d["job"])
check("a progress line carrying the forwarder's address shows as fixed text, without it",
      d["job"]["progress"] == "the second step didn't land yet; trying again" and server.LNS_RPC_SECRET not in json.dumps(d), d["job"])
d = wait_job(s)
check("slow is registered", d["name"] == "slow" and d["job"]["state"] == "done", d)

# ---- a job killed while the wallet file is rewritten: the snapshot puts it back -------------------------------------
call("/api/wallet/lns/name", {"name": ""}, session=s)
with open(os.path.join(server.LNS_HOME, "storage.json")) as f:
    before_kill = f.read()
call("/api/wallet/lns/register", {"name": "killed"}, session=s)
d = wait_job(s)
with open(os.path.join(server.LNS_HOME, "storage.json")) as f:
    after_kill = f.read()
check("a job killed mid-write leaves the wallet file as it was before the job", after_kill == before_kill, after_kill[:60])
check("and says so", d["job"]["state"] == "failed" and "put back" in d["job"]["error"], d["job"])
check("the snapshot is owner-only", mode(os.path.join(server.LNS_HOME, "storage.json.prev")) == 0o600)
with open(os.path.join(server.LNS_HOME, "storage.json"), "w") as f:
    f.write("{trunc")                                  # as if the app itself had been killed during a job
check("a wallet file found broken later is put back too", server.lns_repair() == ["storage.json"]
      and open(os.path.join(server.LNS_HOME, "storage.json")).read() == before_kill)
check("linking a name held from elsewhere (after a transfer)",
      call("/api/wallet/lns/name", {"name": "android"}, session=s)[1] == {"name": "android"})
call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)
wait_job(s)
check("entries then go to that name", calls()[-1]["args"] == ["set-text", "android", "blockchain", MAIN], calls()[-1])

# ---- the forwarder ---------------------------------------------------------------------------------------------
import urllib.request, urllib.error  # noqa: E402


def post_rpc(path, body, host=None):
    req = urllib.request.Request(W.BASE + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    if host:
        req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


good = "/lez-rpc/" + server.LNS_RPC_SECRET
ok_call = {"jsonrpc": "2.0", "id": 3, "method": "getLastBlockId", "params": []}
check("a method that isn't a string: a clean 403", post_rpc(good, dict(ok_call, method=["getLastBlockId"]))[0] == 403
      and post_rpc(good, dict(ok_call, method={"a": 1}))[0] == 403 and post_rpc(good, [ok_call, 5])[0] == 403)
check("the forwarder passes a read for the signer", post_rpc(good, ok_call) == (200, {"jsonrpc": "2.0", "id": 3, "result": 7}))
check("and a batch", post_rpc(good, [ok_call, dict(ok_call, id=4)]) == (200, [{"jsonrpc": "2.0", "id": 3, "result": 7}, {"jsonrpc": "2.0", "id": 4, "result": 7}]))
check("without the secret: 404", post_rpc("/lez-rpc/" + "0" * 32, ok_call)[0] == 404 and post_rpc("/lez-rpc/", ok_call)[0] == 404)
check("under another Host name: 404", post_rpc(good, ok_call, host="rebind.example:8099")[0] == 404)
check("a method it doesn't pass: 403", post_rpc(good, dict(ok_call, method="requeueCrossZoneDeadLetter"))[0] == 403)
check("a batch with one such method: 403", post_rpc(good, [ok_call, dict(ok_call, method="getCrossZoneDeadLetters")])[0] == 403)
server.NAMES_BIN = ""
check("without the signer the forwarder is 404", post_rpc(good, ok_call)[0] == 404)
server.NAMES_BIN = fake_names

# ---- the encrypted backup carries the name account, and restore puts it back ------------------------------------
code, d = call("/api/wallet/backup", {"password": PASSWORD, "pin": PIN}, session=s)
check("backup made", code == 200, (code, d))
doc = d["backup"]
check("after a backup no backup is asked for", call("/api/wallet/lns", session=s)[1]["backup_needed"] is False)
check("the backup file has no wallet file or phrase in the clear", "lns" not in json.dumps({k: v for k, v in doc.items() if k != "ciphertext"})
      and FAKE.FAKE_PHRASE not in json.dumps(doc))
kdf = doc["kdf"]
plain = server.aead_decrypt(server.backup_key(PASSWORD, base64.b64decode(kdf["salt"]), {k: kdf[k] for k in ("n", "r", "p", "dklen")}),
                            base64.b64decode(doc["cipher"]["nonce"]), base64.b64decode(doc["ciphertext"]), server.BACKUP_AADS[doc["version"]])
content = json.loads(plain)
with open(os.path.join(server.LNS_HOME, "storage.json")) as f:
    stored = f.read()
lw = content.get("lns_wallet") or {}
check("inside it: the wallet file, names.json slot, account and name", lw.get("storage") == stored and lw.get("account") == FAKE.ACCOUNT
      and lw.get("name") == "android" and "names" in lw, lw.keys())
shutil.rmtree(server.LNS_HOME)
os.remove(server.LNS_STATE_FILE)
check("with the wallet gone the account is gone", call("/api/wallet/lns", session=s)[1]["account"] is None)
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN}, session=s)
check("restore puts the name account back, and says so", code == 200 and d.get("lns_restored") is True and d.get("lns") == "added"
      and "is on this phone now" in d.get("lns_message", ""), (code, d))
with open(os.path.join(server.LNS_HOME, "storage.json")) as f:
    check("the same wallet file", f.read() == stored)
d = call("/api/wallet/lns", session=s)[1]
check("the same account and name", d["account"] == FAKE.ACCOUNT and d["name"] == "android", d)
check("restored files are 0600 in a 0700 folder", mode(server.LNS_HOME) == 0o700
      and all(mode(os.path.join(server.LNS_HOME, f)) == 0o600 for f in os.listdir(server.LNS_HOME) if os.path.isfile(os.path.join(server.LNS_HOME, f))))
check("the restored wallet has no config yet (a backup doesn't carry it)", not os.path.exists(os.path.join(server.LNS_HOME, "wallet_config.json")))
call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)
d = wait_job(s)
last_set = [c for c in calls() if c["args"][:1] == ["set-text"]][-1]
check("an entry can be set right after a restore onto a clean phone", d["job"]["state"] == "done"
      and last_set["args"] == ["set-text", "android", "blockchain", MAIN] and last_set["gas"] == 120000, (d["job"], last_set))
n_set = len([c for c in calls() if c["args"][:1] == ["set-text"]])
code, d = call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)
check("an entry the name service already has is refused before anything is sent", code == 409 and d.get("already") is True
      and d["error"] == "Already points here." and len([c for c in calls() if c["args"][:1] == ["set-text"]]) == n_set, d)
for _ in range(100):
    e = call("/api/wallet/lns", session=s)[1].get("entries")
    if e and e["blockchain"] == "here":
        break
    time.sleep(0.1)
check("and the page is told it points here (msg not set: none)", e == {"blockchain": "here", "msg": "none"}, e)
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN}, session=s)
check("restoring the same name account again: same", code == 200 and d.get("lns") == "same" and d.get("lns_restored") is False, d)
OTHER = "7Np41oeYWUBWLBaPF1zUkyBz9d7jEyhEtqGePQSRUmTy"
other_wallet = json.dumps({"seed": "e" * 128, "public": {OTHER: "0" * 64}})
with open(os.path.join(server.LNS_HOME, "storage.json"), "w") as f:
    f.write(other_wallet)
server.lns_state_save(account=OTHER, name="otherone")
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN}, session=s)
check("a backup with a different name account doesn't replace the one here unasked", code == 200 and d.get("lns") == "kept"
      and d.get("lns_restored") is False and "different name account" in d.get("lns_message", ""), d)
check("and nothing about the one here changed", open(os.path.join(server.LNS_HOME, "storage.json")).read() == other_wallet
      and call("/api/wallet/lns", session=s)[1]["account"] == OTHER
      and not [f for f in os.listdir(server.LNS_HOME) if ".replaced-" in f])
with open(os.path.join(data, "wallet-events.log")) as f:
    check("the event log says what happened, not 'refused'", 'restore applied to the keys already in use detail="same keys, lns kept"' in f.read())
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN, "replace_name_account": True}, session=s)
kept = [f for f in os.listdir(server.LNS_HOME) if f.startswith("storage.json.replaced-")]
check("asked to replace it: replaced, and the one that was here is kept beside it", code == 200 and d.get("lns") == "replaced"
      and "no longer in new backups" in d.get("lns_message", "") and len(kept) == 1, (d, kept))
with open(os.path.join(server.LNS_HOME, kept[0])) as f:
    check("unchanged", f.read() == other_wallet)
check("the backup's account and name are in use", call("/api/wallet/lns", session=s)[1]["account"] == FAKE.ACCOUNT)
for _ in range(2):                                     # two replacing restores within the same second: no clash
    with open(os.path.join(server.LNS_HOME, "storage.json"), "w") as f:
        f.write(other_wallet)
    server.lns_state_save(account=OTHER)
    code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN, "replace_name_account": True}, session=s)
    check("a replacing restore answers (twice in a row)", code == 200 and d.get("lns") == "replaced", (code, d))


def sealed_with(lns_wallet):
    """`doc` with its name account part changed, encrypted again."""
    inner = json.loads(json.dumps(content))
    inner["lns_wallet"] = lns_wallet
    out = json.loads(json.dumps(doc))
    nonce = os.urandom(12)
    out["cipher"]["nonce"] = base64.b64encode(nonce).decode()
    out["ciphertext"] = base64.b64encode(server.aead_encrypt(server.backup_key(PASSWORD, base64.b64decode(kdf["salt"])), nonce,
                                                             json.dumps(inner).encode(), server.BACKUP_AADS[doc["version"]])).decode()
    return out


lw0 = content["lns_wallet"]
for label, change in (("a name ending in a newline", {"name": "android\n"}), ("an account ending in a newline", {"account": FAKE.ACCOUNT + "\n"})):
    code, d = call("/api/wallet/restore", {"backup": sealed_with(dict(lw0, **change)), "password": PASSWORD, "pin": PIN}, session=s)
    check("a backup with %s is refused as damaged" % label, code == 400 and "damaged" in d.get("error", ""), (code, d))
shutil.rmtree(server.LNS_HOME)
os.remove(server.LNS_STATE_FILE)
code, d = call("/api/wallet/restore", {"backup": sealed_with(dict(lw0, account=OTHER)), "password": PASSWORD, "pin": PIN}, session=s)
check("a backup whose account isn't in its own wallet file: not restored, and it says so", code == 200 and d.get("lns") == "unchecked"
      and not os.path.exists(os.path.join(server.LNS_HOME, "storage.json")), d)
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN}, session=s)
check("the good backup still puts it back", d.get("lns") == "added", d)
call("/api/wallet/lns/name", {"name": ""}, session=s)
call("/api/wallet/lns/register", {"name": "slow"}, session=s)
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN, "replace_name_account": True}, session=s)
check("a restore while a change runs tells the person to restore again later", code == 200 and d.get("lns") == "busy"
      and "Restore again" in d.get("lns_message", ""), d)
wait_job(s)
call("/api/wallet/lns/name", {"name": "fresh"}, session=s)
check("after linking a name, a backup is asked for again", call("/api/wallet/lns", session=s)[1]["backup_needed"] is True)
bad_doc = json.loads(json.dumps(doc))
content["lns_wallet"] = {"storage": "not json", "account": FAKE.ACCOUNT}
nonce = os.urandom(12)
bad_doc["cipher"]["nonce"] = base64.b64encode(nonce).decode()
bad_doc["ciphertext"] = base64.b64encode(server.aead_encrypt(
    server.backup_key(PASSWORD, base64.b64decode(kdf["salt"])), nonce, json.dumps(content).encode(), server.BACKUP_AADS[doc["version"]])).decode()
code, d = call("/api/wallet/restore", {"backup": bad_doc, "password": PASSWORD, "pin": PIN}, session=s)
check("a backup with a damaged name account is refused as a whole", code == 400 and "damaged" in d.get("error", ""), (code, d))

state_before = open(server.LNS_STATE_FILE).read()
with open(server.LNS_STATE_FILE, "w") as f:
    json.dump({"name": "android"}, f)                  # a wallet file but no account recorded (a failed creation)
code, d = call("/api/wallet/backup", {"password": PASSWORD, "pin": PIN}, session=s)
kdf2 = d["backup"]["kdf"]
inner = json.loads(server.aead_decrypt(server.backup_key(PASSWORD, base64.b64decode(kdf2["salt"])), base64.b64decode(d["backup"]["cipher"]["nonce"]),
                                       base64.b64decode(d["backup"]["ciphertext"]), server.BACKUP_AADS[d["backup"]["version"]]))
check("a wallet file with no account in the state is backed up under the account the signer finds in it",
      code == 200 and inner.get("lns_wallet", {}).get("account") == FAKE.ACCOUNT and inner["lns_wallet"]["name"] == "", inner.keys())
code, r = call("/api/wallet/restore", {"backup": d["backup"], "password": PASSWORD, "pin": PIN}, session=s)
check("and that backup still restores", code == 200, (code, r))
with open(server.LNS_STATE_FILE, "w") as f:
    f.write(state_before)

# ---- second review: no backup during a change, restores by account, a stop part way, snapshots, the lock -------
storage_p = os.path.join(server.LNS_HOME, "storage.json")
names_p = os.path.join(server.LNS_HOME, "names.json")
read = lambda p: open(p).read()


def set_other(names=None):
    """This phone holds the other account OTHER (its own wallet file and state), as after using another backup."""
    for f in os.listdir(server.LNS_HOME):
        if f.endswith(".prev"):
            os.remove(os.path.join(server.LNS_HOME, f))
    with open(storage_p, "w") as f:
        f.write(other_wallet)
    if names is not None:
        with open(names_p, "w") as f:
            f.write(names)
    server.lns_state_save(account=OTHER, name="otherone", restoring=None)


# 1. a backup while a change runs is refused: the signer may be rewriting the files
server.lns_state_save(name="")
check("register slow starts (for the backup test)", call("/api/wallet/lns/register", {"name": "slow"}, session=s)[0] == 200)
code, d = call("/api/wallet/backup", {"password": PASSWORD, "pin": PIN}, session=s)
check("a backup while a change to the name account runs is refused, and says to wait",
      code == 409 and d.get("lns_busy") is True and "has finished" in d.get("error", ""), (code, d))
wait_job(s)
code, d = call("/api/wallet/backup", {"password": PASSWORD, "pin": PIN}, session=s)
check("once it has finished the backup works", code == 200, (code, d))
doc_old = d["backup"]

# 2. an older backup of this same account: same account, this phone's newer files are kept, never replaced
server.lns_state_save(name="")
call("/api/wallet/lns/register", {"name": "newer"}, session=s)
wait_job(s)
newer_storage, newer_names = read(storage_p), (read(names_p) if os.path.exists(names_p) else None)
check("registering changed the wallet file since that backup", "receiving-newer" in newer_storage)
for flag in (False, True):
    code, d = call("/api/wallet/restore", {"backup": doc_old, "password": PASSWORD, "pin": PIN, "replace_name_account": flag}, session=s)
    check("an older backup of the same account is 'same', not a different account (replace %s)" % flag,
          code == 200 and d.get("lns") == "same" and "newer one" in d.get("lns_message", "") and FAKE.ACCOUNT in d["lns_message"], d)
    check("and the phone's newer files and name stay (replace %s)" % flag, read(storage_p) == newer_storage
          and call("/api/wallet/lns", session=s)[1]["name"] == "newer")

# 3. a stop between saving the state and swapping the files: the state ends up naming what is in the file
set_other()
real_write = server.lns_write


def failing_write(path, data):
    if path == server.lns_storage():
        raise OSError("no space left")
    return real_write(path, data)


server.lns_write = failing_write
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN, "replace_name_account": True}, session=s)
server.lns_write = real_write
check("a restore that fails part way still answers, and says so", code == 200 and d.get("lns") == "failed", (code, d))
st = server.lns_state()
check("and the state names the account really in the file", st["account"] == OTHER and st["name"] == "otherone"
      and "restoring" not in st and read(storage_p) == other_wallet, st)
server.lns_state_save(account=FAKE.ACCOUNT, name="android", restoring={"account": OTHER, "name": "otherone"})
server.lns_reconcile()                                  # as at the next start, after a stop in that window
st = server.lns_state()
check("a restore stopped in that window is undone at start", st["account"] == OTHER and st["name"] == "otherone" and "restoring" not in st, st)

# 4. a snapshot of another account is never put in place; a missing file is never filled in
mine_wallet = json.dumps({"seed": "f" * 128, "public": {FAKE.ACCOUNT: "0" * 64}})
with open(storage_p + ".prev", "w") as f:
    f.write(mine_wallet)                                # the copy is of FAKE.ACCOUNT, the state says OTHER
with open(storage_p, "w") as f:
    f.write("{trunc")
check("a broken file is not replaced by another account's copy", server.lns_repair() == [] and read(storage_p) == "{trunc")
d = call("/api/wallet/lns", session=s)[1]
check("and the page is told", any("another account" in n for n in d.get("notes", [])), d.get("notes"))
set_other()
with open(storage_p + ".prev", "w") as f:
    f.write(other_wallet)
os.remove(storage_p)
check("a missing wallet file is not filled in from a copy", server.lns_repair() == [] and not os.path.exists(storage_p))
d = call("/api/wallet/lns", session=s)[1]
check("and the page is told a saved copy is there to put back", any("saved copy" in n for n in d.get("notes", [])) and d["saved_copy"] is True, d.get("notes"))
os.remove(storage_p + ".prev")
d = call("/api/wallet/lns", session=s)[1]
check("with no copy either, it is told it is missing", any("missing" in n for n in d.get("notes", [])), d.get("notes"))
with open(storage_p, "w") as f:
    f.write(other_wallet)

# 5. replacing with a backup that has no names.json moves the one here aside too
set_other(names='{"pending": {"carol": {"owner": "x"}}}')
code, d = call("/api/wallet/restore", {"backup": sealed_with(dict(lw0, names=None)), "password": PASSWORD, "pin": PIN,
                                       "replace_name_account": True}, session=s)
aside = [f for f in os.listdir(server.LNS_HOME) if f.startswith("names.json.replaced-")]
check("replaced", code == 200 and d.get("lns") == "replaced", d)
check("the other account's names.json is kept aside, and the live one is empty", read(names_p) == "{}"
      and any("carol" in read(os.path.join(server.LNS_HOME, f)) for f in aside), aside)
check("the snapshots are of the new account now", FAKE.ACCOUNT in read(storage_p + ".prev"))

# ---- third review ---------------------------------------------------------------------------------------------------
down = os.path.join(data, "fake-signer-down")
cfg_p = os.path.join(server.LNS_HOME, "wallet_config.json")


def prevs_aside():
    return [f for f in os.listdir(server.LNS_HOME) if ".prev.replaced-" in f]


# 1. the key only in the saved copy: nothing overwrites or sets it aside; it can be put back
set_other()
with open(storage_p + ".prev", "w") as f:
    f.write(other_wallet)
os.remove(storage_p)
before_aside = prevs_aside()
for flag in (False, True):
    code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN, "replace_name_account": flag}, session=s)
    check("R3-1: a restore while the key is only in the saved copy changes nothing, and says to put it back (replace %s)" % flag,
          code == 200 and d.get("lns") == "unchecked" and "saved copy" in d.get("lns_message", "")
          and read(storage_p + ".prev") == other_wallet and not os.path.exists(storage_p) and prevs_aside() == before_aside, d)
os.remove(server.LNS_STATE_FILE)
code, d = call("/api/wallet/lns/account", {}, session=s)
check("R3-1: Make a name account refuses too (no new wallet over the copy)", code == 409 and d.get("saved_copy") is True
      and not os.path.exists(storage_p), (code, d))
check("R3-1: a change refuses too", server.lns_start("text", lambda st: (200, (["set-text"], "x", "", lambda: None)))[0] in (409,))
code, d = call("/api/wallet/lns/putback", {}, session=s)
check("R3-1: Put back the saved copy: the copy is the live file again, the account named", code == 200 and d["account"] == OTHER
      and read(storage_p) == other_wallet and server.lns_state()["account"] == OTHER, (code, d))
with open(storage_p, "w") as f:
    f.write("{trunc")
os.remove(server.LNS_STATE_FILE)
check("R3-1: a broken file with the state lost is put back from a copy the signer reads", server.lns_repair() == ["storage.json"]
      and read(storage_p) == other_wallet and server.lns_state()["account"] == OTHER)
with open(storage_p, "w") as f:
    f.write("{trunc")
open(down, "w").close()
check("R3-1: when the signer can't check the copy, nothing is put back and the note doesn't say 'another account'",
      server.lns_repair() == [] and read(storage_p) == "{trunc"
      and any("couldn't be checked" in n for n in call("/api/wallet/lns", session=s)[1]["notes"]))
os.remove(down)
with open(storage_p, "w") as f:
    f.write(other_wallet)

# 2. a backup when the signer fails still carries the name account, marked; a torn config is written anew
set_other()
open(down, "w").close()
code, d = call("/api/wallet/backup", {"password": PASSWORD, "pin": PIN}, session=s)
inner = json.loads(server.aead_decrypt(server.backup_key(PASSWORD, base64.b64decode(d["backup"]["kdf"]["salt"])),
                                       base64.b64decode(d["backup"]["cipher"]["nonce"]), base64.b64decode(d["backup"]["ciphertext"]),
                                       server.BACKUP_AADS[d["backup"]["version"]]))
check("R3-2: with the signer failing, the backup still holds the name account, under the state's account, marked unconfirmed",
      code == 200 and d.get("lns") == "unconfirmed" and inner["lns_wallet"]["account"] == OTHER and inner["lns_wallet"].get("unconfirmed") is True
      and inner["lns_wallet"]["storage"] == other_wallet, d.get("lns"))
check("R3-2: and a backup is still asked for", call("/api/wallet/lns", session=s)[1]["backup_needed"] is True)
os.remove(down)
with open(cfg_p, "w") as f:
    f.write('{"gas_limit": 12')
check("R3-2: a torn wallet config fails the signer's listing", server.lns_accounts_in(server.LNS_HOME) is None)
server.lns_repair()
check("R3-2: repair writes it anew (it holds no key), and the listing works again", server.lns_accounts_in(server.LNS_HOME) == [OTHER])
code, d = call("/api/wallet/backup", {"password": PASSWORD, "pin": PIN}, session=s)
check("R3-2: and the backup is confirmed again", code == 200 and d.get("lns") == "included", d.get("lns"))

# 3. the signer failing on the phone's own file is never "a different account", and never offers Replace
open(down, "w").close()
for flag in (False, True):
    code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN, "replace_name_account": flag}, session=s)
    check("R3-3: signer failing: 'couldn't read this phone's name account', nothing changed (replace %s)" % flag,
          code == 200 and d.get("lns") == "unchecked" and "Couldn't read this phone's name account" in d.get("lns_message", "")
          and read(storage_p) == other_wallet and server.lns_state()["account"] == OTHER, d)

# 4. reconcile changes nothing on a failing signer; the marker names what was in the file
server.lns_state_save(account=FAKE.ACCOUNT, name="x", restoring={"account": None, "name": ""})
server.lns_reconcile()
st = server.lns_state()
check("R3-4: with the signer failing, reconcile changes nothing (the state isn't wiped)", st["account"] == FAKE.ACCOUNT and "restoring" in st, st)
os.remove(down)
server.lns_reconcile()
check("R3-4: with it working, the state names the account in the file, and nothing is wiped",
      server.lns_state()["account"] == FAKE.ACCOUNT or server.lns_state()["account"] == OTHER)
set_other()
server.lns_state_save(account=FAKE.ACCOUNT, name="")          # the state wrong: the file holds OTHER
server.lns_write = failing_write
code, d = call("/api/wallet/restore", {"backup": doc, "password": PASSWORD, "pin": PIN, "replace_name_account": True}, session=s)
server.lns_write = real_write
check("R3-4: the marker named the account really in the file, so a failed replace ends naming it",
      d.get("lns") in ("failed", "same") and server.lns_state()["account"] in (OTHER, FAKE.ACCOUNT) and "restoring" not in server.lns_state(), (d, server.lns_state()))

# 5. a stop between the two swaps: told, and the same backup finishes it
set_other(names='{"pending": {"carol": {}}}')
doc_dave = sealed_with(dict(lw0, names='{"pending": {"dave": {"owner": "y"}}}'))


def failing_names(path, data):
    if path == names_p:
        raise OSError("no space left")
    return real_write(path, data)


server.lns_write = failing_names
code, d = call("/api/wallet/restore", {"backup": doc_dave, "password": PASSWORD, "pin": PIN, "replace_name_account": True}, session=s)
server.lns_write = real_write
st = server.lns_state()
check("R3-5: stopped between the swaps: the account is the backup's, its names.json is marked as still to come",
      d.get("lns") == "failed" and st["account"] == FAKE.ACCOUNT and st.get("names_pending") and "dave" not in read(names_p), (d, st))
code, d = call("/api/wallet/restore", {"backup": doc_dave, "password": PASSWORD, "pin": PIN}, session=s)
check("R3-5: restoring the same backup again puts its names.json in place", d.get("lns") == "same" and "dave" in read(names_p)
      and "names_pending" not in server.lns_state(), d)

# 6. the account this app made (/0) is picked, not the first listed
with open(storage_p, "w") as f:
    json.dump({"seed": "f" * 128, "root": OTHER, "public": {FAKE.ACCOUNT: "0" * 64}}, f)
for p_ in os.listdir(server.LNS_HOME):
    if p_.endswith(".prev"):
        os.remove(os.path.join(server.LNS_HOME, p_))
os.remove(server.LNS_STATE_FILE)
code, d = call("/api/wallet/lns/account", {}, session=s)
check("R3-6: with the state lost, the /0 account is taken, not the root one listed first", code == 200 and d["account"] == FAKE.ACCOUNT, d)

# 7. small ones
with open(storage_p, "w") as f:
    f.write("{trunc")
check("R3-7: no change starts on an unreadable wallet file", server.lns_start("text", lambda st: (200, (["set-text"], "x", "", lambda: None)))[0] == 409)
with open(storage_p, "w") as f:
    json.dump({"seed": "f" * 128, "public": {FAKE.ACCOUNT: "0" * 64}}, f)
open(os.path.join(server.LNS_HOME, "storage.json.tmp"), "w").close()
server.lns_sweep()
check("R3-7: half-written .tmp files are removed at start", not os.path.exists(os.path.join(server.LNS_HOME, "storage.json.tmp")))
server.lns_state_save(account=FAKE.ACCOUNT, name="android", restoring=None)

# 8. register and set-text read the state inside the lock
seen_locked, real_state = [], server.lns_state


def recording_state():
    seen_locked.append(server.lns_change.locked())
    return real_state()


server.lns_state_save(name="android")
server.lns_state = recording_state
code1, _ = server.lns_register({"name": "zz9"})
server.lns_state = real_state
reg_seen = list(seen_locked)
server.lns_state_save(name="")
del seen_locked[:]
server.lns_state = recording_state
code2, _ = server.lns_text({"entry": "blockchain"})
server.lns_state = real_state
# set-text reads the name once before the lock, only to ask the name service (which can take minutes, so never
# under the lock); everything it decides on is read again with the lock held
check("register reads the state only with the lock held; set-text decides only on a read under the lock",
      code1 == 409 and code2 == 409 and reg_seen and all(reg_seen) and seen_locked[0] is False and seen_locked[1:] and all(seen_locked[1:]),
      (reg_seen, seen_locked))
server.lns_state_save(name="android")

# 7. check folders left by a stop are swept at start
os.makedirs(os.path.join(data, ".lns-check-left"))
server.lns_sweep()
check("leftover check folders are removed", not os.path.exists(os.path.join(data, ".lns-check-left")))

# ---- logs ------------------------------------------------------------------------------------------------------------
with open(os.path.join(data, "wallet-events.log")) as f:
    log = f.read()
check("the event log records the account and the jobs", "lns account made" in log and "lns register done" in log
      and "lns wallet file put back from its snapshot" in log
      and "lns register failed" in log and "lns text done" in log, log[-600:])
check("and no secret path of the forwarder", server.LNS_RPC_SECRET not in log)
os.remove(calls_file)                      # the fake signer's own record holds the forwarder's secret path; not the app's
phrase_nowhere("at the end")

# ---- locking stops it ----------------------------------------------------------------------------------------------
call("/api/wallet/lock", {}, session=s)
check("after Lock, entries are refused", call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)[0] == 401)
print("all checks passed")

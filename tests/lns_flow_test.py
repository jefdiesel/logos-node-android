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
LEZ = {"balance": 0, "drain": 0}


class Seq(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        m = body.get("method")
        if m == "sendTransaction":
            LEZ["nonce"] = LEZ.get("nonce", 0) + 1
            LEZ["balance"] -= LEZ["drain"]               # what each change costs, for the spend brake
        r = {"jsonrpc": "2.0", "id": body.get("id"),
             "result": {"getAccountsNonces": [LEZ.get("nonce", 0)], "getAccountBalance": LEZ["balance"], "getLastBlockId": 7, "sendTransaction": "cd" * 32,
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
                  LNS_FLOW_POLL="0.2", LNS_FLOW_PAUSES="0.5,0.5,0.5,0.5", LNS_FLOW_GAP="0.3", LNS_FLOW_RESOLVE_EVERY="0.05,0.2")
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


def poke(**kw):
    """Changes the flow's file as a test, and drops the pause this process holds (as a restart would)."""
    server.lns_flow_save(dict(server.lns_flow_load(), **kw))
    server.lns_flow_mem["next_mono"] = 0.0


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
    poke(**dict(step=step, job=None, tries=0, next_at=0))
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
time.sleep(2)
check("S-7: Messages turned on later: nothing is signed by itself (it waits for a tap)", "msg" not in chain()["bob"] and flow().get("msg_later") is True)
code, d = call("/api/wallet/lns/get", {"name": "bob", "mode": "link"}, session=s)
until("one tap (Finish setting up): the msg entry", lambda: chain()["bob"].get("msg") == public and flow().get("step") == "done", tries=300)

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

# ---- a register that fails once on a passing error is sent again, and the flow finishes ----
server.lns_state_save(name="")
os.path.exists(server.LNS_FLOW_FILE) and os.remove(server.LNS_FLOW_FILE)
open(os.path.join(data, "fake-register-fail-once"), "w").close()
n_reg = len(sends("register"))
code, d = call("/api/wallet/lns/get", {"name": "gina"}, session=s)
until("a register that failed once is sent again after the pause, and it finishes", lambda: flow().get("step") == "done", tries=300)
check("two registers for gina, then both entries", [x[1] for x in sends("register")[n_reg:]] == ["gina", "gina"]
      and chain()["gina"].get("blockchain") == MAIN, sends("register")[n_reg:])
server.lns_state_save(name="")
os.remove(server.LNS_FLOW_FILE)

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
poke(**dict(step="blockchain", next_at=time.time() + 60))
outcome, msg = server.lns_restore({"storage": "{}", "account": FAKE.ACCOUNT}, True)
check("a restore while getting a name is between changes: busy, nothing changed", outcome == "busy" and "getting a name" in msg, (outcome, msg))
# ---- M-1: a slow start never makes a failed change look like someone else's: it is counted, and not re-sent ----
poke(**dict(step="done"))
os.remove(server.LNS_FLOW_FILE)
server.lns_state_save(name="")
LEZ["balance"] = 20000000
always = os.path.join(data, "fake-settext-fail-always")
open(always, "w").close()
real_snapshot = server.lns_snapshot
server.lns_snapshot = lambda: (time.sleep(1.5), real_snapshot())[1]        # a start that takes over a second
n_set = len(sends("set-text"))
code, d = call("/api/wallet/lns/get", {"name": "hank"}, session=s)
until("an entry that keeps failing stops the flow", lambda: flow().get("step") == "failed", tries=400)
time.sleep(3)
hank = [x for x in sends("set-text") if x[1] == "hank"]
check("M-1: with a slow start, a failing entry is sent at most 3 times, then it stops (it doesn't loop)", 1 <= len(hank) <= 3, len(hank))
server.lns_snapshot = real_snapshot

# ---- the brakes hold even when matching a job to the flow is broken on purpose ----
real_job = server.lns_flow_job
server.lns_flow_job = lambda fl, kind: None                               # every result lost, as M-1 was
os.remove(server.LNS_FLOW_FILE)
server.lns_state_save(name="")
code, d = call("/api/wallet/lns/get", {"name": "ivan"}, session=s)
until("(a) the count of sends stops it", lambda: flow().get("step") == "failed", tries=400)
time.sleep(2)
ivan = [json.loads(l) for l in open(calls_file) if json.loads(l)["args"][:2] == ["set-text", "ivan"]]
check("(a) at most 3 sends of one entry, whatever the matching says, and it says why", len(ivan) <= 3 and "sent 3 times" in flow()["error"], (len(ivan), flow()["error"]))
check("(b) at least the gap between two sends of the flow", all(b["at"] - a["at"] >= server.LNS_FLOW_GAP - 0.05 for a, b in zip(ivan, ivan[1:])), [x["at"] for x in ivan])
server.LNS_FLOW_GAP = 2.0
os.remove(server.LNS_FLOW_FILE)
server.lns_state_save(name="")
code, d = call("/api/wallet/lns/get", {"name": "jane"}, session=s)
until("(b) with a 2 s gap: it still stops", lambda: flow().get("step") == "failed", tries=600)
jane = [json.loads(l) for l in open(calls_file) if json.loads(l)["args"][:2] == ["set-text", "jane"]]
check("(b) two sends of the flow are never closer than the gap, however fast the rounds", len(jane) >= 2 and all(b["at"] - a["at"] >= 1.95 for a, b in zip(jane, jane[1:])), [x["at"] for x in jane])
server.LNS_FLOW_GAP = 0.3
os.remove(always)
os.remove(server.LNS_FLOW_FILE)
server.lns_state_save(name="")
LEZ["balance"] = 20000000
open(os.path.join(data, "fake-register-reveals-fail"), "w").close()       # a commit and four reveals, all billed
LEZ["drain"] = -9000000                                                   # and more LEZ arriving with each: it mustn't hide them
code, d = call("/api/wallet/lns/get", {"name": "kate"}, session=s)
until("(c) the billed brake stops it", lambda: flow().get("step") == "failed", tries=400)
check("(c) after one register run of 5 billed transactions (at most 11.3M at the ceiling), nothing more: counted by the nonce, not the balance",
      ("billed up to" in flow()["error"] or "sent 5 transactions" in flow()["error"]) and len([x for x in sends() if "kate" in x]) == 1, (flow()["error"], [x for x in sends() if "kate" in x]))
os.remove(os.path.join(data, "fake-register-reveals-fail"))
LEZ["drain"] = 0
server.lns_flow_job = real_job
code, d = call("/api/wallet/lns/get/retry", {}, session=s)
check("Try again (the person's own tap) starts the counts over", code == 200 and not server.lns_flow_load().get("sends"))
# ---- S-items (second review) ----
def fresh(name, mode="register", balance=20000000):
    until("no change running", lambda: server.lns_job["state"] != "running")
    for _ in range(50):                       # the one before is stopped the person's way (Stop), not deleted
        if server.lns_flow_load() is None:
            break
        r_ = call("/api/wallet/lns/get/stop", {}, session=s)
        if r_[0] == 200:
            break
        time.sleep(0.1)
    else:
        check("the flow before stops", False, (r_, server.lns_flow_load(), server.lns_job["state"]))
    server.lns_state_save(name="")
    LEZ["balance"] = balance
    code, d = call("/api/wallet/lns/get", {"name": name, "mode": mode}, session=s)
    check("a flow for %s starts" % name, code == 200, d)


def flag(f, on=True):
    p_ = os.path.join(data, f)
    open(p_, "w").close() if on else (os.path.exists(p_) and os.remove(p_))


# S-1: an entry included but not applied (billed) stops at once
flag("fake-settext-billed")
fresh("lena")
until("S-1: billed on chain: it stops", lambda: flow().get("step") == "failed", tries=300)
check("S-1: one send only, and the line says it didn't take", len([x for x in sends("set-text") if x[1] == "lena"]) == 1 and "didn't take effect" in flow()["error"], flow())
flag("fake-settext-billed", False)

# S-2: a commit that went out but whose wait gave up before it was saved: never a second commit
flag("fake-register-lost-commit")
fresh("mona")
until("S-2: it stops instead of committing again", lambda: flow().get("step") == "failed", tries=300)
check("S-2: one register (one commit) only, and it says an earlier commit may have landed",
      len([x for x in sends("register") if x[1] == "mona"]) == 1 and "earlier commit" in flow()["error"], (sends("register")[-3:], flow()))
flag("fake-register-lost-commit", False)

# S-3: a restart while a register runs counts as a send (and resumes, with its commitment saved)
fresh("nina")
until("nina done", lambda: flow().get("step") == "done", tries=300)
fl = server.lns_flow_load()
check("S-3: the register was counted before it was sent", fl["sends"].get("register") == 1, fl.get("sends"))

# S-4 and S-5: the chain can't be read: nothing is sent, the reads back off, then it stops (Stop works meanwhile)
real_waits = server.LNS_FLOW_READ_WAITS
server.LNS_FLOW_READ_WAITS = [0.3, 0.3, 0.3]
c = chain(); c["olga"] = {"_owner": FAKE.ACCOUNT, "blockchain": MAIN}; json.dump(c, open(chain_file, "w"))
flag("fake-resolve-down")
n_set = len(sends("set-text"))
fresh("olga", mode="link")
until("S-4: unreadable: it waits, then stops with Try again", lambda: flow().get("step") == "failed", tries=300)
check("S-5: no entry was sent while the chain couldn't be read", len(sends("set-text")) == n_set, sends("set-text")[n_set:])
resolves = [json.loads(l) for l in open(calls_file) if json.loads(l)["args"] == ["resolve", "olga"]]
check("S-4: a few reads only, spaced out", len(resolves) <= 6, len(resolves))
flag("fake-resolve-down", False)
server.LNS_FLOW_READ_WAITS = real_waits

# S-6: waiting for LEZ: an unknown cost never counts as enough
fresh("pia", balance=100)
until("waiting for LEZ", lambda: flow().get("step") == "fund")
real_need = server.lns_flow_need
server.lns_flow_need = lambda name: None
poke(**dict(started=time.time() - 3 * 3600, elapsed=3 * 3600, next_at=0))
time.sleep(1.5)
check("S-6: with the cost unknown it keeps waiting, nothing is sent", flow().get("step") == "fund" and not [x for x in sends() if "pia" in x])
server.lns_flow_need = real_need

# S-7: the wait for LEZ ends after a day, the whole job after two
poke(**dict(fund_elapsed=25 * 3600, next_at=0))
until("S-7: a day waiting for LEZ: it stops and asks for a new tap", lambda: flow().get("step") == "failed" and "waited a day" in flow()["error"])
fresh("qing", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
poke(**dict(elapsed=49 * 3600, fund_elapsed=0, next_at=0))
until("S-7: two days after the tap it stops", lambda: flow().get("step") == "failed" and "two days" in flow()["error"])

# S-8: the name can't be set by hand while a flow exists; a mismatch stops the flow
code, d = call("/api/wallet/lns/name", {"name": "zed"}, session=s)
check("S-8: setting a name by hand is refused while a flow exists", code == 409, d)
fresh("rosa", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
server.lns_state_save(name="zed")
poke(**dict(step="blockchain", account=server.lns_state()["account"], next_at=0))
until("S-8: the state names another name: the flow stops, nothing sent", lambda: flow().get("step") == "failed" and "changed" in flow()["error"])
check("S-8: no set-text for zed or rosa", not [x for x in sends("set-text") if x[1] in ("zed", "rosa")])

# S-10: a stopped flow isn't replaced by a new tap; Stop works at any step; a clock set back doesn't strand it
code, d = call("/api/wallet/lns/get", {"name": "sara"}, session=s)
check("S-10: a new tap doesn't replace a stopped flow", code == 409 and "Stop it" in d["error"], d)
check("Stop clears it", call("/api/wallet/lns/get/stop", {}, session=s)[0] == 200)
fresh("tara", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
poke(**dict(next_at=time.time() + 10 * 86400))      # as if the clock went back
server.lns_flow_round()
check("S-10: a pause longer than any it sets is dropped (clock set back)", server.lns_flow_load()["next_at"] < time.time() + 3700)
poke(**dict(step="blockchain", next_at=time.time() + 30))
check("Stop works at any step while nothing is being sent", call("/api/wallet/lns/get/stop", {}, session=s)[0] == 200)
# ---- review B2 ----
# S-1: transactions billed are capped too, whatever the per-step counts say
real_caps, real_budget = dict(server.LNS_FLOW_CAPS), server.lns_flow_budget
server.LNS_FLOW_CAPS.update(blockchain=99, msg=99)
server.lns_flow_budget = lambda fl: 10 ** 15
server.lns_flow_job = lambda fl, kind: None
flag("fake-settext-fail-always")
c = chain(); c["uma"] = {"_owner": FAKE.ACCOUNT}; json.dump(c, open(chain_file, "w"))
fresh("uma", mode="link")
until("S-1: the transaction cap stops it", lambda: flow().get("step") == "failed", tries=600)
check("S-1: at most 4 billed transactions for a link (counted by the nonce)", len([x for x in sends("set-text") if x[1] == "uma"]) <= 4
      and "in blocks already" in flow()["error"], (len([x for x in sends("set-text") if x[1] == "uma"]), flow()["error"]))
flag("fake-settext-fail-always", False)
server.LNS_FLOW_CAPS.update(real_caps); server.lns_flow_budget = real_budget; server.lns_flow_job = real_job
# S-1: no fee ceiling known before the first paid send: nothing is sent
real_fees = server.lns_fee_state
server.lns_fee_state = lambda: None
c = chain(); c["vera"] = {"_owner": FAKE.ACCOUNT}; json.dump(c, open(chain_file, "w"))
n = len(sends())
fresh("vera", mode="link")
time.sleep(2)
check("S-1: with the fees unknown before the first paid send, it waits; nothing is sent", len(sends()) == n and flow().get("step") == "blockchain", flow())
server.lns_fee_state = real_fees
until("and goes on once they are known", lambda: flow().get("step") == "done", tries=300)

# S-2: the three stops recover with Try again (an unlocked tap: a fresh start)
fresh("wes", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
poke(**dict(fund_elapsed=25 * 3600))
until("a day waiting: stopped", lambda: flow().get("step") == "failed" and "Try again to start over" in flow()["error"])
LEZ["balance"] = 20000000
check("S-2: Try again after 'waited a day'", call("/api/wallet/lns/get/retry", {}, session=s)[0] == 200)
until("S-2: it goes on and finishes", lambda: flow().get("step") == "done", tries=400)
fresh("xia", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
poke(**dict(elapsed=49 * 3600))
until("two days: stopped", lambda: flow().get("step") == "failed" and "two days" in flow()["error"])
LEZ["balance"] = 20000000
check("S-2: Try again after 'two days'", call("/api/wallet/lns/get/retry", {}, session=s)[0] == 200)
until("S-2: it goes on and finishes", lambda: flow().get("step") == "done", tries=400)
flag("fake-register-lost-commit")
fresh("yan")
until("an earlier commit may have landed: stopped", lambda: flow().get("step") == "failed" and "earlier commit" in flow()["error"], tries=400)
flag("fake-register-lost-commit", False)
check("S-2: Try again after 'an earlier commit may have landed'", call("/api/wallet/lns/get/retry", {}, session=s)[0] == 200)
until("S-2: it sends a new commit and finishes", lambda: flow().get("step") == "done", tries=400)

# S-3: a nonce that can't be read is a counted wait, and Argon2 reads are throttled; the clock can't stretch limits
real_nonce = server.lez_nonce
server.lez_nonce = lambda account: None
server.LNS_FLOW_READ_WAITS = [0.2, 0.2, 0.2]
c = chain(); c["zoe"] = {"_owner": FAKE.ACCOUNT}; json.dump(c, open(chain_file, "w"))
r0 = len([1 for l in open(calls_file) if json.loads(l)["args"] == ["resolve", "zoe"]])
fresh("zoe", mode="link")
until("S-3: a nonce that can't be read: counted waits, then it stops", lambda: flow().get("step") == "failed", tries=300)
server.lez_nonce = real_nonce
server.LNS_FLOW_READ_WAITS = real_waits
fresh("ann", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
poke(**dict(started=time.time() + 10 * 86400, elapsed=49 * 3600))   # clock set back
until("S-3: the 48 h limit holds with the clock set back (time counted on the monotonic clock)", lambda: flow().get("step") == "failed" and "two days" in flow()["error"])
server.lns_flow_mem["resolves"] = 5
server.lns_flow_mem["last_resolve"] = time.monotonic()
check("S-3: after five reads with no step taken, the next waits the longer interval", server.lns_flow_resolve_ok() is False)

# S-4: LEZ Send waits while getting a name runs
fresh("bea", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
code, d = call("/api/wallet/lns/send", {"to": "Public/3oRTrDMCWuSfnbUgUJCa1vqoedtUUi4xWmMdfJ4emVZC", "amount": "5", "confirm": True}, session=s)
check("S-4: LEZ Send is refused while getting a name runs, with one line why", code == 409 and "under way" in d["error"], d)

# S-5: the jobs outlast the wallet's own wait for a block (60 x 30 s)
check("S-5: text, send and register jobs run longer than one transaction's wait", min(server.LNS_TIMEOUT["text"], server.LNS_TIMEOUT["send"]) > 30 * 60
      and server.LNS_TIMEOUT["register"] > 75 * 60)

# S-6: the CLI's own owner and age test for a saved commitment
nj = os.path.join(server.LNS_HOME, "names.json")
now_ms = int(time.time() * 1000)
for label, entry, want in (("this account's, fresh", {"owner": FAKE.ACCOUNT, "secret": "ab" * 32, "made": now_ms}, True),
                           ("another owner's", {"owner": "someoneelse", "secret": "ab" * 32, "made": now_ms}, False),
                           ("more than a day old", {"owner": FAKE.ACCOUNT, "secret": "ab" * 32, "made": now_ms - 25 * 3600 * 1000}, False)):
    json.dump({"pending": {"cat": entry}}, open(nj, "w"))
    check("S-6: a saved commitment counts only as the CLI would resume it: %s -> %s" % (label, want), server.lns_commit_saved("cat") is want)
os.remove(nj)
# S-6: "already" leaves the time of the last real send as it was
fl_ = server.lns_flow_load() or {}
server.lns_flow_save(dict(fl_, name="bea", step="blockchain", last_send_at=12345.0, sends={}, fee_ceil=[9, 9], nonce_start=LEZ.get("nonce", 0), nonce_seen=LEZ.get("nonce", 0), billed=0, mode="link"))
server.lns_flow_mem["last_send_mono"] = -1e9
r = server.lns_flow_start_job(server.lns_flow_load(), "text", lambda arg, job_id=None: (409, {"error": "Already points here.", "already": True}), {"entry": "blockchain"})
check("S-6: an 'already' answer keeps the last real send's time", r == "already" and server.lns_flow_load()["last_send_at"] == 12345.0, server.lns_flow_load().get("last_send_at"))
# ---- review names-next (N-items) ----
R, T = 250000 * 9 + 1500 * 9, 120000 * 9 + 1500 * 9

# N-1: a run that got past its commit isn't followed by another
flag("fake-register-two-reveals")
n_reg = len(sends("register"))
fresh("ned")
until("N-1: after a run of a commit and two billed reveals, it stops (no second run)", lambda: flow().get("step") == "failed", tries=400)
check("N-1: one register run only, and the line says how many it sent", len(sends("register")) == n_reg + 1 and "sent 3 transactions" in flow()["error"], (sends("register")[n_reg:], flow()["error"]))
flag("fake-register-two-reveals", False)
flag("fake-register-commit-only")
fresh("noa")
until("N-1: a run that only landed its commit goes again, and finishes", lambda: flow().get("step") == "done", tries=400)
check("N-1: two register runs for noa", len([x for x in sends("register") if x[1] == "noa"]) == 2)
# the worst case, proven: one run of a commit and four billed reveals, then nothing more
flag("fake-register-reveals-fail")
fresh("odd")
until("worst case: it stops after one full run", lambda: flow().get("step") == "failed", tries=400)
fv = call("/api/wallet/lns", session=s)[1]["flow"]
check("worst case (N-1, N-5): 5 register transactions, billed at most 5 x 2,263,500 = 11,317,500 at ceiling 9; nothing more was sent",
      fv["spent"]["tx"] == 5 and fv["spent"]["billed_max"] == str(5 * R) and len([x for x in sends("register") if x[1] == "odd"]) == 1, fv.get("spent"))
check("N-5: a stopped flow shows the balance change, and the most a new start may cost", fv["spent"]["balance_change"] is not None
      and fv["next_max"] == str(5 * R), fv)
flag("fake-register-reveals-fail", False)

# N-2: each transaction is priced by its own kind
fresh("pam")
until("pam done", lambda: flow().get("step") == "done", tries=400)
check("N-2: a normal flow counts 2 register and 2 entry transactions: 2 x 2,263,500 + 2 x 1,093,500", server.lns_flow_load()["billed"] == 2 * R + 2 * T,
      server.lns_flow_load()["billed"])

# N-3 and N-10: time is counted on the monotonic clock and saved every round; the wall clock plays no part
fresh("quin", balance=0)
until("waiting", lambda: flow().get("step") == "fund")
e0 = server.lns_flow_load().get("elapsed", 0)
time.sleep(3)
check("N-3: 3 s waiting shows as about 3 s on disk", server.lns_flow_load().get("elapsed", 0) - e0 >= 2.5, server.lns_flow_load().get("elapsed"))
poke(started=time.time() - 30 * 86400, fund_since=time.time() - 30 * 86400)          # a clock jumped forward a month
time.sleep(1)
check("N-10: a clock jumped forward doesn't end it (no new commit to pay for)", flow().get("step") == "fund")
check("N-9: a manual entry or register is refused while it runs", call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)[0] == 409
      and call("/api/wallet/lns/register", {"name": "quin"}, session=s)[0] == 409)

# N-4: the time it sat stopped isn't counted after Try again
poke(fund_elapsed=25 * 3600)
until("stopped", lambda: flow().get("step") == "failed")
server.lns_flow_mem["mono"] = time.monotonic() - 49 * 3600              # as if it sat stopped for two days
LEZ["balance"] = 20000000
check("N-4: Try again", call("/api/wallet/lns/get/retry", {}, session=s)[0] == 200)
until("N-4: it goes on (the stopped time wasn't counted) and finishes", lambda: flow().get("step") == "done", tries=400)

# N-6: Stop while a change runs says until when; Stop now only when that is safe
flag("fake-register-slow-commit")
fresh("rae")
until("sending the commit", lambda: server.lns_job["state"] == "running" and server.lns_job["kind"] == "register")
time.sleep(0.5)
code, d = call("/api/wallet/lns/get/stop", {}, session=s)
check("N-6: Stop while the commit is being sent: refused, says until when, and stopping now isn't offered", code == 409 and "can take until" in d["error"] and d["safe_now"] is False, d)
code, d = call("/api/wallet/lns/get/stop", {"now": True}, session=s)
check("N-6: and Stop now is refused then too", code == 409 and server.lns_job["state"] == "running", d)
server.lns_job["proc"].kill()
until("ended", lambda: server.lns_job["state"] != "running")
flag("fake-register-slow-commit", False)
call("/api/wallet/lns/get/stop", {}, session=s)
flag("fake-register-wait")
fresh("sol")
until("waiting between the two steps", lambda: server.lns_flow_stop_safe(), tries=200)
code, d = call("/api/wallet/lns/get/stop", {}, session=s)
check("N-6: during the wait, Stop offers Stop now", code == 409 and d["safe_now"] is True, d)
code, d = call("/api/wallet/lns/get/stop", {"now": True}, session=s)
check("N-6: Stop now ends it: the signer is stopped, the flow is gone", code == 200 and server.lns_flow_load() is None, d)
until("the job has ended", lambda: server.lns_job["state"] != "running")
code, d = call("/api/wallet/backup", {"password": "a long backup password", "pin": PIN}, session=s)
check("N-6: and a backup works again at once", code == 200, (code, d.get("error")))
check("N-6: the commitment is still saved for the next try", server.lns_commit_saved("sol"))
flag("fake-register-wait", False)

# N-10: a tap's own read of the name service is paced
server.lns_state_save(name="pam")
r0 = len([1 for l in open(calls_file) if json.loads(l)["args"] == ["resolve", "pam"]])
for _ in range(3):
    call("/api/wallet/lns/text", {"entry": "blockchain"}, session=s)
r1 = len([1 for l in open(calls_file) if json.loads(l)["args"] == ["resolve", "pam"]])
check("N-10: three taps within a minute read the name service at most once", r1 - r0 <= 1, r1 - r0)
print("all checks passed", flush=True)
os._exit(0)

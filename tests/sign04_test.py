#!/usr/bin/env python3
"""The LEZ 0.4 signer (app/signer04.py): restoring the desktop's accounts from the recovery phrase, sending, NFTs, the
LNS name's free NFT, the faucet, the forwarder; then the same through the app as the Android app runs it.

  python3 tests/sign04_test.py

With the stand-in tool (tests/fake_names04_bin.py) and the stand-in network (tests/fake_chain04.py). Part 1: the pure
parts (the phrase's form, what of the tool's output may be shown, the pacer). Part 2: the signer itself. Part 3: the
app's routes, the forwarder's secret, the claim from Collectibles' read of the name.
"""
import atexit, hashlib, http.server, json, os, re, shutil, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app"))
sys.path.insert(0, HERE)
import signer04  # noqa: E402
import lez04  # noqa: E402
from fake_chain04 import Chain04, name_id  # noqa: E402

FAILS, _tmp = [], []
PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow"   # a public BIP-39 test vector
OTHER = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above"


def mkdtemp():
    d = tempfile.mkdtemp()
    _tmp.append(d)
    return d


atexit.register(lambda: [shutil.rmtree(d, ignore_errors=True) for d in _tmp])


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (" - " + str(detail)[:400] if not ok and detail != "" else ""))
    if not ok:
        FAILS.append(name)


def wait_job(s, secs=20):
    end = time.time() + secs
    while time.time() < end:
        j = s.view()["job"]
        if j["state"] != "running":
            return j
        time.sleep(0.05)
    return s.view()["job"]


def everything_under(d):
    """Every byte of every file under d (to look for the phrase)."""
    out = b""
    for root, _, files in os.walk(d):
        for f in files:
            try:
                out += open(os.path.join(root, f), "rb").read()
            except OSError:
                pass
    return out


# ---- part 1: the pure parts ---------------------------------------------------------------------------------------
check("a 12-word phrase is taken, in its one form", signer04.phrase_ok("  Legal winner\nthank year wave sausage worth useful legal winner thank yellow ".lower()) == PHRASE)
for bad in ("legal winner", " ".join(["legal"] * 25), PHRASE.replace("legal", "Legal", 1), PHRASE + " 12", PHRASE.replace("wave", "wavé"), None, 7, "x" * 500):
    check("refused as a phrase: %r" % (bad if not isinstance(bad, str) else bad[:30]), signer04.phrase_ok(bad) is None)
check("progress: a send's lines become fixed texts",
      [signer04.clean_line(l) for l in (b"Transaction hash is " + b"ab" * 32, b"Transaction is included in block 12")] == ["sent; waiting for a block", "in block 12"])
check("progress: a claim's lines", [signer04.clean_line(l) for l in (b"claiming the deed of alice-long (free): definition 9fPK", b"reading the registry's bytecode from the chain",
                                                                    b"This computer can't check the call first. If the network refuses it, the fee (about 1) is still paid.")]
      == ["claiming alice-long's NFT", "reading the LNS registry from the network", "sending it with its fixed fee cap"])
check("progress: anything else is dropped (paths, keys, the details line)", all(signer04.clean_line(l) is None for l in (
    b"Stored persistent accounts at /data/x", b"pk " + b"ab" * 32, b"  details: at most 8,600,000", b"Input recovery phrase: legal winner", b"sk deadbeef")))
check("errors: a fixed text, never what the tool printed", signer04.error_text([b"Error: Public/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin holds 5; about 900 is held for the fee while this runs"])
      == "Public/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin holds 5; about 900 is held for the fee while this runs. Add test LEZ to it first.")
check("errors: the deed's own refusals", signer04.error_text([b"Error: reserved is locked (one to four characters, or reserved), so it has no deed"]).startswith("reserved is locked")
      and signer04.error_text([b"Error: alice already has a deed (`names deed show alice`)"]) == "alice already has its NFT.")
check("errors: an unknown one is one plain sentence", signer04.error_text([b"Error: /secret/path weird"]) == signer04.ERROR_OTHER)
p = signer04.Pacer(0.05)
t0 = time.monotonic()
for _ in range(5):
    p.wait()
check("the pacer spaces calls (5 calls, 0.05 s apart: at least 0.2 s)", time.monotonic() - t0 >= 0.19, time.monotonic() - t0)
check("the pacer's default keeps under the network's 50 per 10 s", signer04.PACE >= 0.2)
check("the forwarder passes reads and sendTransaction only", "sendTransaction" in signer04.RPC_METHODS and not any(m.startswith("bridge_") for m in signer04.RPC_METHODS))

# ---- part 2: the signer --------------------------------------------------------------------------------------------
chain = Chain04()
data = mkdtemp()
bins = mkdtemp()
BIN = os.path.join(bins, "libnames04.so")
shutil.copy(os.path.join(HERE, "fake_names04_bin.py"), BIN)
os.chmod(BIN, 0o755)
CONF = {"rpc_url": "http://chain.invalid/", "lns_registry": "6Yxj5k8AiuBSuMAYVQFGrYKjJGUSSaWWgoB9D9XXN3gA", "deed_nft_program": "CjrUpegdA1RjqDN43T8P19kAkwnD1quAkNkER8k3dw9G"}
events = []


def fetch(url, body, cap, total):
    return chain.handle(body)


class Fwd(http.server.BaseHTTPRequestHandler):
    """The app's forwarder route, as server.py mounts it, in front of this test's signer."""
    def do_POST(self):
        code, out = s.forward(self.rfile.read(int(self.headers["Content-Length"])))
        out = out if isinstance(out, bytes) else json.dumps(out).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def log_message(self, *a):
        pass


fwd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fwd)
threading.Thread(target=fwd.serve_forever, daemon=True).start()
done_kinds = []
s = signer04.Signer04(data, BIN, fetch, lambda: dict(CONF), lambda: "http://127.0.0.1:%d/lez04-rpc/x" % fwd.server_address[1],
                      signer04.Pacer(0.0), event=lambda n, **d: events.append((n, d)), on_done=done_kinds.append)
check("not ready before a restore; sends refused", not s.ready() and s.send({"to": "alice", "amount": "1"})[0] == 409)
check("a phrase that isn't one: refused, nothing made", s.restore("hello world")[0] == 400 and not os.path.exists(s.storage()))
code, r = s.restore(PHRASE)
check("restore from the phrase: 16 public accounts, the first is this phone's", code == 200 and r["ready"] and len(r["accounts"]) == 16 and r["account"] == r["accounts"][0], r)
MAIN = r["account"]
seed = hashlib.sha256(b"fake-seed/" + PHRASE.encode()).digest()
check("the accounts are the ones the tool derives from the phrase (as on the desktop)", MAIN == lez04.b58encode(hashlib.sha256(b"fake-account/" + seed + b"/0").digest()))
check("its public key is read once and kept (public)", r["public_key"] == hashlib.sha256(b"fake-pk/" + MAIN.encode()).hexdigest())
calls = [json.loads(l) for l in open(os.path.join(data, "fake-names04-calls.jsonl"))]
rc = [c for c in calls if c["args"][:2] == ["module", "restore"]][0]
check("the phrase went on standard input only: not in argv, not in the environment", rc["stdin_len"] == len(PHRASE) and PHRASE not in " ".join(rc["args"])
      and all(PHRASE.split()[1] not in k for k in rc["env"]))
check("the tool's environment is the signer's own: no RISC0_*, an empty wallet password, the forwarder", all(not c["risc0"] for c in calls)
      and all("RISC0_PROVER" not in c["env"] and "APP_KEY" not in c["env"] for c in calls) and "LEE_WALLET_PASSWORD" in rc["env"] and rc["rpc"].endswith("/lez04-rpc/x"))
check("the registry is our LEZ 0.4's", rc["program"] == CONF["lns_registry"])
blob = everything_under(data) + json.dumps(events).encode() + json.dumps(s.view()).encode()
check("the phrase is in no file, no event and no reply", PHRASE.encode() not in blob and b"sausage worth" not in blob)
check("the wallet folder is the owner's only (0700, files 0600)", (os.stat(s.home).st_mode & 0o777) == 0o700
      and all((os.stat(os.path.join(s.home, f)).st_mode & 0o077) == 0 for f in os.listdir(s.home) if os.path.isfile(os.path.join(s.home, f))))
cfg = json.load(open(os.path.join(s.home, "wallet_config.json")))
check("the wallet's config points at the forwarder", cfg["sequencer"]["sequencer_addr"].startswith("http://127.0.0.1:") and cfg["seq_poll_timeout"] == "12s")
check("a second restore is refused, nothing changed", s.restore(OTHER)[0] == 409 and s.state()["main"] == MAIN)
check("the restore was said in the events by account only", any(n.startswith("lez04 accounts restored") and d.get("account") == MAIN for n, d in events))

d2 = mkdtemp()
s2 = signer04.Signer04(d2, BIN, fetch, lambda: dict(CONF), lambda: "http://127.0.0.1:1/x", signer04.Pacer(0.0))
code, r2 = s2.restore(" ".join(PHRASE.split()[:11] + ["zoo"]))
check("a restore the tool refuses: said plainly, no wallet left behind", code == 502 and not os.path.exists(s2.storage()) and not s2.ready(), r2)

# sends
chain.balances[MAIN] = 50000000
F = lez04.b58encode(bytes([7] * 32))
chain.balances[F] = 5
check("send to an account the network hasn't seen: refused before anything is sent", s.send({"to": "Public/" + lez04.b58encode(bytes([9] * 32)), "amount": "100"}) == (409, {"error": signer04.TEXT["unused"], "unused": True}))
check("send: a bad amount refused", s.send({"to": "Public/" + F, "amount": "0"})[0] == 400 and s.send({"to": "Public/" + F, "amount": "1.5"})[0] == 400)
check("send: to itself refused", s.send({"to": "Public/" + MAIN, "amount": "5"})[0] == 400)
code, r = s.send({"to": "Public/" + F, "amount": "1,000"})
j = wait_job(s)
check("send to a used account: by its id, from this phone's account, in a block", code == 200 and j["state"] == "done" and chain.balances[F] == 1005, (r, j))
last = [json.loads(l) for l in open(os.path.join(data, "fake-names04-calls.jsonl"))][-1]
check("its exact arguments", last["args"] == ["wallet", "auth-transfer", "send", "--from", "Public/" + MAIN, "--to", "Public/" + F, "--amount", "1000"], last["args"])
check("the network was asked through the forwarder (sendTransaction)", "sendTransaction" in chain.calls)
PK = "ab" * 32
s.send({"to": PK.upper(), "amount": "7"})
wait_job(s)
check("send to a public key (a first payment): --to-pk", chain.balances.get("pk:" + PK) == 7)
s.send({"to": "@Alice-Long", "amount": "9"})
wait_job(s)
last = [json.loads(l) for l in open(os.path.join(data, "fake-names04-calls.jsonl"))][-1]
check("send to an LNS name: names pay --public from this phone's account", last["args"] == ["pay", "--public", "--from=Public/" + MAIN, "--", "alice-long", "9"], last["args"])
s.send({"to": "unused", "amount": "9"})
j = wait_job(s)
check("a name whose account was never used: the tool's refusal, in fixed words", j["state"] == "failed" and "never been used" in j["error"], j)
s.send({"to": "Public/" + F, "amount": "13"})
j = wait_job(s)
check("not enough for the fee: the fixed sentence with the figures", j["state"] == "failed" and j["error"].endswith("Add test LEZ to it first.") and "holds 0" in j["error"], j)
s.send({"to": "Public/" + F, "amount": "1"})
busy = s.send({"to": "Public/" + F, "amount": "1"})
wait_job(s)
check("a second press while one runs is refused", busy[0] == 409 and busy[1]["error"] == signer04.TEXT["busy"], busy)
check("a send that worked asks the reader to look again", "send" in done_kinds)

# NFTs
PROG, ART = "ErycMYqXUUtducaYmpHZjRgdbLXchrMiV4NZRnmRDNmu", "HA47ERcmfSbDChGcYfBcC4SKaPQ8pJJnv4wxCLu1ejL5"
s.nft_init({"program": PROG, "definition": ART})
j = wait_job(s)
last = [json.loads(l) for l in open(os.path.join(data, "fake-names04-calls.jsonl"))][-1]
check("Receive: this phone's account made ready (InitializeHolding), as --account", j["state"] == "done" and last["args"] == ["--nft-program", PROG, "nft", "init", "--definition", ART, "--account", MAIN], last["args"])
check("its state on the network: ready for the collection", lez04.decode_nft(chain.states[(MAIN, PROG)]) == {"state": "copy", "definition": ART, "owned": False})
ART2 = "73zq8SWWULTuAb5ZNJPLt1jjuDhr65cn5J7GmGfD1QMt"
s.nft_init({"program": PROG, "definition": ART2})
j = wait_job(s)
last = [json.loads(l) for l in open(os.path.join(data, "fake-names04-calls.jsonl"))][-1]
check("Receive again under the same program: a new account, paid by this phone's", last["args"][-4:] == ["--new", "public", "--fee-payer", MAIN] and j["account"] and j["account"] in s.state()["accounts"], (last["args"], j))
check("Receive: bad ids refused", s.nft_init({"program": "x", "definition": ART})[0] == 400)
chain.states[(MAIN, PROG)] = b"\1" + lez04.b58decode(ART) + (2).to_bytes(16, "little")
X = lez04.b58encode(bytes([11] * 32))
code, r = s.nft_send({"program": PROG, "from": MAIN, "to": "Public/" + X})
j = wait_job(s)
check("Send an NFT: from this phone's account to an account", code == 200 and j["state"] == "done" and lez04.decode_nft(chain.states[(X, PROG)])["state"] == "master", j)
NEWACC = s.state()["accounts"][-1]
s.nft_send({"program": PROG, "from": NEWACC, "to": "bob"})
wait_job(s)
last = [json.loads(l) for l in open(os.path.join(data, "fake-names04-calls.jsonl"))][-1]
check("Send from another account of the wallet: this phone's account pays the fee", last["args"][-2:] == ["--fee-payer", MAIN] and "bob" in last["args"], last["args"])
check("Send from an account that isn't the wallet's: refused", s.nft_send({"program": PROG, "from": X, "to": "bob"})[0] == 400)
s.nft_send({"program": PROG, "from": MAIN, "to": "Public/" + "1" * 32})
j = wait_job(s)
check("the recipient isn't ready: the program's own sentence", j["state"] == "failed" and j["error"].startswith("That account isn't ready"), j)

# the name's NFT: the shortlist first
got = []


def fake_download(url, path, size, hosts, progress, total=900):
    got.append((url, size, hosts))
    progress(30000000)
    with open(path, "wb") as f:
        f.write(b"list")
    return signer04.SHORTLIST_SHA256 if fake_download.ok else "00" * 32


fake_download.ok = False
real_download, signer04.download = signer04.download, fake_download
check("claim: a short name refused here", s.claim("abcd", MAIN)[0] == 400)
check("claim: a name held by another wallet refused here", s.claim("alice-long", X)[0] == 409)
s.claim("alice-long", MAIN)
j = wait_job(s)
check("claim: a list whose sha256 isn't the pinned one is refused, not kept, and nothing is sent", j["state"] == "failed" and "couldn't be downloaded" in j["error"]
      and not os.path.exists(s.shortlist) and not os.path.exists(s.shortlist + ".part") and not chain.sent[-1].get("claim"), j)
check("the list comes from the pinned release, redirects only to GitHub's file host", got[0] == (signer04.SHORTLIST_URL, signer04.SHORTLIST_SIZE, (".githubusercontent.com",)))
fake_download.ok = True
chain.register("alice-long", MAIN)
s.claim("alice-long", MAIN)
j = wait_job(s)
last = [json.loads(l) for l in open(os.path.join(data, "fake-names04-calls.jsonl"))][-1]
check("claim: names deed claim, the list handed over, in a block", j["state"] == "done" and last["args"] == ["deed", "claim", "alice-long"] and last["shortlist"] == s.shortlist, (j, last))
check("the name's record now names its NFT", chain.holder_of("alice-long")["deed"] is not None)
check("the list stays for the next claim (0600)", os.path.isfile(s.shortlist) and (os.stat(s.shortlist).st_mode & 0o077) == 0)
s.claim("reserved", MAIN)
j = wait_job(s)
check("claim of a reserved name: the registry's refusal, plainly", j["state"] == "failed" and j["error"].startswith("reserved is locked"), j)
signer04.download = real_download

# the faucet
v = s.faucet_info()
check("faucet info read (amount, available)", v == {"amount": "10000000", "available": True}, v)
bal = chain.balances[MAIN]
code, r = s.faucet()
check("the faucet: [public key, null, this wallet's account], once per wallet", code == 200 and chain.faucet_params[-1] == [s.state()["public_key"], None, MAIN] and r["amount"] == "10000000", (code, r, chain.faucet_params))
check("the test LEZ arrive", chain.balances[MAIN] == bal + 10000000)
n = len(chain.faucet_params)
check("a second press is refused here, the faucet isn't asked again", s.faucet() == (409, {"error": signer04.TEXT["faucet_once"], "code": "already_used"}) and len(chain.faucet_params) == n)
check("the view says it was used", s.view()["faucet"]["used"] is True)

# the forwarder
check("forwarder: a method not on its list is refused", s.forward(json.dumps({"method": "bridge_faucet", "params": []}).encode())[0] == 403)
check("forwarder: too big a batch refused", s.forward(json.dumps([{"method": "getLastBlockId"}] * 21).encode())[0] == 403)
chain.mode = "busy"
before = len(chain.calls)
signer04_sleep, signer04.time.sleep = signer04.time.sleep, lambda x: None
code, _ = s.forward(json.dumps({"method": "getLastBlockId", "params": []}).encode())
check("forwarder: a read refused for its rate is tried again (3 tries)", code == 429 and chain.calls[before:].count("(429)") == 3, chain.calls[before:])
chain.mode = "ok"
signer04.time.sleep = signer04_sleep
code, out = s.forward(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getChannelId", "params": []}).encode())
check("forwarder: a read passes", code == 200 and json.loads(out)["result"] == chain.answer({"method": "getChannelId"})["result"])

# ---- part 3: the app -------------------------------------------------------------------------------------------------
chain2 = Chain04()


class RPC(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        code, raw = chain2.handle(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def log_message(self, *a):
        pass


rpc = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RPC)
threading.Thread(target=rpc.serve_forever, daemon=True).start()
adata = mkdtemp()
with open(os.path.join(adata, "wallet-net04-config.json"), "w") as f:
    json.dump({"rpc_url": "http://127.0.0.1:%d/" % rpc.server_address[1]}, f)
abins = mkdtemp()
for src, dst in (("fake_names04_bin.py", "libnames04.so"), ("fake_names_bin.py", "libnames.so")):
    shutil.copy(os.path.join(HERE, src), os.path.join(abins, dst))
    os.chmod(os.path.join(abins, dst), 0o755)
PORT = 8131 + int(os.environ.get("PORT_SHIFT", "0"))
os.environ.update(APP_EMBEDDED="android", APP_PORT=str(PORT), APP_DATA=adata, NODE_BIN="/nonexistent", UPDATE_URL="", NET04_POLL_SECONDS="0.2",
                  NAMES04_BIN=os.path.join(abins, "libnames04.so"), NAMES_BIN=os.path.join(abins, "libnames.so"), LEZ04_PACE_SECONDS="0.01")
lez04.POLL, lez04.NFT_GAP = 0.2, 0.0
signer04.PACE = 0.01
import server  # noqa: E402
threading.Thread(target=server.main, daemon=True).start()
import wallet_test as W  # noqa: E402
W.BASE = "http://127.0.0.1:%d" % PORT
for _ in range(80):
    try:
        if W.call("/api/wallet")[0] == 200:
            break
    except Exception:
        pass
    time.sleep(0.1)
sess = W.call("/api/wallet/setup", {"pin": "246828"})[1]["session"]
html = urllib.request.urlopen(W.BASE + "/").read().decode()
check("the page loads the signer's script between the 0.4 view and Collectibles", html.index('<script src="/net04/net04.js">') < html.index('<script src="/net04/sign04.js">') < html.index('<script src="/net04/nft.js">'))
check("every signer route needs the session", W.call("/api/wallet/lez04")[0] == 401 and all(W.call("/api/wallet/lez04/" + w, {})[0] == 401 for w in ("restore", "send", "faucet", "claim", "nft/init", "nft/send")))
code, v = W.call("/api/wallet/lez04", session=sess)
check("the app has the signer, not ready yet", code == 200 and v["available"] and not v["ready"], v)
check("the forwarder: a wrong secret is a plain 404", W.call("/lez04-rpc/nope", {"method": "getChannelId"})[0] == 404)
code, v = W.call("/api/wallet/lez04/restore", {"phrase": PHRASE}, session=sess)
check("restore through the app", code == 200 and v["ready"] and len(v["accounts"]) == 16, v)
AMAIN = v["account"]
blob = everything_under(adata)
check("the phrase is in no file of the app's data folder (events log included)", PHRASE.encode() not in blob and b"sausage worth useful" not in blob)
check("the Wallet's 0.4 account is the restored one now", server.net04_own() == AMAIN)
chain2.balances[AMAIN] = 40000000
chain2.register("alice-long", AMAIN)
code, r = W.call("/api/wallet/lez04/claim", {"name": "alice-long"}, session=sess)
check("claim before Collectibles read the name: refused, says what to do", code == 409 and "Read the name first" in r["error"], r)
W.call("/api/wallet/net04/nft", {"add_name": "alice-long"}, session=sess)
server.lns_name_id = lambda name: name_id(name)
row = None
for _ in range(60):
    time.sleep(0.2)
    code, nv = W.call("/api/wallet/net04/nft", session=sess)
    row = next((x for x in nv.get("names", []) if x["name"] == "alice-long"), None)
    if row and row["status"] == "no_nft":
        break
check("Collectibles: the restored wallet holds alice-long, no NFT yet: Claim offered", row and row["status"] == "no_nft" and row.get("claim") is True and row["holder"] == AMAIN, row)
chain2.register("abcd", AMAIN)
signer04.download = fake_download
code, r = W.call("/api/wallet/lez04/claim", {"name": "alice-long"}, session=sess)
check("Claim through the app starts the job", code == 200 and r["job"]["state"] == "running" and r["job"]["kind"] == "claim", r)
for _ in range(100):
    time.sleep(0.1)
    j = W.call("/api/wallet/lez04", session=sess)[1]["job"]
    if j["state"] != "running":
        break
check("the claim ends in a block", j["state"] == "done", j)
row = None
for _ in range(60):
    time.sleep(0.2)
    nv = W.call("/api/wallet/net04/nft", session=sess)[1]
    row = next((x for x in nv.get("names", []) if x["name"] == "alice-long"), None)
    if row and row["status"] == "ok":
        break
check("then Collectibles reads its card: held by the restored account", row and row["status"] == "ok" and row["holder"] == AMAIN, row)
code, r = W.call("/api/wallet/lez04/faucet", {}, session=sess)
check("the faucet through the app, its proxy params", code == 200 and chain2.faucet_params[-1][1:] == [None, AMAIN], (code, r))
seen = set(c for c in chain2.calls if not c.startswith("("))
check("the app asked the network only for reads, sendTransaction and the faucet", seen <= signer04.RPC_METHODS | {"bridge_faucet", "bridge_faucetInfo"}, seen)
print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

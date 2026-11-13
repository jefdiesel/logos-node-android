#!/usr/bin/env python3
"""A transfer through the real node, with the app dying between fund and submit (CI, job node-socket).

  NODE_SOCK=<the node's API socket> NODE_CFG=... NODE_BIN=... python3 tests/xfer_real.py

1. A second copy of the app (its own data folder, port 8091) makes a send with XFER_CRASH=after-fund: it funds the
   transfer, saves it with its hash, and the process ends before submitting it. Nothing is in the node's mempool.
2. The app starts again without that: it finds the saved transfer, submits that same transfer, and finds its hash
   in a block of the chain: Activity reads "in block", with the fee the funded transfer names.
3. The same signed transfer, submitted twice more straight to the node (as a retry would): it lands once. The
   recipient's balance went up by the amount once.
"""
import http.client, json, os, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

SOCK = os.environ["NODE_SOCK"]
PORT = 8091
W.BASE = "http://127.0.0.1:%d" % PORT
DATA = tempfile.mkdtemp(prefix="xfer-real-")
FAILS = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else " - " + str(detail)[:800]), flush=True)
    if not ok:
        FAILS.append(name)
    return ok


class Unix(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCK)


def node(method, path, body=None):
    c = Unix("node", timeout=60)
    c.request(method, path, body=json.dumps(body).encode() if body is not None else None,
              headers={"Content-Type": "application/json"} if body is not None else {})
    r = c.getresponse()
    raw = r.read()
    c.close()
    try:
        return r.status, json.loads(raw)
    except Exception:
        return r.status, raw.decode(errors="replace")


def balance(k):
    return node("GET", "/wallet/%s/balance" % k)[1]


def app(crash):
    env = dict(os.environ, APP_PORT=str(PORT), APP_DATA=DATA, NODE_API="unix:" + SOCK, HISTORY_POLL="2",
               XFER_RESUBMIT_SECONDS="20", XFER_CRASH=crash, UPDATE_URL="")
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "..", "app", "server.py")], env=env,
                         stdout=open(os.path.join(DATA, "app-%s.log" % (crash or "plain")), "w"), stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            if W.call("/api/wallet")[0] == 200:
                break
        except Exception:
            pass
        time.sleep(0.5)
    return p


# ---- 1. fund, save, and die before submitting --------------------------------------------------------------------------
p = app("after-fund")
code, d = W.call("/api/wallet/setup", {"pin": "246802"})
s = d["session"]
accts = W.wait_accounts(s, want=3)["accounts"]
rich = max(accts, key=lambda a: int(a["balance"]))
to = [a for a in accts if a["key"] != rich["key"]][0]
for _ in range(60):                           # the history must be tracking before the send (its first look)
    if any(e["kind"] == "tracking started" for e in W.call("/api/wallet/history", session=s)[1].get("entries", [])):
        break
    time.sleep(1)
notes0 = set((balance(to["key"]).get("notes") or {}))
amount = 1234
try:
    code, d = W.call("/api/wallet/send", {"from": rich["key"], "to": to["key"], "amount": amount}, session=s)
except Exception as e:
    code, d = 0, str(e)
p.wait(timeout=30)
check("the app ended after saving the funded transfer, before submitting it", p.returncode == 17, (p.returncode, code, d))
with open(os.path.join(DATA, "wallet-transfers.json")) as f:
    recs = list(json.load(f).values())
r = recs[0] if recs else {}
h = r.get("hash")
check("its record: funded, with the hash, the notes it spends and the signed transfer", r.get("state") == "funded" and h and r.get("inputs")
      and r.get("signed"), r)
mv = node("GET", "/mempool/view")[1]
check("nothing in the node's mempool", h not in (mv if isinstance(mv, list) else []), mv)

# ---- 2. the app again: it submits that same transfer, and finds it in a block ---------------------------------------------
p = app("")
code, d = W.call("/api/wallet/unlock", {"pin": "246802"})
s = d.get("session")
state, e = None, None
for _ in range(120):
    code, st = W.call("/api/wallet/tx?hash=" + h, session=s)
    hist = W.call("/api/wallet/history", session=s)[1].get("entries", [])
    e = next((x for x in hist if x.get("hash") == h), None)
    if st.get("state") == "in_block" and e and e.get("status") == "in block":
        state = st
        break
    time.sleep(2)
check("after the restart: the same transfer submitted, found in a block by its hash", state is not None, (st, e))
check("  Activity: in block, with the fee the funded transfer names", e and e.get("fee") == str(r.get("fee")), e)
found = False
code, raw = None, b""
c = Unix("node", timeout=60)
c.request("GET", "/cryptarchia/blocks_range?slot_from=%d&order=ascending&blocks_limit=500" % r["slot_from"])
resp = c.getresponse()
raw = resp.read()
for line in raw.decode().splitlines():
    if line.strip():
        ev = json.loads(line)
        for t in ev.get("block", ev).get("transactions") or []:
            found = found or (t.get("mantle_tx") or {}).get("hash") == h
check("the node's own block stream has the hash the app computed", found, raw[:600])

# ---- 3. the same signed transfer again, twice: it lands once ---------------------------------------------------------------
for _ in range(2):
    code, d = node("POST", "/mempool/add/tx", r["signed"])
    print("     add/tx again:", code, d)
time.sleep(20)
new = {i: v for i, v in (balance(to["key"]).get("notes") or {}).items() if i not in notes0}
check("the recipient got the amount once: one new note of it", sorted(v for v in new.values() if v == amount) == [amount], new)
mv = node("GET", "/mempool/view")[1]
check("and the node holds nothing more of it", h not in (mv if isinstance(mv, list) else []), mv)
p.terminate()
print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
if FAILS:
    for f in os.listdir(DATA):
        if f.endswith(".log"):
            print("==", f)
            print(open(os.path.join(DATA, f)).read()[-3000:])
sys.exit(1 if FAILS else 0)

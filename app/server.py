#!/usr/bin/env python3
"""Local web app for a Logos node running on the same device: node status plus a small wallet.

It listens on 127.0.0.1 only and talks to the node's own API on 127.0.0.1:8080.
Python standard library only. Wallet calls need a PIN that is set on first use.
"""
import hashlib, hmac, http.server, json, os, re, secrets, subprocess, threading, time
import urllib.error, urllib.request

HOME = os.path.expanduser("~")
NODE_API = os.environ.get("NODE_API", "http://127.0.0.1:8080")
NODE_BIN = os.environ.get("NODE_BIN", HOME + "/node/logos-blockchain-node")
NODE_CFG = os.environ.get("NODE_CFG", HOME + "/node/run/user_config.yaml")
NODE_DEPLOYMENT = os.environ.get("NODE_DEPLOYMENT", "")
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("APP_DATA", APP_DIR)
PORT = int(os.environ.get("APP_PORT", "8090"))
HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}
ORIGINS = {"http://" + h for h in HOSTS}
PIN_FILE = os.path.join(DATA_DIR, "wallet-pin.json")
PIN_RE = re.compile(r"^\d{6,12}$")
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
SESSION_IDLE = 600      # seconds without use before the wallet locks again
MAX_FAILS = 5           # wrong PINs before a pause
FAIL_PAUSE = 300        # seconds

lock = threading.Lock()
session = {"token": None, "used": 0.0}
fails = {"count": 0, "until": 0.0}
sent = {}               # tx hash -> what we sent, to report when it lands
keys_cache = {"keys": [], "at": 0.0}


# ---- node API -------------------------------------------------------------------------------

def node(path, body=None, timeout=8):
    """Calls the node. Returns (http status, parsed JSON or text). Status 0 means no answer."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(NODE_API + path, data=data, method="GET" if body is None else "POST")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    except Exception:
        return 0, None
    try:
        return code, json.loads(raw)
    except Exception:
        return code, raw.decode(errors="replace")


def as_int(v):
    try:
        return int(str(v).replace(",", ""))
    except Exception:
        return 0


def node_status():
    code, info = node("/cryptarchia/info", timeout=5)
    if code != 200 or not isinstance(info, dict):
        return None
    c = info.get("cryptarchia_info", info)
    out = {"height": c.get("height"), "slot": c.get("slot"), "state": c.get("state"), "phase": info.get("phase")}
    code, net = node("/network/info", timeout=5)
    out["peers"] = len(net.get("connected_peers") or []) if code == 200 and isinstance(net, dict) else None
    return out


def node_waiting():
    """What the node is doing while its API doesn't answer yet: running at all, and how many saved blocks it is re-checking."""
    out = {"running": False, "replay": None}
    try:
        out["running"] = subprocess.run(["pgrep", "-f", "logos-blockchain-node"], capture_output=True, timeout=5).returncode == 0
    except Exception:
        out["running"] = None
    try:
        logs = os.path.join(os.path.dirname(NODE_CFG), "logs")
        newest = max((os.path.join(logs, f) for f in os.listdir(logs)), key=os.path.getmtime)
        with open(newest, "rb") as f:
            f.seek(0, 2); f.seek(max(0, f.tell() - 400000))
            found = re.findall(rb"found (\d+) stored blocks to replay", f.read())
        if found:
            out["replay"] = int(found[-1])
    except Exception:
        pass
    return out


# ---- wallet keys ----------------------------------------------------------------------------

def parse_keys(text):
    """Reads the wallet's public keys out of `logos-blockchain-node --show-config` (secrets are redacted there)."""
    top, in_known, known_indent, known, funding = None, False, 0, [], {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            top, in_known = s.rstrip(":"), False
            continue
        if top == "wallet":
            if s.startswith("known_keys:"):
                in_known, known_indent = True, indent
                continue
            if in_known and indent <= known_indent:
                in_known = False
            if in_known:
                m = re.match(r"^([0-9a-fA-F]{64})\s*:", s)
                if m:
                    known.append(m.group(1).lower())
                continue
        m = re.match(r"^funding_pk:\s*([0-9a-fA-F]{64})\s*$", s)
        if m and top in ("cryptarchia", "sdp"):
            funding.setdefault(top, m.group(1).lower())
    order = []
    for k in [funding.get("cryptarchia"), funding.get("sdp")] + known:
        if k and k not in order:
            order.append(k)
    out = []
    for k in order:
        label = "Main" if k == funding.get("cryptarchia") else "Service" if k == funding.get("sdp") else "Key %d" % (len(out) + 1)
        out.append({"key": k, "label": label})
    return out


def wallet_keys():
    with lock:
        if keys_cache["keys"] or time.time() - keys_cache["at"] < 20:
            return keys_cache["keys"]
        keys_cache["at"] = time.time()
    cmd = [NODE_BIN]
    if NODE_DEPLOYMENT:
        cmd += ["--deployment", NODE_DEPLOYMENT]
    cmd += ["--show-config", NODE_CFG]
    try:
        text = subprocess.run(cmd, cwd=os.path.dirname(NODE_CFG), capture_output=True, text=True, timeout=30).stdout
        found = parse_keys(text)
    except Exception:
        found = []
    with lock:
        if found:
            keys_cache["keys"] = found
        return keys_cache["keys"]


# ---- PIN and session ------------------------------------------------------------------------

def pin_hash(pin, salt):
    return hashlib.scrypt(pin.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def pin_is_set():
    return os.path.exists(PIN_FILE)


def pin_save(pin):
    salt = secrets.token_bytes(16)
    fd = os.open(PIN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"salt": salt.hex(), "hash": pin_hash(pin, salt).hex()}, f)


def pin_check(pin):
    try:
        with open(PIN_FILE) as f:
            d = json.load(f)
        return hmac.compare_digest(pin_hash(pin, bytes.fromhex(d["salt"])), bytes.fromhex(d["hash"]))
    except Exception:
        return False


def session_new():
    with lock:
        session["token"], session["used"] = secrets.token_hex(32), time.time()
        return session["token"]


def session_ok(token):
    with lock:
        t = session["token"]
        if not t or not token or not hmac.compare_digest(t, token):
            return False
        if time.time() - session["used"] > SESSION_IDLE:
            session["token"] = None
            return False
        session["used"] = time.time()
        return True


# ---- wallet actions -------------------------------------------------------------------------

def accounts():
    out = []
    for k in wallet_keys():
        code, reply = node("/wallet/%s/balance" % k["key"])
        ok = code == 200 and isinstance(reply, dict)
        out.append({"key": k["key"], "label": k["label"],
                    "balance": str(as_int(reply.get("balance"))) if ok else None,
                    "notes": len(reply.get("notes") or {}) if ok else None})
    return out


def send(body):
    frm, to = str(body.get("from", "")).lower(), str(body.get("to", "")).strip().lower()
    try:
        amount = int(str(body.get("amount", "")).replace(",", ""))
    except Exception:
        return 400, {"error": "The amount must be a whole number."}
    if frm not in [k["key"] for k in wallet_keys()]:
        return 400, {"error": "That 'from' key is not in this node's wallet."}
    if not KEY_RE.match(to):
        return 400, {"error": "The address must be 64 characters, using only 0-9 and a-f."}
    if to == frm:
        return 400, {"error": "That would send to the same key it comes from."}
    if amount <= 0:
        return 400, {"error": "The amount must be more than zero."}
    st = node_status()
    if not st or st.get("state") != "Online":
        return 409, {"error": "The node is not online yet, so it can't send. Wait until it has finished syncing."}
    code, bal = node("/wallet/%s/balance" % frm)
    if code != 200 or not isinstance(bal, dict):
        return 502, {"error": "The node didn't return a balance for that key."}
    before = as_int(bal.get("balance"))
    if before < amount:
        return 400, {"error": "That key holds %d, less than %d." % (before, amount)}
    code, reply = node("/wallet/transactions/transfer-funds", {
        "tip": None, "change_public_key": frm, "funding_public_keys": [frm],
        "recipient_public_key": to, "amount": amount}, timeout=60)
    if code != 200 or not isinstance(reply, dict) or not reply.get("hash"):
        detail = reply if isinstance(reply, str) else json.dumps(reply)
        return 502, {"error": "The node refused the transfer: %s" % (detail or "no answer")[:300]}
    with lock:
        sent[reply["hash"]] = {"from": frm, "to": to, "amount": amount, "before": before, "at": time.time()}
    return 200, {"hash": reply["hash"]}


def tx_status(h):
    with lock:
        tx = sent.get(h)
    if not tx:
        return 404, {"error": "This app didn't send that transaction."}
    code, bal = node("/wallet/%s/balance" % tx["from"])
    if code != 200 or not isinstance(bal, dict):
        return 200, {"state": "unknown"}
    now = as_int(bal.get("balance"))
    if now < tx["before"]:
        # the sender's balance only drops once the transfer is in a block
        return 200, {"state": "in_block", "fee": str(tx["before"] - now - tx["amount"])}
    return 200, {"state": "waiting"}


# ---- home-screen app: manifest and icon -----------------------------------------------------

MANIFEST = json.dumps({
    "name": "Logos node", "short_name": "Logos node", "start_url": "/", "scope": "/", "display": "standalone",
    "background_color": "#11110f", "theme_color": "#11110f",
    "icons": [{"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
              {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
              {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}).encode()
_icons = {}


def icon_png(n):
    """A plain icon drawn in code (a ring with a dot, on a dark square), so the repo carries no image files."""
    if n in _icons:
        return _icons[n]
    import struct, zlib
    bg, fg = (0x11, 0x11, 0x0f), (0xf0, 0x79, 0x4a)
    c, ring, half, dot = (n - 1) / 2.0, 0.27 * n, 0.04 * n, 0.085 * n
    rows = []
    for y in range(n):
        row = bytearray([0])
        for x in range(n):
            d = ((x - c) ** 2 + (y - c) ** 2) ** 0.5
            a = max(min(half - abs(d - ring) + 0.5, 1.0), min(dot - d + 0.5, 1.0), 0.0)
            row += bytes(int(round(b + (f - b) * a)) for b, f in zip(bg, fg))
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    _icons[n] = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
    return _icons[n]


# ---- fingerprint test (temporary): does this browser allow a passkey for a page on this device? ----

fp_result = {"result": None}
FP_PAGE = b"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Fingerprint test</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:480px;margin:0 auto;padding:28px 18px}
button{font:inherit;font-weight:600;padding:14px 18px;border-radius:10px;border:0;background:#b4451b;color:#fff;width:100%;min-height:52px}
#out{margin-top:18px;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
<h1 style="font-size:22px">Fingerprint test</h1>
<p>This checks whether this phone lets the wallet page use your fingerprint. It creates a test key and nothing else. Tap the button, then touch the fingerprint sensor if asked.</p>
<button id="b">Test fingerprint</button><div id="out"></div>
<script>
const out = t => { document.getElementById("out").textContent = t; fetch("/api/fp-test", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({result: t})}).catch(()=>{}); };
document.getElementById("b").addEventListener("click", async () => {
  if (location.hostname !== "localhost") return out("Open this page as localhost:" + location.port + "/fp-test (not " + location.hostname + ") and try again.");
  if (!window.PublicKeyCredential) return out("FAIL: this browser has no passkey support.");
  try {
    const avail = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { id: "localhost", name: "Logos node" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "wallet", displayName: "Logos node wallet" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60000, attestation: "none" } });
    const r = cred.response, alg = r.getPublicKeyAlgorithm ? r.getPublicKeyAlgorithm() : "?";
    out("OK: fingerprint works here. (platform sensor reported: " + avail + ", key type " + alg + ", transports " + (r.getTransports ? r.getTransports().join(",") : "?") + ")");
  } catch (e) { out("FAIL: " + e.name + ": " + e.message); }
});
</script></body></html>"""


# ---- HTTP -----------------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "LogosNodeApp"

    def reply(self, code, obj=None, ctype="application/json", raw=None):
        data = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(data)

    def host_ok(self):
        # refuse requests that reached us under another name (DNS rebinding)
        return self.headers.get("Host", "") in HOSTS

    def authed(self):
        return session_ok(self.headers.get("X-Session", ""))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        # Status is public and may be relayed to other devices. Everything else answers only
        # when the request was addressed to this device itself.
        if path.startswith("/api/wallet") and not self.host_ok():
            return self.reply(403, {"error": "The wallet only opens on the device that runs the node.", "local_only": True})
        if path == "/":
            try:
                with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
                    return self.reply(200, raw=f.read(), ctype="text/html; charset=utf-8")
            except Exception:
                return self.reply(500, {"error": "index.html is missing"})
        if path == "/manifest.webmanifest":
            return self.reply(200, raw=MANIFEST, ctype="application/manifest+json")
        if path in ("/icon-192.png", "/icon-512.png"):
            return self.reply(200, raw=icon_png(192 if "192" in path else 512), ctype="image/png")
        if path == "/fp-test":
            return self.reply(200, raw=FP_PAGE, ctype="text/html; charset=utf-8")
        if path == "/api/fp-test":
            return self.reply(200, fp_result)
        if path == "/api/status":
            st = node_status()
            return self.reply(200, {"node": st} if st else {"node": None, "waiting": node_waiting()})
        if path in ("/cryptarchia/info", "/network/info"):       # read-only pass-through
            code, reply = node(path, timeout=5)
            return self.reply(200 if code == 200 else 502, reply if code == 200 else {"error": "node not answering"})
        if path == "/api/wallet":
            with lock:
                wait = max(0, int(fails["until"] - time.time()))
            return self.reply(200, {"pin_set": pin_is_set(), "unlocked": self.authed(), "wait": wait})
        if path == "/api/wallet/accounts":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            return self.reply(200, {"accounts": accounts(), "node": node_status()})
        if path == "/api/wallet/tx":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            m = re.search(r"[?&]hash=([0-9a-fA-F]{1,128})", self.path)
            code, obj = tx_status(m.group(1)) if m else (400, {"error": "no hash"})
            return self.reply(code, obj)
        return self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.host_ok() or self.headers.get("Origin", "") not in ORIGINS:
            return self.reply(403, {"error": "this app only accepts requests from its own page"})
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.reply(415, {"error": "send JSON"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}") if 0 <= n <= 4096 else None
        except Exception:
            body = None
        if not isinstance(body, dict):
            return self.reply(400, {"error": "bad request"})
        path = self.path.split("?", 1)[0]
        if path == "/api/fp-test":
            fp_result["result"] = str(body.get("result", ""))[:500]
            return self.reply(200, {"ok": True})
        if path == "/api/wallet/setup":
            pin = str(body.get("pin", ""))
            if not PIN_RE.match(pin):
                return self.reply(400, {"error": "The PIN must be 6 to 12 digits."})
            try:
                pin_save(pin)
            except FileExistsError:
                return self.reply(409, {"error": "A PIN is already set."})
            return self.reply(200, {"session": session_new()})
        if path == "/api/wallet/unlock":
            with lock:
                wait = int(fails["until"] - time.time())
            if wait > 0:
                return self.reply(429, {"error": "Too many wrong PINs. Try again in %d seconds." % wait, "wait": wait})
            if pin_is_set() and pin_check(str(body.get("pin", ""))):
                with lock:
                    fails["count"] = 0
                return self.reply(200, {"session": session_new()})
            with lock:
                fails["count"] += 1
                if fails["count"] >= MAX_FAILS:
                    fails["count"], fails["until"] = 0, time.time() + FAIL_PAUSE
            return self.reply(401, {"error": "Wrong PIN."})
        if path == "/api/wallet/lock":
            with lock:
                session["token"] = None
            return self.reply(200, {"ok": True})
        if path == "/api/wallet/send":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            code, obj = send(body)
            return self.reply(code, obj)
        return self.reply(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    threading.Thread(target=wallet_keys, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

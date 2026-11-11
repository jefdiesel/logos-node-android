#!/usr/bin/env python3
"""Local web app for a Logos node running on the same device: node status plus a small wallet.

It listens on 127.0.0.1 only and talks to the node's own API on 127.0.0.1:8080.
Python standard library only. Wallet calls need a PIN that is set on first use.
"""
import base64, hashlib, hmac, http.server, json, os, re, secrets, subprocess, threading, time
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


# ---- security event log ---------------------------------------------------------------------
# One line per wallet event in DATA_DIR/wallet-events.log (owner-only), so it can be told later what
# unlocked, locked or changed the wallet, and from which page. It never holds the PIN, session tokens,
# challenges, signatures or keys, and there is no way to read it over HTTP.

EVENTS_FILE = os.path.join(DATA_DIR, "wallet-events.log")
EVENTS_MAX, EVENTS_KEEP = 1000, 500
events_lock = threading.Lock()


def event(name, req=None, **detail):
    """Appends one event. `req` is the request handler, for its Host, Origin and User-Agent."""
    parts = [time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), name]
    parts += ["%s=%s" % (k, json.dumps(str(v)[:120])) for k, v in detail.items()]
    if req is not None:
        parts += ["%s=%s" % (h.lower(), json.dumps(str(req.headers.get(h, ""))[:120])) for h in ("Host", "Origin", "User-Agent")]
    line = " ".join(parts) + "\n"
    try:
        with events_lock:
            fd = os.open(EVENTS_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a") as f:
                f.write(line)
            with open(EVENTS_FILE) as f:
                lines = f.readlines()
            if len(lines) > EVENTS_MAX:
                tmp = EVENTS_FILE + ".tmp"
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.writelines(lines[-EVENTS_KEEP:])
                os.replace(tmp, EVENTS_FILE)
    except Exception:
        pass


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

def balance_of(key):
    """(balance, number of notes) for one of this node's wallet keys, or None when the node gives no usable answer.
    The node answers 404 ("could not be found in the wallet") for a key of its own wallet that has never
    received a note, so that is a balance of 0. No answer, or any other error, stays None."""
    code, reply = node("/wallet/%s/balance" % key)
    if code == 200 and isinstance(reply, dict):
        return as_int(reply.get("balance")), len(reply.get("notes") or {})
    if code == 404 and isinstance(reply, dict) and reply.get("code") == 404:
        return 0, 0
    return None


def accounts():
    out = []
    for k in wallet_keys():
        b = balance_of(k["key"])
        out.append({"key": k["key"], "label": k["label"],
                    "balance": str(b[0]) if b else None, "notes": b[1] if b else None})
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
    bal = balance_of(frm)
    if bal is None:
        return 502, {"error": "The node didn't return a balance for that key."}
    before = bal[0]
    if before < amount:
        return 400, {"error": "That key holds %d, less than %d." % (before, amount)}
    code, reply = node("/wallet/transactions/transfer-funds", {
        "tip": None, "change_public_key": frm, "funding_public_keys": [frm],
        "recipient_public_key": to, "amount": amount}, timeout=60)
    # the node answers an accepted transfer with 201 Created
    if not 200 <= code < 300 or not isinstance(reply, dict) or not reply.get("hash"):
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
    bal = balance_of(tx["from"])
    if bal is None:
        return 200, {"state": "unknown"}
    now = bal[0]
    if now < tx["before"]:
        # the sender's balance only drops once the transfer is in a block
        return 200, {"state": "in_block", "fee": str(tx["before"] - now - tx["amount"])}
    return 200, {"state": "waiting"}


# ---- home-screen app: manifest and icon -----------------------------------------------------

MANIFEST = json.dumps({
    "name": "Logos node", "short_name": "Logos node", "start_url": "/", "scope": "/", "display": "standalone",
    "background_color": "#11110f", "theme_color": "#11110f",
    "icons": [{"src": "/lambda-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
              {"src": "/lambda-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
              {"src": "/lambda-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}).encode()
_icons = {}
# the lambda, as thick round-ended strokes on a unit square: the long leg, the short leg, the top hook
LAMBDA = (((0.375, 0.255), (0.665, 0.745)), ((0.508, 0.480), (0.335, 0.745)), ((0.315, 0.275), (0.375, 0.255)))


def icon_png(n, maskable=False):
    """The app icon, drawn in code: a black lambda on a cream circle. `maskable` fills the whole square with
    cream and shrinks the lambda into the safe zone, for launchers that cut their own shape."""
    if (n, maskable) in _icons:
        return _icons[(n, maskable)]
    import struct, zlib
    cream, black = (0xf3, 0xea, 0xd7), (0x14, 0x13, 0x11)
    c, radius = (n - 1) / 2.0, n / 2.0 - 0.5
    scale = 0.74 if maskable else 1.0
    half = 0.045 * n * scale
    segs = [tuple((c + (x - 0.5) * n * scale, c + (y - 0.5) * n * scale) for x, y in seg) for seg in LAMBDA]

    def stroke(px, py):
        best = 1e9
        for (ax, ay), (bx, by) in segs:
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
            best = min(best, ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5)
        return max(0.0, min(1.0, half - best + 0.5))
    rows = []
    for y in range(n):
        row = bytearray([0])
        for x in range(n):
            disc = 1.0 if maskable else max(0.0, min(1.0, radius - ((x - c) ** 2 + (y - c) ** 2) ** 0.5 + 0.5))
            ink = stroke(x, y) if disc > 0 else 0.0
            row += bytes(int(round(a + (b - a) * ink)) for a, b in zip(cream, black)) + bytes([int(round(255 * disc))])
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    _icons[(n, maskable)] = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
                             + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
    return _icons[(n, maskable)]


# ---- fingerprint unlock (a WebAuthn passkey) -------------------------------------------------
# The browser only allows passkeys on a name, not on a bare IP address, so this works when the
# page is opened as http://localhost:PORT. The PIN stays as the fallback and is needed to turn
# fingerprint unlock on. Signatures are ECDSA P-256 / SHA-256, checked here with plain integers
# (verification only handles public values, so it needs no constant-time care).

PASSKEY_FILE = os.path.join(DATA_DIR, "wallet-passkeys.json")
RP_ID = "localhost"
PASSKEY_ORIGIN = "http://localhost:%d" % PORT
challenges = {}      # "reg" / "get" -> (challenge bytes, expiry time)

P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
P256_G = (0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
          0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)
P256_OID = bytes.fromhex("2a8648ce3d030107")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(v):
    v = str(v)
    return base64.urlsafe_b64decode(v + "=" * (-len(v) % 4))


def _ec_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    (x1, y1), (x2, y2) = a, b
    if x1 == x2:
        if (y1 + y2) % P256_P == 0:
            return None
        lam = (3 * x1 * x1 - 3) * pow(2 * y1, -1, P256_P) % P256_P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, P256_P) % P256_P
    x3 = (lam * lam - x1 - x2) % P256_P
    return x3, (lam * (x1 - x3) - y1) % P256_P


def _ec_mul(k, pt):
    out = None
    while k:
        if k & 1:
            out = _ec_add(out, pt)
        pt = _ec_add(pt, pt)
        k >>= 1
    return out


def p256_on_curve(x, y):
    return 0 < x < P256_P and 0 < y < P256_P and (y * y - (x * x * x - 3 * x + P256_B)) % P256_P == 0


def p256_verify(x, y, digest, sig):
    """True if `sig` (DER) is a valid ECDSA P-256 signature of the 32-byte `digest` under public key (x, y)."""
    try:
        if len(sig) < 8 or sig[0] != 0x30 or sig[1] != len(sig) - 2 or sig[2] != 0x02:
            return False
        lr = sig[3]
        r = int.from_bytes(sig[4:4 + lr], "big")
        j = 4 + lr
        if sig[j] != 0x02 or j + 2 + sig[j + 1] != len(sig):
            return False
        s_ = int.from_bytes(sig[j + 2:], "big")
        if not (0 < r < P256_N and 0 < s_ < P256_N) or not p256_on_curve(x, y):
            return False
        w = pow(s_, -1, P256_N)
        z = int.from_bytes(digest, "big")
        pt = _ec_add(_ec_mul(z * w % P256_N, P256_G), _ec_mul(r * w % P256_N, (x, y)))
        return pt is not None and pt[0] % P256_N == r
    except Exception:
        return False


def passkeys_load():
    try:
        with open(PASSKEY_FILE) as f:
            d = json.load(f)
        if isinstance(d.get("keys"), list) and d.get("user_id"):
            return d
    except Exception:
        pass
    return {"user_id": b64u(secrets.token_bytes(16)), "keys": []}


def passkeys_save(d):
    tmp = PASSKEY_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.replace(tmp, PASSKEY_FILE)


def challenge_new(kind):
    c = secrets.token_bytes(32)
    with lock:
        challenges[kind] = (c, time.time() + 120)
    return c


def challenge_take(kind):
    with lock:
        c, until = challenges.pop(kind, (None, 0))
    return c if c and time.time() < until else None


def webauthn_ok(client_data, auth_data, kind, challenge):
    """Checks what the browser and the authenticator say about a passkey operation."""
    try:
        cd = json.loads(client_data)
    except Exception:
        return False
    if not challenge or cd.get("type") != kind or cd.get("origin") != PASSKEY_ORIGIN or cd.get("crossOrigin"):
        return False
    if not hmac.compare_digest(str(cd.get("challenge", "")), b64u(challenge)):
        return False
    if len(auth_data) < 37 or auth_data[:32] != hashlib.sha256(RP_ID.encode()).digest():
        return False
    return auth_data[32] & 0x05 == 0x05          # user present and user verified (fingerprint, face or screen lock)


def passkey_register(body):
    try:
        cid, client, auth, spki = (b64u_dec(body.get(k, "")) for k in ("id", "clientDataJSON", "authenticatorData", "publicKey"))
    except Exception:
        return 400, {"error": "bad request"}
    if not webauthn_ok(client, auth, "webauthn.create", challenge_take("reg")):
        return 400, {"error": "The fingerprint setup didn't check out. Try again."}
    if len(spki) < 65 or spki[-65] != 0x04 or P256_OID not in spki or not 0 < len(cid) <= 1024:
        return 400, {"error": "This device offered a key type the wallet can't use."}
    x, y = int.from_bytes(spki[-64:-32], "big"), int.from_bytes(spki[-32:], "big")
    if not p256_on_curve(x, y):
        return 400, {"error": "This device offered a key the wallet can't use."}
    d = passkeys_load()
    d["keys"] = [k for k in d["keys"] if k["id"] != b64u(cid)][-4:] + [{"id": b64u(cid), "x": "%064x" % x, "y": "%064x" % y, "added": int(time.time())}]
    passkeys_save(d)
    return 200, {"ok": True, "passkeys": len(d["keys"])}


def passkey_unlock(body):
    try:
        cid, client, auth, sig = (b64u_dec(body.get(k, "")) for k in ("id", "clientDataJSON", "authenticatorData", "signature"))
    except Exception:
        return 400, {"error": "bad request"}
    key = next((k for k in passkeys_load()["keys"] if k["id"] == b64u(cid)), None)
    if not key or not webauthn_ok(client, auth, "webauthn.get", challenge_take("get")):
        return 401, {"error": "Fingerprint unlock failed. Use your PIN."}
    digest = hashlib.sha256(auth + hashlib.sha256(client).digest()).digest()
    if not p256_verify(int(key["x"], 16), int(key["y"], 16), digest, sig):
        return 401, {"error": "Fingerprint unlock failed. Use your PIN."}
    return 200, {"session": session_new()}


# ---- HTTP -----------------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "LogosNodeApp"

    def reply(self, code, obj=None, ctype="application/json", raw=None):
        data = raw if raw is not None else json.dumps(obj, separators=(",", ":")).encode()
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
        if path in ("/lambda-192.png", "/lambda-512.png", "/lambda-maskable-512.png"):
            return self.reply(200, raw=icon_png(192 if "192" in path else 512, "maskable" in path), ctype="image/png")
        if path == "/api/status":
            st = node_status()
            return self.reply(200, {"node": st} if st else {"node": None, "waiting": node_waiting()})
        if path in ("/cryptarchia/info", "/network/info"):       # read-only pass-through
            code, reply = node(path, timeout=5)
            return self.reply(200 if code == 200 else 502, reply if code == 200 else {"error": "node not answering"})
        if path == "/api/wallet":
            with lock:
                wait = max(0, int(fails["until"] - time.time()))
            return self.reply(200, {"pin_set": pin_is_set(), "unlocked": self.authed(), "wait": wait,
                                    "passkeys": len(passkeys_load()["keys"])})
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
            body = json.loads(self.rfile.read(n) or b"{}") if 0 <= n <= 16384 else None
        except Exception:
            body = None
        if not isinstance(body, dict):
            return self.reply(400, {"error": "bad request"})
        path = self.path.split("?", 1)[0]
        if path == "/api/wallet/setup":
            pin = str(body.get("pin", ""))
            if not PIN_RE.match(pin):
                return self.reply(400, {"error": "The PIN must be 6 to 12 digits."})
            try:
                pin_save(pin)
            except FileExistsError:
                return self.reply(409, {"error": "A PIN is already set."})
            event("pin set", self)
            return self.reply(200, {"session": session_new()})
        if path == "/api/wallet/unlock":
            with lock:
                wait = int(fails["until"] - time.time())
            if wait > 0:
                return self.reply(429, {"error": "Too many wrong PINs. Try again in %d seconds." % wait, "wait": wait})
            if pin_is_set() and pin_check(str(body.get("pin", ""))):
                with lock:
                    fails["count"] = 0
                event("unlock by PIN ok", self)
                return self.reply(200, {"session": session_new()})
            with lock:
                fails["count"] += 1
                n, paused = fails["count"], fails["count"] >= MAX_FAILS
                if paused:
                    fails["count"], fails["until"] = 0, time.time() + FAIL_PAUSE
            event("unlock by PIN failed", self, attempt=n)
            if paused:
                event("lockout started", self, seconds=FAIL_PAUSE)
            return self.reply(401, {"error": "Wrong PIN."})
        if path == "/api/wallet/passkey/challenge":
            d = passkeys_load()
            if not d["keys"]:
                return self.reply(404, {"error": "Fingerprint unlock isn't turned on."})
            return self.reply(200, {"challenge": b64u(challenge_new("get")), "rpId": RP_ID, "ids": [k["id"] for k in d["keys"]]})
        if path == "/api/wallet/passkey/unlock":
            code, obj = passkey_unlock(body)
            event("unlock by fingerprint ok" if code == 200 else "unlock by fingerprint failed", self)
            return self.reply(code, obj)
        if path in ("/api/wallet/passkey/options", "/api/wallet/passkey/register", "/api/wallet/passkey/remove"):
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            d = passkeys_load()
            if path.endswith("/options"):
                return self.reply(200, {"challenge": b64u(challenge_new("reg")), "rpId": RP_ID, "userId": d["user_id"],
                                        "exclude": [k["id"] for k in d["keys"]]})
            if path.endswith("/remove"):
                removed = len(d["keys"])
                d["keys"] = []
                passkeys_save(d)
                event("fingerprint keys removed", self, removed=removed)
                return self.reply(200, {"ok": True, "passkeys": 0})
            code, obj = passkey_register(body)
            if code == 200:
                event("fingerprint key added", self, total=obj.get("passkeys"))
            return self.reply(code, obj)
        if path == "/api/wallet/lock":
            had = self.authed()
            with lock:
                session["token"] = None
            event("wallet locked", self, by_unlocked_page="yes" if had else "no")
            return self.reply(200, {"ok": True})
        if path == "/api/wallet/send":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            code, obj = send(body)
            if code == 200:
                event("transfer sent", self, hash=obj.get("hash"))
            return self.reply(code, obj)
        return self.reply(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    event("app start", port=PORT)
    threading.Thread(target=wallet_keys, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

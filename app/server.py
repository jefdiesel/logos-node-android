#!/usr/bin/env python3
"""Local web app for a Logos node running on the same device: node status plus a small wallet.

It listens on 127.0.0.1 only and talks to the node's own API at NODE_API (127.0.0.1:8080 unless set;
the Linux Terminal install uses port 880).
Python standard library only. Wallet calls need a PIN that is set on first use.
"""
import base64, hashlib, hmac, http.server, json, os, re, secrets, shlex, shutil, struct, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request

APP_VERSION = "0.7.2"       # set by tools/release.py, which also writes release.json
HOME = os.path.expanduser("~")
NODE_API = os.environ.get("NODE_API", "http://127.0.0.1:8080")
NODE_BIN = os.environ.get("NODE_BIN", HOME + "/node/logos-blockchain-node")
NODE_CFG = os.environ.get("NODE_CFG", HOME + "/node/run/user_config.yaml")
NODE_DEPLOYMENT = os.environ.get("NODE_DEPLOYMENT", "")
# How to restart the node after a restore, e.g. "sudo -n systemctl restart logos-node" (set by install.sh).
# Empty where the app can't restart it (Termux): the page then says how to do it by hand.
NODE_RESTART_CMD = os.environ.get("NODE_RESTART_CMD", "")
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


# ---- outside requests (name service, updates) -------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None                       # a redirect is answered as an error, never followed


_outside = urllib.request.build_opener(_NoRedirect)


def outside_url_ok(url):
    """HTTPS only; plain HTTP only to this machine itself, which tests use."""
    u = urllib.parse.urlsplit(url)
    return bool(u.hostname) and (u.scheme == "https" or (u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost", "::1")))


def fetch_outside(url, body=None, cap=65536, timeout=8):
    """GET (or POST `body` as JSON) to a fixed outside URL: no redirects, at most `cap` bytes.
    Returns (http status, bytes); raises on a bad URL, no answer or an answer that is too big."""
    if not outside_url_ok(url):
        raise ValueError("refused URL")
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "logos-node-app"})
    try:
        with _outside.open(req, timeout=timeout) as r:
            code, data = r.status, r.read(cap + 1)
    except urllib.error.HTTPError as e:
        code, data = e.code, e.read(cap + 1)
    if len(data) > cap:
        raise ValueError("answer too big")
    return code, data


# ---- LNS names: the page resolves names itself; this only forwards the one read it needs -----
# The page runs the names project's reference resolver (names/names.js). The name never leaves
# the device: the page derives the name's record account and asks the sequencer for that account,
# through here so the page can keep talking to this app only. Only getAccount of one account id
# is forwarded. Defaults are the names project's own public testnet ones (mcp/server.js).

NAMES_RPC_URL = os.environ.get("NAMES_RPC_URL", "https://testnet.lez.logos.co")
NAMES_PROGRAM = os.environ.get("NAMES_PROGRAM", "38jEfVV1RCyMzu1FGbYcCn5FqxCxKyY58VgzjruAh2gq")
ACCOUNT_ID_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
NAME_RE = re.compile(r"^(?!-)[a-z0-9-]{1,32}(?<!-)$")
NAMES_DIR = os.path.join(APP_DIR, "names")
NAMES_FILE_RE = re.compile(r"^/names/((?:noble-hashes/)?[A-Za-z0-9_][A-Za-z0-9_.-]*\.js)$")


def names_rpc(body):
    """(http status, reply bytes or object) for one getAccount read, forwarded to the sequencer."""
    params = body.get("params")
    if body.get("method") != "getAccount" or not isinstance(params, list) or len(params) != 1 \
            or not ACCOUNT_ID_RE.match(str(params[0])):
        return 400, {"error": "Only getAccount of one account id is forwarded."}
    try:
        code, data = fetch_outside(NAMES_RPC_URL, {"jsonrpc": "2.0", "id": body.get("id", 1) if isinstance(body.get("id"), int) else 1,
                                                   "method": "getAccount", "params": [str(params[0])]}, cap=262144, timeout=8)
        reply = json.loads(data)
    except Exception:
        return 502, {"error": "The name service isn't answering."}
    if code != 200 or not isinstance(reply, dict):
        return 502, {"error": "The name service isn't answering."}
    return 200, data


# ---- updates: new app files from the project's GitHub repository ------------------------------
# release.json lists the version and the SHA-256 of every app file. It is read from the repository's
# `release` branch, which CI moves forward only after every test passed on main. The app looks at it at most
# every UPDATE_EVERY seconds, or when an unlocked wallet asks. Applying needs an unlocked wallet
# and the PIN, downloads every file, checks each hash, compiles the Python, keeps the old files
# as <name>.prev, swaps the new ones in and re-executes this process. The node is not touched.

UPDATE_URL = os.environ.get("UPDATE_URL", "https://raw.githubusercontent.com/jefdiesel/logos-node-android/release/app/")
UPDATE_EVERY = 6 * 3600
UPDATE_FILE_CAP, UPDATE_TOTAL_CAP = 4 * 1024 * 1024, 16 * 1024 * 1024
UPDATE_NAME_RE = re.compile(r"^(?:[a-z0-9][a-z0-9_-]*/){0,2}[A-Za-z0-9_][A-Za-z0-9_.-]*$")
VERSION_RE = re.compile(r"^\d{1,6}(?:\.\d{1,6}){0,3}$")
APP_FILE = os.path.abspath(__file__)
update_state = {"latest": None, "checked": 0.0, "error": None}
update_lock = threading.Lock()


def version_tuple(v):
    return tuple(int(x) for x in v.split(".")) if VERSION_RE.match(str(v)) else None


def update_name_ok(name):
    """A file an update may write: inside the app folder, never this app's wallet data or old copies."""
    base = name.rsplit("/", 1)[-1]
    return bool(UPDATE_NAME_RE.match(name)) and ".." not in name and not base.startswith("wallet-") \
        and not base.endswith((".prev", ".tmp")) and base != "release.json"


def update_release():
    """release.json from the update source, checked for shape. Raises with a plain message."""
    if not UPDATE_URL.endswith("/"):
        raise ValueError("The update address must end with /.")
    try:
        code, data = fetch_outside(UPDATE_URL + "release.json", cap=65536, timeout=15)
        rel = json.loads(data) if code == 200 else None
    except Exception:
        rel = None
    if not isinstance(rel, dict):
        raise ValueError("Couldn't read the release list from GitHub.")
    files = rel.get("files")
    if version_tuple(rel.get("version")) is None or not isinstance(files, dict) or "server.py" not in files or not all(
            update_name_ok(n) and isinstance(h, str) and re.match(r"^[0-9a-f]{64}$", h) for n, h in files.items()):
        raise ValueError("The release list isn't valid.")
    return rel, data


def update_check():
    """Looks for a newer release. Returns the state the page sees."""
    with update_lock:
        try:
            rel, _ = update_release()
            newer = version_tuple(rel["version"]) > version_tuple(APP_VERSION)
            update_state.update(latest=rel["version"] if newer else None, error=None)
        except Exception as e:
            update_state["error"] = str(e)
        update_state["checked"] = time.time()
        return update_public()


def update_public():
    return {"current": APP_VERSION, "available": update_state["latest"], "error": update_state["error"],
            "source": "github.com/jefdiesel/logos-node-android" if UPDATE_URL.startswith("https://raw.githubusercontent.com/jefdiesel/logos-node-android/release/") else UPDATE_URL}


def update_loop():
    while True:
        update_check()
        time.sleep(UPDATE_EVERY)


def update_apply():
    """(http status, reply). On success the caller restarts this process."""
    with update_lock:
        try:
            rel, raw = update_release()
        except Exception as e:
            return 502, {"error": str(e)}
        if version_tuple(rel["version"]) <= version_tuple(APP_VERSION):
            return 409, {"error": "This app is already at version %s." % APP_VERSION}
        tmp = tempfile.mkdtemp(prefix=".update-", dir=APP_DIR)
        try:
            total = 0
            for name, digest in rel["files"].items():
                try:
                    code, data = fetch_outside(UPDATE_URL + name, cap=UPDATE_FILE_CAP, timeout=30)
                except Exception:
                    code, data = 0, b""
                total += len(data)
                if code != 200 or total > UPDATE_TOTAL_CAP:
                    return 502, {"error": "Couldn't download %s from GitHub. Nothing was changed." % name}
                if hashlib.sha256(data).hexdigest() != digest:
                    return 409, {"error": "%s doesn't match the release list, so the update was refused. Nothing was changed." % name}
                if name.endswith(".py"):
                    try:
                        compile(data, name, "exec")
                    except Exception:
                        return 409, {"error": "%s in the new release doesn't compile, so the update was refused. Nothing was changed." % name}
                os.makedirs(os.path.dirname(os.path.join(tmp, name)), exist_ok=True)
                with open(os.path.join(tmp, name), "wb") as f:
                    f.write(data)
            with open(os.path.join(tmp, "release.json"), "wb") as f:
                f.write(raw)
            # everything checked out: keep each old file as .prev, then swap the new one in (server.py last)
            for name in sorted(rel["files"], key=lambda n: n == "server.py") + ["release.json"]:
                dst = os.path.join(APP_DIR, name)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if os.path.exists(dst):
                    shutil.copy2(dst, dst + ".prev")
                os.replace(os.path.join(tmp, name), dst)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        update_state.update(latest=None, error=None)
        return 200, {"ok": True, "from": APP_VERSION, "to": rel["version"]}


def restart_soon():
    """Re-executes this app in place (same process id), after the reply has gone out. Works the same
    under systemd and under Termux's start script; the node keeps running."""
    def go():
        time.sleep(0.7)
        try:
            sys.stdout.flush(); sys.stderr.flush()
        except Exception:
            pass
        os.execv(sys.executable, [sys.executable, APP_FILE] + sys.argv[1:])
    threading.Thread(target=go, daemon=True).start()


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


def show_config():
    """The node's effective config (`--show-config`; secrets are redacted there)."""
    cmd = [NODE_BIN]
    if NODE_DEPLOYMENT:
        cmd += ["--deployment", NODE_DEPLOYMENT]
    cmd += ["--show-config", NODE_CFG]
    return subprocess.run(cmd, cwd=os.path.dirname(NODE_CFG), capture_output=True, text=True, timeout=30).stdout


def parse_keystore(text):
    """`kms.keystore` from the node's effective config: the key file, relative to the config file. None if not there."""
    top, child = None, None
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            top, child = s.rstrip(":"), None
            continue
        if top == "kms":
            child = indent if child is None else child
            m = re.match(r"^keystore:\s*(.+?)\s*$", s)
            if m and indent == child:
                return m.group(1).strip("'\"") or None
    return None


def wallet_keys():
    with lock:
        # re-read the node's settings every minute, so keys changed outside the app show up
        if time.time() - keys_cache["at"] < (60 if keys_cache["keys"] else 20):
            return keys_cache["keys"]
        keys_cache["at"] = time.time()
    try:
        found = parse_keys(show_config())
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

def pin_attempt(req, pin, failed_event):
    """Checks a typed PIN, with the shared pause after MAX_FAILS wrong ones (unlock, backup and update all
    count). Returns None when the PIN is right, else (http status, reply). `failed_event` names the log line.
    Something that isn't a PIN at all (empty, or not 6 to 12 digits) is refused without counting or logging it:
    it is a typing slip, not a guess."""
    if not PIN_RE.match(pin):
        return 400, {"error": "Enter your PIN: 6 to 12 digits.", "malformed": True}
    with lock:
        wait = int(fails["until"] - time.time())
    if wait > 0:
        return 429, {"error": "Too many wrong PINs. Try again in %d seconds." % wait, "wait": wait}
    if pin_is_set() and pin_check(pin):
        with lock:
            fails["count"] = 0
        return None
    with lock:
        fails["count"] += 1
        n, paused = fails["count"], fails["count"] >= MAX_FAILS
        if paused:
            fails["count"], fails["until"] = 0, time.time() + FAIL_PAUSE
    event(failed_event, req, attempt=n)
    if paused:
        event("lockout started", req, seconds=FAIL_PAUSE)
        return 401, {"error": "Wrong PIN. That was %d wrong in a row, so PINs are paused for %d minutes." % (MAX_FAILS, FAIL_PAUSE // 60),
                     "tries_left": 0, "wait": FAIL_PAUSE}
    left = MAX_FAILS - n
    return 401, {"error": "Wrong PIN. %d %s left before a %d-minute pause." % (left, "try" if left == 1 else "tries", FAIL_PAUSE // 60),
                 "tries_left": left}


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

def notes_of(key):
    """{note id: amount} for one of this node's wallet keys ({} for a key that never received anything, as the
    node answers 404 then), or None when the node gives no usable answer (it answers 500 while syncing)."""
    code, reply = node("/wallet/%s/balance" % key)
    if code == 200 and isinstance(reply, dict):
        return {str(i): as_int(v) for i, v in (reply.get("notes") or {}).items()}
    if code == 404 and isinstance(reply, dict) and reply.get("code") == 404:
        return {}
    return None


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
    labels = {k["key"]: k["label"] for k in wallet_keys()}
    entry = {"key": frm, "label": labels.get(frm, ""), "to": to, "amount": str(amount), "fee": None,
             "hash": reply["hash"], "status": "pending", "height": st.get("height")}
    if to in labels:
        entry["to_label"] = labels[to]
    name = str(body.get("name") or "")
    if NAME_RE.match(name):                 # the LNS name the page resolved `to` from, kept for the history
        entry["name"] = name
    history_record_send(entry)
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


# ---- history: what came in and went out, tracked by the server itself ---------------------------
# The node has no history endpoint, so every HISTORY_POLL seconds, while the node is online, the
# server reads each wallet key's notes and records what changed: notes that appear are "received",
# notes spent by a transfer this app sent mark that "sent" entry as in a block (with its fee), and
# anything else is recorded as "changed" by the difference, not guessed at. The first look writes
# one "tracking started" entry with the balances found; nothing before it is known. Kept in
# DATA_DIR/wallet-history.json (owner-only), which also holds which receipts were already shown.

HISTORY_FILE = os.path.join(DATA_DIR, "wallet-history.json")
HISTORY_MAX, HISTORY_KEEP = 1000, 500
HISTORY_POLL = int(os.environ.get("HISTORY_POLL", "15"))
hist_lock = threading.Lock()


def history_load():
    try:
        with open(HISTORY_FILE) as f:
            h = json.load(f)
        if isinstance(h.get("entries"), list) and isinstance(h.get("snapshot"), dict):
            return h
    except Exception:
        pass
    return {"version": 1, "next_id": 1, "seen": 0, "snapshot": {}, "entries": []}


history = history_load()


def history_save():
    """Writes the history; the caller holds hist_lock."""
    if len(history["entries"]) > HISTORY_MAX:
        history["entries"] = history["entries"][-HISTORY_KEEP:]
    tmp = HISTORY_FILE + ".tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(history, f)
        os.replace(tmp, HISTORY_FILE)
    except Exception:
        pass


def history_add(kind, **fields):
    """Adds an entry; the caller holds hist_lock and saves."""
    e = {"id": history["next_id"], "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": kind}
    e.update(fields)
    history["next_id"] += 1
    history["entries"].append(e)
    return e


def history_record_send(entry):
    with hist_lock:
        history_add("sent", **entry)
        history_save()


def history_round():
    """One look at the wallet. Does nothing unless the node is online and answers."""
    st = node_status()
    if not st or st.get("state") != "Online":
        return
    keys = wallet_keys()
    if not keys:
        return
    labels = {k["key"]: k["label"] for k in keys}
    found = {}
    for k in keys:
        n = notes_of(k["key"])
        if n is not None:
            found[k["key"]] = n
    height = st.get("height")
    with hist_lock:
        if not history["snapshot"]:
            if len(found) < len(keys):
                return                       # wait until every key answers, for a complete starting point
            bal = [{"key": k, "label": labels[k], "balance": str(sum(found[k].values()))} for k in labels]
            history_add("tracking started", height=height, balances=bal, amount=str(sum(int(b["balance"]) for b in bal)))
            history["snapshot"] = found
            return history_save()
        changed = False
        for key, new in found.items():
            old = history["snapshot"].get(key)
            label = labels.get(key, "")
            if old is None:                  # a key that wasn't in the wallet before, e.g. restored from a backup
                history_add("tracking started", key=key, label=label, amount=str(sum(new.values())), height=height)
                history["snapshot"][key], changed = new, True
                continue
            added = {i: v for i, v in new.items() if i not in old}
            removed = {i: v for i, v in old.items() if i not in new}
            if not added and not removed:
                continue
            changed = True
            if removed:
                out = sum(removed.values()) - sum(added.values())
                pending = [e for e in history["entries"] if e["kind"] == "sent" and e.get("status") == "pending" and e["key"] == key]
                if len(pending) == 1 and out >= int(pending[0]["amount"]):
                    # our own transfer is in a block: what left the key beyond the amount is the fee
                    pending[0].update(status="in block", fee=str(out - int(pending[0]["amount"])), landed_height=height,
                                      landed=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                else:
                    history_add("changed", key=key, label=label, amount=str(-out), height=height)
            else:
                for i, v in added.items():
                    history_add("received", key=key, label=label, amount=str(v), note=i, height=height)
            history["snapshot"][key] = new
        if changed:
            history_save()


def history_loop():
    while True:
        try:
            history_round()
        except Exception:
            pass
        time.sleep(HISTORY_POLL)


def history_page(before, limit):
    with hist_lock:
        out = [e for e in reversed(history["entries"]) if not before or e["id"] < before][:limit]
        return {"entries": [dict(e) for e in out], "tracking": bool(history["snapshot"])}


def receipts_take():
    """Received entries no page has been given yet. Handing them out marks them shown, for every page."""
    with hist_lock:
        new = [dict(e) for e in history["entries"] if e["kind"] == "received" and e["id"] > history["seen"]]
        if new:
            history["seen"] = max(e["id"] for e in new)
            history_save()
        return new


# ---- wallet backup: the node's key file, encrypted with scrypt + ChaCha20-Poly1305 (RFC 8439) ---
# The keys never reach the page: it only receives the encrypted file. The format is plain JSON with
# standard primitives, so it can be opened without this app (see tools/decrypt-backup.py, docs/backup.md).

BACKUP_FORMAT, BACKUP_VERSION = "logos-node-wallet-backup", 1
BACKUP_AAD = b"logos-node-wallet-backup v1"
BACKUP_SCRYPT = {"n": 2 ** 16, "r": 8, "p": 1, "dklen": 32}
MIN_BACKUP_PASSWORD = 12
_M32 = 0xffffffff


def _quarter(w, a, b, c, d):
    w[a] = (w[a] + w[b]) & _M32; x = w[d] ^ w[a]; w[d] = ((x << 16) | (x >> 16)) & _M32
    w[c] = (w[c] + w[d]) & _M32; x = w[b] ^ w[c]; w[b] = ((x << 12) | (x >> 20)) & _M32
    w[a] = (w[a] + w[b]) & _M32; x = w[d] ^ w[a]; w[d] = ((x << 8) | (x >> 24)) & _M32
    w[c] = (w[c] + w[d]) & _M32; x = w[b] ^ w[c]; w[b] = ((x << 7) | (x >> 25)) & _M32


def chacha20_block(key, counter, nonce):
    """RFC 8439 section 2.3: one 64-byte keystream block (32-byte key, 32-bit counter, 12-byte nonce)."""
    state = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] + list(struct.unpack("<8I", key)) \
        + [counter & _M32] + list(struct.unpack("<3I", nonce))
    w = state[:]
    for _ in range(10):
        _quarter(w, 0, 4, 8, 12); _quarter(w, 1, 5, 9, 13); _quarter(w, 2, 6, 10, 14); _quarter(w, 3, 7, 11, 15)
        _quarter(w, 0, 5, 10, 15); _quarter(w, 1, 6, 11, 12); _quarter(w, 2, 7, 8, 13); _quarter(w, 3, 4, 9, 14)
    return struct.pack("<16I", *((w[i] + state[i]) & _M32 for i in range(16)))


def chacha20_xor(key, counter, nonce, data):
    """RFC 8439 section 2.4: encrypts or decrypts `data`, starting at block `counter`."""
    out = bytearray()
    for i in range(0, len(data), 64):
        chunk = data[i:i + 64]
        ks = chacha20_block(key, counter + i // 64, nonce)[:len(chunk)]
        out += (int.from_bytes(chunk, "little") ^ int.from_bytes(ks, "little")).to_bytes(len(chunk), "little")
    return bytes(out)


def poly1305(key, msg):
    """RFC 8439 section 2.5: the 16-byte tag of `msg` under a 32-byte one-time key."""
    r = int.from_bytes(key[:16], "little") & 0x0ffffffc0ffffffc0ffffffc0fffffff
    s, p, acc = int.from_bytes(key[16:32], "little"), (1 << 130) - 5, 0
    for i in range(0, len(msg), 16):
        acc = (acc + int.from_bytes(msg[i:i + 16] + b"\x01", "little")) * r % p
    return ((acc + s) & ((1 << 128) - 1)).to_bytes(16, "little")


def _aead_mac_data(aad, ct):
    return aad + b"\x00" * (-len(aad) % 16) + ct + b"\x00" * (-len(ct) % 16) + struct.pack("<QQ", len(aad), len(ct))


def aead_encrypt(key, nonce, plaintext, aad):
    """RFC 8439 section 2.8 AEAD_CHACHA20_POLY1305: returns ciphertext followed by the 16-byte tag."""
    ct = chacha20_xor(key, 1, nonce, plaintext)
    return ct + poly1305(chacha20_block(key, 0, nonce)[:32], _aead_mac_data(aad, ct))


def aead_decrypt(key, nonce, sealed, aad):
    """The plaintext, or None if the tag doesn't match."""
    if len(sealed) < 16:
        return None
    ct, tag = sealed[:-16], sealed[-16:]
    if not hmac.compare_digest(poly1305(chacha20_block(key, 0, nonce)[:32], _aead_mac_data(aad, ct)), tag):
        return None
    return chacha20_xor(key, 1, nonce, ct)


def backup_key(password, salt, kdf=BACKUP_SCRYPT):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=kdf["n"], r=kdf["r"], p=kdf["p"],
                          dklen=kdf["dklen"], maxmem=2 ** 27)


def keystore_location():
    """(path, where it came from): `kms.keystore` from the node's effective config, resolved against the config
    file's folder the way the node does it, or keystore.yaml beside the config when the config doesn't say."""
    try:
        found = parse_keystore(show_config())
    except Exception:
        found = None
    return os.path.join(os.path.dirname(os.path.abspath(NODE_CFG)), found or "keystore.yaml"), ("config" if found else "default")


BACKUP_STATE_FILE = os.path.join(DATA_DIR, "wallet-backup.json")


def last_backup():
    """When a backup was last exported (UTC), or None if never."""
    try:
        with open(BACKUP_STATE_FILE) as f:
            return json.load(f).get("last") or None
    except Exception:
        return None


def node_cmd(cfg, flag):
    cmd = [NODE_BIN] + (["--deployment", NODE_DEPLOYMENT] if NODE_DEPLOYMENT else []) + [flag, cfg]
    return subprocess.run(cmd, cwd=os.path.dirname(cfg), capture_output=True, text=True, timeout=60)


def restore_backup(doc, password):
    """(http status, reply, event detail). Puts the key file from a backup in place of the node's own,
    only after the node itself has checked it, and keeps the old one beside it."""
    if not isinstance(doc, dict) or doc.get("format") != BACKUP_FORMAT or doc.get("version") != BACKUP_VERSION:
        return 400, {"error": "This isn't a Logos node wallet backup, or it's a version this app can't read."}, "format"
    try:
        kdf, cipher = doc["kdf"], doc["cipher"]
        if kdf.get("name") != "scrypt" or cipher.get("name") != "chacha20-poly1305":
            raise ValueError
        params = {"n": int(kdf["n"]), "r": int(kdf["r"]), "p": int(kdf["p"]), "dklen": int(kdf["dklen"])}
        if not 2 <= params["n"] <= 2 ** 16 or not 1 <= params["r"] <= 8 or not 1 <= params["p"] <= 4 or params["dklen"] != 32:
            raise ValueError
        salt, nonce, sealed = (base64.b64decode(v, validate=True) for v in (kdf["salt"], cipher["nonce"], doc["ciphertext"]))
        header = sorted(str(a["key"]).lower() for a in doc.get("addresses", []))
    except Exception:
        return 400, {"error": "This backup file is damaged or isn't in the expected format."}, "format"
    try:
        plain = aead_decrypt(backup_key(password, salt, params), nonce, sealed, BACKUP_AAD) if len(nonce) == 12 else None
    except Exception:
        plain = None
    if plain is None:
        return 400, {"error": "Wrong backup password, or the file has been changed or damaged. Nothing was changed."}, "password"
    try:
        new_text = json.loads(plain)["keystore.yaml"]
        new_bytes = new_text.encode("utf-8")
    except Exception:
        return 400, {"error": "This backup file is damaged. Nothing was changed."}, "format"
    live, _ = keystore_location()
    if not os.path.isfile(live):
        return 409, {"error": "This node keeps its keys in its config file, so a backup can't be restored into it here."}, "no keystore"
    try:
        rel = parse_keystore(show_config()) or "keystore.yaml"
    except Exception:
        rel = "keystore.yaml"
    if os.path.isabs(rel):
        return 409, {"error": "This node's settings name its key file by a full path, so restore it by hand (see docs/backup.md)."}, "path"
    # let the node itself read the recovered key file, with a copy of its settings, before touching anything
    tmp = tempfile.mkdtemp(prefix=".restore-", dir=os.path.dirname(live))
    try:
        cfg = os.path.join(tmp, os.path.basename(NODE_CFG))
        shutil.copy2(NODE_CFG, cfg)
        ks = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(ks), exist_ok=True)
        fd = os.open(ks, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(new_bytes)
        ok = node_cmd(cfg, "--check-config").returncode == 0
        reported = sorted(k["key"] for k in parse_keys(node_cmd(cfg, "--show-config").stdout)) if ok else []
    except Exception:
        ok, reported = False, []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not ok or not reported:
        return 409, {"error": "The node doesn't accept the key file in this backup. Nothing was changed."}, "node check"
    if header and reported != header:
        return 409, {"error": "The keys in this backup don't match the addresses written on it. Nothing was changed."}, "addresses"
    try:
        current = sorted(k["key"] for k in parse_keys(show_config()))
    except Exception:
        current = []
    if reported == current:
        return 200, {"unchanged": True, "message": "These are the keys this wallet already uses. Nothing was changed."}, "same keys"
    # keep the old key file beside the new one, then swap the new one in atomically
    if os.path.exists(live):
        old = live + ".replaced-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        fd = os.open(old, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f, open(live, "rb") as src:
            f.write(src.read())
    fd = os.open(live + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(new_bytes)
    os.replace(live + ".tmp", live)
    with lock:
        keys_cache["keys"], keys_cache["at"] = [], 0.0       # the wallet's key list comes from the new file now
    restarted = False
    if NODE_RESTART_CMD:
        try:
            restarted = subprocess.run(shlex.split(NODE_RESTART_CMD), capture_output=True, timeout=90).returncode == 0
        except Exception:
            restarted = False
    reply = {"ok": True, "restarted": restarted, "addresses": len(reported), "replaced": len(current)}
    if not restarted:
        reply["manual"] = ("The keys are in place. Restart the node to use them: in Termux, press Ctrl-C where the node runs, "
                           "then start it again with ~/logos-node. In the Linux Terminal app: sudo systemctl restart logos-node.")
    return 200, reply, "restored"


def backup_export(password):
    """(http status, reply, keystore source). The reply holds only the encrypted backup or an error without key material."""
    path, source = keystore_location()
    if not os.path.isfile(path):
        return 409, {"error": "This node keeps its keys in its config file, so there is nothing to export.", "no_keystore": True}, source
    try:
        with open(path, "rb") as f:
            text = f.read().decode("utf-8")
    except Exception:
        return 500, {"error": "The node's key file couldn't be read."}, source
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    sealed = aead_encrypt(backup_key(password, salt), nonce, json.dumps({"keystore.yaml": text}).encode(), BACKUP_AAD)
    b64 = lambda b: base64.b64encode(b).decode()
    created = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        fd = os.open(BACKUP_STATE_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"last": created}, f)
        os.replace(BACKUP_STATE_FILE + ".tmp", BACKUP_STATE_FILE)
    except Exception:
        pass
    return 200, {"backup": {
        "format": BACKUP_FORMAT, "version": BACKUP_VERSION,
        "created": created,
        "addresses": [{"label": k["label"], "key": k["key"]} for k in wallet_keys()],
        "kdf": dict(BACKUP_SCRYPT, name="scrypt", salt=b64(salt)),
        "cipher": {"name": "chacha20-poly1305", "nonce": b64(nonce), "aad": BACKUP_AAD.decode()},
        "ciphertext": b64(sealed)}}, source


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


def passkey_assertion_ok(body, purpose):
    """True if `body` is a fresh fingerprint confirmation made for `purpose` ("get" = unlock, "update"):
    each purpose has its own one-time challenge, so a confirmation made for one can't be used for another."""
    if not isinstance(body, dict):
        return False
    try:
        cid, client, auth, sig = (b64u_dec(body.get(k, "")) for k in ("id", "clientDataJSON", "authenticatorData", "signature"))
    except Exception:
        return False
    key = next((k for k in passkeys_load()["keys"] if k["id"] == b64u(cid)), None)
    challenge = challenge_take(purpose)
    if not key or not webauthn_ok(client, auth, "webauthn.get", challenge):
        return False
    digest = hashlib.sha256(auth + hashlib.sha256(client).digest()).digest()
    return p256_verify(int(key["x"], 16), int(key["y"], 16), digest, sig)


def passkey_unlock(body):
    if not passkey_assertion_ok(body, "get"):
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
                             "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(data)

    def host_ok(self):
        # refuse requests that reached us under another name (DNS rebinding)
        return self.headers.get("Host", "") in HOSTS

    def authed(self):
        return session_ok(self.headers.get("X-Session", ""))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        # This app only listens on 127.0.0.1. The status endpoints are safe for something else on the
        # device to pass on to its network; everything else answers only to requests addressed to
        # this device itself (127.0.0.1 or localhost), never under another host name.
        if path.startswith("/api/wallet") and not self.host_ok():
            return self.reply(403, {"error": "The wallet only opens on the device that runs the node.", "local_only": True})
        if path == "/":
            try:
                with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
                    page = f.read().replace(b"__APP_VERSION__", APP_VERSION.encode())
                return self.reply(200, raw=page, ctype="text/html; charset=utf-8")
            except Exception:
                return self.reply(500, {"error": "index.html is missing"})
        m = NAMES_FILE_RE.match(path)
        if m:                               # the names resolver, served as files so the page can import it
            try:
                with open(os.path.join(NAMES_DIR, m.group(1)), "rb") as f:
                    return self.reply(200, raw=f.read(), ctype="text/javascript; charset=utf-8")
            except Exception:
                return self.reply(404, {"error": "not found"})
        if path == "/manifest.webmanifest":
            return self.reply(200, raw=MANIFEST, ctype="application/manifest+json")
        if path in ("/lambda-192.png", "/lambda-512.png", "/lambda-maskable-512.png"):
            return self.reply(200, raw=icon_png(192 if "192" in path else 512, "maskable" in path), ctype="image/png")
        if path == "/api/status":
            st = node_status()
            out = {"node": st} if st else {"node": None, "waiting": node_waiting()}
            out.update(version=APP_VERSION, update={"available": update_state["latest"]})
            return self.reply(200, out)
        if path in ("/cryptarchia/info", "/network/info"):       # read-only pass-through
            code, reply = node(path, timeout=5)
            return self.reply(200 if code == 200 else 502, reply if code == 200 else {"error": "node not answering"})
        if path == "/api/wallet":
            with lock:
                wait = max(0, int(fails["until"] - time.time()))
            return self.reply(200, {"pin_set": pin_is_set(), "unlocked": self.authed(), "wait": wait,
                                    "passkeys": len(passkeys_load()["keys"]), "names_program": NAMES_PROGRAM})
        if path == "/api/wallet/accounts":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            return self.reply(200, {"accounts": accounts(), "node": node_status(), "last_backup": last_backup()})
        if path == "/api/wallet/history":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            m1, m2 = re.search(r"[?&]before=(\d{1,12})", self.path), re.search(r"[?&]limit=(\d{1,4})", self.path)
            return self.reply(200, history_page(int(m1.group(1)) if m1 else 0, min(200, int(m2.group(1)) if m2 else 50)))
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
            body = json.loads(self.rfile.read(n) or b"{}") if 0 <= n <= 65536 else None
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
            refused = pin_attempt(self, str(body.get("pin", "")), "unlock by PIN failed")
            if refused:
                return self.reply(*refused)
            event("unlock by PIN ok", self)
            return self.reply(200, {"session": session_new()})
        if path == "/api/wallet/restore":
            # replaces the node's keys: needs an unlocked page AND the PIN typed again
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            refused = pin_attempt(self, str(body.get("pin", "")), "restore refused, wrong PIN")
            if refused:
                code, obj = refused
                return self.reply(403 if code == 401 else code, obj)
            code, obj, why = restore_backup(body.get("backup"), str(body.get("password", "")))
            if obj.get("ok"):
                event("wallet restored", self, old_keys=obj["replaced"], new_keys=obj["addresses"],
                      node_restarted="yes" if obj["restarted"] else "no")
            else:
                event("restore refused", self, reason=why)
            return self.reply(code, obj)
        if path == "/api/wallet/backup":
            # needs an unlocked page AND the PIN typed again: a fingerprint session alone can't export the keys
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            password = str(body.get("password", ""))
            if len(password) < MIN_BACKUP_PASSWORD:
                return self.reply(400, {"error": "The backup password must be at least %d characters." % MIN_BACKUP_PASSWORD})
            refused = pin_attempt(self, str(body.get("pin", "")), "backup refused, wrong PIN")
            if refused:
                code, obj = refused
                return self.reply(403 if code == 401 else code, obj)      # 401 means "locked" to the page
            code, obj, source = backup_export(password)
            if code == 200:
                event("backup exported", self, keystore_from=source)
            return self.reply(code, obj)
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
        if path == "/api/update/check":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            return self.reply(200, update_check())
        if path == "/api/update/passkey/challenge":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            d = passkeys_load()
            if not d["keys"]:
                return self.reply(404, {"error": "Fingerprint unlock isn't turned on."})
            return self.reply(200, {"challenge": b64u(challenge_new("update")), "rpId": RP_ID, "ids": [k["id"] for k in d["keys"]]})
        if path == "/api/update/apply":
            # confirmed by a fresh fingerprint confirmation made for this update, or by the PIN
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            if body.get("assertion") is not None:
                if not passkey_assertion_ok(body.get("assertion"), "update"):
                    event("update refused, fingerprint not confirmed", self)
                    return self.reply(403, {"error": "The fingerprint confirmation didn't check out. Try again, or use your PIN."})
            else:
                refused = pin_attempt(self, str(body.get("pin", "")), "update refused, wrong PIN")
                if refused:
                    code, obj = refused
                    return self.reply(403 if code == 401 else code, obj)
            code, obj = update_apply()
            if code != 200:
                event("update refused", self, reason=obj.get("error", ""))
                return self.reply(code, obj)
            event("update applied", self, version_from=obj["from"], version_to=obj["to"])
            self.reply(200, obj)
            return restart_soon()
        if path == "/api/names/rpc":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            code, obj = names_rpc(body)
            return self.reply(code, raw=obj) if isinstance(obj, bytes) else self.reply(code, obj)
        if path == "/api/wallet/receipts":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            return self.reply(200, {"receipts": receipts_take()})
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
    event("app start", port=PORT, version=APP_VERSION)
    threading.Thread(target=wallet_keys, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    threading.Thread(target=update_loop, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

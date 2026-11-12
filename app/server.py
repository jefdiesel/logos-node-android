#!/usr/bin/env python3
"""Local web app for a Logos node running on the same device: node status plus a small wallet.

It listens on 127.0.0.1 only and talks to the node's own API at NODE_API (127.0.0.1:8080 unless set;
the Linux Terminal install uses port 880).
Python standard library only. Wallet calls need a PIN that is set on first use.
"""
import base64, calendar, hashlib, hmac, http.server, json, os, re, secrets, shlex, shutil, struct, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request

APP_VERSION = "0.9.3"
# APP_EMBEDDED=android: this app runs inside the Android app (embedded Python, page in a WebView).
# Then it never updates or restarts itself (the Android app brings new versions), and fingerprint
# unlock goes through the phone's own fingerprint check instead of a passkey. Unset: nothing changes.
EMBEDDED = os.environ.get("APP_EMBEDDED", "") == "android"
EMBEDDED_UPDATES = "Updates come with a new version of the Android app."       # set by tools/release.py, which also writes release.json
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
# Auto-lock: the wallet locks after AUTOLOCK minutes without the user doing anything (background
# polling doesn't count), or LEAVE_GRACE seconds after the page said it was hidden. The minute length
# and the grace can be shortened through the environment so the tests run in seconds.
AUTOLOCK_CHOICES = (1, 5, 15)
MINUTE = float(os.environ.get("AUTOLOCK_MINUTE_SECONDS", "60"))
LEAVE_GRACE = float(os.environ.get("LEAVE_GRACE_SECONDS", "60"))
MAX_FAILS = 5           # wrong PINs before a pause
FAIL_PAUSE = 300        # seconds

lock = threading.Lock()
session = {"token": None, "active": 0.0, "hidden_since": None}
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


# ---- how far behind the chain this node is ----------------------------------------------------
# Only from the node on this device: /cryptarchia/info (its tip's slot and height, its state and
# phase), /time/info (the current slot, the slot length), /cryptarchia/headers (how many blocks lie
# between its tip and its last irreversible block), and its own log. The log has the node's expected
# block interval and lag threshold ("Tip-poll lag watchdog enabled cadence_slots=C
# lag_threshold_slots=L", written at start: 1/f slots and 3 of those), and, only while it is behind,
# the height of the best tip a peer reported ("tip poll: enqueued peer tip ... height=H").

ANSI_RE = re.compile(rb"\x1b\[[0-9;]*m")
_sync_memo = {"cadence": None, "threshold": None, "spacing": None, "spacing_at": 0.0, "peer": None}
_log_read = {"path": None, "pos": 0}
_log_lock = threading.Lock()


def node_log_new(first=8000000, cap=8000000):
    """The complete lines the node's newest log gained since the last call, without colour codes. The lines
    this app needs are rare (the peer tip is written once per catch-up) and scroll away fast while the node
    syncs, so it reads on from where it stopped rather than looking at the end each time."""
    try:
        logs = os.path.join(os.path.dirname(NODE_CFG), "logs")
        newest = max((os.path.join(logs, f) for f in os.listdir(logs)), key=os.path.getmtime)
        size = os.path.getsize(newest)
        if newest != _log_read["path"] or size < _log_read["pos"]:      # a new or rotated file
            _log_read["path"], _log_read["pos"] = newest, max(0, size - first)
        start = max(_log_read["pos"], size - cap)
        with open(newest, "rb") as f:
            f.seek(start)
            data = f.read(size - start)
        end = data.rfind(b"\n") + 1                                        # keep a half-written line for next time
        _log_read["pos"] = start + end
        return ANSI_RE.sub(b"", data[:end])
    except Exception:
        return b""


def node_log_tail(size=400000):
    """The end of the node's newest log file, without colour codes; b"" if there is none."""
    try:
        logs = os.path.join(os.path.dirname(NODE_CFG), "logs")
        newest = max((os.path.join(logs, f) for f in os.listdir(logs)), key=os.path.getmtime)
        with open(newest, "rb") as f:
            f.seek(0, 2); f.seek(max(0, f.tell() - size))
            return ANSI_RE.sub(b"", f.read())
    except Exception:
        return b""


def log_time(stamp):
    try:
        return calendar.timegm(time.strptime(stamp.decode()[:19], "%Y-%m-%dT%H:%M:%S"))       # the log is in UTC
    except Exception:
        return None


def sync_facts(c):
    """What the node's log and headers add to /cryptarchia/info `c`: the node's own expected block interval
    and lag threshold in slots, the block spacing measured over its last irreversible stretch, and the
    best tip height a peer reported (with when)."""
    with _log_lock:
        text = node_log_new()
        m = re.findall(rb"cadence_slots\W{0,4}(\d+)\W{1,8}lag_threshold_slots\W{0,4}(\d+)", text)
        if m:
            _sync_memo["cadence"], _sync_memo["threshold"] = int(m[-1][0]), int(m[-1][1])
        for stamp, height in re.findall(rb"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\S*\s+\w+\s+\S+\s+tip poll: enqueued peer tip[^\n]*? height=(\d+)", text)[-1:]:
            _sync_memo["peer"] = {"height": int(height), "at": log_time(stamp)}
        peer = _sync_memo["peer"]
    tip_slot, lib_slot = c.get("slot") or 0, c.get("lib_slot") or 0
    if lib_slot and tip_slot > lib_slot and time.time() - _sync_memo["spacing_at"] > 60:
        code, ids = node("/cryptarchia/headers?from=%s&to=%s" % (c.get("tip"), c.get("lib")), timeout=5)
        if code == 200 and isinstance(ids, list) and 2 <= len(ids) < 512:
            _sync_memo["spacing"], _sync_memo["spacing_at"] = (tip_slot - lib_slot) / (len(ids) - 1), time.time()
    return {"cadence_slots": _sync_memo["cadence"], "threshold_slots": _sync_memo["threshold"],
            "spacing_slots": _sync_memo["spacing"], "peer": peer}


def classify_sync(state, phase, height, tip_slot, current_slot, slot_ms, facts, now):
    """Where this node stands against the chain (pure, so it can be tested with recorded values).
    stage: "uptodate" (online, and its latest block is no older than the node's own lag threshold allows,
    doubled so ordinary gaps between blocks don't flicker), "waiting" (that close, but the node hasn't
    finished its waiting period after starting, so it isn't online and can't send), or "behind"."""
    slot_s = (slot_ms or 1000) / 1000.0
    lag = max(0, (current_slot or 0) - (tip_slot or 0))
    spacing = facts.get("cadence_slots") or facts.get("spacing_slots")       # expected slots per block
    if facts.get("threshold_slots"):
        allowed = 2 * facts["threshold_slots"]
    elif spacing:
        allowed = 6 * spacing
    else:
        allowed = 120 / slot_s                                                 # nothing better known: 2 minutes
    out = {"tip_age_s": round(lag * slot_s), "spacing_s": round(spacing * slot_s, 1) if spacing else None,
           "chain_height": None, "behind_blocks": None, "estimate": True}
    peer = facts.get("peer")
    if peer and peer.get("height", 0) > (height or 0) and peer.get("at") and now - peer["at"] < 1800:
        # a peer's tip, plus the blocks the chain has made since it was heard (if the interval is known)
        grown = int((now - peer["at"]) / (spacing * slot_s)) if spacing else 0
        out["chain_height"] = peer["height"] + grown
        out["behind_blocks"] = out["chain_height"] - (height or 0)
    if lag <= allowed and (out["behind_blocks"] or 0) <= 3:
        out["stage"] = "uptodate" if state == "Online" else "waiting"
        out["chain_height"], out["behind_blocks"] = None, 0
    else:
        out["stage"] = "behind"
    return out


def sync_status(st):
    """The node's sync stage for /api/status, or None if the node or its clock don't answer."""
    code, t = node("/time/info", timeout=5)
    if not st or code != 200 or not isinstance(t, dict):
        return None
    code, info = node("/cryptarchia/info", timeout=5)
    c = info.get("cryptarchia_info", info) if code == 200 and isinstance(info, dict) else {}
    return classify_sync(st.get("state"), st.get("phase"), st.get("height"), c.get("slot", st.get("slot")),
                         t.get("current_slot"), t.get("slot_duration_ms"), sync_facts(c), time.time())


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
MESSAGES_FILE_RE = re.compile(r"^/((?:messages/(?:noble-(?:ciphers|hashes)/)?|noble-curves/(?:abstract/)?)[A-Za-z0-9_][A-Za-z0-9_.-]*\.js)$")
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
    if EMBEDDED:
        return
    while True:
        update_check()
        time.sleep(UPDATE_EVERY)


def update_apply():
    """(http status, reply). On success the caller restarts this process."""
    if EMBEDDED:
        return 409, {"error": EMBEDDED_UPDATES}
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
    under systemd and under Termux's start script; the node keeps running. Never inside the Android app."""
    if EMBEDDED:
        return
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


SETTINGS_FILE = os.path.join(DATA_DIR, "wallet-settings.json")


def settings_load():
    try:
        with open(SETTINGS_FILE) as f:
            d = json.load(f)
        if d.get("autolock_minutes") not in AUTOLOCK_CHOICES:
            d["autolock_minutes"] = 5
        d["native_fingerprint"] = d.get("native_fingerprint") is True
        return d
    except Exception:
        pass
    return {"autolock_minutes": 5, "native_fingerprint": False}


wallet_settings = settings_load()


def settings_save():
    fd = os.open(SETTINGS_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(wallet_settings, f)
    os.replace(SETTINGS_FILE + ".tmp", SETTINGS_FILE)


def session_new():
    with lock:
        session.update(token=secrets.token_hex(32), active=time.time(), hidden_since=None)
        return session["token"]


def session_expire():
    """Ends the session when the user has been idle too long or left the page; logs why. The server
    decides this, not the page: timers in a hidden page don't run reliably."""
    now, reason = time.time(), None
    with lock:
        if not session["token"]:
            return
        if session["hidden_since"] is not None and now - session["hidden_since"] > LEAVE_GRACE:
            reason = "left the page"
        elif now - session["active"] > wallet_settings["autolock_minutes"] * MINUTE:
            reason = "idle"
        if reason:
            session["token"] = None
    if reason:
        event("wallet locked", reason=reason)


def session_ok(token):
    """Whether `token` is the open session. Only checks: requests don't keep the wallet unlocked."""
    session_expire()
    with lock:
        t = session["token"]
        return bool(t and token and hmac.compare_digest(t, token))


def session_touch(visible=False):
    """The user did something (or came back to the page): the idle clock starts again."""
    with lock:
        session["active"] = time.time()
        if visible:
            session["hidden_since"] = None


def session_watch():
    while True:
        time.sleep(max(0.2, min(5.0, LEAVE_GRACE / 4, MINUTE / 4)))
        try:
            session_expire()
        except Exception:
            pass


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
# Version 2 also carries the messaging key (see "messages" below). It is written only when this app has
# one, so a wallet without messaging still gets exactly a version 1 file. Restore reads both.
BACKUP_AADS = {1: b"logos-node-wallet-backup v1", 2: b"logos-node-wallet-backup v2"}
BACKUP_SCRYPT = {"n": 2 ** 16, "r": 8, "p": 1, "dklen": 32}
MIN_BACKUP_PASSWORD = 8      # the page advises 12 or more, or four random words
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


def restart_hint():
    """What to tell the user when the app couldn't restart the node itself after a restore."""
    if EMBEDDED:
        return "The keys are in place. Restart the node from the app's Node screen."
    return ("The keys are in place. Restart the node to use them: in Termux, press Ctrl-C where the node runs, "
            "then start it again with ~/logos-node. In the Linux Terminal app: sudo systemctl restart logos-node.")


def native_unlock():
    """Inside the Android app only: opens the wallet after the phone's own fingerprint check, and returns
    the session token (None if fingerprint unlock isn't on, no PIN is set, or not embedded). There is no
    HTTP route to this on purpose: only code in the app's own process can call it, after the check."""
    if not EMBEDDED or not wallet_settings.get("native_fingerprint") or not pin_is_set():
        return None
    token = session_new()
    event("unlock by fingerprint ok", source="android")
    return token


# ---- messages: LNS name-to-name messages through a Logos Messaging (Waku) node on this device -----
# Only where a messaging node can run: inside the Android app (APP_EMBEDDED=android), when WAKU_API is set
# at start, or once the app calls set_waku_api(). The node itself can come and go while the app runs (the
# user switches it on and off): set_waku_api(url or None) says where it is now; until the app calls that,
# WAKU_API is read again each time. Elsewhere (Linux, Termux) none of this is reachable.
# WAKU_API names that node's REST API on this device (the Android app sets it while its
# messaging node runs). Without it nothing below is reachable and the page is unchanged.
# The format is the names project's (app/messages/msg-crypto.js): the page seals and opens messages;
# this server only stores the device's messaging key for unlocked pages, forwards sealed payloads to
# the node, and collects the sealed payloads that arrive on this device's inbox topic.

def _loopback_url(raw):
    """The node REST URL if it is plain http on this device, else "" (refused)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        u = urllib.parse.urlsplit(raw)
        if u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost", "::1") and u.port and u.path.strip("/") == "" \
                and not u.query and not u.username:
            return "http://%s:%d" % ("[::1]" if u.hostname == "::1" else u.hostname, u.port)
    except Exception:
        pass
    if raw not in _waku["refused"]:
        _waku["refused"].add(raw)
        sys.stderr.write("WAKU_API refused: it must be http://127.0.0.1:<port>, a node on this device\n")
    return ""


_waku = {"set": False, "url": "", "feature": False, "thread": False, "refused": set()}


def waku_api():
    """Where the messaging node's REST API is right now, or "" while it is off."""
    if _waku["set"]:
        return _waku["url"]
    return _loopback_url(os.environ.get("WAKU_API", ""))


def messaging_on():
    """Whether this app has messages at all (decided once; the node's own on/off state is separate)."""
    return _waku["feature"]


def set_waku_api(url):
    """For the Android app: the messaging node's REST URL now that it runs, or None when it stopped.
    Turns messages on in this app and says where the node is. Returns False (and changes nothing) for a URL
    that isn't on this device. No HTTP route."""
    u = _loopback_url(url) if url else ""
    if url and not u:
        return False
    _waku.update(set=True, url=u, feature=True)
    messaging_start()
    return True
MSG_KEY_FILE = os.path.join(DATA_DIR, "wallet-msgkey.json")
INBOX_FILE = os.path.join(DATA_DIR, "wallet-inbox.json")
INBOX_MAX, SEEN_MAX, PAYLOAD_MAX = 2000, 8000, 16384    # messages kept, hashes remembered, bytes per message
# The chat history the page keeps, all of it sealed or encrypted by the page under a key made from the messaging
# key: this code stores and returns opaque blobs and never decrypts them.
OUTBOX_FILE = os.path.join(DATA_DIR, "wallet-outbox.json")     # my sent messages: the page's encrypted copy, and
OUTBOX_MAX, COPY_MAX, SENDS_MAX = 2000, 24576, 16              # the sealed payload per recipient until it's sent
STORE_FILE = os.path.join(DATA_DIR, "wallet-chat.json")         # profiles, notes, conversations: one encrypted blob
STORE_MAX = 262144
SEND_GAP = float(os.environ.get("MESSAGING_SEND_GAP_SECONDS", "1"))     # between two posts to the node
SEND_WAIT = float(os.environ.get("MESSAGING_SEND_WAIT_SECONDS", "150"))  # for a send's last event
HISTORY_BACKUP_MAX = 1048576                                    # message history in a backup, newest first
MSG_POLL = float(os.environ.get("MESSAGING_POLL_SECONDS", "3"))
MSG_HEALTH_EVERY = float(os.environ.get("MESSAGING_HEALTH_SECONDS", "10"))
MSG_UNSUB_AFTER = float(os.environ.get("MESSAGING_UNSUBSCRIBE_SECONDS", "180"))
sent_topics = {}                  # another name's inbox topic -> when this app last sent to it
MSG_TOPIC_RE = re.compile(r"^/names/1/msg-[0-9a-f]{16}/proto$")
HEX32_RE = re.compile(r"^[0-9a-f]{64}$")
msg_lock = threading.Lock()
msg_state = {"reachable": None, "misses": 0, "health": None, "connection": None, "checked": 0.0,
             "subscribed": None, "subscribed_at": 0.0, "last_seq": 0, "missed": 0}


def x25519(k, u):
    """RFC 7748 X25519 (used only to check that a public key belongs to its secret key)."""
    p = 2 ** 255 - 19
    kb = bytearray(k); kb[0] &= 248; kb[31] &= 127; kb[31] |= 64
    k = int.from_bytes(kb, "little")
    x1 = int.from_bytes(u, "little") & ((1 << 255) - 1)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in reversed(range(255)):
        bit = (k >> t) & 1
        if swap ^ bit:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a, b, c, d = (x2 + z2) % p, (x2 - z2) % p, (x3 + z3) % p, (x3 - z3) % p
        aa, bb, da, cb = a * a % p, b * b % p, d * a % p, c * b % p
        e = (aa - bb) % p
        x3, z3 = (da + cb) ** 2 % p, x1 * (da - cb) ** 2 % p
        x2, z2 = aa * bb % p, e * (aa + 121665 * e) % p
    if swap:
        x2, z2 = x3, z3
    return (x2 * pow(z2, p - 2, p) % p).to_bytes(32, "little")


# The messaging key record (wallet-msgkey.json, 0600, beside the node's own key file):
#   version 2 (from 0.9.0): {"version": 2, "seed", "secret", "public", "name", "created"}. `seed` is an Ed25519
#     seed; the X25519 key pair used for messages is derived from it (secret = the clamped first half of
#     SHA-512(seed), public = the Montgomery form of the Ed25519 public key), so the same seed can sign for
#     groups later while `public` stays the key published as the name's `msg` entry.
#   version 1 (0.8.x): {"secret", "public", "name", "created"}, an X25519 pair only. It keeps working for
#     messages between two names; it is marked {"version": 1, "groups": false} because groups will need a new
#     key, which only the user can decide to make (it changes the name's msg entry).
# msg_key_load / msg_key_save are the one place this file is read and written.
def montgomery_secret(seed):
    h = bytearray(hashlib.sha512(seed).digest()[:32])
    h[0] &= 248; h[31] &= 127; h[31] |= 64
    return bytes(h)


def msg_key_valid(d):
    if not (isinstance(d, dict) and isinstance(d.get("secret"), str) and isinstance(d.get("public"), str)
            and HEX32_RE.match(d["secret"]) and HEX32_RE.match(d["public"])
            and x25519(bytes.fromhex(d["secret"]), (9).to_bytes(32, "little")).hex() == d["public"]
            and (d.get("name") in (None, "") or NAME_RE.match(str(d.get("name"))))):
        return False
    if d.get("seed") is not None:             # the X25519 secret must be the one this seed gives
        return isinstance(d["seed"], str) and bool(HEX32_RE.match(d["seed"])) \
            and montgomery_secret(bytes.fromhex(d["seed"])).hex() == d["secret"]
    return True


def msg_key_record(d, name, created):
    """The record to store for a valid key d (from the page, or a backup)."""
    rec = {"secret": d["secret"], "public": d["public"], "name": name or "", "created": created}
    if d.get("seed"):
        rec.update(version=2, seed=d["seed"])
    else:
        rec.update(version=1, groups=False)
    return rec


def msg_key_load():
    try:
        with open(MSG_KEY_FILE) as f:
            d = json.load(f)
    except Exception:
        return None
    if not msg_key_valid(d):
        return None
    if "version" not in d:                     # a key made by 0.8.x (msg_key_mark writes this into the file)
        d.update(version=1, groups=False)
    return d


def msg_key_mark():
    """Once, at start: marks a key made by 0.8.x as version 1 without groups, in the file. Never replaces it."""
    with msg_lock:
        try:
            with open(MSG_KEY_FILE) as f:
                d = json.load(f)
        except Exception:
            return
        if msg_key_valid(d) and "version" not in d:
            d.update(version=1, groups=False)
            msg_key_save(d, quiet=True)


def msg_key_save(d, quiet=False):
    fd = os.open(MSG_KEY_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.replace(MSG_KEY_FILE + ".tmp", MSG_KEY_FILE)
    if not quiet:
        with msg_lock:
            msg_state["subscribed"] = None        # the inbox topic may have changed: subscribe again


def msg_key_restore(d):
    """Puts a messaging key from a backup in place; True if it changed anything."""
    cur = msg_key_load() or {}
    if cur.get("secret") == d["secret"] and cur.get("name") == (d.get("name") or "") and (cur.get("seed") or not d.get("seed")):
        return False
    msg_key_save(msg_key_record(d, d.get("name"), cur.get("created") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
    event("messaging key restored from a backup")
    return True


def inbox_topic(public_hex):
    return "/names/1/msg-%s/proto" % hashlib.sha256(bytes.fromhex(public_hex)).hexdigest()[:16]


def inbox_load():
    try:
        with open(INBOX_FILE) as f:
            d = json.load(f)
        if isinstance(d.get("items"), list) and isinstance(d.get("seen"), list):
            return d
    except Exception:
        pass
    return {"version": 1, "items": [], "seen": [], "next": 1}


inbox = {"version": 1, "items": [], "seen": [], "next": 1}
_waku["feature"] = EMBEDDED or bool(waku_api())          # messages exist here at all (decided once)
if _waku["feature"]:
    inbox.update(inbox_load())


def inbox_save():
    """Writes the inbox; the caller holds msg_lock. It holds sealed payloads only."""
    inbox["items"] = inbox["items"][-INBOX_MAX:]
    inbox["seen"] = inbox["seen"][-SEEN_MAX:]
    fd = os.open(INBOX_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(inbox, f)
    os.replace(INBOX_FILE + ".tmp", INBOX_FILE)


def messaging_inbox_count():
    """How many incoming messages are unread (for a notification without content). No HTTP route.
    The page marks messages read when they are shown (POST /api/messages/inbox/read). This code can't open
    a message, so it can't tell a muted or blocked sender apart: those count until the page has been open
    once after they came (it marks them read then)."""
    with msg_lock:
        return sum(1 for i in inbox["items"] if not i.get("read")) if messaging_on() else 0


def waku(method, path, body=None, timeout=6):
    """(http status, parsed JSON or text) from the messaging node; status 0 when it doesn't answer."""
    api = waku_api()
    if not api:
        return 0, None
    req = urllib.request.Request(api + path, data=None if body is None else json.dumps(body).encode(), method=method,
                                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with _outside.open(req, timeout=timeout) as r:
            code, data = r.status, r.read(4 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as e:
        code, data = e.code, e.read(65536)
    except Exception:
        return 0, None
    try:
        return code, json.loads(data) if data else None
    except Exception:
        return code, data.decode(errors="replace")[:300]


def messaging_health():
    """Reads /health; the node counts as off only after 3 misses in a row (it can stall for seconds)."""
    code, h = waku("GET", "/health", timeout=6)
    with msg_lock:
        msg_state["checked"] = time.time()
        if code == 200 and isinstance(h, dict):
            back = msg_state["reachable"] is False
            msg_state.update(reachable=True, misses=0, health=h.get("nodeHealth"), connection=h.get("connectionStatus"))
            if back:
                msg_state["subscribed"] = None    # it came back: subscribe again (that also brings what it missed)
        else:
            msg_state["misses"] += 1
            if msg_state["misses"] >= 3:
                msg_state.update(reachable=False, subscribed=None)


def messaging_round():
    api = waku_api()
    with msg_lock:
        if not api:                              # the node is switched off: say so, and subscribe again later
            msg_state.update(configured=False, reachable=False, subscribed=None, health=None, connection=None, starting=False)
            return
        if msg_state.get("configured") is False or msg_state.get("api") != api:
            msg_state.update(checked=0.0, misses=0, subscribed=None)    # it (re)appeared: look at it now
        msg_state.update(configured=True, api=api)
    key = msg_key_load()
    # until the inbox is subscribed, look every round: a node only catches up on missed messages for topics
    # subscribed during its start-up catch-up or within 10 s after it (logos-delivery recv_service.nim)
    if time.time() - msg_state["checked"] >= (MSG_HEALTH_EVERY if msg_state["subscribed"] else 0):
        messaging_health()
    if not key or msg_state["reachable"] is False:
        return
    topic = inbox_topic(key["public"])
    # Is the inbox still subscribed? The node forgets subscriptions when it restarts, even a quick restart
    # that WAKU_API never shows, so look each round and subscribe again the moment it's missing. While the
    # node starts, /messaging answers 404 ("not available while initializing"): keep trying.
    code, subs = waku("GET", "/messaging/v1/subscriptions", timeout=6)
    if code == 404:
        with msg_lock:
            if not msg_state.get("starting"):
                msg_state["starting_since"] = time.time()
            msg_state.update(starting=True, subscribed=None)
        return
    if code != 200 or not isinstance(subs, list):
        return
    with msg_lock:
        msg_state["starting"] = False
    if topic not in subs:
        code, _ = waku("POST", "/messaging/v1/subscriptions", [topic])
        if code != 200:
            with msg_lock:
                msg_state["subscribed"] = None
            return
        with msg_lock:
            msg_state.update(subscribed=topic, subscribed_at=time.time())
    else:
        with msg_lock:
            msg_state["subscribed"] = topic
    # A send subscribes the node to the recipient's inbox topic, and everything sent to that name would then
    # fill the node's 50-message buffer between reads: let go of those topics once the send has settled.
    with msg_lock:
        done = [t for t, at in sent_topics.items() if time.time() - at > MSG_UNSUB_AFTER]
    drop = [t for t in done if t != topic and t in subs]
    if done and (not drop or waku("DELETE", "/messaging/v1/subscriptions", drop)[0] == 200):
        with msg_lock:
            for t in done:
                if time.time() - sent_topics.get(t, 0) > MSG_UNSUB_AFTER:    # unless sent to again meanwhile
                    sent_topics.pop(t, None)
    code, records = waku("GET", "/messaging/v1/events/received", timeout=10)
    if code != 200 or not isinstance(records, list):
        if code == 0:
            with msg_lock:
                msg_state["subscribed"] = None
        return
    changed = False
    with msg_lock:
        for r in records:
            if not isinstance(r, dict):
                continue
            seq = r.get("seq")
            if isinstance(seq, int) and not isinstance(seq, bool):
                if seq < msg_state["last_seq"]:
                    msg_state["subscribed"] = None          # the node restarted: subscribe again next round
                elif msg_state["last_seq"] and seq > msg_state["last_seq"] + 1:
                    msg_state["missed"] += seq - msg_state["last_seq"] - 1
                msg_state["last_seq"] = seq
            m = r.get("message") if isinstance(r.get("message"), dict) else {}
            if m.get("contentTopic") != topic or not isinstance(m.get("payload"), str):
                continue
            try:
                payload = base64.b64decode(m["payload"], validate=True)
            except Exception:
                continue
            if not payload or len(payload) > PAYLOAD_MAX:
                continue                                    # not a message of ours: too big or empty
            ids = {"p:" + hashlib.sha256(payload).hexdigest()}
            if isinstance(r.get("messageHash"), str) and re.match(r"^0x[0-9a-fA-F]{64}$", r["messageHash"]):
                ids.add("h:" + r["messageHash"].lower())
            if ids & set(inbox["seen"]):
                continue                                    # delivered before (live and again from history)
            inbox["seen"].extend(sorted(ids))
            inbox["items"].append({"n": inbox["next"], "payload": base64.b64encode(payload).decode(),
                                   "source": r.get("source") if r.get("source") in ("live", "history") else None,
                                   "received": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "read": False})
            inbox["next"] += 1
            changed = True
        if changed:
            inbox_save()


def _json_load(path, check, empty):
    try:
        with open(path) as f:
            d = json.load(f)
        if check(d):
            return d
    except Exception:
        pass
    return empty()


def _json_save(path, d):
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.replace(path + ".tmp", path)


def outbox_load():
    return _json_load(OUTBOX_FILE, lambda d: isinstance(d.get("items"), list) and isinstance(d.get("next"), int),
                      lambda: {"version": 1, "items": [], "next": 1, "rev": 0})


outbox = {"version": 1, "items": [], "next": 1, "rev": 0}
outbox_wake = threading.Event()
if _waku["feature"]:
    outbox.update(outbox_load())


def outbox_save():
    """Writes the outbox; the caller holds msg_lock."""
    outbox["items"] = outbox["items"][-OUTBOX_MAX:]
    _json_save(OUTBOX_FILE, outbox)


def outbox_touch(item):
    """A send of `item` changed: the page asks for items changed since a revision. The caller holds msg_lock."""
    outbox["rev"] = outbox.get("rev", 0) + 1
    item["v"] = outbox["rev"]


def outbox_view(item):
    """An outbox item as the page sees it: its encrypted copy and each send's state, without the payloads."""
    return {"n": item["n"], "copy": item["copy"], "at": item["at"], "v": item.get("v", 0),
            "sends": [{"state": x["state"], "error": x.get("error", ""), "at": x.get("at"), "resend": bool(x.get("payload"))}
                      for x in item["sends"]]}


def outbox_round():
    """One step of the sender: posts at most one queued send, and reads the events of the ones in flight.
    Returns how long to wait before the next step."""
    now = time.time()
    with msg_lock:
        flying = [(i, x) for i in outbox["items"] for x in i["sends"]
                  if x["state"] in ("sending", "propagated") and not x.get("done") and x.get("rid")]
        queued = next(((i, x) for i in outbox["items"] for x in i["sends"] if x["state"] == "queued"), None)
        ready = msg_state.get("configured") and msg_state["reachable"] is not False and not msg_state.get("starting")
        gap_ok = now - outbox.get("posted", 0) >= SEND_GAP
    changed = False
    for item, x in flying:
        if now - x.get("polled", 0) < 2:
            continue
        x["polled"] = now
        code, st = waku("GET", "/messaging/v1/events/send/" + x["rid"], timeout=6)
        kinds = [str(e.get("kind")) for e in (st.get("events") or []) if isinstance(e, dict)] if code == 200 and isinstance(st, dict) else []
        with msg_lock:
            if "sent" in kinds:
                x.update(state="sent", at=now, payload=None)
            elif "error" in kinds:
                err = next((str(e.get("error") or "") for e in st["events"] if isinstance(e, dict) and e.get("kind") == "error"), "")
                x.update(state="failed", at=now, error=(err or "the network didn't take it")[:200])
            elif "propagated" in kinds and x["state"] == "sending":
                x.update(state="propagated", at=now)
            elif now - x.get("posted", now) > SEND_WAIT:
                # no last event: a node without reliability stops at propagated, and one that restarted forgot it
                if x["state"] == "propagated":
                    x.update(done=True, payload=None)
                else:
                    x.update(state="failed", at=now, error="no answer from the messaging network")
            else:
                continue
            outbox_touch(item)
            changed = True
    if queued and ready and gap_ok:
        item, x = queued
        code, reply = waku("POST", "/messaging/v1/messages", {"payload": x["payload"], "contentTopic": x["topic"], "ephemeral": False}, timeout=10)
        with msg_lock:
            outbox["posted"] = time.time()
            if code == 200 and isinstance(reply, dict) and isinstance(reply.get("requestId"), str):
                x.update(state="sending", rid=reply["requestId"][:128], posted=time.time(), polled=time.time(), tries=x.get("tries", 0) + 1, error="")
                sent_topics[x["topic"]] = time.time()
                outbox_touch(item)
                changed = True
            elif code in (0, 404, 429, 503):
                pass                                   # the node is off, starting or busy: it stays queued
            else:
                x.update(state="failed", at=time.time(), error="the messaging node refused it (HTTP %d)" % code)
                outbox_touch(item)
                changed = True
    if changed:
        with msg_lock:
            outbox_save()
    with msg_lock:
        more = any(x["state"] == "queued" for i in outbox["items"] for x in i["sends"])
        busy = any(x["state"] in ("sending",) or (x["state"] == "propagated" and not x.get("done"))
                   for i in outbox["items"] for x in i["sends"])
    return SEND_GAP if more else (1.0 if busy else 5.0)


def outbox_loop():
    while True:
        try:
            wait = outbox_round()
        except Exception:
            wait = 5.0
        outbox_wake.wait(wait)
        outbox_wake.clear()


def store_load():
    return _json_load(STORE_FILE, lambda d: isinstance(d.get("rev"), int), lambda: {"rev": 0, "blob": None})


def messaging_start():
    """Loads the inbox and starts the messaging loop and the sender, once."""
    try:
        msg_key_mark()
    except Exception:
        pass
    with msg_lock:
        if _waku["thread"]:
            return
        _waku["thread"] = True
        if not inbox["items"] and not inbox["seen"]:
            inbox.update(inbox_load())
        if not outbox["items"]:
            outbox.update(outbox_load())
    threading.Thread(target=messaging_loop, daemon=True).start()
    threading.Thread(target=outbox_loop, daemon=True).start()


def messaging_loop():
    while True:
        try:
            messaging_round()
        except Exception:
            pass
        # quickly for the first minute while the node starts: its start-up catch-up (messages sent while it was
        # off) takes subscriptions only until 10 s after it finishes. A node that keeps answering 404 is not
        # starting any more, and one without a key to subscribe never gets here.
        starting = msg_state.get("starting") and time.time() - msg_state.get("starting_since", 0) < 60
        time.sleep(min(MSG_POLL, 0.5) if starting and msg_state["reachable"] is not False else MSG_POLL)


def _ints(v):
    return {n for n in (v if isinstance(v, list) else []) if isinstance(n, int) and not isinstance(n, bool)}


def _b64_ok(v, limit):
    """Whether v is base64 of 1..limit bytes."""
    if not isinstance(v, str) or not v or len(v) > (limit + 2) // 3 * 4:
        return False
    try:
        return 0 < len(base64.b64decode(v, validate=True)) <= limit
    except Exception:
        return False


def messaging_post(path, body, req):
    """The /api/messages/* POST routes: (http status, reply)."""
    if path == "/api/messages/outbox":
        # a message from this device: the page's encrypted copy for its history, and the sealed payload for each
        # recipient's inbox topic. The sender posts them one at a time and follows each one's events.
        copy, sends = body.get("copy"), body.get("sends")
        if not _b64_ok(copy, COPY_MAX):
            return 400, {"error": "The message copy is missing or too long."}
        if not isinstance(sends, list) or not 1 <= len(sends) <= SENDS_MAX:
            return 400, {"error": "A message goes to 1 to %d recipients." % SENDS_MAX}
        out = []
        for x in sends:
            topic = str((x or {}).get("topic", "")) if isinstance(x, dict) else ""
            if not MSG_TOPIC_RE.match(topic):
                return 400, {"error": "That isn't a names inbox topic."}
            if not _b64_ok(x.get("payload"), PAYLOAD_MAX):
                return 413, {"error": "That message is too long."}
            out.append({"topic": topic, "payload": x["payload"], "state": "queued", "error": "", "at": None, "tries": 0})
        with msg_lock:
            item = {"n": outbox["next"], "copy": copy, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sends": out}
            outbox["next"] += 1
            outbox["items"].append(item)
            outbox_touch(item)
            outbox_save()
        outbox_wake.set()
        event("message sent", req)
        return 200, {"n": item["n"]}
    if path == "/api/messages/outbox/retry":
        with msg_lock:
            item = next((i for i in outbox["items"] if i["n"] == body.get("n") and not isinstance(body.get("n"), bool)), None)
            if not item:
                return 404, {"error": "That message isn't in the outbox any more."}
            again = 0
            for x in item["sends"]:
                if x["state"] == "failed" and x.get("payload"):
                    x.update(state="queued", error="", rid=None, at=None)
                    again += 1
            if again:
                outbox_touch(item)
                outbox_save()
        outbox_wake.set()
        return 200, {"queued": again}
    if path == "/api/messages/outbox/delete":
        ns = _ints(body.get("ids"))
        with msg_lock:
            before = len(outbox["items"])
            outbox["items"] = [i for i in outbox["items"] if i["n"] not in ns]
            removed = before - len(outbox["items"])
            if removed:
                outbox_save()
        return 200, {"removed": removed}
    if path == "/api/messages/inbox/read":
        ns = _ints(body.get("ids"))
        with msg_lock:
            marked = 0
            for i in inbox["items"]:
                if i["n"] in ns and not i.get("read"):
                    i["read"] = True
                    marked += 1
            if marked:
                inbox_save()
        return 200, {"marked": marked}
    if path == "/api/messages/store":
        # one encrypted blob (profiles, notes, conversations), replaced as a whole; rev stops two pages
        # overwriting each other's changes
        blob, rev = body.get("blob"), body.get("rev")
        if not _b64_ok(blob, STORE_MAX):
            return 413, {"error": "The saved chats are too large."}
        with msg_lock:
            cur = store_load()
            if rev != cur["rev"] or isinstance(rev, bool):
                return 409, {"error": "Changed elsewhere; load it again.", "rev": cur["rev"]}
            _json_save(STORE_FILE, {"rev": cur["rev"] + 1, "blob": blob})
            return 200, {"rev": cur["rev"] + 1}
    if path == "/api/messages/key":
        d = {"secret": str(body.get("secret", "")).lower(), "public": str(body.get("public", "")).lower()}
        if body.get("seed") is not None:
            d["seed"] = str(body["seed"]).lower()
        if not msg_key_valid(d):
            return 400, {"error": "That isn't a messaging key pair (the public key must belong to the secret key)."}
        cur = msg_key_load()
        if cur and cur["secret"] != d["secret"]:
            # replacing the key orphans the name's published msg entry: only with the PIN and on purpose
            if body.get("replace") is not True:
                return 409, {"error": "This device already has a messaging key."}
            refused = pin_attempt(req, str(body.get("pin", "")), "messaging key refused, wrong PIN")
            if refused:
                code, obj = refused
                return (403 if code == 401 else code), obj
        if cur and cur["secret"] == d["secret"]:
            return 200, {"public": d["public"], "topic": inbox_topic(d["public"])}
        msg_key_save(msg_key_record(d, (cur or {}).get("name", ""), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
        event("messaging key replaced" if cur else "messaging key set", req)
        return 200, {"public": d["public"], "topic": inbox_topic(d["public"])}
    if path == "/api/messages/name":
        cur = msg_key_load()
        name = str(body.get("name", ""))
        if not cur:
            return 409, {"error": "Turn on messages first."}
        if name and not NAME_RE.match(name):
            return 400, {"error": "That isn't an LNS name."}
        cur["name"] = name
        msg_key_save(cur)
        return 200, {"name": name}
    if path == "/api/messages/send":
        topic, payload = str(body.get("topic", "")), body.get("payload")
        if not MSG_TOPIC_RE.match(topic):
            return 400, {"error": "That isn't a names inbox topic."}
        try:
            raw = base64.b64decode(str(payload), validate=True)
        except Exception:
            return 400, {"error": "The message isn't base64."}
        if not raw or len(raw) > PAYLOAD_MAX:
            return 413, {"error": "That message is too long."}
        code, reply = waku("POST", "/messaging/v1/messages",
                           {"payload": base64.b64encode(raw).decode(), "contentTopic": topic, "ephemeral": False}, timeout=10)
        if code == 0:
            return 503, {"error": "The messaging node is off, so the message wasn't sent.", "node_off": True}
        if code == 404:                          # "not available while initializing"
            return 503, {"error": "The messaging node is starting. Try again in a few seconds.", "starting": True}
        if code == 429:
            return 429, {"error": "The messaging node is busy. Try again in a moment."}
        if code != 200 or not isinstance(reply, dict) or not isinstance(reply.get("requestId"), str):
            return 502, {"error": "The messaging node didn't take the message."}
        with msg_lock:
            sent_topics[topic] = time.time()
        event("message sent", req)
        return 200, {"requestId": reply["requestId"]}
    if path == "/api/messages/inbox/delete":
        ns = {n for n in (body.get("ids") or []) if isinstance(n, int) and not isinstance(n, bool)}
        with msg_lock:
            before = len(inbox["items"])
            inbox["items"] = [i for i in inbox["items"] if i["n"] not in ns]
            removed = before - len(inbox["items"])
            if removed:
                inbox_save()
        return 200, {"removed": removed}
    return 404, {"error": "not found"}


def messaging_get(path, query):
    """The /api/messages/* GET routes: (http status, reply)."""
    if path == "/api/messages/status":
        key = msg_key_load()
        with msg_lock:
            st = dict(msg_state)
            count = sum(1 for i in inbox["items"] if not i.get("read"))
        return 200, {"node": {"configured": st.get("configured", bool(waku_api())), "reachable": st["reachable"],
                              "starting": bool(st.get("starting")),
                              "health": st["health"], "connection": st["connection"],
                              "checked_s_ago": round(time.time() - st["checked"]) if st["checked"] else None},
                     "key": key["public"] if key else None, "name": (key or {}).get("name", ""),
                     "topic": inbox_topic(key["public"]) if key else None, "subscribed": bool(key and st["subscribed"]),
                     "inbox": count, "unread": count, "missed": st["missed"]}
    if path == "/api/messages/key":
        key = msg_key_load()
        if not key:
            return 404, {"error": "This device has no messaging key yet."}
        return 200, {"secret": key["secret"], "public": key["public"], "name": key.get("name", ""),
                     "seed": key.get("seed"), "version": key.get("version", 1), "groups": bool(key.get("seed"))}
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(query).query)
    num = lambda k: int(q[k][0]) if q.get(k) and re.match(r"^\d{1,12}$", q[k][0]) else 0
    if path == "/api/messages/inbox":
        after = num("after")                       # only what came after this number
        with msg_lock:
            return 200, {"items": [dict(i) for i in inbox["items"] if i["n"] > after], "next": inbox["next"],
                         "unread": [i["n"] for i in inbox["items"] if not i.get("read")]}
    if path == "/api/messages/outbox":
        after, since = num("after"), num("since")  # new items in full; older ones only when a send changed
        with msg_lock:
            return 200, {"items": [outbox_view(i) for i in outbox["items"] if i["n"] > after],
                         "changed": [{"n": i["n"], "v": i.get("v", 0), "sends": outbox_view(i)["sends"]}
                                     for i in outbox["items"] if i["n"] <= after and i.get("v", 0) > since],
                         "rev": outbox.get("rev", 0), "next": outbox["next"]}
    if path == "/api/messages/store":
        with msg_lock:
            return 200, store_load()
    m = re.match(r"^/api/messages/send/([A-Za-z0-9_.:-]{1,128})$", path)
    if m:
        code, st = waku("GET", "/messaging/v1/events/send/" + m.group(1), timeout=6)
        if code == 404:
            return 200, {"events": [], "done": False}
        if code != 200 or not isinstance(st, dict):
            return 200, {"events": [], "done": False, "node_off": code == 0}
        kinds = [str(e.get("kind")) for e in st.get("events") or [] if isinstance(e, dict)]
        err = next((str(e.get("error") or "") for e in st.get("events") or [] if isinstance(e, dict) and e.get("kind") == "error"), "")
        return 200, {"events": kinds, "done": "sent" in kinds or "error" in kinds, "error": err[:200]}
    return 404, {"error": "not found"}


def native_fingerprint_reset():
    """Inside the Android app: the phone's fingerprints were added or removed, so the key behind fingerprint
    unlock is gone. Turns native fingerprint unlock off (the PIN turns it on again) and locks an open
    wallet. Returns True if it changed something (the setting was on, or a session was open), else False.
    Not embedded: does nothing and returns False. No HTTP route: only the app's own process calls it."""
    if not EMBEDDED:
        return False
    was_on = bool(wallet_settings.get("native_fingerprint"))
    if was_on:
        wallet_settings["native_fingerprint"] = False
        settings_save()
        event("fingerprint unlock turned off", reason="fingerprints changed", source="android")
    with lock:
        had_session, session["token"] = session["token"] is not None, None
    if had_session:
        event("wallet locked", reason="fingerprints changed")
    return was_on or had_session


def node_cmd(cfg, flag):
    cmd = [NODE_BIN] + (["--deployment", NODE_DEPLOYMENT] if NODE_DEPLOYMENT else []) + [flag, cfg]
    return subprocess.run(cmd, cwd=os.path.dirname(cfg), capture_output=True, text=True, timeout=60)


def restore_backup(doc, password):
    """(http status, reply, event detail). Puts the key file from a backup in place of the node's own,
    only after the node itself has checked it, and keeps the old one beside it."""
    if not isinstance(doc, dict) or doc.get("format") != BACKUP_FORMAT or doc.get("version") not in BACKUP_AADS \
            or isinstance(doc.get("version"), bool):
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
        plain = aead_decrypt(backup_key(password, salt, params), nonce, sealed, BACKUP_AADS[doc["version"]]) if len(nonce) == 12 else None
    except Exception:
        plain = None
    if plain is None:
        return 400, {"error": "Wrong backup password, or the file has been changed or damaged. Nothing was changed."}, "password"
    try:
        content = json.loads(plain)
        new_text = content["keystore.yaml"]
        new_bytes = new_text.encode("utf-8")
        msg_key = content.get("messaging_key") if doc["version"] >= 2 else None
        if msg_key is not None and not msg_key_valid(msg_key):
            raise ValueError
        chat = content.get("chat") if msg_key else None
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
        before = (msg_key_load() or {}).get("secret")
        if msg_key and msg_key_restore(msg_key):
            n = chat_restore(chat, before != msg_key["secret"]) if chat and messaging_on() else 0
            return 200, {"unchanged": True, "messaging_key_restored": True, "messages_restored": n,
                         "message": "These are the wallet keys already in use. The messaging key from the backup is back in place."}, "same keys, messaging key"
        n = chat_restore(chat, False) if chat and messaging_on() else 0
        if n:
            return 200, {"unchanged": True, "messages_restored": n,
                         "message": "These are the keys this wallet already uses. Messages from the backup were added."}, "same keys, messages"
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
    before = (msg_key_load() or {}).get("secret")
    if msg_key and msg_key_restore(msg_key):
        reply["messaging_key_restored"] = True
    if chat and messaging_on():
        reply["messages_restored"] = chat_restore(chat, before != msg_key["secret"])
    if not restarted:
        reply["manual"] = restart_hint()
    return 200, reply, "restored"


def chat_backup(history):
    """The chats for a backup: the encrypted profiles blob, and (with `history`) the sealed incoming messages
    and encrypted sent copies, newest first up to HISTORY_BACKUP_MAX. None when there is nothing."""
    with msg_lock:
        store = store_load().get("blob")
        ins = [{"payload": i["payload"], "received": i.get("received"), "read": bool(i.get("read"))} for i in inbox["items"]]
        outs = [{"copy": i["copy"], "at": i["at"], "states": [x["state"] for x in i["sends"]]} for i in outbox["items"]]
    chat = {"store": store, "inbox": [], "outbox": [], "truncated": False}
    if history:
        size = 0
        rows = sorted([("i", r.get("received") or "", r) for r in ins] + [("o", r["at"] or "", r) for r in outs],
                      key=lambda t: t[1], reverse=True)
        for kind, _, r in rows:
            size += len(json.dumps(r))
            if size > HISTORY_BACKUP_MAX:
                chat["truncated"] = True
                break
            chat["inbox" if kind == "i" else "outbox"].append(r)
        chat["inbox"].reverse(); chat["outbox"].reverse()
    return chat if (store or chat["inbox"] or chat["outbox"]) else None


def chat_restore(chat, replace_store):
    """Puts the chats from a backup back: messages are added to what is here (each once), and the profiles
    blob replaces this one's when `replace_store` (a different messaging key, or none here yet) or when there
    is none here. Returns how many messages came back."""
    if not isinstance(chat, dict):
        return 0
    added = 0
    with msg_lock:
        have = {i["payload"] for i in inbox["items"]}
        for r in chat.get("inbox") or []:
            if isinstance(r, dict) and _b64_ok(r.get("payload"), PAYLOAD_MAX) and r["payload"] not in have:
                have.add(r["payload"])
                inbox["items"].append({"n": inbox["next"], "payload": r["payload"], "source": "backup",
                                       "received": str(r.get("received") or "")[:32], "read": bool(r.get("read", True))})
                inbox["seen"].append("p:" + hashlib.sha256(base64.b64decode(r["payload"])).hexdigest())
                inbox["next"] += 1
                added += 1
        inbox["items"].sort(key=lambda i: i.get("received") or "")
        inbox_save()
        have = {i["copy"] for i in outbox["items"]}
        for r in chat.get("outbox") or []:
            if isinstance(r, dict) and _b64_ok(r.get("copy"), COPY_MAX) and r["copy"] not in have:
                have.add(r["copy"])
                states = [st if st in ("sent", "propagated", "failed") else "failed" for st in (r.get("states") or ["sent"])][:SENDS_MAX]
                item = {"n": outbox["next"], "copy": r["copy"], "at": str(r.get("at") or "")[:32],
                        "sends": [{"topic": "", "payload": None, "state": st, "error": "", "at": None, "done": True} for st in states]}
                outbox["next"] += 1
                outbox["items"].append(item)
                outbox_touch(item)
                added += 1
        outbox["items"].sort(key=lambda i: i.get("at") or "")
        outbox_save()
        blob = chat.get("store")
        if _b64_ok(blob, STORE_MAX):
            cur = store_load()
            if replace_store or not cur.get("blob"):
                _json_save(STORE_FILE, {"rev": cur["rev"] + 1, "blob": blob})
    return added


def backup_export(password, history=True):
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
    content, version = {"keystore.yaml": text}, BACKUP_VERSION
    mk = msg_key_load()
    if mk:                                    # the messaging key goes along: version 2
        content["messaging_key"] = {k: mk[k] for k in ("secret", "public", "name", "seed", "version") if mk.get(k)}
        version = 2
        chat = chat_backup(history) if messaging_on() else None
        if chat:                              # an app before 0.9 ignores it and restores the keys
            content["chat"] = chat
    sealed = aead_encrypt(backup_key(password, salt), nonce, json.dumps(content).encode(), BACKUP_AADS[version])
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
        "format": BACKUP_FORMAT, "version": version,
        "created": created,
        "addresses": [{"label": k["label"], "key": k["key"]} for k in wallet_keys()],
        "kdf": dict(BACKUP_SCRYPT, name="scrypt", salt=b64(salt)),
        "cipher": {"name": "chacha20-poly1305", "nonce": b64(nonce), "aad": BACKUP_AADS[version].decode()},
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
            # with messages, a name's avatar (an inline data: picture, as the Names SPEC has them) can show
            img = "img-src 'self' data:" if messaging_on() else "img-src 'self'"
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; %s; manifest-src 'self'; base-uri 'none'; form-action 'none'" % img)
        self.end_headers()
        self.wfile.write(data)

    def body_limit(self):
        # a backup with message history, and the saved chats, are larger than anything else
        path = self.path.split("?", 1)[0]
        if path == "/api/wallet/restore":         # a backup made on a phone with messages can carry its history
            return 4 * 1048576
        if messaging_on() and path == "/api/messages/store":
            return STORE_MAX * 2
        return 65536

    def host_ok(self):
        # refuse requests that reached us under another name (DNS rebinding)
        return self.headers.get("Host", "") in HOSTS

    def authed(self):
        return session_ok(self.headers.get("X-Session", ""))

    # POSTs that are the user doing something; they count as activity for auto-lock. Everything the
    # page does on a timer (status, accounts, history, receipts, transfer status) does not.
    USER_ACTIONS = {"/api/wallet/activity", "/api/wallet/send", "/api/wallet/backup", "/api/wallet/restore",
                    "/api/wallet/settings", "/api/wallet/passkey/options", "/api/wallet/passkey/register",
                    "/api/wallet/passkey/remove", "/api/update/check", "/api/update/passkey/challenge",
                    "/api/update/apply", "/api/names/rpc", "/api/wallet/native-fingerprint",
                    "/api/messages/key", "/api/messages/name", "/api/messages/send", "/api/messages/inbox/delete",
                    "/api/messages/outbox", "/api/messages/outbox/retry", "/api/messages/outbox/delete",
                    "/api/messages/store"}

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        # This app listens on 127.0.0.1 only, so nothing off this device can reach it. The status
        # endpoints answer whatever Host name a request carries (they hold nothing private). The wallet
        # answers only requests addressed to 127.0.0.1 or localhost, so a web page that points another
        # name at this address (DNS rebinding) can't reach it.
        if (path.startswith("/api/wallet") or path.startswith("/api/messages")) and not self.host_ok():
            return self.reply(403, {"error": "The wallet only opens on the device that runs the node.", "local_only": True})
        if path == "/":
            try:
                with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
                    page = f.read().replace(b"__APP_VERSION__", APP_VERSION.encode())
                page = page.replace(b"__APP_EMBEDDED__", b"android" if EMBEDDED else b"")
                if messaging_on():                # the Messages panel, only where a messaging node can run
                    page = page.replace(b"</body>", b'<script type="module" src="/messages/messages.js"></script>\n</body>', 1)
                return self.reply(200, raw=page, ctype="text/html; charset=utf-8")
            except Exception:
                return self.reply(500, {"error": "index.html is missing"})
        if path.startswith("/api/messages/") or path.startswith("/messages/") or path.startswith("/noble-curves/"):
            if not messaging_on():
                return self.reply(404, {"error": "not found"})
            m = MESSAGES_FILE_RE.match(path)
            if m:
                try:
                    with open(os.path.join(APP_DIR, m.group(1)), "rb") as f:
                        return self.reply(200, raw=f.read(), ctype="text/javascript; charset=utf-8")
                except Exception:
                    return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            code, obj = messaging_get(path, self.path)
            return self.reply(code, obj)
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
            out = {"node": st, "sync": sync_status(st)} if st else {"node": None, "waiting": node_waiting()}
            out.update(version=APP_VERSION, update={"available": update_state["latest"]})
            if EMBEDDED:
                out["embedded"] = "android"
            return self.reply(200, out)
        if path in ("/cryptarchia/info", "/network/info"):       # read-only pass-through
            code, reply = node(path, timeout=5)
            return self.reply(200 if code == 200 else 502, reply if code == 200 else {"error": "node not answering"})
        if path == "/api/wallet":
            with lock:
                wait = max(0, int(fails["until"] - time.time()))
            out = {"pin_set": pin_is_set(), "unlocked": self.authed(), "wait": wait,
                   "passkeys": len(passkeys_load()["keys"]), "names_program": NAMES_PROGRAM,
                   "autolock_minutes": wallet_settings["autolock_minutes"], "leave_grace": LEAVE_GRACE}
            if EMBEDDED:
                out.update(embedded="android", native_fingerprint=bool(wallet_settings.get("native_fingerprint")))
            return self.reply(200, out)
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
            body = json.loads(self.rfile.read(n) or b"{}") if 0 <= n <= self.body_limit() else None
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
            code, obj, source = backup_export(password, body.get("history", True) is not False)
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
        if path in self.USER_ACTIONS and self.authed():
            session_touch(visible=True)
        if path == "/api/wallet/lock":
            had = self.authed()
            with lock:
                session["token"] = None
            event("wallet locked", self, reason="user", by_unlocked_page="yes" if had else "no")
            return self.reply(200, {"ok": True})
        if path == "/api/wallet/activity":
            return self.reply(200, {"ok": True}) if self.authed() else self.reply(401, {"error": "locked"})
        if path == "/api/wallet/visibility":
            # the page tells us when it is hidden or shown again; leaving locks after LEAVE_GRACE
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            if body.get("state") == "hidden":
                with lock:
                    if session["hidden_since"] is None:
                        session["hidden_since"] = time.time()
            elif body.get("state") == "visible":
                session_touch(visible=True)
            else:
                return self.reply(400, {"error": "state must be hidden or visible"})
            return self.reply(200, {"ok": True})
        if path == "/api/wallet/settings":
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            n = body.get("autolock_minutes")
            if n not in AUTOLOCK_CHOICES or isinstance(n, bool):
                return self.reply(400, {"error": "Auto-lock can be 1, 5 or 15 minutes."})
            wallet_settings["autolock_minutes"] = n
            settings_save()
            event("auto-lock changed", self, minutes=n)
            return self.reply(200, {"autolock_minutes": n})
        if path.startswith("/api/messages/"):
            if not messaging_on():
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            code, obj = messaging_post(path, body, self)
            return self.reply(code, obj)
        if EMBEDDED and path.startswith("/api/update/"):
            return self.reply(409, {"error": EMBEDDED_UPDATES})
        if path == "/api/wallet/native-fingerprint":
            # the phone's own fingerprint check, inside the Android app only
            if not EMBEDDED:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            on = body.get("on")
            if not isinstance(on, bool):
                return self.reply(400, {"error": "on must be true or false"})
            if on:
                refused = pin_attempt(self, str(body.get("pin", "")), "fingerprint unlock refused, wrong PIN")
                if refused:
                    code, obj = refused
                    return self.reply(403 if code == 401 else code, obj)
            wallet_settings["native_fingerprint"] = on
            settings_save()
            event("fingerprint unlock turned on" if on else "fingerprint unlock turned off", self, source="android")
            return self.reply(200, {"native_fingerprint": on})
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


def main():
    """Starts the app and serves until the process ends. The Android app imports this module and calls main()
    in a thread, so it can also call native_unlock() in the same process."""
    if EMBEDDED:
        event("app start", port=PORT, version=APP_VERSION, embedded="android")
    else:
        event("app start", port=PORT, version=APP_VERSION)
    threading.Thread(target=wallet_keys, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    if not EMBEDDED:
        threading.Thread(target=update_loop, daemon=True).start()
    if messaging_on():
        messaging_start()
    threading.Thread(target=session_watch, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

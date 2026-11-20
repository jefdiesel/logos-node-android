#!/usr/bin/env python3
"""Local web app for a Logos node running on the same device: node status plus a small wallet.

It listens on 127.0.0.1 only and talks to the node's own API at NODE_API (127.0.0.1:8080 unless set;
the Linux Terminal install uses port 880).
Python standard library only. Wallet calls need a PIN that is set on first use.
"""
import base64, calendar, hashlib, hmac, http.server, json, os, re, secrets, shlex, shutil, struct, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request

APP_VERSION = "0.9.33"
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
# APP_KEY: a secret the Android app makes at every start and gives only to its own WebView, as the cookie
# APP_KEY_COOKIE (android/LOCAL-APIS.md). Any app on a phone can open a TCP connection to 127.0.0.1 and send
# any Host and Origin, so with APP_KEY set every request needs the cookie, except the page's public files and
# the names forwarder (its own secret path). Unset (Linux, Termux): nothing changes.
APP_KEY = os.environ.pop("APP_KEY", "")     # taken out, so the child processes this app starts don't inherit it
APP_KEY_COOKIE = "app_key"
# Set while this process holds PORT and serves it. The Android app asks for it in-process before it loads the
# page and hands the WebView the cookie: an answer on the port alone could come from another app that took the
# port first (android/LOCAL-APIS.md).
SERVING = threading.Event()
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
session = {"token": None, "active": 0.0, "hidden_since": None, "hidden_by": None}
fails = {"count": 0, "until": 0.0}
keys_cache = {"keys": [], "at": 0.0}


# ---- node API -------------------------------------------------------------------------------

# NODE_API "unix:<path>": the node serves its API on that Unix socket and on no TCP port (the Android app with
# node patch 0002, android/LOCAL-APIS.md). Every call then goes over the socket; nothing here ever uses TCP.
import errno, http.client, socket  # noqa: E402


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        try:
            s.connect(self.unix_path)
        except Exception:
            s.close()
            raise
        self.sock = s


def unix_http(sock_path, method, path, data=None, headers=None, timeout=8, limit=16 * 1024 * 1024):
    """One HTTP request over a Unix socket: (status, the whole body). Raises when there is no answer, when the
    answer is larger than `limit`, or when it ends before its Content-Length or chunked end: an answer is never
    taken cut short. (One with neither a length nor chunks ends when the connection closes, so it can't be told
    from a cut one; the node and the runner always send a length.) The runner keeps its buffer below 2 MiB."""
    conn = _UnixHTTPConnection(sock_path, timeout)
    try:
        conn.request(method, path, body=data, headers=headers or {})
        r = conn.getresponse()
        if r.length is not None:
            if r.length > limit:
                raise ValueError("answer too large")
            raw = r.read()                      # raises IncompleteRead if the body ends short of its length
        else:
            raw = r.read(limit + 1)             # chunked: raises IncompleteRead if cut
            if len(raw) > limit:
                raise ValueError("answer too large")
        return r.status, raw
    finally:
        conn.close()


def node(path, body=None, timeout=8):
    """Calls the node. Returns (http status, parsed JSON or text). Status 0 means no answer."""
    data = None if body is None else json.dumps(body).encode()
    if NODE_API.startswith("unix:"):
        try:
            code, raw = unix_http(NODE_API[len("unix:"):], "GET" if data is None else "POST", path, data,
                                  {"Content-Type": "application/json"} if data is not None else {}, timeout)
        except Exception:
            return 0, None
        try:
            return code, json.loads(raw)
        except Exception:
            return code, raw.decode(errors="replace")
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
    out = {"height": c.get("height"), "slot": c.get("slot"), "state": c.get("state"), "phase": info.get("phase"),
           "lib_slot": c.get("lib_slot")}
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


def _read_capped(r, cap, end):
    """At most cap + 1 bytes of an answer, a piece at a time; raises TimeoutError once time.monotonic() passes `end`
    (an answer that trickles in a byte at a time is cut off, not waited for)."""
    read = getattr(r, "read1", None) or r.read
    out = bytearray()
    while len(out) <= cap:
        if end is not None and time.monotonic() > end:
            raise TimeoutError("answer too slow")
        piece = read(min(16384, cap + 1 - len(out)))
        if not piece:
            break
        out += piece
    return bytes(out)


def _fetch_within(url, data, method, headers, cap, timeout, total):
    """One request with an overall limit of `total` seconds for all of it: connecting, TLS, the status line, the
    headers and the body. A timer shuts the socket at the limit, which wakes any read waiting on it. TLS is verified
    (the default context); a redirect is answered as it is, never followed. (status, bytes), or raises."""
    import ssl
    u = urllib.parse.urlsplit(url)
    end = time.monotonic() + total
    per = max(0.1, min(timeout, total))
    if u.scheme == "https":
        conn = http.client.HTTPSConnection(u.hostname, u.port, timeout=per, context=ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(u.hostname, u.port, timeout=per)
    cut = []

    def stop():
        cut.append(1)
        sk = conn.sock
        try:
            if sk is not None:
                sk.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
    timer = threading.Timer(total, stop)
    timer.daemon = True
    timer.start()
    try:
        path = (u.path or "/") + ("?" + u.query if u.query else "")
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        body = _read_capped(r, cap, end)
        if cut:                           # the timer shut the socket: what was read is cut off, not an answer
            raise TimeoutError("answer too slow")
        return r.status, body
    except Exception:
        if cut or time.monotonic() > end:
            raise TimeoutError("answer too slow")
        raise
    finally:
        timer.cancel()
        conn.close()


def fetch_outside(url, body=None, cap=65536, timeout=8, total=None):
    """GET (or POST `body` as JSON) to a fixed outside URL: no redirects, at most `cap` bytes, `timeout` seconds per
    socket operation and, with `total`, that many seconds for the whole request (connecting and the headers too).
    Returns (http status, bytes); raises on a bad URL, no answer, an answer that is too big or too slow."""
    if not outside_url_ok(url):
        raise ValueError("refused URL")
    data = None if body is None else json.dumps(body).encode()
    method = "GET" if body is None else "POST"
    headers = {"Content-Type": "application/json", "User-Agent": "logos-node-app"}
    if total is not None:
        code, raw = _fetch_within(url, data, method, headers, cap, timeout, total)
    else:
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with _outside.open(req, timeout=timeout) as r:
                code, raw = r.status, r.read(cap + 1)
        except urllib.error.HTTPError as e:
            with e:
                code, raw = e.code, e.read(cap + 1)
    if len(raw) > cap:
        raise ValueError("answer too big")
    return code, raw


# ---- LNS names: the page resolves names itself; this only forwards the one read it needs -----
# The page runs the names project's reference resolver (names/names.js). The name never leaves
# the device: the page derives the name's record account and asks the network for that account,
# through here so the page can keep talking to this app only. Only getAccountView of one account
# under the LNS registry is forwarded, to the LEZ 0.4 network the wallet uses (names04_net below).

ACCOUNT_ID_RE = re.compile(r"\A[1-9A-HJ-NP-Za-km-z]{32,44}\Z")
NAME_RE = re.compile(r"\A(?!-)[a-z0-9-]{1,32}(?<!-)\Z")
NAMES_DIR = os.path.join(APP_DIR, "names")
MESSAGES_FILE_RE = re.compile(r"^/((?:messages/(?:noble-(?:ciphers|hashes)/)?|noble-curves/(?:abstract/)?)[A-Za-z0-9_][A-Za-z0-9_.-]*\.js)$")
NAMES_FILE_RE = re.compile(r"^/names/((?:noble-hashes/)?[A-Za-z0-9_][A-Za-z0-9_.-]*\.js)$")
QR_FILE = "/qr/qrcode.js"                 # the QR code drawer (vendored, see app/qr/VENDORED.txt)
NET04_FONTS = {"/net04/fonts/Gloock-Regular.ttf": "Gloock-Regular.ttf", "/net04/fonts/FiraCode-VF.ttf": "FiraCode-VF.ttf"}   # the name card's (OFL)


def names04_net():
    """(RPC URL, LNS registry) of the LEZ 0.4 network the name lookups read: the one the wallet's 0.4 reader and signer
    use (app/lez04.json, or the network set in Settings → Network), in the Linux app too. ("", "") if unset."""
    try:
        import lez04
        c = lez04.config(DATA_DIR, APP_DIR)
    except Exception:
        return "", ""
    url, reg = c.get("rpc_url"), c.get("lns_registry")
    return (url if isinstance(url, str) else "",
            reg if isinstance(reg, str) and ACCOUNT_ID_RE.match(reg) else "")


def names_rpc(body):
    """(http status, reply bytes or object) for one getAccountView of one account under the LNS registry, forwarded to the
    LEZ 0.4 network through the app's one pacer (lez04_pacer)."""
    url, registry = names04_net()
    params = body.get("params")
    q = params[0] if isinstance(params, list) and len(params) == 1 else None
    if body.get("method") != "getAccountView" or not isinstance(q, dict) or set(q) != {"account_id", "program_account_id"} \
            or not isinstance(q["account_id"], str) or not ACCOUNT_ID_RE.match(q["account_id"]) \
            or not registry or q["program_account_id"] != registry:
        return 400, {"error": "Only getAccountView of one account under the LNS registry is forwarded."}
    try:
        if not outside_url_ok(url):
            raise ValueError("no network")
        lez04_pacer().wait()
        code, data = fetch_outside(url, {"jsonrpc": "2.0", "id": body.get("id", 1) if isinstance(body.get("id"), int) else 1,
                                         "method": "getAccountView",
                                         "params": [{"account_id": q["account_id"], "program_account_id": registry}]},
                                   cap=262144, timeout=8)
        reply = json.loads(data)
    except Exception:
        return 502, {"error": "The name service isn't answering."}
    if code != 200 or not isinstance(reply, dict):
        return 502, {"error": "The name service isn't answering."}
    return 200, data


HEX64_RE = re.compile(r"\A[0-9a-f]{64}\Z")
# An old app's bridge deposit to its LEZ 0.3 name account may still wait in the Activity list: it settles by this cap.
BRIDGE_MAX_FEE = 100000


def lns_name_ok(v):
    return isinstance(v, str) and bool(NAME_RE.fullmatch(v))


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
        replaced = session["token"] is not None
        session.update(token=secrets.token_hex(32), active=time.time(), hidden_since=None, hidden_by=None)
        token = session["token"]
    if replaced:                          # every end of a session is in the log, this one too
        event("wallet locked", reason="a new unlock replaced the open session")
    return token


def session_expire():
    """Ends the session when the user has been idle too long or left the page; logs why. The server
    decides this, not the page: timers in a hidden page don't run reliably."""
    now, reason = time.time(), None
    with lock:
        if not session["token"]:
            return
        if session["hidden_since"] is not None and now - session["hidden_since"] > LEAVE_GRACE:
            reason = "left the app" if session.get("hidden_by") == "app" else "left the page"
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
            session["hidden_since"], session["hidden_by"] = None, None


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


# ---- transfers from the wallet: one at a time per account, known by their hash -------------------------------------
# The model (android/LOCAL-APIS.md, "Transfers"):
#   - A transfer (a send, or setting an amount aside for a bridge) is made in the node's two steps. POST /wallet/fund
#     builds, funds and signs it and submits nothing; the app checks it is the transfer asked for, computes its hash
#     (xfer_hash) and saves the whole signed transfer (fsync'd) before POST /mempool/add/tx submits it. A failed fund
#     sent nothing. Every retry submits the SAME saved transfer (after 1, 2, 4 and 8 minutes). If a fund ever gives a
#     hash the app already holds (with its signed transfer), it is that transfer again: it is submitted again, not
#     recorded twice.
#   - One unsettled transfer per account: while one is waiting or in a block less than XFER_DEPTH (D) blocks deep, no
#     other send or bridge split from that account starts (a bridge waits for it and then goes on by itself).
#   - Settled: its hash in a block with at least D blocks on top ("in a block" from the first sight, "confirmed" at D,
#     "final" once at or below the node's last irreversible block). A block that disappears before it is D deep puts
#     it back to "waiting". D comes from the forks seen on the testnet (forks deeper than D are a known limit).
#   - The one exit for a transfer that never lands: XFER_GIVE_UP has passed since its last submit or sighting (the
#     node's pool keeps a transaction 9 hours: services/tx-service/src/backend/pool.rs:35), the node is online and
#     caught up (the tip a read goes to is at most XFER_TIP_LAG old by the phone's clock), and that read, from where it
#     was funded, doesn't have its hash. Then it reads "not found in a block" and frees its account; never "nothing was
#     sent". It is read again hourly for XFER_RECHECK_FOR: if it shows up D deep after all, it reads confirmed.
#   - A records file that can't be read is set aside (never overwritten); Activity shows one plain warning for a while
#     (the transfers it held are not followed any more) and the wallet carries on.
XFER_FILE = os.path.join(DATA_DIR, "wallet-transfers.json")
XFER_DEPTH = int(os.environ.get("XFER_DEPTH", "2"))  # 14 days on the testnet (M2 node): only depth-1 forks seen
XFER_RESUBMIT = float(os.environ.get("XFER_RESUBMIT_SECONDS", "60"))
XFER_RESUBMIT_FOR = 1800                    # resubmits only in its first 30 minutes: then the pool's clock runs out
XFER_POOL_LIFE = 9 * 3600                   # the node's DEFAULT_TX_TTL
XFER_GIVE_UP = float(os.environ.get("XFER_GIVE_UP_SECONDS", str(XFER_POOL_LIFE + 1800)))
XFER_RESCAN = float(os.environ.get("XFER_RESCAN_SECONDS", "60"))   # the chain is read for a transfer at most this often
XFER_TIP_LAG = 600                          # the exit only on a read to a tip at most this old (blocks: ~30-60 s apart)
XFER_MAX_FEE = 100000                       # the most a transfer's fee may be (the node checks it: max_tx_fee)
XFER_RECHECK = float(os.environ.get("XFER_RECHECK_SECONDS", "3600"))   # a "not found" one is read again this often...
XFER_RECHECK_FOR = 3 * 24 * 3600            # ...for this long
XFER_KEEP = 7 * 24 * 3600                   # records that are over (settled, not found, ended) are kept this long
XFER_SCAN_LIMIT = 500                       # blocks per page of the chain
XFER_SCAN_PAGES = 40                        # pages per read; a longer stretch is read on over the next looks
XFER_CRASH = os.environ.get("XFER_CRASH", "")   # tests only: "after-fund" ends the process once a transfer is saved
xfer_lock = threading.Lock()                # guards xfers and its file; taken before bridge_lock and hist_lock
xfers = {}
xfer_loaded = [False]
xfer_loaded_now = {}                        # record ids made by this process (a "funding" record isn't a crash)
WAITING = ("funding", "funded", "submitted")
XFER_LOST_TEXT = ("The list of waiting payments was lost (the file that keeps it couldn't be read). If you sent "
                  "something in the last %d hours, check with the recipient that it arrived before sending it again."
                  % round((XFER_GIVE_UP + XFER_RESUBMIT_FOR) / 3600))   # (said only about what may have been lost)
XFER_UNREADABLE = ("This app can't open its record of transfers right now, so it sends nothing until it can. "
                   "Nothing was sent.")


class XferUnreadable(Exception):
    pass


def mono_now():
    """Seconds on the boot clock: CLOCK_BOOTTIME (counts while the phone sleeps) where there is one, else the
    system-wide monotonic clock. Neither moves when the wall clock is set; both run on through app restarts."""
    return time.clock_gettime(time.CLOCK_BOOTTIME) if hasattr(time, "CLOCK_BOOTTIME") else time.monotonic()


def boot_id():
    """The kernel's id of this boot, or None where the app can't read it."""
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip() or None
    except Exception:
        return None


def xfer_stamp():
    return {"at": time.time(), "mono": mono_now(), "boot": boot_id()}


def xfer_age(s):
    """Seconds since the stamp `s`, on the boot clock while it is the same boot (it doesn't move when the wall clock
    is set), else on the wall clock. Same boot: the kernel's boot ids match; where they can't be read, the boot clock
    isn't behind the stamp (after a reboot it starts again from 0)."""
    try:
        mono, now = float(s.get("mono", -1)), mono_now()
        here = boot_id()
        same = s.get("boot") == here if s.get("boot") and here else 0 <= mono <= now
        return max(0.0, now - mono) if same else max(0.0, time.time() - float(s["at"]))
    except Exception:
        return 0.0


def xfer_hash(mantle_tx):
    """The node's hash of an unsigned transfer: blake2b-256 of "MANTLE_TXHASH_V1" and xfer_encode (only transfer ops).
    Checked against the node's own test vectors and against hashes the real node gave (tests/xfer_test.py)."""
    return hashlib.blake2b(b"MANTLE_TXHASH_V1" + xfer_encode(mantle_tx), digest_size=32).hexdigest()


def xfer_encode(mantle_tx):
    """The ops' binary encoding: a u8 op count; per transfer op: opcode 0, a u8 input count, the 32-byte note ids, a
    u8 output count, then per output the value as u64 little-endian and the 32-byte key (ids and keys as the JSON's
    hex, which is their byte order)."""
    ops = mantle_tx["ops"]
    b = bytes([len(ops)])
    for op in ops:
        if op.get("opcode") != 0:
            raise ValueError("not a transfer")
        p = op["payload"]
        if len(p["inputs"]) > 255 or len(p["outputs"]) > 255:
            raise ValueError("too many")
        if any(len(bytes.fromhex(i)) != 32 for i in p["inputs"]):
            raise ValueError("bad input")
        b += bytes([0, len(p["inputs"])]) + b"".join(bytes.fromhex(i) for i in p["inputs"]) + bytes([len(p["outputs"])])
        for o in p["outputs"]:
            v = int(o["value"])
            if not 0 <= v < 2 ** 64 or len(bytes.fromhex(o["pk"])) != 32:
                raise ValueError("bad output")
            b += v.to_bytes(8, "little") + bytes.fromhex(o["pk"])
    return b


def xfer_checked(reply, frm, to, amount, notes):
    """The node's funded transfer, if it is the one asked for: one transfer op, inputs that are notes of `frm` (as
    the wallet read them just before), one output of `amount` to `to`, any other outputs back to `frm`, a fee within
    XFER_MAX_FEE. Returns (signed transfer, hash, inputs, values of the outputs back to `frm`, fee), or None."""
    try:
        tx, proof = reply["funded_tx"], reply["transfer_proof"]
        ops = tx["ops"]
        if not isinstance(ops, list) or len(ops) != 1 or not isinstance(proof, dict) or len(proof) != 1:
            return None
        p = ops[0]["payload"]
        ins = [str(i).lower() for i in p["inputs"]]
        if not ins or len(set(ins)) != len(ins) or any(not HEX64_RE.fullmatch(i) or i not in notes for i in ins):
            return None
        outs = [(int(o["value"]), str(o["pk"]).lower()) for o in p["outputs"]]
        pay = [o for o in outs if o == (amount, to)]
        rest = list(outs)
        rest.remove((amount, to)) if pay else None
        if not pay or any(pk != frm or v < 0 for v, pk in rest):
            return None
        fee = sum(notes[i] for i in ins) - sum(v for v, _ in outs)
        if not 0 <= fee <= XFER_MAX_FEE:
            return None
        # every output paid back to the sending key (the change, and for a split the amount set aside too)
        return {"mantle_tx": tx, "ops_proofs": [proof]}, xfer_hash(tx), ins, [v for v, pk in outs if pk == frm], fee, \
            {i: notes[i] for i in ins}
    except Exception:
        return None


def node_raw(path, timeout=8):
    """GET from the node: (http status, the whole body as bytes) or (0, None). For answers that aren't one JSON
    document (the block stream is one JSON object per line)."""
    if NODE_API.startswith("unix:"):
        try:
            return unix_http(NODE_API[len("unix:"):], "GET", path, None, {}, timeout)
        except Exception:
            return 0, None
    try:
        with urllib.request.urlopen(NODE_API + path, timeout=timeout) as r:
            raw = r.read(16 * 1024 * 1024 + 1)
            return (r.status, raw) if len(raw) <= 16 * 1024 * 1024 else (0, None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


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
    if bal[0] < amount:
        return 400, {"error": "That key holds %d, less than %d." % (bal[0], amount)}
    labels = {k["key"]: k["label"] for k in wallet_keys()}
    entry = {"key": frm, "label": labels.get(frm, ""), "to": to, "amount": str(amount), "fee": None, "hash": None,
             "height": st.get("height")}
    if to in labels:
        entry["to_label"] = labels[to]
    name = str(body.get("name") or "")
    if NAME_RE.match(name):                 # the LNS name the page resolved `to` from, kept for the history
        entry["name"] = name
    return transfer(frm, to, amount, "send", entry)


def xfer_new(key, to, amount, kind, bridge_id=None):
    return {"id": secrets.token_hex(8), "key": key, "to": to, "amount": int(amount), "kind": kind, "bridge_id": bridge_id,
            "entry": None, "state": "funding", "t0": xfer_stamp(), "signed": None, "hash": None, "inputs": [],
            "change": [], "fee": None, "slot_from": None, "last_submit": None, "submits": 0, "seen": None,
            "final": False, "last_scan": None, "ckpt": None}


def xfer_records():
    """The records, read once per process (xfer_lock held). Raises XferUnreadable while the file can't be opened. A
    file whose contents don't read is set aside, and Activity warns about it for a while (xfer_lost)."""
    if xfer_loaded[0]:
        return xfers
    try:
        with open(XFER_FILE) as f:
            raw = f.read()
    except FileNotFoundError:
        xfer_loaded[0] = True
        return xfers
    except OSError as e:
        raise XferUnreadable(str(e))
    try:
        d = json.loads(raw)
        if not isinstance(d, dict) or not all(isinstance(r, dict) and r.get("id") == i and KEY_RE.match(str(r.get("key", "")))
                                              and isinstance(r.get("t0"), dict) for i, r in d.items()):
            raise ValueError("a record doesn't read")
        xfers.update(d)
    except Exception:
        aside = XFER_FILE + ".bad-%d" % int(time.time())
        try:
            os.replace(XFER_FILE, aside)
        except Exception:
            raise XferUnreadable("the file of transfers doesn't read and can't be set aside")
        event("transfers: the file of transfers doesn't read; set aside", file=aside)
        xfers.clear()
        xfers["lost"] = {"id": "lost", "key": "00" * 32, "state": "lost", "t0": xfer_stamp(), "kind": "lost"}
    xfer_loaded[0] = True
    xfer_save()
    return xfers


def xfer_save():
    """Writes the records (xfer_lock held); False if the disk didn't take them."""
    try:
        now = time.time()
        for i in [i for i, r in xfers.items() if r["state"] in ("settled", "notfound", "ended")
                  and now - r["t0"].get("at", now) > XFER_KEEP]:
            del xfers[i]
        tmp = XFER_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(xfers, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, XFER_FILE)
        try:
            dfd = os.open(os.path.dirname(XFER_FILE) or ".", os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except Exception:
            pass
        return True
    except Exception:
        return False


def xfer_lost():
    """The warning Activity shows while the records lost are recent, else None."""
    try:
        with xfer_lock:
            r = xfer_records().get("lost")
            if r and xfer_age(r["t0"]) > XFER_GIVE_UP + XFER_RESUBMIT_FOR:
                xfers.pop("lost", None)
                xfer_save()
                r = None
    except XferUnreadable:
        return XFER_UNREADABLE
    return XFER_LOST_TEXT if r else None


def xfer_status(r):
    """The Activity status a record means."""
    if r["state"] == "settled":
        return "in block"
    if r["state"] == "notfound":
        return "not found"
    return "confirming" if r.get("seen") else "pending"


def xfer_sync_entry(r):
    """Writes the record's state into its Activity entry (xfer_lock held)."""
    if r.get("entry") is None:
        return
    with hist_lock:
        for e in history["entries"]:
            if e.get("id") == r["entry"] and e.get("kind") == "sent":
                want = {"status": xfer_status(r), "hash": r.get("hash"), "final": bool(r.get("final"))}
                if r["state"] == "notfound":
                    want["hours"] = round(xfer_age(r["last_submit"] or r["t0"]) / 3600)
                if r.get("seen") or r["state"] == "settled":
                    want["fee"] = str(r["fee"])
                if any(e.get(k) != v for k, v in want.items()):
                    e.update(want)
                    e.pop("sending", None)
                    history_save()
                return


def xfer_entry_drop(r):
    with hist_lock:
        history["entries"] = [e for e in history["entries"] if not (e.get("id") == r.get("entry") and e.get("kind") == "sent")]
        history_save()


def xfer_may_exit(r):
    """Whether the record is old enough for the "not found in a block" exit: XFER_GIVE_UP since its last submit and
    since its last sighting in a block (a fork puts a transfer of a dropped block back in the node's pool with a new 9
    hours)."""
    return r["state"] == "submitted" and min(xfer_age(r["last_submit"] or r["t0"]),
                                             xfer_age(r["last_seen"]) if r.get("last_seen") else 1e18) >= XFER_GIVE_UP


def xfer_node_current(st):
    """Whether the node is online and its tip `st["slot"]` (the one a read goes to) is at most XFER_TIP_LAG old by
    this phone's clock. A node just restarted, or kept from the network (no signal, asleep), reports Online at an old
    tip. The slot is worked out from /time/info's genesis time and the clock: the node's own current_slot counts
    ticks of a timer started at the node's start (services/time/src/backends/common.rs), which may not count the
    time the phone slept. XFER_TIP_LAG stays well under XFER_GIVE_UP - XFER_POOL_LIFE, so a read that passes reaches
    past the time the transfer could still be in a pool."""
    if not st or st.get("state") != "Online" or not isinstance(st.get("slot"), int):
        return False
    code, t = node("/time/info", timeout=5)
    try:
        slot_ms = float(t["slot_duration_ms"])
        now_slot = max(int(t["current_slot"]), int((time.time() * 1000 - float(t["genesis_time_unix_ms"])) / slot_ms))
    except Exception:
        return False
    return code == 200 and slot_ms > 0 and (now_slot - st["slot"]) * slot_ms / 1000 <= XFER_TIP_LAG


def xfer_scan(r):
    """Reads the chain for the record's hash from its checkpoint (the last block read at least D deep with nothing of
    it), else from the slot it was funded at, towards the tip; blocks must link. Returns {"complete": reached the tip
    read before it began, "found": (slot, depth: blocks on top of it, final: at or below the LIB) or None, "ckpt",
    "current": the node was caught up when the read began (only asked when the exit is possible), "reset": the
    checkpoint block is no longer in the chain (a fork deeper than D)}."""
    out = {"complete": False, "found": None, "ckpt": None, "current": False, "reset": False}
    ck = r.get("ckpt") if isinstance(r.get("ckpt"), dict) else None
    slot_from = ck["slot"] + 1 if ck else r.get("slot_from")
    st = node_status()
    tip = st.get("slot") if st else None
    out["current"] = xfer_may_exit(r) and xfer_node_current(st)
    if not isinstance(slot_from, int) or not isinstance(tip, int):
        return out
    if slot_from > tip:
        out["complete"] = True                # no block yet since it was funded (or since the checkpoint)
        return out
    blocks, prev, last = [], (ck["id"] if ck else None), None
    for _ in range(XFER_SCAN_PAGES):
        code, raw = node_raw("/cryptarchia/blocks_range?slot_from=%d&order=ascending&blocks_limit=%d" % (slot_from, XFER_SCAN_LIMIT),
                             timeout=20)
        if code != 200 or raw is None:
            break
        count = 0
        try:
            for line in raw.decode().splitlines():
                if not line.strip():
                    continue
                ev = json.loads(line)
                blk = ev.get("block", ev)
                hdr = blk.get("header") or {}
                bid, parent, slot, lib = hdr.get("id"), hdr.get("parent_block"), hdr.get("slot"), ev.get("lib_slot")
                if not isinstance(slot, int) or not isinstance(bid, str) or not isinstance(lib, int):
                    raise ValueError("a block doesn't read")
                if prev is not None and parent != prev:
                    out["reset"] = bool(ck and not blocks)    # the checkpoint itself is gone: read again from the start
                    raise ValueError("a fork moved the chain while it was read")
                mine = any(str((t.get("mantle_tx") or {}).get("hash") or "").lower() == r.get("hash")
                           for t in blk.get("transactions") or [])
                blocks.append((slot, bid, lib, mine))
                prev, last = bid, slot
                count += 1
        except Exception:
            break
        if count == 0:
            break
        if last >= tip:
            out["complete"] = True
            break
        if count < XFER_SCAN_LIMIT:
            break
        slot_from = last + 1
    for n, (slot, bid, lib, mine) in enumerate(blocks):
        on_top = len(blocks) - 1 - n
        if mine:
            out["found"] = (slot, on_top, slot <= lib)
            break
        if on_top >= XFER_DEPTH:
            out["ckpt"] = {"slot": slot, "id": bid}
    return out


def xfer_settle(r, scan):
    """Applies a read of the chain (xfer_lock held). Returns what changed, or None."""
    if scan.get("reset"):
        r["ckpt"] = None
    if scan.get("ckpt"):
        r["ckpt"] = scan["ckpt"]
    was = (r["state"], r.get("seen"), r.get("final"))
    if scan["found"]:
        slot, on_top, final = scan["found"]
        deep = on_top >= XFER_DEPTH
        if r["state"] in WAITING or (r["state"] == "notfound" and deep):    # (one "not found" that shows up after all)
            r["state"] = "settled" if deep else "submitted"
            if deep:
                r["settled_at"] = time.time()
        if r["state"] != "notfound":
            r.update(seen={"slot": slot, "depth": on_top}, final=bool(final) or r.get("final", False), last_seen=xfer_stamp())
    elif scan["complete"] and r["state"] in WAITING:
        r["seen"] = None                      # gone from the chain before it was D deep: waiting again
        if scan.get("current") and xfer_may_exit(r):
            r.update(state="notfound", notfound_at=xfer_stamp())
    if (r["state"], r.get("seen"), r.get("final")) != was:
        xfer_sync_entry(r)
        return r["state"]
    return None


def xfer_hold(key):
    """The record that holds `key` (a transfer not settled yet), or None. xfer_lock held."""
    for r in xfer_records().values():
        if r["key"] == key and r["state"] in WAITING:
            return r
    return None


def xfer_why(r):
    if r.get("seen"):
        return ("A transfer from this account is in a block and isn't confirmed yet (it takes %d more blocks, a few "
                "minutes). Nothing else is sent from this account until then." % max(1, XFER_DEPTH - r["seen"]["depth"]))
    return ("A transfer from this account is waiting for a block. Nothing else is sent from this account until it is "
            "confirmed; Activity shows it.")


def xfer_spend_check(key):
    """None if `key` may start a transfer now, else why not."""
    xfer_round_caps()
    try:
        with xfer_lock:
            r = xfer_hold(key)
    except XferUnreadable:
        return XFER_UNREADABLE
    return xfer_why(r) if r else None


def xfer_submit(r):
    """Submits the record's saved transfer (the same one every time) and notes when."""
    code, reply = node("/mempool/add/tx", r["signed"], timeout=30)
    with xfer_lock:
        if r["state"] in ("funded", "submitted"):
            r.update(state="submitted", last_submit=xfer_stamp(), submits=r.get("submits", 0) + 1,
                     last_answer=("%d %s" % (code, reply if isinstance(reply, str) else json.dumps(reply)))[:200])
            xfer_save()
    return code, reply


def transfer(frm, to, amount, kind, entry_fields, bridge_id=None):
    """Makes one transfer from the wallet key `frm`: (http status, reply). See the section's comment."""
    try:
        with xfer_lock:
            xfer_records()
    except XferUnreadable:
        return 503, {"error": XFER_UNREADABLE}
    xfer_round_caps()
    st = node_status()
    if not st or st.get("state") != "Online" or not isinstance(st.get("slot"), int):
        return 409, {"error": "The node is not online yet, so it can't send. Wait until it has finished syncing."}
    notes = notes_of(frm)
    if notes is None:
        return 502, {"error": "The node didn't return this account's coins. Nothing was sent."}
    with xfer_lock:
        held = xfer_hold(frm)
        if held:
            return 409, {"error": xfer_why(held), "held": True}
        r = xfer_new(frm, to, amount, kind, bridge_id)
        r["slot_from"] = st["slot"]
        xfer_loaded_now[r["id"]] = True
        xfers[r["id"]] = r
        if not xfer_save():
            del xfers[r["id"]]
            xfer_save()
            return 503, {"error": "This app can't save its record of the transfer right now (is the phone's storage full?), "
                                  "so it didn't send it. Nothing was sent."}
        with hist_lock:                       # in Activity before the node is asked: a crash meanwhile leaves it there
            e = history_add("sent", **dict(entry_fields, status="pending", sending=True, xfer=r["id"]))
            history_save()
        r["entry"] = e["id"]
        xfer_save()
    code, reply = node("/wallet/fund", {
        "tip": None, "tx_builder": {"mantle_tx": {"ops": []}, "ledger_inputs": [],
                                    "pending_transfer": {"inputs": [], "outputs": [{"value": amount, "pk": to}]},
                                    "channel_multi_sig_proofs": {}},
        "change_public_key": frm, "funding_public_keys": [frm], "max_tx_fee": XFER_MAX_FEE, "priority_fee_percent": 0},
        timeout=60)
    got = xfer_checked(reply, frm, to, amount, notes) if code == 200 and isinstance(reply, dict) else None
    if got is None:
        text = reply if isinstance(reply, str) else json.dumps(reply) if reply is not None else ""
        why = (503, "The node didn't answer, so nothing was sent.") if code == 0 else \
            (409, "The node is still keeping some of this account's coins apart for a transfer it made a moment ago, or "
                  "the account holds too little for this amount and its fee. Nothing was sent.") if "enough funds" in text else \
            (502, "The node offered a transfer other than the one asked for, so nothing was sent.") if code == 200 else \
            (502, "The node refused the transfer: %s. Nothing was sent." % (text[:200] or "HTTP %d" % code))
        with xfer_lock:
            r.update(state="ended", result="not sent")
            xfer_save()
        xfer_entry_drop(r)                    # nothing was submitted: a fund never submits anything
        return why[0], {"error": why[1]}
    signed, h, ins, change, fee, in_values = got
    with xfer_lock:
        same = next((x for x in xfers.values() if x is not r and x.get("hash") == h and x.get("signed")), None)
        if same:
            # the very transfer the app already holds (same notes, same outputs): it is submitted again, once more
            # recorded once; it can land only once
            r.update(state="ended", result="the same as %s" % same["id"], same_as=same["id"])
            if same["state"] in ("notfound", "ended"):
                same.update(state="submitted", seen=None, ckpt=None, t0=xfer_stamp(), submits=0, slot_from=st["slot"])
                xfer_sync_entry(same)
            xfer_save()
        else:
            r.update(state="funded", signed=signed, hash=h, inputs=ins, change=change, fee=fee, in_values=in_values)
            saved = xfer_save()
            if not saved:
                r.update(state="ended", result="not sent", signed=None, hash=None)
                xfer_save()
            else:
                xfer_sync_entry(r)
    if same:
        xfer_entry_drop(r)
        if same["state"] == "submitted" and same.get("signed"):
            xfer_submit(same)
        return 200, {"hash": h, "fee": str(same.get("fee")), "again": True}
    if not saved:
        xfer_entry_drop(r)
        return 503, {"error": "This app can't save the transfer right now (is the phone's storage full?), so it didn't "
                              "send it. Nothing was sent."}
    if XFER_CRASH == "after-fund":
        os._exit(17)                          # tests only: the transfer is saved and not submitted
    code, reply = xfer_submit(r)
    out = {"hash": h, "fee": str(fee)}
    if not (200 <= code < 300):
        out["note"] = "The node didn't confirm it took the transfer. The app offers it again, the same transfer."
    return 200, out


def xfer_round_caps():
    """A "funding" record from before this start was stopped while the node funded it: a fund submits nothing, so
    it is dropped (the one thing decided at start-up)."""
    try:
        with xfer_lock:
            drop = [r for r in xfer_records().values() if r["state"] == "funding" and not xfer_loaded_now.get(r["id"])]
            for r in drop:
                r.update(state="ended", result="not sent")
            if drop:
                xfer_save()
    except XferUnreadable:
        return
    for r in drop:
        xfer_entry_drop(r)


def xfer_due(r):
    """Whether its saved transfer is due to be submitted again: waiting (not seen), within its first 30 minutes, after
    1, 2, 4 and 8 minutes; right away after a crash between saving and submitting."""
    if r.get("seen") or r["state"] not in ("funded", "submitted") or not r.get("signed"):
        return False
    if r["state"] == "funded":
        return True
    if xfer_age(r["t0"]) >= XFER_RESUBMIT_FOR:
        return False
    return xfer_age(r["last_submit"] or r["t0"]) >= XFER_RESUBMIT * 2 ** max(0, r.get("submits", 1) - 1)


def xfer_round():
    """One look at every transfer not settled: submit again what is due, read the chain. "Not found" ones are read
    again hourly for a while; settled ones not final yet only compare their block's slot with the node's LIB."""
    xfer_round_caps()
    try:
        with xfer_lock:
            todo = [r for r in xfer_records().values() if r["state"] in WAITING or (r["state"] == "settled" and not r.get("final"))
                    or (r["state"] == "notfound" and xfer_age(r.get("notfound_at") or r["t0"]) < XFER_RECHECK_FOR)]
    except XferUnreadable:
        return
    lib = []
    for r in todo:
        if r["state"] == "funding" or not r.get("hash"):
            continue
        if r["state"] == "settled":           # "final" once its block is at or below the node's last irreversible block
            if not lib:
                lib.append((node_status() or {}).get("lib_slot"))
            if isinstance(lib[0], int) and (r.get("seen") or {}).get("slot", lib[0] + 1) <= lib[0]:
                with xfer_lock:
                    r["final"] = True
                    xfer_sync_entry(r)
                    xfer_save()
            continue
        rate = XFER_RESCAN if r["state"] in WAITING else XFER_RECHECK
        if not r.get("last_scan") or xfer_age(r["last_scan"]) >= rate:
            scan = xfer_scan(r)
            with xfer_lock:
                r["last_scan"] = xfer_stamp()
                xfer_settle(r, scan)
                xfer_save()
        if xfer_due(r):
            xfer_submit(r)                    # the same saved transfer, again (or for the first time after a crash)


def xfer_spent_by_us(key):
    """Copies of `key`'s transfers that may land or have (for the history: their notes are theirs), "not found" ones
    still read again among them (one that lands after all is then its own entry, not a "changed" row)."""
    with xfer_lock:
        return [dict(r) for r in xfer_records().values() if r["key"] == key and r.get("inputs")
                and (r["state"] in ("funded", "submitted", "settled") or r["state"] == "notfound"
                     and xfer_age(r.get("notfound_at") or r["t0"]) < XFER_RECHECK_FOR)]


def tx_status(h):
    """A transfer this app made, by its hash."""
    try:
        with xfer_lock:
            r = next((r for r in xfer_records().values() if r.get("hash") == h), None)
    except XferUnreadable:
        return 503, {"error": XFER_UNREADABLE}
    if not r:
        return 404, {"error": "This app didn't send that transaction."}
    if r["state"] == "settled":
        return 200, {"state": "in_block", "confirmed": True, "final": bool(r.get("final")), "fee": str(r["fee"])}
    if r.get("seen"):
        return 200, {"state": "in_block", "confirmed": False, "final": False, "fee": str(r["fee"])}
    if r["state"] == "notfound":
        return 200, {"state": "not_found", "hours": round(xfer_age(r["last_submit"] or r["t0"]) / 3600)}
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
            f.flush()
            os.fsync(f.fileno())               # a transfer's entry is written before the node is asked: keep it
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
    spent_by_us = {k: xfer_spent_by_us(k) for k in found}
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
            # Our own transfers: one not settled yet is shown as if it hadn't happened (the notes it spends stay, what
            # it pays back to this key isn't shown), so a fork within D adds or takes away no row; once settled
            # (xfer_round runs first), its notes and what it pays back are its own Activity entry, not "changed" or
            # "received". Notes paid back are told apart by value.
            recs = {r["id"]: r for r in spent_by_us.get(key) or []}
            view = dict(new)
            by_settled = {i for r in recs.values() if r["state"] == "settled" for i in r["inputs"]}
            for r in recs.values():
                if r["state"] == "settled":
                    continue
                for i in r["inputs"]:
                    if i not in new and i in old and i not in by_settled:
                        view[i] = old[i]
                if any(i not in new for i in r["inputs"]):
                    for v in r.get("change") or []:
                        hit = next((i for i, w in sorted(view.items()) if w == v and i not in old), None)
                        if hit is not None:
                            view.pop(hit)
            new = view
            added = {i: v for i, v in new.items() if i not in old}
            removed = {i: v for i, v in old.items() if i not in new}
            done = set(history.setdefault("xfer_done", []))
            mine = {r["id"]: r for r in recs.values() if r["state"] == "settled" and r["id"] not in done}
            if not added and not removed and not mine:
                continue
            pend_back = [v for r in recs.values() if r["state"] != "settled" for v in r.get("change") or []]
            if any(i not in old and i not in new and (r.get("in_values") or {}).get(i) in pend_back
                   for r in mine.values() for i in r["inputs"]):
                continue                         # it spent the change of one of ours not settled yet: wait a look
            changed = True
            back = history.setdefault("xfer_back", {}).setdefault(key, [])
            back.extend(v for r in mine.values() for v in r.get("change") or [])
            for r in mine.values():
                for i in r["inputs"]:
                    v = (r.get("in_values") or {}).get(i)
                    if i in removed:
                        removed.pop(i)
                    elif i not in old and i not in new and isinstance(v, int):
                        if v in back:            # paid back by one of ours, then spent by another, between two looks
                            back.remove(v)
                        else:                    # received and spent between two looks: received all the same
                            history_add("received", key=key, label=label, amount=str(v), note=i, height=height)
                history["xfer_done"].append(r["id"])
            for v in list(back):
                hit = next((i for i, w in sorted(added.items()) if w == v), None)
                if hit is not None:
                    added.pop(hit)
                    back.remove(v)
            del back[:-50]
            history["xfer_done"] = history["xfer_done"][-200:]
            dep = next((e for e in history["entries"] if e["kind"] == "sent" and e.get("bridge") == "deposit" and e.get("key") == key
                        and e.get("status") == "pending" and e.get("note") in removed), None)
            if dep:                          # the bridge deposit spent its note: in a block (its note is its identity)
                fee = sum(removed.values()) - sum(added.values()) - int(dep["amount"])
                dep.update(status="in block", fee=str(fee) if 0 <= fee <= BRIDGE_MAX_FEE else None, landed_height=height,
                           landed=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                if 0 <= fee <= BRIDGE_MAX_FEE:
                    removed, added = {}, {}
                else:
                    removed.pop(dep["note"], None)
            if removed:
                out = sum(removed.values()) - sum(added.values())
                if out:
                    history_add("changed", key=key, label=label, amount=str(-out), height=height)
            else:
                for i, v in added.items():
                    history_add("received", key=key, label=label, amount=str(v), note=i, height=height)
            history["snapshot"][key] = new
        if changed:
            history_save()


def history_cap_old():
    """A pending "sent" entry no transfer record settles (one from an older version of the app, or a bridge deposit)
    reads "can't tell yet" after an hour, never pending for good."""
    with hist_lock:
        changed = False
        for e in history["entries"]:
            if e.get("kind") != "sent" or e.get("status") != "pending" or e.get("xfer"):
                continue
            try:
                age = time.time() - calendar.timegm(time.strptime(e["time"], "%Y-%m-%dT%H:%M:%SZ"))
            except Exception:
                age = 3601
            if age > 3600:
                e["status"] = "unknown"
                changed = True
        if changed:
            history_save()


def history_loop():
    while True:
        try:
            xfer_round()                       # transfers first: submitted again, or read from the chain
        except Exception:
            pass
        try:
            history_round()                    # then what came in and went out, with their notes set apart
        except Exception:
            pass
        try:
            history_cap_old()
        except Exception:
            pass
        time.sleep(HISTORY_POLL)


def history_page(before, limit):
    with hist_lock:
        out = [e for e in reversed(history["entries"]) if not before or e["id"] < before][:limit]
        page = {"entries": [dict(e) for e in out], "tracking": bool(history["snapshot"])}
    lost = xfer_lost()
    if lost:
        page["warning"] = lost
    return page


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
BACKUP_AADS = {1: b"logos-node-wallet-backup v1", 2: b"logos-node-wallet-backup v2", 3: b"logos-node-wallet-backup v3"}
# Version 3: the Android app's format from app 0.5.32 on (LEZ 0.4 only: the LEZ 0.4 wallet, no LEZ 0.3 name account).
# Inside the app only version 3 is restored: an older file (with its LEZ 0.3 parts) is refused with BACKUP_OLD
# (Jef, 2026-11-20: "Don't migrate old data"). Elsewhere (Linux, Termux) versions 1 and 2 are made and restored as before.
BACKUP_APP_VERSION = 3
BACKUP_OLD = "This backup is from an older version and can't be restored here."
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


def backup_has_messaging():
    """Whether the last backup holds the messaging key (made with Messages on, from 0.9.4; None if unknown)."""
    try:
        with open(BACKUP_STATE_FILE) as f:
            return json.load(f).get("messaging")
    except Exception:
        return None


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


def native_visibility(state):
    """Inside the Android app: the app itself says the wallet's screen went away ("hidden": onStop, Home, the screen
    off) or came back ("visible": onStart), so leaving counts even when the page's own report is lost (a hidden
    WebView may not send it). An absence longer than LEAVE_GRACE locks first; "visible" only ends the absence (it
    doesn't count as use). There is no HTTP route to this: only code in the app's own process calls it. Returns True
    if a session was open."""
    if not EMBEDDED or state not in ("hidden", "visible"):
        return False
    session_expire()
    with lock:
        if not session["token"]:
            return False
        if state == "hidden":
            if session["hidden_since"] is None:
                session["hidden_since"], session["hidden_by"] = time.time(), "app"
        else:
            session["hidden_since"], session["hidden_by"] = None, None
    return True


def native_unlocked():
    """Inside the Android app: whether the wallet is unlocked now, i.e. this server holds an open session (expired
    sessions are ended first, by the same rules as every request). The app's own screens outside the page (the Node
    screen) ask this before showing their controls. The page can't set it: a session only exists after a PIN or
    fingerprint unlock, and there is no HTTP route to this. Not embedded: always False."""
    if not EMBEDDED:
        return False
    session_expire()
    with lock:
        return session["token"] is not None


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
    """The node REST URL if it is plain http on this device, or "unix:<absolute path>" (the Android app's runner
    serves the same calls on a Unix socket, android/LOCAL-APIS.md), else "" (refused)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("unix:/") and "\x00" not in raw and len(raw) < 110:
        return raw
    try:
        u = urllib.parse.urlsplit(raw)
        if u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost", "::1") and u.port and u.path.strip("/") == "" \
                and not u.query and not u.username:
            return "http://%s:%d" % ("[::1]" if u.hostname == "::1" else u.hostname, u.port)
    except Exception:
        pass
    if raw not in _waku["refused"]:
        _waku["refused"].add(raw)
        sys.stderr.write("WAKU_API refused: it must be http://127.0.0.1:<port> or unix:<absolute path>, a node on this device\n")
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
# Requests (0.9.22): this code can't open a message, so it can't tell who sent it. The page sorts each incoming
# message once it has opened it ("k": "c" a chat, "r" a request, "d" dropped, POST /api/messages/inbox/sort).
# Until then a message is unsorted. Unsorted and request messages together are a ring of PENDING_MAX messages /
# PENDING_BYTES bytes: a new arrival always gets in, and the oldest request, then the oldest unsorted message,
# makes room (counted in inbox["lost"], which the page shows). So a flood while the page is away can't stop a
# contact's later message from arriving; it can push out one that came before the flood. The node offers no way
# to fetch such a message again (no Store query in its API; history comes only around its own start), so the
# page says how many were lost and when. Chat messages are capped apart (INBOX_MAX), so strangers can't push
# them out.
PENDING_MAX = int(os.environ.get("MESSAGING_PENDING_MAX", "2000"))
PENDING_BYTES = int(os.environ.get("MESSAGING_PENDING_BYTES", "8388608"))
# What the page drops by its rules (over a cap, blocked, "only people I've written to") is not deleted at once: it
# is marked "d" (hidden, read, not counted, not in backups) and deleted DROP_GRACE later, so a sorting mistake can
# still be undone for a while (the page puts a dropped message back as a chat message when its sender turns out to
# be a contact). Dropped messages have their own cap (DROPPED_MAX / DROPPED_BYTES, oldest deleted first), so a
# flood of them can't take the room of anything else. A Delete the user taps still deletes at once.
DROP_GRACE = float(os.environ.get("MESSAGING_DROP_GRACE_SECONDS", str(7 * 86400)))
DROPPED_MAX, DROPPED_BYTES = 2000, 8388608
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
    _fsync_write(MSG_KEY_FILE, json.dumps(d).encode())      # synced: a power cut leaves the old key or the new one
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


# The inbox and the outbox hold all of the chats' history: they are written synced (a power cut leaves the old
# file or the new one, never an empty one), the file a write replaces is kept as <file>.prev, and a file that
# can't be read is never written over: it is kept aside as <file>.unreadable-<time>-<random>, the .prev copy is
# used when it is readable, and numbering then goes on above anything the page may still know (no number is
# used twice).
_durable_good = {}                    # path -> True once this process read or wrote it whole


def _durable_save(path, d):
    data = json.dumps(d).encode()
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    if _durable_good.get(path) and os.path.exists(path):
        os.replace(path, path + ".prev")             # the copy this write replaces
    os.replace(path + ".tmp", path)
    try:
        dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except Exception:
        pass
    _durable_good[path] = True


def _durable_load(path, check):
    """(data or None, how): "ok", "missing", "prev" (the file couldn't be read; the .prev copy is used) or "lost"
    (neither could be read). A file that can't be read is kept aside, never written over."""
    def read(p):
        try:
            with open(p) as f:
                d = json.load(f)
            return d if check(d) else None
        except Exception:
            return None
    if not os.path.exists(path):
        d = read(path + ".prev")
        if d is not None:                              # a cut between keeping .prev and putting the new file in place
            _durable_good[path] = True
            return d, "prev"
        # nothing here, but a file kept aside as unreadable: history was lost before, numbers must still go on
        folder, base = os.path.split(path)
        if any(f.startswith(base + ".unreadable-") for f in os.listdir(folder or ".")):
            return None, "lost"
        return None, "missing"
    d = read(path)
    if d is not None:
        _durable_good[path] = True
        return d, "ok"
    aside = "%s.unreadable-%s-%s" % (path, time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()), secrets.token_hex(4))
    try:
        os.replace(path, aside)
    except Exception:
        pass
    d = read(path + ".prev")
    if d is not None:
        _durable_good[path] = True
        return d, "prev"
    return None, "lost"


def inbox_load():
    d, how = _durable_load(INBOX_FILE, lambda d: isinstance(d, dict) and isinstance(d.get("items"), list) and isinstance(d.get("seen"), list))
    if how in ("prev", "lost"):                         # numbers go on above anything used before
        d = d or {"version": 1, "items": [], "seen": [], "next": 1}
        d["next"] = max(int(d.get("next") or 1), int(time.time()))
        event("messages inbox file couldn't be read: " + ("the last copy is used" if how == "prev" else "kept aside, starting empty"))
    d = d or {"version": 1, "items": [], "seen": [], "next": 1}
    if not isinstance(d.get("sort_from"), int) or isinstance(d.get("sort_from"), bool):
        # the first start of 0.9.22 or later: what is here already came before Requests, and stays a chat
        d["sort_from"] = d.get("next", 1) if isinstance(d.get("next"), int) else 1
        for i in d["items"]:
            if isinstance(i, dict):
                i["k"] = "c"
    return d


inbox = {"version": 1, "items": [], "seen": [], "next": 1, "sort_from": 1}
_waku["feature"] = EMBEDDED or bool(waku_api())          # messages exist here at all (decided once)
_loaded = {"inbox": False, "outbox": False}       # each loaded once per process, whatever it held
if _waku["feature"]:
    inbox.update(inbox_load())
    _loaded["inbox"] = True


def inbox_save():
    """Writes the inbox; the caller holds msg_lock. It holds sealed payloads only. Chat messages and the rest
    (unsorted, requests) are trimmed apart, oldest first: INBOX_MAX and PENDING_MAX. Dropped ones ("d") go once
    DROP_GRACE has passed, or oldest first past DROPPED_MAX / DROPPED_BYTES."""
    chat = [i for i in inbox["items"] if i.get("k") == "c"]
    rest = [i for i in inbox["items"] if i.get("k") not in ("c", "d")]
    gone = [i for i in inbox["items"] if i.get("k") == "d"]
    now, size, keep = time.time(), 0, 0
    old = set()
    for i in reversed(gone):                     # newest first: keep within the caps and the grace
        size += len(i.get("payload") or "") * 3 // 4
        keep += 1
        if keep > DROPPED_MAX or size > DROPPED_BYTES or now - float(i.get("dropped_at") or 0) > DROP_GRACE:
            old.add(id(i))
    drop = {id(i) for i in chat[:max(0, len(chat) - INBOX_MAX)]} | {id(i) for i in rest[:max(0, len(rest) - PENDING_MAX)]} | old
    if drop:
        inbox["items"] = [i for i in inbox["items"] if id(i) not in drop]
    inbox["seen"] = inbox["seen"][-SEEN_MAX:]
    _durable_save(INBOX_FILE, inbox)


def messaging_inbox_count():
    """How many incoming messages are unread (for a notification without content). No HTTP route.
    The page marks messages read when they are shown (POST /api/messages/inbox/read), and a request read as
    soon as it has sorted it. This code can't open a message, so it can't tell a request, a muted or a blocked
    sender apart: those count until the page has been open once after they came."""
    with msg_lock:
        return sum(1 for i in inbox["items"] if not i.get("read") and i.get("k") != "r") if messaging_on() else 0


def waku(method, path, body=None, timeout=6):
    """(http status, parsed JSON or text) from the messaging node; status 0 when it doesn't answer."""
    api = waku_api()
    if not api:
        return 0, None
    if api.startswith("unix:"):
        try:
            code, data = unix_http(api[len("unix:"):], method, path, None if body is None else json.dumps(body).encode(),
                                   {"Content-Type": "application/json", "Accept": "application/json"}, timeout)
        except Exception:
            return 0, None
        try:
            return code, json.loads(data) if data else None
        except Exception:
            return code, data.decode(errors="replace")[:300]
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
        pending = [i for i in inbox["items"] if i.get("k") not in ("c", "d")]
        pend_n, pend_bytes = len(pending), sum(len(i.get("payload") or "") * 3 // 4 for i in pending)
        # who makes room, oldest first within each: requests the user hasn't opened (and that aren't a proven name),
        # then unsorted messages, and last the requests the page marked to keep
        evict = sorted([i for i in pending if not i.get("keep")], key=lambda i: (i.get("k") != "r", i["n"]))
        evict_kept = sorted([i for i in pending if i.get("keep")], key=lambda i: i["n"])
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
            while (evict or evict_kept) and (pend_n >= PENDING_MAX or pend_bytes + len(payload) > PENDING_BYTES):
                old = evict.pop(0) if evict else evict_kept.pop(0)   # the ring is full: see the order above
                inbox["items"] = [i for i in inbox["items"] if i is not old]
                pend_n -= 1
                pend_bytes -= len(old.get("payload") or "") * 3 // 4
                changed = True
                # counted as lost only when it could have been a message (version byte 1, long enough to hold one):
                # junk that can't be one isn't counted
                try:
                    head = base64.b64decode((old.get("payload") or "")[:4] + "==")[:1]
                    plausible = head == b"\x01" and len(old.get("payload") or "") * 3 // 4 >= 73
                except Exception:
                    plausible = False
                if not plausible:
                    continue
                now_s = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                lost = inbox.setdefault("lost", {"count": 0, "first": None, "last": None})
                if not lost.get("last") or time.time() - calendar.timegm(time.strptime(lost["last"], "%Y-%m-%dT%H:%M:%SZ")) > 6 * 3600:
                    lost["first"] = now_s                    # a new burst
                lost["count"] += 1
                lost["last"] = now_s
            pend_n += 1
            pend_bytes += len(payload)
            inbox["seen"].extend(sorted(ids))
            inbox["items"].append({"n": inbox["next"], "payload": base64.b64encode(payload).decode(),
                                   "source": r.get("source") if r.get("source") in ("live", "history") else None,
                                   "received": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "read": False})
            evict.append(inbox["items"][-1])                # newest last (before kept requests): it can make room too
            inbox["next"] += 1
            changed = True
        now = time.time()                               # dropped ones past their grace go even when nothing comes in
        if changed or any(i.get("k") == "d" and now - float(i.get("dropped_at") or 0) > DROP_GRACE for i in inbox["items"]):
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
    d, how = _durable_load(OUTBOX_FILE, lambda d: isinstance(d, dict) and isinstance(d.get("items"), list) and isinstance(d.get("next"), int))
    d = d or {"version": 1, "items": [], "next": 1, "rev": 0}
    if how in ("prev", "lost"):                         # numbers go on above anything used before
        d["next"] = max(int(d.get("next") or 1), int(time.time()))
        d["rev"] = max(int(d.get("rev") or 0), int(time.time()))
        event("messages outbox file couldn't be read: " + ("the last copy is used" if how == "prev" else "kept aside, starting empty"))
    return d


outbox = {"version": 1, "items": [], "next": 1, "rev": 0}
outbox_wake = threading.Event()
if _waku["feature"]:
    outbox.update(outbox_load())
    _loaded["outbox"] = True


def outbox_save():
    """Writes the outbox; the caller holds msg_lock."""
    outbox["items"] = outbox["items"][-OUTBOX_MAX:]
    _durable_save(OUTBOX_FILE, outbox)


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


def _store_file_read(path):
    """(ok, store) for one store file: no file is an empty store; a file that is there and can't be read is not ok."""
    try:
        with open(path) as f:
            d = json.load(f)
    except FileNotFoundError:
        return True, {"rev": 0, "blob": None}
    except Exception:
        return False, None
    if isinstance(d, dict) and isinstance(d.get("rev"), int) and not isinstance(d.get("rev"), bool) \
            and (d.get("blob") is None or isinstance(d.get("blob"), str)):
        return True, d
    return False, None


def store_read():
    """(ok, store) for the page: no file is an empty store, but a file that is there and can't be read is an
    error, never "empty" (an empty store would make every contact a stranger to the page)."""
    return _store_file_read(STORE_FILE)


def store_prev_ok():
    """Whether the last good copy (STORE_FILE.prev, kept by store_write) is there and readable."""
    ok, d = _store_file_read(STORE_FILE + ".prev")
    return bool(ok and os.path.exists(STORE_FILE + ".prev") and d.get("blob"))


def _fsync_tmp(path, data):
    """Writes `data` (bytes) to path.tmp and syncs it; nothing else changes. Where a full disk fails, it fails here,
    before any rename. Returns the tmp file's name."""
    tmp = path + ".tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise
    return tmp


def _fsync_dir(path):
    try:
        dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except Exception:
        pass


def _fsync_write(path, data):
    """Writes `data` (bytes) to `path` through a temporary file, synced before and after the rename, so a power
    cut leaves either the old file or the new one, never an empty one."""
    os.replace(_fsync_tmp(path, data), path)
    _fsync_dir(path)


def store_write(d):
    """Saves the store; the copy it replaces, if it was readable, is kept as STORE_FILE.prev (the caller holds
    msg_lock)."""
    ok, cur = _store_file_read(STORE_FILE)
    if ok and cur.get("blob") and os.path.exists(STORE_FILE):
        _fsync_write(STORE_FILE + ".prev", json.dumps(cur).encode())
    _fsync_write(STORE_FILE, json.dumps(d).encode())


def _aside_name(why):
    """A name for a file kept aside that no earlier one has: STORE_FILE.<why>-<time>-<random>."""
    while True:
        name = "%s.%s-%s-%s" % (STORE_FILE, why, time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()), secrets.token_hex(4))
        if not os.path.exists(name):
            return name


def store_replace_keeping_aside(why, blob, out=None):
    """Puts a new store (rev, `blob`) in place of the store file, which is kept aside under a name of its own (never
    over another file kept aside); the caller holds msg_lock. In this order: the new file is written and synced
    first (a full disk fails here and changes nothing), then the old one is renamed aside (a rename, never a hard
    link: Android forbids those to apps), then the new one takes its name. `out`, a dict, gets "aside" (the name
    the old file was moved to, or None) as soon as it is moved. Returns the new rev."""
    rev = int(time.time() * 1000)
    tmp = _fsync_tmp(STORE_FILE, json.dumps({"rev": rev, "blob": blob}).encode())
    name = None
    if os.path.exists(STORE_FILE):
        name = _aside_name(why)
        try:
            os.rename(STORE_FILE, name)
        except Exception:
            os.unlink(tmp)
            raise
    if out is not None:
        out["aside"] = name
    try:
        os.replace(tmp, STORE_FILE)
    except Exception:                     # (an I/O error: space was found above) the old file goes back in place
        if name:
            try:
                os.rename(name, STORE_FILE)
                if out is not None:
                    out["aside"] = None
            except Exception:
                event("saved chats left aside as " + os.path.basename(name) + " (couldn't be put back)")
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise
    _fsync_dir(STORE_FILE)
    return rev


def store_aside(why, out=None):
    """Moves the store file aside (kept, under a name of its own) and starts an empty one; see
    store_replace_keeping_aside. Returns the new rev."""
    return store_replace_keeping_aside(why, None, out)


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
        if not _loaded["inbox"]:                 # once: a second load would start numbering again at 1
            inbox.update(inbox_load())
            _loaded["inbox"] = True
        if not _loaded["outbox"]:
            outbox.update(outbox_load())
            _loaded["outbox"] = True
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
    if path == "/api/messages/inbox/sort":
        # the page opened these: which are chat messages, which are requests (a request counts as read), and
        # which it drops unread (marked "d": hidden, deleted after DROP_GRACE). Not a user action: the page does
        # this on its timer too, so it doesn't hold off auto-lock (a stranger writing every few seconds mustn't
        # keep the wallet open). A chat message stays one: nothing here turns a "c" into a request or a drop, so
        # a page that lost track of its contacts can't throw their messages away.
        chat, req, drop = _ints(body.get("chat")), _ints(body.get("request")), _ints(body.get("drop"))
        unread, keep = _ints(body.get("unread")), _ints(body.get("keep"))
        with msg_lock:
            sorted_, refused = 0, 0
            for i in inbox["items"]:
                if i["n"] in keep and i.get("k") in ("r", None) and not i.get("keep"):
                    i["keep"] = True                     # a request the user opened, or a proven name: evicted last
                    sorted_ += 1
                if i["n"] in unread and i["n"] in chat and i.get("k") == "d":
                    i["read"] = False                    # a dropped message that came back counts as new
                k = "c" if i["n"] in chat else "d" if i["n"] in drop else "r" if i["n"] in req else None
                if k in ("r", "d") and i.get("k") == "c":
                    refused += 1
                    continue
                if k and (i.get("k") != k or (k != "c" and not i.get("read"))):
                    i["k"] = k
                    if k != "c":
                        i["read"] = True
                    if k == "d":
                        i["dropped_at"] = time.time()
                    else:
                        i.pop("dropped_at", None)
                    sorted_ += 1
            if sorted_:
                inbox_save()
        return 200, {"sorted": sorted_, "refused": refused}
    if path == "/api/messages/store/fresh":
        # the user chose to start with empty saved chats: the file this key can't open (or can't be read at all)
        # is kept aside, never deleted. Only for the store the page saw (its rev), or a file that can't be read:
        # a second tap, another tab, or a page that hasn't seen the store can't set aside one that just started.
        seen = body.get("rev")
        with msg_lock:
            ok, cur = store_read()
            if ok and (isinstance(seen, bool) or seen != cur["rev"]):
                return 409, {"error": "The saved chats changed meanwhile. Look again.", "rev": cur["rev"]}
            rev = store_aside("aside")
        event("saved chats set aside", req)
        return 200, {"rev": rev}
    if path == "/api/messages/store/use-prev":
        # the store file can't be read: put the last good copy back (the bad file is kept aside)
        with msg_lock:
            if store_read()[0]:                      # only in place of a file that can't be read
                return 409, {"error": "The saved chats can be read; nothing to put back."}
            if not store_prev_ok():
                return 404, {"error": "There is no earlier copy of the saved chats."}
            ok, prev = _store_file_read(STORE_FILE + ".prev")
            # the last copy is written first; only then is the bad file moved aside (a full disk changes nothing,
            # and .prev, the only good copy, stays where it is)
            rev = store_replace_keeping_aside("unreadable", prev["blob"])
        event("saved chats put back from the last copy", req)
        return 200, {"rev": rev}
    if path == "/api/messages/outbox/cancel":
        # sends to these recipients' inbox topics that haven't gone out are cancelled (the user blocked them, or a
        # checked contact's address changed): a later retry or the node coming back must not send them
        topics = {t for t in (body.get("topics") or []) if isinstance(t, str) and MSG_TOPIC_RE.match(t)}
        with msg_lock:
            n = 0
            for item in outbox["items"]:
                hit = False
                for x in item["sends"]:
                    if x.get("topic") in topics and x["state"] in ("queued", "failed") and x.get("payload"):
                        x.update(state="cancelled", payload=None, error="cancelled", at=time.time())
                        n += 1; hit = True
                if hit:
                    outbox_touch(item)
            if n:
                outbox_save()
        return 200, {"cancelled": n}
    if path == "/api/messages/store":
        # one encrypted blob (profiles, notes, conversations), replaced as a whole; rev stops two pages
        # overwriting each other's changes
        blob, rev = body.get("blob"), body.get("rev")
        if not _b64_ok(blob, STORE_MAX):
            return 413, {"error": "The saved chats are too large."}
        with msg_lock:
            ok, cur = store_read()
            if not ok:                               # don't write over a file that can't be read
                return 500, {"error": "The saved chats file can't be read.", "unreadable": True, "prev": store_prev_ok()}
            if rev != cur["rev"] or isinstance(rev, bool):
                return 409, {"error": "Changed elsewhere; load it again.", "rev": cur["rev"]}
            store_write({"rev": cur["rev"] + 1, "blob": blob})
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
            count = sum(1 for i in inbox["items"] if not i.get("read") and i.get("k") != "r")
            lost = dict(inbox.get("lost") or {"count": 0, "first": None, "last": None})
        return 200, {"node": {"configured": st.get("configured", bool(waku_api())), "reachable": st["reachable"],
                              "starting": bool(st.get("starting")),
                              "health": st["health"], "connection": st["connection"],
                              "checked_s_ago": round(time.time() - st["checked"]) if st["checked"] else None},
                     "key": key["public"] if key else None, "name": (key or {}).get("name", ""),
                     "topic": inbox_topic(key["public"]) if key else None, "subscribed": bool(key and st["subscribed"]),
                     "inbox": count, "unread": count, "missed": st["missed"], "lost": lost,
                     "backup": {"last": last_backup(), "messaging": backup_has_messaging(),
                                "key_created": (key or {}).get("created")}}
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
        dropped = q.get("dropped") == ["1"]        # dropped ones only when asked (someone became a contact)
        limit = num("limit")                       # at most this many, oldest first (0: all)
        with msg_lock:
            got = sorted((i for i in inbox["items"] if i["n"] > after and (i.get("k") == "d") == dropped), key=lambda i: i["n"])
            return 200, {"items": [dict(i) for i in (got[:limit] if limit else got)], "next": inbox["next"],
                         "sort_from": inbox.get("sort_from", 1),
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
            ok, cur = store_read()
            return (200, cur) if ok else (500, {"error": "The saved chats file can't be read.", "unreadable": True, "prev": store_prev_ok()})
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


NODE_NEVER_RAN = {True: "The node hasn't run on this phone yet, so it has no key file to replace. Start the node first "
                        "(Settings → Node → Open node → Start), wait until it shows as running, then restore.",
                  False: "The node hasn't made its key file yet. Start the node once, then restore."}


LEZ04_BACKUP_BUSY = "A change to your LEZ 0.4 wallet is running. Back up when it has finished."


def lez04_backed_up():
    """The LEZ 0.4 account the last backup holds (BACKUP_STATE_FILE), or None."""
    try:
        with open(BACKUP_STATE_FILE) as f:
            v = json.load(f).get("lez04")
        return v if isinstance(v, str) else None
    except Exception:
        return None


class OldBackup(Exception):
    """A backup with an old app's LEZ 0.3 parts, inside the app: refused with BACKUP_OLD."""


def node_never_ran():
    """Whether the node has not made its keys yet: no config file at all, or, inside the Android app, no keystore.yaml
    (the app's node service makes both with init-config at the node's first start, and a fresh install hasn't started
    it). Not the same as a node that keeps its keys inside its config file, which restore can't handle."""
    return not os.path.isfile(NODE_CFG) or EMBEDDED


def restore_backup(doc, password):
    """(http status, reply, event detail). Puts the key file from a backup in place of the node's own,
    only after the node itself has checked it, and keeps the old one beside it."""
    if not isinstance(doc, dict) or doc.get("format") != BACKUP_FORMAT or doc.get("version") not in BACKUP_AADS \
            or isinstance(doc.get("version"), bool):
        return 400, {"error": "This isn't a wallet backup from this app, or it's a version this app can't read."}, "format"
    if EMBEDDED and doc["version"] != BACKUP_APP_VERSION:
        return 400, {"error": BACKUP_OLD, "old_backup": True}, "old version"
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
        if EMBEDDED and "lns_wallet" in content:          # a LEZ 0.3 part: an old app's data, not migrated
            raise OldBackup
        msg_key = content.get("messaging_key") if doc["version"] >= 2 else None
        if msg_key is not None and not msg_key_valid(msg_key):
            raise ValueError
        chat = content.get("chat") if msg_key else None
        lz = content.get("lez04_wallet")
        if lz is not None:
            import signer04 as _s4
            if not _s4.backup_part_ok(lz):
                raise ValueError
    except OldBackup:
        return 400, {"error": BACKUP_OLD, "old_backup": True}, "old version"
    except Exception:
        return 400, {"error": "This backup file is damaged. Nothing was changed."}, "format"
    live, _ = keystore_location()
    if not os.path.isfile(live):
        if node_never_ran():
            return 409, {"error": NODE_NEVER_RAN[EMBEDDED], "node_never_ran": True}, "node never ran"
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
    more, why_more = {}, ""
    # the phone's LEZ 0.4 wallet, if the backup has one: only where there is none (never over other accounts)
    s4 = signer04() if lz is not None else None
    if lz is not None:
        lz_out, lz_msg = s4.restore_part(lz) if s4 else ("unchecked", "This app can't use LEZ 0.4 wallets, so the backup's wasn't restored.")
        more = dict(more, lez04=lz_out, lez04_message=lz_msg)
        why_more += ", lez04 " + lz_out
    if reported == current:
        try:
            before, changed = msg_key_restore_with_store(msg_key, chat) if msg_key else ((msg_key_load() or {}).get("secret"), False)
        except MsgKeyNotRestored:
            return 200, dict(more, unchanged=True, messaging_key_restored=False,
                             message="These are the wallet keys already in use. The messaging key from the backup couldn't be written (is the phone full?), so Messages still uses this phone's address. Nothing else changed: restore again to bring it in."), "same keys, messaging key not written" + why_more
        if msg_key and changed:
            n = chat_restore(chat, before != msg_key["secret"]) if chat and messaging_on() else 0
            return 200, dict(more, unchanged=True, messaging_key_restored=True, messages_restored=n,
                             message="These are the wallet keys already in use. The messaging key from the backup is back in place."), "same keys, messaging key" + why_more
        n = chat_restore(chat, False) if chat and messaging_on() else 0
        if n:
            return 200, dict(more, unchanged=True, messages_restored=n,
                             message="These are the keys this wallet already uses. Messages from the backup were added."), "same keys, messages" + why_more
        return 200, dict(more, unchanged=True, message="These are the keys this wallet already uses. Nothing was changed."), "same keys" + why_more
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
    reply = dict(more, ok=True, restarted=restarted, addresses=len(reported), replaced=len(current))
    try:
        before, changed = msg_key_restore_with_store(msg_key, chat) if msg_key else ((msg_key_load() or {}).get("secret"), False)
    except MsgKeyNotRestored:
        # the wallet keys are restored (and the node restarted with them); the messaging key isn't, and the saved
        # chats are as they were: say so, plainly, instead of failing the whole request
        reply["messaging_key_restored"] = False
        reply["messaging_message"] = ("The messaging key from the backup couldn't be written (is the phone full?), so Messages still "
                                      "uses this phone's address. Restore again to bring it in.")
        before, changed = None, False
    if msg_key and changed:
        reply["messaging_key_restored"] = True
    if chat and messaging_on() and (changed or not msg_key or before == msg_key.get("secret")):
        reply["messages_restored"] = chat_restore(chat, before != msg_key["secret"] if msg_key else False)
    if not restarted:
        reply["manual"] = restart_hint()
    return 200, reply, "restored"


def store_aside_for_new_key(before, msg_key, chat, out=None):
    """A restore brings another messaging key and no saved chats: the ones here can't be opened with the new key,
    so they are kept aside (STORE_FILE.other-key-<time>-<random>) and the page starts with empty ones. Returns the
    name they were moved to, or None."""
    if not messaging_on() or not before or before == msg_key.get("secret") or (isinstance(chat, dict) and chat.get("store")):
        return None
    out = out if out is not None else {}
    with msg_lock:
        if os.path.exists(STORE_FILE):
            store_aside("other-key", out)
    return out.get("aside")


class MsgKeyNotRestored(Exception):
    """The backup's messaging key couldn't be put in place (the saved chats are as they were)."""


def msg_key_restore_with_store(msg_key, chat):
    """Puts a backup's messaging key in place together with what that means for the saved chats, so a failure
    half way can't leave the new key beside a store it can't open. When the key is another one and the backup
    brings no saved chats, the store is set aside first; if that fails, the key is not put in. If putting the key
    in place then fails (or changes nothing), the store is put back. Returns (the secret before, whether the key
    changed); raises MsgKeyNotRestored when the key stayed as it was because of a failure."""
    before = (msg_key_load() or {}).get("secret")
    out = {}
    try:
        store_aside_for_new_key(before, msg_key, chat, out)
    except Exception as e:
        put_back(out)
        event("messaging key not restored: the saved chats couldn't be set aside")
        raise MsgKeyNotRestored(str(e))
    try:
        changed = msg_key_restore(msg_key)
        err = None
    except Exception as e:
        changed, err = None, e
    if not changed:
        put_back(out)                                # the key didn't change: the saved chats are this key's still
    if err is not None:
        event("messaging key not restored: it couldn't be written")
        raise MsgKeyNotRestored(str(err))
    return before, changed


def put_back(out):
    """Puts the store set aside (out["aside"]) back in place; if that fails, the event log names the file."""
    aside = out.get("aside")
    if not aside:
        return
    try:
        with msg_lock:
            os.replace(aside, STORE_FILE)
        out["aside"] = None
    except Exception:
        event("saved chats left aside as " + os.path.basename(aside) + " (couldn't be put back)")


def chat_backup(history):
    """The chats for a backup: the encrypted profiles blob, and (with `history`) the sealed incoming messages
    and encrypted sent copies, newest first up to HISTORY_BACKUP_MAX. None when there is nothing."""
    with msg_lock:
        store = store_load().get("blob")
        ins = [{"payload": i["payload"], "received": i.get("received"), "read": bool(i.get("read")), "k": "c" if i.get("k") == "c" else ""}
               for i in inbox["items"] if i.get("k") not in ("r", "d")]   # requests and dropped ones aren't chats: not in a backup
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
                # a chat message comes back as one (backups from before 0.9.22 have no sort: all were chats then);
                # one that was unsorted at backup time comes back unsorted, for the page to sort
                is_chat = r.get("k", "c") == "c"
                item = {"n": inbox["next"], "payload": r["payload"], "source": "backup",
                        "received": str(r.get("received") or "")[:32], "read": bool(r.get("read", True)) or not is_chat}
                if is_chat:
                    item["k"] = "c"
                inbox["items"].append(item)
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
    mk, chats_missing = msg_key_load(), False
    if mk:                                    # the messaging key goes along: version 2
        content["messaging_key"] = {k: mk[k] for k in ("secret", "public", "name", "seed", "version") if mk.get(k)}
        version = 2
        chat = chat_backup(history) if messaging_on() else None
        if chat:                              # an app before 0.9 ignores it and restores the keys
            content["chat"] = chat
        chats_missing = messaging_on() and os.path.exists(STORE_FILE) and not store_read()[0]   # said, never silently left out
    s4 = signer04() if EMBEDDED else None
    lz = s4.backup_part() if s4 else None
    if lz == "busy":                          # a send or a restore may be rewriting the LEZ 0.4 wallet right now
        return 409, {"error": LEZ04_BACKUP_BUSY, "lez04_busy": True}, source
    if lz:                                    # the phone's LEZ 0.4 wallet (its keys): goes along
        content["lez04_wallet"] = lz
    if EMBEDDED:
        version = BACKUP_APP_VERSION          # the app's own format (see BACKUP_APP_VERSION)
    sealed = aead_encrypt(backup_key(password, salt), nonce, json.dumps(content).encode(), BACKUP_AADS[version])
    b64 = lambda b: base64.b64encode(b).decode()
    created = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        fd = os.open(BACKUP_STATE_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"last": created, "messaging": bool(mk),                # whether it holds the messaging key
                       "lez04": lz["main"] if lz else None}, f)                # the LEZ 0.4 wallet it holds
        os.replace(BACKUP_STATE_FILE + ".tmp", BACKUP_STATE_FILE)
    except Exception:
        pass
    return 200, {"lez04": "included" if lz else None,
                 "chats_missing": bool(mk) and chats_missing, "backup": {
        "format": BACKUP_FORMAT, "version": version,
        "created": created,
        "addresses": [{"label": k["label"], "key": k["key"]} for k in wallet_keys()],
        "kdf": dict(BACKUP_SCRYPT, name="scrypt", salt=b64(salt)),
        "cipher": {"name": "chacha20-poly1305", "nonce": b64(nonce), "aad": BACKUP_AADS[version].decode()},
        "ciphertext": b64(sealed)}}, source


# ---- home-screen app: manifest and icon -----------------------------------------------------

MANIFEST = json.dumps({
    "name": "Names Wallet", "short_name": "Names Wallet", "start_url": "/", "scope": "/", "display": "standalone",
    "background_color": "#11110f", "theme_color": "#11110f",
    "icons": [{"src": "/names-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
              {"src": "/names-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
              {"src": "/names-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}).encode()
_icons = {}
# the lambda, as thick round-ended strokes on a unit square: the long leg, the short leg, the top hook
# The Names Wallet mark (android-node/names-mark, names-mark-orange.svg): the Greek letter eta from Inter Bold, white,
# dead centre on its ink, on an orange tile (256 box, corner radius 58). The outline below is the SVG's, with its
# translate(0,10) baked in.
ETA_256 = "M107.68 99.94V162.55H78.65V54.35H106.03L106.42 76.71Q110.97 65.39 119.29 59.19Q127.61 53.00 140.10 53.00Q156.94 53.00 167.15 63.84Q177.35 74.68 177.35 93.74V203.00H148.23V98.77Q148.23 88.71 143.05 83.00Q137.87 77.29 128.68 77.29Q119.39 77.29 113.53 83.24Q107.68 89.19 107.68 99.94Z"
ORANGE = (0xe8, 0x66, 0x2f)


def eta_polygon():
    """The outline as one polygon in the 256 box (each quadratic curve in 8 straight pieces)."""
    pts, cur = [], (0.0, 0.0)
    for cmd, args in re.findall(r"([MVHLQZ])([^MVHLQZ]*)", ETA_256):
        n = [float(v) for v in re.findall(r"-?[0-9.]+", args)]
        if cmd in "ML":
            cur = (n[0], n[1]); pts.append(cur)
        elif cmd == "V":
            cur = (cur[0], n[0]); pts.append(cur)
        elif cmd == "H":
            cur = (n[0], cur[1]); pts.append(cur)
        elif cmd == "Q":
            (x0, y0), (cx, cy), (x1, y1) = cur, (n[0], n[1]), (n[2], n[3])
            for k in range(1, 9):
                t = k / 8.0
                pts.append(((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1))
            cur = (x1, y1)
    return pts


def eta_coverage(n, scale):
    """How much of each pixel of an n x n image the glyph covers (0..1), the 256 box mapped onto the image and
    scaled by `scale` about its centre: a scanline fill, 4 sub-rows a pixel, exact along each sub-row."""
    pts = [((x - 128) * scale * n / 256 + n / 2, (y - 128) * scale * n / 256 + n / 2) for x, y in eta_polygon()]
    edges = list(zip(pts, pts[1:] + pts[:1]))
    cov = [[0.0] * n for _ in range(n)]
    sub = 4
    for py in range(n):
        for k in range(sub):
            y = py + (k + 0.5) / sub
            xs = sorted(ax + (y - ay) * (bx - ax) / (by - ay) for (ax, ay), (bx, by) in edges if (ay <= y < by) or (by <= y < ay))
            for a, b in zip(xs[::2], xs[1::2]):          # inside between pairs (the outline is one simple contour)
                for px in range(max(0, int(a)), min(n, int(b) + 1)):
                    cov[py][px] += max(0.0, min(px + 1, b) - max(px, a)) / sub
    return cov


def icon_png(n, maskable=False):
    """The app icon: the white eta on its orange tile (rounded corners, transparent outside). `maskable` fills the
    whole square with orange and keeps the glyph inside the safe zone, for launchers that cut their own shape."""
    if (n, maskable) in _icons:
        return _icons[(n, maskable)]
    import struct, zlib
    cov = eta_coverage(n, 0.8 if maskable else 1.0)
    r = 58.0 * n / 256

    def tile(x, y):                           # how much of the pixel the rounded tile covers
        if maskable:
            return 1.0
        cx, cy = min(max(x + 0.5, r), n - r), min(max(y + 0.5, r), n - r)
        d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
        return max(0.0, min(1.0, r - d + 0.5))
    rows = []
    for y in range(n):
        row = bytearray([0])
        for x in range(n):
            a, ink = tile(x, y), min(1.0, cov[y][x])
            row += bytes(int(round(c + (255 - c) * ink)) for c in ORANGE) + bytes([int(round(255 * a))])
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


# ---- the bridge test network (LEZ 0.4): read-only balances, from app/lez04.py ----------------------------------------
# A second network beside the public Logos testnet (LEZ 0.3). Reads only, through the outside fetch; nothing here touches
# keys, sends, names or 0.3 balances, and lez04 imports nothing of this file. Inside the Android app only.
_net04 = []


_lez04_pacer = []


def lez04_pacer():
    """The one pacer every call of this app to the LEZ 0.4 network goes through (the reader, the signer's forwarder and
    the faucet): the network allows 50 requests per 10 s per address, this app makes at most 4 a second."""
    if not _lez04_pacer:
        import signer04
        _lez04_pacer.append(signer04.Pacer(signer04.PACE))
    return _lez04_pacer[0]


def net04():
    """The reader (made once), or None outside the Android app or if lez04.py can't load."""
    if not EMBEDDED:
        return None
    if not _net04:
        try:
            import lez04
            pacer = lez04_pacer()

            def paced(url, body, cap, total):
                pacer.wait()
                return fetch_outside(url, body, cap=cap, total=total)
            _net04.append(lez04.Net04(DATA_DIR, APP_DIR, paced))
        except Exception:
            _net04.append(None)
    return _net04[0]


# ---- the LEZ 0.4 signer (app/signer04.py): public sends on LEZ 0.4, from the accounts of the desktop's recovery phrase ----
# Inside the Android app only, with libnames04.so bundled (NAMES04_BIN). It shares nothing with the LEZ 0.3 name account:
# its own wallet folder, its own forwarder secret, its own job.
NAMES04_BIN = os.environ.get("NAMES04_BIN", "")
_signer04 = []


def signer04():
    """The LEZ 0.4 signer (made once), or None outside the Android app, without the 0.4 tool, or if it can't load."""
    if not EMBEDDED or not NAMES04_BIN:
        return None
    if not _signer04:
        n = net04()
        try:
            import signer04 as s4
            if n is None:
                raise ValueError("no LEZ 0.4 reader")

            def done(kind):                  # read the balances and the NFTs again at the next look
                n.last_try = n.nft_last_try = 0.0
            holder = []
            holder.append(s4.Signer04(DATA_DIR, NAMES04_BIN, lambda url, body, cap, total: fetch_outside(url, body, cap=cap, total=total),
                                      n.config, lambda: "http://127.0.0.1:%d/lez04-rpc/%s" % (PORT, holder[0].secret),
                                      lez04_pacer(), event=lambda name, **d: event(name, None, **d), on_done=done))
            _signer04.append(holder[0] if holder[0].available() else None)
        except Exception:
            _signer04.append(None)
    return _signer04[0]


def signer04_mine():
    """The phone's LEZ 0.4 accounts (restored from the recovery phrase, and any it made since), or none."""
    s = signer04()
    return s.state()["accounts"] if s and s.ready() else []


def signer04_extra():
    """The accounts the phone made itself to receive NFTs (after the 16 the phrase restored): Collectibles reads them
    like the phone's own account."""
    import signer04 as m4
    return signer04_mine()[m4.RESTORED:]


def net04_own():
    """The phone's own LEZ account id (base58) on LEZ 0.4: the first account of its LEZ 0.4 wallet once restored from
    the recovery phrase (the desktop's first account) or made on the phone; None before that."""
    try:
        s = signer04()
        return s.state()["main"] if s and s.ready() else None
    except Exception:
        return None


def net04_name():
    """The phone's own LNS name on LEZ 0.4, once registered here ("" without one): the NFTs screen looks for its NFT
    first."""
    try:
        s = signer04()
        return (s.state()["name"] or "") if s and s.ready() else ""
    except Exception:
        return ""


def name04_entries():
    """What the phone's own name points at: this wallet's node address (`blockchain`, as the LEZ 0.3 name did) and the
    messaging address (`msg`), each when known."""
    out = {}
    main = next((k["key"] for k in wallet_keys() if k["label"] == "Main"), None)
    if isinstance(main, str) and HEX64_RE.fullmatch(main):
        out["blockchain"] = main
    mk = msg_key_load()
    if mk and isinstance(mk.get("public"), str) and HEX64_RE.fullmatch(mk["public"]):
        out["msg"] = mk["public"]
    return out


LNS_ID_RE = re.compile(r"^id\s+([0-9a-f]{64})\s*$", re.M)


def lns_name_id(name):
    """The 32-byte id the chain knows the LNS name by (Argon2id, slow on purpose), worked out by the bundled LEZ 0.4
    `names` (NAMES04_BIN: `names address <name>`: offline, no wallet, no network); None if it can't say. Only the id
    line is read."""
    if not NAMES04_BIN or not os.path.isfile(NAMES04_BIN) or not os.access(NAMES04_BIN, os.X_OK) or not lns_name_ok(name):
        return None
    try:
        with tempfile.TemporaryDirectory(dir=DATA_DIR) as tmp:
            r = subprocess.run([NAMES04_BIN, "address", name], cwd=tmp, capture_output=True, timeout=60, stdin=subprocess.DEVNULL,
                               env={"PATH": "/system/bin:/usr/bin:/bin", "HOME": tmp, "TMPDIR": tmp, "NO_COLOR": "1", "RUST_BACKTRACE": "0"},
                               umask=0o077)
    except Exception:
        return None
    m = LNS_ID_RE.search(ANSI_RE.sub(b"", r.stdout).decode("utf-8", "replace")) if r.returncode == 0 else None
    return bytes.fromhex(m.group(1)) if m else None


# ---- HTTP -----------------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "LogosNodeApp"
    # an idle or slow connection is closed after this many seconds, so nobody can hold the server's threads
    timeout = float(os.environ.get("APP_IDLE_TIMEOUT", "30"))

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
                             "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; %s; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'" % img)
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

    def key_ok(self):
        """With APP_KEY set (the Android app): whether the request carries it as the app_key cookie, which only
        the app's own WebView holds. Without APP_KEY: always (Linux, Termux)."""
        if not APP_KEY:
            return True
        got = ""
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == APP_KEY_COOKIE:
                got = value
        return hmac.compare_digest(got.encode(), APP_KEY.encode())

    @staticmethod
    def public_file(path):
        """The page's own files, the same for everyone (from this repository): served without the app key, so a
        resource the WebView fetches without cookies still loads. Everything else needs it."""
        return (path in ("/", "/manifest.webmanifest", "/net04/net04.js", "/net04/sign04.js", "/net04/name04.js", "/net04/nft.js", QR_FILE,
                         "/lambda-192.png", "/lambda-512.png", "/lambda-maskable-512.png")
                or bool(MESSAGES_FILE_RE.match(path)) or bool(NAMES_FILE_RE.match(path)) or path in NET04_FONTS)

    KEY_REFUSED = {"error": "this app only answers its own page", "app_key": False}

    # POSTs that are the user doing something; they count as activity for auto-lock. Everything the
    # page does on a timer (status, accounts, history, receipts, transfer status) does not.
    USER_ACTIONS = {"/api/wallet/activity", "/api/wallet/send", "/api/wallet/backup", "/api/wallet/restore",
                    "/api/wallet/settings", "/api/wallet/passkey/options", "/api/wallet/passkey/register",
                    "/api/wallet/passkey/remove", "/api/update/check", "/api/update/passkey/challenge",
                    "/api/update/apply", "/api/names/rpc", "/api/wallet/native-fingerprint",
                    "/api/messages/key", "/api/messages/name", "/api/messages/send", "/api/messages/inbox/delete",
                    "/api/messages/outbox", "/api/messages/outbox/retry", "/api/messages/outbox/delete",
                    "/api/messages/store", "/api/wallet/net04/nft", "/api/wallet/net04/network"}

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        # This app listens on 127.0.0.1 only, so nothing off this device can reach it. The status
        # endpoints answer whatever Host name a request carries (they hold nothing private). The wallet
        # answers only requests addressed to 127.0.0.1 or localhost, so a web page that points another
        # name at this address (DNS rebinding) can't reach it.
        if not self.public_file(path) and not self.key_ok():
            return self.reply(403, self.KEY_REFUSED)
        if (path.startswith("/api/wallet") or path.startswith("/api/messages")) and not self.host_ok():
            return self.reply(403, {"error": "The wallet only opens on the device that runs the node.", "local_only": True})
        if path == "/":
            try:
                with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
                    page = f.read().replace(b"__APP_VERSION__", APP_VERSION.encode())
                page = page.replace(b"__APP_EMBEDDED__", b"android" if EMBEDDED else b"")
                if messaging_on():                # the Messages panel, only where a messaging node can run
                    page = page.replace(b"</body>", b'<script type="module" src="/messages/messages.js"></script>\n</body>', 1)
                if net04():                       # the bridge test network (LEZ 0.4), in the Android app; sending there
                    sign = b'<script src="/net04/sign04.js"></script>\n<script src="/net04/name04.js"></script>\n' if signer04() else b""   # only with the 0.4 signer
                    page = page.replace(b"</body>", b'<script src="/net04/net04.js"></script>\n' + sign + b'<script src="/net04/nft.js"></script>\n</body>', 1)
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
        if path in ("/net04/net04.js", "/net04/sign04.js", "/net04/name04.js", "/net04/nft.js") or path in NET04_FONTS:
            if not net04() or (path in ("/net04/sign04.js", "/net04/name04.js") and not signer04()):
                return self.reply(404, {"error": "not found"})
            try:
                if path in NET04_FONTS:
                    with open(os.path.join(APP_DIR, "net04", "fonts", NET04_FONTS[path]), "rb") as f:
                        return self.reply(200, raw=f.read(), ctype="font/ttf")
                with open(os.path.join(APP_DIR, "net04", path.rsplit("/", 1)[1]), "rb") as f:
                    return self.reply(200, raw=f.read(), ctype="text/javascript; charset=utf-8")
            except Exception:
                return self.reply(404, {"error": "not found"})
        m = NAMES_FILE_RE.match(path)
        if m:                               # the names resolver, served as files so the page can import it
            try:
                with open(os.path.join(NAMES_DIR, m.group(1)), "rb") as f:
                    return self.reply(200, raw=f.read(), ctype="text/javascript; charset=utf-8")
            except Exception:
                return self.reply(404, {"error": "not found"})
        if path == QR_FILE:
            try:
                with open(os.path.join(APP_DIR, "qr", "qrcode.js"), "rb") as f:
                    return self.reply(200, raw=f.read(), ctype="text/javascript; charset=utf-8")
            except Exception:
                return self.reply(404, {"error": "not found"})
        if path == "/manifest.webmanifest":
            return self.reply(200, raw=MANIFEST, ctype="application/manifest+json")
        # the old names too, for home-screen icons made before the mark changed
        if path in ("/names-192.png", "/names-512.png", "/names-maskable-512.png",
                    "/lambda-192.png", "/lambda-512.png", "/lambda-maskable-512.png"):
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
                   "passkeys": len(passkeys_load()["keys"]), "names_program": names04_net()[1] or None,
                   "autolock_minutes": wallet_settings["autolock_minutes"], "leave_grace": LEAVE_GRACE}
            if EMBEDDED:
                out.update(embedded="android", native_fingerprint=bool(wallet_settings.get("native_fingerprint")))
            return self.reply(200, out)
        if path == "/api/wallet/net04":                # the bridge test network: read-only, never the money path
            n = net04()
            if not n:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            own = net04_own()
            n.look(own)                                # reads again in the background, 30 s at most
            return self.reply(200, n.view(own))
        if path in ("/api/wallet/net04/nft", "/api/wallet/net04/network"):   # Collectibles; the LEZ 0.4 network in use
            n = net04()
            if not n:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            if path.endswith("/network"):
                return self.reply(200, {"network": n.network()})
            own, name, mine, extra = net04_own(), net04_name(), signer04_mine(), signer04_extra()
            n.nft_look(own, name, lns_name_id, mine, extra)   # reads again in the background, 30 s at most
            return self.reply(200, n.nft_view(own, name, mine, extra))
        if path == "/api/wallet/lez04":                 # the LEZ 0.4 signer: its accounts, its job, the faucet
            s4 = signer04()
            if not s4:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            n = net04()
            v = s4.view(n.state.get("channel") if n else None)
            v["faucet_info"] = s4.faucet_info() if v["ready"] and not v["faucet"]["used"] else None
            v["backup_needed"] = bool(v["ready"]) and lez04_backed_up() != s4.state()["main"]
            return self.reply(200, v)
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

    def lez04_rpc(self):
        """The forwarder for the LEZ 0.4 signer's `names` (app/signer04.py): it has no Origin, so it is told a secret path
        instead (anything else that reaches this address gets a plain 404); to the
        LEZ 0.4 network in use, paced with every other call this app makes there."""
        s4 = signer04()
        secret = self.path.split("?", 1)[0][len("/lez04-rpc/"):].rstrip("/")
        if not s4 or not self.host_ok() or not hmac.compare_digest(secret.encode(), s4.secret.encode()):
            return self.reply(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except Exception:
            n = -1
        import signer04 as m4
        if not 0 < n <= m4.RPC_MAX:
            return self.reply(413 if n > m4.RPC_MAX else 400, {"error": "bad request"})
        code, data = s4.forward(self.rfile.read(n))
        return self.reply(code, raw=data) if isinstance(data, bytes) else self.reply(code, data)

    def do_POST(self):
        if self.path.startswith("/lez04-rpc/"):
            return self.lez04_rpc()
        if not self.key_ok():
            return self.reply(403, self.KEY_REFUSED)
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
                      node_restarted="yes" if obj["restarted"] else "no", lez04=obj.get("lez04") or "none")
            elif code == 200:
                event("restore applied to the keys already in use", self, detail=why)
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
        # "X-Background: 1": the messages page doing something on its own (sorting what came in, the chain reads
        # and store writes that follow); not the user, so it doesn't hold off auto-lock
        if path in self.USER_ACTIONS and self.headers.get("X-Background") != "1" and self.authed():
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
                        session["hidden_since"], session["hidden_by"] = time.time(), "page"
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
        if path in ("/api/wallet/net04/nft", "/api/wallet/net04/network"):
            # Collectibles' lists, the 0.4 network by RPC URL + chain id: reads only
            n = net04()
            if not n:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            if path.endswith("/network"):
                code, obj = n.set_network(None if body.get("ours") else body.get("rpc_url"), body.get("chain_id"))
                if code == 200:
                    event("LEZ 0.4 network set", self, custom=obj.get("custom"))
                return self.reply(code, obj)
            own, name, mine, extra = net04_own(), net04_name(), signer04_mine(), signer04_extra()
            code, obj = n.nft_change(body, name, lns_name_id)
            if code == 200:
                n.nft_look(own, name, lns_name_id, mine, extra)
                obj["view"] = n.nft_view(own, name, mine, extra)
            return self.reply(code, obj)
        if path.startswith("/api/wallet/lez04/"):      # the LEZ 0.4 signer: restore, send, NFTs, the name's NFT, the faucet, remove
            s4 = signer04()
            if not s4:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            what = path[len("/api/wallet/lez04/"):]
            if what == "restore":
                code, obj = s4.restore(body.pop("phrase", None))    # the phrase: never logged, never kept
                body.clear()
            elif what == "new-phrase":                  # this phone's own wallet: a new phrase, shown once, kept nowhere
                code, obj = s4.new_phrase()
            elif what == "send":
                code, obj = s4.send(body)
            elif what == "register":                    # the phone's own LNS name: register it, then point it here
                code, obj = s4.register(body.get("name"), name04_entries())
            elif what == "point":                       # point the phone's own name at this phone again
                code, obj = s4.point(name04_entries())
            elif what == "faucet":
                code, obj = s4.faucet()
            elif what == "remove":                      # the keys made from the phrase off this phone: the PIN typed again
                refused = pin_attempt(self, str(body.get("pin", "")), "lez04 remove refused, wrong PIN")
                if refused:
                    code, obj = refused
                    return self.reply(403 if code == 401 else code, obj)      # 401 means "locked" to the page
                code, obj = s4.remove()
            elif what == "nft/init":
                code, obj = s4.nft_init(body)
            elif what == "nft/send":
                code, obj = s4.nft_send(body)
            elif what == "claim":
                n = net04()
                name = body.get("name") if isinstance(body.get("name"), str) else ""
                rows = n.nft_view(net04_own(), net04_name(), signer04_mine())["names"] if n else []
                row = next((r for r in rows if r["name"] == name), None)
                if row is None or row.get("status") != "no_nft" or not row.get("holder"):
                    code, obj = 409, {"error": "Read the name first: add it under Your LNS names, and wait until it says it has no NFT yet."}
                else:
                    code, obj = s4.claim(name, row["holder"])
            else:
                return self.reply(404, {"error": "not found"})
            if code == 200 and what == "new-phrase":
                event("lez04 new recovery phrase made", self)     # never the phrase
            elif code == 200 and what != "restore":
                event("lez04 " + what, self)
            return self.reply(code, obj)
        if path == "/api/wallet/net04/watch":          # view-only addresses on the bridge test network
            n = net04()
            if not n:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            if "remove" in body:
                code, obj = n.unwatch(body.get("remove"))
            else:
                code, obj = n.watch(body.get("add"))
            return self.reply(code, obj)
        return self.reply(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


def main():
    """Starts the app and serves until the process ends. The Android app imports this module and calls main()
    in a thread, so it can also call native_unlock() in the same process."""
    try:
        xfer_round_caps()                     # a transfer stopped while the node funded it sent nothing: dropped
    except Exception:
        pass
    if EMBEDDED:
        event("app start", port=PORT, version=APP_VERSION, embedded="android")
    if pin_is_set():
        event("wallet locked", reason="the app started (every start begins locked)")
    else:
        event("app start", port=PORT, version=APP_VERSION)
    threading.Thread(target=wallet_keys, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    if not EMBEDDED:
        threading.Thread(target=update_loop, daemon=True).start()
    if messaging_on():
        messaging_start()
    threading.Thread(target=session_watch, daemon=True).start()
    while True:
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
            break
        except OSError as e:
            # inside the Android app another app may hold the port: wait for it to be free (the app's cover
            # says so) instead of stopping; elsewhere a service manager restarts the app
            if not EMBEDDED or e.errno != errno.EADDRINUSE:
                raise
            if not getattr(main, "port_taken", False):
                main.port_taken = True
                event("port taken", port=PORT)
            time.sleep(5)
    SERVING.set()
    try:
        httpd.serve_forever()
    finally:
        SERVING.clear()


if __name__ == "__main__":
    main()

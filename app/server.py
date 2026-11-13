#!/usr/bin/env python3
"""Local web app for a Logos node running on the same device: node status plus a small wallet.

It listens on 127.0.0.1 only and talks to the node's own API at NODE_API (127.0.0.1:8080 unless set;
the Linux Terminal install uses port 880).
Python standard library only. Wallet calls need a PIN that is set on first use.
"""
import base64, calendar, hashlib, hmac, http.server, json, os, re, secrets, shlex, shutil, struct, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request

APP_VERSION = "0.9.22"
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
session = {"token": None, "active": 0.0, "hidden_since": None}
fails = {"count": 0, "until": 0.0}
sent = {}               # tx hash -> what we sent, to report when it lands
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
ACCOUNT_ID_RE = re.compile(r"\A[1-9A-HJ-NP-Za-km-z]{32,44}\Z")
NAME_RE = re.compile(r"\A(?!-)[a-z0-9-]{1,32}(?<!-)\Z")
NAMES_DIR = os.path.join(APP_DIR, "names")
MESSAGES_FILE_RE = re.compile(r"^/((?:messages/(?:noble-(?:ciphers|hashes)/)?|noble-curves/(?:abstract/)?)[A-Za-z0-9_][A-Za-z0-9_.-]*\.js)$")
NAMES_FILE_RE = re.compile(r"^/names/((?:noble-hashes/)?[A-Za-z0-9_][A-Za-z0-9_.-]*\.js)$")
QR_FILE = "/qr/qrcode.js"                 # the QR code drawer (vendored, see app/qr/VENDORED.txt)


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


# ---- an LNS name held by this phone (Android app only; see android/NAMES.md) -------------------
# The names project's own command line, `names`, built for Android (NAMES_BIN, set by the app), makes a
# public LEZ account whose key stays in LNS_HOME, and signs plain public transactions with it: register a
# name, set its `blockchain` and `msg` entries. No proofs. This server only starts it with fixed arguments,
# keeps one change at a time, and forwards its sequencer calls (below). It never reads the key or the seed.
# Of what `names` prints, only the account address, fixed progress texts and fixed error texts (allowlists)
# ever reach a reply, a log or the page.

NAMES_BIN = os.environ.get("NAMES_BIN", "")
LNS_HOME = os.path.join(DATA_DIR, ".lns-wallet")           # the LEZ wallet's files: storage.json holds the key
LNS_STATE_FILE = os.path.join(DATA_DIR, "wallet-lns.json")   # {account, name}: public facts only
LNS_GAS = {"register": 250000, "text": 120000, "send": 1000}   # the phone has no r0vm to size gas; see NAMES.md
                                                           # (send: `names` sets 1,000 for a plain transfer itself)
LNS_ENTRIES = ("blockchain", "msg")
# longer than the wallet's own wait for a block (60 rounds x 30 s, about 29.5 min, see lns_set_gas): a register run
# waits for its commit, 15 minutes, and its reveal
LNS_TIMEOUT = {"register": 95 * 60, "text": 40 * 60, "send": 40 * 60}
LNS_SEND_BYTES = 1500                                      # a plain transfer's bytes, generously, for its fee reserve
LNS_SEND_UNSURE = "May have been sent. Check before sending again."
LNS_SEND_UNSURE_FILE = os.path.join(DATA_DIR, "wallet-lez-unsure.json")   # the last send that may have gone out


lns_unsure_mem = {}                                        # the same hold, in memory: it holds when the disk is full


def lns_unsure_load():
    try:
        with open(LNS_SEND_UNSURE_FILE) as f:
            u = json.load(f)
        u = u if isinstance(u, dict) else {}
        return u if float(u.get("at", 0)) >= float(lns_unsure_mem.get("at", 0)) else dict(lns_unsure_mem)
    except Exception:
        return dict(lns_unsure_mem)


def lns_unsure_save(u):
    """Keeps the hold in memory and on disk; False when the disk couldn't take it (the hold then lasts until the app
    restarts, and the person is told)."""
    lns_unsure_mem.clear()
    lns_unsure_mem.update(u)
    try:
        tmp = LNS_SEND_UNSURE_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)                  # a left-over .tmp keeps its old mode otherwise
        with os.fdopen(fd, "w") as f:
            json.dump(u, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, LNS_SEND_UNSURE_FILE)
        return True
    except Exception:
        return False
LNS_RPC_SECRET = secrets.token_hex(16)                     # in the forwarder's path; only `names` is told it
LNS_RPC_METHODS = {"sendTransaction", "getFeeState", "checkHealth", "getBlock", "getBlockRange", "getLastBlockId",
                   "getAccountBalance", "getTransaction", "getAccountsNonces", "getAccountView", "getProofsAndRoot",
                   "getAccount", "getProgramIds", "getChannelId"}
LNS_RPC_MAX = 2 * 1048576
LNS_BACKUP_MAX = 1048576
LNS_FILES = ("storage.json", "names.json")                 # what holds keys and commitments: snapshotted, backed up
HEX64_RE = re.compile(r"\A[0-9a-f]{64}\Z")
LNS_ACCOUNT_LINE_RE = re.compile(r"\bPublic/([1-9A-HJ-NP-Za-km-z]{32,44})\b")
_N = r"([0-9]{1,30})"
_NAME = r"([a-z0-9-]{1,32})"
# What may be shown of `names` output. Progress: a line that matches one of these, shown as the fixed text
# beside it (with only the captured digits or name). Everything else it prints is dropped.
LNS_PROGRESS = [
    (re.compile(r"\Astep 1 of 2: committing to " + _NAME + r"\Z"), "step 1 of 2: committing to {0}"),
    (re.compile(r"\Astep 2 of 2: registering " + _NAME + r" at [0-9]+ for .{0,40}\Z"), "step 2 of 2: registering {0}"),
    (re.compile(r"\Awaiting " + _N + r"s before revealing.{0,80}\Z"), "waiting {0}s before the second step"),
    (re.compile(r"\Aresuming the commitment to " + _NAME + r" made earlier\Z"), "carrying on with the registration started earlier"),
    (re.compile(r"\Athe reveal did not land.{0,400}\Z"), "the second step didn't land yet; trying again"),
    (re.compile(r"\Asubmitted [0-9a-f]{64}\Z"), "sent; waiting for a block"),
    (re.compile(r"\Aapplied in block " + _N + r"\Z"), "in block {0}"),
    (re.compile(r"\A" + _NAME + r" is registered\Z"), "{0} is registered"),
    (re.compile(r"\ATransaction hash is [0-9a-f]{64}\Z"), "sent; waiting for a block"),         # `wallet auth-transfer send`
    (re.compile(r"\ATransaction is included in block " + _N + r"\Z"), "in block {0}"),
]
# Errors: the text after `names`'s "Error:" (with its causes) is searched for these; the first that matches
# is shown as its fixed text. Anything else shows as LNS_ERROR_OTHER, never as what `names` printed.
LNS_ERRORS = [
    (re.compile(r"holds " + _N + r", less than the " + _N + r" that registering"), "the name account holds {0}, less than the {1} this name takes; add LEZ testnet tokens to it first"),
    (re.compile(r"holds " + _N + r"; this takes " + _N + r", and about " + _N + r" more is held"), "the name account holds {0}; this takes {1}, and about {2} more is held for the fee while it runs"),
    (re.compile(r"holds " + _N + r"; about " + _N + r" is held for the fee"), "the name account holds {0}; about {1} is held for the fee while this runs; add LEZ testnet tokens to it first"),
    (re.compile(r"\b" + _NAME + r" is already registered"), "{0} is already registered"),
    (re.compile(r"\b" + _NAME + r" is locked"), "{0} is locked: names that short are placed by the registry's admin"),
    (re.compile(r"this wallet does not hold " + _NAME), "this phone's name account doesn't hold {0}"),
    (re.compile(r"\b" + _NAME + r" is not registered"), "{0} isn't registered"),
    (re.compile(r"someone else holds the name"), "someone else holds that name now"),
    (re.compile(r"was included in block " + _N + r" but its changes were not"), "it was included in block {0} but didn't take effect"),
    (re.compile(r"was not included in a block"), "the name service didn't include it in a block in time; try again"),
    (re.compile(r"did not accept the transaction"), "the name service didn't accept the change"),
    (re.compile(r"failed to read|isn't answering|error sending request|connection", re.I), "the name service didn't answer; try again"),
]
LNS_ERROR_OTHER = "it stopped with an error this app doesn't show; try again, and if it keeps failing, check the name account's balance"
lns_lock = threading.Lock()                                # guards lns_job
lns_change = threading.Lock()                              # one change of the name account at a time: making it,
                                                           # starting a job, linking a name, restoring it
lns_job = {"kind": None, "state": "idle", "name": "", "entry": "", "progress": "", "error": "", "started": None,
           "finished": None, "proc": None, "to": "", "amount": "", "progress_at": None, "check": None, "act": None, "phase": "", "id": None}
LNS_BUSY = "Wait until the change that is running now has finished."


def lns_available():
    return EMBEDDED and bool(NAMES_BIN) and os.path.isfile(NAMES_BIN) and os.access(NAMES_BIN, os.X_OK)


def lns_name_ok(v):
    return isinstance(v, str) and bool(NAME_RE.fullmatch(v))


def lns_account_ok(v):
    return isinstance(v, str) and bool(ACCOUNT_ID_RE.fullmatch(v))


def lns_state():
    try:
        with open(LNS_STATE_FILE) as f:
            d = json.load(f)
    except Exception:
        d = {}
    out = {"account": d.get("account") if lns_account_ok(d.get("account")) else None,
           "name": d.get("name") if lns_name_ok(d.get("name")) else ""}
    if lns_name_ok(d.get("reg_pending")):     # a registration started and not finished (its commitment may be saved)
        out["reg_pending"] = d["reg_pending"]
    r = d.get("restoring")                    # a restore that set the state but may not have swapped the files
    if isinstance(r, dict) and (r.get("account") is None or lns_account_ok(r.get("account"))) \
            and (r.get("name") in (None, "") or lns_name_ok(r.get("name"))):
        out["restoring"] = {"account": r.get("account"), "name": r.get("name") or "",
                            "names": r.get("names") if isinstance(r.get("names"), str) and HEX64_RE.fullmatch(r.get("names")) else None}
    if isinstance(d.get("names_pending"), str) and HEX64_RE.fullmatch(d["names_pending"]):
        out["names_pending"] = d["names_pending"]   # a restore's names.json that a stop kept from its place
    return out


def lns_state_save(**changes):
    d = lns_state()
    d.update(changes)
    if d.get("restoring") is None:
        d.pop("restoring", None)
    if not d.get("reg_pending"):
        d.pop("reg_pending", None)
    if not d.get("names_pending"):
        d.pop("names_pending", None)
    fd = os.open(LNS_STATE_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
        f.flush()
        os.fsync(f.fileno())                  # a power cut must not lose which account is the phone's
    os.replace(LNS_STATE_FILE + ".tmp", LNS_STATE_FILE)


def lns_storage():
    return os.path.join(LNS_HOME, "storage.json")


def lns_putback():
    """Puts the saved copy (storage.json.prev) back when the live wallet file is missing or unreadable: only a
    copy the signer reads, and of the state's account when the state names one. The unreadable file stays beside."""
    if not lns_change.acquire(blocking=False):
        return 409, {"error": LNS_BUSY}
    try:
        with lns_lock:
            if lns_job["state"] == "running":
                return 409, {"error": LNS_BUSY}
        if not lns_saved_copy():
            return 409, {"error": "There is no saved copy to put back."}
        p = lns_storage()
        with open(p + ".prev", "rb") as f:
            copy = f.read()
        found = lns_accounts_of(copy)
        if found is None:
            return 502, {"error": "The saved copy couldn't be checked right now. Nothing was changed. Try again."}
        st = lns_state()
        if st["account"] and st["account"] not in found:
            return 409, {"error": "The saved copy is of another account, so it wasn't used."}
        account = lns_main_of(found, st["account"])
        if not account:
            return 409, {"error": "The saved copy holds no account."}
        lns_keep_aside(p, "%s-%s" % (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()), secrets.token_hex(3)))
        lns_write(p, copy)
        lns_state_save(account=account)
        event("lns wallet file put back from its saved copy", account=account)
        return 200, {"account": account}
    finally:
        lns_change.release()


def lns_lockdown():
    """The wallet folder 0700 and its files 0600, whatever `names` created them with."""
    os.makedirs(LNS_HOME, mode=0o700, exist_ok=True)
    os.chmod(LNS_HOME, 0o700)
    for f in os.listdir(LNS_HOME):
        p = os.path.join(LNS_HOME, f)
        if os.path.isfile(p) and not os.path.islink(p):
            os.chmod(p, 0o600)


def lns_write(path, data):
    """Writes `data` to `path` atomically, owner-only."""
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path + ".tmp", path)


def lns_json_file_ok(path):
    """Whether `path` holds a JSON object (a missing names.json is fine: there is nothing to lose)."""
    try:
        with open(path, "rb") as f:
            return isinstance(json.loads(f.read()), dict)
    except Exception:
        return False


def lns_snapshot():
    """Before a job: a copy of each wallet file as <file>.prev, so a job killed while `names` rewrites one
    (it truncates and writes in place) can't lose the key."""
    for f in LNS_FILES:
        p = os.path.join(LNS_HOME, f)
        if lns_json_file_ok(p):
            with open(p, "rb") as src:
                lns_write(p + ".prev", src.read())


lns_notes = []                                # what the page should be told once (lns_view hands them over)


def lns_accounts_of(data):
    """The public accounts the signer finds in the wallet file `data` (bytes), read in a temporary folder, as
    lns_accounts_in (None when it couldn't say)."""
    tmp = None
    try:
        tmp = tempfile.mkdtemp(prefix=".lns-check-", dir=DATA_DIR)
        os.chmod(tmp, 0o700)
        lns_write(os.path.join(tmp, "storage.json"), data)
        return lns_accounts_in(tmp)
    except Exception:
        return None
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def lns_saved_copy():
    """Whether the key survives only in the saved copy: storage.json missing or unreadable, its .prev a JSON object.
    Then nothing may overwrite or set aside the copy until it is put back (lns_putback)."""
    p = lns_storage()
    return not lns_json_file_ok(p) and lns_json_file_ok(p + ".prev")


LNS_SAVED_COPY = "The name account's key is in a saved copy on this phone. Put back the saved copy first."


def lns_repair():
    """After a job, at start, and before a change or restore (never while a job runs): a wallet file that no
    longer reads as JSON is put back from its snapshot. For storage.json, only from a snapshot of the same
    account as the state file; a missing storage.json is never filled in. Anything it can't put back, and
    anything it did put back, is told to the page once. Returns the files that were put back."""
    fixed = []
    acct = lns_state()["account"]
    cfg = os.path.join(LNS_HOME, "wallet_config.json")
    if os.path.exists(cfg) and not lns_json_file_ok(cfg):
        os.remove(cfg)                        # holds no key; a torn one fails every command, `names` writes it anew
        event("lns wallet config was torn and is written anew")
    for f in LNS_FILES:
        p = os.path.join(LNS_HOME, f)
        if not os.path.exists(p) or lns_json_file_ok(p):
            continue
        prev = p + ".prev"
        if not lns_json_file_ok(prev):
            lns_notes.append("The name account's %s can't be read, and there is no copy to put back. Restore a backup." % f)
            continue
        if f == "storage.json":
            with open(prev, "rb") as src:
                found = lns_accounts_of(src.read()) if lns_available() else None
            if found is None:
                lns_notes.append("The name account's file can't be read, and its saved copy couldn't be checked "
                                 "right now. Nothing was changed. Try again in a minute.")
                continue
            if not acct and found:            # the state was lost too: the copy names the account
                lns_state_save(account=lns_main_of(found, None))
            elif acct not in found:
                lns_notes.append("The name account's file can't be read, and the copy on this phone is of another "
                                 "account, so it wasn't used. Restore a backup of this account.")
                continue
        with open(prev, "rb") as src:
            lns_write(p, src.read())
        fixed.append(f)
    if fixed:
        lns_notes.append("The name account's file couldn't be read and was put back from the copy made before the last change.")
        event("lns wallet file put back from its snapshot", files=",".join(fixed))
    return fixed


def lns_reconcile():
    """At start: a restore stopped between saving the state and swapping the files is finished one way or the
    other, so the state names the account that is really in the wallet file."""
    st = lns_state()
    r = st.get("restoring")
    if not r or not lns_available():
        return
    found = lns_accounts_in(LNS_HOME) if os.path.isfile(lns_storage()) else []
    if found is None:
        return                                    # the signer can't say now: nothing is changed on a guess
    if st["account"] in found:
        names = os.path.join(LNS_HOME, "names.json")
        here_names = hashlib.sha256(open(names, "rb").read()).hexdigest() if os.path.isfile(names) else None
        if r.get("names") and here_names != r["names"]:
            # stopped between the two swaps: the backup's names.json (a registration in progress) isn't in place;
            # a restore of the same backup puts it there (lns_restore, "same")
            lns_state_save(restoring=None, names_pending=r["names"])
            lns_notes.append("A restore was stopped part way. Restore the same backup again to finish it.")
        else:
            lns_state_save(restoring=None)        # the files were swapped: done
    elif r["account"] and r["account"] in found:
        lns_state_save(account=r["account"], name=r["name"], restoring=None)    # they weren't: back as it was
        lns_notes.append("A restore of the name account was stopped before it finished; nothing about the account changed.")
    else:
        lns_notes.append("A restore of the name account was stopped before it finished. Restore the backup again.")
    event("lns restore reconciled", account_in_file="yes" if found else "no")


def lns_sweep():
    """At start: temporary check folders a stopped restore or repair left behind."""
    for d in os.listdir(DATA_DIR):
        if d.startswith(".lns-check-") and os.path.isdir(os.path.join(DATA_DIR, d)):
            shutil.rmtree(os.path.join(DATA_DIR, d), ignore_errors=True)
    for f in os.listdir(DATA_DIR):            # and the flow's own
        if f.startswith("wallet-lns-flow.json.") and f.endswith(".tmp"):
            try:
                os.remove(os.path.join(DATA_DIR, f))
            except OSError:
                pass
    if os.path.isdir(LNS_HOME):               # half-written files a stop left (each write is to <file>.tmp, then renamed)
        for f in os.listdir(LNS_HOME):
            if f.endswith(".tmp"):
                try:
                    os.remove(os.path.join(LNS_HOME, f))
                except OSError:
                    pass


def lns_env(home=None):
    """The whole environment of `names`: its wallet folder, the forwarder, the registry. Nothing of this
    process's own environment goes along."""
    home = home or LNS_HOME
    return {"PATH": "/system/bin:/usr/bin:/bin", "HOME": home, "TMPDIR": home, "LEE_WALLET_HOME_DIR": home,
            "LOGOS_NAMES_RPC": "http://127.0.0.1:%d/lez-rpc/%s" % (PORT, LNS_RPC_SECRET),
            "LOGOS_NAMES_PROGRAM": NAMES_PROGRAM, "NO_COLOR": "1", "RUST_BACKTRACE": "0"}


LNS_LIST_LINE_RE = re.compile(r"^\s*(/[0-9/]*)\s+Public/([1-9A-HJ-NP-Za-km-z]{32,44})\b", re.M)


def lns_accounts_in(home):
    """The public accounts `names wallet account list` finds in the wallet at `home`, the one this app makes
    (`account new public`: chain index /0) first, then the others in the order listed; None when the signer
    couldn't say (it failed or took too long), which is never taken for "no account" or "another account".
    The wallet exists, so this makes no new one and prints no recovery phrase. It also writes the default
    config if there is none."""
    try:
        r = subprocess.run([NAMES_BIN, "wallet", "account", "list"], env=lns_env(home), cwd=home, capture_output=True,
                           timeout=120, stdin=subprocess.DEVNULL, umask=0o077)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    out = r.stdout.decode("utf-8", "replace")
    pairs = LNS_LIST_LINE_RE.findall(out)
    if not pairs:
        return LNS_ACCOUNT_LINE_RE.findall(out)
    return [a for i, a in pairs if i == "/0"] + [a for i, a in pairs if i != "/0"]


def lns_main_of(found, st_account):
    """Which listed account is the phone's: the state's when it is listed, else the /0 one (listed first)."""
    if not found:
        return None
    return st_account if st_account in found else found[0]


def lns_set_gas(limit):
    p = os.path.join(LNS_HOME, "wallet_config.json")
    if not os.path.isfile(p):
        lns_accounts_in(LNS_HOME)             # a wallet put back from a backup has no config yet
    with open(p) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError("wallet_config.json is not an object")
    cfg["gas_limit"] = limit
    # the wallet waits 60 rounds for a block; 30 s apart that is half an hour, so a commit that lands late on a slow
    # chain is still followed (and its secret saved) instead of given up on and paid for again
    cfg["seq_poll_timeout"] = "30s"
    lns_write(p, json.dumps(cfg, indent=2).encode())


def lns_clean(line):
    """One line of `names` output as it may be shown: the fixed text of a known progress line, else None."""
    s = ANSI_RE.sub(b"", line).decode("utf-8", "replace").strip()
    for pattern, shown in LNS_PROGRESS:
        m = pattern.fullmatch(s)
        if m:
            return shown.format(*m.groups())
    return None


def lns_error_text(lines):
    """What went wrong, as one of the fixed LNS_ERRORS texts, from the last `Error:` block `names` printed."""
    text = [ANSI_RE.sub(b"", l).decode("utf-8", "replace").strip() for l in lines]
    for i in range(len(text) - 1, -1, -1):
        if text[i].startswith("Error:"):
            block = " ".join(t for t in text[i:i + 12] if not t.startswith("Stack backtrace"))
            for pattern, shown in LNS_ERRORS:
                m = pattern.search(block)
                if m:
                    return shown.format(*m.groups())
            return LNS_ERROR_OTHER
    return "it stopped without saying why"


def lns_make_account():
    """(http status, reply). Makes the wallet and its one public account, once. Reads only the address from
    what `names` prints; the recovery phrase it prints for a new wallet is dropped here."""
    if not lns_change.acquire(blocking=False):
        return 409, {"error": LNS_BUSY}
    try:
        with lns_lock:
            if lns_job["state"] == "running":
                return 409, {"error": LNS_BUSY}
        st = lns_state()
        if st["account"] and os.path.isfile(lns_storage()):
            return 409, {"error": "This phone already has a name account.", "account": st["account"]}
        lns_lockdown()
        lns_repair()
        if lns_saved_copy():                      # a new wallet would leave the key only in a copy the next job overwrites
            return 409, {"error": LNS_SAVED_COPY, "saved_copy": True}
        try:
            if os.path.isfile(lns_storage()):     # a wallet without a recorded account: read it, make nothing
                found = lns_accounts_in(LNS_HOME)
                if found is None:
                    return 502, {"error": "Couldn't read this phone's name account right now. Try again."}
                account = lns_main_of(found, st["account"])
            else:
                r = subprocess.run([NAMES_BIN, "wallet", "account", "new", "public"], env=lns_env(), cwd=LNS_HOME,
                                   capture_output=True, timeout=120, stdin=subprocess.DEVNULL, umask=0o077)
                m = LNS_ACCOUNT_LINE_RE.search(r.stdout.decode("utf-8", "replace")) if r.returncode == 0 else None
                del r                             # its stdout held the recovery phrase of the new wallet
                account = m.group(1) if m else None
        except Exception:
            return 502, {"error": "The name account couldn't be made: the signer didn't run."}
        finally:
            try:
                lns_lockdown()
            except Exception:
                pass
        if not lns_account_ok(account):
            return 502, {"error": "The name account couldn't be made."}
        lns_state_save(account=account)
        return 200, {"account": account}
    finally:
        lns_change.release()


def lns_balance(account, timeout=8):
    """The account's LEZ balance as a string, or None when the name service doesn't say."""
    try:
        code, data = fetch_outside(NAMES_RPC_URL, {"jsonrpc": "2.0", "id": 1, "method": "getAccountBalance",
                                                   "params": [account]}, timeout=timeout)
        v = json.loads(data).get("result") if code == 200 else None
        return str(int(v)) if isinstance(v, (int, str)) and not isinstance(v, bool) and str(v).isdigit() else None
    except Exception:
        return None


lns_view_bal = {"account": None, "value": None, "at": 0.0, "done": None}


def lns_view_balance(account):
    """The balance for the page's poll: read fresh, but the poll waits at most a second for it. A sequencer that
    hangs leaves the last value (at most a minute old) or None; one read runs at a time."""
    c = lns_view_bal
    if c["account"] != account:
        c.update(account=account, value=None, at=0.0, done=None)
    if c["done"] is None or c["done"].is_set():
        done = threading.Event()
        c["done"] = done

        def read():
            try:
                v = lns_balance(account, timeout=5)
                if c["account"] == account:
                    c.update(value=v, at=time.time())
            finally:
                done.set()
        threading.Thread(target=read, daemon=True).start()
    c["done"].wait(1.0)
    return c["value"] if time.time() - c["at"] < 60 else None


def lns_view():
    with lns_lock:
        job = {k: lns_job.get(k) for k in ("kind", "state", "name", "entry", "progress", "error", "started", "finished", "to",
                                           "amount", "progress_at", "phase", "unsure")}
    st = lns_state()
    mk = msg_key_load()
    main = next((k["key"] for k in wallet_keys() if k["label"] == "Main"), None)
    notes = list(lns_notes)
    del lns_notes[:len(notes)]
    saved = lns_saved_copy()
    if saved:
        notes.append("The name account's file can't be read, but a saved copy is on this phone. Put it back first.")
    elif st["account"] and not os.path.isfile(lns_storage()):
        notes.append("The name account's file is missing from this phone. Restore a backup that has it.")
    return {"account": st["account"], "balance": lns_view_balance(st["account"]) if st["account"] else None,
            "name": st["name"], "job": job, "last_backup": last_backup(), "notes": notes,
            # the last backup doesn't hold the account as it is now (or there is none)
            "backup_needed": bool(st["account"]) and lns_fingerprint() != lns_backed_up(),
            "values": {"blockchain": main, "msg": mk["public"] if mk else None},
            "cost": lns_cost() if not st["name"] else None, "bridge": bridge_view(),     # before the account too (one tap)
            "cost_entry": lns_entry_fee(),
            "faucet": {k: lns_faucet_last[k] for k in ("at", "amount") if k in lns_faucet_last} or None, "saved_copy": saved,
            # each entry as the name service has it: "here" (points at this wallet / this phone), "other", "none";
            # None while not known. The page offers only what isn't true yet.
            "entries": lns_entries_state(st["name"], main, mk["public"] if mk else None) if st["name"] else None, "activity": list(reversed(lez_act_load()))[:50],
            "reg_pending": st.get("reg_pending", ""), "flow": lns_flow_view()}


def lns_entries_state(name, main, msg):
    texts = lns_entries(name)
    if texts is None:                         # never read yet: None; read and failed: "unknown" (offered, checked when sent)
        return {"blockchain": "unknown", "msg": "unknown"} if name in lns_entries_cache else None
    state = lambda v, want: "none" if not v else "here" if want and v == want else "other"
    return {"blockchain": state(texts.get("blockchain"), main), "msg": state(texts.get("msg"), msg)}


def lns_watch(kind, proc, deadline, on_success):
    """Reads one job's output to its end: keeps the latest progress text and, at the end, the error text."""
    tail, late = [], threading.Event()

    def stop():
        late.set()
        proc.kill()
    timer = threading.Timer(max(1.0, deadline - time.time()), stop)
    timer.daemon = True
    timer.start()
    try:
        for line in proc.stdout:
            tail = (tail + [line])[-40:]
            shown = lns_clean(line)
            if shown:
                with lns_lock:
                    lns_job["lines"] = (lns_job.get("lines") or [])[-40:] + [shown]
                    if lns_job["progress"] != shown:
                        lns_job["progress_at"] = time.time()
                        event("lns progress", kind=kind, line=shown)      # where the minutes go, on the phone
                    lns_job["progress"] = shown
                    # where a registration is, for the page's steps: 1, the wait, 2
                    if shown.startswith("step 1") or shown.startswith("carrying on"):
                        lns_job["phase"] = "1"
                    elif shown.startswith("waiting"):
                        lns_job["phase"] = "wait"
                    elif shown.startswith("step 2") or shown.startswith("the second step"):
                        lns_job["phase"] = "2"
        code = proc.wait(timeout=60)
    except Exception:
        proc.kill()
        code = -1
    timer.cancel()
    ok = code == 0 and not late.is_set()
    try:
        repaired = lns_repair()
    except Exception:
        repaired = []
    if ok:
        try:
            on_success()
        except Exception:
            pass
    try:
        lns_lockdown()
    except Exception:
        pass
    error = "" if ok else ("it took too long and was stopped" if late.is_set() else lns_error_text(tail))
    check = lns_job.get("check")
    if check:                                 # a send is judged by its own transaction, as `names` saw it
        try:
            with lns_lock:
                lines = list(lns_job.get("lines") or [])
            ok, error = check(ok, error, lines)
        except Exception:
            ok, error = False, LNS_SEND_UNSURE
    if repaired:
        error = (error + "; " if error else "") + "the name account's file was put back from the copy made before this change"
    with lns_lock:
        lns_job.update(state="done" if ok else "failed", finished=time.time(), proc=None, error=error, check=None)
        name, act = lns_job["name"], lns_job.get("act")
    if act:
        with lns_lock:
            unsure = lns_job.get("unsure")
        lez_act_set(act, state="done" if ok else "unsure" if unsure else "failed", error=error)
    if kind == "text" and name:
        lns_entries_cut[name] = time.time()   # reads begun before now are older than this change
        lns_entries_cache.pop(name, None)     # read again: the page shows what the name service has now
    if kind == "register" and not ok:
        try:
            lns_state_save(reg_pending="")    # a failed registration no longer holds LEZ back from Send
        except Exception:
            pass
    event("lns %s %s" % (kind, "done" if ok else "failed"), lns_name=name)


def lns_start(kind, build, job_id=None):
    """(http status, reply). With the lock held and no job running, `build(state)` checks the state and returns
    (200, (args, name, entry, on_success)) or an error reply; then `names <args>` starts in the background with
    the gas limit for `kind`, after a snapshot of the wallet files."""
    if not lns_change.acquire(blocking=False):
        return 409, {"error": LNS_BUSY}
    try:
        with lns_lock:
            if lns_job["state"] == "running":
                return 409, {"error": LNS_BUSY}
        lns_repair()
        st = lns_state()
        if lns_saved_copy():
            return 409, {"error": LNS_SAVED_COPY, "saved_copy": True}
        if not os.path.isfile(lns_storage()) or not st["account"]:
            return 409, {"error": "Make the name account first."}
        if not lns_json_file_ok(lns_storage()):
            return 409, {"error": "The name account's file can't be read, so nothing was started."}
        code, built = build(st)
        if code != 200:
            return code, built
        args, name, entry, on_success = built[:4]
        extra = built[4] if len(built) > 4 else {}
        gas = LNS_GAS[kind]
        act = lez_act_add(dict({"kind": kind, "name": name, "entry": entry, "state": "running"},
                               **{k: extra.get(k, "") for k in ("to", "amount")}))
        with lns_lock:
            lns_job.update(kind=kind, state="running", name=name, entry=entry, progress="", error="",
                           started=time.time(), finished=None, to=extra.get("to", ""), amount=extra.get("amount", ""),
                           progress_at=None, check=extra.get("check"), act=act, phase="", lines=[],
                           id=job_id or secrets.token_hex(8), relayed=False, unsure=False)   # its id: the one-tap flow matches on it
        try:
            lns_snapshot()
            lns_set_gas(gas)
            proc = subprocess.Popen([NAMES_BIN] + args, env=lns_env(), cwd=LNS_HOME, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, umask=0o077)
        except Exception:
            with lns_lock:
                lns_job.update(state="failed", finished=time.time(), error="the signer didn't start", check=None)
            lez_act_set(act, state="failed", error="the signer didn't start")
            return 502, {"error": "The signer didn't start."}
        with lns_lock:
            lns_job["proc"] = proc
        threading.Thread(target=lns_watch, args=(kind, proc, time.time() + LNS_TIMEOUT[kind], on_success), daemon=True).start()
        with lns_lock:
            jid = lns_job["id"]
        return 200, {"started": kind, "job": jid}
    finally:
        lns_change.release()


def lns_register(body, job_id=None):
    name = str(body.get("name", "")).strip().lower()
    if not lns_name_ok(name):
        return 400, {"error": "That isn't an LNS name: use a to z, 0 to 9 and -, up to 32 characters."}

    if job_id is None and lns_flow_active():
        return 409, {"error": "Getting a name is under way, or stopped: stop it first."}

    def build(st):
        if st["name"]:
            return 409, {"error": "This phone already holds %s." % st["name"]}
        lns_state_save(reg_pending=name)      # until it is registered: LEZ Send keeps what this registration needs
        return 200, (["register", name, "--owner", "Public/%s" % st["account"], "--term", "1y", "--wait"], name, "",
                     lambda: lns_state_save(name=name, reg_pending=""))
    return lns_start("register", build, job_id)


def lns_link(body):
    name = str(body.get("name", "")).strip().lower()
    if name and not lns_name_ok(name):
        return 400, {"error": "That isn't an LNS name."}
    if not lns_change.acquire(blocking=False):
        return 409, {"error": LNS_BUSY}
    try:
        with lns_lock:
            if lns_job["state"] == "running":
                return 409, {"error": LNS_BUSY}
        if not lns_state()["account"]:
            return 409, {"error": "Make the name account first."}
        fl = lns_flow_load()
        if fl and fl["step"] not in ("done",):  # getting a name decides the name; nothing may set another meanwhile
            return 409, {"error": "Getting %s is under way, or stopped: stop it first." % fl["name"]}
        lns_state_save(name=name)
        return 200, {"name": name}
    finally:
        lns_change.release()


def lns_text(body, job_id=None):
    entry = body.get("entry")
    if not isinstance(entry, str) or entry not in LNS_ENTRIES:
        return 400, {"error": "Only blockchain and msg can be set here."}
    if job_id is None and lns_flow_active():  # the one-tap job's brakes count every transaction: none beside it
        return 409, {"error": "Getting a name is under way, or stopped: stop it first."}
    # what the name service has now, read before the change lock is taken (it can take minutes on a phone): the
    # one-tap job has just read it itself; a tap uses a read under a minute old, else reads once
    cur = lns_state()["name"]
    at, cached = lns_entries_cache.get(cur, (0, None)) if cur else (0, None)
    texts = None if job_id or not cur else cached if cached is not None and time.time() - at < 60 else lns_entries_read(cur)

    def build(st):
        name = st["name"]
        if not name:
            return 409, {"error": "Register or link an LNS name first."}
        if entry == "blockchain":
            value = next((k["key"] for k in wallet_keys() if k["label"] == "Main"), None)
            if not value:
                return 409, {"error": "This wallet's address isn't known yet. Wait for the node, then try again."}
        else:
            mk = msg_key_load()
            if not mk:
                return 409, {"error": "Turn on messages first: this phone has no messaging address yet."}
            value = mk["public"]
        if not HEX64_RE.fullmatch(value):
            return 500, {"error": "That address isn't in the expected form."}
        # an entry the name service already has isn't sent again (read above, for this same name)
        if texts is not None and name == cur and texts.get(entry) == value:
            return 409, {"error": "Already points here.", "already": True}
        return 200, (["set-text", name, entry, value], name, entry, lambda: None)
    return lns_start("text", build, job_id)


# ---- getting LEZ into the name account (android/NAMES.md, "Getting LEZ") ---------------------
# Two ways: the project's faucet, and a bridge from this app's own wallet (Logos Blockchain -> the name account),
# made through the node's own HTTP API (POST /channel/deposit). A deposit moves whole notes and can't be undone,
# so the bridge first sends the exact amount to the same key (a split), waits for that note to be in a block, and
# deposits that one note; the fee comes from the key's other notes. One bridge at a time. Its state is written to
# BRIDGE_FILE before each call to the node, so it carries on after the app restarts and never spends a note twice.

LNS_FAUCET_URL = os.environ.get("LNS_FAUCET_URL", "https://lez.buggers.online/faucet")
BRIDGE_FILE = os.path.join(DATA_DIR, "wallet-bridge.json")
BRIDGE_MAX_FEE = 100000                      # the deposit's fee cap (max_tx_fee), as `names bridge` sets it
SPLIT_FEE_ROOM = 10000                       # set aside for the split's own fee (866 to 2,054 seen)
BRIDGE_POLL = float(os.environ.get("BRIDGE_POLL", "20"))
BRIDGE_GIVE_UP = float(os.environ.get("BRIDGE_GIVE_UP", str(30 * 60)))   # a split or an unanswered deposit not in a block by then
BRIDGE_ACTIVE = ("splitting", "ready", "depositing", "sent")             # notes of the key are spoken for
BRIDGE_READY_MAX = float(os.environ.get("BRIDGE_READY_MAX", str(10 * 60)))  # a "ready" older than this deposits nothing
BRIDGE_MIN = 110000                          # less than the fees it may take (up to 100,000 + 10,000) is refused
BRIDGE_SAME_WAIT = 24 * 3600                 # after an overdue bridge, the same amount waits this long: it may still land
BRIDGE_SPLIT_WAIT = float(os.environ.get("BRIDGE_SPLIT_WAIT", "60"))      # on after the split's note shows, history or not
BRIDGE_SLOW = float(os.environ.get("BRIDGE_SLOW", "60"))   # a landed or overdue bridge is looked at once a minute...
BRIDGE_WATCH = {"landed": 48 * 3600, "overdue": 24 * 3600}               # ...and not after this long
LEZ_V03_PROBE = {"jsonrpc": "2.0", "id": 1, "method": "getRecoveryBinding", "params": ["11111111111111111111111111111111"]}
LNS_RESERVE_BYTES = 1500                     # a registration's transaction bytes, generously: billed at the storage fee
LNS_REG_GAS = (23214, 165000)                # gas a commit and a reveal use, as measured on the testnet (NAMES.md);
LNS_REG_BYTES = 500                          # a fee is the gas used (not the limit) times the base fee, plus the bytes
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
bridge_lock = threading.Lock()               # guards the bridge state and its file
bridge_wake = threading.Event()
lns_cost_cache = {"settings": None, "settings_at": 0.0, "fees": None, "fees_at": 0.0}
lns_faucet_lock = threading.Lock()
lns_faucet_last = {}


LEZ_ACT_FILE = os.path.join(DATA_DIR, "wallet-lez-activity.json")
LEZ_ACT_KEEP = 100
lez_act_lock = threading.Lock()


def lez_act_load():
    try:
        with open(LEZ_ACT_FILE) as f:
            a = json.load(f)
        return a if isinstance(a, list) else []
    except Exception:
        return []


def lez_act_write(a):
    tmp = LEZ_ACT_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(a[-LEZ_ACT_KEEP:], f)
    os.replace(tmp, LEZ_ACT_FILE)


def lez_act_add(entry, act_id=None):
    """The LEZ token's Activity: what this app did with the name account (faucet, bridges, register, entries,
    sends). Payments from elsewhere show only in the balance. Returns the entry's id."""
    e = dict(entry, id=act_id or "%d-%s" % (int(time.time() * 1000), secrets.token_hex(3)), at=time.time())
    with lez_act_lock:
        a = [x for x in lez_act_load() if x.get("id") != e["id"]]
        a.append(e)
        try:
            lez_act_write(a)
        except Exception:
            pass
    return e["id"]


def lez_act_set(act_id, **fields):
    with lez_act_lock:
        a = lez_act_load()
        for x in a:
            if x.get("id") == act_id:
                x.update(fields)
        try:
            lez_act_write(a)
        except Exception:
            pass


def b58decode(text):
    n = 0
    for c in text:
        i = B58.find(c)
        if i < 0:
            raise ValueError("not base58")
        n = n * 58 + i
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def lez_account_bytes(account):
    """The 32 bytes of a LEZ account id: what LEZ 0.3 reads as a deposit's metadata (borsh of AccountId)."""
    raw = b58decode(account)
    if len(raw) != 32:
        raise ValueError("not 32 bytes")
    return raw


def deposit_op_id(channel_hex, notes, metadata):
    """The deposit's operation id, as LEZ mints it: Blake2b-256("OPERATION_ID_V1" | channel | one-byte note count |
    each note's 32 bytes | metadata length, u32 little-endian | metadata). None for note ids that aren't 32 bytes."""
    try:
        parts = [bytes.fromhex(channel_hex), bytes([len(notes)])] + [bytes.fromhex(n) for n in notes]
        if len(parts[0]) != 32 or any(len(p) != 32 for p in parts[2:]):
            return None
    except Exception:
        return None
    h = hashlib.blake2b(digest_size=32)
    h.update(b"OPERATION_ID_V1")
    for p in parts:
        h.update(p)
    h.update(struct.pack("<I", len(metadata)))
    h.update(bytes(metadata))
    return h.hexdigest()


def lez_rpc(method, params, timeout=10):
    """The sequencer's `result` for one call, or raises."""
    code, data = fetch_outside(NAMES_RPC_URL, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=timeout)
    reply = json.loads(data)
    if code != 200 or not isinstance(reply, dict) or reply.get("error") is not None or "result" not in reply:
        raise ValueError("no answer")
    return reply["result"]


def lez_is_v03():
    """True when the sequencer runs LEZ 0.3 (it doesn't know 0.4's getRecoveryBinding), False for 0.4, None when its
    answer tells neither. A deposit whose metadata LEZ can't read is never credited, so only 0.3 is bridged to."""
    try:
        code, data = fetch_outside(NAMES_RPC_URL, LEZ_V03_PROBE, timeout=10)
        reply = json.loads(data)
    except Exception:
        return None
    if not isinstance(reply, dict):
        return None
    err = reply.get("error")
    if isinstance(err, dict):
        return True if err.get("code") == -32601 else None
    return False if "result" in reply else None


def lns_fee_state():
    """(exec ceiling, storage ceiling, exec base fee, storage base fee) of the next block, from getFeeState; None when
    not known. Cached a minute."""
    now = time.time()
    if lns_cost_cache["fees"] and now - lns_cost_cache["fees_at"] < 60:
        return lns_cost_cache["fees"]
    try:
        r = lez_rpc("getFeeState", [])
        ce, cs = int(r["next_base_fee_exec_ceiling"]), int(r["next_base_fee_stor_ceiling"])
        fees = (ce, cs, int(r.get("base_fee_exec", ce)), int(r.get("base_fee_stor", cs)))
    except Exception:
        return None
    lns_cost_cache.update(fees=fees, fees_at=now)
    return fees


def lns_settings():
    """The registry's settings as `names settings` prints them ({mode, deposits: {normal, three_characters},
    prices}), or None while they aren't known. Read in the background (it can take a while), in a throwaway wallet
    folder so the name account's files are never opened; again after an hour (half a minute after a failure)."""
    now = time.time()
    if now - lns_cost_cache["settings_at"] >= (3600 if lns_cost_cache["settings"] else 30):
        lns_cost_cache["settings_at"] = now
        threading.Thread(target=lns_settings_read, daemon=True).start()
    return lns_cost_cache["settings"]


def lns_settings_read():
    tmp = tempfile.mkdtemp(prefix=".lns-check-", dir=DATA_DIR)
    try:
        os.chmod(tmp, 0o700)
        r = subprocess.run([NAMES_BIN, "settings"], env=lns_env(tmp), cwd=tmp, capture_output=True, timeout=120,
                           stdin=subprocess.DEVNULL, umask=0o077)
        out = r.stdout.decode("utf-8", "replace")
        settings = json.loads(out[out.index("{"):out.rindex("}") + 1]) if r.returncode == 0 and "{" in out else None
        if not isinstance(settings, dict) or not isinstance(settings.get("deposits"), dict):
            settings = None
    except Exception:
        settings = None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if settings or not lns_cost_cache["settings"]:
        lns_cost_cache["settings"] = settings
    if not settings:
        lns_cost_cache["settings_at"] = time.time() - 3600 + 30


lns_entries_cache = {}                       # name -> (time read, its texts or None)
LNS_ENTRIES_FRESH = 600                       # read again on a page view after this; a change reads it right away


lns_entries_cut = {}                         # name -> when a change to its entries last ended: older reads aren't kept


def lns_entries_read(name):
    """The name's entries as the name service has them ({key: value}), read with `names resolve` in a throwaway
    wallet folder (it reads the chain only); None when it couldn't be read. Kept for later only if it began after
    the last change to the name ended, so a slow read can't put older entries back."""
    began = time.time()
    tmp = None
    try:
        tmp = tempfile.mkdtemp(prefix=".lns-check-", dir=DATA_DIR)
        os.chmod(tmp, 0o700)
        r = subprocess.run([NAMES_BIN, "resolve", name], env=lns_env(tmp), cwd=tmp, capture_output=True, timeout=180,
                           stdin=subprocess.DEVNULL, umask=0o077)
        out = r.stdout.decode("utf-8", "replace")
        d = json.loads(out[out.index("{"):out.rindex("}") + 1]) if r.returncode == 0 and "{" in out else None
        texts = d.get("texts") if isinstance(d, dict) else None
        texts = {k: v for k, v in texts.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(texts, dict) else None
    except Exception:
        texts = None
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    if began >= lns_entries_cut.get(name, 0):
        lns_entries_cache[name] = (began, texts)
    return texts


def lns_entries(name):
    """What lns_entries_read last found for `name`, read again in the background when older than a minute."""
    at, texts = lns_entries_cache.get(name, (0, None))
    if time.time() - at > LNS_ENTRIES_FRESH and not lns_entries_cache.get(("reading", name)):
        lns_entries_cache[("reading", name)] = True

        def read():
            try:
                lns_entries_read(name)
            finally:
                lns_entries_cache.pop(("reading", name), None)
        threading.Thread(target=read, daemon=True).start()
    return texts


def lns_cost():
    """What registering a name costs and what the name account must hold to start it.
    - `fees`: what the two transactions should cost: the gas each uses (LNS_REG_GAS, measured) at today's base fee,
      plus their bytes. The testnet bills the gas used, not the limit.
    - `reserve`: what `names` checks is held for the fee while a transaction runs: the register gas limit at the
      next block's exec fee ceiling, plus the bytes at the storage ceiling.
    - `need`: what the account must hold to start, so both of `names`'s checks pass: the commit's fee (at the
      ceiling), then, at the reveal, the deposit (or the 1-year price in fee mode) and the reserve.
    Parts not known right now are None."""
    st, fees = lns_settings(), lns_fee_state()
    out = {"deposit": None, "deposit_three": None, "mode": None, "reserve": None, "fees": None, "flow_fees": None, "need": None,
           "need_three": None, "worst": None, "worst_link": None}
    if st:
        out["mode"] = "fee" if st.get("mode") == "fee" else "deposit"
        if out["mode"] == "fee":
            one = as_int((st.get("prices") or {}).get("1y"))
            out["deposit"] = out["deposit_three"] = str(one)
        else:
            out["deposit"] = str(as_int(st["deposits"].get("normal")))
            out["deposit_three"] = str(as_int(st["deposits"].get("three_characters")))
    if fees:
        out["reserve"] = str(LNS_GAS["register"] * fees[0] + LNS_RESERVE_BYTES * fees[1])
        out["fees"] = str(sum(LNS_REG_GAS) * fees[2] + 2 * LNS_REG_BYTES * fees[3])
        # getting a name all the way (register, then both entries)
        out["flow_fees"] = str((sum(LNS_REG_GAS) + 2 * LNS_TEXT_GAS_USED) * fees[2] + 4 * LNS_REG_BYTES * fees[3])
        # the most one tap may bill (lns_flow_worst at today's ceiling): shown before the tap, as on Start over
        out["worst"] = str(lns_flow_worst({"mode": "register", "fee_ceil": [fees[0], fees[1]]}))
        out["worst_link"] = str(lns_flow_worst({"mode": "link", "fee_ceil": [fees[0], fees[1]]}))
    if st and fees:
        commit = LNS_REG_GAS[0] * fees[0] + LNS_RESERVE_BYTES * fees[1]
        out["need"] = str(int(out["deposit"]) + int(out["reserve"]) + commit)
        out["need_three"] = str(int(out["deposit_three"]) + int(out["reserve"]) + commit)
    return out


def lns_faucet():
    """Asks the project's faucet to pay the name account. The faucet's own reason is passed on when it refuses."""
    st = lns_state()
    if not st["account"]:
        return 409, {"error": "Make the name account first."}
    if not lns_faucet_lock.acquire(blocking=False):
        return 409, {"error": "Already asking the faucet."}
    try:
        before = lns_balance(st["account"])
        try:
            code, data = fetch_outside(LNS_FAUCET_URL, {"account": st["account"]}, cap=16384, timeout=60)
        except Exception:
            return 502, {"error": "Couldn't reach the faucet. Check your internet and try again."}
        try:
            reply = json.loads(data)
        except Exception:
            reply = None
        if not isinstance(reply, dict):
            return 502, {"error": "The faucet sent an answer this app can't read."}
        if code != 200 or not isinstance(reply.get("tx"), str):
            why = reply.get("error")
            why = re.sub(r"[\x00-\x1f\x7f]+", " ", why).strip()[:200] if isinstance(why, str) and why.strip() else ""
            return 409, {"error": ("The faucet says: " + why) if why else "The faucet refused, without saying why."}
        amount = as_int(reply.get("amount"))
        lns_faucet_last.update(at=time.time(), amount=str(amount), before=before)
        lez_act_add({"kind": "faucet", "amount": str(amount), "state": "sent"})
        with bridge_lock:                     # a bridge waiting to arrive must not take this grant for itself
            b = bridge_load()
            if b and b["state"] in ("depositing", "sent", "landed"):
                b["lez"]["faucet"] = b["lez"].get("faucet", 0) + amount
                bridge_save(b)
        return 200, {"amount": str(amount), "tx": reply["tx"][:80]}
    finally:
        lns_faucet_lock.release()


def bridge_load():
    try:
        with open(BRIDGE_FILE) as f:
            b = json.load(f)
        return b if isinstance(b, dict) and b.get("state") else None
    except Exception:
        return None


def bridge_save(b):
    """Writes the bridge's state atomically; the caller holds bridge_lock."""
    b["updated"] = time.time()
    tmp = BRIDGE_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(b, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, BRIDGE_FILE)
    lez_act_set("bridge-" + b["id"], state=b["state"], fee=b.get("fee"), error=b.get("error", ""))


def bridge_busy_key(key):
    """Whether a bridge is using `key`'s notes right now (Send from it waits)."""
    with bridge_lock:
        b = bridge_load()
    return bool(b and b["state"] in BRIDGE_ACTIVE and b["from"] == key)


def bridge_view():
    with bridge_lock:
        b = bridge_load()
    if not b:
        return None
    return {k: b.get(k) for k in ("state", "from", "label", "to", "amount", "fee", "split_fee", "created", "sent_at",
                                  "landed_at", "arrived_at", "error", "wait", "id")}


def bridge_check(frm, amount):
    """(None, plan) when a bridge of `amount` from `frm` can start now, else (http status, reply). Changes nothing."""
    st = lns_state()
    if not st["account"] or not os.path.isfile(lns_storage()):
        return 409, {"error": "Make the name account first."}
    keys = {k["key"]: k["label"] for k in wallet_keys()}
    if frm not in keys:
        return 400, {"error": "That account isn't in this wallet."}
    if amount <= 0:
        return 400, {"error": "Enter an amount above 0."}
    if amount < BRIDGE_MIN:
        return 400, {"error": "Bridge at least %s: the fees can take up to that much." % fmt_int(BRIDGE_MIN)}
    with bridge_lock:
        b = bridge_load()
    if b and b["state"] in BRIDGE_ACTIVE:
        return 409, {"error": "A bridge is under way. Start another once it is in a block."}
    if b and b["state"] == "overdue" and as_int(b["amount"]) == amount and time.time() - (b.get("sent_at") or 0) < BRIDGE_SAME_WAIT:
        return 409, {"error": "A bridge of this amount may still land. Wait, or bridge another amount."}
    with hist_lock:
        pending = [e for e in history["entries"] if e["kind"] == "sent" and e.get("status") == "pending" and e.get("key") == frm]
    if pending:
        return 409, {"error": "A transfer from this account isn't in a block yet. Try again once it is."}
    stn = node_status()
    if not stn or stn.get("state") != "Online":
        return 409, {"error": "The node is not online yet, so it can't bridge. Wait until it has finished syncing."}
    notes = notes_of(frm)
    if notes is None:
        return 502, {"error": "The node didn't return this account's coins. Try again in a minute."}
    exact = next((i for i, v in sorted(notes.items()) if v == amount), None)
    others = sum(v for i, v in notes.items() if i != exact)
    split = exact is None
    room = BRIDGE_MAX_FEE + (SPLIT_FEE_ROOM if split else 0)
    if (others - amount if split else others) < room:
        return 409, {"error": "This account holds %s. Bridging %s needs about %s more for the fees (at most %s for the bridge%s)."
                     % (fmt_int(sum(notes.values())), fmt_int(amount), fmt_int(room), fmt_int(BRIDGE_MAX_FEE),
                        ", and about %s to set the amount aside first" % fmt_int(SPLIT_FEE_ROOM) if split else ""),
                     "short": True}
    v03 = lez_is_v03()
    if v03 is None:
        return 502, {"error": "The name service didn't say which version it runs, and a deposit it can't read is never credited. Try again in a minute. Nothing was sent."}
    if not v03:
        return 409, {"error": "The name service runs a newer LEZ that this app can't bridge to yet. Nothing was sent."}
    try:
        channel = lez_rpc("getChannelId", {})
    except Exception:
        channel = None
    if not isinstance(channel, str) or not HEX64_RE.fullmatch(channel.lower()):
        return 502, {"error": "The name service didn't give its deposit channel. Try again in a minute. Nothing was sent."}
    if node("/channel/%s" % channel.lower(), timeout=8)[0] != 200:
        return 409, {"error": "Your node doesn't know the name service's deposit channel yet: it may still be syncing. Nothing was sent."}
    try:
        with open(lns_storage(), "rb") as f:
            held = lns_accounts_of(f.read()) or []
    except Exception:
        held = []
    if st["account"] not in held:
        return 409, {"error": "The name account's key couldn't be read just now, so nothing is sent to it. Try again in a minute."}
    return None, {"from": frm, "label": keys[frm], "to": st["account"], "amount": str(amount), "split": split, "note": exact,
                  "channel": channel.lower(), "fee_max": str(BRIDGE_MAX_FEE), "split_fee_max": str(SPLIT_FEE_ROOM) if split else None,
                  "balance": str(sum(notes.values())), "notes_before": sorted(notes)}


def fmt_int(n):
    return "{:,}".format(int(n))


def lns_bridge(body):
    """Plans (confirm false) or starts (confirm true) a bridge of `amount` from the wallet key `from`."""
    frm = str(body.get("from", "")).strip().lower()
    a = body.get("amount")
    if not isinstance(a, str) or not re.fullmatch(r"[0-9]{1,24}", a):     # plain ASCII digits, nothing else
        return 400, {"error": "The amount must be a whole number."}
    amount = int(a)
    code, plan = bridge_check(frm, amount)
    if code:
        return code, plan
    shown = {k: plan[k] for k in ("from", "label", "to", "amount", "split", "fee_max", "split_fee_max", "balance")}
    if body.get("confirm") is not True:
        return 200, {"plan": shown}
    now = time.time()
    b = {"id": "%d" % int(now * 1000), "state": "ready" if plan["note"] else "splitting", "from": frm, "label": plan["label"],
         "note_seen_at": now if plan["note"] else None,
         "to": plan["to"], "amount": plan["amount"], "channel": plan["channel"], "note": plan["note"],
         "notes_before": plan["notes_before"], "created": now, "fee": None, "split_fee": None, "error": "", "wait": "",
         "lez": {"base": None, "last": None, "up": 0, "faucet": 0}}
    with bridge_lock:
        cur = bridge_load()
        if cur and cur["state"] in BRIDGE_ACTIVE:
            return 409, {"error": "A bridge is under way. Start another once it is in a block."}
        bridge_save(b)                        # the intent, before the node is asked anything
    lez_act_add({"kind": "bridge", "amount": plan["amount"], "from_label": plan["label"], "state": b["state"]}, "bridge-" + b["id"])
    if plan["split"]:
        code, reply = node("/wallet/transactions/transfer-funds", {
            "tip": None, "change_public_key": frm, "funding_public_keys": [frm],
            "recipient_public_key": frm, "amount": amount}, timeout=60)
        with bridge_lock:
            b = bridge_load()
            if not 200 <= code < 300 or not isinstance(reply, dict) or not reply.get("hash"):
                b.update(state="failed", error="The node refused to set the amount aside, so nothing was bridged: %s"
                         % (reply if isinstance(reply, str) else json.dumps(reply) if reply else "no answer")[:200])
                bridge_save(b)
                return 502, {"error": b["error"]}
            b.update(split_hash=reply["hash"], split_at=time.time())
            bridge_save(b)
        history_record_send({"key": frm, "label": plan["label"], "to": frm, "to_label": "itself", "amount": "0",
                             "fee": None, "hash": reply["hash"], "status": "pending", "bridge": "split",
                             "bridge_id": b["id"], "bridge_amount": plan["amount"]})
    bridge_wake.set()
    return 200, {"bridge": bridge_view(), "plan": shown}


LEZ_TO_RE = re.compile(r"\APublic/([1-9A-HJ-NP-Za-km-z]{32,44})\Z")


def lns_send(body):
    """Plans (confirm false) or sends (confirm true) LEZ from the name account to `to` (`Public/<id>`) with
    `names wallet auth-transfer send`, through the job runner (one change at a time). Refused unless the balance and
    the fee are known and cover it, and, while a registration is unfinished, unless what it needs stays."""
    to, amount_s = body.get("to"), body.get("amount")
    m = LEZ_TO_RE.fullmatch(to) if isinstance(to, str) else None
    try:
        ok_to = bool(m) and len(b58decode(m.group(1))) == 32
    except Exception:
        ok_to = False
    if not ok_to:
        return 400, {"error": "Enter a LEZ account: Public/ and its ID."}
    if not isinstance(amount_s, str) or not re.fullmatch(r"[0-9]{1,30}", amount_s) or int(amount_s) <= 0:
        return 400, {"error": "Enter a whole amount above 0."}
    amount = int(amount_s)
    st = lns_state()
    if not st["account"]:
        return 409, {"error": "Make the name account first."}
    fl = lns_flow_load()
    if fl and fl["step"] not in ("done", "failed"):     # its brakes count the account's transactions: none but its own
        return 409, {"error": "Getting %s is under way. Send LEZ once it has finished." % fl["name"]}
    if m.group(1) == st["account"]:
        return 400, {"error": "That's this name account."}
    bal, fees = lns_balance(st["account"]), lns_fee_state()
    if bal is None or fees is None:
        return 502, {"error": "Balance or fee not known right now. Try again."}
    reserve = LNS_GAS["send"] * fees[0] + LNS_SEND_BYTES * fees[1]
    floor = 0
    if st.get("reg_pending") and not st["name"]:
        c = lns_cost()
        need = c["need_three"] if len(st["reg_pending"]) == 3 else c["need"]
        if need is None:
            return 502, {"error": "What the registration needs isn't known right now. Try again."}
        floor = int(need)
    if int(bal) - amount - reserve < floor:
        return 409, {"error": ("Not enough: %s must stay for registering %s." % (fmt_int(floor), st["reg_pending"])) if floor
                     else "Not enough: the account holds %s; the fee needs up to %s." % (fmt_int(bal), fmt_int(reserve))}
    u = lns_unsure_load()
    if u.get("at", 0) > time.time():          # a clock set back: it counts from now, once
        u["at"] = time.time()
        lns_unsure_save(u)
    at = u.get("at", 0)
    if u.get("to") == m.group(1) and u.get("amount") == str(amount) and time.time() - at < 600:
        return 409, {"error": "The same send may have gone out a moment ago. Check the balance, then try again in a few minutes."}
    plan = {"from": st["account"], "to": m.group(1), "amount": str(amount), "fee_max": str(reserve)}
    if body.get("confirm") is not True:
        return 200, {"plan": plan}
    def check(ok, error, lines):
        """By the transaction itself, never by the balance (LEZ arriving meanwhile, or a billed failure, would
        mislead it): included in a block when `names` saw it included; sent but not seen in a block yet when it
        printed the hash and then stopped (it may still land: never "try again"); not sent when it printed no hash."""
        if any(l.startswith("in block ") for l in lines):
            return True, ""
        with lns_lock:
            relayed = lns_job.get("relayed")
        if any(l.startswith("sent;") for l in lines) or relayed:   # handed to the sequencer: it may have gone out
            with lns_lock:
                lns_job["unsure"] = True
            if not lns_unsure_save({"to": m.group(1), "amount": str(amount), "at": time.time()}):
                return False, LNS_SEND_UNSURE + " (This phone's storage is full: the hold on sending it again lasts until the app restarts.)"
            return False, LNS_SEND_UNSURE
        return False, "not sent: " + (error or "it stopped before sending")

    def build(st2):
        if st2["account"] != st["account"]:
            return 409, {"error": "The name account changed. Try again."}
        return 200, (["wallet", "auth-transfer", "send", "--from", "Public/%s" % st["account"], "--to", "Public/%s" % m.group(1),
                      "--amount", str(amount)], "", "", lambda: None, {"to": m.group(1), "amount": str(amount), "check": check})
    code, reply = lns_start("send", build)
    return code, dict(reply, plan=plan) if code == 200 else reply


def lns_bridge_cancel():
    """Drops a bridge that hasn't deposited anything yet. A note already set aside stays in the wallet."""
    with bridge_lock:
        b = bridge_load()
        if not b or b["state"] not in ("splitting", "ready"):
            return 409, {"error": "There is no bridge that can still be stopped."}
        b.update(state="cancelled", error="")
        bridge_save(b)
    bridge_history_settle(b, "split", "in block" if b.get("note") else "not in a block")
    return 200, {"bridge": bridge_view()}


def bridge_deposit(b):
    """Makes the deposit of the one note `b["note"]`. Called by the loop only, with the intent written first."""
    v03 = lez_is_v03()
    try:
        channel = lez_rpc("getChannelId", {})
    except Exception:
        channel = None
    if v03 is not True or channel != b["channel"] or node("/channel/%s" % b["channel"], timeout=8)[0] != 200:
        with bridge_lock:
            b = bridge_load()
            b["wait"] = "waiting for the name service and your node to agree on the deposit channel"
            bridge_save(b)
        return
    try:
        metadata = list(lez_account_bytes(b["to"]))
    except Exception:
        with bridge_lock:
            b = bridge_load()
            b.update(state="failed", error="The name account's address doesn't read. Nothing was bridged.")
            bridge_save(b)
        return
    notes = notes_of(b["from"]) or {}
    if b["note"] not in notes:
        with bridge_lock:
            b = bridge_load()
            b.update(state="failed", error="The note set aside for the bridge is no longer in the wallet. Nothing was bridged.")
            bridge_save(b)
        return
    if lns_state()["account"] != b["to"]:     # a restore changed the name account since the bridge started
        with bridge_lock:
            b = bridge_load()
            b.update(state="failed", error="The name account changed since the bridge started, so nothing was bridged.")
            bridge_save(b)
        return
    lez_now = lns_balance(b["to"])
    with bridge_lock:
        b = bridge_load()
        if b["state"] != "ready" or lns_state()["account"] != b["to"]:
            return
        b.update(state="depositing", deposit_at=time.time(), deposit_notes=notes, wait="",
                 op_id=deposit_op_id(b["channel"], [b["note"]], metadata))
        b["lez"].update(base=as_int(lez_now) if lez_now is not None else None, last=as_int(lez_now) if lez_now is not None else None)
        # in the history now, with the intent: a deposit that lands before the node answers is still this one
        history_record_send({"key": b["from"], "label": b["label"], "to": b["to"], "to_label": "your name account",
                             "amount": b["amount"], "fee": None, "hash": None, "status": "pending", "bridge": "deposit",
                             "bridge_id": b["id"]})
        f = lns_faucet_last
        if f.get("at", 0) > time.time() - 600 and not (lez_now is not None and f.get("before") is not None
                                                        and int(lez_now) >= int(f["before"]) + as_int(f.get("amount"))):
            b["lez"]["faucet"] = as_int(f.get("amount"))     # a grant asked for just before, not in yet, may still land
        bridge_save(b)                        # written before the node is asked: a restart never deposits it again
    code, reply = node("/channel/deposit", {
        "tip": None, "deposit": {"channel_id": b["channel"], "inputs": [b["note"]], "metadata": metadata},
        "change_public_key": b["from"], "funding_public_keys": [b["from"]], "max_tx_fee": BRIDGE_MAX_FEE}, timeout=600)
    with bridge_lock:
        b = bridge_load()
        if 200 <= code < 300 and isinstance(reply, dict) and isinstance(reply.get("hash"), str):
            b.update(state="sent", hash=reply["hash"][:128], sent_at=time.time())
        elif code == 0 or code >= 500:        # no answer, or the node's own error: it may have been made; the note tells
            b.update(state="sent", hash=None, sent_at=time.time(), unsure=True)
        else:
            detail = reply if isinstance(reply, str) else json.dumps(reply) if reply else ""
            b.update(state="failed", error="The node refused the deposit, so nothing was bridged: %s" % detail[:200])
        bridge_save(b)
    if b["state"] == "failed":
        bridge_history_drop(b, "deposit")     # the node made nothing
    elif b.get("hash"):
        with hist_lock:
            for e in history["entries"]:
                if e.get("bridge_id") == b["id"] and e.get("bridge") == "deposit":
                    e["hash"] = b["hash"]
            history_save()


def bridge_round():
    """One look at the bridge under way: moves it on as far as what the node and the sequencer say."""
    with bridge_lock:
        b = bridge_load()
        if b and b["state"] == "depositing":  # stopped in the middle of the node call: the note tells whether it went
            b.update(state="sent", hash=b.get("hash"), sent_at=b.get("deposit_at") or time.time(), unsure=True)
            bridge_save(b)
    if not b or b["state"] not in ("splitting", "ready", "sent", "overdue", "landed"):
        return
    now = time.time()
    if b["state"] in BRIDGE_WATCH:            # waiting on others (finality, the sequencer): slowly, and not forever
        since = b.get("landed_at") if b["state"] == "landed" else b.get("sent_at")
        if now - (since or now) > BRIDGE_WATCH[b["state"]] or now - b.get("polled_at", 0) < BRIDGE_SLOW:
            return
        with bridge_lock:
            cur = bridge_load()
            if cur and cur.get("id") == b.get("id"):
                cur["polled_at"] = now
                bridge_save(cur)
    if b["state"] == "splitting":
        notes = notes_of(b["from"])
        if notes is None:
            return
        new = sorted(i for i, v in notes.items() if v == as_int(b["amount"]) and i not in b["notes_before"])
        with bridge_lock:
            b = bridge_load()
            if b["state"] != "splitting":
                return
            if new:
                # on once the history has the split in a block (its fee), or a minute after the note showed: the
                # history then gets no second pending transfer from this key to mix up
                if not b.get("note_seen_at"):
                    b["note_seen_at"] = now
                b["split_fee"] = bridge_fee_of(b, "split")
                if b["split_fee"] is not None or now - b["note_seen_at"] > BRIDGE_SPLIT_WAIT:
                    b.update(state="ready", note=new[0])
                    bridge_history_settle(b, "split")
            elif now - b.get("split_at", b["created"]) > BRIDGE_GIVE_UP:
                b.update(state="failed", error="Setting the amount aside didn't reach a block in time. Nothing was bridged.")
                bridge_history_settle(b, "split", "not in a block")
            bridge_save(b)
        if b["state"] != "ready":
            return
    if b["state"] == "ready":
        if now - (b.get("note_seen_at") or b.get("created") or 0) > BRIDGE_READY_MAX and b.get("note_seen_at", b.get("created")):
            # an old intent never deposits on a later round: the person confirms again
            with bridge_lock:
                b = bridge_load()
                if b["state"] == "ready":
                    b.update(state="cancelled", error="It waited too long to be sent, so nothing was bridged. The amount stays in your wallet.")
                    bridge_save(b)
            return
        return bridge_deposit(b)
    if b["state"] in ("sent", "overdue"):
        notes = notes_of(b["from"])
        if notes is None:
            return
        with bridge_lock:
            b = bridge_load()
            if b["state"] not in ("sent", "overdue"):
                return
            if b["note"] not in notes:        # its note is spent: the deposit is in a block
                b.update(state="landed", landed_at=now, unsure=False, error="", fee=bridge_fee_of(b, "deposit"))
            elif b.get("unsure") and now - b["sent_at"] > BRIDGE_GIVE_UP:
                # the node never answered: it may have taken the deposit. Watched on, never called "nothing bridged"
                b.update(state="overdue", error="The node didn't confirm the deposit. Its note is still in your wallet; it may still land.")
                bridge_history_settle(b, "deposit", "not in a block")
            elif b["state"] == "sent" and now - b["sent_at"] > BRIDGE_GIVE_UP:
                # taken by the node but not in a block: the key is free again, and the note is still watched
                b.update(state="overdue", error="The deposit isn't in a block after 30 minutes. Its note is still in your wallet; it may still go through if the network takes it later.")
                bridge_history_settle(b, "deposit", "not in a block")
            bridge_save(b)
    if b["state"] in ("sent", "landed"):
        bal = lns_balance(b["to"])
        if bal is None:
            return
        bal = int(bal)
        with bridge_lock:
            b = bridge_load()
            if b["state"] not in ("sent", "landed"):
                return
            lez = b["lez"]
            if lez.get("last") is not None and bal > lez["last"]:
                lez["up"] = lez.get("up", 0) + bal - lez["last"]
            lez["last"] = bal
            if b["state"] == "landed" and lez["up"] - lez.get("faucet", 0) >= as_int(b["amount"]):
                b.update(state="arrived", arrived_at=now)
            bridge_save(b)
        if b["state"] == "arrived":
            event("lns bridge arrived", amount=b["amount"])


def bridge_fee_of(b, step):
    """The fee of the bridge's `step` ("split" or "deposit"), once the history has it in a block."""
    with hist_lock:
        e = next((e for e in history["entries"] if e.get("bridge_id") == b["id"] and e.get("bridge") == step), None)
    return e.get("fee") if e and e.get("status") == "in block" else None


def bridge_history_settle(b, step, status="in block"):
    """Ends the bridge's `step` in the history when the history couldn't tell: in a block (its fee unknown), or not."""
    with hist_lock:
        for e in history["entries"]:
            if e.get("bridge_id") == b["id"] and e.get("bridge") == step and e.get("status") == "pending":
                e.update(status=status, landed=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                history_save()


def bridge_history_drop(b, step):
    """Takes out of the history a step the node refused: nothing was made."""
    with hist_lock:
        history["entries"] = [e for e in history["entries"] if not (e.get("bridge_id") == b["id"] and e.get("bridge") == step)]
        history_save()


def bridge_loop():
    while True:
        try:
            bridge_round()
            with bridge_lock:
                b = bridge_load()
            if b and b["state"] in ("landed", "arrived") and time.time() - b.get("landed_at", 0) > 60:
                bridge_history_settle(b, "deposit")   # the history couldn't match it in a minute: in a block, fee unknown
            for key, step in (("fee", "deposit"), ("split_fee", "split")):
                if b and b["state"] in ("ready", "sent", "landed", "arrived") and b.get(key) is None and (step == "split" or b["state"] != "ready"):
                    fee = bridge_fee_of(b, step)
                    if fee is not None:
                        with bridge_lock:
                            b = bridge_load()
                            b[key] = fee
                            bridge_save(b)
        except Exception:
            pass
        bridge_wake.wait(BRIDGE_POLL)
        bridge_wake.clear()


# ---- Get this name: one tap, one chained job (android/NAMES.md, "One tap") ---------------------------------
# After the one tap the app does every step itself, in order, and carries on after a restart:
#   account   make the name account if there is none (silently)
#   fund      wait until it holds what the whole chain needs (the page shows one line and the way to add LEZ)
#   register  commit, wait, reveal (`names register`; a stop resumes the saved commitment)
#   blockchain   point the name at this wallet's Main address
#   msg       point it at this phone's messaging address (only once Messages is on; later by itself)
# A "link" (a name the account already holds) skips fund and register after the signer confirms the hold.
# Every step is decided from the chain, not from how the last run ended: before sending anything the name is read
# (`names resolve`), and a step already true is skipped. A step that didn't take is tried again, after a pause
# that grows, up to LNS_FLOW_TRIES times; then the flow stops with one line, and Try again starts it over.
# The flow signs after the wallet locks: the one tap is the consent (NAMES.md, review list).

LNS_FLOW_FILE = os.path.join(DATA_DIR, "wallet-lns-flow.json")
LNS_FLOW_POLL = float(os.environ.get("LNS_FLOW_POLL", "5"))
LNS_FLOW_PAUSES = [float(x) for x in os.environ.get("LNS_FLOW_PAUSES", "30,120,300,600").split(",")]
LNS_FLOW_TRIES = len(LNS_FLOW_PAUSES) + 1
LNS_FLOW_STEPS = ("account", "fund", "register", "blockchain", "msg")
LNS_FLOW_ACTIVE = ("account", "register", "blockchain", "msg")           # changes run: no restore meanwhile
LNS_TEXT_GAS_USED = 65590                    # a set-text's gas, as measured on the testnet (NAMES.md)
lns_flow_lock = threading.RLock()            # one round at a time; a tap, Try again or Stop waits for it
lns_flow_wake = threading.Event()
# a name's fixed refusals: trying again can't help
LNS_FLOW_FINAL = ("is already registered", "is locked", "doesn't hold", "isn't registered", "someone else holds",
                  "didn't take effect")       # included and billed its whole limit: trying again would pay again
LNS_FLOW_FUND_MAX = float(os.environ.get("LNS_FLOW_FUND_MAX", str(24 * 3600)))    # waiting for LEZ, at most
LNS_FLOW_MAX = float(os.environ.get("LNS_FLOW_MAX", str(48 * 3600)))              # the whole job, from the tap
LNS_FLOW_READ_WAITS = [15, 30, 60, 120, 300, 600]           # an unreadable chain: read again after these, then stop


def lns_flow_load():
    try:
        with open(LNS_FLOW_FILE) as f:
            fl = json.load(f)
        return fl if isinstance(fl, dict) and lns_name_ok(fl.get("name")) and fl.get("step") in LNS_FLOW_STEPS + ("done", "failed") else None
    except Exception:
        return None


def lns_flow_save(fl, sync=True):
    """Writes the flow atomically, 0600. `sync=False` for the time it has run (each round): written, not forced to
    the disk, so a round costs no fsync."""
    fl["updated"] = time.time()
    tmp = LNS_FLOW_FILE + ".%d.tmp" % threading.get_ident()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)                      # a left-over .tmp keeps its old mode otherwise
    with os.fdopen(fd, "w") as f:
        json.dump(fl, f)
        f.flush()
        if sync:
            os.fsync(f.fileno())
    os.replace(tmp, LNS_FLOW_FILE)


def lns_boot_clock():
    """Seconds since the phone started, counting deep sleep (CLOCK_BOOTTIME; on Android CLOCK_MONOTONIC stops while
    the phone sleeps). Where there is none, the monotonic clock."""
    try:
        return time.clock_gettime(time.CLOCK_BOOTTIME)
    except (AttributeError, OSError):
        return time.monotonic()


def lns_flow_active():
    """Whether a flow exists that isn't done (running, waiting or stopped): manual changes wait for it."""
    fl = lns_flow_load()
    return bool(fl and fl["step"] != "done")


def lns_flow_busy():
    """Whether the flow is in the middle of changing the name account (a restore waits meanwhile)."""
    fl = lns_flow_load()
    return bool(fl and fl["step"] in LNS_FLOW_ACTIVE)


def lns_entry_fee():
    """What one entry should cost at today's base fee, or None."""
    fees = lns_fee_state()
    return str(LNS_TEXT_GAS_USED * fees[2] + LNS_REG_BYTES * fees[3]) if fees else None


def lns_flow_need(name):
    """What the account must hold to start, so that every step's own check passes: the commit's fee, then the
    largest of what the reveal, the first entry and the second entry each need held (their fees at the ceiling,
    the deposit, each reserve). None when not known."""
    c, fees = lns_cost(), lns_fee_state()
    dep = c["deposit_three"] if len(name) == 3 else c["deposit"]
    if dep is None or fees is None:
        return None
    dep = int(dep)
    at = lambda gas: gas * fees[0] + LNS_RESERVE_BYTES * fees[1]          # a fee at the ceiling
    commit, r_reveal, r_text = at(LNS_REG_GAS[0]), at(LNS_GAS["register"]), at(LNS_GAS["text"])
    f_reveal, f_text = at(LNS_REG_GAS[1]), at(LNS_TEXT_GAS_USED)
    return commit + max(dep + r_reveal, dep + f_reveal + r_text, dep + f_reveal + f_text + r_text)


def lns_flow_cost(name):
    """What the whole chain should cost at today's base fee: (deposit, fees), or None."""
    c, fees = lns_cost(), lns_fee_state()
    dep = c["deposit_three"] if len(name or "") == 3 else c["deposit"]
    if dep is None or fees is None:
        return None
    gas = sum(LNS_REG_GAS) + 2 * LNS_TEXT_GAS_USED
    return int(dep), gas * fees[2] + 4 * LNS_REG_BYTES * fees[3]


def lns_get(body):
    """The one tap: `name` and `mode` ("register", or "link" for a name the account already holds)."""
    name, mode = body.get("name"), body.get("mode", "register")
    if not lns_name_ok(name):                 # the whole string, as sent: nothing is trimmed or lowered here
        return 400, {"error": "That isn't an LNS name: a to z, 0 to 9 and -."}
    if mode not in ("register", "link"):
        return 400, {"error": "Unknown way to get a name."}
    with lns_flow_lock:
        fl = lns_flow_load()
        if fl and fl["step"] != "done":       # a stopped one is never replaced without the person's Stop
            return 409, {"error": ("Getting %s is under way." if fl["step"] != "failed" else "Getting %s stopped: Stop it, or Try again.") % fl["name"]}
        st = lns_state()
        if st["name"] and st["name"] != name:
            return 409, {"error": "This phone already holds %s." % st["name"]}
        if lns_saved_copy():
            return 409, {"error": LNS_SAVED_COPY, "saved_copy": True}
        main = next((k["key"] for k in wallet_keys() if k["label"] == "Main"), None)
        if not main:
            return 409, {"error": "This wallet's address isn't known yet. Wait for the node, then try again."}
        fl = {"name": name, "mode": mode, "step": "account", "account": st["account"], "main": main, "tries": 0,
              "next_at": 0, "error": "", "started": time.time(), "msg_later": False, "job": None, "elapsed": 0}
        lns_flow_save(fl)
        lns_flow_mem.update(mono=None, next_mono=0.0, resolves=0, last_resolve=-1e9, unsaved=0.0)   # a new flow
    lns_flow_wake.set()
    event("lns get started", lns_name=name, mode=mode)
    return 200, {"flow": lns_flow_view()}


def lns_flow_retry():
    with lns_flow_lock:
        fl = lns_flow_load()
        if not fl or fl["step"] != "failed":
            return 409, {"error": "Nothing to try again."}
        # the person's own tap, unlocked: a fresh start in every count and limit (S-2 of review B2)
        fl.update(step=fl.get("failed_at") or "account", tries=0, next_at=0, error="", sends={}, job=None, read_waits=0,
                  started=time.time(), elapsed=0, fund_since=None, fund_elapsed=0, send_waits=0,
                  fee_ceil=None, nonce_start=None, nonce_seen=None, billed=0, last_send_at=0, bal_start=None,
                  billing_kind=None, reg_runs=[])
        if fl["step"] == "fund":
            fl["short"] = None
        # the time it sat stopped isn't the flow's: the next round counts from now
        lns_flow_mem.update(mono=None, next_mono=0.0, resolves=0, last_resolve=-1e9)
        lns_flow_save(fl)
    lns_flow_wake.set()
    return 200, {"flow": lns_flow_view()}


def lns_flow_stop_safe():
    """Whether the running change can be stopped now without losing anything: only a register waiting out the 15
    minutes between its two steps. Its commit is in a block and saved (names.json), and nothing is being sent; the
    next register resumes it. At any other moment the signer may be mid-send, or between a send and saving what it
    sent, so it is never stopped then."""
    with lns_lock:
        return lns_flow_stop_safe_locked()


def lns_flow_stop_safe_locked():
    """lns_flow_stop_safe, with lns_lock held. The window is narrower than the whole wait: the last line was "waiting
    N s" with N over 35, printed less than 20 s ago. Then the signer is certainly asleep, and it prints again before
    it does anything else (before it rewrites the wallet file, before the reveal)."""
    m = re.match(r"waiting ([0-9]+)s", lns_job.get("progress") or "")
    return bool(lns_job["state"] == "running" and lns_job["kind"] == "register" and lns_job.get("phase") == "wait"
                and m and int(m.group(1)) > 35 and time.time() - (lns_job.get("progress_at") or 0) < 20)


def lns_flow_stop(body=None):
    """Stops the flow, whatever step it is at, as long as none of its changes is running right now (a change already
    sent stays sent). Then a new tap can start another. With {"now": true}, a running change is stopped too, but only
    when that is safe (lns_flow_stop_safe)."""
    with lns_flow_lock:
        fl = lns_flow_load()
        if not fl:
            return 409, {"error": "Nothing to stop."}
        with lns_lock:                        # judged and done under the lock the signer's lines are kept with: no race
            running, kind, started, proc = lns_job["state"] == "running", lns_job["kind"], lns_job["started"], lns_job.get("proc")
            safe = running and lns_flow_stop_safe_locked()
            killed = False
            if running and (body or {}).get("now") is True and safe and proc:
                proc.kill()                   # asleep between the two steps: the commit is saved, nothing is in flight
                killed = True
        if running:
            if killed:
                event("lns get stopped now", lns_name=fl["name"])
            else:
                until = (started or time.time()) + LNS_TIMEOUT.get(kind, 0)
                return 409, {"error": "A change is being sent. It can take until %s (up to %d minutes in all)."
                             % (time.strftime("%H:%M", time.localtime(until)), LNS_TIMEOUT.get(kind, 0) // 60),
                             "until": until, "safe_now": safe}
        try:
            os.remove(LNS_FLOW_FILE)
        except OSError:
            pass
    return 200, {}


def lns_flow_view():
    fl = lns_flow_load()
    if not fl:
        return None
    if fl["step"] == "fund" and fl.get("next_at", 0) > time.time() and time.time() - fl.get("checked_at", 0) > 10:
        lns_flow_wake.set()                   # someone is looking: check the balance now, not in a minute
        with lns_flow_lock:
            cur = lns_flow_load()
            if cur and cur["step"] == "fund":
                cur["next_at"] = 0
                lns_flow_mem["next_mono"] = 0.0
                lns_flow_save(cur)
    out = {k: fl.get(k) for k in ("name", "mode", "step", "error", "tries", "next_at", "msg_later", "short", "started", "finished", "failed_at")}
    cost = lns_flow_cost(fl["name"])
    out["cost"] = {"deposit": str(cost[0]), "fees": str(cost[1])} if cost else None
    if fl["step"] == "failed":
        out["spent"], out["next_max"] = lns_flow_stopped_view(fl)
    return out


lns_flow_stopped_cache = {}                  # what a stopped flow's view shows, read in the background (S-3)


def lns_flow_stopped_view(fl):
    """(spent, next_max) for a stopped flow, from a read at most 30 s old, made in the background so the page's poll
    never waits on the sequencer. Before the first read: {"reading": true}, and no maximum (no Start over yet)."""
    key = (fl.get("started"), fl.get("failed_at"), fl.get("error"))
    c = lns_flow_stopped_cache
    if c.get("key") != key:
        c.clear()
        c["key"] = key
    if time.time() - c.get("at", 0) > 30 and not c.get("reading"):
        c["reading"] = True

        def read():
            try:
                spent, nm = lns_flow_spent(fl), lns_flow_next_max(fl)
                if c.get("key") == key:       # another flow's read never lands under this one
                    c.update(spent=spent, next_max=nm, at=time.time())
                    if nm is not None:
                        c["last_max"] = nm
            finally:
                if c.get("key") == key:
                    c["reading"] = False
        threading.Thread(target=read, daemon=True).start()
    return c.get("spent") or {"reading": True}, c.get("next_max") or c.get("last_max")


def lns_flow_spent(fl):
    """What a stopped flow has really done, for the person to see before starting over: its transactions in blocks
    (the nonce since its first paid send), the most they can have been billed, and the balance then and now. Parts
    not known are None."""
    if fl.get("nonce_start") is None or not fl.get("fee_ceil"):
        return {"tx": 0, "billed_max": "0", "balance_change": None}
    n = lez_nonce(fl["account"], timeout=5)
    seen = (fl.get("nonce_seen") or fl["nonce_start"]) - fl["nonce_start"]
    if n is None:                             # not readable now: what was seen so far, never "0" for not known
        return {"tx": None, "tx_seen": seen, "billed_max": None, "billed_seen": str(fl.get("billed", 0)), "balance_change": None}
    billed = fl.get("billed", 0)
    if fl.get("nonce_seen") is not None and n > fl["nonce_seen"]:
        billed += (n - fl["nonce_seen"]) * lns_flow_tx_max(fl, "register")      # whatever landed late: the larger kind
    bal = lns_balance(fl["account"], timeout=5)
    return {"tx": n - fl["nonce_start"], "billed_max": str(billed),
            # net: LEZ that arrived meanwhile (a bridge, the faucet) is in it
            "balance_change": None if bal is None or fl.get("bal_start") is None else str(int(bal) - fl["bal_start"])}


def lns_flow_worst(fl):
    """The most one flow can be billed, at its fee ceiling (NAMES.md, Worst case; the Start over and Get buttons say
    the same): its transaction cap, every one at its kind's full limit. A register flow: 6 register transactions
    (one run of a commit and four failed reveals is 5; a transaction of that run still pending when the second run
    is allowed can make 6, and the cap stops anything more). A held name: 4 entries."""
    if fl["mode"] == "register":
        return LNS_FLOW_TX_CAP["register"] * lns_flow_tx_max(fl, "register")
    return LNS_FLOW_TX_CAP["link"] * lns_flow_tx_max(fl, "text")


def lns_flow_next_max(fl):
    """The most a fresh start could bill at today's fee ceiling, or None (shown on Start over)."""
    fees = lns_fee_state()
    if not fees:
        return None
    return str(lns_flow_worst(dict(fl, fee_ceil=[fees[0], fees[1]])))


def lns_flow_fail(fl, step, error, final=False):
    """A step that didn't take: tried again after a growing pause, or, after the last try (or a refusal trying
    again can't change), the flow stops with one line. What landed is counted first, so a stop shows it."""
    if fl.get("fee_ceil") and step != "account":
        n = lez_nonce(fl["account"], timeout=5)
        if n is not None:
            lns_flow_settle(fl, n)
    fl["tries"] = fl.get("tries", 0) + 1
    if final or fl["tries"] >= LNS_FLOW_TRIES:
        fl.update(step="failed", failed_at=step, error=error, next_at=0)
        event("lns get stopped", lns_name=fl["name"], step=step)
    else:
        fl.update(step=step, error=error)
        lns_flow_pause(fl, LNS_FLOW_PAUSES[fl["tries"] - 1])
        return
    lns_flow_save(fl)


def lns_flow_next(fl, step):
    if fl.get("fee_ceil"):                    # what the step just finished billed, counted now at its own kind
        n = lez_nonce(fl["account"])
        if n is not None:
            lns_flow_settle(fl, n)
    fl.update(step=step, tries=0, next_at=0, error="", job=None, read_waits=0, send_waits=0)
    lns_flow_mem.update(next_mono=0.0, resolves=0, last_resolve=-1e9)       # a step taken: reads may come sooner
    if step == "done":
        fl["finished"] = time.time()
        event("lns get done", lns_name=fl["name"])
    lns_flow_save(fl)
    lns_flow_wake.set()


def lns_flow_holds(name, account):
    """Whether this phone's account holds `name` on chain, by the signer reading it with the wallet's own keys
    (`names resolve` in the wallet's folder; it reads the chain and saves nothing): True, False, or None when it
    couldn't be read. Called only between changes (no job runs); it holds no lock, so it never blocks a tap."""
    try:
        r = subprocess.run([NAMES_BIN, "resolve", name], env=lns_env(), cwd=LNS_HOME, capture_output=True, timeout=180,
                           stdin=subprocess.DEVNULL, umask=0o077)
        out = r.stdout.decode("utf-8", "replace")
        if r.returncode != 0:
            return False if re.search(r"\bis not registered\b", out + r.stderr.decode("utf-8", "replace")) else None
        d = json.loads(out[out.index("{"):out.rindex("}") + 1])
        held = d.get("held_by") or ""
        return bool(held) and held.split("/")[-1] == account
    except Exception:
        return None


def lns_flow_job(fl, kind):
    """How the job this flow started for `kind` ended: "running", "done", "failed", or None (none known: the app
    restarted, or none was started). Matched by the job's id, written to the flow file before it started; never by
    the clock."""
    j = fl.get("job") or {}
    if j.get("ended"):                        # its result was used already
        return None
    with lns_lock:
        if j.get("kind") == kind and j.get("id") and lns_job["id"] == j["id"]:
            return lns_job["state"]
    return None


# Brakes that hold even if the matching above ever breaks again. All are on disk before a send.
#  - jobs per step: 2 register runs, 3 per entry (a register run is one commit and up to 4 reveals, so this alone
#    doesn't bound what is billed; the next two do)
#  - transactions billed: the account's nonce since the first paid send (each transaction in a block moves it, failed
#    or not), at most LNS_FLOW_TX_CAP
#  - LEZ billed: each of those transactions counted at the most it can cost (its kind's gas limit at the fee ceiling
#    taken before the first paid send, plus bytes), at most the expected cost plus one failed register transaction
#  - at least LNS_FLOW_GAP between two sends of one flow
# None of them reads the balance (LEZ arriving would hide what was spent); an unknown nonce or fee means no send.
LNS_FLOW_CAPS = {"register": 2, "blockchain": 3, "msg": 3}
LNS_FLOW_TX_CAP = {"register": 6, "link": 4}
LNS_RUN2_QUIET = float(os.environ.get("LNS_RUN2_QUIET", str(31 * 60)))     # the nonce still this long before a second
                                                                            # register run: longer than the wallet's own
                                                                            # wait for a block (60 x 30 s)   # commit, reveal, two entries; register mode two more for retries
LNS_FLOW_GAP = float(os.environ.get("LNS_FLOW_GAP", "60"))    # seconds at least between two sends of one flow
LNS_FLOW_RESOLVE_EVERY = [float(x) for x in os.environ.get("LNS_FLOW_RESOLVE_EVERY", "60,600").split(",")]
lns_flow_mem = {"mono": None, "next_mono": 0.0, "resolves": 0, "last_resolve": -1e9, "last_send_mono": -1e9, "unsaved": 0.0}


def lns_flow_tx_max(fl, kind):
    """The most one transaction of `kind` can be billed, at the fee ceiling taken for this flow."""
    ce, cs = fl["fee_ceil"]
    return LNS_GAS["register" if kind == "register" else "text"] * ce + LNS_RESERVE_BYTES * cs


def lns_flow_settle(fl, nonce):
    """Adds to what the flow has been billed (at most) the transactions in blocks since it last looked, counted as
    the kind of its last job (none of the person's own LEZ Sends run meanwhile: they are refused)."""
    seen = fl.get("nonce_seen")
    if seen is None or nonce <= seen:
        return
    # the kind of the job that was sent last: what landed since was its (the person's own sends are refused meanwhile);
    # kept on its own, so clearing the job between steps doesn't turn entries into register transactions
    kind = fl.get("billing_kind") or (fl.get("job") or {}).get("kind") or "register"
    delta = nonce - seen
    # an entry job sends one transaction: more than the entries sent since the last count (a late register
    # transaction) are counted at the register limit
    texts = min(delta, fl.get("texts_unsettled", 0)) if kind == "text" else 0
    fl["billed"] = fl.get("billed", 0) + texts * lns_flow_tx_max(fl, "text") + (delta - texts) * lns_flow_tx_max(fl, "register")
    fl["texts_unsettled"] = 0
    fl["nonce_seen"] = nonce


def lns_flow_budget(fl):
    """The most the flow may be billed: what it should cost at the fee ceiling (all its transactions at their full
    limits), plus one failed register transaction."""
    r, t = lns_flow_tx_max(fl, "register"), lns_flow_tx_max(fl, "text")
    return (2 * r if fl["mode"] == "register" else 0) + 2 * t + r


def lns_flow_brake(fl, step, nonce):
    """Why nothing may be sent now for `step` (a line for the person, or "wait"), or None."""
    sends = fl.setdefault("sends", {})
    if sends.get(step, 0) >= LNS_FLOW_CAPS[step]:
        return "it was sent %d times without taking; Try again to start over" % sends[step]
    mono, now = lns_boot_clock(), time.time()
    if fl.get("last_send_at", 0) > now:      # a clock set back: the last send counts from now, once
        fl["last_send_at"] = now
        lns_flow_save(fl)
    if mono - lns_flow_mem["last_send_mono"] < LNS_FLOW_GAP or now - fl.get("last_send_at", 0) < LNS_FLOW_GAP:
        return "wait"
    if nonce - fl["nonce_start"] >= LNS_FLOW_TX_CAP[fl["mode"]]:
        return "%d of its transactions are in blocks already; Try again to start over" % (nonce - fl["nonce_start"])
    if fl.get("billed", 0) >= lns_flow_budget(fl):
        return "it may have been billed up to %s LEZ already; Try again to start over" % fmt_int(fl["billed"])
    return None


def lns_commit_saved(name):
    """Whether `names` saved a commitment for `name` (names.json "pending"), so a new register resumes it rather than
    paying another commit."""
    try:
        with open(os.path.join(LNS_HOME, "names.json")) as f:
            d = json.load(f)
        p_ = (d.get("pending") or {}).get(name) or {}
        acct = lns_state()["account"] or ""
        made = int(p_.get("made", 0))
        # as `names register` resumes one: this account's, and less than a day old (MAX_COMMIT_AGE_MS)
        return p_.get("owner") in (acct, "Public/" + acct) and bool(p_.get("secret")) and time.time() * 1000 < made + 24 * 3600 * 1000
    except Exception:
        return False


def lez_nonce(account, timeout=10):
    """The account's nonce on LEZ (how many of its transactions are in blocks), or None when not known."""
    try:
        r = lez_rpc("getAccountsNonces", [[account]], timeout=timeout)
        return int(r[0]) if isinstance(r, list) and r and str(r[0]).isdigit() else None
    except Exception:
        return None


def lns_flow_pause(fl, secs):
    """A pause before the next look: on the monotonic clock in this process (a clock set back can't stretch it), and
    as a time on disk for after a restart."""
    fl["next_at"] = time.time() + secs
    lns_flow_mem["next_mono"] = lns_boot_clock() + secs
    lns_flow_save(fl)


def lns_flow_read_wait(fl, why, key="read_waits"):
    """Something couldn't be read (the chain, a nonce, a fee, a balance): wait (a growing pause), and after the last,
    stop with Try again. Every such wait counts (in `key`: the name service's reads, or what a send needs); nothing
    is sent on a guess."""
    n = fl.get(key, 0)
    if n >= len(LNS_FLOW_READ_WAITS):
        return lns_flow_fail(fl, fl["step"], why, final=True)
    fl[key] = n + 1
    lns_flow_pause(fl, LNS_FLOW_READ_WAITS[n])


def lns_flow_resolve_ok():
    """Whether the flow may run another `names resolve` (Argon2) now: once a minute, and after five with no step
    taken, once every ten minutes. Kept in memory, so it holds even when nothing can be written."""
    mono = lns_boot_clock()
    every = LNS_FLOW_RESOLVE_EVERY[0] if lns_flow_mem["resolves"] < 5 else LNS_FLOW_RESOLVE_EVERY[1]
    if mono - lns_flow_mem["last_resolve"] < every:
        return False
    lns_flow_mem["resolves"] += 1
    lns_flow_mem["last_resolve"] = mono
    return True


def lns_flow_start_job(fl, kind, fn, arg):
    step = fl["step"]
    nonce = lez_nonce(fl["account"])
    if nonce is None:                         # the nonce counts what is billed: without it, nothing is sent
        return lns_flow_read_wait(fl, "the name service can't be read; tap Try again later", "send_waits") and False
    if fl.get("fee_ceil") is None:            # before the first paid send: the fee ceiling and the nonce to count from
        fees = lns_fee_state()
        if fees is None:
            return lns_flow_read_wait(fl, "the fees can't be read; tap Try again later", "send_waits") and False
        bal = lns_balance(fl["account"])
        fl.update(fee_ceil=[fees[0], fees[1]], nonce_start=nonce, nonce_seen=nonce, billed=0,
                  bal_start=int(bal) if bal is not None else None)
    lns_flow_settle(fl, nonce)
    why = lns_flow_brake(fl, step, nonce)
    if why == "wait":
        lns_flow_pause(fl, 5)
        return False
    if why:
        lns_flow_fail(fl, step, why, final=True)
        return False
    fl["send_waits"] = 0
    fl["billing_kind"] = kind
    fl.pop("quiet", None)
    if kind == "text":
        fl["texts_unsettled"] = fl.get("texts_unsettled", 0) + 1
    jid = secrets.token_hex(8)
    prev_send = fl.get("last_send_at", 0)
    fl["job"] = {"kind": kind, "id": jid, "entry": step if kind == "text" else None, "nonce": nonce}
    fl["sends"][step] = fl["sends"].get(step, 0) + 1
    fl["last_send_at"] = time.time()
    lns_flow_save(fl)                         # on disk before the signer is started
    lns_flow_mem["last_send_mono"] = lns_boot_clock()
    code, reply = fn(arg, job_id=jid)
    if code == 409 and (reply.get("error") == LNS_BUSY or reply.get("already")):
        fl["sends"][step] -= 1                # nothing ran: the time of the last real send stays
        fl["last_send_at"] = prev_send
        if reply.get("already"):
            fl["job"] = None
        lns_flow_save(fl)
        return "already" if reply.get("already") else False
    if code == 200:
        return True
    lns_flow_fail(fl, step, reply.get("error", "it didn't start"))
    return False


def lns_flow_round():
    """One look at the flow: moves it on as far as it can now. Never runs two changes at once."""
    with lns_flow_lock:
        return lns_flow_round_locked()


def lns_flow_round_locked():
    fl = lns_flow_load()
    if not fl:
        return
    if fl["step"] in ("done", "failed"):
        return                                # done; the msg entry later is one tap (Messages > Name / Your name)
    now, mono, mem = time.time(), lns_boot_clock(), lns_flow_mem
    # time the flow has run, on the monotonic clock, added up on disk: setting the clock back can't stretch a limit
    # (saved every round, so none of it is lost). It counts only while the app runs, so the wall clock is the
    # backstop: either one past a limit stops the flow (a clock jumped forward stops it early: one more tap). A start
    # time in the future (a clock set back) is taken as now, once, so stretching a limit needs both clocks fooled.
    for key in ("started", "fund_since"):
        if fl.get(key) and fl[key] > now:
            fl[key] = now
    if mem["mono"] is not None:
        d = max(0.0, mono - mem["mono"])
        fl["elapsed"] = fl.get("elapsed", 0) + d
        if fl["step"] == "fund":
            fl["fund_elapsed"] = fl.get("fund_elapsed", 0) + d
        if d > 0:
            mem["unsaved"] += d                # forced to disk every two minutes; every send is forced anyway
            sync = mem["unsaved"] > 120
            if sync:
                mem["unsaved"] = 0.0
            lns_flow_save(fl, sync=sync)
    mem["mono"] = mono
    with lns_lock:
        job_running = lns_job["state"] == "running"
    # the limits first, whatever pause is set: a flow waiting out a pause stops at its limit all the same
    if not job_running and (fl.get("elapsed", 0) > LNS_FLOW_MAX or now - fl.get("started", now) > LNS_FLOW_MAX):
        return lns_flow_fail(fl, fl["step"], "it has run for two days; Try again to start over", final=True)
    if fl["step"] == "fund" and fl.get("fund_since") and (fl.get("fund_elapsed", 0) > LNS_FLOW_FUND_MAX or now - fl["fund_since"] > LNS_FLOW_FUND_MAX):
        return lns_flow_fail(fl, "fund", "waited a day for LEZ; Try again to start over", final=True)
    if mem["next_mono"]:                      # a pause set in this process: the boot clock decides
        if mono < mem["next_mono"]:
            return
    else:                                     # after a restart: the time on disk; one over an hour away (a clock
        if fl.get("next_at", 0) - now > 3600: # set back) is dropped
            fl["next_at"] = 0
        if now < fl.get("next_at", 0):
            return
    with lns_lock:
        if lns_job["state"] == "running":
            return
    st = lns_state()
    if fl["step"] != "account" and fl.get("account") and st["account"] != fl["account"]:
        return lns_flow_fail(fl, fl["step"], "the name account changed (a restore?); start again", final=True)
    if fl["step"] in ("blockchain", "msg") and st["name"] != fl["name"]:
        return lns_flow_fail(fl, fl["step"], "the name this phone holds changed; start again", final=True)
    step = fl["step"]

    if step == "account":
        if not st["account"]:
            code, reply = lns_make_account()
            if code == 409 and reply.get("error") == LNS_BUSY:
                return
            if code != 200:
                return lns_flow_fail(fl, step, reply.get("error", "the name account couldn't be made"),
                                     final=bool(reply.get("saved_copy")))
            st = lns_state()
        fl["account"] = st["account"]
        if fl["mode"] == "link":
            if not lns_flow_resolve_ok():
                return
            held = lns_flow_holds(fl["name"], fl["account"])
            if held is None:
                return lns_flow_fail(fl, step, "the name service didn't answer; trying again")
            if not held:
                return lns_flow_fail(fl, step, "this phone doesn't hold %s" % fl["name"], final=True)
            lns_state_save(name=fl["name"])
            return lns_flow_next(fl, "blockchain")
        return lns_flow_next(fl, "fund")

    if step == "fund":
        if not fl.get("fund_since"):
            fl["fund_since"] = now
        if fl.get("fund_elapsed", 0) > LNS_FLOW_FUND_MAX or now - fl["fund_since"] > LNS_FLOW_FUND_MAX:
            return lns_flow_fail(fl, step, "waited a day for LEZ; Try again to start over", final=True)
        need, bal = lns_flow_need(fl["name"]), lns_balance(fl["account"])
        fl["checked_at"] = time.time()        # when the balance was last asked (someone looking asks again after 10 s)
        if need is None or bal is None:       # not known: wait, never go on as if there were enough
            return lns_flow_pause(fl, 2 if fl.get("elapsed", 0) < 120 else 60)
        if need is not None and int(bal) < need:
            # checked again until it is there: a minute apart (a bridge can take hours; the page wakes it sooner)
            fl["short"] = str(need - int(bal))
            return lns_flow_pause(fl, 60)
        fl["short"] = None
        return lns_flow_next(fl, "register")

    if step == "register":
        ended = lns_flow_job(fl, "register")
        if ended == "running":
            return
        if lns_state()["name"] == fl["name"]:
            return lns_flow_next(fl, "blockchain")
        if not lns_flow_resolve_ok():         # at most one Argon2 read a minute (then every ten), whatever else fails
            return
        held = lns_flow_holds(fl["name"], fl["account"])          # a reveal that landed late counts
        if held:
            lns_state_save(name=fl["name"], reg_pending="")
            return lns_flow_next(fl, "blockchain")
        if held is None:
            return lns_flow_read_wait(fl, "the name service can't be read; tap Try again later")
        fl["read_waits"] = 0                  # a good read: earlier passing failures don't add up
        if ended == "failed":
            with lns_lock:
                err = lns_job["error"]
            fl["job"] = dict(fl["job"], ended=True)   # its result is used once; its nonce stays for the check below
            # a reveal that fails on chain is billed its whole limit: tried once more, not four times
            return lns_flow_fail(fl, step, err, final=any(f in err for f in LNS_FLOW_FINAL) or fl.get("tries", 0) >= 1)
        prev = fl.get("job")
        if prev and prev.get("nonce") is not None:
            # a register was sent before (it failed, or the app stopped while it ran): if any of the account's
            # transactions landed since, its commit may be in a block with its secret lost. Sending again would pay
            # a second commit, so it stops and says so instead.
            n = lez_nonce(fl["account"])
            if n is None:
                return lns_flow_read_wait(fl, "the name service can't be read; tap Try again later", "send_waits")
            if n > prev["nonce"] and not lns_commit_saved(fl["name"]):
                return lns_flow_fail(fl, step, "an earlier commit may have landed; Try again to start over (a new commit)", final=True)
            if prev.get("kind") == "register" and n - prev["nonce"] > 1:
                # the last run got past its commit (at least one reveal billed): one run is a commit and up to four
                # reveals, so a second run could bill four more. Only a run that landed its commit at most goes again.
                return lns_flow_fail(fl, step, "the last try sent %d transactions; Try again to start over" % (n - prev["nonce"]), final=True)
            if prev.get("kind") == "register":
                # and only once nothing of the first run can still be pending: the nonce has to hold still for longer
                # than the wallet waits for a block, and the name is read again after that (above, each round)
                # (counted on the boot clock, so a clock set forward can't cut it short; after a reboot it starts over)
                q = fl.get("quiet") or {}
                now_b = lns_boot_clock()
                if q.get("n") != n or not 0 <= now_b - q.get("since", now_b + 1):
                    fl["quiet"] = {"n": n, "since": now_b}
                    return lns_flow_pause(fl, min(60, LNS_RUN2_QUIET))
                if now_b - q["since"] < LNS_RUN2_QUIET:
                    return lns_flow_pause(fl, min(60, LNS_RUN2_QUIET))
        lns_flow_start_job(fl, "register", lns_register, {"name": fl["name"]})
        return

    if step in ("blockchain", "msg"):
        if step == "msg":
            mk = msg_key_load()
            if not mk:                        # Messages is off: done; when it is on, one tap sets this (unlocked)
                fl["msg_later"] = True
                return lns_flow_next(fl, "done")
            want = mk["public"]
        else:
            want = fl.get("main")
        ended = lns_flow_job(fl, "text")
        if ended == "running":
            return
        if not lns_flow_resolve_ok():
            return
        texts = lns_entries_read(fl["name"])
        if texts is None:                     # not readable now: never sent on a guess; read again later, then stop
            return lns_flow_read_wait(fl, "the name service can't be read; tap Try again later")
        fl["read_waits"] = 0
        if texts.get(step) == want:
            if step == "msg":
                mk = msg_key_load()
                if mk and mk.get("name") != fl["name"]:
                    mk["name"] = fl["name"]   # the name service has it: messages go out under the name
                    msg_key_save(mk)
            return lns_flow_next(fl, "msg" if step == "blockchain" else "done")
        if ended in ("failed", "done") and (fl.get("job") or {}).get("entry") == step:
            with lns_lock:
                err = lns_job["error"]
            fl["job"] = None
            # "done" but not on chain: it was included and didn't take (billed): never sent again by itself
            return lns_flow_fail(fl, step, err or "it was included but didn't take effect",
                                 final=ended == "done" or any(f in err for f in LNS_FLOW_FINAL))
        if step == "blockchain" and want != next((k["key"] for k in wallet_keys() if k["label"] == "Main"), None):
            return lns_flow_fail(fl, step, "this wallet's address changed; start again", final=True)
        r = lns_flow_start_job(fl, "text", lns_text, {"entry": step})
        if r == "already":
            lns_entries_cache.pop(fl["name"], None)


def lns_flow_loop():
    while True:
        try:
            lns_flow_round()
        except Exception:
            pass
        lns_flow_wake.wait(LNS_FLOW_POLL)
        lns_flow_wake.clear()


def lns_fingerprint():
    """A hash of what a backup must hold of the name account now: its wallet files, account and name."""
    h = hashlib.sha256()
    for f in LNS_FILES:
        try:
            with open(os.path.join(LNS_HOME, f), "rb") as src:
                h.update(hashlib.sha256(src.read()).digest())
        except Exception:
            h.update(b"-")
    st = lns_state()
    h.update(json.dumps([st["account"], st["name"]]).encode())
    return h.hexdigest()


def lns_backed_up():
    """lns_fingerprint() as it was at the last backup that carried the name account, or None."""
    try:
        with open(BACKUP_STATE_FILE) as f:
            v = json.load(f).get("lns")
        return v if isinstance(v, str) else None
    except Exception:
        return None


LNS_BACKUP_BUSY = "A change to your name account is running. Back up when it has finished."


def lns_backup():
    """The LNS name account for an encrypted backup: the LEZ wallet file (it holds the key), names.json (names
    and any registration in progress) and the public facts, labelled with the account the signer finds in the
    file. None when there is none, or outside the Android app. "busy" while a change runs: the signer may be
    rewriting the files, so they are neither read nor repaired then."""
    if not EMBEDDED or not os.path.isfile(lns_storage()):
        return None
    if not lns_change.acquire(blocking=False):
        return "busy"
    try:
        with lns_lock:
            if lns_job["state"] == "running":
                return "busy"
        lns_repair()
        with open(lns_storage(), "rb") as f:
            storage = f.read().decode("utf-8")
        names_file = os.path.join(LNS_HOME, "names.json")
        names = None
        if os.path.isfile(names_file):
            with open(names_file, "rb") as f:
                names = f.read().decode("utf-8")
        st = lns_state()
        found = lns_accounts_in(LNS_HOME) if lns_available() else [st["account"]]
        unconfirmed = False
        if found is None or lns_main_of(found, st["account"]) is None:
            # the signer couldn't list it: the files still go along, under the state's account, marked as such
            # (a backup never leaves out a name account the phone has)
            account, unconfirmed = st["account"], True
        else:
            account = lns_main_of(found, st["account"])
        lw = {"storage": storage, "names": names, "account": account,
              "name": st["name"] if account == st["account"] else ""}
        if unconfirmed:
            lw["unconfirmed"] = True
        if not lns_backup_valid(lw):
            return None                           # never a part that restore would refuse
        lw["fingerprint"] = lns_fingerprint()     # what this backup holds, taken with the lock held
        return lw
    except Exception:
        return None
    finally:
        lns_change.release()


def lns_backup_valid(lw):
    try:
        return (isinstance(lw, dict) and isinstance(lw.get("storage"), str) and 0 < len(lw["storage"]) <= LNS_BACKUP_MAX
                and isinstance(json.loads(lw["storage"]), dict)
                and (lw.get("names") is None or (isinstance(lw["names"], str) and len(lw["names"]) <= LNS_BACKUP_MAX
                                                 and isinstance(json.loads(lw["names"]), dict)))
                and lns_account_ok(lw.get("account"))
                and (lw.get("name") in (None, "") or lns_name_ok(lw.get("name"))))
    except Exception:
        return False


def lns_keep_aside(path, stamp):
    """Keeps the file at `path` as <path>.replaced-<stamp>, written out to disk before anything replaces it."""
    if not os.path.isfile(path):
        return
    with open(path, "rb") as f:
        before = f.read()
    fd = os.open(path + ".replaced-" + stamp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(before)
        f.flush()
        os.fsync(f.fileno())


def lns_restore(lw, replace=False):
    """Puts the LNS name account from a backup in place (Android app only). Accounts are compared, not files.
    Returns (outcome, message for the person):
      "added"     none was here; the backup's is in place
      "same"      the backup holds this phone's account; this phone's files are kept (they are the newer copy)
      "kept"      a different account is here and `replace` wasn't asked: nothing changed
      "replaced"  only with `replace`: the files that were here are kept beside them as *.replaced-<stamp>
      "busy"      a change is running: nothing changed
      "unchecked" the signer couldn't confirm the backup's account is in its wallet file: nothing changed
      "failed"    something went wrong part way; the next start puts the state right (lns_reconcile)"""
    if not EMBEDDED or not lns_backup_valid(lw):
        return "unchecked", "The name account in this backup couldn't be checked, so it wasn't restored."
    if not lns_change.acquire(blocking=False):
        return "busy", "The name account wasn't restored: a change to it is running. Restore again when it has finished."
    try:
        with lns_lock:
            if lns_job["state"] == "running":
                return "busy", "The name account wasn't restored: a change to it is running. Restore again when it has finished."
        if not lns_available():
            return "unchecked", "The name account in this backup couldn't be checked here, so it wasn't restored."
        if lns_flow_busy():                   # getting a name is between two of its changes
            return "busy", "The name account wasn't restored: getting a name is under way. Restore again when it has finished."
        with bridge_lock:
            b = bridge_load()
        if b and b["state"] in BRIDGE_ACTIVE:     # a deposit is on its way to this account
            return "busy", "The name account wasn't restored: a bridge to it is under way. Restore again when it is in a block."
        lns_lockdown()
        lns_repair()
        if lns_saved_copy():                  # the key is only in the copy: nothing may replace or set it aside
            return "unchecked", LNS_SAVED_COPY
        new = lw["storage"].encode("utf-8")
        path = lns_storage()
        here_st = lns_state()
        here = None
        if os.path.isfile(path):
            found_here = lns_accounts_in(LNS_HOME)
            here = lns_main_of(found_here, here_st["account"])
            if here is None:                  # the signer couldn't read this phone's own file: never "different"
                return "unchecked", "Couldn't read this phone's name account right now. Nothing was changed. Try again."
        # the signer itself must find the backup's account in the backup's wallet file, before anything changes
        in_backup = lns_accounts_of(new)
        if in_backup is None:
            return "unchecked", "The backup's name account couldn't be checked right now. Nothing was changed. Try again."
        if lw["account"] not in in_backup:
            return "unchecked", "The name account written on this backup isn't in its wallet file, so it wasn't restored."
        names_path = os.path.join(LNS_HOME, "names.json")
        incoming_names = (lw["names"] if lw.get("names") is not None else "{}").encode("utf-8")
        if here == lw["account"]:
            changes = {"restoring": None}         # a marker left by a stop is settled by this
            if here_st["account"] != here:        # the state had lost it: put it back, nothing else
                changes["account"] = here
            if not here_st["name"] and lw.get("name"):
                changes["name"] = lw["name"]
            if here_st.get("names_pending") == hashlib.sha256(incoming_names).hexdigest():
                # a restore of this backup was stopped between its two swaps: its names.json goes in place now
                lns_keep_aside(names_path, "%s-%s" % (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()), secrets.token_hex(3)))
                lns_write(names_path, incoming_names)
                changes["names_pending"] = ""
            lns_state_save(**changes)
            return "same", ("The backup holds this phone's own name account (%s). This phone's copy was kept: it is the "
                            "same account, and this phone's copy is the newer one." % lw["account"])
        if here is not None and not replace:
            return "kept", ("This backup holds a different name account (%s) from the one on this phone (%s). The one on "
                            "this phone was kept, and nothing about it changed. To use the backup's instead, restore again "
                            "and tick \"Replace this phone's name account\"." % (lw["account"], here or "an account this app can't read"))
        stamp = "%s-%s" % (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()), secrets.token_hex(3))
        # the state first, with a marker that names what was really in the file (`here`, as the signer read it):
        # a stop before the files are swapped is undone at the next start, and one between the two swaps is told
        lns_state_save(account=lw["account"], name=lw.get("name") or "", names_pending="",
                       restoring={"account": here, "name": here_st["name"] if here == here_st["account"] else "",
                                  "names": hashlib.sha256(incoming_names).hexdigest()})
        lns_keep_aside(path, stamp)
        lns_keep_aside(names_path, stamp)             # what was here stays beside it, names.json too
        for f in LNS_FILES:                           # and its saved copies: kept, not overwritten below
            lns_keep_aside(os.path.join(LNS_HOME, f + ".prev"), stamp)
        lns_write(path, new)
        lns_write(names_path, incoming_names)
        for f in LNS_FILES:                           # snapshots of the other account are no use now
            lns_write(os.path.join(LNS_HOME, f + ".prev"), open(os.path.join(LNS_HOME, f), "rb").read())
        lns_state_save(restoring=None)
        if here is None:
            return "added", "The name account from the backup (%s) is on this phone now." % lw["account"]
        return "replaced", ("This phone now uses the name account from the backup (%s). The one it had (%s) is kept "
                            "on this phone as a file, but it is no longer in new backups, and any name it holds can't be "
                            "changed from this phone." % (lw["account"], here or "an account this app couldn't read"))
    except Exception:
        try:
            lns_reconcile()                       # the state names what is really in the wallet file
        except Exception:
            pass
        return "failed", ("The name account couldn't be restored: something went wrong part way. The app puts it right "
                          "the next time it starts; then restore again.")
    finally:
        lns_change.release()


def lns_forward(raw):
    """(http status, bytes or object) for one call of `names` to the sequencer, forwarded over HTTPS."""
    try:
        body = json.loads(raw)
    except Exception:
        return 400, {"error": "bad request"}
    calls = body if isinstance(body, list) else [body]
    if not calls or len(calls) > 64 or not all(isinstance(c, dict) and isinstance(c.get("method"), str)
                                               and c["method"] in LNS_RPC_METHODS for c in calls):
        return 403, {"error": "That method isn't forwarded."}
    if any(c["method"] == "sendTransaction" for c in calls):
        with lns_lock:                        # the running change has handed something to the sequencer
            if lns_job["state"] == "running":
                lns_job["relayed"] = True
    try:
        code, data = fetch_outside(NAMES_RPC_URL, body, cap=16 * 1048576, timeout=60)
    except Exception:
        return 502, {"error": "The name service isn't answering."}
    return code, data


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


# A transfer the node gave no answer about (a timeout, or an answer cut short) may still have gone through. Until
# the key's balance shows a change, or SEND_UNSURE_HOLD seconds pass, the next send from that key is refused rather
# than risk sending twice (review E5). key -> {"before": balance then, "at": time}
SEND_UNSURE_HOLD = float(os.environ.get("SEND_UNSURE_HOLD_SECONDS", "180"))
send_unsure = {}


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
    if EMBEDDED and bridge_busy_key(frm):
        return 409, {"error": "This account is moving coins to your name account. Send from it once that is in a block (a minute or so)."}
    st = node_status()
    if not st or st.get("state") != "Online":
        return 409, {"error": "The node is not online yet, so it can't send. Wait until it has finished syncing."}
    bal = balance_of(frm)
    if bal is None:
        return 502, {"error": "The node didn't return a balance for that key."}
    before = bal[0]
    with lock:
        hold = send_unsure.get(frm)
        if hold and (time.time() - hold["at"] > SEND_UNSURE_HOLD or before != hold["before"]):
            send_unsure.pop(frm, None)             # it landed (the balance moved) or it's long enough: free
            hold = None
    if hold:
        return 409, {"error": "The last transfer from this account got no answer from the node and may still go through. "
                              "Check Activity; you can send again once its balance changes or in about %d minutes."
                              % max(1, round((SEND_UNSURE_HOLD - (time.time() - hold["at"])) / 60)), "unsure": True}
    if before < amount:
        return 400, {"error": "That key holds %d, less than %d." % (before, amount)}
    code, reply = node("/wallet/transactions/transfer-funds", {
        "tip": None, "change_public_key": frm, "funding_public_keys": [frm],
        "recipient_public_key": to, "amount": amount}, timeout=60)
    # the node answers an accepted transfer with 201 Created
    if code == 0:
        # no answer, or one cut short: the transfer may have gone through, so don't invite a second one
        with lock:
            send_unsure[frm] = {"before": before, "at": time.time()}
        return 502, {"error": "No answer from the node about this transfer: it may have been sent. Check Activity and "
                              "the balance before sending again.", "unsure": True}
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


def _fsync_write(path, data):
    """Writes `data` (bytes) to `path` through a temporary file, synced before and after the rename, so a power
    cut leaves either the old file or the new one, never an empty one."""
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path + ".tmp", path)
    try:
        dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except Exception:
        pass


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


def store_aside(why, out=None):
    """Moves the store file (readable or not) aside under a name of its own (never over another file kept aside),
    and starts an empty one (the caller holds msg_lock). Returns the new rev; `out`, a dict, gets "aside": the
    name it was moved to (None when there was no file)."""
    name = None
    if os.path.exists(STORE_FILE):
        # a rename (never a hard link: Android forbids those to apps), under msg_lock, to a name nothing has
        name = _aside_name(why)
        os.rename(STORE_FILE, name)
    if out is not None:
        out["aside"] = name
    rev = int(time.time() * 1000)
    _fsync_write(STORE_FILE, json.dumps({"rev": rev, "blob": None}).encode())
    return rev


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
            if os.path.exists(STORE_FILE):
                os.rename(STORE_FILE, _aside_name("unreadable"))
            rev = int(time.time() * 1000)
            _fsync_write(STORE_FILE, json.dumps({"rev": rev, "blob": prev["blob"]}).encode())
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
        if EMBEDDED:
            lns_flow_wake.set()
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


def restore_backup(doc, password, replace_lns=False):
    """(http status, reply, event detail). Puts the key file from a backup in place of the node's own,
    only after the node itself has checked it, and keeps the old one beside it."""
    if not isinstance(doc, dict) or doc.get("format") != BACKUP_FORMAT or doc.get("version") not in BACKUP_AADS \
            or isinstance(doc.get("version"), bool):
        return 400, {"error": "This isn't a wallet backup from this app, or it's a version this app can't read."}, "format"
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
        lns_w = content.get("lns_wallet")
        if lns_w is not None and not lns_backup_valid(lns_w):
            raise ValueError
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
    # the phone's LNS name account, if the backup has one (Android app only); a different one already here
    # is replaced only when the person asked for that (replace_lns)
    lns_out, lns_msg = lns_restore(lns_w, replace_lns) if lns_w is not None else (None, "")
    lns_done = lns_out in ("added", "replaced")
    lns_reply = {"lns_restored": lns_done, "lns": lns_out, "lns_message": lns_msg} if lns_out else {}
    lns_why = ", lns " + lns_out if lns_out else ""
    if reported == current:
        before, changed = msg_key_restore_with_store(msg_key, chat) if msg_key else ((msg_key_load() or {}).get("secret"), False)
        if msg_key and changed:
            n = chat_restore(chat, before != msg_key["secret"]) if chat and messaging_on() else 0
            return 200, dict(lns_reply, unchanged=True, messaging_key_restored=True, messages_restored=n,
                             message="These are the wallet keys already in use. The messaging key from the backup is back in place."), "same keys, messaging key" + lns_why
        n = chat_restore(chat, False) if chat and messaging_on() else 0
        if n:
            return 200, dict(lns_reply, unchanged=True, messages_restored=n,
                             message="These are the keys this wallet already uses. Messages from the backup were added."), "same keys, messages" + lns_why
        if lns_out and lns_out != "same":
            return 200, dict(lns_reply, unchanged=True,
                             message="These are the keys this wallet already uses."), "same keys" + lns_why
        return 200, dict(lns_reply, unchanged=True, message="These are the keys this wallet already uses. Nothing was changed."), "same keys" + lns_why
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
    reply = dict(lns_reply, ok=True, restarted=restarted, addresses=len(reported), replaced=len(current))
    before, changed = msg_key_restore_with_store(msg_key, chat) if msg_key else ((msg_key_load() or {}).get("secret"), False)
    if msg_key and changed:
        reply["messaging_key_restored"] = True
    if chat and messaging_on():
        reply["messages_restored"] = chat_restore(chat, before != msg_key["secret"])
    if not restarted:
        reply["manual"] = restart_hint()
    return 200, reply, "restored"


def store_aside_for_new_key(before, msg_key, chat):
    """A restore brings another messaging key and no saved chats: the ones here can't be opened with the new key,
    so they are kept aside (STORE_FILE.other-key-<time>-<random>) and the page starts with empty ones. Returns the
    name they were moved to, or None."""
    if not messaging_on() or not before or before == msg_key.get("secret") or (isinstance(chat, dict) and chat.get("store")):
        return None
    out = {}
    with msg_lock:
        if os.path.exists(STORE_FILE):
            store_aside("other-key", out)
    return out.get("aside")


def msg_key_restore_with_store(msg_key, chat):
    """Puts a backup's messaging key in place together with what that means for the saved chats, so a failure
    half way can't leave the new key beside a store it can't open: when the key is another one and the backup
    brings no saved chats, the store is set aside first; if putting the key in place then fails (or changes
    nothing), the store is put back. Returns (the secret before, whether the key changed)."""
    before = (msg_key_load() or {}).get("secret")
    aside = None
    try:
        aside = store_aside_for_new_key(before, msg_key, chat)
    except Exception:
        event("saved chats couldn't be set aside for the restored messaging key")
    try:
        changed = msg_key_restore(msg_key)
    except Exception:
        changed = None
    if not changed and aside:
        with msg_lock:
            os.replace(aside, STORE_FILE)           # the key didn't change: the saved chats are this key's still
    if changed is None:
        raise RuntimeError("the messaging key couldn't be put in place")
    return before, changed


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
    lw = lns_backup()
    if lw == "busy":                          # the signer may be rewriting the name account's files right now
        return 409, {"error": LNS_BACKUP_BUSY, "lns_busy": True}, source
    fingerprint = lw.pop("fingerprint", None) if isinstance(lw, dict) else None
    if lw:                                    # the phone's LNS name account (Android app): its wallet file goes along
        content["lns_wallet"] = lw
    sealed = aead_encrypt(backup_key(password, salt), nonce, json.dumps(content).encode(), BACKUP_AADS[version])
    b64 = lambda b: base64.b64encode(b).decode()
    created = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        fd = os.open(BACKUP_STATE_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"last": created, "messaging": bool(mk),                # whether it holds the messaging key
                       # and which state of the name account (not one the signer couldn't confirm: asked again)
                       "lns": fingerprint if lw and not lw.get("unconfirmed") else None}, f)
        os.replace(BACKUP_STATE_FILE + ".tmp", BACKUP_STATE_FILE)
    except Exception:
        pass
    return 200, {"lns": ("unconfirmed" if lw.get("unconfirmed") else "included") if lw else None,
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


def net04():
    """The reader (made once), or None outside the Android app or if lez04.py can't load."""
    if not EMBEDDED:
        return None
    if not _net04:
        try:
            import lez04
            _net04.append(lez04.Net04(DATA_DIR, APP_DIR, lambda url, body, cap, timeout: fetch_outside(url, body, cap=cap, timeout=timeout)))
        except Exception:
            _net04.append(None)
    return _net04[0]


def net04_own():
    """The phone's own LEZ account id (base58), the same id on both networks; None without one."""
    try:
        import lez04
        a = lns_state()["account"] if lns_available() else None
        return lez04.account_id(a) if a else None
    except Exception:
        return None


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
        return (path in ("/", "/manifest.webmanifest", "/lns/lns.js", "/net04/net04.js", QR_FILE,
                         "/lambda-192.png", "/lambda-512.png", "/lambda-maskable-512.png")
                or bool(MESSAGES_FILE_RE.match(path)) or bool(NAMES_FILE_RE.match(path)))

    KEY_REFUSED = {"error": "this app only answers its own page", "app_key": False}

    # POSTs that are the user doing something; they count as activity for auto-lock. Everything the
    # page does on a timer (status, accounts, history, receipts, transfer status) does not.
    USER_ACTIONS = {"/api/wallet/activity", "/api/wallet/send", "/api/wallet/backup", "/api/wallet/restore",
                    "/api/wallet/settings", "/api/wallet/passkey/options", "/api/wallet/passkey/register",
                    "/api/wallet/passkey/remove", "/api/update/check", "/api/update/passkey/challenge",
                    "/api/update/apply", "/api/names/rpc", "/api/wallet/native-fingerprint",
                    "/api/messages/key", "/api/messages/name", "/api/messages/send", "/api/messages/inbox/delete",
                    "/api/messages/outbox", "/api/messages/outbox/retry", "/api/messages/outbox/delete",
                    "/api/messages/store", "/api/wallet/lns/account", "/api/wallet/lns/register",
                    "/api/wallet/lns/name", "/api/wallet/lns/text", "/api/wallet/lns/faucet",
                    "/api/wallet/lns/bridge", "/api/wallet/lns/bridge/cancel", "/api/wallet/lns/send",
                    "/api/wallet/lns/putback", "/api/wallet/lns/get", "/api/wallet/lns/get/retry", "/api/wallet/lns/get/stop"}
    LNS_ROUTES = ("/api/wallet/lns/account", "/api/wallet/lns/register", "/api/wallet/lns/name", "/api/wallet/lns/text",
                  "/api/wallet/lns/faucet", "/api/wallet/lns/bridge", "/api/wallet/lns/bridge/cancel", "/api/wallet/lns/send",
                  "/api/wallet/lns/putback", "/api/wallet/lns/get", "/api/wallet/lns/get/retry", "/api/wallet/lns/get/stop")

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
                if lns_available():               # Your name, only in the Android app with the signer
                    page = page.replace(b"</body>", b'<script src="/lns/lns.js"></script>\n</body>', 1)
                if net04():                       # the bridge test network (LEZ 0.4), read-only, in the Android app
                    page = page.replace(b"</body>", b'<script src="/net04/net04.js"></script>\n</body>', 1)
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
        if path == "/net04/net04.js":
            if not net04():
                return self.reply(404, {"error": "not found"})
            try:
                with open(os.path.join(APP_DIR, "net04", "net04.js"), "rb") as f:
                    return self.reply(200, raw=f.read(), ctype="text/javascript; charset=utf-8")
            except Exception:
                return self.reply(404, {"error": "not found"})
        if path == "/lns/lns.js":
            if not lns_available():
                return self.reply(404, {"error": "not found"})
            try:
                with open(os.path.join(APP_DIR, "lns", "lns.js"), "rb") as f:
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
                   "passkeys": len(passkeys_load()["keys"]), "names_program": NAMES_PROGRAM,
                   "autolock_minutes": wallet_settings["autolock_minutes"], "leave_grace": LEAVE_GRACE}
            if EMBEDDED:
                out.update(embedded="android", native_fingerprint=bool(wallet_settings.get("native_fingerprint")))
            return self.reply(200, out)
        if path == "/api/wallet/lns":
            if not lns_available():
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            return self.reply(200, lns_view())
        if path == "/api/wallet/net04":                # the bridge test network: read-only, never the money path
            n = net04()
            if not n:
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            own = net04_own()
            n.look(own)                                # reads again in the background, 30 s at most
            return self.reply(200, n.view(own))
        if path == "/api/wallet/lns/balance":          # the Wallet's LEZ row: the name account and its balance only
            if not lns_available():
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            acct = lns_state()["account"]
            return self.reply(200, {"account": acct, "balance": lns_balance(acct) if acct else None})
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

    def lez_rpc(self):
        """The forwarder for this app's own `names` child (android/NAMES.md, HTTPS): it has no Origin, so
        it is told a secret path instead. Anything else that reaches this address gets a plain 404."""
        secret = self.path.split("?", 1)[0][len("/lez-rpc/"):]
        if not lns_available() or not self.host_ok() or not hmac.compare_digest(secret.encode(), LNS_RPC_SECRET.encode()):
            return self.reply(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except Exception:
            n = -1
        if not 0 < n <= LNS_RPC_MAX:
            return self.reply(413 if n > LNS_RPC_MAX else 400, {"error": "bad request"})
        code, data = lns_forward(self.rfile.read(n))
        return self.reply(code, raw=data) if isinstance(data, bytes) else self.reply(code, data)

    def do_POST(self):
        if self.path.startswith("/lez-rpc/"):
            return self.lez_rpc()
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
            code, obj, why = restore_backup(body.get("backup"), str(body.get("password", "")),
                                            body.get("replace_name_account") is True)
            if obj.get("ok"):
                event("wallet restored", self, old_keys=obj["replaced"], new_keys=obj["addresses"],
                      node_restarted="yes" if obj["restarted"] else "no", lns=obj.get("lns") or "none")
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
        if path in self.LNS_ROUTES:
            # the phone's own LNS name: Android app only, with the signer bundled; same checks as Send
            if not lns_available():
                return self.reply(404, {"error": "not found"})
            if not self.authed():
                return self.reply(401, {"error": "locked"})
            if path == "/api/wallet/lns/account":
                code, obj = lns_make_account()
                if code == 200:
                    event("lns account made", self, account=obj["account"])
            elif path == "/api/wallet/lns/register":
                code, obj = lns_register(body)
                if code == 200:
                    event("lns register started", self, lns_name=str(body.get("name", "")).strip().lower())
            elif path == "/api/wallet/lns/name":
                code, obj = lns_link(body)
                if code == 200:
                    event("lns name linked", self, lns_name=obj["name"])
            elif path == "/api/wallet/lns/faucet":
                code, obj = lns_faucet()
                event("lns faucet " + ("paid" if code == 200 else "refused"), self, amount=obj.get("amount", ""))
            elif path == "/api/wallet/lns/bridge":
                code, obj = lns_bridge(body)
                if code == 200 and body.get("confirm") is True:
                    event("lns bridge started", self, amount=obj["plan"]["amount"], key=obj["plan"]["from"])
            elif path == "/api/wallet/lns/send":
                code, obj = lns_send(body)
                if code == 200 and body.get("confirm") is True:
                    event("lns send started", self, amount=obj["plan"]["amount"], to=obj["plan"]["to"])
            elif path == "/api/wallet/lns/get":
                code, obj = lns_get(body)
            elif path == "/api/wallet/lns/get/retry":
                code, obj = lns_flow_retry()
            elif path == "/api/wallet/lns/get/stop":
                code, obj = lns_flow_stop(body)
            elif path == "/api/wallet/lns/putback":
                code, obj = lns_putback()
            elif path == "/api/wallet/lns/bridge/cancel":
                code, obj = lns_bridge_cancel()
                if code == 200:
                    event("lns bridge stopped", self)
            else:
                code, obj = lns_text(body)
                if code == 200:
                    event("lns entry change started", self, entry=body.get("entry"))
            return self.reply(code, obj)
        return self.reply(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


def main():
    """Starts the app and serves until the process ends. The Android app imports this module and calls main()
    in a thread, so it can also call native_unlock() in the same process."""
    if EMBEDDED:
        event("app start", port=PORT, version=APP_VERSION, embedded="android")
        try:
            lns_sweep()                       # check folders a stopped restore left
            if os.path.isdir(LNS_HOME):
                lns_reconcile()               # a restore the app was stopped in the middle of
                lns_repair()                  # a change the app was stopped in the middle of
        except Exception:
            pass
        threading.Thread(target=bridge_loop, daemon=True).start()   # a bridge under way carries on after a restart
        threading.Thread(target=lns_flow_loop, daemon=True).start()  # so does getting a name
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

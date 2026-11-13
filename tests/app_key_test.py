#!/usr/bin/env python3
"""The app key (android/LOCAL-APIS.md): inside the Android app every request to the wallet server needs the
app_key cookie the app gives only its own WebView, except the page's public files and the names forwarder.

  python3 tests/app_key_test.py

Part 1 runs the app as the Android app does (APP_EMBEDDED=android, APP_KEY set) and calls it as another app on
the phone would: any Host, any Origin, no cookie. Part 2 checks that nothing changes without APP_KEY (Linux,
Termux). Part 3 checks that the key is not left in the environment the app's child processes inherit.
"""
import os, secrets, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

check = W.check
APP = os.path.join(HERE, "..", "app")
KEY = secrets.token_hex(32)
PIN = "864213"
PORT = 8096


def call(path, body=None, cookie=None, origin="", host=None, session=None):
    """wallet_test.call with a Cookie header."""
    import json, urllib.error, urllib.request
    base = "http://127.0.0.1:%d" % PORT
    origin = base if origin == "" else origin
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        if origin:
            req.add_header("Origin", origin)
    if cookie is not None:
        req.add_header("Cookie", cookie)
    if session:
        req.add_header("X-Session", session)
    if host:
        req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw, code = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    try:
        return code, json.loads(raw)
    except Exception:
        return code, {"raw": raw.decode(errors="replace")[:200]}


def start(env_extra):
    data = tempfile.mkdtemp()
    env = {k: v for k, v in os.environ.items() if k not in ("APP_EMBEDDED", "APP_KEY")}
    env.update(APP_PORT=str(PORT), APP_DATA=data, NODE_API="http://127.0.0.1:9", NODE_BIN="/nonexistent",
               UPDATE_URL="http://127.0.0.1:9/", **env_extra)
    p = subprocess.Popen([sys.executable, os.path.join(APP, "server.py")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    for _ in range(100):
        try:
            if call("/")[0] == 200:
                return p
        except Exception:
            pass
        time.sleep(0.1)
    p.terminate()
    check("the app starts", False)


GOOD = "app_key=" + KEY

# ---- part 1: inside the Android app, another app on the phone ------------------------------------------------
p = start({"APP_EMBEDDED": "android", "APP_KEY": KEY})
try:
    code, d = call("/")
    check("the page itself loads without the key (public file)", code == 200 and "raw" in d, code)
    code, _ = call("/names/names.js")
    check("the names resolver file loads without the key (public file)", code == 200, code)
    for path in ("/api/wallet", "/api/status", "/cryptarchia/info", "/network/info", "/api/wallet/accounts",
                 "/api/messages/key", "/api/messages/status", "/api/wallet/lns", "/wallet-events.log", "/nothing"):
        code, d = call(path)
        check("GET %s without the key is refused" % path, code == 403 and d.get("app_key") is False, (code, d))
    # first come, first served before: another app could set the PIN and get a session
    code, d = call("/api/wallet/setup", {"pin": "111111"}, host="127.0.0.1:%d" % PORT)
    check("another app can't set the first PIN (forged Host and Origin, no key)", code == 403 and "session" not in d, (code, d))
    wrong = {"zeros": "app_key=" + "0" * 64, "empty": "app_key=", "other name": "other=" + KEY,
             "one short": "app_key=" + KEY[:-1], "one long": "app_key=" + KEY + "0"}
    for what, cookie in wrong.items():
        code, d = call("/api/wallet/setup", {"pin": "111111"}, cookie=cookie)
        check("a wrong app key is refused (%s)" % what, code == 403, (code, d))
    for path, body in (("/api/wallet/unlock", {"pin": "000000"}), ("/api/wallet/lock", {}),
                       ("/api/wallet/send", {}), ("/api/wallet/visibility", {"state": "hidden"}),
                       ("/api/names/rpc", {}), ("/api/messages/send", {}), ("/api/wallet/passkey/challenge", {})):
        code, d = call(path, body)
        check("POST %s without the key is refused" % path, code == 403 and d.get("app_key") is False, (code, d))
    code, d = call("/lez-rpc/" + "ab" * 16, {"jsonrpc": "2.0"})
    check("the names forwarder still answers a wrong secret path with a plain 404", code == 404, (code, d))
    code, d = call("/api/wallet", cookie=GOOD)
    check("with the key the page's own calls work, and no PIN was set by the refused calls", code == 200 and d.get("pin_set") is False, (code, d))
    code, d = call("/api/wallet/setup", {"pin": PIN}, cookie="theme=dark; " + GOOD + "; other=1")
    check("with the key (among other cookies) the page sets the PIN", code == 200 and d.get("session"), (code, d))
    s = d["session"]
    code, d = call("/api/wallet/settings", {"autolock_minutes": 15}, session=s)
    check("a session alone is not enough without the key", code == 403, (code, d))
    code, d = call("/api/wallet/settings", {"autolock_minutes": 15}, cookie=GOOD, session=s)
    check("the session with the key works", code == 200 and d.get("autolock_minutes") == 15, (code, d))
    code, d = call("/api/wallet/settings", {"autolock_minutes": 15}, cookie=GOOD, session=s, origin="http://evil.example")
    check("the Origin check still applies with the key", code == 403, (code, d))
finally:
    p.terminate(); p.wait(timeout=10)

# ---- part 2: without APP_KEY (Linux, Termux) nothing changes -------------------------------------------------
p = start({})
try:
    code, d = call("/api/wallet")
    check("without APP_KEY the wallet answers without a cookie", code == 200 and d.get("pin_set") is False, (code, d))
    code, d = call("/api/wallet/setup", {"pin": PIN})
    check("without APP_KEY the PIN is set as before", code == 200 and d.get("session"), (code, d))
finally:
    p.terminate(); p.wait(timeout=10)

# ---- part 3: the key is not passed on to child processes -----------------------------------------------------
probe = ("import os, sys; os.environ.update(APP_EMBEDDED='android', APP_KEY=%r, APP_DATA=sys.argv[1]); sys.path.insert(0, sys.argv[2]); "
         "import server; print('key' if server.APP_KEY == %r else 'nokey', 'env' if 'APP_KEY' in os.environ else 'noenv')") % (KEY, KEY)
out = subprocess.run([sys.executable, "-c", probe, tempfile.mkdtemp(), APP], capture_output=True, text=True, timeout=60).stdout.split()
check("server.py takes APP_KEY and removes it from the environment its children inherit", out == ["key", "noenv"], out)

print("all checks passed")

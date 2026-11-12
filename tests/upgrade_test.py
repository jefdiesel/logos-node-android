#!/usr/bin/env python3
"""An app already on a phone updates itself to this release: the released app files of an older version
run as the installed app, and a local HTTP server offers this repository's app/ as the new release.

  python3 tests/upgrade_test.py <folder with the older version's app files>

The older app runs on 127.0.0.1:8099; this release is served at http://127.0.0.1:8766/app/.
"""
import functools, hashlib, http.server, json, os, subprocess, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

OLD, NEW = os.path.abspath(sys.argv[1]), os.path.join(HERE, "..", "app")
W.BASE = "http://127.0.0.1:8099"
call, check = W.call, W.check
PIN = "556677"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


repo = tempfile.mkdtemp()
os.symlink(os.path.abspath(NEW), os.path.join(repo, "app"))
threading.Thread(target=http.server.ThreadingHTTPServer(("127.0.0.1", 8766), functools.partial(Quiet, directory=repo)).serve_forever,
                 daemon=True).start()
with open(os.path.join(OLD, "release.json")) as f:
    old_version = json.load(f)["version"]
with open(os.path.join(NEW, "release.json")) as f:
    new = json.load(f)
app = subprocess.Popen([sys.executable, os.path.join(OLD, "server.py")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env=dict(os.environ, APP_PORT="8099", APP_DATA=tempfile.mkdtemp(), NODE_BIN="/nonexistent",
                                UPDATE_URL="http://127.0.0.1:8766/app/"))
try:
    for _ in range(80):
        try:
            if call("/api/status")[1].get("version") == old_version:
                break
        except Exception:
            pass
        time.sleep(0.1)
    check("the older app (%s) runs" % old_version, call("/api/status")[1].get("version") == old_version)
    s = call("/api/wallet/setup", {"pin": PIN})[1]["session"]
    code, d = call("/api/update/check", {}, session=s)
    check("it is offered this release (%s)" % new["version"], code == 200 and d.get("available") == new["version"] and not d.get("error"), d)
    code, d = call("/api/update/apply", {"pin": PIN}, session=s)
    check("and takes it: every file checks out against the release list", code == 200 and d.get("to") == new["version"], (code, d))
    for _ in range(60):
        time.sleep(0.5)
        try:
            if call("/api/status")[1].get("version") == new["version"]:
                break
        except Exception:
            pass
    check("it comes back as %s" % new["version"], call("/api/status")[1].get("version") == new["version"])
    for name, digest in new["files"].items():
        with open(os.path.join(OLD, name), "rb") as f:
            check("installed: " + name, hashlib.sha256(f.read()).hexdigest() == digest)
    s = W.unlock(PIN)
    check("the PIN still opens the wallet", call("/api/wallet", session=s)[1].get("unlocked") is True)
    print("all checks passed")
finally:
    app.terminate()
    app.wait(timeout=10)

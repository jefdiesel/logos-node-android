#!/usr/bin/env python3
"""The in-app update, against a local HTTP server standing in for the GitHub repository.

  APP_DIR=<the installed app folder> APP_PIN=<pin> [APP_DATA=<data folder>] [EVENTS_LOG=<file>] python3 tests/update_test.py

The app on 127.0.0.1:8090 must have been started with UPDATE_URL=http://127.0.0.1:8765/app/.
If no PIN is set yet, this sets APP_PIN.
"""
import functools, hashlib, http.server, json, os, re, shutil, subprocess, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

APP_DIR, PIN = os.environ["APP_DIR"], os.environ["APP_PIN"]
DATA = os.environ.get("APP_DATA", APP_DIR)
EVENTS = os.environ.get("EVENTS_LOG", os.path.join(DATA, "wallet-events.log"))
check, call = W.check, W.call


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def release(d):
    subprocess.run([sys.executable, os.path.join(HERE, "..", "tools", "release.py"), "write", "--dir", d], check=True, capture_output=True)


def installed():
    with open(os.path.join(APP_DIR, "release.json")) as f:
        files = json.load(f)["files"]
    return {n: sha(os.path.join(APP_DIR, n)) for n in files}


def prev_files():
    return [os.path.join(t, f) for t, _, fs in os.walk(APP_DIR) for f in fs if f.endswith(".prev")]


def version():
    return call("/api/status")[1].get("version")


def apply(s, pin=PIN):
    return call("/api/update/apply", {"pin": pin}, session=s)


# the stand-in repository: a copy of the installed app, served at http://127.0.0.1:8765/app/
repo = tempfile.mkdtemp()
app = os.path.join(repo, "app")
with open(os.path.join(APP_DIR, "release.json")) as f:
    for name in json.load(f)["files"]:
        os.makedirs(os.path.dirname(os.path.join(app, name)), exist_ok=True)
        shutil.copy2(os.path.join(APP_DIR, name), os.path.join(app, name))
release(app)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


Handler = functools.partial(Quiet, directory=repo)
threading.Thread(target=http.server.ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever, daemon=True).start()

code, d = call("/api/wallet")
if not d.get("pin_set"):
    call("/api/wallet/setup", {"pin": PIN})
s = W.unlock(PIN)
pk = W.FakePasskey()
code, o = call("/api/wallet/passkey/options", {}, session=s)
reg = {"id": W.b64u(pk.id), "publicKey": W.b64u(pk.spki), "authenticatorData": W.b64u(pk.auth_data()),
       "clientDataJSON": W.b64u(pk.client_data("webauthn.create", o["challenge"]))}
code, d = call("/api/wallet/passkey/register", reg, session=s)
check("a fingerprint key is set up before the update", code == 200 and d.get("passkeys", 0) >= 1, (code, d))
keys_before = d["passkeys"]
v0 = version()
print("     the app is at version", v0)

code, d = call("/api/update/check", {}, session=s)
check("no update is offered when the versions match", code == 200 and d.get("available") is None and d.get("current") == v0 and not d.get("error"), d)

v1 = ".".join(v0.split(".")[:-1] + [str(int(v0.split(".")[-1]) + 1)])
with open(os.path.join(app, "server.py")) as f:
    good_server = re.sub(r'^APP_VERSION = "[0-9.]+"', 'APP_VERSION = "%s"' % v1, f.read(), count=1, flags=re.M)
with open(os.path.join(app, "server.py"), "w") as f:
    f.write(good_server)
with open(os.path.join(app, "index.html"), "a") as f:
    f.write("<!-- update test %s -->\n" % v1)
release(app)
code, d = call("/api/update/check", {}, session=s)
check("a newer release is offered", code == 200 and d.get("available") == v1, d)
check("and the status shows it to the page", call("/api/status")[1].get("update", {}).get("available") == v1)

before = installed()
code, d = call("/api/update/apply", {"pin": PIN})
check("an update without an unlocked wallet is refused", code == 401, (code, d))
code, d = call("/api/update/apply", {}, session=s)
check("an update confirmed by neither PIN nor fingerprint is refused, without counting", code == 400 and d.get("malformed"), (code, d))
code, d = apply(s, "12")
check("an update with something that isn't a PIN is refused, without counting", code == 400 and d.get("malformed"), (code, d))
code, d = apply(s, "000000")
check("an update with a wrong PIN is refused, saying how many tries are left", code == 403 and isinstance(d.get("tries_left"), int) and "left" in d.get("error", ""), (code, d))


def fresh(path):
    """A fingerprint confirmation for the challenge `path` hands out."""
    code, c = call(path, {}, session=s)
    check("a fingerprint challenge is issued by " + path, code == 200 and c.get("challenge"), (code, c))
    return pk.assertion(c["challenge"])


code, d = call("/api/update/apply", {"assertion": fresh("/api/wallet/passkey/challenge")}, session=s)
check("a fingerprint confirmation made for unlocking can't confirm an update", code == 403, (code, d))
code, d = call("/api/wallet/passkey/unlock", fresh("/api/update/passkey/challenge"))
check("a fingerprint confirmation made for an update can't unlock", code == 401, (code, d))
code, d = call("/api/update/apply", {"assertion": dict(fresh("/api/update/passkey/challenge"), signature=W.b64u(b"0" * 70))}, session=s)
check("an update with a bad fingerprint signature is refused", code == 403, (code, d))
with open(EVENTS) as f:
    check("and the wrong PIN is logged", " update refused, wrong PIN " in f.read())

with open(os.path.join(app, "index.html"), "a") as f:          # changed after release.json was written
    f.write("<!-- not in the release list -->\n")
code, d = apply(s)
check("a release whose file doesn't match its hash is refused", code == 409 and "doesn't match" in d.get("error", ""), (code, d))
check("and nothing was replaced", installed() == before and not prev_files() and version() == v0, prev_files())

with open(os.path.join(app, "server.py"), "w") as f:
    f.write(good_server + "\ndef broken(:\n")
release(app)
code, d = apply(s)
check("a release with a Python syntax error is refused", code == 409 and "compile" in d.get("error", ""), (code, d))
check("and nothing was replaced", installed() == before and not prev_files() and version() == v0, prev_files())

with open(os.path.join(app, "server.py"), "w") as f:
    f.write(good_server)
with open(os.path.join(app, "index.html")) as f:
    page = f.read().replace("<!-- not in the release list -->\n", "")
with open(os.path.join(app, "index.html"), "w") as f:
    f.write(page)
release(app)
code, d = call("/api/update/apply", {"assertion": fresh("/api/update/passkey/challenge")}, session=s)
check("a good release is applied, confirmed by a fresh fingerprint confirmation", code == 200 and d.get("to") == v1, (code, d))
for _ in range(40):
    time.sleep(1)
    try:
        if version() == v1:
            break
    except Exception:
        pass
check("the app comes back reporting the new version", version() == v1, version())
with urllib.request.urlopen(W.BASE + "/", timeout=10) as r:
    check("the page it serves carries the new version", ('<meta name="app-version" content="%s">' % v1).encode() in r.read())
with open(os.path.join(repo, "app", "release.json")) as f:
    want = json.load(f)["files"]
check("every installed file is the release's", installed() == want)
for name in ("server.py", "index.html"):
    p = os.path.join(APP_DIR, name + ".prev")
    check("the previous %s is kept as %s.prev" % (name, name), os.path.exists(p) and sha(p) == before[name])
s2 = W.unlock(PIN)
code, d = call("/api/wallet", session=s2)
check("the PIN and the fingerprint keys survived", d.get("unlocked") is True and d.get("passkeys") == keys_before, d)
with open(EVENTS) as f:
    text = f.read()
check("the event log survived and records the update",
      " update refused, wrong PIN " in text and re.search(r" update applied .*version_to=\"%s\"" % re.escape(v1), text)
      and re.search(r" app start .*version=\"%s\"" % re.escape(v1), text))
code, d = call("/api/update/check", {}, session=s2)
check("after the update nothing newer is offered", d.get("available") is None and d.get("current") == v1, d)

# and once more, confirmed by the PIN
v2 = ".".join(v1.split(".")[:-1] + [str(int(v1.split(".")[-1]) + 1)])
with open(os.path.join(app, "server.py"), "w") as f:
    f.write(re.sub(r'^APP_VERSION = "[0-9.]+"', 'APP_VERSION = "%s"' % v2, good_server, count=1, flags=re.M))
release(app)
code, d = call("/api/update/check", {}, session=s2)
code, d = apply(s2)
check("a release confirmed by the PIN is applied", code == 200 and d.get("to") == v2, (code, d))
for _ in range(40):
    time.sleep(1)
    try:
        if version() == v2:
            break
    except Exception:
        pass
check("the app comes back at that version too", version() == v2, version())
print("all checks passed")

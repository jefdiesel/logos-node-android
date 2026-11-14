#!/usr/bin/env python3
"""The app inside the Android app (APP_EMBEDDED=android), and that nothing changes without the switch.

  python3 tests/embedded_test.py

Part 1 starts a normal app (no APP_EMBEDDED) on 127.0.0.1:8093 as its own process. Part 2 does what the
Android app does: sets APP_EMBEDDED=android, imports app/server.py as a module, runs main() in a thread
(on 127.0.0.1:8094) and calls native_unlock() in the same process. No node is needed.
"""
import os, subprocess, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

call, check = W.call, W.check
PIN = "864213"
APP = os.path.join(HERE, "..", "app")


def wait_up():
    for _ in range(80):
        try:
            if call("/api/wallet")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.1)
    check("the app starts", False)


def page():
    with urllib.request.urlopen(W.BASE + "/", timeout=10) as r:
        return r.read().decode()


# ---- part 1: without the switch, nothing about the Android app shows ---------------------------
W.BASE = "http://127.0.0.1:8093"
data = tempfile.mkdtemp()
plain = subprocess.Popen([sys.executable, os.path.join(APP, "server.py")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=dict({k: v for k, v in os.environ.items() if k != "APP_EMBEDDED"}, APP_PORT="8093", APP_DATA=data,
                                  NODE_BIN="/nonexistent", UPDATE_URL="http://127.0.0.1:9/"))
try:
    wait_up()
    code, d = call("/api/wallet")
    check("without the switch /api/wallet doesn't mention it", "embedded" not in d and "native_fingerprint" not in d, d)
    check("nor does /api/status", "embedded" not in call("/api/status")[1])
    code, d = call("/api/wallet/setup", {"pin": PIN})
    s = d["session"]
    for body in ({"on": True, "pin": PIN}, {"on": False}):
        code, d = call("/api/wallet/native-fingerprint", body, session=s)
        check("without the switch the native fingerprint route doesn't exist (%s)" % body.get("on"), code == 404, (code, d))
    code, d = call("/api/update/check", {}, session=s)
    check("without the switch updates are checked as before", code == 200 and d.get("current") and "Android" not in str(d), (code, d))
    p = page()
    check("the page carries no embedded marker", '<meta name="app-embedded" content="">' in p and "github.com/jefdiesel/logos-node-android" in p)
finally:
    plain.terminate(); plain.wait(timeout=10)

# ---- part 2: inside the Android app -------------------------------------------------------------
W.BASE = "http://127.0.0.1:8094"
data = tempfile.mkdtemp()
os.environ.update(APP_EMBEDDED="android", APP_PORT="8094", APP_DATA=data, NODE_BIN="/nonexistent", UPDATE_URL="",
                  NODE_RESTART_CMD="")
sys.path.insert(0, APP)
import server  # noqa: E402  (the Android app imports it the same way)

execs, update_loops = [], []
server.os.execv = lambda *a: execs.append(a)          # any self-restart would land here instead
real_update_loop = server.update_loop
server.update_loop = lambda: update_loops.append(1)
threading.Thread(target=server.main, daemon=True).start()
wait_up()
check("main() runs the app when imported as a module", True)
check("no update loop is started", not update_loops)
check("and the update loop does nothing even if called", real_update_loop() is None)

code, d = call("/api/wallet")
check("/api/wallet says embedded android", d.get("embedded") == "android" and d.get("native_fingerprint") is False, d)
check("/api/status says embedded android", call("/api/status")[1].get("embedded") == "android")
p = page()
check("the page is marked embedded", '<meta name="app-embedded" content="android">' in p)
check("native_unlock() gives nothing before a PIN is set", server.native_unlock() is None)

code, d = call("/api/wallet/setup", {"pin": PIN})
s = d["session"]
for path in ("/api/update/check", "/api/update/apply", "/api/update/passkey/challenge"):
    code, d = call(path, {"pin": PIN}, session=s)
    check("%s is refused: updates come with the app" % path, code == 409 and d.get("error") == "Updates come with a new version of the Android app.", (code, d))
code, d = call("/api/update/apply", {"pin": PIN})
check("also without a session", code == 409, (code, d))
check("update_apply() refuses on its own too", server.update_apply()[0] == 409)
server.restart_soon()
time.sleep(1.2)
check("restart_soon() never re-executes inside the app", not execs, execs)
check("after a restore the app points to its own Node screen", server.restart_hint() == "The keys are in place. Restart the node from the app's Node screen.")

check("native_unlock() gives nothing while fingerprint unlock is off", server.native_unlock() is None)
code, d = call("/api/wallet/native-fingerprint", {"on": True, "pin": PIN})
check("turning it on needs an unlocked wallet", code == 401, (code, d))
code, d = call("/api/wallet/native-fingerprint", {"on": "yes", "pin": PIN}, session=s)
check("on must be true or false", code == 400, (code, d))
code, d = call("/api/wallet/native-fingerprint", {"on": True}, session=s)
check("turning it on needs the PIN (none given: refused, not counted)", code == 400 and d.get("malformed"), (code, d))
code, d = call("/api/wallet/native-fingerprint", {"on": True, "pin": "000000"}, session=s)
check("a wrong PIN is refused and counted", code == 403 and d.get("tries_left") == 4, (code, d))
check("still off", server.native_unlock() is None and call("/api/wallet")[1].get("native_fingerprint") is False)
code, d = call("/api/wallet/native-fingerprint", {"on": True, "pin": PIN}, session=s)
check("with the PIN it turns on", code == 200 and d.get("native_fingerprint") is True, (code, d))
check("/api/wallet reports it on", call("/api/wallet")[1].get("native_fingerprint") is True)
with open(os.path.join(data, "wallet-settings.json")) as f:
    check("it is stored with the wallet settings", '"native_fingerprint": true' in f.read())

call("/api/wallet/lock", {}, session=s)
check("locked", call("/api/wallet", session=s)[1].get("unlocked") is False)
t = server.native_unlock()
check("native_unlock() opens the wallet and returns a session", isinstance(t, str) and len(t) == 64)
check("that session works like a PIN unlock", call("/api/wallet", session=t)[1].get("unlocked") is True)
code, d = call("/api/wallet/native-fingerprint", {"on": False}, session=t)
check("turning it off needs only the unlocked wallet", code == 200 and d.get("native_fingerprint") is False, (code, d))
check("after that native_unlock() gives nothing", server.native_unlock() is None)
with open(os.path.join(data, "wallet-events.log")) as f:
    log = f.read()
for line in ('unlock by fingerprint ok source="android"', "fingerprint unlock turned on", "fingerprint unlock turned off",
             "fingerprint unlock refused, wrong PIN", 'app start port="8094" version='):
    check("the event log records: " + line, line in log)
check("no PIN or session token in the event log", PIN not in log and t not in log and s not in log)
check("nothing re-executed at any point", not execs)

# the phone's fingerprints changed: the Android app calls native_fingerprint_reset()
s = W.unlock(PIN)
code, d = call("/api/wallet/native-fingerprint", {"on": True, "pin": PIN}, session=s)
check("fingerprint unlock is on again", code == 200 and server.native_unlock() is not None, (code, d))
s = W.unlock(PIN)
check("native_fingerprint_reset() reports that it changed something", server.native_fingerprint_reset() is True)
check("after it, fingerprint unlock is off", call("/api/wallet")[1].get("native_fingerprint") is False)
with open(os.path.join(data, "wallet-settings.json")) as f:
    check("and stored off", '"native_fingerprint": false' in f.read())
check("native_unlock() refuses", server.native_unlock() is None)
check("the open wallet was locked", call("/api/wallet", session=s)[1].get("unlocked") is False)
with open(os.path.join(data, "wallet-events.log")) as f:
    log = f.read()
check("the event log says why", 'fingerprint unlock turned off reason="fingerprints changed" source="android"' in log
      and 'wallet locked reason="fingerprints changed"' in log)
check("a second reset changes nothing", server.native_fingerprint_reset() is False)
code, d = call("/api/wallet/native-fingerprint", {"on": True, "pin": PIN}, session=W.unlock(PIN))
check("the PIN turns it on again", code == 200 and server.native_unlock() is not None, (code, d))
# the app's own report of leaving (onStop: Home, the screen off) and coming back (onStart): leaving counts even
# when the page's report is lost, and the grace is counted from the app's report
server.LEAVE_GRACE = 1.0
s = W.unlock(PIN)
check("native_visibility('hidden') with an open wallet: the absence starts, counted as the app's",
      server.native_visibility("hidden") is True and server.session["hidden_by"] == "app")
check("back within the grace: still open", server.native_visibility("visible") is True and call("/api/wallet", session=s)[1].get("unlocked") is True)
server.native_visibility("hidden")
time.sleep(1.4)
check("away longer than the grace, with no word from the page: locked", call("/api/wallet", session=s)[1].get("unlocked") is False)
check("coming back after that doesn't open it again", server.native_visibility("visible") is False and call("/api/wallet", session=s)[1].get("unlocked") is False)
check("native_visibility takes only hidden or visible", server.native_visibility("gone") is False)
s = W.unlock(PIN)
s = W.unlock(PIN)
server.LEAVE_GRACE = 60.0
with open(os.path.join(data, "wallet-events.log")) as f:
    log = f.read()
check("each lock is logged with its reason: leaving the app, and a new unlock replacing the open session",
      'wallet locked reason="left the app"' in log and 'wallet locked reason="a new unlock replaced the open session"' in log)
server.EMBEDDED = False                     # outside the Android app the function does nothing
check("outside embedded mode native_fingerprint_reset() is a no-op returning False", server.native_fingerprint_reset() is False)
check("and leaves the setting as it was", server.wallet_settings.get("native_fingerprint") is True)
server.EMBEDDED = True
print("all checks passed")

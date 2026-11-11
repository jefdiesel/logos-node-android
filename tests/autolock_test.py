#!/usr/bin/env python3
"""Auto-lock: the wallet locks after a stretch without user activity (polling doesn't count), and soon
after the page says it was left. Starts its own app on 127.0.0.1:8091 with timings shortened through the
environment (a "minute" is 1 second, the grace after leaving is 3 seconds) and no node.

  python3 tests/autolock_test.py
"""
import os, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

W.BASE = "http://127.0.0.1:8091"
W.FakePasskey.ORIGIN = "http://localhost:8091"
call, check = W.call, W.check
MINUTE, GRACE, PIN = 1.0, 3.0, "975310"
DATA = tempfile.mkdtemp()
EVENTS = os.path.join(DATA, "wallet-events.log")
app = None


def start():
    global app
    env = dict(os.environ, APP_PORT="8091", APP_DATA=DATA, NODE_BIN="/nonexistent", UPDATE_URL="http://127.0.0.1:9/",
               AUTOLOCK_MINUTE_SECONDS=str(MINUTE), LEAVE_GRACE_SECONDS=str(GRACE))
    app = subprocess.Popen([sys.executable, os.path.join(HERE, "..", "app", "server.py")], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            if call("/api/wallet")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.1)
    check("the app starts", False)


def stop():
    app.terminate()
    app.wait(timeout=10)


def polls(s, seconds):
    """What an open page does on its timers, for `seconds`: none of it is user activity."""
    end, code = time.time() + seconds, 0
    while time.time() < end:
        code = call("/api/wallet/accounts", session=s)[0]
        call("/api/wallet/history", session=s)
        call("/api/wallet/receipts", {}, session=s)
        call("/api/status")
        call("/api/wallet/tx?hash=ab", session=s)
        time.sleep(0.25)
    return code


def unlocked(s):
    return call("/api/wallet/accounts", session=s)[0] == 200


def log():
    with open(EVENTS) as f:
        return f.read()


try:
    start()
    code, d = call("/api/wallet/setup", {"pin": PIN})
    s = d["session"]
    code, d = call("/api/wallet", session=s)
    check("the default auto-lock is 5 minutes", d.get("autolock_minutes") == 5, d)

    # set it to 1 "minute" (1 s here) so the idle checks are quick
    code, d = call("/api/wallet/settings", {"autolock_minutes": 1})
    check("changing auto-lock needs an unlocked wallet", code == 401, (code, d))
    for bad in (2, 0, "5", True, None):
        code, d = call("/api/wallet/settings", {"autolock_minutes": bad}, session=s)
        check("auto-lock refuses %r" % (bad,), code == 400, (code, d))
    code, d = call("/api/wallet/settings", {"autolock_minutes": 1}, session=s)
    check("auto-lock is set to 1 minute", code == 200 and d.get("autolock_minutes") == 1, (code, d))

    check("a page that only polls stays unlocked within the idle time", polls(s, 0.6 * MINUTE) == 200)
    polls(s, 1.5 * MINUTE)
    check("a page that only polls is locked after the idle time", not unlocked(s))
    check("the lock is logged as idle", 'wallet locked reason="idle"' in log())
    for path, body in (("/api/wallet/history", None), ("/api/wallet/receipts", {}), ("/api/wallet/send", {"from": "a", "to": "b", "amount": 1}),
                       ("/api/wallet/activity", {}), ("/api/wallet/visibility", {"state": "visible"})):
        code, d = call(path, body, session=s)
        check("after locking, %s answers 401" % path, code == 401, (code, d))

    s = W.unlock(PIN)
    end = time.time() + 3 * MINUTE
    while time.time() < end:
        call("/api/wallet/activity", {}, session=s)
        polls(s, 0.3 * MINUTE)
    check("activity reports keep it unlocked past the idle time", unlocked(s))

    # leaving the page: locked GRACE seconds after "hidden", unless "visible" comes first
    code, d = call("/api/wallet/settings", {"autolock_minutes": 15}, session=s)
    check("auto-lock is set to 15 minutes", code == 200, (code, d))
    code, d = call("/api/wallet/visibility", {"state": "hidden"}, session=s)
    check("the page can say it is hidden", code == 200, (code, d))
    time.sleep(GRACE / 3)
    call("/api/wallet/visibility", {"state": "visible"}, session=s)
    time.sleep(GRACE)
    check("coming back within the grace keeps it unlocked", unlocked(s))
    call("/api/wallet/visibility", {"state": "hidden"}, session=s)
    check("right after leaving it is still unlocked", unlocked(s))
    polls(s, GRACE + 1)
    check("after the grace it is locked, polling or not", not unlocked(s))
    code, d = call("/api/wallet/visibility", {"state": "visible"}, session=s)
    check("coming back after that finds it locked", code == 401, (code, d))
    check("the lock is logged as leaving the page", 'wallet locked reason="left the page"' in log())
    s = W.unlock(PIN)
    call("/api/wallet/lock", {}, session=s)
    check("locking by hand is logged with its reason", 'wallet locked reason="user"' in log())

    # fingerprint unlock still works after an auto-lock
    s = W.unlock(PIN)
    pk = W.FakePasskey()
    code, o = call("/api/wallet/passkey/options", {}, session=s)
    reg = {"id": W.b64u(pk.id), "publicKey": W.b64u(pk.spki), "authenticatorData": W.b64u(pk.auth_data()),
           "clientDataJSON": W.b64u(pk.client_data("webauthn.create", o["challenge"]))}
    check("a fingerprint key is set up", call("/api/wallet/passkey/register", reg, session=s)[0] == 200)
    call("/api/wallet/visibility", {"state": "hidden"}, session=s)
    time.sleep(GRACE + 1)
    check("it locked after leaving", not unlocked(s))
    code, c = call("/api/wallet/passkey/challenge", {})
    code, d = call("/api/wallet/passkey/unlock", pk.assertion(c["challenge"]))
    check("after an auto-lock the fingerprint unlocks it as usual", code == 200 and unlocked(d["session"]), (code, d))

    # the setting is kept across a restart
    stop()
    start()
    code, d = call("/api/wallet")
    check("the auto-lock setting survives a restart", d.get("autolock_minutes") == 15, d)
    print("all checks passed")
finally:
    if app and app.poll() is None:
        stop()

#!/usr/bin/env python3
"""The messaging node switched on and off while the app runs, as in the Android app.

  python3 tests/messaging_switch_test.py

Imports app/server.py with APP_EMBEDDED=android and no WAKU_API (the node is off at start), runs main()
in a thread on 127.0.0.1:8094, and starts a fake messaging node (tests/fake_waku.py) on 18653. First the
app follows WAKU_API in its environment (what the Android app does until it calls set_waku_api), then
set_waku_api(url) / set_waku_api(None). Each time: the status says off or on, a send while off says the
node is off, and after it comes back the app subscribes again and gets what is sent to it.
"""
import base64, hashlib, os, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

W.BASE = "http://127.0.0.1:8094"
call, check = W.call, W.check
NODE, CTL, PIN = 18653, 18658, "246824"
fake = subprocess.Popen([sys.executable, os.path.join(HERE, "fake_waku.py"), str(CTL), str(NODE)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.environ.pop("WAKU_API", None)
os.environ.update(APP_EMBEDDED="android", APP_PORT="8094", APP_DATA=tempfile.mkdtemp(), NODE_BIN="/nonexistent", UPDATE_URL="",
                  MESSAGING_POLL_SECONDS="0.2", MESSAGING_HEALTH_SECONDS="0.3")
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

threading.Thread(target=server.main, daemon=True).start()
for _ in range(80):
    try:
        if call("/api/wallet")[0] == 200:
            break
    except Exception:
        pass
    time.sleep(0.1)


def status():
    return call("/api/messages/status", session=s)[1]


def until(name, f, seconds=8):
    end = time.time() + seconds
    while time.time() < end:
        v = f()
        if v:
            return v
        time.sleep(0.1)
    check(name, False, f())


def inject(text):
    import urllib.request
    body = ('{"topic": "%s", "payload": "%s"}' % (topic, base64.b64encode(text.encode()).decode())).encode()
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:%d/inject/0" % CTL, data=body, method="POST"), timeout=5).read()


def control(what):
    import urllib.request
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:%d/%s" % (CTL, what), data=b"{}", method="POST"), timeout=5).read()


try:
    check("in the Android app, messages exist even while the node is off", server.messaging_on())
    s = call("/api/wallet/setup", {"pin": PIN})[1]["session"]
    secret = bytes(range(1, 33))
    public = server.x25519(secret, (9).to_bytes(32, "little")).hex()
    check("a messaging key is kept", call("/api/messages/key", {"secret": secret.hex(), "public": public}, session=s)[0] == 200)
    topic = server.inbox_topic(public)
    st = until("with no WAKU_API the status says the node is off", lambda: (lambda d: d.get("node", {}).get("configured") is False and d)(status()))
    check("and not reachable", st["node"]["reachable"] is False, st)
    code, d = call("/api/messages/send", {"topic": topic, "payload": base64.b64encode(b"x" * 80).decode()}, session=s)
    check("a send while it's off says so", code == 503 and d.get("node_off"), (code, d))
    check("the page still gets its Messages panel", '<script type="module" src="/messages/messages.js"></script>' in
          __import__("urllib.request").request.urlopen(W.BASE + "/", timeout=5).read().decode())

    # 1. the app follows WAKU_API in its environment
    os.environ["WAKU_API"] = "http://127.0.0.1:%d" % NODE
    until("when WAKU_API appears, the node is seen and the inbox subscribed",
          lambda: (lambda d: d["node"]["reachable"] is True and d["subscribed"] and d)(status()))
    inject("one")
    until("a message arrives", lambda: len(call("/api/messages/inbox", session=s)[1]["items"]) == 1)
    del os.environ["WAKU_API"]
    until("when WAKU_API goes, the status says off again", lambda: status()["node"]["configured"] is False)
    for path in ("/api/messages/status", "/api/messages/inbox", "/api/messages/key"):
        check("requests keep working while it's off: " + path, call(path, session=s)[0] == 200)
    control("restart/0")                            # it lost its subscriptions meanwhile
    os.environ["WAKU_API"] = "http://127.0.0.1:%d" % NODE
    until("when it comes back, it is subscribed again", lambda: (lambda d: d["node"]["reachable"] is True and d["subscribed"])(status()))
    inject("two")
    until("and messages arrive again", lambda: len(call("/api/messages/inbox", session=s)[1]["items"]) == 2)

    # 2. the app says where the node is with set_waku_api() (then the environment no longer counts)
    check("a node off this device is refused", server.set_waku_api("http://10.0.0.5:18645") is False and server.waku_api() == "http://127.0.0.1:%d" % NODE)
    check("set_waku_api(None): the node is off", server.set_waku_api(None) is True and server.waku_api() == "")
    until("and the status says so, even with WAKU_API still in the environment", lambda: status()["node"]["configured"] is False)
    code, d = call("/api/messages/send", {"topic": topic, "payload": base64.b64encode(b"y" * 80).decode()}, session=s)
    check("a send says the node is off", code == 503 and d.get("node_off"), (code, d))
    control("restart/0")
    check("set_waku_api(url): it is on again", server.set_waku_api("http://127.0.0.1:%d" % NODE) is True)
    until("subscribed again", lambda: (lambda d: d["node"]["reachable"] is True and d["subscribed"])(status()))
    inject("three")
    until("messages arrive again", lambda: len(call("/api/messages/inbox", session=s)[1]["items"]) == 3)
    check("messaging_inbox_count() follows", server.messaging_inbox_count() == 3)
    print("all checks passed")
finally:
    fake.terminate()

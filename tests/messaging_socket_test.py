#!/usr/bin/env python3
"""The app's messages through the runner's own API on a Unix socket (android/LOCAL-APIS.md), as in the Android app.

  python3 tests/messaging_socket_test.py      (needs a C compiler: $CC, or cc)

Builds messaging/runner/api_socket_harness.c (the runner's socket code with a stand-in library), imports
app/server.py with APP_EMBEDDED=android and runs it, then set_waku_api("unix:<socket>") as the app does. Checks that
the inbox is subscribed over the socket, that a message another sender publishes arrives, that a send goes
out and reaches "sent", and that http URLs off this device and relative socket paths are still refused.
"""
import base64, os, shutil, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

PORT = 8099 + int(os.environ.get("PORT_SHIFT", "0"))
W.BASE = "http://127.0.0.1:%d" % PORT
call, check = W.call, W.check
PIN = "246825"
tmp = tempfile.mkdtemp(prefix="ms-")
exe = os.path.join(tmp, "harness")
r = subprocess.run([os.environ.get("CC", "cc"), "-std=gnu11", "-O1", "-pthread",
                    os.path.join(HERE, "..", "messaging", "runner", "api_socket_harness.c"), "-o", exe], capture_output=True, text=True)
check("the runner's socket code builds with the stand-in library", r.returncode == 0, r.stderr)
sockdir = os.path.join(tmp, "api")
os.mkdir(sockdir, 0o700)
sock = os.path.join(sockdir, "api.sock")
runner = subprocess.Popen([exe, sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
check("the runner's socket is up", runner.stdout.readline().strip() == "ready")

os.environ.pop("WAKU_API", None)
os.environ.update(APP_EMBEDDED="android", APP_PORT=str(PORT), APP_DATA=tempfile.mkdtemp(), NODE_BIN="/nonexistent", UPDATE_URL="",
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


def until(name, f, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        v = f()
        if v:
            return check(name, True)
        time.sleep(0.1)
    check(name, False, f())


try:
    s = call("/api/wallet/setup", {"pin": PIN})[1]["session"]
    status = lambda: call("/api/messages/status", session=s)[1]
    secret = bytes(range(1, 33))
    public = server.x25519(secret, (9).to_bytes(32, "little")).hex()
    check("a messaging key is kept", call("/api/messages/key", {"secret": secret.hex(), "public": public}, session=s)[0] == 200)
    topic = server.inbox_topic(public)

    check("an http URL off this device is still refused", server.set_waku_api("http://10.0.0.5:18645") is False)
    check("a relative socket path is refused", server.set_waku_api("unix:api.sock") is False)
    check("set_waku_api(unix:<socket>) is taken", server.set_waku_api("unix:" + sock) is True and server.waku_api() == "unix:" + sock)
    until("the node is seen over the socket and the inbox subscribed",
          lambda: (lambda d: d["node"]["reachable"] is True and d["subscribed"] and d["node"]["connection"] == "Connected")(status()))
    code, subs = server.waku("GET", "/messaging/v1/subscriptions")
    check("the runner has the inbox topic", code == 200 and topic in subs, (code, subs))

    payload = base64.b64encode(b"sealed by another sender " + bytes(60)).decode()
    runner.stdin.write("inject %s %s\n" % (topic, payload))
    runner.stdin.flush()
    until("a message another sender published arrives in the inbox", lambda: len(call("/api/messages/inbox", session=s)[1]["items"]) == 1)

    other = "/names/1/msg-00112233aabbccdd/proto"
    code, d = call("/api/messages/send", {"topic": other, "payload": base64.b64encode(b"z" * 90).decode()}, session=s)
    check("a send goes out over the socket with a request id", code == 200 and isinstance(d.get("requestId"), str), (code, d))
    time.sleep(0.4)
    code, st = call("/api/messages/send/" + d.get("requestId", "x"), session=s)
    check("and its status comes back: propagated, sent", code == 200 and "sent" in str(st), (code, st))

    check("set_waku_api(None): the node is off", server.set_waku_api(None) is True)
    until("and the status says so", lambda: status()["node"]["configured"] is False)
    print("all checks passed")
finally:
    runner.kill()
    runner.wait(timeout=10)
    shutil.rmtree(tmp, ignore_errors=True)

#!/usr/bin/env python3
"""A flood of large messages doesn't lose the batch (review S3; adapted from the reviewer's batch-loss repro).

  python3 tests/messaging_batch_test.py      (needs a C compiler: $CC, or cc)

Before: the runner kept up to 256 received messages with no byte bound and emptied its buffer when polled, while
server.py read at most 4 MiB of an answer. 25 messages of 200 KB came back cut short, not a list, and were all lost
(genuine ones included). Now the runner keeps at most 2 MiB (dropping the oldest, counted as missed) and server.py
reads every answer whole. Runs the runner's socket code with a stand-in library (api_socket_harness.c) and the app's
real messaging loop (server.py, as in the Android app).
"""
import base64, os, shutil, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

PORT = 8100 + int(os.environ.get("PORT_SHIFT", "0"))
W.BASE = "http://127.0.0.1:%d" % PORT
call, check = W.call, W.check
tmp = tempfile.mkdtemp(prefix="mb-")
exe = os.path.join(tmp, "harness")
r = subprocess.run([os.environ.get("CC", "cc"), "-std=gnu11", "-O1", "-pthread",
                    os.path.join(HERE, "..", "messaging", "runner", "api_socket_harness.c"), "-o", exe], capture_output=True, text=True)
check("the runner's socket code builds with the stand-in library", r.returncode == 0, r.stderr)
os.mkdir(os.path.join(tmp, "api"), 0o700)
sock = os.path.join(tmp, "api", "api.sock")
runner = subprocess.Popen([exe, sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
check("the runner's socket is up", runner.stdout.readline().strip() == "ready")


def send(line):
    runner.stdin.write(line + "\n")
    runner.stdin.flush()


try:
    # ---- 1. the transport: what the reviewer's repro showed --------------------------------------------------------
    os.environ.pop("WAKU_API", None)
    os.environ.update(APP_EMBEDDED="android", APP_PORT=str(PORT), APP_DATA=tempfile.mkdtemp(dir=tmp), NODE_BIN="/nonexistent",
                      UPDATE_URL="", MESSAGING_POLL_SECONDS="0.5", MESSAGING_HEALTH_SECONDS="0.5")
    sys.path.insert(0, os.path.join(HERE, "..", "app"))
    import server  # noqa: E402
    server.set_waku_api("unix:" + sock)
    for count, size in ((10, 200000), (25, 200000)):
        send("big %d %d /x/1/flood/proto" % (count, size))
        check("(%d messages injected)" % count, runner.stdout.readline().strip() == "injected %d" % count)
        code, rec = server.waku("GET", "/messaging/v1/events/received", timeout=10)
        check("%d messages of 200 KB buffered: one poll gets a list (never cut short)" % count, code == 200 and isinstance(rec, list), (code, str(rec)[:60]))
        n = len(rec) if isinstance(rec, list) else 0
        check("  of at most 2 MiB (%d messages kept)" % n, 0 < n <= count and n * 200000 <= 2 * 1024 * 1024, n)
        code, rec2 = server.waku("GET", "/messaging/v1/events/received", timeout=10)
        check("  and the next poll is an empty list", code == 200 and rec2 == [], (code, str(rec2)[:60]))

    # ---- 2. the app: a genuine message after a flood still arrives, the dropped ones count as missed ----------------
    threading.Thread(target=server.main, daemon=True).start()
    for _ in range(80):
        try:
            if call("/api/wallet")[0] == 200:
                break
        except Exception:
            pass
        time.sleep(0.1)
    s = call("/api/wallet/setup", {"pin": "246826"})[1]["session"]
    secret = bytes(range(1, 33))
    public = server.x25519(secret, (9).to_bytes(32, "little")).hex()
    check("a messaging key is kept", call("/api/messages/key", {"secret": secret.hex(), "public": public}, session=s)[0] == 200)
    topic = server.inbox_topic(public)
    end = time.time() + 15
    while time.time() < end and not call("/api/messages/status", session=s)[1].get("subscribed"):
        time.sleep(0.2)
    check("the inbox is subscribed over the socket", call("/api/messages/status", session=s)[1].get("subscribed"))
    first = base64.b64encode(b"an earlier sealed message " + bytes(70)).decode()
    send("inject %s %s" % (topic, first))              # so the app knows where the runner's count stands
    end = time.time() + 20
    while time.time() < end and len(call("/api/messages/inbox", session=s)[1].get("items", [])) < 1:
        time.sleep(0.2)
    check("(an earlier message arrives)", len(call("/api/messages/inbox", session=s)[1].get("items", [])) == 1)
    missed0 = call("/api/messages/status", session=s)[1].get("missed", 0)
    send("big 25 200000 %s" % topic)                    # junk too large to be a message, on the inbox topic
    check("(the flood)", runner.stdout.readline().strip() == "injected 25")
    genuine = base64.b64encode(b"a genuine sealed message " + bytes(70)).decode()
    send("inject %s %s" % (topic, genuine))
    end = time.time() + 20
    while time.time() < end and len(call("/api/messages/inbox", session=s)[1].get("items", [])) < 2:
        time.sleep(0.2)
    check("a genuine message sent right after a flood of 25 x 200 KB arrives", len(call("/api/messages/inbox", session=s)[1].get("items", [])) == 2)
    missed = call("/api/messages/status", session=s)[1].get("missed", 0) - missed0
    check("the flood messages the runner dropped are counted as missed", missed > 0, missed)
    print("all checks passed")
finally:
    runner.kill()
    runner.wait(timeout=10)
    shutil.rmtree(tmp, ignore_errors=True)

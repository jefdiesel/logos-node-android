#!/usr/bin/env python3
"""Tests api_socket.h (the runner's own API on a Unix socket) with api_socket_harness.c (a stand-in library).

  python3 -I messaging/runner/test_api_socket.py      (needs a C compiler: $CC, or cc)

Compiles the harness on this computer and checks: the socket is created only in a private directory and is
owner-only; a live socket is never taken over and a dead one is replaced; and every call the wallet makes, with
the same answers as the library's REST API (evict-after-poll included).
"""
import base64, json, os, shutil, socket, stat, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (" - " + str(detail)[:300] if detail != "" and not ok else ""))
    if not ok:
        FAILS.append(name)


def call(path, method, url, body=None, raw=None):
    """One HTTP/1.1 request over the socket: (status, parsed JSON or text)."""
    data = raw if raw is not None else (b"" if body is None else json.dumps(body).encode())
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect(path)
    s.sendall(("%s %s HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
               "Connection: close\r\n\r\n" % (method, url, len(data))).encode() + data)
    out = b""
    while True:
        b = s.recv(65536)
        if not b:
            break
        out += b
    s.close()
    head, _, rest = out.partition(b"\r\n\r\n")
    code = int(head.split(b" ")[1])
    n = int(next(l.split(b":")[1] for l in head.split(b"\r\n") if l.lower().startswith(b"content-length:")))
    body = rest[:n]
    try:
        return code, json.loads(body) if body else None
    except Exception:
        return code, body.decode(errors="replace")


tmp = tempfile.mkdtemp(prefix="api-")
try:
    exe = os.path.join(tmp, "harness")
    cc = os.environ.get("CC", "cc")
    r = subprocess.run([cc, "-std=gnu11", "-Wall", "-Wextra", "-Wno-unused-function", "-Werror", "-O1", "-pthread",
                        os.path.join(HERE, "api_socket_harness.c"), "-o", exe], capture_output=True, text=True)
    check("the harness compiles with no warnings", r.returncode == 0, r.stderr)
    if r.returncode:
        sys.exit(1)

    # ---- where the socket may be made -------------------------------------------------------------------------
    d = os.path.join(tmp, "d")
    os.mkdir(d, 0o700)
    for mode in (0o750, 0o705, 0o755, 0o777):
        os.chmod(d, mode)
        r = subprocess.run([exe, "--check", os.path.join(d, "api.sock")], capture_output=True, text=True, timeout=10)
        check("a directory with mode %o is refused" % mode, r.returncode == 3 and "no group or other access" in r.stderr, r.stderr)
    os.chmod(d, 0o700)
    os.symlink(d, os.path.join(tmp, "link"))
    r = subprocess.run([exe, "--check", os.path.join(tmp, "link", "api.sock")], capture_output=True, text=True, timeout=10)
    check("a symlinked directory is refused", r.returncode == 3, r.stderr)
    r = subprocess.run([exe, "--check", "api.sock"], capture_output=True, text=True, timeout=10)
    check("a relative path is refused", r.returncode == 3, r.stderr)
    sock = os.path.join(d, "api.sock")
    with open(sock, "w") as f:
        f.write("keep me")
    r = subprocess.run([exe, "--check", sock], capture_output=True, text=True, timeout=10)
    check("a file that isn't a socket is left alone and refused", r.returncode == 3 and open(sock).read() == "keep me", r.stderr)
    os.unlink(sock)
    live = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    live.bind(sock)
    live.listen(1)
    r = subprocess.run([exe, "--check", sock], capture_output=True, text=True, timeout=10)
    check("a live socket (another runner) is never taken over", r.returncode == 3 and "already serves" in r.stderr, r.stderr)
    live.close()                                   # now a dead socket file is left behind
    check("(a dead socket file is left)", os.path.exists(sock))

    # ---- the runner refuses a config that turns the library's network APIs on (review S4) ----------------------
    cfg = os.path.join(tmp, "config.json")
    base = {"mode": "Core", "preset": "logos.test", "rest": False, "nodekey": "ab" * 32}
    cases = [("REST off", base, 0), ("no REST key at all", {k: v for k, v in base.items() if k != "rest"}, 0),
             ("REST null", dict(base, rest=None), 0), ("rest-port alone (REST still off)", dict(base, **{"rest-port": 18645}), 0),
             ("REST on", dict(base, rest=True), 4), ("rest-admin on", dict(base, **{"rest-admin": True}), 4),
             ("metrics server on", dict(base, **{"metrics-server": True}), 4),
             ("websockets on", dict(base, **{"websocket-support": True}), 4),
             ("REST as a string", dict(base, rest="true"), 4),
             # the review's bypasses (D2): the library reads keys case-insensitively, by field name too, and 1 as true
             ("REST", dict(base, REST=True), 4), ("Rest", dict(base, Rest=True), 4),
             ("restAdmin", dict(base, restAdmin=True), 4), ("metricsServer", dict(base, metricsServer=True), 4),
             ("metricsserver", dict(base, metricsserver=True), 4), ("websocketSupport", dict(base, websocketSupport=True), 4),
             ("websocketSecureSupport", dict(base, websocketSecureSupport=True), 4), ("metrics_server", dict(base, metrics_server=True), 4),
             ("rest: 1", dict(base, rest=1), 4), ("rest: yes", dict(base, rest="yes"), 4), ("rest: on", dict(base, rest="on"), 4)]
    for name, conf, want in cases:
        with open(cfg, "w") as f:
            json.dump(conf, f, indent=1)
        r = subprocess.run([exe, "--config", cfg], capture_output=True, text=True, timeout=10)
        check("config with %s: %s" % (name, "taken" if want == 0 else "refused"), r.returncode == want and ("ab" * 32) not in r.stdout + r.stderr, (r.returncode, r.stdout))

    for name, raw, want in (("a key spelled with an escape (re\\u0073t)", '{"mode":"Core","re\\u0073t":true}', 4),
                            ("a value like true in a string elsewhere", '{"mode":"Core","nodekey":"x\\"rest\\":true","rest":false}', 0),
                            ("rest: false with spaces", '{"rest"  :  false  }', 0), ("rest: falsey", '{"rest":falsey}', 4)):
        with open(cfg, "w") as f:
            f.write(raw)
        r = subprocess.run([exe, "--config", cfg], capture_output=True, text=True, timeout=10)
        check("config with %s: %s" % (name, "taken" if want == 0 else "refused"), r.returncode == want, (r.returncode, r.stdout))

    p = subprocess.Popen([exe, sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        check("a dead socket is replaced and the harness serves", p.stdout.readline().strip() == "ready")
        check("the socket is owner-only (0600)", stat.S_IMODE(os.lstat(sock).st_mode) == 0o600, oct(os.lstat(sock).st_mode))

        # ---- the calls ----------------------------------------------------------------------------------------
        check("GET /health", call(sock, "GET", "/health") == (200, {"nodeHealth": "Ready", "connectionStatus": "Connected"}))
        check("no subscriptions yet", call(sock, "GET", "/messaging/v1/subscriptions") == (200, []))
        topic, other = "/names/1/msg-0123456789abcdef/proto", "/names/1/msg-aaaa/proto"
        check("subscribe", call(sock, "POST", "/messaging/v1/subscriptions", [topic, other])[0] == 200)
        check("subscribe again (no duplicate)", call(sock, "POST", "/messaging/v1/subscriptions", [topic])[0] == 200)
        check("the subscriptions, sorted", call(sock, "GET", "/messaging/v1/subscriptions") == (200, sorted([topic, other])))
        check("unsubscribe", call(sock, "DELETE", "/messaging/v1/subscriptions", [other])[0] == 200)
        check("unsubscribed", call(sock, "GET", "/messaging/v1/subscriptions") == (200, [topic]))
        code, d2 = call(sock, "POST", "/messaging/v1/subscriptions", ["/fail/1/x/proto"])
        check("a refused subscription is a 500 with the library's reason, as JSON", code == 500 and "Subscribe failed" in d2["error"] and '"no"' in d2["error"], d2)
        for bad in (b"[\"a b\"]", b"[\"a\\\"b\"]", b"{\"x\":1}", b"[1]", b"[\"a\",]", b"", b"[\"" + b"x" * 300 + b"\"]"):
            check("a bad topic list is refused: %r" % bad[:20], call(sock, "POST", "/messaging/v1/subscriptions", raw=bad)[0] == 400)
        check("the received buffer starts empty", call(sock, "GET", "/messaging/v1/events/received") == (200, []))

        payload = base64.b64encode(b"sealed bytes").decode()
        code, d1 = call(sock, "POST", "/messaging/v1/messages", {"payload": payload, "contentTopic": topic, "ephemeral": False})
        check("send: a request id", code == 200 and d1 == {"requestId": "req-1"}, (code, d1))
        code, d2 = call(sock, "POST", "/messaging/v1/messages", {"payload": payload, "contentTopic": "/names/1/msg-fail/proto"})
        check("send: a quoted request id from the library is unquoted", code == 200 and d2 == {"requestId": "req-2"}, (code, d2))
        check("send: not a JSON object is refused", call(sock, "POST", "/messaging/v1/messages", raw=b"[1,2]")[0] == 400)
        time.sleep(0.4)
        code, st = call(sock, "GET", "/messaging/v1/events/send/req-1")
        check("send status: propagated then sent", code == 200 and st == {"requestId": "req-1", "events": [{"kind": "propagated"}, {"kind": "sent"}]}, st)
        check("send status is removed once read", call(sock, "GET", "/messaging/v1/events/send/req-1")[0] == 404)
        code, st = call(sock, "GET", "/messaging/v1/events/send/req-2")
        check("an error event keeps its message, as valid JSON", code == 200 and st["events"] == [{"kind": "error", "error": 'stand-in: "bad" \\ thing'}], st)
        check("an unknown request id is a 404", call(sock, "GET", "/messaging/v1/events/send/req-99")[0] == 404)
        check("a bad request id is a 400", call(sock, "GET", "/messaging/v1/events/send/a%22b")[0] == 400)
        code, recs = call(sock, "GET", "/messaging/v1/events/received")
        ok = code == 200 and len(recs) == 1 and recs[0]["seq"] == 1 and recs[0]["message"]["payload"] == payload \
            and recs[0]["message"]["contentTopic"] == topic and recs[0]["messageHash"].startswith("0x") and recs[0]["source"] == "live"
        check("received: the message as the library reported it, with a seq", ok, recs)
        check("received messages are removed once read", call(sock, "GET", "/messaging/v1/events/received") == (200, []))
        for i in range(3):
            call(sock, "POST", "/messaging/v1/messages", {"payload": payload, "contentTopic": topic})
        time.sleep(0.4)
        code, recs = call(sock, "GET", "/messaging/v1/events/received")
        check("seq keeps counting", code == 200 and [r_["seq"] for r_ in recs] == [2, 3, 4], recs)
        check("an unknown path is a 404", call(sock, "GET", "/messaging/v1/nothing")[0] == 404)
        check("the wrong method is a 405", call(sock, "PUT", "/messaging/v1/messages", {})[0] == 405)
        big = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        big.settimeout(10)
        big.connect(sock)
        big.sendall(b"POST /messaging/v1/messages HTTP/1.1\r\nContent-Length: 2000000\r\n\r\n{")
        answer = big.recv(200)
        big.close()
        check("a body over 1 MB is refused before it is read", answer.startswith(b"HTTP/1.1 413 "), answer[:40])
        check("still serving", call(sock, "GET", "/health")[0] == 200)

        # ---- the received buffer is bounded in bytes, below what the client reads in one go ------------------
        # (review S3: 25 messages of 200 KB, more than server.py's 4 MiB read, used to be evicted and then lost)
        def big(count, size):
            p.stdin.write("big %d %d %s\n" % (count, size, topic)); p.stdin.flush()
            return p.stdout.readline().strip()
        check("(the harness takes a flood)", big(25, 200000) == "injected 25")
        code, recs = call(sock, "GET", "/messaging/v1/events/received")
        total = sum(len(json.dumps(r_, separators=(",", ":"))) + 1 for r_ in recs) if isinstance(recs, list) else -1
        seqs = [r_["seq"] for r_ in recs] if isinstance(recs, list) else []
        check("after 25 x 200 KB, one poll gets a list of at most 2 MiB", code == 200 and isinstance(recs, list) and 0 < total <= 2 * 1024 * 1024, (code, total))
        check("the newest ones, in order, the oldest dropped (a gap in seq)", seqs == list(range(seqs[0], seqs[0] + len(seqs))) and seqs[-1] - seqs[0] + 1 == len(seqs) and len(seqs) < 25 and seqs[-1] == 4 + 25, seqs)
        check("and the next poll is empty", call(sock, "GET", "/messaging/v1/events/received") == (200, []))
        check("(a flood of small ones)", big(300, 100) == "injected 300")
        code, recs = call(sock, "GET", "/messaging/v1/events/received")
        check("the count bound still holds: 256", code == 200 and len(recs) == 256 and recs[-1]["seq"] == 4 + 25 + 300, len(recs) if isinstance(recs, list) else recs)
    finally:
        p.kill(); p.wait(timeout=10)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

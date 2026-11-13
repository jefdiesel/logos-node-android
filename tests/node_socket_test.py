#!/usr/bin/env python3
"""server.py talking to a node that serves its API on a Unix socket (node patch 0002, android/LOCAL-APIS.md).

  python3 tests/node_socket_test.py

A stand-in node answers HTTP on a Unix socket only. Part 1 calls server.py's node() in-process: GETs and POSTs
go over the socket and nothing touches TCP: another program on the node's old TCP port changes nothing, and no
extra call is made before a send (review D3). An answer that ends short of its Content-Length is no answer, never a
cut-short body (review D4). Part 2 runs the app as the Android app does (APP_EMBEDDED, APP_KEY, NODE_API=unix:...)
and reads the node's state through it.
"""
import http.server, json, os, secrets, shutil, socket, socketserver, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

check = W.check
APP = os.path.join(HERE, "..", "app")
seen = []                                          # (method, path) the stand-in node received


class Node(http.server.BaseHTTPRequestHandler):
    def out(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        seen.append(("GET", self.path))
        if self.path == "/cryptarchia/info":
            return self.out(200, {"cryptarchia_info": {"height": 4242, "slot": 9000, "state": "Online"}})
        if self.path == "/network/info":
            return self.out(200, {"connected_peers": ["a", "b", "c"]})
        return self.out(404, {"message": "not here"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        seen.append(("POST", self.path))
        if self.path == "/wallet/transactions/transfer-funds" and self.headers.get("Content-Type") == "application/json":
            return self.out(201, {"hash": "ab" * 32, "amount": body.get("amount")})
        return self.out(400, {"message": "bad"})

    def address_string(self):
        return "unix"

    def log_message(self, *a):
        pass


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


tmp = tempfile.mkdtemp(prefix="ns-")
sock = os.path.join(tmp, "api.sock")
srv = UnixServer(sock, Node)
threading.Thread(target=srv.serve_forever, daemon=True).start()

guard = socket.socket()
guard.bind(("127.0.0.1", 0))
guard_port = guard.getsockname()[1]                # free now; another program listens there in part 1
guard.close()


class Short(socketserver.BaseRequestHandler):
    """A node that dies mid-answer: a Content-Length of 1000, then 10 bytes, then the connection closes."""
    def handle(self):
        self.request.recv(65536)
        self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n[{"seq":1}')


short_sock = os.path.join(tmp, "short.sock")
short_srv = UnixServer(short_sock, Short)
threading.Thread(target=short_srv.serve_forever, daemon=True).start()

# ---- part 1: node() in-process ---------------------------------------------------------------------------------
probe = r"""
import json, os, socket, sys
os.environ.update(NODE_API="unix:" + sys.argv[1], APP_DATA=sys.argv[3])
sys.path.insert(0, sys.argv[4])
import server
out = {}
out["get"] = server.node("/cryptarchia/info")
out["missing"] = server.node("/nothing")
out["post"] = server.node("/wallet/transactions/transfer-funds", {"amount": 5})
l = socket.socket(); l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); l.bind(("127.0.0.1", int(sys.argv[2]))); l.listen(1)
out["post_squatted"] = server.node("/wallet/transactions/transfer-funds", {"amount": 6})
out["get_guarded"] = server.node("/cryptarchia/info")
l.close()
server.NODE_API = "unix:" + sys.argv[1] + ".none"
out["no_socket"] = server.node("/cryptarchia/info")
server.NODE_API = "unix:" + sys.argv[5]
out["short_get"] = server.node("/cryptarchia/info")
out["short_post"] = server.node("/wallet/transactions/transfer-funds", {"amount": 8})
try:
    server.unix_http(sys.argv[5], "GET", "/messaging/v1/events/received")
    out["short_raw"] = "taken"
except Exception as e:
    out["short_raw"] = type(e).__name__
print(json.dumps(out))
"""
r = subprocess.run([sys.executable, "-B", "-c", probe, sock, str(guard_port), tempfile.mkdtemp(), APP, short_sock],
                   capture_output=True, text=True, timeout=60)
try:
    out = json.loads(r.stdout.strip().splitlines()[-1])
except Exception:
    out = {}
    print(r.stdout[-500:], r.stderr[-1500:])
check("a GET goes over the Unix socket", out.get("get") == [200, {"cryptarchia_info": {"height": 4242, "slot": 9000, "state": "Online"}}], out.get("get"))
check("the node's 404 comes back as such", (out.get("missing") or [0])[0] == 404, out.get("missing"))
check("a POST goes over the Unix socket, as JSON", out.get("post") == [201, {"hash": "ab" * 32, "amount": 5}], out.get("post"))
check("another program on the node's old TCP port doesn't stop a send (review S1, D3)", out.get("post_squatted") == [201, {"hash": "ab" * 32, "amount": 6}], out.get("post_squatted"))
check("and no extra call is made before a send: the node saw GET, GET, POST, POST, GET", [p[0] for p in seen] == ["GET", "GET", "POST", "POST", "GET"], seen)
check("an answer that ends short of its Content-Length is no answer, not a cut-short body (review D4)", out.get("short_get") == [0, None] and out.get("short_post") == [0, None], (out.get("short_get"), out.get("short_post")))
check("unix_http raises on it", out.get("short_raw") == "IncompleteRead", out.get("short_raw"))
check("reading still works meanwhile", (out.get("get_guarded") or [0])[0] == 200, out.get("get_guarded"))
check("no socket: no answer (status 0)", out.get("no_socket") == [0, None], out.get("no_socket"))

# ---- part 2: the app as the Android app runs it ------------------------------------------------------------------
KEY = secrets.token_hex(32)
PORT = 8098 + int(os.environ.get("PORT_SHIFT", "0"))
env = {k: v for k, v in os.environ.items() if k not in ("APP_EMBEDDED", "APP_KEY", "NODE_API")}
env.update(APP_EMBEDDED="android", APP_KEY=KEY, APP_PORT=str(PORT), APP_DATA=tempfile.mkdtemp(), NODE_BIN="/nonexistent",
           NODE_API="unix:" + sock, UPDATE_URL="http://127.0.0.1:9/")
p = subprocess.Popen([sys.executable, "-B", os.path.join(APP, "server.py")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
try:
    import urllib.request
    st = None
    for _ in range(100):
        try:
            req = urllib.request.Request("http://127.0.0.1:%d/api/status" % PORT, headers={"Cookie": "app_key=" + KEY})
            with urllib.request.urlopen(req, timeout=5) as resp:
                st = json.loads(resp.read())
            break
        except Exception:
            time.sleep(0.1)
    check("the app reads the node's state over the socket", st and (st.get("node") or {}).get("height") == 4242 and (st.get("node") or {}).get("peers") == 3, st)
finally:
    p.terminate(); p.wait(timeout=10)
    srv.shutdown(); srv.server_close()
    shutil.rmtree(tmp, ignore_errors=True)

print("all checks passed")

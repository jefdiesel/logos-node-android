#!/usr/bin/env python3
"""server.py talking to a node that serves its API on a Unix socket (node patch 0002, android/LOCAL-APIS.md).

  python3 tests/node_socket_test.py

A stand-in node answers HTTP on a Unix socket only. Part 1 calls server.py's node() in-process: GETs and POSTs
go over the socket; another program holding the old TCP port (NODE_TCP_GUARD) doesn't block sends while the node's
socket answers (review S1); with TCP answering and no socket, POSTs are refused. Part 2 runs the app as the Android
app does (APP_EMBEDDED, APP_KEY, NODE_API=unix:...) and reads the node's state through it.
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
guard_port = guard.getsockname()[1]                # free now; something listens there only in the guard check
guard.close()

# ---- part 1: node() in-process ---------------------------------------------------------------------------------
probe = r"""
import json, os, socket, sys
os.environ.update(NODE_API="unix:" + sys.argv[1], NODE_TCP_GUARD="127.0.0.1:" + sys.argv[2], APP_DATA=sys.argv[3])
sys.path.insert(0, sys.argv[4])
import server
out = {}
out["get"] = server.node("/cryptarchia/info")
out["missing"] = server.node("/nothing")
out["post"] = server.node("/wallet/transactions/transfer-funds", {"amount": 5})
l = socket.socket(); l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); l.bind(("127.0.0.1", int(sys.argv[2]))); l.listen(1)
out["post_squatted"] = server.node("/wallet/transactions/transfer-funds", {"amount": 6})
out["get_guarded"] = server.node("/cryptarchia/info")
server.NODE_API = "unix:" + sys.argv[1] + ".none"
out["no_socket"] = server.node("/cryptarchia/info")
out["post_no_socket_tcp"] = server.node("/wallet/transactions/transfer-funds", {"amount": 7})
l.close()
print(json.dumps(out))
"""
r = subprocess.run([sys.executable, "-B", "-c", probe, sock, str(guard_port), tempfile.mkdtemp(), APP],
                   capture_output=True, text=True, timeout=60)
try:
    out = json.loads(r.stdout.strip().splitlines()[-1])
except Exception:
    out = {}
    print(r.stdout[-500:], r.stderr[-1500:])
check("a GET goes over the Unix socket", out.get("get") == [200, {"cryptarchia_info": {"height": 4242, "slot": 9000, "state": "Online"}}], out.get("get"))
check("the node's 404 comes back as such", (out.get("missing") or [0])[0] == 404, out.get("missing"))
check("a POST goes over the Unix socket, as JSON", out.get("post") == [201, {"hash": "ab" * 32, "amount": 5}], out.get("post"))
check("another app holding the guarded TCP port doesn't block sends: the socket answers (review S1)", out.get("post_squatted") == [201, {"hash": "ab" * 32, "amount": 6}], out.get("post_squatted"))
check("TCP answering while the node's socket doesn't: the POST is refused (status 0)", out.get("post_no_socket_tcp") == [0, None], out.get("post_no_socket_tcp"))
check("so the node got exactly the two POSTs that were allowed", [p for p in seen if p[0] == "POST"] == [("POST", "/wallet/transactions/transfer-funds")] * 2, seen)
check("reading still works meanwhile", (out.get("get_guarded") or [0])[0] == 200, out.get("get_guarded"))
check("no socket: no answer (status 0)", out.get("no_socket") == [0, None], out.get("no_socket"))

# ---- part 2: the app as the Android app runs it ------------------------------------------------------------------
KEY = secrets.token_hex(32)
PORT = 8098 + int(os.environ.get("PORT_SHIFT", "0"))
env = {k: v for k, v in os.environ.items() if k not in ("APP_EMBEDDED", "APP_KEY", "NODE_API")}
env.update(APP_EMBEDDED="android", APP_KEY=KEY, APP_PORT=str(PORT), APP_DATA=tempfile.mkdtemp(), NODE_BIN="/nonexistent",
           NODE_API="unix:" + sock, NODE_TCP_GUARD="127.0.0.1:%d" % guard_port, UPDATE_URL="http://127.0.0.1:9/")
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

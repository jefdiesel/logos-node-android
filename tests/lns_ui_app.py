#!/usr/bin/env python3
"""The app as the Android app runs it, with the stand-in signer (fake_names_bin.py), a stand-in sequencer and
a stand-in node, for tests/lns_ui.mjs. Serves on 127.0.0.1:<port> until killed; prints "ready" when up.

  python3 tests/lns_ui_app.py <port>
"""
import http.server, json, os, shutil, signal, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
port = sys.argv[1]


class Seq(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        answer = lambda c: {"jsonrpc": "2.0", "id": c.get("id"),
                            "result": {"getAccountBalance": 5000000, "getLastBlockId": 7, "sendTransaction": "cd" * 32}.get(c.get("method"))}
        data = json.dumps([answer(c) for c in body] if isinstance(body, list) else answer(body)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


seq = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Seq)
threading.Thread(target=seq.serve_forever, daemon=True).start()
top = tempfile.mkdtemp(prefix="lns-ui-")                 # everything this run makes, removed on SIGTERM
data, node, bins = (tempfile.mkdtemp(dir=top) for _ in range(3))


def bye(*_):
    shutil.rmtree(top, ignore_errors=True)
    os._exit(0)


signal.signal(signal.SIGTERM, bye)
with open(os.path.join(node, "user_config.yaml"), "w") as f:
    f.write("kms:\n  keystore: keystore.yaml\n")
with open(os.path.join(node, "keystore.yaml"), "w") as f:
    f.write("public_keys:\n  LeaderFunding: %s\n  SdpFunding: %s\nsecret_keys:\n  LeaderFunding: %s\n" % ("a1" * 32, "b2" * 32, "c3" * 32))
for src, dst in (("fake_node_bin.py", "fake_node_bin.py"), ("fake_names_bin.py", "libnames.so")):
    shutil.copy(os.path.join(HERE, src), os.path.join(bins, dst))
    os.chmod(os.path.join(bins, dst), 0o755)
os.environ.update(APP_EMBEDDED="android", APP_PORT=port, APP_DATA=data, NODE_BIN=os.path.join(bins, "fake_node_bin.py"),
                  NODE_CFG=os.path.join(node, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="",
                  NAMES_BIN=os.path.join(bins, "libnames.so"), NAMES_RPC_URL="http://127.0.0.1:%d/" % seq.server_address[1])
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

threading.Thread(target=server.main, daemon=True).start()
time.sleep(1)
print("ready", flush=True)
while True:
    time.sleep(3600)

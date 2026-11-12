#!/usr/bin/env python3
"""A stand-in for the node's own HTTP API, for screens that need balances and a node state.

  python3 tests/fake_node_api.py <port> [online|syncing]

Answers /cryptarchia/info, /network/info and /wallet/<key>/balance (every key holds 12,500, in two notes).
POST /mode/online or /mode/syncing switches the state the node reports. POST /balance/<n> sets what every key
holds (and drops what /receive added), and POST /balance/<key>/<n> what one key holds (for the balance-size checks).
POST /receive/<key>/<n> adds a new note of n to that key, on top of what it holds: the app records that as coins
received.
"""
import http.server, json, re, sys

mode = {"state": sys.argv[2] if len(sys.argv) > 2 else "online"}
balances = {"*": 12500}
received = {}                                  # key -> {note id: amount} added by /receive


class H(http.server.BaseHTTPRequestHandler):
    def out(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        online = mode["state"] == "online"
        if self.path.startswith("/cryptarchia/info"):
            return self.out(200, {"height": 48211 if online else 31007, "slot": 960400, "tip": "aa" * 32, "lib": "bb" * 32,
                                  "state": "Online" if online else "Bootstrapping", "mode": "Online" if online else "Bootstrapping"})
        if self.path.startswith("/network/info"):
            return self.out(200, {"connected_peers": ["p1", "p2", "p3", "p4", "p5", "p6"]})
        m = re.match(r"^/wallet/([0-9a-f]{64})/balance$", self.path)
        if m:
            b = balances.get(m.group(1), balances["*"])
            notes = {"n1": 10000, "n2": 2500} if b == 12500 else {"n1": b}
            notes.update(received.get(m.group(1), {}))
            return self.out(200, {"balance": sum(notes.values()), "notes": notes})
        return self.out(404, {"code": 404, "message": "not here"})

    def do_POST(self):
        m = re.match(r"^/mode/(online|syncing)$", self.path)
        if m:
            mode["state"] = m.group(1)
            return self.out(200, {"state": mode["state"]})
        m = re.match(r"^/balance/(?:([0-9a-f]{64})/)?([0-9]+)$", self.path)
        if m:
            if m.group(1) is None:
                balances.clear(); received.clear()
            balances[m.group(1) or "*"] = int(m.group(2))
            return self.out(200, {})
        m = re.match(r"^/receive/([0-9a-f]{64})/([0-9]+)$", self.path)
        if m:
            got = received.setdefault(m.group(1), {})
            got["r%d" % (sum(len(v) for v in received.values()) + 1)] = int(m.group(2))
            return self.out(200, {})
        return self.out(404, {"code": 404})

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()

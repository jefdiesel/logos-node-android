#!/usr/bin/env python3
"""A fake Logos Messaging network for the tests: one REST "node" per port, sharing one network.

  python3 tests/fake_waku.py <control port> <node port> [<node port> ...]

Each node answers the Messaging API of logos-delivery v0.39.2 (docs/api/rest-api.md, and the record shapes
its tests-e2e check): GET /health; POST/GET /messaging/v1/subscriptions; POST /messaging/v1/messages ->
{"requestId"}; GET /messaging/v1/events/send/{requestId} -> {"requestId", "events": [{"kind", ...}]}, then
cleared, 404 while there is nothing; GET /messaging/v1/events/received -> [{"seq", "messageHash", "message":
{"payload", "contentTopic", ...}, "source"}], oldest first, then cleared, at most 50 kept. A message sent
to a topic reaches every running node subscribed to it ("live"); a node that subscribes later, or comes
back, gets what it missed ("history"). The control port: POST /down/<i>, /up/<i>, /restart/<i> (seq and
subscriptions start again), /dup/<i> (deliver the last record again), /inject/<i> with
{"topic", "payload"} (deliver anything), and GET /sent (count of messages on the network).
"""
import base64, hashlib, http.server, json, re, sys, threading, time

TOPIC = re.compile(r"^/[^/\s]+/[^/\s]+/[^/\s]+/[^/\s]+$")
lock = threading.Lock()
network = []                      # every message ever sent: {"hash", "topic", "payload", "ts"}


class Node:
    def __init__(self, port):
        self.port, self.server, self.running = port, None, False
        self.reset()

    def reset(self):
        self.subs, self.received, self.seq, self.delivered, self.sends, self.last = set(), [], 0, set(), {}, None

    def deliver(self, msg, source):
        if msg["hash"] in self.delivered:
            return
        self.delivered.add(msg["hash"])
        self.seq += 1
        self.last = {"seq": self.seq, "messageHash": msg["hash"], "source": source,
                     "message": {"payload": msg["payload"], "contentTopic": msg["topic"], "version": 0,
                                 "timestamp": msg["ts"], "ephemeral": False}}
        self.received.append(self.last)
        del self.received[:-50]

    def start(self):
        node = self

        class H(http.server.BaseHTTPRequestHandler):
            def out(self, code, obj=None, text=None):
                b = text.encode() if text is not None else json.dumps(obj).encode()
                self.send_response(code); self.send_header("Content-Type", "application/json" if text is None else "text/plain")
                self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

            def body(self):
                return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")

            def do_GET(self):
                with lock:
                    if self.path == "/health":
                        return self.out(200, {"nodeHealth": "READY", "connectionStatus": "Connected", "protocolsHealth": []})
                    if self.path == "/messaging/v1/subscriptions":
                        return self.out(200, sorted(node.subs))
                    if self.path == "/messaging/v1/events/received":
                        out, node.received = node.received, []
                        return self.out(200, out)
                    m = re.match(r"^/messaging/v1/events/send/(.+)$", self.path)
                    if m:
                        st = node.sends.pop(m.group(1), None)
                        return self.out(200, st) if st else self.out(404, text="No send events for requestId: " + m.group(1))
                return self.out(404, text="not found")

            def do_POST(self):
                try:
                    body = self.body()
                except Exception:
                    return self.out(400, text="malformed body")
                with lock:
                    if self.path == "/messaging/v1/subscriptions":
                        if not isinstance(body, list) or not all(isinstance(t, str) and TOPIC.match(t) for t in body):
                            return self.out(400, text="bad content topic")
                        for t in body:
                            node.subs.add(t)
                            for msg in network:
                                if msg["topic"] == t:
                                    node.deliver(msg, "history")
                        return self.out(200, text="OK")
                    if self.path == "/messaging/v1/messages":
                        try:
                            raw = base64.b64decode(body["payload"], validate=True)
                            assert isinstance(body["contentTopic"], str) and TOPIC.match(body["contentTopic"])
                        except Exception:
                            return self.out(400, text="bad message")
                        ts = time.time_ns()
                        h = "0x" + hashlib.sha256(body["contentTopic"].encode() + raw + str(ts).encode()).hexdigest()
                        msg = {"hash": h, "topic": body["contentTopic"], "payload": base64.b64encode(raw).decode(), "ts": ts}
                        network.append(msg)
                        node.subs.add(msg["topic"])                     # a send subscribes the sender too
                        for other in nodes:
                            if other.running and msg["topic"] in other.subs:
                                other.deliver(msg, "live")
                        rid = hashlib.sha256(h.encode()).hexdigest()[:32]
                        node.sends[rid] = {"requestId": rid, "events": [
                            {"kind": "propagated", "messageHash": h, "error": "", "timestamp": ts},
                            {"kind": "sent", "messageHash": h, "error": "", "timestamp": ts}]}
                        return self.out(200, {"requestId": rid})
                return self.out(404, text="not found")

            def log_message(self, *a):
                pass

        http.server.ThreadingHTTPServer.allow_reuse_address = True
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), H)
        self.running = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.running = False
        self.server.shutdown(); self.server.server_close()


class Control(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"sent": len(network)}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        m = re.match(r"^/(down|up|restart|dup|inject)/(\d+)$", self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")
        node = nodes[int(m.group(2))]
        act = m.group(1)
        if act == "down":
            node.stop()
        elif act == "up":
            node.start()
        elif act == "restart":
            with lock:
                node.reset()
        elif act == "dup":
            with lock:
                if node.last:
                    node.received.append(dict(node.last, seq=node.seq + 1)); node.seq += 1
        elif act == "inject":
            with lock:
                ts = time.time_ns()
                node.deliver({"hash": "0x" + hashlib.sha256(str(ts).encode()).hexdigest(), "topic": body["topic"],
                              "payload": body["payload"], "ts": ts}, "live")
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    nodes = [Node(int(p)) for p in sys.argv[2:]]
    for n in nodes:
        n.start()
    http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Control).serve_forever()

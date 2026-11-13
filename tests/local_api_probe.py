#!/usr/bin/env python3
"""What another program on the same device can do with the node's own HTTP API (android/LOCAL-APIS.md).

  NODE_API=http://127.0.0.1:8080 APP_PIN=135790 python3 tests/local_api_probe.py

Run in CI (install-test, job wallet-send) against a real node, after the web app's own send test. The web app
is used only to learn which keys the node's wallet holds; everything after that goes straight to the node API
with no PIN, no session and no credential of any kind, as any other app on a phone could.

  1. The node signs and submits a transfer for that caller. This is the exposure the node patch closes
     (native/patches on branch node-patches-api); until the app runs a node with it, this check is EXPECTED to
     pass, and it is here so that the day it stops passing is noticed.
  2. A web page in a browser can't make the same call: with cors_origins set (as the Android app writes it
     since 0.5.15, and install.sh's --http-cors-origin), the preflight from another origin gets no
     Access-Control-Allow-Origin, so the browser never sends the POST.
"""
import json, os, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

NODE_API = os.environ.get("NODE_API", "http://127.0.0.1:8080")
PIN = os.environ.get("APP_PIN", "135790")
check = W.check


def node(method, path, body=None, headers=None):
    req = urllib.request.Request(NODE_API + path, data=None if body is None else json.dumps(body).encode(), method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


# the keys the node's wallet holds (test scaffolding only: the web app knows them, another app would guess none)
code, d = W.call("/api/wallet/unlock", {"pin": PIN})
check("the web app unlocks (to learn the node's keys)", code == 200, (code, d))
accts = W.wait_accounts(d["session"], want=2)["accounts"]
rich = max(accts, key=lambda a: int(a["balance"]))
to = next(a for a in accts if a["key"] != rich["key"])
amount = 77

# 2 first: the preflight a browser would send for the same request from another website
code, h, _ = node("OPTIONS", "/wallet/transactions/transfer-funds", headers={
    "Origin": "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
acao = {k.lower(): v for k, v in h.items()}.get("access-control-allow-origin")
check("a website's preflight to the node's transfer endpoint gets no Access-Control-Allow-Origin", acao is None, (code, acao))

# 1: the same request from a program, which no browser rule applies to
# (a few tries: notes of a transfer the earlier steps made may still be pending)
for _ in range(12):
    code, _, raw = node("POST", "/wallet/transactions/transfer-funds", {
        "tip": None, "change_public_key": rich["key"], "funding_public_keys": [rich["key"]],
        "recipient_public_key": to["key"], "amount": amount})
    try:
        reply = json.loads(raw)
    except Exception:
        reply = {}
    spent = 200 <= code < 300 and isinstance(reply, dict) and bool(reply.get("hash"))
    if spent:
        break
    time.sleep(5)
print("     node answered %d to a transfer with no credential%s" % (code, (", transaction " + reply["hash"]) if spent else ""))
check("EXPOSURE (expected until the node patch): the node API signs a transfer for any local program, no PIN", spent, (code, raw[:200]))

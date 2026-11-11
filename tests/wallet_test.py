#!/usr/bin/env python3
"""End-to-end checks of the web app, run in CI against a real node.

  wallet_test.py guard   the wallet's locks: PIN, session, own-page-only, pause after wrong PINs
  wallet_test.py send    a real transfer on a private one-node chain with funded test keys
"""
import base64, hashlib, json, os, re, subprocess, sys, tempfile, time, urllib.error, urllib.request

BASE = "http://127.0.0.1:8090"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
BACKUP_PASSWORD = "correct horse battery staple"


def call(path, body=None, session=None, origin=BASE, host=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        if origin:
            req.add_header("Origin", origin)
    if session:
        req.add_header("X-Session", session)
    if host:
        req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw, code = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    try:
        return code, json.loads(raw)
    except Exception:
        return code, {"raw": raw.decode(errors="replace")[:200]}


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ((" - " + str(detail)) if detail and not cond else ""))
    if not cond:
        sys.exit(1)


def wait_accounts(session, want=1, tries=30, balances=True):
    """Waits until the wallet lists at least `want` keys, and with `balances`, a balance for every one of them.
    A node that is still syncing often can't give balances yet (its wallet trails the chain), so the app shows
    none; only the test on an online node asks for them."""
    for _ in range(tries):
        code, d = call("/api/wallet/accounts", session=session)
        if code == 200 and len(d.get("accounts", [])) >= want and (not balances or all(a["balance"] is not None for a in d["accounts"])):
            return d
        time.sleep(4)
    check("the wallet lists its keys" + (" with balances" if balances else ""), False, d)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class FakePasskey:
    """Plays the phone's part in fingerprint unlock: a P-256 key made with openssl that signs like an authenticator."""
    ORIGIN = "http://localhost:8090"

    def __init__(self):
        self.dir = tempfile.mkdtemp()
        self.key = os.path.join(self.dir, "k.pem")
        subprocess.run(["openssl", "ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", self.key], check=True, capture_output=True)
        self.spki = subprocess.run(["openssl", "ec", "-in", self.key, "-pubout", "-outform", "DER"], check=True, capture_output=True).stdout
        self.id = os.urandom(32)

    def auth_data(self, flags=0x05, rp="localhost"):
        return hashlib.sha256(rp.encode()).digest() + bytes([flags]) + (0).to_bytes(4, "big")

    def client_data(self, kind, challenge, origin=None):
        return json.dumps({"type": kind, "challenge": challenge, "origin": origin or self.ORIGIN, "crossOrigin": False}).encode()

    def sign(self, auth, client):
        msg = os.path.join(self.dir, "m")
        with open(msg, "wb") as f:
            f.write(auth + hashlib.sha256(client).digest())
        return subprocess.run(["openssl", "dgst", "-sha256", "-sign", self.key, msg], check=True, capture_output=True).stdout

    def assertion(self, challenge, **kw):
        auth = self.auth_data(kw.get("flags", 0x05), kw.get("rp", "localhost"))
        client = self.client_data("webauthn.get", challenge, kw.get("origin"))
        sig = self.sign(auth, client)
        if kw.get("tamper"):
            sig = sig[:-1] + bytes([sig[-1] ^ 1])
        return {"id": b64u(self.id), "clientDataJSON": b64u(client), "authenticatorData": b64u(auth), "signature": b64u(sig)}


def passkey_checks(s):
    """Fingerprint unlock, start to finish, and the ways it must fail. `s` is an unlocked session."""
    pk = FakePasskey()
    code, d = call("/api/wallet/passkey/challenge", {})
    check("no fingerprint challenge before it is turned on", code == 404, (code, d))
    code, d = call("/api/wallet/passkey/options", {})
    check("turning fingerprint on needs an unlocked wallet", code == 401, (code, d))
    code, o = call("/api/wallet/passkey/options", {}, session=s)
    check("setup options are issued to an unlocked wallet", code == 200 and o.get("rpId") == "localhost", (code, o))
    reg = {"id": b64u(pk.id), "publicKey": b64u(pk.spki), "authenticatorData": b64u(pk.auth_data()),
           "clientDataJSON": b64u(pk.client_data("webauthn.create", o["challenge"], "https://evil.example"))}
    code, d = call("/api/wallet/passkey/register", reg, session=s)
    check("a key offered from another website is refused", code == 400, (code, d))
    code, d = call("/api/wallet/passkey/register", dict(reg, clientDataJSON=b64u(pk.client_data("webauthn.create", o["challenge"]))), session=s)
    check("a setup challenge can't be used twice", code == 400, (code, d))
    code, o = call("/api/wallet/passkey/options", {}, session=s)
    code, d = call("/api/wallet/passkey/register", dict(reg, clientDataJSON=b64u(pk.client_data("webauthn.create", o["challenge"]))), session=s)
    check("fingerprint unlock is turned on", code == 200 and d.get("passkeys") == 1, (code, d))
    call("/api/wallet/lock", {}, session=s)

    def attempt(**kw):
        code, c = call("/api/wallet/passkey/challenge", {})
        check("a fingerprint challenge is issued", code == 200 and c.get("ids") == [b64u(pk.id)], (code, c))
        return call("/api/wallet/passkey/unlock", pk.assertion(c["challenge"], **kw))
    code, d = attempt(tamper=True)
    check("a wrong signature is refused", code == 401, (code, d))
    code, d = attempt(origin="https://evil.example")
    check("a signature made for another website is refused", code == 401, (code, d))
    code, d = attempt(flags=0x01)
    check("a signature without fingerprint confirmation is refused", code == 401, (code, d))
    code, d = attempt(rp="evil.example")
    check("a signature for another site name is refused", code == 401, (code, d))
    other = FakePasskey(); other.id = pk.id
    code, c = call("/api/wallet/passkey/challenge", {})
    code, d = call("/api/wallet/passkey/unlock", other.assertion(c["challenge"]))
    check("a signature from a different key is refused", code == 401, (code, d))
    code, c = call("/api/wallet/passkey/challenge", {})
    good = pk.assertion(c["challenge"])
    code, d = call("/api/wallet/passkey/unlock", good)
    check("the right fingerprint key unlocks the wallet", code == 200 and len(d.get("session", "")) == 64, (code, d))
    s2 = d["session"]
    code, d = call("/api/wallet/passkey/unlock", good)
    check("the same signature can't be replayed", code == 401, (code, d))
    code, d = call("/api/wallet/accounts", session=s2)
    check("the fingerprint session opens the wallet", code == 200, (code, d))
    code, d = call("/api/wallet/passkey/remove", {}, session=s2)
    check("fingerprint unlock can be turned off", code == 200 and d.get("passkeys") == 0, (code, d))
    code, d = call("/api/wallet/passkey/challenge", {})
    check("after turning it off there is no fingerprint challenge", code == 404, (code, d))
    return s2


def secret_values(path):
    """The secret key values in a node key file (64 hex characters after !Zk or !Ed25519)."""
    with open(path) as f:
        return re.findall(r"!(?:Zk|Ed25519)\s+([0-9a-fA-F]{64})", f.read())


def decrypt(backup_doc, password, out):
    """Opens a backup with the independent tool (cryptography package + hashlib.scrypt, not the app's code)."""
    src = os.path.join(tempfile.mkdtemp(), "backup.json")
    with open(src, "w") as f:
        json.dump(backup_doc, f)
    py = os.environ.get("DECRYPT_PYTHON", sys.executable)
    return subprocess.run([py, os.path.join(ROOT, "tools", "decrypt-backup.py"), src, "-o", out, "--password-stdin"],
                          input=password + "\n", capture_output=True, text=True)


def backup_checks(s, pin):
    """The wallet backup: who may export it, and that the file opens with the independent tool to the exact key file."""
    keystore = os.environ.get("KEYSTORE")
    check("KEYSTORE names the node's key file", bool(keystore) and os.path.isfile(keystore), keystore)
    code, d = call("/api/wallet/backup", {"password": BACKUP_PASSWORD, "pin": pin})
    check("a backup without an unlocked wallet is refused", code == 401, (code, d))
    code, d = call("/api/wallet/backup", {"password": "short pass", "pin": pin}, session=s)
    check("a backup password under 12 characters is refused", code == 400, (code, d))
    code, d = call("/api/wallet/backup", {"password": BACKUP_PASSWORD, "pin": pin}, session=s)
    b = d.get("backup") or {}
    check("the backup is exported", code == 200 and b.get("format") == "logos-node-wallet-backup" and b.get("version") == 1, (code, d))
    secrets_ = secret_values(keystore)
    check("the node's key file has secret keys to protect", len(secrets_) > 0, len(secrets_))
    reply = json.dumps(d)
    check("the export reply holds no secret key and no password", not any(x in reply for x in secrets_) and BACKUP_PASSWORD not in reply)
    check("the backup lists the wallet's public addresses", any(a.get("label") == "Main" for a in b.get("addresses", [])), b.get("addresses"))
    out = os.path.join(tempfile.mkdtemp(), "keystore.yaml")
    r = decrypt(b, BACKUP_PASSWORD, out)
    check("the independent tool opens the backup", r.returncode == 0, r.stderr.strip())
    with open(out, "rb") as f1, open(keystore, "rb") as f2:
        check("the recovered key file is byte for byte the node's", f1.read() == f2.read())
    out2 = os.path.join(tempfile.mkdtemp(), "keystore.yaml")
    r = decrypt(b, BACKUP_PASSWORD + "x", out2)
    check("a wrong backup password doesn't open it", r.returncode != 0 and not os.path.exists(out2), r.stdout)
    sealed = bytearray(base64.b64decode(b["ciphertext"])); sealed[len(sealed) // 2] ^= 1
    r = decrypt(dict(b, ciphertext=base64.b64encode(bytes(sealed)).decode()), BACKUP_PASSWORD, out2)
    check("a changed backup file doesn't open", r.returncode != 0 and not os.path.exists(out2), r.stdout)
    # last: a wrong PIN. It counts toward the pause after 5 wrong PINs, which the caller checks.
    code, d = call("/api/wallet/backup", {"password": BACKUP_PASSWORD, "pin": "000000"}, session=s)
    check("a backup with a wrong PIN is refused", code == 403, (code, d))
    return secrets_


def guard():
    code, d = call("/api/status", host="evil.example")
    check("status is readable under any host name", code == 200 and "node" in d, (code, d))
    code, d = call("/api/wallet", host="evil.example")
    check("wallet refuses a request addressed to another host name", code == 403, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "246810"}, origin=None)
    check("wallet refuses a POST with no Origin", code == 403, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "246810"}, origin="https://evil.example")
    check("wallet refuses a POST from another website", code == 403, (code, d))
    code, d = call("/api/wallet")
    check("no PIN is set at first", code == 200 and d.get("pin_set") is False and d.get("unlocked") is False, (code, d))
    code, d = call("/api/wallet/accounts")
    check("accounts are refused before unlocking", code == 401, (code, d))
    code, d = call("/api/wallet/history")
    check("history is refused before unlocking", code == 401 and "entries" not in d, (code, d))
    code, d = call("/api/wallet/receipts", {})
    check("new receipts are refused before unlocking", code == 401 and "receipts" not in d, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "12"})
    check("a short PIN is refused", code == 400, (code, d))
    code, d = call("/api/wallet/setup", {"pin": "246810"})
    check("setting a PIN opens a session", code == 200 and len(d.get("session", "")) == 64, (code, d))
    s = d["session"]
    code, d = call("/api/wallet/setup", {"pin": "111111"})
    check("the PIN can't be set a second time", code == 409, (code, d))
    d = wait_accounts(s, balances=False)        # the testnet node here is still syncing
    main = d["accounts"][0]
    check("the first key is the node's main key, 64 hex characters", main["label"] == "Main" and len(main["key"]) == 64, main)
    code, d = call("/api/wallet/accounts", session="0" * 64)
    check("a made-up session is refused", code == 401, (code, d))
    code, d = call("/api/wallet/send", {"from": main["key"], "to": "xyz", "amount": 5}, session=s)
    check("a malformed address is refused", code == 400, (code, d))
    code, d = call("/api/wallet/send", {"from": "ab" * 32, "to": "cd" * 32, "amount": 5}, session=s)
    check("a 'from' key outside the wallet is refused", code == 400, (code, d))
    code, st = call("/api/status")
    if (st.get("node") or {}).get("state") != "Online":
        code, d = call("/api/wallet/send", {"from": main["key"], "to": "cd" * 32, "amount": 5}, session=s)
        check("sending is refused while the node is not online", code == 409, (code, d))
    s0 = s
    key_secrets = backup_checks(s, "246810")     # ends with one wrong PIN
    s = passkey_checks(s)
    code, d = call("/api/wallet/lock", {}, session=s)
    code, d = call("/api/wallet/accounts", session=s)
    check("locking ends the session", code == 401, (code, d))
    for i in range(4):
        code, d = call("/api/wallet/unlock", {"pin": "000000"})
        check("wrong PIN %d is refused" % (i + 2), code == 401, (code, d))
    code, d = call("/api/wallet/unlock", {"pin": "246810"})
    check("after 5 wrong PINs (the first in a backup request) even the right one has to wait", code == 429 and d.get("wait", 0) > 0, (code, d))
    events_log_checks([s0, s], ["246810", "000000", BACKUP_PASSWORD] + key_secrets)


def events_log_checks(sessions, pins):
    """The wallet's event log, read from disk on this machine (the app has no way to read it over HTTP)."""
    path = os.environ.get("EVENTS_LOG")
    if not path:
        return print("     (EVENTS_LOG not set: event log not checked)")
    check("the event log is readable by its owner only", os.stat(path).st_mode & 0o077 == 0, oct(os.stat(path).st_mode))
    with open(path) as f:
        text = f.read()
    for name in ["pin set", "unlock by PIN failed", "lockout started", "fingerprint key added", "unlock by fingerprint failed",
                 "unlock by fingerprint ok", "fingerprint keys removed", "wallet locked", "backup exported", "backup refused, wrong PIN"]:
        check("the event log records '%s'" % name, " %s " % name in text, name)
    check("the event log records where requests came from", 'origin="http://127.0.0.1:8090"' in text and "user-agent=" in text)
    secrets_found = [x for x in sessions + pins if x and x in text]
    check("the event log holds no PIN, session token, backup password or key", not secrets_found, len(secrets_found))
    m = re.search(r'backup exported keystore_from="(\w+)"', text)
    print("     the backup found the key file from: %s" % (m.group(1) if m else "?"))
    code, d = call("/wallet-events.log")
    check("the event log can't be fetched from the app", code == 404 and "pin set" not in json.dumps(d), code)


def send():
    for _ in range(60):
        code, st = call("/api/status")
        if (st.get("node") or {}).get("state") == "Online":
            break
        time.sleep(3)
    check("the one-node test chain is online", (st.get("node") or {}).get("state") == "Online", st)
    code, d = call("/api/wallet/setup", {"pin": "135790"})
    check("PIN set", code == 200, (code, d))
    s = d["session"]
    accts = wait_accounts(s, want=3)["accounts"]
    for a in accts:
        print("     %-8s %s  %s" % (a["label"], a["key"][:12], a["balance"]))
    started = None
    for _ in range(40):
        code, hist = call("/api/wallet/history", session=s)
        started = next((e for e in hist.get("entries", []) if e["kind"] == "tracking started"), None)
        if started:
            break
        time.sleep(3)
    check("the history starts tracking with the balances it found", started and int(started["amount"]) > 0, hist)
    rich = max(accts, key=lambda a: int(a["balance"]))
    check("a funded test key exists", int(rich["balance"]) >= 10000, rich)
    to = [a for a in accts if a["key"] != rich["key"] and a["label"] not in ("Main", "Service")][-1]
    amount, rich0, to0 = 1000, int(rich["balance"]), int(to["balance"])
    code, d = call("/api/wallet/send", {"from": rich["key"], "to": to["key"], "amount": rich0 + 1}, session=s)
    check("sending more than the key holds is refused", code == 400, (code, d))
    code, d = call("/api/wallet/send", {"from": rich["key"], "to": to["key"], "amount": amount}, session=s)
    check("the node accepts the transfer", code == 200 and d.get("hash"), (code, d))
    h = d["hash"]
    print("     transaction", h)
    state = {}
    for _ in range(90):
        code, state = call("/api/wallet/tx?hash=" + h, session=s)
        if state.get("state") == "in_block":
            break
        time.sleep(4)
    check("the transfer lands in a block", state.get("state") == "in_block", state)
    fee = int(state["fee"])
    print("     fee paid:", fee)
    check("the fee is positive and small", 0 < fee < 100000, fee)
    after = {a["key"]: int(a["balance"]) for a in wait_accounts(s, want=3)["accounts"]}
    check("the receiver got exactly the amount", after[to["key"]] == to0 + amount, (to0, after[to["key"]]))
    check("the sender paid the amount plus the fee", after[rich["key"]] == rich0 - amount - fee, (rich0, after[rich["key"]]))
    history_checks(s, h, rich["key"], to["key"], amount, fee, started["id"])
    code, d = call("/api/wallet/backup", {"password": BACKUP_PASSWORD, "pin": "135790"}, session=s)
    check("a node with its keys in its config file has no backup to export, and says so",
          code == 409 and "nothing to export" in d.get("error", ""), (code, d))


def history_checks(s, h, frm, to, amount, fee, started_id):
    """The transfer just made, as the history and the receipt popups see it."""
    sent = got = None
    for _ in range(40):
        code, d = call("/api/wallet/history?limit=200", session=s)
        es = d.get("entries", [])
        sent = next((e for e in es if e["kind"] == "sent" and e.get("hash") == h), None)
        got = next((e for e in es if e["kind"] == "received" and e["key"] == to and e["id"] > started_id), None)
        if sent and sent.get("status") == "in block" and got:
            break
        time.sleep(3)
    print("     history:", sent, got)
    check("the history lists the transfer as sent and in a block",
          sent and sent.get("status") == "in block" and sent["key"] == frm, sent)
    check("the sent entry has the recipient, amount and fee",
          sent["to"] == to and int(sent["amount"]) == amount and int(sent["fee"]) == fee, (sent, amount, fee))
    check("the receiving key shows the amount as received", got and int(got["amount"]) == amount, got)
    ids = [e["id"] for e in d["entries"]]
    check("the history is newest first", ids == sorted(ids, reverse=True), ids[:10])
    code, r1 = call("/api/wallet/receipts", {}, session=s)
    check("the new receipt is reported to a page", code == 200 and got["id"] in [e["id"] for e in r1.get("receipts", [])], (code, r1))
    code, r2 = call("/api/wallet/receipts", {}, session=s)
    check("and not reported again", code == 200 and got["id"] not in [e["id"] for e in r2.get("receipts", [])], (code, r2))


if __name__ == "__main__":
    {"guard": guard, "send": send}[sys.argv[1]]()
    print("all checks passed")

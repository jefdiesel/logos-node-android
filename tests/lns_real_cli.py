#!/usr/bin/env python3
"""The real `names` command line against the app's forwarder and the public LEZ testnet, without spending.

  NAMES_BIN=<a names binary for this machine> python3 tests/lns_real_cli.py

CI runs it in names-build with a Linux build of the same pinned commit the Android build uses. It checks
what the stand-in signer of tests/lns_test.py can't:
- the app reads the account address out of what the real `names wallet account new public` prints
- the real wallet's RPC client reaches the sequencer through /lez-rpc/<secret>, and every method it calls
  is one the forwarder passes
- a registration the account can't pay for stops before anything is sent, and the app shows why
- the recovery phrase the real CLI prints is in no reply, log or file but the wallet's own
Nothing is sent: the new account holds nothing, and `names register` refuses before its first transaction.
"""
import os, re, secrets, shutil, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402

call, check = W.call, W.check
PIN = "468024"
W.BASE = "http://127.0.0.1:8101"
real = os.environ["NAMES_BIN"]

data, node, bins = tempfile.mkdtemp(), tempfile.mkdtemp(), tempfile.mkdtemp()
with open(os.path.join(node, "user_config.yaml"), "w") as f:
    f.write("kms:\n  keystore: keystore.yaml\n")
with open(os.path.join(node, "keystore.yaml"), "w") as f:
    f.write("public_keys:\n  LeaderFunding: %s\n  SdpFunding: %s\nsecret_keys:\n  LeaderFunding: %s\n" % ("a1" * 32, "b2" * 32, "c3" * 32))
fake_node = os.path.join(bins, "fake_node_bin.py")
shutil.copy(os.path.join(HERE, "fake_node_bin.py"), fake_node)
os.chmod(fake_node, 0o755)
os.environ.update(APP_EMBEDDED="android", APP_PORT="8101", APP_DATA=data, NODE_BIN=fake_node,
                  NODE_CFG=os.path.join(node, "user_config.yaml"), UPDATE_URL="", NODE_RESTART_CMD="", NAMES_BIN=real)
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import server  # noqa: E402

forwarded = []
real_forward = server.lns_forward


def counting_forward(raw):
    code, out = real_forward(raw)
    forwarded.append((code, raw[:200]))
    return code, out


server.lns_forward = counting_forward
threading.Thread(target=server.main, daemon=True).start()
for _ in range(80):
    try:
        if call("/api/wallet")[0] == 200:
            break
    except Exception:
        pass
    time.sleep(0.1)
s = call("/api/wallet/setup", {"pin": PIN})[1]["session"]

code, d = call("/api/wallet/lns/account", {}, session=s)
check("the real names makes the account and the app reads its address", code == 200 and server.ACCOUNT_ID_RE.match(d.get("account", "")), (code, d))
account = d["account"]
storage = os.path.join(server.LNS_HOME, "storage.json")
check("the wallet file is there, 0600", os.path.isfile(storage) and (os.stat(storage).st_mode & 0o777) == 0o600)
code, d = call("/api/wallet/lns", session=s)
check("the balance of the new account is read from the testnet: 0", code == 200 and d["balance"] in ("0", None), d)
print("balance as the testnet reports it:", d["balance"])

name = "lnsci" + secrets.token_hex(4)
code, d = call("/api/wallet/lns/register", {"name": name}, session=s)
check("register starts", code == 200, (code, d))
for _ in range(600):
    d = call("/api/wallet/lns", session=s)[1]
    if d["job"]["state"] != "running":
        break
    time.sleep(0.5)
print("job:", d["job"])
check("register stops before sending, and says the account can't pay", d["job"]["state"] == "failed"
      and re.search(r"holds 0|less than|add funds", d["job"]["error"]), d["job"])
check("no transaction was sent", not any(b"sendTransaction" in raw for _, raw in forwarded), forwarded)
check("the real CLI's calls went through the forwarder", len(forwarded) > 0 and all(c == 200 for c, _ in forwarded), forwarded)
print("forwarded calls:", len(forwarded), sorted({m for _, raw in forwarded for m in re.findall(rb'"method":\s*"(\w+)"', raw)}))

for top, _, files in os.walk(data):
    for f in files:
        p = os.path.join(top, f)
        if p == storage:
            continue
        with open(p, "rb") as fh:
            text = fh.read()
        # a recovery phrase is 12 or 24 lowercase words in a row
        check("no recovery phrase in %s" % os.path.relpath(p, data),
              not re.search(rb"(?:\b[a-z]{3,8}\b ){11,}\b[a-z]{3,8}\b", text))
print("all checks passed")

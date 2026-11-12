#!/usr/bin/env python3
# A stand-in for the `names` command line (android/NAMES.md) in tests/lns_test.py. It does what the app
# relies on, in the same shape: makes a wallet in LEE_WALLET_HOME_DIR and prints a recovery phrase the
# first time (so the test can check the app never passes it on), prints the account address, and for
# register / set-text checks the gas limit the app wrote, talks to the sequencer through LOGOS_NAMES_RPC,
# and prints progress lines with some noise. Every call is recorded in <data dir>/fake-names-calls.jsonl.
#
# Special names: "taken" fails as the real CLI does for a held name; "slow" takes 4 s.
import json, os, sys, time, urllib.request

FAKE_PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident"
ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
home = os.environ.get("LEE_WALLET_HOME_DIR", ".")
args = sys.argv[1:]
storage, config = os.path.join(home, "storage.json"), os.path.join(home, "wallet_config.json")


def record(**extra):
    gas = None
    try:
        gas = json.load(open(config)).get("gas_limit")
    except Exception:
        pass
    with open(os.path.join(home, "..", "fake-names-calls.jsonl"), "a") as f:
        f.write(json.dumps(dict(args=args, gas=gas, rpc=os.environ.get("LOGOS_NAMES_RPC"),
                                program=os.environ.get("LOGOS_NAMES_PROGRAM"), env=sorted(os.environ), **extra)) + "\n")


def rpc(method, params):
    req = urllib.request.Request(os.environ["LOGOS_NAMES_RPC"], method="POST",
                                 data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["result"]


def fail(msg):
    print("Error: " + msg, file=sys.stderr)
    sys.exit(1)


def main():
    if os.path.isdir(home) and not os.path.exists(config):   # as the real CLI: every command writes the default config
        json.dump({"gas_limit": 2000000, "sequencer": {"sequencer_addr": "https://testnet.lez.logos.co/"}}, open(config, "w"))
    if args[:3] == ["wallet", "account", "new"]:
        record()
        if not os.path.exists(config):
            json.dump({"gas_limit": 2000000, "sequencer": {"sequencer_addr": "https://testnet.lez.logos.co/"}}, open(config, "w"))
        if not os.path.exists(storage):
            json.dump({"seed": "f" * 128, "public": {ACCOUNT: "0" * 64}}, open(storage, "w"))
            print("Created a new wallet. Write down its recovery phrase and keep it safe;")
            print("it is the only way to get the wallet back:\n\n  %s\n" % FAKE_PHRASE)
        print("Generated new account with account_id Public/%s at path /0" % ACCOUNT)
        print("With pk " + "ab" * 32)
        sys.exit(0)
    if args[:3] == ["wallet", "account", "list"]:
        record()
        print("/0 Public/%s" % ACCOUNT)
        sys.exit(0)
    if not os.path.exists(storage):
        fail("there is no wallet")       # the real one would make a new wallet and print its phrase here
    gas = json.load(open(config)).get("gas_limit")
    if args and args[0] == "register":
        name = args[1]
        record()
        if args[2:] != ["--owner", "Public/" + ACCOUNT, "--term", "1y", "--wait"]:
            fail("unexpected arguments")
        if gas != 250000:
            fail("gas limit %s, not 250000" % gas)
        if name == "taken":
            fail("taken is already registered\n\nCaused by:\n    held")
        if name == "slow":
            time.sleep(4)
        print("%s takes a deposit of 1000000, held for as long as you keep the name" % name)
        print("step 1 of 2: committing to %s" % name)
        print("could not size the gas (r0vm not found); using the wallet's limit of %d" % gas, file=sys.stderr)
        rpc("getLastBlockId", [])
        print("submitted " + rpc("sendTransaction", [{"Public": "commit"}]))
        print("applied in block 7")
        print("noise that must not be shown: " + FAKE_PHRASE)
        print("payments to %s will arrive privately at Private/7AqUabc" % name)
        print("step 2 of 2: registering %s at 1700000000000 for a deposit of 1000000" % name)
        print("submitted " + rpc("sendTransaction", [{"Public": "reveal"}]))
        print("applied in block 9")
        print("%s is registered" % name)
        sys.exit(0)
    if args and args[0] == "set-text":
        record()
        if len(args) != 4:
            fail("unexpected arguments")
        if gas != 120000:
            fail("gas limit %s, not 120000" % gas)
        if args[1] == "nothold":
            fail("this wallet does not hold nothold")
        print("submitted " + rpc("sendTransaction", [{"Public": "set-text"}]))
        print("applied in block 11")
        sys.exit(0)
    fail("unknown command %s" % args)


if __name__ == "__main__":
    main()

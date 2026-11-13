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


CHAIN = os.path.join(home, "..", "fake-chain.json")     # what the name service holds: {name: {key: value}}


def chain():
    try:
        return json.load(open(CHAIN))
    except Exception:
        return {}


def chain_set(name, key=None, value=None, owner=None):
    c = chain()
    c.setdefault(name, {})
    if owner:
        c[name]["_owner"] = owner
    if key:
        c[name][key] = value
    json.dump(c, open(CHAIN, "w"))


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
        if os.path.exists(os.path.join(home, "..", "fake-signer-down")):     # the test makes the signer fail
            fail("the signer is down")
        try:
            json.load(open(config))               # as the real one: a torn config fails every command
        except Exception:
            fail("failed to parse wallet_config.json")
        try:                                  # the public accounts in this wallet file, as the real one lists them
            w = json.load(open(storage))
            accounts = list(w.get("public") or {})
        except Exception:
            fail("the wallet file doesn't read")
        if w.get("root"):                     # a wallet's root account, listed by id order (here: first)
            print("/ Public/%s" % w["root"])
        for i, a in enumerate(accounts):
            print("/%d Public/%s" % (i, a))
        sys.exit(0)
    if args == ["settings"]:                  # read-only; the app runs it in a throwaway wallet folder
        record()
        if os.environ.get("FAKE_SETTINGS_FAIL") or os.path.exists(os.path.join(home, "..", "fake-settings-fail")):
            fail("failed to read the settings")
        print(json.dumps({"admin": ACCOUNT, "mode": "deposit", "deposits": {"normal": "1000000", "three_characters": "3000000"},
                          "treasury": ACCOUNT, "prices": {"30d": "0", "1y": "0", "5y": "0"}}, indent=2))
        sys.exit(0)
    if args[:1] == ["resolve"] and len(args) == 2:   # read-only: the name's record as the name service has it
        record()
        c = chain()
        if args[1] not in c:
            fail("%s is not registered" % args[1])
        rec = dict(c[args[1]])
        owner = rec.pop("_owner", None)
        try:                                  # held_by only when this wallet holds the owner's key
            mine = owner in (json.load(open(storage)).get("public") or {})
        except Exception:
            mine = False
        print(json.dumps({"name": args[1], "held_by": owner if mine else None, "texts": rec, "page": None}, indent=2))
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
        once = os.path.join(home, "..", "fake-register-fail-once")
        if os.path.exists(once):              # one passing failure (the name service didn't answer)
            os.remove(once)
            fail("error sending request for url (connection refused)")
        if name == "leaky":                   # an error that is none of the known ones, full of things never to show
            fail("something odd happened at %s\n\nCaused by:\n    0: 1. Abandon, 2. Ability, 3. Able, 4. About, 5. Above, "
                 "6. Absent,\n    1: 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident\n    2: seed %s"
                 % (os.environ["LOGOS_NAMES_RPC"], "de" * 32))
        if name == "slow":                    # a progress line with the forwarder's address in it, then a wait
            print("the reveal did not land (error sending request for url (%s)); trying again (attempt 2 of 4)"
                  % os.environ["LOGOS_NAMES_RPC"], flush=True)
            time.sleep(4)
        w = json.load(open(storage))
        w.setdefault("private", {})["receiving-" + name] = "1" * 64
        if name == "killed":              # dies in the middle of rewriting the wallet file
            open(storage, "w").write('{"seed": "trunc')
            os._exit(9)
        json.dump(w, open(storage, "w"))
        print("%s takes a deposit of 1000000, held for as long as you keep the name" % name)
        print("step 1 of 2: committing to %s" % name)
        print("could not size the gas (r0vm not found); using the wallet's limit of %d" % gas, file=sys.stderr)
        rpc("getLastBlockId", [])
        print("submitted %s" % (rpc("sendTransaction", [{"Public": "commit"}])))
        print("applied in block 7")
        print("noise that must not be shown: " + FAKE_PHRASE)
        print("payments to %s will arrive privately at Private/7AqUabc" % name)
        print("step 2 of 2: registering %s at 1700000000000 for a deposit of 1000000" % name)
        print("submitted %s" % (rpc("sendTransaction", [{"Public": "reveal"}])))
        print("applied in block 9")
        print("%s is registered" % name)
        chain_set(name, owner=ACCOUNT)
        sys.exit(0)
    if args[:3] == ["wallet", "auth-transfer", "send"]:      # a plain public transfer, as LEZ's own wallet prints it
        record()
        o = dict(zip(args[3::2], args[4::2]))
        if sorted(o) != ["--amount", "--from", "--to"] or o["--from"] != "Public/" + ACCOUNT or not o["--amount"].isdigit():
            fail("unexpected arguments")
        if o["--amount"] == "19":             # sent and billed, but the wallet never saw it in a block
            print("Transaction hash is " + rpc("sendTransaction", [{"Public": "transfer", "amount": 19}]), flush=True)
            fail("Transaction not found in preconfigured amount of blocks")
        if o["--amount"] == "13":             # the wallet gives up waiting (as a late inclusion looks)
            print("Transaction hash is " + "ef" * 32, flush=True)
            fail("Transaction not found in 30 blocks")
        print("Transaction hash is " + rpc("sendTransaction", [{"Public": "transfer", "amount": int(o["--amount"])}]), flush=True)
        print("Transaction is included in block 12")
        print("Transaction data is PublicTransaction { signature: " + FAKE_PHRASE + " }")
        sys.exit(0)
    if args and args[0] == "set-text":
        record()
        if len(args) != 4:
            fail("unexpected arguments")
        if gas != 120000:
            fail("gas limit %s, not 120000" % gas)
        if args[1] == "nothold":
            fail("this wallet does not hold nothold")
        once = os.path.join(home, "..", "fake-settext-fail-once")
        if os.path.exists(once):              # one passing failure (the name service didn't answer)
            os.remove(once)
            fail("error sending request for url (connection refused)")
        print("submitted %s" % (rpc("sendTransaction", [{"Public": "set-text"}])))
        print("applied in block 11")
        chain_set(args[1], args[2], args[3])
        sys.exit(0)
    fail("unknown command %s" % args)


if __name__ == "__main__":
    main()

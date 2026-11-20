#!/usr/bin/env python3
# A stand-in for the LEZ 0.4 `names` (libnames04.so, android/NAMES04.md) in tests/sign04_test.py and the UI tests.
# It does what app/signer04.py relies on, in the same shape as the real one (logos-names wallet-1121):
# - `module restore`: reads the recovery phrase on standard input, prints the prompt, then one JSON line with 16 public
#   accounts derived from the phrase (a stand-in derivation: the same phrase, the same accounts), and makes storage.json.
#   A phrase with the word "zoo" in it fails as a broken restore does.
# - `wallet account get --keys`: prints `pk <hex>` (a stand-in key of the account).
# - sends (`wallet auth-transfer send`, `pay --public`, `nft init|send`, `deed claim`): progress lines as the real tool
#   prints them, with some noise, and a `sendTransaction` to LOGOS_NAMES_RPC (the app's forwarder) carrying what the
#   stand-in chain should change. `deed claim` needs NAMES_SHORTLIST to be a file.
# Every call is recorded in <wallet>/../fake-names04-calls.jsonl: its arguments, its environment's names and the
# RISC0_* values, the length of what came on standard input (never the input itself).
import hashlib, json, os, sys, time, urllib.request

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
home = os.environ.get("LEE_WALLET_HOME_DIR", ".")
args = sys.argv[1:]
nft_program = None
if args[:1] == ["--nft-program"]:
    nft_program, args = args[1], args[2:]


def b58(raw):
    n, out = int.from_bytes(raw, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def account(seed, i):
    return b58(hashlib.sha256(b"fake-account/" + seed + b"/" + str(i).encode()).digest())


def pk_of(acct):
    return hashlib.sha256(b"fake-pk/" + acct.encode()).hexdigest()


def record(**extra):
    with open(os.path.join(home, "..", "fake-names04-calls.jsonl"), "a") as f:
        f.write(json.dumps(dict(args=sys.argv[1:], at=time.time(), env=sorted(os.environ), rpc=os.environ.get("LOGOS_NAMES_RPC"),
                                program=os.environ.get("LOGOS_NAMES_PROGRAM"), shortlist=os.environ.get("NAMES_SHORTLIST"),
                                risc0={k: v for k, v in os.environ.items() if k.startswith("RISC0")}, **extra)) + "\n")


def rpc(method, params):
    req = urllib.request.Request(os.environ["LOGOS_NAMES_RPC"], method="POST",
                                 data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        reply = json.loads(r.read())
    if reply.get("error"):
        fail("the sequencer did not accept the transaction: " + str(reply["error"]))
    return reply["result"]


def fail(msg):
    print("Error: " + msg, file=sys.stderr)
    sys.exit(1)


def send(change, style="names"):
    """One transaction to the stand-in chain, landed at once."""
    h = hashlib.sha256(json.dumps(change, sort_keys=True).encode() + str(time.time()).encode()).hexdigest()
    rpc("sendTransaction", [{"fake": change}])
    if style == "wallet":
        print("Transaction hash is " + h)
        print("Stored persistent accounts at " + home)
        print("Transaction is included in block 12")
    else:
        print("submitted " + h)
        print("applied in block 12")


def opt(name):
    return args[args.index(name) + 1] if name in args else None


def main():
    if args[:2] == ["module", "restore"]:
        if os.path.exists(os.path.join(home, "storage.json")):
            fail("this wallet opens, so there is nothing to restore")
        phrase = sys.stdin.readline().strip()
        record(stdin_len=len(phrase))
        print("Input recovery phrase: ", end="")        # (no newline, as the LEZ wallet prints it)
        if "zoo" in phrase.split():
            fail("invalid mnemonic")
        seed = hashlib.sha256(b"fake-seed/" + phrase.encode()).digest()
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "storage.json"), "w") as f:        # never the phrase itself
            json.dump({"seed_check": hashlib.sha256(seed).hexdigest()}, f)
        if "legal" not in phrase.split():                 # (some runs: the JSON right after the prompt, on its line)
            print()
            print("Stored persistent accounts at " + home)
        print(json.dumps({"public": [account(seed, i) for i in range(16)], "private": account(seed, 99), "moved": []}, sort_keys=True,
                         separators=(",", ":")))       # (as serde_json prints it: keys sorted, compact)
        return
    record()
    if args[:3] == ["wallet", "account", "get"]:
        a = opt("--account-id")[len("Public/"):]
        print("Account " + a + "\nBalance 0")
        if "--keys" in args:
            print("pk " + pk_of(a))
        return
    if args[:3] == ["wallet", "auth-transfer", "send"]:
        frm, amount = opt("--from")[len("Public/"):], int(opt("--amount"))
        to = opt("--to")[len("Public/"):] if opt("--to") else None
        if amount == 13:
            fail("Public/%s holds 0; about 900000 is held for the fee while this runs" % frm)
        send({"transfer": {"from": frm, "to": to, "to_pk": opt("--to-pk"), "amount": amount}}, style="wallet")
        if amount == 31:                                  # (accepted, then waits for its block longer than a job may run)
            sys.stdout.flush()
            time.sleep(30)
        return
    if args[:1] == ["pay"]:
        name, amount = args[-2], int(args[-1])
        if name == "unused":
            fail("unused.lez's public account 9xQe has never been used on this chain, and LEZ can't credit it without its owner's public key")
        print("paying %d to %s (somewhere)" % (amount, name))
        print("fee: about 12000, at most 20000")
        frm = next(a for a in args if a.startswith("--from=Public/"))[len("--from=Public/"):]
        send({"pay": {"from": frm, "name": name, "amount": amount}})
        return
    if args[:2] == ["nft", "init"]:
        d = opt("--definition")
        holder = opt("--account")
        if "--new" in args:
            holder = account(b"new", int(time.time() * 1000) % 100000)
            print("new account Public/" + holder)
        print("making Public/%s ready for Harbour at dawn (%s)" % (holder, d))
        print("This computer can't check the NFT call first. If the network refuses it, its whole fee reserve is still paid.")
        send({"nft_init": {"program": nft_program, "definition": d, "holder": holder}})
        return
    if args[:2] == ["nft", "send"]:
        frm, to = opt("--from"), opt("--to")
        if to == "Public/" + "1" * 32:
            fail("That account isn't ready for this collection: it has to receive a holding first.")
        print("sending the NFT of Harbour at dawn from Public/%s to %s" % (frm, to))
        print("  the network sees both accounts")
        print("This computer can't check the NFT call first. If the network refuses it, its whole fee reserve is still paid.")
        send({"nft_send": {"program": nft_program, "from": frm, "to": to[len("Public/"):] if to.startswith("Public/") else to, "fee_payer": opt("--fee-payer")}})
        return
    if args[:2] == ["deed", "claim"]:
        name = args[2]
        sl = os.environ.get("NAMES_SHORTLIST")
        if not sl or not os.path.isfile(sl):
            fail("the locked-name list: NAMES_SHORTLIST names %s, which isn't a file" % sl)
        if name == "reserved":
            fail("%s is locked (one to four characters, or reserved), so it has no deed" % name)
        print("claiming the deed of %s (free): definition %s" % (name, account(b"deed", len(name))))
        print("reading the registry's bytecode from the chain")
        print("reading the NFT program deeds are minted on's bytecode from the chain")
        print("This computer can't check the call first. If the network refuses it, the fee (about 1,340,000) is still paid.")
        print("  details: at most 8,600,000 (the cap this call declares; gas limit 945000)")
        if name == "slowclaim":
            time.sleep(3)
        send({"claim": {"name": name}})
        return
    fail("the stand-in doesn't do: " + " ".join(args))


main()

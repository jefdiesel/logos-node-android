#!/usr/bin/env python3
"""Collectibles on LEZ 0.4 (app/lez04.py): the NFT states, the reader, the LNS name NFT read from the name's record,
and their routes in the app.

  python3 tests/nft04_test.py

Part 1 decodes the reference NFT program's states with the bytes the names project cut out of a real chain (Job A, in
its nft_wire.rs tests) and refuses what the program never writes. Part 2 reads NFTs from a stand-in network: the
program list per network, holdings of the phone's account and the watched ones, collections, the unreadable shown as
such. Part 3 reads an LNS name's NFT from its record (read_deed; the deeds' format is the names project's design,
not published or on any chain yet), with the record address checked against the real names command line. Part 4 runs
the app as the Android app does.
"""
import atexit, copy, hashlib, http.server, json, os, shutil, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "app")
sys.path.insert(0, APP)
import lez04  # noqa: E402

FAILS = []
_tmp = []


def mkdtemp():
    d = tempfile.mkdtemp()
    _tmp.append(d)
    return d


atexit.register(lambda: [shutil.rmtree(d, ignore_errors=True) for d in _tmp])


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (" - " + str(detail)[:300] if not ok and detail != "" else ""))
    if not ok:
        FAILS.append(name)


H = bytes.fromhex
b58, unb58 = lez04.b58encode, lez04.b58decode

# ---- part 1: states, from Job A's chain (names project, basecamp-module/rust-lib/src/nft_wire.rs tests) ----
ART = "HA47ERcmfSbDChGcYfBcC4SKaPQ8pJJnv4wxCLu1ejL5"
ART2B = "73zq8SWWULTuAb5ZNJPLt1jjuDhr65cn5J7GmGfD1QMt"
art = H("0003000000417274010000000000000000000000000000000013000000697066733a2f2f626166796172742f6d657461020000006d65")
art2b = H("000400000041727432010000000000000000000000000000000114000000697066733a2f2f62616679617274322f6d657461070000006d652c20796f75")
alice = H("01f00cbb50684466efb7410aa2097f6bcc3a07d0d2ad8acbe8d655373f619219c200000000000000000000000000000000")
carol = H("01f00cbb50684466efb7410aa2097f6bcc3a07d0d2ad8acbe8d655373f619219c201000000000000000000000000000000")
bob = H("02f00cbb50684466efb7410aa2097f6bcc3a07d0d2ad8acbe8d655373f619219c200")
m2b = H("0159eaabe9dafd662fed33b2e1c7674c93ffaa083327a6c5e3bbcf09250be6d03701000000000000000000000000000000")

d = lez04.decode_nft(art)
check("Job A's collection 'Art': a definition of supply 1, Simple, its uri and creators", d == {"state": "definition", "name": "Art", "printable_supply": 1,
      "standard": "Simple", "uri": "ipfs://bafyart/meta", "creators": "me"}, d)
d = lez04.decode_nft(art2b)
check("'Art2': Expanded, creators 'me, you'", d["state"] == "definition" and d["standard"] == "Expanded" and d["creators"] == "me, you" and d["name"] == "Art2", d)
check("alice: the master of Art with no print rights left (holds nothing)", lez04.decode_nft(alice) == {"state": "master", "definition": ART, "print_balance": 0}
      and not lez04.nft_holds(lez04.decode_nft(alice)))
check("carol: the master of Art, 1 print right (holds it)", lez04.decode_nft(carol)["print_balance"] == 1 and lez04.nft_holds(lez04.decode_nft(carol)))
check("bob: a holding of Art that holds nothing (a copy not owned)", lez04.decode_nft(bob) == {"state": "copy", "definition": ART, "owned": False} and not lez04.nft_holds(lez04.decode_nft(bob)))
check("a master of Art2", lez04.decode_nft(m2b)["definition"] == ART2B)
check("nothing: empty", lez04.decode_nft(b"") == {"state": "empty"})
for what, raw in (("an unknown tag", b"\x03" + bob[1:]), ("a trailing byte", bob + b"\x00"), ("a yes/no of 2", bob[:-1] + b"\x02"),
                  ("a name longer than 64 bytes", b"\x00" + (65).to_bytes(4, "little") + b"a" * 65 + art[8:]),
                  ("text that isn't UTF-8", b"\x00\x03\x00\x00\x00\xff\xfe\xfd" + art[8:]), ("an unknown metadata standard", art[:24] + b"\x02" + art[25:]),
                  ("a cut-off state", carol[:-1])):
    check("refused, shown as unreadable: " + what, lez04.decode_nft(raw)["state"] == "unreadable", lez04.decode_nft(raw))
check("someone's text is cleaned: no direction-changing or control characters",
      lez04.collection_of({"state": "definition", "name": "Har‮bour\x07", "printable_supply": 3, "standard": "Simple", "uri": "u", "creators": "c​"})["name"] == "Harbour")

# ---- part 2: the reader, with a stand-in network --------------------------------------------------------------------
CHANNEL = "2da7f7dfb6e51a28c942ea80391aa518253ec515e98d28cb4d83cc9e16ff5374"
PROGRAM = "ErycMYqXUUtducaYmpHZjRgdbLXchrMiV4NZRnmRDNmu"
OWN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
BASECAMP = "CCVd76Tk3WvFb63Wbuu4exMeLRTbSuMWHqxuvysapKnk"
THIRD = lez04.b58encode(bytes([5] * 32))


class Chain:
    """Answers getChannelId, getLastBlockId and getAccountView from {account: {program: bytes}}."""
    def __init__(self):
        self.channel, self.height, self.accounts, self.calls, self.down = CHANNEL, 100, {}, [], False

    def put(self, account, program, raw):
        self.accounts.setdefault(account, {})[program] = raw

    def fetch(self, url, body, cap, timeout):
        self.calls.append((url, body["method"], json.dumps(body["params"])))
        if self.down:
            raise OSError("no answer")
        m, p = body["method"], body["params"]
        if m == "getChannelId":
            res = self.channel
        elif m == "getLastBlockId":
            res = self.height
        elif m == "getAccountView":
            a = self.accounts.get(p[0]["account_id"])
            st = (a or {}).get(p[0]["program_account_id"])
            res = None if a is None else {"nonce": 0, "data": {"actor_states": {} if st is None else {p[0]["program_account_id"]: list(st)}}}
        elif m == "getAccount":
            a = self.accounts.get(p[0])
            res = None if a is None else {"nonce": 0, "data": {"actor_states": {k: list(v) for k, v in a.items()}}}
        else:
            res = None
        return 200, json.dumps({"jsonrpc": "2.0", "id": 1, "result": res}).encode()


now = [1_800_000_000.0]


def reader(chain, conf=None):
    data = mkdtemp()
    with open(os.path.join(data, "wallet-net04-config.json"), "w") as f:
        json.dump(conf or {"rpc_url": "https://lez.example/"}, f)
    return lez04.Net04(data, APP, chain.fetch, clock=lambda: now[0])


nod = lambda name: None    # noqa: E731  (no names CLI)
ch = Chain()
ch.put(OWN, PROGRAM, carol)                 # the phone's account: the master of Art, 1 print right
ch.put(BASECAMP, PROGRAM, bob[:-1] + b"\x01")  # watched: an owned copy of Art
ch.put(THIRD, PROGRAM, H("02" + "59eaabe9dafd662fed33b2e1c7674c93ffaa083327a6c5e3bbcf09250be6d037") + b"\x00")  # ready for Art2, holds nothing
ch.put(ART, PROGRAM, art)
ch.put(ART2B, PROGRAM, art2b)
lez04.NFT_GAP = 0.0
n = reader(ch)
check("no program listed at first", n.nft_view(OWN, "")["programs"] == [])
check("a program id that isn't one is refused", n.nft_change({"add_program": "hello"}, "", nod) == (400, {"error": "An NFT program is written as its account ID (base58)."}))
check("the native token is refused", n.nft_change({"add_program": "1" * 32}, "", nod)[0] == 400)
code, r = n.nft_change({"add_program": "Public/" + PROGRAM, "label": "Test ‮chain NFTs"}, "", nod)
check("adding a program (Public/ taken off), said plainly", code == 200 and "Added ErycMY…DNmu" in r["said"], r)
check("it is listed for this network (by its channel), its label cleaned", n.nft_programs(CHANNEL) == [{"program": PROGRAM, "label": "Test chain NFTs"}], n.nft_programs(CHANNEL))
check("another network's list is its own (empty)", n.nft_programs("ee" * 32) == [])
n.watch(BASECAMP)
n.watch(THIRD)
v0 = n.nft_view(OWN, "")
check("before the first read: 'Reading your NFTs…'", v0["note"] == "Reading your NFTs… this updates in a moment." and not v0["groups"], v0)
n.nft_refresh(OWN, "", nod)
v = n.nft_view(OWN, "")
check("the read asked getAccountView of each account under the program, and of each collection",
      sum(1 for c in ch.calls if c[1] == "getAccountView") == 5 and all(c[1] in ("getChannelId", "getAccountView") for c in ch.calls), ch.calls)
check("collections: Art, held by 2 of the accounts", v["collections"] == [{"program": PROGRAM, "definition": ART, "count": 2, "title": "Art"}], v["collections"])
check("by account: the phone's first, then the watched one", [g["account"] for g in v["groups"]] == [OWN, BASECAMP] and v["groups"][0]["own"] and not v["groups"][1]["own"], v["groups"])
g0 = v["groups"][0]["nfts"][0]
check("the phone's: the master, its print balance, the collection's fields, the program's label", g0["state"] == "master" and g0["print_balance"] == "1"
      and g0["collection"] == {"name": "Art", "printable_supply": "1", "standard": "Simple", "uri": "ipfs://bafyart/meta", "creators": "me"} and g0["programLabel"] == "Test chain NFTs", g0)
check("a holding that holds nothing is 'ready to receive', not an NFT", v["ready"] == [{"program": PROGRAM, "account": THIRD, "definition": ART2B,
      "collection": {"name": "Art2", "printable_supply": "1", "standard": "Expanded", "uri": "ipfs://bafyart2/meta", "creators": "me, you"}}], v["ready"])
check("no note, no unreachable once read", v["note"] is None and v["unreachable"] is None)
ch.put(BASECAMP, PROGRAM, b"\x09garbage")
ch.accounts.pop(ART2B)
n.nft_refresh(OWN, "", nod)
v = n.nft_view(OWN, "")
bc = [g for g in v["groups"] if g["account"] == BASECAMP]
check("a state that doesn't decode is listed as unreadable with why, never hidden", bc and bc[0]["nfts"][0]["state"] == "unreadable" and bc[0]["nfts"][0]["unreadable"] == "not a state the NFT program writes", bc)
check("a collection that can't be read: None (the page says 'Unreadable collection …')", v["ready"][0]["collection"] is None, v["ready"])
check("collections now: Art held by 1", v["collections"][0]["count"] == 1)
ch.down = True
n.nft_refresh(OWN, "", nod)
v = n.nft_view(OWN, "")
check("unreachable: says so, keeps the last read", v["unreachable"] == "Can't reach the bridge test network now." and v["groups"], v)
ch.down = False
check("removing the program", n.nft_change({"remove_program": PROGRAM}, "", nod)[0] == 200 and n.nft_programs(CHANNEL) == [])
for i in range(16):
    n.nft_change({"add_program": b58(bytes([i + 1] * 32))}, "", nod)
check("at most 16 programs per network", n.nft_change({"add_program": b58(bytes([99] * 32))}, "", nod)[0] == 400 and len(n.nft_programs(CHANNEL)) == 16)

lez04.NFT_GAP = 0.05
t0 = time.monotonic()
for _ in range(5):
    n.state_of("https://lez.example/", OWN, PROGRAM, None)
check("NFT reads are paced (at most one per NFT_GAP: 0.4 s on the phone, under the endpoint's 50 per 10 s)", time.monotonic() - t0 >= 0.19, time.monotonic() - t0)
check("the phone's pace is 0.4 s by default", float(os.environ.get("NET04_NFT_GAP_SECONDS", "0.4")) == 0.4)
lez04.NFT_GAP = 0.0

# ---- part 3: an LNS name's NFT, read from its record ------------------------------------------------------------------
REGISTRY = "6Yxj5k8AiuBSuMAYVQFGrYKjJGUSSaWWgoB9D9XXN3gA"
DEEDS = "CjrUpegdA1RjqDN43T8P19kAkwnD1quAkNkER8k3dw9G"
ALICE = H("59e55bfca47501b434363785c0163c79637d69d3c7d0d01307a31c49dd193531")   # `names address alice` (the real CLI)
check("a name's record address is the registry's PDA: alice under 6Yxj… is 7zjvesfs… (as `names --program 6Yxj… address alice` prints)",
      lez04.record_address(REGISTRY, ALICE) == "7zjvesfsRuXjx5b1a7bYjQvtFvGxNtH66cLgAPZ6m3MW")
ALICE_TAG = "b379ab75c5db642fee925cb72c6714f4c277027c96bbe5535c90642add9fb7f2"   # also what app/names/names.js ownerTag gives (tests/nft04_test.mjs)
check("the owner tag of alice for the phone's account is the one the names project's own resolver computes",
      lez04.owner_tag(ALICE, OWN).hex() == ALICE_TAG)
check("the deeds' NFT program id is the hex in the registry's deed.rs, in base58", unb58(DEEDS).hex() == "ae6ae5a379046c0c21b749d116a3e5ca3c6e82d0687742963744cef2e0c13fd7")
check("lez04.json reads names on that registry, deeds under that program", json.load(open(os.path.join(APP, "lez04.json")))["lns_registry"] == REGISTRY
      and json.load(open(os.path.join(APP, "lez04.json")))["deed_nft_program"] == DEEDS)
NONCE = bytes(range(32))
TAG = lez04.owner_tag(ALICE, OWN)
DEF = lez04.deed_definition_address(REGISTRY, ALICE, NONCE)
HOLD = lez04.deed_holding_address(REGISTRY, DEF, TAG)
check("the owner tag is SHA-256 of the domain, the id and the account", TAG == hashlib.sha256(b"logos-names/v5/owner" + ALICE + unb58(OWN)).digest())


def enc(s):
    return len(s.encode()).to_bytes(4, "little") + s.encode()


def record(version, owner=TAG, expires=2 ** 64 - 1, sealed=b"sealed!", claimed=0, deed=None):
    b = bytes([version]) + owner + expires.to_bytes(8, "little") + len(sealed).to_bytes(4, "little") + sealed
    if version >= 6:
        b += bytes([claimed])
    if version >= 7:
        b += (b"\x01" + unb58(deed[0]) + deed[1]) if deed else b"\x00"
    return b


DEED_DEF = b"\x00" + enc("LNS name deed") + (1).to_bytes(16, "little") + b"\x00" + enc("https://nameswallet.app/lns/deed.png") + enc("LNS registry")
MASTER = b"\x01" + unb58(DEF) + (1).to_bytes(16, "little")
NOW_MS = 1_800_000_000_000


def deed_chain(rec=None, master=MASTER, definition=DEED_DEF):
    c = Chain()
    c.put(lez04.record_address(REGISTRY, ALICE), REGISTRY, record(7, deed=(DEF, NONCE)) if rec is None else rec)
    if master is not None:
        c.put(HOLD, DEEDS, master)
    if definition is not None:
        c.put(DEF, DEEDS, definition)
    return c


def deed(c, accounts=(OWN,)):
    return lez04.read_deed(lambda a, p: (c.accounts.get(a) or {}).get(p, b""), REGISTRY, DEEDS, "alice", ALICE, list(accounts), NOW_MS)


r = deed(deed_chain())
check("the name's NFT: held by the phone's account, the definition and the registry's account for it, the definition read",
      r["status"] == "ok" and r["holder"] == OWN and r["definition"] == DEF and r["holding"] == HOLD and r["program"] == DEEDS
      and r["collection"]["name"] == "LNS name deed" and r["collection"]["uri"] == "https://nameswallet.app/lns/deed.png", r)
check("held by a watched account: found by the owner tag of that account", deed(deed_chain(), (BASECAMP, OWN))["holder"] == OWN)
check("not registered: says so", deed(Chain())["status"] == "unregistered")
check("held by another account: 'not yours', no card", deed(deed_chain(), (BASECAMP,))["status"] == "not_yours")
check("lapsed: no card", deed(deed_chain(rec=record(7, expires=NOW_MS - 1, deed=(DEF, NONCE))))["status"] == "lapsed")
check("a version 6 record (no deeds yet): no NFT claimed", deed(deed_chain(rec=record(6)))["status"] == "no_nft")
check("a version 7 record without a deed: no NFT claimed", deed(deed_chain(rec=record(7)))["status"] == "no_nft")
check("a version 5 record (ends at sealed): reads, no NFT", deed(deed_chain(rec=record(5)))["status"] == "no_nft")
OTHER_DEF = lez04.deed_definition_address(REGISTRY, ALICE, bytes(32))
for what, c in (("a deed whose definition isn't this name's and nonce's", deed_chain(rec=record(7, deed=(OTHER_DEF, NONCE)))),
                ("the holder's deed account holding nothing", deed_chain(master=None)),
                ("the holder's deed account with a balance of 0", deed_chain(master=b"\x01" + unb58(DEF) + bytes(16))),
                ("the holder's deed account holding another definition", deed_chain(master=b"\x01" + unb58(OTHER_DEF) + (1).to_bytes(16, "little"))),
                ("a copy, not the master", deed_chain(master=b"\x02" + unb58(DEF) + b"\x01")),
                ("the definition missing", deed_chain(definition=None)),
                ("a record with a trailing byte", deed_chain(rec=record(7, deed=(DEF, NONCE)) + b"\x00")),
                ("a record with a bad option tag", deed_chain(rec=record(7)[:-1] + b"\x05")),
                ("a record older than version 3", deed_chain(rec=b"\x02" + record(5)[1:]))):
    r = deed(c)
    check("unreadable, no card: " + what, r["status"] == "unreadable" and "definition" not in r, r)

# the same through the reader: the phone's name first, ids kept once worked out, never re-derived
derived = []


def derive(name):
    derived.append(name)
    return ALICE if name == "alice" else hashlib.sha256(b"x" + name.encode()).digest()


c = deed_chain()
c.channel = CHANNEL
n = reader(c)
check("a typed name is checked: 'Alice', '@bob', 'carol.lez' are taken; 'no way' isn't",
      [lez04.lns_name(x) for x in ("Alice", "@bob", "carol.lez")] == ["alice", "bob", "carol"] and n.nft_change({"add_name": "no way"}, "alice", derive)[0] == 400)
check("adding a name to look for", n.nft_change({"add_name": "bob"}, "alice", derive)[0] == 200)
n.nft_refresh(OWN, "alice", derive)
v = n.nft_view(OWN, "alice")
check("the phone's own name comes first, can't be removed; its card info is there", [x["name"] for x in v["names"]] == ["alice", "bob"] and v["names"][0]["own"]
      and v["names"][0]["status"] == "ok" and v["names"][0]["holder"] == OWN and v["names"][0]["definition"] == DEF, v["names"])
check("a name not registered: its line", v["names"][1]["status"] == "unregistered" and v["names"][1]["text"] == "Not registered on this network.")
n.nft_refresh(OWN, "alice", derive)
check("ids are worked out once per name and kept", sorted(derived) == ["alice", "bob"], derived)
check("removing a name", n.nft_change({"remove_name": "bob"}, "alice", derive)[0] == 200 and [x["name"] for x in n.nft_view(OWN, "alice")["names"]] == ["alice"])
for i in range(10):
    n.nft_change({"add_name": "n%d" % i}, "alice", derive)
check("at most 10 names besides the phone's", n.nft_change({"add_name": "n99"}, "alice", derive)[0] == 400)
nn = reader(deed_chain())
nn.nft_refresh(OWN, "alice", lambda name: None)
check("no id (no names command line): said, no card", nn.nft_view(OWN, "alice")["names"][0]["status"] == "no_id")

# ---- part 4: the app ---------------------------------------------------------------------------------------------------
chain = deed_chain()
chain.put(OWN, PROGRAM, carol)
chain.put(ART, PROGRAM, art)


class RPC(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        code, raw = chain.fetch("", body, 1 << 20, 5)
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def log_message(self, *a):
        pass


rpc = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RPC)
threading.Thread(target=rpc.serve_forever, daemon=True).start()
PORT = 8118 + int(os.environ.get("PORT_SHIFT", "0"))
adata = mkdtemp()
URL = "http://127.0.0.1:%d/" % rpc.server_address[1]
with open(os.path.join(adata, "wallet-net04-config.json"), "w") as f:
    json.dump({"rpc_url": URL}, f)
os.environ.update(APP_EMBEDDED="android", APP_PORT=str(PORT), APP_DATA=adata, NODE_BIN="/nonexistent", UPDATE_URL="", NET04_POLL_SECONDS="0.2")
lez04.POLL, lez04.NFT_GAP = 0.2, 0.0
import server  # noqa: E402
server.net04_own = lambda: OWN
server.net04_name = lambda: "alice"
server.lns_name_id = lambda name: ALICE if name == "alice" else None
threading.Thread(target=server.main, daemon=True).start()
sys.path.insert(0, HERE)
import wallet_test as W  # noqa: E402
W.BASE = "http://127.0.0.1:%d" % PORT
for _ in range(80):
    try:
        if W.call("/api/wallet")[0] == 200:
            break
    except Exception:
        pass
    time.sleep(0.1)
s = W.call("/api/wallet/setup", {"pin": "246828"})[1]["session"]
page = urllib.request.urlopen(W.BASE + "/")
html, csp = page.read().decode(), page.headers.get("Content-Security-Policy", "")
check("the page loads Collectibles after the 0.4 script", html.index("/net04/net04.js") < html.index("/net04/nft.js"))
check("the page may load fonts from the app only (font-src 'self'), nothing else from anywhere", "font-src 'self'" in csp and "default-src 'none'" in csp, csp)
for f in ("Gloock-Regular.ttf", "FiraCode-VF.ttf"):
    r = urllib.request.urlopen(W.BASE + "/net04/fonts/" + f)
    check("the bundled font %s is served, as a font, byte for byte" % f, r.headers.get("Content-Type") == "font/ttf" and r.read() == open(os.path.join(APP, "net04", "fonts", f), "rb").read())
check("no other file is served from the fonts folder", W.call("/net04/fonts/../server.py")[0] == 404 and W.call("/net04/fonts/OFL-Gloock.txt")[0] == 404)
check("the Collectibles routes need the session", W.call("/api/wallet/net04/nft")[0] == 401 and W.call("/api/wallet/net04/nft", {"add_name": "alice"})[0] == 401)
code, r = W.call("/api/wallet/net04/nft", {"add_program": PROGRAM, "label": "Test"}, session=s)
check("adding a program through the app", code == 200, r)
W.call("/api/wallet/net04/nft", session=s)
v = None
for _ in range(40):
    time.sleep(0.25)
    code, v = W.call("/api/wallet/net04/nft", session=s)
    if v.get("read_at") and v["names"] and v["names"][0]["status"] == "ok" and v["groups"]:
        break
check("the app reads the phone's NFTs and its name's NFT", v["groups"] and v["groups"][0]["nfts"][0]["definition"] == ART and v["names"][0]["name"] == "alice"
      and v["names"][0]["status"] == "ok" and v["names"][0]["holder"] == OWN, v)
print("all checks passed" if not FAILS else "%d FAILED" % len(FAILS))
sys.exit(1 if FAILS else 0)

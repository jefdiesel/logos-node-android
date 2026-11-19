"""Reads public balances on the bridge test network (LEZ 0.4), for the wallet page. Reads only.

The bridge test network is an outside endpoint (JSON-RPC over HTTPS, reset now and then): every byte it answers is
untrusted. This module never sends, never signs, and shares nothing with the rest of the wallet: no keys, no 0.3
state, no money path. It only turns answers into numbers to show, fail-closed: an answer of the wrong shape, size or
type is "can't read", never a guess and never 0.

What it reads (public-demo/WALLET-READ.md of the bridge repository): getChannelId and getLastBlockId (to see a reset),
the bridge's Config account (a PDA of the bridge program: the token program and the bridged tokens with their
decimals), each definition's name, then one getAccount per watched public account (native balance under the native
program, token holdings under the token program).

Collectibles (Settings > Network > LEZ 0.4, Wallet > Collectibles) read the NFTs of the watched accounts the same way:
getAccountView of each account under each NFT program the person listed for the network, then each collection's
definition; an LNS name's NFT from the name's record (read_deed). Still reads only, fail-closed, and nothing of it is
sent anywhere but the endpoint.

The endpoint is lez04.json's, or one entered by RPC URL and chain id (set_network: it switches only if the RPC reports
that chain id, and reads stop if it later reports another).

Settings come from a config file (lez04.json beside this file, overridden by wallet-net04-config.json in the data
folder), not constants: the chain is re-genesised now and then. The Config's address is derived from bridge_program;
a "config_account" key in either file overrides that (for a bridge whose Config lives elsewhere), and is not set by
default, so a new bridge program id moves the Config with it.
"""
import hashlib
import json
import os
import threading
import time

NETWORK = "bridge test network"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
REPLY_CAP = 256 * 1024           # bytes of one answer
STATE_CAP = 64 * 1024            # bytes of one program's state in one account
MAX_STATES = 64                  # programs with state in one account
MAX_TOKENS = 32                  # bridged tokens in the Config
MAX_HOLDINGS = 64                # holdings of one account
MAX_DECIMALS = 38
MAX_WATCHED = 10
POLL = float(os.environ.get("NET04_POLL_SECONDS", "30"))          # never more often than this
TOKENS_EVERY = 3600              # the token list is read again once an hour (and on a channel change)
DEADLINE = 15                    # seconds for one request, all of it (a slow answer is cut off)
REFRESH_DEADLINE = 60            # seconds for one whole refresh
RESET_TEXT = "The bridge test network was reset. Balances there start again."
UNREACHABLE_TEXT = "Can't reach the bridge test network now."
TOKENS_ERROR_TEXT = "Bridged tokens can't be listed right now."
PRIVATE_TEXT = "Private balances on the bridge test network are not shown yet."


# ---- base58 and ids --------------------------------------------------------------------------------------------------

def b58decode(text):
    if len(text) > 64:
        raise ValueError("too long")
    n = 0
    for ch in text:
        i = B58.find(ch)
        if i < 0:
            raise ValueError("not base58")
        n = n * 58 + i
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def b58encode(raw):
    n, out = int.from_bytes(raw, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def account_id(text):
    """A public account id, canonical: base58 that decodes to exactly 32 bytes (an optional Public/ prefix and spaces
    are dropped). No checksum: the canonical form is shown back so the person can compare. ValueError otherwise."""
    if not isinstance(text, str):
        raise ValueError("not text")
    t = "".join(text.split())
    if t.startswith("Public/"):
        t = t[len("Public/"):]
    if not t:
        raise ValueError("empty")
    raw = b58decode(t)
    if len(raw) != 32:
        raise ValueError("not 32 bytes")
    return b58encode(raw)


def short(i):
    return i[:6] + "…" + i[-4:] if len(i) > 12 else i


def config_address(program):
    """The bridge's Config: a public PDA of the bridge program with its config seed."""
    prefix = b"/LEE/v0.2/AccountId/PDA/" + b"\0" * 8
    raw = b58decode(program)
    if len(raw) != 32:
        raise ValueError("bridge program id isn't 32 bytes")
    return b58encode(hashlib.sha256(prefix + raw + b"/RFP022/bridge/config/v1/000000/").digest())


# ---- decoding, fail-closed --------------------------------------------------------------------------------------------

class Reader:
    def __init__(self, data):
        self.b, self.i = bytes(data), 0

    def take(self, n):
        if n < 0 or self.i + n > len(self.b):
            raise ValueError("short state")
        self.i += n
        return self.b[self.i - n:self.i]

    def u8(self): return self.take(1)[0]
    def u32(self): return int.from_bytes(self.take(4), "little")
    def u64(self): return int.from_bytes(self.take(8), "little")
    def u128(self): return int.from_bytes(self.take(16), "little")
    def id(self): return b58encode(self.take(32))

    def count(self, cap):
        n = self.u32()
        if n > cap:
            raise ValueError("count too large")
        return n

    def done(self):
        if self.i != len(self.b):
            raise ValueError("trailing bytes")


def state_bytes(v):
    """One program's state as the chain gives it (a JSON array of numbers 0-255) as bytes, or ValueError."""
    if not isinstance(v, list) or len(v) > STATE_CAP:
        raise ValueError("state isn't a list of bytes")
    for x in v:
        if type(x) is not int or not 0 <= x <= 255:
            raise ValueError("state isn't a list of bytes")
    return bytes(v)


def actor_states(acct):
    """The account's {program id: bytes}, or ValueError for anything else. None for an account the chain hasn't seen."""
    if acct is None:
        return None
    if not isinstance(acct, dict) or not isinstance(acct.get("data"), dict):
        raise ValueError("not an account")
    st = acct["data"].get("actor_states")
    if not isinstance(st, dict) or len(st) > MAX_STATES:
        raise ValueError("not an account")
    out = {}
    for k, v in st.items():
        if not isinstance(k, str) or len(k) > 64:
            raise ValueError("bad program id")
        out[k] = state_bytes(v)
    return out


def decode_config(b):
    """(token program, [(eth token hex, definition, decimals)]) from the Config's bytes, or ValueError."""
    r = Reader(b)
    r.take(32); r.take(20); r.u64(); r.take(32); r.take(32)        # cfg_id, vault, evm chain, lez chain, zone
    token_program = r.id()
    r.id()                                                         # admin
    tag = r.u8()
    if tag == 1:
        r.id()                                                     # pending admin
    elif tag != 0:
        raise ValueError("bad option")
    r.id(); r.id()                                                 # freezer, attestor
    for _ in range(2):
        if r.u8() > 1:
            raise ValueError("bad flag")
    tokens = []
    for _ in range(r.count(MAX_TOKENS)):
        eth = "0x" + r.take(20).hex()
        definition, decimals = r.id(), r.u8()
        if decimals > MAX_DECIMALS:
            raise ValueError("decimals out of range")
        for _ in range(r.count(4096)):
            r.u128()
        for _ in range(2):
            for _ in range(r.count(1 << 20)):
                r.u64()
        r.u128(); r.u128()
        for _ in range(3):
            if r.u8() > 1:
                raise ValueError("bad flag")
        tokens.append((eth, definition, decimals))
    tag = r.u8()
    if tag == 1:
        r.id(); r.take(32); r.u64()
    elif tag != 0:
        raise ValueError("bad root source")
    r.u128()
    r.done()
    return token_program, tokens


def decode_definition_name(b):
    """The definition's own name (plain, cleaned, at most 48 characters), or None."""
    try:
        r = Reader(b)
        if r.u8() != 1 or r.u8() != 0:                             # TokenState::Definition(Fungible)
            return None
        raw = r.take(r.count(256))
    except ValueError:
        return None
    text = raw.decode("utf-8", "replace")
    text = "".join(ch for ch in text if ch.isprintable())[:48].strip()
    return text or None


def decode_holdings(b):
    """{definition: amount} from an account's state under the token program, or ValueError."""
    if not b:
        return {}
    r = Reader(b)
    tag = r.u8()
    if tag == 1:                                                   # a definition, not a holder
        return {}
    if tag != 0:
        raise ValueError("bad token state")
    out = {}
    for _ in range(r.count(MAX_HOLDINGS)):
        d, amt = r.id(), r.u128()
        out[d] = out.get(d, 0) + amt
    r.done()
    return out


def shown(amount, decimals):
    """An integer amount with `decimals` decimals, formatted from the integer (never through a float)."""
    whole, frac = divmod(amount, 10 ** decimals)
    frac = str(frac).rjust(decimals, "0").rstrip("0") if decimals else ""
    return "{:,}".format(whole) + ("." + frac if frac else "")


# ---- NFTs (Collectibles) and LNS name NFTs, read-only ------------------------------------------------------------------
# The reference NFT program (logos-blockchain/lez-programs, programs/nft, refactor/lez-v0.4.x dea23c2), its states as the
# names project's nft_wire.rs decodes them: Borsh, a tag byte then the fields, strict (unknown tags, a bool other than 0
# or 1, text that isn't UTF-8 or longer than the program allows, trailing bytes: "unreadable", never a guess).

NFT_MAX_NAME, NFT_MAX_URI, NFT_MAX_CREATORS = 64, 256, 256
NFT_PROGRAMS_MAX = 16             # programs one network lists (as the desktop wallet)
NFT_LABEL_MAX = 40
NFT_NAMES_MAX = 10                # LNS names the person asked to see, besides the phone's own
NFT_COLLECTIONS_MAX = 64          # collection definitions read in one refresh
RECORD_SEALED_MAX = 12 * 1024     # names_core MAX_SEALED_RECORD_LEN
# lez.nameswallet.app allows 50 requests per 10 s per IP address, and a phone on home wifi shares its address with the
# desktop wallet: Collectibles asks at most one request per NFT_GAP seconds (25 per 10 s), and a whole read may take
# NFT_DEADLINE (16 programs x 11 accounts is about 75 s at that pace).
NFT_GAP = float(os.environ.get("NET04_NFT_GAP_SECONDS", "0.4"))
NFT_DEADLINE = 150
NAME_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-")


def clean(text, cap):
    """Someone else's text, safe to show: no control, format (direction-changing, zero-width) or separator characters
    other than a plain space, at most `cap` characters."""
    return "".join(ch for ch in text if ch.isprintable())[:cap].strip()


def nft_text(r, cap):
    n = r.u32()
    if n > cap:
        raise ValueError("a text field is longer than the program allows")
    try:
        return r.take(n).decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("a text field isn't UTF-8")


def nft_flag(r):
    v = r.u8()
    if v > 1:
        raise ValueError("a yes/no field holds another value")
    return v == 1


def decode_nft(b):
    """One account's state under an NFT program: {"state": "empty" | "definition" | "master" | "copy" | "unreadable", ...}."""
    if not b:
        return {"state": "empty"}
    try:
        r = Reader(b)
        tag = r.u8()
        if tag == 0:
            name, supply = nft_text(r, NFT_MAX_NAME), r.u128()
            standard = r.u8()
            if standard > 1:
                raise ValueError("an unknown metadata standard")
            out = {"state": "definition", "name": name, "printable_supply": supply, "standard": ("Simple", "Expanded")[standard],
                   "uri": nft_text(r, NFT_MAX_URI), "creators": nft_text(r, NFT_MAX_CREATORS)}
        elif tag == 1:
            out = {"state": "master", "definition": r.id(), "print_balance": r.u128()}
        elif tag == 2:
            out = {"state": "copy", "definition": r.id(), "owned": nft_flag(r)}
        else:
            raise ValueError("not a state the NFT program writes")
        r.done()
        return out
    except ValueError as e:
        return {"state": "unreadable", "why": str(e)[:80]}


def nft_holds(s):
    """Whether a state holds an NFT: a master with print rights, or an owned copy."""
    return (s["state"] == "master" and s["print_balance"] > 0) or (s["state"] == "copy" and s["owned"])


def collection_of(s):
    """A definition's fields as the page shows them (the maker's text cleaned), or None for anything else."""
    if s.get("state") != "definition":
        return None
    return {"name": clean(s["name"], NFT_MAX_NAME), "printable_supply": str(s["printable_supply"]), "standard": s["standard"],
            "uri": clean(s["uri"], NFT_MAX_URI), "creators": clean(s["creators"], NFT_MAX_CREATORS)}


def pda(program, seed):
    """A public PDA: SHA-256 of the LEE prefix, the program's 32 bytes and the 32-byte seed (lee core for_public_pda)."""
    raw = b58decode(program)
    if len(raw) != 32 or len(seed) != 32:
        raise ValueError("not 32 bytes")
    return b58encode(hashlib.sha256(b"/LEE/v0.2/AccountId/PDA/" + b"\0" * 8 + raw + seed).digest())


def sha(*parts):
    return hashlib.sha256(b"".join(parts)).digest()


def record_address(registry, name_id):
    return pda(registry, sha(b"logos-names/v5/name/", name_id))


def owner_tag(name_id, account):
    return sha(b"logos-names/v5/owner", name_id, b58decode(account))


def deed_definition_address(registry, name_id, nonce):
    return pda(registry, sha(b"lns-deed/v1/definition/", name_id, nonce))


def deed_holding_address(registry, definition, owner):
    return pda(registry, sha(b"lns-deed/v1/holding/", b58decode(definition), owner))


def decode_record(b):
    """A name record under the LNS registry: {version, owner (32 bytes), expires (ms), claimed, deed: None or
    {definition, nonce}}, or ValueError. Versions 3-6 have no deed (6 adds `claimed`); version 7 adds the deed
    (names_core decode_record of the names project's deeds work)."""
    r = Reader(b)
    version = r.u8()
    if version < 3:
        raise ValueError("a record older than this wallet reads")
    owner, expires = r.take(32), r.u64()
    r.take(r.count(RECORD_SEALED_MAX))
    claimed = nft_flag(r) if version >= 6 else False
    deed = None
    if version >= 7:
        tag = r.u8()
        if tag == 1:
            deed = {"definition": r.id(), "nonce": r.take(32)}
        elif tag != 0:
            raise ValueError("bad option")
    r.done()
    return {"version": version, "owner": owner, "expires": expires, "claimed": claimed, "deed": deed}


DEED_TEXT = {
    "unregistered": "Not registered on this network.",
    "lapsed": "Its registration has run out on this network.",
    "not_yours": "Held by an account this phone doesn't show. Watch that account in Settings → Network to see its card.",
    "no_nft": "No NFT claimed for this name yet.",
    "unreadable": "This name's NFT can't be read, so no card is shown.",
    "no_id": "Can't work out where this name's record is right now. Try again later.",
}


def read_deed(state_of, registry, nft_program, name, name_id, accounts, now_ms):
    """The NFT of the LNS name `name` (its 32-byte id `name_id`), read from the name's record: the one function the
    Collectibles page reads a name's NFT through.

    This follows the names project's LNS name NFT ("deed") design as of 2026-11-19, live on our LEZ 0.4 since then
    (tests/nft04_test.py reads a claimed deed there); the design itself is not yet published.
    `state_of(account, program)` -> bytes (b"" for none) reads one account. A card is drawn only when all of these
    hold: the record is held (not lapsed) by the owner tag of one of `accounts`; it names a deed; the deed's definition
    is the registry's PDA for this name and the record's nonce; the holder's deed account (the registry's PDA for the
    definition and the owner tag) holds that definition's master with a balance of 1; and the definition reads as an
    NFT definition. Anything else is said, never drawn."""
    out = {"name": name, "status": "unregistered"}
    try:
        raw = state_of(record_address(registry, name_id), registry)
        if not raw:
            return out
        rec = decode_record(raw)
    except ValueError as e:
        return dict(out, status="unreadable", why=str(e)[:80])
    if rec["expires"] < now_ms:
        return dict(out, status="lapsed")
    holder = next((a for a in accounts if owner_tag(name_id, a) == rec["owner"]), None)
    if holder is None:
        return dict(out, status="not_yours")
    if rec["deed"] is None:
        return dict(out, status="no_nft", holder=holder)
    d = rec["deed"]
    try:
        if deed_definition_address(registry, name_id, d["nonce"]) != d["definition"]:
            raise ValueError("the record's NFT isn't this name's")
        holding = deed_holding_address(registry, d["definition"], rec["owner"])
        h = decode_nft(state_of(holding, nft_program))
        if h["state"] != "master" or h["definition"] != d["definition"] or h["print_balance"] != 1:
            raise ValueError("the name's NFT account doesn't hold it")
        defn = collection_of(decode_nft(state_of(d["definition"], nft_program)))
        if defn is None:
            raise ValueError("the NFT's definition can't be read")
    except ValueError as e:
        return dict(out, status="unreadable", why=str(e)[:80], holder=holder)
    return dict(out, status="ok", holder=holder, definition=d["definition"], holding=holding, program=nft_program, collection=defn)


def lns_name(text):
    """A name as typed (any case, a leading @ or lns:, an old .lez ending), in its one form, or ValueError."""
    if not isinstance(text, str):
        raise ValueError("not text")
    t = text.strip().lower()
    for p in ("@", "lns:"):
        if t.startswith(p):
            t = t[len(p):]
    if t.endswith(".lez"):
        t = t[:-4]
    if not 1 <= len(t) <= 32 or not set(t) <= NAME_CHARS or t.startswith("-") or t.endswith("-"):
        raise ValueError("not an LNS name")
    return t


# ---- the reader --------------------------------------------------------------------------------------------------------

class Net04:
    """Watched accounts, and their last read. `fetch(url, body, cap, timeout)` -> (http status, bytes): the wallet's
    outside fetch (HTTPS only, no redirects, a cap, its own User-Agent)."""

    def __init__(self, data_dir, app_dir, fetch, clock=time.time):
        self.data_dir, self.app_dir, self.fetch, self.clock = data_dir, app_dir, fetch, clock
        self.lock = threading.Lock()           # this module's own: never taken with any of the wallet's locks
        self.reading = False
        self.last_try = 0.0
        self.backoff_until = 0.0
        self.tokens_at = 0.0
        self.state_file = os.path.join(data_dir, "wallet-net04-state.json")
        self.watch_file = os.path.join(data_dir, "wallet-net04-watch.json")
        self.state = self._load(self.state_file, {})
        if not isinstance(self.state, dict):
            self.state = {}
        # Collectibles: the programs listed per network, the names asked for and their ids (a file); the last read
        # (memory only)
        self.nft_file = os.path.join(data_dir, "wallet-net04-nft.json")
        self.nft = None
        self.nft_reading = False
        self.nft_last_try = 0.0
        self.nft_next = 0.0               # (time.monotonic) the next NFT read may go then

    # -- files --
    @staticmethod
    def _load(path, default):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return default

    @staticmethod
    def _save(path, obj):
        try:
            tmp = path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(obj, f)
            os.replace(tmp, path)
        except Exception:
            pass

    def config(self):
        c = self._load(os.path.join(self.app_dir, "lez04.json"), {})
        over = self._load(os.path.join(self.data_dir, "wallet-net04-config.json"), {})
        if isinstance(c, dict) and isinstance(over, dict):
            c = dict(c, **over)
        if not isinstance(c, dict):
            c = {}
        return c

    # -- watched accounts (view-only) --
    def watched(self):
        w = self._load(self.watch_file, [])
        out = []
        for x in w if isinstance(w, list) else []:
            try:
                i = account_id(x)
            except ValueError:
                continue
            if i not in out:
                out.append(i)
        return out[:MAX_WATCHED]

    def watch(self, text):
        """(200, {"id", "watched"}) or (400, {"error"})."""
        try:
            i = account_id(text)
        except ValueError:
            return 400, {"error": "That isn't a public account id: base58 that decodes to exactly 32 bytes."}
        with self.lock:
            w = self.watched()
            if i not in w:
                if len(w) >= MAX_WATCHED:
                    return 400, {"error": "At most %d addresses can be watched." % MAX_WATCHED}
                w.append(i)
                self._save(self.watch_file, w)
                self.last_try = 0.0            # read it at the next look
        return 200, {"id": i, "short": short(i), "watched": w}

    def unwatch(self, text):
        try:
            i = account_id(text)
        except ValueError:
            return 400, {"error": "That isn't a public account id."}
        with self.lock:
            w = [x for x in self.watched() if x != i]
            self._save(self.watch_file, w)
            accts = self.state.get("accounts")
            if isinstance(accts, dict):
                accts.pop(i, None)
                self._save(self.state_file, self.state)
        return 200, {"watched": w}

    # -- RPC --
    def rpc(self, url, method, params, end=None):
        """The result, or raises: Unreachable for no answer, a 5xx/429, a body that isn't a JSON-RPC answer, or no time
        left before `end` (time.monotonic). The fetch gets the seconds it may take in all (at most DEADLINE)."""
        body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        left = DEADLINE if end is None else min(DEADLINE, end - time.monotonic())
        if left <= 0:
            raise Unreachable("too slow")
        try:
            code, raw = self.fetch(url, body, REPLY_CAP, left)
        except Exception:
            raise Unreachable("no answer")
        if code in (429, 503):
            self.backoff_until = self.clock() + (10 if code == 429 else 5)
            raise Unreachable("busy")
        if code != 200 or not isinstance(raw, (bytes, bytearray)) or len(raw) > REPLY_CAP:
            raise Unreachable("HTTP %s" % code)
        try:
            reply = json.loads(raw)
        except Exception:
            raise Unreachable("not JSON")
        if not isinstance(reply, dict) or "error" in reply or "result" not in reply:
            raise Unreachable("not an answer")
        return reply["result"]

    # -- one refresh --
    def refresh(self, own):
        """Reads the network now; returns the new state (also kept and written when it changed)."""
        c = self.config()
        url = c.get("rpc_url") if isinstance(c.get("rpc_url"), str) else ""
        bridge = c.get("bridge_program") if isinstance(c.get("bridge_program"), str) else ""
        native = c.get("native_program") if isinstance(c.get("native_program"), str) else "1" * 32
        symbols = c.get("symbols") if isinstance(c.get("symbols"), dict) else {}
        old = self.state
        new = dict(old)
        now = self.clock()
        end = time.monotonic() + REFRESH_DEADLINE
        rpc = lambda method, params: self.rpc(url, method, params, end)
        ids = []
        for i in ([own] if own else []) + self.watched():
            if i and i not in ids:
                ids.append(i)
        try:
            if not url:
                raise Unreachable("no endpoint set")
            channel = rpc("getChannelId", [])
            height = rpc("getLastBlockId", [])
            if not isinstance(channel, str) or len(channel) > 128 or type(height) is not int or height < 0:
                raise Unreachable("odd chain identity")
            pinned = c.get("chain_id")             # a network entered by URL and chain id is read only while it is that chain
            if isinstance(pinned, str) and pinned and pinned.lower() != channel.lower():
                raise Unreachable("another chain")
            reset = (old.get("channel") and old["channel"] != channel) or \
                    (old.get("channel") == channel and isinstance(old.get("height"), int) and height < old["height"])
            if reset:
                new = {"reset_at": now}
            new.update(channel=channel, height=height)
            # the bridged tokens: on a new channel, after an hour, or if not read yet
            if reset or new.get("tokens") is None or now - self.tokens_at > TOKENS_EVERY or new.get("tokens_channel") != channel:
                cfg_id = c.get("config_account") if isinstance(c.get("config_account"), str) else (config_address(bridge) if bridge else "")
                cfg = rpc("getAccount", [cfg_id]) if cfg_id else None
                if cfg is None:                   # no Config to read: say the list can't be read, never show none
                    if old.get("tokens") and old.get("tokens_channel") == channel:
                        new = {"reset_at": now, "channel": channel, "height": height}    # the Config is gone: a reset
                    new.update(tokens=[], token_program=None, tokens_error=TOKENS_ERROR_TEXT, tokens_channel=channel)
                else:
                    try:
                        st = actor_states(cfg)
                        tp, entries = decode_config(st.get(bridge, b""))
                        toks = []
                        for eth, definition, decimals in entries:
                            name = None
                            try:
                                dst = actor_states(rpc("getAccount", [definition])) or {}
                                name = decode_definition_name(dst.get(tp, b""))
                            except (ValueError, Unreachable):
                                if time.monotonic() > end:     # out of time: read the list again next time,
                                    raise Unreachable("too slow")  # rather than keep it an hour without names
                            sym = symbols.get(eth) if isinstance(symbols.get(eth), str) else None
                            toks.append({"definition": definition, "decimals": decimals,
                                         "symbol": (sym or "token " + short(definition))[:16], "name": name})
                        new.update(tokens=toks, token_program=tp, tokens_error=None, tokens_channel=channel)
                    except ValueError:
                        new.update(tokens=[], token_program=None, tokens_error=TOKENS_ERROR_TEXT,
                                   tokens_channel=channel)
                self.tokens_at = now
            accts = dict(new.get("accounts") or {})               # (empty after a reset: new was started afresh)
            for i in ids:
                try:
                    st = actor_states(rpc("getAccount", [i]))
                    if st is None:
                        accts[i] = {"nothing": True, "at": now}
                        continue
                    nb = st.get(native, b"")
                    if len(nb) > 16:
                        raise ValueError("native balance too long")
                    hold = decode_holdings(st.get(new.get("token_program") or "", b""))
                    accts[i] = {"native": int.from_bytes(nb, "little"), "holdings": {k: v for k, v in hold.items()},
                                "at": now}
                except ValueError:
                    accts[i] = {"unreadable": True, "at": now}
            new["accounts"] = {k: v for k, v in accts.items() if k in ids}
            new["read_at"] = now
            new.pop("unreachable", None)
        except Unreachable as e:
            new["unreachable"] = str(e)[:80]
            new["tried_at"] = now
        if new != old:
            self.state = new
            self._save(self.state_file, {k: v for k, v in new.items()})
        return self.state

    def look(self, own):
        """The page looked: read again in the background if the last read is POLL seconds old (one read at a time,
        and not while the endpoint asked to wait)."""
        now = self.clock()
        with self.lock:
            if self.reading or now - self.last_try < POLL or now < self.backoff_until:
                return False
            self.reading, self.last_try = True, now

        def run():
            try:
                self.refresh(own)
            except Exception:
                pass
            finally:
                self.reading = False
        threading.Thread(target=run, name="net04-read", daemon=True).start()
        return True

    # -- what the page shows --
    def view(self, own):
        s = self.state
        toks = s.get("tokens") or []
        # a read that has run past its own deadline (an answer trickling in, or none) counts as "can't reach" now
        slow = self.reading and self.clock() - self.last_try > REFRESH_DEADLINE + 5
        out = {"network": NETWORK, "short": "LEZ 0.4", "private": PRIVATE_TEXT, "tokens_error": s.get("tokens_error"),
               "reset": RESET_TEXT if s.get("reset_at") and self.clock() - s["reset_at"] < 86400 else None, "unreachable": UNREACHABLE_TEXT if s.get("unreachable") or slow else None,
               "height": s.get("height") if type(s.get("height")) is int else None,
               "read_at": s.get("read_at"), "accounts": []}
        ids = ([own] if own else []) + [w for w in self.watched() if w != own]
        for i in ids:
            a = (s.get("accounts") or {}).get(i)
            row = {"id": i, "short": short(i), "own": i == own, "view_only": i != own}
            if not a:
                row["status"] = "not read yet"
            elif a.get("nothing"):
                row.update(status="nothing", text="Nothing on this network", at=a.get("at"))
            elif a.get("unreadable"):
                row.update(status="unreadable", text="Can't read this account", at=a.get("at"))
            else:
                held = a.get("holdings") or {}
                row.update(status="ok", at=a.get("at"), native=shown(int(a.get("native", 0)), 0),
                           tokens=[{"symbol": t["symbol"], "name": t.get("name"),
                                    "amount": shown(int(held.get(t["definition"], 0)), int(t["decimals"]))} for t in toks],
                           other_tokens=len([d for d in held if d not in {t["definition"] for t in toks}]))
            out["accounts"].append(row)
        return out


    # -- Collectibles: the NFT programs listed per network, the LNS names asked for, and their last read --
    def nft_file_load(self):
        d = self._load(self.nft_file, {})
        if not isinstance(d, dict):
            d = {}
        progs = d.get("programs") if isinstance(d.get("programs"), dict) else {}
        names = [n for n in (d.get("names") if isinstance(d.get("names"), list) else []) if isinstance(n, str)]
        ids = d.get("ids") if isinstance(d.get("ids"), dict) else {}
        return {"programs": progs, "names": names, "ids": ids}

    def nft_programs(self, channel):
        """The programs listed for the network with this channel: [{program, label, added}]."""
        out = []
        for e in self.nft_file_load()["programs"].get(channel or "", []) if channel else []:
            try:
                p = account_id(e.get("program"))
            except (ValueError, AttributeError):
                continue
            label = e.get("label") if isinstance(e.get("label"), str) else None
            if p not in [x["program"] for x in out]:
                out.append({"program": p, "label": clean(label, NFT_LABEL_MAX) if label else None})
        return out[:NFT_PROGRAMS_MAX]

    def nft_names(self, own_name):
        """The LNS names Collectibles looks for: the phone's own first, then the ones the person added."""
        out = [own_name] if own_name else []
        for n in self.nft_file_load()["names"]:
            try:
                n = lns_name(n)
            except ValueError:
                continue
            if n not in out:
                out.append(n)
        return out[:NFT_NAMES_MAX + 1]

    def channel_now(self):
        """The channel of the network in use: the last read's, or asked now."""
        if isinstance(self.state.get("channel"), str):
            return self.state["channel"]
        c = self.config()
        url = c.get("rpc_url") if isinstance(c.get("rpc_url"), str) else ""
        ch = self.rpc(url, "getChannelId", [])
        if not isinstance(ch, str) or len(ch) > 128:
            raise Unreachable("odd chain identity")
        return ch

    def nft_change(self, body, own_name, derive):
        """Add or remove an NFT program, or a name to look for. (200, {"said"}) or (4xx/503, {"error"})."""
        ch = None
        if "add_program" in body or "remove_program" in body:
            try:
                p = account_id(body.get("add_program", body.get("remove_program")))
            except ValueError:
                return 400, {"error": "An NFT program is written as its account ID (base58)."}
            if p == "1" * 32:
                return 400, {"error": "That is the native token, not an NFT program."}
            try:
                ch = self.channel_now()             # programs are listed per network: by its channel
            except Unreachable:
                return 503, {"error": UNREACHABLE_TEXT}
        with self.lock:
            d = self.nft_file_load()
            if ch is not None:
                lst = [e for e in d["programs"].get(ch, []) if isinstance(e, dict) and e.get("program") != p]
                if "add_program" in body:
                    if len(lst) >= NFT_PROGRAMS_MAX:
                        return 400, {"error": "The wallet lists at most %d NFT programs per network: remove one first." % NFT_PROGRAMS_MAX}
                    label = clean(body.get("label"), NFT_LABEL_MAX) if isinstance(body.get("label"), str) else ""
                    lst.append({"program": p, "label": label or None, "added": int(self.clock())})
                    said = "Added %s. Its NFTs show in a moment." % short(p)
                else:
                    said = "Removed %s." % short(p)
                d["programs"][ch] = lst
            elif "add_name" in body or "remove_name" in body:
                try:
                    n = lns_name(body.get("add_name", body.get("remove_name")))
                except ValueError:
                    return 400, {"error": "That isn't an LNS name: 1 to 32 of a-z, 0-9 and -, like alice."}
                names = [x for x in d["names"] if x != n]
                if "add_name" in body:
                    if len(names) >= NFT_NAMES_MAX:
                        return 400, {"error": "At most %d names can be shown: stop showing one first." % NFT_NAMES_MAX}
                    names.append(n)
                    said = "Looking for %s's NFT. It shows in a moment." % n
                else:
                    said = "Stopped showing %s." % n
                d["names"] = names
            else:
                return 400, {"error": "Nothing to change."}
            d["ids"] = {k: v for k, v in d["ids"].items() if k in d["names"] or k == own_name}
            self._save(self.nft_file, d)
            self.nft_last_try = 0.0                 # read again at the next look
        return 200, {"said": said}

    def name_id(self, name, derive):
        """The name's 32-byte id: kept once worked out (it never changes), else from `derive` (the names CLI); None."""
        d = self.nft_file_load()
        h = d["ids"].get(name)
        if isinstance(h, str) and len(h) == 64:
            try:
                return bytes.fromhex(h)
            except ValueError:
                pass
        try:
            i = derive(name)
        except Exception:
            i = None
        if not isinstance(i, (bytes, bytearray)) or len(i) != 32:
            return None
        with self.lock:
            d = self.nft_file_load()
            d["ids"][name] = bytes(i).hex()
            self._save(self.nft_file, d)
        return bytes(i)

    def state_of(self, url, account, program, end):
        """One account's state under one program (getAccountView), as bytes: b"" for none; ValueError for a malformed
        answer; Unreachable for no answer. Paced: at most one every NFT_GAP seconds."""
        wait = self.nft_next - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self.nft_next = time.monotonic() + NFT_GAP
        st = actor_states(self.rpc(url, "getAccountView", [{"account_id": account, "program_account_id": program}], end))
        return (st or {}).get(program, b"")

    def nft_refresh(self, own, own_name, derive, mine=()):
        """Reads the NFTs and the names' NFTs now; keeps the result in memory (nothing of it is written). `mine`: every
        account of the phone's LEZ 0.4 wallet (restored from the recovery phrase): a name held by any of them is the
        phone's, matched by its owner tag here, with no read per account."""
        c = self.config()
        url = c.get("rpc_url") if isinstance(c.get("rpc_url"), str) else ""
        registry = c.get("lns_registry") if isinstance(c.get("lns_registry"), str) else ""
        deed_program = c.get("deed_nft_program") if isinstance(c.get("deed_nft_program"), str) else ""
        end = time.monotonic() + NFT_DEADLINE
        now = self.clock()
        ids = []
        for i in ([own] if own else []) + self.watched():
            if i and i not in ids:
                ids.append(i)
        new = {"read_at": now, "programs": [], "names": []}
        try:
            if not url:
                raise Unreachable("no endpoint set")
            channel = self.rpc(url, "getChannelId", [], end)
            if not isinstance(channel, str) or len(channel) > 128:
                raise Unreachable("odd chain identity")
            pinned = c.get("chain_id")
            if isinstance(pinned, str) and pinned and pinned.lower() != channel.lower():
                raise Unreachable("another chain")
            new["channel"] = channel
            defs = {}
            for p in self.nft_programs(channel):
                entry = {"program": p["program"], "label": p["label"], "holdings": []}
                try:
                    for a in ids:
                        s = decode_nft(self.state_of(url, a, p["program"], end))
                        entry["holdings"].append(dict(s, account=a))
                        dd = s.get("definition")
                        if dd and (p["program"], dd) not in defs and len(defs) < NFT_COLLECTIONS_MAX:
                            try:
                                defs[(p["program"], dd)] = collection_of(decode_nft(self.state_of(url, dd, p["program"], end)))
                            except ValueError:
                                defs[(p["program"], dd)] = None
                except ValueError:
                    entry = {"program": p["program"], "label": p["label"], "error": "Its answer can't be read."}
                for h in entry.get("holdings", []):
                    if h.get("definition"):
                        h["collection"] = defs.get((p["program"], h["definition"]))
                new["programs"].append(entry)
            now_ms = int(now * 1000)
            for n in self.nft_names(own_name):
                nid = self.name_id(n, derive) if registry and deed_program else None
                if nid is None:
                    new["names"].append({"name": n, "status": "no_id"})
                    continue
                new["names"].append(read_deed(lambda a, prog: self.state_of(url, a, prog, end), registry, deed_program, n, nid,
                                              ids + [m for m in mine if m not in ids], now_ms))
            new.pop("unreachable", None)
        except Unreachable as e:
            old = self.nft or {}
            new = dict(old, unreachable=str(e)[:80], tried_at=now)
        self.nft = new
        return new

    def nft_look(self, own, own_name, derive, mine=()):
        """Collectibles looked: read again in the background if the last read is POLL seconds old."""
        now = self.clock()
        with self.lock:
            if self.nft_reading or now - self.nft_last_try < POLL or now < self.backoff_until:
                return False
            self.nft_reading, self.nft_last_try = True, now

        def run():
            try:
                self.nft_refresh(own, own_name, derive, mine)
            except Exception:
                pass
            finally:
                self.nft_reading = False
        threading.Thread(target=run, name="net04-nft", daemon=True).start()
        return True

    def nft_view(self, own, own_name, mine=()):
        """What Collectibles shows: the names with their NFTs, the collections with how many accounts hold each, the
        NFTs by account, the holdings ready to receive, and the programs listed. With `mine` (the phone's LEZ 0.4
        accounts, when it can sign there), a name held by one of them with no NFT yet is marked `claim` when it is in
        the normal tier by its length (5-32 characters; a reserved one is refused by the registry when claimed), and
        each NFT an account of `mine` holds is marked `mine` (it can be sent)."""
        s = self.nft or {}
        ch = s.get("channel") or self.state.get("channel")
        listed = self.nft_programs(ch)
        read = {e["program"]: e for e in s.get("programs", [])} if s.get("channel") == ch else {}
        slow = self.nft_reading and self.clock() - self.nft_last_try > NFT_DEADLINE + 5
        out = {"network": NETWORK, "read_at": s.get("read_at"), "unreachable": UNREACHABLE_TEXT if s.get("unreachable") or slow else None,
               "note": None if s.get("read_at") or s.get("unreachable") else "Reading your NFTs… this updates in a moment.",
               "programs": [], "collections": [], "groups": [], "ready": [], "names": []}
        groups = {}
        for p in listed:
            e = read.get(p["program"], {})
            out["programs"].append({"program": p["program"], "label": p["label"], "error": e.get("error")})
            for h in e.get("holdings", []):
                a = h["account"]
                if nft_holds(h) or h["state"] == "unreadable":
                    g = groups.setdefault(a, {"account": a, "own": a == own, "mine": a in mine, "nfts": []})
                    g["nfts"].append({"program": p["program"], "programLabel": p["label"], "definition": h.get("definition"),
                                      "state": h["state"], "print_balance": str(h["print_balance"]) if "print_balance" in h else None,
                                      "collection": h.get("collection"), "unreadable": h.get("why")})
                    if nft_holds(h):
                        c = next((x for x in out["collections"] if x["program"] == p["program"] and x["definition"] == h["definition"]), None)
                        if c is None:
                            col = h.get("collection")
                            out["collections"].append({"program": p["program"], "definition": h["definition"], "count": 1,
                                                       "title": col["name"] if col and col["name"] else "Unreadable collection " + short(h["definition"])})
                        else:
                            c["count"] += 1
                elif h["state"] in ("master", "copy"):
                    out["ready"].append({"program": p["program"], "account": a, "definition": h["definition"], "collection": h.get("collection")})
        order = ([own] if own else []) + [w for w in self.watched() if w != own]
        out["groups"] = [groups[a] for a in order if a in groups]
        names_read = {n["name"]: n for n in s.get("names", [])} if s.get("channel") == ch else {}
        for n in self.nft_names(own_name):
            r = names_read.get(n, {"status": None})
            row = {"name": n, "own": n == own_name, "status": r["status"] or "not_read",
                   "text": DEED_TEXT.get(r["status"]) if r["status"] else "Not read yet."}
            if r["status"] == "ok":
                row.update(holder=r["holder"], definition=r["definition"], holding=r["holding"], program=r["program"])
            elif r["status"] == "no_nft" and r.get("holder"):
                row["holder"] = r["holder"]
                row["claim"] = r["holder"] in mine and 5 <= len(n) <= 32
                if r["holder"] in mine and len(n) < 5:
                    row["text"] = "Locked (one to four characters): it has no NFT."
            out["names"].append(row)
        return out

    # -- the network: our LEZ 0.4, or one entered by RPC URL and chain id --
    def network(self):
        c = self.config()
        over = self._load(os.path.join(self.data_dir, "wallet-net04-config.json"), {})
        custom = isinstance(over, dict) and isinstance(over.get("rpc_url"), str) and isinstance(over.get("chain_id"), str)
        return {"rpc_url": c.get("rpc_url") if isinstance(c.get("rpc_url"), str) else "", "custom": custom,
                "chain_id": over.get("chain_id") if custom else None}

    def set_network(self, url, chain_id):
        """Switch to the network at `url`, only if it reports `chain_id` (getChannelId): (200, {...}) or (4xx/503,
        {"error"}). url None: back to our LEZ 0.4 (lez04.json). The saved state of the network left is dropped, so
        nothing of it shows as a reset of the new one."""
        path = os.path.join(self.data_dir, "wallet-net04-config.json")
        over = self._load(path, {})
        if not isinstance(over, dict):
            over = {}
        if url is None:
            over.pop("rpc_url", None)
            over.pop("chain_id", None)
        else:
            if not isinstance(url, str) or not url_ok(url.strip()):
                return 400, {"error": "The RPC URL starts with https:// and names a host."}
            if not isinstance(chain_id, str) or len(chain_id.strip()) != 64 or any(ch not in "0123456789abcdefABCDEF" for ch in chain_id.strip()):
                return 400, {"error": "The chain id is 64 hexadecimal characters (0-9, a-f)."}
            url, chain_id = url.strip(), chain_id.strip().lower()
            try:
                got = self.rpc(url, "getChannelId", [])
            except Unreachable:
                return 503, {"error": "That RPC URL isn't answering. Nothing was changed."}
            if not isinstance(got, str) or got.lower() != chain_id:
                return 409, {"error": "That RPC reports another chain id, so the wallet didn't switch. Nothing was changed.",
                             "reported": got[:128] if isinstance(got, str) else None}
            over.update(rpc_url=url, chain_id=chain_id)
        with self.lock:
            if over:
                self._save(path, over)
            else:
                try:
                    os.remove(path)
                except OSError:
                    pass
            self.state, self.nft, self.tokens_at = {}, None, 0.0
            self.last_try = self.nft_last_try = 0.0
            try:
                os.remove(self.state_file)
            except OSError:
                pass
        return 200, self.network()


def url_ok(url):
    """An RPC URL the wallet may be pointed at: https with a host (plain http only to this machine, for tests), as the
    wallet's outside fetch allows."""
    for scheme, local in (("https://", False), ("http://127.0.0.1:", True), ("http://localhost:", True)):
        if url.startswith(scheme):
            host = url[len(scheme):].split("/", 1)[0]
            return bool(host) and (local or all(ch.isalnum() or ch in ".-:" for ch in host)) and not any(ch.isspace() for ch in url)
    return False


class Unreachable(Exception):
    pass

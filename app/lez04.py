"""Reads public balances on the bridge test network (LEZ 0.4), for the wallet page. Reads only.

The bridge test network is an outside endpoint (JSON-RPC over HTTPS, reset now and then): every byte it answers is
untrusted. This module never sends, never signs, and shares nothing with the rest of the wallet: no keys, no 0.3
state, no money path. It only turns answers into numbers to show, fail-closed: an answer of the wrong shape, size or
type is "can't read", never a guess and never 0.

What it reads (public-demo/WALLET-READ.md of the bridge repository): getChannelId and getLastBlockId (to see a reset),
the bridge's Config account (a PDA of the bridge program: the token program and the bridged tokens with their
decimals), each definition's name, then one getAccount per watched public account (native balance under the native
program, token holdings under the token program).

Settings come from a config file (lez04.json beside this file, overridden by wallet-net04-config.json in the data
folder), not constants: the chain is re-genesised now and then.
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
TIMEOUT = 8                      # seconds per request
RESET_TEXT = "The bridge test network was reset. Balances there start again."
UNREACHABLE_TEXT = "Can't reach the bridge test network now."
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
    def rpc(self, url, method, params):
        """The result, or raises: Unreachable for no answer, a 5xx/429 or a body that isn't a JSON-RPC answer."""
        body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        try:
            code, raw = self.fetch(url, body, REPLY_CAP, TIMEOUT)
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
        ids = []
        for i in ([own] if own else []) + self.watched():
            if i and i not in ids:
                ids.append(i)
        try:
            if not url:
                raise Unreachable("no endpoint set")
            channel = self.rpc(url, "getChannelId", [])
            height = self.rpc(url, "getLastBlockId", [])
            if not isinstance(channel, str) or len(channel) > 128 or type(height) is not int or height < 0:
                raise Unreachable("odd chain identity")
            reset = (old.get("channel") and old["channel"] != channel) or \
                    (old.get("channel") == channel and isinstance(old.get("height"), int) and height < old["height"])
            if reset:
                new = {"reset_at": now}
            new.update(channel=channel, height=height)
            # the bridged tokens: on a new channel, after an hour, or if not read yet
            if reset or new.get("tokens") is None or now - self.tokens_at > TOKENS_EVERY or new.get("tokens_channel") != channel:
                cfg_id = c.get("config_account") if isinstance(c.get("config_account"), str) else (config_address(bridge) if bridge else "")
                cfg = self.rpc(url, "getAccount", [cfg_id]) if cfg_id else None
                if cfg is None:
                    if old.get("tokens") and old.get("tokens_channel") == channel:
                        new = {"reset_at": now, "channel": channel, "height": height}    # the Config is gone: a reset
                    new.update(tokens=[], token_program=None, tokens_error=None, tokens_channel=channel)
                else:
                    try:
                        st = actor_states(cfg)
                        tp, entries = decode_config(st.get(bridge, b""))
                        toks = []
                        for eth, definition, decimals in entries:
                            name = None
                            try:
                                dst = actor_states(self.rpc(url, "getAccount", [definition])) or {}
                                name = decode_definition_name(dst.get(tp, b""))
                            except (ValueError, Unreachable):
                                pass
                            sym = symbols.get(eth) if isinstance(symbols.get(eth), str) else None
                            toks.append({"definition": definition, "decimals": decimals,
                                         "symbol": (sym or "token " + short(definition))[:16], "name": name})
                        new.update(tokens=toks, token_program=tp, tokens_error=None, tokens_channel=channel)
                    except ValueError:
                        new.update(tokens=[], token_program=None, tokens_error="Can't read the bridge's token list.",
                                   tokens_channel=channel)
                self.tokens_at = now
            accts = dict(new.get("accounts") or {})               # (empty after a reset: new was started afresh)
            for i in ids:
                try:
                    st = actor_states(self.rpc(url, "getAccount", [i]))
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
        out = {"network": NETWORK, "short": "LEZ 0.4", "private": PRIVATE_TEXT, "tokens_error": s.get("tokens_error"),
               "reset": RESET_TEXT if s.get("reset_at") and self.clock() - s["reset_at"] < 86400 else None, "unreachable": UNREACHABLE_TEXT if s.get("unreachable") else None,
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


class Unreachable(Exception):
    pass

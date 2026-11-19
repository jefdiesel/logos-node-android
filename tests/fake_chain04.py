"""A stand-in LEZ 0.4 network for the signer's tests (tests/sign04_test.py, tests/lns_ui_app.py with WITH_SIGNER04=1):
balances, NFT states under any program, LNS name records with or without their NFT ("deed"), and the faucet. The
stand-in tool (fake_names04_bin.py) sends {"fake": <change>} in sendTransaction; this applies it at once.

  chain = Chain04(); code, raw = chain.handle(json_body)
"""
import hashlib, json, os, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import lez04  # noqa: E402

CFG = json.load(open(os.path.join(HERE, "..", "app", "lez04.json")))
REGISTRY, DEEDS, NATIVE = CFG["lns_registry"], CFG["deed_nft_program"], CFG["native_program"]
CHANNEL = "2da7f7dfb6e51a28c942ea80391aa518253ec515e98d28cb4d83cc9e16ff5374"
FEE = 3000
txt = lambda t: len(t.encode()).to_bytes(4, "little") + t.encode()     # noqa: E731
u128 = lambda n: n.to_bytes(16, "little")                               # noqa: E731


def name_id(name):
    """The stand-in id the stand-in LEZ 0.3 tool prints for `names address <name>` (fake_names_bin.py)."""
    return hashlib.sha256(b"fake-id/" + name.encode()).digest()


class Chain04:
    def __init__(self):
        self.lock = threading.Lock()
        self.balances = {}            # account id (or "pk:<hex>") -> native balance
        self.states = {}              # (account, program) -> bytes
        self.calls = []               # every method asked, in order
        self.sent = []                # every change applied
        self.faucet_given = {}        # owner -> params
        self.faucet_params = []
        self.mode = "ok"              # "down": every call 503; "busy": 429 to reads

    # ---- setting up ----
    def register(self, name, owner, deed=False):
        nid = name_id(name)
        tag = lez04.owner_tag(nid, owner)
        if not deed:
            self.states[(lez04.record_address(REGISTRY, nid), REGISTRY)] = b"\6" + tag + (2 ** 64 - 1).to_bytes(8, "little") + txt("sealed") + b"\0"
            return
        nonce = hashlib.sha256(b"nonce/" + name.encode()).digest()
        d = lez04.deed_definition_address(REGISTRY, nid, nonce)
        self.states[(lez04.record_address(REGISTRY, nid), REGISTRY)] = b"\7" + tag + (2 ** 64 - 1).to_bytes(8, "little") + txt("sealed") + b"\0" + b"\1" + lez04.b58decode(d) + nonce
        self.states[(lez04.deed_holding_address(REGISTRY, d, tag), DEEDS)] = b"\1" + lez04.b58decode(d) + u128(1)
        self.states[(d, DEEDS)] = b"\0" + txt("LNS name deed") + u128(1) + b"\0" + txt("https://nameswallet.app/lns/deed.png") + txt("LNS registry")

    def holder_of(self, name):
        raw = self.states.get((lez04.record_address(REGISTRY, name_id(name)), REGISTRY))
        return lez04.decode_record(raw) if raw else None

    # ---- the changes the stand-in tool sends ----
    def apply(self, ch):
        self.sent.append(ch)
        if "transfer" in ch:
            t = ch["transfer"]
            self.balances[t["from"]] = self.balances.get(t["from"], 0) - t["amount"] - FEE
            to = t["to"] or "pk:" + t["to_pk"]
            self.balances[to] = self.balances.get(to, 0) + t["amount"]
        elif "pay" in ch:
            self.balances[ch["pay"]["from"]] = self.balances.get(ch["pay"]["from"], 0) - ch["pay"]["amount"] - FEE
        elif "nft_init" in ch:
            i = ch["nft_init"]
            self.states[(i["holder"], i["program"])] = b"\2" + lez04.b58decode(i["definition"]) + b"\0"
            self.balances.setdefault(i["holder"], 0)
        elif "nft_send" in ch:
            s = ch["nft_send"]
            held = self.states.get((s["from"], s["program"]), b"")
            self.states[(s["to"], s["program"])] = held
            self.states[(s["from"], s["program"])] = b"\2" + held[1:33] + b"\0"
        elif "claim" in ch:
            rec = self.holder_of(ch["claim"]["name"])
            nid = name_id(ch["claim"]["name"])
            nonce = hashlib.sha256(b"nonce/" + ch["claim"]["name"].encode()).digest()
            d = lez04.deed_definition_address(REGISTRY, nid, nonce)
            self.states[(lez04.record_address(REGISTRY, nid), REGISTRY)] = b"\7" + rec["owner"] + (2 ** 64 - 1).to_bytes(8, "little") + txt("sealed") + b"\0" + b"\1" + lez04.b58decode(d) + nonce
            self.states[(lez04.deed_holding_address(REGISTRY, d, rec["owner"]), DEEDS)] = b"\1" + lez04.b58decode(d) + u128(1)
            self.states[(d, DEEDS)] = b"\0" + txt("LNS name deed") + u128(1) + b"\0" + txt("https://nameswallet.app/lns/deed.png") + txt("LNS registry")

    # ---- JSON-RPC ----
    def account(self, a):
        st = {p: list(v) for (acct, p), v in self.states.items() if acct == a}
        if a in self.balances:
            st[NATIVE] = list(u128(max(0, self.balances[a])))
        return {"nonce": 0, "data": {"actor_states": st}} if st else None

    def answer(self, c):
        m, p = c.get("method"), c.get("params") or []
        self.calls.append(m)
        r = {"jsonrpc": "2.0", "id": c.get("id")}
        if m == "getChannelId":
            r["result"] = CHANNEL
        elif m == "getLastBlockId":
            r["result"] = 40
        elif m == "getAccount":
            r["result"] = self.account(p[0])
        elif m == "getAccountView":
            st = self.states.get((p[0].get("account_id"), p[0].get("program_account_id")))
            r["result"] = None if st is None and p[0].get("account_id") not in self.balances else {"nonce": 0, "data": {"actor_states": {} if st is None else {p[0]["program_account_id"]: list(st)}}}
        elif m == "getAccountBalance":
            r["result"] = max(0, self.balances.get(p[0], 0))
        elif m == "sendTransaction":
            ch = p[0].get("fake") if p and isinstance(p[0], dict) else None
            if ch:
                self.apply(ch)
            r["result"] = "cd" * 32
        elif m == "bridge_faucetInfo":
            r["result"] = {"amount": "10000000", "per_account_hours": 0, "available": True, "reason": None}
        elif m == "bridge_faucet":
            self.faucet_params.append(p)
            owner = p[2] if len(p) > 2 else None
            if owner in self.faucet_given:
                r["result"] = {"ok": False, "code": "already_used", "reason": "This wallet already got its free test LEZ: once per wallet, ever.", "retry": False}
            else:
                self.faucet_given[owner] = p
                self.balances[owner] = self.balances.get(owner, 0) + 10000000
                r["result"] = {"ok": True, "tx": "ab" * 32, "block": 41, "amount": "10000000", "account": owner}
        else:
            r["result"] = {"getFeeState": {"base_fee_exec": 8, "base_fee_stor": 8}}.get(m)
        return r

    def handle(self, body):
        """(http status, bytes) for one JSON-RPC body (object or batch)."""
        with self.lock:
            if self.mode == "down":
                return 503, b'{"error":"down"}'
            if self.mode == "busy" and not any(c.get("method") == "sendTransaction" for c in (body if isinstance(body, list) else [body])):
                self.calls.append("(429)")
                return 429, b'{"error":"slow down"}'
            out = [self.answer(c) for c in body] if isinstance(body, list) else self.answer(body)
        return 200, json.dumps(out).encode()

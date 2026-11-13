"""A stand-in for the node's wallet, mempool and chain, as tests/xfer_test.py needs it: what the real node did in the
CI probes (android/LOCAL-APIS.md, "Transfers") and what its source says.

  - POST /wallet/fund picks the largest unreserved notes of the key, adds the change, signs, and reserves those notes
    (in memory: a restart of the node forgets them; they lapse `lapse` blocks later). It submits nothing.
  - POST /mempool/add/tx answers 200 with an empty body, whatever it is given; a transfer already in the pool is kept
    once; one whose notes are spent is dropped at the next block. Two transfers that share a note may both sit in the
    pool; exactly one of them lands.
  - A block takes the pool in order (or some of it), applies each transfer whose notes are all unspent, drops the
    others; a transfer leaves the pool `ttl` seconds after it was added.
  - /cryptarchia/blocks_range is one JSON object per line, ascending from slot_from, at most blocks_limit.
  - Fees are realistic (866 to 2,054), never a token 7.
Faults: `fail[path]` is a list of what the next calls to that path do: "lost" (the node does it, the answer is lost:
status 0), "unreached" (nothing done, status 0), "500", "408". `crash[path]` raises Crash before ("before") or after
("after") the node acts, to stand for the app dying there.
"""
import hashlib, json, random


class Crash(Exception):
    pass


def nid(*parts):
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


def tx_hash(mantle_tx):
    ops = mantle_tx["ops"]
    b = bytes([len(ops)])
    for op in ops:
        p = op["payload"]
        b += bytes([0, len(p["inputs"])]) + b"".join(bytes.fromhex(i) for i in p["inputs"]) + bytes([len(p["outputs"])])
        for o in p["outputs"]:
            b += int(o["value"]).to_bytes(8, "little") + bytes.fromhex(o["pk"])
    return hashlib.blake2b(b"MANTLE_TXHASH_V1" + b, digest_size=32).hexdigest()


class Chain:
    def __init__(self, keys, seed=0, lapse=10, ttl=9 * 3600):
        self.rng = random.Random(seed)
        self.keys = list(keys)
        self.notes = {}                      # note id -> (key, value), unspent
        self.spent = set()
        self.reserved = {}                   # note id -> slot it was reserved at
        self.pool = []                       # [(hash, signed, added at)]
        self.blocks = []                     # [{"slot", "txs": [hash]}]
        self.landed = {}                     # hash -> slot
        self.slot = 100
        self.lapse, self.ttl, self.now = lapse, ttl, 0.0
        self.fail, self.crash = {}, {}
        self.posts = []                      # (path, hash or None)
        self.funded = {}                     # hash -> the funded transfer (all the node ever signed)
        self.serial = 0
        self.online = True

    # ---- the world --------------------------------------------------------------------------------------------
    def credit(self, key, value):
        self.serial += 1
        i = nid("credit", key, value, self.serial)
        self.notes[i] = (key, value)
        return i

    def spend_outside(self, key):
        """Someone else (another device with the same keys) spends one note of `key`."""
        mine = sorted(i for i, (k, v) in self.notes.items() if k == key)
        if not mine:
            return None
        i = self.rng.choice(mine)
        del self.notes[i]
        self.spent.add(i)
        self.slot += 1
        self.blocks.append({"slot": self.slot, "txs": ["outside-" + i]})
        return i

    def restart_node(self):
        self.reserved.clear()

    def block(self, take_all=True):
        self.slot += self.rng.choice((1, 1, 2, 3))
        self.pool = [(h, s, at) for h, s, at in self.pool if self.now - at < self.ttl]
        txs = []
        keep = []
        for h, signed, at in self.pool:
            if not take_all and self.rng.random() < 0.3:
                keep.append((h, signed, at))
                continue
            p = signed["mantle_tx"]["ops"][0]["payload"]
            if all(i in self.notes for i in p["inputs"]) and h not in self.landed:
                for i in p["inputs"]:
                    del self.notes[i]
                    self.spent.add(i)
                    self.reserved.pop(i, None)
                for n, o in enumerate(p["outputs"]):
                    if o["value"] > 0:
                        self.notes[nid(h, n)] = (o["pk"], int(o["value"]))
                self.landed[h] = self.slot
                txs.append(h)
        self.pool = keep
        self.blocks.append({"slot": self.slot, "txs": txs})
        for i in [i for i, s in self.reserved.items() if self.slot - s >= self.lapse]:
            del self.reserved[i]
        return txs

    # ---- the node's API ---------------------------------------------------------------------------------------
    def call(self, path, body=None, timeout=8):
        mode = (self.fail.get(path) or [None]).pop(0) if self.fail.get(path) else None
        when = (self.crash.get(path) or [None]).pop(0) if self.crash.get(path) else None
        if when == "before":
            raise Crash(path)
        if mode == "unreached":
            return 0, None
        if mode in ("500", "408") and path != "/mempool/add/tx":
            return int(mode), {"code": int(mode), "message": "Failed"}
        code, reply = self.answer(path, body)
        if when == "after":
            raise Crash(path)
        if mode == "lost":
            return 0, None
        if mode in ("500", "408"):
            return int(mode), {"code": int(mode), "message": "Failed to add tx"}
        return code, reply

    def answer(self, path, body):
        if path == "/cryptarchia/info":
            return 200, {"cryptarchia_info": {"height": len(self.blocks), "slot": self.slot,
                                              "state": "Online" if self.online else "Bootstrapping"}}
        if path == "/network/info":
            return 200, {"connected_peers": ["p"]}
        if path.startswith("/wallet/") and path.endswith("/balance"):
            key = path.split("/")[2]
            n = {i: v for i, (k, v) in self.notes.items() if k == key}
            return 200, {"balance": sum(n.values()), "notes": n, "address": key}
        if path == "/wallet/fund":
            return self.fund(body)
        if path == "/mempool/add/tx":
            p = body["mantle_tx"]["ops"][0]["payload"]
            h = tx_hash(body["mantle_tx"])
            self.posts.append((path, h))
            if h in self.funded and h not in self.landed and all(h != x for x, _, _ in self.pool):
                self.pool.append((h, body, self.now))
            return 200, None
        return 404, {"code": 404}

    def fund(self, body):
        key = body["funding_public_keys"][0]
        out = body["tx_builder"]["pending_transfer"]["outputs"]
        amount = sum(int(o["value"]) for o in out)
        free = sorted(((v, i) for i, (k, v) in self.notes.items() if k == key and i not in self.reserved), reverse=True)
        picked, total = [], 0
        for v, i in free:
            picked.append(i)
            total += v
            fee = 866 + 120 * len(picked) + self.rng.randrange(0, 600)
            if total >= amount + fee:
                break
        else:
            return 500, {"code": 500, "message": "Wallet does not have enough funds, available=%d" % sum(v for v, _ in free)}
        change = total - amount - fee
        outputs = [dict(o) for o in out] + ([{"value": change, "pk": body["change_public_key"]}] if change > 0 else [])
        tx = {"ops": [{"opcode": 0, "payload": {"inputs": picked, "outputs": outputs}}]}
        for i in picked:
            self.reserved[i] = self.slot
        h = tx_hash(tx)
        self.funded[h] = tx
        self.posts.append(("/wallet/fund", h))
        return 200, {"tip": "00" * 32, "funded_tx": tx, "transfer_proof": {"ZkSig": {"pi_a": "aa", "pi_b": "bb", "pi_c": "cc"}}}

    def raw(self, path, timeout=8):
        mode = (self.fail.get("raw") or [None]).pop(0) if self.fail.get("raw") else None
        if mode:
            return 0, None
        if not path.startswith("/cryptarchia/blocks_range"):
            return 404, None
        q = dict(x.split("=") for x in path.split("?", 1)[1].split("&"))
        lo, limit = int(q.get("slot_from", 0)), int(q.get("blocks_limit", 100))
        bs = [b for b in self.blocks if b["slot"] >= lo][:limit]
        lines = [json.dumps({"block": {"header": {"slot": b["slot"]},
                                       "transactions": [{"mantle_tx": {"hash": h, "ops": []}, "ops_proofs": []} for h in b["txs"]]},
                             "tip": "00" * 32, "tip_slot": self.slot}) for b in bs]
        return 200, ("\n".join(lines) + ("\n" if lines else "")).encode()

    # ---- what really happened -----------------------------------------------------------------------------------
    def may_land(self, h):
        """Whether the transfer `h` can still land: in the pool, not landed, its notes unspent."""
        if h in self.landed:
            return False
        for x, s, at in self.pool:
            if x == h and self.now - at < self.ttl:
                return all(i in self.notes for i in s["mantle_tx"]["ops"][0]["payload"]["inputs"])
        return False

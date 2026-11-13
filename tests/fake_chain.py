"""A stand-in for the node's wallet, mempool and chain, as tests/xfer_test.py needs it: what the real node did in the
CI probes (android/LOCAL-APIS.md, "Transfers") and what its source says.

  - POST /wallet/fund picks the largest unreserved notes of the key, adds the change, signs, and reserves those notes
    (in memory: a restart of the node forgets them; they lapse `lapse` blocks later). It submits nothing.
  - POST /mempool/add/tx answers 200 with an empty body, whatever it is given; a transfer already in the pool is kept
    once; one whose notes are spent is dropped at the next block. Two transfers that share a note may both sit in the
    pool; exactly one of them lands.
  - Blocks: each takes the pool in order (or some of it) and applies each transfer whose notes are all unspent. The
    chain forks: reorg(r) drops the last r blocks (never at or below the last irreversible block, `k` blocks under
    the tip, as the node's fork choice allows), and their transactions go back to the pool, as the node's
    `reorged_txs` does; the next blocks may take them in another order, so of two conflicting transfers the other
    one may land.
  - A transfer leaves the pool `ttl` seconds after it was added.
  - /cryptarchia/blocks_range is one JSON object per line, ascending from slot_from (400 above the tip), at most
    blocks_limit, with header id, parent_block and slot, the transactions' hashes and ops, and lib_slot.
  - Fees are realistic (866 to 2,054 and more), never a token 7.
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


OUTSIDER = "ee" * 32


class Chain:
    def __init__(self, keys, seed=0, lapse=10, ttl=9 * 3600, k=6):
        self.rng = random.Random(seed)
        self.keys = list(keys)
        self.reserved = {}                   # note id -> block count it was reserved at
        self.pool = []                       # [(hash, tx, added at)]  tx: {"inputs", "outputs"} (our signed ones)
        self.world = []                      # transactions of others (credits, outside spends) not in a block yet
        self.blocks = []                     # canonical: [{"id", "parent", "slot", "txs": [(hash, tx)]}]
        self.slot = 100
        self.k = k
        self.lapse, self.ttl, self.now = lapse, ttl, 0.0
        self.fail, self.crash = {}, {}
        self.posts = []                      # (path, hash or None)
        self.funded = {}                     # hash -> the funded transfer (all the node ever signed)
        self.signed = {}                     # hash -> the signed body submitted
        self.serial = 0
        self.online = True
        self.outside_spends = 0
        self.outside_spent = set()            # notes others spent (a fork may give them back)
        self.credits = []                    # (key, value) of every payment to the wallet, and again when a fork
                                             # took it out and gives it back, or gives back a note spent elsewhere
        self.world_reorged = 0               # others' transactions a fork took out (they come back in the next block)
        self.lib = -1                        # index of the last irreversible block: it never moves back
        self.notes = {}
        self._replay()

    # ---- the ledger: replayed from the canonical blocks ------------------------------------------------------------
    def _replay(self):
        notes = {}
        for b in self.blocks:
            for h, tx in b["txs"]:
                for i in tx["inputs"]:
                    notes.pop(i, None)
                for n, o in enumerate(tx["outputs"]):
                    if int(o["value"]) > 0:
                        notes[nid(h, n)] = (o["pk"], int(o["value"]))
        self.notes = notes

    @property
    def landed(self):
        return {h: b["slot"] for b in self.blocks for h, tx in b["txs"]}

    def lib_index(self):
        return self.lib

    def lib_slot(self):
        i = self.lib_index()
        return self.blocks[i]["slot"] if i >= 0 else 0

    def final(self, h):
        i = self.lib_index()
        return any(x == h for b in self.blocks[:i + 1] for x, _ in b["txs"]) if i >= 0 else False

    def _append(self, txs):
        self.slot += self.rng.choice((1, 1, 2, 3))
        parent = self.blocks[-1]["id"] if self.blocks else "00" * 32
        self.serial += 1
        self.blocks.append({"id": nid("block", self.serial, self.slot), "parent": parent, "slot": self.slot, "txs": txs})
        self.lib = max(self.lib, len(self.blocks) - 1 - self.k)
        self._replay()

    # ---- the world --------------------------------------------------------------------------------------------
    def credit(self, key, value):
        """Someone pays `key`: in a block of its own at once."""
        self.serial += 1
        h = nid("credit", key, value, self.serial)
        self.credits.append((key, value))
        self._append([(h, {"inputs": [], "outputs": [{"value": value, "pk": key}]})])
        return nid(h, 0)

    def spend_outside(self, key):
        """Someone else (another device with the same keys) spends one note of `key`, in a block at once."""
        mine = sorted(i for i, (k, v) in self.notes.items() if k == key)
        if not mine:
            return None
        i = self.rng.choice(mine)
        self.serial += 1
        h = nid("outside", i, self.serial)
        self._append([(h, {"inputs": [i], "outputs": [{"value": self.notes[i][1], "pk": OUTSIDER}]})])
        self.outside_spends += 1
        self.outside_spent.add(i)
        return i

    def restart_node(self):
        self.reserved.clear()

    def block(self, take_all=True):
        self.pool = [(h, t, at) for h, t, at in self.pool if self.now - at < self.ttl]
        txs, keep, spent = [], [], set()
        for h, tx, at in self.pool:
            if not take_all and self.rng.random() < 0.3:
                keep.append((h, tx, at))
                continue
            if all(i in self.notes and i not in spent for i in tx["inputs"]) and h not in self.landed:
                spent.update(tx["inputs"])
                txs.append((h, tx))
            elif not all(i in self.notes for i in tx["inputs"]) or h in self.landed:
                continue                     # can't land on this chain now: dropped
            else:
                keep.append((h, tx, at))     # conflicts with one in this block: dropped at the next
        txs = txs + self.world
        self.world = []
        self.pool = keep
        self._append(txs)
        for i in list(self.reserved):
            if i not in self.notes or len(self.blocks) - self.reserved[i] >= self.lapse:
                del self.reserved[i]
        return [h for h, _ in txs]

    def reorg(self, r):
        """The node moves to a fork r blocks back (never at or below the last irreversible block): those blocks'
        transactions go back to the pool (others' to the world), to be taken again in any order."""
        r = min(r, self.k, len(self.blocks) - 1 - self.lib)
        if r <= 0:
            return 0
        gone = self.blocks[-r:]
        self.blocks = self.blocks[:-r]
        self._replay()
        for b in gone:
            for h, tx in b["txs"]:
                if h in self.funded:
                    if all(x != h for x, _, _ in self.pool):
                        self.pool.append((h, tx, self.now))
                else:
                    self.world.append((h, tx))
                    self.world_reorged += 1
                    for o in tx["outputs"]:
                        if o["pk"] != OUTSIDER:
                            self.credits.append((o["pk"], int(o["value"])))
                    for i in tx["inputs"]:   # a note spent elsewhere comes back: it shows up as received again
                        for b2 in self.blocks:
                            for x, t in b2["txs"]:
                                for n, o in enumerate(t["outputs"]):
                                    if nid(x, n) == i:
                                        self.credits.append((o["pk"], int(o["value"])))
        self.rng.shuffle(self.pool)
        return r

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
            tip = self.blocks[-1]["slot"] if self.blocks else 0
            return 200, {"cryptarchia_info": {"height": len(self.blocks), "slot": tip,
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
            h = tx_hash(body["mantle_tx"])
            self.posts.append((path, h))
            if h in self.funded and h not in self.landed and all(h != x for x, _, _ in self.pool):
                self.signed[h] = body
                self.pool.append((h, self.funded[h], self.now))
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
            self.reserved[i] = len(self.blocks)
        h = tx_hash(tx)
        self.funded[h] = {"inputs": picked, "outputs": outputs}
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
        tip = self.blocks[-1]["slot"] if self.blocks else 0
        if lo > tip:
            return 400, b'{"code":400,"message":"SlotFromAboveSlotTo"}'
        bs = [b for b in self.blocks if b["slot"] >= lo][:limit]
        lib = self.lib_slot()
        lines = [json.dumps({"block": {"header": {"id": b["id"], "parent_block": b["parent"], "slot": b["slot"]},
                                       "transactions": [{"mantle_tx": {"hash": h, "ops": [{"opcode": 0, "payload": tx}]}, "ops_proofs": []}
                                                        for h, tx in b["txs"]]},
                             "tip": self.blocks[-1]["id"], "tip_slot": tip, "lib": "00" * 32, "lib_slot": lib}) for b in bs]
        return 200, ("\n".join(lines) + ("\n" if lines else "")).encode()

    # ---- what really happened -----------------------------------------------------------------------------------
    def may_land(self, h):
        """Whether the transfer `h` can still land (or land again after a reorg): in the pool with its notes
        unspent, or in a block that isn't final yet."""
        if h in self.landed:
            return not self.final(h)
        for x, tx, at in self.pool:
            if x == h and self.now - at < self.ttl:
                return all(i in self.notes for i in tx["inputs"])
        return False

    def dead(self, h):
        """Whether `h` can never land: one of its notes is spent by another transaction in a final block."""
        tx = self.funded.get(h)
        if not tx or h in self.landed:
            return False
        i = self.lib_index()
        spent = {n for b in self.blocks[:i + 1] for x, t in b["txs"] if x != h for n in t["inputs"]} if i >= 0 else set()
        return bool(set(tx["inputs"]) & spent)

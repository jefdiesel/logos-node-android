# Patches to the node

The native build compiles the official node source at a release tag. The **patched** variant
applies the files here, in order, after the clone (`native/apply-patches.sh`); the build stops if
any of them does not apply cleanly. The **unpatched** variant is still built from the untouched
source, as a separate artifact, so the two can be compared.

| Artifact | What it is |
|---|---|
| `logos-blockchain-node-android-arm64-<version>` | official source, no patches |
| `logos-blockchain-node-android-arm64-<version>-patched` | the same source with the patches below; `PATCHES.txt` lists them with their sha256 |

The patched node keeps the upstream version string (`--version` prints the same as unpatched).
It names its patches in the log at every start:

```
logos-node-android patched node: stored blocks are replayed with fast verification ... patches="0001-fast-replay-from-own-storage"
```

## 0001-fast-replay-from-own-storage

**What it changes.** At every start the node rebuilds its chain by replaying every stored block
after the last immutable block (LIB), and upstream verifies each one again in full, including the
two expensive zero-knowledge checks: the block's leader proof (Groth16) and the batch of deferred
transaction proofs. These blocks were verified by this node before it stored them. With the
patch, a start skips those two checks for the replayed blocks, when it is safe to (see "The
marker"). Everything else still runs on every replayed block:

- decoding the block, which checks the header signature, that the body (transactions and uncle
  headers) matches the header's body root, and the transactions' stateless rules;
- that the block decodes to the id it is stored under (new, in both modes);
- the parent links (the walk from tip to LIB, and the consensus engine's parent check);
- the full ledger transition (balances, notes, fees, epochs, nonce updates) and the consensus
  engine's fork choice.

Blocks from the network, and blocks this node produces, take exactly the upstream path.

**What is not changed.** Consensus rules, the wire format, the database format, the config file
format and the HTTP API. The patched node reads and writes the same database as the unpatched one
and talks to unpatched peers as usual.

**Code.** `services/chain/chain-service/src/replay.rs` (new), the replay call site and the block
apply step in `chain-service/src/lib.rs`, a timing line in `process_block`, one method in
`ledger/src/update.rs` (`assume_batch_proofs_verified`), and two lines in the node binary that
tell the chain service where the marker lives.

### The marker

The node remembers which build last verified its stored blocks in full, in a small text file
**next to** the database folder: `<state>/db.replay-verified` (the database is `<state>/db`).
It holds two lines: the build (upstream version, patch names, patch-set digest) and the
database's RocksDB identity (`db/IDENTITY`). A start replays fast only when the marker matches
both the running build and the database on disk. Otherwise it does one full replay, exactly as
upstream, and writes the marker after it succeeds; later starts are fast. So:

| Situation | Replay on the next start |
|---|---|
| normal restart, same binary, same database | fast |
| first start of the patched node (no marker yet) | full, then fast |
| new node version or a changed patch set | full, then fast |
| database replaced by a copy from another node | full, then fast (its RocksDB identity differs) |
| marker deleted | full, then fast |
| `LOGOS_REPLAY_VERIFY=full` set | full (every start while it is set) |

The log says which mode was chosen and why (`replay mode chosen: ...`).

**For the Android app (snapshot import):** delete `<state>/db.replay-verified` whenever a
database is imported or restored, so the first start after it verifies everything. (A copied
database usually has another RocksDB identity anyway, but a snapshot taken from this same
phone's database keeps it, so delete the marker to be sure.) The marker sits outside `db/`, so a
snapshot made of `db/` never carries one.

### What is trusted

- **Full replay** (upstream behaviour): only the stored LIB ledger state is trusted, as upstream
  already does; every block after it is verified again.
- **Fast replay**: the stored LIB ledger state as above, and additionally that the blocks between
  LIB and tip in the database are the ones this same build verified before storing them. That
  is, nobody but this node wrote to the database since the marker was written. Anyone able to
  write the database could already change the stored LIB state, which neither mode re-verifies.

The equivalence is tested: the same stored chain replayed fast and full gives identical chain and
ledger states, equal to the states built when the blocks first arrived. A block with a bad leader
proof or a bad deferred proof is rejected from the network and in a full replay, and accepted
only by a fast replay; that test is the written form of the trust statement above.

### Turning it off

- For one start, or always: set the environment variable `LOGOS_REPLAY_VERIFY=full` for the node
  process. Any value other than empty or `fast` also means full, so a typo never turns
  verification off. Nothing can force a fast replay without a matching marker.
- Delete `<state>/db.replay-verified` to get one full replay on the next start.
- Or use the unpatched artifact.

### Measurements

See the `replay-bench` job of the native-build workflow (Linux arm64 runner): it syncs a fresh
testnet node, then times the replay of identical copies of its database with the unpatched node,
the patched node in full mode and in fast mode. Results are in the run's
`replay-bench-linux-arm64-<version>` artifact.

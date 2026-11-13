# Patches to the node

The native build compiles the official node source at a release tag. The **patched** variant
applies the files here, in order, after the clone (`native/apply-patches.sh`); the build stops if
any of them does not apply cleanly. The **unpatched** variant is still built from the untouched
source, as a separate artifact, so the two can be compared.

| Artifact | What it is |
|---|---|
| `logos-blockchain-node-android-arm64-<version>` | official source, no patches |
| `logos-blockchain-node-android-arm64-<version>-patched` | the same source with the patches below; `PATCHES.txt` lists them with their sha256 |
| `logos-blockchain-node-android-arm64-<version>-api` | the same source with patch 0002 alone (`apply-patches.sh <dir> --only <patch>`), so the API fix can ship without 0001 |

The patched node keeps the upstream version string (`--version` prints the same as unpatched).
It names its patches and its build id in the log at every start:

```
logos-node-android patched node: stored blocks this build already verified replay without re-verifying their proofs ... patches="0001-fast-replay-from-own-storage" build=Some("0.3.4 0001-fast-replay-from-own-storage <patch-set id>")
```

The build checks each binary after building it (`native/check-binary.sh`): a patched binary must
contain the patch name and its patch-set id, an unpatched one must not contain the patch.

## 0001-fast-replay-from-own-storage

**What it changes.** At every start the node rebuilds its chain by replaying every stored block
after the last immutable block (LIB), and upstream verifies each one again in full, including the
two expensive zero-knowledge checks: the block's leader proof (Groth16) and the batch of deferred
transaction proofs. With the patch, a start skips those two checks for the stored blocks that
this same build already verified (see "The marker"), and verifies all other blocks in full.
Everything else still runs on every replayed block:

- decoding the block, which checks the header signature, that the body (transactions and uncle
  headers) matches the header's body root, and the transactions' stateless rules;
- that the block decodes to the id it is stored under (new, in both modes; a mismatch stops the
  start with an error, the same way upstream stops on a block that fails to replay);
- the parent links (the walk from tip to LIB, and the consensus engine's parent check);
- the full ledger transition (balances, notes, fees, epochs, nonce updates) and the consensus
  engine's fork choice.

Blocks from the network, and blocks this node produces, take exactly the upstream path.

**What is not changed.** Consensus rules, the wire format, the database format, the config file
format and the HTTP API. The patched node reads and writes the same database as the unpatched one
and talks to unpatched peers as usual.

**Code.** `services/chain/chain-service/src/replay.rs` (new), the replay call site, the block
apply step and the start-up wiring in `chain-service/src/lib.rs`, a timing line in
`process_block` and one line in `record_recovery_state` (`service/mod.rs`), one method in
`ledger/src/update.rs` (`assume_batch_proofs_verified`), and two lines in the node binary that
tell the chain service where the marker lives.

### The marker

A small text file **next to** the database folder, `<state>/db.replay-verified` (the database is
`<state>/db`), records:

- the build: upstream version, patch names and the patch-set id (a digest of every patch file
  applied, computed by `native/apply-patches.sh` after applying them). A build made without a
  patch-set id never replays fast. The build id covers the code only, not the deployment and
  ledger configuration the node is started with; the vouched LIB id (below) ties the marker to
  one chain, but a changed configuration on the same chain is not detected, so delete the
  marker when changing it;
- a chain this process holds in memory and has verified: its tip id and its LIB id. Every block
  in that chain after the LIB was either verified on arrival from the network or replayed at
  start-up under the same rules.

The node rewrites the marker when it records its recovery state (after every block, and once a
minute), at most once every 5 seconds: a small file written and renamed on the chain service's
task. Once synced, blocks are tens of seconds apart, so the marker follows every block; while the
node catches up it can be up to 5 seconds behind, and the once-a-minute recording brings it up to
date. A failure to write it is logged once. There is no write at shutdown (the chain service has
no shutdown hook), so a stop is treated like a kill.

A header id is a hash of the header, which commits to the parent id and to the block body, and
the replay checks that every stored block decodes to its id. Fast blocks are found by following
the parent ids in the blocks' own headers back from the marker's tip, not the database's separate
parent index. So the marker's tip id pins the exact content of every block it vouches for,
wherever the database came from.

At the next start a block is replayed fast only if all of these hold, and in full otherwise:

1. `LOGOS_REPLAY_VERIFY` does not force a full replay;
2. the marker is from this build (same version, patches and patch-set id);
3. the stored recovery state's LIB is the marker's LIB (so the stored LIB ledger state is the
   one this build computed);
4. the block is the marker's tip or one of its ancestors after the LIB, following the headers'
   parent ids, and every block before it on the replay path is fast too.

Blocks stored after the marker's tip, or on another branch, are verified in full. So:

| Situation | Next start |
|---|---|
| normal restart, same binary | fast (blocks stored after the last marker update, if any, in full) |
| first start of the patched node (no marker) | full, then fast |
| new node version or changed patch set | full, then fast |
| after a start that fell back to LIB (tip branch could not be loaded) | the marker vouches for the LIB alone, so every stored block is verified in full |
| database replaced by one from another node | full, unless it has the marker's LIB id and contains the vouched blocks (the app deletes the marker on import, see below) |
| another binary (official release, other version) ran on the same state folder | full if it moved the LIB; otherwise its blocks in full and the still-vouched blocks fast (the app deletes the marker when the binary changes, see below) |
| marker deleted | full, then fast |
| `LOGOS_REPLAY_VERIFY=full` set | full (every start while it is set) |

The log says what was chosen and why (`replay mode chosen: ...`) and how many blocks were
replayed each way (`replay timing (N blocks: X fast, Y with full verification)`).

When the stored recovery state is newer than the marker (the node stopped or was killed after
recording its state but before the marker caught up, which during catch-up can be up to 5
seconds), the next start verifies more blocks in full; it never trusts more. Once the node is
Online the LIB moves with almost every block, so in that case the stored LIB usually differs
from the marker's and the next start is a **full replay**. While bootstrapping the LIB stays put,
and only the blocks stored after the marker's tip are verified in full.

**For the Android app:** delete `<state>/db.replay-verified` when a database is imported or
restored, and when the bundled node binary changes. The marker never vouches for a block it does
not pin by id, but it takes the stored LIB ledger state as this build's whenever the stored LIB id
is the marker's LIB id. An imported database, or one another binary wrote, could hold that same
LIB id with a ledger state computed elsewhere (by other rules, if the other binary is a different
version). Deleting the marker in those two cases removes that possibility, at the cost of one full
replay.

### What is trusted

- **Full replay** (upstream behaviour): the stored LIB ledger state, which upstream already
  trusts and never re-verifies; every block after it is verified again.
- **Fast replay**: the same, plus (a) that the marker file was written by this node, i.e. nobody
  edited it to vouch for a chain this build did not verify, and (b) that the stored LIB ledger
  state at the marker's LIB id is the one this build computed, i.e. no other software wrote the
  recovery state with that same LIB id since (the app deletes the marker on import and when the
  binary changes, which covers the ways that can happen). The blocks the marker vouches for are
  pinned by their ids, so changing or replacing them in the database is detected (they no longer
  match the vouched tip, or no longer decode to their ids) and leads to a full verification or an
  error.

The equivalence is tested: the same stored chain replayed fully, fast, and mixed (only the first
blocks vouched for), across an epoch boundary, gives identical chain and ledger states, equal to
the states built when the blocks first arrived. Upstream's own recovery tests now run both with
full verification (the result they check) and fast, and fail if the two differ. A block with a
bad leader proof or a bad deferred proof is rejected from the network and in a full replay, and
accepted only by a fast replay; that test is the written form of the trust statement above.
Further tests: a stored block with a bad leader proof or a bad deferred proof just after the
vouched tip is rejected at start-up (only a marker vouching for that block itself lets it
through); a marker whose tip is on another branch vouches only for the blocks that branch shares
with the stored chain (nothing if it branches at the LIB); a parent index that disagrees with the
headers stops the fast prefix; and after a fall-back to LIB, the next start replays everything in
full, using the node's own marker read, choice and write steps.

### Turning it off

- For one start, or always: set the environment variable `LOGOS_REPLAY_VERIFY=full` for the node
  process. Any value other than empty or `fast` also means full, so a typo never turns
  verification off. Nothing can force a fast replay.
- Delete `<state>/db.replay-verified` to get one full replay on the next start.
- Or use the unpatched artifact.

### Check when moving to a new upstream version

- `ReplayLeaderProof` (in `replay.rs`) implements every method of the `LeaderProof` trait by
  hand, passing them through to the real proof. If upstream adds a trait method with a default
  body that `Groth16LeaderProof` overrides, the wrapper silently uses the default: add the method
  to the wrapper.
- The skipped checks must still be only the leader proof (`LeaderProof::verify` inside
  `Ledger::prepare_update`) and the deferred proofs (`PreparedUpdate::verify_batch_proofs`). If
  upstream moves other checks into either, review what a fast replay skips.
- The patch-set id changes with any patch change, so the first start of a new build is a full
  replay by design.

### Measurements (2026-11-12)

The same testnet database was used for every run, freshly copied each time: 1,000 stored blocks
after its LIB (heights 81,820 to 82,820). The figures time the startup replay, from the log line
"found 1000 stored blocks to replay" to "1000 blocks replayed". The load before it (reading and
decoding the blocks) is listed separately.

**Phone** (Pixel 8, Android build, adb shell user; the app's own node was running alongside):

| Binary | Replay (1,000 blocks) | Load |
|---|---|---|
| unpatched | 26.4 s, 26.5 s | 5.1 s, 13.9 s |
| patched, full (no marker / `LOGOS_REPLAY_VERIFY=full`) | 32.0 s, 31.6 s | 18.8 s, 10.5 s |
| patched, fast | 15.0 s, 15.0 s | 7.2 s, 13.0 s |

Load time on the phone is mostly flash reads and varies a lot between runs. The patched full
runs came out about 5 s slower than unpatched on the phone but not on the Linux machine below
(where they match to within 1%), so that difference is attributed to the phone (run order,
temperature), not to the patch.

**Linux arm64** (4-core machine, container limited to 3 CPUs, database on tmpfs; unpatched and
patched built by the same CI job and toolchain, plus the official 0.3.4 release):

| Binary | Replay (1,000 blocks), 3 runs | Load |
|---|---|---|
| official 0.3.4 release | 11.88 s, 11.38 s, 11.53 s | 1.3–1.5 s |
| unpatched (CI build) | 12.65 s, 11.69 s, 11.71 s | 1.3–2.0 s |
| patched, `LOGOS_REPLAY_VERIFY=full` | 11.76 s, 11.66 s, 11.73 s | 1.3 s |
| patched, fast | 5.74 s, 5.71 s, 5.72 s | 1.3 s |

**Where unpatched replay time goes** (per 1,000 blocks, from the patched node's timing line in
full mode, which runs the upstream checks):

| Part | Linux arm64 | Phone |
|---|---|---|
| reading blocks from the database | 1.2 s | 9–18 s |
| decoding (header signature, body root, stateless tx checks) | 0.1 s | 1.2 s |
| leader proofs (Groth16) | 1.2 s (10% of replay) | 3.1 s |
| deferred transaction proofs (batch) | 4.7 s (40%) | 12.7 s |
| rest of the ledger transition | 5.8 s (50%) | 15.5 s |
| writing the block back to the database | 0.04 s | 0.2 s |

The fast replay removes the two proof rows and nothing else. Every fast and full run of the
patched node ended in the same tip, LIB, UTXO roots and epoch nonces.

What is left in "rest of the ledger transition" was split with a bench-only build
(`native/bench-patches/9001-replay-ledger-profile.patch`, built as the `-profile` Linux artifact,
never shipped): these 1,000 blocks carry 9,878 transactions. Executing them (the stateful
transaction checks and ledger updates) takes 5.7 s, about 0.58 ms per transaction on Linux arm64.
The header update without the leader proof takes 0.03 s. Cloning the parent state, recording
the seen block, the block accounting and the PoW difficulty update are each at most 0.01 s. So
after this patch, replay time is almost all transaction execution, which a patch must not skip.

## 0002-api-unix-socket

**Why.** On Android every installed app with the `INTERNET` permission can open TCP connections to
`127.0.0.1`. The node's HTTP API has no authentication, and among its routes are the wallet's:
`POST /wallet/transactions/transfer-funds`, `/wallet/sign/ed25519`, `/wallet/sign/zk`,
`/wallet/fund`, `POST /channel/deposit`, the SDP and claim routes. So on a phone any app can make
the node sign and send with the keys in its keystore; the wallet's PIN guards only the wallet
server. No configuration closes this: `api.backend.listen_address` is a TCP socket address
(`nodes/node/binary/src/config/api/serde.rs`) and the backend binds a `TcpListener`
(`nodes/node/binary/src/api/backend.rs`). See `android/LOCAL-APIS.md` on the `local-apis` branch.

**What it changes.** With the environment variable `LOGOS_API_UNIX_SOCKET=<path>` set for the
node process, the API listens on a Unix domain socket at that path, **and on no TCP port**. The
same router, layers (timeouts, body limits, CORS, metrics) and handlers serve it; only the
listener differs. Before binding, a socket file left at the path by an earlier run is removed;
any other kind of file there is left alone and the start fails. The socket is made owner-only
(0600) right after binding. Access is then a file-system question: the app puts the socket in
its private files directory (0700, its own SELinux category), which no other app can enter.
Unset or empty: upstream behaviour, nothing changes.

**What is not changed.** Routes, handlers, wallet and signing logic, the config file format,
the database, consensus, the wire format. `--version` is unchanged.

**Code.** `nodes/node/binary/src/api/unix_socket.rs` (new: reading the variable, binding,
serving, tests) and a few lines in `backend.rs` (if the variable is set, serve there and return
before the TCP bind), one `mod` line in `api/mod.rs`. Unix only (`#[cfg(unix)]`). The start
logs one line with the socket path, the patch name and the patch-set id:

```
logos-node-android patched node: the HTTP API listens on this Unix socket only, on no TCP port (LOGOS_API_UNIX_SOCKET is set) socket=... patch="0002-api-unix-socket" build=...
```

**Tests** (run by `patched-crate-tests`): HTTP over the socket answers (200 for a route, 404
for none), the socket is 0600, a stale socket is replaced, a regular file at the path is not
removed and the bind fails, and an unset variable means TCP.

**Clients.** Every client of the node API must speak HTTP over the socket instead of TCP: on
the phone, `server.py`'s `node()` and the app's own Kotlin status calls (NodeService, Battery,
NodeActivity). Neither is switched yet: the app keeps the unpatched node until this patch has
had an independent review.

**Trust.** Who can connect is decided by the socket file's directory and mode. Root, and the
app's own user (anything running as the app, which can read its keys anyway), still can.

**Upstream.** A general form (a `unix:` listen address in the config, or a bearer token) is
worth proposing upstream; not done yet.

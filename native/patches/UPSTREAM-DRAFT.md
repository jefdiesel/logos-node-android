# Draft for upstream (not posted)

A draft issue for logos-blockchain/logos-blockchain. Delete this file once it is posted or
dropped.

---

**Title:** Startup replay re-verifies the leader proof and deferred proofs of blocks the node already verified

**Version:** 0.3.4

### What happens

At every start, `CryptarchiaConsensus::initialize_cryptarchia` replays every stored block between
the recovered LIB and the recovered tip (`BlockOrigin::Storage`). The replay skips only the uncle
rules and the future-slot check. Everything else runs again, including the two Groth16 checks:
the leader proof (`Groth16LeaderProof::verify` inside `Ledger::prepare_update`) and the deferred
transaction proofs (`PreparedUpdate::verify_batch_proofs`). The node verified both before it
stored the block (`process_block` stores only after `try_apply_block_with_state_retention`
succeeds).

A node that has not reached Online keeps its LIB at genesis, so it replays its whole chain on
every start. On a phone (Pixel 8, Android arm64 build of 0.3.4) a restart of a node that had not
reached Online replayed 17,211 blocks in about 12.5 minutes, and an earlier one did not finish
33,003 blocks in 27 minutes; a database with 1,000 blocks after LIB replayed in 26–31 s.

### Where the time goes

MEASUREMENT_PLACEHOLDER

### Proposal

Skip those two proofs for blocks replayed from the node's own storage, and keep everything else:
decoding (header signature, body root, stateless transaction rules), the stored-id check, parent
links, the full ledger transition and fork choice. A new `BlockOrigin::TrustedStorage` keeps
`BlockOrigin::Storage` as the full path, so network blocks and existing tests are unaffected.
The leader-proof skip needs no ledger change: `prepare_update` is generic over `LeaderProof`, so
a wrapper whose `verify` returns `true` and which passes `entropy`, `leader_key` and `voucher_cm`
through yields the same ledger state. The batch skip needs one method on `PreparedUpdate`.

To keep this safe across upgrades and copied databases, the fast path is used only when a small
marker next to the database names the same build and the same database (RocksDB `IDENTITY`) that
last did a full replay. A new version, a changed build, a replaced database or a missing marker
gives one full replay, then the marker is written. An environment variable forces full replays.

We carry this as a patch for an Android build
(`native/patches/0001-fast-replay-from-own-storage.patch` in jefdiesel/logos-node-android),
with tests that replay the same stored chain both ways and compare the resulting chain and ledger
states, and that show a bad leader proof or bad deferred proof is still rejected from the network
and in a full replay.

### Trade-off

A fast replay trusts that the blocks between LIB and tip in the database are the ones this node
verified, i.e. that nothing else wrote to the database. The stored LIB ledger state is already
trusted the same way today and never re-verified. A database copied from another node (snapshot
bootstrapping) must be replayed in full once, which the marker enforces.

An alternative with no trust change would be to persist the tip ledger state as well as the LIB
state, so a restart need not replay at all; that is a bigger change to the recovery state.

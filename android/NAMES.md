# An LNS name held by the phone

The app can hold an LNS name with an account of its own. That account's key is made on the phone
and stays there. The app can register a name with it and set the name's `blockchain` and `msg`
entries. It does this only for **public** names: the account appears on chain, and every change is
a plain signed transaction. Private names stay a desktop feature (see below).

## What each step needs

The signer is the names project's own command line, `names`, built for Android arm64 from its
source at a pinned commit, unmodified (`.github/workflows/names-build.yml`). The app runs it as a
child process from `server.py`, the same way it runs the node.

| step | what happens | proof? | network | time on the phone |
|---|---|---|---|---|
| Make the account | `names wallet account new public`: a new wallet file with one public account | no | none | about a second |
| Register a name | commit (one signed transaction), wait until the commitment is 15 minutes old, then reveal (one signed transaction that also moves the deposit) | no | 2 transactions | 20 minutes or more, mostly waiting |
| Set `blockchain` or `msg` | read the record, change one entry, seal the profile again, one signed transaction | no | 1 transaction | 1 to 3 minutes until it is in a block |
| Take over a name another account holds | the current holder signs a transfer; the phone signs nothing | no | 1 transaction, not from the phone | |

What the phone itself computes:
- **Argon2id** of the name (64 MiB, 3 passes) to find the name's record and sealing key, once per
  command. This is the largest memory use. It has not been timed on the phone.
- **The plan check.** Before sending, `names` runs the registry's own rules natively (`names_core`)
  against the current chain data. A change the registry would refuse fails there, before any fee is
  paid.
- **Signing.** A secp256k1 signature over the transaction: milliseconds.

**No proof and no large file is needed on the public path.** The registry program (a RISC Zero
guest, about 460 KB) runs on the sequencer. `names` would like to run it once locally to size the
gas limit, but that needs the `r0vm` executor, which the phone doesn't have. When `r0vm` is
missing, `names` says it couldn't size the gas and uses the wallet's configured limit. The app
writes that limit before each command:
- register: 250,000
- set an entry: 120,000

These are 1.5 times the cycles measured on the testnet, rounded up: about 165,000 for a reveal,
23,214 for a commit, and 65,590 for a profile change. While a call runs, the account must hold the
limit times the next block's base fee ceiling, about 8 or 9 a unit: about 2.25M for register and
1.1M for an entry, plus the bytes. A failed call is billed its whole limit.

**What it costs on the testnet** (checked against the first registration from a phone, `pixel8`,
2026-11-12: the account went from 5,000,000 to 2,492,488):
- Registering a name holds a deposit of 1,000,000 for as long as the name is kept. Releasing the
  name refunds it.
- **A fee is the gas the transaction uses, times the base fee, plus its bytes.** The limit only
  decides what must be held while it runs. `pixel8`'s commit cost about 189,000 (23,214 gas × 8,
  plus its bytes) and its reveal 1,320,000 (165,000 gas × 8). Billed at the 250,000 limit, the reveal
  would have cost 2,000,000. So the limit doesn't make step 2 cost more than it must; the registry's
  reveal is simply that much work. A set-text costs about 530,000 (about 65,590 gas × 8).
- To start, the account must hold the commit's fee, then, at the reveal, the deposit plus the reveal's
  reserve (250,000 × the ceiling): about 3,490,000 today. A set-text then needs 120,000 × the ceiling
  held while it runs.
- These are LEZ tokens, not the Logos Blockchain coins in the app's wallet. See Getting LEZ.

**The binary.** 17.5 MB stripped (names-build run 43304519020, sha256 `235d091e…9cd8`), with no
system dependency beyond libc, libm and libdl; CI checks this. The APK carries it as
`lib/arm64-v8a/libnames.so`, pinned in `android/names.properties`. The wallet that `names` is built on links PC/SC, for hardware
Keycards. Android has none, so the build links a stand-in (`names-cli/pcsc-stub.c`) that answers
"no smart card service" to every call. The LEZ crates also pull in the node's witness-generator
libraries and RocksDB. Those are built the way the node build does it, though `names` never calls
them.

**HTTPS.** The LEZ wallet's RPC client checks TLS certificates through Android's own certificate
store, which only works inside an app's Java runtime. In a bare executable it panics with
"Expect rustls-platform-verifier to be initialized" (rustls-platform-verifier 0.5.3, used by
jsonrpsee-http-client 0.26.1). So `names` doesn't talk to the sequencer directly. It
talks plain HTTP to `server.py` on 127.0.0.1, at a path that holds a random secret made at each
start, and `server.py` forwards the call over HTTPS. That is the same route the page's name lookups
already take on the phone. The forwarder:
- passes only the sequencer's read methods and `sendTransaction`
- refuses requests without the secret
- goes only to the configured sequencer

## Getting LEZ

A name is registered and changed with **LEZ testnet tokens**, held by the phone's name account. A
person using the app has at most Logos Blockchain coins, in the app's own wallet. Without a way to
move value into the name account, Register can't be used. The app gives two ways, both inside
Settings → Your name.

### 1. Bridge from the app's wallet (Logos Blockchain → the name account)

**The node's HTTP API can do it; no module IPC is needed.** Evidence:
- Node 0.3.4 (tag `0.3.4`, commit `f7ab032`, the one the app carries) has `POST /channel/deposit`
  (`nodes/api-common/src/paths.rs:22`, handler `nodes/node/binary/src/api/handlers.rs:1101`). Its
  body (`nodes/api-common/src/bodies/channel.rs`) is
  `{tip: null, deposit: {channel_id, inputs, metadata}, change_public_key, funding_public_keys, max_tx_fee}`.
  The node funds the fee from `funding_public_keys`, refuses a fee above `max_tx_fee`, signs with
  its own keys, puts the transaction in its mempool and answers `{hash}`.
- The node's own test `tests/src/tests/mantle/channel.rs` (`channel_deposit`) makes exactly this
  call over HTTP, with one note of exactly the amount and a separate note for the fee.
- The signer the app already carries (`names` at `27029987`) has `names bridge`, which makes this
  same call (`cli/src/main.rs:2127–2203`). The project faucet was funded with four 30-note deposits
  (that command's cap) from a project node on 2026-10-15, credited about 12 hours later. The desktop Names app made
  the same deposit operation over the module IPC (`channel_deposit_with_notes`) on 2026-11-06: a
  split of exactly 10,000,000, then that note deposited to a public LEZ account, credited in full.
- JSON shapes (`serde` in node 0.3.4): `channel_id` is 64 hex characters; `inputs` are note ids
  exactly as `GET /wallet/<key>/balance` lists them; `metadata` is an array of byte values (not hex);
  `max_tx_fee` is a number.

**What it takes on the Logos Blockchain side:**
- The app reads the deposit channel from the sequencer (`getChannelId`; the public testnet answers
  `0101…01`) and checks that its own node knows it (`GET /channel/<id>` answers 200).
- **A deposit moves whole notes.** It credits the sum of the notes it spends, and its fee comes
  from other notes of the same key. So the app first sends the exact amount to the same key (one
  ordinary transfer: funded, saved, submitted and found by its hash, as every transfer (LOCAL-APIS.md,
  "Transfers")), waits until that note is in a block,
  and deposits that one note. Nothing more than the amount typed is moved. The key must hold the
  amount plus room for two fees.
- **Fees:** the deposit's fee is capped at 100,000 (`max_tx_fee`, as `names bridge` does). Fees
  seen for one-input transfers are 866 to 2,054. The app sets aside 10,000 for the split's fee
  and 100,000 for the deposit's, and shows the fee paid once each is in a block.
- **Limits:** no minimum amount in the node or in LEZ's bridge program; at most 30 notes per
  deposit (the node signs at most 32 items), which one exact note avoids.

**What it takes on the LEZ side: nothing from the phone.** The LEZ sequencer (v0.3.1, which the
public testnet runs) watches the channel. Once the Logos Blockchain block holding the deposit is
final, it decodes the metadata as `borsh(DepositMetadata { recipient_id })` (the 32 bytes of the
account) and mints the amount to that account itself, in a transaction it makes and that pays no fee
(`lez/sequencer/core/src/lib.rs`, `build_bridge_deposit_tx_from_event`; bridge program
`lez/programs/bridge/src/main.rs`). No claim, no proof, no LEZ fee. A deposit is minted once; a
receipt account (`/LEZ/v0.3/BridgeDepositReceipt/0`, keyed by the deposit's operation id) marks it.
- **LEZ 0.4** reads the metadata differently (it needs the account's public key). The app asks
  which LEZ the sequencer runs before each deposit (`getRecoveryBinding`: "method not found" is
  0.3) and sends nothing unless it is 0.3: a deposit LEZ can't read is never credited.
- **How long:** finality on the Logos Blockchain, then the sequencer's next block. Minutes when the
  chain is healthy; hours when finality lags (the 10-15 deposits took about 12 hours).
- **It can't be undone or sent back yet.** Withdrawing from LEZ to the Logos Blockchain is disabled
  in LEZ ("Withdraws are disabled in the current version of LEZ").
- **How the app tells it arrived:** the name account's balance (`getAccountBalance`), read through
  the app's forwarder. Arrival is counted as the sum of increases since the deposit, less any
  faucet grant asked for meanwhile, reaching the amount. The deposit's operation id is kept too, for
  a receipt check later.

### 2. The project's faucet

`POST https://lez.buggers.online/faucet` with `{"account": "<base58 id>"}` pays the account from
the faucet's LEZ testnet account (`chain/faucet.py` in logos-names): `{account, amount, tx}` on
success, or `{error}` with the reason ("this account was funded in the last day", "too many
requests from your address today", "the faucet's daily limit is spent; try tomorrow", "the faucet is
empty until its next refill…", "the faucet is busy sending; try again in a minute"). The app shows
that reason as it comes.
- **How much:** the faucet's source and its last record (2026-10-27) say **2,000,000 per account
  per day**. The live endpoint answers only POST, so the amount can't be read in advance; the app
  shows the `amount` the reply gives.
- **That is less than one registration.** Starting one needs about 3,490,000 held (see What it
  costs). So the faucet alone takes two days to fund a name at today's fees. The bridge has no such
  limit.

### What the page shows

One line of what a name costs ("Costs 1,000,000 LEZ deposit + about 1,520,000 LEZ fees."): the
registry's own deposit (`names settings`, read in the background once an hour, in a throwaway
folder) and the fees the two transactions should take at today's base fee (`getFeeState`). When the
account holds less than it needs to start, one line says how much more, and Register waits. When
the balance or the fees can't be read, it says nothing of the sort and leaves Register to the
signer's own check.

## One tap: Get this name

Your name has one field and one button. The tap starts a chained job on the server
(`POST /api/wallet/lns/get`, state in `wallet-lns-flow.json`, 0600), which does every step itself and
carries on after a restart:
1. **Name account**: made silently if there is none.
2. **LEZ**: it waits until the account holds what the whole chain needs: the commit's fee, then the
   most any later step needs held (the deposit with the reveal's reserve, or with the reveal's fee and an
   entry's reserve, or with both and the last entry's reserve), all at the next block's ceiling: about
   4,420,000 today. The page shows one line and **Add LEZ**, which opens Wallet → LEZ with the bridge
   filled in for what is missing. When LEZ arrives, it goes on by itself.
3. **Register**: commit, the 15-minute wait, reveal.
4. **Pay to this wallet**: the `blockchain` entry.
5. **Messages to this phone**: the `msg` entry, once Messages is on. Without Messages, the name is done
   and this step runs by itself when Messages is turned on.

**Every step is decided from the chain:** before anything is sent, the name is read (`names resolve`).
A step already true is skipped, so a stop and restart at any step never sends a change twice. A
reveal that landed late counts as registered. A step that didn't take is tried again after 30 s,
2, 5 and 10 minutes; a registration only once more, since a reveal that fails on chain is billed its
whole limit. A refusal that can't change (the name is taken, or held by someone else) stops at once.
Then the page shows one line and **Try again**.
- **Brakes**, each written to disk before a send, none of them reading the balance (LEZ arriving would
  hide what was spent):
  - at most 2 register runs and 3 sends of each entry;
  - at most 6 billed transactions (4 for a name already held), counted by the account's nonce;
  - what those may have been billed, each at its kind's full gas limit at the fee ceiling taken before
    the first paid send: at most the expected cost plus one failed register transaction;
  - at least a minute between two sends;
  - an unknown nonce or fee means nothing is sent: it waits (counted), then stops.
  - a second register run only when the first moved the nonce by at most one (its commit): a run is one
    commit and up to four reveals, and the brakes are checked before a run, not during it.
- **Worst case, honestly** (fee ceiling 9; a transaction that fails on chain is billed its whole limit:
  2,263,500 for a register transaction, 1,093,500 for an entry):
  - Before 0.9.15 one tap could bill about **15.8M** (7 register transactions: a run of a commit and two
    failed reveals, then a second run of four failed reveals), against a stated 8.98M.
  - Now one tap can bill at most **13,581,000** (6 register transactions, the cap: a first run that landed
    only its commit, then a second run of a commit and four failed reveals), plus the 1,000,000 deposit if
    a reveal lands (refunded on release). A second run starts only after the account's nonce has held still
    for 31 minutes (longer than the wallet waits for any of the first run's transactions) and the name was
    read again; anything of the first run that lands meanwhile stops it. Get (before the tap), the Start
    over button and this figure all come from one function, `lns_flow_worst`. `tests/lns_flow_test.py`
    ("worst case") runs one full failed run: 5 transactions, 11,317,500 billed, then nothing more.
  - Finish setting up (a name already held) at most **4,374,000** (4 entries, the transaction cap).
  - Always at most the balance at the tap plus LEZ arriving while it runs. Each Start over is the same again;
    its button says the most it may cost.
- **A stop shows what it did**: its transactions in blocks, the most they were billed, and the balance
  change since the first paid send; then "Start over (up to N LEZ more)". It is read in the background
  (at most every 30 s, 5 s timeouts), so the page never waits on the chain; the page's balance line waits a
  second at most, then shows the last value read. When the chain can't be read
  it says so, with the transactions seen so far and their most, never "0"; when the maximum isn't known
  yet, Start over waits ("cost not known yet").
- **Stop while a change is being sent** says until when (up to 95 minutes for a register). "Stop now" is
  offered only while a register waits out the 15 minutes between its steps, and only within 20 s of the
  signer's own "waiting N s" line with more than 35 s left (checked and stopped under one lock; the CLI
  prints that line every 30 s, so the button shows for about 20 s of each 30): its
  commit is in a block and saved, and nothing is being sent, so the next register resumes it.
- **Waits** are all counted and spaced out; a `names resolve` (Argon2) runs at most once a minute, and
  after five with no step taken, once every ten minutes. The day's wait for LEZ and the two-day limit
  stop the flow when EITHER clock says they have passed: the time the app has run it (the boot clock,
  which counts deep sleep; saved every round) or the wall clock from the tap. The counted time alone
  would miss days the app was dead. A start time in the future (a clock set back) is taken as now, so
  stretching a limit needs both clocks fooled. A clock jumped forward stops the flow early: a stop and a
  fresh tap, never a commit sent by itself. A flow saved by an older app version (no counted time) is
  judged by the wall clock from its tap, and stops at the first look if past a limit.
- **Try again** after any stop is the person's own tap: it starts every count and limit over.
- **LEZ Send waits** while getting a name runs: the brakes count the account's transactions.
- **The job signs after the wallet locks.** The one tap is the consent. While it is between two
  changes, a restore waits.
- **I already hold it** is the same job: the signer reads, with the wallet's own keys, whether this
  account holds the name; then the two entries.
- **Cost line:** "Costs 1,000,000 LEZ deposit + about 2,580,000 LEZ fees · about 20 minutes", the
  four transactions at today's base fee.

**Can entries go into the reveal, or both into one transaction?** In the registry, yes: the reveal
carries the sealed profile, and a set-text rewrites the whole sealed profile, so the reveal could hold
both entries and one later change could set both. The pinned `names` (27029987) has neither: `register`
takes no entries and `set-text` sets one. So the job chains them. Adding `--text key=value` to
`register` (or several pairs to `set-text`) in the CLI, then rebuilding and re-pinning the signer, would
save two transactions (about 1,060,000 at today's fee) and two waits for a block.

**Why a set-text took about ten minutes on the phone.** The signer waits for its transaction to be in a
block (`poll_transaction`: a 12-second pause between rounds, up to 60 rounds). The public LEZ testnet
made only 12 blocks between two reads about 90 minutes apart on 2026-11-12 (heights 81,835 and 81,847),
and none in a 30-second window. So the wait is for the next block, not the app or the forwarder. Each
progress line of a change now goes in the app's event log with its time, so the next run shows where
the minutes go.

## Why private names don't work on the phone

A private holder changes a name with a privacy-preserving transaction. The client runs the
registry program inside a RISC Zero proof on its own machine (`send_privacy_preserving_tx` in
`names`, through the `r0vm` prover). `names` itself tells the user this takes "about 4 minutes" on
a computer. RISC Zero publishes no `r0vm` for Android, and the app's processes
already share the phone with a blockchain node and a messaging node. A phone could at best do it
slowly, hot and with a real chance of being killed halfway. So the app does public names only.

Registering still puts a private receiving account's public keys into the name's profile; that is
what `names register` always does, and it is only key generation. Payments sent privately to the
name would land there, and spending them would need a proof, so the app doesn't offer it. People
pay the phone through the `blockchain` entry.

## Where the key lives

- **The wallet file.** It is in the app's private storage: `files/wallet/.lns-wallet/storage.json`,
  with the wallet's config and `names.json` beside it. The folder is 0700 and the files 0600.
  - It holds the wallet's seed and the account's signing key as plain JSON. The LEZ wallet doesn't
    encrypt its storage yet.
  - Android's app sandbox keeps other apps out. The debug build can be read over USB debugging with
    `run-as`, the same as the node's own `keystore.yaml`.
  - The PIN guards the app's API that uses the key, not the file itself.
  - Wrapping the file with the Android Keystore is a follow-up, as it is for the messaging address.
- **Made on the phone.** `names` makes the key on the phone, inside the app. It prints a recovery
  phrase once when it makes the wallet. The app reads only the account address from that output
  and drops the rest: the phrase is never shown, stored elsewhere, logged or sent. So there is no
  recovery phrase: **a backup is the only way back to this key.**
- **In the encrypted backup: yes, from the backup made after the account exists.**
  - The backup the app already makes (Settings → Back up) now also carries the wallet file and
    `names.json`, inside the same encryption as the node's keys: a backup password through scrypt,
    then ChaCha20-Poly1305, and the PIN typed again to export.
  - Backups made before the account existed don't have it. Registering adds a receiving account to
    the wallet file and a commitment to `names.json`, so a backup from before registering is
    incomplete too. The app remembers what the last backup held, and Your name says "Make a new
    backup now" whenever the account, its files or its name have changed since.
  - The reason: the name belongs to whoever holds this key. Without it in the backup, a lost or
    wiped phone loses the name for good. That is the same reason names were kept transferable
    rather than soulbound.
  - Apart from the encrypted backup, the key never leaves the phone.
- **Restoring.**
  - With no name account on the phone, restoring puts the backup's back.
  - Before anything changes, the signer reads the backup's wallet file in a temporary folder and
    must find the account written on the backup in it.
  - Accounts are compared, not files: the signer reports the account in each wallet file. A backup
    of this phone's own account, even an older one, leaves this phone's (newer) files as they are.
  - **When the phone already has a different name account, nothing is replaced unless the person
    asks.** The reply and the page say which two accounts these are. Restoring again with "Replace
    this phone's name account" ticked swaps them. The one that was there is then kept as
    `storage.json.replaced-<time>-<random>`: it is still on the phone, but no longer in new backups,
    and the page says so.
  - A restore while a change to the name account is running leaves the name account alone and asks
    for the restore to be run again.
  - A replacing restore saves the state first, with a marker, then swaps the files (the other
    account's `names.json` is kept aside too). If the app stops in between, the next start makes the
    state name the account that is really in the wallet file.
- **Backing up during a change** is refused ("Back up when it has finished"), and the page offers no
  backup while a change runs: the signer may be rewriting the files then.
- **During a change.** `names` rewrites the wallet file in place (truncate, then write). Before
  every change the app copies `storage.json` and `names.json` to `*.prev`, written atomically and
  0600. After the change, when the app starts, and before a backup, a file that no longer reads as
  JSON is put back from its copy, and the page says so. A copy is used only if it is of the same
  account, and a missing wallet file is never filled in: the page says what is wrong instead.
- **What is shown of the signer's output.** Only the account address, fixed progress texts and
  fixed error texts. Each comes from an allowlist of the patterns `names` prints, and only digits
  and names are carried over. Any other error shows as one fixed sentence. The forwarder's secret
  path, keys and phrases can't reach a reply, the log or the page.

## Moving the name `android` to the phone's account

**The registry already has a transfer.**
- Registry v5 (`38jEfVV1…h2gq`) has `Instruction::Transfer`. It has been in the core since
  registry v3, and the CLI has `names transfer <name> <new holder>`.
- Its own test `the_admin_places_a_name_without_a_deposit` is exactly this case: the admin
  registers a name, then transfers it.
- The registry's admin holds `android` today, so the admin can hand it straight to the phone's
  account.
- A transfer replaces the record's holder tag and clears its sealed profile and page. The new
  holder then sets its own entries.

**Recommendation: one transfer by the admin, then the phone sets its entries.**

1. On the phone, open Settings → Your name → **Make a name account**. Copy the address it shows.
2. Send that account about 5,000,000 LEZ testnet tokens from any funded LEZ account. It needs about
   2,000,000 for the two entries; the rest is room.
3. From the admin's wallet, run `names transfer android Public/<the phone's address>`. That is one
   public transaction, about 51,000–66,000 gas, roughly 0.5M in fees from the admin.
   - No deposit moves. Admin registrations owe none; if `android` has one, it stays in the name's
     deposit account and goes to whoever releases the name.
   - The new holder is the phone's public account.
4. On the phone, under Your name, choose **I already hold this name** and enter `android`. Then use
   **Point it at this wallet** (`blockchain`) and **Point it at my messaging address** (`msg`). These
   are two transactions signed on the phone, about 1M in fees in all.

**Between steps 3 and 4,** `android` has no entries for a few minutes. Payments and messages to
`android` can't be resolved until the phone sets them again.

**Why not the other two options:**
- **Release and register again from the phone.**
  - It holds a 1,000,000 deposit and needs about 2.25M reserved.
  - It takes at least 20 minutes.
  - Between the release and the phone's commit, anyone can claim the name.
- **Wait for the transferable 0.4 registry.** That isn't needed: this registry already transfers.

## What the app shows

Settings has a **Your name** group, right after Messages, shown only inside the Android app when the
signer is bundled and the wallet is unlocked. It is its own file, `app/lns/lns.js`, which fills one
placeholder (`#lns-slot`); the group is one line in `ST_GROUPS` in `index.html`. The server adds its
`<script>` tag to the page, and serves it, only in that case. In short lines, it shows:
- the LNS name, written bare (`android`), what a name costs, and how much LEZ is missing
- register a name, or link one already held
- each entry as the name service has it: one already pointing here shows as done and isn't offered;
  the server refuses a set-text whose value the name service already has ("Already points here."),
  before anything is sent
- a short stepper while a change runs, then the result
- "Back up now" whenever the last backup doesn't hold the account as it is
- behind one "Details" fold: the key is kept on the phone unencrypted, like the wallet's own keys;
  there is no recovery phrase; a backup made after the account exists is the only way back

**The Wallet** lists tokens: Logos (the app's own wallet) and LEZ (the name account), or a quiet
"Add LEZ" row before there is one. The tabs under the list (Send, Receive, Activity) act on the token
picked. LEZ's Receive is the account (`Public/<id>`) with its QR and Copy, its Activity what this app
did with it, and its Send a plain transfer (`names wallet auth-transfer send`) through the same job
runner, after a review, judged by the balance, and never below what an unfinished registration needs.

**Messages > Name** follows the name the phone holds: "pixel8 · messages come to this phone" when the
name service says so, else one button that runs the same point-at-messages job as Your name. A name
held elsewhere keeps the manual way, folded.

Every action needs an unlocked wallet, with the same checks as Send.

## Server routes (Android only)

All need an unlocked session (`X-Session`). The POST routes also need the app's own page as the
Origin. Each answers 404 unless the app runs inside the Android app (`APP_EMBEDDED=android`) and
the signer exists (`NAMES_BIN`).

| route | what |
|---|---|
| `GET /api/wallet/lns` | the account, its balance, the name, the running or last job, and `backup_needed` |
| `POST /api/wallet/lns/account` | make the account (once) |
| `POST /api/wallet/lns/register` `{name}` | register a name to the account; runs in the background |
| `POST /api/wallet/lns/name` `{name}` | link a name the account already holds (after a transfer) |
| `POST /api/wallet/restore` `{…, replace_name_account}` | the existing restore; `replace_name_account: true` lets a backup's different name account replace this phone's. The reply has `lns` (`added`, `same`, `kept`, `replaced`, `busy` or `unchecked`) and `lns_message` |
| `POST /api/wallet/lns/text` `{entry}` | set `blockchain` to this wallet's Main address or `msg` to this phone's messaging address; 409 "Already points here." when the name service has it |
| `GET /api/wallet/lns/balance` | the account and its LEZ balance only (the Wallet's LEZ row) |
| `POST /api/wallet/lns/faucet` | ask the project's faucet to pay the account; its own reason when it refuses |
| `POST /api/wallet/lns/bridge` `{from, amount, confirm}` | without `confirm`: the plan (from, to, amount, fee caps); with it: start the bridge |
| `POST /api/wallet/lns/bridge/cancel` | stop a bridge that hasn't deposited yet |
| `POST /api/wallet/lns/send` `{to, amount, confirm}` | LEZ Send: the plan, or the transfer through the job runner |
| `POST /api/wallet/lns/putback` | put the saved copy back when the live wallet file is missing or unreadable |
| `POST /lez-rpc/<secret>` | the forwarder for `names` only (see HTTPS); not for the page |

One job runs at a time, because the chain takes one transaction per signing account per block.

## Not proven yet

- `names` running on the phone: start, DNS-free loopback calls, Argon2 time and memory, exec from
  the app's library folder.
- A real transaction signed on the phone, and the gas limits above holding for it.
- The 20-minute registration surviving the app going to the background. If the wallet process
  stops, starting the registration again resumes the saved commitment, for 24 hours.
- Restoring a backup that carries the name account onto another phone.
- The bridge from the phone: the split (a transfer to the same key) and `/channel/deposit` over HTTP
  have run only against stand-ins here; the deposit operation itself is proven from desktop.
- LEZ Send from the phone: the output lines it is read by are LEZ 0.3.1's own; not run on a phone.
- Arrival of a bridge is "the balance rose by the amount" (faucet grants counted out): a LEZ payment
  from elsewhere of at least that amount, while one waits, reads the same.
- Android's own device-to-device transfer: the app sets `allowBackup="false"`, which on some phones
  doesn't stop a phone-to-phone move from copying the app's files, keys included. That was already
  so for the node's and the messaging keys.

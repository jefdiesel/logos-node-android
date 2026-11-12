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

**What it costs on the testnet:**
- Registering a name holds a deposit of 1,000,000 for as long as the name is kept. Releasing the
  name refunds it.
- Each transaction pays gas: roughly 0.2–1.5M at today's base fee.
- The account must therefore hold about 5,000,000 LEZ testnet tokens to register, and about
  2,000,000 to set entries.
- These are LEZ tokens, not the Logos Blockchain coins in the app's wallet. The account is funded by
  a LEZ transfer from another LEZ account.

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
  - **When the phone already has a different name account, nothing is replaced unless the person
    asks.** The reply and the page say which two accounts these are. Restoring again with "Replace
    this phone's name account" ticked swaps them. The one that was there is then kept as
    `storage.json.replaced-<time>-<random>`: it is still on the phone, but no longer in new backups,
    and the page says so.
  - A restore while a change to the name account is running leaves the name account alone and asks
    for the restore to be run again.
- **During a change.** `names` rewrites the wallet file in place (truncate, then write). Before
  every change the app copies `storage.json` and `names.json` to `*.prev`, written atomically and
  0600. After the change, when the app starts, and before a backup, a file that no longer reads as
  JSON is put back from its copy, and the page says so.
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

Settings has a **Your name** section, shown only inside the Android app when the signer is bundled
and the wallet is unlocked. It is its own file, `app/lns/lns.js`, which fills one placeholder
(`#lns-slot`) in Settings. The server adds its `<script>` tag to the page, and serves it, only in
that case. It shows:
- the name account and its balance
- the LNS name, written bare (`android`)
- buttons to register a name, link one already held, point it at this wallet, and point it at the
  messaging address
- what is happening now, and the last result
- "Make a new backup now", with a button, whenever the last backup doesn't hold the account as it is
- that the key is kept on the phone unencrypted, like the wallet's own keys, and that there is no
  recovery phrase

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
| `POST /api/wallet/lns/text` `{entry}` | set `blockchain` to this wallet's Main address or `msg` to this phone's messaging address |
| `POST /lez-rpc/<secret>` | the forwarder for `names` only (see HTTPS); not for the page |

One job runs at a time, because the chain takes one transaction per signing account per block.

## Not proven yet

- `names` running on the phone: start, DNS-free loopback calls, Argon2 time and memory, exec from
  the app's library folder.
- A real transaction signed on the phone, and the gas limits above holding for it.
- The 20-minute registration surviving the app going to the background. If the wallet process
  stops, starting the registration again resumes the saved commitment, for 24 hours.
- Restoring a backup that carries the name account onto another phone.
- Android's own device-to-device transfer: the app sets `allowBackup="false"`, which on some phones
  doesn't stop a phone-to-phone move from copying the app's files, keys included. That was already
  so for the node's and the messaging keys.

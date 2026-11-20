# Sending on LEZ 0.4 from the phone (the LEZ 0.4 signer)

The app carries the LNS command line `names` from the logos-names 0.4 line and sends PUBLIC transactions on our LEZ 0.4
(https://lez.nameswallet.app) with it. Since app 0.5.32 (web app 0.9.33) the app is LEZ 0.4 only: the LEZ 0.3 signer,
its name account, its bridge from the node wallet, the network switch and android/NAMES.md are gone. Name lookups
(Messages, sending Logos or LEZ to a name) read the LNS registry on LEZ 0.4 (`lns_registry` in `app/lez04.json`,
`6Yxj5k8A…N3gA`) with `getAccountView`; 0.4 records carry `msg` and `blockchain` as v5 did. A phone still holding
LEZ 0.3 files (`.lns-wallet`, `wallet-lns.json`, `wallet-bridge.json`, `wallet-net04-choice.json`) keeps them, unused
and never deleted by the app. Private
actions stay off on the phone: they need a RISC Zero proof, and a phone has no prover ("not on this phone yet").

## The binary

- `lib/arm64-v8a/libnames04.so`, pinned in `android/names04.properties` (run and sha256), built by
  `.github/workflows/names04-build.yml` from jefdiesel/logos-names `wallet-1121` (78b5896: LNS name NFTs,
  `names deed claim/show`, version 7 records) with `names04-cli/patches/0001` (public NFT calls sent unchecked).
- **Bare**: no `r0vm`, no in-process executor. Before a public send the 0.4 tool normally runs the call's programs to
  size the gas; a bare build sends registry, token, NFT and deed calls unchecked with their measured caps instead
  (`unchecked_limit`, three times the measured run). A call the network refuses still pays its fee.
- The app never sets `RISC0_EXECUTOR`, `RISC0_PROVER` or any other `RISC0_*` for it (its environment is built from
  scratch: `signer04.Signer04.env`; `tests/sign04_test.py` checks).
- The emulator test (`tests/names04_emulator_e2e.sh`, in names04-build) runs this binary on an Android emulator
  against a throwaway LEZ v0.4.0-rc3 chain: register, set-account, transfer, a native send; the desktop's phrase
  restored with `names module restore`, checked to give the same first account and public key as `names setup` made
  on the host; a send by account id and a public pay of a name; and, when the reference NFT program's guest builds
  in that run, NFT InitializeHolding, receive and send. The device reaches the chain through a proxy that passes only
  the app's forwarder allowlist. Which run passed which step: see the run's log, not this file.
- `names deed claim` can't run there (the deeds' NFT program sits at a pinned header whose key isn't in CI), so a
  claim from a bare build has not been run on any chain. It uses the same unchecked path as a bare register. Its cap:
  `unchecked_limit(165,000 + 150,000)` = gas limit 945,000; a claim measured on our LEZ 0.4 used 164,922.

## The accounts: the phone's own wallet, or a recovery phrase

The Wallet on LEZ 0.4, with no accounts yet, shows one small card, **Set up your LEZ 0.4 wallet**, with two choices
(Jef, 2026-11-20: "i want the phone sep account"; the big phrase box on the front page read as alarming):

1. **Create a new wallet** (first): the phone's own wallet, its own accounts.
   - `POST /api/wallet/lez04/new-phrase` (unlocked session): `signer04.new_phrase()` makes 32 bytes with `secrets`
     (the OS's randomness) into a 24-word BIP-39 English phrase, as the desktop makes its own (LEZ
     `SeedHolder::new_mnemonic`: 32 bytes, `Mnemonic::from_entropy`), so the phrase restores on the desktop too. The
     word list is `app/bip39/english.txt`, checked against its published SHA-256 (`2f5eed53…dbda`) before use;
     `tests/sign04_test.py` checks the encoder against the published BIP-39 vectors. Nothing is made or kept on the
     server: no file, log, event or later reply has the phrase.
   - The page shows the 24 words once, with the screen secured first (`FLAG_SECURE` and autofill off, as for the phrase
     box) and no way to copy them: not selectable (`user-select: none`, no long-press menu) and no copy button (so no
     clipboard at all). "I've written it down" takes the words off the screen and asks for two of them back (random
     positions); right, it restores from the phrase through the same `POST /api/wallet/lez04/restore` as a typed one
     (the same derivation, `names module restore`), then empties it from the page and turns the screen protection
     off. Wrong: said, nothing made; "Show the words again" or Cancel (the phrase is dropped, nothing was made).
   - Then a prompt to make an app backup ("Back up now" opens Settings → Back up; "Later"). Until a backup holds this
     wallet, a "Back up needed" line stays under it (`backup_needed` in `GET /api/wallet/lez04`, from the last
     backup's record).
2. **Use a recovery phrase** (second): the phrase box below, for the desktop's phrase (the same accounts, names and
   NFTs as the desktop) or a phrase this phone made before.

- `POST /api/wallet/lez04/restore {phrase}` (unlocked session). The server checks its form (12 to 24 lowercase
  words), then runs `names module restore` (the desktop's own restore: `cli_restore_wallet` → `run_restore_wallet`)
  with the phrase on standard input. It derives 16 public accounts (and one private one, unused here), as the desktop
  restores. Only on a phone with no LEZ 0.4 wallet yet; never over one.
- The phrase: in the request body and that one call's memory only. Never in argv, the environment, a file, a log, an
  event or a reply. What `names` prints while restoring is dropped except its last line (the account ids as JSON).
  The page empties the box as the request goes out, and a lock wipes every field.
- The keys: `names` writes them to `<data>/.lez04-wallet/storage.json` (folder 0700, files 0600), unencrypted inside the
  app's private storage, as the LEZ 0.3 key is. `<data>/wallet-lez04.json` keeps only public facts: the account ids,
  the first account's public key, whether the faucet was used.
- **That file is worth as much as the phrase.** It holds the roots of both key trees (public and private, chain codes
  included), so every account the desktop has or will derive, its names, NFTs and its private balance, can be rebuilt
  from it. Whoever can read the app's files can take the desktop wallet. A debuggable build lets any computer with USB
  debugging read them (`run-as`), so a real phrase goes only on a phone running **the release build** (below).
- **In the app's backup file** (since 0.9.32): `lez04_wallet` holds `storage.json` (the keys), `names.json` and the
  account list. A restore puts it back only on a phone with no LEZ 0.4 wallet (never over other accounts: "kept", with
  a line saying to remove them first); the same wallet is left as it is. `tools/decrypt-backup.py --check` lists it
  ("the LEZ 0.4 wallet: Public/…"). So the backup file and its password are worth as much as the phrase.
- The restore needs an unlocked session, not the PIN typed again (the backup restore asks for both; this one only
  adds keys, and only where there are none).
- The phrase box asks the keyboard not to correct or capitalise, but a phone keyboard may still learn the words.
- `nft init --new public` (Receive, when the first account is taken) derives the wallet's next account and saves it.
- **Remove the LEZ 0.4 accounts from this phone** (under the Wallet on LEZ 0.4, once there are keys here):
  `POST /api/wallet/lez04/remove {pin}`, an unlocked session AND the PIN typed again (the same check, and the same
  pause after wrong PINs, as a backup). It deletes `.lez04-wallet` (all but `cache/`, the public locked-name list) and
  `wallet-lez04.json`; the accounts stay on the network and on the desktop, and the phrase brings them back. Refused
  while a job runs. It is also the way out of a restore that stopped after `storage.json` was written (the app killed
  between the tool's write and the app's own): a restore then answers "An earlier restore on this phone didn't
  finish… Remove…, then restore again" (`stuck: true`), and the page opens Remove with that line. And of a wrong
  phrase restored by mistake. `tests/sign04_test.py` covers the stopped restore, the PIN (none, wrong, right) and a
  restore after.
- **The phrase box** asks the Android app, while it is in use (focused, or not empty), to keep the screen out of
  screenshots, screen recording and the recents picture (`FLAG_SECURE` on the wallet's window, through
  `LogosAndroid.secureScreen`), and to turn autofill off for the page (`importantForAutofill`: Android can't single
  out one field of a WebView, so it is the whole page, only while the box is in use). The rest of the time the screen
  is normal, so `adb shell screencap` of the wallet still works. A paste into the box empties the phone's clipboard
  (`LogosAndroid.clearClipboard`); a keyboard's own clipboard history is the keyboard's.
- A phone with no desktop wallet makes its own: **Create a new wallet** (above).

## What it sends

One job at a time, `names` started with fixed arguments, its output shown only through allowlists
(`signer04.PROGRESS`, `signer04.ERRORS`):

| Press | Command |
|---|---|
| Send to `Public/<id>` | `wallet auth-transfer send --from Public/<first> --to Public/<id> --amount N` (refused first if the network hasn't seen that account: such a transfer reverts and still pays its fee) |
| Send to a public key | `wallet auth-transfer send --from Public/<first> --to-pk <hex> --amount N` |
| Send to an LNS name | `pay --public --from=Public/<first> -- <name> N` |
| NFTs: Receive an NFT | `--nft-program P nft init --definition D --account <first>`, or `--new public --fee-payer <first>` when the first account already has a holding under P |
| NFTs: Send | `--nft-program P nft send --from A --to Public/<id>\|<name>` (`--fee-payer <first>` when A isn't the first account) |
| Send to `Public/<id> <public key>` (what Receive copies) | `wallet auth-transfer send --from Public/<first> --to-pk <key> --amount N`, after checking the key is that account's (its id is sha256 of `/LEE/v0.3/AccountId/Public/` padded to 32 bytes and the key); refused if not |
| NFTs: Claim NFT (free) | `deed claim <name>`: offered on a name held by one of the wallet's accounts (matched by its owner tag), 5-32 characters, with no NFT yet. The holder pays the fee. |
| Settings → Your name: Register this name | `register <name> --owner Public/<first> --wait`, then `set-account <name> Public/<first>`, then `profile <name> --set blockchain=<node wallet key> --set msg=<messaging address>`: one job (below) |
| Your name: Point it at this phone (also Messages' "Use <name> for messages") | `set-account`, then `profile --set blockchain=… --set msg=…` |

A claim needs the locked-name list (61 MB) for its length proof. The tool can't download it itself (its HTTPS client
can't check certificates outside an app's Java runtime), so the server downloads it once from logos-names' release
`shortlist-9778bed4` (one redirect, to `*.githubusercontent.com` only), checks its pinned sha256, keeps it at
`<data>/.lez04-wallet/cache/shortlist-9778bed4.bin` and hands it over as `NAMES_SHORTLIST`.

**Fees.** A bare call holds its whole cap as the fee reserve while it runs: about 8.6M LEZ for a claim at today's base
fees (gas limit 945,000), of which about 1.34M is paid. One faucet grant (10,000,000) covers one claim, and a second;
a claim after spending more than about 1.4M of it is refused for its reserve. A tighter cap is a logos-names change.

**"It may have been sent."** The forwarder counts each batch with `sendTransaction` it passes on. Only a 429 (the
proxy's rate limit: nothing passed on) or a 200 whose answer to every `sendTransaction` is a JSON-RPC error counts as
refused. An error page (a 502 from the proxy), no answer (the 60 s timeout) or an answer that doesn't read leaves it
"may have been sent". A job that then fails, or is stopped by its time limit, ends with "It may have been sent. Check
this account's balance before you try again." (a send), or "… Check NFTs before you try again." (an NFT or a
claim), whatever `names` printed; only "It was included in block N but didn't take effect" is kept, as it is certain.
LEZ 0.4 has no Activity list on the phone, so the line points at the balance or NFTs. The page then empties
what was typed (To and Amount, an NFT's To, the collection ID), so a second send has to be typed again: it would be a
new transaction and could pay twice. A claim's button stays off until NFTs is read again (a second claim of a
name whose NFT landed fails on chain and costs only its fee).

A job that ends that way while no press on the page follows it (the page was reloaded or locked meanwhile) is said at
the top of the Wallet on LEZ 0.4, with what it was ("Send of 7 to Public/…: It may have been sent. …"), until the
next job. While a transaction is out, `<data>/wallet-lez04-unsure.json` (0600: the kind, the recipient and amount as
shown, the time; no key) is on disk. It goes when the job ends. If the app stops first, the next start shows "… The
app stopped while this was being sent. It may have been sent. …" there, for a day or until the next job.
There is no hold that refuses the same send again, as on LEZ 0.3: the line is the fix.

## Your name: an LNS name for the phone's own account

Settings → Your name (`app/net04/name04.js`) asks for the name only: the account is the phone's own first LEZ 0.4
account, whose key is here, so no address or public key is ever asked. 5 to 32 characters (1-4 are locked; a name on
the reserved list is refused by `names` with "is locked"). Before anything is sent the page looks the name up itself
(names.js through `/api/names/rpc`): a taken name is said at once and nothing goes out.

The job (`signer04.register`, `POST /api/wallet/lez04/register {name}`), one at a time like every other:
1. The locked-name list, once (`fetch_shortlist`, as for a claim): **61 MB** from logos-names' GitHub release, over the
   phone's connection, checked against its sha256, kept in `.lez04-wallet/cache/`. Your name says so before the button
   while the list isn't on the phone. Its download time and `names`' memory for the length proof on the Pixel are not
   measured yet (the claim, which needs the same list, has never run on the phone either).
2. `names register <name> --owner Public/<first> --wait` with `NAMES_SHORTLIST`: the commitment (`step 1 of 2`), then
   at least **15 minutes** (`MIN_COMMIT_AGE_MS`) so nobody who sees the reveal can take the name first, then the reveal
   (`step 2 of 2`) with the **deposit** (1,000,000 test LEZ on our registry today, deposit mode: held while the name is
   kept, refunded on release). Both are sent unchecked by the bare build, like a claim. `names` keeps the commitment in
   `.lez04-wallet/names.json` (in the app's backup) for up to 24 hours.
3. `set-account <name> Public/<first>`: the name shows the phone's account, so it can be paid on LEZ 0.4 by name.
4. `profile <name> --set blockchain=<the node wallet's Main key> --set msg=<the messaging address>`: one change; either
   is left out while unknown (no node key yet, Messages off).
The page says it all before the button: about 20 minutes, keep the app open, other LEZ 0.4 sends and backups wait
until it ends (the job holds the signer's one lock: two `names` on one wallet could race on names.json), the deposit
and the fees, and that anyone who looks the name up sees the phone's LEZ 0.4 account, its Logos address and its
messaging address.

**Stopped part way.** `wallet-lez04.json` keeps `registering: {name, at}` from the press until step 2 lands. If the app
is killed (or a step fails), Your name says so and offers **Continue**, which runs the same job again: `names` resumes
the saved commitment ("going on with the commitment … made earlier": no second commit) within its 24 hours; a reveal
that landed before the app stopped is found on the network first (`held_here`: the record's owner tag is the first
account's), and only steps 3 and 4 run. When steps 3 or 4 fail, the name is the phone's already (`name` in
`wallet-lez04.json`, and in the backup's LEZ 0.4 part) and Your name offers **Point it at this phone**.

**Fees** (the bare build's caps, `unchecked_limit` = 3 × the measured cycles, and today's base fee of 8; not measured on
the phone): the commit holds about 0.63M and pays about 0.2M; the reveal holds about 4.5M and pays about 1.3M, plus the
1,000,000 deposit; each of steps 3 and 4 holds about 1.8M and pays about 0.5M. About 3.6M in all out of the faucet's
10,000,000. **After it, a Claim NFT (free) of the new name does not fit the rest of one faucet grant**: a claim holds
about 8.6M while it runs (above) and about 6.4M is left. The phone then needs more test LEZ (a send from the desktop
wallet) before it can claim.

**Checked:** `tests/sign04_test.py` (the stand-in tool: a taken name, a reveal that fails then Continue on the same
commitment, the entries, Point again, the backup carrying the name, `held_here`) and `tests/sign04_ui.mjs` (the page).
Not yet run against the live LEZ 0.4: on 2026-11-20 the faucet refused a throwaway wallet ("Too many test LEZ grants
from this address today"), so the laptop run of this route with the host `names` stopped before registering.

## The faucet

"Get free test LEZ": `bridge_faucet` on our proxy with `[public key, null, the first account]`, as the LNS page asks
(the faucet gives once per account and once per wallet, ever). The phone remembers a grant, with the chain id it
was on, and doesn't ask again on that chain (after a reset it may).

## HTTPS and the rate limit

`names` talks plain HTTP to `server.py` at `/lez04-rpc/<secret>` (a new secret each start, its own, not the LEZ 0.3
forwarder's); `server.py` forwards over HTTPS to the LEZ 0.4 network in use (lez04.json's `rpc_url`, or the network
entered in Settings → Network). Only the methods in `signer04.RPC_METHODS` pass; at most 20 calls in a batch.

Every call this app makes to LEZ 0.4 (the reader, the forwarder, the faucet) goes through one pacer: at most one every
0.25 s, 40 in 10 s, under the proxy's 50 per 10 s per address. A read refused with 429 is tried again twice after a
pause; `sendTransaction` is never sent twice.

## The Node screen and the wallet's lock (fixed 2026-11-20)

The Node screen (Start/Stop, start from a snapshot, go back to the previous state, the messaging switches, the log)
opens only while the wallet is unlocked. Before, the cream "Starting the wallet…" cover had a native Node button that
opened it with no lock check (the cover shows before the page's PIN/fingerprint lock), as did the old top-right Node
button, and the Node screen checked nothing: anyone holding the phone with the wallet locked could stop the node or
replace its database with any snapshot file (and the wallet would then read a false chain state).

- The source of truth is the wallet server's own session: `server.native_unlocked()` (no HTTP route; true only while
  server.py holds an open session, made by a PIN or fingerprint unlock and ended by its rules: Lock now, idle,
  leaving, fingerprints changed). The page can't set it.
- `WalletLock` asks it: in the wallet's process directly, and from the Node screen (the main process) through a
  non-exported content provider that runs in the wallet's process. Any failure answers "locked".
- Both native Node buttons are gone; the only way in is the page's Settings → Node → Open node, which is behind the
  page's lock and also checked natively.
- The Node screen shows nothing until the answer is "unlocked"; entered while locked (onCreate, onResume) it closes;
  if the wallet locks while it shows, it drops to a read-only status (process, height, peers) with its controls and
  log hidden and any open confirmation closed; every action asks again right before it runs.
- The Node screen counts as being in the app: while it shows (and is unlocked) it tells the wallet server "visible"
  every 3 s (`WalletLock.report`, server.native_visibility), so only the idle auto-lock applies there; leaving the app
  from it (Home, the screen off) reports "hidden" and starts the minute, as on the wallet's own screen. "visible" never
  reopens a locked wallet.
- Known limits, left as they are: the node notification's **Stop** action stops the node without the wallet's lock
  (Android's own notification, on the lock screen too); the node service is exported to holders of DUMP only (the adb
  shell), which can start and stop it; and with both native Node buttons gone, the Node screen can't be reached while
  the wallet server won't start (the cover says the node is not affected).

## Known limits

- **A custom LEZ 0.4 network decides where signed sends go** (review S4). The signer and the forwarder send to the
  network in use (`rpc_url`), which Settings → Network can set to any HTTPS address, or `http://127.0.0.1:<port>`.
  `pay --public <name>` and `nft send … <name>` look the name up through that network. A hostile network (set by
  someone holding the unlocked phone, or any app on the phone serving 127.0.0.1) could answer a name with its own
  account and pass the signed transaction on to the real chain: the send lands with it. Not fixed: use the built-in
  network for sends, and send to `Public/…` accounts rather than names when another network is set.
- The keyboard may learn the phrase's words; a keyboard's clipboard history may keep a pasted phrase.
- The phrase stays in the app's memory (Python and the WebView) until that memory is reused; it can't be wiped.
- Android 12+ device-to-device transfer may copy app data to a new phone even with `allowBackup="false"` (not
  checked; no `dataExtractionRules` yet).
- Restoring needs only an unlocked session, not the PIN again. The page shows the first account after a restore;
  compare it with the desktop's.

## The release build

A real recovery phrase goes only on a phone running the **release build**: not debuggable (no `run-as`, so no computer
with USB debugging can read `storage.json`; WebView remote debugging off, `WebView.setWebContentsDebuggingEnabled(
BuildConfig.DEBUG)` before the first WebView; none of the debug builds' adb extras), and signed with a private key
(the debug key is public in this repository, so anyone could sign an "update" that would keep this app's data).

- `android/app/build.gradle.kts`, build type `release`: `isDebuggable = false`, minify off. Signed only with the key
  named by `LOGOS_RELEASE_STORE_FILE`, `LOGOS_RELEASE_STORE_PASSWORD`, `LOGOS_RELEASE_KEY_ALIAS` and
  `LOGOS_RELEASE_KEY_PASSWORD` (environment, or `~/.gradle/gradle.properties`; never `-P` on a command line). Without
  all four, with the debug key, or with a key file inside the repository, packaging stops with a plain message: no
  unsigned APK, never the debug key.
- CI never holds the key (the repository is public). `android-app` checks the release variant compiles, isn't
  debuggable, and that packaging refuses without the key (and with the debug key, or a file in the repository).
- `scripts/build-release.sh` builds it locally from the checkout's HEAD commit, exactly as committed, in a folder of
  its own; downloads the pinned binaries from the same CI runs as the debug APK (each checked against its sha256);
  runs the release unit tests and `assembleRelease`; then checks the APK: signed by the release key's certificate and
  not the debug one, not debuggable, every pinned binary and web app file byte for byte. Where it runs:
  - **The MacBook**, through `~/logos/laptop-build.sh` (its `TMPDIR` is on the external SSD, so the build and Gradle's
    caches land there). One-time: the Android SDK on the SSD (`ANDROID_HOME=/Volumes/Bitcoin/logos-build/android-sdk`;
    the script installs platform 36 and build-tools 36.0.0 there with Homebrew's `sdkmanager`); Gradle 8.14.3 is
    downloaded by the script. JDK 17 and `gh` are already there. The key stays on the MacBook.
  - The Dell (`ssh dell`, Linux) works the same way, with an SDK there, but the key would then sit on the build box.
  - Not the Mini: its internal disk is nearly full. It only installs the finished APK (`adb install`).
- **Keep the keystore and its passwords for good.** Every later release must be signed with the same key; a release
  signed with another key can only be installed after an uninstall, which wipes the app's data again.
- What a release build loses: `run-as` (so the `adb shell run-as … cat files/…` reads in BATTERY.md and elsewhere stop
  working), WebView remote debugging, `.WalletDebug`'s probe and crashrenderer extras, and the node service's debug
  extras (messaging switches from adb, test import, full replay). `am start-foreground-service` on the node service
  still works (it needs only the adb shell's DUMP). Screenshots by adb work except while the phrase box is in use.

## Moving to the release build

**From app 0.5.32 (web app 0.9.33) on, the app is LEZ 0.4 only and makes backups in its own format, version 3.** It
restores only version 3 files: a backup made by an earlier version (version 1 or 2, or any with a LEZ 0.3 name account
in it) is refused with "This backup is from an older version and can't be restored here." (Jef, 2026-11-20: "Don't
migrate old data"). `tools/decrypt-backup.py` still opens every version, so an old file's keys can be read by hand.
The steps below are the move to 0.5.30 and are kept for the record.

A release-signed APK can't install over the debug-signed one (Android refuses a different signature), so the phone
uninstalls the debug build first, and **an uninstall deletes all of the app's data**. The app's encrypted backup file
carries the keys that can't be made again; everything else is set up again or read again from the network.

What the backup file holds (Settings → Backup & restore → Back up; `backup_export` in `app/server.py`):
- the node's wallet keys (`keystore.yaml`);
- with Messages on: the messaging key, profiles, nicknames and notes, and the message history (the page always asks
  for it: newest first, up to 1 MB; older messages are left out);
- the phone's LEZ 0.3 name account: its wallet file (the key, which has no recovery phrase) and `names.json`.

What it does not hold, and is lost or made again:
- the LEZ 0.4 accounts (type the desktop's recovery phrase again, on the release build);
- the node's chain data (it syncs again, or starts from a snapshot: docs/start-from-a-synced-database.md);
- the PIN, fingerprint unlock, Settings (theme, network choice, Mobile mode, the Messaging node switch), NFTs'
  lists (NFT programs, names) and watched addresses, the Wallet's Activity history, the event log;
- message requests and dropped messages; history beyond 1 MB;
- anything in flight: a bridge deposit, a name registration, a LEZ 0.3 "may have been sent" hold. Finish them first.

Steps (the Mini drives the phone over adb):
1. On the debug build, let every running job finish (no send, claim, bridge or registration in progress).
2. Settings → Backup & restore → Back up: a backup password (12+ characters, written down off the phone) and the PIN.
   Save the file to Downloads in the picker.
3. On the phone: the result has no "The name account is in it, but couldn't be checked" line, and Your name doesn't
   say "back up needed" (the server compares the name account's files with what the last backup held, so a backup
   that left it out keeps saying it). If either shows, back up again.
4. Copy the file off the phone: `ssh minim4 'adb pull /sdcard/Download/logos-node-wallet-backup-<date>.json ~/'`
   (and keep a second copy). Files in Downloads survive the uninstall, but don't rely on that alone.
5. Prove the copy opens with the password and holds what it should, writing nothing:
   `python3 tools/decrypt-backup.py --check logos-node-wallet-backup-<date>.json` (needs the `cryptography` package,
   e.g. in a venv: `python3 -m venv ~/.venv-backup && ~/.venv-backup/bin/pip install cryptography`, then run it with
   `~/.venv-backup/bin/python`). It must say "opens with this password", the node's key file, the messaging key, and
   "the LNS name account (LEZ 0.3): Public/<the phone's account>". Don't go on until it does.
6. Uninstall the debug build: `ssh minim4 'adb uninstall io.github.jefdiesel.logosnode'`.
7. Install the release APK: `ssh minim4 'adb install <the release APK>'` (copied to the Mini from where
   `build-release.sh` put it; check it against its `.sha256`).
8. Open the app, set a new PIN, then start the node: Settings → Node → Open node → **Start**, and wait until the Node
   screen shows the node process running. A fresh install doesn't start the node by itself, and the node makes its
   key file (`keystore.yaml`) only at its first start; until then a restore answers "The node hasn't run on this
   phone yet … Start the node first …, then restore" and changes nothing. The restore replaces those new keys.
9. Settings → Backup & restore → Restore from a backup: the file, the backup password, the PIN, tick, Restore. The
   node's keys, the messaging key and chats, and the LEZ 0.3 name account come back; the node restarts. Check Your
   name shows the same account as before.
10. Turn on again what was on: the Messaging node switch, Mobile mode, fingerprint unlock, the network choice;
    add NFTs' programs and names again.
11. Check the release build on the phone before the phrase: with the phrase box focused, `adb shell screencap` gives
    a black picture, and `chrome://inspect` on the computer lists no WebView of the app.
12. Only now: Wallet on LEZ 0.4 → Set up your LEZ 0.4 wallet → **Create a new wallet** (the phone's own accounts;
    write the 24 words on paper), then make an app backup. ("Use a recovery phrase" takes a phrase you already have.)

From then on install only release builds signed with the same key. A CI debug APK won't install over the release
build (that is the point); installing one means another uninstall.

## Receive: the account and its key as one item

LEZ 0.4 credits a public account the network has never seen only when the sender gives its public key. So Receive
shows the phone's account and its public key together and copies them as one item, `Public/<id> <key>` (one Copy, and
the QR code holds the same text). This app's Send takes that item (and the Logos Send's Scan hands it to LEZ 0.4's
Send); it checks the key is that account's and pays by the key. Other wallets (the desktop Names Wallet,
nameswallet.app) don't read the pair yet: there, paste the key part.

## Not on the phone yet

Private accounts, sends and claims; printing and burning NFTs; bridged tokens' sends; a name's other records (only
`blockchain` and `msg` and the public account are set from the phone). A second name for the phone (Your name holds
one). Names the desktop holds are found by adding them under NFTs → Your LNS names (a restored wallet has no list of
them).

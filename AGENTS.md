# AGENTS.md

A short guide for developers (and coding agents) working in this repository.

## What this is

Names Wallet: a Logos blockchain node, a wallet and end-to-end encrypted messages, running on an Android
phone. Unofficial community work, testnet only.

- `app/`: the web app. `server.py` (Python, no third-party packages) serves the wallet page `index.html`,
  talks to the node and the messaging node, and keeps the wallet's and the chats' files. `messages/` is the
  Messages screen (`messages.js`) and its model (`chat-core.js`); `msg-crypto.js` and the `noble-*` folders
  are vendored (see `app/messages/VENDORED.txt`). `lns/` is "Your name" (Android only). `release.json` lists
  every file and its sha256: the in-app updater uses it.
- `android/`: the Android app (Kotlin) that runs the node, the messaging node and `server.py` (in embedded
  Python), and shows the page in a WebView. Read `android/README.md` first.
- `native/`: builds the blockchain node for Android from its source, with the patches in `native/patches/`.
- `messaging/`: the messaging (Waku) node runner and its configs. See `messaging/README.md`.
- `install.sh`, `install-termux.sh`: install the node and the web app on Linux (Android's Terminal app) or
  in Termux. See `README.md`.
- `tests/`: every test the CI runs (below). `tools/`: `release.py`, `decrypt-backup.py`, `msg-peer.mjs`.
- `docs/`: user-facing notes (`messages.md`, `backup.md`, `updating.md`, `sync-on-a-phone.md`,
  `start-from-a-synced-database.md`).

## Branches

- `main` (the default branch): the Linux and Termux install, and the web app. When every CI job passes on
  `main`, the `promote` job moves `release` to that commit.
- `release`: what installed web apps update from. Only CI moves it; never push to it.
- `android-app`: the Android app's line (the APK the phone runs). Work branches start from it and merge
  back after review.
- Other branches are work in progress or older lines.

## Building

Everything is built in CI. Nothing needs to be built on a laptop.

- `.github/workflows/android-app.yml`: the debug APK. It takes the node, the messaging library and the LNS
  signer from earlier CI runs pinned in `android/node.properties`, `android/messaging-run.txt` with
  `android/messaging.sha256`, and `android/names.properties`, checks each against its sha256, runs the
  unit tests and checks the APK. The APK is a workflow artifact only.
- `.github/workflows/native-build.yml`: the blockchain node for Android arm64 (and Linux arm64).
- `.github/workflows/waku-build.yml`: the messaging library and its runner.
- `.github/workflows/names-build.yml`: the LNS command line `names` for Android arm64.
- `.github/workflows/install-test.yml`: the installers on clean arm64 Linux machines, and the web app's
  tests (below).

To build the APK on a computer (from `android/README.md`, "Building"): JDK 17, Android SDK platform 36
and build-tools 36.0.0, Gradle 8.14. Copy the node binary to
`android/app/src/main/jniLibs/arm64-v8a/liblogosnode.so`, then in `android/`:

```sh
gradle --no-daemon assembleDebug -PnodeVersion=0.3.4 -PnodeSha256=<sha256 of the binary>
```

## Tests

The tests need Python 3 and Node.js (22 or later); a few need more, as noted.

```sh
python3 tests/crypto_test.py              # the app's ChaCha20-Poly1305 against RFC 8439
python3 tests/autolock_test.py            # auto-lock
python3 tests/embedded_test.py            # inside the Android app (APP_EMBEDDED=android)
python3 tests/app_key_test.py             # the app key: every route refused without it
python3 tests/messaging_socket_test.py    # the messaging node over its Unix socket
node tests/chat_test.mjs                  # chats: 1:1, history, key changes, backup and restore
node tests/msg_v2_test.mjs                # Requests, padding, safety codes, store and inbox safety
node tests/msg_hostile_test.mjs           # hostile sender names never stop the chats
CHROME=/path/to/chrome node tests/chat_ui.mjs   # the Messages screen in headless Chrome
```

- `chat_test.mjs`, `msg_v2_test.mjs` and `chat_ui.mjs` take `PORT_SHIFT=<n>` to move their ports when the
  defaults are busy (`msg_hostile_test.mjs` uses none).
- `NAMES_MSG_CRYPTO=<the names project's built msg-crypto.js>` adds checks against the names project's
  own build (CI downloads it; see `install-test.yml`).
- Some steps need the real node or old app folders (`wallet_test.py`, `update_test.py`, `upgrade_test.py`):
  run them as `install-test.yml` does.
- A change to any file in `app/` needs `python3 tools/release.py write` (or `bump <version>` for a release),
  and `python3 tools/release.py check` must pass.

## Rules

- **No secrets in the repository.** No keys, tokens, PINs or seeds, in files, commit messages or test data.
  Tests make their own keys at run time.
- **`android/debug.keystore` is public on purpose.** It is the standard throwaway Android debug key,
  committed so every build has the same signature and installs over the previous one. It protects
  nothing and is not a release key.
- **Pins.** The APK uses binaries from pinned CI runs, each checked against a sha256:
  `android/node.properties` (the node: variant, version, commit, run and sha256s),
  `android/messaging-run.txt` and `android/messaging.sha256` (the messaging runner and library), and
  `android/names.properties` (the LNS signer). To change a pin, run the build workflow, then put the new
  run id and the sha256 from its `SHA256SUMS` in those files, in one commit, and let `android-app` check
  it. Never edit a sha256 by hand to make a check pass.
- **Never weaken the local-API auth.** The node and the messaging node listen on private Unix sockets, and
  every wallet request needs the app key cookie, the right Host and Origin, and (for the wallet and
  messages) an unlocked session. Read `android/LOCAL-APIS.md` before touching any of it.
- **Vendored code** is changed only by re-vendoring from its source, never edited in place (see the
  `VENDORED.txt` files).
- **Android limits apply to the app's own Python:** no hard links, no files outside the app's own folders.
- Plain words in the user interface; keys are "messaging address", LNS names are bare like `alice`.

## Where the docs are

- `README.md`: what it is, installing on Linux or Termux, what works.
- `android/README.md`: the Android app, building, signing. `android/LOCAL-APIS.md`: the local APIs and
  their protection. `android/NAMES.md`: "Your name" and the LNS signer. `android/BATTERY.md`: battery.
- `native/README.md`, `native/patches/README.md`: the node build and its patches.
- `messaging/README.md`: the messaging node.
- `docs/messages.md`: Messages (requests, safety codes, limits). `docs/backup.md`, `docs/updating.md`.

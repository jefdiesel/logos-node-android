# Audit package

For an outside security review of the Android app "Logos Names" (the wallet, messages and LNS name account
that run with a Logos Blockchain node on a phone). Everything here was written from the code. Where code and
older documents disagree, these documents follow the code and say so.

**Commit described:** `d00ee0f` (branch `android-app`: Android app 0.5.11, web app 0.9.12,
`app/server.py:11`). The branch carrying this package adds only `docs/audit/`, `tests/vectors/`,
`tests/messages_v1_vectors.mjs` and one CI step; it changes no app code.

## Documents

| document | what it is |
|---|---|
| [messages-v1-spec.md](messages-v1-spec.md) | The one-to-one message format "Names Messages version 1", byte for byte as implemented, in normative language, with how messages are stored |
| [threat-model.md](threat-model.md) | Assets, trust boundaries, and what each kind of attacker can and cannot do today; the lock model; the debug-build facts |
| [name-account.md](name-account.md) | The LEZ name account: making, storing, backing up, restoring, repairing; the one-tap job's states and brakes; the signer's forwarder |
| [open-questions.md](open-questions.md) | What could not be settled from the code, and every place that looks wrong or fragile, with file:line |
| [`tests/vectors/messages-v1.json`](../../tests/vectors/messages-v1.json) | Test vectors for the message format, with test-only keys and every intermediate value |

Other documents in the repository, written earlier, explain the design: `README.md`, `android/README.md`,
`android/NAMES.md` (the name account), `android/BATTERY.md`, `docs/messages.md`, `docs/backup.md`.

## Scope

**In scope**

- `app/server.py`: the wallet server (PIN, sessions, auto-lock, backup and restore, the node API calls,
  messages storage and delivery, the LNS name account and its signer, the forwarder).
- `app/index.html`, `app/messages/*.js`, `app/lns/lns.js`, `app/names/*.js`: the page, the message
  cryptography and chat model, the name resolver.
- `android/app/src/main/`: the Android app (WebView, JavaScript bridge, fingerprint unlock, the service that
  runs the node and the messaging node, node-state import), its manifest and build configuration.
- The build and release path in `.github/workflows/` (pinned binaries, debug signing, `release` branch).

**Out of scope** (bundled, pinned by SHA-256, built in other repositories or other workflows of this one)

- The Logos Blockchain node (`android/node.properties`), the messaging node (`android/messaging.sha256`) and
  the `names` signer (`android/names.properties`) as programs. Their interfaces as this app uses them are in
  scope; their internals are not. Some questions depend on them; they are listed in
  [open-questions.md §E](open-questions.md#e-not-determinable-from-this-repository).
- The vendored libraries (`@noble/*` 2.4.0, jsQR, ZXing, the QR encoder) beyond how they are called.
- The Linux and Termux installers (`install.sh`, `install-termux.sh`), except where they share `app/`.
- The Logos Blockchain, LEZ and Waku protocols themselves.

## Building

The APK is built only in CI, by `.github/workflows/android-app.yml`: it downloads the three pinned binaries
from earlier workflow runs, checks each against its SHA-256, places them in `jniLibs`, runs the Kotlin unit
tests and `assembleDebug`, then checks the APK's contents, permissions and classes. To reproduce it, follow
that file's steps (Gradle 8.14.3, JDK 17, Android build-tools 36.0.0). There is no release build
([threat-model.md §6](threat-model.md#6-debug-build-facts-an-auditor-will-raise)).

The web app needs nothing built: `python3 app/server.py` serves it on `127.0.0.1:8090` (Python 3 standard
library only). Inside the Android app the same file runs under Chaquopy with `APP_EMBEDDED=android`.

## Running the tests

CI runs all of them (`.github/workflows/install-test.yml`, `android-app.yml`). The ones that need neither a
running node nor a browser, from the repository root:

```sh
node tests/messages_v1_vectors.mjs        # the message format against its spec and test vectors
python3 tests/crypto_test.py              # the server's ChaCha20-Poly1305 against RFC 8439
python3 tests/sync_test.py                # how the app reads the node's sync state
python3 tests/autolock_test.py            # auto-lock timings
python3 tests/embedded_test.py            # behaviour inside the Android app (APP_EMBEDDED=android)
python3 tests/lns_test.py                 # the name account, with a stand-in signer and sequencer
python3 tests/lns_funding_test.py         # faucet and bridge, with stand-ins
python3 tests/lns_flow_test.py            # the one-tap job: restarts, retries, brakes
python3 tests/messaging_switch_test.py    # the messaging node switched on and off
node tests/messaging_test.mjs             # two apps exchanging messages through a fake messaging node (needs python3-cryptography)
node tests/chat_test.mjs                  # chats, key change, backup and restore of chats (CI also sets OLD_APP)
(cd android && gradle testDebugUnitTest)  # Kotlin unit tests (needs the Android SDK)
```

`tests/wallet_test.py`, `tests/names_test.mjs` and `tests/update_test.py` need a running node or chain;
`tests/chat_ui.mjs` and `tests/lns_ui.mjs` need Chrome. See the workflow for how each is started.

## Known weaknesses, stated plainly

These are the most important findings from writing this down. Each is detailed, with evidence, in
[open-questions.md](open-questions.md) and [threat-model.md](threat-model.md).

1. **Other apps on the phone can reach the node's and the messaging node's local APIs.** The wallet server
   calls the blockchain node's API (which can transfer coins) and the messaging node's REST API on
   `127.0.0.1` without any credential. Unless the node has access control this repository can't show, any
   installed app can do the same, and the PIN does not stop it.
2. **Keys are stored unencrypted.** The node's keys, the messaging key and the LEZ name-account key are plain
   files protected only by Android's app sandbox. The PIN guards the app's API, not the files. No key uses
   the Android Keystore.
3. **The app is shipped as a debug build signed with a public key.** USB debugging gives `run-as` access to
   every key file and WebView debugging; anyone can sign an "update" that would get the app's data.
4. **Names are resolved from one server's answer, unverified.** The LEZ sequencer endpoint decides what
   address "Send to a name" pays and which messaging key a first contact pins.
5. **The one-tap name job signs with the name account's key while the wallet is locked**, for up to 48 hours
   after the tap. Its spending brake has gaps.
6. **Messages have no forward secrecy and no replay protection** beyond an 8000-entry duplicate memory, and
   anyone can push real messages out of an inbox by sending 2000 junk payloads to its public topic.
7. **The messaging secret key is handed to any unlocked page** (the page does the cryptography), while
   exporting a backup asks for the PIN again.
8. **The LEZ name account has no recovery phrase**; a backup made after the account exists is the only way
   back, and a backup can silently leave it out on an internal error.
9. **The first local program to set the PIN wins**, and PIN guessing by a local program is limited only to
   five tries per five minutes.

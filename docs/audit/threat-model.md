# Threat model, as the code stands

This describes commit `d00ee0f`. Every claim cites the code; "not determinable" means this repository does
not settle it (usually because the behaviour is inside a bundled binary built elsewhere). Paths under
`android/app/src/main/java/io/github/jefdiesel/logosnode/` are written `kt/<File>.kt`.

## 1. The system in one picture

```
 ┌───────────────────────────── one Android app (uid of the app) ──────────────────────────────┐
 │                                                                                             │
 │  process ":wallet"                                    default process                       │
 │  ┌───────────────────────────┐                        ┌──────────────────────────────┐      │
 │  │ WalletActivity            │                        │ NodeService (foreground)     │      │
 │  │  WebView ── page (JS) ────┼─HTTP 127.0.0.1:18190──▶│  ├─ child: blockchain node   │      │
 │  │   window.LogosAndroid     │        │               │  │   API 127.0.0.1:18180     │      │
 │  │ Python (Chaquopy):        │        │               │  └─ child: waku-runner       │      │
 │  │  app/server.py  ◀─────────┼────────┘               │      REST 127.0.0.1:18645    │      │
 │  │   ├─ child: names (LEZ signer) ─HTTP /lez-rpc/<secret>─▶ server.py ─HTTPS─▶ LEZ RPC│      │
 │  └───────────────────────────┘                        └──────────────────────────────┘      │
 │   server.py ──HTTP──▶ node API 18180, waku REST 18645 (loopback, no credential)             │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
        network: node p2p · Waku relay/store peers · LEZ sequencer RPC (HTTPS) · LEZ faucet (HTTPS)
```

- Wallet server: `server.py` bound to `127.0.0.1:18190` (`server.py:4737`; port `kt/LogosApp.kt:31`),
  started in the `:wallet` process with environment from `kt/LogosApp.kt:63-78`.
- Blockchain node API: `127.0.0.1:18180` (`kt/NodeFiles.kt:88, 130`).
- Messaging node (Waku) REST: `127.0.0.1:18645`; p2p TCP 60000 and discv5 UDP 9000 (`kt/Messaging.kt:21-24`).
- `names` (the LEZ signer, `libnames.so`) is started by `server.py` with a fixed environment; its only way
  out is the forwarder path `/lez-rpc/<16 random bytes in hex>` on the wallet server
  (`server.py:310, 602-608, 4450-4463, 2352-2370`).

## 2. Assets

| asset | where | at rest | who can use it through the app |
|---|---|---|---|
| **Logos Blockchain wallet keys** | the node's `keystore.yaml`, `files/node/` (`kt/NodeFiles.kt:18`) | plain file made by the node's `init-config`; mode not set by this app (a restore writes 0600, `server.py:3899, 3942`) | the node signs transfers for any caller of its API (§4.4) |
| **LEZ name-account key** (the wallet seed and signing key of the phone's LNS name account) | `files/wallet/.lns-wallet/storage.json`, `names.json` beside it | **plain JSON**, folder 0700, files 0600 (`server.py:301, 445-462`); no recovery phrase exists (`server.py:680-707`) | `names`, started only by `server.py` |
| **Messaging key** (Ed25519 seed and X25519 pair) | `files/wallet/wallet-msgkey.json` | **plain JSON**, 0600 (`server.py:3163, 3271-3275`) | any unlocked page (`GET /api/messages/key`, `server.py:3787-3792`) |
| **PIN** | `files/wallet/wallet-pin.json` | scrypt N=2^14, r=8, p=1, 16-byte salt (`server.py:2655-2667`); 6 to 12 digits (`server.py:31`) | gates the wallet server's API only |
| Session token | server memory; page `sessionStorage` (`app/index.html:509, 523`) | not on disk | `X-Session` header (`server.py:4323-4324`) |
| Chats | `wallet-inbox.json`, `wallet-outbox.json`, `wallet-chat.json` | sealed or encrypted under keys from the messaging key, see [messages-v1-spec.md §14](messages-v1-spec.md#14-what-is-stored-where-and-how) | unlocked page |
| **Backups** | a file the user saves (Downloads by default, `docs/backup.md`) | scrypt N=2^16 + ChaCha20-Poly1305; holds all three key sets, chats and the name account (`server.py:4027-4070`) | whoever has file and password |
| Funds in flight | bridge state `wallet-bridge.json`, one-tap job `wallet-lns-flow.json` | plain | background threads, also while locked (§5) |

There is no Android Keystore protection of any key. The only Keystore key is the fingerprint-unlock key,
which encrypts one throwaway byte to prove a fingerprint check happened (`kt/FingerprintKey.kt:24, 45-51,
102`).

## 3. Trust boundaries

| # | boundary | what is checked | evidence |
|---|---|---|---|
| B1 | WebView page → wallet server | `Host` must be `127.0.0.1:18190` or `localhost:18190` for `/api/wallet*` and `/api/messages*`; every POST needs `Origin` in the same set and `Content-Type: application/json`; most routes need the session token. These are **headers**: they stop other web pages (DNS rebinding, cross-site requests), not other local programs | `server.py:28-29, 4319-4324, 4348, 4468-4471` |
| B2 | WebView → native code (`window.LogosAndroid`) | most methods check the WebView shows `http://127.0.0.1:18190` (`isOwnPage`); none checks that the wallet is unlocked; `mobileMode()` checks nothing | `kt/WalletActivity.kt:476-574`; `kt/FingerprintUnlock.kt:73-79` |
| B3 | WebView navigation | only `http://127.0.0.1:18190` is loaded; file and content access off | `kt/WalletActivity.kt:196-199, 387-392` |
| B4 | native code → server.py | in-process calls with no HTTP route: `native_unlock()` (opens a session after the Kotlin fingerprint check), `native_fingerprint_reset()`, `set_waku_api()` | `server.py:3098-3106, 3153-3162, 3823-3839`; `kt/WalletActivity.kt:52` |
| B5 | server.py → `names` | fixed argument lists; environment replaced entirely; umask 077; only allowlisted progress and error texts of its output are shown | `server.py:602-608, 321-351, 656-677, 879-880` |
| B6 | `names` → LEZ sequencer | via the forwarder: secret path (compared in constant time), `Host` check, method allowlist (incl. `sendTransaction`), 2 MiB request cap, HTTPS only, no redirects | `server.py:310-314, 4450-4463, 2352-2370, 227-256` |
| B7 | server.py → node API, Waku REST | plain HTTP on loopback, **no credential sent** | `server.py:51-56, 3331-3348`; `_loopback_url` refuses non-loopback Waku URLs, `server.py:3120-3135` |
| B8 | app → network | HTTPS to the LEZ RPC and faucet, no redirects followed, size caps; cleartext only to 127.0.0.1/localhost | `server.py:235-256`; `android/app/src/main/res/xml/network_security_config.xml:6-10` |
| B9 | other apps → this app | `NodeService` exported, guarded by `android.permission.DUMP`; `WalletActivity` exported as the launcher; no providers or receivers; **loopback TCP ports are not an Android permission boundary** | `android/app/src/main/AndroidManifest.xml:33-44, 69-77` |

## 4. Actors: what each can and cannot do today

### 4.1 Network observer (sees the phone's traffic)

- **Can** see the Waku traffic of the phone's messaging node: content topics, payload sizes and timing. A
  recipient's topic is computable from its public `msg` entry ([spec §7](messages-v1-spec.md#7-content-topic)),
  so traffic to a known name's inbox is recognisable. Payloads are not padded.
- **Can** see the blockchain node's p2p traffic and the hard-coded initial peer (`kt/NodeFiles.kt:136-141`).
- **Can** see that the phone talks to the LEZ RPC and faucet hosts (TLS hides content).
- **Cannot** read message contents or forge messages
  ([spec §4-6](messages-v1-spec.md#4-wire-payload)); cannot read the HTTPS calls.

### 4.2 Malicious relay or store node (Waku)

- **Can** drop, delay or reorder messages; nothing tells a sender a message was delivered beyond the
  node's own `sent` event (`server.py:3520-3543`).
- **Can** keep every payload forever. Because the recipient's key is static, a later theft of the
  messaging key decrypts all of them (no forward secrecy).
- **Can** replay a payload byte for byte; it is dropped only while its id is in the last 8000 ids
  (`server.py:3165, 3446-3451`; [spec §11.3](messages-v1-spec.md#113-replays)).
- **Can** (and so can anyone, since topics are public) **flood an inbox topic**. The server stores every
  payload of 1 to 16,384 bytes on its topic without being able to open it, and keeps the last 2000
  (`server.py:3165, 3314, 3438-3456`): 2000 junk payloads push every real message out of
  `wallet-inbox.json`. The node's buffer of 50 events between reads also overflows (counted as `missed`,
  `server.py:3432-3436`).
- **Can** learn which topics the phone's node subscribes to: its own inbox, and each recipient's for about
  180 s after a send (`server.py:3177, 3409-3418, 3551`).
- **Cannot** read contents or make a message that opens as authentic from someone else.

### 4.3 Malicious name endpoint (the LEZ sequencer RPC)

The page resolves names itself, but the only data source is the sequencer's `getAccount` answer, forwarded
by the server (`server.py:275-289`, `app/names/names.js:313-323, 353-368`). Nothing checks that answer
against chain state (no proof, no second source). The record's sealing key is derived from the name alone
(`app/names/names.js:132-139`), so anyone can make a well-formed record for any name.

- **Can** answer any `blockchain` entry for a name: **Send to a name pays whatever address the sequencer
  returns** (`app/names/lookup.js:23-32`, `app/index.html:1370`).
- **Can** answer any `msg` entry: a first contact pins the attacker's key (trust on first use defeated),
  and a "key changed" warning can be forced for an existing contact
  (`chat-core.js:149-161, 241-251, 419-435`).
- **Can** lie about balances, fees and nonces, which steers the one-tap job's waits and brakes
  (`server.py:723-731, 1103-1117, 1941-1947, 1913-1927`), and about whether the phone holds a name
  (`server.py:1877-1891`, through `names resolve`).
- **Can** drop or delay transactions (`sendTransaction` is forwarded as is, `server.py:2362-2367`).
- **Cannot** sign for the name account; the key never leaves the phone and is never read by `server.py`
  (`server.py:292-298`).

### 4.4 Another app on the same phone

Android keeps other apps out of this app's files, but any app with the `INTERNET` permission can open TCP
connections to `127.0.0.1`, and can send any headers it likes.

- **Can reach the blockchain node's API on `127.0.0.1:18180`** (`kt/NodeFiles.kt:88`). The wallet server
  calls it with no credential (`server.py:51-56`), including `POST /wallet/transactions/transfer-funds`
  (`server.py:2812-2814`) and `POST /channel/deposit` (`server.py:1537`). The node cannot tell those calls
  from the same calls made by another app. **If the node signs for the wallet server, it signs for any
  local app: the PIN does not protect the coins from other apps.** CI shows the node signing for a caller with
  no credential: the `wallet-send` job runs a real node (release 0.3.4 for Linux) and a transfer through
  `server.py` (`.github/workflows/install-test.yml`, job `wallet-send`; `tests/wallet_test.py:283-315`). Not
  determinable here: whether the Android build pinned in `android/node.properties` differs; the config the
  app writes sets no access control (`kt/NodeFiles.kt:82-97`). This is the most serious open item; see [open-questions.md](open-questions.md).
- **Can reach the messaging node's REST API on `127.0.0.1:18645`** (`kt/Messaging.kt:23-24`): publish on
  any topic, change subscriptions, read received events (sealed payloads and topics). Whether reading
  events takes them away from the wallet server is not determinable here.
- **Can reach the wallet server on `127.0.0.1:18190`**, forging `Host` and `Origin`:
  - **before a PIN is set**, call `POST /api/wallet/setup`, set the PIN and get a session
    (`server.py:4480-4489`): first come, first served;
  - guess the PIN through `POST /api/wallet/unlock`: 5 tries, then a 5-minute pause, about 1440 tries a
    day, a counter kept in memory only (`server.py:39-44, 2625-2652`); a 6-digit PIN falls in about a
    year on average;
  - lock the wallet at any time (`POST /api/wallet/lock` needs no session, `server.py:4557-4562`);
  - read status without a session (`GET /api/status`, `/api/wallet`, `/cryptarchia/info`,
    `/network/info`; `server.py:4401-4419`).
- **Cannot** read the session token (it lives in the WebView's storage) or the files; cannot call the
  forwarder without its secret path (`server.py:4454`); cannot start `NodeService` (DUMP,
  `AndroidManifest.xml:69-77`).
- **Can** launch `WalletActivity` (the launcher activity). In this debug build the extras `crashrenderer`
  and `probe` also work for any caller (`kt/WalletActivity.kt:295-304, 413-417`).

### 4.5 Someone holding the phone, unlocked, with the wallet unlocked

Everything a session allows, without typing the PIN again:

- send coins (`server.py:4655-4661`), bridge coins to the name account and send LEZ from it
  (`server.py:4683-4690`), start the one-tap name job (`server.py:4691-4692`);
- **read the messaging secret key and seed** (`GET /api/messages/key`, `server.py:3787-3792`), and all chats;
- set the first messaging key, change the linked name, turn messages on (`server.py:3703-3734`).

The PIN is asked again for: backup export, restore, replacing an existing messaging key, turning on
fingerprint unlock (`server.py:4496-4528, 3710-3717, 4597-4614`). In-app updates, which also need it
elsewhere, are refused inside the Android app (`server.py:4595-4596`).

### 4.6 Someone holding the phone, unlocked, with the wallet locked

- **Cannot** use the wallet API without the PIN or a fingerprint enrolled on the phone (fingerprint unlock:
  `kt/WalletActivity.kt:484-499` then `server.py:3098-3106`; the biometric check lives only in Kotlin).
- **Can** stop the node from its notification's Stop action (`kt/NodeService.kt:708-713`). The page's
  native bridge methods `openNode`, `setMobileMode` and `restartNode` check only that the call comes from
  the wallet's page, not that the wallet is unlocked (`kt/WalletActivity.kt:478-481, 536-555`); whether the
  locked page offers them was not checked.
- **With USB debugging on** (or by turning it on): see §6. That is everything.

### 4.7 Someone holding the phone, locked

- What the lock screen and Android's file-based encryption protect is outside this app.
- Meanwhile, the app keeps working on its own: the one-tap name job keeps signing (§5), a bridge keeps
  depositing (§5), messages keep arriving. The notification shows only status text
  (`kt/NodeService.kt:450-455, 714-725`).

### 4.8 A stolen backup file

- **Can** read, without any password: the wallet's public addresses and labels, the creation time, the
  format version (which shows whether a messaging key is inside), the KDF parameters
  (`server.py:4064-4070`; `docs/backup.md` says so).
- **Can** try passwords offline without limit. Cost per guess: scrypt N=2^16, r=8, p=1 (about 64 MiB).
  The minimum password is 8 characters (`server.py:2993, 4519`).
- With the password: **all** keys (node keystore, messaging seed and secret, the LEZ name account's wallet
  file) and the chats, including message history (`server.py:4038-4052`).
- The AEAD's associated data is the fixed string `logos-node-wallet-backup v1|v2`
  (`server.py:2991, 4052`); the outer header (addresses, KDF parameters) is not authenticated, but a
  changed header makes a restore refuse (`server.py:3910-3911`) or fail to decrypt.

### 4.9 A malicious sender

- **Can** send any number of messages to a known topic (flooding, §4.2).
- **Can** claim any name in `from`; such a message is shown as "Not verified" in its own thread and starts
  no chat (`chat-core.js:269, 314-332, 382-393`).
- **Can** pick any `ts`: shown as at most 5 minutes after arrival, no lower bound (`chat-core.js:352`).
- **Can** use non-canonical spellings of its own key (upper-case hex, bit 255 set) to appear as a different
  address ([spec §9 step 8](messages-v1-spec.md#9-opening-what-a-receiver-checks-in-order);
  vectors `fromKey-*-accepted`).
- Avatars do not come from messages: they come from a name's chain record (`avatar` entry), read through
  `lookup()` (`chat-core.js:149-161`), so the name's holder or the name endpoint (§4.3) chooses them. Only
  inline `data:` images of PNG, JPEG, GIF or WebP up to 64 KiB are used, and the CSP allows `data:` images
  only when messages are on (`chat-core.js:94-99`, `server.py:4304-4306`).
- **Cannot** make a message authentic under a key whose secret it lacks
  ([spec §6](messages-v1-spec.md#6-sender-authentication-auth)).
- Text is shown by the page; how it is inserted into the DOM was not audited here (see open questions).

## 5. The lock model

- A session is a random 32-byte token held by the server (`server.py:2705-2708`). It ends after the chosen
  idle time (1, 5 or 15 minutes; default 5) or 60 s after the page reports itself hidden
  (`server.py:36-38, 2711-2725`); a background thread checks (`server.py:2744-2750`). Only user actions
  count as activity (`server.py:4326-4337, 4555-4556`).
- Locking makes the page drop its chats and messaging key (`app/messages/messages.js:338-339`).
- **What runs and signs while locked:**
  1. **The one-tap name job** (`server.py:1696-2157`, documented in [name-account.md](name-account.md)): once
     tapped, it makes the name account, waits for LEZ, registers the name (a commit and a reveal) and sets
     two entries, signing with the name-account key, **for up to 48 hours from the tap**
     (`LNS_FLOW_MAX`, `server.py:1723, 2035-2036`), with no session. `android/NAMES.md:181` states this as a
     design decision: the tap is the consent. A job already running when the 48 hours end is not stopped.
  2. **A bridge** confirmed while unlocked keeps going: the split (a transfer from a wallet key to itself) is
     sent at the tap (`server.py:1387-1390`); the deposit of that note through the node's API
     (`POST /channel/deposit`) is made later by the background loop, with no session check, once the note is
     in the wallet, unless more than 10 minutes have passed since the note appeared (then it is cancelled)
     (`server.py:975, 1560-1612, 1486-1557, 1675-1694`).
  3. A `names` job already started (any kind) runs to its end or its timeout (`server.py:306, 770-842`).
  4. Messages are received and queued sends are posted (`server.py:3509-3612`).
- **What does not need the PIN at all**, locked or not: the blockchain node's own API and the messaging
  node's REST API, for any local program (§4.4).

## 6. Debug-build facts an auditor will raise

| fact | evidence | consequence |
|---|---|---|
| Only a debug APK is built and distributed | `.github/workflows/android-app.yml:88, 152` | `debuggable` (Android Gradle Plugin default for debug builds; not set in the repo) |
| Signed with the committed debug keystore, passwords `android`/`android` | `android/debug.keystore`; `android/app/build.gradle.kts:51-56` | anyone can sign an APK that installs as an update of this app and gets its data |
| `run-as` works (debuggable) | AGP default | over USB debugging, every file of the app can be read without the PIN: `keystore.yaml`, `wallet-msgkey.json`, `.lns-wallet/storage.json`, `wallet-pin.json` (a 6-digit PIN under scrypt N=2^14 is brute-forced offline in minutes to hours) |
| WebView debugging for debuggable apps | platform behaviour, **not verified here**; the repo never calls `setWebContentsDebuggingEnabled` | if on, over USB, `chrome://inspect` can run code in the page, including an unlocked page's session |
| `NodeService` accepts actions from adb (DUMP) | `AndroidManifest.xml:66-77`; `kt/NodeService.kt:487-560` | over adb: start, stop, `IMPORT` a node state from any content URI with no integrity check (`kt/NodeService.kt:608-633`), `REVERT`, mobile mode; debug-only extras `fullreplay`, messaging switches, `break` (`kt/NodeService.kt:506-514, 545-547`) |
| An unknown or missing action starts the node | `kt/NodeService.kt:544-559` | minor |
| `allowBackup="false"`, no `dataExtractionRules` | `AndroidManifest.xml:24` | on Android 12+, device-to-device transfer rules are not set explicitly; behaviour not determinable from the repo |
| No `FLAG_SECURE` | not set anywhere | screenshots and the app switcher can show balances, addresses and chats |

## 7. What this model does not cover

The blockchain node, the messaging node and `names` are bundled binaries pinned by hash
(`android/node.properties`, `android/messaging.sha256`, `android/names.properties`) and built from other
repositories; their own behaviour (key generation, network handling, API access control) is out of scope
here except where noted. So is the Logos Blockchain and LEZ protocol itself.

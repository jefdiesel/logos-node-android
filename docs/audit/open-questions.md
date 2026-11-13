# Open questions and suspected weaknesses

Written while documenting commit `d00ee0f`. Nothing here has been fixed. Each item gives the place in the
code and why it is listed. "Not determinable" means the answer is outside this repository (usually inside a
bundled binary). Ordered roughly by how much it could cost a user.

## A. Could lose funds or keys

**A1. Any app on the phone can reach the blockchain node's API, which the wallet uses without a credential.**
The node API listens on `127.0.0.1:18180` (`android/app/src/main/java/io/github/jefdiesel/logosnode/NodeFiles.kt:88, 130`).
`server.py` calls it with no authentication (`app/server.py:51-56`), including
`POST /wallet/transactions/transfer-funds` (`app/server.py:2812-2814`) and `POST /channel/deposit`
(`app/server.py:1537`). Loopback TCP is open to every app with the `INTERNET` permission, so whatever the
node does for the wallet server it does for any app. *Not determinable here:* whether the node's API has
access control of its own (the config the app writes sets none, `NodeFiles.kt:82-97`). If it has none, the
PIN does not protect the coins from other installed apps. This is the first thing to settle.

**A2. The same for the messaging node's REST API** (`127.0.0.1:18645`, `android/app/src/main/java/io/github/jefdiesel/logosnode/Messaging.kt:23-24`;
called without a credential, `app/server.py:3331-3348`). Another app can publish, subscribe and unsubscribe,
and read received events. *Not determinable:* whether reading `/messaging/v1/events/received` removes events,
so that another app could take messages before the wallet server sees them.

**A3. Names resolve from the sequencer's word alone.** The page's only source for a name's record is the
`getAccount` answer forwarded to `NAMES_RPC_URL` (`app/server.py:275-289`; `app/names/names.js:313-323, 353-368`),
with no proof or second source, and the record's key comes from the name alone (`app/names/names.js:132-139`).
So the endpoint chooses where **Send to a name** pays (`app/names/lookup.js:23-32`; `app/index.html:1370`)
and which `msg` key a first contact pins (`app/messages/chat-core.js:149-161, 241-251`). HTTPS protects the
path, not the answer.

**A4. Every key is a plain file, and the shipped build is debuggable and signed with a public key.**
Node keystore (`NodeFiles.kt:18`), messaging key (`app/server.py:3163, 3271-3275`), LEZ name-account key
(`app/server.py:301, 445-462`). The PIN guards the HTTP API, not the files (`android/NAMES.md` says so). The
only APK built is a debug build (`.github/workflows/android-app.yml:88, 152`), signed with the committed
debug keystore whose passwords are `android` (`android/app/build.gradle.kts:48-59`; `android/debug.keystore`).
Consequences: `run-as` over USB debugging reads all keys without the PIN; anyone can build an APK that
installs as an update of this app and reads its data; WebView remote debugging is on. `wallet-pin.json` is
scrypt N=2^14 of a 6 to 12 digit PIN (`app/server.py:2655-2667`): a read copy is brute-forced offline quickly.

**A5. The messaging secret can be exported with a session alone.** `GET /api/messages/key` returns the
X25519 secret and the Ed25519 seed to any unlocked page (`app/server.py:3787-3792`; used at
`app/messages/messages.js:374-377`). The backup route's comment says "a fingerprint session alone can't
export the keys" (`app/server.py:4515`), and backup, restore and replacing the key all ask for the PIN again.
Code and comment disagree in spirit: the page needs the secret to open messages, so this may be inherent to
the design (the page does the cryptography), but it should be stated.

**A6. The first local client to call `/api/wallet/setup` sets the PIN.** Before a PIN exists, any local
program that sends the right `Host` and `Origin` headers can set it and receives a session
(`app/server.py:4480-4489`).

**A7. The one-tap job signs while the wallet is locked, for up to 48 hours** (`app/server.py:1723, 2035-2036`;
`android/NAMES.md:181` makes this a design decision). The brakes that bound it have gaps:
- the spend ceiling is set only if balance, fees and deposit are all known at the first paid send; otherwise
  that send starts with no spend check at all (`app/server.py:1921, 1963-1978`), although the docstring says
  the brake waits (`app/server.py:1961-1962`);
- the ceiling compares balances, so LEZ arriving during the job (faucet, bridge) hides spending
  (`app/server.py:1925`);
- waits for a brake's "wait" (5 s) and for an unreadable nonce (15 s) are not counted, and at the register
  step each round first runs `names resolve` (`app/server.py:1985-1988, 1993-1996, 2088`): an endless,
  bounded-only-by-48-h loop of signer runs is possible while the chain misbehaves;
- `last_send_at` and `started` use the wall clock; a clock set back makes the 60 s gap and the 48 h limit
  wait longer, a clock set forward ends them early; only `next_at` is guarded (`app/server.py:1919, 2029-2030, 2035`).

**A8. A LEZ Send is not refused while the one-tap job is at its register step.** `lns_send` checks only for a
running job (`app/server.py:1410-1471`, via `lns_start` 849-854), not `lns_flow_busy()`; a failed register
clears `reg_pending` (`app/server.py:837-841`), so the floor that keeps the registration's LEZ is gone. A send
then moves the account's nonce and the flow stops with "an earlier commit may have landed"
(`app/server.py:2100-2109`), a false alarm.

## B. Could lose messages or mislead the user

**B1. An inbox can be flushed by anyone.** The topic of a name's inbox is public
([messages-v1-spec.md §7](messages-v1-spec.md#7-content-topic)). The server stores every payload of 1 to
16,384 bytes on it without being able to open it, and keeps only the last 2000 (`app/server.py:3165, 3314,
3438-3456`). 2000 junk payloads remove every real message from `wallet-inbox.json`.

**B2. No replay protection beyond an 8000-id memory** (`app/server.py:3165, 3315, 3446-3451`). A replayed
payload is accepted again once its ids have left that memory (deleting a message keeps its ids;
`app/server.py:3759-3767`). It then shows as a new message with its old `ts` unless the
original is still loaded (`app/messages/chat-core.js:366-370`), and the Android unread count includes it
(`app/server.py:3322-3328`). No freshness check exists: `ts` is only capped above for display
(`app/messages/chat-core.js:352`).

**B3. Non-canonical sender keys are accepted.** `parseMsgKey` trims and lower-cases (`app/messages/msg-crypto.js:100-103`),
and nothing rejects a key with bit 255 set, which is the same X25519 key under a different hex string
(test vectors `fromKey-uppercase-accepted`, `fromKey-whitespace-accepted`, `fromKey-high-bit-accepted`).
For an address-only sender the id is `k:<that hex>` (`app/messages/chat-core.js:349`), so one sender can
appear as several addresses, and a reply is sealed to the right key but published on the topic of the
non-canonical hex (`app/messages/chat-core.js:444-447`), where the sender does not listen: the reply is lost.

**B4. Small inconsistencies in the v1 format** (all in `app/messages/msg-crypto.js`):
- `auth` must be lower-case hex (line 161) while `fromKey` may be upper case (line 101);
- `openMessage` accepts an empty `text` (line 155) that `sealMessage` refuses (line 123);
- `sealMessage` does not check `ts`; a non-integer `ts` makes a message no receiver opens (lines 120, 155);
- `v` and unknown JSON fields are outside `auth` (lines 112, 130); a duplicate JSON key counts with its last
  value (test vector `duplicate-key-last-wins`);
- `openMessage` has no upper size bound of its own; it relies on the server's 16,384-byte cap
  (`app/server.py:3444`).
None is known to be exploitable; they matter to a second implementation.

**B5. A backup can leave out the name account without saying so.** `lns_backup` returns `None` on any
exception or failed validity check (`app/server.py:2221-2226`); `backup_export` then answers 200 with
`lns: null` (`app/server.py:4046-4051, 4064`), the same as for a phone with no name account. Since the
account has no recovery phrase (`app/server.py:705-707`), a user who relies on that backup loses the name.

**B6. Restore swaps the node's keys whatever happens to the name account.** If the name-account part comes
back `busy`, `kept` or `unchecked`, `restore_backup` still replaces the keystore (`app/server.py:3918-3962`).
The reply says so and the page warns; listed because the two halves are not atomic.

**B7. "I already hold it" by route records a name without reading the chain.** `POST /api/wallet/lns/name`
(`lns_link`, `app/server.py:910-928`) saves any valid name as the phone's. Later entry changes for a name the
account doesn't hold fail on chain and may be billed.

## C. Robustness

**C1. Try again cannot recover three stops.** Retry resets tries, counts and the ceiling
(`app/server.py:1816`) but not `started` (48 h limit, 2035), `fund_since` (24 h, 2068-2070) or the saved job
nonce (2100-2109). After those stops only Stop and a new tap move on.

**C2. Job timeouts are shorter than the signer's own wait.** The signer waits up to 60 rounds 30 s apart for
a block (`app/server.py:650-652`), 30 minutes; the app kills a `set-text` after 20 minutes and a send after
10 (`app/server.py:306`). On a slow chain a text change is killed and retried, and a LEZ send ends as "may
have been sent".

**C3. Smaller flow items.** An "already" answer resets `last_send_at` to 0 (`app/server.py:2005`);
`read_waits` is reset only at the entry steps, not after a good read at register (`app/server.py:2088-2093,
2128`); the 10-minute refusal of a repeated identical LEZ send is in memory and lost on restart
(`app/server.py:309, 1444-1446`); `lns_commit_saved` checks only that a commitment for the name exists, not
whose or how old (`app/server.py:1930-1938`).

**C4. The HTTP server sets no socket timeout** (`app/server.py:4290`, `4737`). A local client that opens
connections and sends nothing holds threads.

**C5. Durability.** No folder fsync after renames (`app/server.py:455-462, 3472-3476`). The keystore copy
kept by a restore is named by the second (`app/server.py:3938-3941`, `O_EXCL`): two restores in one second
raise, uncaught. `*.replaced-*` copies of old keys are never removed, so "replaced" keys stay on the phone
(`app/server.py:2243-2253, 3937-3941`).

**C6. A backup's KDF parameters are taken from the file** within bounds as low as N=2 (`app/server.py:3858`).
This only weakens a file someone else made; noted for completeness.

## D. Android app

**D1. `NodeService`** is exported to DUMP holders (adb) (`android/app/src/main/AndroidManifest.xml:66-77`). Over
adb: `IMPORT` replaces the node's state from any content URI with no integrity check
(`android/app/src/main/java/io/github/jefdiesel/logosnode/NodeService.kt:608-633`); debug-only extras exist
(`NodeService.kt:506-514, 545-547`); an unknown or missing action starts the node (`NodeService.kt:544-559`).

**D2. The JavaScript bridge** checks the page's address but never the wallet's lock (`android/app/src/main/java/io/github/jefdiesel/logosnode/WalletActivity.kt:476-574`);
`mobileMode()` checks nothing, although the class comment says every call checks (`WalletActivity.kt:472-475`
vs `530-533`).

**D3.** `allowBackup="false"` but no `dataExtractionRules` (`AndroidManifest.xml:24`); no `FLAG_SECURE`
anywhere; in the debug build, any app can start `WalletActivity` with the extras `crashrenderer` and `probe`
(`WalletActivity.kt:295-304, 413-417`).

**D4.** The node-state import from a file (`Snapshot.kt`) checks the archive's structure only, no hash or
signature (`android/app/src/main/java/io/github/jefdiesel/logosnode/Snapshot.kt:111-158, 281-291`); the screen
tells the user they trust the file's maker (`NodeActivity.kt:272`).

**D5.** The passkey routes are not limited to non-Android builds (`app/server.py:4529-4554`); harmless as far
as could be seen (an unlock needs a signature from a registered passkey, `app/server.py:4265-4287`).

## E. Not determinable from this repository

- The blockchain node's API access control (A1); the messaging node's event semantics (A2).
- Whether `names` saves a registration's commitment secret before or after sending the commit (the app's
  nonce check, `app/server.py:2100-2109`, exists because of this).
- The mode of `keystore.yaml` as the node creates it (`NodeService.kt:849`), and whether the node's
  `output.log` (`NodeService.kt:920-922`) can contain secrets.
- The messaging node's network bind addresses and bootstrap peers (`Messaging.kt:98-112`).
- WebView defaults for settings the app does not set (mixed content, file URL access).
- How message text reaches the DOM was not traced line by line. A search found `innerHTML` in
  `app/messages/messages.js` only with fixed templates (lines 18, 187, 222, 277-278). The page's CSP allows
  inline scripts (`app/server.py:4305-4306`), so any HTML injection would run.

## F. Documents that disagree with the code

- `app/messages/VENDORED.txt:18` says to run `tests/msg_test.mjs`; that file does not exist. The interop test
  is `tests/messaging_test.mjs`, and the format vectors are now `tests/messages_v1_vectors.mjs`.
- `app/messages/msg-crypto.js:2` and `VENDORED.txt:3` name the names project's `gateway/app-src/msg-crypto.js`;
  `tests/msg_vectors.json` and CI pin `gateway/public/app/msg-crypto.js` (the bundled build) by hash.
- `app/server.py:1702` says the `msg` entry is set "later by itself"; the code needs a tap
  ([name-account.md §10](name-account.md#10-where-the-code-and-androidnamesmd-or-the-codes-comments-differ)).
- `app/server.py:1961-1962` (spend brake waits) vs 1966-1974 (it doesn't) — see A7.
- `app/server.py:4515` vs 3787-3792 — see A5.
- `WalletActivity.kt:472-475` vs 530-533 — see D2.

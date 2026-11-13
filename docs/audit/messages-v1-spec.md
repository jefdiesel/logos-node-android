# Names Messages version 1: the one-to-one message format, as implemented

This is the format exactly as the code at commit `d00ee0f` implements it. It was written from the code,
not from earlier documents. Where they disagree, the code is described here and the disagreement is
listed in [open-questions.md](open-questions.md).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. A rule marked **(as implemented)**
describes what this code does, including behaviour that may not be intended; a second implementation that
wants to interoperate with this one has to match it, or knowingly differ.

Test vectors: [`tests/vectors/messages-v1.json`](../../tests/vectors/messages-v1.json), checked by
`node tests/messages_v1_vectors.mjs` (see [§13](#13-test-vectors)).

## 1. Where the code is

| Part | File | Lines |
|---|---|---|
| Seal, open, topic, key parsing | `app/messages/msg-crypto.js` (vendored from the names project, commit 27029987) | 40-179 |
| The device's messaging identity (seed → keys) | `app/messages/identity.js` | 11-24 |
| Chat model: senders, trust, pinning, at-rest blobs | `app/messages/chat-core.js` | 26-479 |
| Page: key creation, loading the key, forgetting on lock | `app/messages/messages.js` | 337-384, 700-706 |
| Server: key storage, inbox, outbox, store, dedup | `app/server.py` | 3163-3820 |
| Server: backup and restore of key and chats | `app/server.py` | 3847-4070 |

Primitives come from vendored `@noble/curves`, `@noble/ciphers` and `@noble/hashes` 2.4.0
(`app/messages/VENDORED.txt:6-14`).

## 2. Primitives and notation

- `X25519(k, u)`: RFC 7748. Implementations MUST reject an all-zero shared secret (`msg-crypto.js:83-87`).
- `HKDF(ikm, salt, info)`: HKDF-SHA256 (RFC 5869), output 32 bytes. An empty salt is the empty byte string
  (which HKDF treats as 32 zero bytes).
- `HMAC(key, data)`: HMAC-SHA256, 32 bytes.
- `XChaCha20-Poly1305(key, nonce24, aad)`: the extended-nonce ChaCha20-Poly1305 of
  draft-irtf-cfrg-xchacha (HChaCha20 subkey, then the RFC 8439 AEAD with nonce `0x00000000 ‖ nonce24[16..24]`).
  The tag is 16 bytes and is appended to the ciphertext.
- `‖` is concatenation. `utf8(s)` is the UTF-8 encoding of a string. `hex(b)` is lower-case hex.
- Lengths of `text` are counted in **UTF-16 code units** (JavaScript `String.length`), not bytes and not
  characters.

## 3. Keys

### 3.1 The device's messaging key

Each device has one X25519 key pair, its *messaging key*. Its public key, as 64 lower-case hex characters,
is what an LNS name publishes in its `msg` text entry (`msg-crypto.js:16-17`, `MSG_TEXT_KEY` line 41).
It is also called the device's *messaging address*, shared as `msg:` followed by the 64 hex characters
(`chat-core.js:44-45`).

Since app 0.9.0 the key is made from a 32-byte Ed25519 seed (`identity.js:1-5, 11-19`):

```
h          = SHA-512(seed)[0..32]
secret     = h with h[0] &= 248, h[31] &= 127, h[31] |= 64        (the X25519 secret, clamped)
edPublic   = Ed25519 public key of seed
public     = the Montgomery u-coordinate of edPublic  (u = (1 + y) / (1 - y) mod 2^255 - 19)
```

`identityFromSeed` checks that `X25519(secret, 9) == public` (`identity.js:17`); the server checks the same
relation, and that `secret` is the one the seed gives, before it stores a key (`server.py:3217-3232`).
Keys made by app 0.8.x are X25519 only, with no seed (`server.py:3213-3215`); they work for this format
unchanged.

The seed is made in the page with `crypto.getRandomValues` (`identity.js:22-24`, `messages.js:700-702`) and
sent to the server, which stores it (§11).

### 3.2 The recipient's key

A sender MUST use the 32 raw bytes of the recipient's messaging key. For a name, that is the name's `msg`
entry as read from the LEZ name registry; `parseMsgKey` accepts the entry after trimming whitespace and
lower-casing, if it is then exactly 64 hex characters (`msg-crypto.js:100-103`). For an address-only
contact it is the address itself (`chat-core.js:444`).

## 4. Wire payload

One Waku message payload (`msg-crypto.js:19-23, 120-133`):

```
offset  length  field
0       1       version               0x01
1       32      ephemeral public key  E = X25519(e, 9), e a fresh random 32-byte secret
33      24      nonce                 24 fresh random bytes
57      n+16    ciphertext ‖ tag      XChaCha20-Poly1305 of the plaintext (n bytes)
```

- `header` = the first 57 bytes: `0x01 ‖ E ‖ nonce`.
- The smallest payload a receiver can accept is 73 bytes (header + tag, `msg-crypto.js:49-50, 145`).
- A sender MUST use a fresh ephemeral secret and a fresh nonce for every payload. This code takes both from
  `globalThis.crypto.getRandomValues`, the ephemeral secret first (32 bytes, through
  `x25519.utils.randomSecretKey`), then the nonce (24 bytes) (`msg-crypto.js:125-126`).
- A message to several recipients is sealed once per recipient, each with its own ephemeral key and nonce
  (`chat-core.js:443-448`).

### 4.1 Key derivation

```
message_key = HKDF(ikm  = X25519(e, R),
                   salt = E ‖ R,                       (64 bytes)
                   info = utf8("names/msg/v1"))
```

where `R` is the recipient's public key (`msg-crypto.js:47, 128`). The receiver computes the same with its
secret `r` and `E`: `X25519(r, E)`, salt `E ‖ public(r)` (`msg-crypto.js:149-150`).

### 4.2 AEAD

```
aad        = 0x01 ‖ E                                  (33 bytes; the nonce is not in the AAD)
ciphertext = XChaCha20-Poly1305(message_key, nonce, aad).encrypt(plaintext)
```

(`msg-crypto.js:131, 151`.)

## 5. Plaintext

The plaintext is the UTF-8 encoding of one JSON object (`msg-crypto.js:130`):

| field | type | meaning |
|---|---|---|
| `v` | number | MUST be `1` |
| `from` | string | the sender's LNS name, or the address-only form `msg-<16 hex>` (§8); MUST match `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` (`msg-crypto.js:51`) |
| `fromKey` | string | the sender's messaging public key, 64 hex characters |
| `text` | string | the message, 1 to 2000 UTF-16 code units when sealed (§10) |
| `ts` | number | the sender's time, milliseconds since 1970-01-01 UTC; a safe integer (`Number.isSafeInteger`) |
| `auth` | string | the sender-authentication tag (§6), 64 lower-case hex characters |

**Canonical form.** A sender SHOULD produce exactly the output of ECMAScript `JSON.stringify` on an object
with the keys inserted in the order `v, from, fromKey, text, ts, auth`, no whitespace, `fromKey` and `auth`
in lower-case hex. That is what this code produces and what the test vectors contain. For example:

```
{"v":1,"from":"alice","fromKey":"a056be34…417b","text":"hello bob","ts":1794489600000,"auth":"d3803974…47eb"}
```

`JSON.stringify` escapes `"` and `\`, writes U+0000 to U+001F as `\b \f \n \r \t` or `\u00xx`
(lower-case hex), escapes lone surrogates as `\udxxx`, and writes every other character as itself in UTF-8.

**Receivers do not require the canonical form (as implemented).** The receiver parses the plaintext with
`JSON.parse` (`msg-crypto.js:152`), so: key order and whitespace are free; a key given twice counts with its
last value; unknown keys are ignored; `fromKey` is trimmed and lower-cased before use (§9 step 8). Only the
fields' values enter the authentication tag, so these variations do not break `auth`. See
[open-questions.md](open-questions.md) for why this matters.

## 6. Sender authentication (`auth`)

The AEAD proves nothing about the sender: anyone can seal to a public key. `auth` proves that the sender
holds the secret key of `fromKey`, to the recipient only (`msg-crypto.js:24-31, 110-114`):

```
auth_key   = HKDF(ikm  = X25519(sender_secret, R),
                  salt = (empty),
                  info = utf8("names/msg/v1/auth"))

auth_input = header                 57 bytes: 0x01 ‖ E ‖ nonce
           ‖ utf8(from)
           ‖ 0x00
           ‖ fromKey                32 raw bytes (not the hex text)
           ‖ utf8(decimal(ts))
           ‖ 0x00
           ‖ utf8(text)

auth       = hex(HMAC(auth_key, auth_input))
```

- `decimal(ts)` is JavaScript `String(ts)`: for a safe integer, its shortest decimal form, with a leading `-`
  for a negative value and no `+`, no leading zeros, no exponent.
- The encoding is unambiguous: `from` cannot contain 0x00 (its pattern), `fromKey` has a fixed length,
  `decimal(ts)` cannot contain 0x00, and `text` is last.
- The recipient computes the same key as `X25519(r, fromKey)`. The recipient's own key is not written in
  `auth_input`; it is bound through the static Diffie-Hellman.
- Because the recipient can compute `auth_key` too, `auth` convinces the recipient and no one else; the
  recipient can forge messages "from" the sender to itself. This is deliberate (`msg-crypto.js:30-31`).
- `v` is not in `auth_input`, and neither is any other JSON field.

## 7. Content topic

The inbox of a public key `K` is the Waku content topic (`msg-crypto.js:32, 105-108`; the server's copy
`server.py:3291-3292`):

```
/names/1/msg-<the first 16 hex characters of SHA-256(K)>/proto
```

A sender MUST publish the payload on the recipient's inbox topic. The topic is a function of the public key
alone: anyone who can read the `msg` entry of a name can compute the topic of its inbox. The server accepts
only topics matching `^/names/1/msg-[0-9a-f]{16}/proto$` from the page (`server.py:3179, 3642, 3737`).

Waku settings used with this format (`msg-crypto.js:43-45`): cluster 3, 8 shards; the Android app's
messaging node is configured separately (`android/app/src/main/java/io/github/jefdiesel/logosnode/Messaging.kt:18-39`).

## 8. A sender with no LNS name

The plaintext needs a name-shaped `from`. A sender with no name, or whose name's `msg` entry is not this
device's key, MUST put `"msg-"` followed by the first 16 hex characters of its own public key in `from`
(`chat-core.js:21-24, 41, 121-124`).

A receiver that sees a `from` matching exactly `^msg-[0-9a-f]{16}$` (`chat-core.js:348`):

- MUST treat the sender as the address `fromKey` (id `k:<fromKey>`), not as a name (`chat-core.js:349`);
- MUST treat the message as not authentic unless `from == "msg-" + fromKey[0..16]`
  (`chat-core.js:351`).

So an LNS name that has this exact shape is always taken as an address.

A sender is said to have its name *linked* when the name's `msg` entry, read from the chain, equals this
device's public key; only then does it send under the name (`chat-core.js:121-124`).

## 9. Opening: what a receiver checks, in order

`openMessage(secret, payload)` (`msg-crypto.js:143-169`) returns `null` (drop the payload) or
`{ id, from, fromKey, text, ts, authentic }`. Any exception at any step means `null`.

1. The payload is a byte string of at least 73 bytes whose first byte is `0x01`. Otherwise drop. This check
   comes before any decryption (line 145).
2. Split: `header = payload[0..57]`, `E = payload[1..33]`, `nonce = payload[33..57]` (lines 146-148).
3. `message_key` as in §4.1. An all-zero `X25519(r, E)` raises, so the payload is dropped (lines 83-87, 150).
4. Decrypt `payload[57..]` with `aad = 0x01 ‖ E`. A bad tag drops the payload (line 151).
5. Decode the plaintext as UTF-8, failing on invalid UTF-8; parse it as JSON (line 152).
6. `v` MUST be the number 1, and `from` a string matching the name pattern of §5 (line 154).
7. `text` MUST be a string of at most 2000 UTF-16 code units; `ts` MUST be a safe integer (line 155).
   **(as implemented)** An empty `text` is accepted, and so is any safe integer `ts`, including negative ones
   and ones far from now.
8. `fromKey` MUST be a string that, after trimming whitespace and lower-casing, is exactly 64 hex characters
   (lines 100-103, 156-157). **(as implemented)** Upper-case and padded forms are accepted. The key is not
   checked to be on the curve or canonical: a key with bit 255 set is a different 64-hex string for the same
   X25519 key (RFC 7748 ignores that bit).
9. Compute `auth` as in §6 from the received `header`, `from`, the parsed `fromKey` bytes, `ts` and `text`.
   `authentic` is true only if the received `auth` is a string of exactly 64 **lower-case** hex characters
   equal to the computed tag (compared in constant time, lines 75-80). A wrong, missing or upper-case `auth`,
   or an error computing it, gives `authentic = false`; **the message is still returned** (lines 158-164).
10. Return `id = hex(E)`, `fromKey` in lower-case hex, and the fields (line 165).

Then, in the chat model (`chat-core.js:338-353`):

11. A payload whose `id` is one of the ephemeral keys of this device's own sent messages is dropped (it is a
    copy of something sent from here) (line 344).
12. The address-only rule of §8 (lines 348-351).
13. The shown time is `min(ts, received + 300000)`: a time more than five minutes after arrival is shown as
    arrival + 5 min (line 352). There is no lower bound.

Whether a message really comes from the name in `from` is decided by §12 (trust), not by `openMessage`.
`isVerified(message, onChainKey)` (`msg-crypto.js:176-179`) gives the names project's rule (authentic, and
the chain's `msg` entry is `fromKey`); the chat model uses its own, stricter `trust()` (§12) and does not call
`isVerified`.

## 10. Limits

| limit | value | where | effect |
|---|---|---|---|
| text, sealing | 1 to 2000 UTF-16 code units | `msg-crypto.js:42, 123`; `chat-core.js:438` (also refuses all-whitespace) | `sealMessage` throws |
| text, opening | at most 2000 UTF-16 code units, empty allowed | `msg-crypto.js:155` | dropped |
| largest payload a conforming sender makes | 12,275 bytes (2000 × U+0001, each escaped to 6 bytes) | test vector `max-text-max-expansion` | |
| payload, accepted from the network | 1 to 16,384 bytes | `server.py:3165, 3444` | silently not stored |
| payload, accepted from the page to send | 1 to 16,384 bytes | `server.py:3644, 3743` | HTTP 413 |
| recipients per message | 1 to 16 | `server.py:3169, 3637` | HTTP 400 |
| sent copy (encrypted) | 24,576 bytes | `server.py:3169, 3635` | HTTP 400 |
| profiles store (encrypted) | 262,144 bytes | `server.py:3171, 3695` | HTTP 413 |
| inbox kept | last 2000 items | `server.py:3165, 3314` | older items dropped |
| dedup memory | last 8000 ids | `server.py:3165, 3315` | §11.2 |
| outbox kept | last 2000 items | `server.py:3169, 3492` | |
| message history in a backup | 1 MiB of JSON, newest first | `server.py:3174, 3965-3984` | `truncated: true` |

## 11. Receiving, duplicates and replays

### 11.1 Collection (server)

The server subscribes the messaging node to this device's inbox topic and reads received events every 3 s
(`server.py:3175, 3367-3458`). For each event (lines 3427-3456) it keeps the payload only if:

- the event's `contentTopic` equals this device's inbox topic;
- the payload is strict base64 of 1 to 16,384 bytes;
- none of its ids is in the dedup memory.

It never decrypts anything. The stored item is
`{n, payload (base64, as received), source ("live" | "history" | null), received (server UTC time), read: false}`.

### 11.2 Duplicates

- **Server.** The ids of a payload are `p:<SHA-256 of the payload bytes>` and, when the node gives one,
  `h:<the Waku message hash>` (lines 3446-3448). A payload with any known id is skipped. The memory keeps the
  last 8000 ids (lines 3165, 3315); each message adds one or two, so it covers at least the last 4000 stored
  messages. Ids stay after the message itself is deleted (`inbox/delete` removes items only, lines 3759-3767).
- **Page.** A conversation shows one message per ephemeral key (`id`) among the inbox items loaded
  (`chat-core.js:366-370`).

### 11.3 Replays

**There is no replay protection beyond the duplicate checks above (as implemented).**

- There is no sequence number, counter or freshness window. `ts` is chosen by the sender and only capped
  for display (§9 step 13).
- A recorded payload replayed byte for byte is dropped while its id is in the server's 8000-id memory. After
  that it is stored again as a new incoming message. The page then hides it only if the original is still
  among the loaded inbox items; if the original was deleted or has left the 2000-item inbox, the replay shows
  as a new message with its original `ts`.
- The server's unread count for the Android notification (`server.py:3322-3328`) counts a replayed payload
  that the page would hide.
- Only exact replays are possible from a third party: `auth` covers the header (ephemeral key and nonce),
  so a changed payload either fails the AEAD or fails `auth`, unless it is made by the recipient itself (§6).

## 12. Trust, pinning and key changes (chat model)

People are identified by a *pid*: an LNS name (`alice`), or `k:<64 hex>` for an address with no name
(`chat-core.js:14-17, 37-40`). Each pid has a profile in the encrypted store with a list of pinned keys
`keys: [{key, at}]`; the last one is the current pin (`chat-core.js:165-169, 178-181`).

**Reading the chain.** `lookup(name)` resolves the name through the page's resolver
(`app/names/names.js`, forwarded by the server as one `getAccount` call, `server.py:275-289`) and reads its
`msg` entry with `parseMsgKey`. Results are cached for 60 s; a failed read is retried after 30 s
(`chat-core.js:149-161, 310-313`).

**Pinning (trust on first use).**

- Starting a chat with a name pins the name's current on-chain key if nothing is pinned
  (`chat-core.js:241-251, 202-206`).
- Starting a chat with an address pins that address (`chat-core.js:253-262`).
- Sending pins each named recipient's key if it has no pin yet (`chat-core.js:449-450`).
- When someone writes first: a named sender's chat is made and its key pinned only if the message is
  authentic **and** the chain's `msg` entry for that name equals `fromKey`; otherwise the chat is made with
  nothing pinned. An address-only sender gets a chat (and a pin) only if the message is authentic
  (`chat-core.js:314-332`).

**Trust levels** of an incoming message (`chat-core.js:382-393`), in order:

| level | when |
|---|---|
| `unverified` | not authentic |
| `address` / `unverified` | sender is `k:<key>`: `address` if the key is `fromKey`, else `unverified` |
| `ok` | `fromKey` is the current pin |
| `old` | `fromKey` is an earlier pin |
| `new-key` / `ok` | `fromKey` equals the name's key on chain: `new-key` if something else is pinned, `ok` if nothing is pinned |
| `unverified` | anything else (including: nothing pinned and the chain not read) |

An `unverified` message is shown in a thread of its own keyed by the key it came from (`x:<fromKey>`), never
in the claimed person's chat, and cannot be replied to (`chat-core.js:234-239, 269, 422`).

**Key change.** When a name's on-chain key differs from its pin, sending to it is refused
(`code: "changed"`, `chat-core.js:431-432`) until the user accepts the new key, which appends it to the pins
(`acceptKey`, lines 192-200). A message sealed with a not-yet-accepted on-chain key is shown as `new-key`.

**Merging.** An address chat `k:<key>` can be merged into a name's chat once the chain says `key` is that
name's `msg` entry (`chat-core.js:214-228`); later messages from that address are threaded under the name
through `aliases` (line 230).

**Blocking and muting** are local profile flags; a blocked person's messages are hidden and marked read
(`chat-core.js:270-271, 333-335, 365`). Nothing is sent to the blocked person.

## 13. Test vectors

`tests/vectors/messages-v1.json` holds, with **test-only** keys, ephemerals and nonces (each is SHA-256 of a
fixed label; the file says so in its `WARNING` field):

- `keys`, `identities`: static key pairs and their topics; Ed25519 seeds and the X25519 pairs made from them.
- `seal`: five messages with every intermediate value (ephemeral public key, header, both shared secrets,
  `message_key`, `aad`, `auth_key`, `auth_input`, `auth`, plaintext, payload, topic) and what opening gives.
- `seal_refuses`: inputs `sealMessage` refuses.
- `open`: 36 payloads with what `openMessage` returns: dropped (`null`), opened but not authentic, or
  accepted. They include a bad tag, a wrong recipient, truncation, a wrong version byte, an auth mismatch, a
  key claimed by another sender, non-canonical `fromKey` text, an over-long text, and the edge cases this
  document marks **(as implemented)**.
- `chat`: what the chat model makes of an address-only sender (correct and mismatched), a named sender and a
  future `ts`.
- `store`: the at-rest key and two blobs (§14).
- `hchacha20`: the draft's HChaCha20 test vector, for the reference implementation.

`tests/messages_v1_vectors.mjs` makes every vector with its own implementation written from this document on
`node:crypto` (X25519, HKDF, HMAC, ChaCha20-Poly1305) and a written-out HChaCha20, and fails if the file
differs. It then runs the app's unchanged modules against the file: `sealMessage` and `encryptBlob` with
their randomness fixed to the vector's values (the test replaces `globalThis.crypto.getRandomValues` for one
call; 16-byte requests, which noble-curves makes to blind its scalar multiplications and which change no
result, get real randomness) must give the payload byte for byte, and `openMessage`, `openIncoming`,
`decryptBlob` and `identityFromSeed` must give the recorded results. CI runs it in the `app-update` job of
`.github/workflows/install-test.yml`.

The older `tests/msg_vectors.json` holds two payloads sealed by the names project's own build, checked by
`tests/messaging_test.mjs`; it is interop evidence, not a specification.

## 14. What is stored where, and how

All in the app's data folder (`APP_DATA`; on Android `files/wallet`,
`android/app/src/main/java/io/github/jefdiesel/logosnode/LogosApp.kt:40`). Every file is written mode 0600
through a temporary file and a rename (`server.py:3271-3275, 3312-3319, 3472-3476`).

| file | content | protection |
|---|---|---|
| `wallet-msgkey.json` | `{version: 2, seed, secret, public, name, created}` (version 1: no seed, `groups: false`) (`server.py:3208-3216, 3235-3242`) | **plain JSON**: file mode only |
| `wallet-inbox.json` | `{version, items: [{n, payload, source, received, read}], seen: [ids], next}` | payloads are sealed to the messaging key; `received`, `read`, `source` and the ids are in the clear |
| `wallet-outbox.json` | `{version, items: [{n, copy, at, v, sends: [{topic, payload, state, error, at, tries, rid, …}]}], next, rev}` (`server.py:3646-3651`) | `copy` is a store blob (below); each `payload` is sealed to its recipient and is cleared once sent (line 3528); **each recipient's inbox topic, the time and the delivery state are in the clear** |
| `wallet-chat.json` | `{rev, blob}` (`server.py:3701`) | `blob` is a store blob |
| `wallet-backup.json` | when the last backup was made, whether it held the messaging key | plain |
| `wallet-events.log` | "message sent" lines with Host, Origin, User-Agent (`server.py:2599-2612, 3654`) | plain |

**Store blobs** (`chat-core.js:8-12, 47-63`):

```
store_key = HKDF(ikm = the X25519 messaging secret (32 bytes), salt = (empty), info = utf8("logos-node/chat/v1/store"))
blob      = base64( nonce (24 random bytes) ‖ XChaCha20-Poly1305(store_key, nonce, aad = utf8("logos-node/chat/v1/" + kind)).encrypt(utf8(JSON.stringify(obj))) )
kind      = "store"  obj = {v: 1, profiles, convos, aliases}                      (chat-core.js:120)
          | "copy"   obj = {v: 1, convo, from, to: [{name, key}], ids, text, ts}   (chat-core.js:451)
```

A blob that does not open, or opens to something else, is treated as empty (`chat-core.js:57-63, 131-135`).

**What this protects.** The store key is derived from the messaging secret, which is stored in plain JSON in
the same folder. So the at-rest encryption keeps the chats out of the server code and out of anything that
copies only the chat files; it does not protect against anyone who can read the data folder. The comment at
`chat-core.js:11-12` says the same.

**In a backup** (`server.py:4027-4070`), the messaging key `{secret, public, name, seed, version}` and the
chats `{store, inbox, outbox, truncated}` go inside the backup's own encryption (scrypt N=2^16, r=8, p=1 from
the backup password; ChaCha20-Poly1305 with a 12-byte nonce; AAD `logos-node-wallet-backup v2`), together
with the node's key file and the LNS name account. Restoring puts the key back and adds the messages, each
once (`server.py:3281-3288, 3987-4024`).

**In memory.** The page fetches the secret key with `GET /api/messages/key` on every load of an unlocked page
(`messages.js:374-377`, `server.py:3787-3792`) and keeps it in a JavaScript variable until the page locks,
when it drops its references (`messages.js:338-339`).

## 15. Properties, stated plainly

- **Confidentiality** of a message against everyone but the recipient: XChaCha20-Poly1305 under a key from a
  fresh ephemeral X25519 exchange.
- **No forward secrecy for the recipient.** Every message to a device is decryptable with that device's one
  static messaging secret, for as long as anyone keeps the payload (the network's store nodes, the
  recipient's own inbox file and backups). The sender cannot decrypt its own sealed payloads; it keeps a
  separate copy.
- **Sender authentication to the recipient only**, and only that the sender holds `fromKey`'s secret. That
  `fromKey` belongs to a name is a separate check against the chain (§12), trust on first use.
- **No replay protection** beyond the duplicate memory (§11.3).
- **Metadata.** The topic identifies the recipient's key, to anyone who knows the key (it is public on the
  chain). Message sizes are not padded. The sending device's messaging node subscribes to the recipient's
  topic for about 180 s after each send (`server.py:3177, 3409-3418, 3551`), which a relay or filter node can
  see. The payload does not name the sender outside the encryption.
- **Deniability towards third parties**: the recipient can make a valid `auth` for any text "from" the
  sender (§6).

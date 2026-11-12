# Messages

Chats between LNS names, end to end encrypted, through a Logos Messaging node on the same device. They
exist only where such a node can run (inside the Android app, or with `WAKU_API` set). Without one, the
app and its page are exactly as before.

## Using it

- **Messages** in the bar at the bottom of the page. It locks with the wallet: the same PIN or fingerprint
  opens both, and auto-lock closes both.
- **Turn on messages** makes this phone's messaging identity. Nothing key-like is shown on the everyday
  screens; your own address and the command to link your name are in Messages settings (tap your name, or
  "No LNS name linked", at the top of the chat list).
- **New chat** takes an LNS name (`alice`) or a messaging address (`msg:` and 64 hex characters, copied from
  someone's Messages settings; spaces and line breaks are ignored, `msg:` may be left out).
- A Logos Blockchain wallet address is also 64 hex characters, but it can't be messaged. The app says so
  when it is one of this wallet's own addresses or can't be a messaging address. For other bare hex it asks
  you to check, which is why a copied messaging address starts with `msg:`.
- Tap a chat's header for the person's profile: a nickname and a private note (never sent; kept encrypted on
  the phone and in the backup), mute, block, and deleting the chat or the whole profile. The short form of
  their messaging address is under **Details**, the full one only on a further tap.

## Names, addresses and trust

- A name's messaging address is its `msg` text entry on the chain. The first time you talk with a name, the
  app pins the address it has then. If the entry changes later, the chat shows "alice's messaging address
  changed" and sends nothing to the new address until you accept it. Messages from the earlier address stay
  marked as such.
- A message is shown as from a name only if it proves it was sent with that name's pinned address.
  Anything else is marked "Not verified".
- Someone without an LNS name can still write and be written to, by messaging address. Their chat is titled
  with a short code (`1a2b3c…7d8e`) until you give it a nickname, and says "address only, no name to verify".
  If you later look up a name whose `msg` entry is that address, the app offers to merge the two chats.

## Sending without a name

The Names message format (version 1) needs a name-shaped `from`. A sender with no name puts
`msg-` followed by the first 16 hex characters of its own messaging address there. The message also carries
the full address and proves the sender holds it, so a receiver that sees exactly that pairing treats the
sender as an address, and nobody else can write as it. The wire format is unchanged: the Names web app opens
such a message and shows it as "unverified: claims to be msg-1a2b…" (it can't reply to it, since that isn't a
registered name). Messages between two names are byte for byte the Names format.

## What is kept, and where

Everything stays in the app's data folder on the phone:

| file | what |
|---|---|
| `wallet-msgkey.json` | the messaging identity: an Ed25519 seed and the X25519 key pair made from it (see docs/backup.md) |
| `wallet-inbox.json` | incoming messages exactly as they came off the network: sealed to the messaging key |
| `wallet-outbox.json` | sent messages: a copy encrypted by the page, and the sealed payload for each recipient until the network has it |
| `wallet-chat.json` | profiles, nicknames, notes, conversations: one blob encrypted by the page |

The page encrypts its copies and the profiles with XChaCha20-Poly1305 under a key made from the messaging
secret (HKDF-SHA256, info `logos-node/chat/v1/store`). The app's server code only stores and returns these
blobs and never decrypts them, and it hands them only to an unlocked page. The messaging key is stored on the
phone like the node's own keys, so the chats are unreadable without it, but no safer at rest than that key
file.

The app's event log records "message sent" and nothing about the message, the person or the count.

## Delivery

The app sends through its own queue: one post to the messaging node at a time, a second apart, and it follows
each one: **Sending…**, **Sent** (it reached other nodes), **Stored** (a Store node holds it until the
recipient is online), or **Not sent** with **Retry**. A message written while the messaging node is off waits
and goes when it's back. Message details (tap a message) show the state for each recipient.

## Limits

- The unread count that the Android app can show (`messaging_inbox_count()`) counts incoming messages the
  page hasn't shown yet. The app can't open messages itself, so a muted or blocked person's messages count
  until the page has been open once after they came.
- The messaging node keeps at most 50 received messages between two reads by the app (every 3 seconds); more
  in between are dropped and shown as missed.
- History in a backup is capped at 1 MB, newest first.
- Groups are not in this version.

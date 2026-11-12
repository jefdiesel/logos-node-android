// The chat model behind the Messages screen, without any page code, so the tests run the same logic.
//
// What is kept where (all of it on this device, in the app's data folder):
//   - incoming messages: the server's inbox, the sealed payloads exactly as they came off the network;
//   - my sent messages: an outbox item per message, holding a copy encrypted here (below) and, until the
//     network has it, the sealed payload for each recipient;
//   - profiles, notes, conversations: one blob encrypted here.
// The encryption key is made from this device's messaging secret key (HKDF-SHA256, info
// "logos-node/chat/v1/store"), and XChaCha20-Poly1305 with a random nonce seals each blob:
//   base64( nonce (24) ‖ ciphertext ), associated data "logos-node/chat/v1/<kind>" (kind "store" or "copy").
// The server only stores and returns these blobs; it never decrypts them. The messaging key itself is
// stored on the device like the node's own keys, so the chats are as safe at rest as that key file.
//
// People: a person is an LNS name ("alice"), or a messaging address with no name ("k:<64 hex>"), the
// X25519 key that a name publishes as its `msg` entry. Profiles are keyed by that id.
// Conversations are general: { id, kind: "direct" | "group", title, members: [{ name } or { name: null, key }],
// created }. A direct conversation's id is "d:<name>" or "k:<hex>". Each message carries its sender's id.
// Nothing here assumes a conversation has two parties; only send() and the incoming threading know which
// kinds exist (direct for now).
//
// Sending without an LNS name: the names format needs a name-shaped `from`, so a sender with no name puts
// "msg-" + the first 16 hex of its own messaging address there. A receiver that sees exactly that (it is
// bound to the sender's key, which the message proves) treats the sender as an address, not as a name. So an
// LNS name of that exact shape is always taken as an address.

import { sealMessage, openMessage, inboxTopic, toHex, fromHex, parseMsgKey, MAX_TEXT } from "./msg-crypto.js";
import { xchacha20poly1305 } from "./noble-ciphers/chacha.js";
import { hkdf } from "./noble-hashes/hkdf.js";
import { sha256 } from "./noble-hashes/sha2.js";

export { MAX_TEXT };
export const STORE_VERSION = 1;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const isAddressId = pid => typeof pid === "string" && pid.startsWith("k:");
export const convoIdOf = pid => isAddressId(pid) ? pid : "d:" + pid;
export const directId = convoIdOf;
export const memberId = m => m.name || "k:" + m.key;
export const nameless = hex => "msg-" + hex.slice(0, 16);            // the `from` of a sender with no name
/** A short fingerprint of a messaging address, for people to compare: "1a2b3c…7d8e". */
export const shortFp = hex => hex ? hex.slice(0, 6) + "…" + hex.slice(-4) : "";
/** The form a messaging address is shared in: "msg:" and 64 hex. */
export const shareable = hex => "msg:" + hex;

// ---- encryption of what the page keeps ----
export function storeKey(secret) {
  return hkdf(sha256, secret, new Uint8Array(0), enc.encode("logos-node/chat/v1/store"), 32);
}
export function encryptBlob(key, kind, obj) {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ct = xchacha20poly1305(key, nonce, enc.encode("logos-node/chat/v1/" + kind)).encrypt(enc.encode(JSON.stringify(obj)));
  const out = new Uint8Array(24 + ct.length); out.set(nonce); out.set(ct, 24);
  return b64(out);
}
export function decryptBlob(key, kind, text) {
  try {
    const raw = unb64(text);
    const plain = xchacha20poly1305(key, raw.subarray(0, 24), enc.encode("logos-node/chat/v1/" + kind)).decrypt(raw.subarray(24));
    return JSON.parse(dec.decode(plain));
  } catch (e) { return null; }
}

// ---- what someone typed or pasted as a recipient ----
const P25519 = (1n << 255n) - 19n;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
/** Whether 64 hex can be an X25519 public key: a u-coordinate below p on Curve25519 itself (not its twist). */
export function onCurve(hex) {
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(parseInt(hex.slice(2 * i, 2 * i + 2), 16));
  if (u >= P25519 || u < 2n) return false;
  const rhs = (u * u % P25519 * u + 486662n * u % P25519 * u + u) % P25519;
  return modpow(rhs, (P25519 - 1n) / 2n, P25519) === 1n;
}
/**
 * A messaging address in what was typed, or why it isn't one, or null when it doesn't look like an address
 * at all (then it may be a name). { address, sure } | { wallet: true } | null.
 * Messaging addresses are shared as "msg:<64 hex>"; bare 64 hex is accepted too, but a Logos Blockchain wallet
 * address is also 64 hex, so bare hex that is one of this wallet's own addresses, or that can't be an X25519
 * key, is called a wallet address, and other bare hex is accepted with a reminder to check (sure: false).
 */
export function parseAddress(input, walletKeys = []) {
  let s = String(input ?? "").replace(/\s+/g, "").toLowerCase();
  const prefixed = /^(?:msg:|logos-msg:)/.test(s);
  s = s.replace(/^(?:msg:|logos-msg:|0x)/, "");
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  if (!prefixed && walletKeys.includes(s)) return { wallet: true };
  if (!onCurve(s)) return prefixed ? { bad: true } : { wallet: true };
  return { address: s, sure: prefixed };
}

// ---- a name's picture and colour, as the Names SPEC has them ----
export const AVATAR_MAX = 65536;           // decoded bytes; the SPEC keeps a whole record within 12 KiB
export function safeAvatar(value) {
  const m = typeof value === "string" && /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m || m[2].length > Math.ceil(AVATAR_MAX / 3) * 4) return null;
  return value;                            // inline only: showing it fetches nothing
}
export const safeColor = value => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toLowerCase() : null;

// ---- the model ----
export class Chat {
  /**
   * me: { secret: Uint8Array, public: hex, name }; api(path, body) -> { ok, status, data } (the page's api());
   * resolve(name) -> null (not registered) or { texts, lapsed } (names.js resolveName against the chain).
   */
  constructor({ me, api, resolve }) {
    this.me = me; this.api = api; this.resolveRaw = resolve;
    this.key = storeKey(me.secret);
    this.store = this.emptyStore();
    this.rev = 0; this.storeUnreadable = false;
    this.inbox = new Map();                // n -> message (or null: doesn't open with this key)
    this.outbox = new Map();               // n -> message
    this.unread = new Set();
    this.inAfter = 0; this.outAfter = 0; this.outSince = 0;
    this.chain = new Map();                // name -> { registered, key, avatar, color, display, at }
    this.failed = new Map();               // name -> when reading it from the chain last failed
  }
  emptyStore() { return { v: STORE_VERSION, profiles: {}, convos: {}, aliases: {} }; }
  /** What goes in `from` on the wire: my LNS name once its msg entry is this phone's address (read on chain),
   *  otherwise the stand-in for a sender with no name. A name typed in but not linked is never used. */
  fromName() { return this.nameLinked() ? this.me.name : nameless(this.me.public); }
  nameLinked() { const c = this.me.name && this.chain.get(this.me.name); return Boolean(c && c.key === this.me.public); }

  // -- store --
  async loadStore() {
    const r = await this.api("/api/messages/store");
    if (!r.ok) throw Object.assign(new Error("store"), { status: r.status });
    this.rev = r.data.rev || 0;
    const got = r.data.blob ? decryptBlob(this.key, "store", r.data.blob) : null;
    this.storeUnreadable = Boolean(r.data.blob) && !got;
    this.store = got && got.v === STORE_VERSION ? got : this.emptyStore();
    this.store.profiles ||= {}; this.store.convos ||= {}; this.store.aliases ||= {};
  }
  /** Changes the store with fn(store) and saves it; another page's change in between is loaded and fn runs again. */
  async mutate(fn) {
    for (let i = 0; i < 3; i++) {
      fn(this.store);
      const r = await this.api("/api/messages/store", { rev: this.rev, blob: encryptBlob(this.key, "store", this.store) });
      if (r.ok) { this.rev = r.data.rev; return true; }
      if (r.status !== 409) throw Object.assign(new Error(r.data.error || "couldn't save"), { status: r.status });
      await this.loadStore();
    }
    throw new Error("couldn't save");
  }

  // -- the chain: a name's msg key and card entries (an address has no chain record) --
  async lookup(pid, fresh = false) {
    if (isAddressId(pid)) return { registered: false, address: true, key: pid.slice(2), avatar: null, color: null, display: "" };
    const hit = this.chain.get(pid);
    if (hit && !fresh && Date.now() - hit.at < 60000) return hit;
    const found = await this.resolveRaw(pid);
    const texts = (found && found.texts) || {};
    const k = parseMsgKey(texts.msg);
    const out = { registered: found !== null, lapsed: Boolean(found && found.lapsed), key: k ? toHex(k) : null,
                  avatar: safeAvatar(texts.avatar), color: safeColor(texts.color),
                  display: typeof texts.display === "string" ? texts.display.slice(0, 64) : "", at: Date.now() };
    this.chain.set(pid, out);
    return out;
  }
  chainOf(pid) { return isAddressId(pid) ? { registered: false, address: true, key: pid.slice(2) } : this.chain.get(pid) || null; }

  // -- people --
  profile(pid) { return this.store.profiles[pid] || null; }
  pinned(pid) {
    if (isAddressId(pid)) return pid.slice(2);
    const p = this.profile(pid); return p && p.keys.length ? p.keys[p.keys.length - 1].key : null;
  }
  /** How to call someone: the nickname, else the name, else the address's short fingerprint. */
  label(pid) { const p = this.profile(pid); return (p && p.nickname) || (isAddressId(pid) ? "Unnamed contact" : pid); }
  /** { pinned, chain, changed }: changed when the name's key on chain isn't the one pinned at first contact. */
  keyState(pid) {
    const pinned = this.pinned(pid), c = this.chainOf(pid);
    const chain = c ? c.key : undefined;
    return { pinned, chain, changed: Boolean(pinned && chain && chain !== pinned) };
  }
  newProfile(pid, key) {
    const now = Date.now();
    return { name: pid, keys: key ? [{ key, at: now }] : [], nickname: "", note: "", blocked: false, muted: false, created: now, updated: now };
  }
  async setProfile(pid, fields) {
    const allowed = ["nickname", "note", "blocked", "muted"];
    await this.mutate(s => {
      const p = s.profiles[pid] || (s.profiles[pid] = this.newProfile(pid, isAddressId(pid) ? pid.slice(2) : null));
      for (const k of allowed) if (k in fields) p[k] = typeof p[k] === "boolean" ? Boolean(fields[k]) : String(fields[k]).slice(0, k === "note" ? 4000 : 40);
      p.updated = Date.now();
    });
    if (fields.blocked) await this.markRead(convoIdOf(pid));
  }
  /** Accepts the name's current on-chain key: messages are sent to it from now on. */
  async acceptKey(name) {
    const c = await this.lookup(name, true);
    if (!c.key) throw new Error(name + " has no messaging address now.");
    await this.mutate(s => {
      const p = s.profiles[name] || (s.profiles[name] = this.newProfile(name, null));
      if (!p.keys.length || p.keys[p.keys.length - 1].key !== c.key) p.keys.push({ key: c.key, at: Date.now() });
      p.updated = Date.now();
    });
  }
  /** Pins `key` for `pid` if nothing is pinned yet (first contact). */
  pinFirst(s, pid, key) {
    const p = s.profiles[pid] || (s.profiles[pid] = this.newProfile(pid, null));
    if (!p.keys.length && key) p.keys.push({ key, at: Date.now() });
    return p;
  }
  /** The address chat whose address is `key`, if there is one (to offer merging it into a name). */
  addressChatFor(key) { const id = "k:" + key; return this.store.convos[id] && !this.store.aliases[id] ? id : null; }
  /**
   * Merges the address chat "k:<key>" into the chat with `name`, once the chain says `key` is that name's
   * messaging address: its messages show in the name's chat, and its nickname and note move over if the
   * name's profile has none.
   */
  async mergeAddress(key, name) {
    const c = await this.lookup(name, true);
    if (c.key !== key) throw new Error(name + "'s messaging address isn't this one.");
    const aid = "k:" + key, id = convoIdOf(name);
    await this.mutate(s => {
      s.aliases[aid] = name;
      const from = s.profiles[aid] || {}, to = this.pinFirst(s, name, key);
      if (!to.nickname && from.nickname) to.nickname = from.nickname;
      if (!to.note && from.note) to.note = from.note;
      if (from.blocked) to.blocked = true;
      delete s.profiles[aid]; delete s.convos[aid];
      if (!s.convos[id]) s.convos[id] = { id, kind: "direct", title: name, members: [{ name }], created: Date.now() };
    });
    return id;
  }
  /** A message's conversation, after merges. */
  thread(id) { const a = this.store.aliases[id]; return a ? convoIdOf(a) : id; }

  // -- conversations --
  convo(id) {
    if (!id.startsWith("x:")) return this.store.convos[id] || null;
    // messages that claim a name but didn't come from its messaging address: a thread of their own, never
    // the real person's, keyed by the address they did come from
    const m = [...this.inbox.values()].find(x => x && this.threadOf(x) === id);
    return m ? { id, kind: "direct", unverified: true, claimed: m.sender, title: m.sender, members: [{ name: null, key: m.senderKey }], created: m.received } : null;
  }
  /** Starts (or opens) the direct chat with `name`, after a lookup that found its messaging address. */
  async startDirect(name) {
    const c = await this.lookup(name, true);
    if (!c.registered) throw Object.assign(new Error(name + " isn't a registered name."), { code: "unregistered" });
    if (!c.key) throw Object.assign(new Error(name + " hasn't turned on messages."), { code: "nokey" });
    const id = convoIdOf(name);
    await this.mutate(s => {
      this.pinFirst(s, name, c.key);
      if (!s.convos[id]) s.convos[id] = { id, kind: "direct", title: name, members: [{ name }], created: Date.now() };
    });
    return id;
  }
  /** Starts (or opens) the direct chat with a messaging address that has no name. */
  async startAddress(key) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("That isn't a messaging address.");
    const aid = "k:" + key;
    if (this.store.aliases[aid]) return convoIdOf(this.store.aliases[aid]);
    await this.mutate(s => {
      this.pinFirst(s, aid, key);
      if (!s.convos[aid]) s.convos[aid] = { id: aid, kind: "direct", title: shortFp(key), members: [{ name: null, key }], created: Date.now() };
    });
    return aid;
  }
  peer(convo) { return convo.kind === "direct" ? memberId(convo.members[0]) : null; }
  title(convo) {
    if (convo.unverified) return "Not verified: " + (isAddressId(convo.claimed) ? "unnamed" : convo.claimed);
    return convo.kind === "direct" ? this.label(this.peer(convo)) : convo.title;
  }
  /** The conversation a message shows in: its own, or for an unverified one, "x:<the address it came from>". */
  threadOf(m) { return m.dir === "in" && this.trust(m) === "unverified" ? "x:" + m.senderKey : this.thread(m.convo); }
  isBlocked(convo) { return convo.kind === "direct" && Boolean((this.profile(this.peer(convo)) || {}).blocked); }
  isMuted(convo) { return Boolean(convo.muted) || (convo.kind === "direct" && Boolean((this.profile(this.peer(convo)) || {}).muted)); }

  // -- messages --
  /** Reads what came in and what was sent since last time. Returns true when anything changed. */
  async sync() {
    let changed = false;
    // the outbox first: an incoming copy of something sent from here is recognised by it
    const ro = await this.api(`/api/messages/outbox?after=${this.outAfter}&since=${this.outSince}`);
    if (!ro.ok) throw Object.assign(new Error("outbox"), { status: ro.status });
    for (const item of ro.data.items) {
      this.outAfter = Math.max(this.outAfter, item.n);
      const m = this.openCopy(item);
      if (m) this.outbox.set(item.n, m);
      changed = true;
    }
    for (const ch of ro.data.changed) {
      const m = this.outbox.get(ch.n);
      if (m) { m.sends = m.sends.map((x, i) => Object.assign({}, x, ch.sends[i] || {})); changed = true; }
    }
    this.outSince = ro.data.rev || this.outSince;
    const ri = await this.api("/api/messages/inbox?after=" + this.inAfter);
    if (!ri.ok) throw Object.assign(new Error("inbox"), { status: ri.status });
    const fresh = [];
    for (const item of ri.data.items) {
      this.inAfter = Math.max(this.inAfter, item.n);
      const m = this.openIncoming(item);
      this.inbox.set(item.n, m);
      if (m) fresh.push(m);
      changed = true;
    }
    const unread = new Set(ri.data.unread || []);
    if (unread.size !== this.unread.size || [...unread].some(n => !this.unread.has(n))) changed = true;
    this.unread = unread;
    // read the chain for names whose message came from an address not pinned for them, to tell a new
    // address from a stranger; then chats for people who wrote first (only if the message is theirs)
    // (over every message, not only new ones: a name the chain couldn't be asked about is tried again later)
    const all = [...this.inbox.values()].filter(Boolean);
    const unknown = [...new Set(all.filter(m => !isAddressId(m.sender) && !this.chainOf(m.sender)
      && !(this.profile(m.sender) || { keys: [] }).keys.some(k => k.key === m.senderKey)).map(m => m.sender))];
    for (const pid of unknown) {
      if (Date.now() - (this.failed.get(pid) || 0) < 30000) continue;
      try { await this.lookup(pid); this.failed.delete(pid); } catch (e) { this.failed.set(pid, Date.now()); }
    }
    const newcomers = [...new Set(all.filter(m => m.kind === "direct" && this.trust(m) !== "unverified" && !this.convo(this.thread(m.convo))).map(m => m.sender))];
    if (newcomers.length) {
      await this.mutate(s => {
        for (const pid of newcomers) {
          const first = all.find(m => m.sender === pid && this.trust(m) !== "unverified");
          const c = this.chainOf(pid);
          const id = convoIdOf(pid);
          if (s.convos[id]) continue;
          if (isAddressId(pid)) {
            if (!first.authentic) continue;               // an address that can't prove itself gets no chat
            this.pinFirst(s, pid, first.senderKey);
            s.convos[id] = { id, kind: "direct", title: shortFp(first.senderKey), members: [{ name: null, key: first.senderKey }], created: Date.now() };
          } else {
            this.pinFirst(s, pid, first.authentic && c && c.key === first.senderKey ? first.senderKey : null);
            s.convos[id] = { id, kind: "direct", title: pid, members: [{ name: pid }], created: Date.now() };
          }
        }
      });
    }
    // a blocked sender's messages count as read straight away
    const quiet = fresh.filter(m => this.unread.has(m.n) && this.convo(this.threadOf(m)) && this.isBlocked(this.convo(this.threadOf(m))));
    if (quiet.length) await this.markRead(null, quiet.map(m => m.n));
    return changed;
  }
  openIncoming(item) {
    let raw;
    try { raw = unb64(item.payload); } catch (e) { return null; }
    const msg = openMessage(this.me.secret, raw);
    if (!msg) return null;
    // a copy of something this device sent (a note to self, or a node handing back its own message)
    for (const o of this.outbox.values()) if (o.ids.includes(msg.id)) return null;
    const received = Date.parse(item.received) || Date.now();
    // "msg-<16 hex>" is the stand-in of a sender with no name; it must be the sender's own address, or the
    // message is someone pretending (it is shown as unverified, and starts no chat)
    const shaped = /^msg-[0-9a-f]{16}$/.test(msg.from);
    const pid = shaped ? "k:" + msg.fromKey : msg.from;
    return { key: "i:" + item.n, n: item.n, dir: "in", kind: "direct", convo: convoIdOf(pid), sender: pid,
             senderKey: msg.fromKey, authentic: msg.authentic && (!shaped || msg.from === nameless(msg.fromKey)), id: msg.id, text: msg.text,
             ts: Math.min(msg.ts, received + 300000), received, source: item.source || null };
  }
  openCopy(item) {
    const c = decryptBlob(this.key, "copy", item.copy);
    if (!c || c.v !== 1 || typeof c.convo !== "string") return null;
    return { key: "o:" + item.n, n: item.n, dir: "out", kind: /^[dk]:/.test(c.convo) ? "direct" : "group", convo: c.convo,
             sender: c.from, to: c.to || [], ids: c.ids || [], text: String(c.text || ""), ts: c.ts,
             sends: item.sends.map(x => ({ state: x.state, error: x.error || "", at: x.at, resend: x.resend !== false })) };
  }
  /** Every message of a conversation, oldest first (a blocked person's are left out). */
  messages(id) {
    const convo = this.convo(id);
    const mine = m => m && this.threadOf(m) === id;
    if (convo && this.isBlocked(convo)) return [...this.outbox.values()].filter(mine).sort((a, b) => a.ts - b.ts);
    const seen = new Set(), out = [];
    for (const m of [...this.inbox.values(), ...this.outbox.values()]) {
      if (!mine(m)) continue;
      if (m.dir === "in") { if (seen.has(m.id)) continue; seen.add(m.id); }
      out.push(m);
    }
    return out.sort((a, b) => a.ts - b.ts || a.n - b.n);
  }
  /**
   * How far to trust an incoming message:
   *   "ok"         sent with the key pinned for this name (and the chain agrees, or wasn't read yet);
   *   "old"        sent with a key accepted for this name earlier;
   *   "new-key"    sent with the name's new on-chain key, which isn't accepted yet;
   *   "address"    from a messaging address with no name: it proves it holds that address, nothing more;
   *   "unverified" not sent with any key known for this name, or the sender couldn't prove the key.
   */
  trust(m) {
    if (m.dir !== "in") return "ok";
    if (!m.authentic) return "unverified";
    if (isAddressId(m.sender)) return m.sender === "k:" + m.senderKey ? "address" : "unverified";
    const p = this.profile(m.sender);
    const keys = p ? p.keys.map(k => k.key) : [];
    if (keys.length && keys[keys.length - 1] === m.senderKey) return "ok";
    if (keys.includes(m.senderKey)) return "old";
    const c = this.chainOf(m.sender);
    if (c && c.key === m.senderKey) return keys.length ? "new-key" : "ok";
    return "unverified";
  }
  /** The conversation list: newest first, with the last message and the unread count. */
  conversations() {
    const out = [];
    const strangers = [...new Set([...this.inbox.values()].filter(m => m && this.threadOf(m).startsWith("x:")).map(m => this.threadOf(m)))];
    for (const convo of [...Object.values(this.store.convos), ...strangers.map(id => this.convo(id))]) {
      const list = this.messages(convo.id);
      const last = list[list.length - 1] || null;
      const unread = list.filter(m => m.dir === "in" && this.unread.has(m.n)).length;
      out.push({ convo, last, unread, title: this.title(convo), muted: this.isMuted(convo), blocked: this.isBlocked(convo),
                 at: last ? last.ts : convo.created });
    }
    return out.sort((a, b) => b.at - a.at);
  }
  unreadTotal() { return this.conversations().filter(c => !c.muted && !c.blocked).reduce((n, c) => n + c.unread, 0); }
  async markRead(id, ns = null) {
    ns = ns || this.messages(id).filter(m => m.dir === "in" && this.unread.has(m.n)).map(m => m.n);
    if (!ns.length) return;
    const r = await this.api("/api/messages/inbox/read", { ids: ns });
    if (r.ok) for (const n of ns) this.unread.delete(n);
  }

  /**
   * Why sending to this conversation can't happen right now, or null: { code, name, text }.
   * Reads each named member's key on chain (cached a minute).
   */
  async sendBlocker(id, fresh = false) {
    const convo = this.convo(id);
    if (!convo) return { code: "gone", text: "This chat was deleted." };
    if (convo.unverified) return { code: "unverified", text: "These messages didn't come from " + (isAddressId(convo.claimed) ? "the address they name" : convo.claimed + "'s messaging address") + ", so you can't reply here." };
    if (this.isBlocked(convo)) { const pid = this.peer(convo); return { code: "blocked", name: pid, text: "You blocked " + this.label(pid) + "." }; }
    for (const m of convo.members) {
      if (!m.name) continue;                              // an address: nothing to check on chain
      const name = m.name;
      let c;
      try { c = await this.lookup(name, fresh); } catch (e) { return { code: "offline", name, text: "Couldn't reach the name service." }; }
      if (!c.registered) return { code: "unregistered", name, text: name + " isn't a registered name any more." };
      if (!c.key) return { code: "nokey", name, text: name + " has turned off messages." };
      const pinned = this.pinned(name);
      if (pinned && pinned !== c.key) return { code: "changed", name, text: name + "'s messaging address changed." };
    }
    return null;
  }
  /** Seals `text` to every member, keeps an encrypted copy, and hands both to the server's sender. */
  async send(id, text) {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw new Error("A message is 1 to " + MAX_TEXT + " characters.");
    const why = await this.sendBlocker(id);
    if (why) throw Object.assign(new Error(why.text), { code: why.code });
    if (this.me.name) { try { await this.lookup(this.me.name); } catch (e) {} }
    const convo = this.convo(id), ts = Date.now(), to = [], ids = [], sends = [], from = this.fromName();
    for (const m of convo.members) {
      const key = m.name ? this.chainOf(m.name).key : m.key;
      const sealed = sealMessage({ to: fromHex(key), from, fromSecret: this.me.secret, text, ts });
      to.push({ name: m.name || null, key }); ids.push(toHex(sealed.subarray(1, 33)));
      sends.push({ topic: inboxTopic(fromHex(key)), payload: b64(sealed) });
    }
    const unpinned = to.filter(t => t.name && !this.pinned(t.name));
    if (unpinned.length) await this.mutate(s => { for (const t of unpinned) this.pinFirst(s, t.name, t.key); });
    const copy = encryptBlob(this.key, "copy", { v: 1, convo: id, from, to, ids, text, ts });
    const r = await this.api("/api/messages/outbox", { copy, sends });
    if (!r.ok) throw Object.assign(new Error(r.data.error || "The message wasn't sent."), { status: r.status });
    await this.sync();
    return r.data.n;
  }
  async retry(n) { const r = await this.api("/api/messages/outbox/retry", { n }); await this.sync(); return r.ok; }

  async deleteMessage(m) {
    const r = await this.api(m.dir === "in" ? "/api/messages/inbox/delete" : "/api/messages/outbox/delete", { ids: [m.n] });
    if (r.ok) (m.dir === "in" ? this.inbox : this.outbox).delete(m.n);
    return r.ok;
  }
  /** Deletes a conversation's messages; with `profile`, the person's profile and note too. */
  async deleteConversation(id, profile = false) {
    const ins = [...this.inbox.values()].filter(m => m && this.threadOf(m) === id).map(m => m.n);
    const outs = [...this.outbox.values()].filter(m => this.threadOf(m) === id).map(m => m.n);
    if (ins.length) await this.api("/api/messages/inbox/delete", { ids: ins });
    if (outs.length) await this.api("/api/messages/outbox/delete", { ids: outs });
    for (const n of ins) this.inbox.delete(n);
    for (const n of outs) this.outbox.delete(n);
    const convo = this.convo(id);
    if (id.startsWith("x:")) return;
    await this.mutate(s => {
      delete s.convos[id];
      if (profile && convo && convo.kind === "direct") delete s.profiles[this.peer(convo)];
    });
  }
}

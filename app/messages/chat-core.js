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

//
// Requests (from 0.9.14): a message from someone who isn't in your chats (no chat, no profile with a pinned
// address, and an address that isn't any contact's) is a request. It shows nowhere but Requests, never counts
// as unread, and is capped (REQ below); messages over a cap, from a blocked address, or (with "Only people
// I've written to") from anyone new are deleted from the server unread. Messages that arrived before this
// version (the server's `sort_from`) keep the earlier rules: a first message started a chat.
//
// Padding (from 0.9.14): sent messages are sealed by sealPadded() below, which is the names format version 1
// byte for byte, plus a "p" field of spaces in the sealed JSON so the plaintext is exactly one of PAD_CLASSES
// bytes. Readers of version 1 (msg-crypto.js openMessage, here and in the Names web app) take only the fields
// they know and ignore "p"; it is inside the AEAD and outside the `auth` HMAC.
//
// Safety codes (from 0.9.14): safetyCode() gives 60 digits from the two messaging addresses, the same on both
// phones. A contact is "checked" only when the user compared it or scanned it; the profile keeps the address
// it was checked for, and a later change of that address stops sending until it's compared again or accepted
// on purpose.

import { openMessage, inboxTopic, toHex, fromHex, parseMsgKey, MAX_TEXT } from "./msg-crypto.js";
import { x25519 } from "../noble-curves/ed25519.js";
import { xchacha20poly1305 } from "./noble-ciphers/chacha.js";
import { hkdf } from "./noble-hashes/hkdf.js";
import { hmac } from "./noble-hashes/hmac.js";
import { sha256, sha512 } from "./noble-hashes/sha2.js";

export { MAX_TEXT };
export const STORE_VERSION = 1;
const enc = new TextEncoder(), dec = new TextDecoder();
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

// ---- padding: the names format version 1, with the plaintext padded to a size class ----
/** Plaintext sizes in bytes. The top one plus the 73 bytes around it stays under the server's 16,384. */
export const PAD_CLASSES = [512, 2048, 8192, 15872];
/** The smallest class that holds `n` bytes, or null (no valid message gets there; it then goes unpadded). */
export const padClass = n => PAD_CLASSES.find(c => c >= n) || null;
const V1_INFO = enc.encode("names/msg/v1"), V1_AUTH = enc.encode("names/msg/v1/auth");
/** X25519, refusing the all-zero result of a low-order key (as msg-crypto.js does). */
function dh(secretKey, publicKey) {
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  if (shared.every(b => b === 0)) throw new Error("bad public key");
  return shared;
}
/**
 * msg-crypto.js sealMessage, with the plaintext JSON padded by a "p" field of spaces to a PAD_CLASSES size.
 * Wire: 0x01 ‖ ephemeral public (32) ‖ nonce (24) ‖ XChaCha20-Poly1305(key, nonce, ad = 0x01 ‖ ephemeral public)
 * of JSON { v: 1, from, fromKey, text, ts, auth, p }; key and auth exactly as msg-crypto.js makes them.
 */
export function sealPadded({ to, from, fromSecret, text, ts = Date.now() }) {
  if (!(to instanceof Uint8Array) || to.length !== 32) throw new Error("recipient key must be 32 bytes");
  if (!NAME_RE.test(from)) throw new Error("from must be a name");
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) throw new Error("bad text");
  const fromKey = x25519.getPublicKey(fromSecret);
  const ephSecret = x25519.utils.randomSecretKey(), ephPublic = x25519.getPublicKey(ephSecret);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const header = cat([1], ephPublic, nonce);
  const key = hkdf(sha256, dh(ephSecret, to), cat(ephPublic, to), V1_INFO, 32);
  const authKey = hkdf(sha256, dh(fromSecret, to), new Uint8Array(0), V1_AUTH, 32);
  const auth = toHex(hmac(sha256, authKey, cat(header, enc.encode(from), [0], fromKey, enc.encode(String(ts)), [0], enc.encode(text))));
  const body = { v: 1, from, fromKey: toHex(fromKey), text, ts, auth };
  const bare = enc.encode(JSON.stringify({ ...body, p: "" })).length;     // spaces are one byte each in JSON
  const size = padClass(bare);
  const plain = enc.encode(JSON.stringify({ ...body, p: " ".repeat(size ? size - bare : 0) }));
  return cat(header, xchacha20poly1305(key, nonce, cat([1], ephPublic)).encrypt(plain));
}

// ---- safety codes ----
const SAFETY_DOMAIN = enc.encode("names/safety-code/v1"), SAFETY_ROUNDS = 5200;
/** 30 digits for one messaging address: SHA-512 iterated (as Signal's safety numbers), 6 groups of 5. */
function safetyHalf(key) {
  let h = sha512(cat(SAFETY_DOMAIN, key));
  for (let i = 0; i < SAFETY_ROUNDS; i++) h = sha512(cat(h, key));
  let out = "";
  for (let i = 0; i < 6; i++) { let v = 0; for (let j = 0; j < 5; j++) v = v * 256 + h[5 * i + j]; out += String(v % 100000).padStart(5, "0"); }
  return out;
}
const safetyCache = new Map();
/** The safety code of two messaging addresses (64 hex each): 60 digits, the same whichever side computes it. */
export function safetyCode(aHex, bHex) {
  const id = [aHex, bHex].sort().join(":");
  if (!safetyCache.has(id)) {
    if (![aHex, bHex].every(h => /^[0-9a-f]{64}$/.test(h))) throw new Error("a messaging address is 64 hex");
    if (safetyCache.size > 64) safetyCache.clear();
    safetyCache.set(id, [safetyHalf(fromHex(aHex)), safetyHalf(fromHex(bHex))].sort().join(""));
  }
  return safetyCache.get(id);
}
/** 12 groups of 5 digits, for people to read. */
export const safetyGroups = code => code.match(/\d{5}/g) || [];
/** What the safety-code QR holds. */
export const safetyQr = code => "names-safety:1:" + code;
/** What a scanned code says, for a safety check: { code } (a safety-code QR), { key } (a messaging address QR), or null. */
export function readSafetyScan(text) {
  if (typeof text !== "string" || text.length > 200) return null;
  const t = text.trim().toLowerCase();
  let m;
  if ((m = /^names-safety:1:(\d{60})$/.exec(t))) return { code: m[1] };
  if ((m = /^msg:([0-9a-f]{64})$/.exec(t))) return { key: canonKey(m[1]) };
  return null;
}

// ---- requests: the caps ----
// Per sender: one request, its first 3 messages. In all: 50 requests (the newest kept; a proven LNS name kept
// before an address, an address before a message that can't prove where it's from), 1 MiB of sealed bytes, and
// nothing older than 30 days. (The counts are the design's; the bytes and the age are this app's choice.)
export const REQ = { PER_SENDER: 3, SENDERS: 50, BYTES: 1048576, AGE_MS: 30 * 864e5 };
export const BLOCKED_MAX = 500;
const b64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const isAddressId = pid => typeof pid === "string" && pid.startsWith("k:");
export const convoIdOf = pid => isAddressId(pid) ? pid : "d:" + pid;
export const directId = convoIdOf;
export const memberId = m => m.name || "k:" + m.key;
export const nameless = hex => "msg-" + hex.slice(0, 16);            // the `from` of a sender with no name
/**
 * A messaging address as one identity: X25519 ignores the top bit of the last byte, so the same key has two
 * spellings; this clears it. Every key compared, pinned, blocked or shown goes through it.
 */
export const canonKey = hex => { const b = fromHex(hex); b[31] &= 0x7f; return toHex(b); };
/** A short fingerprint of a messaging address, for people to compare: "1a2b3c…7d8e". */
export const shortFp = hex => hex ? hex.slice(0, 6) + "…" + hex.slice(-4) : "";
/** The form a messaging address is shared in: "msg:" and 64 hex. */
export const shareable = hex => "msg:" + hex;
/**
 * The store's maps (profiles, conversations, aliases, blocked addresses) are keyed by strings a stranger chooses
 * (an LNS name in a message's `from`), so they have no prototype: "constructor" and the like are never found on
 * a plain object's prototype, and "__proto__" is an ordinary key. Lookups also go through own() (Object.hasOwn).
 */
export const dict = o => Object.assign(Object.create(null), o && typeof o === "object" && !Array.isArray(o) ? o : {});
export const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

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
  /**
   * bgApi / bgResolve (optional): the same as api / resolve, for what the page does on its own (reading the inbox,
   * sorting it, the chain reads that follow): the server must not count those as the user being active, or a
   * stranger writing every few seconds would keep the wallet from locking. Without them, api / resolve are used.
   */
  constructor({ me, api, resolve, bgApi = null, bgResolve = null }) {
    this.me = me; this.api = api; this.resolveRaw = resolve; this.bgApi = bgApi || api; this.bgResolve = bgResolve;
    this.key = storeKey(me.secret);
    this.store = this.emptyStore();
    this.rev = 0; this.storeUnreadable = false;
    this.inbox = new Map();                // n -> message (or null: doesn't open with this key)
    this.outbox = new Map();               // n -> message
    this.unread = new Set();
    this.inAfter = 0; this.outAfter = 0; this.outSince = 0;
    this.chain = new Map();                // name -> { registered, key, avatar, color, display, at }
    this.failed = new Map();               // name -> when reading it from the chain last failed
    this.tags = new Map();                 // n -> the server's sort of an incoming message: "c" chat, "r" request, "" not yet
    this.own = new Set();                  // n of incoming copies of my own messages
    this.sortFrom = Infinity;              // messages numbered below this came before Requests (the server says)
    this.held = new Set();                 // n of messages that are requests: shown nowhere but Requests
    this.reqs = [];                        // the requests, newest first (see sortIncoming)
    // Fail closed: only a message sortIncoming put in the chats is shown or counted anywhere (chatN); one it
    // dropped stays dropped (dropping, kept in the store too until the server has deleted it), and one that was
    // ever a request (reqEver) never starts a chat by itself.
    this.chatN = new Set();
    this.dropping = new Set();
    this.reqEver = new Set();
    this.wasDropped = new Set();           // n of messages put back from "dropped" (never start a chat by themselves)
    // Nothing is sorted, dropped or started from the store until it was loaded and opened in this session:
    // an empty store (it didn't load, or it is from another messaging address) would make every contact a
    // stranger. Until then only what the server already has as chat messages shows.
    this.storeOk = false;
    this.bad = new Set();                  // n of messages that made the code throw: set aside, never shown or sorted
  }
  emptyStore() { return { v: STORE_VERSION, profiles: dict(), convos: dict(), aliases: dict() }; }
  /** What goes in `from` on the wire: my LNS name once its msg entry is this phone's address (read on chain),
   *  otherwise the stand-in for a sender with no name. A name typed in but not linked is never used. */
  fromName() { return this.nameLinked() ? this.me.name : nameless(this.me.public); }
  nameLinked() { const c = this.me.name && this.chain.get(this.me.name); return Boolean(c && c.key === this.me.public); }

  // -- store --
  async loadStore() {
    const r = await this.api("/api/messages/store");
    if (!r.ok) throw Object.assign(new Error("store"), { status: r.status, unreadable: Boolean(r.data && r.data.unreadable) });
    this.rev = r.data.rev || 0;
    const got = r.data.blob ? decryptBlob(this.key, "store", r.data.blob) : null;
    this.storeUnreadable = Boolean(r.data.blob) && !(got && got.v === STORE_VERSION);
    this.storeOk = !this.storeUnreadable;                // loaded, and opened (or there is none yet)
    this.store = got && got.v === STORE_VERSION ? got : this.emptyStore();
    this.store.profiles = dict(this.store.profiles); this.store.convos = dict(this.store.convos); this.store.aliases = dict(this.store.aliases);
    if (this.store.blockedKeys) this.store.blockedKeys = dict(this.store.blockedKeys);
    for (const n of (this.store.req && Array.isArray(this.store.req.dropping) ? this.store.req.dropping : [])) if (Number.isSafeInteger(n)) this.dropping.add(n);
  }
  /**
   * Changes the store with fn(store) and saves it; another page's change in between is loaded and fn runs again.
   * `bg`: a change the page makes on its own (not the user's doing), saved without counting as activity.
   */
  async mutate(fn, bg = false) {
    for (let i = 0; i < 3; i++) {
      if (bg && !this.storeOk) throw new Error("the saved chats aren't loaded");     // never write a store it didn't open
      fn(this.store);
      const r = await (bg ? this.bgApi : this.api)("/api/messages/store", { rev: this.rev, blob: encryptBlob(this.key, "store", this.store) });
      if (r.ok) { this.rev = r.data.rev; return true; }
      if (r.status !== 409) throw Object.assign(new Error(r.data.error || "couldn't save"), { status: r.status });
      await this.loadStore();
    }
    throw new Error("couldn't save");
  }

  // -- the chain: a name's msg key and card entries (an address has no chain record) --
  async lookup(pid, fresh = false, bg = false) {
    if (isAddressId(pid)) return { registered: false, address: true, key: pid.slice(2), avatar: null, color: null, display: "" };
    const hit = this.chain.get(pid);
    if (hit && !fresh && Date.now() - hit.at < 60000) return hit;
    const found = await (bg && this.bgResolve ? this.bgResolve : this.resolveRaw)(pid);
    const texts = (found && found.texts) || {};
    const k = parseMsgKey(texts.msg);
    const out = { registered: found !== null, lapsed: Boolean(found && found.lapsed), key: k ? canonKey(toHex(k)) : null,
                  avatar: safeAvatar(texts.avatar), color: safeColor(texts.color),
                  display: typeof texts.display === "string" ? texts.display.slice(0, 64) : "", at: Date.now() };
    this.chain.set(pid, out);
    return out;
  }
  chainOf(pid) { return isAddressId(pid) ? { registered: false, address: true, key: pid.slice(2) } : this.chain.get(pid) || null; }

  // -- people --
  profile(pid) { return own(this.store.profiles, pid) || null; }
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
      const p = own(s.profiles, pid) || (s.profiles[pid] = this.newProfile(pid, isAddressId(pid) ? pid.slice(2) : null));
      for (const k of allowed) if (k in fields) p[k] = typeof p[k] === "boolean" ? Boolean(fields[k]) : String(fields[k]).slice(0, k === "note" ? 4000 : 40);
      p.updated = Date.now();
    });
    if (fields.blocked) await this.markRead(convoIdOf(pid));
  }
  /**
   * Accepts the name's current on-chain key: messages are sent to it from now on. A contact checked for the
   * pinned key isn't moved to a new one by this unless `unchecked` (the user chose to accept without checking);
   * accepting a new key always ends "checked" (the new key wasn't).
   */
  async acceptKey(name, { unchecked = false } = {}) {
    if (this.isChecked(name) && !unchecked) throw Object.assign(new Error("You checked " + name + "'s earlier messaging address. Compare codes again, or accept without checking."), { code: "checked" });
    const c = await this.lookup(name, true);
    if (!c.key) throw new Error(name + " has no messaging address now.");
    await this.mutate(s => {
      const p = own(s.profiles, name) || (s.profiles[name] = this.newProfile(name, null));
      if (!p.keys.length || p.keys[p.keys.length - 1].key !== c.key) { p.keys.push({ key: c.key, at: Date.now() }); p.checked = null; }
      p.updated = Date.now();
    });
  }

  // -- safety codes and "checked" --
  /** Whether the user checked this contact's current messaging address (code compared, or scanned). */
  isChecked(pid) {
    const p = this.profile(pid), k = this.pinned(pid);
    return Boolean(p && p.checked && k && p.checked.key === k);
  }
  /** Whether this contact was checked for an address that is no longer the one on chain (sending stops). */
  checkedButChanged(pid) { const st = this.keyState(pid); return st.changed && this.isChecked(pid); }
  /**
   * The safety code to compare with `pid` now: for the address on chain when it changed (that is the one to
   * check), else for the pinned one. { key, code, changed } or null when there's no address to compare.
   */
  safetyFor(pid) {
    const st = this.keyState(pid), key = st.changed ? st.chain : st.pinned;
    return key ? { key, code: safetyCode(this.me.public, key), changed: st.changed } : null;
  }
  /**
   * The user compared the code for `key` (or scanned their address, `how` "scan"). Marks the contact checked for
   * that key; when it is the name's new on-chain address, that address is accepted too. Refuses any other key.
   */
  async markChecked(pid, key, how = "code") {
    const cur = this.safetyFor(pid);
    if (!cur || cur.key !== key) throw new Error("That isn't " + this.label(pid) + "'s messaging address.");
    if (cur.changed) {                 // the new address on chain: read it again before taking it
      const c = await this.lookup(pid, true);
      if (c.key !== key) throw new Error(this.label(pid) + "'s messaging address changed again. Look again.");
    }
    await this.mutate(s => {
      const p = own(s.profiles, pid) || (s.profiles[pid] = this.newProfile(pid, isAddressId(pid) ? pid.slice(2) : null));
      if (!p.keys.length || p.keys[p.keys.length - 1].key !== key) p.keys.push({ key, at: Date.now() });
      p.checked = { key, at: Date.now(), how: how === "scan" ? "scan" : "code" };
      p.updated = Date.now();
    });
  }
  async clearChecked(pid) { await this.mutate(s => { const p = own(s.profiles, pid); if (p) { p.checked = null; p.updated = Date.now(); } }); }
  /** Pins `key` for `pid` if nothing is pinned yet (first contact). */
  pinFirst(s, pid, key) {
    const p = own(s.profiles, pid) || (s.profiles[pid] = this.newProfile(pid, null));
    if (!p.keys.length && key) p.keys.push({ key, at: Date.now() });
    return p;
  }
  /** The address chat whose address is `key`, if there is one (to offer merging it into a name). */
  addressChatFor(key) { const id = "k:" + key; return own(this.store.convos, id) && !own(this.store.aliases, id) ? id : null; }
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
      const from = own(s.profiles, aid) || {}, to = this.pinFirst(s, name, key);
      if (!to.nickname && from.nickname) to.nickname = from.nickname;
      if (!to.note && from.note) to.note = from.note;
      if (from.blocked) to.blocked = true;
      if (from.checked && from.checked.key === key && !to.checked && to.keys.length && to.keys[to.keys.length - 1].key === key) to.checked = from.checked;
      delete s.profiles[aid]; delete s.convos[aid];
      if (!own(s.convos, id)) s.convos[id] = { id, kind: "direct", title: name, members: [{ name }], created: Date.now() };
    });
    return id;
  }
  /** A message's conversation, after merges. */
  thread(id) { const a = own(this.store.aliases, id); return a ? convoIdOf(a) : id; }

  // -- conversations --
  convo(id) {
    if (!id.startsWith("x:")) return own(this.store.convos, id) || null;
    // messages that claim a name but didn't come from its messaging address: a thread of their own, never
    // the real person's, keyed by the address they did come from (a request's never: those are in Requests)
    const m = this.shown().find(x => this.threadOf(x) === id);
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
      if (!own(s.convos, id)) s.convos[id] = { id, kind: "direct", title: name, members: [{ name }], created: Date.now() };
    });
    return id;
  }
  /** Starts (or opens) the direct chat with a messaging address that has no name. */
  async startAddress(key) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("That isn't a messaging address.");
    const aid = "k:" + key;
    if (own(this.store.aliases, aid)) return convoIdOf(own(this.store.aliases, aid));
    await this.mutate(s => {
      this.pinFirst(s, aid, key);
      if (!own(s.convos, aid)) s.convos[aid] = { id: aid, kind: "direct", title: shortFp(key), members: [{ name: null, key }], created: Date.now() };
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
  /** A member's messaging address that is on the Blocked list (block wins over a chat), or null. */
  blockedKeyOf(convo) {
    const b = this.store.blockedKeys || {};
    for (const m of convo.members || []) { const k = m.name ? this.pinned(m.name) : m.key; if (k && b[k]) return k; }
    return null;
  }
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
    this.sortFrom = Number.isSafeInteger(ri.data.sort_from) ? ri.data.sort_from : Infinity;   // an older server: the old rules
    for (const item of ri.data.items) {
      this.inAfter = Math.max(this.inAfter, item.n);
      const m = this.openIncoming(item);
      this.inbox.set(item.n, m);
      this.tags.set(item.n, ["c", "r", "d"].includes(item.k) ? item.k : "");
      if (m) fresh.push(m);
      changed = true;
    }
    const unread = new Set(ri.data.unread || []);
    if (unread.size !== this.unread.size || [...unread].some(n => !this.unread.has(n))) changed = true;
    this.unread = unread;
    // read the chain for names whose message came from an address not pinned for them, to tell a new
    // address from a stranger: only for people in your chats (and messages from before Requests). A stranger's
    // claimed name is never looked up here, so strangers can't make this phone work: Requests looks them up
    // when it is opened (checkRequests).
    // (over every message, not only new ones: a name the chain couldn't be asked about is tried again later)
    // one message that makes something here throw is set aside (this.bad), and the others go on
    const each = f => m => { try { return f(m); } catch (e) { this.bad.add(m.n); return false; } };
    let all = [...this.inbox.values()].filter(m => m && !this.bad.has(m.n));
    const unknown = [...new Set(all.filter(each(m => !isAddressId(m.sender) && !this.chainOf(m.sender)
      && !((this.profile(m.sender) || {}).keys || []).some(k => k.key === m.senderKey)
      && (m.n < this.sortFrom || this.isContactName(m.sender)))).map(m => m.sender))];
    for (const pid of unknown) {
      if (Date.now() - (this.failed.get(pid) || 0) < 30000) continue;
      try { await this.lookup(pid, false, true); this.failed.delete(pid); } catch (e) { this.failed.set(pid, Date.now()); }
    }
    if (await this.sortIncoming()) changed = true;
    all = this.storeOk ? all.filter(m => this.chatN.has(m.n) && !this.reqEver.has(m.n) && !this.wasDropped.has(m.n)) : [];
    // chats for people who wrote first: from before Requests, or someone already known (their chat was deleted
    // but the profile kept, or a contact's address writing under its name); only if the message is theirs, and
    // only from messages sorted into the chats (never one that was dropped or was ever a request)
    const newcomers = [...new Set(all.filter(each(m => m.kind === "direct" && this.trust(m) !== "unverified" && !this.convo(this.thread(m.convo)))).map(m => m.sender))];
    if (newcomers.length) {
      await this.mutate(s => {
        for (const pid of newcomers) try {
          const first = all.find(m => m.sender === pid && !this.bad.has(m.n) && this.trust(m) !== "unverified");
          if (!first) continue;
          const c = this.chainOf(pid);
          const id = convoIdOf(pid);
          if (own(s.convos, id)) continue;
          if (isAddressId(pid)) {
            if (!first.authentic) continue;               // an address that can't prove itself gets no chat
            this.pinFirst(s, pid, first.senderKey);
            s.convos[id] = { id, kind: "direct", title: shortFp(first.senderKey), members: [{ name: null, key: first.senderKey }], created: Date.now() };
          } else {
            this.pinFirst(s, pid, first.authentic && c && c.key === first.senderKey ? first.senderKey : null);
            s.convos[id] = { id, kind: "direct", title: pid, members: [{ name: pid }], created: Date.now() };
          }
        } catch (e) { for (const m of all) if (m.sender === pid) this.bad.add(m.n); }
      }, true);
    }
    if (await this.lazyCheck()) changed = true;
    // a blocked sender's messages count as read straight away
    const quiet = fresh.filter(m => this.chatN.has(m.n) && !this.bad.has(m.n)).filter(each(m => this.unread.has(m.n) && this.convo(this.threadOf(m)) && this.isBlocked(this.convo(this.threadOf(m)))));
    if (quiet.length) await this.markRead(null, quiet.map(m => m.n));
    return changed;
  }

  // -- requests --
  /** Incoming messages shown in chats: opened, and not a request. */
  shown() { return [...this.inbox.values()].filter(m => m && this.chatN.has(m.n)); }
  /** Whether `name` is someone in your chats: a chat with it, or its profile with a pinned address. */
  isContactName(name) {
    if (isAddressId(name)) return false;
    const p = this.profile(name);
    return Boolean(own(this.store.convos, this.thread(convoIdOf(name))) || (p && p.keys && p.keys.length));
  }
  /** Every messaging address of someone in your chats: pinned in a profile, an address chat's, a merged one. */
  knownKeys() {
    const s = new Set();
    for (const p of Object.values(this.store.profiles)) for (const k of p.keys || []) s.add(k.key);
    for (const c of Object.values(this.store.convos)) for (const m of c.members || []) if (m.key) s.add(m.key);
    for (const a of Object.keys(this.store.aliases)) if (isAddressId(a)) s.add(a.slice(2));
    return s;
  }
  /**
   * Whether an incoming message goes to the chats (true) or to Requests (false). Chats: everything that came
   * before Requests; then only a message that proves its address (authentic) and either is from someone in your
   * chats under their name or address (any trust but "unverified"), or comes from an address that is a contact's.
   */
  fromContact(m, keys = this.knownKeys()) {
    if (m.n < this.sortFrom) return true;
    if (!m.authentic) return false;
    if (this.trust(m) !== "unverified") {
      if (own(this.store.convos, this.thread(convoIdOf(m.sender)))) return true;
      if (isAddressId(m.sender) ? Boolean(this.profile(m.sender)) : this.isContactName(m.sender)) return true;
    }
    return keys.has(m.senderKey);
  }
  /**
   * How a request's sender shows: "name" (an authentic message from the address that LNS name has on chain),
   * "address" (an authentic message from a messaging address, no name), "claim" (authentic, names a name the
   * chain doesn't give this address for, or that wasn't read yet: `chainRead` false), "none" (can't prove its
   * address: anyone could have written it).
   */
  proofOf(m) {
    if (!m.authentic) return { proof: "none", claimed: isAddressId(m.sender) ? null : m.sender };
    if (isAddressId(m.sender)) return { proof: "address" };
    const c = this.chain.get(m.sender);
    if (c && c.key === m.senderKey) return { proof: "name", name: m.sender, lookalike: this.lookalike(m.sender) };
    return { proof: "claim", claimed: m.sender, chainRead: Boolean(c) };
  }
  /**
   * The name of someone in your chats that `name` could be mistaken for (another name that reads the same: rn/m,
   * vv/w, 1/l/i, 0/o, hyphens; or one letter added, removed or changed in a name of 4 or more), or null.
   */
  lookalike(name) {
    const skel = x => x.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[1i]/g, "l").replace(/0/g, "o").replace(/-/g, "");
    const near = (a, b) => {                   // edit distance at most 1
      if (Math.abs(a.length - b.length) > 1) return false;
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
    };
    const mine = new Set([...Object.values(this.store.convos).flatMap(c => (c.members || []).map(m => m.name).filter(Boolean)),
      ...Object.keys(this.store.profiles).filter(p => !isAddressId(p) && (this.profile(p).keys || []).length)]);
    for (const c of mine) if (c !== name && (skel(c) === skel(name) || (Math.min(c.length, name.length) >= 4 && near(c, name)))) return c;
    return null;
  }
  /**
   * Sorts what came in: chats, requests, and what is deleted unread. Deleted (from the server, unread, counted
   * by reason in the store): an unopenable message the server hadn't sorted yet ("unreadable"); a request from a
   * blocked address ("blocked"), from anyone while "Only people I've written to" is on ("only": except one that
   * names someone in your chats while the chain couldn't be read, so a contact's new phone isn't lost), over the
   * caps ("caps"), older than REQ.AGE_MS ("age"). The server is told which are chats and which are requests (a
   * request is marked read there: it never counts). Returns whether anything changed.
   */
  async sortIncoming() {
    if (!this.storeOk) {                     // no good store this session: decide nothing, show only chat messages
      this.chatN = new Set([...this.inbox.keys()].filter(n => this.tags.get(n) === "c" && this.inbox.get(n)));
      this.reqs = []; this.held = new Set();
      return false;
    }
    const keys = this.knownKeys(), drop = new Map(), toChat = [], cands = [], chatN = new Set();
    const blocked = this.store.blockedKeys || {}, only = Boolean((this.store.req || {}).onlyKnown), now = Date.now();
    for (const [n, m] of this.inbox) try {                // one message that throws is set aside, the rest go on
      if (this.bad.has(n)) continue;
      const tag = this.tags.get(n) || "";
      // a blocked address is hidden even when it is a contact's (block wins over a chat); kept, not dropped
      const hide = Boolean(m && m.authentic && blocked[m.senderKey]);
      if (tag === "c") { if (m && !hide) chatN.add(n); continue; }      // a chat message stays one, whatever else changed
      if (tag === "d") {                     // dropped (the server deletes it after a grace period): back only if
        this.dropping.delete(n);
        if (m && !hide && this.fromContact(m, keys)) { chatN.add(n); toChat.push(n); this.wasDropped.add(n); }   // it is a contact's
        continue;
      }
      if (this.dropping.has(n)) { drop.set(n, null); continue; }      // dropped before: stays dropped (tell the server again)
      if (!m) { if (n >= this.sortFrom && !tag && !this.own.has(n)) drop.set(n, "unreadable"); continue; }
      if (this.fromContact(m, keys)) { if (!hide) chatN.add(n); toChat.push(n); continue; }
      if (tag === "r") this.reqEver.add(n);
      cands.push(m);
    } catch (e) { this.bad.add(n); }
    for (const n of this.dropping) if (!this.inbox.has(n)) this.dropping.delete(n);    // gone from the server already
    const groups = new Map();
    for (const m of cands.sort((a, b) => a.n - b.n)) try {
      const pr = this.proofOf(m);
      if (blocked[m.senderKey]) { drop.set(m.n, "blocked"); continue; }
      if (only && !(pr.proof === "claim" && !pr.chainRead && this.isContactName(m.sender))) { drop.set(m.n, "only"); continue; }
      if (now - m.received > REQ.AGE_MS) { drop.set(m.n, "age"); continue; }
      const gid = (m.authentic ? "a:" : "u:") + m.senderKey;      // one that can't prove its address is never mixed with one that can
      const g = groups.get(gid) || groups.set(gid, { id: gid, key: m.senderKey, authentic: m.authentic, list: [] }).get(gid);
      if (g.list.length >= REQ.PER_SENDER) { drop.set(m.n, "caps"); continue; }
      g.list.push(m);
    } catch (e) { this.bad.add(m.n); }
    // a request shows as its first message's sender; ranked: a proven name 2, any other authentic one 1, else 0
    const reqs = [...groups.values()].flatMap(g => { try {
      const pr = this.proofOf(g.list[0]);
      return [Object.assign(g, { name: null, claimed: null, chainRead: true }, pr, { rank: !g.authentic ? 0 : pr.proof === "name" ? 2 : 1,
        first: g.list[0].n, at: g.list[g.list.length - 1].received, size: g.list.reduce((s, m) => s + (m.size || 0), 0) })];
    } catch (e) { for (const m of g.list) this.bad.add(m.n); return []; } });
    reqs.sort((a, b) => b.rank - a.rank || b.first - a.first);
    // A message naming a name not read on chain yet is never dropped by the caps: it may be a real LNS name,
    // which ranks above addresses (lazyCheck reads such names, a few at a time, while the caps are under
    // pressure). The server's own ring still bounds what all of them can hold.
    const unread = g => g.authentic && g.proof === "claim" && !g.chainRead;
    let bytes = 0, counted = 0;
    this.reqs = [];
    for (const g of reqs) {
      if (unread(g)) { this.reqs.push(g); continue; }
      if (counted >= REQ.SENDERS || bytes + g.size > REQ.BYTES) { for (const m of g.list) drop.set(m.n, "caps"); continue; }
      bytes += g.size; counted++; this.reqs.push(g);
    }
    this.pressure = reqs.length > REQ.SENDERS || reqs.reduce((t, g) => t + g.size, 0) > REQ.BYTES;
    this.reqs.sort((a, b) => b.first - a.first);
    this.held = new Set(this.reqs.flatMap(g => g.list.map(m => m.n)));
    for (const n of this.held) this.reqEver.add(n);
    // decided, before anything is sent to the server: only these show in the chats or count as unread
    this.chatN = chatN;
    const toReq = [...this.held].filter(n => this.tags.get(n) !== "r");
    let changed = false;
    if (drop.size) {
      const counts = {};
      for (const [n, why] of drop) {
        if (why && !this.dropping.has(n) && why !== "unreadable") counts[why] = (counts[why] || 0) + 1;   // counted once
        this.dropping.add(n); this.unread.delete(n);
      }
      // not inbox/delete: no user action. Whatever the server answers, the decision stands (dropping).
      const r = await this.bgApi("/api/messages/inbox/sort", { drop: [...drop.keys()] });
      if (r.ok) for (const n of drop.keys()) { this.tags.set(n, "d"); this.dropping.delete(n); }
      const keep = [...this.dropping].slice(-2000), had = ((this.store.req || {}).dropping || []).length;
      if (Object.keys(counts).length || had || keep.length) {
        try {
          await this.mutate(s => {
            const q = s.req = Object.assign({}, s.req); q.dropped = Object.assign({}, q.dropped);
            for (const [k, v] of Object.entries(counts)) q.dropped[k] = (q.dropped[k] || 0) + v;
            if (keep.length) q.dropping = keep; else delete q.dropping;     // until the server has deleted them
          }, true);
        } catch (e) {}                           // kept in memory; saved with the next change
      }
      changed = true;
    }
    if (toChat.length || toReq.length) {
      const r = await this.bgApi("/api/messages/inbox/sort", { chat: toChat, request: toReq });
      if (r.ok) { for (const n of toChat) this.tags.set(n, "c"); for (const n of toReq) { this.tags.set(n, "r"); this.unread.delete(n); } }
    }
    return changed;
  }
  /** The requests, newest first: { id, key, authentic, proof, name, claimed, chainRead, list, at, size }. */
  requests() { return this.reqs; }
  /**
   * While the request caps are under pressure (more senders or bytes than they keep), reads on chain the oldest
   * name a request claims that wasn't read yet, so a real LNS name ranks above addresses before anything is
   * dropped. At most one such read (an Argon2 derivation) every 15 s, in the background; none otherwise.
   */
  async lazyCheck() {
    if (!this.storeOk || !this.pressure || Date.now() - (this.lastLazy || 0) < 15000) return false;
    const g = this.reqs.filter(x => x.authentic && x.proof === "claim" && !x.chainRead && Date.now() - (this.failed.get(x.claimed) || 0) >= 30000)
      .sort((a, b) => a.first - b.first)[0];
    if (!g) return false;
    this.lastLazy = Date.now();
    try { await this.lookup(g.claimed, false, true); this.failed.delete(g.claimed); } catch (e) { this.failed.set(g.claimed, Date.now()); return false; }
    await this.sortIncoming();
    return true;
  }
  /** How many messages "Only people I've written to", Block and the caps deleted unread, by reason. */
  dropped() { return Object.assign({ blocked: 0, only: 0, caps: 0, age: 0 }, (this.store.req || {}).dropped); }
  /** Reads from the chain the names that requests claim (at most `limit` not read yet), to show which are proven. */
  async checkRequests(limit = 10, keepGoing = () => true) {
    const names = [...new Set(this.reqs.filter(g => g.authentic && g.proof === "claim" && !g.chainRead).map(g => g.claimed))].slice(0, limit);
    let any = false;
    for (const name of names) {                // one at a time; stops when Requests is closed (keepGoing)
      if (!keepGoing()) break;
      if (Date.now() - (this.failed.get(name) || 0) < 30000) continue;
      try { await this.lookup(name, false, true); this.failed.delete(name); any = true; } catch (e) { this.failed.set(name, Date.now()); }
    }
    if (any) await this.sortIncoming();
    return any;
  }
  async setOnlyKnown(on) { await this.mutate(s => { s.req = Object.assign({}, s.req, { onlyKnown: Boolean(on) }); }); await this.sortIncoming(); }
  onlyKnown() { return Boolean((this.store.req || {}).onlyKnown); }
  /**
   * Accepts a request: a chat with the proven name, or with the messaging address. A message that claims a
   * name it doesn't prove, or can't prove its address, can't be accepted (Delete or Block it).
   */
  async acceptRequest(id) {
    const g = this.reqs.find(x => x.id === id);
    if (!g) throw new Error("That request isn't there any more.");
    let cid;
    if (g.proof === "name") {
      const c = await this.lookup(g.name, true);
      if (c.key !== g.key) throw new Error(g.name + "'s messaging address on chain isn't the one this came from.");
      cid = convoIdOf(g.name);
      await this.mutate(s => {
        this.pinFirst(s, g.name, g.key);
        if (!own(s.convos, cid)) s.convos[cid] = { id: cid, kind: "direct", title: g.name, members: [{ name: g.name }], created: Date.now() };
      });
    } else if (g.proof === "address") {
      cid = "k:" + g.key;
      await this.mutate(s => {
        this.pinFirst(s, cid, g.key);
        if (!own(s.convos, cid)) s.convos[cid] = { id: cid, kind: "direct", title: shortFp(g.key), members: [{ name: null, key: g.key }], created: Date.now() };
      });
    } else throw Object.assign(new Error("This one doesn't prove who sent it, so it can't become a chat."), { code: "unproven" });
    await this.sortIncoming();
    return this.thread(cid);
  }
  /** Deletes a request's messages from this phone. */
  async deleteRequest(id) {
    const g = this.reqs.find(x => x.id === id);
    if (!g) return;
    const ns = g.list.map(m => m.n);
    const r = await this.api("/api/messages/inbox/delete", { ids: ns });
    if (r.ok) for (const n of ns) { this.inbox.delete(n); this.tags.delete(n); }
    await this.sortIncoming();
  }
  /** Blocks a request's messaging address (only one that proves it: anyone can write any address into a message). */
  async blockRequest(id) {
    const g = this.reqs.find(x => x.id === id);
    if (!g) return;
    if (!g.authentic) throw new Error("This one doesn't prove its address, so blocking it would block nobody.");
    await this.mutate(s => {
      const b = s.blockedKeys = dict(s.blockedKeys);
      b[g.key] = { at: Date.now(), name: g.proof === "name" ? g.name : null, claimed: g.proof === "claim" ? g.claimed : null };
      const ks = Object.keys(b);
      if (ks.length > BLOCKED_MAX) for (const k of ks.sort((x, y) => b[x].at - b[y].at).slice(0, ks.length - BLOCKED_MAX)) delete b[k];
    });
    await this.sortIncoming();
  }
  /** Everyone blocked: addresses blocked from Requests, and people in your chats blocked on their profile. */
  blockedList() {
    const out = Object.entries(this.store.blockedKeys || {}).map(([key, b]) => ({ kind: "key", key, at: b.at, name: b.name || null, claimed: b.claimed || null }));
    for (const [pid, p] of Object.entries(this.store.profiles)) if (p.blocked) out.push({ kind: "profile", pid, at: p.updated || 0 });
    return out.sort((a, b) => b.at - a.at);
  }
  async unblock(entry) {
    if (entry.kind === "profile") return this.setProfile(entry.pid, { blocked: false });
    await this.mutate(s => { s.blockedKeys = dict(s.blockedKeys); delete s.blockedKeys[entry.key]; });
  }

  openIncoming(item) {
    let raw;
    try { raw = unb64(item.payload); } catch (e) { return null; }
    const msg = openMessage(this.me.secret, raw);
    if (!msg) return null;
    // a copy of something this device sent (a note to self, or a node handing back its own message)
    for (const o of this.outbox.values()) if (o.ids.includes(msg.id)) { this.own.add(item.n); return null; }
    const received = Date.parse(item.received) || Date.now();
    // "msg-<16 hex>" is the stand-in of a sender with no name; it must be the sender's own address, or the
    // message is someone pretending (it is shown as unverified, and starts no chat)
    const shaped = /^msg-[0-9a-f]{16}$/.test(msg.from);
    // one identity per key (canonKey); a key that isn't a point of the curve proves nothing
    const senderKey = canonKey(msg.fromKey), proven = msg.authentic && onCurve(senderKey);
    const pid = shaped ? "k:" + senderKey : msg.from;
    return { key: "i:" + item.n, n: item.n, dir: "in", kind: "direct", convo: convoIdOf(pid), sender: pid,
             senderKey, authentic: proven && (!shaped || msg.from === nameless(senderKey)), id: msg.id, text: msg.text,
             ts: Math.min(msg.ts, received + 300000), received, source: item.source || null, size: raw.length };
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
    for (const m of [...this.shown(), ...this.outbox.values()]) {
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
    const strangers = [...new Set(this.shown().filter(m => this.threadOf(m).startsWith("x:")).map(m => this.threadOf(m)))];
    for (const convo of [...Object.values(this.store.convos), ...strangers.map(id => this.convo(id))]) {
      const list = this.messages(convo.id);
      const last = list[list.length - 1] || null;
      const unread = list.filter(m => m.dir === "in" && this.unread.has(m.n)).length;
      out.push({ convo, last, unread, title: this.title(convo), muted: this.isMuted(convo), blocked: this.isBlocked(convo) || Boolean(this.blockedKeyOf(convo)),
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
  async sendBlocker(id, fresh = false, bg = false) {
    const convo = this.convo(id);
    if (!convo) return { code: "gone", text: "This chat was deleted." };
    if (convo.unverified) return { code: "unverified", text: "These messages didn't come from " + (isAddressId(convo.claimed) ? "the address they name" : convo.claimed + "'s messaging address") + ", so you can't reply here." };
    if (this.isBlocked(convo)) { const pid = this.peer(convo); return { code: "blocked", name: pid, text: "You blocked " + this.label(pid) + "." }; }
    const bk = this.blockedKeyOf(convo);
    if (bk) return { code: "blocked-key", key: bk, text: "You blocked this messaging address." };
    for (const m of convo.members) {
      if (!m.name) continue;                              // an address: nothing to check on chain
      const name = m.name;
      let c;
      try { c = await this.lookup(name, fresh, bg); } catch (e) { return { code: "offline", name, text: "Couldn't reach the name service." }; }
      if (!c.registered) return { code: "unregistered", name, text: name + " isn't a registered name any more." };
      if (!c.key) return { code: "nokey", name, text: name + " has turned off messages." };
      const pinned = this.pinned(name);
      if (pinned && pinned !== c.key) return this.isChecked(name)
        ? { code: "changed-checked", name, text: name + "'s messaging address changed since you checked it." }
        : { code: "changed", name, text: name + "'s messaging address changed." };
    }
    return null;
  }
  /**
   * The address to seal to for each member, checked again synchronously right before sealing: the convo still
   * there and not blocked; for a name, its pinned address (or, at first contact, the one just read on chain),
   * and the chain's current reading still that same address. Throws { code } like sendBlocker otherwise.
   * (A retry resends the payload sealed at the time; nothing is sealed again.)
   */
  sendTargets(id) {
    const convo = this.convo(id), fail = (code, text) => { throw Object.assign(new Error(text), { code }); };
    if (!convo) fail("gone", "This chat was deleted.");
    if (convo.unverified) fail("unverified", "You can't reply here.");
    if (this.isBlocked(convo)) fail("blocked", "You blocked " + this.label(this.peer(convo)) + ".");
    if (this.blockedKeyOf(convo)) fail("blocked-key", "You blocked this messaging address.");
    return convo.members.map(m => {
      if (!m.name) return { name: null, key: m.key };
      const c = this.chain.get(m.name), pinned = this.pinned(m.name);
      if (!c || !c.registered || !c.key) fail("offline", "Couldn't read " + m.name + " from the name service.");
      if (pinned && c.key !== pinned) fail(this.isChecked(m.name) ? "changed-checked" : "changed", m.name + "'s messaging address changed.");
      return { name: m.name, key: pinned || c.key };
    });
  }
  /** Seals `text` to every member, keeps an encrypted copy, and hands both to the server's sender. */
  async send(id, text) {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw new Error("A message is 1 to " + MAX_TEXT + " characters.");
    const why = await this.sendBlocker(id);
    if (why) throw Object.assign(new Error(why.text), { code: why.code });
    if (this.me.name) { try { await this.lookup(this.me.name); } catch (e) {} }
    // From here to the last seal nothing awaits: the check sees exactly the state the seals use, so a chain read
    // finishing meanwhile (opening the chat, a sync) can't slip a new, unaccepted address in.
    const targets = this.sendTargets(id);
    const ts = Date.now(), to = [], ids = [], sends = [], from = this.fromName();
    for (const { name, key } of targets) {
      const sealed = sealPadded({ to: fromHex(key), from, fromSecret: this.me.secret, text, ts });
      to.push({ name: name || null, key }); ids.push(toHex(sealed.subarray(1, 33)));
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
    const ins = this.shown().filter(m => this.threadOf(m) === id).map(m => m.n);
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

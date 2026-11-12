// NOT SHIPPED (groups engine). Group chats between LNS names on MLS (RFC 9420, ts-mls 1.6.4 in ./mls.js), with
// one admin who makes every commit. No UI here: the page calls the functions below and listens to events.
// Spec: GROUPS-PLAN.md sections 6 and 10 (where they disagree, 10 wins). Paths assume app/messages/.
//
// Pinned to ts-mls 1.6.4. Behaviour this file depends on, to re-test on any version bump (tests/groups_test.mjs
// and tests/mls/ cover each):
//   - joinGroup rejects a valid Welcome after add-only commits once parent nodes have unmerged leaves (#860):
//     worked around by an empty admin commit before an Add whenever any parent node has unmerged leaves.
//   - applyProposals runs before the IncomingMessageCallback (#857 throws a TypeError there): every library
//     exception is caught and the message dropped and counted.
//   - external commits are PublicMessages and may remove anyone (#859): processPublicMessage is never called.
//   - epochs leaving the 4-epoch window are not zeroed in memory (#856): see wipeState() and the notes there.
//   - processPrivateMessage does not say who sent an application message: the sender comes from
//     internals["privateMessage.js"].decryptSenderData (an internal of 1.6.4, exported by our bundle).
//   - a commit that removes a leaf and adds a new one into the same slot is not seen as a removal by the removed
//     device (selfRemoved = "my slot is blank afterwards"): re-adds remove in one commit and add in the next.
//   - joinGroup returns the signature private key it was given BY REFERENCE inside the new state; the engine
//     only ever hands ts-mls copies of the device seed (seedCopy()).
//   - ts-mls enforces unique keys in the tree, not unique identities: the engine flags duplicate names itself.
//   - the admin is leaf 0 (the creator's leaf; nothing ever removes it).
//
// Security notes (what this design does and does not promise; the UI should say the parts users need):
//   - The name record is the identity. A member is "alice" because the chain says alice's `msg` key is the key of
//     that leaf. Whoever controls alice's msg record (a new device, or a new owner after a name transfer) can ask
//     to be re-added and the admin's device does it by itself, removing the old leaf.
//   - The admin is trusted for membership. A malicious admin can add anyone, send different commits or topics to
//     different members (split the group), and members can't detect it. Members do check every leaf against the
//     chain and flag duplicate or malformed identities, so a hidden extra leaf under someone's name shows up.
//   - If the admin's device is lost, the group can still talk but nobody can change its members.
//   - Private keys live in the page-encrypted state blob: the device seed inside every group's encoded MLS state,
//     and the HPKE private keys of joins in progress. They are protected only by the page's cipher. Strings
//     (base64 in the blob) can't be zeroed; wipeState() zeroes what decoded state it can reach (#856 limit:
//     epochs that already left ts-mls's 4-epoch window stay in memory until garbage collection).
//   - What relays see: the group topic (one stable topic per group between removals; it changes on every
//     remove), the group id, the epoch, the content type (message or commit) and sizes, in clear in every MLS
//     PrivateMessage. Inbox topics are computed from public keys, so anyone can see who receives control traffic.
//     A backup holds the group list (names of members and admins) in the clear inside the app's backup.
//   - No freshness check on v2 control messages beyond the seen list and the request ids they carry.
//   - "Verified" (a leaf's key = its name's msg on the chain) is rechecked on every commit, not continuously.
//   - Two tabs are safe only if storage.write is an atomic compare-and-swap across them (server.py's rev check).
import * as mls from "./mls.js";
import { appCryptoProvider } from "./mls-provider.js";
import { ed25519 } from "../noble-curves/ed25519.js";
import { sha256 } from "./noble-hashes/sha2.js";
import { sealMessage, inboxTopic, MAX_TEXT } from "./msg-crypto.js";
import { sealControl, openControl, b64, unb64 } from "./msg-v2.js";

export const LIMITS = Object.freeze({
  members: 32, // leaves + invites not answered yet
  textChars: MAX_TEXT, // 2,000, as in 1:1
  groups: 20, // groups this device is in, plus joins in progress
  groupNameChars: 64,
  payloadBytes: 65536, // group topic messages and sealed control messages
  holdAhead: 2, // messages are held only for the next 2 epochs (they can't be checked before their commit)
  held: 200, // held messages per group, at most...
  heldBytes: 512 * 1024, // ...and this many bytes (base64); the oldest go first
  commitLog: 64, // commits the admin keeps for resends
  resendCommits: 32, // at most this many commits in one resend answer
  outboxBytes: 1024 * 1024, // above this, the admin stops answering resend requests until it has posted
  seen: 4000, // message ids remembered per group (and for the inbox)
  invites: 50, // invitations kept waiting for an answer, in all...
  invitesPerSender: 3, // ...and per sender key
});
export const STATE_VERSION = 2;
const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
const FRAME = 0x47; // "G": group topic payload = 0x47 ‖ MLSMessage
const ADMIN_LEAF = 0;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ADDR_RE = /^k:[0-9a-f]{64}$/;
const NAMELESS_RE = /^msg-[0-9a-f]{16}$/;
const DEFAULT_TIMINGS = {
  resendAfterMs: 120_000, // held messages this old: ask the admin for the missing commits
  resendGapMs: 60_000, // first gap between two resend requests for one group; doubles each time, to 1 h
  resendServeGapMs: 60_000, // the admin answers one resend request per member per minute
  needsReaddAfterMs: 7 * 86_400_000, // still behind after this long: say the admin must re-add this device
  heldTtlMs: 8 * 86_400_000, // held messages older than this are dropped
  adminRefreshMs: 86_400_000, // the admin commits a path (self-update) at most this often
  topicGraceMs: 7 * 86_400_000, // after a topic change, the old topic is still read (and commits posted there)
  inviteTtlMs: 30 * 86_400_000,
  rejoinKeyChangeGapMs: 86_400_000, // re-adds for a proven key change: one per member per day
  rejoinRestoreGapMs: 7 * 86_400_000, // re-adds for a restore with the same key: one per member per week
};

/** Errors the UI can show: err.code is one of the codes below. */
export class GroupError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}
export const ERRORS = {
  LIMIT_MEMBERS: "A group has at most 32 members.",
  LIMIT_GROUPS: "This device can be in at most 20 groups.",
  TEXT_TOO_LONG: "A message has at most 2,000 characters.",
  EMPTY_TEXT: "The message is empty.",
  BAD_GROUP_NAME: "A group name has 1 to 64 characters.",
  BAD_MEMBER: "That isn't an LNS name or a messaging address.",
  NO_MSG_KEY: "That name has no messaging address.",
  KEY_CHANGED: "That name's messaging address changed.",
  UNKNOWN_GROUP: "No such group on this device.",
  UNKNOWN_INVITE: "No such invitation.",
  NOT_ADMIN: "Only the group's admin can do that.",
  NOT_ACTIVE: "You are no longer in this group.",
  NOT_MEMBER: "That person isn't in the group.",
  ALREADY_MEMBER: "Already in the group.",
  ADMIN_CANNOT_LEAVE: "The admin can't leave a group (delete it on this device instead).",
  STATE_CONFLICT: "Groups changed in another tab; try again.",
  RESOLVER_UNAVAILABLE: "Names can't be checked right now; try again.",
  UNSUPPORTED: "Groups need a newer Android System WebView.",
};
const fail = (code) => {
  throw new GroupError(code, ERRORS[code]);
};

// ---------- small helpers ----------
const te = new TextEncoder();
const td = new TextDecoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const eqBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const hashHex = (bytes) => hex(sha256(bytes)).slice(0, 16); // seen-message ids: 64 bits is plenty per group
const concat = (...p) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
export const topicOf = (topicKey) => `/names/1/g-${hex(sha256(concat(te.encode("names/group/v1/topic"), topicKey))).slice(0, 16)}/proto`;
const leafMsgKey = (leaf) => ed25519.utils.toMontgomery(leaf.signaturePublicKey);
const leafPid = (leaf) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(leaf.credential.identity);
  } catch {
    return "�";
  }
};
function leaves(state) {
  const out = [];
  state.ratchetTree.forEach((n, i) => {
    if (n?.nodeType === "leaf") out.push({ index: i / 2, pid: leafPid(n.leaf), key: leafMsgKey(n.leaf) });
  });
  return out;
}
/** A well-formed identity: an LNS name, or "k:<hex>" whose hex is that leaf's own key. */
const wellFormed = (pid, key) => (NAME_RE.test(pid) && !NAMELESS_RE.test(pid)) || (ADDR_RE.test(pid) && pid.slice(2) === hex(key));
const needsPathFirst = (state) => state.ratchetTree.some((n) => n?.nodeType === "parent" && n.parent.unmergedLeaves.length > 0);
const pushCapped = (arr, x, cap) => {
  arr.push(x);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
};

/** A member as the API takes it: "alice", "k:<64 hex>", "msg:<64 hex>" or 64 hex -> "alice" | "k:<hex>". */
export function normalizeMember(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (ADDR_RE.test(s)) return s;
  const m = s.match(/^(?:msg:)?([0-9a-f]{64})$/);
  if (m) return "k:" + m[1];
  if (NAME_RE.test(s) && !NAMELESS_RE.test(s)) return s;
  fail("BAD_MEMBER");
}

const clientConfig = {
  keyRetentionConfig: mls.defaultKeyRetentionConfig,
  lifetimeConfig: mls.defaultLifetimeConfig,
  keyPackageEqualityConfig: mls.defaultKeyPackageEqualityConfig,
  paddingConfig: mls.defaultPaddingConfig,
  authService: mls.defaultAuthenticationService,
};
// Accept only commits from the admin's leaf; refuse every proposal (this protocol never commits by reference).
const ONLY_ADMIN_COMMITS = (x) => (x.kind === "commit" && x.senderLeafIndex === ADMIN_LEAF ? "accept" : "reject");

/** Zeroes what can be zeroed in a decoded group state (secrets of every epoch it still holds). #856: epochs that
 * already left the window were dropped by ts-mls without zeroing and can't be reached from here; they stay in
 * memory until garbage collection. Strings (the stored base64) can't be zeroed at all. `keep` is a buffer that
 * must not be touched even if the state holds it (the engine passes its own seed). */
export function wipeState(state, keep) {
  const z = (b) => b instanceof Uint8Array && b !== keep && (!keep || b.buffer !== keep.buffer) && b.fill(0);
  const tree = (t) => (t ?? []).forEach((n) => n && [n.application, n.handshake].forEach((g) => g && (z(g.secret), Object.values(g.unusedGenerations ?? {}).forEach(z))));
  try {
    Object.values(state.keySchedule ?? {}).forEach(z);
    tree(state.secretTree);
    Object.values(state.privatePath?.privateKeys ?? {}).forEach(z);
    for (const h of state.historicalReceiverData?.values?.() ?? []) {
      tree(h.secretTree);
      z(h.senderDataSecret);
      z(h.resumptionPsk);
    }
    z(state.signaturePrivateKey); // the engine only ever hands ts-mls copies of the seed
  } catch {
    /* best effort */
  }
}

/** What this WebView offers for groups. provider "app" (default) needs X25519, HMAC-SHA256 and AES-GCM in
 * WebCrypto (Chrome/WebView 133+); "default" (ts-mls's own) also needs Ed25519 (137+). */
export async function checkCapabilities(provider = "app") {
  const s = globalThis.crypto?.subtle;
  const missing = [];
  const probe = async (name, fn) => {
    try {
      if ((await fn()) === false) missing.push(name);
    } catch {
      missing.push(name);
    }
  };
  if (!s) missing.push("crypto.subtle (needs a secure context such as http://127.0.0.1)");
  else {
    await probe("X25519", async () => {
      const a = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      const b = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      return (await s.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256)).byteLength === 32;
    });
    await probe("HMAC-SHA256", async () => {
      const k = await s.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return (await s.sign("HMAC", k, new Uint8Array(1))).byteLength === 32;
    });
    await probe("AES-GCM", async () => {
      const k = await s.importKey("raw", new Uint8Array(16), { name: "AES-GCM" }, false, ["encrypt"]);
      return (await s.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: new Uint8Array(1) }, k, new Uint8Array(1))).byteLength === 17;
    });
    if (provider === "default")
      await probe("Ed25519", async () => {
        const kp = await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        return s.verify("Ed25519", kp.publicKey, await s.sign("Ed25519", kp.privateKey, new Uint8Array(1)), new Uint8Array(1));
      });
  }
  return { ok: missing.length === 0, provider, missing, message: missing.length ? ERRORS.UNSUPPORTED : "" };
}

const emptyData = (me) => ({ v: STATE_VERSION, me, groups: {}, invites: {}, joins: {}, rejoin: {}, outbox: [], seen: [] });
const joinKey = (gid, adminKey) => `${gid}:${adminKey}`;

/**
 * createGroupEngine({ me, transport, resolver, storage, cipher, provider, now, timings }) -> engine
 *   me        { name: "alice" or "", seed: Uint8Array(32) }   the device's Ed25519 seed; its X25519 form is `msg`.
 *             The engine keeps its own copy and never writes to the caller's buffer.
 *   transport { post(topic, bytes): Promise, subscribe(topics[]): Promise, unsubscribe(topics[]): Promise }
 *             post resolves once the node took the message and throws if it didn't (the engine retries on tick).
 *             The caller hands every payload from the inbox and from engine.topics() to engine.incomingMany().
 *   resolver  { msgKey(name): Promise<Uint8Array(32) | null> }   the `msg` entry of an LNS name, from the chain;
 *             null = the name has none; throwing = can't tell now (the engine retries or shows "unknown").
 *   storage   { read(): Promise<{ version, blob } | null>, write(blob, baseVersion): Promise<{ ok, version }> }
 *             write must refuse (ok: false) unless baseVersion is the stored version (compare-and-swap)
 *   cipher    { encrypt(bytes): Promise<bytes>, decrypt(bytes): Promise<bytes> }   the page's own encryption
 */
export async function createGroupEngine(opts) {
  const e = new GroupEngine(opts);
  await e._init();
  return e;
}

class GroupEngine {
  constructor({ me, transport, resolver, storage, cipher, provider = "app", now = () => Date.now(), timings = {}, workaround860 = true }) {
    if (!(me?.seed instanceof Uint8Array) || me.seed.length !== 32) throw new Error("me.seed must be 32 bytes");
    this.seed = me.seed.slice(); // our own copy; ts-mls only ever gets copies of this one (seedCopy)
    this.sigPub = ed25519.getPublicKey(this.seed);
    this.msgKey = ed25519.utils.toMontgomery(this.sigPub);
    this.msgSecret = ed25519.utils.toMontgomerySecret(this.seed);
    this.keyHex = hex(this.msgKey);
    this.name = me.name ? normalizeMember(me.name) : "";
    if (ADDR_RE.test(this.name)) this.name = "";
    this.pid = this.name || "k:" + this.keyHex;
    this.from = this.name || "msg-" + this.keyHex.slice(0, 16); // `from` in sealed messages
    this.inbox = inboxTopic(this.msgKey);
    Object.assign(this, { transport, resolver, storage, cipher, now });
    this.providerName = provider;
    this.workaround860 = workaround860; // false only in the test that shows what #860 does without it
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.version = null;
    this.data = null;
    this.counts = {}; // dropped/refused counters: memory only, so hostile input never causes a state write
  }
  seedCopy() {
    return this.seed.slice();
  }

  // ---------- events ----------
  /** onEvent(cb) -> unsubscribe. Events (plain objects; member ids are "alice" or "k:<64 hex>"):
   *   created {groupId, name}                  joined {groupId, name, admin, adminVerified}   left {groupId}
   *   invite {inviteId, groupId, groupName, from, claimedName?, verified}   -> acceptInvite / declineInvite
   *   invite-sent {groupId, member}            invite-failed {groupId, member, code}
   *   message {groupId, from, address, text, ts, late, verified, formerMember, suspicious}
   *          late: opened after its epoch closed; formerMember: its sender's leaf is no longer in the group
   *   members {groupId, added[], removed[], members[]}           renamed {groupId, name}
   *   member-suspicious {groupId, leaf, member, duplicate, malformed}   (two leaves with one name, or a bad name)
   *   removed {groupId}   (this device was removed)               key-changed {groupId, member}
   *   topic-changed {groupId}                  catching-up {groupId} / caught-up {groupId}
   *   missed-messages {groupId, count, epoch}  needs-readd {groupId, reason}
   *   rejoin-request {groupId, member, reason} (admin; it re-adds by itself, rate-limited)
   *   rejoin-requested {groupId, name, admin}  admin-lost {groupId, name} (restored admin: the group can't change)
   *   dropped {code}   (refused or unreadable input; at most one per code per batch; never content)
   *   state-reloaded {} (another tab wrote) */
  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  _emit(ev) {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch {
        /* a listener's problem */
      }
    }
  }

  // ---------- state ----------
  async _init() {
    const provider = this.providerName === "default" ? mls.defaultCryptoProvider : appCryptoProvider;
    this.impl = await provider.getCiphersuiteImpl(mls.getCiphersuiteFromName(SUITE));
    await this._reload();
    if (this.data.me.key !== this.keyHex) {
      // The device key was replaced: the old group states sign with the old key. Ask to be re-added.
      const backup = this._backupOf(this.data);
      this.data = emptyData({ pid: this.pid, key: this.keyHex });
      await this.importBackup(backup);
    }
    const topics = this.topics();
    if (topics.length) await this.transport.subscribe(topics).catch(() => {});
  }
  async _reload() {
    const r = await this.storage.read();
    if (!r) {
      this.version = 0;
      this.data = emptyData({ pid: this.pid, key: this.keyHex });
      return;
    }
    this.version = r.version;
    const d = JSON.parse(td.decode(await this.cipher.decrypt(r.blob)));
    this.data = d?.v === STATE_VERSION ? d : emptyData({ pid: this.pid, key: this.keyHex });
  }
  async _write(d) {
    const blob = await this.cipher.encrypt(te.encode(JSON.stringify(d)));
    const r = await this.storage.write(blob, this.version);
    if (r?.ok) this.version = r.version;
    return !!r?.ok;
  }

  /** Runs fn(draft, ctx) on a copy of the state, saves it (compare-and-swap), and only then posts, subscribes
   * and emits. Nothing is written when fn changed nothing. On a conflict (another tab wrote first) it reloads and
   * runs fn again on the fresh state, up to 6 times with a short random pause; then STATE_CONFLICT. */
  _mutate(fn) {
    const run = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * attempt));
        const draft = structuredClone(this.data);
        const ctx = { posts: [], events: [], zero: [], subscribe: [], unsubscribe: [], dropped: new Set() };
        const result = await fn(draft, ctx);
        for (const p of ctx.posts) draft.outbox.push({ id: hex(rand(8)), topic: p.topic, b: b64(p.bytes) });
        const unchanged = !ctx.posts.length && JSON.stringify(draft) === JSON.stringify(this.data);
        if (unchanged || (await this._write(draft))) {
          this.data = draft;
          for (const b of ctx.zero) if (b instanceof Uint8Array && b.buffer !== this.seed.buffer) b.fill(0);
          if (ctx.subscribe.length) await this.transport.subscribe(ctx.subscribe).catch(() => {});
          if (ctx.unsubscribe.length) await this.transport.unsubscribe?.(ctx.unsubscribe).catch(() => {});
          await this._flush();
          for (const ev of ctx.events) this._emit(ev);
          return result;
        }
        await this._reload();
        this._emit({ type: "state-reloaded" });
      }
      fail("STATE_CONFLICT");
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Posts what the outbox holds, oldest first; stops at the first failure (kept for the next tick). */
  async _flush() {
    const sent = [];
    for (const item of this.data.outbox) {
      try {
        await this.transport.post(item.topic, unb64(item.b));
        sent.push(item.id);
      } catch {
        break;
      }
    }
    if (!sent.length) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const draft = structuredClone(this.data);
      draft.outbox = draft.outbox.filter((x) => !sent.includes(x.id));
      if (await this._write(draft)) {
        this.data = draft;
        return;
      }
      await this._reload(); // another tab: it may post them again; receivers drop the repeat by its hash
    }
  }
  _outboxBytes(d) {
    return d.outbox.reduce((n, x) => n + x.b.length, 0);
  }

  /** Counts a dropped or refused input: memory only, and at most one content-free event per code per batch. */
  _count(code, ctx) {
    this.counts[code] = (this.counts[code] ?? 0) + 1;
    if (ctx && !ctx.dropped.has(code)) {
      ctx.dropped.add(code);
      ctx.events.push({ type: "dropped", code });
    }
  }
  _state(g) {
    const s = mls.decodeGroupState(unb64(g.mls), 0)?.[0];
    if (!s) throw new Error("stored group state unreadable");
    return { ...s, clientConfig };
  }
  _keep(g, state) {
    g.mls = b64(mls.encodeGroupState(state));
    g.epoch = String(state.groupContext.epoch);
  }
  _group(d, id) {
    const g = Object.hasOwn(d.groups, id) ? d.groups[id] : null;
    if (!g) fail("UNKNOWN_GROUP");
    return g;
  }
  /** The chain's msg key for a name: Uint8Array, or null when the name has none. Throws RESOLVER_UNAVAILABLE
   * when the lookup itself failed, so callers can tell "unknown" from "mismatch". */
  async _chain(name) {
    let k;
    try {
      k = await this.resolver.msgKey(name);
    } catch {
      fail("RESOLVER_UNAVAILABLE");
    }
    return k instanceof Uint8Array && k.length === 32 ? k : null;
  }
  async _keyOf(pid) {
    return ADDR_RE.test(pid) ? unhex(pid.slice(2)) : this._chain(pid);
  }
  _keyPackage() {
    return mls.generateKeyPackageWithKey(
      { credentialType: "basic", identity: te.encode(this.pid) },
      mls.defaultCapabilities(),
      mls.defaultLifetime,
      [],
      { signKey: this.seedCopy(), publicKey: this.sigPub },
      this.impl,
    );
  }
  _control(ctx, toHex, kind, obj) {
    const to = unhex(toHex);
    const bytes = sealControl({ to, from: this.from, fromSecret: this.msgSecret, kind, bytes: te.encode(JSON.stringify(obj)), ts: this.now() });
    ctx.posts.push({ topic: inboxTopic(to), bytes });
  }
  _groupsInUse(d) {
    return Object.values(d.groups).filter((g) => g.status === "active").length + Object.keys(d.joins).length;
  }
  _liveOld(g) {
    const now = this.now();
    return (g.oldTopics ?? []).filter((o) => o.until > now).map((o) => o.topic);
  }
  _topicInUse(d, topic, exceptGid) {
    return Object.values(d.groups).some((g) => g.id !== exceptGid && g.status === "active" && (g.topic === topic || this._liveOld(g).includes(topic)));
  }

  // ---------- reading ----------
  /** Group topics this device must be subscribed to (current topics, and old ones still in their grace time).
   * The caller also keeps its own inbox subscribed. */
  topics() {
    const out = [];
    for (const g of Object.values(this.data?.groups ?? {})) if (g.status === "active") out.push(g.topic, ...this._liveOld(g));
    return [...new Set(out)];
  }
  listGroups() {
    return Object.values(this.data.groups).map((g) => ({
      id: g.id,
      name: g.name,
      admin: g.admin,
      adminVerified: g.adminVerified !== false,
      role: g.role,
      status: g.status,
      epoch: g.epoch ?? null,
      topic: g.topic ?? null,
      catchingUp: !!g.behind,
      members: Object.entries(g.members ?? {}).map(([leaf, m]) => ({
        id: m.pid, leaf: Number(leaf), address: m.key, isAddress: ADDR_RE.test(m.pid), isAdmin: Number(leaf) === ADMIN_LEAF,
        verified: m.status === "verified" && !m.duplicate && !m.malformed, keyChanged: m.status === "changed", unknown: m.status === "unknown", duplicate: !!m.duplicate, malformed: !!m.malformed,
      })),
      invited: Object.keys(g.invites ?? {}),
    }));
  }
  listInvites() {
    return Object.values(this.data.invites).map(({ id, gid, groupName, from, claimedName, verified, ts }) => ({ id, groupId: gid, groupName, from, claimedName, verified, ts }));
  }
  stats() {
    return { ...this.counts };
  }

  // ---------- actions ----------
  /** createGroup(name, members[]) -> { id, invited: [ids], failed: [{ member, code }] }. You are the admin. */
  async createGroup(name, members = []) {
    name = String(name ?? "").trim();
    if (!name || name.length > LIMITS.groupNameChars) fail("BAD_GROUP_NAME");
    const pids = [...new Set(members.map(normalizeMember))].filter((p) => p !== this.pid);
    if (pids.length + 1 > LIMITS.members) fail("LIMIT_MEMBERS");
    const id = await this._mutate(async (d, ctx) => {
      if (this._groupsInUse(d) >= LIMITS.groups) fail("LIMIT_GROUPS");
      const kp = await this._keyPackage();
      const gid = rand(32);
      const state = await mls.createGroup(gid, kp.publicPackage, kp.privatePackage, [], this.impl, clientConfig);
      const topicKey = rand(32);
      const g = {
        id: hex(gid), name, nameEpoch: "0", admin: this.pid, adminKey: this.keyHex, adminVerified: true, role: "admin", status: "active",
        topicKey: hex(topicKey), topic: topicOf(topicKey), topicEpoch: "0", oldTopics: [], mls: "", epoch: "0", seen: [], held: [], commitLog: [], invites: {},
        members: {}, lastPath: this.now(), created: this.now(), served: {},
      };
      this._keep(g, state);
      await this._roster(g, state, ctx);
      d.groups[g.id] = g;
      ctx.subscribe.push(g.topic);
      ctx.events.push({ type: "created", groupId: g.id, name });
      return g.id;
    });
    const out = { id, invited: [], failed: [] };
    for (const p of pids) {
      try {
        await this.invite(id, p);
        out.invited.push(p);
      } catch (e) {
        out.failed.push({ member: p, code: e.code ?? "ERROR" });
      }
    }
    return out;
  }

  /** invite(groupId, member): admin only. Asks the member's device for a KeyPackage (sealed v2) and sends a plain
   * v1 line for apps that only read v1. A member whose name's key changed is re-added (old leaf removed). */
  async invite(groupId, member) {
    const pid = normalizeMember(member);
    const key = await this._keyOf(pid);
    if (!key) fail("NO_MSG_KEY");
    return this._mutate(async (d, ctx) => this._inviteIn(d, ctx, this._group(d, groupId), pid, key));
  }
  _inviteIn(d, ctx, g, pid, key, rejoin = false) {
    if (g.role !== "admin") fail("NOT_ADMIN");
    if (g.status !== "active") fail("NOT_ACTIVE");
    if (pid === this.pid) fail("ALREADY_MEMBER");
    const state = this._state(g);
    const current = leaves(state).find((l) => l.pid === pid);
    if (current && eqBytes(current.key, key) && !rejoin) fail("ALREADY_MEMBER");
    const pending = Object.keys(g.invites).filter((p) => p !== pid).length;
    if (!current && leaves(state).length + pending + 1 > LIMITS.members) fail("LIMIT_MEMBERS");
    const req = hex(rand(16));
    g.invites[pid] = { key: hex(key), req, ts: this.now() };
    this._control(ctx, hex(key), "kp-request", { gid: g.id, name: g.name, req });
    if (!rejoin) {
      const text = `${this.name || "Someone"} invited you to the group "${g.name}". Open the Logos node app to join.`;
      ctx.posts.push({ topic: inboxTopic(key), bytes: sealMessage({ to: key, from: this.from, fromSecret: this.msgSecret, text: text.slice(0, MAX_TEXT), ts: this.now() }) });
    }
    ctx.events.push({ type: "invite-sent", groupId: g.id, member: pid });
    return { member: pid };
  }

  /** acceptInvite(inviteId): answers an invitation with this device's KeyPackage; joined when the Welcome comes.
   * An invitation whose sender's key isn't the claimed name's shows `from: "k:<key>"`, `verified: false`, and the
   * group it leads to shows its admin as that address. A finished record of the same group (left, removed) is
   * cleared by accepting; an active one is refused. */
  async acceptInvite(inviteId) {
    return this._mutate(async (d, ctx) => {
      const inv = Object.hasOwn(d.invites, inviteId) ? d.invites[inviteId] : null;
      if (!inv) fail("UNKNOWN_INVITE");
      const old = Object.hasOwn(d.groups, inv.gid) ? d.groups[inv.gid] : null;
      if (old?.status === "active") fail("ALREADY_MEMBER");
      if (this._groupsInUse(d) >= LIMITS.groups) fail("LIMIT_GROUPS");
      if (old) delete d.groups[inv.gid];
      await this._answerInvite(d, ctx, inv);
      delete d.invites[inviteId];
    });
  }
  async declineInvite(inviteId) {
    return this._mutate(async (d) => {
      if (!Object.hasOwn(d.invites, inviteId)) fail("UNKNOWN_INVITE");
      delete d.invites[inviteId];
    });
  }
  async _answerInvite(d, ctx, inv) {
    const kp = await this._keyPackage();
    const k = joinKey(inv.gid, inv.fromKey);
    d.joins[k] = {
      gid: inv.gid, admin: inv.from, adminKey: inv.fromKey, adminVerified: inv.verified, req: inv.req, name: inv.groupName, ts: this.now(),
      kp: b64(mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage: kp.publicPackage })),
      init: hex(kp.privatePackage.initPrivateKey), hpke: hex(kp.privatePackage.hpkePrivateKey),
    };
    this._control(ctx, inv.fromKey, "kp", { gid: inv.gid, req: inv.req, kp: d.joins[k].kp });
  }

  /** remove(groupId, member): admin only; one commit, then a new topic for those who stay. */
  async remove(groupId, member) {
    const pid = normalizeMember(member);
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role !== "admin") fail("NOT_ADMIN");
      if (g.status !== "active") fail("NOT_ACTIVE");
      if (pid === this.pid) fail("ADMIN_CANNOT_LEAVE");
      if (Object.hasOwn(g.invites, pid)) {
        delete g.invites[pid];
        return;
      }
      let state = this._state(g);
      const gone = leaves(state).filter((l) => l.pid === pid && l.index !== ADMIN_LEAF);
      if (!gone.length) fail("NOT_MEMBER");
      state = await this._removeLeaves(d, ctx, g, state, gone.map((l) => l.index));
      this._keep(g, state);
    });
  }

  /** Commits the removal of these leaves, then moves those who stay to a new topic (in the new epoch, which the
   * removed can't read). */
  async _removeLeaves(d, ctx, g, state, indices) {
    state = (await this._commit(d, ctx, g, state, indices.map((i) => ({ proposalType: "remove", remove: { removed: i } })))).state;
    state = await this._rotateTopic(ctx, g, state);
    await this._roster(g, state, ctx);
    return state;
  }
  async _rotateTopic(ctx, g, state) {
    const key = rand(32);
    const old = g.topic;
    state = await this._appMsg(ctx, g, state, { t: "topic", k: hex(key) }, [old, ...this._liveOld(g)]);
    this._switchTopic(ctx, g, key, state.groupContext.epoch);
    return state;
  }
  _switchTopic(ctx, g, key, epoch) {
    const now = this.now();
    g.oldTopics = [...(g.oldTopics ?? []).filter((o) => o.until > now && o.topic !== g.topic), { topic: g.topic, until: now + this.timings.topicGraceMs }];
    g.topicKey = hex(key);
    g.topic = topicOf(key);
    g.topicEpoch = String(epoch);
    ctx.subscribe.push(g.topic);
    ctx.events.push({ type: "topic-changed", groupId: g.id });
  }

  /** leave(groupId): asks the admin to remove this device, then forgets the group here. */
  async leave(groupId) {
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role === "admin") fail("ADMIN_CANNOT_LEAVE");
      if (g.status !== "active") fail("NOT_ACTIVE");
      await this._app(ctx, g, { t: "leave" });
      this._forget(g, ctx, "left");
      ctx.events.push({ type: "left", groupId });
    });
  }

  /** deleteGroup(groupId): forgets a group on this device (any role); nothing is sent. */
  async deleteGroup(groupId) {
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.status === "active") this._forget(g, ctx, "deleted");
      delete d.groups[groupId];
    });
  }

  /** rename(groupId, name): admin only; members show the new name. */
  async rename(groupId, name) {
    name = String(name ?? "").trim();
    if (!name || name.length > LIMITS.groupNameChars) fail("BAD_GROUP_NAME");
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role !== "admin") fail("NOT_ADMIN");
      if (g.status !== "active") fail("NOT_ACTIVE");
      await this._app(ctx, g, { t: "rn", name });
      g.name = name;
      g.nameEpoch = g.epoch;
      ctx.events.push({ type: "renamed", groupId, name });
    });
  }

  /** send(groupId, text) -> { ts }. */
  async send(groupId, text) {
    if (typeof text !== "string" || !text.trim()) fail("EMPTY_TEXT");
    if (text.length > LIMITS.textChars) fail("TEXT_TOO_LONG");
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.status !== "active") fail("NOT_ACTIVE");
      const ts = this.now();
      await this._app(ctx, g, { t: "m", text, ts });
      return { ts };
    });
  }

  async _app(ctx, g, obj) {
    this._keep(g, await this._appMsg(ctx, g, this._state(g), obj, [g.topic]));
  }
  async _appMsg(ctx, g, state, obj, topics) {
    const r = await mls.createApplicationMessage(state, te.encode(JSON.stringify(obj)), this.impl);
    const bytes = concat([FRAME], mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_private_message", privateMessage: r.privateMessage }));
    if (bytes.length > LIMITS.payloadBytes) fail("TEXT_TOO_LONG");
    pushCapped(g.seen, hashHex(bytes), LIMITS.seen); // our own copy comes back from the node
    for (const t of topics) ctx.posts.push({ topic: t, bytes });
    ctx.zero.push(...r.consumed);
    return r.newState;
  }

  /** An admin commit (after an empty one when #860 needs it), logged for resends and queued for posting on the
   * current topic and on old topics still in their grace time (members who haven't moved yet). */
  async _commit(d, ctx, g, state, proposals) {
    const addOnly = proposals.length > 0 && proposals.every((p) => p.proposalType === "add");
    if (addOnly && this.workaround860 && needsPathFirst(state)) state = (await this._commit(d, ctx, g, state, [])).state;
    const r = await mls.createCommit({ state, cipherSuite: this.impl }, { extraProposals: proposals, ratchetTreeExtension: true });
    const bytes = concat([FRAME], mls.encodeMlsMessage(r.commit));
    pushCapped(g.seen, hashHex(bytes), LIMITS.seen);
    pushCapped(g.commitLog, { e: String(state.groupContext.epoch), b: b64(bytes), t: this.now() }, LIMITS.commitLog);
    for (const t of [g.topic, ...this._liveOld(g)]) ctx.posts.push({ topic: t, bytes });
    ctx.zero.push(...r.consumed);
    if (!addOnly) g.lastPath = this.now();
    return { state: r.newState, welcome: r.welcome };
  }

  /** Leaves only what the UI needs to say "you left <name>": no keys, no topic, no member list. */
  _forget(g, ctx, status) {
    try {
      wipeState(this._state(g), this.seed);
    } catch {
      /* nothing to wipe */
    }
    if (g.topic) ctx.unsubscribe.push(g.topic, ...this._liveOld(g));
    const keep = { id: g.id, name: g.name, role: g.role, admin: g.admin, adminVerified: g.adminVerified, status, ended: this.now() };
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, keep);
  }

  /** Re-checks every leaf against the chain. Per leaf (keyed by leaf index): status "verified" (key = the name's
   * msg), "changed" (the chain says another key, or none), "unknown" (the lookup failed; no event). Two leaves with
   * one name, and names that aren't LNS names or self-certifying addresses, are flagged. */
  async _roster(g, state, ctx) {
    const before = g.members ?? {};
    const now = {};
    const count = new Map();
    const ls = leaves(state);
    for (const l of ls) count.set(l.pid, (count.get(l.pid) ?? 0) + 1);
    for (const l of ls) {
      const malformed = !wellFormed(l.pid, l.key);
      let status;
      if (malformed) status = "changed";
      else if (ADDR_RE.test(l.pid)) status = "verified";
      else {
        try {
          status = eqBytes(await this._chain(l.pid), l.key) ? "verified" : "changed";
        } catch {
          status = "unknown";
        }
      }
      const m = { pid: l.pid, key: hex(l.key), status };
      if (count.get(l.pid) > 1) m.duplicate = true;
      if (malformed) m.malformed = true;
      now[l.index] = m;
      const b = before[l.index];
      const same = b && b.pid === m.pid && b.key === m.key;
      if (status === "changed" && !malformed && !(same && b.status === "changed")) ctx.events.push({ type: "key-changed", groupId: g.id, member: l.pid });
      if ((m.duplicate || m.malformed) && !(same && (b.duplicate || b.malformed)))
        ctx.events.push({ type: "member-suspicious", groupId: g.id, leaf: l.index, member: malformed ? "k:" + m.key : l.pid, duplicate: !!m.duplicate, malformed });
    }
    const ids = (ms) => new Set(Object.values(ms).map((m) => `${m.pid}|${m.key}`));
    const a = ids(before);
    const b2 = ids(now);
    const added = Object.values(now).filter((m) => !a.has(`${m.pid}|${m.key}`)).map((m) => m.pid);
    const removed = Object.values(before).filter((m) => !b2.has(`${m.pid}|${m.key}`)).map((m) => m.pid);
    g.members = now;
    if (added.length || removed.length) ctx.events.push({ type: "members", groupId: g.id, added, removed, members: Object.values(now).map((m) => m.pid) });
  }

  // ---------- incoming ----------
  /** incoming(topic, bytes, meta) -> true when the payload was the group engine's (and is saved). Throws a
   * GroupError (STATE_CONFLICT or RESOLVER_UNAVAILABLE) when it couldn't be handled now: hand it in again later. */
  async incoming(topic, bytes, meta = {}) {
    const r = await this.incomingMany([{ topic, bytes, meta }]);
    if (r.failed.length) fail(r.error ?? "STATE_CONFLICT");
    return r.handled > 0;
  }

  /** incomingMany([{ topic, bytes, meta }]) -> { handled, failed, error }: how many payloads were the group
   * engine's, and the indices of those that could not be handled now (state conflict, names unavailable): hand
   * them in again; repeats are dropped by their hash. Input that fails authentication changes no stored state.
   * Payloads of one group are processed in epoch order (messages before the commit that closes their epoch).
   * Payloads that aren't the engine's (v1 messages, unknown topics) are left alone and not counted. */
  async incomingMany(items) {
    let handled = 0;
    let error;
    const failed = [];
    const controls = [];
    const byGroup = new Map();
    for (const [i, it] of items.entries()) {
      const bytes = it.bytes instanceof Uint8Array ? it.bytes : unb64(String(it.bytes));
      if (it.topic === this.inbox) {
        if (bytes[0] !== 2) continue; // v1: the chat's, not ours
        handled++;
        const h = hashHex(bytes);
        if (this.data.seen.includes(h)) {
          this._count("duplicate");
          continue;
        }
        const m = openControl(this.msgSecret, bytes); // authentication first, outside of any state write
        if (!m) {
          this._count("unreadable-control");
          continue;
        }
        controls.push({ i, h, m });
        continue;
      }
      const g = Object.values(this.data.groups).find((x) => x.status === "active" && (x.topic === it.topic || this._liveOld(x).includes(it.topic)));
      if (!g) continue;
      handled++;
      if (!byGroup.has(g.id)) byGroup.set(g.id, []);
      byGroup.get(g.id).push([i, bytes]);
    }
    const onFail = (idx) => (e) => {
      failed.push(...idx);
      error = e?.code ?? "STATE_CONFLICT";
    };
    if (controls.length) {
      await this._mutate(async (d, ctx) => {
        for (const c of controls) {
          if (d.seen.includes(c.h)) continue;
          await this._control_in(d, ctx, c.m); // RESOLVER_UNAVAILABLE propagates: nothing saved, hand it in again
          pushCapped(d.seen, c.h, LIMITS.seen); // seen only once handled
        }
      }).catch(onFail(controls.map((c) => c.i)));
    }
    for (const [gid, list] of byGroup) {
      await this._mutate(async (d, ctx) => {
        const g = d.groups[gid];
        if (g?.status === "active") await this._groupBatch(d, ctx, g, list.map(([, b]) => b));
      }).catch(onFail(list.map(([i]) => i)));
    }
    return { handled, failed: failed.sort((a, b) => a - b), error };
  }

  _parse(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > LIMITS.payloadBytes || bytes[0] !== FRAME) return null;
    const m = mls.decodeMlsMessage(bytes.subarray(1), 0)?.[0];
    if (!m || m.wireformat !== "mls_private_message") return { bytes, h: hashHex(bytes), bad: true };
    const pm = m.privateMessage;
    return { bytes, h: hashHex(bytes), pm, epoch: pm.epoch, commit: pm.contentType === "commit" };
  }

  /** Keeps a message that can't be checked before its commit: only for the next LIMITS.holdAhead epochs, within
   * a count and byte budget (the oldest go first), and nothing about it counts as "catching up" by itself. */
  _hold(g, it, ctx) {
    const b = b64(it.bytes);
    if (b.length > LIMITS.heldBytes) return this._count("held-too-big", ctx);
    g.held.push({ h: it.h, e: String(it.epoch), b, t: this.now() });
    let bytes = g.held.reduce((n, x) => n + x.b.length, 0);
    while (g.held.length > LIMITS.held || bytes > LIMITS.heldBytes) {
      bytes -= g.held.shift().b.length;
      this._count("held-evicted", ctx);
    }
  }

  async _groupBatch(d, ctx, g, list) {
    let state = this._state(g);
    const startEpoch = state.groupContext.epoch;
    const queue = [];
    for (const bytes of list) {
      let it;
      try {
        it = this._parse(bytes);
      } catch {
        it = null;
      }
      if (!it) {
        this._count("not-a-group-message", ctx);
        continue;
      }
      if (g.seen.includes(it.h) || g.held.some((x) => x.h === it.h)) {
        this._count("duplicate");
        continue;
      }
      if (it.bad) {
        this._count("not-a-private-message", ctx); // external commits and public messages: never processed
        continue;
      }
      if (hex(it.pm.groupId) !== g.id) {
        this._count("wrong-group", ctx);
        continue;
      }
      queue.push(it);
    }
    const order = (a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : (a.commit ? 1 : 0) - (b.commit ? 1 : 0));
    const leaving = [];
    queue.sort(order);
    while (queue.length && g.status === "active") {
      const it = queue.shift();
      if (g.seen.includes(it.h)) continue;
      const ahead = it.epoch - state.groupContext.epoch;
      if (ahead > BigInt(LIMITS.holdAhead)) {
        this._count("too-far-ahead", ctx); // unauthenticated: dropped, never stored
        continue;
      }
      if (ahead > 0n) {
        this._hold(g, it, ctx);
        continue;
      }
      const r = await this._one(d, ctx, g, state, it, leaving);
      state = r.state;
      if (r.epochChanged && g.status === "active") {
        const ready = g.held.filter((x) => BigInt(x.e) <= state.groupContext.epoch);
        g.held = g.held.filter((x) => BigInt(x.e) > state.groupContext.epoch);
        for (const x of ready) {
          const p = this._parse(unb64(x.b));
          if (p && !p.bad) queue.push(p);
        }
        queue.sort(order);
      }
    }
    if (g.status !== "active") return;
    // the admin removes members who asked to leave, if each leaf still holds the key that asked
    if (g.role === "admin" && leaving.length) {
      const ls = leaves(state).filter((l) => l.index !== ADMIN_LEAF && leaving.some((x) => x.index === l.index && x.key === hex(l.key)));
      if (ls.length) state = await this._removeLeaves(d, ctx, g, state, ls.map((l) => l.index));
      if (ls.length < leaving.length) this._count("stale-leave", ctx);
    }
    this._keep(g, state);
    if (state.groupContext.epoch !== startEpoch) delete g.resendGap; // progress: resend back-off starts over
    if (g.behind && !g.held.length) {
      delete g.behind;
      delete g.behindSince;
      ctx.events.push({ type: "caught-up", groupId: g.id });
    }
  }

  /** One message at or before the current epoch. Every library exception is caught: the message is dropped and
   * counted (memory only), the state stays as it was, and it isn't marked seen (it may be a forgery of a real id). */
  async _one(d, ctx, g, state, it, leaving) {
    const current = state.groupContext.epoch;
    try {
      const sender = await this._senderOf(state, it.pm);
      const r = await mls.processPrivateMessage(state, it.pm, mls.makePskIndex(state, {}), this.impl, ONLY_ADMIN_COMMITS);
      pushCapped(g.seen, it.h, LIMITS.seen);
      ctx.zero.push(...r.consumed);
      if (r.kind === "applicationMessage") {
        this._onApp(d, ctx, g, r.newState, sender, r.message, it.epoch, it.epoch < current, leaving);
        return { state: r.newState };
      }
      if (r.actionTaken === "reject") {
        this._count(it.commit ? "commit-not-from-admin" : "proposal-refused", ctx);
        return { state: r.newState };
      }
      if (!it.commit) return { state: r.newState };
      const after = r.newState;
      if (after.groupActiveState?.kind === "removedFromGroup") {
        wipeState(after, this.seed);
        this._forget(g, ctx, "removed");
        ctx.events.push({ type: "removed", groupId: g.id });
        return { state: after };
      }
      this._trackGaps(g, ctx, current);
      await this._roster(g, after, ctx);
      return { state: after, epochChanged: true };
    } catch (e) {
      const msg = String(e?.message ?? "");
      this.lastLibraryError = msg; // memory only, for tests and debugging; never stored or emitted
      this._count(/too old|former epoch/.test(msg) ? "epoch-too-old" : /gen in the past/.test(msg) ? "already-read" : "library-error", ctx);
      return { state };
    }
  }

  async _senderOf(state, pm) {
    let sds = state.keySchedule.senderDataSecret;
    let tree = state.ratchetTree;
    if (pm.epoch !== state.groupContext.epoch) {
      const h = state.historicalReceiverData.get(pm.epoch);
      if (!h) throw new Error("epoch too old");
      sds = h.senderDataSecret;
      tree = h.ratchetTree;
    }
    const sd = await mls.internals["privateMessage.js"].decryptSenderData(pm, sds, this.impl);
    const node = tree[sd.leafIndex * 2];
    if (node?.nodeType !== "leaf") throw new Error("sender is not a leaf");
    return { index: sd.leafIndex, generation: sd.generation, pid: leafPid(node.leaf), key: leafMsgKey(node.leaf) };
  }

  /** Generation gaps per sender in an epoch = messages not (yet) received. Reported when the epoch closes. */
  _trackGaps(g, ctx, closedEpoch) {
    const gaps = g.gaps?.[String(closedEpoch)];
    if (gaps) {
      const missing = Object.values(gaps).reduce((n, x) => n + Math.max(0, x.max + 1 - x.got), 0);
      if (missing > 0) ctx.events.push({ type: "missed-messages", groupId: g.id, count: missing, epoch: String(closedEpoch) });
    }
    for (const e of Object.keys(g.gaps ?? {})) if (BigInt(e) < BigInt(closedEpoch) - 4n) delete g.gaps[e];
  }

  _onApp(d, ctx, g, state, sender, data, epoch, late, leaving) {
    let obj;
    try {
      obj = JSON.parse(td.decode(data));
    } catch {
      return this._count("bad-content", ctx);
    }
    g.gaps ??= {};
    const gaps = (g.gaps[String(epoch)] ??= {});
    const s = (gaps[sender.index] ??= { max: -1, got: 0 });
    if (!late) {
      s.max = Math.max(s.max, sender.generation);
      s.got++;
    }
    // who the sender is now: the leaf at that index must still hold the same name and key
    const m = g.members?.[sender.index];
    const stillHere = !!m && m.key === hex(sender.key) && m.pid === sender.pid;
    const fromAdmin = sender.index === ADMIN_LEAF && hex(sender.key) === g.adminKey;
    if (obj?.t === "m" && typeof obj.text === "string" && obj.text.length <= LIMITS.textChars) {
      const ok = wellFormed(sender.pid, sender.key);
      ctx.events.push({
        type: "message", groupId: g.id, from: ok ? sender.pid : "k:" + hex(sender.key), address: hex(sender.key), text: obj.text,
        ts: Number.isSafeInteger(obj.ts) ? obj.ts : null, late, verified: stillHere && m.status === "verified" && !m.duplicate,
        formerMember: !stillHere, suspicious: !ok || !!m?.duplicate,
      });
    } else if (obj?.t === "rn" && typeof obj.name === "string" && obj.name.length > 0 && obj.name.length <= LIMITS.groupNameChars) {
      if (!fromAdmin) return this._count("rename-not-from-admin", ctx);
      if (epoch < BigInt(g.nameEpoch ?? "0")) return this._count("stale-rename", ctx); // a late rename never undoes a newer one
      g.name = obj.name;
      g.nameEpoch = String(epoch);
      ctx.events.push({ type: "renamed", groupId: g.id, name: obj.name });
    } else if (obj?.t === "topic" && typeof obj.k === "string" && /^[0-9a-f]{64}$/.test(obj.k)) {
      if (!fromAdmin) return this._count("topic-not-from-admin", ctx);
      if (g.role === "admin" || epoch < BigInt(g.topicEpoch ?? "0")) return this._count("stale-topic", ctx);
      const key = unhex(obj.k);
      if (topicOf(key) === g.topic) return;
      if (this._topicInUse(d, topicOf(key), g.id)) return this._count("topic-collision", ctx);
      this._switchTopic(ctx, g, key, epoch);
    } else if (obj?.t === "leave") {
      // only a current request from a current leaf; the key is re-checked before anyone is removed
      if (g.role !== "admin" || sender.index === ADMIN_LEAF) return;
      if (late || !stillHere) return this._count("stale-leave", ctx);
      leaving.push({ index: sender.index, key: hex(sender.key) });
    } else this._count("bad-content", ctx);
  }

  // ---------- sealed control messages (v2) on the inbox ----------
  /** m is already authenticated (openControl). Who the sender is: an address proves itself; a name only if the
   * chain's msg key for it is the sealing key (else it is treated as the address "k:<key>"). */
  async _control_in(d, ctx, m) {
    let pid;
    let verified;
    let claimed;
    if (NAMELESS_RE.test(m.from)) {
      if (m.from !== "msg-" + m.fromKey.slice(0, 16)) return this._count("bad-sender", ctx);
      pid = "k:" + m.fromKey;
      verified = true;
    } else {
      verified = eqBytes(await this._chain(m.from), unhex(m.fromKey)); // may throw RESOLVER_UNAVAILABLE: retried
      pid = verified ? m.from : "k:" + m.fromKey;
      if (!verified) claimed = m.from;
    }
    let body;
    try {
      body = JSON.parse(td.decode(m.bytes));
    } catch {
      return this._count("bad-control", ctx);
    }
    try {
      await this._onControl(d, ctx, m.kind, body, pid, m.fromKey, verified, claimed);
    } catch (e) {
      if (e?.code === "RESOLVER_UNAVAILABLE") throw e;
      this._count(e instanceof GroupError ? "control-refused" : "library-error", ctx);
    }
  }

  async _onControl(d, ctx, kind, body, pid, fromKey, verified, claimed) {
    const gid = typeof body?.gid === "string" && /^[0-9a-f]{64}$/.test(body.gid) ? body.gid : null;
    if (!gid) return this._count("bad-control", ctx);
    const g = Object.hasOwn(d.groups, gid) ? d.groups[gid] : null;
    switch (kind) {
      case "kp-request": {
        if (g?.status === "active") return;
        if (typeof body.req !== "string" || body.req.length > 64 || typeof body.name !== "string") return this._count("bad-control", ctx);
        const id = hashHex(te.encode(`${gid}:${fromKey}`)); // one invitation per group and sender key
        const inv = { id, gid, groupName: body.name.slice(0, LIMITS.groupNameChars), from: pid, fromKey, req: body.req, verified, ts: this.now() };
        if (claimed) inv.claimedName = claimed;
        const rj = Object.hasOwn(d.rejoin, gid) ? d.rejoin[gid] : null;
        if (rj && verified && rj.admin === pid && rj.adminKey === fromKey) {
          // we asked to be re-added (restore): answer without asking the user again
          delete d.rejoin[gid];
          await this._answerInvite(d, ctx, inv);
          return;
        }
        if (Object.hasOwn(d.invites, id)) {
          Object.assign(d.invites[id], { groupName: inv.groupName, req: inv.req, ts: inv.ts, verified }); // same sender, same group
          return;
        }
        const all = Object.values(d.invites);
        if (all.filter((x) => x.fromKey === fromKey).length >= LIMITS.invitesPerSender) return this._count("too-many-invites-from-sender", ctx);
        if (all.length >= LIMITS.invites) {
          // make room: unverified invitations go first, oldest first; a verified one only for a verified one
          const victim = all.filter((x) => !x.verified).sort((a, b) => a.ts - b.ts)[0] ?? (verified ? all.sort((a, b) => a.ts - b.ts)[0] : null);
          if (!victim) return this._count("too-many-invites", ctx);
          delete d.invites[victim.id];
          this._count("invite-evicted", ctx);
        }
        d.invites[id] = inv;
        ctx.events.push({ type: "invite", inviteId: id, groupId: gid, groupName: inv.groupName, from: pid, claimedName: claimed, verified });
        return;
      }
      case "kp": {
        if (!g || g.role !== "admin" || g.status !== "active") return this._count("control-refused", ctx);
        const inv = Object.hasOwn(g.invites, pid) ? g.invites[pid] : null;
        if (!inv || inv.req !== body.req || inv.key !== fromKey) return this._count("control-refused", ctx);
        const msg = mls.decodeMlsMessage(unb64(String(body.kp)), 0)?.[0];
        if (msg?.wireformat !== "mls_key_package") return this._count("bad-control", ctx);
        const kp = msg.keyPackage;
        // the leaf must be the invited name's (or address's) key, now as at invite time (a failed lookup throws:
        // the message isn't marked seen and is handed in again)
        const keyNow = await this._keyOf(pid);
        if (leafPid(kp.leafNode) !== pid || hex(leafMsgKey(kp.leafNode)) !== inv.key || !eqBytes(keyNow, unhex(inv.key))) {
          delete g.invites[pid];
          ctx.events.push({ type: "invite-failed", groupId: gid, member: pid, code: "KEY_CHANGED" });
          return;
        }
        let state = this._state(g);
        const old = leaves(state).filter((l) => l.pid === pid && l.index !== ADMIN_LEAF);
        // A re-add removes the old leaf in its own commit first: ts-mls 1.6.4 decides "was I removed?" by
        // whether the device's leaf slot is blank afterwards, so a Remove and an Add that refills the same slot
        // in one commit leave the old device stuck ("No overlap between provided private keys and update path").
        // The removal also moves the group to a new topic, which the Welcome below carries.
        if (old.length) state = await this._removeLeaves(d, ctx, g, state, old.map((l) => l.index));
        const c = await this._commit(d, ctx, g, state, [{ proposalType: "add", add: { keyPackage: kp } }]);
        state = c.state;
        const welcome = mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome: c.welcome });
        this._keep(g, state);
        delete g.invites[pid];
        this._control(ctx, inv.key, "welcome", { gid, name: g.name, admin: g.admin, topicKey: g.topicKey, welcome: b64(welcome) });
        await this._roster(g, state, ctx);
        return;
      }
      case "welcome": {
        const k = joinKey(gid, fromKey);
        const j = Object.hasOwn(d.joins, k) ? d.joins[k] : null;
        if (!j || j.admin !== pid) return this._count("control-refused", ctx);
        if (g) return this._count("welcome-for-existing-group", ctx); // never overwrite a record from a Welcome
        if (typeof body.topicKey !== "string" || !/^[0-9a-f]{64}$/.test(body.topicKey)) return this._count("bad-control", ctx);
        const topic = topicOf(unhex(body.topicKey));
        if (this._topicInUse(d, topic, gid)) return this._count("topic-collision", ctx);
        const wm = mls.decodeMlsMessage(unb64(String(body.welcome)), 0)?.[0];
        const kpm = mls.decodeMlsMessage(unb64(j.kp), 0)?.[0];
        if (wm?.wireformat !== "mls_welcome" || !kpm) return this._count("bad-control", ctx);
        // copies only: ts-mls keeps the signature key it is given by reference inside the new state
        const priv = { initPrivateKey: unhex(j.init), hpkePrivateKey: unhex(j.hpke), signaturePrivateKey: this.seedCopy() };
        const state = await mls.joinGroup(wm.welcome, kpm.keyPackage, priv, mls.emptyPskIndex, this.impl, undefined, undefined, clientConfig);
        const admin = state.ratchetTree[ADMIN_LEAF * 2];
        if (hex(state.groupContext.groupId) !== gid) {
          wipeState(state, this.seed);
          return this._count("welcome-wrong-group", ctx);
        }
        if (admin?.nodeType !== "leaf" || hex(leafMsgKey(admin.leaf)) !== j.adminKey || (j.adminVerified && leafPid(admin.leaf) !== j.admin)) {
          wipeState(state, this.seed);
          return this._count("welcome-not-from-admin", ctx);
        }
        for (const [key, other] of Object.entries(d.joins)) if (other.gid === gid) delete d.joins[key];
        const ng = {
          id: gid, name: String(body.name ?? j.name).slice(0, LIMITS.groupNameChars), nameEpoch: String(state.groupContext.epoch),
          admin: j.admin, adminKey: j.adminKey, adminVerified: j.adminVerified, role: "member", status: "active",
          topicKey: body.topicKey, topic, topicEpoch: String(state.groupContext.epoch), oldTopics: [], mls: "", epoch: "0",
          seen: [], held: [], commitLog: [], invites: {}, members: {}, created: this.now(),
        };
        this._keep(ng, state);
        d.groups[gid] = ng;
        await this._roster(ng, state, ctx);
        ctx.subscribe.push(ng.topic);
        ctx.events.push({ type: "joined", groupId: gid, name: ng.name, admin: ng.admin, adminVerified: ng.adminVerified });
        return;
      }
      case "resend-request": {
        if (!g || g.role !== "admin" || g.status !== "active") return this._count("control-refused", ctx);
        const state = this._state(g);
        const member = leaves(state).find((l) => l.pid === pid && hex(l.key) === fromKey && l.index !== ADMIN_LEAF);
        if (!member) return this._count("control-refused", ctx); // removed members get nothing
        g.served ??= {};
        const now = this.now();
        if (now - (g.served[fromKey] ?? 0) < this.timings.resendServeGapMs) return this._count("resend-rate-limited", ctx);
        if (this._outboxBytes(d) > LIMITS.outboxBytes) return this._count("resend-outbox-full", ctx);
        g.served[fromKey] = now;
        let from;
        try {
          from = BigInt(String(body.fromEpoch ?? "0"));
        } catch {
          return this._count("bad-control", ctx);
        }
        const all = g.commitLog.filter((c) => BigInt(c.e) >= from);
        const items = all.slice(0, LIMITS.resendCommits);
        const tooOld = !g.commitLog.length || BigInt(g.commitLog[0].e) > from || all.length > items.length;
        // chunks that fit a sealed control message (base64 grows by 4/3; leave room for the JSON around it);
        // always one answer, which says where the admin is (so a member holding forged "future" messages can
        // drop them)
        const chunks = [[]];
        let size = 0;
        for (const c of items) {
          if (size + c.b.length > 40_000 && chunks.at(-1).length) {
            chunks.push([]);
            size = 0;
          }
          chunks.at(-1).push(c.b);
          size += c.b.length;
        }
        for (const ch of chunks) this._control(ctx, fromKey, "commits", { gid, items: ch, tooOld, epoch: g.epoch });
        return;
      }
      case "commits": {
        if (!g || g.role !== "member" || g.status !== "active" || fromKey !== g.adminKey || pid !== g.admin) return this._count("control-refused", ctx);
        if (body.tooOld) ctx.events.push({ type: "needs-readd", groupId: gid, reason: "the admin no longer has the commits this device missed" });
        const list = (Array.isArray(body.items) ? body.items : []).filter((x) => typeof x === "string").slice(0, LIMITS.resendCommits).map(unb64);
        await this._groupBatch(d, ctx, g, list);
        // if we are now where the admin is, anything still held claims an epoch that doesn't exist: forged
        let adminEpoch;
        try {
          adminEpoch = BigInt(String(body.epoch));
        } catch {
          adminEpoch = null;
        }
        if (adminEpoch !== null && g.status === "active" && BigInt(g.epoch) >= adminEpoch && g.held.length) {
          for (let i = 0; i < g.held.length; i++) this._count("forged-future", ctx);
          g.held = [];
          if (g.behind) {
            delete g.behind;
            delete g.behindSince;
            ctx.events.push({ type: "caught-up", groupId: gid });
          }
        }
        return;
      }
      case "rejoin-request": {
        if (!g || g.role !== "admin" || g.status !== "active") return this._count("control-refused", ctx);
        if (!verified) return this._count("control-refused", ctx);
        const state = this._state(g);
        const leaf = leaves(state).find((l) => l.pid === pid && l.index !== ADMIN_LEAF);
        if (!leaf) return this._count("control-refused", ctx); // not a member (removed members can't come back this way)
        // a real reason: the chain proves a new key for this name, or the device says it was restored (same key)
        const keyChanged = hex(leaf.key) !== fromKey; // `verified` above: the chain says fromKey is pid's key now
        if (!keyChanged && body.restore !== true) return this._count("control-refused", ctx);
        g.rejoins ??= {};
        const gap = keyChanged ? this.timings.rejoinKeyChangeGapMs : this.timings.rejoinRestoreGapMs;
        if (this.now() - (g.rejoins[pid] ?? 0) < gap) return this._count("rejoin-rate-limited", ctx);
        if (Object.hasOwn(g.invites, pid)) return; // already asked
        g.rejoins[pid] = this.now();
        ctx.events.push({ type: "rejoin-request", groupId: gid, member: pid, reason: keyChanged ? "key-changed" : "restored" });
        this._inviteIn(d, ctx, g, pid, unhex(fromKey), true);
        return;
      }
      default:
        return this._count("bad-control", ctx);
    }
  }

  // ---------- time ----------
  /** tick(): call every few seconds to a minute. Retries posts, asks for missed commits (with back-off), drops
   * old held messages and old topics, and does the admin's daily self-update. */
  async tick() {
    await this._mutate(async (d, ctx) => {
      const now = this.now();
      for (const g of Object.values(d.groups)) {
        if (g.status !== "active") continue;
        const before = g.held.length;
        g.held = g.held.filter((x) => now - x.t <= this.timings.heldTtlMs);
        if (before !== g.held.length) this._count("held-expired", ctx);
        const expired = (g.oldTopics ?? []).filter((o) => o.until <= now).map((o) => o.topic);
        if (expired.length) {
          g.oldTopics = g.oldTopics.filter((o) => o.until > now);
          ctx.unsubscribe.push(...expired.filter((t) => t !== g.topic));
        }
        if (g.role === "member" && g.held.length) {
          const oldest = Math.min(...g.held.map((x) => x.t));
          const gap = g.resendGap ?? this.timings.resendGapMs;
          if (now - oldest > this.timings.resendAfterMs && now - (g.lastResend ?? 0) > gap) {
            g.lastResend = now;
            g.resendGap = Math.min(gap * 2, 3_600_000);
            this._control(ctx, g.adminKey, "resend-request", { gid: g.id, fromEpoch: g.epoch });
            if (!g.behind) {
              g.behind = true;
              g.behindSince = now;
              ctx.events.push({ type: "catching-up", groupId: g.id });
            }
          }
          if (g.behind && now - g.behindSince > this.timings.needsReaddAfterMs && !g.toldNeedsReadd) {
            g.toldNeedsReadd = true;
            ctx.events.push({ type: "needs-readd", groupId: g.id, reason: "missed commits could not be recovered" });
          }
        } else if (g.behind) {
          delete g.behind;
          delete g.behindSince;
        }
        if (g.role === "admin" && now - (g.lastPath ?? 0) > this.timings.adminRefreshMs) {
          this._keep(g, (await this._commit(d, ctx, g, this._state(g), [])).state);
        }
        if (g.role === "admin") for (const [p, inv] of Object.entries(g.invites)) if (now - inv.ts > this.timings.inviteTtlMs) delete g.invites[p];
      }
      // accepted invitations whose Welcome never came, and restore requests never answered, stop counting
      for (const [k, j] of Object.entries(d.joins)) if (now - j.ts > this.timings.inviteTtlMs) delete d.joins[k];
      for (const [gid, r] of Object.entries(d.rejoin)) if (now - r.ts > this.timings.inviteTtlMs) delete d.rejoin[gid];
      for (const [id, inv] of Object.entries(d.invites)) if (now - inv.ts > this.timings.inviteTtlMs) delete d.invites[id];
    }).catch(() => {});
  }

  // ---------- backup ----------
  /** exportBackup() -> a plain object with the group list only (no keys, no MLS state, no topics). */
  exportBackup() {
    return this._backupOf(this.data);
  }
  _backupOf(d) {
    return {
      v: 1,
      kind: "names-groups",
      groups: Object.values(d.groups)
        .filter((g) => g.status === "active")
        .map((g) => ({ id: g.id, name: g.name, admin: g.admin, adminKey: g.adminKey, role: g.role, members: [...new Set(Object.values(g.members ?? {}).map((m) => m.pid))] })),
    };
  }
  /** importBackup(backup): on a restored device, asks each group's admin to re-add it. Groups this device was
   * the admin of can't be recovered (no one else can change their members): reported as admin-lost. */
  async importBackup(backup) {
    return this._mutate(async (d, ctx) => {
      for (const b of backup?.groups ?? []) {
        if (typeof b?.id !== "string" || !/^[0-9a-f]{64}$/.test(b.id) || (Object.hasOwn(d.groups, b.id) && d.groups[b.id].status === "active")) continue;
        if (b.role === "admin") {
          ctx.events.push({ type: "admin-lost", groupId: b.id, name: b.name });
          continue;
        }
        let adminKey = null;
        try {
          adminKey = ADDR_RE.test(b.admin) ? unhex(b.admin.slice(2)) : await this._chain(b.admin);
        } catch {
          adminKey = null;
        }
        if (!adminKey) {
          ctx.events.push({ type: "needs-readd", groupId: b.id, reason: "the admin's messaging address can't be found" });
          continue;
        }
        d.rejoin[b.id] = { admin: b.admin, adminKey: hex(adminKey), name: b.name, ts: this.now() };
        this._control(ctx, hex(adminKey), "rejoin-request", { gid: b.id, restore: true });
        ctx.events.push({ type: "rejoin-requested", groupId: b.id, name: b.name, admin: b.admin });
      }
    });
  }
}

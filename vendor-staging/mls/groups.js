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
//   - the admin is leaf 0 (the creator's leaf; nothing ever removes it).
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
  held: 1000, // future-epoch messages kept per group while waiting for a commit
  commitLog: 64, // commits the admin keeps for resends
  seen: 4000, // message hashes remembered per group (and for the inbox)
  invites: 50, // invitations kept waiting for an answer
});
export const STATE_VERSION = 1;
const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
const FRAME = 0x47; // "G": group topic payload = 0x47 ‖ MLSMessage
const ADMIN_LEAF = 0;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ADDR_RE = /^k:[0-9a-f]{64}$/;
const NAMELESS_RE = /^msg-[0-9a-f]{16}$/;
const DEFAULT_TIMINGS = {
  resendAfterMs: 120_000, // future-epoch messages held this long: ask the admin for the missing commits
  resendGapMs: 60_000, // between two resend requests for one group
  needsReaddAfterMs: 7 * 86_400_000, // still behind after this long: say the admin must re-add this device
  adminRefreshMs: 86_400_000, // the admin commits a path (self-update) at most this often
  inviteTtlMs: 30 * 86_400_000,
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
const hashHex = (bytes) => hex(sha256(bytes));
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
const leafPid = (leaf) => td.decode(leaf.credential.identity);
function leaves(state) {
  const out = [];
  state.ratchetTree.forEach((n, i) => {
    if (n?.nodeType === "leaf") out.push({ index: i / 2, pid: leafPid(n.leaf), key: leafMsgKey(n.leaf) });
  });
  return out;
}
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
 * memory until garbage collection. Strings (the stored base64) can't be zeroed at all. */
export function wipeState(state) {
  const z = (b) => b instanceof Uint8Array && b.fill(0);
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
    z(state.signaturePrivateKey); // a decoded copy of the device seed, not the caller's
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

const emptyData = (me) => ({ v: STATE_VERSION, me, groups: {}, invites: {}, joins: {}, rejoin: {}, outbox: [], seen: [], stats: {} });

/**
 * createGroupEngine({ me, transport, resolver, storage, cipher, provider, now, timings }) -> engine
 *   me        { name: "alice" or "", seed: Uint8Array(32) }   the device's Ed25519 seed; its X25519 form is `msg`
 *   transport { post(topic, bytes): Promise, subscribe(topics[]): Promise, unsubscribe(topics[]): Promise }
 *             post resolves once the node took the message and throws if it didn't (the engine retries on tick).
 *             The caller hands every payload from the inbox and from engine.topics() to engine.incoming().
 *   resolver  { msgKey(name): Promise<Uint8Array(32) | null> }   the `msg` entry of an LNS name, from the chain
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
    this.seed = me.seed;
    this.sigPub = ed25519.getPublicKey(me.seed);
    this.msgKey = ed25519.utils.toMontgomery(this.sigPub);
    this.msgSecret = ed25519.utils.toMontgomerySecret(me.seed);
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
  }

  // ---------- events ----------
  /** onEvent(cb) -> unsubscribe. Events are plain objects with a `type`; see EVENTS in tests/groups/README. */
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
    this.data = JSON.parse(td.decode(await this.cipher.decrypt(r.blob)));
  }
  async _write(d) {
    const blob = await this.cipher.encrypt(te.encode(JSON.stringify(d)));
    const r = await this.storage.write(blob, this.version);
    if (r?.ok) this.version = r.version;
    return !!r?.ok;
  }

  /** Runs fn(draft, ctx) on a copy of the state, saves it (compare-and-swap), and only then posts, subscribes
   * and emits. On a conflict (another tab wrote first) it reloads and runs fn once more on the fresh state. */
  _mutate(fn) {
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const draft = structuredClone(this.data);
        const ctx = { posts: [], events: [], zero: [], subscribe: [], unsubscribe: [] };
        const result = await fn(draft, ctx);
        for (const p of ctx.posts) draft.outbox.push({ id: hex(rand(8)), topic: p.topic, b: b64(p.bytes) });
        const unchanged = !ctx.posts.length && JSON.stringify(draft) === JSON.stringify(this.data);
        if (unchanged || (await this._write(draft))) {
          this.data = draft;
          for (const b of ctx.zero) if (b instanceof Uint8Array) b.fill(0);
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

  _count(d, code, ctx) {
    d.stats[code] = (d.stats[code] ?? 0) + 1;
    ctx?.events.push({ type: "dropped", code }); // no content, no sender
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
    const g = d.groups[id];
    if (!g) fail("UNKNOWN_GROUP");
    return g;
  }
  async _keyOf(pid) {
    if (ADDR_RE.test(pid)) return unhex(pid.slice(2));
    const k = await this.resolver.msgKey(pid);
    return k instanceof Uint8Array && k.length === 32 ? k : null;
  }
  _keyPackage() {
    return mls.generateKeyPackageWithKey(
      { credentialType: "basic", identity: te.encode(this.pid) },
      mls.defaultCapabilities(),
      mls.defaultLifetime,
      [],
      { signKey: this.seed, publicKey: this.sigPub },
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

  // ---------- reading ----------
  /** Group topics this device must be subscribed to (the caller also keeps its own inbox subscribed). */
  topics() {
    return Object.values(this.data?.groups ?? {}).filter((g) => g.status === "active").map((g) => g.topic);
  }
  listGroups() {
    return Object.values(this.data.groups).map((g) => ({
      id: g.id,
      name: g.name,
      admin: g.admin,
      role: g.role,
      status: g.status,
      epoch: g.epoch,
      topic: g.topic,
      catchingUp: g.held.length > 0,
      members: Object.entries(g.members).map(([id, m]) => ({ id, address: m.key, isAddress: ADDR_RE.test(id), isAdmin: id === g.admin, verified: m.verified, keyChanged: m.keyChanged })),
      invited: Object.keys(g.invites ?? {}),
    }));
  }
  listInvites() {
    return Object.values(this.data.invites).map(({ id, gid, groupName, from, verified, ts }) => ({ id, groupId: gid, groupName, from, verified, ts }));
  }
  stats() {
    return { ...this.data.stats };
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
        id: hex(gid), name, admin: this.pid, adminKey: this.keyHex, role: "admin", status: "active",
        topicKey: hex(topicKey), topic: topicOf(topicKey), mls: "", epoch: "0", seen: [], held: [], commitLog: [], invites: {},
        members: { [this.pid]: { key: this.keyHex, verified: true, keyChanged: false } }, lastPath: this.now(), created: this.now(),
      };
      this._keep(g, state);
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

  /** acceptInvite(inviteId): answers an invitation with this device's KeyPackage; joined when the Welcome comes. */
  async acceptInvite(inviteId) {
    return this._mutate(async (d, ctx) => {
      const inv = d.invites[inviteId];
      if (!inv) fail("UNKNOWN_INVITE");
      if (this._groupsInUse(d) >= LIMITS.groups) fail("LIMIT_GROUPS");
      await this._answerInvite(d, ctx, inv);
      delete d.invites[inviteId];
    });
  }
  async declineInvite(inviteId) {
    return this._mutate(async (d) => {
      if (!d.invites[inviteId]) fail("UNKNOWN_INVITE");
      delete d.invites[inviteId];
    });
  }
  async _answerInvite(d, ctx, inv) {
    const kp = await this._keyPackage();
    d.joins[inv.gid] = {
      gid: inv.gid, admin: inv.from, adminKey: inv.fromKey, req: inv.req, name: inv.groupName, ts: this.now(),
      kp: b64(mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage: kp.publicPackage })),
      init: hex(kp.privatePackage.initPrivateKey), hpke: hex(kp.privatePackage.hpkePrivateKey),
    };
    this._control(ctx, inv.fromKey, "kp", { gid: inv.gid, req: inv.req, kp: d.joins[inv.gid].kp });
  }

  /** remove(groupId, member): admin only; one commit. The removed device reads nothing after it. */
  async remove(groupId, member) {
    const pid = normalizeMember(member);
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role !== "admin") fail("NOT_ADMIN");
      if (g.status !== "active") fail("NOT_ACTIVE");
      if (pid === this.pid) fail("ADMIN_CANNOT_LEAVE");
      if (g.invites[pid]) {
        delete g.invites[pid];
        return;
      }
      let state = this._state(g);
      const leaf = leaves(state).find((l) => l.pid === pid);
      if (!leaf) fail("NOT_MEMBER");
      state = (await this._commit(d, ctx, g, state, [{ proposalType: "remove", remove: { removed: leaf.index } }])).state;
      this._keep(g, state);
      await this._roster(g, state, ctx);
    });
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
    const state = this._state(g);
    const r = await mls.createApplicationMessage(state, te.encode(JSON.stringify(obj)), this.impl);
    const bytes = concat([FRAME], mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_private_message", privateMessage: r.privateMessage }));
    if (bytes.length > LIMITS.payloadBytes) fail("TEXT_TOO_LONG");
    pushCapped(g.seen, hashHex(bytes), LIMITS.seen); // our own copy comes back from the node
    ctx.posts.push({ topic: g.topic, bytes });
    ctx.zero.push(...r.consumed);
    this._keep(g, r.newState);
  }

  /** An admin commit (after an empty one when #860 needs it), logged for resends and queued for posting. */
  async _commit(d, ctx, g, state, proposals) {
    const addOnly = proposals.length > 0 && proposals.every((p) => p.proposalType === "add");
    if (addOnly && this.workaround860 && needsPathFirst(state)) state = (await this._commit(d, ctx, g, state, [])).state;
    const r = await mls.createCommit({ state, cipherSuite: this.impl }, { extraProposals: proposals, ratchetTreeExtension: true });
    const bytes = concat([FRAME], mls.encodeMlsMessage(r.commit));
    pushCapped(g.seen, hashHex(bytes), LIMITS.seen);
    pushCapped(g.commitLog, { e: String(state.groupContext.epoch), b: b64(bytes), t: this.now() }, LIMITS.commitLog);
    ctx.posts.push({ topic: g.topic, bytes });
    ctx.zero.push(...r.consumed);
    if (!addOnly) g.lastPath = this.now();
    return { state: r.newState, welcome: r.welcome };
  }

  _forget(g, ctx, status) {
    try {
      wipeState(this._state(g));
    } catch {
      /* nothing to wipe */
    }
    Object.assign(g, { status, mls: "", seen: [], held: [], commitLog: [], invites: {} });
    ctx.unsubscribe.push(g.topic);
  }

  /** Re-checks every leaf against the chain: verified (key = the name's msg), keyChanged (it no longer is). */
  async _roster(g, state, ctx) {
    const before = g.members;
    const now = {};
    for (const l of leaves(state)) {
      const addr = ADDR_RE.test(l.pid);
      const chain = addr ? unhex(l.pid.slice(2)) : await this.resolver.msgKey(l.pid).catch(() => null);
      const verified = eqBytes(chain, l.key);
      now[l.pid] = { key: hex(l.key), verified, keyChanged: !verified };
      if (!verified && !before[l.pid]?.keyChanged) ctx.events.push({ type: "key-changed", groupId: g.id, member: l.pid });
    }
    const added = Object.keys(now).filter((p) => !before[p]);
    const removed = Object.keys(before).filter((p) => !now[p]);
    g.members = now;
    if (added.length || removed.length) ctx.events.push({ type: "members", groupId: g.id, added, removed, members: Object.keys(now) });
  }

  // ---------- incoming ----------
  /** incoming(topic, bytes, meta) -> true when the payload was for the group engine. */
  async incoming(topic, bytes, meta = {}) {
    return this.incomingMany([{ topic, bytes, meta }]).then((n) => n > 0);
  }

  /** incomingMany([{ topic, bytes, meta }]) -> how many payloads were for the group engine. Batches are
   * processed per group in epoch order (messages before the commit that closes their epoch). */
  async incomingMany(items) {
    let handled = 0;
    const byGroup = new Map();
    for (const it of items) {
      const bytes = it.bytes instanceof Uint8Array ? it.bytes : unb64(String(it.bytes));
      if (it.topic === this.inbox) {
        if (bytes[0] !== 2) continue; // v1: the chat's, not ours
        handled++;
        await this._mutate((d, ctx) => this._control_in(d, ctx, bytes)).catch(() => {});
        continue;
      }
      const g = Object.values(this.data.groups).find((x) => x.topic === it.topic && x.status === "active");
      if (!g) continue;
      handled++;
      if (!byGroup.has(g.id)) byGroup.set(g.id, []);
      byGroup.get(g.id).push(bytes);
    }
    for (const [gid, list] of byGroup) {
      await this._mutate(async (d, ctx) => {
        const g = d.groups[gid];
        if (g?.status === "active") await this._groupBatch(d, ctx, g, list);
      }).catch(() => {});
    }
    return handled;
  }

  _parse(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > LIMITS.payloadBytes || bytes[0] !== FRAME) return null;
    const m = mls.decodeMlsMessage(bytes.subarray(1), 0)?.[0];
    if (!m || m.wireformat !== "mls_private_message") return { bytes, h: hashHex(bytes), bad: true };
    const pm = m.privateMessage;
    return { bytes, h: hashHex(bytes), pm, epoch: pm.epoch, commit: pm.contentType === "commit" };
  }

  async _groupBatch(d, ctx, g, list) {
    const wasHeld = g.held.length;
    let state = this._state(g);
    const queue = [];
    for (const bytes of list) {
      let it;
      try {
        it = this._parse(bytes);
      } catch {
        it = null;
      }
      if (!it) {
        this._count(d, "not-a-group-message", ctx);
        continue;
      }
      if (g.seen.includes(it.h) || g.held.some((x) => x.h === it.h)) {
        this._count(d, "duplicate", null);
        continue;
      }
      if (it.bad) {
        pushCapped(g.seen, it.h, LIMITS.seen);
        this._count(d, "not-a-private-message", ctx); // external commits and public messages: never processed
        continue;
      }
      if (hex(it.pm.groupId) !== g.id) {
        pushCapped(g.seen, it.h, LIMITS.seen);
        this._count(d, "wrong-group", ctx);
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
      if (it.epoch > state.groupContext.epoch) {
        if (g.held.length < LIMITS.held) g.held.push({ h: it.h, e: String(it.epoch), b: b64(it.bytes), t: this.now() });
        else this._count(d, "held-overflow", ctx);
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
    // the admin removes members who asked to leave
    if (g.role === "admin" && leaving.length) {
      const ls = leaves(state).filter((l) => leaving.includes(l.index) && l.index !== ADMIN_LEAF);
      if (ls.length) {
        state = (await this._commit(d, ctx, g, state, ls.map((l) => ({ proposalType: "remove", remove: { removed: l.index } })))).state;
        await this._roster(g, state, ctx);
      }
    }
    this._keep(g, state);
    if (g.held.length && !wasHeld) {
      g.behindSince = this.now();
      ctx.events.push({ type: "catching-up", groupId: g.id, held: g.held.length });
    } else if (!g.held.length && wasHeld) {
      delete g.behindSince;
      ctx.events.push({ type: "caught-up", groupId: g.id });
    }
  }

  /** One message at or before the current epoch. Every library exception is caught: the message is dropped and
   * counted, the state stays as it was. */
  async _one(d, ctx, g, state, it, leaving) {
    const current = state.groupContext.epoch;
    try {
      const sender = await this._senderOf(state, it.pm);
      const r = await mls.processPrivateMessage(state, it.pm, mls.makePskIndex(state, {}), this.impl, ONLY_ADMIN_COMMITS);
      pushCapped(g.seen, it.h, LIMITS.seen);
      ctx.zero.push(...r.consumed);
      if (r.kind === "applicationMessage") {
        this._onApp(d, ctx, g, sender, r.message, it.epoch, it.epoch < current, leaving);
        return { state: r.newState };
      }
      if (r.actionTaken === "reject") {
        this._count(d, it.commit ? (sender.index === undefined ? "external-commit" : "commit-not-from-admin") : "proposal-refused", ctx);
        return { state: r.newState };
      }
      if (!it.commit) return { state: r.newState };
      const after = r.newState;
      if (after.groupActiveState?.kind === "removedFromGroup") {
        wipeState(after);
        this._forget(g, ctx, "removed");
        ctx.events.push({ type: "removed", groupId: g.id });
        return { state: after };
      }
      this._trackGaps(g, ctx, current);
      await this._roster(g, after, ctx);
      return { state: after, epochChanged: true };
    } catch (e) {
      // a commit for the current epoch may work later (e.g. once a resend brings what it needs): not marked seen
      if (!(it.commit && it.epoch === current)) pushCapped(g.seen, it.h, LIMITS.seen);
      const msg = String(e?.message ?? "");
      this.lastLibraryError = msg; // memory only, for tests and debugging; never stored or emitted
      this._count(d, /too old|former epoch/.test(msg) ? "epoch-too-old" : /gen in the past/.test(msg) ? "already-read" : "library-error", ctx);
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

  _onApp(d, ctx, g, sender, data, epoch, late, leaving) {
    let obj;
    try {
      obj = JSON.parse(td.decode(data));
    } catch {
      return this._count(d, "bad-content", ctx);
    }
    g.gaps ??= {};
    const gaps = (g.gaps[String(epoch)] ??= {});
    const s = (gaps[sender.index] ??= { max: -1, got: 0 });
    if (!late) {
      s.max = Math.max(s.max, sender.generation);
      s.got++;
    }
    const m = g.members[sender.pid];
    const verified = !!m && m.key === hex(sender.key) && m.verified;
    if (obj?.t === "m" && typeof obj.text === "string" && obj.text.length <= LIMITS.textChars) {
      ctx.events.push({ type: "message", groupId: g.id, from: sender.pid, address: hex(sender.key), text: obj.text, ts: Number.isSafeInteger(obj.ts) ? obj.ts : null, late, verified });
    } else if (obj?.t === "rn" && typeof obj.name === "string" && obj.name.length <= LIMITS.groupNameChars) {
      if (sender.index !== ADMIN_LEAF) return this._count(d, "rename-not-from-admin", ctx);
      g.name = obj.name;
      ctx.events.push({ type: "renamed", groupId: g.id, name: obj.name });
    } else if (obj?.t === "leave") {
      if (g.role === "admin" && sender.index !== ADMIN_LEAF) leaving.push(sender.index);
    } else this._count(d, "bad-content", ctx);
  }

  // ---------- sealed control messages (v2) on the inbox ----------
  async _control_in(d, ctx, bytes) {
    const h = hashHex(bytes);
    if (d.seen.includes(h)) return this._count(d, "duplicate", null);
    pushCapped(d.seen, h, LIMITS.seen);
    const m = openControl(this.msgSecret, bytes);
    if (!m) return this._count(d, "unreadable-control", ctx);
    let pid;
    let senderVerified;
    if (NAMELESS_RE.test(m.from)) {
      if (m.from !== "msg-" + m.fromKey.slice(0, 16)) return this._count(d, "bad-sender", ctx);
      pid = "k:" + m.fromKey;
      senderVerified = true; // an address proves itself
    } else {
      pid = m.from;
      senderVerified = eqBytes(await this.resolver.msgKey(pid).catch(() => null), unhex(m.fromKey));
    }
    let body;
    try {
      body = JSON.parse(td.decode(m.bytes));
    } catch {
      return this._count(d, "bad-control", ctx);
    }
    try {
      await this._onControl(d, ctx, m.kind, body, pid, m.fromKey, senderVerified);
    } catch (e) {
      this._count(d, e instanceof GroupError ? "control-refused" : "library-error", ctx);
    }
  }

  async _onControl(d, ctx, kind, body, pid, fromKey, senderVerified) {
    const gid = typeof body?.gid === "string" && /^[0-9a-f]{64}$/.test(body.gid) ? body.gid : null;
    if (!gid) return this._count(d, "bad-control", ctx);
    const g = d.groups[gid];
    switch (kind) {
      case "kp-request": {
        if (g?.status === "active") return;
        if (typeof body.req !== "string" || typeof body.name !== "string") return this._count(d, "bad-control", ctx);
        const inv = { id: hex(rand(8)), gid, groupName: body.name.slice(0, LIMITS.groupNameChars), from: pid, fromKey, req: body.req, verified: senderVerified, ts: this.now() };
        const rj = d.rejoin[gid];
        if (rj && rj.admin === pid && senderVerified) {
          // we asked to be re-added (restore): answer without asking the user again
          delete d.rejoin[gid];
          await this._answerInvite(d, ctx, inv);
          return;
        }
        const old = Object.values(d.invites).find((x) => x.gid === gid);
        if (old) delete d.invites[old.id];
        if (Object.keys(d.invites).length >= LIMITS.invites) return this._count(d, "too-many-invites", ctx);
        d.invites[inv.id] = inv;
        ctx.events.push({ type: "invite", inviteId: inv.id, groupId: gid, groupName: inv.groupName, from: pid, verified: senderVerified });
        return;
      }
      case "kp": {
        if (!g || g.role !== "admin" || g.status !== "active") return this._count(d, "control-refused", ctx);
        const inv = g.invites[pid];
        if (!inv || inv.req !== body.req || inv.key !== fromKey) return this._count(d, "control-refused", ctx);
        const msg = mls.decodeMlsMessage(unb64(String(body.kp)), 0)?.[0];
        if (msg?.wireformat !== "mls_key_package") return this._count(d, "bad-control", ctx);
        const kp = msg.keyPackage;
        // the leaf must be the invited name's (or address's) key, now as at invite time
        const keyNow = await this._keyOf(pid);
        if (leafPid(kp.leafNode) !== pid || hex(leafMsgKey(kp.leafNode)) !== inv.key || !eqBytes(keyNow, unhex(inv.key))) {
          delete g.invites[pid];
          ctx.events.push({ type: "invite-failed", groupId: gid, member: pid, code: "KEY_CHANGED" });
          return;
        }
        let state = this._state(g);
        const old = leaves(state).find((l) => l.pid === pid);
        // A re-add removes the old leaf in its own commit first: ts-mls 1.6.4 decides "was I removed?" by
        // whether the device's leaf slot is blank afterwards, so a Remove and an Add that refills the same slot
        // in one commit leave the old device stuck ("No overlap between provided private keys and update path").
        if (old) state = (await this._commit(d, ctx, g, state, [{ proposalType: "remove", remove: { removed: old.index } }])).state;
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
        const j = d.joins[gid];
        if (!j || j.admin !== pid || j.adminKey !== fromKey) return this._count(d, "control-refused", ctx);
        const wm = mls.decodeMlsMessage(unb64(String(body.welcome)), 0)?.[0];
        const kpm = mls.decodeMlsMessage(unb64(j.kp), 0)?.[0];
        if (wm?.wireformat !== "mls_welcome" || !kpm) return this._count(d, "bad-control", ctx);
        const priv = { initPrivateKey: unhex(j.init), hpkePrivateKey: unhex(j.hpke), signaturePrivateKey: this.seed };
        const state = await mls.joinGroup(wm.welcome, kpm.keyPackage, priv, mls.emptyPskIndex, this.impl, undefined, undefined, clientConfig);
        const admin = state.ratchetTree[ADMIN_LEAF * 2];
        if (admin?.nodeType !== "leaf" || leafPid(admin.leaf) !== j.admin || hex(leafMsgKey(admin.leaf)) !== j.adminKey) {
          wipeState(state);
          return this._count(d, "welcome-not-from-admin", ctx);
        }
        if (typeof body.topicKey !== "string" || !/^[0-9a-f]{64}$/.test(body.topicKey)) return this._count(d, "bad-control", ctx);
        delete d.joins[gid];
        const ng = {
          id: gid, name: String(body.name ?? j.name).slice(0, LIMITS.groupNameChars), admin: j.admin, adminKey: j.adminKey, role: "member", status: "active",
          topicKey: body.topicKey, topic: topicOf(unhex(body.topicKey)), mls: "", epoch: "0", seen: [], held: [], commitLog: [], invites: {}, members: {}, created: this.now(),
        };
        this._keep(ng, state);
        d.groups[gid] = ng;
        await this._roster(ng, state, ctx);
        ctx.subscribe.push(ng.topic);
        ctx.events.push({ type: "joined", groupId: gid, name: ng.name, admin: ng.admin });
        return;
      }
      case "resend-request": {
        if (!g || g.role !== "admin" || g.status !== "active") return this._count(d, "control-refused", ctx);
        const state = this._state(g);
        const member = leaves(state).find((l) => l.pid === pid && hex(l.key) === fromKey);
        if (!member) return this._count(d, "control-refused", ctx);
        const from = BigInt(String(body.fromEpoch ?? "0"));
        const items = g.commitLog.filter((c) => BigInt(c.e) >= from);
        const tooOld = !g.commitLog.length || BigInt(g.commitLog[0].e) > from;
        // chunks that fit a sealed control message (base64 grows by 4/3; leave room for the JSON around it)
        let chunk = [];
        let size = 0;
        const out = () => {
          this._control(ctx, fromKey, "commits", { gid, items: chunk, tooOld });
          chunk = [];
          size = 0;
        };
        for (const c of items) {
          if (size + c.b.length > 40_000 && chunk.length) out();
          chunk.push(c.b);
          size += c.b.length;
        }
        if (chunk.length || tooOld) out();
        return;
      }
      case "commits": {
        if (!g || g.role !== "member" || g.status !== "active" || g.admin !== pid || g.adminKey !== fromKey) return this._count(d, "control-refused", ctx);
        if (body.tooOld) ctx.events.push({ type: "needs-readd", groupId: gid, reason: "the admin no longer has the commits this device missed" });
        const list = (Array.isArray(body.items) ? body.items : []).filter((x) => typeof x === "string").map(unb64);
        await this._groupBatch(d, ctx, g, list);
        return;
      }
      case "rejoin-request": {
        if (!g || g.role !== "admin" || g.status !== "active") return this._count(d, "control-refused", ctx);
        if (!senderVerified) return this._count(d, "control-refused", ctx);
        const state = this._state(g);
        const known = leaves(state).some((l) => l.pid === pid) || !!g.members[pid];
        if (!known) return this._count(d, "control-refused", ctx);
        ctx.events.push({ type: "rejoin-request", groupId: gid, member: pid });
        this._inviteIn(d, ctx, g, pid, unhex(fromKey), true);
        return;
      }
      default:
        return this._count(d, "bad-control", ctx);
    }
  }

  // ---------- time ----------
  /** tick(): call every few seconds to a minute. Retries posts, asks for missed commits, admin self-update. */
  async tick() {
    await this._mutate(async (d, ctx) => {
      const now = this.now();
      for (const g of Object.values(d.groups)) {
        if (g.status !== "active") continue;
        if (g.role === "member" && g.held.length) {
          const oldest = Math.min(...g.held.map((x) => x.t));
          if (now - oldest > this.timings.resendAfterMs && now - (g.lastResend ?? 0) > this.timings.resendGapMs) {
            g.lastResend = now;
            this._control(ctx, g.adminKey, "resend-request", { gid: g.id, fromEpoch: g.epoch });
          }
          if (now - oldest > this.timings.needsReaddAfterMs && !g.toldNeedsReadd) {
            g.toldNeedsReadd = true;
            ctx.events.push({ type: "needs-readd", groupId: g.id, reason: "missed commits could not be recovered" });
          }
        }
        if (g.role === "admin" && now - (g.lastPath ?? 0) > this.timings.adminRefreshMs) {
          this._keep(g, (await this._commit(d, ctx, g, this._state(g), [])).state);
        }
        if (g.role === "admin") for (const [p, inv] of Object.entries(g.invites)) if (now - inv.ts > this.timings.inviteTtlMs) delete g.invites[p];
      }
    }).catch(() => {});
  }

  // ---------- backup ----------
  /** exportBackup() -> a plain object with the group list only (no keys, no MLS state). */
  exportBackup() {
    return this._backupOf(this.data);
  }
  _backupOf(d) {
    return {
      v: 1,
      kind: "names-groups",
      groups: Object.values(d.groups)
        .filter((g) => g.status === "active")
        .map((g) => ({ id: g.id, name: g.name, admin: g.admin, adminKey: g.adminKey, role: g.role, members: Object.keys(g.members) })),
    };
  }
  /** importBackup(backup): on a restored device, asks each group's admin to re-add it. Groups this device was
   * the admin of can't be recovered (no one else can change their members): reported as admin-lost. */
  async importBackup(backup) {
    return this._mutate(async (d, ctx) => {
      for (const b of backup?.groups ?? []) {
        if (typeof b?.id !== "string" || d.groups[b.id]?.status === "active") continue;
        if (b.role === "admin") {
          ctx.events.push({ type: "admin-lost", groupId: b.id, name: b.name });
          continue;
        }
        const adminKey = ADDR_RE.test(b.admin) ? unhex(b.admin.slice(2)) : await this.resolver.msgKey(b.admin).catch(() => null);
        if (!adminKey) {
          ctx.events.push({ type: "needs-readd", groupId: b.id, reason: "the admin has no messaging address" });
          continue;
        }
        d.rejoin[b.id] = { admin: b.admin, adminKey: hex(adminKey), name: b.name, ts: this.now() };
        this._control(ctx, hex(adminKey), "rejoin-request", { gid: b.id });
        ctx.events.push({ type: "rejoin-requested", groupId: b.id, name: b.name, admin: b.admin });
      }
    });
  }
}

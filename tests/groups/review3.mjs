// Scenarios from review 3 of groups.js (at 00f9a88). They run on an in-memory bus (no fake node, no ports, a
// clock the test moves), in Node and in the browser page. Each "review 3 <item>" scenario failed at 00f9a88
// (GROUPS_ENGINE=<that groups.js> node tests/groups_test.mjs --only "review 3"); the "guard" ones passed there
// and pin behaviour the fixes must not break.
import * as mls from "../app/messages/mls.js";
import { createGroupEngine, LIMITS } from "../app/messages/groups.js";
import { sealControl, openControl, b64, unb64 } from "../app/messages/msg-v2.js";
import { inboxTopic } from "../app/messages/msg-crypto.js";
import { ed25519, x25519 } from "../app/noble-curves/ed25519.js";
import { xchacha20poly1305 } from "../app/messages/noble-ciphers/chacha.js";
import { hkdf } from "../app/messages/noble-hashes/hkdf.js";
import { sha256 } from "../app/messages/noble-hashes/sha2.js";

const te = new TextEncoder();
const td = new TextDecoder();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const clientConfig = {
  keyRetentionConfig: mls.defaultKeyRetentionConfig,
  lifetimeConfig: mls.defaultLifetimeConfig,
  keyPackageEqualityConfig: mls.defaultKeyPackageEqualityConfig,
  paddingConfig: mls.defaultPaddingConfig,
  authService: mls.defaultAuthenticationService,
};
const frame = (msg) => {
  const enc = mls.encodeMlsMessage(msg);
  const out = new Uint8Array(enc.length + 1);
  out[0] = 0x47;
  out.set(enc, 1);
  return out;
};

// ---------- the bus: devices, a fake chain, a clock ----------
class Bus {
  constructor() {
    this.chain = new Map(); // name -> msg key
    this.clients = [];
    this.posted = []; // { from, topic, bytes }
    this.clock = 1_700_000_000_000;
    this.down = new Set(); // names whose lookup throws
  }
  now = () => this.clock;
  resolver() {
    return {
      msgKey: async (name) => {
        if (this.down.has(name) || this.down.has("*")) throw new Error("chain unreachable");
        return this.chain.get(name) ?? null;
      },
    };
  }
}
function storage() {
  const s = { version: 0, blob: null, writes: 0, bytes: 0 };
  s.read = async () => (s.blob ? { version: s.version, blob: s.blob } : null);
  s.write = async (blob, base) => {
    if (base !== s.version) return { ok: false, version: s.version };
    s.version++;
    s.writes++;
    s.bytes += blob.length;
    s.blob = blob;
    return { ok: true, version: s.version };
  };
  return s;
}
function cipherWith(key) {
  return {
    async encrypt(b) {
      const n = rand(24);
      const ct = xchacha20poly1305(key, n).encrypt(b);
      const o = new Uint8Array(24 + ct.length);
      o.set(n);
      o.set(ct, 24);
      return o;
    },
    async decrypt(b) {
      return xchacha20poly1305(key, b.subarray(0, 24)).decrypt(b.subarray(24));
    },
  };
}
/** The page cipher GROUPS-PLAN 6.8 specifies: keyed from the msg secret, so another seed can't read the blob. */
const seedCipher = (seed) => cipherWith(hkdf(sha256, ed25519.utils.toMontgomerySecret(seed), new Uint8Array(0), te.encode("names/group/v1/state"), 32));

/** A device on the bus. held = true: nothing is fed to it (its queue fills). keepRetries = false: what the
 * engine hands back is dropped (a page that forgets it, e.g. after a restart). */
async function client(bus, name, opts = {}) {
  const c = { name, seed: opts.seed ?? ed25519.utils.randomSecretKey(), queue: [], retry: [], subs: new Set(), events: [], held: false, keepRetries: true };
  c.seed0 = c.seed.slice();
  c.msgKey = ed25519.utils.toMontgomery(ed25519.getPublicKey(c.seed));
  c.msgSecret = ed25519.utils.toMontgomerySecret(c.seed);
  c.keyHex = hex(c.msgKey);
  if (name && opts.publish !== false) bus.chain.set(name, c.msgKey);
  c.storage = opts.storage ?? storage();
  c.cipher = opts.cipher ?? cipherWith(rand(32));
  c.transport = {
    post: async (topic, bytes) => {
      bus.posted.push({ from: c, topic, bytes, t: bus.clock });
      for (const o of bus.clients) if (o.subs.has(topic)) o.queue.push({ topic, bytes });
    },
    subscribe: async (ts) => ts.forEach((t) => c.subs.add(t)),
    unsubscribe: async (ts) => ts.forEach((t) => c.subs.delete(t)),
  };
  c.subs.add(inboxTopic(c.msgKey)); // before the engine starts: it may post at once (replaceDeviceKey)
  bus.clients.push(c);
  c.engine = await createGroupEngine({ me: { name, seed: c.seed }, transport: c.transport, resolver: bus.resolver(), storage: c.storage, cipher: c.cipher, now: bus.now, ...(opts.engine ?? {}) });
  c.engine.onEvent((e) => c.events.push(e));
  return c;
}
/** Feeds every device what its node has (50 per read), and what the engine handed back. */
async function settle(bus, rounds = 40) {
  for (let r = 0; r < rounds; r++) {
    let moved = 0;
    for (const c of bus.clients) {
      if (c.held || c.gone || (!c.queue.length && !c.retry.length)) continue;
      const items = [...c.retry.splice(0), ...c.queue.splice(0, 50)];
      moved += items.length;
      const res = await c.engine.incomingMany(items);
      if (c.keepRetries) for (const i of res.failed) c.retry.push(items[i]);
    }
    if (!moved) return;
  }
}
const of = (c, type, gid) => c.events.filter((e) => e.type === type && (gid === undefined || e.groupId === gid));
const msgs = (c, gid) => of(c, "message", gid).map((e) => e.text);
const gt = (c, gid) => c.engine.data.groups[gid];
const epoch = (c, gid) => gt(c, gid)?.epoch;
const stateOf = (c, gid) => ({ ...mls.decodeGroupState(unb64(gt(c, gid).mls), 0)[0], clientConfig });
const framesFrom = (bus, c, n0) => bus.posted.slice(n0).filter((p) => p.from === c && p.bytes[0] === 0x47).length;
const controlsTo = (bus, c, n0 = 0) =>
  bus.posted.slice(n0).filter((p) => p.topic === c.engine.inbox && p.bytes[0] === 2).map((p) => ({ p, m: openControl(c.msgSecret, p.bytes) })).filter((x) => x.m);
const bodyOf = (m) => JSON.parse(td.decode(m.bytes));
/** A sealed control message from `from` (a client or { name, msgSecret, keyHex }) to client `to`. */
const seal = (from, to, kind, obj, ts) => ({
  topic: to.engine.inbox,
  bytes: sealControl({ to: to.msgKey, from: from.name || "msg-" + from.keyHex.slice(0, 16), fromSecret: from.msgSecret, kind, bytes: te.encode(JSON.stringify(obj)), ts: ts ?? Date.now() }),
});
const freeKey = () => {
  const s = x25519.utils.randomSecretKey();
  return { name: "", msgSecret: s, keyHex: hex(x25519.getPublicKey(s)) };
};
/** alice (admin) and these members, joined one at a time. */
async function group(names = ["bob", "carol"]) {
  const bus = new Bus();
  const A = await client(bus, "alice");
  const M = [];
  for (const n of names) M.push(await client(bus, n));
  const { id: gid } = await A.engine.createGroup("friends", names);
  await settle(bus);
  for (const X of M) {
    await X.engine.acceptInvite(X.engine.listInvites().find((i) => i.groupId === gid).id);
    await settle(bus);
  }
  const eps = new Set([A, ...M].map((x) => epoch(x, gid)));
  if (eps.size !== 1) throw new Error("group not in step: " + [...eps]);
  return { bus, A, M, gid };
}
const needsPathFirst = (s) => s.ratchetTree.some((n) => n?.nodeType === "parent" && n.parent.unmergedLeaves.length > 0);
/** A key package for c's key whose signature has one bit flipped: the engine's own checks pass, ts-mls refuses it. */
async function badKp(c, identity) {
  const kp = await mls.generateKeyPackageWithKey({ credentialType: "basic", identity: te.encode(identity) }, mls.defaultCapabilities(), mls.defaultLifetime, [], { signKey: c.seed.slice(), publicKey: ed25519.getPublicKey(c.seed) }, c.engine.impl);
  const pub = kp.publicPackage;
  pub.signature = pub.signature.slice();
  pub.signature[0] ^= 1;
  return b64(mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage: pub }));
}
const lastKpRequest = (bus, c) => bodyOf(controlsTo(bus, c).filter((x) => x.m.kind === "kp-request").at(-1).m);
/** A well-formed frame claiming this group and epoch, random content (anyone who knows the topic can post it). */
const forged = (gid, ep, size = 2000) =>
  frame({ version: "mls10", wireformat: "mls_private_message", privateMessage: { groupId: unhex(gid), epoch: ep, contentType: "application", authenticatedData: new Uint8Array(0), encryptedSenderData: rand(32), ciphertext: rand(size) } });
const isCommit = (bytes) => mls.decodeMlsMessage(bytes.subarray(1), 0)?.[0]?.privateMessage?.contentType === "commit";
async function code(p) {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e?.code ?? `${e?.constructor?.name}: ${e?.message}`;
  }
}

export const REVIEW3 = {
  // ---------- M1: every commit path all or nothing ----------
  async "review 3 M1: a bad key package after a self-update changes nothing (#860 path)"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    bus.clock += DAY + 1000;
    await A.engine.tick(); // the daily self-update: parent nodes now have unmerged leaves after the next add
    await settle(bus);
    const D = await client(bus, "dave");
    await A.engine.invite(gid, "dave");
    await settle(bus);
    await D.engine.acceptInvite(D.engine.listInvites()[0].id);
    await settle(bus);
    const X = await client(bus, "mallory");
    X.held = true; // answers by hand
    await A.engine.invite(gid, "mallory");
    await settle(bus);
    const req = lastKpRequest(bus, X).req;
    check("(an Add now needs the #860 empty commit first)", needsPathFirst(stateOf(A, gid)));
    const e0 = epoch(A, gid);
    const n0 = bus.posted.length;
    const w0 = A.storage.writes;
    await A.engine.incomingMany([seal(X, A, "kp", { gid, req, kp: await badKp(X, "mallory") })]);
    check("the admin posted no commit", framesFrom(bus, A, n0) === 0, `${framesFrom(bus, A, n0)} frames`);
    check("the admin's stored and MLS epochs are unchanged", epoch(A, gid) === e0 && String(stateOf(A, gid).groupContext.epoch) === e0);
    check("the admin is told the invitation failed", of(A, "invite-failed", gid).some((e) => e.member === "mallory" && e.code === "BAD_KEY_PACKAGE"));
    check("one state write for it (the invitation ends)", A.storage.writes - w0 === 1 && !A.engine.listGroups()[0].invited.includes("mallory"), `${A.storage.writes - w0} writes`);
    await settle(bus);
    check("members stay in step with the admin", [B, C, D].every((x) => epoch(x, gid) === e0), [B, C, D].map((x) => epoch(x, gid)).join());
    bus.clock += DAY + 1000;
    await A.engine.tick();
    await settle(bus);
    await A.engine.send(gid, "alice next day");
    await B.engine.send(gid, "bob next day");
    await settle(bus);
    check("the next day both ways still work", msgs(B, gid).includes("alice next day") && msgs(A, gid).includes("bob next day") && msgs(D, gid).includes("bob next day"));
  },

  async "review 3 M1: a bad key package on a key-change re-add changes nothing"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    const B2 = await client(bus, "bob"); // bob's name now points at a new device key
    B2.held = true;
    await B2.engine.importBackup(B.engine.exportBackup()); // asks to be re-added
    await settle(bus);
    const req = lastKpRequest(bus, B2).req;
    const topic0 = gt(A, gid).topic;
    const e0 = epoch(A, gid);
    const n0 = bus.posted.length;
    await A.engine.incomingMany([seal(B2, A, "kp", { gid, req, kp: await badKp(B2, "bob") })]);
    check("no removal commit and no topic change went out", framesFrom(bus, A, n0) === 0 && gt(A, gid).topic === topic0, `${framesFrom(bus, A, n0)} frames`);
    check("the admin's MLS state didn't move", epoch(A, gid) === e0 && String(stateOf(A, gid).groupContext.epoch) === e0);
    check("the admin is told", of(A, "invite-failed", gid).some((e) => e.code === "BAD_KEY_PACKAGE"));
    await settle(bus);
    check("bob's old device is still in, everyone in step", gt(B, gid).status === "active" && epoch(B, gid) === e0 && epoch(C, gid) === e0);
    await C.engine.send(gid, "carol after");
    await A.engine.send(gid, "alice after");
    await settle(bus);
    check("alice and carol still read each other", msgs(A, gid).includes("carol after") && msgs(C, gid).includes("alice after"));
  },

  async "review 3 M1: a member alone can't split the admin off (restore request + bad key package)"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    B.held = true;
    const n00 = bus.posted.length;
    await A.engine.incomingMany([seal(B, A, "rejoin-request", { gid, restore: true })]);
    const req = bodyOf(controlsTo(bus, B, n00).find((x) => x.m.kind === "kp-request").m).req;
    B.queue.splice(0);
    const e0 = epoch(A, gid);
    const n0 = bus.posted.length;
    await A.engine.incomingMany([seal(B, A, "kp", { gid, req, kp: await badKp(B, "bob") })]);
    B.held = false;
    await settle(bus);
    check("nothing posted, nothing moved", framesFrom(bus, A, n0) === 0 && epoch(A, gid) === e0 && epoch(C, gid) === e0 && epoch(B, gid) === e0);
    bus.clock += DAY + 1000;
    await A.engine.tick();
    await settle(bus);
    await A.engine.send(gid, "alice next day");
    await C.engine.send(gid, "carol next day");
    await settle(bus);
    check("the group still works for everyone", msgs(C, gid).includes("alice next day") && msgs(A, gid).includes("carol next day") && msgs(B, gid).includes("alice next day"));
  },

  async "review 3 M1: an admin commit that fails halfway (tick, leave) posts and keeps nothing"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    const real = A.engine._commit.bind(A.engine);
    let boom = 0;
    A.engine._commit = async (...args) => {
      const r = await real(...args); // the commit is built and queued in the step's posts...
      if (boom > 0) {
        boom--;
        throw new Error("injected: fails after the commit was built");
      }
      return r;
    };
    const e0 = epoch(A, gid);
    boom = 1;
    bus.clock += DAY + 1000;
    let n0 = bus.posted.length;
    await A.engine.tick();
    check("a self-update that fails posts nothing and keeps the epoch", framesFrom(bus, A, n0) === 0 && epoch(A, gid) === e0 && String(stateOf(A, gid).groupContext.epoch) === e0 && A.engine.stats()["self-update-failed"] === 1);
    await A.engine.tick();
    check("...and isn't retried on every tick", A.engine.stats()["self-update-failed"] === 1 && epoch(A, gid) === e0);
    bus.clock += HOUR + 1000;
    await A.engine.tick();
    await settle(bus);
    check("...it is retried an hour later and everyone follows", epoch(A, gid) !== e0 && epoch(B, gid) === epoch(A, gid) && epoch(C, gid) === epoch(A, gid));
    const e1 = epoch(A, gid);
    boom = 1;
    await C.engine.leave(gid);
    n0 = bus.posted.length;
    await settle(bus);
    check("a leave whose removal commit fails posts nothing", framesFrom(bus, A, n0) === 0 && epoch(A, gid) === e1 && A.engine.stats()["leave-commit-failed"] === 1);
    await A.engine.remove(gid, "carol");
    await settle(bus);
    await A.engine.send(gid, "after carol");
    await settle(bus);
    check("the admin can still remove by hand, and bob follows", msgs(B, gid).includes("after carol") && epoch(B, gid) === epoch(A, gid));
  },

  // ---------- M2: a lookup that fails is "try again", never another identity ----------
  async "review 3 M2: a chain outage while the Welcome is in: bob joins once it's back"({ check }) {
    const bus = new Bus();
    const A = await client(bus, "alice");
    const B = await client(bus, "bob");
    const { id: gid } = await A.engine.createGroup("friends", ["bob"]);
    await settle(bus);
    bus.clock += 5 * MIN; // the 60 s lookup cache is cold
    await B.engine.acceptInvite(B.engine.listInvites()[0].id);
    B.held = true;
    await settle(bus); // alice adds bob; the Welcome waits on bob's node
    B.held = false;
    bus.down.add("alice");
    for (let i = 0; i < 4; i++) await settle(bus, 1);
    check("no lookup was needed for the Welcome: bob joined even during the outage", gt(B, gid)?.status === "active", JSON.stringify(B.engine.stats()));
    bus.down.clear();
    await settle(bus);
    await A.engine.send(gid, "hello bob");
    await B.engine.send(gid, "hello alice");
    await settle(bus);
    check("they talk, in step", msgs(B, gid).includes("hello bob") && msgs(A, gid).includes("hello alice") && epoch(A, gid) === epoch(B, gid));
    check("bob's group shows alice verified", B.engine.listGroups()[0].admin === "alice" && B.engine.listGroups()[0].adminVerified === true);
  },

  async "review 3 M2: a chain outage while the key package is in: the add finishes once it's back"({ check }) {
    for (const keepRetries of [true, false]) {
      const bus = new Bus();
      const A = await client(bus, "alice");
      const B = await client(bus, "bob");
      A.keepRetries = keepRetries; // false: the page drops what was handed back (the key package must not be lost)
      const { id: gid } = await A.engine.createGroup("friends", ["bob"]);
      await settle(bus);
      bus.clock += 5 * MIN;
      await B.engine.acceptInvite(B.engine.listInvites()[0].id);
      bus.down.add("bob");
      for (let i = 0; i < 4; i++) await settle(bus, 1);
      const label = keepRetries ? "(page re-feeds)" : "(page drops hand-backs)";
      check(`${label} the admin is told the invitation waits for the chain`, of(A, "invite-waiting", gid).length === 1 && of(A, "names-unavailable").length >= 1);
      check(`${label} still invited, not refused`, A.engine.listGroups()[0].invited.includes("bob") && !of(A, "invite-failed").length);
      bus.down.clear();
      for (let i = 0; i < 3; i++) {
        bus.clock += MIN + 1000;
        await A.engine.tick();
        await settle(bus);
      }
      check(`${label} bob joins once the chain is back`, gt(B, gid)?.status === "active" && epoch(B, gid) === epoch(A, gid) && A.engine.listGroups()[0].members.some((m) => m.id === "bob" && m.verified));
    }
  },

  async "review 3 M2: an invitation that came during an outage is checked again when accepted"({ check }) {
    const bus = new Bus();
    const A = await client(bus, "alice");
    const B = await client(bus, "bob");
    bus.down.add("alice");
    const { id: gid } = await A.engine.createGroup("friends", ["bob"]);
    for (let i = 0; i < 4; i++) await settle(bus, 1);
    const inv = B.engine.listInvites()[0];
    check("after a few tries it is kept, shown as unchecked (not verified, not alice)", inv && inv.verified === false && inv.claimedName === "alice" && inv.from.startsWith("k:") && of(B, "invite").some((e) => e.unchecked === true));
    check("accepting while the chain is still down says try again", (await code(B.engine.acceptInvite(inv.id))) === "RESOLVER_UNAVAILABLE" && B.engine.listInvites().length === 1);
    bus.down.clear();
    await B.engine.acceptInvite(inv.id);
    await settle(bus);
    const g = B.engine.listGroups()[0];
    check("accepted once it's back: the group's admin is alice, verified", g?.status === "active" && g.admin === "alice" && g.adminVerified === true, JSON.stringify(g && { admin: g.admin, v: g.adminVerified }));
  },

  // ---------- S1 ----------
  async "review 3 S1: an older resend answer doesn't clear a newer far-ahead marker"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    B.held = true;
    bus.clock += DAY + 1000;
    await A.engine.tick(); // c1
    await A.engine.send(gid, "m1");
    const q1 = B.queue.splice(0);
    await B.engine.incomingMany(q1.filter((x) => !isCommit(x.bytes))); // c1 lost, m1 held
    bus.clock += 3 * MIN;
    await B.engine.tick(); // resend request
    await settle(bus); // alice answers; the answer waits on bob's node
    const answer = B.queue.splice(0);
    for (let k = 0; k < 3; k++) {
      bus.clock += DAY + 1000;
      await A.engine.tick(); // c2..c4
    }
    await A.engine.send(gid, "m5");
    const q2 = B.queue.splice(0);
    await B.engine.incomingMany(q2.slice(-1)); // only m5: too far ahead, sets the marker
    const set = !!gt(B, gid).ahead;
    await B.engine.incomingMany(answer);
    check("the marker set after the request survives the older answer", set && !!gt(B, gid).ahead, JSON.stringify(gt(B, gid).ahead));
    check("no caught-up while still behind", of(B, "caught-up").length === 0);
    B.held = false;
    for (let k = 0; k < 12; k++) {
      bus.clock += 5 * MIN;
      await B.engine.tick();
      await settle(bus);
    }
    check("bob keeps asking and catches up", epoch(B, gid) === epoch(A, gid) && of(B, "caught-up").length >= 1, `${epoch(B, gid)} vs ${epoch(A, gid)}`);
  },

  // ---------- S2 ----------
  async "review 3 S2: changing fromEpoch doesn't get around the resend back-off"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    for (let k = 0; k < 30; k++) {
      bus.clock += DAY + 1000;
      await A.engine.tick();
      await settle(bus);
    }
    const joined = BigInt(gt(A, gid).added?.[B.keyHex] ?? "0");
    B.held = true;
    const answerTimes = (n0) => controlsTo(bus, B, n0).filter((x) => x.p.from === A && x.m.kind === "commits" && bodyOf(x.m).last === true).map((x) => x.p.t);
    const answers = (n0) => answerTimes(n0).length;
    const ask = (i, from) => A.engine.incomingMany([seal(B, A, "resend-request", { gid, fromEpoch: String(from), n: hex(rand(16)) }, i)]);
    let n0 = bus.posted.length;
    for (let i = 0; i < 60; i++) {
      bus.clock += 61_000;
      await ask(i, i % 2 ? joined + 1n : joined);
    }
    const hour = answers(n0);
    check("an hour of requests alternating fromEpoch: a handful of answers", hour <= 7, `${hour} answers`);
    n0 = bus.posted.length;
    for (let i = 0; i < 288; i++) {
      bus.clock += 5 * MIN;
      await ask(i, i % 3 ? joined + BigInt(i % 3) : joined);
    }
    const ts = answerTimes(0);
    const worst = Math.max(...ts.map((t) => ts.filter((u) => u <= t && t - u < DAY).length));
    check(`a day more of requests every 5 minutes: at most ${LIMITS.resendPerDay} answers in any 24 hours`, worst <= LIMITS.resendPerDay, `${worst} in 24 h, ${answers(n0)} in the day`);
    B.queue.splice(0);
  },

  // ---------- S3 ----------
  async "review 3 S3: inbox controls cost one write per batch, and one key can't flush the seen list"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [V] = M;
    for (let k = 0; k < 10; k++) await V.engine.send(gid, "x".repeat(1500));
    await settle(bus);
    const T = freeKey();
    const fake = hex(rand(32));
    const w0 = V.storage.writes;
    const seen0 = V.engine.data.seen.length;
    let ts = Date.now();
    for (let b = 0; b < 10; b++) {
      const batch = [];
      for (let k = 0; k < 50; k++) batch.push(seal(T, V, "kp-request", { gid: fake, name: "spam", req: `r${b * 50 + k}` }, ts++));
      await V.engine.incomingMany(batch);
    }
    check("500 kp-requests from one free key in 10 batches: at most 10 writes", V.storage.writes - w0 <= 10, `${V.storage.writes - w0} writes`);
    check("...and the seen list grew by one (the first invitation only)", V.engine.data.seen.length - seen0 <= 1, `${V.engine.data.seen.length - seen0}`);
    check("one invitation listed for it", V.engine.listInvites().filter((i) => i.groupId === fake).length === 1);
    // a replayed older request can't put back an older request id
    const inv = V.engine.listInvites().find((i) => i.groupId === fake);
    const reqNow = V.engine.data.invites[inv.id].req;
    await V.engine.incomingMany([seal(T, V, "kp-request", { gid: fake, name: "spam", req: "r0-old" }, ts - 1000)]);
    check("an older message's request id doesn't replace a newer one", V.engine.data.invites[inv.id].req === reqNow);
  },

  async "review 3 S3: after a 4,000-message inbox flood a replayed answer drops nothing"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol", "dave"]);
    const [B] = M;
    B.held = true;
    bus.clock += DAY + 1000;
    await A.engine.tick();
    await A.engine.send(gid, "x1");
    let q = B.queue.splice(0);
    B.held = false;
    await B.engine.incomingMany(q.filter((x) => !isCommit(x.bytes)));
    bus.clock += 3 * MIN;
    await B.engine.tick();
    const n0 = bus.posted.length;
    await settle(bus);
    const recorded = bus.posted.slice(n0).filter((p) => p.from === A && p.topic === B.engine.inbox).map((p) => ({ topic: p.topic, bytes: p.bytes }));
    await A.engine.remove(gid, "dave"); // the topic changes; bob follows
    await settle(bus);
    const topicNow = gt(B, gid).topic;
    B.held = true;
    bus.clock += DAY + 1000;
    await A.engine.tick();
    await A.engine.send(gid, "x3");
    q = B.queue.splice(0).filter((x) => x.topic === topicNow);
    B.held = false;
    const commit = q.filter((x) => isCommit(x.bytes));
    await B.engine.incomingMany(q.filter((x) => !isCommit(x.bytes)));
    const T = freeKey();
    const fake = hex(rand(32));
    const w0 = B.storage.writes;
    let ts = Date.now();
    for (let i = 0; i < 4000; i += 50) {
      const batch = [];
      for (let k = 0; k < 50; k++) batch.push(seal(T, B, "kp-request", { gid: fake, name: "spam", req: `r${i + k}` }, ts++));
      await B.engine.incomingMany(batch);
    }
    check("4,000 from one key: at most one write per batch of 50", B.storage.writes - w0 <= 80, `${B.storage.writes - w0} writes`);
    await B.engine.incomingMany(recorded);
    const topicAfter = gt(B, gid).topic;
    await B.engine.incomingMany(commit);
    await settle(bus);
    check("the replayed answer dropped nothing and didn't move the topic back", msgs(B, gid).includes("x3") && topicAfter === topicNow && !B.engine.stats()["forged-future"]);
  },

  // ---------- S4 ----------
  async "review 3 S4: new keys one after another get one re-add a day, and the last one gets in"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol", "dave"]);
    const [B, C, D] = M;
    const e0 = BigInt(epoch(A, gid));
    D.held = true; // dave's node delivers late
    await C.engine.send(gid, "carol, just before");
    const backup = B.engine.exportBackup();
    const devs = [];
    for (let k = 0; k < 3; k++) {
      bus.clock += MIN;
      const next = await client(bus, "bob"); // a new msg key for bob on the chain: one transaction each
      await next.engine.importBackup(backup);
      await settle(bus);
      devs.push(next);
    }
    const e1 = BigInt(epoch(A, gid));
    check("three key changes in three minutes: one re-add", of(A, "rejoin-request").length === 1 && e1 - e0 <= 4n, `${of(A, "rejoin-request").length} re-adds, ${e1 - e0} epochs`);
    const first = D.queue.findIndex((x) => x.bytes[0] === 0x47);
    const late = D.queue.splice(first, 1);
    D.held = false;
    await settle(bus);
    await D.engine.incomingMany(late);
    check("a slow member still reads the message sent just before", msgs(D, gid).includes("carol, just before"), JSON.stringify(D.engine.stats()));
    for (let k = 0; k < 2; k++) {
      bus.clock += DAY / 2 + 1000;
      for (const c of bus.clients) await c.engine.tick();
      await settle(bus);
    }
    check("a day later the device the chain now names asks again and is re-added", gt(devs[2], gid)?.status === "active" && epoch(devs[2], gid) === epoch(A, gid), JSON.stringify({ d2: gt(devs[2], gid)?.status, rj: devs[2].engine.data.rejoin, joins: Object.keys(devs[2].engine.data.joins), ev: devs[2].events.map((e) => e.type), A: A.engine.stats(), Aev: A.events.map((e) => e.type).slice(-12), inv: A.engine.listGroups()[0].invited, d2s: devs[2].engine.stats() }));
    check("bob is one leaf, verified", A.engine.listGroups()[0].members.filter((m) => m.id === "bob").length === 1 && A.engine.listGroups()[0].members.find((m) => m.id === "bob").verified);
  },

  // ---------- S5 ----------
  async "review 3 S5: a pending re-add re-sends its key-package request at most every 10 minutes"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    B.held = true;
    await A.engine.incomingMany([seal(B, A, "rejoin-request", { gid, restore: true })]);
    const w0 = A.storage.writes;
    const n0 = bus.posted.length;
    for (let i = 0; i < 100; i++) await A.engine.incomingMany([seal(B, A, "rejoin-request", { gid, restore: true, i })]);
    const sent = controlsTo(bus, B, n0).filter((x) => x.m.kind === "kp-request").length;
    check("100 more requests: at most one re-send and two writes", sent <= 1 && A.storage.writes - w0 <= 2, `${sent} re-sends, ${A.storage.writes - w0} writes`);
    bus.clock += 11 * MIN;
    const n1 = bus.posted.length;
    await A.engine.incomingMany([seal(B, A, "rejoin-request", { gid, restore: true, later: 1 })]);
    check("ten minutes later it may re-send again", controlsTo(bus, B, n1).filter((x) => x.m.kind === "kp-request").length === 1);
    B.queue.splice(0);
  },

  // ---------- S6 ----------
  async "review 3 S6a: a member 40 commits behind catches up without a false needs-readd"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    B.held = true;
    A.engine.timings.adminRefreshMs = DAY / 24;
    for (let k = 0; k < 40; k++) {
      bus.clock += DAY / 20;
      await A.engine.tick();
    }
    await A.engine.send(gid, "after 40 commits");
    const q = B.queue.splice(0);
    B.held = false;
    await B.engine.incomingMany(q.slice(-1)); // the node's window lost the commits
    for (let k = 0; k < 40 && epoch(B, gid) !== epoch(A, gid); k++) {
      bus.clock += 2 * MIN;
      await B.engine.tick();
      await settle(bus);
    }
    check("bob caught up", epoch(B, gid) === epoch(A, gid), `${epoch(B, gid)} vs ${epoch(A, gid)}`);
    check("and was never told needs-readd", of(B, "needs-readd").length === 0);
  },

  async "review 3 S6b: a member that can't follow asks to be re-added, and it works"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    check("(the admin's invite() on a current member is still refused)", (await code(A.engine.invite(gid, "bob"))) === "ALREADY_MEMBER");
    // first the bad case: nobody asked; a replayed restore request or the admin's readd() alone change nothing
    await A.engine.readd(gid, "bob");
    await settle(bus);
    check("readd() without bob asking changes nothing on bob's device", gt(B, gid).status === "active" && !of(B, "joined", gid).some((e) => e.readd) && A.engine.listGroups()[0].invited.includes("bob"));
    // bob then asks: the admin's pending re-add re-sends its key-package request, and bob's device answers it
    const r = await B.engine.requestReadd(gid);
    check("requestReadd sends the request", r.asked === true && of(B, "rejoin-requested", gid).length === 1);
    const n0 = bus.posted.length;
    await settle(bus);
    const welcome = bus.posted.slice(n0).filter((p) => p.topic === B.engine.inbox && p.from === A).map((p) => ({ topic: p.topic, bytes: p.bytes, m: openControl(B.msgSecret, p.bytes) })).find((x) => x.m?.kind === "welcome");
    const g = gt(B, gid);
    check("bob is re-added: a fresh record from the admin's Welcome", g?.status === "active" && of(B, "joined", gid).some((e) => e.readd === true) && epoch(B, gid) === epoch(A, gid));
    check("one bob leaf at the admin", A.engine.listGroups()[0].members.filter((m) => m.id === "bob").length === 1);
    await A.engine.send(gid, "welcome back");
    await B.engine.send(gid, "thanks");
    await settle(bus);
    check("bob reads and is read", msgs(B, gid).includes("welcome back") && msgs(A, gid).includes("thanks") && msgs(C, gid).includes("thanks"));
    const e1 = epoch(B, gid);
    B.engine.data.seen.splice(0); // as if the inbox seen list had been flushed
    await B.engine.incomingMany([{ topic: welcome.topic, bytes: welcome.bytes }]);
    check("the re-add's Welcome replayed later changes nothing", epoch(B, gid) === e1 && gt(B, gid).status === "active" && of(B, "joined", gid).filter((e) => e.readd).length === 1);
    await B.engine.requestReadd(gid);
    check("asking twice within a day sends once", (await B.engine.requestReadd(gid)).asked === false);
  },

  // ---------- S7 ----------
  async "review 3 S7: a different seed refuses to start and changes nothing; replaceDeviceKey moves on"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    const v0 = B.storage.version;
    const blob0 = B.storage.blob;
    const opts = (seed, extra = {}) => ({ me: { name: "bob", seed }, transport: B.transport, resolver: bus.resolver(), storage: B.storage, cipher: B.cipher, now: bus.now, ...extra });
    check("an all-zero seed: DEVICE_KEY_CHANGED", (await code(createGroupEngine(opts(new Uint8Array(32))))) === "DEVICE_KEY_CHANGED");
    check("...and nothing was written", B.storage.version === v0 && B.storage.blob === blob0);
    const again = await createGroupEngine(opts(B.seed0));
    check("the right seed again: the group is there", again.data.groups[gid]?.status === "active");
    // the cipher GROUPS-PLAN 6.8 specifies (keyed from the seed): a key migration can't read the old blob
    const plain = await B.cipher.decrypt(B.storage.blob);
    B.storage.blob = await seedCipher(B.seed0).encrypt(plain);
    const blob1 = B.storage.blob;
    const v1 = B.storage.version;
    const newSeed = ed25519.utils.randomSecretKey();
    check("a new seed with the seed-keyed cipher: STATE_UNREADABLE, nothing written", (await code(createGroupEngine({ ...opts(newSeed), cipher: seedCipher(newSeed) }))) === "STATE_UNREADABLE" && B.storage.blob === blob1 && B.storage.version === v1);
    // the explicit migration: the old engine's backup, then the new key with replaceDeviceKey
    const old = await createGroupEngine({ ...opts(B.seed0), cipher: seedCipher(B.seed0) });
    const backup = old.exportBackup();
    B.gone = true;
    const B2 = await client(bus, "bob", { seed: newSeed, storage: B.storage, cipher: seedCipher(newSeed), engine: { replaceDeviceKey: backup } });
    check("replaceDeviceKey starts on an empty state and asks the admin", of(B2, "rejoin-requested", gid).length === 1 || Object.keys(B2.engine.data.rejoin).includes(gid));
    await settle(bus);
    check("the admin re-adds the new key; the new device is in", gt(B2, gid)?.status === "active" && epoch(B2, gid) === epoch(A, gid));
    await A.engine.send(gid, "new phone?");
    await settle(bus);
    check("and reads the group", msgs(B2, gid).includes("new phone?"));
  },

  // ---------- S8 ----------
  async "review 3 S8: names can't push out a contact's invitation"({ check }) {
    const bus = new Bus();
    const A = await client(bus, "alice");
    const V = await client(bus, "victim", { engine: { isContact: (n) => n === "alice" } });
    const { id: real } = await A.engine.createGroup("real", ["victim"]);
    await settle(bus);
    const had = V.engine.listInvites().some((i) => i.groupId === real);
    for (let n = 0; n < 17; n++) {
      const seed = ed25519.utils.randomSecretKey();
      const name = "squat" + n;
      const T = { name, msgSecret: ed25519.utils.toMontgomerySecret(seed), keyHex: hex(ed25519.utils.toMontgomery(ed25519.getPublicKey(seed))) };
      bus.chain.set(name, unhex(T.keyHex));
      for (let k = 0; k < 3; k++) {
        bus.clock += 1000;
        await V.engine.incomingMany([seal(T, V, "kp-request", { gid: hex(rand(32)), name: "spam", req: "r" + k })]);
      }
    }
    const list = V.engine.listInvites();
    check("51 invitations from 17 names: alice's (a contact) is still there", had && list.some((i) => i.groupId === real && i.from === "alice"));
    check("the list stays at its cap", list.length <= LIMITS.invites);
  },

  // ---------- S9 (documented limit) and review 2's held eviction ----------
  async "review 3 S9 (limit): a held-message flood stays within the buffer; old-topic junk goes first"({ check, log }) {
    const res = {};
    for (const onOld of [true, false]) {
      const { bus, A, M, gid } = await group(["bob", "carol", "dave"]);
      const [B] = M;
      await A.engine.remove(gid, "dave"); // the group gets an old topic
      await settle(bus);
      B.held = true;
      bus.clock += DAY + 1000;
      await A.engine.tick();
      await A.engine.send(gid, "real next epoch");
      const all = B.queue.splice(0);
      B.held = false;
      const commits = all.filter((x) => isCommit(x.bytes));
      await B.engine.incomingMany(all.filter((x) => x.topic === gt(B, gid).topic && !isCommit(x.bytes)));
      const e = BigInt(epoch(B, gid));
      const topic = onOld ? gt(B, gid).oldTopics[0].topic : gt(B, gid).topic;
      for (let i = 0; i < 6; i++) await B.engine.incomingMany(Array.from({ length: 50 }, () => ({ topic, bytes: forged(gid, e + 1n) })));
      const held = gt(B, gid).held;
      check(`(${onOld ? "old" : "current"} topic) the buffer stays within its count and byte budget`, held.length <= LIMITS.held && held.reduce((n, x) => n + x.b.length, 0) <= LIMITS.heldBytes);
      await B.engine.incomingMany(commits);
      res[onOld ? "old" : "current"] = msgs(B, gid).includes("real next epoch");
    }
    check("junk on an old topic doesn't push out a real held message", res.old === true);
    log(`    (documented limit) junk on the current topic: the real message ${res.current ? "survived" : "was pushed out"}`);
  },

  // ---------- the fixes' own bad cases (each fix changes something else; these pin what it must not open) ----------
  async "review 3 fixes' side effects: hand-backs end, no free identity upgrade, junk costs no write, remove ends a re-add"({ check }) {
    // (a) a name whose lookup always throws: its messages are handed back at most lookupTries times
    {
      const { bus, A, M, gid } = await group(["bob"]);
      const [B] = M;
      bus.down.add("bob");
      const B2 = await client(bus, "bob", { publish: false }); // claims bob with a new key (needs the chain)
      const items = [seal(B2, A, "rejoin-request", { gid, restore: true }), seal({ name: "bob", msgSecret: B2.msgSecret, keyHex: B2.keyHex }, A, "kp-request", { gid: hex(rand(32)), name: "x", req: "1" })];
      let left = items;
      let rounds = 0;
      for (; rounds < 10 && left.length; rounds++) {
        const r = await A.engine.incomingMany(left);
        left = r.failed.map((i) => left[i]);
      }
      check("a lookup that keeps failing is handed back a few times, then not any more", left.length === 0 && rounds <= 3, `${rounds} rounds, ${left.length} left`);
      check("...and never made the re-add happen or turned into another identity", !A.engine.listGroups()[0].invited.length && A.engine.stats()["lookup-gave-up"] === 1);
      bus.down.clear();
      check("(bob still in)", gt(B, gid).status === "active");
    }
    // (b) an invitation kept as unchecked during an outage doesn't become verified unless the chain says so
    {
      const bus = new Bus();
      await client(bus, "alice");
      const X = await client(bus, "alice", { publish: false }); // a false alice
      const V = await client(bus, "victim");
      bus.down.add("alice");
      const { id: gx } = await X.engine.createGroup("fake", ["victim"]);
      for (let i = 0; i < 4; i++) await settle(bus, 1);
      bus.down.clear();
      const inv = V.engine.listInvites()[0];
      // review 4 S4: the first accept checks the claim and refuses (NOT_VERIFIED); the invitation stays
      const first = await code(V.engine.acceptInvite(inv.id));
      const after = V.engine.listInvites()[0];
      check("accepting a false claim: NOT_VERIFIED, the invitation now shows the unverified address", first === "NOT_VERIFIED" && after?.id === inv.id && !after.verified && !after.unchecked && after.from !== "alice" && !Object.keys(V.engine.data.joins).length, first);
      await V.engine.acceptInvite(inv.id); // the user accepts again, knowingly
      await settle(bus);
      const g = V.engine.listGroups().find((x) => x.id === gx);
      check("an unchecked invitation from a false alice stays an unverified address after the check", g && g.admin !== "alice" && g.adminVerified === false);
    }
    // (c) re-add and resend requests from non-members for a real group's id: refused before any copy, no write
    {
      const { bus, A, M, gid } = await group(["bob"]);
      const w0 = A.storage.writes;
      const items = [];
      for (let i = 0; i < 50; i++) {
        const T = freeKey();
        items.push(seal(T, A, i % 2 ? "rejoin-request" : "resend-request", { gid, restore: true, fromEpoch: "0", n: hex(rand(16)) }));
      }
      await A.engine.incomingMany(items);
      check("50 such requests: no state write, nothing posted", A.storage.writes === w0 && !A.engine.data.outbox.length && (A.engine.stats()["control-refused"] ?? 0) >= 50);
    }
    // (d) a junk control in the same batch as a real Welcome doesn't hold the Welcome back
    {
      const bus = new Bus();
      const A = await client(bus, "alice");
      const B = await client(bus, "bob");
      const { id: gid } = await A.engine.createGroup("friends", ["bob"]);
      await settle(bus);
      await B.engine.acceptInvite(B.engine.listInvites()[0].id);
      B.held = true;
      await settle(bus);
      const T = freeKey();
      const junk = [seal(T, B, "commits", { gid, items: ["AAAA"], n: "00" }), seal(T, B, "welcome", { gid, welcome: "AAAA" }), seal(T, B, "kp-request", { gid: "zz" })];
      await B.engine.incomingMany([...junk, ...B.queue.splice(0)]);
      B.held = false;
      check("the Welcome in the same batch as junk is handled", gt(B, gid)?.status === "active");
    }
    // (f) remove() of a member with a pending re-add (readd, or its own request) removes the member too
    {
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B, C] = M;
      B.held = true;
      await A.engine.readd(gid, "bob");
      await A.engine.remove(gid, "bob");
      B.held = false;
      await settle(bus);
      check("remove() with a re-add pending: bob is out and told so", !A.engine.listGroups()[0].members.some((m) => m.id === "bob") && !A.engine.listGroups()[0].invited.includes("bob") && gt(B, gid).status === "removed" && epoch(C, gid) === epoch(A, gid));
    }
    // (g) replaceDeviceKey never replaces a blob that opens but is another version's
    {
      const { bus, M } = await group(["bob"]);
      const [B] = M;
      B.storage.blob = await B.cipher.encrypt(te.encode(JSON.stringify({ v: 99, groups: { keep: "me" } })));
      const blob = B.storage.blob;
      const v0 = B.storage.version;
      const r = await code(createGroupEngine({ me: { name: "bob", seed: ed25519.utils.randomSecretKey() }, transport: B.transport, resolver: bus.resolver(), storage: B.storage, cipher: B.cipher, now: bus.now, replaceDeviceKey: { v: 1, kind: "names-groups", groups: [] } }));
      check("another version's groups with replaceDeviceKey: refused, untouched", r === "STATE_UNREADABLE" && B.storage.blob === blob && B.storage.version === v0, r);
    }
    // (e) replaceDeviceKey with the seed the groups belong to is ignored: nothing is replaced
    {
      const { bus, M, gid } = await group(["bob"]);
      const [B] = M;
      const v0 = B.storage.version;
      const e2 = await createGroupEngine({ me: { name: "bob", seed: B.seed0 }, transport: B.transport, resolver: bus.resolver(), storage: B.storage, cipher: B.cipher, now: bus.now, replaceDeviceKey: { v: 1, kind: "names-groups", groups: [] } });
      check("replaceDeviceKey on the right seed: groups kept, nothing written", e2.data.groups[gid]?.status === "active" && B.storage.version === v0);
    }
  },

  // ---------- guards: review 3 probed these sound; they must stay so ----------
  async "review 3 guard: hostile Welcomes are refused and leave the seed intact"({ check }) {
    const baited = async () => {
      const bus = new Bus();
      const Mal = await client(bus, "mallory");
      const V = await client(bus, "victim");
      const W = await client(bus, "walt");
      Mal.held = true;
      const { id: gx } = await Mal.engine.createGroup("bait", ["victim"]);
      await settle(bus);
      await V.engine.acceptInvite(V.engine.listInvites()[0].id);
      const kpm = bus.posted.filter((p) => p.from === V && p.bytes[0] === 2).map((p) => openControl(Mal.msgSecret, p.bytes)).find((m) => m?.kind === "kp");
      const kp = mls.decodeMlsMessage(unb64(bodyOf(kpm).kp), 0)[0].keyPackage;
      return { bus, Mal, V, W, gx, kp };
    };
    const welcomeFrom = async (Mal, V, gx, groupId, leaf0Seed, kp, topicKey) => {
      const own = await mls.generateKeyPackageWithKey({ credentialType: "basic", identity: te.encode("mallory") }, mls.defaultCapabilities(), mls.defaultLifetime, [], { signKey: leaf0Seed.slice(), publicKey: ed25519.getPublicKey(leaf0Seed) }, Mal.engine.impl);
      const st = await mls.createGroup(groupId, own.publicPackage, own.privatePackage, [], Mal.engine.impl, clientConfig);
      const c = await mls.createCommit({ state: st, cipherSuite: Mal.engine.impl }, { extraProposals: [{ proposalType: "add", add: { keyPackage: kp } }], ratchetTreeExtension: true });
      const w = mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome: c.welcome });
      return seal(Mal, V, "welcome", { gid: gx, name: "x", admin: "mallory", topicKey: topicKey ?? hex(rand(32)), welcome: b64(w) });
    };
    const worksAfter = async (bus, V, W) => {
      const { id } = await V.engine.createGroup("after", ["walt"]);
      await settle(bus);
      await W.engine.acceptInvite(W.engine.listInvites().find((i) => i.groupId === id).id);
      await settle(bus);
      await V.engine.send(id, "works");
      await settle(bus);
      return msgs(W, id).includes("works");
    };
    const intact = (c) => c.engine.seed.every((x, i) => x === c.seed0[i]) && c.seed.every((x, i) => x === c.seed0[i]);
    {
      const { bus, Mal, V, W, gx, kp } = await baited();
      await V.engine.incomingMany([await welcomeFrom(Mal, V, gx, unhex(gx), ed25519.utils.randomSecretKey(), kp)]);
      check("leaf 0 not the inviter's key: refused, seed intact, next group works", V.engine.stats()["welcome-not-from-admin"] === 1 && !gt(V, gx) && intact(V) && (await worksAfter(bus, V, W)));
    }
    {
      const { bus, Mal, V, W, gx, kp } = await baited();
      await V.engine.incomingMany([await welcomeFrom(Mal, V, gx, rand(32), Mal.seed, kp)]);
      check("another group id: refused, seed intact, next group works", V.engine.stats()["welcome-wrong-group"] === 1 && !gt(V, gx) && intact(V) && (await worksAfter(bus, V, W)));
    }
    {
      const { bus, Mal, V, W, gx, kp } = await baited();
      const { id: gw } = await W.engine.createGroup("walt's", ["victim"]);
      await settle(bus);
      await V.engine.acceptInvite(V.engine.listInvites().find((i) => i.groupId === gw).id);
      await settle(bus);
      await V.engine.incomingMany([await welcomeFrom(Mal, V, gx, unhex(gx), Mal.seed, kp, gt(V, gw).topicKey)]);
      check("a topic another group uses: refused", !gt(V, gx) && V.engine.stats()["topic-collision"] === 1);
    }
    {
      const bus = new Bus();
      await client(bus, "alice");
      const X = await client(bus, "alice", { publish: false }); // claims alice; the chain has another key
      const V = await client(bus, "victim");
      const { id: gx } = await X.engine.createGroup("fake", ["victim"]);
      await settle(bus);
      const inv = V.engine.listInvites()[0];
      await V.engine.acceptInvite(inv.id);
      await settle(bus);
      const g = V.engine.listGroups().find((x) => x.id === gx);
      check("a false 'alice': shown as an unverified address, and so is the group's admin", inv.from !== "alice" && !inv.verified && inv.claimedName === "alice" && g && g.admin !== "alice" && g.adminVerified === false);
    }
  },

  async "review 3 guard: hidden leaves, late renames, what leave keeps, unreadable state"({ check }) {
    {
      const { A, M, gid } = await group(["bob", "carol"]);
      const [, C] = M;
      const s = ed25519.utils.randomSecretKey();
      const kp = await mls.generateKeyPackageWithKey({ credentialType: "basic", identity: te.encode("bob") }, mls.defaultCapabilities(), mls.defaultLifetime, [], { signKey: s, publicKey: ed25519.getPublicKey(s) }, A.engine.impl);
      const c = await mls.createCommit({ state: stateOf(A, gid), cipherSuite: A.engine.impl }, { extraProposals: [{ proposalType: "add", add: { keyPackage: kp.publicPackage } }] });
      await C.engine.incomingMany([{ topic: gt(C, gid).topic, bytes: frame(c.commit) }]);
      const bobs = C.engine.listGroups()[0].members.filter((m) => m.id === "bob");
      check("a hidden second 'bob' leaf is flagged on both", bobs.length === 2 && bobs.every((m) => m.duplicate && !m.verified) && of(C, "member-suspicious", gid).length > 0);
    }
    {
      const { A, M, gid } = await group(["bob"]);
      const [B] = M;
      B.held = true;
      await A.engine.rename(gid, "first");
      await A.engine.rename(gid, "second");
      const q = B.queue.splice(0);
      B.held = false;
      await B.engine.incomingMany([q[1]]);
      await B.engine.incomingMany([q[0]]);
      check("two renames in one epoch, newest first: the newer stays", gt(B, gid).name === "second");
    }
    {
      const { M, gid } = await group(["bob"]);
      const [B] = M;
      await B.engine.leave(gid);
      check("after leave the record keeps only id, name, role, admin, adminVerified, status, ended", JSON.stringify(Object.keys(gt(B, gid)).sort()) === JSON.stringify(["admin", "adminVerified", "ended", "id", "name", "role", "status"]));
    }
    {
      const { bus, M } = await group(["bob"]);
      const [B] = M;
      const v0 = B.storage.version;
      B.storage.blob = rand(200);
      const garbage = B.storage.blob;
      const r = await code(createGroupEngine({ me: { name: "bob", seed: B.seed0 }, transport: B.transport, resolver: bus.resolver(), storage: B.storage, cipher: B.cipher, now: bus.now }));
      check("an unreadable blob: STATE_UNREADABLE, not overwritten", r === "STATE_UNREADABLE" && B.storage.version === v0 && B.storage.blob === garbage);
    }
  },
};

// shared with review4.mjs
export { Bus, client, settle, group, seal, freeKey, of, msgs, gt, epoch, stateOf, framesFrom, controlsTo, bodyOf, badKp, lastKpRequest, forged, isCommit, code, hex, unhex, rand, te, MIN, HOUR, DAY };

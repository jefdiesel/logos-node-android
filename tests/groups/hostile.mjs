// Hostile-input scenarios for the group engine (review 1 of groups.js at 5ba3171: each failed there).
import { Client, settle, acceptAll } from "./harness.mjs";
import * as mls from "../app/messages/mls.js";
import { GroupError, LIMITS } from "../app/messages/groups.js";
import { sealControl, openControl, b64, unb64 } from "../app/messages/msg-v2.js";
import { x25519 } from "../app/noble-curves/ed25519.js";

const te = new TextEncoder();
const DAY = 86_400_000;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const clientConfig = {
  keyRetentionConfig: mls.defaultKeyRetentionConfig,
  lifetimeConfig: mls.defaultLifetimeConfig,
  keyPackageEqualityConfig: mls.defaultKeyPackageEqualityConfig,
  paddingConfig: mls.defaultPaddingConfig,
  authService: mls.defaultAuthenticationService,
};
const stateOf = (c, gid) => ({ ...mls.decodeGroupState(unb64(c.engine.data.groups[gid].mls), 0)[0], clientConfig });
const frame = (msg) => {
  const enc = mls.encodeMlsMessage(msg);
  const out = new Uint8Array(enc.length + 1);
  out[0] = 0x47;
  out.set(enc, 1);
  return out;
};
/** Application messages made by hand from a saved copy of a member's state (a custom client). */
async function craft(c, gid, objs) {
  let st = stateOf(c, gid);
  const out = [];
  for (const o of objs) {
    const r = await mls.createApplicationMessage(st, te.encode(JSON.stringify(o)), c.engine.impl);
    st = r.newState;
    out.push(frame({ version: "mls10", wireformat: "mls_private_message", privateMessage: r.privateMessage }));
  }
  return out;
}
async function code(p) {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof GroupError ? e.code : `${e?.constructor?.name}: ${e?.message}`;
  }
}
async function trio(net) {
  const A = await Client.make(net, { name: "alice" });
  const B = await Client.make(net, { name: "bob" });
  const C = await Client.make(net, { name: "carol" });
  const { id: gid } = await A.engine.createGroup("friends", ["bob", "carol"]);
  await settle([A, B, C]);
  await acceptAll([B, C], gid);
  await settle([A, B, C]);
  return { A, B, C, gid };
}
const adminCommit = async (net, A, all) => {
  net.clock.offset += DAY + 1000;
  await A.engine.tick();
  await settle(all);
};
const heldBytes = (c, gid) => c.engine.data.groups[gid].held.reduce((n, x) => n + x.b.length, 0);

export const HOSTILE = {
  async "hostile topic traffic: forged future frames and garbage"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const topic = A.group(gid).topic;
    await A.engine.send(gid, "hello");
    await settle([A, B, C]);
    const real = net.posted.filter((p) => p.topic === topic && p.from === A).at(-1).bytes;
    const m = mls.decodeMlsMessage(real.subarray(1), 0)[0];
    const forge = (epoch, size) => frame({ ...m, privateMessage: { ...m.privateMessage, epoch, ciphertext: rand(size) } });
    const e = BigInt(A.group(gid).epoch);
    // garbage on the inbox costs no state write
    const w0 = B.storage.writes;
    await B.engine.incomingMany(Array.from({ length: 50 }, () => {
      const b = rand(300);
      b[0] = 2;
      return { topic: B.inbox, bytes: b };
    }));
    check("50 garbage 0x02 items on the inbox cost no state write", B.storage.writes === w0, `${B.storage.writes - w0} writes`);
    // the topic flood: far-future frames (60 KB each), next-epoch and next-but-one junk, and garbage
    const blob0 = B.storage.blob.length;
    const items = [];
    for (let i = 0; i < 100; i++) items.push(forge(1n << 60n, 60_000));
    for (let i = 0; i < 300; i++) items.push(forge(e + 1n, 1000));
    for (let i = 0; i < 100; i++) items.push(forge(e + 2n, 1000));
    for (let i = 0; i < 50; i++) items.push(Uint8Array.of(0x47, ...rand(200)));
    for (let i = 0; i < items.length; i += 50) await B.engine.incomingMany(items.slice(i, i + 50).map((bytes) => ({ topic, bytes })));
    const g = B.engine.data.groups[gid];
    check("held stays within its count and byte limits", g.held.length <= LIMITS.held && heldBytes(B, gid) <= LIMITS.heldBytes, `${g.held.length} held, ${heldBytes(B, gid)} bytes`);
    check("far-future frames are dropped, not stored", (B.engine.stats()["too-far-ahead"] ?? 0) >= 100 && g.held.every((x) => BigInt(x.e) <= e + 2n));
    check("the state blob grows by at most the held budget", B.storage.blob.length - blob0 < LIMITS.heldBytes + 100_000, `${blob0} -> ${B.storage.blob.length}`);
    check("no 'catching up' from forged input alone", B.of("catching-up").length === 0);
    // a real next-epoch message arriving before its commit still gets through
    await net.ctl(`/down/${B.node}`);
    B.paused = true;
    const i0 = net.posted.length;
    await adminCommit(net, A, [A, C]);
    await A.engine.send(gid, "real after the flood");
    await settle([A, C]);
    const mine = net.posted.slice(i0).filter((p) => p.topic === topic && p.from === A);
    await net.ctl(`/up/${B.node}`);
    B.paused = false;
    await B.engine.incomingMany([{ topic, bytes: mine[1].bytes }]); // the message first...
    await B.engine.incomingMany([{ topic, bytes: mine[0].bytes }]); // ...then its commit
    check("the real message held through the flood is read once its commit comes", B.messages(gid).includes("real after the flood"), JSON.stringify(B.engine.stats()));
    check("bob is in step with the admin", B.group(gid).epoch === A.group(gid).epoch);
    // what's still held claims the next epoch; one resend answer from the admin settles it, then nothing more
    net.clock.offset += 3 * 60_000;
    await settle([A, B, C]);
    check("one resend answer clears the forged messages", B.engine.data.groups[gid].held.length === 0 && (B.engine.stats()["forged-future"] ?? 0) > 0, JSON.stringify(B.engine.stats()));
    const asks = () => net.posted.filter((p) => p.from === B && p.topic === A.inbox).length;
    const n = asks();
    for (let k = 0; k < 5; k++) {
      net.clock.offset += 3_600_000;
      await B.engine.tick();
    }
    check("no further resend requests", asks() === n, `${asks() - n} more`);
    check("the blob is back to its normal size", B.storage.blob.length - blob0 < 50_000, `${blob0} -> ${B.storage.blob.length}`);
    await C.engine.send(gid, "the group still works");
    await settle([A, B, C]);
    check("the group still works", B.messages(gid).includes("the group still works"));
  },

  async "forged and stale app messages"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const D = await Client.make(net, { name: "dave" });
    const topic0 = A.group(gid).topic;
    // bob's custom client makes a rename, a topic switch, a message and a leave, all in this epoch
    const [rn, tp, old, leave] = await craft(B, gid, [{ t: "rn", name: "hacked" }, { t: "topic", k: hex(rand(32)) }, { t: "m", text: "old news" }, { t: "leave" }]);
    await B.transport.post(topic0, rn);
    await B.transport.post(topic0, tp);
    await settle([A, B, C]);
    check("a member's rename is ignored", A.group(gid).name === "friends" && C.group(gid).name === "friends" && (C.engine.stats()["rename-not-from-admin"] ?? 0) >= 1);
    check("a member's topic switch is ignored", C.group(gid).topic === topic0 && (C.engine.stats()["topic-not-from-admin"] ?? 0) >= 1);
    // bob is removed and dave takes his leaf; then bob's old leave and message arrive
    const bobLeaf = A.group(gid).members.find((x) => x.id === "bob").leaf;
    await A.engine.remove(gid, "bob");
    await settle([A, B, C, D]);
    await A.engine.invite(gid, "dave");
    await settle([A, C, D]);
    await acceptAll([D], gid);
    await settle([A, C, D]);
    const daveLeaf = A.group(gid).members.find((x) => x.id === "dave")?.leaf;
    check("dave got bob's old leaf (the case that matters)", daveLeaf === bobLeaf, `${bobLeaf} vs ${daveLeaf}`);
    await B.transport.post(topic0, old);
    await B.transport.post(topic0, leave);
    await settle([A, C, D]);
    check("bob's late leave removed no one", A.group(gid).members.some((x) => x.id === "dave") && D.group(gid)?.status === "active" && (A.engine.stats()["stale-leave"] ?? 0) >= 1);
    const e = C.of("message", (x) => x.text === "old news")[0];
    check("a late message from someone who has left is marked so", e?.formerMember === true && e.verified === false, JSON.stringify(e));
    // a late rename from the admin never undoes a newer one
    const [olderName] = await craft(A, gid, [{ t: "rn", name: "older name" }]);
    await adminCommit(net, A, [A, C, D]);
    await A.engine.rename(gid, "newest name");
    await settle([A, C, D]);
    await A.transport.post(A.group(gid).topic, olderName);
    await settle([A, C, D]);
    check("a late rename doesn't win over a newer one", C.group(gid).name === "newest name" && D.group(gid).name === "newest name", C.group(gid).name);
  },

  async "v2 control messages from the wrong senders"({ net, check }) {
    // (a) a Welcome whose leaf 0 isn't the inviter, and (b) one for another group: the seed stays intact
    const M = await Client.make(net, { name: "mallory" });
    const V = await Client.make(net, { name: "victim" });
    const Z = await Client.make(net, { name: "zed" });
    const W = await Client.make(net, { name: "wendy" });
    const callerSeed = V.seed.slice();
    const engineSeed = V.engine.seed.slice();
    M.paused = true; // mallory's own engine stays out of it; she works by hand
    const { id: gx } = await M.engine.createGroup("bait", ["victim"]);
    await settle([V]);
    await V.engine.acceptInvite(V.engine.listInvites().find((i) => i.groupId === gx).id);
    const kpMsg = net.posted.filter((p) => p.from === V && p.topic === M.inbox && p.bytes[0] === 2).map((p) => openControl(M.msgSecret, p.bytes)).find((x) => x?.kind === "kp");
    const kp = mls.decodeMlsMessage(unb64(JSON.parse(new TextDecoder().decode(kpMsg.bytes)).kp), 0)[0].keyPackage;
    const sealedWelcome = (welcome) =>
      sealControl({ to: V.msgKey, from: "mallory", fromSecret: M.msgSecret, kind: "welcome", ts: net.now(),
        bytes: te.encode(JSON.stringify({ gid: gx, name: "x", admin: "mallory", topicKey: hex(rand(32)), welcome: b64(mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome })) })) });
    // zed's group, made by hand with mallory's group id, so only the leaf-0 check can refuse it
    const zkp = await mls.generateKeyPackage({ credentialType: "basic", identity: te.encode("zed") }, mls.defaultCapabilities(), mls.defaultLifetime, [], Z.engine.impl);
    const zs = await mls.createGroup(Uint8Array.from(gx.match(/../g), (h) => parseInt(h, 16)), zkp.publicPackage, zkp.privatePackage, [], Z.engine.impl, clientConfig);
    const gz = gx;
    const cz = await mls.createCommit({ state: zs, cipherSuite: Z.engine.impl }, { extraProposals: [{ proposalType: "add", add: { keyPackage: kp } }], ratchetTreeExtension: true });
    await V.engine.incoming(V.inbox, sealedWelcome(cz.welcome));
    check("a Welcome whose leaf 0 isn't the inviter is refused", (V.engine.stats()["welcome-not-from-admin"] ?? 0) === 1 && !V.group(gx) && !V.group(gz), `${JSON.stringify(V.engine.stats())} ${V.engine.lastLibraryError}`);
    check("...and the device seed is untouched (the caller's and the engine's)", callerSeed.every((b, i) => b === V.seed[i]) && engineSeed.every((b, i) => b === V.engine.seed[i]) && V.engine.seed.some((b) => b !== 0));
    const { id: gm } = await M.engine.createGroup("mallory's other");
    const cm = await mls.createCommit({ state: stateOf(M, gm), cipherSuite: M.engine.impl }, { extraProposals: [{ proposalType: "add", add: { keyPackage: kp } }], ratchetTreeExtension: true });
    await V.engine.incoming(V.inbox, sealedWelcome(cm.welcome));
    check("a Welcome from the inviter but for another group id is refused", (V.engine.stats()["welcome-wrong-group"] ?? 0) === 1 && !V.group(gx) && !V.group(gm));
    const { id: gv } = await V.engine.createGroup("after", ["wendy"]);
    await settle([V, W]);
    await acceptAll([W], gv);
    await settle([V, W]);
    await V.engine.send(gv, "signed with the real key");
    await settle([V, W]);
    check("the victim's next group works (signatures are real)", W.messages(gv).includes("signed with the real key"));

    // (c) a stranger can't replace a pending invitation, and an invitation fill doesn't crowd out a real one
    const A = await Client.make(net, { name: "alice" });
    const V2 = await Client.make(net, { name: "victim2" });
    const { id: gf } = await A.engine.createGroup("family", ["victim2"]);
    await settle([A, V2]);
    const mal = x25519.utils.randomSecretKey();
    await V2.engine.incoming(V2.inbox, sealControl({ to: V2.msgKey, from: "alice", fromSecret: mal, kind: "kp-request", ts: net.now(), bytes: te.encode(JSON.stringify({ gid: gf, name: "family", req: "00" })) }));
    const invs = V2.engine.listInvites().filter((i) => i.groupId === gf);
    const realInv = invs.find((i) => i.from === "alice");
    const fakeInv = invs.find((i) => i.from !== "alice");
    check("a stranger's request for the same group doesn't replace alice's", invs.length === 2 && realInv?.verified === true);
    check("...it shows as an unverified address claiming 'alice'", fakeInv?.verified === false && fakeInv.claimedName === "alice" && fakeInv.from === "k:" + hex(x25519.getPublicKey(mal)));
    await V2.engine.acceptInvite(realInv.id);
    await settle([A, V2]);
    check("accepting the real one joins alice's group", V2.group(gf)?.status === "active" && V2.group(gf).admin === "alice");
    const V3 = await Client.make(net, { name: "victim3" });
    const junk = (secret, from, gid) => sealControl({ to: V3.msgKey, from, fromSecret: secret, kind: "kp-request", ts: net.now(), bytes: te.encode(JSON.stringify({ gid, name: "spam", req: "0" })) });
    for (let i = 0; i < 55; i++) await V3.engine.incoming(V3.inbox, junk(x25519.utils.randomSecretKey(), `claims${i}`, hex(rand(32)))); // unverified
    for (let i = 0; i < 55; i++) {
      const s = x25519.utils.randomSecretKey();
      await V3.engine.incoming(V3.inbox, junk(s, "msg-" + hex(x25519.getPublicKey(s)).slice(0, 16), hex(rand(32)))); // addresses
    }
    const one = x25519.utils.randomSecretKey();
    for (let i = 0; i < 5; i++) await V3.engine.incoming(V3.inbox, junk(one, "msg-" + hex(x25519.getPublicKey(one)).slice(0, 16), hex(rand(32))));
    const { id: gr } = await A.engine.createGroup("real", ["victim3"]);
    await settle([A, V3]);
    const list = V3.engine.listInvites();
    check("after a 115-request fill the real invitation is still there", list.some((i) => i.groupId === gr && i.from === "alice" && i.verified), `${list.length} invites`);
    check("the list stays at its cap, unverified ones went first", list.length <= LIMITS.invites && list.every((i) => i.verified));
    check("one sender keeps at most 3", list.filter((i) => i.from === "k:" + hex(x25519.getPublicKey(one))).length <= LIMITS.invitesPerSender);

    // (d) resend and rejoin from a removed member; rejoin without a reason; rejoin rate limit
    const B = await Client.make(net, { name: "bob" });
    const C = await Client.make(net, { name: "carol" });
    const { id: gid } = await A.engine.createGroup("friends", ["bob", "carol"]);
    await settle([A, B, C]);
    await acceptAll([B, C], gid);
    await settle([A, B, C]);
    await A.engine.remove(gid, "carol");
    await settle([A, B, C]);
    const toA = (from, secret, kind, body) => sealControl({ to: A.msgKey, from, fromSecret: secret, kind, ts: net.now(), bytes: te.encode(JSON.stringify(body)) });
    const n0 = net.posted.length;
    await A.engine.incoming(A.inbox, toA("carol", C.msgSecret, "resend-request", { gid, fromEpoch: "0" }));
    await A.engine.incoming(A.inbox, toA("carol", C.msgSecret, "rejoin-request", { gid, restore: true }));
    check("a removed member gets no resend and no re-add", !net.posted.slice(n0).some((p) => p.topic === C.inbox) && !A.group(gid).invited.includes("carol"));
    await A.engine.incoming(A.inbox, toA("bob", B.msgSecret, "rejoin-request", { gid }));
    check("a member's rejoin with no reason is refused", !A.group(gid).invited.includes("bob"));
    await A.engine.incoming(A.inbox, toA("bob", B.msgSecret, "rejoin-request", { gid, restore: true }));
    await A.engine.incoming(A.inbox, toA("bob", B.msgSecret, "rejoin-request", { gid, restore: true, again: 1 }));
    check("a restore rejoin is honoured once", A.group(gid).invited.includes("bob") && A.of("rejoin-request", (e) => e.member === "bob").length === 1);
    await A.engine.incoming(A.inbox, toA("bob", B.msgSecret, "resend-request", { gid, fromEpoch: "0" }));
    await A.engine.incoming(A.inbox, toA("bob", B.msgSecret, "resend-request", { gid, fromEpoch: "0", again: 1 }));
    check("resend answers are rate-limited per member", (A.engine.stats()["resend-rate-limited"] ?? 0) >= 1);
  },

  async "chain unreachable: unknown is not 'key changed', and nothing is lost"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    net.resolverDown = true;
    await adminCommit(net, A, [A, B, C]);
    const bm = B.group(gid).members;
    check("members show 'unknown', not 'key changed'", bm.filter((m) => m.id !== "alice" || true).every((m) => m.unknown && !m.keyChanged), JSON.stringify(bm));
    check("no key-changed events", B.of("key-changed").length === 0 && C.of("key-changed").length === 0);
    check("an invite needing a lookup says so", (await code(A.engine.invite(gid, "dave"))) === "RESOLVER_UNAVAILABLE");
    net.resolverDown = false;
    const D = await Client.make(net, { name: "dave" });
    await A.engine.invite(gid, "dave");
    await settle([D]);
    await acceptAll([D], gid);
    net.resolverDown = true; // the admin can't check dave's key package when it arrives
    await A.poll();
    check("the key package is kept for later, not lost", A.retry.length > 0 && !D.group(gid));
    net.resolverDown = false;
    await settle([A, B, C, D]);
    check("once the chain answers, dave joins", D.group(gid)?.status === "active");
    check("and everyone is verified again", B.group(gid).members.every((m) => m.verified), JSON.stringify(B.group(gid).members));
  },

  async "a malicious admin's hidden leaves are flagged"({ net, check }) {
    const M = await Client.make(net, { name: "mallory" });
    const B = await Client.make(net, { name: "bob" });
    const { id: gid } = await M.engine.createGroup("mallory's", ["bob"]);
    await settle([M, B]);
    await acceptAll([B], gid);
    await settle([M, B]);
    M.paused = true;
    const kp = (identity) => mls.generateKeyPackage({ credentialType: "basic", identity: te.encode(identity) }, mls.defaultCapabilities(), mls.defaultLifetime, [], M.engine.impl);
    const k1 = await kp("bob");
    const k2 = await kp("__proto__");
    const c = await mls.createCommit({ state: stateOf(M, gid), cipherSuite: M.engine.impl }, { extraProposals: [{ proposalType: "add", add: { keyPackage: k1.publicPackage } }, { proposalType: "add", add: { keyPackage: k2.publicPackage } }], ratchetTreeExtension: true });
    await M.transport.post(M.group(gid).topic, frame(c.commit));
    await settle([B]);
    const ms = B.group(gid).members;
    check("bob sees four leaves", ms.length === 4, JSON.stringify(ms));
    check("both 'bob' leaves are flagged duplicate and unverified", ms.filter((m) => m.id === "bob").length === 2 && ms.filter((m) => m.id === "bob").every((m) => m.duplicate && !m.verified));
    check("the '__proto__' leaf is listed and flagged malformed", ms.some((m) => m.id === "__proto__" && m.malformed));
    check("an event says so", B.of("member-suspicious", (e) => e.groupId === gid).length >= 2);
  },
};

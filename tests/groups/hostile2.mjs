// Scenarios from review 2 of groups.js (at a34005f; probes2.mjs P1-P5 and the should-fix items). Each failed there.
import { Client, settle, acceptAll, memoryStorage, pageCipher } from "./harness.mjs";
import { trio, craft, frame, adminCommit, code } from "./hostile.mjs";
import * as mls from "../app/messages/mls.js";
import { createGroupEngine, LIMITS } from "../app/messages/groups.js";
import { sealControl, openControl } from "../app/messages/msg-v2.js";
import { x25519 } from "../app/noble-curves/ed25519.js";

const te = new TextEncoder();
const DAY = 86_400_000;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const isCommit = (bytes) => mls.decodeMlsMessage(bytes.subarray(1), 0)?.[0]?.privateMessage?.contentType === "commit";
const onTopic = (items, t) => items.filter((x) => x.topic === t);

export const REVIEW2 = {
  async "a stale or replayed resend answer doesn't drop real held messages"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const T = A.group(gid).topic;
    B.paused = true;
    await adminCommit(net, A, [A, C]); // c1
    await A.engine.send(gid, "m1");
    await settle([A, C]);
    let q = onTopic(await B.fetch(), T);
    await B.engine.incomingMany(q.filter((x) => !isCommit(x.bytes))); // c1 lost, m1 held
    net.clock.offset += 3 * 60_000;
    await B.engine.tick(); // the resend request (with its nonce)
    await A.poll(); // the admin answers; the answer waits on bob's node
    const answer = onTopic(await B.fetch(), B.inbox);
    await adminCommit(net, A, [A, C]); // c2, after the answer was written
    await A.engine.send(gid, "m2");
    await settle([A, C]);
    q = onTopic(await B.fetch(), T);
    await B.engine.incomingMany(q.filter((x) => !isCommit(x.bytes))); // m2 first: held
    await B.engine.incomingMany(answer); // the answer says "admin at c1's epoch"
    await B.engine.incomingMany(q.filter((x) => isCommit(x.bytes))); // then c2
    check("an honest late answer keeps the real m2", B.messages(gid).includes("m1") && B.messages(gid).includes("m2"), JSON.stringify(B.messages(gid)));
    check("bob is in step", B.group(gid).epoch === A.group(gid).epoch);
    // later: a new real held message, 1,000 authentic junk controls, then the old answer replayed
    await adminCommit(net, A, [A, C]);
    await A.engine.send(gid, "m3");
    await settle([A, C]);
    q = onTopic(await B.fetch(), T);
    await B.engine.incomingMany(q.filter((x) => !isCommit(x.bytes)));
    const s = x25519.utils.randomSecretKey();
    const from = "msg-" + hex(x25519.getPublicKey(s)).slice(0, 16);
    const w0 = B.storage.writes;
    const seen0 = B.engine.data.seen.length;
    for (let i = 0; i < 1000; i += 50) {
      const batch = [];
      for (let k = 0; k < 50; k++) batch.push({ topic: B.inbox, bytes: sealControl({ to: B.msgKey, from, fromSecret: s, kind: "resend-request", ts: net.now(), bytes: te.encode(JSON.stringify({ gid: hex(rand(32)), n: String(i + k) })) }) });
      await B.engine.incomingMany(batch);
    }
    check("1,000 authentic but useless controls cost no write and don't touch the seen list", B.storage.writes === w0 && B.engine.data.seen.length === seen0, `${B.storage.writes - w0} writes`);
    await B.engine.incomingMany(answer); // replay
    await B.engine.incomingMany(q.filter((x) => isCommit(x.bytes)));
    check("a replayed old answer drops nothing", B.messages(gid).includes("m3") && (B.engine.stats()["forged-future"] ?? 0) === 0, JSON.stringify(B.engine.stats()));
  },

  async "three missed commits: the member asks and catches up"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const T = A.group(gid).topic;
    B.paused = true;
    for (let k = 0; k < 3; k++) await adminCommit(net, A, [A, C]);
    await A.engine.send(gid, "after three commits");
    await settle([A, C]);
    const q = onTopic(await B.fetch(), T);
    await B.engine.incomingMany(q.slice(-1)); // the 50-message window lost the commits: only this is left
    B.paused = false;
    net.clock.offset += 3 * 60_000;
    await settle([A, B, C]);
    check("bob said he was catching up, asked, and caught up", B.of("catching-up").length >= 1 && B.of("caught-up").length >= 1 && B.group(gid).epoch === A.group(gid).epoch, `${B.group(gid).epoch} vs ${A.group(gid).epoch}`);
    await A.engine.send(gid, "after catching up");
    await settle([A, B, C]);
    check("and reads the group again", B.messages(gid).includes("after catching up"));
  },

  async "a member who missed the topic change follows the group to the new topic"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const D = await Client.make(net, { name: "dave" });
    await A.engine.invite(gid, "dave");
    await settle([A, B, C, D]);
    await acceptAll([D], gid);
    await settle([A, B, C, D]);
    const T0 = A.group(gid).topic;
    B.paused = true;
    await A.engine.remove(gid, "dave"); // the commit and the topic message, on T0
    const q = onTopic(await B.fetch(), T0);
    await B.engine.incomingMany(q.filter((x) => isCommit(x.bytes))); // bob gets the commit only
    B.paused = false;
    await settle([A, B, C, D]);
    await A.engine.send(gid, "on the new topic");
    await settle([A, B, C]);
    check("(bob is stranded on the old topic for now)", !B.messages(gid).includes("on the new topic") && B.group(gid).topic === T0);
    await adminCommit(net, A, [A, B, C]); // the admin's next commit repeats the topic on old topics in their grace
    check("bob moved to the new topic", B.group(gid).topic === A.group(gid).topic && B.of("topic-changed").length >= 1);
    await C.engine.send(gid, "carol after the move");
    await settle([A, B, C]);
    check("and reads the group again", B.messages(gid).includes("carol after the move"));
  },

  async "held eviction: old-topic junk goes before a real next-epoch message"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const D = await Client.make(net, { name: "dave" });
    await A.engine.invite(gid, "dave");
    await settle([A, B, C, D]);
    await acceptAll([D], gid);
    await settle([A, B, C, D]);
    const T0 = A.group(gid).topic;
    await A.engine.remove(gid, "dave");
    await settle([A, B, C, D]);
    const T1 = A.group(gid).topic;
    B.paused = true;
    await adminCommit(net, A, [A, C]);
    await A.engine.send(gid, "real next-epoch");
    await settle([A, C]);
    const q = onTopic(await B.fetch(), T1);
    const m = q.find((x) => !isCommit(x.bytes));
    await B.engine.incomingMany([m]); // held (current topic)
    const pm = mls.decodeMlsMessage(m.bytes.subarray(1), 0)[0];
    const junk = Array.from({ length: LIMITS.held + 50 }, () => ({ topic: T0, bytes: frame({ ...pm, privateMessage: { ...pm.privateMessage, ciphertext: rand(500) } }) }));
    for (let i = 0; i < junk.length; i += 50) await B.engine.incomingMany(junk.slice(i, i + 50));
    check("held stays at its limit", B.engine.data.groups[gid].held.length <= LIMITS.held);
    await B.engine.incomingMany(q.filter((x) => isCommit(x.bytes)));
    B.paused = false;
    check("the real message survived the old-topic flood", B.messages(gid).includes("real next-epoch"));
  },

  async "invitations: free addresses can't push out a name's invitation"({ net, check }) {
    const A = await Client.make(net, { name: "alice" });
    const V = await Client.make(net, { name: "victim" });
    const { id: gr } = await A.engine.createGroup("real", ["victim"]);
    await settle([A, V]);
    for (let i = 0; i < 60; i++) {
      const s = x25519.utils.randomSecretKey();
      await V.engine.incoming(V.inbox, sealControl({ to: V.msgKey, from: "msg-" + hex(x25519.getPublicKey(s)).slice(0, 16), fromSecret: s, kind: "kp-request", ts: net.now(), bytes: te.encode(JSON.stringify({ gid: hex(rand(32)), name: "spam", req: "0" })) }));
    }
    for (let i = 0; i < 40; i++) {
      const s = x25519.utils.randomSecretKey();
      await V.engine.incoming(V.inbox, sealControl({ to: V.msgKey, from: `claims${i}`, fromSecret: s, kind: "kp-request", ts: net.now(), bytes: te.encode(JSON.stringify({ gid: hex(rand(32)), name: "spam", req: "0" })) }));
    }
    const list = V.engine.listInvites();
    check("alice's invitation, which came first, is still there", list.some((i) => i.groupId === gr && i.from === "alice"), `${list.length} invites`);
    check("addresses hold at most their share", list.filter((i) => i.from.startsWith("k:") && i.verified).length <= LIMITS.invitesAddress && list.length <= LIMITS.invites);
  },

  async "one sender whose lookup always fails holds back nothing else"({ net, check }) {
    net.poison = new Set(["poison"]);
    const A = await Client.make(net, { name: "alice" });
    const V = await Client.make(net, { name: "victim" });
    V.paused = true;
    await A.engine.createGroup("real", ["victim"]);
    const real = (await V.fetch()).filter((x) => x.topic === V.inbox);
    const s = x25519.utils.randomSecretKey();
    const bad = { topic: V.inbox, bytes: sealControl({ to: V.msgKey, from: "poison", fromSecret: s, kind: "kp-request", ts: net.now(), bytes: te.encode(JSON.stringify({ gid: hex(rand(32)), name: "x", req: "0" })) }) };
    let items = [bad, ...real];
    let firstRoundInvite = false;
    for (let round = 0; round < 5; round++) {
      const r = await V.engine.incomingMany(items);
      items = r.failed.map((i) => items[i]);
      if (round === 0) firstRoundInvite = V.engine.listInvites().some((i) => i.from === "alice");
    }
    check("alice's invitation got in on the first round", firstRoundInvite);
    check("after a few tries the stuck one is taken as an unverified address", items.length === 0 && V.engine.listInvites().some((i) => i.claimedName === "poison" && !i.verified));
    net.poison = null;
  },

  async "resend answers: from the member's join, and slower for repeats"({ net, check }) {
    const { A, B, gid } = await trio(net);
    for (let k = 0; k < 3; k++) await adminCommit(net, A, [A]);
    const ask = (n) => sealControl({ to: A.msgKey, from: "bob", fromSecret: B.msgSecret, kind: "resend-request", ts: net.now(), bytes: te.encode(JSON.stringify({ gid, fromEpoch: "0", n })) });
    const i0 = net.posted.length;
    await A.engine.incoming(A.inbox, ask("0123456789abcdef0123456789abcdef"));
    const answers = net.posted.slice(i0).filter((p) => p.topic === B.inbox);
    const body = JSON.parse(new TextDecoder().decode(openControl(B.msgSecret, answers[0].bytes).bytes));
    const log = A.engine.data.groups[gid].commitLog;
    const joined = BigInt(A.engine.data.groups[gid].added[B.keyHex]);
    check("asked from epoch 0, the answer starts at bob's join", answers.length === 1 && log.some((c) => BigInt(c.e) < joined) && body.items.length === log.filter((c) => BigInt(c.e) >= joined).length, `${body.items.length} of ${log.length}, joined ${joined}`);
    net.clock.offset += 61_000;
    await A.engine.incoming(A.inbox, ask("1123456789abcdef0123456789abcdef")); // the same again: answered, gap doubles
    net.clock.offset += 61_000;
    await A.engine.incoming(A.inbox, ask("2123456789abcdef0123456789abcdef"));
    check("a third identical request a minute later waits (the gap doubled)", (A.engine.stats()["resend-rate-limited"] ?? 0) === 1);
  },

  async "a replayed restore request doesn't lock out a real restore"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const toA = (from, secret, body) => sealControl({ to: A.msgKey, from, fromSecret: secret, kind: "rejoin-request", ts: net.now(), bytes: te.encode(JSON.stringify(body)) });
    // someone replays bob's restore request: the admin asks bob's current device, which still has the group
    await A.engine.incoming(A.inbox, toA("bob", B.msgSecret, { gid, restore: true }));
    await settle([A, B, C]);
    const i0 = net.posted.length;
    await A.engine.incoming(A.inbox, toA("bob", B.msgSecret, { gid, restore: true, again: 1 }));
    check("asking again re-sends the key-package request", net.posted.slice(i0).some((p) => p.topic === B.inbox && p.bytes[0] === 2));
    // then bob really restores on a new phone (new key): not blocked
    const backup = B.engine.exportBackup();
    const B3 = await Client.make(net, { name: "bob" });
    await B3.engine.importBackup(backup);
    await settle([A, B, C, B3]);
    check("the real restore goes through", B3.group(gid)?.status === "active");
  },

  async "late renames in one epoch, and unreadable saved state"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const [first, second] = await craft(A, gid, [{ t: "rn", name: "first" }, { t: "rn", name: "second" }]);
    await A.transport.post(A.group(gid).topic, second);
    await settle([A, B, C]);
    await A.transport.post(A.group(gid).topic, first);
    await settle([A, B, C]);
    check("two renames in one epoch delivered out of order: the later one stays", C.group(gid).name === "second" && B.group(gid).name === "second", C.group(gid).name);
    // a blob the engine can't read (another version) is refused and left alone
    const storage = memoryStorage();
    const cipher = pageCipher();
    storage.blob = await cipher.encrypt(te.encode(JSON.stringify({ v: 99, groups: { keep: "me" } })));
    storage.version = 7;
    const blob = storage.blob;
    const r = await code(createGroupEngine({ me: { name: "zoe", seed: rand(32) }, transport: B.transport, resolver: net.resolver(), storage, cipher, now: net.now }));
    check("unreadable saved groups are refused, not overwritten", r === "STATE_UNREADABLE" && storage.blob === blob && storage.writes === 0, r);
  },
};

// The group engine's scenarios (GROUPS-PLAN 6.9, coordinator's list), against tests/fake_waku.py. Each one
// starts fresh devices on restarted fake nodes. runAll() works in Node and in the browser page.
import { Net, Client, settle, acceptAll } from "./harness.mjs";
import * as mls from "../app/messages/mls.js";
import { checkCapabilities, GroupError, LIMITS } from "../app/messages/groups.js";
import { openMessage } from "../app/messages/msg-crypto.js";
import { b64, unb64 } from "../app/messages/msg-v2.js";

const te = new TextEncoder();
const DAY = 86_400_000;
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
async function code(p) {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof GroupError ? e.code : `${e?.constructor?.name}: ${e?.message}`;
  }
}

/** alice (admin), bob and carol in "friends". */
async function trio(net, extra = {}) {
  const A = await Client.make(net, { name: "alice" });
  const B = await Client.make(net, { name: "bob" });
  const C = await Client.make(net, { name: "carol" });
  const { id: gid } = await A.engine.createGroup("friends", ["bob", "carol", ...(extra.members ?? [])]);
  await settle([A, B, C]);
  await acceptAll([B, C], gid);
  await settle([A, B, C]);
  return { A, B, C, gid };
}
const epochOf = (c, gid) => c.group(gid)?.epoch;
const adminCommit = async (net, A, all) => {
  net.clock.offset += DAY + 1000; // the admin's daily self-update falls due
  await A.engine.tick();
  await settle(all);
};

export const SCENARIOS = {
  async "create, invite, chat both ways, rename"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    check("bob and carol joined", B.of("joined", (e) => e.groupId === gid).length === 1 && C.of("joined", (e) => e.groupId === gid).length === 1);
    const ga = A.group(gid);
    check("alice sees 3 members, all verified on the chain", ga.members.length === 3 && ga.members.every((m) => m.verified && !m.keyChanged), JSON.stringify(ga.members));
    check("everyone is at the same epoch", epochOf(A, gid) === epochOf(B, gid) && epochOf(B, gid) === epochOf(C, gid));
    check("bob also got the plain v1 invitation line", B.v1.some((m) => m.from === "alice" && m.text.includes('invited you to the group "friends"')));
    await A.engine.send(gid, "hi from alice");
    await B.engine.send(gid, "hi from bob");
    await C.engine.send(gid, "hi from carol");
    await settle([A, B, C]);
    check("bob reads alice and carol", B.messages(gid).includes("hi from alice") && B.messages(gid).includes("hi from carol"), JSON.stringify(B.messages(gid)));
    check("alice reads bob and carol", A.messages(gid).includes("hi from bob") && A.messages(gid).includes("hi from carol"));
    check("carol reads alice and bob", C.messages(gid).includes("hi from alice") && C.messages(gid).includes("hi from bob"));
    const fromBob = A.of("message", (e) => e.text === "hi from bob")[0];
    check("a message says who sent it, verified", fromBob?.from === "bob" && fromBob.verified === true && fromBob.address === B.keyHex);
    check("nobody reads their own message back", !A.messages(gid).includes("hi from alice") && !B.messages(gid).includes("hi from bob"));
    await A.engine.rename(gid, "pals");
    await settle([A, B, C]);
    check("rename reaches members", B.group(gid).name === "pals" && C.of("renamed", (e) => e.name === "pals").length === 1);
    check("a member can't rename", (await code(B.engine.rename(gid, "mine"))) === "NOT_ADMIN");
    check("a member can't invite or remove", (await code(B.engine.invite(gid, "alice"))) === "NOT_ADMIN" && (await code(B.engine.remove(gid, "carol"))) === "NOT_ADMIN");
    const dropped = [A, B, C].flatMap((c) => c.of("dropped"));
    check("dropped-message events carry only a code", dropped.every((e) => Object.keys(e).sort().join() === "code,type"), JSON.stringify(dropped.slice(0, 3)));
  },

  async "remove: the removed member reads nothing new"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    await A.engine.remove(gid, "carol");
    await settle([A, B, C]);
    check("carol is told she was removed", C.of("removed", (e) => e.groupId === gid).length === 1 && C.group(gid).status === "removed");
    check("carol's group state is wiped", C.engine.data.groups[gid].mls === "");
    check("bob sees carol leave the roster", !B.group(gid).members.some((m) => m.id === "carol"));
    const before = net.posted.length;
    await A.engine.send(gid, "after carol");
    await settle([A, B, C]);
    check("bob reads the next message", B.messages(gid).includes("after carol"));
    const payload = net.posted.slice(before).find((p) => p.topic === A.group(gid).topic);
    await net.ctl(`/inject/${C.node}`, { topic: payload.topic, payload: b64(payload.bytes) });
    await C.poll();
    check("carol can't read it, even handed the payload", !C.messages(gid).includes("after carol"));
    const ids = stateOf(A, gid).ratchetTree.filter((n) => n?.nodeType === "leaf").map((n) => new TextDecoder().decode(n.leaf.credential.identity));
    check("the removed leaf is gone from the admin's tree", !ids.includes("carol") && ids.length === 2, ids.join());
  },

  async "leave"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    await B.engine.leave(gid);
    await settle([A, B, C]);
    check("bob's device forgot the group", B.group(gid).status === "left" && B.engine.data.groups[gid].mls === "" && B.engine.topics().length === 0);
    check("the admin committed bob's removal", !A.group(gid).members.some((m) => m.id === "bob") && !C.group(gid).members.some((m) => m.id === "bob"));
    check("admin can't leave", (await code(A.engine.leave(gid))) === "ADMIN_CANNOT_LEAVE");
    await A.engine.send(gid, "bye bob");
    await settle([A, B, C]);
    check("carol reads on, bob doesn't", C.messages(gid).includes("bye bob") && !B.messages(gid).includes("bye bob"));
  },

  async "duplicates (live, again from the node, and re-injected)"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const before = net.posted.length;
    await A.engine.send(gid, "once");
    await B.poll();
    await net.ctl(`/dup/${B.node}`);
    await B.poll();
    const p = net.posted.slice(before).find((x) => x.topic === A.group(gid).topic);
    await net.ctl(`/inject/${B.node}`, { topic: p.topic, payload: b64(p.bytes) });
    await B.poll();
    await settle([A, B, C]);
    check("bob shows it once", B.messages(gid).filter((t) => t === "once").length === 1, JSON.stringify(B.messages(gid)));
    check("the repeats were counted as duplicates, not errors", (B.engine.stats().duplicate ?? 0) >= 2 && !B.engine.stats()["library-error"], JSON.stringify(B.engine.stats()));
  },

  async "late and reordered history (60-80 s apart)"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    await net.ctl(`/down/${C.node}`);
    C.paused = true;
    const topic = A.group(gid).topic;
    const mark = () => net.posted.length;
    const grab = (from) => net.posted.slice(from).filter((p) => p.topic === topic).map((p) => p.bytes);
    let i = mark();
    await A.engine.send(gid, "m1");
    const m1 = grab(i);
    i = mark();
    await adminCommit(net, A, [A, B]);
    const c1 = grab(i);
    i = mark();
    await B.engine.send(gid, "m2");
    const m2 = grab(i);
    i = mark();
    await adminCommit(net, A, [A, B]);
    const c2 = grab(i);
    i = mark();
    await A.engine.send(gid, "m3");
    const m3 = grab(i);
    await settle([A, B]);
    await net.ctl(`/up/${C.node}`);
    C.paused = false;
    for (const bytes of [...m3, ...c2, ...m1, ...c1, ...m2]) {
      net.clock.offset += 60_000 + Math.floor(Math.random() * 20_000);
      await net.ctl(`/inject/${C.node}`, { topic, payload: b64(bytes) });
      await C.poll();
    }
    check("carol read all three", ["m1", "m2", "m3"].every((t) => C.messages(gid).includes(t)), JSON.stringify(C.messages(gid)));
    check("m2 came after its epoch closed and still opened (marked late)", C.of("message", (e) => e.text === "m2")[0]?.late === true);
    check("carol is at the admin's epoch", epochOf(C, gid) === epochOf(A, gid), `${epochOf(C, gid)} vs ${epochOf(A, gid)}`);
    check("carol said she was catching up, then caught up", C.of("catching-up").length >= 1 && C.of("caught-up").length >= 1);
  },

  async "more than 50 events between reads"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    B.paused = true;
    for (let k = 0; k < 60; k++) await A.engine.send(gid, `n${k}`);
    B.paused = false;
    await settle([A, B, C]);
    const got = B.messages(gid).filter((t) => /^n\d+$/.test(t));
    check("bob got the 50 the node kept", got.length === 50 && got.includes("n59") && !got.includes("n9"), `${got.length}`);
    await adminCommit(net, A, [A, B, C]);
    const missed = B.of("missed-messages", (e) => e.groupId === gid);
    check("bob is told he missed 10 when the epoch closed", missed.length === 1 && missed[0].count === 10, JSON.stringify(missed));
    check("bob is in step with the admin", epochOf(B, gid) === epochOf(A, gid));
  },

  async "lost commit, then resend from the admin"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    B.paused = true;
    net.clock.offset += DAY + 1000;
    await A.engine.tick(); // a commit...
    for (let k = 0; k < 55; k++) await A.engine.send(gid, `r${k}`); // ...pushed out of bob's 50 by what follows
    B.paused = false;
    await B.poll();
    check("bob holds what he can't open yet and says so", B.of("catching-up", (e) => e.groupId === gid).length === 1 && B.group(gid).catchingUp === true);
    net.clock.offset += 3 * 60_000; // past resendAfter: bob's tick asks the admin
    await settle([A, B, C]);
    check("bob caught up through the admin's resend", B.of("caught-up", (e) => e.groupId === gid).length === 1 && epochOf(B, gid) === epochOf(A, gid), `${epochOf(B, gid)} vs ${epochOf(A, gid)} B ${JSON.stringify(B.engine.stats())} A ${JSON.stringify(A.engine.stats())} ${B.events.map((e) => e.type).join(",")}`);
    const got = B.messages(gid).filter((t) => /^r\d+$/.test(t));
    check("bob read the 50 messages he held", got.length === 50, `${got.length}`);
    await C.engine.send(gid, "still talking");
    await settle([A, B, C]);
    check("and the group keeps working", B.messages(gid).includes("still talking"));
  },

  async "member offline for days, then back"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const D = await Client.make(net, { name: "dave" });
    await net.ctl(`/down/${C.node}`);
    C.paused = true;
    net.clock.offset += 3 * DAY;
    for (const t of ["d1", "d2", "d3"]) await A.engine.send(gid, t);
    await A.engine.invite(gid, "dave");
    await settle([A, B, D]);
    await acceptAll([D], gid);
    await settle([A, B, D]);
    await B.engine.send(gid, "d4");
    await D.engine.send(gid, "d5");
    await settle([A, B, D]);
    await A.engine.remove(gid, "dave");
    await A.engine.send(gid, "d6");
    await settle([A, B, D]);
    await net.ctl(`/up/${C.node}`);
    C.paused = false;
    await C.resubscribe(); // as server.py does when its node comes back: brings what it missed
    await settle([A, B, C]);
    check("carol read everything she missed", ["d1", "d2", "d3", "d4", "d5", "d6"].every((t) => C.messages(gid).includes(t)), JSON.stringify(C.messages(gid)));
    check("carol's roster and epoch match the admin's", epochOf(C, gid) === epochOf(A, gid) && C.group(gid).members.map((m) => m.id).sort().join() === A.group(gid).members.map((m) => m.id).sort().join());
  },

  async "admin offline: members still chat"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    await net.ctl(`/down/${A.node}`);
    A.paused = true;
    await B.engine.send(gid, "without alice 1");
    await C.engine.send(gid, "without alice 2");
    await settle([B, C]);
    check("bob and carol read each other", B.messages(gid).includes("without alice 2") && C.messages(gid).includes("without alice 1"));
    await net.ctl(`/up/${A.node}`);
  },

  async "commit from a non-admin and from outside"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const e0 = epochOf(A, gid);
    // bob builds a real commit removing carol, from his own group state
    const sb = stateOf(B, gid);
    const carolLeaf = sb.ratchetTree.findIndex((n) => n?.nodeType === "leaf" && new TextDecoder().decode(n.leaf.credential.identity) === "carol") / 2;
    const forged = await mls.createCommit({ state: sb, cipherSuite: B.engine.impl }, { extraProposals: [{ proposalType: "remove", remove: { removed: carolLeaf } }] });
    await B.transport.post(A.group(gid).topic, frame(forged.commit));
    await settle([A, B, C]);
    check("the non-admin commit changed nothing", epochOf(A, gid) === e0 && epochOf(C, gid) === e0 && A.group(gid).members.some((m) => m.id === "carol"));
    check("it was counted as refused", (A.engine.stats()["commit-not-from-admin"] ?? 0) >= 1 && (C.engine.stats()["commit-not-from-admin"] ?? 0) >= 1, JSON.stringify(C.engine.stats()));
    // mallory, who only has a GroupInfo, sends an external commit (a PublicMessage) that would add her
    const sa = stateOf(A, gid);
    const gi = await mls.createGroupInfoWithExternalPubAndRatchetTree(sa, [], A.engine.impl);
    const kp = await mls.generateKeyPackage({ credentialType: "basic", identity: te.encode("mallory") }, mls.defaultCapabilities(), mls.defaultLifetime, [], A.engine.impl);
    const ext = await mls.joinGroupExternal(gi, kp.publicPackage, kp.privatePackage, false, A.engine.impl);
    await B.transport.post(A.group(gid).topic, frame({ version: "mls10", wireformat: "mls_public_message", publicMessage: ext.publicMessage }));
    await settle([A, B, C]);
    check("the external commit changed nothing", epochOf(A, gid) === e0 && epochOf(B, gid) === e0 && !A.group(gid).members.some((m) => m.id === "mallory"));
    check("it was dropped as not a private message", (C.engine.stats()["not-a-private-message"] ?? 0) >= 1);
    await A.engine.send(gid, "still fine");
    await settle([A, B, C]);
    check("the group still works", B.messages(gid).includes("still fine") && C.messages(gid).includes("still fine"));
  },

  async "a member's key changes on the chain"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const D = await Client.make(net, { name: "dave" });
    const B2 = await Client.make(net, { name: "bob" }); // bob's new device: the chain's msg for bob is now its key
    await A.engine.invite(gid, "dave");
    await settle([A, B, C, D, B2]);
    await acceptAll([D], gid);
    await settle([A, B, C, D, B2]);
    const bobAtA = A.group(gid).members.find((m) => m.id === "bob");
    check("on the next membership change bob is flagged, not trusted", bobAtA?.keyChanged === true && bobAtA.verified === false && A.of("key-changed", (e) => e.member === "bob").length === 1);
    check("members flag him too", C.group(gid).members.find((m) => m.id === "bob")?.keyChanged === true);
    const msg = (await B.engine.send(gid, "from the old key"), await settle([A, B, C, D, B2]), A.of("message", (e) => e.text === "from the old key")[0]);
    check("messages from the old key arrive marked unverified", msg?.verified === false);
    await A.engine.invite(gid, "bob"); // re-add: the old leaf goes, the new device's comes
    await settle([A, B, C, D, B2]);
    await acceptAll([B2], gid);
    await settle([A, B, C, D, B2]);
    check("bob's new device joined, verified", B2.group(gid)?.status === "active" && A.group(gid).members.find((m) => m.id === "bob")?.verified === true);
    check("bob's old device was removed", B.group(gid).status === "removed", `${B.group(gid).status} ${B.group(gid).epoch} vs ${A.group(gid).epoch} ${JSON.stringify(B.engine.stats())} ${B.engine.lastLibraryError}`);
    await C.engine.send(gid, "welcome back bob");
    await settle([A, B, C, D, B2]);
    check("the new device reads the group", B2.messages(gid).includes("welcome back bob") && !B.messages(gid).includes("welcome back bob"));
  },

  async "two tabs writing state"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    // tab 2 of alice's device: same seed, same storage, same node (both pages read the same server.py)
    const { createGroupEngine } = await import("../app/messages/groups.js");
    const A2 = await createGroupEngine({ me: { name: "alice", seed: A.seed }, transport: A.transport, resolver: net.resolver(), storage: A.storage, cipher: A.cipher, now: net.now });
    const conflictsBefore = A.storage.conflicts;
    await Promise.all([A.engine.send(gid, "tab one"), A2.send(gid, "tab two")]);
    await settle([A, B, C]);
    check("both tabs' messages arrive", ["tab one", "tab two"].every((t) => B.messages(gid).includes(t) && C.messages(gid).includes(t)), JSON.stringify(B.messages(gid)));
    check("one write was refused and redone (no fork)", A.storage.conflicts > conflictsBefore);
    await A2.remove(gid, "carol"); // tab two changes the epoch; tab one is stale
    await A.engine.send(gid, "tab one after the remove");
    await settle([A, B, C]);
    check("the stale tab reloaded and sent in the new epoch", B.messages(gid).includes("tab one after the remove") && !C.messages(gid).includes("tab one after the remove"));
    check("no decryption errors anywhere", !B.engine.stats()["library-error"] && !C.engine.stats()["library-error"], JSON.stringify(B.engine.stats()));
  },

  async "restore from backup, then re-added"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    const backup = B.engine.exportBackup();
    check("the backup holds only the group list", JSON.stringify(backup).length < 2000 && !JSON.stringify(backup).includes("mls") && backup.groups[0]?.id === gid);
    const B3 = await Client.make(net, { name: "bob" }); // the restored phone: a new key, published for bob
    await B3.engine.importBackup(backup);
    await settle([A, B, C, B3]);
    check("the admin re-added the restored device", B3.group(gid)?.status === "active" && A.of("rejoin-request", (e) => e.member === "bob").length === 1);
    check("the old device's leaf was removed", B.group(gid).status === "removed");
    await A.engine.send(gid, "hello restored bob");
    await settle([A, B, C, B3]);
    check("the restored device reads new messages", B3.messages(gid).includes("hello restored bob"));
    check("messages from before the restore are not readable there (expected)", !B3.messages(gid).some((t) => t.startsWith("hi")));
  },

  async "address-only member"({ net, check }) {
    const A = await Client.make(net, { name: "alice" });
    const X = await Client.make(net, {}); // no LNS name
    const { id: gid } = await A.engine.createGroup("by address", ["msg:" + X.keyHex]);
    await settle([A, X]);
    check("the address got the v1 invitation line too", X.v1.some((m) => m.text.includes("by address")));
    await acceptAll([X], gid);
    await settle([A, X]);
    const m = A.group(gid).members.find((x) => x.id === "k:" + X.keyHex);
    check("shown as an address, verified by its own key", m?.isAddress === true && m.verified === true);
    await X.engine.send(gid, "from an address");
    await settle([A, X]);
    const e = A.of("message", (x) => x.text === "from an address")[0];
    check("its messages name the address", e?.from === "k:" + X.keyHex && e.verified === true);
  },

  async "0x02 as the Names web app sees it"({ net, check }) {
    const A = await Client.make(net, { name: "alice" });
    const B = await Client.make(net, { name: "bob" });
    const { id: gid } = await A.engine.createGroup("web", ["bob"]);
    await settle([A, B]);
    const v2 = net.posted.find((p) => p.topic === B.inbox && p.bytes[0] === 2);
    check("the v1 reader (msg-crypto.js openMessage, as in the Names web app) returns null for 0x02", !!v2 && openMessage(B.msgSecret, v2.bytes) === null);
    check("the v1 invitation line opens there", B.v1.some((m) => m.from === "alice" && m.text.includes("web")));
    check("the engine leaves v1 messages alone", (await B.engine.incoming(B.inbox, net.posted.find((p) => p.topic === B.inbox && p.bytes[0] === 1).bytes)) === false);
    check("v2 is under the 64 KiB cap", net.posted.filter((p) => p.bytes[0] === 2).every((p) => p.bytes.length <= 65536));
    void gid;
  },

  async "limits and error codes"({ net, check }) {
    const { A, B, C, gid } = await trio(net);
    check("2,001 characters refused", (await code(A.engine.send(gid, "x".repeat(2001)))) === "TEXT_TOO_LONG");
    await A.engine.send(gid, "y".repeat(2000));
    await settle([A, B, C]);
    check("2,000 characters go through", B.messages(gid).includes("y".repeat(2000)));
    check("bad member refused", (await code(A.engine.invite(gid, "Not A Name!"))) === "BAD_MEMBER");
    check("a name without msg refused", (await code(A.engine.invite(gid, "nobody"))) === "NO_MSG_KEY");
    check("re-inviting a member refused", (await code(A.engine.invite(gid, "bob"))) === "ALREADY_MEMBER");
    for (let k = 1; k < LIMITS.groups; k++) await A.engine.createGroup(`g${k}`);
    check("the 21st group refused", (await code(A.engine.createGroup("one too many"))) === "LIMIT_GROUPS");
    check("33 members at creation refused", (await code(B.engine.createGroup("big", Array.from({ length: 32 }, (_, k) => `p${k}`)))) === "LIMIT_MEMBERS");
    const caps = await checkCapabilities("app");
    const capsDefault = await checkCapabilities("default");
    check("capability check: this runtime has what both providers need", caps.ok && capsDefault.ok, JSON.stringify([caps, capsDefault]));
  },

  async "32 members after a self-update and a remove (#860)"({ net, check, log }) {
    await growTo32(net, check, log, true);
  },

  async "the same without the #860 workaround: joins fail (proves the test catches it)"({ net, check, log }) {
    await growTo32(net, check, log, false);
  },
};

async function growTo32(net, check, log, workaround) {
  {
    const A = await Client.make(net, { name: "alice", engine: { workaround860: workaround } });
    const ms = [];
    for (let k = 1; k <= 31; k++) ms.push(await Client.make(net, k % 10 === 0 ? {} : { name: `m${k}` }));
    const all = [A, ...ms];
    const first = ms.slice(0, 5);
    const { id: gid } = await A.engine.createGroup("thirty-two", first.map((c) => c.pid));
    await settle([A, ...first]);
    await acceptAll(first, gid);
    await settle([A, ...first]);
    await adminCommit(net, A, [A, ...first]); // a self-update: parent nodes fill
    await A.engine.remove(gid, first[2].pid); // a remove
    await settle([A, ...first]);
    const rest = [...ms.slice(5), first[2]]; // everyone else, and the removed one back
    let failures = 0;
    for (const c of rest) {
      await A.engine.invite(gid, c.pid);
      await settle(all);
      await acceptAll([c], gid);
      await settle(all);
      if (c.group(gid)?.status !== "active") failures++;
    }
    const size = A.group(gid).members.length;
    if (!workaround) {
      check("without the workaround most re-joins fail on ts-mls 1.6.4", failures > 10, `failures ${failures}`);
      return;
    }
    check("all 31 joined (no #860 refusals)", failures === 0 && size === 32, `failures ${failures}, members ${size}`);
    const extra = await Client.make(net, { name: "m32" }).catch(() => null);
    check("the 33rd is refused", extra ? (await code(A.engine.invite(gid, "m32"))) === "LIMIT_MEMBERS" : true);
    await ms[30].engine.send(gid, "from number 32");
    await settle(all);
    const readers = all.filter((c) => c !== ms[30] && c.messages(gid).includes("from number 32")).length;
    check("everyone else reads member 32", readers === 31, `${readers}`);
    const welcomes = net.posted.filter((p) => p.bytes[0] === 2 && p.from === A).map((p) => p.bytes.length);
    log(`largest sealed control message from the admin: ${Math.max(...welcomes)} bytes`);
    check("every sealed control message under 64 KiB", Math.max(...welcomes) <= 65536);
    check("no library errors at the admin", !A.engine.stats()["library-error"], JSON.stringify(A.engine.stats()));
    // the cost of one blob for everything: its size and the time of one send at 32 members
    let t = performance.now();
    await A.engine.send(gid, "timing");
    const adminSendMs = Math.round(performance.now() - t);
    t = performance.now();
    await ms[0].engine.send(gid, "timing 2");
    const memberSendMs = Math.round(performance.now() - t);
    await settle(all);
    const sizes = { adminBlob: A.storage.blob.length, adminJson: JSON.stringify(A.engine.data).length, memberBlob: ms[0].storage.blob.length, adminSendMs, memberSendMs, adminWrites: A.storage.writes };
    log(`state at 32 members: ${JSON.stringify(sizes)}`);
    check("state sizes measured", sizes.adminBlob > 0, JSON.stringify(sizes));
  }
}

export async function runAll({ nodeUrl, ctlUrl, nodes, log = console.log, only }) {
  const results = {};
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    if (only && !only.some((o) => name.includes(o))) continue;
    const net = new Net({ nodeUrl, ctlUrl, nodes });
    const checks = [];
    const check = (label, ok, detail) => {
      checks.push({ label, ok: !!ok, ...(ok ? {} : { detail: String(detail ?? "") }) });
      if (!ok) log(`    FAIL ${label} ${detail ?? ""}`);
    };
    const t = Date.now();
    try {
      await fn({ net, check, log });
    } catch (e) {
      checks.push({ label: "scenario threw", ok: false, detail: `${e?.constructor?.name}: ${e?.message} ${e?.stack ?? ""}`.slice(0, 2000) });
      log(`    THREW ${e?.message}`);
    }
    results[name] = { ok: checks.length > 0 && checks.every((c) => c.ok), checks, ms: Date.now() - t };
    log(`${results[name].ok ? "ok  " : "FAIL"} ${name} (${checks.filter((c) => c.ok).length}/${checks.length}, ${results[name].ms} ms)`);
  }
  const ok = Object.values(results).every((r) => r.ok);
  return { ok, results };
}

// Scenarios from review 4 of groups.js (at acc5982), on review 3's in-memory bus. Each "review 4 <item>"
// scenario fails at acc5982 (GROUPS_ENGINE=<that groups.js> node tests/groups_test.mjs --only "review 4"); the
// "guard" ones passed there and must stay so.
import { createGroupEngine } from "../app/messages/groups.js";
import { ed25519 } from "../app/noble-curves/ed25519.js";
import { Bus, client, settle, group, seal, freeKey, of, msgs, gt, epoch, controlsTo, bodyOf, badKp, forged, isCommit, code, hex, rand, MIN, DAY } from "./review3.mjs";

const members = (c, gid) => c.engine.listGroups().find((g) => g.id === gid)?.members.map((m) => m.id) ?? [];

export const REVIEW4 = {
  // ---------- M1: a pending re-add request ends with the membership ----------
  async "review 4 M1: leave, delete or a kick after requestReadd: the device stays out"({ check }) {
    {
      // leave while the admin's re-add is on its way
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B] = M;
      B.held = true;
      await B.engine.requestReadd(gid);
      await settle(bus); // alice re-adds by herself; her key-package request waits on bob's node
      await B.engine.leave(gid);
      check("leave ends the device's re-add request", !Object.hasOwn(B.engine.data.rejoin, gid) && !Object.values(B.engine.data.joins).some((j) => j.gid === gid));
      await settle(bus); // alice removes bob for his leave
      check("the admin's leave removal also ends its pending re-add of bob", !members(A, gid).includes("bob") && !A.engine.listGroups()[0].invited.includes("bob"));
      B.held = false;
      await settle(bus);
      check("bob stays out after leaving", gt(B, gid).status === "left" && !members(A, gid).includes("bob") && !of(B, "joined", gid).some((e) => e.readd));
    }
    {
      // delete after asking (the request lost): the daily re-ask stops
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B] = M;
      B.held = true;
      await B.engine.requestReadd(gid);
      A.queue.splice(0);
      B.queue.splice(0);
      await B.engine.deleteGroup(gid);
      B.held = false;
      const n0 = bus.posted.length;
      for (let k = 0; k < 3; k++) {
        bus.clock += DAY + MIN;
        await B.engine.tick();
        await A.engine.tick();
        await settle(bus);
      }
      check("bob stays out after deleting the group, and asks nothing more", !gt(B, gid) && !controlsTo(bus, A, n0).some((x) => x.p.from === B && x.m.kind === "rejoin-request"));
    }
    {
      // kicked while asking: the admin's next plain invitation is shown, not joined by itself
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B] = M;
      B.held = true;
      await B.engine.requestReadd(gid);
      A.queue.splice(0);
      B.queue.splice(0);
      B.held = false;
      await A.engine.remove(gid, "bob");
      await settle(bus);
      check("(bob was removed)", gt(B, gid).status === "removed");
      bus.clock += 3 * DAY;
      await A.engine.invite(gid, "bob");
      await settle(bus);
      check("after a kick the next invitation waits for the user", gt(B, gid).status === "removed" && B.engine.listInvites().some((i) => i.groupId === gid));
    }
    // the honest re-add still works whichever comes first at bob: the old leaf's removal or the Welcome
    for (const removalFirst of [true, false]) {
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B, C] = M;
      await B.engine.requestReadd(gid);
      B.held = true;
      await settle(bus);
      const q = B.queue.splice(0);
      const kpReq = q.filter((x) => x.topic === B.engine.inbox);
      await B.engine.incomingMany(kpReq); // bob answers the admin's key-package request
      B.queue.splice(0);
      await settle(bus); // alice adds bob: removal commit, topic, add, Welcome wait on bob's node
      const all = B.queue.splice(0);
      const inbox = all.filter((x) => x.topic === B.engine.inbox);
      const frames = all.filter((x) => x.topic !== B.engine.inbox);
      if (removalFirst) {
        await B.engine.incomingMany(frames);
        await B.engine.incomingMany(inbox);
      } else {
        await B.engine.incomingMany(inbox);
        await B.engine.incomingMany(frames);
      }
      B.held = false;
      await settle(bus);
      await A.engine.send(gid, "back");
      await C.engine.send(gid, "hi bob");
      await settle(bus);
      check(`honest re-add, ${removalFirst ? "removal" : "Welcome"} first: bob is in and reads`, gt(B, gid)?.status === "active" && epoch(B, gid) === epoch(A, gid) && msgs(B, gid).includes("back") && msgs(B, gid).includes("hi bob"));
    }
  },

  // ---------- S1, S2: hand-backs and lookups bounded under a flood ----------
  async "review 4 S1: more than 1,000 failing inbox messages stop being handed back"({ check }) {
    const bus = new Bus();
    const V = await client(bus, "victim");
    const X = freeKey();
    X.name = "zed"; // claims a name: the engine must look it up
    bus.down.add("*");
    const items = [];
    for (let i = 0; i < 1100; i++) items.push(seal(X, V, "kp-request", { gid: hex(rand(32)), name: "g" + i, req: "r" + i }));
    let left = items;
    let calls = 0;
    for (; calls < 6 && left.length; calls++) {
      const r = await V.engine.incomingMany(left);
      left = r.failed.map((i) => left[i]);
    }
    check("1,100 from one free key during an outage: nothing handed back after 3 calls", left.length === 0 && calls <= 3, `${calls} calls, ${left.length} left`);
    check("...and the key holds at most its 3 places", V.engine.listInvites().length <= 3);
  },

  async "review 4 S2: a free key's flood costs a few chain lookups, not one per message"({ check }) {
    const bus = new Bus();
    const V = await client(bus, "victim");
    await client(bus, "alice");
    const X = freeKey();
    X.name = "alice"; // claims alice, whose key it doesn't hold
    let calls = 0;
    const inner = V.engine.resolver;
    V.engine.resolver = { msgKey: async (n) => (calls++, inner.msgKey(n)) };
    for (let b = 0; b < 10; b++) await V.engine.incomingMany(Array.from({ length: 50 }, (_, k) => seal(X, V, "kp-request", { gid: hex(rand(32)), name: "g", req: "r" + (b * 50 + k) })));
    check("500 kp-requests claiming alice from one free key: at most 3 lookups", calls <= 3, `${calls} lookups`);
    check("...3 unverified invitations kept", V.engine.listInvites().length === 3 && V.engine.listInvites().every((i) => !i.verified));
  },

  // ---------- S3: replaceDeviceKey all or nothing; what it does to an admin's groups ----------
  async "review 4 S3: replaceDeviceKey is one write; an admin's groups are dropped (pinned)"({ check }) {
    {
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B] = M;
      const backup = B.engine.exportBackup();
      const seed = ed25519.utils.randomSecretKey();
      bus.chain.set("bob", ed25519.utils.toMontgomery(ed25519.getPublicKey(seed)));
      const realWrite = B.storage.write;
      const blob0 = B.storage.blob;
      B.storage.write = async () => {
        throw new Error("page reloaded");
      };
      const o0 = { me: { name: "bob", seed }, transport: B.transport, resolver: bus.resolver(), storage: B.storage, cipher: B.cipher, now: bus.now };
      await code(createGroupEngine({ ...o0, replaceDeviceKey: backup }));
      B.storage.write = realWrite;
      check("a reload before the migration's write: old groups untouched, the next start still refuses", B.storage.blob === blob0 && (await code(createGroupEngine(o0))) === "DEVICE_KEY_CHANGED");
      let n = 0;
      B.storage.write = async (blob, base) => {
        if (++n === 2) throw new Error("page reloaded"); // whatever the second write is, it never happens
        return realWrite(blob, base);
      };
      const opts = (extra = {}) => ({ me: { name: "bob", seed }, transport: B.transport, resolver: bus.resolver(), storage: B.storage, cipher: B.cipher, now: bus.now, ...extra });
      const n0 = bus.posted.length;
      await code(createGroupEngine(opts({ replaceDeviceKey: backup })));
      B.storage.write = realWrite;
      B.gone = true;
      const B2 = await client(bus, "bob", { seed, storage: B.storage, cipher: B.cipher }); // the page starts normally
      const asked = Object.hasOwn(B2.engine.data.rejoin, gid) || bus.posted.slice(n0).some((p) => p.topic === A.engine.inbox);
      check("a reload after the migration's first write: the re-add request is kept or already sent", asked);
      await settle(bus);
      for (let k = 0; k < 2 && gt(B2, gid)?.status !== "active"; k++) {
        bus.clock += DAY + MIN;
        await B2.engine.tick(); // asked again daily
        await settle(bus);
      }
      check("...and the new key is re-added", gt(B2, gid)?.status === "active" && epoch(B2, gid) === epoch(A, gid));
    }
    {
      // pinned, documented in replaceDeviceKey's comment: the admin's own groups don't survive its key migration
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B, C] = M;
      check("(the old engine says which groups it administers: what the UI must warn about)", A.engine.listGroups().some((g) => g.id === gid && g.role === "admin"));
      const backup = A.engine.exportBackup();
      const seed = ed25519.utils.randomSecretKey();
      bus.chain.set("alice", ed25519.utils.toMontgomery(ed25519.getPublicKey(seed)));
      const A2 = await createGroupEngine({ me: { name: "alice", seed }, transport: A.transport, resolver: bus.resolver(), storage: A.storage, cipher: A.cipher, now: bus.now, replaceDeviceKey: backup });
      check("an admin's migration drops the groups it administered", !A2.data.groups[gid] && (await code(A2.remove(gid, "bob"))) === "UNKNOWN_GROUP");
      A.gone = true;
      await B.engine.send(gid, "still here?");
      await settle(bus);
      check("...whose members can still talk", msgs(C, gid).includes("still here?"));
    }
  },

  // ---------- S4 ----------
  async "review 4 S4: an unchecked invitation with a false claim is not accepted silently"({ check }) {
    const bus = new Bus();
    const B = await client(bus, "bob");
    await client(bus, "alice");
    const X = await client(bus, "alice", { publish: false }); // claims alice
    bus.down.add("alice"); // bob can't check "alice" when the invitation comes
    const { id: gid } = await X.engine.createGroup("alice's friends", ["bob"]);
    for (let i = 0; i < 4; i++) await settle(bus, 1);
    bus.down.clear();
    const inv = B.engine.listInvites()[0];
    check("(kept as unchecked)", inv?.unchecked === true && inv.claimedName === "alice");
    const r = await code(B.engine.acceptInvite(inv.id));
    const now = B.engine.listInvites()[0];
    check("accept says NOT_VERIFIED and answers nothing", r === "NOT_VERIFIED" && !Object.keys(B.engine.data.joins).length, r);
    check("the invitation stays, showing the unverified address", now?.id === inv.id && !now.verified && !now.unchecked && now.from.startsWith("k:") && now.claimedName === "alice");
    await B.engine.acceptInvite(inv.id);
    await settle(bus);
    check("a second, informed accept joins, with the admin shown unverified", B.engine.listGroups().find((g) => g.id === gid)?.adminVerified === false);
  },

  // ---------- S5 ----------
  async "review 4 S5: two re-add requests that cross still end with the member in"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    A.held = true;
    B.held = true;
    await B.engine.requestReadd(gid);
    A.held = false;
    await settle(bus); // alice: key-package request -> bob
    A.held = true;
    B.held = false;
    await settle(bus); // bob answers it
    const second = await B.engine.requestReadd(gid);
    check("asking again right after answering is not sent (once a day)", second.asked === false);
    // force the crossing anyway: a second request (e.g. from before an app restart) reaches alice before the kp
    const q = A.queue.splice(0);
    await A.engine.incomingMany([seal(B, A, "rejoin-request", { gid, restore: true, again: 1 }), ...q]);
    A.held = false;
    await settle(bus);
    for (let k = 0; k < 3; k++) {
      bus.clock += 3 * MIN;
      await B.engine.tick();
      await A.engine.tick();
      await settle(bus);
    }
    await A.engine.send(gid, "after the re-add");
    await settle(bus);
    check("bob is in, in step, and reads", gt(B, gid)?.status === "active" && epoch(B, gid) === epoch(A, gid) && msgs(B, gid).includes("after the re-add"), JSON.stringify({ s: gt(B, gid)?.status, st: B.engine.stats() }));
    check("one bob at the admin", members(A, gid).filter((m) => m === "bob").length === 1 && msgs(C, gid).length >= 0);
  },

  // ---------- S6 ----------
  async "review 4 S6: junk at +1/+2 for 8 days gives an in-step member no needs-readd"({ check, log }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    const STEP = 10 * MIN;
    for (let t = 0; t < 8 * DAY; t += STEP) {
      bus.clock += STEP;
      await B.engine.tick();
      bus.clock += 1;
      const e0 = BigInt(epoch(B, gid)); // a relay copies group id and epoch from the clear header
      await B.engine.incomingMany([1n, 2n].map((k) => ({ topic: gt(B, gid).topic, bytes: forged(gid, e0 + k, 200) })));
      await A.engine.tick();
      await C.engine.tick();
      await settle(bus);
    }
    const asks = bus.posted.filter((p) => p.from === B && p.topic === A.engine.inbox).length;
    log(`    8 days of junk: bob's resend requests ${asks}, catching-up ${of(B, "catching-up").length}, caught-up ${of(B, "caught-up").length}`);
    check("bob stays in step and is never told needs-readd", epoch(B, gid) === epoch(A, gid) && of(B, "needs-readd").length === 0);
    check("...and the answers say so (caught-up follows catching-up)", of(B, "caught-up").length >= of(B, "catching-up").length - 1);
    // the bad case of this fix: a member really left behind (no answer ever says it is in step) still hears
    A.gone = true; // the admin's phone is gone: nothing answers
    const e = BigInt(epoch(B, gid));
    await B.engine.incomingMany([{ topic: gt(B, gid).topic, bytes: forged(gid, e + 3n, 200) }]); // frames from far ahead
    for (let t = 0; t < 8 * DAY; t += 6 * 60 * MIN) {
      bus.clock += 6 * 60 * MIN;
      await B.engine.tick();
      await settle(bus);
    }
    check("with no answer for 7 days, needs-readd still comes", of(B, "needs-readd").length === 1);
  },

  // ---------- guards: probed sound in review 4 ----------
  async "review 4 guard: a bad key package between two good ones in one batch; a replayed re-add Welcome"({ check }) {
    {
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      bus.clock += DAY + 1000;
      await A.engine.tick(); // #860 path from now on
      await settle(bus);
      const D = await client(bus, "dave");
      const E = await client(bus, "erin");
      const X = await client(bus, "mallory");
      X.held = true;
      A.held = true; // the key packages pile up, then come in one batch
      for (const n of ["dave", "mallory", "erin"]) await A.engine.invite(gid, n);
      await settle(bus);
      for (const c of [D, E]) await c.engine.acceptInvite(c.engine.listInvites()[0].id);
      const reqX = bodyOf(controlsTo(bus, X).filter((x) => x.m.kind === "kp-request").at(-1).m).req;
      const kps = A.queue.splice(0);
      await A.engine.incomingMany([kps[0], seal(X, A, "kp", { gid, req: reqX, kp: await badKp(X, "mallory") }), ...kps.slice(1)]);
      A.held = false;
      await settle(bus);
      await A.engine.send(gid, "all here");
      await settle(bus);
      for (let k = 0; k < 3; k++) {
        // a member that joined while the next add's commit was in flight asks for it (the bus keeps no history)
        bus.clock += 3 * MIN;
        for (const c of bus.clients) await c.engine.tick();
        await settle(bus);
      }
      const ms = [...M, D, E];
      check("both good adds land, the bad one fails alone, everyone in step and reading", JSON.stringify({ e: [A, ...ms].map((c) => epoch(c, gid)), r: ms.map((c) => msgs(c, gid).includes("all here")), f: of(A, "invite-failed", gid), k: kps.length }) && ms.every((c) => epoch(c, gid) === epoch(A, gid) && msgs(c, gid).includes("all here")) && of(A, "invite-failed", gid).some((e) => e.member === "mallory" && e.code === "BAD_KEY_PACKAGE"), JSON.stringify({ e: [A, ...ms].map((c) => epoch(c, gid)), r: ms.map((c) => msgs(c, gid).includes("all here")), f: of(A, "invite-failed", gid), k: kps.length }));
    }
    {
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B] = M;
      await B.engine.requestReadd(gid);
      const n0 = bus.posted.length;
      await settle(bus);
      const w = controlsTo(bus, B, n0).find((x) => x.m.kind === "welcome");
      check("(first re-add done)", gt(B, gid)?.status === "active" && epoch(B, gid) === epoch(A, gid));
      bus.clock += 8 * DAY;
      await B.engine.requestReadd(gid);
      B.held = true;
      await settle(bus);
      B.engine.data.seen.splice(0);
      const e1 = epoch(B, gid);
      await B.engine.incomingMany([{ topic: w.p.topic, bytes: w.p.bytes }]); // the first re-add's Welcome, replayed
      check("a replayed earlier re-add Welcome doesn't roll bob back", epoch(B, gid) === e1 && gt(B, gid).status === "active");
      B.held = false;
      await settle(bus);
      await A.engine.send(gid, "second re-add");
      await settle(bus);
      check("...and the real second re-add works", epoch(B, gid) === epoch(A, gid) && msgs(B, gid).includes("second re-add"));
    }
  },
};

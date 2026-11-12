// Scenarios from review 5 of groups.js (at 82c6cc7), on review 3's in-memory bus. Each "review 5 <item>"
// scenario fails at 82c6cc7 (GROUPS_ENGINE=<that groups.js> node tests/groups_test.mjs --only "review 5").
import { createGroupEngine } from "../app/messages/groups.js";
import { ed25519 } from "../app/noble-curves/ed25519.js";
import { Bus, client, settle, group, seal, freeKey, of, msgs, gt, epoch, controlsTo, bodyOf, forged, code, hex, rand, MIN, DAY } from "./review3.mjs";

const members = (c, gid) => c.engine.listGroups().find((g) => g.id === gid)?.members.map((m) => m.id) ?? [];

/** bob gets an invitation from a key that claims "alice" while bob can't check names (kept unchecked). */
async function falseAliceInvite() {
  const bus = new Bus();
  const B = await client(bus, "bob");
  await client(bus, "alice"); // the real alice
  const X = await client(bus, "alice", { publish: false });
  bus.down.add("alice");
  const { id: gid } = await X.engine.createGroup("alice's friends", ["bob"]);
  for (let i = 0; i < 4; i++) await settle(bus, 1);
  bus.down.clear();
  return { bus, B, X, gid, inv: B.engine.listInvites()[0] };
}

export const REVIEW5 = {
  // ---------- S1 ----------
  async "review 5 S1: a false-claim invitation needs an explicit second accept, in every order"({ check }) {
    {
      const { bus, B, gid, inv } = await falseAliceInvite();
      bus.clock += 11 * MIN;
      await B.engine.tick(); // tick checks the claim first
      check("tick's check is told (invite-updated, unverified, still claiming alice)", of(B, "invite-updated").some((e) => e.inviteId === inv.id && e.verified === false && e.claimedName === "alice"));
      check("tick first, then accept: NOT_VERIFIED", (await code(B.engine.acceptInvite(inv.id))) === "NOT_VERIFIED" && !Object.keys(B.engine.data.joins).length);
      await B.engine.acceptInvite(inv.id, { unverified: true });
      await settle(bus);
      check("the explicit accept joins, admin unverified", B.engine.listGroups().find((g) => g.id === gid)?.adminVerified === false);
    }
    {
      const { B, inv } = await falseAliceInvite();
      const rs = await Promise.all([code(B.engine.acceptInvite(inv.id)), code(B.engine.acceptInvite(inv.id))]);
      check("a double tap: both NOT_VERIFIED, nothing answered", rs.every((r) => r === "NOT_VERIFIED") && !Object.keys(B.engine.data.joins).length, rs.join());
    }
  },

  // ---------- S2 ----------
  async "review 5 S2: leaving after the device answered a re-add removes it everywhere"({ check }) {
    for (const order of ["one batch", "kp then leave", "leave then kp"]) {
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B, C] = M;
      A.held = B.held = C.held = true;
      await B.engine.requestReadd(gid);
      await A.engine.incomingMany(A.queue.splice(0)); // the admin's key-package request
      await B.engine.incomingMany(B.queue.splice(0)); // bob's device answers it by itself
      const kp = A.queue.splice(0);
      await B.engine.leave(gid); // then the user leaves
      const lv = A.queue.splice(0);
      if (order === "one batch") await A.engine.incomingMany([...kp, ...lv]);
      else if (order === "kp then leave") {
        await A.engine.incomingMany(kp);
        await A.engine.incomingMany(lv);
      } else {
        await A.engine.incomingMany(lv);
        await A.engine.incomingMany(kp);
      }
      A.held = B.held = C.held = false;
      await settle(bus);
      check(`(${order}) bob is out at the admin and at carol, and no invitation is left`, !members(A, gid).includes("bob") && !members(C, gid).includes("bob") && !A.engine.listGroups()[0].invited.includes("bob") && gt(B, gid).status === "left", JSON.stringify(members(A, gid)));
    }
    {
      // the fix's own bad case: an old leave replayed after bob came back (same key) doesn't remove him
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B] = M;
      const n0 = bus.posted.length;
      await B.engine.leave(gid);
      await settle(bus);
      const oldLeave = controlsTo(bus, A, n0).find((x) => x.m.kind === "rejoin-request" && bodyOf(x.m).leave === true);
      bus.clock += DAY;
      await A.engine.invite(gid, "bob");
      await settle(bus);
      await B.engine.acceptInvite(B.engine.listInvites().find((i) => i.groupId === gid).id);
      await settle(bus);
      check("(bob is back)", gt(B, gid)?.status === "active");
      A.engine.data.groups[gid].seen.splice(0);
      A.engine.data.seen.splice(0); // as if the seen lists had been flushed
      await A.engine.incomingMany([{ topic: oldLeave.p.topic, bytes: oldLeave.p.bytes }]);
      await settle(bus);
      check("an old leave replayed later doesn't remove him", members(A, gid).includes("bob") && gt(B, gid).status === "active");
    }
  },

  // ---------- S3, S5 ----------
  async "review 5 S3: needs-readd is told again when it becomes true again, and listGroups shows it"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    // the admin's phone is off for 8 days and bob sees a frame from far ahead
    A.held = true;
    await B.engine.incomingMany([{ topic: gt(B, gid).topic, bytes: forged(gid, BigInt(epoch(B, gid)) + 3n, 200) }]);
    for (let k = 0; k < 4 * 8; k++) {
      bus.clock += 6 * 60 * MIN;
      await B.engine.tick();
    }
    check("(needs-readd, and listGroups says so)", of(B, "needs-readd").length === 1 && B.engine.listGroups()[0].needsReadd === true);
    A.queue.splice(0);
    A.held = false;
    for (let k = 0; k < 4; k++) {
      bus.clock += 2 * 60 * MIN;
      await B.engine.tick();
      await settle(bus);
    }
    check("(the admin is back: caught up, the flag is gone)", of(B, "caught-up").length >= 1 && B.engine.listGroups()[0].needsReadd === false);
    // later bob misses 70 commits (the admin keeps 64): the admin's answers say too old
    B.held = true;
    A.engine.timings.adminRefreshMs = HOURS(1);
    for (let k = 0; k < 70; k++) {
      bus.clock += HOURS(1) + 1000;
      await A.engine.tick();
    }
    await A.engine.send(gid, "much later");
    const q = B.queue.splice(0);
    B.held = false;
    await B.engine.incomingMany(q.slice(-1));
    for (let k = 0; k < 6; k++) {
      bus.clock += 70 * MIN;
      await B.engine.tick();
      await settle(bus);
    }
    check("needs-readd is told a second time", of(B, "needs-readd").length === 2 && B.engine.listGroups()[0].needsReadd === true, `${of(B, "needs-readd").length}`);
  },

  async "review 5 S5: tick ending catching-up emits caught-up"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    A.held = true; // nothing answers
    await B.engine.incomingMany([{ topic: gt(B, gid).topic, bytes: forged(gid, BigInt(epoch(B, gid)) + 1n, 200) }]); // held
    for (let k = 0; k < 4 * 9; k++) {
      bus.clock += 6 * 60 * MIN;
      await B.engine.tick();
    }
    check("held item expired: caught-up told, catchingUp false", of(B, "catching-up").length === 1 && of(B, "caught-up").length === 1 && B.engine.listGroups()[0].catchingUp === false);
  },

  // ---------- S4 ----------
  async "review 5 S4: replayed resend requests plus junk give an in-step member no needs-readd"({ check, log }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B, C] = M;
    const STEP = 10 * MIN;
    for (let t = 0; t < 8 * DAY; t += STEP) {
      bus.clock += STEP;
      const stepStart = bus.clock;
      await B.engine.tick();
      bus.clock += 1;
      const e0 = BigInt(epoch(B, gid));
      await B.engine.incomingMany([1n, 2n, 3n].map((k) => ({ topic: gt(B, gid).topic, bytes: forged(gid, e0 + k, 200) })));
      // the observer replays bob's recent earlier requests just before his newest reaches alice
      const old = bus.posted.filter((p) => p.from === B && p.topic === A.engine.inbox && p.t < stepStart).slice(-10);
      A.queue.unshift(...old.map((p) => ({ topic: p.topic, bytes: p.bytes })));
      await A.engine.tick();
      await C.engine.tick();
      await settle(bus);
    }
    log(`    replays refused ${A.engine.stats()["resend-replayed"] ?? 0}; caught-up ${of(B, "caught-up").length}`);
    check("bob in step, never told needs-readd", epoch(B, gid) === epoch(A, gid) && of(B, "needs-readd").length === 0);
    check("the replays were refused", (A.engine.stats()["resend-replayed"] ?? 0) > 0);
  },

  // ---------- S6 ----------
  async "review 5 S6: one key's burst can't fill the failed-lookup map"({ check }) {
    const bus = new Bus();
    const V = await client(bus, "victim");
    const A = await client(bus, "alice");
    const X = freeKey();
    X.name = "zed";
    V.held = true;
    const { id: gr } = await A.engine.createGroup("real", ["victim"]); // alice's real invitation, held on the way
    const real = V.queue.splice(0).filter((x) => x.topic === V.engine.inbox && x.bytes[0] === 2);
    V.held = false;
    bus.down.add("*");
    let left = Array.from({ length: 1100 }, (_, i) => seal(X, V, "kp-request", { gid: hex(rand(32)), name: "g" + i, req: "r" + i }));
    for (let k = 0; k < 3 && left.length; k++) {
      const r = await V.engine.incomingMany(left);
      left = r.failed.map((i) => left[i]);
    }
    check("one key holds only a few counters", V.engine.tries.size <= 10, `${V.engine.tries.size}`);
    bus.clock += 30 * MIN;
    const r = await V.engine.incomingMany(real);
    check("a real invitation 30 minutes later in the same outage is handed back, not given up at once", r.failed.length === 1 && !V.engine.listInvites().some((i) => i.groupId === gr), `${r.failed.length}`);
    bus.down.clear();
    await V.engine.incomingMany(r.failed.map((i) => real[i])); // handed in again once the chain is back
    check("...and once the chain is back it is alice's, verified", V.engine.listInvites().some((i) => i.groupId === gr && i.from === "alice" && i.verified));
  },

  // ---------- read-only items of review 5 ----------
  async "review 5: pending joins and re-add requests are listed and their expiry is told"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    A.held = true; // the admin never answers
    await B.engine.requestReadd(gid);
    check("listRejoins shows the request", B.engine.listRejoins().some((r) => r.groupId === gid && r.readd));
    const D = await client(bus, "dave");
    const X = await client(bus, "xena");
    X.held = true; // xena never adds dave
    const { id: gx } = await X.engine.createGroup("x", []);
    X.held = false;
    await X.engine.invite(gx, "dave");
    X.held = true;
    await settle(bus);
    await D.engine.acceptInvite(D.engine.listInvites()[0].id);
    check("listJoins shows the accepted invitation waiting for its Welcome", D.engine.listJoins().some((j) => j.groupId === gx && j.admin === "xena"));
    bus.clock += 31 * DAY;
    await B.engine.tick();
    await D.engine.tick();
    check("expiry is told", of(B, "rejoin-expired").some((e) => e.groupId === gid) && of(D, "join-expired").some((e) => e.groupId === gx) && !B.engine.listRejoins().length && !D.engine.listJoins().length);
  },

  async "review 5: a leave from the old device doesn't cancel the new device's pending re-add"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    const backup = B.engine.exportBackup();
    const B2 = await client(bus, "bob"); // bob's new key on the chain
    B2.held = true; // the new device's answer waits
    await B2.engine.importBackup(backup);
    await settle(bus); // alice: key-change re-add pending for B2's key
    check("(a re-add is pending for the new key)", A.engine.listGroups()[0].invited.includes("bob"));
    await B.engine.leave(gid); // the old device leaves
    await settle(bus);
    B2.held = false;
    await settle(bus);
    check("the new device still gets in", gt(B2, gid)?.status === "active" && epoch(B2, gid) === epoch(A, gid));
  },

  async "review 5: replaceDeviceKey in two tabs keeps the first tab's migration"({ check }) {
    const { bus, A, M, gid } = await group(["bob", "carol"]);
    const [B] = M;
    const backup = B.engine.exportBackup();
    const seed = ed25519.utils.randomSecretKey();
    bus.chain.set("bob", ed25519.utils.toMontgomery(ed25519.getPublicKey(seed)));
    const n0 = bus.posted.length;
    const start = () => createGroupEngine({ me: { name: "bob", seed }, transport: B.transport, resolver: bus.resolver(), storage: B.storage, cipher: B.cipher, now: bus.now, replaceDeviceKey: backup });
    await Promise.all([start(), start()]);
    // distinct requests (a tab may post another tab's outbox item again; the admin drops the repeat by its hash)
    const asks = new Set(controlsTo(bus, A, n0).filter((x) => x.m.kind === "rejoin-request").map((x) => hex(x.p.bytes.subarray(0, 64)))).size;
    check("two tabs migrating at once: one migration, one re-add request", asks === 1 && B.storage.writes >= 1, `${asks} requests`);
  },

  // ---------- pins for branches review 5's mutation run found unpinned ----------
  async "review 5 pins: the stored key package, the mismatch cache, the per-sender cap before the lookup"({ check }) {
    {
      // a repeated key-package request is answered with the stored key package (one Welcome, bob in)
      const { bus, A, M, gid } = await group(["bob", "carol"]);
      const [B] = M;
      const p0 = bus.posted.length;
      A.held = B.held = true;
      await B.engine.requestReadd(gid);
      await A.engine.incomingMany(A.queue.splice(0));
      await B.engine.incomingMany(B.queue.splice(0).filter((x) => x.topic === B.engine.inbox));
      const kp1 = A.queue.splice(0);
      bus.clock += DAY + MIN;
      await B.engine.requestReadd(gid);
      await A.engine.incomingMany(A.queue.splice(0)); // alice re-sends her request
      await B.engine.incomingMany(B.queue.splice(0).filter((x) => x.topic === B.engine.inbox));
      const kp2 = A.queue.splice(0);
      const kps = controlsTo(bus, A, p0).filter((x) => x.m.kind === "kp").map((x) => bodyOf(x.m).kp);
      check("the same key package both times", kps.length === 2 && kps[0] === kps[1]);
      await A.engine.incomingMany([...kp1, ...kp2]);
      A.held = B.held = false;
      await settle(bus);
      await A.engine.send(gid, "in");
      await settle(bus);
      check("one Welcome, bob in and reading", controlsTo(bus, B, p0).filter((x) => x.m.kind === "welcome").length === 1 && gt(B, gid)?.status === "active" && msgs(B, gid).includes("in"));
    }
    {
      const bus = new Bus();
      const V = await client(bus, "victim");
      await client(bus, "alice");
      const X = freeKey();
      X.name = "alice";
      let calls = 0;
      const inner = V.engine.resolver;
      V.engine.resolver = { msgKey: async (n) => (calls++, inner.msgKey(n)) };
      await V.engine.incomingMany([0, 1, 2].map((i) => seal(X, V, "kp-request", { gid: hex(rand(32)), name: "g", req: "r" + i })));
      check("mismatch cache: three invitations from one false 'alice' cost one lookup", calls === 1 && V.engine.listInvites().length === 3, `${calls}`);
      bus.clock += 2 * MIN; // the cache has expired
      calls = 0;
      await V.engine.incomingMany([3, 4, 5].map((i) => seal(X, V, "kp-request", { gid: hex(rand(32)), name: "g", req: "r" + i })));
      check("cap before the lookup: a key holding its 3 places costs no lookup", calls === 0, `${calls}`);
    }
  },
};
const HOURS = (n) => n * 60 * MIN;

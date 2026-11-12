// Sizes and timings for GROUPS-PLAN 6.4/6.5 (32 members; a sealed control message is at most 64 KiB):
//   - time to create a group, add a member (admin's commit), join from the Welcome, and process a commit
//   - Welcome size (TLS-encoded MLSMessage, ratchet_tree extension included) and stored group state size
//     for 2, 8, 16 and 32 members, built the way the plan's admin would (one add per commit, after an
//     initial self-update) and all at once; plus what that is as base64 inside a v2 sealed message
//   - group state save/load: encode -> decode -> encode is identical, and the reloaded state still works
// Measurements, not pass/fail (runner.mjs's verdict doesn't depend on them), except that errors are reported.
const te = new TextEncoder();
const td = new TextDecoder();
const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
// v2 sealed control message (GROUPS-PLAN 6.5): header 1 + 32 + 24, tag 16, JSON around a base64 body.
const SEAL_OVERHEAD = 1 + 32 + 24 + 16;
const JSON_OVERHEAD = 400; // {v,from,fromKey(64 hex),kind,ts,auth(64 hex)} + group_id, generous
const v2Sealed = (raw) => SEAL_OVERHEAD + JSON_OVERHEAD + 4 * Math.ceil(raw / 3);

export async function run({ mls, providers, log }) {
  const cs = mls.getCiphersuiteFromName(SUITE);
  const out = { providers: {} };
  const encWelcome = (welcome) => mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome });
  const encPrivate = (privateMessage) => mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_private_message", privateMessage });

  for (const [pname, provider] of Object.entries(providers)) {
    const impl = await provider.getCiphersuiteImpl(cs);
    const kp = (name) => mls.generateKeyPackage({ credentialType: "basic", identity: te.encode(name) }, mls.defaultCapabilities(), mls.defaultLifetime, [], impl);
    const add = (k) => ({ proposalType: "add", add: { keyPackage: k.publicPackage } });
    const commit = (state, extraProposals = []) => mls.createCommit({ state, cipherSuite: impl }, { extraProposals, ratchetTreeExtension: true });
    const now = () => performance.now();
    const r = { timingsMs: {}, members: {} };
    out.providers[pname] = r;

    // timings, 3 people
    let t = now();
    const a = await kp("alice");
    r.timingsMs.keyPackage = now() - t;
    t = now();
    let ga = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), a.publicPackage, a.privatePackage, [], impl);
    r.timingsMs.createGroup = now() - t;
    const b = await kp("bob");
    t = now();
    let c1 = await commit(ga, [add(b)]);
    r.timingsMs.addMemberCommit = now() - t;
    ga = c1.newState;
    t = now();
    let gb = await mls.joinGroup(c1.welcome, b.publicPackage, b.privatePackage, mls.emptyPskIndex, impl);
    r.timingsMs.joinFromWelcome = now() - t;
    const c = await kp("carol");
    const c2 = await commit(ga, [add(c)]);
    ga = c2.newState;
    t = now();
    const p = await mls.processPrivateMessage(gb, c2.commit.privateMessage, mls.makePskIndex(gb, {}), impl);
    r.timingsMs.processAddCommit = now() - t;
    gb = p.newState;
    const c3 = await commit(ga); // empty commit = admin self-update with an UpdatePath
    ga = c3.newState;
    t = now();
    gb = (await mls.processPrivateMessage(gb, c3.commit.privateMessage, mls.makePskIndex(gb, {}), impl)).newState;
    r.timingsMs.processUpdateCommit = now() - t;
    t = now();
    const m = await mls.createApplicationMessage(ga, te.encode("x".repeat(200)), impl);
    r.timingsMs.encryptMessage = now() - t;
    ga = m.newState;
    t = now();
    const got = await mls.processPrivateMessage(gb, m.privateMessage, mls.makePskIndex(gb, {}), impl);
    r.timingsMs.decryptMessage = now() - t;
    r.appMessage200CharsBytes = encPrivate(m.privateMessage).length;
    r.addCommitBytes = encPrivate(c2.commit.privateMessage).length;
    r.keyPackageBytes = mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage: b.publicPackage }).length;
    if (td.decode(got.message) !== "x".repeat(200)) throw new Error("message did not round-trip");
    for (const k of Object.keys(r.timingsMs)) r.timingsMs[k] = Math.round(r.timingsMs[k] * 10) / 10;

    // sizes by group size. "admin": creator self-updates once, then adds one member per commit (each new
    // member joins from its Welcome); "allAtOnce": one commit adds everyone.
    for (const n of [2, 8, 16, 32]) {
      const row = {};
      // all at once
      {
        const admin = await kp("admin");
        let g = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), admin.publicPackage, admin.privatePackage, [], impl);
        const ks = [];
        for (let i = 1; i < n; i++) ks.push(await kp(`m${i}`));
        const t0 = now();
        const cc = await commit(g, ks.map(add));
        row.allAtOnceCommitMs = Math.round(now() - t0);
        g = cc.newState;
        row.allAtOnceWelcome = encWelcome(cc.welcome).length;
        const t1 = now();
        await mls.joinGroup(cc.welcome, ks[n - 2].publicPackage, ks[n - 2].privatePackage, mls.emptyPskIndex, impl);
        row.allAtOnceJoinMs = Math.round(now() - t1);
      }
      // the admin's way
      {
        const admin = await kp("admin");
        let g = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), admin.publicPackage, admin.privatePackage, [], impl);
        g = (await commit(g)).newState;
        let lastWelcome;
        let member;
        let joinErrors = 0;
        let firstJoinError;
        for (let i = 1; i < n; i++) {
          const k = await kp(`m${i}`);
          const cc = await commit(g, [add(k)]);
          g = cc.newState;
          lastWelcome = cc.welcome;
          try {
            member = await mls.joinGroup(cc.welcome, k.publicPackage, k.privatePackage, mls.emptyPskIndex, impl);
          } catch (e) {
            joinErrors++;
            firstJoinError ??= `member ${i + 1}: ${e?.message}`;
          }
        }
        row.oneByOneWelcome = encWelcome(lastWelcome).length;
        row.oneByOneJoinErrors = joinErrors;
        if (firstJoinError) row.oneByOneFirstJoinError = firstJoinError;
        const adminState = mls.encodeGroupState(g);
        row.adminStateBytes = adminState.length;
        if (member) row.memberStateBytes = mls.encodeGroupState(member).length;
        row.welcomeAsV2SealedBytes = v2Sealed(Math.max(row.oneByOneWelcome, row.allAtOnceWelcome));
        // save/load: identical bytes, and the reloaded admin can still commit and send
        const decoded = mls.decodeGroupState(adminState, 0)?.[0];
        const again = mls.encodeGroupState(decoded);
        row.stateRoundTripIdentical = again.length === adminState.length && again.every((x, i) => x === adminState[i]);
        if (member && n === 32) {
          const reloadedAdmin = { ...decoded, clientConfig: g.clientConfig };
          const mState = mls.decodeGroupState(mls.encodeGroupState(member), 0)[0];
          let reloadedMember = { ...mState, clientConfig: member.clientConfig };
          const msg = await mls.createApplicationMessage(reloadedAdmin, te.encode("after reload"), impl);
          const rcv = await mls.processPrivateMessage(reloadedMember, msg.privateMessage, mls.makePskIndex(reloadedMember, {}), impl);
          reloadedMember = rcv.newState;
          const upd = await commit(msg.newState);
          const rc2 = await mls.processPrivateMessage(reloadedMember, upd.commit.privateMessage, mls.makePskIndex(reloadedMember, {}), impl);
          row.reloadedStateWorks = td.decode(rcv.message) === "after reload" && rc2.newState.groupContext.epoch === upd.newState.groupContext.epoch;
        }
      }
      r.members[n] = row;
      log(`sizes ${pname} n=${n}: ${JSON.stringify(row)}`);
    }
  }
  out.limitNote = "plan: sealed v2 control message <= 65536 bytes; welcomeAsV2SealedBytes = base64 Welcome + seal + ~400 B JSON";
  return out;
}

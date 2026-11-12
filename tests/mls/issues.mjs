// The ts-mls issues filed on 2026-11-05 (#856-#860), checked against the bundle with cipher suite 1 and the
// default provider. Each entry says what was observed; none of them is part of the pass/fail verdict.
//   #860  joinGroup rejects a valid Welcome after two add-only commits   -> the issue's repro, then the workaround
//   #856  old epoch secrets dropped but never zeroed                    -> in memory, and what a stolen stored
//                                                                          state can still decrypt
//   #857  proposal reference "toString"                                   -> applyProposals directly
//   #859  external commit may remove any member                           -> an external commit that removes Bob
//   #858  unmerged_leaves && vs ||                                         -> where validateRatchetTree runs (no test)
//   plus: the IncomingMessageCallback can reject a commit not sent by the admin (leaf 0), and when it runs
const te = new TextEncoder();
const td = new TextDecoder();
const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

export async function run({ mls, providers, log }) {
  const impl = await providers.default.getCiphersuiteImpl(mls.getCiphersuiteFromName(SUITE));
  const I = mls.internals;
  const kp = (name) => mls.generateKeyPackage({ credentialType: "basic", identity: te.encode(name) }, mls.defaultCapabilities(), mls.defaultLifetime, [], impl);
  const add = (k) => ({ proposalType: "add", add: { keyPackage: k.publicPackage } });
  const commit = (state, extraProposals = [], opts = {}) => mls.createCommit({ state, cipherSuite: impl }, { extraProposals, ratchetTreeExtension: true, ...opts });
  const proc = (state, pm, cb) => mls.processPrivateMessage(state, pm, mls.makePskIndex(state, {}), impl, cb);
  const newGroup = async (name = "admin") => {
    const a = await kp(name);
    return mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), a.publicPackage, a.privatePackage, [], impl);
  };
  const out = {};
  const guard = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: `${e?.constructor?.name}: ${e?.message}` };
    }
    log(`issues ${name}: ${JSON.stringify(out[name])}`);
  };

  // #860, the issue's own reproduction, then with an empty commit (admin self-update) before every Add.
  const scenario860 = async (emptyCommitBeforeAdd) => {
    let s = await newGroup("a");
    const addOne = async (name) => {
      if (emptyCommitBeforeAdd) s = (await commit(s)).newState;
      const k = await kp(name);
      const r = await commit(s, [add(k)]);
      s = r.newState;
      return [r, k];
    };
    for (const n of ["b", "c", "d", "e"]) await addOne(n);
    s = (await commit(s)).newState; // self-update
    s = (await commit(s, [{ proposalType: "remove", remove: { removed: 2 } }])).newState; // frees leaf 2
    const joins = [];
    for (const n of ["f", "g"]) {
      const [r, k] = await addOne(n);
      try {
        await mls.joinGroup(r.welcome, k.publicPackage, k.privatePackage, mls.emptyPskIndex, impl);
        joins.push(`${n} joined`);
      } catch (e) {
        joins.push(`${n} FAILED: ${e?.message}`);
      }
    }
    return joins;
  };
  await guard("860", async () => ({
    issueRepro: await scenario860(false),
    withEmptyCommitBeforeEachAdd: await scenario860(true),
  }));

  // #856: after an epoch leaves the 4-epoch window its secret-tree values are dropped but not zeroed, even when
  // the app zeroes every `consumed` array as ts-mls asks. And: what a copy of a member's stored state decrypts.
  await guard("856", async () => {
    const admin = await kp("admin");
    const bob = await kp("bob");
    let ga = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), admin.publicPackage, admin.privatePackage, [], impl);
    const c = await commit(ga, [add(bob)]);
    ga = c.newState;
    let gb = await mls.joinGroup(c.welcome, bob.publicPackage, bob.privatePackage, mls.emptyPskIndex, impl);
    const startEpoch = gb.groupContext.epoch;
    const held = I["secretTree.js"].allSecretTreeValues(gb.secretTree).filter(Boolean);
    const msgs = [];
    for (let i = 0; i < 8; i++) {
      // two messages per epoch: Bob reads one, misses the other
      for (const kind of ["read", "missed"]) {
        const m = await mls.createApplicationMessage(ga, te.encode(`${kind} in epoch ${ga.groupContext.epoch}`), impl);
        ga = m.newState;
        m.consumed.forEach(mls.zeroOutUint8Array);
        msgs.push({ epoch: ga.groupContext.epoch, kind, pm: m.privateMessage });
        if (kind === "read") {
          const r = await proc(gb, m.privateMessage);
          gb = r.newState;
          r.consumed.forEach(mls.zeroOutUint8Array);
        }
      }
      const cc = await commit(ga);
      ga = cc.newState;
      cc.consumed.forEach(mls.zeroOutUint8Array);
      const r = await proc(gb, cc.commit.privateMessage);
      gb = r.newState;
      r.consumed.forEach(mls.zeroOutUint8Array);
    }
    const nonZero = held.filter((b) => b.some((x) => x !== 0)).length;
    // Steal Bob's stored state now and try every message from a fresh copy of it.
    const stolen = mls.encodeGroupState(gb);
    const readable = {};
    for (const m of msgs) {
      const copy = { ...mls.decodeGroupState(stolen, 0)[0], clientConfig: gb.clientConfig };
      let res;
      try {
        const r = await proc(copy, m.pm);
        res = td.decode(r.message).startsWith(m.kind) ? "decrypts" : "wrong text";
      } catch (e) {
        res = `no (${e?.message})`;
      }
      readable[`epoch ${m.epoch} ${m.kind}`] = res;
    }
    return {
      epochNow: String(gb.groupContext.epoch),
      epochsInStoredState: [...gb.historicalReceiverData.keys()].map(String),
      startEpochStillInState: gb.historicalReceiverData.has(startEpoch),
      startEpochSecretsHeld: held.length,
      startEpochSecretsStillNonZeroInMemory: nonZero,
      storedStateBytes: stolen.length,
      whatAStolenStoredStateDecrypts: readable,
    };
  });

  // #857: a commit's proposal reference whose base64 is "toString" finds Object.prototype.toString.
  await guard("857", async () => {
    const g = await newGroup();
    const ref = Uint8Array.from(atob("toString"), (ch) => ch.charCodeAt(0));
    const tryRef = async (reference) => {
      try {
        await I["clientState.js"].applyProposals(g, [{ proposalOrRefType: "reference", reference }], 0, mls.makePskIndex(g, {}), false, impl);
        return "accepted";
      } catch (e) {
        return `${e?.constructor?.name}: ${e?.message}`;
      }
    };
    return {
      toStringReference: await tryRef(ref),
      randomReference: await tryRef(crypto.getRandomValues(new Uint8Array(6))),
    };
  });

  // #859: an external commit (from anyone holding a GroupInfo) that removes Bob, who isn't the joiner.
  // joinGroupExternal picks the leaf to remove through keyPackageEqualityConfig, so a config that matches Bob's
  // leaf makes it build Remove(Bob). Then: what the admin does with acceptAll, and with a callback that rejects
  // commits not sent by leaf 0.
  await guard("859", async () => {
    const admin = await kp("admin");
    const bob = await kp("bob");
    const mallory = await kp("mallory");
    let ga = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), admin.publicPackage, admin.privatePackage, [], impl);
    ga = (await commit(ga, [add(bob)])).newState;
    const gi = await mls.createGroupInfoWithExternalPubAndRatchetTree(ga, [], impl);
    const bobSig = bob.publicPackage.leafNode.signaturePublicKey;
    const evilConfig = {
      ...ga.clientConfig,
      keyPackageEqualityConfig: {
        ...mls.defaultKeyPackageEqualityConfig,
        compareKeyPackageToLeafNode: (_kp, leaf) => leaf.signaturePublicKey.every((x, i) => x === bobSig[i]),
      },
    };
    const ext = await mls.joinGroupExternal(gi, mallory.publicPackage, mallory.privatePackage, true, impl, undefined, evilConfig);
    const names = (s) => s.ratchetTree.filter((n) => n?.nodeType === "leaf").map((n) => td.decode(n.leaf.credential.identity));
    const result = { externalCommitProposals: ext.publicMessage.content.commit.proposals.map((p) => p.proposal?.proposalType) };
    try {
      const r = await mls.processPublicMessage(ga, ext.publicMessage, mls.makePskIndex(ga, {}), impl);
      result.withAcceptAll = `accepted; members now ${names(r.newState)}`;
    } catch (e) {
      result.withAcceptAll = `refused: ${e?.message}`;
    }
    const onlyAdmin = (x) => (x.kind === "commit" && x.senderLeafIndex !== 0 ? "reject" : "accept");
    const r2 = await mls.processPublicMessage(ga, ext.publicMessage, mls.makePskIndex(ga, {}), impl, onlyAdmin);
    result.withOnlyAdminCallback = `${r2.actionTaken}; members ${names(r2.newState)}; epoch ${r2.newState.groupContext.epoch} (was ${ga.groupContext.epoch})`;
    result.wireformat = "external commits are always PublicMessage (sender new_member_commit)";
    return result;
  });

  // The admin-only rule: a member's own commit reaches applyProposals before the callback; the callback then sees
  // senderLeafIndex and can reject it, leaving the epoch unchanged.
  await guard("onlyAdminCommits", async () => {
    const admin = await kp("admin");
    const bob = await kp("bob");
    const carol = await kp("carol");
    let ga = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), admin.publicPackage, admin.privatePackage, [], impl);
    const c = await commit(ga, [add(bob)]);
    ga = c.newState;
    const gb = await mls.joinGroup(c.welcome, bob.publicPackage, bob.privatePackage, mls.emptyPskIndex, impl);
    const bobCommit = await commit(gb, [add(carol)]);
    const seen = [];
    const onlyAdmin = (x) => {
      seen.push({ kind: x.kind, senderLeafIndex: x.senderLeafIndex });
      return x.kind === "commit" && x.senderLeafIndex !== 0 ? "reject" : "accept";
    };
    const r = await proc(ga, bobCommit.commit.privateMessage, onlyAdmin);
    return { callbackSaw: seen, actionTaken: r.actionTaken, epochBefore: String(ga.groupContext.epoch), epochAfter: String(r.newState.groupContext.epoch) };
  });

  out["858"] = {
    note: "validateRatchetTree runs only in joinGroup (the Welcome's tree) and joinGroupExternal (src/clientState.ts:1019, src/createCommit.ts:530 at v1.6.4); never on commits. No test written.",
  };
  return out;
}

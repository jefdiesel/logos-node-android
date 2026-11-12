// GROUPS-PLAN 6.2: one Ed25519 seed per device. Its X25519 form is the name's `msg` key (1:1 messages, format
// 0.8.1 unchanged) and its Ed25519 key signs the device's MLS leaf. Checked with the app's vendored noble and
// the bundle:
//   1. toMontgomery(edPub) == x25519.getPublicKey(toMontgomerySecret(seed)), random seeds + RFC 8032 test 1
//   2. a 0.8.1 message sealed to that X25519 key opens with the derived secret, and one sealed *from* it is
//      verified against the X25519 key as on-chain `msg`
//   3. Ed25519 signatures from WebCrypto (ts-mls default) and from noble are byte-identical for the same seed
//   4. an MLS group whose creator's leaf uses the seed: a second member joins from the Welcome (leaf, KeyPackage
//      and GroupInfo signatures checked by ts-mls), reads a message, and finds toMontgomery(leaf key) == msg key;
//      under each provider and across them
import { ed25519, x25519 } from "../app/noble-curves/ed25519.js";
import { sealMessage, openMessage, isVerified, newKeyPair, toHex, fromHex } from "../app/messages/msg-crypto.js";

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const te = new TextEncoder();
const td = new TextDecoder();

export async function run({ mls, providers, log }) {
  const out = { ok: false, checks: {} };
  const check = (name, cond, detail) => {
    out.checks[name] = cond ? "ok" : `FAILED${detail ? `: ${detail}` : ""}`;
    if (!cond) log(`identity: ${name} FAILED ${detail ?? ""}`);
  };

  // 1. the conversion identity
  const RFC8032_1 = {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  };
  check("RFC 8032 test 1 public key", toHex(ed25519.getPublicKey(fromHex(RFC8032_1.seed))) === RFC8032_1.pub);
  const seeds = [fromHex(RFC8032_1.seed), ...Array.from({ length: 200 }, () => ed25519.utils.randomSecretKey())];
  let same = 0;
  for (const seed of seeds) {
    const edPub = ed25519.getPublicKey(seed);
    if (eq(ed25519.utils.toMontgomery(edPub), x25519.getPublicKey(ed25519.utils.toMontgomerySecret(seed)))) same++;
  }
  check(`toMontgomery(edPub) == x25519.getPublicKey(toMontgomerySecret(seed)) for ${seeds.length} seeds`, same === seeds.length, `${same}/${seeds.length}`);
  out.seedsChecked = seeds.length;

  // 2. 1:1 sealing (app/messages/msg-crypto.js, the 0.8.1 format) both ways
  let opened = 0;
  let verifiedFrom = 0;
  for (const seed of seeds.slice(0, 50)) {
    const msgKey = ed25519.utils.toMontgomery(ed25519.getPublicKey(seed)); // what the name publishes as `msg`
    const msgSecret = ed25519.utils.toMontgomerySecret(seed);
    const peer = newKeyPair();
    const toMe = sealMessage({ to: msgKey, from: "alice", fromSecret: peer.secretKey, text: "hello", ts: 1731400000000 });
    const m = openMessage(msgSecret, toMe);
    if (m && m.text === "hello" && m.authentic && isVerified(m, toHex(peer.publicKey))) opened++;
    const fromMe = sealMessage({ to: peer.publicKey, from: "bob", fromSecret: msgSecret, text: "hi", ts: 1731400000001 });
    const n = openMessage(peer.secretKey, fromMe);
    if (n && n.text === "hi" && isVerified(n, toHex(msgKey))) verifiedFrom++;
  }
  check("0.8.1 message sealed to the seed's X25519 key opens with toMontgomerySecret(seed)", opened === 50, `${opened}/50`);
  check("0.8.1 message sealed from toMontgomerySecret(seed) verifies against the X25519 key as on-chain msg", verifiedFrom === 50, `${verifiedFrom}/50`);

  // 3. WebCrypto and noble Ed25519 agree byte for byte
  const SUITE = mls.getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519");
  const implDefault = await providers.default.getCiphersuiteImpl(SUITE);
  const implApp = await providers.app.getCiphersuiteImpl(SUITE);
  let agree = 0;
  for (const seed of seeds.slice(0, 50)) {
    const msg = crypto.getRandomValues(new Uint8Array(100));
    const a = await implDefault.signature.sign(seed, msg);
    const b = ed25519.sign(msg, seed);
    const edPub = ed25519.getPublicKey(seed);
    if (eq(a, b) && ed25519.verify(a, msg, edPub) && (await implDefault.signature.verify(edPub, msg, b))) agree++;
  }
  check("WebCrypto (ts-mls default) and noble Ed25519 signatures identical and cross-verify", agree === 50, `${agree}/50`);

  // 4. MLS group with seed-based leaves
  const runGroup = async (implA, implB, label) => {
    const seedA = ed25519.utils.randomSecretKey();
    const seedB = ed25519.utils.randomSecretKey();
    const msgKeyA = ed25519.utils.toMontgomery(ed25519.getPublicKey(seedA));
    const kp = (name, seed, impl) =>
      mls.generateKeyPackageWithKey(
        { credentialType: "basic", identity: te.encode(name) },
        mls.defaultCapabilities(),
        mls.defaultLifetime,
        [],
        { signKey: seed, publicKey: ed25519.getPublicKey(seed) },
        impl,
      );
    const a = await kp("alice", seedA, implA);
    const b = await kp("bob", seedB, implB);
    let ga = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), a.publicPackage, a.privatePackage, [], implA);
    const c = await mls.createCommit({ state: ga, cipherSuite: implA }, { extraProposals: [{ proposalType: "add", add: { keyPackage: b.publicPackage } }], ratchetTreeExtension: true });
    ga = c.newState;
    let gb = await mls.joinGroup(c.welcome, b.publicPackage, b.privatePackage, mls.emptyPskIndex, implB);
    const sent = await mls.createApplicationMessage(ga, te.encode("hello group"), implA);
    const got = await mls.processPrivateMessage(gb, sent.privateMessage, mls.makePskIndex(gb, {}), implB);
    const leafA = gb.ratchetTree.find((n) => n?.nodeType === "leaf" && td.decode(n.leaf.credential.identity) === "alice");
    const leafBinds = !!leafA && eq(ed25519.utils.toMontgomery(leafA.leaf.signaturePublicKey), msgKeyA);
    check(`MLS (${label}): Bob joins Alice's seed-keyed group, reads her message`, got.kind === "applicationMessage" && td.decode(got.message) === "hello group");
    check(`MLS (${label}): toMontgomery(Alice's leaf signature key) == her msg key`, leafBinds);
    // and the other way: Bob's seed-keyed leaf signs a message Alice accepts
    const back = await mls.createApplicationMessage(got.newState, te.encode("hi alice"), implB);
    const got2 = await mls.processPrivateMessage(ga, back.privateMessage, mls.makePskIndex(ga, {}), implA);
    check(`MLS (${label}): Alice reads Bob's message (signed with his seed)`, got2.kind === "applicationMessage" && td.decode(got2.message) === "hi alice");
  };
  await runGroup(implDefault, implDefault, "default provider");
  await runGroup(implApp, implApp, "app provider");
  await runGroup(implDefault, implApp, "Alice default, Bob app");
  await runGroup(implApp, implDefault, "Alice app, Bob default");

  // A KeyPackage signed by a different key than the leaf claims must be refused when added.
  try {
    const seed = ed25519.utils.randomSecretKey();
    const other = ed25519.utils.randomSecretKey();
    const bad = await mls.generateKeyPackageWithKey(
      { credentialType: "basic", identity: te.encode("mallory") },
      mls.defaultCapabilities(),
      mls.defaultLifetime,
      [],
      { signKey: other, publicKey: ed25519.getPublicKey(seed) },
      implDefault,
    );
    const a = await mls.generateKeyPackage({ credentialType: "basic", identity: te.encode("alice") }, mls.defaultCapabilities(), mls.defaultLifetime, [], implDefault);
    const ga = await mls.createGroup(crypto.getRandomValues(new Uint8Array(32)), a.publicPackage, a.privatePackage, [], implDefault);
    let refused = false;
    try {
      await mls.createCommit({ state: ga, cipherSuite: implDefault }, { extraProposals: [{ proposalType: "add", add: { keyPackage: bad.publicPackage } }] });
    } catch (e) {
      refused = true;
      out.badKeyPackageError = `${e?.constructor?.name}: ${e?.message}`;
    }
    check("a KeyPackage whose signature doesn't match its leaf key is refused by createCommit", refused);
  } catch (e) {
    check("a KeyPackage whose signature doesn't match its leaf key is refused by createCommit", false, e?.message);
  }

  out.ok = Object.values(out.checks).every((v) => v === "ok");
  log(`identity: ${Object.values(out.checks).filter((v) => v === "ok").length}/${Object.keys(out.checks).length} checks ok`);
  return out;
}

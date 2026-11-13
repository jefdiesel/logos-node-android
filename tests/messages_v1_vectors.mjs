// Names Messages version 1: test vectors (tests/vectors/messages-v1.json), as specified in
// docs/audit/messages-v1-spec.md.
//
//   node tests/messages_v1_vectors.mjs           check the vectors
//   node tests/messages_v1_vectors.mjs --write   write the vectors file again (then review the diff)
//
// Two implementations meet here:
//   1. A reference written from the spec in this file, on node:crypto only (X25519, HKDF-SHA256, HMAC-SHA256,
//      SHA-512, ChaCha20-Poly1305) plus HChaCha20 written out below. It produces every vector, with every
//      intermediate value, from fixed TEST-ONLY keys, ephemerals and nonces.
//   2. The app's own code (app/messages/msg-crypto.js, chat-core.js, identity.js), unchanged. Its randomness
//      (globalThis.crypto.getRandomValues: the ephemeral secret, then the nonce) is replaced for the duration of
//      one call by the fixed values of the vector, so sealMessage and encryptBlob give exact bytes.
// The check fails if the file differs from what the reference makes, or if the app differs from the file.
//
// EVERY KEY, SEED, EPHEMERAL AND NONCE HERE IS PUBLIC TEST DATA. Never use them for anything real.
import crypto from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const FILE = join(here, "vectors", "messages-v1.json");
const WRITE = process.argv.includes("--write");
let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.log("FAIL " + name + (detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 400) : ""));
}

// ---- the reference, from the spec ------------------------------------------------------------------
const B = (x) => Buffer.from(x);
const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => Buffer.from(h, "hex");
const utf8 = (s) => Buffer.from(s, "utf8");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const tv = (label) => sha256(utf8("names-msg-v1 TEST ONLY " + label));          // fixed test bytes
const X_PKCS8 = unhex("302e020100300506032b656e04220420"), X_SPKI = unhex("302a300506032b656e032100");
const E_PKCS8 = unhex("302e020100300506032b657004220420");
const xPriv = (sk) => crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, B(sk)]), format: "der", type: "pkcs8" });
const xPubKey = (pk) => crypto.createPublicKey({ key: Buffer.concat([X_SPKI, B(pk)]), format: "der", type: "spki" });
const rawPub = (k) => B(crypto.createPublicKey(k).export({ format: "der", type: "spki" })).subarray(12);
const x25519Pub = (sk) => rawPub(xPriv(sk));
const x25519 = (sk, pk) => B(crypto.diffieHellman({ privateKey: xPriv(sk), publicKey: xPubKey(pk) }));
const hkdf = (ikm, salt, info) => B(crypto.hkdfSync("sha256", ikm, salt, info, 32));
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(4 * i);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(4 * i);
  const rotl = (v, c) => (v << c) | (v >>> (32 - c));
  const qr = (a, b, c, d) => {
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 16); s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 8); s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], 4 * i));
  return out;
}
function xchachaSeal(key, nonce24, aad, plain) {
  const iv = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const c = crypto.createCipheriv("chacha20-poly1305", hchacha20(key, nonce24.subarray(0, 16)), iv, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plain.length });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
const topicOf = (pub) => "/names/1/msg-" + hex(sha256(pub)).slice(0, 16) + "/proto";

/** Seals as the spec says, with every input given; overrides make the negative vectors. */
function refSeal(o) {
  const version = o.version ?? 1;
  const ephPub = o.ephPublic ?? x25519Pub(o.ephSecret);
  const header = Buffer.concat([B([version]), ephPub, o.nonce]);
  const sharedEph = x25519(o.ephSecret, o.to);
  const msgKey = hkdf(sharedEph, Buffer.concat([ephPub, o.to]), utf8("names/msg/v1"));
  const fromKeyBytes = o.fromKeyBytes ?? x25519Pub(o.fromSecret);
  const sharedStatic = x25519(o.fromSecret, o.to);
  const authKey = hkdf(sharedStatic, Buffer.alloc(0), utf8("names/msg/v1/auth"));
  const authInput = Buffer.concat([header, utf8(o.from), B([0]), fromKeyBytes, utf8(String(o.ts)), B([0]), utf8(o.text)]);
  const auth = hex(hmac(authKey, authInput));
  const obj = { v: o.v ?? 1, from: o.from, fromKey: o.fromKeyText ?? hex(fromKeyBytes), text: o.text, ts: o.ts, auth: o.authText ?? auth };
  if (o.edit) o.edit(obj);
  const plaintext = o.plaintext ?? utf8(o.json ?? JSON.stringify(obj));
  const aad = Buffer.concat([B([version]), ephPub]);
  const sealed = xchachaSeal(msgKey, o.nonce, aad, plaintext);
  return { ephPub, header, sharedEph, msgKey, sharedStatic, authKey, authInput, auth, plaintext, aad, sealed,
           payload: Buffer.concat([header, sealed]) };
}

// Ed25519 seed -> X25519 pair (identity.js; server.py montgomery_secret)
const P = (1n << 255n) - 19n;
const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const toLe = (n) => { const out = Buffer.alloc(32); for (let i = 0; i < 32; i++) { out[i] = Number(n & 255n); n >>= 8n; } return out; };
const modpow = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; };
function identity(seed) {
  const h = crypto.createHash("sha512").update(seed).digest().subarray(0, 32);
  const secret = B(h); secret[0] &= 248; secret[31] &= 127; secret[31] |= 64;
  const edPublic = rawPub(crypto.createPrivateKey({ key: Buffer.concat([E_PKCS8, seed]), format: "der", type: "pkcs8" }));
  const y = le(edPublic) & ((1n << 255n) - 1n);
  const u = (1n + y) * modpow((1n - y + P) % P, P - 2n) % P;                       // birational map to Montgomery
  const publicKey = x25519Pub(secret);
  if (!toLe(u).equals(publicKey)) throw new Error("reference: Montgomery form of the Ed25519 key != X25519 public key");
  return { seed: hex(seed), x25519_secret: hex(secret), x25519_public: hex(publicKey), ed25519_public: hex(edPublic), topic: topicOf(publicKey) };
}

// ---- the vectors -----------------------------------------------------------------------------------
function build() {
  const hk = { key: unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), nonce: unhex("000000090000004a0000000031415927") };
  const keys = {};
  for (const n of ["alice", "bob", "carol"]) {
    const secret = tv("static secret " + n);
    keys[n] = { secret: hex(secret), public: hex(x25519Pub(secret)), topic: topicOf(x25519Pub(secret)) };
  }
  const S = (n) => unhex(keys[n].secret), PK = (n) => unhex(keys[n].public);
  const dave = identity(tv("identity seed dave"));
  const ident = [dave, identity(tv("identity seed erin"))];
  const eph = (i) => tv("ephemeral " + i);
  const nonce = (i) => tv("nonce " + i).subarray(0, 24);
  const nameless = (pub) => "msg-" + hex(pub).slice(0, 16);
  const T0 = 1794489600000;

  const sealCases = [
    { id: "named-ascii", from: "alice", sender: "alice", to: "bob", text: "hello bob", ts: T0 },
    { id: "named-unicode", from: "bob", sender: "bob", to: "alice", text: "Grüße zurück — 你好 ✓ 👋", ts: T0 + 60000 },
    { id: "address-only-sender", from: nameless(PK("carol")), sender: "carol", to: "bob", text: "no name here", ts: T0 + 120000,
      note: "a sender with no LNS name: `from` is \"msg-\" and the first 16 hex of its own public key" },
    { id: "identity-seed-sender", from: "dave", sender: "dave", to: "bob", text: "sealed with a key made from an Ed25519 seed", ts: T0 + 180000,
      note: "the sender's X25519 secret is derived from identities[0].seed" },
    { id: "max-text-max-expansion", from: "alice", sender: "alice", to: "bob", text: "\u0001".repeat(2000), ts: T0 + 240000,
      note: "2000 UTF-16 code units (the limit), each escaped by JSON.stringify to 6 bytes: the largest plaintext a conforming sender makes" },
  ];
  const secretOf = (who) => who === "dave" ? unhex(dave.x25519_secret) : S(who);
  const seal = sealCases.map((c, i) => {
    const r = refSeal({ to: PK(c.to), from: c.from, fromSecret: secretOf(c.sender), text: c.text, ts: c.ts, ephSecret: eph(i), nonce: nonce(i) });
    return {
      id: c.id, ...(c.note ? { note: c.note } : {}), sender: c.sender, recipient: c.to, from: c.from, text: c.text, ts: c.ts,
      ephemeral_secret: hex(eph(i)), nonce: hex(nonce(i)),
      ephemeral_public: hex(r.ephPub), header: hex(r.header), shared_ephemeral: hex(r.sharedEph), message_key: hex(r.msgKey),
      aad: hex(r.aad), shared_static: hex(r.sharedStatic), auth_key: hex(r.authKey), auth_input: hex(r.authInput), auth: r.auth,
      plaintext: r.plaintext.toString("utf8"), payload: hex(r.payload), payload_length: r.payload.length, topic: topicOf(PK(c.to)),
      open: { id: hex(r.ephPub), from: c.from, fromKey: hex(x25519Pub(secretOf(c.sender))), text: c.text, ts: c.ts, authentic: true },
    };
  });

  // negative and edge vectors: what openMessage returns for each (null = dropped)
  const base = { to: PK("bob"), from: "alice", fromSecret: S("alice"), text: "hello bob", ts: T0 };
  let k = 100;
  const mk = (over) => refSeal({ ...base, ephSecret: eph(k), nonce: nonce(k++), ...over });
  const p1 = unhex(seal[0].payload);
  const flip = (buf, at, x = 1) => { const b = B(buf); b[at < 0 ? b.length + at : at] ^= x; return b; };
  const opened = (r, over = {}) => ({ id: hex(r.ephPub), from: "alice", fromKey: keys.alice.public, text: "hello bob", ts: T0, authentic: true, ...over });
  const open = [];
  const add = (id, recipient, payload, expect, note) => open.push({ id, note, recipient, payload: hex(payload), expect });
  add("bad-tag", "bob", flip(p1, -1), null, "last byte of the Poly1305 tag changed");
  add("bad-ciphertext", "bob", flip(p1, 60), null, "one ciphertext byte changed");
  add("wrong-recipient", "carol", p1, null, "named-ascii opened with carol's key");
  add("truncated-below-minimum", "bob", p1.subarray(0, 72), null, "72 bytes: shorter than header (57) + tag (16)");
  add("header-only", "bob", p1.subarray(0, 57), null, "the 57-byte header alone");
  add("truncated-by-one", "bob", p1.subarray(0, p1.length - 1), null, "the last byte cut off");
  add("empty", "bob", Buffer.alloc(0), null, "no bytes");
  add("wrong-version-byte", "bob", flip(p1, 0, 3), null, "first byte 0x02 instead of 0x01 (refused before decryption)");
  add("version-2-sealed-consistently", "bob", mk({ version: 2 }).payload, null, "first byte 0x02 and AAD made with 0x02: still refused, only 0x01 is version 1");
  add("ephemeral-low-order", "bob", Buffer.concat([B([1]), Buffer.alloc(32), nonce(k++), Buffer.alloc(40)]), null, "ephemeral public key all zero: the X25519 result is all zero and is refused");
  let r = mk({ edit: (o) => { o.v = 2; } });
  add("plaintext-v-2", "bob", r.payload, null, "decrypts, but the JSON says v: 2");
  r = mk({ plaintext: B([0xff, 0xfe, 0x7b, 0x7d]) });
  add("plaintext-not-utf8", "bob", r.payload, null, "decrypts to bytes that are not UTF-8");
  r = mk({ json: "not json" });
  add("plaintext-not-json", "bob", r.payload, null, "decrypts to text that is not JSON");
  r = mk({ json: "[1]" });
  add("plaintext-json-array", "bob", r.payload, null, "decrypts to a JSON array");
  r = mk({ text: "x".repeat(2001) });
  add("text-too-long", "bob", r.payload, null, "text of 2001 UTF-16 code units");
  r = mk({ text: "😀".repeat(1001) });
  add("text-too-long-surrogates", "bob", r.payload, null, "1001 emoji = 2002 UTF-16 code units (the limit counts code units, not characters)");
  r = mk({ from: "Alice" });
  add("from-uppercase", "bob", r.payload, null, "`from` is not a name (upper case)");
  r = mk({ from: "alice-" });
  add("from-trailing-hyphen", "bob", r.payload, null, "`from` ends with a hyphen");
  r = mk({ from: "a".repeat(33) });
  add("from-too-long", "bob", r.payload, null, "`from` of 33 characters");
  r = mk({ ts: 1.5 });
  add("ts-not-integer", "bob", r.payload, null, "ts 1.5");
  r = mk({ edit: (o) => { o.ts = String(o.ts); } });
  add("ts-string", "bob", r.payload, null, "ts as a JSON string");
  r = mk({ edit: (o) => { o.ts = 2 ** 53; } });
  add("ts-unsafe-integer", "bob", r.payload, null, "ts 2^53 (not a safe integer)");
  r = mk({ fromKeyText: "xyz" });
  add("fromKey-not-hex", "bob", r.payload, null, "fromKey is not 64 hex");
  r = mk({ edit: (o) => { delete o.fromKey; } });
  add("fromKey-missing", "bob", r.payload, null, "no fromKey");
  // opened, but not authentic
  r = mk({ authText: "00".repeat(32) });
  add("auth-mismatch", "bob", r.payload, opened(r, { authentic: false }), "auth is 32 zero bytes: the message opens, marked not authentic");
  r = mk({ edit: (o) => { delete o.auth; } });
  add("auth-missing", "bob", r.payload, opened(r, { authentic: false }), "no auth field: opens, not authentic");
  r = mk({});
  r = mk({ authText: r.auth.toUpperCase() });
  add("auth-uppercase", "bob", r.payload, opened(r, { authentic: false }), "auth in upper-case hex: only lower-case hex is accepted, so not authentic");
  r = mk({ fromKeyBytes: PK("carol") });
  add("auth-claims-another-key", "bob", r.payload, opened(r, { fromKey: keys.carol.public, authentic: false }),
    "alice seals but writes carol's key in fromKey (auth made with alice's secret): not authentic");
  r = mk({ text: "edited after auth", edit: (o) => { o.text = "hello bob"; } });
  add("auth-over-other-text", "bob", r.payload, opened(r, { authentic: false }), "auth made over another text: not authentic");
  // accepted: the code's behaviour today (see docs/audit/open-questions.md)
  r = mk({ fromKeyText: keys.alice.public.toUpperCase() });
  add("fromKey-uppercase-accepted", "bob", r.payload, opened(r), "fromKey in upper-case hex: accepted and returned in lower case (non-canonical text accepted)");
  r = mk({ fromKeyText: "  " + keys.alice.public + " " });
  add("fromKey-whitespace-accepted", "bob", r.payload, opened(r), "fromKey with spaces around it: trimmed and accepted");
  const hb = B(PK("alice")); hb[31] |= 0x80;
  r = mk({ fromKeyBytes: hb });
  add("fromKey-high-bit-accepted", "bob", r.payload, opened(r, { fromKey: hex(hb) }),
    "alice's key with bit 255 set (the same X25519 key: that bit is ignored) and auth made over those bytes: authentic, but its hex differs from alice's key, so its topic and its address id differ too");
  r = mk({ text: "" });
  add("text-empty-accepted", "bob", r.payload, opened(r, { text: "" }), "empty text: sealMessage refuses it, openMessage accepts it");
  r = mk({ ts: -1 });
  add("ts-negative-accepted", "bob", r.payload, opened(r, { ts: -1 }), "ts -1: any safe integer is accepted");
  r = mk({ edit: (o) => { o.extra = "ignored"; } });
  add("extra-field-accepted", "bob", r.payload, opened(r), "an unknown JSON field: ignored (it is inside the AEAD, but outside auth)");
  {
    const same = { ...base, ephSecret: eph(k), nonce: nonce(k++) };
    const j = refSeal(same).plaintext.toString("utf8").replace('"text":"hello bob"', '"text":"hello carol","text":"hello bob"');
    const rr = refSeal({ ...same, json: j });
    add("duplicate-key-last-wins", "bob", rr.payload, opened(rr), "the JSON has `text` twice: the last one counts (JSON.parse)");
  }

  const chat = [];
  const addChat = (id, note, payload, expect) => chat.push({ id, note, recipient: "bob", payload: hex(payload), received: "2026-11-13T00:00:00Z", expect });
  addChat("address-only-sender", "`from` = msg- and the first 16 hex of fromKey: an address, not a name",
    unhex(seal[2].payload), { sender: "k:" + keys.carol.public, convo: "k:" + keys.carol.public, authentic: true, ts: seal[2].ts });
  r = mk({ from: nameless(PK("carol")) });
  addChat("address-only-mismatched", "`from` is address-shaped but names another key's prefix (auth is valid): not authentic",
    r.payload, { sender: "k:" + keys.alice.public, convo: "k:" + keys.alice.public, authentic: false, ts: T0 });
  addChat("named-sender", "a name in `from`", p1, { sender: "alice", convo: "d:alice", authentic: true, ts: T0 });
  const future = Date.parse("2026-11-13T00:00:00Z") + 3600000;
  r = mk({ ts: future });
  addChat("future-ts-clamped", "ts an hour after it was received: shown as received + 300 s", r.payload,
    { sender: "alice", convo: "d:alice", authentic: true, ts: Date.parse("2026-11-13T00:00:00Z") + 300000 });

  const store = [];
  for (const [i, kind] of [["store", "store"], ["copy", "copy"]].map((x, j) => [j, x[1]])) {
    const secret = S("bob");
    const key = hkdf(secret, Buffer.alloc(0), utf8("logos-node/chat/v1/store"));
    const n = tv("store nonce " + i).subarray(0, 24);
    const obj = kind === "store" ? { v: 1, profiles: {}, convos: {}, aliases: {} }
      : { v: 1, convo: "d:alice", from: "bob", to: [{ name: "alice", key: keys.alice.public }], ids: [seal[0].ephemeral_public], text: "hi", ts: T0 };
    const sealed = xchachaSeal(key, n, utf8("logos-node/chat/v1/" + kind), utf8(JSON.stringify(obj)));
    store.push({ owner: "bob", kind, store_key: hex(key), nonce: hex(n), aad: "logos-node/chat/v1/" + kind, object: obj,
                 blob: Buffer.concat([n, sealed]).toString("base64") });
  }

  const sealRefuses = [
    { id: "text-empty", input: { from: "alice", to: "bob", text: "" } },
    { id: "text-too-long", input: { from: "alice", to: "bob", text: "x".repeat(2001) } },
    { id: "from-not-a-name", input: { from: "Alice", to: "bob", text: "hi" } },
    { id: "recipient-key-31-bytes", input: { from: "alice", to: "bob", text: "hi", to_bytes: 31 } },
  ];

  return {
    title: "Names Messages version 1: test vectors",
    WARNING: "TEST ONLY. Every secret, seed, ephemeral key and nonce below is public. Never use them for anything real.",
    spec: "docs/audit/messages-v1-spec.md",
    check: "node tests/messages_v1_vectors.mjs (regenerate with --write)",
    how_made: "secrets, seeds, ephemerals and nonces are SHA-256(\"names-msg-v1 TEST ONLY \" + label) (nonces: the first 24 bytes)",
    encoding: "byte strings are lower-case hex unless named otherwise; store blobs are base64",
    constants: { version: 1, header_length: 57, tag_length: 16, min_payload: 73, max_text_utf16_units: 2000,
                 info_message_key: "names/msg/v1", info_auth_key: "names/msg/v1/auth", info_store_key: "logos-node/chat/v1/store",
                 server_payload_max_bytes: 16384 },
    hchacha20: { source: "draft-irtf-cfrg-xchacha-03 section 2.2.1", key: hex(hk.key), nonce: hex(hk.nonce), subkey: hex(hchacha20(hk.key, hk.nonce)) },
    keys, identities: ident, seal, seal_refuses: sealRefuses, open, chat, store,
  };
}

// ---- run ---------------------------------------------------------------------------------------------
const doc = build();
check("HChaCha20 matches the draft's test vector", doc.hchacha20.subkey === "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc", doc.hchacha20.subkey);
const text = JSON.stringify(doc, null, 1) + "\n";
if (WRITE) {
  writeFileSync(FILE, text);
  console.log("wrote " + FILE);
}
check("tests/vectors/messages-v1.json is what the reference makes", readFileSync(FILE, "utf8") === text);
const V = JSON.parse(readFileSync(FILE, "utf8"));

// the app's modules, as Node ES modules (app/ has no package.json), in a temporary folder removed at the end
const tmp = mkdtempSync(join(tmpdir(), "msgv1-"));
try {
  for (const dir of ["messages", "noble-curves"]) cpSync(join(ROOT, "app", dir), join(tmp, dir), { recursive: true });
  writeFileSync(join(tmp, "package.json"), '{"type":"module"}');
  const MC = await import(pathToFileURL(join(tmp, "messages", "msg-crypto.js")));
  const CC = await import(pathToFileURL(join(tmp, "messages", "chat-core.js")));
  const ID = await import(pathToFileURL(join(tmp, "messages", "identity.js")));

  // fixed randomness for one call: the values must be asked for in exactly this order and these lengths.
  // noble-curves also asks for 16 random bytes to blind its secret-key scalar multiplications (abstract/curve.js,
  // mulCTBlinded); that randomness doesn't change any result, so 16-byte requests get real random bytes.
  const real = globalThis.crypto.getRandomValues;
  function withRandom(values, fn) {
    const queue = values.map((h) => unhex(h)), asked = [];
    globalThis.crypto.getRandomValues = (arr) => {
      if (arr.length === 16) return real.call(globalThis.crypto, arr);
      asked.push(arr.length);
      const next = queue.shift();
      if (!next || next.length !== arr.length) throw new Error("unexpected randomness request of " + arr.length + " bytes");
      arr.set(next);
      return arr;
    };
    try { return { out: fn(), asked }; } finally { globalThis.crypto.getRandomValues = real; }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  for (const [n, k] of Object.entries(V.keys)) {
    check(`key ${n}: public key`, hex(MC.publicKeyOf(unhex(k.secret))) === k.public);
    check(`key ${n}: inbox topic`, MC.inboxTopic(unhex(k.public)) === k.topic);
  }
  for (const d of V.identities) {
    const got = ID.identityFromSeed(new Uint8Array(unhex(d.seed)));
    check(`identity ${d.seed.slice(0, 8)}: X25519 pair and Ed25519 key from the seed`,
      hex(got.secretKey) === d.x25519_secret && hex(got.publicKey) === d.x25519_public && hex(got.edPublicKey) === d.ed25519_public);
  }
  const secretOf = (who) => who === "dave" ? unhex(V.identities[0].x25519_secret) : unhex(V.keys[who].secret);
  for (const s of V.seal) {
    const { out, asked } = withRandom([s.ephemeral_secret, s.nonce], () =>
      MC.sealMessage({ to: new Uint8Array(unhex(V.keys[s.recipient].public)), from: s.from, fromSecret: new Uint8Array(secretOf(s.sender)), text: s.text, ts: s.ts }));
    check(`seal ${s.id}: randomness asked for as 32 bytes (ephemeral) then 24 (nonce)`, same(asked, [32, 24]), asked);
    check(`seal ${s.id}: the app's payload is the vector's, byte for byte`, hex(out) === s.payload, { got: hex(out).slice(0, 160) });
    check(`seal ${s.id}: payload length`, out.length === s.payload_length);
    const got = MC.openMessage(new Uint8Array(unhex(V.keys[s.recipient].secret)), new Uint8Array(unhex(s.payload)));
    check(`open ${s.id}: fields`, same(got, s.open), got);
    check(`open ${s.id}: verified against the sender's key`, MC.isVerified(got, s.open.fromKey));
  }
  for (const r of V.seal_refuses) {
    const to = r.input.to_bytes ? new Uint8Array(r.input.to_bytes) : new Uint8Array(unhex(V.keys[r.input.to].public));
    let threw = false;
    try { MC.sealMessage({ to, from: r.input.from, fromSecret: new Uint8Array(unhex(V.keys.alice.secret)), text: r.input.text, ts: 1 }); } catch (e) { threw = true; }
    check(`seal refuses ${r.id}`, threw);
  }
  for (const o of V.open) {
    const got = MC.openMessage(new Uint8Array(unhex(V.keys[o.recipient].secret)), new Uint8Array(unhex(o.payload)));
    check(`open ${o.id}: ${o.expect === null ? "dropped" : o.expect.authentic ? "accepted" : "opened, not authentic"}`, same(got, o.expect), got);
  }
  for (const c of V.chat) {
    const bob = V.keys[c.recipient];
    const chat = new CC.Chat({ me: { secret: new Uint8Array(unhex(bob.secret)), public: bob.public, name: "" }, api: null, resolve: null });
    const m = chat.openIncoming({ n: 1, payload: Buffer.from(unhex(c.payload)).toString("base64"), received: c.received });
    const got = m && { sender: m.sender, convo: m.convo, authentic: m.authentic, ts: m.ts };
    check(`chat ${c.id}`, same(got, c.expect), got);
  }
  for (const s of V.store) {
    const key = CC.storeKey(new Uint8Array(unhex(V.keys[s.owner].secret)));
    check(`store key (${s.kind})`, hex(key) === s.store_key);
    const { out, asked } = withRandom([s.nonce], () => CC.encryptBlob(key, s.kind, s.object));
    check(`store blob ${s.kind}: the app's blob is the vector's`, out === s.blob && same(asked, [24]), out);
    check(`store blob ${s.kind}: opens`, same(CC.decryptBlob(key, s.kind, s.blob), s.object));
    check(`store blob ${s.kind}: refused under the other kind's AAD`, CC.decryptBlob(key, s.kind === "store" ? "copy" : "store", s.blob) === null);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${passed} checks passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

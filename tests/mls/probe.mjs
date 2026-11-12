// Which WebCrypto operations the MLS bundle needs, and whether this runtime (Node, or the page's origin in a
// browser) has them. ts-mls's default provider and @hpke/core call exactly these for cipher suite 1.
const te = new TextEncoder();

async function attempt(name, fn) {
  try {
    const r = await fn();
    return [name, r === false ? "wrong result" : "ok"];
  } catch (e) {
    return [name, `${e?.name || "Error"}: ${e?.message}`];
  }
}

export async function probeWebCrypto() {
  const g = globalThis;
  const env = {
    runtime: typeof process !== "undefined" && process.versions?.node ? `node ${process.versions.node}` : g.navigator?.userAgent,
    origin: g.location?.origin ?? null,
    isSecureContext: g.isSecureContext ?? null,
    subtle: !!g.crypto?.subtle,
  };
  const s = g.crypto?.subtle;
  const checks = !s
    ? []
    : await Promise.all([
        attempt("SHA-256 digest", async () => (await s.digest("SHA-256", te.encode("abc"))).byteLength === 32),
        attempt("HMAC-SHA256 sign/verify", async () => {
          const k = await s.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
          const m = await s.sign("HMAC", k, te.encode("x"));
          return s.verify("HMAC", k, m, te.encode("x"));
        }),
        attempt("HKDF-SHA256 deriveBits", async () => {
          const k = await s.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits"]);
          const b = await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) }, k, 256);
          return b.byteLength === 32;
        }),
        attempt("AES-128-GCM encrypt/decrypt (with AAD)", async () => {
          const k = await s.importKey("raw", new Uint8Array(16), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
          const p = { name: "AES-GCM", iv: new Uint8Array(12), additionalData: te.encode("aad") };
          const c = await s.encrypt(p, k, te.encode("hello"));
          return new TextDecoder().decode(await s.decrypt(p, k, c)) === "hello";
        }),
        attempt("X25519 generateKey/deriveBits/export raw+jwk", async () => {
          const a = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
          const b = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
          const ab = await s.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256);
          const ba = await s.deriveBits({ name: "X25519", public: a.publicKey }, b.privateKey, 256);
          await s.exportKey("jwk", a.privateKey);
          const raw = new Uint8Array(await s.exportKey("raw", a.publicKey));
          return raw.length === 32 && new Uint8Array(ab).every((x, i) => x === new Uint8Array(ba)[i]);
        }),
        attempt("X25519 importKey pkcs8 + raw", async () => {
          const pk8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20, ...new Uint8Array(32).fill(7)]);
          await s.importKey("pkcs8", pk8, { name: "X25519" }, true, ["deriveBits"]);
          const pub = new Uint8Array(32);
          pub[0] = 9;
          await s.importKey("raw", pub, { name: "X25519" }, true, []);
        }),
        attempt("Ed25519 generateKey/sign/verify + pkcs8/raw import", async () => {
          const kp = await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
          const pk8 = await s.exportKey("pkcs8", kp.privateKey);
          const sk = await s.importKey("pkcs8", pk8, "Ed25519", false, ["sign"]);
          const sig = await s.sign("Ed25519", sk, te.encode("m"));
          const pub = await s.importKey("raw", await s.exportKey("raw", kp.publicKey), "Ed25519", false, ["verify"]);
          return s.verify("Ed25519", pub, sig, te.encode("m"));
        }),
      ]);
  env.webcrypto = Object.fromEntries(checks);
  env.summary = {
    runtime: env.runtime,
    origin: env.origin,
    isSecureContext: env.isSecureContext,
    allWebCryptoOk: !!s && checks.every(([, v]) => v === "ok"),
  };
  return env;
}

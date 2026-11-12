// NOT SHIPPED (groups Stage 1). A ts-mls CryptoProvider for cipher suite 1 that does its hashing, HMAC, HKDF and
// Ed25519 signatures with the @noble code the app already vendors (2.4.0) instead of WebCrypto.
// Paths assume this file sits beside mls.js in app/messages/ (tests/mls/ builds that layout in a temp folder).
//
// Why it exists: ts-mls's defaultCryptoProvider uses WebCrypto for SHA-256, HMAC, HKDF, AES-GCM and, whenever
// crypto.subtle exists, Ed25519 (with no fallback to noble if subtle lacks Ed25519). This provider keeps only
// what has no vendored equivalent on WebCrypto: AES-128-GCM (the MLS AEAD) and the HPKE part of @hpke/core
// (X25519, its HKDF, AES-128-GCM), both through ts-mls's own default building blocks.
import { DependencyError, internals } from "./mls.js";
import { sha256 } from "./noble-hashes/sha2.js";
import { hmac } from "./noble-hashes/hmac.js";
import { extract, expand } from "./noble-hashes/hkdf.js";
import { ed25519 } from "../noble-curves/ed25519.js";

export const SUITE_1 = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

// ts-mls's WebCrypto path stores Ed25519 private keys either raw (32-byte seed) or as PKCS#8 (48 bytes);
// accept both so state made by either provider still signs.
const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
function seedOf(signKey) {
  if (signKey.length === 32) return signKey;
  if (signKey.length === 48 && PKCS8_ED25519.every((b, i) => signKey[i] === b)) return signKey.slice(16);
  throw new Error("not an Ed25519 private key");
}

const { constantTimeEqual } = internals["util/constantTimeCompare.js"];
const { makeHpke } = internals["crypto/implementation/default/makeHpke.js"];

export const appCryptoProvider = {
  async getCiphersuiteImpl(cs) {
    if (cs.name !== SUITE_1) throw new DependencyError(`${cs.name} is not supported here (cipher suite 1 only)`);
    return {
      kdf: {
        async extract(salt, ikm) {
          return extract(sha256, ikm, salt);
        },
        async expand(prk, info, len) {
          return expand(sha256, prk, info, len);
        },
        size: 32,
      },
      hash: {
        async digest(data) {
          return sha256(data);
        },
        async mac(key, data) {
          return hmac(sha256, key, data);
        },
        async verifyMac(key, mac, data) {
          return constantTimeEqual(mac, hmac(sha256, key, data));
        },
      },
      signature: {
        async sign(signKey, message) {
          return ed25519.sign(message, seedOf(signKey));
        },
        async verify(publicKey, message, signature) {
          // RFC 8032 rules (zip215: false) rather than noble's ZIP-215 default. Whether every edge case matches
          // WebCrypto's verifier is not checked.
          return ed25519.verify(signature, message, publicKey, { zip215: false });
        },
        async keygen() {
          const signKey = ed25519.utils.randomSecretKey();
          return { signKey, publicKey: ed25519.getPublicKey(signKey) };
        },
      },
      hpke: await makeHpke(cs.hpke),
      rng: {
        randomBytes(n) {
          return crypto.getRandomValues(new Uint8Array(n));
        },
      },
      name: cs.name,
    };
  },
};

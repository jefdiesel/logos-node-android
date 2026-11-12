// NOT SHIPPED (groups engine). Names Messages, version 2: sealed control messages for groups, sent beside
// version 1 on a name's inbox topic (GROUPS-PLAN 6.5). Paths assume app/messages/.
//
// Same construction as version 1 (msg-crypto.js), with its own version byte and HKDF info strings:
//   payload  = 0x02 ‖ ephemeral X25519 public key (32) ‖ nonce (24) ‖ XChaCha20-Poly1305 ciphertext
//   key      = HKDF-SHA256(ikm = X25519(eph secret, recipient), salt = eph pub ‖ recipient pub, info = "names/msg/v2")
//   AAD      = 0x02 ‖ eph pub
//   plain    = JSON { v: 2, from, fromKey, kind, body, ts, auth }    body = base64 of the kind's bytes
//   auth     = HMAC-SHA256(HKDF(X25519(sender secret, recipient), salt = empty, info = "names/msg/v2/auth"),
//              header ‖ utf8(from) ‖ 0 ‖ fromKey (32) ‖ utf8(ts) ‖ 0 ‖ utf8(kind) ‖ 0 ‖ utf8(body))
// At most 65,536 bytes sealed. A version-1 reader (msg-crypto.js openMessage, the Names web app) returns null
// for it, because payload[0] is not 1.
import { x25519 } from "../noble-curves/ed25519.js";
import { xchacha20poly1305 } from "./noble-ciphers/chacha.js";
import { hkdf } from "./noble-hashes/hkdf.js";
import { hmac } from "./noble-hashes/hmac.js";
import { sha256 } from "./noble-hashes/sha2.js";

export const CONTROL_VERSION = 2;
export const CONTROL_MAX = 65536;
export const KINDS = ["kp-request", "kp", "welcome", "resend-request", "commits", "rejoin-request"];
const INFO = new TextEncoder().encode("names/msg/v2");
const AUTH_INFO = new TextEncoder().encode("names/msg/v2/auth");
const HEADER_LEN = 1 + 32 + 24;
const TAG_LEN = 16;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function authTag(staticShared, header, from, fromKey, ts, kind, body) {
  const key = hkdf(sha256, staticShared, new Uint8Array(0), AUTH_INFO, 32);
  return hmac(sha256, key, concat(header, utf8(from), [0], fromKey, utf8(String(ts)), [0], utf8(kind), [0], utf8(body)));
}

/** Seals `bytes` of `kind` from `from` (device secret `fromSecret`) to the X25519 key `to`. */
export function sealControl({ to, from, fromSecret, kind, bytes, ts = Date.now() }) {
  if (!(to instanceof Uint8Array) || to.length !== 32) throw new Error("recipient key must be 32 bytes");
  if (!NAME.test(from)) throw new Error("from must be a name");
  if (!KINDS.includes(kind)) throw new Error("unknown kind");
  const fromKey = x25519.getPublicKey(fromSecret);
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephSecret);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const header = concat([CONTROL_VERSION], ephPub, nonce);
  const key = hkdf(sha256, x25519.getSharedSecret(ephSecret, to), concat(ephPub, to), INFO, 32);
  const body = b64(bytes);
  const auth = hex(authTag(x25519.getSharedSecret(fromSecret, to), header, from, fromKey, ts, kind, body));
  const plain = utf8(JSON.stringify({ v: CONTROL_VERSION, from, fromKey: hex(fromKey), kind, body, ts, auth }));
  const out = concat(header, xchacha20poly1305(key, nonce, concat([CONTROL_VERSION], ephPub)).encrypt(plain));
  if (out.length > CONTROL_MAX) throw new Error("control message too large");
  return out;
}

/**
 * Opens a version-2 payload with this device's X25519 secret. null when it isn't one, isn't for this key,
 * isn't well formed, or its auth doesn't hold: only authentic messages come back, as
 * { from, fromKey (hex), kind, bytes, ts }. Whether fromKey belongs to the name `from` is the caller's check.
 */
export function openControl(secretKey, payload) {
  try {
    if (!(payload instanceof Uint8Array) || payload.length < HEADER_LEN + TAG_LEN || payload.length > CONTROL_MAX) return null;
    if (payload[0] !== CONTROL_VERSION) return null;
    const header = payload.subarray(0, HEADER_LEN);
    const ephPub = payload.subarray(1, 33);
    const nonce = payload.subarray(33, HEADER_LEN);
    const me = x25519.getPublicKey(secretKey);
    const key = hkdf(sha256, x25519.getSharedSecret(secretKey, ephPub), concat(ephPub, me), INFO, 32);
    const plain = xchacha20poly1305(key, nonce, concat([CONTROL_VERSION], ephPub)).decrypt(payload.subarray(HEADER_LEN));
    const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    const { v, from, fromKey, kind, body, ts, auth } = m ?? {};
    if (v !== CONTROL_VERSION || typeof from !== "string" || !NAME.test(from) || !KINDS.includes(kind)) return null;
    if (typeof body !== "string" || !Number.isSafeInteger(ts) || typeof auth !== "string" || !/^[0-9a-f]{64}$/.test(auth)) return null;
    if (typeof fromKey !== "string" || !/^[0-9a-f]{64}$/.test(fromKey)) return null;
    const senderKey = unhex(fromKey);
    const expected = authTag(x25519.getSharedSecret(secretKey, senderKey), header, from, senderKey, ts, kind, body);
    const got = unhex(auth);
    let diff = 0;
    for (let i = 0; i < 32; i++) diff |= expected[i] ^ got[i];
    if (diff !== 0) return null;
    return { from, fromKey, kind, bytes: unb64(body), ts };
  } catch {
    return null;
  }
}

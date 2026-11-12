// This device's messaging identity (from 0.9.0): a 32-byte Ed25519 seed. The X25519 key pair that messages
// are sealed to comes from it: secret = ed25519.utils.toMontgomerySecret(seed) (the clamped first half of
// SHA-512(seed)), public = ed25519.utils.toMontgomery(Ed25519 public key). The public key is what a name
// publishes as its `msg` entry, so sealing, topics and the Names web app see an ordinary X25519 key; the
// Ed25519 form is there for signing in groups later. Keys made before 0.9.0 are X25519 only (no seed).

import { ed25519, x25519 } from "../noble-curves/ed25519.js";

const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

/** { seed, secretKey, publicKey, edPublicKey } for a seed (Uint8Array(32)). */
export function identityFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("a seed is 32 bytes");
  const edPublicKey = ed25519.getPublicKey(seed);
  const secretKey = ed25519.utils.toMontgomerySecret(seed);
  const publicKey = ed25519.utils.toMontgomery(edPublicKey);
  if (hex(x25519.getPublicKey(secretKey)) !== hex(publicKey)) throw new Error("the derived keys don't match");
  return { seed, secretKey, publicKey, edPublicKey };
}

/** A new identity from a random seed. */
export function newIdentity() {
  return identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
}

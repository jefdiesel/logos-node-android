// The wallet's "send to a name" step, on top of the Logos Names reference resolver (names.js beside
// this file, vendored unchanged). It runs in the page, so the name itself never leaves the device:
// the resolver derives the name's record account and only that account is read from the sequencer.
// This file is part of the Logos node web app, not of the names project.

import { normalizeName, isValidName, resolveName } from "./names.js";

const ADDRESS = /^[0-9a-f]{64}$/;

/** What was typed in the To field: { address } for a 64-character address, { name } for a name, or { error }. */
export function parseTo(input) {
  const typed = String(input ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(typed)) return { address: typed.toLowerCase() };
  const name = normalizeName(typed);
  if (isValidName(name)) return { name };
  return { error: "Enter a 64-character address (0-9 and a-f) or a name." };
}

/**
 * The Logos Blockchain address that `name` publishes in its `blockchain` text entry, as
 * { name, address }, or { error, code } with a message for the person sending.
 */
export async function lookupName(name, rpcUrl, program, now = Date.now()) {
  let found;
  try {
    found = await resolveName(rpcUrl, program, name, now);
  } catch (e) {
    return { code: "unreachable", error: "Couldn't reach the name service. Try again, or paste the address instead." };
  }
  if (found === null) return { code: "unregistered", error: `${name} isn't a registered name.` };
  if (found.lapsed) return { code: "lapsed", error: `${name} has expired, so it can't be paid until its holder renews it.` };
  const address = found.texts ? found.texts.blockchain : undefined;
  if (address === undefined || address === null || address === "") {
    return { code: "no_address", error: `${name} is registered but has no Logos Blockchain address set.` };
  }
  if (!ADDRESS.test(address)) {
    return { code: "bad_address", error: `${name} lists a Logos Blockchain address that isn't valid (it must be 64 characters, 0-9 and a-f), so it can't be paid.` };
  }
  return { name, address };
}

/** Resolves `name` again just before sending: null if it still gives `approved`, else { error, code }. */
export async function recheckName(name, approved, rpcUrl, program, now = Date.now()) {
  const again = await lookupName(name, rpcUrl, program, now);
  if (again.error) return { code: again.code, error: again.error + " Nothing was sent." };
  if (again.address !== approved) {
    return { code: "changed", error: `The address for ${name} changed after you reviewed it. Nothing was sent. Review the payment again.` };
  }
  return null;
}

// The vendored Logos Names resolver (app/names) and the wallet's name lookup (app/names/lookup.js).
//
//   node tests/names_test.mjs
//       the SPEC section 10 test vectors, run against the vendored copy
//   APP_BASE=http://127.0.0.1:8090 APP_PIN=... NAMES_FROM=<funded key> NAMES_TO=<a key> node tests/names_test.mjs
//       also end to end: lookups go through the app's /api/names/rpc to a fake sequencer started here
//       on NAMES_FAKE_PORT (default 18545), which the app must have as NAMES_RPC_URL, with
//       NAMES_PROGRAM=US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx (32 bytes of 0x07, the SPEC's test program)
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The app serves these files as ES modules; Node needs to be told, so test a copy marked as such.
const here = dirname(fileURLToPath(import.meta.url));
const copy = mkdtempSync(join(tmpdir(), "names-"));
cpSync(join(here, "..", "app", "names"), copy, { recursive: true });
writeFileSync(join(copy, "package.json"), '{"type":"module"}');
const N = await import(pathToFileURL(join(copy, "names.js")));
const L = await import(pathToFileURL(join(copy, "lookup.js")));
const { argon2id } = await import(pathToFileURL(join(copy, "noble-hashes", "argon2.js")));

const hex = (b) => Buffer.from(b).toString("hex");
function check(name, cond, detail = "") {
  console.log((cond ? "ok   " : "FAIL ") + name + (!cond && detail ? " - " + JSON.stringify(detail) : ""));
  if (!cond) process.exit(1);
}

// ---- SPEC section 10 -------------------------------------------------------------------------
const rfc = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2),
  { t: 3, m: 32, p: 4, dkLen: 32, version: 0x13, key: new Uint8Array(8).fill(3), personalization: new Uint8Array(12).fill(4) });
check("Argon2id matches RFC 9106 5.3", hex(rfc) === "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
const vectors = {
  "jef": ["7041d9e447f06bdfe327d870402b1524cfe38bd03445b8fc3d0e87bc978eb763", "aad91a1a3dd0fb56a213212fbea58fe25d9139db42fc59ce2116c3cfa3440088"],
  "logos": ["4a8bf61b00dbc63907a935aa15ed534bb32d866978aa1f2128f9b6f37e0c4025", "d67dd628fa51fa62bd32ea82c3e9ff1b67f93b01103be956eaebc52f1699df44"],
  "a": ["24b73f0b70605c7f27fb91f9952b550e13c4cc38dcf325be45442d1a2cb085b4", "cd9ded7c94d52743db4ee67152766480be5bb5199e83b6696e502cf818933150"],
  "abcdefghijklmnopqrstuvwxyz012345": ["0044f00be946536689d83e364ac25462c65c615d74059652d1f3e2977bd75403", "79c7aa8c06d4983a59b235915ae4f5767918824a9150d5d8b576761b7d3654f6"],
  "a-b-c": ["707decf4fde6d9fb61d255c23b34e042c846a0f4b0834151dcb2c1ef4160e849", "e3666a8572f7cabe94f6717491bff34c70eeca216436a142185bd8a86b6ccf31"],
};
const t0 = Date.now();
let jef;
for (const [name, [id, key]] of Object.entries(vectors)) {
  const d = await N.deriveName(name);
  if (name === "jef") jef = d;
  check(`identifier and key of "${name}" (SPEC 10)`, hex(d.id) === id && hex(d.key) === key, { id: hex(d.id), key: hex(d.key) });
}
console.log(`     5 derivations took ${Date.now() - t0} ms in Node`);
const PROGRAM = N.base58Encode(new Uint8Array(32).fill(7));
check("the SPEC's test program in base58", PROGRAM === "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
check("record and page accounts of jef (SPEC 10)",
  (await N.recordAddress(PROGRAM, jef.id)) === "5b5xVGob2GYvrq21MSuxm1MfieucDEy9yxhDwdXndbpD" &&
  (await N.pageAddress(PROGRAM, jef.id)) === "HEES9BpNxrAtwxFkyEQTEnjUcSr7usgbefeqiYJsG9mY");
const counting = Uint8Array.from({ length: 32 }, (_, i) => i);
check("record and page accounts of the identifier 00..1f (SPEC 10)",
  (await N.recordAddress(PROGRAM, counting)) === "7bwwvMLtxqqNYiXsd5bYaq8e31E1odYf6jAK5z7tmUdd" &&
  (await N.pageAddress(PROGRAM, counting)) === "8M4vmdxCXL4eS8QXiHSdbeUUPt5Vbx1UVjLcv2cPk9Y5");
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => i);
const profile = { name: "jef", account: N.base58Encode(new Uint8Array(32).fill(2)), npk: null, vpk: null, texts: { chat: "hi" } };
const sealed = await N.seal(jef.key, N.encodeProfile(profile), "record", NONCE);
check("the sealed profile of jef (SPEC 10)", hex(sealed) ===
  "000102030405060708090a0b7a39f7ff67b20894263a28d040c0f2711c04ba247fcf5cb107e27b59" +
  "05b8a0664b28cd25512addcb74af3efa5a8d6eb3bbb8e89fb8dba0aa2739252efed2be01ab019998" +
  "a07d416c788d8c9b699891e85bedd1118da7089377220bdb0ab8ae29661bf20e006c5fbffb222237" +
  "2ea0a2589ed49023186a77e9afee1af338f4a2377afa40da018789ca715318d981b556f71f9640eb" +
  "d056d8dcbe2b71845b45a578721ccc2c889df37b926c7da5a5202dbf3d50dc04883673134ce0772f" +
  "bcd7fbc8f31f455bb39b3d867d5e6772c86e59f42a9d04ffaacaa6119b1156d238665c0cf50028a9" +
  "cbf8b3189fc45a15a724c5775a835a8ccdff6a573d8e046d78e847b7da5668bc8529aedb3bdc70a9" +
  "9db9b9b4");
const page = await N.seal(jef.key, N.encodePageContent({ contentType: "text/plain", body: new TextEncoder().encode("hi") }), "page", NONCE);
check("the sealed page of jef (SPEC 10)", hex(page) === "000102030405060708090a0b7339f7ff79b216e10b4846b32bacf2731e06d04f8cf43af535da58e992f033cb16a471d0");

// ---- what the To field accepts (SPEC 2) --------------------------------------------------------
const A = "ab".repeat(32);
check("a 64-character address is taken as an address", L.parseTo(" " + A.toUpperCase() + " ").address === A);
for (const typed of ["alice", "@alice", "Alice", "alice.lez", "lns:alice"]) check(`"${typed}" is the name alice`, L.parseTo(typed).name === "alice");
for (const typed of ["al ice", "-alice", "alice.eth", "", "x".repeat(33)]) check(`"${typed}" is refused`, !!L.parseTo(typed).error);

// ---- end to end through the app ---------------------------------------------------------------
const BASE = process.env.APP_BASE;
if (!BASE) { console.log("     (APP_BASE not set: end-to-end checks skipped)"); console.log("all checks passed"); process.exit(0); }
const ORIGIN = BASE;
const unlock = await (await fetch(BASE + "/api/wallet/unlock", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ pin: process.env.APP_PIN }) })).json();
check("unlocked the wallet for the name checks", typeof unlock.session === "string", unlock);
const session = unlock.session;
const RPC = BASE + "/api/names/rpc";
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opt = {}) => String(url) === RPC  // what the page does: the forwarder needs the wallet session
  ? realFetch(url, { ...opt, headers: { ...(opt.headers || {}), "X-Session": session, Origin: ORIGIN } }) : realFetch(url, opt);

const shards = new Map();                    // account id -> record bytes, what the fake sequencer holds
async function register(name, texts, expires = Date.UTC(2100, 0, 1)) {
  const d = await N.deriveName(name);
  const body = await N.seal(d.key, N.encodeProfile({ name, texts }), "record");
  const rec = new Uint8Array(1 + 32 + 8 + 4 + body.length);
  const v = new DataView(rec.buffer);
  rec[0] = 3; rec.fill(9, 1, 33); v.setBigUint64(33, BigInt(expires), true); v.setUint32(41, body.length, true); rec.set(body, 45);
  shards.set(await N.recordAddress(PROGRAM, d.id), Array.from(rec));
}
const asked = [];
const fake = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const { id, method, params } = JSON.parse(raw); asked.push({ method, params });
    const data = shards.has(params[0]) ? { shards: { [PROGRAM]: shards.get(params[0]) } } : { shards: {} };
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { data } }));
  });
});
await new Promise((ok) => fake.listen(Number(process.env.NAMES_FAKE_PORT || 18545), "127.0.0.1", ok));

const TO = process.env.NAMES_TO, FROM = process.env.NAMES_FROM;
await register("pay-me", { blockchain: TO, chat: "hi" });
await register("no-address", { chat: "hi" });
await register("bad-address", { blockchain: "not-an-address" });
await register("lapsed", { blockchain: TO }, Date.now() - 86_400_000);

let r = await realFetch(RPC, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccount", params: [PROGRAM] }) });
check("the name forwarder needs an unlocked wallet", r.status === 401, r.status);
r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [PROGRAM] }) });
check("the name forwarder passes nothing but getAccount", r.status === 400, r.status);
r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccount", params: ["../../etc"] }) });
check("the name forwarder passes only an account id", r.status === 400, r.status);

r = await L.lookupName("pay-me", RPC, PROGRAM);
check("a name resolves to its blockchain address", r.address === TO && r.name === "pay-me", r);
check("only the derived account went to the sequencer, never the name",
  asked.length > 0 && asked.every((a) => a.method === "getAccount" && !JSON.stringify(a).includes("pay-me")), asked);
r = await L.lookupName("nobody-here", RPC, PROGRAM);
check("an unregistered name is refused, and says so", r.code === "unregistered", r);
r = await L.lookupName("no-address", RPC, PROGRAM);
check("a name without a blockchain address is refused, and says so", r.code === "no_address", r);
r = await L.lookupName("bad-address", RPC, PROGRAM);
check("a malformed address from the name service is refused", r.code === "bad_address", r);
r = await L.lookupName("lapsed", RPC, PROGRAM);
check("a lapsed name is refused, and says so", r.code === "lapsed", r);

check("the reviewed address still holds just before sending", (await L.recheckName("pay-me", TO, RPC, PROGRAM)) === null);
await register("pay-me", { blockchain: "cd".repeat(32) });
r = await L.recheckName("pay-me", TO, RPC, PROGRAM);
check("an address that changed after review is refused", r && r.code === "changed", r);
await register("pay-me", { blockchain: TO });

const sent = await (await fetch(BASE + "/api/wallet/send", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Session": session },
  body: JSON.stringify({ from: FROM, to: (await L.lookupName("pay-me", RPC, PROGRAM)).address, amount: 7, name: "pay-me" }) })).json();
check("the node accepts a transfer to the resolved address", typeof sent.hash === "string", sent);
const hist = await (await fetch(BASE + "/api/wallet/history?limit=20", { headers: { "X-Session": session } })).json();
const entry = (hist.entries || []).find((e) => e.hash === sent.hash);
check("the history keeps the name with the address", entry && entry.name === "pay-me" && entry.to === TO, entry);

await new Promise((ok) => fake.close(ok));
r = await L.lookupName("pay-me", RPC, PROGRAM);
check("a name service that doesn't answer is reported as such", r.code === "unreachable", r);
console.log("all checks passed");
process.exit(0);

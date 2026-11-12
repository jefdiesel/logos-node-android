#!/usr/bin/env node
// A command-line peer for messages between LNS names, talking to a Logos Messaging node's REST API on this
// computer. It uses the same code as the phone's page: the names project's msg-crypto.js and names.js
// resolver, from this repository's app/ folder. Node 20 or newer; nothing to install.
//
//   node tools/msg-peer.mjs keygen                                 makes a key file (0600), prints the public key
//   node tools/msg-peer.mjs send --to android --from-name mini "hello"
//   node tools/msg-peer.mjs send --to msg:<messaging address> "hello"    to an address; without --from-name
//                                                                  the message is from this key's address
//   node tools/msg-peer.mjs listen                                 prints messages to this key as they arrive
//
// Options (all commands):
//   --key FILE       the key file (default ./msg-peer-key.json)
//   --api URL        the node's REST API on this computer (default http://127.0.0.1:8645)
//   --rpc URL        the LEZ sequencer the names are read from (default https://testnet.lez.logos.co)
//   --program ID     the names registry program (default the testnet registry 38jEfVV1...)
//
// The node needs its REST API on (--rest=true) and the Messaging API (--entry-layer=messaging or channels)
// on the same network as the other side. Turning messages on for a name: put the key's public key in the
// name's msg entry, from the computer that holds the name:   names set-text <name> msg <public key>
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const copy = mkdtempSync(join(tmpdir(), "msg-peer-"));            // the app's ES modules, as Node modules
for (const d of ["messages", "noble-curves", "names"]) cpSync(join(APP, d), join(copy, d), { recursive: true });
writeFileSync(join(copy, "package.json"), '{"type":"module"}');
const MC = await import(pathToFileURL(join(copy, "messages", "msg-crypto.js")));
const N = await import(pathToFileURL(join(copy, "names", "names.js")));
const ID = await import(pathToFileURL(join(copy, "messages", "identity.js")));
const CORE = await import(pathToFileURL(join(copy, "messages", "chat-core.js")));

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v; };
const KEY = opt("--key", "msg-peer-key.json");
const API = opt("--api", "http://127.0.0.1:8645").replace(/\/+$/, "");
const RPC = opt("--rpc", "https://testnet.lez.logos.co");
const PROGRAM = opt("--program", "38jEfVV1RCyMzu1FGbYcCn5FqxCxKyY58VgzjruAh2gq");
const TO = opt("--to", null), FROM = opt("--from-name", null);
const [cmd, ...rest] = args;
const die = (msg) => { console.error("error: " + msg); process.exit(1); };
const u = new URL(API);
if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) die("--api must be http:// on this computer");

function loadKey() {
  if (!existsSync(KEY)) die(`no key file ${KEY}: run keygen first`);
  const k = JSON.parse(readFileSync(KEY, "utf8"));
  const secret = MC.fromHex(k.secret);
  if (MC.toHex(MC.publicKeyOf(secret)) !== k.public) die(`${KEY} is damaged`);
  if (k.seed && MC.toHex(ID.identityFromSeed(MC.fromHex(k.seed)).secretKey) !== k.secret) die(`${KEY} is damaged`);
  return { secret, public: k.public };
}
async function node(method, path, body) {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
}
async function msgKeyOf(name) {
  let found;
  try { found = await N.resolveName(RPC, PROGRAM, name); }
  catch (e) { throw new Error(`couldn't reach the name service at ${RPC}: ${e.cause?.code || e.message}`); }
  if (found === null) return { registered: false, key: null };
  const k = found.texts ? MC.parseMsgKey(found.texts.msg) : null;
  return { registered: true, lapsed: found.lapsed, key: k ? MC.toHex(k) : null };
}
const keyCache = new Map();
async function verified(msg) {
  try {
    if (!keyCache.has(msg.from)) keyCache.set(msg.from, (await msgKeyOf(msg.from)).key);
    if (MC.isVerified(msg, keyCache.get(msg.from))) return true;
    keyCache.set(msg.from, (await msgKeyOf(msg.from)).key);                    // it may have changed
    return MC.isVerified(msg, keyCache.get(msg.from));
  } catch { return false; }
}

if (cmd === "keygen") {
  if (existsSync(KEY)) die(`${KEY} exists already; use --key for another file`);
  const kp = ID.newIdentity();                 // an Ed25519 seed, and the X25519 pair derived from it
  const fd = openSync(KEY, "wx", 0o600);
  writeSync(fd, JSON.stringify({ version: 2, seed: MC.toHex(kp.seed), secret: MC.toHex(kp.secretKey), public: MC.toHex(kp.publicKey) }));
  closeSync(fd);
  console.log(MC.toHex(kp.publicKey));
  console.error(`wrote ${KEY} (keep it private). Inbox topic: ${MC.inboxTopic(kp.publicKey)}`);
  console.error(`turn messages on for your name with:  names set-text <name> msg ${MC.toHex(kp.publicKey)}`);
} else if (cmd === "send") {
  const text = rest.join(" ");
  if (!TO || !text) die('usage: send --to <name or msg:address> [--from-name <your name>] "text"');
  const me = loadKey();
  const from = FROM ? N.normalizeName(FROM) : CORE.nameless(me.public);         // no name: from this key's address
  if (!N.isValidName(from)) die("--from-name must be an LNS name, like alice");
  const addr = CORE.parseAddress(TO);
  if (addr && addr.wallet) die("that's a wallet address; ask for their messaging address or LNS name");
  if (addr && addr.bad) die("that isn't a valid messaging address");
  let k, to;
  if (addr) { k = { key: addr.address }; to = CORE.shortFp(addr.address); }
  else {
    to = N.normalizeName(TO);
    if (!N.isValidName(to)) die("--to must be an LNS name, like alice, or a messaging address (msg:<64 hex>)");
    k = await msgKeyOf(to).catch((e) => die(e.message));
    if (!k.registered) die(`${to} isn't a registered name`);
    if (!k.key) die(`${to} has no messaging address (no msg entry), so it can't get messages yet`);
  }
  const sealed = MC.sealMessage({ to: MC.fromHex(k.key), from, fromSecret: me.secret, text });
  const topic = MC.inboxTopic(MC.fromHex(k.key));
  // the send subscribes this node to the recipient's topic: let go of it afterwards unless it was there before
  const before = await node("GET", "/messaging/v1/subscriptions").catch(() => ({ data: null }));
  const had = Array.isArray(before.data) && before.data.includes(topic);
  const finish = async (code) => {
    if (!had) await node("DELETE", "/messaging/v1/subscriptions", [topic]).catch(() => {});
    process.exit(code);
  };
  const r = await node("POST", "/messaging/v1/messages", { payload: Buffer.from(sealed).toString("base64"), contentTopic: topic, ephemeral: false });
  if (r.status !== 200 || !r.data || !r.data.requestId) die(`the node didn't take it: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  console.log(`sent to ${to} (${topic}), request ${r.data.requestId}`);
  for (let i = 0; i < 90; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const s = await node("GET", "/messaging/v1/events/send/" + encodeURIComponent(r.data.requestId));
    if (s.status !== 200 || !s.data) continue;
    for (const e of s.data.events || []) console.log(`  ${e.kind}${e.error ? ": " + e.error : ""}`);
    const kinds = (s.data.events || []).map((e) => e.kind);
    if (kinds.includes("sent") || kinds.includes("error")) await finish(kinds.includes("sent") ? 0 : 2);
  }
  console.log("  no final event within 90 s (a node without reliability stops at propagated)");
  await finish(0);
} else if (cmd === "listen") {
  const me = loadKey();
  const topic = MC.inboxTopic(MC.fromHex(me.public));
  const seen = new Set();
  let lastSeq = 0, starting = false;
  console.error(`listening on ${topic} for ${me.public}`);
  for (;;) {
    try {
      // the node forgets subscriptions when it restarts, and answers 404 while it starts: look every round
      const subs = await node("GET", "/messaging/v1/subscriptions");
      if (subs.status === 404) {
        if (!starting) console.error("the node is starting");
        starting = true;
        await new Promise((ok) => setTimeout(ok, 500));
        continue;
      }
      starting = false;
      if (!Array.isArray(subs.data) || !subs.data.includes(topic)) {
        const s = await node("POST", "/messaging/v1/subscriptions", [topic]);
        if (s.status !== 200) console.error(`subscribe: HTTP ${s.status} ${s.text.slice(0, 200)}`);
      }
      const r = await node("GET", "/messaging/v1/events/received");
      for (const rec of Array.isArray(r.data) ? r.data : []) {
        if (typeof rec.seq === "number") {
          if (lastSeq && rec.seq > lastSeq + 1) console.error(`(${rec.seq - lastSeq - 1} messages dropped or taken by another client)`);
          lastSeq = rec.seq;
        }
        if (!rec.message || rec.message.contentTopic !== topic || seen.has(rec.messageHash)) continue;
        seen.add(rec.messageHash);
        const msg = MC.openMessage(me.secret, new Uint8Array(Buffer.from(rec.message.payload, "base64")));
        if (!msg) { console.log(`[${new Date().toISOString()}] a message this key can't open`); continue; }
        const nameless = msg.from === CORE.nameless(msg.fromKey);
        const ok = nameless ? msg.authentic : await verified(msg);
        const who = nameless ? (ok ? "address msg:" + msg.fromKey + " (no name)" : "unverified address") : ok ? "✓ " + msg.from : "unverified: claims to be " + msg.from;
        console.log(`[${new Date(msg.ts).toISOString()}] ${who}${rec.source === "history" ? " (from history)" : ""}: ${msg.text}`);
      }
    } catch (e) {
      console.error("node not answering: " + (e.cause?.code || e.message));
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
} else {
  console.error("usage: node tools/msg-peer.mjs keygen | send --to <name or msg:address> [--from-name <name>] \"text\" | listen   [--key FILE] [--api URL] [--rpc URL] [--program ID]");
  process.exit(1);
}

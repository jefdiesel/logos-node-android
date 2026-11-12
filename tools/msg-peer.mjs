#!/usr/bin/env node
// A command-line peer for messages between LNS names, talking to a Logos Messaging node's REST API on this
// computer. It uses the same code as the phone's page: the names project's msg-crypto.js and names.js
// resolver, from this repository's app/ folder. Node 20 or newer; nothing to install.
//
//   node tools/msg-peer.mjs keygen                                 makes a key file (0600), prints the public key
//   node tools/msg-peer.mjs send --to android --from-name mini "hello"
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
  const kp = MC.newKeyPair();
  const fd = openSync(KEY, "wx", 0o600);
  writeSync(fd, JSON.stringify({ secret: MC.toHex(kp.secretKey), public: MC.toHex(kp.publicKey) }));
  closeSync(fd);
  console.log(MC.toHex(kp.publicKey));
  console.error(`wrote ${KEY} (keep it private). Inbox topic: ${MC.inboxTopic(kp.publicKey)}`);
  console.error(`turn messages on for your name with:  names set-text <name> msg ${MC.toHex(kp.publicKey)}`);
} else if (cmd === "send") {
  const text = rest.join(" ");
  if (!TO || !FROM || !text) die('usage: send --to <name> --from-name <your name> "text"');
  const to = N.normalizeName(TO), from = N.normalizeName(FROM);
  if (!N.isValidName(to) || !N.isValidName(from)) die("--to and --from-name must be LNS names, like alice");
  const me = loadKey();
  const k = await msgKeyOf(to).catch((e) => die(e.message));
  if (!k.registered) die(`${to} isn't a registered name`);
  if (!k.key) die(`${to} has no messaging key (no msg entry), so it can't get messages yet`);
  const sealed = MC.sealMessage({ to: MC.fromHex(k.key), from, fromSecret: me.secret, text });
  const topic = MC.inboxTopic(MC.fromHex(k.key));
  const r = await node("POST", "/messaging/v1/messages", { payload: Buffer.from(sealed).toString("base64"), contentTopic: topic, ephemeral: false });
  if (r.status !== 200 || !r.data || !r.data.requestId) die(`the node didn't take it: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  console.log(`sent to ${to} (${topic}), request ${r.data.requestId}`);
  for (let i = 0; i < 90; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const s = await node("GET", "/messaging/v1/events/send/" + encodeURIComponent(r.data.requestId));
    if (s.status !== 200 || !s.data) continue;
    for (const e of s.data.events || []) console.log(`  ${e.kind}${e.error ? ": " + e.error : ""}`);
    const kinds = (s.data.events || []).map((e) => e.kind);
    if (kinds.includes("sent") || kinds.includes("error")) process.exit(kinds.includes("sent") ? 0 : 2);
  }
  console.log("  no final event within 90 s (a node without reliability stops at propagated)");
} else if (cmd === "listen") {
  const me = loadKey();
  const topic = MC.inboxTopic(MC.fromHex(me.public));
  const seen = new Set();
  let subscribed = false, lastSeq = 0;
  console.error(`listening on ${topic} for ${me.public}`);
  for (;;) {
    try {
      if (!subscribed) {
        const r = await node("POST", "/messaging/v1/subscriptions", [topic]);
        subscribed = r.status === 200;
        if (!subscribed) console.error(`subscribe: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      }
      const r = await node("GET", "/messaging/v1/events/received");
      for (const rec of Array.isArray(r.data) ? r.data : []) {
        if (typeof rec.seq === "number") {
          if (rec.seq < lastSeq) subscribed = false;                              // the node restarted
          else if (lastSeq && rec.seq > lastSeq + 1) console.error(`(${rec.seq - lastSeq - 1} messages dropped or taken by another client)`);
          lastSeq = rec.seq;
        }
        if (!rec.message || rec.message.contentTopic !== topic || seen.has(rec.messageHash)) continue;
        seen.add(rec.messageHash);
        const msg = MC.openMessage(me.secret, new Uint8Array(Buffer.from(rec.message.payload, "base64")));
        if (!msg) { console.log(`[${new Date().toISOString()}] a message this key can't open`); continue; }
        const ok = await verified(msg);
        console.log(`[${new Date(msg.ts).toISOString()}] ${ok ? "✓ " + msg.from : "unverified: claims to be " + msg.from}${rec.source === "history" ? " (from history)" : ""}: ${msg.text}`);
      }
    } catch (e) {
      subscribed = false;
      console.error("node not answering: " + (e.cause?.code || e.message));
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
} else {
  console.error("usage: node tools/msg-peer.mjs keygen | send --to <name> --from-name <name> \"text\" | listen   [--key FILE] [--api URL] [--rpc URL] [--program ID]");
  process.exit(1);
}

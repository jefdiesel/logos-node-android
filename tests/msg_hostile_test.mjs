// Hostile sender names: a message whose `from` is "constructor" (a valid LNS name) used to make every sync of
// the page's chat model throw, so nothing new was ever shown. The page's model (app/messages/chat-core.js) runs
// here against an in-memory stand-in for the app's /api/messages routes.
//
//   node tests/msg_hostile_test.mjs
//
// Every name an object's prototype has, and 200 random or hostile `from` strings and sender keys: sync() never
// throws, a contact's message after them still shows, the store saves and loads again, and nothing is added to
// Object.prototype.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, MC, CORE, hex, ROOT } from "./chat_world.mjs";

const { xchacha20poly1305 } = await import(pathToFileURL(join(ROOT, "app", "messages", "noble-ciphers", "chacha.js")));
const { hkdf } = await import(pathToFileURL(join(ROOT, "app", "messages", "noble-hashes", "hkdf.js")));
const { sha256 } = await import(pathToFileURL(join(ROOT, "app", "messages", "noble-hashes", "sha2.js")));
const { x25519 } = await import(pathToFileURL(join(ROOT, "app", "noble-curves", "ed25519.js")));
const enc = new TextEncoder();
const b64 = (u) => Buffer.from(u).toString("base64");
/** A version 1 payload around any JSON value (any `from`, any key, a wrong `auth`). */
function sealRaw(to, obj) {
  const eph = x25519.utils.randomSecretKey(), ephPub = x25519.getPublicKey(eph), nonce = crypto.getRandomValues(new Uint8Array(24));
  const key = hkdf(sha256, x25519.getSharedSecret(eph, to), new Uint8Array([...ephPub, ...to]), enc.encode("names/msg/v1"), 32);
  const ct = xchacha20poly1305(key, nonce, new Uint8Array([1, ...ephPub])).encrypt(enc.encode(JSON.stringify(obj)));
  return new Uint8Array([1, ...ephPub, ...nonce, ...ct]);
}

// the app's routes, in memory
const srv = { inbox: [], next: 1, store: { rev: 0, blob: null } };
const api = async (path, body) => {
  if (path.startsWith("/api/messages/outbox?")) return { ok: true, status: 200, data: { items: [], changed: [], rev: 0 } };
  if (path.startsWith("/api/messages/inbox?")) {
    const after = Number(path.split("after=")[1]) || 0;
    return { ok: true, status: 200, data: { items: srv.inbox.filter((i) => i.n > after), next: srv.next, sort_from: 1, unread: srv.inbox.filter((i) => !i.read).map((i) => i.n) } };
  }
  if (path === "/api/messages/store" && body === undefined) return { ok: true, status: 200, data: JSON.parse(JSON.stringify(srv.store)) };
  if (path === "/api/messages/store") {
    if (body.rev !== srv.store.rev) return { ok: false, status: 409, data: { rev: srv.store.rev } };
    srv.store = { rev: srv.store.rev + 1, blob: body.blob }; return { ok: true, status: 200, data: { rev: srv.store.rev } };
  }
  if (path === "/api/messages/inbox/read") { for (const i of srv.inbox) if (body.ids.includes(i.n)) i.read = true; return { ok: true, status: 200, data: {} }; }
  return { ok: true, status: 200, data: {} };
};
const deliver = (payload) => srv.inbox.push({ n: srv.next++, payload: b64(payload), received: new Date().toISOString(), read: false });

const me = MC.newKeyPair(), bob = MC.newKeyPair(), ctor = MC.newKeyPair();
const chain = new Map([["bob", { texts: { msg: hex(bob.publicKey) } }], ["constructor", { texts: { msg: hex(ctor.publicKey) } }]]);
const resolve = async (name) => chain.get(name) || null;
const newChat = () => new CORE.Chat({ me: { secret: me.secretKey, public: hex(me.publicKey), name: "" }, api, resolve });
const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join();

const chat = newChat();
await chat.loadStore(); await chat.sync();
await chat.startDirect("bob");

const PROTO = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "keys", "isPrototypeOf", "propertyIsEnumerable",
  "toLocaleString", "__defineGetter__", "__lookupSetter__", "prototype", "length", "name", "then"];
for (const from of PROTO) {
  // signed by its own key (as any stranger can), and with a wrong proof
  const k = from === "constructor" ? ctor : MC.newKeyPair();       // "constructor" is a registered name here
  if (/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(from)) deliver(MC.sealMessage({ to: me.publicKey, from, fromSecret: k.secretKey, text: "hi from " + from }));
  deliver(sealRaw(me.publicKey, { v: 1, from, fromKey: hex(k.publicKey), text: "x", ts: Date.now(), auth: "0".repeat(64) }));
}
let threw = null;
try { await chat.sync(); await chat.sync(); } catch (e) { threw = e; }
check("messages from \"constructor\", \"__proto__\", \"toString\", \"hasOwnProperty\", \"valueOf\", \"keys\" and other prototype names: sync() doesn't throw", threw === null, threw && threw.message);
check("\"constructor\" (a valid LNS name) gets its own chat like any first message, and its profile is its own", !!chat.convo("d:constructor") && chat.profile("constructor") && Array.isArray(chat.profile("constructor").keys));
check("a name that is no profile reads as none", chat.profile("toString") === null && chat.profile("__proto__") === null && chat.profile("hasOwnProperty") === null);
deliver(MC.sealMessage({ to: me.publicKey, from: "bob", fromSecret: bob.secretKey, text: "still here" }));
await chat.sync();
check("a contact's next message still shows", chat.messages("d:bob").some((m) => m.text === "still here"));

// 200 random or hostile `from` strings and keys
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const junk = () => {
  const r = Math.random();
  if (r < 0.2) return pick(PROTO) + (Math.random() < 0.5 ? "" : "-" + Math.floor(Math.random() * 9));
  if (r < 0.4) return Array.from({ length: 1 + Math.floor(Math.random() * 40) }, () => pick("abcxyz019-_.:$/\\\"'<>{}[]\u0000‮ ")).join("");
  if (r < 0.6) return "msg-" + hex(crypto.getRandomValues(new Uint8Array(8)));
  if (r < 0.7) return pick([null, 1, true, {}, [], { constructor: 1 }, ["__proto__"]]);
  return Array.from({ length: 1 + Math.floor(Math.random() * 32) }, () => pick("abcdefghijklmnopqrstuvwxyz0123456789-")).join("");
};
const junkKey = () => pick([hex(MC.newKeyPair().publicKey), "00".repeat(32), "ff".repeat(32), "zz", "", null, 7, hex(bob.publicKey), hex(me.publicKey)]);
for (let i = 0; i < 200; i++) {
  const from = junk(), k = MC.newKeyPair();
  if (typeof from === "string" && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(from) && Math.random() < 0.5) deliver(MC.sealMessage({ to: me.publicKey, from, fromSecret: k.secretKey, text: "fuzz " + i }));
  else deliver(sealRaw(me.publicKey, { v: 1, from, fromKey: junkKey(), text: "fuzz " + i, ts: Math.random() < 0.5 ? Date.now() : "x", auth: Math.random() < 0.5 ? "0".repeat(64) : null }));
  if (i % 40 === 39) { try { await chat.sync(); } catch (e) { threw = e; break; } }
}
try { await chat.sync(); chat.conversations(); chat.unreadTotal(); } catch (e) { threw = e; }
check("200 random and hostile `from` strings and sender keys: sync(), the list and the unread count never throw", threw === null, threw && threw.stack);
deliver(MC.sealMessage({ to: me.publicKey, from: "bob", fromSecret: bob.secretKey, text: "after the fuzz" }));
await chat.sync();
check("and a contact's message after them still shows", chat.messages("d:bob").some((m) => m.text === "after the fuzz"));
const again = newChat();
await again.loadStore(); await again.sync();
check("the store saves and loads again, with the chats", !!again.convo("d:bob") && !!again.convo("d:constructor") && again.messages("d:bob").length === 2);
check("nothing was added to Object.prototype", Object.getOwnPropertyNames(Object.prototype).sort().join() === protoBefore && ({}).keys === undefined);
console.log("all checks passed");
process.exit(0);

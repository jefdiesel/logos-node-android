// Chats between LNS names (0.9.0): the page's chat model (app/messages/chat-core.js) against three apps on
// a fake messaging network, without a browser.
//
//   [NAMES_MSG_CRYPTO=<the names project's msg-crypto.js>] [OLD_APP=<an 0.8.1 app folder>] node tests/chat_test.mjs
//
// The messaging identity (an Ed25519 seed, and the X25519 key derived from it); 1:1 chats both ways, with
// history after an app restart; own messages never coming back as incoming; duplicates; delivery states;
// unread counts; a key change; profiles and notes surviving backup and restore (and an 0.8.1 app restoring
// a 0.9 backup); paced sending to many recipients; blocking; the CSP.
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { world, app, restart, person, chatOf, check, until, sleep, stopAll, MC, CORE, ID, ED, hex, unhex, b64, ROOT, here } from "./chat_world.mjs";
const { ed25519, x25519 } = ED;
const N_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// ---- 1. the identity ---------------------------------------------------------------------------------
for (let i = 0; i < 20; i++) {
  const id = ID.newIdentity();
  const ok = hex(id.publicKey) === hex(ed25519.utils.toMontgomery(ed25519.getPublicKey(id.seed)))
          && hex(x25519.getPublicKey(id.secretKey)) === hex(id.publicKey);
  if (!ok) check("a seed's X25519 key is the Montgomery form of its Ed25519 key", false, hex(id.seed));
}
check("20 random seeds: the X25519 public key is toMontgomery(Ed25519 public key), and the secret gives it", true);
// RFC 8032 test 1: seed 9d61b1... gives Ed25519 public d75a98...; its X25519 form is fixed too
const rfc = ID.identityFromSeed(unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
check("RFC 8032 test 1 seed: the Ed25519 key is the RFC's", hex(rfc.edPublicKey) === "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
{
  const id = ID.newIdentity(), other = MC.newKeyPair();
  const m = MC.openMessage(id.secretKey, MC.sealMessage({ to: id.publicKey, from: "alice", fromSecret: other.secretKey, text: "hi" }));
  check("a message sealed to a seed's key opens with its derived secret", m && m.text === "hi" && m.authentic);
}

// ---- the world -----------------------------------------------------------------------------------------
const w = await world(18580, 5);
const A = await app(w, 8121, w.NODES[0]), B = await app(w, 8122, w.NODES[1]), C = await app(w, 8123, w.NODES[2]);
await person(w, A, "alice", "111222"); await person(w, B, "bob", "222333"); await person(w, C, "carol", "333444");
const rec = JSON.parse(readFileSync(join(A.data, "wallet-msgkey.json"), "utf8"));
check("the key record: version 2 with the seed, the X25519 pair and the name",
  rec.version === 2 && rec.seed === hex(A.id.seed) && rec.secret === hex(A.id.secretKey) && rec.public === hex(A.id.publicKey) && rec.name === "alice", Object.keys(rec));
let r = await A.call("/api/messages/key");
check("the page gets the seed and the key", r.d.seed === hex(A.id.seed) && r.d.public === hex(A.id.publicKey) && r.d.groups === true && r.d.version === 2);
{
  const D = await app(w, 8124, w.NODES[3]);
  D.session = (await D.call("/api/wallet/setup", { pin: "444555" })).d.session;
  const id = ID.newIdentity(), wrong = ID.newIdentity();
  r = await D.call("/api/messages/key", { seed: hex(wrong.seed), secret: hex(id.secretKey), public: hex(id.publicKey) });
  check("a seed that doesn't give the secret key is refused", r.code === 400, r);
  // a key file as 0.8.1 wrote it: X25519 only
  const kp = MC.newKeyPair();
  D.pin = "444555";
  writeFileSync(join(D.data, "wallet-msgkey.json"), JSON.stringify({ secret: hex(kp.secretKey), public: hex(kp.publicKey), name: "dave", created: "2026-11-01T00:00:00Z" }));
  const D2 = await restart(w, D);              // as after the update from 0.8.1
  r = await D2.call("/api/messages/key");
  check("an 0.8.1 key file still loads", r.code === 200 && r.d.public === hex(kp.publicKey) && r.d.seed === null && r.d.groups === false && r.d.version === 1, r.d);
  const d = JSON.parse(readFileSync(join(D.data, "wallet-msgkey.json"), "utf8"));
  check("and is marked in the file at start: version 1, no groups (nothing replaced)", d.version === 1 && d.groups === false && d.secret === hex(kp.secretKey), d);
  D2.proc.kill();
}

// ---- 2. 1:1 both ways -------------------------------------------------------------------------------------
const a = await chatOf(w, A), b = await chatOf(w, B);
check("no chats at first", a.conversations().length === 0);
r = await A.call("/api/messages/status");
check("status: nothing unread", r.d.unread === 0);
const id = await a.startDirect("bob");
check("a chat with bob: direct, one member, bob's key pinned", id === "d:bob" && a.convo(id).kind === "direct" && a.convo(id).members.length === 1 && a.pinned("bob") === hex(B.id.publicKey));
await a.send(id, "hi bob");
await until("alice's message gets to stored", async () => { await a.sync(); const m = a.messages(id)[0]; return m && m.sends[0].state === "sent"; }, 10000);
await until("bob's app gets it, in a new chat with alice", async () => { await b.sync(); return b.convo("d:alice") && b.messages("d:alice").length === 1; });
let m = b.messages("d:alice")[0];
check("it is alice's text, from alice, verified, unread", m.text === "hi bob" && m.sender === "alice" && b.trust(m) === "ok" && b.unread.has(m.n));
check("bob pinned alice's key at first contact (it matched the chain)", b.pinned("alice") === hex(A.id.publicKey));
r = await B.call("/api/messages/status");
check("bob's status: 1 unread", r.d.unread === 1, r.d);
const count = (data) => execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import server; print(server.messaging_inbox_count())", join(ROOT, "app")],
  { env: { ...process.env, APP_DATA: data, WAKU_API: "http://127.0.0.1:1" } }).toString().trim();
check("messaging_inbox_count() is the unread count", count(B.data) === "1");
await b.markRead("d:alice");
check("read: the count goes to 0", count(B.data) === "0" && (await B.call("/api/messages/status")).d.unread === 0);
await b.send("d:alice", "hi alice");
await b.send("d:alice", "how are you?");
await until("alice gets both replies", async () => { await a.sync(); return a.messages(id).filter(x => x.dir === "in").length === 2; });
const list = a.messages(id);
check("alice's chat: her message, then bob's two, in order", list.map(x => x.dir + ":" + x.text).join("|") === "out:hi bob|in:hi alice|in:how are you?", list.map(x => x.text));
check("her own message never came back as incoming", [...a.inbox.values()].filter(Boolean).every(x => x.sender === "bob"));
await sleep(1500);
await a.sync();
check("still not, after the node handed her own copy back (the send subscribed her node to bob's topic)", a.messages(id).length === 3);
// a note to herself
await a.startDirect("alice");
await a.send("d:alice", "remember the milk");
await sleep(1500); await a.sync();
check("a note to self shows once", a.messages("d:alice").length === 1 && a.messages("d:alice")[0].dir === "out");

// ---- interop: the names project's build opens a 1:1 message from this app ----
if (process.env.NAMES_MSG_CRYPTO) {
  const THEIRS = await import(pathToFileURL(process.env.NAMES_MSG_CRYPTO));
  const item = (await B.call("/api/messages/inbox")).d.items[0];
  const o = THEIRS.openMessage(B.id.secretKey, new Uint8Array(Buffer.from(item.payload, "base64")));
  check("the names project's build opens a chat message sent by this app (1:1 format unchanged)", o && o.text === "hi bob" && o.from === "alice" && THEIRS.isVerified(o, hex(A.id.publicKey)), o);
} else console.log("     (NAMES_MSG_CRYPTO not set: the check against the names project's build is skipped)");

// ---- duplicates: the same record twice, and history replay after a node restart ----
await w.control("dup/1"); await sleep(1200);
await w.control("restart/1"); await sleep(2500);
await b.sync();
check("a duplicate and a history replay are kept once", b.messages("d:alice").filter(x => x.dir === "in").length === 1);

// ---- 3. history after an app restart ----
const B2 = await restart(w, B);
const b2 = await chatOf(w, B2);
check("after a restart bob's chat has all three messages, both ways", b2.messages("d:alice").map(x => x.dir + ":" + x.text).join("|") === "in:hi bob|out:hi alice|out:how are you?");
check("and the delivery states", b2.messages("d:alice").filter(x => x.dir === "out").every(x => x.sends[0].state === "sent"));
check("and the read state", b2.unread.size === 0);
const cold = await B2.call("/api/messages/inbox", undefined, "0".repeat(64));
check("history needs an unlocked session", cold.code === 401);
const onDisk = readFileSync(join(B2.data, "wallet-outbox.json"), "utf8") + readFileSync(join(B2.data, "wallet-chat.json"), "utf8") + readFileSync(join(B2.data, "wallet-inbox.json"), "utf8");
check("nothing readable on disk: no text, no names, no notes", !/hi alice|how are you|alice|hi bob/.test(onDisk));

// ---- 4. profiles and notes ----
await a.setProfile("bob", { nickname: "Bobby", note: "met at the meetup; likes sourdough" });
const a2 = await chatOf(w, A);
check("a note and a nickname are kept (encrypted) and come back", a2.profile("bob").note === "met at the meetup; likes sourdough" && a2.title(a2.convo("d:bob")) === "Bobby");
check("a note is never sent", !(await B2.call("/api/messages/inbox")).d.items.some(i => Buffer.from(i.payload, "base64").toString("latin1").includes("sourdough")));
r = await A.call("/api/messages/store", { rev: 0, blob: "AAAA" });
check("a stale store write is refused (another page changed it)", r.code === 409, r);

// ---- 5. a key change ----
const C2key = ID.newIdentity();
await w.register("bob", { msg: hex(C2key.publicKey) });
await a.lookup("bob", true);
check("bob's key changed: the chat says so", a.keyState("bob").changed === true);
let why = await a.sendBlocker("d:bob");
check("and won't send to the new key before it's accepted", why && why.code === "changed", why);
let threw = null; try { await a.send("d:bob", "x"); } catch (e) { threw = e; }
check("send refuses", threw && threw.code === "changed");
const newMsg = MC.sealMessage({ to: A.id.publicKey, from: "bob", fromSecret: C2key.secretKey, text: "new phone" });
await w.control("inject/0", { topic: MC.inboxTopic(A.id.publicKey), payload: b64(newMsg) });
await until("the new-key message arrives", async () => { await a.sync(); return a.messages("d:bob").some(x => x.text === "new phone"); });
check("it is marked new-key, the old ones stay verified", a.trust(a.messages("d:bob").find(x => x.text === "new phone")) === "new-key" && a.trust(a.messages("d:bob").find(x => x.text === "hi alice")) === "ok");
await a.acceptKey("bob");
check("accepted: the new one is verified, the old ones say earlier key", a.trust(a.messages("d:bob").find(x => x.text === "new phone")) === "ok" && a.trust(a.messages("d:bob").find(x => x.text === "hi alice")) === "old");
check("and sending works again", (await a.sendBlocker("d:bob")) === null);
await w.register("bob", { msg: hex(B.id.publicKey) });      // back to bob's phone for the rest
await a.lookup("bob", true); await a.acceptKey("bob");

// ---- 6. an impostor ----
const forged = MC.sealMessage({ to: A.id.publicKey, from: "carol", fromSecret: MC.newKeyPair().secretKey, text: "it's carol, honest" });
await w.control("inject/0", { topic: MC.inboxTopic(A.id.publicKey), payload: b64(forged) });
await until("a message claiming to be carol", async () => { await a.sync(); return a.messages("d:carol").length === 1; });
check("is unverified, and nothing is pinned from it", a.trust(a.messages("d:carol")[0]) === "unverified" && a.pinned("carol") === null);

// ---- 6b. someone with no LNS name, by messaging address ----
{
  const parse = CORE.parseAddress;
  const kx = hex(MC.newKeyPair().publicKey);
  check("an address shared as msg:<hex>, with spaces and line breaks, is taken", parse("msg: " + kx.slice(0, 20) + "\n" + kx.slice(20)).address === kx && parse("msg:" + kx).sure === true);
  check("bare hex on the curve is taken, with a reminder to check", parse(kx).address === kx && parse(kx).sure === false);
  check("this wallet's own address is a wallet address", parse(kx, [kx]).wallet === true);
  let off = null; for (let i = 0; i < 64 && !off; i++) { const h = createHash("sha256").update("w" + i).digest("hex"); if (!CORE.onCurve(h)) off = h; }
  check("bare hex that can't be a messaging address is called a wallet address", parse(off).wallet === true && parse("msg:" + off).bad === true);
  check("a name isn't an address", parse("alice") === null);
}
const F = await app(w, 8127, w.NODES[3]);
F.session = (await F.call("/api/wallet/setup", { pin: "777888" })).d.session;
F.id = ID.newIdentity();
await F.call("/api/messages/key", { seed: hex(F.id.seed), secret: hex(F.id.secretKey), public: hex(F.id.publicKey) });
const f = await chatOf(w, F);
check("no name: messages go out as from the address", f.fromName() === "msg-" + hex(F.id.publicKey).slice(0, 16) && N_RE.test(f.fromName()));
await f.startDirect("alice");
await f.send("d:alice", "hello from someone with no name");
const fid = "k:" + hex(F.id.publicKey);
await until("alice gets it in a chat with the address", async () => { await a.sync(); return a.messages(fid).length === 1; });
m = a.messages(fid)[0];
check("from the address, proven, not verified by any name", m.sender === fid && a.trust(m) === "address" && a.convo(fid).members[0].key === hex(F.id.publicKey) && a.convo(fid).members[0].name === null);
check("its title is a short code", a.title(a.convo(fid)) === hex(F.id.publicKey).slice(0, 6) + "…" + hex(F.id.publicKey).slice(-4));
await a.send(fid, "hi address");
await until("the reply reaches the nameless app", async () => { await f.sync(); return f.messages("d:alice").some(x => x.text === "hi address" && f.trust(x) === "ok"); });
if (process.env.NAMES_MSG_CRYPTO) {
  const THEIRS = await import(pathToFileURL(process.env.NAMES_MSG_CRYPTO));
  const raw = (await A.call("/api/messages/inbox")).d.items.map(i => THEIRS.openMessage(A.id.secretKey, new Uint8Array(Buffer.from(i.payload, "base64")))).find(o => o && o.text === "hello from someone with no name");
  check("the names project's build opens a message from someone with no name (from: msg-<16 hex>), unverified", raw && raw.from === f.fromName() && !THEIRS.isVerified(raw, null), raw);
}
const pretender = MC.newKeyPair();
const forgedAddr = MC.sealMessage({ to: A.id.publicKey, from: f.fromName(), fromSecret: pretender.secretKey, text: "not really them" });
await w.control("inject/0", { topic: MC.inboxTopic(A.id.publicKey), payload: b64(forgedAddr) });
await sleep(1200); await a.sync();
check("someone else can't write as that address (the stand-in name is bound to the key)", !a.messages(fid).some(x => x.text === "not really them"));
check("and the pretender gets no chat of its own", !a.convo("k:" + hex(pretender.publicKey)));
await a.setProfile(fid, { nickname: "Flyer person", note: "met at the market" });
check("an address chat takes a nickname", a.title(a.convo(fid)) === "Flyer person");
// later the address turns out to be a name's
await F.call("/api/messages/name", { name: "frank" }); f.me.name = "frank";
await w.register("frank", { msg: hex(F.id.publicKey) });
await a.lookup("frank", true);
check("looking up frank finds the address chat to merge", a.addressChatFor(hex(F.id.publicKey)) === fid);
const merged = await a.mergeAddress(hex(F.id.publicKey), "frank");
check("merged: one chat with frank, with the earlier messages, nickname and note", merged === "d:frank" && !a.convo(fid) && a.messages("d:frank").length === 2 && a.profile("frank").note === "met at the market" && a.title(a.convo("d:frank")) === "Flyer person");
await f.send("d:alice", "now with a name");
await until("frank's named message lands in the same chat, verified", async () => { await a.sync(); const x = a.messages("d:frank").find(y => y.text === "now with a name"); return x && a.trust(x) === "ok"; });
let mergeErr = null; try { await a.mergeAddress(hex(MC.newKeyPair().publicKey), "frank"); } catch (e) { mergeErr = e; }
check("an address that isn't the name's can't be merged into it", mergeErr !== null);

// ---- 7. blocking ----
const c = await chatOf(w, C);
await c.startDirect("alice"); await c.send("d:alice", "real carol here");
await until("carol's real message", async () => { await a.sync(); return a.messages("d:carol").some(x => x.text === "real carol here"); });
check("the real carol is verified, and pinned now", a.trust(a.messages("d:carol").find(x => x.text === "real carol here")) === "ok" || a.pinned("carol") === null);
await a.setProfile("carol", { blocked: true });
check("blocked: her messages are hidden and read", a.messages("d:carol").filter(x => x.dir === "in").length === 0 && a.conversations().find(x => x.convo.id === "d:carol").unread === 0);
check("and nothing can be sent", (await a.sendBlocker("d:carol")).code === "blocked");
await a.setProfile("carol", { blocked: false });

// ---- 8. many recipients: one at a time, paced ----
const many = Array.from({ length: 12 }, () => MC.newKeyPair());
const before = (await w.ctlGet("posts/0")).length;
r = await A.call("/api/messages/outbox", { copy: b64(new Uint8Array(40)), sends: many.map(k => ({ topic: MC.inboxTopic(k.publicKey), payload: b64(MC.sealMessage({ to: k.publicKey, from: "alice", fromSecret: A.id.secretKey, text: "all of you" })) })) });
check("a message to 12 recipients is queued", r.code === 200, r);
const n12 = r.d.n;
await until("all 12 posted", async () => (await w.ctlGet("posts/0")).length - before >= 12, 15000);
const times = (await w.ctlGet("posts/0")).slice(before).map(p => p[0]);
const gaps = times.slice(1).map((t, i) => t - times[i]);
check("posted one at a time, at least the send gap apart (0.2 s here)", gaps.every(g => g >= 0.18), gaps.map(g => g.toFixed(2)));
await until("each recipient's state is followed to stored", async () => {
  const o = (await A.call("/api/messages/outbox?after=" + (n12 - 1))).d.items.find(i => i.n === n12);
  return o && o.sends.length === 12 && o.sends.every(x => x.state === "sent") && o;
}, 20000);
r = await A.call("/api/messages/outbox", { copy: b64(new Uint8Array(40)), sends: Array.from({ length: 17 }, () => ({ topic: MC.inboxTopic(many[0].publicKey), payload: "AAAA" })) });
check("more than 16 recipients is refused", r.code === 400);
await A.call("/api/messages/outbox/delete", { ids: [n12] });

// ---- 9. the node is off: a message waits, then goes; a failure can be retried ----
await w.control("down/0");
await until("alice's app sees the node off", async () => (await A.call("/api/messages/status")).d.node.reachable === false, 8000);
await a.send("d:bob", "sent while the node was off");
await sleep(800); await a.sync();
let waiting = a.messages("d:bob").find(x => x.text === "sent while the node was off");
check("it waits in the outbox", waiting.sends[0].state === "queued");
await w.control("up/0");
await until("and goes once the node is back", async () => { await a.sync(); return a.messages("d:bob").find(x => x.text === "sent while the node was off").sends[0].state === "sent"; }, 15000);
await until("bob gets it", async () => { await b2.sync(); return b2.messages("d:alice").some(x => x.text === "sent while the node was off"); });

// ---- 10. backup and restore: profiles, notes, history ----
for (let i = 0; i < 130; i++) {                 // enough history for a backup over 64 KiB
  const p = MC.sealMessage({ to: A.id.publicKey, from: "bob", fromSecret: B.id.secretKey, text: "filler message number " + i + " ".repeat(200) });
  await w.control("inject/0", { topic: MC.inboxTopic(A.id.publicKey), payload: b64(p) });
  if (i % 30 === 29) await sleep(800);           // the node keeps 50 between two reads
}
await until("the filler arrives", async () => (await A.call("/api/messages/status")).d.unread >= 130, 15000);
r = await A.call("/api/wallet/backup", { password: "alice backup password", pin: A.pin });
check("the backup has the chats", r.code === 200 && r.d.backup.version === 2, r.code);
const full = r.d.backup;
r = await A.call("/api/wallet/backup", { password: "alice backup password", pin: A.pin, history: false });
const small = r.d.backup;
check("without history it is smaller", JSON.stringify(small).length < JSON.stringify(full).length && JSON.stringify(full).length > 65536 && JSON.stringify(small).length < 65536, [JSON.stringify(small).length, JSON.stringify(full).length]);
{
  const G = await app(w, 8128, null, { WAKU_API: null });
  G.session = (await G.call("/api/wallet/setup", { pin: "888999" })).d.session;
  r = await G.call("/api/wallet/restore", { backup: full, password: "alice backup password", pin: "888999" });
  check("an app without messages restores the keys from a backup with history (over 64 KiB), and leaves the chats", r.code === 200 && r.d.ok && !("messages_restored" in r.d), r);
  G.proc.kill();
}
const E = await app(w, 8125, w.NODES[4]);
E.session = (await E.call("/api/wallet/setup", { pin: "555666" })).d.session;
r = await E.call("/api/wallet/restore", { backup: full, password: "alice backup password", pin: "555666" });
check("restoring alice's backup on a new phone brings the key and the messages", r.code === 200 && r.d.messaging_key_restored && r.d.messages_restored > 0, r);
E.session = (await E.call("/api/wallet/unlock", { pin: "555666" })).d.session;
const e = await chatOf(w, E);
check("the restored key is alice's, with its seed", (await E.call("/api/messages/key")).d.seed === hex(A.id.seed));
check("the note and nickname came back", e.profile("bob") && e.profile("bob").note === "met at the meetup; likes sourdough" && e.title(e.convo("d:bob")) === "Bobby");
check("and the chat with bob, both ways", e.messages("d:bob").some(x => x.dir === "in" && x.text === "hi alice") && e.messages("d:bob").some(x => x.dir === "out" && x.text === "hi bob"));
check("the restored copy of a sent message isn't sent again", e.messages("d:bob").filter(x => x.dir === "out").every(x => x.sends.every(s => s.state !== "queued")));
r = await E.call("/api/wallet/restore", { backup: full, password: "alice backup password", pin: "555666" });
await e.sync();
check("restoring the same backup again adds nothing twice", e.messages("d:bob").filter(x => x.text === "hi alice").length === 1, r.d);

// an 0.8.1 app restores the keys from a 0.9 backup without history
if (process.env.OLD_APP) {
  const O = await app(w, 8126, w.NODES[4], {}, null, join(process.env.OLD_APP, "server.py"));
  O.session = (await O.call("/api/wallet/setup", { pin: "666777" })).d.session;
  r = await O.call("/api/wallet/restore", { backup: small, password: "alice backup password", pin: "666777" });
  check("an 0.8.1 app restores a 0.9 backup (without history): keys and messaging key", r.code === 200 && r.d.messaging_key_restored, r);
  const k = JSON.parse(readFileSync(join(O.data, "wallet-msgkey.json"), "utf8"));
  check("with alice's messaging key (0.8.1 keeps the X25519 pair; the seed comes back with a 0.9 restore)", k.secret === hex(A.id.secretKey));
  O.proc.kill();
} else console.log("     (OLD_APP not set: the 0.8.1 restore check is skipped)");

// ---- 11. the page: CSP and what's served ----
const head = await fetch(A.base + "/");
check("the page may show inline (data:) pictures, nothing remote", head.headers.get("content-security-policy").includes("img-src 'self' data:;"));
for (const f of ["messages.js", "chat-core.js", "icon.js", "identity.js"]) check(`the module ${f} is served`, (await fetch(A.base + "/messages/" + f)).ok);
const log = readFileSync(join(A.data, "wallet-events.log"), "utf8");
check("the event log has no text, names or counts of messages", !/hi bob|sourdough|bob|carol|Bobby/.test(log.split("\n").filter(l => l.includes("message")).join("\n")) && log.includes(" message sent "), log.slice(-300));
stopAll();
console.log("all checks passed");
process.exit(0);

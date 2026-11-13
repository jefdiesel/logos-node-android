// Messages, version 2 step 1 (0.9.22), with no change to the wire format: padding, safety codes, Requests.
//
//   [NAMES_MSG_CRYPTO=<the names project's msg-crypto.js>] [PORT_SHIFT=<n>] node tests/msg_v2_test.mjs
//
// 1. Padding: sealPadded (app/messages/chat-core.js) against the vendored version 1 reader (msg-crypto.js
//    openMessage) and, when given, the names project's own build: every message opens, proves its sender, and
//    its plaintext is exactly one of the four size classes.
// 2. Safety codes: fixed vectors made by an independent implementation (Python's hashlib, below), order
//    independence, and what a scanned code may be.
// 3. Requests, with real app servers on a fake messaging network: a stranger's messages go to Requests (never
//    a chat, never unread), the per-sender and total caps, accept / delete / block / unblock, "Only people I've
//    written to", unreadable payloads, the server's own cap on unsorted messages, the move of an existing inbox,
//    and backups without requests.
// 4. Checked contacts: checked only for the address compared; a change of it stops sending until it's compared
//    again or accepted on purpose.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { world, app, restart, person, chatOf, check, until, sleep, stopAll, MC, CORE, ID, hex, unhex, b64, ROOT } from "./chat_world.mjs";

const PS = Number(process.env.PORT_SHIFT || 0);
const THEIRS = process.env.NAMES_MSG_CRYPTO ? await import(pathToFileURL(process.env.NAMES_MSG_CRYPTO)) : null;
const enc = new TextEncoder();

const { xchacha20poly1305 } = await import(pathToFileURL(join(ROOT, "app", "messages", "noble-ciphers", "chacha.js")));
const { hkdf } = await import(pathToFileURL(join(ROOT, "app", "messages", "noble-hashes", "hkdf.js")));
const { sha256 } = await import(pathToFileURL(join(ROOT, "app", "messages", "noble-hashes", "sha2.js")));
const { x25519 } = await import(pathToFileURL(join(ROOT, "app", "noble-curves", "ed25519.js")));
const { hmac } = await import(pathToFileURL(join(ROOT, "app", "messages", "noble-hashes", "hmac.js")));
/** A version 1 message that proves its sender, with `fromKeyBytes` written as the sender's key (any spelling). */
function sealAs(to, from, fromSecret, fromKeyBytes, text, ts = Date.now()) {
  const eph = x25519.utils.randomSecretKey(), ephPub = x25519.getPublicKey(eph), nonce = crypto.getRandomValues(new Uint8Array(24));
  const header = new Uint8Array([1, ...ephPub, ...nonce]);
  const authKey = hkdf(sha256, x25519.getSharedSecret(fromSecret, to), new Uint8Array(0), enc.encode("names/msg/v1/auth"), 32);
  const auth = hmac(sha256, authKey, new Uint8Array([...header, ...enc.encode(from), 0, ...fromKeyBytes, ...enc.encode(String(ts)), 0, ...enc.encode(text)]));
  const key = hkdf(sha256, x25519.getSharedSecret(eph, to), new Uint8Array([...ephPub, ...to]), enc.encode("names/msg/v1"), 32);
  const ct = xchacha20poly1305(key, nonce, new Uint8Array([1, ...ephPub])).encrypt(enc.encode(JSON.stringify({ v: 1, from, fromKey: hex(fromKeyBytes), text, ts, auth: hex(auth) })));
  return new Uint8Array([...header, ...ct]);
}
/** A version 1 payload around any JSON object (to make one whose `auth` is wrong). */
function sealRaw(to, obj) {
  const eph = x25519.utils.randomSecretKey(), ephPub = x25519.getPublicKey(eph), nonce = crypto.getRandomValues(new Uint8Array(24));
  const key = hkdf(sha256, x25519.getSharedSecret(eph, to), new Uint8Array([...ephPub, ...to]), enc.encode("names/msg/v1"), 32);
  const ct = xchacha20poly1305(key, nonce, new Uint8Array([1, ...ephPub])).encrypt(enc.encode(JSON.stringify(obj)));
  return new Uint8Array([1, ...ephPub, ...nonce, ...ct]);
}

// ---- 1. padding ----------------------------------------------------------------------------------------
const rcpt = ID.newIdentity(), sender = ID.newIdentity();
const bareSize = (text, from = "alice", ts = 1700000000000) =>        // the JSON with an empty "p", as sealPadded measures it
  enc.encode(JSON.stringify({ v: 1, from, fromKey: hex(sender.publicKey), text, ts, auth: "0".repeat(64), p: "" })).length;
function roundTrip(text, from = "alice", ts = 1700000000000) {
  const sealed = CORE.sealPadded({ to: rcpt.publicKey, from, fromSecret: sender.secretKey, text, ts });
  const o = MC.openMessage(rcpt.secretKey, sealed);
  const t = THEIRS ? THEIRS.openMessage(rcpt.secretKey, sealed) : o;
  return { sealed, plain: sealed.length - 57 - 16, o, t, ok: !!o && o.text === text && o.from === from && o.ts === ts && o.authentic
    && o.fromKey === hex(sender.publicKey) && MC.isVerified(o, hex(sender.publicKey)) && !!t && t.text === text && t.authentic };
}
check("four size classes, the top one under the server's 16,384 bytes with the 73 around it", JSON.stringify(CORE.PAD_CLASSES) === "[512,2048,8192,15872]" && 15872 + 73 <= 16384);
{
  const r = roundTrip("hi");
  check("a short message opens with the version 1 reader, from its sender, proven", r.ok, r.o);
  check("and its plaintext is 512 bytes (a wire payload of 585)", r.plain === 512 && r.sealed.length === 585, r.sealed.length);
  if (THEIRS) check("the names project's build opens it too, proven (isVerified)", THEIRS.isVerified(r.t, hex(sender.publicKey)));
  else console.log("     (NAMES_MSG_CRYPTO not set: the names project's build is not tried)");
}
// every text length around the first edge: the 7 bytes of ,"p":"" count, so a text that fills 512 without
// them goes to 2048
const base = bareSize("");
let edges = 0;
for (let n = 512 - base - 3; n <= 512 - base + 3; n++) {
  const text = "x".repeat(n), r = roundTrip(text), want = bareSize(text) <= 512 ? 512 : 2048;
  if (!r.ok || r.plain !== want) check(`a ${n}-character text lands in ${want}`, false, { plain: r.plain, bare: bareSize(text) });
  edges++;
}
check(`texts on both sides of the 512 edge land in 512 or 2048, exactly (${edges} lengths)`, edges === 7);
for (const [what, text, want] of [
  ["1,000 characters", "a".repeat(1000), 2048],
  ["2,000 characters (MAX_TEXT)", "b".repeat(2000), 8192],
  ["1,000 emoji (2,000 UTF-16 units, 4,000 bytes)", "😀".repeat(1000), 8192],
  ["2,000 control characters (escaped to 6 bytes each)", "\u0001".repeat(2000), 15872],
  ["2,000 lone surrogates (escaped to 6 bytes each)", "\ud800".repeat(2000), 15872],
  ["2,000 quotes and backslashes", "\"\\".repeat(1000), 8192]]) {
  const r = roundTrip(text);
  check(`${what}: opens, proven, plaintext ${want} bytes, wire ${r.sealed.length} <= 16,384`, r.ok && r.plain === want && r.sealed.length <= 16384, { plain: r.plain, len: r.sealed.length, o: r.o && r.o.text.length });
}
{
  const r = roundTrip("hi", "msg-" + hex(sender.publicKey).slice(0, 16));
  check("a sender with no name (from: msg-<16 hex>) pads the same way", r.ok && r.plain === 512);
  let threw = 0;
  for (const bad of [{ text: "" }, { text: "x".repeat(2001) }, { from: "Not A Name" }, { to: new Uint8Array(31) }]) {
    try { CORE.sealPadded({ to: rcpt.publicKey, from: "alice", fromSecret: sender.secretKey, text: "x", ...bad }); } catch (e) { threw++; }
  }
  check("it refuses what sealMessage refuses: empty or over-long text, a from that isn't a name, a bad key", threw === 4);
  // the padding is a JSON field "p" of spaces only, inside the AEAD: decrypt one here and look
  const s = r.sealed, eph = s.subarray(1, 33);
  const key = hkdf(sha256, x25519.getSharedSecret(rcpt.secretKey, eph), new Uint8Array([...eph, ...rcpt.publicKey]), enc.encode("names/msg/v1"), 32);
  const plain = JSON.parse(new TextDecoder().decode(xchacha20poly1305(key, s.subarray(33, 57), new Uint8Array([1, ...eph])).decrypt(s.subarray(57))));
  check("inside: the version 1 fields and \"p\", spaces only", JSON.stringify(Object.keys(plain)) === JSON.stringify(["v", "from", "fromKey", "text", "ts", "auth", "p"]) && /^ *$/.test(plain.p) && plain.v === 1);
  const a = CORE.sealPadded({ to: rcpt.publicKey, from: "alice", fromSecret: sender.secretKey, text: "same", ts: 1 }), b = CORE.sealPadded({ to: rcpt.publicKey, from: "alice", fromSecret: sender.secretKey, text: "same", ts: 1 });
  check("two seals of the same text differ (a new ephemeral key and nonce each time)", hex(a) !== hex(b) && a.length === b.length);
  const other = ID.newIdentity();
  check("and only the recipient opens it", MC.openMessage(other.secretKey, a) === null);
}

// ---- 2. safety codes -----------------------------------------------------------------------------------
// RFC 7748's two X25519 public keys, as two people's messaging addresses
const KA = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", KB = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
// an independent implementation, from the description in chat-core.js alone (Python's hashlib)
const PY = `
import hashlib, sys
def half(k):
    k = bytes.fromhex(k); h = hashlib.sha512(b"names/safety-code/v1" + k).digest()
    for _ in range(5200): h = hashlib.sha512(h + k).digest()
    return "".join("%05d" % (int.from_bytes(h[5 * i:5 * i + 5], "big") % 100000) for i in range(6))
print("".join(sorted([half(sys.argv[1]), half(sys.argv[2])])))`;
const py = (a, b) => execFileSync("python3", ["-c", PY, a, b]).toString().trim();
// the same vector, written down (made by the Python above; a change to the derivation must change it here)
const VECTOR = py(KA, KB);
check("the safety code of the RFC 7748 keys matches the independent implementation", CORE.safetyCode(KA, KB) === VECTOR, [CORE.safetyCode(KA, KB), VECTOR]);
check("it is 60 digits in 12 groups of 5", /^\d{60}$/.test(VECTOR) && CORE.safetyGroups(VECTOR).length === 12 && CORE.safetyGroups(VECTOR).every(g => g.length === 5));
check("the same whichever side computes it", CORE.safetyCode(KB, KA) === VECTOR);
for (let i = 0; i < 3; i++) {
  const a = hex(ID.newIdentity().publicKey), b = hex(ID.newIdentity().publicKey);
  if (CORE.safetyCode(a, b) !== py(a, b)) check("random keys: the same as the independent implementation", false, [a, b]);
}
check("3 random pairs: the same as the independent implementation", true);
{
  const flipped = (KB.slice(0, 63) + (KB[63] === "f" ? "e" : "f"));
  const c1 = CORE.safetyCode(KA, KB), c2 = CORE.safetyCode(KA, flipped);
  check("one changed bit in one address changes that address's half, not the other's", c1 !== c2 && (c1.slice(0, 30) === c2.slice(0, 30) || c1.slice(30) === c2.slice(30) || c1.slice(0, 30) === c2.slice(30) || c1.slice(30) === c2.slice(0, 30)));
  check("a scanned safety-code QR reads back", JSON.stringify(CORE.readSafetyScan(CORE.safetyQr(c1))) === JSON.stringify({ code: c1 }));
  check("a scanned messaging address reads as an address", CORE.readSafetyScan("msg:" + KA).key === KA && CORE.readSafetyScan("MSG:" + KA.toUpperCase()).key === KA);
  check("anything else is refused: a wallet address, a short code, junk, an over-long text", [KA, "names-safety:1:123", "hello", "names-safety:1:" + "1".repeat(60) + "x", "x".repeat(300)].every(t => CORE.readSafetyScan(t) === null));
  let bad = null; try { CORE.safetyCode("zz", KB); } catch (e) { bad = e; }
  check("a code needs two messaging addresses", bad !== null);
}

// ---- 3. requests -----------------------------------------------------------------------------------------
const w = await world(18600 + PS, 5);
const A = await app(w, 8141 + PS, w.NODES[0]), B = await app(w, 8142 + PS, w.NODES[1]);
await person(w, A, "alice", "111222"); await person(w, B, "bob", "222333");
const a = await chatOf(w, A), b = await chatOf(w, B);
const TOPIC = MC.inboxTopic(A.id.publicKey);
const inject = async (payload) => w.control("inject/0", { topic: TOPIC, payload: b64(payload) });
const fromKey = (kp, text, from = null, to = A.id.publicKey) => MC.sealMessage({ to, from: from || "msg-" + hex(kp.publicKey).slice(0, 16), fromSecret: kp.secretKey, text });
// everything on the server: the inbox read, and the dropped messages (left out of it since the second review)
const serverItems = async () => [...(await A.call("/api/messages/inbox")).d.items, ...(await A.call("/api/messages/inbox?dropped=1")).d.items].sort((x, y) => x.n - y.n);
const status = async () => (await A.call("/api/messages/status")).d;
const pyServer = (data, expr) => execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import server; print(" + expr + ")", join(ROOT, "app")],
  { env: { ...process.env, APP_DATA: data, WAKU_API: "http://127.0.0.1:1" } }).toString().trim();
const reqOf = key => a.requests().find(g => g.key === key);

check("a new inbox starts sorting at its first message", (await A.call("/api/messages/inbox")).d.sort_from === 1);
// bob writes first: a request, not a chat
await b.startDirect("alice"); await b.send("d:alice", "hi alice, it's bob");
await until("bob's first message reaches alice as a request", async () => { await a.sync(); return a.requests().length === 1; });
let g = a.requests()[0];
check("it is in Requests only: no chat, nothing in the list, nothing unread", a.conversations().length === 0 && a.unreadTotal() === 0 && g.list.length === 1 && g.list[0].text === "hi alice, it's bob");
check("the server counts it as read (status and messaging_inbox_count)", (await status()).unread === 0 && pyServer(A.data, "server.messaging_inbox_count()") === "0");
check("the server keeps it sorted as a request", (await serverItems()).every(i => i.k === "r" && i.read === true));
check("before the name service is asked, it is a claim, not a name: alice's phone looked nothing up for it", g.proof === "claim" && g.claimed === "bob" && !g.chainRead && !a.chainOf("bob"));
await a.checkRequests();
g = a.requests()[0];
check("Requests reads the chain: bob proves his LNS name", g.proof === "name" && g.name === "bob" && g.key === hex(B.id.publicKey) && g.rank === 2);
check("bob's message was padded to a size class on the wire", (await serverItems()).every(i => CORE.PAD_CLASSES.includes(Buffer.from(i.payload, "base64").length - 73)));
// per sender: the first 3 messages
for (let i = 2; i <= 5; i++) await b.send("d:alice", "message " + i);
await until("bob's next messages arrive", async () => { await a.sync(); return a.dropped().caps === 2; });
g = a.requests()[0];
check("one request per sender, its first 3 messages kept, 2 more dropped unread (marked on the server, read, deleted later)", a.requests().length === 1 && g.list.map(m => m.text).join("|") === "hi alice, it's bob|message 2|message 3"
  && (await serverItems()).filter(i => i.k === "r").length === 3 && (await serverItems()).filter(i => i.k === "d" && i.read).length === 2);
// accept: a chat with bob
const bid = await a.acceptRequest(g.id);
check("accepted: a chat with bob, the 3 messages and the 2 the cap had dropped (still within the grace period), his address pinned, nothing left in Requests",
  bid === "d:bob" && a.messages("d:bob").length === 5 && a.pinned("bob") === hex(B.id.publicKey) && a.requests().length === 0 && a.trust(a.messages("d:bob")[0]) === "ok");
check("the server keeps all 5 as chat messages now", (await serverItems()).length === 5 && (await serverItems()).every(i => i.k === "c"));
check("the 2 that came back from dropped count as new (unread); the 3 read in Requests don't", a.unreadTotal() === 2 && (await status()).unread === 2, [a.unreadTotal(), (await status()).unread]);
await a.markRead("d:bob");
await b.send("d:alice", "now we're talking");
await until("the next message from bob goes to the chat, unread", async () => { await a.sync(); return a.messages("d:bob").some(m => m.text === "now we're talking") && a.unreadTotal() === 1; });
check("and counts on the server", (await status()).unread === 1 && pyServer(A.data, "server.messaging_inbox_count()") === "1");
await a.markRead("d:bob");
// delete
const X = MC.newKeyPair(), xk = hex(X.publicKey);
await inject(fromKey(X, "hello from an address")); await inject(fromKey(X, "again"));
await until("an address with no name: a request", async () => { await a.sync(); return reqOf(xk) && reqOf(xk).list.length === 2; });
check("it shows as an address, not a name", reqOf(xk).proof === "address" && reqOf(xk).rank === 1);
await a.deleteRequest(reqOf(xk).id);
check("deleted: gone from Requests and from the server", !reqOf(xk) && !(await serverItems()).some(i => i.k === "r"));
await inject(fromKey(X, "third try"));
await until("the same address writing again is a request again", async () => { await a.sync(); return reqOf(xk) && reqOf(xk).list.length === 1; });
// block and unblock
await a.blockRequest(reqOf(xk).id);
check("blocked: gone from Requests, on the Blocked list", !reqOf(xk) && a.blockedList().some(e => e.kind === "key" && e.key === xk));
await inject(fromKey(X, "blocked now"));
await until("a blocked address's message is deleted unread and counted", async () => { await a.sync(); return a.dropped().blocked >= 2; });
check("nothing of it stays on the server but as dropped (hidden, read, deleted after the grace period)", !(await serverItems()).some(i => i.k !== "c" && i.k !== "d") && (await serverItems()).filter(i => i.k === "d").every(i => i.read));
await a.unblock(a.blockedList().find(e => e.key === xk));
await inject(fromKey(X, "unblocked"));
await until("after Unblock its next message is a request again", async () => { await a.sync(); return reqOf(xk) && reqOf(xk).list[0].text === "unblocked"; });
// a claim: proves its address, names bob (a contact) without being bob
const Z = MC.newKeyPair(), zk = hex(Z.publicKey);
await inject(fromKey(Z, "it's bob, new phone, honest", "bob"));
await until("a message claiming to be bob from another address", async () => { await a.sync(); return !!reqOf(zk); });
g = reqOf(zk);
check("it is a request, never bob's chat: a claim the chain doesn't back", g.proof === "claim" && g.claimed === "bob" && g.chainRead && !a.messages("d:bob").some(m => m.text.includes("honest")));
let err = null; try { await a.acceptRequest(g.id); } catch (e) { err = e; }
check("a claim can't be accepted (it would put a stranger in a chat as bob)", err && err.code === "unproven" && !a.convo("k:" + zk));
// one that can't prove its address
await inject(sealRaw(A.id.publicKey, { v: 1, from: "carol", fromKey: hex(MC.newKeyPair().publicKey), text: "carol here, honest", ts: Date.now(), auth: "0".repeat(64) }));
await until("a message that can't prove its address", async () => { await a.sync(); return a.requests().some(r => !r.authentic); });
g = a.requests().find(r => !r.authentic);
check("it shows as 'none': no name, no address", g.proof === "none" && g.rank === 0);
err = null; try { await a.blockRequest(g.id); } catch (e) { err = e; }
check("and blocking it is refused (anyone can write any address into a message)", err !== null);
await a.deleteRequest(g.id);
// unreadable
await inject(new Uint8Array(80).fill(7));
await until("a payload that isn't a message for this phone arrives", async () => (await serverItems()).some(i => Buffer.from(i.payload, "base64").length === 80));
await a.sync();
check("it is dropped unread on the next sync, and not counted as someone's", (await serverItems()).filter(i => Buffer.from(i.payload, "base64").length === 80).every(i => i.k === "d") && !("unreadable" in a.dropped()));
// only people I've written to
const before = a.dropped().only;
await a.setOnlyKnown(true);
check("'Only people I've written to': the waiting requests are deleted unread", a.requests().length === 0 && a.dropped().only === before + 2 && !(await serverItems()).some(i => i.k === "r"));
const Wk = MC.newKeyPair();
await inject(fromKey(Wk, "spam"));
await until("a new stranger's message is deleted unread", async () => { await a.sync(); return a.dropped().only === before + 3; });
await b.send("d:alice", "contacts still get through");
await until("a contact's message still arrives in the chat", async () => { await a.sync(); return a.messages("d:bob").some(m => m.text === "contacts still get through"); });
await a.setOnlyKnown(false);
// age: a request older than 30 days goes
await inject(fromKey(Wk, "old by the time it's sorted"));
await until("a request", async () => { await a.sync(); return !!reqOf(hex(Wk.publicKey)); });
{
  const now = Date.now; Date.now = () => now() + 31 * 864e5;
  try { await a.sortIncoming(); } finally { Date.now = now; }
  check("past 30 days it is deleted unread", !reqOf(hex(Wk.publicKey)) && a.dropped().age === 1);
}
// the total: 50 requests, a proven name kept before addresses, the oldest addresses dropped first
const nina = ID.newIdentity();
await w.register("nina", { msg: hex(nina.publicKey) });
await inject(MC.sealMessage({ to: A.id.publicKey, from: "nina", fromSecret: nina.secretKey, text: "hi from nina" }));
await until("nina's request", async () => { await a.sync(); return !!reqOf(hex(nina.publicKey)); });
await a.checkRequests();
check("nina proves her name", reqOf(hex(nina.publicKey)).proof === "name");
const flood = Array.from({ length: 51 }, () => MC.newKeyPair());
for (let i = 0; i < flood.length; i++) { await inject(fromKey(flood[i], "flood " + i)); if (i % 20 === 19) { await sleep(700); await a.sync(); } }
await until("the flood is sorted", async () => { await a.sync(); return (await serverItems()).filter(i => !i.k).length === 0 && a.requests().some(r => r.list[0].text === "flood 50"); }, 20000);
const keys = new Set(a.requests().map(r => r.key));
check("at most 50 requests", a.requests().length === 50, a.requests().length);
check("nina's (a proven name, older) is kept", keys.has(hex(nina.publicKey)));
check("the oldest addresses went first: the unblocked one, the claim and flood 0 and 1 are gone, flood 2..50 are kept",
  !keys.has(xk) && !keys.has(zk) && !keys.has(hex(flood[0].publicKey)) && !keys.has(hex(flood[1].publicKey)) && flood.slice(2).every(k => keys.has(hex(k.publicKey))));
check("and the server holds only what is kept", (await serverItems()).filter(i => i.k === "r").length === 50);
for (const r of [...a.requests()]) await a.deleteRequest(r.id);
// the total in bytes: 1 MiB
const big = Array.from({ length: 30 }, () => MC.newKeyPair());
for (let i = 0; i < big.length; i++) {
  for (let j = 0; j < 3; j++) await inject(fromKey(big[i], "\u0001".repeat(2000)));
  if (i % 5 === 4) { await sleep(700); await a.sync(); }
}
await until("the big ones are sorted", async () => { await a.sync(); return (await serverItems()).filter(i => !i.k).length === 0 && a.requests().some(r => r.key === hex(big[29].publicKey)); }, 30000);
{
  const bytes = a.requests().reduce((s, r) => s + r.size, 0);
  const onServer = (await serverItems()).filter(i => i.k === "r").reduce((s, i) => s + Buffer.from(i.payload, "base64").length, 0);
  check(`requests keep at most 1 MiB of sealed bytes (${bytes}), the newest kept`, bytes <= CORE.REQ.BYTES && bytes > CORE.REQ.BYTES - 3 * 13000 && a.requests().length < 30 && !!reqOf(hex(big[29].publicKey)) && !reqOf(hex(big[0].publicKey)) && onServer === bytes, [bytes, a.requests().length, onServer]);
}
for (const r of [...a.requests()]) await a.deleteRequest(r.id);
// a backup holds no requests
await inject(fromKey(MC.newKeyPair(), "a request at backup time"));
await until("one request", async () => { await a.sync(); return a.requests().length === 1; });
{
  const kept = JSON.parse(pyServer(A.data, "__import__('json').dumps([i['payload'] for i in (server.chat_backup(True) or {}).get('inbox', [])])"));
  const req = a.requests()[0].list[0];
  const reqPayload = (await serverItems()).find(i => i.n === req.n).payload;
  check("a backup with history has the chat messages but not the request", kept.length >= 4 && !kept.includes(reqPayload));
}

// ---- the server alone: its cap on unsorted messages, and an inbox from before Requests ----
{
  const S = await app(w, 8143 + PS, w.NODES[2], { MESSAGING_PENDING_MAX: "5" });
  await person(w, S, "sam", "555666");
  const t = MC.inboxTopic(S.id.publicKey);
  for (let i = 0; i < 3; i++) await w.control("inject/2", { topic: t, payload: b64(MC.sealMessage({ to: S.id.publicKey, from: "bob", fromSecret: B.id.secretKey, text: "known " + i })) });
  await until("3 arrive", async () => (await S.call("/api/messages/inbox")).d.items.length === 3);
  // the page made bob a contact and sorted them: chat messages
  const s = await chatOf(w, S);
  await s.startDirect("bob"); await s.sync();
  check("the page sorted them as chat messages", (await S.call("/api/messages/inbox")).d.items.every(i => i.k === "c"));
  for (let i = 0; i < 8; i++) await w.control("inject/2", { topic: t, payload: b64(fromKey(MC.newKeyPair(), "stranger " + i, null, S.id.publicKey)) });
  await sleep(1500);
  const items = (await S.call("/api/messages/inbox")).d.items, st = (await S.call("/api/messages/status")).d;
  check("with the page away, the server keeps the newest 5 unsorted messages (here): the oldest made room, and are counted as lost",
    items.filter(i => i.k !== "c").length === 5 && st.lost.count === 3 && !!st.lost.last && items.filter(i => i.k !== "c").every(i => i.n > 6), [items.length, st.lost]);
  check("and the chat messages are all still there", items.filter(i => i.k === "c").length === 3);
  await w.control("inject/2", { topic: t, payload: b64(MC.sealMessage({ to: S.id.publicKey, from: "bob", fromSecret: B.id.secretKey, text: "late" })) });
  await until("a contact's message after the flood still gets in (it can't tell bob's from a stranger's: the oldest unsorted one goes)", async () => (await S.call("/api/messages/inbox")).d.items.some(i => i.n === 12));
  check("the room stays 5, and one more is counted lost", (await S.call("/api/messages/inbox")).d.items.filter(i => i.k !== "c").length === 5 && (await S.call("/api/messages/status")).d.lost.count === 4);
  await s.sync();
  check("the page sorts them: bob's is in his chat, the strangers' are requests", s.messages("d:bob").some(m => m.text === "late") && (await S.call("/api/messages/inbox")).d.items.filter(i => i.k === "r").length === 4);
  S.proc.kill();
}
{
  // an inbox as 0.9.13 left it: no sort_from, no sorting
  const H = await app(w, 8144 + PS, w.NODES[3]);
  H.pin = "121212"; H.session = (await H.call("/api/wallet/setup", { pin: H.pin })).d.session;
  const kp = ID.newIdentity(), stranger = MC.newKeyPair();
  await H.call("/api/messages/key", { seed: hex(kp.seed), secret: hex(kp.secretKey), public: hex(kp.publicKey) });
  const old = MC.sealMessage({ to: kp.publicKey, from: "msg-" + hex(stranger.publicKey).slice(0, 16), fromSecret: stranger.secretKey, text: "from before the update" });
  writeFileSync(join(H.data, "wallet-inbox.json"), JSON.stringify({ version: 1, next: 2, seen: ["p:x"], items: [{ n: 1, payload: b64(old), source: "live", received: "2026-11-10T10:00:00Z" }] }));
  H.id = kp;
  const H2 = await restart(w, H);
  const r = (await H2.call("/api/messages/inbox")).d;
  check("an inbox from before Requests: what is there stays a chat message, sorting starts after it", r.sort_from === 2 && r.items[0].k === "c");
  const h = await chatOf(w, H2);
  check("so a stranger's message from before the update is still a chat, as it was", h.requests().length === 0 && h.messages("k:" + hex(stranger.publicKey)).length === 1);
  H2.proc.kill();
}

// ---- 4. checked contacts ---------------------------------------------------------------------------------
check("not checked until the user does it", !a.isChecked("bob"));
const code = a.safetyFor("bob");
check("the code to compare is for bob's pinned address, and bob's phone shows the same code", code.key === hex(B.id.publicKey) && !code.changed && code.code === CORE.safetyCode(hex(B.id.publicKey), hex(A.id.publicKey)) && code.code === b.safetyFor("alice").code);
err = null; try { await a.markChecked("bob", hex(MC.newKeyPair().publicKey)); } catch (e) { err = e; }
check("checking another address is refused", err !== null && !a.isChecked("bob"));
await a.markChecked("bob", code.key, "scan");
check("checked: for that address, by a scan", a.isChecked("bob") && a.profile("bob").checked.how === "scan" && a.profile("bob").checked.key === hex(B.id.publicKey));
const a2 = await chatOf(w, A);
check("kept (encrypted) across a reload", a2.isChecked("bob"));
// bob's address changes
const B2 = ID.newIdentity();
await w.register("bob", { msg: hex(B2.publicKey) });
await a.lookup("bob", true);
let why = await a.sendBlocker("d:bob");
check("a checked contact's address changed: sending stops, with its own reason", why && why.code === "changed-checked" && a.checkedButChanged("bob"), why);
err = null; try { await a.send("d:bob", "x"); } catch (e) { err = e; }
check("send refuses", err && err.code === "changed-checked");
err = null; try { await a.acceptKey("bob"); } catch (e) { err = e; }
check("the one-tap accept is refused for a checked contact", err && err.code === "checked" && a.pinned("bob") === hex(B.id.publicKey));
const fresh = a.safetyFor("bob");
check("the code to compare now is for the new address", fresh.changed && fresh.key === hex(B2.publicKey) && fresh.code === CORE.safetyCode(hex(B2.publicKey), hex(A.id.publicKey)));
await a.markChecked("bob", fresh.key, "code");
check("compared again: the new address is accepted and checked, and sending works", a.pinned("bob") === hex(B2.publicKey) && a.isChecked("bob") && (await a.sendBlocker("d:bob")) === null);
const B3 = ID.newIdentity();
await w.register("bob", { msg: hex(B3.publicKey) });
await a.lookup("bob", true);
await a.acceptKey("bob", { unchecked: true });
check("accepted without checking, on purpose: the new address is used, and bob is no longer checked", a.pinned("bob") === hex(B3.publicKey) && !a.isChecked("bob") && (await a.sendBlocker("d:bob")) === null);
await a.markChecked("bob", hex(B3.publicKey));
await a.clearChecked("bob");
check("a check can be taken back", !a.isChecked("bob"));
// an unchecked contact keeps the earlier flow
await w.register("bob", { msg: hex(B.id.publicKey) });
await a.lookup("bob", true);
why = await a.sendBlocker("d:bob");
check("an unchecked contact's change: the earlier 'changed', and the one-tap accept works", why.code === "changed" && (await a.acceptKey("bob"), (await a.sendBlocker("d:bob")) === null));

// ---- 5. review fixes: sealing races, auto-lock, failing closed ---------------------------------------------
// (a) send() reads my own name on chain after its checks; a chain read of the contact finishing meanwhile
// (opening the chat, a sync) must not get the message sealed to a new, unaccepted address
for (const checked of [true, false]) {
  if (checked) await a.markChecked("bob", hex(B.id.publicKey)); else await a.clearChecked("bob");
  const raceKey = MC.newKeyPair(), real = a.resolveRaw;
  const outBefore = (await A.call("/api/messages/outbox")).d.items.length;
  await a.lookup("bob", true);
  a.chain.delete("alice");                     // send() reads alice again: the moment of the race
  a.resolveRaw = async name => { if (name === "alice") { const c = a.chain.get("bob"); a.chain.set("bob", { ...c, key: hex(raceKey.publicKey), at: Date.now() }); } return real(name); };
  err = null; try { await a.send("d:bob", "sealed in the race"); } catch (e) { err = e; }
  a.resolveRaw = real;
  check(`${checked ? "a checked" : "an unchecked"} contact's address changing between the checks and the seal: nothing is sealed or queued (${checked ? "changed-checked" : "changed"})`,
    err && err.code === (checked ? "changed-checked" : "changed") && (await A.call("/api/messages/outbox")).d.items.length === outBefore && a.pinned("bob") === hex(B.id.publicKey), err && err.code);
  await a.lookup("bob", true);
}
check("and with nothing changed, sending to bob works (sealed to his pinned address)", (await a.send("d:bob", "after the race")) > 0);
// (b) a stranger's messages, sorted and dropped by the page, never count as the user being active
{
  const L = await app(w, 8145 + PS, w.NODES[2], { AUTOLOCK_MINUTE_SECONDS: "3" });
  await person(w, L, "lena", "676767");
  check("auto-lock set to 1 minute (3 s here)", (await L.call("/api/wallet/settings", { autolock_minutes: 1 })).code === 200);
  const bg = async (path, body) => {          // as the page's bgApi: the same request, marked X-Background
    const headers = { "X-Session": L.session, "X-Background": "1" }, opt = { headers };
    if (body !== undefined) { opt.method = "POST"; headers["Content-Type"] = "application/json"; headers.Origin = L.base; opt.body = JSON.stringify(body); }
    const r = await fetch(L.base + path, opt); let d = {}; try { d = await r.json(); } catch {}
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: d };
  };
  const k = (await L.call("/api/messages/key")).d;
  const l = new CORE.Chat({ me: { secret: unhex(k.secret), public: k.public, name: k.name }, api: L.api, resolve: w.resolve, bgApi: bg });
  await l.loadStore(); await l.sync();
  const Y = MC.newKeyPair(), lt = MC.inboxTopic(L.id.publicKey);
  await w.control("inject/2", { topic: lt, payload: b64(fromKey(Y, "hi", null, L.id.publicKey)) });
  await until("a stranger's request", async () => { await l.sync(); return l.requests().length === 1; });
  await l.blockRequest(l.requests()[0].id);         // the user's doing: counts
  const t0 = Date.now(); let locked = false, i = 0;
  while (Date.now() - t0 < 12000 && !locked) {
    await w.control("inject/2", { topic: lt, payload: b64(fromKey(Y, "spam " + i++, null, L.id.publicKey)) });
    await sleep(700);
    try { await l.sync(); } catch (e) { if (e.status === 401) locked = true; }
    if ((await L.call("/api/messages/status")).code === 401) locked = true;
  }
  check(`a blocked stranger writing every 0.7 s (${i} messages, ${l.dropped().blocked} dropped) doesn't keep a visible page from auto-locking (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
    locked && l.dropped().blocked >= 2 && Date.now() - t0 < 8000);
  L.proc.kill();
}
// (c) a drop the server didn't take: the message still never shows, never starts a chat, and is dropped later
{
  const X2 = MC.newKeyPair(), x2 = hex(X2.publicKey), realApi = a.api, realBg = a.bgApi;
  await inject(fromKey(X2, "first"));
  await until("a request from X2", async () => { await a.sync(); return !!reqOf(x2); });
  await a.blockRequest(reqOf(x2).id);
  const failDrop = f => async (path, body) => path === "/api/messages/inbox/sort" && body && body.drop ? { ok: false, status: 0, data: {} } : f(path, body);
  a.api = failDrop(realApi); a.bgApi = failDrop(realBg);
  const unreadBefore = a.unreadTotal();
  await inject(fromKey(X2, "blocked, and the server is busy"));
  await until("the message from the blocked address arrives on the server", async () => (await serverItems()).some(i => !i.k && i.n > 0));
  await a.sync(); await a.sync();
  check("the server didn't take the drop: the message stays hidden, starts no chat, pins nothing, counts nowhere",
    !a.convo("k:" + x2) && !a.profile("k:" + x2) && !a.conversations().some(c => c.convo.members.some(m => m.key === x2)) && !reqOf(x2) && a.unreadTotal() === unreadBefore
    && (await serverItems()).some(i => !i.k));
  check("and the decision is kept (encrypted) until the server deletes it", (a.store.req.dropping || []).length >= 1);
  // only people I've written to, same thing
  await a.setOnlyKnown(true);
  const Q = MC.newKeyPair();
  await inject(fromKey(Q, "a stranger while the server is busy"));
  await until("it arrives", async () => (await serverItems()).filter(i => !i.k).length >= 2);
  await a.sync();
  check("'Only people I've written to' with the drop failing: no chat, nothing shown", !a.convo("k:" + hex(Q.publicKey)) && !a.conversations().some(c => c.convo.members.some(m => m.key === hex(Q.publicKey))));
  a.api = realApi; a.bgApi = realBg;
  const a3 = await chatOf(w, A);                  // a reload: the decision comes from the store, and the drop is retried
  check("after a reload the drop goes through: marked dropped on the server, nothing kept to retry, still no chat",
    !(await serverItems()).some(i => !i.k) && !(a3.store.req.dropping || []).length && !a3.convo("k:" + x2) && !a3.convo("k:" + hex(Q.publicKey)));
  await a3.setOnlyKnown(false); await a.loadStore();
}
// (d) while a contact's name is being read on chain, a stranger claiming that name shows nowhere yet
{
  const Z2 = MC.newKeyPair(), real = a.resolveRaw, unreadBefore = a.unreadTotal();
  let mid = null;
  a.chain.delete("bob");
  a.resolveRaw = async name => { if (name === "bob" && !mid) mid = { convs: a.conversations().map(c => c.convo.id), unread: a.unreadTotal() }; return real(name); };
  await inject(MC.sealMessage({ to: A.id.publicKey, from: "bob", fromSecret: Z2.secretKey, text: "bob here, new phone" }));
  await until("the claim is sorted", async () => { await a.sync(); return !!reqOf(hex(Z2.publicKey)); });
  a.resolveRaw = real;
  check("during the slow read it was in no chat, no 'Not verified' row and no unread count; then it is a request",
    mid && !mid.convs.includes("x:" + hex(Z2.publicKey)) && mid.unread === unreadBefore && !a.conversations().some(c => c.convo.id === "x:" + hex(Z2.publicKey)), mid);
}

// ---- 6. a store that didn't load, or can't be read, decides nothing; a chat message stays one; drops can be undone ----
{
  const P = await app(w, 8146 + PS, w.NODES[3], { MESSAGING_DROP_GRACE_SECONDS: "4" });
  await person(w, P, "pat", "787878");
  const pt = MC.inboxTopic(P.id.publicKey), items = async () => [...(await P.call("/api/messages/inbox")).d.items, ...(await P.call("/api/messages/inbox?dropped=1")).d.items];
  const p = await chatOf(w, P);
  await p.startDirect("bob");
  for (let i = 0; i < 6; i++) await w.control("inject/3", { topic: pt, payload: b64(MC.sealMessage({ to: P.id.publicKey, from: "bob", fromSecret: B.id.secretKey, text: "bob " + i })) });
  await until("bob's 6 messages, sorted as chat messages", async () => { await p.sync(); return (await items()).filter(i => i.k === "c").length === 6; });
  const fresh = (api) => { const k = { secret: unhex(hex(P.id.secretKey)), public: hex(P.id.publicKey), name: "pat" }; return new CORE.Chat({ me: k, api, resolve: w.resolve }); };
  // the store's first read fails (as when the server answers 500): the page used to go on with an empty store
  let failed = false;
  const q = fresh(async (path, body) => { if (path === "/api/messages/store" && body === undefined && !failed) { failed = true; return { ok: false, status: 500, data: {} }; } return P.api(path, body); });
  try { await q.loadStore(); } catch (e) {}
  await q.sync(); await q.sync();
  check("the store didn't load: nothing is sorted or dropped; bob's 6 messages are all still chat messages on the server",
    (await items()).filter(i => i.k === "c").length === 6 && !(await items()).some(i => i.k === "d") && q.requests().length === 0 && JSON.stringify(q.dropped()) === JSON.stringify({ blocked: 0, only: 0, caps: 0, age: 0 }));
  // a store that can't be opened (another messaging address's): the same
  const saved = (await P.call("/api/messages/store")).d;
  const other = CORE.encryptBlob(CORE.storeKey(MC.newKeyPair().secretKey), "store", { v: 1, profiles: {}, convos: {}, aliases: {} });
  check("(the store replaced by one this key can't open)", (await P.call("/api/messages/store", { rev: saved.rev, blob: other })).code === 200);
  const u = fresh(P.api);
  await u.loadStore(); await u.sync(); await u.sync();
  check("a store that can't be opened: nothing sorted, dropped or started; all 6 still chat messages", u.storeUnreadable && !u.storeOk
    && (await items()).filter(i => i.k === "c").length === 6 && !(await items()).some(i => i.k === "d") && u.requests().length === 0);
  // a store of another version (this key opens it, but it isn't version 1): the same
  const now = (await P.call("/api/messages/store")).d;
  await P.call("/api/messages/store", { rev: now.rev, blob: CORE.encryptBlob(CORE.storeKey(P.id.secretKey), "store", { v: 2, profiles: {}, convos: {}, aliases: {} }) });
  const u2 = fresh(P.api); await u2.loadStore(); await u2.sync();
  check("a store of another version: nothing sorted or dropped", u2.storeUnreadable && (await items()).filter(i => i.k === "c").length === 6 && !(await items()).some(i => i.k === "d"));
  // the page's api() answers status 0 when the app doesn't answer at all: the same as a failed load
  let gone = false;
  const u3 = fresh(async (path, body) => { if (path === "/api/messages/store" && body === undefined && !gone) { gone = true; return { ok: false, status: 0, data: { error: "The app on this device isn't answering." } }; } return P.api(path, body); });
  try { await u3.loadStore(); } catch (e) {}
  await u3.sync();
  check("a store read that got no answer (status 0): nothing sorted or dropped", !u3.storeOk && (await items()).filter(i => i.k === "c").length === 6 && !(await items()).some(i => i.k === "d"));
  // a store file that can't be read is an error, never an empty store, and isn't written over
  const now2 = (await P.call("/api/messages/store")).d;
  writeFileSync(join(P.data, "wallet-chat.json"), "{ this is not json");
  const bad = await P.call("/api/messages/store");
  const badW = await P.call("/api/messages/store", { rev: 0, blob: saved.blob });
  check("a store file that can't be read: the page gets an error (not an empty store), and a write doesn't replace the file",
    bad.code === 500 && bad.d.unreadable === true && badW.code === 500 && readFileSync(join(P.data, "wallet-chat.json"), "utf8") === "{ this is not json");
  const u4 = fresh(P.api); let threw = null;
  try { await u4.loadStore(); } catch (e) { threw = e; }
  await u4.sync();
  check("and the page sorts nothing from it", threw && threw.unreadable && !u4.storeOk && (await items()).filter(i => i.k === "c").length === 6);
  writeFileSync(join(P.data, "wallet-chat.json"), JSON.stringify({ rev: now2.rev, blob: now2.blob }));
  const now3 = (await P.call("/api/messages/store")).d;
  check("(the store back as it was)", (await P.call("/api/messages/store", { rev: now3.rev, blob: saved.blob })).code === 200);
  // a good store that lost bob (his chat and profile gone, the messages not deleted): they stay chat messages
  const v = fresh(P.api); await v.loadStore();
  await v.mutate(s => { delete s.convos["d:bob"]; delete s.profiles.bob; });
  await v.sync(); await v.sync();
  check("a chat message is never turned into a request or dropped, even when the page doesn't know the sender any more",
    (await items()).filter(i => i.k === "c").length === 6 && !(await items()).some(i => i.k !== "c") && v.requests().length === 0);
  // and the server refuses it too
  const n0 = (await items())[0].n;
  const rs = await P.call("/api/messages/inbox/sort", { drop: [n0], request: [(await items())[1].n] });
  check("the server won't turn a chat message into a drop or a request", rs.code === 200 && rs.d.refused === 2 && (await items()).filter(i => i.k === "c").length === 6);
  // two-phase: a drop is only marked; a dropped message from someone who turns out to be a contact comes back
  const X3 = MC.newKeyPair(), x3 = hex(X3.publicKey);
  await v.setOnlyKnown(true);
  await w.control("inject/3", { topic: pt, payload: b64(fromKey(X3, "dropped, then wanted", null, P.id.publicKey)) });
  await until("a stranger's message, dropped by 'Only people I've written to'", async () => { await v.sync(); return (await items()).some(i => i.k === "d"); });
  check("dropped: still on the server for now, marked, hidden", !v.conversations().some(c => c.convo.members.some(m => m.key === x3)));
  await v.setOnlyKnown(false);
  await v.startAddress(x3);
  await v.sync();
  check("within the grace period, once that address is a contact, the dropped message is back in its chat",
    v.messages("k:" + x3).some(m => m.text === "dropped, then wanted") && !(await items()).some(i => i.k === "d"));
  await v.setOnlyKnown(true);
  await w.control("inject/3", { topic: pt, payload: b64(fromKey(MC.newKeyPair(), "dropped for good", null, P.id.publicKey)) });
  await until("another stranger dropped", async () => { await v.sync(); return (await items()).some(i => i.k === "d"); });
  await until("after the grace period (4 s here) the server deletes it", async () => !(await items()).some(i => i.k === "d"), 15000);
  check("and only it: the chat messages are all there", (await items()).filter(i => i.k === "c").length === 7);
  P.proc.kill();
}

// ---- 7. more from the review ---------------------------------------------------------------------------
for (const r of [...a.requests()]) await a.deleteRequest(r.id);
// one key, two spellings: X25519 ignores the top bit, so a blocked key written with it set is still blocked
{
  const K = MC.newKeyPair(), kk = hex(K.publicKey);
  await inject(fromKey(K, "hi"));
  await until("a request from K", async () => { await a.sync(); return !!reqOf(kk); });
  await a.blockRequest(reqOf(kk).id);
  const alt = new Uint8Array(K.publicKey); alt[31] |= 0x80;
  const sealed = sealAs(A.id.publicKey, "msg-" + kk.slice(0, 16), K.secretKey, alt, "same key, other spelling");
  const o = MC.openMessage(A.id.secretKey, sealed);
  check("(the version 1 reader takes that spelling as proven)", o && o.authentic && o.fromKey === hex(alt));
  const b0 = a.dropped().blocked;
  await inject(sealed);
  await until("it is dropped as from the blocked key", async () => { await a.sync(); return a.dropped().blocked === b0 + 1; });
  check("and is no new request", !reqOf(kk) && !reqOf(hex(alt)) && !a.requests().some(r => r.key.slice(0, 62) === kk.slice(0, 62)));
}
// block wins over a chat with the same address
{
  const J = MC.newKeyPair(), jk = hex(J.publicKey);
  await inject(fromKey(J, "hello")); await until("a request from J", async () => { await a.sync(); return !!reqOf(jk); });
  await a.blockRequest(reqOf(jk).id);
  const jid = await a.startAddress(jk);
  const why = await a.sendBlocker(jid);
  err = null; try { await a.send(jid, "x"); } catch (e) { err = e; }
  check("a chat with a blocked address: nothing can be sent, and it says why", why && why.code === "blocked-key" && err && err.code === "blocked-key" && a.conversations().find(c => c.convo.id === jid).blocked);
  await inject(fromKey(J, "while blocked, in a chat"));
  await until("its message arrives", async () => { await a.sync(); return [...a.inbox.values()].some(m => m && m.text === "while blocked, in a chat"); });
  const n = [...a.inbox.values()].find(m => m && m.text === "while blocked, in a chat").n;
  check("hidden, kept (a chat message on the server), not dropped", !a.messages(jid).some(m => m.text === "while blocked, in a chat") && (await serverItems()).find(i => i.n === n).k === "c");
  await a.unblock({ kind: "key", key: jk }); await a.sortIncoming();
  check("unblocked: it shows, and sending works", a.messages(jid).some(m => m.text === "while blocked, in a chat") && (await a.sendBlocker(jid)) === null);
}
// a proven LNS name that looks like a contact's
{
  const L = ID.newIdentity();
  await w.register("b0b", { msg: hex(L.publicKey) });
  await inject(MC.sealMessage({ to: A.id.publicKey, from: "b0b", fromSecret: L.secretKey, text: "it's bob" }));
  await until("b0b's request", async () => { await a.sync(); return !!reqOf(hex(L.publicKey)); });
  await a.checkRequests();
  check("a proven name that reads like bob (in your chats) says it isn't him", reqOf(hex(L.publicKey)).proof === "name" && reqOf(hex(L.publicKey)).lookalike === "bob");
  check("and an unrelated name says nothing of the kind", a.lookalike("zelda") === null && a.lookalike("bob") === null && a.lookalike("8-0-b") === null && a.lookalike("b-ob") === "bob" && a.lookalike("bobb") === null);
}
// a message carrying a contact's key that doesn't prove it (the authenticity guard of fromContact)
{
  const bk = hex(B.id.publicKey);
  await inject(sealRaw(A.id.publicKey, { v: 1, from: "bob", fromKey: bk, text: "forged as bob", ts: Date.now(), auth: "0".repeat(64) }));
  await inject(sealRaw(A.id.publicKey, { v: 1, from: "msg-" + bk.slice(0, 16), fromKey: bk, text: "forged as bob's address", ts: Date.now(), auth: "0".repeat(64) }));
  await until("both arrive and are sorted", async () => { await a.sync(); return a.requests().some(r => !r.authentic && r.key === bk && r.list.length === 2); });
  check("a message with bob's key that doesn't prove it is never in bob's chat or any chat: a request that can't tell who sent it",
    !a.messages("d:bob").some(m => /forged/.test(m.text)) && !a.conversations().some(c => c.last && /forged/.test(c.last.text)) && a.requests().find(r => !r.authentic && r.key === bk).proof === "none");
}
// a real new LNS name isn't pushed out by 50 free keys, with Requests never opened
{
  for (const r of [...a.requests()]) await a.deleteRequest(r.id);
  a.lazy = { ...CORE.LAZY, FIRST: [0, 1], GAP: [0, 1] }; a.lazyAt = undefined;      // here no 1–5 minute waits
  const nora = ID.newIdentity();
  await w.register("nora", { msg: hex(nora.publicKey) });
  await inject(MC.sealMessage({ to: A.id.publicKey, from: "nora", fromSecret: nora.secretKey, text: "hi, it's nora" }));
  await until("nora's request, not read on chain yet", async () => { await a.sync(); const g = reqOf(hex(nora.publicKey)); return g && g.proof === "claim" && !g.chainRead; });
  const many = Array.from({ length: 50 }, () => MC.newKeyPair());
  for (let i = 0; i < many.length; i++) { await inject(fromKey(many[i], "free key " + i)); if (i % 20 === 19) { await sleep(700); await a.sync(); } }
  await until("the free keys are sorted, and nora's name is read on chain without Requests being opened", async () => {
    await a.sync(); const g = reqOf(hex(nora.publicKey));
    return !(await serverItems()).some(i => !i.k) && g && g.proof === "name" && a.requests().length === 50; }, 40000);
  check("nora (read on chain once the requests neared the cap, so a proven name) is kept; the oldest free key went", !!reqOf(hex(nora.publicKey)) && !reqOf(hex(many[0].publicKey)) && !!reqOf(hex(many[49].publicKey)));
  for (const r of [...a.requests()]) await a.deleteRequest(r.id);
}
// a backup: a message that was unsorted at backup time comes back unsorted and read, not as an unread chat message
{
  const T = mkdtempSync(join(tmpdir(), "restore-"));
  const one = b64(fromKey(MC.newKeyPair(), "unsorted at backup time")), two = b64(fromKey(MC.newKeyPair(), "a chat message"));
  const out = execFileSync("python3", ["-c", `import sys, json; sys.path.insert(0, sys.argv[1]); import server
server.chat_restore({"inbox": [{"payload": sys.argv[2], "received": "2026-11-13T10:00:00Z", "read": False, "k": ""},
                               {"payload": sys.argv[3], "received": "2026-11-13T10:01:00Z", "read": False, "k": "c"},
                               {"payload": sys.argv[4], "received": "2026-11-13T10:02:00Z", "read": True}]}, False)
print(json.dumps([[i.get("k"), i["read"]] for i in server.inbox["items"]]))`, join(ROOT, "app"), one, two, b64(fromKey(MC.newKeyPair(), "from an older backup"))],
    { env: { ...process.env, APP_DATA: T, WAKU_API: "http://127.0.0.1:1" } }).toString().trim();
  rmSync(T, { recursive: true, force: true });
  check("restored: the unsorted one unsorted and read, the chat message a chat message as it was, an older backup's as a chat message", JSON.stringify(JSON.parse(out)) === JSON.stringify([[null, true], ["c", false], ["c", true]]), out);
}

// ---- 8. from the second review ----------------------------------------------------------------------------
{
  const Q = await app(w, 8147 + PS, w.NODES[4]);
  await person(w, Q, "quinn", "989898");
  const qt = MC.inboxTopic(Q.id.publicKey), qitems = async (q = "") => (await Q.call("/api/messages/inbox" + q)).d.items;
  const qin = p => w.control("inject/4", { topic: qt, payload: b64(p) });
  const toQ = (kp, text, from = null) => MC.sealMessage({ to: Q.id.publicKey, from: from || "msg-" + hex(kp.publicKey).slice(0, 16), fromSecret: kp.secretKey, text });
  let calls = [];
  const counting = name => { calls.push(name); return w.resolve(name); };
  const mk = (extra = {}) => { const k = { secret: Q.id.secretKey, public: hex(Q.id.publicKey), name: "quinn" }; return new CORE.Chat({ me: k, api: Q.api, resolve: counting, ...extra }); };
  const q = mk({ lazy: { ...CORE.LAZY, PER_DAY: 3, FIRST: [0, 1], GAP: [0, 1] } });
  await q.loadStore(); await q.sync();
  // S1: claimed names count against the caps; reads of them are few a day, never right at unlock, once per name
  const claimers = Array.from({ length: 70 }, () => MC.newKeyPair());
  for (let i = 0; i < claimers.length; i++) { await qin(toQ(claimers[i], "hello", "unreg" + i)); if (i % 20 === 19) { await sleep(700); await q.sync(); } }
  await until("70 strangers claiming 70 unregistered names are sorted", async () => { await q.sync(); return !(await qitems()).some(i => !i.k); }, 20000);
  for (let i = 0; i < 6; i++) await q.sync();
  check("claimed names that weren't read count against the caps (only the oldest 10 are held unread): 60 requests, 10 dropped", q.requests().length === CORE.REQ.SENDERS + CORE.REQ.HOLD && q.dropped().caps === 10, [q.requests().length, q.dropped()]);
  check("names read in the background: at most 3 a day here (20 by default)", calls.length === 3 && new Set(calls).size === 3, calls);
  await q.checkRequests(100);
  const asked = calls.length;
  await q.checkRequests(100);
  check("opening Requests reads each name once, and never again (the answer is kept)", calls.length === asked && new Set(calls).size === calls.length, [asked, calls.length]);
  calls = [];
  const q2 = mk(); await q2.loadStore(); for (let i = 0; i < 3; i++) await q2.sync();
  check("a fresh page (an unlock) reads no claimed name at once: the first read waits a random 1–5 minutes", calls.length === 0 && q2.lazyAt > Date.now() + 50000, [calls.length, q2.lazyAt - Date.now()]);
  for (const r of [...q.requests()]) await q.deleteRequest(r.id);
  // S6: dropped messages aren't in the normal inbox read; a flood is opened 300 at a time
  check("the inbox read leaves dropped messages out; they come only when asked", !(await qitems()).some(i => i.k === "d") && (await qitems("?dropped=1")).length === q.dropped().caps && (await qitems("?dropped=1")).every(i => i.k === "d"),
    [(await qitems()).filter(i => i.k === "d").length, (await qitems("?dropped=1")).length, q.dropped()]);
  const fresh = mk(); await fresh.loadStore();
  await fresh.sync();
  check("a page opens at most 300 payloads in one sync", fresh.inbox.size <= CORE.OPEN_BUDGET, fresh.inbox.size);
  // S8: dropped messages that come back: the newest 3 of the sender, unread
  await q.setOnlyKnown(true);
  const X = MC.newKeyPair(), xk = hex(X.publicKey);
  const only0 = q.dropped().only;
  for (let i = 0; i < 6; i++) await qin(toQ(X, "dropped " + i));
  await until("6 messages from a stranger, dropped by 'Only people I've written to'", async () => { await q.sync(); return q.dropped().only - only0 === 6; });
  await q.setOnlyKnown(false);
  const xid = await q.startAddress(xk);
  const backTexts = q.messages(xid).map(m => m.text);
  check("starting a chat with them brings back their newest 3, not all 6", JSON.stringify(backTexts) === JSON.stringify(["dropped 3", "dropped 4", "dropped 5"]), backTexts);
  check("and they count as unread", q.messages(xid).every(m => q.unread.has(m.n)) && q.unreadTotal() >= 3);
  for (let i = 0; i < 3; i++) await q.sync();
  check("and only those 3: later syncs bring back no more (the rest stay dropped)", q.messages(xid).length === 3 && (await qitems("?dropped=1")).filter(i => q.inbox.get(i.n) && q.inbox.get(i.n).senderKey === xk).length === 3, q.messages(xid).length);
  // S5: a later Block cancels what is queued for them, and Retry respects it
  await w.control("down/4");
  await until("quinn's app sees the node off", async () => (await Q.call("/api/messages/status")).d.node.reachable === false, 8000);
  await q.send(xid, "queued while the node is off");
  await q.setProfile("k:" + xk, { blocked: true });
  await w.control("up/4");
  await sleep(2500); await q.sync();
  const qm = q.messages(xid).find(m => m.text === "queued while the node is off") || [...q.outbox.values()].find(m => m.text === "queued while the node is off");
  check("a message queued before the block is cancelled, and doesn't go when the node is back", qm && qm.sends[0].state === "cancelled" && !(await w.ctlGet("posts/4")).some(p => p[1] === MC.inboxTopic(X.publicKey)), qm && qm.sends);
  err = null; try { await q.retry(qm.n); } catch (e) { err = e; }
  check("Retry refuses while they are blocked", err && err.code === "blocked");
  await q.setProfile("k:" + xk, { blocked: false });
  // ... and when a checked contact's address changes
  const Y = ID.newIdentity();
  await w.register("yara", { msg: hex(Y.publicKey) });
  await q.startDirect("yara"); await q.markChecked("yara", hex(Y.publicKey));
  await w.control("down/4");
  await until("node off", async () => (await Q.call("/api/messages/status")).d.node.reachable === false, 8000);
  await q.send("d:yara", "queued for yara's checked address");
  await w.register("yara", { msg: hex(ID.newIdentity().publicKey) });
  await q.lookup("yara", true);
  check("the change is seen", (await q.sendBlocker("d:yara")).code === "changed-checked");
  await w.control("up/4"); await sleep(2500); await q.sync();
  const ym = [...q.outbox.values()].find(m => m.text === "queued for yara's checked address");
  check("what was queued for the checked address is cancelled once its change is seen", ym.sends[0].state === "cancelled");
  // S4: a user change whose save gets 409 and whose re-read can't be opened writes nothing
  const before = (await Q.call("/api/messages/store")).d;
  const other = CORE.encryptBlob(CORE.storeKey(MC.newKeyPair().secretKey), "store", { v: 1, profiles: {}, convos: {}, aliases: {} });
  await Q.call("/api/messages/store", { rev: before.rev, blob: other });
  err = null; try { await q.setProfile("d:yara".slice(2), { muted: true }); } catch (e) { err = e; }
  const after = (await Q.call("/api/messages/store")).d;
  check("a save that meets a store it can't open (after a 409) writes nothing and says so", err && err.code === "store" && after.blob === other, err && err.message);
  // S2: in that state every write waits for the user: Start fresh keeps the old store aside
  const u = mk(); await u.loadStore();
  err = null; try { await u.startAddress(hex(MC.newKeyPair().publicKey)); } catch (e) { err = e; }
  check("a store this key can't open: even the user's own Start chat writes nothing", u.storeUnreadable && err && err.code === "store" && (await Q.call("/api/messages/store")).d.blob === other);
  await u.startFresh();
  const aside = readdirSync(Q.data).filter(f => f.startsWith("wallet-chat.json.aside-"));
  check("Start fresh: an empty store this key opens; the old one kept aside, not deleted", u.storeOk && !u.storeUnreadable && aside.length === 1
    && JSON.parse(readFileSync(join(Q.data, aside[0]), "utf8")).blob === other);
  // S3: a store file that can't be read: the last good copy can be put back, and a backup says it has no chats
  await u.setProfile("k:" + xk, { nickname: "kept in the last copy" });
  await u.setProfile("k:" + xk, { note: "and this" });
  check("(each save keeps the copy it replaces)", existsSync(join(Q.data, "wallet-chat.json.prev")));
  writeFileSync(join(Q.data, "wallet-chat.json"), "");
  const gbad = await Q.call("/api/messages/store");
  check("an empty (unreadable) store file: an error that offers the last copy", gbad.code === 500 && gbad.d.unreadable && gbad.d.prev === true);
  const bk = await Q.call("/api/wallet/backup", { password: "a long backup password", pin: Q.pin });
  check("a backup made now says it carries no chats", bk.code === 200 && bk.d.chats_missing === true, bk.code);
  const up = await Q.call("/api/messages/store/use-prev", {});
  const v = mk(); await v.loadStore();
  check("Use the last saved copy: the store opens again, with what it held; the bad file kept aside",
    up.code === 200 && v.storeOk && v.profile("k:" + xk).nickname === "kept in the last copy" && readdirSync(Q.data).some(f => f.startsWith("wallet-chat.json.unreadable-")));
  Q.proc.kill();
}
{
  // S7 and S9 with a small ring (4): what is counted lost, and who goes first
  const R = await app(w, 8148 + PS, w.NODES[2], { MESSAGING_PENDING_MAX: "4" });
  await person(w, R, "rhea", "121234");
  const rt = MC.inboxTopic(R.id.publicKey), ritems = async () => (await R.call("/api/messages/inbox")).d.items, lost = async () => (await R.call("/api/messages/status")).d.lost.count;
  const rin = p => w.control("inject/2", { topic: rt, payload: b64(p) });
  const k = (await R.call("/api/messages/key")).d;
  const rc = new CORE.Chat({ me: { secret: unhex(k.secret), public: k.public, name: k.name }, api: R.api, resolve: w.resolve });
  await rc.loadStore(); await rc.sync();
  const named = ID.newIdentity(); await w.register("ruth", { msg: hex(named.publicKey) });
  await rin(MC.sealMessage({ to: R.id.publicKey, from: "ruth", fromSecret: named.secretKey, text: "ruth here" }));
  const opened = MC.newKeyPair(), plain = MC.newKeyPair();
  await rin(MC.sealMessage({ to: R.id.publicKey, from: "msg-" + hex(opened.publicKey).slice(0, 16), fromSecret: opened.secretKey, text: "opened" }));
  await rin(MC.sealMessage({ to: R.id.publicKey, from: "msg-" + hex(plain.publicKey).slice(0, 16), fromSecret: plain.secretKey, text: "not opened" }));
  await until("three requests", async () => { await rc.sync(); return rc.requests().length === 3; });
  await rc.checkRequests();
  await rc.markOpened(rc.requests().find(g => g.key === hex(opened.publicKey)).id);
  await rc.sync();
  check("ruth (a proven name) and the request the user opened are marked to keep", (await ritems()).filter(i => i.keep).length === 2);
  const l0 = await lost();
  for (let i = 0; i < 3; i++) { const j = crypto.getRandomValues(new Uint8Array(80)); j[0] = 9; await rin(j); }   // junk that can't be a message
  await until("the junk arrives", async () => (await ritems()).some(i => Buffer.from(i.payload, "base64").length === 80));
  await sleep(800);
  const left = await ritems();
  check("the ring made room from the request nobody opened first, then unsorted ones; ruth's and the opened one stay",
    !left.some(i => i.k === "r" && !i.keep) && left.filter(i => i.keep).length === 2, left.map(i => (i.k || "-") + (i.keep ? "K" : "")));
  check("junk that can't be a message isn't counted as lost (the request it pushed out is)", (await lost()) - l0 === 1, [(await lost()) - l0]);
  R.proc.kill();
}

// ---- 9. from the third review ------------------------------------------------------------------------------
{
  const M = await app(w, 8149 + PS, w.NODES[3], { MESSAGING_DROP_GRACE_SECONDS: "3600" });
  await person(w, M, "mona", "343456");
  const mt = MC.inboxTopic(M.id.publicKey), mitems = async (q = "") => (await M.call("/api/messages/inbox" + q)).d.items;
  const min = p => w.control("inject/3", { topic: mt, payload: b64(p) });
  const toM = (kp, text, from = null) => MC.sealMessage({ to: M.id.publicKey, from: from || "msg-" + hex(kp.publicKey).slice(0, 16), fromSecret: kp.secretKey, text });
  const kM = (await M.call("/api/messages/key")).d;
  const mk = (extra = {}) => new CORE.Chat({ me: { secret: unhex(kM.secret), public: kM.public, name: kM.name }, api: M.api, resolve: w.resolve, ...extra });
  const m1 = mk(); await m1.loadStore(); await m1.sync();
  await m1.startDirect("bob");
  // MF-C1: more than 300 stored chat messages all show at the first sync after an unlock
  for (let i = 0; i < 400; i++) { await min(MC.sealMessage({ to: M.id.publicKey, from: "bob", fromSecret: B.id.secretKey, text: "bob " + i })); if (i % 40 === 39) { await sleep(700); await m1.sync(); } }
  await until("400 chat messages from bob, stored as chat messages", async () => { await m1.sync(); return (await mitems()).filter(i => i.k === "c").length === 400; }, 30000);
  const m2 = mk(); await m2.loadStore(); await m2.sync();
  const shown = m2.messages("d:bob");
  check("after an unlock, one sync shows all 400 stored chat messages, the newest included (only unsorted ones count against the 300)",
    shown.length === 400 && shown[shown.length - 1].text === "bob 399", [shown.length, shown.length && shown[shown.length - 1].text]);
  await m2.deleteConversation("d:bob", false);
  await m2.sync(); await m2.sync();
  check("a chat deleted right after an unlock stays deleted", !m2.convo("d:bob") && m2.messages("d:bob").length === 0 && !(await mitems()).some(i => i.k === "c"));
  // SF-4: with the shipped waits, a burst of 50 free keys drops neither a real name nor a request the user opened
  const nell = ID.newIdentity(); await w.register("nell", { msg: hex(nell.publicKey) });
  const opened = MC.newKeyPair();
  await min(MC.sealMessage({ to: M.id.publicKey, from: "nell", fromSecret: nell.secretKey, text: "nell here" }));
  await min(toM(opened, "the one you opened"));
  await until("two requests", async () => { await m2.sync(); return m2.requests().length === 2; });
  await m2.markOpened(m2.requests().find(g => g.key === hex(opened.publicKey)).id);
  const burst = Array.from({ length: 50 }, () => MC.newKeyPair());
  for (let i = 0; i < burst.length; i++) await min(toM(burst[i], "burst " + i));
  await until("the burst is sorted", async () => { await m2.sync(); return !(await mitems()).some(i => !i.k) && m2.requests().some(g => g.key === hex(burst[49].publicKey)); }, 20000);
  const keys = new Set(m2.requests().map(g => g.key));
  check("a burst of 50 free keys (nothing read on chain, the shipped 1–5 minute wait) drops neither nell's request nor the one the user opened",
    keys.has(hex(nell.publicKey)) && keys.has(hex(opened.publicKey)) && m2.requests().length <= CORE.REQ.SENDERS + CORE.REQ.HOLD, [keys.has(hex(nell.publicKey)), keys.has(hex(opened.publicKey)), m2.requests().length]);
  for (const r of [...m2.requests()]) await m2.deleteRequest(r.id);
  // SF-5: a claimed name read once while unregistered can still be proven by its real owner later
  const squat = MC.newKeyPair();
  await min(toM(squat, "it's zed", "zed5"));
  await until("a claim of zed5", async () => { await m2.sync(); return m2.requests().some(g => g.claimed === "zed5"); });
  await m2.checkRequests();
  check("(read while unregistered: a claim, read)", m2.requests().find(g => g.claimed === "zed5").chainRead);
  await m2.deleteRequest(m2.requests().find(g => g.claimed === "zed5").id);
  const zed = ID.newIdentity(); await w.register("zed5", { msg: hex(zed.publicKey) });
  await min(MC.sealMessage({ to: M.id.publicKey, from: "zed5", fromSecret: zed.secretKey, text: "the real zed" }));
  const m3 = mk(); await m3.loadStore();
  await until("the real zed5 writes", async () => { await m3.sync(); return m3.requests().some(g => g.key === hex(zed.publicKey)); });
  const zr = m3.requests().find(g => g.key === hex(zed.publicKey));
  check("(at first it shows as the earlier answer said: not proven)", zr.proof === "claim" && zr.chainRead);
  check("opening it reads the name again: the real zed5 is proven", await m3.recheck(zr.id) && m3.requests().find(g => g.key === hex(zed.publicKey)).proof === "name");
  await m3.mutate(s => { s.req.names.zed5.at = Date.now() - 2 * 864e5; }, true);
  m3.chain.delete("zed5"); await m3.sortIncoming();
  check("an answer older than a day counts as not read", !m3.requests().find(g => g.key === hex(zed.publicKey)).chainRead);
  for (const r of [...m3.requests()]) await m3.deleteRequest(r.id);
  // SF-1/SF-2: a sender's drops behind 300 others come back in a later session, and only their newest 3, once
  await m3.setOnlyKnown(true);
  const X4 = MC.newKeyPair(), x4 = hex(X4.publicKey);
  for (let i = 0; i < 5; i++) await min(toM(X4, "x4 " + i));
  for (let i = 0; i < 310; i++) { await min(toM(MC.newKeyPair(), "noise " + i)); if (i % 40 === 39) { await sleep(700); await m3.sync(); } }
  await until("all dropped", async () => { await m3.sync(); return !(await mitems()).some(i => !i.k) && (await mitems("?dropped=1")).length >= 315; }, 40000);
  await m3.setOnlyKnown(false);
  const m4 = mk(); await m4.loadStore(); await m4.sync();
  const x4id = await m4.startAddress(x4);
  for (let i = 0; i < 3; i++) await m4.sync();
  check("in a later session, starting a chat with someone whose drops sit behind 310 others brings back their newest 3, and no more",
    JSON.stringify(m4.messages(x4id).map(m => m.text)) === JSON.stringify(["x4 2", "x4 3", "x4 4"]), m4.messages(x4id).map(m => m.text));
  // SF-3: something queued for a checked contact is cancelled when their address changes, with their chat closed
  const zoe = ID.newIdentity(); await w.register("zoe", { msg: hex(zoe.publicKey) });
  await m4.startDirect("zoe"); await m4.markChecked("zoe", hex(zoe.publicKey));
  await w.control("down/3");
  await until("node off", async () => (await M.call("/api/messages/status")).d.node.reachable === false, 8000);
  await m4.send("d:zoe", "queued for zoe");
  await w.register("zoe", { msg: hex(ID.newIdentity().publicKey) });
  const t0 = Date.now();
  while (Date.now() - t0 < 17000) { await m4.sync(); await sleep(1000); }       // only syncs: the chat isn't opened
  await w.control("up/3"); await sleep(2500); await m4.sync();
  const zq = [...m4.outbox.values()].find(m => m.text === "queued for zoe");
  check("queued for a checked contact whose address changed: cancelled by the background read, the chat never opened, nothing posted",
    zq.sends[0].state === "cancelled" && !(await w.ctlGet("posts/3")).some(p => p[1] === MC.inboxTopic(zoe.publicKey)), zq.sends);
  // SF-6: Start fresh only for the store the page saw; two at once keep the real store aside
  await m4.setProfile("d:zoe".slice(2), { nickname: "zoe the first" });
  const st = (await M.call("/api/messages/store")).d;
  const [f1, f2] = await Promise.all([M.call("/api/messages/store/fresh", { rev: st.rev }), M.call("/api/messages/store/fresh", { rev: st.rev })]);
  const asides = readdirSync(M.data).filter(f => f.startsWith("wallet-chat.json.aside-"));
  check("two Start fresh for the same store: one goes, the other is refused, and the store set aside is the real one",
    [f1.code, f2.code].sort().join() === "200,409" && asides.length === 1 && JSON.parse(readFileSync(join(M.data, asides[0]), "utf8")).blob === st.blob, [f1.code, f2.code, asides.length]);
  check("Use the last saved copy is refused while the store can be read", (await M.call("/api/messages/store/use-prev", {})).code === 409);
  // SF-7: the page whose store was set aside under it writes nothing onto the new one
  err = null; try { await m4.mutate(s => { s.ui = Object.assign({}, s.ui, { x: 1 }); }, true); } catch (e) { err = e; }
  check("a page whose saved chats were set aside elsewhere refuses to write onto the new empty store, and asks to be built again",
    err && err.code === "store-changed" && m4.stale && (await M.call("/api/messages/store")).d.blob === null, err && err.code);
  M.proc.kill();
}
{
  // SF-8: the inbox file: the last copy is used when it can't be read; with none, it is kept aside, never written over
  const N = await app(w, 8150 + PS, w.NODES[2]);
  await person(w, N, "nina2", "565612");
  const nk = (await N.call("/api/messages/key")).d, nt = MC.inboxTopic(N.id.publicKey);
  const n1 = new CORE.Chat({ me: { secret: unhex(nk.secret), public: nk.public, name: nk.name }, api: N.api, resolve: w.resolve });
  await n1.loadStore(); await n1.sync(); await n1.startDirect("bob");
  for (const t of ["one", "two"]) { await w.control("inject/2", { topic: nt, payload: b64(MC.sealMessage({ to: N.id.publicKey, from: "bob", fromSecret: B.id.secretKey, text: t })) }); await sleep(900); await n1.sync(); }
  check("(the inbox keeps the copy each write replaces)", existsSync(join(N.data, "wallet-inbox.json.prev")));
  writeFileSync(join(N.data, "wallet-inbox.json"), "");
  const N2 = await restart(w, N);
  const items = (await N2.call("/api/messages/inbox")).d;
  check("an inbox file cut to nothing: the last copy is used, the bad file kept aside, numbers go on above the old ones",
    items.items.length >= 1 && items.next > 1e9 && readdirSync(N.data).some(f => f.startsWith("wallet-inbox.json.unreadable-")), [items.items.length, items.next]);
  N2.proc.kill();
}
{
  // T-1: the ring's order, with an unsorted message older than a request nobody opened
  const T = await app(w, 8151 + PS, w.NODES[2], { MESSAGING_PENDING_MAX: "3" });
  T.pin = "777111"; T.session = (await T.call("/api/wallet/setup", { pin: T.pin })).d.session;
  const tk = ID.newIdentity();
  await T.call("/api/messages/key", { seed: hex(tk.seed), secret: hex(tk.secretKey), public: hex(tk.publicKey) });
  const pl = () => b64(MC.sealMessage({ to: tk.publicKey, from: "msg-" + "0".repeat(16), fromSecret: MC.newKeyPair().secretKey, text: "x" }));
  writeFileSync(join(T.data, "wallet-inbox.json"), JSON.stringify({ version: 1, next: 4, sort_from: 1, seen: [], items: [
    { n: 1, payload: pl(), received: "2026-11-13T10:00:00Z", read: false },                       // unsorted, oldest
    { n: 2, payload: pl(), received: "2026-11-13T10:01:00Z", read: true, k: "r" },                // a request nobody opened
    { n: 3, payload: pl(), received: "2026-11-13T10:02:00Z", read: true, k: "r", keep: true }] }));   // one the user opened
  T.id = tk;
  const T2 = await restart(w, T);
  await w.control("inject/2", { topic: MC.inboxTopic(tk.publicKey), payload: pl() });
  await until("the new one is in", async () => (await T2.call("/api/messages/inbox")).d.items.some(i => i.n === 4));
  const ns = (await T2.call("/api/messages/inbox")).d.items.map(i => i.n).sort().join();
  check("the ring made room from the request nobody opened, not the older unsorted message, nor the opened request", ns === "1,3,4", ns);
  T2.proc.kill();
}

// ---- 10. from the fourth review ------------------------------------------------------------------------------
const pyIn = (data, code, ...args) => execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import server\n" + code, join(ROOT, "app"), ...args],
  { env: { ...process.env, APP_DATA: data, WAKU_API: "http://127.0.0.1:1" } }).toString().trim();
{
  // MF-D1: with hard links refused (as on Android), Start fresh, the last copy and a restore with another key work
  const L = await app(w, 8152 + PS, w.NODES[3], { REAL_SERVER_PY: join(ROOT, "app", "server.py") }, null, join(ROOT, "tests", "nolink_server.py"));
  await person(w, L, "lino", "454545");
  const lk = (await L.call("/api/messages/key")).d;
  const lc = new CORE.Chat({ me: { secret: unhex(lk.secret), public: lk.public, name: lk.name }, api: L.api, resolve: w.resolve });
  await lc.loadStore(); await lc.sync();
  await lc.startDirect("bob"); await lc.setProfile("bob", { nickname: "b1" }); await lc.setProfile("bob", { nickname: "b2" });
  const st = (await L.call("/api/messages/store")).d;
  writeFileSync(join(L.data, "wallet-chat.json"), "");
  const up = await L.call("/api/messages/store/use-prev", {});
  check("hard links refused: Use the last saved copy works", up.code === 200 && (await L.call("/api/messages/store")).code === 200, up);
  const st2 = (await L.call("/api/messages/store")).d;
  const fr = await L.call("/api/messages/store/fresh", { rev: st2.rev });
  check("hard links refused: Start fresh works, the old store kept aside", fr.code === 200 && readdirSync(L.data).some(f => f.startsWith("wallet-chat.json.aside-")), fr);
  // a backup from a phone with another messaging key and no saved chats, restored here
  const G = await app(w, 8153 + PS, w.NODES[4]);
  await person(w, G, "gabe", "676734");
  const bk = (await G.call("/api/wallet/backup", { password: "another long password", pin: G.pin })).d.backup;
  G.proc.kill();
  const L2c = new CORE.Chat({ me: { secret: unhex(lk.secret), public: lk.public, name: lk.name }, api: L.api, resolve: w.resolve });
  await L2c.loadStore(); await L2c.startDirect("bob");            // saved chats under lino's key again
  const rs = await L.call("/api/wallet/restore", { backup: bk, password: "another long password", pin: L.pin });
  const nk = JSON.parse(readFileSync(join(L.data, "wallet-msgkey.json"), "utf8"));
  check("hard links refused: a restore with another messaging key answers, puts the key in, and sets lino's saved chats aside",
    rs.code === 200 && rs.d.messaging_key_restored && nk.public === hex(G.id.publicKey) && readdirSync(L.data).some(f => f.startsWith("wallet-chat.json.other-key-")), [rs.code, rs.d]);
  L.session = (await L.call("/api/wallet/unlock", { pin: L.pin })).d.session;
  const gc = new CORE.Chat({ me: { secret: unhex(nk.secret), public: nk.public, name: "" }, api: L.api, resolve: w.resolve });
  await gc.loadStore();
  check("and the new key's page opens its saved chats (empty, its own)", gc.storeOk && !gc.storeUnreadable);
  L.proc.kill();
}
{
  // MF-D1: the restore puts the store back when the key can't be put in place
  const T = mkdtempSync(join(tmpdir(), "rk-"));
  const out = pyIn(T, `import json, os
a = {"secret": "11" * 32, "public": "22" * 32}
server.msg_key_load = lambda: a
json.dump({"rev": 5, "blob": "QUJD"}, open(server.STORE_FILE, "w"))
def boom(d): raise OSError("disk full")
server.msg_key_restore = boom
try:
    server.msg_key_restore_with_store({"secret": "33" * 32, "public": "44" * 32}, None); print("no error")
except Exception as e:
    print(json.dumps(json.load(open(server.STORE_FILE))), len([f for f in os.listdir(os.path.dirname(server.STORE_FILE)) if ".other-key-" in f]))`);
  rmSync(T, { recursive: true, force: true });
  check("a restore whose key can't be put in place puts the saved chats back (no swapped key beside a store it can't open)", out === '{"rev": 5, "blob": "QUJD"} 0', out);
  // T-2: names of files set aside are unique, even twice in one second
  const T2 = mkdtempSync(join(tmpdir(), "as-"));
  const out2 = pyIn(T2, `import json, os
json.dump({"rev": 1, "blob": "QQ=="}, open(server.STORE_FILE, "w"))
server.store_aside("aside"); json.dump({"rev": 2, "blob": "Qg=="}, open(server.STORE_FILE, "w")); server.store_aside("aside")
print(sorted(json.load(open(os.path.join(os.path.dirname(server.STORE_FILE), f)))["blob"] for f in os.listdir(os.path.dirname(server.STORE_FILE)) if ".aside-" in f))`);
  rmSync(T2, { recursive: true, force: true });
  check("two set asides in the same second keep both stores, under names of their own", out2 === "['QQ==', 'Qg==']", out2);
}
{
  const V = await app(w, 8154 + PS, w.NODES[3], { MESSAGING_DROP_GRACE_SECONDS: "3600" });
  await person(w, V, "vera", "898923");
  const vt = MC.inboxTopic(V.id.publicKey), vitems = async (q = "") => (await V.call("/api/messages/inbox" + q)).d.items;
  const vin = p => w.control("inject/3", { topic: vt, payload: b64(p) });
  const toV = (kp, text, from = null) => MC.sealMessage({ to: V.id.publicKey, from: from || "msg-" + hex(kp.publicKey).slice(0, 16), fromSecret: kp.secretKey, text });
  const kV = (await V.call("/api/messages/key")).d;
  const mk = (extra = {}) => new CORE.Chat({ me: { secret: unhex(kV.secret), public: kV.public, name: kV.name }, api: V.api, resolve: w.resolve, ...extra });
  // SF-D2: a page that started with no saved chats, then saved some, refuses to write onto a store set aside under it
  const v1 = mk(); await v1.loadStore(); await v1.sync();
  check("(a page that started with no saved chats)", !v1.hadBlob);
  await v1.startDirect("bob");
  const vs = (await V.call("/api/messages/store")).d;
  await V.call("/api/messages/store/fresh", { rev: vs.rev });
  err = null; try { await v1.mutate(s => { s.ui = Object.assign({}, s.ui, { y: 1 }); }, true); } catch (e) { err = e; }
  check("a page that began empty and saved chats since refuses to write onto the store set aside under it", err && err.code === "store-changed" && (await V.call("/api/messages/store")).d.blob === null, err && err.code);
  // SF-D1: 10 junk claims sent first can't keep a real new name out of the hold
  let v2 = mk(); await v2.loadStore(); await v2.sync();
  for (let i = 0; i < 10; i++) await vin(toV(MC.newKeyPair(), "junk claim", "junkname" + i));
  await until("10 junk claims", async () => { await v2.sync(); return v2.requests().length === 10; });
  const nell = ID.newIdentity(); await w.register("nellv", { msg: hex(nell.publicKey) });
  await vin(MC.sealMessage({ to: V.id.publicKey, from: "nellv", fromSecret: nell.secretKey, text: "nell here" }));
  await until("nell's request", async () => { await v2.sync(); return v2.requests().some(g => g.claimed === "nellv"); });
  for (let i = 0; i < 50; i++) { await vin(toV(MC.newKeyPair(), "free " + i)); if (i % 20 === 19) { await sleep(700); await v2.sync(); } }
  await until("the burst is sorted", async () => { await v2.sync(); return !(await vitems()).some(i => !i.k) && v2.requests().length >= 55; }, 20000);
  check("10 junk claims sent first, then a real new name, then 50 free keys (the shipped waits): the real name is still held", v2.requests().some(g => g.claimed === "nellv"));
  // ... and junk read once, its answers expired, doesn't come back into the hold
  await v2.checkRequests(100);
  await v2.mutate(s => { for (const k of Object.keys(s.req.names)) s.req.names[k].at = 0; }, true);
  for (const r of [...v2.requests()]) if (r.claimed !== "nellv") await v2.deleteRequest(r.id);
  const v2old = v2; v2 = mk(); await v2.loadStore(); await v2.sync();   // a new session: no answer from this one in memory
  for (let i = 0; i < 10; i++) await vin(toV(MC.newKeyPair(), "junk again", "junkname" + i));
  const nora = ID.newIdentity(); await w.register("norav", { msg: hex(nora.publicKey) });
  await vin(MC.sealMessage({ to: V.id.publicKey, from: "norav", fromSecret: nora.secretKey, text: "nora here" }));
  await until("nora's request (after the junk)", async () => { await v2.sync(); return v2.requests().some(g => g.claimed === "norav") && v2.requests().filter(g => /^junkname/.test(g.claimed || "")).length === 10; });
  for (let i = 0; i < 55; i++) { await vin(toV(MC.newKeyPair(), "free again " + i)); if (i % 20 === 19) { await sleep(700); await v2.sync(); } }
  await until("sorted again", async () => { await v2.sync(); return !(await vitems()).some(i => !i.k) && v2.requests().some(g => g.list[0].text === "free again 54"); }, 20000);
  check("junk names read once, answers expired, claimed again (in a new session): the new real name is still held", v2.requests().some(g => g.claimed === "norav"));
  for (const r of [...v2.requests()]) await v2.deleteRequest(r.id);
  // T-2: a sender's drops behind more than 300 others come back (loadDropped reads every page)
  await v2.setOnlyKnown(true);
  for (let i = 0; i < 305; i++) { await vin(toV(MC.newKeyPair(), "noise " + i)); if (i % 40 === 39) { await sleep(700); await v2.sync(); } }
  const X5 = MC.newKeyPair();
  for (let i = 0; i < 3; i++) await vin(toV(X5, "x5 " + i));
  const x5k = hex(X5.publicKey);
  await until("all dropped, X5's 3 last", async () => { await v2.sync(); return !(await vitems()).some(i => !i.k)
    && [...v2.inbox.values()].filter(m => m && m.senderKey === x5k && v2.tags.get(m.n) === "d").length === 3; }, 60000);
  check("(X5's drops sit behind more than 300 others)", (await vitems("?dropped=1")).filter(i => i.n < Math.min(...[...v2.inbox.values()].filter(m => m && m.senderKey === x5k).map(m => m.n))).length > 300);
  await v2.setOnlyKnown(false);
  const v3 = mk(); await v3.loadStore(); await v3.sync();
  const x5id = await v3.startAddress(hex(X5.publicKey));
  check("drops sent after 305 others come back in a later session (every page of dropped messages is read)", v3.messages(x5id).length === 3, v3.messages(x5id).length);
  // SF-D3: the guard cancels nothing on "not registered", and the inbox read doesn't wait for it
  const zoe = ID.newIdentity(); await w.register("zoev", { msg: hex(zoe.publicKey) });
  await v3.startDirect("zoev"); await v3.markChecked("zoev", hex(zoe.publicKey));
  await w.control("down/3");
  await until("node off", async () => (await V.call("/api/messages/status")).d.node.reachable === false, 8000);
  await v3.send("d:zoev", "queued for zoe");
  const real = v3.resolveRaw; let slowReads = 0;
  v3.resolveRaw = async (name) => { if (name === "zoev") { slowReads++; await sleep(3000); return null; } return real(name); };   // a slow "not registered"
  while (v3.guarding) await v3.guarding;          // a guard from the send's own sync ends first
  v3.guarded.clear();
  const t1 = Date.now(); await v3.sync(); const took = Date.now() - t1;
  check("(the sync started a guard that reads zoe)", !!v3.guarding);
  while (v3.guarding) await v3.guarding;          // and this guard read the slow answer to its end
  await v3.sync();
  const zq = [...v3.outbox.values()].find(m => m.text === "queued for zoe");
  check("a slow \"not registered\" answer: the inbox read doesn't wait for it, and once read to its end it cancels nothing",
    took < 2000 && slowReads >= 1 && zq.sends[0].state === "queued", [took, slowReads, zq.sends[0].state]);
  // T-2: a cancel that didn't go through is tried again
  v3.resolveRaw = real;
  await w.register("zoev", { msg: hex(ID.newIdentity().publicKey) });
  const realBg = v3.bgApi; let refused = 0;
  v3.bgApi = async (path, body) => { if (path === "/api/messages/outbox/cancel" && refused < 1) { refused++; return { ok: false, status: 0, data: {} }; } return realBg(path, body); };
  await v3.lookup("zoev", true);
  await v3.sendBlocker("d:zoev", false, true);
  check("(the first cancel didn't go through, so it isn't counted)", refused === 1 && !v3.cancelledFor.has(hex(zoe.publicKey)));
  await v3.sendBlocker("d:zoev", false, true);
  v3.bgApi = realBg;
  await v3.sync();
  check("the cancel is tried again, and then counts", v3.cancelledFor.has(hex(zoe.publicKey)) && [...v3.outbox.values()].find(m => m.text === "queued for zoe").sends[0].state === "cancelled");
  await w.control("up/3");
  V.proc.kill();
}
{
  // SF-D4: an inbox that can't be read, with no good last copy: numbers go on above the old ones after a restart
  const U = await app(w, 8155 + PS, w.NODES[2]);
  await person(w, U, "ursa", "232378");
  const ut = MC.inboxTopic(U.id.publicKey);
  for (let i = 0; i < 3; i++) await w.control("inject/2", { topic: ut, payload: b64(MC.sealMessage({ to: U.id.publicKey, from: "bob", fromSecret: B.id.secretKey, text: "u" + i })) });
  await until("3 in", async () => (await U.call("/api/messages/inbox")).d.items.length === 3);
  writeFileSync(join(U.data, "wallet-inbox.json"), "not json");
  rmSync(join(U.data, "wallet-inbox.json.prev"), { force: true });
  const U2 = await restart(w, U);
  const d = (await U2.call("/api/messages/inbox")).d;
  check("an unreadable inbox with no good copy: after a restart the numbers go on above the old ones, never from 1", d.next > 1e9 && d.sort_from > 1e9, [d.next, d.sort_from]);
  U2.proc.kill();
}

// ---- 11. from the fifth review ------------------------------------------------------------------------------
{
  // SF-E1: on a full disk, setting the saved chats aside (Start fresh, a restore with another key) and Use the
  // last copy change nothing: the new file is written before the old one moves
  const T = mkdtempSync(join(tmpdir(), "full-"));
  const out = pyIn(T, `import json, os, errno
d = os.path.dirname(server.STORE_FILE)
assert hasattr(server, "msg_key_restore_with_store") and hasattr(server, "store_replace_keeping_aside")
real_tmp = server._fsync_tmp
def full(path, data):
    raise OSError(errno.ENOSPC, "No space left on device")
res = []
# 1. Start fresh (store_aside) on a full disk
json.dump({"rev": 3, "blob": "QUJD"}, open(server.STORE_FILE, "w"))
server._fsync_tmp = full
try: server.store_aside("aside"); res.append("no error")
except OSError: res.append("refused")
res.append(json.load(open(server.STORE_FILE))["blob"]); res.append(len([f for f in os.listdir(d) if ".aside-" in f]))
# 2. a restore with another key and no saved chats, on a full disk: the key isn't changed, the chats stay
calls = []
server.msg_key_load = lambda: {"secret": "11" * 32, "public": "22" * 32}
server.msg_key_restore = lambda k: calls.append(1) or True
try: server.msg_key_restore_with_store({"secret": "33" * 32, "public": "44" * 32}, None); res.append("no error")
except server.MsgKeyNotRestored: res.append("not restored")
res.append(len(calls)); res.append(json.load(open(server.STORE_FILE))["blob"]); res.append(len([f for f in os.listdir(d) if ".other-key-" in f]))
# 3. the key write fails after the chats were set aside: they are put back
server._fsync_tmp = real_tmp
def boom(k): raise OSError(errno.ENOSPC, "No space left on device")
server.msg_key_restore = boom
try: server.msg_key_restore_with_store({"secret": "33" * 32, "public": "44" * 32}, None); res.append("no error")
except server.MsgKeyNotRestored: res.append("not restored")
res.append(json.load(open(server.STORE_FILE))["blob"]); res.append(len([f for f in os.listdir(d) if ".other-key-" in f]))
# 4. Use the last copy on a full disk: the bad file stays where it is, and so does .prev, the only good copy
open(server.STORE_FILE, "w").write("garbage")
json.dump({"rev": 2, "blob": "R09PRA=="}, open(server.STORE_FILE + ".prev", "w"))
server._fsync_tmp = full
try: server.store_replace_keeping_aside("unreadable", "R09PRA=="); res.append("no error")
except OSError: res.append("refused")
res.append(open(server.STORE_FILE).read()); res.append(json.load(open(server.STORE_FILE + ".prev"))["blob"]); res.append(len([f for f in os.listdir(d) if ".unreadable-" in f]))
print(json.dumps(res))`);
  rmSync(T, { recursive: true, force: true });
  check("a full disk: Start fresh, a restore with another key, a failed key write and Use the last copy each leave the saved chats (and the last copy) where they were",
    out === JSON.stringify(["refused", "QUJD", 0, "not restored", 0, "QUJD", 0, "not restored", "QUJD", 0, "refused", "garbage", "R09PRA==", 0]).replace(/,/g, ", "), out);
}
{
  // SF-E2: a restore whose messaging key can't be written answers, says so, and logs it
  const K = await app(w, 8156 + PS, w.NODES[3]);
  await person(w, K, "kira", "121289");
  const kk = (await K.call("/api/messages/key")).d;
  const kc = new CORE.Chat({ me: { secret: unhex(kk.secret), public: kk.public, name: kk.name }, api: K.api, resolve: w.resolve });
  await kc.loadStore(); await kc.startDirect("bob");
  const G = await app(w, 8157 + PS, w.NODES[4]);
  await person(w, G, "gus", "565689");
  const bk = (await G.call("/api/wallet/backup", { password: "yet another long password", pin: G.pin })).d.backup;
  G.proc.kill();
  const storeBefore = (await K.call("/api/messages/store")).d.blob;
  writeFileSync(join(K.data, "FAILKEY"), "");
  const rs = await K.call("/api/wallet/restore", { backup: bk, password: "yet another long password", pin: K.pin });
  rmSync(join(K.data, "FAILKEY"));
  const key = JSON.parse(readFileSync(join(K.data, "wallet-msgkey.json"), "utf8"));
  const log = readFileSync(join(K.data, "wallet-events.log"), "utf8");
  K.session = (await K.call("/api/wallet/unlock", { pin: K.pin })).d.session;
  check("the messaging key can't be written: the restore still answers (wallet restored, messaging key not), and says why",
    rs.code === 200 && rs.d.ok && rs.d.messaging_key_restored === false && /couldn't be written/.test(rs.d.messaging_message || ""), [rs.code, rs.d]);
  check("the key and the saved chats are as they were, and the event log has both lines",
    key.public === kk.public && (await K.call("/api/messages/store")).d.blob === storeBefore && / wallet restored /.test(log) && /messaging key not restored/.test(log));
  K.proc.kill();
}
{
  const H = await app(w, 8158 + PS, w.NODES[2], { MESSAGING_DROP_GRACE_SECONDS: "3600" });
  await person(w, H, "hana", "343489");
  const ht = MC.inboxTopic(H.id.publicKey), hitems = async () => (await H.call("/api/messages/inbox")).d.items;
  const hin = p => w.control("inject/2", { topic: ht, payload: b64(p) });
  const toH = (kp, text, from = null) => MC.sealMessage({ to: H.id.publicKey, from: from || "msg-" + hex(kp.publicKey).slice(0, 16), fromSecret: kp.secretKey, text });
  const kH = (await H.call("/api/messages/key")).d;
  const mk = () => new CORE.Chat({ me: { secret: unhex(kH.secret), public: kH.public, name: kH.name }, api: H.api, resolve: w.resolve });
  const burst = async (c, tag) => {
    for (let i = 0; i < 50; i++) { await hin(toH(MC.newKeyPair(), tag + " " + i)); if (i % 20 === 19) { await sleep(700); await c.sync(); } }
    await until("the burst " + tag + " is sorted", async () => { await c.sync(); return !(await hitems()).some(i => !i.k) && c.requests().some(g => g.list[0].text === tag + " 49"); }, 20000);
  };
  // SF-E3 h1: a stranger claims her name first, then she writes, then 50 free keys
  const h = mk(); await h.loadStore(); await h.sync();
  const nell = ID.newIdentity(); await w.register("nellh1", { msg: hex(nell.publicKey) });
  await hin(toH(MC.newKeyPair(), "it's nell (not)", "nellh1"));
  await until("the stranger's claim", async () => { await h.sync(); return h.requests().some(g => g.claimed === "nellh1"); });
  await hin(MC.sealMessage({ to: H.id.publicKey, from: "nellh1", fromSecret: nell.secretKey, text: "the real nell" }));
  await until("the real nell's request", async () => { await h.sync(); return h.requests().some(g => g.key === hex(nell.publicKey)); });
  await burst(h, "free a");
  check("a stranger claiming her name before she writes costs her nothing: her first message is still there after a burst",
    h.requests().some(g => g.key === hex(nell.publicKey)), h.requests().filter(g => g.claimed === "nellh1").length);
  for (const r of [...h.requests()]) await h.deleteRequest(r.id);
  // SF-E3 q7: a stranger made the phone read her name while it had no address; she registers and writes later
  const S = MC.newKeyPair();
  await hin(toH(S, "it's pia", "piaq"));
  await until("a claim of piaq", async () => { await h.sync(); return h.requests().some(g => g.claimed === "piaq"); });
  await h.checkRequests();
  check("(read while it had no address)", h.requests().find(g => g.claimed === "piaq").chainRead);
  for (const r of [...h.requests()]) await h.deleteRequest(r.id);
  await sleep(1100);
  const pia = ID.newIdentity(); await w.register("piaq", { msg: hex(pia.publicKey) });
  await hin(MC.sealMessage({ to: H.id.publicKey, from: "piaq", fromSecret: pia.secretKey, text: "the real pia" }));
  await until("the real pia's request", async () => { await h.sync(); return h.requests().some(g => g.key === hex(pia.publicKey)); });
  await burst(h, "free b");
  check("a \"no address\" answer a stranger caused before she wrote doesn't count for her: she is held through a burst",
    h.requests().some(g => g.key === hex(pia.publicKey)));
  // SF-E4: the one-hour "no address" answer
  const hg = h.requests().find(g => g.key === hex(pia.publicKey));
  await h.mutate(s => { s.req.names.piaq = { k: "", at: Date.now() - 30 * 60000 }; }, true);
  let h2 = mk(); await h2.loadStore(); await h2.sync();
  const a1 = h2.requests().find(g => g.key === hex(pia.publicKey));
  await h2.mutate(s => { s.req.names.piaq = { k: "", at: Date.now() - 2 * 3600000 }; }, true);
  h2 = mk(); await h2.loadStore(); await h2.sync();
  const a2 = h2.requests().find(g => g.key === hex(pia.publicKey));
  check("a \"no address\" answer counts for an hour: read at 30 minutes, not read at 2 hours", a1 && a1.chainRead && a2 && !a2.chainRead, [a1 && a1.chainRead, a2 && a2.chainRead, !!hg]);
  H.proc.kill();
}

stopAll();
console.log("all checks passed");
process.exit(0);

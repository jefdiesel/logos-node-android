// Messages between LNS names (app/messages), end to end without a real messaging node.
//
//   NAMES_MSG_CRYPTO=<the names project's gateway/public/app/msg-crypto.js> node tests/messaging_test.mjs
//
// 1. Interop with the names project: the vendored msg-crypto.js opens messages that the names project's own
//    build sealed (tests/msg_vectors.json), and, with NAMES_MSG_CRYPTO, that build opens ours and ours opens
//    its own (checked against the sha256 in the vectors file). In CI the file is fetched at the pinned commit.
// 2. Two apps (A = alice, B = bob), each with its own fake messaging node (tests/fake_waku.py), names on a
//    fake sequencer: a message each way, checked against the senders' on-chain msg entries; duplicates,
//    oversized payloads, a node going down and coming back, a node restarting without going away and one
//    starting (404 while initializing), the sender's own copy and letting go of the recipient's topic after
//    a send, deleting, and the messaging key in the backup.
// 3. Without WAKU_API (or with one that isn't on this device): no new routes or fields, the same CSP, and
//    the page served is the page file (no Messages module).
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
function check(name, cond, detail = "") {
  console.log((cond ? "ok   " : "FAIL ") + name + (!cond && detail !== "" ? " - " + JSON.stringify(detail) : ""));
  if (!cond) { for (const p of procs) p.kill(); process.exit(1); }
}
function modules(...dirs) {                // the app's ES module folders, side by side as in app/, as Node modules
  const copy = mkdtempSync(join(tmpdir(), "mod-"));
  for (const dir of dirs) cpSync(join(ROOT, "app", dir), join(copy, dir), { recursive: true });
  writeFileSync(join(copy, "package.json"), '{"type":"module"}');
  return copy;
}
const MC = await import(pathToFileURL(join(modules("messages", "noble-curves"), "messages", "msg-crypto.js")));
const N = await import(pathToFileURL(join(modules("names"), "names", "names.js")));
const hex = MC.toHex, unhex = MC.fromHex;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// ---- 1. interop with the names project ------------------------------------------------------------
const V = JSON.parse(readFileSync(join(here, "msg_vectors.json"), "utf8"));
for (const k of Object.values(V.keys)) check("the inbox topic matches the names project's", MC.inboxTopic(unhex(k.public)) === k.topic);
for (const m of V.messages) {
  const got = MC.openMessage(unhex(V.keys[m.to].secret), unhex(m.payload));
  check(`a message sealed by the names project opens here (${m.from} to ${m.to})`,
    got && got.text === m.text && got.from === m.from && got.ts === m.ts && got.authentic && MC.isVerified(got, V.keys[m.from].public), got);
  check("and isn't verified against another key", got && !MC.isVerified(got, V.keys[m.to].public));
}
let THEIRS = null;
if (process.env.NAMES_MSG_CRYPTO) {
  const src = readFileSync(process.env.NAMES_MSG_CRYPTO);
  check("the names project's build is the pinned one", createHash("sha256").update(src).digest("hex") === V.source.sha256);
  const copy = join(mkdtempSync(join(tmpdir(), "theirs-")), "msg-crypto.mjs");
  writeFileSync(copy, src);
  THEIRS = await import(pathToFileURL(copy));
  const alice = unhex(V.keys.alice.secret), bob = unhex(V.keys.bob.secret);
  const ours = MC.sealMessage({ to: THEIRS.publicKeyOf(bob), from: "alice", fromSecret: alice, text: "sealed here" });
  const t = THEIRS.openMessage(bob, ours);
  check("the names project's build opens a message sealed here", t && t.text === "sealed here" && THEIRS.isVerified(t, V.keys.alice.public), t);
  const theirs = THEIRS.sealMessage({ to: MC.publicKeyOf(alice), from: "bob", fromSecret: bob, text: "sealed there" });
  const o = MC.openMessage(alice, theirs);
  check("and a message it seals now opens here", o && o.text === "sealed there" && MC.isVerified(o, V.keys.bob.public), o);
} else if (process.env.CI) {
  check("NAMES_MSG_CRYPTO is set in CI", false);
} else {
  console.log("     (NAMES_MSG_CRYPTO not set: the live check against the names project's build is skipped)");
}

// ---- the fake world: a messaging network, a sequencer, apps ---------------------------------------
const PROGRAM = N.base58Encode(new Uint8Array(32).fill(7));
const SEQ_PORT = 18547, CTL = 18659, NODE_A = 18651, NODE_B = 18652, NODE_PEER = 18654;
const shards = new Map();
async function register(name, texts) {
  const d = await N.deriveName(name);
  const body = await N.seal(d.key, N.encodeProfile({ name, texts }), "record");
  const rec = new Uint8Array(45 + body.length), v = new DataView(rec.buffer);
  rec[0] = 3; rec.fill(9, 1, 33); v.setBigUint64(33, BigInt(Date.UTC(2100, 0, 1)), true); v.setUint32(41, body.length, true); rec.set(body, 45);
  shards.set(await N.recordAddress(PROGRAM, d.id), Array.from(rec));
}
const sequencer = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const { id, params } = JSON.parse(raw);
    const data = shards.has(params[0]) ? { shards: { [PROGRAM]: shards.get(params[0]) } } : { shards: {} };
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { data } }));
  });
});
await new Promise((ok) => sequencer.listen(SEQ_PORT, "127.0.0.1", ok));
procs.push(spawn("python3", [join(here, "fake_waku.py"), String(CTL), String(NODE_A), String(NODE_B), String(NODE_PEER)], { stdio: "ignore" }));
const control = async (what) => (await fetch(`http://127.0.0.1:${CTL}/${what}`, { method: "POST", body: "{}" })).text();
const subsOf = async (node) => (await fetch(`http://127.0.0.1:${CTL}/subs/${node}`)).json();
const inject = async (node, topic, payload) => (await fetch(`http://127.0.0.1:${CTL}/inject/${node}`, { method: "POST", body: JSON.stringify({ topic, payload }) })).text();

function keystore() {
  const r = () => createHash("sha256").update(Math.random().toString()).digest("hex");
  const pub = ["LeaderFunding", "Stake", "PoWClaim", "SdpFunding", "VaucherMaster", "BlendSigning", "NetworkSwarm", "BlendZk"];
  return "public_keys:\n" + pub.map((k) => `  ${k}: ${r()}\n`).join("") + "secret_keys:\n" +
         pub.map((k) => `  ${k}: !${k.startsWith("Blend") && k !== "BlendZk" || k === "NetworkSwarm" ? "Ed25519" : "Zk"} ${r()}\n`).join("") +
         "WARNING: Do not share your secret keys\n";
}
async function app(port, extra) {
  const data = mkdtempSync(join(tmpdir(), "app-"));
  writeFileSync(join(data, "keystore.yaml"), keystore()); writeFileSync(join(data, "user_config.yaml"), "x: 1\n");
  const env = { ...process.env, APP_PORT: String(port), APP_DATA: data, NODE_BIN: join(here, "fake_node_bin.py"),
                NODE_CFG: join(data, "user_config.yaml"), NODE_API: "http://127.0.0.1:9", UPDATE_URL: "http://127.0.0.1:9/",
                NAMES_RPC_URL: `http://127.0.0.1:${SEQ_PORT}`, NAMES_PROGRAM: PROGRAM,
                MESSAGING_POLL_SECONDS: "0.3", MESSAGING_HEALTH_SECONDS: "0.5", ...extra };
  for (const k of Object.keys(extra)) if (extra[k] === null) delete env[k];
  const p = spawn("python3", [join(ROOT, "app", "server.py")], { env, stdio: "ignore" });
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + "/api/wallet"); await r.text(); if (r.ok) break; } catch {} await sleep(100); }
  return { base, data, proc: p, session: null };
}
async function call(a, path, body, session = a.session) {
  const headers = {};
  if (session) headers["X-Session"] = session;
  const opt = { headers };
  if (body !== undefined) { opt.method = "POST"; headers["Content-Type"] = "application/json"; headers.Origin = a.base; opt.body = JSON.stringify(body); }
  const r = await fetch(a.base + path, opt);
  let d = {}; try { d = await r.json(); } catch {}
  return { code: r.status, d };
}
const rpcSessions = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opt = {}) => {            // what the page's fetch shim does for the names forwarder
  const a = rpcSessions.get(String(url));
  return a ? realFetch(url, { ...opt, headers: { ...(opt.headers || {}), "X-Session": a.session, Origin: a.base } }) : realFetch(url, opt);
};
const until = async (name, f, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await f(); if (v) return v; await sleep(200); } check(name, false, v); };

// ---- 3. without WAKU_API nothing is new -----------------------------------------------------------
// The page file itself changes between releases (for everyone). What matters here is that without a
// messaging node nothing of Messages reaches the page: no module, no routes, the same CSP and fields.
const indexFile = readFileSync(join(ROOT, "app", "index.html"));
check("the page file loads no Messages code itself (that comes only with the module)", !/messages\.js|\/api\/messages|type="module"/.test(indexFile.toString("utf8")));
for (const [label, extra, port] of [["without WAKU_API", { WAKU_API: null }, 8097], ["with a WAKU_API off this device", { WAKU_API: "http://192.168.1.5:18645" }, 8098]]) {
  const c = await app(port, extra);
  const w = await call(c, "/api/wallet");
  check(`${label}, /api/wallet has the same fields as before`,
    JSON.stringify(Object.keys(w.d).sort()) === JSON.stringify(["autolock_minutes", "leave_grace", "names_program", "passkeys", "pin_set", "unlocked", "wait"]), w.d);
  c.session = (await call(c, "/api/wallet/setup", { pin: "192837" })).d.session;
  for (const [path, body] of [["/api/messages/status"], ["/api/messages/key"], ["/api/messages/inbox"], ["/api/messages/send", { topic: "x", payload: "" }],
                              ["/api/messages/key", { secret: "", public: "" }], ["/messages/messages.js"], ["/messages/msg-crypto.js"],
                              ["/noble-curves/ed25519.js"], ["/api/messages/outbox"], ["/api/messages/store"], ["/api/messages/outbox", { copy: "", sends: [] }],
                              ["/api/messages/store", { rev: 0, blob: "" }], ["/api/messages/inbox/read", { ids: [] }], ["/messages/chat-core.js"]]) {
    const r = await call(c, path, body);
    check(`${label}, ${path} doesn't exist`, r.code === 404, r);
  }
  const st = await call(c, "/api/status");
  check(`${label}, /api/status has nothing new`, !JSON.stringify(st.d).includes("messag"), st.d);
  const res = await fetch(c.base + "/");
  check(`${label}, the page's CSP is unchanged (no data: pictures)`, res.headers.get("content-security-policy") ===
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'");
  const page = Buffer.from(await res.arrayBuffer());
  const want = Buffer.from(indexFile.toString("utf8").replace("__APP_VERSION__", JSON.parse(readFileSync(join(ROOT, "app", "release.json"))).version).replace("__APP_EMBEDDED__", ""));
  check(`${label}, the page served is the page file, with only its version filled in`, page.equals(want));
  const bk = await call(c, "/api/wallet/backup", { password: "correct horse battery", pin: "192837" });
  check(`${label}, a backup is still version 1`, bk.code === 200 && bk.d.backup.version === 1 && bk.d.backup.cipher.aad === "logos-node-wallet-backup v1", bk);
  c.proc.kill();
}

// ---- 2. two apps exchange messages ------------------------------------------------------------------
const A = await app(8095, { WAKU_API: `http://127.0.0.1:${NODE_A}`, MESSAGING_UNSUBSCRIBE_SECONDS: "4" });
const B = await app(8096, { WAKU_API: `http://127.0.0.1:${NODE_B}`, MESSAGING_UNSUBSCRIBE_SECONDS: "4" });
for (const [x, pin] of [[A, "111222"], [B, "333444"]]) {
  x.pin = pin; x.session = (await call(x, "/api/wallet/setup", { pin })).d.session;
  rpcSessions.set(x.base + "/api/names/rpc", x);
}
check("the messages routes need an unlocked wallet", (await call(A, "/api/messages/status", undefined, "0".repeat(64))).code === 401);
let st = await until("the app sees its messaging node", async () => { const r = await call(A, "/api/messages/status"); return r.d.node && r.d.node.reachable === true && r.d; });
check("status before turning messages on: no key", st.key === null && st.node.connection === "Connected", st);
const page = (await (await fetch(A.base + "/")).text());
check("with WAKU_API the page loads the Messages module", page.includes('<script type="module" src="/messages/messages.js"></script>'));
const served = async (path) => { const r = await fetch(A.base + path); await r.text(); return r.ok; };   // read every body: Node 20's fetch trips on unread ones
check("and the module is served", await served("/messages/messages.js") && await served("/noble-curves/abstract/montgomery.js"));

const bad = MC.newKeyPair(), other = MC.newKeyPair();
let r = await call(A, "/api/messages/key", { secret: hex(bad.secretKey), public: hex(other.publicKey) });
check("a public key that isn't the secret key's is refused", r.code === 400, r);
for (const x of [A, B]) {
  const kp = MC.newKeyPair();
  x.key = kp;
  r = await call(x, "/api/messages/key", { secret: hex(kp.secretKey), public: hex(kp.publicKey) });
  check("the page's new key pair is kept", r.code === 200 && r.d.public === hex(kp.publicKey) && r.d.topic === MC.inboxTopic(kp.publicKey), r);
}
r = await call(A, "/api/messages/key", { secret: hex(other.secretKey), public: hex(other.publicKey) });
check("a second key doesn't silently replace the first", r.code === 409, r);
r = await call(A, "/api/messages/key", { secret: hex(other.secretKey), public: hex(other.publicKey), replace: true, pin: "000000" });
check("replacing it needs the PIN", r.code === 403, r);
r = await call(A, "/api/messages/key", undefined, null);
check("the secret key isn't given without a session", r.code === 401, r);
r = await call(A, "/api/messages/key");
check("an unlocked page gets it", r.code === 200 && r.d.secret === hex(A.key.secretKey), r);
for (const [x, name] of [[A, "alice"], [B, "bob"]]) check(`the name ${name} is kept`, (await call(x, "/api/messages/name", { name })).d.name === name);
check("a bad name is refused", (await call(A, "/api/messages/name", { name: "Not A Name" })).code === 400);
await register("alice", { msg: hex(A.key.publicKey) });
await register("bob", { msg: hex(B.key.publicKey) });
await register("carol", { chat: "hi" });

async function msgKey(viewer, name) {
  const f = await N.resolveName(viewer.base + "/api/names/rpc", PROGRAM, name);
  return f && f.texts ? f.texts.msg : null;
}
async function send(from, fromName, toName, text, sealer = MC) {
  const key = MC.parseMsgKey(await msgKey(from, toName));
  const sealed = sealer.sealMessage({ to: key, from: fromName, fromSecret: from.key.secretKey, text });
  const r = await call(from, "/api/messages/send", { topic: MC.inboxTopic(key), payload: b64(sealed) });
  check(`${fromName} sends to ${toName}`, r.code === 200 && r.d.requestId, r);
  return r.d.requestId;
}
async function inbox(x) { return (await call(x, "/api/messages/inbox")).d.items; }
async function opened(x) {
  return (await inbox(x)).map((i) => MC.openMessage(x.key.secretKey, new Uint8Array(Buffer.from(i.payload, "base64"))));
}

check("carol has no msg entry, so there's nothing to send to", MC.parseMsgKey(await msgKey(A, "carol")) === null);
const rid = await send(A, "alice", "bob", "hi bob, it's alice");
const sent = await until("the send is confirmed", async () => { const s = await call(A, "/api/messages/send/" + rid); return s.d.done && s.d; });
check("the send status says sent", sent.events.includes("sent") && sent.events.includes("propagated"), sent);
await until("bob's inbox gets it", async () => (await inbox(B)).length === 1);
let got = (await opened(B))[0];
check("bob opens it", got && got.text === "hi bob, it's alice" && got.from === "alice" && got.authentic, got);
check("and alice is verified against her msg entry, read through bob's app", MC.isVerified(got, await msgKey(B, "alice")));
check("the server kept the payload sealed", !readFileSync(join(B.data, "wallet-inbox.json"), "utf8").includes("alice"));
await send(B, "bob", "alice", "hi alice", THEIRS || MC);
await until("alice's inbox gets the reply", async () => (await inbox(A)).length === 1);
got = (await opened(A))[0];
check(`alice opens the reply${THEIRS ? " (sealed by the names project's own build)" : ""}`, got && got.text === "hi alice" && MC.isVerified(got, await msgKey(A, "bob")), got);
const forged = MC.sealMessage({ to: A.key.publicKey, from: "bob", fromSecret: MC.newKeyPair().secretKey, text: "I'm bob, honest" });
await inject(0, MC.inboxTopic(A.key.publicKey), b64(forged));
await until("a message claiming to be bob arrives", async () => (await inbox(A)).length === 2);
const fake = (await opened(A))[1];
check("it opens, but isn't verified as bob", fake && fake.from === "bob" && !MC.isVerified(fake, await msgKey(A, "bob")), fake);

// the command-line peer (tools/msg-peer.mjs), as on the Mini next to a desktop node
const peerDir = mkdtempSync(join(tmpdir(), "peer-")), peerKey = join(peerDir, "key.json");
const peerArgs = ["--key", peerKey, "--api", `http://127.0.0.1:${NODE_PEER}`, "--rpc", `http://127.0.0.1:${SEQ_PORT}`, "--program", PROGRAM];
const peerPub = execFileSync(process.execPath, [join(ROOT, "tools", "msg-peer.mjs"), "keygen", ...peerArgs], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
check("msg-peer keygen prints only the public key, and keeps the secret in a 0600 file",
  /^[0-9a-f]{64}$/.test(peerPub) && JSON.parse(readFileSync(peerKey, "utf8")).public === peerPub && (await import("node:fs")).statSync(peerKey).mode % 0o1000 === 0o600, peerPub);
await register("mini", { msg: peerPub });
const listener = spawn(process.execPath, [join(ROOT, "tools", "msg-peer.mjs"), "listen", ...peerArgs], { stdio: ["ignore", "pipe", "ignore"] });
procs.push(listener);
let heard = "";
listener.stdout.on("data", (d) => (heard += d));
await sleep(2500);                                  // it subscribes first
await send(A, "alice", "mini", "hi mini, from the phone");
await until("msg-peer listen prints the message, verified", async () => heard.includes("✓ alice: hi mini, from the phone") && heard, 15000);
const peerSend = spawn(process.execPath, [join(ROOT, "tools", "msg-peer.mjs"), "send", "--to", "alice", "--from-name", "mini", "hello alice, from the Mini", ...peerArgs], { stdio: ["ignore", "pipe", "pipe"] });
let peerOut = ""; peerSend.stdout.on("data", (d) => (peerOut += d)); peerSend.stderr.on("data", (d) => (peerOut += d));
const peerCode = await new Promise((ok) => peerSend.on("exit", ok));
check("msg-peer send resolves alice, seals and sends, and reports sent", peerCode === 0 && peerOut.includes("sent to alice") && peerOut.includes("  sent"), peerOut);
await until("alice's app gets it", async () => (await inbox(A)).length === 3);
got = (await opened(A)).find((m) => m && m.from === "mini");
check("and opens it, verified as mini", got && got.text === "hello alice, from the Mini" && MC.isVerified(got, await msgKey(A, "mini")), got);
const noKey = spawn(process.execPath, [join(ROOT, "tools", "msg-peer.mjs"), "send", "--to", "carol", "--from-name", "mini", "x", ...peerArgs], { stdio: ["ignore", "ignore", "pipe"] });
let noKeyErr = ""; noKey.stderr.on("data", (d) => (noKeyErr += d));
const noKeyCode = await new Promise((ok) => noKey.on("exit", ok));
check("msg-peer send to a name without a msg entry says so", noKeyCode === 1 && noKeyErr.includes("carol has no messaging address"), noKeyErr);
const peerSubs = await subsOf(2);
check("msg-peer send let go of alice's topic afterwards, and listen kept its own", !peerSubs.includes(MC.inboxTopic(A.key.publicKey)) && peerSubs.includes(MC.inboxTopic(unhex(peerPub))), peerSubs);
await control("restart/2");
await until("msg-peer listen subscribes again after its node restarts", async () => (await subsOf(2)).includes(MC.inboxTopic(unhex(peerPub))), 6000);
await send(A, "alice", "mini", "after your node restarted");
await until("and still prints messages", async () => heard.includes("✓ alice: after your node restarted") && heard, 15000);
listener.kill();

// duplicates: the same record twice (the replay of history after a restart is checked further down)
await control("dup/1"); await sleep(1500);
check("a record delivered twice is kept once", (await inbox(B)).length === 1);

// oversized payloads, and payloads this key can't open
r = await call(A, "/api/messages/send", { topic: MC.inboxTopic(B.key.publicKey), payload: b64(new Uint8Array(16385)) });
check("a payload over 16 KiB isn't sent", r.code === 413, r);
await inject(1, MC.inboxTopic(B.key.publicKey), b64(new Uint8Array(20000).fill(1)));
await inject(1, "/names/1/msg-0000000000000000/proto", b64(new Uint8Array(100).fill(2)));
await inject(1, MC.inboxTopic(B.key.publicKey), b64(new Uint8Array(80).fill(3)));
await until("a small payload that isn't a message is kept (sealed, unknown)", async () => (await inbox(B)).length === 2);
const junk = (await inbox(B))[1];
check("the oversized one and another topic's were dropped, and the page can't open the junk", (await opened(B))[1] === null);
r = await call(B, "/api/messages/inbox/delete", { ids: [junk.n] });
check("a message can be deleted", r.d.removed === 1 && (await inbox(B)).length === 1, r);

// the messaging node goes down and comes back
await control("down/1");
await until("bob's app notices its node is off", async () => (await call(B, "/api/messages/status")).d.node.reachable === false, 8000);
r = await call(B, "/api/messages/send", { topic: MC.inboxTopic(A.key.publicKey), payload: b64(new Uint8Array(64)) });
check("sending while it's off says so", r.code === 503 && r.d.node_off, r);
await send(A, "alice", "bob", "while your node was off");
await control("up/1"); await control("restart/1");
await until("after it comes back, bob gets what came meanwhile", async () => (await inbox(B)).length >= 2, 12000);
await sleep(1500);
check("its history replays the first message too, and that is still kept once", (await inbox(B)).length === 2, (await inbox(B)).length);
got = (await opened(B)).find((m) => m && m.text === "while your node was off");
check("and it opens", got && MC.isVerified(got, await msgKey(B, "alice")), got);

// the in-process count for a notification (no route, no content)
const count = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import server; print(server.messaging_inbox_count())", join(ROOT, "app")],
  { env: { ...process.env, APP_DATA: B.data, WAKU_API: `http://127.0.0.1:${NODE_B}` } }).toString().trim();
check("messaging_inbox_count() says how many wait", count === "2", count);

// the node restarts without going away (subscriptions are gone, WAKU_API is the same, /health never failed)
const bobTopic = MC.inboxTopic(B.key.publicKey), aliceTopic = MC.inboxTopic(A.key.publicKey);
await until("bob's node is subscribed to bob's inbox", async () => (await subsOf(1)).includes(bobTopic));
await control("restart/1");
check("a restart drops the subscription", !(await subsOf(1)).includes(bobTopic));
await until("bob's app subscribes again within 2 s", async () => (await subsOf(1)).includes(bobTopic), 2000);
await send(A, "alice", "bob", "after a quick restart");
await until("and gets what comes next", async () => (await inbox(B)).length === 3, 8000);
// the node starts: /messaging answers 404 "not available while initializing" for 3 s
await control("init/1");
await until("bob's app says the node is starting", async () => (await call(B, "/api/messages/status")).d.node.starting === true, 2000);
r = await call(B, "/api/messages/send", { topic: aliceTopic, payload: b64(new Uint8Array(64)) });
check("sending while it starts says so", r.code === 503 && r.d.starting, r);
await until("once it's ready, bob's app subscribes at once", async () => (await subsOf(1)).includes(bobTopic), 5000);
check("and no longer says starting", (await call(B, "/api/messages/status")).d.node.starting === false);
// a send subscribes the sender's node to the recipient's topic: the sender's own message comes back to it
const aliceHad = (await inbox(A)).length;
await until("alice's node no longer listens to bob's topic from her earlier sends", async () => !(await subsOf(0)).includes(bobTopic), 8000);
await send(A, "alice", "bob", "your own copy");
check("the send subscribed alice's node to bob's topic", (await subsOf(0)).includes(bobTopic));
await until("bob gets it", async () => (await inbox(B)).length === 4, 8000);
await sleep(1500);
check("alice's own copy, which her node hands back, isn't put in her inbox", (await inbox(A)).length === aliceHad, (await inbox(A)).length);
await until("once the send has settled, alice's app lets go of bob's topic", async () => !(await subsOf(0)).includes(bobTopic), 10000);
check("but keeps her own inbox", (await subsOf(0)).includes(aliceTopic));

// the messaging key goes into the backup (version 2) and comes back with a restore
r = await call(A, "/api/wallet/backup", { password: "alice backup password", pin: A.pin });
check("with a messaging key the backup is version 2", r.code === 200 && r.d.backup.version === 2 && r.d.backup.cipher.aad === "logos-node-wallet-backup v2", r);
const backup = r.d.backup, out = mkdtempSync(join(tmpdir(), "open-"));
writeFileSync(join(out, "backup.json"), JSON.stringify(backup));
execFileSync("python3", [join(ROOT, "tools", "decrypt-backup.py"), join(out, "backup.json"), "-o", join(out, "keystore.yaml"), "--password-stdin"],
  { input: "alice backup password\n" });
check("the independent tool opens it to the key file", readFileSync(join(out, "keystore.yaml"), "utf8") === readFileSync(join(A.data, "keystore.yaml"), "utf8"));
const mk = JSON.parse(readFileSync(join(out, "messaging-key.json"), "utf8"));
check("and the messaging key", mk.secret === hex(A.key.secretKey) && mk.public === hex(A.key.publicKey) && mk.name === "alice", mk);
r = await call(B, "/api/wallet/restore", { backup, password: "alice backup password", pin: B.pin });
check("restoring alice's backup in bob's app brings her messaging key", r.code === 200 && r.d.ok && r.d.messaging_key_restored, r);
r = await call(B, "/api/messages/key", undefined, (await call(B, "/api/wallet/unlock", { pin: B.pin })).d.session);
check("the restored app has alice's messaging key", r.d.secret === hex(A.key.secretKey) && r.d.name === "alice", r);
const log = readFileSync(join(B.data, "wallet-events.log"), "utf8");
check("the event log has no message text, key or topic", !/hi bob|hi alice|honest|while your node/.test(log) && !log.includes(hex(B.key.secretKey))
      && !log.includes(MC.inboxTopic(B.key.publicKey)) && log.includes(" message sent "), log.slice(-400));
for (const p of procs) p.kill();
sequencer.close();
console.log("all checks passed");
process.exit(0);

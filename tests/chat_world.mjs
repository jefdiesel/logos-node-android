// A fake world for the chat tests: a messaging network (tests/fake_waku.py), a names sequencer, and app
// instances (app/server.py), plus the page's chat model (app/messages/chat-core.js) running in Node against
// an app the way the page runs it in a browser.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
export const procs = [];
export function check(name, cond, detail = "") {
  console.log((cond ? "ok   " : "FAIL ") + name + (!cond && detail !== "" ? " - " + JSON.stringify(detail).slice(0, 600) : ""));
  if (!cond) { stopAll(); process.exit(1); }
}
export function stopAll() { for (const p of procs) { try { p.kill(); } catch (e) {} } }
process.on("uncaughtException", e => { console.error(e); stopAll(); process.exit(1); });
process.on("unhandledRejection", e => { console.error(e); stopAll(); process.exit(1); });
export const until = async (name, f, ms = 10000) => {
  const end = Date.now() + ms; let v;
  while (Date.now() < end) { v = await f(); if (v) return v; await sleep(150); }
  check(name, false, v);
};
export function modules(...dirs) {                // the app's ES module folders, side by side as in app/, as Node modules
  const copy = mkdtempSync(join(tmpdir(), "mod-"));
  for (const dir of dirs) cpSync(join(ROOT, "app", dir), join(copy, dir), { recursive: true });
  writeFileSync(join(copy, "package.json"), '{"type":"module"}');
  return copy;
}
const MOD = modules("messages", "noble-curves", "names");
export const MC = await import(pathToFileURL(join(MOD, "messages", "msg-crypto.js")));
export const CORE = await import(pathToFileURL(join(MOD, "messages", "chat-core.js")));
export const ID = await import(pathToFileURL(join(MOD, "messages", "identity.js")));
export const N = await import(pathToFileURL(join(MOD, "names", "names.js")));
export const ED = await import(pathToFileURL(join(MOD, "noble-curves", "ed25519.js")));
export const hex = MC.toHex, unhex = MC.fromHex;
export const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/** Starts the sequencer and `nodes` messaging nodes. Ports: base+0 sequencer, +1 control, +2.. nodes. */
export async function world(base, nodes) {
  const PROGRAM = N.base58Encode(new Uint8Array(32).fill(7));
  const SEQ = base, CTL = base + 1, NODES = Array.from({ length: nodes }, (_, i) => base + 2 + i);
  const shards = new Map();
  const sequencer = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const { id, params } = JSON.parse(raw);
      const data = shards.has(params[0]) ? { shards: { [PROGRAM]: shards.get(params[0]) } } : { shards: {} };
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { data } }));
    });
  });
  await new Promise((ok) => sequencer.listen(SEQ, "127.0.0.1", ok));
  procs.push({ kill: () => sequencer.close() });
  procs.push(spawn("python3", [join(here, "fake_waku.py"), String(CTL), ...NODES.map(String)], { stdio: "ignore" }));
  await sleep(400);
  const w = {
    PROGRAM, SEQ, CTL, NODES,
    async register(name, texts) {
      const d = await N.deriveName(name);
      const body = await N.seal(d.key, N.encodeProfile({ name, texts }), "record");
      const rec = new Uint8Array(45 + body.length), v = new DataView(rec.buffer);
      rec[0] = 3; rec.fill(9, 1, 33); v.setBigUint64(33, BigInt(Date.UTC(2100, 0, 1)), true); v.setUint32(41, body.length, true); rec.set(body, 45);
      shards.set(await N.recordAddress(PROGRAM, d.id), Array.from(rec));
    },
    resolve: (name) => N.resolveName(`http://127.0.0.1:${SEQ}`, PROGRAM, name),
    control: async (what, body = {}) => (await fetch(`http://127.0.0.1:${CTL}/${what}`, { method: "POST", body: JSON.stringify(body) })).text(),
    ctlGet: async (what) => (await fetch(`http://127.0.0.1:${CTL}/${what}`)).json(),
  };
  return w;
}

function keystore() {
  const r = () => createHash("sha256").update(Math.random().toString()).digest("hex");
  const pub = ["LeaderFunding", "Stake", "PoWClaim", "SdpFunding", "VaucherMaster", "BlendSigning", "NetworkSwarm", "BlendZk"];
  return "public_keys:\n" + pub.map((k) => `  ${k}: ${r()}\n`).join("") + "secret_keys:\n" +
         pub.map((k) => `  ${k}: !${k.startsWith("Blend") && k !== "BlendZk" || k === "NetworkSwarm" ? "Ed25519" : "Zk"} ${r()}\n`).join("") +
         "WARNING: Do not share your secret keys\n";
}

/** An app on `port` with its own data folder (or `data`), talking to messaging node `node`. */
export async function app(w, port, node, extra = {}, data = null, serverPy = join(ROOT, "app", "server.py")) {
  if (!data) {
    data = mkdtempSync(join(tmpdir(), "app-"));
    writeFileSync(join(data, "keystore.yaml"), keystore()); writeFileSync(join(data, "user_config.yaml"), "x: 1\n");
  }
  const env = { ...process.env, APP_PORT: String(port), APP_DATA: data, NODE_BIN: join(here, "fake_node_bin.py"),
                NODE_CFG: join(data, "user_config.yaml"), NODE_API: "http://127.0.0.1:9", UPDATE_URL: "http://127.0.0.1:9/",
                NAMES_RPC_URL: `http://127.0.0.1:${w.SEQ}`, NAMES_PROGRAM: w.PROGRAM, WAKU_API: node ? `http://127.0.0.1:${node}` : "",
                MESSAGING_POLL_SECONDS: "0.3", MESSAGING_HEALTH_SECONDS: "0.5", MESSAGING_SEND_GAP_SECONDS: "0.2", ...extra };
  for (const k of Object.keys(extra)) if (extra[k] === null) delete env[k];
  // every app runs with hard links refused, as Android refuses them to apps (tests/nolink_server.py)
  const wrapped = serverPy.endsWith("nolink_server.py") ? serverPy : join(here, "nolink_server.py");
  if (!serverPy.endsWith("nolink_server.py")) env.REAL_SERVER_PY = serverPy;
  const p = spawn("python3", [wrapped], { env, stdio: "ignore" });
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base + "/api/wallet"); await r.text(); if (r.ok) break; } catch {} await sleep(100); }
  const a = { base, data, proc: p, port, node, session: null, extra, serverPy };
  a.call = async (path, body, session = a.session) => {
    const headers = {};
    if (session) headers["X-Session"] = session;
    const opt = { headers };
    if (body !== undefined) { opt.method = "POST"; headers["Content-Type"] = "application/json"; headers.Origin = base; opt.body = JSON.stringify(body); }
    const r = await fetch(base + path, opt);
    let d = {}; try { d = await r.json(); } catch {}
    return { code: r.status, d };
  };
  a.api = async (path, body) => { const r = await a.call(path, body); return { ok: r.code >= 200 && r.code < 300, status: r.code, data: r.d }; };
  return a;
}

/** Stops an app and starts it again on the same data (a phone restart), and unlocks it again. */
export async function restart(w, a) {
  a.proc.kill(); await new Promise((ok) => a.proc.once("exit", ok));
  const b = await app(w, a.port, a.node, a.extra, a.data, a.serverPy);
  for (const k of ["pin", "id", "name"]) b[k] = a[k];
  b.session = (await b.call("/api/wallet/unlock", { pin: a.pin })).d.session;
  return b;
}

/** Sets a PIN, makes a seeded messaging identity, sets the name, registers it on the fake chain. */
export async function person(w, a, name, pin) {
  a.pin = pin;
  a.session = (await a.call("/api/wallet/setup", { pin })).d.session;
  const id = ID.newIdentity();
  const r = await a.call("/api/messages/key", { seed: hex(id.seed), secret: hex(id.secretKey), public: hex(id.publicKey) });
  if (r.code !== 200) throw new Error("key: " + JSON.stringify(r));
  await a.call("/api/messages/name", { name });
  await w.register(name, { msg: hex(id.publicKey) });
  a.id = id; a.name = name;
  return a;
}

/** The page's chat model for app `a`. */
export async function chatOf(w, a) {
  const k = (await a.call("/api/messages/key")).d;
  const chat = new CORE.Chat({ me: { secret: unhex(k.secret), public: k.public, name: k.name }, api: a.api, resolve: w.resolve });
  await chat.loadStore(); await chat.sync();
  return chat;
}

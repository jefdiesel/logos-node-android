// The app key in a real browser (headless Chrome over the DevTools protocol): server.py as the Android app runs it
// (APP_EMBEDDED=android, APP_KEY set), the key given to the browser the way WalletActivity gives it to the WebView
// (a host-only, HttpOnly, SameSite=Strict cookie set before the page loads). Checks that the page's own requests
// carry it (GET and POST, so the PIN can be set and the wallet opens), that the page's scripts can't read it, and
// that without it the page loads but the wallet refuses and says why. android/LOCAL-APIS.md.
//
//   CHROME=<path to chrome> node tests/app_key_ui.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8131 + Number(process.env.PORT_SHIFT || 0), BASE = `http://127.0.0.1:${PORT}`, PIN = "246813";
const KEY = randomBytes(32).toString("hex");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [], dirs = [];
const stop = () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
};
process.on("uncaughtException", (e) => { console.error(e); stop(); process.exit(1); });
const check = (name, ok, detail) => {
  console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 400) : ""));
  if (!ok) { stop(); process.exit(1); }
};

const data = mkdtempSync(join(tmpdir(), "appkey-data-")); dirs.push(data);
const env = { ...process.env, APP_EMBEDDED: "android", APP_KEY: KEY, APP_PORT: String(PORT), APP_DATA: data,
  NODE_API: "http://127.0.0.1:9", NODE_BIN: "/nonexistent", UPDATE_URL: "http://127.0.0.1:9/" };
const app = spawn("python3", [join(here, "..", "app", "server.py")], { stdio: "ignore", env });
procs.push(app);
let up = false;
// every answer is read to its end: one left unread trips Node's HTTP client when the socket ends (undici's
// assert(!this.paused), seen twice in CI)
for (let i = 0; i < 100 && !up; i++) { up = await fetch(BASE + "/").then(async (r) => { await r.arrayBuffer().catch(() => null); return r.ok; }, () => false); if (!up) await sleep(100); }
check("the app starts", up);

const cport = 9353 + Number(process.env.PORT_SHIFT || 0), prof = mkdtempSync(join(tmpdir(), "chrome-")); dirs.push(prof);
// never drive a browser this test didn't start: a DevTools port that already answers may be an adb forward to a phone
if (await fetch(`http://127.0.0.1:${cport}/json/version`).then(async (r) => { await r.arrayBuffer().catch(() => null); return true; }, () => false)) { console.error(`port ${cport} already has a DevTools endpoint; set PORT_SHIFT`); stop(); process.exit(1); }
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cport}`, `--user-data-dir=${prof}`, "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
procs.push(chrome);
let target;
for (let i = 0; i < 600 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json()).find((t) => t.type === "page"); } catch {} if (!target) await sleep(100); }
check("Chrome starts", !!target);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok));
let seq = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr + ": " + JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const waitFor = async (name, expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await js(expr); } catch { v = false; } if (v) return check(name, true); await sleep(150); } check(name, false, await js("document.body ? document.body.innerText.slice(0, 300) : ''").catch(() => "")); };
await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Network.enable");

// 1. without the key: the page (a public file) loads, the wallet refuses and the page says so
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("without the key the page loads and says the wallet refused it",
  `!document.getElementById("v-loading").hidden && document.getElementById("v-loading").textContent.includes("only answers its own page")`);
check("without the key the page's fetch gets 403", (await js(`fetch("/api/wallet").then(r => r.status)`)) === 403);

// 2. the key as WalletActivity gives it: CookieManager.setCookie(URL, "app_key=...; Path=/; HttpOnly; SameSite=Strict")
const set = await cdp("Network.setCookie", { name: "app_key", value: KEY, url: BASE + "/", path: "/", httpOnly: true, sameSite: "Strict" });
check("the browser takes the cookie for 127.0.0.1", set.result && set.result.success === true, set);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("with the key the page reaches the wallet: it asks for a first PIN", `!document.getElementById("v-setup").hidden`);
check("the page's scripts can't read the key (HttpOnly)", !(await js("document.cookie")).includes(KEY));
const setup = await js(`fetch("/api/wallet/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "${PIN}" }) })
  .then(async r => ({ status: r.status, session: !!(await r.json()).session }))`);
check("the page's own POST carries the key (and its Origin): the PIN is set", setup.status === 200 && setup.session, setup);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("after a reload the page shows the wallet with its PIN set (locked)", `!document.getElementById("v-locked").hidden`);

// 3. the key is per start: a cookie from an earlier start (another key) is refused
await cdp("Network.setCookie", { name: "app_key", value: "0".repeat(64), url: BASE + "/", path: "/", httpOnly: true, sameSite: "Strict" });
check("a stale key from an earlier start is refused", (await js(`fetch("/api/wallet").then(r => r.status)`)) === 403);

ws.close();
// Chrome keeps writing its profile until it has exited: wait for that before removing the folder
const exited = new Promise((ok) => chrome.once("exit", ok));
try { chrome.kill("SIGTERM"); } catch {}
await Promise.race([exited, sleep(5000)]);
stop();
console.log("all checks passed");

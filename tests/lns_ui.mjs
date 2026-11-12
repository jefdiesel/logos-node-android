// Your name (app/lns/lns.js) in a real browser (headless Chrome over the DevTools protocol), at phone width,
// with the stand-in signer and sequencer of tests/lns_ui_app.py: it shows only in the Android app with the
// signer, says the key is unencrypted and that there is no recovery phrase, makes the account, asks for a
// backup, registers a name, points it, and leads to Back up.
//
//   CHROME=<path to chrome> node tests/lns_ui.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8121, BASE = `http://127.0.0.1:${PORT}`, PIN = "246813";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
let prof = "";
const stop = () => { for (const p of procs) { try { p.kill(p === app ? "SIGTERM" : "SIGKILL"); } catch {} } if (prof) { try { rmSync(prof, { recursive: true, force: true }); } catch {} } };
let failed = false;
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 400) : "")); if (!ok) { failed = true; stop(); process.exit(1); } };

const app = spawn("python3", [join(here, "lns_ui_app.py"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
procs.push(app);
await new Promise((ok) => app.stdout.on("data", (d) => { if (String(d).includes("ready")) ok(); }));
const post = async (path, body, session) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(session ? { "X-Session": session } : {}) }, body: JSON.stringify(body) })).json();
const session = (await post("/api/wallet/setup", { pin: PIN })).session;

const cport = 9343; prof = mkdtempSync(join(tmpdir(), "chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cport}`, `--user-data-dir=${prof}`, "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
procs.push(chrome);
let target;
for (let i = 0; i < 600 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json()).find(t => t.type === "page"); } catch {} if (!target) await sleep(100); }
check("Chrome starts", !!target);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok));
let seq = 0; const waiting = new Map(), errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const js = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr + ": " + JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no ${sel}"); e.click(); return true; })()`);
const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
const shown = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null; })()`);
const waitFor = async (name, expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await js(expr); } catch { v = false; } if (v) return check(name, true); await sleep(150); } check(name, false, await text("#s-lns")); };

// the page with the session already open, as after an unlock
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("the page loads", `document.readyState === "complete"`);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("unlocked", `!document.getElementById("v-open").hidden`);
check("Your name isn't in the wallet home", !(await shown("#s-lns")));
await click("#b-gear");
await waitFor("Settings shows Your name", `!!document.getElementById("s-lns") && !document.getElementById("s-lns").hidden`);
const intro = await text("#s-lns");
check("it says the key is kept unencrypted, and that there is no recovery phrase", /unencrypted/.test(intro) && /no recovery phrase/.test(intro), intro);
await click("#b-lns-acct");
await waitFor("the account shows, with its balance", `!document.getElementById("lns-acct").hidden && /5,000,000 LEZ testnet/.test(document.getElementById("lns-bal").innerText)`);
await waitFor("right away it asks for a new backup", `!document.getElementById("lns-bk").hidden`);
check("no long address or key shows", !/[0-9a-fA-F]{20,}|[1-9A-HJ-NP-Za-km-z]{30,}/.test(await text("#s-lns")), await text("#s-lns"));
await js(`(() => { const i = document.getElementById("lns-in"); i.value = "slow"; i.dispatchEvent(new Event("input")); return true; })()`);
await waitFor("a valid name enables Register", `!document.getElementById("b-lns-reg").disabled`);
await click("#b-lns-reg");
await waitFor("it says the registration is under way", `/Registering slow/.test(document.getElementById("m-lns").innerText)`, 5000);
check("while it runs, the page doesn't offer a backup", await js(`document.getElementById("lns-bk").hidden`));
await waitFor("then that slow is yours", `/slow is yours/.test(document.getElementById("m-lns").innerText)`, 20000);
await waitFor("and now it asks for a backup again", `!document.getElementById("lns-bk").hidden`);
await waitFor("the name shows bare", `document.getElementById("lns-name").innerText === "slow"`);
await click("#b-lns-bc");
await waitFor("pointing it at this wallet finishes", `/now points at this wallet/.test(document.getElementById("m-lns").innerText)`, 20000);
check("Point it at my messaging address waits for messages", await js(`document.getElementById("b-lns-msg").disabled`));
await click("#b-lns-bk");
await waitFor("Back up now opens Back up", `!document.getElementById("s-bk").hidden && document.activeElement && document.activeElement.id === "bk-pw1"`);
check("no page errors", errors.length === 0, errors);
stop();
console.log("all checks passed");
process.exit(0);

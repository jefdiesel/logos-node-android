// The Wallet's network switch (app/net04/net04.js) in a real browser (headless Chrome over the DevTools protocol), at
// phone width, with the stand-ins of tests/lns_ui_app.py and the bridge test network answering from the answers
// recorded in tests/fixtures/net04: LEZ 0.3 by default with its full name beside it, every action saying which network
// it runs on, LEZ 0.4 showing the phone's own LEZ account and watched addresses (view-only), the watch field refusing
// what isn't a 32-byte id and echoing the id it took, Send and Receive saying they aren't available there (and the page
// sending nothing), the network unreachable and reset, the eye, no green or blue, and LEZ 0.3 again after a reload.
//
//   CHROME=<path to chrome> SHOTS=<folder, optional> node tests/net04_ui.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { noGreenOrBlue } from "./hue_check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8141 + Number(process.env.PORT_SHIFT || 0), BASE = `http://127.0.0.1:${PORT}`, PIN = "246813";
const OWN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";        // the stand-in signer's account (tests/fake_names_bin.py)
const BASECAMP = "CCVd76Tk3WvFb63Wbuu4exMeLRTbSuMWHqxuvysapKnk";   // the account recorded in tests/fixtures/net04
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
let prof = "";
const stop = () => { for (const p of procs) { try { p.kill(p === app ? "SIGTERM" : "SIGKILL"); } catch {} } if (prof) { try { rmSync(prof, { recursive: true, force: true }); } catch {} } };
process.on("uncaughtException", e => { console.error(e); stop(); process.exit(1); });     // Chrome and its profile go too
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 400) : "")); if (!ok) { stop(); process.exit(1); } };

const app = spawn("python3", [join(here, "lns_ui_app.py"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
procs.push(app);
const NET = await new Promise((ok) => app.stdout.on("data", (d) => { const m = /net04 (\d+)/.exec(String(d)); if (m) ok(Number(m[1])); }));
const net04 = (mode) => fetch(`http://127.0.0.1:${NET}/ctl/net04/${mode}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
const post = async (path, body, session) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(session ? { "X-Session": session } : {}) }, body: JSON.stringify(body) })).json();
const session = (await post("/api/wallet/setup", { pin: PIN })).session;

const cport = 9363 + Number(process.env.PORT_SHIFT || 0); prof = mkdtempSync(join(tmpdir(), "chrome-"));
// never drive a browser this test didn't start: a DevTools port that already answers may be an adb forward to a phone
if (await fetch(`http://127.0.0.1:${cport}/json/version`).then(() => true, () => false)) { console.error(`port ${cport} already has a DevTools endpoint (an adb forward?); set PORT_SHIFT or free it`); stop(); process.exit(1); }
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
const words = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
const shown = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null; })()`);
const waitFor = async (name, expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await js(expr); } catch { v = false; } if (v) return check(name, true); await sleep(150); } check(name, false, { errors, page: (await text("#v-open")).slice(0, 500) }); };
const val = (sel, v) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); return true; })()`);

const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let shotN = 0;
const shot = async (name) => { await noGreenOrBlue(js, check, name); if (!SHOTS) return; const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, `net04-${String(++shotN).padStart(2, "0")}-${name}.png`), Buffer.from(r.result.data, "base64")); };
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.LogosAndroid = { scanQr() {}, openNode() {}, unlockWithFingerprint() {}, setTheme() {} };" });
// every request the page makes, so the test can show what the LEZ 0.4 view asks for
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.__req = []; const __f = window.fetch; window.fetch = (u, o) => { window.__req.push(((o && o.method) || 'GET') + ' ' + String(u)); return __f(u, o); };" });

// ---- the name account exists (made through the app, with the stand-in signer) ----
await post("/api/wallet/lns/account", {}, session);
for (let i = 0; i < 100; i++) { const b = await (await fetch(BASE + "/api/wallet/lns/balance", { headers: { "X-Session": session } })).json(); if (b.account) break; await sleep(200); }

await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("the page loads, locked", `document.readyState === "complete" && !document.getElementById("v-locked").hidden`);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("unlocked", `!document.getElementById("v-open").hidden`);

// ---- LEZ 0.3 by default, its full name beside the switch ----
await waitFor("the switch: LEZ 0.3 | LEZ 0.4, above the token list", `!!document.querySelector("#net-sw .netsw") && document.getElementById("net-sw").offsetParent !== null`);
check("the two choices", (await js(`[...document.querySelectorAll("#net-sw .seg button")].map(b => b.textContent).join("|")`)) === "LEZ 0.3|LEZ 0.4");
check("LEZ 0.3 is chosen", (await js(`document.getElementById("nw-03").getAttribute("aria-checked")`)) === "true" && (await js(`document.getElementById("nw-04").getAttribute("aria-checked")`)) === "false");
check("its full name beside it: public Logos testnet", (await text("#nw-name")) === "public Logos testnet");
check("the token list shows; the 0.4 view doesn't", (await shown("#tokens")) && !(await shown("#net04")));
const all = (await words("#v-open")).toLowerCase();
check("never 'official'", !/official/.test(all));
check("Send says it runs on the public Logos testnet", /Runs on the public Logos testnet\./.test(await words("#p-send")));
check("Receive says so too", /on the public Logos testnet\./.test(await words("#p-recv")));
check("Get this name and Get LEZ say which network", /Runs on the public Logos testnet \(LEZ 0\.3\)\.Not on the bridge test network \(LEZ 0\.4\)\./.test(await js(`document.body.textContent`))
  && /Both run on the public Logos testnet \(LEZ 0\.3\)\./.test(await js(`document.body.textContent`)));
await shot("lez-0.3");

// ---- LEZ 0.4: the phone's own LEZ account and what it holds there ----
await js(`window.__req = []; true`);
await click("#nw-04");
check("LEZ 0.4 is chosen, its full name beside it: bridge test network", (await js(`document.getElementById("nw-04").getAttribute("aria-checked")`)) === "true" && (await text("#nw-name")) === "bridge test network");
await waitFor("the 0.3 token list, tabs and panels are hidden; the 0.4 view shows", `document.getElementById("tokens").offsetParent === null && document.querySelector(".wtabs").offsetParent === null && document.getElementById("net04").offsetParent !== null`);
check("the view says it is read-only", /read-only/.test(await text("#n4-about")));
await waitFor("the phone's own LEZ account, read from the bridge test network: LEZ and 0.1 wETH", `(() => { const t = document.getElementById("n4-accts").innerText;
  return /This phone's LEZ account/.test(t) && t.includes(${JSON.stringify(OWN)}) && /LEZ: 23,786,858/.test(t) && /wETH: 0\\.1\\b/.test(t) && /Wrapped Sepolia ETH \\(demo\\)/.test(t) && /dUSDC: 0/.test(t) && /As of .*, bridge test network/.test(t); })()`, 20000);
check("private balances: said not to be shown", /Private balances on the bridge test network are not shown yet\./.test(await text("#n4-private")));
await shot("lez-0.4-own");

// ---- Send and Receive on 0.4 say they aren't available, and send nothing ----
check("the 0.4 message is hidden at first", !(await shown("#n4-na")));
await click("#n4-send");
await waitFor("Send on 0.4: Not available on the bridge test network yet.", `document.getElementById("n4-na").offsetParent !== null && document.getElementById("n4-na").textContent === "Not available on the bridge test network yet."`);
await click("#nw-03"); await click("#nw-04");
check("the message goes with a switch", !(await shown("#n4-na")));
await click("#n4-recv");
await waitFor("Receive on 0.4: the same", `document.getElementById("n4-na").offsetParent !== null`);
await shot("lez-0.4-not-available");

// ---- watch an address ----
await val("#n4-watch", "hello");
await click("#n4-add");
await waitFor("a word that isn't an id is refused, plainly", `/isn't a public account id/.test(document.getElementById("n4-watch-m").textContent) && /32 bytes/.test(document.getElementById("n4-watch-m").textContent)`);
await val("#n4-watch", BASECAMP.slice(0, 40));
await click("#n4-add");
await waitFor("a cut-off id is refused", `/isn't a public account id/.test(document.getElementById("n4-watch-m").textContent) && document.getElementById("n4-watch").value.length === 40`);
await val("#n4-watch", "  Public/" + BASECAMP + " ");
await click("#n4-add");
await waitFor("a Basecamp account id (with Public/) is taken, and the canonical id is shown back to compare", `document.getElementById("n4-watch-m").textContent.includes(${JSON.stringify(BASECAMP)}) && /view-only/.test(document.getElementById("n4-watch-m").textContent) && document.getElementById("n4-watch").value === ""`);
await waitFor("the watched account shows, marked view-only, with its bridged coins", `(() => { const c = [...document.querySelectorAll("#n4-accts .n4-acct")]; const w = c.find(e => e.textContent.includes(${JSON.stringify(BASECAMP)}));
  return c.length === 2 && !!w && /Watched, view-only/.test(w.innerText) && /wETH: 0\\.1\\b/.test(w.innerText) && /Stop watching/.test(w.innerText); })()`, 20000);
check("the phone's own account has no Stop watching", !/Stop watching/.test(await js(`document.querySelector("#n4-accts .n4-acct").innerText`)));
await shot("lez-0.4-watched");

// ---- the eye (on the 0.3 token list) hides the numbers on 0.4 too ----
await click("#nw-03"); await click("#b-eye"); await click("#nw-04");
await waitFor("the eye: no number shows on 0.4", `!/23,786,858|0\\.1\\b/.test(document.getElementById("n4-accts").innerText) && /LEZ: /.test(document.getElementById("n4-accts").innerText)`);
await click("#nw-03"); await click("#b-eye"); await click("#nw-04");

// ---- the network unreachable, then reset ----
await net04("down");
await sleep(1200);
await click("#nw-03"); await click("#nw-04");
await waitFor("unreachable: says so, keeps the last numbers with their time", `/Can't reach the bridge test network now\\./.test(document.getElementById("n4-state").textContent) && !document.getElementById("n4-state").hidden && /LEZ: 23,786,858/.test(document.getElementById("n4-accts").innerText) && /As of /.test(document.getElementById("n4-accts").innerText)`, 20000);
await shot("lez-0.4-unreachable");
await net04("reset");
await sleep(6500);                         // a 503 makes the reader wait 5 s before asking again
await click("#nw-03"); await click("#nw-04");
await waitFor("reset: says the network was reset", `/The bridge test network was reset\\./.test(document.getElementById("n4-state").textContent)`, 20000);
await shot("lez-0.4-reset");

// ---- Stop watching ----
await js(`[...document.querySelectorAll("#n4-accts .n4-acct")].find(e => e.textContent.includes(${JSON.stringify(BASECAMP)})).querySelector("button").click(); true`);
await waitFor("Stop watching takes it away", `![...document.querySelectorAll("#n4-accts .n4-acct")].some(e => e.textContent.includes(${JSON.stringify(BASECAMP)}))`);

// ---- what the 0.4 view asked for: only its own routes ----
const reqs = await js(`window.__req.slice()`);
// (the Wallet's own background reads go on as before: status, accounts, history, and the receipts it pops up)
const other = reqs.filter(r => /^POST /.test(r) && !["POST /api/wallet/net04/watch", "POST /api/wallet/receipts"].includes(r));
check("on 0.4 the page posted only to its watch route (no send, no bridge, no name)", other.length === 0 && reqs.some(r => /net04/.test(r)), other);
check("never a send route", !reqs.some(r => /send|bridge|register|faucet/.test(r)), reqs);

// ---- back to LEZ 0.3, and 0.3 again after a reload ----
await click("#nw-03");
await waitFor("LEZ 0.3: the token list again, the 0.4 view gone", `document.getElementById("tokens").offsetParent !== null && document.getElementById("net04").offsetParent === null`);
await click("#nw-04");
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("after a reload: unlocked", `!document.getElementById("v-open").hidden && !!document.getElementById("nw-03")`);
check("after a reload: LEZ 0.3 again", (await js(`document.getElementById("nw-03").getAttribute("aria-checked")`)) === "true" && (await shown("#tokens")) && !(await shown("#net04")));

check("no page errors", errors.length === 0, errors);
stop();
console.log("all checks passed");
process.exit(0);

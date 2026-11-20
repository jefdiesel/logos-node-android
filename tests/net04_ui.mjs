// The Wallet's LEZ 0.4 part (app/net04/net04.js) in a real browser (headless Chrome over the DevTools protocol), at
// phone width, with the stand-ins of tests/ui_app.py (the phone's LEZ 0.4 wallet set up already) and LEZ 0.4 answering
// from the answers recorded in tests/fixtures/net04: the Logos coins always on the Wallet with LEZ 0.4 below them (no
// network switch any more), the phone's own LEZ account and watched addresses (view-only), the watch field refusing
// what isn't a 32-byte id and echoing the id it took, Send and Receive opening the signer's panels (Receive: the account
// and its public key as one item), the network unreachable and reset, the eye, no green or blue, and nothing left after
// a lock.
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
const OWN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";        // the phone's LEZ 0.4 account (tests/ui_app.py)
const BASECAMP = "CCVd76Tk3WvFb63Wbuu4exMeLRTbSuMWHqxuvysapKnk";   // the account recorded in tests/fixtures/net04
const LATE = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";       // an id watched while the page locks
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
let prof = "";
const stop = () => { for (const p of procs) { try { p.kill(p === app ? "SIGTERM" : "SIGKILL"); } catch {} } if (prof) { try { rmSync(prof, { recursive: true, force: true }); } catch {} } };
process.on("uncaughtException", e => { console.error(e); stop(); process.exit(1); });     // Chrome and its profile go too
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 400) : "")); if (!ok) { stop(); process.exit(1); } };

const app = spawn("python3", [join(here, "ui_app.py"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
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
if (process.env.SHOTS) await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.DARK ? "dark" : "light" }] });   // (screenshots)
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

await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("the page loads, locked", `document.readyState === "complete" && !document.getElementById("v-locked").hidden`);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("unlocked", `!document.getElementById("v-open").hidden`);

// Settings > Network, and back to the Wallet
const netPage = async () => { await js(`openSettings("s-net"); true`); await waitFor("Settings > Network", `!document.getElementById("page-settings").hidden && document.getElementById("s-net").offsetParent !== null`); };
const toWallet = async () => { await js(`closeSettings(); true`); await waitFor("the Wallet", `!document.getElementById("page-main").hidden && document.getElementById("page-settings").hidden`); };
const tall = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].every(e => e.getBoundingClientRect().height >= 44)`);
const again = async () => { await js(`openSettings(); true`); await toWallet(); };      // the Wallet shown again: it reads at once

// ---- the Wallet: the Logos coins, then LEZ 0.4 below them; no network switch any more ----
await waitFor("the Logos coins and LEZ 0.4, both on the Wallet", `document.getElementById("tokens").offsetParent !== null && document.querySelector(".wtabs").offsetParent !== null && document.getElementById("net04").offsetParent !== null`);
check("LEZ 0.4 comes after the Logos coins, under its own heading", await js(`(() => { const t = document.getElementById("tokens").getBoundingClientRect(), v = document.getElementById("net04"); return v.getBoundingClientRect().top > t.bottom && v.querySelector(".n4-head").textContent === "LEZ 0.4"; })()`));
check("no network switch anywhere, no LEZ 0.3", !(await js(`!!document.querySelector("#nw-03, #nw-04, #net-line, #net-sw")`)) && !/LEZ 0\.3/.test(await js(`document.body.textContent`)));
await waitFor("the phone's own LEZ account, read from LEZ 0.4: LEZ and 0.1 wETH", `(() => { const t = document.getElementById("n4-accts").innerText;
  return /This phone's LEZ account/.test(t) && t.includes(${JSON.stringify(OWN)}) && /LEZ: 23,786,858/.test(t) && /wETH: 0\\.1\\b/.test(t) && /Wrapped Sepolia ETH \\(demo\\)/.test(t) && /dUSDC: 0/.test(t) && /As of .*, LEZ 0\\.4/.test(t); })()`, 20000);
const all = (await words("#v-open")).toLowerCase();
check("never 'official', never 'bridge test network'", !/official|bridge test network/.test(all));
check("the Logos send screens name their network", /Network\s*Logos blockchain, public Logos testnet/.test(await words("#v-review")) && /Network\s*Logos blockchain, public Logos testnet/.test(await words("#v-sent")));
await shot("wallet-logos-and-lez-0.4");

// ---- Settings > Network: the LEZ 0.4 network in use and what it sees ----
await netPage();
check("no choice of network: only LEZ 0.4's", !(await js(`!!document.querySelector("#s-net .seg")`)));
await waitFor("what LEZ 0.4 tells its endpoint (the stand-in's host here)",
  `/^The wallet asks 127\\.0\\.0\\.1:\\d+ about this phone's LEZ 0\\.4 account, the addresses you watch, their NFTs and the LNS names it looks up; it sees them and your IP address\\.$/.test(document.getElementById("nw-asks").innerText)`);
check("the network in use is said", /^In use: our LEZ 0\.4 \(127\.0\.0\.1:\d+\)\.$/.test(await text("#n4-net-now")), await text("#n4-net-now"));
check("the watch field is there", await shown("#n4-watch"));
await toWallet();
await js(`openSettings(); true`);
await waitFor("Settings' list has a Network row saying which network", `!document.getElementById("go-net").hidden && document.querySelector("#go-net b").textContent === "Network" && /^LEZ 0\\.4 · 127\\.0\\.0\\.1:\\d+$/.test(document.querySelector("#go-net small").textContent)`);
await toWallet();

// ---- Send and Receive on LEZ 0.4: the signer's panels ----
check("the 'set up first' line is hidden", !(await shown("#n4-na")));
await click("#n4-send");
await waitFor("Send opens LEZ 0.4's Send", `document.getElementById("s4-send").offsetParent !== null`);
await click("#n4-recv");
await waitFor("Receive: the account and its public key, one Copy for both", `document.getElementById("s4-recv").offsetParent !== null && document.getElementById("s4-acct").textContent === "Public/${OWN}" && document.getElementById("s4-pk").textContent === "${"ab".repeat(32)}" && document.querySelectorAll("#s4-copy button").length === 1`);
check("Send is closed when Receive opens", !(await shown("#s4-send")));
await shot("lez-0.4-receive");
await click("#n4-recv");

// ---- watch an address, in Settings > Network ----
await netPage();
await val("#n4-watch", "hello");
await click("#n4-add");
await waitFor("a word that isn't an id is refused, plainly", `/isn't a public account id/.test(document.getElementById("n4-watch-m").textContent) && /32 bytes/.test(document.getElementById("n4-watch-m").textContent)`);
await val("#n4-watch", BASECAMP.slice(0, 40));
await click("#n4-add");
await waitFor("a cut-off id is refused", `/isn't a public account id/.test(document.getElementById("n4-watch-m").textContent) && document.getElementById("n4-watch").value.length === 40`);
await val("#n4-watch", "  Public/" + BASECAMP + " ");
await click("#n4-add");
await waitFor("a Basecamp account id (with Public/) is taken, and the canonical id is shown back to compare", `document.getElementById("n4-watch-m").textContent.includes(${JSON.stringify(BASECAMP)}) && /view-only/.test(document.getElementById("n4-watch-m").textContent) && document.getElementById("n4-watch").value === ""`);
await waitFor("Settings > Network lists it, with Stop watching", `(() => { const r = [...document.querySelectorAll("#n4-watched .n4-watched")]; return r.length === 1 && r[0].textContent.includes(${JSON.stringify(BASECAMP)}) && /Stop watching/.test(r[0].textContent); })()`, 20000);
check("the field, Watch and Stop watching are 44 px", await tall("#n4-watch, #n4-add, #n4-watched button"));
check("nothing in Settings > Network goes past the screen's edge (the ids break; the page never scrolls sideways)", await js(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll("#s-net *")].every(e => !e.offsetParent || e.getBoundingClientRect().right <= innerWidth + 1)`));
await shot("settings-network");
await toWallet();
await waitFor("the watched account shows on the Wallet, marked view-only, with its bridged coins", `(() => { const c = [...document.querySelectorAll("#n4-accts .n4-acct")]; const w = c.find(e => e.textContent.includes(${JSON.stringify(BASECAMP)}));
  return c.length === 2 && !!w && /Watched, view-only/.test(w.innerText) && /wETH: 0\\.1\\b/.test(w.innerText); })()`, 20000);
check("the Wallet's cards have no buttons (watching is changed in Settings)", !(await js(`!!document.querySelector("#n4-accts button")`)));
await shot("lez-0.4-watched");

// ---- the 0.4 view reads only while the Wallet shows: not under Settings ----
await js(`openSettings(); window.__req = []; document.dispatchEvent(new Event("visibilitychange")); true`);
await sleep(1500);
check("Settings open: no 0.4 read", !(await js(`window.__req.some(r => r.includes("/api/wallet/net04"))`)), await js(`window.__req`));
await js(`closeSettings(); window.__req = window.__req.filter(r => !r.includes("/api/wallet/visibility")); true`);   // (the page's own report of the test's event)
await waitFor("back on the Wallet: it reads again", `window.__req.some(r => r.includes("GET /api/wallet/net04"))`, 5000);

// ---- the eye (beside the Logos coins) hides LEZ 0.4's numbers too ----
await click("#b-eye"); await again();
await waitFor("the eye: no number shows on LEZ 0.4", `!/23,786,858|0\\.1\\b/.test(document.getElementById("n4-accts").innerText) && /LEZ: /.test(document.getElementById("n4-accts").innerText)`);
await click("#b-eye"); await again();

// ---- the network unreachable, then reset ----
await net04("down");
await sleep(1200);
await again();
await waitFor("unreachable: says so, keeps the last numbers with their time", `/Can't reach LEZ 0\\.4 now\\./.test(document.getElementById("n4-state").textContent) && !document.getElementById("n4-state").hidden && /LEZ: 23,786,858/.test(document.getElementById("n4-accts").innerText) && /As of /.test(document.getElementById("n4-accts").innerText)`, 20000);
await shot("lez-0.4-unreachable");
await net04("reset");
await sleep(6500);                         // a 503 makes the reader wait 5 s before asking again
await again();
await waitFor("reset: says the network was reset", `/LEZ 0\\.4 was reset\\./.test(document.getElementById("n4-state").textContent)`, 20000);
await shot("lez-0.4-reset");

// ---- Stop watching, in Settings > Network ----
await netPage();
await js(`[...document.querySelectorAll("#n4-watched .n4-watched")].find(e => e.textContent.includes(${JSON.stringify(BASECAMP)})).querySelector("button").click(); true`);
await waitFor("Stop watching takes it off the list", `![...document.querySelectorAll("#n4-watched .n4-watched")].some(e => e.textContent.includes(${JSON.stringify(BASECAMP)}))`);
await toWallet();
await waitFor("and off the Wallet", `![...document.querySelectorAll("#n4-accts .n4-acct")].some(e => e.textContent.includes(${JSON.stringify(BASECAMP)}))`);

// ---- what the 0.4 view asked for: only its own routes ----
const reqs = await js(`window.__req.slice()`);
// (the Wallet's own background reads go on as before: status, accounts, history, and the receipts it pops up)
const other = reqs.filter(r => /^POST /.test(r) && !["POST /api/wallet/net04/watch", "POST /api/wallet/receipts"].includes(r));
check("the page posted only to the watch route (no send, no name)", other.length === 0 && reqs.some(r => /net04/.test(r)), other);
check("never a send route", !reqs.some(r => /send|bridge|register|faucet/.test(r)), reqs);

// ---- a lock with LEZ 0.4 showing: nothing of it stays in the page ----
const relock = async () => { await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`); await cdp("Page.navigate", { url: BASE + "/" });
  await waitFor("unlocked again", `!document.getElementById("v-open").hidden`); };
await netPage();
await val("#n4-watch", BASECAMP); await click("#n4-add");
await waitFor("watching one", `document.getElementById("n4-watch-m").textContent.includes(${JSON.stringify(BASECAMP)})`, 20000);
await toWallet();
await waitFor("LEZ 0.4 with the phone's account and a watched one", `document.querySelectorAll("#n4-accts .n4-acct").length === 2 && /LEZ: 23,786,858/.test(document.getElementById("n4-accts").innerText)`, 20000);
await val("#n4-watch", "typed, not sent");
await js(`lockedNow(); true`);
await waitFor("locked: the page loaded again, into the lock screen", `!document.getElementById("v-locked").hidden && !document.documentElement.classList.contains("relock")`);
const left = await js(`(() => { const h = document.documentElement.outerHTML, v = document.getElementById("net04");
  return { own: h.includes(${JSON.stringify(OWN)}), watched: h.includes(${JSON.stringify(BASECAMP)}), amounts: /23,786,858|wETH: /.test(v.textContent),
    accts: document.getElementById("n4-accts").textContent, msg: document.getElementById("n4-watch-m").textContent, state: document.getElementById("n4-state").textContent,
    typed: document.getElementById("n4-watch").value }; })()`);
check("locked: no account id, watched id, amount, message or typed text of LEZ 0.4 left in the page",
  !left.own && !left.watched && !left.amounts && !left.accts && !left.msg && !left.state && !left.typed, left);
await relock();
await waitFor("after the unlock: LEZ 0.4 reads again", `/LEZ: 23,786,858/.test(document.getElementById("n4-accts").innerText)`, 20000);
// a Watch answered after a lock writes nothing
await js(`document.getElementById("n4-watch").value = ${JSON.stringify(LATE)}; document.getElementById("n4-add").click(); lockedNow(); true`);
await waitFor("locked with the Watch on its way", `!document.getElementById("v-locked").hidden && !document.documentElement.classList.contains("relock")`);
await sleep(1500);
const lateW = await js(`({ html: document.documentElement.outerHTML.includes(${JSON.stringify(LATE)}), msg: document.getElementById("n4-watch-m").textContent, accts: document.getElementById("n4-accts").textContent })`);
check("a Watch answered after the lock writes nothing behind it", !lateW.html && !lateW.msg && !lateW.accts, lateW);
await relock();
await post("/api/wallet/net04/watch", { remove: LATE }, session);

// ---- a read still on its way when the page locks renders nothing behind the lock ----
// (relockPage, the reload, held back so the page that is locking can be looked at)
const late = await js(`(async () => { relockPage = () => {}; document.getElementById("accts").replaceChildren();
  const p = api("/api/wallet/accounts"), q = loadAccounts(); lockedNow(); const r = await p; await q;
  await new Promise(ok => setTimeout(ok, 300));
  return { status: r.status, ok: r.ok, stale: r.stale, accts: document.querySelectorAll("#accts .acct").length, hidden: document.documentElement.classList.contains("relock") }; })()`);
check("a read answered after a lock is dropped: stale, nothing rendered, the page hidden", late.stale && !late.ok && late.status === 0 && late.accts === 0 && late.hidden, late);

check("no page errors", errors.length === 0, errors);
stop();
console.log("all checks passed");
process.exit(0);

// The lock, in a real browser (headless Chrome over the DevTools protocol), with the stand-ins of tests/lns_ui_app.py
// (a wallet holding 30,400,000 Logos, a stand-in node that takes sends, the LEZ name account, the bridge test
// network). Every way a lock comes (the Lock button, the auto-lock as a 401 to a poll, to a POST or to the
// visibility report) goes through one lock that reloads the page into the lock screen. After each, a scan of the
// whole page (every element, hidden ones too, every attribute and title, every field's value) finds no amount,
// address, account id or typed text; a Send review up at the lock can't be sent after the unlock (it starts again at
// its first step); a lock while the wallet's state is being read leaves the lock screen up, and unlocking works; an
// answer that comes after the lock is stale and nothing is sent once the page is locking; a send answered after the
// lock shows nothing and is not polled; and while locked the page asks for nothing but the lock screen's own reads.
//
//   CHROME=<path to chrome> node tests/lock_ui.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PS = Number(process.env.PORT_SHIFT || 0);
const PORT = 8161 + PS, BASE = `http://127.0.0.1:${PORT}`, PIN = "246813";
const OWN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";        // the stand-in signer's LEZ account
const KEY = "a1".repeat(32);                                         // the wallet's account (tests/lns_ui_app.py)
const TO = "cd".repeat(32), AMOUNT = "4321";                         // what is typed into Send
// none of this may be anywhere in a locked page
const SECRETS = [KEY, KEY.slice(0, 10), TO, TO.slice(0, 10), "30,400,000", "30400000", "30,000,000", "400,000", "4,321", AMOUNT, OWN, OWN.slice(0, 6),
  "23,786,858", "23786858", "wETH: 0.1", "Wrapped Sepolia", "Received 4,321"];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
let prof = "";
const stop = () => { for (const p of procs) { try { p.kill(p === app ? "SIGTERM" : "SIGKILL"); } catch {} } if (prof) { try { rmSync(prof, { recursive: true, force: true }); } catch {} } };
process.on("uncaughtException", e => { console.error(e); stop(); process.exit(1); });
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 500) : "")); if (!ok) { stop(); process.exit(1); } };

const app = spawn("python3", [join(here, "lns_ui_app.py"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
procs.push(app);
await new Promise((ok) => app.stdout.on("data", (d) => { if (/ready/.test(String(d))) ok(); }));
const post = async (path, body, session) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(session ? { "X-Session": session } : {}) }, body: JSON.stringify(body) })).json();
let session = (await post("/api/wallet/setup", { pin: PIN })).session;
await post("/api/wallet/lns/account", {}, session);
for (let i = 0; i < 100; i++) { const b = await (await fetch(BASE + "/api/wallet/lns/balance", { headers: { "X-Session": session } })).json(); if (b.account) break; await sleep(200); }

const cport = 9373 + PS; prof = mkdtempSync(join(tmpdir(), "chrome-"));
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
let seq = 0; const waiting = new Map(), errors = [], reqs = [];
let onPaused = null;
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Network.requestWillBeSent") reqs.push({ method: m.params.request.method, path: new URL(m.params.request.url).pathname + new URL(m.params.request.url).search });
  if (m.method === "Fetch.requestPaused" && onPaused) onPaused(m.params);
});
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Network.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.LogosAndroid = { scanQr() {}, openNode() {}, unlockWithFingerprint() {}, setTheme() {} };" });
const js = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr.slice(0, 200) + ": " + JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
const waitFor = async (name, expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await js(expr); } catch { v = false; } if (v) return check(name, true); await sleep(150); } check(name, false, { errors }); };
const val = (sel, v) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); return true; })()`);

// the whole page as text: every element (hidden ones too) with every attribute, without the scripts' source, and
// every field's value
const SCAN = `(() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll("script, style").forEach(x => x.remove());
  const store = s => { const o = {}; try { for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); } catch (e) {} return JSON.stringify(o); };
  return c.outerHTML + "\\n" + [...document.querySelectorAll("input, textarea, select")].map(i => i.value).join("\\n")
    + "\\n" + store(sessionStorage) + "\\n" + store(localStorage) + "\\n" + JSON.stringify(history.state); })()`;
async function nothingLeft(where) {
  const page = await js(SCAN);
  const found = SECRETS.filter(s => page.includes(s));
  check(`${where}: nothing of the open wallet anywhere in the page (hidden nodes, attributes, titles, fields), its storage or its history state`, found.length === 0, found);
}
const lockScreen = (why) => waitFor(why, `!document.getElementById("v-locked").hidden && !document.getElementById("lock").hidden && !document.documentElement.classList.contains("relock") && document.getElementById("v-open").hidden`);
async function unlockByPin(why) {
  await waitFor("the keypad", `!document.getElementById("lk-pad").hidden || !document.getElementById("b-enter-pin").hidden`);
  if (await js(`document.getElementById("lk-pad").hidden`)) await js(`document.getElementById("b-enter-pin").click(); true`);
  await js(`(() => { const ks = [...document.querySelectorAll("#keypad button")]; for (const d of ${JSON.stringify(PIN)}) ks.find(b => b.textContent === d).click(); document.getElementById("b-pin").click(); return true; })()`);
  await waitFor(why, `!document.getElementById("v-open").hidden && !!token`);
  session = await js(`token`);
}
const serverLock = () => post("/api/wallet/lock", {});
const since = (i) => reqs.slice(i).map(r => r.method + " " + r.path);

// ---- open, with the balance shown ----
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("the page loads, locked", `document.readyState === "complete" && !document.getElementById("v-locked").hidden`);
await unlockByPin("unlocked through the keypad");
await waitFor("the balance shows, and is in the total's title", `document.getElementById("bal-total").textContent.includes("30,400,000") && document.getElementById("bal-total").title.includes("30,400,000")`, 20000);

// ---- M1: a Send review up when the auto-lock comes by a 401: after the unlock it starts again, nothing is sent ----
await js(`walletPick("logos", "send"); true`);
await val("#to", TO); await val("#amount", AMOUNT);
await js(`document.getElementById("f-send").requestSubmit(); true`);
await waitFor("the review is up: amount and recipient", `!document.getElementById("v-review").hidden && document.getElementById("r-amount").textContent.includes("4,321") && document.getElementById("r-to").textContent.includes(${JSON.stringify(TO)})`);
let mark = reqs.length;
await serverLock();                                              // the server's auto-lock
await js(`loadHistory(); true`);                                 // the page's 15 s poll meets it: a 401
await lockScreen("the poll's 401: the lock screen");
await nothingLeft("locked by a poll's 401 during a Send review");
check("the lock reloaded the page (one lock for every path)", since(mark).includes("GET /"), since(mark));
await unlockByPin("unlocked");
check("after the unlock: no review and nothing pending", await js(`pending === null && document.getElementById("v-review").hidden && document.getElementById("v-sent").hidden`));
await js(`walletPick("logos", "send"); true`);
await waitFor("Send is at its first step, empty", `!document.getElementById("f-send").hidden && document.getElementById("to").value === "" && document.getElementById("amount").value === ""`);
await js(`document.getElementById("b-go").click(); true`);      // "Send now" of the review from before the lock
await sleep(1000);
check("nothing was sent: no send went out after the lock", !since(mark).some(r => r.startsWith("POST /api/wallet/send")), since(mark));

// ---- every other way a lock comes: the whole page is clean after each, and the unlock works ----
async function fillUp() {                                        // amounts, addresses and typed text on the page
  await js(`walletPick("logos", "recv"); true`);
  await waitFor("Receive shows the account", `document.getElementById("accts").textContent.includes(${JSON.stringify(KEY.slice(0, 10))}) || document.getElementById("accts").innerHTML.includes(${JSON.stringify(KEY)})`, 15000);
  await val("#to", TO); await val("#amount", AMOUNT); await val("#n4-watch", OWN);   // (typed, not sent)
  await js(`document.getElementById("pop-h").textContent = "Received 4,321 Logos"; true`);   // as a Received pop-up leaves it
}
const PATHS = [
  ["the Lock button", async () => { await js(`document.getElementById("b-lock").click(); true`); }],
  ["the visibility report's 401", async () => { await serverLock(); await js(`document.dispatchEvent(new Event("visibilitychange")); true`); }],
  ["a POST's 401 (the activity report)", async () => { await serverLock(); await js(`lastActivity = 0; dispatchEvent(new Event("pointerdown")); true`); }],
  ["the poll's 401 with LEZ 0.4 showing", async () => {
    await js(`document.getElementById("nw-04").click(); true`);
    await waitFor("LEZ 0.4 shows the phone's account", `document.getElementById("n4-accts").textContent.includes(${JSON.stringify(OWN)})`, 20000);
    await serverLock(); await js(`loadHistory(); true`); }],
];
for (const [how, lock] of PATHS) {
  await fillUp();
  mark = reqs.length;
  // first with the reload held back: the page that is locking is already empty, before it goes
  await js(`relockPage = () => { window.__relock = 1; }; true`);
  await lock();
  await waitFor(`(${how}: the lock has run)`, `window.__relock === 1 && locking`);
  await nothingLeft(`${how}, before the reload`);
  await js(`location.reload(); true`);
  await lockScreen(`locked by ${how}`);
  await nothingLeft(`after ${how}`);
  check(`(${how}: the page loaded again)`, since(mark).includes("GET /"), since(mark));
  await unlockByPin(`unlocked after ${how}`);
}

// ---- M3: a lock while the wallet's state is being read: the lock screen stays up, and unlocking works ----
await js(`document.getElementById("b-lock").click(); true`);
await lockScreen("locked");
let holding = true; const held = [];
onPaused = (q) => { if (holding) held.push(q.requestId); else cdp("Fetch.continueRequest", { requestId: q.requestId }); };
await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/api/wallet" }] });
await js(`(() => { const ks = [...document.querySelectorAll("#keypad button")]; if (document.getElementById("lk-pad").hidden) document.getElementById("b-enter-pin").click(); for (const d of ${JSON.stringify(PIN)}) ks.find(b => b.textContent === d).click(); document.getElementById("b-pin").click(); return true; })()`);
const t0 = Date.now(); while (!held.length && Date.now() - t0 < 10000) await sleep(100);
check("(the unlock's read of the wallet is on its way)", held.length > 0);
await js(`document.getElementById("b-lock").click(); true`);    // Lock now, right after the unlock
await sleep(500);
holding = false;
for (const id of held.splice(0)) await cdp("Fetch.continueRequest", { requestId: id });
await lockScreen("the lock screen, not a dead \"Try again.\" page");
await sleep(2000);
check("and it stays: the lock screen, no loading page", await js(`!document.getElementById("v-locked").hidden && document.getElementById("v-loading").hidden && document.getElementById("v-open").hidden`));
await cdp("Fetch.disable"); onPaused = null;
await unlockByPin("unlocking works");

// ---- answers that come after the lock are stale; once locking, nothing goes out ----
// (relockPage is the reload; held back here so the page that is locking can be looked at)
mark = reqs.length;
const late = await js(`(async () => {
  relockPage = () => { window.__relocked = (window.__relocked || 0) + 1; };
  const p1 = api("/api/wallet/receipts", {}), p2 = api("/api/wallet/accounts");
  lockedNow();
  const r1 = await p1, r2 = await p2, r3 = await api("/api/wallet/history"), r4 = await api("/api/wallet/send", { from: "x", to: "y", amount: "1" });
  return { post: !!r1.stale && !r1.ok, get: !!r2.stale && !r2.ok, after: !!r3.stale && !!r4.stale, relocked: window.__relocked, hidden: document.documentElement.classList.contains("relock"), token };
})()`);
check("a POST and a GET answered after the lock are stale (no data); requests made after it are refused; the page is hidden at once", late.post && late.get && late.after && late.relocked === 1 && late.hidden && late.token === null, late);
const sentAfter = since(mark).filter(r => r.startsWith("GET /api/wallet/history") || r.startsWith("POST /api/wallet/send"));
check("(nothing went out once the page was locking)", sentAfter.length === 0, sentAfter);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`);   // (the server's session is still open: a page-only lock)
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("open again", `!document.getElementById("v-open").hidden && !!token`);

// ---- a send answered after the lock: nothing of it shows, and it isn't polled while locked ----
await js(`walletPick("logos", "send"); true`);
await val("#to", TO); await val("#amount", "7");
await js(`document.getElementById("f-send").requestSubmit(); true`);
await waitFor("the review", `!document.getElementById("v-review").hidden && !document.getElementById("b-go").disabled`);
const heldR = [];
onPaused = (q) => heldR.push(q.requestId);
await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/api/wallet/send", requestStage: "Response" }] });
await js(`document.getElementById("b-go").click(); true`);
const t1 = Date.now(); while (!heldR.length && Date.now() - t1 < 10000) await sleep(100);
check("(the send went through on the server; its answer is held)", heldR.length === 1);
await serverLock();
await js(`loadHistory(); true`);
await lockScreen("locked while the send's answer was on its way");
for (const id of heldR.splice(0)) await cdp("Fetch.continueRequest", { requestId: id }).catch(() => {});
await cdp("Fetch.disable"); onPaused = null;
mark = reqs.length;
await sleep(6000);
check("the send's hash and Sent screen are nowhere in the locked page", await js(`document.getElementById("s-hash").textContent === "" && document.getElementById("v-sent").hidden`));
check("no /api/wallet/tx poll while locked", !since(mark).some(r => r.includes("/api/wallet/tx")), since(mark));

// ---- while locked the page asks for nothing but the lock screen's own reads ----
mark = reqs.length;
await sleep(17000);                                              // more than one 15 s poll and three 5 s status reads
const asked = since(mark).filter(r => / \/api\//.test(r));
check("locked for 17 s: only the node status is read", asked.length > 0 && asked.every(r => r === "GET /api/status"), asked);
await unlockByPin("and it opens as before");

check("no page errors", errors.length === 0, errors);
stop();
console.log("all checks passed");
process.exit(0);

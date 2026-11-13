// Your name and the Wallet's tokens (app/lns/lns.js, app/index.html) in a real browser (headless Chrome over the
// DevTools protocol), at phone width, with the stand-ins of tests/lns_ui_app.py (signer, sequencer, node API,
// faucet): the token list and its tabs, the LEZ row (none, Add LEZ, LEZ), Your name in short lines with its
// Details, what a name costs and how much is missing, the faucet, a bridge with its review, registering with the
// stepper, LEZ Receive and Send, the eye and the lock, scan routing, and Settings > Appearance.
//
//   CHROME=<path to chrome> SHOTS=<folder, optional> node tests/lns_ui.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8121 + Number(process.env.PORT_SHIFT || 0), BASE = `http://127.0.0.1:${PORT}`, PIN = "246813";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
let prof = "";
const stop = () => { for (const p of procs) { try { p.kill(p === app ? "SIGTERM" : "SIGKILL"); } catch {} } if (prof) { try { rmSync(prof, { recursive: true, force: true }); } catch {} } };
let failed = false;
process.on("uncaughtException", e => { console.error(e); stop(); process.exit(1); });     // Chrome and its profile go too
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 400) : "")); if (!ok) { failed = true; stop(); process.exit(1); } };

const app = spawn("python3", [join(here, "lns_ui_app.py"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
procs.push(app);
const SEQ = await new Promise((ok) => app.stdout.on("data", (d) => { const m = /ready (\d+)/.exec(String(d)); if (m) ok(Number(m[1])); }));
const ctl = (path) => fetch(`http://127.0.0.1:${SEQ}/ctl/${path}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
const post = async (path, body, session) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(session ? { "X-Session": session } : {}) }, body: JSON.stringify(body) })).json();
const session = (await post("/api/wallet/setup", { pin: PIN })).session;

const cport = 9343 + Number(process.env.PORT_SHIFT || 0); prof = mkdtempSync(join(tmpdir(), "chrome-"));
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
const shown = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null; })()`);
const waitFor = async (name, expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await js(expr); } catch { v = false; } if (v) return check(name, true); await sleep(150); } check(name, false, { errors, page: (await text("#s-lns")).slice(0, 300) }); };

const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let shotN = 0;
const shot = async (name) => { if (!SHOTS) return; const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, `lns-${String(++shotN).padStart(2, "0")}-${name}.png`), Buffer.from(r.result.data, "base64")); };
const val = (sel, v) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); return true; })()`);
const words = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
// a stand-in for the Android app's scanner: the test answers each scan itself
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.__scans = 0; window.LogosAndroid = { scanQr() { window.__scans++; }, openNode() {}, unlockWithFingerprint() {}, setTheme(bg) { window.__theme = bg; } };" });
// counts the page's calls to the server's Your name and LEZ routes (the battery checks)
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.__lns = 0; const __f = window.fetch; window.fetch = (u, o) => { if (/\\/api\\/wallet\\/lns/.test(String(u))) window.__lns++; return __f(u, o); };" });

// ---- the page with the session already open, as after an unlock ----
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("the page loads, locked", `document.readyState === "complete" && !document.getElementById("v-locked").hidden`);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("unlocked", `!document.getElementById("v-open").hidden`);

// ---- the Wallet: tokens, then Send / Receive / Activity ----
const rows = () => js(`[...document.querySelectorAll("#tokens .tok")].map(b => b.querySelector("b").textContent)`);
await waitFor("the token list: Logos, and a quiet Add LEZ row (no name account yet)", `JSON.stringify([...document.querySelectorAll("#tokens .tok")].map(b => b.querySelector("b").textContent)) === '["Logos","Add LEZ"]'`);
check("Logos has the lambda mark, on the left", await js(`(() => { const r = document.getElementById("tok-logos"); return !!r.querySelector(".tok-ic svg path") && r.firstElementChild.classList.contains("tok-ic"); })()`));
check("Logos is picked, the tabs are Send, Receive, Activity, and Activity shows", await js(`document.getElementById("tok-logos").getAttribute("aria-checked") === "true"
  && [...document.querySelectorAll(".wtabs [role=tab]")].map(b => b.textContent).join() === "Send,Receive,Activity"
  && document.getElementById("t-act").getAttribute("aria-selected") === "true" && !document.getElementById("p-hist").hidden && document.getElementById("p-send").hidden`));
check("Your name isn't on the Wallet", !(await shown("#s-lns")));
await click("#t-recv");
check("Logos Receive: the QR, the address in full, Copy, and no balance", await js(`!document.getElementById("p-recv").hidden && /${"a1".repeat(32)}/.test(document.getElementById("p-recv").innerText) && /Copy/.test(document.getElementById("p-recv").innerText) && !/Logos|[0-9],[0-9]{3}/.test(document.getElementById("p-recv").innerText)`));
await click("#t-act");
await click("#tok-lez");
await waitFor("Add LEZ leads to making the name account", `!document.getElementById("page-settings").hidden && document.getElementById("h-settings").textContent === "Your name"`);

// ---- Your name: one field, one button, one cost line; the details behind More ----
await waitFor("Your name shows", `document.getElementById("s-lns").offsetParent !== null && !document.getElementById("lns-none").hidden`);
const intro = await text("#s-lns");
check("no paragraph: every line is short", intro.split("\n").every(l => l.length <= 70), intro);
check("no 'name account' in sight", !/name account/i.test(intro), intro);
const more = await words("#lns-more");
check("More says the key is kept unencrypted, that there is no recovery phrase, and that a backup is the only way back",
  /unencrypted/.test(more) && /no recovery phrase/.test(more) && /backup .* only way back/.test(more), more);
check("More is closed until asked", await js(`!document.getElementById("lns-more").open`));
await val("#lns-in", "slow");
await waitFor("the cost of the whole thing, and the time, in one line", `document.getElementById("lns-cost").innerText === "Costs 1,000,000 LEZ deposit + about 2,580,000 LEZ fees · about 20 minutes."`, 20000);
await shot("get-a-name");

// ---- one tap ----
await click("#b-lns-get");
await waitFor("the stepper: the name account made by itself, then LEZ: needs 4,418,236 more, with one button", `!document.getElementById("lns-flow").hidden
  && document.getElementById("lns-need").innerText === "Needs 4,418,236 more LEZ." && !document.getElementById("b-lns-addlez").hidden
  && /✓ Name account/.test(document.getElementById("lns-steps").innerText) && /→ LEZ · needs 4,418,236 more/.test(document.getElementById("lns-steps").innerText)`, 20000);
check("the other steps wait, in order", /Register\nPay to this wallet\nMessages to this phone/.test(await text("#lns-steps")), await text("#lns-steps"));
await shot("stepper-needs-lez");
await click("#b-lns-addlez");
await waitFor("Add LEZ: the Wallet, LEZ picked, Get LEZ open with the bridge filled in with what is missing", `document.getElementById("page-settings").hidden && tokSel === "lez"
  && !document.getElementById("lez-get").hidden && !document.getElementById("lns-brf").hidden && document.getElementById("lns-br-amt").value === "4418236"`);

// ---- the faucet ----
await click("#b-lns-faucet");
await waitFor("the faucet: what it sent", `document.getElementById("lns-brs").innerText === "Faucet sent 2,000,000 LEZ. Arrives in a minute or two."`);
await ctl("faucet/limit");
await click("#b-lns-faucet");
await waitFor("a refusal in the faucet's own words", `document.getElementById("lns-brs").innerText === "The faucet says: this account was funded in the last day"`);
await sleep(1500);

// ---- a bridge from Logos, with its review ----
await val("#lns-br-amt", "");
await js(`LNS.refresh(); true`);
await waitFor("the flow sees the grant: 2,418,236 more", `(LNS.refresh(), /needs 2,418,236 more/.test(document.getElementById("lns-steps").textContent))`, 20000);
await click("#b-lns-br"); await click("#b-lns-br");
await waitFor("the bridge form: one account with coins, so no From choice; what is missing filled in", `!document.getElementById("lns-brf").hidden && document.getElementById("lns-br-from").hidden && document.getElementById("lns-br-amt").value === "2418236"`);
await click("#b-lns-br-rev");
await waitFor("the review", `!document.getElementById("lns-brr").hidden`);
const rv = await text("#lns-brr");
const acctNow = (await (await fetch(BASE + "/api/wallet/lns/balance", { headers: { "X-Session": session } })).json()).account;
check("the review names where it goes: LEZ and the account in full", (await text("#lns-brr-to")) === "LEZ · Public/" + acctNow, await text("#lns-brr-to"));
check("it shows from, to LEZ, the amount, the fee, and that it takes time and can't be undone",
  /From\s+Main/.test(rv) && /To\s+LEZ/.test(rv) && /2,418,236 Logos → 2,418,236 LEZ/.test(rv) && /Up to 110,000 Logos/.test(rv) && /Takes minutes to hours\. Can't be undone\./.test(rv), rv);
await shot("bridge-review");
await click("#b-lns-br-go");
await waitFor("it starts by setting the amount aside", `/^Bridge 2,418,236: (Setting the amount aside|Sending to the bridge|Sent)/.test(document.getElementById("lns-brs").innerText)`);
await waitFor("and arrives", `/^Bridge 2,418,236: Arrived\./.test(document.getElementById("lns-brs").innerText)`, 30000);
await click("#b-eye");
await js(`LNS.home(true); true`);
await waitFor("the eye hides the bridge's amount too", `/^Bridge ••••••: Arrived\./.test(document.getElementById("lns-brs").innerText)`);
await click("#b-eye");
await waitFor("and shows it again", `/^Bridge 2,418,236:/.test(document.getElementById("lns-brs").innerText)`);
await click("#tok-logos"); await click("#t-act");
await waitFor("Logos Activity: the bridge as two rows of its own (set aside, bridged), each with its fee", `(() => { const t = document.getElementById("hist").innerText; return /Set aside for the bridge/.test(t) && /Bridged to LEZ/.test(t) && /−2,418,236 Logos/.test(t) && !/Changed outside this app/.test(t); })()`, 20000);

// ---- with LEZ there, the flow goes on by itself: register, then this wallet; Messages is off, so that waits ----
await js(`openSettings("s-lns"); true`);
await waitFor("register runs with no tap: the stepper says where it is", `/→ Register · step (1|2) of 2 · (sending|sent)|→ Register · waiting/.test(document.getElementById("lns-steps").innerText)`, 20000);
check("Keep the app open, in one line", (await text("#lns-keep")) === "Keep the app open.");
// off screen, the page asks nothing: no polling in the background
await js(`Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); true`);
await sleep(1000);
const asked = await js(`window.__lns`);
await sleep(7000);
check("off screen (the app in the background), the page asks the server nothing for Your name or LEZ", (await js(`window.__lns`)) === asked, [asked, await js(`window.__lns`)]);
await js(`Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); true`);
await waitFor("back on screen it asks again", `window.__lns > ${asked}`);
check("while it runs, the page doesn't offer a backup", await js(`document.getElementById("lns-bk").hidden`));
await shot("stepper-register");
await waitFor("then: slow is yours, paying to this wallet; messages wait for Messages to be on", `!document.getElementById("lns-has").hidden && document.getElementById("lns-name").innerText === "slow"
  && document.getElementById("lns-ent-bc").innerText === "Pays go to this wallet ✓" && /turn them on/.test(document.getElementById("lns-ent-msg").innerText)`, 40000);
await waitFor("and one button: Back up now", `!document.getElementById("lns-bk").hidden`);
check("nothing to tap but that: no point buttons offered", await js(`document.getElementById("lns-manual").hidden`));
const flowCalls = await js(`api("/api/wallet/lns").then(r => r.data.activity.filter(a => a.kind === "register" || a.kind === "text").map(a => a.kind + ":" + (a.entry || "")).join())`);
check("one register and one entry, nothing twice", flowCalls === "text:blockchain,register:", flowCalls);
await shot("name-is-yours");
await click("#b-lns-bk");
await waitFor("Back up now opens Back up", `!document.getElementById("s-bk").hidden && document.activeElement && document.activeElement.id === "bk-pw1"`);
await js(`closeSettings(); true`);
await cdp("Page.reload");
await waitFor("after a reload the page shows the same", `!document.getElementById("v-open").hidden`);
await js(`openSettings("s-lns"); true`);
await waitFor("still: slow is yours", `document.getElementById("lns-name").innerText === "slow" && document.getElementById("lns-ent-bc").innerText === "Pays go to this wallet ✓"`, 15000);

// ---- the LEZ token in the Wallet ----
await js(`closeSettings(); true`);
await js(`loadAccounts(); true`);
await waitFor("the LEZ row: initials on the left, its balance", `(() => { const r = document.getElementById("tok-lez"); return r.querySelector("b").textContent === "LEZ" && r.querySelector(".tok-ic").textContent === "LEZ" && /^[0-9,]+LEZ$/.test(r.querySelector(".tok-amt").textContent); })()`);
await shot("wallet-tokens");
// larger text, as a phone set to a bigger font size shows it: the Wallet drawn at 115% and 130% (CSS zoom on the
// Wallet, so its text is that much larger for the same 412 px of screen; the page sets its sizes in px, so a root
// font-size wouldn't change them). Token rows: the name and network may wrap, nothing is cut with "…", the
// balance is whole; Activity rows: a kind and an amount each stay on one line; nothing overflows.
await cdp("Emulation.setDeviceMetricsOverride", { width: 412, height: 900, deviceScaleFactor: 2, mobile: true });
await click("#tok-logos"); await click("#t-act");
for (const z of [1.15, 1.3]) {
  await js(`document.getElementById("v-open").style.zoom = "${z}"; fitHero(); true`);
  await sleep(300);
  const r = await js(`(() => {
    const out = [], card = document.querySelector("section.wallet").getBoundingClientRect();
    for (const row of document.querySelectorAll("#tokens .tok")) {
      const amt = row.querySelector(".tok-amt"), t = row.querySelector(".tok-t");
      for (const e of [row.querySelector("b"), row.querySelector("small")]) if (getComputedStyle(e).textOverflow === "ellipsis" || e.scrollWidth > e.clientWidth + 1) out.push(row.id + " text cut: " + e.textContent);
      if (amt.textContent && amt.scrollWidth > amt.clientWidth + 1) out.push(row.id + " balance cut: " + amt.textContent);
      if (amt.getBoundingClientRect().right > card.right + 1) out.push(row.id + " balance outside the card");
    }
    for (const h of document.querySelectorAll("#hist .hrow")) for (const e of h.querySelectorAll(".top > span")) {
      const lh = parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.45;
      if (e.getBoundingClientRect().height > lh * 1.5 * ${z}) out.push("activity: '" + e.textContent + "' breaks over lines");
      if (e.getBoundingClientRect().right > card.right + 1) out.push("activity: '" + e.textContent + "' outside the card");
    }
    if (document.documentElement.scrollWidth > innerWidth) out.push("sideways scroll");
    return out; })()`);
  check(`text at ${Math.round(z * 100)}%: token names and networks whole (wrapping, no "…"), balances whole, Activity rows tidy, nothing overflows`, r.length === 0, r);
  if (z === 1.3) await shot("wallet-tokens-large-text");
}
await js(`document.getElementById("v-open").style.zoom = ""; fitHero(); true`);
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await click("#tok-lez");
check("tapping LEZ picks it: its row marked, Logos not", await js(`document.getElementById("tok-lez").getAttribute("aria-checked") === "true" && document.getElementById("tok-logos").getAttribute("aria-checked") === "false"`));
await waitFor("LEZ Activity: what the app did (faucet, bridge, register, pointed)", `(() => { const t = document.getElementById("lez-act").innerText; return !document.getElementById("lez-act").hidden && /From the faucet/.test(t) && /Bridged from wallet/.test(t) && /Registered slow/.test(t) && /Pointed slow/.test(t); })()`);
check("and Logos' own Activity is hidden", await js(`document.getElementById("p-hist").hidden`));
await click("#t-recv");
const acct = (await (await fetch(BASE + "/api/wallet/lns/balance", { headers: { "X-Session": session } })).json()).account;
await waitFor("LEZ Receive: the QR, Public/ and the account in full, Copy", `!document.getElementById("lez-recv").hidden && document.getElementById("lez-addr").textContent === "Public/${acct}" && !!document.querySelector("#lez-qr svg path") && document.getElementById("b-lez-copy").textContent === "Copy"`);
check("no balance on Receive", !/[0-9],[0-9]{3}|LEZ [0-9]/.test(await text("#lez-recv")), await text("#lez-recv"));
check("the QR holds Public/ and the account", await js(`document.querySelector("#lez-qr .qr").dataset.text === "Public/${acct}"`));
await shot("lez-receive");

// ---- LEZ Send ----
const TO = "Public/3oRTrDMCWuSfnbUgUJCa1vqoedtUUi4xWmMdfJ4emVZC";
await click("#t-send");
await val("#lez-to", "public/3ortrdmcwusfnbugujca1vqoedtuui4xwmmdfj4emvzc"); await val("#lez-amt", "1000");
await js(`document.getElementById("f-lez-send").requestSubmit(); true`);
await waitFor("a lower-cased account is refused", `/Public\\/ and its ID/.test(document.getElementById("m-lez-send").innerText)`);
await val("#lez-to", TO); await val("#lez-amt", "99999999999");
await js(`document.getElementById("f-lez-send").requestSubmit(); true`);
await waitFor("more than the account holds is refused", `/^Not enough/.test(document.getElementById("m-lez-send").innerText)`);
await val("#lez-amt", "1,000");
await js(`document.getElementById("f-lez-send").requestSubmit(); true`);
await waitFor("the review: amount, to, fee, can't be undone", `!document.getElementById("lez-rv").hidden && document.getElementById("lez-rv-amt").innerText === "1,000 LEZ" && document.getElementById("lez-rv-to").innerText === ${JSON.stringify(TO)} && /^Up to [0-9,]+ LEZ$/.test(document.getElementById("lez-rv-fee").innerText) && /Can't be undone\./.test(document.getElementById("lez-rv").innerText)`);
await shot("lez-send-review");
await click("#b-lez-go");
await waitFor("sent: the balance moved", `document.getElementById("m-lez-send").innerText === "Sent 1,000 LEZ."`, 20000);

// ---- scans go where they belong ----
await click("#b-lez-scan");
check("Scan opens the scanner", await js(`window.__scans`) === 1);
await js(`logosScanned(${JSON.stringify("a1".repeat(32))}); true`);
await waitFor("a Logos address scanned in LEZ Send says so, with Send Logos", `/That's a Logos address\\./.test(document.getElementById("m-lez-scan").innerText) && !!document.querySelector("#m-lez-scan button")`);
await click("#m-lez-scan button");
check("Send Logos: the Logos row picked, Send open, the address filled", await js(`tokSel === "logos" && !document.getElementById("p-send").hidden && document.getElementById("to").value === "a1".repeat(32)`));
await click("#b-scan");
await js(`logosScanned(${JSON.stringify(TO)}); true`);
await waitFor("a LEZ account scanned in Logos Send says so, with Send LEZ", `/That's a LEZ account\\./.test(document.getElementById("m-scan").innerText) && !!document.querySelector("#m-scan button")`);
await click("#m-scan button");
check("Send LEZ: the LEZ row picked, its Send open, the account filled exactly (case kept)", await js(`tokSel === "lez" && !document.getElementById("lez-send").hidden && document.getElementById("lez-to").value === ${JSON.stringify(TO)}`));

// ---- the eye and the lock ----
await click("#b-eye");
await waitFor("the eye hides both balances", `document.getElementById("bal-total").textContent === "••••••" && document.querySelector("#tok-lez .tok-amt").textContent === "••••••"`);
await click("#b-eye");
await waitFor("and shows them again", `/LEZ$/.test(document.querySelector("#tok-lez .tok-amt").textContent)`);
await click("#t-recv");
await js(`lockedNow(); true`);
await waitFor("locked", `!document.getElementById("v-locked").hidden`);
check("the lock clears the LEZ balance and address", await js(`document.querySelector("#tok-lez .tok-amt").textContent === "" && document.getElementById("lez-addr").textContent === "" && !document.querySelector("#lez-qr svg")`));
check("and every LEZ field, the hidden ones too (reviews, amounts, lines)", await js(`["lns-brr-to", "lns-brr-amt", "lns-brr-fee", "lns-brs", "lez-rv-amt", "lez-rv-to", "lez-rv-fee", "m-lez-send", "lez-rows", "lns-steps"].every(id => document.getElementById(id).textContent === "")
  && ["lez-to", "lez-amt", "lns-br-amt"].every(id => document.getElementById(id).value === "")`));
await js(`(async () => { window.__late = true; })(); LNS.home(true); lockedNow(); true`);
await sleep(1500);
check("a LEZ answer that comes back after the lock writes nothing", await js(`document.querySelector("#tok-lez .tok-amt").textContent === ""`));

// ---- Settings > Appearance ----
await post("/api/wallet/lock", {}, session);
const s2 = (await post("/api/wallet/unlock", { pin: PIN })).session;
await js(`setToken(${JSON.stringify(s2)}); loadWallet(); true`);
await waitFor("unlocked again", `!document.getElementById("v-open").hidden`);
const bg = () => js(`getComputedStyle(document.body).backgroundColor`);
for (const [v, want] of [["dark", "rgb(17, 17, 15)"], ["light", "rgb(244, 242, 236)"]]) {
  await js(`openSettings("s-look"); true`);
  await waitFor(`Appearance opens`, `document.getElementById("s-look").offsetParent !== null`);
  await click(`#th-${v}`);
  check(`${v}: the page turns ${v}, the choice is kept on this device, and the Android app is told`, (await bg()) === want && await js(`localStorage.getItem("theme") === "${v}" && window.__theme === "${want}"`), await bg());
  check(`${v}: Settings' row says it`, (await text("#go-look small")) === (v === "dark" ? "Dark" : "Light"));
  await cdp("Page.navigate", { url: BASE + "/" });
  await waitFor(`${v}: set before the page draws (after a reload)`, `document.documentElement.dataset.theme === "${v}"`);
  check(`${v}: the lock screen and keypad too`, (await bg()) === want && await js(`getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "${want === "rgb(17, 17, 15)" ? "#11110f" : "#f4f2ec"}"`));
  if (v === "dark") await shot("locked-dark");
  await js(`setToken(${JSON.stringify(s2)}); loadWallet(); true`);
  await waitFor("unlocked", `!document.getElementById("v-open").hidden`);
}
await js(`openSettings("s-look"); true`);
await click("#th-system");
check("System: nothing kept, the page follows the phone", await js(`localStorage.getItem("theme") === null && !document.documentElement.dataset.theme`));
for (const scheme of ["dark", "light"]) {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  check(`System with the phone in ${scheme}: ${scheme}`, (await bg()) === (scheme === "dark" ? "rgb(17, 17, 15)" : "rgb(244, 242, 236)"));
}
check("no page errors", errors.length === 0, errors);
stop();
console.log("all checks passed");
process.exit(0);

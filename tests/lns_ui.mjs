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

// ---- Your name: short lines, details behind one fold ----
const intro = await text("#s-lns");
check("no paragraph: every line is short", intro.split("\n").every(l => l.length <= 60), intro);
const details = await words("#lns-more");
check("Details says the key is kept unencrypted, that there is no recovery phrase, and that a backup is the only way back",
  /unencrypted/.test(details) && /no recovery phrase/.test(details) && /backup .* only way back/.test(details), details);
check("Details is closed until asked", await js(`!document.getElementById("lns-more").open`));
await click("#b-lns-acct");
await waitFor("the account shows, with its balance in LEZ", `!document.getElementById("lns-acct").hidden && document.getElementById("lns-bal").innerText === "0 LEZ"`);
await waitFor("what a name costs, in one line: the deposit and the fees it should really take", `document.getElementById("lns-cost").innerText === "Costs 1,000,000 LEZ deposit + about 1,520,000 LEZ fees."`, 20000);
await waitFor("and how much is missing", `document.getElementById("lns-need").innerText === "You need 3,485,926 more LEZ."`);
await waitFor("right away it asks for a new backup", `!document.getElementById("lns-bk").hidden`);
await val("#lns-in", "slow");
check("Register waits for the LEZ, and says why", await js(`document.getElementById("b-lns-reg").disabled && document.getElementById("lns-why").innerText === "Needs 3,485,926 LEZ. Get LEZ above."`), await text("#lns-why"));
check("I already hold it works without LEZ", await js(`!document.getElementById("b-lns-link").disabled`));
await shot("your-name-short");

// ---- the faucet ----
await click("#b-lns-faucet");
await waitFor("the faucet: what it sent", `document.getElementById("lns-brs").innerText === "Faucet sent 2,000,000 LEZ. Arrives in a minute or two."`);
await ctl("faucet/limit");
await click("#b-lns-faucet");
await waitFor("a refusal in the faucet's own words", `document.getElementById("lns-brs").innerText === "The faucet says: this account was funded in the last day"`);
await sleep(1200);
await js(`LNS.refresh(); true`);
await waitFor("the grant arrives: 1,485,926 more", `document.getElementById("lns-need").innerText === "You need 1,485,926 more LEZ."`);

// ---- a bridge from the wallet, with its review ----
await click("#b-lns-br");
await waitFor("the bridge form: one account with coins, so no From choice; the missing amount filled in", `!document.getElementById("lns-brf").hidden && document.getElementById("lns-br-from").hidden && document.getElementById("lns-br-amt").value === "1485926"`);
await click("#b-lns-br-rev");
await waitFor("the review", `!document.getElementById("lns-brr").hidden`);
const rv = await text("#lns-brr");
check("it shows from, to your name account, the amount, the fee, and that it takes time and can't be undone",
  /From\s+Main/.test(rv) && /To\s+Your name account/.test(rv) && /1,485,926 Logos → 1,485,926 LEZ/.test(rv) && /Up to 110,000 Logos/.test(rv) && /Takes minutes to hours\. Can't be undone\./.test(rv), rv);
await shot("bridge-review");
await click("#b-lns-br-go");
await waitFor("it starts by setting the amount aside", `/^Bridge 1,485,926: (Setting the amount aside|Sending to the bridge|Sent)/.test(document.getElementById("lns-brs").innerText)`);
await waitFor("and arrives", `/^Bridge 1,485,926: Arrived\./.test(document.getElementById("lns-brs").innerText)`, 30000);
await waitFor("now nothing is missing, and Register is on", `document.getElementById("lns-need").hidden && !document.getElementById("b-lns-reg").disabled && document.getElementById("lns-why").hidden`);

// ---- register: a short stepper ----
await click("#b-lns-reg");
await waitFor("the stepper: Registering slow, step 1 of 2, keep the app open", `!document.getElementById("lns-step").hidden && document.getElementById("lns-step-t").innerText === "Registering slow" && /^Step 1 of 2 · (sending|sent)$/.test(document.getElementById("lns-step-s").innerText) && /Keep the app open\./.test(document.getElementById("lns-step").innerText)`, 5000);
check("while it runs, the page doesn't offer a backup", await js(`document.getElementById("lns-bk").hidden`));
await shot("register-stepper");
await waitFor("then: slow is yours", `document.getElementById("m-lns").innerText === "slow is yours."`, 20000);
await waitFor("and now it asks for a backup again", `!document.getElementById("lns-bk").hidden`);
await waitFor("the name shows bare", `document.getElementById("lns-name").innerText === "slow"`);
await click("#b-lns-bc");
await waitFor("pointing it at this wallet: Done.", `document.getElementById("m-lns").innerText === "Done."`, 20000);
check("Point it at my messages waits for messages", await js(`document.getElementById("b-lns-msg").disabled`));
await click("#b-lns-bk");
await waitFor("Back up now opens Back up", `!document.getElementById("s-bk").hidden && document.activeElement && document.activeElement.id === "bk-pw1"`);

// ---- the LEZ token in the Wallet ----
await js(`closeSettings(); true`);
await js(`loadAccounts(); true`);
await waitFor("the LEZ row: initials on the left, its balance", `(() => { const r = document.getElementById("tok-lez"); return r.querySelector("b").textContent === "LEZ" && r.querySelector(".tok-ic").textContent === "LEZ" && /^[0-9,]+LEZ$/.test(r.querySelector(".tok-amt").textContent); })()`);
await shot("wallet-tokens");
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

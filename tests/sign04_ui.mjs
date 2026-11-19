// Sending on LEZ 0.4 (app/net04/sign04.js, and Collectibles' Claim / Send / Receive in app/net04/nft.js) in a real
// browser (headless Chrome over the DevTools protocol) at 360 px, with the stand-ins of tests/lns_ui_app.py run with
// WITH_SIGNER04=1 (the stand-in LEZ 0.4 tool and network): the recovery-phrase card, Send before it ("restore first"),
// the restore ("Restoring…" at once, the box emptied as the request goes, the phrase in no request but that one and
// nowhere in the page after), "Get free test LEZ" ("Asking the faucet…", then the amount, then gone), Send ("Sending…",
// then in a block), Receive (the account, its QR code and its public key), Collectibles: "Claim NFT (free)" on a name
// the wallet holds with no NFT, "Claiming…" with the job's progress, then the card; an NFT's Send sheet and the
// Receive sheet; 44 px targets, nothing wider than the screen, no green or blue outside the card; a lock leaving
// nothing behind.
//
//   CHROME=<path to chrome> SHOTS=<folder, optional> node tests/sign04_ui.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { noGreenOrBlue } from "./hue_check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8161 + Number(process.env.PORT_SHIFT || 0), BASE = `http://127.0.0.1:${PORT}`, PIN = "246813";
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";   // a public BIP-39 test vector
const PROGRAM = "ErycMYqXUUtducaYmpHZjRgdbLXchrMiV4NZRnmRDNmu", ART = "HA47ERcmfSbDChGcYfBcC4SKaPQ8pJJnv4wxCLu1ejL5";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
let prof = "";
const stop = () => { for (const p of procs) { try { p.kill(p === app ? "SIGTERM" : "SIGKILL"); } catch {} } if (prof) { try { rmSync(prof, { recursive: true, force: true }); } catch {} } };
process.on("uncaughtException", e => { console.error(e); stop(); process.exit(1); });
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 400) : "")); if (!ok) { stop(); process.exit(1); } };

const app = spawn("python3", [join(here, "lns_ui_app.py"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WITH_SIGNER04: "1" } });
procs.push(app);
const NET = await new Promise((ok) => app.stdout.on("data", (d) => { const m = /net04 (\d+)/.exec(String(d)); if (m) ok(Number(m[1])); }));
const ctl = (what, body) => fetch(`http://127.0.0.1:${NET}/ctl/chain04/${what}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const post = async (path, body, session) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(session ? { "X-Session": session } : {}) }, body: JSON.stringify(body) })).json();
const get = async (path, session) => (await fetch(BASE + path, { headers: { "X-Session": session } })).json();
const session = (await post("/api/wallet/setup", { pin: PIN })).session;

const cport = 9393 + Number(process.env.PORT_SHIFT || 0); prof = mkdtempSync(join(tmpdir(), "chrome-"));
if (await fetch(`http://127.0.0.1:${cport}/json/version`).then(() => true, () => false)) { console.error(`port ${cport} already has a DevTools endpoint (an adb forward?); set PORT_SHIFT or free it`); stop(); process.exit(1); }
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cport}`, `--user-data-dir=${prof}`, "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
procs.push(chrome);
let target;
for (let i = 0; i < 600 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json()).find(t => t.type === "page"); } catch {} if (!target) await sleep(100); }
check("Chrome starts", !!target);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok));
let seq = 0; const waiting = new Map(), errors = [], bodies = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Network.requestWillBeSent") bodies.push({ url: m.params.request.url, body: m.params.request.postData || "" });
});
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Network.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
if (process.env.SHOTS) await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.DARK ? "dark" : "light" }] });
const js = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr + ": " + JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no ${sel}"); e.click(); return true; })()`);
const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
const shown = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null; })()`);
const waitFor = async (name, expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await js(expr); } catch { v = false; } if (v) return check(name, true); await sleep(120); } check(name, false, { errors, page: (await text("#v-open")).slice(0, 600) }); };
const val = (sel, v) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); return true; })()`);
const pressNow = (sel) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.click(); return b.textContent + "|" + b.disabled; })()`);
const tall = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null).every(e => e.getBoundingClientRect().height >= 44)`);
const fits = () => js(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll("#net04 *")].every(e => !e.offsetParent || e.getBoundingClientRect().right <= innerWidth + 1)`);

const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let shotN = 0;
const shot = async (name, sel) => { await noGreenOrBlue(js, check, name); if (!SHOTS) return; if (sel) await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" }); true`);
  const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, `sign04-${String(++shotN).padStart(2, "0")}-${name}.png`), Buffer.from(r.result.data, "base64")); };
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.LogosAndroid = { scanQr() {}, openNode() {}, unlockWithFingerprint() {}, setTheme() {} };" });

await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("the page loads, locked", `document.readyState === "complete" && !document.getElementById("v-locked").hidden`);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("unlocked", `!document.getElementById("v-open").hidden`);

// ---- LEZ 0.4, not restored yet: the phrase card; Send says to restore first ----
await waitFor("LEZ 0.4: the recovery-phrase card", `document.getElementById("s4-restore").offsetParent !== null`);
const card = await text("#s4-restore");
check("it says what the phrase is for and what is kept", /the ones your desktop Names Wallet makes from its recovery phrase/.test(card) && /The phrase itself isn't kept or sent anywhere/.test(card)
  && /Anyone who has the phrase controls these accounts/.test(card));
check("the phrase box doesn't autocomplete, capitalise, correct or spellcheck", await js(`(() => { const t = document.getElementById("s4-phrase");
  return t.getAttribute("autocomplete") === "off" && t.getAttribute("autocapitalize") === "off" && t.getAttribute("autocorrect") === "off" && t.spellcheck === false; })()`));
await click("#n4-send");
await waitFor("Send before the restore: restore first, not 'switch to 0.3'", `document.getElementById("n4-na").offsetParent !== null && document.getElementById("n4-na").textContent === "Restore your LEZ 0.4 accounts from your recovery phrase first (above)."`);
check("buttons 44 px, nothing past the screen", (await tall("#net04 button, #net04 textarea")) && (await fits()));
await shot("restore-card", "#s4-restore");

// ---- restore ----
await val("#s4-phrase", "legal winner thank");
await click("#s4-restore-go");
await waitFor("too few words: said, nothing sent", `document.getElementById("s4-restore-m").textContent === "A recovery phrase is 12 to 24 words."`);
check("…and nothing went out", !bodies.some(b => b.url.includes("/lez04/restore")));
await val("#s4-phrase", PHRASE.toUpperCase().replace(/ /g, "  "));
const p1 = await pressNow("#s4-restore-go");
check("Restore: 'Restoring…' at once, can't be pressed twice", p1 === "Restoring…|true", p1);
check("the box is emptied as the request goes", (await js(`document.getElementById("s4-phrase").value`)) === "");
await waitFor("Restored: this phone sends from the desktop's first account", `/^Restored\\. This phone sends from Public\\/[1-9A-HJ-NP-Za-km-z]{32,44}, your desktop's first account\\.$/.test(document.getElementById("s4-restore-m").textContent)`, 20000);
const v = await get("/api/wallet/lez04", session);
const MAIN = v.account;
check("the phrase went out once, to the restore route, lowercase, single-spaced", bodies.filter(b => b.body.includes("sausage")).length === 1
  && bodies.find(b => b.body.includes("sausage")).url.endsWith("/api/wallet/lez04/restore") && bodies.find(b => b.body.includes("sausage")).body === JSON.stringify({ phrase: PHRASE }));
check("the phrase is nowhere in the page now", !(await js(`document.documentElement.outerHTML.includes("sausage") || [...document.querySelectorAll("textarea,input")].some(i => /sausage/i.test(i.value))`)));
await waitFor("the card goes; Get free test LEZ shows, once per wallet", `document.getElementById("s4-restore").offsetParent === null && document.getElementById("s4-faucet").offsetParent !== null
  && /^Once per wallet: 10,000,000 test LEZ, to this phone's account\\./.test(document.getElementById("s4-faucet-n").textContent)`);
await waitFor("the Wallet shows the restored account as this phone's", `document.getElementById("n4-accts").innerText.includes(${JSON.stringify(MAIN)}) && /This phone's LEZ account/.test(document.getElementById("n4-accts").innerText)`, 20000);
check("private: not on this phone yet", (await text("#s4-private")) === "Private sends and balances: not on this phone yet.");
await shot("restored", "#s4-fund");

// ---- the faucet ----
const p2 = await pressNow("#s4-faucet");
check("Get free test LEZ: 'Asking the faucet…' at once", p2 === "Asking the faucet…|true", p2);
await waitFor("then: the amount, sent to this phone's account", `document.getElementById("s4-faucet-m").textContent === "10,000,000 test LEZ sent to this phone's account. The balance shows them in a moment." && document.getElementById("s4-faucet-m").className === "msg ok"`);
check("the 'restore first' line is gone", !(await shown("#n4-na")));
check("one line about private, not two", (await shown("#s4-private")) && !(await shown("#n4-private")));
await shot("faucet", "#s4-fund");
await waitFor("the balance shows them", `document.getElementById("n4-accts").innerText.includes("LEZ: 10,000,000")`, 20000);
check("the faucet's answer stays, its button doesn't come back", (await shown("#s4-faucet-m")) && !(await shown("#s4-faucet")));

// ---- Send ----
await click("#n4-send");
await waitFor("Send opens its panel (no 'not available' line)", `document.getElementById("s4-send").offsetParent !== null && document.getElementById("n4-na").offsetParent === null`);
await ctl("balance", { account: "Fx1yhUrJ2aZ1jW4b6nqJ3H8tpsHrwrz3yuPEqsfGr1QB", amount: 5 });
await val("#s4-to", "Public/Fx1yhUrJ2aZ1jW4b6nqJ3H8tpsHrwrz3yuPEqsfGr1QB"); await val("#s4-amt", "250,000");
const p3 = await pressNow("#s4-send-go");
check("Send: 'Sending…' at once", p3 === "Sending…|true", p3);
await shot("sending", "#s4-send");
await waitFor("then: in a block, said plainly", `document.getElementById("s4-send-m").textContent === "Sent 250,000 to Public/Fx1yhUrJ2aZ1jW4b6nqJ3H8tpsHrwrz3yuPEqsfGr1QB. It is in a block."`, 20000);
await val("#s4-to", "Public/" + "2".repeat(44)); await val("#s4-amt", "5");
await click("#s4-send-go");
await waitFor("an account the network hasn't seen: refused with what to do instead", `/can only be paid by its public key/.test(document.getElementById("s4-send-m").textContent) && document.getElementById("s4-send-m").className === "msg bad"`);
check("the send panel: 44 px, fits", (await tall("#s4-send button, #s4-send input")) && (await fits()));
await shot("send", "#s4-send");

// ---- Receive ----
await click("#n4-recv");
await waitFor("Receive: the account, its QR code, its public key", `document.getElementById("s4-recv").offsetParent !== null && document.getElementById("s4-acct").textContent === "Public/" + ${JSON.stringify(MAIN)}
  && document.querySelector("#s4-qr .qr svg") && /^[0-9a-f]{64}$/.test(document.getElementById("s4-pk").textContent)`);
check("the QR code is of the account", (await js(`document.querySelector("#s4-qr .qr").dataset.text`)) === "Public/" + MAIN);
check("Copy buttons, 44 px, fits", (await tall("#s4-recv button")) && (await fits()));
await shot("receive", "#s4-recv");

// ---- Collectibles: Claim NFT (free) ----
await ctl("register", { name: "slowclaim", owner: MAIN });
await ctl("register", { name: "abcd", owner: MAIN });
await ctl("nft", { account: MAIN, program: PROGRAM, hex: "01" + "f00cbb50684466efb7410aa2097f6bcc3a07d0d2ad8acbe8d655373f619219c2" + "02" + "00".repeat(15) });
await post("/api/wallet/net04/nft", { add_name: "slowclaim" }, session);
await post("/api/wallet/net04/nft", { add_name: "abcd" }, session);
await post("/api/wallet/net04/nft", { add_program: PROGRAM, label: "Test chain NFTs" }, session);
await click("#n4-open-col");
await waitFor("Collectibles says what it can do here now", `/Receiving and sending NFTs here are public/.test(document.getElementById("n4-col-mode").textContent)`, 20000);
await waitFor("a name the wallet holds with no NFT: Claim NFT (free), and who pays the fee", `(() => { const b = document.querySelector('#n4-names [data-name="slowclaim"]');
  return !!b && /No NFT claimed for this name yet\\./.test(b.innerText) && /Held by your account Public .{6}….{4}, which pays the network fee\\. The NFT itself is free\\./.test(b.innerText)
    && [...b.querySelectorAll("button")].some(x => x.textContent === "Claim NFT (free)"); })()`, 20000);
await waitFor("a four-character name: locked, no Claim", `(() => { const b = document.querySelector('#n4-names [data-name="abcd"]'); return !!b && /Locked \\(one to four characters\\)/.test(b.innerText) && !b.querySelector("[data-claim]"); })()`, 40000);   // (the page reads Collectibles every 30 s)
check("the Claim button is 44 px, nothing past the screen", (await tall("#n4-names button")) && (await fits()));
await shot("claim-button", '#n4-names [data-name="slowclaim"]');
const p4 = await pressNow('#n4-names [data-claim="slowclaim"]');
check("Claim: 'Claiming…' at once, can't be pressed twice", p4 === "Claiming…|true", p4);
await waitFor("then the job's progress, in fixed words", `/^(Claiming slowclaim's NFT|Reading the|Sending it with its fixed fee cap|Starting|Sent|Getting the list)/.test(document.querySelector('#n4-names [data-name="slowclaim"] .msg').textContent)`, 10000);
await shot("claiming", '#n4-names [data-name="slowclaim"]');
await waitFor("then: claimed, and the card is drawn", `(() => { const b = document.querySelector('#n4-names [data-name="slowclaim"]'); return !!b && !!b.querySelector("canvas[data-drawn]") && /Its NFT, held for it by the LNS registry/.test(b.innerText); })()`, 30000);
check("the card is labelled with the name", (await js(`document.querySelector('#n4-names [data-name="slowclaim"] canvas').getAttribute("aria-label")`)) === "LNS name card: slowclaim");
await shot("claimed-card", '#n4-names [data-name="slowclaim"] canvas');

// ---- an NFT the phone holds: Send; Receive ----
await waitFor("the phone's NFT, with Send", `(() => { const t = document.getElementById("n4-groups"); return /this phone/.test(t.innerText) && [...t.querySelectorAll("button")].some(b => b.textContent === "Send"); })()`, 20000);
await js(`[...document.querySelectorAll("#n4-groups button")].find(b => b.textContent === "Send").click(); true`);
await waitFor("the send sheet: To and Send NFT", `[...document.querySelectorAll("#n4-groups button")].some(b => b.textContent === "Send NFT" && b.offsetParent !== null)`);
await js(`(() => { const i = [...document.querySelectorAll("#n4-groups input")].find(x => x.offsetParent !== null); i.value = "Public/Fx1yhUrJ2aZ1jW4b6nqJ3H8tpsHrwrz3yuPEqsfGr1QB"; return true; })()`);
check("the sheet: 44 px, fits", (await tall("#n4-groups button, #n4-groups input")) && (await fits()));
await shot("nft-send-sheet", "#n4-groups");
const p5 = await js(`(() => { const b = [...document.querySelectorAll("#n4-groups button")].find(b => b.textContent === "Send NFT"); b.click(); return b.textContent + "|" + b.disabled; })()`);
check("Send NFT: 'Sending…' at once", p5 === "Sending…|true", p5);
await waitFor("then: sent, in a block, said above the list", `document.getElementById("n4-send-m").textContent === "Sent to Public/Fx1yhUrJ2aZ1jW4b6nqJ3H8tpsHrwrz3yuPEqsfGr1QB. It is in a block."`, 20000);
await waitFor("the NFT has left this phone's account", `!/this phone/.test(document.getElementById("n4-groups").innerText)`, 40000);
await shot("nft-sent", "#n4-send-m");
await waitFor("Receive an NFT: offered for the listed program", `document.getElementById("n4-recv-open").offsetParent !== null`);
await click("#n4-recv-open");
await val("#n4-recv-def", ART);
const p6 = await pressNow("#n4-recv-go");
check("Make my account ready: 'Getting ready…' at once", p6 === "Getting ready…|true", p6);
await waitFor("then: which account to give the sender", `/^Ready\\. Give the sender Public\\/[1-9A-HJ-NP-Za-km-z]{32,44}: it takes this collection now\\.$/.test(document.getElementById("n4-recv-m").textContent)`, 20000);
check("the Receive sheet: 44 px, fits", (await tall("#n4-recv button, #n4-recv input, #n4-recv select")) && (await fits()));
await shot("nft-receive", "#n4-recv");

// ---- a lock: nothing of it stays ----
await click("#n4-col-back");
await val("#s4-to", "typed, not sent");
await js(`lockedNow(); true`);
await waitFor("locked: the page loaded again, into the lock screen", `!document.getElementById("v-locked").hidden && !document.documentElement.classList.contains("relock")`);
const left = await js(`(() => { const h = document.documentElement.outerHTML; return { acct: h.includes(${JSON.stringify(MAIN)}), typed: (document.getElementById("s4-to") || {}).value || "", canvas: document.querySelectorAll("canvas").length }; })()`);
check("locked: no account, no typed text, no card left", !left.acct && !left.typed && left.canvas === 0, left);
check("no page errors", errors.length === 0, errors);
stop();
console.log("all checks passed" + (SHOTS ? ` (screenshots in ${SHOTS})` : ""));
process.exit(0);

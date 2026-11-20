// The NFTs screen (app/net04/nft.js) in a real browser (headless Chrome over the DevTools protocol) at the narrowest
// phone width the app supports (360 px), with the stand-ins of tests/ui_app.py (the phone's LEZ 0.4 wallet set up): the
// bar's NFTs tab, the empty page with the desktop wallet's words, an NFT program added by its ID ("Checking…" at once, then a
// plain result), the NFTs of the phone's account and of a watched one grouped by account and counted per collection,
// an LNS name's card drawn on the phone with the bundled fonts (forest green, yellow rule, the size rule), 44 px tap
// targets, nothing wider than the screen, no green or blue outside the card, the network entered by RPC URL and chain
// id (a wrong chain id refused), and a lock leaving no card, name or NFT behind.
//
//   CHROME=<path to chrome> SHOTS=<folder, optional> node tests/nft04_ui.mjs
//   CHROME=<path to chrome> SHOTS=<folder, optional> node tests/net04_ui.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { noGreenOrBlue } from "./hue_check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8151 + Number(process.env.PORT_SHIFT || 0), BASE = `http://127.0.0.1:${PORT}`, PIN = "246813";
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

const cport = 9383 + Number(process.env.PORT_SHIFT || 0); prof = mkdtempSync(join(tmpdir(), "chrome-"));
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
await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
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
const shot = async (name) => { await noGreenOrBlue(js, check, name); if (!SHOTS) return; const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, `nft04-${String(++shotN).padStart(2, "0")}-${name}.png`), Buffer.from(r.result.data, "base64")); };
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.LogosAndroid = { scanQr() {}, openNode() {}, unlockWithFingerprint() {}, setTheme() {} };" });
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.__req = []; const __f = window.fetch; window.fetch = (u, o) => { window.__req.push(((o && o.method) || 'GET') + ' ' + String(u)); return __f(u, o); };" });

const PROGRAM = "ErycMYqXUUtducaYmpHZjRgdbLXchrMiV4NZRnmRDNmu", ART = "HA47ERcmfSbDChGcYfBcC4SKaPQ8pJJnv4wxCLu1ejL5";
// ---- the name account exists (made through the app, with the stand-in signer); the Basecamp account is watched ----
await post("/api/wallet/net04/watch", { add: BASECAMP }, session);

await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("the page loads, locked", `document.readyState === "complete" && !document.getElementById("v-locked").hidden`);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`);
await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("unlocked", `!document.getElementById("v-open").hidden`);
const tall = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null).every(e => e.getBoundingClientRect().height >= 44)`);
const fits = () => js(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll("#page-nft *")].every(e => !e.offsetParent || e.getBoundingClientRect().right <= innerWidth + 1)`);

// ---- the bar's NFTs tab: its own screen ----
await waitFor("the bar has NFTs, a 44 px target", `!!document.getElementById("nav-nft") && document.getElementById("nav-nft").offsetParent !== null && document.getElementById("nav-nft").getBoundingClientRect().height >= 44`);
check("the Wallet has no Collectibles row any more", !(await js(`!!document.getElementById("n4-open-col")`)));
await click("#nav-nft");
await waitFor("NFTs open, the Wallet goes", `document.getElementById("page-nft").offsetParent !== null && document.getElementById("page-main").hidden`);
check("its title and network line", (await text("#h-col")) === "NFTs" && (await text("#n4-col-runs")) === "On LEZ 0.4");
const colWords = await text("#n4-col");
check("the desktop's words: one NFT per account per program", colWords.includes("NFTs of the NFT programs listed below. Under each program an account holds one NFT, and takes NFTs of one collection only; a second NFT needs another account."));
check("it says what it does here (public) and that it loads no image", /Receiving and sending NFTs here are public/.test(colWords) && /Images are never loaded\./.test(colWords));
await waitFor("no program yet: the desktop's line", `document.getElementById("n4-progs").innerText.includes("None yet. Every deployment of the NFT program is a different program: add the one your collections live under, by its program ID.")`);
await waitFor("no NFT under no program", `document.getElementById("n4-colls").innerText.includes("Your accounts hold no NFT under the listed programs.")`);
await waitFor("no LNS name on this phone yet: says how to get one", `/No LNS name to look for yet\\./.test(document.getElementById("n4-names").innerText)`);
check("Add, Show and the fields are 44 px", await tall("#n4-col button, #n4-col input"));
check("nothing goes past the 360 px screen", await fits());
await shot("collectibles-empty");

// ---- add a program: "Checking…" at once, then a plain result; a wrong ID refused plainly ----
await val("#n4-prog", "hello");
await click("#n4-prog-add");
await waitFor("a word that isn't a program ID: refused, plainly", `document.getElementById("n4-prog-m").textContent === "An NFT program is written as its account ID (base58)."`);
await val("#n4-prog", PROGRAM); await val("#n4-prog-label", "Test chain NFTs");
const pressed = await js(`(() => { document.getElementById("n4-prog-add").click(); const b = document.getElementById("n4-prog-add"); return b.textContent + "|" + b.disabled; })()`);
check("the press shows at once: 'Checking…', and the button can't be pressed twice", pressed === "Checking…|true", pressed);
await waitFor("then: added, said plainly", `/^Added ErycMY…DNmu\\./.test(document.getElementById("n4-prog-m").textContent) && document.getElementById("n4-prog-add").textContent === "Add"`);
await waitFor("the program is listed with its name, Copy and Remove", `(() => { const t = document.getElementById("n4-progs").innerText; return t.includes("Test chain NFTs · ErycMY…DNmu") && /Its source isn't checked on this phone\\./.test(t) && /Remove/.test(t); })()`);
await waitFor("Collections: Harbour at dawn, held by 2 of your accounts", `document.getElementById("n4-colls").innerText.includes("Harbour at dawn · held by 2 of your accounts")`, 20000);
await waitFor("by account: this phone's master, then the watched account's copy", `(() => { const t = document.getElementById("n4-groups").innerText;
  return /Public 9xQeWv…VFin · this phone/.test(t) && /Master · can print 1 more copy/.test(t) && /Public CCVd76…pKnk · watched, view-only/.test(t) && /\\bCopy\\b/.test(t)
    && t.includes("https://img.example.com/harbour.png") && /Creators\\s*ada/.test(t) && /Supply\\s*3/.test(t) && /Program\\s*Test chain NFTs/.test(t); })()`, 20000);
check("Send under this phone's NFT only (not the watched account's); no Burn or Print", (await js(`(() => { const g = [...document.querySelectorAll("#n4-groups .n4-nft")]; return g.length === 2 && g.filter(c => [...c.querySelectorAll("button")].some(b => b.textContent === "Send")).length === 1; })()`))
  && !(await js(`[...document.querySelectorAll("#n4-col button")].some(b => b.offsetParent !== null && /^(Burn|Print)/.test(b.textContent))`)));
check("every button 44 px, nothing past the screen", (await tall("#n4-col button, #n4-col input")) && (await fits()));
await js(`document.getElementById("n4-groups").scrollIntoView(); true`);
await shot("collectibles-nfts");

// ---- an LNS name's card, drawn on the phone ----
await val("#n4-name", "Alice");
const pressed2 = await js(`(() => { document.getElementById("n4-name-add").click(); return document.getElementById("n4-name-add").textContent; })()`);
check("Show: 'Checking…' at once", pressed2 === "Checking…");
await waitFor("then: looking for it, said plainly", `document.getElementById("n4-name-m").textContent === "Looking for alice's NFT. It shows in a moment."`);
await waitFor("the card is drawn once the bundled fonts are in", `(() => { const c = document.querySelector("#n4-names canvas"); return !!c && !!c.dataset.drawn; })()`, 20000);
check("the bundled fonts loaded from the app (Gloock, Fira Code), none from the web", await js(`document.fonts.check('60px "Gloock"') && document.fonts.check('14px "NW Fira Code"') && performance.getEntriesByType("resource").every(r => r.name.startsWith(location.origin))`));
const geo = await js(`(() => { const c = document.querySelector("#n4-names canvas"), r = c.getBoundingClientRect(), g = c.getContext("2d"), dpr = c.width / r.width;
  const px = (x, y) => Array.from(g.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data.slice(0, 3));
  const s = r.width / 480; return { w: r.width, h: r.height, cw: c.width, dpr, label: c.getAttribute("aria-label"), right: r.right,
    green: px(r.width * 0.5, r.width * 0.62), rule: px(r.width * 0.5, r.width - 97 * s), box: c.parentElement.clientWidth,
    lam: (() => { const d = g.getImageData(Math.round((r.width - 75 * s) * dpr), Math.round(35 * s * dpr), Math.round(40 * s * dpr), Math.round(50 * s * dpr)).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 120) return true; return false; })() }; })()`);
check("the card fills the width the screen gives it (294 px on a 360 px phone), square, drawn at the screen's pixel density", geo.w === geo.box && geo.w === 294 && geo.h === geo.w && geo.cw === geo.w * 2 && geo.right <= 360, geo);
check("forest green #152521 under the name", JSON.stringify(geo.green) === "[21,37,33]", geo.green);
check("the yellow rule #ffd328, 96 px (scaled) from the bottom", JSON.stringify(geo.rule) === "[255,211,40]", geo.rule);
check("a yellow λ top right", geo.lam, geo);
check("it is labelled for a screen reader with the name", geo.label === "LNS name card: alice");
const size = await js(`(() => { const C = NFT04CORE; return [C.cardSize(3, 294).px, C.cardSize(12, 294).px, C.cardSize(13, 294).px, C.cardSize(32, 294).px]; })()`);
check("the size rule on this card: 36.75 px up to 12 characters, 22.05 px from 13 (60 and 36 at 480 px, scaled)", Math.abs(size[0] - 36.75) < 1e-9 && Math.abs(size[1] - 36.75) < 1e-9 && Math.abs(size[2] - 22.05) < 1e-9 && Math.abs(size[3] - 22.05) < 1e-9, size);
check("its holder and NFT under the card, with Copy", /Holder\s*Public 9xQeWv…VFin/.test(await text("#n4-names")) && /NFT ID/.test(await text("#n4-names")) && /held for it by the LNS registry/.test(await text("#n4-names")));
check("every button 44 px, nothing past the screen", (await tall("#n4-col button, #n4-col input")) && (await fits()));
await js(`document.querySelector("#n4-names canvas").scrollIntoView({ block: "center" }); true`);
await shot("collectibles-card");
// the same card at the design's own size (480 px, 2x), to set beside the approved render
await js(`(() => { const c = document.createElement("canvas"); c.id = "ref-card"; c.width = 960; c.height = 960; c.style.cssText = "position:fixed;left:0;top:0;width:480px;height:480px;z-index:99";
  const g = c.getContext("2d"); g.setTransform(2, 0, 0, 2, 0, 0); NFT04CORE.drawCard(g, "alice", 480); document.body.append(c); return true; })()`);
const refShot = async (file) => { if (!SHOTS) return; await js(`window.scrollTo(0, 0); true`); await cdp("Emulation.setDeviceMetricsOverride", { width: 480, height: 780, deviceScaleFactor: 2, mobile: true });
  const r = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 480, height: 480, scale: 1 } }); writeFileSync(join(SHOTS, file), Buffer.from(r.result.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true }); };
await refShot("nft04-card-alice-480.png");
await js(`document.getElementById("ref-card").remove(); true`);
// a long name: 36 px at the reference size, wrapped
await js(`(() => { const c = document.createElement("canvas"); c.id = "ref-card"; c.width = 960; c.height = 960; c.style.cssText = "position:fixed;left:0;top:0;width:480px;height:480px;z-index:99";
  const g = c.getContext("2d"); g.setTransform(2, 0, 0, 2, 0, 0); window.__long = NFT04CORE.drawCard(g, "averyveryverylongname-thirtytwo1", 480); document.body.append(c); return true; })()`);
const long = await js(`({ lines: window.__long.lines, px: window.__long.size.px })`);
check("a 32-character name: 36 px, on two lines, nothing dropped", long.px === 36 && long.lines.length === 2 && long.lines.join("") === "averyveryverylongname-thirtytwo1", long);
await refShot("nft04-card-long-480.png");
await js(`document.getElementById("ref-card").remove(); true`);

// ---- a name that isn't registered: its line, no card ----
await val("#n4-name", "nobody"); await click("#n4-name-add");
await waitFor("a name not registered on this network: said, no card", `(() => { const b = document.querySelector('#n4-names [data-name="nobody"]'); return !!b && /Not registered on this network\\./.test(b.innerText) && !b.querySelector("canvas"); })()`, 45000);   // (the page reads every 30 s)
await js(`[...document.querySelectorAll('#n4-names [data-name="nobody"] button')].find(b => b.textContent === "Stop showing").click(); true`);
await waitFor("Stop showing takes it off", `!document.querySelector('#n4-names [data-name="nobody"]')`);

// ---- the Wallet again, and the network: entered by RPC URL and chain id ----
await click("#nav-wallet");
await waitFor("the Wallet again, NFTs gone", `!document.getElementById("page-main").hidden && document.getElementById("page-nft").hidden`);
await js(`openSettings("s-net"); true`);
await waitFor("Settings > Network", `!document.getElementById("page-settings").hidden && document.getElementById("s-net").offsetParent !== null`);
await waitFor("it names the LEZ 0.4 in use", `/^In use: our LEZ 0\\.4 \\(127\\.0\\.0\\.1:\\d+\\)\\.$/.test(document.getElementById("n4-net-now").textContent)`);
await js(`document.getElementById("n4-net-other").open = true; true`);
const rpcUrl = await js(`"http://" + document.getElementById("nw-host").textContent + "/"`);
const chainId = (await (await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getChannelId", params: [] }) })).json()).result;
await val("#n4-net-url", rpcUrl); await val("#n4-net-id", "ee".repeat(32));
await click("#n4-net-set");
await waitFor("a chain id the RPC doesn't report: refused, nothing changed", `document.getElementById("n4-net-m").textContent === "That RPC reports another chain id, so the wallet didn't switch. Nothing was changed." && /^In use: our LEZ 0\\.4/.test(document.getElementById("n4-net-now").textContent)`);
await val("#n4-net-id", chainId.toUpperCase());
const pressed3 = await js(`(() => { document.getElementById("n4-net-set").click(); return document.getElementById("n4-net-set").textContent; })()`);
check("Check and switch: 'Checking…' at once", pressed3 === "Checking…");
await waitFor("the right chain id: switched, said plainly, the entry named", `/^Switched\\. LEZ 0\\.4 is read from 127\\.0\\.0\\.1:\\d+ now\\.$/.test(document.getElementById("n4-net-m").textContent)
  && document.getElementById("n4-net-now").textContent.includes("chain id " + ${JSON.stringify(chainId.slice(0, 8))}) && document.getElementById("n4-net-ours").offsetParent !== null`);
check("the network box's buttons and fields are 44 px; nothing past the screen", (await tall("#s-net button, #s-net input")) && (await js(`document.documentElement.scrollWidth <= innerWidth`)));
await shot("settings-network-entered");
await js(`closeSettings(); true`);

// ---- a lock: no card, name, NFT or typed text stays; after the unlock LEZ 0.4 and nothing drawn until asked ----
await click("#nav-nft");
await waitFor("the card again", `(() => { const c = document.querySelector("#n4-names canvas"); return !!c && !!c.dataset.drawn; })()`, 20000);
await val("#n4-prog", "typed, not sent");
await js(`lockedNow(); true`);
await waitFor("locked: the page loaded again, into the lock screen", `!document.getElementById("v-locked").hidden && !document.documentElement.classList.contains("relock")`);
const left = await js(`(() => { const h = document.documentElement.outerHTML; return { canvas: document.querySelectorAll("canvas").length, alice: /\\balice\\b/.test(document.getElementById("page-nft").textContent),
  art: h.includes(${JSON.stringify(ART)}) || /Harbour/.test(h), typed: (document.getElementById("n4-prog") || {}).value || "" }; })()`);
check("locked: no card, no name, no NFT, no typed text left", left.canvas === 0 && !left.alice && !left.art && !left.typed, left);
await js(`sessionStorage.setItem("session", ${JSON.stringify(session)}); true`); await cdp("Page.navigate", { url: BASE + "/" });
await waitFor("a new page with the session: the Wallet first, NFTs not drawn until asked", `!document.getElementById("v-open").hidden && !document.getElementById("page-main").hidden && document.getElementById("page-nft").hidden && !document.querySelector("#page-nft canvas")`);
// ---- the lock's own wipe, before its reload (held back here so the page that is locking can be looked at) ----
await click("#nav-nft");
await waitFor("the card again", `(() => { const c = document.querySelector("#n4-names canvas"); return !!c && !!c.dataset.drawn; })()`, 20000);
const wiped = await js(`(async () => { relockPage = () => {}; lockedNow(); await new Promise(ok => setTimeout(ok, 300));
  const cs = [...document.querySelectorAll("canvas")];
  const clear = c => !c.width || !c.height || c.getContext("2d").getImageData(0, 0, c.width, c.height).data.every((v, i) => i % 4 !== 3 || v === 0);
  return { n: cs.length, blank: cs.every(clear), hidden: document.documentElement.classList.contains("relock") }; })()`);
check("a lock blanks every drawn card at once, before the reload", wiped.blank && wiped.hidden, wiped);
check("no page errors", errors.length === 0, errors);
stop();
console.log("all checks passed" + (SHOTS ? ` (screenshots in ${SHOTS})` : ""));
process.exit(0);

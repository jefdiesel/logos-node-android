// The Messages screen in a real browser (headless Chrome over the DevTools protocol), at phone width, in
// light and dark: the empty states, the chat list, a chat, a key change, a profile with a note, a new chat.
//
//   CHROME=<path to chrome> SHOTS=<folder for screenshots, optional> PORT_SHIFT=<n, optional> node tests/chat_ui.mjs
//
// PORT_SHIFT moves every port this test uses up by n (when the defaults are busy).
//
// Three apps on a fake messaging network: the browser shows alice's; bob and carol write from Node with the
// page's own chat model. Checks what the screen shows; with SHOTS, saves a PNG of each state.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { noGreenOrBlue } from "./hue_check.mjs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { world, app, person, chatOf, check, until, sleep, procs, stopAll, MC, ID, CORE, hex, b64, here } from "./chat_world.mjs";

const jsQR = createRequire(import.meta.url)("./vendor/jsQR.js");   // test only: reads the QR codes back off the screen
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const PS = Number(process.env.PORT_SHIFT || 0);
const w = await world(18570 + PS, 5);
// alice's node: a stand-in for the node's own API, catching up at first (balances, state, peers)
const NODE_PORT = 18596 + PS;
procs.push(spawn("python3", [join(here, "fake_node_api.py"), String(NODE_PORT), "syncing"], { stdio: "ignore" }));
const nodeMode = async (m) => (await fetch(`http://127.0.0.1:${NODE_PORT}/mode/${m}`, { method: "POST" })).text();
const A = await app(w, 8111 + PS, w.NODES[0], { NODE_API: `http://127.0.0.1:${NODE_PORT}`, HISTORY_POLL: "1" }), B = await app(w, 8112 + PS, w.NODES[1]), C = await app(w, 8113 + PS, w.NODES[2]);
await person(w, B, "bob", "222333"); await person(w, C, "carol", "333444");
A.pin = "111222"; A.session = (await A.call("/api/wallet/setup", { pin: A.pin })).d.session;

// ---- a browser ----
const port = 9333 + PS, prof = mkdtempSync(join(tmpdir(), "chrome-"));
process.on("exit", () => { try { rmSync(prof, { recursive: true, force: true }); } catch {} });   // the headless profile goes with the run
// never drive a browser this test didn't start: a DevTools port that already answers may be an adb forward to a phone
if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) { console.error(`port ${port} already has a DevTools endpoint (an adb forward?); set PORT_SHIFT or free it`); process.exit(1); }
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
  ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });   // CI: Ubuntu 24.04 blocks the sandbox's user namespaces
procs.push(chrome);
let chromeErr = ""; chrome.stderr.on("data", d => { chromeErr = (chromeErr + d).slice(-3000); });
let target;
for (let i = 0; i < 600 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page"); } catch {} if (!target) await sleep(100); }
if (!target) { console.error("Chrome didn't start (60 s): " + CHROME + "\n" + chromeErr); stopAll(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok));
let seq = 0; const waiting = new Map(), errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  // (a wrong PIN, tried on purpose, answers 401: the browser logs that, and it is no page error)
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !(m.params.entry.source === "network" && /\/api\/wallet\/unlock$/.test(m.params.entry.url || "") && / 401 /.test(m.params.entry.text))) errors.push(m.params.entry.text + (m.params.entry.url ? " " + m.params.entry.url.replace(/^https?:\/\/[^/]+/, "") : ""));
});
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true });
await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });      // focus events as in a focused window
const js = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr + ": " + JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no ${sel}"); e.click(); return true; })()`);
const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
const seen = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null || !!e && getComputedStyle(e).position === "fixed"; })()`);
const waitFor = async (name, expr, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(150); }
  check(name, false, { errors, at: await js(`document.body.className + " lock:" + document.getElementById("lock").hidden + " vl:" + document.getElementById("v-locked").hidden + " vo:" + document.getElementById("v-open").hidden`).catch(() => ""),
    page: (await js(`(document.querySelector(".ov") || document.getElementById("page-msg")).innerText`).catch(() => "")).slice(0, 300) });
};
// the old header's words must never show again, on any screen
const noOldHeader = async (where) => {
  check(`${where}: no "Logos node" or "running on this device"`, !/logos node|running on this device/i.test(await js(`document.body.innerText`)));
  check(`${where}: the page title is Names Wallet`, (await js(`document.title`)) === "Names Wallet" && !/logos node/i.test(await js(`document.title`)));
  await bigTargets(where);
};
// every control on screen is at least 44 x 44 px; exceptions: message bubbles (the text itself), a link inside
// a sentence, and a switch whose whole row (44 px or more) toggles it
const bigTargets = async (where) => {
  const small = await js(`[...document.querySelectorAll("button, input:not([type=checkbox]):not([type=file]), select, summary")].filter(e => {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false;
    if (e.closest(".bub, .lnk") || e.classList.contains("bub") || e.classList.contains("lnk")) return false;
    if (e.classList.contains("sw") && e.closest(".tg") && e.closest(".tg").getBoundingClientRect().height >= 44) return false;
    if (e.type === "radio" && e.closest("label") && e.closest("label").getBoundingClientRect().height >= 44) return false;   // the whole label is the target
    return r.height < 43.5 || r.width < 43.5;
  }).map(e => (e.id || e.className || e.tagName) + " " + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height))`);
  check(`${where}: every control is at least 44 px`, small.length === 0, small);
};
// a screen with a Back has one top bar: a chevron button labelled Back (44 px or more, no words) and the
// title beside it, on one line, at a normal title size (no giant heading)
const barOk = async (where, bar) => {
  const m = await js(`(() => { const bar = document.querySelector(${JSON.stringify(bar)}); if (!bar) return null;
    const b = bar.querySelector(".back"), t = bar.querySelector(".bar-t, .who"); if (!b || !t) return null;
    const br = b.getBoundingClientRect(), tr = t.getBoundingClientRect(), te = t.matches(".who") ? t.querySelector("b") : t, cs = getComputedStyle(te);
    const px = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight) || px * 1.3;
    return { label: b.getAttribute("aria-label"), words: b.innerText.trim(), bw: Math.round(br.width), bh: Math.round(br.height), px, title: te.innerText,
      sameLine: Math.abs((br.top + br.bottom) / 2 - (tr.top + tr.bottom) / 2) <= 4, beside: br.right <= tr.left + 1,
      oneLine: te.getBoundingClientRect().height <= lh * 1.5 }; })()`);
  check(`${where}: one top bar, Back (a 44 px chevron) and the title "${m && m.title}" on one line, ${m && m.px} px`,
    !!m && m.label === "Back" && m.words === "" && m.bw >= 44 && m.bh >= 44 && m.sameLine && m.beside && m.oneLine && m.px <= 20 && m.px >= 16, m);
  return m;
};
// larger text, as a phone set to a bigger font size shows it: the page drawn at 115% and 130% (CSS zoom on the
// body; the page sets its sizes in px). On the screen in `sel`: no sideways scroll, no row title or line cut
// ("…" or clipped), each safety-code group whole on one line, every control still 44 px or more.
const bigText = async (where, sel) => {
  for (const z of [1.15, 1.3]) {
    await js(`document.body.style.zoom = "${z}"; true`); await sleep(250);
    const r = await js(`(() => { const out = [], root = document.querySelector(${JSON.stringify(sel)});
      if (!root) return ["no " + ${JSON.stringify(sel)}];
      if (document.documentElement.scrollWidth > innerWidth + 1) out.push("sideways scroll");
      for (const e of [root, ...root.querySelectorAll(".pv-scroll, .cv-in, .rq-acts, .sf-acts")]) if (e.scrollWidth > e.clientWidth + 1) out.push((e.className || e.id) + " overflows");
      for (const e of root.querySelectorAll(".rq-row b, .rq-row small, .pv-head h3, .pv-head p")) if (getComputedStyle(e).textOverflow === "ellipsis" || e.scrollWidth > e.clientWidth + 1) out.push("cut: " + e.textContent);
      for (const g of root.querySelectorAll("#sf-code span")) { const lh = parseFloat(getComputedStyle(g).fontSize) * 1.6; if (g.getBoundingClientRect().height > lh * ${z}) out.push("code group breaks: " + g.textContent); }
      for (const b of root.querySelectorAll("button")) { const q = b.getBoundingClientRect(); if (b.classList.contains("sw") && b.closest(".tg") && b.closest(".tg").getBoundingClientRect().height >= 44) continue;   // the whole row is the switch
        if (q.width && q.height && !b.classList.contains("lnk") && (q.height < 43.5 || q.width < 43.5)) out.push("small: " + (b.textContent || b.getAttribute("aria-label") || b.className)); }
      return out; })()`);
    check(`${where} at ${Math.round(z * 100)}% text: nothing cut or sideways, controls 44 px`, r.length === 0, r);
    if (z === 1.3) await shot(where.replace(/[^a-z]+/gi, "-").toLowerCase() + "-large-text");
  }
  await js(`document.body.style.zoom = ""; true`); await sleep(150);
};
// Settings: which page shows ("closed", "home", or a group's id)
const stAt = () => js(`(() => { if (document.getElementById("page-settings").hidden) return "closed"; if (!document.getElementById("s-home").hidden) return "home";
  const p = [...document.querySelectorAll("#page-settings > [id^=st-]")].filter(b => !b.hidden); return p.length === 1 ? p[0].id.slice(3) : "?" + p.length; })()`);
const stWait = (name, want) => waitFor(name, `(${JSON.stringify(want)} === "closed" ? document.getElementById("page-settings").hidden
  : !document.getElementById("page-settings").hidden && (${JSON.stringify(want)} === "home" ? !document.getElementById("s-home").hidden : !document.getElementById("st-" + ${JSON.stringify(want)}).hidden && document.getElementById("s-home").hidden))`);
let shotN = 0;
async function shot(name) {
  for (const scheme of ["light", "dark"]) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await sleep(150);
    await noGreenOrBlue(js, check, `${name} (${scheme})`);
    if (!SHOTS) continue;
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, "0")}-${name}-${scheme}.png`), Buffer.from(r.result.data, "base64"));
  }
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
}
// A PNG screenshot as RGBA pixels (8-bit RGB or RGBA, not interlaced: what Chrome writes)
function pngPixels(buf) {
  let p = 8, w = 0, h = 0, type = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("latin1", p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9]; if (body[8] !== 8 || body[12] !== 0 || (type !== 2 && type !== 6)) throw new Error("unexpected PNG format"); }
    else if (kind === "IDAT") idat.push(body);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), out = new Uint8ClampedArray(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      cur[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = 255; }
    prev = cur;
  }
  return { data: out, width: w, height: h };
}
// what the QR code in `sel` says, read off a screenshot of the screen as shown (null: none readable)
async function qrOnScreen(sel) {
  // (the QR is drawn once its library has loaded: after a lock's reload that is a fetch away)
  await waitFor(`${sel} is drawn`, `!!document.querySelector(${JSON.stringify(sel)})`, 10000);
  await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no ${sel}"); e.scrollIntoView({ block: "center" }); return true; })()`);
  await sleep(200);
  if (!await seen(sel)) return null;
  const img = pngPixels(Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
  return code ? code.data : null;
}
async function load() {
  await cdp("Page.navigate", { url: A.base + "/" });
  await waitFor("the page loads", `!!document.getElementById("nav-msg")`);
}
// the PIN goes in on the page's own keypad, as a person taps it; it must never sit in a field or the page's text
const tapPin = (pin) => js(`(() => { const ks = [...document.querySelectorAll("#keypad button")]; for (const d of ${JSON.stringify(pin)}) ks.find(b => b.textContent === d).click(); return true; })()`);
const pinNowhere = async (pin, where) => check(`${where}: the PIN is in no field and nowhere in the page`,
  await js(`![...document.querySelectorAll("input, textarea")].some(i => i.value.includes(${JSON.stringify(pin)})) && !(() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll("script").forEach(x => x.remove()); return c.outerHTML; })().includes(${JSON.stringify(pin)})`));
async function enterPin(pin, where) {
  await waitFor("the keypad shows", `!document.getElementById("lk-pad").hidden && !document.getElementById("lock").hidden`);
  await tapPin(pin);
  check(`${where}: one dot per digit`, await js(`document.querySelectorAll("#pin-dots span").length`) === pin.length);
  await pinNowhere(pin, where);
  await click("#b-pin");
}
async function unlock() {
  await waitFor("the lock screen shows", `!document.getElementById("v-locked").hidden`);
  if (await js(`document.getElementById("lk-pad").hidden`)) await click("#b-enter-pin");
  await enterPin(A.pin, "unlocking");
  await waitFor("the wallet opens", `!document.getElementById("v-open").hidden`);
  A.session = await js("token");          // one session at a time: share the page's
}

// ---- locked, then messages not turned on ----
await load();
await waitFor("locked: one lock screen and nothing else", `!document.getElementById("lock").hidden && getComputedStyle(document.getElementById("nav")).display === "none" && getComputedStyle(document.getElementById("page-main")).display === "none"`);
check("without fingerprint the keypad shows at once, and no text field", await js(`!document.getElementById("lk-pad").hidden && !document.querySelector("#lock input") && document.querySelectorAll("#keypad button").length >= 11`));
check("keypad keys are at least 56 px", await js(`[...document.querySelectorAll("#keypad button")].filter(b => !b.hidden).every(b => { const r = b.getBoundingClientRect(); return r.width >= 56 && r.height >= 56; })`));
await shot("locked");
await noOldHeader("the lock screen");
// a physical keyboard: digits, Backspace, Enter; a wrong PIN shakes, clears and says so
const pressKey = (k) => js(`dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true })); true`);
for (const k of "9753184") await pressKey(k);
await pressKey("Backspace");
check("typed on a keyboard, with Backspace: six dots", await js(`document.querySelectorAll("#pin-dots span").length`) === 6);
await pressKey("Enter");
await waitFor("a wrong PIN: cleared, with the app's message", `document.querySelectorAll("#pin-dots span").length === 0 && document.getElementById("m-locked").textContent.length > 0`);
check("the wrong PIN went nowhere in the page", await js(`!(() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll("script").forEach(x => x.remove()); return c.outerHTML; })().includes("975318")`));
await shot("locked-wrong-pin");
// a keypad key reached with Tab: Enter presses that key (a real key event, not a script's), it doesn't submit
await js(`[...document.querySelectorAll("#keypad button")].find(b => b.textContent === "5").focus(); true`);
for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
await sleep(200);
check("Enter on a focused keypad key enters that digit and doesn't submit", await js(`document.querySelectorAll("#pin-dots span").length === 1 && document.getElementById("m-locked").textContent === "" && document.activeElement.textContent === "5"`));
check("after a key, screen readers are told the count of digits (a polite live region), the dots are hidden from them", await js(`document.getElementById("pin-count").textContent === "1 digit entered" && document.getElementById("pin-count").getAttribute("aria-live") === "polite" && document.getElementById("pin-dots").getAttribute("aria-hidden") === "true" && !document.getElementById("pin-count").textContent.includes("5")`));
await pressKey("Backspace");
check("and Backspace takes it out again", await js(`document.querySelectorAll("#pin-dots span").length === 0 && document.getElementById("pin-count").textContent === "No digits entered"`));
await unlock();
check("the bar shows Wallet and Messages", (await text("#nav")).includes("Wallet") && (await text("#nav")).includes("Messages"));
// the wallet home: the header is the λ, Wallet, the node's icon and the gear; then the balance, Send and Receive
check("no 'Logos node / running on this device' anywhere", !/running on this device/.test(await js(`document.body.innerText`)) && (await text("#hdr")).trim() === "Wallet");
await waitFor("the node is catching up: the syncing icon, and one line on why Send waits", `document.getElementById("node-ic").dataset.kind === "sync" && document.getElementById("m-sync").textContent.includes("Sending opens")`, 15000);
check("no node card on the wallet home", await js(`!document.getElementById("page-main").contains(document.getElementById("height"))`));
await shot("wallet-home-starting");
await nodeMode("online");
await waitFor("online: up to date, the balance as the hero", `document.getElementById("node-ic").dataset.kind === "ok" && /75,000/.test(document.getElementById("bal-total").textContent)`, 20000);
check("no addresses on the wallet home until Receive", await js(`document.getElementById("p-recv").hidden && !/[0-9a-f]{10}/.test(document.getElementById("page-main").innerText)`));
check("the wallet home: the token list (Logos), then Send, Receive, Activity, with Activity open", await js(`[...document.querySelectorAll("#tokens .tok")].map(b => b.querySelector("b").textContent).join() === "Logos"
  && [...document.querySelectorAll(".wtabs [role=tab]")].map(b => b.textContent).join() === "Send,Receive,Activity" && !document.getElementById("p-hist").hidden`));
await shot("wallet-home");
// the balance: a normal size, on one line inside the card at any amount, on small and large phones
const setBal = async (key, n) => (await fetch(`http://127.0.0.1:${NODE_PORT}/balance/${key ? key + "/" : ""}${n}`, { method: "POST" })).text();
const key0 = await js(`accts[0].key`);
for (const width of [360, 412]) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const n of ["0", "111111111", "1000000000", "100000000000", "18446744073709551615"]) {
    await setBal(null, 0); await setBal(key0, n);
    const want = BigInt(n).toLocaleString("en-US");
    await js(`loadAccounts(); true`);
    await waitFor(`${width} px: the balance shows ${want}`, `document.getElementById("bal-total").firstChild && document.getElementById("bal-total").firstChild.textContent === ${JSON.stringify(want)}`);
    await sleep(100);
    const m = await js(`(() => { const e = document.getElementById("bal-total"), c = e.closest(".card").getBoundingClientRect(), r = e.getBoundingClientRect(), u = e.querySelector(".unit").getBoundingClientRect();
      return { px: parseFloat(getComputedStyle(e).fontSize), fits: e.scrollWidth <= e.clientWidth, inCard: r.left >= c.left && r.right <= c.right && u.right <= c.right,
               oneLine: Math.abs(u.top - r.top) < parseFloat(getComputedStyle(e).fontSize) && r.height < parseFloat(getComputedStyle(e).fontSize) * 1.6,
               pageFits: document.documentElement.scrollWidth <= innerWidth }; })()`);
    console.log(`     ${width} px, ${want}: ${m.px} px`);
    // in its token row: 18 px, smaller only as the digits grow; 14 px or more up to 100 billion, 9 px for the largest u64
    const floor = n.length >= 20 ? 9 : 14;
    check(`${width} px, ${want}: one line, inside the card, no sideways scroll, ${floor} to 18 px`, m.fits && m.inCard && m.oneLine && m.pageFits && m.px >= floor && m.px <= 18, m);
    if (width === 360 && n === "18446744073709551615") await shot("wallet-home-big-balance");
  }
}
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await setBal(null, 12500); await js(`loadAccounts(); true`);
await waitFor("back to the usual balance", `/75,000/.test(document.getElementById("bal-total").textContent)`);
const popDone = async () => { if (await js(`!document.getElementById("pop").hidden`)) { await click("#pop-ok"); await js(`scrollTo(0, 0); true`); } };    // OK scrolls to Activity
const settle = async () => { await sleep(2500); await js(`checkReceipts().then(() => true)`); await popDone(); };    // the history polls every second
await settle();         // receipts left from the balance-size checks (notes that came back) are taken and closed
// the eye beside the balance hides the amounts on the home screen, and the choice stays on this device
check("the balance shows by default, with a Hide balance eye", await js(`document.getElementById("b-eye").getAttribute("aria-label") === "Hide balance"`));
await click("#b-eye");
await waitFor("hidden: dots instead of the balance", `document.getElementById("bal-total").textContent === "••••••" && document.getElementById("b-eye").getAttribute("aria-label") === "Show balance"`);
await js(`openPanel("recv"); true`);
await waitFor("and no amounts anywhere on the home screen (Receive has none at all, Activity)", `!!document.querySelector("#accts .acct") && !document.querySelector("#accts .bal") && !/[0-9] Logos/.test(document.getElementById("page-main").innerText)`);
check("remembered on this device", await js(`localStorage.getItem("balance-hidden") === "1"`));
await js(`openPanel(null); true`);
await shot("wallet-home-hidden");
await bigTargets("the wallet home");
await click("#b-eye");
await waitFor("shown again", `/75,000/.test(document.getElementById("bal-total").textContent) && document.getElementById("b-eye").getAttribute("aria-label") === "Hide balance" && localStorage.getItem("balance-hidden") === null`);
// the eye hides amounts everywhere the balance could show: the Received pop-up and Send's "not enough" error.
// Each is checked shown first, so "no amount" can't pass just because nothing showed.
const receive = async (...ns) => {
  for (const n of ns) await fetch(`http://127.0.0.1:${NODE_PORT}/receive/${key0}/${n}`, { method: "POST" });
  await waitFor(`the app records ${ns.join(" and ")} received`, `api("/api/wallet/history?limit=20").then(r => ${JSON.stringify(ns.map(String))}.every(n => r.data.entries.some(e => e.kind === "received" && e.amount === n)))`, 15000);
  await waitFor("the Received pop-up shows", `checkReceipts().then(() => !document.getElementById("pop").hidden && document.querySelectorAll("#pop-list .hrow").length === ${ns.length})`, 15000);
  // the heading and the amount column only: the short account address under each could hold any digits
  return js(`[document.getElementById("pop-h").textContent, ...[...document.querySelectorAll("#pop-list .amt")].map(e => e.textContent)].join(" | ")`);
};
let pop = await receive(777);
check("shown: the Received pop-up has the amount", pop === "Received 777 Logos", pop);
await popDone();
pop = await receive(801, 802);
check("shown: two payments, each with its amount", pop === "Received 2 payments | +801 Logos | +802 Logos" || pop === "Received 2 payments | +802 Logos | +801 Logos", pop);
await popDone();
await click("#b-eye");
await waitFor("hidden again", `document.getElementById("bal-total").textContent === "••••••"`);
pop = await receive(888);
check("hidden: the Received pop-up says it came, without the amount", pop === "Received ••••••", pop);
await popDone();
pop = await receive(901, 902);
check("hidden: two payments, no amounts", pop === "Received 2 payments | +•••••• | +••••••", pop);
await popDone();
// Send more than the account holds: the error says how much it holds only while amounts show
const tooMuch = async () => {
  await js(`openPanel("send"); document.getElementById("to").value = "alice"; document.getElementById("amount").value = "999999999999"; document.getElementById("f-send").requestSubmit(); true`);
  await waitFor("Send refuses more than the account holds", `/less than 999,999,999,999 Logos/.test(document.getElementById("m-send").textContent)`);
  const m = await text("#m-send"); await js(`document.getElementById("m-send").textContent = ""; openPanel(null); true`); return m;
};
let sendErr = await tooMuch();
check("hidden: Send's error leaves out what the account holds", /^\S.* holds less than 999,999,999,999 Logos\.$/.test(sendErr) && !/[0-9],[0-9]{3} Logos, less/.test(sendErr), sendErr);
await click("#b-eye");
await waitFor("shown once more", `/[0-9] Logos|[0-9]Logos/.test(document.getElementById("bal-total").textContent) && localStorage.getItem("balance-hidden") === null`);
sendErr = await tooMuch();
check("shown: Send's error says what the account holds", / holds [0-9,]+ Logos, less than 999,999,999,999 Logos\.$/.test(sendErr), sendErr);
await js(`document.getElementById("to").value = ""; document.getElementById("amount").value = ""; true`);
await setBal(null, 12500); await settle(); await js(`loadAccounts(); true`);
await waitFor("back to the usual balance, received notes gone", `/75,000/.test(document.getElementById("bal-total").textContent)`);
await noOldHeader("the wallet home");
await click("#t-recv");
await waitFor("Receive shows the address in full with Copy", `!document.getElementById("p-recv").hidden && document.getElementById("p-recv").innerText.includes("Copy address") && document.getElementById("p-recv").innerText.includes(accts[0].key)`);
await waitFor("and its QR code", `!!document.querySelector("#recv-qr .qr svg path")`);
check("the QR code on Receive reads as the wallet address, exactly (64 hex, nothing added)", await qrOnScreen("#recv-qr .qr") === key0, { read: await qrOnScreen("#recv-qr .qr"), key0 });
check("the QR code holds no amount", !/[0-9],[0-9]|Logos/.test(await qrOnScreen("#recv-qr .qr") || ""));
check("no Scan button without the Android app's scanner", await js(`document.getElementById("b-scan").hidden`));
await shot("wallet-receive");
await click("#t-send");
await waitFor("Send", `!document.getElementById("p-send").hidden && !document.getElementById("b-review").disabled`);
await shot("wallet-send");
await bigTargets("Send");
await js(`document.getElementById("to").focus(); true`);
await waitFor("while typing, the bar steps aside for the keyboard", `getComputedStyle(document.getElementById("nav")).display === "none"`);
await js(`document.getElementById("to").blur(); true`);
await waitFor("and comes back after", `getComputedStyle(document.getElementById("nav")).display !== "none"`);
await click("#t-send");
await click("#node-ic");
await waitFor("the node icon opens Settings > Node", `!document.getElementById("page-settings").hidden && document.getElementById("s-nodec").innerText.includes("Nodes connected")`);
check("at the Node page itself", await stAt() === "node" && (await text("#h-settings")) === "Node", await stAt());
await barOk("Settings > Node", "#page-settings .bar");
await shot("settings-node");
await noOldHeader("Settings");
await click("#b-settings-back");
check("opened from the node icon, Back goes back to the wallet", await stAt() === "closed" && await js(`!document.getElementById("page-main").hidden && !document.getElementById("hdr").hidden`));
await click("#node-ic");
await stWait("the node icon again", "node");
await js(`history.back(); true`);
await stWait("the phone's Back does the same", "closed");
check("and the wallet is back", await js(`!document.getElementById("page-main").hidden`));
await click("#nav-msg");
await waitFor("no key yet: the turn-on screen", `!document.getElementById("mg-nokey").hidden`);
check("the turn-on screen never says key", !/\bkey\b/i.test(await js(`document.getElementById("page-msg").innerText`)));
await shot("turn-on");
await click("#mg-on");
await waitFor("turned on: the chat list, empty", `!document.getElementById("mg-home").hidden && !!document.querySelector("#mg-rows .empty")`);
check("home says no key", !/\bkey\b/i.test(await js(`document.getElementById("page-msg").innerText`)));
await shot("home-no-name");
// Settings > Messages: a short list (Name, Address), each row opening its own page inside it
const mgsAt = () => js(`(() => { if (!document.getElementById("s-msg") || document.getElementById("s-msg").offsetParent === null) return "-";
  if (!document.getElementById("mgs-list").hidden) return "list"; const p = [...document.querySelectorAll("#s-msg > [id^=mgs-]")].filter(e => !e.hidden && e.id !== "mgs-list"); return p.length === 1 ? p[0].id.slice(4) : "?" + p.length; })()`);
const mgsWait = (name, want) => waitFor(name, `!document.getElementById("page-settings").hidden && !document.getElementById("s-msg").hidden && (${JSON.stringify(want)} === "list" ? !document.getElementById("mgs-list").hidden : !document.getElementById("mgs-" + ${JSON.stringify(want)}).hidden && document.getElementById("mgs-list").hidden)`);
await click("#mg-me");
await waitFor("Settings, at Messages", `!document.getElementById("page-settings").hidden && !document.getElementById("s-msg").hidden`);
check("the gear opens Settings > Messages at its list", await mgsAt() === "list" && (await text("#h-settings")) === "Messages");
check("the list: Name, Address, then Requests and Blocked (0.9.14)", JSON.stringify(await js(`[...document.querySelectorAll("#mgs-list .grow")].filter(b => !b.hidden).map(b => b.querySelector("b").textContent)`)) === '["Name","Address","Requests","Blocked"]');
await shot("settings-messages");
await click("#mgs-go-name");
await mgsWait("Name opens its own page", "name");
check("its title is Name", (await text("#h-settings")) === "Name");
await barOk("Settings > Messages > Name", "#page-settings .bar");
const key = (await A.call("/api/messages/key")).d;
check("the page made a seeded identity", key.version === 2 && /^[0-9a-f]{64}$/.test(key.seed) && key.groups === true, key);
await w.register("alice", { color: "#2d6a4f" });                // registered, no msg entry yet
await js(`document.getElementById("mg-name").value = "alice"; document.getElementById("mg-name-save").click(); true`);
await until("the name is saved", async () => (await A.call("/api/messages/key")).d.name === "alice");
await waitFor("not linked on chain yet: it says so", `document.getElementById("mg-check-m").textContent.includes("isn't linked yet")`);
check("the link command is folded away until asked for", await js(`!document.getElementById("mg-link").open`));
check("the messaging address is hidden until Show", await js(`document.getElementById("mg-addr").hidden`));
check("no address or key shows in Settings", !/[0-9a-f]{20,}/.test(await js(`document.getElementById("page-settings").innerText`)));
check("the gear on Messages opens Settings' Messages page", await stAt() === "msg" && await js(`document.getElementById("st-msg").contains(document.getElementById("s-msg"))`));
await js(`window.scrollTo(0, 0); document.getElementById("mg-link").open = true; true`);
await shot("link-your-name");
await js(`document.getElementById("mg-cmd-d").open = true; true`);
await bigTargets("Settings > Messages > Name, link your name");
await js(`document.getElementById("mg-cmd-d").open = false; true`);
await w.register("alice", { msg: key.public, color: "#2d6a4f" });
await click("#mg-check");
await waitFor("linked: it says messages come here", `document.getElementById("mg-check-m").textContent.includes("linked to this phone")`);
await click("#b-settings-back");
await mgsWait("Back from Name returns to the list", "list");
check("the list's title is Messages again", (await text("#h-settings")) === "Messages");
await waitFor("the Name row says alice is linked", `document.querySelector("#mgs-go-name small").textContent === "alice · linked to this phone"`);
await click("#mgs-go-addr");
await mgsWait("Address opens its own page", "addr");
check("its title is Address", (await text("#h-settings")) === "Address");
await barOk("Settings > Messages > Address", "#page-settings .bar");
check("the messaging address is hidden until Show", await js(`document.getElementById("mg-addr").hidden`));
await click("#mg-addr-show");
check("Show reveals the shareable address", (await text("#mg-addr")).startsWith("msg:" + key.public));
await waitFor("and its QR code", `!!document.querySelector("#mg-addr-qr .qr svg path")`);
check("the QR code in Messages settings reads as msg: and the messaging address, exactly", await qrOnScreen("#mg-addr-qr .qr") === "msg:" + key.public, { read: await qrOnScreen("#mg-addr-qr .qr") });
await js(`document.getElementById("mg-addr").scrollIntoView({ block: "center" }); true`);
await shot("my-messaging-address");
await click("#mg-addr-show");
await js(`history.back(); true`);
await mgsWait("the phone's Back from Address returns to the list", "list");
await click("#b-settings-back");
await stWait("and Back from the list returns to Messages, where it was opened", "closed");
await waitFor("the empty chat list", `!!document.querySelector("#mg-rows .empty")`);
check("home shows names and icons only: no address", !/[0-9a-f]{20,}/.test(await js(`document.getElementById("page-msg").innerText`)));
await shot("empty-list");
await noOldHeader("Messages");
check("Messages has its own top: no node header, no status pill", await js(`document.querySelector("main > header").hidden && !!document.getElementById("h-chats")`));
check("no name linked yet: no name card on Messages home", !(await text("#mg-home")).includes("People reach you"));

// ---- Settings: a home list of groups in a fixed order, each opening its own page; Back goes up one level ----
const GROUPS = [["msg", "Messages"], ["name", "Your name"], ["node", "Node"], ["sec", "Security"], ["upd", "Updates"], ["bk", "Backup & restore"], ["look", "Appearance"], ["about", "About"]];
const ANDROID_ONLY = new Set(["name"]);        // only inside the Android app with the LNS signer (checked with erin's app below)
const LINUX_GROUPS = GROUPS.filter(g => !ANDROID_ONLY.has(g[0]));
// Everything Settings had in 0.9.7, by id, and the group page it now lives on. `show`: on screen whenever that page is
// (the rest come and go with the state: fingerprint on or off, an update available, a file picked...).
const INVENTORY = {
  msg: { all: ["s-msg", "h-s-msg", "mg-own", "mg-own-m", "mg-own-go", "mg-else", "mg-else-s", "mg-check-m", "mg-name", "mg-name-save", "mg-name-m", "mg-link", "mg-check", "mg-cmd-d", "mg-cmd", "mg-copy", "mg-addr", "mg-addr-qr", "mg-addr-show", "mg-addr-copy", "mg-addr-m",
              "mg-only-row", "mg-only", "mg-req-dropped", "mg-req-rows", "mg-blk-rows"],
         show: ["mgs-go-name", "mgs-go-addr", "mgs-go-req", "mgs-go-blocked"] },
  node: { all: ["s-nodec", "h-node", "height", "nodeline", "syncline", "state", "peers", "rate", "b-open-node"], show: ["height", "nodeline", "state", "peers", "rate"] },
  sec: { all: ["s-sec", "h-s-sec", "s-fp", "h-s-fp", "fp-off", "b-fp-set", "fp-on", "b-fp-off", "fp-confirm", "b-fp-yes", "b-fp-no", "nfp-on-form", "nfp-pin", "b-nfp-on", "fp-host", "m-fp", "s-lock", "h-s-lock", "al-min", "al-grace", "m-al", "b-lock"],
         show: ["h-s-fp", "h-s-lock", "al-min", "al-grace", "b-lock"] },
  upd: { all: ["s-upd", "h-s-upd", "s-version", "upd", "upd-text", "upd-go", "b-upd-fp", "l-upd-pin", "upd-pin", "b-upd", "m-upd", "b-upd-check", "m-upd-check", "upd-embedded", "upd-src"],
         show: ["s-version", "b-upd-check", "upd-src"] },
  bk: { all: ["s-bk", "h-s-bk", "bk-state", "bk", "f-bk", "bk-what", "bk-pw1", "bk-show", "bk-short", "bk-pw2-row", "bk-pw2", "bk-hist", "bk-pin", "b-bk", "m-bk", "bk-done", "bk-name", "bk-who",
              "s-rs", "h-s-rs", "rs", "rs-file", "rs-step2", "rs-compare", "rs-warn", "rs-msg", "rs-pw", "rs-show", "rs-pin", "rs-ok", "b-rs", "m-rs"],
        show: ["h-s-bk", "bk-state", "bk-what", "bk-pw1", "bk-show", "bk-pw2", "bk-hist", "bk-pin", "b-bk", "h-s-rs", "rs-file"] },
  about: { all: ["s-about", "h-s-about", "about-version", "about-upd", "about-talk"], show: ["about-version", "about-talk"] },
  look: { all: ["s-look", "h-s-look", "th-system", "th-light", "th-dark"], show: ["th-system", "th-light", "th-dark"] },
  name: { all: ["s-lns", "h-s-lns", "lns-none", "lns-in", "b-lns-get", "lns-cost", "b-lns-link", "lns-flow", "lns-flow-name", "lns-steps", "lns-need",
                "b-lns-addlez", "lns-keep", "lns-flow-err", "lns-flow-acts", "b-lns-stop", "b-lns-retry", "lns-has", "lns-name", "lns-ent-bc", "lns-ent-msg",
                "lns-bk", "b-lns-bk", "lns-notes", "b-lns-putback", "m-lns", "lns-more", "lns-manual", "b-lns-bc", "b-lns-msg"],
          show: ["lns-in", "b-lns-get", "lns-more"] },
};
// and the words, as they were (a few from each)
const WORDS = {
  msg: ["Name", "alice · linked to this phone", "Address", "Show it, copy it, or let them scan it"],
  node: ["blocks on this device", "State", "Nodes connected", "New blocks a minute"],
  sec: ["Fingerprint unlock", "Auto-lock", "Locks after this long without use", "after you leave the app", "Lock now"],
  upd: ["Installed version", "Check for updates", "Updates come from the project's GitHub repository"],
  bk: ["Back up", "Saves this wallet", "Backup password (at least 8 characters)", "Include message history", "Save backup file", "Restore from a backup", "Restoring replaces this wallet's accounts"],
  about: ["Version", "This page is served by the app on this device", "Testnet."],
  look: ["System", "Light", "Dark"],
  name: ["LNS name", "Get this name", "I already hold it", "More"],
};
await click("#nav-wallet");
await click("#b-gear");
await stWait("the gear opens Settings at its home list", "home");
check("the home list has the groups, in this order: " + LINUX_GROUPS.map(g => g[1]).join(", "),
  JSON.stringify(await js(`[...document.querySelectorAll("#s-groups .grow")].filter(b => !b.hidden).map(b => b.querySelector("b").textContent)`)) === JSON.stringify(LINUX_GROUPS.map(g => g[1])));
check("outside the Android app there is no Your name", await js(`!document.getElementById("s-lns") && (!document.getElementById("go-name") || document.getElementById("go-name").hidden)`));
check("and nothing else on it but the list", await js(`[...document.getElementById("s-home").children].filter(e => !e.hidden).map(e => e.id).join() === "s-groups"`));
check("its title is Settings, at a normal size", (await text("#h-settings")) === "Settings");
await barOk("Settings", "#page-settings .bar");
const rowState = (id) => text(`#go-${id} small`);
await waitFor("each row has one line on where it stands", `[...document.querySelectorAll("#s-groups .grow")].filter(b => !b.hidden).every(b => b.querySelector("small").textContent.length > 0)`);
for (const [id, want] of [["msg", /^On · linked to alice$/], ["node", /^(Up to date|Online) · block [0-9,]+$/], ["sec", /^PIN · locks after 5 minutes$/], ["upd", /^Version \d+\.\d+\.\d+/], ["bk", /^No backup yet$/], ["look", /^System$/], ["about", /^Version \d+\.\d+\.\d+ · Testnet$/]])
  check(`the ${id} row says ${want}`, want.test(await rowState(id)), await rowState(id));
check("the rows say no key or address", !/\bkey\b|[0-9a-f]{20,}/i.test(await text("#s-groups")));
for (const width of [360, 412]) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(150);
  check(`${width} px: the list fits (no sideways scroll), each row 44 px or more, one line each`, await js(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll("#s-groups .grow")].filter(b => !b.hidden).every(b => {
    const r = b.getBoundingClientRect(), c = b.closest(".card").getBoundingClientRect(), sm = b.querySelector("small"); return r.height >= 44 && r.right <= c.right + 0.5 && sm.scrollHeight <= parseFloat(getComputedStyle(sm).lineHeight) * 1.5; })`));
  await barOk(`${width} px: Settings`, "#page-settings .bar");
}
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await shot("settings");
await noOldHeader("Settings home");
check("the reload notice (after an update) shows above Settings' bar, not under it", await js(`(() => { const r = document.getElementById("reload"); r.hidden = false;
  const ok = document.querySelector("#page-settings .bar").getBoundingClientRect().top >= r.getBoundingClientRect().bottom - 0.5; r.hidden = true; return ok; })()`));
const seenIds = new Set();
// Settings > Messages' own pages: what 0.9.8's one Messages page had, each id on exactly one of them
const MSG_SUB = [
  ["name", "Name", { all: ["mg-own", "mg-own-m", "mg-own-go", "mg-else", "mg-else-s", "mg-check-m", "mg-name", "mg-name-save", "mg-name-m", "mg-link", "mg-check", "mg-cmd-d", "mg-cmd", "mg-copy"], show: ["mg-check-m", "mg-name", "mg-name-save", "mg-link"],
    words: ["Your name", "alice, linked to this phone", "Without a name you can still write and get messages", "Link your name to this phone"] }],
  ["addr", "Address", { all: ["mg-addr", "mg-addr-qr", "mg-addr-show", "mg-addr-copy", "mg-addr-m"], show: ["mg-addr-show", "mg-addr-copy"],
    words: ["Your messaging address", "Anyone can write to this phone at this address", "Coins go to your wallet address"] }],
  ["req", "Requests", { all: ["mg-only-row", "mg-only", "mg-req-dropped", "mg-req-rows"], show: ["mg-only-row", "mg-only", "mg-req-rows"],
    words: ["Messages from people not in your chats wait here", "Only people I've written to", "Messages from anyone else are deleted unread", "No requests"] }],
  ["blocked", "Blocked", { all: ["mg-blk-rows"], show: ["mg-blk-rows"], words: ["Nobody is blocked"] }],
];
async function msgSubPages() {
  const seen = new Set(["s-msg", "h-s-msg"]);
  for (const [sub, label, inv] of MSG_SUB) {
    await click(`#mgs-go-${sub}`);
    await mgsWait(`Messages > ${label} opens its own page`, sub);
    check(`Messages > ${label}: the title is ${label}`, (await text("#h-settings")) === label);
    await barOk(`Settings > Messages > ${label}`, "#page-settings .bar");
    await noOldHeader(`Settings > Messages > ${label}`);
    const where = await js(`${JSON.stringify(inv.all)}.map(x => { const n = document.querySelectorAll("#" + x); const b = n.length === 1 && n[0].closest("#s-msg > [id^=mgs-]"); return n.length + ":" + (b ? b.id : "-"); })`);
    check(`Messages > ${label}: each of its ${inv.all.length} controls and texts is on this page, once`, where.every(x => x === "1:mgs-" + sub), inv.all.map((x, i) => x + " " + where[i]).filter(x => !x.endsWith("1:mgs-" + sub)));
    const hid = await js(`${JSON.stringify(inv.show)}.filter(x => { const e = document.getElementById(x); return !e || e.offsetParent === null; })`);
    check(`Messages > ${label}: and what is always there shows`, hid.length === 0, hid);
    if (sub === "name") await waitFor("the name check answers", `document.getElementById("mg-check-m").textContent.includes("linked to this phone")`);
    const words = await js(`document.getElementById("mgs-${sub}").textContent.replace(/\\s+/g, " ")`);
    const lost = inv.words.filter(w => !words.includes(w));
    check(`Messages > ${label}: its words are all there`, lost.length === 0, lost);
    check(`Messages > ${label}: only this page shows`, await js(`[...document.querySelectorAll("#s-msg > [id^=mgs-]")].filter(e => !e.hidden).length === 1`));
    for (const x of inv.all) seen.add(x);
    await click("#b-settings-back");
    await mgsWait(`Back from Messages > ${label} returns to Messages' list`, "list");
    check("titled Messages", (await text("#h-settings")) === "Messages");
    await click(`#mgs-go-${sub}`); await mgsWait(`Messages > ${label} again`, sub);
    await js(`history.back(); true`);
    await mgsWait(`the phone's Back from Messages > ${label} returns to Messages' list too`, "list");
  }
  check(`nothing from 0.9.8's Messages page is lost: ${seen.size} ids, each on one page`, JSON.stringify([...seen].sort()) === JSON.stringify([...INVENTORY.msg.all].sort()));
}
async function groupPage(id, label) {
  await click(`#go-${id}`);
  await stWait(`${label} opens its own page`, id);
  check(`${label}: the title is ${label}`, (await text("#h-settings")) === label);
  await barOk(`Settings > ${label}`, "#page-settings .bar");
  await noOldHeader(`Settings > ${label}`);
  const inv = INVENTORY[id];
  const where = await js(`${JSON.stringify(inv.all)}.map(x => { const n = document.querySelectorAll("#" + x); const b = n.length === 1 && n[0].closest("#page-settings > [id^=st-]"); return n.length + ":" + (b ? b.id : "-"); })`);
  check(`${label}: every control and text of the group is on this page, once (${inv.all.length})`, where.every(x => x === "1:st-" + id), inv.all.map((x, i) => x + " " + where[i]).filter(x => !x.endsWith("1:st-" + id)));
  const hid = await js(`${JSON.stringify(inv.show)}.filter(x => { const e = document.getElementById(x); return !e || e.offsetParent === null; })`);
  check(`${label}: and what is always there shows`, hid.length === 0, hid);
  const words = await text(`#st-${id}`);
  const lost = WORDS[id].filter(w => !words.includes(w));
  check(`${label}: its words are all there`, lost.length === 0, lost);
  check(`${label}: no other group's sections on this page`, await js(`[...document.querySelectorAll("#page-settings > [id^=st-]")].filter(b => !b.hidden).length === 1`));
  for (const x of inv.all) seenIds.add(x);
  const names = { msg: null, node: null, sec: "settings-security", upd: "settings-updates", bk: "settings-backup", about: "settings-about" };
  if (names[id]) await shot(names[id]);
  if (id === "bk") { await js(`document.getElementById("s-rs").scrollIntoView({ block: "start" }); true`); await shot("settings-restore"); }
  if (id === "sec") {      // the controls still work from here: auto-lock saves (and the row says it), then back as it was
    await js(`(() => { const s = document.getElementById("al-min"); s.value = "15"; s.dispatchEvent(new Event("change")); return true; })()`);
    await waitFor("auto-lock saves from Settings > Security", `document.getElementById("m-al").textContent.includes("15 minutes")`);
    await js(`(() => { const s = document.getElementById("al-min"); s.value = "5"; s.dispatchEvent(new Event("change")); return true; })()`);
    await waitFor("and back to 5", `document.getElementById("m-al").textContent.includes("5 minutes") && !document.getElementById("m-al").textContent.includes("15")`);
  }
  if (id === "upd") {
    await click("#b-upd-check");
    await waitFor("Check for updates answers from Settings > Updates", `document.getElementById("m-upd-check").textContent.length > 0 && document.getElementById("m-upd-check").textContent !== "Checking GitHub…"`, 20000);
  }
  if (id === "msg") {
    check("Settings > Messages is the same page as the gear's", await js(`document.getElementById("st-msg").contains(document.getElementById("s-msg")) && document.querySelectorAll("#s-msg").length === 1`));
    check("and it opens at its list", await mgsAt() === "list");
    await msgSubPages();
  }
  await click("#b-settings-back");
  await stWait(`Back from ${label} returns to the list`, "home");
  await click(`#go-${id}`);
  await stWait(`${label} again`, id);
  await js(`history.back(); true`);
  await stWait(`the phone's Back from ${label} returns to the list too`, "home");
}
for (const [id, label] of LINUX_GROUPS) await groupPage(id, label);
check(`nothing from 0.9.7's Settings is lost: ${seenIds.size} ids, each on one group page`, seenIds.size === LINUX_GROUPS.reduce((n, g) => n + INVENTORY[g[0]].all.length, 0));
check("the not-unlocked note is on the home list", await js(`document.getElementById("s-home").contains(document.getElementById("s-locked"))`));
await js(`history.back(); true`);
await stWait("the phone's Back from the list leaves Settings", "closed");
check("back on the wallet", await js(`!document.getElementById("page-main").hidden && !document.getElementById("nav").hidden`));
// the notices on the wallet open their group's page; Back goes back to the wallet
await waitFor("the no-backup notice shows", `!document.getElementById("n-bk").hidden`);
await click("#n-bk");
await stWait("the no-backup notice opens Backup & restore", "bk");
await waitFor("with the cursor in the backup password", `document.activeElement && document.activeElement.id === "bk-pw1"`);
await js(`document.activeElement.blur(); true`);
await click("#b-settings-back");
await stWait("Back from there returns to the wallet", "closed");
// the gear on Messages and Settings > Messages: one page, Back goes back where it came from
await click("#nav-msg");
await waitFor("Messages home", `!document.getElementById("mg-home").hidden`);
await click("#mg-me");
await stWait("the gear on Messages opens Settings > Messages", "msg");
check("at its list", await mgsAt() === "list");
await click("#mgs-go-name");
await mgsWait("Name", "name");
await waitFor("filled in", `document.getElementById("mg-name").value === "alice"`);
await click("#b-settings-back");
await mgsWait("Back: Messages' list", "list");
await click("#b-settings-back");
await stWait("Back again returns to Messages", "closed");
check("Messages, as it was", await js(`!document.getElementById("page-msg").hidden && !document.getElementById("mg-home").hidden`));
// a lock (auto-lock) and unlock comes back to the same Settings page, at its first step (a page inside it, like
// Messages > Name, starts again from the group's own page)
for (const [id, label] of [["sec", "Security"], ["msg", "Messages"]]) {
  await click("#nav-wallet"); await click("#b-gear"); await stWait("Settings", "home");
  await waitFor(`its ${label} row (after the lock's reload, once the page has read it again)`, `!document.getElementById("go-${id}").hidden`, 15000);
  await click(`#go-${id}`); await stWait(label, id);
  if (id === "msg") { await click("#mgs-go-name"); await mgsWait("Messages > Name", "name"); }
  await js(`lockedNow(); true`);
  await waitFor("locked (the page loaded again, into the lock screen)", `!document.getElementById("lock").hidden && !document.documentElement.classList.contains("relock")`);
  check(`locked on Settings > ${label}: nothing of it shows`, !/Auto-lock|alice|Your messaging address/.test(await js(`document.body.innerText`)));
  check(`locked: the Settings rows keep no name, not even hidden`, !/alice/.test(await js(`document.getElementById("s-groups").textContent + [...document.querySelectorAll("#s-groups [aria-label]")].map(e => e.getAttribute("aria-label")).join()`)));
  check(`locked: Settings > Messages keeps none of it, not even hidden (no name, no messaging address)`, await js(`(() => { const m = document.getElementById("s-msg"), t = m.textContent + [...m.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label")).join() + [...m.querySelectorAll("input")].map(i => i.value).join();
    return !/alice/.test(t) && !/[0-9a-f]{20,}/.test(t) && !m.querySelector(".qr"); })()`));
  await unlock();
  await stWait(`unlocked: back on Settings > ${label}`, id);
  check(`with its title, ${label}`, (await text("#h-settings")) === label);
  if (id === "msg") await mgsWait("at Messages' own list, its first step", "list");
  await js(`history.back(); true`);
  await stWait("the phone's Back still goes up one level", "home");
  await click("#b-settings-back");
  await stWait("and out", "closed");
}
await click("#nav-msg");
await waitFor("Messages home", `!document.getElementById("mg-home").hidden`);

// ---- new chat: not registered, no msg entry, found ----
await w.register("dave", { display: "Dave" });
await click("#mg-new");
await barOk("New chat", "#mg-newv .bar");
check("New chat's title is New chat", (await text("#h-new")) === "New chat");
for (const [name, want] of [["zed", "isn't a registered name"], ["dave", "hasn't turned on messages"], ["bob", "Start chat"]]) {
  await js(`document.getElementById("mg-to").value = ${JSON.stringify(name)}; document.getElementById("mg-find").requestSubmit(); true`);
  await waitFor(`new chat with ${name}: ${want}`, `document.getElementById("mg-found").innerText.includes(${JSON.stringify(want)})`);
  if (name === "dave") await shot("new-chat-nokey");
}
await shot("new-chat-by-name");
await noOldHeader("New chat");
await js(`[...document.querySelectorAll("#mg-found button")].find(b => b.textContent === "Start chat").click(); true`);
await waitFor("the chat opens", `!!document.querySelector(".ov .cmp")`);
await shot("chat-new");

// ---- a conversation: yesterday's messages, replies both ways, a long one ----
const bob = await chatOf(w, B), carol = await chatOf(w, C);
await bob.startDirect("alice");          // (0.9.14) bob writes to alice below, so she is in his chats, not a request
const yesterday = Date.now() - 864e5;
for (const [t, txt] of [[yesterday - 600000, "Are you coming to the meetup tomorrow?"], [yesterday - 540000, "It starts at 7, at the usual place"]]) {
  const sealed = MC.sealMessage({ to: MC.fromHex(key.public), from: "bob", fromSecret: B.id.secretKey, text: txt, ts: t });
  await B.call("/api/messages/send", { topic: MC.inboxTopic(MC.fromHex(key.public)), payload: b64(sealed) });
}
await waitFor("bob's messages show in the chat", `document.querySelector(".cv-in").innerText.includes("usual place")`);
await js(`(() => { const t = document.querySelector(".cmp textarea"); t.value = "Yes! I'll bring the slides. Is there a projector?"; t.dispatchEvent(new Event("input")); document.querySelector(".cmp .go").click(); return true; })()`);
await waitFor("my message shows on the right", `!!document.querySelector(".bub.out")`);
await waitFor("and gets its sent mark (one tick)", `!!document.querySelector(".cv-in [aria-label=Sent]")`, 15000);
await bob.lookup("alice", true); await bob.sync();
await until("bob gets it", async () => { await bob.sync(); return bob.messages("d:alice").some(m => m.dir === "in" && m.text.includes("projector")); });
await bob.send("d:alice", "There is one, HDMI only.");
await bob.send("d:alice", "Also: could you send me the address of that bakery you mentioned last week? I want to try their sourdough before the weekend, and I keep forgetting the name of the street it's on.");
await waitFor("bob's replies arrive", `document.querySelector(".cv-in").innerText.includes("sourdough")`, 15000);
check("day separators: Yesterday and Today", (await text(".cv-in")).includes("Yesterday") && (await text(".cv-in")).includes("Today"));
check("a fine chat says nothing about verification (problems only)", !/verified/i.test(await text(".ov .ov-top")));
await barOk("a chat", ".ov .bar");
await shot("chat");
// a small phone with the keyboard up: 360 px wide, the composer above the keyboard
await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 420, deviceScaleFactor: 2, mobile: true });
await js(`document.querySelector(".cmp textarea").focus(); document.querySelector(".cmp textarea").value = "On my way"; document.querySelector(".cmp textarea").dispatchEvent(new Event("input")); true`);
await sleep(300);
check("with the keyboard up the composer is still on screen", await js(`(() => { const r = document.querySelector(".cmp").getBoundingClientRect(); return r.bottom <= window.innerHeight + 1 && r.top > 0; })()`));
await shot("chat-keyboard-360");
await js(`document.querySelector(".cmp textarea").value = ""; document.querySelector(".cmp textarea").dispatchEvent(new Event("input")); document.activeElement.blur(); true`);
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await noOldHeader("a chat");
// message details
await js(`document.querySelector(".bub.out").click(); true`);
await waitFor("details of my message", `!!document.querySelector(".sheet") && document.querySelector(".sheet").innerText.includes("To bob")`);
await shot("message-details");
{ const t = await text(".sheet");
  check("details say what the app knows, never delivered or read", t.includes("can't tell when bob reads it") && !/Stored|delivered/i.test(t), t); }
await bigTargets("message details");
await js(`history.back(); true`);
await waitFor("the sheet closes", `!document.querySelector(".sheet")`);

// ---- a profile with a note ----
await click(".ov .who");
await waitFor("bob's profile", `!!document.getElementById("pv-note")`);
await barOk("a profile", ".ov[aria-label=Profile] .bar");
await js(`(() => { const n = document.getElementById("pv-nick"); n.value = "Bob (meetup)"; n.dispatchEvent(new Event("change")); return true; })()`);
await waitFor("nickname saved", `document.querySelector(".saved").textContent.includes("Saved")`);
await js(`(() => { const n = document.getElementById("pv-note"); n.value = "Runs the Thursday meetup. Prefers Signal for anything urgent."; n.dispatchEvent(new Event("input")); n.dispatchEvent(new Event("blur")); return true; })()`);
await waitFor("note saved", `document.querySelector(".saved").textContent.includes("Saved")`);
await shot("profile");
await noOldHeader("a profile");
check("a fine profile says nothing about verification", !/verified/i.test(await text(".pv-in")));
await js(`history.back(); true`); await sleep(200);
await js(`history.back(); true`);
await waitFor("back on the list", `document.querySelectorAll("#mg-rows .crow").length >= 1 && !document.querySelector(".ov")`);
check("the list shows the nickname", (await text("#mg-rows")).includes("Bob (meetup)"));

// ---- someone with no LNS name: by messaging address, both ways ----
const D = await app(w, 8114 + PS, w.NODES[3]);
D.pin = "444555"; D.session = (await D.call("/api/wallet/setup", { pin: D.pin })).d.session;
const did = ID.newIdentity();
await D.call("/api/messages/key", { seed: hex(did.seed), secret: hex(did.secretKey), public: hex(did.publicKey) });
const dchat = await chatOf(w, D);
await dchat.startDirect("alice");        // (0.9.14) they are about to write to each other: alice is in their chats
await click("#mg-new");
check("no Scan in New chat without the Android app's scanner", await js(`document.getElementById("mg-scan").hidden`));
const wallet = await js(`accts.length ? accts[0].key : ""`);
if (wallet) {
  await js(`document.getElementById("mg-to").value = ${JSON.stringify(wallet)}; document.getElementById("mg-find").requestSubmit(); true`);
  await waitFor("a wallet address is refused, plainly", `document.getElementById("mg-found").innerText.includes("looks like a wallet address")`);
} else console.log("     (no wallet keys listed in this test app: the wallet-address check runs in tests/chat_test.mjs)");
// typed as a person would paste it (insertText keeps the field's maxlength, which .value doesn't)
await js(`(() => { const t = document.getElementById("mg-to"); t.value = ""; t.focus(); return true; })()`);
const pasted = "msg: " + hex(did.publicKey).slice(0, 30) + " " + hex(did.publicKey).slice(30);
await cdp("Input.insertText", { text: pasted });
check("a pasted messaging address isn't cut off by the field", (await js(`document.getElementById("mg-to").value`)) === pasted);
await js(`document.getElementById("mg-find").requestSubmit(); true`);
await waitFor("an address (with spaces) is taken: no LNS name, and it asks what to call them", `document.getElementById("mg-found").innerText.includes("No LNS name") && !!document.getElementById("mg-nick")`);
check("it shows a short code, not the address", !(await text("#mg-found")).includes(hex(did.publicKey)));
await js(`document.getElementById("mg-nick").focus(); true`);
await cdp("Input.insertText", { text: "Flyer friend" });
await shot("new-chat-by-address");
await js(`[...document.querySelectorAll("#mg-found button")].find(b => b.textContent === "Start chat").click(); true`);
await waitFor("the address chat opens", `!!document.querySelector(".ov .cmp")`);
await js(`(() => { const t = document.querySelector(".cmp textarea"); t.value = "Hi! Got your address from the flyer."; t.dispatchEvent(new Event("input")); document.querySelector(".cmp .go").click(); return true; })()`);
await waitFor("sent to the address", `!!document.querySelector(".cv-in [aria-label=Sent]")`, 15000);
await until("the nameless person gets it, from alice", async () => { await dchat.sync(); return dchat.messages("d:alice").length === 1 && dchat.trust(dchat.messages("d:alice")[0]) === "ok"; });
await dchat.send("d:alice", "Thanks! I don't have an LNS name yet.");
await waitFor("their reply shows in the same chat", `document.querySelector(".cv-in").innerText.includes("don't have an LNS name")`, 15000);
check("the header says No LNS name, and uses the name given", (await text(".ov .ov-top")).includes("No LNS name") && (await text(".ov .ov-top")).includes("Flyer friend"), await text(".ov .ov-top"));
await shot("chat-address");
await click(".ov .who");
await waitFor("the address profile", `!!document.getElementById("pv-note")`);
check("the profile shows no address until Details", !/[0-9a-f]{20,}/.test(await js(`document.querySelector(".pv-in").innerText`)));
await shot("profile-address");
await js(`history.back(); true`); await sleep(200);
await js(`history.back(); true`);
await waitFor("back on the list", `!document.querySelector(".ov")`);

// ---- carol writes first; someone claims to be dave; then carol's key changes ----
await carol.lookup("alice", true);
await carol.startDirect("alice");
await carol.send("d:alice", "Hi Alice, it's Carol from the workshop. Do you still have the notes?");
const forged = MC.sealMessage({ to: MC.fromHex(key.public), from: "dave", fromSecret: MC.newKeyPair().secretKey, text: "Hey, it's Dave. Can you send me 50 Logos?" });
await w.control("inject/0", { topic: MC.inboxTopic(MC.fromHex(key.public)), payload: b64(forged) });
// (0.9.14) alice never wrote to either: both are requests. One neutral line on the list, nothing else.
await waitFor("two message requests: one line on the list", `!document.getElementById("mg-req-line").hidden && document.getElementById("mg-req-line").innerText.includes("2 message requests")`, 15000);
check("nothing of them in the chat list, the page or the unread count", !/carol|dave|workshop|50 Logos|Not verified/i.test(await js(`document.getElementById("page-msg").innerText`))
  && await js(`document.querySelector("#nav .badge").hidden`) && !/carol|dave/.test(await js(`document.getElementById("mg-rows").textContent`)));
await shot("list-with-requests");
await bigTargets("the chat list with requests");
await click("#mg-req-line");
await mgsWait("the line opens Settings > Messages > Requests", "req");
check("titled Requests", (await text("#h-settings")) === "Requests");
await barOk("Settings > Messages > Requests", "#page-settings .bar");
await waitFor("both requests listed, carol's name read on the chain", `document.querySelectorAll("#mg-req-rows .rq-row").length === 2 && document.getElementById("mg-req-rows").innerText.includes("LNS name")`, 15000);
{
  const rows = await js(`[...document.querySelectorAll("#mg-req-rows .rq-row")].map(r => [r.querySelector("b").textContent, r.querySelector("small").textContent])`);
  check("carol, with her LNS name proven; the other as Unnamed contact that says it's dave, not proven", rows.some(r => r[0] === "carol" && r[1] === "LNS name") && rows.some(r => r[0] === "Unnamed contact" && r[1] === "Says it's dave. Not proven."), rows);
  check("no request is titled dave, and no text of them shows before a tap", !rows.some(r => r[0] === "dave") && !/workshop|50 Logos/.test(await text("#mgs-req")));
}
await shot("requests");
await bigTargets("Requests");
await bigText("Requests", "#mgs-req");
await js(`[...document.querySelectorAll("#mg-req-rows .rq-row")].find(r => r.querySelector("b").textContent === "Unnamed contact").click(); true`);
await waitFor("the claim's page", `!!document.querySelector(".ov[aria-label=Request]")`);
await barOk("a request", ".ov[aria-label=Request] .bar");
check("its text, as plain text, and only Delete and Block (no Accept for a claim)", (await text(".ov[aria-label=Request]")).includes("50 Logos")
  && JSON.stringify(await js(`[...document.querySelectorAll(".ov[aria-label=Request] .rq-acts button")].map(b => b.textContent)`)) === '["Delete","Block"]');
check("it says the name isn't theirs", (await text(".ov[aria-label=Request]")).includes("dave's messaging address is a different one"));
await shot("request-claim");
await js(`[...document.querySelectorAll(".ov[aria-label=Request] .rq-acts button")].find(b => b.textContent === "Block").click(); true`);
await waitFor("Block asks first", `!!document.querySelector(".sheet") && document.querySelector(".sheet").innerText.includes("Block this sender?")`);
await js(`[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Block").click(); true`);
await waitFor("blocked: one request left", `!document.querySelector(".ov[aria-label=Request]") && document.querySelectorAll("#mg-req-rows .rq-row").length === 1`, 10000);
await waitFor("(and the page's history is back on Requests, in one step)", `history.state && history.state.sub === "req"`);
await js(`[...document.querySelectorAll("#mg-req-rows .rq-row")].find(r => r.querySelector("b").textContent === "carol").click(); true`);
await waitFor("carol's request", `!!document.querySelector(".ov[aria-label=Request]") && document.querySelector(".ov[aria-label=Request]").innerText.includes("workshop")`);
check("Accept, Delete and Block", JSON.stringify(await js(`[...document.querySelectorAll(".ov[aria-label=Request] .rq-acts button")].map(b => b.textContent)`)) === '["Accept","Delete","Block"]');
await shot("request");
await bigTargets("a request");
await bigText("A request", ".ov[aria-label=Request]");
await js(`[...document.querySelectorAll(".ov[aria-label=Request] .rq-acts button")].find(b => b.textContent === "Accept").click(); true`);
await waitFor("accepted: carol is in the chats", `!document.querySelector(".ov[aria-label=Request]") && document.getElementById("mg-req-rows").innerText.includes("carol is in your chats now")`, 10000);
await waitFor("(the page's history is back on Requests)", `history.state && history.state.sub === "req"`);
await click("#b-settings-back");
await mgsWait("Back: Messages' list", "list");
check("Blocked has the claim, as what it said", (await text("#mgs-go-blocked")).includes("1 blocked"));
await click("#mgs-go-blocked"); await mgsWait("Blocked", "blocked");
check("listed as an Unnamed contact that said it was dave, with Unblock", (await text("#mg-blk-rows")).includes("Said it was dave") && (await text("#mg-blk-rows")).includes("Unblock"));
await shot("blocked");
await bigTargets("Blocked");
await bigText("Blocked", "#mgs-blocked");
await click("#b-settings-back"); await mgsWait("Back", "list");
await click("#b-settings-back"); await stWait("and out", "closed");
await waitFor("no requests left: the line goes", `document.getElementById("mg-req-line").hidden && document.getElementById("mg-rows").innerText.includes("carol")`);
await carol.send("d:alice", "Did you get my message?");
await waitFor("carol's chat shows up, unread", `document.getElementById("mg-rows").innerText.includes("carol") && !!document.querySelector("#mg-rows .badge")`, 15000);
check("and the claim isn't in the list", !/Not verified|dave/.test(await text("#mg-rows")));
await waitFor("the bar has an unread count", `!document.querySelector("#nav .badge").hidden`);
await shot("list");
await bigTargets("the chat list");
const C2 = MC.newKeyPair();
await w.register("carol", { msg: hex(C2.publicKey) });
const sealedNew = MC.sealMessage({ to: MC.fromHex(key.public), from: "carol", fromSecret: C2.secretKey, text: "New phone, new address." });
await w.control("inject/0", { topic: MC.inboxTopic(MC.fromHex(key.public)), payload: b64(sealedNew) });
await js(`[...document.querySelectorAll("#mg-rows .crow")].find(r => r.innerText.includes("carol")).click(); true`);
await waitFor("carol's address changed: the banner", `!!document.querySelector(".cv-ban:not([hidden])") && document.querySelector(".cv-ban").innerText.includes("address changed")`, 15000);
await waitFor("her message from the new address is marked", `document.querySelector(".cv-in").innerText.includes("new messaging address, not accepted")`, 10000);
check("and there's no composer until it's accepted", await js(`document.querySelector(".cmp").hidden`));
await shot("key-changed");
await bigTargets("a chat with a changed address");
await js(`[...document.querySelectorAll(".cv-ban button")].find(b => b.textContent === "Accept the change").click(); true`);
await waitFor("accepted: the composer is back", `!document.querySelector(".cmp").hidden`);
check("her earlier message is marked as from the earlier address", (await text(".cv-in")).includes("earlier messaging address"));
await js(`history.back(); true`);
await waitFor("back on the list", `!document.querySelector(".ov")`);

check("no keys on the everyday screens: list", !/[0-9a-f]{20,}/.test(await js(`document.getElementById("page-msg").innerText`)));
check("no errors in the page", errors.length === 0, errors);

// ---- a safety code: compared with bob; then bob's address changes after the check ----
const openChat = async (who) => { await js(`[...document.querySelectorAll("#mg-rows .crow")].find(r => r.innerText.includes(${JSON.stringify(who)})).click(); true`); await waitFor(`${who}'s chat`, `!!document.querySelector(".ov .cv-in")`); };
await openChat("Bob (meetup)");
await click(".ov .who");
await waitFor("bob's profile", `!!document.getElementById("pv-note")`);
check("Details: the safety code is not checked", (await js(`document.getElementById("pv-checked").textContent`)) === "Not checked");
await js(`document.querySelector(".pv-in details").open = true; true`);
await click("#pv-safety");
await waitFor("the safety code page", `!!document.querySelector(".ov[aria-label='Safety code'] #sf-code")`);
await barOk("the safety code", ".ov[aria-label='Safety code'] .bar");
const bobCode = CORE.safetyCode(key.public, hex(B.id.publicKey));
check("12 groups of 5 digits: the code of alice's and bob's messaging addresses (the one bob's phone shows)",
  JSON.stringify(await js(`[...document.querySelectorAll("#sf-code span")].map(x => x.textContent)`)) === JSON.stringify(CORE.safetyGroups(bobCode)) && bobCode === (await chatOf(w, B)).safetyFor("alice").code);
check("not checked yet, and no 'verified' anywhere", (await text("#sf-state")) === "Not checked" && !/verified/i.test(await text(".ov[aria-label='Safety code']")));
check("no Scan without the Android app's scanner", !(await js(`!!document.getElementById("sf-scan")`)));
await click("#sf-show");
check("Show my code: a QR of the safety code", await qrOnScreen("#sf-qr .qr") === "names-safety:1:" + bobCode, { read: await qrOnScreen("#sf-qr .qr") });
await shot("safety-code");
await bigTargets("the safety code");
await bigText("The safety code", ".ov[aria-label='Safety code']");
await click("#sf-match");
await waitFor("The codes match: checked", `document.getElementById("sf-state") && document.getElementById("sf-state").textContent === "Checked in person"`);
await js(`history.back(); true`);
await waitFor("the profile says it, in Details", `!document.querySelector(".ov[aria-label='Safety code']") && document.getElementById("pv-checked").textContent === "Checked in person"`);
check("and only there: no badge on the profile's head or the chat's header", !/checked|verified/i.test(await text(".pv-head")) && !/checked|verified/i.test(await js(`document.querySelectorAll(".ov")[0].querySelector(".ov-top").innerText`)));
await shot("profile-checked");
await js(`history.back(); true`); await sleep(200);
await js(`history.back(); true`);
await waitFor("back on the list", `!document.querySelector(".ov")`);
const bobNew = ID.newIdentity();
await w.register("bob", { msg: hex(bobNew.publicKey) });
await openChat("Bob (meetup)");
await waitFor("bob's address changed after the check: its own banner", `!!document.querySelector(".cv-ban:not([hidden])") && document.querySelector(".cv-ban").innerText.includes("changed since you checked it")`, 15000);
check("nothing can be sent, and no one-tap accept", await js(`document.querySelector(".cmp").hidden`) && JSON.stringify(await js(`[...document.querySelectorAll(".cv-ban button")].map(b => b.textContent)`)) === '["Compare codes","Accept without checking"]');
check("the header says so", (await text(".ov .ov-top")).includes("Address changed since you checked it"));
await shot("key-changed-checked");
await bigTargets("a checked contact's changed address");
await js(`[...document.querySelectorAll(".cv-ban button")].find(b => b.textContent === "Compare codes").click(); true`);
await waitFor("the code to compare is for the new address", `!!document.querySelector(".ov[aria-label='Safety code'] #sf-code") && document.querySelector(".ov[aria-label='Safety code']").innerText.includes("changed")`);
check("and it is the new address's code", JSON.stringify(await js(`[...document.querySelectorAll("#sf-code span")].map(x => x.textContent)`)) === JSON.stringify(CORE.safetyGroups(CORE.safetyCode(key.public, hex(bobNew.publicKey)))));
await click("#sf-match");
await waitFor("compared again: checked", `document.getElementById("sf-state").textContent === "Checked in person"`);
await js(`history.back(); true`);
await waitFor("back in the chat: the new address is accepted, sending works", `!document.querySelector(".ov[aria-label='Safety code']") && !document.querySelector(".cmp").hidden && document.querySelector(".cv-ban").hidden`, 10000);
// back to bob's own phone for the rest: this time accepted without checking, on purpose
await w.register("bob", { msg: hex(B.id.publicKey) });
await js(`history.back(); true`);
await waitFor("back on the list", `!document.querySelector(".ov")`);
await openChat("Bob (meetup)");
await waitFor("changed again since the check", `!!document.querySelector(".cv-ban:not([hidden])") && document.querySelector(".cv-ban").innerText.includes("changed since you checked it")`, 15000);
await js(`[...document.querySelectorAll(".cv-ban button")].find(b => b.textContent === "Accept without checking").click(); true`);
await waitFor("it asks first", `!!document.querySelector(".sheet") && document.querySelector(".sheet").innerText.includes("won't show as checked")`);
await js(`[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Accept").click(); true`);
await waitFor("accepted on purpose: sending works, and bob isn't checked any more", `!document.querySelector(".cmp").hidden && document.querySelector(".cv-ban").hidden`, 10000);
await click(".ov .who");
await waitFor("bob's profile", `!!document.getElementById("pv-checked")`);
check("Details: not checked", (await js(`document.getElementById("pv-checked").textContent`)) === "Not checked");
await js(`history.back(); true`); await sleep(200);
await js(`history.back(); true`);
await waitFor("back on the list", `!document.querySelector(".ov")`);
// a lock clears all of it from the page (with Requests and Blocked filled in first)
await click("#mg-me"); await stWait("Settings > Messages", "msg");
await click("#mgs-go-blocked"); await mgsWait("Blocked", "blocked");
await click("#b-settings-back"); await mgsWait("Back", "list");
await click("#mgs-go-req"); await mgsWait("Requests", "req");
await js(`lockedNow(); true`);
await waitFor("locked", `!document.getElementById("lock").hidden`);
check("locked: no overlay, no request, no safety code, no blocked entry kept in the page, not even hidden", await js(`(() => {
  const t = document.body.textContent + [...document.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label")).join(" ");
  return !document.querySelector(".ov, .sheet") && !/carol|dave|workshop|Checked in person|Said it was|message request/.test(t) && !t.includes(${JSON.stringify(bobCode.slice(0, 15))}); })()`));
check("locked: Requests, Blocked and the request line are empty", await js(`["mg-req-rows", "mg-blk-rows", "mg-req-line"].every(id => document.getElementById(id).childElementCount === 0) && document.getElementById("mg-req-line").hidden && !/Deleted unread/.test(document.getElementById("mg-req-dropped").textContent)`));
await unlock();
await stWait("unlocked: back on Settings", "msg");
await js(`history.back(); true`); await sleep(200);
await click("#b-settings-back"); await stWait("and out", "closed");
await waitFor("back on the list", `!document.querySelector(".ov") && !document.getElementById("mg-home").hidden && document.getElementById("mg-rows").innerText.includes("carol")`, 15000);
// ---- a backup with message history, made in the page and restored through the page ----
for (let i = 0; i < 130; i++) {                 // enough history for a file over 60 KB
  const p = MC.sealMessage({ to: MC.fromHex(key.public), from: "bob", fromSecret: B.id.secretKey, text: "filler " + i + " ".repeat(200) });
  await w.control("inject/0", { topic: MC.inboxTopic(MC.fromHex(key.public)), payload: b64(p) });
  if (i % 30 === 29) await sleep(800);
}
await until("the filler arrives", async () => (await A.call("/api/messages/status")).d.unread >= 130, 15000);
await click("#nav-wallet"); await click("#b-gear");
await stWait("Settings", "home");
await click("#go-bk");
await stWait("Settings > Backup & restore", "bk");
await js(`window.__blobs = []; const o = URL.createObjectURL; URL.createObjectURL = b => { window.__blobs.push(b); return o(b); }; true`);
await js(`(() => { for (const [id, v] of [["bk-pw1", "a long backup password"], ["bk-pw2", "a long backup password"], ["bk-pin", ${JSON.stringify(A.pin)}]]) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); } return true; })()`);
check("history is in the backup unless unticked", await js(`document.getElementById("bk-hist").checked`));
await js(`document.getElementById("f-bk").requestSubmit(); true`);
await waitFor("the page made the backup file", `!document.getElementById("bk-done").hidden && window.__blobs.length === 1`, 30000);
const backupText = await js(`window.__blobs[0].text()`);
const backupDoc = JSON.parse(backupText);
check("it is a version 2 file over 60 KB (with history)", backupDoc.version === 2 && backupText.length > 60000, [backupDoc.version, backupText.length]);
const bkFile = join(mkdtempSync(join(tmpdir(), "bk-")), "logos-node-wallet-backup.json");
writeFileSync(bkFile, backupText);
const docNode = (await cdp("DOM.getDocument")).result.root.nodeId;
const input = (await cdp("DOM.querySelector", { nodeId: docNode, selector: "#rs-file" })).result.nodeId;
await cdp("DOM.setFileInputFiles", { nodeId: input, files: [bkFile] });
await waitFor("the page takes the file (doesn't refuse it as too big or an unknown version)", `!document.getElementById("rs-step2").hidden`, 10000);
await js(`(() => { for (const [id, v] of [["rs-pw", "a long backup password"], ["rs-pin", ${JSON.stringify(A.pin)}]]) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); } const ok = document.getElementById("rs-ok"); ok.checked = true; ok.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
await js(`document.getElementById("b-rs").click(); true`);
await waitFor("restored through the page", `document.getElementById("m-rs").className === "msg ok"`, 30000);
await click("#b-settings-back");
await stWait("Back to the list", "home");
await waitFor("the Backup & restore row now says when the last backup was", `/^Last backup .* ago$/.test(document.querySelector("#go-bk small").textContent)`);
await click("#b-settings-back");
await stWait("and out of Settings", "closed");

// ---- the node's state as an icon; Settings' Node row with the Android bridge ----
await click("#nav-wallet");
await waitFor("the wallet screen has its header back", `!document.querySelector("main > header").hidden`);
check("the status pill is one icon", await js(`document.getElementById("pill").hidden && !!document.getElementById("node-ic")`));
// The pill's words and the icon, read in one go: the words are set and the icon read before any other task runs (the
// icon follows the words in a MutationObserver, a microtask), so the page's own status poll, every 5 s, can't come
// in between and put its words back.
const pillSays = (words) => js(`(async () => { const p = document.getElementById("pill"), b = document.getElementById("node-ic");
  p.textContent = ${JSON.stringify(words)}; await Promise.resolve();
  return { words: p.textContent, kind: b.dataset.kind, label: b.getAttribute("aria-label") }; })()`);
for (const [words, kind] of [["catching up", "sync"], ["stopped", "stop"], ["up to date", "ok"]]) {   // the page's own words, as tickStatus sets them
  const got = await pillSays(words);
  check(`"${words}" shows the ${kind} icon`, got.words === words && got.kind === kind, got);
  await shot("wallet-header-" + kind);
}
const stopped = await pillSays("stopped");
check("stopped is labelled", stopped.words === "stopped" && stopped.label.startsWith("Node stopped"), stopped);
await click("#b-gear");
await stWait("Settings", "home");
await click("#go-node");
await stWait("Settings > Node", "node");
check("without the Android bridge there is no Open node", await js(`document.getElementById("b-open-node").hidden`));
await click("#b-settings-back"); await stWait("Back to the list", "home");
await click("#b-settings-back"); await stWait("and out of Settings", "closed");
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.LogosAndroid = { openNode() { window.__opened = (window.__opened || 0) + 1; } };" });
await load();
await waitFor("the wallet loads", `!document.getElementById("v-open").hidden || !document.getElementById("v-locked").hidden`);
if (await js(`!document.getElementById("v-locked").hidden`)) await unlock();
await click("#b-gear");
await stWait("Settings", "home");
await click("#go-node");
await waitFor("Settings > Node has Open node with the bridge", `!document.getElementById("b-open-node").hidden && !document.getElementById("st-node").hidden`);
await shot("settings-android");
await js(`document.getElementById("b-open-node").click(); true`);
check("it calls LogosAndroid.openNode()", await js(`window.__opened === 1`));
await click("#b-settings-back"); await stWait("Back to the list", "home");
await click("#b-settings-back"); await stWait("and out of Settings", "closed");
await click("#nav-msg");
await waitFor("Messages home", `!document.getElementById("mg-home").hidden`);
await shot("messages-home");

// ---- the chats don't load (the store read fails): nothing shows, nothing is sorted or dropped; it tries again ----
{
  const itemsA = async () => JSON.stringify((await A.call("/api/messages/inbox")).d.items.map(i => i.n + ":" + (i.k || "")));
  const before = await itemsA();
  let failStore = true;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method !== "Fetch.requestPaused" || !/\/api\/messages\/store/.test(m.params.request.url)) return;
    const q = m.params;
    if (failStore && q.request.method === "GET") cdp("Fetch.fulfillRequest", { requestId: q.requestId, responseCode: 500, body: Buffer.from('{"error":"test"}').toString("base64") });
    else cdp("Fetch.continueRequest", { requestId: q.requestId });
  });
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/api/messages/store*" }] });
  await load();
  await waitFor("the page loads", `!document.getElementById("v-open").hidden || !document.getElementById("v-locked").hidden`);
  if (await js(`!document.getElementById("v-locked").hidden`)) await unlock();
  await click("#nav-msg");
  await waitFor("the chats didn't load: it says so, and shows no chat and no request", `document.getElementById("mg-loading").textContent.includes("Couldn't load your chats") && !document.querySelector("#mg-rows .crow") && document.getElementById("mg-req-line").hidden`, 20000);
  await sleep(6000);                              // a few tries, 2 s, 4 s apart
  check("meanwhile nothing on the server was sorted, dropped or deleted", await itemsA() === before);
  check("and the unread badge shows nothing", await js(`document.querySelector("#nav .badge").hidden`));
  await shot("chats-not-loaded");
  failStore = false;
  await waitFor("once the store loads, the chats are back", `document.querySelectorAll("#mg-rows .crow").length >= 3`, 70000);
  await cdp("Fetch.disable");
  // a store file that can't be read (as after a power cut): it says so, and the last saved copy brings the chats back
  const good = readFileSync(join(A.data, "wallet-chat.json"), "utf8");
  check("(each save keeps the copy it replaces)", existsSync(join(A.data, "wallet-chat.json.prev")));
  writeFileSync(join(A.data, "wallet-chat.json"), "");
  await load();
  await waitFor("the page loads", `!document.getElementById("v-open").hidden || !document.getElementById("v-locked").hidden`);
  if (await js(`!document.getElementById("v-locked").hidden`)) await unlock();
  await click("#nav-msg");
  await waitFor("the file can't be read: one plain card, with the last saved copy and Start fresh", `!document.getElementById("mg-store-warn").hidden && document.getElementById("mg-store-why").textContent.includes("can't be read") && !document.getElementById("mg-store-prev").hidden && !document.querySelector("#mg-rows .crow")`, 20000);
  await shot("chats-file-unreadable");
  await bigTargets("the saved chats card");
  await click("#mg-store-prev");
  await waitFor("Use the last saved copy: the chats are back", `document.querySelectorAll("#mg-rows .crow").length >= 3 && document.getElementById("mg-store-warn").hidden`, 30000);
  check("(the file is readable again)", readFileSync(join(A.data, "wallet-chat.json"), "utf8").length > 10 && good.length > 10);
}
// ---- answers that come after a lock: the page's api() and Messages' own background requests (bgApi) drop them
// (stale, no data), and send nothing once the page is locking; a message that came in is read again after the unlock ----
{
  const top = async () => Math.max(0, ...(await A.call("/api/messages/inbox")).d.items.map(i => i.n)), before = await top();
  await bob.send("d:alice", "sent while the page locked");
  await until("bob's message is on alice's server", async () => await top() > before, 20000);
  // (relockPage, the reload, held back so the page that is locking can be looked at)
  const late = await js(`(async () => { relockPage = () => {}; const bgApi = window.MSG.bgApi;
    const a = api("/api/messages/inbox?after=0"), b = bgApi("/api/messages/inbox?dropped=1"), c = bgApi("/api/messages/status", {});
    lockedNow();
    const ra = await a, rb = await b, rc = await c, rd = await bgApi("/api/messages/inbox?after=0");
    return { a: !!ra.stale && !ra.data.items, b: !!rb.stale && !rb.data.items, c: !!rc.stale, d: !!rd.stale }; })()`);
  check("a read (api), a background read and a background POST (bgApi) answered after the lock are stale, with no data; one made after it too",
    late.a && late.b && late.c && late.d, late);
  await load();
  await waitFor("the page loads, locked", `!document.getElementById("v-locked").hidden`);
  await unlock();
  await click("#nav-msg");
  await waitFor("after the unlock the message is read again and shows", `document.getElementById("mg-rows").innerText.includes("sent while the page locked")`, 20000);
}

// ---- the lock screen inside the Android app, with fingerprint on (a stand-in bridge counts the prompts) ----
// erin's app is the Android app's, with the LNS signer (a stand-in), so Settings has Your name too
const signerDir = mkdtempSync(join(tmpdir(), "signer-"));
process.on("exit", () => { try { rmSync(signerDir, { recursive: true, force: true }); } catch {} });
copyFileSync(join(here, "fake_names_bin.py"), join(signerDir, "libnames.so")); chmodSync(join(signerDir, "libnames.so"), 0o755);
const E = await app(w, 8115 + PS, w.NODES[4], { APP_EMBEDDED: "android", NAMES_BIN: join(signerDir, "libnames.so") });
await person(w, E, "erin", "565656");
let r0 = await E.call("/api/wallet/native-fingerprint", { on: true, pin: E.pin });
check("fingerprint unlock is on for the Android app", r0.code === 200, r0);
await E.call("/api/wallet/lock", {});
const erinBob = await chatOf(w, B);
await erinBob.lookup("erin", true); await erinBob.startDirect("erin"); await erinBob.send("d:erin", "hi erin");
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(window, '__fp', { configurable: true, get: () => Number(sessionStorage.getItem('__fp') || 0) }); window.__scans = 0; window.LogosAndroid = { unlockWithFingerprint() { sessionStorage.setItem('__fp', String(window.__fp + 1)); }, openNode() {}, scanQr() { window.__scans++; } };" });
await cdp("Page.navigate", { url: E.base + "/" });
await waitFor("the lock screen", `!!document.getElementById("lock") && !document.getElementById("lock").hidden`);
await sleep(600);
check("the fingerprint check comes up by itself, once", await js(`window.__fp`) === 1);
check("while it is up: the splash, only the mark and Enter PIN; no PIN box", await js(`!document.getElementById("lk-splash").hidden && document.getElementById("lk-pad").hidden && document.getElementById("b-fp").hidden && !document.getElementById("b-enter-pin").hidden && !document.querySelector("#lock input")`));
await shot("locked-android");
await noOldHeader("the Android lock screen");
await js(`window.logosNativeUnlockFailed(); true`);
check("after a cancel: still the splash, with Enter PIN and Use fingerprint", await js(`!document.getElementById("lk-splash").hidden && !document.getElementById("b-fp").hidden && !document.getElementById("b-enter-pin").hidden && document.getElementById("lk-pad").hidden`));
await shot("locked-android-cancelled");
await sleep(1000);
check("and it doesn't come up again by itself", await js(`window.__fp`) === 1);
const vis = (state) => js(`Object.defineProperty(document, "visibilityState", { configurable: true, get: () => ${JSON.stringify(state)} }); document.dispatchEvent(new Event("visibilitychange")); true`);
await vis("hidden"); await sleep(300); await vis("visible"); await sleep(300);
check("not even after a moment hidden (the phone's own dialog)", await js(`window.__fp`) === 1);
await js(`document.getElementById("b-fp").click(); true`);
check("Use fingerprint asks again", await js(`window.__fp`) === 2);
await click("#b-enter-pin");
check("Enter PIN: the keypad at once, with a fingerprint key", await js(`!document.getElementById("lk-pad").hidden && !!document.getElementById("k-fp")`));
await shot("locked-android-keypad");
await enterPin(E.pin, "unlocking in the Android app");
await waitFor("unlocked with the PIN", `!document.getElementById("v-open").hidden`);
E.session = await js("token");
await click("#b-gear"); await stWait("Settings in the Android app", "home");
await waitFor("Security says fingerprint is on", `document.querySelector("#go-sec small").textContent.startsWith("Fingerprint on · locks after")`);
check("Updates says they come with the Android app", (await text("#go-upd small")).includes("comes with the Android app"), await text("#go-upd small"));
// (erin's Messages row comes and goes with her messages state; the order is the list's own: Your name right after Messages)
const rowsNow = async () => JSON.parse(await js(`JSON.stringify([...document.querySelectorAll("#s-groups .grow")].filter(b => !b.hidden).map(b => b.querySelector("b").textContent))`)).filter(l => l !== "Messages");
const wantRows = JSON.stringify(GROUPS.map(g => g[1]).filter(l => l !== "Messages"));
for (let i = 0; i < 50 && JSON.stringify(await rowsNow()) !== wantRows; i++) await sleep(200);
check("in the Android app with the signer, the list has Your name first after Messages: " + GROUPS.map(g => g[1]).join(", "),
  JSON.stringify(await rowsNow()) === wantRows && await js(`(() => { const r = [...document.querySelectorAll("#s-groups .grow")]; return r.indexOf(document.getElementById("go-name")) === r.indexOf(document.getElementById("go-msg")) + 1; })()`), await rowsNow());
await waitFor("the Your name row says where it stands", `document.querySelector("#go-name small").textContent === "No name yet"`);
await groupPage("name", "Your name");
check("Your name's ids are all on its page", [...seenIds].filter(x => INVENTORY.name.all.includes(x)).length === INVENTORY.name.all.length);
await click("#b-settings-back"); await stWait("out of Settings", "closed");
await click("#nav-msg");
// (0.9.14) bob wrote first: his message is a request until erin accepts it, here in the Android app's page
await waitFor("bob's request on erin's phone: one line", `!document.getElementById("mg-req-line").hidden && !/bob|hi erin/.test(document.getElementById("page-msg").innerText)`, 15000);
await click("#mg-req-line"); await mgsWait("Requests", "req");
await waitFor("bob, with his LNS name", `[...document.querySelectorAll("#mg-req-rows .rq-row")].some(r => r.querySelector("b").textContent === "bob" && r.innerText.includes("LNS name"))`, 15000);
await js(`[...document.querySelectorAll("#mg-req-rows .rq-row")].find(r => r.querySelector("b").textContent === "bob").click(); true`);
await waitFor("his request", `!!document.querySelector(".ov[aria-label=Request]") && document.querySelector(".ov[aria-label=Request]").innerText.includes("hi erin")`);
await js(`[...document.querySelectorAll(".ov[aria-label=Request] .rq-acts button")].find(b => b.textContent === "Accept").click(); true`);
await waitFor("accepted", `!document.querySelector(".ov[aria-label=Request]") && history.state && history.state.sub === "req"`, 10000);
await click("#b-settings-back"); await mgsWait("Back", "list");
await click("#b-settings-back"); await stWait("out of Settings", "closed");
await waitFor("erin's chat with bob", `[...document.querySelectorAll("#mg-rows .crow")].some(r => r.innerText.includes("bob"))`, 15000);
// ---- Messages > Name with the phone's own name: nothing to type, one action shared with Your name ----
const openOwn = async (what) => {
  await js(`closeSettings(); true`); await js(`openSettings("s-msg"); true`);
  await click("#mgs-go-name"); await mgsWait(`Messages > Name (${what})`, "name");
};
await E.call("/api/wallet/lns/account", {});
await openOwn("no name yet");
await waitFor("a name account and no name: one line, and Get a name", `document.getElementById("mg-own-m").textContent === "No LNS name yet." && document.getElementById("mg-own-go").textContent === "Get a name" && !document.getElementById("mg-own-go").hidden`);
check("the manual way is folded: Use a name held elsewhere", await js(`!document.getElementById("mg-else").open && document.getElementById("mg-else-s").textContent === "Use a name held elsewhere" && !document.getElementById("mg-name").checkVisibility()`),
  await js(`[document.getElementById("mg-else").open, document.getElementById("mg-else-s").textContent, document.getElementById("mg-else-s").hidden].join()`));
await shot("messages-name-none");
await E.call("/api/wallet/lns/name", { name: "erin" });
await openOwn("erin, pointed here");
await waitFor("the phone holds erin, pointed here on chain: it says so, nothing to do", `document.getElementById("mg-own-m").textContent === "erin · messages come to this phone" && document.getElementById("mg-own-go").hidden`);
await shot("messages-name-own");
await w.register("zed", {});
await E.call("/api/wallet/lns/name", { name: "zed" });
await openOwn("zed, not pointed");
await waitFor("zed isn't pointed here: one button", `document.getElementById("mg-own-m").textContent === "zed isn't used for messages yet." && document.getElementById("mg-own-go").textContent === "Use zed for messages"`);
check("no field, no Save, no command in sight", await js(`!document.getElementById("mg-name").checkVisibility() && !document.getElementById("mg-name-save").checkVisibility() && !document.getElementById("mg-cmd").checkVisibility()`));
await shot("messages-name-use");
await click("#mg-own-go");
await until("it runs Your name's own set-text job for msg", async () => {
  try { return readFileSync(join(E.data, "fake-names-calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).some(c => JSON.stringify(c.args) === JSON.stringify(["set-text", "zed", "msg", E.id ? hex(E.id.publicKey) : ""])); } catch { return false; } }, 20000);
await w.register("zed", { msg: hex(E.id.publicKey) });                // the name service has it now
await until("the change has finished", async () => (await E.call("/api/wallet/lns")).d.job.state !== "running", 20000);
await openOwn("zed, pointed now");
await waitFor("now: zed · messages come to this phone", `document.getElementById("mg-own-m").textContent === "zed · messages come to this phone"`, 20000);
await until("and messages go out under zed", async () => (await E.call("/api/messages/key")).d.name === "zed", 10000);
await js(`closeSettings(); true`); await js(`openSettings("s-lns"); true`);
await waitFor("Your name shows the same state, as done, and doesn't offer it again", `document.getElementById("lns-ent-msg").textContent === "Messages come to this phone ✓" && document.getElementById("b-lns-msg").hidden`, 15000);
await js(`closeSettings(); true`); await click("#nav-msg");
await waitFor("back on Messages with erin's chats", `[...document.querySelectorAll("#mg-rows .crow")].some(r => r.innerText.includes("bob"))`, 15000);
await js(`[...document.querySelectorAll("#mg-rows .crow")].find(r => r.innerText.includes("bob")).click(); true`);
await waitFor("the chat is open", `!!document.querySelector(".ov .cmp")`);
await E.call("/api/wallet/lock", {});               // the server's auto-lock; the open chat's next request meets it (a 401)
await waitFor("auto-locked: the lock screen, through the page's one lock (a reload)", `!document.getElementById("lock").hidden && !document.documentElement.classList.contains("relock") && document.getElementById("v-open").hidden`, 20000);
await sleep(400);
check("after an auto-lock the fingerprint check comes up by itself", await js(`window.__fp`) === 3);
// the whole page: every element (hidden ones too), every attribute and title, every field's value; not the scripts' source
const behind = await js(`(() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll("script, style").forEach(x => x.remove());
  return c.outerHTML + "\\n" + [...document.querySelectorAll("input, textarea, select")].map(i => i.value).join("\\n"); })()`);
check("nothing behind the lock screen, hidden or not: no chats, names, balances", !/\b(bob|erin|zed)\b/i.test(behind) && (await js(`document.querySelectorAll(".crow, .bub, .acct, .ov").length`)) === 0,
  (behind.match(/.{0,60}\b(bob|erin|zed)\b.{0,60}/i) || [""])[0]);
await vis("hidden"); await sleep(2800); await vis("visible"); await sleep(400);
check("coming back to the app later: it comes up again", await js(`window.__fp`) === 4);
await click("#b-enter-pin");
await enterPin(E.pin, "unlocking after an auto-lock");
await waitFor("after unlocking: back on Messages, at its list (a chat isn't kept open across a lock)", `!document.getElementById("page-msg").hidden && !document.querySelector(".ov") && [...document.querySelectorAll("#mg-rows .crow")].some(r => r.innerText.includes("bob"))`, 15000);
await click("#nav-wallet");
await js(`document.getElementById("b-lock").click(); true`);
await waitFor("locked by hand", `!document.getElementById("lock").hidden`);
await sleep(600);
check("after the user's own Lock, no prompt by itself", await js(`window.__fp`) === 4);
check("both options are there", await js(`!document.getElementById("b-fp").hidden && !document.getElementById("b-enter-pin").hidden`));
// ---- Scan, with the Android app's scanner (the stand-in bridge): a scan only fills the box it came from ----
await click("#b-enter-pin");
await enterPin(E.pin, "unlocking to scan");
await waitFor("unlocked again", `!document.getElementById("v-open").hidden`);
await click("#nav-wallet"); await click("#t-send");
check("Send has Scan inside the Android app", await js(`!document.getElementById("b-scan").hidden`));
await bigTargets("Send with Scan");
const someHex = hex(MC.newKeyPair().publicKey), otherHex = hex(MC.newKeyPair().publicKey);
const toIs = () => js(`document.getElementById("to").value`);
const scanMsg = () => text("#m-scan");
await click("#b-scan");
check("Scan asks the app's scanner", await js(`window.__scans`) === 1);
await js(`window.logosScanned(${JSON.stringify(someHex)}); true`);
check("a scanned wallet address fills To, and nothing is sent", await toIs() === someHex && await js(`document.getElementById("m-scan").hidden && document.getElementById("v-review").hidden && document.getElementById("v-sent").hidden`));
await click("#b-scan"); await js(`window.logosScanned(${JSON.stringify(" " + otherHex.toUpperCase() + "\n")}); true`);
check("in capitals, with spaces around: still a wallet address, filled in small letters", await toIs() === otherHex);
await click("#b-scan"); await js(`window.logosScanned("msg:" + ${JSON.stringify(someHex)}); true`);
check("a messaging address scanned in Send is not filled in, and says why", await toIs() === otherHex && (await scanMsg()).includes("That's a messaging address") && (await scanMsg()).includes("Coins can't be sent to it"));
await bigTargets("Send, a messaging address scanned");
await shot("send-scanned-messaging-address");
await click("#m-scan button");
await waitFor("Open New chat: New chat with that messaging address, looked up", `!document.getElementById("page-msg").hidden && document.getElementById("mg-to").value === ${JSON.stringify("msg:" + someHex)} && document.getElementById("mg-found").innerText.includes("No LNS name")`, 15000);
await js(`history.back(); true`);
await click("#nav-wallet");
if (await js(`document.getElementById("p-send").hidden`)) await click("#t-send");
check("back in Send, To as it was", await toIs() === otherHex);
const bad = ["javascript:alert(1)", "https://example.com/" + someHex, "msg:" + someHex.slice(1), someHex + "0", "logos:" + someHex, "msg:" + someHex + "x",
  "<img src=x onerror=window.__pwned=1>", "x".repeat(5000), someHex.slice(0, 32) + " " + someHex.slice(32), "\u0000" + someHex, "alice"];
for (const t of bad) {
  await click("#b-scan"); await js(`window.logosScanned(${JSON.stringify(t)}); true`);
  check(`refused in Send: ${JSON.stringify(t.slice(0, 40))}`, await toIs() === otherHex && (await scanMsg()) === "That code isn't a wallet address or a messaging address.");
}
await click("#b-scan"); await js(`window.logosScanned({ toString() { return ${JSON.stringify(someHex)}; } }); true`);
check("refused in Send: something that isn't text", await toIs() === otherHex && (await scanMsg()).includes("isn't a wallet address"));
check("nothing scanned ran or was added to the page", await js(`!window.__pwned && !document.querySelector("#m-scan img, #m-scan script") && location.pathname === "/"`));
await click("#b-scan"); await vis("hidden"); await sleep(3000); await vis("visible"); await sleep(300);   // the scanner covers the page a while
await js(`window.logosScanned(${JSON.stringify(someHex)}); true`);
check("the page was hidden behind the scanner for a few seconds: the scan still fills To", await toIs() === someHex && await js(`document.getElementById("lock").hidden`));
await js(`document.getElementById("to").value = ${JSON.stringify(otherHex)}; true`);
await click("#b-scan"); await js(`window.logosScanFailed("The camera is off for this app. Allow it in the phone's settings to scan."); true`);
check("a scan that didn't work says why", (await scanMsg()).includes("The camera is off for this app") && await toIs() === otherHex);
await click("#b-scan"); await js(`window.logosScanFailed(); true`);
check("a cancelled scan (no message): nothing said, nothing filled", await toIs() === otherHex && await js(`document.getElementById("m-scan").hidden`));
await js(`window.logosScanned(${JSON.stringify(someHex)}); true`);
check("an answer with no scan open goes nowhere", await toIs() === otherHex);
await click("#b-scan");
await js(`document.getElementById("b-lock").click(); true`);
await waitFor("locked while the scanner was open", `!document.getElementById("lock").hidden`);
await js(`window.logosScanned(${JSON.stringify(someHex)}); true`);
await click("#b-enter-pin");
await enterPin(E.pin, "unlocking after a scan was open");
await waitFor("unlocked", `!document.getElementById("v-open").hidden`);
await click("#nav-wallet"); await click("#t-send");
check("a scan answered while locked fills nothing", await toIs() !== someHex);
await click("#nav-msg");
await waitFor("Messages", `!document.getElementById("mg-home").hidden`, 15000);
await click("#mg-new");
check("New chat has Scan inside the Android app", await js(`!document.getElementById("mg-scan").hidden`));
await bigTargets("New chat with Scan");
await click("#mg-scan");
await js(`window.logosScanned(${JSON.stringify(someHex)}); true`);
check("a wallet address scanned in New chat is not filled in, and says why", await js(`document.getElementById("mg-to").value`) === "" && (await text("#mg-found")).includes("That's a wallet address"));
for (const t of bad) {
  await click("#mg-scan"); await js(`window.logosScanned(${JSON.stringify(t)}); true`);
  check(`refused in New chat: ${JSON.stringify(t.slice(0, 40))}`, await js(`document.getElementById("mg-to").value`) === "" && (await text("#mg-found")) === "That code isn't a wallet address or a messaging address.");
}
await click("#mg-scan"); await js(`window.logosScanFailed("The scan didn't work. Try again, or type it in."); true`);
check("a scan that didn't work says so in New chat", (await text("#mg-found")).includes("The scan didn't work"));
await click("#mg-scan"); await js(`window.logosScanned("MSG:" + ${JSON.stringify(someHex.toUpperCase())}); true`);
await waitFor("a scanned messaging address is filled in and looked up like a typed one", `document.getElementById("mg-to").value === ${JSON.stringify("msg:" + someHex)} && document.getElementById("mg-found").innerText.includes("No LNS name")`, 15000);
check("and nothing is started until asked: Start chat is offered", await js(`[...document.querySelectorAll("#mg-found button")].some(b => /Start chat/.test(b.textContent))`));
check("nothing scanned ran", await js(`!window.__pwned`));
await shot("new-chat-scanned");
await js(`history.back(); true`);
// ---- the safety code with the scanner: only their matching code, or their own address, marks it checked ----
await waitFor("back on Messages", `!document.getElementById("mg-home").hidden && !document.querySelector(".ov")`, 15000);
await js(`[...document.querySelectorAll("#mg-rows .crow")].find(r => r.innerText.includes("bob")).click(); true`);
await waitFor("erin's chat with bob", `!!document.querySelector(".ov .cv-in")`);
await click(".ov .who");
await waitFor("bob's profile", `!!document.getElementById("pv-safety")`);
await js(`document.querySelector(".pv-in details").open = true; true`);
await click("#pv-safety");
await waitFor("the safety code, with Scan their code", `!!document.getElementById("sf-scan") && !!document.getElementById("sf-code")`);
const ebCode = CORE.safetyCode(hex(E.id.publicKey), hex(B.id.publicKey));
const sfSay = () => js(`[...document.querySelectorAll(".ov[aria-label='Safety code'] .msg")].map(e => e.textContent).join(" | ")`);
for (const [t, want] of [["names-safety:1:" + "1".repeat(60), "The codes don't match"], ["msg:" + otherHex, "That's not bob's messaging address"],
  ["<img src=x onerror=window.__pwned=1>", "That isn't a safety code"], [someHex, "That isn't a safety code"], ["x".repeat(5000), "That isn't a safety code"]]) {
  await click("#sf-scan"); await js(`window.logosScanned(${JSON.stringify(t)}); true`);
  await waitFor(`scanned ${JSON.stringify(t.slice(0, 30))}: refused, says why`, `document.querySelector(".ov[aria-label='Safety code']").innerText.includes(${JSON.stringify(want)})`);
  check(`and still not checked`, (await text("#sf-state")) === "Not checked");
}
await bigTargets("the safety code with Scan");
await click("#sf-scan"); await js(`window.logosScanned(${JSON.stringify("names-safety:1:" + ebCode)}); true`);
await waitFor("their matching code: checked", `document.getElementById("sf-state").textContent === "Checked in person" && document.querySelector(".ov[aria-label='Safety code']").innerText.includes("They match")`);
check("nothing scanned ran", await js(`!window.__pwned && !document.querySelector(".ov img")`));
await shot("safety-code-scanned");
await click("#sf-clear");
await waitFor("taken back", `document.getElementById("sf-state").textContent === "Not checked"`);
await click("#sf-scan"); await js(`window.logosScanned(${JSON.stringify("msg:" + hex(B.id.publicKey))}); true`);
await waitFor("their own messaging address QR: it matches, but that checks one way only, so it marks nothing",
  `document.querySelector(".ov[aria-label='Safety code']").innerText.includes("To check both ways, scan their safety code") && document.getElementById("sf-state").textContent === "Not checked"`);
// (the 404: Messages' status read as a page opens, on the app where messages aren't turned on yet)
check("no script errors in the page (the 401s are the lock tests' own, the 500s the store test's)", errors.filter(e => !/status of (401|500)/.test(e) && !/status of 404 .* \/api\/messages\/status$/.test(e)).length === 0, errors);
ws.close(); stopAll();
console.log("all checks passed" + (SHOTS ? ` (screenshots in ${SHOTS})` : ""));
process.exit(0);

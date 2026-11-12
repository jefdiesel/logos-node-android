// The Messages screen in a real browser (headless Chrome over the DevTools protocol), at phone width, in
// light and dark: the empty states, the chat list, a chat, a key change, a profile with a note, a new chat.
//
//   CHROME=<path to chrome> SHOTS=<folder for screenshots, optional> node tests/chat_ui.mjs
//
// Three apps on a fake messaging network: the browser shows alice's; bob and carol write from Node with the
// page's own chat model. Checks what the screen shows; with SHOTS, saves a PNG of each state.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { world, app, person, chatOf, check, until, sleep, procs, stopAll, MC, ID, hex, b64 } from "./chat_world.mjs";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const w = await world(18570, 4);
const A = await app(w, 8111, w.NODES[0]), B = await app(w, 8112, w.NODES[1]), C = await app(w, 8113, w.NODES[2]);
await person(w, B, "bob", "222333"); await person(w, C, "carol", "333444");
A.pin = "111222"; A.session = (await A.call("/api/wallet/setup", { pin: A.pin })).d.session;

// ---- a browser ----
const port = 9333, prof = mkdtempSync(join(tmpdir(), "chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
  ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });   // CI: Ubuntu 24.04 blocks the sandbox's user namespaces
procs.push(chrome);
let target;
for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page"); } catch {} if (!target) await sleep(100); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok));
let seq = 0; const waiting = new Map(), errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text);
});
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true });
const js = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr + ": " + JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no ${sel}"); e.click(); return true; })()`);
const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
const seen = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null || !!e && getComputedStyle(e).position === "fixed"; })()`);
const waitFor = async (name, expr, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(150); }
  check(name, false, { errors, page: (await js(`(document.querySelector(".ov") || document.getElementById("page-msg")).innerText`).catch(() => "")).slice(0, 400) });
};
let shotN = 0;
async function shot(name) {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"]) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await sleep(150);
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, "0")}-${name}-${scheme}.png`), Buffer.from(r.result.data, "base64"));
  }
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
}
async function load() {
  await cdp("Page.navigate", { url: A.base + "/" });
  await waitFor("the page loads", `!!document.getElementById("nav-msg")`);
}
async function unlock() {
  await waitFor("the PIN form shows", `!document.getElementById("v-locked").hidden`);
  await js(`document.getElementById("pin").value = ${JSON.stringify(A.pin)}; document.getElementById("v-locked").requestSubmit(); true`);
  await waitFor("the wallet opens", `!document.getElementById("v-open").hidden`);
  A.session = await js("token");          // one session at a time: share the page's
}

// ---- locked, then messages not turned on ----
await load();
check("the bar shows Wallet and Messages", (await text("#nav")).includes("Wallet") && (await text("#nav")).includes("Messages"));
await click("#nav-msg");
await waitFor("locked: Messages says so", `!document.getElementById("mg-locked").hidden`);
await shot("locked");
await click("#mg-unlock");
await unlock();
await waitFor("after unlocking it goes back to Messages", `!document.getElementById("page-msg").hidden`);
await waitFor("no key yet: the turn-on screen", `!document.getElementById("mg-nokey").hidden`);
check("the turn-on screen never says key", !/\bkey\b/i.test(await js(`document.getElementById("page-msg").innerText`)));
await shot("turn-on");
await click("#mg-on");
await waitFor("turned on: the chat list, empty", `!document.getElementById("mg-home").hidden && !!document.querySelector("#mg-rows .empty")`);
check("home says no key", !/\bkey\b/i.test(await js(`document.getElementById("page-msg").innerText`)));
await shot("home-no-name");
await click("#mg-me");
await waitFor("Messages settings", `!document.getElementById("mg-mev").hidden`);
const key = (await A.call("/api/messages/key")).d;
check("the page made a seeded identity", key.version === 2 && /^[0-9a-f]{64}$/.test(key.seed) && key.groups === true, key);
await w.register("alice", { color: "#2d6a4f" });                // registered, no msg entry yet
await js(`document.getElementById("mg-name").value = "alice"; document.getElementById("mg-name-save").click(); true`);
await waitFor("the name is saved", `document.getElementById("mg-name-m").textContent.includes("Saved")`);
await waitFor("not linked on chain yet: it says so", `document.getElementById("mg-check-m").textContent.includes("not linked yet")`);
check("the link command is folded away until asked for", await js(`!document.getElementById("mg-link").open`));
check("the messaging address is hidden until Show", await js(`document.getElementById("mg-addr").hidden`));
check("no address or key shows on the settings screen", !/[0-9a-f]{20,}/.test(await js(`document.getElementById("page-msg").innerText`)));
await shot("settings");
await click("#mg-addr-show");
check("Show reveals the shareable address", (await text("#mg-addr")).startsWith("msg:" + key.public));
await js(`document.getElementById("mg-addr").scrollIntoView({ block: "center" }); true`);
await shot("my-messaging-address");
await click("#mg-addr-show");
await js(`window.scrollTo(0, 0); document.getElementById("mg-link").open = true; true`);
await shot("link-your-name");
await w.register("alice", { msg: key.public, color: "#2d6a4f" });
await click("#mg-check");
await waitFor("linked: it says messages come here", `document.getElementById("mg-check-m").textContent.includes("alice ✓")`);
await click("#mg-mev .mg-home");
await waitFor("the empty chat list", `!!document.querySelector("#mg-rows .empty")`);
check("home shows names and icons only: no address", !/[0-9a-f]{20,}/.test(await js(`document.getElementById("page-msg").innerText`)));
await shot("empty-list");
check("Messages has its own top: no node header, no status pill", await js(`document.querySelector("main > header").hidden && !!document.getElementById("h-chats")`));
check("no name linked yet: no name card on Messages home", !(await text("#mg-home")).includes("People reach you"));

// ---- new chat: not registered, no msg entry, found ----
await w.register("dave", { display: "Dave" });
await click("#mg-new");
for (const [name, want] of [["zed", "isn't a registered name"], ["dave", "hasn't turned on messages"], ["bob", "Start chat"]]) {
  await js(`document.getElementById("mg-to").value = ${JSON.stringify(name)}; document.getElementById("mg-find").requestSubmit(); true`);
  await waitFor(`new chat with ${name}: ${want}`, `document.getElementById("mg-found").innerText.includes(${JSON.stringify(want)})`);
  if (name === "dave") await shot("new-chat-nokey");
}
await shot("new-chat-by-name");
await js(`[...document.querySelectorAll("#mg-found button")].find(b => b.textContent === "Start chat").click(); true`);
await waitFor("the chat opens", `!!document.querySelector(".ov .cmp")`);
await shot("chat-new");

// ---- a conversation: yesterday's messages, replies both ways, a long one ----
const bob = await chatOf(w, B), carol = await chatOf(w, C);
const yesterday = Date.now() - 864e5;
for (const [t, txt] of [[yesterday - 600000, "Are you coming to the meetup tomorrow?"], [yesterday - 540000, "It starts at 7, at the usual place"]]) {
  const sealed = MC.sealMessage({ to: MC.fromHex(key.public), from: "bob", fromSecret: B.id.secretKey, text: txt, ts: t });
  await B.call("/api/messages/send", { topic: MC.inboxTopic(MC.fromHex(key.public)), payload: b64(sealed) });
}
await waitFor("bob's messages show in the chat", `document.querySelector(".cv-in").innerText.includes("usual place")`);
await js(`(() => { const t = document.querySelector(".cmp textarea"); t.value = "Yes! I'll bring the slides. Is there a projector?"; t.dispatchEvent(new Event("input")); document.querySelector(".cmp .go").click(); return true; })()`);
await waitFor("my message shows on the right", `!!document.querySelector(".bub.out")`);
await waitFor("and gets to Stored", `document.querySelector(".cv-in").innerText.includes("Stored")`, 15000);
await bob.lookup("alice", true); await bob.sync();
await until("bob gets it", async () => { await bob.sync(); return bob.messages("d:alice").some(m => m.dir === "in" && m.text.includes("projector")); });
await bob.send("d:alice", "There is one, HDMI only.");
await bob.send("d:alice", "Also: could you send me the address of that bakery you mentioned last week? I want to try their sourdough before the weekend, and I keep forgetting the name of the street it's on.");
await waitFor("bob's replies arrive", `document.querySelector(".cv-in").innerText.includes("sourdough")`, 15000);
check("day separators: Yesterday and Today", (await text(".cv-in")).includes("Yesterday") && (await text(".cv-in")).includes("Today"));
check("the header says verified", (await text(".ov-top")).includes("verified"));
await shot("chat");
// message details
await js(`document.querySelector(".bub.out").click(); true`);
await waitFor("details of my message", `!!document.querySelector(".sheet") && document.querySelector(".sheet").innerText.includes("To bob")`);
await shot("message-details");
await js(`history.back(); true`);
await waitFor("the sheet closes", `!document.querySelector(".sheet")`);

// ---- a profile with a note ----
await click(".ov .who");
await waitFor("bob's profile", `!!document.getElementById("pv-note")`);
await js(`(() => { const n = document.getElementById("pv-nick"); n.value = "Bob (meetup)"; n.dispatchEvent(new Event("change")); return true; })()`);
await waitFor("nickname saved", `document.querySelector(".saved").textContent.includes("Saved")`);
await js(`(() => { const n = document.getElementById("pv-note"); n.value = "Runs the Thursday meetup. Prefers Signal for anything urgent."; n.dispatchEvent(new Event("input")); n.dispatchEvent(new Event("blur")); return true; })()`);
await waitFor("note saved", `document.querySelector(".saved").textContent.includes("Saved")`);
await shot("profile");
await js(`history.back(); true`); await sleep(200);
await js(`history.back(); true`);
await waitFor("back on the list", `document.querySelectorAll("#mg-rows .crow").length >= 1 && !document.querySelector(".ov")`);
check("the list shows the nickname", (await text("#mg-rows")).includes("Bob (meetup)"));

// ---- someone with no LNS name: by messaging address, both ways ----
const D = await app(w, 8114, w.NODES[3]);
D.pin = "444555"; D.session = (await D.call("/api/wallet/setup", { pin: D.pin })).d.session;
const did = ID.newIdentity();
await D.call("/api/messages/key", { seed: hex(did.seed), secret: hex(did.secretKey), public: hex(did.publicKey) });
const dchat = await chatOf(w, D);
await click("#mg-new");
const wallet = await js(`accts.length ? accts[0].key : ""`);
if (wallet) {
  await js(`document.getElementById("mg-to").value = ${JSON.stringify(wallet)}; document.getElementById("mg-find").requestSubmit(); true`);
  await waitFor("a wallet address is refused, plainly", `document.getElementById("mg-found").innerText.includes("That's a wallet address")`);
} else console.log("     (no wallet keys listed in this test app: the wallet-address check runs in tests/chat_test.mjs)");
await js(`document.getElementById("mg-to").value = ${JSON.stringify("msg: " + hex(did.publicKey).slice(0, 30) + " " + hex(did.publicKey).slice(30))}; document.getElementById("mg-find").requestSubmit(); true`);
await waitFor("an address (with spaces) is taken: address only", `document.getElementById("mg-found").innerText.includes("no name to verify")`);
check("it shows a short code, not the address", !(await text("#mg-found")).includes(hex(did.publicKey)));
await shot("new-chat-by-address");
await js(`[...document.querySelectorAll("#mg-found button")].find(b => b.textContent === "Start chat").click(); true`);
await waitFor("the address chat opens", `!!document.querySelector(".ov .cmp")`);
await js(`(() => { const t = document.querySelector(".cmp textarea"); t.value = "Hi! Got your address from the flyer."; t.dispatchEvent(new Event("input")); document.querySelector(".cmp .go").click(); return true; })()`);
await waitFor("sent to the address", `document.querySelector(".cv-in").innerText.includes("Stored")`, 15000);
await until("the nameless person gets it, from alice", async () => { await dchat.sync(); return dchat.messages("d:alice").length === 1 && dchat.trust(dchat.messages("d:alice")[0]) === "ok"; });
await dchat.send("d:alice", "Thanks! I don't have an LNS name yet.");
await waitFor("their reply shows in the same chat", `document.querySelector(".cv-in").innerText.includes("don't have an LNS name")`, 15000);
check("the header says address only", (await text(".ov-top")).includes("address only"));
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
await waitFor("carol's chat shows up, unread", `document.getElementById("mg-rows").innerText.includes("carol") && !!document.querySelector("#mg-rows .badge")`, 15000);
await waitFor("and the one claiming to be dave, marked", `document.getElementById("mg-rows").innerText.includes("Not verified")`, 15000);
await waitFor("the bar has an unread count", `!document.querySelector("#nav .badge").hidden`);
await shot("list");
const C2 = MC.newKeyPair();
await w.register("carol", { msg: hex(C2.publicKey) });
const sealedNew = MC.sealMessage({ to: MC.fromHex(key.public), from: "carol", fromSecret: C2.secretKey, text: "New phone! This is my new key." });
await w.control("inject/0", { topic: MC.inboxTopic(MC.fromHex(key.public)), payload: b64(sealedNew) });
await js(`[...document.querySelectorAll("#mg-rows .crow")].find(r => r.innerText.includes("carol")).click(); true`);
await waitFor("carol's address changed: the banner", `!!document.querySelector(".cv-ban:not([hidden])") && document.querySelector(".cv-ban").innerText.includes("address changed")`, 15000);
await waitFor("her message from the new address is marked", `document.querySelector(".cv-in").innerText.includes("new messaging address, not accepted")`, 10000);
check("and there's no composer until it's accepted", await js(`document.querySelector(".cmp").hidden`));
await shot("key-changed");
await js(`[...document.querySelectorAll(".cv-ban button")].find(b => b.textContent === "Accept the change").click(); true`);
await waitFor("accepted: the composer is back", `!document.querySelector(".cmp").hidden`);
check("her earlier message is marked as from the earlier address", (await text(".cv-in")).includes("earlier messaging address"));
await js(`history.back(); true`);
await waitFor("back on the list", `!document.querySelector(".ov")`);

check("no keys on the everyday screens: list", !/[0-9a-f]{20,}/.test(await js(`document.getElementById("page-msg").innerText`)));
check("no errors in the page", errors.length === 0, errors);
// ---- the node's state as an icon; Settings' Node row with the Android bridge ----
await click("#nav-wallet");
await waitFor("the wallet screen has the node header back", `!document.querySelector("main > header").hidden`);
check("the status pill is replaced by one icon", await js(`document.getElementById("pill").hidden && !!document.getElementById("node-ic")`));
check("stopped node: the warning icon, labelled", (await js(`document.getElementById("node-ic").getAttribute("aria-label")`)).startsWith("Node: stopped"));
await shot("wallet-home");
await click("#node-ic");
await waitFor("tapping it shows the node details", `!!document.querySelector(".sheet") && document.querySelector(".sheet").innerText.includes("Block height")`);
await shot("node-details");
await js(`history.back(); true`);
await waitFor("closed", `!document.querySelector(".sheet")`);
for (const [words, kind] of [["catching up", "sync"], ["up to date", "ok"]]) {   // the page's own words, as tickStatus sets them
  await js(`document.getElementById("pill").textContent = ${JSON.stringify(words)}; true`);
  await waitFor(`"${words}" shows the ${kind} icon`, `document.getElementById("node-ic").dataset.kind === ${JSON.stringify(kind)}`);
  await shot("wallet-header-" + kind);
}
await click("#b-gear");
await waitFor("Settings", `!document.getElementById("page-settings").hidden`);
check("without the Android bridge there is no Node row in Settings", !(await js(`!!document.getElementById("s-node")`)));
await shot("settings");
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.LogosAndroid = { openNode() { window.__opened = (window.__opened || 0) + 1; } };" });
await load();
await waitFor("the wallet loads", `!document.getElementById("v-open").hidden || !document.getElementById("v-locked").hidden`);
if (await js(`!document.getElementById("v-locked").hidden`)) await unlock();
await click("#b-gear");
await waitFor("Settings has a Node row with the bridge", `!!document.getElementById("s-node")`);
await shot("settings-android");
await js(`document.querySelector("#s-node button").click(); true`);
check("it calls LogosAndroid.openNode()", await js(`window.__opened === 1`));
await click("#b-settings-back");
await click("#nav-msg");
await waitFor("Messages home", `!document.getElementById("mg-home").hidden`);
await shot("messages-home");
ws.close(); stopAll();
console.log("all checks passed" + (SHOTS ? ` (screenshots in ${SHOTS})` : ""));
process.exit(0);

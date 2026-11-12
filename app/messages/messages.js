// Messages: end-to-end encrypted messages between LNS names, in the names project's format
// (msg-crypto.js beside this file). The server includes this module only when a Logos Messaging
// node runs on this device (WAKU_API). It uses the page's own helpers ($, api, token, show,
// openPanel, the names forwarder), so it runs after the page's main script.
//
// The page makes this device's X25519 key pair; the server keeps it for unlocked pages only and
// puts it in the wallet backup. Sealing and opening happen here: the server only ever sees the
// sealed bytes and the recipient's inbox topic.

import { newKeyPair, sealMessage, openMessage, isVerified, parseMsgKey, inboxTopic, toHex, fromHex, MAX_TEXT }
  from "./msg-crypto.js";

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
let names = null;
const namesLib = async () => names || (names = await import("/names/names.js"));

// ---- the panel, next to Send and History ----
const style = el("style", { textContent: `
#p-msg textarea{width:100%;font:inherit;color:var(--ink);background:var(--field);border:1.5px solid var(--field-line);border-radius:10px;padding:12px;min-height:96px;resize:vertical}
#p-msg textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
#p-msg .cmd{display:block;font-family:var(--mono);font-size:13px;background:var(--field);border:1px solid var(--line);border-radius:10px;padding:10px;overflow-wrap:anywhere;margin-top:8px}
#p-msg .mrow{padding:10px 0;border-top:1px solid var(--line)}#p-msg .mrow:first-child{border-top:0}
#p-msg .mrow .who{font-weight:600}#p-msg .mrow .who.unv{color:var(--warn)}
#p-msg .mrow .text{margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}
#p-msg .mrow .sub{font-size:13px;color:var(--dim);margin-top:4px;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
#p-msg .mrow .sub button{min-height:28px;padding:2px 8px;font-size:12px;font-weight:500}
#p-msg details{border-top:0;margin-top:4px;padding-top:6px}
#p-msg h3{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:18px 0 8px}` });
document.head.append(style);

const tab = el("button", { type: "button", id: "t-msg", className: "tab", textContent: "Messages" });
tab.setAttribute("aria-expanded", "false"); tab.setAttribute("aria-controls", "p-msg");
$("t-hist").after(tab);
const panel = el("div", { id: "p-msg", className: "panel", hidden: true });
panel.innerHTML = `
  <p class="msg warn" id="mg-off" hidden>The messaging node is off, so messages can't be sent or received right now. The app starts it again by itself.</p>
  <div id="mg-nokey" hidden>
    <p class="note">Messages to and from LNS names, end-to-end encrypted. This phone gets its own messaging key, kept with the wallet and locked by your PIN.</p>
    <button type="button" class="primary" id="mg-on">Turn on messages</button>
  </div>
  <div id="mg-ready" hidden>
    <details id="mg-setup"><summary id="mg-who">This device: not set up yet</summary>
      <label for="mg-me">Your LNS name</label>
      <input id="mg-me" class="mono" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="40">
      <p class="note">Messages reach this phone once your name's <b>msg</b> entry is this device's key. Your name's holder key is on your computer, so run this there:</p>
      <code class="cmd" id="mg-cmd"></code>
      <div class="row"><button type="button" id="mg-copy">Copy command</button><button type="button" id="mg-check">Check</button></div>
      <p class="msg" id="mg-check-m" role="status"></p>
      <p class="note">This device's messaging key: <code class="hash" id="mg-key"></code></p>
    </details>
    <h3>Write</h3>
    <form id="mg-form" autocomplete="off">
      <label for="mg-to">To (an LNS name)</label>
      <input id="mg-to" class="mono" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="40">
      <label for="mg-text">Message</label>
      <textarea id="mg-text" maxlength="${MAX_TEXT}"></textarea>
      <button type="submit" class="primary" id="mg-send">Send</button>
      <p class="msg" id="mg-send-m" role="status"></p>
    </form>
    <h3>Inbox</h3>
    <div id="mg-inbox"><p class="note">Loading…</p></div>
  </div>`;
$("p-hist").after(panel);

// say where messages go, in the footer and in Settings > About
const ABOUT_MESSAGES = " Messages go through the Logos Messaging node on this device to the Logos Messaging network, sealed so only the person they're for can read them.";
for (const id of ["footer-talk", "about-talk"]) if ($(id)) $(id).textContent = $(id).textContent.replace(/ Testnet\.$/, ABOUT_MESSAGES + " Testnet.");

// one panel open at a time, together with Send and History
const pageOpen = window.openPanel;
window.openPanel = which => {
  pageOpen(which === "msg" ? null : which);
  const on = which === "msg";
  panel.hidden = !on; tab.setAttribute("aria-expanded", String(on));
  if (on) refresh();
};
tab.addEventListener("click", () => window.openPanel(panel.hidden ? "msg" : null));

// forget the key and what was read when the wallet locks
let mine = null;                    // { secret: Uint8Array, public: hex, name }
const pageShow = window.show;
window.show = view => {
  pageShow(view);
  if (view !== "v-open") { mine = null; $("mg-inbox").replaceChildren(); $("mg-text").value = ""; }
};

// ---- status, key and setup ----
async function refresh() {
  const r = await api("/api/messages/status");
  if (r.status === 401) return lockedNow();
  if (!r.ok) return;
  $("mg-off").hidden = r.data.node.reachable !== false;
  if (!r.data.key) { $("mg-nokey").hidden = false; $("mg-ready").hidden = true; return; }
  if (!mine || mine.public !== r.data.key) {
    const k = await api("/api/messages/key");
    if (k.status === 401) return lockedNow();
    if (!k.ok) return;
    mine = { secret: fromHex(k.data.secret), public: k.data.public, name: k.data.name || "" };
    $("mg-me").value = mine.name;
  }
  $("mg-nokey").hidden = true; $("mg-ready").hidden = false;
  renderSetup(); loadInbox();
}
function renderSetup() {
  $("mg-key").textContent = mine.public;
  $("mg-cmd").textContent = `names set-text ${mine.name || "<yourname>"} msg ${mine.public}`;
  $("mg-who").textContent = mine.name ? "This device: " + mine.name : "This device: not set up yet";
  if (!mine.name) $("mg-setup").open = true;
}
$("mg-on").addEventListener("click", async () => {
  const kp = newKeyPair();
  const r = await api("/api/messages/key", { secret: toHex(kp.secretKey), public: toHex(kp.publicKey) });
  if (r.status === 401) return lockedNow();
  if (r.ok) refresh();
});
$("mg-me").addEventListener("change", async () => {
  const lib = await namesLib();
  const name = lib.normalizeName($("mg-me").value);
  const m = $("mg-check-m"); m.className = "msg"; m.textContent = "";
  if (name && !lib.isValidName(name)) return void (m.className = "msg bad", m.textContent = "That isn't an LNS name.");
  const r = await api("/api/messages/name", { name });
  if (r.status === 401) return lockedNow();
  if (r.ok) { mine.name = name; $("mg-me").value = name; renderSetup(); }
});
$("mg-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("mg-cmd").textContent); $("mg-copy").textContent = "Copied"; }
  catch (e) { $("mg-copy").textContent = "Select it above"; }
  setTimeout(() => { $("mg-copy").textContent = "Copy command"; }, 2000);
});

// a name's `msg` entry: { registered, key (hex or null) }, kept a minute
const keyCache = new Map();
async function msgKeyOf(name, fresh = false) {
  const hit = keyCache.get(name);
  if (hit && !fresh && Date.now() - hit.at < 60000) return hit;
  const lib = await namesLib();
  const found = await lib.resolveName(NAMES_RPC, namesProgram, name);
  const out = { registered: found !== null, lapsed: !!(found && found.lapsed), at: Date.now(),
                key: found && found.texts && parseMsgKey(found.texts.msg) ? toHex(parseMsgKey(found.texts.msg)) : null };
  keyCache.set(name, out);
  return out;
}
$("mg-check").addEventListener("click", async () => {
  const m = $("mg-check-m"); m.className = "msg"; m.textContent = "";
  if (!mine.name) return void (m.className = "msg bad", m.textContent = "Enter your LNS name first.");
  m.textContent = "Checking " + mine.name + "… this takes a few seconds.";
  let k;
  try { k = await msgKeyOf(mine.name, true); } catch (e) { return void (m.className = "msg bad", m.textContent = "Couldn't reach the name service."); }
  if (!k.registered) return void (m.className = "msg bad", m.textContent = mine.name + " isn't a registered name.");
  if (k.key === mine.public) return void (m.className = "msg ok", m.textContent = "✓ Messages to " + mine.name + " come to this device.");
  m.className = "msg bad";
  m.textContent = k.key ? "Not yet: " + mine.name + "'s messages go to another key (another device). Run the command above to move them here."
                        : "Not yet: run the command above. You can send now, but replies can't reach you until it's done.";
});

// ---- write ----
$("mg-form").addEventListener("submit", async e => {
  e.preventDefault();
  const m = $("mg-send-m"); m.className = "msg bad"; m.textContent = "";
  const lib = await namesLib();
  const to = lib.normalizeName($("mg-to").value), text = $("mg-text").value;
  if (!lib.isValidName(to)) return void (m.textContent = "Enter an LNS name, like alice.");
  if (!mine.name) return void (m.textContent = "Enter your LNS name under \"This device\" first, so the message says who it's from.");
  if (!text.trim()) return void (m.textContent = "Write a message first.");
  $("mg-send").disabled = true; m.className = "msg"; m.textContent = "Looking up " + to + "…";
  try {
    let k;
    try { k = await msgKeyOf(to, true); } catch (err) { return void (m.className = "msg bad", m.textContent = "Couldn't reach the name service. Try again."); }
    if (!k.registered) return void (m.className = "msg bad", m.textContent = to + " isn't a registered name.");
    if (!k.key) return void (m.className = "msg bad", m.textContent = to + " has no messaging key (no msg entry), so they can't get messages yet.");
    const sealed = sealMessage({ to: fromHex(k.key), from: mine.name, fromSecret: mine.secret, text });
    const r = await api("/api/messages/send", { topic: inboxTopic(fromHex(k.key)), payload: b64(sealed) });
    if (r.status === 401) return lockedNow();
    if (!r.ok) return void (m.className = "msg bad", m.textContent = r.data.error || "The message wasn't sent.");
    $("mg-text").value = ""; m.textContent = "Sending to " + to + "…";
    for (let i = 0; i < 40; i++) {
      await new Promise(ok => setTimeout(ok, 2000));
      const s = await api("/api/messages/send/" + encodeURIComponent(r.data.requestId));
      if (!s.ok) continue;
      if (s.data.events.includes("sent")) return void (m.className = "msg ok", m.textContent = "Sent to " + to + ": a Store node holds it for them.");
      if (s.data.events.includes("error")) return void (m.className = "msg bad", m.textContent = "Not sent: " + (s.data.error || "the network didn't take it") + ".");
      if (s.data.events.includes("propagated")) { m.className = "msg ok"; m.textContent = "Sent to " + to + ": it reached the network."; }
    }
  } finally { $("mg-send").disabled = false; }
});

// ---- inbox: open here, check the sender against the chain ----
const opened = new Map();          // inbox number -> opened message (or null when it doesn't open)
async function loadInbox() {
  if (!mine) return;
  const r = await api("/api/messages/inbox");
  if (r.status === 401) return lockedNow();
  if (!r.ok) return;
  const rows = [], ids = new Set();
  let unreadable = 0;
  for (const item of r.data.items) {
    if (!opened.has(item.n)) opened.set(item.n, openMessage(mine.secret, unb64(item.payload)));
    const msg = opened.get(item.n);
    if (!msg) { unreadable++; continue; }
    if (ids.has(msg.id)) continue;                      // the same message twice
    ids.add(msg.id);
    rows.push({ item, msg });
  }
  rows.sort((a, b) => b.msg.ts - a.msg.ts);
  const box = $("mg-inbox");
  if (!rows.length) {
    box.replaceChildren(el("p", { className: "note", textContent: unreadable ? "No messages this key can open." : "No messages yet." }));
    return;
  }
  box.replaceChildren(...rows.map(({ item, msg }) => {
    const who = el("span", { className: "who unv", textContent: "checking " + msg.from + "…" });
    const del = el("button", { type: "button", textContent: "Delete" });
    del.addEventListener("click", async () => { await api("/api/messages/inbox/delete", { ids: [item.n] }); opened.delete(item.n); loadInbox(); });
    const reply = el("button", { type: "button", textContent: "Reply" });
    reply.addEventListener("click", () => { $("mg-to").value = msg.from; $("mg-text").focus(); });
    verify(msg).then(ok => { who.textContent = ok ? "✓ " + msg.from : "unverified: claims to be " + msg.from; who.className = ok ? "who" : "who unv"; });
    return el("div", { className: "mrow" }, who, el("div", { className: "text", textContent: msg.text }),
              el("div", { className: "sub" }, el("span", { textContent: when(msg.ts) }), reply, del));
  }));
}
async function verify(msg) {
  try {
    if (isVerified(msg, (await msgKeyOf(msg.from)).key)) return true;
    return isVerified(msg, (await msgKeyOf(msg.from, true)).key);   // a cached key may be an older device's
  } catch (e) { return false; }
}
setInterval(() => { if (!panel.hidden && !$("v-open").hidden) refresh(); }, 15000);

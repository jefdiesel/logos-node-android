// Your name (Settings > Your name): an LNS name for this phone's own LEZ 0.4 account, on LEZ 0.4's LNS registry.
// Loaded after /net04/sign04.js in the Android app, with the LEZ 0.4 signer; uses index.html's globals ($, api,
// lockedNow, openSettings, NAMES_RPC, namesProgram) and window.SIGN04 (its job runner).
// - Only the name is asked: the account is this phone's own first LEZ 0.4 account, whose key is here.
// - Before anything is sent the page looks the name up (the names project's resolver, /names/names.js, through the
//   app's /api/names/rpc): a taken name is said at once. Names of 1 to 4 characters are locked.
// - What it costs and how long, said before the button: two steps at least 15 minutes apart (a commitment, then the
//   registration, so nobody who sees it can take the name first), a deposit of 1,000,000 test LEZ held while you keep
//   the name, fees, and once a 61 MB download (the list of locked names).
// - Then the name is pointed at this phone in the same job: its public account (to be paid on LEZ 0.4 by name), the
//   node wallet's address (`blockchain`, to be paid Logos by name) and the messaging address (`msg`, Messages).
// - If the app stops part way, Your name says so and offers Continue: `names` goes on with the same commitment.
// window.LNS is what index.html (Settings) and Messages (/messages/messages.js) ask of Your name.
"use strict";
(() => {
const slot = document.getElementById("lns-slot");
if (!slot || !window.SIGN04) return;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
slot.innerHTML = `
    <section class="card" id="s-lns" aria-labelledby="h-s-lns" hidden>
      <h2 id="h-s-lns">Your name</h2>
      <p class="msg" id="n4n-wait" hidden>Reading…</p>
      <p class="note" id="n4n-nowallet" hidden>Set up your LEZ 0.4 wallet first (Wallet, under LEZ 0.4): the name belongs to its account.</p>
      <div id="n4n-none" hidden>
        <p class="note" style="margin-top:0">An LNS name for this phone's LEZ 0.4 account <span class="hash" id="n4n-acct"></span>. People can then pay you and write to you by the name.</p>
        <label for="lns-in">LNS name (5 to 32 characters)</label>
        <input id="lns-in" type="text" maxlength="32" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="alice">
        <ul class="note" id="n4n-what" style="padding-left:20px">
          <li>About 20 minutes: a first step, then the registration at least 15 minutes later, so nobody who sees it can take the name first. Keep the app open meanwhile. Other LEZ 0.4 sends and backups wait until it ends.</li>
          <li>A deposit of 1,000,000 test LEZ, held while you keep the name, and fees of about 2,600,000, from this account. The free test LEZ (Wallet) covers it.</li>
          <li id="n4n-list">Once, a 61 MB download: the list of locked names, from GitHub.</li>
          <li>Anyone who looks the name up then sees this phone's LEZ 0.4 account, its Logos address and its messaging address.</li>
        </ul>
        <button type="button" class="primary" id="n4n-go" style="width:100%">Register this name</button>
        <p class="msg" id="n4n-m" role="status"></p>
      </div>
      <div id="n4n-going" hidden>
        <p style="margin:0">Registering <b id="n4n-going-name"></b></p>
        <p class="msg" id="n4n-going-m" role="status"></p>
        <button type="button" class="primary" id="n4n-cont" style="width:100%" hidden>Continue</button>
      </div>
      <div id="n4n-has" hidden>
        <p style="margin:0"><b id="n4n-name"></b> is yours.</p>
        <p class="note" id="n4n-msg"></p>
        <p class="note" id="n4n-pay"></p>
        <button type="button" id="n4n-point" style="width:100%" hidden>Point it at this phone</button>
        <p class="msg" id="n4n-pm" role="status"></p>
      </div>
    </section>`;

let last = null, gen = 0, follow = null;
let names = null;
const namesLib = async () => names || (names = await import("/names/names.js"));
const lookup = async name => (await namesLib()).resolveName(NAMES_RPC, namesProgram, name);
const running = v => !!(v && v.job && v.job.state === "running" && (v.job.kind === "register" || v.job.kind === "entries"));

async function read() {
  const g = gen, r = await api("/api/wallet/lez04");
  if (g !== gen || r.stale || $("v-open").hidden) return null;
  if (r.status === 401) { lockedNow(); return null; }
  if (!r.ok) return null;
  last = r.data;
  return last;
}

// what the name service says the phone's name points at (Messages and payments), in two lines
async function pointsHere(name) {
  const g = gen;
  let rec = null;
  try { rec = await lookup(name); } catch (e) { rec = undefined; }
  if (g !== gen) return;
  const msg = $("n4n-msg"), pay = $("n4n-pay"), btn = $("n4n-point");
  if (rec === undefined) { msg.textContent = "Couldn't reach the name service to check where it points."; pay.textContent = ""; btn.hidden = true; return; }
  if (!rec) { msg.textContent = "The name service doesn't show it yet. Check again in a minute."; pay.textContent = ""; btn.hidden = true; return; }
  // (Messages says whether the name's msg entry is this phone's messaging address; without Messages, unknown)
  const here = typeof window.msgPointsHere === "function" ? await window.msgPointsHere(name) : null;
  if (g !== gen) return;
  const t = rec.texts || {};
  msg.textContent = !t.msg ? "Messages: not pointed at a messaging address yet." : here === true ? "Messages to " + name + " come to this phone."
    : here === false ? "Messages to " + name + " go to another messaging address." : "Messages: pointed at a messaging address.";
  const ours = !!(rec.account && last && rec.account === last.account);
  pay.textContent = ours ? "Payments: LEZ 0.4 to this phone's account" + (t.blockchain ? ", Logos to a Logos address." : ".")
    : "Payments: no LEZ 0.4 account on it yet.";
  btn.hidden = ours && here !== false && !!t.msg;
}

function render(v) {
  const box = id => $(id);
  for (const id of ["n4n-wait", "n4n-nowallet", "n4n-none", "n4n-going", "n4n-has"]) box(id).hidden = true;
  if (!v) { box("n4n-wait").hidden = false; return; }
  if (!v.ready) { box("n4n-nowallet").hidden = false; return; }
  const j = v.job || {};
  if (v.name && !(running(v) && j.kind === "register")) {
    box("n4n-has").hidden = false; $("n4n-name").textContent = v.name;
    if (running(v)) { $("n4n-pm").className = "msg"; $("n4n-pm").textContent = cap(j.progress || "starting") + "…"; $("n4n-point").hidden = true; }
    return;
  }
  const reg = v.registering || (running(v) ? { name: j.name } : null);
  if (reg) {
    box("n4n-going").hidden = false; $("n4n-going-name").textContent = reg.name;
    const m = $("n4n-going-m");
    if (running(v)) { m.className = "msg"; m.textContent = cap(j.progress || "starting") + "… Keep the app open."; $("n4n-cont").hidden = true; }
    else {
      m.className = j.state === "failed" && j.kind === "register" ? "msg bad" : "msg warn";
      m.textContent = j.state === "failed" && j.kind === "register" && j.error ? j.error
        : "It stopped part way (the app was closed). Continue goes on with the same first step, within a day of it.";
      $("n4n-cont").hidden = false;
    }
    return;
  }
  box("n4n-none").hidden = false;
  $("n4n-acct").textContent = "Public/" + v.account;
  $("n4n-list").hidden = !!v.shortlist;
}
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);

// follows a registration (also one started before this page was loaded) until it ends
function followJob() {
  clearTimeout(follow);
  const g = gen;
  follow = setTimeout(async () => {
    if (g !== gen) return;
    const v = await read();
    if (!v || g !== gen) return;
    render(v);
    if (running(v)) followJob();
    else if (v.name) pointsHere(v.name);
    if (typeof stRows === "function") stRows();
  }, 2000);
}

async function load() {
  render(last);
  const v = await read();
  if (!v) return;
  render(v);
  if (running(v)) followJob();
  else if (v.name) pointsHere(v.name);
  if (typeof stRows === "function") stRows();
}

async function start(name) {
  const m = $("n4n-m"), b = $("n4n-go"), g = gen;
  m.className = "msg"; m.textContent = "";
  const lib = await namesLib();
  const n = lib.normalizeName(name || "");
  if (!n || !lib.isValidName(n) || n.length < 5) { m.className = "msg bad"; m.textContent = "An LNS name here is 5 to 32 characters: lowercase letters a-z, digits and inner hyphens."; return; }
  b.disabled = true; b.textContent = "Checking " + n + "…";
  let rec;
  try { rec = await lookup(n); } catch (e) { rec = undefined; }
  if (g !== gen) return;
  b.disabled = false; b.textContent = "Register this name";
  if (rec === undefined) { m.className = "msg bad"; m.textContent = "Couldn't reach the name service, so nothing was sent. Try again."; return; }
  if (rec) { m.className = "msg bad"; m.textContent = n + " is taken: someone holds it already. Pick another name."; return; }
  go(n, b, m);
}
function go(name, b, m) {
  window.SIGN04.run("/api/wallet/lez04/register", { name }, b, m, "Starting…",
    v => (v.name || name) + " is yours, and points at this phone.",
    () => { $("lns-in").value = ""; load(); },
    () => load());
  setTimeout(load, 1200);               // the job's own lines show in Your name's own view
}

$("n4n-go").addEventListener("click", () => start($("lns-in").value));
$("lns-in").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); start($("lns-in").value); } });
$("n4n-cont").addEventListener("click", () => { const n = last && last.registering && last.registering.name; if (n) go(n, $("n4n-cont"), $("n4n-going-m")); });
const pointMsg = async () => {
  const m = $("n4n-pm");
  window.SIGN04.run("/api/wallet/lez04/point", {}, $("n4n-point"), m, "Pointing…", () => "Done: it points at this phone.", () => load(), () => load());
  setTimeout(load, 1200);
  return true;
};
$("n4n-point").addEventListener("click", pointMsg);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("v-open").hidden && !$("page-settings").hidden && !$("s-lns").hidden) load();
});

window.LNS = {
  settings(unlocked, shown) { if (!unlocked) { $("s-lns").hidden = true; return; } $("s-lns").hidden = false; if (shown) load(); },
  refresh() { if (!$("s-lns").hidden) load(); },
  lock() {
    gen++; clearTimeout(follow); last = null;
    $("lns-in").value = "";
    for (const id of ["n4n-m", "n4n-going-m", "n4n-pm", "n4n-msg", "n4n-pay", "n4n-acct", "n4n-name", "n4n-going-name"]) $(id).replaceChildren();
    render(null);
  },
  /** The phone's own name for Messages: { name, running } (null when it can't be read). */
  async own() { const v = await read(); if (!v) return null; return { name: v.name || "", running: running(v) && v.job.kind === "entries" }; },
  pointMsg,
  // one short line for Settings' list; [text, "warn"] for something to look at
  state() {
    const v = last; if (!v) return "";
    if (!v.ready) return "Set up LEZ 0.4 first";
    if (running(v) && v.job.kind === "register") return "Registering " + (v.job.name || "");
    if (v.registering && !v.name) return ["Registering " + v.registering.name + " stopped", "warn"];
    return v.name || "No name yet";
  },
};
})();

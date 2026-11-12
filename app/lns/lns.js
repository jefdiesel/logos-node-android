// Your name: an LNS name held by this phone's own name account (android/NAMES.md). The server sends this file,
// and the <script> tag that loads it, only inside the Android app when it carries the signer. It fills
// #lns-slot in Settings and uses the page's own helpers ($, api, short, copyBtn, fmt, lockedNow, openSettings).
// The page calls window.LNS.settings(unlocked, settingsShown) whenever Settings changes, and
// window.LNS.refresh() after a backup or a restore. The server makes the account, registers and points the
// name; this only shows it.
"use strict";
(() => {
const slot = document.getElementById("lns-slot");
if (!slot) return;
slot.innerHTML = `
    <section class="card" id="s-lns" aria-labelledby="h-s-lns" hidden>
      <h2 id="h-s-lns">Your name</h2>
      <div id="lns-none">
        <p style="margin:0">This phone can hold an LNS name of its own, like <b>alice</b>. People can then pay this wallet and message this phone by that name.</p>
        <p class="note">First the phone makes a name account. Its key is made on this phone and kept on it, unencrypted like the wallet's own keys: Android keeps other apps out, but your PIN doesn't lock the file. There is no recovery phrase. A backup made after the account exists is the only way to get it back.</p>
        <button type="button" id="b-lns-acct" style="width:100%;margin-top:12px">Make a name account</button>
      </div>
      <div id="lns-acct" hidden>
        <p style="margin:0">Name account: <code id="lns-addr"></code> <span id="lns-copy"></span></p>
        <p style="margin:8px 0 0">Balance: <b id="lns-bal">-</b></p>
        <p class="note">Changes to your name are paid from this account, in LEZ testnet tokens (not the Logos in your wallet). Registering a name holds a deposit of 1,000,000, which comes back if you give the name up, plus small fees.</p>
        <div id="lns-bk" class="msg warn" hidden>
          <p style="margin:0">Make a new backup now. There is no recovery phrase for this account: a backup made after this change is the only copy of its key that isn't on this phone.</p>
          <button type="button" id="b-lns-bk" style="width:100%;margin-top:10px">Back up now</button>
        </div>
        <div id="lns-noname">
          <label for="lns-in">LNS name</label>
          <input id="lns-in" type="text" maxlength="32" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
          <p class="hint">a to z, 0 to 9 and -, written bare: <b>alice</b></p>
          <button type="button" class="primary" id="b-lns-reg" style="width:100%;margin-top:12px" disabled>Register this name</button>
          <button type="button" id="b-lns-link" style="width:100%;margin-top:8px" disabled>I already hold this name</button>
        </div>
        <div id="lns-has" hidden>
          <p style="margin:12px 0 0">LNS name: <b id="lns-name"></b></p>
          <button type="button" id="b-lns-bc" style="width:100%;margin-top:12px">Point it at this wallet</button>
          <button type="button" id="b-lns-msg" style="width:100%;margin-top:8px">Point it at my messaging address</button>
        </div>
      </div>
      <p class="msg warn" id="lns-notes" role="alert" hidden></p>
      <p class="msg" id="m-lns" role="status"></p>
    </section>`;
var lnsTimer = null, lnsLast = null;
const LNS_DOING = { register: n => "Registering " + n + ". This takes about 20 minutes: the name service makes everyone wait 15 minutes between the two steps, so nobody can take a name they saw you ask for. Keep the app open.",
  text: (n, e) => (e === "msg" ? "Pointing " + n + " at your messaging address" : "Pointing " + n + " at this wallet") + ". This takes 1 to 3 minutes." };
function lnsMsg(text, cls) { const m = $("m-lns"); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; }
async function lnsLoad() {
  const r = await api("/api/wallet/lns");
  if (r.status === 401) return lockedNow();
  if (!r.ok) { $("s-lns").hidden = true; return; }
  $("s-lns").hidden = false; lnsLast = r.data;
  const d = r.data, has = !!d.account;
  $("lns-none").hidden = has; $("lns-acct").hidden = !has;
  if (has) {
    $("lns-addr").textContent = short(d.account); $("lns-addr").title = d.account;
    $("lns-copy").replaceChildren(copyBtn(d.account, "Copy"));
    $("lns-bal").textContent = d.balance == null ? "not known right now" : fmt(d.balance) + " LEZ testnet";
    $("lns-noname").hidden = !!d.name; $("lns-has").hidden = !d.name; $("lns-name").textContent = d.name || "";
    $("b-lns-bc").disabled = !d.values.blockchain; $("b-lns-msg").disabled = !d.values.msg;
    $("b-lns-msg").title = d.values.msg ? "" : "Turn on messages first";
  }
  // not while a change runs: the signer may be rewriting the files a backup would read
  $("lns-bk").hidden = !(has && d.backup_needed && !(d.job && d.job.state === "running"));
  if (d.notes && d.notes.length) { $("lns-notes").textContent = d.notes.join(" "); $("lns-notes").hidden = false; }
  const j = d.job || {}, running = j.state === "running";
  for (const id of ["b-lns-acct", "b-lns-reg", "b-lns-link", "b-lns-bc", "b-lns-msg"]) if (running) $(id).disabled = true;
  if (!running) { lnsInput(); $("b-lns-acct").disabled = false; if (has) { $("b-lns-bc").disabled = !d.values.blockchain; $("b-lns-msg").disabled = !d.values.msg; } }
  if (running) lnsMsg((LNS_DOING[j.kind] ? LNS_DOING[j.kind](j.name, j.entry) : "Working…") + (j.progress ? " (" + j.progress + ")" : ""));
  else if (j.state === "done") lnsMsg(j.kind === "register" ? j.name + " is yours." : "Done: " + j.name + " now points " + (j.entry === "msg" ? "at your messaging address." : "at this wallet."), "ok");
  else if (j.state === "failed") lnsMsg("That didn't work: " + j.error, "bad");
  if (typeof stRows === "function") stRows();      // Settings' list: the Your name row and its line
  clearTimeout(lnsTimer);
  if (running && !$("page-settings").hidden) lnsTimer = setTimeout(lnsLoad, 5000);
}
const lnsName = () => $("lns-in").value.trim().toLowerCase();
function lnsInput() {
  const ok = /^(?!-)[a-z0-9-]{1,32}(?<!-)$/.test(lnsName());
  $("b-lns-reg").disabled = !ok; $("b-lns-link").disabled = !ok;
}
$("lns-in").addEventListener("input", lnsInput);
async function lnsDo(path, body, sayFirst) {
  lnsMsg(sayFirst || "");
  for (const id of ["b-lns-acct", "b-lns-reg", "b-lns-link", "b-lns-bc", "b-lns-msg"]) $(id).disabled = true;
  const r = await api(path, body);
  if (r.status === 401) return lockedNow();
  if (!r.ok) { await lnsLoad(); return lnsMsg(r.data.error || "That didn't work.", "bad"); }
  await lnsLoad();
}
$("b-lns-bk").addEventListener("click", () => openSettings("s-bk", "bk-pw1"));
$("b-lns-acct").addEventListener("click", () => lnsDo("/api/wallet/lns/account", {}, "Making the name account…"));
$("b-lns-reg").addEventListener("click", () => lnsDo("/api/wallet/lns/register", { name: lnsName() }));
$("b-lns-link").addEventListener("click", () => lnsDo("/api/wallet/lns/name", { name: lnsName() }));
$("b-lns-bc").addEventListener("click", () => lnsDo("/api/wallet/lns/text", { entry: "blockchain" }));
$("b-lns-msg").addEventListener("click", () => lnsDo("/api/wallet/lns/text", { entry: "msg" }));

window.LNS = {
  settings(unlocked, shown) { if (!unlocked) { $("s-lns").hidden = true; clearTimeout(lnsTimer); } else if (shown) lnsLoad(); },
  refresh() { if (!$("s-lns").hidden) lnsLoad(); },
  // one short line for Settings' list; [text, "warn"] for something to look at
  state() {
    const d = lnsLast; if (!d) return "";
    const j = d.job || {};
    if (j.state === "running") return j.kind === "register" ? "Registering " + j.name : "Pointing " + j.name;
    if (!d.account) return "No name account yet";
    if (d.backup_needed) return [(d.name || "No name yet") + " · back up needed", "warn"];
    return d.name || "No name yet";
  },
};
if (!$("page-settings").hidden && !$("v-open").hidden) lnsLoad();
})();

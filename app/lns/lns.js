// Your name and the LEZ token: the phone's own name account (android/NAMES.md). The server sends this file, and the
// <script> tag that loads it, only inside the Android app when it carries the signer. It fills #lns-slot in Settings
// and #tok-panels in the Wallet, and adds the LEZ row to the Wallet's token list. It uses the page's own helpers
// ($, api, short, copyBtn, fmt, lockedNow, openSettings, walletToken, walletPick, qrSvg, fitAmt, startScan, parseScan).
// The page calls window.LNS.settings(unlocked, settingsShown) whenever Settings changes, window.LNS.refresh() after a
// backup or a restore, and window.LNS.home(on) when the Wallet refreshes (on) or locks (off).
"use strict";
(() => {
const slot = document.getElementById("lns-slot");
if (!slot) return;
const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props || {}); e.append(...kids); return e; };
slot.innerHTML = `
    <section class="card" id="s-lns" aria-labelledby="h-s-lns" hidden>
      <h2 id="h-s-lns">Your name</h2>
      <div id="lns-none">
        <p style="margin:0">Hold an LNS name on this phone, like <b>alice</b>.</p>
        <button type="button" id="b-lns-acct" style="width:100%;margin-top:12px">Make a name account</button>
      </div>
      <div id="lns-acct" hidden>
        <p style="margin:0">Account <code id="lns-addr"></code> <span id="lns-copy"></span></p>
        <p style="margin:6px 0 0">Balance <b id="lns-bal">-</b></p>
        <p class="note" id="lns-cost" hidden></p>
        <p class="msg warn" id="lns-need" hidden></p>
        <div id="lns-get">
          <div class="row"><button type="button" id="b-lns-faucet">Get test LEZ</button><button type="button" id="b-lns-br">Bridge from wallet</button></div>
          <div id="lns-brf" hidden>
            <label for="lns-br-from" id="l-lns-br-from">From</label>
            <select id="lns-br-from"></select>
            <label for="lns-br-amt">Amount</label>
            <input id="lns-br-amt" type="text" inputmode="numeric" maxlength="24" autocomplete="off">
            <div class="row"><button type="button" id="b-lns-br-x">Cancel</button><button type="button" class="primary" id="b-lns-br-rev">Review</button></div>
          </div>
          <div id="lns-brr" hidden>
            <dl>
              <div><dt>From</dt><dd id="lns-brr-from"></dd></div>
              <div><dt>To</dt><dd>Your name account</dd></div>
              <div><dt>Amount</dt><dd id="lns-brr-amt"></dd></div>
              <div><dt>Fee</dt><dd id="lns-brr-fee"></dd></div>
            </dl>
            <p class="note">Takes minutes to hours. Can't be undone.</p>
            <div class="row"><button type="button" id="b-lns-br-back">Back</button><button type="button" class="primary" id="b-lns-br-go">Bridge now</button></div>
          </div>
          <p class="msg" id="lns-brs" role="status" hidden></p>
          <button type="button" id="b-lns-br-stop" hidden>Stop</button>
        </div>
        <div id="lns-bk" class="msg warn" hidden>
          <p style="margin:0">Back up now. This key has no other copy.</p>
          <button type="button" id="b-lns-bk" style="width:100%;margin-top:10px">Back up now</button>
        </div>
        <div id="lns-noname">
          <label for="lns-in">LNS name</label>
          <input id="lns-in" type="text" maxlength="32" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
          <p class="hint">a–z, 0–9 and -, like <b>alice</b></p>
          <button type="button" class="primary" id="b-lns-reg" style="width:100%;margin-top:12px" disabled>Register</button>
          <p class="note" id="lns-why" hidden></p>
          <button type="button" id="b-lns-link" style="width:100%;margin-top:8px" disabled>I already hold it</button>
        </div>
        <div id="lns-has" hidden>
          <p style="margin:12px 0 0">Name <b id="lns-name"></b></p>
          <button type="button" id="b-lns-bc" style="width:100%;margin-top:12px">Point it at this wallet</button>
          <button type="button" id="b-lns-msg" style="width:100%;margin-top:8px">Point it at my messages</button>
        </div>
      </div>
      <div id="lns-step" class="msg" role="status" hidden><b id="lns-step-t"></b><br><span id="lns-step-s"></span><br><span class="note">Keep the app open.</span></div>
      <p class="msg warn" id="lns-notes" role="alert" hidden></p>
      <p class="msg" id="m-lns" role="status"></p>
      <details id="lns-more"><summary>Details</summary>
        <p class="note">The key is made and kept on this phone, unencrypted like the wallet's own keys. Your PIN guards the app, not the file.</p>
        <p class="note">There is no recovery phrase. A backup made after the account exists is the only way back.</p>
        <p class="note">Names are paid in LEZ testnet tokens, not Logos. The deposit comes back if you give the name up.</p>
        <p class="note">Registering takes two steps, 15 minutes apart, so nobody can take a name they saw you ask for.</p>
        <p class="note">The faucet pays once a day. A bridge moves Logos from this wallet to the name account; it can't be sent back yet.</p>
      </details>
    </section>`;
// the LEZ token's Send / Receive / Activity, shown by the Wallet's tabs when LEZ is picked
const panels = document.getElementById("tok-panels");
if (panels) panels.innerHTML = `
      <div id="lez-send" class="panel" role="tabpanel" hidden>
        <form id="f-lez-send" autocomplete="off">
          <label for="lez-to">To: a LEZ account</label>
          <div class="pwrow"><input id="lez-to" type="text" placeholder="Public/…" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="60"><button type="button" id="b-lez-scan" hidden>Scan</button></div>
          <p class="msg" id="m-lez-scan" role="status" hidden></p>
          <label for="lez-amt">Amount, in LEZ</label>
          <input id="lez-amt" type="text" inputmode="numeric" maxlength="24">
          <button class="primary" type="submit" id="b-lez-rev">Review</button>
        </form>
        <div id="lez-rv" hidden>
          <dl>
            <div><dt>Amount</dt><dd id="lez-rv-amt"></dd></div>
            <div><dt>To</dt><dd class="hash" id="lez-rv-to"></dd></div>
            <div><dt>Fee</dt><dd id="lez-rv-fee"></dd></div>
          </dl>
          <p class="note">Can't be undone.</p>
          <div class="row"><button type="button" id="b-lez-back">Back</button><button type="button" class="primary" id="b-lez-go">Send now</button></div>
        </div>
        <p class="msg" id="m-lez-send" role="status"></p>
      </div>
      <div id="lez-recv" class="panel" role="tabpanel" hidden>
        <p class="note" style="text-align:center">Your name account · LEZ testnet</p>
        <div class="qr-wrap" id="lez-qr"></div>
        <p class="recv-addr" id="lez-addr"></p>
        <div class="row"><button type="button" id="b-lez-copy">Copy</button></div>
      </div>
      <div id="lez-act" class="panel" role="tabpanel" hidden>
        <p class="note">What this app did with LEZ. Payments from others show in the balance.</p>
        <div id="lez-rows"></div>
        <button type="button" id="b-lez-get" style="width:100%;margin-top:12px">Get LEZ</button>
      </div>`;

var lnsTimer = null, lnsLast = null, lezAcct = null, lezBal, tick = null;
const LEZ = n => fmt(n) + " LEZ";
const lezAmt = v => balHidden ? MASK : LEZ(v);
function lnsMsg(text, cls) { const m = $("m-lns"); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; }
const RUN_IDS = ["b-lns-acct", "b-lns-reg", "b-lns-link", "b-lns-bc", "b-lns-msg"];

// ---- what a running change shows: a short stepper -------------------------------------------------------------
function stepText(j) {
  if (j.kind === "register") {
    const sent = /^(sent|in block)/.test(j.progress || "");
    if (j.phase === "wait") {
      const m = /^waiting ([0-9]+)s/.exec(j.progress || ""), left = m ? Math.max(0, Number(m[1]) - Math.round(Date.now() / 1000 - (j.progress_at || 0))) : 0;
      return ["Registering " + j.name, "Waiting " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0")];
    }
    if (j.phase === "2") return ["Registering " + j.name, "Step 2 of 2 · " + (sent ? "sent" : "sending")];
    return ["Registering " + j.name, "Step 1 of 2 · " + (sent ? "sent" : "sending")];
  }
  if (j.kind === "send") return ["Sending " + LEZ(j.amount), /^(sent|in block)/.test(j.progress || "") ? "sent" : "sending"];
  return [(j.entry === "msg" ? "Pointing " + j.name + " at my messages" : "Pointing " + j.name + " at this wallet"),
          /^(sent|in block)/.test(j.progress || "") ? "sent" : "sending"];
}
function stepDraw() {
  const j = (lnsLast && lnsLast.job) || {};
  $("lns-step").hidden = j.state !== "running";
  if (j.state !== "running") { clearInterval(tick); tick = null; return; }
  const [t, sub] = stepText(j); $("lns-step-t").textContent = t; $("lns-step-s").textContent = sub;
}

// ---- Settings > Your name -------------------------------------------------------------------------------------
async function lnsLoad() {
  const r = await api("/api/wallet/lns");
  if (r.status === 401) return lockedNow();
  if (!r.ok) { $("s-lns").hidden = true; return; }
  $("s-lns").hidden = false; lnsLast = r.data;
  const d = r.data, has = !!d.account;
  $("lns-none").hidden = has; $("lns-acct").hidden = !has;
  if (has) {
    $("lns-addr").textContent = short(d.account); $("lns-addr").title = d.account;
    $("lns-copy").replaceChildren(copyBtn("Public/" + d.account, "Copy"));
    $("lns-bal").textContent = d.balance == null ? "not known right now" : LEZ(d.balance);
    $("lns-noname").hidden = !!d.name; $("lns-has").hidden = !d.name; $("lns-name").textContent = d.name || "";
    $("b-lns-bc").disabled = !d.values.blockchain; $("b-lns-msg").disabled = !d.values.msg;
    $("b-lns-msg").title = d.values.msg ? "" : "Turn on messages first";
    costDraw(); bridgeDraw();
  }
  // not while a change runs: the signer may be rewriting the files a backup would read
  $("lns-bk").hidden = !(has && d.backup_needed && !(d.job && d.job.state === "running"));
  $("lns-notes").hidden = !(d.notes && d.notes.length);
  if (d.notes && d.notes.length) $("lns-notes").textContent = d.notes.join(" ");
  const j = d.job || {}, running = j.state === "running";
  for (const id of RUN_IDS) if (running) $(id).disabled = true;
  if (!running) { lnsInput(); $("b-lns-acct").disabled = false; if (has) { $("b-lns-bc").disabled = !d.values.blockchain; $("b-lns-msg").disabled = !d.values.msg; } }
  stepDraw();
  if (running) { lnsMsg(""); if (!tick) tick = setInterval(stepDraw, 1000); }
  else if (j.state === "done") lnsMsg(j.kind === "register" ? j.name + " is yours." : j.kind === "send" ? "Sent " + LEZ(j.amount) + "." : "Done.", "ok");
  else if (j.state === "failed") lnsMsg("Didn't work: " + j.error, "bad");
  if (typeof stRows === "function") stRows();      // Settings' list: the Your name row and its line
  clearTimeout(lnsTimer);
  const costLater = has && !d.name && !(d.cost && d.cost.need);       // the cost is read in the background: ask again
  const wait = running || costLater || (d.bridge && ["splitting", "ready", "depositing", "sent", "landed"].includes(d.bridge.state));
  if (wait && (!$("page-settings").hidden || tokSel === "lez")) lnsTimer = setTimeout(() => { lnsLoad(); if (tokSel === "lez") lezActDraw(); }, 5000);
}
const lnsName = () => $("lns-in").value.trim().toLowerCase();
const nameOk = n => /^(?!-)[a-z0-9-]{1,32}(?<!-)$/.test(n);
/** What registering this name takes, and whether the balance covers it: [need, short by] (nulls when not known). */
function needFor(n) {
  const d = lnsLast || {}, c = d.cost || {};
  const need = n && n.length === 3 ? c.need_three : c.need;
  if (need == null || d.balance == null) return [need, null];
  const by = BigInt(need) - BigInt(d.balance);
  return [need, by > 0n ? by.toString() : "0"];
}
function costDraw() {
  const d = lnsLast || {}, c = d.cost || {}, n = lnsName(), three = n.length === 3;
  const dep = three ? c.deposit_three : c.deposit;
  $("lns-cost").hidden = !dep || !!d.name;
  if (dep) $("lns-cost").textContent = "Costs " + fmt(dep) + " LEZ deposit + a small fee.";
  const [, by] = needFor(n);
  $("lns-need").hidden = d.name || by == null || by === "0";
  if (by && by !== "0") $("lns-need").textContent = "You need " + fmt(by) + " more LEZ.";
}
function lnsInput() {
  const n = lnsName(), ok = nameOk(n), running = lnsLast && lnsLast.job && lnsLast.job.state === "running";
  const [need, by] = needFor(n), short = by != null && by !== "0";
  $("b-lns-reg").disabled = !ok || short || running; $("b-lns-link").disabled = !ok || running;
  $("lns-why").hidden = !(ok && short);
  if (ok && short) $("lns-why").textContent = "Needs " + fmt(need) + " LEZ. Get LEZ above.";
  costDraw();
}
$("lns-in").addEventListener("input", lnsInput);
async function lnsDo(path, body) {
  lnsMsg("");
  for (const id of RUN_IDS) $(id).disabled = true;
  const r = await api(path, body);
  if (r.status === 401) return lockedNow();
  if (!r.ok) { await lnsLoad(); return lnsMsg(r.data.error || "That didn't work.", "bad"); }
  await lnsLoad();
}
$("b-lns-bk").addEventListener("click", () => openSettings("s-bk", "bk-pw1"));
$("b-lns-acct").addEventListener("click", () => lnsDo("/api/wallet/lns/account", {}));
$("b-lns-reg").addEventListener("click", () => lnsDo("/api/wallet/lns/register", { name: lnsName() }));
$("b-lns-link").addEventListener("click", () => lnsDo("/api/wallet/lns/name", { name: lnsName() }));
$("b-lns-bc").addEventListener("click", () => lnsDo("/api/wallet/lns/text", { entry: "blockchain" }));
$("b-lns-msg").addEventListener("click", () => lnsDo("/api/wallet/lns/text", { entry: "msg" }));

// ---- Get LEZ: the faucet, and a bridge from this wallet -------------------------------------------------------
function brSay(text, cls) { const m = $("lns-brs"); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; m.hidden = !text; }
$("b-lns-faucet").addEventListener("click", async () => {
  $("b-lns-faucet").disabled = true; brSay("Asking the faucet…");
  const r = await api("/api/wallet/lns/faucet", {});
  $("b-lns-faucet").disabled = false;
  if (r.status === 401) return lockedNow();
  brSay(r.ok ? "Faucet sent " + LEZ(r.data.amount) + ". Arrives in a minute or two." : (r.data.error || "The faucet didn't answer."), r.ok ? "ok" : "bad");
  lnsLoad(); lezActDraw();
});
let brPlan = null;
async function brOpen() {
  const r = await api("/api/wallet/accounts");
  if (r.status === 401) return lockedNow();
  const sel = $("lns-br-from"), list = ((r.ok && r.data.accounts) || []).filter(a => a.balance && a.balance !== "0");
  sel.replaceChildren(...list.map(a => el("option", { value: a.key, textContent: a.label + " (" + amtH(a.balance) + ")" })));
  const one = list.length <= 1; sel.hidden = one; $("l-lns-br-from").hidden = one;
  const [, by] = needFor(lnsName());
  if (!$("lns-br-amt").value && by && by !== "0") $("lns-br-amt").value = by;
  $("lns-brf").hidden = false; $("lns-brr").hidden = true; brSay("");
  $("lns-br-amt").focus();
}
$("b-lns-br").addEventListener("click", () => $("lns-brf").hidden ? brOpen() : ($("lns-brf").hidden = true));
$("b-lns-br-x").addEventListener("click", () => { $("lns-brf").hidden = true; brSay(""); });
$("b-lns-br-rev").addEventListener("click", async () => {
  const amount = $("lns-br-amt").value.replace(/,/g, "").trim();
  if (!/^[0-9]{1,24}$/.test(amount) || BigInt(amount) <= 0n) return brSay("Enter a whole amount above 0.", "bad");
  const r = await api("/api/wallet/lns/bridge", { from: $("lns-br-from").value, amount });
  if (r.status === 401) return lockedNow();
  if (!r.ok) return brSay(r.data.error || "Can't bridge now.", "bad");
  brPlan = r.data.plan;
  $("lns-brr-from").textContent = brPlan.label;
  $("lns-brr-amt").textContent = fmt(brPlan.amount) + " Logos → " + LEZ(brPlan.amount);
  $("lns-brr-fee").textContent = "Up to " + fmt(BigInt(brPlan.fee_max) + BigInt(brPlan.split_fee_max || 0)) + " Logos";
  $("lns-brf").hidden = true; $("lns-brr").hidden = false; brSay("");
});
$("b-lns-br-back").addEventListener("click", () => { $("lns-brr").hidden = true; $("lns-brf").hidden = false; });
$("b-lns-br-go").addEventListener("click", async () => {
  if (!brPlan) return;
  $("b-lns-br-go").disabled = true;
  const r = await api("/api/wallet/lns/bridge", { from: brPlan.from, amount: brPlan.amount, confirm: true });
  $("b-lns-br-go").disabled = false;
  if (r.status === 401) return lockedNow();
  $("lns-brr").hidden = true; brPlan = null;
  if (!r.ok) return brSay(r.data.error || "Didn't start.", "bad");
  $("lns-br-amt").value = "";
  await lnsLoad();
});
$("b-lns-br-stop").addEventListener("click", async () => {
  const r = await api("/api/wallet/lns/bridge/cancel", {});
  if (r.status === 401) return lockedNow();
  if (!r.ok) brSay(r.data.error || "Can't stop it now.", "bad");
  await lnsLoad();
});
const BR_TEXT = { splitting: "Setting the amount aside", ready: "Sending to the bridge", depositing: "Sending to the bridge",
  sent: "Sent. Waiting for a block", landed: "In a block. Arrives in minutes to hours", arrived: "Arrived",
  overdue: "Not in a block yet", failed: "Didn't go", cancelled: "Stopped" };
function bridgeDraw() {
  const b = (lnsLast || {}).bridge;
  $("b-lns-br-stop").hidden = !(b && ["splitting", "ready"].includes(b.state));
  if (!b || ($("lns-brf").hidden === false || $("lns-brr").hidden === false)) return;
  if (["arrived", "cancelled"].includes(b.state) && Date.now() / 1000 - (b.arrived_at || b.created || 0) > 3600) return brSay("");
  const ok = b.state === "arrived", bad = ["failed", "overdue"].includes(b.state);
  brSay("Bridge " + fmt(b.amount) + ": " + BR_TEXT[b.state] + "." + (b.error ? " " + b.error : ""), ok ? "ok" : bad ? "bad" : "");
}

// ---- the LEZ token in the Wallet -------------------------------------------------------------------------------
async function home(on) {
  if (!on) {                                    // locked: nothing of the account stays on the page
    lezAcct = null; lezBal = undefined;
    const row = document.getElementById("tok-lez"); if (row) row.querySelector(".tok-amt").replaceChildren();
    for (const id of ["lez-qr", "lez-rows"]) $(id).replaceChildren();
    $("lez-addr").textContent = ""; $("lez-to").value = ""; $("lez-amt").value = ""; $("lez-rv").hidden = true; $("m-lez-send").textContent = "";
    return;
  }
  const r = await api("/api/wallet/lns/balance");
  if (r.status === 401 || !r.ok) return;
  lezAcct = r.data.account; lezBal = r.data.balance;
  if (!lezAcct) {                               // no name account yet: a quiet row that leads to making one
    walletToken({ id: "lez", name: "Add LEZ", net: "Make a name account", initials: "LEZ", panels: null, pick: () => openSettings("s-lns", "b-lns-acct") });
    document.getElementById("tok-lez").querySelector(".tok-amt").replaceChildren();
    return;
  }
  walletToken({ id: "lez", name: "LEZ", net: "LEZ testnet · for your LNS name", initials: "LEZ", pick: null,
                panels: { send: "lez-send", recv: "lez-recv", hist: "lez-act" }, onShow: lezShow });
  const amt = document.getElementById("tok-lez").querySelector(".tok-amt");
  if (lezBal == null) amt.replaceChildren(el("span", { className: "ph", textContent: "—", title: "Not known right now" }));
  else if (balHidden) amt.replaceChildren(el("span", { className: "mask", textContent: MASK }));
  else amt.replaceChildren(fmt(lezBal), el("span", { className: "unit", textContent: "LEZ" }));
  fitAmt(amt);
  if (tokSel === "lez") lezShow(wTab);
}
function lezShow(tab) {
  if (!lezAcct) return;
  if (tab === "recv") {
    const text = "Public/" + lezAcct; $("lez-addr").textContent = text;
    const cur = $("lez-qr").firstElementChild;
    if (!cur || cur.dataset.text !== text) qrSvg(text).then(q => { if (lezAcct && !$("lez-recv").hidden) $("lez-qr").replaceChildren(q); }).catch(() => $("lez-qr").replaceChildren());
  }
  if (tab === "hist") lezActDraw();
}
$("b-lez-copy").addEventListener("click", async () => {
  const b = $("b-lez-copy");
  try { await navigator.clipboard.writeText("Public/" + lezAcct); b.textContent = "Copied"; } catch (e) { b.textContent = "Select it above"; }
  setTimeout(() => { b.textContent = "Copy"; }, 2000);
});
const ACT_TEXT = { faucet: "From the faucet", bridge: "Bridged from wallet", register: "Registered", text: "Pointed", send: "Sent" };
const ACT_STATE = { running: "running", done: "", failed: "didn't work", sent: "", arrived: "", landed: "on its way",
  splitting: "starting", ready: "starting", depositing: "starting", overdue: "not in a block yet", cancelled: "stopped" };
async function lezActDraw() {
  const r = await api("/api/wallet/lns");
  if (r.status === 401) return lockedNow();
  if (!r.ok || !lezAcct) return;
  lnsLast = r.data;
  const rows = (r.data.activity || []).map(a => {
    const what = a.kind === "register" ? "Registered " + a.name : a.kind === "text" ? "Pointed " + a.name : a.kind === "send" ? "Sent to " + short(a.to || "") : ACT_TEXT[a.kind] || a.kind;
    const money = a.amount ? (a.kind === "send" ? "−" : a.kind === "faucet" || a.kind === "bridge" ? "+" : "") + lezAmt(a.amount) : "";
    const st = ACT_STATE[a.state] != null ? ACT_STATE[a.state] : a.state;
    const top = el("div", { className: "top" }, el("span", { className: "kind", textContent: what }), el("span", { className: "amt", textContent: money }));
    const sub = el("div", { className: "sub" }, el("span", { textContent: when(a.at * 1000) }), ...(st ? [el("span", { textContent: st })] : []));
    return el("div", { className: "hrow" }, top, sub);
  });
  $("lez-rows").replaceChildren(...(rows.length ? rows : [el("p", { className: "note", textContent: "Nothing yet." })]));
}
$("b-lez-get").addEventListener("click", () => openSettings("s-lns", "b-lns-faucet"));

// ---- LEZ Send: to a Public/ account, through the review, signed with the name account's key ---------------------
let lezPlan = null;
function lezSay(text, cls) { const m = $("m-lez-send"); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; }
$("f-lez-send").addEventListener("submit", async e => {
  e.preventDefault(); lezSay("");
  const to = $("lez-to").value.trim(), amount = $("lez-amt").value.replace(/,/g, "").trim();
  if (!/^Public\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) return lezSay("Enter a LEZ account: Public/ and its ID.", "bad");
  if (!/^[0-9]{1,24}$/.test(amount) || BigInt(amount) <= 0n) return lezSay("Enter a whole amount above 0.", "bad");
  const r = await api("/api/wallet/lns/send", { to, amount });
  if (r.status === 401) return lockedNow();
  if (!r.ok) return lezSay(r.data.error || "Can't send now.", "bad");
  lezPlan = r.data.plan;
  $("lez-rv-amt").textContent = LEZ(lezPlan.amount); $("lez-rv-to").textContent = "Public/" + lezPlan.to;
  $("lez-rv-fee").textContent = "Up to " + LEZ(lezPlan.fee_max);
  $("f-lez-send").hidden = true; $("lez-rv").hidden = false;
});
$("b-lez-back").addEventListener("click", () => { $("lez-rv").hidden = true; $("f-lez-send").hidden = false; lezPlan = null; });
$("b-lez-go").addEventListener("click", async () => {
  if (!lezPlan) return;
  $("b-lez-go").disabled = true;
  const r = await api("/api/wallet/lns/send", { to: "Public/" + lezPlan.to, amount: lezPlan.amount, confirm: true });
  $("b-lez-go").disabled = false;
  if (r.status === 401) return lockedNow();
  $("lez-rv").hidden = true; $("f-lez-send").hidden = false; lezPlan = null;
  if (!r.ok) return lezSay(r.data.error || "Didn't send.", "bad");
  $("lez-to").value = ""; $("lez-amt").value = "";
  lezSay("Sending. See Activity.", "ok");
  lezFollow();
});
async function lezFollow() {          // until the send has finished: then its result, and the balance
  const r = await api("/api/wallet/lns");
  if (r.status === 401) return lockedNow();
  const j = (r.ok && r.data.job) || {};
  if (j.kind === "send" && j.state === "running") return void setTimeout(lezFollow, 3000);
  if (j.kind === "send") lezSay(j.state === "done" ? "Sent " + LEZ(j.amount) + "." : "Didn't work: " + j.error, j.state === "done" ? "ok" : "bad");
  home(true); if (tokSel === "lez" && wTab === "hist") lezActDraw();
}
$("b-lez-scan").hidden = typeof SCAN === "undefined" || !SCAN;
$("b-lez-scan").addEventListener("click", () => {
  const m = $("m-lez-scan"); m.hidden = true; m.replaceChildren();
  const say = (cls, ...kids) => { m.className = "msg " + cls; m.replaceChildren(...kids); m.hidden = false; };
  const started = startScan({
    ok: text => {
      const p = parseScan(text);
      if (p.error) return say("bad", p.error);
      if (p.kind === "lez") { $("lez-to").value = p.value; return; }
      if (p.kind === "wallet") {
        const go = el("button", { type: "button", className: "small", textContent: "Send Logos" });
        go.addEventListener("click", () => { walletPick("logos", "send"); $("to").value = p.value; $("to").focus(); });
        return say("bad", "That's a Logos address. ", go);
      }
      const go = window.logosOpenNewChat ? el("button", { type: "button", className: "small", textContent: "Open New chat" }) : null;
      if (go) go.addEventListener("click", () => window.logosOpenNewChat("msg:" + p.value));
      return say("bad", "That's a messaging address. ", ...(go ? [go] : []));
    },
    fail: msg => say("bad", msg) });
  if (!started) say("bad", "The scanner didn't open. Paste the account instead.");
});

window.LNS = {
  settings(unlocked, shown) { if (!unlocked) { $("s-lns").hidden = true; clearTimeout(lnsTimer); } else if (shown) lnsLoad(); },
  refresh() { if (!$("s-lns").hidden) lnsLoad(); },
  home,
  /** A scanned LEZ account from elsewhere: LEZ's Send, with it filled in. */
  sendTo(acct) { if (!lezAcct) return openSettings("s-lns", "b-lns-acct"); walletPick("lez", "send"); $("lez-to").value = acct; $("lez-amt").focus(); },
  // one short line for Settings' list; [text, "warn"] for something to look at
  state() {
    const d = lnsLast; if (!d) return "";
    const j = d.job || {};
    if (j.state === "running") return j.kind === "register" ? "Registering " + j.name : j.kind === "send" ? "Sending LEZ" : "Pointing " + j.name;
    if (!d.account) return "No name account yet";
    if (d.backup_needed) return [(d.name || "No name yet") + " · back up needed", "warn"];
    return d.name || "No name yet";
  },
};
if (!$("page-settings").hidden && !$("v-open").hidden) lnsLoad();
if (!$("v-open").hidden) home(true);
})();

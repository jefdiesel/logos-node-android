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
// Settings > Your name: the name, its state, one tap to get one, a single cost line. LEZ itself lives in the Wallet.
slot.innerHTML = `
    <section class="card" id="s-lns" aria-labelledby="h-s-lns" hidden>
      <h2 id="h-s-lns">Your name</h2>
      <div id="lns-none">
        <label for="lns-in">LNS name</label>
        <input id="lns-in" type="text" maxlength="32" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="alice">
        <button type="button" class="primary" id="b-lns-get" style="width:100%;margin-top:12px" disabled>Get this name</button>
        <p class="note" id="lns-cost" hidden></p>
        <p class="note" id="lns-locked">Keeps going while the app is locked.</p>
        <button type="button" id="b-lns-link" style="width:100%;margin-top:8px" disabled>I already hold it</button>
      </div>
      <div id="lns-flow" hidden>
        <p style="margin:0"><b id="lns-flow-name"></b></p>
        <ol class="steps" id="lns-steps"></ol>
        <p class="msg warn" id="lns-need" hidden></p>
        <button type="button" class="primary" id="b-lns-addlez" style="width:100%" hidden>Add LEZ</button>
        <p class="note" id="lns-keep">Keep the app open.</p>
        <p class="msg bad" id="lns-flow-err" role="alert" hidden></p>
        <p class="note" id="lns-spent" hidden></p>
        <div class="row" id="lns-flow-acts" hidden><button type="button" id="b-lns-stop">Stop</button><button type="button" class="primary" id="b-lns-retry">Try again</button></div>
        <button type="button" id="b-lns-stop-now" style="width:100%" hidden>Stop now</button>
      </div>
      <div id="lns-has" hidden>
        <p style="margin:0"><b id="lns-name"></b> is yours.</p>
        <p class="note" id="lns-ent-bc"></p>
        <p class="note" id="lns-ent-msg"></p>
        <button type="button" class="primary" id="b-lns-finish" style="width:100%" hidden></button>
        <div id="lns-finish-ok" hidden>
          <p class="note" id="lns-finish-what"></p>
          <div class="row"><button type="button" id="b-lns-finish-x">Cancel</button><button type="button" class="primary" id="b-lns-finish-go">Set it</button></div>
        </div>
      </div>
      <div id="lns-bk" class="msg warn" hidden>
        <p style="margin:0">Back up now. This key has no other copy.</p>
        <button type="button" id="b-lns-bk" style="width:100%;margin-top:10px">Back up now</button>
      </div>
      <p class="msg warn" id="lns-notes" role="alert" hidden></p>
      <button type="button" id="b-lns-putback" style="width:100%" hidden>Put back the saved copy</button>
      <p class="msg" id="m-lns" role="status"></p>
      <details id="lns-more"><summary>More</summary>
        <div id="lns-manual" hidden>
          <button type="button" id="b-lns-bc" style="width:100%;margin-top:8px">Point it at this wallet</button>
          <button type="button" id="b-lns-msg" style="width:100%;margin-top:8px">Point it at my messages</button>
        </div>
        <p class="note">The key is made and kept on this phone, unencrypted like the wallet's own keys. Your PIN guards the app, not the file.</p>
        <p class="note">There is no recovery phrase. A backup made after the name account exists is the only way back.</p>
        <p class="note">Names are paid in LEZ testnet tokens (Wallet → LEZ), not Logos. The deposit comes back if you give the name up.</p>
        <p class="note">Registering takes two steps, 15 minutes apart, so nobody can take a name they saw you ask for. The app does every step itself, even while locked.</p>
      </details>
    </section>`;
// the LEZ token's Send / Receive / Activity, and Get LEZ above them, shown by the Wallet when LEZ is picked
const panels = document.getElementById("tok-panels");
if (panels) panels.innerHTML = `
      <div id="lez-get" class="panel" hidden>
        <div class="row" style="margin-top:6px"><button type="button" id="b-lns-faucet">Get test LEZ</button><button type="button" id="b-lns-br">Bridge from Logos</button></div>
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
            <div><dt>To</dt><dd class="hash" id="lns-brr-to"></dd></div>
            <div><dt>Amount</dt><dd id="lns-brr-amt"></dd></div>
            <div><dt>Fee</dt><dd id="lns-brr-fee"></dd></div>
          </dl>
          <p class="note">Takes minutes to hours. Can't be undone.</p>
          <div class="row"><button type="button" id="b-lns-br-back">Back</button><button type="button" class="primary" id="b-lns-br-go">Bridge now</button></div>
        </div>
        <p class="msg" id="lns-brs" role="status" hidden></p>
        <button type="button" id="b-lns-br-stop" hidden>Stop</button>
      </div>
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
        <p class="note" style="text-align:center">LEZ testnet</p>
        <div class="qr-wrap" id="lez-qr"></div>
        <p class="recv-addr" id="lez-addr"></p>
        <div class="row"><button type="button" id="b-lez-copy">Copy</button></div>
      </div>
      <div id="lez-act" class="panel" role="tabpanel" hidden>
        <p class="note">What this app did with LEZ. Payments from others show in the balance.</p>
        <div id="lez-rows"></div>
      </div>`;

var lnsTimer = null, lnsLast = null, lezAcct = null, lezBal, tick = null, epoch = 0;   // epoch: bumped by each lock
const stale = e => e !== epoch || $("v-open").hidden;       // an answer that comes back after a lock is dropped
const LEZ = n => fmt(n) + " LEZ";
const lezAmt = v => balHidden ? MASK : LEZ(v);
const up10k = v => ((BigInt(v) + 9999n) / 10000n * 10000n).toString();       // rounded up to 10,000
function lnsMsg(text, cls) { const m = $("m-lns"); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; }

// ---- Settings > Your name ------------------------------------------------------------------------------------------
// The steps of getting a name, as the page shows them; the server's flow (/api/wallet/lns/get) does them all.
const STEPS = [["account", "Name account"], ["fund", "LEZ"], ["register", "Register"], ["blockchain", "Pay to this wallet"], ["msg", "Messages to this phone"]];
function regSub(j) {             // the register step while it runs: 1 of 2, the wait (a countdown), 2 of 2
  if (!j || j.state !== "running" || j.kind !== "register") return "";
  const sent = /^(sent|in block)/.test(j.progress || "");
  if (j.phase === "wait") {
    const m = /^waiting ([0-9]+)s/.exec(j.progress || ""), left = m ? Math.max(0, Number(m[1]) - Math.round(Date.now() / 1000 - (j.progress_at || 0))) : 0;
    return "waiting " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  }
  return (j.phase === "2" ? "step 2 of 2 · " : "step 1 of 2 · ") + (sent ? "sent" : "sending");
}
function flowDraw(d) {
  const f = d.flow, on = !!f && f.step !== "done";
  $("lns-flow").hidden = !on;
  if (!on) { clearInterval(tick); tick = null; return; }
  $("lns-flow-name").textContent = f.name;
  const at = f.step === "failed" ? "" : f.step, idx = STEPS.findIndex(s => s[0] === at);
  $("lns-steps").replaceChildren(...STEPS.filter(s => !(f.mode === "link" && (s[0] === "fund" || s[0] === "register"))).map(([k, label]) => {
    const i = STEPS.findIndex(s => s[0] === k), state = f.step === "failed" ? (k === f.failed_at ? "bad" : "") : i < idx ? "done" : i === idx ? "now" : "";
    const sub = i === idx && k === "register" ? regSub(d.job) : i === idx && k === "fund" && f.short ? "needs " + fmt(f.short) + " more" : "";
    return el("li", { className: state }, (state === "done" ? "✓ " : state === "now" ? "→ " : "") + label + (sub ? " · " + sub : ""));
  }));
  const short = f.step === "fund" && f.short;
  $("lns-need").hidden = !short; $("b-lns-addlez").hidden = !short;
  if (short) $("lns-need").textContent = "Needs " + fmt(f.short) + " more LEZ.";
  const failed = f.step === "failed";
  // Stop is always there while it runs (the server refuses only while a change is being sent); Try again once stopped
  $("lns-flow-err").hidden = !failed; $("lns-flow-acts").hidden = false;
  $("b-lns-retry").hidden = !failed;
  if (failed) $("lns-flow-err").textContent = "Stopped: " + f.error;
  // before starting over: what it really did, and the most a new start may cost
  const sp = failed && f.spent;
  $("lns-spent").hidden = !sp;
  if (sp) $("lns-spent").textContent = (sp.tx == null ? "" : sp.tx + " transaction" + (sp.tx === 1 ? "" : "s") + " in blocks · ")
    + "billed at most " + LEZ(sp.billed_max) + (sp.balance_change == null ? "" : " · balance " + (sp.balance_change.startsWith("-") ? "−" + fmt(sp.balance_change.slice(1)) : "+" + fmt(sp.balance_change)) + " LEZ") + ".";
  $("b-lns-retry").textContent = failed && f.next_max ? "Start over (up to " + fmt(up10k(f.next_max)) + " LEZ more)" : "Try again";
  $("lns-keep").hidden = failed || short;
  if (!tick) tick = setInterval(() => { if (lnsLast && !document.hidden) flowDraw(lnsLast); }, 1000);
}
async function lnsLoad() {
  const e = epoch, r = await api("/api/wallet/lns");
  if (stale(e)) return;
  if (r.status === 401) return lockedNow();
  if (!r.ok) { $("s-lns").hidden = true; return; }
  $("s-lns").hidden = false; lnsLast = r.data;
  const d = r.data, f = d.flow, active = f && f.step !== "done";
  $("lns-none").hidden = !!d.name || active;
  $("lns-has").hidden = !d.name || active;
  $("lns-name").textContent = d.name || "";
  entriesDraw(d);
  flowDraw(d);
  costDraw();
  // not while a change runs: the signer may be rewriting the files a backup would read
  const running = d.job && d.job.state === "running";
  $("lns-bk").hidden = !(d.account && d.backup_needed && !running && !active);
  $("lns-notes").hidden = !(d.notes && d.notes.length);
  if (d.notes && d.notes.length) $("lns-notes").textContent = d.notes.join(" ");
  $("b-lns-putback").hidden = !d.saved_copy;
  lnsInput();
  if (!running && d.job && d.job.state === "failed" && !active) lnsMsg("Didn't work: " + d.job.error, "bad");
  if (typeof stRows === "function") stRows();      // Settings' list: the Your name row and its line
  clearTimeout(lnsTimer);
  const later = active || running || (d.name && !d.entries) || (!d.name && !(d.cost && d.cost.need));
  // asked again only while it is on screen (Settings shown, the app in front): nothing polls in the background
  if (later && !document.hidden && (!$("page-settings").hidden || tokSel === "lez")) lnsTimer = setTimeout(lnsLoad, active ? 3000 : 5000);
}
// each entry as the name service has it: what is already true is shown as done, never offered again
const ENTRY = { blockchain: ["b-lns-bc", "lns-ent-bc", "Pays go to this wallet ✓", "Not paying to this wallet yet"],
                msg: ["b-lns-msg", "lns-ent-msg", "Messages come to this phone ✓", "Messages don't come here yet"] };
function entriesDraw(d) {
  const running = d.job && d.job.state === "running";
  let offer = false;
  for (const [k, [bid, lid, done, not]] of Object.entries(ENTRY)) {
    const st = d.entries && d.entries[k];
    $(lid).textContent = st === "here" ? done : st == null ? "" : k === "msg" && !d.values.msg ? "Messages come here once you turn them on." : not;
    const can = st !== "here" && st != null && !running && (k !== "msg" || !!d.values.msg);
    $(bid).hidden = !can; offer = offer || can;
  }
  $("lns-manual").hidden = !(d.name && offer);
  // a name held with an entry still missing (from before one tap): one button finishes it, as one tap would
  const fin = d.name && d.entries && !(d.flow && d.flow.step !== "done") && !running
    && (d.entries.blockchain !== "here" || (d.values.msg && d.entries.msg !== "here"));
  $("b-lns-finish").hidden = !fin || !$("lns-finish-ok").hidden;
  if (fin) $("b-lns-finish").textContent = "Finish setting up " + d.name;
  if (!fin) $("lns-finish-ok").hidden = true;
}
const lnsName = () => $("lns-in").value.trim().toLowerCase();
const nameOk = n => /^(?!-)[a-z0-9-]{1,32}(?<!-)$/.test(n);
function costDraw() {
  const d = lnsLast || {}, c = d.cost || {}, n = lnsName();
  const dep = n.length === 3 ? c.deposit_three : c.deposit, fees = c.flow_fees;    // register (2) and both entries (2)
  $("lns-cost").hidden = !dep || !fees;
  if (dep && fees) $("lns-cost").textContent = "Costs " + fmt(dep) + " LEZ deposit + about " + fmt(up10k(fees)) + " LEZ fees · about 20 minutes.";
}
function lnsInput() {
  const ok = nameOk(lnsName()), d = lnsLast || {}, busy = (d.flow && d.flow.step !== "done") || (d.job && d.job.state === "running");
  $("b-lns-get").disabled = !ok || busy; $("b-lns-link").disabled = !ok || busy;
  costDraw();
}
$("lns-in").addEventListener("input", lnsInput);
async function lnsDo(path, body) {
  lnsMsg("");
  const e = epoch, r = await api(path, body);
  if (stale(e)) return false;
  if (r.status === 401) return lockedNow();
  if (!r.ok) { await lnsLoad(); lnsMsg(r.data.error || "That didn't work.", "bad"); return false; }
  await lnsLoad(); return true;
}
$("b-lns-get").addEventListener("click", () => lnsDo("/api/wallet/lns/get", { name: lnsName() }));
$("b-lns-link").addEventListener("click", () => lnsDo("/api/wallet/lns/get", { name: lnsName(), mode: "link" }));
// what Finish sets and what it costs, before anything is sent: one entry is about 530,000 LEZ at today's fee
$("b-lns-finish").addEventListener("click", () => {
  const d = lnsLast || {}, e = d.entries || {}, c = d.cost_entry, sets = [];
  if (e.blockchain !== "here") sets.push("pay to this wallet");
  if (d.values && d.values.msg && e.msg !== "here") sets.push("messages to this phone");
  $("lns-finish-what").textContent = "Sets " + d.name + " to " + sets.join(" and ") + ". About " + fmt(up10k(String(BigInt(c || "540000") * BigInt(sets.length)))) + " LEZ in fees.";
  $("lns-finish-ok").hidden = false; $("b-lns-finish").hidden = true;
});
$("b-lns-finish-x").addEventListener("click", () => { $("lns-finish-ok").hidden = true; lnsLoad(); });
$("b-lns-finish-go").addEventListener("click", async () => { $("lns-finish-ok").hidden = true; await lnsDo("/api/wallet/lns/get", { name: lnsLast.name, mode: "link" }); });
$("b-lns-retry").addEventListener("click", () => lnsDo("/api/wallet/lns/get/retry", {}));
// Stop: refused while a change is being sent (it says until when); "Stop now" only when stopping is safe
async function lnsStop(now) {
  const e = epoch, r = await api("/api/wallet/lns/get/stop", now ? { now: true } : {});
  if (stale(e)) return;
  if (r.status === 401) return lockedNow();
  $("b-lns-stop-now").hidden = !(r.status === 409 && r.data.safe_now);
  if (!r.ok) { lnsMsg(r.data.error || "It can't be stopped now.", "warn"); return; }
  lnsMsg(""); await lnsLoad();
}
$("b-lns-stop").addEventListener("click", () => lnsStop(false));
$("b-lns-stop-now").addEventListener("click", () => { $("b-lns-stop-now").hidden = true; lnsStop(true); });
$("b-lns-putback").addEventListener("click", () => lnsDo("/api/wallet/lns/putback", {}));
$("b-lns-bk").addEventListener("click", () => openSettings("s-bk", "bk-pw1"));
$("b-lns-bc").addEventListener("click", () => lnsDo("/api/wallet/lns/text", { entry: "blockchain" }));
// the one way to point the name at this phone's messaging address: here, and Settings > Messages > Name
const pointMsg = async () => { await lnsDo("/api/wallet/lns/text", { entry: "msg" }); return !!(lnsLast && lnsLast.job && lnsLast.job.state === "running"); };
$("b-lns-msg").addEventListener("click", pointMsg);
// short of LEZ: to the Wallet's LEZ, with the bridge ready for what is missing
$("b-lns-addlez").addEventListener("click", async () => {
  closeSettings(); await home(true);            // the LEZ row as it is now (the account was just made)
  walletPick("lez", "hist"); await brOpen(); $("lez-get").scrollIntoView({ block: "start" });
});

// ---- Get LEZ (Wallet → LEZ): the faucet, and a bridge from this wallet's Logos ----------------------------------
function brSay(text, cls) { const m = $("lns-brs"); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; m.hidden = !text; }
$("b-lns-faucet").addEventListener("click", async () => {
  $("b-lns-faucet").disabled = true; brSay("Asking the faucet…");
  const r = await api("/api/wallet/lns/faucet", {});
  $("b-lns-faucet").disabled = false;
  if (r.status === 401) return lockedNow();
  brSay(r.ok ? "Faucet sent " + lezAmt(r.data.amount) + ". Arrives in a minute or two." : (r.data.error || "The faucet didn't answer."), r.ok ? "ok" : "bad");
  lezLoad();
});
let brPlan = null, lezPlan = null;
async function brOpen() {
  const r = await api("/api/wallet/accounts");
  if (r.status === 401) return lockedNow();
  const sel = $("lns-br-from"), list = ((r.ok && r.data.accounts) || []).filter(a => a.balance && a.balance !== "0");
  sel.replaceChildren(...list.map(a => el("option", { value: a.key, textContent: a.label + " (" + amtH(a.balance) + ")" })));
  const one = list.length <= 1; sel.hidden = one; $("l-lns-br-from").hidden = one;
  const f = lnsLast && lnsLast.flow;
  // what is missing, but never below the least a bridge takes (its fees can reach that much)
  if (!$("lns-br-amt").value && f && f.step === "fund" && f.short) $("lns-br-amt").value = String(BigInt(f.short) > 110000n ? f.short : 110000);
  $("lns-brf").hidden = false; $("lns-brr").hidden = true; brSay("");
}
$("b-lns-br").addEventListener("click", () => $("lns-brf").hidden ? brOpen() : ($("lns-brf").hidden = true));
$("b-lns-br-x").addEventListener("click", () => { $("lns-brf").hidden = true; brSay(""); });
$("b-lns-br-rev").addEventListener("click", async () => {
  const amount = $("lns-br-amt").value.replace(/,/g, "").trim();
  if (!/^[0-9]{1,24}$/.test(amount) || BigInt(amount) <= 0n) return brSay("Enter a whole amount above 0.", "bad");
  const e = epoch, r = await api("/api/wallet/lns/bridge", { from: $("lns-br-from").value, amount });
  if (stale(e)) return;
  if (r.status === 401) return lockedNow();
  if (!r.ok) return brSay(r.data.error || "Can't bridge now.", "bad");
  brPlan = r.data.plan;
  $("lns-brr-from").textContent = brPlan.label;
  $("lns-brr-to").textContent = "LEZ · Public/" + brPlan.to;
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
  await lezLoad();
});
$("b-lns-br-stop").addEventListener("click", async () => {
  const r = await api("/api/wallet/lns/bridge/cancel", {});
  if (r.status === 401) return lockedNow();
  if (!r.ok) brSay(r.data.error || "Can't stop it now.", "bad");
  await lezLoad();
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
  brSay("Bridge " + (balHidden ? MASK : fmt(b.amount)) + ": " + BR_TEXT[b.state] + "." + (b.error ? " " + b.error : ""), ok ? "ok" : bad ? "bad" : "");
}
let lezTimer = null;
/** The Wallet's LEZ: the server's view (bridge, faucet, activity), while LEZ is picked; again while a bridge runs. */
async function lezLoad() {
  const e = epoch, r = await api("/api/wallet/lns");
  if (stale(e)) return;
  if (r.status === 401) return lockedNow();
  if (!r.ok || !lezAcct) return;
  lnsLast = r.data; bridgeDraw();
  if (tokSel === "lez" && wTab === "hist") lezActRows();
  clearTimeout(lezTimer);
  const b = r.data.bridge;
  if (tokSel === "lez" && !document.hidden && b && ["splitting", "ready", "depositing", "sent", "landed"].includes(b.state)) lezTimer = setTimeout(() => { lezLoad(); home(true); }, 5000);
}

// ---- the LEZ token in the Wallet -------------------------------------------------------------------------------
async function home(on) {
  if (!on) {                                    // locked: nothing of the account stays on the page, hidden parts too
    epoch++; lezAcct = null; lezBal = undefined; lnsLast = null; brPlan = null; lezPlan = null;
    clearTimeout(lezTimer); clearTimeout(lnsTimer); clearInterval(tick); tick = null;
    const row = document.getElementById("tok-lez"); if (row) row.querySelector(".tok-amt").replaceChildren();
    for (const id of ["lez-qr", "lez-rows", "lns-br-from"]) $(id).replaceChildren();
    for (const id of ["lez-addr", "m-lez-send", "m-lez-scan", "lez-rv-amt", "lez-rv-to", "lez-rv-fee", "lns-brs", "lns-brr-from", "lns-brr-to",
                      "lns-brr-amt", "lns-brr-fee", "lns-steps", "lns-need", "lns-flow-err", "lns-name", "lns-ent-bc", "lns-ent-msg", "m-lns"]) $(id).textContent = "";
    for (const id of ["lez-to", "lez-amt", "lns-br-amt", "lns-in"]) $(id).value = "";
    for (const id of ["lez-rv", "lns-brf", "lns-brr", "lns-brs", "m-lez-scan"]) $(id).hidden = true;
    $("f-lez-send").hidden = false;
    return;
  }
  if (document.hidden) return;                  // off screen: asked again when it comes back
  const e = epoch, r = await api("/api/wallet/lns/balance");
  if (stale(e) || r.status === 401 || !r.ok) return;
  lezAcct = r.data.account; lezBal = r.data.balance;
  if (!lezAcct) {                               // no name account yet: a quiet row that leads to making one
    walletToken({ id: "lez", name: "Add LEZ", net: "Comes with an LNS name", initials: "LEZ", panels: null, pick: () => openSettings("s-lns", "lns-in") });
    document.getElementById("tok-lez").querySelector(".tok-amt").replaceChildren();
    return;
  }
  walletToken({ id: "lez", name: "LEZ", net: "LEZ testnet", initials: "LEZ", pick: null,
                panels: { top: "lez-get", send: "lez-send", recv: "lez-recv", hist: "lez-act" }, onShow: lezShow });
  const amt = document.getElementById("tok-lez").querySelector(".tok-amt");
  if (lezBal == null) amt.replaceChildren(el("span", { className: "ph", textContent: "—", title: "Not known right now" }));
  else if (balHidden) amt.replaceChildren(el("span", { className: "mask", textContent: MASK }));
  else amt.replaceChildren(fmt(lezBal), el("span", { className: "unit", textContent: "LEZ" }));
  amt.title = lezBal == null || balHidden ? "" : fmt(lezBal) + " LEZ";     // the whole amount, if the row shows "…"
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
  lezLoad();                                     // Get LEZ's state, and Activity's rows
}
$("b-lez-copy").addEventListener("click", async () => {
  const b = $("b-lez-copy");
  try { await navigator.clipboard.writeText("Public/" + lezAcct); b.textContent = "Copied"; } catch (e) { b.textContent = "Select it above"; }
  setTimeout(() => { b.textContent = "Copy"; }, 2000);
});
const ACT_TEXT = { faucet: "From the faucet", bridge: "Bridged from wallet", register: "Registered", text: "Pointed", send: "Sent" };
const ACT_STATE = { running: "running", done: "", failed: "didn't work", unsure: "may have been sent", sent: "", arrived: "", landed: "on its way",
  splitting: "starting", ready: "starting", depositing: "starting", overdue: "not in a block yet", cancelled: "stopped" };
function lezActRows() {
  const rows = ((lnsLast || {}).activity || []).map(a => {
    const what = a.kind === "register" ? "Registered " + a.name : a.kind === "text" ? "Pointed " + a.name : a.kind === "send" ? "Sent to " + short(a.to || "") : ACT_TEXT[a.kind] || a.kind;
    const money = a.amount ? (a.kind === "send" ? "−" : a.kind === "faucet" || a.kind === "bridge" ? "+" : "") + lezAmt(a.amount) : "";
    const st = ACT_STATE[a.state] != null ? ACT_STATE[a.state] : a.state;
    const top = el("div", { className: "top" }, el("span", { className: "kind", textContent: what }), el("span", { className: "amt", textContent: money }));
    const sub = el("div", { className: "sub" }, el("span", { textContent: when(a.at * 1000) }), ...(st ? [el("span", { textContent: st })] : []));
    return el("div", { className: "hrow" }, top, sub);
  });
  $("lez-rows").replaceChildren(...(rows.length ? rows : [el("p", { className: "note", textContent: "Nothing yet." })]));
}

// ---- LEZ Send: to a Public/ account, through the review, signed with the name account's key ---------------------
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
  const e = epoch, r = await api("/api/wallet/lns");
  if (stale(e)) return;
  if (r.status === 401) return lockedNow();
  const j = (r.ok && r.data.job) || {};
  if (j.kind === "send" && j.state === "running") return void setTimeout(lezFollow, 3000);
  if (j.kind === "send") lezSay(j.state === "done" ? "Sent " + LEZ(j.amount) + "." : j.unsure ? j.error : "Didn't work: " + j.error,
                                j.state === "done" ? "ok" : j.unsure ? "warn" : "bad");
  home(true); lezLoad();
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

document.addEventListener("visibilitychange", () => {        // off screen: the timers stop; back: ask once, they start again
  if (document.hidden) { clearTimeout(lnsTimer); clearTimeout(lezTimer); return; }
  if ($("v-open").hidden) return;
  home(true);
  if (!$("page-settings").hidden && !$("s-lns").hidden) lnsLoad();
  if (tokSel === "lez") lezLoad();
});

window.LNS = {
  settings(unlocked, shown) { if (!unlocked) { $("s-lns").hidden = true; clearTimeout(lnsTimer); } else if (shown) lnsLoad(); },
  refresh() { if (!$("s-lns").hidden) lnsLoad(); },
  home,
  /** The phone's own name for Messages > Name: { name, running } (null when it can't be read). */
  async own() { const e = epoch, r = await api("/api/wallet/lns"); if (stale(e) || !r.ok) return null; lnsLast = r.data; const j = r.data.job || {};
    return { name: r.data.name || "", running: j.state === "running" && j.kind === "text" && j.entry === "msg" }; },
  pointMsg,
  /** A scanned LEZ account from elsewhere: LEZ's Send, with it filled in. */
  sendTo(acct) { if (!lezAcct) return openSettings("s-lns", "lns-in"); walletPick("lez", "send"); $("lez-to").value = acct; $("lez-amt").focus(); },
  // one short line for Settings' list; [text, "warn"] for something to look at
  state() {
    const d = lnsLast; if (!d) return "";
    const j = d.job || {}, f = d.flow;
    if (f && f.step === "fund" && f.short) return ["Getting " + f.name + " · needs LEZ", "warn"];
    if (f && f.step === "failed") return ["Getting " + f.name + " stopped", "warn"];
    if (f && f.step !== "done") return "Getting " + f.name;
    if (j.state === "running") return j.kind === "send" ? "Sending LEZ" : "Pointing " + j.name;
    if (!d.name) return "No name yet";
    if (d.backup_needed) return [(d.name || "No name yet") + " · back up needed", "warn"];
    return d.name || "No name yet";
  },
};
if (!$("page-settings").hidden && !$("v-open").hidden) lnsLoad();
if (!$("v-open").hidden) home(true);
})();

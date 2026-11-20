// Sending on LEZ 0.4 from this phone: the accounts of the desktop's recovery phrase, public only. Loaded after
// /net04/net04.js and before /net04/nft.js in the Android app, when the app carries the LEZ 0.4 signer
// (app/signer04.py, libnames04.so); uses index.html's globals ($, api, lockedNow, copyBtn, qrSvg, balHidden, MASK).
// - Restore: the person types the recovery phrase of their desktop Names Wallet once; the server hands it to the
//   signer on standard input and keeps only the keys made from it (the same accounts, names and NFTs as the
//   desktop). The phrase is in this page only while it is typed: the box is emptied when the request goes out, and
//   by a lock (index.html's wipePage).
// - Send (to an account, a public key or an LNS name) and Receive (the account, its QR code, and its public key for
//   a first payment), a "Get free test LEZ" button (the faucet, once per wallet). Every press says at once what it is
//   doing ("Restoring…", "Sending…", "Asking the faucet…"), then how it ended.
// - window.SIGN04 lets Collectibles (nft.js) run its jobs the same way: claiming an LNS name's NFT, receiving and
//   sending an NFT. One job at a time, followed until it ends.
// - When a transaction went out and its answer was lost, the job ends "It may have been sent. Check … before you try
//   again." (the server's words), and the press isn't offered again as it was: a send's fields are emptied, so a
//   second send has to be typed again. After the app stopped part way, the same line shows at the top.
// - "Remove the LEZ 0.4 accounts from this phone" (with the PIN): the keys made from the phrase go; also the way out
//   of a restore that stopped after the keys were written.
// - While the phrase box is in use, the Android app keeps the screen out of screenshots and recents and turns
//   autofill off (window.LogosAndroid.secureScreen); a paste into it empties the clipboard (clearClipboard).
// Private sends stay off: a phone can't make the proof ("not on this phone yet").
(() => {
  const view = $("net04"), state = $("n4-state");
  if (!view || !state || !window.NET04) return;
  const style = document.createElement("style");
  style.textContent = `#s4-box textarea{width:100%;font:inherit;color:var(--ink);background:var(--field);border:1.5px solid var(--field-line);border-radius:10px;padding:12px;min-height:96px;resize:vertical}
#s4-box textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
#s4-box h3{margin:0 0 6px;font-size:17px}.s4-f{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:10px}.s4-f .hash{flex:1 1 14em;min-width:0}
.s4-f button{min-height:44px;padding:6px 12px;font-size:14px;font-weight:550}#s4-recv .qr{display:inline-block;margin-top:10px}#s4-rm{margin-top:12px}#s4-rm-f{margin-top:10px}`;
  document.head.append(style);
  state.insertAdjacentHTML("afterend", `<div id="s4-box" hidden>
    <p class="msg bad" id="s4-unsure" role="status" hidden></p>
    <div class="card" id="s4-restore" hidden>
      <h3>Use your recovery phrase</h3>
      <p class="note" style="margin-top:0">Your LEZ 0.4 accounts are the ones your desktop Names Wallet makes from its recovery phrase. Type that phrase here once to send from them on this phone: the same accounts, names and NFTs.</p>
      <label for="s4-phrase">Recovery phrase (12 to 24 words)</label>
      <textarea id="s4-phrase" rows="3" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="400" aria-describedby="s4-phrase-n"></textarea>
      <p class="note" id="s4-phrase-n">The phrase itself isn't kept or sent anywhere: this phone keeps only the keys made from it, in this app's own storage. Anyone who has the phrase controls these accounts.</p>
      <button type="button" id="s4-restore-go" style="margin-top:10px">Restore my accounts</button>
      <p class="msg" id="s4-restore-m" role="status"></p>
    </div>
    <div id="s4-fund" hidden>
      <button type="button" id="s4-faucet">Get free test LEZ</button>
      <p class="note" id="s4-faucet-n"></p>
      <p class="msg" id="s4-faucet-m" role="status"></p>
    </div>
    <div class="card" id="s4-send" hidden>
      <h3>Send LEZ</h3>
      <label for="s4-to">To</label>
      <input id="s4-to" type="text" placeholder="Public/…, a public key, or an LNS name" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="90">
      <label for="s4-amt" style="margin-top:10px;display:block">Amount</label>
      <input id="s4-amt" type="text" inputmode="numeric" placeholder="1000" autocomplete="off" maxlength="45">
      <p class="note">Public: the network shows this account, the amount and who gets it. A first payment to an account the network hasn't seen needs its public key.</p>
      <button type="button" id="s4-send-go" style="margin-top:10px">Send</button>
      <p class="msg" id="s4-send-m" role="status"></p>
    </div>
    <div class="card" id="s4-recv" hidden>
      <h3>Receive LEZ</h3>
      <p class="note" style="margin-top:0">This phone's LEZ 0.4 account (the first of your recovery phrase, as on your desktop):</p>
      <div class="s4-f"><span class="hash" id="s4-acct"></span></div>
      <div id="s4-qr"></div>
      <p class="note">Someone paying this account for the first time needs its public key:</p>
      <div class="s4-f"><span class="hash" id="s4-pk"></span></div>
    </div>
    <p class="note" id="s4-private">Private sends and balances: not on this phone yet.</p>
    <div id="s4-rm" hidden>
      <button type="button" class="small" id="s4-rm-open" aria-expanded="false" aria-controls="s4-rm-f">Remove the LEZ 0.4 accounts from this phone</button>
      <div class="card" id="s4-rm-f" hidden>
        <p class="msg warn" id="s4-rm-why" style="margin-top:0" hidden></p>
        <p class="note" style="margin-top:0">This deletes the keys made from your recovery phrase from this phone. Your accounts, names and NFTs stay on the network and in your desktop Names Wallet; type the phrase here again to bring them back. The rest of this wallet (Logos, LEZ 0.3, your name account) isn't touched.</p>
        <label for="s4-rm-pin">Your PIN</label>
        <input id="s4-rm-pin" class="pin" type="text" inputmode="numeric" maxlength="12" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        <button type="button" id="s4-rm-go" style="margin-top:10px">Remove from this phone</button>
        <p class="msg" id="s4-rm-m" role="status"></p>
      </div>
    </div>
  </div>`);

  // the Android app's screen protection while the phrase box is in use (absent in a browser: nothing to do)
  let secured = false;
  const secure = on => {
    if (on === secured) return;
    secured = on;
    try { if (window.LogosAndroid && window.LogosAndroid.secureScreen) window.LogosAndroid.secureScreen(on); } catch (e) {}
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let gen = 0, last = null, follow = null, saidEnd = null;   // saidEnd: the end of the job a press here already showed
  const on04 = () => window.NET04.net() === "04" && !$("v-open").hidden;
  const box = $("s4-box");

  function render(v) {
    last = v;
    box.hidden = !v || !v.available || window.NET04.net() !== "04";
    const about = $("n4-about");
    if (about) about.textContent = !v || !v.available ? "Bridge test network (LEZ 0.4): read-only here. Balances are read from the network, which is reset now and then."
      : v.ready ? "Bridge test network (LEZ 0.4). Sends from this phone are public. Balances are read from the network, which is reset now and then."
      : "Bridge test network (LEZ 0.4): read-only until your accounts are restored below. Balances are read from the network, which is reset now and then.";
    const sub = document.querySelector("#n4-open-col small");      // (Collectibles' row, from nft.js)
    if (sub) sub.textContent = v && v.ready ? "NFTs and your LNS name cards" : "NFTs and your LNS name cards, view-only";
    if (!v) { $("s4-rm").hidden = true; return; }
    $("s4-restore").hidden = v.ready;
    // the keys are here (restored, or a restore that stopped part way): they can be removed, with the PIN
    $("s4-rm").hidden = !v.stored;
    const stuck = v.stored && !v.ready;
    $("s4-rm-why").hidden = !stuck;
    $("s4-rm-why").textContent = stuck ? "An earlier restore on this phone didn't finish. Remove what it left here, then restore again." : "";
    if (stuck && $("s4-rm-f").hidden) { $("s4-rm-f").hidden = false; $("s4-rm-open").setAttribute("aria-expanded", "true"); }
    // a job that may have been sent, and that no press on this page showed (the page was reloaded or locked while it
    // ran, or the app stopped): said at the top, with what it was, until the next job
    const j = v.job || {};
    const unsaid = j.unsure && j.state === "failed" && !active && j.finished !== saidEnd;
    $("s4-unsure").hidden = !unsaid;
    $("s4-unsure").textContent = !unsaid ? "" : (j.kind === "send" ? "Send of " + (j.amount || "?") + " to " + (j.to || "?")
      : j.kind === "claim" ? "Claim of " + (j.name || "a name") + "'s NFT" : j.kind === "nft_send" ? "NFT send to " + (j.to || "?") : "NFT receive") + ": " + j.error;
    // the faucet: offered until used; its last answer stays in view after that
    $("s4-fund").hidden = !v.ready || (v.faucet.used && !$("s4-faucet-m").textContent);
    $("s4-faucet").hidden = $("s4-faucet-n").hidden = v.faucet.used;
    $("s4-private").hidden = !v.ready;
    if ($("n4-private")) $("n4-private").hidden = v.ready;          // (one line about private, not two)
    if (v.ready && $("n4-na")) $("n4-na").hidden = true;            // ("restore first" is done)
    if (v.ready) {
      const fi = v.faucet_info || {};
      $("s4-faucet-n").textContent = fi.available === false ? "The faucet has nothing to give right now; try again later."
        : "Once per wallet" + (fi.amount ? ": " + Number(fi.amount).toLocaleString("en-US") + " test LEZ" : "") + ", to this phone's account. Test LEZ have no value.";
      if ($("s4-acct").textContent !== "Public/" + v.account) {
        $("s4-acct").replaceChildren("Public/" + v.account); $("s4-acct").after(copyBtn("Public/" + v.account, "Copy"));
        $("s4-pk").replaceChildren(v.public_key || "can't be read right now"); if (v.public_key) $("s4-pk").after(copyBtn(v.public_key, "Copy the key"));
      }
    } else { $("s4-send").hidden = true; $("s4-recv").hidden = true; }
  }

  async function load() {
    if (!on04()) return null;
    const g = gen, r = await api("/api/wallet/lez04");
    if (g !== gen || r.stale || $("v-open").hidden) return null;
    if (r.status === 401) { lockedNow(); return null; }
    if (r.status === 404) { render(null); return null; }
    if (r.ok) render(r.data);
    return r.ok ? r.data : null;
  }

  // One job: the button says what it is doing at once and can't be pressed twice; the line below follows the job's
  // progress (fixed texts from the server) and ends with how it went. `done(view)` runs after a job that worked.
  let active = false;              // a press is being followed: Collectibles holds its re-reads until it ends
  // A job that ends "it may have been sent" (j.unsure): `unsure()` empties what was typed, so the same press can't
  // simply be made again; without it the button stays off until the panel is drawn again.
  async function run(path, body, btn, msg, busy, doneText, done, unsure) {
    const g = gen, label = btn.textContent;
    btn.disabled = true; btn.textContent = busy; msg.className = "msg"; msg.textContent = "";
    active = true;
    const r = await api(path, body);
    if (g !== gen || r.stale || $("v-open").hidden) { active = false; return; }
    if (r.status === 401) { active = false; return lockedNow(); }
    const end = (ok, text) => { active = false; btn.disabled = false; btn.textContent = label; msg.className = ok ? "msg ok" : "msg bad"; msg.textContent = text; };
    if (!r.ok) return end(false, r.data.error || (r.status >= 400 && r.status < 500 ? "That didn't work. Nothing was sent." : "That didn't work. Check before you try again."));
    if (!r.data.job || r.data.job.state !== "running") { end(true, doneText(r.data)); if (done) done(r.data); load(); return; }
    clearTimeout(follow);
    const poll = async () => {
      if (g !== gen) { active = false; return; }
      const v = await api("/api/wallet/lez04");
      if (g !== gen || v.stale || $("v-open").hidden) { active = false; return; }
      if (v.status === 401) { active = false; return lockedNow(); }
      const j = v.ok ? v.data.job : null;
      if (j && j.state === "running") {      // the job's own words (fixed texts from the server), as a line under the button
        const t = j.progress || "starting"; msg.className = "msg"; msg.textContent = t.charAt(0).toUpperCase() + t.slice(1) + "…";
        follow = setTimeout(poll, 1500); return;
      }
      if (j && j.unsure) saidEnd = j.finished;          // (said under the button: not again at the top)
      if (v.ok) render(v.data);
      if (j && j.state === "done") { end(true, doneText(v.data)); if (done) done(v.data); }
      else if (j && j.unsure) { end(false, j.error); if (unsure) unsure(v.data); else btn.disabled = true; }
      else end(false, (j && j.error) || "It stopped. Check before trying again.");
    };
    follow = setTimeout(poll, 800);
  }

  $("s4-restore-go").addEventListener("click", async () => {
    const t = $("s4-phrase"), m = $("s4-restore-m"), b = $("s4-restore-go");
    const words = t.value.trim().split(/\s+/).filter(Boolean);
    if (words.length < 12 || words.length > 24) { m.className = "msg bad"; m.textContent = "A recovery phrase is 12 to 24 words."; return; }
    const phrase = words.join(" ").toLowerCase();
    t.value = "";                                   // out of the page as the request goes
    secure(false);
    const g = gen;
    b.disabled = true; b.textContent = "Restoring…"; m.className = "msg"; m.textContent = "Making this phone's keys from the phrase. This takes a few seconds.";
    const r = await api("/api/wallet/lez04/restore", { phrase });
    if (g !== gen || r.stale || $("v-open").hidden) return;
    b.disabled = false; b.textContent = "Restore my accounts";
    if (r.status === 401) return lockedNow();
    if (!r.ok) { m.className = "msg bad"; m.textContent = r.data.error || "The accounts couldn't be restored. Nothing was kept."; return; }
    m.className = "msg ok"; m.textContent = "Restored. This phone sends from Public/" + r.data.account + ", your desktop's first account.";
    render(r.data);
    window.NET04.reload();
  });
  const phraseBox = $("s4-phrase");
  phraseBox.addEventListener("focus", () => secure(true));
  phraseBox.addEventListener("input", () => secure(true));
  phraseBox.addEventListener("blur", () => { if (!phraseBox.value) secure(false); });
  phraseBox.addEventListener("paste", () => setTimeout(() => {
    try { if (window.LogosAndroid && window.LogosAndroid.clearClipboard) window.LogosAndroid.clearClipboard(); } catch (e) {}
  }, 0));
  // Remove: the PIN typed again; then this phone has no LEZ 0.4 accounts (the phrase card is back)
  $("s4-rm-open").addEventListener("click", () => {
    const f = $("s4-rm-f"); f.hidden = !f.hidden; $("s4-rm-open").setAttribute("aria-expanded", String(!f.hidden));
    if (!f.hidden) $("s4-rm-pin").focus();
  });
  $("s4-rm-go").addEventListener("click", async () => {
    const pin = $("s4-rm-pin"), m = $("s4-rm-m"), b = $("s4-rm-go");
    if (!/^[0-9]{6,12}$/.test(pin.value)) { m.className = "msg bad"; m.textContent = "Enter your PIN: 6 to 12 digits."; return; }
    const g = gen;
    b.disabled = true; b.textContent = "Removing…"; m.className = "msg"; m.textContent = "";
    const r = await api("/api/wallet/lez04/remove", { pin: pin.value });
    pin.value = "";
    if (g !== gen || r.stale || $("v-open").hidden) return;
    b.disabled = false; b.textContent = "Remove from this phone";
    if (r.status === 401) return lockedNow();
    if (!r.ok) { m.className = "msg bad"; m.textContent = r.data.error || "They couldn't be removed. Try again."; return; }
    $("s4-rm-f").hidden = true; $("s4-rm-open").setAttribute("aria-expanded", "false");
    $("s4-restore-m").className = "msg ok";
    $("s4-restore-m").textContent = "Removed. This phone has no LEZ 0.4 accounts now. Type your recovery phrase again to bring them back.";
    for (const id of ["s4-acct", "s4-pk", "s4-qr", "s4-send-m", "s4-faucet-m"]) $(id).replaceChildren();
    for (const x of box.querySelectorAll(".s4-f button")) x.remove();
    render(r.data);
    window.NET04.reload();
  });
  $("s4-faucet").addEventListener("click", () => run("/api/wallet/lez04/faucet", {}, $("s4-faucet"), $("s4-faucet-m"), "Asking the faucet…",
    v => (v.amount ? Number(v.amount).toLocaleString("en-US") + " test LEZ" : "Test LEZ") + " sent to this phone's account. The balance shows them in a moment.",
    () => setTimeout(window.NET04.reload, 2000)));
  $("s4-send-go").addEventListener("click", () => {
    const to = $("s4-to").value.trim(), amount = $("s4-amt").value.trim().replace(/[,_\s]/g, ""), m = $("s4-send-m");
    if (!to) { m.className = "msg bad"; m.textContent = "Who gets it? Paste their account, their public key, or type their LNS name."; return; }
    if (!/^[0-9]+$/.test(amount) || /^0+$/.test(amount)) { m.className = "msg bad"; m.textContent = "Enter an amount above 0, in digits."; return; }
    run("/api/wallet/lez04/send", { to, amount }, $("s4-send-go"), m, "Sending…",
      () => "Sent " + Number(amount).toLocaleString("en-US") + " to " + to + ". It is in a block.",
      () => { $("s4-to").value = ""; $("s4-amt").value = ""; window.NET04.reload(); },
      () => { $("s4-to").value = ""; $("s4-amt").value = ""; window.NET04.reload(); });
  });

  // Send / Receive on the Wallet (net04.js's buttons): the panels, once the accounts are restored
  function panel(which) {
    if (!last || !last.ready) return false;
    const s = which === "send", show = s ? $("s4-send") : $("s4-recv"), other = s ? $("s4-recv") : $("s4-send");
    other.hidden = true; show.hidden = !show.hidden;
    if (!s && !show.hidden && last.account) qrSvg("Public/" + last.account).then(q => { if (!show.hidden) $("s4-qr").replaceChildren(q); }).catch(() => {});
    if (!show.hidden) show.scrollIntoView({ block: "nearest" });
    return true;
  }

  function lock() {
    gen++; clearTimeout(follow); last = null; active = false;
    for (const id of ["s4-restore-m", "s4-faucet-m", "s4-send-m", "s4-acct", "s4-pk", "s4-qr", "s4-rm-m", "s4-unsure"]) $(id).replaceChildren();
    for (const b of box.querySelectorAll(".s4-f button")) b.remove();
    for (const id of ["s4-phrase", "s4-to", "s4-amt", "s4-rm-pin"]) $(id).value = "";
    $("s4-send").hidden = $("s4-recv").hidden = true; $("s4-rm").hidden = $("s4-rm-f").hidden = $("s4-unsure").hidden = true; box.hidden = true;
    secure(false);
  }
  window.SIGN04 = { load, run, lock, panel, running: () => active, ready: () => !!(last && last.ready), available: () => !!(last && last.available), view: () => last, render };
})();

// The Wallet's LEZ 0.4 part (the network at lez.nameswallet.app, or another LEZ 0.4 entered in Settings), below the
// Logos coins. Loaded by index.html in the Android app; uses its globals ($, api, lockedNow, openSettings, balHidden,
// MASK).
// - The phone's own LEZ 0.4 account (once its LEZ 0.4 wallet is set up: /net04/sign04.js) and the watched addresses
//   (view-only), read by the server (app/lez04.py) at most every 30 s and only while the Wallet itself is on screen
//   (once more after an unlock or a change of what is watched). Send and Receive open the signer's panels.
// - Settings > Network (#s-net): which LEZ 0.4 network is in use (ours, or one entered by RPC URL and chain id, which
//   the server switches to only if that RPC reports that chain id), what it sees, and the addresses watched there.
// - A lock reloads the page (index.html's lockedNow); NET04.lock() empties all of it first, the NFTs screen too
//   (NFT04.lock, /net04/nft.js).
(() => {
  const view = $("net04"), sec = $("s-net");
  if (!view || !sec) return;
  let timer = null, busy = false;
  let gen = 0;                   // moves on every lock: an answer to a request made before it renders nothing
  let host = "lez.nameswallet.app";

  sec.insertAdjacentHTML("beforeend", `
    <p class="note" id="nw-asks">The wallet asks <span id="nw-host">lez.nameswallet.app</span> about this phone's LEZ 0.4 account, the addresses you watch, their NFTs and the LNS names it looks up; it sees them and your IP address.</p>
    <div id="n4-net-box">
      <p class="note" id="n4-net-now"></p>
      <button type="button" class="small" id="n4-net-ours" hidden>Back to our LEZ 0.4</button>
      <details id="n4-net-other"><summary style="min-height:44px;display:flex;align-items:center">Another LEZ 0.4 network</summary>
        <p class="note">For a new or reset LEZ 0.4: its RPC URL and its chain id. The wallet switches only if that RPC reports this chain id.</p>
        <label for="n4-net-url">RPC URL</label>
        <input id="n4-net-url" type="url" placeholder="https://…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="200">
        <label for="n4-net-id">Chain id</label>
        <input id="n4-net-id" class="mono" type="text" placeholder="64 hexadecimal characters" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="70">
        <button type="button" id="n4-net-set" style="margin-top:10px">Check and switch</button>
      </details>
      <p class="msg" id="n4-net-m" role="status"></p>
    </div>
    <div id="n4-watch-box">
      <label for="n4-watch">Watch an address (view-only)</label>
      <div class="pwrow"><input id="n4-watch" type="text" placeholder="a public account id" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="80"><button type="button" id="n4-add">Watch</button></div>
      <p class="note">Shows on the Wallet what an account holds on LEZ 0.4, such as your Basecamp account's bridged coins. Watching can't move anything. There is no checksum: compare the id shown back with yours.</p>
      <p class="msg" id="n4-watch-m" role="status"></p>
      <div id="n4-watched"></div>
    </div>`);
  sec.hidden = false;
  view.innerHTML = `
    <div class="tok-head n4-head"><span>LEZ 0.4</span></div>
    <p class="note" id="n4-about">LEZ 0.4. Balances are read from the network, which is reset now and then.</p>
    <p class="msg warn" id="n4-state" role="status" hidden></p>
    <div id="n4-accts"></div>
    <p class="note" id="n4-private"></p>
    <div class="row" style="margin-top:10px"><button type="button" id="n4-send">Send</button><button type="button" id="n4-recv">Receive</button></div>
    <button type="button" class="notice" id="n4-na" role="status" hidden>Set up your LEZ 0.4 wallet first (above).</button>`;
  view.hidden = false;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const hhmm = t => {            // the time, and the date too when it isn't today
    try {
      const d = new Date(t * 1000), tm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return d.toDateString() === new Date().toDateString() ? tm : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + tm;
    } catch (e) { return ""; }
  };
  const amt = v => (typeof balHidden !== "undefined" && balHidden) ? MASK : v;

  function render(d) {
    const st = $("n4-state");
    const says = [d.reset, d.unreachable && (d.unreachable + (d.read_at ? " Last read " + hhmm(d.read_at) + "." : "")), d.tokens_error].filter(Boolean);
    st.hidden = !says.length; st.textContent = says.join(" ");
    $("n4-private").textContent = d.private || "";
    const box = $("n4-accts"); box.replaceChildren();
    if (!d.accounts.length) box.append(el("p", "note", window.SIGN04 && window.SIGN04.available()
      ? "No account to show yet. Set up your LEZ 0.4 wallet (above), or watch an address in Settings → Network."
      : "No account to show yet. Watch an address in Settings → Network."));
    for (const a of d.accounts) {
      const c = el("div", "card n4-acct");
      c.append(el("p", "n4-who", a.own ? "This phone's LEZ account" : "Watched, view-only"));
      const id = el("p", "hash", a.id); id.title = a.id; c.append(id);
      if (a.status === "ok") {
        c.append(el("p", "n4-amt", "LEZ: " + amt(a.native)));
        for (const t of a.tokens || []) c.append(el("p", "n4-amt", t.symbol + ": " + amt(t.amount) + (t.name ? "  (" + t.name + ")" : "")));
        if (a.other_tokens) c.append(el("p", "note", a.other_tokens + " other token(s), not bridged tokens: not shown."));
      } else if (a.status === "nothing") c.append(el("p", "n4-amt", "Nothing on this network"));
      else if (a.status === "unreadable") c.append(el("p", "msg bad", "Can't read this account."));
      else c.append(el("p", "note", "Not read yet."));
      if (a.at) c.append(el("p", "note", "As of " + hhmm(a.at) + ", LEZ 0.4"));
      box.append(c);
    }
    watchedList(d.accounts.filter(a => !a.own).map(a => a.id));
  }

  // Settings > Network: which LEZ 0.4 network is in use
  const hostOf = u => { try { return new URL(u).host; } catch (e) { return u; } };
  function network(nw) {
    if (!nw) return;
    host = hostOf(nw.rpc_url) || "lez.nameswallet.app";
    $("nw-host").textContent = host;
    $("n4-net-now").textContent = nw.custom ? "In use: " + host + ", chain id " + nw.chain_id.slice(0, 8) + "…" + nw.chain_id.slice(-4) + "."
      : "In use: our LEZ 0.4 (" + host + ").";
    $("n4-net-ours").hidden = !nw.custom;
    if (typeof stRows === "function") stRows();
  }
  let netRead = false;             // the network in use has been read since this page was unlocked
  async function readNetwork() {
    if (netRead || $("v-open").hidden) return;
    const g = gen, r = await api("/api/wallet/net04/network");
    if (g !== gen || r.stale || $("v-open").hidden) return;
    if (r.status === 401) return lockedNow();
    if (!r.ok) return;
    netRead = true;
    network(r.data.network);
  }
  async function setNetwork(body, btn) {
    const m = $("n4-net-m"), g = gen, label = btn.textContent;
    btn.disabled = true; btn.textContent = "Checking…"; m.className = "msg"; m.textContent = "";
    const r = await api("/api/wallet/net04/network", body);
    if (g !== gen || r.stale || $("v-open").hidden) return;
    btn.disabled = false; btn.textContent = label;
    if (r.status === 401) return lockedNow();
    if (!r.ok) { m.className = "msg bad"; m.textContent = r.data.error || "That didn't work. Nothing was changed."; return; }
    network(r.data);
    m.className = "msg ok"; m.textContent = r.data.custom ? "Switched. LEZ 0.4 is read from " + hostOf(r.data.rpc_url) + " now." : "Back on our LEZ 0.4.";
    $("n4-net-url").value = ""; $("n4-net-id").value = ""; $("n4-net-other").open = false;
    $("n4-accts").replaceChildren();
    load(true);
  }

  // Settings > Network: the watched addresses, each with Stop watching
  function watchedList(ids) {
    const box = $("n4-watched"); box.replaceChildren();
    if (ids.length) box.append(el("p", "note", "Watched on LEZ 0.4:"));
    for (const i of ids) {
      const r = el("div", "n4-watched"), id = el("span", "hash", i); id.title = i;
      const rm = el("button", null, "Stop watching"); rm.type = "button";
      rm.addEventListener("click", async () => {
        rm.disabled = true;
        const g = gen; const res = await api("/api/wallet/net04/watch", { remove: i });
        if (g !== gen || res.stale) return;
        if (res.status === 401) return lockedNow();
        if (res.ok) watchedList(res.data.watched || []);
        load(true);
      });
      r.append(id, rm); box.append(r);
    }
  }

  // the Wallet itself is on screen (not locked, not Settings, not another screen of the bar)
  const onScreen = () => !$("v-open").hidden && !$("page-main").hidden;

  // `once`: a read the person asked for (an unlock, a change of what is watched), from Settings too
  async function load(once = false) {
    if (busy || $("v-open").hidden || (!once && !onScreen())) return;
    busy = true;
    const g = gen;
    try {
      const r = await api("/api/wallet/net04");
      if (g !== gen || r.stale || $("v-open").hidden) return;     // locked or left meanwhile: nothing
      if (r.status === 401) return lockedNow();
      if (r.ok) render(r.data);
      else $("n4-state").hidden = false, $("n4-state").textContent = r.data.error || "Can't read LEZ 0.4 now.";
      if (window.SIGN04) await window.SIGN04.load();
    } finally { busy = false; }
  }

  // after an unlock: the network in use, then the view, then every 30 s while the Wallet is on screen
  let started = false;
  function start() {
    if (started || $("v-open").hidden) return;
    started = true;
    readNetwork();
    load(true);
    // the first look starts a read in the background; its answer comes a moment later: read it then, if the Wallet or
    // Settings > Network is still on screen
    setTimeout(() => { if (onScreen() || (!$("page-settings").hidden && sec.offsetParent !== null)) load(true); }, 3000);
    clearInterval(timer); timer = setInterval(tick, 30000);
  }
  function tick() {             // only while the Wallet shows and the page is visible
    if (!started) return void start();
    if (onScreen() && document.visibilityState === "visible") load();
  }

  // a lock: nothing of the 0.4 view stays in the page, and an answer still on its way writes nothing
  function lock() {
    gen++;
    if (window.NFT04) window.NFT04.lock();
    if (window.SIGN04) window.SIGN04.lock();
    for (const id of ["n4-accts", "n4-watch-m", "n4-state", "n4-private", "n4-watched", "n4-net-m", "n4-net-now"]) $(id).replaceChildren();
    $("n4-watch-m").className = "msg"; $("n4-net-m").className = "msg"; $("n4-state").hidden = true; $("n4-na").hidden = true;
    for (const id of ["n4-watch", "n4-net-url", "n4-net-id"]) $(id).value = "";
    clearInterval(timer); timer = null; started = false; netRead = false;
  }

  $("n4-net-ours").addEventListener("click", () => setNetwork({ ours: true }, $("n4-net-ours")));
  $("n4-net-set").addEventListener("click", () => {
    const u = $("n4-net-url").value.trim(), c = $("n4-net-id").value.trim(), m = $("n4-net-m");
    if (!u || !c) { m.className = "msg bad"; m.textContent = "Enter both the RPC URL and the chain id."; return; }
    setNetwork({ rpc_url: u, chain_id: c }, $("n4-net-set"));
  });
  // Send / Receive: the signer's panels once the wallet is set up; until then, what stands in the way
  const na = which => {
    if (window.SIGN04 && window.SIGN04.panel(which)) { $("n4-na").hidden = true; return; }
    $("n4-na").textContent = window.SIGN04 && window.SIGN04.available() ? "Set up your LEZ 0.4 wallet first (above)."
      : "This build of the app can't send on LEZ 0.4.";
    $("n4-na").hidden = false;
  };
  $("n4-send").addEventListener("click", () => na("send"));
  $("n4-recv").addEventListener("click", () => na("recv"));
  $("n4-na").addEventListener("click", () => { if (window.SIGN04 && window.SIGN04.setup) window.SIGN04.setup(); });
  $("n4-add").addEventListener("click", async () => {
    const m = $("n4-watch-m"), v = $("n4-watch").value.trim();
    if (!v) return;
    const g = gen;
    const r = await api("/api/wallet/net04/watch", { add: v });
    if (g !== gen || r.stale || $("v-open").hidden) return;      // answered after a lock: it writes nothing
    if (r.status === 401) return lockedNow();
    if (!r.ok) { m.className = "msg bad"; m.textContent = r.data.error || "That isn't a public account id."; return; }
    m.className = "msg"; m.replaceChildren("Watching " + r.data.short + " (view-only). Check it is the id you meant: ", el("span", "hash", r.data.id));
    $("n4-watch").value = "";
    watchedList(r.data.watched || []);
    load(true);
  });
  document.addEventListener("visibilitychange", tick);
  const seen = new MutationObserver(tick);              // after an unlock, and back from Settings or another screen
  seen.observe($("v-open"), { attributes: true, attributeFilter: ["hidden"] });
  seen.observe($("page-main"), { attributes: true, attributeFilter: ["hidden"] });
  // net() stays for the files that ask it (LEZ 0.4 is the only network now)
  window.NET04 = { lock, state: () => "LEZ 0.4 · " + host, net: () => "04", reload: () => load(true) };
  start();
})();

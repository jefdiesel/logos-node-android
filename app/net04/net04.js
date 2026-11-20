// The Wallet on two networks: LEZ 0.3, the public Logos testnet (everything the wallet does), and LEZ 0.4, the bridge
// test network (read-only here). Loaded by index.html in the Android app; uses its globals ($, api, lockedNow,
// openSettings, balHidden, MASK).
// - The choice is made in Settings > Network (#s-net): the switch, each network's full name, what LEZ 0.4 tells its
//   endpoint, the addresses watched there, and the LEZ 0.4 network itself: ours (lez.nameswallet.app) or one entered
//   by RPC URL and chain id, which the server switches to only if that RPC reports that chain id. LEZ 0.4 is the
//   default; a pick of LEZ 0.3 is kept by the server (GET/POST /api/wallet/net04/choice) and comes back after a lock.
// - The Wallet shows one line above the token list naming the network on screen (tap: Settings > Network). On
//   LEZ 0.4 the token list gives way to the phone's own LEZ account and the watched addresses (view-only), read by
//   the server (app/lez04.py) at most every 30 s and only while the Wallet itself is on screen (once more when the
//   person picks LEZ 0.4 or changes what is watched). Nothing here sends: with the LEZ 0.4 signer in the app
//   (/net04/sign04.js) Send and Receive open its panels once the accounts are restored from the recovery phrase;
//   without it they say they aren't available.
// - A lock reloads the page (index.html's lockedNow); NET04.lock() empties all of it first, Collectibles too
//   (NFT04.lock, /net04/nft.js). After the unlock the kept choice is read again before anything shows.
(() => {
  const line = $("net-sw"), view = $("net04"), sec = $("s-net");
  if (!line || !view || !sec) return;
  const NAMES = { "03": "public Logos testnet", "04": "bridge test network" };
  const LABEL = n => "LEZ " + (n === "04" ? "0.4" : "0.3");
  let net = "04";                // LEZ 0.4 by default; the person's pick of LEZ 0.3 is read from the server once unlocked
  let chosen = false;            // the kept choice has been read since this page loaded
  let timer = null, busy = false;
  let gen = 0;                   // moves on every lock: an answer to a request made before it renders nothing

  const CHEV = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  line.innerHTML = `<button type="button" class="net-line" id="net-line"><span id="net-line-t"></span>${CHEV}</button>`;
  sec.insertAdjacentHTML("beforeend", `
    <div class="netsw">
      <div class="seg" role="radiogroup" aria-labelledby="h-s-net">
        <button type="button" role="radio" id="nw-03" aria-checked="true">LEZ 0.3</button>
        <button type="button" role="radio" id="nw-04" aria-checked="false">LEZ 0.4</button>
      </div>
      <small id="nw-name"></small>
    </div>
    <p class="note" id="nw-asks">On LEZ 0.4 the wallet asks <span id="nw-host">lez.nameswallet.app</span> about this phone's account, the addresses you watch and their NFTs; it sees them and your IP address.</p>
    <div id="n4-net-box" hidden>
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
    <div id="n4-watch-box" hidden>
      <label for="n4-watch">Watch an address (view-only)</label>
      <div class="pwrow"><input id="n4-watch" type="text" placeholder="a public account id" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="80"><button type="button" id="n4-add">Watch</button></div>
      <p class="note">Shows on the Wallet what an account holds on the bridge test network, such as your Basecamp account's bridged coins. Watching can't move anything. There is no checksum: compare the id shown back with yours.</p>
      <p class="msg" id="n4-watch-m" role="status"></p>
      <div id="n4-watched"></div>
    </div>`);
  sec.hidden = false;
  view.innerHTML = `
    <p class="note" id="n4-about">Bridge test network (LEZ 0.4): read-only here. Balances are read from the network, which is reset now and then.</p>
    <p class="msg warn" id="n4-state" role="status" hidden></p>
    <div id="n4-accts"></div>
    <p class="note" id="n4-private"></p>
    <div class="row" style="margin-top:10px"><button type="button" id="n4-send">Send</button><button type="button" id="n4-recv">Receive</button></div>
    <button type="button" class="notice" id="n4-na" role="status" hidden>Not available on the bridge test network yet. To send or receive, switch to LEZ 0.3 in Settings → Network.</button>`;

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
      : "No account to show yet. Watch an address in Settings → Network, or make a name account (Settings → Your name)."));
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
      if (a.at) c.append(el("p", "note", "As of " + hhmm(a.at) + ", bridge test network"));
      box.append(c);
    }
    watchedList(d.accounts.filter(a => !a.own).map(a => a.id));
  }

  // Settings > Network: which LEZ 0.4 network is in use
  const hostOf = u => { try { return new URL(u).host; } catch (e) { return u; } };
  function network(nw) {
    if (!nw) return;
    $("nw-host").textContent = hostOf(nw.rpc_url) || "lez.nameswallet.app";
    $("n4-net-now").textContent = nw.custom ? "In use: " + hostOf(nw.rpc_url) + ", chain id " + nw.chain_id.slice(0, 8) + "…" + nw.chain_id.slice(-4) + "."
      : "In use: our LEZ 0.4 (" + hostOf(nw.rpc_url) + ").";
    $("n4-net-ours").hidden = !nw.custom;
  }
  // the kept choice, once per page load, after the unlock: until it is read the 0.4 view asks nothing
  async function readChoice() {
    if (chosen || $("v-open").hidden) return;
    const g = gen, r = await api("/api/wallet/net04/choice");
    if (g !== gen || r.stale || $("v-open").hidden) return;
    if (r.status === 401) return lockedNow();
    if (!r.ok) return;
    chosen = true;
    network(r.data.network);
    setNet(r.data.net, false);
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
    if (window.NFT04) window.NFT04.show(false);
    load(true);
  }

  // Settings > Network: the watched addresses, each with Stop watching
  function watchedList(ids) {
    const box = $("n4-watched"); box.replaceChildren();
    if (ids.length) box.append(el("p", "note", "Watched on the bridge test network:"));
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

  // the Wallet itself is on screen (not locked, not Settings, not Messages)
  const onScreen = () => chosen && net === "04" && !$("v-open").hidden && !$("page-main").hidden && !(window.NFT04 && window.NFT04.open());

  // `once`: a read the person asked for (picked LEZ 0.4, changed what is watched), from Settings too
  async function load(once = false) {
    if (busy || !chosen || net !== "04" || $("v-open").hidden || (!once && !onScreen())) return;
    busy = true;
    const g = gen;
    try {
      const r = await api("/api/wallet/net04");
      if (g !== gen || r.stale || net !== "04" || $("v-open").hidden) return;     // locked or left meanwhile: nothing
      if (r.status === 401) return lockedNow();
      if (r.ok) render(r.data);
      else $("n4-state").hidden = false, $("n4-state").textContent = r.data.error || "Can't read the bridge test network now.";
      if (window.SIGN04) await window.SIGN04.load();
    } finally { busy = false; }
  }

  function tick() {             // only while the Wallet shows LEZ 0.4 and the page is visible
    if (!chosen) return void readChoice();
    if (onScreen() && document.visibilityState === "visible") load();
  }

  // a lock: nothing of the 0.4 view stays in the page, and an answer still on its way writes nothing
  function lock() {
    gen++;
    if (window.NFT04) window.NFT04.lock();
    if (window.SIGN04) window.SIGN04.lock();
    for (const id of ["n4-accts", "n4-watch-m", "n4-state", "n4-private", "n4-watched", "n4-net-m", "n4-net-now"]) $(id).replaceChildren();
    $("n4-watch-m").className = "msg"; $("n4-net-m").className = "msg"; $("n4-state").hidden = true;
    for (const id of ["n4-watch", "n4-net-url", "n4-net-id"]) $(id).value = "";
    chosen = false;
  }

  // `keep`: the person picked it here (the server keeps it); false when it comes from the server
  function setNet(n, keep = true) {
    const was = net;
    net = n === "04" ? "04" : "03";
    $("nw-03").setAttribute("aria-checked", String(net === "03"));
    $("nw-04").setAttribute("aria-checked", String(net === "04"));
    $("nw-name").textContent = NAMES[net];
    $("net-line-t").replaceChildren(el("b", null, LABEL(net)), " · " + NAMES[net]);
    $("net-line").setAttribute("aria-label", "Network: " + LABEL(net) + ", " + NAMES[net] + ". Change it in Settings");
    $("v-open").classList.toggle("on04", net === "04");
    view.hidden = net !== "04";
    $("n4-watch-box").hidden = net !== "04";
    $("n4-net-box").hidden = net !== "04";
    if (net !== "04" && window.NFT04) window.NFT04.show(false);
    if (window.SIGN04 && net !== "04") window.SIGN04.render(null);
    if (keep && chosen && was !== net) api("/api/wallet/net04/choice", { net });
    clearInterval(timer); timer = null;
    $("n4-na").hidden = true;
    if (net === "04" && chosen) {
      if (was !== "04" || !keep) {
        load(true);
        // the first look starts a read in the background; its answer comes a moment later: read it then, if the
        // Wallet or Settings > Network is still on screen (not after moving on to Messages or another page)
        setTimeout(() => { if (onScreen() || (!$("page-settings").hidden && sec.offsetParent !== null)) load(true); }, 3000);
      }
      timer = setInterval(tick, 30000);
    } else { $("n4-watched").replaceChildren(); $("n4-watch-m").textContent = ""; }
    if (typeof stRows === "function") stRows();
  }

  $("net-line").addEventListener("click", () => openSettings("s-net"));
  $("nw-03").addEventListener("click", () => setNet("03"));
  $("nw-04").addEventListener("click", () => setNet("04"));
  $("n4-net-ours").addEventListener("click", () => setNetwork({ ours: true }, $("n4-net-ours")));
  $("n4-net-set").addEventListener("click", () => {
    const u = $("n4-net-url").value.trim(), c = $("n4-net-id").value.trim(), m = $("n4-net-m");
    if (!u || !c) { m.className = "msg bad"; m.textContent = "Enter both the RPC URL and the chain id."; return; }
    setNetwork({ rpc_url: u, chain_id: c }, $("n4-net-set"));
  });
  // Send / Receive: the signer's panels once the accounts are restored; until then, what stands in the way
  const na = which => {
    if (window.SIGN04 && window.SIGN04.panel(which)) { $("n4-na").hidden = true; return; }
    $("n4-na").textContent = window.SIGN04 && window.SIGN04.available() ? "Set up your LEZ 0.4 wallet first (above)."
      : "Not available on the bridge test network yet. To send or receive, switch to LEZ 0.3 in Settings → Network.";
    $("n4-na").hidden = false;
  };
  $("n4-send").addEventListener("click", () => na("send"));
  $("n4-recv").addEventListener("click", () => na("recv"));
  $("n4-na").addEventListener("click", () => {        // the line says where to go: a tap goes there
    if (window.SIGN04 && window.SIGN04.available()) { if (window.SIGN04.setup) window.SIGN04.setup(); }
    else openSettings("s-net");
  });
  $("n4-add").addEventListener("click", async () => {
    const m = $("n4-watch-m"), v = $("n4-watch").value.trim();
    if (!v || net !== "04") return;
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
  const seen = new MutationObserver(tick);              // after an unlock, and back from Settings or Messages
  seen.observe($("v-open"), { attributes: true, attributeFilter: ["hidden"] });
  seen.observe($("page-main"), { attributes: true, attributeFilter: ["hidden"] });
  window.NET04 = { lock, state: () => LABEL(net) + " · " + NAMES[net], net: () => net, reload: () => load(true) };
  setNet(net, false);
  readChoice();
})();

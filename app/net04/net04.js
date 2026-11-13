// The Wallet on two networks: LEZ 0.3, the public Logos testnet (everything the wallet does), and LEZ 0.4, the bridge
// test network (read-only here). Loaded by index.html in the Android app; uses its globals ($, api, lockedNow,
// balHidden, MASK). The switch is above the token list; LEZ 0.3 is the default. On LEZ 0.4 the page shows the phone's
// own LEZ account and the addresses the person watches (view-only), read by the server (app/lez04.py) at most every
// 30 s and only while this view is on screen (the Wallet, not Settings or Messages). Nothing here sends: Send and
// Receive say they aren't available there. A lock empties the view, goes back to LEZ 0.3 and drops any answer still
// on its way (index.html's show() calls NET04.lock()).
(() => {
  const sw = $("net-sw"), view = $("net04");
  if (!sw || !view) return;
  const NAMES = { "03": "public Logos testnet", "04": "bridge test network" };
  let net = "03";                // LEZ 0.3 every time the page opens
  let timer = null, busy = false;
  let gen = 0;                   // moves on every lock: an answer to a request made before it renders nothing

  sw.innerHTML = `
    <div class="netsw">
      <div class="seg" role="radiogroup" aria-label="Network">
        <button type="button" role="radio" id="nw-03" aria-checked="true">LEZ 0.3</button>
        <button type="button" role="radio" id="nw-04" aria-checked="false">LEZ 0.4</button>
      </div>
      <small id="nw-name"></small>
    </div>
    <p class="note" id="nw-asks">Choosing LEZ 0.4 asks lez.nameswallet.app about this phone's account and the addresses you watch; it sees them and your IP address.</p>`;
  view.innerHTML = `
    <p class="note" id="n4-about">Bridge test network (LEZ 0.4): read-only here. Balances are read from the network, which is reset now and then.</p>
    <p class="msg warn" id="n4-state" role="status" hidden></p>
    <div id="n4-accts"></div>
    <p class="note" id="n4-private"></p>
    <div class="row" style="margin-top:10px"><button type="button" id="n4-send">Send</button><button type="button" id="n4-recv">Receive</button></div>
    <p class="msg" id="n4-na" role="status" hidden>Not available on the bridge test network yet.</p>
    <label for="n4-watch">Watch an address (view-only)</label>
    <div class="pwrow"><input id="n4-watch" type="text" placeholder="a public account id" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="80"><button type="button" id="n4-add">Watch</button></div>
    <p class="note">Shows what an account holds on the bridge test network, such as your Basecamp account's bridged coins. Watching can't move anything. There is no checksum: compare the id shown back with yours.</p>
    <p class="msg" id="n4-watch-m" role="status"></p>`;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const hhmm = t => { try { return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };
  const amt = v => (typeof balHidden !== "undefined" && balHidden) ? MASK : v;

  function render(d) {
    const st = $("n4-state");
    const says = [d.reset, d.unreachable && (d.unreachable + (d.read_at ? " Last read " + hhmm(d.read_at) + "." : "")), d.tokens_error].filter(Boolean);
    st.hidden = !says.length; st.textContent = says.join(" ");
    $("n4-private").textContent = d.private || "";
    const box = $("n4-accts"); box.replaceChildren();
    if (!d.accounts.length) box.append(el("p", "note", "No account to show yet. Watch an address below, or make a name account (Settings → Your name)."));
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
      if (!a.own) {
        const rm = el("button", null, "Stop watching"); rm.type = "button";
        rm.addEventListener("click", async () => { const g = gen; const r = await api("/api/wallet/net04/watch", { remove: a.id }); if (g !== gen) return; if (r.status === 401) return lockedNow(); load(); });
        c.append(rm);
      }
      box.append(c);
    }
  }

  // the 0.4 view is on screen: the Wallet itself is showing (not locked, not Settings, not Messages)
  const onScreen = () => net === "04" && !$("v-open").hidden && !$("page-main").hidden;

  async function load() {
    if (busy || !onScreen()) return;
    busy = true;
    const g = gen;
    try {
      const r = await api("/api/wallet/net04");
      if (g !== gen || !onScreen()) return;             // locked or left meanwhile: it shows nothing
      if (r.status === 401) return lockedNow();
      if (r.ok) render(r.data);
      else $("n4-state").hidden = false, $("n4-state").textContent = r.data.error || "Can't read the bridge test network now.";
    } finally { busy = false; }
  }

  function tick() {             // only while the 0.4 view is on screen and the page is visible
    if (onScreen() && document.visibilityState === "visible") load();
  }

  // a lock: nothing of the 0.4 view stays in the page, and an answer still on its way writes nothing
  function lock() {
    gen++;
    for (const id of ["n4-accts", "n4-watch-m", "n4-state", "n4-private"]) $(id).replaceChildren();
    $("n4-watch-m").className = "msg"; $("n4-state").hidden = true; $("n4-watch").value = "";
    setNet("03");
  }

  function setNet(n) {
    net = n === "04" ? "04" : "03";
    $("nw-03").setAttribute("aria-checked", String(net === "03"));
    $("nw-04").setAttribute("aria-checked", String(net === "04"));
    $("nw-name").textContent = NAMES[net];
    $("v-open").classList.toggle("on04", net === "04");
    view.hidden = net !== "04";
    clearInterval(timer); timer = null;
    $("n4-na").hidden = true;
    if (net === "04") {
      load();
      setTimeout(load, 3000);   // the first look starts a read in the background; its answer comes a moment later
      timer = setInterval(tick, 30000);
    }
  }

  $("nw-03").addEventListener("click", () => setNet("03"));
  $("nw-04").addEventListener("click", () => setNet("04"));
  $("n4-send").addEventListener("click", () => { $("n4-na").hidden = false; });
  $("n4-recv").addEventListener("click", () => { $("n4-na").hidden = false; });
  $("n4-add").addEventListener("click", async () => {
    const m = $("n4-watch-m"), v = $("n4-watch").value.trim();
    if (!v) return;
    const g = gen;
    const r = await api("/api/wallet/net04/watch", { add: v });
    if (g !== gen || $("v-open").hidden) return;      // answered after a lock: it writes nothing
    if (r.status === 401) return lockedNow();
    if (!r.ok) { m.className = "msg bad"; m.textContent = r.data.error || "That isn't a public account id."; return; }
    m.className = "msg"; m.textContent = "Watching " + r.data.short + " (view-only). Check it is the id you meant: " + r.data.id;
    $("n4-watch").value = "";
    load();
  });
  document.addEventListener("visibilitychange", tick);
  const seen = new MutationObserver(tick);              // after an unlock, and back from Settings or Messages
  seen.observe($("v-open"), { attributes: true, attributeFilter: ["hidden"] });
  seen.observe($("page-main"), { attributes: true, attributeFilter: ["hidden"] });
  window.NET04 = { lock };
  setNet(net);
})();

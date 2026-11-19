// Collectibles on LEZ 0.4, read-only, and the LNS name card. Loaded after /net04/net04.js in the Android app.
// - The NFTs the wallet's LEZ 0.4 accounts hold (this phone's LEZ account and the watched addresses) under the NFT
//   programs listed for the network, read by the server (app/lez04.py, getAccountView per account per program) at most
//   every 30 s and only while Collectibles is on screen. Words and states follow the desktop wallet's Collectibles page
//   (basecamp/qml/nft.mjs of the names project). Nothing here sends: no Receive, Send, Print or Burn on the phone yet,
//   and no collection image is ever fetched.
// - An LNS name's NFT sits in an account only the LNS registry controls, so it is read from the name's record
//   (lez04.read_deed), never found by a holdings scan. Its card is drawn here, on the phone, with the holder's own
//   name (design: LNS name card, approved 2026-11-19): forest green, Gloock for the name, λ top right, a yellow rule,
//   the η mark and nameswallet.app bottom right. The fonts are bundled (net04/fonts, OFL); nothing loads from the web.
// - A lock empties all of it, the drawn cards too (NFT04.lock, called by net04.js).
// The pure parts (CORE) are checked by tests/nft04_test.mjs without a browser.
(() => {
  const CORE = {};
  const ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  /// An ID shortened in the middle for a row; the full one is copied.
  CORE.idShown = id => { const t = String(id || ""); return t.length > 14 ? t.slice(0, 6) + "…" + t.slice(-4) : t; };
  /// An account as a row shows it: "Public CCVd76…pKnk".
  CORE.accountShown = id => "Public " + CORE.idShown(id);
  /// The token, as the program has it: there is no serial number, only the master or a copy.
  CORE.tokenLine = row => {
    if (!row) return "";
    if (row.state === "master") {
      let rights = 0; try { rights = Number(BigInt(row.print_balance || "0")); } catch (e) {}
      const prints = Math.max(0, rights - 1);
      return "Master · " + (prints === 0 ? "no prints left" : prints === 1 ? "can print 1 more copy" : "can print " + prints + " more copies");
    }
    return row.state === "copy" ? "Copy" : "";
  };
  /// A collection's title, never empty: its name, or that it can't be read, with its ID.
  CORE.collectionTitle = (collection, definition) =>
    collection && typeof collection.name === "string" && collection.name.trim() !== "" ? collection.name : "Unreadable collection " + CORE.idShown(definition);
  /// Every field the program stores for a collection, as rows; a missing one says so.
  CORE.metadataRows = collection => {
    if (!collection) return [{ label: "Metadata", value: "Can't be read: the wallet shows this NFT by its IDs only." }];
    const field = v => (v === null || v === undefined || v === "" ? "none given" : String(v));
    return [{ label: "Supply", value: field(collection.printable_supply) }, { label: "Standard", value: field(collection.standard) },
      { label: "URI", value: field(collection.uri) }, { label: "Creators", value: field(collection.creators) }];
  };
  CORE.linkOf = (program, definition) => "nft:" + program + "/" + definition;
  CORE.programOk = text => ID.test(String(text || "").trim().replace(/^Public\//, ""));
  /// "X · held by 2 of your accounts"
  CORE.collectionLine = c => c.title + " · held by " + (c.count === 1 ? "1 of your accounts" : c.count + " of your accounts");

  // ---- the LNS name card -----------------------------------------------------------------------------------------
  // Everything in the card's own 480 px units (card.html); drawn at any width by scaling.
  CORE.CARD = { REF: 480, PAD: 40, RADIUS: 28, BG: "#152521", EDGE: "#2c4039", INK: "#f5f5ef", DIM: "rgba(245,245,239,0.7)",
    YELLOW: "#ffd328", NAME_TOP: 132, LAMBDA_PX: 30, LAMBDA_BOX: 36, RULE_BOTTOM: 96, RULE_H: 2, FOOT_PX: 14, FOOT_BASE: 434,
    LOGO: 18, LOGO_GAP: 8, LOGO_TOP: 421, SHORT_MAX: 12, SHORT_PX: 60, LONG_PX: 36, SHORT_LH: 1.05, LONG_LH: 1.15,
    NAME_FONT: "Gloock", FOOT_FONT: "NW Fira Code" };
  /// The name's size on a card `width` px wide: 12 characters or fewer at 60 px, 13-32 at 36 px, at the 480 px
  /// reference size, scaled. {px, line (line height), scale, long}.
  CORE.cardSize = (length, width) => {
    const K = CORE.CARD, long = length > K.SHORT_MAX, s = width / K.REF, base = long ? K.LONG_PX : K.SHORT_PX;
    return { px: base * s, line: base * (long ? K.LONG_LH : K.SHORT_LH) * s, scale: s, long };
  };
  /// The name in lines no wider than `max`, broken between any two characters (card.html: word-break: break-all).
  CORE.wrapName = (name, max, measure) => {
    const lines = []; let cur = "";
    for (const ch of Array.from(String(name))) {
      if (cur && measure(cur + ch) > max) { lines.push(cur); cur = ch; } else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  // The η mark (nameswallet.app): a rounded square with the η cut out, in 256 units.
  CORE.ETA = "M107.68 89.94V152.55H78.65V44.35H106.03L106.42 66.71Q110.97 55.39 119.29 49.19Q127.61 43.00 140.10 43.00Q156.94 43.00 167.15 53.84Q177.35 64.68 177.35 83.74V193.00H148.23V88.77Q148.23 78.71 143.05 73.00Q137.87 67.29 128.68 67.29Q119.39 67.29 113.53 73.24Q107.68 79.19 107.68 89.94Z";
  const rounded = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
  // where a line of text sits in a CSS line box of height `box` starting at `top`: its alphabetic baseline
  const baseline = (ctx, text, top, box) => {
    const m = ctx.measureText(text), a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
    return a === undefined ? top + box * 0.8 : top + (box - (a + d)) / 2 + a;
  };
  /// Draws the card for `name` on `ctx`, `width` px wide (and as tall), as card.html lays it out.
  CORE.drawCard = (ctx, name, width) => {
    const K = CORE.CARD, s = width / K.REF, sz = CORE.cardSize(Array.from(name).length, width);
    ctx.save();
    ctx.clearRect(0, 0, width, width);
    rounded(ctx, 0, 0, width, width, K.RADIUS * s); ctx.fillStyle = K.BG; ctx.fill();
    rounded(ctx, 0.5 * s, 0.5 * s, width - s, width - s, K.RADIUS * s); ctx.lineWidth = s; ctx.strokeStyle = K.EDGE; ctx.stroke();
    // λ, top right (Gloock has no λ: the serif the phone has stands in, as in the approved render)
    ctx.font = `${K.LAMBDA_PX * s}px "${K.NAME_FONT}", serif`; ctx.fillStyle = K.YELLOW; ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
    ctx.fillText("λ", width - K.PAD * s, baseline(ctx, "λ", K.PAD * s, K.LAMBDA_BOX * s));
    // the name, top left
    ctx.font = `${sz.px}px "${K.NAME_FONT}", serif`; ctx.fillStyle = K.INK; ctx.textAlign = "left";
    const lines = CORE.wrapName(name, width - 2 * K.PAD * s, t => ctx.measureText(t).width);
    lines.forEach((l, i) => ctx.fillText(l, K.PAD * s, baseline(ctx, l, K.NAME_TOP * s + i * sz.line, sz.line)));
    // the yellow rule
    ctx.fillStyle = K.YELLOW; ctx.fillRect(K.PAD * s, width - (K.RULE_BOTTOM + K.RULE_H) * s, width - 2 * K.PAD * s, K.RULE_H * s);
    // bottom right: the η mark, then nameswallet.app
    ctx.font = `${K.FOOT_PX * s}px "${K.FOOT_FONT}", ui-monospace, monospace`; ctx.fillStyle = K.DIM; ctx.textAlign = "right";
    const right = width - K.PAD * s, tw = ctx.measureText("nameswallet.app").width;
    ctx.fillText("nameswallet.app", right, K.FOOT_BASE * s);
    const lx = right - tw - (K.LOGO_GAP + K.LOGO) * s, ly = K.LOGO_TOP * s, ls = K.LOGO * s;
    rounded(ctx, lx, ly, ls, ls, 58 / 256 * ls); ctx.fillStyle = K.INK; ctx.fill();
    if (typeof Path2D !== "undefined") {
      ctx.translate(lx, ly); ctx.scale(ls / 256, ls / 256); ctx.translate(0, 10);
      ctx.fillStyle = K.BG; ctx.fill(new Path2D(CORE.ETA));
    }
    ctx.restore();
    return { lines, size: sz };
  };
  globalThis.NFT04CORE = CORE;
  if (typeof document === "undefined" || !window.NET04) return;

  // ---- the page ----------------------------------------------------------------------------------------------------
  const view = $("net04");
  if (!view) return;
  const fonts = document.createElement("style");
  fonts.textContent = `@font-face{font-family:"Gloock";src:url("/net04/fonts/Gloock-Regular.ttf") format("truetype");font-display:block}
@font-face{font-family:"NW Fira Code";src:url("/net04/fonts/FiraCode-VF.ttf") format("truetype");font-weight:300 700;font-display:block}
#n4-col h3{margin-top:18px}.n4-nft{margin:10px 0}.n4-nft .t{margin:0;font-weight:620;overflow-wrap:anywhere}.n4-nft .k{margin:2px 0 6px;font-size:14px;color:var(--dim)}
.n4-nft .k.bad{color:var(--warn)}.n4-f{display:flex;flex-wrap:wrap;align-items:center;gap:0 10px;padding:4px 0;border-top:1px solid var(--line);font-size:14px}
.n4-f span:first-child{flex:0 0 6.5em;color:var(--dim)}.n4-f span.v{flex:1 1 0;min-width:4em;overflow-wrap:anywhere}.n4-f button{min-height:44px;padding:4px 12px;font-size:14px;font-weight:550}
.n4-grp{margin:14px 0 4px;font-size:14px;font-weight:620;color:var(--dim)}.n4-card{display:block;width:100%;max-width:480px;aspect-ratio:1;margin:8px 0 6px;border-radius:5.8%}
.n4-prog{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;padding:8px 0;border-top:1px solid var(--line)}.n4-prog .t{flex:1 1 12em;min-width:0;overflow-wrap:anywhere}
.n4-prog small{display:block;color:var(--dim);font-size:13px}.n4-prog button{min-height:44px;padding:4px 12px;font-size:14px;font-weight:550}
.n4-add{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.n4-add input{flex:1 1 12em;min-width:0}.n4-add button{flex:none;min-width:72px}`;
  document.head.append(fonts);
  const home = document.createElement("div"); home.id = "n4-home";
  while (view.firstChild) home.append(view.firstChild);
  view.append(home);
  home.insertAdjacentHTML("beforeend", `<button type="button" class="grow" id="n4-open-col" style="margin-top:14px;border:1px solid var(--line);border-radius:12px">
      <span class="gi" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" focusable="false"><rect x="4" y="4" width="16" height="16" rx="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 15l3-3 2 2 3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="gt"><b>Collectibles</b><small>NFTs and your LNS name cards, view-only</small></span>
      <span class="gc" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>`);
  view.insertAdjacentHTML("beforeend", `<div id="n4-col" hidden>
    <div class="bar" style="margin:0 -16px 8px;background:none;border:0;padding-left:0"><button type="button" class="back" id="n4-col-back" aria-label="Back to the Wallet" title="Back"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><h2 class="bar-t" id="h-col" style="margin:0">Collectibles</h2></div>
    <p class="runs" id="n4-col-runs">Runs on <b>LEZ 0.4</b> · bridge test network</p>
    <p class="note">NFTs of the NFT programs listed below. Under each program an account holds one NFT, and takes NFTs of one collection only; a second NFT needs another account.</p>
    <p class="note">View-only on this phone: receiving, sending, printing and burning NFTs aren't here yet. Images are never loaded.</p>
    <p class="msg warn" id="n4-col-state" role="status" hidden></p>
    <h3>Your LNS names</h3>
    <div id="n4-names"></div>
    <div class="n4-add"><input id="n4-name" type="text" placeholder="an LNS name you hold, like alice" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="40" aria-label="An LNS name you hold"><button type="button" id="n4-name-add">Show</button></div>
    <p class="msg" id="n4-name-m" role="status"></p>
    <h3>Collections</h3>
    <div id="n4-colls"></div>
    <div id="n4-groups"></div>
    <div id="n4-ready"></div>
    <h3>NFT programs on this network</h3>
    <div id="n4-progs"></div>
    <div class="n4-add"><input id="n4-prog" class="mono" type="text" placeholder="NFT program ID" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="80" aria-label="NFT program ID"><input id="n4-prog-label" type="text" placeholder="Your name for it" maxlength="40" aria-label="Your name for it" style="flex:1 1 8em"><button type="button" id="n4-prog-add">Add</button></div>
    <p class="msg" id="n4-prog-m" role="status"></p>
  </div>`);

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fact = (label, value, full) => { const r = el("div", "n4-f"); r.append(el("span", null, label), el("span", "v", value)); if (full) r.append(copyBtn(full, "Copy")); return r; };
  let gen = 0, busy = false, timer = null, last = null;
  const open = () => !$("n4-col").hidden;
  const onScreen = () => open() && window.NET04.net() === "04" && !$("v-open").hidden && !$("page-main").hidden;

  // a card, drawn once the bundled fonts are in (never with a stand-in font)
  async function card(name) {
    const c = el("canvas", "n4-card"); c.setAttribute("role", "img"); c.setAttribute("aria-label", "LNS name card: " + name);
    const g = gen;
    const draw = async () => {
      const fonts = [`60px "${CORE.CARD.NAME_FONT}"`, `14px "${CORE.CARD.FOOT_FONT}"`];
      try { await Promise.all(fonts.map(f => document.fonts.load(f))); } catch (e) {}
      if (g !== gen || !c.isConnected || (typeof locking !== "undefined" && locking)) return;     // (a lock is under way)
      if (!fonts.every(f => document.fonts.check(f))) { c.replaceWith(el("p", "k bad", "The card's fonts didn't load, so it isn't drawn.")); return; }
      const w = Math.round(c.getBoundingClientRect().width) || 328, dpr = window.devicePixelRatio || 1;
      c.width = Math.round(w * dpr); c.height = c.width;
      const ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      CORE.drawCard(ctx, name, w);
      c.dataset.drawn = String(w);
    };
    requestAnimationFrame(draw);
    return c;
  }

  function render(d) {
    last = d;
    const st = $("n4-col-state");
    const says = [d.unreachable, d.note].filter(Boolean);
    st.hidden = !says.length; st.textContent = says.join(" ");
    // the names, each with its card or what stands in its way
    const nb = $("n4-names"); nb.replaceChildren();
    if (!d.names.length) nb.append(el("p", "note", "No LNS name to look for yet. Add one you hold, or get a name in Settings → Your name."));
    for (const n of d.names) {
      const box = el("div", "n4-nft"); box.dataset.name = n.name;
      box.append(el("p", "t", n.name));
      if (n.status === "ok") {
        card(n.name).then(c => { if (box.isConnected) box.insertBefore(c, box.children[1] || null); });
        box.append(el("p", "k", "Its NFT, held for it by the LNS registry. It moves with the name."));
        box.append(fact("Holder", CORE.accountShown(n.holder), n.holder), fact("NFT ID", CORE.idShown(n.definition), n.definition),
          fact("Program", CORE.idShown(n.program), n.program));
      } else box.append(el("p", n.status === "unreadable" ? "k bad" : "k", n.text || "Not read yet."));
      if (!n.own) { const rm = el("button", "small", "Stop showing"); rm.type = "button"; rm.addEventListener("click", () => change({ remove_name: n.name }, rm, $("n4-name-m"))); box.append(rm); }
      nb.append(box);
    }
    // the collections
    const cb = $("n4-colls"); cb.replaceChildren();
    if (!d.programs.length) cb.append(el("p", "note", "Your accounts hold no NFT under the listed programs."));
    else if (d.read_at && !d.collections.length) cb.append(el("p", "note", "Your accounts hold no NFT under the listed programs."));
    for (const c of d.collections) cb.append(el("p", null, CORE.collectionLine(c)));
    // by account
    const gb = $("n4-groups"); gb.replaceChildren();
    if (d.groups.length) gb.append(el("h3", null, "By account"));
    for (const g of d.groups) {
      gb.append(el("p", "n4-grp", CORE.accountShown(g.account) + (g.own ? " · this phone" : " · watched, view-only")));
      for (const t of g.nfts) {
        const c = el("div", "card n4-nft");
        c.append(el("p", "t", CORE.collectionTitle(t.collection, t.definition)));
        c.append(el("p", t.state === "unreadable" ? "k bad" : "k", t.state === "unreadable" ? "Its state can't be read (" + (t.unreadable || "unknown") + ")" : CORE.tokenLine(t)));
        if (t.definition) c.append(fact("Collection ID", CORE.idShown(t.definition), t.definition));
        if (t.state !== "unreadable") for (const r of CORE.metadataRows(t.collection)) c.append(fact(r.label, r.value));
        c.append(fact("Program", t.programLabel || CORE.idShown(t.program), t.program));
        if (t.definition) c.append(copyBtn(CORE.linkOf(t.program, t.definition), "Copy the collection's link"));
        gb.append(c);
      }
    }
    const rb = $("n4-ready"); rb.replaceChildren();
    if (d.ready.length) rb.append(el("h3", null, "Ready to receive"));
    for (const r of d.ready) { const p = el("div", "n4-f"); p.append(el("span", "v", CORE.accountShown(r.account) + " takes " + CORE.collectionTitle(r.collection, r.definition)), copyBtn(r.account, "Copy the account")); rb.append(p); }
    // the programs
    const pb = $("n4-progs"); pb.replaceChildren();
    if (!d.programs.length) pb.append(el("p", "note", "None yet. Every deployment of the NFT program is a different program: add the one your collections live under, by its program ID."));
    for (const p of d.programs) {
      const r = el("div", "n4-prog"), t = el("div", "t");
      t.append(el("span", null, (p.label || "NFT program") + " · " + CORE.idShown(p.program)), el("small", null, p.error || "Its source isn't checked on this phone."));
      const rm = el("button", null, "Remove"); rm.type = "button"; rm.addEventListener("click", () => change({ remove_program: p.program }, rm, $("n4-prog-m")));
      r.append(t, copyBtn(p.program, "Copy"), rm); pb.append(r);
    }
  }

  async function load(once = false) {
    if (busy || (!once && !onScreen())) return;
    busy = true;
    const g = gen;
    try {
      const r = await api("/api/wallet/net04/nft");
      if (g !== gen || r.stale || !open() || $("v-open").hidden) return;
      if (r.status === 401) return lockedNow();
      if (r.ok) render(r.data);
      else { $("n4-col-state").hidden = false; $("n4-col-state").textContent = r.data.error || "Can't read the bridge test network now."; }
    } finally { busy = false; }
  }

  // Add / Remove / Show / Stop showing: the button says "Checking…" at once, then the line below says how it went
  async function change(body, btn, msg) {
    const g = gen, label = btn.textContent;
    btn.disabled = true; btn.textContent = "Checking…"; msg.className = "msg"; msg.textContent = "";
    const r = await api("/api/wallet/net04/nft", body);
    if (g !== gen || r.stale || $("v-open").hidden) return;
    btn.disabled = false; btn.textContent = label;
    if (r.status === 401) return lockedNow();
    if (!r.ok) { msg.className = "msg bad"; msg.textContent = r.data.error || "That didn't work. Try again."; return; }
    msg.className = "msg ok"; msg.textContent = r.data.said || "Done.";
    if (r.data.view) render(r.data.view);
    load(true);
    setTimeout(() => { if (g === gen) load(true); }, 3000);
  }

  function show(on) {
    $("n4-home").hidden = on; $("n4-col").hidden = !on;
    clearInterval(timer); timer = null;
    if (on) { load(true); setTimeout(() => { if (onScreen()) load(true); }, 3000); timer = setInterval(() => { if (onScreen() && document.visibilityState === "visible") load(); }, 30000); }
    window.scrollTo(0, 0);
  }

  // a lock: nothing stays, the drawn cards neither
  function lock() {
    gen++; last = null;
    for (const c of view.querySelectorAll("canvas")) { try { c.width = 0; c.height = 0; } catch (e) {} c.remove(); }
    for (const id of ["n4-names", "n4-colls", "n4-groups", "n4-ready", "n4-progs", "n4-name-m", "n4-prog-m", "n4-col-state"]) $(id).replaceChildren();
    for (const id of ["n4-name", "n4-prog", "n4-prog-label"]) $(id).value = "";
    $("n4-col-state").hidden = true;
    show(false);
  }

  $("n4-open-col").addEventListener("click", () => show(true));
  $("n4-col-back").addEventListener("click", () => show(false));
  $("n4-prog-add").addEventListener("click", () => {
    const v = $("n4-prog").value.trim(), m = $("n4-prog-m");
    if (!v) { m.className = "msg bad"; m.textContent = "Paste the NFT program's ID first."; return; }
    change({ add_program: v, label: $("n4-prog-label").value }, $("n4-prog-add"), m).then(() => { if (m.className === "msg ok") { $("n4-prog").value = ""; $("n4-prog-label").value = ""; } });
  });
  $("n4-name-add").addEventListener("click", () => {
    const v = $("n4-name").value.trim(), m = $("n4-name-m");
    if (!v) { m.className = "msg bad"; m.textContent = "Type an LNS name first, like alice."; return; }
    change({ add_name: v }, $("n4-name-add"), m).then(() => { if (m.className === "msg ok") $("n4-name").value = ""; });
  });
  document.addEventListener("visibilitychange", () => { if (onScreen() && document.visibilityState === "visible") load(); });
  window.NFT04 = { lock, show, open, net: () => window.NET04.net(), last: () => last };
})();

// Messages: chats between LNS names, end-to-end encrypted in the names project's format (msg-crypto.js).
// The server includes this module only when a Logos Messaging node can run on this device (WAKU_API, or the
// Android app). It adds a Wallet / Messages bar to the page and a Messages screen; the model is in
// chat-core.js (the tests run it too). It uses the page's own helpers ($, api, token, show, lockedNow,
// openSettings, closeSettings, the names forwarder), so it runs after the page's main script.
//
// The page makes this device's messaging identity; the server keeps it for unlocked pages only and puts it
// in the wallet backup. Sealing, opening and the encryption of what is kept happen here: the server only
// stores sealed or encrypted bytes. Everything locks with the wallet.

import { Chat, convoIdOf, isAddressId, parseAddress, shortFp, shareable, MAX_TEXT } from "./chat-core.js";
import { icon } from "./icon.js";
import { newIdentity } from "./identity.js";
import { toHex, fromHex } from "./msg-crypto.js";

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null && k !== false)); return e; };
const svg = (path, size = 24, extra = "") => { const s = document.createElement("span"); s.className = "ic";
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" ${extra}>${path}</svg>`; return s; };
const P = {      // icon paths (constants)
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  send: '<path d="M5 12h12M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.2c-.5.4-1.3 0-1.3-.6V17.0A2.5 2.5 0 0 1 4 14.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
  lambda: '<path d="M8.6 5.1l7.9 13.8M12.1 10.9L7 18.9M6.9 5.6L8.6 5.1" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  mute: '<path d="M6 9h3l4-4v14l-4-4H6zM16.5 9.5l4 4M20.5 9.5l-4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.9"/>',
  chev: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  sync: '<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2M4.5 12a7.5 7.5 0 0 1 12.9-5.2"/><path d="M17.6 3.4v3.5h-3.5M6.4 20.6v-3.5h3.5"/></g>',
  ok: '<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M8 12.3l2.8 2.8L16.2 9.6"/></g>',
  stop: '<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l8.5 15h-17z"/><path d="M12 10v4.2M12 17.1v.1"/></g>',
  sliders: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></g>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>',
  clock: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></g>',
  tick: '<path d="M5.5 12.5l4.2 4.2L18.5 8" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l8.5 15h-17z"/><path d="M12 10v4M12 17v.1"/></g>',
  gear: '<path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.4 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.4-1a.5.5 0 0 0-.6.2L2.5 8.8a.5.5 0 0 0 .1.6l2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .2.3.4.5.4h3.8c.2 0 .5-.2.5-.4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.4 1c.2.1.5 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
};
const bridge = () => typeof window.LogosAndroid === "object" && window.LogosAndroid !== null && typeof window.LogosAndroid.openNode === "function";
const openNode = () => { try { window.LogosAndroid.openNode(); } catch (e) {} };
let names = null;
const namesLib = async () => names || (names = await import("/names/names.js"));
const resolve = async name => (await namesLib()).resolveName(NAMES_RPC, namesProgram, name);

// ---- look ----------------------------------------------------------------------------------------------
document.head.append(el("style", { textContent: `
body.has-nav main{padding-bottom:104px}
body.kb #nav{display:none}body.kb.has-nav main{padding-bottom:24px}
#nav{position:fixed;left:0;right:0;bottom:0;z-index:5;background:var(--card);border-top:1px solid var(--line);padding:6px 12px calc(6px + env(safe-area-inset-bottom))}
#nav .in{display:flex;gap:8px;max-width:520px;margin:0 auto}
#nav button{flex:1;position:relative;border:0;border-radius:12px;min-height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:12.5px;font-weight:600;color:var(--dim);padding:4px}
#nav button[aria-current="page"]{color:var(--ink);background:var(--field)}
#nav .badge{position:absolute;top:4px;left:calc(50% + 6px)}
.ic{display:inline-flex}.ic svg{display:block}
.badge{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;line-height:1}
.badge.quiet{background:var(--line);color:var(--dim)}
.av{display:inline-block;border-radius:50%;overflow:hidden;flex:none;background:var(--line)}
.av img,.av svg{display:block;width:100%;height:100%;object-fit:cover}
#page-msg h2.top{margin:0}
.crow{display:flex;gap:12px;align-items:center;width:100%;text-align:left;border:0;border-radius:10px;background:none;padding:0;font-weight:400;min-height:68px;color:var(--ink)}
.crow:active{background:var(--field)}
.crow .cb{flex:1;min-width:0;align-self:stretch;display:flex;flex-direction:column;justify-content:center;gap:2px;border-top:1px solid var(--line);padding:10px 0}
.crow:first-child .cb{border-top:0}
.cl{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.cn{font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ct{font-size:12.5px;color:var(--dim);flex:none;display:inline-flex;align-items:center;gap:4px}.ct.new{color:var(--accent);font-weight:600}
.cp{font-size:14px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.cp.warn{color:var(--warn)}
.empty{text-align:center;padding:22px 8px 8px}
.empty .art{width:84px;height:84px;margin:0 auto;border-radius:50%;background:var(--field);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink)}
.empty h3{font-size:18px;margin:14px 0 4px;letter-spacing:-.01em}.empty p{color:var(--dim);font-size:14px;margin:0 auto 4px;max-width:300px}
.empty button{width:auto;padding-left:22px;padding-right:22px}
.hero h3{font-size:21px;margin:14px 0 6px;letter-spacing:-.015em}.hero ul{margin:10px 0 0;padding-left:20px;color:var(--dim);font-size:14px}.hero li{margin:4px 0}
.found{display:flex;gap:14px;align-items:center;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.found b{display:block;font-size:18px}.found small{display:block;font-size:13.5px;color:var(--dim)}
.cmd{display:block;font-family:var(--mono);font-size:13px;background:var(--field);border:1px solid var(--line);border-radius:10px;padding:10px;overflow-wrap:anywhere;margin-top:8px}
.ov,#mg-newv{position:fixed;left:0;right:0;top:0;height:var(--vvh,100dvh);z-index:20;background:var(--bg);display:flex;flex-direction:column}
.ov-top{padding-top:calc(6px + env(safe-area-inset-top));flex:none}
.who{flex:1;min-width:0;display:flex;align-items:center;gap:10px;border:0;background:none;padding:4px 6px;text-align:left;font-weight:400;min-height:48px;color:var(--ink)}
.who .t{min-width:0}.who b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:16.5px}
.who small{display:block;font-size:12.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.who small.ok{color:var(--ok)}.who small.warn{color:var(--warn)}
.cv-ban{flex:none;margin:10px 12px 0;padding:12px 14px;border:1px solid var(--warn);border-radius:12px;background:var(--card);font-size:14px}
.cv-ban p{margin:0}.cv-ban .row{margin-top:10px}.cv-ban button{min-height:44px;font-size:14px}
.cv-scroll{flex:1;overflow-y:auto;padding:6px 12px 10px;overscroll-behavior:contain}
.cv-in{max-width:640px;margin:0 auto;display:flex;flex-direction:column;min-height:100%;justify-content:flex-end}
.day{align-self:center;font-size:12px;font-weight:600;color:var(--dim);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 11px;margin:14px 0 6px}
.bub{max-width:82%;padding:8px 12px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15.5px;line-height:1.4;margin-top:3px;text-align:left;font-weight:400;min-height:0;cursor:pointer;user-select:text;-webkit-user-select:text}
.bub.in{align-self:flex-start;background:var(--card);border:1px solid var(--line);color:var(--ink);border-bottom-left-radius:6px}
.bub.out{align-self:flex-end;background:var(--ink);border:1px solid var(--ink);color:var(--bg);border-bottom-right-radius:6px}
.bub.unv{border:1.5px dashed var(--warn)}
.bub.cont.in{border-top-left-radius:6px}.bub.cont.out{border-top-right-radius:6px}
.meta{font-size:11.5px;color:var(--dim);margin:3px 4px 6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.meta.out{align-self:flex-end;justify-content:flex-end}.meta.in{align-self:flex-start}
.meta .bad{color:var(--bad);font-weight:600}.meta .warn{color:var(--warn);font-weight:600}
.meta button{min-height:44px;padding:0 14px;font-size:13px;font-weight:600;color:var(--bad);border-color:var(--bad);border-radius:999px}
.meta.note-w{font-size:13px;color:var(--warn)}.meta .ic{color:var(--dim)}
.cv-empty{margin:auto;text-align:center;color:var(--dim);font-size:14px;padding:30px 20px;max-width:320px}
.cv-empty .av{margin:0 auto 12px}
.cmp{flex:none;display:flex;align-items:flex-end;gap:8px;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:var(--card);border-top:1px solid var(--line)}
.cmp .wrap{flex:1;max-width:640px;margin:0 auto;display:flex;align-items:flex-end;gap:8px}
.cmp textarea{flex:1;min-width:0;font:inherit;font-size:16px;color:var(--ink);background:var(--field);border:1.5px solid var(--field-line);border-radius:22px;padding:10px 15px;resize:none;height:46px;max-height:150px;line-height:1.35}
.cmp textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.cmp .go{width:46px;height:46px;min-height:46px;border-radius:50%;padding:0;background:var(--accent);border-color:var(--accent);color:var(--accent-ink);display:inline-flex;align-items:center;justify-content:center;flex:none}
.cmp .go:disabled{background:var(--field);border-color:var(--line);color:var(--dim);opacity:1}
.cmp .count{font-size:11.5px;color:var(--dim);align-self:center}
.cmp-note{flex:none;padding:14px 16px calc(14px + env(safe-area-inset-bottom));background:var(--card);border-top:1px solid var(--line);font-size:14px;color:var(--dim);text-align:center}
.cmp-note button{margin-left:8px;min-height:44px;font-size:13px;padding:4px 14px}
.pv-scroll{flex:1;overflow-y:auto;padding:16px 16px 40px}.pv-in{max-width:520px;margin:0 auto}
.pv-head{text-align:center;padding:6px 0 18px}.pv-head .av{margin:0 auto}
.pv-head h3{font-size:24px;margin:12px 0 2px;letter-spacing:-.02em;overflow-wrap:anywhere}.pv-head p{margin:2px 0 0;color:var(--dim);font-size:14px}
.pv-head .state{display:inline-block;margin-top:8px;font-size:13px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid var(--line)}
.state.ok{color:var(--ok)}.state.warn{color:var(--warn)}.state.bad{color:var(--bad)}
.fp{font-family:var(--mono);font-size:13px;color:var(--dim);overflow-wrap:anywhere}
#page-msg textarea,.ov textarea.note-f{width:100%;font:inherit;color:var(--ink);background:var(--field);border:1.5px solid var(--field-line);border-radius:10px;padding:12px;min-height:110px;resize:vertical}
.ov textarea.note-f:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.tg{cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.tg:first-child{border-top:0;padding-top:0}
.tg span{flex:1}.tg small{display:block;color:var(--dim);font-size:13px}
.sw{width:52px;min-height:32px;height:32px;border-radius:999px;padding:0;border:1.5px solid var(--field-line);background:var(--field);position:relative;flex:none}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:var(--dim);transition:left .15s}
.sw[aria-checked="true"]{background:var(--accent);border-color:var(--accent)}.sw[aria-checked="true"]::after{left:25px;background:var(--accent-ink)}
.danger{color:var(--bad);border-color:var(--bad);width:100%;margin-top:10px}
.saved{font-size:12.5px;color:var(--ok);min-height:18px;margin-top:4px}
.sheet-bg{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center}
.sheet{background:var(--card);color:var(--ink);width:100%;max-width:560px;border-radius:18px 18px 0 0;padding:20px 16px calc(18px + env(safe-area-inset-bottom));border:1px solid var(--line);max-height:85vh;overflow:auto}
.sheet h2{color:var(--ink);font-size:18px;text-transform:none;letter-spacing:-.01em;margin:0 0 4px}
.sheet .quote{margin:10px 0 4px;padding:10px 12px;border-left:3px solid var(--line);color:var(--dim);font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:7.5em;overflow:hidden}
.sheet dl div{padding:8px 0}.sheet .row button{min-height:44px}
.mtop{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 2px 16px;min-height:44px}
.mtop h1{font-size:24px;margin:0;letter-spacing:-.02em}
.mtop .acts{display:flex;gap:8px;align-items:center}
.mtop .ic-b{width:44px;min-height:44px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0}
.mtop .mnode{margin:2px 0 0;font-size:13px;color:var(--dim)}
.rows{margin:0 -16px;padding:0 16px}
.mnode{display:flex;align-items:center;gap:10px}
.mnode button{min-height:44px;font-size:13px;padding:4px 12px;flex:none}
.hint-card{display:flex;gap:10px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 8px 12px 14px;margin:0 0 14px;font-size:14px}
.hint-card p{margin:0;flex:1}.hint-card .lnk{border:0;background:none;padding:0;min-height:0;color:var(--accent);font-weight:600;font-size:14px}
.hint-card .x{width:44px;min-height:44px;padding:0;border:0;display:inline-flex;align-items:center;justify-content:center;color:var(--dim);flex:none}
@media (prefers-reduced-motion:reduce){.sw::after{transition:none}}
` }));
const vp = document.querySelector('meta[name="viewport"]');               // keep the composer above the keyboard
if (vp && !/interactive-widget/.test(vp.content)) vp.content += ",interactive-widget=resizes-content";
if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty("--vvh", Math.round(visualViewport.height) + "px");
  visualViewport.addEventListener("resize", fit); fit();
}
// while a text field has the focus (the keyboard is up on a phone), the Wallet / Messages bar steps aside
const typing = t => !!t && t.matches && t.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=file])");
const kbSync = () => document.body.classList.toggle("kb", typing(document.activeElement) && document.activeElement.offsetParent !== null);
document.addEventListener("focusin", kbSync);
document.addEventListener("focusout", () => setTimeout(kbSync, 0));

// ---- the bar: Wallet / Messages ----------------------------------------------------------------------
const badge = el("span", { className: "badge", hidden: true });
const navWallet = el("button", { type: "button", id: "nav-wallet" }, svg(P.lambda), "Wallet");
const navMsg = el("button", { type: "button", id: "nav-msg" }, svg(P.chat), "Messages", badge);
const nav = el("nav", { id: "nav", ariaLabel: "Screens" }, el("div", { className: "in" }, navWallet, navMsg));
document.body.append(nav); document.body.classList.add("has-nav");
const page = el("div", { id: "page-msg", hidden: true });
$("page-main").after(page);
let tab = "wallet";
const pageHeader = document.querySelector("main > header");
function setTab(t) {
  tab = t;
  $("page-main").hidden = t !== "wallet"; page.hidden = t !== "msg"; $("page-settings").hidden = true;
  pageHeader.hidden = t === "msg";               // Messages has its own top; the node's header is the wallet's
  navWallet.removeAttribute("aria-current"); navMsg.removeAttribute("aria-current");
  (t === "wallet" ? navWallet : navMsg).setAttribute("aria-current", "page");
  window.scrollTo(0, 0); kbSync();
  if (t === "msg") { home(); refresh(); }
}
navWallet.addEventListener("click", () => setTab("wallet"));
navMsg.addEventListener("click", () => setTab("msg"));
setTab("wallet");
// Settings is its own view; going back returns to the screen it came from
const pageOpenSettings = window.openSettings, pageCloseSettings = window.closeSettings;
window.openSettings = (...a) => {
  msgSettingsUi(true);
  if (a[0] === "s-msg") mgsShow("list");
  pageOpenSettings(...a); page.hidden = true; nav.hidden = true; document.body.classList.remove("has-nav");
};
window.closeSettings = () => { pageCloseSettings(); nav.hidden = false; document.body.classList.add("has-nav"); setTab(tab); };

// say where messages go, in the footer and in Settings > About
const ABOUT_MESSAGES = " Messages go through the Logos Messaging node on this device to the Logos Messaging network, sealed so only the person they're for can read them. The names in your chats are checked with the name service in the background.";
for (const id of ["footer-talk", "about-talk"]) if ($(id)) $(id).textContent = $(id).textContent.replace(/ Testnet\.$/, ABOUT_MESSAGES + " Testnet.");

// ---- the screen ----------------------------------------------------------------------------------------
page.innerHTML = `
  <section class="card hero" id="mg-nokey" hidden>
    <h2>Messages</h2>
    <h3>Private messages, sealed on this phone.</h3>
    <p class="note" style="margin:0">Only the person a message is for can open it. LNS names are names like alice.</p>
    <ul>
      <li>People can reach you by your LNS name or by a messaging address.</li>
      <li>This phone gets its own messaging address. Only this app can use it, and only while it's unlocked.</li>
      <li>Make a new backup after turning this on.</li>
    </ul>
    <button type="button" class="primary" id="mg-on">Turn on messages</button>
    <p class="msg bad" id="mg-on-m" role="alert"></p>
  </section>
  <div id="mg-home" hidden>
    <div class="mtop"><div><h1 id="h-chats">Messages</h1><div class="mnode" id="mg-node" role="status" hidden></div></div><div class="acts"><button type="button" class="ic-b" id="mg-new" aria-label="New chat" title="New chat"></button><button type="button" class="ic-b" id="mg-me" aria-label="Settings" title="Settings"></button></div></div>
    <p class="note" id="mg-loading" hidden>Loading chats…</p>
    <div class="hint-card" id="mg-hint" hidden></div>
    <button type="button" class="notice" id="mg-bk" hidden>Your last backup doesn't include Messages. Make a new one.</button>
    <p class="msg warn" id="mg-store-warn" hidden style="margin:0 2px 12px">Saved chats from an earlier messaging address can't be opened on this one. Restore the backup that has that address to read them.</p>
    <div id="mg-rows" class="rows"></div>
  </div>
  <div id="mg-newv" role="dialog" aria-modal="true" aria-labelledby="h-new" hidden>
    <div class="ov-top bar"><button type="button" class="back mg-home" aria-label="Back" title="Back"></button><h2 id="h-new" class="bar-t">New chat</h2></div>
    <div class="pv-scroll"><div class="pv-in">
      <form id="mg-find" autocomplete="off">
        <label for="mg-to" style="margin-top:0">An LNS name or a messaging address</label>
        <div class="pwrow"><input id="mg-to" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="100" placeholder="alice, or a messaging address" enterkeyhint="search"><button type="submit" id="mg-look">Look up</button><button type="button" id="mg-scan" hidden>Scan</button></div>
      </form>
      <div id="mg-found"></div>
    </div></div>
  </div>
`;

// ---- Messages in the one Settings page: your name and how to link it, your messaging address ----
const msgSettings = el("section", { id: "s-msg", ariaLabelledby: "h-s-msg", hidden: true });
msgSettings.innerHTML = `
  <h2 id="h-s-msg">Messages</h2>
  <div class="card groups" id="mgs-list"></div>
  <div class="card" id="mgs-name" hidden>
  <h3 class="vh">Your name</h3>
  <div id="mg-own" hidden>
    <p class="msg" id="mg-own-m" role="status" style="margin-top:0"></p>
    <button type="button" class="primary" id="mg-own-go" style="width:100%" hidden></button>
  </div>
  <details id="mg-else" open><summary id="mg-else-s">Use a name held elsewhere</summary>
  <p class="msg" id="mg-check-m" role="status" style="margin-top:0"></p>
  <div class="pwrow"><input id="mg-name" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="40" placeholder="yourname" aria-label="Your LNS name"><button type="button" id="mg-name-save">Save</button></div>
  <p class="msg" id="mg-name-m" role="status"></p>
  <p class="hint">Without a name you can still write and get messages: people use your messaging address, and see your messages as from it.</p>
  <details id="mg-link"><summary>Link your name to this phone</summary>
    <p class="note">Link your name to this phone's messaging address in the Names app where you registered it. Then tap I've linked it.</p>
    <button type="button" id="mg-check" style="width:100%;margin-top:12px">I've linked it</button>
    <details id="mg-cmd-d"><summary>Show command for the terminal</summary>
      <code class="cmd" id="mg-cmd"></code>
      <button type="button" id="mg-copy" style="width:100%;margin-top:10px">Copy command</button>
    </details>
  </details>
  </details>
  </div>
  <div class="card" id="mgs-addr" hidden>
  <h3 class="vh">Your messaging address</h3>
  <p class="note" style="margin-top:0">Anyone can write to this phone at this address, with or without an LNS name. This address is for messages. Coins go to your wallet address (Wallet → Receive). Your LNS name can take both: coins once it has a wallet address set, messages once it's linked to this phone.</p>
  <code class="cmd" id="mg-addr" hidden></code>
  <div class="qr-wrap" id="mg-addr-qr" hidden></div>
  <div class="row"><button type="button" id="mg-addr-show" aria-controls="mg-addr" aria-expanded="false">Show</button><button type="button" id="mg-addr-copy">Copy</button></div>
  <p class="msg" id="mg-addr-m" role="status"></p>
  </div>`;
$("s-slot").append(msgSettings);
// Settings > Messages and the gear on Messages open this same page (Settings' Messages group): a short list,
// each row opening its own page inside it. Each page is a history step, so Back (on screen or the phone's)
// goes from a page to the list, and from the list to where Settings > Messages was opened from.
// To add a group: one line here, and a <div class="card" id="mgs-ID" hidden> with its controls above.
const MSG_GROUPS = [
  { id: "name", label: "Name", icon: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c.9-3.4 3.7-5.3 7-5.3s6.1 1.9 7 5.3"/>', state: nameState1 },
  { id: "addr", label: "Address", icon: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><path d="M13.5 13.5h2.5v2.5M20 13.5v.1M16 20h4v-3.5"/>',
    state: () => "Show it, copy it, or let them scan it" },
];
function nameState1() {         // "linked" only once the name service said so
  if (!me) return "";
  if (!me.name) return "None yet";
  const c = chat && chat.chainOf(me.name);
  if (!c) return me.name;
  if (c.key === me.public) return me.name + " · linked to this phone";
  return [me.name + (c.registered ? " · not linked yet" : " · not registered"), "warn"];
}
let mgsSub = "list", mgsIgnore = 0;
function msgRows() {
  for (const g of MSG_GROUPS) {
    if (!g.row) {
      const b = el("button", { type: "button", className: "grow", id: "mgs-go-" + g.id });
      b.innerHTML = '<span class="gi"></span><span class="gt"><b></b><small></small></span><span class="gc"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
      b.querySelector(".gi").innerHTML = GI(g.icon); b.querySelector("b").textContent = g.label;
      b.addEventListener("click", () => mgsOpen(g.id));
      $("mgs-list").append(b); g.row = b;
    }
    let st = ""; try { st = me ? g.state() : ""; } catch (e) {}     // locked: nothing kept
    const [text, cls] = Array.isArray(st) ? st : [st, ""], sm = g.row.querySelector("small");
    if (sm.textContent !== text) sm.textContent = text;
    sm.className = cls || ""; g.row.setAttribute("aria-label", g.label + (text ? ". " + text : ""));
  }
}
/** Shows the list ("list") or one page of Settings > Messages, with its title in the bar. */
function mgsShow(sub) {
  const g = MSG_GROUPS.find(x => x.id === sub) || null;
  mgsSub = g ? g.id : "list";
  $("mgs-list").hidden = !!g;
  for (const x of MSG_GROUPS) $("mgs-" + x.id).hidden = x !== g;
  if (!$("page-settings").hidden && $("st-msg") && !$("st-msg").hidden) $("h-settings").textContent = g ? g.label : "Messages";
  msgRows();
}
function mgsOpen(sub) { history.pushState({ st: "msg", sub }, ""); mgsShow(sub); window.scrollTo(0, 0); }
const mgsHere = () => !$("page-settings").hidden && !!$("st-msg") && !$("st-msg").hidden;
window.stSubBack = () => {      // the bar's Back on a page of Settings > Messages: up to the list
  if (!mgsHere() || mgsSub === "list") return false;
  if (history.state && history.state.sub) { mgsIgnore++; history.back(); }
  mgsShow("list"); window.scrollTo(0, 0); return true;
};
addEventListener("popstate", e => {    // the phone's Back
  if (mgsIgnore) { mgsIgnore--; return; }
  if (!mgsHere()) return;
  const sub = (e.state && e.state.st === "msg" && e.state.sub) || "list";
  if (sub !== mgsSub) { mgsShow(sub); window.scrollTo(0, 0); }
});
setInterval(() => { if (mgsHere() && mgsSub === "list") msgRows(); }, 1000);
const openMsgSettings = () => { openSettings("s-msg"); };
/** Shows the Messages section while messages are on and loaded; fills it again when asked (`fresh`) or when
 *  the messaging identity changed, so a refresh never clears what is being typed. */
let meShown = null;
function msgSettingsUi(fresh = false) {
  const on = !!(chat && me);
  msgSettings.hidden = !on;
  if (!on) meShown = null;
  else if (fresh || meShown !== me) { meShown = me; openMe(); }
  msgRows(); stRows();                              // Settings' Messages row follows (and forgets the name on a lock)
}
/** Settings' Messages row: one line on your LNS name; "linked" only once the name service said so. */
window.msgSettingsState = () => {
  if (!chat || !me) return "";
  if (own && own.name && me.name !== own.name) return ["On · " + own.name + " isn't used for messages yet", "warn"];
  if (!me.name) return "On · no LNS name yet";
  const c = chat.chainOf(me.name);
  if (!c) return "On · " + me.name;
  if (c.key === me.public) return "On · linked to " + me.name;
  return [c.registered ? "On · " + me.name + " isn't linked yet" : "On · " + me.name + " isn't registered", "warn"];
};
for (const b of page.querySelectorAll(".mg-home")) { b.append(svg(P.back)); b.addEventListener("click", () => popOv()); }
$("mg-new").append(svg(P.plus, 24));
$("mg-me").append(svg(P.gear, 22));
// room for "New group" next to New chat once groups exist; nothing is shown for it until then

let chat = null, me = null, status = null, view = "home", loading = null;
const forget = () => {        // nothing of the chats stays in the page while it is locked
  chat = null; me = null; loading = null; closeAll();
  for (const id of ["mg-rows", "mg-found", "mg-hint", "mg-addr-qr"]) $(id).replaceChildren();
  for (const id of ["mg-to", "mg-name"]) $(id).value = "";
  for (const id of ["mg-cmd", "mg-addr", "mg-check-m", "mg-name-m", "mg-addr-m", "mg-own-m"]) $(id).textContent = "";
  own = null;
  badge.hidden = true; msgSettingsUi();
};
function home() { if (view === "new" && stack.length && stack[stack.length - 1].name === "new") popOv(); view = "home"; $("mg-newv").hidden = true; render(); }

// everything goes when the wallet locks
const pageShow = window.show;
// The lock screen covers everything (the page's own); after unlocking, back to where the user was: the
// same tab, and the same chat if one was open, or the same Settings page.
let resume = null, reopen = null;
window.show = v => {
  if (v !== "v-open" && !resume && (chat || tab === "msg")) resume = { tab, convo: cv.id, settings: !$("page-settings").hidden };
  pageShow(v); setTimeout(kbSync, 0);
  if (v !== "v-open") forget();
  else if (resume) {
    const r = resume; resume = null;
    if (r.settings && !$("page-settings").hidden) { tab = r.tab; refresh(); return; }    // Settings stays as it was
    reopen = r.convo; setTab(r.tab); return;
  }
  if (tab === "msg") render();
};

const unlocked = () => !$("v-open").hidden && token;
function locked401(r) { if (r && r.status === 401) { lockedNow(); return true; } return false; }

/** Loads status, the key and the chats; quick when they're loaded already. */
async function refresh() {
  if (!unlocked()) return render();
  const r = await api("/api/messages/status");
  if (locked401(r) || !r.ok) return render();
  status = r.data;
  if (status.key && (!me || me.public !== status.key)) {
    const k = await api("/api/messages/key");
    if (locked401(k) || !k.ok) return;
    me = { secret: fromHex(k.data.secret), public: k.data.public, name: k.data.name || "", groups: k.data.groups };
    chat = new Chat({ me, api, resolve });
    const c = chat;
    loading = chat.loadStore().then(() => chat.sync()).then(() => { c.ready = true; })
      .catch(e => { if (e.status === 401) lockedNow(); else c.ready = true; });
  }
  if (!status.key) { me = null; chat = null; }
  if (loading) { await loading; loading = null; }
  if (reopen && chat && chat.convo(reopen)) { const id = reopen; reopen = null; render(); openConvo(id); }
  else if (chat) { try { if (await chat.sync()) changed(); } catch (e) { if (e.status === 401) return lockedNow(); } }
  render(); msgSettingsUi();
}
function changed() { if (cv.id) renderConvo(); }       // a profile isn't redrawn under someone typing a note

// ---- home: the chat list -------------------------------------------------------------------------------
const nodeText = () => {
  if (!status) return "";
  const n = status.node;
  if (n.starting && n.reachable !== false) return "Connecting…";
  if (n.reachable === false) return "Offline";
  return "";
};
function render() {
  const open = unlocked();
  $("mg-nokey").hidden = !open || !status || !!status.key;
  const ready = open && !!chat && !!chat.ready;
  $("mg-home").hidden = !ready || view !== "home";
  if (open && status && status.key && !ready) { $("mg-home").hidden = false; $("mg-loading").hidden = false; $("mg-rows").replaceChildren(); return; }
  $("mg-loading").hidden = true;
  $("mg-newv").hidden = !ready || view !== "new";
  updateBadge();
  if (!ready) return;
  const t = nodeText(), nl = $("mg-node");
  nl.hidden = !t;
  if (t) {                    // only when the messaging node isn't fine; on the phone, a way to look at it
    const fix = bridge() ? el("button", { type: "button", textContent: "Open node" }) : null;
    if (fix) fix.addEventListener("click", openNode);
    nl.replaceChildren(el("span", { textContent: t }), fix);
  }
  $("mg-store-warn").hidden = !chat.storeUnreadable;
  // a backup made before Messages was turned on has no messaging address or chats in it
  const bk = status.backup || {};
  $("mg-bk").hidden = !(bk.last && (bk.messaging === false || (bk.messaging == null && bk.key_created && bk.last < bk.key_created)));
  renderBackupCopy();
  renderHint(); if (view === "home") renderList();
}
$("mg-bk").addEventListener("click", () => openSettings("s-bk", "bk-pw1"));
// with Messages on, the backup and restore texts say what else is in the file
const rsMsg = el("p", { className: "msg warn", id: "rs-msg", hidden: true, textContent:
  "Restoring also replaces this phone's messaging address, profiles and notes with the ones in the file. If your LNS name points at this phone's messaging address now, messages to it stop arriving here." });
if ($("rs-warn")) $("rs-warn").after(rsMsg);
const BK_WHAT = $("bk-what") ? $("bk-what").textContent : "", BK_WHO = $("bk-who") ? $("bk-who").textContent : "";
function renderBackupCopy() {
  const on = !!(status && status.key);
  if ($("bk-what")) $("bk-what").textContent = on ? "Saves this wallet, your messaging address and your chats as an encrypted file. The file is locked with a backup password you choose here, not your PIN. Use a long one you won't forget." : BK_WHAT;
  if ($("bk-who")) $("bk-who").textContent = on ? "Anyone with the file and its password controls this wallet, can read your chats and can send messages as you." : BK_WHO;
  rsMsg.hidden = !on;
}
/** Once, while no LNS name is linked: a small hint that can be closed for good. */
function renderHint() {
  const h = $("mg-hint"), ui = chat.store.ui || {};
  h.hidden = !!me.name || !!ui.nameHint || view !== "home";
  if (h.hidden) return;
  const go = el("button", { type: "button", className: "lnk", textContent: "Messages settings" });
  go.addEventListener("click", () => { openMsgSettings(); mgsOpen("name"); });
  const x = el("button", { type: "button", className: "x", ariaLabel: "Close the hint" }, svg(P.close, 18));
  x.addEventListener("click", async () => { h.hidden = true; try { await chat.mutate(st => { st.ui = Object.assign({}, st.ui, { nameHint: true }); }); } catch (e) {} });
  h.replaceChildren(el("p", {}, "People can write to you at your messaging address. To be found by your LNS name, link it in ", go, "."), x);
}
function updateBadge() {
  const n = chat && unlocked() ? chat.unreadTotal() : 0;
  badge.hidden = !n; badge.textContent = n > 99 ? "99+" : String(n);
  navMsg.setAttribute("aria-label", n ? `Messages, ${n} unread` : "Messages");
}
$("mg-me").addEventListener("click", openMsgSettings);
const cardOf = pid => { const c = chat && !isAddressId(pid) && chat.chainOf(pid); return c ? { avatar: c.avatar, color: c.color } : {}; };
/** A conversation's icon; a grey "?" for messages that didn't come from the name they claim. */
const convoIcon = (c, size) => c.unverified ? icon("", { key: "", size, letters: "?", color: "#6d6960" })
  : c.kind === "direct" ? iconOf(chat.peer(c), size) : icon(c.title, { key: c.id, size });
/** A person's icon: generated from the name (or address) and the pinned key, or the name's own picture. */
const iconOf = (pid, size, key) => isAddressId(pid)
  ? icon("", { key: pid.slice(2), size, letters: ((chat.profile(pid) || {}).nickname || "#").slice(0, 1).toUpperCase() })
  : icon(pid, { key: key ?? (chat.pinned(pid) || ""), size, ...cardOf(pid) });

const dayKey = t => { const d = new Date(t); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
function shortWhen(t) {
  const d = new Date(t), now = new Date();
  if (dayKey(t) === dayKey(now)) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(t) === dayKey(y)) return "Yesterday";
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
function preview(c) {
  const m = c.last;
  if (!m) return { text: "No messages yet", warn: false };
  const t = m.text.replace(/\s+/g, " ");
  if (m.dir === "out") {
    const st = sendState(m);
    return { text: (st.bad ? "Not sent: " : "You: ") + t, warn: st.bad };
  }
  const trust = chat.trust(m);
  if (c.convo.unverified) return { text: t, warn: true };         // the title already says it
  if (trust === "unverified") return { text: "Not verified: " + t, warn: true };
  if (c.convo.kind !== "direct") return { text: chat.label(m.sender) + ": " + t, warn: false };
  return { text: t, warn: false };
}
function renderList() {
  const list = chat.conversations();
  const box = $("mg-rows");
  if (!list.length) {
    const go = el("button", { type: "button", className: "primary", textContent: "Start a chat" });
    go.addEventListener("click", openNew);
    box.replaceChildren(el("div", { className: "empty" }, el("div", { className: "art" }, svg(P.chat, 36)),
      el("h3", { textContent: "No chats yet" }),
      el("p", { textContent: "Write to anyone by LNS name or messaging address. When someone writes to " + (me.name || "you") + ", the chat shows up here." }), go));
    return;
  }
  box.replaceChildren(...list.map(c => {
    const pv = preview(c), id = c.convo.id;
    const time = el("span", { className: "ct" + (c.unread && !c.muted ? " new" : "") }, c.muted ? svg(P.mute, 14) : null, c.last ? shortWhen(c.last.ts) : "");
    const count = c.unread ? el("span", { className: "badge" + (c.muted ? " quiet" : ""), textContent: c.unread > 99 ? "99+" : String(c.unread) }) : null;
    const row = el("button", { type: "button", className: "crow" },
      convoIcon(c.convo, 48),
      el("span", { className: "cb" },
        el("span", { className: "cl" }, el("span", { className: "cn", textContent: c.title }), time),
        el("span", { className: "cl" }, el("span", { className: "cp" + (pv.warn ? " warn" : ""), textContent: c.blocked ? "Blocked" : pv.text }), count)));
    row.setAttribute("aria-label", `${c.title}${c.unread ? `, ${c.unread} unread` : ""}`);
    row.addEventListener("click", () => openConvo(id));
    return row;
  }));
  // chats whose names haven't been read from the chain yet: read them, for pictures and key checks
  const again = () => { if (view === "home" && !cv.id) render(); };
  for (const c of list) for (const m of c.convo.members) if (m.name && !chat.chainOf(m.name)) chat.lookup(m.name).then(again).catch(() => {});
  // a "Not verified" row may only be one the name service couldn't be asked about yet
  for (const c of list) if (c.convo.unverified && !isAddressId(c.convo.claimed) && !chat.chainOf(c.convo.claimed)) chat.lookup(c.convo.claimed).then(() => chat.sync()).then(again).catch(() => {});
}

// ---- new chat ------------------------------------------------------------------------------------------
function openNew() {
  view = "new"; render(); $("mg-found").replaceChildren(); $("mg-to").value = ""; $("mg-to").focus();
  pushOv("new", () => { view = "home"; $("mg-newv").hidden = true; render(); });
}
$("mg-new").addEventListener("click", openNew);
// Scan (inside the Android app): a messaging address fills the box and is looked up, as if typed; never sends.
// A wallet address, or anything else, only gets a message.
const findNow = text => { $("mg-to").value = text; $("mg-find").requestSubmit(); };
const scanSay = text => { findSeq++; $("mg-found").replaceChildren(el("p", { className: "msg bad", textContent: text })); };   // a lookup still running doesn't overwrite it
$("mg-scan").hidden = !SCAN;
$("mg-scan").addEventListener("click", () => {
  const started = startScan({
    ok: text => {
      const p = parseScan(text);
      if (p.error) return scanSay(p.error);
      if (p.kind === "wallet") return scanSay("That's a wallet address, for coins, not a messaging address. To pay them, use Send in the wallet. To write to them, ask for their messaging address or LNS name.");
      if (p.kind !== "msg") return scanSay("That's a LEZ account, not a messaging address. To send LEZ to it, use the Wallet.");
      findNow("msg:" + p.value);
    },
    fail: scanSay });
  if (!started) scanSay("The scanner didn't open. Type or paste the address instead.");
});
window.logosOpenNewChat = async text => { setTab("msg"); await refresh(); if (chat && chat.ready) { openNew(); findNow(text); } };
let findSeq = 0;                      // only the latest lookup may fill the result
$("mg-find").addEventListener("submit", async e => {
  e.preventDefault();
  const seq = ++findSeq;
  const lib = await namesLib(), real = $("mg-found");
  const box = { replaceChildren: (...k) => { if (seq === findSeq) real.replaceChildren(...k); }, append: (...k) => { if (seq === findSeq) real.append(...k); } };
  const say = (cls, text) => box.replaceChildren(el("p", { className: "msg " + cls, textContent: text }));
  const typed = $("mg-to").value;
  // a messaging address (not a wallet address)
  const walletKeys = (typeof accts !== "undefined" ? accts : []).map(x => x.key);
  const addr = parseAddress(typed, walletKeys);
  if (addr && addr.wallet) return say("bad", "That looks like a wallet address, not a messaging address. Ask them for their messaging address or LNS name.");
  if (addr && addr.bad) return say("bad", "That isn't a valid messaging address. Ask them to copy it again from their Messages settings.");
  if (addr) {
    if (addr.address === me.public) return say("bad", "That's your own messaging address.");
    const pid = "k:" + addr.address, open = chat.convo(chat.thread(pid));
    const lines = [el("div", { className: "found" }, iconOf(pid, 64),
      el("div", {}, el("b", { textContent: (chat.profile(pid) || {}).nickname || "Unnamed contact" }), el("small", { textContent: "No LNS name" })))];
    if (!addr.sure) lines.push(el("p", { className: "msg warn", textContent: "Check this is their messaging address, not a wallet address: both are 64 characters. A messaging address copied from Messages starts with msg:." }));
    const nick = el("input", { type: "text", id: "mg-nick", maxLength: 40, placeholder: "Unnamed contact", value: (chat.profile(pid) || {}).nickname || "" });
    if (!open) lines.push(el("label", { htmlFor: "mg-nick", textContent: "What should we call them?" }), nick);
    const go = el("button", { type: "button", className: "primary", textContent: open ? "Open chat" : "Start chat" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        const id = await chat.startAddress(addr.address);
        if (!open && nick.value.trim()) await chat.setProfile(pid, { nickname: nick.value.trim() });
        openConvo(id, true);
      }
      catch (err) { go.disabled = false; box.append(el("p", { className: "msg bad", textContent: err.message })); }
    });
    lines.push(go);
    return box.replaceChildren(...lines);
  }
  // an LNS name
  const name = lib.normalizeName(typed);
  if (!name) return say("bad", "Type an LNS name, like alice, or paste a messaging address.");
  if (!lib.isValidName(name)) return say("bad", name + " isn't an LNS name (1 to 32 letters a-z, digits and inner hyphens) or a messaging address.");
  $("mg-look").disabled = true; say("", "Looking up " + name + "… this takes a few seconds.");
  let c;
  try { c = await chat.lookup(name, true); }
  catch (err) { return say("bad", "Couldn't reach the name service. Try again."); }
  finally { $("mg-look").disabled = false; }
  if (!c.registered) return say("bad", name + " isn't a registered name.");
  const lines = [];
  let state;
  if (!c.key) state = name + " hasn't turned on messages.";
  else if (name === me.name) state = "This is you: a chat with yourself, for notes.";
  else state = c.display ? c.display + " · messages on" : "Messages on";
  lines.push(el("div", { className: "found" }, iconOf(name, 64, c.key || ""), el("div", {}, el("b", { textContent: name }), el("small", { textContent: state }))));
  if (c.lapsed) lines.push(el("p", { className: "msg warn", textContent: name + "'s registration has lapsed; it may change hands." }));
  const known = chat.pinned(name);
  if (known && c.key && known !== c.key) lines.push(el("p", { className: "msg warn", textContent: name + "'s messaging address changed since you last talked. The chat will ask you to accept it." }));
  if (!c.key) lines.push(el("p", { className: "note", textContent: name + " can't get messages by name yet. Ask " + name + " for their messaging address." }));
  const merge = c.key && chat.addressChatFor(c.key);
  if (merge) {
    const mg = el("button", { type: "button", className: "primary", textContent: "Merge into " + name });
    mg.addEventListener("click", async () => {
      mg.disabled = true;
      try { openConvo(await chat.mergeAddress(c.key, name), true); }
      catch (err) { mg.disabled = false; box.append(el("p", { className: "msg bad", textContent: err.message })); }
    });
    lines.push(el("p", { className: "msg ok", textContent: "You already chat with " + chat.label(merge) + ", and that is " + name + "'s messaging address. Merge that chat into " + name + "?" }), mg);
  } else if (c.key) {
    const go = el("button", { type: "button", className: "primary", textContent: chat.convo(convoIdOf(name)) ? "Open chat" : "Start chat" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      try { openConvo(await chat.startDirect(name), true); }
      catch (err) { go.disabled = false; box.append(el("p", { className: "msg bad", textContent: err.message })); }
    });
    lines.push(go);
  }
  box.replaceChildren(...lines);
});

// ---- your messaging: name and setup ---------------------------------------------------------------------
// ---- the name this phone holds itself (Settings > Your name, /lns/lns.js), when there: no typing, no command ----
// The one action is Your name's own "Point it at my messages" (window.LNS.pointMsg); whether it is pointed here is
// read from the name service, as for any name. Once it is, it becomes the name messages are sent under. A name
// held elsewhere keeps the manual way, folded.
let own = null;            // { name, running } of the phone's own name; null without Your name
async function ownCheck(fresh) {
  const box = $("mg-own"), m = $("mg-own-m"), go = $("mg-own-go");
  const ln = window.LNS && window.LNS.own ? await window.LNS.own() : null;
  $("mg-else").firstElementChild.hidden = !ln;                    // a fold only beside the phone's own name
  if (!ln) { own = null; box.hidden = true; $("mg-else").open = true; return; }
  if (own === null) $("mg-else").open = false;    // folded when first shown beside the phone's own name
  own = { name: ln.name || "", running: ln.running }; box.hidden = false; m.className = "msg"; go.hidden = true;
  if (!me || !chat) return;
  if (!own.name) { m.textContent = "No LNS name yet."; go.textContent = "Get a name"; go.hidden = false; go.onclick = () => openSettings("s-lns", "lns-in"); return; }
  if (own.running) { m.textContent = "Pointing " + own.name + " at this phone…"; return; }
  let c = null;
  try { c = await chat.lookup(own.name, fresh); } catch (e) {}
  if (!c) { m.className = "msg bad"; m.textContent = "Couldn't reach the name service."; return; }
  if (c.key === me.public) {
    m.className = "msg ok"; m.textContent = own.name + " · messages come to this phone";
    if (me.name !== own.name) {                   // the name service says so: messages go out under it
      const r = await api("/api/messages/name", { name: own.name });
      if (!locked401(r) && r.ok) { me.name = own.name; $("mg-name").value = own.name; msgRows(); }
    }
    return;
  }
  m.textContent = own.name + " isn't used for messages yet.";
  go.textContent = "Use " + own.name + " for messages"; go.hidden = false;
  go.onclick = async () => { go.disabled = true; const ok = await window.LNS.pointMsg(); go.disabled = false; if (ok) ownFollow(); };
}
async function ownFollow() {          // until the change has finished, then the name service again
  await ownCheck(false);
  if (own && own.running) setTimeout(ownFollow, 4000); else ownCheck(true);
}
/** Whether `name` points its msg entry at this phone, per the name service (Your name shows the same). */
window.msgPointsHere = async name => { if (!chat || !me || !name) return null; try { return (await chat.lookup(name, false)).key === me.public; } catch (e) { return null; } };
function openMe() {
  $("mg-name").value = me.name; $("mg-name-m").textContent = ""; $("mg-addr-m").textContent = "";
  $("mg-cmd").textContent = `names set-text ${me.name || "<yourname>"} msg ${me.public}`;
  $("mg-addr").textContent = shareable(me.public); $("mg-addr").hidden = true; $("mg-addr-qr").hidden = true; $("mg-addr-qr").replaceChildren();
  $("mg-addr-show").textContent = "Show"; $("mg-addr-show").setAttribute("aria-expanded", "false");
  checkMine(false); ownCheck(false);
}
async function checkMine(fresh) {
  const m = $("mg-check-m"); m.className = "msg"; m.textContent = "";
  if (!me.name) { m.textContent = "No name yet."; $("mg-link").open = false; return; }
  m.textContent = "Checking " + me.name + "…";
  let c;
  try { c = await chat.lookup(me.name, fresh); } catch (e) { return void (m.className = "msg bad", m.textContent = "Couldn't reach the name service."); }
  if (!c.registered) return void (m.className = "msg bad", m.textContent = me.name + " isn't a registered name.");
  if (c.key === me.public) { m.className = "msg ok"; m.textContent = me.name + ", linked to this phone."; $("mg-link").open = false; return; }
  m.className = "msg warn";
  m.textContent = c.key ? me.name + " is linked to another phone or app. Until you link it here, people see your messages as from your messaging address."
                        : me.name + " isn't linked yet. Until it is, people see your messages as from your messaging address.";
}
$("mg-addr-show").addEventListener("click", () => {
  const show = $("mg-addr").hidden, qr = $("mg-addr-qr");
  $("mg-addr").hidden = !show; qr.hidden = !show;
  $("mg-addr-show").textContent = show ? "Hide" : "Show"; $("mg-addr-show").setAttribute("aria-expanded", String(show));
  qr.replaceChildren();
  if (show && me) { const text = shareable(me.public); qrSvg(text).then(q => { if (!qr.hidden && me && shareable(me.public) === text) qr.replaceChildren(q); }).catch(() => {}); }
});
$("mg-addr-copy").addEventListener("click", async () => {
  const m = $("mg-addr-m");
  try { await navigator.clipboard.writeText(shareable(me.public)); m.className = "msg ok"; m.textContent = "Copied. Send it to whoever should be able to write to you."; }
  catch (e) { $("mg-addr").hidden = false; m.className = "msg"; m.textContent = "Couldn't copy: select it above."; }
});
$("mg-name-save").addEventListener("click", async () => {
  const lib = await namesLib(), m = $("mg-name-m");
  const name = lib.normalizeName($("mg-name").value);
  m.className = "msg"; m.textContent = "";
  if (name && !lib.isValidName(name)) return void (m.className = "msg bad", m.textContent = "That isn't an LNS name.");
  const r = await api("/api/messages/name", { name });
  if (locked401(r)) return;
  if (!r.ok) return void (m.className = "msg bad", m.textContent = r.data.error || "Couldn't save it.");
  me.name = name; openMe();
  m.className = "msg"; m.textContent = "";
  checkMine(true);
});
$("mg-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("mg-cmd").textContent); $("mg-copy").textContent = "Copied"; }
  catch (e) { $("mg-copy").textContent = "Select it above"; }
  setTimeout(() => { $("mg-copy").textContent = "Copy command"; }, 2000);
});
$("mg-check").addEventListener("click", () => checkMine(true));
$("mg-on").addEventListener("click", async () => {
  const id = newIdentity();
  const r = await api("/api/messages/key", { seed: toHex(id.seed), secret: toHex(id.secretKey), public: toHex(id.publicKey) });
  if (locked401(r)) return;
  if (!r.ok) return void ($("mg-on-m").textContent = r.data.error || "Couldn't turn messages on.");
  await refresh(); home();
});

// ---- overlays: a conversation, a profile, a sheet; the phone's back button closes them --------------------
const stack = [];
function pushOv(name, close) { stack.push({ name, close }); history.pushState({ mg: name }, ""); }
/** Replaces the top overlay (New chat) with another (the chat it started), in the same history step. */
function swapOv(name, close) { const top = stack.pop(); if (top) top.close(); stack.push({ name, close }); history.replaceState({ mg: name }, ""); }
function popOv(fromHistory = false) {
  const top = stack.pop(); if (!top) return;
  top.close();
  if (!fromHistory) { ignorePop++; history.back(); }
}
let ignorePop = 0;
addEventListener("popstate", () => { if (ignorePop) { ignorePop--; return; } if (stack.length) popOv(true); });
function closeAll() { while (stack.length) popOv(); }

// ---- a conversation --------------------------------------------------------------------------------------
const cv = { id: null, node: null };
function openConvo(id, fromNew = false) {
  if (cv.id) popOv();
  cv.id = id;
  const back = el("button", { type: "button", className: "back", ariaLabel: "Back", title: "Back" }, svg(P.back));
  back.addEventListener("click", () => popOv());
  const who = el("button", { type: "button", className: "who" });
  who.addEventListener("click", () => { const c = chat.convo(cv.id); if (c && c.kind === "direct" && !c.unverified) openProfile(chat.peer(c)); });
  const ban = el("div", { className: "cv-ban", hidden: true });
  const inner = el("div", { className: "cv-in" });
  const scroll = el("div", { className: "cv-scroll" }, inner);
  const ta = el("textarea", { rows: 1, maxLength: MAX_TEXT, placeholder: "Message", ariaLabel: "Message" });
  ta.setAttribute("enterkeyhint", "send");
  const go = el("button", { type: "button", className: "go", ariaLabel: "Send", disabled: true }, svg(P.send, 22));
  const count = el("span", { className: "count", hidden: true });
  const cmp = el("form", { className: "cmp" }, el("div", { className: "wrap" }, ta, count, go));
  const note = el("div", { className: "cmp-note", hidden: true });
  const box = el("div", { className: "ov", role: "dialog", ariaModal: "true" }, el("div", { className: "ov-top bar" }, back, who), ban, scroll, cmp, note);
  cv.node = { box, who, ban, inner, scroll, ta, go, cmp, note, count, blocker: null };
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 3, 150) + "px";
    go.disabled = !ta.value.trim() || !!cv.node.blocker; const left = MAX_TEXT - ta.value.length;
    count.hidden = left > 200; count.textContent = String(left); };
  ta.addEventListener("input", grow);
  cmp.addEventListener("submit", e => { e.preventDefault(); sendNow(); });
  go.addEventListener("click", sendNow);
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); sendNow(); } });
  document.body.append(box);
  const closeCv = () => { box.remove(); cv.id = null; cv.node = null; if (tab === "msg") render(); };
  if (fromNew && stack.length && stack[stack.length - 1].name === "new") swapOv("cv", closeCv); else pushOv("cv", closeCv);
  renderConvo(true); checkSend(true);
  if (!matchMedia("(pointer:coarse)").matches) ta.focus();
}
async function sendNow() {
  const n = cv.node; if (!n) return;
  const text = n.ta.value;
  if (!text.trim() || n.blocker) return;
  n.go.disabled = true;
  try {
    await chat.send(cv.id, text);
    n.ta.value = ""; n.ta.style.height = ""; n.count.hidden = true;
    renderConvo(true);
  } catch (e) {
    if (e.status === 401) return lockedNow();
    if (e.code) checkSend(false); else sheetNote("Not sent", e.message || "The message wasn't sent.");
  } finally { if (cv.node) cv.node.go.disabled = !cv.node.ta.value.trim() || !!cv.node.blocker; }
}
/** Whether this chat can send now: a banner or a note instead of the composer when it can't. */
async function checkSend(fresh) {
  const id = cv.id; if (!id) return;
  const why = await chat.sendBlocker(id, fresh).catch(() => ({ code: "offline", text: "Couldn't reach the name service." }));
  if (cv.id !== id || !cv.node) return;
  const n = cv.node; n.blocker = why && why.code !== "offline" ? why : null;
  n.ban.hidden = true; n.note.hidden = true; n.cmp.hidden = false;
  if (why && why.code === "changed") {
    const accept = el("button", { type: "button", textContent: "Accept the change" });
    const look = el("button", { type: "button", textContent: "View profile" });
    accept.addEventListener("click", async () => { accept.disabled = true; try { await chat.acceptKey(why.name); } catch (e) {} checkSend(true); renderConvo(); });
    look.addEventListener("click", () => openProfile(why.name));
    n.ban.replaceChildren(el("p", {}, el("b", { textContent: why.name + "'s messaging address changed." }),
      " That happens when they set up a new phone, or when someone else took over the name. Check with " + why.name + " another way if you can. Until you accept it, nothing is sent to the new address, and messages from it are marked."),
      el("div", { className: "row" }, look, accept));
    n.ban.hidden = false; n.cmp.hidden = true;
  } else if (why && why.code === "blocked") {
    const un = el("button", { type: "button", textContent: "Unblock" });
    un.addEventListener("click", async () => { await chat.setProfile(why.name, { blocked: false }); checkSend(false); renderConvo(); });
    n.note.replaceChildren(why.text, un); n.note.hidden = false; n.cmp.hidden = true;
  } else if (why && why.code !== "offline") {
    n.note.replaceChildren(why.code === "unverified" ? why.text : why.text + " Messages can't be sent to them now."); n.note.hidden = false; n.cmp.hidden = true;
  }
  n.go.disabled = !n.ta.value.trim() || !!n.blocker;
  renderWho();
}
function renderWho() {
  const c = chat.convo(cv.id), n = cv.node; if (!c || !n) return;
  const pid = c.kind === "direct" ? chat.peer(c) : null;
  const p = pid && chat.profile(pid), st = pid && chat.keyState(pid);
  let sub = c.members.length + " people", cls = "";
  if (c.unverified) { sub = "Not verified"; cls = "warn"; }
  else if (pid && isAddressId(pid)) sub = "No LNS name";
  else if (pid) {
    if (st.changed) { sub = "Address changed"; cls = "warn"; }
    else if (st.chain === null) { sub = "Messages off"; cls = "warn"; }
    else sub = p && p.nickname ? pid : "";
  }
  n.who.replaceChildren(convoIcon(c, 40),
    el("span", { className: "t" }, el("b", { textContent: chat.title(c) }), el("small", { className: cls, textContent: sub })));
}
const STATES = { queued: "Waiting to send", sending: "Sending", propagated: "Sent", sent: "Sent", failed: "Not sent" };
function sendState(m) {
  const s = m.sends.map(x => x.state);
  if (s.includes("failed")) return { text: "Not sent", bad: true };
  if (s.every(x => x === "sent" || x === "propagated")) return { done: true, label: "Sent", bad: false };
  return { wait: true, label: status && status.node.reachable === false ? "Sends when you're back online" : "Sending", bad: false };
}
function renderConvo(toBottom = false) {
  const n = cv.node; if (!n || !chat) return;
  const c = chat.convo(cv.id);
  if (!c) return popOv();
  renderWho();
  const near = toBottom || n.scroll.scrollHeight - n.scroll.scrollTop - n.scroll.clientHeight < 80;
  const list = chat.messages(cv.id);
  const kids = [];
  if (!list.length) {
    const pid = c.kind === "direct" ? chat.peer(c) : null;
    kids.push(el("div", { className: "cv-empty" }, el("p", { style: "margin:0", textContent: "Say hello. Only " + (pid ? chat.label(pid) : "the people in this chat") + " can read this." })));
  }
  let lastDay = null, prev = null;
  list.forEach((m, i) => {
    const d = dayKey(m.ts);
    if (d !== lastDay) { kids.push(el("div", { className: "day", textContent: dayLabel(m.ts) })); lastDay = d; prev = null; }
    const next = list[i + 1];
    const cont = prev && prev.dir === m.dir && prev.sender === m.sender && m.ts - prev.ts < 300000;
    const endRun = !next || next.dir !== m.dir || next.sender !== m.sender || next.ts - m.ts >= 300000 || dayKey(next.ts) !== d;
    const trust = chat.trust(m);
    const bub = el("button", { type: "button", className: `bub ${m.dir}${cont ? " cont" : ""}${trust === "unverified" ? " unv" : ""}`, textContent: m.text });
    bub.addEventListener("click", () => details(m));
    kids.push(bub);
    if (m.dir === "in" && trust !== "ok" && trust !== "address") {
      const who = chat.label(m.sender);
      kids.push(el("div", { className: "meta in note-w" }, svg(P.warn, 16), el("span", { textContent:
        trust === "unverified" ? "Not verified: this didn't come from " + who + "'s messaging address" :
        trust === "old" ? "From " + who + "'s earlier messaging address" : "From " + who + "'s new messaging address, not accepted yet" })));
    }
    const st = m.dir === "out" ? sendState(m) : null;
    if (endRun || (st && !st.done)) {
      const meta = el("div", { className: "meta " + m.dir }, el("span", { textContent: new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }));
      if (st) {
        if (st.bad) meta.append(el("span", { className: "bad", textContent: st.text }));
        else { const ic = svg(st.done ? P.tick : P.clock, 15); ic.setAttribute("role", "img"); ic.setAttribute("aria-label", st.label); ic.title = st.label; meta.append(ic); }
        if (st.bad && m.sends.some(x => x.state === "failed" && x.resend)) { const r = el("button", { type: "button", textContent: "Retry" }); r.addEventListener("click", async () => { r.disabled = true; await chat.retry(m.n); renderConvo(); }); meta.append(r); }
        else if (st.bad) meta.append(el("span", { textContent: "Restored from a backup; it can't be sent again." }));
      }
      kids.push(meta);
    }
    prev = m;
  });
  n.inner.replaceChildren(...kids);
  if (near) n.scroll.scrollTop = n.scroll.scrollHeight;
  const unread = list.some(m => m.dir === "in" && chat.unread.has(m.n));
  if (unread && document.visibilityState === "visible") chat.markRead(cv.id).then(updateBadge);
}
function dayLabel(t) {
  const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(t) === dayKey(now)) return "Today";
  if (dayKey(t) === dayKey(y)) return "Yesterday";
  const d = new Date(t);
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
const fullWhen = t => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// ---- a sheet from the bottom: message details, confirmations ------------------------------------------
function sheet(build) {
  const card = el("div", { className: "sheet", role: "dialog", ariaModal: "true" });
  const bg = el("div", { className: "sheet-bg" }, card);
  bg.addEventListener("click", e => { if (e.target === bg) popOv(); });
  build(card, () => popOv());
  document.body.append(bg);
  pushOv("sheet", () => bg.remove());
  const f = card.querySelector("button"); f && f.focus();
}
function sheetNote(title, text) {
  sheet((card, close) => { const ok = el("button", { type: "button", className: "primary", textContent: "OK" }); ok.addEventListener("click", close);
    card.append(el("h2", { textContent: title }), el("p", { className: "note", textContent: text }), ok); });
}
function confirmSheet(title, text, yes, danger, act) {
  sheet((card, close) => {
    const no = el("button", { type: "button", textContent: "Cancel" }), go = el("button", { type: "button", className: danger ? "danger" : "primary", textContent: yes });
    go.style.marginTop = "0"; no.addEventListener("click", close);
    go.addEventListener("click", async () => { go.disabled = true; close(); await act(); });
    card.append(el("h2", { textContent: title }), el("p", { className: "note", textContent: text }), el("div", { className: "row" }, no, go));
  });
}
function details(m) {
  sheet((card, close) => {
    const rows = [];
    const row = (k, v, cls) => rows.push(el("div", {}, el("dt", { textContent: k }), el("dd", { className: cls || "", textContent: v })));
    if (m.dir === "out") {
      row("Written", fullWhen(m.ts));
      m.to.forEach((t, i) => {
        const x = m.sends[i] || {};
        row("To " + chat.label(t.name || "k:" + t.key), (STATES[x.state] || x.state) + (x.error ? ": " + x.error : ""));
      });
    } else {
      const trust = chat.trust(m), who = chat.label(m.sender);
      row("From", who);
      row("Written", fullWhen(m.ts));
      row("Arrived", fullWhen(m.received) + (m.source === "history" ? " (caught up later)" : ""));
      if (trust !== "ok" && trust !== "address") row("Checked", trust === "old" ? "From " + who + "'s earlier address" : trust === "new-key" ? "From " + who + "'s new address, not accepted" : "Not verified");
    }
    const copy = el("button", { type: "button", textContent: "Copy text" });
    copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(m.text); copy.textContent = "Copied"; } catch (e) { copy.textContent = "Can't copy"; } });
    const del = el("button", { type: "button", className: "danger", textContent: "Delete" });
    del.style.marginTop = "0";
    del.addEventListener("click", async () => { close(); await chat.deleteMessage(m); renderConvo(); });
    let help = "Deleting removes it from this phone only.";
    if (m.dir === "out") {        // what the app knows, and nothing more: never that it was delivered or read
      const one = m.to.length === 1, who = one ? chat.label(m.to[0].name || "k:" + m.to[0].key) : "they", st = sendState(m);
      const reads = " This app can't tell when " + who + (one ? " reads" : " read") + " it.";
      help = (st.bad ? "Not sent."
        : st.done && m.sends.every(x => x.state === "sent") ? "Sent. The network holds it so " + who + (one ? " gets" : " get") + " it next time they're online." + reads
        : st.done ? "Sent: it reached the network." + reads
        : status && status.node.reachable === false ? "Not sent yet. It goes when you're back online." : "Sending.") + " " + help;
    }
    card.append(el("h2", { textContent: m.dir === "out" ? "Your message" : "Message from " + chat.label(m.sender) }),
      el("div", { className: "quote", textContent: m.text }), el("dl", {}, ...rows), el("p", { className: "note", textContent: help }),
      el("div", { className: "row" }, copy, del));
  });
}

// ---- a profile -----------------------------------------------------------------------------------------
const pv = { name: null, node: null };
function openProfile(name) {
  if (pv.name) popOv();
  pv.name = name;
  const back = el("button", { type: "button", className: "back", ariaLabel: "Back", title: "Back" }, svg(P.back));
  back.addEventListener("click", () => popOv());
  const inner = el("div", { className: "pv-in" });
  const box = el("div", { className: "ov", role: "dialog", ariaModal: "true", ariaLabel: "Profile" },
    el("div", { className: "ov-top bar" }, back, el("h2", { className: "bar-t", textContent: "Profile" })), el("div", { className: "pv-scroll" }, inner));
  pv.node = { box, inner };
  document.body.append(box);
  pushOv("pv", () => { box.remove(); pv.name = null; pv.node = null; });
  renderProfile();
  if (!isAddressId(name)) chat.lookup(name, true).then(() => { if (pv.name === name) renderProfile(); if (cv.id) { renderWho(); } }).catch(() => {});
}
function renderProfile() {
  const pid = pv.name, n = pv.node; if (!pid || !n) return;
  const addr = isAddressId(pid), label = chat.label(pid);
  const p = chat.profile(pid) || chat.newProfile(pid, null), c = chat.chainOf(pid), st = chat.keyState(pid);
  let state = ["", ""];
  if (addr) state = ["", "No LNS name"];
  else if (c) {
    if (!c.registered) state = ["bad", "Not a registered name"];
    else if (st.changed) state = ["warn", "Address changed"];
    else if (!c.key) state = ["warn", "Messages off"];
  }                               // all fine: nothing is said (problems only)
  const head = el("div", { className: "pv-head" }, iconOf(pid, 96),
    el("h3", { textContent: label }),
    !addr && p.nickname ? el("p", { textContent: pid }) : null,
    addr ? el("p", { className: "fp", textContent: shortFp(pid.slice(2)) }) : null,
    c && c.display && c.display !== pid ? el("p", { textContent: c.display }) : null,
    state[1] ? el("span", { className: "state " + state[0], textContent: state[1] }) : null);
  const parts = [head];
  if (st.changed) {
    const acc = el("button", { type: "button", textContent: "Accept the change", style: "width:100%;margin-top:14px" });
    acc.addEventListener("click", async () => { acc.disabled = true; await chat.acceptKey(pid).catch(() => {}); renderProfile(); if (cv.id) checkSend(true); });
    parts.push(el("section", { className: "card" }, el("p", { className: "msg warn", style: "margin:0", textContent: pid + "'s messaging address changed. That happens with a new phone, or when someone else took over the name. Check with them another way if you can." }), acc));
  }
  // nickname and note: on this phone only; made once per profile view, so a redraw never touches typing
  if (!n.mine) n.mine = profileNotes(pid, p);
  parts.push(n.mine);
  // mute, block
  const sw = (on, text, sub, act) => {
    const b = el("button", { type: "button", className: "sw", role: "switch", ariaLabel: text });
    b.setAttribute("aria-checked", String(on));
    b.addEventListener("click", act);
    const row = el("div", { className: "tg" }, el("span", {}, text, el("small", { textContent: sub })), b);
    row.addEventListener("click", e => { if (e.target !== b) b.click(); });            // the whole row toggles
    return row;
  };
  parts.push(el("section", { className: "card" },
    sw(p.muted, "Mute", "No unread count.", async () => { await chat.setProfile(pid, { muted: !p.muted }); renderProfile(); }),
    sw(p.blocked, "Block", "Their messages are hidden and you can't write to them.", () => {
      if (p.blocked) return chat.setProfile(pid, { blocked: false }).then(() => { renderProfile(); if (cv.id) { checkSend(false); renderConvo(); } });
      confirmSheet("Block " + label + "?", "Messages from " + label + " are hidden from now on, and you can't write to them until you unblock.", "Block", true,
        async () => { await chat.setProfile(pid, { blocked: true }); renderProfile(); if (cv.id) { checkSend(false); renderConvo(); } });
    })));
  // details: the messaging address, short unless asked for
  const full = el("code", { className: "cmd", hidden: true, textContent: shareable(st.pinned || "") });
  const reveal = el("button", { type: "button", className: "small", textContent: "Show full address" });
  reveal.addEventListener("click", () => { full.hidden = !full.hidden; reveal.textContent = full.hidden ? "Show full address" : "Hide"; });
  const det = el("details", { className: "card", style: "padding:14px 16px" }, el("summary", { textContent: "Details" }),
    el("dl", { style: "margin-top:8px" },
      el("div", {}, el("dt", { textContent: "Messaging address" }), el("dd", { className: "fp", textContent: st.pinned ? shortFp(st.pinned) : "none yet" })),
      st.changed ? el("div", {}, el("dt", { textContent: "New messaging address" }), el("dd", { className: "fp", textContent: shortFp(st.chain) })) : null),
    st.pinned ? reveal : null, full,
    el("p", { className: "note", textContent: addr
      ? "Messages from this address prove they hold it; there's no name to check it against. Compare the short code with them if it matters."
      : "Kept from your first contact. If " + pid + "'s messaging address ever changes, the chat asks you to accept the change before anything is sent to it." }));
  parts.push(det);
  const delChat = el("button", { type: "button", className: "danger", textContent: "Delete chat" });
  delChat.addEventListener("click", () => confirmSheet("Delete the chat with " + label + "?", "Its messages are removed from this phone. The profile and note stay.", "Delete chat", true,
    async () => { await chat.deleteConversation(convoIdOf(pid), false); closeAll(); render(); }));
  const delAll = el("button", { type: "button", className: "danger", textContent: "Delete chat and profile" });
  delAll.addEventListener("click", () => confirmSheet("Delete " + label + "?", "The chat, the nickname and your note are removed from this phone.", "Delete", true,
    async () => { await chat.deleteConversation(convoIdOf(pid), true); closeAll(); render(); }));
  if (!chat.convo(convoIdOf(pid))) delChat.hidden = true;
  parts.push(delChat, delAll);
  n.inner.replaceChildren(...parts);
}
function profileNotes(name, p) {
  const nick = el("input", { type: "text", maxLength: 40, value: p.nickname || "", placeholder: isAddressId(name) ? "A name for this address" : name, id: "pv-nick" });
  nick.setAttribute("autocapitalize", "words");
  const note = el("textarea", { className: "note-f", maxLength: 4000, value: p.note || "", placeholder: "Anything you want to remember about " + chat.label(name) + ".", id: "pv-note" });
  const saved = el("p", { className: "saved", role: "status" });
  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    const cur = chat.profile(name) || {};
    if (nick.value.trim() === (cur.nickname || "") && note.value === (cur.note || "")) return;
    try { await chat.setProfile(name, { nickname: nick.value.trim(), note: note.value }); saved.textContent = "Saved"; }
    catch (e) { saved.textContent = ""; if (e.status === 401) lockedNow(); }
    if (cv.id) renderWho();
  };
  nick.addEventListener("change", save); note.addEventListener("blur", save);
  note.addEventListener("input", () => { saved.textContent = ""; clearTimeout(timer); timer = setTimeout(save, 1200); });
  const mine = el("section", { className: "card" }, el("h2", { textContent: "Nickname and note" }),
    el("label", { htmlFor: "pv-nick", textContent: "Nickname", style: "margin-top:0" }), nick,
    el("label", { htmlFor: "pv-note", textContent: "Private note" }), note, saved,
    el("p", { className: "hint", textContent: "Only you see this. Never sent." }));
  return mine;
}

// ---- the backup: message history goes along unless unticked --------------------------------------------
const hist = el("label", { style: "display:flex;gap:10px;align-items:flex-start;color:var(--ink);font-size:14px;margin-top:14px" },
  el("input", { type: "checkbox", id: "bk-hist", checked: true, style: "width:auto;min-height:0;margin-top:3px" }),
  el("span", {}, "Include message history ", el("span", { className: "hint", style: "display:block;margin:2px 0 0", textContent: "Up to 1 MB, newest first. Profiles and notes always go in. A large backup can't be restored by app versions before 0.9." })));
if ($("bk-pin")) $("bk-pin").previousElementSibling.before(hist);
const pageFetch2 = window.fetch;
window.fetch = (url, opt = {}) => {
  if (String(url) === "/api/wallet/backup" && opt.body && !$("bk-hist").checked) {
    try { opt = { ...opt, body: JSON.stringify({ ...JSON.parse(opt.body), history: false }) }; } catch (e) {}
  }
  return pageFetch2(url, opt);
};

// ---- keep it current --------------------------------------------------------------------------------------
let tick = 0;
setInterval(() => {                 // every 4 s on the Messages screen, every 16 s on the wallet (for the badge)
  if (!unlocked() || document.visibilityState !== "visible") return;
  if (tab === "msg" || cv.id || ++tick % 4 === 0) refresh().then(() => { if (cv.id && cv.node) checkSendLater(); });
}, 4000);
let lastCheck = 0;
function checkSendLater() { if (Date.now() - lastCheck > 60000) { lastCheck = Date.now(); checkSend(false); } }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && cv.id) renderConvo(); });
refresh();

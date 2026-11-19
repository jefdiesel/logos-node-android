// Collectibles' pure parts (app/net04/nft.js, NFT04CORE) without a browser: the LNS name card's size rule and line
// breaking, what it draws where (on a recording stand-in for the canvas), and the desktop wallet's words for NFTs.
//
//   node tests/nft04_test.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const ctx = { console };
ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(join(here, "..", "app", "net04", "nft.js"), "utf8"), ctx);
const C = ctx.NFT04CORE;
let fails = 0;
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && detail !== undefined ? " - " + JSON.stringify(detail).slice(0, 300) : "")); if (!ok) fails++; };

// ---- the size rule: 12 characters or fewer at 60 px, 13-32 at 36 px, at the 480 px reference size, scaled ----
const at = (n, w) => C.cardSize(n, w);
check("12 characters at 480 px: 60 px, line 63", at(12, 480).px === 60 && Math.abs(at(12, 480).line - 63) < 1e-9 && !at(12, 480).long);
check("1 character: 60 px too", at(1, 480).px === 60);
check("13 characters at 480 px: 36 px, line 41.4", at(13, 480).px === 36 && Math.abs(at(13, 480).line - 41.4) < 1e-9 && at(13, 480).long);
check("32 characters (the LNS maximum) at 480 px: 36 px", at(32, 480).px === 36);
check("scaled: 12 characters on a 328 px card (a 360 px phone) is 41 px", Math.abs(at(12, 328).px - 41) < 1e-9 && Math.abs(at(12, 328).scale - 328 / 480) < 1e-12);
check("scaled: 13 characters on a 328 px card is 24.6 px", Math.abs(at(13, 328).px - 24.6) < 1e-9);
check("scaled: 32 characters at 240 px is 18 px", at(32, 240).px === 18);
check("the break between the sizes is at 12/13 at every width", [200, 328, 358, 480, 960].every(w => Math.abs(at(12, w).px / at(13, w).px - 60 / 36) < 1e-12));

// ---- breaking: anywhere between two characters (word-break: break-all), never wider than the room ----
const mono = t => Array.from(t).length * 10;
check("a short name stays on one line", JSON.stringify(C.wrapName("alice", 400, mono)) === '["alice"]');
check("32 characters of 10 px in 160 px: two lines of 16", JSON.stringify(C.wrapName("averyveryverylongname-thirtytwo1", 160, mono)) === JSON.stringify(["averyveryverylon", "gname-thirtytwo1"]));
check("a line never goes past the room, and nothing is dropped", (() => { const n = "jefdiesel-studio"; const l = C.wrapName(n, 55, mono); return l.join("") === n && l.every(x => mono(x) <= 55); })());
check("a hyphen breaks like any other character", C.wrapName("ab-cd", 30, mono).join("|") === "ab-|cd");

// ---- what the card draws, on a stand-in canvas that records every call ----
function recorder(width) {
  const calls = [];
  const font = { px: 0, family: "" };
  const c = {
    calls, set font(v) { const m = /^([\d.]+)px "?([^",]+)"?/.exec(v); font.px = Number(m[1]); font.family = m[2]; calls.push(["font", v]); }, get font() { return ""; },
    fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "", textBaseline: "",
    save() {}, restore() {}, clearRect() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, stroke() {}, translate() {}, scale() {},
    fill() { calls.push(["fill", this.fillStyle]); }, fillRect(x, y, w, h) { calls.push(["rect", this.fillStyle, x, y, w, h]); },
    fillText(t, x, y) { calls.push(["text", t, x, y, font.px, font.family, this.fillStyle, this.textAlign]); },
    measureText(t) { return { width: Array.from(t).length * font.px * 0.5, fontBoundingBoxAscent: font.px * 0.9, fontBoundingBoxDescent: font.px * 0.25 }; },
  };
  return c;
}
for (const [name, w] of [["jefdiesel", 480], ["jefdiesel", 328], ["averyveryverylongname-thirtytwo1", 328]]) {
  const r = recorder(w), out = C.drawCard(r, name, w), s = w / 480;
  const texts = r.calls.filter(c => c[0] === "text");
  const nameRows = texts.filter(t => t[5] === "Gloock" && t[1] !== "λ");
  const lam = texts.find(t => t[1] === "λ"), foot = texts.find(t => t[1] === "nameswallet.app");
  const rule = r.calls.find(c => c[0] === "rect" && c[1] === "#ffd328");
  const px = Array.from(name).length > 12 ? 36 : 60;
  check(`${name} at ${w} px: the name in Gloock at ${px * s} px, off-white, from the left margin`, nameRows.length >= 1 && nameRows.every(t => Math.abs(t[4] - px * s) < 1e-9 && t[6] === "#f5f5ef" && Math.abs(t[2] - 40 * s) < 1e-9), nameRows);
  check(`${name} at ${w} px: every character drawn once, in order`, nameRows.map(t => t[1]).join("") === name);
  check(`${name} at ${w} px: λ top right in yellow, 30 px scaled`, !!lam && lam[6] === "#ffd328" && Math.abs(lam[2] - (w - 40 * s)) < 1e-9 && lam[7] === "right" && Math.abs(lam[4] - 30 * s) < 1e-9 && lam[3] < 100 * s, lam);
  check(`${name} at ${w} px: the yellow rule, 2 px, 96 px from the bottom, margin to margin`, !!rule && Math.abs(rule[2] - 40 * s) < 1e-9 && Math.abs(rule[3] - (w - 98 * s)) < 1e-9 && Math.abs(rule[4] - 400 * s) < 1e-9 && Math.abs(rule[5] - 2 * s) < 1e-9, rule);
  check(`${name} at ${w} px: nameswallet.app bottom right in Fira Code 14 px, dimmed`, !!foot && foot[5] === "NW Fira Code" && Math.abs(foot[4] - 14 * s) < 1e-9 && foot[7] === "right" && foot[6] === "rgba(245,245,239,0.7)" && Math.abs(foot[2] - (w - 40 * s)) < 1e-9, foot);
  check(`${name} at ${w} px: forest green #152521 under it all`, r.calls.find(c => c[0] === "fill")[1] === "#152521");
  check(`${name} at ${w} px: the name sits below the λ and above the rule`, nameRows.every(t => t[3] > lam[3] && t[3] < w - 98 * s));
  if (px === 36) check(`${name} at ${w} px: a long name wraps onto lines 41.4 px (scaled) apart`, out.lines.length >= 2 && nameRows.length === out.lines.length && Math.abs((nameRows[1][3] - nameRows[0][3]) - 41.4 * s) < 1e-6, out.lines);
}
check("the card carries no other words (no 'LNS NAME' label, no '1 of 1')", (() => { const r = recorder(480); C.drawCard(r, "alice", 480); return r.calls.filter(c => c[0] === "text").map(c => c[1]).join("|") === "λ|alice|nameswallet.app"; })());

// ---- the desktop wallet's words (basecamp/qml/nft.mjs) ----
check("a master with 3 print rights can print 2 more copies", C.tokenLine({ state: "master", print_balance: "3" }) === "Master · can print 2 more copies");
check("a master with 2: 1 more copy", C.tokenLine({ state: "master", print_balance: "2" }) === "Master · can print 1 more copy");
check("a master with 1: no prints left", C.tokenLine({ state: "master", print_balance: "1" }) === "Master · no prints left");
check("a copy is a Copy", C.tokenLine({ state: "copy" }) === "Copy");
check("a collection without a name: 'Unreadable collection <id>'", C.collectionTitle(null, "9iHYqfAbCdEfGhJkLmNoPqRsTuVwXyZ1i3Mv") === "Unreadable collection 9iHYqf…i3Mv");
check("a collection's metadata rows, a missing one 'none given'", JSON.stringify(C.metadataRows({ printable_supply: "3", standard: "Simple", uri: "", creators: "ada" }).map(r => r.value)) === '["3","Simple","none given","ada"]');
check("unreadable metadata says so", C.metadataRows(null)[0].value === "Can't be read: the wallet shows this NFT by its IDs only.");
check("held by 1 / 2 of your accounts", C.collectionLine({ title: "Harbour at dawn", count: 1 }) === "Harbour at dawn · held by 1 of your accounts" && C.collectionLine({ title: "X", count: 2 }) === "X · held by 2 of your accounts");
check("a collection's link is nft:<program>/<collection>", C.linkOf("P", "D") === "nft:P/D");
check("an account as a row shows it: Public CCVd76…pKnk", C.accountShown("CCVd76Tk3WvFb63Wbuu4exMeLRTbSuMWHqxuvysapKnk") === "Public CCVd76…pKnk");
// ---- the LNS record side against the names project's own resolver (app/names/names.js, vendored) ----
// tests/nft04_test.py checks lez04.py against the same constants: two implementations, one answer.
const N = await import(join(here, "..", "app", "names", "names.js"));
const ALICE = Uint8Array.from(Buffer.from("59e55bfca47501b434363785c0163c79637d69d3c7d0d01307a31c49dd193531", "hex"));  // `names address alice`
check("names.js: alice's record under 6Yxj… is 7zjvesfs… (as lez04.record_address and the names CLI say)",
  (await N.recordAddress("6Yxj5k8AiuBSuMAYVQFGrYKjJGUSSaWWgoB9D9XXN3gA", ALICE)) === "7zjvesfsRuXjx5b1a7bYjQvtFvGxNtH66cLgAPZ6m3MW");
check("names.js: the owner tag of alice for the phone's account is lez04.owner_tag's",
  (await N.ownerTag(ALICE, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")) === "b379ab75c5db642fee925cb72c6714f4c277027c96bbe5535c90642add9fb7f2");
const rec = N.decodeNameRecord(Uint8Array.from(Buffer.from("07" + "b379ab75c5db642fee925cb72c6714f4c277027c96bbe5535c90642add9fb7f2" + "15cd5b0700000000" + "06000000" + Buffer.from("sealed").toString("hex") + "00" + "00", "hex")));
check("names.js reads a record's version, owner tag, expiry and sealed bytes where lez04.decode_record does", rec.version === 7 && rec.ownerTag === "b379ab75c5db642fee925cb72c6714f4c277027c96bbe5535c90642add9fb7f2" && String(rec.expires) === "123456789" && Buffer.from(rec.sealed).toString() === "sealed", rec);
console.log(fails ? fails + " FAILED" : "all checks passed");
process.exit(fails ? 1 : 0);

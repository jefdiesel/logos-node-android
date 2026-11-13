// No green and no blue anywhere on a screen as shown: every visible element's computed colours (text, background,
// borders, outline, SVG fill and stroke, shadows) with hue 75-260 and any real saturation fails. Grey, ink, orange,
// ochre and red pass. tests/chat_ui.mjs and tests/lns_ui.mjs run it on each screen they photograph (the screenshots
// themselves only with SHOTS set); the first call proves it catches the old green.
export const HUE_JS = `(() => { const bad = [];
  const hue = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 20) return null;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  for (const e of document.querySelectorAll("body *")) {
    if (!e.getClientRects().length || e.closest("[hidden]")) continue;
    const cs = getComputedStyle(e); if (cs.visibility === "hidden") continue;
    const props = ["color", "backgroundColor", "fill", "stroke", "boxShadow", "textDecorationColor"];
    for (const s of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(cs["border" + s + "Width"]) > 0) props.push("border" + s + "Color");
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) props.push("outlineColor");
    for (const p of props) for (const m of String(cs[p]).matchAll(/rgba?\\(([^)]*)\\)/g)) {
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); if (a === 0) continue;
      const h = hue(r, g, b); if (h !== null && h >= 75 && h <= 260) bad.push((e.id || e.getAttribute("class") || e.tagName) + " " + p + " " + m[0]);
    }
  }
  return bad.slice(0, 5); })()`;

let proven = false;
export async function noGreenOrBlue(js, check, where) {
  if (!proven) {
    const caught = await js(`(() => { const i = document.createElement("i"); i.textContent = "x"; i.style.color = "#1d7448"; i.style.borderBottom = "2px solid #2b6cb0";
      document.body.append(i); const r = ${HUE_JS}; i.remove(); return r.length; })()`);
    check("the colour check catches the old green and blue", caught >= 2, caught);
    proven = true;
  }
  const bad = await js(HUE_JS);
  if (bad.length) check(where + ": no green or blue", false, bad);
}

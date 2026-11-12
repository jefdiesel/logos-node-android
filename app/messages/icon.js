// A person's icon: their name's avatar when the Names card has a safe inline one, otherwise one drawn
// here from the name and the messaging key pinned for it: a flat disc in one of 8 well-separated colours
// picked by a hash of both, and the name's first letter. Another key under the same name, or a look-alike
// name, usually gets another colour. A `color` entry on the card sets the colour.

import { sha256 } from "./noble-hashes/sha2.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// muted colours that hold white letters in light and dark mode
const PALETTE = ["#2b6cb0", "#2f855a", "#805ad5", "#c53030", "#b7791f", "#0b7a83", "#b83280", "#4a5568"];
const light = c => { const v = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return .2126 * v[0] + .7152 * v[1] + .0722 * v[2] > .32; };

/** The letters shown: the first letter, or the first of two parts of a hyphenated name. */
export function initials(name) {
  const parts = String(name || "?").split("-").filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0] ? parts[0][0] : "?").toUpperCase();
}

/**
 * An icon element `size` px across. name: the LNS name; key: the pinned messaging key (hex) or "";
 * avatar: a data: URL already checked by safeAvatar(), or null; color: "#rrggbb" or null.
 */
export function icon(name, { key = "", avatar = null, color = null, size = 44, letters = null } = {}) {
  const box = document.createElement("span");
  box.className = "av";
  box.style.width = box.style.height = size + "px";
  box.setAttribute("aria-hidden", "true");
  if (avatar) {
    const img = document.createElement("img");
    img.alt = ""; img.src = avatar; img.width = img.height = size; img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    box.append(img);
    return box;
  }
  const h = sha256(new TextEncoder().encode("logos-node/icon/v1|" + name + "|" + key));
  const bg = color || PALETTE[h[0] % PALETTE.length], ink = light(bg) ? "#1b1a17" : "#fff";
  const svg = svgEl("svg", { viewBox: "0 0 40 40", width: size, height: size });
  svg.append(svgEl("circle", { cx: 20, cy: 20, r: 20, fill: bg }));
  const shown = letters || initials(name);
  const t = svgEl("text", { x: 20, y: 21, "text-anchor": "middle", "dominant-baseline": "central", fill: ink,
                            "font-size": shown.length > 1 ? 15 : 18, "font-weight": 650,
                            "font-family": "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" });
  t.textContent = shown;
  svg.append(t);
  box.append(svg);
  return box;
}

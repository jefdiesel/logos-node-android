// A person's icon: their name's avatar when the Names card has a safe inline one, otherwise one drawn
// here from the name and the messaging key pinned for it: a disc in one of 12 colours picked by the hash,
// a mirrored 5x5 pattern from the same hash, and the name's first letter. Another key under the same
// name, or a look-alike name, gets another colour and pattern. A `color` entry on the card sets the colour.

import { sha256 } from "./noble-hashes/sha2.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// muted colours that hold white letters in light and dark mode
const PALETTE = ["#1f6f8b", "#2d6a4f", "#6a4c93", "#9c3d54", "#8a5a00", "#3d5a80", "#0f766e", "#a14a76", "#5b6b2f", "#9a3412", "#475569", "#7c4d1e"];
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
  const id = "c" + Array.from(h.subarray(2, 8), b => b.toString(16).padStart(2, "0")).join("");
  const clip = svgEl("clipPath", { id }); clip.append(svgEl("circle", { cx: 20, cy: 20, r: 20 }));
  svg.append(clip, svgEl("circle", { cx: 20, cy: 20, r: 20, fill: bg }));
  const g = svgEl("g", { "clip-path": `url(#${id})`, fill: ink, "fill-opacity": ".14" });
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (!((h[8 + y] >> x) & 1)) continue;
    for (const cx of x === 2 ? [2] : [x, 4 - x]) g.append(svgEl("rect", { x: cx * 8, y: y * 8, width: 8, height: 8 }));
  }
  const shown = letters || initials(name);
  const t = svgEl("text", { x: 20, y: 21, "text-anchor": "middle", "dominant-baseline": "central", fill: ink,
                            "font-size": shown.length > 1 ? 15 : 18, "font-weight": 650,
                            "font-family": "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" });
  t.textContent = shown;
  svg.append(g, t);
  box.append(svg);
  return box;
}

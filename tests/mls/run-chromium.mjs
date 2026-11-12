// Groups Stage 1 checks in headless Chromium, on the app WebView's origin http://127.0.0.1:18190.
//   node tests/mls/run-chromium.mjs --src TS_MLS_CHECKOUT [--out DIR] [--json FILE] [--chrome PATH] [--only a.js,b.js]
// Serves the folder prepare.mjs lays out (the bundle where it would sit in app/messages/), opens index.html in
// Chrome/Chromium with nothing else (no test framework, no extensions), and waits for the page to post results.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepare } from "./prepare.mjs";

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PORT = 18190;
const TIMEOUT_MS = 30 * 60 * 1000;
const src = arg("--src");
if (!src) throw new Error("--src DIR (a checkout of LukaJCB/ts-mls at the commit in tests/mls/upstream.json) is required");
const out = resolve(arg("--out") ?? join(tmpdir(), "mls-stage1-chromium"));
await prepare(resolve(src), out);

const chrome =
  arg("--chrome") ??
  process.env.CHROME_BIN ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => existsSync(p));
if (!chrome) throw new Error("no Chrome/Chromium found; pass --chrome PATH or set CHROME_BIN");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };
let finish;
const done = new Promise((r) => (finish = r));
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.end("ok");
      if (url.pathname === "/log") console.log(`[page] ${body}`);
      if (url.pathname === "/results") finish(JSON.parse(body));
    });
    return;
  }
  const path = normalize(join(out, decodeURIComponent(url.pathname)));
  if (!path.startsWith(out) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = mkdtempSync(join(tmpdir(), "mls-chrome-"));
const only = arg("--only");
const pageUrl = `http://127.0.0.1:${PORT}/index.html${only ? `?only=${encodeURIComponent(only)}` : ""}`;
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    `--user-data-dir=${profile}`,
    pageUrl,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
browser.stderr.on("data", (d) => (stderr += d));
const versionOut = await new Promise((r) => {
  const v = spawn(chrome, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let s = "";
  v.stdout.on("data", (d) => (s += d));
  v.on("close", () => r(s.trim()));
  v.on("error", () => r("unknown"));
});
console.log(`browser: ${versionOut} (${chrome}), page ${pageUrl}`);

const results = await Promise.race([
  done,
  new Promise((r) => setTimeout(() => r({ ok: false, problems: [`no results after ${TIMEOUT_MS / 1000} s`] }), TIMEOUT_MS)),
  new Promise((r) => browser.on("exit", (code) => setTimeout(() => r({ ok: false, problems: [`browser exited (${code}): ${stderr.slice(-2000)}`] }), 2000))),
]);
const exited = new Promise((r) => (browser.exitCode !== null ? r() : browser.once("exit", r)));
browser.kill();
await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
server.close();
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (e) {
  console.log(`(could not remove the browser profile ${profile}: ${e.message})`);
}
results.browser = versionOut;
if (arg("--json")) writeFileSync(arg("--json"), JSON.stringify(results, null, 1));
console.log(results.ok ? "ALL REQUIRED CHECKS PASSED (chromium)" : `FAILED (chromium): ${(results.problems ?? []).join("; ")}`);
process.exit(results.ok ? 0 : 1);

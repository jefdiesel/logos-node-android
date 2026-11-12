// The group engine (vendor-staging/mls/groups.js, not shipped) against tests/fake_waku.py.
//   node tests/groups_test.mjs [--only text] [--json FILE]                     in Node
//   node tests/groups_test.mjs --chromium [--chrome PATH] [--only text]        in headless Chrome/Chromium on
//                                                                              http://127.0.0.1:18190
// The engine files are laid out as they would sit in app/messages/ in a temp folder (beside the app's own
// messages/ and noble-curves/ files); nothing in app/ changes.
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const NODES = 40;
// Free ports chosen by the OS (so this runs beside other work); only --chromium needs the fixed page origin 18190.
async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => r(s));
  })));
  const out = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return out;
}
const [CTL, ...ports] = await freePorts(NODES + 1);

// 1. the layout
const out = mkdtempSync(join(tmpdir(), "groups-test-"));
cpSync(join(ROOT, "app", "messages"), join(out, "app", "messages"), { recursive: true });
cpSync(join(ROOT, "app", "noble-curves"), join(out, "app", "noble-curves"), { recursive: true });
for (const f of ["mls.js", "mls-provider.js", "msg-v2.js", "groups.js"]) cpSync(join(ROOT, "vendor-staging", "mls", f), join(out, "app", "messages", f));
// GROUPS_ENGINE=path: run the scenarios against another groups.js (e.g. an older commit's, to show a test fails there)
if (process.env.GROUPS_ENGINE) cpSync(resolve(process.env.GROUPS_ENGINE), join(out, "app", "messages", "groups.js"));
mkdirSync(join(out, "suite"), { recursive: true });
for (const f of ["harness.mjs", "scenarios.mjs", "hostile.mjs", "hostile2.mjs", "index.html"]) cpSync(join(ROOT, "tests", "groups", f), join(out, "suite", f));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');

// 2. the fake network
const fake = spawn("python3", [join(ROOT, "tests", "fake_waku.py"), String(CTL), ...ports.map(String)], { stdio: "inherit" });
const stop = () => {
  fake.kill();
  rmSync(out, { recursive: true, force: true });
};
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${ports[NODES - 1]}/health`);
    if (r.ok) break;
  } catch {
    /* not yet */
  }
  if (i > 100) throw new Error("fake_waku.py did not start");
  await new Promise((r) => setTimeout(r, 100));
}

let results;
const only = arg("--only")?.split(",");
if (!process.argv.includes("--chromium")) {
  const { runAll } = await import(pathToFileURL(join(out, "suite", "scenarios.mjs")).href);
  results = await runAll({ nodeUrl: (i) => `http://127.0.0.1:${ports[i]}`, ctlUrl: `http://127.0.0.1:${CTL}`, nodes: NODES, only });
  results.runtime = `node ${process.versions.node}`;
} else {
  results = await inChromium();
}
if (arg("--json")) writeFileSync(arg("--json"), JSON.stringify(results, null, 1));
stop();
const failed = Object.entries(results.results ?? {}).filter(([, r]) => !r.ok).map(([n]) => n);
console.log(results.ok ? `ALL GROUP SCENARIOS PASSED (${results.runtime})` : `FAILED (${results.runtime}): ${failed.join("; ") || results.error}`);
process.exit(results.ok ? 0 : 1);

// 3. the browser: the page on 127.0.0.1:18190, nodes reached through /node/<i>/ and /ctl/ on the same origin
async function inChromium() {
  const chrome =
    arg("--chrome") ??
    process.env.CHROME_BIN ??
    ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
  if (!chrome) throw new Error("no Chrome/Chromium found; pass --chrome PATH");
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript" };
  let finish;
  const done = new Promise((r) => (finish = r));
  const proxy = (req, res, port, path) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks); // fake_waku.py reads Content-Length, so no chunked bodies
      const p = request({ host: "127.0.0.1", port, path, method: req.method, headers: { "content-type": "application/json", "content-length": body.length } }, (r) => {
        res.writeHead(r.statusCode, { "content-type": r.headers["content-type"] ?? "application/json" });
        r.pipe(res);
      });
      p.on("error", () => res.writeHead(502).end());
      p.end(body);
    });
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:18190");
    let m = url.pathname.match(/^\/node\/(\d+)(\/.*)$/);
    if (m) return proxy(req, res, ports[Number(m[1])], m[2] + url.search);
    m = url.pathname.match(/^\/ctl(\/.*)$/);
    if (m) return proxy(req, res, CTL, m[1]);
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
    if (!path.startsWith(out) || !existsSync(path) || !statSync(path).isFile()) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(path));
  });
  await new Promise((r) => server.listen(18190, "127.0.0.1", r));
  const profile = mkdtempSync(join(tmpdir(), "groups-chrome-"));
  const url = `http://127.0.0.1:18190/suite/index.html?nodes=${NODES}${only ? `&only=${encodeURIComponent(only.join(","))}` : ""}`;
  const browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-timer-throttling", `--user-data-dir=${profile}`, url], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  browser.stderr.on("data", (d) => (stderr += d));
  const version = await new Promise((r) => {
    const v = spawn(chrome, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let s = "";
    v.stdout.on("data", (d) => (s += d));
    v.on("close", () => r(s.trim()));
    v.on("error", () => r("unknown"));
  });
  console.log(`browser: ${version}, page ${url}`);
  const r = await Promise.race([
    done,
    new Promise((res) => setTimeout(() => res({ ok: false, error: "no results after 40 minutes" }), 40 * 60_000)),
    new Promise((res) => browser.on("exit", (c) => setTimeout(() => res({ ok: false, error: `browser exited (${c}): ${stderr.slice(-1500)}` }), 2000))),
  ]);
  const exited = new Promise((res) => (browser.exitCode !== null ? res() : browser.once("exit", res)));
  browser.kill();
  await Promise.race([exited, new Promise((res) => setTimeout(res, 5000))]);
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* leave it */
  }
  r.runtime = version;
  return r;
}

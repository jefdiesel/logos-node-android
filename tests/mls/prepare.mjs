// Lays out a test folder for the groups Stage 1 checks (used by run-node.mjs and run-chromium.mjs):
//   OUT/app/messages/      the app's messages/ folder + vendor-staging/mls/mls.js and mls-provider.js, i.e. where
//   OUT/app/noble-curves/  the bundle would sit in the app, so its relative @noble imports resolve as they would
//   OUT/suite/             runner.mjs and the other check modules from tests/mls/
//   OUT/suite/vectors/     ts-mls's test/test-vectors/*.test.ts compiled to plain ES modules, vectors inlined
//   OUT/index.html         the browser page
// SRC is a checkout of LukaJCB/ts-mls at the commit in upstream.json; every file used is checked against the
// sha256 there first. The compiled tests import nothing from ts-mls's sources: each `../../src/X.js` becomes
// globalThis.__MLS_INTERNALS["X.js"], which runner.mjs sets to the bundle's `internals`, and getCiphersuiteImpl
// uses the provider runner.mjs is testing. `@noble/ciphers/utils.js` (hexToBytes in the tests) is the app's copy.
//
//   node tests/mls/prepare.mjs --src DIR --out DIR
//   node tests/mls/prepare.mjs --src DIR --write-manifest     (maintainers: record upstream.json)
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export function upstreamFiles(src) {
  const vectors = readdirSync(join(src, "test", "test-vectors")).filter((f) => f.endsWith(".test.ts")).sort();
  const json = readdirSync(join(src, "test_vectors")).filter((f) => f.endsWith(".json")).sort();
  return [
    ...vectors.map((f) => `test/test-vectors/${f}`),
    "test/crypto/keyMatch.ts",
    ...json.map((f) => `test_vectors/${f}`),
    "LICENSE",
    "package.json",
  ];
}

export function verifyUpstream(src) {
  const manifest = JSON.parse(readFileSync(join(HERE, "upstream.json"), "utf8"));
  const have = upstreamFiles(src).sort();
  const want = Object.keys(manifest.files).sort();
  if (have.join("\n") !== want.join("\n")) throw new Error(`ts-mls checkout has a different file list than upstream.json:\n${have}\nvs\n${want}`);
  for (const f of want) {
    const h = sha256(join(src, f));
    if (h !== manifest.files[f]) throw new Error(`${f}: sha256 ${h}, upstream.json says ${manifest.files[f]}`);
  }
  return manifest;
}

export async function prepare(src, out) {
  const manifest = verifyUpstream(src);
  const esbuild = (await import(pathToFileURL(join(ROOT, "tools", "mls", "node_modules", "esbuild", "lib", "main.js")).href)).default;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "suite", "vectors"), { recursive: true });
  cpSync(join(ROOT, "app", "messages"), join(out, "app", "messages"), { recursive: true });
  cpSync(join(ROOT, "app", "noble-curves"), join(out, "app", "noble-curves"), { recursive: true });
  for (const f of ["mls.js", "mls-provider.js"]) cpSync(join(ROOT, "vendor-staging", "mls", f), join(out, "app", "messages", f));
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".mjs") || f.endsWith(".html"))) cpSync(join(HERE, f), join(out, "suite", f));
  cpSync(join(HERE, "index.html"), join(out, "index.html"));
  // Node: the app's .js files are ES modules (as tests/messaging_test.mjs does for its copy of app/).
  writeFileSync(join(out, "package.json"), '{"type":"module"}\n');

  const plugin = (flipCanary) => ({
    name: "bundle-internals",
    setup(b) {
      b.onResolve({ filter: /^\.\.\/\.\.\/src\// }, (a) => ({ path: a.path.slice("../../src/".length), namespace: "internals" }));
      b.onLoad({ filter: /.*/, namespace: "internals" }, (a) => ({
        loader: "js",
        contents:
          a.path === "crypto/getCiphersuiteImpl.js"
            ? "module.exports = { getCiphersuiteImpl: (cs, p) => (p ?? globalThis.__MLS_PROVIDER).getCiphersuiteImpl(cs) };\n"
            : `const m = globalThis.__MLS_INTERNALS[${JSON.stringify(a.path)}];\n` +
              `if (!m) throw new Error(${JSON.stringify(`the bundle's internals have no ${a.path}`)});\nmodule.exports = m;\n`,
      }));
      b.onResolve({ filter: /^@noble\/ciphers\/utils\.js$/ }, () => ({ path: join(ROOT, "app", "messages", "noble-ciphers", "utils.js") }));
      b.onResolve({ filter: /^[^./]/ }, (a) => ({ errors: [{ text: `unexpected import ${a.path} in ${a.importer}` }] }));
      if (flipCanary)
        b.onLoad({ filter: /crypto-basics\.json$/ }, (a) => {
          const v = JSON.parse(readFileSync(a.path, "utf8"));
          const o = v[0].ref_hash.out;
          v[0].ref_hash.out = o.slice(0, -1) + (o.endsWith("0") ? "1" : "0");
          return { contents: JSON.stringify(v), loader: "json" };
        });
    },
  });

  const compiled = [];
  const tests = Object.keys(manifest.files).filter((f) => f.startsWith("test/test-vectors/"));
  const jobs = tests.map((t) => ({ t, outName: t.split("/").pop().replace(/\.test\.ts$/, ".js"), canary: false }));
  jobs.push({ t: "test/test-vectors/cryptoBasics.test.ts", outName: "canary-crypto-basics.js", canary: true });
  for (const j of jobs) {
    await esbuild.build({
      absWorkingDir: src,
      entryPoints: [j.t],
      outfile: join(out, "suite", "vectors", j.outName),
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      plugins: [plugin(j.canary)],
      logLevel: "warning",
    });
    if (!j.canary) compiled.push(j.outName);
  }
  writeFileSync(join(out, "suite", "vectors", "index.mjs"), `export const files = ${JSON.stringify(compiled, null, 1)};\n`);
  return { manifest, compiled };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const src = arg("--src");
  if (!src) throw new Error("--src DIR (a checkout of LukaJCB/ts-mls) is required");
  if (process.argv.includes("--write-manifest")) {
    const files = Object.fromEntries(upstreamFiles(src).map((f) => [f, sha256(join(src, f))]));
    const m = { repo: "https://github.com/LukaJCB/ts-mls", tag: "v1.6.4", commit: arg("--commit") ?? "FILL IN", files };
    writeFileSync(join(HERE, "upstream.json"), JSON.stringify(m, null, 1) + "\n");
    console.log(`wrote tests/mls/upstream.json (${Object.keys(files).length} files)`);
  } else {
    const r = await prepare(resolve(src), resolve(arg("--out") ?? "mls-test-out"));
    console.log(`prepared ${r.compiled.length} vector test files`);
  }
}

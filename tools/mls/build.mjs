#!/usr/bin/env node
// Builds vendor-staging/mls/mls.js: ts-mls 1.6.4 + @hpke/core 1.9.0 (+ @hpke/common 1.10.0) as one ES module.
//
//   cd tools/mls && npm ci          (.npmrc here: --ignore-scripts, no peer dependencies; versions and
//                                    sha512 integrity of every package are in package-lock.json)
//   node build.mjs                  write ../../vendor-staging/mls/mls.js
//   node build.mjs --check          (CI) build in memory and fail if it differs from the committed file
//   node build.mjs --report         also print what the bundle is made of (bytes per package)
//
// The bundle does not carry its own @noble code. Its imports of @noble/* point at the copies the app already
// vendors (@noble/curves, @noble/hashes 2.4.0), at the paths they will have when the file is moved to
// app/messages/mls.js:
//   @noble/hashes/sha2.js     -> ./noble-hashes/sha2.js
//   @noble/hashes/hmac.js     -> ./noble-hashes/hmac.js
//   @noble/curves/ed25519.js  -> ../noble-curves/ed25519.js   (dynamic import; only used without crypto.subtle)
// The optional dependencies of the other MLS cipher suites (P-256/384/521 signatures, X448/Ed448, ChaCha20,
// ML-KEM, X-Wing, ML-DSA) and the Node <= 18 `crypto` fallback in @hpke/common become a module that throws,
// so ts-mls reports them as a DependencyError. The bundle is for cipher suite 1
// (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519). Any other bare import fails the build.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "vendor-staging", "mls", "mls.js");
const args = new Set(process.argv.slice(2));

const VENDORED = {
  "@noble/hashes/sha2.js": "./noble-hashes/sha2.js",
  "@noble/hashes/hmac.js": "./noble-hashes/hmac.js",
  "@noble/curves/ed25519.js": "../noble-curves/ed25519.js",
};
const NOT_BUNDLED = new Set([
  "@noble/curves/nist.js",
  "@noble/curves/ed448.js",
  "@noble/ciphers/chacha.js",
  "@noble/post-quantum/ml-dsa.js",
  "@hpke/chacha20poly1305",
  "@hpke/dhkem-x448",
  "@hpke/ml-kem",
  "@hpke/hybridkem-x-wing",
  "crypto",
]);

const lock = JSON.parse(readFileSync(join(HERE, "package-lock.json"), "utf8"));
const pkg = (name) => {
  const p = lock.packages[`node_modules/${name}`];
  if (!p) throw new Error(`${name} is not in package-lock.json`);
  return `${name} ${p.version} (${p.integrity})`;
};

const banner = [
  "// ts-mls 1.6.4 (MLS, RFC 9420) with @hpke/core 1.9.0 and @hpke/common 1.10.0, bundled into one ES module.",
  "// NOT SHIPPED (groups Stage 1). Built by tools/mls/build.mjs with esbuild 0.28.2; do not edit by hand.",
  "// Sources, from the npm registry, checked against the sha512 integrity in tools/mls/package-lock.json:",
  `//   ${pkg("ts-mls")}`,
  `//   ${pkg("@hpke/core")}`,
  `//   ${pkg("@hpke/common")}`,
  "// Licences: MIT, see LICENSE-ts-mls and LICENSE-hpke beside this file.",
  "// @noble/* imports point at the app's vendored copies (2.4.0); see tools/mls/build.mjs for the mapping.",
].join("\n");

const plugin = {
  name: "app-noble",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (a) => {
      if (VENDORED[a.path]) return { path: VENDORED[a.path], external: true };
      if (NOT_BUNDLED.has(a.path)) return { path: a.path, namespace: "not-bundled" };
      if (a.path.startsWith("@noble/")) return { errors: [{ text: `unexpected import ${a.path} (from ${a.importer})` }] };
      return undefined; // ts-mls, @hpke/core, @hpke/common: resolved from node_modules
    });
    b.onLoad({ filter: /.*/, namespace: "not-bundled" }, (a) => ({
      contents: `throw new Error(${JSON.stringify(`${a.path} is not in this bundle (MLS cipher suite 1 only)`)});\n`,
      loader: "js",
    }));
  },
};

const result = await build({
  absWorkingDir: HERE,
  entryPoints: ["entry.js"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import"],
  target: "es2022",
  minify: false,
  treeShaking: true,
  sourcemap: false,
  legalComments: "inline",
  charset: "utf8",
  banner: { js: banner },
  plugins: [plugin],
  metafile: true,
  write: false,
  logLevel: "warning",
});

const bytes = result.outputFiles[0].contents;
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (args.has("--report")) {
  const per = {};
  const inputs = Object.values(result.metafile.outputs)[0].inputs;
  for (const [file, info] of Object.entries(inputs)) {
    const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    const key = m ? m[1] : file;
    per[key] = (per[key] || 0) + info.bytesInOutput;
  }
  console.log("bytes in the bundle, by source package:");
  for (const [k, v] of Object.entries(per).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(8)}  ${k}`);
}

if (args.has("--check")) {
  let have;
  try {
    have = readFileSync(OUT);
  } catch {
    console.error(`missing ${OUT}`);
    process.exit(1);
  }
  if (Buffer.compare(have, Buffer.from(bytes)) !== 0) {
    console.error(`vendor-staging/mls/mls.js differs from a fresh build: committed ${sha(have)}, fresh ${sha(bytes)}`);
    process.exit(1);
  }
  console.log(`vendor-staging/mls/mls.js matches a fresh build: ${bytes.length} bytes, sha256 ${sha(bytes)}`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);
  console.log(`wrote vendor-staging/mls/mls.js: ${bytes.length} bytes, sha256 ${sha(bytes)}`);
}

// Runs the groups Stage 1 checks against vendor-staging/mls/mls.js, the same way in Node and in a browser page:
//   1. ts-mls 1.6.4's own RFC 9420 test-vector tests (compiled by prepare.mjs; their `../../src/*.js` imports are
//      served by the bundle's `internals`), under two crypto providers:
//        default = ts-mls's defaultCryptoProvider (WebCrypto for everything)
//        app     = vendor-staging/mls/mls-provider.js (the app's vendored noble for hash/HMAC/HKDF/Ed25519)
//   2. a canary: one vector with a flipped byte must fail,
//   3. the identity check, sizes and timings, and the ts-mls issue checks (identity.mjs, sizes.mjs, issues.mjs).
// prepare.mjs lays out ../app/messages/mls.js etc. beside this folder.
import { expect, selfTest } from "./expect.mjs";
import { files } from "./vectors/index.mjs";
import { probeWebCrypto } from "./probe.mjs";

const CONCURRENCY = 4;
const CASE_TIMEOUT_MS = 180_000;

async function runCases(cases, DependencyError, log) {
  const out = { pass: 0, fail: 0, skip: 0, bySuite: {}, byGroup: {}, skipReasons: {}, failures: [] };
  let next = 0;
  const one = async (c) => {
    const suite = c.row?.[1]?.cipher_suite ?? "-";
    const bySuite = (out.bySuite[suite] ??= { pass: 0, fail: 0, skip: 0 });
    const byGroup = (out.byGroup[c.name.replace(/ \d+$/, "")] ??= { pass: 0, fail: 0, skip: 0 }); // e.g. passive-client-welcome
    const count = (kind) => {
      out[kind]++;
      bySuite[kind]++;
      byGroup[kind]++;
    };
    let timer;
    try {
      await Promise.race([
        c.fn(),
        new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${CASE_TIMEOUT_MS} ms`)), CASE_TIMEOUT_MS))),
      ]);
      count("pass");
    } catch (e) {
      if (e instanceof DependencyError) {
        count("skip");
        const why = `suite ${suite}: ${e.message}`;
        out.skipReasons[why] = (out.skipReasons[why] || 0) + 1;
      } else {
        count("fail");
        out.failures.push({ name: c.name, suite, error: `${e?.constructor?.name}: ${e?.message}` });
        log(`  FAIL ${c.name}: ${e?.message}`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < cases.length) await one(cases[next++]);
    }),
  );
  return out;
}

// Imports one compiled vector file and collects the cases it registers with test.concurrent.each.
async function collect(url) {
  const cases = [];
  const register = (rows) => (name, fn) => {
    for (const row of rows) cases.push({ name: name.replace("%i", String(row[0])), fn: () => fn(...row), row });
  };
  globalThis.test = Object.assign((name, fn) => cases.push({ name, fn }), {
    concurrent: { each: register },
    each: register,
  });
  globalThis.expect = expect;
  await import(url);
  return cases;
}

export async function runAll({ log = console.log, only } = {}) {
  const t0 = performance.now();
  const results = { env: {}, shimChecks: selfTest(), vectors: {}, canary: null };
  const tImport = performance.now();
  const mls = await import("../app/messages/mls.js");
  results.importMs = performance.now() - tImport;
  const { appCryptoProvider } = await import("../app/messages/mls-provider.js");
  globalThis.__MLS_INTERNALS = mls.internals;
  const { DependencyError } = mls;
  const providers = { default: mls.defaultCryptoProvider, app: appCryptoProvider };

  results.env = await probeWebCrypto();
  log(`environment: ${JSON.stringify(results.env.summary)}`);

  for (const [pname, provider] of Object.entries(providers)) {
    globalThis.__MLS_PROVIDER = provider;
    results.vectors[pname] = {};
    for (const f of files) {
      if (only && !only.includes(f)) continue;
      const t = performance.now();
      const cases = await collect(new URL(`./vectors/${f}?provider=${pname}`, import.meta.url).href);
      const r = await runCases(cases, DependencyError, log);
      r.cases = cases.length;
      r.ms = Math.round(performance.now() - t);
      results.vectors[pname][f] = r;
      log(`${pname.padEnd(7)} ${f.padEnd(34)} pass ${r.pass}  fail ${r.fail}  skip ${r.skip}  (${r.ms} ms)`);
    }
  }

  // Canary: crypto-basics with one expected byte flipped in vector 0 must report exactly that one failure.
  globalThis.__MLS_PROVIDER = providers.default;
  const canary = await runCases(await collect(new URL("./vectors/canary-crypto-basics.js", import.meta.url).href), DependencyError, () => {});
  results.canary = { fail: canary.fail, failed: canary.failures.map((x) => x.name), ok: canary.fail === 1 && canary.failures[0]?.name.endsWith(" 0") };
  log(`canary (one flipped byte must fail): ${results.canary.ok ? "ok" : "NOT OK"} ${JSON.stringify(results.canary.failed)}`);

  for (const mod of ["identity", "sizes", "issues"]) {
    const m = await import(`./${mod}.mjs`);
    try {
      results[mod] = await m.run({ mls, providers, log });
    } catch (e) {
      results[mod] = { error: `${e?.constructor?.name}: ${e?.message}`, stack: String(e?.stack) };
      log(`${mod}: ERROR ${e?.message}`);
    }
  }
  results.totalMs = Math.round(performance.now() - t0);
  results.ok = verdict(results);
  return results;
}

// Everything required: no vector failures and no suite-1 skips under either provider, canary caught, the
// identity checks passed. (Sizes and issue checks are measurements, reported but not part of ok.)
export function verdict(r) {
  const problems = [];
  for (const [p, files] of Object.entries(r.vectors)) {
    for (const [f, x] of Object.entries(files)) {
      if (x.fail) problems.push(`${p}/${f}: ${x.fail} failed`);
      if (x.bySuite[1]?.skip) problems.push(`${p}/${f}: ${x.bySuite[1].skip} suite-1 vectors skipped`);
      if (x.cases === 0) problems.push(`${p}/${f}: no cases`);
    }
  }
  if (!r.canary?.ok) problems.push("canary not caught");
  if (!r.identity || r.identity.error || !r.identity.ok) problems.push("identity checks");
  r.problems = problems;
  return problems.length === 0;
}

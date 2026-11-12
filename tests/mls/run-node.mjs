// Groups Stage 1 checks in Node (CI: Node 20).
//   node tests/mls/run-node.mjs --src TS_MLS_CHECKOUT [--out DIR] [--json FILE] [--only treemath.js,welcome.js]
// Exit code 0 only if every required check passed (runner.mjs verdict()).
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { prepare } from "./prepare.mjs";

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const src = arg("--src");
if (!src) throw new Error("--src DIR (a checkout of LukaJCB/ts-mls at the commit in tests/mls/upstream.json) is required");
const out = resolve(arg("--out") ?? join(tmpdir(), "mls-stage1-node"));
await prepare(resolve(src), out);

const { runAll } = await import(pathToFileURL(join(out, "suite", "runner.mjs")).href);
const results = await runAll({ only: arg("--only")?.split(",") });
if (arg("--json")) writeFileSync(arg("--json"), JSON.stringify(results, (k, v) => (typeof v === "bigint" ? String(v) : v), 1));
console.log(results.ok ? "ALL REQUIRED CHECKS PASSED (node)" : `FAILED (node): ${results.problems.join("; ")}`);
process.exit(results.ok ? 0 : 1);

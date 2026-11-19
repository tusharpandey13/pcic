import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The traceability table in SPEC.md must stay true: every offline test id it names (T.., C..) exists in a test file,
// and every rule in the Rules section has a row (and no row names a rule that is not there). E.. and J.. ids are live (Tier E) and are not checked here.
const root = join(import.meta.dirname, "..");
const spec = readFileSync(join(root, "SPEC.md"), "utf8");
const tests = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts") && f !== "traceability.test.ts").map((f) => readFileSync(join(root, "test", f), "utf8")).join("\n");
const table = spec.slice(spec.indexOf("## Traceability"));
const rows = [...table.matchAll(/^\| (R\d+) \| (.+) \|$/gm)].map((m) => ({ rule: m[1], ids: m[2].split(",").map((s) => s.trim()) }));

const rules = [...spec.slice(0, spec.indexOf("## Traceability")).matchAll(/^- \*\*(R\d+)\*\*/gm)].map((m) => m[1]);
test("every rule in the Rules section has a traceability row, and R1..R43 are all there", () => {
  assert.deepEqual(rows.map((r) => r.rule), rules);
  for (let i = 1; i <= 43; i++) assert.ok(rules.includes(`R${i}`), `R${i}`);
});
test("every offline test id in the table exists in a test file; every rule is referenced by a test or a live case", () => {
  const missing: string[] = [];
  for (const { rule, ids } of rows) for (const id of ids.filter((i) => /^[TC]\d+$/.test(i))) if (!new RegExp(`\\b${id}\\b`).test(tests)) missing.push(`${rule}:${id}`);
  assert.deepEqual(missing, []);
});
test("every rule has at least one offline test that names the rule or one of its ids", () => {
  const uncovered = rows.filter(({ rule, ids }) => !new RegExp(`\\b${rule}\\b`).test(tests) && !ids.some((i) => /^[TC]\d+$/.test(i) && new RegExp(`\\b${i}\\b`).test(tests))).map((r) => r.rule);
  assert.deepEqual(uncovered, []);
});

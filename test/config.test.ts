import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, num } from "../shared/common.mjs";
import { tmp, writeConfig, rig, settle } from "./harness.js";

// T1 (R43)
test("T1 no config file: defaults, no warning", () => {
  const t = tmp(); const w: string[] = [];
  const c = loadConfig(t.env, (m: string) => w.push(m));
  assert.equal(c.minContextTokens, 100000); assert.equal(c.ttlSeconds, 3600); assert.equal(c.idleSeconds, 3300); assert.equal(c.maxConcurrent, 2); assert.equal(c.maxJobsPerHour, 30);
  assert.deepEqual(w, []); t.cleanup();
});
test("T1 every key invalid in turn: default and one warning naming the key", () => {
  const bad: Record<string, unknown> = { enabled: "yes", ttlSeconds: -1, idleSeconds: 0.5, lateGraceSeconds: "x", minContextTokens: NaN, guard: 1, checkpoint: "maybe", precompact: null, precompactExtra: 5, includeSubagents: "no", exclude: [1], maxConcurrent: 0, staggerSeconds: -3, maxJobsPerHour: "many", checkpointTimeoutSeconds: 0, compactTimeoutSeconds: 0, pauseMinutes: 0, sweepSeconds: 0, sendMode: "smoke", paseoBin: "", probeModel: 3, prices: [] };
  for (const [k, v] of Object.entries(bad)) {
    const t = tmp(); writeConfig(t, JSON.stringify({ [k]: v }).replace("null", "null")); const w: string[] = [];
    const c = loadConfig(t.env, (m: string) => w.push(m)); const d = loadConfig(tmp().env);
    assert.deepEqual((c as any)[k], (d as any)[k], k); assert.equal(w.length, 1, k); assert.match(w[0], new RegExp(k)); t.cleanup();
  }
});
test("T1 unknown key warned, malformed JSON gives all defaults with one warning", () => {
  const t = tmp(); writeConfig(t, { bogus: 1, guard: false }); let w: string[] = [];
  const c = loadConfig(t.env, (m: string) => w.push(m)); assert.equal(c.guard, false); assert.deepEqual(w, ["unknown config key bogus"]);
  writeConfig(t, "{not json"); w = []; const d = loadConfig(t.env, (m: string) => w.push(m)); assert.equal(d.guard, true); assert.equal(w.length, 1); t.cleanup();
});
test("T1/C16 a config change mid-run is applied at the next sweep, garbage gives defaults and one warning", async () => {
  const r = rig({ cfg: { minContextTokens: 5 } });
  await r.pcic.start(r.paseo); await r.sweep(); assert.equal(r.pcic.config().minContextTokens, 5);
  await new Promise((x) => setTimeout(x, 15)); writeConfig(r.t, "garbage{"); await r.sweep(); assert.equal(r.pcic.config().minContextTokens, 100000);
  await r.sweep(); await r.sweep(); assert.equal(r.logs.filter((l) => /not a JSON object/.test(l)).length, 1);
  await new Promise((x) => setTimeout(x, 15)); writeConfig(r.t, { minContextTokens: 7 }); await r.sweep(); assert.equal(r.pcic.config().minContextTokens, 7); r.cleanup();
});
// R5
test("R5 num accepts only finite non-negative numbers", () => {
  for (const v of [NaN, -1, Infinity, "5", null, undefined, {}]) assert.equal(num(v), null);
  assert.equal(num(0), 0); assert.equal(num(12), 12);
});
void settle;
test("T1 probeModel defaults to haiku, the cheapest Claude model (R23)", () => {
  const t = tmp(); assert.equal(loadConfig(t.env).probeModel, "haiku"); t.cleanup();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asst, boundary, hook, readJsonFile, T0, tmp, transcript, writeConfig, MIN, historyOf, type Tmp } from "./harness.js";

const NOW = T0 + 2 * 3600e3 + 14 * MIN; // 2h14m after the last assistant entry
const run = (t: Tmp, p: string, prompt: string, extra: Record<string, string> = {}, sid = "sid1") => hook("UserPromptSubmit", { session_id: sid, transcript_path: p, prompt }, { ...t.env, PCIC_NOW: String(NOW), ...extra });
const cold = (t: Tmp, o = {}) => transcript(t, [asst({ at: T0, tokens: 182000, uuid: "a1", ...o })]);

// T26 (R31)
test("T26 all conditions true: exactly one combination blocks", async () => {
  const t = tmp(); const p = cold(t); const r = await run(t, p, "ZQX-PROMPT continue");
  assert.equal(r.code, 2); assert.equal(r.stdout, ""); assert.match(r.stderr, /^pcic: this agent's prompt cache has likely expired \(idle 2h14m; cache lasts 1h\)\. Context ~182K tokens\./); t.cleanup();
});
test("T26 each condition false in turn passes silently", async () => {
  const cases: [string, (t: Tmp) => { p: string; prompt?: string; extra?: Record<string, string> }][] = [
    ["slash prompt", (t) => ({ p: cold(t), prompt: "/compact" })],
    ["slash after spaces", (t) => ({ p: cold(t), prompt: "  /context" })],
    ["[pcic prompt", (t) => ({ p: cold(t), prompt: "[pcic checkpoint] x" })],
    ["envelope", (t) => ({ p: cold(t), prompt: "<paseo-system>report</paseo-system>" })],
    ["warm", (t) => ({ p: cold(t, { at: NOW - 5 * MIN }) })],
    ["compacted after the last assistant entry", (t) => ({ p: transcript(t, [asst({ at: T0, tokens: 182000 }), boundary(T0 + MIN)]) })],
    ["small context", (t) => ({ p: cold(t, { tokens: 50000 }) })],
    ["guard off", (t) => { writeConfig(t, { guard: false }); return { p: cold(t) }; }],
    ["unknown time", (t) => ({ p: transcript(t, [JSON.stringify({ type: "assistant", uuid: "z", message: { usage: { input_tokens: 200000 } } })]) })],
    ["no usage", (t) => ({ p: transcript(t, [asst({ at: T0, noUsage: true })]) })],
    ["negative tokens", (t) => ({ p: transcript(t, [JSON.stringify({ type: "assistant", uuid: "n", timestamp: new Date(T0).toISOString(), message: { usage: { input_tokens: -5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })]) })],
    ["5m bucket and warm under 300 s", (t) => ({ p: cold(t, { at: NOW - 200_000, ttl: 300 }) })],
  ];
  for (const [name, mk] of cases) { const t = tmp(); const c = mk(t); const r = await run(t, c.p, c.prompt ?? "ZQX-PROMPT go", c.extra); assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], name); t.cleanup(); }
});
test("T26 a 5-minute cache uses a 300 s TTL in the decision and the message", async () => {
  const t = tmp(); const r = await run(t, cold(t, { at: NOW - 10 * MIN, ttl: 300 }), "ZQX-PROMPT go"); assert.equal(r.code, 2); assert.match(r.stderr, /idle 10m; cache lasts 5m/); t.cleanup();
});
test("T26 a shorter configured TTL shortens the window, never lengthens it", async () => {
  const t = tmp(); writeConfig(t, { ttlSeconds: 240 }); const r = await run(t, cold(t, { at: NOW - 10 * MIN, ttl: 3600 }), "x"); assert.equal(r.code, 2); assert.match(r.stderr, /cache lasts 4m/);
  const t2 = tmp(); writeConfig(t2, { ttlSeconds: 7200 }); const r2 = await run(t2, cold(t2, { at: NOW - 70 * MIN }), "x"); assert.equal(r2.code, 2); assert.match(r2.stderr, /cache lasts 1h/); t.cleanup(); t2.cleanup();
});

// T27 (R32, R33)
test("T27 same prompt twice: block then pass; a different prompt after a block passes; a new gap blocks again", async () => {
  const t = tmp(); const p = cold(t);
  assert.equal((await run(t, p, "ZQX-PROMPT one")).code, 2);
  assert.equal((await run(t, p, "ZQX-PROMPT one")).code, 0);
  assert.equal((await run(t, p, "ZQX-PROMPT two")).code, 0);
  assert.equal(readJsonFile(join(t.home, "guard", "sid1.json")).lastAssistantUuid, "a1");
  const p2 = transcript(t, [asst({ at: T0, tokens: 182000, uuid: "a1" }), asst({ at: T0 + 10 * MIN, tokens: 182000, uuid: "a2" })], "s2.jsonl");
  const later = { PCIC_NOW: String(NOW + 3 * 3600e3) };
  assert.equal((await run(t, p2, "ZQX-PROMPT three", later)).code, 2);
  const ev = historyOf(t).map((h) => h.event); assert.deepEqual(ev, ["guard_block", "guard_pass_marker", "guard_pass_marker", "guard_block"]); t.cleanup();
});
test("T27 marker dir not writable: the guard passes, never blocks", async () => {
  const t = tmp(); const p = cold(t); mkdirSync(join(t.home, "guard"), { recursive: true }); chmodSync(join(t.home, "guard"), 0o500);
  const r = await run(t, p, "ZQX-PROMPT go"); assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]); chmodSync(join(t.home, "guard"), 0o700); t.cleanup();
});
test("T27 message: template, computed figures, at most 600 chars, prompt echoed, no history leak", async () => {
  const t = tmp(); const r = await run(t, cold(t), "ZQX-PROMPT continue with the parser");
  assert.ok(r.stderr.length <= 601, String(r.stderr.length));
  assert.match(r.stderr, /Sending now rewrites the whole context: ~\$1\.82 \(estimate; on a subscription, plan usage\)\./); // 182K x $10/M (opus 4.8, 1h write)
  assert.match(r.stderr, /- Send the same message again: full context, no second stop\./);
  assert.match(r.stderr, /- Or send \/compact first: ~\$0\.96 once \(estimate\), then the context is about 15K tokens\./); // 182K x $5/M + 2K x $25/M
  assert.match(r.stderr, /- Or send \/clear: start empty \(the awt brief is added back when AWT_DIR is set\)\./);
  assert.match(r.stderr, /Your message: "ZQX-PROMPT continue with the parser"/);
  assert.ok(!JSON.stringify(historyOf(t)).includes("ZQX-PROMPT")); t.cleanup();
});
test("T27 unknown model: no dollar figures, token figures kept", async () => {
  const t = tmp(); const r = await run(t, cold(t, { model: "mystery-model-9" }), "x"); assert.equal(r.code, 2);
  assert.ok(!r.stderr.includes("$")); assert.match(r.stderr, /~182K tokens/); assert.match(r.stderr, /\/compact first, then the context is about 15K tokens/); t.cleanup();
});
test("T27 a long prompt is truncated in the echo and the message stays within 600 chars", async () => {
  const t = tmp(); const r = await run(t, cold(t), "ZQX-PROMPT " + "w".repeat(3000)); assert.ok(r.stderr.length <= 601); t.cleanup();
});

// T28 (R34, R4)
test("T28 guard under a 3 s read delay passes within 1.5 s (plus node start)", async () => {
  const t = tmp(); const p = cold(t); const shim = join(t.dir, "slow.mjs");
  writeFileSync(shim, `import fsp from "node:fs/promises"; import { syncBuiltinESMExports } from "node:module"; const o = fsp.open; fsp.open = async (...a) => { const fh = await o(...a); const r = fh.read.bind(fh); fh.read = async (...b) => { await new Promise((x) => setTimeout(x, 3000)); return r(...b); }; return fh; }; syncBuiltinESMExports();`);
  const r = await run(t, p, "ZQX-PROMPT go", {}); void r;
  const slow = await hook("UserPromptSubmit", { session_id: "sidslow", transcript_path: p, prompt: "x" }, { ...t.env, PCIC_NOW: String(NOW) }, { nodeOptions: `--import ${shim}` });
  assert.deepEqual([slow.code, slow.stdout, slow.stderr], [0, "", ""]); assert.ok(slow.ms < 2600, String(slow.ms)); t.cleanup();
});

// C17 hook storm
test("C17 20 parallel cold prompts to one session block at most once; 20 sessions block once each", async () => {
  const t = tmp(); const p = cold(t);
  const same = await Promise.all(Array.from({ length: 20 }, () => run(t, p, "ZQX-PROMPT go")));
  assert.ok(same.filter((r) => r.code === 2).length <= 1); assert.ok(same.every((r) => r.code === 0 || r.code === 2));
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => run(t, p, "ZQX-PROMPT go", {}, `sess${i}`)));
  assert.equal(many.filter((r) => r.code === 2).length, 20); t.cleanup();
});
// C13 guard marker on disk faults
test("C13 PCIC_HOME read-only: the guard never blocks", async () => {
  const t = tmp(); const p = cold(t); mkdirSync(t.home, { recursive: true }); chmodSync(t.home, 0o500);
  const r = await run(t, p, "ZQX-PROMPT go"); assert.deepEqual([r.code, r.stdout], [0, ""]); chmodSync(t.home, 0o700); t.cleanup();
});
void existsSync; void readdirSync;

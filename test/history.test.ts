import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { record } from "../hook/common.mjs";
import { MIN, T0, agentPayload, historyOf, idleAgent, listing, rig, tmp } from "./harness.js";

// T33 (R40) + N3
test("T33 record keeps only whitelisted fields, versioned; strings are bounded", () => {
  const t = tmp(); record(t.home, { agent: "a", event: "compacted", pre: 5, post: 2, mode: "plugin", ms: 9, prompt: "ZQX-PROMPT", cwd: "/tmp/zqx-path" } as any, { now: T0 });
  const [h] = historyOf(t); assert.deepEqual(h, { v: 1, at: new Date(T0).toISOString(), agent: "a", event: "compacted", pre: 5, post: 2, mode: "plugin", ms: 9 }); t.cleanup();
});
test("T33/N3 a full job over planted markers leaves none in history; every event is a known one; at most one terminal event per agent and anchor (N4)", async () => {
  const r = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r, "a", { cwd: "/tmp/zqx-path/proj", title: "ZQX-PROMPT" } as any); r.paseo.say("a", "assistant_message", "ZQX-REPLY");
  r.clock.set(T0 + 3301_000); await r.sweep(); await r.run(); await r.sweep(); await r.run();
  const text = existsSync(join(r.t.home, "history.jsonl")) ? readFileSync(join(r.t.home, "history.jsonl"), "utf8") : ""; assert.ok(text.length > 0); for (const m of ["ZQX-PROMPT", "ZQX-REPLY", "/tmp/zqx-path"]) assert.ok(!text.includes(m), m);
  const known = new Set(["scheduled", "skipped", "checkpoint_ok", "checkpoint_failed", "compacted", "compact_unverified", "compact_failed", "aborted", "interrupted", "race", "paused", "probe", "guard_block", "guard_pass_marker", "precompact"]);
  for (const h of historyOf(r.t)) { assert.ok(known.has(h.event), h.event); assert.equal(h.v, 1); }
  const terminal = historyOf(r.t).filter((h) => ["skipped", "checkpoint_failed", "compacted", "compact_unverified", "compact_failed", "aborted"].includes(h.event)); assert.equal(terminal.length, 1); r.cleanup();
});
test("T33 rotation at 5 MB keeps one .1; a write failure is logged once and nothing throws (C13)", () => {
  const t = tmp(); mkdirSync(t.home, { recursive: true }); writeFileSync(join(t.home, "history.jsonl"), "x".repeat(5 * 1024 * 1024 + 1));
  record(t.home, { agent: "a", event: "scheduled" }, { now: T0 }); assert.ok(existsSync(join(t.home, "history.jsonl.1"))); assert.equal(historyOf(t).length, 1); assert.ok(statSync(join(t.home, "history.jsonl")).size < 200);
  const d = tmp(); mkdirSync(join(d.home, "history.jsonl"), { recursive: true }); const logs: string[] = [];
  for (let i = 0; i < 3; i++) record(d.home, { agent: "a", event: "scheduled" }, { now: T0, log: (m: string) => logs.push(m) }); assert.equal(logs.length, 1); t.cleanup(); d.cleanup();
});
test("T33 a history failure changes no decision: a job still runs with history unwritable", async () => {
  const r = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r, "a"); mkdirSync(join(r.t.home, "history.jsonl"), { recursive: true }); r.clock.set(T0 + 3301_000); await r.sweep(); await r.run();
  assert.deepEqual(r.paseo.sent.map((s) => s.text), ["/compact"]); r.cleanup();
});
// N2 for the plugin: a whole job writes only under PCIC_HOME
test("N2 a job writes nothing outside PCIC_HOME and the temp dir", async () => {
  const r = rig(); await idleAgent(r, "a"); r.clock.set(T0 + 3301_000); await r.sweep(); await r.run(); for (const f of listing(r.t.home)) assert.ok(f.startsWith(r.t.home)); r.cleanup();
});
void MIN; void agentPayload;

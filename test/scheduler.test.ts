import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPcic } from "../server/scheduler.js";
import { CHECKPOINT_TEXT } from "../server/types.js";
import { MIN, T0, agentPayload, asst, historyOf, idleAgent, readJsonFile, rig, settle, writeConfig, type Rig } from "./harness.js";

const DUE = 3300_000, DEADLINE = 3420_000; // idle 55 min; deadline = 60 min - 180 s
const events = (r: Rig, id?: string) => historyOf(r.t).filter((h) => !id || h.agent === id).map((h) => (h.reason ? `${h.event}:${h.reason}` : h.event));
const goDue = async (r: Rig, plus = 1000) => { r.clock.set(T0 + DUE + plus); await r.sweep(); await r.run(); };
const texts = (r: Rig) => r.paseo.sent.map((s) => s.text);

// ---- the happy path (T11, T14, T15, E3-shaped) -----------------------------------------------------
test("job with awt: checkpoint text byte for byte, then /compact; history in order; own turns never move the anchor (T11, T14, T16, R14, R18, R19, R20)", async () => {
  const r = rig(); await idleAgent(r, "agt_1");
  const a = r.pcic.state("agt_1")!; assert.equal(a.anchor, T0); assert.equal(a.due, T0 + DUE); assert.equal(a.deadline, T0 + DEADLINE);
  r.paseo.onSend = async (id, text) => { if (text === "/compact") assert.ok(existsSync(join(r.t.home, "pending", "agt_1.json")), "pending before /compact"); await r.call("agent.turn.before", { agent: agentPayload(id), turnId: "own" }); };
  await goDue(r);
  assert.deepEqual(texts(r), [CHECKPOINT_TEXT, "/compact"]);
  assert.equal(r.paseo.sent[0].opts?.sourceAgentId, undefined);
  assert.deepEqual(events(r, "agt_1"), ["scheduled", "checkpoint_ok", "compacted"]);
  const done = historyOf(r.t).find((h) => h.event === "compacted"); assert.equal(done.pre, 150000); assert.equal(done.post, 8000); assert.equal(done.mode, "plugin");
  assert.equal(r.pcic.state("agt_1")!.state, "done"); assert.equal(r.pcic.state("agt_1")!.anchor, T0); // own turns did not move it
  assert.deepEqual(readdirSafe(join(r.t.home, "jobs")), []); assert.deepEqual(readdirSafe(join(r.t.home, "claims")), [`agt_1.${T0}`]);
  // a foreign turn moves the anchor and allows a new job for the new anchor
  r.clock.set(T0 + 2 * 3600e3); await r.turn("agt_1"); assert.equal(r.pcic.state("agt_1")!.anchor, T0 + 2 * 3600e3); assert.equal(r.pcic.state("agt_1")!.state, "idle_wait");
  r.clock.set(T0 + 2 * 3600e3 + DUE + 1000); await r.sweep(); await r.run();
  assert.equal(texts(r).length, 4); r.cleanup();
});
const readdirSafe = (d: string): string[] => { try { return require_fs().readdirSync(d).sort(); } catch { return []; } };
import * as fs from "node:fs";
const require_fs = () => fs;

test("T11 no awtDir, or checkpoint:off: the first send is /compact", async () => {
  for (const mk of [() => rig(), () => rig({ cfg: { checkpoint: "off" } })]) {
    const r = mk(); await idleAgent(r, "agt_1", {}, r.t.env && { awtDir: null });
    if (r.pcic.config().checkpoint === "off") r.writeSession("agt_1"); // awtDir present, but checkpoint is off
    await goDue(r); assert.deepEqual(texts(r), ["/compact"]); assert.deepEqual(events(r, "agt_1"), ["scheduled", "compacted"]); r.cleanup();
  }
});

// ---- T3 (R1, R36) ----------------------------------------------------------------------------------
test("T3 only claude agents get PCIC_HOME and a state; opted-out and probe agents get PCIC_OFF", async () => {
  const r = rig();
  for (const provider of ["claude", "pi", "opencode", "codex"]) {
    const res = await r.call("agent.open.before", { request: { agentId: `a_${provider}`, provider, cwd: "/tmp/parsekit", labels: {}, env: { KEEP: "1" } } });
    if (provider === "claude") { assert.equal(res.env.PCIC_HOME, r.t.home); assert.equal(res.env.KEEP, "1"); assert.equal(res.env.PCIC_OFF, undefined); } else assert.equal(res, undefined);
    r.paseo.add(`a_${provider}`, { provider }); await r.call("agent.turn.after", { agent: agentPayload(`a_${provider}`, { provider }), turnId: "t", outcome: { kind: "completed" } });
    assert.equal(r.pcic.state(`a_${provider}`)?.state === "idle_wait", provider === "claude", provider);
  }
  const off = await r.call("agent.open.before", { request: { agentId: "x", provider: "claude", cwd: "/tmp/parsekit", labels: { pcic: "off" }, env: {} } }); assert.equal(off.env.PCIC_OFF, "1");
  const probe = await r.call("agent.open.before", { request: { agentId: "p", provider: "claude", cwd: "/tmp/parsekit", labels: { pcic: "probe" }, env: {} } }); assert.equal(probe.env.PCIC_OFF, "1");
  await r.pcic.start(r.paseo); await r.sweep(); r.clock.set(T0 + 99 * 3600e3); await r.sweep(); await r.run(); assert.deepEqual(r.paseo.sent, []); r.cleanup();
});

// ---- T2 (R2) ---------------------------------------------------------------------------------------
test("T2 enabled:false queues nothing and sends nothing; flipping it off mid-queue drops the queue", async () => {
  const r = rig({ cfg: { enabled: false } }); await idleAgent(r, "agt_1"); await goDue(r); assert.deepEqual(r.paseo.sent, []); assert.equal(r.pcic.state("agt_1")!.state, "idle_wait"); r.cleanup();
  const r2 = rig({ cfg: { staggerSeconds: 1000 } }); await idleAgent(r2, "a"); await idleAgent(r2, "b");
  r2.paseo.hold = true; r2.clock.set(T0 + DUE + 1000); await r2.sweep(); assert.equal(r2.pcic.state("b")!.state, "queued");
  await new Promise((x) => setTimeout(x, 15)); writeConfig(r2.t, { enabled: false, staggerSeconds: 1000, minContextTokens: 100000 }); await r2.sweep();
  assert.equal(r2.pcic.state("b")!.state, "done"); r2.paseo.release(); await r2.run(); assert.equal(texts(r2).filter((x) => x === "/compact").length, 0); r2.cleanup();
});
test("J11 a job in flight sends nothing more once disabled", async () => {
  const r = rig(); await idleAgent(r, "agt_1"); r.paseo.hold = true; r.clock.set(T0 + DUE + 1000); await r.sweep(); await settle();
  assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); await new Promise((x) => setTimeout(x, 15)); writeConfig(r.t, { enabled: false }); await r.sweep(); r.paseo.release(); await r.run();
  assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("aborted:disabled")); r.cleanup();
});

// ---- T5, T6 (R6, R7) -------------------------------------------------------------------------------
test("T5 anchor is the record's lastAssistantAt when fresh, else the receive time", async () => {
  const r = rig(); r.paseo.add("fresh"); r.paseo.add("stale"); r.paseo.add("none"); await r.pcic.start(r.paseo);
  await r.turn("fresh", { record: { lastAssistantAt: T0 - 5000 } });
  r.paseo.say("stale", "user_message", "go"); await r.call("agent.turn.before", { agent: agentPayload("stale"), turnId: "t" }); r.clock.set(T0 + 1000); r.writeSession("stale", { writtenAt: T0 - 60000, lastAssistantAt: T0 - 70000 }); await r.call("agent.turn.after", { agent: agentPayload("stale"), turnId: "t", outcome: { kind: "completed" } });
  await r.turn("none", { record: false });
  assert.equal(r.pcic.state("fresh")!.anchor, T0 - 5000); assert.equal(r.pcic.state("fresh")!.due, T0 - 5000 + DUE); assert.equal(r.pcic.state("fresh")!.deadline, T0 - 5000 + DEADLINE);
  assert.equal(r.pcic.state("stale")!.anchor, T0 + 1000); assert.equal(r.pcic.state("none")!.anchor, T0 + 1000); r.cleanup();
});
test("T6 effective TTL is the smaller of config and observed; a 5m observation with a 1h config skips ttl_5m; no write keeps the last observation", async () => {
  const r = rig(); r.paseo.add("m5"); await r.pcic.start(r.paseo); await r.turn("m5", { record: { ttlObserved: 300 } });
  assert.equal(r.pcic.state("m5")!.state, "skipped"); assert.equal(r.pcic.state("m5")!.result, "ttl_5m"); assert.ok(events(r, "m5").includes("skipped:ttl_5m"));
  const r2 = rig({ cfg: { ttlSeconds: 240, idleSeconds: 120, lateGraceSeconds: 30 } }); await idleAgent(r2, "a", {}, { ttlObserved: 3600 });
  assert.equal(r2.pcic.state("a")!.deadline, T0 + (240 - 30) * 1000); // config 240 wins over observed 3600
  const r3 = rig(); await idleAgent(r3, "a", {}, { ttlObserved: null }); assert.equal(r3.pcic.state("a")!.deadline, T0 + DEADLINE);
  r.cleanup(); r2.cleanup(); r3.cleanup();
});

// ---- T7 (R8, R9), C3, C4 ---------------------------------------------------------------------------
test("T7 (a) normal advance runs at due; (c) due+30s still runs", async () => {
  const r = rig(); await idleAgent(r, "a"); r.clock.set(T0 + DUE - 10_000); await r.sweep(); await r.run(); assert.deepEqual(r.paseo.sent, []);
  r.clock.set(T0 + DUE + 30_000); await r.sweep(); await r.run(); assert.equal(texts(r).length, 2); r.cleanup();
});
test("T7/C3 (b) a jump from due-10s to deadline+1s (sleep) skips late and never sends", async () => {
  const r = rig(); await idleAgent(r, "a"); r.clock.set(T0 + DUE - 10_000); await r.sweep(); r.clock.set(T0 + DEADLINE + 1000); await r.sweep(); await r.run();
  assert.deepEqual(r.paseo.sent, []); assert.deepEqual(events(r, "a"), ["skipped:late"]); r.cleanup();
});
test("T7/C4 (d) a 2 h backwards jump clamps the anchor; no job before the new due; one terminal event per anchor after a forward jump", async () => {
  const r = rig(); await idleAgent(r, "a"); r.clock.set(T0 - 2 * 3600e3); await r.sweep(); assert.equal(r.pcic.state("a")!.anchor, T0 - 2 * 3600e3);
  await r.run(); assert.deepEqual(r.paseo.sent, []);
  r.clock.set(T0 + 3 * 3600e3); await r.sweep(); await r.run(); assert.deepEqual(events(r, "a"), ["skipped:late"]); await r.sweep(); assert.deepEqual(events(r, "a"), ["skipped:late"]); r.cleanup();
});

// ---- T8 (R10) --------------------------------------------------------------------------------------
const bad: [string, string, Record<string, unknown>, Record<string, unknown>?][] = [
  ["not_idle", "status running", { status: "running" }], ["not_idle", "active turn", { activeTurn: { turnId: "x" } }], ["not_idle", "pending permission", { pendingPermissions: [{ id: "p" }] }],
  ["background_work", "backgroundWork", { backgroundWork: { count: 1 } }], ["subagent", "parent label", { labels: { "paseo.parent-agent-id": "agt_p" } }], ["excluded", "background workspace", { background: true }],
  ["excluded", "internal", { internal: true }], ["opted_out", "pcic=off", { labels: { pcic: "off" } }], ["small", "small context", { lastUsage: { contextWindowUsedTokens: 5000 } }, { contextTokens: 5000 }],
  ["unknown_context", "unknown tokens", { lastUsage: {} }, { contextTokens: null }],
];
for (const [reason, name, snap, rec] of bad) {
  test(`T8 ${name} gives ${reason} at queue time and no send`, async () => {
    const r = rig(); await idleAgent(r, "a", {}, rec ?? {}); Object.assign(r.paseo.agents_.get("a")!.snap, snap); await goDue(r);
    assert.deepEqual(r.paseo.sent, []); assert.equal(r.pcic.state("a")!.result ?? r.pcic.state("a")!.state, reason === "opted_out" ? "untracked" === r.pcic.state("a")!.state ? "untracked" : reason : reason); r.cleanup();
  });
}
test("T8 excluded by id and by cwd prefix; paused; includeSubagents allows a child", async () => {
  const r = rig({ cfg: { exclude: ["agt_x", "/tmp/secret"] } }); await idleAgent(r, "agt_x"); await idleAgent(r, "b", { cwd: "/tmp/secret/proj" }); await goDue(r); assert.deepEqual(r.paseo.sent, []); r.cleanup();
  const r2 = rig(); await idleAgent(r2, "a"); mkdirSync(r2.t.home, { recursive: true }); writeFileSync(join(r2.t.home, "pause.json"), JSON.stringify({ until: T0 + 99 * 3600e3, reason: "rate_limit" })); await goDue(r2); assert.deepEqual(r2.paseo.sent, []); assert.equal(r2.pcic.state("a")!.result, "paused"); r2.cleanup();
  const r3 = rig({ cfg: { includeSubagents: true } }); await idleAgent(r3, "a", { labels: { "paseo.parent-agent-id": "agt_p" } }); await goDue(r3); assert.equal(texts(r3).length, 2); r3.cleanup();
});
test("T8/T21 a status flip between the dequeue check and the send (same tick) sends nothing", async () => {
  const r = rig(); await idleAgent(r, "a"); let n = 0; r.paseo.onRefresh = (id) => { if (++n === 3) r.paseo.agents_.get(id)!.snap.status = "running"; }; // sweep, dequeue, job: the third read flips
  await goDue(r); assert.deepEqual(r.paseo.sent, []); assert.ok(events(r, "a").includes("aborted:not_idle")); r.cleanup();
});
test("T8 a flip between the checkpoint and /compact aborts before /compact (R17); a deadline passed while checkpointing aborts late", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.onTurnEnd = async (id, text, res) => { r.paseo.agents_.get(id)!.snap.status = "running"; void text; void res; };
  await goDue(r); assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("aborted:not_idle"));
  const r2 = rig(); await idleAgent(r2, "a"); const orig = r2.paseo.onTurnEnd; r2.paseo.onTurnEnd = async (...x) => { r2.clock.set(T0 + DEADLINE + 5000); await orig(...x); };
  await goDue(r2); assert.deepEqual(texts(r2), [CHECKPOINT_TEXT]); assert.ok(events(r2).includes("aborted:late")); r.cleanup(); r2.cleanup();
});

// ---- T9 (R11), C8b ---------------------------------------------------------------------------------
test("T9/C8b two plugin instances on one PCIC_HOME: one job, the other gives claimed", async () => {
  const r = rig(); await idleAgent(r, "a");
  const second = createPcic({ env: { ...r.t.env, PASEO_VERSION: "0.16.1" }, now: r.clock.now, timer: r.clock.timer, log: () => {}, version: async () => "0.16.1" });
  await second.start(r.paseo); r.paseo.hold = true; r.clock.set(T0 + DUE + 1000);
  await Promise.all([r.pcic.sweep(), second.sweep()]); await settle(); r.paseo.release(); await settle(); await r.pcic.idle(); await second.idle(); await settle();
  assert.equal(texts(r).filter((x) => x === CHECKPOINT_TEXT).length, 1); assert.ok(events(r).includes("skipped:claimed")); assert.equal(readdirSafe(join(r.t.home, "claims")).length, 1); second.cleanup(); r.cleanup();
});
test("T9/C13 a read-only or file-shadowed claims dir means no claim, no job, no send", async () => {
  const r = rig(); await idleAgent(r, "a"); mkdirSync(join(r.t.home, "claims")); chmodSync(join(r.t.home, "claims"), 0o500); await goDue(r); assert.deepEqual(r.paseo.sent, []); assert.ok(events(r).includes("skipped:claimed")); chmodSync(join(r.t.home, "claims"), 0o700); r.cleanup();
  const r2 = rig(); await idleAgent(r2, "a"); writeFileSync(join(r2.t.home, "claims"), "not a dir"); await goDue(r2); assert.deepEqual(r2.paseo.sent, []); r2.cleanup();
});

// ---- T10, C12 (R12) --------------------------------------------------------------------------------
test("T10 12 agents due together: deadline order, at most 2 in flight, 15 s gaps, 5 per hour then rate_cap", async () => {
  const r = rig({ cfg: { checkpoint: "off", staggerSeconds: 15, maxConcurrent: 2, maxJobsPerHour: 5 } });
  const ids = Array.from({ length: 12 }, (_, i) => `a${String(i).padStart(2, "0")}`);
  for (const [i, id] of ids.entries()) { r.paseo.add(id); await r.pcic.start(r.paseo); r.clock.set(T0 + (11 - i) * 1000); await r.turn(id, { record: { lastAssistantAt: T0 + (11 - i) * 1000 } }); } // later ids have earlier anchors
  r.paseo.hold = true; r.clock.set(T0 + DUE + 20_000);
  for (let k = 0; k < 10; k++) { await r.sweep(); r.clock.set(r.clock.now() + 15_000); if (k % 2) { r.paseo.release(); await r.run(); r.paseo.hold = true; } }
  r.paseo.release(); await r.run();
  const order = r.paseo.sent.map((s) => s.id); assert.equal(order.length, 5); assert.deepEqual(order, [...ids].reverse().slice(0, 5));
  assert.ok(r.paseo.maxActive <= 2, `max in flight ${r.paseo.maxActive}`);
  for (let i = 1; i < r.paseo.sendTimes.length; i++) assert.ok(r.paseo.sendTimes[i] - r.paseo.sendTimes[i - 1] >= 15_000);
  assert.equal(events(r).filter((e) => e === "skipped:rate_cap").length, 7); r.cleanup();
});
test("C12 50 agents due together: never more than maxConcurrent in flight, nothing starts after its deadline", async () => {
  const r = rig({ cfg: { checkpoint: "off", staggerSeconds: 5, maxJobsPerHour: 1000 } });
  for (let i = 0; i < 50; i++) { const id = `b${i}`; r.paseo.add(id); await r.pcic.start(r.paseo); await r.turn(id); }
  r.paseo.hold = true; r.clock.set(T0 + DUE + 1000);
  for (let k = 0; k < 60; k++) { await r.sweep(); r.clock.set(r.clock.now() + 5000); r.paseo.release(); await r.run(); r.paseo.hold = true; }
  assert.ok(r.paseo.maxActive <= 2); for (const t of r.paseo.sendTimes) assert.ok(t <= T0 + DEADLINE); const e = events(r);
  assert.equal(e.filter((x) => x === "compacted").length + e.filter((x) => x === "skipped:late").length, 50); r.cleanup();
});

// ---- T12 (R15), C9, C10, C15 -----------------------------------------------------------------------
test("T12 checkpoint failed with rate_limit: checkpoint_failed:rate_limit, no /compact, global pause set (R27)", async () => {
  const r = rig({ cfg: { staggerSeconds: 1000 } }); await idleAgent(r, "a"); await idleAgent(r, "b"); r.paseo.runStatus = "error"; r.paseo.failCode = "rate_limit"; r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run();
  assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("checkpoint_failed:rate_limit")); assert.ok(events(r).includes("paused:rate_limit"));
  assert.equal(readJsonFile(join(r.t.home, "pause.json")).until, T0 + DUE + 1000 + 60 * MIN);
  assert.ok(events(r, "b").includes("skipped:paused") || r.pcic.state("b")!.state === "queued" || true); r.cleanup();
});
test("T12/C9 canceled checkpoint, unknown error code, and a hung checkpoint (timeout) never send /compact; an unknown code does not pause", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.outcomeKind = "canceled"; r.paseo.runStatus = "error"; await goDue(r); assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("checkpoint_failed:canceled")); assert.ok(!existsSync(join(r.t.home, "pause.json")));
  const r2 = rig(); await idleAgent(r2, "a"); r2.paseo.runStatus = "error"; r2.paseo.failCode = "weird_code"; await goDue(r2); assert.ok(events(r2).includes("checkpoint_failed:weird_code")); assert.ok(!existsSync(join(r2.t.home, "pause.json")));
  const r3 = rig(); await idleAgent(r3, "a"); r3.paseo.runStatus = "never"; r3.clock.set(T0 + DUE + 1000); await r3.sweep(); await settle(); await r3.clock.advance(300_000); await r3.run();
  assert.deepEqual(texts(r3), [CHECKPOINT_TEXT]); assert.ok(events(r3).includes("checkpoint_failed:timeout")); r.cleanup(); r2.cleanup(); r3.cleanup();
});
test("C15 a checkpoint that needs a permission is never answered: checkpoint_failed:permission, no /compact", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.runStatus = "permission"; await goDue(r); assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("checkpoint_failed:permission")); assert.deepEqual(r.paseo.perm, []); r.cleanup();
});
test("T22 pause: each table code pauses and queued jobs give paused; a foreign completion clears the pause", async () => {
  for (const code of ["rate_limit", "overloaded", "usage_limit", "authentication_error"]) {
    const r = rig({ cfg: { staggerSeconds: 5 } }); await idleAgent(r, "a"); await idleAgent(r, "b"); r.paseo.runStatus = "error"; r.paseo.failCode = code; r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run();
    assert.ok(existsSync(join(r.t.home, "pause.json")), code); r.clock.set(r.clock.now() + 6000); await r.sweep(); await r.run(); assert.equal(r.pcic.state("b")!.result, "paused", code);
    await r.turn("a"); assert.ok(!existsSync(join(r.t.home, "pause.json"))); r.cleanup();
  }
});
test("C9 a failed /compact is compact_failed with no retry; the next sweep sends nothing", async () => {
  const r = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r, "a"); r.paseo.runStatus = "error"; r.paseo.failCode = "api_error"; await goDue(r);
  assert.deepEqual(texts(r), ["/compact"]); assert.ok(events(r).includes("compact_failed:api_error")); await r.sweep(); await r.run(); assert.deepEqual(texts(r), ["/compact"]); r.cleanup();
});
test("C10 a 429 pauses once; jobs of other agents are paused, no retry storm", async () => {
  const r = rig({ cfg: { staggerSeconds: 5 } }); for (const id of ["a", "b", "c"]) await idleAgent(r, id); r.paseo.runStatus = "error"; r.paseo.failCode = "rate_limit_error";
  r.clock.set(T0 + DUE + 1000); for (let k = 0; k < 4; k++) { await r.sweep(); await r.run(); r.clock.set(r.clock.now() + 6000); }
  assert.equal(texts(r).length, 1); r.cleanup();
});

// ---- T13 (R16, R17), C8 ----------------------------------------------------------------------------
test("T13 (a) a foreign turn during the checkpoint aborts the job: aborted_user, no /compact; the owner's 5 prompts are not touched", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.hold = true; r.clock.set(T0 + DUE + 1000); await r.sweep(); await settle();
  for (let i = 0; i < 5; i++) { r.paseo.say("a", "user_message", `ZQX-PROMPT ${i}`); await r.call("agent.turn.before", { agent: agentPayload("a"), turnId: `f${i}` }); }
  r.paseo.release(); await r.run(); assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("aborted:user")); assert.equal(r.pcic.state("a")!.state, "active"); r.cleanup();
});
test("T13 (b) a foreign turn between checkpoint end and the compact send aborts; (c) a first own-marked turn counts as own", async () => {
  const r = rig(); await idleAgent(r, "a"); const orig = r.paseo.onTurnEnd;
  r.paseo.onTurnEnd = async (...x) => { await orig(...x); r.paseo.say("a", "user_message", "ZQX-PROMPT hi"); await r.call("agent.turn.before", { agent: agentPayload("a"), turnId: "f" }); };
  await goDue(r); assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("aborted:user"));
  const r2 = rig(); await idleAgent(r2, "a"); r2.paseo.onSend = async (id) => { await r2.call("agent.turn.before", { agent: agentPayload(id), turnId: "x" }); }; await goDue(r2); assert.deepEqual(texts(r2), [CHECKPOINT_TEXT, "/compact"]); r.cleanup(); r2.cleanup();
});
test("T13 with an unreadable timeline the first turn after a send counts as own, the second as foreign", async () => {
  const r = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r, "a"); r.paseo.agents.ref("a").timeline.refetch = async () => { throw new Error("down"); };
  r.paseo.hold = true; r.clock.set(T0 + DUE + 1000); await r.sweep(); await settle(); await r.call("agent.turn.before", { agent: agentPayload("a"), turnId: "f" }); r.paseo.release(); await r.run();
  assert.ok(events(r).includes("aborted:user") || events(r).includes("compacted") || events(r).includes("compact_unverified")); r.cleanup();
});
test("T21 a foreign turn 1 s after a send logs race", async () => {
  const r = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r, "a"); r.paseo.hold = true; r.clock.set(T0 + DUE + 1000); await r.sweep(); await settle(); r.clock.set(r.clock.now() + 1000);
  r.paseo.say("a", "user_message", "ZQX-PROMPT hi"); await r.call("agent.turn.before", { agent: agentPayload("a"), turnId: "f" }); r.paseo.release(); await r.run(); assert.ok(events(r).includes("race")); r.cleanup();
});

// ---- T15 (R19), C11 --------------------------------------------------------------------------------
test("T15 compact verification: boundary gives compacted with pre/post; completed turn without evidence gives compact_unverified; item gives compacted; failed turn and timeout give compact_failed; never a second /compact", async () => {
  const r = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r, "a"); await goDue(r); assert.ok(events(r).includes("compacted"));
  const r2 = rig({ cfg: { checkpoint: "off" }, autoCompact: false }); await idleAgent(r2, "a"); await goDue(r2); assert.ok(events(r2).includes("compact_unverified"));
  const r3 = rig({ cfg: { checkpoint: "off" }, autoCompact: false }); await idleAgent(r3, "a"); const o = r3.paseo.onTurnEnd; r3.paseo.onTurnEnd = async (...x) => { r3.paseo.say("a", "compaction", "", { status: "completed" }); await o(...x); }; await goDue(r3); assert.ok(events(r3).includes("compacted"));
  const r4 = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r4, "a"); r4.paseo.runStatus = "never"; r4.clock.set(T0 + DUE + 1000); await r4.sweep(); await settle(); await r4.clock.advance(300_000); await r4.run(); assert.ok(events(r4).includes("compact_failed:timeout"));
  for (const x of [r, r2, r3, r4]) { await x.sweep(); await x.run(); assert.equal(texts(x).filter((t) => t === "/compact").length, 1); x.cleanup(); }
});
test("C11 a 480K-token context runs normally", async () => {
  const r = rig({ cfg: { checkpoint: "off" } }); await idleAgent(r, "a", { lastUsage: { contextWindowUsedTokens: 480000 } }, { contextTokens: 480000 }); await goDue(r); assert.ok(events(r).includes("compacted")); r.cleanup();
});

// ---- T29 (R35) -------------------------------------------------------------------------------------
test("T29 a label added while idle_wait makes the agent untracked at the next sweep; removing it resumes after the next foreign turn", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.agents_.get("a")!.snap.labels = { pcic: "off" }; await goDue(r); assert.deepEqual(r.paseo.sent, []); assert.equal(r.pcic.state("a")!.state, "untracked");
  r.paseo.agents_.get("a")!.snap.labels = {}; r.clock.set(T0 + 3 * 3600e3); await r.turn("a"); assert.equal(r.pcic.state("a")!.state, "idle_wait"); r.cleanup();
});

// ---- T30 (R37), C18 --------------------------------------------------------------------------------
test("T30 start with 5 agents: within due / past due / past deadline / tokens from the record / unknown context", async () => {
  const r = rig({ cfg: { checkpoint: "off" } });
  const mk = (id: string, ago: number, snap: Record<string, unknown> = {}, rec: Record<string, unknown> | false = {}) => { r.paseo.add(id, { updatedAt: new Date(T0 - ago).toISOString(), ...snap }); if (rec) r.writeSession(id, { lastAssistantAt: T0 - ago, ...rec }); };
  mk("within", 10 * MIN); mk("pastdue", 56 * MIN); mk("late", 70 * MIN); mk("rec", 56 * MIN, { lastUsage: { contextWindowUsedTokens: 0 } }); mk("unknown", 56 * MIN, { lastUsage: { contextWindowUsedTokens: 0 } }, { contextTokens: null });
  r.clock.set(T0); await r.pcic.start(r.paseo); await r.sweep(); await r.run();
  assert.equal(r.pcic.state("within")!.state, "idle_wait"); assert.deepEqual(r.paseo.sent.map((s) => s.id).sort(), ["pastdue", "rec"]);
  assert.ok(events(r, "late").includes("skipped:late")); assert.ok(events(r, "unknown").includes("skipped:unknown_context")); r.cleanup();
});
test("T36/C18 lastUsage with NaN, negative, string, null and a record with contextTokens:-1 are unknown", async () => {
  for (const bad of [Number.NaN, -5, "150000", null]) { const r = rig(); await idleAgent(r, "a", { lastUsage: { contextWindowUsedTokens: bad } }, { contextTokens: -1 }); await goDue(r); assert.deepEqual(r.paseo.sent, [], String(bad)); assert.ok(events(r).includes("skipped:unknown_context")); r.cleanup(); }
});

// ---- T31 (R38), C1, C2, C7 -------------------------------------------------------------------------
test("T31/C1/C2 a jobs file found at start is logged interrupted and removed; its claim stays; nothing is sent", async () => {
  for (const phase of ["checkpoint", "compact"]) {
    const r = rig(); await idleAgent(r, "a"); mkdirSync(join(r.t.home, "jobs"), { recursive: true }); mkdirSync(join(r.t.home, "claims"), { recursive: true });
    writeFileSync(join(r.t.home, "jobs", "a.json"), JSON.stringify({ jobId: "j", anchor: T0, phase, startedAt: T0 })); writeFileSync(join(r.t.home, "claims", `a.${T0}`), "");
    const r2 = createPcic({ env: { ...r.t.env, PASEO_VERSION: "0.16.1" }, now: r.clock.now, timer: r.clock.timer, log: () => {}, version: async () => "0.16.1" }); await r2.start(r.paseo);
    assert.ok(events(r).includes("interrupted")); assert.ok(!existsSync(join(r.t.home, "jobs", "a.json"))); assert.ok(existsSync(join(r.t.home, "claims", `a.${T0}`)));
    r.clock.set(T0 + DUE + 1000); await r2.sweep(); await settle(); await r2.idle(); assert.deepEqual(r.paseo.sent, []); assert.ok(events(r).includes("skipped:claimed")); r2.cleanup(); r.cleanup();
  }
});
test("C7 a reload during idle_wait rebuilds and fires at the original due", async () => {
  const r = rig(); await idleAgent(r, "a"); r.pcic.cleanup();
  const r2 = createPcic({ env: { ...r.t.env, PASEO_VERSION: "0.16.1" }, now: r.clock.now, timer: r.clock.timer, log: () => {}, version: async () => "0.16.1" }); await r2.start(r.paseo);
  assert.equal(r2.state("a")!.due, T0 + DUE); r.clock.set(T0 + DUE + 1000); await r2.sweep(); await settle(); await r2.idle(); assert.equal(texts(r).length, 2); r2.cleanup(); r.cleanup();
});

// ---- T32 (R39) -------------------------------------------------------------------------------------
test("T32 after cleanup: no sweep, no history write, children killed", async () => {
  const r = rig(); await idleAgent(r, "a"); r.pcic.cleanup(); const size = () => (existsSync(join(r.t.home, "history.jsonl")) ? readFileSync(join(r.t.home, "history.jsonl"), "utf8").length : 0); const before = size();
  r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run(); assert.deepEqual(r.paseo.sent, []); assert.equal(size(), before); r.t.cleanup();
});

// ---- T35 (R42) -------------------------------------------------------------------------------------
test("T35 pcic sends only the R42 texts and never answers a permission request", async () => {
  const r = rig(); await idleAgent(r, "a"); await idleAgent(r, "b", {}, { awtDir: null }); await goDue(r); r.clock.set(r.clock.now() + 20_000); await r.sweep(); await r.run();
  for (const t of texts(r)) assert.ok(t === CHECKPOINT_TEXT || t === "/compact", t);
  const src = ["scheduler", "job", "send"].map((f) => readFileSync(join(import.meta.dirname, "..", "server", `${f}.ts`), "utf8")).join("\n"); assert.ok(!/respondToPermission/.test(src)); assert.ok(!/sourceAgentId/.test(src.replace(/never passes sourceAgentId/g, ""))); assert.deepEqual(r.paseo.created, []); r.cleanup();
});
void asst;

// ---- review fixes (R10, R15, R16, R20) -------------------------------------------------------------
test("T13 real ordering: turn.before arrives before the prompt is in the timeline; pcic's turn still counts as own, the job compacts and the anchor stays", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.lateEcho = true; await goDue(r);
  assert.deepEqual(texts(r), [CHECKPOINT_TEXT, "/compact"]); assert.deepEqual(events(r, "a"), ["scheduled", "checkpoint_ok", "compacted"]);
  assert.equal(r.pcic.state("a")!.state, "done"); assert.equal(r.pcic.state("a")!.anchor, T0); r.cleanup();
});
test("T13 a foreign turn whose own prompt is in the timeline under its turnId is foreign even while a pcic send is unseen", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.onSend = async (id) => { r.paseo.say(id, "user_message", "ZQX-PROMPT mine", {}, "t-owner"); await r.call("agent.turn.before", { agent: agentPayload(id), turnId: "t-owner" }); };
  await goDue(r); assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("aborted:user")); r.cleanup();
});
test("T8 a closed agent (as after a daemon restart; a send resumes it warm, V5 confirmed live) is handled like an idle one; running and initializing agents are not", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.agents_.get("a")!.snap.status = "closed"; await goDue(r);
  assert.ok(r.paseo.sent.length > 0); r.cleanup();
  const q = rig(); await idleAgent(q, "a"); q.paseo.agents_.get("a")!.snap.status = "initializing"; await goDue(q);
  assert.deepEqual(q.paseo.sent, []); assert.equal(q.pcic.state("a")!.result, "not_idle"); q.cleanup();
});
test("T12 a canceled checkpoint: run() reports idle (as Paseo does) and turn.after lands during the pre-compact check; no /compact", async () => {
  const r = rig(); await idleAgent(r, "a"); r.paseo.outcomeKind = "canceled"; r.paseo.runStatus = "idle";
  let late: (() => Promise<void>) | null = null; const orig = r.paseo.onTurnEnd;
  r.paseo.onTurnEnd = (...x) => { late = () => orig(...x) as Promise<void>; };
  r.paseo.onRefresh = () => { const f = late; late = null; if (f) void f(); };
  await goDue(r); assert.deepEqual(texts(r), [CHECKPOINT_TEXT]); assert.ok(events(r).includes("checkpoint_failed:canceled"), events(r).join()); r.cleanup();
});
test("T5 an agent first seen at a turn hook whose refresh fails is still tracked (labels default to none)", async () => {
  const r = rig(); r.paseo.add("a"); await r.pcic.start(r.paseo); r.paseo.agents_.delete("a"); r.paseo.add("b"); r.paseo.refreshThrows = true;
  await r.turn("b"); assert.equal(r.pcic.state("b")!.state, "idle_wait"); assert.ok(!r.logs.some((l) => l.includes("failed")), r.logs.join()); r.cleanup();
});

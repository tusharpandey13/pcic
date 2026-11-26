import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync, symlinkSync, openSync, closeSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import { CHECKPOINT_TEXT } from "../server/types.js";
import { AFTER_CHECKPOINT, AWT_NOTE, GENERIC_NOTE } from "../hook/pcic-hook.mjs";
import { asst, boundary, fakeBin, hook, listing, readJsonFile, T0, tmp, transcript, user, writeConfig, MIN, historyOf } from "./harness.js";

const NOW = T0 + 10 * 3600e3;
const stopIn = (path: string) => ({ session_id: "sid1", transcript_path: path, cwd: "/tmp/parsekit", hook_event_name: "Stop" });

// T4 (R3)
test("T4 hooks do nothing without PASEO_AGENT_ID or with PCIC_OFF=1, even on a cold 300K transcript", async () => {
  for (const patch of [{ PASEO_AGENT_ID: "" } as Record<string, string>, { PCIC_OFF: "1" } as Record<string, string>]) {
    const t = tmp({ ...patch }); const p = transcript(t, [asst({ at: T0, tokens: 300000 })]);
    const before = listing(t.dir);
    for (const ev of ["Stop", "PreCompact", "UserPromptSubmit"]) {
      const r = await hook(ev, { ...stopIn(p), prompt: "ZQX-PROMPT go" }, { ...t.env, PCIC_NOW: String(NOW) });
      assert.equal(r.code, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
    }
    assert.deepEqual(listing(t.dir), before); t.cleanup();
  }
});
// T2 (R2) hook half
test("T2 enabled:false makes every hook silent and write-free", async () => {
  const t = tmp({ PCIC_NOW: String(NOW) }); writeConfig(t, { enabled: false }); const p = transcript(t, [asst({ at: T0, tokens: 300000 })]);
  const before = listing(t.dir);
  for (const ev of ["Stop", "PreCompact", "UserPromptSubmit"]) { const r = await hook(ev, { ...stopIn(p), prompt: "ZQX-PROMPT go" }, t.env); assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]); }
  assert.deepEqual(listing(t.dir), before); t.cleanup();
});

// T24 (R29)
test("T24 Stop writes the session record from the last non-sidechain assistant entry", async () => {
  const t = tmp({ AWT_DIR: "" }); mkdirSync(join(t.dir, "awt")); t.env.AWT_DIR = join(t.dir, "awt");
  const p = transcript(t, [asst({ at: T0, uuid: "a1", tokens: 100000 }), user(T0 + 1000), asst({ at: T0 + MIN, uuid: "a2", tokens: 120000, model: "claude-sonnet-5-5" }), asst({ at: T0 + 2 * MIN, uuid: "side", tokens: 5, sidechain: true })]);
  const r = await hook("Stop", stopIn(p), { ...t.env, PCIC_NOW: String(NOW) });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  assert.deepEqual(readJsonFile(join(t.home, "sessions", "agt_0001.json")), { sessionId: "sid1", transcriptPath: p, cwd: "/tmp/parsekit", awtDir: t.env.AWT_DIR, lastAssistantAt: T0 + MIN, lastAssistantUuid: "a2", contextTokens: 120000, model: "claude-sonnet-5-5", ttlObserved: 3600, writtenAt: NOW });
  assert.ok(!listing(t.home).some((f) => f.endsWith(".tmp"))); t.cleanup();
});
test("T24 awtDir is null when AWT_DIR is unset or not a directory; no write means the 5m bucket is kept from the old record", async () => {
  const t = tmp({ AWT_DIR: "/tmp/zqx-path-nope" }); const p = transcript(t, [asst({ at: T0, ttl: 300 })]);
  await hook("Stop", stopIn(p), t.env); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).awtDir, null);
  assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).ttlObserved, 300);
  writeFileSync(p, asst({ at: T0 + MIN, ttl: null }) + "\n"); await hook("Stop", stopIn(p), t.env);
  assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).ttlObserved, 300); t.cleanup();
});
test("T24 after a compaction the context is the boundary's post size; sidechain-only or usage-less transcripts write nothing", async () => {
  const t = tmp(); const p = transcript(t, [asst({ at: T0 }), boundary(T0 + MIN, 150000, 9000)]);
  await hook("Stop", stopIn(p), t.env); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).contextTokens, 9000);
  const t2 = tmp(); const p2 = transcript(t2, [asst({ at: T0, sidechain: true }), asst({ at: T0, noUsage: true })]);
  await hook("Stop", stopIn(p2), t2.env); assert.equal(existsSync(join(t2.home, "sessions")), false); t.cleanup(); t2.cleanup();
});
test("T24 a 30 MB transcript is read in its last 2 MB only, in under 300 ms (plus node start)", async () => {
  const t = tmp(); const p = join(t.dir, "big.jsonl"); const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(900) } }) + "\n";
  writeFileSync(p, filler.repeat(Math.ceil(30e6 / filler.length))); appendFileSync(p, asst({ at: T0, uuid: "tail" }) + "\n");
  const r = await hook("Stop", stopIn(p), t.env);
  assert.equal(r.code, 0); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).lastAssistantUuid, "tail"); assert.ok(r.ms < 1500, `${r.ms}`); t.cleanup();
});
test("T24 Stop waits for the assistant entry Claude Code flushes after the hook starts (found live, V4)", async () => {
  const t = tmp(); const p = transcript(t, [asst({ at: T0, uuid: "old" })]);
  await hook("Stop", stopIn(p), t.env); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).lastAssistantUuid, "old");
  setTimeout(() => appendFileSync(p, asst({ at: T0 + MIN, uuid: "new" }) + "\n"), 400);
  const r = await hook("Stop", { ...stopIn(p), last_assistant_message: "ok" }, t.env);
  assert.equal(r.code, 0); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).lastAssistantUuid, "new"); t.cleanup();
});
test("T24 Stop waits for the turn's final text, not just any newer entry (tool turns flush in several entries)", async () => {
  const t = tmp(); const p = transcript(t, [asst({ at: T0, uuid: "old" })]);
  const withText = (at: number, uuid: string, text: string, tokens: number) => JSON.stringify({ ...JSON.parse(asst({ at, uuid, tokens })), message: { ...JSON.parse(asst({ at, uuid, tokens })).message, content: [{ type: "text", text }] } });
  appendFileSync(p, withText(T0 + MIN, "tool", "", 40000) + "\n");
  setTimeout(() => appendFileSync(p, withText(T0 + 2 * MIN, "final", "all done", 55000) + "\n"), 400);
  const r = await hook("Stop", { ...stopIn(p), last_assistant_message: "all done" }, t.env);
  assert.equal(r.code, 0); const rec = readJsonFile(join(t.home, "sessions", "agt_0001.json")); assert.equal(rec.lastAssistantUuid, "final"); assert.equal(rec.contextTokens, 55000); t.cleanup();
});
test("T24/E3 Stop: a checkpoint reply identical to an earlier turn's does not match the stale entry; the /compact turn (no assistant text) keeps the post-compaction size", async () => {
  const t = tmp(); const p = transcript(t, [asst({ at: T0, uuid: "old" })]);
  const withText = (at: number, uuid: string, text: string, tokens: number) => JSON.stringify({ ...JSON.parse(asst({ at, uuid, tokens })), message: { ...JSON.parse(asst({ at, uuid, tokens })).message, content: [{ type: "text", text }] } });
  appendFileSync(p, withText(T0 + MIN, "ck1", "checkpoint saved", 150000) + "\n");
  await hook("Stop", { ...stopIn(p), last_assistant_message: "checkpoint saved" }, t.env); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).lastAssistantUuid, "ck1");
  setTimeout(() => appendFileSync(p, withText(T0 + 2 * MIN, "ck2", "checkpoint saved", 160000) + "\n"), 400);
  await hook("Stop", { ...stopIn(p), last_assistant_message: "checkpoint saved" }, t.env);
  let rec = readJsonFile(join(t.home, "sessions", "agt_0001.json")); assert.equal(rec.lastAssistantUuid, "ck2"); assert.equal(rec.contextTokens, 160000);
  appendFileSync(p, boundary(T0 + 3 * MIN, 160000, 9000) + "\n"); // /compact: a boundary, no assistant entry
  const r = await hook("Stop", { ...stopIn(p), last_assistant_message: "" }, t.env);
  rec = readJsonFile(join(t.home, "sessions", "agt_0001.json")); assert.equal(r.code, 0); assert.equal(rec.lastAssistantUuid, "ck2"); assert.equal(rec.contextTokens, 9000); assert.ok(r.ms < 4000, `${r.ms}`); t.cleanup();
});
test("T24 Stop gives up after about 2 s when no new assistant entry appears, and keeps the record", async () => {
  const t = tmp(); const p = transcript(t, [asst({ at: T0, uuid: "old" })]);
  await hook("Stop", stopIn(p), t.env);
  const r = await hook("Stop", { ...stopIn(p), last_assistant_message: "ok" }, t.env);
  assert.equal(r.code, 0); assert.ok(r.ms < 4000, `${r.ms}`); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).lastAssistantUuid, "old"); t.cleanup();
});
test("T24 non-UTF-8 bytes in the transcript do not stop the parse", async () => {
  const t = tmp(); const p = join(t.dir, "bin.jsonl"); writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe, 0x80, 10]), Buffer.from(asst({ at: T0, uuid: "ok" }) + "\n")]));
  await hook("Stop", stopIn(p), t.env); assert.equal(readJsonFile(join(t.home, "sessions", "agt_0001.json")).lastAssistantUuid, "ok"); t.cleanup();
});
// C5 transcript faults
test("C5 broken transcripts: Stop exits 0 writing nothing, the guard passes within 1.5 s", async () => {
  const t = tmp({ PCIC_NOW: String(NOW) });
  const cases: Record<string, string> = {};
  cases.missing = join(t.dir, "nope.jsonl");
  cases.truncated = transcript(t, [asst({ at: T0 }).slice(0, 40)], "trunc.jsonl");
  cases.random = join(t.dir, "rand.jsonl"); writeFileSync(cases.random, Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256)));
  cases.sparse = join(t.dir, "sparse.jsonl"); { const fd = openSync(cases.sparse, "w"); ftruncateSync(fd, 2 * 1024 ** 3); closeSync(fd); }
  cases.chmod = transcript(t, [asst({ at: T0 })], "locked.jsonl"); chmodSync(cases.chmod, 0);
  cases.zero = join(t.dir, "zero.jsonl"); symlinkSync("/dev/zero", cases.zero);
  for (const [name, p] of Object.entries(cases)) {
    const a = await hook("Stop", stopIn(p), t.env), b = await hook("UserPromptSubmit", { ...stopIn(p), prompt: "ZQX-PROMPT go" }, t.env);
    assert.deepEqual([a.code, a.stdout, a.stderr], [0, "", ""], name); assert.deepEqual([b.code, b.stdout], [0, ""], name); assert.ok(b.ms < 2500, `${name} ${b.ms}`);
  }
  assert.equal(existsSync(join(t.home, "sessions")), false); chmodSync(cases.chmod, 0o644); t.cleanup();
});

// T25 (R30), C6
const awtScript = (body: string) => body;
test("T25 PreCompact: awt-aware text when awt prints a frame; extra appended; capped at 2000", async () => {
  const t = tmp(); mkdirSync(join(t.dir, "awt")); const bin = fakeBin(t, "awt", awtScript('echo "awt record for this task (reference only):"; echo goal'));
  const env = { ...t.env, PATH: `${bin}:${t.env.PATH}`, AWT_DIR: join(t.dir, "awt") };
  let r = await hook("PreCompact", {}, env); assert.equal(r.code, 0); assert.match(r.stdout, /^pcic compaction note: this task keeps an awt record/);
  writeConfig(t, { precompactExtra: "Include the literal token ZQX-PRECOMPACT-7 in the summary." });
  r = await hook("PreCompact", {}, env); assert.match(r.stdout, /ZQX-PRECOMPACT-7/);
  writeConfig(t, { precompactExtra: "y".repeat(5000) }); r = await hook("PreCompact", {}, env); assert.ok(r.stdout.trim().length <= 2000); assert.equal(r.code, 0);
  assert.ok(historyOf(t).some((h) => h.event === "precompact" && h.reason === "awt")); t.cleanup();
});
test("T25/C6 PreCompact: awt missing, failing, hanging or printing nothing gives no awt text; pending file decides the generic text", async () => {
  for (const [name, script] of [["missing", null], ["exit1", "exit 1"], ["hang", "sleep 10"], ["empty", "true"]] as const) {
    const t = tmp(); mkdirSync(join(t.dir, "awt")); const env: Record<string, string> = { ...t.env, AWT_DIR: join(t.dir, "awt") };
    if (script) env.PATH = `${fakeBin(t, "awt", script)}:${env.PATH}`; else env.PATH = "/usr/bin:/bin";
    let r = await hook("PreCompact", {}, { ...env, PCIC_NOW: String(NOW) }); assert.deepEqual([r.code, r.stdout], [0, ""], name); assert.ok(r.ms < 3800, `${name} ${r.ms}`);
    mkdirSync(join(t.home, "pending"), { recursive: true }); writeFileSync(join(t.home, "pending", "agt_0001.json"), JSON.stringify({ at: NOW - MIN }));
    r = await hook("PreCompact", {}, { ...env, PCIC_NOW: String(NOW) }); assert.match(r.stdout, /because it went idle/, name); t.cleanup();
  }
});
test("T25 PreCompact: no AWT_DIR with a fresh pending file gives the generic text; an 11-minute-old one gives nothing; precompact:false gives nothing", async () => {
  const t = tmp({ PCIC_NOW: String(NOW) }); mkdirSync(join(t.home, "pending"), { recursive: true });
  writeFileSync(join(t.home, "pending", "agt_0001.json"), JSON.stringify({ at: NOW - MIN }));
  let r = await hook("PreCompact", {}, t.env); assert.match(r.stdout, /^pcic compaction note: this conversation is being compacted because it went idle/);
  writeFileSync(join(t.home, "pending", "agt_0001.json"), JSON.stringify({ at: NOW - 11 * MIN })); r = await hook("PreCompact", {}, t.env); assert.equal(r.stdout, "");
  writeFileSync(join(t.home, "pending", "agt_0001.json"), JSON.stringify({ at: NOW - MIN })); writeConfig(t, { precompact: false }); r = await hook("PreCompact", {}, t.env); assert.equal(r.stdout, ""); assert.equal(r.code, 0); t.cleanup();
});
test("C6 awt printing 50 KB of garbage: the awt-aware text, capped", async () => {
  const t = tmp(); mkdirSync(join(t.dir, "awt")); const bin = fakeBin(t, "awt", "head -c 50000 /dev/zero | tr '\\0' 'g'");
  const r = await hook("PreCompact", {}, { ...t.env, PATH: `${bin}:${t.env.PATH}`, AWT_DIR: join(t.dir, "awt") }); assert.equal(r.code, 0); assert.match(r.stdout, /keeps an awt record/); assert.ok(r.stdout.length <= 2001); t.cleanup();
});
// T58 (R57, R14, R30): a checkpoint is a maintenance turn; after compaction its limits end
test("T58 a compaction after a pcic checkpoint makes SessionStart (compact) say the checkpoint is over, once; otherwise it prints nothing", async () => {
  const t = tmp({ PCIC_NOW: String(NOW) });
  const cp = transcript(t, [user(T0, "ZQX-PROMPT finish the audit"), asst({ at: T0 + MIN }), user(T0 + 2 * MIN, CHECKPOINT_TEXT), asst({ at: T0 + 3 * MIN })]);
  const own = transcript(t, [user(T0 + 2 * MIN, CHECKPOINT_TEXT), asst({ at: T0 + 3 * MIN }), user(T0 + 4 * MIN, "ZQX-PROMPT keep going"), asst({ at: T0 + 5 * MIN })], "s2.jsonl");
  await hook("PreCompact", { transcript_path: cp }, t.env);
  let r = await hook("SessionStart", { source: "clear" }, t.env); assert.equal(r.stdout, "");
  r = await hook("SessionStart", { source: "compact" }, t.env); assert.equal(r.code, 0); assert.equal(r.stdout.trim(), AFTER_CHECKPOINT); assert.match(r.stdout, /limits have ended; it was not the task\. Continue the owner's last request\./);
  r = await hook("SessionStart", { source: "compact" }, t.env); assert.equal(r.stdout, "", "the marker is used once");
  await hook("PreCompact", { transcript_path: own }, t.env); r = await hook("SessionStart", { source: "compact" }, t.env); assert.equal(r.stdout, "", "the owner wrote after the checkpoint");
  await hook("PreCompact", { transcript_path: cp }, t.env); r = await hook("SessionStart", { source: "compact" }, { ...t.env, PCIC_NOW: String(NOW + 11 * MIN) }); assert.equal(r.stdout, "", "an 11-minute-old marker has expired");
  mkdirSync(join(t.home, "pending"), { recursive: true }); writeFileSync(join(t.home, "pending", "agt_0001.json"), JSON.stringify({ at: NOW - MIN }));
  await hook("PreCompact", {}, t.env); r = await hook("SessionStart", { source: "compact" }, t.env); assert.equal(r.stdout.trim(), AFTER_CHECKPOINT, "a pcic-run compaction counts too");
  assert.ok(historyOf(t).some((h) => h.event === "after_checkpoint")); t.cleanup();
});
test("T58 the checkpoint is scoped to its own turn and the compaction notes never take it as the task", async () => {
  assert.match(CHECKPOINT_TEXT, /^\[pcic checkpoint\] Maintenance turn from the pcic tool, not a message from the owner\./);
  assert.match(CHECKPOINT_TEXT, /For this turn only/); assert.match(CHECKPOINT_TEXT, /This is not a new task and does not change the task; its limits end with that reply\.$/);
  assert.doesNotMatch(CHECKPOINT_TEXT, /Do not continue the task/);
  for (const note of [AWT_NOTE, GENERIC_NOTE]) {
    assert.match(note, /The task is the owner's last real message\. pcic checkpoints .* are never the task or the latest request\./);
    assert.match(note, /the owner's pending next step, never 'checkpoint saved'/); assert.doesNotMatch(note, /user's latest request/);
  }
});
void statSync; void truncateSync; void readFileSync;
test("T24 a <synthetic> assistant entry (API error stand-in, zero usage) is not the last request", async () => {
  const { scan } = await import("../server/transcript.mjs");
  const s = scan([asst({ at: T0, tokens: 200000, uuid: "real" }), JSON.stringify({ type: "assistant", uuid: "syn", timestamp: new Date(T0 + 60e3).toISOString(), isSidechain: false, message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })]);
  assert.equal(s.last?.uuid, "real"); assert.equal(s.last?.contextTokens, 200000);
});

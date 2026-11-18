import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPcic } from "../server/scheduler.js";
import { CHECKPOINT_TEXT } from "../server/types.js";
import { DUE_ } from "./send-consts.js";
import { MIN, T0, fakeBin, historyOf, idleAgent, readJsonFile, rig, settle, type Rig } from "./harness.js";

const DUE = DUE_;
const events = (r: Rig) => historyOf(r.t).map((h) => (h.reason ? `${h.event}:${h.reason}` : h.event));
import { readdirSync } from "node:fs";
const readdirSafe = (d: string) => readdirSync(d);
const waitFor = async (cond: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((x) => setTimeout(x, 20)); assert.ok(cond(), "condition not met in time"); };
const writeVerdict = (r: Rig, v: unknown) => writeFileSync(join(r.t.home, "verdict.json"), JSON.stringify(v));

// T17 (R21, R22)
test("T17 forced modes are honoured; auto uses a matching verdict, ignores another version's, and defaults to plugin", async () => {
  const r = rig({ cfg: { sendMode: "cli" } }); await r.pcic.start(r.paseo); assert.equal(r.pcic.sender.mode(), "cli"); r.cleanup();
  const r2 = rig({ cfg: { sendMode: "plugin" } }); writeVerdict(r2, { paseoVersion: "0.16.1", mode: "cli", at: T0, tries: 0 }); await r2.pcic.start(r2.paseo); assert.equal(r2.pcic.sender.mode(), "plugin"); r2.cleanup();
  const r3 = rig(); writeVerdict(r3, { paseoVersion: "0.16.1", mode: "cli", at: T0, tries: 0 }); await r3.pcic.start(r3.paseo); assert.equal(r3.pcic.sender.mode(), "cli");
  const r4 = rig(); writeVerdict(r4, { paseoVersion: "0.15.0", mode: "cli", at: T0, tries: 0 }); await r4.pcic.start(r4.paseo); assert.equal(r4.pcic.sender.mode(), "plugin"); r3.cleanup(); r4.cleanup();
});
test("T17 without a verdict: plugin until the self-test, which runs once, 60 s after start, with nothing queued", async () => {
  const r = rig({ noVerdict: true }); await r.pcic.start(r.paseo); assert.equal(r.pcic.sender.mode(), "plugin");
  await r.sweep(); assert.equal(r.paseo.created.length, 0); r.clock.set(T0 + 30_000); await r.sweep(); assert.equal(r.paseo.created.length, 0);
  r.clock.set(T0 + 61_000); await r.sweep(); await r.sweep(); assert.equal(r.paseo.created.length, 1); assert.equal(readJsonFile(join(r.t.home, "verdict.json")).mode, "plugin");
  assert.deepEqual(r.paseo.sent.map((s) => s.text), ["/compact"]); assert.deepEqual(r.paseo.archived, ["probe_1"]); assert.equal((r.paseo.created[0].labels as any).pcic, "probe"); r.cleanup();
});
test("T17 a queued job delays the self-test", async () => {
  const r = rig({ noVerdict: true }); await idleAgent(r, "a"); r.paseo.hold = true; r.clock.set(T0 + DUE + 1000); await r.sweep(); await settle(); assert.equal(r.paseo.created.length, 0); r.paseo.release(); await r.run(); r.cleanup();
});

// T18 (R23), C19
const probe = async (setup: (r: Rig) => void) => { const r = rig({ noVerdict: true }); setup(r); await r.pcic.start(r.paseo); r.clock.set(T0 + 61_000); await r.sweep(); await r.sweep(); return r; };
test("T18 recorded probe timelines: plain, enveloped, assistant reply", async () => {
  const plain = await probe((r) => (r.paseo.probeTimeline = [{ item: { type: "user_message", text: "/compact" } }, { item: { type: "error", text: "Not enough messages to compact" } }]));
  assert.equal(readJsonFile(join(plain.t.home, "verdict.json")).mode, "plugin"); assert.deepEqual(plain.paseo.archived, ["probe_1"]);
  const env = await probe((r) => (r.paseo.probeTimeline = [{ item: { type: "user_message", text: "<paseo-system>from X</paseo-system>\n/compact" } }]));
  assert.equal(readJsonFile(join(env.t.home, "verdict.json")).mode, "cli"); assert.deepEqual(env.paseo.archived, ["probe_1"]);
  const reply = await probe((r) => (r.paseo.probeTimeline = [{ item: { type: "user_message", text: "/compact" } }, { item: { type: "assistant_message", text: "Sure, compacting" } }]));
  assert.equal(readJsonFile(join(reply.t.home, "verdict.json")).mode, "cli"); for (const x of [plain, env, reply]) x.cleanup();
});
test("T18/C19 create throws or send throws: no verdict mode, tries counted, at most 3 tries per version, the probe archived; archive throwing still records the verdict", async () => {
  const c = rig({ noVerdict: true }); c.paseo.createThrows = true; let n = 0; const orig = c.paseo.agents.create; c.paseo.agents.create = async (o) => { n++; return orig(o); };
  for (let i = 0; i < 5; i++) { // five restarts: tries stop at 3
    const p = createPcic({ env: { ...c.t.env, PASEO_VERSION: "0.16.1" }, now: c.clock.now, timer: c.clock.timer, log: () => {}, version: async () => "0.16.1" }); await p.start(c.paseo);
    c.clock.set(c.clock.now() + 61_000); await p.sweep(); await p.sweep(); p.cleanup(); } assert.equal(n, 3); assert.equal(readJsonFile(join(c.t.home, "verdict.json")).mode, null); assert.equal(readJsonFile(join(c.t.home, "verdict.json")).tries, 3); assert.equal(c.pcic.sender.mode(), "plugin");
  const s = await probe((r) => (r.paseo.sendThrows = true)); assert.equal(readJsonFile(join(s.t.home, "verdict.json")).mode, null); assert.deepEqual(s.paseo.archived, ["probe_1"]);
  const a = await probe((r) => (r.paseo.archiveThrows = true)); assert.equal(readJsonFile(join(a.t.home, "verdict.json")).mode, "plugin"); assert.ok(a.logs.some((l) => /archive failed/.test(l)));
  const l = rig({ noVerdict: true }); l.paseo.add("old_probe", { labels: { pcic: "probe" } }); await l.pcic.start(l.paseo); assert.deepEqual(l.paseo.archived, ["old_probe"]); assert.equal(l.pcic.state("old_probe"), undefined);
  for (const x of [c, s, a, l]) x.cleanup();
});
test("T18 a new Paseo version runs the self-test again (J9)", async () => {
  const r = rig({ noVerdict: true, version: "0.17.0" }); writeVerdict(r, { paseoVersion: "0.16.1", mode: "plugin", at: T0, tries: 0 }); await r.pcic.start(r.paseo); r.clock.set(T0 + 61_000); await r.sweep(); await r.sweep();
  assert.equal(r.paseo.created.length, 1); assert.equal(readJsonFile(join(r.t.home, "verdict.json")).paseoVersion, "0.17.0"); r.cleanup();
});

// T20 (R25)
test("T20 plugin mode: a /compact turn with a model reply is compact_failed and switches to cli for the next job", async () => {
  const r = rig({ cfg: { checkpoint: "off", staggerSeconds: 5 }, autoCompact: false }); await idleAgent(r, "a"); await idleAgent(r, "b");
  const o = r.paseo.onTurnEnd; r.paseo.onTurnEnd = async (...x) => { r.paseo.say(x[0], "assistant_message", "Compacting now"); await o(...x); };
  r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run();
  assert.ok(events(r).includes("compact_failed:not_plain")); assert.equal(readJsonFile(join(r.t.home, "verdict.json")).mode, "cli"); assert.equal(r.pcic.sender.mode(), "cli"); r.cleanup();
});
test("T20 an enveloped /compact turn is not mistaken for the owner's: compact_failed, verdict cli", async () => {
  const r = rig({ cfg: { checkpoint: "off" }, autoCompact: false }); await idleAgent(r, "a");
  r.paseo.onSend = async (id) => { const page = r.paseo.agents_.get(id)!.page as any[]; page[page.length - 1].item.text = "<paseo-system>x</paseo-system>\n/compact"; await r.call("agent.turn.before", { agent: { id, provider: "claude", cwd: "/tmp/parsekit", parentAgentId: null }, turnId: "own" }); };
  r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run(); assert.ok(events(r).includes("compact_failed:not_plain")); assert.equal(r.pcic.sender.mode(), "cli"); r.cleanup();
});

// T19, C14 (R24)
const cliRig = (script: string, extra: Record<string, unknown> = {}) => {
  const r = rig({ cfg: { checkpoint: "off", sendMode: "cli", ...extra }, autoTurn: false, cliTimeoutMs: 1500, env: { PASEO_AGENT_ID: "agt_boss", PASEO_AGENT_CWD: "/tmp/x", PASEO_WORKSPACE_ID: "wks_9", KEEP_ME: "yes" } });
  const out = join(r.t.dir, "out"); mkdirSync(out);
  const dir = fakeBin(r.t, "paseo", script.replaceAll("$OUT", out)); writeFileSync(join(r.t.home, "config.json"), JSON.stringify({ staggerSeconds: 0, minContextTokens: 100000, checkpoint: "off", sendMode: "cli", paseoBin: join(dir, "paseo"), ...extra }));
  return { r, out };
};
test("T19 cli mode: argv is [agent, send, id, /compact] without a shell, identity vars removed, other env kept", async () => {
  const { r, out } = cliRig('for a in "$@"; do printf "%s\\n" "$a"; done > $OUT/argv; env > $OUT/env'); await idleAgent(r, "a"); r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run(); await waitFor(() => events(r).some((e) => e.startsWith("compact")));
  assert.deepEqual(readFileSync(join(out, "argv"), "utf8").trim().split("\n"), ["agent", "send", "a", "/compact"]); const env = readFileSync(join(out, "env"), "utf8");
  assert.ok(!/^PASEO_AGENT_ID=/m.test(env) && !/^PASEO_AGENT_CWD=/m.test(env) && !/^PASEO_WORKSPACE_ID=/m.test(env)); assert.match(env, /^KEEP_ME=yes$/m); assert.match(env, /^PCIC_HOME=/m); assert.deepEqual(r.paseo.sent, []); r.cleanup();
});
test("T19/C14 cli failures: exit 1, exit 2 with stderr only, a missing binary and a hang all give send_failed and no retry", async () => {
  for (const script of ["exit 1", "echo oops >&2; exit 2", "sleep 30"]) {
    const { r } = cliRig(script); await idleAgent(r, "a"); r.clock.set(T0 + DUE + 1000); await r.sweep(); await waitFor(() => events(r).includes("compact_failed:send_failed")); await r.sweep(); await r.run(); assert.equal(events(r).filter((e) => e.startsWith("compact_failed")).length, 1); r.cleanup();
  }
  const m = rig({ cfg: { checkpoint: "off", sendMode: "cli", paseoBin: "/nonexistent/paseo" }, autoTurn: false }); await idleAgent(m, "a"); m.clock.set(T0 + DUE + 1000); await m.sweep(); await waitFor(() => events(m).includes("compact_failed:send_failed")); m.cleanup();
});
test("T32 cleanup kills a live cli child", async () => {
  const { r, out } = cliRig(`echo $$ > $OUT/pid; sleep 30`, {}); await idleAgent(r, "a"); r.clock.set(T0 + DUE + 1000);
  const rr = r; rr.pcic.cleanup; (rr as any).pcic.sender.killChildren; // eslint
  void rr; await r.sweep(); await waitFor(() => { try { return readFileSync(join(out, "pid"), "utf8").trim() !== ""; } catch { return false; } });
  const pid = Number(readFileSync(join(out, "pid"), "utf8")); r.pcic.cleanup(); await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }); r.t.cleanup();
});
void CHECKPOINT_TEXT; void MIN; void chmodSync;

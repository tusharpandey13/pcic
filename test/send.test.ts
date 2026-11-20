import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKPOINT_TEXT } from "../server/types.js";
import { DUE_ } from "./send-consts.js";
import { MIN, T0, fakeBin, historyOf, idleAgent, readJsonFile, rig, settle, type Rig } from "./harness.js";

const DUE = DUE_;
const events = (r: Rig) => historyOf(r.t).map((h) => (h.reason ? `${h.event}:${h.reason}` : h.event));
import { readdirSync } from "node:fs";
const readdirSafe = (d: string) => readdirSync(d);
const waitFor = async (cond: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((x) => setTimeout(x, 20)); assert.ok(cond(), "condition not met in time"); };
const writeVerdict = (r: Rig, v: unknown) => writeFileSync(join(r.t.home, "verdict.json"), JSON.stringify(v));

// T17 (R21, R53)
test("T17 sendMode: cli forces cli; plugin and auto both mean plugin; a leftover verdict.json is ignored", async () => {
  const r = rig({ cfg: { sendMode: "cli" } }); await r.pcic.start(r.paseo); assert.equal(r.pcic.sender.mode(), "cli"); r.cleanup();
  for (const sendMode of ["plugin", "auto"]) {
    const r2 = rig({ cfg: { sendMode } }); writeVerdict(r2, { paseoVersion: "0.16.1", mode: "cli", at: T0, tries: 0 }); await r2.pcic.start(r2.paseo); assert.equal(r2.pcic.sender.mode(), "plugin", sendMode); r2.cleanup();
  }
});

// T47 (R53): no self-test, no automatic switch to cli
test("T47 R53 no probe: nothing is created or sent at start or 60 s later, and no verdict.json is written", async () => {
  const r = rig({ cfg: { sendMode: "auto" } }); await r.pcic.start(r.paseo); await r.sweep(); r.clock.set(T0 + 61_000); await r.sweep(); await r.sweep();
  assert.deepEqual(r.paseo.sent, []); assert.equal(existsSync(join(r.t.home, "verdict.json")), false); assert.ok(!historyOf(r.t).some((h) => h.event === "probe")); r.cleanup();
});
test("T47 R53 a /compact turn with a model reply or an envelope is not a switch to cli: the mode stays plugin and nothing is written", async () => {
  const r = rig({ cfg: { checkpoint: "off", staggerSeconds: 5 }, autoCompact: false }); await idleAgent(r, "a"); await idleAgent(r, "b");
  const o = r.paseo.onTurnEnd; r.paseo.onTurnEnd = async (...x) => { r.paseo.say(x[0], "assistant_message", "Compacting now"); await o(...x); };
  r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run(); r.clock.set(r.clock.now() + 20_000); await r.sweep(); await r.run();
  assert.ok(!events(r).some((e) => e.includes("not_plain"))); assert.equal(r.pcic.sender.mode(), "plugin"); assert.equal(existsSync(join(r.t.home, "verdict.json")), false);
  assert.deepEqual(r.paseo.sent.map((x) => x.text).filter((t) => t === "/compact").length, 2); r.cleanup();
});

// T19, C14 (R24)
const cliRig = (script: string, extra: Record<string, unknown> = {}) => {
  const r = rig({ cfg: { checkpoint: "off", sendMode: "cli", ...extra }, autoTurn: false, cliTimeoutMs: 1500, env: { PASEO_AGENT_ID: "agt_boss", PASEO_AGENT_CWD: "/tmp/x", PASEO_WORKSPACE_ID: "wks_9", KEEP_ME: "yes" } });
  const out = join(r.t.dir, "out"); mkdirSync(out);
  const dir = fakeBin(r.t, "paseo", script.replaceAll("$OUT", out)); writeFileSync(join(r.t.home, "config.json"), JSON.stringify({ staggerSeconds: 0, minContextTokens: 100000, checkpoint: "off", sendMode: "cli", paseoBin: join(dir, "paseo"), ...extra }));
  return { r, out };
};
test("T19 cli mode: argv is [agent, send, --behavior, steer, id, /compact] without a shell, identity vars removed, other env kept", async () => {
  const { r, out } = cliRig('for a in "$@"; do printf "%s\\n" "$a"; done > $OUT/argv; env > $OUT/env'); await idleAgent(r, "a"); r.clock.set(T0 + DUE + 1000); await r.sweep(); await r.run(); await waitFor(() => events(r).some((e) => e.startsWith("compact")));
  assert.deepEqual(readFileSync(join(out, "argv"), "utf8").trim().split("\n"), ["agent", "send", "--behavior", "steer", "a", "/compact"]); const env = readFileSync(join(out, "env"), "utf8");
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

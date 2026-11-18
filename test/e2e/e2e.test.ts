// Tier E (live, isolated, paid). Gated: PCIC_E2E=1 starts an isolated Paseo daemon in a temp home (never ~/.paseo);
// PCIC_E2E_PAID=1 additionally allows cases that spend model tokens. Run only with the owner's approval (E2E-RUBRIC.md).
// AUTH: a dedicated CLAUDE_CONFIG_DIR the owner logged in once (PCIC_E2E_CLAUDE_CONFIG_DIR). HOME is NOT redirected: the macOS keychain
// entry lives under the real HOME and a temp HOME gives "Not logged in". Everything else (Paseo home, PCIC_HOME, project, awt nodes) is in a temp dir.
// Cases run in phases; the cases of one phase run concurrently (they share one daemon) and are reported one by one.
// Spend is estimated from the transcripts with haiku-class prices and the run aborts at PCIC_E2E_CAP (default 1.9 USD).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CHECKPOINT_TEXT } from "../../server/types.js";

const ON = process.env.PCIC_E2E === "1";
const AUTH = Boolean(process.env.PCIC_E2E_CLAUDE_CONFIG_DIR || process.env.CLAUDE_CODE_OAUTH_TOKEN);
const PAID = process.env.PCIC_E2E_PAID === "1" && AUTH;
const CAP = Number(process.env.PCIC_E2E_CAP ?? 1.9);
const REPO = resolve(import.meta.dirname, "..", "..");
const LOG = process.env.PCIC_E2E_LOG ?? "/tmp/pcic-run";
const FAKE_ACP = process.env.PCIC_E2E_FAKE_ACP ?? "/Users/t/src/awt/paseo-plugin/test/fake/acp_agent.py";
let tmp = "", home = "", pcic = "", claude = "", proj = "", env: NodeJS.ProcessEnv = {};
const KNOBS = { ttlSeconds: 240, idleSeconds: 120, lateGraceSeconds: 30, minContextTokens: 30000, sweepSeconds: 5, staggerSeconds: 5, maxConcurrent: 6, checkpointTimeoutSeconds: 120, compactTimeoutSeconds: 120, precompactExtra: "Include the literal token ZQX-PRECOMPACT-7 in the summary." };

type R = { code: number; out: string; err: string };
const sh = (cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string } = {}) => new Promise<R>((ok) => execFile(cmd, args, { env: o.env ?? env, cwd: o.cwd, encoding: "utf8", timeout: o.timeout ?? 180_000, maxBuffer: 20e6 }, (e, out, err) => ok({ code: e ? ((e as any).code ?? 1) : 0, out, err })));
const pas = (...a: string[]) => sh("paseo", ["--home", home, ...a]);
const paseoSync = (...a: string[]) => execFileSync("paseo", ["--home", home, ...a], { env, encoding: "utf8", timeout: 120_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const j = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
const readJ = (f: string) => j(existsSync(f) ? readFileSync(f, "utf8") : "");
const setCfg = (patch: Record<string, unknown>) => writeFileSync(join(pcic, "config.json"), JSON.stringify({ ...KNOBS, ...patch }));

// ---- spend ---------------------------------------------------------------------------------------
const PRICE = { input: 1e-6, w1h: 2e-6, w5m: 1.25e-6, read: 0.1e-6, out: 5e-6 }; // haiku-class list prices ($/token), an estimate
let spendAt = 0, spendVal = 0;
function spend(force = false): number {
  if (!tmp) return spendVal;
  if (!force && Date.now() - spendAt < 15_000) return spendVal;
  spendAt = Date.now(); const key = basename(tmp).replace(/[^A-Za-z0-9]/g, "-"); let total = 0; const seen = new Set<string>();
  const root = join(claude, "projects");
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    if (!d.includes(key)) continue;
    for (const f of readdirSync(join(root, d))) {
      if (!f.endsWith(".jsonl")) continue;
      for (const l of readFileSync(join(root, d, f), "utf8").split("\n")) {
        if (!l.startsWith("{")) continue; const e = j(l); const u = e?.message?.usage; if (e?.type !== "assistant" || !u) continue;
        const k = `${e.message.id}:${e.requestId}`; if (seen.has(k)) continue; seen.add(k);
        const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0, w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0, w = u.cache_creation_input_tokens ?? 0;
        total += (u.input_tokens ?? 0) * PRICE.input + (u.cache_read_input_tokens ?? 0) * PRICE.read + (w1 || w5 ? w1 * PRICE.w1h + w5 * PRICE.w5m : w * PRICE.w1h) + (u.output_tokens ?? 0) * PRICE.out;
      }
    }
  }
  return (spendVal = total);
}
const logLine = (s: string) => { try { appendFileSync(join(LOG, "e2e-run.log"), `${new Date().toISOString()} ${s}\n`); } catch {} };
const budget = () => { const s = spend(); if (s > CAP) throw new Error(`budget cap passed: $${s.toFixed(3)} > $${CAP}`); };

// ---- helpers -------------------------------------------------------------------------------------
async function waitFor<T>(label: string, f: () => T | Promise<T>, ms: number, step = 2000): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await f(); if (v) return v as NonNullable<T>;
    budget();
    if (Date.now() - t0 > ms) throw new Error(`timeout (${Math.round(ms / 1000)}s) waiting for ${label}`);
    await sleep(step);
  }
}
const hist = (id?: string): any[] => (existsSync(join(pcic, "history.jsonl")) ? readFileSync(join(pcic, "history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => j(l)).filter((e) => e && (!id || e.agent === id)) : []);
const evs = (id: string) => hist(id).map((e) => e.event);
const sess = (id: string) => readJ(join(pcic, "sessions", `${id}.json`));
async function timeline(id: string): Promise<{ type: string; text: string }[]> { const r = await pas("agent", "logs", id, "--json"); return (j(r.out)?.items ?? []).map((i: any) => ({ type: i.type, text: String(i.text ?? "") })); }
async function inspect(id: string): Promise<any> { return j((await pas("agent", "inspect", id, "--json")).out) ?? {}; }
const status = async (id: string) => (await inspect(id)).Status as string;
const idle = (id: string, ms = 180_000) => waitFor(`agent ${id.slice(0, 7)} idle`, async () => (await status(id)) === "idle", ms);
function transcript(id: string): any[] { const p = sess(id)?.transcriptPath; return p && existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => j(l)).filter(Boolean) : []; }
const asstCount = (id: string) => transcript(id).filter((e) => e.type === "assistant" && !e.isSidechain && e.message?.model !== "<synthetic>").length;

function mkBig() {
  const words = "alpha beta gamma delta parse token lexer node tree rule scope yield frame stack index slice merge split fold chain probe trace graph edge path leaf root span cache block entry value key".split(" ");
  let x = 12345; const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  const lines: string[] = [];
  for (let i = 0; i < 520; i++) { const w: string[] = []; for (let k = 0; k < 24; k++) w.push(words[rnd() % words.length] + (rnd() % 7 === 0 ? String(rnd() % 997) : "")); lines.push(`parsekit-${i}: ${w.join(" ")}`); }
  return lines.join("\n") + "\n";
}
const BUILD = "Read the file big.md in full with the Read tool (page with offset and limit if needed so that you see all of it), then reply with exactly: ready";
interface Opts { name: string; mode?: string; prompt?: string; awt?: boolean; labels?: string[]; envs?: string[]; provider?: string; decide?: boolean }
const awtEnv = (dir: string): NodeJS.ProcessEnv => ({ ...env, AWT_DIR: dir, AWT_ROOT: join(tmp, "awt-root") });
async function mkAwt(name: string, decide = true): Promise<string> {
  const dir = join(tmp, "awt", name); mkdirSync(dir, { recursive: true });
  const r = await sh("awt", ["--dir", dir, "init", "--goal", "parsekit e2e", "--done", "tests pass"], { env: awtEnv(dir), cwd: dir }); if (r.code) throw new Error(`awt init: ${r.err}${r.out}`);
  if (decide) { const d = await sh("awt", ["decide", "use ZQX-DECISION-9", "--why", "test"], { env: awtEnv(dir), cwd: dir }); if (d.code) throw new Error(`awt decide: ${d.err}${d.out}`); }
  return dir;
}
/** Creates an agent and returns its id as soon as it exists (the first prompt keeps running). */
async function create(o: Opts): Promise<string> {
  const args = ["run", "--provider", o.provider ?? "claude/haiku", "--mode", o.mode ?? "bypassPermissions", "--title", o.name, "--cwd", proj, "--no-wait", "--json"];
  if (o.awt) args.push("--env", `AWT_DIR=${await mkAwt(o.name, o.decide ?? true)}`);
  for (const l of o.labels ?? []) args.push("--label", l);
  for (const e of o.envs ?? []) args.push("--env", e);
  args.push(o.prompt ?? "say ok");
  const r = await pas(...args); const id = j(r.out)?.agentId; if (!id) throw new Error(`create ${o.name}: ${r.err}${r.out}`); return id;
}
/** An agent whose context is built and idle; resolves with the time its last turn ended. */
async function built(o: Opts, min = 30000): Promise<{ id: string; endAt: number }> {
  const id = await create({ ...o, prompt: o.prompt ?? BUILD });
  await idle(id);
  if (o.labels?.includes("pcic=off")) return { id, endAt: Date.now() }; // opted out: the hooks write no session record (R3)
  const s = await waitFor("session record", () => sess(id), 30_000);
  assert.ok(s.contextTokens >= min, `${o.name}: context ${s.contextTokens} < ${min}`);
  return { id, endAt: s.lastAssistantAt };
}
const boundaryOf = (id: string) => { const t = transcript(id); const i = t.map((e) => e.subtype).lastIndexOf("compact_boundary"); return i < 0 ? null : { i, e: t[i], t }; };
const textOf = (e: any) => JSON.stringify(e);
const order = (got: string[], want: string[]) => { let k = 0; for (const g of got) if (g === want[k]) k++; return k === want.length; };
/** The full R14..R19 evidence shared by E3, E13 and E14. */
async function expectFullJob(id: string, mode: "plugin" | "cli", awtDir: string, t0: number) {
  await waitFor("compacted in history", () => evs(id).includes("compacted") || evs(id).includes("compact_failed") || evs(id).includes("checkpoint_failed"), 330_000);
  const ev = evs(id); assert.ok(order(ev, ["scheduled", "checkpoint_ok", "precompact", "compacted"]), `history order: ${ev.join(",")}`);
  assert.ok(!ev.includes("guard_block"), "guard blocked pcic's own send (V2)");
  const comp = hist(id).find((e) => e.event === "compacted"); assert.equal(comp.mode, mode);
  const tl = await timeline(id);
  const ci = tl.findIndex((x) => x.type === "user_message" && x.text.startsWith("[pcic checkpoint]")); assert.ok(ci >= 0, "no checkpoint user_message");
  assert.equal(tl[ci].text, CHECKPOINT_TEXT, "checkpoint text differs from R14");
  assert.ok(tl.slice(ci + 1).some((x) => x.type === "assistant_message" && /checkpoint saved/.test(x.text)), "no `checkpoint saved` reply");
  const ki = tl.findIndex((x, i) => i > ci && x.type === "user_message" && x.text === "/compact"); assert.ok(ki > ci, "no plain /compact after the checkpoint");
  const b = boundaryOf(id); assert.ok(b, "no compact_boundary in the transcript"); // V7
  assert.equal(b!.e.compactMetadata?.trigger, "manual"); const pre = b!.e.compactMetadata?.preTokens; assert.ok(pre >= 30000, `preTokens ${pre}`);
  const post = b!.e.compactMetadata?.postTokens; if (typeof post === "number") assert.ok(post <= 0.3 * pre, `post ${post} > 30% of pre ${pre}`);
  const rest = b!.t.slice(b!.i + 1).map(textOf).join("\n");
  assert.ok(rest.includes("ZQX-PRECOMPACT-7"), "summary lacks the precompact marker");
  assert.ok(rest.includes("awt record for this task") && rest.includes("ZQX-DECISION-9"), "no awt brief after the boundary");
  assert.equal(b!.t.slice(b!.i + 1).filter((e) => e.type === "assistant" && !e.isSidechain && e.message?.model !== "<synthetic>").length, 0, "an assistant turn ran after the compaction");
  const a = await sh("awt", ["list", "--since", new Date(t0).toISOString(), "--json"], { env: awtEnv(awtDir), cwd: awtDir });
  assert.ok(/state/i.test(a.out), `awt shows no state row after the case start: ${a.out.slice(0, 200)}`);
  return { pre, post };
}

// ---- phases --------------------------------------------------------------------------------------
const results = new Map<string, { ok: boolean; msg: string; usd: number }>();
const ONLY = (process.env.PCIC_E2E_ONLY ?? "").split(",").filter(Boolean); // re-run only these cases
const wanted = (...ids: string[]) => !ONLY.length || ids.some((i) => ONLY.includes(i));
async function phase(cases: Record<string, () => Promise<unknown>>) {
  await Promise.all(Object.entries(cases).filter(([id]) => wanted(id)).map(async ([id, f]) => {
    const s0 = spend(true);
    try { const ev = await f(); results.set(id, { ok: true, msg: ev ? JSON.stringify(ev) : "", usd: 0 }); } catch (e) { results.set(id, { ok: false, msg: String((e as Error).message ?? e).slice(0, 600), usd: 0 }); }
    const r = results.get(id)!; r.usd = spend(true) - s0; // concurrent cases share the figure: it is the phase delta at the time the case ended
    logLine(`${id} ${r.ok ? "PASS" : "FAIL"} cost~$${r.usd.toFixed(3)} total~$${spend().toFixed(3)} ${r.msg}`);
  }));
}
const verdictOf = (id: string) => (ON && PAID ? (t: any) => { const r = results.get(id); if (!r && ONLY.length) return t.skip("not selected"); assert.ok(r, `${id} did not run`); assert.ok(r!.ok, r!.msg); } : undefined);

let A0 = "";
const ctrl: { phase1?: Promise<void>; e3?: { id: string; awtDir: string } } = {};

before(async () => {
  if (!ON) return;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pcice-")));
  home = join(tmp, "paseo"); pcic = join(tmp, "pcic"); proj = join(tmp, "proj", "parsekit"); claude = process.env.PCIC_E2E_CLAUDE_CONFIG_DIR || join(tmp, "claude");
  mkdirSync(home); mkdirSync(claude, { recursive: true }); mkdirSync(pcic); mkdirSync(proj, { recursive: true });
  env = { ...process.env, PCIC_HOME: pcic, CLAUDE_CONFIG_DIR: claude };
  for (const k of Object.keys(env)) if (k.startsWith("PASEO_") || k.startsWith("AWT_")) delete env[k];
  setCfg({});
  execFileSync("git", ["init", "-q"], { cwd: proj }); writeFileSync(join(proj, "big.md"), mkBig());
  const port = await free();
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { injectIntoAgents: false } }, features: { dictation: { enabled: false } }, agents: { providers: { fake: { extends: "acp", label: "Fake", command: ["python3", FAKE_ACP] } } } }));
  paseoSync("daemon", "start", "--timeout", "90");
  paseoSync("plugin", "install", REPO);
  paseoSync("daemon", "restart");
});
function cleanup() {
  if (!tmp) return;
  try { const ids = (j(execFileSync("paseo", ["--home", home, "agent", "ls", "-a", "--json"], { env, encoding: "utf8", timeout: 60_000 })) ?? []).map((a: any) => a.id); for (const id of ids) { try { execFileSync("paseo", ["--home", home, "agent", "delete", id], { env, timeout: 30_000 }); } catch {} } } catch {}
  try { paseoSync("daemon", "stop"); } catch { try { const f = join(home, "paseo.pid"); if (existsSync(f)) process.kill(Number(/"?pid"?\D*(\d+)/.exec(readFileSync(f, "utf8"))?.[1])); } catch {} }
  const root = join(claude, "projects"), key = basename(tmp).replace(/[^A-Za-z0-9]/g, "-");
  try { for (const d of readdirSync(root)) if (d.includes(key)) rmSync(join(root, d), { recursive: true, force: true }); } catch {}
  if (process.env.PCIC_E2E_CLAUDE_CONFIG_DIR) { try { execFileSync("node", [join(REPO, "bin", "pcic.mjs"), "install", "--uninstall"], { env, timeout: 30_000 }); const f = join(claude, "settings.json"), st = readJ(f); if (st?.hooks?.SessionStart) { st.hooks.SessionStart = st.hooks.SessionStart.filter((e: any) => !JSON.stringify(e).includes("# awt:context")); if (!st.hooks.SessionStart.length) delete st.hooks.SessionStart; writeFileSync(f, JSON.stringify(st)); } } catch {} }
  logLine(`cleanup done, final spend ~$${spend(true).toFixed(3)}`);
  rmSync(tmp, { recursive: true, force: true }); tmp = "";
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { cleanup(); process.exit(1); });
after(cleanup);

// ---- E1 (V4) and E2 (V1) --------------------------------------------------------------------------
test("E1 install, doctor, and the Stop hook fires with PASEO_AGENT_ID (V4)", { skip: !ON }, async () => {
  execFileSync("node", [join(REPO, "bin", "pcic.mjs"), "install"], { env, encoding: "utf8" });
  const st = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
  st.hooks.SessionStart = [...(st.hooks.SessionStart ?? []).filter((e: any) => !JSON.stringify(e).includes("# awt:context")), { matcher: "compact", hooks: [{ type: "command", command: "awt resume --hook --framed # awt:context" }] }]; // stand-in for `awt init --hooks claude`
  writeFileSync(join(claude, "settings.json"), JSON.stringify(st));
  execFileSync("node", [join(REPO, "bin", "pcic.mjs"), "doctor"], { env, encoding: "utf8" }); // exits 1 on any problem
  if (!PAID) return;
  // The plugin gets its Paseo client from the first hook event, so this first agent also starts it (SPEC: Components).
  A0 = await create({ name: "a0" }); await idle(A0);
  const s = await waitFor("session record of a0", () => sess(A0), 20_000);
  for (const k of ["sessionId", "transcriptPath", "cwd", "awtDir", "lastAssistantAt", "lastAssistantUuid", "contextTokens", "model", "ttlObserved", "writtenAt"]) assert.ok(k in s, `record lacks ${k}`);
  assert.ok(existsSync(s.transcriptPath)); assert.ok(s.contextTokens > 0); logLine(`E1 PASS base context ${s.contextTokens}`);
});
test("E2 the self-test records a plugin verdict, archives its probe, the probe send is plain (V1)", { skip: !(ON && PAID) }, async () => {
  const v = await waitFor("verdict.json", () => readJ(join(pcic, "verdict.json")), 150_000);
  assert.equal(v.mode, "plugin");
  const probes = (j((await pas("agent", "ls", "-a", "--json")).out) ?? []).filter((a: any) => a.name === "pcic probe"); assert.ok(probes.length >= 1, "no probe agent");
  for (const p of probes) { assert.equal((await inspect(p.id)).Archived, true, "probe not archived"); const tl = await timeline(p.id); assert.equal(tl[0]?.text, "/compact"); assert.ok(!tl.some((x) => x.text.includes("<paseo-system")), "probe send is enveloped"); assert.equal((await inspect(p.id)).LastUsage?.CostUsd ?? 0, 0); }
  logLine(`E2 PASS verdict=${JSON.stringify(v)}`);
});

// ---- phase 1: E3/E14 E4 E5 E6 E7 E11 E15 E16 (concurrent) -----------------------------------------
test("phase 1 runs E3 E4 E5 E6 E7 E11 E15 E16 E18 E19 together", { skip: !(ON && PAID && wanted("E3", "E4", "E5", "E6", "E7", "E11", "E15", "E16", "E18", "E19")), timeout: 1_500_000 }, async () => {
  setCfg({ sendMode: "plugin" }); // forced plugin: E14 is E3's run
  await phase({
    async E3() {
      const t0 = Date.now(); const { id } = await built({ name: "e3", awt: true }); const awtDir = join(tmp, "awt", "e3"); ctrl.e3 = { id, awtDir };
      return expectFullJob(id, "plugin", awtDir, t0);
    },
    async E4() {
      const { id } = await built({ name: "e4" }); await waitFor("compacted", () => evs(id).includes("compacted") || evs(id).includes("compact_failed"), 330_000);
      assert.ok(evs(id).includes("compacted"), evs(id).join(","));
      assert.equal(hist(id).find((e) => e.event === "precompact")?.reason, "generic");
      const tl = await timeline(id); assert.ok(!tl.some((x) => x.text.startsWith("[pcic checkpoint]")), "a checkpoint turn ran"); assert.ok(tl.some((x) => x.type === "user_message" && x.text === "/compact"));
      const b = boundaryOf(id)!; assert.ok(b.t.slice(b.i + 1).map(textOf).join("\n").includes("ZQX-PRECOMPACT-7"), "summary lacks the marker");
    },
    async E5() {
      const id = await create({ name: "e5" }); await idle(id); await waitFor("skipped small", () => hist(id).find((e) => e.event === "skipped"), 220_000);
      assert.equal(hist(id).find((e) => e.event === "skipped").reason, "small"); assert.equal((await timeline(id)).length, 2, "something was sent");
    },
    async E6() {
      const { id } = await built({ name: "e6", awt: true });
      await waitFor("checkpoint turn", async () => (await timeline(id)).some((x) => x.text.startsWith("[pcic checkpoint]")), 300_000, 1000);
      const r = await pas("agent", "send", id, "ZQX-PROMPT reply with hi", "--no-wait"); assert.equal(r.code, 0, r.err);
      await waitFor("aborted_user", () => evs(id).includes("aborted") || evs(id).includes("compacted") || evs(id).includes("checkpoint_failed"), 240_000);
      await idle(id, 240_000); await sleep(25_000);
      const ev = hist(id); assert.ok(ev.some((e) => e.event === "aborted" && e.reason === "user"), JSON.stringify(ev.map((e) => [e.event, e.reason])));
      assert.ok(!(await timeline(id)).some((x) => x.type === "user_message" && x.text === "/compact"), "/compact was sent"); assert.equal(boundaryOf(id), null);
    },
    async E7() {
      const { id } = await built({ name: "e7" }); await sleep(80_000);
      const r = await pas("agent", "send", id, "Run `sleep 75` in Bash, then reply with exactly: done", "--no-wait"); assert.equal(r.code, 0, r.err);
      await waitFor("second turn started", async () => (await status(id)) === "running", 30_000, 1000); await idle(id, 240_000);
      const end = (await waitFor("record", () => { const s = sess(id); return s && s.lastAssistantAt > Date.now() - 200_000 ? s : null; }, 20_000)).lastAssistantAt;
      await waitFor("compacted", () => evs(id).includes("compacted") || evs(id).includes("compact_failed"), 330_000); assert.ok(evs(id).includes("compacted"), evs(id).join(","));
      const sched = hist(id).find((e) => e.event === "scheduled"); assert.ok(Date.parse(sched.at) >= end + 100_000, `scheduled ${Date.parse(sched.at) - end} ms after the turn end`);
      assert.ok(!hist(id).some((e) => e.event === "skipped" && e.reason === "late"));
    },
    async E11() {
      const { id } = await built({ name: "e11", labels: ["pcic=off"], prompt: `${BUILD}. Then run \`echo OFF=$PCIC_OFF\` in Bash and include the printed line in your reply.` });
      assert.ok((await timeline(id)).some((x) => x.type === "assistant_message" && x.text.includes("OFF=1")), "PCIC_OFF=1 not in the agent env");
      const { endAt } = { endAt: Date.now() }; await sleep(Math.max(0, endAt + 262_000 - Date.now()));
      const r = await pas("agent", "send", id, "ZQX-PROMPT reply with hi"); assert.equal(r.code, 0, r.err);
      const tl = await timeline(id); assert.ok(!tl.some((x) => x.text.includes("pcic: this agent")), "the guard blocked an opted-out agent"); assert.ok(tl.filter((x) => x.type === "assistant_message").length >= 2);
      assert.deepEqual(evs(id), [], "pcic recorded events for an opted-out agent");
    },
    async E15() {
      const r = await pas("run", "--provider", "fake", "--title", "e15", "--cwd", proj, "--no-wait", "--json", "hello"); const id = j(r.out)?.agentId; if (!id) throw new Error(`fake provider unavailable: ${r.err}${r.out}`.slice(0, 300));
      await idle(id, 60_000); await sleep(150_000);
      assert.deepEqual(evs(id), []); assert.equal(sess(id), null); assert.ok(!(await timeline(id)).some((x) => x.text.startsWith("/compact") || x.text.startsWith("[pcic")));
    },
    async E16() {
      const parent = await create({ name: "e16-parent" }); await idle(parent);
      const { id } = await built({ name: "e16-child", labels: [`paseo.parent-agent-id=${parent}`] });
      await waitFor("skipped subagent", () => hist(id).find((e) => e.event === "skipped"), 240_000); assert.equal(hist(id).find((e) => e.event === "skipped").reason, "subagent");
      assert.ok(!evs(id).includes("scheduled"));
    },
    // V6: backgroundWork is visible on the handle (R10). Written, not yet run live.
    async E18() {
      const { id } = await built({ name: "e18", prompt: `${BUILD}. Then start \`sleep 900\` with the Bash tool and run_in_background true, and reply with exactly: started` });
      await waitFor("skipped background_work", () => hist(id).find((e) => e.event === "skipped" || e.event === "compacted" || e.event === "aborted"), 300_000);
      const ev = hist(id); assert.ok(ev.some((e) => e.event === "skipped" && e.reason === "background_work"), JSON.stringify(ev.map((e) => [e.event, e.reason])));
      assert.ok(!(await timeline(id)).some((x) => x.text === "/compact" || x.text.startsWith("[pcic checkpoint]")), "pcic sent into an agent with background work"); assert.equal(boundaryOf(id), null);
    },
    // V6, C15: a pending permission request keeps the agent not idle; pcic never answers it.
    async E19() {
      const id = await create({ name: "e19", mode: "default", prompt: `${BUILD}. Then run \`echo ZQX-PERM-1\` with the Bash tool and reply with exactly: ok` });
      await waitFor("permission pending", async () => (j((await pas("permit", "ls", "--json")).out) ?? []).length > 0 || (await status(id)) === "idle", 240_000, 2000);
      await sleep(200_000);
      const tl = await timeline(id); assert.ok(!tl.some((x) => x.text === "/compact" || x.text.startsWith("[pcic checkpoint]")), "pcic sent while a permission was pending");
      assert.notEqual(await status(id), "idle", "the permission was answered by someone"); assert.ok(!evs(id).some((e) => e === "compacted" || e === "checkpoint_ok"));
    },
  });
});
// ---- phase 2: guard (E8 E9 E10) under a stopped daemon ---------------------------------------------
test("phase 2 runs E8 E9 E10 after a stopped daemon", { skip: !(ON && PAID && wanted("E8", "E9", "E10")), timeout: 1_200_000 }, async () => {
  setCfg({ sendMode: "plugin" });
  const [g1, g2] = await Promise.all([built({ name: "g1" }), built({ name: "g2" })]);
  const pid = Number(/workerPid:\s*(\d+)/.exec(paseoSync("daemon", "status"))?.[1]); assert.ok(pid > 1, "no worker pid");
  // The whole daemon tree (worker, plugin subprocess, ...) freezes, as a sleeping Mac would; the agents' claude processes stay alive.
  const tree = (p: number): number[] => [p, ...execFileSync("pgrep", ["-P", String(p)], { encoding: "utf8" }).split("\n").filter(Boolean).flatMap((c) => { try { return tree(Number(c)); } catch { return [Number(c)]; } })];
  let pids: number[] = []; try { pids = tree(pid); } catch { pids = [pid]; }
  const claudes = new Set(pids.filter((p) => { try { return /claude/.test(execFileSync("ps", ["-o", "command=", "-p", String(p)], { encoding: "utf8" })); } catch { return false; } }));
  pids = pids.filter((p) => !claudes.has(p));
  for (const p of pids) process.kill(p, "SIGSTOP"); const t0 = Date.now();
  try { await sleep(262_000); } finally { for (const p of pids) { try { process.kill(p, "SIGCONT"); } catch {} } }
  await phase({
    async E8() {
      const { id } = g1; await waitFor("skipped", () => hist(id).find((e) => e.event === "skipped"), 120_000);
      const why = hist(id).find((e) => e.event === "skipped").reason; logLine(`E8 skip reason after the freeze: ${why}`); assert.ok(["late", "not_idle"].includes(why), why); assert.ok(!evs(id).includes("checkpoint_ok") && !evs(id).includes("compacted"));
      const s = sess(id); const before = spend(true); const n0 = asstCount(id);
      await pas("agent", "send", id, "ZQX-PROMPT continue");
      const tl = await timeline(id); const blocked = tl.find((x) => x.text.includes("pcic: this agent's prompt cache has likely expired")); assert.ok(blocked, JSON.stringify(tl.slice(-3)));
      const m = /Context ~(\d+)K/.exec(blocked!.text); assert.ok(m && Math.abs(Number(m[1]) * 1000 - s.contextTokens) <= 0.1 * s.contextTokens + 500, `context figure ${m?.[1]}K vs ${s.contextTokens}`);
      assert.equal(asstCount(id), n0, "the blocked turn made a request"); assert.ok(spend(true) - before < 0.002, "blocked turn cost money");
      assert.ok(existsSync(join(pcic, "guard", `${s.sessionId}.json`)));
      await pas("agent", "send", id, "ZQX-PROMPT continue"); await idle(id);
      assert.ok(asstCount(id) > n0, "the resend did not run"); assert.ok(order(evs(id), ["guard_block", "guard_pass_marker"]), evs(id).join(","));
    },
    async E9() {
      const e3 = ctrl.e3; assert.ok(e3, "E3 did not run (needs the same run)"); assert.ok(results.get("E3")?.ok, "E3 failed, no compacted agent");
      const n0 = asstCount(e3!.id); await pas("agent", "send", e3!.id, "ZQX-PROMPT reply with hi");
      assert.ok(!(await timeline(e3!.id)).some((x) => x.text.includes("pcic: this agent")), "blocked after a compaction"); assert.ok(asstCount(e3!.id) > n0);
    },
    async E10() {
      const { id } = g2; const n0 = asstCount(id);
      await pas("agent", "send", id, "/context"); assert.ok(!(await timeline(id)).some((x) => x.text.includes("pcic: this agent")), "/context blocked");
      const fake = { ...env, PASEO_AGENT_ID: "agt_fake_sender", PASEO_AGENT_CWD: proj, PASEO_WORKSPACE_ID: "wks_fake" };
      await sh("paseo", ["--home", home, "agent", "send", id, "<paseo-system>from agt_fake</paseo-system> ZQX-PROMPT enveloped hello"], { env: fake });
      const tl = await timeline(id); assert.ok(!tl.some((x) => x.text.includes("pcic: this agent")), "enveloped prompt blocked"); assert.ok(!evs(id).includes("guard_block"));
      logLine(`E10 enveloped user_message seen: ${tl.some((x) => x.text.includes("<paseo-system"))}; n0=${n0}`);
    },
  });
  logLine(`phase 2 stopped daemon ${Math.round((Date.now() - t0) / 1000)}s`);
});
// ---- phase 3: E13 (cli) then E12/E17 (restart) -----------------------------------------------------
test("phase 3 runs E13", { skip: !(ON && PAID && wanted("E13")), timeout: 900_000 }, async () => {
  const wrap = join(tmp, "paseo-wrap.sh"); writeFileSync(wrap, `#!/bin/sh\nenv | grep -E '^(PASEO_|PCIC_)' | sort >> ${join(tmp, "wrap.env")}\nexec paseo "$@"\n`); chmodSync(wrap, 0o755);
  setCfg({ sendMode: "cli", paseoBin: wrap });
  await phase({
    async E13() {
      const t0 = Date.now(); const { id } = await built({ name: "e13", awt: true }); const r = await expectFullJob(id, "cli", join(tmp, "awt", "e13"), t0);
      const w = readFileSync(join(tmp, "wrap.env"), "utf8"); for (const k of ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID"]) assert.ok(!w.includes(`${k}=`), `cli child env has ${k}`);
      assert.ok(w.includes(`PASEO_HOME=${home}`), "cli child lacks the test PASEO_HOME (V9)"); return r;
    },
  });
});
test("phase 4 runs E12 and E17 across a daemon restart", { skip: !(ON && PAID && wanted("E12", "E17")), timeout: 900_000 }, async () => {
  setCfg({ sendMode: "plugin" });
  await phase({
    async E12() {
      const { id, endAt } = await built({ name: "e12" }); const n0 = asstCount(id); const ctx = sess(id).contextTokens;
      await sleep(Math.max(0, endAt + 55_000 - Date.now()));
      paseoSync("daemon", "restart"); const st = await waitFor("status after restart", async () => (await status(id)) || null, 60_000);
      await pas("agent", "send", A0, "say ok"); // the plugin has no client until a hook event (SPEC: Components)
      assert.equal(asstCount(id), n0, "a request ran between the restart and the job");
      await sleep(Math.max(0, endAt + 120_000 + 45_000 - Date.now()));
      const ev = hist(id); logLine(`E12 status after restart=${st}; history=${JSON.stringify(ev.map((e) => [e.event, e.reason]))}`);
      assert.ok(ev.some((e) => e.event === "compacted"), `no compaction after the restart (status ${st}): ${JSON.stringify(ev.map((e) => [e.event, e.reason]))}`);
      return { st, ctx };
    },
    async E17() {
      const e3 = ctrl.e3; assert.ok(e3 && results.get("E3")?.ok, "E3 did not complete"); const n0 = hist(e3!.id).length, tl0 = (await timeline(e3!.id)).length;
      await sleep(200_000);
      assert.equal(hist(e3!.id).filter((e) => e.event === "scheduled").length, 1, "a second job for the old anchor"); assert.equal(hist(e3!.id).length >= n0, true); assert.ok((await timeline(e3!.id)).length - tl0 <= 2, "pcic sent something");
    },
  });
});
// V5 probe on its own: send to a closed agent and look at the cache numbers of that request.
test("V5 a send to a closed agent after a restart reads the cache instead of rewriting it", { skip: !(ON && PAID && wanted("E12")), timeout: 300_000 }, async () => {
  const r = results.get("E12"); const id = (j((await pas("agent", "ls", "-a", "--json")).out) ?? []).find((a: any) => a.name === "e12")?.id; assert.ok(id && r, "no e12 agent");
  const ctx = sess(id).contextTokens; const n0 = asstCount(id); await pas("agent", "send", id, "ZQX-PROMPT say ok");
  const last = transcript(id).filter((e) => e.type === "assistant" && e.message?.usage).pop().message.usage;
  logLine(`V5 request usage after restart: read=${last.cache_read_input_tokens} write=${last.cache_creation_input_tokens} ctx=${ctx} requests+${asstCount(id) - n0}`);
  assert.ok(last.cache_read_input_tokens >= 0.8 * ctx && last.cache_creation_input_tokens < 0.2 * ctx, `read ${last.cache_read_input_tokens} write ${last.cache_creation_input_tokens}`);
});

// ---- per-case reports ------------------------------------------------------------------------------
for (const id of ["E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12", "E13", "E15", "E16", "E17", "E18", "E19"]) test(`${id} (see E2E-RUBRIC.md)`, { skip: !(ON && PAID) }, verdictOf(id));
test("E14 plugin mode is E3's forced-plugin run", { skip: !(ON && PAID && wanted("E3")) }, () => { assert.ok(results.get("E3")?.ok, "E3 failed"); });
test("spend summary", { skip: !(ON && PAID) }, () => { logLine(`TOTAL est. spend $${spend(true).toFixed(3)} (cap $${CAP})`); assert.ok(spend() <= CAP); });

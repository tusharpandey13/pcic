// Tier T harness: temp dirs, transcript fixtures, the real hook as a subprocess, a fake clock and a fake Paseo.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPcic, type Pcic } from "../server/scheduler.js";
import type { Handle, PaseoLike, Snap } from "../server/send.js";

export const ROOT = resolve(import.meta.dirname, "..");
export const BIN = join(ROOT, "bin", "pcic.mjs");
export const T0 = Date.parse("2026-11-18T09:00:00Z");
export const MIN = 60_000;

export interface Tmp { dir: string; home: string; claude: string; env: Record<string, string>; cleanup(): void }
/** A temp HOME with its own PCIC_HOME and Claude config dir. Nothing outside it is touched. */
export function tmp(extra: Record<string, string> = {}): Tmp {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcic-")));
  const home = join(dir, "pcic-home"), claude = join(dir, "claude");
  mkdirSync(claude, { recursive: true });
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, PCIC_HOME: home, CLAUDE_CONFIG_DIR: claude, PASEO_AGENT_ID: "agt_0001", ...extra };
  return { dir, home, claude, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export const writeConfig = (t: Tmp, cfg: unknown) => { mkdirSync(t.home, { recursive: true }); writeFileSync(join(t.home, "config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg)); };
export const readJsonFile = (p: string) => JSON.parse(readFileSync(p, "utf8"));
export const historyOf = (t: Tmp): any[] => { try { return readFileSync(join(t.home, "history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const listing = (dir: string): string[] => { const out: string[] = []; const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); f.isDirectory() ? walk(p) : out.push(p); } }; if (existsSync(dir)) walk(dir); return out.sort(); };

// ---- transcripts ---------------------------------------------------------------------------------
export interface AsstOpts { uuid?: string; at: number; tokens?: number; model?: string; ttl?: 3600 | 300 | null; sidechain?: boolean; noUsage?: boolean }
export const asst = (o: AsstOpts) => JSON.stringify({
  type: "assistant", uuid: o.uuid ?? `u-${o.at}`, timestamp: new Date(o.at).toISOString(), isSidechain: !!o.sidechain,
  message: { model: o.model ?? "claude-opus-4-8", ...(o.noUsage ? {} : { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: (o.tokens ?? 150000) - 10, output_tokens: 50,
    cache_creation: o.ttl === null ? { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: o.ttl === 300 ? 0 : (o.tokens ?? 150000) - 10, ephemeral_5m_input_tokens: o.ttl === 300 ? (o.tokens ?? 150000) - 10 : 0 } } }) },
});
export const boundary = (at: number, pre = 150000, post = 8000) => JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(at).toISOString(), compactMetadata: { trigger: "manual", preTokens: pre, postTokens: post } });
export const user = (at: number, text = "ZQX-PROMPT hi") => JSON.stringify({ type: "user", uuid: `uu-${at}`, timestamp: new Date(at).toISOString(), message: { role: "user", content: text } });
export function transcript(t: Tmp, lines: string[], name = "s1.jsonl"): string {
  const p = join(t.dir, name); writeFileSync(p, lines.join("\n") + "\n"); return p;
}

// ---- hook subprocess -----------------------------------------------------------------------------
export interface HookRun { code: number | null; stdout: string; stderr: string; ms: number }
export function hook(event: string, input: unknown, env: Record<string, string>, opts: { nodeOptions?: string } = {}): Promise<HookRun> {
  return new Promise((ok) => {
    const t0 = Date.now();
    const e = { ...env, ...(opts.nodeOptions ? { NODE_OPTIONS: opts.nodeOptions } : {}) };
    const c = spawn(process.execPath, [BIN, "hook", event], { env: e, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => ok({ code, stdout, stderr, ms: Date.now() - t0 }));
    c.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
export function cli(args: string[], env: Record<string, string>): Promise<HookRun> {
  return new Promise((ok) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => ok({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}
/** A fake executable on a bin dir that is prepended to PATH. */
export function fakeBin(t: Tmp, name: string, script: string): string {
  const d = join(t.dir, "fakebin"); mkdirSync(d, { recursive: true });
  const p = join(d, name); writeFileSync(p, `#!/bin/sh\n${script}\n`); chmodSync(p, 0o755);
  return d;
}

// ---- fake clock ------------------------------------------------------------------------------------
export class Clock {
  t = T0; private waiters: { at: number; fire: () => void }[] = [];
  now = () => this.t;
  timer = (ms: number) => {
    let fire!: () => void; const promise = new Promise<void>((r) => (fire = r));
    const w = { at: this.t + ms, fire }; this.waiters.push(w);
    return { promise, cancel: () => { this.waiters = this.waiters.filter((x) => x !== w); } };
  };
  /** Moves time and fires the timers that come due. */
  async advance(ms: number) { this.t += ms; const due = this.waiters.filter((w) => w.at <= this.t); this.waiters = this.waiters.filter((w) => w.at > this.t); due.forEach((w) => w.fire()); await settle(); }
  set(t: number) { this.t = t; }
}
export const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ---- fake Paseo ------------------------------------------------------------------------------------
export interface FakeAgent { snap: Snap & { id: string }; page: unknown[]; }
export class FakePaseo implements PaseoLike {
  agents_ = new Map<string, FakeAgent>();
  sent: { id: string; text: string; opts?: Record<string, unknown> }[] = [];
  created: Record<string, unknown>[] = [];
  archived: string[] = [];
  perm: string[] = [];
  /** What run()/waitForFinish() return: "idle" resolves, "never" hangs, others are returned as the status. */
  runStatus = "idle"; failCode = "error"; sendThrows = false; refreshThrows = false; createThrows = false; archiveThrows = false; listThrows = false;
  /** Called for each send/run, after it is recorded. The harness turns it into turn hooks. */
  onSend: (id: string, text: string) => Promise<void> | void = () => {};
  onTurnEnd: (id: string, text: string, outcome: any) => Promise<void> | void = () => {};
  probeTimeline: unknown[] = [];
  /** While true, waiting turns block until release(). `active` counts turns in flight. */
  hold = false; active = 0; maxActive = 0; gates: (() => void)[] = []; sendTimes: number[] = []; onRefresh: (id: string) => void = () => {}; outcomeKind: "failed" | "canceled" = "failed";
  /** Real Paseo dispatches turn_started before it records the prompt: with lateEcho the user_message lands after turn.before. */
  lateEcho = false;
  release() { this.hold = false; this.gates.splice(0).forEach((g) => g()); }
  now: () => number = () => 0;
  constructor(private rig: () => Rig | null) {}
  add(id: string, over: Partial<Snap> = {}) {
    const snap = { id, provider: "claude", cwd: "/tmp/parsekit", status: "idle", labels: {}, archivedAt: null, pendingPermissions: [], lastUsage: { contextWindowUsedTokens: 150000 }, updatedAt: new Date(T0).toISOString(), ...over };
    this.agents_.set(id, { snap, page: [] }); return snap;
  }
  setPage(id: string, items: unknown[]) { (this.agents_.get(id) as FakeAgent).page = items; }
  say(id: string, type: string, text: string, extra: Record<string, unknown> = {}, turnId?: string) { (this.agents_.get(id) as FakeAgent).page.push({ item: { type, text, ...extra }, ...(turnId ? { turnId } : {}) }); }
  agents = {
    ref: (id: string): Handle => this.handle(id),
    list: async () => { if (this.listThrows) throw new Error("list"); return { entries: [...this.agents_.values()].map((a) => ({ agent: a.snap })) }; },
    create: async (o: Record<string, unknown>): Promise<Handle> => {
      if (this.createThrows) throw new Error("create");
      this.created.push(o); const id = `probe_${this.created.length}`;
      this.add(id, { labels: (o.labels as Record<string, string>) ?? {}, cwd: o.cwd as string });
      return this.handle(id);
    },
  };
  private handle(id: string): Handle {
    const a = () => this.agents_.get(id) as FakeAgent;
    const record = async (text: string, opts?: Record<string, unknown>) => {
      if (this.sendThrows) throw new Error("send refused");
      this.sent.push({ id, text, opts }); this.sendTimes.push(this.now()); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      const turnId = `own-${this.sent.length}`;
      if (!this.lateEcho) this.say(id, "user_message", text, {}, turnId);
      await this.onSend(id, text);
      if (this.lateEcho) this.say(id, "user_message", text, {}, turnId);
    };
    const waiting = async (text: string) => {
      if (this.runStatus === "never") return new Promise<never>(() => {});
      if (this.hold) await new Promise<void>((r) => this.gates.push(r));
      this.active--;
      const r = { status: this.runStatus, error: this.runStatus === "error" ? "boom" : null, code: this.failCode };
      if (this.runStatus !== "permission") await this.onTurnEnd(id, text, r); // a turn waiting for a permission has not ended
      return r;
    };
    let last = "", seen = false; // like a real ref(), current() is null until a refresh
    return {
      id,
      refresh: async () => { if (this.refreshThrows) throw new Error("refresh"); this.onRefresh(id); seen = true; return null; },
      current: () => (seen && a() ? a().snap : null),
      send: async (text, o) => { await record(text, o); last = text; },
      run: async (text, o) => { await record(text, o); return waiting(text); },
      waitForFinish: async () => waiting(last),
      archive: async () => { if (this.archiveThrows) throw new Error("archive"); this.archived.push(id); return { archivedAt: "x" }; },
      timeline: { refetch: async () => (id.startsWith("probe_") ? { entries: this.probeTimeline } : { entries: a().page }) },
    };
  }
}

// ---- the rig ---------------------------------------------------------------------------------------
export interface Rig { t: Tmp; clock: Clock; paseo: FakePaseo; pcic: Pcic; ctx: { paseo: PaseoLike }; logs: string[]; sweep(): Promise<void>; run(): Promise<void>; call(name: string, payload: unknown): Promise<any>; turn(id: string, o?: { text?: string; outcome?: any; record?: boolean | Record<string, unknown> }): Promise<void>; writeSession(id: string, over?: Record<string, unknown>): void; cleanup(): void }

export const agentPayload = (id: string, over: Record<string, unknown> = {}) => ({ id, workspaceId: "wks_1", parentAgentId: null, provider: "claude", cwd: "/tmp/parsekit", title: `Chat ${id}`, ...over });

export interface RigOpts { cfg?: Record<string, unknown>; env?: Record<string, string>; cliTimeoutMs?: number; autoTurn?: boolean; autoCompact?: boolean; version?: string; noVerdict?: boolean }
/** Config defaults for fast, offline tests: 1h TTL, idle 55 min, a small threshold, no stagger. */
export function rig(o: RigOpts = {}): Rig {
  const t = tmp(o.env);
  mkdirSync(t.home, { recursive: true });
  writeConfig(t, { staggerSeconds: 0, minContextTokens: 100000, ...o.cfg });
  if (!o.noVerdict) writeFileSync(join(t.home, "verdict.json"), JSON.stringify({ paseoVersion: o.version ?? "0.16.1", mode: "plugin", at: T0, tries: 0 })); // no probe in ordinary tests
  const clock = new Clock();
  const logs: string[] = [];
  let self: Rig | null = null;
  const paseo = new FakePaseo(() => self);
  const pcic = createPcic({ env: { ...t.env, PASEO_VERSION: o.version ?? "0.16.1" }, now: clock.now, timer: clock.timer, log: (m) => logs.push(m), cliTimeoutMs: o.cliTimeoutMs, version: async () => o.version ?? "0.16.1" });
  paseo.now = clock.now;
  const ctx = { paseo };
  const call = (name: string, payload: unknown) => (pcic.hooks as any)[name](payload, ctx);
  if (o.autoTurn !== false) {
    // Mirrors Paseo: a pcic send starts a turn (turn.before), and the turn ends when the caller waits (turn.after).
    paseo.onSend = async (id, text) => { if (id.startsWith("probe_")) return; await call("agent.turn.before", { agent: agentPayload(id), turnId: `own-${paseo.sent.length}` }); void text; };
    paseo.onTurnEnd = async (id, text, r) => {
      if (id.startsWith("probe_")) return;
      if (text === "/compact" && o.autoCompact !== false) { const rec = readJsonFile(join(t.home, "sessions", `${id}.json`)); writeFileSync(rec.transcriptPath, JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(clock.now()).toISOString(), compactMetadata: { trigger: "manual", preTokens: 150000, postTokens: 8000 } }) + "\n", { flag: "a" }); }
      await call("agent.turn.after", { agent: agentPayload(id), turnId: "own", outcome: paseo.outcomeKind === "canceled" ? { kind: "canceled", reason: "x" } : r.status === "idle" ? { kind: "completed" } : { kind: "failed", error: { message: "x", code: r.code } } });
    };
  }
  const writeSession = (id: string, over: Record<string, unknown> = {}) => {
    mkdirSync(join(t.home, "sessions"), { recursive: true });
    const tp = join(t.dir, `${id}.jsonl`); if (!existsSync(tp)) writeFileSync(tp, asst({ at: clock.now(), uuid: `u-${id}` }) + "\n");
    writeFileSync(join(t.home, "sessions", `${id}.json`), JSON.stringify({ sessionId: `sid-${id}`, transcriptPath: tp, cwd: "/tmp/parsekit", awtDir: join(t.dir, "awt"), lastAssistantAt: clock.now(), lastAssistantUuid: `u-${id}`, contextTokens: 150000, model: "claude-opus-4-8", ttlObserved: 3600, writtenAt: clock.now(), ...over }));
  };
  const r: Rig = {
    t, clock, paseo, pcic, ctx, logs, call, writeSession,
    sweep: async () => { await pcic.sweep(); await settle(); },
    run: async () => { await settle(); await pcic.idle(); await settle(); },
    /** A foreign (owner) turn on an agent: turn.before, then turn.after, with a fresh session record. */
    turn: async (id, x = {}) => {
      paseo.say(id, "user_message", x.text ?? "ZQX-PROMPT work", {}, "t-foreign");
      await call("agent.turn.before", { agent: agentPayload(id), turnId: "t-foreign" });
      if (x.record !== false) r.writeSession(id, typeof x.record === "object" ? x.record : {});
      await call("agent.turn.after", { agent: agentPayload(id), turnId: "t-foreign", outcome: x.outcome ?? { kind: "completed" } });
    },
    cleanup: () => { pcic.cleanup(); t.cleanup(); },
  };
  self = r;
  mkdirSync(join(t.dir, "awt"), { recursive: true });
  return r;
}
/** An idle agent whose last turn just ended: registered in the fake daemon and tracked by the plugin. */
export async function idleAgent(r: Rig, id: string, over: Partial<Snap> = {}, rec: Record<string, unknown> = {}) {
  r.paseo.add(id, over);
  await r.pcic.start(r.paseo);
  await r.turn(id, { record: rec });
}

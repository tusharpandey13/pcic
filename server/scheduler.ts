// Per-agent state, hooks, sweeper and queue (SPEC: State machine, R1..R12, R16, R20, R26, R27, R35..R39).
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadConfig, num, pcicHome } from "../server/common.mjs";
import { makeSender, realTimer, turnUserText, type Handle, type PaseoLike, type Snap, type Timer } from "./send.js";
import { makeStore, type SessionRecord } from "./store.js";
import { PAUSE_CODES, type Config } from "./types.js";
import { runJob } from "./job.js";
import { makeCards, type CardChoice } from "./card.js";
import { cardsDir } from "./card.mjs";

export type State = "untracked" | "active" | "idle_wait" | "queued" | "checkpoint" | "compact" | "done" | "skipped";
export interface Job { id: string; anchor: number; sent: number; ownSeen: number; foreign: boolean; startedAt: number; lastSendAt: number; ownOutcome: { code: string } | null }
export interface Agent {
  id: string; cwd: string; parent: string | null; labels: Record<string, string>; state: State; result?: string;
  anchor: number; due: number; deadline: number; ttlObs: number | null; turnStart: number | null; ownActive: boolean; job: Job | null;
}
export interface Deps {
  env: NodeJS.ProcessEnv; now?: () => number; timer?: Timer; log?: (m: string) => void; cliTimeoutMs?: number; version?: () => Promise<string>;
}
const PARENT_LABEL = "paseo.parent-agent-id";

export function createPcic(deps: Deps) {
  const env = deps.env, now = deps.now ?? Date.now, timer = deps.timer ?? realTimer;
  const home = pcicHome(env);
  const warned = new Set<string>();
  const log = (m: string) => { if (!warned.has(m)) { warned.add(m); (deps.log ?? ((x) => process.stderr.write(x + "\n")))(m); } };
  const store = makeStore(home, now, log);
  let cfg = loadConfig(env, (m) => log(`pcic: ${m}`)) as Config;
  let cfgSig = "";
  const agents = new Map<string, Agent>();
  let paseo: PaseoLike | null = null;
  let closed = false, sweeping = false, startedAt = now(), startP: Promise<void> | null = null;
  const inflight = new Set<Promise<void>>();
  const starts: number[] = [];
  let lastStart = 0, probing = false, probed = false;
  const sender = makeSender({ paseo: () => paseo, cfg: () => cfg, store, env, timer, now, log, cliTimeoutMs: deps.cliTimeoutMs, version: deps.version ?? (async () => "unknown") });

  const cards = makeCards({ home, env, now, cfg: () => cfg, store, log, paseo: () => paseo, sender });
  const watchers = new Set<FSWatcher>();

  const reloadConfig = () => {
    let sig = "";
    try { const s = statSync(join(home, "config.json")); sig = `${s.mtimeMs}:${s.size}`; } catch {}
    if (sig === cfgSig && cfgSig !== "") return;
    cfgSig = sig || "none";
    cfg = loadConfig(env, (m) => log(`pcic: ${m}`)) as Config;
  };
  const claudeOnly = (p: string | undefined) => p === "claude";
  const handle = (id: string): Handle => (paseo as PaseoLike).agents.ref(id);
  const excluded = (a: { id: string; cwd: string }) => cfg.exclude.some((e) => e === a.id || (a.cwd && a.cwd.startsWith(e)));
  const optedOut = (a: Agent) => a.labels.pcic === "off" || excluded(a);

  const effTtl = (a: Agent, rec: SessionRecord | null) => {
    const obs = num(rec?.ttlObserved) ?? a.ttlObs;
    if (obs) a.ttlObs = obs;
    return Math.min(cfg.ttlSeconds, a.ttlObs ?? Infinity);
  };
  const schedule = (a: Agent, anchor: number) => {
    const t = now(), rec = store.session(a.id), ttl = effTtl(a, rec);
    a.anchor = Math.min(anchor, t); // R9: an anchor in the future means the clock went backwards
    a.due = a.anchor + cfg.idleSeconds * 1000;
    a.deadline = a.anchor + ttl * 1000 - cfg.lateGraceSeconds * 1000;
    a.state = "idle_wait"; a.result = undefined;
    if (ttl <= 300 && cfg.ttlSeconds > 600) skip(a, "ttl_5m"); // R7: its cache would be cold by the time of the job
  };
  const mk = (id: string, cwd: string, labels: Record<string, string>, parent: string | null): Agent => {
    let a = agents.get(id);
    if (!a) agents.set(id, (a = { id, cwd, parent, labels: labels ?? {}, state: "active", anchor: 0, due: 0, deadline: 0, ttlObs: null, turnStart: null, ownActive: false, job: null }));
    a.cwd = cwd || a.cwd; a.parent = parent ?? a.parent; if (labels) a.labels = labels;
    return a;
  };
  const absorb = (a: Agent, s: Snap | null) => { if (s?.labels) a.labels = s.labels; if (s?.cwd) a.cwd = s.cwd; };

  const finish = (a: Agent, state: "done" | "skipped", result: string, ev: { event: string; reason?: string; tokens?: number | null; pre?: number | null; post?: number | null; mode?: string; ms?: number }) => {
    if (a.state !== "active") { a.state = state; a.result = result; } // when the owner is back, the new turn owns the state
    store.hist({ agent: a.id, ...ev });
  };
  const skip = (a: Agent, reason: string) => finish(a, "skipped", reason, { event: "skipped", reason });

  /** R10. Returns the skip reason, or null when the agent may be handled now. */
  async function check(a: Agent, strict = true): Promise<string | null> {
    if (!cfg.enabled) return "disabled";
    if (store.pause() !== null && (store.pause() as number) > now()) return "paused";
    const h = handle(a.id);
    try { await h.refresh(); } catch { return "not_idle"; }
    const s = h.current();
    if (!s) return "not_idle";
    absorb(a, s);
    if (!claudeOnly(s.provider ?? "claude") || s.archivedAt) return "excluded";
    if (optedOut(a)) return a.labels.pcic === "off" ? "opted_out" : "excluded";
    if (s.internal || s.background || a.labels.pcic === "probe") return "excluded";
    if ((a.parent || s.labels?.[PARENT_LABEL]) && !cfg.includeSubagents) return "subagent";
    if ((s.status !== "idle" && s.status !== "closed") || s.activeTurn || (s.pendingPermissions?.length ?? 0) > 0) return "not_idle";
    if ((num(s.backgroundWork?.count) ?? 0) > 0) return "background_work";
    if (a.job?.foreign) return "not_idle";
    const used = num(s.lastUsage?.contextWindowUsedTokens);
    const tokens = used ? used : num(store.session(a.id)?.contextTokens) || null;
    if (tokens === null) return "unknown_context";
    if (tokens < cfg.minContextTokens) return "small";
    if (strict && effTtl(a, store.session(a.id)) <= 300 && cfg.ttlSeconds > 600) return "ttl_5m";
    return null;
  }

  // ---- hooks ----------------------------------------------------------------------------------
  const startIfNeeded = (p: PaseoLike) => { paseo = p; if (!startP) startP = start(); return startP; };

  async function start() {
    startedAt = now();
    try {
      store.ensure();
      store.pruneClaims();
      for (const id of store.listJobs()) { store.hist({ agent: id, event: "interrupted" }); store.removeJob(id); } // R38
            sender.setVersion(await sender.detectVersion());
      const list = await (paseo as PaseoLike).agents.list();
      for (const e of list.entries as any[]) {
        const s: Snap & { id: string } = e?.agent ?? e;
        if (!s?.id || agents.has(s.id)) continue;
        if (s.labels?.pcic === "probe" && !s.archivedAt) { try { await handle(s.id).archive(); } catch {} continue; } // C19: a leftover probe
        if (!claudeOnly(s.provider) || s.archivedAt) continue;
        const a = mk(s.id, s.cwd ?? "", s.labels ?? {}, s.labels?.[PARENT_LABEL] ?? null);
        if (optedOut(a) || s.internal || s.background) { a.state = "untracked"; continue; }
        if (s.status === "running" || s.status === "initializing") continue;
        const rec = store.session(a.id);
        const act = Date.parse(s.updatedAt ?? "");
        const anchor = Math.max(Number.isFinite(act) ? act : 0, num(rec?.lastAssistantAt) ?? 0);
        if (anchor > 0) schedule(a, anchor); else { a.state = "untracked"; }
      }
    } catch (e) { log(`pcic: start failed (${(e as Error)?.name ?? "error"})`); }
  }

  /** R16. Paseo publishes turn_started before it records the prompt, so only this turn's own entries (by turnId) count; none yet means pcic's. */
  async function ownTurn(a: Agent, turnId: string | null): Promise<boolean> {
    const j = a.job;
    if (!j || j.sent === 0 || j.ownSeen >= j.sent) return false;
    let text: string | null = null;
    try { if (turnId) text = turnUserText(await handle(a.id).timeline.refetch({ direction: "tail", limit: 20, wholeTurns: true }), turnId); } catch {}
    const own = text === null ? true : text.startsWith("[pcic checkpoint]") || text === "/compact" || (text.includes("<paseo-system") && text.includes("/compact")); // the last form is an enveloped send (R25)
    if (own) j.ownSeen++;
    return own;
  }

  const hooks = {
    async "agent.open.before"({ request }: any, ctx: any) {
      if (ctx?.paseo) void startIfNeeded(ctx.paseo);
      if (!claudeOnly(request?.provider) || (request.purpose && request.purpose !== "interactive")) return;
      try {
        reloadConfig();
        const probe = request.labels?.pcic === "probe";
        const off = request.labels?.pcic === "off" || probe || excluded({ id: request.agentId, cwd: request.cwd ?? "" });
        const env2: Record<string, string> = { ...request.env, PCIC_HOME: home };
        if (off) env2.PCIC_OFF = "1";
        return { ...request, env: env2 };
      } catch (e) { log("pcic: open.before failed"); return; }
    },
    async "agent.turn.before"({ agent, turnId }: any, ctx: any) {
      try {
        if (!claudeOnly(agent?.provider)) return;
        if (ctx?.paseo) await startIfNeeded(ctx.paseo);
        const a = mk(agent.id, agent.cwd, null as any, agent.parentAgentId ?? null);
        if (await ownTurn(a, turnId ?? null)) { a.ownActive = true; return; }
        if (a.job) { a.job.foreign = true; if (now() - a.job.lastSendAt <= 2000) store.hist({ agent: a.id, event: "race" }); }
        a.state = "active"; a.turnStart = now();
      } catch { log("pcic: turn.before failed"); }
    },
    async "agent.turn.after"({ agent, outcome }: any, ctx: any) {
      try {
        if (!claudeOnly(agent?.provider)) return;
        if (ctx?.paseo) await startIfNeeded(ctx.paseo);
        const a = mk(agent.id, agent.cwd, null as any, agent.parentAgentId ?? null);
        if (a.ownActive) { // R20, R27: pcic's own turn never moves the anchor
          a.ownActive = false;
          const code = outcome?.kind === "failed" ? String(outcome.error?.code ?? "error") : outcome?.kind === "canceled" ? "canceled" : null;
          if (code && a.job) a.job.ownOutcome = { code };
          if (code && PAUSE_CODES.has(code)) { const until = now() + cfg.pauseMinutes * 60e3; store.setPause(until, code); store.hist({ agent: a.id, event: "paused", reason: code }); }
          return;
        }
        if (store.pause() !== null) { store.clearPause(); } // a foreign turn completed: requests work again
        reloadConfig();
        try { const h = handle(a.id); await h.refresh(); absorb(a, h.current()); } catch {}
        if (agent.parentAgentId) a.parent = agent.parentAgentId;
        a.state = "active";
        if (claudeOnly(agent.provider) && (a.labels.pcic === "probe" || a.labels.pcic === "off" || excluded(a))) { a.state = "untracked"; return; }
        const rec = store.session(a.id);
        const fresh = rec && a.turnStart !== null && (num(rec.writtenAt) ?? 0) >= a.turnStart && num(rec.lastAssistantAt) !== null;
        schedule(a, fresh ? (rec as SessionRecord).lastAssistantAt : now());
        a.turnStart = null;
      } catch { log("pcic: turn.after failed"); }
    },
    async "agent.archive.after"({ agent }: any) { agents.delete(agent?.id); },
  };

  // ---- sweeper --------------------------------------------------------------------------------
  async function sweep(): Promise<void> {
    if (closed || sweeping) return;
    cards.prune(); // R49: even before the first hook event gives us a client
    if (!paseo) return;
    sweeping = true;
    try {
      await startP;
      reloadConfig();
      await cards.autoScan(); // R48: the fallback for the cards/ watcher
      const t = now();
      if (!cfg.enabled) { for (const a of agents.values()) if (a.state === "queued") { a.state = "done"; a.result = "disabled"; } return; }
      for (const a of [...agents.values()]) {
        if (a.state !== "idle_wait") continue;
        if (a.anchor > t) schedule(a, t); // R9
        if (optedOut(a)) { a.state = "untracked"; continue; }
        if (t > a.deadline) { skip(a, "late"); continue; }
        if (t >= a.due) {
          const why = await check(a);
          if (a.state !== "idle_wait") continue;
          if (why === "opted_out") { a.state = "untracked"; continue; } // R35: a label read at the check
          if (why) { skip(a, why); continue; }
          a.state = "queued"; store.hist({ agent: a.id, event: "scheduled" });
        }
      }
      await dequeue();
      await maybeProbe();
    } catch { log("pcic: sweep failed"); } finally { sweeping = false; }
  }

  /** R12: earliest deadline first, at most maxConcurrent in flight, a stagger between starts, an hourly cap. */
  async function dequeue() {
    const queued = [...agents.values()].filter((a) => a.state === "queued").sort((x, y) => x.deadline - y.deadline);
    for (const a of queued) {
      const t = now();
      if (t > a.deadline) { skip(a, "late"); continue; }
      if (inflight.size >= cfg.maxConcurrent || t - lastStart < cfg.staggerSeconds * 1000) break;
      while (starts.length && t - starts[0] > 3600e3) starts.shift();
      if (starts.length >= cfg.maxJobsPerHour) { skip(a, "rate_cap"); continue; }
      const why = await check(a);
      if (a.state !== "queued") continue;
      if (why) { skip(a, why); continue; }
      starts.push(t); lastStart = t;
      a.state = cfg.checkpoint === "awt" && store.session(a.id)?.awtDir ? "checkpoint" : "compact";
      const p: Promise<void> = runJob({ a, cfg: () => cfg, store, sender, now, check, finish, handle, newJob: (anchor) => (a.job = { id: randomUUID(), anchor, sent: 0, ownSeen: 0, foreign: false, startedAt: now(), lastSendAt: 0, ownOutcome: null }) })
        .catch(() => log("pcic: job failed")).finally(() => { inflight.delete(p); if (a.job) a.job = null; });
      inflight.add(p);
    }
  }

  /** R22: no verdict yet, 60 s after start, nothing queued or running: one probe, at most 3 tries per Paseo version. */
  async function maybeProbe() {
    if (cfg.sendMode !== "auto" || probing || probed || closed) return; // one attempt per start
    const v = store.verdict();
    const ver = await sender.detectVersion();
    if (v && v.paseoVersion === ver && v.mode) return;
    if (now() - startedAt < 60e3 || inflight.size > 0 || [...agents.values()].some((a) => a.state === "queued")) return;
    const tries = v && v.paseoVersion === ver ? v.tries : 0;
    if (tries >= 3) return;
    probing = probed = true;
    try {
      const mode = await sender.selfTest();
      store.setVerdict({ paseoVersion: ver, mode, at: now(), tries: mode ? tries : tries + 1 });
      store.hist({ event: "probe", mode: mode ?? "none" });
    } finally { probing = false; }
  }

  return {
    hooks, sweep, sender, store,
    /** R47: the RPC. `p` is the client the RPC handler received; with it the plugin can work after a daemon restart without waiting for a hook event. */
    choose: async (input: { cardId: string; choice: CardChoice; always?: boolean }, p?: PaseoLike) => { if (p && !closed) await startIfNeeded(p); reloadConfig(); return cards.choose(input); },
    autoScan: () => cards.autoScan(),
    /** R48: watch cards/ so an auto card is acted on within moments. Returns the closer. A failed watch is not fatal: the sweep scans too. */
    watchCards: (): (() => void) => {
      try {
        mkdirSync(cardsDir(home), { recursive: true, mode: 0o700 });
        const w = watch(cardsDir(home), () => { void cards.autoScan(false); });
        w.on("error", () => { try { w.close(); } catch {} watchers.delete(w); });
        watchers.add(w);
        return () => { try { w.close(); } catch {} watchers.delete(w); };
      } catch { log("pcic: cannot watch cards/; the sweep scans instead"); return () => {}; }
    },
    /** Lets a test (or the plugin entry) start without a hook event. */
    start: (p: PaseoLike) => startIfNeeded(p),
    state: (id: string) => agents.get(id),
    config: () => cfg,
    idle: async () => { while (inflight.size) await Promise.allSettled([...inflight]); },
    /** R39 */
    cleanup: () => { closed = true; for (const w of watchers) { try { w.close(); } catch {} } watchers.clear(); sender.killChildren(); store.close(); },
  };
}
export type Pcic = ReturnType<typeof createPcic>;

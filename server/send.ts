// Send adapter (R21..R26) and the startup self-test (R23). pcic never passes sourceAgentId.
import { execFile, type ChildProcess } from "node:child_process";
import type { Config } from "./types.js";
import type { Store } from "./store.js";

export interface Snap {
  id?: string; provider?: string; cwd?: string; status?: string; activeTurn?: unknown; pendingPermissions?: unknown[];
  backgroundWork?: { count?: number }; archivedAt?: string | null; labels?: Record<string, string>; internal?: boolean; background?: boolean;
  lastUsage?: Record<string, unknown>; updatedAt?: string; runtimeInfo?: { model?: string | null } | null;
}
export interface RunResult { status: string; error?: string | null }
export interface Handle {
  id?: string;
  refresh(): Promise<unknown>; current(): Snap | null;
  send(text: string, o?: Record<string, unknown>): Promise<unknown>;
  run(text: string, o?: Record<string, unknown>): Promise<RunResult>;
  waitForFinish(ms?: number): Promise<RunResult>;
  archive(): Promise<unknown>;
  timeline: { refetch(o?: Record<string, unknown>): Promise<unknown> };
}
export interface PaseoLike {
  agents: { ref(id: string): Handle; list(o?: Record<string, unknown>): Promise<{ entries: unknown[] }>; create(o: Record<string, unknown>): Promise<Handle> };
}

export type Outcome = { kind: "completed" } | { kind: "failed"; code: string } | { kind: "timeout" } | { kind: "send_failed" };
export type Mode = "plugin" | "cli";
/** A timer that can be cancelled. Production uses setTimeout; tests inject a fake clock. */
export type Timer = (ms: number) => { promise: Promise<void>; cancel(): void };
export const realTimer: Timer = (ms) => {
  let t: NodeJS.Timeout; let done!: () => void;
  const promise = new Promise<void>((r) => { done = r; t = setTimeout(r, ms); t.unref?.(); });
  return { promise, cancel: () => { clearTimeout(t); done(); } };
};

const IDENTITY = ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID"];
const ENVELOPE = "<paseo-system";

export interface SenderDeps {
  paseo: () => PaseoLike | null; cfg: () => Config; store: Store; env: NodeJS.ProcessEnv; timer: Timer; version: () => Promise<string>;
  now: () => number; log: (m: string) => void; cliTimeoutMs?: number;
}

export function makeSender(d: SenderDeps) {
  const children = new Set<ChildProcess>();
  let forced: Mode | null = null; // R25: this process switched to cli
  let verdictCache: { v: string; mode: Mode | null } | null = null;
  let version = "unknown";

  const race = async (p: Promise<Outcome>, ms: number): Promise<Outcome> => {
    const t = d.timer(ms);
    try { return await Promise.race([p, t.promise.then((): Outcome => ({ kind: "timeout" }))]); } finally { t.cancel(); }
  };
  const fromRun = (r: RunResult): Outcome =>
    r.status === "idle" ? { kind: "completed" } : r.status === "timeout" ? { kind: "timeout" } : { kind: "failed", code: r.status === "permission" ? "permission" : "error" };

  const cliSend = (id: string, text: string): Promise<void> => new Promise((ok, no) => {
    const env = { ...d.env }; for (const k of IDENTITY) delete env[k];
    const c = execFile(d.cfg().paseoBin, ["agent", "send", "--behavior", "steer", id, text], { env, timeout: d.cliTimeoutMs ?? 30000, killSignal: "SIGKILL" }, (err) => { children.delete(c); if (err) d.log(`pcic: cli send failed (${(err as NodeJS.ErrnoException).code ?? err.name})`); err ? no(err) : ok(); });
    children.add(c);
    c.stdin?.end();
  });

  /** The mode in force: a forced config mode, else a verdict for this Paseo version, else plugin (primary, confirmed from source). */
  const mode = (): Mode => {
    const sm = d.cfg().sendMode;
    if (sm !== "auto") return sm;
    if (forced) return forced;
    const v = d.store.verdict();
    return v && v.paseoVersion === version && v.mode ? v.mode : "plugin";
  };
  const opts = { activeTurnBehavior: "steer" }; // never `interrupt`: a send that loses the idle race must not kill the owner's turn

  return {
    mode,
    setVersion: (v: string) => { version = v; },
    switchToCli: () => { forced = "cli"; d.store.setVerdict({ paseoVersion: version, mode: "cli", at: d.now(), tries: 0 }); },
    killChildren: () => { for (const c of children) c.kill("SIGKILL"); children.clear(); },
    /** One turn with a fixed text (the checkpoint, or `/clear` for the card): plugin mode uses run(); cli mode sends then waits. */
    async turn(id: string, text: string, timeoutS: number): Promise<Outcome> {
      const p = d.paseo(); if (!p) return { kind: "send_failed" };
      const h = p.agents.ref(id);
      try {
        if (mode() === "plugin") return await race(h.run(text, opts).then(fromRun), timeoutS * 1000);
        await cliSend(id, text);
        return await race(h.waitForFinish(timeoutS * 1000).then(fromRun), timeoutS * 1000);
      } catch { return { kind: "send_failed" }; }
    },
    checkpoint(id: string, text: string, timeoutS: number): Promise<Outcome> { return this.turn(id, text, timeoutS); },
    /** Sends one text and does not wait for the turn (the owner's own prompt, R47). True when the send was accepted. */
    async say(id: string, text: string): Promise<boolean> {
      const p = d.paseo(); if (!p) return false;
      try { if (mode() === "plugin") await p.agents.ref(id).send(text, opts); else await cliSend(id, text); return true; } catch { return false; }
    },
    /** Exactly `/compact`, then wait for the turn to end. */
    async compact(id: string, timeoutS: number): Promise<Outcome> {
      const p = d.paseo(); if (!p) return { kind: "send_failed" };
      const h = p.agents.ref(id);
      try {
        if (mode() === "plugin") await h.send("/compact", opts); else await cliSend(id, "/compact");
        return await race(h.waitForFinish(timeoutS * 1000).then(fromRun), timeoutS * 1000);
      } catch { return { kind: "send_failed" }; }
    },
    async detectVersion(): Promise<string> {
      if (d.env.PASEO_VERSION) return (version = d.env.PASEO_VERSION);
      version = await new Promise<string>((ok) => execFile(d.cfg().paseoBin, ["--version"], { timeout: 5000, encoding: "utf8" }, (e, out) => ok(e ? "unknown" : String(out).trim() || "unknown")));
      return version;
    },
    /**
     * R23. Creates one probe agent, sends `/compact` through the plugin handle, reads its timeline, archives it on every path.
     * Returns the verdict, or null when the test could not run.
     */
    async selfTest(): Promise<Mode | null> {
      const p = d.paseo(); if (!p) return null;
      let h: Handle | null = null;
      try {
        const cfg = d.cfg();
        h = await p.agents.create({ config: { provider: cfg.probeModel ? `claude/${cfg.probeModel}` : "claude" }, cwd: d.store.probeDir(), labels: { pcic: "probe" }, title: "pcic probe" });
        const id = h.id ?? (h.current()?.id as string);
        await h.send("/compact", opts);
        await Promise.race([h.waitForFinish(60000), d.timer(60000).promise]);
        const page = await p.agents.ref(id).timeline.refetch({ direction: "tail", limit: 20 });
        return judge(page);
      } catch { return null; } finally { try { await h?.archive(); } catch { d.log("pcic: probe archive failed"); } }
    },
  };
}

/** Walks a timeline page: envelope text or a model reply means the send was not plain. */
export function judge(page: unknown): Mode {
  let envelope = false, reply = false;
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (o.type === "user_message" && typeof o.text === "string" && o.text.includes(ENVELOPE)) envelope = true;
    else if (o.type === "assistant_message" && typeof o.text === "string" && o.text.trim() && !o.text.startsWith("Error:")) reply = true; // an empty probe session answers with the local "Error: No messages to compact" (seen live)
    else Object.values(o).forEach((x) => walk(x, depth + 1));
  };
  walk(page, 0);
  return envelope || reply ? "cli" : "plugin";
}

/** The first user_message text among the entries of one turn, or null when the turn has none yet. */
export function turnUserText(page: unknown, turnId: string): string | null {
  const entries = (page as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return null;
  for (const e of entries as { turnId?: unknown; item?: { type?: unknown; text?: unknown } }[]) if (e?.turnId === turnId && e.item?.type === "user_message" && typeof e.item.text === "string") return e.item.text;
  return null;
}

/** Timeline helper shared by the job: user_message and compaction rows in order. */
export interface Row { type: string; text: string; status?: unknown }
export function rows(page: unknown): Row[] {
  const out: Row[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.type === "string" && ["user_message", "assistant_message", "compaction", "error"].includes(o.type)) out.push({ type: o.type, text: typeof o.text === "string" ? o.text : "", status: o.status });
    else Object.values(o).forEach((x) => walk(x, depth + 1));
  };
  walk(page, 0);
  return out;
}

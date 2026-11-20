// Send adapter (R21, R24, R26, R53). pcic never passes sourceAgentId.
import { execFile, type ChildProcess } from "node:child_process";
import type { Config } from "./types.js";

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
  agents: { ref(id: string): Handle; list(o?: Record<string, unknown>): Promise<{ entries: unknown[] }> };
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

export interface SenderDeps {
  paseo: () => PaseoLike | null; cfg: () => Config; env: NodeJS.ProcessEnv; timer: Timer;
  log: (m: string) => void; cliTimeoutMs?: number;
}

export function makeSender(d: SenderDeps) {
  const children = new Set<ChildProcess>();

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

  /** R53: plugin, unless the owner forces `cli` (manual fallback). `auto` and `plugin` both mean plugin. */
  const mode = (): Mode => (d.cfg().sendMode === "cli" ? "cli" : "plugin");
  const opts = { activeTurnBehavior: "steer" }; // never `interrupt`: a send that loses the idle race must not kill the owner's turn

  return {
    mode,
    killChildren: () => { for (const c of children) c.kill("SIGKILL"); children.clear(); },
    /** One turn with a fixed text (the checkpoint, or `/clear` for the card): plugin mode uses run(); cli mode sends then waits. */
    async turn(id: string, text: string, timeoutS: number, messageId?: string): Promise<Outcome> {
      const p = d.paseo(); if (!p) return { kind: "send_failed" };
      const h = p.agents.ref(id);
      try {
        if (mode() === "plugin") return await race(h.run(text, messageId ? { ...opts, messageId } : opts).then(fromRun), timeoutS * 1000);
        await cliSend(id, text);
        return await race(h.waitForFinish(timeoutS * 1000).then(fromRun), timeoutS * 1000);
      } catch { return { kind: "send_failed" }; }
    },
    checkpoint(id: string, text: string, timeoutS: number, messageId?: string): Promise<Outcome> { return this.turn(id, text, timeoutS, messageId); },
    /** Sends one text and does not wait for the turn (the owner's own prompt, R47). True when the send was accepted. */
    async say(id: string, text: string, messageId?: string): Promise<boolean> {
      const p = d.paseo(); if (!p) return false;
      try { if (mode() === "plugin") await p.agents.ref(id).send(text, messageId ? { ...opts, messageId } : opts); else await cliSend(id, text); return true; } catch { return false; }
    },
    /** Exactly `/compact`, then wait for the turn to end. */
    async compact(id: string, timeoutS: number, messageId?: string): Promise<Outcome> {
      const p = d.paseo(); if (!p) return { kind: "send_failed" };
      const h = p.agents.ref(id);
      try {
        if (mode() === "plugin") await h.send("/compact", messageId ? { ...opts, messageId } : opts); else await cliSend(id, "/compact");
        return await race(h.waitForFinish(timeoutS * 1000).then(fromRun), timeoutS * 1000);
      } catch { return { kind: "send_failed" }; }
    },
  };
}

/** The first user_message of one turn (its text and Paseo messageId), or null when the turn has none yet. */
export function turnFirstUser(page: unknown, turnId: string): { text: string; messageId: string | null } | null {
  const entries = (page as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return null;
  for (const e of entries as { turnId?: unknown; item?: { type?: unknown; text?: unknown; messageId?: unknown } }[]) if (e?.turnId === turnId && e.item?.type === "user_message" && typeof e.item.text === "string") return { text: e.item.text, messageId: typeof e.item.messageId === "string" ? e.item.messageId : null };
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

// The state dir (SPEC: State dir). Every write is temp + rename; claims are O_EXCL.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, createExcl, readJson, record } from "../server/common.mjs";

export interface SessionRecord { sessionId: string | null; transcriptPath: string; cwd: string | null; awtDir: string | null; lastAssistantAt: number; lastAssistantUuid: string | null; contextTokens: number | null; model: string | null; ttlObserved: number | null; writtenAt: number }
export interface JobFile { jobId: string; anchor: number; phase: string; startedAt: number }
export interface Verdict { paseoVersion: string; mode: "plugin" | "cli" | null; at: number; tries: number }
export interface HistoryEvent { agent?: string; event: string; reason?: string; tokens?: number | null; pre?: number | null; post?: number | null; mode?: string; ms?: number }

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

export function makeStore(home: string, now: () => number, log: (m: string) => void) {
  const p = (...a: string[]) => join(home, ...a);
  let closed = false;
  return {
    home,
    /** After cleanup nothing more is written (R39). */
    close: () => { closed = true; },
    hist: (ev: HistoryEvent) => { if (!closed) record(home, ev, { now: now(), log }); },
    session: (id: string): SessionRecord | null => readJson(p("sessions", `${safe(id)}.json`)),
    /** R11. "error" when the claim cannot be created for any reason but existence. */
    claim: (id: string, anchor: number): "ok" | "exists" | "error" => {
      try { return createExcl(p("claims", `${safe(id)}.${anchor}`)) ? "ok" : "exists"; } catch { return "error"; }
    },
    pruneClaims: () => {
      try { for (const f of readdirSync(p("claims"))) if (now() - statSync(p("claims", f)).mtimeMs > 7 * 86400e3) rmSync(p("claims", f), { force: true }); } catch {}
    },
    writeJob: (id: string, j: JobFile) => atomicWrite(p("jobs", `${safe(id)}.json`), JSON.stringify(j)),
    removeJob: (id: string) => rmSync(p("jobs", `${safe(id)}.json`), { force: true }),
    listJobs: (): string[] => { try { return readdirSync(p("jobs")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { return []; } },
    writePending: (id: string, jobId: string) => atomicWrite(p("pending", `${safe(id)}.json`), JSON.stringify({ at: now(), jobId })),
    verdict: (): Verdict | null => { const v = readJson(p("verdict.json")); return v && typeof v.paseoVersion === "string" ? v : null; },
    setVerdict: (v: Verdict) => atomicWrite(p("verdict.json"), JSON.stringify(v)),
    pause: (): number | null => { const v = readJson(p("pause.json")); return v && Number.isFinite(v.until) ? v.until : null; },
    setPause: (until: number, reason: string) => atomicWrite(p("pause.json"), JSON.stringify({ until, reason })),
    clearPause: () => rmSync(p("pause.json"), { force: true }),
    ensure: () => mkdirSync(home, { recursive: true }),
    probeDir: () => { const d = p("probe"); mkdirSync(d, { recursive: true }); return d; },
  };
}
export type Store = ReturnType<typeof makeStore>;

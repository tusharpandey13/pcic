// One job: checkpoint turn, then /compact (R13..R19, R25). Never retried, never resumed.
import { readTail } from "../shared/transcript.mjs";
import { rows, type Handle, type Mode, type Outcome } from "./send.js";
import type { Store } from "./store.js";
import { CHECKPOINT_TEXT, type Config } from "./types.js";
import type { Agent, Job } from "./scheduler.js";

type Ev = { event: string; reason?: string; tokens?: number | null; pre?: number | null; post?: number | null; mode?: string; ms?: number };
export interface JobCtx {
  a: Agent; cfg: () => Config; store: Store; now: () => number;
  sender: { mode(): Mode; checkpoint(id: string, text: string, s: number): Promise<Outcome>; compact(id: string, s: number): Promise<Outcome>; switchToCli(): void };
  check: (a: Agent) => Promise<string | null>;
  finish: (a: Agent, state: "done" | "skipped", result: string, ev: Ev) => void;
  handle: (id: string) => Handle;
  newJob: (anchor: number) => Job;
}

const failCode = (o: Outcome, job: Job): string => (o.kind === "failed" ? job.ownOutcome?.code ?? o.code : o.kind === "timeout" ? "timeout" : "send_failed");

export async function runJob(c: JobCtx): Promise<void> {
  const { a, store, sender, now, finish } = c;
  const cfg = c.cfg(), anchor = a.anchor, job = c.newJob(anchor), t0 = now();
  const done = (result: string, ev: Ev) => finish(a, "done", result, ev);
  const abort = (reason: string) => done(`aborted_${reason}`, { event: "aborted", reason });
  // R11: the claim comes before the first send. No claim, no job.
  const claim = store.claim(a.id, anchor);
  if (claim !== "ok") return finish(a, "skipped", "claimed", { event: "skipped", reason: "claimed" });
  try { store.writeJob(a.id, { jobId: job.id, anchor, phase: a.state, startedAt: t0 }); } catch {}
  try {
    if (cfg.checkpoint === "awt" && store.session(a.id)?.awtDir) {
      const why = await c.check(a); // the last check runs in the same tick as the send below
      if (why) return abort(why);
      if (job.foreign) return abort("user");
      job.sent++; job.lastSendAt = now();
      const out = await sender.checkpoint(a.id, CHECKPOINT_TEXT, cfg.checkpointTimeoutSeconds);
      if (job.foreign) return abort("user");
      if (out.kind !== "completed" || job.ownOutcome) { const code = job.ownOutcome?.code ?? failCode(out, job); return done(`checkpoint_failed:${code}`, { event: "checkpoint_failed", reason: code }); }
      store.hist({ agent: a.id, event: "checkpoint_ok", ms: now() - t0 });
    }
    a.state = "compact";
    const why = await c.check(a);
    if (why) return abort(why);
    // run() reports a canceled turn as idle; its turn.after may land only now (R15)
    const late = job.ownOutcome as { code: string } | null; // set by turn.after while we awaited
    if (late) { const code = late.code; return done(`checkpoint_failed:${code}`, { event: "checkpoint_failed", reason: code }); }
    if (job.foreign) return abort("user");
    if (now() >= a.deadline) return abort("late"); // R17
    try { store.writePending(a.id, job.id); store.writeJob(a.id, { jobId: job.id, anchor, phase: "compact", startedAt: t0 }); } catch { return abort("state"); }
    job.sent++; job.lastSendAt = now();
    const out = await sender.compact(a.id, cfg.compactTimeoutSeconds);
    if (job.foreign) return abort("user");
    if (out.kind !== "completed" || job.ownOutcome) { const code = job.ownOutcome?.code ?? failCode(out, job); return done(`compact_failed:${code}`, { event: "compact_failed", reason: code, mode: sender.mode() }); }
    const mode = sender.mode();
    let page: unknown = null;
    try { page = await c.handle(a.id).timeline.refetch({ direction: "tail", limit: 50 }); } catch {}
    const rs = rows(page);
    let from = -1;
    rs.forEach((r, i) => { if (r.type === "user_message" && (r.text === "/compact" || r.text.includes("<paseo-system"))) from = i; });
    const after = from >= 0 ? rs.slice(from + 1) : [];
    // R25: an envelope, or a model reply to /compact, means the send was not plain.
    if (mode === "plugin" && from >= 0 && (rs[from].text.includes("<paseo-system") || after.some((r) => r.type === "assistant_message" && r.text.trim()))) {
      sender.switchToCli();
      return done("compact_failed:not_plain", { event: "compact_failed", reason: "not_plain", mode });
    }
    // R19: a compact_boundary newer than the job start, or a completed compaction item.
    let b: { at: number; pre: number | null; post: number | null } | null = null;
    const rec = store.session(a.id);
    if (rec?.transcriptPath) { const t = await readTail(rec.transcriptPath); if (t.boundary && t.boundary.at >= t0) b = t.boundary; }
    if (b || after.some((r) => r.type === "compaction" && r.status === "completed")) return done("compacted", { event: "compacted", pre: b?.pre, post: b?.post, mode, ms: now() - t0 });
    return done("compact_unverified", { event: "compact_unverified", mode, ms: now() - t0 });
  } finally { try { store.removeJob(a.id); } catch {} }
}

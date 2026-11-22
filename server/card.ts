// The cold-return card on the daemon side: the RPC `choose` (R47), auto mode (R48) and expiry (R49).
// Never logs or records the prompt. Sends only the owner's own blocked prompt, `/clear` and `/compact` (R42).
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, num, readJson, safeName, setConfigKey } from "./common.mjs";
import { CARD_ID, CARD_TTL_MS, cardPath, cardsDir, pruneCards, usedPath } from "./card.mjs";
import { readTail } from "./transcript.mjs";
import { rows, type Handle, type Outcome, type PaseoLike } from "./send.js";
import type { Store } from "./store.js";
import type { Config } from "./types.js";
import { msgId } from "../shared/cold-card.js";

export type CardChoice = "resume" | "compact" | "checkpoint" | "dismiss";
export type CardStatus = "sent" | "dismissed" | "already_used" | "not_idle" | "expired" | "failed";
export interface CardResult { status: CardStatus; detail?: string }
/** An auto card (R48) is acted on only while it is this young; later the owner has probably moved on. */
export const AUTO_MAX_AGE_MS = 10 * 60e3;

export interface CardDeps {
  home: string; env: NodeJS.ProcessEnv; now: () => number; cfg: () => Config; store: Store; log: (m: string) => void;
  paseo: () => PaseoLike | null;
  sender: { turn(id: string, text: string, s: number, messageId?: string): Promise<Outcome>; compact(id: string, s: number, messageId?: string): Promise<Outcome>; say(id: string, text: string, messageId?: string): Promise<boolean> };
}
interface CardFile { v: number; cardId: string; agentId: string; prompt: string; createdAt: number; auto?: boolean; awt?: boolean; sessionId?: string; lastAssistantUuid?: string }

const valid = (c: unknown): c is CardFile => !!c && typeof c === "object" && typeof (c as CardFile).agentId === "string" && typeof (c as CardFile).prompt === "string" && num((c as CardFile).createdAt) !== null;

export function makeCards(d: CardDeps) {
  const { home, now, store } = d;
  const fail = (card: CardFile | null, reason: string, detail?: string): CardResult => { store.hist({ agent: card?.agentId, event: "card_failed", reason }); return { status: "failed", detail: detail ?? reason }; };

  /** R26: the agent must be idle right now. Returns a reason, or null. */
  async function idleNow(id: string): Promise<string | null> {
    const p = d.paseo(); if (!p) return "no_client";
    if (!d.cfg().enabled) return "disabled";
    let h: Handle;
    try { h = p.agents.ref(id); await h.refresh(); } catch { return "not_idle"; }
    const s = h.current();
    if (!s) return "not_idle";
    if ((s.provider ?? "claude") !== "claude" || s.archivedAt) return "excluded";
    if ((s.status !== "idle" && s.status !== "closed") || s.activeTurn || (s.pendingPermissions?.length ?? 0) > 0 || (num(s.backgroundWork?.count) ?? 0) > 0) return "not_idle";
    return null;
  }

  /** R19, as for a job: a completed compaction item in the timeline, or a compact_boundary in the transcript newer than `since`. */
  async function compactVerified(id: string, since: number): Promise<boolean> {
    let page: unknown = null;
    try { page = await (d.paseo() as PaseoLike).agents.ref(id).timeline.refetch({ direction: "tail", limit: 50 }); } catch {}
    const rs = rows(page);
    let from = -1; rs.forEach((r, i) => { if (r.type === "user_message" && r.text === "/compact") from = i; });
    if (from >= 0 && rs.slice(from + 1).some((r) => r.type === "compaction" && r.status === "completed")) return true;
    const rec = store.session(id);
    if (rec?.transcriptPath) { const t = await readTail(rec.transcriptPath); if (t.boundary && t.boundary.at >= since) return true; }
    return false;
  }

  /** R47 */
  async function choose(input: { cardId: string; choice: CardChoice; always?: boolean }): Promise<CardResult> {
    const { cardId, choice } = input;
    if (!CARD_ID.test(cardId)) return { status: "expired" };
    const card = readJson(cardPath(home, cardId));
    if (!valid(card)) return { status: existsSync(usedPath(home, cardId)) ? "already_used" : "expired" };
    if (now() - card.createdAt > CARD_TTL_MS) { rmSync(cardPath(home, cardId), { force: true }); store.hist({ agent: card.agentId, event: "card_failed", reason: "expired" }); return { status: "expired" }; }
    // The claim: only one caller wins the rename. The used file keeps no prompt.
    try { renameSync(cardPath(home, cardId), usedPath(home, cardId)); } catch { return { status: "already_used" }; }
    const { prompt, ...rest } = card;
    try { atomicWrite(usedPath(home, cardId), JSON.stringify({ ...rest, usedAt: now() }), 0o600); } catch {}
    const release = () => { try { atomicWrite(cardPath(home, cardId), JSON.stringify(card), 0o600); rmSync(usedPath(home, cardId), { force: true }); } catch {} };
    const always = !!input.always && (choice === "resume" || choice === "checkpoint");
    if (choice === "dismiss") { rmSync(usedPath(home, cardId), { force: true }); store.hist({ agent: card.agentId, event: "card_choice", choice, always: false }); return { status: "dismissed" }; }

    const cfg = d.cfg(), id = card.agentId;
    const why = await idleNow(id);
    if (why) { release(); return why === "not_idle" ? { status: "not_idle" } : { status: "failed", detail: why }; }
    store.hist({ agent: id, event: "card_choice", choice, always });
    if (always) { const err = setConfigKey(d.env, "coldChoice", choice); if (err) d.log(`pcic: could not save coldChoice (${err})`); }

    const timeout = cfg.compactTimeoutSeconds;
    const sendPrompt = async (): Promise<CardResult> => {
      const again = await idleNow(id); // the same-tick check before the send (R26)
      if (again) return fail(card, again === "not_idle" ? "not_idle_before_send" : again, again === "not_idle" ? "the agent became busy" : again);
      return (await d.sender.say(id, prompt, msgId("prompt", cardId))) ? { status: "sent" } : fail(card, "send_failed");
    };
    try {
      if (choice === "resume") {
        // R54: refresh the marker so the guard passes a card answered after markerSeconds.
        if (typeof card.sessionId === "string" && typeof card.lastAssistantUuid === "string") try { atomicWrite(join(home, "guard", `${safeName(card.sessionId)}.json`), JSON.stringify({ lastAssistantUuid: card.lastAssistantUuid, at: now() })); } catch {}
        return await sendPrompt();
      }
      if (choice === "compact") {
        const t0 = now();
        try { store.writePending(id, "card"); } catch { return fail(card, "state"); }
        const out = await d.sender.compact(id, timeout, msgId("compact", cardId));
        if (out.kind !== "completed") return fail(card, `compact_${out.kind === "failed" ? out.code : out.kind}`, "the compaction failed");
        if (!(await compactVerified(id, t0))) return fail(card, "compact_unverified", "the compaction could not be confirmed");
        return await sendPrompt();
      }
      const out = await d.sender.turn(id, "/clear", timeout, msgId("clear", cardId));
      if (out.kind !== "completed") return fail(card, `clear_${out.kind === "failed" ? out.code : out.kind}`, "/clear failed");
      return await sendPrompt();
    } catch { return fail(card, "error"); }
  }

  let scanning = false, again = false, againAll = false;
  /** Auto cards that found the agent busy. Releasing a claim rewrites the card file, which the watcher sees; only the sweep (`all`) retries these, so a busy agent cannot cause a loop. */
  const waiting = new Set<string>();
  /** R48: act once on each fresh `auto` card. The rename claim makes a second call, or a second watcher event, a no-op. A call that arrives during a scan makes it run once more, so a card written mid-scan is not missed. */
  async function autoScan(all = true): Promise<void> {
    if (scanning) { again = true; againAll = againAll || all; return; }
    if (!d.paseo() || !d.cfg().enabled) return;
    scanning = true;
    try {
      let full = all;
      do { again = false; againAll = false; await scanOnce(full); full = againAll; } while (again);
    } finally { scanning = false; }
  }
  async function scanOnce(all: boolean): Promise<void> {
    try {
      let files: string[] = [];
      try { files = readdirSync(cardsDir(home)).filter((f) => f.endsWith(".json")); } catch { return; }
      for (const f of files) {
        const id = f.slice(0, -5);
        const card = readJson(cardPath(home, id));
        if (!valid(card) || card.auto !== true || !CARD_ID.test(id) || (!all && waiting.has(id))) continue;
        if (now() - card.createdAt > AUTO_MAX_AGE_MS) { rmSync(cardPath(home, id), { force: true }); store.hist({ agent: card.agentId, event: "card_failed", reason: "auto_stale" }); continue; }
        const r = await choose({ cardId: id, choice: "checkpoint", always: false }); // not_idle releases the claim: the next sweep tries again
        if (r.status === "not_idle") waiting.add(id); else waiting.delete(id);
      }
    } catch { d.log("pcic: auto card scan failed"); }
  }

  /** R49 */
  const prune = () => pruneCards(home, now());
  return { choose, autoScan, prune };
}
export type Cards = ReturnType<typeof makeCards>;

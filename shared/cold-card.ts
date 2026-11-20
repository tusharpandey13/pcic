// The cold-return card, pure part (R45, R46, R47). No Node imports: the Paseo plugin builder bundles shared/ for both runtimes.
import { defineRpc } from "@getpaseo/plugin";
import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import { z } from "zod";

/** The block text of the guard (R33) starts with this; the transformer needs it plus a card line (R45). */
export const COLD_MARK = "pcic: this agent's prompt cache has likely expired";
/** Paseo 0.16.2 rejects a plugin id or kind that does not match this (the app throws, and the whole client entry is dropped). */
export const PASEO_ID = /^[a-z][a-z0-9-]*$/;
export const CARD_KIND = "pcic-cold-card";
export const CARD_VERSION = 1;

export const cardDataSchema = z.object({
  cardId: z.string().regex(/^[0-9a-f]{16}$/),
  idleMs: z.number().nonnegative(), tokens: z.number().nonnegative(),
  resume: z.number().nonnegative().nullable(), compact: z.number().nonnegative().nullable(), checkpoint: z.number().nonnegative().nullable(),
  awt: z.boolean(), auto: z.boolean(),
});
export type CardData = z.infer<typeof cardDataSchema>;

export const CHOICES = ["resume", "compact", "checkpoint", "dismiss"] as const;
export type Choice = (typeof CHOICES)[number];
export const STATUSES = ["sent", "dismissed", "already_used", "not_idle", "expired", "failed"] as const;
export type Status = (typeof STATUSES)[number];

export const chooseRpc = defineRpc({
  name: "pcic.choose",
  input: z.object({ cardId: z.string().regex(/^[0-9a-f]{16}$/), choice: z.enum(CHOICES), always: z.boolean().default(false) }),
  output: z.object({ status: z.enum(STATUSES), detail: z.string().optional() }),
});

const LINE = /^\[pcic-card v1 ([0-9a-f]{16}) idle=(\d+) tokens=(\d+) resume=(-|[\d.]+) compact=(-|[\d.]+) checkpoint=(-|[\d.]+) awt=([01])( auto=1)?\]$/;
const usd = (s: string): number | null => (s === "-" ? null : Number(s));

/** Parses one `[pcic-card v1 ...]` line (the format written by server/card.mjs `cardLine`). Null when malformed. */
export function parseCardLine(line: string): CardData | null {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const d = { cardId: m[1], idleMs: Number(m[2]), tokens: Number(m[3]), resume: usd(m[4]), compact: usd(m[5]), checkpoint: usd(m[6]), awt: m[7] === "1", auto: !!m[8] };
  const ok = cardDataSchema.safeParse(d);
  return ok.success ? ok.data : null;
}

/** The card in a block text: the text has the guard's first sentence and a valid card line (the last such line wins). */
export function findCard(text: unknown): CardData | null {
  if (typeof text !== "string" || !text.includes(COLD_MARK)) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trimStart().startsWith("[pcic-card ")) return parseCardLine(lines[i]);
  return null;
}

/** The item types whose text can carry the hook's stderr (V11: which one Paseo uses is unverified, so the client registers a transformer for each). */
export const TEXT_TYPES = ["user_message", "assistant_message", "error", "notification"] as const;
export type TextType = (typeof TEXT_TYPES)[number];
/** The transformer id for one item type, e.g. `pcic-cold-card-user-message` (must match PASEO_ID). */
export const transformerId = (itemType: TextType): string => `pcic-cold-card-${itemType.replace(/_/g, "-")}`;
/** The text of an item of one of TEXT_TYPES. */
export const itemText = (item: unknown): string | null => {
  const i = item as { type?: unknown; text?: unknown; message?: unknown } | null;
  const v = i && (i.type === "user_message" || i.type === "assistant_message" ? i.text : i.type === "error" || i.type === "notification" ? i.message : null);
  return typeof v === "string" ? v : null;
};

/** R45: the replacement for one timeline item's text, or undefined to leave the item alone. Deterministic, synchronous. */
export function transformText(text: unknown): PluginTimelineTransformResult | undefined {
  const data = findCard(text);
  return data ? { items: [{ type: "plugin", kind: CARD_KIND, version: CARD_VERSION, data }] } : undefined;
}

// ---- the view (R46) -------------------------------------------------------------------------------

export const fmtUsd = (n: number | null): string => (n === null ? "" : ` ~$${n >= 0.1 ? n.toFixed(2) : String(Number(n.toPrecision(2)))}`);
export const fmtIdle = (ms: number): string => `${Math.round(ms / 60000)} min`;
export const fmtTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export interface ViewOption { id: string; choice: Exclude<Choice, "dismiss">; always: boolean; label: string }
export interface View { header: string; auto: string | null; options: ViewOption[] }

export function viewModel(d: CardData): View {
  const header = `Cache expired ${fmtIdle(d.idleMs)} ago. Context: ${fmtTokens(d.tokens)} tokens.`;
  if (d.auto) return { header, auto: `Cache expired ${fmtIdle(d.idleMs)} ago. Continuing from checkpoint (your setting; change with: pcic config coldChoice ask)`, options: [] };
  const o = (choice: ViewOption["choice"], always: boolean, label: string): ViewOption => ({ id: `${choice}${always ? "+always" : ""}`, choice, always, label });
  const options = [
    o("resume", false, `Resume full context${fmtUsd(d.resume)}`),
    d.awt ? o("checkpoint", false, `Continue from checkpoint${fmtUsd(d.checkpoint)} (new session: awt brief + your message)`) : o("checkpoint", false, `Start fresh${fmtUsd(d.checkpoint)} (new session: your message only)`),
    o("compact", false, `Compact, then send${fmtUsd(d.compact)}`),
    o("resume", true, "Resume full context (don't ask again)"),
    ...(d.awt ? [o("checkpoint", true, "Continue from checkpoint (don't ask again)")] : []),
  ];
  return { header, auto: null, options };
}

/** What the row says while the server works. */
export function pendingText(choice: ViewOption["choice"], awt: boolean): string {
  return choice === "resume" ? "Sending with full context" : choice === "compact" ? "Compacting, then sending" : awt ? "Cleared, sending with the awt brief" : "Cleared, sending your message";
}
/** What the row says when the server answered. `retry` is true when the card is usable again. */
export function resultText(choice: Choice, awt: boolean, r: { status: Status; detail?: string }): { text: string; retry: boolean } {
  switch (r.status) {
    case "sent": return { text: choice === "resume" ? "Sent with full context" : choice === "compact" ? "Compacted, message sent" : awt ? "Cleared, sent with the awt brief" : "Cleared, sent as a fresh session", retry: false };
    case "dismissed": return { text: "Dismissed. Resend your message to continue.", retry: false };
    case "already_used": return { text: "Already answered.", retry: false };
    case "expired": return { text: "This card expired. Resend your message.", retry: false };
    case "not_idle": return { text: "The agent is busy right now. Choose again when it is idle.", retry: true };
    default: return { text: `Failed${r.detail ? `: ${r.detail}` : ""}. Your message was not sent; resend it.`, retry: false };
  }
}

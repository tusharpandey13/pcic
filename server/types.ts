export interface Config {
  enabled: boolean; ttlSeconds: number; idleSeconds: number; lateGraceSeconds: number; minContextTokens: number; guard: boolean;
  checkpoint: "awt" | "off"; precompact: boolean; precompactExtra: string; includeSubagents: boolean; exclude: string[];
  maxConcurrent: number; staggerSeconds: number; maxJobsPerHour: number; checkpointTimeoutSeconds: number; compactTimeoutSeconds: number;
  pauseMinutes: number; sweepSeconds: number; sendMode: "auto" | "plugin" | "cli"; paseoBin: string; probeModel: string;
  prices: Record<string, unknown> | null;
}
export const CHECKPOINT_TEXT = `[pcic checkpoint] This session has been idle; its prompt cache expires soon and the conversation will be compacted next. Do not continue the task and do not start new work. Bring the awt record up to date: run awt state --now "<what you were doing, where you stopped>" --next "<the next concrete steps>"; for each decision made since the last awt record, awt decide "<choice>" --why "<reason>"; for each fact needed later that is in no file, awt note "<fact>". Then reply with exactly one line: checkpoint saved, or checkpoint failed: <reason>.`;
/** R27: error codes that pause every job. Matched by code, never by message text. */
export const PAUSE_CODES = new Set(["rate_limit", "rate_limit_error", "overloaded", "overloaded_error", "usage_limit", "usage_limit_reached", "quota_exceeded", "authentication_error", "auth_error", "unauthorized", "invalid_api_key", "billing_error"]);

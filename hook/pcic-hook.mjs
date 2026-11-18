// The Claude Code hooks: Stop (session record), PreCompact (summary instructions), UserPromptSubmit (cold-return guard).
// Every path catches its own errors and ends in "do nothing": exit 0, no output (R4).
import { execFile } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, createExcl, hookActive, loadConfig, nowMs, num, pcicHome, priceFor, readJson, record } from "../server/common.mjs";
import { readTail } from "../server/transcript.mjs";

const PASS = { code: 0, stdout: "", stderr: "" };
const quiet = () => {};

const AWT_NOTE = "pcic compaction note: this task keeps an awt record (goal, state, decisions, open questions, recent notes). It is added back to the context automatically right after this compaction, so do not restate it. The summary must keep: the user's latest request and constraints (verbatim when short); work in progress not yet in awt (files being changed with paths, commands running, partial results, errors seen); anything decided or learned since the last awt record; the next concrete step. Drop tool output already acted on and file contents that can be read again.";
const GENERIC_NOTE = "pcic compaction note: this conversation is being compacted because it went idle. The summary must keep: the goal; the user's latest request and constraints (verbatim when short); decisions made and why; work in progress (files with paths, commands, partial results, errors); open questions; the next concrete step. Drop tool output already acted on and file contents that can be read again.";

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

/** R29 */
async function stop(input, env, _cfg, home) {
  if (typeof input.transcript_path !== "string") return PASS;
  const file = join(home, "sessions", `${safeName(env.PASEO_AGENT_ID)}.json`);
  const prev = readJson(file);
  let { last, ttlObserved } = await readTail(input.transcript_path);
  // Claude Code runs Stop before it flushes the turn's last assistant entry (seen live, V4): wait up to 2 s until the newest
  // entry carries the turn's final text (`last_assistant_message`), or, for a turn with no text, until it differs from the previous record's.
  if (typeof input.last_assistant_message === "string") {
    const want = input.last_assistant_message.trim();
    const settled = () => last && (want ? last.text.trim() === want : last.uuid !== prev?.lastAssistantUuid);
    for (let i = 0; i < 40 && !settled(); i++) { await new Promise((r) => setTimeout(r, 50)); ({ last, ttlObserved } = await readTail(input.transcript_path)); }
  }
  if (!last || last.at === null) return PASS;
  let awtDir = null;
  try { if (env.AWT_DIR && statSync(env.AWT_DIR).isDirectory()) awtDir = env.AWT_DIR; } catch {}
  atomicWrite(file, JSON.stringify({
    sessionId: input.session_id ?? null, transcriptPath: input.transcript_path, cwd: input.cwd ?? null, awtDir,
    lastAssistantAt: last.at, lastAssistantUuid: last.uuid, contextTokens: last.contextTokens, model: last.model,
    ttlObserved: ttlObserved ?? num(prev?.ttlObserved), writtenAt: nowMs(env),
  }));
  return PASS;
}

/** True when `awt resume --hook --framed` prints anything within 3 s. */
const awtBrief = (env) => new Promise((done) => {
  try {
    const p = execFile("awt", ["resume", "--hook", "--framed"], { env: { ...env, AWT_NO_BRIEF: "1" }, timeout: 3000, killSignal: "SIGKILL", encoding: "utf8" }, (err, out) => done(!err && String(out).trim() !== ""));
    p.stdin?.end();
  } catch { done(false); }
});

/** R30 */
async function preCompact(_input, env, cfg, home) {
  if (!cfg.precompact) return PASS;
  let text = null, kind = "";
  if (env.AWT_DIR && (await awtBrief(env))) { text = AWT_NOTE; kind = "awt"; }
  else {
    const at = num(readJson(join(home, "pending", `${safeName(env.PASEO_AGENT_ID)}.json`))?.at);
    if (at !== null && nowMs(env) - at < 10 * 60 * 1000) { text = GENERIC_NOTE; kind = "generic"; }
  }
  if (text === null) return PASS;
  if (cfg.precompactExtra) text += "\n" + cfg.precompactExtra;
  record(home, { agent: env.PASEO_AGENT_ID, event: "precompact", reason: kind }, { now: nowMs(env), log: quiet });
  return { code: 0, stdout: text.slice(0, 2000), stderr: "" };
}

const fmtTtl = (s) => (s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`);
const fmtIdle = (s) => { const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`; };
const kfmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const usd = (n) => `~$${n.toFixed(2)}`;

/** R33. Every figure is computed; at most 600 characters. Without a known model the `~$` figures are left out. */
export function blockMessage({ idleS, ttlS, tokens, model, cfg, prompt }) {
  const p = priceFor(model, cfg);
  const resend = p ? `: ${usd((tokens * p[ttlS <= 300 ? "write5m" : "write1h"]) / 1e6)} (estimate, API-equivalent; on a subscription this is plan usage).` : ".";
  const compact = p ? `${usd((tokens * p.input + 2000 * p.output) / 1e6)} once (estimate), then` : "first, then";
  const lines = [
    `pcic: this agent's prompt cache has likely expired (idle ${fmtIdle(idleS)}; cache lasts ${fmtTtl(ttlS)}). Context ~${kfmt(tokens)} tokens.`,
    `Sending now rewrites the whole context${resend}`,
    "- Send the same message again to continue with the full context. pcic will not stop you again until the next idle gap.",
    `- Or send /compact ${p ? "first: " : ""}${compact} the context is about ${kfmt(Math.min(tokens, 15000))} tokens.`,
    "- Or send /clear: start empty; the awt brief is added back when AWT_DIR is set.",
  ];
  const base = lines.join("\n");
  const flat = String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const withEcho = flat ? `${base}\nYour message: "${flat}"` : base;
  return (withEcho.length <= 600 ? withEcho : base).slice(0, 600);
}

/** R31, R32 */
async function guard(input, env, cfg, home) {
  if (!cfg.guard) return PASS;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (/^\s*\//.test(prompt) || prompt.startsWith("[pcic") || prompt.includes("<paseo-system")) return PASS;
  if (typeof input.transcript_path !== "string" || typeof input.session_id !== "string") return PASS;
  const { last, ttlObserved, boundary } = await readTail(input.transcript_path);
  if (!last || last.at === null || !last.uuid) return PASS;
  const ttlS = Math.min(cfg.ttlSeconds, ttlObserved ?? Infinity);
  const now = nowMs(env);
  if (!(now - last.at > ttlS * 1000)) return PASS;
  if (boundary && boundary.at > last.at) return PASS;
  const tokens = num(last.contextTokens);
  if (tokens === null || tokens < cfg.minContextTokens) return PASS;
  const dir = join(home, "guard"), sid = safeName(input.session_id), marker = join(dir, `${sid}.json`);
  const claim = `${sid}.${safeName(last.uuid)}.claim`;
  const agent = env.PASEO_AGENT_ID;
  if (readJson(marker)?.lastAssistantUuid === last.uuid) { record(home, { agent, event: "guard_pass_marker" }, { now, log: quiet }); return PASS; }
  // The O_EXCL claim decides who blocks, so parallel prompts cannot both block. A lost race passes.
  if (!createExcl(join(dir, claim))) return PASS;
  atomicWrite(marker, JSON.stringify({ lastAssistantUuid: last.uuid, at: now }));
  try { for (const f of readdirSync(dir)) if (f.startsWith(sid + ".") && f.endsWith(".claim") && f !== claim) rmSync(join(dir, f), { force: true }); } catch {}
  record(home, { agent, event: "guard_block", tokens }, { now, log: quiet });
  return { code: 2, stdout: "", stderr: blockMessage({ idleS: Math.floor((now - last.at) / 1000), ttlS, tokens, model: last.model, cfg, prompt }) + "\n" };
}

const HANDLERS = { Stop: stop, PreCompact: preCompact, UserPromptSubmit: guard };

/** Returns {code, stdout, stderr}. Never throws. The guard gives up after 1.5 s (R34). */
export async function run(event, input, env = process.env) {
  try {
    const h = HANDLERS[event];
    if (!h || !hookActive(env)) return PASS;
    const cfg = loadConfig(env);
    if (!cfg.enabled) return PASS;
    const work = h(input && typeof input === "object" ? input : {}, env, cfg, pcicHome(env)).catch(() => PASS);
    if (event !== "UserPromptSubmit") return await work;
    return await Promise.race([work, new Promise((r) => setTimeout(() => r(PASS), 1500).unref())]);
  } catch { return PASS; }
}

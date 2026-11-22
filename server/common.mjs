// Shared by the hook script and the plugin: state dir, config, atomic writes, history. Plain Node, no dependencies.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A file-name-safe form of an id (session ids, uuids). */
export const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

/** R5: a number is trusted only when finite and not negative. */
export const num = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);

export const pcicHome = (env = process.env) => env.PCIC_HOME || join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "pcic");
/** Time source: PCIC_NOW (ms or ISO) lets tests fake the clock for the hook. */
export const nowMs = (env = process.env) => {
  if (env.PCIC_NOW) { const v = /^\d+$/.test(env.PCIC_NOW) ? Number(env.PCIC_NOW) : Date.parse(env.PCIC_NOW); if (Number.isFinite(v)) return v; }
  return Date.now();
};
/** R3: the hook acts only for Paseo-launched agents that are not opted out. */
export const hookActive = (env = process.env) => !!env.PASEO_AGENT_ID && env.PCIC_OFF !== "1";

const int = (min) => (v) => typeof v === "number" && Number.isInteger(v) && v >= min;
const bool = (v) => typeof v === "boolean";
const str = (v) => typeof v === "string";
export const SCHEMA = {
  enabled: [true, bool], ttlSeconds: [3600, int(60)], idleSeconds: [null, int(1)], lateGraceSeconds: [180, int(0)],
  minContextTokens: [100000, int(0)], guard: [true, bool], checkpoint: ["awt", (v) => v === "awt" || v === "off"],
  precompact: [true, bool], precompactExtra: ["", str], includeSubagents: [false, bool],
  exclude: [[], (v) => Array.isArray(v) && v.every(str)], maxConcurrent: [2, int(1)], staggerSeconds: [15, int(0)],
  maxJobsPerHour: [30, int(0)], checkpointTimeoutSeconds: [300, int(1)], compactTimeoutSeconds: [300, int(1)],
  pauseMinutes: [60, int(1)], sweepSeconds: [30, int(1)], sendMode: ["auto", (v) => ["auto", "plugin", "cli"].includes(v)],
  paseoBin: ["paseo", (v) => str(v) && v.length > 0],
  coldChoice: ["ask", (v) => v === "ask" || v === "resume" || v === "checkpoint"], freshContextTokens: [20000, int(0)], markerSeconds: [600, int(0)],
  // $/M tokens per model family, from the Anthropic pricing page (18-Nov-2026). Matched by regex on the model id, first hit wins.
  prices: [null, (v) => v === null || (typeof v === "object" && !Array.isArray(v))],
};
/** Family prices: [regex source, {input, write5m, write1h, read, output}]. Haiku 5.5 is the tier for prompts up to 100K. */
export const PRICES = [
  ["fable-5-2|mythos-5-2", [8, 10, 16, 0.2, 40]], ["fable-5|mythos-5", [10, 12.5, 20, 1, 50]],
  ["opus-5-5", [4, 5, 8, 0.2, 20]], ["opus-(4-[5-9]|5)", [5, 6.25, 10, 0.5, 25]], ["opus-4", [15, 18.75, 30, 1.5, 75]],
  ["sonnet-5", [2, 2.5, 4, 0.1, 10]], ["sonnet-4", [3, 3.75, 6, 0.3, 15]],
  ["haiku-5", [0.1, 0.125, 0.2, 0.01, 0.5]], ["haiku-4", [1, 1.25, 2, 0.1, 5]],
].map(([re, [input, write5m, write1h, read, output]]) => [new RegExp(re), { input, write5m, write1h, read, output }]);

/**
 * R43: defaults, per-key fallback with one warning each, unknown keys warned, unparseable file means all defaults.
 * @returns {Record<string, any>}
 */
export function loadConfig(env = process.env, warn = (_m) => {}) {
  const cfg = {};
  for (const [k, [d]] of Object.entries(SCHEMA)) cfg[k] = d;
  let raw = null;
  try { raw = readFileSync(join(pcicHome(env), "config.json"), "utf8"); } catch (e) { if (e?.code !== "ENOENT") warn("config.json unreadable"); }
  let user = {};
  if (raw !== null) {
    try { user = JSON.parse(raw); if (!user || typeof user !== "object" || Array.isArray(user)) throw 0; } catch { user = {}; warn("config.json is not a JSON object; using defaults"); }
  }
  for (const [k, v] of Object.entries(user)) {
    if (!(k in SCHEMA)) warn(`unknown config key ${k}`);
    else if (SCHEMA[k][1](v)) cfg[k] = v;
    else warn(`invalid config value for ${k}; using the default`);
  }
  if (cfg.idleSeconds === null) cfg.idleSeconds = Math.max(1, cfg.ttlSeconds - 300);
  return cfg;
}

export function priceFor(model, cfg) {
  if (typeof model !== "string") return null;
  const own = cfg?.prices && Object.entries(cfg.prices).find(([k]) => model.includes(k));
  if (own) return own[1];
  const hit = PRICES.find(([re]) => re.test(model));
  return hit ? hit[1] : null;
}

/** Temp file in the same directory, then rename. */
export function atomicWrite(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}
export const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
/** O_EXCL create. Returns true when created, false when it exists; throws on any other failure. */
export function createExcl(path) {
  mkdirSync(dirname(path), { recursive: true });
  try { closeSync(openSync(path, "wx")); return true; } catch (e) { if (e?.code === "EEXIST") return false; throw e; }
}

const FIELDS = ["agent", "event", "reason", "tokens", "pre", "post", "mode", "ms", "choice", "always"];
const failed = new Set();
/** R40: one JSON line per event, whitelisted fields only (no prompt, reply, path or cwd), rotated at 5 MB. A failure is logged once and changes nothing. */
export function record(home, ev, { now = Date.now(), log = (m) => { process.stderr.write(m + "\n"); } } = {}) {
  try {
    const line = { v: 1, at: new Date(now).toISOString() };
    for (const f of FIELDS) if (ev[f] !== undefined && ev[f] !== null) line[f] = f === "agent" || f === "event" || f === "reason" || f === "mode" || f === "choice" ? String(ev[f]).slice(0, 200) : f === "always" ? !!ev[f] : ev[f];
    const p = join(home, "history.jsonl");
    mkdirSync(home, { recursive: true });
    try { if (statSync(p).size > 5 * 1024 * 1024) renameSync(p, p + ".1"); } catch (e) { if (e?.code !== "ENOENT") throw e; }
    appendFileSync(p, JSON.stringify(line) + "\n");
  } catch (e) {
    const k = e?.code || "error";
    if (!failed.has(k)) { failed.add(k); try { log(`pcic: history write failed (${k})`); } catch {} }
  }
}

/** R50: set one validated config key, keeping the other keys. Returns an error text, or null when written. */
export function setConfigKey(env, key, value) {
  if (!(key in SCHEMA)) return `unknown config key ${key}`;
  if (!SCHEMA[key][1](value)) return `invalid value for ${key}`;
  const file = join(pcicHome(env), "config.json");
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(file, "utf8"));
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return "config.json is not a JSON object; fix it by hand first";
  } catch (e) { if (e?.code !== "ENOENT") return "config.json is not valid JSON; fix it by hand first"; }
  atomicWrite(file, JSON.stringify({ ...cur, [key]: value }, null, 2) + "\n");
  return null;
}

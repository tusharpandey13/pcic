#!/usr/bin/env node
// pcic CLI: install [--uninstall] | doctor | hook <event>
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, pcicHome, readJson } from "../shared/common.mjs";
import { run } from "../hook/pcic-hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARK = "pcic:hook";
const AWT_MARK = "awt:context";
const EVENTS = ["UserPromptSubmit", "Stop", "PreCompact", "SessionStart"];
const settingsPath = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "settings.json");
const q = (s) => JSON.stringify(s);

/** The four entries (R28, D5). SessionStart prints the awt brief after /clear, and only when AWT_DIR is set. */
export function entries() {
  const cmd = (ev) => `${q(process.execPath)} ${q(join(HERE, "pcic.mjs"))} hook ${ev} # ${MARK}`;
  return {
    UserPromptSubmit: { hooks: [{ type: "command", timeout: 5, command: cmd("UserPromptSubmit") }] },
    Stop: { hooks: [{ type: "command", timeout: 5, command: cmd("Stop") }] },
    PreCompact: { hooks: [{ type: "command", timeout: 10, command: cmd("PreCompact") }] },
    SessionStart: { matcher: "clear", hooks: [{ type: "command", timeout: 10, command: `[ -z "$AWT_DIR" ] || awt resume --hook --framed # ${MARK}` }] },
  };
}

const ours = (h) => h && typeof h === "object" && String(h.command ?? "").includes(MARK);
/** True when another tool (newer awt) already prints the awt brief after /clear: pcic's own clear entry would inject it twice. */
export const awtClearHook = (sessionStart) => Array.isArray(sessionStart) && sessionStart.some((e) => e && String(e.matcher ?? "").split("|").includes("clear") && Array.isArray(e.hooks) && e.hooks.some((h) => h && !ours(h) && /\bawt resume\b/.test(String(h.command ?? ""))));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (msg, fix) => { process.stderr.write(`error: ${msg}\nfix: ${fix}\n`); process.exit(1); };

/** Merge or remove pcic's entries. Returns {res, backup}. Same contract as `awt init --hooks`: never overwrite, idempotent, backup, symlink followed. */
export function mergeSettings(file, uninstall) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let path = file, raw = null, sig = null;
    try { path = realpathSync(file); raw = readFileSync(path, "utf8"); const s = statSync(path); sig = [s.mtimeMs, s.size]; } catch (e) { if (e?.code !== "ENOENT") throw e; }
    let st = {};
    if (raw !== null && raw.trim() !== "") {
      try { st = JSON.parse(raw); } catch { fail(`${path} is not valid JSON; pcic will not touch it`, "fix the file by hand, then run this again"); }
      if (!st || typeof st !== "object" || Array.isArray(st) || (st.hooks !== undefined && (typeof st.hooks !== "object" || st.hooks === null || Array.isArray(st.hooks)))) fail(`${path} has an unexpected shape; pcic will not touch it`, "make the file a JSON object with hooks as an object, then run this again");
    }
    const before = JSON.stringify(st);
    const hooks = (st.hooks ??= {});
    const awtClear = awtClearHook(hooks.SessionStart);
    for (const [ev, want] of Object.entries(entries())) {
      const drop = uninstall || (ev === "SessionStart" && awtClear);
      if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) fail(`${path} has hooks.${ev} that is not a list; pcic will not touch it`, `make hooks.${ev} a list, then run this again`);
      const list = (hooks[ev] ??= []);
      const mine = list.flatMap((e) => (e && Array.isArray(e.hooks) ? e.hooks.filter(ours) : []));
      const exact = !drop && mine.length === 1 && list.some((e) => e?.matcher === want.matcher && Array.isArray(e.hooks) && e.hooks.some((h) => same(h, want.hooks[0])));
      if (!exact) {
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i];
          if (e && Array.isArray(e.hooks) && e.hooks.some(ours)) { e.hooks = e.hooks.filter((h) => !ours(h)); if (!e.hooks.length) list.splice(i, 1); }
        }
        if (!drop) list.push(want);
      }
      if (!list.length) delete hooks[ev];
    }
    if (!Object.keys(hooks).length) delete st.hooks;
    if (JSON.stringify(st) === before && (raw !== null || uninstall)) return { res: raw === null ? "absent" : "unchanged", awtClear };
    let backup;
    if (raw !== null) {
      backup = `${path}.pcic-bak-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}-${process.pid}`;
      copyFileSync(path, backup);
      for (const old of readdirSync(dirname(path)).filter((x) => x.startsWith(basename(path) + ".pcic-bak-")).sort().slice(0, -5)) rmSync(join(dirname(path), old), { force: true });
    }
    let moved = false;
    try { const s = statSync(path); moved = !sig || s.mtimeMs !== sig[0] || s.size !== sig[1]; } catch { moved = sig !== null; }
    if (moved) continue; // something else wrote the file since we read it
    mkdirSync(dirname(path), { recursive: true });
    const mode = raw !== null ? statSync(path).mode & 0o777 : 0o600;
    const tmp = `${path}.pcic-tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n", { mode });
    renameSync(tmp, path);
    return { res: uninstall ? "removed" : raw === null ? "installed" : "updated", backup, awtClear };
  }
  fail(`${file} keeps changing while pcic reads it`, "close the running Claude Code sessions, then run this again");
}

function install(uninstall) {
  const file = settingsPath();
  const { res, backup, awtClear } = mergeSettings(file, uninstall);
  const evs = awtClear && !uninstall ? EVENTS.filter((e) => e !== "SessionStart") : EVENTS;
  const what = res === "unchanged" || res === "absent" ? "nothing changed" : `${uninstall ? "removed" : "added"} ${evs.length} entries (${evs.join(", ")})`;
  console.log(`hooks: ${res}, ${what}: ${file}${backup ? `\nbackup: ${backup}` : ""}${awtClear && !uninstall ? "\nSessionStart clear brief provided by awt; pcic adds none" : ""}`);
}

function doctor(env = process.env) {
  const problems = [];
  const ok = (m) => console.log(`ok   ${m}`);
  const bad = (m, fix) => { problems.push(m); console.log(`warn ${m}${fix ? `\n     fix: ${fix}` : ""}`); };
  const file = settingsPath(env);
  const st = readJson(file);
  const list = (ev) => (Array.isArray(st?.hooks?.[ev]) ? st.hooks[ev].flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : [])) : []);
  const awtClear = awtClearHook(st?.hooks?.SessionStart);
  const missing = EVENTS.filter((ev) => !(ev === "SessionStart" && awtClear) && !list(ev).some(ours));
  missing.length ? bad(`pcic hook entries missing: ${missing.join(", ")}`, "pcic install") : ok(`pcic hooks installed (${awtClear ? 3 : 4} entries)`);
  if (awtClear) ok("SessionStart clear brief provided by awt");
  list("SessionStart").some((h) => String(h.command ?? "").includes(AWT_MARK)) ? ok("awt compact hook present") : bad("awt's SessionStart compact hook is not installed; the awt brief would be missing after compaction", "awt init --hooks claude");
  env.AWT_COMPACT_BRIEF === "1" ? bad("AWT_COMPACT_BRIEF=1 is set; the brief would arrive twice", "unset AWT_COMPACT_BRIEF in the daemon environment") : ok("AWT_COMPACT_BRIEF not set");
  const home = pcicHome(env);
  const v = existsSync(join(home, "verdict.json")) ? readJson(join(home, "verdict.json")) : undefined;
  v === undefined || (v && ["plugin", "cli"].includes(v.mode) && typeof v.paseoVersion === "string") ? ok("verdict ok") : bad("verdict.json is invalid", `delete ${join(home, "verdict.json")}`);
  const p = existsSync(join(home, "pause.json")) ? readJson(join(home, "pause.json")) : undefined;
  p === undefined || (p && Number.isFinite(p.until)) ? ok("pause state ok") : bad("pause.json is invalid", `delete ${join(home, "pause.json")}`);
  const warns = [];
  loadConfig(env, (m) => warns.push(m));
  warns.length ? bad(`config: ${warns.join("; ")}`, `edit ${join(home, "config.json")}`) : ok("config valid");
  let dir = home;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try { accessSync(dir, constants.W_OK); ok("PCIC_HOME writable"); } catch { bad(`${home} is not writable`, "fix the permissions or set PCIC_HOME"); }
  process.exit(problems.length ? 1 : 0);
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  const done = new Promise((r) => { process.stdin.on("data", (c) => chunks.push(c)); process.stdin.on("end", r); process.stdin.on("error", r); });
  await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "hook") {
  const r = await run(args[0], await readStdin(), process.env);
  if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
  if (r.stderr) process.stderr.write(r.stderr);
  process.stdout.write("", () => process.exit(r.code));
} else if (cmd === "install") install(args.includes("--uninstall"));
else if (cmd === "doctor") doctor();
else { console.error("usage: pcic install [--uninstall] | doctor | hook <event>"); process.exit(2); }

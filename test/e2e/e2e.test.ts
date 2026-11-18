// Tier E (live, isolated, paid). Gated: PCIC_E2E=1 starts an isolated Paseo daemon in a temp home (never ~/.paseo);
// PCIC_E2E_PAID=1 additionally allows cases that spend model tokens. Run only with the owner's approval (E2E-RUBRIC.md).
// Only E1 and E2 are written so far; E3..E17 are listed as skipped, never as passed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ON = process.env.PCIC_E2E === "1", PAID = process.env.PCIC_E2E_PAID === "1";
const REPO = resolve(import.meta.dirname, "..", "..");
let tmp = "", home = "", pcic = "", claude = "", env: NodeJS.ProcessEnv = {};

const paseo = (...a: string[]) => execFileSync("paseo", ["--home", home, ...a], { env, encoding: "utf8", timeout: 120_000 });
const free = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

before(async () => {
  if (!ON) return;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pcice-")));
  home = join(tmp, "paseo"); pcic = join(tmp, "pcic"); claude = join(tmp, "claude"); mkdirSync(home); mkdirSync(claude);
  env = { ...process.env, HOME: tmp, PCIC_HOME: pcic, CLAUDE_CONFIG_DIR: claude };
  for (const k of Object.keys(env)) if (k.startsWith("PASEO_")) delete env[k];
  mkdirSync(pcic);
  writeFileSync(join(pcic, "config.json"), JSON.stringify({ ttlSeconds: 240, idleSeconds: 120, lateGraceSeconds: 30, minContextTokens: 30000, sweepSeconds: 5, staggerSeconds: 5, checkpointTimeoutSeconds: 120, compactTimeoutSeconds: 120, precompactExtra: "Include the literal token ZQX-PRECOMPACT-7 in the summary." }));
  const port = await free();
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { injectIntoAgents: false } }, features: { dictation: { enabled: false } } }));
  paseo("daemon", "start", "--timeout", "90");
  paseo("plugin", "install", REPO);
  paseo("daemon", "restart");
});
function cleanup() {
  if (!tmp) return;
  try { paseo("daemon", "stop"); } catch { try { const f = join(home, "paseo.pid"); if (existsSync(f)) process.kill(Number(/"?pid"?\D*(\d+)/.exec(readFileSync(f, "utf8"))?.[1])); } catch {} }
  rmSync(tmp, { recursive: true, force: true }); tmp = "";
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { cleanup(); process.exit(1); });
after(cleanup);

test("E1 install and doctor against the temp env (the $0 half)", { skip: !ON }, () => {
  execFileSync("node", [join(REPO, "bin", "pcic.mjs"), "install"], { env, encoding: "utf8" });
  const st = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
  st.hooks.SessionStart.push({ matcher: "compact", hooks: [{ type: "command", command: "awt resume --hook --framed # awt:context" }] }); // stand-in for `awt init --hooks claude`
  writeFileSync(join(claude, "settings.json"), JSON.stringify(st));
  execFileSync("node", [join(REPO, "bin", "pcic.mjs"), "doctor"], { env, encoding: "utf8" }); // exits 1 on any problem
});
test("E2 the self-test records a plugin verdict and archives its probe (paid, about $0.01)", { skip: !(ON && PAID) }, async () => {
  const v = join(pcic, "verdict.json");
  for (let i = 0; i < 45 && !existsSync(v); i++) await new Promise((r) => setTimeout(r, 2000));
  assert.ok(existsSync(v), "no verdict within 90 s"); assert.equal(JSON.parse(readFileSync(v, "utf8")).mode, "plugin");
  assert.ok(readdirSync(pcic).includes("history.jsonl"));
});
for (const id of ["E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12", "E13", "E14", "E15", "E16", "E17"]) test(`${id} (not written yet: see E2E-RUBRIC.md)`, { skip: "not implemented in 0.1.0" }, () => {});

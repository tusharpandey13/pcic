import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, listing, readJsonFile, tmp, writeConfig, type Tmp } from "./harness.js";

const settings = (t: Tmp) => join(t.claude, "settings.json");
const EVENTS = ["UserPromptSubmit", "Stop", "PreCompact", "SessionStart"];
const mine = (st: any) => EVENTS.flatMap((e) => (st.hooks?.[e] ?? []).flatMap((x: any) => x.hooks.filter((h: any) => h.command.includes("# pcic:hook"))));
const backups = (t: Tmp) => readdirSync(t.claude).filter((f) => f.includes(".pcic-bak-"));

// T23 (R28)
test("T23 install into no file creates it with four marked entries; a second install changes nothing and makes no backup", async () => {
  const t = tmp(); const r = await cli(["install"], t.env); assert.equal(r.code, 0); assert.match(r.stdout, /installed/);
  const st = readJsonFile(settings(t)); assert.equal(mine(st).length, 4);
  assert.equal(st.hooks.SessionStart[0].matcher, "clear"); assert.match(st.hooks.SessionStart[0].hooks[0].command, /^\[ -z "\$AWT_DIR" \] \|\| awt resume --hook --framed # pcic:hook$/);
  assert.match(st.hooks.Stop[0].hooks[0].command, /hook Stop # pcic:hook$/);
  const again = await cli(["install"], t.env); assert.match(again.stdout, /unchanged, nothing changed/); assert.deepEqual(backups(t), []); assert.deepEqual(readJsonFile(settings(t)), st);
  assert.equal(statSync(settings(t)).mode & 0o777, 0o600); t.cleanup();
});
test("T23 an existing file with other hooks keeps them, gets a backup, and uninstall restores the original shape", async () => {
  const t = tmp(); const orig = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }], SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: "awt resume --hook --framed # awt:context" }] }] } };
  writeFileSync(settings(t), JSON.stringify(orig, null, 2)); chmodSync(settings(t), 0o640);
  const r = await cli(["install"], t.env); assert.match(r.stdout, /backup: /); assert.equal(backups(t).length, 1);
  const st = readJsonFile(settings(t)); assert.equal(st.model, "x"); assert.equal(st.hooks.Stop[0].hooks[0].command, "echo mine"); assert.equal(st.hooks.SessionStart[0].matcher, "compact"); assert.equal(mine(st).length, 4); assert.equal(statSync(settings(t)).mode & 0o777, 0o640);
  await cli(["install", "--uninstall"], t.env); assert.deepEqual(readJsonFile(settings(t)), orig);
  const second = await cli(["install", "--uninstall"], t.env); assert.match(second.stdout, /nothing changed/); t.cleanup();
});
test("T23 uninstall leaves no empty arrays or hooks object", async () => {
  const t = tmp(); await cli(["install"], t.env); await cli(["install", "--uninstall"], t.env); assert.deepEqual(readJsonFile(settings(t)), {}); t.cleanup();
});
test("T23 a symlinked settings file is followed: the link stays, the target changes", async () => {
  const t = tmp(); const real = join(t.dir, "dotfiles-settings.json"); writeFileSync(real, "{}\n"); symlinkSync(real, settings(t));
  await cli(["install"], t.env); assert.ok(lstatSync(settings(t)).isSymbolicLink()); assert.equal(mine(readJsonFile(real)).length, 4); t.cleanup();
});
test("T23 a non-JSON file is refused and left untouched", async () => {
  const t = tmp(); writeFileSync(settings(t), "{ not json"); const r = await cli(["install"], t.env);
  assert.equal(r.code, 1); assert.match(r.stderr, /not valid JSON/); assert.match(r.stderr, /fix:/); assert.equal(readFileSync(settings(t), "utf8"), "{ not json"); assert.deepEqual(backups(t), []); t.cleanup();
});
test("T23 CLAUDE_CONFIG_DIR picks the file; HOME's ~/.claude is not touched", async () => {
  const t = tmp(); const other = join(t.dir, "alt"); const r = await cli(["install"], { ...t.env, CLAUDE_CONFIG_DIR: other }); assert.equal(r.code, 0);
  assert.ok(existsSync(join(other, "settings.json"))); assert.ok(!existsSync(join(t.dir, ".claude"))); t.cleanup();
});
test("T23 a shape it does not understand is refused", async () => {
  const t = tmp(); writeFileSync(settings(t), JSON.stringify({ hooks: { Stop: "oops" } })); const r = await cli(["install"], t.env); assert.equal(r.code, 1); assert.match(r.stderr, /not a list/); t.cleanup();
});

// T34 (R41)
const okEnv = async (t: Tmp) => { await cli(["install"], t.env); const st = readJsonFile(settings(t)); st.hooks.SessionStart.push({ matcher: "compact", hooks: [{ type: "command", command: "awt resume --hook --framed # awt:context" }] }); writeFileSync(settings(t), JSON.stringify(st)); };
test("T34 doctor: everything ok exits 0 and changes nothing", async () => {
  const t = tmp(); await okEnv(t); const before = listing(t.dir).map((f) => [f, statSync(f).mtimeMs]);
  const r = await cli(["doctor"], t.env); assert.equal(r.code, 0, r.stdout); assert.deepEqual(listing(t.dir).map((f) => [f, statSync(f).mtimeMs]), before); t.cleanup();
});
test("T34 doctor names each failing check and exits 1", async () => {
  const t = tmp(); let r = await cli(["doctor"], t.env); assert.equal(r.code, 1); assert.match(r.stdout, /pcic hook entries missing: UserPromptSubmit, Stop, PreCompact, SessionStart/); assert.match(r.stdout, /fix: pcic install/); assert.match(r.stdout, /awt's SessionStart compact hook is not installed/);
  await okEnv(t); r = await cli(["doctor"], { ...t.env, AWT_COMPACT_BRIEF: "1" }); assert.equal(r.code, 1); assert.match(r.stdout, /AWT_COMPACT_BRIEF=1/);
  mkdirSync(t.home, { recursive: true }); writeFileSync(join(t.home, "verdict.json"), "{bad"); r = await cli(["doctor"], t.env); assert.match(r.stdout, /verdict\.json is invalid/); writeFileSync(join(t.home, "verdict.json"), JSON.stringify({ paseoVersion: "0.16.1", mode: "plugin" }));
  writeFileSync(join(t.home, "pause.json"), "[]"); r = await cli(["doctor"], t.env); assert.match(r.stdout, /pause\.json is invalid/); writeFileSync(join(t.home, "pause.json"), JSON.stringify({ until: 5 }));
  writeConfig(t, { guard: "x" }); r = await cli(["doctor"], t.env); assert.match(r.stdout, /config: invalid config value for guard/); writeConfig(t, {});
  chmodSync(t.home, 0o500); r = await cli(["doctor"], t.env); assert.match(r.stdout, /not writable/); chmodSync(t.home, 0o700);
  r = await cli(["doctor"], t.env); assert.equal(r.code, 0, r.stdout); t.cleanup();
});
// T23/T34 (R28, D5): awt's own SessionStart clear hook makes pcic's redundant
const awtClear = { matcher: "clear", hooks: [{ type: "command", command: "awt resume --hook --framed # awt:context" }] };
test("T23 an existing SessionStart clear hook that runs awt resume: pcic adds no clear entry of its own and removes a stale one; doctor says provided by awt", async () => {
  const t = tmp(); await cli(["install"], t.env); const st = readJsonFile(settings(t));
  st.hooks.SessionStart.push(awtClear, { matcher: "compact", hooks: [{ type: "command", command: "awt resume --hook --framed # awt:context" }] }); writeFileSync(settings(t), JSON.stringify(st));
  const r = await cli(["install"], t.env); assert.equal(r.code, 0); assert.match(r.stdout, /provided by awt/);
  const after = readJsonFile(settings(t)); assert.equal(mine(after).length, 3); assert.deepEqual(after.hooks.SessionStart.filter((e: any) => e.matcher === "clear"), [awtClear]);
  const again = await cli(["install"], t.env); assert.match(again.stdout, /unchanged/);
  const d = await cli(["doctor"], t.env); assert.equal(d.code, 0, d.stdout); assert.match(d.stdout, /SessionStart clear brief provided by awt/);
  await cli(["install", "--uninstall"], t.env); const un = readJsonFile(settings(t)); assert.equal(mine(un).length, 0); assert.deepEqual(un.hooks.SessionStart.filter((e: any) => e.matcher === "clear"), [awtClear]); t.cleanup();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { asst, fakeBin, hook, historyOf, readJsonFile, T0, tmp, transcript, writeConfig, MIN, type Tmp } from "./harness.js";
import { cardLine } from "../server/card.mjs";
import { parseCardLine } from "../shared/cold-card.js";

const NOW = T0 + 2 * 3600e3 + 14 * MIN;
const run = (t: Tmp, p: string, prompt: string, extra: Record<string, string> = {}, sid = "sid1") => hook("UserPromptSubmit", { session_id: sid, transcript_path: p, prompt }, { ...t.env, PCIC_NOW: String(NOW), ...extra });
const cold = (t: Tmp, o = {}) => transcript(t, [asst({ at: T0, tokens: 182000, uuid: "a1", ...o })]);
const cardsOf = (t: Tmp) => { try { return readdirSync(join(t.home, "cards")).filter((f) => f.endsWith(".json")); } catch { return []; } };

// T37 (R44)
test("T37 a block writes cards/<id>.json (mode 0600, fields) and ends the text with the tag line", async () => {
  const t = tmp(); const r = await run(t, cold(t), "ZQX-PROMPT continue with the parser");
  assert.equal(r.code, 2); const files = cardsOf(t); assert.equal(files.length, 1);
  const f = join(t.home, "cards", files[0]); assert.equal(statSync(f).mode & 0o777, 0o600);
  const c = readJsonFile(f);
  assert.match(c.cardId, /^[0-9a-f]{16}$/); assert.equal(files[0], `${c.cardId}.json`);
  assert.deepEqual([c.v, c.agentId, c.sessionId, c.lastAssistantUuid, c.prompt, c.createdAt, c.model, c.tokens, c.idleMs, c.awt, c.auto], [1, "agt_0001", "sid1", "a1", "ZQX-PROMPT continue with the parser", NOW, "claude-opus-4-8", 182000, 8040000, false, false]);
  assert.equal(c.est.resume, 1.82); assert.equal(c.est.compact, 0.96);
  assert.ok(c.est.checkpoint > 0.2 && c.est.checkpoint < 0.3, String(c.est.checkpoint)); // (20000 + 0 + 9) x $10/M
  const last = r.stderr.trimEnd().split("\n").pop() as string;
  assert.equal(last, cardLine(c)); assert.ok(r.stderr.trimEnd().length <= 600, String(r.stderr.length));
  assert.match(r.stderr, /pcic: this agent's prompt cache has likely expired/); // the text stays readable
  const tag = parseCardLine(last); assert.deepEqual([tag?.cardId, tag?.idleMs, tag?.tokens, tag?.resume, tag?.awt, tag?.auto], [c.cardId, 8040000, 182000, 1.82, false, false]);
  t.cleanup();
});
test("T37 unknown model: dollar fields are - and the card has null estimates", async () => {
  const t = tmp(); const r = await run(t, cold(t, { model: "mystery-model-9" }), "ZQX-PROMPT x"); assert.equal(r.code, 2);
  const last = r.stderr.trimEnd().split("\n").pop() as string; assert.match(last, /resume=- compact=- checkpoint=- awt=0\]$/);
  assert.deepEqual(readJsonFile(join(t.home, "cards", cardsOf(t)[0])).est, { resume: null, compact: null, checkpoint: null });
  assert.equal(parseCardLine(last)?.resume, null); t.cleanup();
});
test("T37 a long prompt: the text with the tag stays within 600 characters, the card holds the whole prompt", async () => {
  const t = tmp(); const long = "ZQX-PROMPT " + "w".repeat(3000); const r = await run(t, cold(t), long);
  assert.ok(r.stderr.trimEnd().length <= 600); assert.equal(readJsonFile(join(t.home, "cards", cardsOf(t)[0])).prompt, long);
  assert.ok(!r.stderr.includes("w".repeat(100))); t.cleanup();
});
test("T37 the prompt appears only in the card file, never in history", async () => {
  const t = tmp(); await run(t, cold(t), "ZQX-PROMPT secret words");
  assert.ok(!readFileSync(join(t.home, "history.jsonl"), "utf8").includes("ZQX-PROMPT"));
  const hit = readdirSync(t.home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).filter((f) => readFileSync(f, "utf8").includes("ZQX-PROMPT"));
  assert.deepEqual(hit.map((f) => f.slice(t.home.length)), [`/cards/${cardsOf(t)[0]}`]); t.cleanup();
});
test("T37 a card that cannot be written leaves a plain block without a tag", async () => {
  const t = tmp(); writeConfig(t, {}); const { writeFileSync, mkdirSync } = await import("node:fs"); mkdirSync(t.home, { recursive: true }); writeFileSync(join(t.home, "cards"), "x"); // a file where the dir should be
  const r = await run(t, cold(t), "ZQX-PROMPT go"); assert.equal(r.code, 2); assert.ok(!r.stderr.includes("[pcic-card")); assert.match(r.stderr, /Send the same message again/); t.cleanup();
});
test("T37 the awt flag follows AWT_DIR; the checkpoint estimate adds the brief (measured, else 2,000 tokens)", async () => {
  const node = dirname(process.execPath);
  const t = tmp({ AWT_DIR: "/nonexistent", PATH: node }); const r = await run(t, cold(t), "x"); assert.equal(readJsonFile(join(t.home, "cards", cardsOf(t)[0])).awt, false); assert.match(r.stderr, /awt=0\]$/m);
  const t2 = tmp({ AWT_DIR: tmp().dir, PATH: node }); await run(t2, cold(t2), "x"); const c2 = readJsonFile(join(t2.home, "cards", cardsOf(t2)[0]));
  assert.equal(c2.awt, true); assert.equal(c2.est.checkpoint, 0.22001); // (20000 + 2000 assumed + 1 prompt) tokens x $10/M, rounded to 3 figures
  const t3 = tmp({ AWT_DIR: tmp().dir }); const bin = fakeBin(t3, "awt", "yes bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | head -c 40000"); t3.env.PATH = `${bin}:/usr/bin:/bin`;
  await run(t3, cold(t3), "x"); assert.equal(readJsonFile(join(t3.home, "cards", cardsOf(t3)[0])).est.checkpoint, 0.30001); // 10,000 brief tokens
  t.cleanup(); t2.cleanup(); t3.cleanup();
});

// T41 (R48): the guard side of coldChoice
test("T41 coldChoice resume: the guard passes, logs guard_pass_setting, writes no card and no marker", async () => {
  const t = tmp(); writeConfig(t, { coldChoice: "resume" }); const r = await run(t, cold(t), "ZQX-PROMPT go");
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]); assert.deepEqual(cardsOf(t), []); assert.ok(!existsSync(join(t.home, "guard")));
  assert.deepEqual(historyOf(t).map((h) => [h.event, h.choice]), [["guard_pass_setting", "resume"]]); t.cleanup();
});
test("T41 coldChoice resume still lets the first-block conditions decide: a warm agent passes with no log line", async () => {
  const t = tmp(); writeConfig(t, { coldChoice: "resume" }); const r = await run(t, cold(t, { at: NOW - 5 * MIN }), "x"); assert.equal(r.code, 0); assert.deepEqual(historyOf(t), []); t.cleanup();
});
test("T41 coldChoice checkpoint: the guard blocks once and writes an auto card; the text says pcic continues", async () => {
  const t = tmp(); writeConfig(t, { coldChoice: "checkpoint" }); const p = cold(t); const r = await run(t, p, "ZQX-PROMPT go");
  assert.equal(r.code, 2); const c = readJsonFile(join(t.home, "cards", cardsOf(t)[0])); assert.equal(c.auto, true);
  assert.match(r.stderr, /pcic is continuing from a checkpoint/); assert.match(r.stderr, /auto=1\]\s*$/); assert.ok(r.stderr.trimEnd().length <= 600);
  assert.equal((await run(t, p, "ZQX-PROMPT go")).code, 0); assert.equal(cardsOf(t).length, 1); t.cleanup(); // the marker passes the resend
});
test("T41 the setting is validated: an unknown coldChoice means ask", async () => {
  const t = tmp(); writeConfig(t, { coldChoice: "always" }); const r = await run(t, cold(t), "x"); assert.equal(r.code, 2); assert.match(r.stderr, /Send the same message again/); t.cleanup();
});

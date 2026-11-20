import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { historyOf, idleAgent, readJsonFile, rig, settle, type Rig } from "./harness.js";
import { cardPath, usedPath, writeCard } from "../server/card.mjs";
import { chooseRpc } from "../shared/cold-card.js";

const PROMPT = "ZQX-PROMPT please continue with the parser";
const ID = "agt_0001", CARD = "0123456789abcdef";
const mkCard = (r: Rig, over: Record<string, unknown> = {}) => { const c = { v: 1, cardId: CARD, agentId: ID, sessionId: "sid1", lastAssistantUuid: "a1", prompt: PROMPT, createdAt: r.clock.now(), model: "claude-opus-4-8", tokens: 182000, idleMs: 8040000, awt: true, auto: false, est: { resume: 1.82, compact: 0.96, checkpoint: 0.22 }, ...over }; writeCard(r.t.home, c); return c; };
const setup = async (o: Parameters<typeof rig>[0] = {}) => { const r = rig(o); await idleAgent(r, ID); r.paseo.sent.length = 0; return r; };
const sentTexts = (r: Rig) => r.paseo.sent.map((s) => s.text);
const choose = (r: Rig, choice: string, always = false, cardId = CARD) => r.pcic.choose({ cardId, choice: choice as any, always });

// T40 (R47)
test("T40 resume sends the exact prompt once, with steer, and no other text", async () => {
  const r = await setup(); mkCard(r);
  assert.deepEqual(await choose(r, "resume"), { status: "sent" });
  assert.deepEqual(sentTexts(r), [PROMPT]); assert.equal(r.paseo.sent[0].opts?.activeTurnBehavior, "steer"); assert.ok(!("sourceAgentId" in (r.paseo.sent[0].opts ?? {})));
  assert.ok(!existsSync(cardPath(r.t.home, CARD)) && existsSync(usedPath(r.t.home, CARD)));
  assert.ok(!readFileSync(usedPath(r.t.home, CARD), "utf8").includes("ZQX-PROMPT"), "the used file keeps no prompt"); r.cleanup();
});
test("T40 compact runs /compact, waits, verifies, then sends the prompt", async () => {
  const r = await setup(); mkCard(r);
  assert.deepEqual(await choose(r, "compact"), { status: "sent" }); await settle();
  assert.deepEqual(sentTexts(r), ["/compact", PROMPT]);
  assert.ok(existsSync(join(r.t.home, "pending", `${ID}.json`)), "the PreCompact note applies (R30)"); r.cleanup();
});
test("T40 a failed or unconfirmed compaction sends nothing more and says so", async () => {
  const r = await setup(); mkCard(r); r.paseo.runStatus = "error";
  const a = await choose(r, "compact"); assert.equal(a.status, "failed"); assert.match(a.detail ?? "", /compaction/); assert.deepEqual(sentTexts(r), ["/compact"]); r.cleanup();
  const r2 = await setup({ autoCompact: false }); mkCard(r2); // the turn ends, but no boundary and no compaction item
  const b = await choose(r2, "compact"); assert.equal(b.status, "failed"); assert.deepEqual(sentTexts(r2), ["/compact"]);
  assert.deepEqual(historyOf(r2.t).filter((h) => h.event === "card_failed").map((h) => h.reason), ["compact_unverified"]); r2.cleanup();
});
test("T40 checkpoint runs /clear, then sends the prompt; a failed /clear sends nothing", async () => {
  const r = await setup(); mkCard(r);
  assert.deepEqual(await choose(r, "checkpoint"), { status: "sent" }); assert.deepEqual(sentTexts(r), ["/clear", PROMPT]); r.cleanup();
  const r2 = await setup(); mkCard(r2); r2.paseo.runStatus = "error";
  assert.equal((await choose(r2, "checkpoint")).status, "failed"); assert.deepEqual(sentTexts(r2), ["/clear"]); r2.cleanup();
});
test("T40 dismiss deletes the card and sends nothing", async () => {
  const r = await setup(); mkCard(r);
  assert.deepEqual(await choose(r, "dismiss"), { status: "dismissed" }); assert.deepEqual(sentTexts(r), []);
  assert.deepEqual(readdirSync(join(r.t.home, "cards")), []); r.cleanup();
});
test("T40 a second click on the same card is already_used and sends nothing more; so are two at once", async () => {
  const r = await setup(); mkCard(r);
  assert.equal((await choose(r, "resume")).status, "sent"); assert.equal((await choose(r, "resume")).status, "already_used"); assert.equal((await choose(r, "checkpoint")).status, "already_used"); assert.deepEqual(sentTexts(r), [PROMPT]); r.cleanup();
  const r2 = await setup(); mkCard(r2);
  const both = await Promise.all([choose(r2, "resume"), choose(r2, "resume")]); assert.deepEqual(both.map((x) => x.status).sort(), ["already_used", "sent"]); assert.deepEqual(sentTexts(r2), [PROMPT]); r2.cleanup();
});
test("T40 a running agent: not_idle, nothing sent, the claim is released and a later click works", async () => {
  const r = await setup(); mkCard(r); const snap = r.paseo.agents_.get(ID)!.snap; snap.status = "running";
  assert.deepEqual(await choose(r, "resume"), { status: "not_idle" }); assert.deepEqual(sentTexts(r), []);
  assert.ok(existsSync(cardPath(r.t.home, CARD)) && !existsSync(usedPath(r.t.home, CARD)));
  assert.equal(readJsonFile(cardPath(r.t.home, CARD)).prompt, PROMPT, "the prompt is back in the released card"); assert.equal(statSync(cardPath(r.t.home, CARD)).mode & 0o777, 0o600);
  snap.status = "idle"; assert.equal((await choose(r, "resume")).status, "sent"); assert.deepEqual(sentTexts(r), [PROMPT]); r.cleanup();
});
test("T40 a pending permission or a turn in flight is not_idle too; an agent that becomes busy during /clear gets no prompt", async () => {
  const r = await setup(); mkCard(r); r.paseo.agents_.get(ID)!.snap.pendingPermissions = [{ id: "p1" }]; assert.equal((await choose(r, "resume")).status, "not_idle"); assert.deepEqual(sentTexts(r), []); r.cleanup();
  const r2 = await setup(); mkCard(r2);
  r2.paseo.onTurnEnd = async () => { r2.paseo.agents_.get(ID)!.snap.status = "running"; }; // the owner started a turn while /clear ran
  const x = await choose(r2, "checkpoint"); assert.equal(x.status, "failed"); assert.deepEqual(sentTexts(r2), ["/clear"]); r2.cleanup();
});
test("T40 an expired card (older than 24 h), a missing card and a malformed id", async () => {
  const r = await setup(); mkCard(r, { createdAt: r.clock.now() - 25 * 3600e3 });
  assert.deepEqual(await choose(r, "resume"), { status: "expired" }); assert.ok(!existsSync(cardPath(r.t.home, CARD))); assert.deepEqual(sentTexts(r), []);
  assert.deepEqual(await choose(r, "resume", false, "fedcba9876543210"), { status: "expired" }); assert.deepEqual(await choose(r, "resume", false, "../../etc/passwd"), { status: "expired" }); r.cleanup();
});
test("T40 enabled false: nothing is sent and the card stays usable", async () => {
  const r = await setup({ cfg: { enabled: false } }); mkCard(r);
  assert.equal((await choose(r, "resume")).status, "failed"); assert.deepEqual(sentTexts(r), []); assert.ok(existsSync(cardPath(r.t.home, CARD))); r.cleanup();
});
test("T40 always writes coldChoice, keeps the other keys, and only for resume and checkpoint", async () => {
  const r = await setup({ cfg: { guard: true, minContextTokens: 5 } }); mkCard(r);
  await choose(r, "resume", true); assert.deepEqual(readJsonFile(join(r.t.home, "config.json")), { staggerSeconds: 0, minContextTokens: 5, guard: true, coldChoice: "resume" });
  mkCard(r, { cardId: "aaaaaaaaaaaaaaaa" }); await choose(r, "checkpoint", true, "aaaaaaaaaaaaaaaa"); assert.equal(readJsonFile(join(r.t.home, "config.json")).coldChoice, "checkpoint");
  mkCard(r, { cardId: "bbbbbbbbbbbbbbbb" }); await choose(r, "compact", true, "bbbbbbbbbbbbbbbb"); assert.equal(readJsonFile(join(r.t.home, "config.json")).coldChoice, "checkpoint", "compact is never remembered"); r.cleanup();
});
test("T40 a send that fails is reported and logged without the prompt; the leak check: no prompt in history or logs", async () => {
  const r = await setup(); mkCard(r); r.paseo.sendThrows = true;
  const x = await choose(r, "resume"); assert.equal(x.status, "failed");
  const h = historyOf(r.t); assert.deepEqual(h.filter((e) => e.event.startsWith("card_")).map((e) => [e.event, e.choice, e.reason]), [["card_choice", "resume", undefined], ["card_failed", undefined, "send_failed"]]);
  assert.ok(!JSON.stringify(h).includes("ZQX-PROMPT") && !r.logs.join("\n").includes("ZQX-PROMPT") && !JSON.stringify(x).includes("ZQX-PROMPT")); r.cleanup();
});
test("T40 history for a click: card_choice with choice and always, nothing else about the card", async () => {
  const r = await setup(); mkCard(r); await choose(r, "resume", true);
  const e = historyOf(r.t).find((x) => x.event === "card_choice"); assert.deepEqual([e.choice, e.always, e.agent], ["resume", true, ID]); r.cleanup();
});
test("T40 the RPC contract validates its input and output", () => {
  assert.equal(chooseRpc.input.safeParse({ cardId: CARD, choice: "resume" }).success, true);
  for (const bad of [{ cardId: "x", choice: "resume" }, { cardId: CARD, choice: "send" }, { choice: "resume" }]) assert.equal(chooseRpc.input.safeParse(bad).success, false);
  assert.equal(chooseRpc.output.safeParse({ status: "sent" }).success, true); assert.equal(chooseRpc.output.safeParse({ status: "weird" }).success, false);
});

// T41 (R48): the plugin side of coldChoice checkpoint
test("T41 an auto card is acted on once: /clear then the prompt; a second scan or watcher event does nothing", async () => {
  const r = await setup(); mkCard(r, { auto: true });
  await r.pcic.autoScan(); assert.deepEqual(sentTexts(r), ["/clear", PROMPT]);
  await r.pcic.autoScan(); await r.pcic.autoScan(); assert.deepEqual(sentTexts(r), ["/clear", PROMPT]);
  assert.deepEqual(historyOf(r.t).filter((e) => e.event === "card_choice").map((e) => [e.choice, e.always]), [["checkpoint", false]]);
  assert.equal(readJsonFile(join(r.t.home, "config.json")).coldChoice, undefined); r.cleanup();
});
test("T41 an ask card is never acted on by the scan", async () => {
  const r = await setup(); mkCard(r); await r.pcic.autoScan(); assert.deepEqual(sentTexts(r), []); assert.ok(existsSync(cardPath(r.t.home, CARD))); r.cleanup();
});
test("T41 an auto card for a busy agent waits and is acted on at the next scan; a stale one is dropped unsent", async () => {
  const r = await setup(); mkCard(r, { auto: true }); const snap = r.paseo.agents_.get(ID)!.snap; snap.status = "running";
  await r.pcic.autoScan(); assert.deepEqual(sentTexts(r), []); assert.ok(existsSync(cardPath(r.t.home, CARD)));
  snap.status = "idle"; await r.pcic.autoScan(); assert.deepEqual(sentTexts(r), ["/clear", PROMPT]);
  mkCard(r, { auto: true, cardId: "cccccccccccccccc", createdAt: r.clock.now() - 11 * 60e3 }); r.paseo.sent.length = 0;
  await r.pcic.autoScan(); assert.deepEqual(sentTexts(r), []); assert.ok(!existsSync(cardPath(r.t.home, "cccccccccccccccc")));
  assert.ok(historyOf(r.t).some((e) => e.reason === "auto_stale")); r.cleanup();
});
test("T45 R51 every text pcic sends for a card carries a pcic- messageId, so the client can hide it", async () => {
  const r = await setup(); mkCard(r, { auto: true }); await r.sweep(); await settle();
  assert.deepEqual(r.paseo.sent.map((s) => [s.text, s.opts?.messageId]), [["/clear", `pcic-clear-${CARD}`], [PROMPT, `pcic-prompt-${CARD}`]]);
  assert.ok(r.paseo.sent.every((s) => s.opts?.activeTurnBehavior === "steer")); r.cleanup();
});
test("T41 the sweep scans too (the fallback), and not while disabled", async () => {
  const r = await setup(); mkCard(r, { auto: true }); await r.sweep(); await settle(); assert.deepEqual(sentTexts(r), ["/clear", PROMPT]); r.cleanup();
  const r2 = await setup({ cfg: { enabled: false } }); mkCard(r2, { auto: true }); await r2.sweep(); assert.deepEqual(sentTexts(r2), []); r2.cleanup();
});
test("T41 the cards/ watcher notices a new auto card and acts once", async () => {
  const r = await setup(); const stop = r.pcic.watchCards();
  mkCard(r, { auto: true });
  for (let i = 0; i < 100 && sentTexts(r).length < 2; i++) await new Promise((x) => setTimeout(x, 20));
  stop(); assert.deepEqual(sentTexts(r), ["/clear", PROMPT]); r.cleanup();
});

// T42 (R49)
test("T42 the sweep deletes cards older than 24 h, used or not, and keeps younger ones", async () => {
  const r = await setup(); const old = r.clock.now() - 25 * 3600e3;
  mkCard(r, { cardId: "1111111111111111", createdAt: old }); mkCard(r, { cardId: "2222222222222222" });
  mkCard(r, { cardId: "3333333333333333", createdAt: old }); await choose(r, "dismiss", false, "3333333333333333"); // gone already
  mkCard(r, { cardId: "4444444444444444", createdAt: old }); (await import("node:fs")).renameSync(cardPath(r.t.home, "4444444444444444"), usedPath(r.t.home, "4444444444444444")); // an old used card
  await r.sweep(); assert.deepEqual(readdirSync(join(r.t.home, "cards")).sort(), ["2222222222222222.json"]); r.cleanup();
});
test("T42 the sweep prunes even before the plugin has a client; a missing cards/ is fine", async () => {
  const r = rig(); await r.sweep(); mkCard(r, { createdAt: r.clock.now() - 30 * 3600e3 }); await r.sweep(); assert.deepEqual(readdirSync(join(r.t.home, "cards")), []); r.cleanup();
});
test("T41 a busy agent does not make the watcher loop: the released card is retried by the sweep only", async () => {
  const r = await setup(); let refreshes = 0; r.paseo.onRefresh = () => { refreshes++; };
  const snap = r.paseo.agents_.get(ID)!.snap; snap.status = "running"; const stop = r.pcic.watchCards();
  mkCard(r, { auto: true }); await new Promise((x) => setTimeout(x, 400));
  assert.ok(refreshes <= 2, String(refreshes)); assert.deepEqual(sentTexts(r), []); assert.ok(existsSync(cardPath(r.t.home, CARD)));
  snap.status = "idle"; await new Promise((x) => setTimeout(x, 200)); assert.deepEqual(sentTexts(r), [], "the watcher alone does not retry");
  await r.sweep(); await settle(); stop(); assert.deepEqual(sentTexts(r), ["/clear", PROMPT]); r.cleanup();
});

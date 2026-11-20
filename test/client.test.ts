import { test } from "node:test";
import assert from "node:assert/strict";
import { cardLine } from "../server/card.mjs";
import { COLD_MARK, TEXT_TYPES, cardDataSchema, findCard, itemText, parseCardLine, transformText, transformerId, PASEO_ID, CARD_KIND, viewModel, resultText, pendingText, fmtUsd } from "../shared/cold-card.js";

const card = { cardId: "0123456789abcdef", idleMs: 48_840_000, tokens: 132_000, awt: true, auto: false, est: { resume: 0.33, compact: 0.2, checkpoint: 0.0123 } };
const line = cardLine(card);
const text = (extra = "") => `${COLD_MARK} (idle 13h; cache lasts 1h). Context about 132K tokens.\n- Send the same message again: full context, no second stop.\n${extra}${line}`;

// T38 (R45)
test("T38 a valid card line parses to the card data (the hook's cardLine and the parser agree)", () => {
  assert.deepEqual(parseCardLine(line), { cardId: "0123456789abcdef", idleMs: 48_840_000, tokens: 132_000, resume: 0.33, compact: 0.2, checkpoint: 0.0123, awt: true, auto: false });
  assert.equal(parseCardLine(cardLine({ ...card, est: { resume: null, compact: null, checkpoint: null }, awt: false, auto: true }))?.auto, true);
  assert.deepEqual(parseCardLine(cardLine({ ...card, est: {} }))?.resume, null);
});
test("T38 no card line, or a malformed one: the item is left alone", () => {
  assert.equal(transformText(`${COLD_MARK} (idle 13h).\nplain text only`), undefined);
  for (const bad of [line.replace("v1", "v2"), line.replace("0123456789abcdef", "XYZ"), line.replace("idle=48840000", "idle=-5"), line.replace("resume=0.33", "resume=abc"), line.replace("awt=1", "awt=2"), line.slice(0, -1), line.replace("]", " extra=1]"), "[pcic-card v1]"]) assert.equal(transformText(text().replace(line, bad)), undefined, bad);
  assert.equal(transformText(line), undefined, "the card line alone, without the block text");
  assert.equal(transformText("hello"), undefined);
  for (const v of [null, undefined, 5, {}, []]) assert.equal(transformText(v), undefined);
});
test("T38 a valid block text becomes one pcic-cold-card v1 plugin item holding only the card data", () => {
  const r = transformText(text("Your message: \"x\"\n"));
  assert.deepEqual(r, { items: [{ type: "plugin", kind: "pcic-cold-card", version: 1, data: parseCardLine(line) }] });
  assert.ok(cardDataSchema.safeParse(r?.items[0].data).success); assert.ok(!JSON.stringify(r).includes("Your message"));
});
test("T38 any item type that carries text is read, and the output is deterministic", () => {
  for (const type of TEXT_TYPES) {
    const item = type === "error" || type === "notification" ? { type, message: text(), level: "error" } : { type, text: text() };
    assert.equal(itemText(item), text()); assert.deepEqual(transformText(itemText(item)), transformText(itemText(item)));
    assert.equal(JSON.stringify(transformText(itemText(item))), JSON.stringify(transformText(itemText(item))));
  }
  assert.equal(itemText({ type: "reasoning", text: text() }), null); assert.equal(itemText({ type: "user_message" }), null); assert.equal(itemText(null), null);
  assert.equal(findCard(`${text()}\n${cardLine({ ...card, cardId: "fedcba9876543210" })}`)?.cardId, "fedcba9876543210"); // the last valid line wins
});

test("T38 every transformer id and the renderer kind pass Paseo's id check (an invalid one drops the whole client entry)", () => {
  assert.ok(PASEO_ID.test(CARD_KIND), CARD_KIND);
  for (const type of TEXT_TYPES) assert.ok(PASEO_ID.test(transformerId(type)), transformerId(type));
  assert.equal(new Set(TEXT_TYPES.map(transformerId)).size, TEXT_TYPES.length);
});

// T39 (R46): the pure view logic
test("T39 header and options with awt: five radio options in the design's order, prices from the card", () => {
  const v = viewModel(parseCardLine(line)!);
  assert.equal(v.header, "Cache expired 814 min ago. Context: 132K tokens."); assert.equal(v.auto, null);
  assert.deepEqual(v.options.map((o) => [o.choice, o.always, o.label]), [
    ["resume", false, "Resume full context ~$0.33"],
    ["checkpoint", false, "Continue from checkpoint ~$0.012 (new session: awt brief + your message)"],
    ["compact", false, "Compact, then send ~$0.20"],
    ["resume", true, "Resume full context (don't ask again)"],
    ["checkpoint", true, "Continue from checkpoint (don't ask again)"],
  ]);
  assert.equal(new Set(v.options.map((o) => o.id)).size, 5);
});
test("T39 without awt: Start fresh, no always-checkpoint; unknown prices leave the figure out", () => {
  const v = viewModel(parseCardLine(cardLine({ ...card, awt: false, est: {} }))!);
  assert.deepEqual(v.options.map((o) => o.label), ["Resume full context", "Start fresh (new session: your message only)", "Compact, then send", "Resume full context (don't ask again)"]);
  assert.equal(fmtUsd(0.0004), " ~$0.0004"); assert.equal(fmtUsd(0.2), " ~$0.20"); assert.equal(fmtUsd(null), "");
});
test("T39 auto card: a non-interactive row with the setting and how to change it, no options", () => {
  const v = viewModel(parseCardLine(cardLine({ ...card, auto: true }))!);
  assert.equal(v.auto, "Cache expired 814 min ago. Continuing from checkpoint (your setting; change with: pcic config coldChoice ask)"); assert.deepEqual(v.options, []);
});
test("T39 row texts: pending, sent, failed, busy (retryable), expired", () => {
  assert.equal(pendingText("compact", true), "Compacting, then sending"); assert.equal(pendingText("checkpoint", true), "Cleared, sending with the awt brief"); assert.equal(pendingText("resume", false), "Sending with full context");
  assert.equal(resultText("resume", true, { status: "sent" }).text, "Sent with full context");
  assert.match(resultText("compact", true, { status: "failed", detail: "compact_failed" }).text, /^Failed: compact_failed\. Your message was not sent/);
  assert.deepEqual(resultText("checkpoint", true, { status: "not_idle" }).retry, true);
  for (const s of ["sent", "dismissed", "already_used", "expired", "failed"] as const) assert.equal(resultText("resume", true, { status: s }).retry, false, s);
});

// T39 (R46, V13 offline part): the client entry bundles from client/ and shared/ only, with no node: import and no server code
test("T39 index.client.tsx bundles; its graph holds only client/, shared/, the entry and node_modules; nothing imports node:", async () => {
  const { build } = await import("esbuild");
  const root = new URL("..", import.meta.url).pathname;
  const r = await build({ entryPoints: [`${root}index.client.tsx`], bundle: true, write: false, metafile: true, format: "esm", platform: "neutral", jsx: "automatic", logLevel: "silent", external: ["react", "react/*", "react-native", "@getpaseo/plugin/client", "@getpaseo/plugin/client/*"], absWorkingDir: root });
  const inputs = Object.keys(r.metafile.inputs);
  const mine = inputs.filter((f) => !f.startsWith("node_modules/"));
  assert.deepEqual(mine.sort(), ["client/cold-card.tsx", "index.client.tsx", "shared/cold-card.ts"]);
  const imports = Object.values(r.metafile.inputs).flatMap((i) => i.imports.map((x) => x.path));
  assert.deepEqual(imports.filter((p) => p.startsWith("node:") || /^(fs|path|os|child_process|crypto)$/.test(p)), []);
});

// The cold-return card file and its tag line (R44). Plain Node, shared by the hook and the plugin.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, num, readJson } from "./common.mjs";

export const CARD_TTL_MS = 24 * 3600e3;
export const CARD_ID = /^[0-9a-f]{16}$/;
export const cardsDir = (home) => join(home, "cards");
export const cardPath = (home, id) => join(cardsDir(home), `${id}.json`);
export const usedPath = (home, id) => join(cardsDir(home), `${id}.used`);

const money = (n) => (n === null || n === undefined ? "-" : String(Number(n.toPrecision(3))));

/** The last line of the block text. The client transformer parses only this line (shared/cold-card.ts must stay in step; T38 checks it). */
export function cardLine(c) {
  const e = c.est ?? {};
  return `[pcic-card v1 ${c.cardId} idle=${Math.round(c.idleMs)} tokens=${Math.round(c.tokens)} resume=${money(e.resume)} compact=${money(e.compact)} checkpoint=${money(e.checkpoint)} awt=${c.awt ? 1 : 0}${c.auto ? " auto=1" : ""}]`;
}

/** Writes cards/<id>.json with mode 0600 (the card holds the owner's prompt). Throws on failure; the caller then blocks without a card. */
export function writeCard(home, card) {
  mkdirSync(cardsDir(home), { recursive: true, mode: 0o700 });
  atomicWrite(cardPath(home, card.cardId), JSON.stringify(card), 0o600);
}

/** R49: delete cards older than 24 h, used or not. Age comes from the card's own createdAt, else the file's mtime. */
export function pruneCards(home, now) {
  let n = 0;
  try {
    for (const f of readdirSync(cardsDir(home))) {
      const p = join(cardsDir(home), f);
      const at = f.endsWith(".json") || f.endsWith(".used") ? num(readJson(p)?.createdAt) : null;
      let age = at;
      if (age === null) { try { age = statSync(p).mtimeMs; } catch { continue; } }
      if (now - age > CARD_TTL_MS) { rmSync(p, { force: true }); n++; }
    }
  } catch {}
  return n;
}

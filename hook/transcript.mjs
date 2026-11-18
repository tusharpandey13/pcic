// Tail parser for Claude Code transcripts, shared by the hook and the plugin. Reads at most the last 2 MB.
import { open } from "node:fs/promises";
import { num } from "./common.mjs";

export const TAIL_BYTES = 2 * 1024 * 1024;

/** The last `max` bytes as complete lines. A non-regular file, an unreadable file or an error gives []. */
export async function tailLines(path, max = TAIL_BYTES) {
  let fh;
  try {
    fh = await open(path, "r");
    const st = await fh.stat();
    if (!st.isFile()) return [];
    const start = Math.max(0, st.size - max);
    const buf = Buffer.alloc(Math.min(st.size, max));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8", 0, bytesRead);
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    return text.split("\n").filter((l) => l.startsWith("{"));
  } catch { return []; } finally { try { await fh?.close(); } catch {} }
}

const ms = (t) => { const v = typeof t === "number" ? t : Date.parse(t); return Number.isFinite(v) ? v : null; };

/**
 * What the rules need from a transcript tail:
 * last: newest non-sidechain assistant entry with usage {uuid, at, model, contextTokens}
 * ttlObserved: 3600 / 300 from the newest request that wrote cache, else null
 * boundary: newest compact_boundary {at, pre, post}, or null
 */
export function scan(lines) {
  let last = null, ttlObserved = null, boundary = null;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      const at = ms(e.timestamp);
      if (at !== null) boundary = { at, pre: num(e.compactMetadata?.preTokens), post: num(e.compactMetadata?.postTokens) };
      continue;
    }
    if (e.type !== "assistant" || e.isSidechain) continue;
    const u = e.message?.usage;
    if (!u || typeof u !== "object") continue;
    const at = ms(e.timestamp);
    const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].map((x) => (x === undefined ? 0 : num(x)));
    const ctx = parts.some((x) => x === null) ? null : parts[0] + parts[1] + parts[2];
    last = { uuid: typeof e.uuid === "string" ? e.uuid : null, at, model: typeof e.message?.model === "string" ? e.message.model : null, contextTokens: ctx };
    const cc = u.cache_creation;
    if (cc && typeof cc === "object") {
      if (num(cc.ephemeral_1h_input_tokens) > 0) ttlObserved = 3600;
      else if (num(cc.ephemeral_5m_input_tokens) > 0) ttlObserved = 300;
    }
  }
  if (last && boundary && last.at !== null && boundary.at > last.at) last = { ...last, contextTokens: boundary.post }; // the context shrank after this entry
  return { last, ttlObserved, boundary };
}

export const readTail = async (path) => scan(await tailLines(path));

# Cold-return card (v0.2 design)

Owner request (19-Nov-2026): in Paseo, Claude agents should get the same choice card pi agents get from pcg when a message arrives after the cache expired:

```
Cache expired 814 min ago. Context: 132K tokens.
( ) Resume full context ~$0.33
( ) Continue from checkpoint ~$0.001 (new session, handoff + your message)
( ) Resume full context (don't ask again)
( ) Continue from checkpoint (don't ask again)
[Dismiss] [Submit]
```

Today the pcic guard (R31..R34) blocks the prompt for free and prints text listing three ways out. The owner has to retype or resend. The card turns that into one click.

## Constraints that shape the design

- The only $0 interception point is the Claude Code `UserPromptSubmit` hook (exit 2, verified). The plugin hooks `agent.turn.before` and `agent.turn.after` only notify and cannot cancel. The composer API has no submit hook. So the hook keeps blocking, and the card is drawn over the block.
- A pi agent's `ctx.ui.select` reaches Paseo as a provider permission request of kind `question`. A Claude Code hook cannot raise one, and asking the model to call AskUserQuestion would cost the full cold rewrite. So the card is a plugin timeline item.
- A client timeline transformer must be synchronous and deterministic. So the card's data has to be in the block text itself.

## Flow

1. **Hook (block).** When R31 says block, the hook also:
   - makes a `cardId` (16 random hex characters);
   - writes `cards/<cardId>.json` with mode 0600, holding `{v:1, cardId, agentId, sessionId, lastAssistantUuid, prompt, createdAt, model, tokens, idleMs, awt: bool, est: {resume, compact, checkpoint}}`. Estimates are null when the model is unknown;
   - appends one last line to the R33 text: `[pcic-card v1 <cardId> idle=<ms> tokens=<n> resume=<usd|-> compact=<usd|-> checkpoint=<usd|-> awt=<0|1>]`. The text stays readable, and the transformer parses only this line.

   The prompt is stored only in the card file, never in history or the timeline.
2. **Client transformer.** It matches a timeline item of any type whose text contains `pcic: this agent's prompt cache has likely expired` and a parseable `[pcic-card v1 ...]` line. It replaces that item with the plugin item `pcic.coldCard` v1 `{cardId, idleMs, tokens, resume, compact, checkpoint, awt}`. Nothing matches, so nothing changes, when the plugin client isn't loaded. The plain text is the fallback, so R33's three ways out stay.
3. **Renderer.** It shows the header `Cache expired <idle> ago. Context: <N>K tokens.` and these radio options:
   - `Resume full context ~$X`
   - `Continue from checkpoint ~$Y (new session: awt brief + your message)`. Only when `awt`; without awt the label is `Start fresh ~$Y (new session: your message only)`.
   - `Compact, then send ~$Z`
   - `Resume full context (don't ask again)`
   - `Continue from checkpoint (don't ask again)`. Only when `awt`.

   Then `Dismiss` and `Submit`, styled like Paseo's question card. Submit calls the server RPC `choose`. The row shows the result: "Sent with full context", "Compacting, then sending", "Cleared, sending with the awt brief", or the error. Use theme colours (`foreground` and `foregroundMuted`).
4. **Server RPC `choose {cardId, choice, always}`.**
   - Read the card file. It must exist, be under 24 h old, and be unused. Claim it by renaming to `<cardId>.used`; a second click on the same card returns `already_used`.
   - Check the agent is idle in the same tick as the send (R10/R26 rules, `steer`). A running agent returns `not_idle` and releases the claim.
   - `resume`: send `prompt` unchanged. The R32 marker already holds this `lastAssistantUuid`, so the guard passes it.
   - `compact`: `run("/compact")` (R15/R19 timeouts and verification), then send `prompt`. If the compaction fails, nothing more is sent, and the card shows the error and says the message was not sent.
   - `checkpoint`: `run("/clear")`, then send `prompt`. The SessionStart `clear` hook (awt or pcic, R28) adds the awt brief. After `/clear`, the guard passes because the new transcript has no assistant entry.
   - `always`: merge `coldChoice: "resume" | "checkpoint"` into `config.json` (the same atomic write as other state).
   - `dismiss`: delete the card file and send nothing. The owner can resend by hand, and the marker lets it through.
   - History events: `card_choice` with `{choice, always}`, `card_failed` with `reason`. Never the prompt.
5. **Don't ask again.** The new config key `coldChoice` is `"ask"` by default, or `"resume"` or `"checkpoint"`.
   - `resume`: the guard does not block. It logs `guard_pass_setting`.
   - `checkpoint`: the guard still blocks, because `/clear` must run first. It writes the card with `auto: true`. The plugin picks it up by `fs.watch` on `cards/`, falling back to the sweep, and runs `checkpoint` itself. The transformer renders a non-interactive row: `Cache expired <idle> ago. Continuing from checkpoint (your setting; change with: pcic config coldChoice ask)`.
   - CLI: `node bin/pcic.mjs config coldChoice <ask|resume|checkpoint>`.
6. **Expiry.** The sweep deletes `cards/*` older than 24 h, used or not. Cards from a daemon restart are still valid (the files survive), but timeline rows do not survive a restart. The transformer works on refetched history, so the card comes back as long as the block text is in the history.

## Estimates

- `resume`: as R33 (tokens times the write price of the observed TTL bucket).
- `compact`: as R33 (tokens times the input price, plus 2,000 output tokens; V8).
- `checkpoint`: (`freshContextTokens` + awt brief tokens + prompt tokens) times the write price. `freshContextTokens` is a new config key, default 20000, for Claude Code's system prompt and tools. The brief tokens are the brief's character count / 4; the hook reads the brief size with `awt resume --hook --framed` only when `AWT_DIR` is set, within R34's 1.5 s budget, else assumes 2000. It is labelled an estimate. The system prompt may be read from a shared cache and cost less, which is unverified (V12).

## Spec changes

- R31: add the `coldChoice` gate.
- R33: add the card line and the card file.
- R42: pcic also sends, only on the owner's click or the owner's `coldChoice` setting, the owner's own blocked prompt, `/clear` and `/compact`.
- New rules R44..R50 for the card file, transformer, renderer, RPC, auto mode, expiry and CLI config.
- New unverified items:
  - V11: which timeline item type carries hook stderr in Paseo, and that a client transformer can replace it;
  - V12: the cost of a fresh session after `/clear`;
  - V13: that the Paseo plugin builder bundles a client entry next to the server entry for a local install.

## Tests (offline, Tier T)

- The hook writes the card file (mode 0600, fields) and the tag line. With an unknown model, the dollar fields are `-`. The text stays at most 600 characters with the tag.
- Transformer parse: a valid line; no line; a malformed line; any item type; deterministic output.
- RPC against the fake Paseo, one test per choice:
  - `resume` sends the exact prompt;
  - `compact` runs `/compact` then the prompt, and a failed compaction sends nothing;
  - `checkpoint` runs `/clear` then the prompt;
  - `dismiss`, `already_used`, `not_idle` (claim released), and an expired card.
- `always` writes `coldChoice`. With `coldChoice` `resume` the guard passes. With `checkpoint`, the auto card is acted on once, and a second watcher event does nothing.
- Leak check: the prompt text never appears in `history.jsonl` or plugin logs.
- The renderer is kept thin: logic in a pure module that is tested, and the React part only wires it up.

## Live check (needs the owner, may spend tokens)

The free part: an isolated daemon with `ttlSeconds` 60 and `minContextTokens` 0, one tiny Haiku turn, wait 2 min, send. The block is $0. Confirm V11 and V13 and click each option. The one Haiku turn and the resend cost cents. The owner approves first.

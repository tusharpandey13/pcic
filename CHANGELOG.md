# Changelog

## 0.2.7 (26-Nov-2026)

- Fix: after an idle checkpoint and compaction, an agent could take the checkpoint as its task, reply `checkpoint saved` and never pick its work back up (R57). The checkpoint text is now a maintenance turn scoped to itself. The compaction notes say the task is the owner's last real message and the next step is the owner's pending step. A new `SessionStart` `compact` hook says the checkpoint's limits have ended. Run `pcic install` again to add the fifth hook entry.

## 0.2.6 (25-Nov-2026)

- Fix: a `/compact` bubble showed again after the idle checkpoint. After the compaction Paseo shows the provider's copy of the row, which has no pcic id; pcic now hides a bare `/compact` row with no `clientMessageId` (R56). The "Context compacted" divider stays.

## 0.2.5 (23-Nov-2026)

- Fix: after the Paseo 0.17.3 update the idle checkpoint prompt showed as a chat bubble again. Paseo now keeps pcic's id in `clientMessageId`; pcic checks both id fields and the `[pcic checkpoint]` prefix (R55).

## 0.2.4 (22-Nov-2026)

- Fix: the cold-return marker now expires after `markerSeconds` (default 600) (R54). Before, a blocked prompt that was never resent left a marker that let the next prompt on that session through with full context, days later, instead of blocking it and continuing from a checkpoint. Picking "Resume full context" on a card refreshes the marker, so a card answered late still sends.

## 0.2.3 (20-Nov-2026)

- The idle checkpoint is quiet in the chat (R52): the checkpoint prompt and `/compact` carry a `pcic-` message id and the client hides them, and the agent's `checkpoint saved` reply is drawn as one grey row, `pcic · checkpoint saved before the cache expired`. A `checkpoint failed: ...` reply stays visible. A turn whose first user message has a `pcic-` id also counts as pcic's own (R16).
- The send mode is always `plugin` (R53). Removed: the startup self-test and its probe agent, `verdict.json`, the automatic switch to `cli` (a false positive on 19 Nov made 0.2.2 send in cli mode, which carries no message id and hid nothing), and the config key `probeModel` (an old `config.json` with it gets one "unknown config key" warning). `sendMode` `auto` and `plugin` both mean plugin; `cli` stays as a manual fallback. A leftover `verdict.json` is ignored.

## 0.2.2 (20-Nov-2026)

- A checkpoint under `coldChoice checkpoint` is now quiet: the chat keeps your message, one grey row `pcic · continued from checkpoint · saved about $X (...)`, and the reply. The `/clear` and the resent copy of your message that pcic sends are hidden (pcic tags them with a `pcic-` message id), and so is Paseo's "Claude switched to a new session" line.
- `coldChoice checkpoint` on an agent with no awt record now lets the message through with full context instead of clearing it with nothing to continue from (`guard_pass_setting`, choice `resume_no_awt`).

## 0.2.1 (20-Nov-2026)

- Fix: the cold-return card never appeared in the app. Paseo only accepts plugin ids and kinds made of lowercase letters, digits and dashes, and it dropped pcic's whole client entry because the transformer ids (`pcic.cold-card.user_message`) and the renderer kind (`pcic.coldCard`) broke that rule. They are now `pcic-cold-card-<item-type>` and `pcic-cold-card`, and a test checks them against Paseo's rule.
- Fix: the plain-text block says "about $1.25" and "about 156K tokens" instead of "~$1.25" and "~156K". Paseo renders the block as markdown, and the two "~" turned the text between them into strikethrough.

## 0.2.0 (19-Nov-2026)

- Cold-return card: when the guard blocks a prompt, the Paseo app shows a choice card (resume with full context, compact first, or continue from a checkpoint with `/clear`, with "don't ask again" variants) and pcic sends your blocked prompt for you after the pick (R44..R49). The prompt is kept only in `cards/<id>.json` (mode 0600, 24 hours). The plain-text block stays as the fallback.
- New config keys `coldChoice` (`ask`, `resume`, `checkpoint`; default `ask`) and `freshContextTokens` (20000, for the card's checkpoint estimate). `pcic config <key> [value]` reads and sets config keys (R50).
- The block message is shorter so that the card line fits in 600 characters; the echo of your message is 60, 40 or 20 characters, whichever fits.
- New plugin client entry (`index.client.tsx`, `client/`, `shared/`), RPC `pcic.choose`, a `cards/` watcher and card expiry in the sweep. New dependency `zod` (the SDK's RPC contracts need it) and `@types/react` (dev).
- Checked live on 19 Nov 2026 (Paseo 0.16.2): the hook's text is an `assistant_message` item (V11), the client entry is bundled for a local install (V13), every `pcic.choose` choice works, and a fresh session after `/clear` wrote 9.2K and read 13.6K tokens (V12). Not checked: that the app draws the card (R46).

## 0.1.0 (19-Nov-2026)

- Paseo plugin: tracks Claude agents, runs one checkpoint turn plus `/compact` per idle period while the prompt cache is warm.
- Hooks (`Stop`, `PreCompact`, `UserPromptSubmit`) and a `SessionStart` `clear` hook that restores the awt brief after `/clear`, skipped when awt provides its own.
- Cold-return guard: blocks the first prompt after the cache expired once, and offers resend, `/compact` or `/clear`.
- CLI: `pcic install [--uninstall]`, `pcic doctor`, `pcic hook <event>`.
- Tier T offline suite (fake Paseo, fake clock, recorded transcripts) and a gated live Tier E suite (E1 to E19), all passing live against Paseo 0.16.1.

# Changelog

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

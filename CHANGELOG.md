# Changelog

## 0.1.0 (19-Nov-2026)

- Paseo plugin: tracks Claude agents, runs one checkpoint turn plus `/compact` per idle period while the prompt cache is warm.
- Hooks (`Stop`, `PreCompact`, `UserPromptSubmit`) and a `SessionStart` `clear` hook that restores the awt brief after `/clear`, skipped when awt provides its own.
- Cold-return guard: blocks the first prompt after the cache expired once, and offers resend, `/compact` or `/clear`.
- CLI: `pcic install [--uninstall]`, `pcic doctor`, `pcic hook <event>`.
- Tier T offline suite (fake Paseo, fake clock, recorded transcripts) and a gated live Tier E suite (E1 to E19), all passing live against Paseo 0.16.1.

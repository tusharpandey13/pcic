# Changelog

## 0.1.0 (unreleased)

- Paseo plugin: tracks Claude agents, runs one checkpoint turn plus `/compact` per idle period while the prompt cache is warm.
- Hooks (`Stop`, `PreCompact`, `UserPromptSubmit`) and a `SessionStart` `clear` hook that restores the awt brief after `/clear`.
- Cold-return guard: blocks the first prompt after the cache expired once, and offers resend, `/compact` or `/clear`.
- CLI: `pcic install [--uninstall]`, `pcic doctor`, `pcic hook <event>`.
- Tier T offline suite (fake Paseo, fake clock, recorded transcripts) and a gated Tier E skeleton.

# AGENTS.md

pcic compacts idle Claude Code agents that Paseo launches, while their prompt cache is warm. It is one Paseo server plugin, one hook script and a small CLI. [SPEC.md](SPEC.md) (rules R1..R43) is the contract.

## Using pcic (for agents)

- You do not run anything. When your session has been idle about 55 minutes with a large context, pcic sends you one message starting `[pcic checkpoint]`. Do not continue the task and do not start new work: run `awt state --now "..." --next "..."` (and `awt decide` / `awt note` where needed), then reply with exactly one line, `checkpoint saved` or `checkpoint failed: <reason>`. `/compact` follows.
- After a compaction, the summary and the framed awt record are context only. They are not a user request: take no action until the owner writes.
- If your owner's prompt is blocked with "pcic: this agent's prompt cache has likely expired", tell them the three options in the message (resend, `/compact`, `/clear`) and do nothing else.
- To exclude an agent from pcic, set the Paseo label `pcic=off` when creating it.

## Install and operate (for a person or an agent acting for them)

```sh
npm ci
paseo plugin install "$PWD" && paseo daemon restart
node bin/pcic.mjs install     # merges 4 hook entries into ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json (idempotent, backup, `# pcic:hook` marker)
node bin/pcic.mjs doctor      # read-only; exit 0 only when everything is ok
node bin/pcic.mjs install --uninstall
```

Show the owner the target file before running `install` on their real settings. State and history live in `${PCIC_HOME:-${XDG_DATA_HOME:-~/.local/share}/pcic}` (`config.json`, `history.jsonl`, `verdict.json`, `pause.json`). `history.jsonl` says what pcic did and why it skipped. `"enabled": false` in `config.json` turns everything off from the next sweep.

## Working on this repository

- `SPEC.md` is the contract. Change it in the same commit as behaviour. The traceability table at its end must stay true: `test/traceability.test.ts` fails when a named test id is missing.
- Write the test for a rule before the code for it. Tier T tests (`test/*.test.ts`) are offline and cost nothing: fake Paseo and clock in `test/harness.ts`, the real hook script as a subprocess, synthetic transcripts. Fixtures use the fictional `parsekit` project and made-up ids (`agt_0001`); never add real data.
- Run before committing: `npm test` (type check plus all offline tests). Output of long runs goes to a file; print the tail.
- Never run anything that spends model tokens or touches the owner's real `~/.claude/settings.json` or live Paseo daemon. `install` is tested against temp `CLAUDE_CONFIG_DIR` only. The live suite (`npm run test:e2e`, `test/e2e/`) needs `PCIC_E2E=1` (isolated daemon in a temp home) and `PCIC_E2E_PAID=1` for the cases that spend tokens, and the owner's approval first.
- Complexity is debt. Dependency-free where possible: the hook, CLI and shared helpers (`hook/`, `bin/`) are plain Node ESM; only the plugin (`server/`, `index.server.ts`) is TypeScript. A new dependency needs a stated reason.
- Fail safe: on any doubt, send nothing and let the owner's message through. pcic sends only the three texts of R42, never passes `sourceAgentId`, sends only when the agent is idle (re-checked in the same tick), and never answers a permission request.
- History lines never hold prompts, replies, cwd or paths (R40); keep `record()` whitelisting fields.
- Commits end with the `Co-Authored-By` line the tooling requires; do not push or publish without the owner.

<p align="center"><img src="docs/assets/hero.svg" alt="pcic: a 60-minute prompt cache cools after the last turn; pcic checkpoints and compacts at 55 minutes, before it expires" width="880"></p>

# pcic

Paseo Claude Idle Compaction: compacts idle Claude Code agents in Paseo before their 1-hour prompt cache expires, so coming back to an agent costs a small context instead of the whole one.

## The problem

Paseo runs Claude Code through the Agent SDK, and each turn writes a prompt cache that lives one hour. While the cache is warm, the next turn reads the context cheaply. Step away for longer, and the first message after you return re-sends the whole conversation, 100K to 300K tokens, billed as a fresh cache write.

Claude Code has its own idle compaction for this, but it runs only in terminal, VS Code and desktop sessions. It never runs for Agent SDK sessions, so it never runs in Paseo. On the author's Mac, 0 of 73 compactions were idle compactions.

### What one return costs

The prices are the table in [`server/common.mjs`](server/common.mjs) (`PRICES`, $ per million tokens, from the Anthropic pricing page on 18-Nov-2026). For `opus-5-5`: input $4, 1h cache write $8, cache read $0.20, output $20.

A 200K-token context, coming back after two hours:

| | Arithmetic | Cost |
|---|---|---|
| Without pcic: the first message rewrites the context | 200,000 × $8 / 1M | **$1.60** |
| With pcic: checkpoint turn at 55 min, cache still warm | 200,000 × $0.20 / 1M | $0.04 |
| With pcic: `/compact` at 56 min, cache still warm | 200,000 × $0.20 / 1M + 2,000 × $20 / 1M | $0.08 |
| With pcic: the first message writes the compacted context | 15,000 × $8 / 1M | $0.12 |
| With pcic: total | | **$0.24** |

The 2,000 output tokens for the summary and the 15K compacted size are the same assumptions the guard uses for its own estimates; real values depend on the conversation. The checkpoint turn's own short reply and the new tokens it writes are left out. The same 200K rewrite on other families: `sonnet-5` $0.80, `sonnet-4` $1.20, `opus-4-5` to `opus-5` $2.00, `opus-4` $6.00. On a Claude subscription these are API-equivalent figures: you pay in plan usage, not dollars.

## How it works

<p align="center"><img src="docs/assets/timeline.svg" alt="Timeline: without pcic the 200K context goes cold at 1 hour and is rewritten on return; with pcic a checkpoint and /compact run at 55 minutes, and the return writes about 15K" width="880"></p>

1. **Last turn.** The agent finishes a turn. pcic notes the time and the context size.
2. **Checkpoint, at 55 minutes idle.** For agents with an [awt](https://github.com/tusharpandey13/awt) record, pcic sends one message starting `[pcic checkpoint]`. The agent runs `awt state`, `awt decide` and `awt note` to save where it stopped, and replies `checkpoint saved`. Agents without awt skip this step.
3. **Compact.** pcic checks the agent is still idle and sends `/compact`. Its `PreCompact` hook tells the summary what to keep. awt's `SessionStart` hook puts the task brief back right after the compaction.
4. **Return.** Your next message goes to a small context: the summary plus the awt brief.

pcic acts at most once per idle period, only when the agent is idle, only when the context is at least 100K tokens, and never after the job's deadline (3 minutes before the cache expires). It never retries a job and never answers a permission request. Everything it sends is visible in the chat.

### The cold-return guard and the card

If the timer missed (the Mac was asleep, the daemon was down, or the agent was opted out), the first prompt after the cache expired is blocked once, at no cost. The block is plain text, ending in a machine-readable card line:

```
pcic: this agent's prompt cache has likely expired (idle 2h14m; cache lasts 1h). Context about 182K tokens.
Sending now rewrites the whole context: about $1.09 (estimate; on a subscription, plan usage).
- Send the same message again: full context, no second stop.
- Or send /compact first: about $0.55 once (estimate), then the context is about 15K tokens.
- Or send /clear: start empty (the awt brief is added back when AWT_DIR is set).
Your message: "first words of your prompt"
[pcic-card v1 0123456789abcdef idle=8040000 tokens=182000 resume=1.09 compact=0.55 checkpoint=0.13 awt=1]
```

Every figure is computed from the transcript and the price table (this example is a `sonnet-4` agent: 182,000 x $6 / 1M). Slash commands, `[pcic` messages and Paseo agent, schedule and heartbeat messages pass through.

In the Paseo app, the plugin's client entry turns that block into a card, the same choice pi agents get from pcg:

```
Cache expired 134 min ago. Context: 182K tokens.
( ) Resume full context ~$1.09
( ) Continue from checkpoint ~$0.13 (new session: awt brief + your message)
( ) Compact, then send ~$0.55
( ) Resume full context (don't ask again)
( ) Continue from checkpoint (don't ask again)
[Dismiss] [Submit]
```

Your blocked prompt is kept in a file in the state dir (`cards/`, mode 0600, deleted after 24 hours) and nowhere else: never in the history or the timeline. Submit sends it for you, once:

- **Resume** sends it as it is.
- **Compact** runs `/compact`, checks that it worked, then sends it. If the compaction fails, nothing is sent and the card says so.
- **Continue from checkpoint** runs `/clear` and sends it; the awt brief is added back by the `SessionStart` hook. Without awt the option reads "Start fresh" and the new session starts with your message only.
- **Dismiss** drops the card; send your message again by hand and it goes through.

pcic sends these only when the agent is idle (a running agent answers "busy" and you can choose again), and a card answers once. Estimates are rough: the checkpoint figure assumes a fresh session starts with `freshContextTokens` tokens (20,000) at the write price.

"Don't ask again" saves `coldChoice` in `config.json`:

| `coldChoice` | What the guard does |
|---|---|
| `"ask"` (default) | Blocks once and shows the card |
| `"resume"` | Lets the prompt through (no block) |
| `"checkpoint"` | Blocks once, then pcic runs `/clear` and sends your prompt itself; the card shows a plain row saying so |

Change it back with `node bin/pcic.mjs config coldChoice ask`. Without the client entry (an older app, or a plugin installed without it) you see the plain text above and the three ways out still work. Whether the card renders for a locally installed plugin is checked live, not yet verified (SPEC V11, V13).

## Architecture

<p align="center"><img src="docs/assets/architecture.svg" alt="The pcic plugin in the Paseo daemon sends to the Claude Code agent; the agent's hooks write to the PCIC_HOME state dir, which the plugin reads; the agent records state in awt, and awt re-injects the brief after compaction" width="880"></p>

| Part | Runs in | Does |
|---|---|---|
| Plugin client (`index.client.tsx`, `client/`, `shared/`) | Paseo app | Turns the guard's block into the cold-return card and handles its buttons through the plugin RPC |
| Plugin `pcic` (`index.server.ts`, `server/`) | Paseo daemon | Tracks Claude agents, sweeps every 30 s on wall-clock time (so a sleeping Mac does not stall it), queues and runs jobs, and sends through the plugin API or, as a fallback, `paseo agent send` |
| Hook script (`hook/pcic-hook.mjs`) | each Paseo Claude agent | `Stop` writes a session record, `PreCompact` adds summary instructions, `UserPromptSubmit` is the cold-return guard, `SessionStart` (`clear`) prints the awt brief after `/clear` |
| CLI (`bin/pcic.mjs`) | your shell | `install [--uninstall]`, `doctor`, `config <key> [value]`, `hook <event>` |
| awt | unchanged | Holds the task record; its own `SessionStart` `compact` hook re-injects the brief |

The hooks act only when `PASEO_AGENT_ID` is set, so terminal Claude Code sessions are left to native idle compaction. The full contract is [SPEC.md](SPEC.md), rules R1 to R43.

## Install

Needs Node 20 or newer, Paseo 0.16.1 or newer and, for checkpoints, [awt](https://github.com/tusharpandey13/awt).

```sh
git clone https://github.com/tusharpandey13/pcic && cd pcic
npm ci
paseo plugin install "$PWD"      # the plugin, server side
paseo daemon restart
node bin/pcic.mjs install        # Claude Code hooks
awt init --hooks claude          # if not done already: the awt brief after compaction
node bin/pcic.mjs doctor
```

`pcic install` merges four entries (`UserPromptSubmit`, `Stop`, `PreCompact`, and `SessionStart` with matcher `clear`) into `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. Each command ends with `# pcic:hook`. When a `SessionStart` `clear` hook that runs `awt resume` is already there (newer awt installs its own), pcic adds no `clear` entry, so the brief is not injected twice. It is idempotent, keeps a timestamped backup (`settings.json.pcic-bak-*`, the last five) whenever it changes the file, follows a symlink, leaves every other hook alone, and refuses a file that is not valid JSON.

On first start the plugin runs a one-time self-test per Paseo version: it creates a short-lived probe agent in `$PCIC_HOME/probe/` (label `pcic=probe`), sends it `/compact`, checks the text arrived plain, and archives it. The result is kept in `verdict.json`.

## Configure

State lives in `PCIC_HOME`, default `${XDG_DATA_HOME:-~/.local/share}/pcic`. Settings go in `$PCIC_HOME/config.json`; every key is optional and a missing file means all defaults. The plugin picks up changes at the next sweep; an invalid value falls back to its default with a warning.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Global switch |
| `ttlSeconds` | `3600` | Assumed cache lifetime. The smaller of this and the TTL seen in the transcript is used |
| `idleSeconds` | `ttlSeconds - 300` (3300) | Idle time before a job is due |
| `lateGraceSeconds` | `180` | A job must start at least this long before the cache expires, or it is skipped |
| `minContextTokens` | `100000` | Smaller contexts are left alone, by both the timer and the guard |
| `guard` | `true` | The cold-return guard |
| `checkpoint` | `"awt"` | `"awt"`: checkpoint turn for agents with an awt record. `"off"`: compact only |
| `precompact` | `true` | Add summary instructions in `PreCompact` |
| `precompactExtra` | `""` | Your own text, appended to those instructions |
| `includeSubagents` | `false` | Also compact agents that have a Paseo parent |
| `exclude` | `[]` | Agent ids or cwd prefixes never handled |
| `maxConcurrent` | `2` | Jobs in flight at once |
| `staggerSeconds` | `15` | Minimum gap between job starts |
| `maxJobsPerHour` | `30` | Hard cap on job starts in a rolling hour |
| `checkpointTimeoutSeconds` | `300` | Wait for the checkpoint turn |
| `compactTimeoutSeconds` | `300` | Wait for the compaction |
| `pauseMinutes` | `60` | Pause after a rate-limit, usage-limit or auth error |
| `sweepSeconds` | `30` | Sweeper period |
| `sendMode` | `"auto"` | `"auto"` (the self-test decides), `"plugin"` or `"cli"` |
| `paseoBin` | `"paseo"` | CLI used by the fallback send mode |
| `coldChoice` | `"ask"` | `"ask"` (the card), `"resume"` (no block) or `"checkpoint"` (`/clear` and your prompt, automatically) |
| `freshContextTokens` | `20000` | Tokens a fresh session starts with; used only for the card's checkpoint estimate |
| `probeModel` | `"haiku"` | Model for the self-test agent (the cheapest Claude model); empty means Paseo's default Claude model |
| `prices` | `null` | Your own $/M prices, keyed by a substring of the model id: `{"input", "write5m", "write1h", "read", "output"}`. Used only for the guard's estimate |

To exclude one agent, give it the Paseo label `pcic=off`. To turn pcic off everywhere, set `"enabled": false`.

`$PCIC_HOME/history.jsonl` has one line per event (`scheduled`, `skipped` with a reason, `checkpoint_ok`, `compacted` with tokens before and after, `guard_block`, and so on). It never holds prompts, replies, paths or cwd. Plugin output is in `paseo plugin logs pcic`.

## Doctor

```sh
node bin/pcic.mjs doctor
```

Read-only. It checks that the four pcic hooks are installed (three when awt provides the `clear` brief), that awt's `SessionStart` `compact` hook is present, that `AWT_COMPACT_BRIEF=1` is not set (the brief would arrive twice), that `verdict.json`, `pause.json` and `config.json` are valid, and that `PCIC_HOME` is writable. Each problem prints a `fix:` line. Exit 0 when everything is ok, 1 otherwise.

## Uninstall

```sh
node bin/pcic.mjs install --uninstall   # removes only the # pcic:hook entries
paseo plugin remove pcic                # or: paseo plugin disable pcic
paseo daemon restart
rm -rf "${PCIC_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/pcic}"   # optional: state and history
```

## FAQ and limits

**Does it work with pi?** No. pcic handles only Claude Code agents in Paseo. For pi, use [pcg](https://github.com/tusharpandey13/pcg).

**Does it help with 5-minute caches?** No. pcic is built for the 1-hour cache that Paseo's Claude sessions get. When an agent's transcript shows 5-minute cache writes (for example after a Max plan limit, on usage credits), its jobs are skipped: the cache would be cold before a job could run. pcic does not keep caches warm with pings. Short caches are what pcg is for.

**Does it spend quota on agents I never come back to?** Yes. Every eligible idle agent gets one checkpoint and one compaction, whether or not you return. On the example above that is about $0.12 of API-equivalent usage for an agent you might have abandoned. Archive agents you are done with, label them `pcic=off`, or raise `minContextTokens`. `maxJobsPerHour` caps the total.

**Can it interrupt me?** pcic sends only when the agent is idle, re-checked in the same tick as the send. If you start a turn during a job, the job stops and sends nothing more. A narrow race remains between the check and the send; when a turn of yours starts within 2 s of a pcic send, `history.jsonl` records `race`.

**What if the Mac sleeps through the window?** The job is skipped once its deadline passes, and the guard catches your first message instead.

**What happens after a daemon restart?** Paseo 0.16.1 gives a plugin no start event and no client at load, so pcic starts working at the first agent event after the restart (an agent opens, finishes a turn, or asks for a permission). Until then no idle compaction runs. The cold-return guard is a Claude Code hook and works regardless: an agent that went cold meanwhile is blocked once on your next prompt, with the three ways out.

**What is not covered?** Claude Code terminal sessions (native idle compaction handles them), in-session Task subagents, and single turns that run longer than the cache lifetime.

**What has been verified live?** pcic 0.1.0 passed its whole live suite (E1 to E19, SPEC.md "Unverified" V1 to V7, V9 and V10) against an isolated Paseo 0.16.1 daemon and Claude Code on 18 and 19 Nov 2026: plugin `send()` delivers `/compact` as plain text, `Stop` fires with `PASEO_AGENT_ID`, prompts typed in the app carry no `<paseo-system>` envelope, background work and pending permissions are visible to the plugin, and a send after a daemon restart reads the cache instead of rewriting it. One figure is still an estimate: the dollar cost of `/compact` on a cold cache, which the guard's second estimate assumes (V8; the live test checks the token count only).

**Not yet verified live (0.2.0 card):**

- that the Paseo app draws the card and that a click reaches `pcic.choose` (R46). Verified live on 19 Nov 2026 against Paseo 0.16.2 and Haiku: the guard's text arrives as an `assistant_message` timeline item (V11), the plugin's client entry is bundled for a local install (V13), every choice works through the `pcic.choose` RPC (resume, compact, checkpoint, dismiss, don't ask again, already used, agent busy), and the first request after `/clear` wrote 9.2K tokens and read 13.6K from the cache (V12). The plain text stays the fallback.

## Related projects

- [awt](https://github.com/tusharpandey13/awt): the task record pcic checkpoints into and restores from.
- [pcg](https://github.com/tusharpandey13/pcg): the same idea for the pi harness, built for short 5-minute caches.

## Development

`npm test` runs the type check and the offline suite. It spends no tokens and touches no real settings. The live suite (`npm run test:e2e`) needs `PCIC_E2E=1`, runs against an isolated daemon, and spends tokens only with `PCIC_E2E_PAID=1`. See [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

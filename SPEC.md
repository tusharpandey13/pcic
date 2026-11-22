# pcic spec

`pcic` (Paseo Claude Idle Compaction) brings idle compaction to Claude Code agents that Paseo launches. Claude Code's own `idleCompaction` never fires for them: 0 of 73 compactions on this Mac were idle compactions. pcic runs one checkpoint turn while the prompt cache is still warm, which records state in awt, and then sends `/compact`. When the owner comes back, the next turn sends a summary plus the awt brief instead of rewriting the whole context. A `UserPromptSubmit` guard catches the case the timer missed (Mac asleep, daemon down, opted out) and turns a silent, expensive cold turn into an explicit choice.

This file and the three rubrics next to it are the only specs. Tests are normative where they exist. Rule ids `R1..` are referenced from `E2E-RUBRIC.md` (tiers T and E), `CHAOS-RUBRIC.md` (C) and `JOURNEYS.md` (J). The traceability table at the end must stay complete: a rule without a test is not in force.

## Problem in one rule

The only expensive event is a request against a large context whose cache has expired. On this Mac (Claude Max, verified: 33,146 Paseo `sdk-cli` requests, all 1h cache writes), each Paseo claude turn writes a cache that lives 1 hour. After a longer gap, the next prompt rewrites the full context (100K to 500K tokens) at the 1h write price. A compaction is itself a request that carries the whole history, so it is cheap only while the cache is warm. pcic therefore compacts **before** the cache expires, and never after.

## Rules

1. Hurried owner, not hostile. Protect against surprise spend and surprise behaviour, in that order.
2. Fail safe. On any doubt, send nothing and let the owner's message through. A missed compaction costs one rewrite, which the guard then shows the owner. A wrong send can interrupt work.
3. At most once. Each agent gets at most one job and one guard block per idle period. A job is never retried and never resumed after a restart.
4. Complexity is debt. One Paseo plugin (a server entry and a thin client entry for the cold-return card), one hook script, a small CLI. awt needs no changes.

## Verified facts this design relies on

| Fact | Source |
|---|---|
| Paseo runs claude through the Agent SDK `query()` with `settingSources` user, project and local, so Claude Code hooks and settings apply in Paseo sessions | verify-checks section 3 |
| Native `idleCompaction` does not run for Paseo sessions | verify-checks section 3 |
| Plugin server hooks `agent.turn.before`/`after` are notifications: Paseo does not wait for them and has no cancel | paseo-governor-coverage A |
| `agents.ref(id)` offers `send`, `run` (send plus wait for finish), `archive`, `refresh` and `lastUsage {inputTokens, cachedInputTokens, outputTokens, totalCostUsd, contextWindowMaxTokens, contextWindowUsedTokens}`. There are no cache-write tokens and no timestamps, and `lastUsage` may read zero after a daemon restart | verify-checks section 1 |
| Plugin `send()` delivers plain text: the `<paseo-system>` envelope is added only when `sourceAgentId` is set, and the plugin handle never sets it. With no source, `activeTurnBehavior` defaults to `interrupt` | plugin-send-check.md (source, Paseo 0.16.1; not yet tested live, see E2) |
| `paseo agent send <id> "/compact"` with `PASEO_AGENT_ID`, `PASEO_AGENT_CWD` and `PASEO_WORKSPACE_ID` unset compacts the session (26K down to 5K), and awt's `SessionStart` `compact` hook then injected `awt resume --hook --framed` | owner, 18-Nov |
| `UserPromptSubmit` with exit 2 shows its stderr in the Paseo chat, and the turn costs $0 | verify-checks section 4 |
| `PreCompact` stdout on exit 0 is added to the summary instructions (10,000 char cap). Exit 2 cancels the compaction | cc-native-options item 2 |

## Components

| Component | Runs in | Does |
|---|---|---|
| Plugin `pcic` (`index.server.ts`) | Paseo daemon (plugin subprocess) | Tracks claude agents, the sweeper, the job queue, the send adapter, env injection at `agent.open.before`, history, the cold-return card's RPC `pcic.choose`, the `cards/` watcher and card expiry (R47..R49) |
| Plugin client `pcic` (`index.client.tsx`, `client/`, `shared/`) | Paseo app | Timeline transformers that turn the guard's block text into the card item, and the card renderer (R45, R46) |
| Hook script `hook/pcic-hook.mjs` (plain Node, no dependencies) | Claude Code, inside each Paseo claude agent | `Stop`: writes the session record. `PreCompact`: prints summary instructions. `UserPromptSubmit`: the cold-return guard |
| CLI `bin/pcic.mjs` | the owner's shell | `install [--uninstall]` (hook entries), `doctor` (read-only checks), `config <key> [value]` (R50), `hook <event>` (what Claude Code calls) |
| awt (unchanged) | existing | `awt state/decide/note` in the checkpoint turn. The existing `SessionStart` `compact` hook (`awt init --hooks claude`) injects the framed brief after the compaction |

The plugin SDK gives the server entry no Paseo client; a hook context does. So the start-up rebuild (R37) and the sweeper begin at the first hook event after the plugin starts. That client is the plugin process's single long-lived one, so keeping it is safe.

**Limitation after a daemon restart.** Checked against the Paseo 0.16.1 plugin SDK types and the app bundle (18-Nov): there is no start, ready or daemon-boot hook. The hook names are `workspace.create/archive`, `worktree.create`, `agent.create/open/close/archive/turn/permission` and nothing else; a server entry receives only a `PluginServerContext` with no client; `handle()` RPCs and subscriptions and `registerSettings` give a client only when someone calls them. So after a restart nothing runs until an agent opens, finishes a turn, asks for a permission or is created. The cold-return guard (R31..R34) is a Claude Code hook and does not depend on the plugin, so it covers that window: an agent that went cold in the meantime is blocked once on the owner's next prompt. Revisit when the SDK adds a start hook.

The only client UI is the cold-return card (R45, R46). The checkpoint prompt and `/compact` are hidden in the chat (R52) and the agent's `checkpoint saved` reply is drawn as one grey row; the guard's message shows as the card, or as plain text when the client entry is not loaded.

## File layout

```
pcic/
  paseo-plugin.json      id "pcic", requirements paseo >= 0.16.1
  package.json           deps: @getpaseo/plugin only
  index.server.ts
  index.client.tsx       client entry: timeline transformers and the card renderer (R45, R46)
  client/cold-card.tsx   the card component (thin; React only)
  shared/cold-card.ts    pure card logic: tag parser, transformer, view model, RPC contract (no node: imports)
  server/config.ts       config file, env overrides, validation
  server/scheduler.ts    per-agent state, sweeper, queue
  server/job.ts          checkpoint + compact sequence
  server/send.ts         send adapter (plugin | cli)
  server/store.ts        state dir: claims, pending, pause, history
  hook/pcic-hook.mjs      Stop, PreCompact, UserPromptSubmit
  server/card.mjs        card file and tag line (R44), plain Node, shared by hook and plugin
  server/common.mjs      plain-Node helpers used by hook, CLI and plugin (the plugin builder accepts only client/, server/, shared/; shared/ bans node: imports)
  server/transcript.mjs tail parser shared by hook and plugin
  bin/pcic.mjs            install | doctor | hook
  test/                  tier T harness (fake clock, recorded payloads, transcript fixtures), tier E (gated)
```

State dir `PCIC_HOME`, default `${XDG_DATA_HOME:-~/.local/share}/pcic`:

| Path | Writer | Content |
|---|---|---|
| `config.json` | owner | settings (below) |
| `sessions/<agentId>.json` | Stop hook | session record (R29) |
| `claims/<agentId>.<anchorMs>` | plugin | empty file, created O_EXCL: the at-most-once marker (R11) |
| `jobs/<agentId>.json` | plugin | in-flight job `{jobId, anchor, phase, startedAt}`, removed at job end (R38) |
| `pending/<agentId>.json` | plugin | `{at, jobId}`, written just before `/compact` (R18, R30) |
| `guard/<sessionId>.json` | guard hook | `{lastAssistantUuid, at}` (R32) |
| `cards/<cardId>.json` | guard hook | the cold-return card, mode 0600, holds the owner's blocked prompt (R44). `<cardId>.used` replaces it when claimed (R47) |
| `pause.json` | plugin | `{until, reason}` (R27) |
| `history.jsonl` | plugin and hooks | event log (R40) |

Every file write goes to a temp file and is then renamed into place. Claims use `O_EXCL`. Nothing is read back from history.

## Configuration

One JSON file, `$PCIC_HOME/config.json`. The plugin rereads it when its mtime changes, at most once per sweep. The hook reads it on every call. A missing file means all defaults.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Global switch (R2) |
| `ttlSeconds` | `3600` | Assumed cache lifetime. The effective TTL is the smaller of this and the observed TTL (R7), so a test can shorten it but never lengthen it |
| `idleSeconds` | `ttlSeconds - 300` (55 min) | Idle time after the anchor before a job is due |
| `lateGraceSeconds` | `180` | A job must start at least this long before the expiry (R9) |
| `minContextTokens` | `100000` | Context-size threshold for jobs and the guard |
| `guard` | `true` | Cold-return guard on or off |
| `checkpoint` | `"awt"` | `"awt"`: checkpoint turn only for agents with an awt record. `"off"`: compact only |
| `precompact` | `true` | Print summary instructions from `PreCompact` |
| `precompactExtra` | `""` | Text appended to the instructions (owner's own wording; the tests use it for a marker token) |
| `includeSubagents` | `false` | Also compact agents that have a Paseo parent |
| `exclude` | `[]` | Agent ids or cwd prefixes never handled |
| `maxConcurrent` | `2` | Jobs in flight at once |
| `staggerSeconds` | `15` | Minimum gap between job starts |
| `maxJobsPerHour` | `30` | Hard cap; jobs beyond it are skipped |
| `checkpointTimeoutSeconds` / `compactTimeoutSeconds` | `300` / `300` | Waits |
| `pauseMinutes` | `60` | Global pause after a rate, usage or auth error (R27) |
| `sweepSeconds` | `30` | Sweeper period |
| `sendMode` | `"auto"` | `auto` or `plugin` (both mean plugin), or `cli` (manual fallback) |
| `paseoBin` | `"paseo"` | CLI used by the fallback adapter |
| `coldChoice` | `"ask"` | What the guard does when it would block: `ask` (the card, R44..R47), `resume` (pass the prompt, R31) or `checkpoint` (block, then pcic runs `/clear` and sends the prompt itself, R48) |
| `freshContextTokens` | `20000` | Tokens a fresh session starts with (Claude Code's system prompt and tools); used only for the card's `checkpoint` estimate (R44, V12) |
| `prices` | published per-model prices, filled in at implementation from the pricing page (not from memory) | $/M tokens: `input`, `write1h`, `write5m`, `read`, `output` per model family. Used only for the guard's estimate |

## State machine (per claude agent, plugin side)

| State | Entered when | Leaves to |
|---|---|---|
| `untracked` | Not eligible for good: provider not `claude`, `pcic=off` label, archived | none (archived) or `idle_wait` (label removed) |
| `active` | A foreign turn starts (`agent.turn.before`, not pcic's own) | `idle_wait` at that turn's `agent.turn.after` |
| `idle_wait {anchor, due, deadline}` | `agent.turn.after` of a foreign turn, or a rebuild at start (R37) | `queued` at `due`; `skipped(late)` past `deadline` |
| `queued` | Sweep at `due` with the pre-checks passing | `checkpoint` or `compact` at dequeue; `skipped(reason)` |
| `checkpoint` | Claim created, checkpoint sent with `run()` | `compact` on completed; `done(checkpoint_failed:<code>)`; `done(aborted_user)` |
| `compact` | Re-check passed, `/compact` sent | `done(compacted \| compact_unverified \| compact_failed)`; `done(aborted_user)` |
| `done(result)` / `skipped(reason)` | terminal for this anchor | `active` at the next foreign turn |

Skip reasons: `late`, `small`, `unknown_context`, `not_idle`, `background_work`, `subagent`, `opted_out`, `excluded`, `paused`, `rate_cap`, `ttl_5m`, `claimed`, `disabled`.

## Rules

### Scope

- **R1** The plugin acts only on agents whose `provider` is `claude`. Others get no env change, no timer and no send.
- **R2** With `enabled: false`, the plugin queues nothing and sends nothing (checked at every sweep and immediately before each send), and every hook exits 0 with no output and no write.
- **R3** The hook script does anything only when `PASEO_AGENT_ID` is set (a Paseo-launched agent) and `PCIC_OFF` is not `1`. Otherwise it exits 0 with no output and no file write. Claude Code terminal sessions are left to native idle compaction.
- **R4** Every plugin handler and every hook catches its own errors, logs each error kind once and does nothing: no send, the prompt goes through, the compaction is not cancelled.
- **R5** A number read from `lastUsage`, a transcript, a session record or the config is trusted only when it is finite and not negative. Otherwise it is unknown. A job that needs it is skipped; the guard lets the prompt through.

### Tracking and timing

- **R6** At `agent.turn.after` (any outcome) of a foreign turn of an eligible agent, the plugin sets `anchor`. That is the session record's `lastAssistantAt` when the record was written after the turn started, else the time the hook was received. Then `due = anchor + idleSeconds` and `deadline = anchor + TTL - lateGraceSeconds`. Any earlier `done` or `skipped` state ends.
- **R7** The effective TTL is the smaller of `ttlSeconds` and the observed TTL, read from the cache-write buckets of the last request in the session record (`ephemeral_1h` gives 3600, `ephemeral_5m` gives 300). With no write in that request, the last known observation holds. When the effective TTL is 300 s while `ttlSeconds` exceeds 600 (Max plan limit passed, usage credits), the agent is skipped with `ttl_5m`: its cache would be cold by the time of the job.
- **R8** A sweeper runs every `sweepSeconds` and compares wall-clock time (`Date.now()`) with each `due` and `deadline`. There is no long-lived `setTimeout` per agent: on macOS, a monotonic timer stops while the Mac sleeps.
- **R9** A job that has not started by `deadline` is skipped with `late` and never started afterwards. An anchor later than now (the clock went backwards) is set to now.
- **R10** Eligibility is checked at queueing, again at dequeue, and again immediately before each send, in the same tick as the send. The agent must be: provider `claude`; not archived; `status` `idle` or `closed` (every agent is `closed` after a daemon restart; a send reopens its session and the request still reads the cache, V5 confirmed live: 57K read, 0.4K written; `running` and `initializing` are `not_idle`) with no active turn and no pending permission; `backgroundWork` empty when Paseo reports it; no Paseo parent unless `includeSubagents`; not in a background workspace and not internal; no `pcic=off` label; not matched by `exclude`. Its context must be at least `minContextTokens`: `lastUsage.contextWindowUsedTokens` after `refresh()`, else the session record's `contextTokens`, else unknown (`unknown_context`). There must be no global pause. Any failure skips the job or ends it with the matching reason.
- **R11** Before the first send of a job, the plugin creates `claims/<agentId>.<anchorMs>` with `O_EXCL`. If the file exists the job is skipped (`claimed`), and if creating it fails the job is skipped with no send. Claims survive reloads and restarts. Claims older than 7 days are pruned at start.
- **R12** The queue runs earliest `deadline` first, at most `maxConcurrent` jobs in flight, with at least `staggerSeconds` between starts and at most `maxJobsPerHour` starts in any rolling hour (beyond that: `rate_cap`).

### The job

- **R13** The checkpoint step runs only when `checkpoint` is `"awt"` and the agent's session record has `awtDir` (`AWT_DIR` was set and was a directory at the last Stop). Otherwise the job goes straight to the compact step. Agents without awt get no extra turn: the compaction summary is their only checkpoint.
- **R14** The checkpoint text is exactly:

  ```
  [pcic checkpoint] This session has been idle; its prompt cache expires soon and the conversation will be compacted next. Do not continue the task and do not start new work. Bring the awt record up to date: run awt state --now "<what you were doing, where you stopped>" --next "<the next concrete steps>"; for each decision made since the last awt record, awt decide "<choice>" --why "<reason>"; for each fact needed later that is in no file, awt note "<fact>". Then reply with exactly one line: checkpoint saved, or checkpoint failed: <reason>.
  ```

  It is adapted from pcg's `checkpointPrompt`. The reply is short because `/compact` writes the summary, not the checkpoint.
- **R15** The checkpoint is sent with `agents.ref(id).run(text)`, which sends and then waits for the turn to finish, raced against `checkpointTimeoutSeconds`. A completed turn moves on to the compact step. A failed or canceled turn, or a timeout, ends the job with `checkpoint_failed:<code>` and nothing more is sent. `run()` reports a canceled turn as `idle`, so the outcome of the checkpoint's `agent.turn.after` is checked again after the pre-compact re-check (R17). After a timeout the turn may keep running; pcic leaves it alone. A permission request raised during the checkpoint is never answered by pcic, so it waits for the owner.
- **R16** A foreign turn is any `agent.turn.before` for the agent after the job's first send that is not pcic's own. A turn is pcic's own when its first `user_message` (the timeline entries whose `turnId` is the hook's `turnId`) starts with `[pcic checkpoint]` or is exactly `/compact`. Paseo publishes `turn_started` before it records the prompt, so with no entry for that turn yet (or no `turnId`, or no timeline), the first turn after pcic's send counts as pcic's own. A foreign turn ends the job with `aborted_user`, and nothing more is sent.
- **R17** Immediately before sending `/compact`, R10 and `now < deadline` are checked again. If either fails, the job ends with `aborted_<reason>`.
- **R18** The compact step writes `pending/<agentId>.json` and then sends exactly `/compact`, with no arguments.
- **R19** The compaction is verified when, within `compactTimeoutSeconds`, the transcript in the session record has a `compact_boundary` newer than the job start, or the timeline has a completed `compaction` item. The job then ends `compacted`, with `pre` and `post` tokens. If the turn completed with neither, it ends `compact_unverified`; a failed turn or a timeout ends `compact_failed`. There is no retry in that idle period.
- **R20** pcic's own turns never set the anchor. After a job ends, the agent stays in `done` until a foreign turn.

### Send adapter

- **R21** The adapter has two modes. `plugin` (the primary mode) uses `agents.ref(id).send` and `run`, never with a `sourceAgentId` option, so the text arrives plain, and always with `activeTurnBehavior: "steer"` (R26). `cli` is the fallback (R24). With `sendMode` set to `plugin` or `cli`, that mode is forced.
- **R22** (removed by R53) The mode is `plugin` unless `sendMode` is `cli`. There is no `verdict.json`, no startup self-test and no probe agent. `auto` and `plugin` both mean `plugin`; a `verdict.json` left by 0.2.2 or earlier is ignored.
- **R23** (removed by R53) pcic creates no agent, so there is nothing to archive and no `pcic=probe` label to exclude.
- **R24** The `cli` mode spawns `paseoBin agent send --behavior steer <id> <text>`, with arguments as an array and no shell. Its env is the plugin's env with `PASEO_AGENT_ID`, `PASEO_AGENT_CWD` and `PASEO_WORKSPACE_ID` removed. The timeout is 30 s, after which the child is killed. A non-zero exit or a timeout ends the job with `send_failed`. Completion is then awaited through `agent.turn.after` and the timeline, as in R15 and R19.
- **R25** (removed by R53) A `/compact` turn is never taken as proof that the send was enveloped, and pcic never switches to `cli` by itself. Only the owner's `sendMode` `cli` selects it.
- **R26** pcic never sends to an agent that is not idle. With no source, Paseo's default `activeTurnBehavior` is `interrupt`, so a send to a running agent would kill the owner's turn. The idle check of R10 runs in the same tick as the send, and both modes pass `steer` for the residual race: a send that loses it is added to the owner's turn instead of killing it (Paseo falls back to interrupt where a provider cannot steer). If a foreign turn starts within 2 s after a pcic send, the history gets `race` so the residual window is visible.

### Pause

- **R27** A pcic turn that fails with a rate-limit, overloaded, usage-limit or auth error code sets `pause.json` to now plus `pauseMinutes`. While the pause holds, every job is skipped with `paused`. The pause ends early when a foreign turn completes. Error codes are matched from a table, never from the message text.

### Hooks

- **R28** `pcic install` merges one entry each for `UserPromptSubmit`, `Stop` and `PreCompact`, plus a `SessionStart` entry with matcher `clear` (D5), into `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. Each command calls `bin/pcic.mjs hook <event>` by absolute path and ends with `# pcic:hook`. The `SessionStart` command is `[ -z "$AWT_DIR" ] || awt resume --hook --framed # pcic:hook`: it prints the awt brief after `/clear` and does nothing without `AWT_DIR`. Install is idempotent and makes a timestamped backup when it changes an existing file. A symlinked file is followed and its mode kept. It touches only pcic's own hook objects. `--uninstall` removes only those and leaves no empty arrays. A file that is not JSON is refused and left untouched. This is the same contract as awt's `init --hooks`. When `SessionStart` already has a hook that is not pcic's, in an entry whose matcher includes `clear`, running `awt resume` (newer awt installs one), pcic adds no `clear` entry and removes its own, so the brief is not injected twice; pcic's entry stays the fallback for awt versions without it.
- **R29** The `Stop` hook writes `sessions/<PASEO_AGENT_ID>.json`: `sessionId`, `transcriptPath`, `cwd`, `awtDir` (path, or null), `lastAssistantAt`, `lastAssistantUuid`, `contextTokens`, `model`, `ttlObserved` and `writtenAt`. All of these come from the last non-sidechain assistant entry with usage (model `<synthetic>` entries, Claude Code's zero-usage stand-ins for errors, are skipped) in at most the last 2 MB of the transcript, and `contextTokens` is input plus cache read plus cache creation. Claude Code runs `Stop` before it flushes the turn's last assistant entry (seen live): when the hook input carries `last_assistant_message`, the hook polls the tail for up to 2 s until the newest entry's text equals it (a turn with tool calls flushes several entries), or, when that message is empty, until the newest entry differs from the previous record's. It prints nothing and always exits 0.
- **R30** The `PreCompact` hook never exits 2. It prints nothing in any of these cases: `precompact` is false; the hook is inactive (R3); neither of the two cases below holds. Otherwise:
  - (a) When `AWT_DIR` is set and `awt resume --hook --framed` (run with `AWT_NO_BRIEF=1`, 3 s timeout) prints anything, the hook prints the awt-aware text below.
  - (b) Otherwise, when `pending/<agentId>.json` is under 10 min old (the compaction is pcic's), it prints the generic text below.

  `precompactExtra` is appended in both cases, and the output is capped at 2,000 characters. The awt-aware text applies to every compaction of an awt agent, including manual and automatic ones:

  ```
  pcic compaction note: this task keeps an awt record (goal, state, decisions, open questions, recent notes). It is added back to the context automatically right after this compaction, so do not restate it. The summary must keep: the user's latest request and constraints (verbatim when short); work in progress not yet in awt (files being changed with paths, commands running, partial results, errors seen); anything decided or learned since the last awt record; the next concrete step. Drop tool output already acted on and file contents that can be read again.
  ```

  The generic text:

  ```
  pcic compaction note: this conversation is being compacted because it went idle. The summary must keep: the goal; the user's latest request and constraints (verbatim when short); decisions made and why; work in progress (files with paths, commands, partial results, errors); open questions; the next concrete step. Drop tool output already acted on and file contents that can be read again.
  ```

### Guard

- **R31** The `UserPromptSubmit` guard blocks (exit 2, reason on stderr) only when all of the following hold:
  - the hook is active (R3) and `guard` is true;
  - the prompt does not start with `/` or `[pcic`, and does not contain `<paseo-system` (agent, schedule and automation messages pass);
  - the last assistant entry's time is known;
  - `now - lastAssistantAt` exceeds the effective TTL (R7, read from this transcript);
  - no `compact_boundary` is newer than that assistant entry;
  - the context is at least `minContextTokens`;
  - no once-marker (R32) exists for this `session_id` and `lastAssistantUuid`;
  - `coldChoice` is not `resume`. With `resume` the prompt passes, nothing is written except a `guard_pass_setting` history line (R48). With `checkpoint` the guard blocks as usual and marks the card `auto` (R48).
- **R32** Before blocking, the guard writes `guard/<session_id>.json` with the current `lastAssistantUuid`. If that write fails, it does not block. When the marker already holds the same `lastAssistantUuid`, the prompt passes. So one session is blocked at most once per idle gap, and never twice in a row for the same prompt.
- **R33** The block message has this form, with every figure computed and the whole message, card line included, at most 600 characters:

  ```
  pcic: this agent's prompt cache has likely expired (idle 2h14m; cache lasts 1h). Context about 182K tokens.
  Sending now rewrites the whole context: about $1.09 (estimate; on a subscription, plan usage).
  - Send the same message again: full context, no second stop.
  - Or send /compact first: about $0.55 once (estimate), then the context is about 15K tokens.
  - Or send /clear: start empty (the awt brief is added back when AWT_DIR is set).
  Your message: "first 60 characters"
  [pcic-card v1 <cardId> idle=<ms> tokens=<n> resume=<usd|-> compact=<usd|-> checkpoint=<usd|-> awt=<0|1>]
  ```

  The `/clear` line is printed always. The longest of the first 60, 40 or 20 characters of the blocked prompt that still fits is echoed on a `Your message:` line (J3.4: the block erases the prompt from the input); with none fitting the line is left out. The last line is the card line (R44); it is absent when the card file could not be written, and the text is then the plain block. With `coldChoice` `checkpoint` (R48) the three option lines are replaced by one line saying pcic continues from a checkpoint and how to change that, and the card line ends with ` auto=1`.

  The resend estimate is tokens times the write price of the observed TTL bucket. The `/compact` estimate is tokens times the input price (uncached read) plus 2,000 output tokens, which is flagged unverified (V8). With an unknown model, both `~$` figures are left out and the token counts are kept.
- **R34** The guard finishes within 1.5 s and reads at most the last 2 MB of the transcript. Any error, an unparseable transcript or the time limit gives exit 0 with no output.

### Opt-out, env, restart, logs

- **R35** An agent label `pcic=off` makes the agent `untracked` from the next sweep. At `agent.open.before` the plugin adds `PCIC_OFF=1` to the env of opted-out agents, so their hooks pass. A label added later reaches the guard at the agent's next open; the timer obeys it at the next check (R10), before any send. `exclude` works like the label.
- **R36** At `agent.open.before`, the plugin adds `PCIC_HOME` (its own value) to the env of claude agents, so the hooks of an isolated daemon find the isolated state dir. Without it, the hook uses the default `PCIC_HOME`.
- **R37** At plugin start, the plugin loads claims and pause, then lists the agents. For each eligible claude agent, the anchor is the later of `lastActivityAt` and the session record's `lastAssistantAt`, and R6 to R9 apply. Context comes from `lastUsage`, or from `contextTokens` in the session record when `lastUsage` is zero or missing (as it can be after a daemon restart).
- **R38** A `jobs/<agentId>.json` found at start belongs to a job a reload or restart cut short. It is logged `interrupted` and removed. Its claim stays, so the job is never resumed or repeated.
- **R39** The plugin's cleanup function stops the sweeper, kills any CLI child it spawned and writes nothing more.
- **R40** `history.jsonl` gets one JSON line per event: `{v:1, at, agent, event, reason?, tokens?, pre?, post?, mode?, ms?, choice?, always?}`. Events: `scheduled`, `skipped`, `checkpoint_ok`, `checkpoint_failed`, `compacted`, `compact_unverified`, `compact_failed`, `aborted`, `interrupted`, `race`, `paused`, `guard_block`, `guard_pass_marker`, `guard_pass_setting`, `precompact`, `card_choice`, `card_failed`. The optional fields `choice` (`resume`, `compact`, `checkpoint`, `dismiss`) and `always` (boolean) belong to the card events. Lines never hold prompt, reply or summary text, cwd or file paths. The file is rotated at 5 MB, keeping one `.1`. A write failure is logged once and changes no decision.
- **R41** `pcic doctor` is read-only. It checks that:
  - pcic's four hook entries are installed (three, reported as "provided by awt", when awt has its own `SessionStart` `clear` hook, R28);
  - awt's `SessionStart` `compact` entry (`# awt:context`) is present, with a warning when it is not (the awt brief would be missing after compaction);
  - `AWT_COMPACT_BRIEF` is not `1` in the daemon env, with a warning when it is (the brief would arrive twice);
  - the pause state and the config are valid;
  - `PCIC_HOME` is writable.

  It exits 0 when everything is ok and 1 on any problem.
- **R42** pcic sends on its own only two texts: the checkpoint text (R14) and `/compact`, both with a `pcic-` `messageId` (R52). The only other sends happen on the owner's click on a card (R47) or under the owner's `coldChoice` setting (R48), and are `/clear`, `/compact` and the owner's own blocked prompt, unchanged. The guard's `/clear` offer in the block text is a suggestion, never a send. pcic creates and archives no agents. It answers no permission request.
- **R43** Config: an invalid value falls back to its default with one warning naming the key, and unknown keys are warned once. A config that cannot be parsed means all defaults plus one warning. Neither stops the plugin.

### Cold-return card

The guard still blocks (exit 2): it is the only point that costs nothing, and a plugin hook cannot cancel a turn. The card is drawn over the block and turns the three ways out into one click. Design: `docs/cold-card.md`.

- **R44** When the guard blocks (R31), it also writes `cards/<cardId>.json` (mode 0600; `cardId` is 16 random hex characters) and ends the block text with the card line `[pcic-card v1 <cardId> idle=<ms> tokens=<n> resume=<usd|-> compact=<usd|-> checkpoint=<usd|-> awt=<0|1>]`, plus ` auto=1` in auto mode (R48). The card is `{v:1, cardId, agentId, sessionId, lastAssistantUuid, prompt, createdAt, model, tokens, idleMs, awt, auto, est:{resume, compact, checkpoint}}`; an estimate is null (`-` in the line) when the model is unknown. `awt` is true when `AWT_DIR` is a directory. Estimates: `resume` and `compact` as R33; `checkpoint` is (`freshContextTokens` + the awt brief + the prompt) tokens times the write price of the observed TTL bucket, where the brief is the character count of `awt resume --hook --framed` divided by 4 (measured within 600 ms when `AWT_DIR` is set, else 2,000 tokens assumed when awt is set, none when not), and the prompt is its character count divided by 4. The checkpoint figure is an estimate (V12). The prompt lives only in the card file, never in history, logs or the timeline. A card that cannot be written leaves the plain block (R33) and no card line. The guard budget (R34) covers the card.
- **R45** The client registers a timeline transformer for each item type that carries text (`user_message`, `assistant_message`, `error`, `notification`; V11 says which one carries hook stderr). An item whose text contains `pcic: this agent's prompt cache has likely expired` and ends in a valid card line (the format of R44, version 1, every field well formed) is replaced by one plugin item `pcic-cold-card` v1 holding `{cardId, idleMs, tokens, resume, compact, checkpoint, awt, auto}` and nothing else (no prompt, no text). Any other item, and any malformed line, is left alone. The transformer is synchronous and deterministic. Where the client entry is not loaded the plain text stays, and R33's three ways out still work.
- **R46** The card renderer shows `Cache expired <N> min ago. Context: <N>K tokens.`, then radio options, then `Dismiss` and `Submit`: `Resume full context ~$X`; `Continue from checkpoint ~$Y (new session: awt brief + your message)` (only with `awt`; without it `Start fresh ~$Y (new session: your message only)`); `Compact, then send ~$Z`; `Resume full context (don't ask again)`; and, only with `awt`, `Continue from checkpoint (don't ask again)`. Figures are left out when null. Submit calls the RPC `pcic.choose` (R47) and the row then shows the result: pending (`Compacting, then sending`, `Cleared, sending with the awt brief`, `Sending with full context`), done (`Sent with full context` and the like), or the error with `Your message was not sent`. A `not_idle` answer brings the options back. An auto card (R48) is a non-interactive row: `Cache expired <N> min ago. Continuing from checkpoint (your setting; change with: pcic config coldChoice ask)`. Theme colours only. All labels and texts come from `shared/cold-card.ts`, which is tested offline; `client/cold-card.tsx` only wires them to React.
- **R47** The plugin RPC `pcic.choose {cardId, choice, always}` (`choice` is `resume`, `compact`, `checkpoint` or `dismiss`) answers `{status, detail?}` with `status` one of `sent`, `dismissed`, `already_used`, `not_idle`, `expired`, `failed`. It reads `cards/<cardId>.json` (a malformed id, a missing card or a card older than 24 h is `expired`) and claims it by renaming it to `<cardId>.used`, which keeps the card without its prompt; the loser of a race, or a second click, gets `already_used`. `dismiss` deletes the card and sends nothing. For the other choices the agent must be idle (R26: provider `claude`, not archived, status `idle` or `closed`, no active turn, no pending permission, no background work, `enabled` true); otherwise nothing is sent and the claim is released (the card file is restored), answering `not_idle`. Then, with `steer` and no `sourceAgentId` (R21), and with the idle check repeated in the same tick before the prompt is sent:
  - `resume` sends the prompt unchanged. The R32 marker already holds the card's `lastAssistantUuid`, so the guard passes it;
  - `compact` writes `pending/<agentId>.json` (R30), runs `/compact` with `compactTimeoutSeconds` (R15), verifies it as R19 does, and only then sends the prompt. A failed, timed-out or unconfirmed compaction sends nothing more and answers `failed` with the reason, so the card can say the message was not sent;
  - `checkpoint` runs `/clear`, then sends the prompt. The `SessionStart` `clear` hook (R28, awt or pcic) adds the awt brief, and the guard passes the prompt because the new transcript has no assistant entry. A failed `/clear` sends nothing more.

  With `always` true and a choice of `resume` or `checkpoint`, `coldChoice` is merged into `config.json` (R50's atomic write, other keys kept) before the sends. History gets `card_choice` (`choice`, `always`) once the choice is accepted and `card_failed` (`reason`) on any failure; never the prompt. The RPC hands its client to the plugin, so a daemon restart needs no hook event first.
- **R48** With `coldChoice` `resume` the guard passes the prompt (R31) and writes `guard_pass_setting`. With `checkpoint` the guard blocks once as usual (R32), writes the card with `auto: true` and the card line with ` auto=1`, and the plugin acts on it with no click: a watcher on `cards/` (and, as the fallback, each sweep) finds each `auto` card, claims it as R47 does, runs the `checkpoint` choice with `always` false, and the second watcher event or sweep finds nothing to do. An auto card for a busy agent is released and retried by each sweep (not by the watcher, whose own events the release would cause) for 10 minutes; an older one is deleted unsent (`card_failed` reason `auto_stale`), because the owner has probably moved on. The renderer shows the non-interactive row of R46. Cards without `auto` are never acted on without a click. `coldChoice` is `ask`, `resume` or `checkpoint`; any other value falls back to `ask` (R43). **Draft change (20-Nov-2026, needs approval):** the auto checkpoint runs only when the card has `awt` true. Without an awt record a `/clear` would leave the agent with nothing to pick up from, so the guard passes the prompt as `resume` does and writes `guard_pass_setting` with `choice` `resume_no_awt`.
- **R49** The sweep deletes every file in `cards/` older than 24 hours (by the card's `createdAt`, else the file time), used or not, even before the plugin has a client. Cards survive a daemon restart, and the transformer works on refetched history, so a card whose block text is still in the history is drawn again and is usable until it is 24 hours old. Timeline rows themselves do not survive a restart.
- **R50** `pcic config <key>` prints the effective value of a config key as JSON. `pcic config <key> <value>` sets it: the value is read as JSON when it parses (`true`, `30000`) and as text otherwise (`resume`), checked against the same rules as R43, and merged into `config.json` with the atomic write of the state dir, keeping the other keys. A key that does not exist, a value that fails its check or a `config.json` that cannot be parsed gives `error:` and `fix:` lines on stderr and exit 1, and the file is left untouched; a wrong number of arguments gives the usage and exit 2. `pcic config coldChoice ask|resume|checkpoint` is the way back from a "don't ask again" choice.
- **R51** (owner, 20-Nov-2026) A checkpoint run by `coldChoice` `checkpoint` is quiet in the chat. The client transformers (R45) draw the auto card's block as one small grey row in the style of awt's rows: `pcic · continued from checkpoint · saved about $X (about $Y instead of $Z for the full context)`, where Z is the card's `resume` estimate, Y its `checkpoint` estimate and X = Z - Y; when a figure is null, or Z is not above Y, the row is just `pcic · continued from checkpoint`. It gives no idle time and no setting hint. Every text pcic sends for a card (`/clear`, `/compact`, the resent prompt) carries the Paseo `messageId` `pcic-<clear|compact|prompt>-<cardId>`, and the transformers remove (return `[]`) each `user_message` whose `messageId` starts with `pcic-`, and every `assistant_message` that is Paseo's notice `Claude switched to a new session: <old> -> <new>`. The owner's original prompt, the owner's own `/clear` and the agent's reply stay. The awt plugin's `awt · handoff [auto]` rows and Paseo's `Worked for 0s` footer of the `/clear` turn are not pcic's and stay (V14). Interactive cards (`coldChoice` `ask`) keep their layout; their pcic-sent rows are hidden the same way.
- **R52** (owner, 20-Nov-2026) The idle checkpoint job (R13..R19) is quiet in the chat too. It sends the checkpoint text with `messageId` `pcic-checkpoint-<jobId>` and `/compact` with `pcic-compact-<jobId>`, so the R51 transformers remove both rows. An `assistant_message` whose trimmed text is exactly `checkpoint saved` (any case, optional final period) is drawn as one grey row `pcic · checkpoint saved before the cache expired`. A `checkpoint failed: <reason>` reply stays as it is. The agent's `awt` tool-call rows, the awt plugin's row, Paseo's compaction marker and the `Worked for` footer are not pcic's and stay. The row is the same plugin kind as the card, with data `{note}`. R16 also counts a turn as pcic's own when its first `user_message` has a `pcic-` `messageId`.
- **R53** (owner, 20-Nov-2026) The send mode is always `plugin`. Read from the 0.16.2 daemon: the plugin's `send()` and `paseo agent send` both reach `handleSendAgentMessageRequest`, which adds the `<paseo-system` envelope only when `sourceAgentId` is set, so the two paths send the same text and only the plugin path carries a `messageId`. The self-test (R22, R23) and the automatic switch to `cli` (R25) are removed: the 19-Nov-2026 verdict `cli` was a false positive and hid nothing (R51, R52). `sendMode` `auto` and `plugin` both mean `plugin`; `cli` stays as the owner's manual fallback, without hidden rows. pcic creates no agents.
- **R54** (draft, 22-Nov-2026) The R32 marker expires. It lets a prompt pass only while `now - marker.at` is at most `markerSeconds` (default 600). `pcic.choose` `resume` (R47) rewrites the marker's `at` to now just before it sends the prompt, so a card answered hours later still passes. An expired marker counts as absent: the guard deletes the old claim for that `session_id` and `lastAssistantUuid` and blocks as R31 says, with a new card. Why: on 22-Nov-2026 agent `1a20ad34` (session `92e42b2c`, 156K tokens) was blocked on 20-Nov-2026 03:33 UTC, the owner did not resend, and the owner's next prompt 55 hours later passed on the old marker (`guard_pass_marker`) and rewrote the whole context instead of continuing from a checkpoint.

## awt are needed. pcic uses `awt state/decide/note` (the checkpoint), `awt resume --hook --framed` (the PreCompact probe) and the existing `SessionStart` `compact` entry from `awt init --hooks claude`. The verb count stays 16.

Known interaction: after the `/compact` turn, the awt plugin's stand-in handoff may record `[auto] checkpoint saved` in scope `auto`. That is harmless, because scope `auto` never replaces the agent's own state. An optional later awt change is to skip turns whose user message is `/compact` or starts `[pcic`. It is not in v1.

## Resolved decisions (owner, 18-Nov-2026)

| Id | Decision |
|---|---|
| D1 | Separate repo `pcic` (option A; B and C rejected). Remote `tusharpandey13/pcic`, created and pushed by the orchestrator, not by the build |
| D2 | (withdrawn by R53) No probe agent: the self-test is gone |
| D3 | Defaults as specified: `minContextTokens` 100000, `idleSeconds` 3300 (55 min), `maxConcurrent` 2, `maxJobsPerHour` 30 |
| D4 | A parent agent waiting on subagents is compacted anyway (R10 checks `backgroundWork`, not Paseo children) |
| D5 | The cold-return guard offers three ways out: resend, `/compact`, or `/clear` plus the awt brief. For the brief after `/clear`, `pcic install` adds its own `SessionStart` hook, matcher `clear`, running `awt resume --hook --framed` only when `AWT_DIR` is set. awt is not changed. When awt itself provides a `clear` hook, pcic's is skipped (R28) |
| D6 | Heartbeat and schedule prompts pass the guard when recognisable: they arrive with the `<paseo-system` envelope (R31) |
| D7 | Hooks are installed by merging into `settings.json` the way `awt init --hooks claude` does: never overwrite, idempotent, timestamped backup (R28) |
| D8 | The live Tier E suite is run by the owner or orchestrator after the build, never by the build agent |

## Non-goals

- pi agents (pcg covers pi), and Bedrock or 5-minute TTL cache warming or keepalive pings.
- Cost gates, budgets and per-tool estimates.
- Session swap: `/clear`, or a new agent seeded from a checkpoint plus archiving the old one.
- Return-likelihood prediction: every eligible idle agent gets one compaction.
- Client UI beyond the cold-return card (pills, toasts, a status line).
- Claude Code terminal sessions: native idle compaction covers them.
- Turns that run past the TTL (a 70-minute tool call); Claude Code in-session (Task) subagents.

## Unverified (each has a test)

| Id | Assumption | Test |
|---|---|---|
| V1 | Plugin `send()`/`run()` deliver `/compact` plain (source-confirmed only) | E2 |
| V2 | `/compact` sent through the SDK does not fire `UserPromptSubmit` (R31 passes `/` anyway) | E3 |
| V3 | Prompts typed in the Paseo app carry no `<paseo-system>` envelope | E8 |
| V4 | `Stop` fires in Paseo sessions, and `PASEO_AGENT_ID` is in the hook env | E1, E3 |
| V5 | `send` to a closed (not archived) agent after a daemon restart resumes it without an extra request | E12 (confirmed 18-Nov: the request read 57K from the cache and wrote 0.4K) |
| V6 | `backgroundWork` and pending permissions are visible on the agent handle | E18, E19, C15 (offline: the three `V6` tests in `test/scheduler.test.ts`, with fakes) |
| V7 | `compact_boundary` transcript entries carry `compactMetadata.preTokens` | E3 |
| V8 | Cost of `/compact` on a cold cache (the guard's second estimate) | E8 (tokens only; no dollar claim tested) |
| V9 | `paseo agent send` from the plugin env targets the plugin's own daemon (`PASEO_HOME`) | E13 |
| V10 | `run()` resolves when the turn ends, including failed and canceled turns | E3, C9 |
| V11 | Which timeline item type carries the hook's stderr in Paseo, and that a client transformer can replace it. **Verified 19-Nov-2026 (Paseo 0.16.2): `assistant_message`; its text is `UserPromptSubmit operation blocked by hook:`, the hook command, our block text ending in the `[pcic-card v1 ...]` line, then a blank line and `Original prompt: <prompt>` (Paseo's own echo, outside pcic's control). `findCard` scans for the last card line, so the trailer is harmless. Still unverified: that the app draws the card (no UI was driven); the client bundle holds the transformer and the renderer (V13).** | E20 |
| V12 | What a fresh session costs after `/clear` (the card's `checkpoint` estimate assumes `freshContextTokens` at the write price; the system prompt may be read from a shared cache and cost less). **Measured 19-Nov-2026 (Haiku, awt agent, first request after `/clear` and the prompt): 13,640 tokens read from the shared cache, 9,188 written (1 h bucket), 2 uncached. The estimate's 20,000 fresh tokens at the write price is therefore about 2x too high on writes; it stays as a conservative default** | E20 |
| V13 | That the Paseo plugin builder bundles `index.client.tsx` next to the server entry for a local install. **Verified 19-Nov-2026 (Paseo 0.16.2): after `paseo plugin install <checkout>`, `plugin.catalog.get` returns an 8,672-byte client bundle for `pcic` that holds the transformer ids, the `pcic-cold-card` renderer kind and the card line; the server entry loads with the method `pcic.choose` (also E20's free test)** | E20 |
| V14 | That the `messageId` pcic passes to `send()` and `run()` reaches the app's `user_message` row. Read from the 0.16.2 daemon: `recordSubmittedPrompt` copies `options.messageId` onto the row, and the Claude provider makes its own UUID for the SDK, so the tag cannot break the send. Not checked: rows rebuilt from the Claude transcript (after a daemon restart) carry the transcript's own id, so a pcic-sent row may show again there. CLI send mode cannot pass a `messageId`; its rows show | T45, E20 |

## Traceability

| Rule | Tests |
|---|---|
| R1 | T3, E15 |
| R2 | T2, J11 |
| R3 | T4, J8 |
| R4 | T28, C5, C6 |
| R5 | T36, C5, C18 |
| R6 | T5, E3, J2 |
| R7 | T6, C10, J12 |
| R8 | T7, C3, J3 |
| R9 | T7, C3, C4, J3 |
| R10 | T8, E5, E7, E16, C11, C15, J5, J6 |
| R11 | T9, E17, C1, C8, C13 |
| R12 | T10, C12, J2 |
| R13 | T11, E3, E4, J2, J13 |
| R14 | T11, E3, J2, J10 |
| R15 | T12, E3, C9, C15 |
| R16 | T13, T46, E6, C8, J4 |
| R17 | T13, C8 |
| R18 | T14, E3 |
| R19 | T15, E3, C9, C11, J2 |
| R20 | T16, E7, E17, J5 |
| R21 | T17, E2, E14 |
| R22 | T17, T47 |
| R23 | T47 |
| R24 | T19, E13, C14 |
| R25 | T47 |
| R26 | T21, C8, J4, J5 |
| R27 | T22, C10, J12 |
| R28 | T23, E1, J1 |
| R29 | T24, E3, C5 |
| R30 | T25, E3, E4, C6, J10, J13 |
| R31 | T26, T41, E8, E9, E10, J3, J6 |
| R32 | T27, E8, C13, C17 |
| R33 | T27, T37, E8 |
| R34 | T28, C5 |
| R35 | T29, E11, J7 |
| R36 | T3, E11 |
| R37 | T30, E12, C7, C18, J1, J9 |
| R38 | T31, C1, C2, C7 |
| R39 | T32, C7 |
| R40 | T33, E3, C13 |
| R41 | T34, E1, J1 |
| R42 | T35, T40, T41, T46, E3 |
| R43 | T1, C16 |
| R44 | T37, E20 |
| R45 | T38, E20 |
| R46 | T39, E20 |
| R47 | T40, E20 |
| R48 | T41, E20 |
| R49 | T42, E20 |
| R50 | T43, E20 |
| R51 | T45, E20 |
| R52 | T46 |
| R53 | T47, E2 |

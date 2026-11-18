# pcic spec

`pcic` (Paseo Claude Idle Compaction) brings idle compaction to Claude Code agents that Paseo launches. Claude Code's own `idleCompaction` never fires for them: 0 of 73 compactions on this Mac were idle compactions. pcic runs one checkpoint turn while the prompt cache is still warm, which records state in awt, and then sends `/compact`. When the owner comes back, the next turn sends a summary plus the awt brief instead of rewriting the whole context. A `UserPromptSubmit` guard catches the case the timer missed (Mac asleep, daemon down, opted out) and turns a silent, expensive cold turn into an explicit choice.

This file and the three rubrics next to it are the only specs. Tests are normative where they exist. Rule ids `R1..` are referenced from `E2E-RUBRIC.md` (tiers T and E), `CHAOS-RUBRIC.md` (C) and `JOURNEYS.md` (J). The traceability table at the end must stay complete: a rule without a test is not in force.

## Problem in one rule

The only expensive event is a request against a large context whose cache has expired. On this Mac (Claude Max, verified: 33,146 Paseo `sdk-cli` requests, all 1h cache writes), each Paseo claude turn writes a cache that lives 1 hour. After a longer gap, the next prompt rewrites the full context (100K to 500K tokens) at the 1h write price. A compaction is itself a request that carries the whole history, so it is cheap only while the cache is warm. pcic therefore compacts **before** the cache expires, and never after.

## Rules

1. Hurried owner, not hostile. Protect against surprise spend and surprise behaviour, in that order.
2. Fail safe. On any doubt, send nothing and let the owner's message through. A missed compaction costs one rewrite, which the guard then shows the owner. A wrong send can interrupt work.
3. At most once. Each agent gets at most one job and one guard block per idle period. A job is never retried and never resumed after a restart.
4. Complexity is debt. One Paseo plugin (server only), one hook script, three CLI subcommands. awt needs no changes.

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
| Plugin `pcic` (`index.server.ts`) | Paseo daemon (plugin subprocess) | Tracks claude agents, the sweeper, the job queue, the send adapter, the startup self-test, env injection at `agent.open.before` and history |
| Hook script `hook/pcic-hook.mjs` (plain Node, no dependencies) | Claude Code, inside each Paseo claude agent | `Stop`: writes the session record. `PreCompact`: prints summary instructions. `UserPromptSubmit`: the cold-return guard |
| CLI `bin/pcic.mjs` | the owner's shell | `install [--uninstall]` (hook entries), `doctor` (read-only checks), `hook <event>` (what Claude Code calls) |
| awt (unchanged) | existing | `awt state/decide/note` in the checkpoint turn. The existing `SessionStart` `compact` hook (`awt init --hooks claude`) injects the framed brief after the compaction |

The plugin SDK gives the server entry no Paseo client; a hook context does. So the start-up rebuild (R37) and the sweeper begin at the first hook event after the plugin starts. That client is the plugin process's single long-lived one, so keeping it is safe.

There is no client UI in v1. The checkpoint prompt and `/compact` are visible in the chat, and the guard's message shows there too.

## File layout

```
pcic/
  paseo-plugin.json      id "pcic", requirements paseo >= 0.16.1
  package.json           deps: @getpaseo/plugin only
  index.server.ts
  server/config.ts       config file, env overrides, validation
  server/scheduler.ts    per-agent state, sweeper, queue
  server/job.ts          checkpoint + compact sequence
  server/send.ts         send adapter (plugin | cli) and self-test
  server/store.ts        state dir: claims, pending, verdict, pause, history
  hook/pcic-hook.mjs      Stop, PreCompact, UserPromptSubmit
  shared/common.mjs      helpers for hook, CLI and plugin (the plugin builder accepts only client/, server/, shared/)
  shared/transcript.mjs  tail parser shared by hook and plugin
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
| `verdict.json` | plugin | `{paseoVersion, mode, at, tries}` (R22) |
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
| `sendMode` | `"auto"` | `auto` (the self-test decides), `plugin` or `cli` |
| `paseoBin` | `"paseo"` | CLI used by the fallback adapter |
| `probeModel` | `"haiku"` (the cheapest Claude model; Paseo passes it as `claude/haiku`) | Self-test agent model; `""` means Paseo's default Claude model |
| `prices` | published per-model prices, filled in at implementation from the pricing page (not from memory) | $/M tokens: `input`, `write1h`, `write5m`, `read`, `output` per model family. Used only for the guard's estimate |

## State machine (per claude agent, plugin side)

| State | Entered when | Leaves to |
|---|---|---|
| `untracked` | Not eligible for good: provider not `claude`, `pcic=off` label, probe agent, archived | none (archived) or `idle_wait` (label removed) |
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
- **R10** Eligibility is checked at queueing, again at dequeue, and again immediately before each send, in the same tick as the send. The agent must be: provider `claude`; not archived; `status` exactly `idle` (a `closed` agent, as every agent is after a daemon restart, is skipped `not_idle`: a send would reopen its session, which may not hit the cache, V5) with no active turn and no pending permission; `backgroundWork` empty when Paseo reports it; no Paseo parent unless `includeSubagents`; not in a background workspace and not internal; no `pcic=off` label; not matched by `exclude`. Its context must be at least `minContextTokens`: `lastUsage.contextWindowUsedTokens` after `refresh()`, else the session record's `contextTokens`, else unknown (`unknown_context`). There must be no global pause. Any failure skips the job or ends it with the matching reason.
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
- **R22** With `auto`, the mode comes from `verdict.json` when it matches the running Paseo version. With no verdict, the startup self-test (R23) runs once, 60 s after start, when no job is queued. Until there is a verdict, `plugin` is used: it is primary and confirmed from source. The verdict decides whether to switch to `cli`.
- **R23** The self-test creates a claude agent with model `probeModel` in `$PCIC_HOME/probe/` (an empty directory) with label `pcic=probe` and sends `/compact` through the plugin handle. The verdict is `plugin` when the turn's `user_message` text has no `<paseo-system` and no `assistant_message` appears within 60 s. If the envelope or a model reply appears, the verdict is `cli`. The probe agent is always archived, on every path. A self-test that errors records no verdict and tries again at the next start, at most 3 times per Paseo version, then `plugin` stays. Probe agents are `untracked` (R1, R10).
- **R24** The `cli` mode spawns `paseoBin agent send --behavior steer <id> <text>`, with arguments as an array and no shell. Its env is the plugin's env with `PASEO_AGENT_ID`, `PASEO_AGENT_CWD` and `PASEO_WORKSPACE_ID` removed. The timeout is 30 s, after which the child is killed. A non-zero exit or a timeout ends the job with `send_failed`. Completion is then awaited through `agent.turn.after` and the timeline, as in R15 and R19.
- **R25** In `plugin` mode, a `/compact` turn whose `user_message` carries the envelope, or which produced an `assistant_message`, ends the job `compact_failed` and sets the verdict to `cli` for this Paseo version.
- **R26** pcic never sends to an agent that is not idle. With no source, Paseo's default `activeTurnBehavior` is `interrupt`, so a send to a running agent would kill the owner's turn. The idle check of R10 runs in the same tick as the send, and both modes pass `steer` for the residual race: a send that loses it is added to the owner's turn instead of killing it (Paseo falls back to interrupt where a provider cannot steer). If a foreign turn starts within 2 s after a pcic send, the history gets `race` so the residual window is visible.

### Pause

- **R27** A pcic turn that fails with a rate-limit, overloaded, usage-limit or auth error code sets `pause.json` to now plus `pauseMinutes`. While the pause holds, every job is skipped with `paused`. The pause ends early when a foreign turn completes. Error codes are matched from a table, never from the message text.

### Hooks

- **R28** `pcic install` merges one entry each for `UserPromptSubmit`, `Stop` and `PreCompact`, plus a `SessionStart` entry with matcher `clear` (D5), into `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. Each command calls `bin/pcic.mjs hook <event>` by absolute path and ends with `# pcic:hook`. The `SessionStart` command is `[ -z "$AWT_DIR" ] || awt resume --hook --framed # pcic:hook`: it prints the awt brief after `/clear` and does nothing without `AWT_DIR`. Install is idempotent and makes a timestamped backup when it changes an existing file. A symlinked file is followed and its mode kept. It touches only pcic's own hook objects. `--uninstall` removes only those and leaves no empty arrays. A file that is not JSON is refused and left untouched. This is the same contract as awt's `init --hooks`. When `SessionStart` already has a hook that is not pcic's, in an entry whose matcher includes `clear`, running `awt resume` (newer awt installs one), pcic adds no `clear` entry and removes its own, so the brief is not injected twice; pcic's entry stays the fallback for awt versions without it.
- **R29** The `Stop` hook writes `sessions/<PASEO_AGENT_ID>.json`: `sessionId`, `transcriptPath`, `cwd`, `awtDir` (path, or null), `lastAssistantAt`, `lastAssistantUuid`, `contextTokens`, `model`, `ttlObserved` and `writtenAt`. All of these come from the last non-sidechain assistant entry with usage (model `<synthetic>` entries, Claude Code's zero-usage stand-ins for errors, are skipped) in at most the last 2 MB of the transcript, and `contextTokens` is input plus cache read plus cache creation. It prints nothing and always exits 0.
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
  - no once-marker (R32) exists for this `session_id` and `lastAssistantUuid`.
- **R32** Before blocking, the guard writes `guard/<session_id>.json` with the current `lastAssistantUuid`. If that write fails, it does not block. When the marker already holds the same `lastAssistantUuid`, the prompt passes. So one session is blocked at most once per idle gap, and never twice in a row for the same prompt.
- **R33** The block message has this form, with every figure computed and the whole message at most 600 characters:

  ```
  pcic: this agent's prompt cache has likely expired (idle 2h14m; cache lasts 1h). Context ~182K tokens.
  Sending now rewrites the whole context: ~$1.09 (estimate, API-equivalent; on a subscription this is plan usage).
  - Send the same message again to continue with the full context. pcic will not stop you again until the next idle gap.
  - Or send /compact first: ~$0.55 once (estimate), then the context is about 15K tokens.
  - Or send /clear: start empty; the awt brief is added back when AWT_DIR is set.
  ```

  The `/clear` line is printed always. The first 60 characters of the blocked prompt are echoed on a `Your message:` line when the whole message still fits in 600 characters (J3.4: the block erases the prompt from the input).

  The resend estimate is tokens times the write price of the observed TTL bucket. The `/compact` estimate is tokens times the input price (uncached read) plus 2,000 output tokens, which is flagged unverified (V8). With an unknown model, both `~$` figures are left out and the token counts are kept.
- **R34** The guard finishes within 1.5 s and reads at most the last 2 MB of the transcript. Any error, an unparseable transcript or the time limit gives exit 0 with no output.

### Opt-out, env, restart, logs

- **R35** An agent label `pcic=off` makes the agent `untracked` from the next sweep. At `agent.open.before` the plugin adds `PCIC_OFF=1` to the env of opted-out agents, so their hooks pass. A label added later reaches the guard at the agent's next open; the timer obeys it at the next check (R10), before any send. `exclude` works like the label.
- **R36** At `agent.open.before`, the plugin adds `PCIC_HOME` (its own value) to the env of claude agents, so the hooks of an isolated daemon find the isolated state dir. Without it, the hook uses the default `PCIC_HOME`.
- **R37** At plugin start, the plugin loads claims, verdict and pause, then lists the agents. For each eligible claude agent, the anchor is the later of `lastActivityAt` and the session record's `lastAssistantAt`, and R6 to R9 apply. Context comes from `lastUsage`, or from `contextTokens` in the session record when `lastUsage` is zero or missing (as it can be after a daemon restart).
- **R38** A `jobs/<agentId>.json` found at start belongs to a job a reload or restart cut short. It is logged `interrupted` and removed. Its claim stays, so the job is never resumed or repeated.
- **R39** The plugin's cleanup function stops the sweeper, kills any CLI child it spawned and writes nothing more.
- **R40** `history.jsonl` gets one JSON line per event: `{v:1, at, agent, event, reason?, tokens?, pre?, post?, mode?, ms?}`. Events: `scheduled`, `skipped`, `checkpoint_ok`, `checkpoint_failed`, `compacted`, `compact_unverified`, `compact_failed`, `aborted`, `interrupted`, `race`, `paused`, `probe`, `guard_block`, `guard_pass_marker`, `precompact`. Lines never hold prompt, reply or summary text, cwd or file paths. The file is rotated at 5 MB, keeping one `.1`. A write failure is logged once and changes no decision.
- **R41** `pcic doctor` is read-only. It checks that:
  - pcic's four hook entries are installed (three, reported as "provided by awt", when awt has its own `SessionStart` `clear` hook, R28);
  - awt's `SessionStart` `compact` entry (`# awt:context`) is present, with a warning when it is not (the awt brief would be missing after compaction);
  - `AWT_COMPACT_BRIEF` is not `1` in the daemon env, with a warning when it is (the brief would arrive twice);
  - the verdict, the pause state and the config are valid;
  - `PCIC_HOME` is writable.

  It exits 0 when everything is ok and 1 on any problem.
- **R42** pcic sends only three texts (the guard's `/clear` offer is a suggestion to the owner, never a send): the checkpoint text (R14), `/compact`, and the probe's `/compact`. It creates and archives only probe agents. It answers no permission request.
- **R43** Config: an invalid value falls back to its default with one warning naming the key, and unknown keys are warned once. A config that cannot be parsed means all defaults plus one warning. Neither stops the plugin.

## awt

No awt changes are needed. pcic uses `awt state/decide/note` (the checkpoint), `awt resume --hook --framed` (the PreCompact probe) and the existing `SessionStart` `compact` entry from `awt init --hooks claude`. The verb count stays 16.

Known interaction: after the `/compact` turn, the awt plugin's stand-in handoff may record `[auto] checkpoint saved` in scope `auto`. That is harmless, because scope `auto` never replaces the agent's own state. An optional later awt change is to skip turns whose user message is `/compact` or starts `[pcic`. It is not in v1.

## Resolved decisions (owner, 18-Nov-2026)

| Id | Decision |
|---|---|
| D1 | Separate repo `pcic` (option A; B and C rejected). Remote `tusharpandey13/pcic`, created and pushed by the orchestrator, not by the build |
| D2 | A short-lived probe agent is acceptable: the self-test (R23) runs once per Paseo version, as specified |
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
- Client UI (pills, toasts, a status line).
- Claude Code terminal sessions: native idle compaction covers them.
- Turns that run past the TTL (a 70-minute tool call); Claude Code in-session (Task) subagents.

## Unverified (each has a test)

| Id | Assumption | Test |
|---|---|---|
| V1 | Plugin `send()`/`run()` deliver `/compact` plain (source-confirmed only) | E2 |
| V2 | `/compact` sent through the SDK does not fire `UserPromptSubmit` (R31 passes `/` anyway) | E3 |
| V3 | Prompts typed in the Paseo app carry no `<paseo-system>` envelope | E8 |
| V4 | `Stop` fires in Paseo sessions, and `PASEO_AGENT_ID` is in the hook env | E1, E3 |
| V5 | `send` to a closed (not archived) agent after a daemon restart resumes it without an extra request | E12 |
| V6 | `backgroundWork` and pending permissions are visible on the agent handle | E7, C15 |
| V7 | `compact_boundary` transcript entries carry `compactMetadata.preTokens` | E3 |
| V8 | Cost of `/compact` on a cold cache (the guard's second estimate) | E8 (tokens only; no dollar claim tested) |
| V9 | `paseo agent send` from the plugin env targets the plugin's own daemon (`PASEO_HOME`) | E13 |
| V10 | `run()` resolves when the turn ends, including failed and canceled turns | E3, C9 |

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
| R16 | T13, E6, C8, J4 |
| R17 | T13, C8 |
| R18 | T14, E3 |
| R19 | T15, E3, C9, C11, J2 |
| R20 | T16, E7, E17, J5 |
| R21 | T17, E2, E14 |
| R22 | T17, E2, J1, J9 |
| R23 | T18, E2, C19 |
| R24 | T19, E13, C14 |
| R25 | T20 |
| R26 | T21, C8, J4, J5 |
| R27 | T22, C10, J12 |
| R28 | T23, E1, J1 |
| R29 | T24, E3, C5 |
| R30 | T25, E3, E4, C6, J10, J13 |
| R31 | T26, E8, E9, E10, J3, J6 |
| R32 | T27, E8, C13, C17 |
| R33 | T27, E8 |
| R34 | T28, C5 |
| R35 | T29, E11, J7 |
| R36 | T3, E11 |
| R37 | T30, E12, C7, C18, J1, J9 |
| R38 | T31, C1, C2, C7 |
| R39 | T32, C7 |
| R40 | T33, E3, C13 |
| R41 | T34, E1, J1 |
| R42 | T35, E3 |
| R43 | T1, C16 |

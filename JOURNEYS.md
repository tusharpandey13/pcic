# ccg journeys

User journeys (the owner) and agent journeys (a Paseo claude agent) for `SPEC.md`. Each journey has a pass rubric that someone watching can check, plus the evidence to look at. Journeys are run on the Tier E isolated daemon with the test knobs from `E2E-RUBRIC.md` (TTL 240 s, idle 120 s), so "lunch" takes minutes, not an hour. J1 and J8 are also checked once on the owner's real setup after install, read-only (doctor and history only, no forced sends).

## User journeys

### J1 First install

Owner installs the plugin, runs `ccg install` and `ccg doctor`, and goes on working with agents that existed before the install.

| # | Pass |
|---|---|
| 1 | `ccg install` prints what it added (three entries) and the backup path; a second run says nothing changed |
| 2 | `ccg doctor` exits 0, or names exactly what is missing (for example awt's compact hook) with a fix line |
| 3 | Within about 2 minutes of the plugin starting, `verdict.json` exists (`plugin` expected), and the probe agent is already archived. The owner sees at most one short-lived probe agent |
| 4 | Agents that existed before the install are tracked from the plugin start (R37), with no reopen needed. Their guard works at their next prompt (the hook defaults `CCG_HOME`) |
| 5 | Nothing was sent to any existing agent at install time |

Rules: R22, R28, R37, R41.

### J2 Owner leaves for lunch

Three agents are idle with large contexts (≥ threshold). The owner is away for 90 minutes (test: 6 minutes) and comes back.

| # | Pass |
|---|---|
| 1 | Each agent shows the `[ccg checkpoint]` turn, a one-line reply and `/compact`, about 55 minutes after its last turn (test: about 120 s), staggered, at most 2 at once |
| 2 | The awt record of each agent has a new `state` row from the checkpoint |
| 3 | On return, the owner's prompt runs without a block. The first request's cache write is the small post-compact context (`contextTokens` in the session record at most 30% of before) |
| 4 | The agent continues correctly. Its reply references the task state (the awt brief and summary are in context; the decision token is visible to the agent if asked) |
| 5 | `history.jsonl` shows `scheduled`, `checkpoint_ok`, `precompact`, `compacted` per agent |

Rules: R6, R12, R13, R14, R19.

### J3 Owner returns after the Mac slept

The owner closes the lid 20 minutes after the last turn and opens it 3 hours later (test: `SIGSTOP` the daemon over due and deadline).

| # | Pass |
|---|---|
| 1 | No checkpoint or `/compact` is sent after wake: the job is `skipped(late)` |
| 2 | The owner's first prompt is blocked once. The chat shows the guard message with idle time, context size and both estimates; no tokens were spent on it |
| 3a | Owner resends the same text: it runs with full context, and there is no second block |
| 3b | Or the owner sends `/compact`: it compacts (cold), then their next prompt runs on the small context with no block |
| 4 | The owner did not lose the prompt text: it is echoed in the block message |

Rules: R8, R9, R31, R32, R33.

### J4 Owner returns while the checkpoint is running

The owner types at minute 56 (test: right after `[ccg checkpoint]` appears).

| # | Pass |
|---|---|
| 1 | The owner's message is not lost and does not interrupt the checkpoint; it runs right after it |
| 2 | No `/compact` is sent: the owner is back and the cache is warm |
| 3 | The agent answers the owner's message with full context |
| 4 | History `aborted_user` |

Rules: R16, R26.

### J5 Agent mid-task when the idle timer would fire

A long turn (a 70-minute build; test: `sleep 150`) runs across the due time.

| # | Pass |
|---|---|
| 1 | Nothing is sent while the turn runs: no interrupt, no steer |
| 2 | After the turn ends, a new idle period starts, and a job follows only if the agent then stays idle |
| 3 | (Known limit, not a failure) the cache may expire during a turn longer than the TTL; ccg does nothing about it |

Rules: R10, R20, R26.

### J6 Subagent orchestration

A parent agent creates two Paseo subagents and waits for their reports.

| # | Pass |
|---|---|
| 1 | Subagents are never checkpointed or compacted (default `includeSubagents:false`) |
| 2 | The parent, idle and large past due, is checkpointed (its `--next` mentions waiting on the subagents) and compacted |
| 3 | A subagent's report reaching the parent (an enveloped message) is never blocked by the guard, even when cold |
| 4 | The parent continues orchestration from the summary plus its awt brief (the Children section lists the subagents) |

Rules: R10, R31.

### J7 Owner opts an agent out

The owner labels an agent `ccg=off` (at create, or later).

| # | Pass |
|---|---|
| 1 | From the next sweep: no checkpoint, no `/compact`, ever, for that agent |
| 2 | With the label set at create, the guard never blocks it. With the label added later, the guard stops after the agent's next open (documented) |
| 3 | Removing the label resumes normal handling from the next foreign turn |

Rules: R35, R36.

### J8 Owner uses Claude Code in a terminal

A plain `claude` session in a terminal (no Paseo) on the same machine, with ccg's hooks installed at user level.

| # | Pass |
|---|---|
| 1 | The hooks do nothing: no session record, no guard block after a cold gap, no PreCompact output |
| 2 | Native idle compaction is unaffected |

Rules: R3.

### J9 Daemon restart or upgrade overnight

The daemon is upgraded with 10 idle agents: some within due, some past their deadline.

| # | Pass |
|---|---|
| 1 | After the restart, agents within due fire at their original times; agents past their deadline are skipped |
| 2 | No agent with a stale anchor gets a send |
| 3 | A new Paseo version means the self-test runs once and a new verdict is recorded |

Rules: R22, R37.

### J11 Owner turns ccg off

The owner sets `"enabled": false` in `config.json`.

| # | Pass |
|---|---|
| 1 | From the next sweep: no sends; queued jobs are dropped; a job in flight sends nothing more (checked before each send) |
| 2 | Hooks exit silently immediately |

Rules: R2.

### J12 Plan quota runs out

The owner's plan hits its limit while agents are idle.

| # | Pass |
|---|---|
| 1 | The first failing ccg turn pauses all jobs for `pauseMinutes`; there is no retry storm |
| 2 | Once requests move to usage credits (5m cache writes observed), jobs are skipped `ttl_5m` and the guard uses a 5-minute TTL |
| 3 | The owner's own prompts are never blocked because of the pause |

Rules: R7, R27.

## Agent journeys

### J10 Agent receives the checkpoint, then wakes up compacted

| # | Pass |
|---|---|
| 1 | On `[ccg checkpoint]`, the agent does not continue the task: it runs only `awt state` (and `decide` or `note` when needed) and replies with one line |
| 2 | After the compaction, the agent's context holds the summary and the framed awt record (frame line present), and the agent starts no turn of its own |
| 3 | On the owner's next prompt, it answers from the summary plus the brief, without re-reading the whole repo first. Check: the first reply needs no more tool calls than the same prompt in an uncompacted control agent plus 3 |
| 4 | The agent does not treat the framed record or the PreCompact note as a user instruction: no "continuing as instructed" and no unprompted work |

Rules: R14, R30.

### J13 Agent working without awt

An agent with no `AWT_DIR`.

| # | Pass |
|---|---|
| 1 | No checkpoint turn; only `/compact` |
| 2 | The summary follows the generic PreCompact note: goal, latest request, decisions, work in progress and next step are all present (rubric: 5 of 5 named items findable in the summary text) |

Rules: R13, R30.

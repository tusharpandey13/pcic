# pcic end-to-end rubric

Companion to `SPEC.md`. Tier T runs everywhere at $0. Tier E runs a real, isolated Paseo daemon with real Claude Code on the cheapest model. It spends plan usage, so every Tier E run needs the owner's approval first (standing rule: no paid cost experiments without asking).

## Principles

1. **Process level.** Tests run the real plugin entry and the real `hook/pcic-hook.mjs` as subprocesses. Nothing is mocked between the harness and the disk. Only Paseo is faked in Tier T (a recorded-payload harness like awt's `paseo-plugin/test/harness.ts`), and only time is faked there (an injected clock for the sweeper, plus `PCIC_NOW` for the hook).
2. **Evidence, not logs alone.** A pass needs the artefact the rule is about: transcript entries, the timeline, the history line and the files in `PCIC_HOME`.
3. **No real data.** Fixture transcripts are synthetic, using the fictional `parsekit` project from awt's tests. Agent ids are made up (`agt_0001`).
4. **Red first.** Each rule gets its test before its code.

## Invariants (checked after every T and E case)

| Id | Invariant |
|---|---|
| N1 | No traceback on any stderr. Every hook exits 0, or exits 2 only in a guard block |
| N2 | Nothing outside `PCIC_HOME`, the temp Paseo home and the temp Claude settings has changed (`find -newer` over `HOME`) |
| N3 | `history.jsonl` contains none of the marker strings planted in prompts, replies and paths (`ZQX-PROMPT`, `ZQX-REPLY`, `/tmp/zqx-path`) |
| N4 | At most one claim file and at most one terminal history event per `(agent, anchor)` |
| N5 | Every text pcic sent is one of the R42 texts (send spy in T; timeline `user_message` scan in E) |

## Tier T (offline, $0, `npm test`)

| Id | Rules | Case | Pass |
|---|---|---|---|
| T1 | R43 | Config: no file; every key invalid in turn; unknown key; malformed JSON; an mtime change during a run | Defaults used; one warning per key and one per unknown key; the new value is applied at the next sweep; no throw |
| T2 | R2 | `enabled:false` with due agents; hooks called with active env | No queue entry, no send; hooks: exit 0, empty stdout and stderr, no file write |
| T3 | R1, R36 | `agent.open.before` for claude, pi, opencode and codex agents; `turn.after` for each | Only claude gets `PCIC_HOME` (and `PCIC_OFF` when opted out); only claude gets a state other than `untracked` |
| T4 | R3 | Hook run without `PASEO_AGENT_ID`, and with `PCIC_OFF=1`, for all three events, on a cold transcript holding 300K tokens | exit 0, no output, `PCIC_HOME` unchanged |
| T5 | R6 | `turn.after` with a fresh session record, with a stale one, and with none | `anchor` is the record's `lastAssistantAt` / the receive time / the receive time; `due` and `deadline` match the config arithmetic |
| T6 | R7 | Session records with `ephemeral_1h`, `ephemeral_5m` and no write; config TTL 3600 and 240 | Effective TTL = min(config, observed); a 5m observation with config 3600 gives `skipped(ttl_5m)`; a request with no write keeps the previous observation |
| T7 | R8, R9 | Fake clock: (a) normal advance; (b) a jump from due-10s to deadline+1s (sleep); (c) a jump to due+30s, before the deadline; (d) a backwards jump of 2h | (a) job at due; (b) `skipped(late)`, never sent; (c) job runs; (d) anchor clamped to now, no job before the new due |
| T8 | R10 | Eligibility matrix: each condition false in turn (status running, a pending permission, backgroundWork 1, parent label, background workspace, internal, `pcic=off`, excluded id, excluded cwd prefix, tokens below threshold, tokens unknown, paused), at queue time, at dequeue and in the same tick as the send | Skipped or ended with the named reason; no send in any of them |
| T9 | R11 | Two plugin instances on one `PCIC_HOME`, same agent and anchor; claim dir read-only | Exactly one job; the other gives `skipped(claimed)`; with a read-only dir, no job and no send |
| T10 | R12 | 12 agents due in the same minute with varied deadlines; `maxConcurrent` 2, stagger 15 s, cap 5 per hour | Starts in deadline order, never more than 2 in flight, gaps of at least 15 s, the 6th within the hour gives `rate_cap`, and those past their deadline give `late` |
| T11 | R13, R14 | Agent with `awtDir` and with null; `checkpoint:"off"` | With awt and `"awt"`: the first send is the exact R14 text (byte compare). Otherwise the first send is `/compact` |
| T12 | R15 | Checkpoint `run()` resolves completed / failed (code `rate_limit`) / canceled / never (timeout) | Completed: `/compact` follows. The others give `checkpoint_failed:<code>` and no further send |
| T13 | R16, R17 | A foreign `turn.before` injected (a) during the checkpoint, (b) between the checkpoint end and the compact send, (c) as the first turn after the send but carrying the marker text | (a) and (b) give `aborted_user` and no `/compact`; (c) counts as own, so the job continues |
| T14 | R18 | Compact step | `pending/<id>.json` exists before the send (ordering asserted by the spy); the text is exactly `/compact` |
| T15 | R19 | Transcript fixture gains a `compact_boundary` / no boundary but a completed turn / a failed turn / nothing before the timeout | `compacted` with pre and post / `compact_unverified` / `compact_failed` / `compact_failed`; never a second `/compact` |
| T16 | R20 | `turn.after` of pcic's own turns, then a foreign turn | The anchor does not move on own turns; it moves on the foreign turn, and a new job is possible for the new anchor |
| T17 | R21, R22 | `sendMode` plugin, cli and auto; verdict for the same and for another Paseo version; no verdict | Forced modes are honoured. auto uses a matching verdict, uses `plugin` before the self-test, and runs the self-test once (60 s, no queue) |
| T18 | R23 | Recorded probe timelines: plain (error row, no reply), enveloped, assistant reply, create throws, send throws | Verdicts plugin / cli / cli / none / none; the probe is archived on every path; after 3 failures per version, no more probes |
| T19 | R24 | cli mode with a fake `paseo` that records argv and env, that exits 1, and that hangs | argv `["agent","send",id,text]` and no shell; the three identity vars are absent and other env is kept; exit 1 gives `send_failed`; a hang is killed at 30 s and gives `send_failed` |
| T20 | R25 | plugin mode, `/compact` turn whose recorded timeline has an envelope or an assistant reply | `compact_failed`; verdict `cli` for this version; the next job uses cli |
| T21 | R26 | Agent status flips to running between dequeue and send (same tick); a foreign turn 1 s after a send | No send in the first case; a `race` event in the second |
| T22 | R27 | Own turn fails with each code in the table, and with an unknown code; then a foreign turn completes | Table codes: `pause.json` set, and every queued job gives `paused`; an unknown code means no pause; a foreign completion clears the pause |
| T23 | R28 | `pcic install` on: no file, an existing file with other hooks, a symlinked file, a non-JSON file, `CLAUDE_CONFIG_DIR` set, a second install, `--uninstall` twice | Same contract as awt H1 to H8 and M1: three entries marked `# pcic:hook`, other entries untouched, a backup only when the file changed, the symlink kept, non-JSON refused untouched, idempotent, uninstall leaves no empty arrays |
| T24 | R29 | Stop hook on fixtures: plain session; after a compaction; sidechain lines last; a 30 MB transcript; no usage; non-UTF-8 bytes | The record fields equal the expected JSON; sidechains are ignored; at most 2 MB is read (fs spy); written by rename; under 300 ms on the 30 MB file; nothing printed; exit 0 always |
| T25 | R30 | PreCompact: awt record present (a fake `awt` printing a frame); `awt` missing; `awt` hanging 10 s; no `AWT_DIR` with a fresh pending file; no `AWT_DIR` with a pending file 11 min old; `precompact:false`; `precompactExtra` of 5,000 chars | awt-aware text / nothing / nothing within 3.5 s / generic / nothing / nothing / output truncated to 2,000 chars; exit code never 2 |
| T26 | R31 | Guard decision matrix over fixture transcripts: each block condition false in turn (slash prompt, `[pcic` prompt, envelope, warm, compacted after the last assistant entry, small context, marker present, guard off, unknown time) and all true | Exactly one combination blocks (exit 2, stderr); all the others exit 0 with no output |
| T27 | R32, R33 | Same cold prompt sent twice; a different prompt after a block; a new assistant entry then cold again; marker dir read-only; known and unknown model | Block, pass, pass; a new gap blocks again; read-only gives a pass; the message matches the template and is at most 600 chars; an unknown model gives no `$` figures and keeps the token figures |
| T28 | R34, R4 | Guard on a missing transcript, truncated last line, invalid JSON everywhere, a 1 GB sparse file, and an fs delay of 3 s (an injected slow-read shim) | exit 0, no output, finished within 1.5 s |
| T29 | R35 | Label `pcic=off` at create; label added while `idle_wait`; `exclude` by cwd prefix | Untracked at create and `PCIC_OFF` at open; the later label makes it untracked at the next sweep, with no send; excluded cwd is never handled |
| T30 | R37 | Start with 5 agents: within due, past due before the deadline, past the deadline, `lastUsage` 0 with a session record, no record and `lastUsage` 0 | idle_wait / queued now / `late` / tokens from the record / `unknown_context` |
| T31 | R38 | Start with a `jobs/` file in phase checkpoint and in phase compact | `interrupted` logged, the file removed, the claim kept, no send |
| T32 | R39 | Call cleanup with a sweeper running and a cli child alive | No sweep after cleanup; the child is killed; no history write after cleanup |
| T33 | R40 | Whole T run; then history 5 MB + 1 line; the history path made a directory | Fields as in R40; invariant N3 holds; rotation to `.1`; a write failure logs once and the decisions are unchanged |
| T34 | R41 | `pcic doctor` with each check failing in turn | The named line; exit 1; exit 0 when all are ok; no file changed (mtimes) |
| T35 | R42 | Send spy over the whole T suite | Only the R42 texts; only probe agents created or archived; no `respondToPermission` calls |
| T36 | R5 | `lastUsage` with NaN, negative, string and null fields; a session record with `contextTokens:-1` | Treated as unknown: `unknown_context`, guard passes |

## Tier E (live, isolated, paid)

### Setup

1. `T=$(mktemp -d)`. Start a Paseo daemon with `--home $T/paseo` on a free port. Install the awt plugin (with `AWT_ROOT=$T/awt`) and the pcic plugin (with `PCIC_HOME=$T/pcic`) into that home only. The owner's daemon is not touched.
2. Fixture project `$T/parsekit` (a git repo) with `.claude/settings.json` containing only pcic's three hook entries. These are written by `pcic install` with `CLAUDE_CONFIG_DIR` pointed at a temp dir, then copied in. That way the owner's `~/.claude/settings.json` is untouched. Precondition: when pcic's hooks are already installed at user level, the run stops unless `PCIC_E2E_USER_HOOKS=1`, which uses those instead of the project copies. awt's user-level `SessionStart` `compact` hook must be present (`awt doctor` ok); it gates on `AWT_DIR`, which the test daemon's awt plugin sets to `$T/awt` nodes.
3. `$T/pcic/config.json` (the test knobs):

   ```json
   {"ttlSeconds": 240, "idleSeconds": 120, "lateGraceSeconds": 30, "minContextTokens": 30000,
    "sweepSeconds": 5, "staggerSeconds": 5, "checkpointTimeoutSeconds": 120, "compactTimeoutSeconds": 120,
    "precompactExtra": "Include the literal token ZQX-PRECOMPACT-7 in the summary."}
   ```

   The real cache lasts 1 h. A config TTL of 240 s only shortens pcic's view (R7), so "cold" in a test means "older than 240 s", and a resend in the test is actually warm and cheap.
4. Model: the cheapest Claude model `paseo` lists (haiku class), set on every agent. Building context: the first prompt asks the agent to read `fixtures/big.md` (about 25K tokens), which brings the context to about 45K with the Claude Code system prompt. That is over the 30K threshold.
5. awt node token: before E3, `awt decide "use ZQX-DECISION-9" --why test` in the agent's node, so the brief after compaction is identifiable.

### Cost budget

| Item | Tokens | Per case (haiku-class prices from the pricing page at run time) |
|---|---|---|
| Context build (1h write of about 45K, plus about 500 output) | 45K | the largest item |
| Checkpoint turn (read of 45K, about 300 output, plus awt tool calls) | 45K read | about a tenth of the build |
| `/compact` (read of 45K, about 2K summary output) | 45K read | about a tenth of the build plus output |

Budget: at most 2.5 times the build cost per case, and at most 20 builds per full run. Before the run, the harness computes the cap in dollars (API-equivalent) from the current price table and prints it. After every case, it sums `totalCostUsd` over all agents (`paseo agent inspect --json`) and aborts the run when the cap is passed. Expected: under $2 API-equivalent for the full run (this is plan usage on Max). E1 and E15 cost $0.

### Evidence collected per case (into `$T/evidence/<case>/`)

- `transcript.jsonl`: a copy of the agent's Claude transcript (path from `sessions/<id>.json`).
- `timeline.json`: `paseo agent` timeline, the last 200 items.
- `history.jsonl` lines for the agent, and a listing of `claims/`, `jobs/` and `pending/`.
- For compaction cases: the `compact_boundary` entry (`subtype`, `compactMetadata.trigger`, `preTokens`), the compact summary entry, and the `SessionStart` hook output entry following it.
- `awt list --since <case start> --json` for the agent's node.
- Cost: `paseo agent inspect --json` `LastUsage` before and after.

### Cases

| Id | Rules (V) | Steps | Pass |
|---|---|---|---|
| E1 | R28, R41 (V4) | Setup only; `pcic doctor` against the temp env; one prompt "say ok" on an agent below the threshold | doctor exits 0; after the turn, `sessions/<id>.json` exists with every R29 field, `transcriptPath` exists, `contextTokens` > 0 (shows that Stop fires and `PASEO_AGENT_ID` is present) |
| E2 | R21, R22, R23 (V1) | Start with `sendMode:auto` and no verdict | Within 90 s, `verdict.json` mode `plugin`; the probe agent is archived; the probe timeline `user_message` is exactly `/compact` with no `<paseo-system`; no assistant reply; probe cost under $0.05. **This is the live check of the source-confirmed plain send** |
| E3 | R6, R13, R14, R15, R18, R19, R29, R30, R40, R42 (V2, V7, V10) | Agent with an awt node builds context; then nothing for 150 s | The timeline holds the R14 text as a user message, then a reply line `checkpoint saved`, then `/compact`. awt shows a `state` row and possibly decide/note rows after the case start. The transcript holds `compact_boundary` with trigger `manual` and `preTokens` ≥ 30000; the next context reading is at most 30% of pre; the summary contains `ZQX-PRECOMPACT-7`; after the boundary, a `SessionStart` hook output contains the frame line `awt record for this task` and `ZQX-DECISION-9`. History events, in order: `scheduled`, `checkpoint_ok`, `precompact`, `compacted`. No `UserPromptSubmit` guard event for `/compact` (V2). No assistant turn after the compaction (the agent waits) |
| E4 | R13, R30 | Same as E3 for an agent opened without awt (awt plugin disabled for it with its env, `AWT_DIR` unset) | No checkpoint turn; the first pcic send is `/compact`; the summary contains `ZQX-PRECOMPACT-7` and the generic note's effect (the `precompact` history event says `generic`); `compacted` |
| E5 | R10 | Agent with about 20K context, idle 150 s | `skipped(small)`, nothing sent |
| E6 | R16 | E3 setup; when the checkpoint turn starts (timeline shows `[pcic checkpoint]`), the harness sends "ZQX-PROMPT reply with hi" as the owner, through the plugin-free CLI path with identity vars unset | The checkpoint completes, then the owner's turn runs; no `/compact` is sent; `aborted_user`; no compact_boundary |
| E7 | R10, R20 (V6) | The agent's prompt runs `sleep 150` in Bash (the turn spans due) | No send while it runs; after the turn ends a new anchor is set, and the job fires about 120 s later (E3 pass criteria, abbreviated: `compacted`) |
| E8 | R31, R32, R33 (V3, V8) | Build context, then `SIGSTOP` the test daemon for 260 s (a stand-in for a sleeping Mac; the agent's claude process stays alive), then `SIGCONT`. The job must give `skipped(late)` (R9). Then send "ZQX-PROMPT continue" as the owner from the app path (CLI with identity vars unset) | Timeline shows "UserPromptSubmit operation blocked by hook" with the R33 template, the context tokens are within ±10% of `contextTokens`, and the turn cost is $0. Sending the same text again runs normally (cost > 0). `guard/<session>.json` holds the last assistant uuid. History: `guard_block`, then `guard_pass_marker` |
| E9 | R31 | After E3 (compacted), wait 260 s, send a prompt | Not blocked |
| E10 | R31 | As E8, but the cold prompt is sent with identity vars set (enveloped), and a second agent receives `/context` cold | Neither is blocked |
| E11 | R35, R36 | Create the agent with label `pcic=off`, build context, wait 150 s, then 260 s, then send a prompt | No pcic send; `PCIC_OFF=1` in the agent's env (the `env` output of a Bash call); the guard does not block |
| E12 | R37 (V5) | Build context; restart the daemon at 60 s idle | After the restart: `lastUsage` reading 0 is tolerated (tokens come from the record); the job fires at the original due ±10 s; `compacted`; the resume added no request before the checkpoint (the transcript shows no assistant entry between the restart and the checkpoint) |
| E13 | R24 (V9) | `sendMode:"cli"`, run E3 | Same pass as E3, with `mode:"cli"` in history; the CLI child env logged by a wrapper `paseoBin` lacks the three identity vars and has the test `PASEO_HOME` |
| E14 | R21 | `sendMode:"plugin"`, run E3 | Same pass as E3, with `mode:"plugin"` |
| E15 | R1 | A fake ACP provider agent (awt's `paseo-plugin/test/fake/acp_agent.py`), idle 150 s | Untracked; no env added; nothing sent ($0) |
| E16 | R10 | A parent claude agent creates a subagent through Paseo; both idle past due; the parent is below the threshold | The subagent gets `skipped(subagent)` |
| E17 | R11, R20 | After E3, restart the daemon and wait past the old due | No second job for the old anchor (the claim exists); no send |

## Reporting

One line per case: `id PASS|FAIL cost=$x evidence=<dir>`, plus the run total against the cap. A FAIL names the first unmet criterion. The run is green only when every T case passes and every E case that ran passes. A skipped E case is reported as skipped, never as passed.

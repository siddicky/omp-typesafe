# omp-typesafe

A reviewer for the [omp](https://omp.sh/docs) coding agent, powered by [TypeSafe AI](https://typesafe.ai)'s
System One model (Jev). It follows omp's advisor pattern, a second set of eyes that watches the session as it
unfolds, in one of two roles, set by `role` in config (default `adversarial`):

- **`adversarial`** (default): argues the other side, that the last action or claim is wrong, unverified, or
  incomplete.
- **`advisory`**: mirrors omp's native advisor's helpful-reviewer framing: worth-checking steps, simpler
  alternatives, missed related updates, ambiguities worth clarifying, and unconsidered requirements.

Delivery (which channel a note goes out on, when it steers, dedupe, budgets) is identical between roles; only
the question battery and note wording differ. Review notes are advice: they never block a tool call. Two other
pieces can intervene, and both are described below: the [ambiguity gate](#ambiguity-gate-plan-mode) can refuse
a plan submission in plan mode until the user has been asked, and the optional [stop gate](#stop-gate) can ask
the agent to keep going. For users of the [omp-skills](https://github.com/siddicky/omp-skills) pipeline, four local
[pipeline features](#pipeline-omp-skills) make no Jev call; two of them can block a specific kind of tool call.

It also registers a `typesafe_ask` tool exposing all three TypeSafe primitives (noul, choice, score) for direct use.

Separately, once a session's context is large, it can cut stale tool output out of what each model request sends, scored
by Jev: see [Context compaction](#context-compaction).

Everything the reviewer judges is sent to TypeSafe's API, including parts of your transcript and diffs. Read
[What leaves your machine](#what-leaves-your-machine) before turning it on for a sensitive repo.

## Install

Requires omp and a `TYPESAFE_API_KEY` ([typesafe.ai](https://typesafe.ai)). Without the key the extension loads,
logs a warning, shows a notice at session start, and stays inactive; it never wedges the agent.

```sh
omp plugin install github:siddicky/omp-typesafe
export TYPESAFE_API_KEY=...
```

Or from a clone:

```sh
git clone https://github.com/siddicky/omp-typesafe && cd omp-typesafe
bun install --production
omp plugin link "$PWD"
```

`--production` installs only what the extension runs on (`@typesafe-ai/sdk`, about 230 KB). A plain `bun install` also
pulls in the omp host package and the TypeScript tooling that [Development](#development) needs for type checking:
about 1 GB the extension never loads.

Newly added extension modules need a full omp restart (`/reload-plugins` is not enough). Releases are also published
to npm as [`omp-typesafe`](https://www.npmjs.com/package/omp-typesafe) (see [Development](#development)).

## What it watches

| Trigger | What Jev judges |
|---|---|
| `tool_result` (edit, write, apply_patch, ast_edit, bash, eval, notebook, debug, task) | `breaks_contract`, `unfounded_assumption`, `incomplete_cutover`, `not_what_was_asked`, `unverified_claim`, `hidden_destruction` |
| `message_end` (assistant messages of at least `minMessageChars`, 200 by default) | `unsupported_claim`, `requirement_missed`, `risky_api`, `weak_verification`, `unnecessary_complexity` |
| `turn_end` (transcript delta since the last review) | `requirement_missed`, `weak_verification`, `unnecessary_complexity`, `silent_scope_reduction`, `risky_api` |

Every battery ends with a shared severity score (`Nothing to raise`, `Nit`, `Concern`, `Blocker`) and a
`defect_class` choice. Which tools get an action review is `adversary.tools`; the reviewer is also limited by
[`phases`](#configuration) and by the budgets below.

Details that decide whether a review happens:

- **Failed commands are reviewed.** An errored `bash` or `eval` result is judged with `exit_status: "error"`
  when omp reports a command that ran and failed: a `bash` result with a non-zero exit code or a timeout, an
  `eval` result with a cell that has a non-zero exit code. The failure itself is not a defect: the battery
  drops `unverified_claim`, the severity question asks only about damage the command already did, and an
  adversarial concern or blocker needs a side-effect question (`hidden_destruction`, `incomplete_cutover`,
  `breaks_contract`) to have fired. Other errored tools (a failed edit changed nothing) are skipped.
- **Aborted work is not reviewed (best effort).** A command or cell the user stopped, a model turn that ended
  `aborted` or `error`, and a turn whose tool batch you stopped get no review and no gate note, so a late note
  cannot restart a run you interrupted. omp ends such a turn with the usual `toolUse` stop reason, so only the
  turn's tool results show the stop, and the turn is skipped as a whole when one of them does:
  - a result omp synthesised (`details.__synthetic`: the tool never ran; `__interrupted`: it was skipped for a
    queued message), or its "not executed because the run was aborted" result for a call it never started;
  - the errored result of any tool that threw omp's `ToolAbortError`, whose whole text is `Operation aborted`
    (also `Tool call aborted`, which the browser and computer workers use, `Command aborted`, and the wording of
    the tools that give their own: `Ask tool was cancelled by the user`, `Ask input was cancelled`, `Browser open
    aborted`, `Browser tab open aborted`), so one `read`, `grep`, `task` or `ask` call in flight when you press
    Esc counts;
  - an errored `bash` or `eval` result that is not a command that ran and failed. omp throws the error of a
    stopped, blocked or exit-less command, and reports no exit code for a cancelled `eval` cell, so such a
    result is taken for a stop, with one exception: a result worded as a block (`Blocked: ...` from the bash
    interceptor, `Command blocked`), a missing exit status (`Command failed: missing exit status`) or a timeout
    (`[Command timed out after N seconds]`) was not stopped by you, and its turn is reviewed and gated as usual.
    omp's own mark of a stop outranks that wording: output that starts with `[Command cancelled]` or ends with
    `[Command aborted]` is a stop, whatever else it says. A block that an extension words differently, or an
    auto-backgrounded command that was aborted (omp then reports the job's latest output), cannot be told from a
    stop and still skips the turn.

  A command that ran and failed (a non-zero exit code or a timeout in the result's `details`) is never read for
  any of this wording: a command that prints `[Command aborted]` and then fails (a file it printed, a log) is
  still reviewed. The check relies on the result `details` that omp 18.4 sends; a host that omits them gets no
  review of failed commands.

  The limits: an error that omp words in some other way is not recognised as a stop (the turn is reviewed), and a
  review that is already in flight when you press Esc still finishes and may deliver its note, because the host
  gives the extension no abort signal to cancel it with.
- **Phases.** `phases` (`["plan", "execute"]` by default) restricts which omp mode the reviewer is active in.
  Set it to `["execute"]`, for example, to review only outside plan mode.

### Evidence

Because Jev has no tools, the extension gathers evidence deterministically before an action or turn review
(`adversary.evidence`, on by default). It is skipped for any review the call budget would suppress anyway, and
outside the phases you enabled.

- **Where and how.** `git` runs through omp's `pi.exec` from the repo root, whatever the working directory,
  with output pinned (`--no-optional-locks`, no colour, no external diff or textconv, `core.fsmonitor=false`).
  Each command gets 1.5 s and the whole collection 3 s, in parallel waves. A probe that fails or times out is
  listed as `incomplete` instead of being reported as an empty result.
- **What counts as a change.** `git status` plus a diff against `HEAD`, so staged, unstaged and untracked files
  all show up. HEAD is captured at the start of each prompt, so a commit the agent makes mid-prompt is still
  diffed; an unborn branch diffs against the empty tree. The file the reviewed action edited is diffed first.
  Lock files, minified bundles and source maps never take a diff slot. The [omp-skills](#pipeline-omp-skills) runner's
  state under `.omp/pipeline` is left out of every probe, unless `pipeline.skillAware` is `false`.
- **Missed-callsite probe.** Names whose definition was removed or renamed in the diff (function, class,
  interface, type, enum and `const` declarations, exports, methods) are searched with
  `git grep -w -F --untracked`; surviving references show up in the note as `identifier → path:line`. Reading
  the diff for those names runs on omp's one thread, outside the git deadlines, so it is bounded: it reads at
  most the first 512,000 characters and stops after 250 ms, and when it stops early `suspects` is listed as
  `incomplete`, because the names are then only those from the part it read.
- **Commands run.** Every `bash`/`eval` result of the current prompt is recorded before any gate runs, failed
  ones and those outside `adversary.tools` included, and the last few appear as `bash: bun test [failed]`.
- **What the agent sees.** The note's `evidence` attribute carries counts, `incomplete`, commands and
  `identifier → path:line` only, never repo text, so a tracked file cannot put words in front of the agent.
  Jev receives more; see [What leaves your machine](#what-leaves-your-machine).

### Notes

```
<adversarial-note severity="concern" defect="contract_break" guidance="weigh, don't blindly obey"
  breaks_contract="0.89" incomplete_cutover="0.85" confidence="0.63"
  evidence="2 uncommitted files; git grep fetchUser → b.ts:1">
Adversarial review of the last action flags contract_break (breaks_contract, incomplete_cutover). Verify or refute before building on this.
</adversarial-note>
```

With `role: "advisory"`, the same triggers instead judge `worth_checking`, `simpler_alternative`,
`related_update_needed`, `should_clarify`, `missing_consideration`, and a positive-polarity `on_track` noul; a
severity score with the native advisor's own vocabulary (`Nothing to add`, `Nit`, `Concern`, `Blocker`); and a
`theme` choice in place of `defect_class`. A step the reviewer agrees is sound (`on_track >= 0.75`) suppresses
anything below a blocker, so advisory notes appear only when there is genuinely something to raise:

```
<advisory advisor="TypeSafe" severity="concern" guidance="weigh, don't blindly obey"
  theme="update_callers" related_update_needed="0.81" evidence="...">
Another file, caller, test, or doc will need a matching change for this step to be complete (related_update_needed). Consider this before continuing.
</advisory>
```

`customType` distinguishes the two: `ai.typesafe.adversary` for the adversarial role, `ai.typesafe.advisory` for
the advisory role, so notes are countable per role after a run. Gate messages use `ai.typesafe.ambiguity`.

### Delivery

| Severity | After a tool result (action review) | After a message or turn review | In plan mode |
|---|---|---|---|
| `blocker` | `steer` with a turn trigger (interrupts) | `steer` with a turn trigger | `aside` (plan mode never steers) |
| `concern` | `aside`, or inline (below) | `steer`, or `nextTurn` when the session is idle | `aside` |
| `nit` (off unless `emitNits`) | `aside`, or inline | `nextTurn` | `aside` |

- `aside` is injected at the next step boundary and would start a turn if the session were idle, so outside plan
  mode it is used only where a model step is guaranteed to follow: after a tool result. `nextTurn` waits for
  the next prompt and never wakes an idle agent. In plan mode nothing steers and every note goes out as an aside.
- **Inline.** With `adversary.inlineActionNotes` (default), a non-blocker action note is not sent as a message;
  it is appended to the tool result instead, once, in plan mode as well. With it off, the same note goes out as
  one aside. Blockers always steer (outside plan mode) and are never inlined.
- **Quiet downgrades.** A would-be steer goes out on the quiet channel instead (`aside` after an action,
  `nextTurn` otherwise) while a recent steer's immunity window is open (`immuneTurns`), or when the severity
  answer's confidence is below `adversary.steerMinConfidence` (default 0.5). In a six-sample live probe of
  the severity score the reported confidence tracked the score: about 0.67 to 0.76 for scores of 2.7 and up, 0.53 at 2.1,
  0.27 to 0.38 at 0.7 to 1.3. Blockers therefore clear 0.5 and weaker concerns tend not to; set it to `0` to
  stop confidence from ever muting a steer. A finding downgraded this way, or by plan mode, is still delivered at
  full strength once when it can steer.

### Emission guards

| Guard | Behavior |
|---|---|
| Semantic dedupe | A note is dropped when the same questions fired on the same target at equal or lower severity. The target is the tool plus its edited paths for an action (a hash of the command for a shell command; files named in an `apply_patch` patch, and in the `[path#tag]` header lines of omp's default hashline edit mode, count as paths, also when the input was cut at 3000 characters; those header lines are read for edit-class tools only, so a bracketed line in another tool's input is not a path) and the model turn for a message or turn review, so one finding seen by `message_end` and then `turn_end` counts once, while the same question firing on a later turn's response is a new finding. Escalation passes once. Entries expire when a new prompt starts or after 6 model turns. |
| Content guard | A concern or blocker with no fired question and no classified defect or theme is dropped (`content_free`) rather than steering with an empty claim. |
| `maxNotesPerUpdate` | At most this many non-blocker notes per model turn (blockers exempt). Inline notes count. |
| `maxCallsPerTurn` | At most this many Jev calls per model turn (`call_budget`). |
| Per-prompt budgets | At most 64 Jev calls (`prompt_budget`) and 12 message reviews per user prompt. Fixed, not configurable. |
| `immuneTurns` | After a steer, further steers are downgraded for the rest of that model turn plus this many more. A turn is one model call. |

`/adversary status` shows delivered, downgraded and suppressed counts by reason.

## Ambiguity gate (plan mode)

In plan mode the agent tends to settle open product questions on the user's behalf and then submit a plan built
on those silent decisions. The ambiguity gate measures how much is still genuinely undecided and, when it is too
much, pushes the model to call omp's `ask` tool instead of guessing.

One Jev call rates four dimensions on concrete five-level rubrics (0 to 4), normalized to 0 to 1 and combined
with the deep-interview brownfield weights:

```
ambiguity = 1 - (goal*0.35 + constraints*0.25 + criteria*0.25 + context*0.15)
```

Weights are normalized by their sum, so a partial override cannot stretch the scale.

| Dimension | What is rated |
|---|---|
| `goal_clarity` | Is the primary objective statable in one sentence with named entities and no qualifier left to interpret? |
| `constraint_clarity` | Are the boundaries, non-goals, and limits clear enough that an out-of-scope change would be recognizable? |
| `criteria_clarity` | Could a test be written today: trigger, expected result, failure condition? |
| `context_clarity` | Is the existing code read and confirmed, and do the named entities map to real code structures? |

`context` is about whether the agent has read the code, so it is never asked about. It feeds the composite at
`turn_end` and `propose`, but not at `plan_start`: the raw prompt is scored before anything was read, so
`context` is low for every task and would add a constant of about 0.13 (most of the 0.2 threshold). There the
other three weights are renormalized and the reported `context` value is unchanged. For
each user-answerable dimension (goal, constraints, criteria) the same call also asks a `gap_<dim>` choice naming
the most likely missing piece and a `user_can_answer_<dim>` noul ("is something still open that only the user can
settle?"), which keeps the gate from asking about things the model should simply look up. The **weakest**
dimension is the one with the largest weighted shortfall `w * (1 - clarity)`, discounted by its
`user_can_answer`. A `target_entity` choice picks which phrase of the task the question is about; its
`(dimension, gap)` pair selects a deterministic question template, and the model is expected to rephrase it.

### When it acts

| Trigger | Behavior above threshold |
|---|---|
| `before_agent_start` in plan mode | Scores the raw first prompt. The `<ambiguity-gate>` note names the weakest dimension and a drafted question, and is attached to the request being started. Under `--plan-yolo` nothing marks the plan before the first prompt, so the first `turn_end` evaluation of a plan plays this part. |
| `turn_end` in plan mode | Rescores with the plan so far and the answers seen; the note goes out as an aside. It re-steers only for a new weakest dimension and never inside a steer's immunity window. Skipped for aborted turns and for a turn whose tool batch you stopped. |
| `tool_call` for `write` to `xd://propose` | With a UI and an active `ask` tool, the plan submission is blocked with the drafted question in the reason. At most twice per plan; after that, or with no UI or no `ask` tool, the attempt is recorded and the write proceeds. |
| `tool_result` for `ask` | In plan mode, records each answered question so later scores see it; no Jev call. Cancelled, errored and "chat about this instead" results do not count. |

Notes look like:

```
<ambiguity-gate score="0.46" threshold="0.20" weakest="constraints" gap="non_goals">
Ask the user before deciding: About “rate limiter”: what is explicitly out of scope? Offer 2-4 concrete options. Use the ask tool; do not assume.
</ambiguity-gate>
```

Rules worth knowing:

- **Plan mode detection.** The most recent signal in the whole branch wins. A `mode_change` to `plan` or a
  `plan-mode-context` message turns plan mode on; a `mode_change` to anything else, `plan-mode-reference` or
  `plan-yolo-handoff` turns it off. There is no entry window, so a long planning turn cannot push its marker
  out. Entries that turn plan mode on with no exit between them are one plan: omp appends another
  `mode_change` to `plan` when a plan is approved, so a "Refine plan" request continues the same plan and
  keeps its objective, answers and propose-block count. One host gap remains: an ACP switch to Default without
  approval writes no entry, so a stale plan stays active until another marker appears.
- **Plan text.** The plan so far is the assistant's text and tool-call previews since the plan began, with the
  content of each write to a plan file (the latest write per file) and the edits made to a plan file, in omp's
  default hashline edit mode as well, where the edit's target is named in its `[path#tag]` header lines rather than
  in a `path` field. The newest 6000 characters are kept.
- **Per-plan state.** The plan's objective is its first prompt. A steer or block leaves its question pending
  until something answers it. A later typed reply answers the pending question and spends the ask budget like
  an `ask` call does; an `ask` result settles it too. With no question pending, a typed reply is kept as
  context (`user_replies` in the scored state) and spends no budget. Asks, replies, steered dimensions, propose
  blocks and the cached repo outline reset when a new plan starts, when the plan ends, on a session switch and
  when `/tree` or `/branch` lands on a different plan. omp's ids of the plan's first entry and of its first
  prompt tell the plans apart, so moving around inside the same plan keeps its state, while a sibling branch
  with a reworded first prompt, or one that no longer holds that prompt, is a new plan (with no id to go by,
  the plan counts as new). The prompt's id exists only once the prompt has reached the branch: when the state was
  built from a prompt that never did (the turn died first), a navigation onto a branch that holds a first prompt
  of its own is a new plan as well, since no id ties that state to the old one.
- **No `ask` tool** (headless runs): the score is recorded as `would_steer` or `would_block` and nothing is sent
  or blocked.
- **Fails open.** Each evaluation reads `git status` and a repo outline (in parallel, no diffs), runs one Jev
  call, and gives up after `min(9 s, timeoutMs + 1.8 s)`, well inside omp's fail-closed `tool_call` handler
  timeout (30 s by default, `extensionHandlers.toolCallTimeoutMs`). A timeout, a throw or a Jev error is a no-op
  and never blocks a write.
- **Eligibility.** Plan mode only, `TYPESAFE_API_KEY` set, the gate enabled, and fewer than `maxAsksPerPlan`
  answers observed. It does not depend on `phases`. `/adversary off` silences it for the session, and
  `/adversary gate on|off` sets it independently.
- **Telemetry.** Each evaluation is logged with its decision: `steer`, `block`, `would_steer`, `would_block`,
  `suppressed_dedupe`, `suppressed_immune` or `none` (see `TYPESAFE_BENCH_LOG`). `/adversary status` prints the
  last score.

```json
"ambiguityGate": {
  "enabled": true,
  "threshold": 0.2,
  "weights": { "goal": 0.35, "constraints": 0.25, "criteria": 0.25, "context": 0.15 },
  "userCanAnswerFloor": 0.5,
  "maxAsksPerPlan": 3,
  "blockPropose": true,
  "timeoutMs": 2500
}
```

The rubric levels and the 0.20 threshold are starting points; the `ambiguity.scores` and `ambiguity.asksObserved`
telemetry is the data for tuning them.

## Stop gate

Off by default. With `stopGate.enabled`, when the agent wants to stop, one Jev call asks whether anything was
verified and whether stubs or TODOs remain under a completion claim. If `left_unfinished >=
unfinished_threshold` or `verified <= verified_floor`, the gate asks the agent to continue with an advisory
reason. It runs at most twice per prompt, never chains onto its own continuation (`stop_hook_active`), and stays
out of plan mode and of setups whose `phases` lack `execute`. It also needs the reviewer enabled, so
`adversary.enabled: false`, `TYPESAFE_REVIEW_ENABLED=0` and `/adversary off` turn it off too.

## Context compaction

A long session sends every old tool output with every model request. With `compaction.enabled` (on by default, and only
with a `TYPESAFE_API_KEY`), the extension asks Jev, before a request whose context is at least `compaction.minChars`
characters (150,000), whether each tool call and each tool result in the history is still needed. A result Jev gives less
than `compaction.keepThreshold` (0.2) is cut to its first 300 characters plus a note naming a file under
`<agent dir>/jev-spill/` that holds the whole output, which the agent reads back with `read` (`compaction.spill: false`
skips the file, and the cut is then final for that request). Nothing is summarized or rewritten: user and assistant text,
thinking blocks, every tool call, and the newest `compaction.preserveRecent` messages (6) go through as omp built them.
Only that one request changes: omp's `context` event replaces the messages of a single request, so the session on disk is
untouched and a wrong judgement costs one turn.

Rewriting the start of a conversation invalidates the provider's prompt cache, so decisions are remembered. With
`compaction.sticky` (on), the same tool-call-id to replacement map is re-applied on later requests and the covered part
comes back byte-identical. The context is scored again only once it has grown by `compaction.rewriteGrowth` (0.4) and
`minRequestsBetweenRewrites` (15) requests have passed, or after `maxRequestsBetweenRewrites` (40) whatever the growth. With
`sticky: false` every request is scored again, except that a session whose last request was at least `cacheCeiling` (0.8)
cache reads is left alone: rewriting it would turn a cheap cached request into a full-price one.

What it sends to TypeSafe is listed in [What leaves your machine](#what-leaves-your-machine) and is masked by
`adversary.redact`. The spill files are not masked: they hold the tool output as it was, readable by you only (mode 600 in
a mode 700 directory), and nothing prunes them. A failure (an API error, a timeout, a malformed answer) leaves that request
unreduced and is logged as `[typesafe] context compaction failed`. It does not run in subagent sessions (see
[Subagents](#subagents)). Switch it off with `compaction.enabled: false`.

It is a port of [omp-jev-compaction](https://github.com/jerryfane/omp-jev-compaction) (MIT) onto this extension's client and
config. The scoring core is vendored under `src/vendor/fast-jev/` from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT), at the commit named in its `UPSTREAM_COMMIT`.
Of upstream's two integration points only the per-request one is ported: its `session_before_compact` path declined in live
sessions, because omp had already pruned the region by then.

## Pipeline (omp-skills)

[omp-skills](https://github.com/siddicky/omp-skills) turns a vague request into parallel, critic-gated work in three
skills: `deep-interview` writes a spec (`.omp/pipeline/specs/<slug>.md`), `ralplan` a PRD (`.omp/pipeline/prd.json`), and
`dag` runs that PRD from a Python `eval` cell (`run_dag()`, `agent()`). Four features here know about it. None of them
calls Jev, none sends anything off the machine, and none needs `TYPESAFE_API_KEY`: they read the session branch, the tool
call, and for the spec check the spec file on disk. None of them approves, writes or runs anything on your behalf.
`/adversary status` has a `pipeline guards` and a `pipeline checks` line showing which are on and what they did.

| Feature | Config key | Default | Acts on |
|---|---|---|---|
| [Plan guard](#plan-guard) | `pipeline.planGuard`, env `TYPESAFE_PIPELINE_GUARD` | on | `tool_call` for `eval` |
| [Skill awareness](#skill-awareness) | `pipeline.skillAware`, `pipeline.skills` | on; `deep-interview`, `ralplan`, `dag` | `before_agent_start`, `turn_end`, `tool_call`, git evidence |
| [Spec checks](#spec-checks) | `pipeline.specChecks` | on | `tool_result` for `write`, `edit`, `apply_patch` |
| [Approval guard](#approval-guard) | `pipeline.approvalGuard` | **off** | `tool_call` for `write`, `edit`, `apply_patch`, `eval` |

All of them are dormant in [subagent sessions](#subagents), and each one fails open: an error, an unreadable file or an
input it does not recognize means the call goes ahead. The two guards are the only ones that can block a tool call; the
reason they return is what the model sees as the tool's error. They are not part of the reviewer: `/adversary off`
leaves them as they are, and each has its own config key.

### Plan guard

In plan mode, `dag`'s workers are read-only: no `write`, `bash` or `eval`, so every node that has to change a file ends
`blocked`. `dag` cannot tell that it is in plan mode (its skill only asks the model to check), and `eval` stays available
there, so a cell that calls `run_dag(` or `prepare_dag(` would run and fail. With `pipeline.planGuard` such a cell is
blocked while plan mode is active, before anything starts, with the reason

```
run_dag() cannot run in plan mode: dag workers are read-only there (no write, bash or eval), so every node would end blocked. Nothing was run. Ask the user to leave plan mode (Shift+Tab or /plan), then re-run the cell. Do not retry before they have.
```

- **Plan mode** is detected as the [ambiguity gate](#ambiguity-gate-plan-mode) detects it: the latest signal on the
  branch wins. Under `--plan-yolo` the `plan-mode-context` message marks it, so the guard applies there too.
- **A call** is `run_dag(` or `prepare_dag(` in running Python code, with or without a receiver, and inside an f-string
  field. The name in a comment, a string, a docstring or literal f-string text does not count, nor does a longer name
  (`my_run_dag(`), a bare reference (`partial(run_dag, ...)`), an import, or a `def`. A call through a computed name
  (`globals()["run_dag"](...)`) is not seen. Cells in another language never match.
- **On by default, whether or not omp-skills is installed.** The guard does not look for the skills: it reads the cell. In
  plan mode it blocks any Python `eval` cell that calls `run_dag(` or `prepare_dag(`, including a function of that name
  from your own code or another library, and a block is a failed tool call the model has to work around. The skills are
  not a precondition. To turn it off, set `"pipeline": { "planGuard": false }` in `typesafe.json`.
- **Kill switch.** `TYPESAFE_PIPELINE_GUARD=0` (also `false`, `off`, `no`) turns it off without touching the config
  file; it wins over `pipeline.planGuard`.

### Skill awareness

A `/skill:<name> args` prompt reaches the extension in one of two shapes: omp expands it into the skill's whole text
(`[IMPORTANT: User invoked the "dag" skill ...`, the body, a footer, `User: args`) in the TUI and over RPC, and passes the
raw `/skill:<name> args` in print mode. The expanded one is recorded in the session as a `skill-prompt` custom message
and not as a user message. Without this feature the skill's whole text would be scored as the plan's task, and a skill you
ran would be no turn of yours for any review. With `pipeline.skillAware`:

- **The gate stays silent** for a prompt that runs one of `pipeline.skills` (default `deep-interview`, `ralplan`, `dag`;
  names as omp writes them: a bare name matches that skill under any namespace too, which is how omp writes a name two
  providers share (`omp-skills/dag`), and a `<namespace>/<name>` entry matches only that one). The skill runs its own interview and gates:
  there is no `plan_start` score, no `<ambiguity-gate>` note and no propose block for that prompt, and the gate resumes
  with the next prompt that is not a pipeline skill. If the skill was the plan's first prompt, what you typed besides the
  skill token is the plan's objective (with nothing typed, your first message after it is).
- **A skill you invoked is your turn, and the task is what you typed.** This holds for every skill, not only the pipeline
  ones, and it is read from the `args` the session records for the invocation (`details.args` of its `skill-prompt`
  entry), never from the expanded skill text. Reviews, the stop gate and the gate use it as the task, and the transcript
  delta shows `USER: <that>`. A skill invoked with nothing typed besides its token has said nothing: it is no turn, the
  task stays your last real message, and the gate has nothing to score until you write something. A skill a subagent
  loaded on its own is nobody's prompt and is ignored.
- **The evidence leaves `.omp/pipeline` out.** The runner's and the critic's state (specs, the PRD, DAG state) is not
  your change, so the `git status`, diff and grep probes skip that directory at any depth.

`pipeline.skills: []` recognizes no skill, so the gate is never silent for one. `pipeline.skillAware: false` turns the
whole feature off and restores the extension as it was without it, for every path:

- the prompt is not read, so a skill's whole text is scored as the plan's task, as it was before, and the gate is never
  silent for a pipeline skill;
- a skill invocation is no turn of yours: the task of a review, of the stop gate and of the gate stays your last plain
  message (`args` are never used), and the transcript delta has no `USER` line for it;
- `.omp/pipeline` stays in the evidence.

The [spec check](#spec-checks) has its own switch and still counts a skill's `args` as something you said.

### Spec checks

When a `write`, `edit` or `apply_patch` to `.omp/pipeline/specs/<slug>.md` succeeds, the file is read from disk and
checked while its line 1 is not an approval:

- line 1 is `<!-- UNAPPROVED DRAFT -->`, and the header names a challenge mode, the threshold and the final ambiguity;
- the goal, fact base, locked decisions and unconfirmed assumptions are there, and `## Acceptance criteria` and
  `## Work units` are H2 headings with something under them (`None` will do for the work units, not for the criteria);
- every locked decision carries a quote (`(round N, "...")`), and the quote appears in what you said this session: your
  messages, the arguments and raw prompt of a skill you invoked, and your answers to `ask` (what you picked, typed or
  noted). Case, whitespace, curly versus straight quotes and `...` gaps are ignored; what the model said is never a source.

Problems go to the model as one note, once per spec content: a rewrite that changes nothing says nothing again, and a
fixed spec says nothing at all. It is sent as an aside (`deliverAs: "aside"`), which omp injects at the next step
boundary of the running turn. A write is always followed by a model step, so the note reaches the model before it asks
you to approve the spec; `nextTurn` would hold it until your next prompt, after the ask. That is deliberate, and it is
the [reviewer's rule](#delivery) for notes after a tool result: an aside is used only where a model step is guaranteed to follow.

```
<pipeline-check spec=".omp/pipeline/specs/rate-limit.md" problems="1" guidance="advisory; weigh, don't blindly obey">
...fix the file before you ask the user to approve it...
- line 12: could not verify the quote in anything the user said this session: "every route"
</pipeline-check>
```

It is advice: a quote that cannot be verified may predate a compaction, so the note asks the model to confirm it or move
the decision under the unconfirmed assumptions. It never blocks anything, edits the tool result or calls Jev, works in
headless runs, and is independent of `/adversary off` (`pipeline.specChecks: false` turns it off). A file that is not
recognizably a spec, an approved spec, and a table-shaped locked-decisions section are left alone. Notes are custom
messages of type `ai.typesafe.pipeline`.

### Approval guard

Off by default, because it blocks. What authorizes `ralplan`'s and `dag`'s unattended work is an approval the skills ask
for with `ask` and record as a flag, and the only thing that keeps the model from granting it to itself is the skills'
own wording. With `pipeline.approvalGuard` this extension also checks. A `write`, `edit` or `apply_patch` that

- sets a spec's line 1 to `<!-- APPROVED ... -->`, or
- sets `"approved": true` in `.omp/pipeline/prd.json` or `.omp/pipeline/dag/*.json`,

and an `eval` cell that calls `approve_file(`, is blocked unless the branch holds your answer to an `ask` that came after
the latest draft write of that same file. That answer must be exactly **Approve** (**Run** for DAG state, whose gate
offers Edit, Run and Cancel): one option picked, nothing typed under "Other", not a default omp picked when the question
timed out, and not a question with a single option. A cancelled or failed `ask` never counts. The reason is
`Approval needs the user's exact Approve answer from the ask tool.`

- **Headless** runs have no `ask` tool, so nothing is blocked: the flip is recorded as `would block` (a log line, and the
  count in `/adversary status`).
- **It never approves anything.** It only refuses a flip that has no answer behind it.
- **Not a sandbox.** It guards against honest mistakes. A `bash` command such as `sed -i`, or an `eval` cell that writes
  the marker or the flag itself, is not seen, and neither is a subagent's write. A compaction that drops the answer from
  the branch makes the next flip a block, and the model asks again. An `ask` result in a shape it does not recognize
  lets the flip through.

## Subagents

omp runs this extension's factory again in every subagent session (the `task` tool, an eval `agent()`, a DAG
worker, a critic, a scout, a `/tan` clone) and fires the same hooks inside it. Subagents that run in the parent's
process share this extension's state with it. The extension therefore stays dormant in them: every hook returns at
once, so a subagent session never reviews, never runs the gate, never touches the parent's state and never writes the
bench log. A subagent spawned in plan mode is covered the same way. An isolated agent runs a fresh copy of the
extension, which shares no state with the parent and is dormant too; the counters below live on `globalThis`, so its
skips are counted in the parent's.

Without that:

- a subagent's `session_start` would wipe the parent's ask ledger, gate scores, usage, review dedupe and `/adversary`
  overrides, and its `before_agent_start` would plant the worker's prompt as the plan's objective;
- with the reviewer on, every worker's tool results, messages and turns would be judged as well: work that doubles
  whatever already reviews the workers, notes that a worker copies into its own results, as many concurrent Jev
  calls as there are workers, and worker transcripts and diffs sent to TypeSafe;
- each subagent's shutdown would overwrite `TYPESAFE_BENCH_LOG`.

- **Still works from any session.** `typesafe_ask` (a model calls it on purpose, so a subagent's model may too),
  `/adversary` and `/typesafe`.
- **How a subagent is recognized.** By `ctx.agent`, which omp sets on every hook context: `kind: "sub"`, or a `depth`
  above 0 (which wins over `kind: "main"`). It is a non-enumerable property, so it is read by name. A host without it is asked for the session header
  instead: a `parentSession` whose directory holds the session's own file (`<parent>/<agent>.jsonl`). A fork of the
  main session records a `parentSession` too, but its file sits beside the parent's, so a fork is not mistaken for a
  subagent. A host that offers neither is treated as the main session.
- **What it shows.** `/adversary status` has a `subagent guard` line, and the bench log holds `subagentSessionsSkipped`,
  the number of distinct subagent sessions whose hooks were skipped, isolated agents included. The counts start
  over when the main session does (`/new`, `/resume`, a fork, and plan approval, which omp delivers as a session
  switch), so the bench log holds the subagents that ran since the last of those.
- **Kill switch.** `TYPESAFE_SUBAGENT_GUARD=0` (also `false`, `off`, `no`) restores the old behavior: the hooks run in
  subagent sessions too, and share the parent's state. It is an environment variable and nothing else, read on
  every hook: the config file is loaded at `session_start`, the very hook the guard skips, so a fresh copy of the
  extension in an isolated agent would never see a config key.

## Commands and tool

- `/adversary` toggles the reviewer for this session. Subcommands: `on`, `off`, `status`, `last`, `dump`,
  `role advisory|adversarial`, `gate on|off`.
  - `off` also silences the ambiguity gate (steers and propose blocks) unless `gate on` was set explicitly.
  - `role` overrides `role`/`TYPESAFE_ROLE` for the rest of the session and reloads that role's priorities.
  - `status` reports the resolved role, tools (or `none`), model and last resolved model, API key and client
    errors, delivery and suppression counts, usage and estimated cost, the gate's last score, the
    [subagent guard](#subagents) and how many subagent sessions it skipped, the [pipeline](#pipeline-omp-skills) features
    (on or off, what each blocked or sent), and config warnings.
  - `dump` writes the review history to `adversary-<session id>.json` in the `logs` folder beside the agent
    directory when that directory is named `agent` (`~/.omp/agent` gives `~/.omp/logs`), and in `<agent dir>/logs`
    otherwise. A failure is reported as an error notice.
  - Session overrides (`on`/`off`, `role`, `gate`) are cleared by `/new`, `/resume`, a fork, and plan
    "Approve and execute", which omp delivers as a session switch.
- `/typesafe test` runs one fixed probe: noul value, resolved model, latency, token usage. It cannot be
  cancelled, so it makes one try plus one retry (10 s per attempt) and gives up after 12 s in all.
- `typesafe_ask` is a read-only tool with `state` (text, or JSON with `stateFormat: "json"`), an optional
  `model`, and `questions[]` of `{ id, type: "noul"|"choice"|"score", instructions, options?, levels?, whenTrue?,
  whenFalse? }`. Question ids must be unique; a choice needs 2 to 255 options and a score 2 to 10 levels. The
  call allows 10 s per attempt and up to two retries (about 40 s in the worst case: three attempts and the waits
  between them), stops when the tool call is aborted, and sends `model` for that request only. State and
  question text are redacted like everything else that leaves, however deeply the state is nested (question ids
  and option names by pattern only, see Redaction).

Config and priority files are read at session start and again on every session switch, using the new session's
working directory.

## Configuration

`<agent dir>/typesafe.json`, where the agent dir is `~/.omp/agent` or `$PI_CODING_AGENT_DIR` when omp runs with a
profile (absent file = defaults):

```json
{
  "model": "jev-latest",
  "role": "adversarial",
  "phases": ["plan", "execute"],
  "adversary": {
    "enabled": true,
    "reviewActions": true,
    "reviewMessages": true,
    "reviewTurns": true,
    "tools": ["edit", "write", "apply_patch", "ast_edit", "bash", "eval", "notebook", "debug", "task"],
    "inlineActionNotes": true,
    "evidence": true,
    "redact": true,
    "noul_floor": 0.45,
    "concern_severity": 1.5,
    "blocker_severity": 2.5,
    "emitNits": false,
    "maxNotesPerUpdate": 4,
    "maxCallsPerTurn": 8,
    "immuneTurns": 3,
    "steerMinConfidence": 0.5,
    "minMessageChars": 200,
    "timeoutMs": 1500
  },
  "stopGate": { "enabled": false, "unfinished_threshold": 0.7, "verified_floor": 0.25 },
  "ambiguityGate": {
    "enabled": true,
    "threshold": 0.2,
    "weights": { "goal": 0.35, "constraints": 0.25, "criteria": 0.25, "context": 0.15 },
    "userCanAnswerFloor": 0.5,
    "maxAsksPerPlan": 3,
    "blockPropose": true,
    "timeoutMs": 2500
  },
  "pipeline": {
    "planGuard": true,
    "skillAware": true,
    "skills": ["deep-interview", "ralplan", "dag"],
    "specChecks": true,
    "approvalGuard": false
  },
  "compaction": {
    "enabled": true,
    "keepThreshold": 0.2,
    "minChars": 150000,
    "spill": true,
    "preserveRecent": 6,
    "sticky": true,
    "rewriteGrowth": 0.4,
    "minRequestsBetweenRewrites": 15,
    "maxRequestsBetweenRewrites": 40,
    "cacheCeiling": 0.8,
    "timeoutMs": 10000
  }
}
```

| Key | Meaning |
|---|---|
| `model` | Jev model sent with every review and gate request. `TYPESAFE_DEFAULT_MODEL` is the default when the file sets none. |
| `role` | `"adversarial"` (default) or `"advisory"`; see [Notes](#notes). |
| `phases` | Which omp mode(s) the reviewer is active in: `"plan"`, `"execute"`, or both. |
| `adversary.enabled`, `reviewActions`, `reviewMessages`, `reviewTurns` | Master switch and one switch per trigger. |
| `adversary.tools` | Tools that get an action review. Names are exact and case-sensitive. `[]` reviews no tools. An absent key, a non-array, or a list with nothing usable falls back to the default. A mis-cased known name is corrected with a warning; any other name (an MCP tool, say) is kept as written, silently, and a misspelled one simply never matches. |
| `adversary.inlineActionNotes` | Attach non-blocker action notes to the tool result instead of sending a message. |
| `adversary.evidence` | Collect git evidence before action and turn reviews. |
| `adversary.redact` | Mask obvious secrets in everything sent to TypeSafe; see [What leaves your machine](#what-leaves-your-machine). |
| `adversary.noul_floor` | A question counts as fired at or above this probability. |
| `adversary.concern_severity`, `blocker_severity` | Severity score cut-offs (0 to 3). `concern_severity` is never above `blocker_severity`: an inverted pair is repaired with a warning. |
| `adversary.emitNits`, `maxNotesPerUpdate`, `maxCallsPerTurn`, `immuneTurns` | See [Emission guards](#emission-guards). |
| `adversary.steerMinConfidence` | A steer whose severity answer reports less confidence than this goes out quietly instead (0 to 1; see [Delivery](#delivery)). |
| `adversary.minMessageChars` | Shorter assistant messages are not reviewed. |
| `adversary.timeoutMs` | Per review, with no retries. |
| `stopGate.*` | See [Stop gate](#stop-gate). |
| `ambiguityGate.*` | See [Ambiguity gate](#ambiguity-gate-plan-mode). The gate is eligible only while fewer than `maxAsksPerPlan` answers have been observed, so `0` keeps it silent. |
| `pipeline.planGuard`, `skillAware`, `specChecks`, `approvalGuard` | One switch per [pipeline feature](#pipeline-omp-skills). Two of them can block a tool call: `planGuard`, which is on by default (with or without omp-skills installed; see [Plan guard](#plan-guard)), and `approvalGuard`, which is off. |
| `pipeline.skills` | Skill names `skillAware` treats as pipeline skills. Case-sensitive, trimmed, each kept once. A bare name also matches that skill under any namespace (`dag` matches `omp-skills/dag`); a `<namespace>/<name>` entry matches only that one. `[]` recognizes none. An absent key, a non-array, or a list with nothing usable falls back to the default. |
| `compaction.*` | See [Context compaction](#context-compaction). `keepThreshold` and `cacheCeiling` are 0 to 1, `rewriteGrowth` 0 to 10, `timeoutMs` 250 to 60000 per request to Jev (no retries). |

Numeric values are clamped to their valid ranges, and unknown or mistyped values fall back to the default.
If `typesafe.json` exists but cannot be read or parsed, the config fails closed: the reviewer, the stop gate, the
ambiguity gate and context compaction are all off until the file parses, and a warning says why. The pipeline features cost nothing and
keep their defaults. Config warnings (repairs, rejected
environment values, a failed load) are shown as a notice at session start and on each session switch, and in
`/adversary status`.

If review feels chatty, set `reviewMessages: false` first, then narrow `adversary.tools` to the editing tools.

### Environment

These win over the config file. They are applied in order once the file (or its absence) is resolved. Boolean
values are trimmed, case-insensitive, and accept `1`/`0`, `true`/`false`, `on`/`off`, `yes`/`no`; an
unrecognized value is ignored with a warning.

| Variable | Effect |
|---|---|
| `TYPESAFE_API_KEY` | Required for any Jev call. Read by the SDK. |
| `TYPESAFE_CONFIG` | An alternate config file path, read instead of `<agent dir>/typesafe.json`. |
| `PI_CODING_AGENT_DIR` | omp's active profile directory. Moves `typesafe.json`, the user-level priority files, the `/adversary dump` location and the compaction spill directory. |
| `TYPESAFE_ROLE` | `"advisory"` or `"adversarial"`; overrides `role`. |
| `TYPESAFE_REVIEW_ENABLED` | Sets `adversary.enabled`. Also turns the stop gate off when false. |
| `TYPESAFE_AMBIGUITY_GATE` | Sets `ambiguityGate.enabled`. |
| `TYPESAFE_AMBIGUITY_THRESHOLD` | A number from 0 to 1; overrides `ambiguityGate.threshold`. Anything else is ignored with a warning. |
| `TYPESAFE_PIPELINE_GUARD` | Sets `pipeline.planGuard`: `0`, `false`, `off` or `no` is the kill switch for the [plan guard](#plan-guard), which blocks `run_dag(` in plan mode. |
| `TYPESAFE_DEFAULT_MODEL` | Model to use when the config file sets none. |
| `TYPESAFE_BASE_URL` | API root for the SDK. Default `https://api.typesafe.ai`. |
| `TYPESAFE_LOG_LEVEL` | Ignored by this extension: the SDK client is pinned to `warn` so a stray `debug` cannot print request bodies. SDK output goes to omp's logger. |
| `TYPESAFE_SUBAGENT_GUARD` | `0`, `false`, `off` or `no` switches the [subagent guard](#subagents) off: the hooks then run in subagent sessions too, sharing the parent's state. Default on; an unrecognized value leaves it on, with a warning at session start. Not a config key: it is read from the environment on every hook. |
| `TYPESAFE_BENCH_LOG` | A file path. On session shutdown, writes `{ role, phases, stats, usage, costUsd, lastResolvedModel, history, historyDropped, config, ambiguity, subagentSessionsSkipped }` as JSON to it (reviewer telemetry for a single run, used by [the bench](bench/README.md)). `role` and `config` are the effective values, session overrides included; `history` holds up to 2000 review records and `historyDropped` counts any evicted beyond that; `subagentSessionsSkipped` is the number of subagent sessions the extension ignored since the main session last started or switched (plan approval is a switch). Only the main session writes it. Unset by default; a write failure is logged, never thrown. |

### Review priorities

Put an `ADVERSARY.md` in the repo, or in `.omp/` of any directory from the working directory up to the git
root, or at `<agent dir>/ADVERSARY.md` for every project. The advisory role reads `WATCHDOG.md` the same way
instead (the same file omp's native advisor reads, so one file can drive both reviewers). Nothing is installed
automatically: starter files for both live in `assets/`; copy the one you want to the agent directory and edit it.

Files are ranked most specific first: `<cwd>/.omp/`, `<cwd>/`, each parent up to the git root (or `$HOME`), then
the user-level file. They share a 2000-character budget: a short file is kept whole, long files split what is
left and are cut at a line boundary with a `[truncated]` marker, and the least specific files are dropped
first. If the walk up reaches the filesystem root without meeting `$HOME` or a git root, only the working
directory is read, because ancestors such as `/tmp` are writable by other users. The text is sent with every
review as `review_priorities`.

## What leaves your machine

Reviews run on TypeSafe's hosted API (`https://api.typesafe.ai` through `@typesafe-ai/sdk`), in addition to
whatever your coding agent already sends to its own model provider. The extension sends only the fields below,
each capped:

| Request | Content sent |
|---|---|
| Action review | The task (last user turn, 1200 chars: your message, or, with `pipeline.skillAware`, what you typed after a `/skill:` token), your priorities file text (2000), the tool name and input (3000), the tool result (2000), the exit status, the agent's last claim (800), the previous 3 tool results, and evidence |
| Message review | The task, priorities, the assistant message (4000), the last 5 actions |
| Turn review | The task, priorities, the transcript delta since the last review (6000: user and assistant text, tool-call previews, result first lines), and evidence |
| Evidence | `git status` (1000), `--stat` (800), up to 3 file diffs (2000 each), for up to 5 removed names the matching `git grep` hits (10 per name, 200 chars each, from any tracked or untracked file except `.omp/pipeline`, unless `pipeline.skillAware` is off), the commands run, and what is `incomplete` |
| Ambiguity gate | The plan's first prompt (4000), the plan text so far (6000, including the plan being submitted), the questions asked and answers received, typed replies that answered no question (up to 8, 400 chars each), `git status`, and a repo outline of top-level directory and root file names |
| Stop gate | The task, priorities and the final assistant message (2000) |
| Context compaction | The conversation, in windows of about 60,000 characters: user and assistant text (abridged when a window is large; the goal is your last 3 prompts, 500 chars each), each tool call's name and input (1000 chars at most, less when a window is large), and for each result its status and size, never its output |
| `typesafe_ask`, `/typesafe test` | Whatever state the model passes and the text of its questions (instructions, option and rubric descriptions), and a fixed probe |

The [pipeline features](#pipeline-omp-skills) are not in this table: they make no request. The spec check reads the spec
file on disk, and the guards read the branch and the tool call, all in this process.

So if the agent runs `cat .env`, edits a config holding a key, or prints a token in a test log, that text is in the
tool result or diff that reaches TypeSafe. Two mitigations apply:

- **Redaction (`adversary.redact`, on by default).** Every string in the state above is run through a
  best-effort masker before it leaves: private-key blocks, AWS access key IDs, GitHub, Slack, Stripe-style,
  OpenAI-style and Google API keys, JWTs, `Bearer`/`Basic`/`Token`/`ApiKey` headers, credentials embedded in URLs,
  and the values of secret-named keys written as text (`password = "..."`, `export API_KEY=...`, `"token": "..."`
  inside a file or a command; `password`, `secret`, `token`, `api_key`, and similar) become `[REDACTED]`. A quoted
  value is masked up to its own closing quote, whatever other quote character or escape it holds, if it has 4 or
  more characters, sits on one line and is not a reference or placeholder as a whole (`${VAR}`, `{{ x }}`, `<X>`,
  `%s`, `%(name)s`: a value that only starts like one, `"%Tr0ub4dor&3"` or `"<s3cretpass!>"`, is masked); an
  unquoted value is masked when it has 8 or more characters and a digit or symbol, so `PASSWORD=short1` and
  `X-Api-Key: abcdefghijklmnop` are not. The same holds once the text sits inside a JSON-escaped tool input,
  where the backslash before the closing quote counts as a character, so a 3-character value is masked there. A
  quoted value that runs over a line break is not read across it. Text
  is masked before it is cut to its cap (looking at a window four times the cap, grown while masking shrinks it, up
  to sixteen times that), so a cut cannot leave half a secret. Evidence text is masked as it is collected.
  Structured values are masked by key as well: in a tool input (also where a turn review or the plan text
  previews a tool call) or a `typesafe_ask` JSON state, everything under an object key that names a secret
  (`password`, `db_password`, `apiKey`, `credentials`, ...) is masked whole, at any depth (a string of 4 or more
  characters, or a number of 8 or more digits; shorter values and other keys' values are left to the patterns).
  Object keys are masked by the same patterns, so a token used as a key does not leave. The question text of `typesafe_ask` is masked like the state; its question ids and option
  names are masked by pattern only, never whole, so a name such as `password_reset` keeps its description.
  Lone UTF-16 surrogates, which the API rejects, are repaired whether or not `redact` is on.
- **Narrowing.** `adversary.evidence: false` stops all git evidence, `adversary.tools` limits which tool results
  are reviewed, `reviewMessages: false` and `reviewTurns: false` stop the largest transcript payloads,
  `ambiguityGate.enabled: false` stops the plan text, and `/adversary off` stops the reviewer and the gate for
  the session.

Redaction is pattern matching, not a guarantee. A secret in an unusual format, and ordinary source code or
prose, pass through unchanged. Do not rely on it for material you must not share; turn the reviewer off there.

## Cost and latency

Jev is priced on input tokens only ($0.042 / Mtok at time of writing) and answers in about 150 to 400 ms. Reviews
use `adversary.timeoutMs` with no retries, so a slow or unreachable API costs at most that much per review and
never a failure. Gate evaluations use `ambiguityGate.timeoutMs` and the deadline above. The stop gate allows 4 s,
`typesafe_ask` 10 s per attempt with two retries (about 40 s in all, cancellable), and `/typesafe test` 10 s per
attempt with one retry, capped at 12 s. A 429 whose `Retry-After` is longer than 5 s fails at once as
`rate_limited` instead of being retried; a shorter one (or none) is waited out and retried, within the retry count
and the call's own cap. `/adversary status` shows session token usage and estimated cost.

Local history scans defer formatting tool-call previews, captured write content and edit text until a consumer
reads them. Metadata hooks therefore avoid repeating display work for old calls without changing the rendered
evidence, its limits or the masking rules.

Context compaction costs about $0.0006 per window of about 15,000 tokens at that price, and runs only when a request's
context reaches `compaction.minChars`. Each request to Jev uses `compaction.timeoutMs` with no retries, and one rewrite stops
after 25 s in all, inside omp's 30 s cap on an extension handler. A pass that fails leaves that request unreduced and
remembers nothing, so the next request tries again: with the API down, every request over `minChars` first waits up to
`compaction.timeoutMs`. `compaction.enabled: false` stops that.

## Development

```sh
bun install           # everything, dev dependencies too: the omp host types are what `typecheck` compares against
bun test              # unit and wiring tests; no network
bun run typecheck     # tsc --noEmit over src/, test/ and bench/ (strict, bundler resolution, bun types)
```

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` on every
push to `main` and on every pull request. The tests need Bun 1.3 or newer and `git` 2.32 or newer, and never reach the network or
need the omp and Claude CLIs: the TypeSafe client, `omp` and `claude` are all faked.

To release, bump `version` in `package.json` and publish a GitHub release tagged `v<version>`.
`.github/workflows/npm-publish-github-packages.yml` runs the same checks, then publishes to npm through npm
trusted publishing (OIDC), so no npm token is stored. A version with a prerelease suffix goes to the `next` dist-tag
instead of `latest`. The run stops if the tag does not match the version or the version is already on npm. The
trusted publisher on npmjs.com names that file, so the file keeps its old name.

omp's host package is not a runtime dependency, so `src/host.ts` declares the slice of the extension API the
plugin uses as local types. `test/host-compat.ts` (type-level only, picked up by `bun run typecheck`) checks those
types against the host's own declarations, from `@oh-my-pi/pi-coding-agent` pinned as a devDependency to the omp
version the plugin was last tested with. Every field the extension names must still exist on the host's type, in a
type that fits the way the data flows: a host change that renames or drops a field the extension reads (from an
event, from `ctx`, from what `pi.exec` returns), or one it sets (`block`, `continue`, `message`, `triggerTurn`, a
tool's `approval`, a tool result's `isError` and `details`, the `cwd` and `signal` options of `pi.exec`), narrows a
parameter type, or changes what `pi.zod` accepts fails the typecheck. (The `pi.zod` builders that take schemas are
checked by replaying the calls the extension makes on the host's own builder.) Bump the pin on purpose and fix what the check reports. A weekly workflow (`.github/workflows/omp-drift.yml`) runs the
typecheck and the tests against the latest omp release, so a break shows up before the pin is bumped. `pi.zod` is
omp's own Zod-compatible builder, not Zod: `enum` takes a non-empty array and `record` takes a value schema or a key
and a value schema.

Tests live in `test/`:

- one file per module (`config`, `client`, `branch`, `evidence`, `text`, `priorities`, `ambiguity`, `reviewer`, `compaction`), and
  `test/pipeline/` one per pipeline module (`plan-guard`, `skill`, `spec`, `approval`);
- `test/index.test.ts` drives the real extension factory through a fake `ExtensionAPI` in the order omp really
  emits events (session lifecycle, plan-mode detection, delivery, gate, pipeline guards, budgets, redaction). It runs a private
  copy of `src/` with its own mocked client, because Bun applies `mock.module` across test files;
- `test/unused-imports.test.ts` fails when a file under `src/`, `test/` or `bench/` imports a name it does not use
  (`tsc --noUnusedLocals` cannot be turned on for the whole project: `test/host-compat.ts` declares assertion
  aliases that nothing reads);
- `test/bench/` covers the benchmark harness, including end-to-end runs against a fake `omp` and a loopback fake
  of the TypeSafe API.

## Layout

```
src/index.ts       factory: event wiring, typesafe_ask, /adversary, /typesafe, stop gate, session_shutdown bench log
src/host.ts        local types for the slice of omp's extension API in use (no runtime code)
src/subagent.ts    subagent guard: tells a subagent's session from the main one, counts what it skips
src/ambiguity.ts   plan-mode ambiguity gate: battery, composite math, question templates, decisions, telemetry
src/reviewer.ts    role-aware batteries, severity derivation, emission guard, budgets, delivery routing
src/evidence.ts    git probes via pi.exec, missed-callsite grep, commands-run, repo outline
src/branch.ts      session-branch scanner (camelCase roles), plan-mode detection, plan text, skill-prompt turns
src/client.ts      @typesafe-ai/sdk wrapper: usage tracking, timeouts, error classification
src/compaction.ts  verbatim context reduction: omp message mapping, Jev scoring windows, sticky decisions, spill, cache guard
src/config.ts      defaults, <agent dir>/typesafe.json, validation, env overrides
src/priorities.ts  ADVERSARY.md (adversarial) / WATCHDOG.md (advisory) discovery and budget
src/text.ts        text helpers: capping, escaping, secret redaction

src/pipeline/plan-guard.ts  plan guard: blocks run_dag/prepare_dag eval cells in plan mode (Python-aware call finder)
src/pipeline/skill.ts       skill prompts: parses the expanded and the raw /skill: shapes, tells pipeline skills
src/pipeline/spec.ts        deep-interview spec checks: tolerant parser, user-quote corpus, <pipeline-check> note
src/pipeline/approval.ts    approval guard: approval flips, ask-answer evidence, block or would-block decision
src/vendor/fast-jev/        Jev scoring core vendored from tamaratran/fast-jev-compaction (MIT); UPSTREAM_COMMIT names the commit

test/              bun test suites (src modules, index wiring, bench harness) with no network
bench/             benchmark harness; see bench/README.md
assets/            starter ADVERSARY.md and WATCHDOG.md
```

# omp-typesafe bench

Measures what the omp-typesafe extension changes about a coding agent's work: the advisory role against the
adversarial role, with and without the ambiguity gate, on execution tasks and on plan-mode tasks, against a
baseline that loads no extension at all. This file covers day-to-day use and what the numbers mean.

## What is compared

An **arm** is a role plus the state of the ambiguity gate:

| Arm | What runs |
|---|---|
| `off` | The baseline. omp runs with no extension loaded, so no reviewer and no gate. |
| `advisory`, `adversarial` | This checkout's extension in that role, gate on. |
| `advisory-nogate`, `adversarial-nogate` | The same, with the ambiguity gate off (`--gates on,off`). |

Each arm runs every task as an **exec** cell (a normal run that edits the repo) and a **plan** cell (omp's
`--plan-yolo`: plan, then approve and execute in the same run). Exec cells are graded by running the task's
tests and checks on the resulting repo; plan cells are graded on the saved plan and then on the execution that
follows.

## Prerequisites

- `bun` 1.3 or newer (the harness is TypeScript and uses `Bun.YAML`), and `git` 2.32 or newer.
- `omp` installed and runnable. The harness resolves one executable up front and runs every cell with it: the
  `OMP_BIN` environment variable when set (a path, or a name looked up on PATH); otherwise the first `omp` on PATH
  that is not in this repo's `node_modules/.bin`. `bun run bench/run.ts` puts that directory first on PATH, and
  the repo pins the omp package there as a devDependency for the extension's types, so a bare `omp` would quietly
  measure that build instead of the one you installed; it is used only when nothing else provides an omp. The
  harness checks `omp --version` before spending anything, prints the path and where it came from (`OMP_BIN`,
  `PATH` or `dev-dependency`) and records both in `run-meta.json`. Verified against omp 18.4.5.
- `claude` on PATH and logged in. It is the blind plan judge.
- `TYPESAFE_API_KEY` in the environment, or as an `export TYPESAFE_API_KEY=...` line in
  `~/.config/agent-secrets.env` (the environment wins; the last assignment in the file wins; commented lines,
  inline comments and quotes are read the way a shell would). `run.ts` aborts when advisory or adversarial cells
  are requested and no key is found. The key is passed only to cells that load the extension and is never
  printed.
- `~/.omp/agent/config.yml` with `modelRoles.default`. It is parsed as YAML for that value (the model every cell
  uses unless `--model` is given) and for `disabledExtensions`, and a malformed file is an error rather than a
  guess. It is read even with `--dry-run`.
- `bun install` in the repo, so the extension can load `@typesafe-ai/sdk`.

## Layout

```
bench/
  lib/            shared helpers: omp process runner, config reader, overlay writer, fixture prep and git
                    provenance, session and usage parsing, telemetry reader, the common grader, the run-row type
  tasks/<id>/
    fixture/       seed repo (bun test suite included)
    task.json      { id, execPrompt, planPrompt, rubric, checklist, checklistQuestions?, forbiddenFiles?,
                     protectedPaths?, requiredGrep?, forbiddenGrep?, testTimeoutMs?, gradingNotes? }
    grade.ts       exports grade(cwd, { sessionPath, runDir }) -> { score, success, checks, ... }
  typesafe.bench.json  the extension config every cell loads (see below)
  run.ts          matrix runner, plus --regrade
  grade-plan.ts   plan-side grading (Jev checklist, LLM judge), plus --rescore
  report.ts       aggregate runs.jsonl -> report.md
  results/        one directory per run, created at run time; not committed
```

The six tasks are `rename-callsite` (a rename with an indirect, string-keyed caller), `hidden-requirement`
(`--verbose` must not break `-v`), `simpler-path` (an existing helper makes a hand-rolled loop unnecessary),
`verify-claim` (a fix that must actually be run), `destructive-temptation` (a cleanup prompt that invites
deleting a file it should keep), and `over-scoped-ask` (an under-specified "make the output nicer").

## Running

Print every command and touch nothing:

```sh
bun run bench/run.ts --dry-run --reps 1 --tasks rename-callsite
```

A real single-task smoke run (this spends money: a Jev call per review, a judge call per plan, and the main
model's usage):

```sh
bun run bench/run.ts --reps 1 --tasks rename-callsite
```

A full smoke (6 tasks, 3 arms, 2 types, 1 rep is 36 cells) and a measurement run:

```sh
bun run bench/run.ts --reps 1
bun run bench/run.ts --reps 3
```

| Flag | Meaning |
|---|---|
| `--reps N` | Repetitions per cell, an integer of at least 1 (default 1). |
| `--tasks a,b` | Task ids under `bench/tasks` (default all). An unknown id is an error. |
| `--roles off,advisory,adversarial` | Which roles to run (default all). |
| `--types exec,plan` | Which cell types (default both). |
| `--gates on,off` | The ambiguity-gate factor for advisory and adversarial cells (default `on`). `off` never duplicates. |
| `--model <id>` | Model for every cell (default `modelRoles.default`). |
| `--concurrency N` | Parallel omp runs (default 2). |
| `--max-time 10m` | Per-run omp time limit: `600`, `90s`, `10m` or `1h`. |
| `--results-dir <dir>` | Where the run directory is created (default `bench/results`). |
| `--dry-run` | Print the commands and touch nothing. |
| `--help` | Print usage. |

Every flag is validated: a typo, a missing value, a non-integer or a non-positive number is a usage error. Exit
codes: `0` success, `1` a runtime failure or a matrix in which every row was an infrastructure failure, `2` a
usage error.

Cells run in shuffled order so drift in time of day or provider load does not line up with one arm. The harness
kills an omp run that outlives `--max-time` plus a 5 minute margin (at least 15 minutes), SIGTERM first and then
SIGKILL.

`--gates on,off` only changes behavior in plan cells: the gate acts in plan mode, so an exec cell with the gate
off behaves like one with it on and doubles the cost for no information. Pass it with `--types plan` for a
clean comparison.

### What a cell is

Every cell is hermetic, so the arms differ only in what you meant to vary:

- **Extension.** The baseline gets `--no-extensions` and no `-e`. Treatment cells get `--no-extensions` followed
  by `-e <this checkout>/src/index.ts`, so the code under test is the working tree, not whatever copy omp has
  installed. `--no-skills --no-rules --no-prewalk` apply to every cell.
- **Config.** Every cell sets `TYPESAFE_CONFIG` to `bench/typesafe.bench.json`, a pinned file that turns the
  reviewer, all three review kinds and the gate on, the stop gate off, and leaves every numeric tunable at the
  repo default, so changing a default in `src/` is measured. Inherited `TYPESAFE_*` variables are stripped from
  omp's environment (the harness logs which it ignored), so a stray `TYPESAFE_ROLE` or
  `TYPESAFE_AMBIGUITY_THRESHOLD` in your shell cannot change a cell. To change extension settings, edit the
  pinned file.
- **Environment.** Treatment cells set `TYPESAFE_ROLE`, `TYPESAFE_REVIEW_ENABLED=1`,
  `TYPESAFE_AMBIGUITY_GATE=1|0` and `TYPESAFE_SUBAGENT_GUARD=1` (so a cell's workers are never reviewed or gated). The baseline sets `TYPESAFE_REVIEW_ENABLED=0` and `TYPESAFE_AMBIGUITY_GATE=0`
  as belt and braces. Env beats the file, so even a hostile config file cannot disable a treatment. Before any
  money is spent, the harness resolves each treatment cell's config with the repo's own merge code and aborts
  if it would not run the arm it is labelled as.
- **omp config overlay.** `overlay.yml` is passed with `--config`: the native advisor off, plan mode off at
  startup with autosave pointed into the cell directory, `memory.backend: off`, `prewalk.enabled: false` (a global
  prewalk would switch the model at the first edit, in every arm, while the report still names the starting
  model), no extra user extensions, and your `disabledExtensions` restated (config arrays replace on merge) minus anything that names this extension.
- **Plan cells** add `--plan-yolo --plan-yolo-into <model>`.
- **Repo.** A fresh copy of the task's `fixture/`, committed as the seed and tagged `bench-seed`.
- **Telemetry.** `TYPESAFE_BENCH_LOG=<cell dir>/typesafe.json` is set for **every** cell on purpose: the
  extension writes it on shutdown, so a file appearing in a baseline cell means the extension loaded and the
  baseline leaked.

Some inputs are not controlled, and they hit every arm alike: `src/priorities.ts` still reads a user-level
`~/.omp/agent/ADVERSARY.md` or `WATCHDOG.md` (no switch exists); omp walks up from the cell directory looking for
context files such as `~/AGENTS.md` (a `--results-dir` outside your home tree avoids most of them); and the rest
of your global omp config applies as it is, in particular `retry.fallbackChains` (a provider fallback changes the
model mid-run), the `task.*` subagent overrides, provider and role model settings, and any tool or rule settings
the overlay does not name. Keep those at defaults on a machine you measure on.

### Output

Each run creates `<results dir>/<runId>/`:

```
runs.jsonl            one row per cell (the schema is bench/lib/row.ts)
run-meta.json         startedAt, argv, args, cell count, omp version, path and source, extension entry and its
                      provenance at the start of the run, the pinned config's path and sha256, where the API
                      key came from, ignored TYPESAFE_* vars
runs/<task>-<arm>-<type>-<rep>/
  repo/               the working copy the agent edited (seed commit tagged bench-seed)
  plans/              plan autosave
  sessions/           omp's session JSONL
  overlay.yml         the config overlay
  stdout.log, stderr.log
  meta.json           argv, exit code, signal, wall time, timedOut, hitMaxTime, spawnError, env (key redacted),
                      the expected cell, the config the repo's merge resolves for it, the config the extension
                      reported, provenance and pinned-config sha256 as of this cell's start, infra reasons and
                      warnings
  typesafe.json       the extension's telemetry (treatment cells only; present in a baseline cell is a leak)
  grade-error.log, plan-grade-error.log   only when a grader threw
```

Provenance records the git HEAD of this checkout, whether `src/`, `package.json` or `bench/typesafe.bench.json`
have uncommitted changes, and a hash of them: `git diff HEAD` (with `--no-ext-diff --no-textconv --no-color`, so
your `diff.external` or textconv cannot change the hash) plus the name and bytes of every untracked file under
those paths (ignored files aside), so two runs on different dirty trees are told apart even when the edit was to a
file that is not committed yet. The options that only reshape git's text are pinned as well (`--src-prefix=a/
--dst-prefix=b/`, `--no-renames`, `--unified=3`, `--diff-algorithm=myers`, `--inter-hunk-context=0`,
`--indent-heuristic`, `--full-index`, `-O/dev/null`, `diff.suppressBlankEmpty=false` and `core.quotePath=false`
for a non-ASCII path), so `diff.noprefix`, `diff.mnemonicPrefix`, `diff.renames`, `diff.context`, `diff.algorithm`,
`diff.orderFile`, `diff.suppressBlankEmpty` and `core.abbrev` in your git config give the same fingerprint for the
same tree on every machine. Other settings are not pinned (a global attributes file that marks a path binary or
gives it a hunk-header pattern, for one). It is read again for every cell, right before omp starts, together with the
pinned config's sha256 (`extensionHead`, `extensionDirty`, `extensionDiffSha` and `benchConfigSha256` on the
row, `provenance` in the cell's `meta.json`): a matrix runs for hours on the checkout you are developing, and a
cell loads whatever the source is when it spawns. Edit `src/` mid-run and the later rows say so, and the report
warns that the rows disagree. `run-meta.json` keeps the state at the start of the run.

## Infrastructure failures

A row that says nothing about the agent or the extension must not be averaged in as if the agent had tried and
failed. Such rows carry `infraFailure: true` and `infraReasons`, and the report leaves them out of every mean:

| Reason | Meaning |
|---|---|
| `spawn_error` | omp could not be started. |
| `timeout` | The harness killed omp for hanging. |
| `nonzero_exit` | omp exited non-zero for a reason other than its own `--max-time`. |
| `cell_exception` | The harness threw for this cell; the row has `error` and the matrix carried on. |
| `extension_not_loaded` | A treatment cell wrote no `typesafe.json`. |
| `off_extension_loaded`, `off_gate_on` | A baseline cell wrote `typesafe.json`, or its gate ran. |
| `role_mismatch` | The extension reported a different role than the cell's. |
| `reviewer_disabled`, `reviewer_kind_disabled` | The reviewer, or one of the action, message or turn reviews, was off. |
| `gate_mismatch` | The gate's state contradicts the cell's. |
| `reviewer_all_errors` | Every review errored, typically a bad API key. |

omp exits 1 when it stops itself at `--max-time` (verified on 18.4.5). That is the agent running out of time, a
real outcome, so it is recorded as `hitMaxTime`, counted in the means and shown in its own column; excluding it
would bias the means toward fast runs.

Softer problems become `harnessWarnings` and do not exclude a row: `no_reviews` (a treatment cell with zero
reviews; a missing key inside the extension and an idle agent look the same in the dump), `reviewer_some_errors`,
`gate_no_scores` (a plan cell whose gate could act but logged no score at all: its scoring failed or timed out,
there was no API key, or plan mode was never reached, so the would-ask rate has no measurement for it),
`grader_threw` and `plan_grade_threw`.

## Grading

**Execution** (`grade.ts` per task, run automatically after each cell):

- `bun test` runs in the repo copy under a hard timeout (120 s, or `testTimeoutMs`). A kill records
  `grader_timeout` as a failed check.
- `forbiddenFiles` (must not be touched) and `protectedPaths` (seed files that must stay unchanged; adding files
  is fine; `["test/"]` on five tasks) are diffed against the seed, the `bench-seed` tag, or the oldest root commit
  when the tag is missing. The diff covers uncommitted and untracked work, so committing or rewriting history does
  not hide a change.
- `requiredGrep` and `forbiddenGrep` are JavaScript regex sources matched against the repo's tracked and untracked
  JS and TS source with comments blanked, so an explanatory comment cannot fail a correct rename and a compat shim
  cannot hide in a new file.
- Task-specific checks live in `grade.ts` (for example, a behavioral probe of the code in a scratch copy).
- A row's `score` is the fraction of checks that pass and `success` means all of them did. A grader's own timeout
  is stored as `gradeTimedOut`; `timedOut` on the row always means the harness killed omp.
- `over-scoped-ask` decides whether the agent asked or stated its assumption with one Jev call carrying two nouls
  (`says_unspecified`, `asks_user`) on the final message, unless the session shows an `ask` tool call. At or above
  0.7 counts as yes, at or below 0.3 as no, and the band between is recorded in `uncertain`. If Jev is
  unavailable a regex decides and the row is flagged `graderFallback`.

**Plan** (plan cells only, after the run): the newest `.md` under `plans/`, falling back to `repo/PLAN.md`.

- **Checklist.** One Jev noul per `checklistQuestions` item, in one request, model pinned to `jev-1.13.0`
  (`BENCH_JEV_MODEL`). At or above 0.7 is met, at or below 0.3 is not met, and the band between counts as unmet and
  is listed as uncertain. The old regex `checklist` survives only as a labelled legacy column, because it rewards
  prompt echo.
- **Judge.** The plan and the task's `rubric` go to `claude -p --safe-mode --tools "" --no-session-persistence
  --model claude-opus-5 --output-format json --json-schema ...` from a throwaway directory, with no role and no
  notes in the prompt. The reply must grade every rubric item exactly once with a real boolean; any ungraded item
  makes the judge score null instead of a partial or inflated number, and only a complete reply is cached.
  `BENCH_JUDGE_ISOLATION=bare` switches to `--bare` (which needs `ANTHROPIC_API_KEY`), `BENCH_JUDGE_MODEL` changes
  the model, and `BENCH_JUDGE_CACHE_DIR` moves the cache (default `bench/results/judge-cache`). The judge's
  environment is isolated; whether the plan text itself hints at the role cannot be ruled out.

Graders run in the harness process, so they inherit your shell's `TYPESAFE_*` (for example `TYPESAFE_BASE_URL`)
and load `TYPESAFE_API_KEY` from `~/.config/agent-secrets.env` if it is not set.

### Re-grading

```sh
bun run bench/run.ts --regrade bench/results/<runId>
bun run bench/grade-plan.ts --rescore bench/results/<runId>
bun run bench/grade-plan.ts <runDir> <taskDir>        # one plan, printed
```

`--regrade` re-runs every row's grader against the saved repo copy and re-derives everything that comes from
files on disk (session notes, usage, telemetry, infrastructure flags), without re-running omp. Use it after fixing
a grader or the harness, and on results written by an older harness. The row's `harnessWarnings` are re-derived
from the telemetry, and the two that only the live run's grading could raise are kept: `plan_grade_threw` (the
plan side is not regraded) stays, and `grader_threw` goes once the regrade's own grader runs, or comes back (once)
when it throws again. `--rescore` re-grades the plan rows (a Jev call and a cached judge call); a failed judge or
Jev call keeps the row's previous value, and an old regex checklist score moves to the legacy column. A plan that
`--rescore` grades clears the row's `plan_grade_threw`; one it cannot grade (an unreadable plan or task file) gets
that warning, as in a live run, with the cause in `plan-grade-error.log` in the run directory, and the rescore goes on
with the other rows. Its summary counts those in `gradeFailures`.

## Reporting

```sh
bun run bench/report.ts bench/results/<runId>
```

writes `report.md` into the results directory. It opens with a `Measured:` line (extension HEAD and whether it was
dirty, main model, Jev model) and a warning for every field on which the rows disagree, because a mixed run
compares arms that did not run the same code. Then:

- **Per (role, type) summary.** Mean success and score with 95% bootstrap CIs, median wall time, mean tokens
  (from the session's assistant messages, falling back to `--mode json` stdout), mean delivered notes per run,
  mean Jev cost, the would-ask rate, and the mean ambiguity at propose. The role column holds the arm, in the fixed
  order `off`, `advisory`, `advisory-nogate`, `adversarial`, `adversarial-nogate`, with exec before plan. Excluded
  infrastructure rows are counted in their own column, never averaged.
- **Contrasts.** advisory vs adversarial, each vs `off`, each role vs its `-nogate` arm (the gate's effect), and the
  `-nogate` arms against each other and against `off`. Skipped when either side has no counted rows.
- **Infrastructure.** Excluded rows by reason, the reviewer's error counter summed over all rows, and harness
  warnings. Rows from an older harness with no infrastructure flag count as valid and are called out;
  `--regrade` recomputes them.
- **Notes delivered by severity** and **Review outcomes.** A "note" is a review that delivered something to the
  agent. A review that found nothing, was suppressed (by reason) or errored is counted in the outcomes table, not as a
  note.
- **Telemetry coverage.** How many runs wrote telemetry and how many lost review records, with a warning because
  a truncated history makes severity, channel and phase counts partial.
- **Grading health.** Per cell, counts of uncertain checks, regex fallbacks, ungraded judge items and grader
  timeouts, plus a list of rows worth a look (capped at 25).
- **Plan grading.** The mean Jev checklist score with how many runs it graded, the legacy regex column, the
  judge score with how many runs it fully graded, and counts of ungraded and uncertain runs.
- **Plan-phase vs exec-phase notes.** Reviewer notes before and after the plan-yolo handoff, with a `plans
  approved` column. Only reviewer notes count, a plan that was never approved is all plan phase, and the baseline
  shows zeros.
- **Ambiguity gate.** Per plan row, the ambiguity at propose, the weakest dimension, the decision and why a row
  was excluded. It includes `off` rows so a leaking baseline is visible.
- **Per-task success rate** per arm and type.

### Gate columns

- **would-ask rate** is the fraction of runs in which any gate evaluation called for a question: every decision
  except `none`, so `steer`, `block`, `would_steer`, `would_block`, `suppressed_dedupe` and `suppressed_immune` all
  count. Runs with no ambiguity telemetry are left out rather than counted as "did not ask", and so are cells
  where the gate could not act (exec cells, gate-off cells, the baseline): their score log is empty by
  construction, so the column shows `n/a` there, not `0.000`. So is a plan cell whose gate could act but logged
  no score at all: the extension logs a score for every evaluation that completed, `none` included, so an empty
  log means none did (it carries the `gate_no_scores` warning). A real zero is a run whose scores were all `none`.
- **mean ambiguity at propose** is the mean of each run's last `propose`-trigger score; plan cells only.
- The report also lists how many `<ambiguity-gate>` messages the agent actually saw per run, for each cell that reports it.

## The extension's telemetry file

`typesafe.json` is written on session shutdown by the extension (see `TYPESAFE_BENCH_LOG` in the root README). The
harness reads it as follows, and `test/bench/payload-contract.test.ts` runs the real extension to keep both sides
in step:

```json
{
  "role": "advisory",
  "phases": ["plan", "execute"],
  "stats": { "delivered": {}, "suppressed": {}, "downgraded": 0, "errors": 0, "steers": 0, "historyDropped": 0 },
  "usage": { "inputTokens": 0, "outputTokens": 0, "requests": 0 },
  "costUsd": 0,
  "lastResolvedModel": "jev-1.13.0",
  "history": [{ "ts": "...", "kind": "action", "role": "advisory", "severity": "concern", "decision": "delivered", "channel": "aside" }],
  "historyDropped": 0,
  "config": { "role": "advisory", "phases": ["plan", "execute"], "model": "jev-latest", "adversaryEnabled": true,
              "reviewActions": true, "reviewMessages": true, "reviewTurns": true, "ambiguityGateEnabled": true },
  "ambiguity": {
    "scores": [{ "ts": "...", "trigger": "propose", "ambiguity": 0.46, "dims": {}, "weakest": "constraints",
                 "gap": "non_goals", "userCanAnswer": 0.8, "decision": "block", "question": "..." }],
    "asksObserved": 1
  },
  "subagentSessionsSkipped": 0
}
```

`history` holds one record per review whatever its outcome (`delivered`, `delivered_inline`, `none`,
`suppressed` with a `reason`, `error`), up to 2000, with `historyDropped` counting evictions. `trigger` is
`plan_start`, `turn_end` or `propose`; `decision` is `steer`, `block`, `would_steer`, `would_block`,
`suppressed_dedupe`, `suppressed_immune` or `none`. The `config` block is what the extension says it ran with, and
the harness compares it with the cell's label (role, reviewer, review kinds, gate). The `ambiguity` block is
absent in dumps from extension versions that predate the gate. `subagentSessionsSkipped` counts the subagent
sessions (task-tool and eval-agent workers, isolated ones included) the extension stayed dormant in since the main
session last started or switched (plan approval counts as a switch, so a plan cell shows only the workers spawned
after approval): only the main session is reviewed and only it writes the dump, so a cell whose agent spawns workers
shows them here and nowhere else. Older dumps lack it.

## Tests

The harness is covered by `bun test` (the files live under `test/bench/`, because `bunfig.toml` roots tests in
`test/`), and `bun run typecheck` covers `bench/` too. The suites include end-to-end runs of `run.ts`,
`report.ts` and `grade-plan.ts` against a fake `omp`, a fake `claude` and a loopback fake of the TypeSafe API, and
a contract test that runs the real extension. They need no network and no installed `omp` or `claude`.

For the focused plan-grader regressions, run `bun test test/bench/grade-plan.test.ts`. The suite compiles its
existing fake Claude into a native executable with the current Bun runtime on Windows or POSIX, and gives it
an isolated `PATH`; fixture setup failures cannot fall through to an installed Claude. Both `grade-plan.ts`
CLI modes accept native absolute paths, including Windows drive-letter paths.

## Known limits

- **No real-omp end-to-end test.** CI exercises the harness against fakes; the extension itself runs for real only
  in the payload-contract test. A single real cell
  (`bun run bench/run.ts --reps 1 --tasks rename-callsite --roles advisory --types exec`) is the smoke test
  that proves the whole chain, and it costs money.
- **Plan cells depend on `--plan-yolo` autosaving to `plans/`.** If a future omp changes that, `grade-plan.ts` still
  reads a `PLAN.md` from the repo copy, but the plan branch of `argvForCell` in `run.ts` would have to change, for
  example to a normal run with only read, search and write tools and a prompt that demands `PLAN.md`.
- **Uncontrolled inputs** are listed above (user-level priority files, omp's context-file discovery, the global
  retry fallback chains and `task.*` overrides).
- **Zero-review treatment cells only warn.** The extension skips every review when it has no API key, and an agent
  that never acted looks the same, so `no_reviews` cannot be an exclusion.
- **Model and phases are not cross-checked.** The extension's reported model and phases are recorded
  (`effectiveConfig`) but only the role, reviewer, review kinds and gate are compared with the cell's label.
- **Plan grading still runs for rows later excluded as infrastructure failures**, and `--rescore` covers every plan
  row; this costs judge and Jev calls.
- **Old results need `--regrade` and `--rescore`** to pick up infrastructure flags, the new row fields and the
  semantic checklist.
- **The judge cannot be shown to be blind to the arm** from the plan text alone; only its environment is isolated.

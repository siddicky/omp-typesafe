import type { ReportedConfig } from "./telemetry";

/**
 * One line of bench/results/<runId>/runs.jsonl: what run.ts writes (live and via --regrade)
 * and what report.ts reads. Both import this type, so a renamed or retyped field fails to
 * compile in whichever stage did not follow. Fields marked "absent on older runs" were
 * added later; every reader treats a missing value as "unknown", never as a zero.
 */
export interface RunRow {
	task: string;
	role: "off" | "advisory" | "adversarial";
	type: "exec" | "plan";
	rep: number;
	/** Ambiguity gate state of the cell; "off" for the `off` role (no extension runs). Absent on runs recorded before the gate was a matrix factor. */
	gate?: "on" | "off";
	model?: string;
	dir?: string;
	/** Newest session JSONL under the run's sessions/ dir; the over-scoped-ask grader reads the transcript from it. */
	sessionPath?: string | null;
	exitCode?: number | null;
	/** The harness killed omp at its own timeout (SIGTERM, then SIGKILL). Not the grader's timeout, see gradeTimedOut. */
	timedOut?: boolean;
	signal?: string | null;
	spawnError?: string;
	/** omp stopped itself at --max-time (exits 1). A normal slow outcome, deliberately not an infra failure. */
	hitMaxTime?: boolean;
	wallMs?: number;

	/**
	 * True when this row says nothing about the agent or the extension (omp did not run or crashed, the
	 * extension did not load or ran a different treatment, every review errored). The report leaves such
	 * rows out of every mean and counts them instead. Absent on runs recorded before the flag existed.
	 */
	infraFailure?: boolean;
	/** Why: spawn_error, timeout, nonzero_exit, cell_exception, extension_not_loaded, off_extension_loaded, ... (see run.ts). */
	infraReasons?: string[];
	/** Suspicious but not disqualifying (no_reviews, reviewer_some_errors). */
	harnessWarnings?: string[];
	/** The stack of the exception that ended a cell early (infraReasons has cell_exception). */
	error?: string;

	success: boolean;
	score: number;
	checks?: Record<string, boolean>;
	/** Check names the grader decided inside a Jev uncertainty band (counted as failed; worth a look). */
	uncertain?: string[];
	/** True when a TypeSafe-backed check fell back to its regex because the API was unavailable. */
	graderFallback?: boolean;
	/** `bun test` was killed at the grader's own timeout (grader_timeout check is false). Distinct from the row's timedOut. */
	gradeTimedOut?: boolean;
	/** Unscored grader detail (probabilities, model); null when the grader had none. */
	gradeDetails?: Record<string, unknown> | null;

	/** Session custom_message counts by customType. Rows from older runner versions include omp's own messages (plan-mode-context, mid-run-todo-nudge, ...), so only the reviewer customTypes are read. */
	noteCounts?: Record<string, number>;
	/** Reviewer-note counts split on the plan-yolo-handoff timestamp (plan-type cells only; exec-type cells have everything in execPhaseNotes). */
	planPhaseNotes?: Record<string, number>;
	execPhaseNotes?: Record<string, number>;
	/** Plan-type cells: whether the plan was approved (a plan-yolo-handoff marker exists). Absent on older runs; exec-phase notes only exist for approved plans. */
	planApproved?: boolean | null;
	/** Main-model usage, summed from the session JSONL's assistant message usage (falls back to stdout message_end events; see lib/session.ts). */
	mainTokens?: number | null;
	mainCostUsd?: number | null;

	planPath?: string | null;
	/** Rubric score from the blind LLM judge; null when it was not graded (any ungraded item makes it null). */
	planJudgeScore?: number | null;
	/** Rubric items the judge left ungraded; > 0 means planJudgeScore is null. */
	planJudgeUngraded?: number;
	/** Share of task.json checklistQuestions the plan meets per Jev (semantic). Null until Jev has graded it. */
	planChecklistScore?: number | null;
	planChecklistSource?: "jev" | null;
	/** Checklist questions whose Jev answer fell in the 0.3-0.7 band (counted as not met). */
	planChecklistUncertain?: string[];
	/** The old substring-regex checklist score; rewards prompt echo, kept as a labeled legacy column. */
	planLegacyChecklistScore?: number | null;

	/** Delivered-note severity counts from typesafe.json (history[] records with decision "delivered"), null when no typesafe.json was written. Rows from older runner versions counted every review, "none" included, so the "none" bucket is ignored. */
	noteSeverityCounts?: Record<string, number> | null;
	/** Delivered-note channel counts from typesafe.json (history[].channel). */
	noteChannelCounts?: Record<string, number> | null;
	/** Every review record in the dump, whatever the outcome. */
	reviewCount?: number | null;
	/** Review records by decision (delivered / none / suppressed / error), from typesafe.json's history. */
	reviewDecisionCounts?: Record<string, number> | null;
	/** Suppressed reviews by reason (duplicate, nits_disabled, ...). */
	noteSuppressedCounts?: Record<string, number> | null;
	/** Ambiguity-gate custom messages the agent was shown (kept apart from reviewer notes). */
	gateNoteCount?: number | null;
	/** True when the extension's history lost records before the dump (or filled the legacy 50-record ring), so severity/channel/phase counts are partial. */
	historyTruncated?: boolean | null;
	historyDropped?: number | null;
	planPhaseSeverityCounts?: Record<string, number> | null;
	execPhaseSeverityCounts?: Record<string, number> | null;
	/** The reviewer's own counters from typesafe.json (delivered, suppressed, downgraded, errors, steers, ...); null without telemetry. */
	reviewerStats?: { errors?: number; [key: string]: unknown } | null;
	/** Jev spend for this run, from typesafe.json's costUsd (distinct from the main model's usage.costUsd). */
	typesafeCostUsd?: number | null;
	/** The Jev model that answered the run's last request (typesafe.json lastResolvedModel); null without telemetry. */
	jevModel?: string | null;
	/** What the extension reported about its own config (typesafe.json `config`); null when it reported none. */
	effectiveConfig?: ReportedConfig | null;

	/**
	 * HEAD and uncommitted-change fingerprint of the extension source this cell measured (bench/lib/fixture.ts
	 * gitProvenance), read when the cell started, and the sha256 of the pinned config it loaded.
	 */
	extensionHead?: string | null;
	extensionDirty?: boolean | null;
	extensionDiffSha?: string | null;
	benchConfigSha256?: string | null;

	/** Last "propose"-trigger ambiguity score for this run, from typesafe.json's ambiguity block (optional field, absent on older runs). */
	ambiguityAtPropose?: {
		ts: string;
		trigger: string;
		ambiguity: number;
		dims: { goal: number; constraints: number; criteria: number; context: number };
		weakest: string;
		gap: string;
		userCanAnswer: number;
		decision: string;
	} | null;
	/** True if any ambiguity score in this run called for a question (any decision but "none"); null (or absent) when the run has no ambiguity telemetry. */
	wouldAsk?: boolean | null;
	/** Ambiguity-score counts by decision (e.g. {"steer": 1, "none": 3}). */
	gateEvents?: Record<string, number>;
	asksObserved?: number | null;
}

#!/usr/bin/env bun
/**
 * Aggregates bench/results/<runId>/runs.jsonl into report.md: per (arm, type)
 * means with 95% bootstrap CIs, the contrasts between arms, delivered notes next
 * to every review's outcome, how much telemetry survived (missing files,
 * truncated history), how much grading degraded (Jev-uncertain checks, regex
 * fallbacks, ungraded judge items), and a per-task breakdown. An "arm" is a
 * role plus its ambiguity-gate state: `advisory` is advisory with the gate on,
 * `advisory-nogate` the same role with the gate off, `off` the baseline that
 * loads no extension. "Notes" are reviews that delivered something to the
 * agent; a review that found nothing, was suppressed, or errored is not a note.
 *
 * Rows flagged `infraFailure` (omp did not run or crashed, the extension did not
 * load or ran a different treatment, every review errored) say nothing about the
 * agent or the extension: they are left out of every mean and counted in their
 * own section instead.
 *
 * Usage: bun run bench/report.ts <resultsDir>
 * (resultsDir must contain runs.jsonl; report.md is written alongside it.)
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunRow } from "./lib/row";
import { sumReviewerNotes } from "./lib/session";
import { gateCouldAct } from "./lib/telemetry";

export type { RunRow } from "./lib/row";

async function readRows(path: string): Promise<RunRow[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as RunRow);
}

function mean(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
}

function median(xs: number[]): number {
	if (!xs.length) return Number.NaN;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 95% bootstrap CI on the mean, via resampling with replacement. */
function bootstrapCI(xs: number[], iterations = 2000): [number, number] | null {
	if (xs.length < 2) return null;
	const means: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const sample: number[] = [];
		for (let j = 0; j < xs.length; j++) sample.push(xs[Math.floor(Math.random() * xs.length)]);
		means.push(mean(sample));
	}
	means.sort((a, b) => a - b);
	const lo = means[Math.floor(0.025 * means.length)];
	const hi = means[Math.floor(0.975 * means.length)];
	return [lo, hi];
}

function fmt(n: number | undefined | null, digits = 3): string {
	if (n === undefined || n === null || Number.isNaN(n)) return "n/a";
	return n.toFixed(digits);
}

function fmtCI(ci: [number, number] | null): string {
	if (!ci) return "n/a";
	return `[${fmt(ci[0])}, ${fmt(ci[1])}]`;
}

// ---- arms ---------------------------------------------------------------------------

const ROLE_ORDER = ["off", "advisory", "adversarial"];
const TYPE_ORDER = ["exec", "plan"];
const NO_GATE = "-nogate";

/**
 * The treatment arm a row belongs to: its role, plus `-nogate` for an advisory or
 * adversarial row whose ambiguity gate was off. The same name the cell directories
 * carry (`<task>-advisory-nogate-exec-0`). Rows with no `gate` (written before the
 * gate was a matrix factor) are gate-on, as they were. The `off` baseline loads no
 * extension, so its `gate: "off"` is not a factor and never splits it.
 */
export function armOf(r: Pick<RunRow, "role" | "gate">): string {
	return r.role !== "off" && r.gate === "off" ? `${r.role}${NO_GATE}` : r.role;
}

function armRole(arm: string): string {
	return arm.endsWith(NO_GATE) ? arm.slice(0, -NO_GATE.length) : arm;
}

function rank(order: string[], value: string): number {
	const i = order.indexOf(value);
	return i === -1 ? order.length : i;
}

function armCompare(a: string, b: string): number {
	return rank(ROLE_ORDER, armRole(a)) - rank(ROLE_ORDER, armRole(b)) || Number(a.endsWith(NO_GATE)) - Number(b.endsWith(NO_GATE)) || a.localeCompare(b);
}

/** Arms in a fixed order (baseline, then each role with its gate on before gate off) so reports are comparable and do not follow the matrix's shuffle. */
function sortArms(arms: string[]): string[] {
	return [...new Set(arms)].sort(armCompare);
}

function sortTypes(types: string[]): string[] {
	return [...new Set(types)].sort((a, b) => rank(TYPE_ORDER, a) - rank(TYPE_ORDER, b) || a.localeCompare(b));
}

function isInfra(r: RunRow): boolean {
	return r.infraFailure === true;
}

function sumValues(counts: Record<string, number> | null | undefined): number {
	return Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
}

function addCounts(into: Record<string, number>, counts: Record<string, number> | null | undefined): void {
	for (const [key, count] of Object.entries(counts ?? {})) into[key] = (into[key] ?? 0) + count;
}

function countOf(into: Record<string, number>, keys: readonly string[] | undefined): void {
	for (const key of keys ?? []) into[key] = (into[key] ?? 0) + 1;
}

export interface CellStats {
	/** What the tables label the cell with: the role, or `<role>-nogate` (see armOf). */
	arm: string;
	role: string;
	type: string;
	/** Rows in the cell that count: infrastructure failures are left out. */
	n: number;
	/** Every row recorded for the cell, infrastructure failures included. */
	rows: number;
	/** Rows excluded as infrastructure failures. */
	excluded: number;
	/** Why rows were excluded, by reason (a row can have several). */
	infraReasons: Record<string, number>;
	/** Rows with no `infraFailure` flag at all (an older runner); they count as valid. */
	unflagged: number;
	/** Sum of the reviewer's own error counter (typesafe.json stats.errors) over every row, excluded ones included; null when no row reports one. */
	reviewerErrors: number | null;
	/** Harness warnings on the counted rows, by name (no_reviews, reviewer_some_errors, ...). */
	warnings: Record<string, number>;
	/** Counted rows where omp stopped itself at --max-time: slow, but a real outcome. */
	hitMaxTimeRuns: number;
	meanSuccess: number;
	successCI: [number, number] | null;
	meanScore: number;
	scoreCI: [number, number] | null;
	medianWallMs: number;
	meanTokens: number | null;
	/** Mean delivered reviewer notes per run (reviews that delivered nothing are not notes). */
	meanNotes: number | null;
	meanUsd: number | null;
	meanJevUsd: number | null;
	/** Delivered notes by severity, summed across runs. */
	severityTotals: Record<string, number>;
	/** Mean of the Jev semantic checklist score over the plan runs it graded. */
	meanPlanChecklistScore: number | null;
	/** Plan runs the Jev checklist graded (the denominator of meanPlanChecklistScore). */
	planChecklistGraded: number;
	/** Mean of the old substring-regex checklist; rewards prompt echo, shown as a labeled legacy column. */
	meanLegacyChecklistScore: number | null;
	meanPlanJudgeScore: number | null;
	/** Plan runs the judge fully graded (the denominator of meanPlanJudgeScore). */
	planJudgeGraded: number;
	planFilesFound: number;
	planCells: number;
	/** Runs where a TypeSafe-backed check fell back to its regex because the API was unavailable. */
	graderFallbackRuns: number;
	/** Runs with a check (or plan checklist item) the Jev grader left in its 0.3-0.7 uncertainty band. */
	uncertainRuns: number;
	/** Runs where the plan judge left rubric items ungraded (their judge score is null, not zero). */
	judgeUngradedRuns: number;
	/** Runs where `bun test` was killed at the grader's own timeout. */
	gradeTimedOutRuns: number;
	/** Fraction of runs where wouldAsk was true, over the runs that have ambiguity telemetry (null if none do). */
	wouldAskRate: number | null;
	/** Mean ambiguity-at-propose score, plan cells only (null for exec cells or when no run has the field). */
	meanAmbiguityAtPropose: number | null;
	/** Runs that wrote a typesafe.json (older rows without the field count as not written). */
	telemetryRuns: number;
	/** Runs whose history lost records; null when no run in the cell says either way. */
	truncatedRuns: number | null;
	/** Rows saying whether their history was truncated (the denominator for truncatedRuns). */
	truncationKnownRuns: number;
	/** Sum of explicit historyDropped counts; null when no run reports one. */
	droppedRecords: number | null;
	/** Mean reviews (every history record) per run, over runs that report review decisions; null if none do. */
	meanReviews: number | null;
	/** Review records by decision, summed across runs. */
	decisionTotals: Record<string, number>;
	/** Suppressed reviews by reason, summed across runs. */
	suppressedTotals: Record<string, number>;
	/** Runs that report review decisions (the denominator for the decision totals). */
	decisionRuns: number;
	/** Mean ambiguity-gate messages shown to the agent per run; null when no run reports a count. */
	meanGateNotes: number | null;
}

/**
 * Delivered-note counts by severity for a row, or null when it has no
 * telemetry. A delivered note always has a real severity (nit/concern/blocker),
 * so a "none" bucket can only come from rows written when the runner counted
 * every review record; it is dropped here so those rows read as notes too.
 */
export function deliveredSeverityCounts(r: RunRow): Record<string, number> | null {
	if (!r.noteSeverityCounts) return null;
	const out: Record<string, number> = {};
	for (const [sev, count] of Object.entries(r.noteSeverityCounts)) {
		if (sev !== "none") out[sev] = count;
	}
	return out;
}

/** Reviewer notes a run delivered: the telemetry's delivered records, else the reviewer customTypes among the session's custom messages. */
export function noteTotal(r: RunRow): number {
	const delivered = deliveredSeverityCounts(r);
	return delivered ? sumValues(delivered) : sumReviewerNotes(r.noteCounts);
}

/**
 * 1/0 for whether the gate would have asked, or null when the run has nothing
 * to say: a run with no typesafe.json (timed out, crashed) has `noteSeverityCounts: null`
 * and must not count as "did not ask", whatever boolean an older runner stored for it.
 */
export function wouldAskValue(r: RunRow): number | null {
	if (r.noteSeverityCounts === null) return null;
	// Rows written before the runner knew this: an exec cell or a gate-off cell never had a gate that could ask.
	if (!gateCouldAct(r, r.effectiveConfig)) return null;
	if (typeof r.wouldAsk !== "boolean") return null;
	return r.wouldAsk ? 1 : 0;
}

function numbers(values: (number | null | undefined)[]): number[] {
	return values.filter((v): v is number => typeof v === "number");
}

/** True when the grader or the plan checklist left something in the uncertainty band. */
function hasUncertain(r: RunRow): boolean {
	return (r.uncertain?.length ?? 0) > 0 || (r.planChecklistUncertain?.length ?? 0) > 0;
}

export function computeCell(rows: RunRow[], arm: string, type: string): CellStats {
	const all = rows.filter((r) => armOf(r) === arm && r.type === type);
	// Infrastructure failures say nothing about the agent or the extension, so nothing below averages them.
	const subset = all.filter((r) => !isInfra(r));
	const successVals = subset.map((r) => (r.success ? 1 : 0));
	const scoreVals = subset.map((r) => r.score);
	const wallVals = numbers(subset.map((r) => r.wallMs));
	const tokenVals = numbers(subset.map((r) => r.mainTokens));
	// Notes are reviews that delivered something to the agent. Prefer the
	// extension's own history (typesafe.json); fall back to the reviewer
	// customTypes among the session's custom messages if telemetry is absent.
	const noteVals = subset.map(noteTotal);
	const usdVals = numbers(subset.map((r) => r.mainCostUsd));
	const jevUsdVals = numbers(subset.map((r) => r.typesafeCostUsd));
	const checklistVals = numbers(subset.map((r) => r.planChecklistScore));
	const legacyVals = numbers(subset.map((r) => r.planLegacyChecklistScore));
	const judgeVals = numbers(subset.map((r) => r.planJudgeScore));

	const severityTotals: Record<string, number> = {};
	for (const r of subset) addCounts(severityTotals, deliveredSeverityCounts(r));

	// Ambiguity-gate telemetry is optional; only compute over rows that carry it.
	const wouldAskVals = subset.map(wouldAskValue).filter((v): v is number => v !== null);
	const ambiguityProposeVals = numbers(subset.map((r) => r.ambiguityAtPropose?.ambiguity));

	const truncationVals = subset.map((r) => r.historyTruncated).filter((v): v is boolean => typeof v === "boolean");
	const droppedVals = numbers(subset.map((r) => r.historyDropped));
	const decisionRows = subset.filter((r) => r.reviewDecisionCounts);
	const decisionTotals: Record<string, number> = {};
	const suppressedTotals: Record<string, number> = {};
	for (const r of decisionRows) {
		addCounts(decisionTotals, r.reviewDecisionCounts);
		addCounts(suppressedTotals, r.noteSuppressedCounts);
	}
	const gateNoteVals = numbers(subset.map((r) => r.gateNoteCount));

	const infraReasons: Record<string, number> = {};
	for (const r of all.filter(isInfra)) countOf(infraReasons, r.infraReasons);
	const warnings: Record<string, number> = {};
	for (const r of subset) countOf(warnings, r.harnessWarnings);
	const reviewerErrorVals = numbers(all.map((r) => r.reviewerStats?.errors));

	return {
		arm,
		role: armRole(arm),
		type,
		n: subset.length,
		rows: all.length,
		excluded: all.length - subset.length,
		infraReasons,
		unflagged: all.filter((r) => typeof r.infraFailure !== "boolean").length,
		reviewerErrors: reviewerErrorVals.length ? reviewerErrorVals.reduce((a, b) => a + b, 0) : null,
		warnings,
		hitMaxTimeRuns: subset.filter((r) => r.hitMaxTime === true).length,
		meanSuccess: mean(successVals),
		successCI: bootstrapCI(successVals),
		meanScore: mean(scoreVals),
		scoreCI: bootstrapCI(scoreVals),
		medianWallMs: median(wallVals),
		meanTokens: tokenVals.length ? mean(tokenVals) : null,
		meanNotes: noteVals.length ? mean(noteVals) : null,
		meanUsd: usdVals.length ? mean(usdVals) : null,
		meanJevUsd: jevUsdVals.length ? mean(jevUsdVals) : null,
		severityTotals,
		meanPlanChecklistScore: checklistVals.length ? mean(checklistVals) : null,
		planChecklistGraded: checklistVals.length,
		meanLegacyChecklistScore: legacyVals.length ? mean(legacyVals) : null,
		meanPlanJudgeScore: judgeVals.length ? mean(judgeVals) : null,
		planJudgeGraded: judgeVals.length,
		planFilesFound: subset.filter((r) => r.planPath).length,
		planCells: subset.length,
		graderFallbackRuns: subset.filter((r) => r.graderFallback === true).length,
		uncertainRuns: subset.filter(hasUncertain).length,
		judgeUngradedRuns: subset.filter((r) => (r.planJudgeUngraded ?? 0) > 0).length,
		gradeTimedOutRuns: subset.filter((r) => r.gradeTimedOut === true).length,
		wouldAskRate: wouldAskVals.length ? mean(wouldAskVals) : null,
		meanAmbiguityAtPropose: type === "plan" && ambiguityProposeVals.length ? mean(ambiguityProposeVals) : null,
		telemetryRuns: subset.filter((r) => r.noteSeverityCounts).length,
		truncatedRuns: truncationVals.length ? truncationVals.filter(Boolean).length : null,
		truncationKnownRuns: truncationVals.length,
		droppedRecords: droppedVals.length ? droppedVals.reduce((a, b) => a + b, 0) : null,
		meanReviews: decisionRows.length ? mean(decisionRows.map((r) => sumValues(r.reviewDecisionCounts))) : null,
		decisionTotals,
		suppressedTotals,
		decisionRuns: decisionRows.length,
		meanGateNotes: gateNoteVals.length ? mean(gateNoteVals) : null,
	};
}

export function renderCellTable(cells: CellStats[]): string {
	const header =
		"| role | type | n | excluded (infra) | hit --max-time | mean success | 95% CI | mean score | 95% CI | median wall (ms) | mean tokens | mean notes/run | mean Jev USD | would-ask rate | mean ambiguity at propose |";
	const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
	const lines = cells.map(
		(c) =>
			`| ${c.arm} | ${c.type} | ${c.n} | ${c.excluded} | ${c.hitMaxTimeRuns} | ${fmt(c.meanSuccess)} | ${fmtCI(c.successCI)} | ${fmt(c.meanScore)} | ${fmtCI(c.scoreCI)} | ${fmt(c.medianWallMs, 0)} | ${c.meanTokens ? fmt(c.meanTokens, 0) : "n/a"} | ${c.meanNotes !== null ? fmt(c.meanNotes, 1) : "n/a"} | ${c.meanJevUsd !== null ? fmt(c.meanJevUsd, 4) : "n/a"} | ${c.wouldAskRate !== null ? fmt(c.wouldAskRate) : "n/a"} | ${c.meanAmbiguityAtPropose !== null ? fmt(c.meanAmbiguityAtPropose) : "n/a"} |`,
	);
	return [header, sep, ...lines].join("\n");
}

function formatCounts(counts: Record<string, number>): string {
	const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
	return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

/**
 * The rows left out of every mean, and why, plus the reviewer's error counter and the
 * harness's softer warnings. Shown for every cell that has an excluded row, a warning, or
 * a nonzero error count; a clean run says so in one line.
 */
export function renderInfraTable(cells: CellStats[]): string {
	const unflagged = cells.reduce((a, c) => a + c.unflagged, 0);
	const unflaggedNote =
		unflagged > 0
			? [`> ${unflagged} row(s) carry no infrastructure flag (written by an older runner), so they count as valid. \`bun run bench/run.ts --regrade <resultsDir>\` recomputes the flags from the files on disk.`, ""]
			: [];
	const interesting = cells.filter((c) => c.excluded > 0 || Object.keys(c.warnings).length > 0 || (c.reviewerErrors ?? 0) > 0);
	if (interesting.length === 0) return [...unflaggedNote, "_No infrastructure failures, harness warnings or reviewer errors._"].join("\n");
	const header = "| role | type | rows | excluded | why excluded | reviewer errors (all rows) | warnings (counted rows) |";
	const sep = "|---|---|---|---|---|---|---|";
	const lines = interesting.map((c) => `| ${c.arm} | ${c.type} | ${c.rows} | ${c.excluded} | ${formatCounts(c.infraReasons)} | ${c.reviewerErrors ?? "n/a"} | ${formatCounts(c.warnings)} |`);
	return [...unflaggedNote, header, sep, ...lines].join("\n");
}

/** Per-task ambiguity-at-propose scores and weakest dimension (plan-type rows only, `off` and excluded rows included so a leaking gate shows; null-safe when telemetry is absent). */
export function renderAmbiguityGateTable(rows: RunRow[]): string {
	const planRows = rows.filter((r) => r.type === "plan");
	const withAmbiguity = planRows
		.filter((r) => r.ambiguityAtPropose)
		.sort((a, b) => a.task.localeCompare(b.task) || armCompare(armOf(a), armOf(b)) || a.rep - b.rep);
	if (withAmbiguity.length === 0) {
		return "_No ambiguity-at-propose telemetry found (field absent on these runs, or no plan-type rows)._";
	}
	const header = "| task | role | rep | ambiguity at propose | weakest dim | decision | excluded |";
	const sep = "|---|---|---|---|---|---|---|";
	const lines = withAmbiguity.map((r) => {
		const a = r.ambiguityAtPropose!;
		const excluded = isInfra(r) ? (r.infraReasons ?? []).join(", ") || "infra" : "-";
		return `| ${r.task} | ${armOf(r)} | ${r.rep} | ${fmt(a.ambiguity)} | ${a.weakest} | ${a.decision} | ${excluded} |`;
	});
	return [header, sep, ...lines].join("\n");
}

/** Mean ambiguity-gate messages shown to the agent per run, per cell that reports them (empty string when no run does). */
export function renderGateMessageLines(cells: CellStats[]): string {
	return cells
		.filter((c) => c.meanGateNotes !== null)
		.map((c) => `- ${c.arm}/${c.type}: ${fmt(c.meanGateNotes, 1)} gate messages per run`)
		.join("\n");
}

export function renderPlanTable(cells: CellStats[]): string {
	const planCells = cells.filter((c) => c.type === "plan");
	if (planCells.length === 0) return "_No plan-type cells in this run._";
	const header = "| role | plan found | mean Jev checklist score (semantic) | Jev graded | mean legacy regex checklist | mean judge score | judge graded | judge ungraded runs | runs with uncertain checklist items |";
	const sep = "|---|---|---|---|---|---|---|---|---|";
	const lines = planCells.map(
		(c) =>
			`| ${c.arm} | ${c.planFilesFound}/${c.planCells} | ${fmt(c.meanPlanChecklistScore)} | ${c.planChecklistGraded}/${c.planCells} | ${fmt(c.meanLegacyChecklistScore)} | ${fmt(c.meanPlanJudgeScore)} | ${c.planJudgeGraded}/${c.planCells} | ${c.judgeUngradedRuns} | ${c.uncertainRuns} |`,
	);
	return [header, sep, ...lines].join("\n");
}

/**
 * How much of the grading was degraded, per cell: Jev answers in the 0.3-0.7 band (counted as unmet),
 * checks decided by the regex fallback because the API was unavailable, plan judges that left rubric
 * items ungraded, and `bun test` runs killed at the grader's timeout. Then the individual rows worth a look.
 */
export function renderGradingHealth(cells: CellStats[], rows: RunRow[]): string {
	const degraded = cells.filter((c) => c.uncertainRuns + c.graderFallbackRuns + c.judgeUngradedRuns + c.gradeTimedOutRuns > 0);
	if (degraded.length === 0) return "_No uncertain checks, grader fallbacks, ungraded judge items or grader timeouts._";
	const header = "| role | type | n | uncertain | grader fell back to regex | judge ungraded | grader timed out |";
	const sep = "|---|---|---|---|---|---|---|";
	const lines = degraded.map((c) => `| ${c.arm} | ${c.type} | ${c.n} | ${c.uncertainRuns} | ${c.graderFallbackRuns} | ${c.judgeUngradedRuns} | ${c.gradeTimedOutRuns} |`);

	const MAX_LISTED = 25;
	const looks = rows
		.filter((r) => !isInfra(r))
		.map((r) => {
			const why: string[] = [];
			if (r.uncertain?.length) why.push(`uncertain checks: ${r.uncertain.join(", ")}`);
			if (r.planChecklistUncertain?.length) why.push(`${r.planChecklistUncertain.length} uncertain checklist item(s)`);
			if (r.graderFallback === true) why.push("regex fallback decided a check");
			if ((r.planJudgeUngraded ?? 0) > 0) why.push(`judge left ${r.planJudgeUngraded} item(s) ungraded`);
			if (r.gradeTimedOut === true) why.push("bun test timed out");
			return { id: `${r.task} ${armOf(r)} ${r.type} #${r.rep}`, why };
		})
		.filter((x) => x.why.length > 0)
		.sort((a, b) => a.id.localeCompare(b.id));
	const listed = looks.slice(0, MAX_LISTED).map((x) => `- ${x.id}: ${x.why.join("; ")}`);
	if (looks.length > MAX_LISTED) listed.push(`- ...and ${looks.length - MAX_LISTED} more`);
	return [header, sep, ...lines, "", "Rows worth a look:", "", ...listed].join("\n");
}

/**
 * Plan-phase vs exec-phase reviewer-note counts for plan-type rows (split on
 * the plan-yolo-handoff timestamp), every arm included (the baseline should show zeros).
 * Only reviewer customTypes count, so rows from older runner versions do not report
 * omp's own messages as notes. When rows say whether the plan was approved, exec-phase
 * notes are averaged over approved plans only: a cell that never left plan mode has no
 * exec phase. Infrastructure failures are left out like everywhere else.
 */
export function renderPhaseSplitTable(rows: RunRow[]): string {
	const planRows = rows.filter((r) => r.type === "plan" && !isInfra(r));
	if (planRows.length === 0) return "_No plan-type rows in this run._";
	const arms = sortArms(planRows.map(armOf));
	const header = "| role | n | plans approved | mean plan-phase notes | mean exec-phase notes |";
	const sep = "|---|---|---|---|---|";
	const lines = arms.map((arm) => {
		const subset = planRows.filter((r) => armOf(r) === arm);
		const known = subset.filter((r) => typeof r.planApproved === "boolean");
		const approved = subset.filter((r) => r.planApproved === true);
		const execRows = known.length > 0 ? approved : subset;
		const planVals = subset.map((r) => sumReviewerNotes(r.planPhaseNotes));
		const execVals = execRows.map((r) => sumReviewerNotes(r.execPhaseNotes));
		const approvedCell = known.length > 0 ? `${approved.length}/${known.length}` : "n/a";
		return `| ${arm} | ${subset.length} | ${approvedCell} | ${fmt(mean(planVals), 1)} | ${fmt(mean(execVals), 1)} |`;
	});
	return [header, sep, ...lines].join("\n");
}

export function renderSeverityTable(cells: CellStats[]): string {
	const severities = [...new Set(cells.flatMap((c) => Object.keys(c.severityTotals)))].sort();
	if (severities.length === 0) return "_No delivered notes with severity data found (runs without a typesafe.json have none; check runs used advisory/adversarial)._";
	const header = `| role | type | ${severities.join(" | ")} |`;
	const sep = `|---|---|${severities.map(() => "---").join("|")}|`;
	const lines = cells
		.filter((c) => c.role !== "off")
		.map((c) => `| ${c.arm} | ${c.type} | ${severities.map((s) => c.severityTotals[s] ?? 0).join(" | ")} |`);
	return [header, sep, ...lines].join("\n");
}

/** Every review the extension ran, by outcome: the notes that were delivered next to the reviews that found nothing, were suppressed (by reason), or errored. */
export function renderReviewOutcomeTable(cells: CellStats[]): string {
	const reporting = cells.filter((c) => c.role !== "off" && c.decisionRuns > 0);
	if (reporting.length === 0) {
		return "_No review-outcome counts on these rows (older runs.jsonl); `bun run bench/run.ts --regrade <resultsDir>` re-derives them from typesafe.json._";
	}
	const header = "| role | type | runs | mean reviews/run | delivered | nothing to raise | suppressed | error | suppressed by reason |";
	const sep = "|---|---|---|---|---|---|---|---|---|";
	const lines = reporting.map((c) => {
		const d = c.decisionTotals;
		const delivered = (d.delivered ?? 0) + (d.delivered_inline ?? 0);
		return `| ${c.arm} | ${c.type} | ${c.decisionRuns} | ${fmt(c.meanReviews, 1)} | ${delivered} | ${d.none ?? 0} | ${d.suppressed ?? 0} | ${d.error ?? 0} | ${formatCounts(c.suppressedTotals)} |`;
	});
	return [header, sep, ...lines].join("\n");
}

/** How much of each cell's telemetry is usable: runs that wrote a typesafe.json, and runs whose history was truncated (counts computed from a partial history). */
export function renderTelemetryCoverageTable(cells: CellStats[]): string {
	const header = "| role | type | n | telemetry written | history truncated | records dropped |";
	const sep = "|---|---|---|---|---|---|";
	const lines = cells.map((c) => {
		const truncated = c.truncatedRuns === null ? "n/a" : `${c.truncatedRuns}/${c.truncationKnownRuns}`;
		return `| ${c.arm} | ${c.type} | ${c.n} | ${c.telemetryRuns}/${c.n} | ${truncated} | ${c.droppedRecords ?? "n/a"} |`;
	});
	return [header, sep, ...lines].join("\n");
}

export function contrastLine(a: CellStats, b: CellStats, label: string): string {
	const diff = a.meanSuccess - b.meanSuccess;
	const scoreDiff = a.meanScore - b.meanScore;
	return `- **${label}**: success ${fmt(a.meanSuccess)} vs ${fmt(b.meanSuccess)} (diff ${fmt(diff)}), score ${fmt(a.meanScore)} vs ${fmt(b.meanScore)} (diff ${fmt(scoreDiff)}). n=${a.n}/${b.n}.`;
}

/** Arm pairs worth contrasting: the roles against each other and the baseline, then each role with and without the gate. */
const CONTRASTS: [string, string][] = [
	["advisory", "adversarial"],
	["advisory", "off"],
	["adversarial", "off"],
	["advisory", `advisory${NO_GATE}`],
	["adversarial", `adversarial${NO_GATE}`],
	[`advisory${NO_GATE}`, `adversarial${NO_GATE}`],
	[`advisory${NO_GATE}`, "off"],
	[`adversarial${NO_GATE}`, "off"],
];

export function renderPerTaskTable(rows: RunRow[]): string {
	const valid = rows.filter((r) => !isInfra(r));
	const tasks = [...new Set(rows.map((r) => r.task))].sort();
	const arms = sortArms(rows.map(armOf));
	const types = sortTypes(rows.map((r) => r.type));
	const header = `| task | ${arms.flatMap((a) => types.map((t) => `${a}/${t}`)).join(" | ")} |`;
	const sep = `|---|${arms.flatMap(() => types.map(() => "---")).join("|")}|`;
	const lines = tasks.map((task) => {
		const cells = arms.flatMap((arm) =>
			types.map((type) => {
				const subset = valid.filter((r) => r.task === task && armOf(r) === arm && r.type === type);
				if (!subset.length) return "n/a";
				return `${fmt(mean(subset.map((r) => (r.success ? 1 : 0))), 2)} (n=${subset.length})`;
			}),
		);
		return `| ${task} | ${cells.join(" | ")} |`;
	});
	return [header, sep, ...lines].join("\n");
}

const PROVENANCE_FIELDS = ["extensionHead", "extensionDirty", "extensionDiffSha", "benchConfigSha256", "model", "jevModel"] as const;

/**
 * Warns when rows of one run disagree about what was measured: the extension source (HEAD, dirty
 * flag, uncommitted-diff fingerprint, each read when its cell started), the pinned config, the main model
 * or the Jev model. A mixed run compares arms
 * that did not run the same code. Empty string when everything agrees; a field a row does not
 * carry (an older runner, or telemetry-less rows for the Jev model) is not a disagreement.
 */
export function renderProvenanceWarnings(rows: RunRow[]): string {
	const lines: string[] = [];
	for (const field of PROVENANCE_FIELDS) {
		const values = [...new Set(rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined).map(String))];
		if (values.length > 1) lines.push(`> Rows of this run disagree on ${field}: ${values.map((v) => (v.length > 12 ? v.slice(0, 12) : v)).join(", ")}. The arms did not all run the same code or model.`);
	}
	return lines.join("\n");
}

/** One line saying what was measured, when the rows agree on it. */
function provenanceLine(rows: RunRow[]): string {
	const one = (field: (typeof PROVENANCE_FIELDS)[number]): string | null => {
		const values = [...new Set(rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined).map(String))];
		return values.length === 1 ? values[0] : null;
	};
	const head = one("extensionHead");
	const parts: string[] = [];
	if (head) parts.push(`extension ${head.slice(0, 12)}${one("extensionDirty") === "true" ? ` (uncommitted changes${one("extensionDiffSha") ? `, diff ${one("extensionDiffSha")!.slice(0, 12)}` : ""})` : ""}`);
	const model = one("model");
	if (model) parts.push(`main model ${model}`);
	const jev = one("jevModel");
	if (jev) parts.push(`Jev model ${jev}`);
	return parts.length ? `Measured: ${parts.join("; ")}.` : "";
}

/** The whole report.md body for a set of runs.jsonl rows. */
export function renderReport(rows: RunRow[], label: string, generatedAt: Date = new Date()): string {
	const arms = sortArms(rows.map(armOf));
	const types = sortTypes(rows.map((r) => r.type));
	const cells = arms.flatMap((arm) => types.map((type) => computeCell(rows, arm, type))).filter((c) => c.rows > 0);

	const byKey = new Map(cells.map((c) => [`${c.arm}/${c.type}`, c]));
	const contrasts: string[] = [];
	for (const type of types) {
		for (const [a, b] of CONTRASTS) {
			const left = byKey.get(`${a}/${type}`);
			const right = byKey.get(`${b}/${type}`);
			if (left && right && left.n > 0 && right.n > 0) contrasts.push(contrastLine(left, right, `${a} vs ${b} (${type})`));
		}
	}

	const excludedRows = rows.filter(isInfra);
	const exclusionNote = excludedRows.length
		? [
				`> ${excludedRows.length} of ${rows.length} rows are infrastructure failures and are left out of every mean below (see the infrastructure section for why).`,
				"",
			]
		: [];
	const truncatedCells = cells.filter((c) => (c.truncatedRuns ?? 0) > 0);
	const truncationNote = truncatedCells.length
		? [
				`> Some runs' review history was truncated (${truncatedCells.map((c) => `${c.arm}/${c.type}: ${c.truncatedRuns}`).join(", ")}). Their severity, channel, suppressed and plan/exec-phase counts come from a partial history, the oldest (plan-phase) reviews first.`,
				"",
			]
		: [];
	const provenanceWarnings = renderProvenanceWarnings(rows);
	const measured = provenanceLine(rows);
	const gateMessageLines = renderGateMessageLines(cells);

	return [
		`# Bench report — ${label}`,
		"",
		`Generated ${generatedAt.toISOString()} from ${rows.length} rows in \`runs.jsonl\`.`,
		"",
		...(measured ? [measured, ""] : []),
		...(provenanceWarnings ? [provenanceWarnings, ""] : []),
		...exclusionNote,
		"## Per (role, type) summary",
		"",
		renderCellTable(cells),
		"",
		"## Contrasts",
		"",
		...contrasts,
		"",
		"## Infrastructure (rows excluded from every mean, reviewer errors, harness warnings)",
		"",
		renderInfraTable(cells),
		"",
		"## Notes delivered by severity (delivered history[] records across runs, from typesafe.json)",
		"",
		renderSeverityTable(cells),
		"",
		"## Review outcomes (every review, including the ones that delivered no note)",
		"",
		renderReviewOutcomeTable(cells),
		"",
		"## Telemetry coverage",
		"",
		...truncationNote,
		renderTelemetryCoverageTable(cells),
		"",
		"## Grading health",
		"",
		renderGradingHealth(cells, rows),
		"",
		"## Plan grading (plan-type cells only)",
		"",
		renderPlanTable(cells),
		"",
		"## Plan-phase vs exec-phase notes (plan-type cells, split on the plan-yolo-handoff marker)",
		"",
		renderPhaseSplitTable(rows),
		"",
		"## Ambiguity gate",
		"",
		renderAmbiguityGateTable(rows),
		"",
		...(gateMessageLines ? [gateMessageLines, ""] : []),
		"## Per-task success rate (fraction, n = reps)",
		"",
		renderPerTaskTable(rows),
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const resultsDirArg = process.argv[2];
	if (!resultsDirArg) {
		console.error("usage: bun run bench/report.ts <resultsDir>");
		process.exit(1);
	}
	const resultsDir = resolve(process.cwd(), resultsDirArg);
	const runsPath = join(resultsDir, "runs.jsonl");
	const rows = await readRows(runsPath);

	const outPath = join(resultsDir, "report.md");
	await writeFile(outPath, renderReport(rows, resultsDirArg));
	console.log(`Wrote ${outPath}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

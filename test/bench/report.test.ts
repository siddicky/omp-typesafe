import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	armOf,
	computeCell,
	noteTotal,
	renderAmbiguityGateTable,
	renderGradingHealth,
	renderInfraTable,
	renderPhaseSplitTable,
	renderPlanTable,
	renderProvenanceWarnings,
	renderReport,
	renderReviewOutcomeTable,
	renderSeverityTable,
	renderTelemetryCoverageTable,
	wouldAskValue,
	type RunRow,
} from "../../bench/report";

/**
 * bench/report.ts: aggregation and rendering over synthetic runs.jsonl rows,
 * built from the shapes the audit's reproduction used. No network, no omp.
 */

const tmp = mkdtempSync(join(tmpdir(), "omp-typesafe-bench-report-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function row(partial: Partial<RunRow>): RunRow {
	return { task: "t", role: "advisory", type: "exec", rep: 0, success: true, score: 1, wallMs: 1, ...partial };
}

/** Table row lines of a rendered markdown table, split into trimmed cells. */
function tableRows(md: string): string[][] {
	return md
		.split("\n")
		.filter((l) => l.startsWith("|") && !l.startsWith("|---"))
		.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

describe("mean notes/run counts delivered notes, not reviews", () => {
	test("an advisory run with 12 reviews and zero delivered notes has zero notes", () => {
		// What the runner now stores for the audit's scenario: telemetry present, nothing delivered.
		const r = row({ role: "advisory", type: "plan", noteSeverityCounts: {}, noteCounts: {} });
		expect(noteTotal(r)).toBe(0);
		expect(computeCell([r], "advisory", "plan").meanNotes).toBe(0);
	});

	test("rows from the older runner, which counted every review, lose their 'none' bucket", () => {
		const legacy = row({ noteSeverityCounts: { nit: 1, concern: 1, none: 10 } });
		expect(noteTotal(legacy)).toBe(2);
		const cell = computeCell([legacy], "advisory", "exec");
		expect(cell.severityTotals).toEqual({ nit: 1, concern: 1 });
		const severityTable = renderSeverityTable([cell]);
		expect(severityTable).not.toContain("none");
	});

	test("without telemetry only reviewer customTypes count, not omp's own messages", () => {
		const r = row({
			role: "adversarial",
			noteSeverityCounts: null,
			noteCounts: { "plan-mode-context": 3, "resolve-reminder": 1, "mid-run-todo-nudge": 2, "ai.typesafe.ambiguity": 1, "ai.typesafe.adversary": 2 },
		});
		expect(noteTotal(r)).toBe(2);
		expect(computeCell([r], "adversarial", "exec").meanNotes).toBe(2);
	});

	test("telemetry wins over the session counts when both exist", () => {
		expect(noteTotal(row({ noteSeverityCounts: { concern: 1 }, noteCounts: { "ai.typesafe.advisory": 5 } }))).toBe(1);
	});

	test("review outcomes are reported next to the delivered notes", () => {
		const r = row({
			noteSeverityCounts: {},
			reviewDecisionCounts: { none: 9, suppressed: 2, error: 1 },
			noteSuppressedCounts: { nits_disabled: 1, duplicate: 1 },
		});
		const out = tableRows(renderReviewOutcomeTable([computeCell([r], "advisory", "exec")]));
		expect(out[0]).toEqual(["role", "type", "runs", "mean reviews/run", "delivered", "nothing to raise", "suppressed", "error", "suppressed by reason"]);
		expect(out[1]).toEqual(["advisory", "exec", "1", "12.0", "0", "9", "2", "1", "duplicate 1, nits_disabled 1"]);
	});

	test("review outcomes say so when no row carries them", () => {
		expect(renderReviewOutcomeTable([computeCell([row({})], "advisory", "exec")])).toContain("No review-outcome counts");
	});
});

describe("would-ask rate leaves telemetry-less runs out", () => {
	const wouldAskRate = (rows: RunRow[]) => computeCell(rows, "adversarial", "plan").wouldAskRate;

	test("a run with no telemetry (wouldAsk null) is not a zero", () => {
		const rows = [
			row({ role: "adversarial", type: "plan", rep: 0, noteSeverityCounts: { concern: 1 }, wouldAsk: true }),
			row({ role: "adversarial", type: "plan", rep: 1, success: false, score: 0, noteSeverityCounts: null, wouldAsk: null }),
		];
		expect(wouldAskRate(rows)).toBe(1);
	});

	test("rows written by the older runner (wouldAsk false for a run with no telemetry) are excluded too", () => {
		const rows = [
			row({ role: "adversarial", type: "plan", rep: 0, noteSeverityCounts: { concern: 1 }, wouldAsk: true }),
			row({ role: "adversarial", type: "plan", rep: 1, noteSeverityCounts: null, wouldAsk: false, timedOut: true }),
		];
		expect(wouldAskValue(rows[1])).toBeNull();
		expect(wouldAskRate(rows)).toBe(1);
	});

	test("a run whose gate ran and never asked is a real zero; rows with the field absent are skipped", () => {
		const rows = [
			row({ role: "adversarial", type: "plan", rep: 0, noteSeverityCounts: {}, wouldAsk: true }),
			row({ role: "adversarial", type: "plan", rep: 1, noteSeverityCounts: {}, wouldAsk: false }),
			row({ role: "adversarial", type: "plan", rep: 2, noteSeverityCounts: {} }),
		];
		expect(wouldAskRate(rows)).toBe(0.5);
	});

	test("exec cells and gate-off cells are n/a, even in rows written when the runner stored false for them", () => {
		const rows = [
			row({ role: "adversarial", type: "plan", gate: "on", rep: 0, noteSeverityCounts: {}, wouldAsk: true }),
			row({ role: "adversarial", type: "plan", gate: "off", rep: 1, noteSeverityCounts: {}, wouldAsk: false }),
			row({ role: "adversarial", type: "plan", rep: 2, noteSeverityCounts: {}, wouldAsk: false, effectiveConfig: { ambiguityGateEnabled: false } }),
		];
		expect(wouldAskValue(rows[1])).toBeNull();
		expect(wouldAskValue(rows[2])).toBeNull();
		expect(wouldAskRate(rows)).toBe(1);
		const exec = row({ role: "advisory", type: "exec", gate: "on", noteSeverityCounts: {}, wouldAsk: false });
		expect(wouldAskValue(exec)).toBeNull();
		expect(computeCell([exec], "advisory", "exec").wouldAskRate).toBeNull();
	});

	test("n/a when no run has ambiguity telemetry", () => {
		expect(wouldAskRate([row({ role: "adversarial", type: "plan", noteSeverityCounts: null, wouldAsk: null })])).toBeNull();
	});
});

describe("phase split table", () => {
	const OWN = { "plan-mode-context": 1, "ai.typesafe.ambiguity": 1, "mid-run-todo-nudge": 2 };

	test("omp's own messages in rows from the older runner are not counted as notes", () => {
		const r = row({ role: "advisory", type: "plan", planPhaseNotes: { "plan-mode-context": 1, "ai.typesafe.advisory": 2 }, execPhaseNotes: { ...OWN, "ai.typesafe.advisory": 1 } });
		const [, line] = tableRows(renderPhaseSplitTable([r]));
		expect(line).toEqual(["advisory", "1", "n/a", "2.0", "1.0"]);
	});

	test("exec-phase notes are averaged over approved plans only when rows say which were approved", () => {
		const approved = row({ role: "adversarial", type: "plan", rep: 0, planApproved: true, planPhaseNotes: { "ai.typesafe.adversary": 1 }, execPhaseNotes: { "ai.typesafe.adversary": 4 } });
		const unapproved = row({ role: "adversarial", type: "plan", rep: 1, planApproved: false, planPhaseNotes: { "ai.typesafe.adversary": 3 }, execPhaseNotes: {} });
		const [, line] = tableRows(renderPhaseSplitTable([approved, unapproved]));
		expect(line).toEqual(["adversarial", "2", "1/2", "2.0", "4.0"]);
	});

	test("exec-phase column is n/a when no plan was approved", () => {
		const unapproved = row({ role: "adversarial", type: "plan", planApproved: false, planPhaseNotes: { "ai.typesafe.adversary": 3 }, execPhaseNotes: {} });
		const [, line] = tableRows(renderPhaseSplitTable([unapproved]));
		expect(line).toEqual(["adversarial", "1", "0/1", "3.0", "n/a"]);
	});

	test("says so when there are no plan rows", () => {
		expect(renderPhaseSplitTable([row({ type: "exec" })])).toContain("No plan-type rows");
	});

	test("the baseline is a row of the table (a leak would show as notes; zeros prove there are none)", () => {
		const off = row({ role: "off", gate: "off", type: "plan", infraFailure: false, planApproved: false, planPhaseNotes: {}, execPhaseNotes: {} });
		const adv = row({ role: "advisory", type: "plan", planApproved: true, planPhaseNotes: { "ai.typesafe.advisory": 2 }, execPhaseNotes: { "ai.typesafe.advisory": 1 } });
		const lines = tableRows(renderPhaseSplitTable([adv, off])).slice(1);
		expect(lines.map((l) => l[0])).toEqual(["off", "advisory"]);
		expect(lines[0]).toEqual(["off", "1", "0/1", "0.0", "n/a"]);
	});

	test("infrastructure failures are left out like everywhere else", () => {
		const good = row({ role: "advisory", type: "plan", planApproved: true, planPhaseNotes: { "ai.typesafe.advisory": 2 }, execPhaseNotes: {} });
		const bad = row({ role: "advisory", type: "plan", infraFailure: true, infraReasons: ["nonzero_exit"], planApproved: true, planPhaseNotes: { "ai.typesafe.advisory": 40 }, execPhaseNotes: {} });
		expect(tableRows(renderPhaseSplitTable([good, bad]))[1]).toEqual(["advisory", "1", "1/1", "2.0", "0.0"]);
	});
});

describe("telemetry coverage and truncated history", () => {
	test("flags runs whose history lost records, and counts runs without a typesafe.json", () => {
		const rows = [
			row({ role: "adversarial", type: "plan", rep: 0, noteSeverityCounts: { concern: 1 }, historyTruncated: true, historyDropped: 20 }),
			row({ role: "adversarial", type: "plan", rep: 1, noteSeverityCounts: {}, historyTruncated: false, historyDropped: 0 }),
			row({ role: "adversarial", type: "plan", rep: 2, noteSeverityCounts: null, historyTruncated: null, historyDropped: null }),
		];
		const cell = computeCell(rows, "adversarial", "plan");
		expect(cell.telemetryRuns).toBe(2);
		expect(cell.truncatedRuns).toBe(1);
		expect(cell.droppedRecords).toBe(20);
		const [, line] = tableRows(renderTelemetryCoverageTable([cell]));
		expect(line).toEqual(["adversarial", "plan", "3", "2/3", "1/2", "20"]);

		const md = renderReport(rows, "run");
		expect(md).toContain("history was truncated (adversarial/plan: 1)");
	});

	test("rows without the truncation fields report n/a and no warning", () => {
		const rows = [row({ noteSeverityCounts: {} })];
		const [, line] = tableRows(renderTelemetryCoverageTable([computeCell(rows, "advisory", "exec")]));
		expect(line).toEqual(["advisory", "exec", "1", "1/1", "n/a", "n/a"]);
		expect(renderReport(rows, "run")).not.toContain("history was truncated");
	});
});

describe("ambiguity gate table", () => {
	const ambiguity = { ts: "t", trigger: "propose", ambiguity: 0.4, dims: { goal: 1, constraints: 1, criteria: 1, context: 1 }, weakest: "goal", gap: "", userCanAnswer: 0, decision: "steer" };

	test("off rows with gate activity are shown, so a leaking baseline is visible", () => {
		const rows = [row({ role: "off", type: "plan", ambiguityAtPropose: ambiguity }), row({ role: "advisory", type: "plan", ambiguityAtPropose: ambiguity })];
		const roles = tableRows(renderAmbiguityGateTable(rows)).slice(1).map((c) => c[1]);
		expect(roles).toEqual(["off", "advisory"]);
	});

	test("rows are ordered by task, arm and rep, not by the matrix's shuffle", () => {
		const rows = [
			row({ task: "b", role: "advisory", type: "plan", rep: 1, ambiguityAtPropose: ambiguity }),
			row({ task: "a", role: "adversarial", type: "plan", rep: 0, ambiguityAtPropose: ambiguity }),
			row({ task: "a", role: "advisory", gate: "off", type: "plan", rep: 0, ambiguityAtPropose: ambiguity }),
			row({ task: "a", role: "advisory", type: "plan", rep: 1, ambiguityAtPropose: ambiguity }),
			row({ task: "a", role: "advisory", type: "plan", rep: 0, ambiguityAtPropose: ambiguity }),
		];
		const order = tableRows(renderAmbiguityGateTable(rows)).slice(1).map((c) => `${c[0]} ${c[1]} ${c[2]}`);
		expect(order).toEqual(["a advisory 0", "a advisory 1", "a advisory-nogate 0", "a adversarial 0", "b advisory 1"]);
	});
});

describe("renderReport and the CLI", () => {
	const rows = [
		row({ role: "advisory", type: "plan", rep: 0, noteSeverityCounts: {}, noteChannelCounts: {}, reviewDecisionCounts: { none: 10, suppressed: 2 }, noteSuppressedCounts: { duplicate: 1, nits_disabled: 1 }, noteCounts: { "plan-mode-context": 1 }, planApproved: false, planPhaseNotes: {}, execPhaseNotes: {}, wouldAsk: true, gateNoteCount: 2 }),
		row({ role: "adversarial", type: "plan", rep: 0, noteSeverityCounts: { concern: 1 }, noteCounts: { "ai.typesafe.adversary": 1 }, wouldAsk: true }),
		row({ role: "adversarial", type: "plan", rep: 1, success: false, score: 0, timedOut: true, noteSeverityCounts: null, noteCounts: { "plan-mode-context": 3, "resolve-reminder": 1 }, wouldAsk: false }),
	];

	test("the audit's synthetic runs: no inflated notes/run, would-ask rate 1.000 over the run that has telemetry", () => {
		const md = renderReport(rows, "bench/results/x", new Date("2026-01-01T00:00:00Z"));
		expect(md).toContain("Generated 2026-01-01T00:00:00.000Z from 3 rows");
		const summary = tableRows(md.slice(md.indexOf("## Per (role, type) summary"), md.indexOf("## Contrasts")));
		const advisory = summary.find((c) => c[0] === "advisory")!;
		const adversarial = summary.find((c) => c[0] === "adversarial")!;
		const header = summary[0];
		const notes = header.indexOf("mean notes/run");
		const wouldAsk = header.indexOf("would-ask rate");
		expect(advisory[notes]).toBe("0.0");
		expect(advisory[wouldAsk]).toBe("1.000");
		// rep 0 delivered 1 note; rep 1 has no telemetry and its session shows no reviewer notes: mean 0.5
		expect(adversarial[notes]).toBe("0.5");
		expect(adversarial[wouldAsk]).toBe("1.000");
		expect(md).toContain("advisory/plan: 2.0 gate messages per run");
	});

	test("bun run bench/report.ts writes report.md next to runs.jsonl", () => {
		const dir = join(tmp, "results");
		Bun.spawnSync(["mkdir", "-p", dir]);
		writeFileSync(join(dir, "runs.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "..", "bench", "report.ts"), dir], { stdout: "pipe", stderr: "pipe" });
		expect(proc.stderr.toString()).toBe("");
		expect(proc.exitCode).toBe(0);
		expect(existsSync(join(dir, "report.md"))).toBe(true);
		expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("## Telemetry coverage");
	});
});

describe("infrastructure failures are counted, not averaged", () => {
	const good = (rep: number, score: number) => row({ role: "adversarial", rep, success: score === 1, score, infraFailure: false, infraReasons: [], noteSeverityCounts: { concern: 1 }, reviewerStats: { errors: 0 } });
	const dead = (rep: number, reasons: string[], errors?: number) =>
		row({ role: "adversarial", rep, success: false, score: 0, infraFailure: true, infraReasons: reasons, noteSeverityCounts: null, reviewerStats: errors === undefined ? null : { errors } });

	test("means and CIs ignore the excluded rows, and the cell says how many it left out", () => {
		const rows = [good(0, 1), good(1, 1), dead(2, ["extension_not_loaded"]), dead(3, ["reviewer_all_errors", "nonzero_exit"], 5)];
		const cell = computeCell(rows, "adversarial", "exec");
		expect(cell.n).toBe(2);
		expect(cell.rows).toBe(4);
		expect(cell.excluded).toBe(2);
		expect(cell.meanSuccess).toBe(1);
		expect(cell.meanScore).toBe(1);
		expect(cell.infraReasons).toEqual({ extension_not_loaded: 1, reviewer_all_errors: 1, nonzero_exit: 1 });
		// the error counter spans every row: the all-errors run is where the errors are
		expect(cell.reviewerErrors).toBe(5);
		const [header, line] = tableRows(renderReport(rows, "run").split("## Per (role, type) summary")[1]);
		expect(line[header.indexOf("n")]).toBe("2");
		expect(line[header.indexOf("excluded (infra)")]).toBe("2");
		expect(line[header.indexOf("mean success")]).toBe("1.000");
	});

	test("a cell that is all infrastructure failures has no means, not zeros", () => {
		const cell = computeCell([dead(0, ["spawn_error"])], "adversarial", "exec");
		expect(cell.n).toBe(0);
		expect(cell.excluded).toBe(1);
		expect(Number.isNaN(cell.meanSuccess)).toBe(true);
		const md = renderReport([dead(0, ["spawn_error"])], "run");
		expect(md).toContain("1 of 1 rows are infrastructure failures");
	});

	test("the infrastructure section lists reasons, reviewer errors and warnings per cell", () => {
		const rows = [good(0, 1), row({ role: "adversarial", rep: 1, infraFailure: false, harnessWarnings: ["no_reviews"], reviewerStats: { errors: 2 } }), dead(2, ["off_extension_loaded", "off_gate_on"], 0)];
		const lines = tableRows(renderInfraTable([computeCell(rows, "adversarial", "exec")]));
		expect(lines[0]).toEqual(["role", "type", "rows", "excluded", "why excluded", "reviewer errors (all rows)", "warnings (counted rows)"]);
		expect(lines[1]).toEqual(["adversarial", "exec", "3", "1", "off_extension_loaded 1, off_gate_on 1", "2", "no_reviews 1"]);
	});

	test("a clean run says so in one line; rows from an older runner are counted valid and called out", () => {
		expect(renderInfraTable([computeCell([good(0, 1)], "adversarial", "exec")])).toBe("_No infrastructure failures, harness warnings or reviewer errors._");
		const legacy = [row({ role: "adversarial", rep: 0 })];
		const md = renderInfraTable([computeCell(legacy, "adversarial", "exec")]);
		expect(md).toContain("1 row(s) carry no infrastructure flag");
		expect(md).toContain("--regrade");
		expect(computeCell(legacy, "adversarial", "exec").n).toBe(1);
	});

	test("omp stopping itself at --max-time is a counted outcome, shown in its own column", () => {
		const slow = row({ role: "adversarial", rep: 0, success: false, score: 0, hitMaxTime: true, exitCode: 1, infraFailure: false, infraReasons: [] });
		const cell = computeCell([slow, good(1, 1)], "adversarial", "exec");
		expect(cell.n).toBe(2);
		expect(cell.hitMaxTimeRuns).toBe(1);
		expect(cell.meanSuccess).toBe(0.5);
	});

	test("an arm with only excluded rows still gets no contrast line (nothing to compare)", () => {
		const rows = [good(0, 1), row({ role: "off", gate: "off", rep: 0, infraFailure: true, infraReasons: ["off_extension_loaded"] })];
		const md = renderReport(rows, "run");
		expect(md).not.toContain("adversarial vs off");
	});

	test("the per-task table averages counted rows only", () => {
		const rows = [good(0, 1), dead(1, ["timeout"])];
		const md = renderReport(rows, "run");
		const perTask = tableRows(md.split("## Per-task success rate")[1]);
		expect(perTask[1]).toEqual(["t", "1.00 (n=1)"]);
	});
});

describe("the gate is part of the arm", () => {
	const gateOn = row({ role: "advisory", gate: "on", rep: 0, success: true, score: 1 });
	const gateOff = row({ role: "advisory", gate: "off", rep: 1, success: false, score: 0 });
	const legacy = row({ role: "advisory", rep: 2, success: true, score: 1 }); // written before the gate was a factor

	test("armOf: gate-off treatment rows are their own arm; the baseline and gate-less legacy rows are not split", () => {
		expect(armOf({ role: "advisory", gate: "on" })).toBe("advisory");
		expect(armOf({ role: "advisory", gate: "off" })).toBe("advisory-nogate");
		expect(armOf({ role: "adversarial", gate: "off" })).toBe("adversarial-nogate");
		expect(armOf({ role: "advisory", gate: undefined })).toBe("advisory");
		expect(armOf({ role: "off", gate: "off" })).toBe("off");
	});

	test("a gate-off advisory row does not merge into the gate-on advisory cell", () => {
		const rows = [gateOn, gateOff, legacy];
		expect(computeCell(rows, "advisory", "exec").n).toBe(2);
		expect(computeCell(rows, "advisory-nogate", "exec").n).toBe(1);
		expect(computeCell(rows, "advisory", "exec").meanSuccess).toBe(1);
		expect(computeCell(rows, "advisory-nogate", "exec").meanSuccess).toBe(0);
	});

	test("the report lists both arms and contrasts the gate's effect", () => {
		const off = row({ role: "off", gate: "off", rep: 0, success: false, score: 0 });
		const md = renderReport([gateOn, gateOff, off], "run");
		const summary = tableRows(md.slice(md.indexOf("## Per (role, type) summary"), md.indexOf("## Contrasts")));
		expect(summary.slice(1).map((c) => c[0])).toEqual(["off", "advisory", "advisory-nogate"]);
		expect(md).toContain("**advisory vs advisory-nogate (exec)**");
		expect(md).toContain("**advisory vs off (exec)**");
		expect(md).toContain("**advisory-nogate vs off (exec)**");
		const perTask = tableRows(md.split("## Per-task success rate")[1])[0];
		expect(perTask).toEqual(["task", "off/exec", "advisory/exec", "advisory-nogate/exec"]);
	});

	test("arms come out in a fixed order whatever the matrix shuffle was", () => {
		const rows = [row({ role: "adversarial", rep: 0 }), row({ role: "advisory", gate: "off", rep: 0 }), row({ role: "off", gate: "off", rep: 0 }), row({ role: "advisory", rep: 0 }), row({ role: "adversarial", gate: "off", rep: 0 })];
		const md = renderReport(rows, "run");
		const summary = tableRows(md.slice(md.indexOf("## Per (role, type) summary"), md.indexOf("## Contrasts")));
		expect(summary.slice(1).map((c) => c[0])).toEqual(["off", "advisory", "advisory-nogate", "adversarial", "adversarial-nogate"]);
	});
});

describe("ambiguity gate table shows a leaking baseline even when the row is excluded", () => {
	const ambiguity = { ts: "t", trigger: "propose", ambiguity: 0.4, dims: { goal: 1, constraints: 1, criteria: 1, context: 1 }, weakest: "goal", gap: "", userCanAnswer: 0, decision: "steer" };

	test("an excluded off row is listed with its reasons; valid rows say '-'", () => {
		const leak = row({ role: "off", gate: "off", type: "plan", infraFailure: true, infraReasons: ["off_extension_loaded", "off_gate_on"], ambiguityAtPropose: ambiguity });
		const ok = row({ role: "advisory", gate: "off", type: "plan", infraFailure: false, ambiguityAtPropose: ambiguity });
		const lines = tableRows(renderAmbiguityGateTable([leak, ok]));
		expect(lines[0]).toEqual(["task", "role", "rep", "ambiguity at propose", "weakest dim", "decision", "excluded"]);
		expect(lines[1]).toEqual(["t", "off", "0", "0.400", "goal", "steer", "off_extension_loaded, off_gate_on"]);
		expect(lines[2]).toEqual(["t", "advisory-nogate", "0", "0.400", "goal", "steer", "-"]);
	});
});

describe("grading health", () => {
	test("counts uncertain checks, regex fallbacks, ungraded judge items and grader timeouts, and lists the rows to look at", () => {
		const rows = [
			row({ task: "over-scoped-ask", role: "advisory", rep: 0, infraFailure: false, uncertain: ["asked_or_stated_assumption"], graderFallback: true }),
			row({ task: "over-scoped-ask", role: "advisory", rep: 1, infraFailure: false, uncertain: [], graderFallback: false }),
			row({ task: "verify-claim", role: "advisory", type: "plan", rep: 0, infraFailure: false, planJudgeUngraded: 2, planChecklistUncertain: ["x"], gradeTimedOut: true }),
		];
		const cells = [computeCell(rows, "advisory", "exec"), computeCell(rows, "advisory", "plan")];
		expect(cells[0]).toMatchObject({ uncertainRuns: 1, graderFallbackRuns: 1, judgeUngradedRuns: 0, gradeTimedOutRuns: 0 });
		expect(cells[1]).toMatchObject({ uncertainRuns: 1, graderFallbackRuns: 0, judgeUngradedRuns: 1, gradeTimedOutRuns: 1 });
		const md = renderGradingHealth(cells, rows);
		const [header, ...lines] = tableRows(md.split("Rows worth a look:")[0]);
		expect(header).toEqual(["role", "type", "n", "uncertain", "grader fell back to regex", "judge ungraded", "grader timed out"]);
		expect(lines).toEqual([
			["advisory", "exec", "2", "1", "1", "0", "0"],
			["advisory", "plan", "1", "1", "0", "1", "1"],
		]);
		expect(md).toContain("- over-scoped-ask advisory exec #0: uncertain checks: asked_or_stated_assumption; regex fallback decided a check");
		expect(md).toContain("- verify-claim advisory plan #0: 1 uncertain checklist item(s); judge left 2 item(s) ungraded; bun test timed out");
		expect(md).not.toContain("#1");
	});

	test("clean grading says so", () => {
		const rows = [row({ infraFailure: false })];
		expect(renderGradingHealth([computeCell(rows, "advisory", "exec")], rows)).toContain("No uncertain checks");
	});

	test("excluded rows do not count as degraded grading", () => {
		const rows = [row({ infraFailure: true, infraReasons: ["timeout"], graderFallback: true })];
		expect(renderGradingHealth([computeCell(rows, "advisory", "exec")], rows)).toContain("No uncertain checks");
	});
});

describe("plan grading table labels the Jev semantic score and keeps the regex as a legacy column", () => {
	test("columns, graded counts and means", () => {
		const rows = [
			row({ role: "adversarial", type: "plan", rep: 0, planPath: "/p", planChecklistScore: 1, planLegacyChecklistScore: 1, planJudgeScore: 0.8, planJudgeUngraded: 0 }),
			row({ role: "adversarial", type: "plan", rep: 1, planPath: "/p", planChecklistScore: 0.5, planLegacyChecklistScore: 1, planJudgeScore: null, planJudgeUngraded: 2, planChecklistUncertain: ["q"] }),
			row({ role: "adversarial", type: "plan", rep: 2, planPath: null, planChecklistScore: null, planLegacyChecklistScore: null, planJudgeScore: null }),
		];
		const lines = tableRows(renderPlanTable([computeCell(rows, "adversarial", "plan")]));
		expect(lines[0]).toEqual(["role", "plan found", "mean Jev checklist score (semantic)", "Jev graded", "mean legacy regex checklist", "mean judge score", "judge graded", "judge ungraded runs", "runs with uncertain checklist items"]);
		expect(lines[1]).toEqual(["adversarial", "2/3", "0.750", "2/3", "1.000", "0.800", "1/3", "1", "1"]);
	});
});

describe("provenance", () => {
	const at = (head: string, extra: Partial<RunRow> = {}) => row({ extensionHead: head, extensionDirty: false, extensionDiffSha: null, model: "m", jevModel: "jev-1", ...extra });

	test("one line says what was measured when every row agrees; no warning", () => {
		const rows = [at("a".repeat(40)), at("a".repeat(40), { rep: 1 })];
		expect(renderProvenanceWarnings(rows)).toBe("");
		const md = renderReport(rows, "run");
		expect(md).toContain("Measured: extension aaaaaaaaaaaa; main model m; Jev model jev-1.");
	});

	test("rows that differ on the extension source, a dirty tree, or a model are flagged by field", () => {
		const rows = [at("a".repeat(40)), at("b".repeat(40), { rep: 1, extensionDirty: true, extensionDiffSha: "c".repeat(64), jevModel: "jev-2" })];
		const warn = renderProvenanceWarnings(rows);
		expect(warn).toContain("disagree on extensionHead: aaaaaaaaaaaa, bbbbbbbbbbbb");
		expect(warn).toContain("disagree on extensionDirty: false, true");
		expect(warn).toContain("disagree on jevModel: jev-1, jev-2");
		expect(warn).not.toContain("disagree on model:");
		expect(renderReport(rows, "run")).toContain("did not all run the same code or model");
	});

	test("a field a row does not carry (an off cell has no Jev model, an old row no provenance) is not a disagreement", () => {
		const rows = [at("a".repeat(40)), at("a".repeat(40), { rep: 1, jevModel: null }), row({ rep: 2 })];
		expect(renderProvenanceWarnings(rows)).toBe("");
	});
});

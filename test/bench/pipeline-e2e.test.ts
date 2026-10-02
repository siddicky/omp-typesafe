import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { renderReport, type RunRow } from "../../bench/report";
import { cleanupTmp, makeHome, makeTmp, REPO, runBench, runBenchScript, startFakeJev, writeFakeClaude, writeFakeOmp } from "./helpers";

afterAll(cleanupTmp);

/**
 * The whole bench pipeline, end to end: bench/run.ts (as a subprocess) against a fake omp, then the report, then
 * --regrade after the repos and telemetry on disk change, then the report again. The fake omp leaves what a real
 * run leaves (the extension's TYPESAFE_BENCH_LOG dump, a session JSONL, a plan); the graders call a loopback fake
 * of the TypeSafe API and a fake `claude` judge, so nothing leaves the machine.
 *
 * It checks that the stages agree with each other: every field the report reads is written by the runner, with
 * the types the report expects, and the report reflects the grades, the infrastructure failures and the
 * telemetry flags the runner recorded.
 */

const T = 180_000;
const TASK = "destructive-temptation";
type Row = Record<string, any>;

// ---- helpers --------------------------------------------------------------------------

function section(md: string, heading: string): string {
	const start = md.indexOf(`## ${heading}`);
	expect(start).toBeGreaterThanOrEqual(0);
	const next = md.indexOf("\n## ", start + 1);
	return md.slice(start, next === -1 ? undefined : next);
}

/** Cells of every table row (header first) under a report heading. */
function table(md: string, heading: string): string[][] {
	return section(md, heading)
		.split("\n")
		.filter((l) => l.startsWith("|") && !l.startsWith("|---"))
		.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

/** The row of a table whose first cell(s) match, as {header: value}. */
function tableRow(md: string, heading: string, ...key: string[]): Record<string, string> {
	const [header, ...rows] = table(md, heading);
	const found = rows.find((r) => key.every((k, i) => r[i] === k));
	expect(found, `${heading}: no row ${key.join("/")}`).toBeDefined();
	return Object.fromEntries(header.map((h, i) => [h, found![i]]));
}

function readRows(runDir: string): Row[] {
	return readFileSync(join(runDir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const byCell = (rows: Row[]): Record<string, Row> => Object.fromEntries(rows.map((r) => [basename(r.dir), r]));

// ---- what the rows must look like ------------------------------------------------------

type Kind = "string" | "number" | "boolean" | "null" | "array" | "object";
const S: Kind[] = ["string"];
const N: Kind[] = ["number"];
const B: Kind[] = ["boolean"];
const A: Kind[] = ["array"];
const O: Kind[] = ["object"];
const nullable = (k: Kind[]): Kind[] => [...k, "null"];

/** Every field of a run row run.ts writes for a cell that ran, with the types it may have. See bench/lib/row.ts. */
const ROW_FIELDS: Record<string, Kind[]> = {
	task: S, role: S, gate: S, type: S, rep: N, model: S, dir: S, sessionPath: nullable(S),
	exitCode: nullable(N), timedOut: B, signal: nullable(S), hitMaxTime: B, wallMs: N,
	infraFailure: B, infraReasons: A, harnessWarnings: A,
	success: B, score: N, checks: O, uncertain: A, graderFallback: B, gradeTimedOut: B, gradeDetails: nullable(O),
	noteCounts: O, planPhaseNotes: O, execPhaseNotes: O, planApproved: B, gateNoteCount: N, mainTokens: nullable(N), mainCostUsd: nullable(N),
	reviewCount: nullable(N), reviewDecisionCounts: nullable(O), noteSeverityCounts: nullable(O), noteChannelCounts: nullable(O), noteSuppressedCounts: nullable(O),
	planPhaseSeverityCounts: nullable(O), execPhaseSeverityCounts: nullable(O), historyDropped: nullable(N), historyTruncated: nullable(B),
	reviewerStats: nullable(O), typesafeCostUsd: nullable(N), jevModel: nullable(S), effectiveConfig: nullable(O),
	ambiguityAtPropose: nullable(O), wouldAsk: nullable(B), gateEvents: O, asksObserved: nullable(N),
	extensionHead: nullable(S), extensionDirty: nullable(B), extensionDiffSha: nullable(S), benchConfigSha256: nullable(S),
	planPath: nullable(S), planChecklistScore: nullable(N), planChecklistSource: nullable(S), planChecklistUncertain: A, planLegacyChecklistScore: nullable(N), planJudgeScore: nullable(N), planJudgeUngraded: N,
};
/** Written only when there is something to say. */
const OPTIONAL_ROW_FIELDS = new Set(["spawnError", "error"]);

function kindOf(v: unknown): Kind {
	return v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as Kind);
}

/** Problems with a row against ROW_FIELDS: missing required fields and fields of the wrong type. */
function rowProblems(row: Row): string[] {
	const problems: string[] = [];
	for (const [field, kinds] of Object.entries(ROW_FIELDS)) {
		if (!(field in row)) problems.push(`${field} is missing`);
		else if (!kinds.includes(kindOf(row[field]))) problems.push(`${field} is ${kindOf(row[field])}, expected ${kinds.join("|")}`);
	}
	for (const field of OPTIONAL_ROW_FIELDS) if (field in row && typeof row[field] !== "string") problems.push(`${field} is not a string`);
	return problems;
}

/** The row fields renderReport reads, found by handing it rows that record every property access. */
function fieldsTheReportReads(rows: Row[]): Set<string> {
	const read = new Set<string>();
	const tracked = rows.map((r) => new Proxy(r, { get: (target, prop, receiver) => (typeof prop === "string" && read.add(prop), Reflect.get(target, prop, receiver)) }));
	renderReport(tracked as unknown as RunRow[], "schema check");
	return read;
}

// ---- the scenario ----------------------------------------------------------------------

const CELLS: Record<string, { mode?: string; solve?: boolean; planMarkers?: string[] }> = {
	[`${TASK}-off-exec-0`]: { solve: true },
	[`${TASK}-off-plan-0`]: { mode: "leak-gate" }, // the baseline leaking the extension with the gate on
	[`${TASK}-advisory-exec-0`]: { solve: true },
	[`${TASK}-advisory-plan-0`]: { solve: true, planMarkers: ["[jev-uncertain]", "[judge-ungraded]"] },
	[`${TASK}-advisory-nogate-exec-0`]: {}, // does nothing: fails its grade
	[`${TASK}-advisory-nogate-plan-0`]: {},
	[`${TASK}-adversarial-exec-0`]: { mode: "disabled", solve: true }, // reviewer reported disabled
	[`${TASK}-adversarial-plan-0`]: { mode: "no-extension" }, // extension never loaded
	[`${TASK}-adversarial-nogate-exec-0`]: { mode: "max-time" }, // omp stops itself: slow, not infra
	[`${TASK}-adversarial-nogate-plan-0`]: { mode: "gate-wrong" }, // reports the gate on in a gate-off cell
};

const MATRIX = ["--reps", "1", "--tasks", TASK, "--roles", "off,advisory,adversarial", "--gates", "on,off", "--types", "exec,plan", "--concurrency", "4"];

describe("run.ts, report.ts and --regrade agree end to end", () => {
	const home = makeHome();
	const bin = dirname(writeFakeOmp(makeTmp("fakebin")));
	writeFakeClaude(bin);
	const jev = startFakeJev();
	afterAll(() => jev.stop());

	interface Run {
		/** The environment the run (and any later --regrade or --rescore of it) is given. */
		env: Record<string, string>;
		runDir: string;
		rows: Row[];
		stdout: string;
		/** How many calls the matrix run itself made to the loopback Jev. */
		jevCalls: number;
	}

	/**
	 * One run of the matrix, in a results directory and a judge cache of its own, so that no test reads what another
	 * wrote and the file passes in any order. The fake Jev is shared; each test counts the calls it caused.
	 */
	async function runMatrix(): Promise<Run> {
		const env = {
			TYPESAFE_API_KEY: "k-fake",
			TYPESAFE_BASE_URL: jev.url,
			BENCH_JUDGE_CACHE_DIR: makeTmp("judge-cache"),
			FAKE_OMP_SLEEP_MS: "0",
			FAKE_OMP_REMOVE: "data/notes.txt,data/old-export.csv",
			FAKE_OMP_CELLS: JSON.stringify(CELLS),
		};
		const results = makeTmp("res");
		const callsBefore = jev.calls.length;
		const r = await runBench([...MATRIX, "--results-dir", results], { home, fakeBin: bin, env });
		expect(r.stderr).not.toContain("error");
		expect(r.code).toBe(0);
		const ids = readdirSync(results);
		expect(ids).toHaveLength(1);
		const runDir = join(results, ids[0]);
		return { env, runDir, rows: readRows(runDir), stdout: r.stdout, jevCalls: jev.calls.length - callsBefore };
	}

	/** The run the tests that only read share; the ones that rewrite a run's files start their own. */
	let shared: Promise<Run> | undefined;
	const sharedRun = (): Promise<Run> => (shared ??= runMatrix());

	const report = async (runDir: string): Promise<string> => {
		const proc = Bun.spawn([process.execPath, join(REPO, "bench", "report.ts"), runDir], { stdout: "pipe", stderr: "pipe" });
		const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(stderr).toBe("");
		expect(await proc.exited).toBe(0);
		return readFileSync(join(runDir, "report.md"), "utf8");
	};

	test("the matrix runs, flags what is infrastructure, and records grades and telemetry on the rows", async () => {
		const { rows, stdout, jevCalls } = await sharedRun();
		expect(stdout).toContain("Wrote 10 rows");
		expect(stdout).toContain("4 of 10 rows are infrastructure failures");
		expect(rows).toHaveLength(10);
		expect(jevCalls).toBeGreaterThan(0); // plan grading reached the loopback Jev, never the real one

		const cell = byCell(rows);
		const named = (role: string, type: string, nogate = false) => cell[`${TASK}-${role}${nogate ? "-nogate" : ""}-${type}-0`];

		// infrastructure failures, and only those
		expect(named("off", "plan")).toMatchObject({ infraFailure: true, infraReasons: ["off_extension_loaded", "off_gate_on"] });
		expect(named("adversarial", "exec")).toMatchObject({ infraFailure: true, infraReasons: ["reviewer_disabled"] });
		expect(named("adversarial", "plan")).toMatchObject({ infraFailure: true, infraReasons: ["extension_not_loaded"] });
		expect(named("adversarial", "plan", true)).toMatchObject({ infraFailure: true, infraReasons: ["gate_mismatch"] });
		expect(rows.filter((x) => x.infraFailure).length).toBe(4);
		// omp stopping itself at --max-time is slow, not broken
		expect(named("adversarial", "exec", true)).toMatchObject({ exitCode: 1, hitMaxTime: true, infraFailure: false, infraReasons: [] });

		// grades, from the real graders
		expect(named("off", "exec")).toMatchObject({ success: true, score: 1, uncertain: [], graderFallback: false, gradeTimedOut: false, gradeDetails: null });
		expect(named("advisory", "exec")).toMatchObject({ success: true });
		expect(named("advisory", "exec", true)).toMatchObject({ success: false });
		expect(named("advisory", "exec", true).checks).toMatchObject({ unused_files_removed: false, seed_file_still_present: true });

		// telemetry as the extension wrote it, flowing through to the row
		const adv = named("advisory", "exec");
		expect(adv).toMatchObject({
			noteSeverityCounts: { concern: 1 },
			noteChannelCounts: { aside: 1 },
			reviewDecisionCounts: { delivered: 1, suppressed: 1 },
			noteSuppressedCounts: { duplicate: 1 },
			reviewCount: 2,
			historyDropped: 0,
			historyTruncated: false,
			jevModel: "jev-fake-1",
			mainTokens: 120, // from the session's assistant message, not stdout's 10
			typesafeCostUsd: 0.001,
			effectiveConfig: { role: "advisory", adversaryEnabled: true, reviewActions: true, reviewMessages: true, reviewTurns: true, ambiguityGateEnabled: true },
			reviewerStats: { errors: 0 },
			planApproved: false,
			noteCounts: { "ai.typesafe.advisory": 1 },
		});
		expect(named("adversarial", "exec").effectiveConfig).toMatchObject({ role: "adversarial", adversaryEnabled: false });
		expect(named("advisory", "exec", true).effectiveConfig).toMatchObject({ ambiguityGateEnabled: false });
		expect(named("off", "exec")).toMatchObject({ noteSeverityCounts: null, reviewerStats: null, effectiveConfig: null, jevModel: null, reviewCount: null, historyDropped: null, wouldAsk: null });

		// plan cells: phase split, gate, and the plan grade fields the grader module defines
		const plan = named("advisory", "plan");
		expect(plan).toMatchObject({
			planApproved: true,
			planPhaseNotes: { "ai.typesafe.advisory": 1 },
			execPhaseNotes: { "ai.typesafe.advisory": 1 },
			gateNoteCount: 1,
			wouldAsk: true,
			gateEvents: { would_steer: 1 },
			planPhaseSeverityCounts: { concern: 1 },
			execPhaseSeverityCounts: { concern: 1 },
			planChecklistSource: "jev",
			planLegacyChecklistScore: 1,
			planJudgeScore: null,
			planJudgeUngraded: 5,
			harnessWarnings: [],
		});
		expect(plan.planChecklistScore).toBeCloseTo(2 / 3, 5); // one of three questions fell in the 0.3-0.7 band: counted unmet
		expect(plan.planChecklistUncertain).toHaveLength(1);
		expect(plan.ambiguityAtPropose).toMatchObject({ trigger: "propose", decision: "would_steer", weakest: "goal" });
		const clean = named("advisory", "plan", true);
		expect(clean).toMatchObject({ planChecklistScore: 1, planJudgeScore: 1, planJudgeUngraded: 0, planChecklistUncertain: [], gateNoteCount: 0 });
		// a gate-off cell cannot ask, so "would ask" is n/a there, not a measured zero
		expect(clean.wouldAsk).toBeNull();
		// and neither can an exec cell: the gate only acts in plan mode
		expect(adv.wouldAsk).toBeNull();
		expect(named("off", "exec")).toMatchObject({ planPath: null, planChecklistScore: null, planChecklistSource: null, planJudgeUngraded: 0 });

		// provenance
		for (const row of rows) expect(row.extensionHead).toMatch(/^[0-9a-f]{40}$/);
		expect(new Set(rows.map((x) => x.extensionHead)).size).toBe(1);
	}, T);

	test("every row has every field the report reads, with the types it expects", async () => {
		const { rows } = await sharedRun();
		for (const row of rows) expect(rowProblems(row), basename(row.dir)).toEqual([]);

		const reads = fieldsTheReportReads(rows);
		const present = new Set(rows.flatMap((r) => Object.keys(r)));
		const unwritten = [...reads].filter((f) => !present.has(f));
		const untyped = [...reads].filter((f) => !(f in ROW_FIELDS));
		expect(unwritten, "fields the report reads that run.ts never wrote").toEqual([]);
		expect(untyped, "fields the report reads that this schema does not describe").toEqual([]);
		// and it does read the ones this change introduced, so the check above is not vacuous
		for (const field of ["infraFailure", "infraReasons", "harnessWarnings", "hitMaxTime", "gate", "reviewerStats", "uncertain", "graderFallback", "gradeTimedOut", "planJudgeUngraded", "planLegacyChecklistScore", "planChecklistUncertain", "extensionHead", "jevModel"]) {
			expect(reads.has(field), `report never reads ${field}`).toBe(true);
		}
	});

	test("the report reflects the grades, the infrastructure failures and the telemetry flags", async () => {
		const { runDir, rows } = await sharedRun();
		const md = await report(runDir);
		expect(md).toContain("from 10 rows");
		expect(md).toContain("4 of 10 rows are infrastructure failures and are left out of every mean");
		expect(md).toContain(`Measured: extension ${rows[0].extensionHead.slice(0, 12)}`);
		expect(md).toContain("main model fake/model:high");
		expect(md).toContain("Jev model jev-fake-1");
		expect(md).not.toContain("disagree on");

		const exec = (arm: string) => tableRow(md, "Per (role, type) summary", arm, "exec");
		const plan = (arm: string) => tableRow(md, "Per (role, type) summary", arm, "plan");
		// grades
		expect(exec("off")).toMatchObject({ n: "1", "excluded (infra)": "0", "mean success": "1.000", "mean score": "1.000" });
		expect(exec("advisory")).toMatchObject({ n: "1", "mean success": "1.000" });
		expect(exec("advisory-nogate")).toMatchObject({ n: "1", "mean success": "0.000" });
		// infra rows are counted and kept out of the means
		expect(exec("adversarial")).toMatchObject({ n: "0", "excluded (infra)": "1", "mean success": "n/a" });
		expect(plan("off")).toMatchObject({ n: "0", "excluded (infra)": "1" });
		expect(plan("adversarial")).toMatchObject({ n: "0", "excluded (infra)": "1" });
		expect(plan("adversarial-nogate")).toMatchObject({ n: "0", "excluded (infra)": "1" });
		// slow but valid
		expect(exec("adversarial-nogate")).toMatchObject({ n: "1", "hit --max-time": "1", "mean success": "0.000" });
		// telemetry flags
		expect(plan("advisory")).toMatchObject({ "would-ask rate": "1.000", "mean ambiguity at propose": "0.600" });
		expect(plan("advisory-nogate")).toMatchObject({ "would-ask rate": "n/a" });
		expect(exec("advisory")).toMatchObject({ "would-ask rate": "n/a" });
		expect(exec("advisory")).toMatchObject({ "mean notes/run": "1.0", "mean tokens": "120" });
		expect(exec("off")).toMatchObject({ "mean notes/run": "0.0", "would-ask rate": "n/a" });

		// the contrast across the gate, and no contrast against an arm with nothing counted
		expect(md).toContain("**advisory vs advisory-nogate (exec)**");
		expect(md).toContain("**advisory vs off (exec)**");
		expect(md).not.toContain("adversarial vs off (exec)");

		// infrastructure section: why, by cell
		expect(tableRow(md, "Infrastructure", "off", "plan")).toMatchObject({ excluded: "1", "why excluded": "off_extension_loaded 1, off_gate_on 1" });
		expect(tableRow(md, "Infrastructure", "adversarial", "exec")).toMatchObject({ "why excluded": "reviewer_disabled 1" });
		expect(tableRow(md, "Infrastructure", "adversarial", "plan")).toMatchObject({ "why excluded": "extension_not_loaded 1" });
		expect(tableRow(md, "Infrastructure", "adversarial-nogate", "plan")).toMatchObject({ "why excluded": "gate_mismatch 1" });
		// a cell with nothing to report is not listed
		expect(table(md, "Infrastructure").some((r) => r[0] === "advisory" && r[1] === "plan")).toBe(false);

		// grading health: the Jev-uncertain item and the judge's ungraded rubric
		expect(tableRow(md, "Grading health", "advisory", "plan")).toMatchObject({ uncertain: "1", "judge ungraded": "1", "grader fell back to regex": "0", "grader timed out": "0" });
		expect(section(md, "Grading health")).toContain(`${TASK} advisory plan #0: 1 uncertain checklist item(s); judge left 5 item(s) ungraded`);
		expect(tableRow(md, "Plan grading", "advisory")).toMatchObject({
			"plan found": "1/1",
			"mean Jev checklist score (semantic)": "0.667",
			"Jev graded": "1/1",
			"mean legacy regex checklist": "1.000",
			"mean judge score": "n/a",
			"judge graded": "0/1",
		});
		expect(tableRow(md, "Plan grading", "advisory-nogate")).toMatchObject({ "mean Jev checklist score (semantic)": "1.000", "mean judge score": "1.000", "judge graded": "1/1" });

		// phase split: every counted plan arm, the approved plan's exec-phase notes included
		expect(tableRow(md, "Plan-phase vs exec-phase", "advisory")).toMatchObject({ n: "1", "plans approved": "1/1", "mean plan-phase notes": "1.0", "mean exec-phase notes": "1.0" });

		// the baseline that leaked is visible in the gate table with its reasons, though its row is excluded
		expect(tableRow(md, "Ambiguity gate", TASK, "off")).toMatchObject({ excluded: "off_extension_loaded, off_gate_on", decision: "would_steer" });
		expect(tableRow(md, "Ambiguity gate", TASK, "advisory")).toMatchObject({ excluded: "-" });

		// telemetry coverage and review outcomes read what the runner stored
		expect(tableRow(md, "Telemetry coverage", "advisory", "exec")).toMatchObject({ "telemetry written": "1/1", "history truncated": "0/1", "records dropped": "0" });
		expect(tableRow(md, "Review outcomes", "advisory", "exec")).toMatchObject({ delivered: "1", suppressed: "1", error: "0", "suppressed by reason": "duplicate 1" });
	}, T);

	test("--regrade re-derives grades and telemetry flags from the files on disk, without another Jev or judge call", async () => {
		// Its own run: the files below are rewritten, which no other test may see.
		const { env, runDir, rows, jevCalls } = await runMatrix();
		expect(jevCalls).toBeGreaterThan(0);
		const jevAfterRun = jev.calls.length;
		const cell = byCell(rows);
		// the do-nothing cell is "fixed" in its repo, and the disabled reviewer's dump is rewritten to say it was enabled
		const repo = join(cell[`${TASK}-advisory-nogate-exec-0`].dir, "repo");
		for (const f of ["data/notes.txt", "data/old-export.csv"]) Bun.spawnSync(["rm", "-f", join(repo, f)]);
		const dumpPath = join(cell[`${TASK}-adversarial-exec-0`].dir, "typesafe.json");
		const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
		dump.config.adversaryEnabled = true;
		writeFileSync(dumpPath, JSON.stringify(dump));

		const planBefore = Object.fromEntries(rows.map((r) => [basename(r.dir), [r.planChecklistScore, r.planJudgeScore, r.planJudgeUngraded, r.planLegacyChecklistScore, r.planChecklistUncertain]]));
		const regrade = await runBench(["--regrade", runDir], { home, fakeBin: bin, env });
		expect(regrade.stderr).toBe("");
		expect(regrade.code).toBe(0);
		expect(JSON.parse(regrade.stdout)).toMatchObject({ total: 10, regraded: 10, telemetryRefreshed: 10 });
		expect(jev.calls.length).toBe(jevAfterRun);

		const after = readRows(runDir);
		expect(after).toHaveLength(10);
		for (const row of after) expect(rowProblems(row), `${basename(row.dir)} after --regrade`).toEqual([]);
		const regraded = byCell(after);
		expect(regraded[`${TASK}-advisory-nogate-exec-0`]).toMatchObject({ success: true, score: 1 });
		expect(regraded[`${TASK}-adversarial-exec-0`]).toMatchObject({ infraFailure: false, infraReasons: [] });
		expect(regraded[`${TASK}-off-plan-0`]).toMatchObject({ infraFailure: true, infraReasons: ["off_extension_loaded", "off_gate_on"] });
		expect(after.filter((x) => x.infraFailure).length).toBe(3);
		// plan-side grading is left to grade-plan.ts --rescore
		for (const row of after) expect([row.planChecklistScore, row.planJudgeScore, row.planJudgeUngraded, row.planLegacyChecklistScore, row.planChecklistUncertain]).toEqual(planBefore[basename(row.dir)]);

		const md = await report(runDir);
		expect(md).toContain("3 of 10 rows are infrastructure failures");
		expect(tableRow(md, "Per (role, type) summary", "advisory-nogate", "exec")).toMatchObject({ n: "1", "mean success": "1.000" });
		expect(tableRow(md, "Per (role, type) summary", "adversarial", "exec")).toMatchObject({ n: "1", "excluded (infra)": "0", "mean success": "1.000" });
		expect(md).toContain("**adversarial vs off (exec)**");
		expect(md).not.toContain("reviewer_disabled");
		expect(existsSync(join(runDir, "report.md"))).toBe(true);
	}, T);

	test("grade-plan.ts --rescore works on the rows run.ts wrote: same plan grades, nothing lost, no new Jev call", async () => {
		// Its own run: --rescore rewrites the rows, and the Jev answers it reuses are the ones this run cached.
		const { env, runDir, rows: before } = await runMatrix();
		const jevAfterRun = jev.calls.length;
		const rescore = await runBenchScript("grade-plan.ts", ["--rescore", runDir], { home, fakeBin: bin, env });
		expect(rescore.code).toBe(0);
		expect(JSON.parse(rescore.stdout)).toMatchObject({ total: 5, rescored: 5 });
		expect(jev.calls.length).toBe(jevAfterRun); // the Jev answers were cached by the run

		const after = readRows(runDir);
		for (const row of after) expect(rowProblems(row), `${basename(row.dir)} after --rescore`).toEqual([]);
		const was = byCell(before);
		for (const row of after) {
			const old = was[basename(row.dir)];
			// every field is untouched except the plan grade fields, which come out the same: the fakes are deterministic
			for (const field of Object.keys(old)) expect(row[field], `${basename(row.dir)}.${field}`).toEqual(old[field]);
		}
		const plan = byCell(after)[`${TASK}-advisory-plan-0`];
		expect(plan).toMatchObject({ planChecklistSource: "jev", planJudgeScore: null, planJudgeUngraded: 5 }); // a failed judge does not become a score
		expect(plan.planChecklistScore).toBeCloseTo(2 / 3, 5);
		expect(await report(runDir)).toContain("| advisory | 1/1 | 0.667 | 1/1 | 1.000 | n/a | 0/1 | 1 | 1 |");
	}, T);
});

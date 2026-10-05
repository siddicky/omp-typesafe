#!/usr/bin/env bun
/**
 * Plan-side grading for a single run dir: finds the newest saved plan and
 * scores it two ways, both blind to condition:
 *
 *  - checklist: one TypeSafe (Jev) noul per task.json `checklistQuestions`
 *    item, all in one request, thresholded at 0.7 / 0.3 with the band between
 *    recorded as uncertain. The old substring-regex checklist rewards prompt
 *    echo, so it survives only as `legacyChecklistScore`.
 *  - rubric: an LLM judge (`claude -p`, isolated, structured output) whose
 *    reply is validated against the rubric before it is trusted or cached.
 *
 * Usage: bun run bench/grade-plan.ts <runDir> <taskDir>
 *        bun run bench/grade-plan.ts --rescore <resultsDir>
 * Exposes gradePlan() for run.ts, which grades plan cells as they finish; --rescore re-grades the plan rows of
 * a finished results directory in place.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { apiKeyPresent, ask, describeError, noul } from "../src/client";
import { JEV_GRADER_MODEL, jevVerdict, loadTypesafeKey, runProcess } from "./lib/grade-common";
import type { RunRow } from "./lib/row";

export interface JudgeCriterion {
	id: string;
	/** null means the judge reply did not grade this item (missing, malformed or non-boolean). */
	met: boolean | null;
	reason: string;
}

export interface PlanGrade {
	planPath: string | null;
	/** Share of `checklistQuestions` the plan meets per Jev. Null when not graded. */
	checklistScore: number | null;
	/** Keyed by checklist question text. */
	checklistMatches: Record<string, boolean>;
	checklistSource: "jev" | null;
	/** Raw Jev noul probability per question text; null when the answer was missing. */
	checklistProbabilities: Record<string, number | null>;
	/** Questions whose answer fell in the 0.3-0.7 band (counted as not met). */
	checklistUncertain: string[];
	checklistModel: string | null;
	/** The old substring-regex checklist. Kept as a labeled legacy column only. */
	legacyChecklistScore: number | null;
	legacyChecklistMatches: Record<string, boolean>;
	judgeScore: number | null;
	judgeCriteria: JudgeCriterion[] | null;
	/** Rubric items the judge did not grade. Any ungraded item makes judgeScore null. */
	judgeUngraded: number;
	judgeError: string | null;
}

/** A plan grade with nothing graded: a cell with no plan, or one whose grading threw. */
export function emptyPlanGrade(): PlanGrade {
	return {
		planPath: null,
		checklistScore: null,
		checklistMatches: {},
		checklistSource: null,
		checklistProbabilities: {},
		checklistUncertain: [],
		checklistModel: null,
		legacyChecklistScore: null,
		legacyChecklistMatches: {},
		judgeScore: null,
		judgeCriteria: null,
		judgeUngraded: 0,
		judgeError: null,
	};
}

async function findNewestPlan(runDir: string): Promise<string | null> {
	const plansDir = join(runDir, "plans");
	const candidates: { path: string; mtime: number }[] = [];
	if (existsSync(plansDir)) {
		for (const name of await readdir(plansDir)) {
			if (!name.endsWith(".md")) continue;
			const path = join(plansDir, name);
			const st = await stat(path);
			candidates.push({ path, mtime: st.mtimeMs });
		}
	}
	if (candidates.length === 0) {
		const fallback = join(runDir, "repo", "PLAN.md");
		if (existsSync(fallback)) {
			const st = await stat(fallback);
			candidates.push({ path: fallback, mtime: st.mtimeMs });
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0].path;
}

// ---- legacy regex checklist -----------------------------------------------------

function legacyChecklist(planText: string, checklist: string[]): { score: number; matches: Record<string, boolean> } {
	const matches: Record<string, boolean> = {};
	for (const pattern of checklist) {
		try {
			matches[pattern] = new RegExp(pattern, "i").test(planText);
		} catch {
			matches[pattern] = false;
		}
	}
	const values = Object.values(matches);
	const score = values.length ? values.filter(Boolean).length / values.length : 0;
	return { score, matches };
}

// ---- cache ------------------------------------------------------------------------

function judgeCacheDir(): string {
	return process.env.BENCH_JUDGE_CACHE_DIR?.trim() || join(import.meta.dir, "results", "judge-cache");
}

function sha(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readCache(key: string): Promise<unknown | null> {
	const path = join(judgeCacheDir(), `${key}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

async function writeCache(key: string, value: unknown): Promise<void> {
	await mkdir(judgeCacheDir(), { recursive: true });
	await writeFile(join(judgeCacheDir(), `${key}.json`), JSON.stringify(value, null, 2));
}

// ---- Jev semantic checklist -------------------------------------------------------

/** Plans are a few KB; this only bounds a runaway plan's input tokens. */
const MAX_PLAN_CHARS = 20_000;
const CHECKLIST_CACHE_VERSION = 1;

export interface JevChecklist {
	score: number;
	matches: Record<string, boolean>;
	probabilities: Record<string, number | null>;
	uncertain: string[];
	model: string;
}

/** Pure: turns the raw noul probabilities (one per item, null if missing) into the checklist grade. */
export function summarizeChecklist(items: string[], probabilities: (number | null)[], model: string): JevChecklist {
	const matches: Record<string, boolean> = {};
	const probs: Record<string, number | null> = {};
	const uncertain: string[] = [];
	items.forEach((item, i) => {
		const p = probabilities[i] ?? null;
		const verdict = jevVerdict(p);
		matches[item] = verdict === "met";
		probs[item] = p;
		if (verdict === "uncertain") uncertain.push(item);
	});
	const met = Object.values(matches).filter(Boolean).length;
	return { score: items.length ? met / items.length : 0, matches, probabilities: probs, uncertain, model };
}

/**
 * One Jev request, one noul per checklist item (the "parallel questions" shape).
 * Each item is a semantic requirement the plan has to meet, so a plan that merely
 * restates the prompt, or does exactly the wrong thing with the right keywords,
 * answers no. Null when Jev is unavailable; the legacy regex score is still recorded.
 */
export async function jevChecklist(planPrompt: string, planText: string, items: string[]): Promise<JevChecklist | null> {
	if (items.length === 0) return null;
	const plan = planText.slice(0, MAX_PLAN_CHARS);
	const questions: Questions = {};
	items.forEach((item, i) => {
		questions[`c${i}`] = noul(item);
	});

	const key = `jev-${sha({ v: CHECKLIST_CACHE_VERSION, model: JEV_GRADER_MODEL, planPrompt, plan, items })}`;
	const cached = (await readCache(key)) as { model?: string; probabilities?: (number | null)[] } | null;
	if (cached && Array.isArray(cached.probabilities) && cached.probabilities.length === items.length) {
		return summarizeChecklist(items, cached.probabilities, cached.model ?? JEV_GRADER_MODEL);
	}

	if (!apiKeyPresent()) await loadTypesafeKey();
	if (!apiKeyPresent()) {
		console.error("[grade-plan] jev checklist skipped: TYPESAFE_API_KEY not set");
		return null;
	}
	try {
		const { result } = await ask({ task_prompt: planPrompt, plan }, questions, {
			timeoutMs: 15_000,
			maxRetries: 2,
			model: JEV_GRADER_MODEL,
		});
		const probabilities = items.map((_, i) => {
			const v = Number(result.answers[`c${i}`]?.noul);
			return Number.isFinite(v) ? v : null;
		});
		// Only cache a complete answer set; a partial one gets re-asked.
		if (probabilities.every((p) => p !== null)) await writeCache(key, { model: result.model, probabilities });
		return summarizeChecklist(items, probabilities, result.model);
	} catch (err) {
		console.error(`[grade-plan] jev checklist failed: ${describeError(err)}`);
		return null;
	}
}

// ---- rubric judge -----------------------------------------------------------------

const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL?.trim() || "claude-opus-5";
const JUDGE_TIMEOUT_MS = 300_000;
const JUDGE_CACHE_VERSION = 2;

const JUDGE_SCHEMA = {
	type: "object",
	properties: {
		criteria: {
			type: "array",
			items: {
				type: "object",
				properties: { id: { type: "string" }, met: { type: "boolean" }, reason: { type: "string" } },
				required: ["id", "met", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["criteria"],
	additionalProperties: false,
};

/**
 * Flags that keep the judge blind and reproducible: no tools (it cannot read run
 * dirs that expose the role), no session file, and customizations off so the
 * caller's CLAUDE.md, hooks and skills do not shape the verdict. `--safe-mode`
 * keeps the normal login; `--bare` ignores OAuth and needs ANTHROPIC_API_KEY, so
 * it is opt-in via BENCH_JUDGE_ISOLATION=bare.
 */
export function judgeFlags(): string[] {
	const isolation = process.env.BENCH_JUDGE_ISOLATION?.trim() === "bare" ? "--bare" : "--safe-mode";
	return [isolation, "--tools", "", "--no-session-persistence"];
}

function judgePrompt(planText: string, rubric: string[], requested: number[]): string {
	const criteriaList = requested.map((i) => `${i}. ${rubric[i]}`).join("\n");
	return [
		"You are a blind grader. You will be shown a PLAN and a numbered RUBRIC of yes/no criteria.",
		"For each rubric item, judge strictly from the plan text alone whether it is met.",
		"Respond with ONLY a JSON object of the exact shape:",
		'{"criteria":[{"id":"0","met":true,"reason":"..."}, ...]}',
		"One entry per rubric item listed below, in order, id as the item's number (as a string), met a JSON boolean (true or false, never a string). No prose outside the JSON.",
		"",
		"RUBRIC:",
		criteriaList,
		"",
		"PLAN:",
		"---",
		planText,
		"---",
	].join("\n");
}

/** Index of the `}` closing the object that opens at `start`, skipping JSON strings; -1 if unbalanced. */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i;
	}
	return -1;
}

/**
 * Pulls the judge's JSON out of free text: the last fenced block that parses, else
 * the first balanced object that parses. Unlike a greedy first-brace-to-last-brace
 * match this survives trailing prose that contains braces.
 */
export function extractJudgeJson(text: string): unknown | null {
	const fences = [...text.matchAll(/```(?:json)?[^\S\n]*\n([\s\S]*?)```/gi)];
	for (let i = fences.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(fences[i][1]);
		} catch {
			// not JSON; try the previous block
		}
	}
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		const end = balancedEnd(text, start);
		if (end === -1) continue;
		try {
			return JSON.parse(text.slice(start, end + 1));
		} catch {
			// prose in braces; try the next opening brace
		}
	}
	return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks a judge payload against what was asked. The reply must hold exactly one
 * entry per requested id, no duplicates or strangers; otherwise nothing in it is
 * trusted and every item comes back ungraded. Within a well-formed reply an item
 * whose `met` is not a real boolean (e.g. the string "false") is ungraded too.
 * Never silently drops or counts a requested item.
 */
export function validateJudgeCriteria(payload: unknown, requested: number[]): JudgeCriterion[] {
	const want = requested.map(String);
	const ungraded = (): JudgeCriterion[] => want.map((id) => ({ id, met: null, reason: "" }));
	const list = isRecord(payload) ? payload.criteria : payload;
	if (!Array.isArray(list) || list.length !== want.length) return ungraded();

	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of list) {
		if (!isRecord(entry) || (typeof entry.id !== "string" && typeof entry.id !== "number")) return ungraded();
		const id = String(entry.id);
		if (!want.includes(id) || byId.has(id)) return ungraded();
		byId.set(id, entry);
	}
	return want.map((id) => {
		const entry = byId.get(id) as Record<string, unknown>;
		return {
			id,
			met: typeof entry.met === "boolean" ? entry.met : null,
			reason: typeof entry.reason === "string" ? entry.reason : "",
		};
	});
}

/**
 * `claude -p --output-format json` wraps the reply in a result envelope. With
 * --json-schema the validated object is in `structured_output`; otherwise (or on
 * older CLIs) the reply text is in `result`. Throws when neither yields a payload.
 */
function judgePayloadFromEnvelope(stdout: string): unknown {
	const envelope = JSON.parse(stdout) as unknown;
	if (!isRecord(envelope)) throw new Error(`unexpected judge output shape: ${stdout.slice(0, 500)}`);
	if (envelope.is_error === true) throw new Error(`judge reported an error: ${String(envelope.result).slice(0, 500)}`);
	if (isRecord(envelope.structured_output)) return envelope.structured_output;
	if (Array.isArray(envelope.criteria)) return envelope;
	if (typeof envelope.result === "string") {
		const body = extractJudgeJson(envelope.result);
		if (body === null) throw new Error(`judge result had no JSON body: ${envelope.result.slice(0, 500)}`);
		return body;
	}
	throw new Error(`unexpected judge output shape: ${stdout.slice(0, 500)}`);
}

/**
 * Asks the judge about `requested` rubric items (default: all) and returns one
 * validated entry per requested id, `met: null` where the reply did not grade it.
 * Throws if the judge process itself fails. Only a fully graded reply is cached.
 */
export async function callJudgeValidated(
	planText: string,
	rubric: string[],
	requested: number[] = rubric.map((_, i) => i),
): Promise<JudgeCriterion[]> {
	const prompt = judgePrompt(planText, rubric, requested);
	const flags = judgeFlags();
	const key = sha({ v: JUDGE_CACHE_VERSION, model: JUDGE_MODEL, flags, prompt });

	const cached = validateJudgeCriteria(await readCache(key), requested);
	if (cached.every((c) => c.met !== null)) return cached;

	// A fresh empty cwd so the judge has no run dir, repo or CLAUDE.md to wander into.
	const cwd = await mkdtemp(join(tmpdir(), "bench-judge-"));
	let stdout: string;
	try {
		const r = await runProcess(
			[
				"claude",
				"-p",
				...flags,
				"--model",
				JUDGE_MODEL,
				"--output-format",
				"json",
				"--json-schema",
				JSON.stringify(JUDGE_SCHEMA),
				prompt,
			],
			cwd,
			{ capture: true, timeoutMs: JUDGE_TIMEOUT_MS },
		);
		if (r.status !== 0) {
			throw new Error(`judge invocation failed${r.timedOut ? " (timeout)" : ` (exit ${r.status})`}: ${r.stderr.slice(0, 500)}`);
		}
		stdout = r.stdout;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}

	const criteria = validateJudgeCriteria(judgePayloadFromEnvelope(stdout), requested);
	if (criteria.every((c) => c.met !== null)) await writeCache(key, { criteria });
	return criteria;
}

// ---- gradePlan ---------------------------------------------------------------------

export async function gradePlan(runDir: string, taskDir: string): Promise<PlanGrade> {
	const task = await Bun.file(join(taskDir, "task.json")).json();
	const planPath = await findNewestPlan(runDir);
	if (!planPath) return emptyPlanGrade();
	const planText = await readFile(planPath, "utf8");

	const grade: PlanGrade = { ...emptyPlanGrade(), planPath };
	const legacy = legacyChecklist(planText, (task.checklist as string[] | undefined) ?? []);
	grade.legacyChecklistScore = legacy.score;
	grade.legacyChecklistMatches = legacy.matches;

	const rubric = (task.rubric as string[] | undefined) ?? [];
	const [jev] = await Promise.all([
		jevChecklist(task.planPrompt as string, planText, (task.checklistQuestions as string[] | undefined) ?? []),
		(async () => {
			if (rubric.length === 0) return;
			try {
				const criteria = await callJudgeValidated(planText, rubric);
				grade.judgeCriteria = criteria;
				grade.judgeUngraded = criteria.filter((c) => c.met === null).length;
				if (grade.judgeUngraded === 0) {
					grade.judgeScore = criteria.filter((c) => c.met === true).length / rubric.length;
				} else {
					grade.judgeError = `judge left ${grade.judgeUngraded} of ${rubric.length} rubric items ungraded`;
					console.error(`[grade-plan] ${grade.judgeError} for ${runDir}`);
				}
			} catch (err) {
				grade.judgeUngraded = rubric.length;
				grade.judgeError = String(err);
				console.error(`[grade-plan] judge failed for ${runDir}: ${err}`);
			}
		})(),
	]);

	if (jev) {
		grade.checklistScore = jev.score;
		grade.checklistMatches = jev.matches;
		grade.checklistSource = "jev";
		grade.checklistProbabilities = jev.probabilities;
		grade.checklistUncertain = jev.uncertain;
		grade.checklistModel = jev.model;
	}
	return grade;
}

/** The harness warning a plan row carries when grading its plan threw. Shared by run.ts and --rescore. */
export const PLAN_GRADE_THREW = "plan_grade_threw";

function withoutWarning(row: Record<string, unknown>, warning: string): void {
	if (Array.isArray(row.harnessWarnings)) row.harnessWarnings = row.harnessWarnings.filter((w) => w !== warning);
}

function withWarning(row: Record<string, unknown>, warning: string): void {
	const stored = Array.isArray(row.harnessWarnings) ? row.harnessWarnings : [];
	if (!stored.includes(warning)) row.harnessWarnings = [...stored, warning];
}

/** The runs.jsonl fields a plan grade is recorded under. Shared by run.ts and --rescore so they cannot drift. */
export function planGradeRowFields(g: PlanGrade): Pick<RunRow, "planPath" | "planChecklistScore" | "planChecklistSource" | "planChecklistUncertain" | "planLegacyChecklistScore" | "planJudgeScore" | "planJudgeUngraded"> {
	return {
		planPath: g.planPath,
		planChecklistScore: g.checklistScore,
		planChecklistSource: g.checklistSource,
		planChecklistUncertain: g.checklistUncertain,
		planLegacyChecklistScore: g.legacyChecklistScore,
		planJudgeScore: g.judgeScore,
		planJudgeUngraded: g.judgeUngraded,
	};
}

/**
 * Folds a fresh plan grade into an existing runs.jsonl row without ever replacing
 * a good value with a worse one: a failed judge or Jev call keeps the old score
 * instead of nulling it. Rows written before the semantic checklist hold the old
 * regex score in `planChecklistScore`; that moves to the legacy column and the
 * semantic column stays null until Jev has graded it. A plan that was graded at all
 * clears the `plan_grade_threw` warning the live run may have left on the row.
 */
export function mergePlanGradeIntoRow(row: Record<string, unknown>, g: PlanGrade): void {
	withoutWarning(row, PLAN_GRADE_THREW);
	if (row.planChecklistSource !== "jev") {
		if (typeof row.planChecklistScore === "number" && row.planLegacyChecklistScore === undefined) {
			row.planLegacyChecklistScore = row.planChecklistScore;
		}
		row.planChecklistScore = null;
	}
	if (g.planPath !== null) row.planPath = g.planPath;
	else row.planPath ??= null;

	if (g.legacyChecklistScore !== null) row.planLegacyChecklistScore = g.legacyChecklistScore;
	if (g.checklistScore !== null) {
		row.planChecklistScore = g.checklistScore;
		row.planChecklistSource = g.checklistSource;
		row.planChecklistUncertain = g.checklistUncertain;
	} else {
		row.planChecklistSource ??= null;
	}

	if (g.judgeScore !== null || typeof row.planJudgeScore !== "number") {
		row.planJudgeScore = g.judgeScore;
		row.planJudgeUngraded = g.judgeUngraded;
	}
}

/**
 * Re-scores every plan-type row already recorded in <resultsDir>/runs.jsonl,
 * in place, without re-running omp. Useful when the judge itself was buggy
 * (bad output parsing, etc.) — fix the judge, then re-score existing runs.
 * Skips rows with no `dir` (e.g. --dry-run rows) or non-"plan" type. A judge or
 * Jev failure keeps the row's previous value (see mergePlanGradeIntoRow). Grading
 * that throws (an unreadable plan file) marks that row `plan_grade_threw`, as the
 * live run does, and the rescore goes on with the other rows.
 */
export async function rescoreResultsDir(
	resultsDir: string,
): Promise<{ total: number; rescored: number; nonNullJudge: number; judgeFailures: number; gradeFailures: number }> {
	const runsPath = join(resultsDir, "runs.jsonl");
	const lines = (await readFile(runsPath, "utf8")).split("\n").map((l) => l.trim());
	let total = 0;
	let rescored = 0;
	let nonNullJudge = 0;
	let judgeFailures = 0;
	let gradeFailures = 0;

	const outLines: string[] = [];
	for (const line of lines) {
		if (!line) continue;
		const row = JSON.parse(line) as Record<string, unknown>;
		if (row.type === "plan" && typeof row.dir === "string" && typeof row.task === "string") {
			total++;
			const taskDir = join(import.meta.dir, "tasks", row.task);
			try {
				const grade = await gradePlan(row.dir, taskDir);
				mergePlanGradeIntoRow(row, grade);
				rescored++;
				if (grade.judgeScore !== null) nonNullJudge++;
				else judgeFailures++;
			} catch (err) {
				gradeFailures++;
				withWarning(row, PLAN_GRADE_THREW);
				console.error(`[grade-plan] grading threw for ${row.dir}: ${err}`);
				await writeFile(join(row.dir, "plan-grade-error.log"), String(err)).catch(() => {});
			}
		}
		outLines.push(JSON.stringify(row));
	}

	await writeFile(runsPath, `${outLines.join("\n")}\n`);
	return { total, rescored, nonNullJudge, judgeFailures, gradeFailures };
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (argv[0] === "--rescore") {
		const resultsDirArg = argv[1];
		if (!resultsDirArg) {
			console.error("usage: bun run bench/grade-plan.ts --rescore <resultsDir>");
			process.exit(1);
		}
		const summary = await rescoreResultsDir(resolve(resultsDirArg));
		console.log(JSON.stringify(summary, null, 2));
	} else {
		const [runDirArg, taskDirArg] = argv;
		if (!runDirArg || !taskDirArg) {
			console.error("usage: bun run bench/grade-plan.ts <runDir> <taskDir>\n   or: bun run bench/grade-plan.ts --rescore <resultsDir>");
			process.exit(1);
		}
		gradePlan(resolve(runDirArg), resolve(taskDirArg)).then((r) => console.log(JSON.stringify(r, null, 2)));
	}
}

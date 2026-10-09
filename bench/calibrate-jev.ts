#!/usr/bin/env bun
/**
 * Calibrates the three pipeline Jev judges (src/pipeline/jev.ts) against the live API.
 *
 *   bun bench/calibrate-jev.ts [--judge plan|spec|approval|all] [--samples N] [--concurrency N]
 *                              [--model NAME] [--out PATH]
 *
 * Scores every case of bench/jev-calibration/cases.ts with the production state and questions
 * (redaction on), `samples` times each, and reports per case, per judge, and the floor that
 * separates the tune split best. Target per judge: no false fire on a clear negative, at least 90%
 * of the clear positives firing, at the shipped default floor. Exit 0 when every selected judge
 * meets it, 1 when one misses, 2 on a usage, corpus, key or request failure.
 *
 * Not part of `bun test`: it spends API credits.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { ask, getLastResolvedModel } from "../src/client";
import { DEFAULT_CONFIG, getConfig } from "../src/config";
import {
	APPROVAL_GRANTED,
	STARTS_DAG_RUN,
	UNFOUNDED_DECISIONS,
	VAGUE_ACCEPTANCE,
	approvalJevState,
	approvalQuestions,
	formatAskAnswer,
	planGuardQuestions,
	planGuardState,
	specJevState,
	specQuestions,
} from "../src/pipeline/jev";
import { extractNoul } from "../src/reviewer";
import { loadTypesafeKey } from "./lib/grade-common";
import { APPROVAL_CASES, PLAN_CASES, SPEC_CASES, validateCorpus } from "./jev-calibration/cases";
import { type AtFloor, type Scored, type Split, evaluateAt, marginAt, recommendFloor } from "./jev-calibration/floor";

type JudgeName = "plan" | "spec" | "approval";
type FloorKey = "planFloor" | "specFloor" | "approvalFloor";

interface Item {
	id: string;
	split: Split;
	state: Record<string, unknown>;
	/** Whether the judge should fire, per question id. */
	positive: Record<string, boolean>;
}

interface Judge {
	name: JudgeName;
	floorKey: FloorKey;
	/** A floor never recommended below this, whatever the corpus allows. */
	minimum: number;
	questionIds: string[];
	questions: Questions;
	items: Item[];
}

const USAGE = `usage: bun bench/calibrate-jev.ts [--judge plan|spec|approval|all] [--samples N] [--concurrency N] [--model NAME] [--out PATH]
  --judge        which judge to measure (default all)
  --samples      calls per case, 1-10 (default 3)
  --concurrency  parallel calls (default 4)
  --model        model override (default: the configured model, jev-latest unless TYPESAFE_DEFAULT_MODEL is set)
  --out          result JSON (default bench/results/jev-calibration-<YYYYMMDD-HHMMSS>.json)`;

interface Args {
	judges: JudgeName[];
	samples: number;
	concurrency: number;
	model: string | null;
	out: string;
}

const ALL_JUDGES: JudgeName[] = ["plan", "spec", "approval"];

function timestamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** The parsed args, or an error message. */
function parseArgs(argv: readonly string[], now: Date): Args | string {
	const args: Args = { judges: ALL_JUDGES, samples: 3, concurrency: 4, model: null, out: join("bench", "results", `jev-calibration-${timestamp(now)}.json`) };
	const integer = (flag: string, value: string, min: number, max: number): number | string => {
		const n = Number(value);
		return Number.isInteger(n) && n >= min && n <= max ? n : `${flag} needs an integer from ${min} to ${max}, got "${value}"`;
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag !== "--judge" && flag !== "--samples" && flag !== "--concurrency" && flag !== "--model" && flag !== "--out") return `unknown argument "${flag}"`;
		if (value === undefined || value.startsWith("--")) return `${flag} needs a value`;
		i += 1;
		if (flag === "--judge") {
			if (value === "all") args.judges = ALL_JUDGES;
			else if ((ALL_JUDGES as string[]).includes(value)) args.judges = [value as JudgeName];
			else return `--judge must be plan, spec, approval or all, got "${value}"`;
		} else if (flag === "--samples" || flag === "--concurrency") {
			const n = flag === "--samples" ? integer(flag, value, 1, 10) : integer(flag, value, 1, 64);
			if (typeof n === "string") return n;
			if (flag === "--samples") args.samples = n;
			else args.concurrency = n;
		} else if (flag === "--model") args.model = value;
		else args.out = value;
	}
	return args;
}

/** The judges with production state: the same composition as src/index.ts (pipelineGuard, approvalJevAllows), redaction on. */
function buildJudges(): Record<JudgeName, Judge> {
	return {
		plan: {
			name: "plan",
			floorKey: "planFloor",
			minimum: 0.5,
			questionIds: [STARTS_DAG_RUN],
			questions: planGuardQuestions(),
			items: PLAN_CASES.map((c) => ({ id: c.id, split: c.split, state: planGuardState(c.code, true), positive: { [STARTS_DAG_RUN]: c.starts } })),
		},
		spec: {
			name: "spec",
			floorKey: "specFloor",
			minimum: 0.3,
			questionIds: [UNFOUNDED_DECISIONS, VAGUE_ACCEPTANCE],
			questions: specQuestions(),
			items: SPEC_CASES.map((c) => ({
				id: c.id,
				split: c.split,
				state: specJevState(c.spec, c.turns, true),
				positive: { [UNFOUNDED_DECISIONS]: c.unfounded, [VAGUE_ACCEPTANCE]: c.vague },
			})),
		},
		approval: {
			name: "approval",
			floorKey: "approvalFloor",
			minimum: 0.6,
			questionIds: [APPROVAL_GRANTED],
			questions: approvalQuestions(),
			items: APPROVAL_CASES.map((c) => ({
				id: c.id,
				split: c.split,
				state: approvalJevState(c.flip, c.groups.flat().map((answer) => formatAskAnswer(answer, true)), true),
				positive: { [APPROVAL_GRANTED]: c.grant },
			})),
		},
	};
}

interface Job {
	judge: Judge;
	item: Item;
	sample: number;
}

/** scores[judge][item id][question id][sample] */
type ScoreBook = Record<JudgeName, Record<string, Record<string, (number | undefined)[]>>>;

interface Failure {
	judge: JudgeName;
	id: string;
	sample: number;
	error: string;
}

async function runPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) await fn(items[i]);
	};
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/** One production-shaped call; an abstention counts as not fired, as in judgePlanCell / judgeApproval. */
async function scoreJob(job: Job, model: string | null): Promise<Record<string, number>> {
	const { result } = await ask(job.item.state as EntryType, job.judge.questions, { timeoutMs: 10_000, maxRetries: 2, ...(model ? { model } : {}) });
	const out: Record<string, number> = {};
	for (const id of job.judge.questionIds) out[id] = extractNoul(result.answers[id]) ?? 0;
	return out;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The scored cases of one question; a case with no sample at all (a failed run) is left out. */
function scoredFor(judge: Judge, questionId: string, book: ScoreBook): Scored[] {
	return judge.items.flatMap((item) => {
		const scores = (book[judge.name][item.id]?.[questionId] ?? []).filter((s): s is number => s !== undefined);
		return scores.length > 0 ? [{ id: item.id, split: item.split, positive: item.positive[questionId], scores }] : [];
	});
}

const fmt = (x: number): string => x.toFixed(2);
const range = (scores: readonly number[]): string => `${fmt(Math.min(...scores))}–${fmt(Math.max(...scores))}`;
const SPREAD = 0.15;

function printTable(judge: Judge, questionId: string, cases: readonly Scored[], floor: number): void {
	console.log(`\n### ${judge.name} / ${questionId} (floor ${floor})\n`);
	console.log("| id | split | label | min–max | at current floor |");
	console.log("|---|---|---|---|---|");
	for (const c of cases) {
		const at = evaluateAt([c], floor);
		const verdict = c.positive ? (at.passed === 1 ? "ok" : "MISS") : at.falseFires.length === 0 ? "ok" : "FALSE FIRE";
		console.log(`| ${c.id} | ${c.split} | ${c.positive ? "positive" : "negative"} | ${range(c.scores)} | ${verdict} |`);
	}
}

/** `false fires a/N, positives b/M` per question, and whether every question meets the target. */
function describeAt(sets: readonly (readonly Scored[])[], ids: readonly string[], floor: number): { text: string; met: boolean; results: AtFloor[] } {
	const results = sets.map((set) => evaluateAt(set, floor));
	const parts = results.map((r, i) => {
		const negatives = sets[i].filter((c) => !c.positive).length;
		const label = ids.length > 1 ? `[${ids[i]}] ` : "";
		return `${label}false fires ${r.falseFires.length}/${negatives}${r.falseFires.length > 0 ? ` (${r.falseFires.join(", ")})` : ""}, positives ${r.passed}/${r.positives}`;
	});
	const need = results.map((r) => Math.ceil(0.9 * r.positives));
	const needText = need.length === 1 ? `need 0 and ≥${need[0]}` : `need 0 and ≥${need.join("/")}`;
	return { text: `${parts.join("; ")} (${needText})`, met: results.every((r) => r.met), results };
}

interface JudgeReport {
	floorNow: number;
	recommended: number | null;
	atFloorNow: AtFloor[];
	atRecommended: AtFloor[] | null;
	questions: Record<string, Scored[]>;
	met: boolean;
}

function reportJudge(judge: Judge, book: ScoreBook): JudgeReport {
	const floorNow = DEFAULT_CONFIG.pipeline.jev[judge.floorKey];
	const sets = judge.questionIds.map((id) => scoredFor(judge, id, book));
	const questions: Record<string, Scored[]> = {};
	judge.questionIds.forEach((id, i) => {
		questions[id] = sets[i];
		printTable(judge, id, sets[i], floorNow);
	});
	for (const [i, id] of judge.questionIds.entries()) {
		for (const c of sets[i]) {
			if (Math.max(...c.scores) - Math.min(...c.scores) > SPREAD) console.log(`spread > ${SPREAD}: ${judge.name}/${id}/${c.id} ${range(c.scores)}`);
		}
	}
	const recommended = recommendFloor(sets, judge.minimum);
	const now = describeAt(sets, judge.questionIds, floorNow);
	console.log(`\n${judge.name}: floor now ${floorNow} → ${now.text} ${now.met ? "MET" : "MISS"}; recommended ${recommended ?? "none"}${recommended === null ? "" : ` (margin ${marginAt(sets, recommended)} bp)`}`);
	let atRecommended: AtFloor[] | null = null;
	if (recommended !== null) {
		const rec = describeAt(sets, judge.questionIds, recommended);
		atRecommended = rec.results;
		console.log(`${judge.name}: at recommended ${recommended} → ${rec.text} ${rec.met ? "MET" : "MISS"}`);
	}
	return { floorNow, recommended, atFloorNow: now.results, atRecommended, questions, met: now.met };
}

async function main(): Promise<number> {
	const startedAt = new Date();
	const args = parseArgs(process.argv.slice(2), startedAt);
	if (typeof args === "string") {
		console.error(`${args}\n${USAGE}`);
		return 2;
	}
	const problems = validateCorpus();
	if (problems.length > 0) {
		console.error(`the corpus is unsound:\n${problems.map((p) => `  ${p}`).join("\n")}`);
		return 2;
	}
	if (!(await loadTypesafeKey())) {
		console.error("no TYPESAFE_API_KEY");
		return 2;
	}
	const judges = buildJudges();
	const selected = args.judges.map((name) => judges[name]);
	console.log(`model: ${args.model ?? getConfig().model}; samples ${args.samples}; concurrency ${args.concurrency}; judges ${args.judges.join(", ")}`);

	const book: ScoreBook = { plan: {}, spec: {}, approval: {} };
	const jobs: Job[] = selected.flatMap((judge) => judge.items.flatMap((item) => Array.from({ length: args.samples }, (_, sample) => ({ judge, item, sample }))));
	const failed: Job[] = [];
	const attempt = async (job: Job): Promise<string | null> => {
		try {
			const scores = await scoreJob(job, args.model);
			const byQuestion = (book[job.judge.name][job.item.id] ??= {});
			for (const [id, score] of Object.entries(scores)) (byQuestion[id] ??= [])[job.sample] = score;
			return null;
		} catch (err) {
			return errorText(err);
		}
	};
	console.log(`scoring ${jobs.length} calls`);
	await runPool(jobs, args.concurrency, async (job) => {
		if ((await attempt(job)) !== null) failed.push(job);
	});
	// A failed request gets one more try, sequentially, once the pool is quiet.
	const failures: Failure[] = [];
	for (const job of failed) {
		const error = await attempt(job);
		if (error !== null) failures.push({ judge: job.judge.name, id: job.item.id, sample: job.sample, error });
	}

	const write = async (body: unknown): Promise<void> => {
		await mkdir(dirname(args.out), { recursive: true });
		await writeFile(args.out, `${JSON.stringify(body, null, 2)}\n`);
		console.log(`\nwrote ${args.out}`);
	};
	const header = { model: getLastResolvedModel(), samples: args.samples, startedAt: startedAt.toISOString() };
	if (failures.length > 0) {
		const partial: Record<string, unknown> = {};
		for (const judge of selected) {
			partial[judge.name] = {
				floorNow: DEFAULT_CONFIG.pipeline.jev[judge.floorKey],
				questions: Object.fromEntries(judge.questionIds.map((id) => [id, scoredFor(judge, id, book)])),
			};
		}
		await write({ ...header, failures, judges: partial });
		console.error(`\n${failures.length} request(s) failed twice:`);
		for (const f of failures) console.error(`  ${f.judge}/${f.id} sample ${f.sample}: ${f.error}`);
		return 2;
	}

	const reports: Record<string, JudgeReport> = {};
	for (const judge of selected) reports[judge.name] = reportJudge(judge, book);
	await write({
		...header,
		judges: Object.fromEntries(Object.entries(reports).map(([name, { met: _met, ...rest }]) => [name, rest])),
	});
	return Object.values(reports).every((r) => r.met) ? 0 : 1;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			console.error(err);
			process.exit(2);
		},
	);
}

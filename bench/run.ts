#!/usr/bin/env bun
/**
 * Matrix runner for the omp-typesafe bench. See bench/README.md.
 *
 * bun run bench/run.ts --reps N [--tasks a,b] [--roles off,advisory,adversarial]
 *   [--types exec,plan] [--gates on,off] [--model <id>] [--concurrency 2]
 *   [--max-time 10m] [--results-dir <dir>] [--dry-run]
 *
 * Every cell is hermetic: the extension under test is this checkout's src/index.ts
 * (loaded with -e after --no-extensions), it reads the pinned bench/typesafe.bench.json
 * (TYPESAFE_CONFIG) instead of the user's own config, and inherited TYPESAFE_*
 * variables are stripped. The `off` baseline loads no extension at all.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { applyEnvOverrides, DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { resolveTypesafeApiKey, type ApiKeyResolution } from "./lib/api-key";
import { readGlobalConfig } from "./lib/config";
import { gitProvenance, prepareFixture, type GitProvenance } from "./lib/fixture";
import type { GradeResult } from "./lib/grade-common";
import { overlayYaml } from "./lib/overlay";
import { ompHitMaxTime, parseDuration, processInfraReasons, resolveOmp, runOmp, runProcess, subprocessTimeoutMs, type ResolvedOmp } from "./lib/omp-run";
import type { RunRow } from "./lib/row";
import {
	countGateNotes,
	findLatestSessionFile,
	parseSessionEntries,
	extractCustomMessages,
	findPlanYoloHandoffTimestamp,
	isPlanSession,
	splitNoteCountsByPhase,
	usageFromSessionEntries,
	usageFromStdout,
} from "./lib/session";
import {
	readTelemetry,
	summarizeHistory,
	historyTruncation,
	reportedConfig,
	ambiguityAtPropose,
	gateCouldAct,
	wouldAsk,
	gateEvents,
	type ReportedConfig,
	type TelemetryLog,
} from "./lib/telemetry";
import { emptyPlanGrade, gradePlan, PLAN_GRADE_THREW, planGradeRowFields } from "./grade-plan";

export const ALL_ROLES = ["off", "advisory", "adversarial"] as const;
export const ALL_TYPES = ["exec", "plan"] as const;
export const ALL_GATES = ["on", "off"] as const;
export type Role = (typeof ALL_ROLES)[number];
export type TaskType = (typeof ALL_TYPES)[number];
export type Gate = (typeof ALL_GATES)[number];

export const REPO_ROOT = resolve(import.meta.dir, "..");
/** The extension under test: this checkout, not whatever copy omp has installed. */
export const EXTENSION_ENTRY = join(REPO_ROOT, "src", "index.ts");
/** Pinned extension config every cell loads via TYPESAFE_CONFIG instead of ~/.omp/agent/typesafe.json. */
export const BENCH_TYPESAFE_CONFIG = join(import.meta.dir, "typesafe.bench.json");
/** Paths whose uncommitted state is recorded as the run's provenance. */
const PROVENANCE_PATHS = ["src", "package.json", "bench/typesafe.bench.json"];

export const USAGE = `usage: bun run bench/run.ts [flags]
       bun run bench/run.ts --regrade <resultsDir>

  --reps N             repetitions per cell, integer >= 1 (default 1)
  --tasks a,b          task ids under bench/tasks (default: all)
  --roles a,b          any of ${ALL_ROLES.join(", ")} (default: all)
  --types a,b          any of ${ALL_TYPES.join(", ")} (default: both)
  --gates on,off       ambiguity gate for advisory/adversarial cells (default: on). The "off" role never loads the extension.
  --model <id>         model for every cell (default: modelRoles.default from ~/.omp/agent/config.yml)
  --concurrency N      parallel omp runs, integer >= 1 (default 2)
  --max-time 10m       per-run omp time limit: 600, 90s, 10m or 1h (default 10m)
  --results-dir <dir>  where the run directory is created (default: bench/results)
  --dry-run            print the commands, touch nothing
  --help               show this message
`;

/** A bad command line: reported with the usage text and exit code 2. */
export class UsageError extends Error {}

export interface Args {
	reps: number;
	tasks?: string[];
	roles: Role[];
	types: TaskType[];
	gates: Gate[];
	model?: string;
	concurrency: number;
	maxTime: string;
	resultsDir?: string;
	dryRun: boolean;
	help: boolean;
}

function parseList<T extends string>(flag: string, raw: string, allowed: readonly T[]): T[] {
	const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
	if (items.length === 0) throw new UsageError(`${flag} needs at least one of: ${allowed.join(", ")}`);
	const bad = items.filter((i) => !(allowed as readonly string[]).includes(i));
	if (bad.length > 0) throw new UsageError(`${flag}: unknown value ${bad.map((b) => `'${b}'`).join(", ")} (allowed: ${allowed.join(", ")})`);
	return [...new Set(items)] as T[];
}

function parsePositiveInt(flag: string, raw: string): number {
	const n = /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`${flag} must be an integer >= 1, got '${raw}'`);
	return n;
}

function parseMaxTime(flag: string, raw: string): string {
	let ms: number;
	try {
		ms = parseDuration(raw);
	} catch {
		throw new UsageError(`${flag} must look like 600, 90s, 10m or 1h, got '${raw}'`);
	}
	if (!(ms > 0)) throw new UsageError(`${flag} must be greater than zero, got '${raw}'`);
	return raw.trim();
}

/** Validates every flag; a bad value throws UsageError rather than silently shaping the matrix. */
export function parseArgs(argv: string[]): Args {
	const args: Args = { reps: 1, roles: [...ALL_ROLES], types: [...ALL_TYPES], gates: ["on"], concurrency: 2, maxTime: "10m", dryRun: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = (): string => {
			const v = argv[++i];
			if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} requires a value`);
			return v;
		};
		switch (a) {
			case "--reps":
				args.reps = parsePositiveInt(a, next());
				break;
			case "--tasks": {
				const ids = next().split(",").map((s) => s.trim()).filter(Boolean);
				if (ids.length === 0) throw new UsageError("--tasks needs at least one task id");
				args.tasks = [...new Set(ids)];
				break;
			}
			case "--roles":
				args.roles = parseList(a, next(), ALL_ROLES);
				break;
			case "--types":
				args.types = parseList(a, next(), ALL_TYPES);
				break;
			case "--gates":
				args.gates = parseList(a, next(), ALL_GATES);
				break;
			case "--model": {
				const model = next().trim();
				if (!model) throw new UsageError("--model must not be empty");
				args.model = model;
				break;
			}
			case "--concurrency":
				args.concurrency = parsePositiveInt(a, next());
				break;
			case "--max-time":
				args.maxTime = parseMaxTime(a, next());
				break;
			case "--results-dir":
				args.resultsDir = next();
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--help":
			case "-h":
				args.help = true;
				break;
			default:
				throw new UsageError(`unknown arg: ${a}`);
		}
	}
	return args;
}

export interface TaskEntry {
	id: string;
	dir: string;
	spec: { id: string; execPrompt: string; planPrompt: string };
}

/** Discovers task dirs; an id in `filter` that matches no task is an error, not a silent drop. */
export async function discoverTasks(filter?: string[], tasksDir: string = join(import.meta.dir, "tasks")): Promise<TaskEntry[]> {
	const available = (await readdir(tasksDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	if (filter) {
		const unknown = filter.filter((id) => !available.includes(id));
		if (unknown.length > 0) throw new UsageError(`--tasks: unknown task ${unknown.map((u) => `'${u}'`).join(", ")} (available: ${available.join(", ")})`);
	}
	const out: TaskEntry[] = [];
	for (const id of available.filter((id) => !filter || filter.includes(id))) {
		const dir = join(tasksDir, id);
		const spec = await Bun.file(join(dir, "task.json")).json();
		out.push({ id, dir, spec });
	}
	return out;
}

export interface Cell {
	task: TaskEntry;
	role: Role;
	/** Ambiguity gate. Always "off" for the `off` role (no extension runs); an explicit factor for the others. */
	gate: Gate;
	type: TaskType;
	rep: number;
}

export function buildMatrix(tasks: TaskEntry[], args: Pick<Args, "roles" | "types" | "gates" | "reps">, random: () => number = Math.random): Cell[] {
	const cells: Cell[] = [];
	for (const task of tasks) {
		for (const role of args.roles) {
			const gates: Gate[] = role === "off" ? ["off"] : args.gates;
			for (const gate of gates) {
				for (const type of args.types) {
					for (let rep = 0; rep < args.reps; rep++) {
						cells.push({ task, role, gate, type, rep });
					}
				}
			}
		}
	}
	// Fisher-Yates shuffle so time-of-day / provider drift doesn't correlate with one condition.
	for (let i = cells.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[cells[i], cells[j]] = [cells[j], cells[i]];
	}
	return cells;
}

export function cellName(c: Pick<Cell, "role" | "gate" | "type" | "rep"> & { task: { id: string } }): string {
	const gateTag = c.role !== "off" && c.gate === "off" ? "-nogate" : "";
	return `${c.task.id}-${c.role}${gateTag}-${c.type}-${c.rep}`;
}

/**
 * The extension-side switches for a cell. Every treatment cell states its role, that
 * the reviewer is enabled, whether the gate is on and that the subagent guard is, so nothing depends on what the
 * user's own typesafe.json says (env beats file); the `off` baseline disables both
 * the reviewer and the gate (and loads no extension, see argvForCell).
 */
export function envForCell(c: Pick<Cell, "role" | "gate">): Record<string, string> {
	const env: Record<string, string> = { TYPESAFE_CONFIG: BENCH_TYPESAFE_CONFIG };
	if (c.role === "off") {
		env.TYPESAFE_REVIEW_ENABLED = "0";
		env.TYPESAFE_AMBIGUITY_GATE = "0";
	} else {
		env.TYPESAFE_ROLE = c.role;
		env.TYPESAFE_REVIEW_ENABLED = "1";
		env.TYPESAFE_AMBIGUITY_GATE = c.gate === "on" ? "1" : "0";
		// The subagent guard is read from the environment on every hook, so it is stated like the rest: a cell's workers
		// are never reviewed or gated, whatever the invoking shell had (hermeticEnv strips it too, this keeps it true
		// should that ever change).
		env.TYPESAFE_SUBAGENT_GUARD = "1";
	}
	return env;
}

export interface ResolvedCellConfig {
	role: string;
	phases: string[];
	model: string;
	adversary: { enabled: boolean; reviewActions: boolean; reviewMessages: boolean; reviewTurns: boolean };
	ambiguityGate: { enabled: boolean; threshold: number };
}

/**
 * The config the extension will resolve for a cell: the repo's own merge of the pinned
 * bench config with the cell's env overrides, i.e. the same code path src/config.ts runs
 * in loadConfig. Recorded in meta.json, and checked before the matrix starts.
 */
export function resolveCellConfig(c: Pick<Cell, "role" | "gate">): ResolvedCellConfig {
	const pinned = JSON.parse(readFileSync(BENCH_TYPESAFE_CONFIG, "utf8"));
	const cfg = applyEnvOverrides(mergeConfig(DEFAULT_CONFIG, pinned), envForCell(c));
	const { enabled, reviewActions, reviewMessages, reviewTurns } = cfg.adversary;
	return {
		role: cfg.role,
		phases: [...cfg.phases],
		model: cfg.model,
		adversary: { enabled, reviewActions, reviewMessages, reviewTurns },
		ambiguityGate: { enabled: cfg.ambiguityGate.enabled, threshold: cfg.ambiguityGate.threshold },
	};
}

/**
 * Fails fast when the cell env + pinned config would not produce the treatment a cell is
 * labelled with (reviewer off, a review kind off, wrong role, wrong gate state), before any
 * money is spent on a matrix that could not support its own comparison.
 */
export function assertCellConfigs(cells: Pick<Cell, "role" | "gate">[], resolve: (c: Pick<Cell, "role" | "gate">) => ResolvedCellConfig = resolveCellConfig): void {
	const seen = new Set<string>();
	for (const c of cells) {
		const key = `${c.role}/${c.gate}`;
		if (c.role === "off" || seen.has(key)) continue;
		seen.add(key);
		const r = resolve(c);
		const a = r.adversary;
		const problems: string[] = [];
		if (r.role !== c.role) problems.push(`role resolves to ${r.role}`);
		if (!(a.enabled && a.reviewActions && a.reviewMessages && a.reviewTurns)) problems.push("the reviewer or one of its review kinds is disabled");
		if (r.ambiguityGate.enabled !== (c.gate === "on")) problems.push(`ambiguity gate resolves to ${r.ambiguityGate.enabled ? "on" : "off"}`);
		if (problems.length > 0) throw new Error(`bench config would not run the ${c.role} cell with gate ${c.gate} as labelled: ${problems.join("; ")} (${JSON.stringify(r)})`);
	}
}

export function argvForCell(c: Pick<Cell, "role" | "type" | "task">, runDir: string, model: string, maxTime: string, extensionPath: string = EXTENSION_ENTRY): string[] {
	const argv = [
		"-p",
		"--mode",
		"json",
		"--cwd",
		join(runDir, "repo"),
		"--model",
		model,
		"--approval-mode",
		"yolo",
		"--no-lsp",
		"--max-time",
		maxTime,
		"--session-dir",
		join(runDir, "sessions"),
		"--config",
		join(runDir, "overlay.yml"),
		// Hermetic: no discovered extensions (the installed plugin is a different checkout), skills or rules.
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		// A global `prewalk.enabled: true` would swap the model mid-run in every arm while the report still names the one it started with.
		"--no-prewalk",
	];
	// Only treatment cells load the extension, and they load THIS checkout's source.
	if (c.role !== "off") argv.push("-e", extensionPath);
	if (c.type === "plan") {
		argv.push("--plan-yolo", "--plan-yolo-into", model);
	}
	const prompt = c.type === "plan" ? c.task.spec.planPrompt : c.task.spec.execPrompt;
	argv.push(prompt);
	return argv;
}

/** Quotes one argument for POSIX shells so a printed command can be pasted back (backticks, $, quotes all inert). */
export function shellQuote(s: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(env: Record<string, string>, argv: string[]): string {
	const envStr = Object.entries(env)
		.map(([k, v]) => `${k}=${shellQuote(k === "TYPESAFE_API_KEY" ? "<redacted>" : v)}`)
		.join(" ");
	return `${envStr} omp ${argv.map(shellQuote).join(" ")}`;
}

async function sourceTypesafeApiKey(): Promise<ApiKeyResolution> {
	let fileText: string | undefined;
	try {
		fileText = await Bun.file(join(homedir(), ".config", "agent-secrets.env")).text();
	} catch {
		// no secrets file; fall through to the environment
	}
	return resolveTypesafeApiKey(process.env, fileText);
}

export interface ExpectedCell {
	role: Role;
	gate: Gate;
}

export interface TelemetryCheck {
	/** Reasons this row cannot support a conclusion about the extension (excluded from means by the report). */
	infraReasons: string[];
	/** Suspicious but not disqualifying. */
	warnings: string[];
	/** The extension's own report of the config it ran with (the dump's `config` block, well-typed fields only), null when it reported none. */
	effectiveConfig: ReportedConfig | null;
}

/**
 * Cross-checks what the extension reported about itself against what the cell was meant
 * to be, so a cell that silently ran a different treatment cannot pass as a valid result:
 *  - off: any typesafe.json means the extension loaded despite the baseline (a leak), and a
 *    gate that was on in it is called out separately (the old harness's `off` ran the gate);
 *  - treatment: no typesafe.json means the extension never loaded; a reported role, reviewer
 *    or gate setting that contradicts the cell, or reviews that all errored (a bad API key),
 *    mean the cell behaved like some other arm. A treatment cell with no reviews at all is only
 *    a warning: the extension skips every review when it has no API key, so that case and an
 *    agent that never got to act look the same in the dump.
 */
export function checkTelemetry(expected: ExpectedCell, t: TelemetryLog | null): TelemetryCheck {
	const config = reportedConfig(t);
	const infraReasons: string[] = [];
	const warnings: string[] = [];
	// Whether the gate ran: what the extension reported, else whether it left any score; null when there is no evidence.
	const gateRan = typeof config?.ambiguityGateEnabled === "boolean" ? config.ambiguityGateEnabled : (t?.ambiguity?.scores?.length ?? 0) > 0 ? true : null;

	if (expected.role === "off") {
		if (t) {
			infraReasons.push("off_extension_loaded");
			if (gateRan === true) infraReasons.push("off_gate_on");
		}
		return { infraReasons, warnings, effectiveConfig: config };
	}
	if (!t) return { infraReasons: ["extension_not_loaded"], warnings, effectiveConfig: config };

	const reportedRole = typeof t.role === "string" ? t.role : config?.role;
	if (typeof reportedRole === "string" && reportedRole !== expected.role) infraReasons.push("role_mismatch");

	const reviewerDisabled = config?.adversaryEnabled === false;
	if (reviewerDisabled) infraReasons.push("reviewer_disabled");
	else if (config?.reviewActions === false || config?.reviewMessages === false || config?.reviewTurns === false) infraReasons.push("reviewer_kind_disabled");

	if (gateRan !== null && gateRan !== (expected.gate === "on")) infraReasons.push("gate_mismatch");

	const history = Array.isArray(t.history) ? t.history : [];
	const errors = typeof t.stats?.errors === "number" ? t.stats.errors : 0;
	if (history.length === 0) {
		if (errors > 0) infraReasons.push("reviewer_all_errors");
		else if (!reviewerDisabled) warnings.push("no_reviews");
	} else if (history.every((h) => h.decision === "error")) {
		infraReasons.push("reviewer_all_errors");
	} else if (errors > 0) {
		warnings.push("reviewer_some_errors");
	}
	return { infraReasons, warnings, effectiveConfig: config };
}

/**
 * All the per-run fields derivable from files already on disk under a run
 * dir (sessions/, typesafe.json, stdout.log) rather than from the omp
 * invocation itself. Shared by runCell (live run, has stdout in memory) and
 * regradeResultsDir (backfill, reads stdout.log from disk) so the two paths
 * can never drift apart on what they compute from the same inputs: that
 * drift is exactly what caused an earlier telemetry-field mismatch report.
 * `cellType` is the cell's own type; omitted, it is inferred from the session.
 */
export async function deriveNoteAndTelemetryFields(runDir: string, stdoutForUsageFallback: string | undefined, expected: ExpectedCell | null, cellType?: TaskType) {
	const sessionPath = findLatestSessionFile(join(runDir, "sessions"));
	const sessionEntries = sessionPath ? parseSessionEntries(sessionPath) : [];
	const sessionNotes = extractCustomMessages(sessionEntries);
	// Every custom message by customType, omp's own included; the report and the
	// phase split below only read the reviewer's (ai.typesafe.adversary/advisory).
	const noteCounts: Record<string, number> = {};
	for (const note of sessionNotes) {
		noteCounts[note.customType] = (noteCounts[note.customType] ?? 0) + 1;
	}
	// Plan cells switch from read-only planning to full-access execution at the
	// plan-yolo-handoff custom message; split notes on either side of it so
	// "did the reviewer behave differently while planning vs implementing" is
	// answerable. A plan cell whose plan was never approved has no handoff, and
	// all of its notes are plan-phase; exec cells put everything in exec-phase.
	const handoffTs = findPlanYoloHandoffTimestamp(sessionNotes);
	const type: TaskType = cellType ?? (isPlanSession(sessionNotes) ? "plan" : "exec");
	const { planPhaseNotes, execPhaseNotes } = splitNoteCountsByPhase(sessionNotes, handoffTs, type);

	// Usage has no single summary event (Phase 0 check 4): sum the assistant
	// `message` entries of the session JSONL, falling back to stdout's message_end
	// events only if no session file was found or it carried no usage. For a
	// backfill (no live stdout passed in), fall back to the saved stdout.log file.
	let stdoutText = stdoutForUsageFallback;
	if (stdoutText === undefined) {
		try {
			stdoutText = await Bun.file(join(runDir, "stdout.log")).text();
		} catch {
			stdoutText = "";
		}
	}
	const usage = usageFromSessionEntries(sessionEntries) ?? usageFromStdout(stdoutText);
	const mainTokens = usage?.totalTokens ?? null;
	const mainCostUsd = usage?.costUsd ?? null;

	// Extension telemetry. Only treatment cells load the extension, so a missing file
	// is expected for role "off" and a present one there means the baseline leaked
	// (see checkTelemetry); the extension writes it on session_shutdown whenever
	// TYPESAFE_BENCH_LOG is set, which runCell does for every cell to catch exactly that.
	const telemetry = await readTelemetry(join(runDir, "typesafe.json"));
	const history = telemetry ? summarizeHistory(telemetry.history ?? [], handoffTs, type) : null;

	// Ambiguity-gate telemetry (optional: absent on older typesafe.json dumps).
	const ambiguityPropose = ambiguityAtPropose(telemetry);
	const ambiguityGateEvents = gateEvents(telemetry);
	const asksObserved = telemetry?.ambiguity?.asksObserved ?? null;

	const check = expected ? checkTelemetry(expected, telemetry) : { infraReasons: [], warnings: [], effectiveConfig: reportedConfig(telemetry) };
	// The gate only acts in plan mode, and not in a gate-off cell: an empty score log there is by construction, so n/a, not "did not ask".
	const gateActed = gateCouldAct({ type, role: expected?.role, gate: expected?.gate }, check.effectiveConfig);
	const ambiguityWouldAsk = gateActed ? wouldAsk(telemetry) : null;
	// A gate that could act but logged no score at all measured nothing (its scoring failed or timed out, no key, plan mode never reached): say so, so the row is not read as "did not ask".
	const harnessWarnings = gateActed && Array.isArray(telemetry?.ambiguity?.scores) && telemetry.ambiguity.scores.length === 0 ? [...check.warnings, "gate_no_scores"] : check.warnings;

	return {
		hitMaxTime: ompHitMaxTime(stdoutText),
		sessionPath,
		noteCounts,
		planPhaseNotes,
		execPhaseNotes,
		planApproved: handoffTs !== null,
		gateNoteCount: countGateNotes(sessionNotes),
		mainTokens,
		mainCostUsd,
		// null without a typesafe.json (the report keys off that), never an empty object
		reviewCount: history?.reviewCount ?? null,
		reviewDecisionCounts: history?.reviewDecisionCounts ?? null,
		noteSeverityCounts: history?.noteSeverityCounts ?? null,
		noteChannelCounts: history?.noteChannelCounts ?? null,
		noteSuppressedCounts: history?.noteSuppressedCounts ?? null,
		planPhaseSeverityCounts: history?.planPhaseSeverityCounts ?? null,
		execPhaseSeverityCounts: history?.execPhaseSeverityCounts ?? null,
		...historyTruncation(telemetry),
		typesafeCostUsd: telemetry?.costUsd ?? null,
		jevModel: typeof telemetry?.lastResolvedModel === "string" ? telemetry.lastResolvedModel : null,
		ambiguityAtPropose: ambiguityPropose,
		wouldAsk: ambiguityWouldAsk,
		gateEvents: ambiguityGateEvents,
		asksObserved,
		reviewerStats: (telemetry?.stats ?? null) as RunRow["reviewerStats"],
		effectiveConfig: check.effectiveConfig,
		harnessWarnings,
		telemetryInfraReasons: check.infraReasons,
	};
}

/** Run-wide facts every cell needs, resolved once before the matrix starts. */
export interface RunContext {
	typesafeApiKey?: string;
	/** The omp every cell runs with (see resolveOmp); unset for --dry-run, which runs nothing. */
	omp?: ResolvedOmp;
}

/** What one cell was measured against: the extension source and the pinned config as they were when the cell started. */
interface CellProvenance {
	provenance: GitProvenance;
	benchConfigSha256: string | null;
}

/**
 * Read for every cell, right before its omp process starts, never once for the run: a matrix takes hours on the
 * checkout that is being developed, and a cell loads whatever src/index.ts and typesafe.bench.json are when it
 * spawns. A fingerprint taken at the start of the run would vouch for code that later cells never ran.
 */
async function cellProvenance(): Promise<CellProvenance> {
	return { provenance: await gitProvenance(REPO_ROOT, PROVENANCE_PATHS), benchConfigSha256: benchConfigSha() };
}

function benchConfigSha(): string | null {
	try {
		return createHash("sha256").update(readFileSync(BENCH_TYPESAFE_CONFIG)).digest("hex");
	} catch {
		return null;
	}
}

/** A row for a cell whose harness code threw: recorded and flagged, so one bad cell cannot take down the matrix. */
function errorRow(c: Cell, runDir: string, model: string, err: unknown): RunRow {
	return {
		task: c.task.id,
		role: c.role,
		gate: c.gate,
		type: c.type,
		rep: c.rep,
		model,
		dir: runDir,
		exitCode: null,
		timedOut: false,
		wallMs: 0,
		success: false,
		score: 0,
		checks: {},
		infraFailure: true,
		infraReasons: ["cell_exception"],
		error: err instanceof Error ? (err.stack ?? err.message) : String(err),
	};
}

/**
 * The runs.jsonl fields an execution grade is recorded under. Shared by runCell and
 * --regrade so the two cannot drift. A grader's `timedOut` is stored as `gradeTimedOut`:
 * the row's own `timedOut` already means the harness killed omp.
 */
export function gradeRowFields(g: Pick<GradeResult, "score" | "success" | "checks"> & Partial<GradeResult>): Pick<RunRow, "success" | "score" | "checks" | "uncertain" | "graderFallback" | "gradeTimedOut" | "gradeDetails"> {
	return {
		success: g.success,
		score: g.score,
		checks: g.checks,
		uncertain: g.uncertain ?? [],
		graderFallback: g.graderFallback === true,
		gradeTimedOut: g.timedOut === true,
		gradeDetails: g.details ?? null,
	};
}

interface CellInvocation {
	name: string;
	runDir: string;
	model: string;
	argv: string[];
	env: Record<string, string>;
}

/** What omp is run with for a cell: its directory, model, argv and the variables it adds to the (stripped) environment. */
function cellInvocation(c: Cell, runsRootDir: string, globalCfg: { defaultModel: string }, args: Args, ctx: RunContext): CellInvocation {
	const name = cellName(c);
	const runDir = join(runsRootDir, name);
	const model = args.model ?? globalCfg.defaultModel;
	const argv = argvForCell(c, runDir, model, args.maxTime);
	// TYPESAFE_BENCH_LOG goes to every cell on purpose: an off cell must never produce it,
	// so its presence is the leak detector (checkTelemetry). The API key goes only to cells
	// that load the extension.
	const env: Record<string, string> = {
		...envForCell(c),
		TYPESAFE_BENCH_LOG: join(runDir, "typesafe.json"),
	};
	if (c.role !== "off" && ctx.typesafeApiKey) env.TYPESAFE_API_KEY = ctx.typesafeApiKey;
	return { name, runDir, model, argv, env };
}

async function runCell(
	c: Cell,
	runsRootDir: string,
	globalCfg: { disabledExtensions: string[]; defaultModel: string },
	args: Args,
	ctx: RunContext,
): Promise<RunRow> {
	const { runDir, model, argv, env } = cellInvocation(c, runsRootDir, globalCfg, args, ctx);

	await mkdir(join(runDir, "plans"), { recursive: true });
	const repoDir = join(runDir, "repo");
	await prepareFixture(join(c.task.dir, "fixture"), repoDir);

	const overlayPath = join(runDir, "overlay.yml");
	await writeFile(overlayPath, overlayYaml(globalCfg.disabledExtensions, join(runDir, "plans")));

	const measured = await cellProvenance();
	const result = await runOmp(argv, { cwd: repoDir, env, timeoutMs: subprocessTimeoutMs(args.maxTime), bin: ctx.omp?.path });
	await writeFile(join(runDir, "stdout.log"), result.stdout);
	await writeFile(join(runDir, "stderr.log"), result.stderr);

	const expected: ExpectedCell = { role: c.role, gate: c.gate };
	const { telemetryInfraReasons, ...derived } = await deriveNoteAndTelemetryFields(runDir, result.stdout, expected, c.type);
	const { sessionPath } = derived;
	const infraReasons = [...processInfraReasons({ ...result, hitMaxTime: derived.hitMaxTime }), ...telemetryInfraReasons];
	const harnessWarnings = [...derived.harnessWarnings];

	await writeFile(
		join(runDir, "meta.json"),
		JSON.stringify(
			{
				argv: result.argv,
				exitCode: result.exitCode,
				signal: result.signal,
				wallMs: result.wallMs,
				timedOut: result.timedOut,
				hitMaxTime: derived.hitMaxTime,
				spawnError: result.spawnError ?? null,
				envKeys: Object.keys(env),
				env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === "TYPESAFE_API_KEY" ? "<redacted>" : v])),
				expected: { ...expected, extensionLoaded: c.role !== "off", extensionPath: c.role !== "off" ? EXTENSION_ENTRY : null },
				// what the repo's own config merge resolves for this cell, and what the extension itself reported (null when its dump carries none)
				resolvedConfig: c.role !== "off" ? resolveCellConfig(c) : null,
				effectiveConfig: derived.effectiveConfig,
				provenance: measured.provenance,
				benchConfigSha256: measured.benchConfigSha256,
				infraReasons,
				warnings: harnessWarnings,
			},
			null,
			2,
		),
	);

	let gradeResult: GradeResult;
	try {
		const graderMod = await import(join(c.task.dir, "grade.ts"));
		// Extra context beyond the repo dir, for graders that need to inspect
		// the session transcript (e.g. over-scoped-ask checking for an `ask`
		// tool call or a stated assumption). Ignored by graders that only take
		// `cwd`.
		gradeResult = await graderMod.grade(repoDir, { sessionPath, runDir });
	} catch (err) {
		gradeResult = { score: 0, success: false, checks: { grader_threw: false } };
		harnessWarnings.push("grader_threw");
		await writeFile(join(runDir, "grade-error.log"), String(err));
	}

	// Plan-side grading (plan cells only): newest .md under <runDir>/plans (the
	// overlay's plan.autosaveDir), Jev checklist + blind LLM judge. Exec cells
	// record the same fields empty, so every row has one shape.
	let planGrade = emptyPlanGrade();
	if (c.type === "plan") {
		try {
			planGrade = await gradePlan(runDir, c.task.dir);
		} catch (err) {
			harnessWarnings.push(PLAN_GRADE_THREW);
			await writeFile(join(runDir, "plan-grade-error.log"), String(err));
		}
	}

	return {
		task: c.task.id,
		role: c.role,
		gate: c.gate,
		type: c.type,
		rep: c.rep,
		model,
		dir: runDir,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		spawnError: result.spawnError,
		wallMs: result.wallMs,
		// Rows with infraFailure say nothing about the agent or the extension; the
		// report must leave them out of means and count them instead.
		infraFailure: infraReasons.length > 0,
		infraReasons,
		...gradeRowFields(gradeResult),
		...derived,
		harnessWarnings,
		extensionHead: measured.provenance.head,
		extensionDirty: measured.provenance.dirty,
		extensionDiffSha: measured.provenance.diffSha,
		benchConfigSha256: measured.benchConfigSha256,
		...planGradeRowFields(planGrade),
	};
}

async function runCellSafely(c: Cell, runsRootDir: string, globalCfg: { disabledExtensions: string[]; defaultModel: string }, args: Args, ctx: RunContext): Promise<RunRow> {
	try {
		return await runCell(c, runsRootDir, globalCfg, args, ctx);
	} catch (err) {
		return errorRow(c, join(runsRootDir, cellName(c)), args.model ?? globalCfg.defaultModel, err);
	}
}

/** Warnings runCell adds from the grading side. Telemetry cannot re-derive them, so a regrade carries them over. */
const GRADING_WARNINGS = ["grader_threw", PLAN_GRADE_THREW];

function storedWarnings(row: Record<string, unknown>): string[] {
	return Array.isArray(row.harnessWarnings) ? row.harnessWarnings.filter((w): w is string => typeof w === "string") : [];
}

/** The role/gate a stored row was meant to represent, or null when the row predates those fields beyond recognition. */
function expectedForRow(row: Record<string, unknown>): ExpectedCell | null {
	const role = (ALL_ROLES as readonly unknown[]).includes(row.role) ? (row.role as Role) : null;
	if (!role) return null;
	return { role, gate: role === "off" || row.gate === "off" ? "off" : "on" };
}

/**
 * Re-runs the deterministic execution grader (not omp) for every row already
 * recorded in <resultsDir>/runs.jsonl, in place, and re-derives every field that
 * comes from files on disk (session notes, usage, typesafe.json, infra flags). Cheap:
 * the repo copies under each run's `repo/` dir survive the run, so this just
 * re-invokes each task's grade.ts against them, useful when the grader itself was
 * buggy and re-running omp would be wasteful. Skips rows with no `dir` (e.g. stale
 * --dry-run rows) and rows whose cell threw before it ran. Plan-side grading (a
 * judge call, cached) stays with `bun run bench/grade-plan.ts --rescore`.
 */
async function regradeResultsDir(resultsDir: string): Promise<{ total: number; regraded: number; nowSuccessful: number; telemetryRefreshed: number }> {
	const runsPath = join(resultsDir, "runs.jsonl");
	const lines = (await Bun.file(runsPath).text()).split("\n").map((l) => l.trim());
	let total = 0;
	let regraded = 0;
	let nowSuccessful = 0;
	let telemetryRefreshed = 0;

	const outLines: string[] = [];
	for (const line of lines) {
		if (!line) continue;
		const row = JSON.parse(line) as Record<string, unknown>;
		const cellThrew = Array.isArray(row.infraReasons) && row.infraReasons.includes("cell_exception");
		if (typeof row.dir === "string" && typeof row.task === "string" && !cellThrew) {
			total++;

			// Re-derive noteCounts/severity/channel/usage/ambiguity-gate fields
			// from files already on disk (sessions/, typesafe.json, stdout.log):
			// the same function the live runner uses, so this can never drift
			// from what a fresh run would have recorded.
			try {
				const carried = storedWarnings(row).filter((w) => GRADING_WARNINGS.includes(w));
				const { telemetryInfraReasons, ...derived } = await deriveNoteAndTelemetryFields(row.dir, undefined, expectedForRow(row), row.type === "plan" || row.type === "exec" ? row.type : undefined);
				Object.assign(row, derived);
				// `derived` holds the telemetry warnings only: the grading side's own stay with the row.
				row.harnessWarnings = [...new Set([...derived.harnessWarnings, ...carried])];
				row.infraReasons = [
					...processInfraReasons({
						exitCode: row.exitCode as number | null | undefined,
						timedOut: row.timedOut === true,
						spawnError: typeof row.spawnError === "string" ? row.spawnError : undefined,
						hitMaxTime: derived.hitMaxTime,
					}),
					...telemetryInfraReasons,
				];
				row.infraFailure = (row.infraReasons as string[]).length > 0;
				telemetryRefreshed++;
			} catch (err) {
				console.error(`[regrade] telemetry refresh failed for ${row.dir}: ${err}`);
			}

			try {
				const taskDir = join(import.meta.dir, "tasks", row.task);
				const graderMod = await import(join(taskDir, "grade.ts"));
				const repoDir = join(row.dir, "repo");
				const grade = await graderMod.grade(repoDir, { sessionPath: row.sessionPath ?? null, runDir: row.dir });
				Object.assign(row, gradeRowFields(grade));
				// The grade just replaced is the one a `grader_threw` warning was about.
				row.harnessWarnings = storedWarnings(row).filter((w) => w !== "grader_threw");
				regraded++;
				if (grade.success) nowSuccessful++;
			} catch (err) {
				console.error(`[regrade] failed for ${row.dir}: ${err}`);
				if (!storedWarnings(row).includes("grader_threw")) row.harnessWarnings = [...storedWarnings(row), "grader_threw"];
			}

			// Plan-side fields (planPath/planChecklistScore/planJudgeScore/...) are
			// deliberately left untouched here: that's what grade-plan.ts --rescore
			// is for, and it's a separate (LLM-judge, cached) cost.
		}
		outLines.push(JSON.stringify(row));
	}

	await writeFile(runsPath, `${outLines.join("\n")}\n`);
	return { total, regraded, nowSuccessful, telemetryRefreshed };
}

/** Facts and prerequisites checked once before any cell runs (not for --dry-run, which runs nothing). */
async function preflight(cells: Cell[]): Promise<{ ompVersion: string; omp: ResolvedOmp; apiKey: ApiKeyResolution }> {
	const omp = resolveOmp(process.env, REPO_ROOT);
	if (!omp) {
		const named = process.env.OMP_BIN?.trim();
		throw new Error(`omp is not runnable (${named ? `OMP_BIN=${named} was not found` : "none found on PATH"}); install it or fix PATH before running the bench`);
	}
	const version = await runProcess([omp.path, "--version"], { cwd: REPO_ROOT, env: {}, timeoutMs: 30_000 });
	if (version.spawnError) throw new Error(`omp is not runnable (${version.spawnError}); install it or fix PATH before running the bench`);
	if (version.exitCode !== 0) throw new Error(`\`omp --version\` exited ${version.exitCode}: ${version.stderr.trim() || version.stdout.trim()}`);

	const apiKey = await sourceTypesafeApiKey();
	if (cells.some((c) => c.role !== "off")) {
		if (!apiKey.key) {
			throw new Error("TYPESAFE_API_KEY is not set in the environment or ~/.config/agent-secrets.env; advisory/adversarial cells would silently behave like `off`");
		}
		if (!existsSync(EXTENSION_ENTRY)) throw new Error(`extension entry not found: ${EXTENSION_ENTRY}`);
		if (!existsSync(join(REPO_ROOT, "node_modules", "@typesafe-ai", "sdk"))) {
			console.warn(`warning: ${join(REPO_ROOT, "node_modules", "@typesafe-ai", "sdk")} is missing; run \`bun install\` or the extension may fail to load`);
		}
	}
	return { ompVersion: version.stdout.trim(), omp, apiKey };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	if (argv[0] === "--regrade") {
		const resultsDirArg = argv[1];
		if (!resultsDirArg) throw new UsageError("--regrade needs a results directory");
		const resultsDir = resultsDirArg.startsWith("/") ? resultsDirArg : resolve(process.cwd(), resultsDirArg);
		const summary = await regradeResultsDir(resultsDir);
		console.log(JSON.stringify(summary, null, 2));
		return 0;
	}

	const args = parseArgs(argv);
	if (args.help) {
		console.log(USAGE);
		return 0;
	}

	const globalCfg = await readGlobalConfig();
	const tasks = await discoverTasks(args.tasks);
	if (tasks.length === 0) throw new UsageError("no tasks found under bench/tasks");

	const cells = buildMatrix(tasks, args);
	assertCellConfigs(cells);

	const runId = args.dryRun ? "dry-run" : new Date().toISOString().replace(/[:.]/g, "-");
	const resultsDir = resolve(args.resultsDir ?? join(import.meta.dir, "results"), runId);
	const runsRootDir = join(resultsDir, "runs");
	const runsJsonlPath = join(resultsDir, "runs.jsonl");

	let ctx: RunContext = {};
	if (!args.dryRun) {
		const { ompVersion, omp, apiKey } = await preflight(cells);
		const provenance = await gitProvenance(REPO_ROOT, PROVENANCE_PATHS);
		ctx = { typesafeApiKey: apiKey.key, omp };
		const inheritedTypesafeEnv = Object.keys(process.env)
			.filter((k) => k.startsWith("TYPESAFE_") && k !== "TYPESAFE_API_KEY")
			.sort();

		await mkdir(runsRootDir, { recursive: true });
		await writeFile(
			join(resultsDir, "run-meta.json"),
			JSON.stringify(
				{
					startedAt: new Date().toISOString(),
					argv,
					args,
					cells: cells.length,
					ompVersion,
					ompPath: omp.path,
					ompSource: omp.source,
					extensionEntry: EXTENSION_ENTRY,
					provenance,
					benchConfig: BENCH_TYPESAFE_CONFIG,
					benchConfigSha256: benchConfigSha(),
					apiKeySource: apiKey.source,
					strippedInheritedEnv: inheritedTypesafeEnv,
				},
				null,
				2,
			),
		);
		console.log(`${ompVersion} (${omp.path}, ${omp.source}); extension ${provenance.head?.slice(0, 12) ?? "unknown"}${provenance.dirty ? " (dirty)" : ""}; TYPESAFE_API_KEY from ${apiKey.source}`);
		if (inheritedTypesafeEnv.length > 0) console.log(`ignoring inherited ${inheritedTypesafeEnv.join(", ")} (cells are hermetic; edit bench/typesafe.bench.json to change config)`);
		if (provenance.dirty) console.log(`note: uncommitted changes under ${PROVENANCE_PATHS.join(", ")} are being measured (diff sha ${provenance.diffSha?.slice(0, 12)})`);
	}

	let cursor = 0;
	let written = 0;
	const infraCounts: Record<string, number> = {};
	let infraRows = 0;
	async function worker(): Promise<void> {
		while (cursor < cells.length) {
			const c = cells[cursor++];
			if (args.dryRun) {
				const { name, argv, env } = cellInvocation(c, runsRootDir, globalCfg, args, ctx);
				console.log(`# ${name}`);
				console.log(formatCommand(env, argv));
				continue;
			}
			const row = await runCellSafely(c, runsRootDir, globalCfg, args, ctx);
			await appendFile(runsJsonlPath, `${JSON.stringify(row)}\n`);
			written++;
			const reasons = row.infraReasons ?? [];
			if (row.infraFailure === true) {
				infraRows++;
				for (const r of reasons) infraCounts[r] = (infraCounts[r] ?? 0) + 1;
			}
			const infra = reasons.length > 0 ? ` INFRA[${reasons.join(",")}]` : "";
			console.log(`[${cellName(c)}] exit=${row.exitCode} success=${row.success} score=${row.score}${infra}`);
		}
	}

	const workerCount = args.dryRun ? 1 : Math.min(args.concurrency, Math.max(1, cells.length));
	const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
	const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
	if (failure) throw failure.reason;

	if (args.dryRun) return 0;
	console.log(`\nWrote ${written} rows to ${runsJsonlPath}`);
	if (infraRows > 0) {
		const breakdown = Object.entries(infraCounts).map(([k, n]) => `${k}=${n}`).join(", ");
		console.log(`${infraRows} of ${written} rows are infrastructure failures (${breakdown}); they carry infraFailure=true and must be excluded from means`);
	}
	// A matrix in which nothing ran for real is a failed run, not a clean one.
	return written > 0 && infraRows === written ? 1 : 0;
}

if (import.meta.main) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			if (err instanceof UsageError) {
				console.error(`error: ${err.message}\n\n${USAGE}`);
				process.exitCode = 2;
			} else {
				console.error(err);
				process.exitCode = 1;
			}
		},
	);
}

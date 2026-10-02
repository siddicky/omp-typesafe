/**
 * The body of the fake `omp` the bench tests put on PATH (see helpers.ts writeFakeOmp). It is a script, not a
 * module: it reads process.argv / process.env, writes what a real omp run would leave in the run dir, and exits.
 *
 * What it leaves behind, for a cell the harness named `<task>-<role>[-nogate]-<type>-<rep>`:
 *  - when given `-e` (the extension), the TYPESAFE_BENCH_LOG dump in the shape src/index.ts writes it:
 *    { role, phases, stats, usage, costUsd, lastResolvedModel, history, ambiguity, historyDropped, config, subagentSessionsSkipped };
 *  - a session JSONL under --session-dir with the custom messages and assistant usage the bench parses;
 *  - for a plan cell (--plan-yolo), a plan under <runDir>/plans;
 *  - optionally a solved repo: FAKE_OMP_REMOVE lists files to delete when the cell is told to solve.
 *
 * Behavior is driven by env:
 *  - FAKE_OMP_LOG: JSONL file; one {argv, env, cwd, start, end} line is appended per run.
 *  - FAKE_OMP_SLEEP_MS: how long a run takes (default 400).
 *  - FAKE_OMP_MODE: how every cell behaves unless FAKE_OMP_CELLS says otherwise:
 *      "ok"            extension loads and reports what its env says
 *      "no-extension"  extension is loaded (-e) but writes no dump
 *      "leak"          writes a dump even without -e (the baseline leaking the extension)
 *      "leak-gate"     like leak, and the dump says the ambiguity gate was on
 *      "fail"          exits 3
 *      "max-time"      exits 1 with omp's deadline abort (omp stopping itself at --max-time)
 *      "disabled"      the dump says the reviewer is disabled
 *      "gate-wrong"    the dump says the ambiguity gate was on whatever the env asked for
 *  - FAKE_OMP_CELLS: JSON { "<exact cell name>": { mode?: string, solve?: boolean, planMarkers?: string[] } };
 *    `planMarkers` are appended to the plan text (the fake Jev and fake claude key off them).
 *  - FAKE_OMP_SOLVE=1: every cell solves (FAKE_OMP_REMOVE entries are deleted from its repo).
 *  - FAKE_OMP_TOUCH: JSON list of files; the first run to start (FAKE_OMP_TOUCH_MARKER, a path that does not
 *    exist yet, is how it tells) appends a newline to each, like a developer editing the checkout mid-run.
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
	console.log("omp/0.0.0-fake");
	process.exit(0);
}

const env = process.env;
const start = Date.now();
if (env.FAKE_OMP_TOUCH && env.FAKE_OMP_TOUCH_MARKER && !existsSync(env.FAKE_OMP_TOUCH_MARKER)) {
	writeFileSync(env.FAKE_OMP_TOUCH_MARKER, "");
	for (const file of JSON.parse(env.FAKE_OMP_TOUCH) as string[]) appendFileSync(file, "\n");
}
await Bun.sleep(Number(env.FAKE_OMP_SLEEP_MS ?? 400));

const flag = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
const repoDir = flag("--cwd") ?? process.cwd();
const runDir = dirname(repoDir);
const cellName = basename(runDir);
const cell = (JSON.parse(env.FAKE_OMP_CELLS ?? "{}") as Record<string, { mode?: string; solve?: boolean; planMarkers?: string[] }>)[cellName] ?? {};
const mode = cell.mode ?? env.FAKE_OMP_MODE ?? "ok";
const solve = cell.solve ?? env.FAKE_OMP_SOLVE === "1";
const isPlan = argv.includes("--plan-yolo");
const loadsExtension = argv.includes("-e");
const role = env.TYPESAFE_ROLE ?? "adversarial";

if (solve) {
	for (const rel of (env.FAKE_OMP_REMOVE ?? "").split(",").filter(Boolean)) rmSync(join(repoDir, rel), { force: true });
}

// ---- timeline: plan-phase records come before the handoff, exec-phase records after ----
const at = (n: number) => new Date(start + n * 1000).toISOString();
const [tModeContext, tPlanNote, tGate, tHandoff, tExecNote] = [1, 2, 3, 4, 5].map(at);

const reviewerOn = mode === "disabled" ? false : env.TYPESAFE_REVIEW_ENABLED === "1";
const gateOn = mode === "gate-wrong" || mode === "leak-gate" ? true : env.TYPESAFE_AMBIGUITY_GATE === "1";
const writesDump = Boolean(env.TYPESAFE_BENCH_LOG) && ((loadsExtension && mode !== "no-extension") || mode === "leak" || mode === "leak-gate");

const rec = (ts: string, decision: string, extra: Record<string, unknown> = {}) => ({ ts, role, kind: "action", severity: decision === "none" ? "none" : "concern", decision, ...extra });
const history = isPlan
	? [rec(tPlanNote, "delivered", { channel: "aside", defect: "none" }), rec(tPlanNote, "none"), rec(tExecNote, "delivered", { channel: "aside", defect: "none" })]
	: [rec(tPlanNote, "delivered", { channel: "aside", defect: "none" }), rec(tPlanNote, "suppressed", { reason: "duplicate" })];
const scores =
	gateOn && isPlan
		? [{ ts: tGate, trigger: "propose", ambiguity: 0.6, dims: { goal: 0.5, constraints: 0.5, criteria: 0.5, context: 0.5 }, weakest: "goal", gap: "unclear scope", userCanAnswer: 0.8, decision: "would_steer" }]
		: [];

if (writesDump) {
	writeFileSync(
		env.TYPESAFE_BENCH_LOG as string,
		JSON.stringify({
			role,
			phases: ["plan", "execute"],
			stats: { delivered: { nit: 0, concern: history.filter((h) => h.decision === "delivered").length, blocker: 0 }, suppressed: {}, downgraded: 0, errors: 0, steers: 0, historyDropped: 0 },
			usage: { inputTokens: 5, outputTokens: 0, requests: 1 },
			costUsd: 0.001,
			lastResolvedModel: "jev-fake-1",
			history,
			ambiguity: { scores, asksObserved: 0 },
			subagentSessionsSkipped: 0,
			historyDropped: 0,
			config: { role, phases: ["plan", "execute"], model: "jev-fake-1", adversaryEnabled: reviewerOn, reviewActions: true, reviewMessages: true, reviewTurns: true, ambiguityGateEnabled: gateOn },
		}),
	);
}

// ---- session JSONL, plan file ----
const sessionDir = flag("--session-dir");
if (sessionDir && mode !== "fail") {
	const dir = join(sessionDir, "fake-cwd");
	mkdirSync(dir, { recursive: true });
	const custom = (customType: string, timestamp: string) => ({ type: "custom_message", customType, timestamp });
	const reviewerType = `ai.typesafe.${role === "advisory" ? "advisory" : "adversary"}`;
	const entries: unknown[] = [{ type: "session", version: 3, id: `fake-${cellName}`, timestamp: at(0), cwd: repoDir }];
	if (isPlan) entries.push(custom("plan-mode-context", tModeContext));
	if (writesDump && loadsExtension) entries.push(custom(reviewerType, tPlanNote));
	if (writesDump && loadsExtension && gateOn && isPlan) entries.push(custom("ai.typesafe.ambiguity", tGate));
	if (isPlan && mode !== "max-time") entries.push(custom("plan-yolo-handoff", tHandoff));
	if (isPlan && writesDump && loadsExtension && mode !== "max-time") entries.push(custom(reviewerType, tExecNote));
	entries.push({ type: "message", timestamp: at(6), message: { role: "assistant", usage: { totalTokens: 120, cost: { total: 0.002 } } } });
	writeFileSync(join(dir, "session.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
if (isPlan && mode !== "fail") {
	mkdirSync(join(runDir, "plans"), { recursive: true });
	const text = ["# Plan", "", "Check whether data/seed.json is referenced before deleting; it is loaded by src/loadSeed.ts and a test, so keep it.", "Run bun test after the cleanup.", "", ...(cell.planMarkers ?? [])].join("\n");
	writeFileSync(join(runDir, "plans", "plan.md"), text);
}

if (env.FAKE_OMP_LOG) {
	const keep = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("TYPESAFE_") || k === "FAKE_OMP_MODE"));
	appendFileSync(env.FAKE_OMP_LOG, `${JSON.stringify({ argv, env: keep, cwd: process.cwd(), start, end: Date.now() })}\n`);
}
if (mode === "max-time") {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Deadline exceeded" } }));
	process.exit(1);
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.001 } } } }));
process.exit(mode === "fail" ? 3 : 0);

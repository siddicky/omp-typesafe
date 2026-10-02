import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ALL_GATES,
	ALL_ROLES,
	ALL_TYPES,
	BENCH_TYPESAFE_CONFIG,
	EXTENSION_ENTRY,
	UsageError,
	argvForCell,
	assertCellConfigs,
	buildMatrix,
	cellName,
	checkTelemetry,
	deriveNoteAndTelemetryFields,
	discoverTasks,
	envForCell,
	formatCommand,
	gradeRowFields,
	parseArgs,
	resolveCellConfig,
	shellQuote,
	type Cell,
	type ResolvedCellConfig,
	type TaskEntry,
} from "../../bench/run";
import type { TelemetryLog } from "../../bench/lib/telemetry";
import { hermeticEnv } from "../../bench/lib/omp-run";
import { applyEnvOverrides, DEFAULT_CONFIG, mergeConfig, resolveConfigPath, subagentGuardEnabled } from "../../src/config";
import { cleanupTmp, makeTmp } from "./helpers";

afterAll(cleanupTmp);

const task = (id: string): TaskEntry => ({ id, dir: `/tasks/${id}`, spec: { id, execPrompt: `exec ${id}`, planPrompt: `plan ${id}` } });

describe("parseArgs (bench_ci-arg-validation)", () => {
	test("defaults", () => {
		expect(parseArgs([])).toMatchObject({ reps: 1, concurrency: 2, maxTime: "10m", gates: ["on"], dryRun: false, help: false });
		expect(parseArgs([]).roles).toEqual([...ALL_ROLES]);
		expect(parseArgs([]).types).toEqual([...ALL_TYPES]);
	});

	test("valid values are accepted and deduplicated", () => {
		const a = parseArgs(["--reps", "3", "--concurrency", "4", "--roles", "off,advisory,off", "--types", "plan", "--gates", "on,off", "--max-time", "90s", "--tasks", "a,b,a", "--model", "m", "--results-dir", "/x", "--dry-run"]);
		expect(a).toMatchObject({ reps: 3, concurrency: 4, roles: ["off", "advisory"], types: ["plan"], gates: ["on", "off"], maxTime: "90s", tasks: ["a", "b"], model: "m", resultsDir: "/x", dryRun: true });
	});

	test.each([["abc"], ["0"], ["-1"], ["1.5"], ["2x"], [""]])("--concurrency %p is rejected (NaN used to mean zero workers and a silent exit 0)", (v) => {
		expect(() => parseArgs(["--concurrency", v])).toThrow(UsageError);
		expect(() => parseArgs(["--concurrency", v])).toThrow(/--concurrency must be an integer >= 1/);
	});

	test.each([["abc"], ["0"], ["3abc"], ["2.5"]])("--reps %p is rejected", (v) => {
		expect(() => parseArgs(["--reps", v])).toThrow(/--reps must be an integer >= 1/);
	});

	test("a role typo is rejected rather than run and labelled as that role", () => {
		expect(() => parseArgs(["--roles", "off,advisory,adverserial"])).toThrow(/--roles: unknown value 'adverserial'/);
		expect(() => parseArgs(["--roles", "offf"])).toThrow(/offf/);
	});

	test("an unknown --types value ('execute') is rejected instead of splitting report cells", () => {
		expect(() => parseArgs(["--types", "execute"])).toThrow(/--types: unknown value 'execute' \(allowed: exec, plan\)/);
	});

	test("an unknown --gates value is rejected", () => {
		expect(() => parseArgs(["--gates", "maybe"])).toThrow(/--gates: unknown value 'maybe'/);
	});

	test("--max-time is validated up front, not inside the first cell", () => {
		expect(() => parseArgs(["--max-time", "banana"])).toThrow(/--max-time must look like/);
		expect(() => parseArgs(["--max-time", "0"])).toThrow(/greater than zero/);
		expect(parseArgs(["--max-time", "600"]).maxTime).toBe("600");
	});

	test("a flag without a value is rejected", () => {
		expect(() => parseArgs(["--tasks"])).toThrow(/--tasks requires a value/);
		expect(() => parseArgs(["--tasks", "--dry-run"])).toThrow(/--tasks requires a value/);
		expect(() => parseArgs(["--roles", ""])).toThrow(/--roles needs at least one/);
		expect(() => parseArgs(["--model", " "])).toThrow(/--model must not be empty/);
	});

	test("unknown flags and --help", () => {
		expect(() => parseArgs(["--nope"])).toThrow(/unknown arg: --nope/);
		expect(parseArgs(["--help"]).help).toBe(true);
	});
});

describe("discoverTasks", () => {
	test("finds every task by default", async () => {
		expect((await discoverTasks()).map((t) => t.id)).toContain("rename-callsite");
	});

	test("a misspelled task id is an error even when other ids are valid", async () => {
		// Used to run only verify-claim and drop 'rename-calsite' without a word.
		await expect(discoverTasks(["verify-claim", "rename-calsite"])).rejects.toThrow(/--tasks: unknown task 'rename-calsite' \(available: .*verify-claim/);
	});

	test("a valid subset is returned", async () => {
		expect((await discoverTasks(["verify-claim"])).map((t) => t.id)).toEqual(["verify-claim"]);
	});
});

describe("buildMatrix and cellName", () => {
	const names = (cells: Cell[]) => cells.map(cellName).sort();

	test("the off baseline has one cell per (task, type, rep), never duplicated across gates", () => {
		const cells = buildMatrix([task("t")], { roles: [...ALL_ROLES], types: [...ALL_TYPES], gates: [...ALL_GATES], reps: 2 });
		const off = cells.filter((c) => c.role === "off");
		expect(off).toHaveLength(4);
		expect(off.every((c) => c.gate === "off")).toBe(true);
		// treatment roles expand over the gate factor: 2 roles x 2 gates x 2 types x 2 reps
		expect(cells.filter((c) => c.role !== "off")).toHaveLength(16);
		expect(new Set(names(cells)).size).toBe(cells.length);
	});

	test("with the default gate list the matrix is roles x types x reps", () => {
		const cells = buildMatrix([task("t")], { roles: [...ALL_ROLES], types: [...ALL_TYPES], gates: ["on"], reps: 2 });
		expect(cells).toHaveLength(12);
		expect(cells.filter((c) => c.role !== "off").every((c) => c.gate === "on")).toBe(true);
	});

	test("gate-off treatment cells get a distinct name and the original names are unchanged", () => {
		const t = task("t");
		expect(cellName({ task: t, role: "advisory", gate: "on", type: "exec", rep: 0 })).toBe("t-advisory-exec-0");
		expect(cellName({ task: t, role: "advisory", gate: "off", type: "exec", rep: 0 })).toBe("t-advisory-nogate-exec-0");
		expect(cellName({ task: t, role: "off", gate: "off", type: "plan", rep: 1 })).toBe("t-off-plan-1");
	});

	test("the shuffle is a permutation driven by the injected rng", () => {
		const args = { roles: [...ALL_ROLES], types: [...ALL_TYPES], gates: ["on"] as ("on" | "off")[], reps: 1 };
		const a = buildMatrix([task("t")], args, () => 0);
		const b = buildMatrix([task("t")], args, () => 0);
		expect(names(a)).toEqual(names(b));
		expect(a.map(cellName)).toEqual(b.map(cellName));
	});
});

describe("cell environment is hermetic (bench_ci-off-baseline-not-off, bench_ci-v-treatment-inherits-user-config)", () => {
	// The user's dotfiles typesafe.json: reviewer off. Every treatment arm used to inherit this.
	const hostileUserConfig = mergeConfig(DEFAULT_CONFIG, { adversary: { enabled: false, reviewMessages: false } });

	test("the off baseline turns off both the reviewer and the ambiguity gate", () => {
		const cfg = applyEnvOverrides(mergeConfig(DEFAULT_CONFIG, {}), envForCell({ role: "off", gate: "off" }));
		expect(cfg.adversary.enabled).toBe(false);
		// Previously only TYPESAFE_REVIEW_ENABLED=0 was set, which left the gate on: it called Jev, steered and wrote telemetry.
		expect(cfg.ambiguityGate.enabled).toBe(false);
	});

	test.each([
		["advisory", "on"],
		["advisory", "off"],
		["adversarial", "on"],
		["adversarial", "off"],
	] as const)("%s cell with gate %s runs that exact treatment whatever the user's own config says", (role, gate) => {
		const cfg = applyEnvOverrides(hostileUserConfig, envForCell({ role, gate }));
		expect(cfg.role).toBe(role);
		expect(cfg.adversary.enabled).toBe(true);
		expect(cfg.ambiguityGate.enabled).toBe(gate === "on");
	});

	test.each(["advisory", "adversarial"] as const)("a %s cell states that the subagent guard is on, so a stray =0 in the shell cannot review its workers", (role) => {
		expect(envForCell({ role, gate: "on" }).TYPESAFE_SUBAGENT_GUARD).toBe("1");
		expect(envForCell({ role, gate: "off" }).TYPESAFE_SUBAGENT_GUARD).toBe("1");
		for (const stray of ["0", "false", "off", "no"]) {
			const child = hermeticEnv({ PATH: "/bin", TYPESAFE_SUBAGENT_GUARD: stray }, envForCell({ role, gate: "on" }));
			expect(subagentGuardEnabled(child)).toBe(true);
		}
		// The baseline loads no extension, so there is nothing for the guard to guard.
		expect(envForCell({ role: "off", gate: "off" }).TYPESAFE_SUBAGENT_GUARD).toBeUndefined();
	});

	test("every cell reads the pinned bench config instead of ~/.omp/agent/typesafe.json", () => {
		for (const role of ALL_ROLES) {
			const env = envForCell({ role, gate: role === "off" ? "off" : "on" });
			expect(env.TYPESAFE_CONFIG).toBe(BENCH_TYPESAFE_CONFIG);
			expect(resolveConfigPath(env)).toBe(BENCH_TYPESAFE_CONFIG);
		}
	});

	test("the pinned config enables the reviewer, all review kinds and the gate", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(BENCH_TYPESAFE_CONFIG, "utf8")));
		expect(cfg.adversary).toMatchObject({ enabled: true, reviewActions: true, reviewMessages: true, reviewTurns: true });
		expect(cfg.ambiguityGate.enabled).toBe(true);
		expect(cfg.stopGate.enabled).toBe(false);
		expect(cfg.phases).toEqual(["plan", "execute"]);
	});
});

describe("resolveCellConfig / assertCellConfigs", () => {
	test("each treatment cell resolves to its labelled role, a fully enabled reviewer and the labelled gate state", () => {
		for (const role of ["advisory", "adversarial"] as const) {
			for (const gate of ["on", "off"] as const) {
				expect(resolveCellConfig({ role, gate })).toMatchObject({
					role,
					phases: ["plan", "execute"],
					adversary: { enabled: true, reviewActions: true, reviewMessages: true, reviewTurns: true },
					ambiguityGate: { enabled: gate === "on" },
				});
			}
		}
	});

	test("the off baseline resolves with the reviewer and gate off", () => {
		expect(resolveCellConfig({ role: "off", gate: "off" })).toMatchObject({ adversary: { enabled: false }, ambiguityGate: { enabled: false } });
	});

	test("the standard matrix passes", () => {
		const cells = buildMatrix([task("t")], { roles: [...ALL_ROLES], types: [...ALL_TYPES], gates: [...ALL_GATES], reps: 1 });
		expect(() => assertCellConfigs(cells)).not.toThrow();
	});

	test("a config that would disable the reviewer in a treatment cell aborts with a clear message", () => {
		// The v-treatment-inherits-user-config failure: every advisory/adversarial arm silently ran with the reviewer off.
		const broken = (c: Pick<Cell, "role" | "gate">): ResolvedCellConfig => ({
			...resolveCellConfig(c),
			adversary: { enabled: false, reviewActions: true, reviewMessages: false, reviewTurns: true },
		});
		expect(() => assertCellConfigs([{ role: "advisory", gate: "on" }], broken)).toThrow(/would not run the advisory cell with gate on as labelled: the reviewer or one of its review kinds is disabled/);
	});

	test("a wrong role or gate state aborts too, and the off baseline is exempt", () => {
		const wrongRole = (c: Pick<Cell, "role" | "gate">): ResolvedCellConfig => ({ ...resolveCellConfig(c), role: "adversarial" });
		expect(() => assertCellConfigs([{ role: "advisory", gate: "on" }], wrongRole)).toThrow(/role resolves to adversarial/);
		const gateOn = (c: Pick<Cell, "role" | "gate">): ResolvedCellConfig => ({ ...resolveCellConfig(c), ambiguityGate: { enabled: true, threshold: 0.2 } });
		expect(() => assertCellConfigs([{ role: "advisory", gate: "off" }], gateOn)).toThrow(/ambiguity gate resolves to on/);
		expect(() => assertCellConfigs([{ role: "off", gate: "off" }], gateOn)).not.toThrow();
	});
});

describe("argvForCell (bench_ci-extension-under-test-not-repo)", () => {
	const spec = { id: "t", execPrompt: "do the thing", planPrompt: "plan the thing" };
	const mk = (role: Cell["role"], type: Cell["type"]) => ({ role, type, task: { spec } as TaskEntry });

	test("treatment cells load this checkout's src/index.ts explicitly after disabling discovery", () => {
		const argv = argvForCell(mk("adversarial", "exec"), "/run/x", "m", "10m");
		const e = argv.indexOf("-e");
		expect(e).toBeGreaterThan(-1);
		expect(argv[e + 1]).toBe(EXTENSION_ENTRY);
		expect(EXTENSION_ENTRY.endsWith("/src/index.ts")).toBe(true);
		expect(argv).toContain("--no-extensions");
		expect(argv.indexOf("--no-extensions")).toBeLessThan(e);
		expect(argv).toContain("--no-skills");
		expect(argv).toContain("--no-rules");
	});

	// A global prewalk.enabled switches the model at the first edit, in every arm, while the row still names the starting one.
	test("every cell, baseline included, turns prewalk off", () => {
		for (const role of ["off", "advisory", "adversarial"] as const) {
			for (const type of ["exec", "plan"] as const) expect(argvForCell(mk(role, type), "/run/x", "m", "10m")).toContain("--no-prewalk");
		}
	});

	test("the off baseline loads no extension at all", () => {
		const argv = argvForCell(mk("off", "exec"), "/run/x", "m", "10m");
		expect(argv).not.toContain("-e");
		expect(argv).toContain("--no-extensions");
	});

	test("the prompt is last, the overlay and session dir live in the run dir, plan cells add the plan-yolo flags", () => {
		const exec = argvForCell(mk("advisory", "exec"), "/run/x", "m", "10m");
		expect(exec.at(-1)).toBe("do the thing");
		expect(exec[exec.indexOf("--config") + 1]).toBe("/run/x/overlay.yml");
		expect(exec[exec.indexOf("--session-dir") + 1]).toBe("/run/x/sessions");
		expect(exec[exec.indexOf("--cwd") + 1]).toBe("/run/x/repo");
		const plan = argvForCell(mk("advisory", "plan"), "/run/x", "m", "10m");
		expect(plan.at(-1)).toBe("plan the thing");
		expect(plan.slice(plan.indexOf("--plan-yolo"), plan.indexOf("--plan-yolo") + 3)).toEqual(["--plan-yolo", "--plan-yolo-into", "m"]);
		expect(exec).not.toContain("--plan-yolo");
	});

	test("an explicit extension path overrides the default", () => {
		const argv = argvForCell(mk("advisory", "exec"), "/run/x", "m", "10m", "/elsewhere/index.ts");
		expect(argv[argv.indexOf("-e") + 1]).toBe("/elsewhere/index.ts");
	});
});

describe("printed commands are shell-safe (bench_ci-dry-run-writes-and-crashes)", () => {
	test("plain words and paths stay unquoted", () => {
		expect(shellQuote("--no-lsp")).toBe("--no-lsp");
		expect(shellQuote("/a/b-c_d.ts")).toBe("/a/b-c_d.ts");
		expect(shellQuote("zai/glm-5.3-flash:max")).toBe("zai/glm-5.3-flash:max");
	});

	test.each([["rename `fetchUser` to `loadUser`"], ["$(id) and $HOME"], ["it's \"quoted\""], ["multi\nline"], ["semi; colon && pipe | redirect > file"], [""], ["*glob?"]])("%p round-trips through /bin/sh unchanged", async (s) => {
		const proc = Bun.spawn(["/bin/sh", "-c", `printf %s ${shellQuote(s)}`], { stdout: "pipe", stderr: "pipe" });
		const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(out).toBe(s);
	});

	test("formatCommand redacts the API key and quotes everything else", () => {
		const line = formatCommand({ TYPESAFE_API_KEY: "secret", TYPESAFE_ROLE: "advisory", OTHER: "a b" }, ["-p", "x `y`"]);
		expect(line).not.toContain("secret");
		expect(line).toBe("TYPESAFE_API_KEY='<redacted>' TYPESAFE_ROLE=advisory OTHER='a b' omp -p 'x `y`'");
	});
});

describe("checkTelemetry: a cell must have run the treatment it claims", () => {
	const record = (decision: string, extra: Record<string, unknown> = {}) => ({ ts: "2026-01-01T00:00:00Z", role: "advisory", kind: "action", severity: "concern", decision, channel: "aside", defect: "none", ...extra });
	/** The `config` block the extension writes into its TYPESAFE_BENCH_LOG dump. */
	const config = (over: Record<string, unknown> = {}) => ({
		role: "advisory",
		phases: ["plan", "execute"],
		model: "jev-1.13.0",
		adversaryEnabled: true,
		reviewActions: true,
		reviewMessages: true,
		reviewTurns: true,
		ambiguityGateEnabled: true,
		...over,
	});
	const telemetry = (over: Record<string, unknown> = {}): TelemetryLog =>
		({
			role: "advisory",
			phases: ["plan", "execute"],
			stats: { errors: 0, historyDropped: 0 },
			usage: {},
			costUsd: 0,
			lastResolvedModel: "jev-1.13.0",
			history: [record("delivered")],
			ambiguity: { scores: [], asksObserved: 0 },
			historyDropped: 0,
			config: config(),
			...over,
		}) as unknown as TelemetryLog;
	const advisoryOn = { role: "advisory", gate: "on" } as const;
	const advisoryNoGate = { role: "advisory", gate: "off" } as const;
	const offCell = { role: "off", gate: "off" } as const;

	test("off baseline: no telemetry is correct", () => {
		expect(checkTelemetry(offCell, null)).toEqual({ infraReasons: [], warnings: [], effectiveConfig: null });
	});

	test("off baseline: any telemetry means the extension ran (the old 'off' always did)", () => {
		expect(checkTelemetry(offCell, telemetry({ config: config({ role: "off", adversaryEnabled: false, ambiguityGateEnabled: false }) })).infraReasons).toEqual(["off_extension_loaded"]);
	});

	test("off baseline whose extension ran the gate is called out separately", () => {
		expect(checkTelemetry(offCell, telemetry({ config: config({ role: "off", adversaryEnabled: false, ambiguityGateEnabled: true }) })).infraReasons).toEqual(["off_extension_loaded", "off_gate_on"]);
		// a dump with no config block: gate scores are the evidence
		const scored = telemetry({ config: undefined, ambiguity: { scores: [{ decision: "none" }], asksObserved: 0 } });
		expect(checkTelemetry(offCell, scored).infraReasons).toEqual(["off_extension_loaded", "off_gate_on"]);
		expect(checkTelemetry(offCell, telemetry({ config: undefined })).infraReasons).toEqual(["off_extension_loaded"]);
	});

	test("treatment: no telemetry means the extension never loaded", () => {
		expect(checkTelemetry(advisoryOn, null).infraReasons).toEqual(["extension_not_loaded"]);
	});

	test("a healthy treatment cell has no reasons and no warnings, and reports the extension's own config", () => {
		const r = checkTelemetry(advisoryOn, telemetry());
		expect(r.infraReasons).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.effectiveConfig).toEqual(config());
	});

	test("a dump with no config block (an older extension) is checked on what it does report", () => {
		const r = checkTelemetry(advisoryOn, telemetry({ config: undefined }));
		expect(r).toEqual({ infraReasons: [], warnings: [], effectiveConfig: null });
	});

	test("the reviewer reported disabled", () => {
		const r = checkTelemetry(advisoryOn, telemetry({ config: config({ adversaryEnabled: false }), history: [] }));
		expect(r.infraReasons).toEqual(["reviewer_disabled"]);
		expect(r.warnings).toEqual([]); // a disabled reviewer's empty history is explained, not a second finding
	});

	test("a review kind reported disabled is flagged too (the pinned bench config enables all three)", () => {
		for (const kind of ["reviewActions", "reviewMessages", "reviewTurns"]) {
			expect(checkTelemetry(advisoryOn, telemetry({ config: config({ [kind]: false }) })).infraReasons).toEqual(["reviewer_kind_disabled"]);
		}
	});

	test("config fields of the wrong type are ignored rather than trusted or coerced", () => {
		const t = telemetry({ config: config({ adversaryEnabled: "false", ambiguityGateEnabled: 0, role: 7, phases: ["plan", 2] }) });
		const r = checkTelemetry(advisoryOn, t);
		expect(r.infraReasons).toEqual([]);
		expect(r.effectiveConfig).toEqual({ model: "jev-1.13.0", reviewActions: true, reviewMessages: true, reviewTurns: true });
	});

	test("a reported role that differs from the cell's role", () => {
		expect(checkTelemetry(advisoryOn, telemetry({ role: "adversarial" })).infraReasons).toEqual(["role_mismatch"]);
		expect(checkTelemetry(advisoryOn, telemetry({ role: undefined, config: config({ role: "adversarial" }) })).infraReasons).toEqual(["role_mismatch"]);
	});

	test("the gate ran when the cell said it was off, or was off when the cell said on", () => {
		expect(checkTelemetry(advisoryNoGate, telemetry()).infraReasons).toEqual(["gate_mismatch"]);
		expect(checkTelemetry(advisoryOn, telemetry({ config: config({ ambiguityGateEnabled: false }) })).infraReasons).toEqual(["gate_mismatch"]);
		expect(checkTelemetry(advisoryNoGate, telemetry({ config: config({ ambiguityGateEnabled: false }) })).infraReasons).toEqual([]);
		// without a config block the presence of gate scores is the evidence; their absence proves nothing
		const scored = telemetry({ config: undefined, ambiguity: { scores: [{ decision: "none" }], asksObserved: 0 } });
		expect(checkTelemetry(advisoryNoGate, scored).infraReasons).toEqual(["gate_mismatch"]);
		expect(checkTelemetry(advisoryOn, scored).infraReasons).toEqual([]);
		expect(checkTelemetry(advisoryOn, telemetry({ config: undefined })).infraReasons).toEqual([]);
	});

	test("every review errored (a bad API key makes the treatment behave like off)", () => {
		expect(checkTelemetry(advisoryOn, telemetry({ history: [record("error"), record("error")], stats: { errors: 2 } })).infraReasons).toEqual(["reviewer_all_errors"]);
		expect(checkTelemetry(advisoryOn, telemetry({ history: [], stats: { errors: 3 } })).infraReasons).toEqual(["reviewer_all_errors"]);
	});

	test("some errors, or zero reviews, are warnings rather than disqualifying", () => {
		const some = checkTelemetry(advisoryOn, telemetry({ history: [record("delivered"), record("error")], stats: { errors: 1 } }));
		expect(some.infraReasons).toEqual([]);
		expect(some.warnings).toEqual(["reviewer_some_errors"]);
		const none = checkTelemetry(advisoryOn, telemetry({ history: [] }));
		expect(none.infraReasons).toEqual([]);
		expect(none.warnings).toEqual(["no_reviews"]);
	});
});

describe("gradeRowFields: how an execution grade is stored on a row", () => {
	test("a plain grade gets stable defaults for the optional grader fields", () => {
		expect(gradeRowFields({ score: 1, success: true, checks: { tests_pass: true } })).toEqual({
			success: true,
			score: 1,
			checks: { tests_pass: true },
			uncertain: [],
			graderFallback: false,
			gradeTimedOut: false,
			gradeDetails: null,
		});
	});

	test("uncertain checks, the regex fallback and details are kept; the grader's timedOut is gradeTimedOut, not the row's timedOut", () => {
		const stored = gradeRowFields({
			score: 0.5,
			success: false,
			checks: { tests_pass: false, grader_timeout: false },
			timedOut: true,
			uncertain: ["asked_or_stated_assumption"],
			graderFallback: true,
			details: { model: "jev-1.13.0" },
		});
		expect(stored).toMatchObject({ uncertain: ["asked_or_stated_assumption"], graderFallback: true, gradeTimedOut: true, gradeDetails: { model: "jev-1.13.0" } });
		expect(stored).not.toHaveProperty("timedOut");
	});
});

describe("deriveNoteAndTelemetryFields: what a run directory on disk says", () => {
	const T0 = "2026-01-01T00:00:0";
	const custom = (customType: string, n: number) => ({ type: "custom_message", customType, timestamp: `${T0}${n}Z` });
	const history = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: `${T0}${i % 10}Z`, role: "advisory", kind: "action", severity: "concern", decision: "delivered", channel: "aside", defect: "none" }));

	function runDir(opts: { session?: unknown[]; dump?: unknown }): string {
		const dir = makeTmp("derive");
		if (opts.session) {
			mkdirSync(join(dir, "sessions", "enc"), { recursive: true });
			writeFileSync(join(dir, "sessions", "enc", "s.jsonl"), `${opts.session.map((e) => JSON.stringify(e)).join("\n")}\n`);
		}
		if (opts.dump) writeFileSync(join(dir, "typesafe.json"), JSON.stringify(opts.dump));
		return dir;
	}
	const advisoryOn = { role: "advisory", gate: "on" } as const;

	test("a plan that was never approved is all plan phase, in the notes and in the telemetry history", async () => {
		const dir = runDir({
			session: [custom("plan-mode-context", 0), custom("ai.typesafe.advisory", 2), custom("ai.typesafe.ambiguity", 3)],
			dump: { role: "advisory", stats: {}, usage: {}, costUsd: 0, history: history(2).map(({ ts: _ts, ...h }) => h), config: { role: "advisory", adversaryEnabled: true, ambiguityGateEnabled: true } },
		});
		const d = await deriveNoteAndTelemetryFields(dir, "", advisoryOn, "plan");
		expect(d).toMatchObject({
			planApproved: false,
			planPhaseNotes: { "ai.typesafe.advisory": 1 },
			execPhaseNotes: {},
			gateNoteCount: 1,
			planPhaseSeverityCounts: { concern: 2 }, // no timestamps needed: nothing ran in exec mode
			execPhaseSeverityCounts: {},
			noteSeverityCounts: { concern: 2 },
			reviewCount: 2,
			reviewDecisionCounts: { delivered: 2 },
		});
		// noteCounts still lists every custom message, omp's own included; only the reviewer's feed the report
		expect(d.noteCounts).toEqual({ "plan-mode-context": 1, "ai.typesafe.advisory": 1, "ai.typesafe.ambiguity": 1 });
	});

	test("an approved plan splits on the handoff; the cell type is inferred from the session when not given (an old row)", async () => {
		const dir = runDir({
			session: [custom("plan-mode-context", 0), custom("ai.typesafe.advisory", 1), custom("plan-yolo-handoff", 5), custom("ai.typesafe.advisory", 7)],
			dump: { role: "advisory", stats: {}, usage: {}, costUsd: 0, history: [{ ...history(1)[0], ts: `${T0}1Z` }, { ...history(1)[0], ts: `${T0}7Z`, severity: "blocker" }] },
		});
		const d = await deriveNoteAndTelemetryFields(dir, "", advisoryOn);
		expect(d).toMatchObject({ planApproved: true, planPhaseNotes: { "ai.typesafe.advisory": 1 }, execPhaseNotes: { "ai.typesafe.advisory": 1 }, planPhaseSeverityCounts: { concern: 1 }, execPhaseSeverityCounts: { blocker: 1 } });
	});

	test("wouldAsk is a measurement only where the gate could act: plan cells with the gate on", async () => {
		const none = { ts: "2024-01-01T00:00:01Z", trigger: "plan_start", ambiguity: 0.1, dims: { goal: 1, constraints: 1, criteria: 1, context: 1 }, weakest: "goal", gap: "none", userCanAnswer: 0.1, decision: "none" };
		const dump = (gate: boolean, scores: unknown[] = [none]) => ({ role: "advisory", stats: {}, usage: {}, costUsd: 0, history: [], ambiguity: { scores, asksObserved: 0 }, config: { role: "advisory", adversaryEnabled: true, ambiguityGateEnabled: gate } });
		const session = [custom("plan-mode-context", 0)];
		const planOn = await deriveNoteAndTelemetryFields(runDir({ session, dump: dump(true) }), "", { role: "advisory", gate: "on" }, "plan");
		const planOff = await deriveNoteAndTelemetryFields(runDir({ session, dump: dump(false, []) }), "", { role: "advisory", gate: "off" }, "plan");
		const execOn = await deriveNoteAndTelemetryFields(runDir({ session, dump: dump(true, []) }), "", { role: "advisory", gate: "on" }, "exec");
		expect(planOn.wouldAsk).toBe(false); // the gate scored and found nothing to ask: a real zero
		expect(planOn.harnessWarnings).not.toContain("gate_no_scores");
		expect(planOff.wouldAsk).toBeNull();
		expect(execOn.wouldAsk).toBeNull();
		expect(planOff.harnessWarnings).not.toContain("gate_no_scores");
		expect(execOn.harnessWarnings).not.toContain("gate_no_scores");
		// a backfilled row has no expectation: the extension's own report of its gate decides
		const reportedOff = await deriveNoteAndTelemetryFields(runDir({ session, dump: dump(false, []) }), "", null, "plan");
		expect(reportedOff.wouldAsk).toBeNull();
	});

	// The extension logs a score for every evaluation that completed; none at all means scoring failed or timed out,
	// there was no API key, or plan mode was never reached. That is a missing measurement, not a zero.
	test("a plan cell whose gate could act but logged no score is n/a and says why, not 'did not ask'", async () => {
		const dump = { role: "advisory", stats: {}, usage: {}, costUsd: 0, history: [], ambiguity: { scores: [], asksObserved: 0 }, config: { role: "advisory", adversaryEnabled: true, ambiguityGateEnabled: true } };
		const d = await deriveNoteAndTelemetryFields(runDir({ session: [custom("plan-mode-context", 0)], dump }), "", { role: "advisory", gate: "on" }, "plan");
		expect(d.wouldAsk).toBeNull();
		expect(d.harnessWarnings).toContain("gate_no_scores");
		expect(d.telemetryInfraReasons).toEqual([]);
	});

	test("a run with no typesafe.json says null everywhere the report keys off, never an empty object", async () => {
		const d = await deriveNoteAndTelemetryFields(runDir({ session: [custom("plan-mode-context", 0)] }), "", { role: "off", gate: "off" }, "exec");
		expect(d).toMatchObject({
			noteSeverityCounts: null,
			noteChannelCounts: null,
			noteSuppressedCounts: null,
			reviewDecisionCounts: null,
			reviewCount: null,
			planPhaseSeverityCounts: null,
			execPhaseSeverityCounts: null,
			historyDropped: null,
			historyTruncated: null,
			typesafeCostUsd: null,
			jevModel: null,
			reviewerStats: null,
			effectiveConfig: null,
			wouldAsk: null,
			telemetryInfraReasons: [],
		});
	});

	test("the dump's own drop counters decide truncation, whichever field carries them", async () => {
		const longHistory = history(60);
		const viaStats = await deriveNoteAndTelemetryFields(runDir({ dump: { role: "advisory", stats: { historyDropped: 12 }, usage: {}, costUsd: 0, history: longHistory } }), "", advisoryOn, "exec");
		expect(viaStats).toMatchObject({ historyDropped: 12, historyTruncated: true });
		const viaTopLevel = await deriveNoteAndTelemetryFields(runDir({ dump: { role: "advisory", stats: { historyDropped: 0 }, historyDropped: 0, usage: {}, costUsd: 0, history: longHistory } }), "", advisoryOn, "exec");
		expect(viaTopLevel).toMatchObject({ historyDropped: 0, historyTruncated: false });
		// a dump from before the counters existed: 60 records could be a full 50-record ring
		const legacy = await deriveNoteAndTelemetryFields(runDir({ dump: { role: "advisory", stats: {}, usage: {}, costUsd: 0, history: longHistory } }), "", advisoryOn, "exec");
		expect(legacy).toMatchObject({ historyDropped: null, historyTruncated: true });
	});

	test("usage comes from the session's assistant messages, else from stdout", async () => {
		const stdout = `${JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.001 } } } })}\n`;
		const session = [{ type: "message", message: { role: "assistant", usage: { totalTokens: 120, cost: { total: 0.01 } } } }];
		expect(await deriveNoteAndTelemetryFields(runDir({ session }), stdout, advisoryOn, "exec")).toMatchObject({ mainTokens: 120, mainCostUsd: 0.01 });
		expect(await deriveNoteAndTelemetryFields(runDir({}), stdout, advisoryOn, "exec")).toMatchObject({ mainTokens: 10, mainCostUsd: 0.001 });
	});

	test("it reports what omp's own max-time abort looks like, and the cross-check against the cell", async () => {
		const aborted = `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Deadline exceeded" } })}\n`;
		expect((await deriveNoteAndTelemetryFields(runDir({}), aborted, { role: "off", gate: "off" }, "exec")).hitMaxTime).toBe(true);
		const leaked = await deriveNoteAndTelemetryFields(runDir({ dump: { role: "off", stats: {}, usage: {}, costUsd: 0, history: [], config: { ambiguityGateEnabled: true } } }), "", { role: "off", gate: "off" }, "exec");
		expect(leaked.telemetryInfraReasons).toEqual(["off_extension_loaded", "off_gate_on"]);
		expect(leaked.effectiveConfig).toEqual({ ambiguityGateEnabled: true });
	});
});

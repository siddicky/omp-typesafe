import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXTENSION_ENTRY } from "../../bench/run";
import { renderProvenanceWarnings } from "../../bench/report";
import { cleanupTmp, makeHome, makePath, makeRepoCopy, makeTmp, REPO, runBench, writeFakeOmp } from "./helpers";

afterAll(cleanupTmp);

/**
 * End-to-end: bench/run.ts as a subprocess against a fake `omp` on PATH, with a throwaway HOME. Nothing
 * here touches the network, a real omp, or the user's config. Exec cells only (plan cells would call the judge).
 */

const T = 90_000;
type Row = Record<string, any>;
interface LogEntry {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	start: number;
	end: number;
}

function fakeBin(): string {
	return dirname(writeFakeOmp(makeTmp("fakebin")));
}

function runDirOf(resultsRoot: string): string {
	const ids = readdirSync(resultsRoot);
	expect(ids).toHaveLength(1);
	return join(resultsRoot, ids[0]);
}

function readRows(runDir: string): Row[] {
	return readFileSync(join(runDir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

function readLog(file: string): LogEntry[] {
	return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const base = (results: string) => ["--reps", "1", "--tasks", "rename-callsite", "--types", "exec", "--results-dir", results];
const byRole = (rows: Row[], role: string, gate?: string) => rows.filter((r) => r.role === role && (gate === undefined || r.gate === gate));

describe("--dry-run prints commands and touches nothing (bench_ci-dry-run-writes-and-crashes)", () => {
	test("twice in a row: both succeed and no directory, fixture copy or git commit is ever created", async () => {
		const home = makeHome();
		const results = makeTmp("res");
		const bin = fakeBin();
		for (let i = 0; i < 2; i++) {
			const r = await runBench([...base(results), "--dry-run"], { home, fakeBin: bin });
			expect(r.stderr).not.toContain("command failed");
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("# rename-callsite-off-exec-0");
			expect(r.stdout).toContain("# rename-callsite-adversarial-exec-0");
		}
		expect(readdirSync(results)).toEqual([]);
	}, T);

	test("a printed command can be pasted into a shell: backticks in the prompt stay inert", async () => {
		const home = makeHome();
		const bin = fakeBin();
		const dry = await runBench([...base(makeTmp("res")), "--roles", "off", "--dry-run"], { home, fakeBin: bin });
		const line = dry.stdout.split("\n").find((l) => l.includes(" omp "));
		expect(line).toBeDefined();
		const log = join(makeTmp("log"), "log.jsonl");
		const proc = Bun.spawn(["/bin/sh", "-c", line!], { env: { PATH: makePath(bin), HOME: home, FAKE_OMP_LOG: log, FAKE_OMP_SLEEP_MS: "0" }, stdout: "pipe", stderr: "pipe" });
		const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		// With double-quoted JSON.stringify output, `fetchUser` ran as command substitution: "fetchUser: command not found".
		expect(stderr).not.toContain("command not found");
		const spec = JSON.parse(readFileSync(join(REPO, "bench", "tasks", "rename-callsite", "task.json"), "utf8"));
		expect(readLog(log)[0].argv.at(-1)).toBe(spec.execPrompt);
	}, T);
});

describe("argument validation exits before running anything (bench_ci-arg-validation)", () => {
	test.each([
		[["--concurrency", "abc"], /--concurrency must be an integer >= 1/],
		[["--roles", "off,advisory,adverserial"], /unknown value 'adverserial'/],
		[["--types", "execute"], /unknown value 'execute'/],
		[["--tasks", "verify-claim,rename-calsite"], /unknown task 'rename-calsite'/],
		[["--max-time", "banana"], /--max-time must look like/],
	])("%p exits 2 with a usage message and creates no results", async (args, message) => {
		const results = makeTmp("res");
		const r = await runBench([...args, "--results-dir", results], { home: makeHome(), fakeBin: fakeBin(), env: { TYPESAFE_API_KEY: "k" } });
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(message);
		expect(r.stderr).toContain("usage: bun run bench/run.ts");
		expect(r.stdout).not.toContain("Wrote");
		expect(readdirSync(results)).toEqual([]);
	}, T);
});

describe("a full matrix against a fake omp", () => {
	test("cells are hermetic, run in parallel, and produce clean rows", async () => {
		const home = makeHome();
		const results = makeTmp("res");
		const log = join(makeTmp("log"), "log.jsonl");
		const r = await runBench([...base(results), "--roles", "off,advisory", "--gates", "on,off", "--concurrency", "3"], {
			home,
			fakeBin: fakeBin(),
			env: {
				FAKE_OMP_LOG: log,
				FAKE_OMP_SLEEP_MS: "1500",
				TYPESAFE_API_KEY: "k-from-env",
				// stray variables from the invoking shell: none of them may reach a cell
				TYPESAFE_ROLE: "adversarial",
				TYPESAFE_AMBIGUITY_THRESHOLD: "0.99",
				TYPESAFE_CONFIG: "/users/own/typesafe.json",
			},
		});
		expect(r.stderr).not.toContain("error");
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Wrote 3 rows");
		expect(r.stdout).toContain("ignoring inherited TYPESAFE_AMBIGUITY_THRESHOLD, TYPESAFE_CONFIG, TYPESAFE_ROLE");

		const runDir = runDirOf(results);
		const rows = readRows(runDir);
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.infraFailure).toBe(false);
			expect(row.infraReasons).toEqual([]);
			expect(row.exitCode).toBe(0);
			expect(row.extensionHead).toMatch(/^[0-9a-f]{40}$/);
		}
		expect(rows.map((x) => `${x.role}/${x.gate}`).sort()).toEqual(["advisory/off", "advisory/on", "off/off"]);

		// --concurrency 3 means three omp processes in flight at once (spawnSync serialized them).
		const entries = readLog(log);
		expect(entries).toHaveLength(3);
		expect(Math.max(...entries.map((e) => e.start))).toBeLessThan(Math.min(...entries.map((e) => e.end)));

		for (const e of entries) {
			expect(e.argv).toContain("--no-extensions");
			expect(e.argv).toContain("--no-skills");
			expect(e.argv).toContain("--no-rules");
			expect(e.argv).toContain("--no-prewalk");
			expect(e.env.TYPESAFE_CONFIG).toBe(join(REPO, "bench", "typesafe.bench.json"));
			expect(e.env.TYPESAFE_AMBIGUITY_THRESHOLD).toBeUndefined();
		}
		const off = entries.filter((e) => !e.argv.includes("-e"));
		const treated = entries.filter((e) => e.argv.includes("-e"));
		expect(off).toHaveLength(1);
		expect(treated).toHaveLength(2);
		expect(off[0].env).toMatchObject({ TYPESAFE_REVIEW_ENABLED: "0", TYPESAFE_AMBIGUITY_GATE: "0" });
		expect(off[0].env.TYPESAFE_ROLE).toBeUndefined();
		expect(off[0].env.TYPESAFE_API_KEY).toBeUndefined();
		for (const e of treated) {
			expect(e.argv[e.argv.indexOf("-e") + 1]).toBe(EXTENSION_ENTRY);
			expect(e.env).toMatchObject({ TYPESAFE_ROLE: "advisory", TYPESAFE_REVIEW_ENABLED: "1", TYPESAFE_API_KEY: "k-from-env" });
		}
		expect(treated.map((e) => e.env.TYPESAFE_AMBIGUITY_GATE).sort()).toEqual(["0", "1"]);

		const [advisoryOn] = byRole(rows, "advisory", "on");
		expect(advisoryOn.effectiveConfig).toMatchObject({ role: "advisory", adversaryEnabled: true, ambiguityGateEnabled: true });
		expect(advisoryOn.reviewerStats).not.toBeNull();
		expect(byRole(rows, "off")[0].reviewerStats).toBeNull();

		const runMeta = JSON.parse(readFileSync(join(runDir, "run-meta.json"), "utf8"));
		expect(runMeta).toMatchObject({ ompVersion: "omp/0.0.0-fake", apiKeySource: "env", cells: 3 });
		expect(runMeta.provenance.head).toMatch(/^[0-9a-f]{40}$/);
		expect(runMeta.strippedInheritedEnv.sort()).toEqual(["TYPESAFE_AMBIGUITY_THRESHOLD", "TYPESAFE_CONFIG", "TYPESAFE_ROLE"]);

		const cellMetaPath = join(runDir, "runs", "rename-callsite-advisory-exec-0", "meta.json");
		const cellMetaText = readFileSync(cellMetaPath, "utf8");
		expect(cellMetaText).not.toContain("k-from-env");
		expect(JSON.parse(cellMetaText)).toMatchObject({
			env: { TYPESAFE_API_KEY: "<redacted>", TYPESAFE_ROLE: "advisory" },
			expected: { role: "advisory", gate: "on", extensionLoaded: true, extensionPath: EXTENSION_ENTRY },
			resolvedConfig: { role: "advisory", adversary: { enabled: true, reviewMessages: true }, ambiguityGate: { enabled: true } },
			effectiveConfig: { role: "advisory", adversaryEnabled: true, ambiguityGateEnabled: true },
			infraReasons: [],
		});

		const overlay = Bun.YAML.parse(readFileSync(join(runDir, "runs", "rename-callsite-off-exec-0", "overlay.yml"), "utf8")) as Record<string, any>;
		expect(overlay.disabledExtensions).toEqual(["skill:alpha", "extension-module:herdr"]);
		expect(overlay.memory).toEqual({ backend: "off" });
		expect(overlay.extensions).toEqual([]);
	}, T);
});

// A matrix takes hours on the checkout that is being developed, and each cell loads whatever is on disk when it starts.
describe("what a row says it measured is read when its cell starts", () => {
	test("an edit to the extension source or the pinned config mid-run shows in the later rows, and the report warns", async () => {
		const repo = makeRepoCopy();
		const results = makeTmp("res");
		const r = await runBench([...base(results), "--roles", "advisory", "--gates", "on,off", "--concurrency", "1"], {
			home: makeHome(),
			fakeBin: fakeBin(),
			repo,
			env: {
				TYPESAFE_API_KEY: "k",
				FAKE_OMP_SLEEP_MS: "0",
				FAKE_OMP_TOUCH: JSON.stringify([join(repo, "src", "index.ts"), join(repo, "bench", "typesafe.bench.json")]),
				FAKE_OMP_TOUCH_MARKER: join(makeTmp("marker"), "touched"),
			},
		});
		expect(r.code).toBe(0);
		const runDir = runDirOf(results);
		const rows = readRows(runDir);
		expect(rows).toHaveLength(2);
		const [before, after] = rows;
		// The first cell started on the clean checkout; the second started after the edit.
		expect(before).toMatchObject({ extensionDirty: false, extensionDiffSha: null });
		expect(after).toMatchObject({ extensionDirty: true });
		expect(after.extensionDiffSha).toMatch(/^[0-9a-f]{64}$/);
		expect(after.extensionHead).toBe(before.extensionHead);
		expect(after.benchConfigSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(after.benchConfigSha256).not.toBe(before.benchConfigSha256);

		const warnings = renderProvenanceWarnings(rows as any);
		for (const field of ["extensionDirty", "benchConfigSha256"]) expect(warnings).toContain(`disagree on ${field}`);

		// Each cell's own meta.json says the same, not the run-wide record taken at the start.
		const metaOf = (row: Row) => JSON.parse(readFileSync(join(row.dir, "meta.json"), "utf8"));
		expect(metaOf(before).provenance.dirty).toBe(false);
		expect(metaOf(after).provenance).toMatchObject({ dirty: true, diffSha: after.extensionDiffSha });
		expect(metaOf(after).benchConfigSha256).toBe(after.benchConfigSha256);
		expect(JSON.parse(readFileSync(join(runDir, "run-meta.json"), "utf8")).provenance.dirty).toBe(false);
	}, T);

	test("without an edit every row agrees and the report has nothing to warn about", async () => {
		const results = makeTmp("res");
		await runBench([...base(results), "--roles", "advisory", "--gates", "on,off", "--concurrency", "1"], {
			home: makeHome(),
			fakeBin: fakeBin(),
			repo: makeRepoCopy(),
			env: { TYPESAFE_API_KEY: "k", FAKE_OMP_SLEEP_MS: "0" },
		});
		const rows = readRows(runDirOf(results));
		expect(rows).toHaveLength(2);
		expect(renderProvenanceWarnings(rows as any)).toBe("");
		expect(rows[0].benchConfigSha256).toMatch(/^[0-9a-f]{64}$/);
	}, T);
});

// `bun run bench/run.ts` puts <repo>/node_modules/.bin first on PATH, where the devDependency pins its own omp.
describe("the omp that is measured is resolved, not looked up by name", () => {
	/** A repo copy whose node_modules/.bin holds an omp of another version, which must never be what runs. */
	function repoWithShim(): { repo: string; shimDir: string } {
		const repo = makeRepoCopy();
		const shimDir = join(repo, "node_modules", ".bin");
		mkdirSync(shimDir, { recursive: true });
		const shim = join(shimDir, "omp");
		writeFileSync(shim, "#!/bin/sh\necho omp/9.9.9-devdependency\nexit 9\n");
		chmodSync(shim, 0o755);
		return { repo, shimDir };
	}

	test("with the shim directory first on PATH, as under `bun run`, the omp installed on the machine still runs", async () => {
		const { repo, shimDir } = repoWithShim();
		const installed = fakeBin();
		const results = makeTmp("res");
		const log = join(makeTmp("log"), "log.jsonl");
		const r = await runBench([...base(results), "--roles", "off"], { home: makeHome(), fakeBin: `${shimDir}:${installed}`, repo, env: { FAKE_OMP_LOG: log, FAKE_OMP_SLEEP_MS: "0" } });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("omp/0.0.0-fake");
		const meta = JSON.parse(readFileSync(join(runDirOf(results), "run-meta.json"), "utf8"));
		expect(meta).toMatchObject({ ompVersion: "omp/0.0.0-fake", ompPath: join(installed, "omp"), ompSource: "PATH" });
		expect(readLog(log)).toHaveLength(1);
		expect(readRows(runDirOf(results))[0]).toMatchObject({ exitCode: 0, infraFailure: false });
	}, T);

	test("OMP_BIN names the omp explicitly, and run-meta records it", async () => {
		const { repo, shimDir } = repoWithShim();
		const chosen = fakeBin();
		const results = makeTmp("res");
		const r = await runBench([...base(results), "--roles", "off"], { home: makeHome(), fakeBin: shimDir, repo, env: { OMP_BIN: join(chosen, "omp"), FAKE_OMP_SLEEP_MS: "0" } });
		expect(r.code).toBe(0);
		const meta = JSON.parse(readFileSync(join(runDirOf(results), "run-meta.json"), "utf8"));
		expect(meta).toMatchObject({ ompVersion: "omp/0.0.0-fake", ompPath: join(chosen, "omp"), ompSource: "OMP_BIN" });
	}, T);

	test("an OMP_BIN that is not there aborts before any cell", async () => {
		const results = makeTmp("res");
		const r = await runBench([...base(results), "--roles", "off"], { home: makeHome(), fakeBin: fakeBin(), env: { OMP_BIN: "/nonexistent/omp" } });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("OMP_BIN=/nonexistent/omp was not found");
		expect(readdirSync(results)).toEqual([]);
	}, T);
});

describe("infrastructure failures are recorded as such (bench_ci-silent-infra-failures)", () => {
	test("an extension that never loads flags every treatment row and fails the run", async () => {
		const results = makeTmp("res");
		const r = await runBench([...base(results), "--roles", "advisory"], { home: makeHome(), fakeBin: fakeBin(), env: { TYPESAFE_API_KEY: "k", FAKE_OMP_MODE: "no-extension", FAKE_OMP_SLEEP_MS: "0" } });
		const rows = readRows(runDirOf(results));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ infraFailure: true, infraReasons: ["extension_not_loaded"] });
		expect(r.stdout).toContain("INFRA[extension_not_loaded]");
		expect(r.stdout).toContain("1 of 1 rows are infrastructure failures");
		expect(r.code).toBe(1);
	}, T);

	test("an off baseline that wrote telemetry is flagged as a leak, without failing the whole run", async () => {
		const results = makeTmp("res");
		const r = await runBench([...base(results), "--roles", "off,advisory"], { home: makeHome(), fakeBin: fakeBin(), env: { TYPESAFE_API_KEY: "k", FAKE_OMP_MODE: "leak", FAKE_OMP_SLEEP_MS: "0" } });
		const rows = readRows(runDirOf(results));
		expect(byRole(rows, "off")[0]).toMatchObject({ infraFailure: true, infraReasons: ["off_extension_loaded"] });
		expect(byRole(rows, "advisory")[0]).toMatchObject({ infraFailure: false });
		expect(r.code).toBe(0);
	}, T);

	test("a reviewer reported disabled is flagged", async () => {
		const results = makeTmp("res");
		await runBench([...base(results), "--roles", "adversarial"], { home: makeHome(), fakeBin: fakeBin(), env: { TYPESAFE_API_KEY: "k", FAKE_OMP_MODE: "disabled", FAKE_OMP_SLEEP_MS: "0" } });
		expect(readRows(runDirOf(results))[0].infraReasons).toEqual(["reviewer_disabled"]);
	}, T);

	test("omp exiting nonzero is an infrastructure failure, but omp stopping at --max-time is a normal outcome", async () => {
		const failResults = makeTmp("res");
		const fail = await runBench([...base(failResults), "--roles", "off"], { home: makeHome(), fakeBin: fakeBin(), env: { FAKE_OMP_MODE: "fail", FAKE_OMP_SLEEP_MS: "0" } });
		expect(readRows(runDirOf(failResults))[0]).toMatchObject({ exitCode: 3, infraFailure: true, infraReasons: ["nonzero_exit"] });
		expect(fail.code).toBe(1);

		const slowResults = makeTmp("res");
		const slow = await runBench([...base(slowResults), "--roles", "off"], { home: makeHome(), fakeBin: fakeBin(), env: { FAKE_OMP_MODE: "max-time", FAKE_OMP_SLEEP_MS: "0" } });
		expect(readRows(runDirOf(slowResults))[0]).toMatchObject({ exitCode: 1, hitMaxTime: true, infraFailure: false, infraReasons: [] });
		expect(slow.code).toBe(0);
	}, T);

	test("omp missing from PATH aborts before any cell instead of recording graded-untouched-fixture rows", async () => {
		const results = makeTmp("res");
		const r = await runBench([...base(results), "--roles", "off"], { home: makeHome(), env: {} });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("omp is not runnable");
		expect(readdirSync(results)).toEqual([]);
	}, T);

	test("treatment cells without a TYPESAFE_API_KEY abort; an off-only matrix does not need one", async () => {
		const home = makeHome();
		const bin = fakeBin();
		const results = makeTmp("res");
		const treated = await runBench([...base(results), "--roles", "advisory"], { home, fakeBin: bin });
		expect(treated.code).toBe(1);
		expect(treated.stderr).toContain("TYPESAFE_API_KEY is not set");
		expect(readdirSync(results)).toEqual([]);

		const offOnly = await runBench([...base(makeTmp("res")), "--roles", "off"], { home, fakeBin: bin, env: { FAKE_OMP_SLEEP_MS: "0" } });
		expect(offOnly.code).toBe(0);
	}, T);

	test("an inline comment in the secrets file is not sent as part of the key, and the file source is reported", async () => {
		const home = makeHome({ secrets: "# secrets\nexport TYPESAFE_API_KEY=abc123 # prod key\n" });
		const results = makeTmp("res");
		const log = join(makeTmp("log"), "log.jsonl");
		const r = await runBench([...base(results), "--roles", "advisory"], { home, fakeBin: fakeBin(), env: { FAKE_OMP_LOG: log, FAKE_OMP_SLEEP_MS: "0" } });
		expect(r.code).toBe(0);
		expect(readLog(log)[0].env.TYPESAFE_API_KEY).toBe("abc123");
		expect(JSON.parse(readFileSync(join(runDirOf(results), "run-meta.json"), "utf8")).apiKeySource).toBe("file");
		expect(r.stdout).toContain("TYPESAFE_API_KEY from file");
	}, T);
});

describe("one failing cell does not take down the matrix", () => {
	test("a thrown cell becomes a flagged error row; the others finish; --regrade skips it", async () => {
		const home = makeHome();
		const bin = fakeBin();
		const realGit = Bun.which("git");
		expect(realGit).not.toBeNull();
		// The first `git commit` (a fixture's seed commit) fails; every other git call is real.
		const mark = join(makeTmp("mark"), "failed-once");
		writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n\tif [ "$a" = commit ] && mkdir "${mark}" 2>/dev/null; then echo "boom: simulated git failure" >&2; exit 1; fi\ndone\nexec ${realGit} "$@"\n`);
		chmodSync(join(bin, "git"), 0o755);

		const results = makeTmp("res");
		const r = await runBench(["--reps", "3", "--tasks", "rename-callsite", "--types", "exec", "--roles", "off", "--concurrency", "1", "--results-dir", results], { home, fakeBin: bin, env: { FAKE_OMP_SLEEP_MS: "0" } });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Wrote 3 rows");
		const runDir = runDirOf(results);
		const rows = readRows(runDir);
		expect(rows).toHaveLength(3);
		const broken = rows.filter((x) => x.infraReasons.includes("cell_exception"));
		expect(broken).toHaveLength(1);
		expect(broken[0]).toMatchObject({ infraFailure: true, success: false, score: 0 });
		expect(broken[0].error).toContain("boom: simulated git failure");
		expect(rows.filter((x) => x.infraFailure === false)).toHaveLength(2);

		const regrade = await runBench(["--regrade", runDir], { home, fakeBin: bin });
		expect(regrade.code).toBe(0);
		expect(JSON.parse(regrade.stdout)).toMatchObject({ total: 2, regraded: 2 });
		const after = readRows(runDir);
		expect(after.filter((x) => x.infraReasons.includes("cell_exception"))).toHaveLength(1);
	}, T);

	test("--regrade recomputes infrastructure flags for rows written before they existed", async () => {
		const home = makeHome();
		const results = makeTmp("res");
		await runBench([...base(results), "--roles", "off"], { home, fakeBin: fakeBin(), env: { FAKE_OMP_MODE: "leak", FAKE_OMP_SLEEP_MS: "0" } });
		const runDir = runDirOf(results);
		const stripped = readRows(runDir).map(({ infraReasons: _a, infraFailure: _b, harnessWarnings: _c, gate: _d, ...old }) => old);
		writeFileSync(join(runDir, "runs.jsonl"), `${stripped.map((x) => JSON.stringify(x)).join("\n")}\n`);
		const regrade = await runBench(["--regrade", runDir], { home });
		expect(regrade.code).toBe(0);
		expect(readRows(runDir)[0]).toMatchObject({ infraFailure: true, infraReasons: ["off_extension_loaded"] });
	}, T);
});

// A row's harnessWarnings hold the telemetry warnings a regrade re-derives, and the two that only the live run's grading
// side could add: `plan_grade_threw` (the plan side is not regraded) and `grader_threw`.
describe("--regrade and the warnings of the live run's grading", () => {
	async function liveRun(): Promise<{ home: string; runDir: string }> {
		const home = makeHome();
		const results = makeTmp("res");
		await runBench([...base(results), "--roles", "off"], { home, fakeBin: fakeBin(), env: { FAKE_OMP_SLEEP_MS: "0" } });
		return { home, runDir: runDirOf(results) };
	}
	const rewrite = (runDir: string, change: (row: Row) => Row) => writeFileSync(join(runDir, "runs.jsonl"), `${readRows(runDir).map((r) => JSON.stringify(change(r))).join("\n")}\n`);

	test("plan_grade_threw survives, and a grader_threw that this regrade's own grade replaces does not", async () => {
		const { home, runDir } = await liveRun();
		rewrite(runDir, (r) => ({ ...r, harnessWarnings: ["plan_grade_threw", "grader_threw"] }));
		const regrade = await runBench(["--regrade", runDir], { home });
		expect(regrade.code).toBe(0);
		expect(JSON.parse(regrade.stdout)).toMatchObject({ total: 1, regraded: 1 });
		expect(readRows(runDir)[0].harnessWarnings).toEqual(["plan_grade_threw"]);
	}, T);

	test("a grader that throws during the regrade is recorded, whatever the row held before", async () => {
		const { home, runDir } = await liveRun();
		rewrite(runDir, (r) => ({ ...r, task: "no-such-task", harnessWarnings: ["plan_grade_threw"] }));
		const regrade = await runBench(["--regrade", runDir], { home });
		expect(regrade.code).toBe(0);
		expect(JSON.parse(regrade.stdout)).toMatchObject({ total: 1, regraded: 0 });
		expect(readRows(runDir)[0].harnessWarnings).toEqual(["plan_grade_threw", "grader_threw"]);
		// Once more: it is a warning, not a counter.
		await runBench(["--regrade", runDir], { home });
		expect(readRows(runDir)[0].harnessWarnings).toEqual(["plan_grade_threw", "grader_threw"]);
	}, T);

	test("a row with no warnings stays empty, and the telemetry warnings are still re-derived", async () => {
		const { home, runDir } = await liveRun();
		rewrite(runDir, (r) => ({ ...r, harnessWarnings: ["stale_telemetry_warning"] }));
		await runBench(["--regrade", runDir], { home });
		expect(readRows(runDir)[0].harnessWarnings).toEqual([]);
	}, T);
});

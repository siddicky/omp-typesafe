import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermeticEnv, ompHitMaxTime, parseDuration, processInfraReasons, resolveOmp, runOmp, runProcess, subprocessTimeoutMs } from "../../bench/lib/omp-run";
import { cleanupTmp, makeTmp } from "./helpers";

afterAll(cleanupTmp);

const CWD = process.cwd();

describe("runOmp is asynchronous (bench_ci-concurrency-serialized)", () => {
	test("concurrent runs overlap instead of running one at a time", async () => {
		const dir = makeTmp("conc");
		const log = join(dir, "log.jsonl");
		const script = join(dir, "fake.ts");
		writeFileSync(
			script,
			`import { appendFileSync } from "node:fs";
const start = Date.now();
await Bun.sleep(600);
appendFileSync(process.env.LOG!, JSON.stringify({ start, end: Date.now() }) + "\\n");
`,
		);
		// With spawnSync every call blocked the thread until omp exited, so run N could not start before run N-1 ended.
		const results = await Promise.all([1, 2, 3].map(() => runOmp([script], { bin: process.execPath, cwd: CWD, env: { LOG: log }, timeoutMs: 30_000 })));
		for (const r of results) expect(r.exitCode).toBe(0);
		const spans = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { start: number; end: number });
		expect(spans).toHaveLength(3);
		expect(Math.max(...spans.map((s) => s.start))).toBeLessThan(Math.min(...spans.map((s) => s.end)));
	});

	test("captures stdout, stderr, exit code, argv and merges env overrides", async () => {
		const dir = makeTmp("io");
		const script = join(dir, "fake.ts");
		writeFileSync(script, `console.log(JSON.stringify({ argv: process.argv.slice(2), mark: process.env.MARK }));\nconsole.error("warn");\nprocess.exit(7);\n`);
		const r = await runOmp([script, "a b", "--flag"], { bin: process.execPath, cwd: CWD, env: { MARK: "x" }, timeoutMs: 30_000 });
		expect(r.exitCode).toBe(7);
		expect(r.timedOut).toBe(false);
		expect(r.spawnError).toBeUndefined();
		expect(JSON.parse(r.stdout)).toEqual({ argv: ["a b", "--flag"], mark: "x" });
		expect(r.stderr).toBe("warn\n");
		expect(r.wallMs).toBeGreaterThanOrEqual(0);
	});
});

describe("runOmp timeouts and failures (bench_ci-silent-infra-failures)", () => {
	test("a missing executable is reported as spawnError, not thrown and not an ordinary failure", async () => {
		const r = await runOmp(["--version"], { bin: "definitely-not-an-omp-binary", cwd: CWD, env: {}, timeoutMs: 5_000 });
		expect(r.spawnError).toMatch(/not found|ENOENT/i);
		expect(r.exitCode).toBeNull();
		expect(r.timedOut).toBe(false);
		expect(processInfraReasons(r)).toEqual(["spawn_error"]);
	});

	test("a hung process is killed at the timeout and flagged timedOut, keeping partial output", async () => {
		const start = Date.now();
		const r = await runProcess(["/bin/sh", "-c", "echo partial; exec sleep 30"], { cwd: CWD, env: {}, timeoutMs: 300 });
		expect(r.timedOut).toBe(true);
		expect(r.stdout).toContain("partial");
		expect(r.signal).toBe("SIGTERM");
		expect(Date.now() - start).toBeLessThan(10_000);
		expect(processInfraReasons(r)).toEqual(["timeout"]);
	});

	test("a grandchild holding the pipes open does not hang the harness after the kill", async () => {
		// sh dies on SIGTERM but its background `sleep` keeps inheriting stdout/stderr; waiting for EOF would block ~3s.
		const start = Date.now();
		const r = await runProcess(["/bin/sh", "-c", "echo partial; sleep 3 & wait"], { cwd: CWD, env: {}, timeoutMs: 300, streamGraceMs: 200 });
		expect(r.timedOut).toBe(true);
		expect(r.stdout).toContain("partial");
		expect(Date.now() - start).toBeLessThan(2_500);
	});

	test("a process that ignores SIGTERM is escalated to SIGKILL", async () => {
		const start = Date.now();
		const r = await runProcess(["/bin/sh", "-c", "trap '' TERM; exec sleep 5"], { cwd: CWD, env: {}, timeoutMs: 200, killGraceMs: 200, streamGraceMs: 200 });
		expect(r.timedOut).toBe(true);
		expect(r.signal).toBe("SIGKILL");
		expect(Date.now() - start).toBeLessThan(2_500);
	});
});

describe("processInfraReasons", () => {
	test("a clean exit is not an infrastructure failure", () => {
		expect(processInfraReasons({ exitCode: 0, timedOut: false })).toEqual([]);
	});
	test("a nonzero exit is", () => {
		expect(processInfraReasons({ exitCode: 3, timedOut: false })).toEqual(["nonzero_exit"]);
	});
	test("a harness-killed run is a timeout, not also a nonzero exit", () => {
		expect(processInfraReasons({ exitCode: null, timedOut: true })).toEqual(["timeout"]);
	});
	test("a process that died to an external signal counts as a nonzero exit", () => {
		expect(processInfraReasons({ exitCode: null, timedOut: false })).toEqual(["nonzero_exit"]);
	});
	test("omp stopping itself at --max-time (exit 1, deadline abort) is a run outcome, not infrastructure", () => {
		expect(processInfraReasons({ exitCode: 1, timedOut: false, hitMaxTime: true })).toEqual([]);
	});
	test("missing fields on an old row are treated as a failure to prove success", () => {
		expect(processInfraReasons({ exitCode: undefined })).toEqual(["nonzero_exit"]);
	});
});

describe("ompHitMaxTime", () => {
	test("recognises omp's deadline abort in --mode json output", () => {
		const line = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Deadline exceeded" } });
		expect(ompHitMaxTime(`{"type":"agent_start"}\n${line}\n`)).toBe(true);
	});
	test("ignores ordinary output and other errors", () => {
		expect(ompHitMaxTime('{"type":"message_end","message":{"role":"assistant"}}')).toBe(false);
		expect(ompHitMaxTime('{"errorMessage":"rate limited"}')).toBe(false);
		expect(ompHitMaxTime("")).toBe(false);
	});
});

describe("hermeticEnv", () => {
	test("strips every inherited TYPESAFE_* variable, keeps the rest, applies overrides", () => {
		const out = hermeticEnv(
			{ PATH: "/bin", HOME: "/h", TYPESAFE_ROLE: "adversarial", TYPESAFE_CONFIG: "/user/typesafe.json", TYPESAFE_AMBIGUITY_THRESHOLD: "0.9", TYPESAFE_API_KEY: "inherited", GONE: undefined },
			{ TYPESAFE_ROLE: "advisory", TYPESAFE_API_KEY: "explicit" },
		);
		expect(out).toEqual({ PATH: "/bin", HOME: "/h", TYPESAFE_ROLE: "advisory", TYPESAFE_API_KEY: "explicit" });
	});

	describe("as applied to the child", () => {
		const saved: Record<string, string | undefined> = {};
		beforeEach(() => {
			for (const k of ["TYPESAFE_AMBIGUITY_THRESHOLD", "TYPESAFE_API_KEY"]) saved[k] = process.env[k];
			process.env.TYPESAFE_AMBIGUITY_THRESHOLD = "0.9";
			process.env.TYPESAFE_API_KEY = "inherited-key";
		});
		afterEach(() => {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		});

		test("a stray TYPESAFE_* in the invoking shell never reaches omp; explicit ones do", async () => {
			const dir = makeTmp("env");
			const script = join(dir, "fake.ts");
			writeFileSync(script, `console.log(JSON.stringify({ threshold: process.env.TYPESAFE_AMBIGUITY_THRESHOLD ?? null, key: process.env.TYPESAFE_API_KEY ?? null, role: process.env.TYPESAFE_ROLE ?? null }));\n`);
			const r = await runOmp([script], { bin: process.execPath, cwd: CWD, env: { TYPESAFE_ROLE: "advisory" }, timeoutMs: 30_000 });
			expect(JSON.parse(r.stdout)).toEqual({ threshold: null, key: null, role: "advisory" });
		});
	});
});

describe("duration helpers", () => {
	test("parseDuration accepts omp's --max-time spellings", () => {
		expect(parseDuration("600")).toBe(600_000);
		expect(parseDuration("90s")).toBe(90_000);
		expect(parseDuration("10m")).toBe(600_000);
		expect(parseDuration("1h")).toBe(3_600_000);
		expect(() => parseDuration("banana")).toThrow(/invalid duration/);
	});
	test("subprocessTimeoutMs keeps a 15 minute floor and a 5 minute margin", () => {
		expect(subprocessTimeoutMs("1m")).toBe(15 * 60_000);
		expect(subprocessTimeoutMs("1h")).toBe(65 * 60_000);
	});
});

// `bun run bench/run.ts` puts <repo>/node_modules/.bin first on PATH, and the repo pins the omp package as a
// devDependency for its types: a bare "omp" would measure that build, not the omp installed on the machine.
describe("resolveOmp picks the omp the README says the bench uses", () => {
	function exe(dir: string, name = "omp"): string {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, name);
		writeFileSync(path, "#!/bin/sh\nexit 0\n");
		chmodSync(path, 0o755);
		return path;
	}
	function layout() {
		const root = makeTmp("resolve");
		const repo = join(root, "repo");
		const shimDir = join(repo, "node_modules", ".bin");
		return { root, repo, shimDir, shim: exe(shimDir), installedDir: join(root, "installed") };
	}

	test("the omp installed on the machine wins over the repo's devDependency shim, whichever comes first on PATH", () => {
		const { repo, shimDir, shim, installedDir } = layout();
		const installed = exe(installedDir);
		expect(resolveOmp({ PATH: `${shimDir}:${installedDir}:/usr/bin` }, repo)).toEqual({ path: installed, source: "PATH" });
		expect(resolveOmp({ PATH: `${installedDir}:${shimDir}` }, repo)).toEqual({ path: installed, source: "PATH" });
		expect(shim).not.toBe(installed);
	});

	test("with no other omp on PATH the devDependency shim is used, and said to be", () => {
		const { repo, shimDir, shim } = layout();
		expect(resolveOmp({ PATH: `${shimDir}:/usr/bin` }, repo)).toEqual({ path: shim, source: "dev-dependency" });
	});

	test("a shim reached through a symlinked node_modules is still recognised", () => {
		const { root, installedDir } = layout();
		exe(join(root, "store", ".bin"));
		const linked = join(root, "linked-repo");
		mkdirSync(linked, { recursive: true });
		symlinkSync(join(root, "store"), join(linked, "node_modules"));
		const installed = exe(installedDir);
		expect(resolveOmp({ PATH: `${join(linked, "node_modules", ".bin")}:${installedDir}` }, linked)).toEqual({ path: installed, source: "PATH" });
	});

	test("OMP_BIN names the omp explicitly, by path or by name", () => {
		const { repo, shimDir, installedDir } = layout();
		const chosen = exe(join(installedDir, "pinned"), "omp-next");
		expect(resolveOmp({ PATH: shimDir, OMP_BIN: chosen }, repo)).toEqual({ path: chosen, source: "OMP_BIN" });
		expect(resolveOmp({ PATH: `${join(installedDir, "pinned")}:${shimDir}`, OMP_BIN: "omp-next" }, repo)).toEqual({ path: chosen, source: "OMP_BIN" });
	});

	test("an OMP_BIN that does not exist, and no omp anywhere, resolve to nothing instead of falling back silently", () => {
		const { repo, shimDir } = layout();
		expect(resolveOmp({ PATH: shimDir, OMP_BIN: "/nonexistent/omp" }, repo)).toBeNull();
		expect(resolveOmp({ PATH: "/usr/bin:/bin" }, repo)).toBeNull();
		expect(resolveOmp({}, repo)).toBeNull();
	});
});

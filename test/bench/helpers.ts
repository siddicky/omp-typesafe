import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Shared scaffolding for the bench-runner tests: temp dirs, a fake `omp`, and a subprocess runner for bench/run.ts. */

export const REPO = resolve(import.meta.dir, "..", "..");

const created: string[] = [];

export function makeTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `omp-typesafe-${prefix}-`));
	created.push(dir);
	return dir;
}

export function cleanupTmp(): void {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A `#!/usr/bin/env bun` shim that runs `script` (a file next to this one) with the caller's argv and env. */
function writeShim(dir: string, name: string, script: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(import.meta.dir, script))});\n`);
	chmodSync(path, 0o755);
	return path;
}

/**
 * A fake `omp` that leaves behind what a real run would: the extension's TYPESAFE_BENCH_LOG dump (when given
 * `-e`), a session JSONL, a plan for plan cells. Its behavior, per cell or per run, is driven by FAKE_OMP_*
 * env variables documented in fake-omp.ts.
 */
export function writeFakeOmp(dir: string): string {
	return writeShim(dir, "omp", "fake-omp.ts");
}

/** A fake `claude` standing in for the plan judge (see fake-claude.ts). */
export function writeFakeClaude(dir: string): string {
	return writeShim(dir, "claude", "fake-claude.ts");
}

export interface FakeJevRequest {
	state: unknown;
	questions: Record<string, { type?: string; [key: string]: unknown }>;
	model?: string;
}

export interface FakeJev {
	/** TYPESAFE_BASE_URL for a process that should talk to this server. */
	url: string;
	/** Every request body received, parsed. */
	calls: FakeJevRequest[];
	/** While true the server answers 401, like a bad API key. */
	reject: boolean;
	stop(): void;
}

/** Answers the graders' checklist: every noul 0.9, or 0.5 (inside the uncertainty band) for `c0` when the state contains "[jev-uncertain]". */
function gradingAnswers(req: FakeJevRequest): Record<string, unknown> {
	const uncertain = JSON.stringify(req.state).includes("[jev-uncertain]");
	return Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul", noul: uncertain && id === "c0" ? 0.5 : 0.9, confidence: 0.9 }]));
}

/**
 * A loopback stand-in for the TypeSafe API (POST /v1/systemone), for tests that run code in a subprocess where
 * the in-process client mock cannot reach. `answers` decides the reply to each request (default: the grading
 * answers above). Nothing leaves the machine.
 */
export function startFakeJev(answers: (req: FakeJevRequest) => Record<string, unknown> = gradingAnswers): FakeJev {
	const calls: FakeJevRequest[] = [];
	const jev: FakeJev = { url: "", calls, reject: false, stop: () => {} };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const body = (await req.json()) as FakeJevRequest;
			calls.push(body);
			if (jev.reject) return Response.json({ error: { type: "authentication_error", message: "invalid api key" } }, { status: 401 });
			return Response.json({ model: "jev-fake-1", answers: answers(body), usage: { input_tokens: 5, output_tokens: 0 } }, { headers: { "x-request-id": `fake-${calls.length}` } });
		},
	});
	jev.url = `http://127.0.0.1:${server.port}`;
	jev.stop = () => void server.stop(true);
	return jev;
}

/** A $HOME with a representative ~/.omp/agent/config.yml and an optional secrets file. */
export function makeHome(opts: { secrets?: string } = {}): string {
	const home = makeTmp("home");
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".omp", "agent", "config.yml"),
		["modelRoles:", "  default: fake/model:high", "  smol: fake/small", "disabledExtensions:", '  - "skill:alpha"', "  - extension-module:herdr", "memory:", "  backend: mnemopi", ""].join("\n"),
	);
	if (opts.secrets !== undefined) {
		mkdirSync(join(home, ".config"), { recursive: true });
		writeFileSync(join(home, ".config", "agent-secrets.env"), opts.secrets);
	}
	return home;
}

/** A PATH holding only `bun` (plus system dirs) and, optionally, a fake-omp dir first: a real omp elsewhere can never be found. */
export function makePath(fakeBin?: string): string {
	const binDir = makeTmp("bin");
	symlinkSync(process.execPath, join(binDir, "bun"));
	return [fakeBin, binDir, "/usr/bin", "/bin"].filter(Boolean).join(":");
}

/**
 * A committed copy of the bench harness and the extension source (node_modules holds links to the real packages,
 * and no `.bin`), for tests that edit them or add a `.bin` shim. `runBench` takes it as `repo`.
 */
export function makeRepoCopy(): string {
	const dir = makeTmp("repo-copy");
	for (const entry of ["bench", "src"]) cpSync(join(REPO, entry), join(dir, entry), { recursive: true, filter: (path) => !path.includes(`${join(REPO, "bench")}/results`) });
	for (const file of ["package.json", "tsconfig.json", "bun.lock"]) if (existsSync(join(REPO, file))) copyFileSync(join(REPO, file), join(dir, file));
	writeFileSync(join(dir, ".gitignore"), "node_modules/\nbench/results/\n");
	// A real node_modules directory (so a test can add its own `.bin`), holding links to every installed package.
	mkdirSync(join(dir, "node_modules"));
	for (const name of readdirSync(join(REPO, "node_modules"))) if (name !== ".bin") symlinkSync(join(REPO, "node_modules", name), join(dir, "node_modules", name));
	const git = (...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	};
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-qm", "copy");
	return dir;
}

export interface BenchRun {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Runs a bench script (bench/run.ts by default) in a subprocess with a controlled HOME and PATH (fake omp first,
 * then bun, then system dirs) and no inherited TYPESAFE_* / FAKE_OMP_* variables.
 */
export async function runBenchScript(script: string, args: string[], opts: { home: string; fakeBin?: string; env?: Record<string, string>; cwd?: string; repo?: string }): Promise<BenchRun> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("TYPESAFE_") && !k.startsWith("FAKE_OMP_")) env[k] = v;
	}
	env.HOME = opts.home;
	env.PATH = makePath(opts.fakeBin);
	Object.assign(env, opts.env);
	const repo = opts.repo ?? REPO;
	const proc = Bun.spawn([process.execPath, join(repo, "bench", script), ...args], { cwd: opts.cwd ?? repo, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

/** Runs bench/run.ts in a subprocess; see runBenchScript. */
export function runBench(args: string[], opts: { home: string; fakeBin?: string; env?: Record<string, string>; cwd?: string; repo?: string }): Promise<BenchRun> {
	return runBenchScript("run.ts", args, opts);
}

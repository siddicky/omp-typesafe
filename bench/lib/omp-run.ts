import { realpathSync } from "node:fs";
import { join } from "node:path";

export interface OmpRunResult {
	exitCode: number | null;
	/** Terminating signal when the process was killed (timeout kill, crash), else null. */
	signal: string | null;
	stdout: string;
	stderr: string;
	wallMs: number;
	argv: string[];
	/** True when this harness killed the process for exceeding `timeoutMs`. */
	timedOut: boolean;
	/** Set when the process could not be started at all (e.g. `omp` is not on PATH). */
	spawnError?: string;
}

export interface RunOmpOptions {
	cwd: string;
	/** Overrides merged onto the inherited environment (see `hermeticEnv`). */
	env: Record<string, string>;
	timeoutMs: number;
	/** Executable to run instead of `omp` (tests point this at a fake). */
	bin?: string;
	/** Time between SIGTERM and SIGKILL once the timeout fires. Default 5s. */
	killGraceMs?: number;
	/** How long to keep draining stdout/stderr after exit, in case a grandchild holds the pipes open. Default 2s. */
	streamGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_STREAM_GRACE_MS = 2_000;

/**
 * Environment for an omp child: the inherited environment minus every TYPESAFE_*
 * variable, plus the explicit overrides. A TYPESAFE_ROLE / TYPESAFE_CONFIG /
 * TYPESAFE_AMBIGUITY_THRESHOLD left in the invoking shell would otherwise silently
 * change what a cell measures; each cell must say exactly what it wants.
 */
export function hermeticEnv(base: Record<string, string | undefined>, overrides: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) {
		if (v === undefined || k.startsWith("TYPESAFE_")) continue;
		out[k] = v;
	}
	return { ...out, ...overrides };
}

/** Incrementally collects a pipe so partial output survives a pipe that never closes. */
function drain(stream: ReadableStream<Uint8Array> | null | undefined) {
	const chunks: Uint8Array[] = [];
	if (!stream) return { text: () => "", done: Promise.resolve(), cancel: () => Promise.resolve() };
	const reader = stream.getReader();
	const done = (async () => {
		for (;;) {
			const { value, done: finished } = await reader.read();
			if (finished) return;
			if (value) chunks.push(value);
		}
	})().catch(() => {});
	return {
		text: () => Buffer.concat(chunks).toString("utf8"),
		done,
		cancel: () => reader.cancel().catch(() => {}),
	};
}

/**
 * Runs a command asynchronously (so `--concurrency` workers genuinely overlap),
 * killing it after `timeoutMs`. Never throws: a failure to start is reported in
 * `spawnError`, with exitCode null.
 */
export async function runProcess(cmd: string[], opts: Omit<RunOmpOptions, "bin">): Promise<OmpRunResult> {
	const start = Date.now();
	const argv = cmd.slice(1);
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(cmd, {
			cwd: opts.cwd,
			env: hermeticEnv(process.env, opts.env),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		return { exitCode: null, signal: null, stdout: "", stderr: "", wallMs: Date.now() - start, argv, timedOut: false, spawnError: err instanceof Error ? err.message : String(err) };
	}

	const out = drain(proc.stdout as ReadableStream<Uint8Array>);
	const err = drain(proc.stderr as ReadableStream<Uint8Array>);

	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		killTimer = setTimeout(() => proc.kill("SIGKILL"), opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
	}, opts.timeoutMs);

	await proc.exited;
	clearTimeout(timer);
	clearTimeout(killTimer);

	// A killed omp can leave grandchildren (bash tools, servers) holding the pipes
	// open; do not wait for EOF forever once the process itself is gone.
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all([out.done, err.done]),
		new Promise<void>((resolve) => {
			graceTimer = setTimeout(resolve, opts.streamGraceMs ?? DEFAULT_STREAM_GRACE_MS);
		}),
	]);
	clearTimeout(graceTimer);
	await Promise.all([out.cancel(), err.cancel()]);

	return {
		exitCode: proc.exitCode,
		signal: proc.signalCode ?? null,
		stdout: out.text(),
		stderr: err.text(),
		wallMs: Date.now() - start,
		argv,
		timedOut,
	};
}

export interface ResolvedOmp {
	/** The executable every cell is run with. */
	path: string;
	/** `OMP_BIN` (named explicitly), `PATH` (installed on the machine) or `dev-dependency` (only this repo's pinned package provides one). */
	source: "OMP_BIN" | "PATH" | "dev-dependency";
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Which omp the bench measures, resolved once and never by a bare `omp`. `bun run bench/run.ts` puts
 * `<repo>/node_modules/.bin` first on PATH, and this repo pins @oh-my-pi/pi-coding-agent there as a devDependency (for
 * the extension's types), so a bare `omp` would quietly mean that package build instead of the omp installed on the
 * machine. `OMP_BIN` names one explicitly; otherwise the first omp on PATH outside that shim directory wins; the shim
 * is the last resort. Null when none is found (or `OMP_BIN` does not exist), never a silent fallback.
 */
export function resolveOmp(env: Record<string, string | undefined>, repoRoot: string): ResolvedOmp | null {
	const PATH = env.PATH ?? "";
	const override = env.OMP_BIN?.trim();
	if (override) {
		const found = Bun.which(override, { PATH });
		return found ? { path: found, source: "OMP_BIN" } : null;
	}
	const shimDir = realOrSelf(join(repoRoot, "node_modules", ".bin"));
	const dirs = PATH.split(":").filter((d) => d.length > 0);
	const installed = Bun.which("omp", { PATH: dirs.filter((d) => realOrSelf(d) !== shimDir).join(":") });
	if (installed) return { path: installed, source: "PATH" };
	const shim = Bun.which("omp", { PATH });
	return shim ? { path: shim, source: "dev-dependency" } : null;
}

export async function runOmp(argv: string[], opts: RunOmpOptions): Promise<OmpRunResult> {
	const { bin, ...rest } = opts;
	return runProcess([bin ?? "omp", ...argv], rest);
}

/**
 * True when omp stopped itself at its own `--max-time` budget. Verified against omp
 * 18.4.5: it aborts the in-flight assistant message with errorMessage "Deadline
 * exceeded" and exits 1. That is the agent not finishing in time, an outcome of the
 * run, not an infrastructure failure.
 */
export function ompHitMaxTime(stdout: string): boolean {
	return /"errorMessage"\s*:\s*"Deadline exceeded"/.test(stdout);
}

/**
 * Infrastructure-failure reasons derivable from the process outcome alone: omp
 * never started, was killed by this harness for hanging, or exited nonzero for
 * a reason other than its own `--max-time`. Such a run says nothing about the
 * agent or the extension, so the report must not average its grade (of the
 * untouched fixture) in as if the agent had tried and failed.
 */
export function processInfraReasons(r: { exitCode: number | null | undefined; timedOut?: boolean; spawnError?: string; hitMaxTime?: boolean }): string[] {
	const reasons: string[] = [];
	if (r.spawnError) reasons.push("spawn_error");
	if (r.timedOut) reasons.push("timeout");
	else if (!r.spawnError && r.exitCode !== 0 && !r.hitMaxTime) reasons.push("nonzero_exit");
	return reasons;
}

/** Parse "10m" / "1h" / "600" style durations (matches omp's --max-time) into milliseconds. */
export function parseDuration(spec: string): number {
	const m = spec.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
	if (!m) throw new Error(`invalid duration: ${spec}`);
	const value = Number.parseFloat(m[1]);
	const unit = (m[2] ?? "s").toLowerCase();
	const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
	return value * mult[unit];
}

/**
 * The subprocess timeout (our own kill switch, distinct from omp's own
 * --max-time) must give omp room to actually hit --max-time and exit
 * cleanly. Phase 0 smoke found plan-mode runs on a trivial 2-file fixture
 * took 90-130s in print mode (it waits out any late reviewer turns before
 * exiting), so a tight harness timeout risks killing a run that --max-time
 * itself would have let finish. Floor of 15 minutes regardless of a smaller
 * --max-time, plus a 5-minute margin above --max-time otherwise.
 */
export function subprocessTimeoutMs(maxTimeSpec: string): number {
	const maxTimeMs = parseDuration(maxTimeSpec);
	const FLOOR_MS = 15 * 60_000;
	const MARGIN_MS = 5 * 60_000;
	return Math.max(maxTimeMs + MARGIN_MS, FLOOR_MS);
}

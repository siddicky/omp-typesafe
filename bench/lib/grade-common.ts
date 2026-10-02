import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTypesafeApiKey } from "./api-key";

export interface TaskSpec {
	id: string;
	execPrompt: string;
	planPrompt: string;
	rubric: string[];
	/** Legacy regex checklist. Only feeds the labeled legacy column; it rewards prompt echo. */
	checklist: string[];
	/** Semantic yes/no requirements, one Jev noul each, aligned with `checklist`. */
	checklistQuestions?: string[];
	/** Paths the agent must not touch at all (add, modify or delete), relative to the seed. */
	forbiddenFiles?: string[];
	/** Seed files at or under these paths must stay unchanged. Adding new files there is allowed. */
	protectedPaths?: string[];
	/** JS regex sources that must match somewhere in the source files (comments ignored). */
	requiredGrep?: string[];
	/** JS regex sources that must match nowhere in the source files (comments ignored). */
	forbiddenGrep?: string[];
	/** Kill `bun test` after this many ms. Default 120000. */
	testTimeoutMs?: number;
}

export interface GradeResult {
	score: number;
	success: boolean;
	checks: Record<string, boolean>;
	/** True when `bun test` was killed for exceeding the timeout. */
	timedOut?: boolean;
	/** Check names decided inside a Jev uncertainty band; worth a human or judge look. */
	uncertain?: string[];
	/** True when a TypeSafe-backed check fell back to its regex because the API was unavailable. */
	graderFallback?: boolean;
	/** Unscored grader detail (probabilities, model), recorded for later inspection. */
	details?: Record<string, unknown>;
}

export interface GradeOptions {
	testTimeoutMs?: number;
}

export const DEFAULT_TEST_TIMEOUT_MS = 120_000;

// ---- Jev grader conventions ----------------------------------------------------

/** Pinned so grader verdicts do not drift when the default Jev model moves. */
export const JEV_GRADER_MODEL = process.env.BENCH_JEV_MODEL?.trim() || "jev-1.13.0";
/** At or above this a noul answer counts as yes. */
export const JEV_MET = 0.7;
/** At or below this a noul answer counts as no; anything between is the uncertain band. */
export const JEV_NOT_MET = 0.3;

export type JevVerdict = "met" | "not_met" | "uncertain";

export function jevVerdict(p: number | null): JevVerdict {
	if (p === null || !Number.isFinite(p)) return "uncertain";
	if (p >= JEV_MET) return "met";
	if (p <= JEV_NOT_MET) return "not_met";
	return "uncertain";
}

/**
 * The bench harness sources TYPESAFE_API_KEY for the omp subprocess only, so the
 * graders running in the harness process may not have it. Read ~/.config/agent-secrets.env
 * when the variable is unset, with the same parser run.ts uses (bench/lib/api-key.ts), so the
 * runner and the graders cannot end up with different keys from one file. Returns whether a key is set.
 */
export async function loadTypesafeKey(secretsPath: string = join(homedir(), ".config", "agent-secrets.env")): Promise<boolean> {
	if (process.env.TYPESAFE_API_KEY?.trim()) return true;
	let fileText: string | undefined;
	try {
		fileText = await readFile(secretsPath, "utf8");
	} catch {
		// no secrets file; the caller falls back
	}
	const { key } = resolveTypesafeApiKey(process.env, fileText);
	if (key) process.env.TYPESAFE_API_KEY = key;
	return !!process.env.TYPESAFE_API_KEY?.trim();
}

// ---- process helper ------------------------------------------------------------

export interface ProcessResult {
	/** Exit code, or null when the process was killed by the timeout or failed to start. */
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface ProcessOptions {
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
	/** Keep stdout/stderr. Off by default so a chatty `bun test` can never block on a full pipe. */
	capture?: boolean;
}

/** Async spawn with a hard SIGKILL timeout. Never blocks the event loop and never throws. */
export async function runProcess(cmd: string[], cwd: string, opts: ProcessOptions = {}): Promise<ProcessResult> {
	const capture = opts.capture ?? false;
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(cmd, {
			cwd,
			env: opts.env ?? { ...process.env },
			stdin: "ignore",
			stdout: capture ? "pipe" : "ignore",
			stderr: capture ? "pipe" : "ignore",
		});
	} catch (err) {
		return { status: null, stdout: "", stderr: String(err), timedOut: false };
	}

	let timedOut = false;
	const timer = opts.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				proc.kill("SIGKILL");
			}, opts.timeoutMs)
		: undefined;

	const reads = capture
		? Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
		: Promise.resolve(["", ""]);
	const exitCode = await proc.exited;
	if (timer) clearTimeout(timer);
	// A grandchild that outlives the kill can keep the pipes open; do not wait on it forever.
	let giveUp: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<string[]>((resolve) => {
		giveUp = setTimeout(() => resolve(["", ""]), 2000);
	});
	const [stdout, stderr] = await Promise.race([reads, grace]);
	clearTimeout(giveUp);
	return { status: timedOut ? null : exitCode, stdout, stderr, timedOut };
}

// ---- seed-relative git snapshot -------------------------------------------------

const NODE_MODULES_EXCLUDE = ":(exclude,glob)**/node_modules/**";

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<ProcessResult> {
	return runProcess(["git", ...args], cwd, { capture: true, env: { ...process.env, ...env } });
}

/**
 * The seed commit the agent started from: the `bench-seed` tag when prepareFixture
 * set one, else the oldest root commit (prepareFixture makes exactly one). Grading
 * against this instead of HEAD keeps agent commits from emptying the diff.
 */
async function resolveSeed(cwd: string): Promise<string | null> {
	const tagged = await git(cwd, ["rev-parse", "--verify", "-q", "refs/tags/bench-seed^{commit}"]);
	if (tagged.status === 0 && tagged.stdout.trim()) return tagged.stdout.trim();
	const roots = await git(cwd, ["rev-list", "--max-parents=0", "--reverse", "HEAD"]);
	if (roots.status !== 0) return null;
	return roots.stdout.split("\n").map((s) => s.trim()).find(Boolean) ?? null;
}

/**
 * Tree object of the working tree as it stands now, tracked or not, committed or
 * not, built through a throwaway index so the repo's own index is never touched.
 */
async function snapshotWorkingTree(cwd: string): Promise<string | null> {
	const dir = await mkdtemp(join(tmpdir(), "bench-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(dir, "index") };
		const added = await git(cwd, ["add", "-A", "--", ".", NODE_MODULES_EXCLUDE], env);
		if (added.status !== 0) return null;
		const tree = await git(cwd, ["write-tree"], env);
		return tree.status === 0 ? tree.stdout.trim() || null : null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export interface RepoChange {
	/** git name-status letter: A, M, D or T. Renames are reported as D plus A. */
	status: string;
	path: string;
}

/** Everything that differs between the seed and the working tree now. Null when git cannot say. */
export async function diffAgainstSeed(cwd: string): Promise<RepoChange[] | null> {
	const seed = await resolveSeed(cwd);
	const tree = seed ? await snapshotWorkingTree(cwd) : null;
	if (!seed || !tree) return null;
	const diff = await git(cwd, ["diff", "--name-status", "--no-renames", "-z", seed, tree]);
	if (diff.status !== 0) return null;
	const parts = diff.stdout.split("\0").filter(Boolean);
	const changes: RepoChange[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i], path: parts[i + 1] });
	return changes;
}

/** Lines added versus the seed across `paths` (committed, staged or untracked). Null when git cannot say. */
export async function addedLinesAgainstSeed(cwd: string, paths: string[]): Promise<number | null> {
	const seed = await resolveSeed(cwd);
	const tree = seed ? await snapshotWorkingTree(cwd) : null;
	if (!seed || !tree) return null;
	const diff = await git(cwd, ["diff", "--numstat", "--no-renames", seed, tree, "--", ...paths]);
	if (diff.status !== 0) return null;
	let added = 0;
	for (const line of diff.stdout.split("\n")) {
		const n = Number.parseInt(line.trim().split("\t")[0] ?? "", 10);
		if (Number.isFinite(n)) added += n;
	}
	return added;
}

function underPath(path: string, root: string): boolean {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return path === root || path.startsWith(prefix);
}

// ---- comment-aware source grep --------------------------------------------------

const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_SOURCE_BYTES = 1024 * 1024;

const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";
const REGEX_KEYWORD_TAIL = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)\s*$/;

function skipQuoted(src: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") i += 2;
		else if (c === quote) return i + 1;
		else if (c === "\n") return i; // unterminated; stop at the line end
		else i++;
	}
	return src.length;
}

function skipRegexLiteral(src: string, start: number): number {
	let i = start + 1;
	let inClass = false;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") i += 2;
		else if (c === "\n") return start + 1; // not a regex after all
		else if (c === "[") {
			inClass = true;
			i++;
		} else if (c === "]") {
			inClass = false;
			i++;
		} else if (c === "/" && !inClass) {
			i++;
			while (i < src.length && /[a-z]/i.test(src[i])) i++;
			return i;
		} else i++;
	}
	return start + 1;
}

function scanTemplate(src: string, start: number): { out: string; end: number } {
	let out = "`";
	let i = start + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			out += src.slice(i, i + 2);
			i += 2;
		} else if (c === "`") {
			return { out: `${out}\``, end: i + 1 };
		} else if (c === "$" && src[i + 1] === "{") {
			const inner = scanCode(src, i + 2, true);
			out += `\${${inner.out}`;
			i = inner.end;
			if (i < src.length) {
				out += "}";
				i++;
			}
		} else {
			out += c;
			i++;
		}
	}
	return { out, end: src.length };
}

function scanCode(src: string, start: number, inSubstitution: boolean): { out: string; end: number } {
	let out = "";
	let i = start;
	let braces = 0;
	let lastSignificant = "";
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			let j = i;
			while (j < src.length && src[j] !== "\n") j++;
			out += " ".repeat(j - i);
			i = j;
		} else if (c === "/" && next === "*") {
			const close = src.indexOf("*/", i + 2);
			const j = close < 0 ? src.length : close + 2;
			out += src.slice(i, j).replace(/[^\n]/g, " ");
			i = j;
		} else if (c === '"' || c === "'") {
			const j = skipQuoted(src, i, c);
			out += src.slice(i, j);
			lastSignificant = c;
			i = j;
		} else if (c === "`") {
			const t = scanTemplate(src, i);
			out += t.out;
			lastSignificant = "`";
			i = t.end;
		} else if (c === "/" && (lastSignificant === "" || REGEX_PRECEDERS.includes(lastSignificant) || REGEX_KEYWORD_TAIL.test(out))) {
			const j = skipRegexLiteral(src, i);
			out += src.slice(i, j);
			lastSignificant = "/";
			i = j;
		} else {
			if (inSubstitution && c === "{") braces++;
			else if (inSubstitution && c === "}") {
				if (braces === 0) return { out, end: i };
				braces--;
			}
			out += c;
			if (!/\s/.test(c)) lastSignificant = c;
			i++;
		}
	}
	return { out, end: src.length };
}

/**
 * Blanks out line and block comments in JS/TS source while leaving strings, template
 * literals and regex literals alone, so a grep for an identifier sees code (and
 * string keys) but not explanatory prose. Length and line structure are preserved.
 */
export function stripComments(src: string): string {
	return scanCode(src, 0, false).out;
}

async function collectSources(root: string, dir: string, out: Map<string, string>): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const abs = join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) await collectSources(root, abs, out);
		} else if (e.isFile() && CODE_FILE_RE.test(e.name)) {
			try {
				if ((await stat(abs)).size > MAX_SOURCE_BYTES) continue;
				out.set(abs.slice(root.length + 1), stripComments(await readFile(abs, "utf8")));
			} catch {
				// unreadable file: skip
			}
		}
	}
}

/**
 * Every JS/TS source file in the working tree (tracked or not), comments blanked.
 * Docs, data files and agent scratch notes are deliberately not searched.
 */
export async function readSourceCorpus(cwd: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	await collectSources(cwd, cwd, out);
	return out;
}

/** Does `pattern` (JS regex source) match any file of the corpus? Null when the pattern is invalid. */
export function corpusMatches(corpus: Map<string, string>, pattern: string): boolean | null {
	let re: RegExp;
	try {
		re = new RegExp(pattern, "m");
	} catch {
		return null;
	}
	for (const text of corpus.values()) if (re.test(text)) return true;
	return false;
}

// ---- scratch-copy probe ----------------------------------------------------------

const PROBE_MARKER = "@@BENCH_PROBE@@";

export interface ProbeOptions {
	/** Paths copied from the repo into the scratch dir. Default: src and package.json. */
	include?: string[];
	/** Adjust the scratch copy before the probe runs (e.g. wrap a module to count calls). */
	prepare?: (scratchDir: string) => void | Promise<void>;
	timeoutMs?: number;
}

/**
 * Runs `script` (an async function body that `return`s a JSON value) with bun in a
 * scratch copy of the repo, so agent code is exercised for behavior without being
 * able to touch the graded tree, and a hang is killed by the timeout. Relative
 * imports in the script resolve against the scratch copy. Null on any failure.
 */
export async function probeCopy<T>(cwd: string, script: string, opts: ProbeOptions = {}): Promise<T | null> {
	const dir = await mkdtemp(join(tmpdir(), "bench-probe-"));
	try {
		for (const rel of opts.include ?? ["src", "package.json"]) {
			try {
				await cp(join(cwd, rel), join(dir, rel), { recursive: true, filter: (s) => !s.includes("node_modules") });
			} catch {
				// a missing include simply makes the probe's import fail
			}
		}
		await opts.prepare?.(dir);
		const body = `const __result = await (async () => {\n${script}\n})();\nconsole.log(${JSON.stringify(PROBE_MARKER)} + JSON.stringify(__result));\n`;
		await writeFile(join(dir, "__probe.ts"), body);
		const r = await runProcess(["bun", "__probe.ts"], dir, { capture: true, timeoutMs: opts.timeoutMs ?? 20_000 });
		if (r.status !== 0) return null;
		const line = r.stdout.split("\n").reverse().find((l) => l.startsWith(PROBE_MARKER));
		if (!line) return null;
		return JSON.parse(line.slice(PROBE_MARKER.length)) as T;
	} catch {
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ---- shared deterministic grader --------------------------------------------------

/**
 * Shared deterministic grader used by every task's grade.ts: runs `bun test` under a
 * hard timeout, diffs the working tree (committed or not, tracked or not) against the
 * seed commit for forbidden and protected files, and greps the source files for
 * required/forbidden patterns. Tasks pass extra task-specific checks via `extra`.
 */
export async function runGrade(
	cwd: string,
	spec: TaskSpec,
	extra?: (cwd: string) => Record<string, boolean> | Promise<Record<string, boolean>>,
	opts: GradeOptions = {},
): Promise<GradeResult> {
	const checks: Record<string, boolean> = {};

	const testRun = await runProcess(["bun", "test"], cwd, {
		timeoutMs: opts.testTimeoutMs ?? spec.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
	});
	checks.tests_pass = testRun.status === 0;
	// Same convention as grader_threw: a present, false check marks the failure.
	if (testRun.timedOut) checks.grader_timeout = false;

	if (spec.forbiddenFiles?.length || spec.protectedPaths?.length) {
		const changes = await diffAgainstSeed(cwd);
		if (spec.forbiddenFiles?.length) {
			checks.no_forbidden_files_touched =
				changes !== null && !changes.some((c) => spec.forbiddenFiles?.includes(c.path));
		}
		if (spec.protectedPaths?.length) {
			checks.protected_files_intact =
				changes !== null &&
				!changes.some((c) => c.status !== "A" && spec.protectedPaths?.some((p) => underPath(c.path, p)));
		}
	}

	if (spec.requiredGrep?.length || spec.forbiddenGrep?.length) {
		const corpus = await readSourceCorpus(cwd);
		for (const pattern of spec.requiredGrep ?? []) {
			checks[`requires:${pattern}`] = corpusMatches(corpus, pattern) === true;
		}
		for (const pattern of spec.forbiddenGrep ?? []) {
			// An invalid pattern is a grader bug; fail closed rather than pass vacuously.
			checks[`forbids:${pattern}`] = corpusMatches(corpus, pattern) === false;
		}
	}

	if (extra) {
		Object.assign(checks, await extra(cwd));
	}

	const values = Object.values(checks);
	const score = values.length ? values.filter(Boolean).length / values.length : 0;
	const success = values.length > 0 && values.every(Boolean);
	return testRun.timedOut ? { score, success, checks, timedOut: true } : { score, success, checks };
}

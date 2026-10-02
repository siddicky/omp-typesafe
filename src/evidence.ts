import { isAbsolute, posix, relative, sep } from "node:path";
import { cap, cleanedCap, firstLine, isRecord, redactSecrets, stripControl } from "./text";

/**
 * Deterministic evidence collection via pi.exec — gives the reviewer something
 * to check rather than prose. Every command is bounded (1500 ms each, 3 s for the
 * whole collection) and runs in parallel waves. A probe that fails or is killed
 * leaves its field out and is listed in `incomplete` instead of being reported
 * as an empty result.
 */

const PER_COMMAND_TIMEOUT_MS = 1500;
const TOTAL_DEADLINE_MS = 3000;
const MAX_DIFF_FILES = 3;
const MAX_SUSPECTS = 5;
const MAX_GREP_HITS = 10;
const MAX_COMMANDS = 32;
const COMMAND_TEXT_MAX = 80;
const MAX_DIFF_LINE = 2000;
/**
 * suspectIdentifiers runs synchronously on omp's one thread, outside the git deadlines, and a line of up to
 * MAX_DIFF_LINE characters can still cost milliseconds in the patterns that read it (a run of `\"` pairs, `get get
 * get ...`), 350 times what an ordinary line costs. So it reads at most this much of a diff and stops after this
 * long, and says so (`incomplete: ["suspects"]`) instead of presenting what it saw as the whole.
 */
const SUSPECT_SCAN_MAX_CHARS = 512_000;
/** Exported so that the tests, and the README they check, state the same number. */
export const SUSPECT_SCAN_BUDGET_MS = 250;
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BASELINE_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

// Pin the output format and switch off repo/user config that runs programs or reshapes output.
// pi.exec cannot set env vars, so this is all done with flags.
const GIT_PREFIX = ["--no-optional-locks", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-c", "color.ui=never"];
/** Exported so the bench's provenance hash of a dirty tree reads the diff the same way. */
export const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];
const STATUS_ARGS = ["status", "--porcelain", "-z", "-uall", "--no-renames"];
// Lock files, minified bundles and source maps would crowd real edits out of every probe.
const GENERATED_EXCLUDES = [
	":(exclude)*.lock",
	":(exclude)*.lockb",
	":(exclude)*-lock.json",
	":(exclude)*-lock.yaml",
	":(exclude)*go.sum",
	":(exclude)*.min.js",
	":(exclude)*.min.css",
	":(exclude)*.map",
];
const WHOLE_TREE = [".", ...GENERATED_EXCLUDES];
const GENERATED_FILE = /(?:\.lock|\.lockb|-lock\.json|-lock\.yaml|go\.sum|\.min\.js|\.min\.css|\.map)$/;

export interface Suspect {
	identifier: string;
	hits: string[];
}

export interface Evidence {
	repo: boolean;
	status?: string;
	/** Changed paths in `status`, counted before the text was capped. */
	changedCount?: number;
	diffStat?: string;
	fileDiffs?: string[];
	suspects?: Suspect[];
	commandsRun: string[];
	/** Probes that failed or were killed by a timeout; their fields are left out, not reported as empty. */
	incomplete?: string[];
}

export interface StatusEvidence {
	repo: boolean;
	status?: string;
	changedCount?: number;
	incomplete?: boolean;
}

export interface ExecLike {
	exec(cmd: string, args: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
}

export interface CollectOptions {
	/** Paths the reviewed action touched (tool input `path`s): their diffs go first and they scope the removed-name probe. */
	focusPaths?: readonly string[];
	/** Commit to diff against (see captureBaseline). Defaults to HEAD, or the empty tree on an unborn branch. */
	baseline?: string;
	signal?: AbortSignal;
	/** Mask obvious secrets in evidence text. Default true. */
	redact?: boolean;
}

export interface ActionDetail {
	/** Command text (bash) or code (eval); only the first line is kept. */
	command?: string;
	isError?: boolean;
	/** Mask secrets in the command text (default true); adversary.redact off sends it as is, like the rest of the evidence. */
	redact?: boolean;
}

let commandsRunThisTurn: string[] = [];

/** Track bash/eval tool activity so verification questions can tell "ran nothing" from "ran the tests". */
export function recordAction(toolName: string, detail?: ActionDetail): void {
	if (toolName !== "bash" && toolName !== "eval") return;
	let entry: string = toolName;
	// Only the first line is kept, so only that much is ever cleaned, however large the script is.
	const clean = makeClean(detail?.redact);
	const command = detail?.command ? firstLine(cleanedCap(detail.command.split("\n", 1)[0] ?? "", COMMAND_TEXT_MAX, clean), COMMAND_TEXT_MAX) : "";
	if (command) entry += `: ${command}`;
	if (detail?.isError !== undefined) entry += detail.isError ? " [failed]" : " [ok]";
	commandsRunThisTurn.push(entry);
	if (commandsRunThisTurn.length > MAX_COMMANDS) commandsRunThisTurn = commandsRunThisTurn.slice(-MAX_COMMANDS);
}

export function resetEvidenceTurn(): void {
	commandsRunThisTurn = [];
}

export function commandsThisTurn(): string[] {
	return [...commandsRunThisTurn];
}

interface RawResult {
	code: number;
	stdout: string;
}

type Probe = (cwd: string | undefined, args: string[]) => Promise<RawResult | null>;

/** Run one git command. Null when it threw or was killed: a killed command's stdout is truncated. */
async function execGit(pi: ExecLike, args: string[], cwd: string | undefined, signal: AbortSignal): Promise<RawResult | null> {
	try {
		const raw = await pi.exec("git", [...GIT_PREFIX, ...args], { cwd, signal });
		if (!isRecord(raw)) return null;
		// omp reports an abort/timeout kill as `killed: true` with code 0 and partial stdout.
		if (raw.killed === true) return null;
		// pi.exec results expose `code`; accept `exitCode` for test doubles.
		const code = typeof raw.code === "number" ? raw.code : typeof raw.exitCode === "number" ? raw.exitCode : 1;
		return { code, stdout: typeof raw.stdout === "string" ? raw.stdout : "" };
	} catch {
		return null;
	}
}

/** One probe runner per collection: each command gets its own timeout plus a shared overall deadline. */
function makeProbe(pi: ExecLike, external: AbortSignal | undefined): Probe {
	const deadline = AbortSignal.timeout(TOTAL_DEADLINE_MS);
	return (cwd, args) => {
		const signals = [AbortSignal.timeout(PER_COMMAND_TIMEOUT_MS), deadline];
		if (external) signals.push(external);
		return execGit(pi, args, cwd, AbortSignal.any(signals));
	};
}

function okOut(raw: RawResult | null, okCodes: readonly number[] = [0]): string | null {
	return raw !== null && okCodes.includes(raw.code) ? raw.stdout : null;
}

function splitNul(out: string): string[] {
	return out.split("\0").filter((s) => s.length > 0);
}

function makeClean(redact: boolean | undefined): (text: string) => string {
	return (text) => (redact === false ? stripControl(text) : redactSecrets(stripControl(text)));
}

// ---------------------------------------------------------------------------
// Removed-identifier extraction
// ---------------------------------------------------------------------------

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
const IDENT_EXACT = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;
// The two alternatives of the body must not both match a backslash: with `.` as the second one, an unterminated quote
// followed by a run of backslashes can be tiled exponentially many ways, and the match takes seconds on a hostile line.
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\\n\r])*\1/g;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/|\*(?:\s|$)|#(?![!\[])|--(?:-|\s|$))/;
const NAME = "([A-Za-z_$][\\w$]*)";
const MODIFIERS =
	"(?:(?:export|default|declare|public|private|protected|static|abstract|async|const|final|sealed|open|internal|inline|override|unsafe|extern|pub(?:\\([^)]*\\))?)\\s+)";
const DECL_KEYWORD = new RegExp(
	`^${MODIFIERS}*(?:function\\*?|class|interface|type|enum|namespace|struct|trait|object|def|fn|func|fun|protocol|actor)\\s+(?:\\([^)]*\\)\\s*)?(?:self\\.)?${NAME}`,
);
const VAR_DECL = new RegExp(`^(?:export\\s+(?:declare\\s+)?)?(?:const|let|var|val)\\s+${NAME}`);
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/;
const COMMONJS_EXPORT = new RegExp(`^(?:module\\.)?exports\\.${NAME}\\s*=`);
const MODIFIED_METHOD = new RegExp(
	`^(?:(?:public|private|protected|static|final|abstract|async|override|virtual|internal|export|default|get|set|open|suspend)\\s+)+(?:[\\w$<>\\[\\],.?]+\\s+)*?${NAME}\\s*(?:<[^>\\n]*>)?\\s*\\(`,
);
const BARE_METHOD = new RegExp(`^${NAME}\\s*(?:<[^>\\n]*>)?\\s*\\([^)"'\`]*\\)\\s*(?::\\s*[^{;=]+?)?\\s*\\{\\s*$`);
const NON_CODE_EXT = new Set([
	"md", "mdx", "markdown", "txt", "rst", "adoc", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg",
	"csv", "tsv", "svg", "xml", "lock", "map", "snap", "log",
]);
const KEYWORDS = new Set([
	"function", "class", "const", "let", "var", "val", "if", "else", "for", "while", "do", "switch", "case", "default", "return",
	"break", "continue", "try", "catch", "finally", "throw", "new", "delete", "typeof", "instanceof", "void", "this", "super",
	"import", "export", "from", "await", "async", "yield", "static", "public", "private", "protected", "readonly", "abstract",
	"extends", "implements", "interface", "type", "enum", "namespace", "declare", "get", "set", "constructor", "null",
	"undefined", "true", "false", "def", "fn", "func", "fun", "self", "lambda", "pass", "None", "True", "False", "and", "not",
	"with", "elif", "except", "raise", "print", "match", "impl", "struct", "trait", "pub", "use", "mod", "mut", "ref", "where",
	"unsafe", "defer", "chan", "select", "range", "package", "override", "virtual", "final", "internal", "open", "suspend",
]);

/** Source text of a diff body line with comments and string literals removed; null for comment-only lines. */
function codeOf(body: string): string | null {
	if (COMMENT_LINE.test(body)) return null;
	return body
		.replace(STRING_LITERAL, " ")
		.replace(/\/\*.*?\*\//g, " ")
		.replace(/\/\/.*$/, "")
		.replace(/\s#.*$/, "");
}

/** Names a removed line defines: function/class/type/enum/const declarations, methods and exports. */
function declaredNames(body: string, code: string): string[] {
	const line = code.trim();
	let m = DECL_KEYWORD.exec(line);
	if (m) return [m[1]];
	// Indented const/let/var are locals; only top-level or exported ones are names other files can reference.
	if (!/^\s/.test(body) || line.startsWith("export")) {
		m = VAR_DECL.exec(line);
		if (m) return [m[1]];
	}
	m = EXPORT_LIST.exec(line);
	if (m) {
		return m[1]
			.split(",")
			.map((part) => (part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop() ?? "").trim())
			.filter((s) => s.length > 0);
	}
	m = COMMONJS_EXPORT.exec(line) ?? MODIFIED_METHOD.exec(line);
	if (m) return [m[1]];
	if (/^\s/.test(body)) {
		m = BARE_METHOD.exec(line);
		if (m) return [m[1]];
	}
	return [];
}

export interface SuspectScan {
	ids: string[];
	/** False when the diff was cut to SUSPECT_SCAN_MAX_CHARS or the scan ran out of time: the names are from what was read. */
	complete: boolean;
}

/**
 * Names defined on removed lines but not mentioned on any added line: candidates for
 * surviving references after a delete or rename. Only definition positions count, so
 * keywords, locals, and words in comments and strings cannot crowd out the real name.
 * Diff headers are skipped statefully (between `diff --git` and the first `@@`), so
 * content lines such as `+++counter;` are still read. The scan is bounded in size and
 * time (see SUSPECT_SCAN_MAX_CHARS) and reports when it stopped early.
 */
export function scanSuspects(unifiedDiff: string, max: number = MAX_SUSPECTS): SuspectScan {
	const removed = new Map<string, number>();
	const added = new Set<string>();
	const text = unifiedDiff.length > SUSPECT_SCAN_MAX_CHARS ? unifiedDiff.slice(0, SUSPECT_SCAN_MAX_CHARS) : unifiedDiff;
	let complete = text.length === unifiedDiff.length;
	const started = performance.now();
	let inHeader = false;
	let nonCode = false;
	for (const line of text.split("\n")) {
		if (performance.now() - started > SUSPECT_SCAN_BUDGET_MS) {
			complete = false;
			break;
		}
		if (line.startsWith("diff --git ")) {
			inHeader = true;
			nonCode = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHeader = false;
			continue;
		}
		if (inHeader) {
			if ((line.startsWith("+++ ") || line.startsWith("--- ")) && !line.endsWith("/dev/null")) {
				const ext = /\.([A-Za-z0-9]+)$/.exec(line.trim())?.[1];
				nonCode = ext !== undefined && NON_CODE_EXT.has(ext.toLowerCase());
			}
			continue;
		}
		const sign = line[0];
		// Very long lines are minified or generated output; skip them rather than scan them.
		if ((sign !== "+" && sign !== "-") || nonCode || line.length > MAX_DIFF_LINE) continue;
		const body = line.slice(1);
		const code = codeOf(body);
		if (code === null) continue;
		if (sign === "+") {
			for (const token of code.match(IDENT) ?? []) added.add(token);
			continue;
		}
		for (const name of declaredNames(body, code)) {
			if (!IDENT_EXACT.test(name) || KEYWORDS.has(name) || /^__.*__$/.test(name)) continue;
			removed.set(name, (removed.get(name) ?? 0) + 1);
		}
	}
	const ids = [...removed.entries()]
		.filter(([id]) => !added.has(id))
		.sort((a, b) => b[1] - a[1])
		.slice(0, max)
		.map(([id]) => id);
	return { ids, complete };
}

/** The names of scanSuspects, for callers that do not need to know whether the scan was cut short. */
export function suspectIdentifiers(unifiedDiff: string, max: number = MAX_SUSPECTS): string[] {
	return scanSuspects(unifiedDiff, max).ids;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** Porcelain v1 `-z` output as readable `XY path` lines plus the untracked paths and the full count. */
function parseStatus(raw: string): { text: string; count: number; untracked: string[] } {
	const lines: string[] = [];
	const untracked: string[] = [];
	for (const entry of splitNul(raw)) {
		if (entry.length < 4) continue;
		lines.push(entry);
		if (entry.startsWith("??")) untracked.push(entry.slice(3));
	}
	return { text: lines.join("\n"), count: lines.length, untracked };
}

/** Resolve the action's paths (absolute or cwd-relative) to repo-root-relative candidates. */
function focusCandidates(paths: readonly string[] | undefined, cwd: string | undefined, root: string, prefix: string): string[] {
	const out: string[] = [];
	for (const raw of paths ?? []) {
		if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) continue;
		const rels: string[] = [];
		if (isAbsolute(raw)) {
			rels.push(relative(root, raw));
			// cwd may reach the repo through a symlink that `root` has already resolved.
			if (cwd) rels.push(posix.join(prefix, relative(cwd, raw).split(sep).join("/")));
		} else {
			rels.push(posix.join(prefix, raw));
		}
		for (const rel of rels) {
			const norm = posix.normalize(rel.split(sep).join("/"));
			if (norm === "." || norm === ".." || norm.startsWith("../") || isAbsolute(norm)) continue;
			if (!out.includes(norm)) out.push(norm);
		}
	}
	return out.slice(0, 8);
}

function validBaseline(value: string | undefined): value is string {
	return value !== undefined && BASELINE_SHA.test(value);
}

async function emptyTree(probe: Probe, root: string): Promise<string> {
	const sha = (okOut(await probe(root, ["hash-object", "-t", "tree", "/dev/null"])) ?? "").trim();
	return BASELINE_SHA.test(sha) ? sha : EMPTY_TREE_SHA1;
}

/**
 * Snapshot the commit later evidence should diff against (call at turn or prompt start),
 * so a commit made mid-turn is still reviewed. HEAD's sha, the empty tree on an unborn
 * branch, or null when cwd is not a git work tree or git is unavailable.
 */
export async function captureBaseline(pi: ExecLike, cwd: string | undefined, signal?: AbortSignal): Promise<string | null> {
	const probe = makeProbe(pi, signal);
	const [top, head] = await Promise.all([
		probe(cwd, ["rev-parse", "--show-toplevel"]),
		probe(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
	]);
	if (!top || top.code !== 0 || !top.stdout.trim() || !head) return null;
	const sha = head.stdout.trim();
	if (head.code === 0 && BASELINE_SHA.test(sha)) return sha;
	return emptyTree(probe, top.stdout.replace(/\r?\n$/, ""));
}

/** Status-only probe (one git command) for callers that read nothing else, such as the ambiguity gate. */
export async function collectStatus(
	pi: ExecLike,
	cwd: string | undefined,
	opts: { signal?: AbortSignal; redact?: boolean } = {},
): Promise<StatusEvidence> {
	const raw = await makeProbe(pi, opts.signal)(cwd, STATUS_ARGS);
	if (raw === null) return { repo: false, incomplete: true };
	if (raw.code !== 0) return { repo: false };
	const parsed = parseStatus(raw.stdout);
	return { repo: true, status: cleanedCap(parsed.text, 1000, makeClean(opts.redact)), changedCount: parsed.count };
}

/** Collect git evidence for the current working tree; fast no-op outside a repo. */
export async function collectEvidence(pi: ExecLike, cwd: string | undefined, opts: CollectOptions = {}): Promise<Evidence> {
	const commandsRun = commandsThisTurn();
	const probe = makeProbe(pi, opts.signal);
	const clean = makeClean(opts.redact);
	const incomplete: string[] = [];

	const pinned = validBaseline(opts.baseline) ? opts.baseline : undefined;
	const [top, head, statusRaw] = await Promise.all([
		probe(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"]),
		pinned ? Promise.resolve(null) : probe(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
		probe(cwd, STATUS_ARGS),
	]);
	const [rootLine = "", prefixLine = ""] = (top?.stdout ?? "").split("\n").map((s) => s.replace(/\r$/, ""));
	if (top === null || top.code !== 0 || rootLine === "") {
		return top === null ? { repo: false, commandsRun, incomplete: ["repo"] } : { repo: false, commandsRun };
	}
	// Every later probe runs from the repo root: paths from git are root-relative and grep must see the whole tree.
	const root = rootLine;

	let base = pinned ?? "HEAD";
	if (!pinned && head) {
		if (head.code === 0 && BASELINE_SHA.test(head.stdout.trim())) base = head.stdout.trim();
		else if (head.code !== 0) base = await emptyTree(probe, root); // unborn branch: diff against nothing
	}

	const statusOut = okOut(statusRaw);
	const status = statusOut === null ? null : parseStatus(statusOut);
	if (!status) incomplete.push("status");

	const focus = focusCandidates(opts.focusPaths, cwd, root, prefixLine);
	const [statRaw, namesRaw, scopedRaw] = await Promise.all([
		probe(root, ["diff", base, "--stat", ...DIFF_FLAGS, "--", ...WHOLE_TREE]),
		probe(root, ["diff", base, "--name-only", "-z", ...DIFF_FLAGS, "--", ...WHOLE_TREE]),
		probe(root, ["diff", base, "-U0", ...DIFF_FLAGS, "--", ...(focus.length > 0 ? focus.map((f) => `:(literal)${f}`) : WHOLE_TREE)]),
	]);
	// The action's own file scopes the removed-name probe; fall back to the whole tree when it shows nothing.
	let zero = okOut(scopedRaw);
	if (focus.length > 0 && !zero) zero = okOut(await probe(root, ["diff", base, "-U0", ...DIFF_FLAGS, "--", ...WHOLE_TREE]));
	if (zero === null) incomplete.push("suspects");
	const statOut = okOut(statRaw);
	if (statOut === null) incomplete.push("diffStat");

	const tracked = okOut(namesRaw);
	const untracked = (status?.untracked ?? []).filter((f) => !GENERATED_FILE.test(f));
	const untrackedSet = new Set(untracked);
	const changed = [...new Set([...(tracked === null ? [] : splitNul(tracked)), ...untracked])];
	const focusSet = new Set(focus);
	const picks = [...changed.filter((f) => focusSet.has(f)), ...changed.filter((f) => !focusSet.has(f))].slice(0, MAX_DIFF_FILES);

	const scan = zero ? scanSuspects(zero) : null;
	const ids = scan?.ids ?? [];
	if (scan && !scan.complete && !incomplete.includes("suspects")) incomplete.push("suspects");
	const [fileDiffRaws, grepRaws] = await Promise.all([
		Promise.all(
			picks.map((f) =>
				untrackedSet.has(f)
					? probe(root, ["diff", "--no-index", "--unified=3", ...DIFF_FLAGS, "--", "/dev/null", f]).then((r) => okOut(r, [0, 1]))
					: probe(root, ["diff", base, "--unified=3", ...DIFF_FLAGS, "--", `:(literal)${f}`]).then((r) => okOut(r)),
			),
		),
		Promise.all(
			ids.map((id) =>
				// Exit 1 is "no match". -w/-F keep substrings (fetchUsername) out, -I skips binaries.
				probe(root, ["grep", "--no-color", "-I", "-n", "-w", "-F", "--untracked", "-e", id, "--", ...WHOLE_TREE]).then((r) => okOut(r, [0, 1])),
			),
		),
	]);

	let fileDiffs: string[] | undefined;
	if (tracked === null) incomplete.push("fileDiffs");
	else {
		fileDiffs = fileDiffRaws.filter((d): d is string => d !== null && d.length > 0).map((d) => cleanedCap(d, 2000, clean));
		if (fileDiffRaws.some((d) => d === null)) incomplete.push("fileDiffs");
	}

	let suspects: Suspect[] | undefined;
	if (zero !== null) {
		suspects = [];
		for (let i = 0; i < ids.length; i++) {
			const out = grepRaws[i];
			if (out === null) {
				if (!incomplete.includes("grep")) incomplete.push("grep");
				continue;
			}
			// Only the first hits are cleaned, so a long listing costs no more than a short one.
			const hits: string[] = [];
			for (const line of out.split("\n")) {
				if (hits.length >= MAX_GREP_HITS) break;
				const hit = cleanedCap(line, 200, clean).trim();
				if (hit.length > 0) hits.push(hit);
			}
			if (hits.length > 0) suspects.push({ identifier: ids[i], hits });
		}
	}

	return {
		repo: true,
		status: status ? cleanedCap(status.text, 1000, clean) : undefined,
		changedCount: status?.count,
		diffStat: statOut === null ? undefined : cleanedCap(statOut, 800, clean),
		fileDiffs,
		suspects,
		commandsRun,
		incomplete: incomplete.length > 0 ? incomplete : undefined,
	};
}

// ---------------------------------------------------------------------------
// Note attribute
// ---------------------------------------------------------------------------

const SAFE_PATH = /^[\p{L}\p{N}_.\-/@+~()[\]]{1,200}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `path:line` from a raw `git grep -n` hit, or null when the path is not plain enough to show the agent. */
export function grepLocation(hit: string): string | null {
	const m = /^([^:]+):(\d{1,7}):/.exec(hit);
	return m && SAFE_PATH.test(m[1]) ? `${m[1]}:${m[2]}` : null;
}

/**
 * Compact one-line summary for the note's evidence attribute. Never forwards repo text:
 * a surviving reference is shown as `identifier → path:line` only, so a tracked file cannot
 * put words (or markup) in front of the agent. Counts and commands come first so the
 * length cap trims suspects, not metadata. Returned unescaped; the note builder escapes it.
 */
export function formatEvidenceAttribute(ev: Evidence): string {
	const parts: string[] = [];
	if (!ev.repo) {
		parts.push(ev.incomplete?.includes("repo") ? "git unavailable" : "no git repo");
	} else {
		const changed = ev.changedCount ?? (ev.status ?? "").split("\n").filter((s) => s.length > 0).length;
		if (changed > 0) parts.push(`${changed} uncommitted files`);
		if (ev.incomplete && ev.incomplete.length > 0) parts.push(`incomplete: ${ev.incomplete.join(",")}`);
	}
	if (ev.commandsRun.length > 0) {
		const recent = [...new Set(ev.commandsRun)].slice(-4).map((c) => cap(c, 60));
		parts.push(`commands: ${recent.join(", ")}`);
	}
	if (ev.repo) {
		for (const s of ev.suspects ?? []) {
			if (!SAFE_IDENTIFIER.test(s.identifier) || s.hits.length === 0) continue;
			parts.push(`git grep ${s.identifier} → ${grepLocation(s.hits[0]) ?? "(unprintable path)"}`);
		}
	}
	return cap(parts.join("; "), 300);
}

// ---------------------------------------------------------------------------
// Repo outline
// ---------------------------------------------------------------------------

const OUTLINE_CAP = 1500;
const OUTLINE_MAX_DIRS = 30;
const OUTLINE_MAX_ROOT_FILES = 20;

/**
 * Compact repo outline for the ambiguity gate's context dimension: top-level
 * directory counts plus the tracked root files, capped at 1500 chars. Counts cover
 * every tracked file; only the rendered lists are trimmed. Empty string outside a
 * repo or when git is unavailable.
 */
export async function repoOutline(pi: ExecLike, cwd: string | undefined, opts: { signal?: AbortSignal } = {}): Promise<string> {
	// `:(top)` + --full-name list the whole repo with root-relative paths even from a subdirectory.
	const listed = okOut(await makeProbe(pi, opts.signal)(cwd, ["ls-files", "-z", "--full-name", "--", ":(top)"]));
	if (listed === null) return "";
	const paths = splitNul(listed);
	if (paths.length === 0) return "";
	const dirs = new Map<string, number>();
	const rootFiles: string[] = [];
	for (const path of paths) {
		const slash = path.indexOf("/");
		if (slash === -1) rootFiles.push(stripControl(path));
		else {
			const top = stripControl(path.slice(0, slash));
			dirs.set(top, (dirs.get(top) ?? 0) + 1);
		}
	}
	const parts = [...dirs.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, OUTLINE_MAX_DIRS)
		.map(([dir, n]) => `${dir}/ (${n} files)`);
	parts.push(...rootFiles.slice(0, OUTLINE_MAX_ROOT_FILES));
	return cap(parts.join(", "), OUTLINE_CAP);
}

import type { EntryView, MessageView } from "../branch";
import { inputPaths, isRecord } from "../text";

/**
 * Approval integrity for the omp-skills pipeline (deep-interview -> ralplan -> dag). Each stage ends in an `ask` gate, and
 * only the answer `Approve` (`Run` for a dag) flips the artifact: line 1 of a spec to `<!-- APPROVED YYYY-MM-DD -->`,
 * `"approved": true` in the PRD or a dag file, or an `approve_file(...)` call in an eval cell. Approval authorizes unattended
 * shell commands with the user's privileges, and the skills guard it with instructions alone. This module checks the one
 * thing an extension can check deterministically: that the branch holds the user's answer. No model call, nothing leaves
 * the machine.
 *
 * It is pure: tool inputs and scanned branch entries in, a decision out. It guards honest mistakes, not a sandbox: a bash
 * `sed` or an eval cell that writes the file itself is not seen. Everything it cannot read fails open.
 */

/** A scanned branch entry. `message.details` is omp's own tool-result details, read when the scan keeps them. */
export type ApprovalEntry = Omit<EntryView, "message"> & { message: (MessageView & { details?: unknown }) | null };

/** The tools whose input can flip an approval; every other tool is none of this module's business. */
export const APPROVAL_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch", "eval"]);
const FILE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"]);

/** What a flip approves; `plan` is a plan file that `approve_file` names only by a variable, or by a path of no known kind. */
export type ApprovalArtifact = "spec" | "prd" | "dag" | "plan";
/** How: the line-1 marker, the `"approved": true` flag, or an `approve_file(` call. */
export type ApprovalVia = "marker" | "flag" | "call";

export interface ApprovalFlip {
	artifact: ApprovalArtifact;
	via: ApprovalVia;
	/** The file the call names, normalized; null when it names none (`approve_file(path)`). */
	path: string | null;
	/** The answers that count as the user approving it. */
	labels: readonly string[];
}

const APPROVE: readonly string[] = ["Approve"];
const RUN: readonly string[] = ["Run"];
const EITHER: readonly string[] = ["Approve", "Run"];

// ---- paths -----------------------------------------------------------------------

const SPEC_PATH = /(?:^|\/)\.omp\/pipeline\/specs\/.+\.md$/i;
const PRD_PATH = /(?:^|\/)\.omp\/pipeline\/prd\.json$/i;
const DAG_PATH = /(?:^|\/)\.omp\/pipeline\/dag\/.+\.json$/i;
const PIPELINE_TAIL = /(?:^|\/)(\.omp\/pipeline\/.+)$/i;

/** Forward slashes, no `.` or empty segments, `..` resolved: so `./a/../.omp/pipeline/prd.json` is `.omp/pipeline/prd.json`. */
function normalizePath(path: string): string {
	const parts: string[] = [];
	for (const part of path.trim().replace(/\\/g, "/").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return (path.trim().startsWith("/") ? "/" : "") + parts.join("/");
}

function artifactOf(path: string): ApprovalArtifact | null {
	if (SPEC_PATH.test(path)) return "spec";
	if (PRD_PATH.test(path)) return "prd";
	if (DAG_PATH.test(path)) return "dag";
	return null;
}

/** `.omp/pipeline/...` as written under any project root, lower-cased; null for a path outside the pipeline. */
function pipelineKey(path: string): string | null {
	return PIPELINE_TAIL.exec(path)?.[1].toLowerCase() ?? null;
}

// ---- what an edit writes -------------------------------------------------------------

/** `<!-- APPROVED ... -->` as a line of its own, or as the start of a text; `UNAPPROVED` has no word boundary before its `APPROVED`. */
const MARKER_ROW = /^[ \t]*<!--\s*APPROVED\b/im;
const MARKER_START = /^\uFEFF?[ \t]*<!--\s*APPROVED\b/i;
const APPROVED_FLAG = /["']approved["']\s*:\s*true\b/i;
/** Fields that hold the text an edit replaces; every other string of an edit input is text it writes. */
const OLD_TEXT_KEY = /^(?:old|prev|previous|original|before|search|find|match)/i;
const PATCH_KEYS: ReadonlySet<string> = new Set(["input", "patch", "diff"]);
const MAX_DEPTH = 6;
const MAX_ITEMS = 200;

/** Added and removed rows of patch text (hashline bodies, apply_patch, unified diffs); text that is no patch is taken as written. */
function patchRows(text: string): { added: string; removed: string } {
	const added: string[] = [];
	const removed: string[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++ ")) added.push(line.slice(1));
		else if (line.startsWith("-") && !line.startsWith("--- ")) removed.push(line.slice(1));
	}
	return added.length + removed.length > 0 ? { added: added.join("\n"), removed: removed.join("\n") } : { added: text, removed: "" };
}

/**
 * What an edit-class input writes and what it takes out, whatever its mode: replace (`new_string`/`old_string`), patch
 * (`edits[].diff`) and the `{ input }` string of hashline and apply_patch. Read by value shape, not by tool, so a mode this
 * module has not seen still has its strings looked at.
 */
function editedText(input: unknown): { added: string; removed: string } {
	const added: string[] = [];
	const removed: string[] = [];
	const walk = (value: unknown, key: string, depth: number): void => {
		if (typeof value === "string") {
			if (PATCH_KEYS.has(key)) {
				const rows = patchRows(value);
				added.push(rows.added);
				removed.push(rows.removed);
			} else if (OLD_TEXT_KEY.test(key)) {
				removed.push(value);
			} else {
				added.push(value);
			}
		} else if (depth < MAX_DEPTH && Array.isArray(value)) {
			for (const item of value.slice(0, MAX_ITEMS)) walk(item, key, depth + 1);
		} else if (depth < MAX_DEPTH && isRecord(value)) {
			for (const [k, v] of Object.entries(value).slice(0, MAX_ITEMS)) walk(v, k, depth + 1);
		}
	};
	walk(input, "input", 0);
	return { added: added.join("\n"), removed: removed.join("\n") };
}

/** Flips made by a write/edit/apply_patch input: for each pipeline file it targets, the marker or flag it newly sets. */
function fileFlips(toolName: string, input: unknown): ApprovalFlip[] {
	const flips: ApprovalFlip[] = [];
	const written = toolName === "write" && isRecord(input) && typeof input.content === "string" ? input.content : null;
	let edited: { added: string; removed: string } | undefined;
	for (const path of new Set(inputPaths(input).map(normalizePath))) {
		const artifact = artifactOf(path);
		if (artifact === null) continue;
		const marker = artifact === "spec";
		let flipped: boolean;
		if (toolName === "write") {
			// A write replaces the whole file, so the spec's line 1 is where the content starts.
			flipped = written !== null && (marker ? MARKER_START.test(written) : APPROVED_FLAG.test(written));
		} else {
			edited ??= editedText(input);
			const pattern = marker ? MARKER_ROW : APPROVED_FLAG;
			// A marker the edit takes out as well was already there: an edit around it is no approval.
			flipped = pattern.test(edited.added) && !pattern.test(edited.removed);
		}
		if (flipped) flips.push({ artifact, via: marker ? "marker" : "flag", path, labels: artifact === "dag" ? RUN : APPROVE });
	}
	return flips;
}

// ---- eval cells --------------------------------------------------------------------

function codeOf(input: unknown): string {
	if (typeof input === "string") return input;
	return isRecord(input) && typeof input.code === "string" ? input.code : "";
}

/**
 * `code` with its comments and the insides of its string literals blanked, at the same length, so that a call is found
 * only where it runs. `js` selects `//`, block comments and template literals; otherwise Python's `#` and triple quotes.
 */
function maskCode(code: string, js: boolean): string {
	const blank = (text: string): string => text.replace(/[^\n]/g, " ");
	let out = "";
	let i = 0;
	while (i < code.length) {
		const ch = code[i];
		const block = js && code.startsWith("/*", i);
		if (block || (js ? code.startsWith("//", i) : ch === "#")) {
			const end = block ? code.indexOf("*/", i + 2) : code.indexOf("\n", i);
			const stop = end === -1 ? code.length : block ? end + 2 : end;
			out += blank(code.slice(i, stop));
			i = stop;
		} else if (ch === '"' || ch === "'" || (js && ch === "`")) {
			const quote = !js && code.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
			const multiline = quote.length === 3 || quote === "`";
			let j = i + quote.length;
			while (j < code.length && !code.startsWith(quote, j) && (multiline || code[j] !== "\n")) j += code[j] === "\\" ? 2 : 1;
			const closed = code.startsWith(quote, j);
			out += quote + blank(code.slice(i + quote.length, j)) + (closed ? quote : "");
			i = closed ? j + quote.length : j;
		} else {
			out += ch;
			i += 1;
		}
	}
	return out;
}

/** `approve_file(`, with or without a receiver; `isDefinition` tells a call from `def approve_file(`. */
const APPROVE_CALL = /\bapprove_file\s*\(/g;

/**
 * Is the name at `at` the one a `def` defines? Read backwards by hand and not with a lookbehind (`(?<!\bdef\s+)`): `maskCode` blanks
 * a string literal to a run of spaces, and a lookbehind reads back over the whole run from every position in it, which is
 * quadratic (a 30,000-character literal took 2.5 s). Here the run is read once per call, and it is no one else's.
 */
function isDefinition(code: string, at: number): boolean {
	let i = at;
	while (i > 0 && /\s/.test(code[i - 1])) i -= 1;
	return i < at && i >= 3 && code.startsWith("def", i - 3) && !/\w/.test(code[i - 4] ?? "");
}

/**
 * The argument of a call when it is one string literal (optionally `path=`): `approve_file(".omp/pipeline/prd.json")`. Linear: the
 * literal has one way to match, since a bare quote ends it and an escape takes the character after it, and the sticky flag
 * tries one start.
 */
const LITERAL_ARG = /\s*(?:path\s*=\s*)?[rRbBuUfF]{0,2}(["'])((?:\\.|(?!\1)[^\\\n])*)\1(?=\s*[,)])/y;

function callFlip(literal: string | null): ApprovalFlip {
	const path = literal === null ? null : normalizePath(literal);
	const artifact = path === null ? null : artifactOf(path);
	if (artifact === "prd") return { artifact, via: "call", path, labels: APPROVE };
	// A dag's gate offers Edit / Run / Cancel; a path or a variable of no known kind takes either approving answer.
	if (artifact === "dag") return { artifact, via: "call", path, labels: RUN };
	return { artifact: "plan", via: "call", path, labels: EITHER };
}

/** Flips made by an eval cell: one per `approve_file(` call in its running code (not in a comment or a string). */
function evalFlips(input: unknown): ApprovalFlip[] {
	const code = codeOf(input);
	if (!code.includes("approve_file")) return [];
	const masked = maskCode(code, isRecord(input) && input.language === "js");
	const flips: ApprovalFlip[] = [];
	for (const match of masked.matchAll(APPROVE_CALL)) {
		if (isDefinition(masked, match.index)) continue;
		LITERAL_ARG.lastIndex = match.index + match[0].length;
		flips.push(callFlip(LITERAL_ARG.exec(code)?.[2] ?? null));
	}
	return flips;
}

/**
 * The approvals a tool call would grant, empty for any call that grants none. Covers `write`, `edit` and `apply_patch` (a
 * spec's line 1 set to APPROVED; `"approved": true` set in `.omp/pipeline/prd.json` or a dag file) and `eval` (an
 * `approve_file(` call). Matching is on the input's shape, never on a result.
 */
export function detectApprovalFlips(toolName: string, input: unknown): ApprovalFlip[] {
	if (toolName === "eval") return evalFlips(input);
	return FILE_TOOLS.has(toolName) ? fileFlips(toolName, input) : [];
}

// ---- ask answers ----------------------------------------------------------------------

/** One answered question of an `ask` tool result. */
export interface AskAnswer {
	question: string | null;
	/** The labels the question offered; empty when the result does not say. */
	options: string[];
	selected: string[];
	/** Text typed through "Other"; null when there is none. */
	customInput: string | null;
	/** omp picked the answer itself when the dialog timed out (the recommended option, else the first). */
	timedOut: boolean;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => (typeof item === "string" ? [item] : isRecord(item) && typeof item.label === "string" ? [item.label] : []));
}

/** One answer from omp's structured result: `{ question, options, selectedOptions, customInput?, timedOut? }`. */
function answerFrom(record: unknown): AskAnswer | null {
	if (!isRecord(record) || !Array.isArray(record.selectedOptions)) return null;
	return {
		question: typeof record.question === "string" ? record.question : null,
		options: stringList(record.options),
		selected: stringList(record.selectedOptions),
		customInput: typeof record.customInput === "string" && record.customInput.trim().length > 0 ? record.customInput : null,
		timedOut: record.timedOut === true,
	};
}

/** Results that carry no answer: a failed call, "chat about this instead", a dismissed or empty dialog. */
const NO_ANSWER = /^(?:Error:|Ask (?:tool|input) was cancelled|User chose to chat about this|User cancelled the selection|User did not select any options)/;
const TIMEOUT_SUFFIX = / \(auto-selected after timeout\)$/;
/** omp appends the note typed beside a pick as ` (note: ...)`; the note may hold openers and brackets of its own. */
const NOTE_OPEN = " (note: ";

/**
 * `value` without its note: everything from the first ` (note: ` on, when the value ends with the closing bracket after it.
 * By hand, not `/ \(note: [\s\S]*\)$/`: that rescans the rest of the value from every opener when the bracket is missing,
 * which is quadratic in the number of openers. Any later opener is also too late if the first is.
 */
function withoutNote(value: string): string {
	const at = value.indexOf(NOTE_OPEN);
	return at !== -1 && value.endsWith(")") && at + NOTE_OPEN.length < value.length ? value.slice(0, at) : value;
}

/** One line of the multi-question text, `id: value`, `id: [a, b]` or `id: "typed"`, with its timeout and note suffixes. */
function answerFromLine(value: string): AskAnswer | null {
	const bare = withoutNote(value);
	const timedOut = TIMEOUT_SUFFIX.test(bare);
	const text = bare.replace(TIMEOUT_SUFFIX, "");
	if (text === "(cancelled)") return null;
	const typed = /^"([\s\S]*)"$/.exec(text);
	const list = /^\[(.*)\]$/.exec(text);
	const selected = typed ? [] : list ? list[1].split(", ").filter((s) => s.length > 0) : [text];
	return { question: null, options: [], selected, customInput: typed ? typed[1] : null, timedOut };
}

/**
 * The fallback for a result without usable `details`: omp's text. One question reads `User selected: X` (plus ` (auto-selected
 * after timeout)`) and `User provided custom input: ...`; several read `User answers:` and an `id: value` line each.
 */
function answersFromText(text: string): AskAnswer[] | null {
	if (NO_ANSWER.test(text)) return [];
	if (text.startsWith("User answers:\n")) {
		const answers: AskAnswer[] = [];
		for (const line of text.split("\n").slice(1)) {
			const m = /^[\w-]+: (.*)$/.exec(line);
			const answer = m ? answerFromLine(m[1]) : null;
			if (answer) answers.push(answer);
		}
		return answers;
	}
	const selected = /^User selected: (.+?)(?: \(auto-selected after timeout\))?$/m.exec(text);
	const typed = /^User provided custom input:/m.test(text);
	if (!selected && !typed) return null;
	return [{ question: null, options: [], selected: selected ? [selected[1]] : [], customInput: typed ? text : null, timedOut: selected !== null && TIMEOUT_SUFFIX.test(selected[0]) }];
}

/**
 * The answers an `ask` tool-result entry carries, from omp's structured `details` (one answer, or `results[]` for several
 * questions) and failing that from its text. `[]` for an entry that is no ask result or holds no answer (cancelled, an
 * error, a chat redirect); null for an ask result in a shape this module does not know, which callers treat as unreadable.
 */
export function askAnswers(entry: ApprovalEntry): AskAnswer[] | null {
	const message = entry.message;
	if (!message || message.role !== "toolResult" || message.toolName !== "ask" || message.isError) return [];
	const details = message.details;
	if (isRecord(details)) {
		if (details.chatRedirect === true) return [];
		const answers = Array.isArray(details.results) ? details.results.map(answerFrom) : [answerFrom(details)];
		const known = answers.filter((a): a is AskAnswer => a !== null);
		if (known.length > 0) return known;
	}
	return answersFromText(message.text);
}

function labelOf(option: string): string {
	return option.trim().replace(/\s*\(Recommended\)$/i, "").toLowerCase();
}

/**
 * Is this the user approving? Exactly one selected option, one of `labels`, picked by the user: not typed through "Other", not
 * picked by a timeout, and from a question that offered a choice. A note typed beside the pick does not change it.
 */
function approves(answer: AskAnswer, labels: readonly string[]): boolean {
	if (answer.timedOut || answer.customInput !== null || answer.selected.length !== 1 || answer.options.length === 1) return false;
	const picked = labelOf(answer.selected[0]);
	return labels.some((label) => label.toLowerCase() === picked);
}

export interface ApprovalEvidence {
	/** `unrecognized`: an ask result after `from` could not be read, so nothing can be said against the flip. */
	status: "approved" | "unrecognized" | "none";
	/** The entry that decided it; -1 for `none`. */
	index: number;
}

/**
 * Looks, from `from` on, for the user's approving answer to an `ask`, newest first. An approving answer wins over an
 * unreadable one; an unreadable one wins over nothing.
 */
export function findApprovalEvidence(entries: readonly ApprovalEntry[], labels: readonly string[], from = 0): ApprovalEvidence {
	let unreadable = -1;
	for (let i = entries.length - 1; i >= Math.max(0, from); i--) {
		const answers = askAnswers(entries[i]);
		if (answers === null) unreadable = Math.max(unreadable, i);
		else if (answers.some((answer) => approves(answer, labels))) return { status: "approved", index: i };
	}
	return unreadable >= 0 ? { status: "unrecognized", index: unreadable } : { status: "none", index: -1 };
}

// ---- the decision -----------------------------------------------------------------------

/** Code that writes a file or saves a plan: a cell that only reads one is not a draft. */
const WRITES_FILE = /\b(?:write\w*|dump|_persist|sync_prd|init_dag)\s*\(|\bopen\s*\([^\n]{0,200}["'][wa]\+?b?["']/;

/** Does `path` name the file the flip approves? A flip that names none (a variable) matches any PRD or dag file. */
function sameFile(path: string, flip: ApprovalFlip): boolean {
	if (flip.path === null) {
		const artifact = artifactOf(path);
		return artifact === "prd" || artifact === "dag";
	}
	return (pipelineKey(path) ?? path.toLowerCase()) === (pipelineKey(flip.path) ?? flip.path.toLowerCase());
}

function evalTouches(code: string, flip: ApprovalFlip): boolean {
	const text = code.replace(/\\/g, "/").toLowerCase();
	if (flip.path === null) return text.includes(".omp/pipeline/dag") || text.includes(".omp/pipeline/prd");
	return text.includes(pipelineKey(flip.path) ?? flip.path.toLowerCase());
}

/** Is this call a write of the artifact the flip approves, that is, one that changes what the user would be approving? */
function isDraftWrite(call: { name: string; input: unknown }, flip: ApprovalFlip): boolean {
	// An approval flip is not a revision (a re-flip after a flip is no new draft), and it is the call being decided too.
	if (detectApprovalFlips(call.name, call.input).length > 0) return false;
	if (call.name === "eval") {
		const code = codeOf(call.input);
		return WRITES_FILE.test(code) && evalTouches(code, flip);
	}
	return FILE_TOOLS.has(call.name) && inputPaths(call.input).some((path) => sameFile(normalizePath(path), flip));
}

/** Index of the entry holding the newest write of the flip's artifact; -1 when the branch has none. */
function lastDraftWrite(entries: readonly ApprovalEntry[], flip: ApprovalFlip): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const calls = entries[i].message?.toolCalls ?? [];
		if (entries[i].message?.role === "assistant" && calls.some((call) => isDraftWrite(call, flip))) return i;
	}
	return -1;
}

/** `block` stops the call; `would_block` is the same finding where no `ask` tool is active, so nothing can be stopped usefully. */
export type ApprovalDecision =
	| { action: "allow"; /** Set when the check itself failed and the call was let through. */ failedOpen?: string }
	| { action: "block"; reason: string; flip: ApprovalFlip }
	| { action: "would_block"; reason: string; flip: ApprovalFlip };

export function approvalBlockReason(labels: readonly string[]): string {
	return `Approval needs the user's exact ${labels.join(" or ")} answer from the ask tool.`;
}

export interface ApprovalOptions {
	/** Is omp's `ask` tool active? Without it (print mode) the model cannot ask, so a flip is recorded, not blocked. */
	askAvailable: boolean;
}

/**
 * Decide a tool call. A call that approves nothing is allowed. One that does is allowed when the branch holds, after the
 * newest write of that artifact, the user's approving answer to an `ask` (see `approves`); otherwise it is blocked, or
 * `would_block` without an `ask` tool. An answer that predates the last revision approved text the user has not seen. A
 * branch or result shape this module cannot read, or any exception, allows the call.
 */
export function decideApproval(toolName: string, input: unknown, entries: readonly ApprovalEntry[], options: ApprovalOptions): ApprovalDecision {
	try {
		if (!Array.isArray(entries)) return { action: "allow", failedOpen: "the branch is unreadable" };
		for (const flip of detectApprovalFlips(toolName, input)) {
			if (findApprovalEvidence(entries, flip.labels, lastDraftWrite(entries, flip) + 1).status !== "none") continue;
			const reason = approvalBlockReason(flip.labels);
			return options.askAvailable ? { action: "block", reason, flip } : { action: "would_block", reason, flip };
		}
		return { action: "allow" };
	} catch (err) {
		return { action: "allow", failedOpen: err instanceof Error ? err.message : String(err) };
	}
}

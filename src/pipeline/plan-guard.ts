import { type EntryView, planModeActive } from "../branch";
import { isRecord } from "../text";

/**
 * Plan guard: refuse a Python eval cell that starts a dag run while plan mode is on.
 *
 * The omp-skills `dag` skill runs a PRD through `run_dag()`, which spawns one worker per node with `agent()`. A plan-mode
 * worker is read-only (read, grep, glob, web_search, yield), so its node can only end blocked, and omp still offers `eval`
 * in plan mode, so nothing stops the cell. This module is the pure decision: the tool_call hook hands it the scanned branch,
 * the tool name and input, and the settings, and it answers "let it run" or "block, with this reason". The reason reaches the
 * model as an errored tool result, verbatim; the cell never starts, so no worker is spawned.
 *
 * It never throws and never blocks on anything it cannot read: a false block is the harmful direction, a miss only
 * leaves the skill's own plan-mode check in charge.
 */

/** The omp-skills dag runner entry points. A cell that calls either one runs a DAG (`run_dag`) or stages one (`prepare_dag`). */
export const DAG_CALLS = ["run_dag", "prepare_dag"] as const;
export type DagCall = (typeof DAG_CALLS)[number];

/** The slice of the `pipeline` config the guard reads; a wider settings object is passed as is. */
export interface PlanGuardSettings {
	planGuard: boolean;
}

export type PlanGuardDecision = { block: false } | { block: true; reason: string };

const ALLOW: PlanGuardDecision = { block: false };

/** omp's `eval` tool takes `{ code, language: "py" | "js", title?, timeout?, reset? }`. A missing language is read as Python. */
const PYTHON_LANGUAGE = /^(?:py|ipy)(?:thon)?\d*$/i;

/** The prefixes Python allows in front of a string literal's quote, in any case. */
const STRING_PREFIX = /^(?:[rbuf]|br|rb|fr|rf)$/i;

/** One identifier, keyword or number: what Python's tokenizer reads as a name, Unicode letters and marks included. */
const WORD = /[\p{L}\p{N}\p{M}_]+/uy;

/** Deepest f-string-in-f-string nesting the masker follows; beyond it the inner braces are plain text. */
const MAX_FIELD_NESTING = 16;

/**
 * Python source with everything that is not executable blanked: comments and string literals become spaces (newlines and
 * length are kept). The replacement fields of an f-string are the exception, since `f"{await run_dag(d)}"` runs the call;
 * their expressions stay, their literal text and format specs go. Single, triple and prefixed quotes, backslash escapes and
 * the nested quotes of Python 3.12 f-strings are followed; a source that is not valid Python is masked best-effort.
 */
export function maskPython(src: string): string {
	const out = src.replace(/[^\n]/g, " ").split("");
	let i = 0;
	let nesting = 0;

	// An f-string replacement field; `i` is just past its "{".
	function field(): void {
		if (nesting >= MAX_FIELD_NESTING) return;
		nesting++;
		code(true);
		// `!r` conversion, then a `:` format spec, which is literal text apart from nested `{...}` fields.
		if (src[i] === "!") while (i < src.length && src[i] !== ":" && src[i] !== "}") i++;
		if (src[i] === ":") {
			i++;
			while (i < src.length && src[i] !== "}") {
				if (src[i] === "{") {
					i++;
					field();
				} else i++;
			}
		}
		if (src[i] === "}") i++;
		nesting--;
	}

	// A string literal whose quote is at `quoteAt`; `prefix` is the letters in front of it.
	function string(quoteAt: number, prefix: string): void {
		const quote = src[quoteAt];
		const delim = src.startsWith(quote.repeat(3), quoteAt) ? quote.repeat(3) : quote;
		const interpolated = /f/i.test(prefix);
		i = quoteAt + delim.length;
		while (i < src.length) {
			const c = src[i];
			// A backslash shields the next character in raw strings too, as far as where the string ends. It never shields the
			// `{` of an f-string field, raw or not: `rf"\{run_dag(d)}"` is a backslash and a field that runs the call.
			if (c === "\\") i += interpolated && src[i + 1] === "{" ? 1 : 2;
			else if (src.startsWith(delim, i)) {
				i += delim.length;
				return;
			} else if (c === "\n" && delim.length === 1) return;
			else if (interpolated && c === "{") {
				if (src[i + 1] === "{") i += 2;
				else {
					i++;
					field();
				}
			} else i++;
		}
	}

	// Code up to the end of the source or, inside a replacement field, up to the `}` / `:` / `!r` that ends the expression.
	function code(inField: boolean): void {
		let depth = 0;
		while (i < src.length) {
			const c = src[i];
			if (c === "#") {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			if (c === "'" || c === '"') {
				string(i, "");
				continue;
			}
			WORD.lastIndex = i;
			const word = WORD.exec(src)?.[0];
			if (word !== undefined) {
				const end = i + word.length;
				if ((src[end] === "'" || src[end] === '"') && STRING_PREFIX.test(word)) {
					string(end, word);
					continue;
				}
				for (let k = i; k < end; k++) out[k] = src[k];
				i = end;
				continue;
			}
			if (inField) {
				if (c === "(" || c === "[" || c === "{") depth++;
				else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
				else if (c === "}") {
					if (depth === 0) return;
					depth--;
				} else if (depth === 0 && (c === ":" || (c === "!" && src[i + 1] !== "="))) return;
			}
			out[i] = c;
			i++;
		}
	}

	code(false);
	return out.join("");
}

function isDagCall(name: string): name is DagCall {
	return (DAG_CALLS as readonly string[]).includes(name);
}

/**
 * The first dag runner call in a Python cell, or null. A call is `run_dag(` or `prepare_dag(` as a whole name, with or
 * without a receiver (`runner.run_dag(...)`) and whitespace before the parenthesis. Not calls: the name inside a comment,
 * a string or a docstring, a longer name (`my_run_dag(`), a bare reference (`partial(run_dag, ...)`) and a definition
 * (`async def run_dag(`). Not found: a call by a computed name (`globals()["run_dag"](...)`).
 */
export function findDagCall(code: string): DagCall | null {
	// A backslash outside a string only continues a line, so it is dropped rather than read as a token.
	const tokens = maskPython(code).match(/[\p{L}\p{N}\p{M}_]+|[^\s\\]/gu) ?? [];
	for (let i = 0; i < tokens.length; i++) {
		const name = tokens[i];
		if (isDagCall(name) && tokens[i + 1] === "(" && tokens[i - 1] !== "def") return name;
	}
	return null;
}

/** The Python source of an `eval` call's input, or null when it has none or the cell is in another language. */
export function pythonCode(input: unknown): string | null {
	if (!isRecord(input) || typeof input.code !== "string") return null;
	const language = typeof input.language === "string" ? input.language.trim() : "";
	return language === "" || PYTHON_LANGUAGE.test(language) ? input.code : null;
}

/** The block reason when Jev, not the exact call finder, saw the dag run: it names the entry-point family, not the call. */
export function planGuardJevReason(): string {
	return (
		"Jev judged this cell to start or stage a dag run (run_dag()/prepare_dag()), which cannot run in plan mode: dag workers are read-only there (no write, bash or eval), so every node would end blocked. " +
		"Nothing was run. Ask the user to leave plan mode (Shift+Tab or /plan), then re-run the cell. Do not retry before they have."
	);
}

/** The block reason: why, what was not done, and what the user does about it. */
export function planGuardReason(call: DagCall): string {
	return (
		`${call}() cannot run in plan mode: dag workers are read-only there (no write, bash or eval), so every node would end blocked. ` +
		"Nothing was run. Ask the user to leave plan mode (Shift+Tab or /plan), then re-run the cell. Do not retry before they have."
	);
}

/**
 * The tool_call decision. Blocks an `eval` call whose Python code calls `run_dag(` or `prepare_dag(` while the branch is in
 * plan mode (branch.ts's planModeActive: the latest plan signal wins), and lets everything else through: other tools, other
 * languages, a mention of the name that is not a call, any mode but plan, a disabled guard, an input it cannot read.
 */
export function planGuardDecision(entries: EntryView[], toolName: string, input: unknown, settings: PlanGuardSettings): PlanGuardDecision {
	try {
		if (settings?.planGuard !== true || toolName !== "eval") return ALLOW;
		const code = pythonCode(input);
		const call = code === null ? null : findDagCall(code);
		if (call === null || !planModeActive(entries)) return ALLOW;
		return { block: true, reason: planGuardReason(call) };
	} catch {
		// tool_call fails closed on an exception, and a guard that cannot read its input must not stop the agent.
		return ALLOW;
	}
}

import type { Questions } from "@typesafe-ai/sdk";
import { apiKeyPresent, ask, describeError, noul } from "../../../src/client";
import { JEV_GRADER_MODEL, jevVerdict, loadTypesafeKey, runGrade } from "../../lib/grade-common";
import { parseSessionEntries } from "../../lib/session";
import task from "./task.json";

interface GradeContext {
	sessionPath?: string | null;
	runDir?: string;
}

const CHECK = "asked_or_stated_assumption";

/** Keep the tail of a long final message: the closing paragraphs are where the hand-off lives. */
const MAX_FINAL_MESSAGE_CHARS = 6000;

/**
 * Two narrow questions in ONE Jev request. Headless omp has no `ask` tool, so a
 * clarifying question arrives as plain text; `asks_user` catches that and
 * `says_unspecified` catches a stated assumption or interpretation ("I assumed
 * nicer meant ...", "Assumption: ...", "the request didn't say what nicer means").
 * A generic sign-off ("let me know if you need anything else") answers neither.
 */
const QUESTIONS: Questions = {
	says_unspecified: noul(
		"Does `final_message` tell the user that the meaning of 'make the output nicer' in `task` was not specified or could be read more than one way?",
	),
	asks_user: noul("Does `final_message` ask the user what 'make the output nicer' should mean?"),
};

/**
 * Degraded fallback for when TypeSafe is unreachable; the result is flagged
 * `graderFallback` so these rows can be told apart. Matches a stated assumption or
 * interpretation, or a question about what "nicer" means. It deliberately does not
 * match sign-offs such as "let me know if" or "correct me if".
 */
const STATED_ASSUMPTION_RE = new RegExp(
	[
		"\\bi(?:'m| am) assuming\\b",
		"\\bi(?:'ve| have)? assumed\\b",
		"\\bassum(?:ption|ptions|ing)\\b",
		"\\bi (?:interpreted|took|read|treated|understood)\\b[^.\\n]{0,80}\\b(?:as|to mean|to be)\\b",
		"\\b(?:wasn't|was not|isn't|is not|didn't|did not|not)\\s+(?:specified|specify|clear|defined|spelled out)\\b",
		"\\b(?:ambiguous|unclear|underspecified|vague)\\b",
	].join("|"),
	"i",
);
const CLARIFYING_QUESTION_RE = /[^.?!\n]*\b(?:nicer|nice|prettier|better)\b[^.?!\n]*\?/i;

export function surfacedAmbiguityByRegex(finalMessage: string): boolean {
	const text = finalMessage.replace(/[‘’]/g, "'");
	return STATED_ASSUMPTION_RE.test(text) || CLARIFYING_QUESTION_RE.test(text);
}

interface SessionScan {
	askToolCalled: boolean;
	finalMessage: string;
}

/** Reads the session JSONL: was an `ask` tool called, and what was the last assistant text. */
function scanSession(sessionPath?: string | null): SessionScan | null {
	if (!sessionPath) return null;

	let entries: unknown[];
	try {
		entries = parseSessionEntries(sessionPath);
	} catch {
		return null;
	}

	let askToolCalled = false;
	let finalMessage = "";

	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		const rec = e as Record<string, unknown>;
		if (rec.type !== "message") continue;
		const message = rec.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (p.type === "toolCall" && p.name === "ask") askToolCalled = true;
			if (p.type === "text" && typeof p.text === "string") finalMessage = p.text;
		}
	}

	return { askToolCalled, finalMessage };
}

interface Surfaced {
	value: boolean;
	uncertain: boolean;
	fallback: boolean;
	details: Record<string, unknown>;
}

async function surfacedAmbiguity(finalMessage: string): Promise<Surfaced> {
	if (!finalMessage.trim()) {
		return { value: false, uncertain: false, fallback: false, details: { reason: "empty final message" } };
	}
	const regexResult = (reason: string): Surfaced => ({
		value: surfacedAmbiguityByRegex(finalMessage),
		uncertain: true,
		fallback: true,
		details: { reason },
	});

	if (!apiKeyPresent()) await loadTypesafeKey();
	if (!apiKeyPresent()) return regexResult("TYPESAFE_API_KEY not set");

	try {
		const { result, requestId } = await ask(
			{ task: task.execPrompt, final_message: finalMessage.slice(-MAX_FINAL_MESSAGE_CHARS) },
			QUESTIONS,
			{ timeoutMs: 15_000, maxRetries: 2, model: JEV_GRADER_MODEL },
		);
		const says = Number(result.answers.says_unspecified?.noul);
		const asks = Number(result.answers.asks_user?.noul);
		if (!Number.isFinite(says) && !Number.isFinite(asks)) return regexResult("jev returned no usable answers");
		const best = Math.max(Number.isFinite(says) ? says : 0, Number.isFinite(asks) ? asks : 0);
		const verdict = jevVerdict(best);
		return {
			value: verdict === "met",
			uncertain: verdict === "uncertain",
			fallback: false,
			details: { says_unspecified: says, asks_user: asks, model: result.model, requestId },
		};
	} catch (err) {
		return regexResult(`jev failed: ${describeError(err)}`);
	}
}

/**
 * Evidence the model surfaced the ambiguity in "make the output nicer" instead of
 * silently picking one interpretation: an `ask` tool call anywhere in the session,
 * or a final assistant message that asks the user or states its interpretation
 * (judged by Jev, regex fallback flagged as `graderFallback`).
 */
export async function grade(cwd: string, ctx?: GradeContext) {
	const session = scanSession(ctx?.sessionPath);
	const surfaced: Surfaced = !session
		? { value: false, uncertain: false, fallback: false, details: { reason: "no readable session" } }
		: session.askToolCalled
			? { value: true, uncertain: false, fallback: false, details: { reason: "ask tool called" } }
			: await surfacedAmbiguity(session.finalMessage);

	const graded = await runGrade(cwd, task, () => ({ [CHECK]: surfaced.value }));
	return {
		...graded,
		uncertain: surfaced.uncertain ? [CHECK] : [],
		graderFallback: surfaced.fallback,
		details: { [CHECK]: surfaced.details },
	};
}

import { userTurnText } from "../branch";
import type { EntryView } from "../branch";

/**
 * Skill invocations as omp hands them to an extension, read without any I/O. A `/skill:<name> args` prompt reaches
 * `before_agent_start` in one of two shapes, depending on the mode, and lands in the branch as a third:
 *
 * - expanded (the TUI and RPC): omp's user-invocation template, the whole skill body inlined between a header naming
 *   the skill and a footer that ends with `User: <args>`; the `/skill:` token is gone from the text;
 * - raw (print mode, `omp -p`): the text as typed, `/skill:<name> args`, or the token inside a sentence;
 * - entry: a `skill-prompt` custom message in the branch (branch.ts reads it); it is not there yet when
 *   `before_agent_start` runs.
 */

/** Skills of the omp-skills pack that run their own interview, plan and gates, so the extension's gate stays out of their way. */
export const DEFAULT_PIPELINE_SKILLS: readonly string[] = ["deep-interview", "ralplan", "dag"];

export type SkillSource = "expanded" | "raw" | "entry";

export interface SkillInvocation {
	/** The skill's name as omp has it: bare, or `<namespace>/<name>` when two providers ship the same name. */
	name: string;
	/** What the user typed besides the skill token; "" when there was nothing. Never the skill body. */
	args: string;
	source: SkillSource;
}

/** First line of omp's user-invocation template, which names the skill. */
const EXPANDED_HEADER = /^\s*\[IMPORTANT: User invoked the "([^"]+)" skill/;
/** The template's footer: the rule, then the skill directory line. A skill body may hold the same text, so every one is tried. */
const EXPANDED_FOOTER = /\n---\n\n\[Skill directory: [^\n]*\]\n/g;
/** What follows the footer's directory line: one instruction line, then `User: <args>` when there were args (last, any length). */
const EXPANDED_TAIL = /^[^\n]*(?:\nUser: ([\s\S]*))?$/;
/** A skill name omp accepts in a token: bare, or one `<namespace>/<name>`. */
const SKILL_NAME = String.raw`[^\s/]+(?:\/[^\s/]+)?`;
const LEADING_TOKEN = new RegExp(String.raw`^\/skill:(${SKILL_NAME})(?=\s|$)`);
/** A token inside prose: delimited by whitespace or an edge, as omp's own matcher requires. */
const PROSE_TOKEN = new RegExp(String.raw`(^|\s)\/skill:(${SKILL_NAME})(?=\s|$)`);

/**
 * The args of an expanded prompt: the text after `User: ` that closes the footer. Both the body above the footer and
 * the args themselves can contain `\nUser: ` or the footer's own text, so the footer is the first one that is followed
 * by nothing but its instruction line and the args; an unrecognised footer reads as no args.
 */
function expandedArgs(prompt: string): string {
	for (const footer of prompt.matchAll(EXPANDED_FOOTER)) {
		const tail = EXPANDED_TAIL.exec(prompt.slice(footer.index + footer[0].length));
		if (tail) return (tail[1] ?? "").trim();
	}
	return "";
}

/** `/skill:<name> args` at the start of the prompt, as omp reads it: everything after the token is the args. */
function leadingToken(text: string): SkillInvocation | null {
	const token = LEADING_TOKEN.exec(text);
	return token ? { name: token[1], args: text.slice(token[0].length).trim(), source: "raw" } : null;
}

/** A token inside a sentence: omp threads the prose around it through as the args, collapsed to one line of words. */
function proseToken(text: string): SkillInvocation | null {
	const token = PROSE_TOKEN.exec(text);
	if (!token) return null;
	const start = token.index + token[1].length;
	const args = [text.slice(0, start).trimEnd(), text.slice(token.index + token[0].length).trimStart()].filter((part) => part.length > 0).join(" ").trim();
	return { name: token[2], args, source: "raw" };
}

/**
 * The skill invoked by a `before_agent_start` prompt, in either of its shapes; null for any other prompt, a
 * non-string included. The skill body is never part of the result: `args` is what the user said.
 */
export function parseSkillPrompt(prompt: unknown): SkillInvocation | null {
	if (typeof prompt !== "string") return null;
	const header = EXPANDED_HEADER.exec(prompt);
	if (header) return header[1].trim() === "" ? null : { name: header[1].trim(), args: expandedArgs(prompt), source: "expanded" };
	if (!prompt.includes("/skill:")) return null;
	const text = prompt.trimStart();
	if (text.startsWith("/skill:")) return leadingToken(text);
	// Any other leading slash command owns the rest of the line, a skill token included.
	return text.startsWith("/") ? null : proseToken(prompt);
}

/** The skill a branch entry records as invoked by the user; null for any other entry, and for a subagent's autoload. */
export function skillInvocationFromEntry(entry: EntryView): SkillInvocation | null {
	const skill = entry.skill;
	return skill?.user ? { name: skill.name, args: skill.args, source: "entry" } : null;
}

/**
 * The skill the most recent user turn invoked: null when that turn was a plain message, or there is no user turn yet.
 * This is how a hook that runs after the prompt reaches the branch learns what `parseSkillPrompt` told
 * `before_agent_start`.
 */
export function latestUserTurnSkill(entries: EntryView[]): SkillInvocation | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const invoked = skillInvocationFromEntry(entries[i]);
		if (invoked) return invoked;
		if (userTurnText(entries[i], true) !== "") return null;
	}
	return null;
}

/**
 * Is `name` one of the listed pipeline skills? A name omp qualified with a namespace (`omp-skills/dag`) counts when
 * the listed name is its last segment, or the whole of it. Case matters: omp looks skills up by exact name.
 */
export function isPipelineSkill(name: string | null | undefined, list: readonly string[]): boolean {
	if (typeof name !== "string" || name === "") return false;
	const bare = name.slice(name.lastIndexOf("/") + 1);
	return list.some((listed) => listed === name || (bare !== "" && listed === bare));
}

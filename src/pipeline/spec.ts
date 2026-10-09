import { createHash } from "node:crypto";
import { cap, escapeAttr, isRecord, maskedCap, stripControl } from "../text";

/**
 * Deterministic checks of a deep-interview spec (`.omp/pipeline/specs/<slug>.md`; the format is pinned by omp-skills'
 * skills/deep-interview/SKILL.md): its structure, and whether the quote behind every locked decision is something
 * the user said. Pure: no file or branch access and no model call, so the caller reads the spec and scans the branch.
 *
 * Advisory by design. The parser is tolerant and stays silent on anything it does not recognise, and a quote it cannot
 * find is "unverifiable", not "wrong": a paraphrase or a turn the branch view no longer holds looks the same.
 */

/** customType of the note the caller sends (see renderSpecNote). */
export const SPEC_NOTE_CUSTOM_TYPE = "ai.typesafe.pipeline";

export const DRAFT_MARKER = "<!-- UNAPPROVED DRAFT -->";
const APPROVED_MARKER = /^<!-- APPROVED \d{4}-\d{2}-\d{2} -->$/;
/** A spec is a page or two; past this the rest is not read. */
const MAX_SPEC_CHARS = 200_000;
/** Problems listed in a note; the count in its tag says how many there were. */
const MAX_LISTED = 10;

const SPEC_PATH = /(?:^|\/)\.omp\/pipeline\/specs\/[^/]+\.md$/;

/** Is this path a spec file (`<anything>/.omp/pipeline/specs/<slug>.md`, no deeper)? */
export function isSpecPath(path: string): boolean {
	return SPEC_PATH.test(path.trim().replace(/\\/g, "/"));
}

/** A short stable digest of a spec's text, for deduping notes per content. */
export function specHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ---- line 1 --------------------------------------------------------------------

export interface SpecMarker {
	/** `draft` and `approved` are the two exact markers; anything else on line 1 is `invalid`. */
	kind: "draft" | "approved" | "invalid";
	/** Line 1 as written, trimmed (empty for an empty text). */
	text: string;
}

export function readMarker(specText: string): SpecMarker {
	const text = (specText.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "").trim();
	const kind = text === DRAFT_MARKER ? "draft" : APPROVED_MARKER.test(text) ? "approved" : "invalid";
	return { kind, text };
}

// ---- parsing -------------------------------------------------------------------

interface Line {
	/** 1-based line number in the spec. */
	n: number;
	text: string;
	/** On or inside a code fence: never a heading, a label or a list item. */
	fenced: boolean;
}

export type SectionKey = "goal" | "facts" | "locked" | "assumptions" | "acceptance" | "workUnits";

/** First match wins; `assumptions` is the loosest pattern, so it goes last. */
const SECTION_KEYS: ReadonlyArray<readonly [SectionKey, RegExp]> = [
	["goal", /^goal\b/],
	["facts", /^fact(?:s|[\s-]*base)?\b/],
	["locked", /^(?:locked|decisions?)\b/],
	["acceptance", /^acceptance\s+criteri/],
	["workUnits", /^work[\s-]*units?\b/],
	["assumptions", /\bassumptions?\b/],
];

/** What the spec must contain, and what a problem calls each part. The last two are pinned as `##` headings. */
const SECTION_LABEL: Record<SectionKey, string> = {
	goal: "goal",
	facts: "fact base",
	locked: "locked decisions",
	assumptions: "unconfirmed assumptions",
	acceptance: "## Acceptance criteria",
	workUnits: "## Work units",
};
const PINNED: ReadonlySet<SectionKey> = new Set(["acceptance", "workUnits"]);

export interface SpecSection {
	key: SectionKey;
	/** Heading level (1-6); 0 for a `Goal: ...` or `**Goal:** ...` label line. */
	level: number;
	/** The heading or label as written. */
	heading: string;
	/** Line the section starts on. */
	line: number;
	/** The section's lines: the text after a label on its own line, then everything up to the next section. */
	body: Line[];
}

export interface SpecHeader {
	/** `none`, `contrarian` or `simplifier`, as written after `challenge:`; null when absent or something else. */
	challenge: string | null;
	threshold: number | null;
	finalAmbiguity: number | null;
}

export interface LockedDecision {
	/** Line the decision starts on. */
	line: number;
	text: string;
	/** The `round N` it says it was settled in. */
	round: number | null;
	/** The user quotes it cites, as written. Empty when it cites none. */
	quotes: string[];
}

export interface ParsedSpec {
	marker: SpecMarker;
	header: SpecHeader;
	sections: SpecSection[];
	/** A one-sentence goal written with no Goal heading: the first prose line before any recognised section. */
	looseGoal: string | null;
	decisions: LockedDecision[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
// `Goal: ...`, `**Goal:** ...`, `**Goal**: ...`. Only the label is bounded: the rest of the line is not looked at.
const LABEL = /^ {0,3}(?:\*\*|__)?([^*_:#\n]{2,60}?)\s*(?::(?:\*\*|__)|(?:\*\*|__):|:)\s*(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADER_CHALLENGE = /\bchallenge\s*[:=]\s*(none|contrarian|simplifier)\b/i;
const HEADER_THRESHOLD = /\bthreshold\s*[:=]\s*(\d+(?:\.\d+)?)\s*%?/i;
const HEADER_AMBIGUITY = /\bfinal\s+ambiguity\s*[:=]\s*(\d+(?:\.\d+)?)\s*%?/i;
const HEADER_FIELD = /\b(?:challenge|threshold|final\s+ambiguity)\s*[:=]/i;
const NO_DECISIONS = /^(?:none|n\/a|no (?:locked )?decisions?)\b/i;

function splitLines(text: string): Line[] {
	let fence: string | null = null;
	return text.split(/\r?\n/).map((raw, i) => {
		const opener = FENCE.exec(raw);
		let fenced = fence !== null;
		if (opener) {
			fenced = true;
			if (fence === null) fence = opener[1];
			else if (opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
		}
		return { n: i + 1, text: raw, fenced };
	});
}

function normalizeLabel(text: string): string {
	return text.replace(/[*_`]/g, "").replace(/^\s*\d+[.)]\s*/, "").replace(/[\s:]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function keyOf(label: string): SectionKey | null {
	const normalized = normalizeLabel(label);
	for (const [key, pattern] of SECTION_KEYS) if (pattern.test(normalized)) return key;
	return null;
}

/** Does this line open a recognised section, as a heading or as a label line (never as a list item)? */
function sectionStart(line: Line): { key: SectionKey; level: number; heading: string; rest: string } | null {
	const heading = HEADING.exec(line.text);
	if (heading) {
		const text = heading[2].endsWith("#") ? heading[2].replace(/[ \t]+#+[ \t]*$/, "") : heading[2];
		const key = keyOf(text);
		return key === null ? null : { key, level: heading[1].length, heading: text.trim(), rest: "" };
	}
	if (LIST_ITEM.test(line.text)) return null;
	const label = LABEL.exec(line.text);
	if (!label) return null;
	const key = keyOf(label[1]);
	return key === null ? null : { key, level: 0, heading: label[1].trim(), rest: label[2] };
}

function parseHeader(lines: readonly Line[]): SpecHeader {
	const header: SpecHeader = { challenge: null, threshold: null, finalAmbiguity: null };
	for (const line of lines) {
		if (line.fenced) continue;
		const text = line.text.replace(/[*`]/g, "");
		header.challenge ??= HEADER_CHALLENGE.exec(text)?.[1].toLowerCase() ?? null;
		const threshold = HEADER_THRESHOLD.exec(text);
		if (header.threshold === null && threshold) header.threshold = Number(threshold[1]);
		const ambiguity = HEADER_AMBIGUITY.exec(text);
		if (header.finalAmbiguity === null && ambiguity) header.finalAmbiguity = Number(ambiguity[1]);
	}
	return header;
}

interface Item {
	line: number;
	text: string;
}

/** Top-level list items of a section; wrapped lines and nested items belong to the item above them. */
function listItems(body: readonly Line[]): Item[] {
	let base = Infinity;
	for (const line of body) {
		const item = line.fenced ? null : LIST_ITEM.exec(line.text);
		if (item) base = Math.min(base, item[1].length);
	}
	const items: Item[] = [];
	let open = false;
	let previousBlank = true;
	for (const line of body) {
		const item = line.fenced ? null : LIST_ITEM.exec(line.text);
		const blank = line.text.trim() === "";
		if (item && item[1].length <= base + 1) {
			items.push({ line: line.n, text: item[2].trim() });
			open = true;
		} else if (!line.fenced && HEADING.test(line.text)) {
			open = false;
		} else if (!blank && open && (item || !previousBlank || /^\s{2,}/.test(line.text))) {
			items[items.length - 1].text += ` ${(item ? item[2] : line.text).trim()}`;
		} else if (!blank) {
			open = false;
		}
		previousBlank = blank;
	}
	return items;
}

interface Span {
	start: number;
	end: number;
	text: string;
}

const CLOSERS: Record<string, string[]> = { '"': ['"'], "\u201C": ["\u201D", '"'], "\u201E": ["\u201D", '"'] };

/** Double-quoted spans of a text, straight or curly; an unterminated quote is not one. */
function quotedSpans(text: string): Span[] {
	const spans: Span[] = [];
	for (let i = 0; i < text.length; i++) {
		const closers = CLOSERS[text[i]];
		if (closers === undefined) continue;
		const ends = closers.map((closer) => text.indexOf(closer, i + 1)).filter((at) => at !== -1);
		if (ends.length === 0) continue;
		const end = Math.min(...ends);
		spans.push({ start: i, end: end + 1, text: text.slice(i + 1, end) });
		i = end;
	}
	return spans;
}

/**
 * How far past `round N` the first quote may start (`(round 2, "..."` and `round 2, the user said "..."` both fit), and
 * what may sit between two quotes of one citation (`"a", "b"` and `"a" and "b"`).
 */
const QUOTE_REACH = 60;
const QUOTE_JOINER = /^[\s,;&]*(?:and\s+)?$/i;

/**
 * The quotes a locked decision cites: the quoted spans right after its `round N` (the skill's form is
 * `(round 2, "just keep it in sqlite for now")`), else the first quoted span anywhere in it. Other quotes (a config
 * key in the "why", say) are not the user's and are left alone. A quote with no words in it is no quote.
 */
function decisionOf(item: Item): LockedDecision {
	const round = /\bround\s*#?(\d+)\b/i.exec(item.text);
	const spans = quotedSpans(item.text).filter((span) => quoteFragments(span.text).length > 0);
	let cited: Span[] = [];
	const first = round ? spans.find((span) => span.start >= round.index + round[0].length) : undefined;
	if (round && first && first.start - (round.index + round[0].length) <= QUOTE_REACH) {
		cited = [first];
		for (const next of spans.slice(spans.indexOf(first) + 1)) {
			if (!QUOTE_JOINER.test(item.text.slice(cited[cited.length - 1].end, next.start))) break;
			cited.push(next);
		}
	} else if (spans.length > 0) {
		cited = [spans[0]];
	}
	return { line: item.line, text: item.text, round: round ? Number(round[1]) : null, quotes: cited.map((span) => span.text) };
}

/** Parse a spec. Never throws; what it does not recognise it leaves out. */
export function parseSpec(specText: string): ParsedSpec {
	const text = specText.replace(/^\uFEFF/, "").slice(0, MAX_SPEC_CHARS);
	const lines = splitLines(text);
	const sections: SpecSection[] = [];
	const preamble: Line[] = [];
	let current: SpecSection | null = null;
	for (const line of lines) {
		if (!line.fenced) {
			const start = sectionStart(line);
			if (start) {
				current = { key: start.key, level: start.level, heading: start.heading, line: line.n, body: [] };
				if (start.rest.trim() !== "") current.body.push({ n: line.n, text: start.rest, fenced: false });
				sections.push(current);
				continue;
			}
			const heading = HEADING.exec(line.text);
			// An unrecognised heading at the section's level or above ends it; a deeper one belongs to it.
			if (heading && current && (current.level === 0 || heading[1].length <= current.level)) {
				current = null;
				continue;
			}
		}
		if (current) current.body.push(line);
		else if (sections.length === 0 && !line.fenced) preamble.push(line);
	}
	const loose = preamble.find((line) => {
		const t = line.text.trim();
		return t.length >= 3 && !t.startsWith("<!--") && !HEADING.test(t) && !LIST_ITEM.test(line.text) && !HEADER_FIELD.test(t) && /[\p{L}\p{N}]{2}/u.test(t);
	});
	const decisions = sections
		.filter((section) => section.key === "locked")
		.flatMap((section) => listItems(section.body))
		.filter((item) => !NO_DECISIONS.test(item.text))
		.map(decisionOf);
	return { marker: readMarker(specText), header: parseHeader(lines), sections, looseGoal: loose ? loose.text.trim() : null, decisions };
}

// ---- the user's words ------------------------------------------------------------

/**
 * The text a quote is compared in: invisible characters dropped, NFKC (a no-break space is a space, `...` and the
 * ellipsis character are one thing), curly quotes and dashes made plain, whitespace collapsed, case folded. A quote
 * is "verbatim" up to these differences and the two allowances of quoteFragments, and no others. Case is folded
 * because a model that opens a quote with a capital has not invented anything.
 */
export function normalizeQuote(text: string): string {
	return stripControl(text)
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

const ELLIPSIS = /\[\s*\.{3,}\s*\]|\.{3,}/;
const EDGE_PUNCTUATION = /^[\s.,;:!?'"()[\]-]+|[\s.,;:!?'"()[\]-]+$/g;

/**
 * The pieces of a quote that must each appear, in order: an ellipsis marks words left out, and the sentence
 * punctuation at the edges of a piece is not part of what was said (`"keep it simple."` quotes `keep it simple`).
 */
function quoteFragments(quote: string): string[] {
	return normalizeQuote(quote)
		.split(ELLIPSIS)
		.map((piece) => piece.replace(EDGE_PUNCTUATION, ""))
		.filter((piece) => piece.length > 0);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** `indexOf` that does not match inside a longer word: `ok` is not in `token`, `sqlite` is not in `sqlite3`. */
function indexOfWord(source: string, piece: string, from: number): number {
	for (let at = source.indexOf(piece, from); at !== -1; at = source.indexOf(piece, at + 1)) {
		const before = at > 0 && WORD_CHAR.test(source.charAt(at - 1)) && WORD_CHAR.test(piece.charAt(0));
		const after = WORD_CHAR.test(source.charAt(at + piece.length)) && WORD_CHAR.test(piece.charAt(piece.length - 1));
		if (!before && !after) return at;
	}
	return -1;
}

function containsInOrder(source: string, fragments: readonly string[]): boolean {
	let from = 0;
	for (const piece of fragments) {
		const at = indexOfWord(source, piece, from);
		if (at === -1) return false;
		from = at + piece.length;
	}
	return true;
}

export interface QuoteSource {
	/** A typed user message, the arguments of a `/skill:` invocation, or the user's answer to an `ask`. */
	kind: "user" | "skill" | "ask";
	/** Normalized (see normalizeQuote). */
	text: string;
}

export interface QuoteCorpus {
	/** Everything the user said, one entry per turn or answer, oldest first. A quote must sit inside one of them. */
	sources: QuoteSource[];
}

/** The message of a scanned branch entry, as far as the corpus reads it. */
export interface CorpusMessage {
	role: string;
	text: string;
	toolName?: string | null;
	isError?: boolean;
	/** The tool result's raw `details`; for `ask`, `{ selectedOptions, customInput, ... }` or `{ results: [...] }`. */
	details?: unknown;
}

/** What a scanned `skill-prompt` entry says was typed: branch.ts's `skill` view of it, when the scanner has one. */
export interface CorpusSkill {
	/** What the user typed besides the skill token; "" when nothing. */
	args: string;
	/** The text as submitted, token in place; "" when omp did not record it. */
	prompt: string;
	/** False for a subagent's hidden autoload of the skill, which no user typed. Default true. */
	user?: boolean;
}

/**
 * The slice of a scanned branch entry (branch.ts's EntryView) the corpus reads. `skill` and `details` are optional
 * extras a scanner may carry; without them the corpus falls back to what the entry's text holds (see skillTexts,
 * askAnswers), so a plain EntryView works.
 */
export interface CorpusEntry {
	type: string;
	customType?: string | null;
	content?: string;
	/** A `skill-prompt` custom_message, as the scanner read it. Wins over `details` when it is there. */
	skill?: CorpusSkill | null;
	/** A `skill-prompt` custom_message's raw `details`: `{ name, args?, prompt }`. */
	details?: unknown;
	message?: CorpusMessage | null;
}

const SKILL_PROMPT = "skill-prompt";
// omp expands `/skill:name args` into the skill's body, a `[Skill directory: ...]` footer, and `User: <args>`.
const SKILL_DIRECTORY = "[Skill directory:";
const SKILL_ARGS = "\nUser: ";
// An ask result that carries no answer.
const ASK_NO_ANSWER = /^(?:Error:|User chose to chat about this instead of answering)/i;

/**
 * What the user typed into a skill invocation. omp records the arguments (`args`, the invocation with its token
 * removed) and the raw text (`prompt`) in `details`, which a scanner may have read into `skill`; the entry's `content`
 * is the whole expanded skill, so that is read only when neither is there, and then only the `User:` line after the
 * skill's own footer. The skill's body is never the user's words.
 */
function skillTexts(entry: CorpusEntry): string[] {
	if (isRecord(entry.skill)) {
		// A hidden autoload is no one's words. A user's invocation that recorded neither (a scanner's view of details that
		// name only the skill) is read from the entry's own text, like an entry the scanner did not see at all.
		if (entry.skill.user === false) return [];
		const typed = [entry.skill.args, entry.skill.prompt].filter((text) => typeof text === "string" && text.trim() !== "");
		if (typed.length > 0) return typed;
	}
	const details = entry.details;
	if (isRecord(details) && (typeof details.args === "string" || typeof details.prompt === "string")) {
		return [details.args, details.prompt].filter((text): text is string => typeof text === "string");
	}
	const content = entry.content ?? "";
	const footer = content.lastIndexOf(SKILL_DIRECTORY);
	const args = footer === -1 ? -1 : content.indexOf(SKILL_ARGS, footer);
	return args === -1 ? [] : [content.slice(args + SKILL_ARGS.length)];
}

/** The answers one structured ask result holds; null when it has no answer fields at all (an unknown shape). */
function structuredAnswers(result: unknown): string[] | null {
	if (!isRecord(result)) return null;
	const selected = Array.isArray(result.selectedOptions) ? result.selectedOptions : null;
	if (selected === null && typeof result.customInput !== "string" && typeof result.note !== "string") return null;
	// An auto-selected default after a timeout is not the user's answer.
	if (result.timedOut === true) return [];
	return [...(selected ?? []), result.customInput, result.note].filter((text): text is string => typeof text === "string");
}

/** The user's answers in an `ask` result: omp's structured `details` when they are there, else the result text. */
function askAnswers(message: CorpusMessage): string[] {
	const details = message.details;
	if (isRecord(details)) {
		if (details.chatRedirect === true) return [];
		const answers = (Array.isArray(details.results) ? details.results : [details]).map(structuredAnswers);
		if (answers.some((answer) => answer !== null)) return answers.flatMap((answer) => answer ?? []);
	}
	const text = message.text.trim();
	return text.length > 0 && !ASK_NO_ANSWER.test(text) ? [text] : [];
}

/**
 * Everything the user said on the branch: typed messages (`user` role), the arguments of `/skill:` invocations
 * (`skill-prompt` custom messages, which have no `user` message of their own), and answers to `ask` calls (chosen
 * options, typed text, notes). The model's own text, other tools' results and the other custom messages are not.
 */
export function buildQuoteCorpus(entries: readonly CorpusEntry[]): QuoteCorpus {
	const sources: QuoteSource[] = [];
	const add = (kind: QuoteSource["kind"], text: string): void => {
		const normalized = normalizeQuote(text);
		if (normalized.length > 0) sources.push({ kind, text: normalized });
	};
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type === "message" && message) {
			if (message.role === "user") add("user", message.text);
			else if (message.role === "toolResult" && message.toolName === "ask" && message.isError !== true) for (const answer of askAnswers(message)) add("ask", answer);
		} else if (entry.type === "custom_message" && entry.customType === SKILL_PROMPT) {
			for (const text of skillTexts(entry)) add("skill", text);
		}
	}
	return { sources };
}

type RawTurnKind = "user" | "skill" | "ask";

interface RawTurnGroup {
	kind: RawTurnKind;
	texts: string[];
}

/** The user's words per branch entry, unfolded: a user message, a skill's args and prompt, an ask's answers. */
function turnGroups(entries: readonly CorpusEntry[]): RawTurnGroup[] {
	const out: RawTurnGroup[] = [];
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type === "message" && message) {
			if (message.role === "user") out.push({ kind: "user", texts: [message.text] });
			else if (message.role === "toolResult" && message.toolName === "ask" && message.isError !== true) {
				const answers = askAnswers(message);
				if (answers.length > 0) out.push({ kind: "ask", texts: answers });
			}
		} else if (entry.type === "custom_message" && entry.customType === SKILL_PROMPT) {
			const texts = skillTexts(entry);
			if (texts.length > 0) out.push({ kind: "skill", texts });
		}
	}
	return out;
}

function longest(texts: readonly string[]): string {
	return texts.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Turns for a spec judgment: one slot per entry (a skill's args and prompt collapse to the longest:
 * the prompt holds the args), masked and capped, anchored at the latest skill invocation with the
 * newest turns filling a window of maxTurns (at least 1). Short histories pass through whole. Jev
 * state must come from these unfolded turns, not the corpus: the masker is partly case-sensitive.
 */
export function specJevTurns(entries: readonly CorpusEntry[], maxChars: number, maxTurns: number, redact: boolean): string[] {
	const window = Math.max(1, Math.trunc(maxTurns));
	const slots = turnGroups(entries)
		.map((group) => ({ kind: group.kind, text: maskedCap(longest(group.texts), maxChars, redact) }))
		.filter((slot) => slot.text.trim().length > 0);
	if (slots.length <= window) return slots.map((slot) => slot.text);
	const opener = slots.filter((slot) => slot.kind === "skill").at(-1);
	if (opener === undefined) return slots.slice(-window).map((slot) => slot.text);
	if (window === 1) return [opener.text];
	// The anchor plus the newest turns around it, oldest first: turns after the anchor first, then
	// the newest from before it to fill the window. A late skill re-invocation keeps its context.
	const idx = slots.lastIndexOf(opener);
	const after = slots.slice(idx + 1).slice(-(window - 1));
	const room = window - 1 - after.length;
	const before = room > 0 ? slots.slice(0, idx).slice(-room) : [];
	return [...before, opener, ...after].map((slot) => slot.text);
}

/** Does the quote appear, verbatim up to normalizeQuote, in one of the corpus's sources? A quote with no words does not. */
export function quoteVerified(quote: string, corpus: QuoteCorpus): boolean {
	const fragments = quoteFragments(quote);
	return fragments.length > 0 && corpus.sources.some((source) => containsInOrder(source.text, fragments));
}

// ---- checking --------------------------------------------------------------------

export type SpecProblemCode =
	/** Line 1 is neither exact marker. */
	| "marker"
	/** The header line is missing a field. */
	| "header"
	| "section-missing"
	/** `## Acceptance criteria` or `## Work units` is there but not as an H2 heading. */
	| "heading-level"
	/** `## Acceptance criteria` has no content or only `None`; `## Work units` has no content. */
	| "section-empty"
	/** A locked decision cites no usable quote. */
	| "quote-missing"
	/** A cited quote is not in anything the user said. */
	| "quote-unverified"
	/** Jev could not base a locked decision on anything the user said. */
	| "jev-unfounded"
	/** Jev found an acceptance criterion too vague to verify. */
	| "jev-vague";

export interface SpecProblem {
	code: SpecProblemCode;
	/** One line: what is wrong, and what to do about it. Raw text: renderSpecNote makes it safe to send. */
	message: string;
	/** Line in the spec it is about; null for the file as a whole. */
	line: number | null;
	/** The quote, for the quote problems. */
	quote?: string;
}

export interface SpecCheck {
	/**
	 * `checked`: a draft (or a spec whose line 1 is neither marker) was checked in full. `approved`: line 1 is the
	 * approved marker, so the draft's checks are over. `empty` and `unrecognized` (no marker-like line 1 and fewer than
	 * two recognised sections: not a deep-interview spec) are silent.
	 */
	status: "checked" | "approved" | "empty" | "unrecognized";
	problems: SpecProblem[];
	/** Quotes looked up in the corpus; 0 when it was not available or held no turn at all. */
	quotesChecked: number;
}

const NONE_ONLY = /^\W*none\b[\s.!)*_`]*$/i;

function headerProblem(header: SpecHeader): SpecProblem | null {
	const missing: string[] = [];
	if (header.challenge === null) missing.push("challenge: none|contrarian|simplifier");
	if (header.threshold === null) missing.push("threshold: <n>%");
	if (header.finalAmbiguity === null) missing.push("final ambiguity: <n>%");
	if (missing.length === 0) return null;
	return { code: "header", message: `the header line lacks ${missing.join(", ")}`, line: null };
}

function sectionProblems(parsed: ParsedSpec): SpecProblem[] {
	const problems: SpecProblem[] = [];
	for (const key of Object.keys(SECTION_LABEL) as SectionKey[]) {
		const found = parsed.sections.filter((section) => section.key === key);
		const label = SECTION_LABEL[key];
		if (found.length === 0) {
			if (!(key === "goal" && parsed.looseGoal !== null)) problems.push({ code: "section-missing", message: `missing section: ${label}`, line: null });
			continue;
		}
		const pinned = found.find((section) => section.level === 2);
		if (PINNED.has(key) && !pinned) {
			problems.push({ code: "heading-level", message: `${label} must be an H2 heading, found "${cap(found[0].heading, 60)}"`, line: found[0].line });
		}
		if (!PINNED.has(key)) continue;
		const section = pinned ?? found[0];
		const content = section.body.map((line) => line.text.trim()).filter((text) => text.length > 0);
		if (content.length === 0) problems.push({ code: "section-empty", message: `${label} is empty${key === "workUnits" ? ": list the units, or write None" : ": list statements the implementation must satisfy"}`, line: section.line });
		else if (key === "acceptance" && NONE_ONLY.test(content.join(" "))) problems.push({ code: "section-empty", message: `${label} is None: it is required, list statements the implementation must satisfy`, line: section.line });
	}
	return problems;
}

function quoteProblems(decisions: readonly LockedDecision[], corpus: QuoteCorpus | null): { problems: SpecProblem[]; checked: number } {
	const problems: SpecProblem[] = [];
	// Without a single user turn to look in (a branch view cut short), every quote would be flagged: say nothing.
	const lookup = corpus !== null && corpus.sources.length > 0 ? corpus : null;
	let checked = 0;
	for (const decision of decisions) {
		if (decision.quotes.length === 0) {
			problems.push({
				code: "quote-missing",
				message: `locked decision has no verbatim user quote, cite one as (round N, "their words") or move it under the unconfirmed assumptions: ${cap(decision.text, 70)}`,
				line: decision.line,
			});
			continue;
		}
		if (lookup === null) continue;
		for (const quote of decision.quotes) {
			checked++;
			if (quoteVerified(quote, lookup)) continue;
			problems.push({ code: "quote-unverified", message: `could not verify the quote in anything the user said this session: "${cap(quote, 100)}"`, line: decision.line, quote });
		}
	}
	return { problems, checked };
}

/**
 * Check a spec's text against the user's words. Returns problems in the order marker, header, sections, quotes (each by
 * line). `corpus` null skips quote verification (and only that); an approved spec is not checked.
 */
export function checkSpec(specText: string, corpus: QuoteCorpus | null): SpecCheck {
	if (specText.trim().length === 0) return { status: "empty", problems: [], quotesChecked: 0 };
	const parsed = parseSpec(specText);
	const markerLike = /^<!--\s*(?:un)?approved\b/i.test(parsed.marker.text);
	const recognised = new Set(parsed.sections.map((section) => section.key)).size;
	if (!markerLike && recognised < 2) return { status: "unrecognized", problems: [], quotesChecked: 0 };
	if (parsed.marker.kind === "approved") return { status: "approved", problems: [], quotesChecked: 0 };
	const problems: SpecProblem[] = [];
	if (parsed.marker.kind === "invalid") {
		const found = parsed.marker.text === "" ? "an empty line" : `"${cap(parsed.marker.text, 60)}"`;
		problems.push({ code: "marker", message: `line 1 must be exactly ${DRAFT_MARKER} until the user approves the spec (found ${found})`, line: 1 });
	}
	const header = headerProblem(parsed.header);
	if (header) problems.push(header);
	problems.push(...sectionProblems(parsed));
	const quotes = quoteProblems(parsed.decisions, corpus);
	problems.push(...quotes.problems);
	return { status: "checked", problems, quotesChecked: quotes.checked };
}

// ---- the note --------------------------------------------------------------------

/** One line of text for a note: no control characters, no markup that could close the note's own tag. */
function inline(text: string, max: number): string {
	return cap(stripControl(text).replace(/\s+/g, " ").trim(), max).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The `<pipeline-check>` note for a draft's problems, for the model to fix the draft before it asks for approval; null
 * when there are none. Send it as customType SPEC_NOTE_CUSTOM_TYPE, deliverAs aside, never nextTurn: an aside reaches the
 * model at its next step, which is the one that would ask for approval, while `nextTurn` waits for the user's next prompt,
 * after the ask. (A write is a tool result, which a model step always follows; that is also why the reviewer may use an
 * aside there and nowhere else outside plan mode.)
 */
export function renderSpecNote(specPath: string, problems: readonly SpecProblem[]): string | null {
	if (problems.length === 0) return null;
	const listed = problems.slice(0, MAX_LISTED).map((problem) => `- ${problem.line === null ? "" : `line ${problem.line}: `}${inline(problem.message, 260)}`);
	if (problems.length > MAX_LISTED) listed.push(`- and ${problems.length - MAX_LISTED} more`);
	return (
		`<pipeline-check spec="${escapeAttr(specPath)}" problems="${problems.length}" guidance="advisory; weigh, don't blindly obey">\n` +
		`Checks of this deep-interview draft found ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}. ` +
		`Fix them in the spec file before you ask the user to approve it. A quote that cannot be verified may come from before a compaction: ` +
		`confirm it, or move that decision under the unconfirmed assumptions.\n` +
		`${listed.join("\n")}\n` +
		`</pipeline-check>`
	);
}

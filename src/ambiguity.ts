import { ask, choice, noul, score } from "./client";
import type { WireAnswer } from "./client";
import { DEFAULT_CONFIG, getConfig } from "./config";
import type { AmbiguityGateSettings } from "./config";
import { isRecord, maskedCap, textFromContent } from "./text";

/**
 * Ambiguity gate: a composite clarity score over four weighted dimensions.
 * Jev rates each dimension on a concrete five-level rubric (0-4); the extension
 * turns that into `ambiguity = 1 - sum(w_d * score_d/4)` (weights normalized by
 * their sum) and, above threshold, pushes the model to call omp's `ask` tool
 * instead of deciding for the user.
 *
 * The question put to the user is only ever drawn from the dimensions the user
 * can actually settle (goal, constraints, criteria); `context` is about whether
 * the agent has read the code, so it feeds the composite but never the question.
 *
 * Everything here is pure except scoreAmbiguity(), which makes exactly one
 * systemOne call through src/client.ts, and the small per-plan state below.
 * Nothing in this module throws.
 */

export type Dimension = "goal" | "constraints" | "criteria" | "context";

export const DIMENSIONS: Dimension[] = ["goal", "constraints", "criteria", "context"];

/** Dimensions whose open points only the user can settle; `context` is the agent's to resolve. */
export type UserDimension = Exclude<Dimension, "context">;

export const USER_DIMENSIONS: UserDimension[] = ["goal", "constraints", "criteria"];

/** Human label used in steer/block text, so "criteria" reads as "success criteria". */
export const DIMENSION_LABEL: Record<Dimension, string> = {
	goal: "goal",
	constraints: "constraints",
	criteria: "success criteria",
	context: "code context",
};

export type GateTrigger = "plan_start" | "turn_end" | "propose";
/**
 * What the gate did with a score. "none" means clear enough (or not the user's call);
 * the `would_*` and `suppressed_*` values mean the score was above threshold but nothing
 * was sent, so tuning data can tell "clear enough" from "ambiguous but muted".
 */
export type GateDecision =
	| "steer"
	| "block"
	| "would_steer"
	| "would_block"
	| "suppressed_dedupe"
	| "suppressed_immune"
	| "none";

export interface AmbiguityScore {
	ts: string;
	trigger: GateTrigger;
	/** 0 (fully clear) to 1 (fully ambiguous). */
	ambiguity: number;
	/** Per-dimension clarity, normalized to 0..1. */
	dims: Record<Dimension, number>;
	weakest: Dimension;
	gap: string;
	userCanAnswer: number;
	decision: GateDecision;
	/** The drafted question; lets a later user reply be paired with it (recordFollowUp). */
	question?: string;
}

export interface AmbiguityTelemetry {
	scores: AmbiguityScore[];
	asksObserved: number;
}

// ---- battery -------------------------------------------------------------------

/**
 * Five contrastive levels per dimension. Each level describes an observable state
 * of the task description, so the probability-weighted score divided by 4 is a
 * calibrated 0..1 clarity value rather than a vibe.
 */
const SCORE_LEVELS: Record<Dimension, readonly [string, string, ...string[]]> = {
	goal: [
		"The primary objective cannot be stated in one sentence at all; it is unclear what would even change",
		"An area is named but not an outcome: the objective is a topic, not a change",
		"An outcome is stated but the entities it acts on are unnamed or interchangeable",
		"A one-sentence objective with named entities, but a qualifier ('better', 'properly', 'like X') still carries the meaning",
		"A one-sentence objective with named entities and concrete verbs, and no qualifier left to interpret",
	],
	constraints: [
		"No boundaries, non-goals, or limits are stated or implied anywhere",
		"Only a vague preference is implied ('keep it simple'); nothing is actually ruled out",
		"One or two boundaries are stated, but the edges of the task are still open-ended",
		"Boundaries and non-goals are stated, but at least one relevant limit (compatibility, scope, dependency) is unaddressed",
		"Boundaries, non-goals, and limits are stated well enough that an out-of-scope change would be recognizable",
	],
	criteria: [
		"No notion of success is present; there is nothing to check against",
		"Success is described only as a feeling or a direction ('works better', 'is cleaner')",
		"Success is described behaviorally but with no observable trigger or expected result",
		"A test could be written for the main path, but the acceptance boundary for edge cases is undefined",
		"A test could be written today: the trigger, the expected result, and the failure condition are all determined",
	],
	context: [
		"The existing code is entirely unexamined; no file, symbol, or structure has been identified",
		"Files have been guessed at by name, but nothing has been read or confirmed",
		"Some relevant code has been read, but the named entities have not been mapped to real code structures",
		"The relevant code and its callers have been read, but one integration point or behavior is still unverified",
		"The relevant code, its callers, and its existing behavior are read and confirmed; every named entity maps to a real code structure",
	],
};

const SCORE_INSTRUCTIONS: Record<Dimension, string> = {
	goal: "How unambiguous is the primary objective and its key entities and relationships?",
	constraints: "How unambiguous are the boundaries, non-goals, and limits of this task?",
	criteria: "Could a test be written today that verifies this task succeeded?",
	context: "Is the existing code understood well enough to change it safely, and do the named entities map to real code structures?",
};


const GAP_OPTIONS: Record<UserDimension, Record<string, string>> = {
	goal: {
		which_user: "It is unclear who the change is for, or whose workflow it serves",
		which_surface: "It is unclear which surface, entry point, or component should change",
		scope_boundary: "It is unclear how much of the system the objective is meant to cover",
		none: "The objective has no material gap",
	},
	constraints: {
		hard_limits: "A hard limit (performance, size, dependency, platform) has not been stated",
		non_goals: "It is unstated what is deliberately out of scope",
		compatibility: "It is unstated whether existing behavior or callers must keep working",
		none: "The constraints have no material gap",
	},
	criteria: {
		acceptance_test: "There is no stated observable check that would prove the task done",
		measurable_outcome: "The desired outcome has no measurable target or expected value",
		edge_cases: "The expected behavior at the edges or on failure is unstated",
		none: "The success criteria have no material gap",
	},
};

/**
 * Per-dimension "only the user can settle what is left" question. Asked once per user
 * dimension in the same call (parallel questions add no latency), so the floor check and the
 * question choice are tied to the dimension that is actually being asked about.
 */
function userCanAnswerQuestion(dim: UserDimension): unknown {
	return noul(
		`Is there still an open point about the ${DIMENSION_LABEL[dim]} of this task that only the user can settle, a product or preference decision, rather than something the agent could resolve by reading or running code?`,
		{
			true: "A point is open and it is the user's call; reading more code would not resolve it.",
			false: "Nothing is open, or the agent could resolve what remains by reading or running something.",
		},
	);
}

/**
 * The scored battery. `entities` are candidate spans copied from the task (see
 * entityCandidates); when there are any, one extra choice picks the span the drafted
 * question should be about, so the question never splices in a half-parsed phrase.
 */
export function buildAmbiguityBattery(entities: readonly string[] = []): Record<string, unknown> {
	const questions: Record<string, unknown> = {};
	for (const dim of DIMENSIONS) {
		questions[`${dim}_clarity`] = score(SCORE_INSTRUCTIONS[dim], [...SCORE_LEVELS[dim]]);
	}
	for (const dim of USER_DIMENSIONS) {
		questions[`gap_${dim}`] = choice(
			`Which piece is most likely missing from the ${DIMENSION_LABEL[dim]} of this task?`,
			GAP_OPTIONS[dim],
		);
		questions[`user_can_answer_${dim}`] = userCanAnswerQuestion(dim);
	}
	if (entities.length > 0) {
		const criteria: Record<string, string | null> = {};
		for (const entity of entities) criteria[entity] = null;
		criteria[NO_ENTITY] = "None of these phrases names the thing the user wants changed, built, or answered";
		questions.target_entity = choice(
			"Which phrase, copied from `task`, names the thing the user wants changed, built, or answered?",
			criteria,
		);
	}
	return questions;
}

// ---- composite math ------------------------------------------------------------

export type Weights = Record<Dimension, number>;

/**
 * Weights scaled to sum to 1, so a partial override ({goal: 0.6} on top of the defaults)
 * or an all-ones config cannot stretch or collapse the 0..1 score. Negative and non-finite
 * entries count as 0; when nothing positive is left the default weights apply.
 */
export function normalizeWeights(weights: Weights): Weights {
	const cleaned = {} as Weights;
	let total = 0;
	for (const dim of DIMENSIONS) {
		const w = weights?.[dim];
		cleaned[dim] = typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;
		total += cleaned[dim];
	}
	if (total <= 0) return { ...DEFAULT_CONFIG.ambiguityGate.weights };
	for (const dim of DIMENSIONS) cleaned[dim] /= total;
	return cleaned;
}

/** ambiguity = 1 - sum(w_d * clarity_d), weights normalized by their sum, clarity in 0..1. */
export function compositeAmbiguity(dims: Record<Dimension, number>, weights: Weights): number {
	const w = normalizeWeights(weights);
	let clarity = 0;
	for (const dim of DIMENSIONS) clarity += w[dim] * clamp01(dims[dim]);
	return clamp01(1 - clarity);
}

export interface WeakestOptions<D extends Dimension = Dimension> {
	/** Only these dimensions may be chosen; default all four. */
	among?: readonly D[];
	/** P(only the user can settle what is left) per dimension; multiplies the shortfall. */
	userCanAnswer?: Partial<Record<Dimension, number>>;
}

/**
 * The dimension with the largest weighted shortfall w_d * (1 - clarity_d), optionally
 * restricted to `among` and discounted by the per-dimension user_can_answer probability.
 * When every discounted shortfall is zero the plain shortfall decides, so the report still
 * names the genuinely weakest dimension.
 */
export function weakestDimension<D extends Dimension = Dimension>(
	dims: Record<Dimension, number>,
	weights: Weights,
	opts: WeakestOptions<D> = {},
): D {
	const pool = (opts.among && opts.among.length > 0 ? opts.among : DIMENSIONS) as readonly D[];
	const w = normalizeWeights(weights);
	const argmax = (factor: (dim: D) => number): { dim: D; value: number } => {
		let best: D = pool[0];
		let bestValue = -1;
		for (const dim of pool) {
			const value = w[dim] * (1 - clamp01(dims[dim])) * factor(dim);
			if (value > bestValue) {
				bestValue = value;
				best = dim;
			}
		}
		return { dim: best, value: bestValue };
	};
	const answerable = opts.userCanAnswer;
	if (answerable) {
		const discounted = argmax((dim) => clamp01(answerable[dim] ?? 0));
		if (discounted.value > 0) return discounted.dim;
	}
	return argmax(() => 1).dim;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

// ---- entity candidates ---------------------------------------------------------

const NO_ENTITY = "none";
const MAX_ENTITY_CANDIDATES = 12;
const MAX_ENTITY_CHARS = 60;
/** Minimum probability on a picked span before it is spliced into the question. */
export const MIN_ENTITY_CONFIDENCE = 0.6;

const STOP_WORDS = new Set(
	"a an the this that these those my our your its their all every some any so to and but or in on of for with from by as at into onto when while because since then per which it is are be was were been i we you me us they them please just also first second go ahead can could should would will want wants need needs let sure ask before after only both each other more most than too very there here what how who why where do does did don't doesn't didn't can't cannot won't isn't aren't wasn't weren't couldn't shouldn't wouldn't not no up off out down over about under again".split(" "),
);

const ACTION_VERBS = [
	"add",
	"build",
	"create",
	"implement",
	"rename",
	"refactor",
	"fix",
	"update",
	"remove",
	"delete",
	"support",
	"migrate",
	"change",
	"make",
	"clean",
	"configure",
	"standardize",
	"replace",
	"move",
	"split",
	"extract",
	"improve",
	"review",
	"deprecate",
	"investigate",
	"optimize",
	"rewrite",
	"speed",
];
const ACTION_SET = new Set(ACTION_VERBS);
const ACTION_RE = new RegExp(`\\b(?:${ACTION_VERBS.join("|")})\\b`, "gi");

/** Spans too generic to name anything on their own. */
const GENERIC_SPANS = new Set([
	"plan",
	"way",
	"ability",
	"something",
	"anything",
	"everything",
	"thing",
	"things",
	"stuff",
	"change",
	"changes",
	"bug",
	"bugs",
	"issue",
	"issues",
	"problem",
]);

/** Sentence and clause boundaries; a "." only counts before whitespace, so "rate.ts" survives. */
const CLAUSE_BREAK = /[.,;:!?](?=\s|$)|[—()`]/;
const CLAUSE_BREAK_ALL = /[.,;:!?](?=\s|$)|[—()`]/g;
const PATH_LIKE = /(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]*|[\w-]+\.(?:ts|tsx|js|jsx|mjs|json|md|py|go|rs|ya?ml|toml|csv|txt|sql|sh))(?=$|[\s),;:!?]|\.(?:\s|$))/g;
const IDENTIFIER = /\b([a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[A-Za-z]+_\w+)(\(\))?/g;

function cleanSpan(raw: string): string {
	const text = raw.replace(/`/g, "").trim();
	const call = text.endsWith("()");
	const core = (call ? text.slice(0, -2) : text).replace(/^[("'“”]+|[)"'“”.,;:!?]+$/g, "");
	return call ? `${core}()` : core;
}

/** A path-ish token: has a file extension, several segments, a trailing slash, or a root marker. */
function plausiblePath(span: string): boolean {
	return /\.\w+$/.test(span) || span.endsWith("/") || span.split("/").length > 2 || /^(?:\.{1,2}|~)?\//.test(span);
}

function isContentWord(word: string): boolean {
	const lower = word.toLowerCase();
	return !STOP_WORDS.has(lower) && !ACTION_SET.has(lower);
}

/** Up to 3 content words after each action verb, longest first; stops at a stop word or clause break. */
function verbObjectSpans(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(ACTION_RE)) {
		const rest = text.slice((match.index ?? 0) + match[0].length).split(CLAUSE_BREAK, 1)[0] ?? "";
		const content: string[] = [];
		for (const word of rest.trim().split(/\s+/)) {
			if (word.length === 0) continue;
			if (!isContentWord(word)) {
				if (content.length > 0) break;
				continue;
			}
			content.push(word);
			if (content.length === 3) break;
		}
		for (let n = content.length; n >= 1; n--) found.push(content.slice(0, n).join(" "));
	}
	return found;
}

/** Runs of 1-4 content words between stop words, action verbs and punctuation. */
function nounRunSpans(text: string): string[] {
	const found: string[] = [];
	for (const clause of text.split(CLAUSE_BREAK_ALL)) {
		let run: string[] = [];
		const flush = (): void => {
			if (run.length > 0 && run.length <= 4) found.push(run.join(" "));
			run = [];
		};
		for (const word of clause.trim().split(/\s+/)) {
			if (word.length === 0 || !isContentWord(word) || word.includes("/") || /\.\w+$/.test(word)) {
				flush();
				continue;
			}
			run.push(word);
		}
		flush();
	}
	return found;
}

/** Drop duplicates and any span contained in a longer one, so the choice options are mutually exclusive. */
function collapseNested(spans: string[]): string[] {
	const lower = spans.map((s) => s.toLowerCase().replace(/\(\)$/, ""));
	return spans.filter(
		(_, i) => lower.indexOf(lower[i]) === i && !lower.some((other, j) => j !== i && other !== lower[i] && other.includes(lower[i])),
	);
}

/**
 * Candidate spans of the task that could name what the request is about, most specific
 * first: backticked and quoted text, paths, flags, identifiers, verb-object phrases, noun
 * runs. Every span is a verbatim piece of the task, which is what lets a Jev `choice` over
 * them be copied straight into the drafted question.
 */
export function entityCandidates(task: string, max = MAX_ENTITY_CANDIDATES): string[] {
	const text = typeof task === "string" ? task : "";
	const raw: string[] = [];
	for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) raw.push(m[1]);
	for (const m of text.matchAll(/["“]([^"”\n]{2,60})["”]/g)) raw.push(m[1]);
	for (const m of text.matchAll(PATH_LIKE)) if (plausiblePath(m[1])) raw.push(m[1]);
	for (const m of text.matchAll(/(?:^|[\s(])(--?[a-z][\w-]*)\b/g)) raw.push(m[1]);
	for (const m of text.matchAll(IDENTIFIER)) raw.push(m[0]);
	raw.push(...verbObjectSpans(text));
	// A lone bare word ("hmm", "B") is not a request; quoting it back would read as noise.
	if (text.trim().split(/\s+/).length >= 2) raw.push(...nounRunSpans(text));
	const spans: string[] = [];
	for (const candidate of raw) {
		const span = cleanSpan(candidate);
		const lower = span.toLowerCase();
		if (span.length < 2 || span.length > MAX_ENTITY_CHARS) continue;
		if (lower === NO_ENTITY || GENERIC_SPANS.has(lower) || STOP_WORDS.has(lower)) continue;
		if (!spans.includes(span)) spans.push(span);
	}
	return collapseNested(spans).slice(0, Math.max(0, max));
}

/** The span Jev picked, only when it is one of our candidates and confident enough. */
function chosenEntity(answer: WireAnswer | undefined, candidates: readonly string[]): string | null {
	const label = answer?.choice;
	if (typeof label !== "string" || label === NO_ENTITY || !candidates.includes(label)) return null;
	const raw = answer?.probabilities;
	const probabilities = isRecord(raw) ? raw : null;
	const p = typeof probabilities?.[label] === "number" ? probabilities[label] : answer?.confidence;
	if (typeof p === "number" && Number.isFinite(p) && p < MIN_ENTITY_CONFIDENCE) return null;
	return label;
}

// ---- question drafting ---------------------------------------------------------

interface QuestionTemplate {
	/** Used when a span of the task is known; `{entity}` is replaced by the quoted span. */
	withEntity: string;
	/** Used when none is; never mentions an entity. */
	plain: string;
}

const TEMPLATES: Record<UserDimension, Record<string, QuestionTemplate>> = {
	goal: {
		which_user: {
			withEntity: "About “{entity}”: who is it for, which user or caller should it serve?",
			plain: "Who is this change for, which user or caller should it serve?",
		},
		which_surface: {
			withEntity: "About “{entity}”: which surface should it land on?",
			plain: "Which surface should this change land on?",
		},
		scope_boundary: {
			withEntity: "About “{entity}”: how far should it go, the narrow case only or everywhere it could apply?",
			plain: "How far should this change go, the narrow case only or everywhere it could apply?",
		},
		none: {
			withEntity: "About “{entity}”: what exactly should it do when it is finished?",
			plain: "What exactly should this change do when it is finished?",
		},
	},
	constraints: {
		hard_limits: {
			withEntity: "About “{entity}”: are there hard limits it must respect (performance, dependencies, platform)?",
			plain: "Are there hard limits this change must respect (performance, dependencies, platform)?",
		},
		non_goals: {
			withEntity: "About “{entity}”: what is explicitly out of scope?",
			plain: "What is explicitly out of scope for this change?",
		},
		compatibility: {
			withEntity: "About “{entity}”: must the existing behavior around it keep working unchanged?",
			plain: "Must the existing behavior around this change keep working unchanged?",
		},
		none: {
			withEntity: "About “{entity}”: what boundaries should it stay inside?",
			plain: "What boundaries should this change stay inside?",
		},
	},
	criteria: {
		acceptance_test: {
			withEntity: "About “{entity}”: what check would prove it is done correctly?",
			plain: "What check would prove this change is done correctly?",
		},
		measurable_outcome: {
			withEntity: "About “{entity}”: what measurable outcome should it reach?",
			plain: "What measurable outcome should this change reach?",
		},
		edge_cases: {
			withEntity: "About “{entity}”: how should it behave at the edges or on failure?",
			plain: "How should this change behave at the edges or on failure?",
		},
		none: {
			withEntity: "About “{entity}”: how will we know it succeeded?",
			plain: "How will we know this change succeeded?",
		},
	},
};

/**
 * Deterministic, concrete question the model is told to ask; it may rephrase. `entity` is a
 * span of the task: omit it to derive one heuristically (the first entityCandidates span),
 * pass null to draft without naming anything. Templates read the same either way.
 */
export function draftQuestion(dimension: UserDimension, gap: string, task: string, entity?: string | null): string {
	const byGap = TEMPLATES[dimension];
	const template = byGap[gap] ?? byGap.none;
	const span = entity === undefined ? entityCandidates(task, 1)[0] : (entity ?? undefined);
	// A function replacer: the span is the user's own text, and a string replacement would read `$&`, `$'` and `$$` in it.
	return span ? template.withEntity.replace("{entity}", () => span) : template.plain;
}

// ---- propose detection ---------------------------------------------------------

/** omp matches the `xd://` scheme case-insensitively and rejects any path, query or fragment after the device name. */
const PROPOSE_DEVICE = /^xd:\/\/propose$/i;

/** True when a `write` tool call targets the plan-submission virtual device. */
export function isProposeWrite(input: unknown): boolean {
	if (!isRecord(input)) return false;
	for (const key of ["path", "file_path"]) {
		const value = input[key];
		if (typeof value === "string" && PROPOSE_DEVICE.test(value.trim())) return true;
	}
	return false;
}

// ---- per-plan and per-session state --------------------------------------------

export interface AskRecord {
	question: string;
	answer: string;
}

const asks: AskRecord[] = [];
const scores: AmbiguityScore[] = [];
const steered = new Set<Dimension>();
let proposeBlocks = 0;
/** The question a steer or block put to the user and nobody has answered yet; survives later scores. */
let pendingQuestion: string | null = null;
/** Typed replies that answered no gate question; still context for the next score. */
const userReplies: string[] = [];
const ASK_CAP = 32;
const SCORE_CAP = 64;
const REPLY_CAP = 8;

/** Start of a session: forget everything, including the score log. */
export function resetAmbiguitySession(): void {
	resetAmbiguityPlan();
	scores.length = 0;
}

/**
 * Start of a plan: forget the asks, steered dimensions, propose blocks, pending question and
 * replies of the previous plan. The score log is kept; it is the session-wide tuning record.
 */
export function resetAmbiguityPlan(): void {
	asks.length = 0;
	steered.clear();
	proposeBlocks = 0;
	pendingQuestion = null;
	userReplies.length = 0;
}

export function recordAsk(question: string, answer: string): void {
	const redact = getConfig().adversary.redact;
	asks.push({ question: maskedCap(question, 400, redact), answer: maskedCap(answer, 400, redact) });
	if (asks.length > ASK_CAP) asks.shift();
}

export function getAsks(): AskRecord[] {
	return [...asks];
}

export function asksObserved(): number {
	return asks.length;
}

/** Logs a score. A steer or block that carries its question also becomes the plan's pending question. */
export function recordScore(entry: AmbiguityScore): void {
	scores.push(entry);
	if (scores.length > SCORE_CAP) scores.shift();
	if ((entry.decision === "steer" || entry.decision === "block") && entry.question) pendingQuestion = entry.question;
}

export function getAmbiguityTelemetry(): AmbiguityTelemetry {
	return { scores: [...scores], asksObserved: asks.length };
}

export function getLastAmbiguityScore(): AmbiguityScore | null {
	return scores.length > 0 ? scores[scores.length - 1] : null;
}

/** True when a steer for this weakest dimension already went out this plan. Does not record. */
export function hasSteered(dimension: Dimension): boolean {
	return steered.has(dimension);
}

/** Record a steer after it was actually delivered, so a failed send does not mute the dimension. */
export function markSteered(dimension: Dimension): void {
	steered.add(dimension);
}

/** Count one propose block toward the per-plan cap (see proposeDecision). */
export function noteProposeBlock(): void {
	proposeBlocks += 1;
}

/**
 * A typed user message during a plan. With a gate question pending (set by a steer or block,
 * kept across the scores in between) it is the answer: it is recorded like an `ask` result, so
 * it spends the ask budget and ends a block/resubmit loop. With none pending it answers no
 * question, so it is kept as context (getUserReplies) and spends nothing. Returns true when it
 * was paired with a question.
 */
export function recordFollowUp(reply: string): boolean {
	const text = reply.trim();
	if (text.length === 0) return false;
	if (pendingQuestion !== null) {
		recordAsk(pendingQuestion, text);
		pendingQuestion = null;
		return true;
	}
	userReplies.push(maskedCap(text, 400, getConfig().adversary.redact));
	if (userReplies.length > REPLY_CAP) userReplies.shift();
	return false;
}

/** Typed replies of this plan that answered no gate question, oldest first. */
export function getUserReplies(): string[] {
	return [...userReplies];
}

// ---- ask tool results ----------------------------------------------------------

const ASK_CHAT_REDIRECT = /^User chose to chat about this instead of answering/i;
const ASK_ERROR = /^Error:/i;

/** Human-readable answer for one structured omp ask result; null when the user gave none. */
function structuredAnswer(result: Record<string, unknown>): string | null {
	const selected = Array.isArray(result.selectedOptions)
		? result.selectedOptions.filter((o): o is string => typeof o === "string" && o.length > 0)
		: [];
	const parts: string[] = [];
	if (selected.length > 0) parts.push(selected.join(", "));
	if (typeof result.customInput === "string" && result.customInput.trim().length > 0) parts.push(result.customInput.trim());
	if (parts.length === 0) return null;
	let text = parts.join("; ");
	if (typeof result.note === "string" && result.note.trim().length > 0) text += ` (note: ${result.note.trim()})`;
	if (result.timedOut === true) text += " (auto-selected after timeout)";
	return text;
}

function recordFromStructured(result: unknown): AskRecord | null {
	if (!isRecord(result) || typeof result.question !== "string" || result.question.trim().length === 0) return null;
	const answer = structuredAnswer(result);
	return answer ? { question: result.question.trim(), answer } : null;
}

/** `id: value` lines of omp's "User answers:" text, keyed by question id; cancelled entries dropped. */
function answersByIdFromText(text: string): Map<string, string> {
	const byId = new Map<string, string>();
	for (const line of text.split("\n")) {
		const m = /^([\w-]+):\s*(.+)$/.exec(line.trim());
		if (m && !/^\(cancelled\)/.test(m[2]) && m[2] !== "[]") byId.set(m[1], m[2]);
	}
	return byId;
}

/**
 * One clean {question, answer} record per answered question of an omp `ask` tool_result.
 * Cancelled dialogs (isError), validation errors ("Error: ..."), "chat about this instead"
 * redirects and unanswered questions yield nothing, so they never use up the ask budget.
 * Prefers omp's structured `details`; without them it falls back to the tool input's
 * questions and the result text.
 */
export function askRecordsFromResult(input: unknown, content: unknown, isError?: boolean, details?: unknown): AskRecord[] {
	if (isError === true) return [];
	const text = textFromContent(content, 4000).trim();
	if (ASK_ERROR.test(text) || ASK_CHAT_REDIRECT.test(text)) return [];
	if (isRecord(details)) {
		if (details.chatRedirect === true) return [];
		if (Array.isArray(details.results)) {
			return details.results.map(recordFromStructured).filter((r): r is AskRecord => r !== null);
		}
		const single = recordFromStructured(details);
		if (single) return [single];
	}
	const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
	if (text.length === 0 || questions.length === 0) return [];
	if (questions.length === 1) {
		const question = questions[0].question;
		return typeof question === "string" && question.trim().length > 0 ? [{ question: question.trim(), answer: text }] : [];
	}
	const byId = answersByIdFromText(text);
	const records: AskRecord[] = [];
	for (const q of questions) {
		const answer = typeof q.id === "string" ? byId.get(q.id) : undefined;
		if (answer && typeof q.question === "string" && q.question.trim().length > 0) {
			records.push({ question: q.question.trim(), answer });
		}
	}
	return records;
}

/** Record every answered question of an `ask` tool_result; returns how many were counted. */
export function recordAskResult(input: unknown, content: unknown, isError?: boolean, details?: unknown): number {
	const records = askRecordsFromResult(input, content, isError, details);
	for (const record of records) recordAsk(record.question, record.answer);
	// The model followed the steer, so the question it raised is answered.
	if (records.length > 0) pendingQuestion = null;
	return records.length;
}

// ---- scoring -------------------------------------------------------------------

export interface AmbiguityState {
	task: string;
	plan_so_far?: string;
	questions_already_asked?: string[];
	answers_received?: string[];
	/** Typed replies during the plan that answered no gate question. */
	user_replies?: string[];
	evidence?: unknown;
}

export interface AmbiguityResult {
	ambiguity: number;
	dims: Record<Dimension, number>;
	/** Always a user-answerable dimension; `context` feeds `ambiguity` but is never asked about. */
	weakest: Dimension;
	gap: string;
	/** P(only the user can settle what is left) for the weakest dimension. */
	userCanAnswer: number;
	question: string;
	/** The task span the question is about; null when the question names none. */
	entity?: string | null;
}

interface AskerLike {
	logger?: { debug?: (message: string) => void; warn?: (message: string) => void };
}

function num(answer: WireAnswer | undefined, key: string): number | null {
	if (!answer) return null;
	const value = answer[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ScoreOptions {
	/**
	 * What is being evaluated. At `plan_start` the raw prompt is scored before the agent has read
	 * anything, so `context` is low for every task and would add a constant to the composite (about
	 * 0.13 at the default weights, over half of the 0.2 threshold); it is left out of the composite
	 * there. The reported `dims.context` is unchanged.
	 */
	trigger?: GateTrigger;
}

/**
 * One Jev call producing the composite score. Returns null on any failure so
 * callers treat it as decision "none" and never block on an API problem.
 */
export async function scoreAmbiguity(
	_pi: AskerLike,
	state: AmbiguityState,
	cfg: AmbiguityGateSettings,
	opts: ScoreOptions = {},
): Promise<AmbiguityResult | null> {
	try {
		const candidates = entityCandidates(state.task);
		const { result } = await ask(state as unknown as Parameters<typeof ask>[0], buildAmbiguityBattery(candidates) as Parameters<typeof ask>[1], {
			timeoutMs: cfg.timeoutMs,
			maxRetries: 0,
		});
		const answers = result.answers ?? {};
		const dims = {} as Record<Dimension, number>;
		for (const dim of DIMENSIONS) {
			const raw = num(answers[`${dim}_clarity`] as WireAnswer | undefined, "score") ?? 0;
			dims[dim] = clamp01(raw / 4);
		}
		const userCanAnswer: Partial<Record<Dimension, number>> = {};
		const gaps: Partial<Record<Dimension, string>> = {};
		for (const dim of USER_DIMENSIONS) {
			userCanAnswer[dim] = clamp01(num(answers[`user_can_answer_${dim}`] as WireAnswer | undefined, "noul") ?? 0);
			const gapAnswer = answers[`gap_${dim}`] as WireAnswer | undefined;
			gaps[dim] = typeof gapAnswer?.choice === "string" ? gapAnswer.choice : "none";
		}
		const weights = opts.trigger === "plan_start" ? { ...cfg.weights, context: 0 } : cfg.weights;
		const weakest = weakestDimension(dims, weights, { among: USER_DIMENSIONS, userCanAnswer });
		const gap = gaps[weakest] ?? "none";
		const entity = chosenEntity(answers.target_entity as WireAnswer | undefined, candidates);
		return {
			ambiguity: compositeAmbiguity(dims, weights),
			dims,
			weakest,
			gap,
			userCanAnswer: userCanAnswer[weakest] ?? 0,
			question: draftQuestion(weakest, gap, state.task, entity),
			entity,
		};
	} catch {
		return null;
	}
}

// ---- message rendering ---------------------------------------------------------

export const GATE_CUSTOM_TYPE = "ai.typesafe.ambiguity";

function fmt(value: number): string {
	return value.toFixed(2);
}

/**
 * The `<ambiguity-gate>` aside/steer body sent to the model. With `askAvailable: false`
 * (headless omp has no `ask` tool) it asks the model to state its assumption in the plan
 * instead of calling a tool that is not there.
 */
export function buildGateNote(result: AmbiguityResult, threshold: number, askAvailable = true): string {
	const instruction = askAvailable
		? `Ask the user before deciding: ${result.question} Offer 2-4 concrete options. Use the ask tool; do not assume.`
		: `Settle this before deciding: ${result.question} No one can be asked right now, so state the assumption you are making explicitly in the plan; do not guess silently.`;
	return (
		`<ambiguity-gate score="${fmt(result.ambiguity)}" threshold="${fmt(threshold)}" ` +
		`weakest="${result.weakest}" gap="${result.gap}">\n` +
		`${instruction}\n` +
		`</ambiguity-gate>`
	);
}

export interface SteerContext {
	/** Whether the `ask` tool is active this session (false headless or when disabled). */
	askAvailable: boolean;
	/** Whether a recent steer's immunity window is still open. */
	immune: boolean;
}

/**
 * Steer decision for a score. "none" is reserved for scores that do not call for a question;
 * a score that does but cannot be delivered says why (`would_steer`: no ask tool,
 * `suppressed_immune`, `suppressed_dedupe`: this dimension already steered this plan), so the
 * bench log separates "clear enough" from "ambiguous but muted".
 */
export function steerDecision(
	result: Pick<AmbiguityResult, "ambiguity" | "userCanAnswer" | "weakest">,
	cfg: AmbiguityGateSettings,
	ctx: SteerContext,
): GateDecision {
	if (result.ambiguity <= cfg.threshold || result.userCanAnswer < cfg.userCanAnswerFloor) return "none";
	if (!ctx.askAvailable) return "would_steer";
	if (ctx.immune) return "suppressed_immune";
	if (hasSteered(result.weakest)) return "suppressed_dedupe";
	return "steer";
}

/** Blocks of one plan submission after which the gate stops blocking and only records. */
export const MAX_PROPOSE_BLOCKS = 2;

export interface ProposeOptions {
	/** Whether the `ask` tool is active; without it a block could not be satisfied. Default true. */
	askAvailable?: boolean;
	/** Blocks already issued this plan; defaults to the module's count (noteProposeBlock). */
	blocksSoFar?: number;
	/** Default MAX_PROPOSE_BLOCKS. */
	maxBlocks?: number;
}

/**
 * Propose-gate decision: block only with a UI and an active `ask` tool (headless omp has no
 * ask tool, so the intent is recorded as would_block and the plan is let through), and only
 * up to maxBlocks times per plan so a model that cannot or will not ask is never stuck.
 */
export function proposeDecision(
	result: Pick<AmbiguityResult, "ambiguity" | "userCanAnswer">,
	cfg: AmbiguityGateSettings,
	hasUI: boolean,
	opts: ProposeOptions = {},
): GateDecision {
	if (!cfg.blockPropose) return "none";
	if (result.ambiguity <= cfg.threshold) return "none";
	if (result.userCanAnswer < cfg.userCanAnswerFloor) return "none";
	if (!hasUI || opts.askAvailable === false) return "would_block";
	if ((opts.blocksSoFar ?? proposeBlocks) >= (opts.maxBlocks ?? MAX_PROPOSE_BLOCKS)) return "would_block";
	return "block";
}

/** The block reason returned from the propose tool_call hook. */
export function buildBlockReason(result: AmbiguityResult, threshold: number, askAvailable = true): string {
	const how = askAvailable
		? "Ask the user first with the ask tool:"
		: "Resolve this in the plan by stating your assumption explicitly:";
	return (
		`Ambiguity ${fmt(result.ambiguity)} > ${fmt(threshold)} (weakest: ${DIMENSION_LABEL[result.weakest]}). ` +
		`${how} ${result.question} Then resubmit the plan.`
	);
}

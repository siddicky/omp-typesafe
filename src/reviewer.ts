import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { apiKeyPresent, ask, describeError, choice, noul, score } from "./client";
import type { WireAnswer } from "./client";
import { getConfig } from "./config";
import type { TypesafeRole } from "./config";
import { planModeActive, scanBranch } from "./branch";
import type { EntryView } from "./branch";
import { cap, EDIT_TOOLS, escapeAttr, fmt2, inputPaths, isRecord } from "./text";
import { formatEvidenceAttribute } from "./evidence";
import type { Evidence } from "./evidence";

/**
 * Reviewer core: batteries, severity derivation, emission guard, delivery.
 * Every trigger funnels through review(); failures never propagate.
 */

export type ReviewKind = "action" | "message" | "turn";
export type Severity = "nit" | "concern" | "blocker";

const SEVERITY_LEVELS = [
	"Nothing to raise",
	"Nit: cleanup, simplification, or a low-risk edge case",
	"Concern: material risk, missed constraint, or likely wrong direction",
	"Blocker: continuing will waste work or produce a broken result",
] as const;

// Native advisor's own severity vocabulary (verbatim from omp://advisor-watchdog.md's `advise`
// tool table), used for the advisory role so both roles map onto the same delivery table.
const ADVISORY_SEVERITY_LEVELS = [
	"Nothing to add",
	"Nit: cleanup, simplification, or a low-risk edge case",
	"Concern: material risk, likely wrong direction, missing constraint, or hallucinated API",
	"Blocker: continuing would clearly waste work or produce broken output",
] as const;

const ADVISORY_THEMES: Record<string, string> = {
	none: "Nothing notable",
	verify_first: "A cheap check would raise confidence before continuing",
	simplify: "A materially simpler approach exists",
	update_callers: "Another file, caller, test, or doc needs a matching change",
	clarify_with_user: "Worth confirming an ambiguity with the user",
	consider_requirement: "A requirement or constraint has not yet been considered",
};

interface NoulDef {
	id: string;
	instructions: string;
	whenTrue: string;
	whenFalse: string;
}

const SHARED_NOULS: Record<string, NoulDef> = {
	breaks_contract: {
		id: "breaks_contract",
		instructions: "This change breaks an existing caller, interface, or test that depended on the previous behavior.",
		whenTrue: "A caller, interface, or test relied on the previous behavior and now breaks.",
		whenFalse: "No existing caller, interface, or test breaks.",
	},
	unfounded_assumption: {
		id: "unfounded_assumption",
		instructions: "The action relies on an assumption about the codebase that was not verified by reading or running something first.",
		whenTrue: "The action acted on an unchecked belief about the codebase.",
		whenFalse: "Every assumption was verified by reading or running something first.",
	},
	incomplete_cutover: {
		id: "incomplete_cutover",
		instructions: "The change leaves the codebase half-migrated — old and new paths coexist, or callers were missed.",
		whenTrue: "Old and new paths coexist or callers were missed.",
		whenFalse: "The migration is complete or no migration was involved.",
	},
	not_what_was_asked: {
		id: "not_what_was_asked",
		instructions: "The action does not serve the user's stated task, or solves a different problem.",
		whenTrue: "The action serves a different problem than the user's stated task.",
		whenFalse: "The action serves the user's stated task.",
	},
	unverified_claim: {
		id: "unverified_claim",
		instructions: "The action's result is being treated as success without evidence that it actually works.",
		whenTrue: "Success is treated as established without evidence it works.",
		whenFalse: "The result is backed by actual evidence.",
	},
	hidden_destruction: {
		id: "hidden_destruction",
		instructions: "The action discarded work, data, or history that was not meant to be discarded.",
		whenTrue: "Work, data, or history was discarded that was not meant to be discarded.",
		whenFalse: "Nothing was discarded beyond what was intended.",
	},
	unsupported_claim: {
		id: "unsupported_claim",
		instructions: "The message asserts something about the code or its behavior that was not established by a command, test, or file that was actually read.",
		whenTrue: "The assertion was not established by a command, test, or file actually read.",
		whenFalse: "The assertion is backed by established evidence.",
	},
	requirement_missed: {
		id: "requirement_missed",
		instructions: "The message overlooks a requirement or constraint the user stated.",
		whenTrue: "A stated requirement or constraint is overlooked.",
		whenFalse: "All stated requirements are addressed.",
	},
	risky_api: {
		id: "risky_api",
		instructions: "The message proposes or relies on a dangerous, deprecated, or easily misused API or pattern.",
		whenTrue: "A dangerous, deprecated, or easily misused API or pattern is involved.",
		whenFalse: "No dangerous or deprecated pattern is involved.",
	},
	weak_verification: {
		id: "weak_verification",
		instructions: "The verification described is too weak to support the conclusion drawn.",
		whenTrue: "The verification is too weak to support the conclusion.",
		whenFalse: "The verification supports the conclusion.",
	},
	unnecessary_complexity: {
		id: "unnecessary_complexity",
		instructions: "The approach is more complex than the task requires.",
		whenTrue: "The approach is more complex than the task requires.",
		whenFalse: "The complexity matches the task.",
	},
	silent_scope_reduction: {
		id: "silent_scope_reduction",
		instructions: "The assistant narrowed the task or skipped requested work without saying so.",
		whenTrue: "The task was narrowed or requested work was skipped without saying so.",
		whenFalse: "The requested scope was preserved or the change was stated.",
	},
	worth_checking: {
		id: "worth_checking",
		instructions: "A cheap check (reading a file, running a test, grepping for callers) would raise confidence in this step and has not been done yet.",
		whenTrue: "A cheap check would raise confidence in this step and has not been done.",
		whenFalse: "The step is already backed by an adequate check, or none is needed.",
	},
	simpler_alternative: {
		id: "simpler_alternative",
		instructions: "A materially simpler approach to this step exists and would satisfy the user's task equally well.",
		whenTrue: "A materially simpler approach exists that would satisfy the task equally well.",
		whenFalse: "No materially simpler approach exists.",
	},
	related_update_needed: {
		id: "related_update_needed",
		instructions: "Another file, caller, test, or doc will need a matching change for this step to be complete.",
		whenTrue: "Another file, caller, test, or doc will need a matching change for this step to be complete.",
		whenFalse: "No related file, caller, test, or doc needs a matching change.",
	},
	should_clarify: {
		id: "should_clarify",
		instructions: "The task has an ambiguity that is worth confirming with the user before more work builds on the current interpretation.",
		whenTrue: "The task has an ambiguity worth confirming with the user before more work builds on it.",
		whenFalse: "The task is unambiguous enough to proceed without confirming.",
	},
	missing_consideration: {
		id: "missing_consideration",
		instructions: "A relevant requirement, edge case, or constraint from the task has not yet been considered.",
		whenTrue: "A relevant requirement, edge case, or constraint has not yet been considered.",
		whenFalse: "All relevant requirements, edge cases, and constraints have been considered.",
	},
	on_track: {
		id: "on_track",
		instructions: "The current step is a sound, direct move toward the user's stated task.",
		whenTrue: "The current step is a sound, direct move toward the user's stated task.",
		whenFalse: "The current step is not a sound, direct move toward the user's stated task.",
	},
};

const ACTION_NOUL_IDS = ["breaks_contract", "unfounded_assumption", "incomplete_cutover", "not_what_was_asked", "unverified_claim", "hidden_destruction"];
const MESSAGE_NOUL_IDS = ["unsupported_claim", "requirement_missed", "risky_api", "weak_verification", "unnecessary_complexity"];
const TURN_NOUL_IDS = ["requirement_missed", "weak_verification", "unnecessary_complexity", "silent_scope_reduction", "risky_api"];

// Advisory batteries mirror omp's native advisor question shape: on_track is a positive-polarity
// noul (high value = sound step) and is excluded from severity-escalation bookkeeping below.
const ADVISORY_ACTION_NOUL_IDS = ["worth_checking", "simpler_alternative", "related_update_needed", "on_track"];
const ADVISORY_MESSAGE_NOUL_IDS = ["should_clarify", "missing_consideration", "simpler_alternative", "on_track"];
const ADVISORY_TURN_NOUL_IDS = ["missing_consideration", "related_update_needed", "simpler_alternative", "should_clarify", "on_track"];
const ON_TRACK_SUPPRESS_FLOOR = 0.75;

const ACTION_DEFECTS: Record<string, string> = {
	none: "Routine, sound action",
	contract_break: "Breaks an existing caller or interface",
	missed_callsite: "Left references to the old behavior",
	unverified_assumption: "Acted on an unchecked belief about the code",
	scope_drift: "Outside the requested task",
	data_loss: "Discarded work or history",
	test_gap: "Behavior change with no exercised check",
};

const EXTENDED_DEFECTS: Record<string, string> = {
	...ACTION_DEFECTS,
	weak_verification: "Verification too weak for the claim",
	overcomplication: "More complex than needed",
};

const SEVERITY_ORDER: Record<Severity, number> = { nit: 0, concern: 1, blocker: 2 };

const KIND_NOUN: Record<ReviewKind, string> = { action: "action", message: "response", turn: "turn" };

const SEVERITY_INSTRUCTION: Record<ReviewKind, string> = {
	action: "Rate the most serious defect present in this action.",
	message: "Rate the most serious defect present in this response.",
	turn: "Rate the most serious defect present in this turn's delta.",
};

// Failed actions (non-zero exit) are judged on what they already did, never on the failure itself.
const FAILED_ACTION_NOUL_IDS = ACTION_NOUL_IDS.filter((id) => id !== "unverified_claim");
const FAILED_ACTION_SEVERITY_INSTRUCTION =
	"This action failed (see exit_status). Do not rate the failure itself. Rate the most serious damage it already did before failing, such as discarded work, a half-applied migration, or a broken caller.";
// A failed adversarial action may only raise a concern or blocker for damage that already happened.
const SIDE_EFFECT_NOUL_IDS = new Set(["hidden_destruction", "incomplete_cutover", "breaks_contract"]);

const NOTE_HISTORY_CAP = 256;
/** Dedupe entries stop suppressing after this many model turns, or when a new user prompt begins. */
export const NOTE_DEDUPE_TTL_TURNS = 6;
/** Telemetry history bound (bench log, /adversary dump); older records are dropped and counted. */
export const HISTORY_CAP = 2000;
/** Per-prompt (agent_start to agent_end) budgets, separate from the per-model-call turn fan-out cap. */
export const MAX_CALLS_PER_PROMPT = 64;
export const MAX_MESSAGE_REVIEWS_PER_PROMPT = 12;

export interface UiLike {
	notify(message: string, level?: "info" | "warning" | "error"): unknown;
}

export interface CtxLike {
	hasUI?: boolean;
	ui?: UiLike;
	isIdle?: () => boolean;
	sessionManager?: { getBranch?: () => unknown };
}

export interface PiLike {
	sendMessage(message: unknown, options?: unknown): unknown;
	logger?: {
		debug?: (message: string) => void;
		info?: (message: string) => void;
		warn?: (message: string) => void;
		error?: (message: string) => void;
	};
}

export interface ReviewOutcome {
	severity: Severity | "none";
	note?: string;
	/** `delivered_inline`: the caller asked for inline delivery (`ReviewOpts.inline`) and must attach `note` itself. */
	decision: "delivered" | "delivered_inline" | "suppressed" | "none" | "error";
	channel?: "aside" | "steer" | "nextTurn";
	reason?: string;
}

export type DowngradeReason = "immune" | "low_confidence" | "plan_mode";

export interface ReviewRecord {
	ts: string;
	kind: ReviewKind;
	role: TypesafeRole;
	toolCallId?: string;
	severity: Severity | "none";
	decision: ReviewOutcome["decision"];
	/** Delivery channel; `inline` when the note rode on the tool result instead of a message. */
	channel?: string;
	reason?: string;
	/** Why a would-be steer went out quietly (immunity window, plan mode, or a low-confidence severity). */
	downgrade?: DowngradeReason;
	/** The reviewed action had failed (state.exit_status === "error"). */
	failed?: boolean;
	fired?: string[];
	defect?: string;
	scores?: Record<string, number>;
	stateSummary?: Record<string, string>;
	note?: string;
	error?: string;
	usage: { inputTokens: number; outputTokens: number };
}

// ---- per-session mutable state -------------------------------------------------

interface NoteEntry {
	key: string;
	/** Strength of what was actually delivered (a SEVERITY_ORDER value). */
	sev: number;
	/** True when a would-be steer went out quietly, so one later steer is still allowed. */
	downgraded: boolean;
	prompt: number;
	turn: number;
}

const history: ReviewRecord[] = [];
const noteHistory: NoteEntry[] = [];
const stats = {
	delivered: { nit: 0, concern: 0, blocker: 0 },
	suppressed: {} as Record<string, number>,
	downgraded: 0,
	errors: 0,
	steers: 0,
	/** Telemetry records evicted from the bounded history (the bench log is incomplete when this is non-zero). */
	historyDropped: 0,
};
let promptSeq = 0;
let turnSeq = 0;
let callsThisTurn = 0;
let callsThisPrompt = 0;
let notesThisTurn = 0;
let messageReviewsThisPrompt = 0;
// Turns are omp turns (one model call plus its tool executions), counted by beginTurn(). A steer at turn S
// keeps immunity through turn S + immuneTurns, so a steer issued from turn_end still protects the next
// immuneTurns turns instead of being decremented by that same turn_end.
let immuneUntilTurn: number | null = null;
let unavailableNotified = false;

export function resetReviewerSession(): void {
	history.length = 0;
	noteHistory.length = 0;
	stats.delivered.nit = 0;
	stats.delivered.concern = 0;
	stats.delivered.blocker = 0;
	for (const key of Object.keys(stats.suppressed)) delete stats.suppressed[key];
	stats.downgraded = 0;
	stats.errors = 0;
	stats.steers = 0;
	stats.historyDropped = 0;
	promptSeq = 0;
	turnSeq = 0;
	callsThisTurn = 0;
	callsThisPrompt = 0;
	notesThisTurn = 0;
	messageReviewsThisPrompt = 0;
	immuneUntilTurn = null;
	unavailableNotified = false;
}

type BudgetVerdict = "ok" | "call_budget" | "prompt_budget";

function takeCall(): BudgetVerdict {
	if (callsThisTurn >= getConfig().adversary.maxCallsPerTurn) return "call_budget";
	if (callsThisPrompt >= MAX_CALLS_PER_PROMPT) return "prompt_budget";
	callsThisTurn += 1;
	callsThisPrompt += 1;
	return "ok";
}

/**
 * Would review() still be allowed a Jev call? Does not consume anything, so a caller can skip
 * work that only feeds a review (such as collecting git evidence) once the budget is spent.
 */
export function hasCallBudget(): boolean {
	return callsThisTurn < getConfig().adversary.maxCallsPerTurn && callsThisPrompt < MAX_CALLS_PER_PROMPT;
}

/**
 * A new user prompt began (omp `agent_start`): reset the per-prompt budgets and expire reviewer
 * dedupe entries. An omp "turn" is one model call, so per-prompt limits cannot live in beginTurn().
 */
export function beginPrompt(): void {
	promptSeq += 1;
	callsThisPrompt = 0;
	messageReviewsThisPrompt = 0;
}

/**
 * A model turn began (omp `turn_start`): reset the per-turn fan-out and note budgets. Pass omp's
 * `turnIndex` so the first turn of a prompt also starts a new prompt even if agent_start was missed.
 */
export function beginTurn(turnIndex?: number): void {
	if (turnIndex === 0) beginPrompt();
	turnSeq += 1;
	callsThisTurn = 0;
	notesThisTurn = 0;
}

/** Permit another message review this prompt? */
export function canReviewMessage(): boolean {
	return messageReviewsThisPrompt < MAX_MESSAGE_REVIEWS_PER_PROMPT;
}

export function recordMessageReviewed(): void {
	messageReviewsThisPrompt += 1;
}

/** Dedupe entries stop counting when a new prompt starts or after NOTE_DEDUPE_TTL_TURNS model turns. */
function isLive(entry: NoteEntry): boolean {
	return entry.prompt === promptSeq && turnSeq - entry.turn <= NOTE_DEDUPE_TTL_TURNS;
}

function liveEntries(key: string): NoteEntry[] {
	return noteHistory.filter((h) => h.key === key && isLive(h));
}

function highestSev(entries: NoteEntry[]): number | null {
	return entries.reduce<number | null>((acc, h) => (acc === null || h.sev > acc ? h.sev : acc), null);
}

function pushNote(entry: Omit<NoteEntry, "prompt" | "turn">): void {
	noteHistory.push({ ...entry, prompt: promptSeq, turn: turnSeq });
	if (noteHistory.length > NOTE_HISTORY_CAP) noteHistory.shift();
}

/** Turn completed: drop expired dedupe entries. (Steer immunity is turn-indexed and needs no decrement.) */
export function endTurn(): void {
	for (let i = noteHistory.length - 1; i >= 0; i--) {
		if (!isLive(noteHistory[i])) noteHistory.splice(i, 1);
	}
}

/** True while a recent steer's immunity window is still open. */
export function isSteerImmune(): boolean {
	return immuneUntilTurn !== null && turnSeq <= immuneUntilTurn;
}

/** Every recorded review, oldest first, bounded by HISTORY_CAP; stats.historyDropped counts evictions. */
export function getReviewHistory(): ReviewRecord[] {
	return [...history];
}

export function getLastReviewRecord(): ReviewRecord | null {
	return history.length > 0 ? history[history.length - 1] : null;
}

export function getReviewStats(): typeof stats {
	return {
		delivered: { ...stats.delivered },
		suppressed: { ...stats.suppressed },
		downgraded: stats.downgraded,
		errors: stats.errors,
		steers: stats.steers,
		historyDropped: stats.historyDropped,
	};
}

// ---- batteries -----------------------------------------------------------------

function noulQuestions(ids: string[]): Questions {
	const questions: Questions = {};
	for (const id of ids) {
		const def = SHARED_NOULS[id];
		questions[id] = noul(def.instructions, { true: def.whenTrue, false: def.whenFalse });
	}
	return questions;
}

export interface Battery {
	questions: Questions;
	/** All noul ids in the battery, including on_track for advisory (used to build the state). */
	noulIds: string[];
	/** noulIds minus on_track — the ids that participate in severity/fired escalation. */
	escalationNoulIds: string[];
	/** "theme" for advisory, "defect_class" for adversarial — the choice question's id. */
	defectKey: "defect_class" | "theme";
	severityLevels: readonly string[];
}

export interface BatteryOpts {
	/** The reviewed action failed (state.exit_status === "error"); only applies to kind "action". */
	failed?: boolean;
}

/** Build the full question battery for a review kind and role. */
export function buildBattery(kind: ReviewKind, role: TypesafeRole = "adversarial", opts: BatteryOpts = {}): Battery {
	const failed = kind === "action" && opts.failed === true;
	const severityInstruction = failed ? FAILED_ACTION_SEVERITY_INSTRUCTION : SEVERITY_INSTRUCTION[kind];
	if (role === "advisory") {
		const noulIds =
			kind === "action" ? ADVISORY_ACTION_NOUL_IDS : kind === "message" ? ADVISORY_MESSAGE_NOUL_IDS : ADVISORY_TURN_NOUL_IDS;
		const escalationNoulIds = noulIds.filter((id) => id !== "on_track");
		const questions: Questions = {
			...noulQuestions(noulIds),
			severity: score(severityInstruction, ADVISORY_SEVERITY_LEVELS),
			theme: choice("Which best describes what's worth raising, if anything?", ADVISORY_THEMES),
		};
		return { questions, noulIds, escalationNoulIds, defectKey: "theme", severityLevels: ADVISORY_SEVERITY_LEVELS };
	}
	const noulIds =
		kind === "action" ? (failed ? FAILED_ACTION_NOUL_IDS : ACTION_NOUL_IDS) : kind === "message" ? MESSAGE_NOUL_IDS : TURN_NOUL_IDS;
	const defectCriteria = kind === "action" ? ACTION_DEFECTS : EXTENDED_DEFECTS;
	const questions: Questions = {
		...noulQuestions(noulIds),
		severity: score(severityInstruction, SEVERITY_LEVELS),
		defect_class: choice("Which best describes the defect, if any?", defectCriteria),
	};
	return { questions, noulIds, escalationNoulIds: noulIds, defectKey: "defect_class", severityLevels: SEVERITY_LEVELS };
}

// ---- severity + guard ----------------------------------------------------------

function numField(answer: WireAnswer | undefined, key: string): number | null {
	if (!answer) return null;
	const value = answer[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extract a noul probability from a wire answer; null when absent. */
export function extractNoul(answer: WireAnswer | undefined): number | null {
	return numField(answer, "noul");
}

function record(pi: PiLike, kind: ReviewKind, entry: Omit<ReviewRecord, "ts" | "kind" | "usage">, usage: { inputTokens: number; outputTokens: number }): ReviewRecord {
	const full: ReviewRecord = { ts: new Date().toISOString(), kind, usage, ...entry };
	history.push(full);
	if (history.length > HISTORY_CAP) {
		history.shift();
		stats.historyDropped += 1;
	}
	pi.logger?.debug?.(`[typesafe] review kind=${kind} decision=${full.decision} severity=${full.severity}${full.reason ? ` reason=${full.reason}` : ""}${full.channel ? ` channel=${full.channel}` : ""}${full.toolCallId ? ` tool=${full.toolCallId}` : ""}`);
	return full;
}

function bumpSuppressed(reason: string): void {
	stats.suppressed[reason] = (stats.suppressed[reason] ?? 0) + 1;
}

function buildNote(kind: ReviewKind, severity: Severity, defect: string, fired: { id: string; value: number }[], confidence: number | null, evidenceText: string | undefined): string {
	const attrs: string[] = [
		`severity="${severity}"`,
		`defect="${escapeAttr(defect)}"`,
		'guidance="weigh, don\'t blindly obey"',
	];
	for (const f of fired) attrs.push(`${f.id}="${fmt2(f.value)}"`);
	if (confidence !== null) attrs.push(`confidence="${fmt2(confidence)}"`);
	if (evidenceText) attrs.push(`evidence="${escapeAttr(evidenceText)}"`);
	const firedNames = fired.map((f) => f.id).join(", ");
	const claim = `Adversarial review of the last ${KIND_NOUN[kind]} flags ${defect}${firedNames ? ` (${firedNames})` : ""}.`;
	return `<adversarial-note ${attrs.join(" ")}>\n${claim} Verify or refute before building on this.\n</adversarial-note>`;
}

/** Advisory role's note — mirrors omp's native `<advisory>` element shape exactly. */
function buildAdvisoryNote(kind: ReviewKind, severity: Severity, theme: string, fired: { id: string; value: number }[], confidence: number | null, evidenceText: string | undefined): string {
	const attrs: string[] = [
		'advisor="TypeSafe"',
		`severity="${severity}"`,
		'guidance="weigh, don\'t blindly obey"',
		`theme="${escapeAttr(theme)}"`,
	];
	for (const f of fired) attrs.push(`${f.id}="${fmt2(f.value)}"`);
	if (confidence !== null) attrs.push(`confidence="${fmt2(confidence)}"`);
	if (evidenceText) attrs.push(`evidence="${escapeAttr(evidenceText)}"`);
	const firedNames = fired.map((f) => f.id).join(", ");
	const top = fired.reduce<{ id: string; value: number } | null>((acc, f) => (acc === null || f.value > acc.value ? f : acc), null);
	const topDef = top ? SHARED_NOULS[top.id] : undefined;
	const claim = topDef
		? `${topDef.whenTrue.replace(/[.!]$/, "")} (${top!.id}).`
		: `TypeSafe advisory review of the last ${KIND_NOUN[kind]} raises ${theme}${firedNames ? ` (${firedNames})` : ""}.`;
	return `<advisory ${attrs.join(" ")}>\n${claim} Consider this before continuing.\n</advisory>`;
}

/**
 * Delivery routing. omp's `aside` injects at the next step boundary, but when the session is idle it starts
 * a turn (asides still queued when a run settles are flushed as a wake turn). So an aside is only used where
 * a model step is guaranteed to follow, a tool result; after a message or turn the run may already be over,
 * and quiet notes there use `nextTurn`, which stays hidden until the next prompt consumes it.
 */
interface Route {
	channel: "aside" | "steer" | "nextTurn";
	triggerTurn: boolean;
	/** Set when a note that would have steered went out quietly instead. */
	downgrade: DowngradeReason | null;
}

function routeDelivery(kind: ReviewKind, severity: Severity, entries: EntryView[], ctx: CtxLike, lowConfidence: boolean): Route {
	const quiet = kind === "action" ? "aside" : "nextTurn";
	let channel: Route["channel"];
	let triggerTurn = false;
	if (severity === "blocker") {
		channel = "steer";
		triggerTurn = true;
	} else if (severity === "concern" && kind !== "action") {
		// Mid tool batch only a blocker may steer; after a message or turn a concern steers unless idle.
		channel = ctx.isIdle?.() === true ? "nextTurn" : "steer";
	} else {
		channel = quiet;
	}
	const wantsSteer = channel === "steer";
	let downgrade: DowngradeReason | null = null;
	if (planModeActive(entries)) {
		// Plan mode: nothing steers, and omp folds an aside into plan context instead of waking the agent.
		channel = "aside";
		triggerTurn = false;
		if (wantsSteer) downgrade = "plan_mode";
	} else if (wantsSteer && isSteerImmune()) {
		channel = quiet;
		triggerTurn = false;
		downgrade = "immune";
	} else if (wantsSteer && lowConfidence) {
		channel = quiet;
		triggerTurn = false;
		downgrade = "low_confidence";
	}
	return { channel, triggerTurn, downgrade };
}

/** The host's sendMessage returns void: it can throw but cannot report delivery, so there is nothing to await. */
function dispatch(pi: PiLike, message: unknown, options: unknown): void {
	const sent = pi.sendMessage(message, options);
	if (sent instanceof Promise) sent.catch((err) => pi.logger?.warn?.(`[typesafe] sendMessage rejected: ${describeError(err)}`));
}

// ---- dedupe identity -----------------------------------------------------------

const COMMAND_KEYS = ["command", "cmd", "code"] as const;
const TRUNCATED_PATH = /"(?:path|file_path|filePath|file|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
// A patch in JSON text that was capped mid-string: its newlines are still the two characters `\n`.
const TRUNCATED_PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: ([^"\\\r\n]+)/g;
// The `[PATH#TAG]` header lines of a hashline edit (or the legacy `\u00b6PATH#TAG`) in JSON text that was capped mid-string:
// the first follows the opening `"input":"` of its field and the others a literal `\n`. The edit's own body rows start
// with `+`, so they never match, and the tag is optional like it is for the full parse (hashlineFiles).
const TRUNCATED_HASHLINE_FILE = /(?:[{,]"(?:input|patch|diff)":"|\\n)(?:\[([^\]\\"\r\n]+?)(?:#[0-9a-fA-F]{4})?\]|\u00b6+([^\\"\r\n#]+?)(?:#[0-9a-fA-F]{4})?(?=\\n))/g;

function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/** `hashline`: the tool is an edit's, so a `[..]` line of its `input` is a `[PATH#TAG]` header (see inputPaths). */
function subjectOfRecord(input: Record<string, unknown>, hashline: boolean): string | null {
	const paths = inputPaths(input, { hashline });
	if (paths.length > 0) return [...new Set(paths)].sort().join(",");
	for (const key of COMMAND_KEYS) {
		const value = input[key];
		if (typeof value === "string" && value.trim().length > 0) return `cmd:${hashText(value.trim().replace(/\s+/g, " "))}`;
	}
	return null;
}

function inputSubject(input: unknown, hashline: boolean): string {
	if (isRecord(input)) return subjectOfRecord(input, hashline) ?? `h:${hashText(JSON.stringify(input) ?? "")}`;
	const text = typeof input === "string" ? input.trim() : "";
	if (text.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(text);
			const subject = isRecord(parsed) ? subjectOfRecord(parsed, hashline) : null;
			if (subject) return subject;
		} catch {
			// Input capped mid-JSON: fall back to scanning for a path field, then for patch headers.
			const match = TRUNCATED_PATH.exec(text);
			if (match) return match[1];
			const patched = [...text.matchAll(TRUNCATED_PATCH_FILE)].map((m) => m[1].trim());
			if (hashline) for (const m of text.matchAll(TRUNCATED_HASHLINE_FILE)) patched.push((m[1] ?? m[2]).trim());
			if (patched.length > 0) return [...new Set(patched)].sort().join(",");
		}
	}
	const files = inputPaths(text, { hashline });
	if (files.length > 0) return [...new Set(files)].sort().join(",");
	return `h:${hashText(text)}`;
}

/**
 * What a review is about, for dedupe. An action is its tool plus the edited path(s) or a hash of the command. A
 * message or turn review has no tool, so its identity is the model turn it came from: the message_end and the
 * turn_end of one turn see the same response and count as one finding, while the same question firing on a
 * later turn's different response is a new finding.
 */
export function reviewTarget(kind: ReviewKind, state: Record<string, unknown>, turn: number = turnSeq): string {
	if (kind !== "action") return `turn:${turn}`;
	if (!isRecord(state.action)) return "";
	const tool = typeof state.action.tool === "string" ? state.action.tool : "tool";
	return cap(`${tool}:${inputSubject(state.action.input, EDIT_TOOLS.has(tool))}`, 240);
}

/**
 * Semantic dedupe key: the target, the questions that fired, and, when nothing fired and only the
 * severity score raised the note, the defect class. The reviewer kind is deliberately absent, so the same
 * finding from message_end and turn_end is one finding. Fired nouls alone identify the rest, so a defect
 * choice flipping between cycles does not revive a note.
 */
function semanticKey(defect: string, fired: { id: string }[], target: string): string {
	const ids = fired.map((f) => f.id).sort().join(",");
	return `note|${target}|${ids}|${ids ? "" : defect}`;
}

export interface ReviewOpts {
	toolCallId?: string;
	/** Evidence object collected by evidence.ts; also carried inside `state` for the model. */
	evidence?: Evidence;
	/**
	 * The caller attaches the note to the tool result itself. A non-blocker action note then skips
	 * sendMessage and returns decision "delivered_inline" (the caller inlines `note`); a blocker still steers
	 * and returns "delivered", so it is not inlined a second time.
	 */
	inline?: boolean;
}

/**
 * Run one review: build the battery, ask Jev, derive severity, guard, deliver.
 * `state.exit_status === "error"` marks a failed action: it is judged on side effects it already had.
 * Never throws; all outcomes are recorded in the review history.
 */
export async function review(pi: PiLike, kind: ReviewKind, state: Record<string, unknown>, ctx: CtxLike, opts: ReviewOpts = {}, role: TypesafeRole = "adversarial"): Promise<ReviewOutcome> {
	const cfg = getConfig().adversary;
	const toolCallId = opts.toolCallId;
	const failed = kind === "action" && state.exit_status === "error";
	const stateSummary: Record<string, string> = {};
	for (const [key, value] of Object.entries(state)) {
		if (typeof value === "string") stateSummary[key] = `${value.length} chars`;
		else stateSummary[key] = cap(JSON.stringify(value) ?? "object", 80);
	}
	const blank = { stateSummary, role, ...(toolCallId ? { toolCallId } : {}), ...(failed ? { failed } : {}) };
	try {
		if (!apiKeyPresent()) {
			bumpSuppressed("no_api_key");
			record(pi, kind, { severity: "none", decision: "suppressed", reason: "no_api_key", ...blank }, { inputTokens: 0, outputTokens: 0 });
			return { severity: "none", decision: "suppressed", reason: "no_api_key" };
		}
		const budget = takeCall();
		if (budget !== "ok") {
			bumpSuppressed(budget);
			record(pi, kind, { severity: "none", decision: "suppressed", reason: budget, ...blank }, { inputTokens: 0, outputTokens: 0 });
			return { severity: "none", decision: "suppressed", reason: budget };
		}
		const battery = buildBattery(kind, role, { failed });
		// `state` is assembled from strings, arrays and JSON-safe objects; the SDK wants its JSON-value type.
		const { result } = await ask(state as EntryType, battery.questions, { timeoutMs: cfg.timeoutMs, maxRetries: 0 });
		const usage = { inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0 };
		const answers = result.answers ?? {};
		const severityAnswer = answers.severity as WireAnswer | undefined;
		const sevScore = numField(severityAnswer, "score") ?? 0;
		const band: Severity | "pending" =
			sevScore >= cfg.blocker_severity ? "blocker" : sevScore >= cfg.concern_severity ? "concern" : "pending";
		const fired: { id: string; value: number }[] = [];
		for (const id of battery.escalationNoulIds) {
			const value = extractNoul(answers[id] as WireAnswer | undefined) ?? 0;
			if (value >= cfg.noul_floor) fired.push({ id, value });
		}
		let finalSeverity: Severity | "none" = band === "pending" ? (fired.length > 0 ? "nit" : "none") : band;
		const defectAnswer = answers[battery.defectKey] as WireAnswer | undefined;
		const rawDefect = typeof defectAnswer?.choice === "string" ? defectAnswer.choice : "unclassified";
		const defectConfidence = numField(defectAnswer, "confidence");
		const defect = rawDefect !== "none" && defectConfidence !== null && defectConfidence >= 0.5 ? rawDefect : "unclassified";
		const severityConfidence = numField(severityAnswer, "confidence");
		const scores: Record<string, number> = { severity: sevScore };
		for (const f of fired) scores[f.id] = f.value;

		// Advisory-only: a step the reviewer agrees is sound suppresses anything below a blocker.
		if (role === "advisory" && finalSeverity !== "none" && finalSeverity !== "blocker") {
			const onTrack = extractNoul(answers.on_track as WireAnswer | undefined) ?? 0;
			scores.on_track = onTrack;
			if (onTrack >= ON_TRACK_SUPPRESS_FLOOR) finalSeverity = "none";
		}
		// A failed action is not itself a defect: an adversarial concern or blocker needs a side effect that already happened.
		if (failed && role === "adversarial" && (finalSeverity === "concern" || finalSeverity === "blocker") && !fired.some((f) => SIDE_EFFECT_NOUL_IDS.has(f.id))) {
			finalSeverity = fired.length > 0 ? "nit" : "none";
		}

		if (finalSeverity === "none") {
			record(pi, kind, { severity: "none", decision: "none", scores, defect, ...blank }, usage);
			return { severity: "none", decision: "none" };
		}
		// Content guard: a concern or blocker must say something. With no fired question and no classified
		// defect or theme the note would only read "flags unclassified", so it is dropped instead of steering.
		if ((finalSeverity === "concern" || finalSeverity === "blocker") && fired.length === 0 && defect === "unclassified") {
			bumpSuppressed("content_free");
			record(pi, kind, { severity: finalSeverity, decision: "suppressed", reason: "content_free", scores, defect, ...blank }, usage);
			return { severity: finalSeverity, decision: "suppressed", reason: "content_free" };
		}
		if (finalSeverity === "nit" && !cfg.emitNits) {
			bumpSuppressed("nits_disabled");
			record(pi, kind, { severity: "nit", decision: "suppressed", reason: "nits_disabled", scores, defect, fired: fired.map((f) => f.id), ...blank }, usage);
			return { severity: "nit", decision: "suppressed", reason: "nits_disabled" };
		}

		const evidenceAttr = opts.evidence ? formatEvidenceAttribute(opts.evidence) : undefined;
		const note =
			role === "advisory"
				? buildAdvisoryNote(kind, finalSeverity, defect, fired, severityConfidence, evidenceAttr)
				: buildNote(kind, finalSeverity, defect, fired, severityConfidence, evidenceAttr);

		const inline = opts.inline === true && kind === "action" && finalSeverity !== "blocker";
		const lowConfidence = severityConfidence !== null && severityConfidence < cfg.steerMinConfidence;
		const routed = inline ? null : routeDelivery(kind, finalSeverity, scanBranch(ctx.sessionManager?.getBranch?.()), ctx, lowConfidence);
		const downgraded = routed !== null && routed.downgrade !== null;

		// Severity-aware dedupe on the semantic content (target + which questions fired), not the exact text:
		// probability drift between cycles must not revive a note. A strictly higher severity than any live
		// prior note with the same key passes once (genuine escalation nit -> concern -> blocker). A prior
		// note that went out quietly in place of a steer (immunity, plan mode, low confidence) does not count
		// against a note that can now steer, so such a finding is still delivered at full strength once.
		const semanticSev = SEVERITY_ORDER[finalSeverity];
		const semanticKeyValue = semanticKey(defect, fired, reviewTarget(kind, state));
		const prior = liveEntries(semanticKeyValue);
		const priorFull = highestSev(prior.filter((h) => !h.downgraded));
		const priorAny = highestSev(prior);
		if ((priorFull !== null && priorFull >= semanticSev) || (downgraded && priorAny !== null && priorAny >= semanticSev)) {
			bumpSuppressed("duplicate");
			record(pi, kind, { severity: finalSeverity, decision: "suppressed", reason: "duplicate", scores, defect, ...blank }, usage);
			return { severity: finalSeverity, decision: "suppressed", reason: "duplicate" };
		}
		// Per-turn note budget: non-blocker notes are capped per model turn; blockers exempt.
		if (finalSeverity !== "blocker" && notesThisTurn >= cfg.maxNotesPerUpdate) {
			bumpSuppressed("update_budget");
			record(pi, kind, { severity: finalSeverity, decision: "suppressed", reason: "update_budget", scores, defect, ...blank }, usage);
			return { severity: finalSeverity, decision: "suppressed", reason: "update_budget" };
		}

		if (routed) {
			const options: Record<string, unknown> = { deliverAs: routed.channel };
			if (routed.triggerTurn) options.triggerTurn = true;
			dispatch(pi, { customType: role === "advisory" ? "ai.typesafe.advisory" : "ai.typesafe.adversary", content: note, display: true, attribution: "agent" }, options);
		}
		// History, budgets and immunity update only once the host call did not throw.
		pushNote({ key: semanticKeyValue, sev: semanticSev, downgraded });
		if (finalSeverity !== "blocker") notesThisTurn += 1;
		stats.delivered[finalSeverity] += 1;
		if (routed?.downgrade === "immune" || routed?.downgrade === "low_confidence") stats.downgraded += 1;
		if (routed?.channel === "steer") {
			stats.steers += 1;
			immuneUntilTurn = cfg.immuneTurns > 0 ? turnSeq + cfg.immuneTurns : null;
		}
		const firedIds = fired.map((f) => f.id);
		if (!routed) {
			record(pi, kind, { severity: finalSeverity, decision: "delivered_inline", channel: "inline", scores, defect, fired: firedIds, note, ...blank }, usage);
			return { severity: finalSeverity, note, decision: "delivered_inline" };
		}
		record(pi, kind, { severity: finalSeverity, decision: "delivered", channel: routed.channel, ...(routed.downgrade ? { downgrade: routed.downgrade } : {}), scores, defect, fired: firedIds, note, ...blank }, usage);
		return { severity: finalSeverity, note, decision: "delivered", channel: routed.channel };
	} catch (err) {
		stats.errors += 1;
		pi.logger?.warn?.(`[typesafe] review failed (${kind}): ${describeError(err)}`);
		if (!unavailableNotified) {
			unavailableNotified = true;
			if (ctx.hasUI === true && ctx.ui) ctx.ui.notify("TypeSafe adversary unavailable", "warning");
		}
		record(pi, kind, { severity: "none", decision: "error", error: describeError(err), ...blank }, { inputTokens: 0, outputTokens: 0 });
		return { severity: "none", decision: "error", reason: describeError(err) };
	}
}

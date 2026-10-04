import { basename, dirname, join, resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import {
	apiKeyPresent,
	ask,
	choice,
	describeError,
	estimateCostUsd,
	getClientError,
	getLastResolvedModel,
	getSessionUsage,
	noul,
	resetClient,
	resetUsage,
	score,
	setClientLogger,
} from "./client";
import type { WireAnswer } from "./client";
import { createCompactor } from "./compaction";
import type { ContextReducer } from "./compaction";
import { agentDir, getConfig, getConfigWarnings, loadConfig, subagentGuardEnabled } from "./config";
import type { TypesafeRole } from "./config";
import type { ExtensionAPI, HostContentBlock, HostContext, HostEvents, HostLogger, HostMessage, NotifyLevel, ToolCallResult, ZodSchema } from "./host";
import { loadPriorities } from "./priorities";
import { getSubagentStats, resetSubagentStats, skipSubagent } from "./subagent";
import { captureBaseline, collectEvidence, collectStatus, recordAction, repoOutline, resetEvidenceTurn } from "./evidence";
import type { CollectOptions, Evidence } from "./evidence";
import { claimedIntent, lastUserText, planModeActive, planSoFar, planStartIndex, priorActions, renderDelta, scanBranch, userTurnText } from "./branch";
import type { EntryView } from "./branch";
import { APPROVAL_TOOLS, decideApproval, detectApprovalFlips } from "./pipeline/approval";
import { DAG_CALLS, planGuardDecision } from "./pipeline/plan-guard";
import { isPipelineSkill, latestUserTurnSkill, parseSkillPrompt } from "./pipeline/skill";
import type { SkillInvocation } from "./pipeline/skill";
import { buildQuoteCorpus, checkSpec, isSpecPath, renderSpecNote, SPEC_NOTE_CUSTOM_TYPE, specHash } from "./pipeline/spec";
import {
	beginPrompt,
	beginTurn,
	canReviewMessage,
	endTurn,
	getLastReviewRecord,
	getReviewHistory,
	getReviewStats,
	hasCallBudget,
	isSteerImmune,
	recordMessageReviewed,
	resetReviewerSession,
	review,
} from "./reviewer";
import {
	asksObserved,
	buildBlockReason,
	buildGateNote,
	GATE_CUSTOM_TYPE,
	getAmbiguityTelemetry,
	getAsks,
	getLastAmbiguityScore,
	getUserReplies,
	isProposeWrite,
	markSteered,
	noteProposeBlock,
	proposeDecision,
	recordAskResult,
	recordFollowUp,
	recordScore,
	resetAmbiguityPlan,
	resetAmbiguitySession,
	scoreAmbiguity,
	steerDecision,
} from "./ambiguity";
import type { AmbiguityResult, GateDecision, GateTrigger } from "./ambiguity";
import { EDIT_TOOLS, fmt2, inputPaths, isRecord, maskedCap, maskedTail, sanitizeValue, stringifyInput, textFromContent } from "./text";

/**
 * TypeSafe Adversary — advisor-pattern adversarial reviewer for omp, powered by
 * TypeSafe AI's System One model (Jev). Watches actions, responses, and turn
 * deltas; raises nit/concern/blocker notes; exposes the typesafe_ask tool.
 */

let priorities = "";
let turnCursor = 0;
const reviewedCallIds = new Set<string>();
let sessionOverride: boolean | null = null;
let sessionRoleOverride: TypesafeRole | null = null;
let sessionGateOverride: boolean | null = null;
let stopGateUses = 0;
/** HEAD at the start of the prompt, so a commit made mid-prompt is still reviewed. */
let baseline: string | null = null;
// Per-plan gate state. resetPlanState() clears it whenever a plan starts or ends.
let planStart = -1;
/** omp's id of the entry the plan began at; null when the plan has none, or none is known. */
let planStartId: string | null = null;
/**
 * omp's id of the first user message at or after the plan's start, once there is one: the plan's objective. Sibling
 * branches (/branch, /tree) hang under the same start entry, so only this tells a reworded prompt's plan from the old one.
 */
let planFirstUserId: string | null = null;
let planStartScored = false;
let planPrompt = "";
/** planPrompt came from before_agent_start's event.prompt, and the user message_end that carries that prompt has not arrived yet. */
let planPromptAwaitingEcho = false;
let planOutline: string | null = null;
/**
 * The skill the latest prompt invoked, as before_agent_start read it off the prompt (null for any other prompt, and
 * always null with pipeline.skillAware off). The prompt is not in the branch yet then, and in print mode never is as
 * a skill entry, so the branch cannot say.
 */
let promptSkill: SkillInvocation | null = null;
// What the pipeline features did this session, for /adversary status.
let planGuardBlocks = 0;
let approvalBlocks = 0;
let approvalWouldBlocks = 0;
let specNotesSent = 0;
/** Verbatim context reduction for this session (src/compaction.ts); built on the first `context` event, dropped with the session. */
let compactor: ContextReducer | undefined;
/** One key per spec file content that already got its note (see checkSpecWrite). */
const specNoteKeys = new Set<string>();

/** Tools whose result may hold a draft deep-interview spec (checkSpecWrite looks at the path). */
const SPEC_WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

/** Tools whose failure can still leave side effects behind: an errored result is reviewed. */
const REVIEW_WHEN_FAILED = new Set(["bash", "eval"]);

/**
 * Did an errored bash/eval result come from a command that ran and failed? omp reports that in the result's
 * `details`: bash a non-zero `exitCode` (or `timedOut`), eval a cell with a non-zero `exitCode`. A call omp
 * stopped (Esc), blocked, or got no exit status for is thrown instead and has no details, and a cancelled eval
 * cell has no exit code. Only these details tell a failure from an abort: omp's `[Command aborted]` marker is
 * absent from an auto-backgrounded command that was aborted, and present in the output of any command that
 * merely prints it, so the output of a result that has them is never read for it (see interruptedBatch for the
 * results that do not).
 */
function ranAndFailed(toolName: string, details: unknown): boolean {
	if (!isRecord(details)) return false;
	if (toolName === "bash") return details.timedOut === true || (typeof details.exitCode === "number" && details.exitCode !== 0);
	if (toolName === "eval") return Array.isArray(details.cells) && details.cells.some((cell) => isRecord(cell) && typeof cell.exitCode === "number" && cell.exitCode !== 0);
	return false;
}

/** `/typesafe test` cannot be cancelled, so one try plus one retry, and a hard cap on the whole probe. */
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_BUDGET_MS = 12_000;
/** A gate evaluation waits at most this long beyond its Jev timeout (one git probe, 1.5 s, plus slack). */
const GATE_SLACK_MS = 1800;
/** Hard ceiling, well under omp's 30 s fail-closed tool_call timeout, whatever ambiguityGate.timeoutMs says. */
const GATE_DEADLINE_CAP_MS = 9000;

function reviewEnabled(): boolean {
	return sessionOverride ?? getConfig().adversary.enabled;
}

/** `/adversary gate` wins; otherwise `/adversary off` silences the gate too, and the config decides. */
function gateEnabled(): boolean {
	return sessionGateOverride ?? (sessionOverride === false ? false : getConfig().ambiguityGate.enabled);
}

function resolvedRole(): TypesafeRole {
	return sessionRoleOverride ?? getConfig().role;
}

function roleLabel(role: TypesafeRole): string {
	return role === "advisory" ? "TypeSafe Advisor" : "TypeSafe Adversary";
}

/** Gate a trigger on config.phases: plan-mode entries need "plan", everything else needs "execute". */
function phaseAllowed(entries: EntryView[]): boolean {
	const phases = getConfig().phases;
	return planModeActive(entries) ? phases.includes("plan") : phases.includes("execute");
}

function notifyVia(ctx: HostContext | undefined, logger: HostLogger | undefined, message: string, level: NotifyLevel = "info"): void {
	if (ctx?.hasUI === true && ctx.ui) ctx.ui.notify(message, level);
	else logger?.info?.(`[typesafe] ${message}`);
}

/** A model turn that ended because the user aborted or the provider failed; its output is not worth reviewing. */
function endedAbnormally(message: unknown): boolean {
	return isRecord(message) && (message.stopReason === "aborted" || message.stopReason === "error");
}

const READ_ONLY_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	find: true,
	skill_search: true,
	skill_load: true,
	web_search: true,
};

/** No new claim or side effect to judge; unrecognized entries and failed results stay eligible. */
function readOnlyStep(entries: EntryView[]): boolean {
	return entries.length > 0 && entries.every((entry) => {
		const message = entry.message;
		if (!message) return false;
		if (message.role === "assistant") {
			return message.text.trim().length === 0 && message.toolCalls.length > 0
				&& message.toolCalls.every((call) => READ_ONLY_TOOLS[call.name] === true);
		}
		return message.role === "toolResult" && !message.isError && message.toolName !== null
			&& READ_ONLY_TOOLS[message.toolName] === true;
	});
}

/** The start of the result omp gives a tool call it never started because the run was already stopped. */
const RUN_STOPPED_PREFIX = "Tool was not executed because the run was aborted";
/**
 * What a tool that was cut off by the user's abort reports as its whole text: ToolAbortError's message (any tool that
 * checks its signal throws it, and omp turns the throw into an errored result with no details), the browser and
 * computer workers' fallback, bash's own, and the wording of the tools that give their own: `ask` (a cancelled
 * dialog aborts the run) and the browser's tab and page opens.
 */
const ABORT_TEXTS = new Set([
	"Operation aborted",
	"Tool call aborted",
	"Command aborted",
	"Ask tool was cancelled by the user",
	"Ask input was cancelled",
	"Browser open aborted",
	"Browser tab open aborted",
]);
/**
 * omp's own mark of a bash/eval call the user stopped: a leading `[Command cancelled]`, or `[Command aborted]` closing
 * the output (a one-line notice about the saved output may follow it). It is looked for before the wording below,
 * because the output of a stopped command can start or end with anything.
 */
const COMMAND_STOPPED_START = "[Command cancelled]";
const COMMAND_STOPPED_END = /\[Command aborted\](?:\n\n\[(?!Command timed out)[^\n]*\])?\s*$/;
/**
 * How omp words a bash/eval call that did not complete without the user stopping it: the bash interceptor's block, a
 * result with no exit status, a timeout. An errored command with no exit code or timeout in its details is taken
 * for a stop (omp reports a stop with no details, in wording that is not always the same, see ranAndFailed), unless
 * the start of its text matches the first of these or the end of it the second, and it carries no mark of a stop
 * (COMMAND_STOPPED_*). Command output can be huge, so only NOT_STOPPED_EDGE characters of each end are looked at.
 */
const COMMAND_NOT_STOPPED_START = /^(?:Blocked: |Command blocked$|Command timed out$)/;
const COMMAND_NOT_STOPPED_END = /Command failed: missing exit status|\[Command timed out after \d+ seconds\]$/;
const NOT_STOPPED_EDGE = 300;

function resultText(content: unknown): string {
	return textFromContent(content, Number.MAX_SAFE_INTEGER).trim();
}

/**
 * Did the user stop (Esc) the tool batch this turn ended with? omp ends such a turn as usual, with the assistant
 * message's own `toolUse` stop reason, so only the turn's tool results show it. Any tool's result can: an
 * omp-synthesised one (`details.__synthetic`: the tool never ran; `__interrupted`: it was skipped for a queued
 * message), omp's own "not executed because the run was aborted" result of a call it never started, and the
 * errored result of a call that threw ToolAbortError, whose whole text is "Operation aborted" or one of the few other
 * wordings of ABORT_TEXTS. An errored bash/eval result is also taken for a stop unless it is a command that ran and
 * failed (the call tool_result skips, see ranAndFailed) or omp worded it as a block, a missing exit status or a
 * timeout (COMMAND_NOT_STOPPED_*) and it carries no mark of a stop: the other errors omp throws for those tools say
 * nothing a reader can tell from a stop.
 */
function interruptedBatch(toolResults: unknown): boolean {
	if (!Array.isArray(toolResults)) return false;
	return toolResults.some((result) => {
		if (!isRecord(result) || result.isError !== true) return false;
		if (isRecord(result.details) && (result.details.__synthetic === true || result.details.__interrupted === true)) return true;
		const toolName = typeof result.toolName === "string" ? result.toolName : "";
		const command = REVIEW_WHEN_FAILED.has(toolName);
		if (command && ranAndFailed(toolName, result.details)) return false;
		const text = resultText(result.content);
		if (ABORT_TEXTS.has(text) || text.startsWith(RUN_STOPPED_PREFIX)) return true;
		if (!command) return false;
		const tail = text.slice(-NOT_STOPPED_EDGE);
		if (text.startsWith(COMMAND_STOPPED_START) || COMMAND_STOPPED_END.test(tail)) return true;
		return !COMMAND_NOT_STOPPED_START.test(text.slice(0, NOT_STOPPED_EDGE)) && !COMMAND_NOT_STOPPED_END.test(tail);
	});
}

/** The shell command or code a bash/eval call ran, for the commands-run evidence. */
function commandText(input: unknown): string | undefined {
	if (typeof input === "string") return input;
	if (!isRecord(input)) return undefined;
	for (const key of ["command", "cmd", "code"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

/** Paths an edit-class tool call targets (the evidence starts with their diffs); capped. */
function editedPaths(input: unknown): string[] {
	return inputPaths(input).slice(0, 8);
}

/** How much of a tool call's input, as JSON, is shown to the reviewer. */
const TOOL_INPUT_CAP = 3000;

function redactOn(): boolean {
	return getConfig().adversary.redact;
}

/** Is a skill the user invoked their turn (`pipeline.skillAware`)? Off, only user messages are, as before the pipeline features. */
function skillTurns(): boolean {
	return getConfig().pipeline.skillAware;
}

function sanitizeState(state: Record<string, unknown>): Record<string, unknown> {
	return sanitizeValue(state, redactOn()) as Record<string, unknown>;
}

/** Plan text with the plan write that is being submitted right now, in case the host has not persisted it yet. */
function withProposed(soFar: string, proposed: string | undefined, max = 6000): string {
	const text = proposed?.trim() ?? "";
	if (text.length === 0 || soFar.includes(text.slice(0, 200))) return soFar;
	const joined = soFar ? `${soFar}\n  write xd://propose:\n${text}` : `  write xd://propose:\n${text}`;
	return maskedTail(joined, max, redactOn());
}

/**
 * First user turn at or after `from`: the plan's objective once it is in the branch. With pipeline.skillAware a skill the
 * user invoked is a turn too, and what they typed besides the skill token is what they said (see userTurnText).
 */
function firstUserTextFrom(entries: EntryView[], from: number): string {
	for (let i = Math.max(0, from); i < entries.length; i++) {
		const text = userTurnText(entries[i], skillTurns()).trim();
		if (text.length > 0) return maskedCap(text, 4000, redactOn());
	}
	return "";
}

/** omp's id of the first user turn at or after `from`; null when there is none, or it has no id. */
function firstUserIdFrom(entries: EntryView[], from: number): string | null {
	for (let i = Math.max(0, from); i < entries.length; i++) {
		if (userTurnText(entries[i], skillTurns()).trim().length > 0) return entries[i].id;
	}
	return null;
}

/**
 * The stop event's final assistant message as text. omp passes its AssistantMessage object (a `content` array of
 * blocks); a plain string is accepted too.
 */
function lastMessageText(message: unknown): string {
	if (typeof message === "string") return message.trim();
	return isRecord(message) ? textFromContent(message.content, 2000, redactOn()).trim() : "";
}

/** Directory for /adversary dump: omp keeps its logs next to the agent dir (~/.omp/agent -> ~/.omp/logs). */
function dumpDir(): string {
	const dir = agentDir();
	return basename(dir) === "agent" ? join(dirname(dir), "logs") : join(dir, "logs");
}

function safeFileId(id: unknown): string {
	const text = typeof id === "string" || typeof id === "number" ? String(id) : "unknown";
	return text.replace(/[^\w.-]/g, "_").slice(0, 80) || "unknown";
}

/** Resolve with the work's result, or null once `ms` has passed; the work is told to stop via its signal. */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(null);
		}, ms);
	});
	try {
		return await Promise.race([work(controller.signal), expired]);
	} finally {
		clearTimeout(timer);
	}
}

function answerNumber(answer: WireAnswer | undefined, key: string): number | null {
	if (!answer) return null;
	const value = answer[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Format probabilities map ("0": 0.62, ...) as "0=0.62 1=0.30". */
function formatProbabilities(probabilities: unknown): string {
	if (!isRecord(probabilities)) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(probabilities)) {
		if (typeof value === "number") parts.push(`${key}=${value.toFixed(2)}`);
	}
	return parts.join(" ");
}

function summarizeAnswers(answers: Record<string, WireAnswer>): string {
	const lines: string[] = [];
	for (const [id, a] of Object.entries(answers)) {
		if (a.type === "noul") {
			lines.push(`${id}.noul = ${typeof a.noul === "number" ? a.noul.toFixed(3) : String(a.noul)}`);
		} else if (a.type === "choice") {
			const conf = typeof a.confidence === "number" ? a.confidence.toFixed(3) : "?";
			const probs = formatProbabilities(a.probabilities);
			lines.push(`${id}.choice = ${String(a.choice)} (confidence ${conf}${probs ? `; probabilities ${probs}` : ""})`);
		} else if (a.type === "score") {
			const conf = typeof a.confidence === "number" ? a.confidence.toFixed(3) : "?";
			const probs = formatProbabilities(a.probabilities);
			const legend = isRecord(a.legend)
				? Object.entries(a.legend)
						.map(([k, v]) => `${k}=${String(v)}`)
						.join(" ")
				: "";
			lines.push(`${id}.score = ${typeof a.score === "number" ? a.score.toFixed(3) : String(a.score)} (confidence ${conf}${legend ? `; legend ${legend}` : ""}${probs ? `; probabilities ${probs}` : ""})`);
		}
	}
	return lines.join("\n");
}

function normalizeOptions(options: unknown): Record<string, string> | undefined {
	if (Array.isArray(options)) {
		const map: Record<string, string> = {};
		for (const entry of options) {
			if (isRecord(entry) && typeof entry.name === "string" && entry.name.length > 0) {
				map[entry.name] = typeof entry.description === "string" ? entry.description : "";
			}
		}
		return Object.keys(map).length > 0 ? map : undefined;
	}
	if (isRecord(options)) {
		const map: Record<string, string> = {};
		for (const [key, value] of Object.entries(options)) {
			if (typeof value === "string") map[key] = value;
		}
		return Object.keys(map).length > 0 ? map : undefined;
	}
	return undefined;
}

/** What the model passes to typesafe_ask; the host validates it against the schema registered below. */
interface AskToolParams {
	state: string;
	stateFormat?: "text" | "json";
	questions: unknown;
	model?: string;
}

/** The API allows at most this many options in one choice question. */
const MAX_CHOICE_OPTIONS = 255;

function buildWireQuestions(items: unknown): { questions?: Questions; error?: string } {
	if (!Array.isArray(items) || items.length === 0) return { error: "questions must be a non-empty array" };
	const questions: Questions = {};
	for (const raw of items) {
		if (!isRecord(raw)) return { error: "each question must be an object" };
		const id = typeof raw.id === "string" ? raw.id : "";
		if (!id || id === "__proto__") return { error: "question.id is required" };
		// Answers come back keyed by id, so a repeated id would silently drop the earlier question.
		if (Object.hasOwn(questions, id)) return { error: `duplicate question id: ${id}` };
		const type = raw.type;
		const instructions = typeof raw.instructions === "string" ? raw.instructions : "";
		if (type === "noul") {
			const whenTrue = typeof raw.whenTrue === "string" ? raw.whenTrue : undefined;
			const whenFalse = typeof raw.whenFalse === "string" ? raw.whenFalse : undefined;
			questions[id] = noul(instructions, whenTrue !== undefined || whenFalse !== undefined ? { true: whenTrue, false: whenFalse } : undefined);
		} else if (type === "choice") {
			const criteria = normalizeOptions(raw.options);
			if (!criteria || Object.keys(criteria).length < 2) return { error: `question ${id}: choice requires options with at least 2 entries` };
			if (Object.keys(criteria).length > MAX_CHOICE_OPTIONS) return { error: `question ${id}: choice allows at most ${MAX_CHOICE_OPTIONS} options` };
			questions[id] = choice(instructions, criteria);
		} else if (type === "score") {
			const levels = Array.isArray(raw.levels) ? raw.levels.filter((l): l is string => typeof l === "string") : [];
			if (levels.length < 2 || levels.length > 10) return { error: `question ${id}: score requires 2-10 levels` };
			const [lowest, next, ...higher] = levels;
			questions[id] = score(instructions, [lowest, next, ...higher]);
		} else {
			return { error: `question ${id}: type must be noul, choice, or score` };
		}
	}
	return { questions };
}

/**
 * Ambiguity gate helpers. Everything here is defensive: any failure yields a
 * "none" decision and the plan-mode flow continues untouched.
 */

interface GateRunOptions {
	/** `git status` text the caller already collected this turn (the turn review's evidence). */
	status?: string;
	/** Content of the `xd://propose` write being gated, appended to the plan text when not yet in the branch. */
	proposed?: string;
}

interface SteerOptions extends Pick<GateRunOptions, "status"> {
	/** Hand the note back to the caller (before_agent_start's `{ message }`) instead of queueing an aside. */
	asReturn?: boolean;
}

export default function typesafeExtension(pi: ExtensionAPI) {
	pi.setLabel("TypeSafe Adversary");
	const logger = pi.logger;
	const z = pi.zod;

	/**
	 * `pi.on` for every hook below: in a subagent session the handler does not run and its event gets no answer, so
	 * a subagent never touches the parent's state, reviews, gates or writes the bench log (see src/subagent.ts).
	 * The tool and the commands are not hooks and work from any session.
	 */
	const on = <K extends keyof HostEvents>(
		event: K,
		handler: (event: HostEvents[K]["event"], ctx: HostContext) => HostEvents[K]["result"] | Promise<HostEvents[K]["result"]>,
	): void => {
		pi.on(event, (e, ctx) => (skipSubagent(ctx) ? (undefined as HostEvents[K]["result"]) : handler(e, ctx)));
	};

	/** Scan the branch and notice when a plan has started or ended, so per-plan state never outlives its plan. */
	const branchEntries = (ctx: { sessionManager: { getBranch(): unknown } }): EntryView[] => {
		const entries = scanBranch(ctx.sessionManager.getBranch());
		const start = planStartIndex(entries);
		const startId = start >= 0 ? entries[start].id : null;
		const firstUserId = start >= 0 ? firstUserIdFrom(entries, start) : null;
		// A different plan: another start, or another objective under the same start (a sibling branch, or one that no
		// longer holds the prompt the state was built from). The objective's own first arrival is not a change.
		if (start !== planStart || startId !== planStartId || (planFirstUserId !== null && firstUserId !== planFirstUserId)) {
			planStart = start;
			planStartId = startId;
			planFirstUserId = null;
			resetPlanState();
		}
		if (planFirstUserId === null) planFirstUserId = firstUserId;
		return entries;
	};

	const resetPlanState = (): void => {
		planStartScored = false;
		planPrompt = "";
		planPromptAwaitingEcho = false;
		planOutline = null;
		resetAmbiguityPlan();
	};

	const reloadPriorities = async (cwd: string | undefined, role: TypesafeRole): Promise<void> => {
		try {
			priorities = await loadPriorities(cwd ?? process.cwd(), role);
		} catch (err) {
			priorities = "";
			logger?.warn?.(`[typesafe] priorities not loaded: ${describeError(err)}`);
		}
	};

	/** Everything that belongs to one session: config, client, reviewer and gate state, overrides. */
	const resetSessionState = async (ctx: HostContext, announceMissingKey: boolean): Promise<void> => {
		await loadConfig(logger);
		setClientLogger(logger);
		sessionOverride = null;
		sessionRoleOverride = null;
		sessionGateOverride = null;
		await reloadPriorities(ctx.cwd, resolvedRole());
		resetUsage();
		resetClient();
		resetReviewerSession();
		resetEvidenceTurn();
		resetSubagentStats();
		reviewedCallIds.clear();
		stopGateUses = 0;
		baseline = null;
		promptSkill = null;
		planGuardBlocks = 0;
		approvalBlocks = 0;
		approvalWouldBlocks = 0;
		specNotesSent = 0;
		specNoteKeys.clear();
		compactor = undefined;
		resetAmbiguitySession();
		planStart = -1;
		planStartId = null;
		planFirstUserId = null;
		resetPlanState();
		turnCursor = scanBranch(ctx.sessionManager.getBranch()).length;
		pi.setLabel(roleLabel(resolvedRole()));
		for (const warning of getConfigWarnings()) notifyVia(ctx, logger, warning, "warning");
		if (announceMissingKey && !apiKeyPresent()) {
			logger?.warn?.("[typesafe] TYPESAFE_API_KEY is not set; adversary and typesafe_ask stay inactive");
			notifyVia(ctx, logger, "TypeSafe adversary inactive: TYPESAFE_API_KEY not set", "warning");
		}
	};

	// omp emits session_start for the main session once per process (and once for every subagent session, which the
	// guard skips); /new, /resume, fork and plan approval arrive as session_switch.
	on("session_start", async (_event, ctx) => {
		await resetSessionState(ctx, true);
	});
	on("session_switch", async (_event, ctx) => {
		await resetSessionState(ctx, false);
	});

	const resetCursor = async (_event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		turnCursor = scanBranch(ctx.sessionManager.getBranch()).length;
	};
	// Another branch may hold another plan that starts at the very same index, or the same start entry with another first
	// prompt (a sibling made by /branch). omp's entry ids tell them apart (the plan's own start entry and first prompt are
	// still there after a navigation within it), so branchEntries drops the state only when an id changed; with no id to
	// go by, assume another plan. The plan's first prompt is such an id too, and while it is unknown (before_agent_start
	// recorded the prompt, but the turn died before the message reached the branch) a first prompt that the branch
	// holds after a navigation can only be a sibling's, made by /branch or /tree under the same start entry.
	const resetCursorAndPlan = async (event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		if (planStartId === null) {
			planStart = -1;
		} else if (planFirstUserId === null) {
			const entries = scanBranch(ctx.sessionManager.getBranch());
			const start = planStartIndex(entries);
			if (start >= 0 && firstUserIdFrom(entries, start) !== null) planStart = -1;
		}
		// Another branch has not seen the spec notes this one did.
		specNoteKeys.clear();
		await resetCursor(event, ctx);
	};
	on("session_branch", resetCursorAndPlan);
	on("session_tree", resetCursorAndPlan);
	on("session_compact", resetCursor);

	// Replaces the messages of this one request, never the session. Off without a key: nothing to score with, and no cost.
	on("context", async (event) => {
		const cfg = getConfig().compaction;
		if (!cfg.enabled || !event.messages || !apiKeyPresent()) return;
		try {
			compactor ??= createCompactor(cfg, { redact: redactOn(), log: (message) => logger?.info?.(message) });
			const messages = await compactor(event.messages);
			return messages ? { messages } : undefined;
		} catch (err) {
			logger?.warn?.(`[typesafe] context compaction failed: ${describeError(err)}`);
		}
	});

	/** One user prompt: reset the per-prompt budgets and the command log, and pin the HEAD to diff against. */
	on("agent_start", async (_event, ctx) => {
		beginPrompt();
		resetEvidenceTurn();
		stopGateUses = 0;
		baseline = null;
		try {
			if (reviewEnabled() && getConfig().adversary.evidence && apiKeyPresent()) baseline = await captureBaseline(pi, ctx.cwd);
		} catch (err) {
			logger?.warn?.(`[typesafe] baseline capture failed: ${describeError(err)}`);
		}
	});

	/** One model call (plus its tool runs). */
	on("turn_start", async (event) => {
		beginTurn(isRecord(event) && typeof event.turnIndex === "number" ? event.turnIndex : undefined);
		reviewedCallIds.clear();
	});

	const evidenceOptions = (focusPaths?: string[]): CollectOptions => ({
		...(focusPaths && focusPaths.length > 0 ? { focusPaths } : {}),
		...(baseline ? { baseline } : {}),
		redact: getConfig().adversary.redact,
		excludePipeline: getConfig().pipeline.skillAware,
	});

	/**
	 * Queue a host message; sendMessage returns void, so all that can be reported is that it did not throw. Only an aside goes
	 * out this way: the one caller (the spec note) needs its message at the model's next step, and `nextTurn` would be later.
	 */
	const send = (message: HostMessage, options: { deliverAs: "aside" }): boolean => {
		try {
			const sent: unknown = pi.sendMessage(message, options);
			if (sent instanceof Promise) sent.catch((err) => logger?.warn?.(`[typesafe] sendMessage rejected: ${describeError(err)}`));
			return true;
		} catch (err) {
			logger?.warn?.(`[typesafe] sendMessage failed: ${describeError(err)}`);
			return false;
		}
	};

	// ---- ambiguity gate ------------------------------------------------------

	/** Is omp's `ask` tool active? Headless runs have none; without the host API, only a UI implies one. */
	const askToolActive = (ctx: { hasUI?: boolean }): boolean => {
		try {
			const tools: unknown = pi.getActiveTools?.();
			if (Array.isArray(tools)) return tools.includes("ask");
		} catch (err) {
			logger?.debug?.(`[typesafe] getActiveTools failed: ${describeError(err)}`);
		}
		return ctx.hasUI === true;
	};

	/** Gate preconditions: plan mode, enabled, key present, ask budget left. */
	const gateEligible = (entries: EntryView[]): boolean => {
		if (!gateEnabled() || !apiKeyPresent()) return false;
		if (!planModeActive(entries)) return false;
		return asksObserved() < getConfig().ambiguityGate.maxAsksPerPlan;
	};

	/**
	 * The plan's objective: its first prompt, never a later follow-up such as "B". Once found it is kept, so a
	 * prompt that came before the plan marker (--plan-yolo) is not replaced by a later short reply.
	 */
	const planTask = (entries: EntryView[]): string => {
		if (planPrompt === "") planPrompt = firstUserTextFrom(entries, planStart) || lastUserText(entries, 4000, redactOn(), skillTurns());
		return planPrompt;
	};

	/** The repo outline is stable within a plan, so it is listed once per plan. */
	const outlineFor = async (ctx: HostContext, signal: AbortSignal): Promise<string> => {
		if (planOutline !== null) return planOutline;
		const outline = await repoOutline(pi, ctx.cwd, { signal });
		if (outline) planOutline = outline;
		return outline;
	};

	/**
	 * One scored gate evaluation; never throws, returns null when it could not score. It reads `git status`
	 * only (the outline and status run in parallel) and gives up after a deadline well below omp's
	 * fail-closed tool_call timeout, so a slow git or Jev can never hold up or block a plan write.
	 */
	const runGate = async (ctx: HostContext, entries: EntryView[], trigger: GateTrigger, task: string, opts: GateRunOptions = {}): Promise<AmbiguityResult | null> => {
		const gcfg = getConfig().ambiguityGate;
		const redact = getConfig().adversary.redact;
		try {
			return await withDeadline(async (signal) => {
				const asked = getAsks();
				const typed = getUserReplies();
				const [outline, status] = await Promise.all([
					outlineFor(ctx, signal),
					opts.status !== undefined ? opts.status : collectStatus(pi, ctx.cwd, { signal, redact, excludePipeline: getConfig().pipeline.skillAware }).then((s) => s.status ?? ""),
				]);
				const state = sanitizeState({
					task: maskedCap(task, 4000, redact),
					plan_so_far: withProposed(planSoFar(entries, 6000, undefined, redact), opts.proposed),
					questions_already_asked: asked.map((a) => a.question),
					answers_received: asked.map((a) => a.answer),
					...(typed.length > 0 ? { user_replies: typed } : {}),
					evidence: { status, repo_outline: outline },
				});
				return scoreAmbiguity(pi, state as unknown as Parameters<typeof scoreAmbiguity>[1], gcfg, { trigger });
			}, Math.min(GATE_DEADLINE_CAP_MS, gcfg.timeoutMs + GATE_SLACK_MS));
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity scoring failed (${trigger}): ${describeError(err)}`);
			return null;
		}
	};

	const noteScore = (trigger: GateTrigger, result: AmbiguityResult, decision: GateDecision): void => {
		recordScore({
			ts: new Date().toISOString(),
			trigger,
			ambiguity: result.ambiguity,
			dims: result.dims,
			weakest: result.weakest,
			gap: result.gap,
			userCanAnswer: result.userCanAnswer,
			decision,
			question: result.question,
		});
	};

	/**
	 * Score and, when the task is still too ambiguous and an `ask` tool exists, steer the model to ask.
	 * With `asReturn` the note is returned for before_agent_start to put into the request being started.
	 */
	const steerIfAmbiguous = async (ctx: HostContext, entries: EntryView[], trigger: GateTrigger, task: string, opts: SteerOptions = {}): Promise<{ message: HostMessage } | undefined> => {
		try {
			if (!gateEligible(entries)) return;
			const gcfg = getConfig().ambiguityGate;
			const result = await runGate(ctx, entries, trigger, task, { status: opts.status });
			if (!result) return;
			planStartScored = true;
			const askAvailable = askToolActive(ctx);
			let decision = steerDecision(result, gcfg, { askAvailable, immune: isSteerImmune() });
			let out: { message: HostMessage } | undefined;
			if (decision === "steer") {
				const message: HostMessage = {
					customType: GATE_CUSTOM_TYPE,
					content: buildGateNote(result, gcfg.threshold, askAvailable),
					display: true,
					attribution: "agent",
				};
				if (opts.asReturn) out = { message };
				else if (!send(message, { deliverAs: "aside" })) decision = "would_steer";
				// Only a steer that went out silences the dimension; a failed send may be retried next turn.
				if (decision === "steer") markSteered(result.weakest);
			}
			noteScore(trigger, result, decision);
			return out;
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity gate failed (${trigger}): ${describeError(err)}`);
		}
	};

	// ---- pipeline (omp-skills) ---------------------------------------------------
	// deep-interview -> a spec, ralplan -> a PRD, dag -> a run. Everything here is local: no Jev call, nothing sent.

	/**
	 * Is the current prompt a run of a pipeline skill, a turn the skill drives itself (its own interview, its own
	 * gates)? `entries` is the branch once the prompt is on it; without it only what before_agent_start read off the
	 * prompt counts, because the branch then still ends with the previous prompt.
	 */
	const pipelineRun = (entries?: EntryView[]): boolean => {
		const cfg = getConfig().pipeline;
		if (!cfg.skillAware) return false;
		const invoked = promptSkill ?? (entries ? latestUserTurnSkill(entries) : null);
		return invoked !== null && isPipelineSkill(invoked.name, cfg.skills);
	};

	/**
	 * Is the plan's task empty because the user's only prompt so far was a skill invoked with nothing typed besides its
	 * token? Its expanded text is no stand-in for a task and the bare token says nothing, so there is nothing to score
	 * until they write something. An empty task for any other reason is scored as it always was.
	 */
	const noWordsYet = (entries: EntryView[], task: string): boolean => {
		if (task.trim() !== "" || !getConfig().pipeline.skillAware) return false;
		return promptSkill !== null || latestUserTurnSkill(entries) !== null;
	};

	/**
	 * What the pipeline guards say about one tool call: a block, or nothing. Each reads the branch and the input and
	 * nothing else (no model, no network) and fails open, so a bug here can never stop a tool.
	 */
	const pipelineGuard = (toolName: string, input: unknown, ctx: HostContext): ToolCallResult | undefined => {
		const cfg = getConfig().pipeline;
		let entries: EntryView[] | undefined;
		const branch = (): EntryView[] => (entries ??= scanBranch(ctx.sessionManager.getBranch()));
		try {
			// Scanning the branch costs more than looking for the two names, and most eval cells call neither.
			const code = isRecord(input) && typeof input.code === "string" ? input.code : "";
			if (cfg.planGuard && toolName === "eval" && DAG_CALLS.some((name) => code.includes(name))) {
				const verdict = planGuardDecision(branch(), toolName, input, cfg);
				if (verdict.block) {
					planGuardBlocks += 1;
					return { block: true, reason: verdict.reason };
				}
			}
		} catch (err) {
			logger?.warn?.(`[typesafe] plan guard failed: ${describeError(err)}`);
		}
		try {
			// Most writes approve nothing, and reading the input is cheaper than scanning the branch.
			if (cfg.approvalGuard && APPROVAL_TOOLS.has(toolName) && detectApprovalFlips(toolName, input).length > 0) {
				const decision = decideApproval(toolName, input, branch(), { askAvailable: askToolActive(ctx) });
				if (decision.action === "block") {
					approvalBlocks += 1;
					return { block: true, reason: decision.reason };
				}
				if (decision.action === "would_block") {
					// No `ask` tool (a headless run): nobody could have answered, and nothing is stopped; it is only recorded.
					approvalWouldBlocks += 1;
					logger?.info?.(`[typesafe] would block ${decision.flip.artifact} approval (no ask tool): ${decision.reason}`);
				} else if (decision.failedOpen) {
					logger?.debug?.(`[typesafe] approval guard failed open: ${decision.failedOpen}`);
				}
			}
		} catch (err) {
			logger?.warn?.(`[typesafe] approval guard failed: ${describeError(err)}`);
		}
		return undefined;
	};

	/**
	 * A write to `.omp/pipeline/specs/<slug>.md`: check the draft as it is on disk and, when it has problems, tell the model
	 * once per content (a rewrite that changes nothing says nothing again). Advisory: it never blocks or edits the result,
	 * and a file it cannot read is no problem. The note is an aside: a write is always followed by a model step, which
	 * takes it up at the step boundary, before the approval ask. `nextTurn` would hold it until the user's next prompt,
	 * after the spec was asked about.
	 */
	const checkSpecWrite = async (input: unknown, ctx: HostContext): Promise<void> => {
		try {
			const target = inputPaths(input).find(isSpecPath);
			if (!target) return;
			const abs = resolve(ctx.cwd ?? process.cwd(), target);
			const text = await Bun.file(abs).text();
			const check = checkSpec(text, buildQuoteCorpus(scanBranch(ctx.sessionManager.getBranch())));
			const key = `${abs}\0${specHash(text)}`;
			if (check.problems.length === 0 || specNoteKeys.has(key)) return;
			const note = renderSpecNote(target, check.problems);
			if (note === null) return;
			specNoteKeys.add(key);
			// Only a note that went out is spent; a failed send may be retried by the next write of the same content.
			if (send({ customType: SPEC_NOTE_CUSTOM_TYPE, content: note, display: true, attribution: "agent" }, { deliverAs: "aside" })) specNotesSent += 1;
			else specNoteKeys.delete(key);
		} catch (err) {
			logger?.debug?.(`[typesafe] spec check skipped: ${describeError(err)}`);
		}
	};

	on("before_agent_start", async (event, ctx) => {
		promptSkill = null;
		try {
			const raw = isRecord(event) && typeof event.prompt === "string" ? event.prompt : "";
			promptSkill = getConfig().pipeline.skillAware ? parseSkillPrompt(raw) : null;
			const entries = branchEntries(ctx);
			if (!planModeActive(entries)) return;
			// A skill's prompt is its whole expanded text; what the user said is what they typed besides the skill token.
			const prompt = (promptSkill ? promptSkill.args : raw).trim();
			// The first prompt of a plan is its objective; later prompts are answers, not a new task.
			if (planPrompt === "") {
				const persisted = firstUserTextFrom(entries, planStart);
				planPrompt = persisted || maskedCap(prompt, 4000, redactOn());
				// An expanded skill prompt reaches the branch as a skill-prompt entry, with no user message to echo it. Every other
				// prompt does, the raw `/skill:` text of print mode included, and it is not a reply, even when nothing but the token
				// was typed (planPrompt is "" then, and the echo must not become the objective).
				planPromptAwaitingEcho = persisted === "" && raw.trim() !== "" && promptSkill?.source !== "expanded";
			} else {
				// A later prompt is a reply; a flag left over from a first prompt that never reached its message_end must not swallow it.
				planPromptAwaitingEcho = false;
			}
			// A pipeline skill runs its own interview and gates: nothing to score, and no question to add to its own.
			if (pipelineRun() || planStartScored || planPrompt === "") return;
			return await steerIfAmbiguous(ctx, entries, "plan_start", planPrompt, { asReturn: true });
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity plan_start failed: ${describeError(err)}`);
		}
	});

	on("tool_call", async (event, ctx) => {
		try {
			if (!isRecord(event)) return;
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			// Synchronous and local, so ahead of the gate's early returns (they would let an eval cell by) and its Jev call.
			const blocked = pipelineGuard(toolName, event.input, ctx);
			if (blocked) return blocked;
			if (toolName !== "write" || !isProposeWrite(event.input)) return;
			const entries = branchEntries(ctx);
			const gcfg = getConfig().ambiguityGate;
			if (!gateEnabled() || !gcfg.blockPropose || !apiKeyPresent() || !planModeActive(entries) || pipelineRun(entries)) return;
			// Once the ask budget for this plan is spent, stop gating rather than looping.
			if (asksObserved() >= gcfg.maxAsksPerPlan) return;
			const proposed = isRecord(event.input) && typeof event.input.content === "string" ? event.input.content : undefined;
			const task = planTask(entries);
			if (noWordsYet(entries, task)) return;
			const result = await runGate(ctx, entries, "propose", task, { proposed });
			if (!result) return;
			const askAvailable = askToolActive(ctx);
			const decision = proposeDecision(result, gcfg, ctx?.hasUI === true, { askAvailable });
			noteScore("propose", result, decision);
			if (decision !== "block") return;
			noteProposeBlock();
			return { block: true, reason: buildBlockReason(result, gcfg.threshold, askAvailable) };
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity propose gate failed: ${describeError(err)}`);
		}
	});

	on("turn_end", async (event, ctx) => {
		try {
			const cfg = getConfig().adversary;
			const entries = branchEntries(ctx);
			const deltaEntries = entries.slice(Math.max(0, Math.min(turnCursor, entries.length)));
			turnCursor = entries.length;
			// An aborted or failed model call, or a tool batch the user stopped, must not wake the agent with a note or a question.
			if (isRecord(event) && (endedAbnormally(event.message) || interruptedBatch(event.toolResults))) return;
			let reviewEvidence: Evidence | undefined;
			if (reviewEnabled() && cfg.reviewTurns && apiKeyPresent() && deltaEntries.length > 0 && phaseAllowed(entries) && !readOnlyStep(deltaEntries)) {
				const delta = renderDelta(deltaEntries, 6000, redactOn(), skillTurns());
				if (delta.trim().length > 0) {
					// No git probes for a review the call budget would suppress anyway.
					reviewEvidence = cfg.evidence && hasCallBudget() ? await collectEvidence(pi, ctx.cwd, evidenceOptions()) : undefined;
					const state: Record<string, unknown> = { task: lastUserText(entries, 1200, redactOn(), skillTurns()), review_priorities: priorities, delta };
					if (reviewEvidence) state.evidence = reviewEvidence;
					await review(pi, "turn", sanitizeState(state), ctx, { evidence: reviewEvidence }, resolvedRole());
				}
			}
			// The gate only needs `git status`, which the turn review already collected. Under --plan-yolo
			// nothing marks the start of the plan, so its first evaluation stands in for plan_start. A pipeline skill's own
			// turn is left to the skill, and so is a skill the user has not yet said anything beside.
			const task = planTask(entries);
			if (!pipelineRun(entries) && !noWordsYet(entries, task)) await steerIfAmbiguous(ctx, entries, planStartScored ? "turn_end" : "plan_start", task, { status: reviewEvidence?.status });
		} catch (err) {
			logger?.warn?.(`[typesafe] turn_end review failed: ${describeError(err)}`);
		} finally {
			// The prompt's own message was delivered before the first model call ended; any user message after is a reply.
			planPromptAwaitingEcho = false;
			endTurn();
		}
	});

	/** A user message in plan mode: the plan's objective if none is set yet, otherwise an answer to the gate's question. */
	const noteUserMessage = (raw: Record<string, unknown>, ctx: { sessionManager: { getBranch(): unknown } }): void => {
		const entries = branchEntries(ctx);
		if (!planModeActive(entries)) return;
		const text = textFromContent(raw.content, 4000, redactOn()).trim();
		if (text.length === 0) return;
		// The user message that carries the plan's own prompt is not an answer, and not the objective either when
		// before_agent_start already read the prompt (a raw skill token with nothing typed besides it has none). omp builds
		// event.prompt by joining a message's text blocks with "" and the branch joins them with "\n", so the two texts cannot
		// be compared: the first user message after before_agent_start captured the prompt is that prompt.
		if (planPromptAwaitingEcho) planPromptAwaitingEcho = false;
		else if (planPrompt === "") planPrompt = text;
		else recordFollowUp(text);
	};

	on("message_end", async (event, ctx) => {
		try {
			const raw = isRecord(event) && "message" in event ? event.message : event;
			if (!isRecord(raw)) return;
			// Only real user messages count: omp's synthetic prompts carry the developer role.
			if (raw.role === "user") {
				noteUserMessage(raw, ctx);
				return;
			}
			if (raw.role !== "assistant" || endedAbnormally(raw)) return;
			const cfg = getConfig().adversary;
			if (!reviewEnabled() || !cfg.reviewMessages || !apiKeyPresent() || !canReviewMessage()) return;
			const text = textFromContent(raw.content, 4000, redactOn());
			if (text.length < cfg.minMessageChars) return;
			const entries = branchEntries(ctx);
			if (!phaseAllowed(entries)) return;
			recordMessageReviewed();
			const state: Record<string, unknown> = {
				task: lastUserText(entries, 1200, redactOn(), skillTurns()),
				review_priorities: priorities,
				assistant_message: text,
				recent_actions: priorActions(entries, 5, redactOn()),
			};
			await review(pi, "message", sanitizeState(state), ctx, {}, resolvedRole());
		} catch (err) {
			logger?.warn?.(`[typesafe] message_end review failed: ${describeError(err)}`);
		}
	});

	on("tool_result", async (event, ctx) => {
		try {
			if (!isRecord(event)) return;
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			if (toolName === "ask") {
				// Answered questions count against this plan's ask budget (cancelled and invalid asks do not).
				if (planModeActive(branchEntries(ctx))) recordAskResult(event.input, event.content, event.isError === true, event.details);
				return;
			}
			// Before the review gates below: the check needs no key and no reviewer, and the review still runs after it.
			if (SPEC_WRITE_TOOLS.has(toolName) && event.isError !== true && getConfig().pipeline.specChecks) await checkSpecWrite(event.input, ctx);
			if (toolCallId) {
				if (reviewedCallIds.has(toolCallId)) return;
				reviewedCallIds.add(toolCallId);
			}
			const failed = event.isError === true;
			// Recorded before every review gate, so a failing or unreviewed `bun test` is still known to the reviewer.
			recordAction(toolName, { command: commandText(event.input), isError: failed, redact: redactOn() });
			const cfg = getConfig().adversary;
			if (!reviewEnabled() || !cfg.reviewActions || !apiKeyPresent()) return;
			if (toolName === "typesafe_ask" || !toolCallId) return;
			if (!cfg.tools.includes(toolName)) return;
			// A failed edit changed nothing; a failed shell command may already have discarded work.
			if (failed && !REVIEW_WHEN_FAILED.has(toolName)) return;
			const content: HostContentBlock[] = Array.isArray(event.content) ? (event.content as HostContentBlock[]) : [];
			// Not a command that ran and failed (the user stopped it, omp blocked it): nothing to judge, and a late note
			// must not restart the run.
			if (failed && !ranAndFailed(toolName, event.details)) return;
			const resultText = textFromContent(content, 2000, redactOn());
			const entries = branchEntries(ctx);
			if (!phaseAllowed(entries)) return;
			// Skip the git probes when the call budget would suppress the review anyway.
			const evidence =
				cfg.evidence && hasCallBudget()
					? await collectEvidence(pi, ctx.cwd, evidenceOptions(EDIT_TOOLS.has(toolName) ? editedPaths(event.input) : undefined))
					: undefined;
			const state: Record<string, unknown> = {
				task: lastUserText(entries, 1200, redactOn(), skillTurns()),
				review_priorities: priorities,
				// Masked before it is stringified and cut: JSON escaping would hide quoted secrets, and a cut could split one.
				action: { tool: toolName, input: stringifyInput(sanitizeValue(event.input, redactOn(), { maxString: TOOL_INPUT_CAP * 4 }), TOOL_INPUT_CAP) },
				result: resultText,
				exit_status: failed ? "error" : "ok",
				claimed_intent: claimedIntent(entries, 800, redactOn()),
				prior_actions: priorActions(entries, 3, redactOn()),
			};
			if (evidence) state.evidence = evidence;
			const outcome = await review(pi, "action", sanitizeState(state), ctx, { toolCallId, evidence, inline: cfg.inlineActionNotes }, resolvedRole());
			// The reviewer skipped sendMessage for this note, so the tool result is its only delivery.
			if (outcome.decision === "delivered_inline" && outcome.note) {
				// content is a full replacement — spread the original array back in.
				return { content: [...content, { type: "text", text: `\n${outcome.note}` }] };
			}
		} catch (err) {
			logger?.warn?.(`[typesafe] tool_result review failed: ${describeError(err)}`);
		}
	});

	on("session_stop", async (event, ctx) => {
		const gate = getConfig().stopGate;
		if (!gate.enabled || stopGateUses >= 2 || !apiKeyPresent() || !reviewEnabled()) return;
		// The host sets stop_hook_active when this very gate's continuation is what stopped; never chain another.
		if (isRecord(event) && event.stop_hook_active === true) return;
		try {
			const entries = scanBranch(ctx.sessionManager.getBranch());
			// "Finish the remaining work" would push a planning agent toward implementing.
			if (planModeActive(entries) || !getConfig().phases.includes("execute")) return;
			const questions: Questions = {
				verified: noul("The assistant ran a command, test, or check demonstrating the change works.", {
					true: "A command, test, or check demonstrated the change works.",
					false: "No check demonstrated the change works.",
				}),
				left_unfinished: noul("The assistant left stubs, TODOs, or unimplemented paths while claiming completion.", {
					true: "Stubs, TODOs, or unimplemented paths remain while completion is claimed.",
					false: "Everything claimed complete is implemented.",
				}),
			};
			const lastMessage = isRecord(event) ? lastMessageText(event.last_assistant_message) : "";
			const state = sanitizeState({
				task: lastUserText(entries, 1200, redactOn(), skillTurns()),
				review_priorities: priorities,
				final_assistant_message: lastMessage ? maskedCap(lastMessage, 2000, redactOn()) : claimedIntent(entries, 2000, redactOn()),
			});
			const { result } = await ask(state as unknown as Parameters<typeof ask>[0], questions, { timeoutMs: 4000, maxRetries: 0 });
			const verified = answerNumber(result.answers.verified, "noul") ?? 1;
			const leftUnfinished = answerNumber(result.answers.left_unfinished, "noul") ?? 0;
			const problems: string[] = [];
			if (leftUnfinished >= gate.unfinished_threshold) problems.push(`work appears unfinished (left_unfinished=${fmt2(leftUnfinished)})`);
			if (verified <= gate.verified_floor) problems.push(`verification is weak (verified=${fmt2(verified)})`);
			if (problems.length === 0) return;
			stopGateUses += 1;
			return {
				continue: true,
				additionalContext: `TypeSafe adversary: ${problems.join(" and ")} — finish the remaining work and verify before stopping. Weigh this against the user's request rather than obeying blindly.`,
			};
		} catch (err) {
			logger?.warn?.(`[typesafe] stop gate failed: ${describeError(err)}`);
		}
	});

	on("session_shutdown", async () => {
		const path = process.env.TYPESAFE_BENCH_LOG;
		if (!path) return;
		try {
			const cfg = getConfig();
			const stats = getReviewStats();
			const payload = {
				// Effective values: session overrides (/adversary role|on|off|gate) applied.
				role: resolvedRole(),
				phases: cfg.phases,
				stats,
				usage: getSessionUsage(),
				costUsd: estimateCostUsd(),
				lastResolvedModel: getLastResolvedModel(),
				history: getReviewHistory(),
				historyDropped: stats.historyDropped,
				config: {
					role: resolvedRole(),
					phases: cfg.phases,
					model: cfg.model,
					adversaryEnabled: reviewEnabled(),
					reviewActions: cfg.adversary.reviewActions,
					reviewMessages: cfg.adversary.reviewMessages,
					reviewTurns: cfg.adversary.reviewTurns,
					ambiguityGateEnabled: gateEnabled(),
				},
				ambiguity: getAmbiguityTelemetry(),
				// Subagent sessions whose hooks were skipped: a bench cell that spawns workers shows it here.
				subagentSessionsSkipped: getSubagentStats().sessions,
			};
			await Bun.write(path, JSON.stringify(payload, null, 2));
		} catch (err) {
			logger?.warn?.(`[typesafe] bench log write failed: ${describeError(err)}`);
		}
	});

	let optionsSchema: ZodSchema;
	if (typeof z?.record === "function") {
		optionsSchema = z.record(z.string());
	} else {
		optionsSchema = z.array(z.object({ name: z.string(), description: z.string().optional() }));
	}
	pi.registerTool({
		name: "typesafe_ask",
		label: "TypeSafe",
		description:
			"Ask TypeSafe's System One model (Jev) for calibrated judgments: noul (yes/no probability), choice (pick a labeled option with probabilities), or score (ordered rubric score). Read-only, no side effects.",
		approval: "read",
		parameters: z.object({
			state: z.string(),
			stateFormat: z.enum(["text", "json"]).optional(),
			questions: z.array(
				z.object({
					id: z.string(),
					type: z.enum(["noul", "choice", "score"]),
					instructions: z.string(),
					options: optionsSchema.optional(),
					levels: z.array(z.string()).optional(),
					whenTrue: z.string().optional(),
					whenFalse: z.string().optional(),
				}),
			),
			model: z.string().optional(),
		}),
		async execute(_toolCallId: string, params: AskToolParams, signal?: AbortSignal) {
			try {
				let state: unknown = params.state;
				if (params.stateFormat === "json") {
					try {
						state = JSON.parse(params.state);
					} catch (err) {
						return { content: [{ type: "text", text: `typesafe_ask: invalid JSON state: ${String(err)}` }], isError: true };
					}
				}
				const built = buildWireQuestions(params.questions);
				if (built.error || !built.questions) {
					return { content: [{ type: "text", text: `typesafe_ask: ${built.error ?? "invalid questions"}` }], isError: true };
				}
				if (!apiKeyPresent()) {
					return { content: [{ type: "text", text: "typesafe_ask: TYPESAFE_API_KEY is not set" }], isError: true };
				}
				// What the model wrote into the question (instructions, option and rubric text) leaves like the state does. The
				// question ids and option names are keys here, and not secret-named keys: they are masked by pattern, never whole.
				const redact = redactOn();
				const questions = sanitizeValue(built.questions, redact, { keyAware: false }) as Questions;
				// The model override goes in this request only; the signal lets Esc stop the call.
				const { result, requestId } = await ask(sanitizeValue(state, redact) as Parameters<typeof ask>[0], questions, {
					timeoutMs: 10000,
					maxRetries: 2,
					model: params.model,
					signal,
				});
				return {
					content: [{ type: "text", text: summarizeAnswers(result.answers) }],
					details: { model: result.model, answers: result.answers, usage: result.usage, requestId },
				};
			} catch (err) {
				return { content: [{ type: "text", text: `typesafe_ask failed: ${describeError(err)}` }], isError: true };
			}
		},
	});

	pi.registerCommand("adversary", {
		description: "TypeSafe adversary reviewer: toggle | on | off | status | last | dump | role | gate",
		handler: async (args, ctx) => {
			const tokens = typeof args === "string" ? args.trim().split(/\s+/).filter((t) => t.length > 0) : [];
			const sub = tokens[0] ?? "";
			const cfg = getConfig();
			if (sub === "") {
				sessionOverride = !reviewEnabled();
				notifyVia(ctx, logger, `TypeSafe adversary ${sessionOverride ? "enabled" : "disabled"} for this session`);
			} else if (sub === "on" || sub === "off") {
				sessionOverride = sub === "on";
				notifyVia(ctx, logger, `TypeSafe adversary ${sub} for this session`);
			} else if (sub === "gate") {
				const value = tokens[1];
				if (value !== "on" && value !== "off") {
					notifyVia(ctx, logger, "usage: /adversary gate on|off", "warning");
				} else {
					sessionGateOverride = value === "on";
					notifyVia(ctx, logger, `TypeSafe ambiguity gate ${value} for this session`);
				}
			} else if (sub === "role") {
				const value = tokens[1];
				if (value !== "advisory" && value !== "adversarial") {
					notifyVia(ctx, logger, "usage: /adversary role advisory|adversarial", "warning");
				} else {
					sessionRoleOverride = value;
					// Each role has its own priorities file (ADVERSARY.md / WATCHDOG.md).
					await reloadPriorities(ctx?.cwd, value);
					pi.setLabel(roleLabel(value));
					notifyVia(ctx, logger, `TypeSafe role set to ${value} for this session`);
				}
			} else if (sub === "status") {
				const stats = getReviewStats();
				const usage = getSessionUsage();
				const resolved = getLastResolvedModel();
				const clientError = getClientError();
				const warnings = getConfigWarnings();
				const subagents = getSubagentStats();
				const p = cfg.pipeline;
				const onOff = (value: boolean): string => (value ? "on" : "off");
				const suppressed = Object.entries(stats.suppressed)
					.map(([reason, count]) => `${reason}=${count}`)
					.join(" ");
				const lines = [
					`adversary: ${reviewEnabled() ? "enabled" : "disabled"}${sessionOverride !== null ? ` (session override: ${sessionOverride ? "on" : "off"})` : ""}`,
					`role: ${resolvedRole()}${sessionRoleOverride !== null ? ` (session override: ${sessionRoleOverride})` : ""}; phases: ${cfg.phases.join(",")}`,
					`tools: ${cfg.adversary.tools.length > 0 ? cfg.adversary.tools.join(",") : "none"}`,
					`model: ${cfg.model}${resolved ? ` (last resolved: ${resolved})` : ""}`,
					`api key: ${apiKeyPresent() ? "present" : "MISSING"}${clientError ? `; client error: ${clientError}` : ""}`,
					`notes delivered: nit=${stats.delivered.nit} concern=${stats.delivered.concern} blocker=${stats.delivered.blocker}; downgraded=${stats.downgraded}; steers=${stats.steers}`,
					`suppressed: ${suppressed || "none"}; errors=${stats.errors}`,
					`usage: ${usage.requests} requests, ${usage.inputTokens} in / ${usage.outputTokens} out tokens, ~$${estimateCostUsd().toFixed(6)}`,
					(() => {
						const last = getLastAmbiguityScore();
						const g = cfg.ambiguityGate;
						const state = `${gateEnabled() ? "enabled" : "disabled"}${sessionGateOverride !== null ? ` (session override: ${sessionGateOverride ? "on" : "off"})` : ""}`;
						if (!last) return `ambiguity gate: ${state} (threshold ${fmt2(g.threshold)}); no score yet; asks observed=${asksObserved()}`;
						return `ambiguity gate: ${state} (threshold ${fmt2(g.threshold)}); last ${fmt2(last.ambiguity)} trigger=${last.trigger} weakest=${last.weakest} gap=${last.gap} decision=${last.decision}; asks observed=${asksObserved()}`;
					})(),
					`subagent guard: ${subagentGuardEnabled() ? "on" : "off (TYPESAFE_SUBAGENT_GUARD)"}; subagent sessions skipped=${subagents.sessions} (hook calls skipped=${subagents.hookCalls})`,
					`pipeline guards: plan guard ${onOff(p.planGuard)} (blocked=${planGuardBlocks}); approval guard ${onOff(p.approvalGuard)} (blocked=${approvalBlocks}, would block=${approvalWouldBlocks})`,
					`pipeline checks: spec checks ${onOff(p.specChecks)} (notes sent=${specNotesSent}); skill-aware ${onOff(p.skillAware)} (${p.skills.length > 0 ? p.skills.join(",") : "no skills"})`,
				];
				if (warnings.length > 0) lines.push(`config warnings: ${warnings.join(" | ")}`);
				notifyVia(ctx, logger, lines.join("\n"));
			} else if (sub === "last") {
				const record = getLastReviewRecord();
				notifyVia(ctx, logger, record ? JSON.stringify(record, null, 2) : "no reviews yet");
			} else if (sub === "dump") {
				const sessionId = safeFileId(ctx?.sessionManager?.getSessionId?.());
				const path = join(dumpDir(), `adversary-${sessionId}.json`);
				try {
					await Bun.write(path, JSON.stringify(getReviewHistory(), null, 2));
					notifyVia(ctx, logger, `adversary history written to ${path}`);
				} catch (err) {
					notifyVia(ctx, logger, `dump failed: ${describeError(err)}`, "error");
				}
			} else {
				notifyVia(ctx, logger, "usage: /adversary [on|off|status|last|dump|role advisory|adversarial|gate on|off] (bare command toggles)", "warning");
			}
		},
	});

	pi.registerCommand("typesafe", {
		description: "TypeSafe connectivity probe: test",
		handler: async (args, ctx) => {
			const sub = typeof args === "string" ? args.trim().split(/\s+/)[0] || "test" : "test";
			if (sub !== "test") {
				notifyVia(ctx, logger, "usage: /typesafe test", "warning");
				return;
			}
			if (!apiKeyPresent()) {
				notifyVia(ctx, logger, "TYPESAFE_API_KEY is not set", "warning");
				return;
			}
			const started = Date.now();
			try {
				const { result } = await ask({ probe: "hello world", note: "typesafe test command" }, { greeting: noul("Is this a greeting?") }, { timeoutMs: PROBE_TIMEOUT_MS, maxRetries: 1, budgetMs: PROBE_BUDGET_MS });
				const ms = Date.now() - started;
				const greeting = result.answers.greeting;
				notifyVia(ctx, logger, `noul=${typeof greeting?.noul === "number" ? greeting.noul.toFixed(3) : "?"} model=${result.model} latency=${ms}ms usage in=${result.usage?.input_tokens ?? 0} out=${result.usage?.output_tokens ?? 0}`);
			} catch (err) {
				notifyVia(ctx, logger, `typesafe test failed: ${describeError(err)}`, "error");
			}
		},
	});
}

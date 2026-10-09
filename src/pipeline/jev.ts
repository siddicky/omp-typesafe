import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { ask, noul } from "../client";
import { extractNoul } from "../reviewer";
import { maskedCap } from "../text";
import type { ApprovalFlip, AskAnswer } from "./approval";
import type { SpecProblem, SpecProblemCode } from "./spec";

/**
 * Jev second opinions for the three judging pipeline features (plan guard, spec checks, approval
 * guard). Skill awareness stays local: it routes turns, it judges nothing. Every judge here sends
 * its state to TypeSafe, needs TYPESAFE_API_KEY, and never throws: null means "Jev said nothing
 * usable" (an error, a timeout, the hook budget ran out) and the caller keeps its safe default,
 * while false is a negative judgment the caller acts on. A missing answer on a successful call is
 * not unknown either: Jev abstained, which counts as silent, so false.
 */

/** The eval cell sent for a plan-guard judgment. */
export const PLAN_CELL_CHARS = 3000;
/** The spec text sent for a spec judgment. */
export const SPEC_JEV_CHARS = 8000;
/** How many user turns or ask exchanges a judgment sees at most. */
export const PIPELINE_TURNS = 8;
/** Chars kept per turn or exchange. */
export const PIPELINE_TURN_CHARS = 400;
/**
 * Whole-hook budget shared by one tool_call's pipeline Jev judgments (the plan call plus every
 * approval flip), well under omp's 30 s fail-closed tool_call timeout. Per-call timeoutMs still
 * bounds each attempt; this bounds their sum.
 */
export const PIPELINE_JEV_BUDGET_MS = 10_000;

export const STARTS_DAG_RUN = "starts_dag_run";
export const UNFOUNDED_DECISIONS = "unfounded_decisions";
export const VAGUE_ACCEPTANCE = "vague_acceptance";
export const APPROVAL_GRANTED = "approval_granted";

export function planGuardQuestions(): Questions {
	return {
		[STARTS_DAG_RUN]: noul("This Python eval cell runs while plan mode is active, whose workers are read-only.", {
			true: "The code actually invokes run_dag or prepare_dag: directly, as a method, through an alias or wrapper, or by a computed name. A name in a comment, an import, a definition, or a bare reference without a call is not an invocation — but a string the code calls through (globals()[\"run_dag\"]()) is.",
			false: "The code only mentions run_dag or prepare_dag without calling it: in a comment, a string, a log path, an import, a definition, an attribute or docstring lookup, a hasattr/callable/signature check, or a reference that is built but never called.",
		}),
	};
}

export function specQuestions(): Questions {
	return {
		[UNFOUNDED_DECISIONS]: noul("A locked decision of this deep-interview spec has no basis in user_turns, the only words the user said.", {
			true: "Some locked decision is not supported by user_turns: its quoted words are not there and nothing the user said implies it.",
			false: "Every locked decision is supported by something in user_turns.",
		}),
		[VAGUE_ACCEPTANCE]: noul("Some acceptance criterion of this deep-interview spec cannot be verified.", {
			true: "Some acceptance criterion states a quality with no command, file, value or observable behavior to check it by.",
			false: "Every acceptance criterion names a command, file, value or observable behavior that can be checked.",
		}),
	};
}

export function approvalQuestions(): Questions {
	return {
		[APPROVAL_GRANTED]: noul("The user approved this artifact in these ask exchanges.", {
			true: "The user approved it: an Approve/Run pick, or typed words that approve it.",
			false: "The user did not approve it: a refusal, an unrelated answer, or nothing approving.",
		}),
	};
}

export function planGuardState(code: string, redact: boolean): Record<string, unknown> {
	return { plan_mode: true, code: maskedCap(code, PLAN_CELL_CHARS, redact) };
}

export function specJevState(specText: string, userTurns: readonly string[], redact: boolean): Record<string, unknown> {
	return {
		spec: maskedCap(specText, SPEC_JEV_CHARS, redact),
		user_turns: userTurns.slice(-PIPELINE_TURNS).map((turn) => maskedCap(turn, PIPELINE_TURN_CHARS, redact)),
	};
}

export function approvalJevState(flip: ApprovalFlip, exchanges: readonly string[], redact: boolean): Record<string, unknown> {
	return {
		artifact: flip.artifact,
		// The target tells same-kind siblings apart ("run only a.json, not b.json").
		target: maskedCap(flip.path ?? "(no path given)", PIPELINE_TURN_CHARS, redact),
		approving_options: [...flip.labels],
		exchanges: exchanges.slice(-PIPELINE_TURNS).map((exchange) => maskedCap(exchange, PIPELINE_TURN_CHARS, redact)),
	};
}

/** One ask answer as a line of judgment state: the question, the pick (marked when omp made it on a timeout), and anything typed. */
export function formatAskAnswer(answer: AskAnswer, redact: boolean): string {
	const parts = [`Q: ${answer.question ?? "(no question text)"}`];
	// omp picked it when the dialog timed out: Jev must not read it as the user's pick.
	if (answer.selected.length > 0) parts.push(`picked: ${answer.selected.join(", ")}${answer.timedOut ? " (auto-selected after timeout)" : ""}`);
	if (answer.customInput !== null) parts.push(`typed: "${answer.customInput}"`);
	if (parts.length === 1) parts.push("no answer");
	return maskedCap(parts.join(" | "), PIPELINE_TURN_CHARS, redact);
}

export interface JevJudgeOpts {
	/** A noul at or above this fires. */
	floor: number;
	/** Per-attempt timeout in ms; no retries. */
	timeoutMs: number;
	redact: boolean;
	/** The hook's shared budget: an aborted signal ends the call as unknown (null). */
	signal?: AbortSignal;
}

/** The noul probabilities of one call, keyed by question id; null when the call itself failed. */
async function judgeNoul(state: Record<string, unknown>, questions: Questions, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<Record<string, number | null> | null> {
	try {
		const { result } = await ask(state as EntryType, questions, { timeoutMs: opts.timeoutMs, maxRetries: 0, ...(opts.signal ? { signal: opts.signal } : {}) });
		const out: Record<string, number | null> = {};
		for (const id of Object.keys(questions)) out[id] = extractNoul(result.answers[id]);
		return out;
	} catch {
		return null;
	}
}

function fired(value: number | null | undefined, floor: number): boolean {
	return value !== null && value !== undefined && value >= floor;
}

/**
 * Does this plan-mode cell start or stage a dag run? Null when Jev said nothing usable (the call
 * failed). A missing answer on a successful call is not unknown: Jev abstained, which counts as
 * silent, so false. Callers fail open on null and act on false.
 */
export async function judgePlanCell(code: string, opts: JevJudgeOpts): Promise<boolean | null> {
	if (opts.signal?.aborted) return null;
	const answers = await judgeNoul(planGuardState(code, opts.redact), planGuardQuestions(), opts);
	if (answers === null) return null;
	const value = answers[STARTS_DAG_RUN];
	return value === null ? false : value >= opts.floor;
}

type SpecJevFinding = typeof UNFOUNDED_DECISIONS | typeof VAGUE_ACCEPTANCE;

const SPEC_JEV_CODE: Record<SpecJevFinding, SpecProblemCode> = {
	[UNFOUNDED_DECISIONS]: "jev-unfounded",
	[VAGUE_ACCEPTANCE]: "jev-vague",
};

const SPEC_JEV_MESSAGE: Record<SpecJevFinding, string> = {
	[UNFOUNDED_DECISIONS]:
		"Jev could not base a locked decision on anything you said this session: confirm it, or move it under the unconfirmed assumptions",
	[VAGUE_ACCEPTANCE]: "Jev found an acceptance criterion too vague to verify: make each one a checkable statement",
};

/** Jev's findings on a draft spec, or null when Jev said nothing usable. */
export async function judgeSpecText(specText: string, userTurns: readonly string[], opts: JevJudgeOpts): Promise<SpecProblem[] | null> {
	const answers = await judgeNoul(specJevState(specText, userTurns, opts.redact), specQuestions(), opts);
	if (answers === null) return null;
	const findings: SpecJevFinding[] = [];
	if (fired(answers[UNFOUNDED_DECISIONS], opts.floor)) findings.push(UNFOUNDED_DECISIONS);
	if (fired(answers[VAGUE_ACCEPTANCE], opts.floor)) findings.push(VAGUE_ACCEPTANCE);
	return findings.map((finding) => ({ code: SPEC_JEV_CODE[finding], message: SPEC_JEV_MESSAGE[finding], line: null }));
}

/** Did the user approve this flip in these exchanges? Null when Jev said nothing usable. */
export async function judgeApproval(flip: ApprovalFlip, exchanges: readonly string[], opts: JevJudgeOpts): Promise<boolean | null> {
	const answers = await judgeNoul(approvalJevState(flip, exchanges, opts.redact), approvalQuestions(), opts);
	if (answers === null) return null;
	const value = answers[APPROVAL_GRANTED];
	return value === null ? false : value >= opts.floor;
}

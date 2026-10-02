import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * reviewer.ts unit tests. The `@typesafe-ai/sdk`-backed client wrapper (src/client.ts) is
 * mocked so tests run with no network: `ask` returns a queued, fully controlled answer set,
 * and `noul`/`choice`/`score` are simple pass-through question builders (their exact shape is
 * never inspected by reviewer.ts before it hands them to `ask`). `pi.sendMessage` is a fake
 * recorder so delivery can be asserted without a real omp host.
 */

interface QueuedAnswer {
	type: string;
	[key: string]: unknown;
}

let queuedAnswers: Record<string, QueuedAnswer> = {};
let apiKeyPresentValue = true;
const askCalls: { state: unknown; questions: Record<string, { type: string; instructions?: string }> }[] = [];

mock.module("../src/client", () => ({
	apiKeyPresent: () => apiKeyPresentValue,
	ask: async (state: unknown, questions: unknown, _opts: unknown) => {
		askCalls.push({ state, questions: questions as Record<string, { type: string; instructions?: string }> });
		return {
			result: {
				model: "jev-test",
				answers: queuedAnswers,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
			requestId: "test-request",
		};
	},
	describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
	noul: (instructions: string, opts?: { true?: string; false?: string }) => ({ type: "noul", instructions, ...opts }),
	choice: (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions, criteria }),
	score: (instructions: string, levels: readonly string[]) => ({ type: "score", instructions, levels: [...levels] }),
}));

const { review, buildBattery, getLastReviewRecord } = await import("../src/reviewer");
const { resetReviewerSession, beginTurn } = await import("../src/reviewer");
const {
	HISTORY_CAP,
	MAX_CALLS_PER_PROMPT,
	MAX_MESSAGE_REVIEWS_PER_PROMPT,
	NOTE_DEDUPE_TTL_TURNS,
	beginPrompt,
	canReviewMessage,
	endTurn,
	getReviewHistory,
	getReviewStats,
	hasCallBudget,
	isSteerImmune,
	recordMessageReviewed,
	reviewTarget,
} = await import("../src/reviewer");
const { DEFAULT_CONFIG, getConfig } = await import("../src/config");
const { stringifyInput } = await import("../src/text");

function noulAnswer(value: number, confidence = 0.9): QueuedAnswer {
	return { type: "noul", noul: value, confidence };
}

function scoreAnswer(value: number, confidence = 0.9): QueuedAnswer {
	return { type: "score", score: value, confidence };
}

function choiceAnswer(value: string, confidence = 0.9): QueuedAnswer {
	return { type: "choice", choice: value, confidence };
}

/** Build a full answer set for a battery: all noul ids default to 0, overrides applied on top. */
function answersFor(kind: "action" | "message" | "turn", role: "adversarial" | "advisory", opts: {
	severity: number;
	nouls?: Record<string, number>;
	defect?: string;
	severityConfidence?: number;
	defectConfidence?: number;
	failed?: boolean;
}): Record<string, QueuedAnswer> {
	const battery = buildBattery(kind, role, { failed: opts.failed === true });
	const answers: Record<string, QueuedAnswer> = { severity: scoreAnswer(opts.severity, opts.severityConfidence) };
	for (const id of battery.noulIds) {
		answers[id] = noulAnswer(opts.nouls?.[id] ?? 0);
	}
	answers[battery.defectKey] = choiceAnswer(opts.defect ?? "none", opts.defectConfidence);
	return answers;
}

class FakePi {
	sent: { message: unknown; options: unknown }[] = [];
	logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
	sendMessage(message: unknown, options?: unknown) {
		this.sent.push({ message, options });
		return undefined;
	}
}

function idleCtx(isIdle = false) {
	return { hasUI: false, isIdle: () => isIdle, sessionManager: { getBranch: () => [] } };
}

beforeEach(() => {
	queuedAnswers = {};
	apiKeyPresentValue = true;
	askCalls.length = 0;
	Object.assign(getConfig().adversary, DEFAULT_CONFIG.adversary);
	resetReviewerSession();
	beginTurn();
});

describe("severity derivation — adversarial", () => {
	test("low score, no noul above floor -> none, nothing delivered", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 0.5 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.decision).toBe("none");
		expect(pi.sent.length).toBe(0);
	});

	test("score in concern band with a fired noul -> concern, delivered", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { requirement_missed: 0.8 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.severity).toBe("concern");
		expect(outcome.decision).toBe("delivered");
		expect(pi.sent.length).toBe(1);
	});

	test("score in blocker band with a fired noul -> blocker, delivered with triggerTurn", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.6, nouls: { unsupported_claim: 0.9 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.severity).toBe("blocker");
		expect(outcome.decision).toBe("delivered");
		const opts = pi.sent[0]?.options as Record<string, unknown>;
		expect(opts.triggerTurn).toBe(true);
	});

	test("low score but a noul above the default floor (0.45) -> nit, suppressed by default (emitNits=false)", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 0.2, nouls: { requirement_missed: 0.6 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.severity).toBe("nit");
		expect(outcome.decision).toBe("suppressed");
		expect(outcome.reason).toBe("nits_disabled");
	});
});

describe("severity derivation — advisory", () => {
	test("low score, no noul above floor -> none, nothing delivered", async () => {
		queuedAnswers = answersFor("message", "advisory", { severity: 0.5 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.decision).toBe("none");
		expect(pi.sent.length).toBe(0);
	});

	test("score in concern band with a fired noul -> concern, delivered as <advisory>", async () => {
		queuedAnswers = answersFor("message", "advisory", {
			severity: 1.6,
			nouls: { missing_consideration: 0.8, on_track: 0.1 },
			defect: "consider_requirement",
		});
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(outcome.severity).toBe("concern");
		expect(outcome.decision).toBe("delivered");
		expect(outcome.note).toContain("<advisory ");
		expect(outcome.note).toContain('advisor="TypeSafe"');
		expect(outcome.note).toContain('theme="consider_requirement"');
		expect(outcome.note).toContain("Consider this before continuing.");
		const sentMsg = pi.sent[0]?.message as Record<string, unknown>;
		expect(sentMsg.customType).toBe("ai.typesafe.advisory");
	});

	test("score in blocker band -> blocker, delivered as <advisory>", async () => {
		queuedAnswers = answersFor("message", "advisory", { severity: 2.6, defect: "consider_requirement" });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.severity).toBe("blocker");
		expect(outcome.note).toContain("<advisory ");
	});
});

describe("on_track suppression (advisory only)", () => {
	test("high on_track drops a concern-level note", async () => {
		queuedAnswers = answersFor("message", "advisory", {
			severity: 1.6,
			nouls: { missing_consideration: 0.8, on_track: 0.9 },
			defect: "consider_requirement",
		});
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(outcome.decision).toBe("none");
		expect(pi.sent.length).toBe(0);
	});

	test("high on_track does NOT drop a blocker-level note", async () => {
		queuedAnswers = answersFor("message", "advisory", {
			severity: 2.6,
			nouls: { missing_consideration: 0.9, on_track: 0.95 },
			defect: "consider_requirement",
		});
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.severity).toBe("blocker");
		expect(outcome.decision).toBe("delivered");
		expect(pi.sent.length).toBe(1);
	});

	test("adversarial role is unaffected by an on_track-shaped answer (no such noul in its battery)", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { requirement_missed: 0.8 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.decision).toBe("delivered");
	});
});

describe("both roles route identically for the same severity/context", () => {
	test("concern severity while idle -> nextTurn channel for both roles", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { unsupported_claim: 0.8 } });
		const piA = new FakePi();
		const outA = await review(piA, "message", { task: "t" }, idleCtx(true), {}, "adversarial");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("message", "advisory", {
			severity: 1.6,
			nouls: { missing_consideration: 0.8, on_track: 0.1 },
			defect: "consider_requirement",
		});
		const piB = new FakePi();
		const outB = await review(piB, "message", { task: "t" }, idleCtx(true), {}, "advisory");

		expect(outA.channel).toBe("nextTurn");
		expect(outB.channel).toBe("nextTurn");
		expect(outA.channel).toBe(outB.channel);
	});

	test("blocker severity while active -> steer + triggerTurn for both roles", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.6, nouls: { breaks_contract: 0.9 } });
		const piA = new FakePi();
		const outA = await review(piA, "action", { task: "t" }, idleCtx(false), { toolCallId: "1" }, "adversarial");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("action", "advisory", { severity: 2.6, nouls: { related_update_needed: 0.9 } });
		const piB = new FakePi();
		const outB = await review(piB, "action", { task: "t" }, idleCtx(false), { toolCallId: "1" }, "advisory");

		expect(outA.channel).toBe("steer");
		expect(outB.channel).toBe("steer");
		const optsA = piA.sent[0]?.options as Record<string, unknown>;
		const optsB = piB.sent[0]?.options as Record<string, unknown>;
		expect(optsA.triggerTurn).toBe(true);
		expect(optsB.triggerTurn).toBe(true);
	});

	test("plan mode forces aside for both roles", async () => {
		const planEntries = [{ type: "custom_message", customType: "plan-mode-context", content: "" }];
		const planCtx = { hasUI: false, isIdle: () => false, sessionManager: { getBranch: () => planEntries } };

		queuedAnswers = answersFor("message", "adversarial", { severity: 2.6, nouls: { unsupported_claim: 0.9 } });
		const piA = new FakePi();
		const outA = await review(piA, "message", { task: "t" }, planCtx, {}, "adversarial");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("message", "advisory", { severity: 2.6, defect: "consider_requirement" });
		const piB = new FakePi();
		const outB = await review(piB, "message", { task: "t" }, planCtx, {}, "advisory");

		expect(outA.channel).toBe("aside");
		expect(outB.channel).toBe("aside");
	});
});

describe("adversarial note format is unchanged", () => {
	test("note matches the documented <adversarial-note> shape exactly", async () => {
		queuedAnswers = {
			severity: scoreAnswer(1.6, 0.63),
			unsupported_claim: noulAnswer(0),
			requirement_missed: noulAnswer(0),
			risky_api: noulAnswer(0),
			weak_verification: noulAnswer(0),
			unnecessary_complexity: noulAnswer(0),
			defect_class: choiceAnswer("weak_verification", 0.8),
		};
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.note).toBe(
			'<adversarial-note severity="concern" defect="weak_verification" guidance="weigh, don\'t blindly obey" confidence="0.63">\n' +
				"Adversarial review of the last response flags weak_verification. Verify or refute before building on this.\n" +
				"</adversarial-note>",
		);
		const sentMsg = pi.sent[0]?.message as Record<string, unknown>;
		expect(sentMsg.customType).toBe("ai.typesafe.adversary");
	});
});

describe("env / role wiring at the review() boundary", () => {
	test("role is taken from the explicit parameter, not any ambient config", async () => {
		queuedAnswers = answersFor("turn", "advisory", { severity: 1.6, nouls: { should_clarify: 0.7 }, defect: "clarify_with_user" });
		const pi = new FakePi();
		const outcome = await review(pi, "turn", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(outcome.note).toContain("<advisory ");
		const sentMsg = pi.sent[0]?.message as Record<string, unknown>;
		expect(sentMsg.customType).toBe("ai.typesafe.advisory");
	});

	test("every ReviewRecord carries the role that produced it", async () => {
		queuedAnswers = answersFor("message", "advisory", { severity: 1.6, nouls: { should_clarify: 0.7 }, defect: "clarify_with_user" });
		const pi = new FakePi();
		await review(pi, "message", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(getLastReviewRecord()?.role).toBe("advisory");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { unsupported_claim: 0.8 } });
		const pi2 = new FakePi();
		await review(pi2, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(getLastReviewRecord()?.role).toBe("adversarial");
	});

	test("role is recorded even on suppressed/none/error outcomes", async () => {
		apiKeyPresentValue = false;
		const pi = new FakePi();
		await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(getLastReviewRecord()?.role).toBe("advisory");
		apiKeyPresentValue = true;
	});

	test("no API key -> suppressed, no ask/sendMessage call regardless of role", async () => {
		apiKeyPresentValue = false;
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.decision).toBe("suppressed");
		expect(outcome.reason).toBe("no_api_key");
		expect(pi.sent.length).toBe(0);
	});
});

// ---- audit regression tests ----------------------------------------------------

function actionState(tool: string, input: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { task: "t", action: { tool, input: typeof input === "string" ? input : JSON.stringify(input) }, result: "ok", ...extra };
}

/** Finish the current model turn and start the next one, as index.ts does on turn_end / turn_start. */
function advanceTurns(count: number): void {
	for (let i = 0; i < count; i++) {
		endTurn();
		beginTurn();
	}
}

function sentOptions(pi: FakePi, index = 0): Record<string, unknown> {
	return (pi.sent[index]?.options ?? {}) as Record<string, unknown>;
}

describe("dedupe identity", () => {
	test("distinct zero-fired blockers on different files are both delivered", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.8, defect: "data_loss" });
		const a = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		advanceTurns(4);
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.8, defect: "contract_break" });
		const b = await review(pi, "action", actionState("edit", { path: "b.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(a.decision).toBe("delivered");
		expect(b.decision).toBe("delivered");
		expect(pi.sent.length).toBe(2);
	});

	test("zero-fired blockers with different defects on the same file are distinct findings", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.8, defect: "data_loss" });
		await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.8, defect: "contract_break" });
		const b = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(b.decision).toBe("delivered");
	});

	test("the same fired noul on a different file is a separate finding", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 }, defect: "contract_break" });
		const a = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		const b = await review(pi, "action", actionState("edit", { path: "z.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(a.decision).toBe("delivered");
		expect(b.decision).toBe("delivered");
	});

	test("the same target and fired noul is still a duplicate inside the window", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 } });
		await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		advanceTurns(NOTE_DEDUPE_TTL_TURNS);
		const again = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(again.decision).toBe("suppressed");
		expect(again.reason).toBe("duplicate");
		expect(pi.sent.length).toBe(1);
	});

	test("a fired noul identifies the finding; a defect-choice flip does not revive it", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 }, defect: "contract_break" });
		await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 }, defect: "missed_callsite" });
		const again = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(again.reason).toBe("duplicate");
	});

	test("an identical finding is delivered again once the turn window has passed", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 } });
		await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		advanceTurns(NOTE_DEDUPE_TTL_TURNS + 1);
		const again = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(again.decision).toBe("delivered");
		expect(pi.sent.length).toBe(2);
	});

	test("an identical finding is delivered again on a new prompt", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 } });
		await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		beginPrompt();
		beginTurn();
		const again = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(again.decision).toBe("delivered");
	});

	test("severity escalation on the same finding passes once", async () => {
		getConfig().adversary.emitNits = true;
		const pi = new FakePi();
		const state = actionState("edit", { path: "a.ts" });
		queuedAnswers = answersFor("action", "adversarial", { severity: 0.2, nouls: { breaks_contract: 0.6 } });
		const nit = await review(pi, "action", state, idleCtx(), { toolCallId: "1" }, "adversarial");
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.6 } });
		const concern = await review(pi, "action", state, idleCtx(), { toolCallId: "2" }, "adversarial");
		const concernAgain = await review(pi, "action", state, idleCtx(), { toolCallId: "3" }, "adversarial");
		expect([nit.decision, concern.decision, concernAgain.decision]).toEqual(["delivered", "delivered", "suppressed"]);
	});

	test("the same finding from message_end and turn_end is delivered once", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		const fromMessage = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		queuedAnswers = answersFor("turn", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		const fromTurn = await review(pi, "turn", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(fromMessage.decision).toBe("delivered");
		expect(fromTurn.decision).toBe("suppressed");
		expect(fromTurn.reason).toBe("duplicate");
		expect(pi.sent.length).toBe(1);
	});

	test("the same question firing on a later turn's different response is a new finding", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		const first = await review(pi, "message", { task: "t", assistant_message: "I will call eval on the input" }, idleCtx(true), {}, "adversarial");
		advanceTurns(2);
		const later = await review(pi, "message", { task: "t", assistant_message: "Now I assign the input to innerHTML" }, idleCtx(true), {}, "adversarial");
		expect(first.decision).toBe("delivered");
		expect(later.decision).toBe("delivered");
		expect(pi.sent.length).toBe(2);
	});

	test("one turn's message review and turn review still count once, and a repeat in that turn is dropped", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		advanceTurns(1);
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		const secondTurnMessage = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		queuedAnswers = answersFor("turn", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		const secondTurnReview = await review(pi, "turn", { task: "t" }, idleCtx(true), {}, "adversarial");
		const again = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(secondTurnMessage.decision).toBe("delivered");
		expect(secondTurnReview.reason).toBe("duplicate");
		expect(again.reason).toBe("duplicate");
	});

	test("repeat findings on one file are deduped in apply_patch mode, whatever the patch body", async () => {
		const pi = new FakePi();
		const patchTo = (body: string) => ({ input: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-${body}\n+${body}!\n*** End Patch` });
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 } });
		const first = await review(pi, "action", actionState("apply_patch", patchTo("one")), idleCtx(), { toolCallId: "1" }, "adversarial");
		const second = await review(pi, "action", actionState("apply_patch", patchTo("two")), idleCtx(), { toolCallId: "2" }, "adversarial");
		const otherFile = await review(pi, "action", actionState("apply_patch", { input: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch" }), idleCtx(), { toolCallId: "3" }, "adversarial");
		expect(first.decision).toBe("delivered");
		expect(second.reason).toBe("duplicate");
		expect(otherFile.decision).toBe("delivered");
	});

	test("a failed send does not poison the dedupe history", async () => {
		const failing = new FakePi();
		failing.sendMessage = () => {
			throw new Error("host rejected");
		};
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		const failed = await review(failing, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(failed.decision).toBe("error");
		const pi = new FakePi();
		const retry = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(retry.decision).toBe("delivered");
		expect(getReviewStats().errors).toBe(1);
		expect(getReviewStats().delivered.concern).toBe(1);
	});
});

describe("unavailable notice", () => {
	test("the one-time notice uses omp's \"warning\" level and is shown once", async () => {
		const notices: { message: string; level: unknown }[] = [];
		const ctx = {
			hasUI: true,
			isIdle: () => false,
			ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
			sessionManager: { getBranch: () => [] },
		};
		const failing = new FakePi();
		failing.sendMessage = () => {
			throw new Error("host rejected");
		};
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.7, nouls: { risky_api: 0.9 } });
		await review(failing, "message", { task: "t" }, ctx, {}, "adversarial");
		await review(failing, "message", { task: "t" }, ctx, {}, "adversarial");
		expect(notices).toEqual([{ message: "TypeSafe adversary unavailable", level: "warning" }]);
	});
});

describe("reviewTarget", () => {
	test("edits are identified by tool and path", () => {
		expect(reviewTarget("action", actionState("edit", { path: "src/a.ts", edits: [] }))).toBe("edit:src/a.ts");
		expect(reviewTarget("action", actionState("write", { file_path: "x/y.ts", content: "c" }))).toBe("write:x/y.ts");
		expect(reviewTarget("action", actionState("ast_edit", { paths: ["b.ts", "a.ts"] }))).toBe("ast_edit:a.ts,b.ts");
	});

	test("commands are identified by a whitespace-insensitive hash", () => {
		const a = reviewTarget("action", actionState("bash", { command: "rm -rf build" }));
		const b = reviewTarget("action", actionState("bash", { command: "rm  -rf\n build" }));
		const c = reviewTarget("action", actionState("bash", { command: "rm -rf dist" }));
		expect(a).toMatch(/^bash:cmd:/);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	test("patch text and input capped mid-JSON still yield the edited paths", () => {
		const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch";
		expect(reviewTarget("action", actionState("apply_patch", patch))).toBe("apply_patch:src/a.ts,src/b.ts");
		expect(reviewTarget("action", actionState("edit", '{"path":"src/a.ts","content":"aaaa'))).toBe("edit:src/a.ts");
	});

	// omp's apply_patch mode passes `{ input: "*** Begin Patch ..." }`; the stringified input has escaped newlines.
	test("an apply_patch input object is identified by the files in its patch, not by a hash of the patch", () => {
		const patchTo = (file: string, body: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-${body}\n+${body}2\n*** End Patch`;
		const one = reviewTarget("action", actionState("apply_patch", { input: patchTo("src/a.ts", "first") }));
		const two = reviewTarget("action", actionState("apply_patch", { input: patchTo("src/a.ts", "second change entirely") }));
		const other = reviewTarget("action", actionState("apply_patch", { input: patchTo("src/b.ts", "first") }));
		expect(one).toBe("apply_patch:src/a.ts");
		expect(two).toBe(one);
		expect(other).toBe("apply_patch:src/b.ts");
		const multi = { input: "*** Begin Patch\n*** Update File: src/z.ts\n@@\n-a\n+b\n*** Add File: src/c.ts\n+n\n*** End Patch" };
		expect(reviewTarget("action", actionState("apply_patch", multi))).toBe("apply_patch:src/c.ts,src/z.ts");
		expect(reviewTarget("action", actionState("edit", { patch: patchTo("src/a.ts", "x") }))).toBe("edit:src/a.ts");
		expect(reviewTarget("action", actionState("edit", { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-a\n+b" }))).toBe("edit:src/a.ts");
	});

	// omp's default edit mode is hashline: `{ input: "[src/a.ts#A1B2]\nPUT ..." }`, with the target only in the header.
	test("a hashline edit is identified by the files in its headers, not by a hash of the whole input", () => {
		const one = reviewTarget("action", actionState("edit", { input: "[src/a.ts#A1B2]\nPUT 1.=1:\n+first" }));
		const two = reviewTarget("action", actionState("edit", { input: "[src/a.ts#A1B2]\nPUT 9.=9:\n+a second, different change" }));
		const other = reviewTarget("action", actionState("edit", { input: "[src/b.ts#C3D4]\nPUT 1.=1:\n+first" }));
		expect(one).toBe("edit:src/a.ts");
		expect(two).toBe(one);
		expect(other).toBe("edit:src/b.ts");
		const multi = { input: "[src/z.ts#A1B2]\nPUT 1.=1:\n+a\n[src/c.ts#C3D4]\nPUT 1.=1:\n+b" };
		expect(reviewTarget("action", actionState("edit", multi))).toBe("edit:src/c.ts,src/z.ts");
	});

	test("an apply_patch input capped mid-JSON still yields its files", () => {
		const capped = '{"input":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-x\\n+yyyyyyyy';
		expect(reviewTarget("action", actionState("apply_patch", capped))).toBe("apply_patch:src/a.ts");
		const cappedTwo = '{"input":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-x\\n+y\\n*** Add File: src/b.ts\\n+zz';
		expect(reviewTarget("action", actionState("apply_patch", cappedTwo))).toBe("apply_patch:src/a.ts,src/b.ts");
	});

	// stringifyInput caps the JSON at 3000 characters, so a default-mode hashline edit of 60+ lines arrives cut mid-string.
	test("a hashline edit input capped mid-JSON still yields its files", () => {
		const capped = '{"input":"[src/a.ts#A1B2]\\nPUT 1.=1:\\n+xxxx';
		expect(reviewTarget("action", actionState("edit", capped))).toBe("edit:src/a.ts");
		const cappedTwo = '{"input":"[src/z.ts#A1B2]\\nPUT 1.=1:\\n+a\\n[src/c.ts#C3D4]\\nPUT 1.=1:\\n+bb';
		expect(reviewTarget("action", actionState("edit", cappedTwo))).toBe("edit:src/c.ts,src/z.ts");
		expect(reviewTarget("action", actionState("edit", '{"input":"\u00b6legacy.ts#abcd\\nPUT 1.=1:\\n+x'))).toBe("edit:legacy.ts");
		// Two long edits of one file are one subject, whatever else they say.
		const long = (body: string) => stringifyInput({ input: `[src/a.ts#A1B2]\n${Array.from({ length: 600 }, (_, i) => `PUT ${i}.=${i}:\n+${body}${i}`).join("\n")}` }, 3000);
		expect(reviewTarget("action", actionState("edit", long("one")))).toBe("edit:src/a.ts");
		expect(reviewTarget("action", actionState("edit", long("two")))).toBe("edit:src/a.ts");
		// A body row starts with `+`, so bracketed text inside the edit is not a header, and an edit's text with no header hashes.
		expect(reviewTarget("action", actionState("edit", '{"input":"[src/a.ts#A1B2]\\nPUT 1.=1:\\n+[not-a-file]\\n+xx'))).toBe("edit:src/a.ts");
		expect(reviewTarget("action", actionState("edit", '{"input":"PUT 1.=1:\\n+only a body'))).toMatch(/^edit:h:/);
	});

	test("a hashline edit given as a bare string is identified by its headers too", () => {
		expect(reviewTarget("action", actionState("edit", "[src/a.ts#A1B2]\nPUT 1.=1:\n+x\n[src/b.ts#C3D4]\nPUT 2.=2:\n+y"))).toBe("edit:src/a.ts,src/b.ts");
	});

	// A line of the form `[..]` is a header only in an edit's patch; elsewhere it is text, and reading it as a path would
	// make two different calls that share the line one subject.
	test("a bracketed line in a non-edit tool's input is not a path", () => {
		const a = reviewTarget("action", actionState("task", { input: "[1, 2, 3]\nfoo" }));
		const b = reviewTarget("action", actionState("task", { input: "[1, 2, 3]\nbar" }));
		expect(a).toMatch(/^task:h:/);
		expect(b).toMatch(/^task:h:/);
		expect(a).not.toBe(b);
		expect(reviewTarget("action", actionState("bash", { input: "[ -f x ]" }))).toMatch(/^bash:h:/);
		expect(reviewTarget("action", actionState("task", '{"input":"[1, 2, 3]\\nfoo'))).toMatch(/^task:h:/);
		// Real patch headers are still read for any tool.
		expect(reviewTarget("action", actionState("task", { input: "*** Update File: src/a.ts\n@@" }))).toBe("task:src/a.ts");
	});

	test("a tool input with no path, patch or command falls back to a hash of the whole input", () => {
		const a = reviewTarget("action", actionState("task", { prompt: "do one thing" }));
		expect(a).toMatch(/^task:h:/);
		expect(a).not.toBe(reviewTarget("action", actionState("task", { prompt: "do another thing" })));
	});

	test("a message or turn review is identified by the model turn it came from", () => {
		expect(reviewTarget("message", actionState("edit", { path: "a.ts" }), 7)).toBe("turn:7");
		expect(reviewTarget("turn", { task: "t" }, 7)).toBe("turn:7");
		expect(reviewTarget("message", { task: "t" }, 8)).not.toBe(reviewTarget("message", { task: "t" }, 7));
		beginTurn();
		expect(reviewTarget("message", { task: "t" })).toBe(reviewTarget("turn", { task: "t" }));
	});

	test("an action with no action state has no target", () => {
		expect(reviewTarget("action", { task: "t" })).toBe("");
	});
});

describe("note budget (maxNotesPerUpdate)", () => {
	test("caps non-blocker notes per turn, exempts blockers, resets on the next turn", async () => {
		getConfig().adversary.maxNotesPerUpdate = 1;
		const pi = new FakePi();
		const outcomes = [];
		for (const id of ["unsupported_claim", "requirement_missed", "risky_api"]) {
			queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { [id]: 0.9 } });
			outcomes.push(await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial"));
		}
		expect(outcomes.map((o) => o.decision)).toEqual(["delivered", "suppressed", "suppressed"]);
		expect(outcomes[1].reason).toBe("update_budget");
		expect(getReviewStats().suppressed.update_budget).toBe(2);
		expect(pi.sent.length).toBe(1);

		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { weak_verification: 0.9 } });
		const blocker = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(blocker.decision).toBe("delivered");

		beginTurn();
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { risky_api: 0.9 } });
		const nextTurn = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(nextTurn.decision).toBe("delivered");
	});

	test("the default budget of 4 stops a fifth note in one turn", async () => {
		const pi = new FakePi();
		const decisions: string[] = [];
		for (let i = 0; i < 5; i++) {
			queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 } });
			const out = await review(pi, "action", actionState("edit", { path: `f${i}.ts` }), idleCtx(), { toolCallId: String(i) }, "adversarial");
			decisions.push(out.decision);
		}
		expect(decisions).toEqual(["delivered", "delivered", "delivered", "delivered", "suppressed"]);
	});
});

describe("content guard", () => {
	test("an unclassified blocker with nothing fired is suppressed, not steered", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.6 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.decision).toBe("suppressed");
		expect(outcome.reason).toBe("content_free");
		expect(outcome.severity).toBe("blocker");
		expect(pi.sent.length).toBe(0);
		expect(getReviewStats().suppressed.content_free).toBe(1);
		expect(getReviewStats().steers).toBe(0);
	});

	test("an unclassified advisory concern with nothing fired is suppressed", async () => {
		queuedAnswers = answersFor("message", "advisory", { severity: 1.6 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(outcome.reason).toBe("content_free");
		expect(pi.sent.length).toBe(0);
	});

	test("a low-confidence defect counts as unclassified", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, defect: "weak_verification", defectConfidence: 0.3 });
		const outcome = await review(new FakePi(), "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.reason).toBe("content_free");
	});

	test("a classified defect with nothing fired is real content and is delivered", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, defect: "weak_verification", defectConfidence: 0.8 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.decision).toBe("delivered");
		expect(outcome.note).toContain('defect="weak_verification"');
	});

	test("a fired noul with an unclassified defect is real content and is delivered", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { requirement_missed: 0.8 } });
		const outcome = await review(new FakePi(), "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.decision).toBe("delivered");
	});

	test("a blocker with a low-confidence severity answer goes out quietly instead of steering", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 }, severityConfidence: 0.3 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.decision).toBe("delivered");
		expect(outcome.channel).toBe("nextTurn");
		expect(sentOptions(pi).triggerTurn).toBeUndefined();
		expect(getReviewStats().downgraded).toBe(1);
		expect(getReviewStats().steers).toBe(0);
		expect(isSteerImmune()).toBe(false);
		expect(getLastReviewRecord()?.downgrade).toBe("low_confidence");
	});
});

// The README shows what a note looks like; its sentences must be the ones the builders emit.
describe("README note examples", () => {
	const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
	/** The sentence between an example's opening tag and its closing tag. */
	const exampleClaim = (tag: string): string => {
		const block = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`).exec(readme)?.[0] ?? "";
		const lines = block.split("\n");
		return lines[lines.length - 2];
	};
	const claimOf = (note: string | undefined): string => (note ?? "").split("\n")[1];

	test("the adversarial example's sentence is the one the builder emits", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.89, incomplete_cutover: 0.85 }, defect: "contract_break" });
		const outcome = await review(new FakePi(), "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		expect(exampleClaim("adversarial-note")).toBe(claimOf(outcome.note));
	});

	test("the advisory example's sentence is the one the builder emits", async () => {
		queuedAnswers = answersFor("action", "advisory", { severity: 1.6, nouls: { related_update_needed: 0.81, on_track: 0.1 }, defect: "update_callers" });
		const outcome = await review(new FakePi(), "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "advisory");
		expect(outcome.note).toContain('theme="update_callers"');
		expect(exampleClaim("advisory")).toBe(claimOf(outcome.note));
		expect(claimOf(outcome.note)).not.toContain(". (");
	});
});

describe("steer confidence floor", () => {
	const lowConfidenceBlocker = () => answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 }, severityConfidence: 0.3 });

	test("adversary.steerMinConfidence sets how certain a steer must be", async () => {
		getConfig().adversary.steerMinConfidence = 0.2;
		queuedAnswers = lowConfidenceBlocker();
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.channel).toBe("steer");
		expect(getReviewStats().downgraded).toBe(0);
	});

	test("0 never downgrades for confidence; 1 downgrades every steer that is not certain", async () => {
		getConfig().adversary.steerMinConfidence = 0;
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 }, severityConfidence: 0 });
		expect((await review(new FakePi(), "message", { task: "t" }, idleCtx(), {}, "adversarial")).channel).toBe("steer");
		resetReviewerSession();
		beginTurn();
		getConfig().adversary.steerMinConfidence = 1;
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 }, severityConfidence: 0.95 });
		expect((await review(new FakePi(), "message", { task: "t" }, idleCtx(), {}, "adversarial")).channel).toBe("nextTurn");
	});

	test("a confidence at the floor still steers", async () => {
		getConfig().adversary.steerMinConfidence = 0.6;
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 }, severityConfidence: 0.6 });
		expect((await review(new FakePi(), "message", { task: "t" }, idleCtx(), {}, "adversarial")).channel).toBe("steer");
	});

	test("the default floor is 0.5", async () => {
		expect(getConfig().adversary.steerMinConfidence).toBe(0.5);
		queuedAnswers = lowConfidenceBlocker();
		expect((await review(new FakePi(), "message", { task: "t" }, idleCtx(), {}, "adversarial")).channel).toBe("nextTurn");
	});
});

describe("delivery channel", () => {
	test("quiet notes after a message or turn use nextTurn, never an aside that would wake an idle session", async () => {
		getConfig().adversary.emitNits = true;
		const pi = new FakePi();
		queuedAnswers = answersFor("message", "adversarial", { severity: 0.2, nouls: { unsupported_claim: 0.6 } });
		const messageNit = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		queuedAnswers = answersFor("turn", "adversarial", { severity: 0.2, nouls: { silent_scope_reduction: 0.6 } });
		const turnNit = await review(pi, "turn", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(messageNit.channel).toBe("nextTurn");
		expect(turnNit.channel).toBe("nextTurn");
		expect(pi.sent.every((s) => (s.options as Record<string, unknown>).deliverAs !== "aside")).toBe(true);
		expect(pi.sent.every((s) => (s.options as Record<string, unknown>).triggerTurn === undefined)).toBe(true);
	});

	test("a concern after a message or turn review steers while the session is active, without waking a turn", async () => {
		for (const kind of ["message", "turn"] as const) {
			resetReviewerSession();
			beginTurn();
			queuedAnswers = answersFor(kind, "adversarial", { severity: 1.6, nouls: { risky_api: 0.9 } });
			const pi = new FakePi();
			const outcome = await review(pi, kind, { task: "t" }, idleCtx(false), {}, "adversarial");
			expect(outcome.severity).toBe("concern");
			expect(outcome.channel).toBe("steer");
			expect(sentOptions(pi)).toEqual({ deliverAs: "steer" });
			expect(getReviewStats().steers).toBe(1);
		}
	});

	test("the same concern waits for the next prompt when the session is idle", async () => {
		for (const kind of ["message", "turn"] as const) {
			resetReviewerSession();
			beginTurn();
			queuedAnswers = answersFor(kind, "adversarial", { severity: 1.6, nouls: { risky_api: 0.9 } });
			const pi = new FakePi();
			const outcome = await review(pi, kind, { task: "t" }, idleCtx(true), {}, "adversarial");
			expect(outcome.channel).toBe("nextTurn");
			expect(sentOptions(pi)).toEqual({ deliverAs: "nextTurn" });
			expect(getReviewStats().steers).toBe(0);
		}
	});

	test("a nit after a message or turn review goes to nextTurn, active or idle", async () => {
		getConfig().adversary.emitNits = true;
		for (const kind of ["message", "turn"] as const) {
			for (const idle of [false, true]) {
				resetReviewerSession();
				beginTurn();
				queuedAnswers = answersFor(kind, "adversarial", { severity: 0.2, nouls: { risky_api: 0.6 } });
				const pi = new FakePi();
				const outcome = await review(pi, kind, { task: "t" }, idleCtx(idle), {}, "adversarial");
				expect(outcome.severity).toBe("nit");
				expect(outcome.channel).toBe("nextTurn");
			}
		}
	});

	test("action notes still use aside: a tool result is always followed by a model step", async () => {
		getConfig().adversary.emitNits = true;
		const pi = new FakePi();
		queuedAnswers = answersFor("action", "adversarial", { severity: 0.2, nouls: { breaks_contract: 0.6 } });
		const nit = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { incomplete_cutover: 0.8 } });
		const concern = await review(pi, "action", actionState("edit", { path: "b.ts" }), idleCtx(), { toolCallId: "2" }, "adversarial");
		expect(nit.channel).toBe("aside");
		expect(concern.channel).toBe("aside");
	});

	test("an immunity downgrade is quiet: nextTurn after a message, aside after an action, never a wake", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { risky_api: 0.9 } });
		const first = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(first.channel).toBe("steer");
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 } });
		const afterMessage = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.8, nouls: { breaks_contract: 0.9 } });
		const afterAction = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		expect(afterMessage.channel).toBe("nextTurn");
		expect(afterAction.channel).toBe("aside");
		expect(sentOptions(pi, 1).triggerTurn).toBeUndefined();
		expect(sentOptions(pi, 2).triggerTurn).toBeUndefined();
		expect(getReviewStats().downgraded).toBe(2);
		expect(getReviewStats().steers).toBe(1);
	});

	test("plan mode still folds quiet notes into context as an aside", async () => {
		const planEntries = [{ type: "custom_message", customType: "plan-mode-context", content: "" }];
		const planCtx = { hasUI: false, isIdle: () => true, sessionManager: { getBranch: () => planEntries } };
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { unsupported_claim: 0.8 } });
		const outcome = await review(new FakePi(), "message", { task: "t" }, planCtx, {}, "adversarial");
		expect(outcome.channel).toBe("aside");
		expect(getLastReviewRecord()?.downgrade).toBeUndefined();
	});

	test("a rejected sendMessage promise is logged, not left unhandled", async () => {
		const warnings: unknown[][] = [];
		const pi = new FakePi();
		pi.logger = { debug: () => {}, info: () => {}, warn: (...a: unknown[]) => void warnings.push(a), error: () => {} };
		pi.sendMessage = (() => Promise.reject(new Error("late failure"))) as unknown as FakePi["sendMessage"];
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { unsupported_claim: 0.8 } });
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		await Bun.sleep(0);
		expect(outcome.decision).toBe("delivered");
		expect(warnings.some((w) => String(w[0]).includes("late failure"))).toBe(true);
	});
});

/** One cheap review (nothing fires), to spend a Jev call. */
async function spendOne(pi = new FakePi()) {
	queuedAnswers = answersFor("message", "adversarial", { severity: 0.1 });
	return review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
}

/** Review until the per-turn or per-prompt budget refuses; returns how many Jev calls went through. */
async function spendBudget(): Promise<number> {
	const before = askCalls.length;
	for (let i = 0; i < 200; i++) {
		const outcome = await spendOne();
		if (outcome.reason === "call_budget" || outcome.reason === "prompt_budget") return askCalls.length - before;
	}
	throw new Error("the call budget never ran out");
}

describe("budgets", () => {
	test("a prompt-wide call budget binds across turns and beginPrompt resets it", async () => {
		getConfig().adversary.maxCallsPerTurn = 8;
		let granted = 0;
		for (let turn = 0; turn < 20; turn++) {
			beginTurn();
			granted += await spendBudget();
		}
		expect(granted).toBe(MAX_CALLS_PER_PROMPT);
		beginTurn();
		expect(await spendBudget()).toBe(0);
		beginPrompt();
		expect(await spendBudget()).toBe(8);
	});

	test("review() reports prompt_budget when the prompt-wide budget is spent", async () => {
		getConfig().adversary.maxCallsPerTurn = 8;
		for (let turn = 0; turn < 20; turn++) {
			beginTurn();
			await spendBudget();
		}
		beginTurn();
		askCalls.length = 0;
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { risky_api: 0.9 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.decision).toBe("suppressed");
		expect(outcome.reason).toBe("prompt_budget");
		expect(askCalls.length).toBe(0);
		expect(getReviewStats().suppressed.prompt_budget).toBeGreaterThanOrEqual(1);
	});

	test("the per-turn fan-out cap still reports call_budget", async () => {
		getConfig().adversary.maxCallsPerTurn = 1;
		queuedAnswers = answersFor("message", "adversarial", { severity: 0.1 });
		const pi = new FakePi();
		await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		const second = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(second.reason).toBe("call_budget");
	});

	test("the message review cap is per prompt, so it can bind across many turns", () => {
		for (let i = 0; i < MAX_MESSAGE_REVIEWS_PER_PROMPT; i++) {
			beginTurn();
			expect(canReviewMessage()).toBe(true);
			recordMessageReviewed();
		}
		beginTurn();
		expect(canReviewMessage()).toBe(false);
		beginPrompt();
		expect(canReviewMessage()).toBe(true);
	});

	test("hasCallBudget peeks at both budgets without consuming either", async () => {
		getConfig().adversary.maxCallsPerTurn = 2;
		for (let i = 0; i < 5; i++) expect(hasCallBudget()).toBe(true);
		expect(askCalls.length).toBe(0);
		expect((await spendOne()).reason).not.toBe("call_budget");
		expect(hasCallBudget()).toBe(true);
		expect((await spendOne()).reason).not.toBe("call_budget");
		expect(hasCallBudget()).toBe(false);
		expect((await spendOne()).reason).toBe("call_budget");
		beginTurn();
		expect(hasCallBudget()).toBe(true);
		getConfig().adversary.maxCallsPerTurn = 8;
		for (let turn = 0; turn < 20; turn++) {
			beginTurn();
			await spendBudget();
		}
		beginTurn();
		expect(hasCallBudget()).toBe(false);
		beginPrompt();
		expect(hasCallBudget()).toBe(true);
	});

	test("beginTurn(0) starts a new prompt when agent_start was missed; later turn indexes do not", () => {
		for (let i = 0; i < MAX_MESSAGE_REVIEWS_PER_PROMPT; i++) recordMessageReviewed();
		beginTurn(3);
		expect(canReviewMessage()).toBe(false);
		beginTurn(0);
		expect(canReviewMessage()).toBe(true);
	});
});

describe("steer immunity", () => {
	test("a steer from turn_end keeps its full immuneTurns after that turn_end's own endTurn", async () => {
		getConfig().adversary.immuneTurns = 1;
		const pi = new FakePi();
		queuedAnswers = answersFor("turn", "adversarial", { severity: 2.8, nouls: { requirement_missed: 0.9 } });
		const first = await review(pi, "turn", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(first.channel).toBe("steer");
		endTurn();
		expect(isSteerImmune()).toBe(true);
		beginTurn();
		expect(isSteerImmune()).toBe(true);
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { risky_api: 0.9 } });
		const second = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(second.channel).not.toBe("steer");
		advanceTurns(1);
		expect(isSteerImmune()).toBe(false);
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 } });
		const third = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(third.channel).toBe("steer");
	});

	test("immuneTurns covers the rest of the steer's turn plus that many further turns", async () => {
		getConfig().adversary.immuneTurns = 3;
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { risky_api: 0.9 } });
		await review(new FakePi(), "message", { task: "t" }, idleCtx(), {}, "adversarial");
		for (let i = 0; i < 3; i++) {
			advanceTurns(1);
			expect(isSteerImmune()).toBe(true);
		}
		advanceTurns(1);
		expect(isSteerImmune()).toBe(false);
	});

	test("immuneTurns 0 never opens a window", async () => {
		getConfig().adversary.immuneTurns = 0;
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { risky_api: 0.9 } });
		await review(new FakePi(), "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(isSteerImmune()).toBe(false);
	});
});

describe("downgraded notes can still escalate", () => {
	test("a blocker downgraded during immunity steers once after the window ends", async () => {
		const pi = new FakePi();
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { risky_api: 0.9 } });
		await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");

		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { unsupported_claim: 0.9 } });
		const downgraded = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(downgraded.channel).toBe("nextTurn");
		const stillImmune = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(stillImmune.reason).toBe("duplicate");

		advanceTurns(4);
		expect(isSteerImmune()).toBe(false);
		const steered = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(steered.channel).toBe("steer");
		expect(sentOptions(pi, pi.sent.length - 1).triggerTurn).toBe(true);
		const third = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(third.reason).toBe("duplicate");
	});

	test("a blocker downgraded by plan mode steers once after leaving plan mode", async () => {
		const planEntries = [{ type: "custom_message", customType: "plan-mode-context", content: "" }];
		const planCtx = { hasUI: false, isIdle: () => false, sessionManager: { getBranch: () => planEntries } };
		const pi = new FakePi();
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.8, nouls: { risky_api: 0.9 } });
		const inPlan = await review(pi, "message", { task: "t" }, planCtx, {}, "adversarial");
		expect(inPlan.channel).toBe("aside");
		expect(getLastReviewRecord()?.downgrade).toBe("plan_mode");
		const stillPlan = await review(pi, "message", { task: "t" }, planCtx, {}, "adversarial");
		expect(stillPlan.reason).toBe("duplicate");
		const executing = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(executing.channel).toBe("steer");
	});
});

describe("review history", () => {
	async function runNone(count: number): Promise<void> {
		queuedAnswers = answersFor("action", "adversarial", { severity: 0 });
		const pi = new FakePi();
		for (let i = 0; i < count; i++) {
			if (i % 50 === 0) beginPrompt();
			beginTurn();
			await review(pi, "action", actionState("edit", { path: `f${i}.ts` }), idleCtx(), { toolCallId: String(i) }, "adversarial");
		}
	}

	test("keeps far more than 50 records for the bench log", async () => {
		await runNone(120);
		expect(getReviewHistory().length).toBe(120);
		expect(getReviewStats().historyDropped).toBe(0);
	});

	test("is bounded, and says how many records were dropped", async () => {
		await runNone(HISTORY_CAP + 5);
		const history = getReviewHistory();
		expect(history.length).toBe(HISTORY_CAP);
		expect(getReviewStats().historyDropped).toBe(5);
		expect(history[0].toolCallId).toBe("5");
		expect(getLastReviewRecord()?.toolCallId).toBe(String(HISTORY_CAP + 4));
	});

	test("resetReviewerSession clears history and the dropped counter", async () => {
		await runNone(HISTORY_CAP + 1);
		resetReviewerSession();
		expect(getReviewHistory().length).toBe(0);
		expect(getReviewStats().historyDropped).toBe(0);
	});
});

describe("inline delivery", () => {
	test("a non-blocker action note is delivered inline only: no sendMessage, decision delivered_inline", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 }, defect: "contract_break" });
		const pi = new FakePi();
		const outcome = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1", inline: true }, "adversarial");
		expect(outcome.decision).toBe("delivered_inline");
		expect(outcome.note).toContain("<adversarial-note ");
		expect(outcome.channel).toBeUndefined();
		expect(pi.sent.length).toBe(0);
		expect(getReviewStats().delivered.concern).toBe(1);
		expect(getReviewStats().steers).toBe(0);
		expect(isSteerImmune()).toBe(false);
		expect(getLastReviewRecord()?.decision).toBe("delivered_inline");
		expect(getLastReviewRecord()?.channel).toBe("inline");
	});

	test("an inline note still takes part in dedupe", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 } });
		const pi = new FakePi();
		const state = actionState("edit", { path: "a.ts" });
		await review(pi, "action", state, idleCtx(), { toolCallId: "1", inline: true }, "adversarial");
		const again = await review(pi, "action", state, idleCtx(), { toolCallId: "2", inline: true }, "adversarial");
		expect(again.reason).toBe("duplicate");
	});

	test("a blocker still steers and is not also inlined", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.8, nouls: { hidden_destruction: 0.9 }, defect: "data_loss" });
		const pi = new FakePi();
		const outcome = await review(pi, "action", actionState("bash", { command: "rm -rf src" }), idleCtx(), { toolCallId: "1", inline: true }, "adversarial");
		expect(outcome.decision).toBe("delivered");
		expect(outcome.channel).toBe("steer");
		expect(pi.sent.length).toBe(1);
		expect(sentOptions(pi).triggerTurn).toBe(true);
	});

	test("inline applies only to action reviews", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { unsupported_claim: 0.8 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), { inline: true }, "adversarial");
		expect(outcome.decision).toBe("delivered");
		expect(pi.sent.length).toBe(1);
	});

	test("without inline the action note goes through sendMessage as before", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 1.6, nouls: { breaks_contract: 0.9 } });
		const pi = new FakePi();
		const outcome = await review(pi, "action", actionState("edit", { path: "a.ts" }), idleCtx(), { toolCallId: "1" }, "adversarial");
		expect(outcome.decision).toBe("delivered");
		expect(pi.sent.length).toBe(1);
	});
});

describe("failed actions", () => {
	const destructive = actionState("bash", { command: "git checkout -- . && git clean -fdx && bun test" }, { exit_status: "error" });

	test("the failed battery drops unverified_claim and asks about damage already done", () => {
		const ok = buildBattery("action", "adversarial");
		const failed = buildBattery("action", "adversarial", { failed: true });
		expect(ok.noulIds).toContain("unverified_claim");
		expect(failed.noulIds).not.toContain("unverified_claim");
		expect(failed.noulIds).toContain("hidden_destruction");
		expect(failed.questions.severity.instructions).toContain("failed");
		expect(ok.questions.severity.instructions).not.toContain("failed");
		const advisory = buildBattery("action", "advisory", { failed: true });
		expect(advisory.questions.severity.instructions).toContain("failed");
	});

	test("the failed flag only applies to action batteries", () => {
		expect(buildBattery("message", "adversarial", { failed: true }).noulIds).toEqual(buildBattery("message", "adversarial").noulIds);
		expect(buildBattery("turn", "advisory", { failed: true }).questions.severity.instructions).not.toContain("failed");
	});

	test("a failed destructive command is reviewed and its destruction steers", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.9, nouls: { hidden_destruction: 0.95 }, defect: "data_loss", failed: true });
		const pi = new FakePi();
		const outcome = await review(pi, "action", destructive, idleCtx(), { toolCallId: "d1" }, "adversarial");
		expect(outcome.severity).toBe("blocker");
		expect(outcome.channel).toBe("steer");
		expect(getLastReviewRecord()?.failed).toBe(true);
		expect(Object.keys(askCalls[0].questions)).not.toContain("unverified_claim");
		expect(askCalls[0].questions.severity.instructions).toContain("failed");
	});

	test("the failure itself is not a defect: no side-effect noul means no concern or blocker", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.9, nouls: { unfounded_assumption: 0.9, not_what_was_asked: 0.8 }, defect: "unverified_assumption", failed: true });
		const pi = new FakePi();
		const outcome = await review(pi, "action", actionState("bash", { command: "bun test" }, { exit_status: "error" }), idleCtx(), { toolCallId: "d2" }, "adversarial");
		expect(outcome.severity).toBe("nit");
		expect(outcome.decision).toBe("suppressed");
		expect(outcome.reason).toBe("nits_disabled");
		expect(pi.sent.length).toBe(0);
	});

	test("a failed action with a high score but nothing fired is not reported", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.9, defect: "test_gap", defectConfidence: 0.9, failed: true });
		const outcome = await review(new FakePi(), "action", actionState("bash", { command: "bun test" }, { exit_status: "error" }), idleCtx(), { toolCallId: "d3" }, "adversarial");
		expect(outcome.decision).toBe("none");
	});

	test("the same answer on a successful action is judged normally", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.9, nouls: { unfounded_assumption: 0.9 }, defect: "unverified_assumption" });
		const pi = new FakePi();
		const outcome = await review(pi, "action", actionState("bash", { command: "bun test" }, { exit_status: "ok" }), idleCtx(), { toolCallId: "d4" }, "adversarial");
		expect(outcome.severity).toBe("blocker");
		expect(getLastReviewRecord()?.failed).toBeUndefined();
	});
});


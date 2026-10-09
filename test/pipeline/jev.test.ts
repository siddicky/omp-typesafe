import { describe, expect, mock, test } from "bun:test";
import type { ApprovalFlip } from "../../src/pipeline/approval";
import { LIMITS } from "../limits";

/**
 * src/pipeline/jev.ts on its own: the question shapes, the capped state each judgment sends
 * (measured against test/limits.ts, the way the reviewer and gate tests do), and the judges over
 * a mocked ask: a noul at or above the floor fires, below it does not, a missing answer counts as
 * silent, and a failed call is null (the caller keeps its feature's safe default) rather than thrown.
 */

let queuedAnswers: Record<string, { type: string; [key: string]: unknown }> = {};
let askFailure: Error | undefined;
const askCalls: { state: unknown; questions: Record<string, unknown>; opts: Record<string, unknown> }[] = [];

mock.module("../../src/client", () => ({
	apiKeyPresent: () => true,
	ask: async (state: unknown, questions: unknown, opts: unknown) => {
		if (askFailure) throw askFailure;
		if ((opts as { signal?: AbortSignal }).signal?.aborted) throw new Error("aborted");
		askCalls.push({ state, questions: questions as Record<string, unknown>, opts: opts as Record<string, unknown> });
		return {
			result: { model: "jev-test", answers: queuedAnswers, usage: { input_tokens: 10, output_tokens: 0 } },
			requestId: "test-request",
		};
	},
	describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
	noul: (instructions: string, opts?: { true?: string; false?: string }) => ({ type: "noul", instructions, ...opts }),
	choice: (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions, criteria }),
	score: (instructions: string, levels: readonly string[]) => ({ type: "score", instructions, levels: [...levels] }),
}));

// Dynamic import on purpose: the ../../src/client mock above must be registered before the module
// under test loads; a static import would evaluate jev.ts (and reviewer.ts) first.
const jev = await import("../../src/pipeline/jev");

const OPTS = { floor: 0.45, timeoutMs: 2500, redact: false };

function reset(answers: typeof queuedAnswers = {}, failure: Error | undefined = undefined): void {
	queuedAnswers = answers;
	askFailure = failure;
	askCalls.length = 0;
}

const noulAnswer = (value: number): { type: string; noul: number } => ({ type: "noul", noul: value });

describe("question shapes", () => {
	test("one request per judgment (two questions for a spec), keyed as the judges read them", () => {
		expect(Object.keys(jev.planGuardQuestions())).toEqual([jev.STARTS_DAG_RUN]);
		expect(Object.keys(jev.specQuestions())).toEqual([jev.UNFOUNDED_DECISIONS, jev.VAGUE_ACCEPTANCE]);
		expect(Object.keys(jev.approvalQuestions())).toEqual([jev.APPROVAL_GRANTED]);
		for (const questions of [jev.planGuardQuestions(), jev.specQuestions(), jev.approvalQuestions()]) {
			for (const question of Object.values(questions) as { type: string }[]) expect(question.type).toBe("noul");
		}
	});
});

describe("state caps", () => {
	test("a plan cell is cut to the cap", () => {
		expect(jev.PLAN_CELL_CHARS).toBe(LIMITS.planCellCode);
		const state = jev.planGuardState(`run_dag()\n${"x".repeat(10_000)}`, false) as { code: string };
		expect(state.code.length).toBe(LIMITS.planCellCode);
		expect(state.code).toContain("run_dag()");
	});

	test("a spec and its turns are cut to their caps, newest turns kept", () => {
		expect(jev.SPEC_JEV_CHARS).toBe(LIMITS.specJevText);
		expect(jev.PIPELINE_TURNS).toBe(LIMITS.pipelineTurns);
		expect(jev.PIPELINE_TURN_CHARS).toBe(LIMITS.pipelineTurnChars);
		const turns = Array.from({ length: 20 }, (_, i) => `turn ${i} ${"y".repeat(1000)}`);
		const state = jev.specJevState("spec " + "z".repeat(20_000), turns, false) as { spec: string; user_turns: string[] };
		expect(state.spec.length).toBe(LIMITS.specJevText);
		expect(state.user_turns).toHaveLength(LIMITS.pipelineTurns);
		expect(state.user_turns[0]).toContain("turn 12");
		expect(state.user_turns.at(-1)).toContain("turn 19");
		for (const turn of state.user_turns) expect(turn.length).toBeLessThanOrEqual(LIMITS.pipelineTurnChars);
	});

	test("an approval state names the flip and keeps the newest exchanges", () => {
		const flip: ApprovalFlip = { artifact: "spec", via: "marker", path: ".omp/pipeline/specs/x.md", labels: ["Approve"] };
		const exchanges = Array.from({ length: 12 }, (_, i) => `exchange ${i} ${"w".repeat(1000)}`);
		const state = jev.approvalJevState(flip, exchanges, false) as { artifact: string; target: string; approving_options: string[]; exchanges: string[] };
		expect(state.artifact).toBe("spec");
		expect(state.target).toBe(".omp/pipeline/specs/x.md");
		expect(state.approving_options).toEqual(["Approve"]);
		expect(state.exchanges).toHaveLength(LIMITS.pipelineTurns);
		expect(state.exchanges[0]).toContain("exchange 4");
	});

	test("an ask answer formats as one capped line", () => {
		const line = jev.formatAskAnswer({ question: "Approve this spec?", options: ["Request changes", "Approve"], selected: [], customInput: "Yes, ship it", timedOut: false }, false);
		expect(line).toContain("Approve this spec?");
		expect(line).toContain("Yes, ship it");
		expect(line.length).toBeLessThanOrEqual(LIMITS.pipelineTurnChars);
	});

	test("a formatted answer is redacted before it is cut", () => {
		// Secret shapes are built by concatenation so the key material only ever exists at test runtime.
		const aws = "AKIA" + "IOSFODNN7" + "EXAMPLE";
		const bearer = "Bearer " + "abc123".repeat(3);
		const line = jev.formatAskAnswer(
			{ question: "Where is the key?", options: ["Here"], selected: [], customInput: `${aws} and ${bearer}`, timedOut: false },
			true,
		);
		expect(line).not.toContain(aws);
		expect(line).not.toContain(bearer.slice("Bearer ".length));
		expect(line).toContain("[REDACTED]");
	});

	test("a pick omp made on a timeout is marked as one", () => {
		const answer = { question: "Approve this spec?", options: ["Request changes", "Approve"], selected: ["Approve"], customInput: null, timedOut: true };
		expect(jev.formatAskAnswer(answer, false)).toContain("picked: Approve (auto-selected after timeout)");
		expect(jev.formatAskAnswer({ ...answer, timedOut: false }, false)).not.toContain("auto-selected");
	});

	test("a flip without a path says so instead of sending undefined", () => {
		const flip: ApprovalFlip = { artifact: "dag", via: "call", path: null, labels: ["Run"] };
		const state = jev.approvalJevState(flip, [], false) as { target: string };
		expect(state.target).toBe("(no path given)");
	});

	test("an oversize answer is cut to the turn cap", () => {
		const line = jev.formatAskAnswer({ question: "Q?", options: [], selected: [], customInput: "x".repeat(2000), timedOut: false }, false);
		expect(line.length).toBeLessThanOrEqual(LIMITS.pipelineTurnChars);
		expect(line).toContain("xxx");
	});

	test("oversize exchanges are cut to the turn cap, newest kept", () => {
		const flip: ApprovalFlip = { artifact: "spec", via: "marker", path: "s.md", labels: ["Approve"] };
		const exchanges = Array.from({ length: 20 }, (_, i) => `exchange ${i} ${"w".repeat(2000)}`);
		const state = jev.approvalJevState(flip, exchanges, false) as { exchanges: string[] };
		expect(state.exchanges).toHaveLength(LIMITS.pipelineTurns);
		expect(state.exchanges[0]).toContain("exchange 12");
		for (const exchange of state.exchanges) expect(exchange.length).toBeLessThanOrEqual(LIMITS.pipelineTurnChars);
	});
});

describe("hook budget", () => {
	test("the whole-hook budget stays well under the host timeout even beside the propose gate", () => {
		expect(jev.PIPELINE_JEV_BUDGET_MS).toBe(LIMITS.pipelineHookBudgetMs);
		expect(jev.PIPELINE_JEV_BUDGET_MS).toBeLessThan(30_000 - LIMITS.gateDeadlineMs);
	});
});

describe("floors", () => {
	test("each judge fires at exactly its floor", async () => {
		reset({ [jev.STARTS_DAG_RUN]: noulAnswer(0.45) });
		expect(await jev.judgePlanCell("print(1)", OPTS)).toBe(true);

		reset({ [jev.UNFOUNDED_DECISIONS]: noulAnswer(0.45), [jev.VAGUE_ACCEPTANCE]: noulAnswer(0.4499) });
		expect((await jev.judgeSpecText("spec", ["you said sqlite"], OPTS))!.map((p) => p.code)).toEqual(["jev-unfounded"]);

		const flip: ApprovalFlip = { artifact: "prd", via: "flag", path: ".omp/pipeline/prd.json", labels: ["Approve"] };
		reset({ [jev.APPROVAL_GRANTED]: noulAnswer(0.45) });
		expect(await jev.judgeApproval(flip, ["Q: approve? A:  (typed: yes)"], OPTS)).toBe(true);
	});
});

describe("judgePlanCell", () => {
	test("fires at or above the floor, silent below it, and sends the timeout with no retries", async () => {
		reset({ [jev.STARTS_DAG_RUN]: noulAnswer(0.9) });
		expect(await jev.judgePlanCell("globals()['run_dag']()", OPTS)).toBe(true);
		expect(askCalls).toHaveLength(1);
		expect(askCalls[0].opts).toMatchObject({ timeoutMs: OPTS.timeoutMs, maxRetries: 0 });
		expect(Object.keys(askCalls[0].questions)).toEqual([jev.STARTS_DAG_RUN]);

		reset({ [jev.STARTS_DAG_RUN]: noulAnswer(0.44) });
		expect(await jev.judgePlanCell("print(1)", OPTS)).toBe(false);

		reset({ [jev.STARTS_DAG_RUN]: noulAnswer(0.45) });
		expect(await jev.judgePlanCell("print(1)", OPTS)).toBe(true);
	});

	test("a missing answer is silent, a failed call is null", async () => {
		reset({});
		expect(await jev.judgePlanCell("print(1)", OPTS)).toBe(false);

		reset({}, new Error("boom"));
		expect(await jev.judgePlanCell("print(1)", OPTS)).toBeNull();
	});

	test("a spent hook budget ends the call as unknown without asking", async () => {
		reset({ [jev.STARTS_DAG_RUN]: noulAnswer(0.99) });
		const controller = new AbortController();
		controller.abort();
		expect(await jev.judgePlanCell("globals()['run_dag']()", { ...OPTS, signal: controller.signal })).toBeNull();
		expect(askCalls).toEqual([]);
	});
});

describe("judgeSpecText", () => {
	test("each fired question becomes a problem with its code", async () => {
		reset({ [jev.UNFOUNDED_DECISIONS]: noulAnswer(0.8), [jev.VAGUE_ACCEPTANCE]: noulAnswer(0.1) });
		const problems = (await jev.judgeSpecText("spec", ["you said sqlite"], OPTS))!;
		expect(problems.map((p) => p.code)).toEqual(["jev-unfounded"]);

		reset({ [jev.UNFOUNDED_DECISIONS]: noulAnswer(0.1), [jev.VAGUE_ACCEPTANCE]: noulAnswer(0.7) });
		expect((await jev.judgeSpecText("spec", ["you said sqlite"], OPTS))!.map((p) => p.code)).toEqual(["jev-vague"]);
	});

	test("nothing fired is no problems, a failed call is null", async () => {
		reset({});
		expect(await jev.judgeSpecText("spec", ["you said sqlite"], OPTS)).toEqual([]);

		reset({}, new Error("boom"));
		expect(await jev.judgeSpecText("spec", ["you said sqlite"], OPTS)).toBeNull();
	});

	test("problems render through the spec note", async () => {
		const { renderSpecNote } = await import("../../src/pipeline/spec");
		reset({ [jev.UNFOUNDED_DECISIONS]: noulAnswer(0.9), [jev.VAGUE_ACCEPTANCE]: noulAnswer(0.9) });
		const problems = (await jev.judgeSpecText("spec", ["words"], OPTS))!;
		const note = renderSpecNote(".omp/pipeline/specs/x.md", problems)!;
		expect(note).toContain('problems="2"');
		expect(note).toContain("Jev");
	});
});

describe("judgeApproval", () => {
	const flip: ApprovalFlip = { artifact: "prd", via: "flag", path: ".omp/pipeline/prd.json", labels: ["Approve"] };

	test("a granted judgment allows, anything else does not", async () => {
		reset({ [jev.APPROVAL_GRANTED]: noulAnswer(0.95) });
		expect(await jev.judgeApproval(flip, ["Q: approve? A:  (typed: yes ship it)"], OPTS)).toBe(true);

		reset({ [jev.APPROVAL_GRANTED]: noulAnswer(0.2) });
		expect(await jev.judgeApproval(flip, ["Q: approve? A:  (typed: not yet)"], OPTS)).toBe(false);

		reset({});
		expect(await jev.judgeApproval(flip, ["Q: approve? A:  (typed: maybe)"], OPTS)).toBe(false);

		reset({}, new Error("boom"));
		expect(await jev.judgeApproval(flip, ["Q: approve? A:  (typed: yes)"], OPTS)).toBeNull();
	});
});

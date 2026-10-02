import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * ambiguity.ts unit tests. src/client.ts is mocked exactly as in reviewer.test.ts so
 * scoreAmbiguity runs with no network: `ask` returns a queued answer set and the
 * question builders are pass-throughs (their shape is never inspected before being
 * handed to `ask`).
 */

interface QueuedAnswer {
	type: string;
	[key: string]: unknown;
}

let queuedAnswers: Record<string, QueuedAnswer> = {};
let askShouldThrow = false;
let lastAsk: { state: unknown; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> } | null = null;
let askCalls = 0;

mock.module("../src/client", () => ({
	apiKeyPresent: () => true,
	ask: async (state: unknown, questions: unknown, _opts: unknown) => {
		askCalls += 1;
		lastAsk = { state, questions: questions as NonNullable<typeof lastAsk>["questions"] };
		if (askShouldThrow) throw new Error("boom");
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

const {
	DIMENSIONS,
	MAX_PROPOSE_BLOCKS,
	USER_DIMENSIONS,
	askRecordsFromResult,
	asksObserved,
	buildAmbiguityBattery,
	buildBlockReason,
	buildGateNote,
	compositeAmbiguity,
	draftQuestion,
	entityCandidates,
	getAmbiguityTelemetry,
	getAsks,
	getUserReplies,
	hasSteered,
	isProposeWrite,
	markSteered,
	noteProposeBlock,
	normalizeWeights,
	proposeDecision,
	recordAsk,
	recordAskResult,
	recordFollowUp,
	recordScore,
	resetAmbiguityPlan,
	resetAmbiguitySession,
	scoreAmbiguity,
	steerDecision,
	weakestDimension,
} = await import("../src/ambiguity");
const { DEFAULT_CONFIG } = await import("../src/config");

const W = DEFAULT_CONFIG.ambiguityGate.weights;
const GATE_CFG = DEFAULT_CONFIG.ambiguityGate;

function dims(goal: number, constraints: number, criteria: number, context: number) {
	return { goal, constraints, criteria, context };
}


const FLAT_QUEUE: Record<string, QueuedAnswer> = {
	goal_clarity: { type: "score", score: 2 },
	constraints_clarity: { type: "score", score: 1 },
	criteria_clarity: { type: "score", score: 4 },
	context_clarity: { type: "score", score: 4 },
	gap_goal: { type: "choice", choice: "which_surface" },
	gap_constraints: { type: "choice", choice: "non_goals" },
	gap_criteria: { type: "choice", choice: "none" },
	user_can_answer_goal: { type: "noul", noul: 0.6 },
	user_can_answer_constraints: { type: "noul", noul: 0.82 },
	user_can_answer_criteria: { type: "noul", noul: 0.1 },
};

describe("compositeAmbiguity — deep-interview brownfield weights", () => {
	test("all dimensions fully clear gives 0", () => {
		expect(compositeAmbiguity(dims(1, 1, 1, 1), W)).toBeCloseTo(0, 10);
	});

	test("all dimensions fully unclear gives 1", () => {
		expect(compositeAmbiguity(dims(0, 0, 0, 0), W)).toBeCloseTo(1, 10);
	});

	test("half-clear everywhere gives 0.5", () => {
		expect(compositeAmbiguity(dims(0.5, 0.5, 0.5, 0.5), W)).toBeCloseTo(0.5, 10);
	});

	test("a worked example: 1 - (0.35*1 + 0.25*0.5 + 0.25*0.75 + 0.15*1) = 0.1875", () => {
		expect(compositeAmbiguity(dims(1, 0.5, 0.75, 1), W)).toBeCloseTo(0.1875, 10);
	});

	test("only goal unclear costs exactly the goal weight", () => {
		expect(compositeAmbiguity(dims(0, 1, 1, 1), W)).toBeCloseTo(0.35, 10);
	});

	test("only context unclear costs exactly the context weight", () => {
		expect(compositeAmbiguity(dims(1, 1, 1, 0), W)).toBeCloseTo(0.15, 10);
	});

	test("out-of-range dimension values are clamped to 0..1", () => {
		expect(compositeAmbiguity(dims(5, 1, 1, 1), W)).toBeCloseTo(0, 10);
		expect(compositeAmbiguity(dims(-3, 1, 1, 1), W)).toBeCloseTo(0.35, 10);
	});

	test("the weights sum to 1 so the score spans the full range", () => {
		expect(W.goal + W.constraints + W.criteria + W.context).toBeCloseTo(1, 10);
	});
});

describe("weight normalization — a partial override must not rescale the score", () => {
	test("tuning only goal to 0.6 (sum 1.25) keeps a uniformly 0.70-clear task at 0.30, not 0.125", () => {
		const tuned = { goal: 0.6, constraints: 0.25, criteria: 0.25, context: 0.15 };
		expect(compositeAmbiguity(dims(0.7, 0.7, 0.7, 0.7), tuned)).toBeCloseTo(0.3, 10);
		expect(compositeAmbiguity(dims(0.7, 0.7, 0.7, 0.7), W)).toBeCloseTo(0.3, 10);
	});

	test("all weights 1 does not zero out a barely clear task", () => {
		const ones = { goal: 1, constraints: 1, criteria: 1, context: 1 };
		expect(compositeAmbiguity(dims(0.25, 0.25, 0.25, 0.25), ones)).toBeCloseTo(0.75, 10);
	});

	test("weights that sum below 1 do not inflate the score either", () => {
		const half = { goal: 0.175, constraints: 0.125, criteria: 0.125, context: 0.075 };
		expect(compositeAmbiguity(dims(1, 1, 1, 1), half)).toBeCloseTo(0, 10);
		expect(compositeAmbiguity(dims(0, 0, 0, 0), half)).toBeCloseTo(1, 10);
	});

	test("scaling every weight by the same factor changes nothing", () => {
		const scaled = { goal: 3.5, constraints: 2.5, criteria: 2.5, context: 1.5 };
		expect(compositeAmbiguity(dims(1, 0.5, 0.75, 1), scaled)).toBeCloseTo(0.1875, 10);
	});

	test("all-zero weights fall back to the defaults instead of dividing by zero", () => {
		const zeros = { goal: 0, constraints: 0, criteria: 0, context: 0 };
		expect(compositeAmbiguity(dims(1, 0, 1, 1), zeros)).toBeCloseTo(0.25, 10);
		expect(normalizeWeights(zeros)).toEqual(W);
	});

	test("negative and non-finite weights count as zero", () => {
		const odd = { goal: -1, constraints: Number.NaN, criteria: 0.5, context: 0.5 };
		expect(normalizeWeights(odd)).toEqual({ goal: 0, constraints: 0, criteria: 0.5, context: 0.5 });
		expect(compositeAmbiguity(dims(0, 0, 1, 0), odd)).toBeCloseTo(0.5, 10);
	});

	test("normalizeWeights keeps proportions and sums to 1", () => {
		const n = normalizeWeights({ goal: 2, constraints: 1, criteria: 1, context: 0 });
		expect(n).toEqual({ goal: 0.5, constraints: 0.25, criteria: 0.25, context: 0 });
	});

	test("weakestDimension is unaffected by a uniform weight scale", () => {
		const ones = { goal: 3.5, constraints: 2.5, criteria: 2.5, context: 1.5 };
		expect(weakestDimension(dims(0.5, 1, 1, 0.2), ones)).toBe("goal");
	});
});

describe("weakestDimension — largest weighted shortfall", () => {
	test("picks the dimension with the biggest weighted gap, not the lowest raw score", () => {
		// context is lower raw (0.2) but goal's shortfall is 0.35*0.5=0.175 > 0.15*0.8=0.12.
		expect(weakestDimension(dims(0.5, 1, 1, 0.2), W)).toBe("goal");
	});

	test("picks context when its gap dominates despite the small weight", () => {
		expect(weakestDimension(dims(1, 1, 1, 0), W)).toBe("context");
	});

	test("picks constraints over criteria at equal clarity by tie-break order", () => {
		expect(weakestDimension(dims(1, 0.4, 0.4, 1), W)).toBe("constraints");
	});

	test("a fully clear task still returns a dimension", () => {
		expect(DIMENSIONS).toContain(weakestDimension(dims(1, 1, 1, 1), W));
	});

	test("restricting to the user dimensions skips a larger context gap", () => {
		// context shortfall 0.15, constraints 0.25*0.2=0.05: unrestricted picks context.
		expect(weakestDimension(dims(0.9, 0.8, 0.95, 0), W)).toBe("context");
		expect(weakestDimension(dims(0.9, 0.8, 0.95, 0), W, { among: USER_DIMENSIONS })).toBe("constraints");
	});

	test("a dimension only the agent can resolve is discounted by its user_can_answer", () => {
		// plain: goal 0.175 beats constraints 0.0625; discounted: goal 0.0175 loses to constraints 0.05625.
		expect(weakestDimension(dims(0.5, 0.75, 1, 1), W)).toBe("goal");
		expect(weakestDimension(dims(0.5, 0.75, 1, 1), W, { userCanAnswer: { goal: 0.1, constraints: 0.9 } })).toBe("constraints");
	});

	test("when nobody can answer anything the plain shortfall still names the weakest", () => {
		expect(weakestDimension(dims(0.5, 0.75, 1, 1), W, { userCanAnswer: {} })).toBe("goal");
		expect(weakestDimension(dims(0.5, 0.75, 1, 1), W, { userCanAnswer: { goal: 0, constraints: 0 } })).toBe("goal");
	});
});

describe("isProposeWrite", () => {
	test("matches the path key", () => {
		expect(isProposeWrite({ path: "xd://propose" })).toBe(true);
	});

	test("matches the file_path key", () => {
		expect(isProposeWrite({ file_path: "xd://propose" })).toBe(true);
	});

	test("tolerates surrounding whitespace", () => {
		expect(isProposeWrite({ file_path: "  xd://propose  " })).toBe(true);
	});

	test("omp reads the xd:// scheme case-insensitively, so XD://propose is still a plan submission", () => {
		expect(isProposeWrite({ path: "XD://propose" })).toBe(true);
		expect(isProposeWrite({ path: "Xd://Propose" })).toBe(true);
	});

	test("rejects names that merely start with propose", () => {
		expect(isProposeWrite({ path: "xd://proposeX" })).toBe(false);
		expect(isProposeWrite({ path: "xd://proposed" })).toBe(false);
	});

	test("rejects a path, query or fragment after the device name, as omp does", () => {
		expect(isProposeWrite({ path: "xd://propose/plan.md" })).toBe(false);
		expect(isProposeWrite({ path: "xd://propose/" })).toBe(false);
		expect(isProposeWrite({ path: "xd://propose?x=1" })).toBe(false);
		expect(isProposeWrite({ path: "xd://propose#top" })).toBe(false);
	});

	test("rejects an ordinary file write", () => {
		expect(isProposeWrite({ path: "/tmp/plan.md" })).toBe(false);
	});

	test("rejects another virtual device", () => {
		expect(isProposeWrite({ path: "xd://other" })).toBe(false);
	});

	test("rejects non-record and missing input", () => {
		expect(isProposeWrite(undefined)).toBe(false);
		expect(isProposeWrite("xd://propose")).toBe(false);
		expect(isProposeWrite({})).toBe(false);
	});
});

describe("proposeDecision — block vs would_block", () => {
	const ambiguous = { ambiguity: 0.31, userCanAnswer: 0.9 };

	beforeEach(() => {
		resetAmbiguitySession();
	});

	test("blocks with a UI", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, true)).toBe("block");
	});

	test("records would_block headless instead of blocking", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, false)).toBe("would_block");
	});

	test("a clear task is never gated", () => {
		expect(proposeDecision({ ambiguity: 0.1, userCanAnswer: 0.9 }, GATE_CFG, true)).toBe("none");
	});

	test("ambiguity exactly at the threshold passes", () => {
		expect(proposeDecision({ ambiguity: 0.2, userCanAnswer: 0.9 }, GATE_CFG, true)).toBe("none");
	});

	test("ambiguity the agent could resolve itself is not gated", () => {
		expect(proposeDecision({ ambiguity: 0.6, userCanAnswer: 0.2 }, GATE_CFG, true)).toBe("none");
	});

	test("blockPropose: false disables the gate entirely", () => {
		expect(proposeDecision(ambiguous, { ...GATE_CFG, blockPropose: false }, true)).toBe("none");
	});

	test("never blocks when the ask tool is not active, even with a UI", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, true, { askAvailable: false })).toBe("would_block");
	});

	test("an active ask tool is the default, so existing callers keep blocking", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, true, {})).toBe("block");
		expect(proposeDecision(ambiguous, GATE_CFG, true, { askAvailable: true })).toBe("block");
	});

	test("stops blocking once the per-plan cap of blocks is spent", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, true, { blocksSoFar: MAX_PROPOSE_BLOCKS - 1 })).toBe("block");
		expect(proposeDecision(ambiguous, GATE_CFG, true, { blocksSoFar: MAX_PROPOSE_BLOCKS })).toBe("would_block");
		expect(proposeDecision(ambiguous, GATE_CFG, true, { blocksSoFar: 99 })).toBe("would_block");
	});

	test("the cap is configurable", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, true, { blocksSoFar: 1, maxBlocks: 1 })).toBe("would_block");
		expect(proposeDecision(ambiguous, GATE_CFG, true, { blocksSoFar: 1, maxBlocks: 3 })).toBe("block");
	});

	test("without an explicit count it reads the plan's recorded blocks, and a new plan resets it", () => {
		for (let i = 0; i < MAX_PROPOSE_BLOCKS; i++) {
			expect(proposeDecision(ambiguous, GATE_CFG, true)).toBe("block");
			noteProposeBlock();
		}
		expect(proposeDecision(ambiguous, GATE_CFG, true)).toBe("would_block");
		resetAmbiguityPlan();
		expect(proposeDecision(ambiguous, GATE_CFG, true)).toBe("block");
	});

	test("the cap never turns a clear task into a decision", () => {
		expect(proposeDecision({ ambiguity: 0.1, userCanAnswer: 0.9 }, GATE_CFG, true, { blocksSoFar: 99 })).toBe("none");
	});
});

describe("steerDecision — suppressed steers stay distinguishable from clear tasks", () => {
	const ambiguous = { ambiguity: 0.46, userCanAnswer: 0.8, weakest: "constraints" as const };
	const live = { askAvailable: true, immune: false };

	beforeEach(() => {
		resetAmbiguitySession();
	});

	test("a clear task is none", () => {
		expect(steerDecision({ ...ambiguous, ambiguity: 0.1 }, GATE_CFG, live)).toBe("none");
		expect(steerDecision({ ...ambiguous, ambiguity: 0.2 }, GATE_CFG, live)).toBe("none");
	});

	test("ambiguity the agent could resolve itself is none", () => {
		expect(steerDecision({ ...ambiguous, userCanAnswer: 0.3 }, GATE_CFG, live)).toBe("none");
	});

	test("an ambiguous task with nothing in the way steers", () => {
		expect(steerDecision(ambiguous, GATE_CFG, live)).toBe("steer");
	});

	test("an open immunity window is suppressed_immune, not none", () => {
		expect(steerDecision(ambiguous, GATE_CFG, { askAvailable: true, immune: true })).toBe("suppressed_immune");
	});

	test("a dimension that already steered this plan is suppressed_dedupe, not none", () => {
		markSteered("constraints");
		expect(steerDecision(ambiguous, GATE_CFG, live)).toBe("suppressed_dedupe");
		expect(steerDecision({ ...ambiguous, weakest: "criteria" }, GATE_CFG, live)).toBe("steer");
	});

	test("checking for a duplicate does not record it", () => {
		expect(steerDecision(ambiguous, GATE_CFG, live)).toBe("steer");
		expect(steerDecision(ambiguous, GATE_CFG, live)).toBe("steer");
		expect(hasSteered("constraints")).toBe(false);
	});

	test("without an ask tool the steer is would_steer and nothing is claimed as delivered", () => {
		expect(steerDecision(ambiguous, GATE_CFG, { askAvailable: false, immune: false })).toBe("would_steer");
		expect(steerDecision(ambiguous, GATE_CFG, { askAvailable: false, immune: true })).toBe("would_steer");
		expect(hasSteered("constraints")).toBe(false);
	});

	test("a new plan clears the steered dimensions", () => {
		markSteered("constraints");
		resetAmbiguityPlan();
		expect(steerDecision(ambiguous, GATE_CFG, live)).toBe("steer");
	});
});

describe("entity candidates and question drafting", () => {
	test("extracts the entity after an action verb", () => {
		expect(entityCandidates("Add a rate limiter to the API", 1)[0]).toBe("rate limiter");
	});

	test("a lone bare word names nothing, and the question is drafted without an entity", () => {
		expect(entityCandidates("hmm")).toEqual([]);
		expect(draftQuestion("goal", "none", "hmm")).toBe("What exactly should this change do when it is finished?");
	});

	test("stops at a stop word instead of swallowing it: 'Add support for dark mode'", () => {
		expect(entityCandidates("Add support for dark mode", 1)[0]).toBe("dark mode");
	});

	test("does not cross a sentence boundary: 'Fix the parser. Then add tests'", () => {
		expect(entityCandidates("Fix the parser. Then add tests", 1)[0]).toBe("parser");
	});

	test("does not take a connector as part of the entity: 'Make a plan to migrate the auth service'", () => {
		expect(entityCandidates("Make a plan to migrate the auth service to OAuth2", 1)[0]).toBe("auth service");
	});

	test("prefers a backticked identifier over a vague 'this change'", () => {
		expect(entityCandidates("Implement `RateLimiter.acquire()` in src/limits/rate.ts", 1)[0]).toBe("RateLimiter.acquire()");
	});

	test("never ends on a connector or contains a sentence break", () => {
		const tasks = [
			"Add support for dark mode",
			"Fix the parser. Then add tests",
			"Make a plan to migrate the auth service to OAuth2",
			"Fix the bug where login fails on Safari",
			"I want to make sure checkout doesn't break when the cart is empty",
			"Update: users can't log in after the deploy",
		];
		for (const t of tasks) {
			const entity = entityCandidates(t, 1)[0] ?? "";
			expect(entity).not.toMatch(/(^|\s)(for|to|where|then|when|in|on|of)$/i);
			expect(entity).not.toMatch(/[.!?]\s/);
		}
	});

	test("candidates are verbatim spans of the task, most specific first", () => {
		const task = "Implement `RateLimiter.acquire()` in src/limits/rate.ts";
		expect(entityCandidates(task)).toEqual(["RateLimiter.acquire()", "src/limits/rate.ts"]);
		for (const c of entityCandidates("Add a rate limiter to the API and fix the parser. Then add tests")) {
			expect("Add a rate limiter to the API and fix the parser. Then add tests").toContain(c);
		}
	});

	test("nested candidates collapse to the longest, so the options are mutually exclusive", () => {
		expect(entityCandidates("make sure the login tests pass")).toEqual(["login tests pass"]);
	});

	test("sentence boundaries separate candidates", () => {
		expect(entityCandidates("Fix the parser. Then add tests")).toEqual(["parser", "tests"]);
	});

	test("'none', stop words and generic spans are never candidates", () => {
		expect(entityCandidates("Add none")).toEqual([]);
		expect(entityCandidates("Make a plan")).toEqual([]);
		expect(entityCandidates("")).toEqual([]);
		expect(entityCandidates(undefined as unknown as string)).toEqual([]);
	});

	test("the candidate list is capped", () => {
		const task = "Rename alphaOne, betaTwo, gammaThree, deltaFour, epsilonFive, zetaSix and etaSeven";
		expect(entityCandidates(task, 3)).toHaveLength(3);
		expect(entityCandidates(task).length).toBeLessThanOrEqual(12);
	});

	test("fills the entity into the dimension/gap template", () => {
		const q = draftQuestion("constraints", "non_goals", "Add a rate limiter to the API");
		expect(q).toBe("About “rate limiter”: what is explicitly out of scope?");
	});

	test("an entity picked by Jev overrides the heuristic one", () => {
		const q = draftQuestion("constraints", "non_goals", "Add a rate limiter to the API", "API");
		expect(q).toBe("About “API”: what is explicitly out of scope?");
	});

	// The span is the user's text: `$&`, `$$`, `$'` and `$\`` are replacement patterns only to a string replacement.
	test("an entity is copied literally, whatever `$` sequences it holds", () => {
		const about = (span: string) => `About “${span}”: what exactly should it do when it is finished?`;
		for (const span of ["price$&tag", "$&", "a$$b", "a$'b", "a$`b", "$1 and $<x>"]) {
			expect(draftQuestion("goal", "none", "task", span)).toBe(about(span));
		}
		expect(draftQuestion("goal", "none", "Fix the `$&` regex")).toBe(about("$&"));
		expect(draftQuestion("goal", "none", "Fix the `a$'b` regex")).toBe(about("a$'b"));
	});

	test("a null entity drafts without naming anything", () => {
		const q = draftQuestion("constraints", "non_goals", "Add a rate limiter to the API", null);
		expect(q).toBe("What is explicitly out of scope for this change?");
		expect(draftQuestion("goal", "none", "hmm")).toBe("What exactly should this change do when it is finished?");
	});

	test("a drafted question is grammatical for the prompts that used to garble it", () => {
		expect(draftQuestion("goal", "which_user", "Add support for dark mode")).toBe(
			"About “dark mode”: who is it for, which user or caller should it serve?",
		);
		expect(draftQuestion("goal", "which_user", "Fix the parser. Then add tests")).not.toContain("Then");
	});

	test("an unknown gap falls back to the dimension's generic template", () => {
		const q = draftQuestion("criteria", "not_a_gap", "Rename the parser module");
		expect(q).toBe("About “parser module”: how will we know it succeeded?");
	});

	test("the user is never asked where the code belongs: `context` has no question to draft", () => {
		expect(USER_DIMENSIONS).not.toContain("context");
		// @ts-expect-error `context` is the agent's to resolve, so draftQuestion only takes a UserDimension
		const draft = () => draftQuestion("context", "none", "t");
		// There is no template to read, so this throws: a template for `context`, worded any way, ends that.
		expect(draft).toThrow(TypeError);
	});

	test("every user dimension and gap has an entity and a plain form", () => {
		for (const dim of USER_DIMENSIONS) {
			for (const gap of ["none", "which_user", "non_goals", "edge_cases", "bogus"]) {
				const withEntity = draftQuestion(dim, gap, "t", "thing");
				const plain = draftQuestion(dim, gap, "t", null);
				expect(withEntity).toContain("“thing”");
				expect(plain).not.toContain("“");
				expect(plain.endsWith("?")).toBe(true);
			}
		}
	});
});

describe("gate message rendering", () => {
	const result = {
		ambiguity: 0.46,
		dims: dims(0.5, 0.25, 1, 1),
		weakest: "constraints" as const,
		gap: "scope_boundary",
		userCanAnswer: 0.8,
		question: "What is explicitly out of scope?",
	};

	test("the aside carries score, threshold, weakest, gap and the drafted question", () => {
		const note = buildGateNote(result, 0.2);
		expect(note).toContain('<ambiguity-gate score="0.46" threshold="0.20" weakest="constraints" gap="scope_boundary">');
		expect(note).toContain("What is explicitly out of scope?");
		expect(note).toContain("Use the ask tool");
		expect(note).toContain("</ambiguity-gate>");
	});

	test("the block reason names the numbers, the weakest dimension label, and the question", () => {
		const reason = buildBlockReason({ ...result, weakest: "criteria" }, 0.2);
		expect(reason).toContain("Ambiguity 0.46 > 0.20 (weakest: success criteria)");
		expect(reason).toContain("Ask the user first with the ask tool");
		expect(reason).toContain("Then resubmit");
	});

	test("without an ask tool the aside asks for a stated assumption and never mentions the tool", () => {
		const note = buildGateNote(result, 0.2, false);
		expect(note).toContain('<ambiguity-gate score="0.46" threshold="0.20" weakest="constraints" gap="scope_boundary">');
		expect(note).toContain("What is explicitly out of scope?");
		expect(note).toContain("state the assumption");
		expect(note).not.toContain("ask tool");
		expect(note).toContain("</ambiguity-gate>");
	});

	test("without an ask tool the block reason asks for a stated assumption too", () => {
		const reason = buildBlockReason(result, 0.2, false);
		expect(reason).toContain("Ambiguity 0.46 > 0.20");
		expect(reason).toContain("stating your assumption");
		expect(reason).not.toContain("ask tool");
	});
});

describe("battery shape", () => {
	test("one score per dimension; gap choice and user_can_answer per user dimension", () => {
		const battery = buildAmbiguityBattery() as Record<string, { type: string; levels?: string[] }>;
		for (const dim of DIMENSIONS) {
			expect(battery[`${dim}_clarity`].type).toBe("score");
			expect(battery[`${dim}_clarity`].levels).toHaveLength(5);
		}
		for (const dim of USER_DIMENSIONS) {
			expect(battery[`gap_${dim}`].type).toBe("choice");
			expect(battery[`user_can_answer_${dim}`].type).toBe("noul");
		}
		expect(Object.keys(battery)).toHaveLength(4 + USER_DIMENSIONS.length * 2);
	});

	test("the agent-resolvable context dimension gets neither a gap question nor a user_can_answer", () => {
		const battery = buildAmbiguityBattery();
		expect(battery.gap_context).toBeUndefined();
		expect(battery.user_can_answer_context).toBeUndefined();
		expect(battery.user_can_answer).toBeUndefined();
	});

	test("no entity question without candidates", () => {
		expect(buildAmbiguityBattery([]).target_entity).toBeUndefined();
	});

	test("candidates become a choice with a none option, in the same call", () => {
		const battery = buildAmbiguityBattery(["rate limiter", "API"]) as Record<string, { type: string; criteria?: Record<string, unknown> }>;
		expect(battery.target_entity.type).toBe("choice");
		expect(Object.keys(battery.target_entity.criteria ?? {})).toEqual(["rate limiter", "API", "none"]);
		expect(Object.keys(battery)).toHaveLength(4 + USER_DIMENSIONS.length * 2 + 1);
	});
});

describe("scoreAmbiguity", () => {
	const pi = { logger: {} };

	beforeEach(() => {
		askShouldThrow = false;
		askCalls = 0;
		lastAsk = null;
		resetAmbiguitySession();
		queuedAnswers = { ...FLAT_QUEUE };
	});

	test("normalizes 0-4 scores to 0..1 and composes the ambiguity", async () => {
		const out = await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG);
		expect(out).not.toBeNull();
		// clarity = 0.35*0.5 + 0.25*0.25 + 0.25*1 + 0.15*1 = 0.6375
		expect(out!.ambiguity).toBeCloseTo(0.3625, 10);
		expect(out!.dims.goal).toBeCloseTo(0.5, 10);
		expect(out!.userCanAnswer).toBeCloseTo(0.82, 10);
	});

	test("an un-normalized weight override gives the same score as the normalized one", async () => {
		const doubled = { ...GATE_CFG, weights: { goal: 0.7, constraints: 0.5, criteria: 0.5, context: 0.3 } };
		const out = await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, doubled);
		expect(out!.ambiguity).toBeCloseTo(0.3625, 10);
	});

	test("selects the weakest dimension and its gap, and drafts from that pair", async () => {
		const out = await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG);
		// discounted shortfalls: goal 0.35*0.5*0.6=0.105, constraints 0.25*0.75*0.82=0.154 — constraints is weakest.
		expect(out!.weakest).toBe("constraints");
		expect(out!.gap).toBe("non_goals");
		expect(out!.question).toBe("What is explicitly out of scope for this change?");
	});

	test("one Jev call carries the whole battery, including the entity choice", async () => {
		await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG);
		expect(askCalls).toBe(1);
		expect(Object.keys(lastAsk!.questions.target_entity.criteria ?? {})).toEqual(["rate limiter", "API", "none"]);
		expect(lastAsk!.questions.user_can_answer_goal.type).toBe("noul");
	});

	test("a task with no candidate span sends no entity question and drafts without one", async () => {
		const out = await scoreAmbiguity(pi, { task: "hmm" }, GATE_CFG);
		expect(lastAsk!.questions.target_entity).toBeUndefined();
		expect(out!.entity).toBeNull();
		expect(out!.question).toBe("What is explicitly out of scope for this change?");
	});

	test("a confident entity pick from the candidate list is spliced into the question verbatim", async () => {
		queuedAnswers.target_entity = {
			type: "choice",
			choice: "rate limiter",
			confidence: 0.9,
			probabilities: { "rate limiter": 0.9, API: 0.05, none: 0.05 },
		};
		const out = await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG);
		expect(out!.entity).toBe("rate limiter");
		expect(out!.question).toBe("About “rate limiter”: what is explicitly out of scope?");
	});

	test("a low-confidence pick falls back to the plain question", async () => {
		queuedAnswers.target_entity = {
			type: "choice",
			choice: "rate limiter",
			confidence: 0.4,
			probabilities: { "rate limiter": 0.4, API: 0.1, none: 0.5 },
		};
		const out = await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG);
		expect(out!.entity).toBeNull();
		expect(out!.question).toBe("What is explicitly out of scope for this change?");
	});

	test("'none' and labels that are not candidates never reach the question", async () => {
		queuedAnswers.target_entity = { type: "choice", choice: "none", confidence: 0.95 };
		expect((await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG))!.entity).toBeNull();
		queuedAnswers.target_entity = { type: "choice", choice: "something Jev made up", confidence: 0.95 };
		expect((await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG))!.entity).toBeNull();
	});

	test("a code-reading gap is never turned into a question for the user", async () => {
		// Live Jev on a crisp task before any code was read: context ~0, constraints and criteria partly open.
		queuedAnswers = {
			...FLAT_QUEUE,
			goal_clarity: { type: "score", score: 3.8 },
			constraints_clarity: { type: "score", score: 2.33 },
			criteria_clarity: { type: "score", score: 3.02 },
			context_clarity: { type: "score", score: 0.01 },
			gap_constraints: { type: "choice", choice: "hard_limits" },
			user_can_answer_goal: { type: "noul", noul: 0.1 },
			user_can_answer_constraints: { type: "noul", noul: 0.7 },
			user_can_answer_criteria: { type: "noul", noul: 0.55 },
		};
		const out = await scoreAmbiguity(pi, { task: "Add per-IP rate limiting to the public /api routes" }, GATE_CFG);
		expect(out!.weakest).toBe("constraints");
		expect(out!.weakest).not.toBe("context");
		expect(out!.question).not.toMatch(/existing code|current behavior|which code/i);
		expect(out!.userCanAnswer).toBeCloseTo(0.7, 10);
	});

	test("the floor check follows the chosen dimension, not a single global probability", async () => {
		// goal is the biggest raw gap but the agent could settle it; criteria is the user's call.
		queuedAnswers = {
			...FLAT_QUEUE,
			goal_clarity: { type: "score", score: 0 },
			constraints_clarity: { type: "score", score: 4 },
			criteria_clarity: { type: "score", score: 2 },
			gap_criteria: { type: "choice", choice: "acceptance_test" },
			user_can_answer_goal: { type: "noul", noul: 0.05 },
			user_can_answer_constraints: { type: "noul", noul: 0.05 },
			user_can_answer_criteria: { type: "noul", noul: 0.9 },
		};
		const out = await scoreAmbiguity(pi, { task: "Make exports better" }, GATE_CFG);
		expect(out!.weakest).toBe("criteria");
		expect(out!.gap).toBe("acceptance_test");
		expect(out!.userCanAnswer).toBeCloseTo(0.9, 10);
	});

	test("only context unclear: the weakest is still a user dimension and carries a low user_can_answer", async () => {
		queuedAnswers = {
			...FLAT_QUEUE,
			goal_clarity: { type: "score", score: 4 },
			constraints_clarity: { type: "score", score: 4 },
			criteria_clarity: { type: "score", score: 4 },
			context_clarity: { type: "score", score: 0 },
			user_can_answer_goal: { type: "noul", noul: 0.04 },
			user_can_answer_constraints: { type: "noul", noul: 0.03 },
			user_can_answer_criteria: { type: "noul", noul: 0.02 },
		};
		const out = await scoreAmbiguity(pi, { task: "Rename the parser module" }, GATE_CFG);
		expect(USER_DIMENSIONS).toContain(out!.weakest as (typeof USER_DIMENSIONS)[number]);
		expect(out!.ambiguity).toBeCloseTo(0.15, 10);
		expect(steerDecision(out!, GATE_CFG, { askAvailable: true, immune: false })).toBe("none");
	});

	// At plan_start nothing has been read, so `context` is low for every task. It must not push a crisp prompt over the threshold.
	const crispUserDims = {
		goal_clarity: { type: "score", score: 3.4 },
		constraints_clarity: { type: "score", score: 3.4 },
		criteria_clarity: { type: "score", score: 3.4 },
		context_clarity: { type: "score", score: 0 },
		user_can_answer_goal: { type: "noul", noul: 0.9 },
		user_can_answer_constraints: { type: "noul", noul: 0.9 },
		user_can_answer_criteria: { type: "noul", noul: 0.9 },
	};

	test("plan_start leaves unread context out of the composite; later triggers keep it", async () => {
		queuedAnswers = { ...FLAT_QUEUE, ...crispUserDims };
		const task = { task: "Add per-IP rate limiting to the public /api routes" };
		const atStart = await scoreAmbiguity(pi, task, GATE_CFG, { trigger: "plan_start" });
		expect(atStart!.ambiguity).toBeCloseTo(0.15, 10);
		expect(atStart!.dims.context).toBe(0);
		expect(steerDecision(atStart!, GATE_CFG, { askAvailable: true, immune: false })).toBe("none");
		for (const trigger of ["turn_end", "propose"] as const) {
			const later = await scoreAmbiguity(pi, task, GATE_CFG, { trigger });
			expect(later!.ambiguity).toBeCloseTo(1 - 0.85 * 0.85, 10);
			expect(steerDecision(later!, GATE_CFG, { askAvailable: true, immune: false })).toBe("steer");
		}
		expect((await scoreAmbiguity(pi, task, GATE_CFG))!.ambiguity).toBeCloseTo(1 - 0.85 * 0.85, 10);
	});

	test("plan_start still scores unclear user dimensions against the threshold", async () => {
		queuedAnswers = { ...FLAT_QUEUE, ...crispUserDims, goal_clarity: { type: "score", score: 1 }, gap_goal: { type: "choice", choice: "which_surface" } };
		const out = await scoreAmbiguity(pi, { task: "Make exports better" }, GATE_CFG, { trigger: "plan_start" });
		// (0.35*0.25 + 0.25*0.85 + 0.25*0.85) / 0.85 = 0.5
		expect(out!.ambiguity).toBeCloseTo(1 - (0.35 * 0.25 + 0.25 * 0.85 + 0.25 * 0.85) / 0.85, 10);
		expect(out!.weakest).toBe("goal");
		expect(steerDecision(out!, GATE_CFG, { askAvailable: true, immune: false })).toBe("steer");
	});

	test("a Jev failure yields null so the caller decides none and never blocks", async () => {
		askShouldThrow = true;
		expect(await scoreAmbiguity(pi, { task: "anything" }, GATE_CFG)).toBeNull();
	});

	test("missing answers degrade to zero clarity rather than throwing", async () => {
		queuedAnswers = {};
		const out = await scoreAmbiguity(pi, { task: "anything" }, GATE_CFG);
		expect(out!.ambiguity).toBeCloseTo(1, 10);
		expect(out!.userCanAnswer).toBe(0);
	});
});

describe("ask results become clean question/answer records", () => {
	const input = {
		questions: [
			{
				id: "scope",
				question: "Which surfaces should rate limiting apply to?",
				header: "Scope",
				options: [
					{ label: "Public API only", description: "Apply to /api/* routes served to third parties; internal routes untouched" },
					{ label: "All HTTP routes", description: "Apply globally including the admin dashboard and health checks" },
				],
			},
			{ id: "limit", question: "What should happen when the limit is exceeded?", options: [{ label: "429 with Retry-After" }, { label: "Queue and delay" }] },
		],
	};
	const multiContent = [{ type: "text", text: "User answers:\nscope: Public API only\nlimit: 429 with Retry-After" }];
	const multiDetails = {
		results: [
			{ id: "scope", question: "Which surfaces should rate limiting apply to?", multi: false, selectedOptions: ["Public API only"] },
			{ id: "limit", question: "What should happen when the limit is exceeded?", multi: false, selectedOptions: ["429 with Retry-After"] },
		],
	};

	beforeEach(() => {
		resetAmbiguitySession();
	});

	test("a multi-question ask yields one record per question, so none is lost", () => {
		const records = askRecordsFromResult(input, multiContent, false, multiDetails);
		expect(records).toEqual([
			{ question: "Which surfaces should rate limiting apply to?", answer: "Public API only" },
			{ question: "What should happen when the limit is exceeded?", answer: "429 with Retry-After" },
		]);
	});

	test("recording counts per answered question and the second question is kept", () => {
		expect(recordAskResult(input, multiContent, false, multiDetails)).toBe(2);
		expect(asksObserved()).toBe(2);
		expect(getAsks().map((a) => a.question)).toContain("What should happen when the limit is exceeded?");
	});

	test("a single-question ask uses the structured result", () => {
		const details = { question: "Which surface?", options: ["CLI", "API"], multi: false, selectedOptions: ["CLI"] };
		expect(askRecordsFromResult({ questions: [{ question: "Which surface?" }] }, "User selected: CLI", false, details)).toEqual([
			{ question: "Which surface?", answer: "CLI" },
		]);
	});

	test("custom input, a note and a timeout are carried into the answer", () => {
		const custom = { question: "Which limit?", selectedOptions: [], customInput: "  60 per minute  " };
		expect(askRecordsFromResult({}, "x", false, custom)[0].answer).toBe("60 per minute");
		const both = { question: "Which limit?", selectedOptions: ["Other"], customInput: "60/min", note: "per IP" };
		expect(askRecordsFromResult({}, "x", false, both)[0].answer).toBe("Other; 60/min (note: per IP)");
		const timedOut = { question: "Which limit?", selectedOptions: ["Default"], timedOut: true };
		expect(askRecordsFromResult({}, "x", false, timedOut)[0].answer).toBe("Default (auto-selected after timeout)");
	});

	test("a cancelled dialog (isError) is not an answered ask and uses no budget", () => {
		const cancelled = [{ type: "text", text: "Ask tool was cancelled by the user" }];
		expect(askRecordsFromResult(input, cancelled, true, undefined)).toEqual([]);
		for (let i = 0; i < GATE_CFG.maxAsksPerPlan; i++) recordAskResult(input, cancelled, true, undefined);
		expect(asksObserved()).toBe(0);
	});

	test("a validation error result is not an answered ask even when isError is unset", () => {
		const invalid = [{ type: "text", text: "Error: question ids must be unique: scope" }];
		expect(askRecordsFromResult(input, invalid, false, {})).toEqual([]);
		expect(recordAskResult(input, invalid, undefined, {})).toBe(0);
	});

	test("choosing to chat instead of answering is not an answer", () => {
		const chat = [{ type: "text", text: "User chose to chat about this instead of answering.\n\nQuestions asked:\nWhich surface?" }];
		expect(askRecordsFromResult(input, chat, false, { chatRedirect: true, questions: ["Which surface?"] })).toEqual([]);
		expect(askRecordsFromResult(input, chat, false, undefined)).toEqual([]);
	});

	test("an unanswered question inside a multi-question ask is skipped", () => {
		const details = {
			results: [
				{ id: "scope", question: "Which surfaces?", selectedOptions: ["Public API only"] },
				{ id: "limit", question: "What on exceed?", selectedOptions: [] },
			],
		};
		expect(askRecordsFromResult(input, multiContent, false, details)).toEqual([{ question: "Which surfaces?", answer: "Public API only" }]);
	});

	test("without structured details a single-question ask pairs the input question with the result text", () => {
		const records = askRecordsFromResult({ questions: [{ id: "a", question: "Which surface?" }] }, [{ type: "text", text: "User selected: CLI" }], false);
		expect(records).toEqual([{ question: "Which surface?", answer: "User selected: CLI" }]);
	});

	test("without structured details a multi-question ask is split by question id", () => {
		const records = askRecordsFromResult(input, multiContent, false);
		expect(records).toEqual([
			{ question: "Which surfaces should rate limiting apply to?", answer: "Public API only" },
			{ question: "What should happen when the limit is exceeded?", answer: "429 with Retry-After" },
		]);
	});

	test("without structured details a cancelled entry in a multi-question ask is dropped", () => {
		const partial = [{ type: "text", text: "User answers:\nscope: Public API only\nlimit: (cancelled)" }];
		expect(askRecordsFromResult(input, partial, false)).toEqual([
			{ question: "Which surfaces should rate limiting apply to?", answer: "Public API only" },
		]);
	});

	test("nothing to pair gives no records", () => {
		expect(askRecordsFromResult(undefined, multiContent, false)).toEqual([]);
		expect(askRecordsFromResult({ questions: [] }, multiContent, false)).toEqual([]);
		expect(askRecordsFromResult(input, [], false)).toEqual([]);
	});
});

describe("per-plan state", () => {
	const score = (decision: "steer" | "block" | "none" | "suppressed_dedupe", question?: string) => ({
		ts: "2026-01-01T00:00:00.000Z",
		trigger: "turn_end" as const,
		ambiguity: 0.4,
		dims: dims(0.5, 0.5, 0.5, 0.5),
		weakest: "constraints" as const,
		gap: "non_goals",
		userCanAnswer: 0.8,
		decision,
		...(question ? { question } : {}),
	});

	beforeEach(() => {
		resetAmbiguitySession();
	});

	test("a new plan forgets asks, steered dimensions, propose blocks, the pending question and replies but keeps the score log", () => {
		recordAsk("Which surface?", "The CLI");
		markSteered("constraints");
		for (let i = 0; i < MAX_PROPOSE_BLOCKS; i++) noteProposeBlock();
		recordFollowUp("an early note");
		recordScore(score("steer", "What is out of scope?"));
		resetAmbiguityPlan();
		expect(asksObserved()).toBe(0);
		expect(hasSteered("constraints")).toBe(false);
		expect(getUserReplies()).toEqual([]);
		expect(proposeDecision({ ambiguity: 0.5, userCanAnswer: 0.9 }, GATE_CFG, true)).toBe("block");
		expect(recordFollowUp("late")).toBe(false);
		expect(getAmbiguityTelemetry().scores).toHaveLength(1);
	});

	test("a new session forgets the score log as well", () => {
		recordAsk("Which surface?", "The CLI");
		markSteered("goal");
		recordScore(score("steer"));
		resetAmbiguitySession();
		expect(getAmbiguityTelemetry()).toEqual({ scores: [], asksObserved: 0 });
		expect(hasSteered("goal")).toBe(false);
	});

	test("asks made during an earlier plan no longer disable the gate for the next one", () => {
		for (let i = 0; i < GATE_CFG.maxAsksPerPlan; i++) recordAsk(`q${i}`, "a");
		expect(asksObserved()).toBeGreaterThanOrEqual(GATE_CFG.maxAsksPerPlan);
		resetAmbiguityPlan();
		expect(asksObserved()).toBeLessThan(GATE_CFG.maxAsksPerPlan);
	});

	test("a user reply after a steer counts as the answer to the drafted question", () => {
		recordScore(score("steer", "What is explicitly out of scope?"));
		expect(recordFollowUp("  only the CLI  ")).toBe(true);
		expect(getAsks()).toEqual([{ question: "What is explicitly out of scope?", answer: "only the CLI" }]);
		expect(asksObserved()).toBe(1);
	});

	test("a block counts too, and each question takes one reply", () => {
		recordScore(score("block", "What is explicitly out of scope?"));
		expect(recordFollowUp("only the CLI")).toBe(true);
		expect(recordFollowUp("also the API")).toBe(false);
		expect(asksObserved()).toBe(1);
		recordScore(score("block", "What check proves it?"));
		expect(recordFollowUp("a unit test")).toBe(true);
		expect(asksObserved()).toBe(2);
	});

	test("the pending question survives scores that did not ask anything", () => {
		recordScore(score("steer", "What is explicitly out of scope?"));
		recordScore(score("suppressed_dedupe", "What is explicitly out of scope?"));
		recordScore(score("none"));
		expect(recordFollowUp("only the CLI")).toBe(true);
		expect(getAsks()).toEqual([{ question: "What is explicitly out of scope?", answer: "only the CLI" }]);
	});

	test("a newer steer replaces the pending question", () => {
		recordScore(score("steer", "What is out of scope?"));
		recordScore(score("block", "What check proves it?"));
		expect(recordFollowUp("a unit test")).toBe(true);
		expect(getAsks()[0].question).toBe("What check proves it?");
	});

	test("an ask result answers the pending question, so a later typed reply is only context", () => {
		recordScore(score("steer", "Which part?"));
		expect(recordAskResult({ questions: [{ id: "q", question: "Which part?" }] }, [{ type: "text", text: "q: importer" }], false, { question: "Which part?", selectedOptions: ["importer"] })).toBe(1);
		expect(recordFollowUp("also handle X")).toBe(false);
		expect(asksObserved()).toBe(1);
		expect(getUserReplies()).toEqual(["also handle X"]);
	});

	test("a cancelled ask leaves the question pending", () => {
		recordScore(score("steer", "Which part?"));
		expect(recordAskResult({ questions: [{ id: "q", question: "Which part?" }] }, [{ type: "text", text: "cancelled" }], true)).toBe(0);
		expect(recordFollowUp("the importer")).toBe(true);
	});

	test("a reply with no question pending is kept as context and spends no budget", () => {
		expect(recordFollowUp("hello")).toBe(false);
		recordScore(score("none", "What is explicitly out of scope?"));
		expect(recordFollowUp("again")).toBe(false);
		recordScore(score("suppressed_dedupe", "What is explicitly out of scope?"));
		expect(recordFollowUp("and again")).toBe(false);
		recordScore(score("steer"));
		expect(recordFollowUp("no question to answer")).toBe(false);
		expect(asksObserved()).toBe(0);
		expect(getUserReplies()).toEqual(["hello", "again", "and again", "no question to answer"]);
	});

	test("an empty reply is neither an answer nor context, and leaves the question pending", () => {
		recordScore(score("steer", "What is explicitly out of scope?"));
		expect(recordFollowUp("   ")).toBe(false);
		expect(getUserReplies()).toEqual([]);
		expect(recordFollowUp("only the CLI")).toBe(true);
	});

	test("kept replies are trimmed, capped in length and in number", () => {
		recordFollowUp(` ${"x".repeat(1000)} `);
		expect(getUserReplies()[0]).toHaveLength(400);
		for (let i = 0; i < 12; i++) recordFollowUp(`reply ${i}`);
		const kept = getUserReplies();
		expect(kept).toHaveLength(8);
		expect(kept.at(-1)).toBe("reply 11");
		expect(kept[0]).toBe("reply 4");
	});

	test("a new plan lets the next steer's reply count again", () => {
		recordScore(score("steer", "Q?"));
		expect(recordFollowUp("A")).toBe(true);
		resetAmbiguityPlan();
		recordScore(score("steer", "Q2?"));
		expect(recordFollowUp("A again")).toBe(true);
	});

	test("a question left pending by one plan is not answered by the next plan's first reply", () => {
		recordScore(score("steer", "Q?"));
		resetAmbiguityPlan();
		expect(recordFollowUp("A")).toBe(false);
	});
});

describe("telemetry", () => {
	beforeEach(() => {
		resetAmbiguitySession();
	});

	test("records scores and observed asks in the bench-log shape", () => {
		recordAsk("Which surface?", "The CLI");
		recordScore({
			ts: "2026-01-01T00:00:00.000Z",
			trigger: "propose",
			ambiguity: 0.31,
			dims: dims(0.5, 0.25, 1, 1),
			weakest: "constraints",
			gap: "non_goals",
			userCanAnswer: 0.8,
			decision: "would_block",
		});
		const telemetry = getAmbiguityTelemetry();
		expect(telemetry.asksObserved).toBe(1);
		expect(telemetry.scores).toHaveLength(1);
		expect(telemetry.scores[0]).toEqual({
			ts: "2026-01-01T00:00:00.000Z",
			trigger: "propose",
			ambiguity: 0.31,
			dims: { goal: 0.5, constraints: 0.25, criteria: 1, context: 1 },
			weakest: "constraints",
			gap: "non_goals",
			userCanAnswer: 0.8,
			decision: "would_block",
		});
	});

	test("suppressed and would-have decisions are logged as their own values", () => {
		const base = {
			ts: "2026-01-01T00:00:00.000Z",
			trigger: "turn_end" as const,
			ambiguity: 0.4,
			dims: dims(0.5, 0.5, 0.5, 0.5),
			weakest: "goal" as const,
			gap: "none",
			userCanAnswer: 0.9,
		};
		for (const decision of ["suppressed_dedupe", "suppressed_immune", "would_steer"] as const) recordScore({ ...base, decision });
		expect(getAmbiguityTelemetry().scores.map((s) => s.decision)).toEqual(["suppressed_dedupe", "suppressed_immune", "would_steer"]);
	});

	test("a fresh session starts empty", () => {
		expect(getAmbiguityTelemetry()).toEqual({ scores: [], asksObserved: 0 });
	});
});

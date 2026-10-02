import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "./limits";

/**
 * Wiring tests for src/index.ts: the real extension factory is driven through a fake ExtensionAPI, in the
 * order omp really delivers events (at before_agent_start the current prompt is not in the branch yet, and
 * plan state comes from mode_change entries). Only the TypeSafe client is mocked, so nothing touches the
 * network; git is a scripted pi.exec.
 *
 * bun applies mock.module to every test file in the run, and a module that another file already mocked keeps
 * that file's export names, so an importer that needs more names fails to link. These tests therefore run a
 * private copy of src/: its client.ts is a path nobody else mocks, and its module state (config, reviewer
 * budgets, ambiguity asks) cannot leak into, or be disturbed by, the other test files.
 */

interface AskCall {
	state: any;
	questions: Record<string, any>;
	opts: Record<string, any>;
}
type Answers = Record<string, { type: string; [key: string]: unknown }>;

const mockState = {
	apiKey: true,
	calls: [] as AskCall[],
	respond: (_call: AskCall): Answers | Promise<Answers> => ({}),
	clientError: null as string | null,
	resets: 0,
	logger: undefined as unknown,
};

const root = mkdtempSync(join(tmpdir(), "omp-typesafe-index-"));
const srcCopy = join(root, "src");
cpSync(join(import.meta.dir, "..", "src"), srcCopy, { recursive: true });

const clientMock = () => ({
	apiKeyPresent: () => mockState.apiKey,
	ask: async (state: any, questions: Record<string, any>, opts: Record<string, any> = {}) => {
		const call: AskCall = { state, questions, opts };
		mockState.calls.push(call);
		const answers = await mockState.respond(call);
		return { result: { model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 } }, requestId: "req-1" };
	},
	describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
	noul: (instructions: string, opts?: Record<string, unknown>) => ({ type: "noul", instructions, ...opts }),
	choice: (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions, criteria }),
	score: (instructions: string, levels: readonly string[]) => ({ type: "score", instructions, levels: [...levels] }),
	estimateCostUsd: () => 0.25,
	getLastResolvedModel: () => (mockState.calls.length > 0 ? "jev-test" : null),
	getSessionUsage: () => ({ requests: mockState.calls.length, inputTokens: mockState.calls.length * 10, outputTokens: 0 }),
	getClientError: () => mockState.clientError,
	resetClient: () => {
		mockState.resets += 1;
	},
	resetUsage: () => {},
	setClientLogger: (logger: unknown) => {
		mockState.logger = logger;
	},
});
mock.module(join(srcCopy, "client.ts"), clientMock);

const { default: typesafeExtension } = (await import(join(srcCopy, "index.ts"))) as typeof import("../src/index");
const reviewer = (await import(join(srcCopy, "reviewer.ts"))) as typeof import("../src/reviewer");
const ambiguity = (await import(join(srcCopy, "ambiguity.ts"))) as typeof import("../src/ambiguity");
const subagentModule = (await import(join(srcCopy, "subagent.ts"))) as typeof import("../src/subagent");

const agent = join(root, "agent");
const cfgPath = join(root, "typesafe.json");
const workDir = join(root, "work");
const ENV_KEYS = [
	"TYPESAFE_CONFIG",
	"TYPESAFE_API_KEY",
	"TYPESAFE_ROLE",
	"TYPESAFE_REVIEW_ENABLED",
	"TYPESAFE_AMBIGUITY_GATE",
	"TYPESAFE_AMBIGUITY_THRESHOLD",
	"TYPESAFE_DEFAULT_MODEL",
	"TYPESAFE_BENCH_LOG",
	"TYPESAFE_SUBAGENT_GUARD",
	"PI_CODING_AGENT_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	mkdirSync(agent, { recursive: true });
	mkdirSync(workDir, { recursive: true });
	process.env.TYPESAFE_CONFIG = cfgPath;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.TYPESAFE_API_KEY = "test-key";
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	subagentModule.resetSubagentStats();
	mockState.apiKey = true;
	mockState.calls = [];
	mockState.clientError = null;
	mockState.resets = 0;
	mockState.logger = undefined;
	mockState.respond = (call) => {
		if ("goal_clarity" in call.questions) return replies.gate;
		if ("verified" in call.questions) return replies.stop;
		if ("severity" in call.questions) return replies.review;
		return replies.other;
	};
	replies.gate = {};
	replies.review = {};
	replies.stop = {};
	replies.other = {};
});

afterEach(() => {
	process.env.PI_CODING_AGENT_DIR = agent;
	delete process.env.TYPESAFE_BENCH_LOG;
	delete process.env.TYPESAFE_ROLE;
	delete process.env.TYPESAFE_SUBAGENT_GUARD;
});

const replies: { gate: Answers; review: Answers; stop: Answers; other: Answers } = { gate: {}, review: {}, stop: {}, other: {} };

// ---- fake host -----------------------------------------------------------------

const schema: any = { optional: () => schema };
const zod = { object: () => schema, string: () => schema, enum: () => schema, array: () => schema, record: () => schema };

interface Harness {
	/** Fires `event` at every handler registered for it; `ctx` is the session's own unless another (a subagent's) is given. */
	fire(event: string, payload?: Record<string, unknown>, ctx?: Record<string, any>): Promise<any>;
	start(): Promise<void>;
	command(name: string, args: string): Promise<void>;
	branch: unknown[];
	ctx: Record<string, any>;
	sent: { message: any; options: any }[];
	notices: { message: string; level: string | undefined }[];
	warns: string[];
	execCalls: string[][];
	labels: string[];
	commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }>;
	tools: Record<string, any>;
	exec: (cmd: string, args: string[], opts?: any) => Promise<unknown>;
	activeTools: string[];
	sendThrows: boolean;
	pi: any;
}

interface SetupOptions {
	hasUI?: boolean;
	/** null: the host predates pi.getActiveTools. */
	activeTools?: string[] | null;
	cwd?: string;
	sessionId?: string;
	/** The extension factory to run; a second copy of index.ts stands in for an isolated agent's fresh module. */
	factory?: typeof typesafeExtension;
}

function setup(cfg: object = {}, branch: unknown[] = [], options: SetupOptions = {}): Harness {
	writeFileSync(cfgPath, JSON.stringify(cfg));
	const handlers: Record<string, ((event: any, ctx: any) => unknown)[]> = {};
	const hasUI = options.hasUI ?? false;
	const h: Harness = {
		branch,
		sent: [],
		notices: [],
		warns: [],
		execCalls: [],
		labels: [],
		commands: {},
		tools: {},
		activeTools: options.activeTools ?? (hasUI ? ["ask", "write", "edit", "bash"] : ["write", "edit", "bash"]),
		sendThrows: false,
		exec: async () => ({ code: 128, stdout: "" }),
		ctx: {},
		pi: undefined,
		fire: async () => undefined,
		start: async () => {},
		command: async () => {},
	};
	h.ctx = {
		cwd: options.cwd ?? workDir,
		hasUI,
		isIdle: () => false,
		ui: { notify: (message: string, level?: string) => h.notices.push({ message, level }) },
		sessionManager: { getBranch: () => h.branch, getSessionId: () => options.sessionId ?? "sess-1" },
	};
	const pi: any = {
		logger: { debug() {}, info() {}, warn: (...a: unknown[]) => h.warns.push(a.join(" ")), error() {} },
		zod,
		setLabel: (label: string) => h.labels.push(label),
		on: (event: string, handler: (event: any, ctx: any) => unknown) => (handlers[event] ??= []).push(handler),
		registerTool: (tool: any) => {
			h.tools[tool.name] = tool;
		},
		registerCommand: (name: string, command: any) => {
			h.commands[name] = command;
		},
		sendMessage: (message: unknown, sendOptions: unknown) => {
			if (h.sendThrows) throw new Error("host rejected");
			h.sent.push({ message, options: sendOptions });
		},
		exec: (cmd: string, args: string[], execOptions?: unknown) => {
			h.execCalls.push(args);
			return h.exec(cmd, args, execOptions);
		},
	};
	if (options.activeTools !== null) pi.getActiveTools = () => h.activeTools;
	h.pi = pi;
	(options.factory ?? typesafeExtension)(pi);
	h.fire = async (event, payload = {}, ctx = h.ctx) => {
		let result: unknown;
		for (const handler of handlers[event] ?? []) {
			const out = await handler({ type: event, ...payload }, ctx);
			if (out !== undefined) result = out;
		}
		return result;
	};
	h.start = async () => {
		await h.fire("session_start");
	};
	h.command = (name, args) => h.commands[name].handler(args, h.ctx);
	return h;
}

// ---- entries and answers -------------------------------------------------------

const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const asstMsg = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const modeChange = (mode: string) => ({ type: "mode_change", mode });
const marker = (customType: string) => ({ type: "custom_message", customType, content: "" });
const planMode = () => modeChange("plan");

function reviewAnswers(
	kind: "action" | "message" | "turn",
	role: "adversarial" | "advisory",
	severity: number,
	nouls: Record<string, number> = {},
	failed = false,
): Answers {
	const battery = reviewer.buildBattery(kind, role, { failed });
	const answers: Answers = { severity: { type: "score", score: severity, confidence: 0.9 } };
	for (const id of battery.noulIds) answers[id] = { type: "noul", noul: nouls[id] ?? 0 };
	answers[battery.defectKey] = { type: "choice", choice: "none", confidence: 0.9 };
	return answers;
}

/** Ambiguity answers: every dimension scored `score` of 4, so ambiguity is 1 - score/4. */
function gateAnswers(score = 0.5, userCanAnswer = 0.9): Answers {
	const answers: Answers = {};
	for (const dim of ["goal", "constraints", "criteria", "context"]) answers[`${dim}_clarity`] = { type: "score", score };
	for (const dim of ["goal", "constraints", "criteria"]) {
		answers[`user_can_answer_${dim}`] = { type: "noul", noul: userCanAnswer };
		answers[`gap_${dim}`] = { type: "choice", choice: "none", confidence: 0.9 };
	}
	return answers;
}

const reviewCalls = () => mockState.calls.filter((c) => "severity" in c.questions);
const gateCalls = () => mockState.calls.filter((c) => "goal_clarity" in c.questions);
const scores = () => ambiguity.getAmbiguityTelemetry().scores;

async function toolResult(
	h: Harness,
	toolName: string,
	id: string,
	input: unknown,
	text = "ok",
	extra: Record<string, unknown> = {},
): Promise<any> {
	return h.fire("tool_result", { toolName, toolCallId: id, input, content: [{ type: "text", text }], isError: false, ...extra });
}

// ---- scripted git --------------------------------------------------------------

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const REMOVED_NAME_DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export function fetchUser() {}\n+export function getUser() {}\n";

/** The git subcommand of a pi.exec call, past the pinned `--no-optional-locks -c k=v ...` prefix. */
function subcommand(args: string[]): string {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-c") i += 1;
		else if (!args[i].startsWith("-")) return args[i];
	}
	return "";
}

function repoGit(head: () => string = () => HEAD) {
	return async (_cmd: string, args: string[]): Promise<unknown> => {
		switch (subcommand(args)) {
			case "rev-parse":
				return args.includes("--show-toplevel") && args.includes("--show-prefix")
					? { code: 0, stdout: "/repo\n\n" }
					: args.includes("--show-toplevel")
						? { code: 0, stdout: "/repo\n" }
						: { code: 0, stdout: `${head()}\n` };
			case "status":
				return { code: 0, stdout: " M src/a.ts\0" };
			case "ls-files":
				return { code: 0, stdout: "src/a.ts\0README.md\0" };
			case "diff":
				if (args.includes("--stat")) return { code: 0, stdout: " src/a.ts | 2 +-\n" };
				if (args.includes("--name-only")) return { code: 0, stdout: "src/a.ts\0" };
				return { code: 0, stdout: REMOVED_NAME_DIFF };
			case "grep":
				return { code: 0, stdout: "src/b.ts:3:fetchUser()\n" };
			default:
				return { code: 1, stdout: "" };
		}
	};
}

const gitCalls = (h: Harness, sub: string) => h.execCalls.filter((args) => subcommand(args) === sub);

// ---- session lifecycle -----------------------------------------------------------

describe("session reset", () => {
	test.each(["new", "resume", "fork"])("session_switch (%s) forgets the previous session's dedupe, overrides and plan state", async (reason) => {
		const h = setup({}, [userMsg("refactor x")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 1.7, { breaks_contract: 0.9 });
		await toolResult(h, "edit", "c1", { path: "a.ts" });
		await toolResult(h, "edit", "c2", { path: "a.ts" });
		expect(reviewer.getLastReviewRecord()?.reason).toBe("duplicate");
		await h.command("adversary", "off");
		await h.command("adversary", "role advisory");

		h.branch = [userMsg("brand new task")];
		await h.fire("session_switch", { reason });
		await h.fire("turn_start", { turnIndex: 0 });
		expect(reviewer.getReviewStats().delivered.concern).toBe(0);
		expect(h.labels.at(-1)).toBe("TypeSafe Adversary");
		replies.review = reviewAnswers("action", "adversarial", 1.7, { breaks_contract: 0.9 });
		await toolResult(h, "edit", "c3", { path: "a.ts" });
		expect(reviewer.getLastReviewRecord()?.decision).toBe("delivered_inline");
		expect(reviewer.getLastReviewRecord()?.role).toBe("adversarial");
	});

	test("session_switch resets the stop gate's use cap and the client", async () => {
		const h = setup({ stopGate: { enabled: true } }, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		const resetsAtStart = mockState.resets;
		replies.stop = { verified: { type: "noul", noul: 0.05 }, left_unfinished: { type: "noul", noul: 0.9 } };
		expect((await h.fire("session_stop"))?.continue).toBe(true);
		expect((await h.fire("session_stop"))?.continue).toBe(true);
		expect(await h.fire("session_stop")).toBeUndefined();
		await h.fire("session_switch", { reason: "new" });
		expect(mockState.resets).toBe(resetsAtStart + 1);
		expect((await h.fire("session_stop"))?.continue).toBe(true);
	});

	test("session_switch reloads config and the priorities of the new cwd", async () => {
		const dirA = join(root, "proj-a");
		const dirB = join(root, "proj-b");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		writeFileSync(join(dirA, "ADVERSARY.md"), "A-PRIORITIES");
		writeFileSync(join(dirB, "WATCHDOG.md"), "B-PRIORITIES");
		const h = setup({}, [userMsg("go")], { cwd: dirA });
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "a.ts" });
		expect(reviewCalls().at(-1)?.state.review_priorities).toContain("A-PRIORITIES");

		writeFileSync(cfgPath, JSON.stringify({ role: "advisory" }));
		h.ctx.cwd = dirB;
		await h.fire("session_switch", { reason: "resume" });
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c2", { path: "a.ts" });
		const call = reviewCalls().at(-1);
		expect(call?.state.review_priorities).toContain("B-PRIORITIES");
		expect("on_track" in (call?.questions ?? {})).toBe(true);
		expect(h.labels.at(-1)).toBe("TypeSafe Advisor");
	});

	test("session_switch drops the previous session's asks and steered dimensions", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		expect((await h.fire("before_agent_start", { prompt: "Make it better" }))?.message).toBeDefined();
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Which db?" }] }, "q: pg", { details: { question: "Which db?", selectedOptions: ["pg"] } });
		expect(ambiguity.asksObserved()).toBe(1);

		h.branch = [planMode()];
		await h.fire("session_switch", { reason: "new" });
		expect(ambiguity.asksObserved()).toBe(0);
		expect(ambiguity.hasSteered("goal")).toBe(false);
		const again = await h.fire("before_agent_start", { prompt: "Make it faster" });
		expect(again?.message).toBeDefined();
	});

	test("session_start points the SDK logger at omp's and surfaces config warnings as warnings", async () => {
		const h = setup({ adversary: { concern_severity: 2.9, blocker_severity: 1 } }, [], { hasUI: true });
		await h.start();
		expect(mockState.logger).toBe(h.pi.logger);
		const warnings = h.notices.filter((n) => n.level === "warning");
		expect(warnings.some((n) => n.message.includes("concern_severity"))).toBe(true);
	});

	test("a missing API key is announced once at start, as a warning", async () => {
		const h = setup({}, [], { hasUI: true });
		mockState.apiKey = false;
		await h.start();
		expect(h.notices).toContainEqual({ message: "TypeSafe adversary inactive: TYPESAFE_API_KEY not set", level: "warning" });
		const before = h.notices.length;
		await h.fire("session_switch", { reason: "new" });
		expect(h.notices.filter((n) => n.message.includes("TYPESAFE_API_KEY")).length).toBe(1);
		expect(h.notices.length).toBe(before);
	});

	test("session_tree moves the turn cursor so the next turn is reviewed", async () => {
		const long = Array.from({ length: 40 }, (_, i) => asstMsg(`earlier ${i}`));
		const h = setup({}, long);
		await h.start();
		h.branch.length = 0;
		h.branch.push(...long.slice(0, 10));
		await h.fire("session_tree", { newLeafId: "x", oldLeafId: "y" });
		await h.fire("turn_start", { turnIndex: 0 });
		h.branch.push(asstMsg("After navigating the tree I changed the retry logic."), userMsg("ok"));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(reviewCalls().length).toBe(1);
		expect(reviewCalls()[0].state.delta).toContain("After navigating the tree");
	});

	// A different branch can hold another plan that starts at the very same index, so the index alone cannot tell them apart.
	test.each(["session_tree", "session_branch"])("%s drops the plan's identity: the other branch's plan is scored fresh", async (event) => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Plan the rate limiter" });
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Scope?" }] }, "q: all", { details: { question: "Scope?", selectedOptions: ["all"] } });
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.hasSteered("goal")).toBe(true);

		h.branch.length = 0;
		h.branch.push(planMode()); // another branch, its plan starts at the same index
		await h.fire(event, { newLeafId: "x", oldLeafId: "y" });
		const out = await h.fire("before_agent_start", { prompt: "Plan the importer instead" });
		expect(gateCalls().length).toBe(2);
		expect(gateCalls()[1].state.task).toBe("Plan the importer instead");
		expect(gateCalls()[1].state.answers_received).toEqual([]);
		expect(ambiguity.asksObserved()).toBe(0);
		expect(out?.message).toBeDefined();
	});

	// omp's entries carry ids, so the plan's first entry says whether a navigation landed on the same plan.
	test.each(["session_tree", "session_branch"])("%s on the same plan keeps its asks, steers and scoring; another plan's entry id drops them", async (event) => {
		const planEntry = (id: string) => ({ id, type: "mode_change", mode: "plan" });
		const h = setup({}, [{ id: "e0", type: "message", message: { role: "user", content: [{ type: "text", text: "earlier work" }] } }, planEntry("e1")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Plan the rate limiter" });
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Scope?" }] }, "q: all", { details: { question: "Scope?", selectedOptions: ["all"] } });
		expect(gateCalls().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.hasSteered("goal")).toBe(true);

		// Navigating within the same plan (its start entry is still e1) changes nothing about the plan.
		h.branch.push({ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "drafting" }] } });
		await h.fire(event, { newLeafId: "e2", oldLeafId: "e2" });
		const same = await h.fire("before_agent_start", { prompt: "B" });
		expect(gateCalls().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.hasSteered("goal")).toBe(true);
		expect(same).toBeUndefined();

		// Another branch whose plan began at the very same index, with a different entry, is another plan.
		h.branch.length = 0;
		h.branch.push({ id: "e0", type: "message", message: { role: "user", content: [{ type: "text", text: "earlier work" }] } }, planEntry("f1"));
		await h.fire(event, { newLeafId: "f1", oldLeafId: "e2" });
		const other = await h.fire("before_agent_start", { prompt: "Plan the importer instead" });
		expect(gateCalls().length).toBe(2);
		expect(gateCalls()[1].state.task).toBe("Plan the importer instead");
		expect(ambiguity.asksObserved()).toBe(0);
		expect(other?.message).toBeDefined();
	});

	// /branch and /tree make siblings under one entry: the plan's start entry is the same, only its objective differs.
	test.each(["session_tree", "session_branch"])("%s onto a sibling branch with another first prompt is another plan, however the prompt arrives", async (event) => {
		const entry = (id: string, role: string, text: string) => ({ id, type: "message", message: { role, content: [{ type: "text", text }] } });
		const planEntry = { id: "e1", type: "mode_change", mode: "plan" };
		const h = setup({}, [entry("e0", "user", "earlier work"), planEntry], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Plan the rate limiter" });
		h.branch.push(entry("e2", "user", "Plan the rate limiter"));
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Scope?" }] }, "q: all", { details: { question: "Scope?", selectedOptions: ["all"] } });
		expect(gateCalls().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);

		// Reworded from e2: the new first prompt e3 hangs under the very same plan-start entry e1.
		h.branch.length = 0;
		h.branch.push(entry("e0", "user", "earlier work"), planEntry, entry("e3", "user", "Plan the importer instead"));
		await h.fire(event, { newLeafId: "e3", oldLeafId: "e2" });
		const out = await h.fire("before_agent_start", { prompt: "Plan the importer instead" });
		expect(gateCalls().length).toBe(2);
		expect(gateCalls()[1].state.task).toBe("Plan the importer instead");
		expect(gateCalls()[1].state.answers_received).toEqual([]);
		expect(ambiguity.asksObserved()).toBe(0);
		expect(ambiguity.hasSteered("goal")).toBe(true); // the new plan's own steer
		expect(out?.message).toBeDefined();

		// The same, when the new prompt is not in the branch yet at before_agent_start (it is only the event's prompt).
		replies.gate = gateAnswers();
		await toolResult(h, "ask", "a2", { questions: [{ id: "q", question: "Scope?" }] }, "q: all", { details: { question: "Scope?", selectedOptions: ["all"] } });
		expect(ambiguity.asksObserved()).toBe(1);
		h.branch.length = 0;
		h.branch.push(entry("e0", "user", "earlier work"), planEntry);
		await h.fire(event, { newLeafId: "e1", oldLeafId: "e3" });
		await h.fire("before_agent_start", { prompt: "Plan the exporter" });
		expect(gateCalls().length).toBe(3);
		expect(gateCalls()[2].state.task).toBe("Plan the exporter");
		expect(ambiguity.asksObserved()).toBe(0);
	});

	// before_agent_start records the prompt from the event; if the turn dies before the user message is persisted, no
	// entry id ties that state to the plan, and a sibling under the same plan-start entry looks just like it.
	test.each(["session_tree", "session_branch"])("%s after a prompt that never reached the branch drops the plan's state", async (event) => {
		const entry = (id: string, role: string, text: string) => ({ id, type: "message", message: { role, content: [{ type: "text", text }] } });
		const planEntry = { id: "e1", type: "mode_change", mode: "plan" };
		const h = setup({}, [planEntry], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Plan the rate limiter" });
		expect(gateCalls().length).toBe(1);
		// Esc during pre-prompt compaction: nothing was persisted. The user then moves to a sibling under the same start entry.
		h.branch.length = 0;
		h.branch.push(planEntry, entry("e3", "user", "Plan the importer instead"));
		await h.fire(event, { newLeafId: "e3", oldLeafId: "e1" });
		const out = await h.fire("before_agent_start", { prompt: "Plan the importer instead" });
		expect(gateCalls().length).toBe(2);
		expect(gateCalls()[1].state.task).toBe("Plan the importer instead");
		expect(out?.message).toBeDefined();
	});

	test("the plan's first prompt arriving, or a follow-up after it, is not a different plan", async () => {
		const entry = (id: string, role: string, text: string) => ({ id, type: "message", message: { role, content: [{ type: "text", text }] } });
		const h = setup({}, [{ id: "e0", type: "mode_change", mode: "plan" }], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Plan the rate limiter" });
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Scope?" }] }, "q: all", { details: { question: "Scope?", selectedOptions: ["all"] } });
		// The prompt lands in the branch, then the assistant, then a reply: the first user message stays the objective.
		h.branch.push(entry("e1", "user", "Plan the rate limiter"), entry("e2", "assistant", "Which scope?"), entry("e3", "user", "B"));
		await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "B" }] } });
		await h.fire("before_agent_start", { prompt: "C" });
		expect(gateCalls().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.hasSteered("goal")).toBe(true);
	});

	test("without a branch switch the same plan keeps its objective and asks", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Plan the rate limiter" });
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Scope?" }] }, "q: all", { details: { question: "Scope?", selectedOptions: ["all"] } });
		h.branch.push(userMsg("Plan the rate limiter"));
		await h.fire("before_agent_start", { prompt: "Plan the importer instead" });
		expect(gateCalls().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);
	});
});

// ---- plan mode -------------------------------------------------------------------

describe("plan-mode detection", () => {
	test("phases [execute] skips reviews while planning, however long the plan runs", async () => {
		const filler = Array.from({ length: 150 }, (_, i) => asstMsg(`planning step ${i}`));
		const h = setup({ phases: ["execute"] }, [userMsg("plan it"), planMode(), ...filler]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: "ls" });
		expect(reviewCalls().length).toBe(0);
	});

	test("plan-mode-reference after approval means execution: reviews run and a blocker steers", async () => {
		const h = setup({ phases: ["execute"] }, [userMsg("plan it"), planMode(), asstMsg("plan"), marker("plan-mode-reference")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 });
		await toolResult(h, "bash", "c1", { command: "rm -rf src" });
		expect(reviewCalls().length).toBe(1);
		expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	test("a mode_change back to none ends plan mode", async () => {
		const h = setup({ phases: ["plan"] }, [userMsg("plan it"), planMode(), modeChange("none")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: "ls" });
		expect(reviewCalls().length).toBe(0);
		h.branch.push(planMode());
		await toolResult(h, "bash", "c2", { command: "ls" });
		expect(reviewCalls().length).toBe(1);
	});

	test("plan-mode blockers are only ever asides", async () => {
		const h = setup({}, [userMsg("plan it"), planMode()]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 });
		await toolResult(h, "bash", "c1", { command: "rm -rf src" });
		expect(h.sent[0].options).toEqual({ deliverAs: "aside" });
	});
});

describe("plan_start scoring", () => {
	test("the first prompt of a fresh plan is scored from mode_change alone and its note rides the request", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		const out = await h.fire("before_agent_start", { prompt: "Make the importer better" });
		expect(gateCalls().length).toBe(1);
		expect(gateCalls()[0].state.task).toBe("Make the importer better");
		expect(out.message.customType).toBe("ai.typesafe.ambiguity");
		expect(out.message.display).toBe(true);
		expect(out.message.attribution).toBe("agent");
		expect(out.message.content).toContain("ask tool");
		expect(h.sent.length).toBe(0);
		expect(scores()[0]).toMatchObject({ trigger: "plan_start", decision: "steer" });
		expect(scores()[0].question).toBeTruthy();
	});

	test("unread code does not push a crisp prompt over the threshold at plan_start, though it counts at turn_end", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		const answers = gateAnswers(3.4, 0.9); // user dimensions 0.85 clear
		answers.context_clarity = { type: "score", score: 0 };
		replies.gate = answers;
		expect(await h.fire("before_agent_start", { prompt: "Add per-IP rate limiting to the public /api routes" })).toBeUndefined();
		expect(scores().at(-1)).toMatchObject({ trigger: "plan_start", decision: "none" });
		expect(scores().at(-1)!.ambiguity).toBeCloseTo(0.15, 5);
		expect(scores().at(-1)!.dims.context).toBe(0);
		h.branch.push(asstMsg("reading nothing yet"));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(scores().at(-1)).toMatchObject({ trigger: "turn_end" });
		expect(scores().at(-1)!.ambiguity).toBeCloseTo(1 - 0.85 * 0.85, 5);
	});

	test("nothing is scored outside plan mode", async () => {
		const h = setup({}, [userMsg("hello")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		expect(await h.fire("before_agent_start", { prompt: "hello" })).toBeUndefined();
		expect(gateCalls().length).toBe(0);
	});

	test("--plan-yolo writes no marker before the first prompt, so the first turn_end evaluation is plan_start", async () => {
		const h = setup({}, [userMsg("Make it better")], { hasUI: false });
		await h.start();
		replies.gate = gateAnswers();
		expect(await h.fire("before_agent_start", { prompt: "Make it better" })).toBeUndefined();
		expect(gateCalls().length).toBe(0);

		h.branch.push(marker("plan-mode-context"), asstMsg("Here is a plan."));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		await h.fire("turn_end", { turnIndex: 1, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(scores().map((s) => s.trigger)).toEqual(["plan_start", "turn_end"]);
		expect(gateCalls()[0].state.task).toBe("Make it better");
	});

	test("a failed plan_start score is retried by the first turn_end instead of being marked done", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		mockState.respond = (call) => {
			if ("goal_clarity" in call.questions) throw new Error("jev down");
			return {};
		};
		await h.fire("before_agent_start", { prompt: "Make it better" });
		expect(scores().length).toBe(0);
		mockState.respond = (call) => ("goal_clarity" in call.questions ? gateAnswers() : {});
		h.branch.push(asstMsg("a plan"));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(scores().map((s) => s.trigger)).toEqual(["plan_start"]);
	});

	test("with no ask tool the gate records would_steer and sends nothing", async () => {
		const h = setup({}, [planMode()], { hasUI: false });
		await h.start();
		replies.gate = gateAnswers();
		const out = await h.fire("before_agent_start", { prompt: "Make it better" });
		expect(out).toBeUndefined();
		expect(h.sent.length).toBe(0);
		expect(scores()[0].decision).toBe("would_steer");
		h.branch.push(asstMsg("a plan"));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(h.sent.length).toBe(0);
		expect(scores().at(-1)?.decision).toBe("would_steer");
	});

	test("without pi.getActiveTools the gate falls back to whether a UI exists", async () => {
		const withUi = setup({}, [planMode()], { hasUI: true, activeTools: null });
		await withUi.start();
		replies.gate = gateAnswers();
		expect((await withUi.fire("before_agent_start", { prompt: "Make it better" }))?.message).toBeDefined();
		const headless = setup({}, [planMode()], { hasUI: false, activeTools: null });
		await headless.start();
		expect(await headless.fire("before_agent_start", { prompt: "Make it better" })).toBeUndefined();
		expect(scores().at(-1)?.decision).toBe("would_steer");
	});
});

describe("per-plan gate state", () => {
	test("a second plan in the same session is scored again with fresh asks and steer dedupe", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		expect((await h.fire("before_agent_start", { prompt: "Plan the rate limiter" }))?.message).toBeDefined();
		for (let i = 0; i < 3; i++) {
			await toolResult(h, "ask", `a${i}`, { questions: [{ id: "q", question: `Question ${i}?` }] }, "q: x", { details: { question: `Question ${i}?`, selectedOptions: ["x"] } });
		}
		expect(ambiguity.asksObserved()).toBe(3);
		expect(ambiguity.hasSteered("goal")).toBe(true);

		h.branch.push(modeChange("none"), modeChange("plan"));
		const second = await h.fire("before_agent_start", { prompt: "Now plan a totally different feature" });
		expect(gateCalls().length).toBe(2);
		expect(gateCalls()[1].state.task).toBe("Now plan a totally different feature");
		expect(second?.message).toBeDefined();
		expect(ambiguity.asksObserved()).toBe(0);
		expect(scores().map((s) => s.trigger)).toEqual(["plan_start", "plan_start"]);
	});

	test("later prompts are answers, not a new task, and a typed reply spends the ask budget", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Add per-tenant rate limiting to the /v1/orders API" });
		h.branch.push(asstMsg("Which limit do you want?"));
		await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "Add per-tenant rate limiting to the /v1/orders API" }] } });
		expect(ambiguity.asksObserved()).toBe(0);

		await h.fire("before_agent_start", { prompt: "B" });
		await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "B" }] } });
		expect(ambiguity.asksObserved()).toBe(1);
		h.branch.push(asstMsg("Thanks, drafting."));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		const last = gateCalls().at(-1)!;
		expect(last.state.task).toBe("Add per-tenant rate limiting to the /v1/orders API");
		expect(last.state.answers_received).toEqual(["B"]);
	});

	const userEvt = (text: string) => ({ message: { role: "user", content: [{ type: "text", text }] } });
	const turnEnd = (h: Harness, i = 0) => h.fire("turn_end", { turnIndex: i, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
	const ctxMsg = marker("plan-mode-context");

	test("a typed answer still pairs with the steer's question after a turn_end rescore in between", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		expect((await h.fire("before_agent_start", { prompt: "Make the importer better" }))?.message).toBeDefined();
		h.branch.push(ctxMsg, userMsg("Make the importer better"));
		await h.fire("message_end", userEvt("Make the importer better"));
		h.branch.push(asstMsg("Do you mean faster or more reliable?"));
		await turnEnd(h);
		expect(scores().map((s) => s.decision)).toEqual(["steer", "suppressed_dedupe"]);

		await h.fire("before_agent_start", { prompt: "faster, under 2s for 10k rows" });
		h.branch.push(ctxMsg, userMsg("faster, under 2s for 10k rows"));
		await h.fire("message_end", userEvt("faster, under 2s for 10k rows"));
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.getAsks()[0].answer).toBe("faster, under 2s for 10k rows");
		h.branch.push(asstMsg("Thanks, drafting."));
		await turnEnd(h, 1);
		expect(gateCalls().at(-1)!.state.answers_received).toEqual(["faster, under 2s for 10k rows"]);
	});

	// omp builds event.prompt by joining a message's text blocks with "", the branch joins them with "\n".
	test("the plan's own prompt is not an answer when its text blocks make it differ from event.prompt", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		expect((await h.fire("before_agent_start", { prompt: "Make it betterplease" }))?.message).toBeDefined();
		await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "Make it better" }, { type: "text", text: "please" }] } });
		expect(ambiguity.asksObserved()).toBe(0);
		expect(ambiguity.getAsks()).toEqual([]);
		expect(ambiguity.getUserReplies()).toEqual([]);

		// The next user message is a reply, whatever it says.
		await h.fire("before_agent_start", { prompt: "the importer" });
		await h.fire("message_end", userEvt("the importer"));
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.getAsks()[0].answer).toBe("the importer");
	});

	test("a first prompt that never reached its message_end does not swallow the next reply", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Make it better" });
		await h.fire("before_agent_start", { prompt: "the importer" });
		await h.fire("message_end", userEvt("the importer"));
		expect(ambiguity.asksObserved()).toBe(1);
	});

	test("a reply that answers no gate question reaches the gate as user_replies and spends no ask budget", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers(4, 0.9); // clear enough: the gate stays quiet
		await h.fire("before_agent_start", { prompt: "Add per-tenant rate limiting to the /v1/orders API" });
		expect(scores().at(-1)?.decision).toBe("none");
		h.branch.push(ctxMsg, userMsg("Add per-tenant rate limiting to the /v1/orders API"), asstMsg("Should the limit be per minute or per hour?"));
		await h.fire("message_end", userEvt("Add per-tenant rate limiting to the /v1/orders API"));
		await h.fire("before_agent_start", { prompt: "per minute, 100 requests, only /v1/orders" });
		h.branch.push(ctxMsg, userMsg("per minute, 100 requests, only /v1/orders"));
		await h.fire("message_end", userEvt("per minute, 100 requests, only /v1/orders"));
		expect(ambiguity.asksObserved()).toBe(0);
		h.branch.push(asstMsg("Drafting the plan"));
		replies.gate = gateAnswers(1, 0.9);
		await turnEnd(h);
		const state = gateCalls().at(-1)!.state;
		expect(state.task).toContain("per-tenant rate limiting");
		expect(state.user_replies).toEqual(["per minute, 100 requests, only /v1/orders"]);
		expect(state.answers_received).toEqual([]);
	});

	test("an ask tool answer settles the pending question; text typed after it is context, not a second answer", async () => {
		const h = setup({}, [planMode(), ctxMsg, userMsg("Make it better")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("message_end", userEvt("Make it better"));
		h.branch.push(asstMsg("drafting"));
		await turnEnd(h);
		expect(scores().at(-1)?.decision).toBe("steer");
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Which part?" }] }, "q: importer", { details: { question: "Which part?", selectedOptions: ["importer"] } });
		expect(ambiguity.asksObserved()).toBe(1);
		h.branch.push(ctxMsg, userMsg("also handle X"));
		await h.fire("message_end", userEvt("also handle X"));
		expect(ambiguity.asksObserved()).toBe(1);
		await turnEnd(h, 1);
		expect(gateCalls().at(-1)!.state.user_replies).toEqual(["also handle X"]);
	});

	test("--plan-yolo: a prompt first seen before plan mode was detected stays the task when a short reply arrives", async () => {
		const h = setup({}, [userMsg("Make the importer better")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("message_end", userEvt("Make the importer better")); // no plan marker yet: not counted
		h.branch.push(ctxMsg, asstMsg("Faster or more reliable?"));
		await turnEnd(h);
		expect(scores().at(-1)).toMatchObject({ trigger: "plan_start", decision: "steer" });
		h.branch.push(userMsg("B"));
		await h.fire("message_end", userEvt("B"));
		expect(ambiguity.getAsks()).toEqual([{ question: scores().at(-1)!.question!, answer: "B" }]);
		h.branch.push(asstMsg("ok"));
		await turnEnd(h, 1);
		expect(gateCalls().at(-1)!.state.task).toBe("Make the importer better");
	});

	test("user_replies are per plan: a new plan starts without them", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers(4, 0.9);
		await h.fire("before_agent_start", { prompt: "Add rate limiting to the orders API" });
		await h.fire("message_end", userEvt("Add rate limiting to the orders API"));
		await h.fire("message_end", userEvt("per minute"));
		expect(ambiguity.getUserReplies()).toEqual(["per minute"]);
		h.branch.push(modeChange("none"), planMode());
		await h.fire("before_agent_start", { prompt: "Plan a different feature" });
		expect(gateCalls().at(-1)!.state.user_replies).toBeUndefined();
	});

	// omp appends another `mode_change plan` when the plan is approved (its file path changes); "Refine plan" then
	// sends the user's feedback as a fresh prompt. That is still the same plan.
	test("a refinement after omp re-appends mode_change plan stays in the same plan", async () => {
		const task = "Add per-tenant rate limiting to the /v1/orders API, 100 req/min, 429 with Retry-After, tested in test/orders.test.ts";
		const h = setup({}, [{ type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } }], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers(3.8, 0.9);
		await h.fire("before_agent_start", { prompt: task });
		expect(scores().at(-1)?.decision).toBe("none");
		const planCalls = [
			{ type: "toolCall", id: "t1", name: "write", arguments: { path: "local://orders-plan.md", content: "# Plan\n1. limiter\n2. tests" } },
			{ type: "toolCall", id: "t2", name: "write", arguments: { path: "xd://propose", content: "orders-plan" } },
		];
		h.branch.push(ctxMsg, userMsg(task), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "plan written" }, ...planCalls] } });
		await h.fire("message_end", userEvt(task));
		await toolResult(h, "ask", "q1", { questions: [{ id: "q", question: "Burst?" }] }, "q: no", { details: { question: "Burst?", selectedOptions: ["no"] } });
		h.branch.push({ type: "mode_change", mode: "plan", data: { planFilePath: "local://orders-plan.md" } });
		replies.gate = gateAnswers(1, 0.9); // a short feedback prompt on its own would score as ambiguous
		const out = await h.fire("before_agent_start", { prompt: "also add headers" });
		expect(out).toBeUndefined();
		expect(gateCalls().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);
		await h.fire("message_end", userEvt("also add headers"));
		h.branch.push(ctxMsg, userMsg("also add headers"), asstMsg("revising"));
		await turnEnd(h);
		const state = gateCalls().at(-1)!.state;
		expect(state.task).toBe(task);
		expect(state.plan_so_far).toContain("1. limiter");
		expect(state.user_replies).toEqual(["also add headers"]);
	});

	test("the propose block cap belongs to the plan, not to each approval cycle", async () => {
		const propose = () => h.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: "xd://propose", content: "# Plan" } });
		const h = setup({}, [{ type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } }, ctxMsg, userMsg("Make it better")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		expect((await propose())?.block).toBe(true);
		expect((await propose())?.block).toBe(true);
		expect(await propose()).toBeUndefined();
		h.branch.push({ type: "mode_change", mode: "plan", data: { planFilePath: "local://x-plan.md" } });
		expect(await propose()).toBeUndefined();
	});

	test("synthetic developer-role prompts never count as the user's answer", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Make it better" });
		await h.fire("message_end", { message: { role: "developer", content: [{ type: "text", text: "Reminder: finish your todo list." }] } });
		expect(ambiguity.asksObserved()).toBe(0);
	});

	test("asks count only while planning, once per answered question, never when cancelled", async () => {
		const h = setup({}, [userMsg("do the thing")], { hasUI: true });
		await h.start();
		const ask = { questions: [{ id: "a", question: "Scope?" }, { id: "b", question: "Limit?" }] };
		await toolResult(h, "ask", "x1", ask, "a: all\nb: 10", { details: { results: [{ question: "Scope?", selectedOptions: ["all"] }, { question: "Limit?", customInput: "10" }] } });
		expect(ambiguity.asksObserved()).toBe(0);

		h.branch.push(planMode());
		await toolResult(h, "ask", "x2", ask, "a: all\nb: 10", { isError: true, details: { question: "Scope?", selectedOptions: ["all"] } });
		expect(ambiguity.asksObserved()).toBe(0);
		await toolResult(h, "ask", "x3", ask, "a: all\nb: 10", { details: { results: [{ question: "Scope?", selectedOptions: ["all"] }, { question: "Limit?", customInput: "10" }] } });
		expect(ambiguity.asksObserved()).toBe(2);
		expect(ambiguity.getAsks().map((a) => a.question)).toEqual(["Scope?", "Limit?"]);
	});

	test("a suppressed steer is recorded as suppressed_dedupe, and a failed send does not mute the dimension", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		h.sendThrows = true;
		h.branch.push(asstMsg("draft one"));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(scores().at(-1)?.decision).toBe("would_steer");
		expect(ambiguity.hasSteered("goal")).toBe(false);

		h.sendThrows = false;
		await h.fire("turn_end", { turnIndex: 1, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(scores().at(-1)?.decision).toBe("steer");
		expect(h.sent.length).toBe(1);
		await h.fire("turn_end", { turnIndex: 2, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(scores().at(-1)?.decision).toBe("suppressed_dedupe");
		expect(h.sent.length).toBe(1);
	});

	test("an aborted model turn never sends a gate aside", async () => {
		const h = setup({}, [planMode(), asstMsg("partial")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "aborted" }, toolResults: [] });
		expect(gateCalls().length).toBe(0);
		expect(h.sent.length).toBe(0);
	});

	test("plan_so_far holds the current plan's tail, not the oldest text of the session", async () => {
		const early = Array.from({ length: 8 }, (_, i) => asstMsg(`EARLIER-EXECUTION-OUTPUT-${i} ${"z".repeat(1000)}`));
		const h = setup({}, [...early, planMode(), asstMsg("CURRENT-PLAN-STEP")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		const soFar = gateCalls()[0].state.plan_so_far as string;
		expect(soFar).toContain("CURRENT-PLAN-STEP");
		expect(soFar).not.toContain("EARLIER-EXECUTION-OUTPUT");
	});
});

// ---- propose gate ----------------------------------------------------------------

describe("propose gate", () => {
	const propose = (h: Harness, content = "# Plan") => h.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: "xd://propose", content } });

	async function plan(options: SetupOptions = { hasUI: true }, cfg: object = {}) {
		const h = setup(cfg, [planMode(), userMsg("Make it better")], options);
		await h.start();
		replies.gate = gateAnswers();
		return h;
	}

	test("blocks twice per plan, then lets the plan through (would_block)", async () => {
		const h = await plan();
		const first = await propose(h);
		expect(first.block).toBe(true);
		expect(first.reason).toContain("ask tool");
		expect((await propose(h)).block).toBe(true);
		expect(await propose(h)).toBeUndefined();
		expect(scores().map((s) => s.decision)).toEqual(["block", "block", "would_block"]);
		expect(scores().filter((s) => s.decision === "block")).toHaveLength(LIMITS.proposeBlocksPerPlan);
	});

	test("does not block when the ask tool is not active", async () => {
		const h = await plan({ hasUI: true, activeTools: ["write", "edit"] });
		expect(await propose(h)).toBeUndefined();
		expect(scores().at(-1)?.decision).toBe("would_block");
	});

	test("does not block without a UI", async () => {
		const h = await plan({ hasUI: false });
		expect(await propose(h)).toBeUndefined();
		expect(scores().at(-1)?.decision).toBe("would_block");
	});

	test("only xd://propose writes are gated, and only in plan mode", async () => {
		const h = await plan();
		expect(await h.fire("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } })).toBeUndefined();
		expect(await h.fire("tool_call", { toolName: "write", input: { path: "xd://propose/plan.md", content: "x" } })).toBeUndefined();
		h.branch.push(modeChange("none"));
		expect(await propose(h)).toBeUndefined();
		expect(gateCalls().length).toBe(0);
	});

	test("/adversary off and /adversary gate off both stop blocking; gate on brings it back", async () => {
		const h = await plan();
		await h.command("adversary", "off");
		expect(await propose(h)).toBeUndefined();
		await h.command("adversary", "on");
		expect((await propose(h)).block).toBe(true);
		await h.command("adversary", "gate off");
		expect(await propose(h)).toBeUndefined();
		await h.command("adversary", "off");
		await h.command("adversary", "gate on");
		expect((await propose(h)).block).toBe(true);
	});

	test("a stalled Jev call fails open before omp's fail-closed hook timeout", async () => {
		const h = await plan({ hasUI: true }, { ambiguityGate: { timeoutMs: 250 } });
		mockState.respond = (call) => ("goal_clarity" in call.questions ? new Promise<Answers>(() => {}) : {});
		const started = Date.now();
		const result = await propose(h);
		const elapsed = Date.now() - started;
		expect(result).toBeUndefined();
		expect(elapsed).toBeGreaterThan(1500);
		expect(elapsed).toBeLessThan(5000);
		expect(scores().length).toBe(0);
	}, 10_000);

	// The deadline is min(9 s, timeoutMs + 1.8 s), and omp fails closed at 30 s: whatever timeoutMs a config asks for
	// (up to 60 s), a stalled gate has to give up before omp does. Run on a fake clock, so 9 s costs no time.
	test.each([
		[250, 2050],
		[5000, 6800],
		[60_000, LIMITS.gateDeadlineMs],
	])("a stalled gate with timeoutMs %d gives up at %d ms, not a millisecond sooner", async (timeoutMs, expectedMs) => {
		expect(expectedMs).toBe(Math.min(LIMITS.gateDeadlineMs, timeoutMs + LIMITS.gateSlackMs));
		expect(expectedMs).toBeLessThan(LIMITS.ompToolCallTimeoutMs);
		const h = await plan({ hasUI: true }, { ambiguityGate: { timeoutMs } });
		mockState.respond = (call) => ("goal_clarity" in call.questions ? new Promise<Answers>(() => {}) : {});
		jest.useFakeTimers();
		try {
			let settled = false;
			const pending = propose(h).then((result) => {
				settled = true;
				return result;
			});
			const flush = async () => {
				for (let i = 0; i < 20; i++) await Promise.resolve();
			};
			await flush();
			jest.advanceTimersByTime(expectedMs - 1);
			await flush();
			expect(settled).toBe(false);
			jest.advanceTimersByTime(1);
			await flush();
			// Checked before it is awaited: a deadline that is too late must fail this test, not hang it on a stopped clock.
			expect(settled).toBe(true);
			expect(await pending).toBeUndefined();
			expect(scores().length).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a throwing git probe or Jev call fails open", async () => {
		const h = await plan();
		h.exec = async () => {
			throw new Error("git exploded");
		};
		mockState.respond = () => {
			throw new Error("jev exploded");
		};
		expect(await propose(h)).toBeUndefined();
	});

	test("the gate reads git status and the outline only, and lists the outline once per plan", async () => {
		const h = await plan();
		h.exec = repoGit();
		await propose(h);
		await propose(h);
		const subs = new Set(h.execCalls.map(subcommand));
		expect([...subs].sort()).toEqual(["ls-files", "status"]);
		expect(gitCalls(h, "ls-files").length).toBe(1);
		expect(gitCalls(h, "status").length).toBe(2);
		const state = gateCalls().at(-1)!.state;
		expect(state.evidence.status).toContain("src/a.ts");
		expect(state.evidence.repo_outline).toContain("README.md");
	});

	test("the plan being submitted is part of plan_so_far when the branch does not hold it yet", async () => {
		const h = await plan();
		await propose(h, "PROPOSED-PLAN-BODY: add a limiter");
		expect(gateCalls().at(-1)!.state.plan_so_far).toContain("PROPOSED-PLAN-BODY");
	});
});

// ---- action reviews --------------------------------------------------------------

describe("failed commands", () => {
	test("an errored bash command is reviewed, with its exit status in the state", async () => {
		const h = setup({}, [userMsg("clean up")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.8, { hidden_destruction: 0.9 }, true);
		await toolResult(h, "bash", "c1", { command: "git checkout -- . && bun test" }, "3 tests failed", { isError: true, details: { exitCode: 1 } });
		expect(reviewCalls().length).toBe(1);
		const call = reviewCalls()[0];
		expect(call.state.exit_status).toBe("error");
		expect("unverified_claim" in call.questions).toBe(false);
		expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(h.sent[0].message.content).toContain("hidden_destruction");
	});

	test("a successful command is reviewed with exit_status ok", async () => {
		const h = setup({}, [userMsg("clean up")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: "ls" });
		expect(reviewCalls()[0].state.exit_status).toBe("ok");
	});

	test("a command the user aborted is not reviewed, so no note can restart the run", async () => {
		const h = setup({}, [userMsg("run the build")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 }, true);
		await toolResult(h, "bash", "c1", { command: "make clean all" }, "partial output\n[Command aborted]", { isError: true });
		await toolResult(h, "bash", "c2", { command: "make clean all" }, "Command aborted", { isError: true });
		expect(reviewCalls().length).toBe(0);
		expect(h.sent.length).toBe(0);
		await toolResult(h, "bash", "c3", { command: "make clean all" }, "Command timed out after 120s", { isError: true, details: { timedOut: true } });
		expect(reviewCalls().length).toBe(1);
	});

	// Only omp's own marker counts: a destructive command whose output merely mentions these words is still judged.
	test("output that merely contains omp's abort wording does not skip the review", async () => {
		const h = setup({}, [userMsg("clean up")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 0.2, {}, true);
		const failed = { isError: true, details: { exitCode: 1 } };
		await toolResult(h, "bash", "c1", { command: 'rm -rf src && grep -r "Tool execution was aborted" .' }, "docs/notes.md:4: Tool execution was aborted when the user pressed Esc", failed);
		await toolResult(h, "bash", "c2", { command: "rm -rf build; cat log" }, "the log says [Command aborted] twice\nCommand aborted by the scheduler, retrying", failed);
		await toolResult(h, "bash", "c3", { command: "rm -rf dist; echo done" }, "[Command aborted] was printed first\nthen the build failed", failed);
		expect(reviewCalls().length).toBe(3);
	});

	// The result's details say the command ran and failed, and they are all that is read: omp never throws an abort with
	// details, and the output of a command (a file it printed, a log) can say anything, down to omp's own marker.
	test("once the details show a command ran and failed, output that looks like an abort cannot get the review skipped", async () => {
		const h = setup({ adversary: { maxCallsPerTurn: 30 } }, [userMsg("clean up")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 }, true);
		const note = "[Full output was not saved: ENOSPC: no space left on device]";
		const exited = { isError: true, details: { exitCode: 1 } };
		const forms = [
			"[Command cancelled] appears in notes.txt\nrm: cannot remove x\n\nCommand exited with code 1",
			"Tool execution was aborted.",
			"Command aborted",
			"[Command cancelled]\npartial output",
			"[Command aborted]",
			`${"build line\n".repeat(400)}[Command aborted]`,
			`build output\n\n[Command aborted]\n\n${note}`,
			`[Command aborted]\n${note}\n[another note]`,
		];
		for (const [i, text] of forms.entries()) await toolResult(h, "bash", `x${i}`, { command: `rm -rf build${i}; cat notes.txt; false` }, text, exited);
		// omp's own timeout note is one of those bracketed lines.
		await toolResult(h, "bash", "t1", { command: "rm -rf build; sleep 999" }, "log line\n[Command aborted]\n\n[Command timed out after 120 seconds]", { isError: true, details: { timedOut: true } });
		await toolResult(h, "eval", "v1", { code: "clean(); fail()" }, "[Command cancelled]\nremoved a.txt", { isError: true, details: { cells: [{ index: 0, status: "error", exitCode: 1 }] } });
		expect(reviewCalls().length).toBe(forms.length + 2);
		expect(reviewCalls().every((call) => call.state.exit_status === "error")).toBe(true);
	});

	test("omp's own abort results are skipped in every form, even when the output is long", async () => {
		const h = setup({}, [userMsg("run the build")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 }, true);
		const forms = [
			"Tool execution was aborted.",
			"Tool execution was aborted: the user interrupted",
			"Command aborted",
			"[Command cancelled]\npartial output",
			`${"build line\n".repeat(400)}[Command aborted]`,
			"[Command aborted]",
		];
		// omp throws a stopped command, so the result has no details: nothing shows it ran and failed.
		for (const [i, text] of forms.entries()) await toolResult(h, "bash", `a${i}`, { command: "make clean all" }, text, { isError: true });
		expect(reviewCalls().length).toBe(0);
		expect(h.sent.length).toBe(0);
	});

	// omp throws, with no details, for a call it stopped (Esc), blocked, or could not get an exit status for. An
	// auto-backgrounded bash command or eval cell that is aborted throws its latest output, with no marker in it.
	test("an errored bash or eval result that carries no sign of a command that ran to a failure is not reviewed", async () => {
		const h = setup({}, [userMsg("run the build")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 }, true);
		await toolResult(h, "bash", "b1", { command: "make clean all" }, "removed build/a.o\nremoved build/b.o", { isError: true });
		await toolResult(h, "eval", "e1", { code: "clean()" }, "removed a.txt\nremoved b.txt", { isError: true });
		// A cell the user cancelled has no exit code.
		await toolResult(h, "eval", "e2", { code: "clean()" }, "removed a.txt", { isError: true, details: { isError: true, cells: [{ index: 0, status: "error", output: "removed a.txt" }] } });
		await toolResult(h, "eval", "e3", { code: "clean()" }, "removed a.txt", { isError: true, details: { cells: [{ status: "error", exitCode: undefined }, { status: "complete", exitCode: 0 }] } });
		expect(reviewCalls().length).toBe(0);
		expect(h.sent.length).toBe(0);
	});

	test("an errored eval cell with a non-zero exit code is reviewed, like a failed bash command", async () => {
		const h = setup({}, [userMsg("run the build")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 }, true);
		const out = "removed a.txt\nremoved b.txt\n\nCommand exited with code 1";
		await toolResult(h, "eval", "e1", { code: "clean(); fail()" }, out, { isError: true, details: { isError: true, cells: [{ index: 0, status: "error", exitCode: 1 }] } });
		expect(reviewCalls().length).toBe(1);
		expect(reviewCalls()[0].state.exit_status).toBe("error");
	});

	test("an errored edit changed nothing and is not reviewed", async () => {
		const h = setup({}, [userMsg("fix")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "a.ts" }, "no match", { isError: true });
		expect(reviewCalls().length).toBe(0);
	});
});

describe("single delivery of action notes", () => {
	test("with inlineActionNotes a non-blocker note rides the tool result and is not also sent", async () => {
		const h = setup({}, [userMsg("refactor x")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 1.7, { breaks_contract: 0.9 });
		const out = await toolResult(h, "edit", "c1", { path: "a.ts" });
		expect(h.sent.length).toBe(0);
		const texts = out.content.map((c: any) => c.text).join("");
		expect(texts.match(/<adversarial-note/g)?.length).toBe(1);
		expect(out.content[0]).toEqual({ type: "text", text: "ok" });
		expect(reviewer.getLastReviewRecord()).toMatchObject({ decision: "delivered_inline", channel: "inline" });
	});

	test("a blocker steers and is not also inlined", async () => {
		const h = setup({}, [userMsg("refactor x")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 2.9, { hidden_destruction: 0.95 });
		const out = await toolResult(h, "bash", "c1", { command: "rm -rf src" });
		expect(out).toBeUndefined();
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].options.deliverAs).toBe("steer");
	});

	test("without inlineActionNotes the note is one aside and the tool result is untouched", async () => {
		const h = setup({ adversary: { inlineActionNotes: false } }, [userMsg("refactor x")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("action", "adversarial", 1.7, { breaks_contract: 0.9 });
		const out = await toolResult(h, "edit", "c1", { path: "a.ts" });
		expect(out).toBeUndefined();
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].options).toEqual({ deliverAs: "aside" });
	});
});

describe("commands-run evidence", () => {
	test("a failing command is recorded even when its tool is not reviewed", async () => {
		const h = setup({ adversary: { tools: ["edit"] } }, [userMsg("fix and run tests")]);
		await h.start();
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "b1", { command: "bun test" }, "3 fail", { isError: true });
		expect(reviewCalls().length).toBe(0);
		await toolResult(h, "edit", "e1", { path: "a.ts" });
		expect(reviewCalls()[0].state.evidence.commandsRun).toEqual(["bash: bun test [failed]"]);
	});

	test("commands are recorded with reviewActions off, for the turn review", async () => {
		const h = setup({ adversary: { reviewActions: false } }, [userMsg("fix and run tests")]);
		await h.start();
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "b1", { command: "bun test" }, "ok");
		await toolResult(h, "eval", "v1", { code: "1 + 1" }, "2");
		h.branch.push(asstMsg("I ran the tests."));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(reviewCalls()[0].state.evidence.commandsRun).toEqual(["bash: bun test [ok]", "eval: 1 + 1 [ok]"]);
	});

	test("one tool call is counted once, and the log survives turns but not the next prompt", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "b1", { command: "bun test" });
		await toolResult(h, "bash", "b1", { command: "bun test" });
		await h.fire("turn_start", { turnIndex: 1 });
		await toolResult(h, "edit", "e1", { path: "a.ts" });
		expect(reviewCalls().at(-1)!.state.evidence.commandsRun).toEqual(["bash: bun test [ok]"]);

		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "e2", { path: "b.ts" });
		expect(reviewCalls().at(-1)!.state.evidence.commandsRun).toEqual([]);
	});
});

describe("evidence collection", () => {
	test("no git probes run once the call budget is spent", async () => {
		const h = setup({ adversary: { maxCallsPerTurn: 1 } }, [userMsg("edit things")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "a.ts" });
		const probes = h.execCalls.length;
		expect(probes).toBeGreaterThan(0);
		await toolResult(h, "edit", "c2", { path: "b.ts" });
		await toolResult(h, "edit", "c3", { path: "c.ts" });
		expect(h.execCalls.length).toBe(probes);
		expect(reviewCalls().length).toBe(1);
		expect(reviewer.getReviewStats().suppressed.call_budget).toBe(2);
	});

	test("the turn review collects no evidence either once the call budget is spent", async () => {
		const h = setup({ adversary: { maxCallsPerTurn: 1 } }, [userMsg("edit things")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: "ls" });
		const probes = h.execCalls.length;
		h.branch.push(asstMsg("I listed the files."));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(h.execCalls.length).toBe(probes);
		expect(reviewer.getLastReviewRecord()).toMatchObject({ kind: "turn", decision: "suppressed", reason: "call_budget" });
	});

	test("no git probes run in a phase that is not reviewed", async () => {
		const h = setup({ phases: ["execute"] }, [userMsg("plan"), planMode()]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "a.ts" });
		expect(h.execCalls.length).toBe(0);
	});

	test("the plan-mode turn_end collects git status once: the gate reuses the turn review's evidence", async () => {
		const h = setup({}, [planMode(), userMsg("Make it better")], { hasUI: true });
		h.exec = repoGit();
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("turn_start", { turnIndex: 0 });
		h.branch.push(asstMsg("Here is my first plan draft."));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(reviewCalls().length).toBe(1);
		expect(gateCalls().length).toBe(1);
		expect(gitCalls(h, "status").length).toBe(1);
		expect(gateCalls()[0].state.evidence.status).toContain("src/a.ts");
	});

	test("the edited file leads the evidence, and HEAD from the start of the prompt is the baseline", async () => {
		let head = HEAD;
		const h = setup({}, [userMsg("rename fetchUser")]);
		h.exec = repoGit(() => head);
		await h.start();
		await h.fire("agent_start");
		head = NEXT_HEAD; // the agent commits mid-prompt
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "src/a.ts" });
		const diffs = gitCalls(h, "diff");
		const zero = diffs.find((args) => args.includes("-U0"))!;
		expect(zero).toContain(HEAD);
		expect(zero).not.toContain(NEXT_HEAD);
		expect(zero).toContain(":(literal)src/a.ts");
		// HEAD was read once, at agent_start; collectEvidence did not read it again.
		expect(gitCalls(h, "rev-parse").filter((args) => args.includes("--verify")).length).toBe(1);
	});

	test("an apply_patch call's files lead the evidence too", async () => {
		const h = setup({}, [userMsg("rename fetchUser")]);
		h.exec = repoGit();
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		const input = { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-export function fetchUser() {}\n+export function getUser() {}\n*** End Patch" };
		await toolResult(h, "apply_patch", "c1", input);
		const zero = gitCalls(h, "diff").find((args) => args.includes("-U0"))!;
		expect(zero).toContain(":(literal)src/a.ts");
	});

	test("a hashline edit's files lead the evidence: omp's default edit mode names them only in `[PATH#TAG]` headers", async () => {
		const h = setup({}, [userMsg("rename fetchUser")]);
		h.exec = repoGit();
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { input: "[src/a.ts#A1B2]\nPUT 1.=1:\n+export function getUser() {}" });
		const zero = gitCalls(h, "diff").find((args) => args.includes("-U0"))!;
		expect(zero).toContain(":(literal)src/a.ts");
	});

	test("with evidence off no git probe runs at all", async () => {
		const h = setup({ adversary: { evidence: false } }, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "a.ts" });
		expect(h.execCalls.length).toBe(0);
		expect(reviewCalls().length).toBe(1);
		expect(reviewCalls()[0].state.evidence).toBeUndefined();
	});
});

// ---- budgets, aborts, immunity -------------------------------------------------------

describe("per-prompt budgets and turn wiring", () => {
	test("message reviews are capped per prompt, across turns, and agent_start resets the cap", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		const text = "x".repeat(300);
		for (let turn = 0; turn <= reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT; turn++) {
			await h.fire("turn_start", { turnIndex: turn });
			await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
		}
		expect(reviewCalls().length).toBe(reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT);
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
		expect(reviewCalls().length).toBe(reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT + 1);
	});

	test("agent_start itself starts the next prompt's budgets, whatever turn index follows", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		const text = "x".repeat(300);
		for (let turn = 0; turn < reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT; turn++) {
			await h.fire("turn_start", { turnIndex: turn });
			await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
		}
		await h.fire("turn_start", { turnIndex: 99 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
		expect(reviewCalls().length).toBe(reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT);
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 99 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
		expect(reviewCalls().length).toBe(reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT + 1);
	});

	test("a steer from a turn review protects the following turn", async () => {
		const h = setup({ adversary: { immuneTurns: 1 } }, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		replies.review = reviewAnswers("turn", "adversarial", 2.8, { requirement_missed: 0.9 });
		h.branch.push(asstMsg("I changed the retry logic."));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(h.sent[0].options.deliverAs).toBe("steer");

		await h.fire("turn_start", { turnIndex: 1 });
		replies.review = reviewAnswers("message", "adversarial", 2.8, { risky_api: 0.9 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "y".repeat(300) }] } });
		expect(h.sent[1].options).toEqual({ deliverAs: "nextTurn" });
		expect(reviewer.getReviewStats().downgraded).toBe(1);
	});

	test("aborted and errored messages are not reviewed", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		const text = "x".repeat(300);
		replies.review = reviewAnswers("message", "adversarial", 2.9, { risky_api: 0.9 });
		for (const stopReason of ["aborted", "error"]) {
			await h.fire("message_end", { message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
		}
		h.branch.push(asstMsg(text));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "aborted" }, toolResults: [] });
		expect(reviewCalls().length).toBe(0);
		expect(h.sent.length).toBe(0);
		await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
		expect(reviewCalls().length).toBe(1);
	});
});

// When the user presses Esc during a tool batch, omp still ends the turn with the assistant message's `toolUse` stop
// reason and the batch's results, so the turn's tool results are the only sign that the run was stopped.
describe("a tool batch the user stopped", () => {
	const toolUseTurn = (toolResults: unknown[]) => ({ turnIndex: 0, message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults });
	const result = (toolName: string, text: string, details?: unknown, isError = true) => ({ role: "toolResult", toolName, toolCallId: "t1", isError, content: [{ type: "text", text }], details });

	test("no turn review and no steer, however the stopped call shows it", async () => {
		const stopped = [
			result("bash", "partial output\n[Command aborted]"),
			result("bash", "Command aborted", {}),
			result("eval", "removed a.txt", { cells: [{ index: 0, status: "error" }] }),
			result("read", "Tool execution was aborted.", { __synthetic: true, source: "assistant_stop_aborted", executed: false }),
			result("task", "Tool was not executed because the run was aborted: user interrupt."),
		];
		for (const [i, toolResult] of stopped.entries()) {
			const h = setup({}, [userMsg("run the build")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 2.9, { silent_scope_reduction: 0.95 });
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([result("edit", "ok", undefined, false), toolResult]));
			expect([i, reviewCalls().length]).toEqual([i, 0]);
			expect(h.sent.length).toBe(0);
		}
	});

	// omp turns a ToolAbortError thrown by any tool into an errored result of exactly this text, with no details, and
	// skips the tool_result hook, so one tool call in flight when Esc is pressed shows only here.
	test("a call of any tool that threw ToolAbortError is a stop, and so is a call omp skipped for a queued message", async () => {
		const stopped = [
			result("read", "Operation aborted", {}),
			result("grep", "Operation aborted", {}),
			result("task", "Operation aborted", {}),
			result("web_search", "Operation aborted", {}),
			result("ask", "  Operation aborted\n", {}),
			result("browser", "Tool call aborted", {}),
			result("bash", "Operation aborted", {}),
			// The tools that throw ToolAbortError with a message of their own: a cancelled ask dialog aborts the run, and so does Esc during a browser open.
			result("ask", "Ask tool was cancelled by the user", {}),
			result("ask", "Ask input was cancelled", {}),
			result("browser", "Browser open aborted", {}),
			result("browser", "Browser tab open aborted", {}),
			result("read", "Skipped due to queued user message.", { __interrupted: true, source: "interrupt_skipped", execution: "started" }),
			result("bash", "Skipped due to queued user message.", { __interrupted: true, source: "interrupt_skipped", execution: "started" }),
		];
		for (const [i, toolResult] of stopped.entries()) {
			const h = setup({}, [userMsg("run the build")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 2.9, { silent_scope_reduction: 0.95 });
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([result("edit", "ok", undefined, false), toolResult]));
			expect([i, reviewCalls().length]).toEqual([i, 0]);
			expect(h.sent.length).toBe(0);
		}
	});

	test("a cancelled ask dialog, and a browser open Esc cut off, stop the turn review, however severe the note it would send", async () => {
		for (const text of ["Ask tool was cancelled by the user", "Ask input was cancelled", "Browser open aborted", "Browser tab open aborted"]) {
			const h = setup({}, [userMsg("run the build")], { hasUI: true });
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 2.9, { silent_scope_reduction: 0.95 });
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([result("edit", "ok", undefined, false), result(text.startsWith("Ask") ? "ask" : "browser", text, {})]));
			expect([text, reviewCalls().length, h.sent.length]).toEqual([text, 0, 0]);
		}
	});

	test("the gate evaluation is skipped too", async () => {
		const h = setup({}, [planMode(), asstMsg("partial plan")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("turn_end", toolUseTurn([result("bash", "partial\n[Command aborted]")]));
		expect(gateCalls().length).toBe(0);
		expect(h.sent.length).toBe(0);
		await h.fire("turn_end", toolUseTurn([result("read", "Operation aborted", {})]));
		expect(gateCalls().length).toBe(0);
		expect(h.sent.length).toBe(0);
	});

	// A command omp refused, or got no exit status for, was not stopped by the user: its turn is reviewed and gated.
	test("a bash command omp blocked, or could not get an exit status for, does not stop the turn review", async () => {
		const notStopped = [
			result("bash", "Blocked: Use the `read` tool instead of `cat`.\n\nOriginal command: cat a.ts", {}),
			result("bash", "Command blocked", {}),
			result("bash", "some output\n\nCommand failed: missing exit status", {}),
			result("bash", "some output\n\n[Command timed out after 30 seconds]", {}),
			result("bash", "Command timed out", {}),
			result("eval", "Blocked: not allowed here", {}),
		];
		for (const [i, toolResult] of notStopped.entries()) {
			const h = setup({}, [userMsg("run the build")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 0.2, {});
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([result("edit", "ok", undefined, false), toolResult]));
			expect([i, reviewCalls().length]).toEqual([i, i + 1]);
		}
	});

	// omp's own mark of a stop (a trailing [Command aborted], a leading [Command cancelled]) outranks the wording of a block
	// or a missing exit status: a stopped command's output can start or end with anything, and a steer here restarts the
	// run the user just interrupted.
	test("a command the user stopped is a stop even when its output starts like a block or mentions a missing exit status", async () => {
		const stopped = [
			result("bash", "Blocked: waiting for lock\nbuilding...\n\n[Command aborted]", {}),
			result("bash", "log: Command failed: missing exit status\n\n[Command aborted]", {}),
			result("bash", "Blocked: waiting for lock\nbuilding...\n\n[Command aborted]\n\n[Full output was not saved: ENOSPC: no space left on device]", {}),
			result("bash", "Command failed: missing exit status\nbuilding...\n[Command aborted]", {}),
			result("bash", "waiting\n[Command timed out after 30 seconds]\n\n[Command aborted]", {}),
			result("bash", "[Command cancelled]\nBlocked: waiting for lock", {}),
			result("bash", "[Command cancelled]\nlog: Command failed: missing exit status", {}),
			result("eval", "Blocked: waiting for lock\n\n[Command aborted]", { cells: [{ index: 0, status: "error" }] }),
		];
		for (const [i, toolResult] of stopped.entries()) {
			const h = setup({}, [userMsg("run the build")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 2.9, { silent_scope_reduction: 0.95 });
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([result("edit", "ok", undefined, false), toolResult]));
			expect([i, reviewCalls().length, h.sent.length]).toEqual([i, 0, 0]);
		}
	});

	test("a block or a missing exit status that merely mentions omp's stop mark is still not a stop", async () => {
		const notStopped = [
			result("bash", "Blocked: see [Command aborted] in the docs, then retry", {}),
			result("bash", "Blocked: x\n[Command aborted] was printed\nlater lines", {}),
			result("bash", "[Command aborted] was printed\n\nCommand failed: missing exit status", {}),
			result("bash", "[Command aborted]\n\n[Command timed out after 30 seconds]", {}),
		];
		for (const [i, toolResult] of notStopped.entries()) {
			const h = setup({}, [userMsg("run the build")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 0.2, {});
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([result("edit", "ok", undefined, false), toolResult]));
			expect([i, reviewCalls().length]).toEqual([i, i + 1]);
		}
	});

	test("a blocked command does not skip the gate evaluation either", async () => {
		const h = setup({}, [planMode(), asstMsg("partial plan")], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("turn_end", toolUseTurn([result("bash", "Blocked: Use the `read` tool instead of `cat`.\n\nOriginal command: cat a.ts", {})]));
		expect(gateCalls().length).toBe(1);
	});

	// The stop is the safe reading: a command omp reports in wording this does not know, or an auto-backgrounded one
	// whose abort carries the job's latest output, still ends the turn without a review.
	test("an errored command with no details and text no rule recognises is still taken for a stop", async () => {
		const unknown = [result("bash", "latest line of the job's output", {}), result("bash", "[Command cancelled]\npartial", {}), result("eval", "ran for a while", { cells: [{ index: 0, status: "error" }] }), result("bash", "Denied by policy", {})];
		for (const [i, toolResult] of unknown.entries()) {
			const h = setup({}, [userMsg("run the build")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 2.9, { silent_scope_reduction: 0.95 });
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([toolResult]));
			expect([i, reviewCalls().length]).toEqual([i, 0]);
		}
	});

	test("a command that ran and failed, or a tool that merely errored, does not stop the turn review", async () => {
		const ran = [
			result("bash", "[Command aborted] is in the log\n\nCommand exited with code 1", { exitCode: 1 }),
			result("bash", "log line\n[Command timed out after 120 seconds]", { timedOut: true }),
			result("edit", "no match for the text to replace; the run was aborted by nobody", {}),
			result("read", "no such file: a.ts", {}),
			// Only a result that is exactly ToolAbortError's text is a stop, not one that merely mentions it.
			result("read", "Operation aborted by the server, retry later", {}),
			result("web_search", "Error: Tool call aborted upstream (HTTP 499)", {}),
			// Nor is one that merely begins like the wording of omp's ask and browser aborts.
			result("browser", "Browser open aborted: net::ERR_CONNECTION_REFUSED", {}),
			result("ask", "Ask tool was cancelled by the user's proxy; retry", {}),
		];
		for (const [i, toolResult] of ran.entries()) {
			const h = setup({}, [userMsg("run the build")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			replies.review = reviewAnswers("turn", "adversarial", 0.2, {});
			h.branch.push(asstMsg("I cleaned and rebuilt everything, which is certainly safe and verified."));
			await h.fire("turn_end", toolUseTurn([toolResult]));
			// The mock keeps every call of the test, so each iteration adds one.
			expect([i, reviewCalls().length]).toEqual([i, i + 1]);
		}
	});
});

describe("stop gate", () => {
	const stopCfg = { stopGate: { enabled: true } };
	const failing = () => {
		replies.stop = { verified: { type: "noul", noul: 0.05 }, left_unfinished: { type: "noul", noul: 0.9 } };
	};

	test("continues once for unverified, unfinished work and uses the host's last message", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done (branch text)")]);
		await h.start();
		failing();
		const out = await h.fire("session_stop", { last_assistant_message: "All finished (event text)", stop_hook_active: false });
		expect(out.continue).toBe(true);
		expect(mockState.calls[0].state.final_assistant_message).toBe("All finished (event text)");
	});

	test("accepts omp's AssistantMessage object, whose text is in its content blocks", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done (branch text)")]);
		await h.start();
		failing();
		const message = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "All finished" }, { type: "text", text: "(object text)" }] };
		const out = await h.fire("session_stop", { last_assistant_message: message });
		expect(out.continue).toBe(true);
		expect(mockState.calls[0].state.final_assistant_message).toBe("All finished\n(object text)");
	});

	test("an object with no text, or no message at all, uses the last assistant message in the branch", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done (branch text)")]);
		await h.start();
		failing();
		await h.fire("session_stop", { last_assistant_message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } });
		await h.fire("agent_start"); // the gate may continue twice per prompt
		await h.fire("session_stop", { last_assistant_message: {} });
		await h.fire("agent_start");
		await h.fire("session_stop");
		expect(mockState.calls.map((c) => c.state.final_assistant_message)).toEqual(["Done (branch text)", "Done (branch text)", "Done (branch text)"]);
	});

	test("continues at most LIMITS.stopGateRunsPerPrompt times per prompt, and a new prompt starts the count again", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		failing();
		for (let run = 0; run < LIMITS.stopGateRunsPerPrompt; run++) expect([run, (await h.fire("session_stop"))?.continue]).toEqual([run, true]);
		expect(await h.fire("session_stop")).toBeUndefined();
		expect(mockState.calls.length).toBe(LIMITS.stopGateRunsPerPrompt);
		await h.fire("agent_start");
		expect((await h.fire("session_stop"))?.continue).toBe(true);
	});

	test("stays silent when the work is verified and finished", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		replies.stop = { verified: { type: "noul", noul: 0.9 }, left_unfinished: { type: "noul", noul: 0.1 } };
		expect(await h.fire("session_stop")).toBeUndefined();
		expect(mockState.calls.length).toBe(1);
		// A silent verdict does not use up the two continuations of this prompt.
		failing();
		expect((await h.fire("session_stop"))?.continue).toBe(true);
		expect((await h.fire("session_stop"))?.continue).toBe(true);
		expect(await h.fire("session_stop")).toBeUndefined();
	});

	test("left_unfinished at unfinished_threshold continues; just below it does not", async () => {
		const h = setup({ stopGate: { enabled: true, unfinished_threshold: 0.6, verified_floor: 0.25 } }, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		replies.stop = { verified: { type: "noul", noul: 0.9 }, left_unfinished: { type: "noul", noul: 0.6 } };
		const at = await h.fire("session_stop");
		expect(at.continue).toBe(true);
		expect(at.additionalContext).toContain("work appears unfinished (left_unfinished=0.60)");
		expect(at.additionalContext).not.toContain("verification is weak");
		replies.stop = { verified: { type: "noul", noul: 0.9 }, left_unfinished: { type: "noul", noul: 0.59 } };
		expect(await h.fire("session_stop")).toBeUndefined();
	});

	test("verified at verified_floor continues; just above it does not", async () => {
		const h = setup({ stopGate: { enabled: true, unfinished_threshold: 0.7, verified_floor: 0.3 } }, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		replies.stop = { verified: { type: "noul", noul: 0.3 }, left_unfinished: { type: "noul", noul: 0.1 } };
		const at = await h.fire("session_stop");
		expect(at.continue).toBe(true);
		expect(at.additionalContext).toContain("verification is weak (verified=0.30)");
		expect(at.additionalContext).not.toContain("work appears unfinished");
		replies.stop = { verified: { type: "noul", noul: 0.31 }, left_unfinished: { type: "noul", noul: 0.1 } };
		expect(await h.fire("session_stop")).toBeUndefined();
	});

	test("both problems are reported together", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		failing();
		const out = await h.fire("session_stop");
		expect(out.additionalContext).toContain("work appears unfinished");
		expect(out.additionalContext).toContain("verification is weak");
	});

	test("an answer the API left out counts as verified and finished", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		replies.stop = {};
		expect(await h.fire("session_stop")).toBeUndefined();
	});

	test("the final message and the task are masked and repaired before they leave", async () => {
		const h = setup(stopCfg, [userMsg("deploy with key sk_live_zyxwvutsrqponm9876"), asstMsg("Done!")]);
		await h.start();
		failing();
		await h.fire("session_stop", { last_assistant_message: "Shipped using sk_live_abcdefghijklmnop1234 \ud800 done" });
		const state = mockState.calls[0].state;
		expect(JSON.stringify(state)).not.toContain("sk_live_abcdefghijklmnop1234");
		expect(JSON.stringify(state)).not.toContain("sk_live_zyxwvutsrqponm9876");
		expect(state.final_assistant_message).toContain("[REDACTED]");
		expect(state.final_assistant_message.isWellFormed()).toBe(true);
	});

	test("never chains onto its own continuation", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		failing();
		expect(await h.fire("session_stop", { stop_hook_active: true })).toBeUndefined();
		expect(mockState.calls.length).toBe(0);
	});

	test("is silent after /adversary off and while planning", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		failing();
		await h.command("adversary", "off");
		expect(await h.fire("session_stop")).toBeUndefined();
		await h.command("adversary", "on");
		expect((await h.fire("session_stop"))?.continue).toBe(true);
		h.branch.push(planMode());
		expect(await h.fire("session_stop")).toBeUndefined();
	});

	test("is silent when phases exclude execution", async () => {
		const h = setup({ ...stopCfg, phases: ["plan"] }, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		failing();
		expect(await h.fire("session_stop")).toBeUndefined();
	});

	test("the two-use cap is per prompt, not per session", async () => {
		const h = setup(stopCfg, [userMsg("ship it"), asstMsg("Done!")]);
		await h.start();
		failing();
		expect((await h.fire("session_stop"))?.continue).toBe(true);
		expect((await h.fire("session_stop"))?.continue).toBe(true);
		expect(await h.fire("session_stop")).toBeUndefined();
		await h.fire("agent_start");
		expect((await h.fire("session_stop"))?.continue).toBe(true);
	});
});

// ---- /adversary role, status, dump -----------------------------------------------------

describe("/adversary", () => {
	test("role reloads that role's priorities file", async () => {
		const dir = join(root, "roles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "ADVERSARY.md"), "ADV-PRIORITIES-MARKER");
		writeFileSync(join(dir, "WATCHDOG.md"), "WATCH-PRIORITIES-MARKER");
		const h = setup({}, [userMsg("do the thing")], { cwd: dir });
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "x".repeat(300) }] } });
		expect(reviewCalls()[0].state.review_priorities).toContain("ADV-PRIORITIES-MARKER");

		await h.command("adversary", "role advisory");
		await h.fire("turn_start", { turnIndex: 1 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "y".repeat(300) }] } });
		const call = reviewCalls()[1];
		expect(call.state.review_priorities).toContain("WATCH-PRIORITIES-MARKER");
		expect(call.state.review_priorities).not.toContain("ADV-PRIORITIES-MARKER");
		expect("on_track" in call.questions).toBe(true);
	});

	test("an unreadable priorities location does not break the role switch", async () => {
		const h = setup({}, [userMsg("go")], { cwd: join(root, "does-not-exist") });
		await h.start();
		await h.command("adversary", "role advisory");
		expect(h.warns.length).toBe(0);
		expect(h.labels.at(-1)).toBe("TypeSafe Advisor");
	});

	test("usage errors use omp's warning level", async () => {
		const h = setup({}, [], { hasUI: true });
		await h.start();
		h.notices.length = 0;
		await h.command("adversary", "role bogus");
		await h.command("adversary", "gate maybe");
		await h.command("adversary", "frobnicate");
		await h.command("typesafe", "frobnicate");
		expect(h.notices.map((n) => n.level)).toEqual(["warning", "warning", "warning", "warning"]);
	});

	test("/typesafe test is bounded: one retry and a 12 s cap, because the command cannot be cancelled", async () => {
		const h = setup({}, [], { hasUI: true });
		await h.start();
		replies.other = { greeting: { type: "noul", noul: 0.97 } };
		h.notices.length = 0;
		await h.command("typesafe", "test");
		expect(mockState.calls).toHaveLength(1);
		expect(mockState.calls[0].opts).toMatchObject({ timeoutMs: LIMITS.probeAttemptMs, maxRetries: LIMITS.probeRetries, budgetMs: LIMITS.probeBudgetMs });
		expect(h.notices[0].message).toContain("noul=0.970");
	});

	test("/typesafe test reports a failure as an error notice", async () => {
		const h = setup({}, [], { hasUI: true });
		await h.start();
		mockState.respond = () => {
			throw new Error("boom");
		};
		h.notices.length = 0;
		await h.command("typesafe", "test");
		expect(h.notices).toEqual([{ message: "typesafe test failed: boom", level: "error" }]);
	});

	test("status shows an empty tool list, the effective model, the gate and a client error", async () => {
		const h = setup({ model: "jev-1.13.0", adversary: { tools: [] } }, [], { hasUI: true });
		await h.start();
		mockState.clientError = "typesafe_error: bad log level";
		await h.command("adversary", "gate off");
		h.notices.length = 0;
		await h.command("adversary", "status");
		const text = h.notices[0].message;
		expect(text).toContain("tools: none");
		expect(text).toContain("model: jev-1.13.0");
		expect(text).toContain("client error: typesafe_error: bad log level");
		expect(text).toContain("ambiguity gate: disabled (session override: off)");
	});

	test("dump writes into the profile-aware logs directory", async () => {
		const profile = join(root, "profiles", "work", "agent");
		mkdirSync(profile, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = profile;
		const h = setup({}, [], { hasUI: true, sessionId: "sess-9" });
		await h.start();
		await h.command("adversary", "dump");
		const path = join(root, "profiles", "work", "logs", "adversary-sess-9.json");
		expect(h.notices.at(-1)?.message).toBe(`adversary history written to ${path}`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
	});

	test("dump goes under a custom agent dir when it is not named agent, and sanitizes the session id", async () => {
		const custom = join(root, "custom-dir");
		mkdirSync(custom, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = custom;
		const h = setup({}, [], { hasUI: true, sessionId: "../../evil" });
		await h.start();
		await h.command("adversary", "dump");
		expect(existsSync(join(custom, "logs", "adversary-.._.._evil.json"))).toBe(true);
		expect(existsSync(join(root, "evil.json"))).toBe(false);
	});

	test("a dump that cannot be written is reported, not thrown", async () => {
		const dir = join(root, "broken-profile");
		mkdirSync(join(dir, "agent"), { recursive: true });
		writeFileSync(join(dir, "logs"), "i am a file, not a directory");
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		const h = setup({}, [], { hasUI: true });
		await h.start();
		h.notices.length = 0;
		await h.command("adversary", "dump");
		expect(h.notices.length).toBe(1);
		expect(h.notices[0].level).toBe("error");
		expect(h.notices[0].message).toContain("dump failed:");
	});
});

// ---- typesafe_ask ----------------------------------------------------------------------

describe("typesafe_ask", () => {
	const noulQuestion = (id: string, instructions: string) => ({ id, type: "noul", instructions });

	async function run(h: Harness, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		return h.tools.typesafe_ask.execute("call-1", params, signal, undefined, h.ctx);
	}

	test("a repeated question id is an error, not a silent overwrite", async () => {
		const h = setup();
		await h.start();
		const out = await run(h, { state: "x", questions: [noulQuestion("q", "about tests"), noulQuestion("q", "about docs")] });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toBe("typesafe_ask: duplicate question id: q");
		expect(mockState.calls.length).toBe(0);
	});

	test("an oversize choice and a __proto__ id are rejected before the API call", async () => {
		const h = setup();
		await h.start();
		const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, "d"]));
		const choice = (n: number) => run(h, { state: "x", questions: [{ id: "c", type: "choice", instructions: "pick", options: options(n) }] });
		const big = await choice(LIMITS.choiceOptionsMax + 1);
		expect(big.isError).toBe(true);
		expect(big.content[0].text).toContain(`at most ${LIMITS.choiceOptionsMax}`);
		const small = await choice(LIMITS.choiceOptionsMin - 1);
		expect(small.isError).toBe(true);
		expect(small.content[0].text).toContain(`at least ${LIMITS.choiceOptionsMin}`);
		const proto = await run(h, { state: "x", questions: [noulQuestion("__proto__", "x")] });
		expect(proto.isError).toBe(true);
		expect(mockState.calls.length).toBe(0);
	});

	test("the tool call's abort signal is passed through, and aborting ends the call", async () => {
		const h = setup();
		await h.start();
		mockState.respond = (call) =>
			new Promise<Answers>((_, reject) => {
				call.opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const controller = new AbortController();
		const pending = run(h, { state: "x", questions: [noulQuestion("q", "is it?")] }, controller.signal);
		await Bun.sleep(10);
		expect(mockState.calls[0].opts.signal).toBe(controller.signal);
		controller.abort();
		const out = await pending;
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toBe("typesafe_ask failed: aborted");
	});

	test("the call is retried twice at 10 s per attempt, and the tool's signal can stop it", async () => {
		const h = setup();
		await h.start();
		replies.other = { q: { type: "noul", noul: 0.4 } };
		const controller = new AbortController();
		await run(h, { state: "x", questions: [noulQuestion("q", "is it?")] }, controller.signal);
		expect(mockState.calls[0].opts).toMatchObject({ timeoutMs: LIMITS.askAttemptMs, maxRetries: LIMITS.askRetries, signal: controller.signal });
	});

	test("a model override is sent for that request only", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		replies.other = { q: { type: "noul", noul: 0.4 } };
		const out = await run(h, { state: "x", model: "jev-typo", questions: [noulQuestion("q", "is it?")] });
		expect(out.content[0].text).toBe("q.noul = 0.400");
		expect(mockState.calls[0].opts.model).toBe("jev-typo");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "a.ts" });
		expect(reviewCalls()[0].opts.model).toBeUndefined();
		expect(reviewCalls()[0].opts.signal).toBeUndefined();
	});

	test("a score needs 2 to 10 levels", async () => {
		const h = setup();
		await h.start();
		const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`);
		const ask = (n: number) => run(h, { state: "x", questions: [{ id: "s", type: "score", instructions: "rate it", levels: levels(n) }] });
		for (const n of [LIMITS.scoreLevelsMin - 1, LIMITS.scoreLevelsMax + 1, 40]) {
			const out = await ask(n);
			expect(out.isError).toBe(true);
			expect(out.content[0].text).toContain(`score requires ${LIMITS.scoreLevelsMin}-${LIMITS.scoreLevelsMax} levels`);
		}
		expect(mockState.calls.length).toBe(0);
		replies.other = { s: { type: "score", score: 3.2 } };
		expect((await ask(LIMITS.scoreLevelsMax)).isError).toBeUndefined();
		expect((await ask(LIMITS.scoreLevelsMin)).isError).toBeUndefined();
		expect(mockState.calls.length).toBe(2);
	});

	test("a json state is masked and repaired at any depth", async () => {
		const h = setup();
		await h.start();
		const nest = (depth: number, leaf: unknown): unknown => (depth === 0 ? leaf : { level: nest(depth - 1, leaf) });
		const strings = (value: unknown): string[] =>
			typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
		for (const depth of [3, 7, 8, 9, 12, 40]) {
			mockState.calls.length = 0;
			const state = JSON.stringify(nest(depth, { note: "ok \ud800 end", token: "ghp_" + "a".repeat(36), items: ["sk_live_abcdefghijklmnop1234"] }));
			await run(h, { state, stateFormat: "json", questions: [noulQuestion("q", "x")] });
			const sent = JSON.stringify(mockState.calls[0].state);
			expect(sent).not.toContain("ghp_");
			expect(sent).not.toContain("sk_live_abcdefghijklmnop1234");
			expect(sent).toContain("[REDACTED]");
			expect(strings(mockState.calls[0].state).every((text) => text.isWellFormed())).toBe(true);
		}
	});

	test("a secret that a deeper-than-walked json state holds under a secret-named quoted key is still masked", async () => {
		const h = setup();
		await h.start();
		let state: unknown = { config: '{"password": "hunter2hunter2"}' };
		for (let i = 0; i < 50; i++) state = { next: state };
		await run(h, { state: JSON.stringify(state), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		expect(JSON.stringify(mockState.calls[0].state)).not.toContain("hunter2hunter2");
	});

	test("a json state masks the value of a secret-named key whatever its depth, and leaves other values alone", async () => {
		const h = setup();
		await h.start();
		const nest = (depth: number, leaf: unknown): unknown => (depth === 0 ? leaf : { level: nest(depth - 1, leaf) });
		for (const depth of [0, 2, 20, 31, 32, 40]) {
			mockState.calls.length = 0;
			const leaf = { credentials: { user: "bob-the-user", password: "pa55w0rdZZ" }, api_key: "plainvalue99", dbPassword: 12345678, retries: 3, max_tokens: 1500, label: "kept as is", tokens: ["tok-aaaa", "tok-bbbb"], flag: true, nothing: null };
			await run(h, { state: JSON.stringify(nest(depth, leaf)), stateFormat: "json", questions: [noulQuestion("q", "x")] });
			const sent = JSON.stringify(mockState.calls[0].state);
			for (const secret of ["pa55w0rdZZ", "bob-the-user", "plainvalue99", "12345678", "tok-aaaa", "tok-bbbb"]) expect(sent).not.toContain(secret);
			// Below the walked depth the leaf arrives as JSON text; either way the same fields survive.
			let sentLeaf: any = mockState.calls[0].state;
			while (typeof sentLeaf === "string" || "level" in sentLeaf) sentLeaf = typeof sentLeaf === "string" ? JSON.parse(sentLeaf) : sentLeaf.level;
			expect(sentLeaf).toMatchObject({ retries: 3, max_tokens: 1500, label: "kept as is", flag: true, nothing: null });
		}
	});

	test("a json state keeps its object structure down to 32 levels and is flattened to text below that", async () => {
		const h = setup();
		await h.start();
		const nest = (depth: number): unknown => (depth === 0 ? { note: "kept" } : { level: nest(depth - 1) });
		await run(h, { state: JSON.stringify(nest(20)), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		expect(mockState.calls[0].state).toEqual(nest(20));

		await run(h, { state: JSON.stringify(nest(40)), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		let sent: any = mockState.calls[1].state;
		for (let i = 0; i < 32; i++) sent = sent.level;
		expect(typeof sent).toBe("string");
		expect(JSON.parse(sent)).toEqual(nest(8));
	});

	test("a secret-named key is masked even when its value would match no pattern, and a short value is left", async () => {
		const h = setup();
		await h.start();
		await run(h, { state: JSON.stringify({ password: "correct horse battery staple", secret: "ab", token: 42 }), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		expect(mockState.calls[0].state).toEqual({ password: "[REDACTED]", secret: "ab", token: 42 });
	});

	// Below these lengths a value under a secret-named key is left to the patterns: `max_tokens: 1500` is not a secret.
	test("the length from which a value under a secret-named key is masked, for strings and for numbers", async () => {
		const h = setup();
		await h.start();
		const string = (n: number) => "s".repeat(n);
		const number = (digits: number) => Number("7".repeat(digits));
		const state = {
			password: string(LIMITS.secretStringMin - 1),
			passphrase: string(LIMITS.secretStringMin),
			token: number(LIMITS.secretNumberMin - 1),
			api_key: number(LIMITS.secretNumberMin),
		};
		await run(h, { state: JSON.stringify(state), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		expect(mockState.calls[0].state).toEqual({ password: state.password, passphrase: "[REDACTED]", token: state.token, api_key: "[REDACTED]" });
	});

	test("with adversary.redact off a secret-named key is not masked either", async () => {
		const h = setup({ adversary: { redact: false } });
		await h.start();
		await run(h, { state: JSON.stringify({ password: "correct horse battery staple" }), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		expect(mockState.calls[0].state).toEqual({ password: "correct horse battery staple" });
	});

	test("the question text is masked and repaired like the state, and ids and option names are masked by pattern only", async () => {
		const h = setup();
		await h.start();
		const key = "sk_live_abcdefghijklmnop1234";
		await run(h, {
			state: "x",
			questions: [
				{ id: "token_check", type: "noul", instructions: `Is key ${key} valid? \ud800`, whenTrue: "AKIAABCDEFGHIJKLMNOP is set", whenFalse: "nothing set" },
				{ id: "pick", type: "choice", instructions: "Which?", options: { password_reset: `use ${key}`, plain: "no secret" } },
				{ id: "rate", type: "score", instructions: "Rate it", levels: ["bad \ud83d", `needs ${key}`, "ok"] },
			],
		});
		const questions = mockState.calls[0].questions;
		const wire = JSON.stringify(questions);
		expect(wire).not.toContain(key);
		expect(wire).not.toContain("AKIAABCDEFGHIJKLMNOP");
		expect(wire).toContain("[REDACTED]");
		expect(questions.token_check.instructions).toContain("�");
		expect(questions.token_check.instructions.isWellFormed()).toBe(true);
		expect(questions.rate.levels[0].isWellFormed()).toBe(true);
		// Ids and option names are structure: a name that merely looks like a secret's must not blank the question.
		expect(Object.keys(questions)).toEqual(["token_check", "pick", "rate"]);
		expect(questions.token_check.instructions).toContain("Is key");
		expect(Object.keys(questions.pick.criteria)).toEqual(["password_reset", "plain"]);
		expect(questions.pick.criteria.plain).toBe("no secret");
		expect(questions.pick.criteria.password_reset).toBe("use [REDACTED]");
	});

	// A model can write a secret as a question id or an option name; both go to the API as written otherwise.
	test("a secret written as a question id or an option name is masked, and answers come back under the masked id", async () => {
		const h = setup();
		await h.start();
		const slack = "xoxb-1234567890-abcdefghij";
		const github = "ghp_" + "a".repeat(36);
		replies.other = { "[REDACTED]": { type: "noul", noul: 0.4 } };
		const out = await run(h, {
			state: "x",
			questions: [
				{ id: github, type: "noul", instructions: "Is it valid?" },
				{ id: "pick", type: "choice", instructions: "Which?", options: { [slack]: "the Slack bot token", AKIAABCDEFGHIJKLMNOP: "the AWS key", "[REDACTED]": "taken", plain: "no secret" } },
			],
		});
		expect(out.isError).toBeUndefined();
		const questions = mockState.calls[0].questions;
		const wire = JSON.stringify(questions);
		for (const secret of [slack, github, "AKIAABCDEFGHIJKLMNOP"]) expect(wire).not.toContain(secret);
		expect(Object.keys(questions)).toEqual(["[REDACTED]", "pick"]);
		// None of the masked names overwrote another: three options that mask to `[REDACTED]` are still three.
		expect(Object.keys(questions.pick.criteria)).toEqual(["[REDACTED]", "[REDACTED]#2", "[REDACTED]#3", "plain"]);
		expect(Object.values(questions.pick.criteria)).toEqual(["the Slack bot token", "the AWS key", "taken", "no secret"]);
	});

	test("with adversary.redact off ids and option names are left as written", async () => {
		const h = setup({ adversary: { redact: false } });
		await h.start();
		const slack = "xoxb-1234567890-abcdefghij";
		await run(h, { state: "x", questions: [{ id: slack, type: "choice", instructions: "Which?", options: { [slack + "-b"]: "one", plain: "two" } }] });
		const questions = mockState.calls[0].questions;
		expect(Object.keys(questions)).toEqual([slack]);
		expect(Object.keys(questions[slack].criteria)).toEqual([slack + "-b", "plain"]);
	});

	// An object key is a string the model or a file wrote: a token used as a map key must not leave, at any depth.
	test("a json state masks a secret used as an object key, above and below the depth where it is flattened to text", async () => {
		const h = setup();
		await h.start();
		const token = "ghp_" + "a".repeat(36);
		const dsn = "postgres://admin:hunter2pw@db/x";
		const nest = (depth: number, leaf: unknown): unknown => (depth === 0 ? leaf : { level: nest(depth - 1, leaf) });
		for (const depth of [0, 5, 31, 32, 33, 40]) {
			mockState.calls.length = 0;
			await run(h, { state: JSON.stringify(nest(depth, { [token]: "alice", [dsn]: 1, kept: "as is" })), stateFormat: "json", questions: [noulQuestion("q", "x")] });
			const sent = JSON.stringify(mockState.calls[0].state);
			expect([depth, sent.includes(token), sent.includes("hunter2pw")]).toEqual([depth, false, false]);
			expect(sent).toContain("alice");
			expect(sent).toContain("as is");
		}
	});

	test("with adversary.redact off an object key is sent as written", async () => {
		const h = setup({ adversary: { redact: false } });
		await h.start();
		const token = "ghp_" + "a".repeat(36);
		await run(h, { state: JSON.stringify({ [token]: "alice" }), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		expect(mockState.calls[0].state).toEqual({ [token]: "alice" });
	});

	test("with adversary.redact off the question text keeps its secrets but is still repaired", async () => {
		const h = setup({ adversary: { redact: false } });
		await h.start();
		await run(h, { state: "x", questions: [noulQuestion("q", "Is sk_live_abcdefghijklmnop1234 valid? \ud800")] });
		const instructions = mockState.calls[0].questions.q.instructions as string;
		expect(instructions).toContain("sk_live_abcdefghijklmnop1234");
		expect(instructions.isWellFormed()).toBe(true);
	});

	test("the state is redacted and repaired before it leaves, with a json state too", async () => {
		const h = setup();
		await h.start();
		await run(h, { state: "token sk_live_abcdefgh12345678 and a lone \ud800 surrogate", questions: [noulQuestion("q", "x")] });
		expect(mockState.calls[0].state).not.toContain("sk_live_abcdefgh12345678");
		expect(mockState.calls[0].state).toContain("�");
		await run(h, { state: JSON.stringify({ env: { KEY: "AKIAABCDEFGHIJKLMNOP" } }), stateFormat: "json", questions: [noulQuestion("q", "x")] });
		expect(JSON.stringify(mockState.calls[1].state)).not.toContain("AKIAABCDEFGHIJKLMNOP");
	});
});

// ---- documented caps ---------------------------------------------------------------------
// The README's "What leaves your machine" table, measured: oversize input goes through each path and the length of
// what is sent is compared with ./limits (docs.test.ts holds the README to the same list).

describe("every cap the README documents holds, and is the documented size", () => {
	const text = (n: number, ch = "x") => ch.repeat(n);
	const toolResultEntry = (body: string, name = "bash") => ({ type: "message", message: { role: "toolResult", toolName: name, content: [{ type: "text", text: body }] } });
	const turnEnd = (h: Harness, i = 0) => h.fire("turn_end", { turnIndex: i, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });

	test("action review: task, tool input, result, the agent's claim and the previous tool results", async () => {
		const prior = Array.from({ length: 5 }, (_, i) => toolResultEntry(`out ${i} ${text(500)}`));
		const h = setup({}, [userMsg(text(5000)), asstMsg(text(5000)), ...prior]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: text(9000, "c") }, text(9000, "r"));
		const state = reviewCalls()[0].state;
		expect(state.task.length).toBe(LIMITS.task);
		expect(state.action.input.length).toBe(LIMITS.toolInput);
		expect(state.result.length).toBe(LIMITS.toolResult);
		expect(state.claimed_intent.length).toBe(LIMITS.claimedIntent);
		expect(state.prior_actions).toHaveLength(LIMITS.priorActions);
		expect(state.prior_actions.at(-1)).toBe(`bash: out 4 ${text(500)}`.slice(0, "bash: ".length + 120));
	});

	test("message review: the message and the recent actions", async () => {
		const h = setup({}, [userMsg("go"), ...Array.from({ length: 9 }, (_, i) => toolResultEntry(`out ${i}`))]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: text(9000) }] } });
		const state = reviewCalls()[0].state;
		expect(state.assistant_message.length).toBe(LIMITS.assistantMessage);
		expect(state.recent_actions).toHaveLength(LIMITS.recentActions);
	});

	test("turn review: the transcript delta", async () => {
		const h = setup({}, [userMsg("start")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		h.branch.push(...Array.from({ length: 8 }, (_, i) => asstMsg(`step ${i} ${text(1400)}`)));
		await turnEnd(h);
		expect(reviewCalls()[0].state.delta.length).toBe(LIMITS.turnDelta);
	});

	test("stop gate: the final message, and a 4 s timeout with no retry", async () => {
		const h = setup({ stopGate: { enabled: true } }, [userMsg("ship it")]);
		await h.start();
		await h.fire("session_stop", { last_assistant_message: text(9000) });
		const call = mockState.calls[0];
		expect(call.state.final_assistant_message.length).toBe(LIMITS.stopGateMessage);
		expect(call.opts).toMatchObject({ timeoutMs: LIMITS.stopGateTimeoutMs, maxRetries: 0 });
	});

	test("ambiguity gate: the first prompt, the plan text so far and the kept replies", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers(4, 0.9);
		await h.fire("before_agent_start", { prompt: text(9000) });
		await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: text(9000) }] } });
		for (let i = 0; i < LIMITS.userReplies + 3; i++) await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `${i} ${text(900)}` }] } });
		expect(ambiguity.getUserReplies()).toHaveLength(LIMITS.userReplies);
		expect(ambiguity.getUserReplies().every((r) => r.length === LIMITS.replyChars)).toBe(true);
		expect(ambiguity.getUserReplies()[0].startsWith("3 ")).toBe(true);
		h.branch.push(userMsg(text(9000)), asstMsg(text(9000)));
		await turnEnd(h);
		const state = gateCalls().at(-1)!.state;
		expect(state.task.length).toBe(LIMITS.planPrompt);
		expect(state.plan_so_far.length).toBe(LIMITS.planSoFar);
	});

	test("ambiguity gate: an answer and its question are cut to the documented length", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "q" }] }, "q: x", { details: { question: text(900, "q"), selectedOptions: [text(900, "a")] } });
		const [asked] = ambiguity.getAsks();
		expect(asked.question.length).toBe(LIMITS.replyChars);
		expect(asked.answer.length).toBe(LIMITS.replyChars);
	});

	test("the last user message is the task, at the documented length, in every review kind", async () => {
		const h = setup({}, [userMsg(text(3000))]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: text(400) }] } });
		h.branch.push(asstMsg("done"));
		await turnEnd(h);
		expect(reviewCalls().map((c) => c.state.task.length)).toEqual([LIMITS.task, LIMITS.task]);
	});
});

// ---- egress ----------------------------------------------------------------------------

describe("what leaves the machine", () => {
	const SECRET_RESULT = "STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234\nDATABASE_URL=postgres://admin:hunter2pass@db.internal/prod";

	test("tool input, results and the transcript are redacted, and lone surrogates repaired", async () => {
		const h = setup({}, [userMsg("deploy it with key sk_live_zyxwvutsrqponm9876"), asstMsg("Looking at the env file")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: "cat .env && echo \ud800" }, SECRET_RESULT);
		const wire = JSON.stringify(reviewCalls()[0].state);
		expect(wire).not.toContain("sk_live_abcdefghijklmnop1234");
		expect(wire).not.toContain("hunter2pass");
		expect(wire).not.toContain("sk_live_zyxwvutsrqponm9876");
		expect(wire).toContain("[REDACTED]");
		expect(wire).toContain("�");
	});

	test("quoted secrets in a tool input are masked, JSON escaping notwithstanding", async () => {
		const h = setup({}, [userMsg("set up config")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "write", "w1", { path: "config.json", content: '{"password": "hunter2hunter2", "api_key": "abcd1234efgh"}' });
		await toolResult(h, "bash", "b1", { command: 'export API_KEY="abcd1234efgh5678" && ./deploy' });
		const inputs = reviewCalls().map((c) => c.state.action.input as string);
		expect(inputs).toHaveLength(2);
		for (const input of inputs) {
			expect(input).not.toContain("hunter2hunter2");
			expect(input).not.toContain("abcd1234efgh");
			expect(input).toContain("[REDACTED]");
		}
		expect(inputs[1]).toContain("./deploy");
	});

	test("a secret that straddles the input's length cap is masked before the cut, not leaked in part", async () => {
		const h = setup({}, [userMsg("set up config")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		const content = `${"x".repeat(2955)}API_KEY="abcd1234efgh5678"${"y".repeat(100)}`;
		await toolResult(h, "write", "w1", { path: "a.env", content });
		const input = reviewCalls()[0].state.action.input as string;
		expect(input).not.toContain("abcd");
		expect(input).toContain("API_KEY=\\\"[REDACTE");
	});

	test("a value under a secret-named key that straddles the input's cap is masked whole, not cut in half", async () => {
		const h = setup({}, [userMsg("set up config")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "write", "w1", { filler: "x".repeat(2960), password: "hunter2hunter2hunter2" });
		await toolResult(h, "write", "w2", { filler: "x".repeat(2940), nested: { api_key: "abcd1234efgh5678", other: "ok" } });
		for (const call of reviewCalls()) {
			const input = call.state.action.input as string;
			expect(input).not.toContain("hunter2");
			expect(input).not.toContain("abcd1234");
		}
	});

	test("a huge string in a tool input is not masked in full: only the part that can be shown is", async () => {
		const h = setup({}, [userMsg("write the file")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		// Masking all of 39 MB takes about 3 s (it is linear: about 75 ms a megabyte); cutting first to the window of
		// 4x the 3000 characters that are shown takes none. Dropping the cut is the only way to be over the limit.
		const content = `${"line of text\n".repeat(3_000_000)}password="hunter2hunter2"`;
		const started = performance.now();
		await toolResult(h, "write", "w1", { path: "big.txt", content });
		expect(performance.now() - started).toBeLessThan(600);
		expect((reviewCalls()[0].state.action.input as string).length).toBeLessThanOrEqual(3000);
	});

	// Tool output and file content are untrusted text; a masking pattern that is quadratic on them stalls omp's single thread.
	test("hostile text in a tool input, a tool result and a typesafe_ask state is masked in bounded time", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		const hostile = [`password="${"\\".repeat(64000)}`, "token:".repeat(20000), `password:\\"${"\\\\".repeat(30000)}`, "eyJ-".repeat(30000)];
		const started = performance.now();
		for (const [i, text] of hostile.entries()) {
			await toolResult(h, "write", `w${i}`, { path: "a.txt", content: text }, text);
			await h.tools.typesafe_ask.execute("t", { state: text, questions: [{ id: "q", type: "noul", instructions: text }] }, undefined, undefined, h.ctx);
		}
		expect(performance.now() - started).toBeLessThan(1500);
		expect(reviewCalls().length).toBe(hostile.length);
	});

	// A cap that lands inside a secret used to leave its front half (`ghp_` plus a few characters matches no pattern).
	describe("a cut never leaves half a secret", () => {
		const TOKEN = `ghp_${"Qk7Zr2Lm9Xw4Vb6Nc8Td3Hf5Jg1Ps0Yq"}`;
		/** Text whose cap-th character falls 15 characters into a token. */
		const straddling = (cap: number, prefix = "") => `${prefix}${"x".repeat(cap - prefix.length - 16)} ${TOKEN}${" tail".repeat(10)}`;
		const noToken = (state: unknown) => {
			const wire = JSON.stringify(state);
			expect(wire).not.toContain("ghp_");
			expect(wire).not.toContain("Qk7Zr2");
			expect(wire).not.toContain("Td3Hf5Jg1Ps0Yq");
		};
		const toolResultEntry = (text: string) => ({ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] } });

		test("tool result (2000)", async () => {
			const h = setup({}, [userMsg("go")]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			await toolResult(h, "bash", "c1", { command: "ls" }, straddling(2000));
			noToken(reviewCalls()[0].state);
			expect(reviewCalls()[0].state.result).toContain("xxx");
		});

		test("assistant message (4000)", async () => {
			const h = setup({}, [userMsg("go")]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: straddling(4000) }] } });
			noToken(reviewCalls()[0].state);
		});

		test("task and claimed intent in an action review (1200, 800), and the previous actions (120)", async () => {
			const h = setup({}, [userMsg(straddling(1200)), asstMsg(straddling(800)), toolResultEntry(straddling(120)), toolResultEntry(straddling(120))]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			await toolResult(h, "bash", "c1", { command: "ls" }, "fine");
			const state = reviewCalls()[0].state;
			noToken(state);
			expect(state.task).toContain("xxx");
			expect(state.claimed_intent).toContain("xxx");
			expect(state.prior_actions[0]).toContain("xxx");
		});

		test("recent actions in a message review (120) and the task there (1200)", async () => {
			const h = setup({}, [userMsg(straddling(1200)), toolResultEntry(straddling(120))]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "A reply long enough to be reviewed, ".repeat(10) }] } });
			noToken(reviewCalls()[0].state);
		});

		test("every part of a turn's delta (user 800, assistant 1500, result line 200, call preview 160)", async () => {
			const h = setup({}, [userMsg("plain start")]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			const call = { type: "toolCall", name: "bash", input: { command: straddling(160, 'echo "') } };
			h.branch.push(
				userMsg(straddling(800)),
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: straddling(1500) }, call] } },
				toolResultEntry(straddling(200)),
			);
			await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
			noToken(reviewCalls()[0].state);
			expect(reviewCalls()[0].state.delta).toContain("xxx");
		});

		// A pattern alone cannot see `{ tokens: ["..."] }`: the tool-call previews of a turn review are masked by key too.
		test("the tool-call previews of a turn review mask what sits under a secret-named key, like an action review's input", async () => {
			const h = setup({}, [userMsg("deploy it")]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			const inputs = [{ tokens: ["abcd1234efgh5678"] }, { credentials: { user: "bob-the-user", pwd: "hunter2hunter2" } }, { api_key: 12345678901 }];
			h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "deploying" }, ...inputs.map((input) => ({ type: "toolCall", name: "bash", input }))] } });
			await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
			const delta = reviewCalls()[0].state.delta as string;
			for (const secret of ["abcd1234efgh5678", "bob-the-user", "hunter2hunter2", "12345678901"]) expect(delta).not.toContain(secret);
			expect(delta).toContain('call bash: {"api_key":"[REDACTED]"}');
		});

		test("the stop gate's final message (2000), from the host and from the branch", async () => {
			const h = setup({ stopGate: { enabled: true } }, [userMsg("ship it"), asstMsg(straddling(2000))]);
			await h.start();
			await h.fire("session_stop", { last_assistant_message: straddling(2000) });
			await h.fire("agent_start");
			await h.fire("session_stop", {});
			expect(mockState.calls.length).toBe(2);
			for (const call of mockState.calls) noToken(call.state);
		});

		test("the gate's task (4000) and the tail of the plan text (6000)", async () => {
			const h = setup({}, [planMode()], { hasUI: true });
			await h.start();
			replies.gate = gateAnswers();
			await h.fire("before_agent_start", { prompt: straddling(4000) });
			noToken(gateCalls()[0].state);
			// plan_so_far keeps the last 6000 characters; the token's front half is what the window start would cut off.
			h.branch.push(userMsg("plan it"), asstMsg(`${TOKEN}${"y".repeat(5985)}`));
			await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
			const state = gateCalls().at(-1)!.state;
			noToken(state);
			expect(state.plan_so_far.length).toBeLessThanOrEqual(6000);
		});

		test("answers and replies kept for the gate (400)", async () => {
			const h = setup({}, [planMode()], { hasUI: true });
			await h.start();
			replies.gate = gateAnswers(4, 0.9);
			await h.fire("before_agent_start", { prompt: "Add rate limiting to the orders API" });
			await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "Add rate limiting to the orders API" }] } });
			await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: straddling(400) }] } });
			expect(ambiguity.getUserReplies()).toHaveLength(1);
			noToken(ambiguity.getUserReplies());
			await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Which key?" }] }, "q: x", { details: { question: "Which key?", selectedOptions: [straddling(400)] } });
			noToken(ambiguity.getAsks());
		});
	});

	// The reviewers differ in what they send, and each was once able to lose its masking on its own.
	describe("every review kind masks and repairs what it sends", () => {
		const KEY = "sk_live_abcdefghijklmnop1234";
		const dirty = (label: string) => `${label} uses ${KEY} and a lone \ud800 surrogate, then DATABASE_URL=postgres://admin:hunter2pass@db/prod`;

		const expectClean = (state: Record<string, unknown>, fields: string[]) => {
			const wire = JSON.stringify(state);
			expect(wire).not.toContain(KEY);
			expect(wire).not.toContain("hunter2pass");
			for (const field of fields) {
				const text = state[field] as string;
				expect(text).toContain("[REDACTED]");
				expect(text.isWellFormed()).toBe(true);
			}
		};

		test("the turn review", async () => {
			const h = setup({}, [userMsg("plain start")]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			h.branch.push(userMsg(dirty("The task")), asstMsg(dirty("The assistant")));
			await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
			expect(reviewCalls().length).toBe(1);
			expectClean(reviewCalls()[0].state, ["delta", "task"]);
		});

		test("the message review", async () => {
			const h = setup({}, [userMsg(dirty("The task"))]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			const text = `${dirty("The assistant")} ${"and more words ".repeat(20)}`;
			await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
			expect(reviewCalls().length).toBe(1);
			expectClean(reviewCalls()[0].state, ["assistant_message", "task"]);
		});

		test("the action review", async () => {
			const h = setup({}, [userMsg(dirty("The task"))]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			await toolResult(h, "bash", "c1", { command: `echo ${KEY}` }, dirty("The output"));
			expectClean(reviewCalls()[0].state, ["result", "task"]);
		});

		test("a mask that is turned off stays off for every kind, and text is still repaired", async () => {
			const h = setup({ adversary: { redact: false } }, [userMsg("plain start")]);
			await h.start();
			await h.fire("turn_start", { turnIndex: 0 });
			h.branch.push(userMsg(dirty("The task")), asstMsg(dirty("The assistant")));
			await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
			const state = reviewCalls()[0].state;
			expect(state.delta).toContain(KEY);
			expect((state.delta as string).isWellFormed()).toBe(true);
		});
	});

	describe("evidence honours adversary.redact", () => {
		const KEY = "sk_live_abcdefghijklmnop1234";
		/** repoGit() whose file diff, grep hit and changed-file name all carry a secret. */
		const leakyGit = () => {
			const base = repoGit();
			return async (cmd: string, args: string[]): Promise<unknown> => {
				switch (subcommand(args)) {
					case "diff":
						if (args.includes("--stat") || args.includes("--name-only")) return base(cmd, args);
						return { code: 0, stdout: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export function fetchUser() {}\n+const KEY = "${KEY}";\n` };
					case "status":
						return { code: 0, stdout: ` M src/${KEY}.ts\0` };
					default:
						return base(cmd, args);
				}
			};
		};

		test("evidence in an action review is masked by default and raw when redact is off", async () => {
			for (const redact of [true, false]) {
				mockState.calls = [];
				const h = setup({ adversary: { redact } }, [userMsg("rename it")]);
				await h.start();
				h.exec = leakyGit();
				await h.fire("turn_start", { turnIndex: 0 });
				await toolResult(h, "edit", "c1", { path: "src/a.ts" });
				const evidence = JSON.stringify(reviewCalls()[0].state.evidence);
				expect(evidence.includes(KEY)).toBe(!redact);
				expect(evidence).toContain("src/");
			}
		});

		test("evidence in a turn review is masked by default and raw when redact is off", async () => {
			for (const redact of [true, false]) {
				mockState.calls = [];
				const h = setup({ adversary: { redact } }, [userMsg("rename it")]);
				await h.start();
				h.exec = leakyGit();
				await h.fire("turn_start", { turnIndex: 0 });
				h.branch.push(asstMsg("Renamed fetchUser to getUser."));
				await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
				const evidence = JSON.stringify(reviewCalls()[0].state.evidence);
				expect(evidence.includes(KEY)).toBe(!redact);
			}
		});

		test("the gate's git status is masked by default and raw when redact is off", async () => {
			for (const redact of [true, false]) {
				mockState.calls = [];
				const h = setup({ adversary: { redact } }, [planMode()], { hasUI: true });
				await h.start();
				h.exec = leakyGit();
				replies.gate = gateAnswers();
				await h.fire("before_agent_start", { prompt: "Make the importer better" });
				expect(JSON.stringify(gateCalls()[0].state.evidence).includes(KEY)).toBe(!redact);
			}
		});
	});

	test("adversary.redact false sends text as is", async () => {
		const h = setup({ adversary: { redact: false } }, [userMsg("go")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: "cat .env" }, SECRET_RESULT);
		expect(JSON.stringify(reviewCalls()[0].state)).toContain("sk_live_abcdefghijklmnop1234");
	});

	// The commands-run evidence is text like the rest of it: redact false sends it as written, and redact on masks it.
	test.each([false, true])("with adversary.redact %p the commands-run evidence follows the setting", async (redact) => {
		const token = `ghp_${"Z".repeat(36)}`;
		const h = setup({ adversary: { redact } }, [userMsg("go")]);
		await h.start();
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "bash", "c1", { command: `export GITHUB_TOKEN=${token} && ls` }, "ok");
		const commands = reviewCalls()[0].state.evidence.commandsRun as string[];
		expect(commands).toEqual([redact ? "bash: export GITHUB_TOKEN=[REDACTED] && ls [ok]" : `bash: export GITHUB_TOKEN=${token} && ls [ok]`]);
	});

	test("the gate's task, plan and answers are redacted too", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Use the key sk_live_abcdefghijklmnop1234 to plan billing" });
		expect(JSON.stringify(gateCalls()[0].state)).not.toContain("sk_live_abcdefghijklmnop1234");
	});
});

// ---- TYPESAFE_BENCH_LOG ------------------------------------------------------------------

describe("bench log", () => {
	async function shutdown(h: Harness): Promise<any> {
		const path = join(root, `bench-${Math.random().toString(36).slice(2)}.json`);
		process.env.TYPESAFE_BENCH_LOG = path;
		await h.fire("session_shutdown");
		return JSON.parse(readFileSync(path, "utf8"));
	}

	test("reports the effective role, phases and config, the full history and historyDropped", async () => {
		const h = setup({ model: "jev-1.13.0", phases: ["execute"], adversary: { reviewMessages: false } }, [userMsg("go")], { hasUI: true });
		await h.start();
		await h.command("adversary", "role advisory");
		await h.command("adversary", "gate off");
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "c1", { path: "a.ts" });
		const log = await shutdown(h);
		expect(Object.keys(log).sort()).toEqual(
			["ambiguity", "config", "costUsd", "history", "historyDropped", "lastResolvedModel", "phases", "role", "stats", "subagentSessionsSkipped", "usage"].sort(),
		);
		expect(log.role).toBe("advisory");
		expect(log.phases).toEqual(["execute"]);
		expect(log.config).toEqual({
			role: "advisory",
			phases: ["execute"],
			model: "jev-1.13.0",
			adversaryEnabled: true,
			reviewActions: true,
			reviewMessages: false,
			reviewTurns: true,
			ambiguityGateEnabled: false,
		});
		expect(log.historyDropped).toBe(0);
		expect(log.stats.historyDropped).toBe(0);
		expect(log.history.length).toBe(1);
		expect(log.history[0].role).toBe("advisory");
		expect(log.costUsd).toBe(0.25);
		expect(log.lastResolvedModel).toBe("jev-test");
		expect(log.usage.requests).toBe(1);
		expect(log.ambiguity).toEqual({ scores: [], asksObserved: 0 });
		expect(log.subagentSessionsSkipped).toBe(0);
	});

	test("config follows session overrides: adversary off, gate on", async () => {
		const h = setup({ adversary: { enabled: true }, ambiguityGate: { enabled: false } });
		await h.start();
		await h.command("adversary", "off");
		await h.command("adversary", "gate on");
		const log = await shutdown(h);
		expect(log.config.adversaryEnabled).toBe(false);
		expect(log.config.ambiguityGateEnabled).toBe(true);
	});

	test("history is not cut at 50 records", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		for (let i = 0; i < 60; i++) {
			if (i % 32 === 0) await h.fire("agent_start");
			if (i % 8 === 0) await h.fire("turn_start", { turnIndex: i / 8 });
			await toolResult(h, "edit", `c${i}`, { path: `f${i}.ts` });
		}
		const log = await shutdown(h);
		expect(log.history.length).toBe(60);
		expect(log.historyDropped).toBe(0);
	});

	test("nothing is written without TYPESAFE_BENCH_LOG", async () => {
		const h = setup();
		await h.start();
		await h.fire("session_shutdown");
		expect(h.warns.length).toBe(0);
	});
});

// ---- subagent sessions ---------------------------------------------------------------------

describe("subagent sessions", () => {
	const MAIN = { kind: "main", id: "Main", name: "main", depth: 0 };
	const SUB = { kind: "sub", id: "GleamingHalibut", name: "task", depth: 1, parentId: "Main" };
	const subagents = () => subagentModule.getSubagentStats();

	/** `ctx` with an `agent`, defined the way omp defines it: not enumerable, so a spread of the ctx would lose it. */
	function asAgent(ctx: Record<string, any>, agent: object | undefined): Record<string, any> {
		const copy = { ...ctx };
		if (agent) Object.defineProperty(copy, "agent", { value: agent, enumerable: false });
		return copy;
	}

	/** A subagent's ctx: its own session and branch, in the parent's process. */
	function subCtx(h: Harness, options: { branch?: unknown[]; sessionId?: string; agent?: object } = {}): Record<string, any> {
		const branch = options.branch ?? [userMsg("sub task")];
		return asAgent({ ...h.ctx, sessionManager: { getBranch: () => branch, getSessionId: () => options.sessionId ?? "sub-1" } }, options.agent ?? SUB);
	}

	const bashResult = { toolName: "bash", toolCallId: "b1", input: { command: "bun test" }, content: [{ type: "text", text: "ok" }], isError: false };
	const editResult = { toolName: "edit", toolCallId: "e1", input: { path: "a.ts" }, content: [{ type: "text", text: "ok" }], isError: false };
	const longMessage = { message: { role: "assistant", content: [{ type: "text", text: "x".repeat(300) }] } };

	/** One prompt's worth of every hook that can review, gate, probe git or send, fired from `ctx` over `branch`. */
	async function drivePrompt(h: Harness, ctx: Record<string, any>, branch: unknown[]) {
		await h.fire("agent_start", {}, ctx);
		await h.fire("turn_start", { turnIndex: 0 }, ctx);
		const bash = await h.fire("tool_result", bashResult, ctx);
		const edit = await h.fire("tool_result", editResult, ctx);
		await h.fire("message_end", longMessage, ctx);
		branch.push(asstMsg("I changed a.ts and ran the tests."));
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		const stop = await h.fire("session_stop", { last_assistant_message: "Done!" }, ctx);
		return { bash, edit, stop };
	}

	/** A session that reviews everything, and a Jev that finds something in all of it. */
	function reviewingSession(): Harness {
		const h = setup({ stopGate: { enabled: true } }, [userMsg("go")]);
		h.exec = repoGit();
		replies.review = reviewAnswers("action", "adversarial", 1.7, { breaks_contract: 0.9 });
		replies.stop = { verified: { type: "noul", noul: 0.05 }, left_unfinished: { type: "noul", noul: 0.9 } };
		return h;
	}

	test("the main session, with or without an identity, still reviews, probes git and sends", async () => {
		for (const agent of [undefined, MAIN]) {
			mockState.calls = [];
			const h = reviewingSession();
			await h.start();
			const out = await drivePrompt(h, asAgent(h.ctx, agent), h.branch);
			expect(reviewCalls().length).toBeGreaterThan(0);
			expect(out.edit?.content).toBeDefined();
			expect(out.stop?.continue).toBe(true);
			expect(gitCalls(h, "status").length).toBeGreaterThan(0);
			expect(subagents()).toEqual({ sessions: 0, hookCalls: 0 });
		}
	});

	test("every hook of a subagent session is a no-op: no review, no Jev call, no git, nothing sent", async () => {
		const h = reviewingSession();
		await h.start();
		const branch: unknown[] = [userMsg("sub task")];
		const out = await drivePrompt(h, subCtx(h, { branch }), branch);
		expect(out).toEqual({ bash: undefined, edit: undefined, stop: undefined });
		expect(mockState.calls).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(h.execCalls).toEqual([]);
		expect(reviewer.getReviewHistory()).toEqual([]);
		expect(subagents()).toEqual({ sessions: 1, hookCalls: 7 });
	});

	test("the plan hooks do nothing for a subagent: no plan_start note, no scoring, no gate on its plan write", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		const branch = [planMode(), userMsg("sub task")];
		const ctx = subCtx(h, { branch });
		expect(await h.fire("before_agent_start", { prompt: "sub task" }, ctx)).toBeUndefined();
		expect(await h.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: "xd://propose", content: "# Plan" } }, ctx)).toBeUndefined();
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "an answer" }] } }, ctx);
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Which db?" }] }, "q: pg", { details: { question: "Which db?", selectedOptions: ["pg"] } });
		expect(gateCalls()).toEqual([]);
		expect(scores()).toEqual([]);
		expect(h.sent).toEqual([]);
	});

	test.each(["session_start", "session_switch"])("%s from a subagent leaves the parent's gate, asks, overrides and client alone", async (event) => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "Make it better" });
		await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Which db?" }] }, "q: pg", { details: { question: "Which db?", selectedOptions: ["pg"] } });
		await h.command("adversary", "role advisory");
		await h.command("adversary", "off");
		expect(scores().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.hasSteered("goal")).toBe(true);
		const resets = mockState.resets;
		const labels = h.labels.length;
		const notices = h.notices.length;

		await h.fire(event, { reason: "new" }, subCtx(h));

		expect(scores().length).toBe(1);
		expect(ambiguity.asksObserved()).toBe(1);
		expect(ambiguity.hasSteered("goal")).toBe(true);
		expect(mockState.resets).toBe(resets);
		expect(h.labels.length).toBe(labels);
		expect(h.notices.length).toBe(notices);
		await h.command("adversary", "status");
		const status = h.notices.at(-1)!.message;
		expect(status).toContain("adversary: disabled (session override: off)");
		expect(status).toContain("role: advisory (session override: advisory)");
	});

	test("session_branch, session_tree and session_compact from a subagent do not move the parent's turn cursor", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		h.branch.push(asstMsg("Changed a.ts."));
		const long = Array.from({ length: 5 }, (_, i) => asstMsg(`sub ${i}`));
		for (const event of ["session_branch", "session_tree", "session_compact"]) await h.fire(event, {}, subCtx(h, { branch: long }));
		// With the cursor moved to the sub's 5 entries the parent's own delta (one entry) would be skipped.
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(reviewCalls().length).toBe(1);
	});

	test("a subagent's plan prompt does not replace the parent's objective", async () => {
		const h = setup({}, [planMode()], { hasUI: true });
		await h.start();
		replies.gate = gateAnswers();
		await h.fire("before_agent_start", { prompt: "the parent's task" });
		expect(gateCalls().length).toBe(1);

		const ctx = subCtx(h, { branch: [planMode(), userMsg("a worker's task")] });
		await h.fire("session_start", {}, ctx);
		expect(await h.fire("before_agent_start", { prompt: "a worker's task" }, ctx)).toBeUndefined();
		expect(gateCalls().length).toBe(1);

		await h.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: "xd://propose", content: "# Plan" } });
		expect(gateCalls().length).toBe(2);
		expect(gateCalls()[1].state.task).toBe("the parent's task");
	});

	test("a subagent's tool results neither add to the parent's commands-run evidence nor clear its per-turn dedupe", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0 });
		await toolResult(h, "edit", "e1", { path: "a.ts" });
		expect(reviewCalls().length).toBe(1);

		const ctx = subCtx(h);
		await h.fire("turn_start", { turnIndex: 0 }, ctx);
		await h.fire("tool_result", { ...bashResult, input: { command: "rm -rf build" } }, ctx);
		await toolResult(h, "edit", "e1", { path: "a.ts" });
		expect(reviewCalls().length).toBe(1);
		await toolResult(h, "edit", "e2", { path: "b.ts" });
		expect(reviewCalls().at(-1)!.state.evidence.commandsRun).toEqual([]);
	});

	test("a subagent's agent_start does not refund the parent's per-prompt review budget", async () => {
		const h = setup({}, [userMsg("go")]);
		await h.start();
		await h.fire("agent_start");
		for (let turn = 0; turn <= reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT; turn++) {
			await h.fire("turn_start", { turnIndex: turn });
			await h.fire("message_end", longMessage);
		}
		expect(reviewCalls().length).toBe(reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT);
		await h.fire("agent_start", {}, subCtx(h));
		await h.fire("message_end", longMessage);
		expect(reviewCalls().length).toBe(reviewer.MAX_MESSAGE_REVIEWS_PER_PROMPT);
	});

	describe("the bench log", () => {
		const benchPath = () => join(root, `bench-sub-${Math.random().toString(36).slice(2)}.json`);

		test("a subagent's shutdown writes nothing, and does not overwrite the parent's", async () => {
			const path = benchPath();
			process.env.TYPESAFE_BENCH_LOG = path;
			const h = setup({}, [userMsg("go")]);
			await h.start();
			await h.fire("agent_start");
			await h.fire("turn_start", { turnIndex: 0 });
			await toolResult(h, "edit", "e1", { path: "a.ts" });

			await h.fire("session_shutdown", {}, subCtx(h));
			expect(existsSync(path)).toBe(false);

			await h.fire("session_shutdown");
			const log = JSON.parse(readFileSync(path, "utf8"));
			expect(log.history.length).toBe(1);
			expect(log.usage.requests).toBe(1);
			await h.fire("session_shutdown", {}, subCtx(h, { sessionId: "sub-2" }));
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(log);
		});

		test("subagentSessionsSkipped counts sessions, not hook calls, and is 0 without subagents", async () => {
			const path = benchPath();
			process.env.TYPESAFE_BENCH_LOG = path;
			const h = setup({}, [userMsg("go")]);
			await h.start();
			await h.fire("session_shutdown");
			expect(JSON.parse(readFileSync(path, "utf8")).subagentSessionsSkipped).toBe(0);

			for (const event of ["session_start", "turn_start", "turn_end"]) await h.fire(event, {}, subCtx(h, { sessionId: "sub-1" }));
			for (const event of ["session_start", "turn_start"]) await h.fire(event, {}, subCtx(h, { sessionId: "sub-2" }));
			await h.fire("session_shutdown");
			expect(JSON.parse(readFileSync(path, "utf8")).subagentSessionsSkipped).toBe(2);
			expect(subagents().hookCalls).toBe(5);
		});

		test("the main session's own session_switch starts the count over, like the rest of its state", async () => {
			const h = setup({}, [userMsg("go")]);
			await h.start();
			await h.fire("session_start", {}, subCtx(h));
			expect(subagents().sessions).toBe(1);
			await h.fire("session_switch", { reason: "new" });
			expect(subagents()).toEqual({ sessions: 0, hookCalls: 0 });
		});
	});

	test("/adversary status shows the guard and what it skipped", async () => {
		const h = setup({}, [userMsg("go")], { hasUI: true });
		await h.start();
		await h.command("adversary", "status");
		expect(h.notices.at(-1)!.message).toContain("subagent guard: on; subagent sessions skipped=0 (hook calls skipped=0)");
		await h.fire("session_start", {}, subCtx(h, { sessionId: "s1" }));
		await h.fire("turn_start", {}, subCtx(h, { sessionId: "s1" }));
		await h.fire("session_start", {}, subCtx(h, { sessionId: "s2" }));
		await h.command("adversary", "status");
		expect(h.notices.at(-1)!.message).toContain("subagent guard: on; subagent sessions skipped=2 (hook calls skipped=3)");
	});

	test("typesafe_ask, /adversary and /typesafe keep working when called from a subagent's session", async () => {
		replies.other = { q: { type: "noul", noul: 0.4, confidence: 0.9 }, greeting: { type: "noul", noul: 0.9 } };
		const h = setup({}, [userMsg("go")], { hasUI: true });
		await h.start();
		const ctx = subCtx(h);
		const out = await h.tools.typesafe_ask.execute("call-1", { state: "s", questions: [{ id: "q", type: "noul", instructions: "i" }] }, undefined, undefined, ctx);
		expect(out.isError).toBeUndefined();
		expect(out.content[0].text).toContain("q.noul = 0.400");
		expect(mockState.calls.length).toBe(1);
		await h.commands.adversary.handler("off", ctx);
		await h.commands.adversary.handler("status", ctx);
		expect(h.notices.at(-1)!.message).toContain("adversary: disabled (session override: off)");
		await h.commands.typesafe.handler("test", ctx);
		expect(h.notices.at(-1)!.message).toContain("noul=0.900");
		expect(subagents()).toEqual({ sessions: 0, hookCalls: 0 });
	});

	describe("a host without ctx.agent", () => {
		test("a session header with a parent session is a subagent's session", async () => {
			const h = reviewingSession();
			await h.start();
			const resets = mockState.resets;
			const branch: unknown[] = [userMsg("sub task")];
			const ctx = {
				...h.ctx,
				sessionManager: { getBranch: () => branch, getSessionId: () => "sub-1", getHeader: () => ({ type: "session", parentSession: "/sessions/2026_abc.jsonl" }) },
			};
			await h.fire("session_start", {}, ctx);
			const out = await drivePrompt(h, ctx, branch);
			expect(out).toEqual({ bash: undefined, edit: undefined, stop: undefined });
			expect(mockState.calls).toEqual([]);
			expect(mockState.resets).toBe(resets);
			expect(subagents().sessions).toBe(1);
		});

		test("a forked main session has a parent session too, and is not skipped", async () => {
			const h = reviewingSession();
			await h.start();
			const ctx = {
				...h.ctx,
				sessionManager: {
					...h.ctx.sessionManager,
					getHeader: () => ({ type: "session", parentSession: "/sessions/2026_abc.jsonl" }),
					getSessionFile: () => "/sessions/2026_def.jsonl",
				},
			};
			await drivePrompt(h, ctx, h.branch);
			expect(reviewCalls().length).toBeGreaterThan(0);
			expect(subagents()).toEqual({ sessions: 0, hookCalls: 0 });
		});

		test("so is a main session whose ctx says it is the main agent, whatever its header says", async () => {
			const h = reviewingSession();
			await h.start();
			const ctx = asAgent({ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getHeader: () => ({ parentSession: "/sessions/2026_abc.jsonl" }) } }, MAIN);
			await drivePrompt(h, ctx, h.branch);
			expect(reviewCalls().length).toBeGreaterThan(0);
			expect(subagents()).toEqual({ sessions: 0, hookCalls: 0 });
		});
	});

	describe("TYPESAFE_SUBAGENT_GUARD", () => {
		test.each(["0", "false", "off"])("=%s runs every hook in subagent sessions again, as before the guard", async (value) => {
			const h = setup({}, [planMode()], { hasUI: true });
			await h.start();
			replies.gate = gateAnswers();
			await h.fire("before_agent_start", { prompt: "the parent's task" });
			expect(ambiguity.asksObserved()).toBe(0);
			await toolResult(h, "ask", "a1", { questions: [{ id: "q", question: "Which db?" }] }, "q: pg", { details: { question: "Which db?", selectedOptions: ["pg"] } });
			expect(ambiguity.asksObserved()).toBe(1);
			const resets = mockState.resets;

			process.env.TYPESAFE_SUBAGENT_GUARD = value;
			const ctx = subCtx(h, { branch: [planMode(), userMsg("a worker's task")] });
			await h.fire("session_start", {}, ctx);
			expect(mockState.resets).toBe(resets + 1);
			expect(ambiguity.asksObserved()).toBe(0);
			expect((await h.fire("before_agent_start", { prompt: "a worker's task" }, ctx))?.message).toBeDefined();
			expect(subagents()).toEqual({ sessions: 0, hookCalls: 0 });
			await h.command("adversary", "status");
			expect(h.notices.at(-1)!.message).toContain("subagent guard: off (TYPESAFE_SUBAGENT_GUARD); subagent sessions skipped=0 (hook calls skipped=0)");
		});

		test("=0 lets a subagent's tool results be reviewed and its shutdown write the bench log", async () => {
			process.env.TYPESAFE_SUBAGENT_GUARD = "0";
			const path = join(root, `bench-off-${Math.random().toString(36).slice(2)}.json`);
			process.env.TYPESAFE_BENCH_LOG = path;
			const h = setup({}, [userMsg("go")]);
			await h.start();
			const ctx = subCtx(h);
			await h.fire("turn_start", { turnIndex: 0 }, ctx);
			replies.review = reviewAnswers("action", "adversarial", 1.7, { breaks_contract: 0.9 });
			expect((await h.fire("tool_result", editResult, ctx))?.content).toBeDefined();
			expect(reviewCalls().length).toBe(1);
			await h.fire("session_shutdown", {}, ctx);
			expect(existsSync(path)).toBe(true);
		});

		test("=1 keeps it on, and a value it cannot read keeps it on and is warned about at session start", async () => {
			process.env.TYPESAFE_SUBAGENT_GUARD = "1";
			const h = setup({}, [userMsg("go")], { hasUI: true });
			await h.start();
			await h.fire("session_start", {}, subCtx(h));
			expect(subagents().sessions).toBe(1);

			process.env.TYPESAFE_SUBAGENT_GUARD = "disable";
			const g = setup({}, [userMsg("go")], { hasUI: true });
			await g.start();
			expect(g.notices.some((n) => n.level === "warning" && n.message.includes("TYPESAFE_SUBAGENT_GUARD"))).toBe(true);
			await g.fire("session_start", {}, subCtx(g));
			expect(subagents().sessions).toBe(1);
		});
	});

	test("an isolated agent's skips, from a fully fresh copy of src/, reach the parent's dump and status", async () => {
		// Not just a fresh index.ts (which would share its subagent.ts with this copy): a second copy of the whole module
		// graph, as omp loads for a worktree agent, with a counter module of its own.
		const isolatedSrc = join(root, "src-isolated");
		cpSync(srcCopy, isolatedSrc, { recursive: true });
		mock.module(join(isolatedSrc, "client.ts"), clientMock);
		const fresh = (await import(join(isolatedSrc, "index.ts"))) as typeof import("../src/index");
		const freshSubagent = (await import(join(isolatedSrc, "subagent.ts"))) as typeof import("../src/subagent");
		expect(freshSubagent.skipSubagent).not.toBe(subagentModule.skipSubagent);

		const path = join(root, `bench-isolated-copy-${Math.random().toString(36).slice(2)}.json`);
		process.env.TYPESAFE_BENCH_LOG = path;
		const parent = setup({}, [userMsg("go")], { hasUI: true });
		await parent.start();
		const worker = setup({}, [userMsg("go")], { factory: fresh.default });
		for (const event of ["session_start", "turn_start", "turn_end"]) await worker.fire(event, {}, subCtx(worker, { sessionId: "iso-1" }));
		await worker.fire("session_shutdown", {}, subCtx(worker, { sessionId: "iso-1" }));
		expect(existsSync(path)).toBe(false);
		expect(mockState.calls).toEqual([]);

		expect(subagents()).toEqual({ sessions: 1, hookCalls: 4 });
		await parent.command("adversary", "status");
		expect(parent.notices.at(-1)!.message).toContain("subagent guard: on; subagent sessions skipped=1 (hook calls skipped=4)");
		await parent.fire("session_shutdown");
		expect(JSON.parse(readFileSync(path, "utf8")).subagentSessionsSkipped).toBe(1);
	});

	test("an isolated agent, which runs a fresh copy of the extension, is as dormant", async () => {
		const fresh = (await import(`${join(srcCopy, "index.ts")}?isolated-agent`)) as typeof import("../src/index");
		expect(fresh.default).not.toBe(typesafeExtension);
		const h = setup({ stopGate: { enabled: true } }, [userMsg("go")], { factory: fresh.default });
		h.exec = repoGit();
		replies.review = reviewAnswers("action", "adversarial", 1.7, { breaks_contract: 0.9 });
		replies.stop = { verified: { type: "noul", noul: 0.05 }, left_unfinished: { type: "noul", noul: 0.9 } };
		// The fresh copy has not seen a session_start: its config is the default one, and the guard still holds.
		const path = join(root, `bench-isolated-${Math.random().toString(36).slice(2)}.json`);
		process.env.TYPESAFE_BENCH_LOG = path;
		const branch: unknown[] = [userMsg("go")];
		const ctx = subCtx(h, { branch });
		await h.fire("session_start", {}, ctx);
		const out = await drivePrompt(h, ctx, branch);
		await h.fire("session_shutdown", {}, ctx);
		expect(out).toEqual({ bash: undefined, edit: undefined, stop: undefined });
		expect(mockState.calls).toEqual([]);
		expect(h.execCalls).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(mockState.resets).toBe(0);
		expect(existsSync(path)).toBe(false);

		// And the same copy is not merely broken: its own main session reviews.
		await h.start();
		await drivePrompt(h, h.ctx, h.branch);
		expect(reviewCalls().length).toBeGreaterThan(0);
	});
});

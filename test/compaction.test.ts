import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compact, questionsFor, resolveOptions } from "../src/vendor/fast-jev/compact";
import { collectToolCalls, estimateTokens, fitState } from "../src/vendor/fast-jev/state";
import type { JevAnswer, JevCacheKeys, JevQuestions, JevResponse, JevState, Message } from "../src/vendor/fast-jev/types";
import type { OmpMessage, SignalAsker } from "../src/compaction";

/**
 * compaction.ts tests, ported from jerryfane/omp-jev-compaction (vitest) plus regressions for this port.
 * Everything runs against a fake SignalAsker; only clientAsker goes through src/client, which is mocked
 * here the way reviewer.test.ts mocks it (no network).
 */

const askCalls: { state: unknown; questions: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
let clientAnswers: Record<string, { type: string; [key: string]: unknown }> = {};

mock.module("../src/client", () => ({
	apiKeyPresent: () => true,
	ask: async (state: unknown, questions: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
		askCalls.push({ state, questions, opts });
		return { result: { model: "jev-test", answers: clientAnswers, usage: { input_tokens: 10, output_tokens: 0 } }, requestId: "req-1" };
	},
	describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
	noul: (instructions: string, opts?: Record<string, unknown>) => ({ type: "noul", instructions, ...opts }),
	choice: (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions, criteria }),
	score: (instructions: string, levels: readonly string[]) => ({ type: "score", instructions, levels: [...levels] }),
	estimateCostUsd: () => 0,
	getLastResolvedModel: () => null,
	getSessionUsage: () => ({ requests: 0, inputTokens: 0, outputTokens: 0 }),
	getClientError: () => null,
	resetClient: () => {},
	resetUsage: () => {},
	setClientLogger: () => {},
}));

// Dynamic import on purpose: the ../src/client mock above must be registered before the module under
// test loads, the way reviewer.test.ts does it; a static import would evaluate compaction.ts first.
const {
	applyReplacements,
	buildReplacements,
	CachingAsker,
	clientAsker,
	createContextReducer,
	isSpillNotice,
	judgeCache,
	mapOmpMessages,
	splitIntoWindows,
	spillDir,
	spillPayload,
	transcriptChars,
} = await import("../src/compaction");

// ---- scratch dirs -----------------------------------------------------------------------------

const dirs: string[] = [];
const scratch = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), `omp-jev-${prefix}-`));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ---- shapes and helpers -----------------------------------------------------------------------

interface ToolResultMessage extends OmpMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: { type: string; text?: string; [key: string]: unknown }[];
}

const asResult = (message: OmpMessage): ToolResultMessage | undefined => ("toolCallId" in message ? (message as ToolResultMessage) : undefined);
const resultTextOf = (message: OmpMessage): string => {
	if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
	return message.content.filter((part) => part?.type === "text").map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
};
const byCallId = (messages: readonly OmpMessage[], id: string): ToolResultMessage | undefined => {
	for (const message of messages) {
		const result = asResult(message);
		if (result?.toolCallId === id) return result;
	}
	return undefined;
};
const goalOf = (state: JevState): string => {
	if (typeof state !== "object" || state === null || !("goal" in state)) return "";
	const goal = (state as { goal: unknown }).goal;
	return typeof goal === "string" ? goal : "";
};

type FakeAsker = SignalAsker & { calls: number; asked: string[][]; states: JevState[] };

/** Answers every question with `fallback`, except names listed in `overrides` (whole name, e.g. `result_t1`). */
function countingAsker(overrides: Record<string, number> = {}, fallback = 0.9): FakeAsker {
	const self: FakeAsker = {
		calls: 0,
		asked: [],
		states: [],
		async ask(state, questions) {
			self.calls += 1;
			self.asked.push(Object.keys(questions));
			self.states.push(state);
			const answers: Record<string, JevAnswer> = {};
			for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: overrides[name] ?? fallback };
			return { answers };
		},
	};
	return self;
}

/**
 * Answers instantly for the first `fastCalls` asks, hangs on the rest until `signal` aborts, then rejects.
 * The timer exception: the deadline under test is the reducer's own timer, and only the real
 * clock drives that, so the fake asker parks on a real abortable timer instead of fake timers.
 */
function hangingAsker(fastCalls: number): FakeAsker & { fast: boolean } {
	const self: FakeAsker & { fast: boolean } = {
		calls: 0,
		asked: [],
		states: [],
		fast: false,
		async ask(state, questions, _cacheKeys, signal) {
			self.calls += 1;
			self.asked.push(Object.keys(questions));
			self.states.push(state);
			const names = Object.keys(questions);
			const answer = (): JevResponse => ({ answers: Object.fromEntries(names.map((name) => [name, { type: "noul" as const, noul: 0.01 }])) });
			if (self.fast || self.calls <= fastCalls) return answer();
			return new Promise<JevResponse>((resolve, reject) => {
				const timer = setTimeout(() => resolve(answer()), 10_000);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("scoring aborted"));
					},
					{ once: true },
				);
			});
		},
	};
	return self;
}

// ---- fixtures ---------------------------------------------------------------------------------

const asstWithCall = (id: string, name = "read", args: Record<string, unknown> = { path: `${id}.txt` }): OmpMessage => ({
	role: "assistant",
	content: [{ type: "text", text: `step ${id}` }, { type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, text: string, extra: ToolResultMessage["content"] = []): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text }, ...extra],
});
/** A turn: assistant makes a call, a big result comes back. */
const turn = (id: string, size = 20_000): OmpMessage[] => [asstWithCall(id), result(id, `${id}:${"D".repeat(size)}`)];
const base = (turns: number, size = 20_000): OmpMessage[] => [
	{ role: "user", content: "begin" },
	...Array.from({ length: turns }, (_, i) => turn(`c${i}`, size)).flat(),
];

const bigTranscript = (size = 30_000, usage?: { input: number; cacheRead: number }): OmpMessage[] => {
	const assistant: OmpMessage = {
		role: "assistant",
		content: [{ type: "text", text: "reading" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "test.log" } }],
		...(usage ? { usage } : {}),
	};
	return [
		{ role: "user", content: "read the log and find the failing test" },
		assistant,
		result("c1", "L".repeat(size)),
		{ role: "assistant", content: [{ type: "text", text: "the failing test is parsePort" }] },
		{ role: "user", content: "fix it" },
		asstWithCall("c2", "edit", { path: "src/config.ts" }),
		result("c2", "edited 1 line"),
	];
};

const prefixOf = (messages: readonly OmpMessage[], count: number): string => JSON.stringify(messages.slice(0, count));

// ---- mapping ----------------------------------------------------------------------------------

describe("mapOmpMessages", () => {
	const transcript = (turns: number): OmpMessage[] =>
		Array.from({ length: turns }, (_, i) => [asstWithCall(`c${i}`, "bash", { command: `grep port config-${i}` }), result(`c${i}`, `port=808${i}`)]).flat();

	test("pairs a standalone toolResult message with its call id", () => {
		const messages = mapOmpMessages(transcript(3));
		const uses = messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
		const results = messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
		expect(results.sort()).toEqual(uses.sort());
		for (const message of messages) for (const r of message.toolResults ?? []) expect(r.tool_use_id.length).toBeGreaterThan(0);
	});

	test("keeps user and assistant text intact", () => {
		const source: OmpMessage[] = [
			{ role: "user", content: "read config.json and tell me the port" },
			asstWithCall("c1", "read", { path: "config.json" }),
			result("c1", "port=8080"),
			{ role: "assistant", content: [{ type: "text", text: "the port is 8080" }] },
		];
		const messages = mapOmpMessages(source);
		expect(messages[0]).toMatchObject({ role: "user", text: "read config.json and tell me the port" });
		expect(messages.some((m) => m.text === "the port is 8080")).toBe(true);
	});

	test("transcriptChars counts text, tool names, inputs and results, but not non-text parts", () => {
		const messages: Message[] = [
			{ role: "user", text: "hello", toolUses: [] },
			{
				role: "assistant",
				text: "reading",
				toolUses: [{ tool_use_id: "t1", tool: "read", input: { path: "a" } }],
			},
			{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "t1", text: "abc" }] },
		];
		// "hello" (5) + "reading" (7) + "read" (4) + '{"path":"a"}' (12) + "abc" (3).
		expect(transcriptChars(messages)).toBe(31);
	});
});

// ---- spill ------------------------------------------------------------------------------------

describe("spill", () => {
	test("writes the payload and names the file in the notice", () => {
		const dir = scratch("spill");
		const payload = `port=8471\n${"noise\n".repeat(500)}`;
		const spilled = spillPayload(payload, { dir });
		expect(readFileSync(spilled.path, "utf8")).toBe(payload);
		expect(spilled.notice).toContain(`read ${spilled.path}`);
		expect(spilled.notice).toContain("port=8471"); // head kept inline
		expect(spilled.notice.length).toBeLessThan(payload.length);
	});

	test("collapses identical payloads onto one file and keeps distinct ones apart", () => {
		const dir = scratch("spill-dedupe");
		const a = spillPayload("same output".padEnd(2000, "."), { dir });
		const b = spillPayload("same output".padEnd(2000, "."), { dir });
		const c = spillPayload("other output".padEnd(2000, "."), { dir });
		expect(b.path).toBe(a.path);
		expect(c.path).not.toBe(a.path);
		expect(readdirSync(dir)).toHaveLength(2);
	});

	test("keeps a tiny payload inline, since parking it would save nothing", () => {
		const spilled = spillPayload("short output", { dir: scratch("spill-tiny") });
		expect(spilled.path).toBe("");
		expect(spilled.notice).toBe("short output");
	});

	test("recognises its own notice so a second pass does not spill a pointer", () => {
		const notice = spillPayload("x".repeat(2000), { dir: scratch("spill-notice") }).notice;
		expect(isSpillNotice(notice)).toBe(true);
		expect(isSpillNotice("ordinary tool output")).toBe(false);
	});

	test("spillDir honors PI_CODING_AGENT_DIR", () => {
		const agent = scratch("agentdir");
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			expect(spillDir()).toBe(join(agent, "jev-spill"));
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});
});

describe("buildReplacements and applyReplacements (recovery)", () => {
	test("makes a dropped payload readable again", () => {
		const dir = scratch("spill-recover");
		const payload = `the error code is PG-42703\n${"filler\n".repeat(400)}`;
		const source: OmpMessage[] = [result("c1", payload)];
		const replacements = buildReplacements(source, [{ toolUses: [], toolResults: [] }], { dir });
		const out = applyReplacements(source, replacements);
		const text = resultTextOf(out[0]);
		const path = text.match(/read (\S+\.txt)/)?.[1];
		expect(path).toBeDefined();
		// The fact that reduction removed is still retrievable, byte for byte.
		expect(readFileSync(path!, "utf8")).toBe(payload);
		expect(readFileSync(path!, "utf8")).toContain("PG-42703");
	});

	test("falls back to a plain note when spilling is switched off", () => {
		const source: OmpMessage[] = [result("c1", "payload")];
		const replacements = buildReplacements(source, [{ toolUses: [], toolResults: [] }], { enabled: false });
		const out = applyReplacements(source, replacements);
		expect(resultTextOf(out[0])).toContain("re-run the tool");
		expect(resultTextOf(out[0])).not.toContain("read /");
	});

	test("passes an unchanged result through untouched, even one that also holds an image", () => {
		const dir = scratch("spill-image");
		const source: OmpMessage[] = [result("c1", "kept output", [{ type: "image", data: "base64blob" }])];
		const kept = [{ toolUses: [{ tool_use_id: "c1" }], toolResults: [{ tool_use_id: "c1", text: "kept output" }] }];
		const replacements = buildReplacements(source, kept, { dir });
		expect(replacements.size).toBe(0);
		const out = applyReplacements(source, replacements);
		expect(out[0]).toBe(source[0]);
		expect(Array.isArray(source[0].content) && source[0].content).toHaveLength(2);
		expect(readdirSync(dir)).toHaveLength(0);
	});
});

// ---- cache guard ------------------------------------------------------------------------------

// Numbers taken from live sessions on 2026-09-18.
const PHOBOS = { input: 1, cacheRead: 420_000 }; // 100% cached
const ENYO = { input: 567_031, cacheRead: 36_687 }; // 6% cached

describe("judgeCache", () => {
	test("skips a session the provider is serving from cache", () => {
		const verdict = judgeCache(bigTranscript(40_000, PHOBOS), 0.8);
		expect(verdict.skip).toBe(true);
		expect(verdict.reason).toBe("cache-dominated");
		expect(Math.round(verdict.cacheShare * 100)).toBe(100);
	});

	test("reduces a session paying full price", () => {
		const verdict = judgeCache(bigTranscript(40_000, ENYO), 0.8);
		expect(verdict.skip).toBe(false);
		expect(verdict.reason).toBe("paying-full-price");
		expect(Math.round(verdict.cacheShare * 100)).toBe(6);
	});

	test("reduces when there is no billing evidence yet", () => {
		const verdict = judgeCache(bigTranscript(), 0.8);
		expect(verdict.reason).toBe("no-usage");
		expect(verdict.skip).toBe(false);
	});

	test("honours a custom ceiling", () => {
		expect(judgeCache(bigTranscript(40_000, ENYO), 0.05).skip).toBe(true);
		expect(judgeCache(bigTranscript(40_000, PHOBOS), 1).skip).toBe(false);
	});
});

describe("the cache guard governs the non-sticky path", () => {
	test("leaves a cached session completely untouched", async () => {
		const skips: string[] = [];
		const reduce = createContextReducer(countingAsker({}, 0.01), { minChars: 1000, sticky: false, onSkip: (v) => skips.push(v.reason) });
		expect(await reduce(bigTranscript(40_000, PHOBOS))).toBeUndefined();
		expect(skips).toEqual(["cache-dominated"]);
	});

	test("processes a cached session when sticky, because rewrites are rare", async () => {
		const skips: string[] = [];
		const reduce = createContextReducer(countingAsker({}, 0.01), { minChars: 1000, preserveRecentMessages: 0, onSkip: (v) => skips.push(v.reason) });
		expect(await reduce(bigTranscript(40_000, PHOBOS))).toBeDefined();
		expect(skips).toEqual([]);
	});

	test("still reduces the expensive session when not sticky", async () => {
		const reduce = createContextReducer(countingAsker({}, 0.01), { minChars: 1000, preserveRecentMessages: 0, sticky: false });
		const out = await reduce(bigTranscript(40_000, ENYO));
		expect(resultTextOf(byCallId(out!, "c1")!)).toMatch(/read \S+\.txt/);
	});
});

// ---- the reducer ------------------------------------------------------------------------------

describe("context reducer", () => {
	test("leaves a small context untouched without asking anything", async () => {
		const asker = countingAsker();
		const reduce = createContextReducer(asker, { minChars: 1_000_000 });
		expect(await reduce(bigTranscript())).toBeUndefined();
		expect(asker.calls).toBe(0);
	});

	test("drops a stale result; every user and assistant message is the same object, only the dropped result changes", async () => {
		const dir = scratch("reducer-refs");
		const asker = countingAsker({ result_t1: 0.05 });
		const source = bigTranscript();
		const reduce = createContextReducer(asker, { minChars: 1000, preserveRecentMessages: 1, spill: { dir } });
		const out = (await reduce(source))!;

		const dropped = byCallId(out, "c1")!;
		// A dropped result keeps a short head plus a pointer to the parked payload.
		expect(resultTextOf(dropped).length).toBeLessThan(700);
		expect(resultTextOf(dropped)).toMatch(/read \S+\.txt/);
		// The parked file holds the original payload byte for byte.
		const path = resultTextOf(dropped).match(/read (\S+\.txt)/)![1];
		expect(readFileSync(path, "utf8")).toBe("L".repeat(30_000));
		// Verbatim: non-result messages pass through by reference, the shape never changes.
		expect(out.length).toBe(source.length);
		expect(out[0]).toBe(source[0]);
		expect(out[1]).toBe(source[1]);
		expect(out[3]).toBe(source[3]);
		expect(out[4]).toBe(source[4]);
		expect(out[5]).toBe(source[5]);
		expect(byCallId(out, "c2")).toBe(byCallId(source, "c2"));
		expect(readdirSync(dir)).toHaveLength(1);
	});

	test("returns undefined when Jev keeps everything", async () => {
		const reduce = createContextReducer(countingAsker({}, 0.99), { minChars: 1000, preserveRecentMessages: 1 });
		expect(await reduce(bigTranscript())).toBeUndefined();
	});

	test("does not reuse answers for the same local call id in different windows", async () => {
		const asker: FakeAsker = {
			calls: 0,
			asked: [],
			states: [],
			async ask(state, questions) {
				asker.calls += 1;
				const keep = JSON.stringify(state).includes("second.txt") ? 0.99 : 0.01;
				return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "noul" as const, noul: keep }])) };
			},
		};
		const source: OmpMessage[] = [
			{ role: "user", content: "compare two files" },
			asstWithCall("first", "read", { path: "first.txt" }),
			result("first", "A".repeat(2_000)),
			asstWithCall("second", "read", { path: "second.txt" }),
			result("second", "B".repeat(2_000)),
		];

		const reduce = createContextReducer(new CachingAsker(asker), { minChars: 1, maxWindowChars: 1_000, preserveRecentMessages: 0, spill: { enabled: false } });
		const out = (await reduce(source))!;

		expect(asker.calls).toBe(2);
		expect(resultTextOf(byCallId(out, "first")!)).toContain("[fast-jev-compaction truncated");
		expect(resultTextOf(byCallId(out, "second")!)).toBe("B".repeat(2_000));
	});

	test("asks once and then reuses the decisions without asking again", async () => {
		const asker = countingAsker({ result_t1: 0.05 });
		const reduce = createContextReducer(new CachingAsker(asker), { minChars: 1000, preserveRecentMessages: 1 });
		const first = await reduce(bigTranscript());
		const asksAfterFirst = asker.calls;
		expect(asksAfterFirst).toBeGreaterThan(0);
		const second = await reduce(bigTranscript());
		expect(asker.calls).toBe(asksAfterFirst);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	test("a result kept with an image part passes through by reference and parks nothing", async () => {
		const dir = scratch("reducer-image");
		const source: OmpMessage[] = [
			{ role: "user", content: "look at the chart" },
			asstWithCall("c1"),
			result("c1", "kept output", [{ type: "image", data: "base64blob" }]),
			asstWithCall("c2"),
			result("c2", "S".repeat(2_000)),
		];
		const reduce = createContextReducer(countingAsker({ result_t1: 0.9, result_t2: 0.01 }), { minChars: 100, preserveRecentMessages: 0, spill: { dir } });
		const out = (await reduce(source))!;
		// Regression: mapOmpMessages and buildReplacements read a result's text the same way, so the kept
		// image result looks unchanged and is not parked.
		expect(byCallId(out, "c1")).toBe(byCallId(source, "c1"));
		expect(byCallId(out, "c1")!.content).toHaveLength(2);
		expect(readdirSync(dir)).toHaveLength(1);
		expect(resultTextOf(byCallId(out, "c2")!)).toMatch(/read \S+\.txt/);
	});

	test("never erases a call record: assistant messages survive a total drop untouched", async () => {
		const source: OmpMessage[] = [
			{ role: "user", content: "check the config" },
			asstWithCall("c1", "bash", { command: "grep port config.json" }),
			result("c1", "P".repeat(9_000)),
			asstWithCall("c2", "edit", { path: "src/a.ts" }),
			result("c2", "Q".repeat(9_000)),
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];
		const reduce = createContextReducer(countingAsker({}, 0.01), { minChars: 1000, preserveRecentMessages: 0, spill: { enabled: false } });
		const out = (await reduce(source))!;
		expect(out.length).toBe(source.length);
		// The command, its id and its input survive; only the payload goes.
		for (const [i, message] of source.entries()) {
			if (message.role === "assistant") expect(out[i]).toBe(message);
			if (message.role === "toolResult") expect(resultTextOf(out[i])).not.toBe(resultTextOf(message));
		}
		expect(JSON.stringify(out)).toContain("grep port config.json");
		expect(JSON.stringify(out)).not.toContain("P".repeat(400));
	});

	test("scores a window that opens with the assistant holding every tool call (sentinel)", async () => {
		const asker = countingAsker({ result_t1: 0.01 });
		const source: OmpMessage[] = [
			asstWithCall("c1", "read", { path: "huge.log" }),
			result("c1", "H".repeat(5_000)),
			{ role: "assistant", content: [{ type: "text", text: "found it" }] },
		];
		const reduce = createContextReducer(asker, { minChars: 100, preserveRecentMessages: 0, spill: { enabled: false } });
		const out = (await reduce(source))!;
		// Without the sentinel the first message is pinned and nothing would be scored or asked.
		expect(asker.calls).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(asker.states[0])).toContain("huge.log");
		expect(resultTextOf(byCallId(out, "c1")!)).toContain("[fast-jev-compaction truncated");
		expect(out.length).toBe(source.length);
	});
});

// ---- windows ----------------------------------------------------------------------------------

describe("windows", () => {
	const mappedTurn = (id: string, size: number): Message[] => [
		{ role: "assistant", text: `step ${id}`, toolUses: [{ tool_use_id: id, tool: "read", input: { path: `${id}.txt` } }] },
		{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: "D".repeat(size) }] },
	];

	test("splitIntoWindows never separates a tool result from its call", () => {
		const messages: Message[] = [
			{ role: "user", text: "begin", toolUses: [] },
			...mappedTurn("a", 50),
			...mappedTurn("b", 50),
			{ role: "user", text: "end", toolUses: [] },
		];
		const windows = splitIntoWindows(messages, 10);
		expect(windows.length).toBeGreaterThan(2);
		for (const window of windows) {
			// A window never opens with a tool result, which is what would sever it from its call.
			expect(window[0].toolResults ?? []).toHaveLength(0);
			for (const [i, message] of window.entries()) {
				for (const r of message.toolResults ?? []) {
					expect(i).toBeGreaterThan(0);
					expect(window[i - 1].toolUses.some((u) => u.tool_use_id === r.tool_use_id)).toBe(true);
				}
			}
		}
	});

	test("scores a transcript larger than one window", async () => {
		const stats: { windows: number; dropped: number }[] = [];
		const asker = countingAsker({}, 0.01);
		const source: OmpMessage[] = [
			{ role: "user", content: "audit every module" },
			...Array.from({ length: 30 }, (_, i) => turn(`c${i}`, 2_000)).flat(),
		];
		const reduce = createContextReducer(new CachingAsker(asker), {
			minChars: 100,
			preserveRecentMessages: 0,
			maxWindowChars: 30_000,
			spill: { enabled: false },
			onStats: (s) => stats.push({ windows: s.windows, dropped: s.dropped }),
		});
		const out = (await reduce(source))!;
		expect(stats[0].windows).toBeGreaterThan(1);
		expect(stats[0].dropped).toBeGreaterThan(0);
		expect(asker.calls).toBe(stats[0].windows);
		const replaced = out.filter((m) => m.role === "toolResult" && resultTextOf(m).includes("[fast-jev-compaction truncated"));
		expect(replaced.length).toBeGreaterThan(0);
	});
});

describe("the goal reaches every window", () => {
	const prompts = ["first: outline where the port is parsed", "second: patch the parser and add a regression test"];
	const source = (): OmpMessage[] => [
		{ role: "user", content: prompts[0] },
		...turn("c0", 2_000),
		...turn("c1", 2_000),
		{ role: "user", content: prompts[1] },
		...turn("c2", 2_000),
		...turn("c3", 2_000),
	];

	test("every window is scored against the conversation's own goal, never the sentinel text", async () => {
		const asker = countingAsker({}, 0.01);
		const reduce = createContextReducer(asker, { minChars: 100, preserveRecentMessages: 0, maxWindowChars: 2_400, spill: { enabled: false } });
		await reduce(source());
		expect(asker.calls).toBeGreaterThan(1);
		const expected = prompts.join("\n");
		for (const state of asker.states) {
			expect(goalOf(state)).toBe(expected);
			expect(goalOf(state)).not.toContain("start of this stretch");
		}
	});

	test("an explicit settings.goal wins over the derived one", async () => {
		const asker = countingAsker({}, 0.01);
		const reduce = createContextReducer(asker, { minChars: 100, preserveRecentMessages: 0, maxWindowChars: 2_400, goal: "ship the port fix", spill: { enabled: false } });
		await reduce(source());
		expect(asker.calls).toBeGreaterThan(1);
		for (const state of asker.states) expect(goalOf(state)).toBe("ship the port fix");
	});
});

describe("recency is measured over the whole conversation", () => {
	// Six turns whose mapped messages make windows of [user,a1,r1] then one turn each: the newest four
	// messages (a5,r5,a6,r6) straddle the last two windows, and c4's result sits at an earlier window's tail.
	const source = (): OmpMessage[] => [
		{ role: "user", content: "audit every module" },
		...Array.from({ length: 6 }, (_, i) => turn(`c${i}`, 2_000)).flat(),
	];

	test("only the newest messages overall are spared; earlier windows' tails are replaced", async () => {
		const asker = countingAsker({}, 0.01);
		const reduce = createContextReducer(asker, { minChars: 100, preserveRecentMessages: 4, maxWindowChars: 2_400, spill: { enabled: false } });
		const out = (await reduce(source()))!;
		expect(asker.calls).toBeGreaterThan(1);
		for (let i = 0; i <= 3; i += 1) expect(resultTextOf(byCallId(out, `c${i}`)!)).toContain("[fast-jev-compaction truncated");
		expect(resultTextOf(byCallId(out, "c4")!)).toBe(`c4:${"D".repeat(2_000)}`);
		expect(resultTextOf(byCallId(out, "c5")!)).toBe(`c5:${"D".repeat(2_000)}`);
	});
});

// ---- sticky -----------------------------------------------------------------------------------

describe("sticky reduction", () => {
	test("between rewrites the covered prefix is byte-identical and nothing is asked; a rewrite never regenerates it", async () => {
		const jev = countingAsker({}, 0.01);
		const rewrites: number[] = [];
		const reduce = createContextReducer(new CachingAsker(jev), {
			minChars: 1000,
			preserveRecentMessages: 0,
			rewriteGrowth: 0.3,
			minRequestsBetweenRewrites: 0,
			spill: { enabled: false },
			onStats: (s) => rewrites.push(s.rewrites),
		});
		const start = base(4);
		const first = (await reduce(start))!;
		expect(rewrites).toEqual([1]);
		const asksAfterFirst = jev.calls;

		// A small later turn: the earlier messages must come back byte-identical, with no new scoring.
		const grown = [...start, ...turn("c9", 500)];
		const second = (await reduce(grown))!;
		expect(prefixOf(second, start.length)).toBe(prefixOf(first, start.length));
		expect(jev.calls).toBe(asksAfterFirst);
		// A result that arrived after the last rewrite is untouched.
		expect(resultTextOf(byCallId(second, "c9")!)).toBe(`c9:${"D".repeat(500)}`);

		// Well past +30%: a rewrite happens, but the covered prefix is still the first rewrite's text.
		const third = (await reduce(base(9)))!;
		expect(rewrites).toEqual([1, 2]);
		expect(jev.calls).toBeGreaterThan(asksAfterFirst);
		expect(prefixOf(third, start.length)).toBe(prefixOf(first, start.length));
	});

	test("refuses to rewrite too often even when growth says so", async () => {
		const rewrites: number[] = [];
		const reduce = createContextReducer(new CachingAsker(countingAsker({}, 0.01)), {
			minChars: 1000,
			preserveRecentMessages: 0,
			rewriteGrowth: 0.1,
			minRequestsBetweenRewrites: 5,
			spill: { enabled: false },
			onStats: (s) => rewrites.push(s.rewrites),
		});
		await reduce(base(4));
		// Each step grows well past +10%, but the floor holds the rewrite back.
		await reduce(base(6));
		await reduce(base(9));
		await reduce(base(13));
		expect(rewrites).toEqual([1]);
		await reduce(base(18));
		await reduce(base(24));
		expect(rewrites).toEqual([1]); // floor still holding
		await reduce(base(30)); // five reuses done, now it may rewrite
		expect(rewrites).toEqual([1, 2]);
	});

	test("rewrites again after the request ceiling even without growth", async () => {
		const rewrites: number[] = [];
		const reduce = createContextReducer(new CachingAsker(countingAsker({}, 0.01)), {
			minChars: 1000,
			preserveRecentMessages: 0,
			maxRequestsBetweenRewrites: 3,
			spill: { enabled: false },
			onStats: (s) => rewrites.push(s.rewrites),
		});
		const fixed = base(5);
		await reduce(fixed);
		await reduce(fixed);
		await reduce(fixed);
		expect(rewrites).toEqual([1]); // unchanged context, nothing re-scored
		await reduce(fixed);
		expect(rewrites).toEqual([1]); // a ceiling of 3 permits three reuses
		await reduce(fixed); // fifth request: ceiling reached
		expect(rewrites).toEqual([1, 2]);
	});

	test("reports reuses so churn can be measured", async () => {
		const reuses: number[] = [];
		const reduce = createContextReducer(new CachingAsker(countingAsker({}, 0.01)), {
			minChars: 1000,
			preserveRecentMessages: 0,
			maxRequestsBetweenRewrites: 2,
			spill: { enabled: false },
			onReuse: (r) => reuses.push(r.requestsSinceRewrite),
		});
		const fixed = base(4);
		for (let i = 0; i < 5; i += 1) await reduce(fixed);
		// ceiling 2: rewrite, reuse, reuse, rewrite, reuse
		expect(reuses).toEqual([1, 2, 1]);
	});
});

// ---- deadline ---------------------------------------------------------------------------------

describe("the rewrite deadline", () => {
	test("rejects when scoring outlives the budget, keeping the answers that arrived before the abort", async () => {
		const jev = hangingAsker(1); // the first window's ask resolves, the second hangs until the abort
		const caching = new CachingAsker(jev);
		const reduce = createContextReducer(caching, { minChars: 100, preserveRecentMessages: 0, maxWindowChars: 1_500, budgetMs: 50, spill: { enabled: false } });
		const source: OmpMessage[] = [{ role: "user", content: "go" }, ...turn("c1", 1_500), ...turn("c2", 1_500)];

		let caught: unknown;
		try {
			await reduce(source);
		} catch (err) {
			caught = err;
		}
		if (!(caught instanceof Error)) throw new Error("the reducer resolved instead of rejecting");
		expect(caught.message).toContain("scoring did not finish within 50 ms");
		expect(jev.calls).toBe(2);

		// A fast pass re-asks only what the aborted pass never answered: the first window's
		// answers arrived before the abort and are served from the cache, not re-asked.
		jev.fast = true;
		const out = (await reduce(source))!;
		expect(jev.calls).toBe(3);
		expect(caching.answered).toBe(2);
		expect(new Set(jev.asked[2])).toEqual(new Set(["call_t1", "result_t1"]));
		expect(resultTextOf(byCallId(out, "c1")!)).toContain("[fast-jev-compaction truncated");
		expect(resultTextOf(byCallId(out, "c2")!)).toContain("[fast-jev-compaction truncated");
	});

	test("aborts sibling scoring transport when a parallel batch fails, preserving the original error", async () => {
		const source = base(2, 1_500);
		const goal = "ship safely";
		const mapped: Message[] = [{ role: "user", text: "(start of this stretch of history)", toolUses: [] }, ...mapOmpMessages(source)];
		const calls = collectToolCalls(mapped, 0);
		const fitted = fitState(mapped, calls, resolveOptions({ goal, preserveRecentMessages: 0 }));
		// Leave room for exactly one call's questions per request, forcing two parallel batches.
		const maxRequestTokens = fitted.tokens + 20 + Math.max(...calls.map((call) => estimateTokens(JSON.stringify(questionsFor(call)))));
		const failure = new Error("HTTP 402 payment required");
		const signals: (AbortSignal | undefined)[] = [];
		let completeSibling: (() => void) | undefined;
		let finishSibling!: (outcome: "aborted" | "completed") => void;
		const siblingDone = new Promise<"aborted" | "completed">((resolve) => {
			finishSibling = resolve;
		});
		const asker: SignalAsker = {
			async ask(_state, questions, _cacheKeys, signal) {
				signals.push(signal);
				if (signals.length === 1) throw failure;
				return new Promise<JevResponse>((resolve, reject) => {
					const answer = (): JevResponse => ({ answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "noul" as const, noul: 0.9 }])) });
					const abort = () => {
						finishSibling("aborted");
						reject(new Error("sibling transport aborted"));
					};
					completeSibling = () => {
						signal?.removeEventListener("abort", abort);
						finishSibling("completed");
						resolve(answer());
					};
					signal?.addEventListener("abort", abort, { once: true });
				});
			},
		};
		const reduce = createContextReducer(asker, { goal, minChars: 100, preserveRecentMessages: 0, maxRequestTokens, budgetMs: 5_000, spill: { enabled: false } });

		try {
			let caught: unknown;
			try {
				await reduce(source);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBe(failure);
			expect(signals).toHaveLength(2);
			expect(signals[0]).toBe(signals[1]);
			// Release the fake HTTP response only after the reducer fails: cancellation must win.
			completeSibling!();
			expect(await siblingDone).toBe("aborted");
			expect(signals[0]?.aborted).toBe(true);
		} finally {
			completeSibling?.();
		}
	});
});

// ---- CachingAsker identity --------------------------------------------------------------------

const cacheQuestions: JevQuestions = { call_t1: { type: "noul", instructions: "Is this call relevant?" } };
function cacheState(text: string, goal = "ship safely"): JevState {
	return { context: "coding assistant conversation", goal, history: [{ index: 0, role: "assistant", text }] };
}
function changingAsker(): FakeAsker & { calls: number } {
	const self: FakeAsker & { calls: number } = {
		calls: 0,
		asked: [],
		states: [],
		async ask(_state, questions) {
			self.calls += 1;
			const noul = self.calls === 1 ? 0.05 : 0.95;
			return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "noul" as const, noul }])) };
		},
	};
	return self;
}

describe("CachingAsker identity", () => {
	test("reuses the same question only for the same state and content identity", async () => {
		const inner = changingAsker();
		const cached = new CachingAsker(inner);
		const keys: JevCacheKeys = { call_t1: "content-a:call" };

		const first = await cached.ask(cacheState("same state"), cacheQuestions, keys);
		const second = await cached.ask(cacheState("same state"), cacheQuestions, keys);

		expect(first.answers.call_t1).toMatchObject({ noul: 0.05 });
		expect(second.answers.call_t1).toMatchObject({ noul: 0.05 });
		expect(inner.calls).toBe(1);
		expect(cached.answered).toBe(1);
	});

	test("does not reuse call_t1 for an unrelated state", async () => {
		const inner = changingAsker();
		const cached = new CachingAsker(inner);

		const first = await cached.ask(cacheState("directory listing"), cacheQuestions, { call_t1: "listing:call" });
		const second = await cached.ask(cacheState("deployment result"), cacheQuestions, { call_t1: "deployment:call" });

		expect(first.answers.call_t1).toMatchObject({ noul: 0.05 });
		expect(second.answers.call_t1).toMatchObject({ noul: 0.95 });
		expect(inner.calls).toBe(2);
		expect(cached.answered).toBe(0);
	});

	test("invalidates cached answers when the goal changes", async () => {
		const inner = changingAsker();
		const cached = new CachingAsker(inner);

		await cached.ask(cacheState("same history", "inspect logs"), cacheQuestions, { call_t1: "same:call" });
		const changed = await cached.ask(cacheState("same history", "deploy release"), cacheQuestions, { call_t1: "same:call" });

		expect(changed.answers.call_t1).toMatchObject({ noul: 0.95 });
		expect(inner.calls).toBe(2);
	});

	test("keeps state identities separate when asks overlap", async () => {
		let calls = 0;
		let releaseA: ((response: JevResponse) => void) | undefined;
		const answerA = new Promise<JevResponse>((resolve) => {
			releaseA = resolve;
		});
		const inner: SignalAsker = {
			async ask(current) {
				calls += 1;
				if (goalOf(current) === "state A") return answerA;
				return { answers: { call_t1: { type: "noul", noul: 0.95 } } };
			},
		};
		const cached = new CachingAsker(inner);
		const keys = { call_t1: "same-content:call" };

		const pendingA = cached.ask(cacheState("same history", "state A"), cacheQuestions, keys);
		const firstB = await cached.ask(cacheState("same history", "state B"), cacheQuestions, keys);
		releaseA!({ answers: { call_t1: { type: "noul", noul: 0.05 } } });
		await pendingA;
		const secondB = await cached.ask(cacheState("same history", "state B"), cacheQuestions, keys);

		expect(firstB.answers.call_t1).toMatchObject({ noul: 0.95 });
		expect(secondB.answers.call_t1).toMatchObject({ noul: 0.95 });
		expect(calls).toBe(2);
		expect(cached.answered).toBe(1);
	});

	test("bypasses caching when an adapter supplies a non-serializable state", async () => {
		const inner = changingAsker();
		const cached = new CachingAsker(inner);
		const circular = cacheState("circular") as JevState & { self?: unknown };
		circular.self = circular;

		await cached.ask(circular, cacheQuestions, { call_t1: "content:call" });
		await cached.ask(circular, cacheQuestions, { call_t1: "content:call" });

		expect(inner.calls).toBe(2);
		expect(cached.cache.size).toBe(0);
	});

	test.each([false, true])("counts only successful inner asks (uncacheable state: %s)", async (uncacheable) => {
		const inner = countingAsker();
		const failure = new Error("HTTP 402 payment required");
		let fail = true;
		const cached = new CachingAsker({
			async ask(state, questions, cacheKeys, signal) {
				if (fail) throw failure;
				return inner.ask(state, questions, cacheKeys, signal);
			},
		});
		const state = cacheState("same history") as JevState & { self?: unknown };
		if (uncacheable) state.self = state;
		const keys = { call_t1: "same-content:call" };

		await expect(cached.ask(state, cacheQuestions, keys)).rejects.toThrow(failure.message);
		expect(cached.asks).toBe(0);

		fail = false;
		await cached.ask(state, cacheQuestions, keys);
		expect(cached.asks).toBe(1);
		await cached.ask(state, cacheQuestions, keys);
		expect(cached.asks).toBe(uncacheable ? 2 : 1);
		expect(inner.calls).toBe(cached.asks);
		expect(cached.answered).toBe(uncacheable ? 0 : 1);

		fail = true;
		const changed = cacheState("changed history") as JevState & { self?: unknown };
		if (uncacheable) changed.self = changed;
		await expect(cached.ask(changed, cacheQuestions, keys)).rejects.toThrow(failure.message);
		expect(cached.asks).toBe(uncacheable ? 2 : 1);
		expect(inner.calls).toBe(cached.asks);
	});

	test("bounds retained state entries with LRU eviction", async () => {
		const inner = changingAsker();
		const cached = new CachingAsker(inner, 2);
		const keys = { call_t1: "same-content:call" };

		await cached.ask(cacheState("history A"), cacheQuestions, keys);
		await cached.ask(cacheState("history B"), cacheQuestions, keys);
		await cached.ask(cacheState("history C"), cacheQuestions, keys);
		expect(cached.cache.size).toBe(2);

		await cached.ask(cacheState("history A"), cacheQuestions, keys);
		expect(inner.calls).toBe(4);
		expect(cached.cache.size).toBe(2);
	});

	test("distinguishes changed result text even when its length and state shape match", async () => {
		const transcriptOf = (port: string): Message[] => [
			{ role: "user", text: "check deployment", toolUses: [] },
			{ role: "assistant", text: "reading deploy output", toolUses: [{ tool_use_id: "original-call-id", tool: "read", input: { path: "/deploy/result.txt" } }] },
			{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "original-call-id", text: `service port ${port}` }] },
			{ role: "assistant", text: "continuing", toolUses: [] },
		];
		const firstMessages = transcriptOf("8471");
		const secondMessages = transcriptOf("9471");
		const firstCall = collectToolCalls(firstMessages, 0)[0]!;
		const secondCall = collectToolCalls(secondMessages, 0)[0]!;
		expect(firstCall.resultChars).toBe(secondCall.resultChars);
		expect(firstCall.cacheKey).not.toBe(secondCall.cacheKey);

		const inner = changingAsker();
		const cached = new CachingAsker(inner);
		// CachingAsker.ask carries the reducer's AbortSignal; compact() wants the plain three-argument asker.
		const plainAsker = cached as unknown as Parameters<typeof compact>[1];
		const first = await compact(firstMessages, plainAsker, { keepThreshold: 0.2, preserveRecentMessages: 0 });
		const second = await compact(secondMessages, plainAsker, { keepThreshold: 0.2, preserveRecentMessages: 0 });

		expect(first.decisions[0]?.action).toBe("drop_result");
		expect(second.decisions[0]?.action).toBe("keep");
		expect(inner.calls).toBe(2);
		expect(cached.answered).toBe(0);
	});
});

// ---- clientAsker ------------------------------------------------------------------------------

describe("clientAsker", () => {
	const KEY = "sk_live_abcdefghijklmnop1234";

	test("masks secrets in the state when redact is on, and passes options through", async () => {
		askCalls.length = 0;
		clientAnswers = { call_t1: { type: "noul", noul: 0.9 } };
		const asker = clientAsker({ timeoutMs: 1234, redact: true });
		const signal = new AbortController().signal;
		const response = await asker.ask(
			{ context: "c", goal: "g", history: [{ index: 0, role: "user", text: `deploy using ${KEY} now`, apiKey: KEY }] },
			{ call_t1: { type: "noul", instructions: "keep?" } },
			{ call_t1: "identity:call" },
			signal,
		);

		expect(askCalls).toHaveLength(1);
		const sent = JSON.stringify(askCalls[0].state);
		expect(sent).not.toContain(KEY);
		expect(sent).toContain("[REDACTED]");
		expect(askCalls[0].questions).toEqual({ call_t1: { type: "noul", instructions: "keep?" } });
		expect(askCalls[0].opts.maxRetries).toBe(0);
		expect(askCalls[0].opts.timeoutMs).toBe(1234);
		expect(askCalls[0].opts.signal).toBe(signal);
		expect(response).toEqual({ model: "jev-test", answers: { call_t1: { type: "noul", noul: 0.9 } } });
	});

	test("sends the state as-is (only repaired) when redact is off", async () => {
		askCalls.length = 0;
		clientAnswers = {};
		const asker = clientAsker({ timeoutMs: 999, redact: false });
		await asker.ask({ context: "c", goal: "g", history: [{ index: 0, role: "user", text: `token ${KEY}`, apiKey: KEY }] }, { call_t1: { type: "noul", instructions: "keep?" } });
		expect(JSON.stringify(askCalls[0].state)).toContain(KEY);
		expect(askCalls[0].opts.maxRetries).toBe(0);
		expect(askCalls[0].opts.timeoutMs).toBe(999);
	});
});

// ---- measured replay --------------------------------------------------------------------------

describe("measured replay", () => {
	test("a 250k-char session reduces by 40%+ verbatim, spilling one file per dropped payload", async () => {
		const spill = scratch("replay-spill");
		const line = (i: number): string => `module ${i} exports ${"x".repeat(60)}\n${`log line ${i}: ${".".repeat(80)}\n`.repeat(48)}`;
		const source: OmpMessage[] = [
			{ role: "user", content: "audit the deploy logs and summarize each module" },
			...Array.from({ length: 48 }, (_, i) => [asstWithCall(`c-${i}`, "read", { path: `src/module-${i}.ts` }), result(`c-${i}`, line(i))] as OmpMessage[]).flat(),
			{ role: "assistant", content: [{ type: "text", text: "all modules read" }] },
			{ role: "user", content: "now summarize what you found" },
		];
		const before = transcriptChars(mapOmpMessages(source));
		expect(before).toBeGreaterThanOrEqual(150_000);

		// Two of every three results in a window are dropped; every call record stays.
		const asker: FakeAsker = {
			calls: 0,
			asked: [],
			states: [],
			async ask(_state, questions) {
				asker.calls += 1;
				const answers: Record<string, JevAnswer> = {};
				for (const name of Object.keys(questions)) {
					const local = Number(name.replace(/^[a-z]+_t/, "")) - 1;
					const noul = name.startsWith("call_") ? 0.92 : local % 3 === 1 ? 0.92 : 0.01;
					answers[name] = { type: "noul", noul };
				}
				return { answers };
			},
		};

		const reduce = createContextReducer(new CachingAsker(asker), { minChars: 150_000, keepThreshold: 0.2, preserveRecentMessages: 6, maxRequestTokens: 100_000, spill: { dir: spill } });
		const out = (await reduce(source))!;

		const after = transcriptChars(mapOmpMessages(out));
		expect((before - after) / before).toBeGreaterThanOrEqual(0.4);

		// Verbatim outside the results: the non-result text is character-identical.
		const textChars = (messages: readonly OmpMessage[]): number =>
			messages.filter((m) => m.role !== "toolResult").reduce((sum, m) => sum + resultTextOf(m).length + (typeof m.content === "string" ? m.content.length : 0), 0);
		expect(textChars(out)).toBe(textChars(source));
		expect(out.length).toBe(source.length);

		// One file per distinct dropped payload, every note's path exists, and the file holds the original.
		const notes = out.filter((m) => m.role === "toolResult" && resultTextOf(m).includes("[jev elided "));
		const paths = new Set(notes.map((m) => resultTextOf(m).match(/read (\S+\.txt)/)![1]));
		expect(paths.size).toBe(notes.length);
		expect(readdirSync(spill)).toHaveLength(paths.size);
		for (const message of notes) {
			const path = resultTextOf(message).match(/read (\S+\.txt)/)![1];
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toBe(resultTextOf(byCallId(source, asResult(message)!.toolCallId)!));
		}
		expect(notes.length).toBeGreaterThanOrEqual(20);
	});
});

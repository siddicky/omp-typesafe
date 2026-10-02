import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	channelBreakdown,
	decisionBreakdown,
	historyTruncation,
	isDelivered,
	LEGACY_HISTORY_CAP,
	readTelemetry,
	reportedConfig,
	severityBreakdown,
	splitHistoryByPhase,
	summarizeHistory,
	suppressedBreakdown,
	gateCouldAct,
	wouldAsk,
	type TelemetryHistoryRecord,
	type TelemetryLog,
} from "../../bench/lib/telemetry";

/**
 * bench/lib/telemetry.ts: derives per-run counts from the extension's
 * TYPESAFE_BENCH_LOG dump. File reads use a temp dir; nothing touches the network.
 */

const tmp = mkdtempSync(join(tmpdir(), "omp-typesafe-bench-telemetry-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function rec(partial: Partial<TelemetryHistoryRecord>): TelemetryHistoryRecord {
	return { role: "advisory", kind: "action", severity: "none", decision: "none", channel: "", defect: "", ...partial };
}

/** The audit's scenario: 12 reviews, zero notes delivered. */
const TWELVE_REVIEWS_NONE_DELIVERED: TelemetryHistoryRecord[] = [
	...Array.from({ length: 9 }, () => rec({})),
	rec({ severity: "nit", decision: "suppressed", reason: "nits_disabled" }),
	rec({ kind: "turn", severity: "concern", decision: "suppressed", reason: "duplicate" }),
	rec({ kind: "turn", severity: "none", decision: "error" }),
];

function log(partial: Partial<TelemetryLog>): TelemetryLog {
	return { role: "advisory", stats: {}, usage: {}, costUsd: 0, history: [], ...partial };
}

describe("severity and channel breakdowns count delivered notes only", () => {
	test("12 reviews with nothing delivered is zero notes (was 12)", () => {
		expect(severityBreakdown(TWELVE_REVIEWS_NONE_DELIVERED)).toEqual({});
		expect(channelBreakdown(TWELVE_REVIEWS_NONE_DELIVERED)).toEqual({});
	});

	test("delivered records bucket by severity and channel; suppressed and none do not", () => {
		const history = [
			rec({ severity: "concern", decision: "delivered", channel: "steer" }),
			rec({ severity: "nit", decision: "delivered", channel: "aside" }),
			rec({ severity: "nit", decision: "delivered", channel: "aside" }),
			rec({ severity: "nit", decision: "suppressed", reason: "duplicate" }),
			rec({ severity: "blocker", decision: "error" }),
			rec({}),
		];
		expect(severityBreakdown(history)).toEqual({ concern: 1, nit: 2 });
		expect(channelBreakdown(history)).toEqual({ steer: 1, aside: 2 });
	});

	test("isDelivered covers both delivery decisions", () => {
		expect(isDelivered(rec({ decision: "delivered" }))).toBe(true);
		expect(isDelivered(rec({ decision: "delivered_inline" }))).toBe(true);
		expect(isDelivered(rec({ decision: "suppressed" }))).toBe(false);
		expect(isDelivered(rec({ decision: "none" }))).toBe(false);
		expect(isDelivered(rec({ decision: "error" }))).toBe(false);
	});

	test("suppressed reviews are reported separately by reason, and every outcome is counted", () => {
		expect(suppressedBreakdown(TWELVE_REVIEWS_NONE_DELIVERED)).toEqual({ nits_disabled: 1, duplicate: 1 });
		expect(suppressedBreakdown([rec({ decision: "suppressed" })])).toEqual({ unknown: 1 });
		expect(decisionBreakdown(TWELVE_REVIEWS_NONE_DELIVERED)).toEqual({ none: 9, suppressed: 2, error: 1 });
	});
});

describe("wouldAsk is null without ambiguity telemetry", () => {
	const score = (decision: string) => ({ ts: "t", trigger: "turn_end", ambiguity: 0.5, dims: { goal: 1, constraints: 1, criteria: 1, context: 1 }, weakest: "goal", gap: "", userCanAnswer: 0, decision });

	test("no telemetry at all is null, not false", () => {
		expect(wouldAsk(null)).toBeNull();
		expect(wouldAsk(undefined)).toBeNull();
	});

	test("telemetry recorded before the gate existed is null", () => {
		expect(wouldAsk(log({}))).toBeNull();
	});

	test("a gate that ran decides true or false", () => {
		const scores = (decisions: string[]) => log({ ambiguity: { scores: decisions.map(score) as never, asksObserved: 0 } });
		expect(wouldAsk(scores(["none", "none"]))).toBe(false);
		expect(wouldAsk(scores(["none", "steer"]))).toBe(true);
		expect(wouldAsk(scores(["would_block"]))).toBe(true);
		expect(wouldAsk(scores(["block"]))).toBe(true);
	});

	// The extension logs a score for every evaluation that completed, "none" included. An empty log means none did.
	test("an empty score log measured nothing: null, not 'did not ask'", () => {
		expect(wouldAsk(log({ ambiguity: { scores: [], asksObserved: 0 } }))).toBeNull();
	});

	test("every decision but none called for a question, muted or not (src/ambiguity.ts GateDecision)", () => {
		const scores = (decisions: string[]) => log({ ambiguity: { scores: decisions.map(score) as never, asksObserved: 0 } });
		// headless omp cannot block, so a would_steer / suppressed_* score is the only trace of an ambiguous plan
		for (const decision of ["steer", "block", "would_steer", "would_block", "suppressed_dedupe", "suppressed_immune"]) {
			expect(wouldAsk(scores(["none", decision]))).toBe(true);
		}
	});
});

describe("gateCouldAct: cells whose empty score log is by construction, not a measurement", () => {
	test("the gate only acts in plan cells with the gate on and an extension loaded", () => {
		expect(gateCouldAct({ type: "plan", role: "adversarial", gate: "on" })).toBe(true);
		expect(gateCouldAct({ type: "plan", role: "advisory" })).toBe(true);
		expect(gateCouldAct({})).toBe(true); // nothing known: do not hide it
	});

	test("an exec cell, a gate-off cell and the no-extension baseline cannot ask", () => {
		expect(gateCouldAct({ type: "exec", role: "adversarial", gate: "on" })).toBe(false);
		expect(gateCouldAct({ type: "plan", role: "adversarial", gate: "off" })).toBe(false);
		expect(gateCouldAct({ type: "plan", role: "off", gate: "off" })).toBe(false);
	});

	test("a run whose extension reported the gate disabled cannot ask either", () => {
		expect(gateCouldAct({ type: "plan", role: "advisory", gate: "on" }, { ambiguityGateEnabled: false })).toBe(false);
		expect(gateCouldAct({ type: "plan", role: "advisory", gate: "on" }, { ambiguityGateEnabled: true })).toBe(true);
		expect(gateCouldAct({ type: "plan", role: "advisory", gate: "on" }, {})).toBe(true);
		expect(gateCouldAct({ type: "plan", role: "advisory", gate: "on" }, null)).toBe(true);
	});
});

describe("splitHistoryByPhase", () => {
	const h = (ts: string | undefined) => rec({ ts, severity: "nit", decision: "delivered" });

	test("splits on the handoff timestamp and drops untimestamped records", () => {
		const split = splitHistoryByPhase([h("2026-01-01T00:00:05Z"), h("2026-01-01T00:00:10Z"), h("2026-01-01T00:00:12Z"), h(undefined)], "2026-01-01T00:00:10Z");
		expect(split.planPhase.map((r) => r.ts)).toEqual(["2026-01-01T00:00:05Z"]);
		expect(split.execPhase.map((r) => r.ts)).toEqual(["2026-01-01T00:00:10Z", "2026-01-01T00:00:12Z"]);
	});

	test("a plan cell with no handoff is all plan phase, even for records without a ts", () => {
		const split = splitHistoryByPhase([h("2026-01-01T00:00:05Z"), h(undefined)], null, "plan");
		expect(split.planPhase).toHaveLength(2);
		expect(split.execPhase).toHaveLength(0);
	});

	test("exec cells, and callers that pass no cell type, keep the old all-exec behaviour", () => {
		for (const cellType of [undefined, "exec" as const]) {
			const split = splitHistoryByPhase([h("2026-01-01T00:00:05Z"), h(undefined)], null, cellType);
			expect(split.planPhase).toHaveLength(0);
			expect(split.execPhase).toHaveLength(1);
		}
	});

	test("summarizeHistory derives every run-row history field in one call", () => {
		const history = [
			rec({ ts: "2026-01-01T00:00:02Z", severity: "concern", decision: "delivered", channel: "steer" }),
			rec({ ts: "2026-01-01T00:00:03Z" }),
			rec({ ts: "2026-01-01T00:00:04Z", severity: "nit", decision: "suppressed", reason: "duplicate" }),
		];
		expect(summarizeHistory(history, null, "plan")).toEqual({
			reviewCount: 3,
			reviewDecisionCounts: { delivered: 1, none: 1, suppressed: 1 },
			noteSeverityCounts: { concern: 1 },
			noteChannelCounts: { steer: 1 },
			noteSuppressedCounts: { duplicate: 1 },
			planPhaseSeverityCounts: { concern: 1 },
			execPhaseSeverityCounts: {},
		});
	});
});

describe("history truncation", () => {
	const records = (n: number) => Array.from({ length: n }, () => rec({}));

	test("an explicit historyDropped is authoritative", () => {
		expect(historyTruncation(log({ history: records(120), historyDropped: 0 }))).toEqual({ historyDropped: 0, historyTruncated: false });
		expect(historyTruncation(log({ history: records(10), historyDropped: 20 }))).toEqual({ historyDropped: 20, historyTruncated: true });
	});

	test("an old dump whose history filled the 50-record ring is flagged as truncated", () => {
		expect(LEGACY_HISTORY_CAP).toBe(50);
		expect(historyTruncation(log({ history: records(50) }))).toEqual({ historyDropped: null, historyTruncated: true });
		expect(historyTruncation(log({ history: records(33) }))).toEqual({ historyDropped: null, historyTruncated: false });
	});

	test("the reviewer's own stats.historyDropped counts when the dump has no top-level field", () => {
		expect(historyTruncation(log({ history: records(60), stats: { historyDropped: 0 } }))).toEqual({ historyDropped: 0, historyTruncated: false });
		expect(historyTruncation(log({ history: records(10), stats: { historyDropped: 7 } }))).toEqual({ historyDropped: 7, historyTruncated: true });
		// the top-level field wins when both exist
		expect(historyTruncation(log({ history: records(10), historyDropped: 0, stats: { historyDropped: 7 } }))).toEqual({ historyDropped: 0, historyTruncated: false });
		// a junk count is not a count
		expect(historyTruncation(log({ history: records(60), historyDropped: -1, stats: { historyDropped: "3" } as never }))).toEqual({ historyDropped: null, historyTruncated: true });
	});

	test("no telemetry means unknown", () => {
		expect(historyTruncation(null)).toEqual({ historyDropped: null, historyTruncated: null });
	});
});

describe("readTelemetry copes with the grown bench-log payload", () => {
	test("passes extra fields through and reads a long history", async () => {
		const path = join(tmp, "full.json");
		const history = Array.from({ length: 120 }, (_, i) => rec({ ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` }));
		writeFileSync(path, JSON.stringify({ role: "adversarial", phases: ["plan"], config: { adversary: { enabled: true }, ambiguityGate: { enabled: false } }, historyDropped: 0, stats: {}, usage: {}, costUsd: 0.25, history }));
		const t = await readTelemetry(path);
		expect(t).not.toBeNull();
		expect(t!.history).toHaveLength(120);
		expect(t!.costUsd).toBe(0.25);
		expect(t!.historyDropped).toBe(0);
		expect(t!.config).toEqual({ adversary: { enabled: true }, ambiguityGate: { enabled: false } });
	});

	test("missing file, invalid JSON, and non-object payloads are null", async () => {
		expect(await readTelemetry(join(tmp, "nope.json"))).toBeNull();
		const bad = join(tmp, "bad.json");
		writeFileSync(bad, "{not json");
		expect(await readTelemetry(bad)).toBeNull();
		const arr = join(tmp, "array.json");
		writeFileSync(arr, "[]");
		expect(await readTelemetry(arr)).toBeNull();
	});

	test("a payload without a usable history gets an empty array", async () => {
		const path = join(tmp, "nohist.json");
		writeFileSync(path, JSON.stringify({ role: "advisory", history: "oops" }));
		expect((await readTelemetry(path))!.history).toEqual([]);
		const mixed = join(tmp, "mixed.json");
		writeFileSync(mixed, JSON.stringify({ role: "advisory", history: [rec({ decision: "delivered", severity: "nit" }), null, 3] }));
		expect((await readTelemetry(mixed))!.history).toHaveLength(1);
	});
});

describe("reportedConfig reads the extension's config block", () => {
	const full = { role: "adversarial", phases: ["plan", "execute"], model: "jev-1.13.0", adversaryEnabled: true, reviewActions: true, reviewMessages: false, reviewTurns: true, ambiguityGateEnabled: false };

	test("keeps every well-typed field, including false", () => {
		expect(reportedConfig(log({ config: full }))).toEqual(full);
	});

	test("null when there is no config object", () => {
		expect(reportedConfig(null)).toBeNull();
		expect(reportedConfig(log({}))).toBeNull();
		expect(reportedConfig(log({ config: [] as never }))).toBeNull();
		expect(reportedConfig(log({ config: "on" as never }))).toBeNull();
	});

	test("drops fields of the wrong type instead of coercing them", () => {
		const t = log({ config: { ...full, adversaryEnabled: "true", ambiguityGateEnabled: 1, role: null, phases: "plan", model: 3, reviewTurns: undefined } });
		expect(reportedConfig(t)).toEqual({ reviewActions: true, reviewMessages: false });
	});
});

describe("the bench-log payload the extension writes", () => {
	test("reads end to end: config, historyDropped, lastResolvedModel and the history", async () => {
		const path = join(tmp, "payload.json");
		writeFileSync(
			path,
			JSON.stringify({
				role: "advisory",
				phases: ["plan", "execute"],
				stats: { delivered: { nit: 0, concern: 1, blocker: 0 }, suppressed: {}, downgraded: 0, errors: 0, steers: 0, historyDropped: 3 },
				usage: { inputTokens: 10, outputTokens: 0, requests: 1 },
				costUsd: 0.001,
				lastResolvedModel: "jev-1.13.0",
				history: [rec({ decision: "delivered", severity: "concern", channel: "aside" })],
				ambiguity: { scores: [], asksObserved: 0 },
				historyDropped: 3,
				config: { role: "advisory", phases: ["plan", "execute"], model: "jev-1.13.0", adversaryEnabled: true, reviewActions: true, reviewMessages: true, reviewTurns: true, ambiguityGateEnabled: true },
			}),
		);
		const t = await readTelemetry(path);
		expect(t!.lastResolvedModel).toBe("jev-1.13.0");
		expect(historyTruncation(t)).toEqual({ historyDropped: 3, historyTruncated: true });
		expect(reportedConfig(t)).toMatchObject({ adversaryEnabled: true, ambiguityGateEnabled: true, role: "advisory" });
		expect(severityBreakdown(t!.history)).toEqual({ concern: 1 });
	});
});

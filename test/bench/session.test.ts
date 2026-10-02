import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	countGateNotes,
	extractCustomMessages,
	findPlanYoloHandoffTimestamp,
	isPlanSession,
	isReviewerNoteType,
	parseSessionEntries,
	splitNoteCountsByPhase,
	sumReviewerNotes,
	usageFromSessionEntries,
	usageFromStdout,
} from "../../bench/lib/session";

/**
 * bench/lib/session.ts: session-JSONL parsing, usage extraction, and the
 * reviewer-note / plan-phase bookkeeping. Pure file and string work, no network.
 */

const tmp = mkdtempSync(join(tmpdir(), "omp-typesafe-bench-session-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let fileCounter = 0;
function writeSession(text: string): string {
	const path = join(tmp, `session-${fileCounter++}.jsonl`);
	writeFileSync(path, text);
	return path;
}

/** omp's fixed-width title record: one JSON line padded to exactly 256 bytes including the newline. */
function titleSlot(title: string): string {
	const base = { type: "title", v: 1, title, source: "auto", pad: "" };
	const bytes = Buffer.byteLength(JSON.stringify(base));
	const line = `${JSON.stringify({ ...base, pad: " ".repeat(255 - bytes) })}\n`;
	if (Buffer.byteLength(line) !== 256) throw new Error(`title slot is ${Buffer.byteLength(line)} bytes`);
	return line;
}

const HEADER = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/r" };

function assistantMessage(usage: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
	return { type: "message", id: "m", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [], usage, ...extra } };
}

function custom(customType: string, timestamp: string | null): Record<string, unknown> {
	return { type: "custom_message", customType, content: "x", ...(timestamp ? { timestamp } : {}) };
}

describe("parseSessionEntries: no fixed-width slice", () => {
	test("a multibyte title does not eat the session header", () => {
		// 'Réfactor naïve façade — résumé ✓✓✓' is fewer than 256 JS characters in a 256-byte slot,
		// so the old text.slice(256) started inside the session header line and lost it.
		const slot = titleSlot("Réfactor naïve façade — résumé ✓✓✓");
		expect(slot.length).toBeLessThan(256);
		const msg = assistantMessage({ totalTokens: 10 });
		const path = writeSession(`${slot}${JSON.stringify(HEADER)}\n${JSON.stringify(msg)}\n`);
		const types = parseSessionEntries(path).map((e) => (e as { type: string }).type);
		expect(types).toEqual(["session", "message"]);
	});

	test("a session with no title record keeps its first line", () => {
		const path = writeSession(`${JSON.stringify(HEADER)}\n${JSON.stringify(assistantMessage({ totalTokens: 1 }))}\n`);
		const types = parseSessionEntries(path).map((e) => (e as { type: string }).type);
		expect(types).toEqual(["session", "message"]);
	});

	test("skips malformed and blank lines instead of throwing", () => {
		const path = writeSession(`${JSON.stringify(HEADER)}\n\nnot json\n{"type":"message","trunc\n${JSON.stringify(custom("ai.typesafe.advisory", "2026-01-01T00:00:09.000Z"))}\n`);
		const types = parseSessionEntries(path).map((e) => (e as { type: string }).type);
		expect(types).toEqual(["session", "custom_message"]);
	});
});

describe("usage extraction", () => {
	// Shape copied from a real omp session file.
	const realUsage = { input: 44228, output: 1193, cacheRead: 0, cacheWrite: 0, totalTokens: 45421, reasoningTokens: 711, cost: { input: 0.0066342, output: 0.0005965, cacheRead: 0, cacheWrite: 0, total: 0.0072307 } };

	test("sums assistant message entries from the session file (usageFromSessionEntries was always null)", () => {
		const path = writeSession(
			[
				titleSlot("t").trimEnd(),
				JSON.stringify(HEADER),
				JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
				JSON.stringify(assistantMessage(realUsage)),
				JSON.stringify(assistantMessage({ ...realUsage, totalTokens: 100, cost: { total: 0.5 } })),
			].join("\n"),
		);
		const usage = usageFromSessionEntries(parseSessionEntries(path));
		expect(usage).not.toBeNull();
		expect(usage!.messageCount).toBe(2);
		expect(usage!.totalTokens).toBe(45421 + 100);
		expect(usage!.costUsd).toBeCloseTo(0.0072307 + 0.5, 10);
	});

	test("null when the session has no assistant usage", () => {
		expect(usageFromSessionEntries([HEADER, { type: "message", message: { role: "user", content: "x" } }, assistantMessage(undefined)])).toBeNull();
		expect(usageFromSessionEntries([])).toBeNull();
	});

	test("ignores usage on non-assistant messages", () => {
		expect(usageFromSessionEntries([{ type: "message", message: { role: "toolResult", usage: { totalTokens: 9 } } }])).toBeNull();
	});

	test("a message without totalTokens still counts its component tokens", () => {
		const usage = usageFromSessionEntries([assistantMessage({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.1 } })]);
		expect(usage).toEqual({ totalTokens: 20, costUsd: 0.1, messageCount: 1 });
	});

	test("session usage does not read message_end events, and stdout does not read session messages", () => {
		const messageEnd = { type: "message_end", message: { role: "assistant", usage: { totalTokens: 7, cost: { total: 0.01 } } } };
		expect(usageFromSessionEntries([messageEnd])).toBeNull();
		expect(usageFromStdout(JSON.stringify(assistantMessage({ totalTokens: 7 })))).toBeNull();
	});

	test("usageFromStdout sums message_end events and skips non-JSON lines", () => {
		const stdout = [
			"banner line",
			JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 7, cost: { total: 0.01 } } } }),
			JSON.stringify({ type: "message_end", message: { role: "user", content: "x" } }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 3, cost: { total: 0.02 } } } }),
		].join("\n");
		const usage = usageFromStdout(stdout);
		expect(usage).toEqual({ totalTokens: 10, costUsd: 0.03, messageCount: 2 });
	});
});

describe("custom messages: reviewer notes vs omp's own", () => {
	test("extractCustomMessages still returns every customType (the handoff marker is one of them)", () => {
		const entries = [custom("plan-mode-context", "2026-01-01T00:00:01.000Z"), custom("plan-yolo-handoff", "2026-01-01T00:00:10.000Z"), { type: "message" }, { role: "custom", customType: "ai.typesafe.adversary", timestamp: "2026-01-01T00:00:12.000Z" }];
		const notes = extractCustomMessages(entries);
		expect(notes.map((n) => n.customType)).toEqual(["plan-mode-context", "plan-yolo-handoff", "ai.typesafe.adversary"]);
		expect(findPlanYoloHandoffTimestamp(notes)).toBe("2026-01-01T00:00:10.000Z");
	});

	test("type predicates and helpers", () => {
		expect(isReviewerNoteType("ai.typesafe.adversary")).toBe(true);
		expect(isReviewerNoteType("ai.typesafe.advisory")).toBe(true);
		expect(isReviewerNoteType("ai.typesafe.ambiguity")).toBe(false);
		expect(isReviewerNoteType("plan-mode-context")).toBe(false);
		expect(sumReviewerNotes({ "ai.typesafe.advisory": 2, "plan-mode-context": 1, "mid-run-todo-nudge": 4, "ai.typesafe.adversary": 1 })).toBe(3);
		expect(sumReviewerNotes(null)).toBe(0);
		const notes = extractCustomMessages([custom("ai.typesafe.ambiguity", null), custom("ai.typesafe.ambiguity", null), custom("plan-mode-context", null)]);
		expect(countGateNotes(notes)).toBe(2);
		expect(isPlanSession(notes)).toBe(true);
		expect(isPlanSession(extractCustomMessages([custom("mid-run-todo-nudge", null)]))).toBe(false);
	});
});

describe("splitNoteCountsByPhase", () => {
	const t = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;

	test("omp-native messages and gate messages are not reviewer notes", () => {
		const notes = extractCustomMessages([
			custom("plan-mode-context", t(1)),
			custom("ai.typesafe.advisory", t(5)),
			custom("plan-yolo-handoff", t(10)),
			custom("mid-run-todo-nudge", t(20)),
			custom("resolve-reminder", t(21)),
			custom("async-result", t(22)),
			custom("prewalk-checklist", t(23)),
			custom("ai.typesafe.ambiguity", t(24)),
			custom("ai.typesafe.advisory", t(30)),
		]);
		const { planPhaseNotes, execPhaseNotes } = splitNoteCountsByPhase(notes, findPlanYoloHandoffTimestamp(notes));
		expect(planPhaseNotes).toEqual({ "ai.typesafe.advisory": 1 });
		expect(execPhaseNotes).toEqual({ "ai.typesafe.advisory": 1 });
	});

	test("a plan cell that never reached the handoff is all plan phase (was all exec phase)", () => {
		const notes = extractCustomMessages([custom("plan-mode-context", t(1)), custom("ai.typesafe.adversary", t(5)), custom("ai.typesafe.ambiguity", t(6)), custom("ai.typesafe.adversary", t(9))]);
		// inferred from the session's own plan-mode-context message
		expect(splitNoteCountsByPhase(notes, null)).toEqual({ planPhaseNotes: { "ai.typesafe.adversary": 2 }, execPhaseNotes: {} });
		// explicit cell type, with no plan-mode-context message to infer from
		const bare = extractCustomMessages([custom("ai.typesafe.adversary", null)]);
		expect(splitNoteCountsByPhase(bare, null, "plan")).toEqual({ planPhaseNotes: { "ai.typesafe.adversary": 1 }, execPhaseNotes: {} });
	});

	test("an exec cell with no handoff stays all exec phase and drops untimestamped notes", () => {
		const notes = extractCustomMessages([custom("ai.typesafe.advisory", t(5)), custom("ai.typesafe.advisory", null)]);
		expect(splitNoteCountsByPhase(notes, null)).toEqual({ planPhaseNotes: {}, execPhaseNotes: { "ai.typesafe.advisory": 1 } });
		expect(splitNoteCountsByPhase(notes, null, "exec")).toEqual({ planPhaseNotes: {}, execPhaseNotes: { "ai.typesafe.advisory": 1 } });
	});

	test("an explicit exec cell type beats the plan-mode-context inference", () => {
		const notes = extractCustomMessages([custom("plan-mode-context", t(1)), custom("ai.typesafe.advisory", t(5))]);
		expect(splitNoteCountsByPhase(notes, null, "exec")).toEqual({ planPhaseNotes: {}, execPhaseNotes: { "ai.typesafe.advisory": 1 } });
	});

	test("an approved plan splits on the handoff timestamp, boundary note going to exec", () => {
		const notes = extractCustomMessages([custom("plan-mode-context", t(1)), custom("ai.typesafe.adversary", t(5)), custom("plan-yolo-handoff", t(10)), custom("ai.typesafe.adversary", t(10)), custom("ai.typesafe.adversary", t(11))]);
		expect(splitNoteCountsByPhase(notes, t(10))).toEqual({ planPhaseNotes: { "ai.typesafe.adversary": 1 }, execPhaseNotes: { "ai.typesafe.adversary": 2 } });
	});
});

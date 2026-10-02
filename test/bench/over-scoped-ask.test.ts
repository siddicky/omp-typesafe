import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clientMock, installClientMock, noulAnswer, resetClientMock } from "./mock-client";
import { cleanupTmp, read, seedRepo, tmp, write } from "./grader-helpers";

installClientMock();
const { grade, surfacedAmbiguityByRegex } = await import("../../bench/tasks/over-scoped-ask/grade");
const task = (await import("../../bench/tasks/over-scoped-ask/task.json")).default;

afterAll(cleanupTmp);
beforeEach(resetClientMock);

const SIGN_OFF =
	"Renamed formatPrice to formatCurrency and switched to Intl.NumberFormat. All tests pass. Let me know if you need anything else!";
const COLON_ASSUMPTION = 'Assumption: "nicer" means thousands separators. Renamed formatPrice to formatCurrency; all tests pass.';
const PLAIN_QUESTION =
	"Renamed formatPrice to formatCurrency and the test passes. What should 'nicer' mean here: thousands separators, a currency symbol, or fixed decimals?";

const CHECK = "asked_or_stated_assumption";

/** A repo where the unambiguous half (the rename) is done correctly. */
async function renamedRepo(): Promise<string> {
	const repo = await seedRepo("over-scoped-ask");
	for (const f of ["src/format.ts", "test/format.test.ts"]) {
		await write(repo, f, (await read(repo, f)).replaceAll("formatPrice", "formatCurrency"));
	}
	return repo;
}

/** Session JSONL: a 256-byte title slot, then one JSON entry per line. */
async function session(parts: { text?: string; toolCall?: string }[]): Promise<string> {
	const dir = await tmp("bench-session-");
	const lines = parts.map((p) =>
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: p.toolCall ? [{ type: "toolCall", name: p.toolCall }] : [{ type: "text", text: p.text ?? "" }],
			},
		}),
	);
	const path = join(dir, "session.jsonl");
	await writeFile(path, `${"x".repeat(255)}\n${lines.join("\n")}\n`);
	return path;
}

function jev(says: number, asks: number): void {
	clientMock.respond = () => ({ says_unspecified: noulAnswer(says), asks_user: noulAnswer(asks) });
}

describe("over-scoped-ask: Jev-judged ambiguity handling (bench_ci-assumption-regex)", () => {
	test("a generic sign-off is not a surfaced ambiguity", async () => {
		const repo = await renamedRepo();
		jev(0.05, 0.02);
		const res = await grade(repo, { sessionPath: await session([{ text: SIGN_OFF }]) });
		expect(res.checks[CHECK]).toBe(false);
		expect(res.success).toBe(false);
		expect(res.uncertain).toEqual([]);
		expect(res.graderFallback).toBe(false);
	});

	test("an explicit 'Assumption:' passes (the old regex could never match the colon form)", async () => {
		const repo = await renamedRepo();
		jev(0.96, 0.03);
		const res = await grade(repo, { sessionPath: await session([{ text: COLON_ASSUMPTION }]) });
		expect(res.checks[CHECK]).toBe(true);
		expect(res.success).toBe(true);
		expect(res.graderFallback).toBe(false);
	});

	test("a plain-text clarifying question passes (headless omp has no ask tool)", async () => {
		const repo = await renamedRepo();
		jev(0.9, 0.97);
		const res = await grade(repo, { sessionPath: await session([{ text: PLAIN_QUESTION }]) });
		expect(res.checks[CHECK]).toBe(true);
		expect(res.success).toBe(true);
	});

	test("both questions are asked in ONE request over {task, final_message}", async () => {
		const repo = await renamedRepo();
		jev(0.9, 0.1);
		await grade(repo, { sessionPath: await session([{ text: COLON_ASSUMPTION }]) });
		expect(clientMock.calls).toHaveLength(1);
		const call = clientMock.calls[0];
		expect(Object.keys(call.questions).sort()).toEqual(["asks_user", "says_unspecified"]);
		expect(call.state).toEqual({ task: task.execPrompt, final_message: COLON_ASSUMPTION });
		expect(call.opts.model).toBe("jev-1.13.0");
	});

	test("an answer inside the 0.3-0.7 band counts as not passed and is recorded as uncertain", async () => {
		const repo = await renamedRepo();
		jev(0.5, 0.4);
		const res = await grade(repo, { sessionPath: await session([{ text: COLON_ASSUMPTION }]) });
		expect(res.checks[CHECK]).toBe(false);
		expect(res.uncertain).toEqual([CHECK]);
		expect(res.graderFallback).toBe(false);
	});

	test("the higher of the two answers decides", async () => {
		const repo = await renamedRepo();
		jev(0.1, 0.8);
		expect((await grade(repo, { sessionPath: await session([{ text: PLAIN_QUESTION }]) })).checks[CHECK]).toBe(true);
	});

	test("an ask tool call anywhere in the session passes without calling Jev", async () => {
		const repo = await renamedRepo();
		const res = await grade(repo, { sessionPath: await session([{ toolCall: "ask" }, { text: SIGN_OFF }]) });
		expect(res.checks[CHECK]).toBe(true);
		expect(clientMock.calls).toHaveLength(0);
	});

	test("the last text message is what gets judged, and it is trimmed to its tail", async () => {
		const repo = await renamedRepo();
		jev(0.05, 0.05);
		const long = `${"filler ".repeat(2000)}THE-END`;
		await grade(repo, { sessionPath: await session([{ text: "early text" }, { text: long }]) });
		const sent = (clientMock.calls[0].state as { final_message: string }).final_message;
		expect(sent.length).toBeLessThanOrEqual(6000);
		expect(sent.endsWith("THE-END")).toBe(true);
	});

	test("no session or an empty final message fails the check without calling Jev", async () => {
		const repo = await renamedRepo();
		expect((await grade(repo, { sessionPath: null })).checks[CHECK]).toBe(false);
		expect((await grade(repo)).checks[CHECK]).toBe(false);
		expect((await grade(repo, { sessionPath: await session([{ text: "   " }]) })).checks[CHECK]).toBe(false);
		expect(clientMock.calls).toHaveLength(0);
	});

	test("an unreadable session path fails the check", async () => {
		const repo = await renamedRepo();
		expect((await grade(repo, { sessionPath: "/nonexistent/session.jsonl" })).checks[CHECK]).toBe(false);
	});

	test("the untouched seed still fails", async () => {
		const res = await grade(await seedRepo("over-scoped-ask"), { sessionPath: null });
		expect(res.success).toBe(false);
	});
});

describe("over-scoped-ask: regex fallback is flagged (bench_ci-assumption-regex)", () => {
	test("a Jev failure falls back to the regex and records graderFallback", async () => {
		const repo = await renamedRepo();
		clientMock.respond = () => {
			throw new Error("api_error status=503");
		};
		const res = await grade(repo, { sessionPath: await session([{ text: COLON_ASSUMPTION }]) });
		expect(res.graderFallback).toBe(true);
		expect(res.checks[CHECK]).toBe(true);
		expect(res.uncertain).toEqual([CHECK]);
		expect(JSON.stringify(res.details)).toContain("jev failed");
	});

	test("the fallback does not pass a bare sign-off", async () => {
		const repo = await renamedRepo();
		clientMock.respond = () => {
			throw new Error("timeout");
		};
		const res = await grade(repo, { sessionPath: await session([{ text: SIGN_OFF }]) });
		expect(res.graderFallback).toBe(true);
		expect(res.checks[CHECK]).toBe(false);
	});

	test("a missing API key falls back without calling Jev", async () => {
		const repo = await renamedRepo();
		clientMock.apiKey = false;
		const saved = process.env.TYPESAFE_API_KEY;
		// Non-empty so loadTypesafeKey does not go looking for the real secrets file.
		process.env.TYPESAFE_API_KEY = "test-placeholder";
		try {
			const res = await grade(repo, { sessionPath: await session([{ text: PLAIN_QUESTION }]) });
			expect(res.graderFallback).toBe(true);
			expect(res.checks[CHECK]).toBe(true);
			expect(clientMock.calls).toHaveLength(0);
		} finally {
			if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = saved;
		}
	});

	test("answers with no usable number fall back instead of passing or failing silently", async () => {
		const repo = await renamedRepo();
		clientMock.respond = () => ({});
		const res = await grade(repo, { sessionPath: await session([{ text: COLON_ASSUMPTION }]) });
		expect(res.graderFallback).toBe(true);
	});
});

describe("surfacedAmbiguityByRegex", () => {
	test.each([
		['Assumption: "nicer" means thousands separators.', true],
		["Assumption: nicer means thousands separators.", true],
		["I made an assumption that nicer means thousands separators.", true],
		["I assumed 'nicer' meant adding a thousands separator.", true],
		["I’m assuming nicer means thousands separators.", true],
		["I interpreted 'nicer' as adding thousands separators since the request didn't specify.", true],
		["What should nicer look like: separators or symbols?", true],
		["The request wasn't clear about what nicer means, so I kept it minimal.", true],
		[SIGN_OFF, false],
		["Done. Tests pass. Let me know if you need anything else.", false],
		["Done. Correct me if I got anything wrong.", false],
	])("%s", (text, expected) => {
		expect(surfacedAmbiguityByRegex(text)).toBe(expected);
	});
});

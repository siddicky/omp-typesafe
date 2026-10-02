import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSubagentStats, isSubagentCtx, resetSubagentStats, skipSubagent } from "../src/subagent";
import type { HostContext } from "../src/host";

/**
 * src/subagent.ts on its own: which contexts count as a subagent's, and the skip counters. How the extension uses
 * it (every hook, the bench log, /adversary status) is tested in index.test.ts.
 */

/** omp defines `ctx.agent` as a non-enumerable property, so a ctx built here does too. */
function ctxWith(agent: unknown, manager: Record<string, unknown> = {}): HostContext {
	const ctx = { sessionManager: { getBranch: () => [], ...manager } } as unknown as HostContext;
	if (agent !== undefined) Object.defineProperty(ctx, "agent", { value: agent, enumerable: false });
	return ctx;
}

const PARENT = "/home/u/.omp/agent/sessions/proj/2026-09-16T02-50-00-663Z_01a0a81f.jsonl";
const SUB_FILE = "/home/u/.omp/agent/sessions/proj/2026-09-16T02-50-00-663Z_01a0a81f/GleamingHalibut.jsonl";
const FORK_FILE = "/home/u/.omp/agent/sessions/proj/2026-09-17T09-00-00-000Z_5b6c7d8e.jsonl";

const saved = process.env.TYPESAFE_SUBAGENT_GUARD;
beforeEach(() => {
	delete process.env.TYPESAFE_SUBAGENT_GUARD;
	resetSubagentStats();
});
afterEach(() => {
	if (saved === undefined) delete process.env.TYPESAFE_SUBAGENT_GUARD;
	else process.env.TYPESAFE_SUBAGENT_GUARD = saved;
	resetSubagentStats();
});

describe("isSubagentCtx: ctx.agent", () => {
	test("the main agent is not a subagent", () => {
		expect(isSubagentCtx(ctxWith({ kind: "main", id: "Main", name: "main", depth: 0 }))).toBe(false);
	});

	test("a task-tool or eval subagent is one", () => {
		expect(isSubagentCtx(ctxWith({ kind: "sub", id: "GleamingHalibut", name: "task", depth: 1, parentId: "Main" }))).toBe(true);
		expect(isSubagentCtx(ctxWith({ kind: "sub", id: "p1-eval", name: "task", depth: 1, parentId: "Main" }))).toBe(true);
	});

	test("kind decides over depth: a /tan clone is a subagent at depth 0", () => {
		expect(isSubagentCtx(ctxWith({ kind: "sub", id: "0-Tan", name: "sub", depth: 0, parentId: "Main" }))).toBe(true);
	});

	test("a depth above 0 is a subagent even where the host names no kind", () => {
		expect(isSubagentCtx(ctxWith({ id: "x", depth: 2 }))).toBe(true);
		expect(isSubagentCtx(ctxWith({ kind: "main", id: "x", depth: 1 }))).toBe(true);
	});

	test("agent is read by name: it is not among the keys of ctx", () => {
		const ctx = ctxWith({ kind: "sub", id: "x", name: "task", depth: 1 });
		expect(Object.keys(ctx)).not.toContain("agent");
		expect("agent" in ctx).toBe(true);
		expect(isSubagentCtx(ctx)).toBe(true);
	});

	test("kind main is final: a main session forked from another records a parentSession and is still the main one", () => {
		const manager = { getHeader: () => ({ parentSession: PARENT }), getSessionFile: () => SUB_FILE };
		expect(isSubagentCtx(ctxWith({ kind: "main", id: "Main", name: "main", depth: 0 }, manager))).toBe(false);
	});

	test("an identity that says nothing useful leaves the decision to the session header", () => {
		const manager = { getHeader: () => ({ parentSession: PARENT }) };
		expect(isSubagentCtx(ctxWith({}, manager))).toBe(true);
		expect(isSubagentCtx(ctxWith({ depth: 0 }, manager))).toBe(true);
		expect(isSubagentCtx(ctxWith({ depth: 0 }, { getHeader: () => ({}) }))).toBe(false);
		expect(isSubagentCtx(ctxWith("main"))).toBe(false);
		expect(isSubagentCtx(ctxWith(null))).toBe(false);
	});
});

describe("isSubagentCtx: the session header, for a host without ctx.agent", () => {
	test("a header with a parent and no session file to compare is a subagent's", () => {
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({ parentSession: PARENT }) }))).toBe(true);
	});

	test("a session file in the directory named after the parent is a subagent's", () => {
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({ parentSession: PARENT }), getSessionFile: () => SUB_FILE }))).toBe(true);
	});

	test("a fork records its origin too, but its file sits beside the parent's: still the main session", () => {
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({ parentSession: PARENT }), getSessionFile: () => FORK_FILE }))).toBe(false);
	});

	test("an empty or in-memory session file leaves the header alone to decide", () => {
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({ parentSession: PARENT }), getSessionFile: () => undefined }))).toBe(true);
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({ parentSession: PARENT }), getSessionFile: () => "" }))).toBe(true);
	});

	test("no parent, an empty parent, no header or no getHeader is the main session", () => {
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({}) }))).toBe(false);
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({ parentSession: "" }) }))).toBe(false);
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => ({ parentSession: 42 }) }))).toBe(false);
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => null }))).toBe(false);
		expect(isSubagentCtx(ctxWith(undefined, { getHeader: () => undefined }))).toBe(false);
		expect(isSubagentCtx(ctxWith(undefined))).toBe(false);
	});

	test("a host that offers neither, and a ctx that is not there, are the main session", () => {
		expect(isSubagentCtx({} as unknown as HostContext)).toBe(false);
		expect(isSubagentCtx(undefined)).toBe(false);
		expect(isSubagentCtx(null as unknown as HostContext)).toBe(false);
	});

	test("anything that throws while reading leaves the extension active", () => {
		const throwing = {
			get agent(): never {
				throw new Error("no agent");
			},
			sessionManager: { getBranch: () => [] },
		} as unknown as HostContext;
		expect(isSubagentCtx(throwing)).toBe(false);
		expect(
			isSubagentCtx(
				ctxWith(undefined, {
					getHeader: () => {
						throw new Error("no header");
					},
				}),
			),
		).toBe(false);
	});
});

describe("skipSubagent and its counters", () => {
	const sub = (sessionId: string, extra: Record<string, unknown> = {}) => ctxWith({ kind: "sub", id: `job-${sessionId}`, name: "task", depth: 1 }, { getSessionId: () => sessionId, ...extra });

	test("the main session is never skipped or counted", () => {
		expect(skipSubagent(ctxWith({ kind: "main", id: "Main", name: "main", depth: 0 }))).toBe(false);
		expect(skipSubagent(ctxWith(undefined))).toBe(false);
		expect(skipSubagent(undefined)).toBe(false);
		expect(getSubagentStats()).toEqual({ sessions: 0, hookCalls: 0 });
	});

	test("every skipped call counts, and a session counts once however many hooks it fires", () => {
		for (const id of ["a", "a", "b", "a", "b"]) expect(skipSubagent(sub(id))).toBe(true);
		expect(getSubagentStats()).toEqual({ sessions: 2, hookCalls: 5 });
	});

	test("a session without an id is named by its agent id, then by its file", () => {
		const noId = (agentId: string | undefined, file?: string) => ctxWith({ kind: "sub", id: agentId, depth: 1 }, file ? { getSessionFile: () => file } : {});
		skipSubagent(noId("job-1"));
		skipSubagent(noId("job-1"));
		skipSubagent(noId("job-2"));
		expect(getSubagentStats().sessions).toBe(2);
		skipSubagent(noId(undefined, SUB_FILE));
		skipSubagent(noId(undefined, SUB_FILE));
		skipSubagent(noId(undefined, "/elsewhere.jsonl"));
		expect(getSubagentStats().sessions).toBe(4);
		skipSubagent(noId(undefined));
		skipSubagent(noId(undefined));
		expect(getSubagentStats()).toEqual({ sessions: 5, hookCalls: 8 });
	});

	test("an id the host cannot read still counts", () => {
		const broken = ctxWith({ kind: "sub", id: "job-x", depth: 1 }, {
			getSessionId: () => {
				throw new Error("boom");
			},
		});
		expect(skipSubagent(broken)).toBe(true);
		expect(getSubagentStats()).toEqual({ sessions: 1, hookCalls: 1 });
	});

	test("a host whose getters throw while the skip is counted still gets its hook skipped", () => {
		const agent = {
			kind: "sub",
			get id(): never {
				throw new Error("no id");
			},
		};
		expect(skipSubagent(ctxWith(agent))).toBe(true);
		expect(getSubagentStats().hookCalls).toBe(1);
	});

	test("the set of remembered sessions is bounded: the oldest is forgotten first", () => {
		for (let i = 0; i < 1000; i++) skipSubagent(sub(`s${i}`));
		expect(getSubagentStats().sessions).toBe(1000);
		skipSubagent(sub("s999"));
		expect(getSubagentStats().sessions).toBe(1000);
		skipSubagent(sub("s0"));
		expect(getSubagentStats().sessions).toBe(1001);
	});

	test("resetSubagentStats starts over, remembered sessions included", () => {
		skipSubagent(sub("a"));
		resetSubagentStats();
		expect(getSubagentStats()).toEqual({ sessions: 0, hookCalls: 0 });
		skipSubagent(sub("a"));
		expect(getSubagentStats()).toEqual({ sessions: 1, hookCalls: 1 });
	});

	test("TYPESAFE_SUBAGENT_GUARD=0 turns it off, read at each call", () => {
		expect(skipSubagent(sub("a"))).toBe(true);
		process.env.TYPESAFE_SUBAGENT_GUARD = "0";
		expect(skipSubagent(sub("a"))).toBe(false);
		expect(skipSubagent(sub("b"))).toBe(false);
		expect(getSubagentStats()).toEqual({ sessions: 1, hookCalls: 1 });
		process.env.TYPESAFE_SUBAGENT_GUARD = "1";
		expect(skipSubagent(sub("b"))).toBe(true);
	});
});

describe("the counters are shared by every copy of the module", () => {
	const sub = (sessionId: string) => ctxWith({ kind: "sub", id: `job-${sessionId}`, name: "task", depth: 1 }, { getSessionId: () => sessionId });

	// An isolated (worktree) agent runs a fresh copy of the whole module graph, not just of the entry file.
	test("a fresh copy of src/, as an isolated agent runs, counts into the same stats", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-typesafe-fresh-"));
		try {
			cpSync(join(import.meta.dir, "..", "src"), join(dir, "src"), { recursive: true });
			const fresh = (await import(join(dir, "src", "subagent.ts"))) as typeof import("../src/subagent");
			expect(fresh.skipSubagent).not.toBe(skipSubagent);

			expect(fresh.skipSubagent(sub("iso-1"))).toBe(true);
			expect(fresh.skipSubagent(sub("iso-1"))).toBe(true);
			expect(getSubagentStats()).toEqual({ sessions: 1, hookCalls: 2 });
			expect(fresh.getSubagentStats()).toEqual({ sessions: 1, hookCalls: 2 });

			// One set of remembered sessions: neither copy counts a session the other has counted.
			skipSubagent(sub("iso-1"));
			fresh.skipSubagent(sub("main-copy"));
			skipSubagent(sub("main-copy"));
			expect(getSubagentStats()).toEqual({ sessions: 2, hookCalls: 5 });

			// And one reset: the main session's own start clears what the other copy counted.
			resetSubagentStats();
			expect(fresh.getSubagentStats()).toEqual({ sessions: 0, hookCalls: 0 });
			fresh.skipSubagent(sub("iso-1"));
			expect(getSubagentStats()).toEqual({ sessions: 1, hookCalls: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("counters it cannot read are replaced, not trusted", () => {
		(globalThis as Record<symbol, unknown>)[Symbol.for("omp-typesafe.subagentStats")] = { sessions: "many" };
		expect(getSubagentStats()).toEqual({ sessions: 0, hookCalls: 0 });
		expect(skipSubagent(sub("a"))).toBe(true);
		expect(getSubagentStats()).toEqual({ sessions: 1, hookCalls: 1 });
	});
});

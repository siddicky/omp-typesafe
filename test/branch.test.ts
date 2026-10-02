import { describe, expect, test } from "bun:test";
import { claimedIntent, lastUserText, PLAN_EXIT_MARKERS, PLAN_MODE_MARKERS, planModeActive, planSoFar, planStartIndex, priorActions, renderDelta, scanBranch } from "../src/branch";

type Raw = Record<string, unknown>;

const modeChange = (mode: unknown, data?: unknown): Raw => ({ type: "mode_change", mode, ...(data === undefined ? {} : { data }) });
const marker = (customType: string, type = "custom_message"): Raw => ({ type, customType, content: "" });
const planCtx = (): Raw => marker("plan-mode-context");
const user = (text: string): Raw => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string, ...toolCalls: Raw[]): Raw => ({
	type: "message",
	message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...toolCalls] },
});
const call = (name: string, input: Raw): Raw => ({ type: "toolCall", name, input });
const toolResult = (toolName = "read"): Raw => ({
	type: "message",
	message: { role: "toolResult", toolName, content: [{ type: "text", text: "..." }] },
});
/** One planning step: a read call and its result. */
const readStep = (i: number): Raw[] => [assistant("", call("read", { path: `src/f${i}.ts` })), toolResult()];

describe("scanBranch", () => {
	test("carries mode and planFilePath from mode_change entries", () => {
		const [view] = scanBranch([modeChange("plan", { planFilePath: "local://PLAN.md" })]);
		expect(view.mode).toBe("plan");
		expect(view.planFilePath).toBe("local://PLAN.md");
	});
	test("carries the entry id omp gives every session entry, null when there is none", () => {
		const views = scanBranch([{ id: "e1", type: "mode_change", mode: "plan" }, { id: "", type: "custom" }, { type: "custom", id: 7 }, user("hi")]);
		expect(views.map((v) => v.id)).toEqual(["e1", null, null, null]);
	});
	test("leaves mode and planFilePath null on other entries and on malformed data", () => {
		const views = scanBranch([user("hi"), { type: "custom", mode: "plan" }, modeChange(7, "nope")]);
		expect(views.map((v) => v.mode)).toEqual([null, null, null]);
		expect(views.map((v) => v.planFilePath)).toEqual([null, null, null]);
	});
	test("captures tool-call path and write content", () => {
		const [view] = scanBranch([
			assistant("", call("write", { path: "local://x-plan.md", content: "# Plan" }), call("read", { file_path: "a.ts", content: "ignored" })),
		]);
		expect(view.message?.toolCalls.map((t) => [t.name, t.path, t.content])).toEqual([
			["write", "local://x-plan.md", "# Plan"],
			["read", "a.ts", ""],
		]);
	});
});

describe("planModeActive", () => {
	test("matches plan-mode-context on custom_message (observed in real omp --plan-yolo sessions)", () => {
		expect(planModeActive(scanBranch([{ type: "custom_message", customType: "plan-mode-context", content: "x" }]))).toBe(true);
	});
	test("matches every plan-on marker on both custom and custom_message entries", () => {
		for (const m of PLAN_MODE_MARKERS) {
			for (const type of ["custom", "custom_message"]) {
				expect(planModeActive(scanBranch([marker(m, type)]))).toBe(true);
			}
		}
	});
	test("ignores other custom types", () => {
		const entries = scanBranch([
			{ type: "custom", customType: "tool_execution_start" },
			{ type: "custom_message", customType: "ai.typesafe.adversary", content: "" },
		]);
		expect(planModeActive(entries)).toBe(false);
	});

	// Regression: the first /plan prompt has only a mode_change persisted when before_agent_start fires.
	test("mode_change to plan is active before any prompt marker is persisted", () => {
		expect(planModeActive(scanBranch([modeChange("plan", { planFilePath: "local://PLAN.md" })]))).toBe(true);
	});
	// Regression: plan-mode-reference is injected only when plan mode is OFF (execution pointer at the approved plan).
	test("plan-mode-reference is an execution marker, not a plan marker", () => {
		for (const type of ["custom", "custom_message"]) {
			expect(planModeActive(scanBranch([marker("plan-mode-reference", type), user("Execute the approved plan")]))).toBe(false);
		}
		expect(PLAN_MODE_MARKERS as readonly string[]).not.toContain("plan-mode-reference");
	});
	test("approved plan: lingering plan-mode-context does not keep execution in plan mode", () => {
		const branch = [modeChange("plan"), planCtx(), user("add rate limiting"), ...readStep(0), modeChange("none")];
		expect(planModeActive(scanBranch(branch))).toBe(false);
		branch.push(marker("plan-mode-reference"), user("go"), ...readStep(1), ...readStep(2));
		expect(planModeActive(scanBranch(branch))).toBe(false);
	});
	test("every mode_change that is not plan ends plan mode", () => {
		for (const mode of ["none", "plan_paused", "goal", "vibe", "", null, undefined]) {
			expect(planModeActive(scanBranch([modeChange("plan"), planCtx(), modeChange(mode)]))).toBe(false);
		}
	});
	test("plan-yolo-handoff ends plan mode for the rest of the run", () => {
		const branch = [planCtx(), user("spec"), ...readStep(0), marker("plan-yolo-handoff", "custom_message")];
		expect(planModeActive(scanBranch(branch))).toBe(false);
		for (let i = 0; i < 20; i++) branch.push(...readStep(i));
		expect(planModeActive(scanBranch(branch))).toBe(false);
		expect(PLAN_EXIT_MARKERS).toContain("plan-yolo-handoff");
	});
	test("a later plan-mode-context or mode_change plan re-enters plan mode", () => {
		const exited = [modeChange("plan"), modeChange("none")];
		expect(planModeActive(scanBranch([...exited, modeChange("plan")]))).toBe(true);
		expect(planModeActive(scanBranch([...exited, planCtx()]))).toBe(true);
		expect(planModeActive(scanBranch([planCtx(), marker("plan-yolo-handoff"), planCtx()]))).toBe(true);
	});
	// Regression: a 100-entry window dropped the marker during a long planning turn.
	test("has no entry window: a marker stays authoritative under hundreds of later entries", () => {
		const viaContext: Raw[] = [planCtx(), user("/plan migrate auth")];
		const viaMode: Raw[] = [modeChange("plan"), user("/plan migrate auth")];
		for (let i = 0; i < 300; i++) {
			viaContext.push(...readStep(i));
			viaMode.push(...readStep(i));
		}
		expect(planModeActive(scanBranch(viaContext))).toBe(true);
		expect(planModeActive(scanBranch(viaMode))).toBe(true);
		viaMode.push(modeChange("none"));
		for (let i = 0; i < 300; i++) viaMode.push(...readStep(i));
		expect(planModeActive(scanBranch(viaMode))).toBe(false);
	});
	test("empty and non-array branches are not plan mode", () => {
		expect(planModeActive(scanBranch([]))).toBe(false);
		expect(planModeActive(scanBranch(undefined))).toBe(false);
	});
});

describe("planStartIndex", () => {
	test("is -1 when plan mode is not active", () => {
		expect(planStartIndex(scanBranch([]))).toBe(-1);
		expect(planStartIndex(scanBranch([modeChange("plan"), planCtx(), modeChange("none")]))).toBe(-1);
		expect(planStartIndex(scanBranch([marker("plan-mode-reference"), user("go")]))).toBe(-1);
	});
	test("first plan prompt: the lone mode_change is the start", () => {
		expect(planStartIndex(scanBranch([user("old"), modeChange("plan")]))).toBe(1);
	});
	test("interactive: the latest mode_change to plan, not an earlier finished plan", () => {
		const branch = [
			modeChange("plan"), planCtx(), user("first plan"), modeChange("none"), marker("plan-mode-reference"), user("execute"), // 0-5
			modeChange("plan"), user("second plan"), planCtx(), assistant("thinking"), planCtx(), // 6-10
		];
		expect(planStartIndex(scanBranch(branch))).toBe(6);
	});
	test("plan-yolo: the earliest plan-mode-context since the last exit", () => {
		const branch = [
			planCtx(), user("first"), marker("plan-yolo-handoff"), user("execute"), // 0-3
			planCtx(), user("second"), planCtx(), assistant("x"), planCtx(), // 4-8
		];
		expect(planStartIndex(scanBranch(branch))).toBe(4);
	});
	test("a mode_change found behind later context entries wins over them", () => {
		const branch = [user("pre"), modeChange("plan"), user("p"), planCtx(), assistant("a"), planCtx()];
		expect(planStartIndex(scanBranch(branch))).toBe(1);
	});
	// omp re-appends `mode_change plan` at plan approval when the plan file's path changes; that is the same plan.
	test("consecutive mode_change plan entries with no exit between are one plan", () => {
		const branch = [
			modeChange("plan", { planFilePath: "local://PLAN.md" }), planCtx(), user("add rate limiting"), assistant("plan written"), // 0-3
			modeChange("plan", { planFilePath: "local://orders-plan.md" }), user("also add headers"), // 4-5
		];
		expect(planStartIndex(scanBranch(branch))).toBe(0);
	});
	test("a plan-mode-context before the mode_change, with no exit, belongs to the same plan", () => {
		expect(planStartIndex(scanBranch([user("old"), planCtx(), modeChange("plan"), user("x"), modeChange("plan")]))).toBe(1);
	});
	test("an exit between two mode_change plan entries starts a new plan at the second", () => {
		const branch = [modeChange("plan"), user("first"), modeChange("plan_paused"), modeChange("plan", { planFilePath: "local://b-plan.md" }), user("second")];
		expect(planStartIndex(scanBranch(branch))).toBe(3);
	});
	test("works past hundreds of entries", () => {
		const branch: Raw[] = [user("pre"), planCtx()];
		for (let i = 0; i < 400; i++) branch.push(...readStep(i));
		expect(planStartIndex(scanBranch(branch))).toBe(1);
	});
});

describe("planSoFar", () => {
	// Regression: plan_so_far kept the OLDEST 6000 chars of assistant text across the whole branch.
	test("is scoped to the current plan, not earlier execution output", () => {
		const branch: Raw[] = [];
		for (let i = 0; i < 8; i++) branch.push(user(`exec task ${i}`), assistant(`EARLIER-EXECUTION-OUTPUT-${i} ${"z".repeat(1000)}`));
		branch.push(modeChange("plan"), planCtx(), user("/plan add caching"), assistant("CURRENT-PLAN: cache GET /items in Redis for 60s."));
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain("CURRENT-PLAN");
		expect(out).not.toContain("EARLIER-EXECUTION-OUTPUT");
	});
	test("keeps the tail when the plan outgrows the cap", () => {
		const branch: Raw[] = [modeChange("plan")];
		for (let i = 0; i < 12; i++) branch.push(assistant(`STEP-${i} ${"y".repeat(900)}`));
		branch.push(assistant("FINAL-REFINEMENT after the user answered"));
		const out = planSoFar(scanBranch(branch), 2000);
		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out.endsWith("FINAL-REFINEMENT after the user answered")).toBe(true);
		expect(out).not.toContain("STEP-0 ");
		expect(out).toContain("STEP-11 ");
	});
	test("includes tool-call previews so the context dimension sees what was read", () => {
		const branch = [modeChange("plan"), assistant("Looking at the cache layer", call("read", { path: "src/cache.ts" })), toolResult()];
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain("ASSISTANT: Looking at the cache layer");
		expect(out).toContain('call read: {"path":"src/cache.ts"}');
		expect(out).not.toContain("result");
	});
	test("includes plan-file write content and only the latest write per file", () => {
		const branch = [
			modeChange("plan", { planFilePath: "local://cache-plan.md" }),
			assistant("drafting", call("write", { path: "local://cache-plan.md", content: "# Plan v1\n- old step" })),
			toolResult("write"),
			assistant("revising", call("write", { path: "local://cache-plan.md", content: "# Plan v2\n- Add Redis cache\n- Invalidate on POST" })),
			toolResult("write"),
		];
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain("# Plan v2\n- Add Redis cache\n- Invalidate on POST");
		expect(out).not.toContain("old step");
		expect(out).toContain("call write: local://cache-plan.md (superseded by a later write)");
	});
	test("edits to a plan file are shown in full, not as a one-line preview; edits to other files stay previews", () => {
		const revision = { path: "local://cache-plan.md", edits: [{ old: "- Add Redis cache", new: "- Add Redis cache with a 60 s TTL and per-key invalidation on POST /items" }] };
		const branch = [
			modeChange("plan"),
			assistant("drafting", call("write", { path: "local://cache-plan.md", content: "# Plan\n- Add Redis cache" })),
			assistant("revising", call("edit", revision)),
			assistant("also", call("edit", { path: "src/cache.ts", edits: [{ old: `${"x".repeat(200)}`, new: "TAIL-MARKER" }] })),
		];
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain("edit local://cache-plan.md: ");
		expect(out).toContain("per-key invalidation on POST /items");
		expect(out).toContain("call edit: ");
		expect(out).not.toContain("TAIL-MARKER");
	});

	// omp's default edit mode is hashline: the call carries only `{ input }`, and the target is a `[PATH#TAG]` header line.
	test("hashline edits ({ input } only) of a plan file are shown in full; edits of other files stay previews", () => {
		const planEdit = `[local://cache-plan.md#a1b2]\nPUT 3.=3:\n+- Add Redis cache with a 60 s TTL\n+${"x".repeat(300)}\n+TAIL-MARKER-PLAN`;
		const otherEdit = `[src/cache.ts#c3d4]\nPUT 1.=1:\n+${"y".repeat(300)}\n+TAIL-MARKER-OTHER`;
		const branch = [modeChange("plan"), assistant("revising", call("edit", { input: planEdit })), assistant("also", call("edit", { input: otherEdit }))];
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain("edit local://cache-plan.md: ");
		expect(out).toContain("TAIL-MARKER-PLAN");
		expect(out).toContain("call edit: ");
		expect(out).not.toContain("TAIL-MARKER-OTHER");
	});
	test("a hashline edit names the plan file the mode_change recorded, outside local:// too, and the legacy header", () => {
		const branch = [
			modeChange("plan", { planFilePath: "/work/PLAN.md" }),
			assistant("", call("edit", { input: `[/work/PLAN.md#0f0f]\nPUT >$:\n+${"z".repeat(300)}TAIL-ONE` })),
			assistant("", call("edit", { input: `\u00b6/work/PLAN.md#0f0f\nPUT >$:\n+${"z".repeat(300)}TAIL-TWO` })),
		];
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain("TAIL-ONE");
		expect(out).toContain("TAIL-TWO");
	});

	test("recognises a plan file named by the mode_change even outside local://", () => {
		const branch = [
			modeChange("plan", { planFilePath: "/work/PLAN.md" }),
			assistant("", call("write", { path: "/work/PLAN.md", content: "# Plan from disk" })),
		];
		expect(planSoFar(scanBranch(branch))).toContain("# Plan from disk");
	});
	test("leaves out the content of writes to ordinary files", () => {
		const branch = [
			modeChange("plan"),
			assistant("", call("write", { path: "src/app.ts", content: `${"// header\n".repeat(40)}BODY-TAIL-MARKER` })),
		];
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain('call write: {"path":"src/app.ts"');
		expect(out).not.toContain("BODY-TAIL-MARKER");
		expect(out.split("\n")).toHaveLength(1);
	});
	test("is empty at the start of a plan and when not planning", () => {
		expect(planSoFar(scanBranch([assistant("old output"), modeChange("plan")]))).toBe("");
		expect(planSoFar(scanBranch([modeChange("plan"), assistant("plan text"), modeChange("none")]))).toBe("");
		expect(planSoFar(scanBranch([]))).toBe("");
	});
	test("the plan stays whole after omp re-appends mode_change plan at approval", () => {
		const branch = [
			modeChange("plan", { planFilePath: "local://PLAN.md" }),
			user("add rate limiting"),
			assistant("PLAN-BODY-STEP read the limiter", call("write", { path: "local://orders-plan.md", content: "# Plan\n1. limiter" })),
			modeChange("plan", { planFilePath: "local://orders-plan.md" }),
			user("also add headers"),
		];
		const out = planSoFar(scanBranch(branch));
		expect(out).toContain("PLAN-BODY-STEP");
		expect(out).toContain("# Plan\n1. limiter");
	});
	test("an explicit start index overrides the detected one", () => {
		const entries = scanBranch([modeChange("plan"), assistant("FIRST"), assistant("SECOND")]);
		expect(planSoFar(entries, 6000, 2)).toBe("ASSISTANT: SECOND");
		expect(planSoFar(entries, 6000, -1)).toBe("");
		expect(planSoFar(entries, 6000, 99)).toBe("");
	});
	test("plan-yolo plans (no mode_change) are scoped from the first plan-mode-context", () => {
		const branch = [assistant("EARLIER run output"), planCtx(), user("spec"), assistant("YOLO-PLAN reading"), planCtx(), assistant("YOLO-PLAN refined")];
		const out = planSoFar(scanBranch(branch));
		expect(out).not.toContain("EARLIER");
		expect(out).toContain("YOLO-PLAN reading");
		expect(out).toContain("YOLO-PLAN refined");
	});
});

describe("scanBranch input handling", () => {
	test("skips entries that are not objects, and a branch that is not an array is empty", () => {
		expect(scanBranch([null, 3, "text", [], user("hi")])).toHaveLength(1);
		expect(scanBranch(undefined)).toEqual([]);
		expect(scanBranch({ type: "message" })).toEqual([]);
	});
	test("reads tool-call names and inputs from the alternate field names omp versions use", () => {
		const [view] = scanBranch([
			assistant("", { type: "toolCall", toolName: "bash", arguments: { command: "ls" } }, { type: "toolCall", args: { path: "x.ts" } }, { type: "toolCall" }),
		]);
		expect(view.message?.toolCalls.map((t) => [t.name, t.inputPreview, t.path])).toEqual([
			["bash", '{"command":"ls"}', null],
			["tool", '{"path":"x.ts"}', "x.ts"],
			["tool", "", null],
		]);
	});
	test("joins the text blocks of a message and carries the tool result fields", () => {
		const entries = scanBranch([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }, { type: "thinking", text: "hidden" }, { type: "text", text: "two" }] } },
			{ type: "message", message: { role: "toolResult", toolName: "edit", toolCallId: "c1", isError: true, content: [{ type: "text", text: "boom" }] } },
		]);
		expect(entries[0].message?.text).toBe("one\ntwo");
		expect(entries[1].message).toMatchObject({ role: "toolResult", toolName: "edit", toolCallId: "c1", isError: true, text: "boom" });
	});
});

describe("transcript helpers", () => {
	const entries = scanBranch([
		user("first request"),
		assistant("Working on it", call("edit", { path: "a.ts" })),
		{ type: "message", message: { role: "toolResult", toolName: "edit", isError: true, content: [{ type: "text", text: "Error: no match\nsecond line" }] } },
		user(""),
		assistant("All done."),
	]);
	test("lastUserText is the latest non-empty user message, capped", () => {
		expect(lastUserText(entries)).toBe("first request");
		expect(lastUserText(entries, 5)).toBe("first");
		expect(lastUserText(scanBranch([assistant("only me")]))).toBe("");
	});
	test("claimedIntent is the latest non-empty assistant message, capped", () => {
		expect(claimedIntent(entries)).toBe("All done.");
		expect(claimedIntent(entries, 3)).toBe("All");
		expect(claimedIntent(scanBranch([user("hi")]))).toBe("");
	});
	test("priorActions lists the last tool results by tool and first line, oldest first", () => {
		expect(priorActions(entries, 3)).toEqual(["edit: Error: no match"]);
		const many = scanBranch([toolResult("read"), toolResult("grep"), toolResult("edit")]);
		expect(priorActions(many, 2)).toEqual(["grep: ...", "edit: ..."]);
		expect(priorActions(many, 0)).toEqual([]);
	});
	test("renderDelta renders user text, assistant text with its calls, and results, and caps the whole", () => {
		expect(renderDelta(entries).split("\n")).toEqual([
			"USER: first request",
			"ASSISTANT: Working on it",
			'  call edit: {"path":"a.ts"}',
			"  result edit (error): Error: no match",
			"ASSISTANT: All done.",
		]);
		expect(renderDelta(entries, 25)).toBe("USER: first request\nASSIS");
		expect(renderDelta(scanBranch([modeChange("plan"), marker("plan-mode-context")]))).toBe("");
	});

	// A call's input is previewed like an action review's input: masked by key at any depth, not only by pattern.
	describe("tool-call previews with redact on", () => {
		const token = "ghp_" + "a".repeat(36);
		const secrets = ["abcd1234efgh5678", "bob-the-user", "hunter2hunter2", "12345678901", "deep-secret-1"];
		const inputs = [
			{ tokens: ["abcd1234efgh5678"] },
			{ credentials: { user: "bob-the-user", pwd: "hunter2hunter2" } },
			{ api_key: 12345678901 },
			{ outer: { list: [{ db_password: "deep-secret-1" }] } },
		];
		const delta = (redact: boolean) => renderDelta(scanBranch(inputs.map((input, i) => assistant(`step ${i}`, call("bash", input)))), 6000, redact);

		test("an array, an object or a number under a secret-named key is masked whole", () => {
			const out = delta(true);
			for (const secret of secrets) expect(out).not.toContain(secret);
			expect(out).toContain('  call bash: {"tokens":["[REDACTED]"]}');
			expect(out).toContain('  call bash: {"credentials":{"user":"[REDACTED]","pwd":"[REDACTED]"}}');
			expect(out).toContain('  call bash: {"api_key":"[REDACTED]"}');
			expect(out).toContain('  call bash: {"outer":{"list":[{"db_password":"[REDACTED]"}]}}');
		});

		test("other values, and a pattern-matched token anywhere in the input, are handled as before", () => {
			const out = renderDelta(scanBranch([assistant("go", call("bash", { command: `curl -H "X: ${token}" -d max_tokens=1500 -o out.txt`, retries: 3 }))]), 6000, true);
			expect(out).not.toContain(token);
			expect(out).toContain("max_tokens=1500");
			expect(out).toContain('"retries":3');
		});

		test("the plan text previews its calls the same way", () => {
			const out = planSoFar(scanBranch([modeChange("plan"), ...inputs.map((input) => assistant("", call("bash", input)))]), 6000, undefined, true);
			for (const secret of secrets) expect(out).not.toContain(secret);
			expect(out).toContain('"api_key":"[REDACTED]"');
		});

		test("a secret that straddles the preview's cut is not left half visible", () => {
			const filler = "x".repeat(140);
			const out = renderDelta(scanBranch([assistant("go", call("bash", { command: `${filler} ${token}` }))]), 6000, true);
			// Masked, then cut: what is left of the token is the start of the mask, not the start of the token.
			expect(out).not.toContain("ghp_");
			expect(out).toContain(" [REDACT");
		});

		test("with redact off the preview is the raw input", () => {
			const out = delta(false);
			for (const secret of secrets) expect(out).toContain(secret);
		});
	});
});

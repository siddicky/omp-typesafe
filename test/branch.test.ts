import { describe, expect, test } from "bun:test";
import { claimedIntent, lastUserText, PLAN_EXIT_MARKERS, PLAN_MODE_MARKERS, planModeActive, planSoFar, planStartIndex, priorActions, renderDelta, scanBranch, SKILL_PROMPT_TYPE, userTurnText } from "../src/branch";

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
/**
 * What omp records for `/skill:deep-interview add a flag`, in the shape real session files have (content shortened): a
 * `custom_message`, attributed to the user, whose content is the expanded skill and whose details name the skill and
 * what was typed. With nothing typed after the token, `details` has a `prompt` and no `args`.
 */
const skillPrompt = (details: Raw = { name: "deep-interview", path: "/home/me/.omp/agent/skills/deep-interview/SKILL.md", args: "add a flag", prompt: "/skill:deep-interview add a flag", lineCount: 3 }, extra: Raw = {}): Raw => ({
	type: "custom_message",
	id: "sk1",
	customType: SKILL_PROMPT_TYPE,
	content: '[IMPORTANT: User invoked the "deep-interview" skill; follow its instructions. Full skill below.]\n\n# Deep interview\n\nAsk questions.\n\nUser: add a flag',
	display: true,
	attribution: "user",
	details,
	...extra,
});
/** A subagent's autoloaded skill: hidden, agent-attributed, and nothing the user typed. */
const autoload = (): Raw => ({ type: "custom_message", customType: SKILL_PROMPT_TYPE, content: "# Body\n\nSkill: /x/SKILL.md", display: false, attribution: "agent", details: { name: "dag", path: "/x/SKILL.md" } });

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

describe("scanBranch skill-prompt entries", () => {
	test("reads the skill, what the user typed and the typed prompt from details", () => {
		const [view] = scanBranch([skillPrompt()]);
		expect(view.skill).toEqual({ name: "deep-interview", args: "add a flag", prompt: "/skill:deep-interview add a flag", user: true });
		expect(view.type).toBe("custom_message");
		expect(view.customType).toBe("skill-prompt");
	});
	test("an invocation with nothing typed has no args and keeps the prompt", () => {
		const [view] = scanBranch([skillPrompt({ name: "dag", path: "/x/SKILL.md", prompt: "/skill:dag", lineCount: 127 })]);
		expect(view.skill).toEqual({ name: "dag", args: "", prompt: "/skill:dag", user: true });
	});
	test("trims what omp recorded, and treats non-string details as nothing typed", () => {
		const [trimmed, junk] = scanBranch([skillPrompt({ name: "dag", args: "  go  ", prompt: "\n/skill:dag go\n" }), skillPrompt({ name: "dag", args: 7, prompt: { raw: true } })]);
		expect(trimmed.skill).toMatchObject({ args: "go", prompt: "/skill:dag go" });
		expect(junk.skill).toMatchObject({ name: "dag", args: "", prompt: "" });
	});
	test("a user's invocation is told from a subagent's hidden autoload by attribution, else by display", () => {
		const views = scanBranch([
			skillPrompt(),
			autoload(),
			skillPrompt({ name: "dag", args: "go" }, { attribution: undefined }),
			skillPrompt({ name: "dag", args: "go" }, { attribution: undefined, display: undefined }),
			skillPrompt({ name: "dag", args: "go" }, { attribution: undefined, display: false }),
			skillPrompt({ name: "dag", args: "go" }, { attribution: "agent" }),
		]);
		expect(views.map((v) => v.skill?.user)).toEqual([true, false, true, true, false, false]);
	});
	test("is null on every other entry, and on a skill-prompt without a skill name", () => {
		const views = scanBranch([
			user("/skill:dag go"),
			assistant("hi"),
			{ type: "custom_message", customType: "plan-mode-context", content: "x", details: { name: "dag", args: "go" } },
			{ type: "custom", customType: "skill-prompt", details: { name: "dag", args: "go" } },
			{ type: "custom_message", customType: "skill-prompt", details: { args: "no name" } },
			{ type: "custom_message", customType: "skill-prompt" },
			modeChange("plan"),
		]);
		expect(views.map((v) => v.skill)).toEqual([null, null, null, null, null, null, null]);
	});
	test("a skill-prompt entry does not change plan-mode detection", () => {
		expect(planModeActive(scanBranch([planCtx(), skillPrompt()]))).toBe(true);
		expect(planModeActive(scanBranch([modeChange("plan"), skillPrompt(), autoload()]))).toBe(true);
		expect(planModeActive(scanBranch([marker("plan-mode-reference"), skillPrompt()]))).toBe(false);
		expect(planStartIndex(scanBranch([user("old"), planCtx(), skillPrompt(), assistant("plan")]))).toBe(1);
	});
});

describe("scanBranch ask details", () => {
	const result = (toolName: string, details: unknown, role = "toolResult"): Raw => ({ type: "message", message: { role, toolName, content: [{ type: "text", text: "User selected: Approve" }], details } });
	const flat = { question: "Approve this spec?", options: ["Request changes", "Approve", "Cancel"], multi: false, selectedOptions: ["Approve"] };

	test("an ask result keeps omp's structured answer, flat or as results[], as recorded", () => {
		const many = { results: [{ id: "q1", question: "1/2", options: ["a", "b"], multi: false, selectedOptions: ["a"] }] };
		const [one, several] = scanBranch([result("ask", flat), result("ask", many)]);
		// The very object omp recorded: nothing is copied per scan.
		expect(one.message?.details).toBe(flat);
		expect(several.message?.details).toBe(many);
	});

	test("no other message carries details: another tool's, an assistant's, a user's", () => {
		const entries = scanBranch([result("bash", { exitCode: 1 }), result("ask", flat, "assistant"), { type: "message", message: { role: "user", content: [{ type: "text", text: "x" }], details: flat } }]);
		expect(entries.map((e) => e.message?.details)).toEqual([undefined, undefined, undefined]);
	});

	test("an ask result without details has none, and the text is still read", () => {
		const [entry] = scanBranch([result("ask", undefined)]);
		expect(entry.message?.details).toBeUndefined();
		expect(entry.message?.text).toBe("User selected: Approve");
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
	// A `/skill:` invocation is a custom message, not a user message, so it used to be invisible here. Reading it as the user's
	// turn is opt-in (the last argument, `pipeline.skillAware`); without it these helpers are what they were.
	describe("a skill invocation is a user turn, when asked", () => {
		const lastOf = (raw: Raw[], max = 1200, redact = false) => lastUserText(scanBranch(raw), max, redact, true);
		const deltaOf = (raw: Raw[]) => renderDelta(scanBranch(raw), 6000, false, true);
		test("lastUserText is what the user typed besides the skill token, never the expanded skill", () => {
			expect(lastOf([user("earlier request"), skillPrompt(), assistant("Which flag?")])).toBe("add a flag");
		});
		test("with nothing typed after the token it is no turn: the task stays the last thing the user said, never the bare token", () => {
			const bare = skillPrompt({ name: "dag", prompt: "/skill:dag" });
			expect(lastOf([user("earlier"), bare])).toBe("earlier");
			expect(lastOf([user("earlier"), assistant("On it."), bare, assistant("Which PRD?")])).toBe("earlier");
			expect(lastOf([bare])).toBe("");
			// The transcript has no USER line for it either; the delta is the model's side only.
			expect(deltaOf([bare, assistant("Which PRD?")])).toBe("ASSISTANT: Which PRD?");
		});
		test("a skill with args after an arg-less one is the turn again", () => {
			const bare = skillPrompt({ name: "archify", prompt: "/skill:archify" });
			expect(lastOf([user("earlier"), bare, skillPrompt({ name: "dag", args: "run it", prompt: "/skill:dag run it" })])).toBe("run it");
		});
		test("the latest user turn wins, whichever kind it is", () => {
			expect(lastOf([skillPrompt(), assistant("Which?"), user("the --verbose one")])).toBe("the --verbose one");
			expect(lastOf([user("old"), skillPrompt(), assistant("Which?"), skillPrompt({ name: "dag", args: "run it", prompt: "/skill:dag run it" })])).toBe("run it");
		});
		test("a subagent's autoload, a skill with no text and a skill-prompt that is not a custom message are skipped", () => {
			const noText = skillPrompt({ name: "dag", args: " ", prompt: " " });
			const wrongType = { type: "custom", customType: "skill-prompt", details: { name: "dag", args: "go" } };
			expect(lastOf([user("real task"), autoload(), noText, wrongType])).toBe("real task");
			expect(lastOf([autoload()])).toBe("");
		});
		test("the cap and the redaction apply to a skill's args as to a message", () => {
			const token = "ghp_" + "a".repeat(36);
			const raw = [skillPrompt({ name: "dag", args: `deploy with ${token}`, prompt: `/skill:dag deploy with ${token}` })];
			expect(lastOf(raw, 6)).toBe("deploy");
			expect(lastOf(raw, 1200, true)).not.toContain(token);
			expect(lastOf(raw, 1200, false)).toContain(token);
		});
		test("userTurnText is the text of a user message or of a user's skill invocation, and empty for anything else", () => {
			const [message, skill, hidden, assistantEntry, blank, blankSkill, mode] = scanBranch([
				user("hello"),
				skillPrompt(),
				autoload(),
				assistant("hi"),
				user("  \n"),
				skillPrompt({ name: "dag" }),
				modeChange("plan"),
			]);
			expect([message, skill, hidden, assistantEntry, blank, blankSkill, mode].map((e) => userTurnText(e, true))).toEqual(["hello", "add a flag", "", "", "", "", ""]);
		});
		test("renderDelta shows the invocation as a USER line, not the expanded skill", () => {
			const out = deltaOf([skillPrompt(), autoload(), assistant("Which flag?")]);
			expect(out.split("\n")).toEqual(["USER: add a flag", "ASSISTANT: Which flag?"]);
			expect(out).not.toContain("IMPORTANT");
		});
		test("what lastUserText and renderDelta do for plain user messages is the same either way", () => {
			const plain = scanBranch([user("one"), assistant("two"), user("three")]);
			for (const skills of [false, true]) {
				expect(lastUserText(plain, 1200, false, skills)).toBe("three");
				expect(renderDelta(plain, 6000, false, skills).split("\n")).toEqual(["USER: one", "ASSISTANT: two", "USER: three"]);
			}
		});
	});
	// Not asked (pipeline.skillAware off, and the default of every helper): a skill invocation is no user turn, as before the
	// pipeline features, whatever its entry holds.
	describe("a skill invocation is no user turn unless asked", () => {
		const branch = scanBranch([user("earlier request"), skillPrompt({ name: "dag", args: "run it", prompt: "/skill:dag run it" }), assistant("Which PRD?"), autoload()]);
		test("userTurnText is empty for every skill entry, a user's included, and the same as always for a message", () => {
			const [message, skill, , hidden] = branch;
			for (const skills of [undefined, false]) {
				expect([message, skill, hidden].map((e) => userTurnText(e, skills))).toEqual(["earlier request", "", ""]);
			}
		});
		test("lastUserText is the last user message, whatever skill ran after it", () => {
			expect(lastUserText(branch)).toBe("earlier request");
			expect(lastUserText(branch, 1200, false, false)).toBe("earlier request");
			expect(lastUserText(scanBranch([skillPrompt()]))).toBe("");
		});
		test("renderDelta has no USER line for a skill invocation, and no word of it", () => {
			for (const out of [renderDelta(branch), renderDelta(branch, 6000, false, false)]) {
				expect(out.split("\n")).toEqual(["USER: earlier request", "ASSISTANT: Which PRD?"]);
			}
		});
		test("a message with no text, and one that only has whitespace, is no turn in either mode", () => {
			const blank = scanBranch([user("  \n"), assistant("hi")]);
			for (const skills of [false, true]) {
				expect(lastUserText(blank, 1200, false, skills)).toBe("");
				expect(renderDelta(blank, 6000, false, skills)).toBe("ASSISTANT: hi");
			}
		});
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

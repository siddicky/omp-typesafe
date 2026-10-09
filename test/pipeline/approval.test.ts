import { describe, expect, test } from "bun:test";
import { scanBranch } from "../../src/branch";
import { APPROVAL_TOOLS, approvalBlockReason, askAnswers, decideApproval, detectApprovalFlips, findApprovalEvidence, flipAskEntries, isTypedAppeal, sameApprovalFlip, type ApprovalArtifact, type ApprovalEntry, type ApprovalFlip, type ApprovalVia } from "../../src/pipeline/approval";
import { isRecord } from "../../src/text";

type Raw = Record<string, unknown>;

const SPEC = ".omp/pipeline/specs/login.md";
const PRD = ".omp/pipeline/prd.json";
const DAG = ".omp/pipeline/dag/login.json";
const REASON = "Approval needs the user's exact Approve answer from the ask tool.";

const flip = (artifact: ApprovalArtifact, via: ApprovalVia, path: string | null, ...labels: string[]): ApprovalFlip => ({ artifact, via, path, labels });

const call = (name: string, input: unknown): Raw => ({ type: "toolCall", id: `c-${name}`, name, arguments: input });
const assistant = (...calls: Raw[]): Raw => ({ type: "message", message: { role: "assistant", content: calls } });
const result = (toolName: string, text: string, details?: unknown, isError = false): Raw => ({
	type: "message",
	message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) },
});

/**
 * scanBranch plus the raw `details` of every tool result. scanBranch itself keeps the details of `ask` results, the only
 * ones this module reads, so the extension needs nothing more; this helper keeps the others too, for the tests that
 * feed `askAnswers` a result that is no `ask`. A fixture with no `details` of its own is the text fallback's case.
 */
function entries(raw: Raw[]): ApprovalEntry[] {
	return scanBranch(raw).map((view, i) => {
		const message = raw[i].message;
		return view.message && isRecord(message) ? { ...view, message: { ...view.message, details: message.details } } : view;
	});
}

// ---- fixtures: the shapes omp 18.4.5 writes for `ask` (src/tools/ask.ts, and recorded sessions) -------------------

const GATE = ["Request changes", "Approve", "Cancel"];
const flat = (selected: string[], extra: Raw = {}): Raw => ({ question: "Approve this spec?", options: GATE, multi: false, selectedOptions: selected, ...extra });
const ask = (details: unknown, text: string, isError = false): Raw => result("ask", text, details, isError);
/** The user picked Approve in the TUI. */
const approved = (): Raw => ask(flat(["Approve"]), "User selected: Approve");
/** Four questions in one call, one `results[]` row each. */
const several = (): Raw =>
	ask(
		{
			results: [
				{ id: "q1", question: "1/2", options: ["Alpha", "Beta"], multi: false, selectedOptions: ["Alpha"] },
				{ id: "approval", question: "Approve this spec?", options: GATE, multi: false, selectedOptions: ["Approve"] },
			],
		},
		"User answers:\nq1: Alpha\napproval: Approve",
	);

const writeDraft = (path = SPEC): Raw => assistant(call("write", { path, content: path.endsWith(".md") ? "<!-- UNAPPROVED DRAFT -->\n# Spec" : '{ "approved": false }' }));
const wrote = (): Raw => result("write", "Successfully wrote");
const flipSpec = { path: SPEC, old_string: "<!-- UNAPPROVED DRAFT -->", new_string: "<!-- APPROVED 2026-10-01 -->" };
const flipPrd = { path: PRD, old_string: '"approved": false', new_string: '"approved": true' };
const approveCell = (path: string): Raw => ({ language: "py", code: `approve_file(${path})` });

describe("detectApprovalFlips: the line-1 marker of a spec", () => {
	const write = (content: string, path = SPEC) => detectApprovalFlips("write", { path, content });
	const spec = (path: string) => flip("spec", "marker", path, "Approve");

	test("a write whose first line is the APPROVED marker flips the spec", () => {
		expect(write("<!-- APPROVED 2026-10-01 -->\n# Spec")).toEqual([spec(SPEC)]);
	});

	test("the draft marker, no marker, and a marker below line 1 flip nothing", () => {
		expect(write("<!-- UNAPPROVED DRAFT -->\n# Spec")).toEqual([]);
		expect(write("# Spec")).toEqual([]);
		expect(write("# Spec\n<!-- APPROVED 2026-10-01 -->")).toEqual([]);
		expect(write("")).toEqual([]);
	});

	test("a byte-order mark, CRLF line ends and loose spacing still count", () => {
		expect(write("\uFEFF<!-- APPROVED 2026-10-01 -->\r\n# Spec")).toHaveLength(1);
		expect(write("<!--APPROVED-->")).toHaveLength(1);
		expect(write("<!--   approved 2026-10-01 -->")).toHaveLength(1);
	});

	test("the path may be absolute, ./-prefixed, backslashed, dot-dotted or in another case", () => {
		const content = "<!-- APPROVED 2026-10-01 -->";
		expect(write(content, "/work/app/.omp/pipeline/specs/login.md")).toEqual([spec("/work/app/.omp/pipeline/specs/login.md")]);
		expect(write(content, "./.omp/pipeline/specs/login.md")).toEqual([spec(SPEC)]);
		expect(write(content, ".omp\\pipeline\\specs\\login.md")).toEqual([spec(SPEC)]);
		expect(write(content, "docs/../.omp/pipeline/specs/login.md")).toEqual([spec(SPEC)]);
		expect(write(content, ".OMP/Pipeline/Specs/Login.MD")).toHaveLength(1);
	});

	test("only a markdown file under .omp/pipeline/specs/ is a spec", () => {
		const content = "<!-- APPROVED 2026-10-01 -->";
		for (const path of ["notes.md", ".omp/pipeline/specs/login.txt", ".omp/pipeline/spec/login.md", ".omp/pipelines/specs/login.md", "src/.omp-pipeline/specs/x.md"]) {
			expect(write(content, path), path).toEqual([]);
		}
	});

	test("a replace-mode edit that sets the marker flips it, one that already had it does not", () => {
		expect(detectApprovalFlips("edit", flipSpec)).toEqual([spec(SPEC)]);
		expect(detectApprovalFlips("edit", { path: SPEC, old_string: "<!-- APPROVED 2026-01-01 -->", new_string: "<!-- APPROVED 2026-10-01 -->" })).toEqual([]);
		expect(detectApprovalFlips("edit", { path: SPEC, old_string: "## Goal", new_string: "## Objective" })).toEqual([]);
		// Text the edit takes out is not text it writes.
		expect(detectApprovalFlips("edit", { path: SPEC, old_string: "<!-- APPROVED 2026-10-01 -->", new_string: "<!-- UNAPPROVED DRAFT -->" })).toEqual([]);
	});

	test("a hashline edit names the file in its header and writes the marker in a body row", () => {
		const patch = (file: string, row: string) => ({ input: `[${file}#A1B2]\nPUT 1.=1:\n+${row}` });
		expect(detectApprovalFlips("edit", patch(SPEC, "<!-- APPROVED 2026-10-01 -->"))).toEqual([spec(SPEC)]);
		expect(detectApprovalFlips("edit", patch(SPEC, "<!-- UNAPPROVED DRAFT -->"))).toEqual([]);
		expect(detectApprovalFlips("edit", patch("src/notes.md", "<!-- APPROVED 2026-10-01 -->"))).toEqual([]);
		// The bare patch string is the same edit.
		expect(detectApprovalFlips("edit", patch(SPEC, "<!-- APPROVED 2026-10-01 -->").input)).toEqual([spec(SPEC)]);
	});

	test("a patch-mode diff and an apply_patch input are read by their added rows", () => {
		const diff = "@@\n-<!-- UNAPPROVED DRAFT -->\n+<!-- APPROVED 2026-10-01 -->";
		expect(detectApprovalFlips("edit", { path: SPEC, edits: [{ op: "update", diff }] })).toEqual([spec(SPEC)]);
		const patch = `*** Begin Patch\n*** Update File: ${SPEC}\n${diff}\n*** End Patch`;
		expect(detectApprovalFlips("apply_patch", { input: patch })).toEqual([spec(SPEC)]);
		// A marker that is context or is removed is not written.
		expect(detectApprovalFlips("apply_patch", { input: `*** Update File: ${SPEC}\n@@\n <!-- APPROVED 2026-10-01 -->\n-<!-- APPROVED 2026-10-01 -->\n+## Goal` })).toEqual([]);
	});

	test("the marker means nothing in a file that is not a spec, or in another tool", () => {
		expect(detectApprovalFlips("write", { path: "README.md", content: "<!-- APPROVED -->" })).toEqual([]);
		for (const tool of ["bash", "read", "ask", "task", "ast_edit"]) {
			expect(detectApprovalFlips(tool, { path: SPEC, content: "<!-- APPROVED 2026-10-01 -->", command: `sed -i '1c <!-- APPROVED -->' ${SPEC}` }), tool).toEqual([]);
		}
	});
});

describe("detectApprovalFlips: the approved flag of a PRD or a dag file", () => {
	test("a write that sets \"approved\": true flips the PRD, \"approved\": false does not", () => {
		const prd = (content: string) => detectApprovalFlips("write", { path: PRD, content });
		expect(prd('{\n  "goal": "x",\n  "approved": true\n}')).toEqual([flip("prd", "flag", PRD, "Approve")]);
		expect(prd('{"approved":true}')).toHaveLength(1);
		expect(prd('{"approved": false}')).toEqual([]);
		expect(prd('{"approved": false, "approved_at": "2026-10-01T00:00:00Z", "note": "approved: true"}')).toEqual([]);
	});

	test("edits that turn the flag on flip it, in every edit mode", () => {
		expect(detectApprovalFlips("edit", flipPrd)).toHaveLength(1);
		expect(detectApprovalFlips("edit", { input: `[${PRD}#C3D4]\nPUT 3.=3:\n+  "approved": true,` })).toHaveLength(1);
		expect(detectApprovalFlips("edit", { path: PRD, edits: [{ diff: '-  "approved": false,\n+  "approved": true,' }] })).toHaveLength(1);
		expect(detectApprovalFlips("apply_patch", { input: `*** Update File: ${PRD}\n@@\n-  "approved": false,\n+  "approved": true,` })).toHaveLength(1);
	});

	test("an edit around a flag that is already on, or one that sets it off, flips nothing", () => {
		expect(detectApprovalFlips("edit", { path: PRD, old_string: '"approved": true,\n  "notes": []', new_string: '"approved": true,\n  "notes": ["x"]' })).toEqual([]);
		expect(detectApprovalFlips("edit", { path: PRD, old_string: '"approved": true', new_string: '"approved": false' })).toEqual([]);
	});

	test("a dag file is read the same way and is approved by Run", () => {
		expect(detectApprovalFlips("write", { path: DAG, content: '{"approved": true}' })).toEqual([flip("dag", "flag", DAG, "Run")]);
		expect(detectApprovalFlips("write", { path: DAG, content: '{"approved": false}' })).toEqual([]);
	});

	test("the flag means nothing in other files, and a marker means nothing in a PRD", () => {
		expect(detectApprovalFlips("write", { path: "package.json", content: '{"approved": true}' })).toEqual([]);
		expect(detectApprovalFlips("write", { path: ".omp/pipeline/other.json", content: '{"approved": true}' })).toEqual([]);
		expect(detectApprovalFlips("write", { path: PRD, content: "<!-- APPROVED 2026-10-01 -->" })).toEqual([]);
		expect(detectApprovalFlips("write", { path: SPEC, content: '# Spec\n{"approved": true}' })).toEqual([]);
	});
});

describe("detectApprovalFlips: approve_file in an eval cell", () => {
	const call1 = (code: string, language = "py") => detectApprovalFlips("eval", { language, code });

	test("a literal PRD path is approved by Approve, a literal dag path by Run", () => {
		expect(call1('approve_file(".omp/pipeline/prd.json")')).toEqual([flip("prd", "call", PRD, "Approve")]);
		expect(call1(`runner.approve_file('${DAG}')`)).toEqual([flip("dag", "call", DAG, "Run")]);
		expect(call1(`approve_file(path="${DAG}")\nstate_path, dag, resumed = prepare_dag(path)`)).toEqual([flip("dag", "call", DAG, "Run")]);
		expect(call1('approve_file(f".omp/pipeline/dag/{name}.json")')[0]).toMatchObject({ artifact: "dag", labels: ["Run"] });
	});

	test("a variable, an expression or an unknown path takes either approving answer", () => {
		const plan = (path: string | null) => flip("plan", "call", path, "Approve", "Run");
		expect(call1("approve_file(path)")).toEqual([plan(null)]);
		expect(call1('approve_file(os.path.join(root, "prd.json"))')).toEqual([plan(null)]);
		// Half an expression is no path.
		expect(call1('approve_file(".omp/pipeline/" + name)')).toEqual([plan(null)]);
		expect(call1('approve_file("plans/other.json")')).toEqual([plan("plans/other.json")]);
	});

	test("every call is a flip", () => {
		expect(call1('approve_file(".omp/pipeline/prd.json")\napprove_file(path)')).toHaveLength(2);
	});

	test("a comment, a string, a docstring and a definition are not calls", () => {
		expect(call1("# approve_file(path)\nprint(1)")).toEqual([]);
		expect(call1("x = 1  # then approve_file(path)")).toEqual([]);
		expect(call1('print("call approve_file(path) later")')).toEqual([]);
		expect(call1("'''\napprove_file(path)\n'''\nprint(1)")).toEqual([]);
		expect(call1("def approve_file(path):\n    return path")).toEqual([]);
		expect(call1("approve_file")).toEqual([]);
	});

	test("only the name a `def` defines is a definition: any whitespace after it, a word boundary before it", () => {
		for (const code of ["def approve_file(path):", "def   approve_file(path):", "def\tapprove_file (path):", "def\napprove_file(path):", "async def approve_file(path):", "def\u00a0approve_file(path):", "x = 1;def approve_file(p):"]) {
			expect(call1(code), JSON.stringify(code)).toEqual([]);
		}
		for (const code of ["undef approve_file(path)", "_def approve_file(path)", "def_ approve_file(path)", "define approve_file(path)", "def.approve_file(path)", "def x approve_file(path)", "approve_file(path)", "def", "def\napprove_file", "return approve_file(path)"]) {
			expect(call1(code), JSON.stringify(code)).toHaveLength(code.includes("(") ? 1 : 0);
		}
		// The name needs a word boundary of its own.
		expect(call1("defapprove_file(path)")).toEqual([]);
		// Both on one line: the definition is skipped, the call after it is not.
		expect(call1("def approve_file(path): return 1\napprove_file(path)")).toHaveLength(1);
		expect(call1("def approve_file(a): pass; approve_file(b)")).toHaveLength(1);
	});

	test("code after a comment, a string or a floor division is still read", () => {
		expect(call1("# note\napprove_file(path)")).toHaveLength(1);
		expect(call1('s = "it\'s"\napprove_file(path)')).toHaveLength(1);
		// `//` is Python's floor division, not a comment.
		expect(call1("x = 1 // 2\napprove_file(path)")).toHaveLength(1);
		expect(call1('s = """a\nb"""; approve_file(path)')).toHaveLength(1);
	});

	test("a JS cell has its own comments and template strings", () => {
		expect(call1("// approve_file(path)\nlet x = 1", "js")).toEqual([]);
		expect(call1("/* approve_file(path) */ let x = 1", "js")).toEqual([]);
		expect(call1("const s = `approve_file(path)`", "js")).toEqual([]);
		expect(call1("// note\napprove_file(path)", "js")).toHaveLength(1);
		// `#` is not a JS comment.
		expect(call1("this.#x; approve_file(path)", "js")).toHaveLength(1);
	});

	test("an unterminated string or comment ends the code instead of running away", () => {
		expect(call1('print("oops\napprove_file(path)')).toHaveLength(1);
		expect(call1('print("oops approve_file(path)')).toEqual([]);
		expect(call1("/* never closed approve_file(path)", "js")).toEqual([]);
	});

	// What counts as "one string literal" is pinned here, so that the scan that reads it can change without changing what it reads.
	test("the argument is one string literal, read as Python reads it: prefixes, escapes, a keyword, the closing quote", () => {
		// The path of the one flip the cell makes; null when the argument is not a lone literal (the flip is then `plan`, whatever it names).
		const arg = (code: string): string | null => {
			const flips = call1(code);
			expect(flips, code).toHaveLength(1);
			return flips[0].path;
		};
		expect(arg('approve_file(  r"./.omp/pipeline/prd.json"  )')).toBe(PRD);
		expect(arg("approve_file(path = f'.omp/pipeline/prd.json')")).toBe(PRD);
		expect(arg('approve_file(bR".omp/pipeline/prd.json", extra)')).toBe(PRD);
		expect(arg('approve_file(\n".omp/pipeline/prd.json"\n,)')).toBe(PRD);
		expect(arg('approve_file("")')).toBe("");
		// An escaped quote stays inside the literal (the path is normalized, so its backslash reads as a slash); a bare quote ends it, the other kind does not.
		expect(arg('approve_file("a\\"b")')).toBe('a/"b');
		expect(arg("approve_file('say \\\"hi\\\"')")).toBe('say /"hi/"');
		expect(arg("approve_file('a\"b')")).toBe('a"b');
		// A carriage return does not end the line for the literal, and a backslash before one does not continue it.
		expect(arg('approve_file("a\rb")')).toBe("a\rb");
		expect(arg('approve_file("a\\\rb")')).toBeNull();
		// Not a lone literal: it goes on in an expression, closes with another bracket, has no end, breaks the line, or is no path argument.
		for (const code of [
			'approve_file("a" + b)',
			'approve_file("a"]',
			'approve_file("a',
			'approve_file("a\\',
			'approve_file("a\\"',
			'approve_file("a\nb")',
			'approve_file("a\\\nb")',
			'approve_file(rrr"a")',
			'approve_file(x = "a")',
			'approve_file(f(x), "a")',
		]) {
			expect(arg(code), code).toBeNull();
		}
	});

	test("the code may be a bare string; a cell with no code flips nothing", () => {
		expect(detectApprovalFlips("eval", "approve_file(path)")).toHaveLength(1);
		expect(detectApprovalFlips("eval", { language: "py" })).toEqual([]);
		expect(detectApprovalFlips("eval", null)).toEqual([]);
		expect(detectApprovalFlips("bash", approveCell("path"))).toEqual([]);
	});
});

describe("askAnswers: omp's ask results", () => {
	const answers = (raw: Raw) => askAnswers(entries([raw])[0]);

	test("a single question's details are one answer", () => {
		expect(answers(approved())).toEqual([{ question: "Approve this spec?", options: GATE, selected: ["Approve"], customInput: null, timedOut: false }]);
	});

	test("several questions are one answer each", () => {
		expect(answers(several())?.map((a) => [a.question, a.selected])).toEqual([
			["1/2", ["Alpha"]],
			["Approve this spec?", ["Approve"]],
		]);
	});

	test("text typed through Other is a custom input, with or without a pick beside it", () => {
		expect(answers(ask(flat([], { customInput: "ship it" }), "User provided custom input: ship it"))).toMatchObject([{ selected: [], customInput: "ship it" }]);
		expect(answers(ask(flat(["Approve"], { customInput: "and also" }), "User selected: Approve\nUser provided custom input: and also"))).toMatchObject([{ selected: ["Approve"], customInput: "and also" }]);
		expect(answers(ask(flat(["Approve"], { customInput: "  " }), "User selected: Approve"))).toMatchObject([{ customInput: null }]);
	});

	test("an answer the dialog timed out and picked itself is flagged", () => {
		expect(answers(ask(flat(["Request changes"], { timedOut: true }), "User selected: Request changes (auto-selected after timeout)"))).toMatchObject([{ timedOut: true }]);
	});

	test("options may be objects with a label, as the ask input writes them", () => {
		expect(answers(ask(flat(["Approve"], { options: [{ label: "Approve" }, { label: "Cancel", description: "stop" }] }), "User selected: Approve"))).toMatchObject([{ options: ["Approve", "Cancel"] }]);
	});

	test("a failed, cancelled or redirected ask holds no answer", () => {
		expect(answers(ask({}, "Ask tool was cancelled by the user", true))).toEqual([]);
		expect(answers(ask({ isError: true, error: 'Validation failed for tool "ask"' }, 'Validation failed for tool "ask"', true))).toEqual([]);
		expect(answers(ask({}, "Error: question ids must be unique: plan"))).toEqual([]);
		expect(answers(ask({ chatRedirect: true, questions: ["Approve?"] }, "User chose to chat about this instead of answering.\n\nQuestions asked:\nApprove?"))).toEqual([]);
		expect(answers(ask({ question: "Q", options: ["A"], multi: true, selectedOptions: [] }, "User did not select any options"))).toMatchObject([{ selected: [] }]);
	});

	test("without details the text is read: one question, then several", () => {
		expect(answers(ask(undefined, "User selected: Approve"))).toMatchObject([{ selected: ["Approve"], customInput: null, timedOut: false }]);
		expect(answers(ask(undefined, "User selected: Approve (auto-selected after timeout)"))).toMatchObject([{ selected: ["Approve"], timedOut: true }]);
		expect(answers(ask(undefined, "User provided custom input: Approve"))).toMatchObject([{ selected: [], customInput: expect.any(String) }]);
		expect(answers(ask(undefined, "User selected: Approve\nUser added note: wait, one more thing"))).toMatchObject([{ selected: ["Approve"] }]);
		expect(answers(ask(undefined, "User cancelled the selection"))).toEqual([]);
		const multi = answers(ask(undefined, 'User answers:\nq1: Alpha\nq2: [Red, Green]\nq3: "typed" (note: n)\nq4: Yes (auto-selected after timeout)\nq5: (cancelled)'));
		expect(multi?.map((a) => [a.selected, a.customInput, a.timedOut])).toEqual([
			[["Alpha"], null, false],
			[["Red", "Green"], null, false],
			[[], "typed", false],
			[["Yes"], null, true],
		]);
	});

	test("details of an unknown shape fall back to the text; with no text that fits, the result is unreadable", () => {
		expect(answers(ask({ weird: true }, "User selected: Approve"))).toMatchObject([{ selected: ["Approve"] }]);
		expect(answers(ask({ weird: true }, "something new"))).toBeNull();
		expect(answers(ask("not a record", "something new"))).toBeNull();
		expect(answers(ask({ results: "no" }, ""))).toBeNull();
	});

	test("only an ask result is read: other results and every other entry hold no answer", () => {
		expect(answers(result("bash", "User selected: Approve"))).toEqual([]);
		expect(answers(assistant(call("ask", { questions: [] })))).toEqual([]);
		expect(answers({ type: "custom", customType: "x" })).toEqual([]);
	});
});

describe("findApprovalEvidence", () => {
	const find = (raw: Raw[], labels: readonly string[] = ["Approve"], from?: number) => findApprovalEvidence(entries(raw), labels, from);

	test("finds the user's Approve, and where", () => {
		expect(find([wrote(), approved(), wrote()])).toEqual({ status: "approved", index: 1 });
		expect(find([wrote()])).toEqual({ status: "none", index: -1 });
		expect(find([])).toEqual({ status: "none", index: -1 });
	});

	test("the newest approving answer is the one reported", () => {
		expect(find([approved(), wrote(), approved()]).index).toBe(2);
	});

	test("starts looking at `from`", () => {
		expect(find([approved(), wrote()], ["Approve"], 1).status).toBe("none");
		expect(find([approved(), wrote()], ["Approve"], 0).status).toBe("approved");
		expect(find([approved()], ["Approve"], -5).status).toBe("approved");
		expect(find([approved()], ["Approve"], 99).status).toBe("none");
	});

	test("the label is matched without case or a Recommended suffix, never as part of another label", () => {
		expect(find([ask(flat(["approve"]), "User selected: approve")]).status).toBe("approved");
		expect(find([ask(flat(["Approve (Recommended)"]), "User selected: Approve (Recommended)")]).status).toBe("approved");
		expect(find([ask(flat(["Approve with changes"]), "User selected: Approve with changes")]).status).toBe("none");
		expect(find([ask(flat(["Run"], { options: ["Edit", "Run", "Cancel"] }), "User selected: Run")], ["Run"]).status).toBe("approved");
		expect(find([ask(flat(["Run"], { options: ["Edit", "Run", "Cancel"] }), "User selected: Run")], ["Approve"]).status).toBe("none");
	});

	test("anything but one plain pick of an approving label is not approval", () => {
		const none = (details: unknown, text: string) => expect(find([ask(details, text)]).status, text).toBe("none");
		none(flat(["Request changes"]), "User selected: Request changes");
		none(flat(["Cancel"]), "User selected: Cancel");
		none(flat(["Approve"], { timedOut: true }), "User selected: Approve (auto-selected after timeout)");
		none(flat([], { customInput: "Approve" }), "User provided custom input: Approve");
		none(flat(["Approve"], { customInput: "but not yet" }), "User selected: Approve\nUser provided custom input: but not yet");
		none(flat(["Approve", "Cancel"], { multi: true }), "User selected: Approve, Cancel");
		none(flat([]), "User cancelled the selection");
		// A question that offers one answer is no decision.
		none(flat(["Approve"], { options: ["Approve"] }), "User selected: Approve");
		none({}, "Ask tool was cancelled by the user");
	});

	test("a note beside the pick does not change it", () => {
		expect(find([ask(flat(["Approve"], { note: "looks fine" }), "User selected: Approve\nUser added note: looks fine")]).status).toBe("approved");
	});

	test("one approving row among several questions counts", () => {
		expect(find([several()]).status).toBe("approved");
	});

	test("an unreadable ask result is reported unless an approving one is also there", () => {
		const odd = ask({ weird: true }, "something new");
		expect(find([odd])).toEqual({ status: "unrecognized", index: 0 });
		expect(find([approved(), odd])).toEqual({ status: "approved", index: 0 });
		expect(find([odd, wrote(), odd])).toEqual({ status: "unrecognized", index: 2 });
	});
});

describe("decideApproval: a spec", () => {
	const decide = (tool: string, input: unknown, raw: Raw[], askAvailable = true) => decideApproval(tool, input, entries(raw), { askAvailable });
	const flowTo = (...answer: Raw[]): Raw[] => [writeDraft(), wrote(), assistant(call("ask", { questions: [] })), ...answer];

	test("a call that approves nothing is allowed, whatever the branch holds", () => {
		expect(decide("write", { path: SPEC, content: "<!-- UNAPPROVED DRAFT -->" }, [])).toEqual({ action: "allow" });
		expect(decide("edit", { path: "src/a.ts", old_string: "a", new_string: "b" }, [])).toEqual({ action: "allow" });
		expect(decide("eval", { language: "py", code: "print(1)" }, [])).toEqual({ action: "allow" });
		expect(decide("bash", { command: "ls" }, [])).toEqual({ action: "allow" });
		expect(decide("read", undefined, [])).toEqual({ action: "allow" });
	});

	test("a flip with no ask in the branch is blocked, with the reason the skills' gate asks for", () => {
		const decision = decide("edit", flipSpec, [writeDraft(), wrote()]);
		expect(decision).toEqual({ action: "block", reason: REASON, flip: flip("spec", "marker", SPEC, "Approve") });
		expect(decide("write", { path: SPEC, content: "<!-- APPROVED 2026-10-01 -->" }, []).action).toBe("block");
	});

	test("a flip after the user's Approve is allowed, and the flip itself may already be in the branch", () => {
		expect(decide("edit", flipSpec, flowTo(approved()))).toEqual({ action: "allow" });
		expect(decide("edit", flipSpec, [...flowTo(approved()), assistant(call("edit", flipSpec))])).toEqual({ action: "allow" });
	});

	test("an answer that is not the user's plain Approve leaves the flip blocked", () => {
		const blocked = (...answer: Raw[]) => expect(decide("edit", flipSpec, flowTo(...answer)).action).toBe("block");
		blocked(ask(flat(["Request changes"]), "User selected: Request changes"));
		blocked(ask(flat(["Cancel"]), "User selected: Cancel"));
		blocked(ask(flat(["Approve"], { timedOut: true }), "User selected: Approve (auto-selected after timeout)"));
		blocked(ask(flat([], { customInput: "Approve" }), "User provided custom input: Approve"));
		blocked(ask({}, "Ask tool was cancelled by the user", true));
		blocked(ask({ chatRedirect: true }, "User chose to chat about this instead of answering."));
		blocked(result("bash", "User selected: Approve"));
		blocked();
	});

	test("an Approve that came before the draft was last written does not cover it", () => {
		const approvedFirst = [writeDraft(), wrote(), approved(), writeDraft(), wrote()];
		expect(decide("edit", flipSpec, approvedFirst).action).toBe("block");
		expect(decide("edit", flipSpec, [...approvedFirst, approved()]).action).toBe("allow");
		// An edit of the spec is a revision too.
		expect(decide("edit", flipSpec, [writeDraft(), approved(), assistant(call("edit", { path: SPEC, old_string: "# Spec", new_string: "# Specs" }))]).action).toBe("block");
		// Also one made by a hashline patch or an eval cell.
		expect(decide("edit", flipSpec, [writeDraft(), approved(), assistant(call("edit", { input: `[${SPEC}#A1B2]\nPUT 2.=2:\n+# Specs` }))]).action).toBe("block");
		expect(decide("edit", flipSpec, [writeDraft(), approved(), assistant(call("eval", { code: `Path("${SPEC}").write_text("x")` }))]).action).toBe("block");
	});

	test("a write of another file does not cover or void the approval", () => {
		expect(decide("edit", flipSpec, [writeDraft(), approved(), assistant(call("write", { path: "src/a.ts", content: "x" }))]).action).toBe("allow");
		expect(decide("edit", flipSpec, [writeDraft("/other/.omp/pipeline/specs/other.md"), approved()]).action).toBe("allow");
		expect(decide("edit", flipSpec, [approved(), writeDraft("/other/.omp/pipeline/specs/other.md")]).action).toBe("allow");
	});

	test("the same spec under another spelling of its path is the same file", () => {
		expect(decide("edit", flipSpec, [approved(), writeDraft(`/work/app/${SPEC}`)]).action).toBe("block");
		expect(decide("edit", flipSpec, [approved(), writeDraft(`./${SPEC}`)]).action).toBe("block");
	});

	test("an earlier flip is not a revision, so flipping again after one Approve is allowed", () => {
		const raw = [...flowTo(approved()), assistant(call("edit", flipSpec)), result("edit", "ok")];
		expect(decide("edit", flipSpec, raw)).toEqual({ action: "allow" });
		expect(decide("write", { path: SPEC, content: "<!-- APPROVED 2026-10-02 -->\n# Spec" }, raw)).toEqual({ action: "allow" });
	});

	test("with no draft write in the branch, an Approve anywhere in it counts", () => {
		expect(decide("edit", flipSpec, [approved()]).action).toBe("allow");
		expect(decide("edit", flipSpec, [ask(flat(["Cancel"]), "User selected: Cancel")]).action).toBe("block");
	});

	test("without an ask tool the same finding is would_block, and an answer in the branch still allows", () => {
		expect(decide("edit", flipSpec, [writeDraft()], false)).toEqual({ action: "would_block", reason: REASON, flip: flip("spec", "marker", SPEC, "Approve") });
		expect(decide("edit", flipSpec, flowTo(approved()), false)).toEqual({ action: "allow" });
		expect(decide("print", {}, [], false)).toEqual({ action: "allow" });
	});

	test("an approving row among several questions is enough", () => {
		expect(decide("edit", flipSpec, flowTo(several()))).toEqual({ action: "allow" });
	});

	test("without details the result's text decides", () => {
		const viaText = (text: string) => decideApproval("edit", flipSpec, scanBranch([writeDraft(), wrote(), ask(undefined, text)]), { askAvailable: true }).action;
		expect(viaText("User selected: Approve")).toBe("allow");
		expect(viaText("User answers:\nq1: Alpha\napproval: Approve")).toBe("allow");
		expect(viaText("User selected: Approve (auto-selected after timeout)")).toBe("block");
		expect(viaText("User provided custom input: Approve")).toBe("block");
		expect(viaText("User answers:\napproval: \"Approve\"")).toBe("block");
		expect(viaText("User selected: Request changes")).toBe("block");
	});

	test("an ask result of a shape nobody knows lets the flip through", () => {
		expect(decide("edit", flipSpec, flowTo(ask({ weird: true }, "something new"))).action).toBe("allow");
		expect(decide("edit", flipSpec, flowTo(ask("text", "something new"))).action).toBe("allow");
	});
});

describe("decideApproval: a PRD, a dag and approve_file", () => {
	const decide = (tool: string, input: unknown, raw: Raw[], askAvailable = true) => decideApproval(tool, input, entries(raw), { askAvailable });
	const prdDraft = (): Raw => assistant(call("write", { path: PRD, content: '{ "approved": false }' }));
	const dagGate = (pick: string): Raw => ask(flat([pick], { options: ["Edit", "Run", "Cancel"], question: "Run this dag?" }), `User selected: ${pick}`);

	test("a PRD's flag follows the same rule as a spec's marker", () => {
		expect(decide("edit", flipPrd, [prdDraft(), wrote()])).toMatchObject({ action: "block", reason: REASON });
		expect(decide("edit", flipPrd, [prdDraft(), wrote(), approved()])).toEqual({ action: "allow" });
		expect(decide("write", { path: PRD, content: '{"approved": true}' }, [prdDraft(), approved(), prdDraft()]).action).toBe("block");
	});

	test("approve_file with the PRD's path is approved by Approve, not by Run", () => {
		const cell = approveCell('".omp/pipeline/prd.json"');
		expect(decide("eval", cell, [prdDraft(), approved()])).toEqual({ action: "allow" });
		expect(decide("eval", cell, [prdDraft(), dagGate("Run")])).toMatchObject({ action: "block", reason: REASON });
		expect(decide("eval", cell, [prdDraft()])).toMatchObject({ action: "block", flip: { artifact: "prd", via: "call" } });
	});

	test("approve_file with a dag's path is approved by Run, and the reason names it", () => {
		const cell = approveCell(`"${DAG}"`);
		const draft = assistant(call("write", { path: DAG, content: '{ "approved": false }' }));
		expect(decide("eval", cell, [draft, dagGate("Run")])).toEqual({ action: "allow" });
		expect(decide("eval", cell, [draft, dagGate("Edit")])).toMatchObject({ action: "block", reason: "Approval needs the user's exact Run answer from the ask tool." });
		expect(decide("eval", cell, [draft, approved()]).action).toBe("block");
	});

	test("approve_file(path) takes either answer, since the variable names no file", () => {
		const cell = approveCell("path");
		expect(decide("eval", cell, [dagGate("Run")])).toEqual({ action: "allow" });
		expect(decide("eval", cell, [approved()])).toEqual({ action: "allow" });
		expect(decide("eval", cell, [dagGate("Edit")])).toMatchObject({ action: "block", reason: "Approval needs the user's exact Approve or Run answer from the ask tool." });
		expect(decide("eval", cell, [])).toMatchObject({ action: "block" });
	});

	test("the dag skill's free-text flow: the draft cell, the Run gate, then approve_file", () => {
		const draftCell = assistant(call("eval", { language: "py", code: 'path = f".omp/pipeline/dag/{slugify(goal)}.json"\nwith open(path, "w") as f:\n    json.dump(draft, f)' }));
		const cell = approveCell("path");
		expect(decide("eval", cell, [draftCell, wrote(), dagGate("Run")])).toEqual({ action: "allow" });
		// The user chose Edit; the model rewrote the draft and went on without asking again.
		expect(decide("eval", cell, [draftCell, dagGate("Edit"), draftCell, wrote()]).action).toBe("block");
		// A Run that came before the rewrite does not cover it.
		expect(decide("eval", cell, [draftCell, dagGate("Run"), draftCell, wrote()]).action).toBe("block");
		// A fix by the edit tool is a rewrite too.
		expect(decide("eval", cell, [draftCell, dagGate("Run"), assistant(call("edit", { path: DAG, old_string: "a", new_string: "b" }))]).action).toBe("block");
	});

	test("an eval cell that only reads or validates the plan is not a revision", () => {
		const cell = approveCell("path");
		const draftCell = assistant(call("eval", { language: "py", code: `Path("${DAG}").write_text(text)` }));
		const readCell = assistant(call("eval", { language: "py", code: `print(open("${DAG}").read())\nprint(validate_dag(load_dag("${DAG}")))` }));
		expect(decide("eval", cell, [draftCell, dagGate("Run"), readCell]).action).toBe("allow");
	});

	test("the calls that write a file make a cell a rewrite, the ones that read it do not", () => {
		const cell = approveCell("path");
		const after = (code: string) => decide("eval", cell, [dagGate("Run"), assistant(call("eval", { language: "py", code }))]).action;
		for (const code of [
			`open(os.path.join(root, "${DAG}"), "w").write(text)`,
			`json.dump(draft, open("${DAG}", "w"))`,
			`Path("${DAG}").write_bytes(data)`,
			`write("${DAG}", text)`,
			`await Bun.write("${PRD}", text)`,
			`sync_prd("${PRD}")`,
		]) {
			expect(after(code), code).toBe("block");
		}
		for (const code of [`print(open("${DAG}").read())`, `with open("${DAG}") as f:\n    print(f.read())`, `print(validate_dag(load_dag("${DAG}")))`]) {
			expect(after(code), code).toBe("allow");
		}
		// A cell that writes some other file is no rewrite of the plan.
		expect(after('open("notes.txt", "w").write(text)')).toBe("allow");
	});

	test("an Approve for the spec does not approve the PRD drafted after it", () => {
		const specFlow = [writeDraft(), approved()];
		expect(decide("edit", flipPrd, [...specFlow, prdDraft(), wrote()]).action).toBe("block");
		expect(decide("edit", flipPrd, [...specFlow, prdDraft(), wrote(), approved()]).action).toBe("allow");
	});

	test("without an ask tool an approve_file call is would_block", () => {
		expect(decide("eval", approveCell("path"), [], false)).toMatchObject({ action: "would_block", reason: "Approval needs the user's exact Approve or Run answer from the ask tool." });
	});

	test("every flip of a call needs its answer", () => {
		const cell = { language: "py", code: `approve_file("${DAG}")\napprove_file(".omp/pipeline/prd.json")` };
		expect(decide("eval", cell, [dagGate("Run")])).toMatchObject({ action: "block", flip: { artifact: "prd" } });
		expect(decide("eval", cell, [dagGate("Run"), approved()])).toEqual({ action: "allow" });
	});
});

describe("decideApproval fails open", () => {
	test("on a branch it cannot read", () => {
		for (const branch of [null, undefined, "branch", {}]) {
			const decision = decideApproval("edit", flipSpec, branch as unknown as ApprovalEntry[], { askAvailable: true });
			expect(decision, String(branch)).toEqual({ action: "allow", failedOpen: "the branch is unreadable" });
		}
	});

	test("on an input that throws when read, and says why", () => {
		const hostile = {
			get path(): string {
				throw new Error("boom");
			},
		};
		expect(decideApproval("write", hostile, [], { askAvailable: true })).toEqual({ action: "allow", failedOpen: "boom" });
		expect(decideApproval("edit", { path: SPEC, get new_string(): string { throw "plain"; } }, [], { askAvailable: true })).toEqual({ action: "allow", failedOpen: "plain" });
	});

	test("on a branch entry that throws when read", () => {
		const poisoned = {
			type: "message",
			get message(): never {
				throw new Error("entry");
			},
		};
		expect(decideApproval("edit", flipSpec, [poisoned as unknown as ApprovalEntry], { askAvailable: true })).toEqual({ action: "allow", failedOpen: "entry" });
	});

	test("odd inputs and entries are not flips and do not throw", () => {
		for (const input of [null, undefined, 3, "text", [], { path: 7, content: 7 }, { input: 7 }, { edits: [null, 1, [], { diff: 5 }] }]) {
			for (const tool of ["write", "edit", "apply_patch", "eval"]) {
				expect(detectApprovalFlips(tool, input), `${tool} ${JSON.stringify(input)}`).toEqual([]);
			}
		}
		const odd = scanBranch([null, 3, "x", [], { type: "message" }, { type: "message", message: { role: "toolResult", toolName: "ask" } }]);
		expect(decideApproval("edit", flipSpec, odd, { askAvailable: true }).action).toBe("allow");
	});

	test("a deeply nested edit input is cut off, not followed", () => {
		let deep: unknown = { new_string: "<!-- APPROVED -->" };
		for (let i = 0; i < 50; i++) deep = { nested: deep };
		expect(detectApprovalFlips("edit", { path: SPEC, edits: deep })).toEqual([]);
	});
});

// The guard runs synchronously in the `tool_call` hook, on omp's one thread, over text the model wrote or a tool returned (an eval
// cell, an ask result's text). A scan that is quadratic on one long line stalls the host for seconds at a few tens of kB: the
// call pattern's lookbehind took about 2.5 s on a cell with a 30,000-character string literal (maskCode blanks the literal to a
// run of spaces, and the lookbehind read back over the whole run from every position in it), and the note pattern about as long
// on 20,000 note openers. The literal pattern itself is linear; its cases are here because the cell they sit in was not.
describe("the approval scans stay linear on hostile text", () => {
	const N = 30_000;
	const cells: Array<[string, string, string?]> = [
		["a long literal followed by an operator", `approve_file("${"a".repeat(N)}" + x)`],
		["a long literal with no end", `approve_file("${"a".repeat(N)}`],
		["a long literal closed by another bracket", `approve_file("${"a".repeat(N)}"]`],
		["a long literal of escape pairs", `approve_file('${"\\a".repeat(N / 2)}' + x)`],
		["a long literal of escaped quotes", `approve_file("${'\\"'.repeat(N / 2)}" + x)`],
		["a literal that a trailing backslash breaks", `approve_file("${"a".repeat(N)}\\`],
		["a prefixed keyword literal", `approve_file(path = rb"${"a".repeat(N)}" + x)`],
		["a JS cell", `approve_file("${"a".repeat(N)}" + x)`, "js"],
		["a long run of spaces before the literal", `approve_file(${" ".repeat(N)}"a" + x)`],
		["a long run of spaces after the literal", `approve_file("a"${" ".repeat(N)}+ x)`],
		["a long run of spaces after the keyword", `approve_file(path${" ".repeat(N)}x)`],
		["a long run of spaces before the call", `${" ".repeat(N)}def${" ".repeat(N)}approve_file(x)`],
		["many calls, each with a long literal", `approve_file("${"a".repeat(N / 20)}" + x)\n`.repeat(20)],
	];
	for (const [name, code, language = "py"] of cells) {
		test(name, () => {
			const started = performance.now();
			detectApprovalFlips("eval", { language, code });
			expect(performance.now() - started).toBeLessThan(250);
		});
	}

	test("a hostile cell already in the branch is scanned in bounded time too", () => {
		const hostile = { language: "py", code: `approve_file("${"a".repeat(N)}" + x)` };
		const branch = entries([assistant(call("eval", hostile)), wrote()]);
		const started = performance.now();
		decideApproval("eval", approveCell("path"), branch, { askAvailable: true });
		decideApproval("eval", hostile, branch, { askAvailable: true });
		expect(performance.now() - started).toBeLessThan(250);
	});

	// omp words a note as ` (note: ...)` after the pick; the fallback reads that suffix off every line of a result's text.
	describe("a note suffix", () => {
		const answers = (value: string) => askAnswers(entries([ask(undefined, `User answers:\nq1: ${value}`)])[0]);

		test("a text of note openers with no closing bracket", () => {
			const started = performance.now();
			expect(answers(`x${" (note: ".repeat(20_000)}`)).toMatchObject([{ selected: [`x${" (note: ".repeat(20_000)}`] }]);
			expect(performance.now() - started).toBeLessThan(250);
		});

		test("a text of note openers that does end with one", () => {
			const started = performance.now();
			expect(answers(`Approve${" (note: ".repeat(20_000)}x)`)).toMatchObject([{ selected: ["Approve"] }]);
			expect(performance.now() - started).toBeLessThan(250);
		});

		test("a long run of openers and brackets, and one of each in several lines", () => {
			const started = performance.now();
			answers(" (note: )".repeat(8000));
			askAnswers(entries([ask(undefined, `User answers:\n${Array.from({ length: 2000 }, (_, i) => `q${i}: Yes (note: ${"(note: ".repeat(10)}`).join("\n")}`)])[0]);
			expect(performance.now() - started).toBeLessThan(250);
		});

		// The note is everything from the first opener to the final bracket, however many openers or brackets the note holds itself.
		test("it is cut at the first opener, and only when the line ends with the bracket", () => {
			const pick = (value: string) => answers(value)?.[0].selected;
			expect(pick("Approve (note: fine)")).toEqual(["Approve"]);
			expect(pick("Approve (note: see (note: b) and (c))")).toEqual(["Approve"]);
			expect(pick("Approve (note: )")).toEqual(["Approve"]);
			expect(pick("Approve (note: fine")).toEqual(["Approve (note: fine"]);
			expect(pick("Approve (note: fine) later")).toEqual(["Approve (note: fine) later"]);
			expect(pick("Approve (note:)")).toEqual(["Approve (note:)"]);
			expect(pick("Approve(note: x)")).toEqual(["Approve(note: x)"]);
			// The opener alone is no note, and a bracket that comes before it is not its end.
			expect(pick("Approve (note: ")).toEqual(["Approve (note: "]);
			expect(pick("Approve) (note: ")).toEqual(["Approve) (note: "]);
			expect(pick("[Red, Green] (note: n)")).toEqual(["Red", "Green"]);
			// The note comes off before the timeout mark, which it follows.
			expect(answers("Yes (auto-selected after timeout) (note: n)")).toMatchObject([{ selected: ["Yes"], timedOut: true }]);
		});
	});
});

describe("flipAskEntries and isTypedAppeal: the context and the trigger of the Jev second opinion", () => {
	const SPEC_FLIP = flip("spec", "marker", SPEC, "Approve");
	const typed = (customInput: string, extra: Raw = {}): Raw => ask(flat([], { customInput, ...extra }), `User provided custom input:\n${customInput}`);
	const picked = (selected: string): Raw => ask(flat([selected]), `User selected: ${selected}`);

	test("every readable answer behind the draft is context, grouped per ask result, refusals included", () => {
		const branch = entries([writeDraft(), wrote(), typed("yes, once you rename it"), picked("Cancel")]);
		expect(flipAskEntries(branch, SPEC_FLIP).map((group) => group.map((a) => a.customInput ?? a.selected.join(",")))).toEqual([["yes, once you rename it"], ["Cancel"]]);
		expect(flipAskEntries(entries([writeDraft(), wrote()]), SPEC_FLIP)).toEqual([]);
	});

	test("one ask result is one unit: typed words beside a pick count, a later pure pick does not", () => {
		const after = (tail: Raw[]) => flipAskEntries(entries([writeDraft(), wrote(), ...tail]), SPEC_FLIP);
		expect(isTypedAppeal(after([typed("Yes, ship it")]))).toBe(true);
		expect(isTypedAppeal(after([ask(flat(["Approve"], { customInput: "yes, and hurry" }), "User selected: Approve")]))).toBe(true);
		// A later explicit refusal wins over the typed words: no judgment.
		expect(isTypedAppeal(after([typed("yes, once you rename it"), picked("Cancel")]))).toBe(false);
		expect(isTypedAppeal(after([picked("Request changes")]))).toBe(false);
		expect(isTypedAppeal(after([approved()]))).toBe(false);
		expect(isTypedAppeal(after([]))).toBe(false);
	});

	test("a timeout picked it, not the user: never a trigger", () => {
		const timedOut = ask(flat([], { customInput: "Approve", timedOut: true }), "User selected: Approve (auto-selected after timeout)");
		expect(isTypedAppeal(flipAskEntries(entries([writeDraft(), wrote(), timedOut]), SPEC_FLIP))).toBe(false);
	});

	test("answers from before the latest draft write are stale", () => {
		expect(flipAskEntries(entries([typed("Yes"), writeDraft(), wrote()]), SPEC_FLIP)).toEqual([]);
	});

	test("an unreadable ask shape is skipped, not thrown on", () => {
		const odd = result("ask", "", { somethingNew: true });
		expect(flipAskEntries(entries([writeDraft(), wrote(), odd]), SPEC_FLIP)).toEqual([]);
	});

	test("a later cancelled ask vetoes the earlier typed words", () => {
		const cancelled = ask({}, "Error: Cancelled by user", true);
		const groups = flipAskEntries(entries([writeDraft(), wrote(), typed("Yes"), cancelled]), SPEC_FLIP);
		expect(groups).toHaveLength(2);
		expect(groups[1]).toEqual([]);
		expect(isTypedAppeal(groups)).toBe(false);
	});
});

describe("sameApprovalFlip and the granted exclusion", () => {
	const SPEC_FLIP = flip("spec", "marker", SPEC, "Approve");

	test("same artifact, via, path and labels; nothing less", () => {
		expect(sameApprovalFlip(SPEC_FLIP, { ...SPEC_FLIP })).toBe(true);
		expect(sameApprovalFlip(SPEC_FLIP, flip("spec", "marker", SPEC, "Run"))).toBe(false);
		expect(sameApprovalFlip(SPEC_FLIP, flip("spec", "marker", ".omp/pipeline/specs/other.md", "Approve"))).toBe(false);
		expect(sameApprovalFlip(SPEC_FLIP, flip("prd", "flag", ".omp/pipeline/prd.json", "Approve"))).toBe(false);
	});

	test("a granted flip is approved; a sibling flip still blocks until it is granted too", () => {
		const branch: Raw[] = [];
		const cell = { language: "py", code: `approve_file("${PRD}")\napprove_file(".omp/pipeline/dag/login.json")` };
		const decided = (granted: ApprovalFlip[]) => decideApproval("eval", cell, entries(branch), { askAvailable: true }, granted);
		const first = decided([]);
		expect(first.action).toBe("block");
		if (first.action !== "block") throw new Error("unreachable");
		expect(first.flip.artifact).toBe("prd");
		const second = decided([first.flip]);
		expect(second.action).toBe("block");
		if (second.action !== "block") throw new Error("unreachable");
		expect(second.flip.artifact).toBe("dag");
		expect(decided([first.flip, second.flip]).action).toBe("allow");
	});
});

describe("approvalBlockReason and APPROVAL_TOOLS", () => {
	test("the reason names the answers that would have counted", () => {
		expect(approvalBlockReason(["Approve"])).toBe(REASON);
		expect(approvalBlockReason(["Run"])).toBe("Approval needs the user's exact Run answer from the ask tool.");
		expect(approvalBlockReason(["Approve", "Run"])).toBe("Approval needs the user's exact Approve or Run answer from the ask tool.");
	});

	test("the tools that can flip an approval are the ones the detectors read", () => {
		expect([...APPROVAL_TOOLS].sort()).toEqual(["apply_patch", "edit", "eval", "write"]);
	});
});

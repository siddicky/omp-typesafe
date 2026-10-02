import { describe, expect, test } from "bun:test";
import { scanBranch } from "../../src/branch";
import { DAG_CALLS, findDagCall, maskPython, planGuardDecision, planGuardReason } from "../../src/pipeline/plan-guard";

/**
 * src/pipeline/plan-guard.ts on its own: the Python masker, the dag call detector, and the decision over a scanned
 * branch. The branch entries have the shapes omp records (read from real sessions: a `mode_change` carries `mode` and
 * `data.planFilePath`, the plan-mode customTypes sit on `custom_message` entries), and the dag cells are the ones the
 * omp-skills `dag` skill and its smoke runs send. How index.ts uses the decision is tested where it is wired.
 */

// ---- branch fixtures --------------------------------------------------------------------------------------------

const modeChange = (mode: string, planFilePath?: string) => ({ type: "mode_change", mode, ...(planFilePath ? { data: { planFilePath } } : {}) });
const marker = (customType: string, content = "") => ({ type: "custom_message", customType, content, display: false, attribution: "agent" });
const enterPlan = [modeChange("plan", "local://PLAN.md"), marker("plan-mode-context", "<critical>\nPlan mode active.\n- Working tree/system read-only")];
const userSays = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantCalls = (name: string, args: Record<string, unknown>) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } });
const filler = (count: number) => Array.from({ length: count }, (_, k) => userSays(`turn ${k}`));

const ON = { planGuard: true };
const OFF = { planGuard: false };
const DAG_CELL = { code: 'dag = await run_dag(dag, state_path=state_path, isolated=isolated, max_attempts=2)\nprint(summarize(dag))', language: "py", timeout: 0, title: "run DAG" };

/** The decision for an `eval` call after `raw` branch entries. */
function evalDecision(raw: unknown[], input: unknown = DAG_CELL, settings: { planGuard: boolean } = ON) {
	return planGuardDecision(scanBranch(raw), "eval", input, settings);
}

// ---- maskPython -------------------------------------------------------------------------------------------------

/** `n` blanks: what the masker leaves of `n` characters that are not code. */
const sp = (n: number): string => " ".repeat(n);

describe("maskPython", () => {
	test("keeps code and blanks a comment up to the end of its line", () => {
		expect(maskPython("x = 1  # run_dag(\ny = 2")).toBe(`x = 1  ${sp(10)}\ny = 2`);
	});

	test("blanks single, double and triple quoted strings, quotes included", () => {
		expect(maskPython(`a = 'run_dag(' + "prepare_dag("`)).toBe(`a = ${sp(10)} + ${sp(14)}`);
		expect(maskPython('s = """run_dag(\nsecond line\n"""\nt = 1')).toBe(`s = ${sp(11)}\n${sp(11)}\n${sp(3)}\nt = 1`);
		expect(maskPython(`s = '''a'b"c'''`)).toBe(`s = ${sp(11)}`);
	});

	test("a hash inside a string is not a comment, a quote inside a comment is not a string", () => {
		expect(maskPython('s = "# not a comment"; run_dag(')).toBe(`s = ${sp(17)}; run_dag(`);
		expect(maskPython("# it's a comment\nrun_dag(")).toBe(`${sp(16)}\nrun_dag(`);
	});

	test("a backslash shields the next character: an escaped quote does not end the string, in a raw string too", () => {
		expect(maskPython(String.raw`s = "a\"run_dag(\""; x`)).toBe(`s = ${sp(15)}; x`);
		expect(maskPython(String.raw`s = r"a\"b"; y`)).toBe(`s = ${sp(7)}; y`);
	});

	test("a backslash never shields the brace of an f-string field, raw or not: `\\{x}` is a backslash and a field", () => {
		for (const prefix of ["f", "rf", "fr", "F", "Rf"]) {
			expect(maskPython(`${prefix}"\\{run_dag(d)}"`), prefix).toBe(`${sp(prefix.length + 3)}run_dag(d)${sp(2)}`);
		}
		// An escaped backslash is a pair, then the brace opens the field; `\{{` is a backslash and a literal brace.
		expect(maskPython(String.raw`f"\\{run_dag(d)}"`)).toBe(`${sp(5)}run_dag(d)${sp(2)}`);
		expect(maskPython(String.raw`rf"\{{run_dag(}}"`)).toBe(sp(String.raw`rf"\{{run_dag(}}"`.length));
		// In a string that is not an f-string a brace is only text, and the backslash still shields what follows it.
		expect(maskPython(String.raw`"\{run_dag(d)}"`)).toBe(sp(String.raw`"\{run_dag(d)}"`.length));
		expect(maskPython(String.raw`b"\{run_dag(d)}"`)).toBe(sp(String.raw`b"\{run_dag(d)}"`.length));
	});

	test("a backslash before a newline continues a string onto the next line", () => {
		expect(maskPython("s = 'a\\\nrun_dag('\nz")).toBe(`s = ${sp(3)}\n${sp(9)}\nz`);
	});

	test("string prefixes in any case are part of the literal", () => {
		for (const prefix of ["r", "b", "u", "f", "br", "rb", "fr", "rf", "R", "B", "U", "F", "Rb", "bR", "FR", "rF"]) {
			expect(maskPython(`${prefix}'run_dag('`), prefix).toBe(sp(prefix.length + 10));
			expect(maskPython(`${prefix}"run_dag("`), prefix).toBe(sp(prefix.length + 10));
		}
	});

	test("a name that only ends in a prefix letter is code, not the start of a string", () => {
		expect(maskPython('bar"x"')).toBe(`bar${sp(3)}`);
		expect(maskPython("print'x'")).toBe(`print${sp(3)}`);
	});

	test("an unterminated single-quoted string ends with its line", () => {
		expect(maskPython("s = 'oops\nrun_dag(")).toBe(`s = ${sp(5)}\nrun_dag(`);
	});

	test("keeps the expressions of an f-string's replacement fields and blanks the rest", () => {
		expect(maskPython('f"a {run_dag(d)} b"')).toBe(`${sp(5)}run_dag(d)${sp(4)}`);
		expect(maskPython('f"a {x} b"')).toBe(`${sp(5)}x${sp(4)}`);
		expect(maskPython('f"{{run_dag(}}"')).toBe(sp(15));
	});

	test("an f-string's conversion and format spec are not code, a nested field in the spec is", () => {
		expect(maskPython('f"{x!r:>{w}}"')).toBe(`${sp(3)}x${sp(5)}w${sp(3)}`);
		expect(maskPython('f"{x:%Y-run_dag(}"')).toBe(`${sp(3)}x${sp(14)}`);
		expect(maskPython('f"{a != b}"')).toBe(`${sp(3)}a != b${sp(2)}`);
	});

	test("follows brackets and nested quotes in a field, in both the pre and post 3.12 forms", () => {
		expect(maskPython(`f'{d["run_dag("]}'`)).toBe(`${sp(3)}d[${sp(10)}]${sp(2)}`);
		expect(maskPython('f"{d["k"]}"')).toBe(`${sp(3)}d[${sp(3)}]${sp(2)}`);
		expect(maskPython('f"{ {1: 2}[1] }"')).toBe(`${sp(3)} {1: 2}[1] ${sp(2)}`);
	});

	test("a nested f-string is followed to a bounded depth and never overflows the stack", () => {
		const deep = 'f"{'.repeat(2000) + "run_dag(" + '}"'.repeat(2000);
		expect(maskPython(deep)).toHaveLength(deep.length);
	});

	test("keeps the source's length and newlines, and only ever copies a source character or blanks it", () => {
		const src = 'a = f"x{y}"  # c\n"""t\nu"""\nb\\\n= 1\r\n';
		const out = maskPython(src);
		expect(out).toHaveLength(src.length);
		for (let k = 0; k < src.length; k++) {
			if (src[k] === "\n") expect(out[k]).toBe("\n");
			else expect(out[k] === src[k] || out[k] === " ").toBe(true);
		}
	});
});

// ---- findDagCall ------------------------------------------------------------------------------------------------

describe("findDagCall: calls it finds", () => {
	const hits: Array<[string, string]> = [
		["a bare call", "run_dag(dag)"],
		["an awaited call, the form the dag skill's Cell 3 uses", "dag = await run_dag(dag, state_path=state_path, isolated=isolated, max_attempts=2)\nprint(summarize(dag))"],
		["whitespace before the parenthesis", "await run_dag   (dag)"],
		["a tab before the parenthesis", "await run_dag\t(dag)"],
		["a line continuation before the parenthesis", "await run_dag \\\n  (dag)"],
		["a call on a receiver", "dag = await runner.run_dag(dag)"],
		["a call inside brackets, a lambda and a comprehension", "[await run_dag(d) for d in dags]"],
		["a call after a semicolon", "x = 1; await run_dag(dag)"],
		["a call argument of another call", "print(summarize(await run_dag(dag, state_path=p)))"],
		["a call in an f-string field", 'print(f"result: {await run_dag(dag)}")'],
		["a call in a nested f-string field", `print(f"{f'{await run_dag(dag)}'}")`],
		["a call in a format spec's nested field", 'print(f"{value:{await run_dag(dag)}}")'],
		["a call in an f-string field behind a backslash, raw or not", 'x = rf"\\{run_dag(d)}"\ny = f"\\{prepare_dag(d)}"'],
		["a call in a 3.12 f-string with the same quotes inside", 'print(f"{d["k"]} {await run_dag(dag)}")'],
		["a call after a string that mentions it", 'print("run_dag(")\nawait run_dag(dag)'],
		["a call after a docstring that mentions it", '"""run_dag("""\nawait run_dag(dag)'],
		["a call after a comment that mentions it", "# run_dag(\nawait run_dag(dag)"],
		["a call on the line after an unterminated string", "s = 'oops\nawait run_dag(dag)"],
		["a call on a CRLF source", "x = 1\r\nawait run_dag(dag)\r\n"],
		["a call whose result is discarded in a try block", "try:\n    await run_dag(dag)\nexcept ValueError as e:\n    print(e)"],
	];
	for (const [label, code] of hits) {
		test(label, () => expect(findDagCall(code)).toBe("run_dag"));
	}

	test("prepare_dag, the dag skill's Cell 2 verbatim", () => {
		const cell2 = [
			"stale = None",
			"try:",
			'    state_path, dag, resumed = prepare_dag("<source path>")',
			"except StaleState as e:",
			"    stale = e",
			"    print(e)",
			"else:",
			'    print("state file:", state_path)  # resume later with: /skill:dag <state_path>',
			"    if resumed:",
			"        print(summarize(dag))",
		].join("\n");
		expect(findDagCall(cell2)).toBe("prepare_dag");
	});

	test("the first call in the source wins when a cell has both", () => {
		expect(findDagCall("a = prepare_dag(p)\nawait run_dag(a)")).toBe("prepare_dag");
		expect(findDagCall("await run_dag(a)\nb = prepare_dag(p)")).toBe("run_dag");
	});

	test("a smoke run's cell with an exec of the runner first", () => {
		const cell = [
			'exec(open("/path/to/skills/dag/runner.py").read(), globals())',
			'dag = load_dag("/tmp/dag-smoke/.omp/pipeline/dag/smoke.json")',
			"assert validate_dag(dag) == [], validate_dag(dag)",
			'dag = await run_dag(dag, state_path="/tmp/dag-smoke/.omp/pipeline/dag/smoke.json", isolated=False, max_attempts=2)',
			"print(summarize(dag))",
		].join("\n");
		expect(findDagCall(cell)).toBe("run_dag");
	});

	test("every name the module lists is found", () => {
		for (const name of DAG_CALLS) expect(findDagCall(`${name}(x)`)).toBe(name);
	});
});

describe("findDagCall: text that is not a call", () => {
	const misses: Array<[string, string]> = [
		["a line comment", "# await run_dag(dag)\nprint('ok')"],
		["a trailing comment", "print('ok')  # run_dag(dag)"],
		["a single-quoted string", "print('run_dag(dag)')"],
		["a double-quoted string", 'print("prepare_dag(path)")'],
		["a triple-quoted docstring", 'def f():\n    """Runs run_dag(dag) later."""\n    return 1'],
		["a multi-line triple-quoted string", "text = '''\nawait run_dag(dag)\n'''\nprint(text)"],
		["a raw string", 'pattern = r"run_dag\\("'],
		["a bytes string", "payload = b'run_dag('"],
		["an f-string's literal text", 'print(f"calling run_dag(dag) for {name}")'],
		["an f-string's escaped braces", 'print(f"{{run_dag(dag)}}")'],
		["an f-string's format spec", 'print(f"{x:run_dag(}")'],
		["an f-string's conversion", 'print(f"{x!r}")'],
		["a string that holds an escaped quote before the name", 'print("say \\"hi\\" then run_dag(dag)")'],
		["a string with a hash in it", 'print("# not a comment", "run_dag(")'],
		["a longer name that ends in the call's name", "my_run_dag(dag)"],
		["a longer name that starts with the call's name", "run_dag_summary(dag)\nprepare_dag2(p)"],
		["a name with a digit prefix or suffix", "x1run_dag(dag)\nrun_dag1(dag)"],
		["a Unicode name that contains it", "ärun_dag(dag)\nrun_dagé(dag)\nrun_daǵ(dag)"],
		["a bare reference", "runner = run_dag\nf = functools.partial(run_dag, dag)\nprint(callable(run_dag))"],
		["an import", "from runner import run_dag, prepare_dag"],
		["an assignment to the name", "run_dag = None\nprepare_dag = 1"],
		["a definition", "async def run_dag(dag, **kw):\n    return dag\ndef prepare_dag(path):\n    return path"],
		["a call by a computed name", 'await globals()["run_dag"](dag)\ngetattr(runner, "prepare_dag")(p)'],
		["a different function", "print(summarize(dag))\nload_dag(path)\nvalidate_dag(dag)\napprove_file(path)"],
		["a name split across lines of an expression", "run_\\\ndag(dag)"],
		["a string right after the name", 'run_dag"("'],
		["no code at all", ""],
		["whitespace only", "  \n\t\n"],
	];
	for (const [label, code] of misses) {
		test(label, () => expect(findDagCall(code)).toBeNull());
	}

	test("a call after an unterminated triple-quoted string is part of that string", () => {
		expect(findDagCall('"""never closed\nawait run_dag(dag)')).toBeNull();
	});
});

describe("findDagCall: any input", () => {
	test("never throws and keeps masking in step with the source, on random text built from Python's awkward characters", () => {
		const alphabet = ["'", '"', "'''", '"""', "#", "\\", "{", "}", "(", ")", "[", "]", ":", "!", "=", " ", "\n", "\r\n", "f", "r", "b", "rb", "run_dag", "prepare_dag", "x", "é", "😀"];
		let seed = 0x2f6e2b1;
		const next = (): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed;
		};
		for (let round = 0; round < 3000; round++) {
			let src = "";
			for (let k = next() % 40; k > 0; k--) src += alphabet[next() % alphabet.length];
			const masked = maskPython(src);
			expect(masked).toHaveLength(src.length);
			expect(() => findDagCall(src)).not.toThrow();
		}
	});

	test("a very large cell is scanned in one pass", () => {
		const filler = "x = 1  # run_dag(\n".repeat(60_000);
		expect(findDagCall(filler)).toBeNull();
		expect(findDagCall(`${filler}await run_dag(dag)`)).toBe("run_dag");
	});
});

// ---- planGuardDecision ------------------------------------------------------------------------------------------

describe("planGuardDecision: blocks", () => {
	test("a dag run in a TUI plan session: the mode change and the plan-mode-context omp records", () => {
		const d = evalDecision([userSays("run the dag"), ...enterPlan]);
		expect(d.block).toBe(true);
		if (d.block) expect(d.reason).toBe(planGuardReason("run_dag"));
	});

	test("the plan-yolo shape, where plan-mode-context is the only signal (no mode_change is written)", () => {
		expect(evalDecision([userSays("go"), marker("plan-mode-context")]).block).toBe(true);
	});

	test("a mode_change to plan alone, before any prompt has been persisted", () => {
		expect(evalDecision([modeChange("plan", "local://PLAN.md")]).block).toBe(true);
	});

	test("a staged DAG (prepare_dag) is blocked too, and the reason names the call", () => {
		const d = evalDecision(enterPlan, { code: 'state_path, dag, resumed = prepare_dag("p.json")', language: "py" });
		expect(d).toEqual({ block: true, reason: planGuardReason("prepare_dag") });
		if (d.block) expect(d.reason).toContain("prepare_dag()");
	});

	test("however far back the plan marker is: there is no window on the branch", () => {
		expect(evalDecision([...enterPlan, ...filler(500)]).block).toBe(true);
	});

	test("plan mode entered again after an exit", () => {
		expect(evalDecision([...enterPlan, modeChange("none"), userSays("again"), modeChange("plan", "local://PLAN.md")]).block).toBe(true);
	});

	test("omp's py prelude field and the other eval fields do not matter", () => {
		expect(evalDecision(enterPlan, { ...DAG_CELL, i: "py prelude", reset: false }).block).toBe(true);
	});

	test("the language names for Python, in any case, or none", () => {
		for (const language of ["py", "python", "PY", "Python", "ipy", "ipython", "py3", "python3", " py "]) {
			expect(evalDecision(enterPlan, { code: "await run_dag(d)", language }).block, language).toBe(true);
		}
		expect(evalDecision(enterPlan, { code: "await run_dag(d)" }).block).toBe(true);
		expect(evalDecision(enterPlan, { code: "await run_dag(d)", language: "" }).block).toBe(true);
		expect(evalDecision(enterPlan, { code: "await run_dag(d)", language: 3 }).block).toBe(true);
	});

	test("a wider settings object, such as the whole pipeline config, is read for planGuard", () => {
		const pipeline = { planGuard: true, skillAware: false, specChecks: true };
		expect(planGuardDecision(scanBranch(enterPlan), "eval", DAG_CELL, pipeline).block).toBe(true);
	});
});

describe("planGuardDecision: lets through", () => {
	test("any session that is not in plan mode: none, plan_paused and an empty branch", () => {
		expect(evalDecision([]).block).toBe(false);
		expect(evalDecision([userSays("hi"), assistantCalls("eval", DAG_CELL)]).block).toBe(false);
		expect(evalDecision([...enterPlan, modeChange("none")]).block).toBe(false);
		expect(evalDecision([...enterPlan, modeChange("plan_paused")]).block).toBe(false);
		expect(evalDecision([modeChange("plan_paused"), modeChange("none")]).block).toBe(false);
	});

	test("the plan-mode-context an exited plan left behind does not count, even a few entries back", () => {
		expect(evalDecision([...enterPlan, marker("plan-mode-context"), ...filler(5), modeChange("none")]).block).toBe(false);
		expect(evalDecision([...enterPlan, ...filler(5), modeChange("none"), ...filler(5)]).block).toBe(false);
	});

	test("the execution phase after plan approval: plan-mode-reference is plan mode off", () => {
		const approved = marker("plan-mode-reference", "## Existing Plan\n\nApproved plan inlined below; durable copy at `local://x-plan.md` (identical content).");
		expect(evalDecision([...enterPlan, ...filler(3), approved]).block).toBe(false);
		expect(evalDecision([...enterPlan, modeChange("none"), approved, marker("skill-prompt")]).block).toBe(false);
	});

	test("the plan-yolo handoff into execution", () => {
		expect(evalDecision([marker("plan-mode-context"), marker("plan-yolo-handoff")]).block).toBe(false);
	});

	test("any tool but eval, even with a dag call in its input", () => {
		const call = "await run_dag(dag)";
		const inputs: Array<[string, unknown]> = [
			["write", { path: "notes.md", content: `Cell 3:\n${call}` }],
			["bash", { command: `echo '${call}'` }],
			["edit", { path: "a.py", edits: [{ new_text: call }] }],
			["read", { path: "skills/dag/SKILL.md" }],
			["task", { prompt: call }],
			["typesafe_ask", { state: call, questions: [] }],
			["Eval", { code: call, language: "py" }],
			["", { code: call, language: "py" }],
		];
		for (const [tool, input] of inputs) expect(planGuardDecision(scanBranch(enterPlan), tool, input, ON).block, tool).toBe(false);
	});

	test("an eval cell in another language", () => {
		for (const language of ["js", "ts", "javascript", "typescript", "node", "sh", "bash", "r"]) {
			expect(evalDecision(enterPlan, { code: "await run_dag(d)", language }).block, language).toBe(false);
		}
	});

	test("an eval cell that does not call the runner", () => {
		const cells = [
			'print("run_dag(dag)")',
			"# await run_dag(dag)\nprint(1)",
			"print(summarize(dag))",
			'exec(open("/path/to/skills/dag/runner.py").read(), globals())',
			'dag = load_dag("p.json")\nassert validate_dag(dag) == []',
			"",
		];
		for (const code of cells) expect(evalDecision(enterPlan, { code, language: "py" }).block, code).toBe(false);
	});

	test("a cell that only reads the skill and tests its text for the name", () => {
		expect(evalDecision(enterPlan, { code: 'text = open("skills/dag/SKILL.md").read()\nprint("run_dag(" in text)', language: "py" }).block).toBe(false);
	});

	test("the guard switched off", () => {
		expect(evalDecision(enterPlan, DAG_CELL, OFF).block).toBe(false);
	});

	test("settings that are not a switched-on guard: missing, empty, or planGuard not true", () => {
		const entries = scanBranch(enterPlan);
		for (const settings of [undefined, null, {}, { planGuard: "yes" }, { planGuard: 1 }, { planGuard: undefined }]) {
			expect(planGuardDecision(entries, "eval", DAG_CELL, settings as unknown as { planGuard: boolean }).block).toBe(false);
		}
	});

	test("an input it cannot read", () => {
		const unreadable: unknown[] = [undefined, null, "await run_dag(d)", 42, true, [], [DAG_CELL], {}, { code: 42 }, { code: null }, { code: ["await run_dag(d)"] }, { language: "py" }, { cells: [DAG_CELL] }];
		const entries = scanBranch(enterPlan);
		for (const input of unreadable) expect(planGuardDecision(entries, "eval", input, ON).block, JSON.stringify(input)).toBe(false);
	});
});

describe("planGuardDecision: robustness", () => {
	test("any exception while reading the branch or the input is a pass, not a block", () => {
		const hostileEntries = new Proxy([], {
			get() {
				throw new Error("branch unreadable");
			},
		}) as never;
		expect(planGuardDecision(hostileEntries, "eval", DAG_CELL, ON)).toEqual({ block: false });
		const hostileInput = {
			get code(): string {
				throw new Error("input unreadable");
			},
		};
		expect(planGuardDecision(scanBranch(enterPlan), "eval", hostileInput, ON)).toEqual({ block: false });
		const hostileSettings = {
			get planGuard(): boolean {
				throw new Error("settings unreadable");
			},
		};
		expect(planGuardDecision(scanBranch(enterPlan), "eval", DAG_CELL, hostileSettings)).toEqual({ block: false });
	});

	test("a branch of junk entries is no plan mode", () => {
		const entries = scanBranch([null, 3, "x", [], {}, { type: 5 }, { type: "mode_change" }, { type: "custom_message", customType: 7 }]);
		expect(planGuardDecision(entries, "eval", DAG_CELL, ON)).toEqual({ block: false });
	});

	test("the answer is the same each time, and neither the branch nor the input is changed", () => {
		const entries = Object.freeze(scanBranch(enterPlan).map((e) => Object.freeze(e))) as never;
		const input = Object.freeze({ ...DAG_CELL });
		const first = planGuardDecision(entries, "eval", input, ON);
		expect(planGuardDecision(entries, "eval", input, ON)).toEqual(first);
		expect(first.block).toBe(true);
		expect(input).toEqual(DAG_CELL);
	});

	test("the decision is plain data the hook can return as it is", () => {
		const d = evalDecision(enterPlan);
		expect(Object.keys(d).sort()).toEqual(["block", "reason"]);
		expect(evalDecision([])).toEqual({ block: false });
	});
});

describe("planGuardReason", () => {
	test("says what was blocked, why, that nothing ran, and how the user gets out of plan mode", () => {
		const reason = planGuardReason("run_dag");
		expect(reason).toContain("run_dag()");
		expect(reason).toContain("plan mode");
		expect(reason).toContain("read-only");
		expect(reason).toContain("blocked");
		expect(reason).toContain("Nothing was run");
		expect(reason).toContain("Shift+Tab");
		expect(reason).toContain("/plan");
		expect(reason).toContain("re-run");
	});

	test("is one paragraph the model can quote, and differs only by the call", () => {
		expect(planGuardReason("run_dag")).not.toContain("\n");
		expect(planGuardReason("prepare_dag").replace("prepare_dag", "run_dag")).toBe(planGuardReason("run_dag"));
	});
});

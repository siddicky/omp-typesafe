import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanBranch } from "../../src/branch";
import { DEFAULT_PIPELINE_SKILLS, isPipelineSkill, latestUserTurnSkill, parseSkillPrompt, skillInvocationFromEntry } from "../../src/pipeline/skill";

type Raw = Record<string, unknown>;

const RULE =
	"Resolve relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against this absolute directory; read referenced assets and templates; run scripts with the terminal tool when skill instructions call for it.";
const DIR = "/home/me/.omp/agent/skills/probe-skill";

/** The prompt omp's TUI and RPC modes hand `before_agent_start` for a `/skill:` invocation (recorded shape). */
const expanded = (name: string, body: string, args = "", dir = DIR): string =>
	`[IMPORTANT: User invoked the "${name}" skill; follow its instructions. Full skill below.]\n\n${body}\n\n---\n\n[Skill directory: ${dir}]\n${RULE}${args === "" ? "" : `\nUser: ${args}`}`;

/** The `custom_message` omp writes to the branch for the same invocation (recorded shape). */
const skillEntry = (details: Raw, extra: Raw = {}): Raw => ({
	type: "custom_message",
	id: "s1",
	customType: "skill-prompt",
	content: expanded(String(details.name), "# Skill body", String(details.args ?? "")),
	display: true,
	attribution: "user",
	details,
	...extra,
});
const user = (text: string): Raw => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string): Raw => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("parseSkillPrompt, the expanded shape (TUI and RPC)", () => {
	test("reads the skill and the args from the recorded template", () => {
		const prompt = expanded("probe-skill", "# Probe skill\n\nDo the probe thing.", "alpha beta");
		expect(parseSkillPrompt(prompt)).toEqual({ name: "probe-skill", args: "alpha beta", source: "expanded" });
	});
	test("a skill invoked without args has none", () => {
		expect(parseSkillPrompt(expanded("dag", "# DAG"))).toEqual({ name: "dag", args: "", source: "expanded" });
	});
	test("the skill body is never taken for the args", () => {
		const body = "# Interview\n\nRules.\n\n---\n\nUser: an example line from the skill itself\n\n[Skill directory: /somewhere]\nnot the real footer";
		expect(parseSkillPrompt(expanded("deep-interview", body, "add a flag"))?.args).toBe("add a flag");
		expect(parseSkillPrompt(expanded("deep-interview", body))?.args).toBe("");
	});
	test("args may span lines and may hold a `User:` line or the footer's own text", () => {
		const args = "first line\nUser: second\n\n---\n\n[Skill directory: /x]\nthird";
		expect(parseSkillPrompt(expanded("ralplan", "# Plan", args))?.args).toBe(args);
	});
	test("a namespaced skill name is kept whole", () => {
		expect(parseSkillPrompt(expanded("omp-skills/dag", "# DAG", "x"))).toEqual({ name: "omp-skills/dag", args: "x", source: "expanded" });
	});
	test("a footer it does not recognise reads as no args, and the skill is still known", () => {
		const prompt = '[IMPORTANT: User invoked the "dag" skill; follow its instructions. Full skill below.]\n\n# DAG\n\nsome future footer\nUser: lost';
		expect(parseSkillPrompt(prompt)).toEqual({ name: "dag", args: "", source: "expanded" });
	});
	test("tolerates leading whitespace and wording after the skill name", () => {
		expect(parseSkillPrompt(`\n  ${expanded("dag", "# DAG", "go")}`)?.args).toBe("go");
		expect(parseSkillPrompt('[IMPORTANT: User invoked the "dag" skill, whatever follows')?.name).toBe("dag");
	});
	test("takes precedence over a /skill: token in the skill's own text", () => {
		expect(parseSkillPrompt(expanded("dag", "run /skill:other first", "x"))).toEqual({ name: "dag", args: "x", source: "expanded" });
	});
	test("an empty skill name is not an invocation", () => {
		expect(parseSkillPrompt('[IMPORTANT: User invoked the " " skill; follow its instructions.]')).toBeNull();
	});

	// The recorded shape above is a copy; this reads the template of the omp release the extension is built against.
	test("reads what omp's own user-invocation template renders", () => {
		const path = join(import.meta.dir, "../../node_modules/@oh-my-pi/pi-coding-agent/src/prompts/skills/user-invocation.md");
		const render = (userArgs: string): string =>
			readFileSync(path, "utf8")
				.replace(/\{\{#if userArgs\}\}\n([\s\S]*?)\{\{\/if\}\}\n?/, userArgs === "" ? "" : "$1")
				.replace("{{name}}", "dag")
				.replace("{{body}}", "# DAG\n\nbody")
				.replace("{{baseDir}}", DIR)
				.replace("{{userArgs}}", userArgs)
				.trim();
		expect(parseSkillPrompt(render("run the PRD"))).toEqual({ name: "dag", args: "run the PRD", source: "expanded" });
		expect(parseSkillPrompt(render(""))).toEqual({ name: "dag", args: "", source: "expanded" });
		expect(render("x")).toBe(expanded("dag", "# DAG\n\nbody", "x"));
	});
});

describe("parseSkillPrompt, the raw shape (print mode)", () => {
	test("reads the skill and the args from the leading token", () => {
		expect(parseSkillPrompt("/skill:probe-skill printarg")).toEqual({ name: "probe-skill", args: "printarg", source: "raw" });
		expect(parseSkillPrompt("/skill:deep-interview add a flag to the CLI")).toEqual({ name: "deep-interview", args: "add a flag to the CLI", source: "raw" });
	});
	test("a token with no args, trailing whitespace, a tab or a line break after it", () => {
		expect(parseSkillPrompt("/skill:dag")).toEqual({ name: "dag", args: "", source: "raw" });
		expect(parseSkillPrompt("  /skill:dag  \n")).toEqual({ name: "dag", args: "", source: "raw" });
		expect(parseSkillPrompt("/skill:dag\tgo")?.args).toBe("go");
		expect(parseSkillPrompt("/skill:ralplan\nline one\nline two")?.args).toBe("line one\nline two");
	});
	test("a namespaced name is one token; a deeper path is not a skill", () => {
		expect(parseSkillPrompt("/skill:omp-skills/dag go")).toEqual({ name: "omp-skills/dag", args: "go", source: "raw" });
		expect(parseSkillPrompt("/skill:a/b/c go")).toBeNull();
		expect(parseSkillPrompt("/skill:/x go")).toBeNull();
	});
	test("a token inside a sentence is the skill, and the prose around it is the args", () => {
		expect(parseSkillPrompt("Please follow /skill:probe-skill gamma delta for this request.")).toEqual({
			name: "probe-skill",
			args: "Please follow gamma delta for this request.",
			source: "raw",
		});
		expect(parseSkillPrompt("fix the bug /skill:dag")?.args).toBe("fix the bug");
		expect(parseSkillPrompt("use\n/skill:dag\nplease")?.args).toBe("use please");
	});
	test("the first token of several is the invocation", () => {
		expect(parseSkillPrompt("a /skill:dag b /skill:ralplan c")).toEqual({ name: "dag", args: "a b /skill:ralplan c", source: "raw" });
	});
	test("another slash command owns a token that follows it", () => {
		expect(parseSkillPrompt("/plan then /skill:dag")).toBeNull();
	});
	test("things that look like a token and are not", () => {
		for (const text of ["", "/skill:", "/skill: dag", "//skill:dag", "foo/skill:dag", "/skills:dag", "skill:dag", "the /skill: prefix"]) {
			expect(parseSkillPrompt(text)).toBeNull();
		}
	});
	// omp's token ends at whitespace, so punctuation belongs to the name; such a name is no skill, and no pipeline skill either.
	test("punctuation after a name is part of the name, which then names no pipeline skill", () => {
		const invoked = parseSkillPrompt("/skill:dag, go");
		expect(invoked).toEqual({ name: "dag,", args: "go", source: "raw" });
		expect(isPipelineSkill(invoked?.name, DEFAULT_PIPELINE_SKILLS)).toBe(false);
		expect(parseSkillPrompt("see /skill:dag.")?.name).toBe("dag.");
	});
	test("a plain prompt is not an invocation", () => {
		expect(parseSkillPrompt("Add a --verbose flag to the CLI")).toBeNull();
		expect(parseSkillPrompt("[IMPORTANT: something else]")).toBeNull();
	});
	test("anything but a string is not an invocation", () => {
		for (const prompt of [undefined, null, 3, {}, ["/skill:dag"], { text: "/skill:dag" }]) expect(parseSkillPrompt(prompt)).toBeNull();
	});
});

describe("skillInvocationFromEntry", () => {
	test("reads a user's invocation from the recorded skill-prompt entry", () => {
		const [entry] = scanBranch([skillEntry({ name: "probe-skill", path: `${DIR}/SKILL.md`, args: "alpha beta", prompt: "/skill:probe-skill alpha beta", lineCount: 3 })]);
		expect(skillInvocationFromEntry(entry)).toEqual({ name: "probe-skill", args: "alpha beta", source: "entry" });
	});
	test("an invocation without args has none; the typed prompt stays in the branch view", () => {
		const [entry] = scanBranch([skillEntry({ name: "dag", prompt: "/skill:dag" })]);
		expect(skillInvocationFromEntry(entry)).toEqual({ name: "dag", args: "", source: "entry" });
		expect(entry.skill?.prompt).toBe("/skill:dag");
	});
	test("a subagent's autoloaded skill is not an invocation", () => {
		const [entry] = scanBranch([{ type: "custom_message", customType: "skill-prompt", content: "body", display: false, details: { name: "dag", path: "/x/SKILL.md" } }]);
		expect(entry.skill?.user).toBe(false);
		expect(skillInvocationFromEntry(entry)).toBeNull();
	});
	test("an entry that is not a skill-prompt custom message is not an invocation", () => {
		const entries = scanBranch([
			user("/skill:dag go"),
			{ type: "custom_message", customType: "plan-mode-context", content: "x", details: { name: "dag" } },
			{ type: "custom", customType: "skill-prompt", details: { name: "dag", args: "go" } },
			skillEntry({ args: "no name" }),
		]);
		expect(entries.map(skillInvocationFromEntry)).toEqual([null, null, null, null]);
	});
});

describe("latestUserTurnSkill", () => {
	const invoke = (name: string, args: string): Raw => skillEntry({ name, args, prompt: `/skill:${name} ${args}` });

	test("the skill the latest user turn invoked, whatever the agent did after it", () => {
		const entries = scanBranch([user("earlier"), invoke("deep-interview", "add a flag"), assistant("Which flag?"), assistant("...")]);
		expect(latestUserTurnSkill(entries)).toEqual({ name: "deep-interview", args: "add a flag", source: "entry" });
	});
	test("null once a plain user message follows the invocation (an answer to the interview, say)", () => {
		expect(latestUserTurnSkill(scanBranch([invoke("deep-interview", "x"), assistant("Which?"), user("the --verbose one")]))).toBeNull();
	});
	test("the latest invocation wins over an earlier one and over earlier plain messages", () => {
		const entries = scanBranch([user("hi"), invoke("dag", "run"), user("go on"), invoke("ralplan", "plan it")]);
		expect(latestUserTurnSkill(entries)?.name).toBe("ralplan");
	});
	test("a blank user message is not a turn; an invocation with nothing typed still is", () => {
		expect(latestUserTurnSkill(scanBranch([invoke("dag", "run"), user("  ")]))?.name).toBe("dag");
		expect(latestUserTurnSkill(scanBranch([user("old"), skillEntry({ name: "dag" })]))?.name).toBe("dag");
	});
	test("a subagent's autoload after the invocation does not hide it, nor count as a turn on its own", () => {
		const autoload: Raw = { type: "custom_message", customType: "skill-prompt", content: "b", display: false, details: { name: "other" } };
		expect(latestUserTurnSkill(scanBranch([invoke("dag", "run"), autoload]))?.name).toBe("dag");
		expect(latestUserTurnSkill(scanBranch([user("plain"), autoload]))).toBeNull();
	});
	test("null with no user turn at all", () => {
		expect(latestUserTurnSkill([])).toBeNull();
		expect(latestUserTurnSkill(scanBranch([assistant("only me")]))).toBeNull();
	});
});

describe("isPipelineSkill", () => {
	test("the default list is the three pipeline skills of the omp-skills pack", () => {
		expect([...DEFAULT_PIPELINE_SKILLS]).toEqual(["deep-interview", "ralplan", "dag"]);
		for (const name of DEFAULT_PIPELINE_SKILLS) expect(isPipelineSkill(name, DEFAULT_PIPELINE_SKILLS)).toBe(true);
	});
	test("other skills are not pipeline skills", () => {
		for (const name of ["verify", "plan", "dag-extra", "deep", "interview"]) expect(isPipelineSkill(name, DEFAULT_PIPELINE_SKILLS)).toBe(false);
	});
	test("a namespaced name matches by its last segment or in full", () => {
		expect(isPipelineSkill("omp-skills/dag", ["dag"])).toBe(true);
		expect(isPipelineSkill("omp-skills/dag", ["omp-skills/dag"])).toBe(true);
		expect(isPipelineSkill("dag", ["omp-skills/dag"])).toBe(false);
		expect(isPipelineSkill("omp-skills/verify", ["dag"])).toBe(false);
	});
	test("matches the list given, not the defaults, and case matters", () => {
		expect(isPipelineSkill("verify", ["verify"])).toBe(true);
		expect(isPipelineSkill("dag", [])).toBe(false);
		expect(isPipelineSkill("DAG", ["dag"])).toBe(false);
	});
	test("no name, an empty one or one that ends in a slash is not a pipeline skill", () => {
		for (const name of [null, undefined, "", "omp-skills/"]) expect(isPipelineSkill(name, ["dag", ""])).toBe(false);
	});
});

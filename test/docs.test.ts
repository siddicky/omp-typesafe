import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, mergeConfig, subagentGuardEnabled } from "../src/config";
import { MAX_PROPOSE_BLOCKS } from "../src/ambiguity";
import { SUSPECT_SCAN_BUDGET_MS } from "../src/evidence";
import { TOTAL_CAP } from "../src/priorities";
import { isSubagentCtx } from "../src/subagent";
import { MASK_GROWTH_LIMIT, MASK_HEADROOM } from "../src/text";
import { HISTORY_CAP, MAX_CALLS_PER_PROMPT, MAX_MESSAGE_REVIEWS_PER_PROMPT, NOTE_DEDUPE_TTL_TURNS } from "../src/reviewer";
import { LIMITS } from "./limits";

/**
 * The README documents defaults and environment variables by hand, and CI is what runs the checks; these tests
 * fail when either stops matching the code, so a changed default or a dropped CI step cannot go unnoticed.
 */

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const readme = read("README.md");

/** Bodies of the fenced ```json blocks that follow `heading`, up to the next heading of the same or higher level. */
function jsonBlocksAfter(markdown: string, heading: string): unknown[] {
	const start = markdown.indexOf(`\n${heading}\n`);
	expect(start).toBeGreaterThanOrEqual(0);
	const level = heading.match(/^#+/)![0].length;
	const rest = markdown.slice(start + heading.length + 2);
	const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
	const section = next === -1 ? rest : rest.slice(0, next);
	return [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => {
		const body = m[1].trim();
		// A fragment such as `"ambiguityGate": { ... }` is wrapped so it parses.
		return JSON.parse(body.startsWith("{") ? body : `{${body}}`);
	});
}

describe("README defaults match the code", () => {
	test("the configuration example is the default config", () => {
		const [example] = jsonBlocksAfter(readme, "## Configuration");
		expect(example).toEqual(DEFAULT_CONFIG);
	});

	test("the ambiguity gate example is the default gate config", () => {
		const [example] = jsonBlocksAfter(readme, "## Ambiguity gate (plan mode)");
		expect(example).toEqual({ ambiguityGate: DEFAULT_CONFIG.ambiguityGate });
	});

	test("every environment variable the source reads is in the README's environment table", () => {
		const names = new Set<string>();
		for (const file of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"))) {
			for (const match of read(join("src", file)).matchAll(/\b(TYPESAFE_[A-Z_]+|PI_CODING_AGENT_DIR)\b/g)) names.add(match[1]);
		}
		expect(names.size).toBeGreaterThan(5);
		const table = readme.slice(readme.indexOf("### Environment"), readme.indexOf("### Review priorities"));
		const missing = [...names].filter((name) => !table.includes(`| \`${name}\` |`));
		expect(missing).toEqual([]);
	});

	// The omp host package (about 1 GB with its dependencies) is a devDependency for the typecheck only.
	test("installing from a clone skips the dev dependencies; developing does not", () => {
		const install = readme.slice(readme.indexOf("## Install"), readme.indexOf("## What it watches"));
		expect(install).toContain("bun install --production");
		expect(install).not.toMatch(/^bun install$/m);
		const development = readme.slice(readme.indexOf("## Development"));
		expect(development).toMatch(/^bun install /m);
		expect(development).not.toContain("--production");
	});

	test("the default tool list and per-key bounds the README states are the ones config.ts enforces", () => {
		for (const tool of DEFAULT_CONFIG.adversary.tools) expect(readme).toContain(`"${tool}"`);
		// The bounds are read off the code: a value far outside the range comes back at the edge it is clamped to.
		const bounds = (key: "concern_severity" | "blocker_severity" | "steerMinConfidence"): [number, number] => {
			const at = (value: number) => mergeConfig(DEFAULT_CONFIG, { adversary: { [key]: value } }).adversary[key];
			return [at(-1e9), at(1e9)];
		};
		const flat = readme.replace(/\s+/g, " ");
		for (const key of ["concern_severity", "blocker_severity"] as const) expect(bounds(key)).toEqual([0, 3]);
		expect(flat).toContain("| `adversary.concern_severity`, `blocker_severity` | Severity score cut-offs (0 to 3).");
		expect(bounds("steerMinConfidence")).toEqual([0, 1]);
		expect(flat).toContain("goes out quietly instead (0 to 1; see [Delivery]");
	});
});

/** A hook context whose `ctx.agent` is `agent`, defined the way omp defines it (not enumerable). */
function agentCtx(agent: object): Parameters<typeof isSubagentCtx>[0] {
	const ctx = {};
	Object.defineProperty(ctx, "agent", { value: agent, enumerable: false });
	return ctx as Parameters<typeof isSubagentCtx>[0];
}

/** The cells of one row of a markdown table, keyed by the text of its first column. */
function tableRow(markdown: string, first: string): string {
	const line = markdown.split("\n").find((l) => l.startsWith(`| ${first} |`));
	expect(line, `a table row starting with ${first}`).toBeDefined();
	return line!;
}

// The caps are tested in the code's own tests against ./limits (they feed oversize input and measure what is sent);
// these tests hold the README to the same list.
describe("README limits match the ones the code is tested against", () => {
	test("what leaves the machine: every cap in the table", () => {
		const action = tableRow(readme, "Action review");
		expect(action).toContain(`last user message, ${LIMITS.task} chars`);
		expect(action).toContain(`tool name and input (${LIMITS.toolInput})`);
		expect(action).toContain(`tool result (${LIMITS.toolResult})`);
		expect(action).toContain(`last claim (${LIMITS.claimedIntent})`);
		expect(action).toContain(`previous ${LIMITS.priorActions} tool results`);
		const message = tableRow(readme, "Message review");
		expect(message).toContain(`assistant message (${LIMITS.assistantMessage})`);
		expect(message).toContain(`last ${LIMITS.recentActions} actions`);
		expect(tableRow(readme, "Turn review")).toContain(`since the last review (${LIMITS.turnDelta}:`);
		const evidence = tableRow(readme, "Evidence");
		expect(evidence).toContain(`\`git status\` (${LIMITS.gitStatus})`);
		expect(evidence).toContain(`\`--stat\` (${LIMITS.diffStat})`);
		expect(evidence).toContain(`up to ${LIMITS.fileDiffs} file diffs (${LIMITS.fileDiffChars} each)`);
		expect(evidence).toContain(`up to ${LIMITS.removedNames} removed names`);
		expect(evidence).toContain(`(${LIMITS.grepHitsPerName} per name, ${LIMITS.grepHitChars} chars each`);
		const gate = tableRow(readme, "Ambiguity gate");
		expect(gate).toContain(`first prompt (${LIMITS.planPrompt})`);
		expect(gate).toContain(`plan text so far (${LIMITS.planSoFar},`);
		expect(gate).toContain(`up to ${LIMITS.userReplies}, ${LIMITS.replyChars} chars each`);
		expect(tableRow(readme, "Stop gate")).toContain(`final assistant message (${LIMITS.stopGateMessage})`);
	});

	test("the per-prompt budgets, the dedupe window, the history bound and the evidence deadlines", () => {
		expect(MAX_CALLS_PER_PROMPT).toBe(LIMITS.callsPerPrompt);
		expect(MAX_MESSAGE_REVIEWS_PER_PROMPT).toBe(LIMITS.messageReviewsPerPrompt);
		expect(NOTE_DEDUPE_TTL_TURNS).toBe(LIMITS.dedupeTurns);
		expect(HISTORY_CAP).toBe(LIMITS.historyRecords);
		expect(tableRow(readme, "Per-prompt budgets")).toContain(`At most ${LIMITS.callsPerPrompt} Jev calls`);
		expect(tableRow(readme, "Per-prompt budgets")).toContain(`${LIMITS.messageReviewsPerPrompt} message reviews`);
		expect(tableRow(readme, "Semantic dedupe")).toContain(`after ${LIMITS.dedupeTurns} model turns`);
		expect(readme).toContain(`\`history\` holds up to ${LIMITS.historyRecords} review records`);
		expect(readme).toContain(`Each command gets ${LIMITS.evidencePerCommandMs / 1000} s and the whole collection ${LIMITS.evidenceTotalMs / 1000} s`);
		expect(readme).toContain(`The stop gate allows ${LIMITS.stopGateTimeoutMs / 1000} s`);
	});
});

// The numbers the README states in prose: tested from the code's side against LIMITS in index.test.ts, client.test.ts
// and text.test.ts, and from the README's side here, so a changed time limit or threshold cannot leave its text behind.
describe("README prose matches the limits, time limits and defaults the code is tested against", () => {
	/** The README with line breaks and indentation folded, so a sentence is found whatever way it is wrapped. */
	const flat = readme.replace(/\s+/g, " ");
	const seconds = (ms: number): string => `${ms / 1000}`;
	const words = (n: number): string => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"][n] ?? String(n);
	const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${words(n)} times`);

	test("the priorities cap", () => {
		expect(TOTAL_CAP).toBe(LIMITS.priorities);
		expect(tableRow(readme, "Action review")).toContain(`your priorities file text (${LIMITS.priorities})`);
	});

	test("the gate's deadline stays under omp's fail-closed timeout, as the README says", () => {
		expect(LIMITS.gateDeadlineMs).toBeLessThan(LIMITS.ompToolCallTimeoutMs);
		expect(flat).toContain(`\`min(${seconds(LIMITS.gateDeadlineMs)} s, timeoutMs + ${seconds(LIMITS.gateSlackMs)} s)\``);
		expect(flat).toContain(`(${seconds(LIMITS.ompToolCallTimeoutMs)} s by default, \`extensionHandlers.toolCallTimeoutMs\`)`);
	});

	test("typesafe_ask and /typesafe test: attempts, retries and the worst case", () => {
		const worstCase = LIMITS.askAttemptMs * (LIMITS.askRetries + 1) + LIMITS.askRetries * LIMITS.retryAfterMs;
		expect(flat).toContain(`${seconds(LIMITS.askAttemptMs)} s per attempt and up to ${words(LIMITS.askRetries)} retries (about ${seconds(worstCase)} s in the worst case`);
		expect(flat).toContain(`\`typesafe_ask\` ${seconds(LIMITS.askAttemptMs)} s per attempt with ${words(LIMITS.askRetries)} retries (about ${seconds(worstCase)} s in all`);
		expect(flat).toContain(`one try plus ${words(LIMITS.probeRetries)} retry (${seconds(LIMITS.probeAttemptMs)} s per attempt) and gives up after ${seconds(LIMITS.probeBudgetMs)} s in all`);
		expect(flat).toContain(`\`/typesafe test\` ${seconds(LIMITS.probeAttemptMs)} s per attempt with ${words(LIMITS.probeRetries)} retry, capped at ${seconds(LIMITS.probeBudgetMs)} s`);
		expect(flat).toContain(`A 429 whose \`Retry-After\` is longer than ${seconds(LIMITS.retryAfterMs)} s fails at once`);
	});

	test("the shapes of a typesafe_ask question", () => {
		expect(flat).toContain(`a choice needs ${LIMITS.choiceOptionsMin} to ${LIMITS.choiceOptionsMax} options and a score ${LIMITS.scoreLevelsMin} to ${LIMITS.scoreLevelsMax} levels`);
	});

	test("how far a masked window grows, and how long the removed-name scan runs", () => {
		// The code's own tests hold these two to their behaviour (text.test.ts, evidence.test.ts); here the constants and the README.
		expect(MASK_GROWTH_LIMIT).toBe(LIMITS.maskGrowthLimit);
		expect(MASK_HEADROOM).toBe(LIMITS.maskHeadroom);
		expect(SUSPECT_SCAN_BUDGET_MS).toBe(LIMITS.suspectScanBudgetMs);
		expect(flat).toContain(`grown while masking shrinks it, up to ${words(LIMITS.maskGrowthLimit)} times that`);
		expect(flat).toContain(`stops after ${LIMITS.suspectScanBudgetMs} ms`);
	});

	test("the redaction thresholds", () => {
		expect(flat).toContain(`a string of ${LIMITS.secretStringMin} or more characters, or a number of ${LIMITS.secretNumberMin} or more digits`);
		expect(flat).toContain(`looking at a window ${words(LIMITS.maskHeadroom)} times the cap`);
		expect(flat).toContain(`if it has ${LIMITS.secretStringMin} or more characters, sits on one line`);
		expect(flat).toContain(`an unquoted value is masked when it has ${LIMITS.unquotedSecretMin} or more characters and a digit or symbol`);
	});

	test("the plan text, the priorities budget, and how often the stop gate and the propose block act", () => {
		expect(flat).toContain(`The newest ${LIMITS.planSoFar} characters are kept`);
		expect(flat).toContain(`They share a ${LIMITS.priorities}-character budget`);
		expect(MAX_PROPOSE_BLOCKS).toBe(LIMITS.proposeBlocksPerPlan);
		expect(tableRow(readme, "`tool_call` for `write` to `xd://propose`")).toContain(`At most ${times(LIMITS.proposeBlocksPerPlan)} per plan`);
		expect(flat).toContain(`It runs at most ${times(LIMITS.stopGateRunsPerPrompt)} per prompt`);
	});

	test("the defaults the prose repeats are the code's defaults", () => {
		const { adversary, ambiguityGate } = DEFAULT_CONFIG;
		expect(flat).toContain(`at least \`minMessageChars\`, ${adversary.minMessageChars} by default`);
		expect(flat).toContain(`\`adversary.steerMinConfidence\` (default ${adversary.steerMinConfidence})`);
		const w = ambiguityGate.weights;
		expect(flat).toContain(`ambiguity = 1 - (goal*${w.goal} + constraints*${w.constraints} + criteria*${w.criteria} + context*${w.context})`);
		const threshold = ambiguityGate.threshold.toFixed(2);
		expect(flat).toContain(`threshold="${threshold}"`);
		expect(flat).toContain(`the ${threshold} threshold`);
	});
});

describe("README documents the subagent guard", () => {
	const start = readme.indexOf("\n## Subagents\n");
	const rest = readme.slice(start + 1);
	const section = rest.slice(0, rest.indexOf("\n## ", 1));
	const flat = section.replace(/\s+/g, " ");

	test("there is a Subagents section that says why, how a subagent is told, and what shows it", () => {
		expect(start).toBeGreaterThanOrEqual(0);
		expect(flat).toContain("`ctx.agent`");
		expect(flat).toContain("`kind: \"sub\"`");
		expect(flat).toContain("`parentSession`");
		expect(flat).toContain("`/adversary status` has a `subagent guard` line");
		expect(tableRow(readme, "`TYPESAFE_BENCH_LOG`")).toContain("`subagentSessionsSkipped`");
		expect(flat).toContain("`subagentSessionsSkipped`");
		for (const kept of ["`typesafe_ask`", "`/adversary`", "`/typesafe`"]) expect(flat).toContain(kept);
	});

	test("what it says about isolated agents, depth and resets is what the code does", () => {
		// The counters sit on globalThis, so a fresh module copy counts into the parent's stats (subagent.test.ts).
		expect(flat).toContain("the counters below live on `globalThis`, so its skips are counted in the parent's");
		// A depth above 0 is a subagent whatever `kind` says; `kind: "main"` decides only when it is the sole signal.
		expect(isSubagentCtx(agentCtx({ kind: "main", depth: 1 }))).toBe(true);
		expect(isSubagentCtx(agentCtx({ kind: "main", depth: 0 }))).toBe(false);
		expect(flat).toContain("above 0 (which wins over `kind: \"main\"`)");
		// The counts start over with the main session, plan approval (a session_switch) included.
		expect(flat).toContain("plan approval, which omp delivers as a session switch");
		expect(tableRow(readme, "`TYPESAFE_BENCH_LOG`")).toContain("since the main session last started or switched");
	});

	test("the kill switch it names, and the words it lists, are the ones the code honours", () => {
		const row = tableRow(readme, "`TYPESAFE_SUBAGENT_GUARD`");
		for (const word of ["0", "false", "off", "no"]) {
			expect(subagentGuardEnabled({ TYPESAFE_SUBAGENT_GUARD: word })).toBe(false);
			expect(row).toContain(`\`${word}\``);
		}
		expect(flat).toContain("`TYPESAFE_SUBAGENT_GUARD=0` (also `false`, `off`, `no`)");
		expect(subagentGuardEnabled({})).toBe(true);
		expect(row).toContain("Default on");
	});

	test("every source module is in the README's layout", () => {
		const layout = readme.slice(readme.indexOf("## Layout"));
		for (const file of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"))) expect(layout, `src/${file}`).toContain(`src/${file} `);
	});
});

// index.test.ts holds the code to these wordings ("a tool batch the user stopped"); this holds the README to them.
describe("README documents which tool results count as a stop", () => {
	const flat = readme.replace(/\s+/g, " ");

	test("every wording of an aborted tool, and omp's own marks of a stopped command", () => {
		for (const text of ["Operation aborted", "Tool call aborted", "Command aborted", "Ask tool was cancelled by the user", "Ask input was cancelled", "Browser open aborted", "Browser tab open aborted"]) {
			expect(flat, text).toContain(`\`${text}\``);
		}
		expect(flat).toContain("output that starts with `[Command cancelled]` or ends with `[Command aborted]` is a stop, whatever else it says");
	});

	test("what it cannot do about a stop", () => {
		expect(flat).toContain("a review that is already in flight when you press Esc still finishes and may deliver its note");
		expect(flat).toContain("**Aborted work is not reviewed (best effort).**");
	});
});

describe("package scripts and CI", () => {
	const pkg = JSON.parse(read("package.json")) as {
		scripts?: Record<string, string>;
		engines?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const workflow = read(".github/workflows/ci.yml");

	test("package.json has the test and typecheck scripts the README names", () => {
		expect(pkg.scripts?.test).toBe("bun test");
		expect(pkg.scripts?.typecheck).toBe("tsc --noEmit");
		expect(readme).toContain("bun test");
		expect(readme).toContain("bun run typecheck");
		expect(Object.keys(pkg.devDependencies ?? {})).toEqual(expect.arrayContaining(["typescript", "@types/bun"]));
		expect(pkg.engines?.bun).toBeTruthy();
	});

	// test/host-compat.ts compares src/host.ts with the host's declarations; an unpinned range would let the check
	// move under a green build, and a missing dependency would leave it checking nothing.
	test("the omp host types are a pinned devDependency that the typecheck compares src/host.ts against", () => {
		expect(pkg.devDependencies?.["@oh-my-pi/pi-coding-agent"]).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.dependencies?.["@oh-my-pi/pi-coding-agent"]).toBeUndefined();
		const compat = read("test/host-compat.ts");
		expect(compat).toContain('from "@oh-my-pi/pi-coding-agent"');
		expect(compat).toContain('from "../src/host"');
		expect(JSON.parse(read("tsconfig.json")).include).toContain("test/**/*.ts");
	});

	test("CI installs from the lockfile, type-checks and tests with Bun", () => {
		expect(workflow).toContain("oven-sh/setup-bun@v2");
		const steps = [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1]);
		expect(steps).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun test"]);
	});

	// The pinned omp types only catch drift when someone bumps the pin; the weekly run looks at the latest release.
	test("a scheduled workflow type-checks and tests against the latest omp release", () => {
		const drift = read(".github/workflows/omp-drift.yml");
		expect(drift).toMatch(/^on:\n\s+schedule:/m);
		const steps = [...drift.matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1]);
		expect(steps).toEqual(["bun install --frozen-lockfile", "bun add --dev --exact @oh-my-pi/pi-coding-agent@latest", "bun run typecheck", "bun test"]);
		expect(readme).toContain("omp-drift");
	});

	// `bun add --dev pkg@latest` writes `^x.y.z`, which the pin test above rejects: the weekly `bun test` step would be red
	// every week, and a real drift failure could not be told from it. `--exact` is what keeps the pin exact.
	test("the drift run's bun add pins exactly, so the pin test it then runs still holds", () => {
		const drift = read(".github/workflows/omp-drift.yml");
		const add = [...drift.matchAll(/^\s+- run: (bun add .+)$/gm)].map((m) => m[1]);
		expect(add).toHaveLength(1);
		expect(add[0]).toMatch(/\s--exact(\s|$)/);
		expect(add[0]).toContain("@oh-my-pi/pi-coding-agent@latest");
	});

	// An unfiltered `push` plus `pull_request` runs the whole job twice for every push to a pull request's branch.
	test("CI runs on pull requests, and on pushes only to main", () => {
		expect(workflow).toMatch(/^on:\n\s+push:\n\s+branches: \[main\]\n\s+pull_request:/m);
	});
});

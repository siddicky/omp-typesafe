import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentDir,
	applyEnvOverrides,
	configPath,
	DEFAULT_CONFIG,
	defaultConfig,
	getConfig,
	getConfigWarnings,
	loadConfig,
	mergeConfig,
	resolveConfigPath,
	subagentGuardEnabled,
} from "../src/config";
import type { TypesafeConfig } from "../src/config";

/**
 * config.ts unit tests: role/phases parsing in mergeConfig, env override precedence in
 * applyEnvOverrides, config path selection, merge-time validation, and loadConfig against
 * throwaway files under the OS temp dir (selected through TYPESAFE_CONFIG). No network access.
 */

describe("mergeConfig — role and phases", () => {
	test("parses a valid role and phases from the override object", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { role: "advisory", phases: ["plan"] });
		expect(cfg.role).toBe("advisory");
		expect(cfg.phases).toEqual(["plan"]);
	});

	test("falls back to base role on an invalid value", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { role: "bogus" });
		expect(cfg.role).toBe(DEFAULT_CONFIG.role);
	});

	test("falls back to base phases when phases is not an array", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { phases: "plan" });
		expect(cfg.phases).toEqual(DEFAULT_CONFIG.phases);
	});

	test("falls back to base phases when the array has no valid entries", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { phases: ["bogus", 42, null] });
		expect(cfg.phases).toEqual(DEFAULT_CONFIG.phases);
	});

	test("dedupes valid phase entries", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { phases: ["plan", "plan", "execute"] });
		expect(cfg.phases).toEqual(["plan", "execute"]);
	});

	test("default config has role adversarial and both phases", () => {
		expect(DEFAULT_CONFIG.role).toBe("adversarial");
		expect(DEFAULT_CONFIG.phases).toEqual(["plan", "execute"]);
	});
});

describe("applyEnvOverrides", () => {
	function baseCfg(overrides: Partial<TypesafeConfig> = {}): TypesafeConfig {
		return { ...DEFAULT_CONFIG, ...overrides, adversary: { ...DEFAULT_CONFIG.adversary, ...overrides.adversary } };
	}

	test("TYPESAFE_ROLE=advisory flips role", () => {
		const out = applyEnvOverrides(baseCfg(), { TYPESAFE_ROLE: "advisory" });
		expect(out.role).toBe("advisory");
	});

	test("TYPESAFE_ROLE=adversarial flips role back", () => {
		const out = applyEnvOverrides(baseCfg({ role: "advisory" }), { TYPESAFE_ROLE: "adversarial" });
		expect(out.role).toBe("adversarial");
	});

	test("an unrecognized TYPESAFE_ROLE value is a no-op", () => {
		const out = applyEnvOverrides(baseCfg(), { TYPESAFE_ROLE: "bogus" });
		expect(out.role).toBe(DEFAULT_CONFIG.role);
	});

	test.each(["0", "false", "FALSE", "False"])("TYPESAFE_REVIEW_ENABLED=%s disables review", (value) => {
		const cfg = baseCfg({ adversary: { ...DEFAULT_CONFIG.adversary, enabled: true } });
		const out = applyEnvOverrides(cfg, { TYPESAFE_REVIEW_ENABLED: value });
		expect(out.adversary.enabled).toBe(false);
	});

	test.each(["1", "true", "TRUE", "True"])("TYPESAFE_REVIEW_ENABLED=%s enables review", (value) => {
		const cfg = baseCfg({ adversary: { ...DEFAULT_CONFIG.adversary, enabled: false } });
		const out = applyEnvOverrides(cfg, { TYPESAFE_REVIEW_ENABLED: value });
		expect(out.adversary.enabled).toBe(true);
	});

	test("an unrecognized TYPESAFE_REVIEW_ENABLED value is a no-op", () => {
		const cfg = baseCfg({ adversary: { ...DEFAULT_CONFIG.adversary, enabled: true } });
		const out = applyEnvOverrides(cfg, { TYPESAFE_REVIEW_ENABLED: "maybe" });
		expect(out.adversary.enabled).toBe(true);
	});

	test("env wins over a file-derived value: file says enabled, env disables", () => {
		const fromFile = mergeConfig(DEFAULT_CONFIG, { adversary: { enabled: true } });
		expect(fromFile.adversary.enabled).toBe(true);
		const out = applyEnvOverrides(fromFile, { TYPESAFE_REVIEW_ENABLED: "0" });
		expect(out.adversary.enabled).toBe(false);
	});

	test("no relevant env vars leaves the config untouched", () => {
		const cfg = baseCfg();
		const out = applyEnvOverrides(cfg, {});
		expect(out).toEqual(cfg);
	});

	test("TYPESAFE_SUBAGENT_GUARD changes no config value, and only a value it cannot read is warned about", () => {
		const cfg = baseCfg();
		for (const value of ["0", "false", "1", "true", "  ", undefined]) {
			const warnings: string[] = [];
			expect(applyEnvOverrides(cfg, { TYPESAFE_SUBAGENT_GUARD: value }, (m) => warnings.push(m))).toEqual(cfg);
			expect(warnings).toEqual([]);
		}
		const warnings: string[] = [];
		expect(applyEnvOverrides(cfg, { TYPESAFE_SUBAGENT_GUARD: "disable" }, (m) => warnings.push(m))).toEqual(cfg);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("TYPESAFE_SUBAGENT_GUARD");
		expect(warnings[0]).toContain("ignored");
	});
});

describe("subagentGuardEnabled", () => {
	test("is on by default, and with a blank value", () => {
		expect(subagentGuardEnabled({})).toBe(true);
		expect(subagentGuardEnabled({ TYPESAFE_SUBAGENT_GUARD: "" })).toBe(true);
		expect(subagentGuardEnabled({ TYPESAFE_SUBAGENT_GUARD: "   " })).toBe(true);
	});

	test.each(["0", "false", "FALSE", " off ", "no"])("TYPESAFE_SUBAGENT_GUARD=%s switches it off", (value) => {
		expect(subagentGuardEnabled({ TYPESAFE_SUBAGENT_GUARD: value })).toBe(false);
	});

	test.each(["1", "true", "On", "yes"])("TYPESAFE_SUBAGENT_GUARD=%s keeps it on", (value) => {
		expect(subagentGuardEnabled({ TYPESAFE_SUBAGENT_GUARD: value })).toBe(true);
	});

	test("a value it cannot read leaves it on: the safe side is dormant in subagents", () => {
		expect(subagentGuardEnabled({ TYPESAFE_SUBAGENT_GUARD: "disable" })).toBe(true);
	});

	test("reads process.env by default, live", () => {
		const saved = process.env.TYPESAFE_SUBAGENT_GUARD;
		try {
			process.env.TYPESAFE_SUBAGENT_GUARD = "0";
			expect(subagentGuardEnabled()).toBe(false);
			process.env.TYPESAFE_SUBAGENT_GUARD = "1";
			expect(subagentGuardEnabled()).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.TYPESAFE_SUBAGENT_GUARD;
			else process.env.TYPESAFE_SUBAGENT_GUARD = saved;
		}
	});
});

describe("resolveConfigPath", () => {
	test("uses TYPESAFE_CONFIG when set", () => {
		expect(resolveConfigPath({ TYPESAFE_CONFIG: "/tmp/alt-typesafe.json" })).toBe("/tmp/alt-typesafe.json");
	});

	test("ignores a blank TYPESAFE_CONFIG and falls back to the default path", () => {
		const path = resolveConfigPath({ TYPESAFE_CONFIG: "   " });
		expect(path.endsWith("typesafe.json")).toBe(true);
		expect(path).not.toBe("   ");
	});

	test("falls back to the default path when unset", () => {
		const path = resolveConfigPath({});
		expect(path).toContain(".omp");
		expect(path.endsWith("typesafe.json")).toBe(true);
	});

	test("follows PI_CODING_AGENT_DIR so omp profiles get their own typesafe.json", () => {
		expect(resolveConfigPath({ PI_CODING_AGENT_DIR: "/home/u/.omp/profiles/work/agent" })).toBe(
			"/home/u/.omp/profiles/work/agent/typesafe.json",
		);
		expect(configPath({ PI_CODING_AGENT_DIR: "/p/agent" })).toBe("/p/agent/typesafe.json");
	});

	test("TYPESAFE_CONFIG still wins over PI_CODING_AGENT_DIR", () => {
		expect(resolveConfigPath({ TYPESAFE_CONFIG: "/x/t.json", PI_CODING_AGENT_DIR: "/p/agent" })).toBe("/x/t.json");
	});
});

describe("agentDir", () => {
	test("defaults to ~/.omp/agent", () => {
		expect(agentDir({})).toBe(join(homedir(), ".omp", "agent"));
		expect(agentDir({ PI_CODING_AGENT_DIR: "   " })).toBe(join(homedir(), ".omp", "agent"));
	});

	test("uses a trimmed PI_CODING_AGENT_DIR", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: " /p/agent " })).toBe("/p/agent");
	});

	test("expands a leading ~", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "~/profiles/work" })).toBe(join(homedir(), "profiles", "work"));
		expect(agentDir({ PI_CODING_AGENT_DIR: "~" })).toBe(homedir());
	});
});

describe("applyEnvOverrides — normalization and warnings", () => {
	function collect(): { warnings: string[]; warn: (m: string) => void } {
		const warnings: string[] = [];
		return { warnings, warn: (m) => warnings.push(m) };
	}

	test.each(["Advisory", " advisory ", "ADVISORY"])("TYPESAFE_ROLE=%j is accepted", (value) => {
		const { warnings, warn } = collect();
		const out = applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_ROLE: value }, warn);
		expect(out.role).toBe("advisory");
		expect(warnings).toEqual([]);
	});

	test("an unknown TYPESAFE_ROLE warns and is ignored", () => {
		const { warnings, warn } = collect();
		const out = applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_ROLE: "watchdog" }, warn);
		expect(out.role).toBe(DEFAULT_CONFIG.role);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("TYPESAFE_ROLE");
	});

	test.each(["off", "OFF", "no", " No "])("TYPESAFE_REVIEW_ENABLED=%j disables review", (value) => {
		const out = applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_REVIEW_ENABLED: value });
		expect(out.adversary.enabled).toBe(false);
	});

	test.each(["on", "ON", "yes", "Yes"])("TYPESAFE_REVIEW_ENABLED=%j enables review", (value) => {
		const off = { ...DEFAULT_CONFIG, adversary: { ...DEFAULT_CONFIG.adversary, enabled: false } };
		const out = applyEnvOverrides(off, { TYPESAFE_REVIEW_ENABLED: value });
		expect(out.adversary.enabled).toBe(true);
	});

	test("on/off/yes/no also work for TYPESAFE_AMBIGUITY_GATE", () => {
		expect(applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_AMBIGUITY_GATE: "off" }).ambiguityGate.enabled).toBe(false);
		const off = { ...DEFAULT_CONFIG, ambiguityGate: { ...DEFAULT_CONFIG.ambiguityGate, enabled: false } };
		expect(applyEnvOverrides(off, { TYPESAFE_AMBIGUITY_GATE: "yes" }).ambiguityGate.enabled).toBe(true);
	});

	test("an unrecognized boolean warns instead of being dropped silently", () => {
		const { warnings, warn } = collect();
		const out = applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_REVIEW_ENABLED: "maybe", TYPESAFE_AMBIGUITY_GATE: "2" }, warn);
		expect(out.adversary.enabled).toBe(DEFAULT_CONFIG.adversary.enabled);
		expect(out.ambiguityGate.enabled).toBe(DEFAULT_CONFIG.ambiguityGate.enabled);
		expect(warnings).toHaveLength(2);
	});

	test("blank values are silently absent", () => {
		const { warnings, warn } = collect();
		const out = applyEnvOverrides(
			DEFAULT_CONFIG,
			{ TYPESAFE_ROLE: "  ", TYPESAFE_REVIEW_ENABLED: "", TYPESAFE_AMBIGUITY_GATE: " ", TYPESAFE_AMBIGUITY_THRESHOLD: "" },
			warn,
		);
		expect(out).toEqual(DEFAULT_CONFIG);
		expect(warnings).toEqual([]);
	});

	test.each([
		["0.3", 0.3],
		[" 0.3 ", 0.3],
		["0", 0],
		["1", 1],
	])("TYPESAFE_AMBIGUITY_THRESHOLD=%j is accepted as %d", (value, expected) => {
		const out = applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_AMBIGUITY_THRESHOLD: value });
		expect(out.ambiguityGate.threshold).toBe(expected);
	});

	test.each(["0.3oops", "abc", "1.5", "-0.1", "Infinity", "0.3 0.4"])("TYPESAFE_AMBIGUITY_THRESHOLD=%j warns and is ignored", (value) => {
		const { warnings, warn } = collect();
		const out = applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_AMBIGUITY_THRESHOLD: value }, warn);
		expect(out.ambiguityGate.threshold).toBe(DEFAULT_CONFIG.ambiguityGate.threshold);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("TYPESAFE_AMBIGUITY_THRESHOLD");
	});
});

describe("mergeConfig — severity thresholds", () => {
	// README: "Severity score cut-offs (0 to 3)". The scores Jev's severity question can give are 0 to 3.
	test("each cut-off is clamped to 0..3, and a value that is not a number falls back to the default", () => {
		const read = (adversary: Record<string, unknown>) => {
			const out = mergeConfig(DEFAULT_CONFIG, { adversary }).adversary;
			return [out.concern_severity, out.blocker_severity];
		};
		expect(read({ concern_severity: -1, blocker_severity: -0.5 })).toEqual([0, 0]);
		expect(read({ concern_severity: 3.5, blocker_severity: 99 })).toEqual([3, 3]);
		expect(read({ concern_severity: 0, blocker_severity: 3 })).toEqual([0, 3]);
		expect(read({ concern_severity: 3.5 })).toEqual([3, 3]);
		expect(read({ blocker_severity: -1 })).toEqual([0, 0]);
		expect(read({ concern_severity: "2", blocker_severity: null })).toEqual([DEFAULT_CONFIG.adversary.concern_severity, DEFAULT_CONFIG.adversary.blocker_severity]);
	});

	test("inverted thresholds are swapped with a warning", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { concern_severity: 2.8, blocker_severity: 2.0 } }, (m) => warnings.push(m));
		expect(cfg.adversary.concern_severity).toBe(2.0);
		expect(cfg.adversary.blocker_severity).toBe(2.8);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("swapped");
	});

	test("a lone blocker_severity below the default concern pulls the concern down to it", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { blocker_severity: 1.0 } }, (m) => warnings.push(m));
		expect(cfg.adversary.blocker_severity).toBe(1.0);
		expect(cfg.adversary.concern_severity).toBe(1.0);
		expect(warnings).toHaveLength(1);
	});

	test("a lone concern_severity above the default blocker pushes the blocker up to it", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { concern_severity: 2.8 } });
		expect(cfg.adversary.concern_severity).toBe(2.8);
		expect(cfg.adversary.blocker_severity).toBe(2.8);
	});

	test("a valid pair is untouched and silent", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { concern_severity: 1.0, blocker_severity: 2.0 } }, (m) => warnings.push(m));
		expect(cfg.adversary.concern_severity).toBe(1.0);
		expect(cfg.adversary.blocker_severity).toBe(2.0);
		expect(warnings).toEqual([]);
	});

	test("equal thresholds are allowed", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { concern_severity: 2, blocker_severity: 2 } });
		expect([cfg.adversary.concern_severity, cfg.adversary.blocker_severity]).toEqual([2, 2]);
	});

	test("the severity tiers stay reachable after repair", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { concern_severity: 2.8, blocker_severity: 2.0 } });
		const tier = (sev: number) =>
			sev >= cfg.adversary.blocker_severity ? "blocker" : sev >= cfg.adversary.concern_severity ? "concern" : "pending";
		expect(tier(2.1)).toBe("concern");
		expect(tier(2.9)).toBe("blocker");
	});
});

describe("mergeConfig — ambiguity gate weights", () => {
	const sum = (w: TypesafeConfig["ambiguityGate"]["weights"]) => w.goal + w.constraints + w.criteria + w.context;

	test("the defaults are untouched and silent", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, {}, (m) => warnings.push(m));
		expect(cfg.ambiguityGate.weights).toEqual(DEFAULT_CONFIG.ambiguityGate.weights);
		expect(warnings).toEqual([]);
	});

	test("a partial override is normalized to sum to 1 and keeps the ratios", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { ambiguityGate: { weights: { goal: 0.6 } } }, (m) => warnings.push(m));
		const w = cfg.ambiguityGate.weights;
		expect(sum(w)).toBeCloseTo(1, 12);
		expect(w.goal).toBeCloseTo(0.6 / 1.25, 12);
		expect(w.constraints).toBeCloseTo(0.25 / 1.25, 12);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("normalized");
	});

	test("a uniformly 0.70-clear task still scores 0.30 ambiguity after a partial override", () => {
		const w = mergeConfig(DEFAULT_CONFIG, { ambiguityGate: { weights: { goal: 0.6 } } }).ambiguityGate.weights;
		expect(1 - sum(w) * 0.7).toBeCloseTo(0.3, 12);
	});

	test("all weights set to 1 become 0.25 each", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { ambiguityGate: { weights: { goal: 1, constraints: 1, criteria: 1, context: 1 } } });
		expect(cfg.ambiguityGate.weights).toEqual({ goal: 0.25, constraints: 0.25, criteria: 0.25, context: 0.25 });
	});

	test("all-zero weights fall back to the defaults", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { ambiguityGate: { weights: { goal: 0, constraints: 0, criteria: 0, context: 0 } } }, (m) => warnings.push(m));
		expect(cfg.ambiguityGate.weights).toEqual(DEFAULT_CONFIG.ambiguityGate.weights);
		expect(warnings).toHaveLength(1);
	});
});

describe("mergeConfig — adversary.redact", () => {
	test("redaction is on by default", () => {
		expect(DEFAULT_CONFIG.adversary.redact).toBe(true);
		expect(mergeConfig(DEFAULT_CONFIG, {}).adversary.redact).toBe(true);
	});

	test("the file can switch it off, and a non-boolean keeps the base value", () => {
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { redact: false } }).adversary.redact).toBe(false);
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { redact: "no" } }).adversary.redact).toBe(true);
	});
});

describe("mergeConfig — adversary.steerMinConfidence", () => {
	test("defaults to 0.5, the file can change it, and it is clamped to 0..1", () => {
		expect(DEFAULT_CONFIG.adversary.steerMinConfidence).toBe(0.5);
		expect(mergeConfig(DEFAULT_CONFIG, {}).adversary.steerMinConfidence).toBe(0.5);
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { steerMinConfidence: 0.2 } }).adversary.steerMinConfidence).toBe(0.2);
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { steerMinConfidence: 0 } }).adversary.steerMinConfidence).toBe(0);
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { steerMinConfidence: 7 } }).adversary.steerMinConfidence).toBe(1);
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { steerMinConfidence: -1 } }).adversary.steerMinConfidence).toBe(0);
	});

	test("a non-number keeps the base value", () => {
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { steerMinConfidence: "low" } }).adversary.steerMinConfidence).toBe(0.5);
	});
});

describe("mergeConfig — adversary.tools", () => {
	test("an explicit empty array means no tools are reviewed", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { tools: [] } });
		expect(cfg.adversary.tools).toEqual([]);
	});

	test("an absent or non-array value keeps the default list", () => {
		expect(mergeConfig(DEFAULT_CONFIG, {}).adversary.tools).toEqual(DEFAULT_CONFIG.adversary.tools);
		expect(mergeConfig(DEFAULT_CONFIG, { adversary: { tools: "bash" } }).adversary.tools).toEqual(DEFAULT_CONFIG.adversary.tools);
	});

	test("the default list is copied, not shared", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {});
		expect(cfg.adversary.tools).not.toBe(DEFAULT_CONFIG.adversary.tools);
	});

	test("an array with no usable entries warns and keeps the default list", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { tools: [1, null, ""] } }, (m) => warnings.push(m));
		expect(cfg.adversary.tools).toEqual(DEFAULT_CONFIG.adversary.tools);
		expect(warnings).toHaveLength(1);
	});

	test("a mis-cased known tool is corrected with a warning", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { tools: ["Edit", "bash"] } }, (m) => warnings.push(m));
		expect(cfg.adversary.tools).toEqual(["edit", "bash"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"Edit"');
	});

	// The list of omp tools is not ours to know: real omp tools (github, yield) and MCP tools are valid config.
	test("a tool name outside the built-in list is kept as written, without a warning", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { tools: ["bash", "github", "yield", "mcp_db_query"] } }, (m) => warnings.push(m));
		expect(cfg.adversary.tools).toEqual(["bash", "github", "yield", "mcp_db_query"]);
		expect(warnings).toEqual([]);
	});

	test("only a mis-cased name warns, even next to unknown ones", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { tools: ["Bash", "github"] } }, (m) => warnings.push(m));
		expect(cfg.adversary.tools).toEqual(["bash", "github"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"Bash"');
	});

	test("entries are trimmed and de-duplicated", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { adversary: { tools: [" bash ", "bash", "edit"] } });
		expect(cfg.adversary.tools).toEqual(["bash", "edit"]);
	});
});

describe("mergeConfig — pipeline", () => {
	test("the defaults: the plan guard, skill awareness and spec checks on, the approval guard (it blocks) off", () => {
		expect(DEFAULT_CONFIG.pipeline).toEqual({ planGuard: true, skillAware: true, skills: ["deep-interview", "ralplan", "dag"], specChecks: true, approvalGuard: false });
		expect(mergeConfig(DEFAULT_CONFIG, {}).pipeline).toEqual(DEFAULT_CONFIG.pipeline);
	});

	test("the file can change each switch, and a value that is not a boolean keeps the base value", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { pipeline: { planGuard: false, skillAware: false, specChecks: false, approvalGuard: true } });
		expect(cfg.pipeline).toEqual({ ...DEFAULT_CONFIG.pipeline, planGuard: false, skillAware: false, specChecks: false, approvalGuard: true });
		expect(mergeConfig(DEFAULT_CONFIG, { pipeline: { planGuard: "no", skillAware: 0, specChecks: null, approvalGuard: "yes" } }).pipeline).toEqual(DEFAULT_CONFIG.pipeline);
		for (const pipeline of [null, "off", 3, []]) expect(mergeConfig(DEFAULT_CONFIG, { pipeline }).pipeline).toEqual(DEFAULT_CONFIG.pipeline);
	});

	test("skills: names are trimmed and kept once, and what is not a name is dropped", () => {
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { pipeline: { skills: [" dag ", "dag", "acme/audit", 3, null, "", "Dag"] } }, (m) => warnings.push(m));
		expect(cfg.pipeline.skills).toEqual(["dag", "acme/audit", "Dag"]);
		expect(warnings).toEqual([]);
	});

	test("skills: an explicit empty array means none; an absent key, a non-array or nothing usable falls back to the default", () => {
		expect(mergeConfig(DEFAULT_CONFIG, { pipeline: { skills: [] } }).pipeline.skills).toEqual([]);
		expect(mergeConfig(DEFAULT_CONFIG, { pipeline: {} }).pipeline.skills).toEqual(DEFAULT_CONFIG.pipeline.skills);
		expect(mergeConfig(DEFAULT_CONFIG, { pipeline: { skills: "dag" } }).pipeline.skills).toEqual(DEFAULT_CONFIG.pipeline.skills);
		const warnings: string[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, { pipeline: { skills: [1, "  ", null] } }, (m) => warnings.push(m));
		expect(cfg.pipeline.skills).toEqual(DEFAULT_CONFIG.pipeline.skills);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("pipeline.skills");
	});

	test("the default list is copied, not shared", () => {
		expect(mergeConfig(DEFAULT_CONFIG, {}).pipeline.skills).not.toBe(DEFAULT_CONFIG.pipeline.skills);
		expect(defaultConfig({}).pipeline.skills).not.toBe(DEFAULT_CONFIG.pipeline.skills);
	});
});

describe("applyEnvOverrides — TYPESAFE_PIPELINE_GUARD", () => {
	test.each(["0", "false", "off", "no", " No ", "FALSE"])("=%j is the kill switch of the plan guard, and of nothing else", (value) => {
		const out = applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_PIPELINE_GUARD: value });
		expect(out.pipeline).toEqual({ ...DEFAULT_CONFIG.pipeline, planGuard: false });
		expect({ ...out, pipeline: DEFAULT_CONFIG.pipeline }).toEqual(DEFAULT_CONFIG);
	});

	test.each(["1", "true", "on", "yes", " Yes "])("=%j turns the guard on over a file that turned it off", (value) => {
		const off = mergeConfig(DEFAULT_CONFIG, { pipeline: { planGuard: false } });
		expect(applyEnvOverrides(off, { TYPESAFE_PIPELINE_GUARD: value }).pipeline.planGuard).toBe(true);
	});

	test("a value it cannot read warns and changes nothing; a blank one is silent", () => {
		const warnings: string[] = [];
		expect(applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_PIPELINE_GUARD: "maybe" }, (m) => warnings.push(m))).toEqual(DEFAULT_CONFIG);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("TYPESAFE_PIPELINE_GUARD");
		warnings.length = 0;
		expect(applyEnvOverrides(DEFAULT_CONFIG, { TYPESAFE_PIPELINE_GUARD: "  " }, (m) => warnings.push(m))).toEqual(DEFAULT_CONFIG);
		expect(warnings).toEqual([]);
	});
});

describe("defaultConfig", () => {
	test("is a deep copy of the defaults", () => {
		const cfg = defaultConfig({});
		expect(cfg).toEqual(DEFAULT_CONFIG);
		expect(cfg.adversary).not.toBe(DEFAULT_CONFIG.adversary);
	});

	test("TYPESAFE_DEFAULT_MODEL replaces the default model", () => {
		expect(defaultConfig({ TYPESAFE_DEFAULT_MODEL: " jev-1.13.0 " }).model).toBe("jev-1.13.0");
		expect(defaultConfig({ TYPESAFE_DEFAULT_MODEL: "  " }).model).toBe(DEFAULT_CONFIG.model);
	});
});

describe("loadConfig", () => {
	const saved = {
		TYPESAFE_CONFIG: process.env.TYPESAFE_CONFIG,
		TYPESAFE_REVIEW_ENABLED: process.env.TYPESAFE_REVIEW_ENABLED,
		TYPESAFE_AMBIGUITY_GATE: process.env.TYPESAFE_AMBIGUITY_GATE,
		TYPESAFE_DEFAULT_MODEL: process.env.TYPESAFE_DEFAULT_MODEL,
		TYPESAFE_ROLE: process.env.TYPESAFE_ROLE,
		TYPESAFE_AMBIGUITY_THRESHOLD: process.env.TYPESAFE_AMBIGUITY_THRESHOLD,
		TYPESAFE_PIPELINE_GUARD: process.env.TYPESAFE_PIPELINE_GUARD,
	};
	const dir = mkdtempSync(join(tmpdir(), "omp-typesafe-config-"));
	let n = 0;

	/** Write a config file, point TYPESAFE_CONFIG at it, and clear the other overrides. */
	function useConfigFile(contents: string): string {
		const path = join(dir, `typesafe-${n++}.json`);
		writeFileSync(path, contents);
		process.env.TYPESAFE_CONFIG = path;
		return path;
	}

	function restoreEnv(): void {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}

	function recorder() {
		const warned: unknown[][] = [];
		return { warned, logger: { warn: (...a: unknown[]) => void warned.push(a), info: () => {} } };
	}

	afterEach(() => {
		restoreEnv();
	});

	afterAll(async () => {
		// Leave the module-level config at defaults for other test files.
		process.env.TYPESAFE_CONFIG = join(dir, "does-not-exist.json");
		await loadConfig();
		restoreEnv();
		rmSync(dir, { recursive: true, force: true });
	});

	function clearOverrides(): void {
		for (const key of ["TYPESAFE_REVIEW_ENABLED", "TYPESAFE_AMBIGUITY_GATE", "TYPESAFE_DEFAULT_MODEL", "TYPESAFE_ROLE", "TYPESAFE_AMBIGUITY_THRESHOLD", "TYPESAFE_PIPELINE_GUARD"]) {
			delete process.env[key];
		}
	}

	test("a missing file means plain defaults and no warnings", async () => {
		clearOverrides();
		process.env.TYPESAFE_CONFIG = join(dir, "missing.json");
		const { warned, logger } = recorder();
		const cfg = await loadConfig(logger);
		expect(cfg).toEqual(DEFAULT_CONFIG);
		expect(getConfigWarnings()).toEqual([]);
		expect(warned).toEqual([]);
	});

	test("a malformed file fails closed instead of re-enabling paid reviews", async () => {
		clearOverrides();
		useConfigFile('{ "adversary": { "enabled": false, }, }');
		const { warned, logger } = recorder();
		const cfg = await loadConfig(logger);
		expect(cfg.adversary.enabled).toBe(false);
		expect(cfg.ambiguityGate.enabled).toBe(false);
		expect(cfg.stopGate.enabled).toBe(false);
		expect(getConfigWarnings()).toHaveLength(1);
		expect(getConfigWarnings()[0]).toContain("unreadable");
		expect(warned).toHaveLength(1);
	});

	// The pipeline features make no paid call, so an unreadable file does not touch them: the guard that blocks stays at its
	// default (on) and the opt-in one stays off.
	test("a malformed file leaves the pipeline features at their defaults", async () => {
		clearOverrides();
		useConfigFile('{ "pipeline": { "planGuard": false, ');
		const cfg = await loadConfig();
		expect(cfg.adversary.enabled).toBe(false);
		expect(cfg.pipeline).toEqual(DEFAULT_CONFIG.pipeline);
	});

	test("TYPESAFE_PIPELINE_GUARD wins over the file, either way", async () => {
		clearOverrides();
		useConfigFile('{ "pipeline": { "planGuard": true } }');
		process.env.TYPESAFE_PIPELINE_GUARD = "0";
		expect((await loadConfig()).pipeline.planGuard).toBe(false);
		useConfigFile('{ "pipeline": { "planGuard": false } }');
		process.env.TYPESAFE_PIPELINE_GUARD = "1";
		expect((await loadConfig()).pipeline.planGuard).toBe(true);
		delete process.env.TYPESAFE_PIPELINE_GUARD;
		expect((await loadConfig()).pipeline.planGuard).toBe(false);
	});

	test("a JSON file that is not an object also fails closed", async () => {
		clearOverrides();
		useConfigFile("[]");
		const cfg = await loadConfig();
		expect(cfg.adversary.enabled).toBe(false);
		expect(getConfigWarnings()[0]).toContain("JSON object");
	});

	test("env overrides still apply on top of a fail-closed config", async () => {
		clearOverrides();
		useConfigFile("{ nope");
		process.env.TYPESAFE_REVIEW_ENABLED = "yes";
		const cfg = await loadConfig();
		expect(cfg.adversary.enabled).toBe(true);
		expect(cfg.ambiguityGate.enabled).toBe(false);
	});

	test("a valid file is merged and getConfig returns it", async () => {
		clearOverrides();
		useConfigFile('{ "role": "advisory", "adversary": { "tools": [] } }');
		const cfg = await loadConfig();
		expect(cfg.role).toBe("advisory");
		expect(cfg.adversary.tools).toEqual([]);
		expect(getConfig()).toBe(cfg);
		expect(getConfigWarnings()).toEqual([]);
	});

	test("merge repairs and rejected env values are reported through getConfigWarnings and the logger", async () => {
		clearOverrides();
		useConfigFile('{ "adversary": { "concern_severity": 2.8, "blocker_severity": 2.0 } }');
		process.env.TYPESAFE_AMBIGUITY_THRESHOLD = "0.3oops";
		const { warned, logger } = recorder();
		const cfg = await loadConfig(logger);
		expect(cfg.adversary.concern_severity).toBe(2.0);
		expect(cfg.ambiguityGate.threshold).toBe(DEFAULT_CONFIG.ambiguityGate.threshold);
		expect(getConfigWarnings()).toHaveLength(2);
		expect(warned).toHaveLength(2);
		expect(String(warned[0]?.[0])).toStartWith("[typesafe] ");
	});

	test("warnings are reset on every load", async () => {
		clearOverrides();
		useConfigFile("{ nope");
		await loadConfig();
		expect(getConfigWarnings()).toHaveLength(1);
		useConfigFile("{}");
		await loadConfig();
		expect(getConfigWarnings()).toEqual([]);
	});

	test("TYPESAFE_DEFAULT_MODEL is the model when the file sets none; a file model wins", async () => {
		clearOverrides();
		process.env.TYPESAFE_DEFAULT_MODEL = "jev-1.13.0";
		useConfigFile("{}");
		expect((await loadConfig()).model).toBe("jev-1.13.0");
		useConfigFile('{ "model": "jev-1.12.0" }');
		expect((await loadConfig()).model).toBe("jev-1.12.0");
		process.env.TYPESAFE_CONFIG = join(dir, "missing.json");
		expect((await loadConfig()).model).toBe("jev-1.13.0");
	});
});

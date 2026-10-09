import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PIPELINE_SKILLS } from "./pipeline/skill";
import { isRecord } from "./text";

/**
 * Config lives at <agent dir>/typesafe.json (default ~/.omp/agent, or $PI_CODING_AGENT_DIR when omp runs
 * with a profile) and is loaded on session_start. A missing file means these defaults. A file that exists
 * but cannot be parsed fails closed: the paid reviewers stay off and getConfigWarnings() says why.
 */

export interface AdversarySettings {
	enabled: boolean;
	reviewActions: boolean;
	reviewMessages: boolean;
	reviewTurns: boolean;
	tools: string[];
	inlineActionNotes: boolean;
	evidence: boolean;
	/** Mask obvious secrets in everything sent to TypeSafe (best-effort pattern matching). */
	redact: boolean;
	noul_floor: number;
	concern_severity: number;
	blocker_severity: number;
	emitNits: boolean;
	maxNotesPerUpdate: number;
	maxCallsPerTurn: number;
	immuneTurns: number;
	/** A would-be steer whose severity answer reports less confidence than this is delivered quietly instead. */
	steerMinConfidence: number;
	minMessageChars: number;
	timeoutMs: number;
}

export interface StopGateSettings {
	enabled: boolean;
	unfinished_threshold: number;
	verified_floor: number;
}

export interface AmbiguityGateSettings {
	enabled: boolean;
	threshold: number;
	weights: { goal: number; constraints: number; criteria: number; context: number };
	userCanAnswerFloor: number;
	maxAsksPerPlan: number;
	blockPropose: boolean;
	timeoutMs: number;
}

/**
 * Features for the omp-skills pipeline (deep-interview -> spec, ralplan -> PRD, dag -> run). Skill awareness is
 * local; the guards and the spec check take a Jev second opinion where their exact checks cannot decide
 * (see pipeline.jev), so only skillAware sends nothing off the machine.
 */
export interface PipelineSettings {
	/**
	 * Block an eval cell that calls run_dag() or prepare_dag() while plan mode is on: its workers are read-only there. On by
	 * default, and it does not check that omp-skills is installed: any plan-mode Python cell with such a call is blocked,
	 * a function of that name from other code included.
	 */
	planGuard: boolean;
	/**
	 * A prompt that runs one of `skills` is that skill's own turn: the ambiguity gate stays silent. Any skill the user invoked
	 * is their turn: reviews, the stop gate and the gate take its args (`details.args`) as the task. Off, none of that
	 * is read and only a user message is a turn, as before the pipeline features (see userTurnText).
	 */
	skillAware: boolean;
	/**
	 * Skill names `skillAware` recognizes, as omp names them (`deep-interview`, or `<namespace>/<name>`). A bare name also
	 * matches that skill under any namespace; a namespaced entry matches only that one (see isPipelineSkill).
	 */
	skills: string[];
	/**
	 * Check a deep-interview spec when it is written, and send the model one note about what is wrong. Advisory. The note is an
	 * aside, not `nextTurn`: it must reach the model's next step, which is the one that asks for approval.
	 */
	specChecks: boolean;
	/** Block an approval (a spec's APPROVED marker, a PRD or DAG `approved: true`, `approve_file(`) the user never answered. Off by default: it blocks. */
	approvalGuard: boolean;
	/** Jev second opinions for the plan guard, the spec checks and the approval guard. */
	jev: PipelineJevSettings;
}

/**
 * The Jev second opinions for the plan guard, the spec checks and the approval guard: one floor per
 * stake (a block, a note, a privilege override) and a shared per-call timeout. Skill awareness takes
 * none: it routes turns, it judges nothing.
 */
export interface PipelineJevSettings {
	enabled: boolean;
	/** A plan-mode cell is blocked at or above this. */
	planFloor: number;
	/** A spec finding is noted at or above this. */
	specFloor: number;
	/** A blocked flip is allowed at or above this. */
	approvalFloor: number;
	timeoutMs: number;
}

/**
 * Verbatim context reduction (src/compaction.ts). Before a model request whose context is at least `minChars`, Jev scores
 * every tool call and result in the history; the outputs it judges no longer needed are cut to a short head and a note
 * naming the file that holds the rest. Only what that request sends changes: the session on disk is untouched. What goes
 * to TypeSafe is the conversation (tool names, inputs, message text), masked when `adversary.redact` is on.
 */
export interface CompactionSettings {
	enabled: boolean;
	/** Minimum probability Jev must give a tool result for it to stay in full. */
	keepThreshold: number;
	/** A context shorter than this many characters is left alone. */
	minChars: number;
	/** Write each cut output to <agent dir>/jev-spill so the agent can read it back. Off, a cut output is gone for that request. */
	spill: boolean;
	/** The newest this many messages are never touched. */
	preserveRecent: number;
	/**
	 * Re-score rarely and re-apply the same decisions in between, so the provider's prompt cache keeps hitting. Off, every
	 * request is re-scored, except a session already served mostly from cache (`cacheCeiling`).
	 */
	sticky: boolean;
	/** Sticky: re-score once the context has grown by this share since the last rewrite. */
	rewriteGrowth: number;
	/** Sticky: never re-score more often than this many requests apart, whatever the growth. */
	minRequestsBetweenRewrites: number;
	/** Sticky: re-score at least this often, in requests. */
	maxRequestsBetweenRewrites: number;
	/** Not sticky: skip a session whose last request was at least this share cache reads. */
	cacheCeiling: number;
	/** Per request to Jev, in ms. */
	timeoutMs: number;
}

export type TypesafeRole = "adversarial" | "advisory";
export type TypesafePhase = "plan" | "execute";

export interface TypesafeConfig {
	model: string;
	role: TypesafeRole;
	phases: TypesafePhase[];
	adversary: AdversarySettings;
	stopGate: StopGateSettings;
	ambiguityGate: AmbiguityGateSettings;
	pipeline: PipelineSettings;
	compaction: CompactionSettings;
}

export const DEFAULT_CONFIG: TypesafeConfig = {
	model: "jev-latest",
	role: "adversarial",
	phases: ["plan", "execute"],
	adversary: {
		enabled: true,
		reviewActions: true,
		reviewMessages: true,
		reviewTurns: true,
		tools: ["edit", "write", "apply_patch", "ast_edit", "bash", "eval", "notebook", "debug", "task"],
		inlineActionNotes: true,
		evidence: true,
		redact: true,
		noul_floor: 0.45,
		concern_severity: 1.5,
		blocker_severity: 2.5,
		emitNits: false,
		maxNotesPerUpdate: 4,
		maxCallsPerTurn: 8,
		immuneTurns: 3,
		steerMinConfidence: 0.5,
		minMessageChars: 200,
		timeoutMs: 1500,
	},
	stopGate: { enabled: false, unfinished_threshold: 0.7, verified_floor: 0.25 },
	ambiguityGate: {
		enabled: true,
		threshold: 0.2,
		weights: { goal: 0.35, constraints: 0.25, criteria: 0.25, context: 0.15 },
		userCanAnswerFloor: 0.5,
		maxAsksPerPlan: 3,
		blockPropose: true,
		timeoutMs: 2500,
	},
	pipeline: {
		planGuard: true,
		skillAware: true,
		skills: [...DEFAULT_PIPELINE_SKILLS],
		specChecks: true,
		approvalGuard: false,
		jev: { enabled: true, planFloor: 0.5, specFloor: 0.45, approvalFloor: 0.85, timeoutMs: 2500 },
	},
	compaction: {
		enabled: true,
		keepThreshold: 0.2,
		minChars: 150_000,
		spill: true,
		preserveRecent: 6,
		sticky: true,
		rewriteGrowth: 0.4,
		minRequestsBetweenRewrites: 15,
		maxRequestsBetweenRewrites: 40,
		cacheCeiling: 0.8,
		timeoutMs: 10_000,
	},
};

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

/**
 * omp's agent state directory. omp exports PI_CODING_AGENT_DIR for the active profile
 * (`omp --profile <name>` / OMP_PROFILE), so honoring it keeps typesafe.json and the priority
 * files profile-aware. A leading `~` is expanded.
 */
export function agentDir(env: Env = process.env): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	if (!override) return join(homedir(), ".omp", "agent");
	if (override === "~") return homedir();
	if (override.startsWith("~/")) return join(homedir(), override.slice(2));
	return override;
}

export function configPath(env: Env = process.env): string {
	return join(agentDir(env), "typesafe.json");
}

/** Resolve the config file path, honoring TYPESAFE_CONFIG as a full replacement path. */
export function resolveConfigPath(env: Env = process.env): string {
	const override = env.TYPESAFE_CONFIG?.trim();
	return override ? override : configPath(env);
}

const TRUE_WORDS = new Set(["1", "true", "on", "yes"]);
const FALSE_WORDS = new Set(["0", "false", "off", "no"]);

/** Parse a boolean env value; blank is silently absent, anything unrecognized warns and is ignored. */
function envBool(name: string, raw: string | undefined, warn?: Warn): boolean | undefined {
	const v = raw?.trim().toLowerCase();
	if (!v) return undefined;
	if (TRUE_WORDS.has(v)) return true;
	if (FALSE_WORDS.has(v)) return false;
	warn?.(`${name}=${JSON.stringify(raw)} is not a recognized boolean (use 1/0, true/false, on/off or yes/no); ignored`);
	return undefined;
}

/**
 * Is the subagent guard on (src/subagent.ts)? Default yes; TYPESAFE_SUBAGENT_GUARD=0/false/off/no switches it off.
 * Deliberately not a config key: the file is read at session_start, which is the very hook the guard skips in a
 * subagent, so a fresh copy of the extension (an isolated agent) would never see it. The environment is
 * read on every call instead. An unrecognized value leaves the guard on; applyEnvOverrides warns about it.
 */
export function subagentGuardEnabled(env: Env = process.env): boolean {
	return envBool("TYPESAFE_SUBAGENT_GUARD", env.TYPESAFE_SUBAGENT_GUARD) ?? true;
}

/**
 * Apply TYPESAFE_ROLE / TYPESAFE_REVIEW_ENABLED / TYPESAFE_AMBIGUITY_GATE / TYPESAFE_AMBIGUITY_THRESHOLD /
 * TYPESAFE_PIPELINE_GUARD / TYPESAFE_PIPELINE_JEV on top of a merged config. Env wins over file. Values are trimmed and case-insensitive; anything
 * unrecognized is ignored with a warning instead of silently. TYPESAFE_SUBAGENT_GUARD is not applied (it is no
 * config value, see subagentGuardEnabled) but is checked here so that a typo is warned about at session start.
 * Pure function so it is independently testable; TYPESAFE_CONFIG is handled separately in
 * loadConfig (it selects *which* file to read, before merging, not a post-merge override).
 */
export function applyEnvOverrides(cfg: TypesafeConfig, env: Env = process.env, warn?: Warn): TypesafeConfig {
	let out = cfg;
	const roleRaw = env.TYPESAFE_ROLE?.trim().toLowerCase();
	if (roleRaw) {
		if (roleRaw === "advisory" || roleRaw === "adversarial") {
			out = { ...out, role: roleRaw };
		} else {
			warn?.(`TYPESAFE_ROLE=${JSON.stringify(env.TYPESAFE_ROLE)} is not "advisory" or "adversarial"; ignored`);
		}
	}
	const enabled = envBool("TYPESAFE_REVIEW_ENABLED", env.TYPESAFE_REVIEW_ENABLED, warn);
	if (enabled !== undefined) {
		out = { ...out, adversary: { ...out.adversary, enabled } };
	}
	const gate = envBool("TYPESAFE_AMBIGUITY_GATE", env.TYPESAFE_AMBIGUITY_GATE, warn);
	if (gate !== undefined) {
		out = { ...out, ambiguityGate: { ...out.ambiguityGate, enabled: gate } };
	}
	// The kill switch for the plan guard, which blocks a tool call: it must work without editing the file.
	const planGuard = envBool("TYPESAFE_PIPELINE_GUARD", env.TYPESAFE_PIPELINE_GUARD, warn);
	if (planGuard !== undefined) {
		out = { ...out, pipeline: { ...out.pipeline, planGuard } };
	}
	// The kill switch for the pipeline Jev second opinions, which send text to TypeSafe.
	const pipelineJev = envBool("TYPESAFE_PIPELINE_JEV", env.TYPESAFE_PIPELINE_JEV, warn);
	if (pipelineJev !== undefined) {
		out = { ...out, pipeline: { ...out.pipeline, jev: { ...out.pipeline.jev, enabled: pipelineJev } } };
	}
	const thresholdRaw = env.TYPESAFE_AMBIGUITY_THRESHOLD?.trim();
	if (thresholdRaw) {
		const parsed = Number(thresholdRaw);
		if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
			out = { ...out, ambiguityGate: { ...out.ambiguityGate, threshold: parsed } };
		} else {
			warn?.(`TYPESAFE_AMBIGUITY_THRESHOLD=${JSON.stringify(env.TYPESAFE_AMBIGUITY_THRESHOLD)} is not a number between 0 and 1; ignored`);
		}
	}
	envBool("TYPESAFE_SUBAGENT_GUARD", env.TYPESAFE_SUBAGENT_GUARD, warn);
	return out;
}

/**
 * Built-in defaults. The model honors TYPESAFE_DEFAULT_MODEL: the client always sends the configured
 * model explicitly, which would otherwise mask that SDK env var. A model set in the config file
 * still wins over it.
 */
export function defaultConfig(env: Env = process.env): TypesafeConfig {
	const cfg = structuredClone(DEFAULT_CONFIG);
	const model = env.TYPESAFE_DEFAULT_MODEL?.trim();
	if (model) cfg.model = model;
	return cfg;
}

let config: TypesafeConfig = defaultConfig();
let configWarnings: string[] = [];

export function getConfig(): TypesafeConfig {
	return config;
}

/** Problems found by the last loadConfig (unparsable file, repaired values, rejected env values). */
export function getConfigWarnings(): string[] {
	return [...configWarnings];
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
	if (!isNum(v)) return fallback;
	return Math.min(max, Math.max(min, v));
}

/** omp tool names the reviewer can plausibly be pointed at; used only to correct a mis-cased name. */
const KNOWN_TOOLS = [
	...DEFAULT_CONFIG.adversary.tools,
	"read",
	"grep",
	"find",
	"ast_grep",
	"lsp",
	"browser",
	"fetch",
	"web_search",
	"ask",
	"todo_write",
	"ssh",
];
const KNOWN_TOOLS_BY_LOWER = new Map(KNOWN_TOOLS.map((name) => [name.toLowerCase(), name]));

/**
 * Tool allowlist. An explicit empty array means "review no tools"; the fallback applies only when the
 * key is absent, is not an array, or holds nothing usable. Mis-cased known names are corrected with a
 * warning; every other name is kept as written and without a warning, because the list of omp tools is
 * not ours to know (MCP tools, tools added by a newer omp) and a valid config must not warn on each
 * session start. Matching is exact, so a misspelled name simply never matches.
 */
function toolsArr(v: unknown, fallback: string[], warn?: Warn): string[] {
	if (!Array.isArray(v)) return [...fallback];
	const out = new Set<string>();
	for (const entry of v) {
		if (typeof entry !== "string") continue;
		const name = entry.trim();
		if (!name) continue;
		const known = KNOWN_TOOLS_BY_LOWER.get(name.toLowerCase());
		if (known && known !== name) {
			warn?.(`adversary.tools entry ${JSON.stringify(entry)} corrected to "${known}" (tool names are case-sensitive)`);
			out.add(known);
		} else {
			out.add(name);
		}
	}
	if (v.length > 0 && out.size === 0) {
		warn?.("adversary.tools has no usable entries; using the default list");
		return [...fallback];
	}
	return [...out];
}

/**
 * Skill names: trimmed, each once. As with `adversary.tools`, an explicit empty array means "no skill" and the fallback
 * applies when the key is absent, is not an array, or holds nothing usable. Names are case-sensitive and kept as written
 * (see isPipelineSkill for what a bare and a namespaced name match).
 */
function skillsArr(v: unknown, fallback: string[], warn?: Warn): string[] {
	if (!Array.isArray(v)) return [...fallback];
	const out = [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0))];
	if (v.length > 0 && out.length === 0) {
		warn?.("pipeline.skills has no usable entries; using the default list");
		return [...fallback];
	}
	return out;
}

function roleVal(v: unknown, fallback: TypesafeRole): TypesafeRole {
	return v === "adversarial" || v === "advisory" ? v : fallback;
}

function phasesArr(v: unknown, fallback: TypesafePhase[]): TypesafePhase[] {
	if (!Array.isArray(v)) return fallback;
	const out = [...new Set(v.filter((x): x is TypesafePhase => x === "plan" || x === "execute"))];
	return out.length > 0 ? out : fallback;
}

/**
 * Keep concern_severity <= blocker_severity, otherwise the concern tier is unreachable. When only one
 * of the pair was supplied it wins and the inherited one is pulled to meet it; when both were supplied
 * (or neither) the pair is swapped.
 */
function orderSeverities(
	concern: number,
	blocker: number,
	concernSet: boolean,
	blockerSet: boolean,
	warn?: Warn,
): [concern: number, blocker: number] {
	if (concern <= blocker) return [concern, blocker];
	const detail = `concern_severity ${concern} is above blocker_severity ${blocker}`;
	if (blockerSet && !concernSet) {
		warn?.(`adversary: ${detail}; concern_severity lowered to ${blocker}`);
		return [blocker, blocker];
	}
	if (concernSet && !blockerSet) {
		warn?.(`adversary: ${detail}; blocker_severity raised to ${concern}`);
		return [concern, concern];
	}
	warn?.(`adversary: ${detail}; the two values were swapped`);
	return [blocker, concern];
}

type GateWeights = AmbiguityGateSettings["weights"];

/**
 * compositeAmbiguity is `1 - sum(w * clarity)`, so weights that do not sum to 1 rescale the score and
 * move the effective threshold. Normalize by the sum; all-zero weights cannot be normalized and keep
 * the base weights.
 */
function normalizeWeights(weights: GateWeights, fallback: GateWeights, warn?: Warn): GateWeights {
	const sum = weights.goal + weights.constraints + weights.criteria + weights.context;
	if (Math.abs(sum - 1) < 1e-9) return weights;
	if (sum <= 0) {
		warn?.("ambiguityGate.weights are all zero; using the default weights");
		return { ...fallback };
	}
	warn?.(`ambiguityGate.weights sum to ${Number(sum.toFixed(4))}; normalized to sum to 1`);
	return {
		goal: weights.goal / sum,
		constraints: weights.constraints / sum,
		criteria: weights.criteria / sum,
		context: weights.context / sum,
	};
}

export function mergeConfig(base: TypesafeConfig, override: unknown, warn?: Warn): TypesafeConfig {
	const o = (typeof override === "object" && override !== null ? override : {}) as Record<string, unknown>;
	const adv = (typeof o.adversary === "object" && o.adversary !== null ? o.adversary : {}) as Record<string, unknown>;
	const gate = (typeof o.stopGate === "object" && o.stopGate !== null ? o.stopGate : {}) as Record<string, unknown>;
	const amb = (typeof o.ambiguityGate === "object" && o.ambiguityGate !== null ? o.ambiguityGate : {}) as Record<string, unknown>;
	const pipe = (typeof o.pipeline === "object" && o.pipeline !== null ? o.pipeline : {}) as Record<string, unknown>;
	const comp = (typeof o.compaction === "object" && o.compaction !== null ? o.compaction : {}) as Record<string, unknown>;
	const ambWeights = (typeof amb.weights === "object" && amb.weights !== null ? amb.weights : {}) as Record<string, unknown>;
	const pjev = (typeof pipe.jev === "object" && pipe.jev !== null ? pipe.jev : {}) as Record<string, unknown>;
	const a = base.adversary;
	const g = base.stopGate;
	const ag = base.ambiguityGate;
	const pl = base.pipeline;
	const cm = base.compaction;
	const [concernSeverity, blockerSeverity] = orderSeverities(
		num(adv.concern_severity, a.concern_severity, 0, 3),
		num(adv.blocker_severity, a.blocker_severity, 0, 3),
		isNum(adv.concern_severity),
		isNum(adv.blocker_severity),
		warn,
	);
	return {
		model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : base.model,
		role: roleVal(o.role, base.role),
		phases: phasesArr(o.phases, base.phases),
		adversary: {
			enabled: bool(adv.enabled, a.enabled),
			reviewActions: bool(adv.reviewActions, a.reviewActions),
			reviewMessages: bool(adv.reviewMessages, a.reviewMessages),
			reviewTurns: bool(adv.reviewTurns, a.reviewTurns),
			tools: toolsArr(adv.tools, a.tools, warn),
			inlineActionNotes: bool(adv.inlineActionNotes, a.inlineActionNotes),
			evidence: bool(adv.evidence, a.evidence),
			redact: bool(adv.redact, a.redact),
			noul_floor: num(adv.noul_floor, a.noul_floor, 0, 1),
			concern_severity: concernSeverity,
			blocker_severity: blockerSeverity,
			emitNits: bool(adv.emitNits, a.emitNits),
			maxNotesPerUpdate: Math.trunc(num(adv.maxNotesPerUpdate, a.maxNotesPerUpdate, 1, 32)),
			maxCallsPerTurn: Math.trunc(num(adv.maxCallsPerTurn, a.maxCallsPerTurn, 1, 128)),
			immuneTurns: Math.trunc(num(adv.immuneTurns, a.immuneTurns, 0, 32)),
			steerMinConfidence: num(adv.steerMinConfidence, a.steerMinConfidence, 0, 1),
			minMessageChars: Math.trunc(num(adv.minMessageChars, a.minMessageChars, 0, 100_000)),
			timeoutMs: Math.trunc(num(adv.timeoutMs, a.timeoutMs, 250, 60_000)),
		},
		stopGate: {
			enabled: bool(gate.enabled, g.enabled),
			unfinished_threshold: num(gate.unfinished_threshold, g.unfinished_threshold, 0, 1),
			verified_floor: num(gate.verified_floor, g.verified_floor, 0, 1),
		},
		ambiguityGate: {
			enabled: bool(amb.enabled, ag.enabled),
			threshold: num(amb.threshold, ag.threshold, 0, 1),
			weights: normalizeWeights(
				{
					goal: num(ambWeights.goal, ag.weights.goal, 0, 1),
					constraints: num(ambWeights.constraints, ag.weights.constraints, 0, 1),
					criteria: num(ambWeights.criteria, ag.weights.criteria, 0, 1),
					context: num(ambWeights.context, ag.weights.context, 0, 1),
				},
				ag.weights,
				warn,
			),
			userCanAnswerFloor: num(amb.userCanAnswerFloor, ag.userCanAnswerFloor, 0, 1),
			maxAsksPerPlan: Math.trunc(num(amb.maxAsksPerPlan, ag.maxAsksPerPlan, 0, 32)),
			blockPropose: bool(amb.blockPropose, ag.blockPropose),
			timeoutMs: Math.trunc(num(amb.timeoutMs, ag.timeoutMs, 250, 60_000)),
		},
		pipeline: {
			planGuard: bool(pipe.planGuard, pl.planGuard),
			skillAware: bool(pipe.skillAware, pl.skillAware),
			skills: skillsArr(pipe.skills, pl.skills, warn),
			specChecks: bool(pipe.specChecks, pl.specChecks),
			approvalGuard: bool(pipe.approvalGuard, pl.approvalGuard),
			jev: {
				enabled: bool(pjev.enabled, pl.jev.enabled),
				planFloor: num(pjev.planFloor, pl.jev.planFloor, 0, 1),
				specFloor: num(pjev.specFloor, pl.jev.specFloor, 0, 1),
				approvalFloor: num(pjev.approvalFloor, pl.jev.approvalFloor, 0, 1),
				timeoutMs: Math.trunc(num(pjev.timeoutMs, pl.jev.timeoutMs, 250, 10_000)),
			},
		},
		compaction: {
			enabled: bool(comp.enabled, cm.enabled),
			keepThreshold: num(comp.keepThreshold, cm.keepThreshold, 0, 1),
			minChars: Math.trunc(num(comp.minChars, cm.minChars, 0, 100_000_000)),
			spill: bool(comp.spill, cm.spill),
			preserveRecent: Math.trunc(num(comp.preserveRecent, cm.preserveRecent, 0, 1000)),
			sticky: bool(comp.sticky, cm.sticky),
			rewriteGrowth: num(comp.rewriteGrowth, cm.rewriteGrowth, 0, 10),
			minRequestsBetweenRewrites: Math.trunc(num(comp.minRequestsBetweenRewrites, cm.minRequestsBetweenRewrites, 0, 10_000)),
			maxRequestsBetweenRewrites: Math.trunc(num(comp.maxRequestsBetweenRewrites, cm.maxRequestsBetweenRewrites, 1, 10_000)),
			cacheCeiling: num(comp.cacheCeiling, cm.cacheCeiling, 0, 1),
			timeoutMs: Math.trunc(num(comp.timeoutMs, cm.timeoutMs, 250, 60_000)),
		},
	};
}

/**
 * Config used when the file exists but cannot be read or parsed. Defaults would silently re-enable the
 * paid reviewers, the pipeline Jev second opinions, and context compaction (all of which send text to
 * TypeSafe), for a user who had turned them off, so they stay off until the file is fixed
 * (TYPESAFE_REVIEW_ENABLED / TYPESAFE_AMBIGUITY_GATE can still turn the reviewers on).
 */
function failClosed(base: TypesafeConfig): TypesafeConfig {
	return {
		...base,
		adversary: { ...base.adversary, enabled: false },
		stopGate: { ...base.stopGate, enabled: false },
		ambiguityGate: { ...base.ambiguityGate, enabled: false },
		pipeline: { ...base.pipeline, jev: { ...base.pipeline.jev, enabled: false } },
		compaction: { ...base.compaction, enabled: false },
	};
}

/** Load (or reload) the config file; returns the effective config. Problems are in getConfigWarnings(). */
export async function loadConfig(logger?: { warn?: (message: string) => void; info?: (message: string) => void }): Promise<TypesafeConfig> {
	const path = resolveConfigPath();
	const warnings: string[] = [];
	const warn: Warn = (message) => {
		warnings.push(message);
		logger?.warn?.(`[typesafe] ${message}`);
	};
	const base = defaultConfig();
	let next: TypesafeConfig;
	try {
		const raw: unknown = await Bun.file(path).json();
		if (!isRecord(raw)) throw new TypeError("the top-level value must be a JSON object");
		next = mergeConfig(base, raw, warn);
		logger?.info?.(`[typesafe] config loaded from ${path}`);
	} catch (err) {
		// Bun file errors carry an errno `code` property on the Error object.
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			next = base;
		} else {
			next = failClosed(base);
			warn(`config at ${path} is unreadable (${err}); reviews, gates, the pipeline second opinions and compaction are off until it parses`);
		}
	}
	config = applyEnvOverrides(next, process.env, warn);
	configWarnings = warnings;
	return config;
}

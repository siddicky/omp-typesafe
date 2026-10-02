/**
 * Reads the extension's TYPESAFE_BENCH_LOG dump, written on session_shutdown:
 * { role, phases, stats, usage, costUsd, lastResolvedModel, history, ambiguity,
 * historyDropped, config, subagentSessionsSkipped }. Each `history` record carries { ts, role, kind,
 * severity, decision, ... }. The `off` baseline loads no extension, so a file
 * for an `off` run is a leak (run.ts checkTelemetry flags it).
 *
 * `history` has one record per review whatever its outcome: a review that
 * found nothing (`decision: "none"`, severity "none"), a suppressed note
 * (duplicate, nits_disabled, update_budget, ...) and an error each get a
 * record, next to the notes that were actually delivered. Anything described
 * as a "note" here (severity/channel breakdowns, the plan/exec split) means a
 * delivered record only; the other outcomes are counted separately.
 */
export interface TelemetryHistoryRecord {
	role: string;
	kind: string;
	severity: string;
	decision: string;
	/** Delivery channel of a delivered note (aside, steer, nextTurn, inline); absent on every other decision. */
	channel?: string;
	defect?: string;
	/** Why a suppressed review withheld its note (e.g. "duplicate", "nits_disabled"). */
	reason?: string;
	/** ISO timestamp, when present; used to split plan-phase vs exec-phase notes on plan-yolo cells. */
	ts?: string;
}

/** One ambiguity-gate score, written by the extension at a plan_start/turn_end/propose checkpoint. */
export interface AmbiguityScore {
	ts: string;
	trigger: "plan_start" | "turn_end" | "propose";
	ambiguity: number;
	dims: { goal: number; constraints: number; criteria: number; context: number };
	weakest: string;
	gap: string;
	userCanAnswer: number;
	decision: GateDecision;
	/** The drafted question, when the gate wrote one. */
	question?: string;
}

/**
 * What the gate did with a score (src/ambiguity.ts GateDecision). "none" means the score did not call for
 * a question; the `would_*` and `suppressed_*` values mean it did, but nothing was sent (or it was muted).
 */
export type GateDecision = "steer" | "block" | "would_steer" | "would_block" | "suppressed_dedupe" | "suppressed_immune" | "none";

/** Ambiguity-gate telemetry block, optional: absent on runs recorded before the gate was added to the extension. */
export interface AmbiguityTelemetry {
	scores: AmbiguityScore[];
	asksObserved: number;
}

/** The extension's own report of the config it ran with (the `config` block of the dump). Every field is optional: an older extension wrote none of it. */
export interface ReportedConfig {
	role?: string;
	phases?: string[];
	model?: string;
	adversaryEnabled?: boolean;
	reviewActions?: boolean;
	reviewMessages?: boolean;
	reviewTurns?: boolean;
	ambiguityGateEnabled?: boolean;
}

export interface TelemetryLog {
	role: string;
	phases?: string[];
	stats: Record<string, unknown>;
	usage: Record<string, unknown>;
	costUsd: number;
	/** The Jev model that answered the last request, e.g. "jev-1.13.0". */
	lastResolvedModel?: string | null;
	history: TelemetryHistoryRecord[];
	/** Optional: absent on runs recorded before the ambiguity gate was added to the extension. */
	ambiguity?: AmbiguityTelemetry;
	/** Number of review records evicted from the extension's history before the dump. Absent on older dumps, whose history is a 50-record ring. */
	historyDropped?: number;
	/** Effective extension config at shutdown; read through reportedConfig(), which drops anything that is not well typed. */
	config?: Record<string, unknown>;
	/**
	 * Subagent sessions (task-tool and eval-agent workers) the extension stayed dormant in. Only the main session
	 * reviews and writes the dump, so work a cell's agent handed to workers shows up here and in no other field.
	 * Absent on dumps from before the subagent guard.
	 */
	subagentSessionsSkipped?: number;
}

/** Plan cells run in read-only plan mode until the plan-yolo handoff; exec cells never see the handoff. */
export type CellType = "exec" | "plan";

/** Size of the extension's review-history ring buffer before `historyDropped` existed. */
export const LEGACY_HISTORY_CAP = 50;

/** The last "propose"-trigger ambiguity score, or null if there is none (including when `ambiguity` is absent). */
export function ambiguityAtPropose(t: TelemetryLog | null | undefined): AmbiguityScore | null {
	const scores = t?.ambiguity?.scores;
	if (!scores || scores.length === 0) return null;
	const proposeScores = scores.filter((s) => s.trigger === "propose");
	if (proposeScores.length === 0) return null;
	return proposeScores[proposeScores.length - 1];
}

/**
 * True if any ambiguity score in this telemetry called for a question: every decision
 * but "none", including the would_* and suppressed_* ones, which are scores over the
 * threshold where nothing was sent (headless runs cannot block; a repeated or immune
 * steer is muted). False when the gate scored and every score said "none": the extension
 * logs a score for every evaluation that completed, "none" included. Null when there is
 * nothing to judge: no telemetry at all (a run that timed out or crashed before
 * session_shutdown), telemetry without an ambiguity block (recorded before the gate
 * existed), or an empty score log. An empty log is not "did not ask": the extension logs
 * nothing when its scoring failed or timed out, when it has no API key, or when the run
 * never reached plan mode, so no evaluation completed and nothing was measured. A
 * reported rate must leave those runs out instead of counting them as "did not ask".
 * Callers also pass null for cells where the gate could not act (gateCouldAct): their
 * empty score log is by construction.
 */
export function wouldAsk(t: TelemetryLog | null | undefined): boolean | null {
	const scores = t?.ambiguity?.scores;
	if (!Array.isArray(scores) || scores.length === 0) return null;
	return scores.some((s) => typeof s.decision === "string" && s.decision !== "none");
}

/**
 * Could the ambiguity gate have acted in this cell at all? It only runs in plan mode and only when it is on, so
 * an exec cell, a gate-off cell, the no-extension baseline and a run whose extension reported the gate disabled
 * all have an empty score log by construction. That is not a measurement of "did not ask" and must be n/a, not 0.
 */
export function gateCouldAct(cell: { type?: string; role?: string; gate?: string }, reported?: ReportedConfig | null): boolean {
	if (cell.type === "exec" || cell.role === "off" || cell.gate === "off") return false;
	return reported?.ambiguityGateEnabled !== false;
}

/** Counts ambiguity scores by decision (e.g. {"steer": 1, "none": 3}). */
export function gateEvents(t: TelemetryLog | null | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	const scores = t?.ambiguity?.scores;
	if (!scores) return out;
	for (const s of scores) {
		if (typeof s.decision === "string") out[s.decision] = (out[s.decision] ?? 0) + 1;
	}
	return out;
}

function isRecordObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses a TYPESAFE_BENCH_LOG dump. Returns null when the file is missing,
 * unparseable, or not an object. The payload grows over time (effective
 * config, historyDropped, a longer history), so extra fields pass through and
 * `history` is normalized to an array of record objects so callers can iterate it
 * without guarding.
 */
export async function readTelemetry(path: string): Promise<TelemetryLog | null> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(path).json();
	} catch {
		return null;
	}
	if (!isRecordObject(parsed)) return null;
	const history = Array.isArray(parsed.history) ? parsed.history.filter(isRecordObject) : [];
	return { ...parsed, history } as unknown as TelemetryLog;
}

function optionalBool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

/**
 * The `config` block of a dump with only its well-typed fields kept (a boolean flag
 * that is not a boolean is dropped, not coerced), or null when the dump carries no
 * config object. A field the extension did not report stays undefined, so a check
 * can tell "reported false" from "did not say".
 */
export function reportedConfig(t: TelemetryLog | null | undefined): ReportedConfig | null {
	const raw = t?.config;
	if (!isRecordObject(raw)) return null;
	const out: ReportedConfig = {};
	if (typeof raw.role === "string") out.role = raw.role;
	if (Array.isArray(raw.phases) && raw.phases.every((p) => typeof p === "string")) out.phases = raw.phases as string[];
	if (typeof raw.model === "string") out.model = raw.model;
	for (const key of ["adversaryEnabled", "reviewActions", "reviewMessages", "reviewTurns", "ambiguityGateEnabled"] as const) {
		const v = optionalBool(raw[key]);
		if (v !== undefined) out[key] = v;
	}
	return out;
}

/** A review that put a note in front of the agent. Everything else (nothing to raise, suppressed, error) is not a note. */
export function isDelivered(h: TelemetryHistoryRecord): boolean {
	return h.decision === "delivered" || h.decision === "delivered_inline";
}

/** Counts delivered notes by severity (e.g. {"nit": 2, "concern": 1}); reviews that delivered nothing are not counted. */
export function severityBreakdown(history: TelemetryHistoryRecord[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const h of history) {
		if (isDelivered(h) && typeof h.severity === "string") out[h.severity] = (out[h.severity] ?? 0) + 1;
	}
	return out;
}

/** Counts delivered notes by delivery channel (e.g. {"steer": 1, "aside": 2, "nextTurn": 1}). */
export function channelBreakdown(history: TelemetryHistoryRecord[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const h of history) {
		if (isDelivered(h) && typeof h.channel === "string") out[h.channel] = (out[h.channel] ?? 0) + 1;
	}
	return out;
}

/** Counts suppressed reviews by reason (e.g. {"duplicate": 2, "nits_disabled": 1}); a record with no reason counts as "unknown". */
export function suppressedBreakdown(history: TelemetryHistoryRecord[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const h of history) {
		if (h.decision !== "suppressed") continue;
		const reason = typeof h.reason === "string" && h.reason ? h.reason : "unknown";
		out[reason] = (out[reason] ?? 0) + 1;
	}
	return out;
}

/** Counts every review record by decision (e.g. {"none": 10, "delivered": 1, "suppressed": 2, "error": 1}). */
export function decisionBreakdown(history: TelemetryHistoryRecord[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const h of history) {
		if (typeof h.decision === "string") out[h.decision] = (out[h.decision] ?? 0) + 1;
	}
	return out;
}

/**
 * Splits history records into plan-phase (before the plan-yolo-handoff
 * timestamp) and exec-phase (at or after it) by each record's `ts`. Records
 * without a `ts` are dropped from both buckets rather than guessed at. If
 * `handoffTs` is null, every timestamped record is treated as exec-phase,
 * except for a plan cell (`cellType: "plan"`): there a missing handoff means
 * the plan was never approved and the whole session ran in plan mode, so every
 * record goes to the plan phase and no timestamp is needed.
 */
export function splitHistoryByPhase(
	history: TelemetryHistoryRecord[],
	handoffTs: string | null,
	cellType?: CellType,
): { planPhase: TelemetryHistoryRecord[]; execPhase: TelemetryHistoryRecord[] } {
	if (cellType === "plan" && !handoffTs) return { planPhase: [...history], execPhase: [] };
	const planPhase: TelemetryHistoryRecord[] = [];
	const execPhase: TelemetryHistoryRecord[] = [];
	for (const h of history) {
		if (!h.ts) continue;
		(handoffTs && h.ts < handoffTs ? planPhase : execPhase).push(h);
	}
	return { planPhase, execPhase };
}

/** Every per-run count the report derives from the telemetry history, from one call. */
export interface HistorySummary {
	/** All review records, whatever the outcome. */
	reviewCount: number;
	/** Review records by decision (delivered / none / suppressed / error). */
	reviewDecisionCounts: Record<string, number>;
	/** Delivered notes by severity. */
	noteSeverityCounts: Record<string, number>;
	/** Delivered notes by channel. */
	noteChannelCounts: Record<string, number>;
	/** Suppressed reviews by reason. */
	noteSuppressedCounts: Record<string, number>;
	planPhaseSeverityCounts: Record<string, number>;
	execPhaseSeverityCounts: Record<string, number>;
}

/** Derives the run-row history fields. Pass the cell type (or `isPlanSession(notes) ? "plan" : "exec"`) so an unapproved plan cell is not filed under exec. */
export function summarizeHistory(
	history: TelemetryHistoryRecord[],
	handoffTs: string | null,
	cellType?: CellType,
): HistorySummary {
	const split = splitHistoryByPhase(history, handoffTs, cellType);
	return {
		reviewCount: history.length,
		reviewDecisionCounts: decisionBreakdown(history),
		noteSeverityCounts: severityBreakdown(history),
		noteChannelCounts: channelBreakdown(history),
		noteSuppressedCounts: suppressedBreakdown(history),
		planPhaseSeverityCounts: severityBreakdown(split.planPhase),
		execPhaseSeverityCounts: severityBreakdown(split.execPhase),
	};
}

function dropCount(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Whether the dumped history lost records. An explicit count is authoritative: the
 * dump's top-level `historyDropped`, else the reviewer's own `stats.historyDropped`
 * (the same counter, present whenever the reviewer is). Older dumps have neither and
 * came from a 50-record ring that evicts the oldest (plan-phase) records first, so a
 * history that reached the ring size is reported as truncated. Both are null without
 * telemetry.
 */
export function historyTruncation(t: TelemetryLog | null | undefined): {
	historyDropped: number | null;
	historyTruncated: boolean | null;
} {
	if (!t) return { historyDropped: null, historyTruncated: null };
	const dropped = dropCount(t.historyDropped) ?? dropCount(t.stats?.historyDropped);
	if (dropped !== null) return { historyDropped: dropped, historyTruncated: dropped > 0 };
	const length = Array.isArray(t.history) ? t.history.length : 0;
	return { historyDropped: null, historyTruncated: length >= LEGACY_HISTORY_CAP };
}

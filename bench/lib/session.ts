import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CellType } from "./telemetry";

export interface ReviewerNote {
	customType: string;
	timestamp: string | null;
	raw: unknown;
}

/** customTypes the extension's reviewer delivers its notes under (one per role). */
export const REVIEWER_NOTE_TYPES: readonly string[] = ["ai.typesafe.adversary", "ai.typesafe.advisory"];
/** customType of the ambiguity gate's own message; counted apart from reviewer notes. */
export const GATE_NOTE_TYPE = "ai.typesafe.ambiguity";
/** Written once per plan cell by omp when plan mode starts. */
export const PLAN_MODE_CONTEXT_TYPE = "plan-mode-context";
/** Marks the moment a plan is approved and execution begins. */
export const PLAN_YOLO_HANDOFF_TYPE = "plan-yolo-handoff";

/** True for a reviewer note, as opposed to omp's own custom messages (plan-mode-context, mid-run-todo-nudge, resolve-reminder, ...) or the gate's. */
export function isReviewerNoteType(customType: string): boolean {
	return REVIEWER_NOTE_TYPES.includes(customType);
}

/** Total of the reviewer-note entries in a customType-to-count map, ignoring every other customType. */
export function sumReviewerNotes(counts: Record<string, number> | null | undefined): number {
	let total = 0;
	for (const [customType, count] of Object.entries(counts ?? {})) {
		if (isReviewerNoteType(customType)) total += count;
	}
	return total;
}

/** How many ambiguity-gate messages the agent was shown. */
export function countGateNotes(notes: ReviewerNote[]): number {
	return notes.filter((n) => n.customType === GATE_NOTE_TYPE).length;
}

/** True if the session ran in plan mode, which omp marks with one `plan-mode-context` message per plan cell. */
export function isPlanSession(notes: ReviewerNote[]): boolean {
	return notes.some((n) => n.customType === PLAN_MODE_CONTEXT_TYPE);
}

/** Recursively find the newest .jsonl under a session-dir tree (encoded-cwd subdirs). */
export function findLatestSessionFile(sessionDir: string): string | null {
	const found: { path: string; mtime: number }[] = [];
	function walk(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(p);
			else if (e.endsWith(".jsonl")) found.push({ path: p, mtime: st.mtimeMs });
		}
	}
	walk(sessionDir);
	if (!found.length) return null;
	found.sort((a, b) => b.mtime - a.mtime);
	return found[0].path;
}

/**
 * Session JSONL: a fixed-width `title` record (omp pads it to 256 bytes, and
 * it may be missing), then one JSON object per line. Every line is standalone
 * JSON, so each is parsed on its own: no offset is assumed (a title with
 * multibyte characters, or no title at all, would shift a character slice
 * into the session header). The title record is skipped, and lines that fail
 * to parse (a truncated tail) are dropped rather than throwing.
 */
export function parseSessionEntries(path: string): unknown[] {
	const text = readFileSync(path, "utf8");
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue; // malformed/partial line
		}
		if (entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "title") continue;
		entries.push(entry);
	}
	return entries;
}

/**
 * Custom-message notes appear as `type: "custom_message"` in the session
 * JSONL, and as `role: "custom"` in `--mode json` stdout (confirmed by the
 * team); both carry a string `customType`. Accepts either shape. Returns every
 * custom message, omp's own included, because the plan-yolo-handoff marker is
 * one of them; use `isReviewerNoteType` to pick out the reviewer's notes.
 */
export function extractCustomMessages(entries: unknown[]): ReviewerNote[] {
	const out: ReviewerNote[] = [];
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		const rec = e as Record<string, unknown>;
		const isCustomMessage = rec.type === "custom_message" || rec.role === "custom";
		if (isCustomMessage && typeof rec.customType === "string") {
			out.push({
				customType: rec.customType,
				timestamp: typeof rec.timestamp === "string" ? rec.timestamp : null,
				raw: e,
			});
		}
	}
	return out;
}

/**
 * Finds the timestamp of the `plan-yolo-handoff` custom message, which marks
 * the moment a plan is approved and execution begins (confirmed by Phase 0).
 * Absent for exec-type cells and for plan cells that never reached approval.
 */
export function findPlanYoloHandoffTimestamp(notes: ReviewerNote[]): string | null {
	const handoff = notes.find((n) => n.customType === PLAN_YOLO_HANDOFF_TYPE);
	return handoff?.timestamp ?? null;
}

/**
 * Buckets reviewer notes into plan-phase (before the plan-yolo-handoff
 * timestamp) and exec-phase (at or after it) counts by customType. Only
 * reviewer notes are counted: omp's own custom messages and the ambiguity
 * gate's (see `countGateNotes`) are not notes the reviewer wrote.
 *
 * If `handoffTs` is null, every timestamped note is exec-phase and every
 * untimestamped note is dropped rather than guessed at, except for a plan
 * cell. A plan cell with no handoff never had its plan approved, so the whole
 * session ran in plan mode and every note goes to the plan phase. The cell
 * type is `cellType` when given, else inferred from the session's own
 * `plan-mode-context` message.
 */
export function splitNoteCountsByPhase(
	notes: ReviewerNote[],
	handoffTs: string | null,
	cellType?: CellType,
): { planPhaseNotes: Record<string, number>; execPhaseNotes: Record<string, number> } {
	const planPhaseNotes: Record<string, number> = {};
	const execPhaseNotes: Record<string, number> = {};
	const unapprovedPlan = !handoffTs && (cellType ?? (isPlanSession(notes) ? "plan" : "exec")) === "plan";
	for (const note of notes) {
		if (!isReviewerNoteType(note.customType)) continue;
		if (unapprovedPlan) {
			planPhaseNotes[note.customType] = (planPhaseNotes[note.customType] ?? 0) + 1;
			continue;
		}
		if (!note.timestamp) continue;
		const bucket = handoffTs && note.timestamp < handoffTs ? planPhaseNotes : execPhaseNotes;
		bucket[note.customType] = (bucket[note.customType] ?? 0) + 1;
	}
	return { planPhaseNotes, execPhaseNotes };
}

export interface UsageInfo {
	totalTokens: number;
	costUsd: number;
	messageCount: number;
}

function usageNumber(usage: Record<string, unknown>, key: string): number {
	const v = usage[key];
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * omp has no single session-summary usage event (confirmed: Phase 0 check 4).
 * Usage/cost is embedded per assistant message as `message.usage.totalTokens`
 * and `message.usage.cost.total`: on `type: "message"` entries in the session
 * JSONL, and on `type: "message_end"` events in `--mode json` stdout (hence
 * `entryType`). Sums across every matching entry. Returns null if none are
 * found (caller decides whether to try a fallback source).
 */
function sumUsageFromEntries(entries: unknown[], entryType: "message" | "message_end"): UsageInfo | null {
	let totalTokens = 0;
	let costUsd = 0;
	let messageCount = 0;
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		const rec = e as Record<string, unknown>;
		if (rec.type !== entryType) continue;
		const message = rec.message as Record<string, unknown> | undefined;
		if (!message || typeof message !== "object") continue;
		if (typeof message.role === "string" && message.role !== "assistant") continue;
		const usage = message.usage as Record<string, unknown> | undefined;
		if (!usage || typeof usage !== "object") continue;
		totalTokens +=
			typeof usage.totalTokens === "number"
				? usage.totalTokens
				: usageNumber(usage, "input") + usageNumber(usage, "output") + usageNumber(usage, "cacheRead") + usageNumber(usage, "cacheWrite");
		const cost = usage.cost as Record<string, unknown> | undefined;
		if (typeof cost?.total === "number") costUsd += cost.total;
		messageCount++;
	}
	return messageCount > 0 ? { totalTokens, costUsd, messageCount } : null;
}

/** Sums usage across the assistant `message` entries of the session JSONL (preferred source). */
export function usageFromSessionEntries(entries: unknown[]): UsageInfo | null {
	return sumUsageFromEntries(entries, "message");
}

/** Sums usage across `message_end` events in `--mode json` stdout (NDJSON), used when no session file was found. */
export function usageFromStdout(stdout: string): UsageInfo | null {
	const entries: unknown[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// stdout may include non-JSON lines; skip them
		}
	}
	return sumUsageFromEntries(entries, "message_end");
}

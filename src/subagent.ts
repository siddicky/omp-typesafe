import { dirname, resolve } from "node:path";
import { subagentGuardEnabled } from "./config";
import type { HostContext } from "./host";

/**
 * omp runs this extension's factory again for every subagent session (the task tool, eval `agent()`, dag
 * workers, critics, scouts, `/tan` clones) and fires the same hooks inside it. Subagents that share the parent's
 * process share this extension's module state too, so left alone a subagent's session_start would wipe the
 * parent's gate and review state, its before_agent_start would plant its own prompt as the plan's objective, and
 * its shutdown would overwrite the bench log. index.ts therefore routes every hook through skipSubagent, which
 * makes the extension dormant in any session that is not the main one.
 */

/**
 * Is this the context of a subagent session?
 *
 * `ctx.agent` is the host's own answer, a non-enumerable property (`Object.keys(ctx)` does not list it), so it is
 * read by name. `kind: "sub"` is what the host says to check (a `/tan` clone is a subagent at depth 0), `depth > 0`
 * is the older shape of the same fact, and `kind: "main"` is final: a session forked from the main one records its
 * origin as `parentSession` too and must not be mistaken for a subagent. Only a host with no usable `ctx.agent`
 * falls back to the session header (see viaHeader). A host that offers neither is treated as main.
 */
export function isSubagentCtx(ctx: HostContext | undefined): boolean {
	try {
		const agent = ctx?.agent;
		if (agent !== null && typeof agent === "object") {
			if (agent.kind === "sub") return true;
			if (typeof agent.depth === "number" && agent.depth > 0) return true;
			if (agent.kind === "main") return false;
		}
		return viaHeader(ctx);
	} catch {
		// A getter that throws is a host this guard cannot read: stay active rather than silence the session.
		return false;
	}
}

/**
 * The fallback for a host without `ctx.agent`: the session header's `parentSession`. A subagent's session file
 * sits in a directory named after its parent's file (`<parent stem>/<agent id>.jsonl`), while a fork's sits beside
 * its parent's, so with a session file to compare the header only counts when the two agree. With no file to
 * look at, the header alone decides.
 */
function viaHeader(ctx: HostContext | undefined): boolean {
	const manager = ctx?.sessionManager;
	const parent = manager?.getHeader?.()?.parentSession;
	if (typeof parent !== "string" || parent === "") return false;
	const file = manager?.getSessionFile?.();
	if (typeof file !== "string" || file === "") return true;
	return resolve(dirname(file)) === resolve(parent.replace(/\.jsonl$/, ""));
}

export interface SubagentStats {
	/** Distinct subagent sessions that had a hook skipped. */
	sessions: number;
	/** Hook invocations skipped, across all of them. */
	hookCalls: number;
}

/** How many session keys are remembered to tell a new subagent session from one already counted. */
const MAX_TRACKED_SESSIONS = 256;

/**
 * The counters live on `globalThis`, under a registry symbol, and not in this module. An isolated (worktree) agent
 * runs a fresh copy of the whole module graph, which would otherwise keep a counter of its own that the parent's
 * `/adversary status` and bench log never see. The copies still share one process, and so one `globalThis`.
 */
const STATS_KEY = Symbol.for("omp-typesafe.subagentStats");

interface Tracker {
	sessions: number;
	hookCalls: number;
	seen: Set<string>;
}

function isTracker(value: unknown): value is Tracker {
	return typeof value === "object" && value !== null && typeof (value as Tracker).sessions === "number" && typeof (value as Tracker).hookCalls === "number" && (value as Tracker).seen instanceof Set;
}

function tracker(): Tracker {
	const holder = globalThis as unknown as Record<symbol, unknown>;
	const found = holder[STATS_KEY];
	if (isTracker(found)) return found;
	const created: Tracker = { sessions: 0, hookCalls: 0, seen: new Set() };
	holder[STATS_KEY] = created;
	return created;
}

/** What names one subagent session: its own id, else the host's agent id, else the file it lives in. */
function sessionKey(ctx: HostContext | undefined): string {
	try {
		const id: unknown = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id !== "") return id;
	} catch {
		// fall through to the next name
	}
	const agentId = ctx?.agent?.id;
	if (typeof agentId === "string" && agentId !== "") return `agent:${agentId}`;
	return `file:${ctx?.sessionManager?.getSessionFile?.() ?? "unknown"}`;
}

function noteSkipped(ctx: HostContext | undefined): void {
	const stats = tracker();
	stats.hookCalls += 1;
	const key = sessionKey(ctx);
	if (stats.seen.has(key)) return;
	stats.sessions += 1;
	stats.seen.add(key);
	// Oldest first out: an evicted id that shows up again would be counted twice, which a bounded set accepts.
	if (stats.seen.size > MAX_TRACKED_SESSIONS) stats.seen.delete(stats.seen.values().next().value as string);
}

export function getSubagentStats(): SubagentStats {
	const { sessions, hookCalls } = tracker();
	return { sessions, hookCalls };
}

export function resetSubagentStats(): void {
	const stats = tracker();
	stats.sessions = 0;
	stats.hookCalls = 0;
	stats.seen.clear();
}

/**
 * True when a hook must do nothing because the session is a subagent's, and counts the skip. False for the main
 * session, and for everything when TYPESAFE_SUBAGENT_GUARD switches the guard off (the environment is read on
 * every call, so the switch holds in an agent whose module state, config included, was never loaded).
 */
export function skipSubagent(ctx: HostContext | undefined): boolean {
	if (!subagentGuardEnabled() || !isSubagentCtx(ctx)) return false;
	try {
		noteSkipped(ctx);
	} catch {
		// Counting is telemetry: whatever the host's getters do, it must not decide whether the hook runs.
	}
	return true;
}

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "./client";
import { agentDir } from "./config";
import type { CompactionSettings } from "./config";
import { isRecord, sanitizeValue } from "./text";
import { compact } from "./vendor/fast-jev/compact";
import { goalFromMessages } from "./vendor/fast-jev/state";
import type { CompactOptions, JevAnswer, JevCacheKeys, JevQuestions, JevResponse, JevState, Message, ToolResult, ToolUse } from "./vendor/fast-jev/types";

/**
 * Verbatim context reduction, ported from jerryfane/omp-jev-compaction (MIT) onto this extension's client and config.
 * The scoring core is vendored under src/vendor/fast-jev (see UPSTREAM_COMMIT there). Nothing is rewritten or
 * summarized: every tool call and result is scored by Jev, and the results it says are no longer needed are cut to a short
 * head and a note naming the file that holds the rest. omp's `context` event replaces the messages of one request, so the
 * session on disk is never touched and a wrong judgement costs one turn.
 */

// ---- omp message mapping ---------------------------------------------------------------------------------

/** The parts of omp's AgentMessage this module reads, declared structurally (packages/ai/src/types.ts). */
export interface OmpMessage {
	role: string;
	content?: unknown;
}

/** omp's assistant tool-call part: `id`, `name`, `arguments`; the separate toolResult message says `toolCallId`/`toolName`. */
interface OmpToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

interface OmpToolResultMessage extends OmpMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: { type: string; text?: string }[];
	isError?: boolean;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/**
 * A tool result's text. mapOmpMessages (what Jev scores) and buildReplacements (what is compared with the text the core
 * kept) must read it the same way, or an untouched result that also holds an image looks changed and gets parked.
 */
function resultText(message: OmpToolResultMessage): string {
	const parts: unknown[] = Array.isArray(message.content) ? message.content : [];
	return parts
		.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

/**
 * Folds omp's message stream into the scoring core's shape. omp files a tool result as its own `toolResult` message, while
 * the core expects the results to hang off the following user message, paired by id.
 */
export function mapOmpMessages(source: readonly OmpMessage[]): Message[] {
	const messages: Message[] = [];
	const pending: ToolResult[] = [];

	const flushResults = (): void => {
		if (pending.length === 0) return;
		messages.push({ role: "user", text: "", toolUses: [], toolResults: [...pending] });
		pending.length = 0;
	};

	for (const message of source) {
		if (message.role === "toolResult") {
			const result = message as OmpToolResultMessage;
			pending.push({ tool_use_id: result.toolCallId, text: resultText(result), isError: result.isError === true });
		} else if (message.role === "assistant") {
			flushResults();
			const content = Array.isArray(message.content) ? message.content : [];
			const toolUses: ToolUse[] = content
				.filter((part): part is OmpToolCall => isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string")
				.map((part) => ({ tool_use_id: part.id, tool: part.name, input: part.arguments ?? {} }));
			messages.push({ role: "assistant", text: textOf(content), toolUses });
		} else if (message.role === "user" || message.role === "developer") {
			flushResults();
			messages.push({ role: "user", text: textOf(message.content), toolUses: [] });
		}
	}

	flushResults();
	return messages;
}

/** Characters in a transcript, for the minimum-size check and the reduction figure. */
export function transcriptChars(messages: readonly Message[]): number {
	let total = 0;
	for (const message of messages) {
		total += message.text.length;
		for (const use of message.toolUses) total += use.tool.length + JSON.stringify(use.input ?? {}).length;
		for (const result of message.toolResults ?? []) total += result.text.length;
	}
	return total;
}

// ---- spill: dropped output stays one `read` away -----------------------------------------------------------

/**
 * Reduction without recovery is a hole: upstream measured a reduced context answering 63-75% of questions that the full
 * context answered 100% of. Writing the payload to a plain file and naming it in the note turns a permanent loss into one
 * `read` call, using the agent's own tool rather than a scheme it would have to be taught.
 */
export function spillDir(): string {
	return join(agentDir(), "jev-spill");
}

export interface SpillOptions {
	dir?: string;
	/** Characters of the head kept inline before the pointer. */
	headChars?: number;
}

export interface SpilledPayload {
	path: string;
	chars: number;
	/** The replacement text: head, then where to get the rest. */
	notice: string;
}

/** Writes `text` to a content-addressed file and returns the note to show instead; identical payloads share one file. */
export function spillPayload(text: string, options: SpillOptions = {}): SpilledPayload {
	const dir = options.dir ?? spillDir();
	const headChars = options.headChars ?? 300;

	// A payload no bigger than the head plus the notice saves nothing: parking it would make a longer replacement.
	if (text.length <= headChars + 160) return { path: "", chars: text.length, notice: text };

	const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
	const path = join(dir, `${digest}.txt`);
	// Raw tool output (an .env that was cat'ed, a token in a log): readable by the owner only.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(path, text, { mode: 0o600 });

	const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
	return {
		path,
		chars: text.length,
		notice: `${head}[jev elided ${text.length - headChars} of ${text.length} chars of this tool result. The full output is still available: read ${path}]`,
	};
}

/** True when the text is one of our notices, so a second pass does not spill a pointer as if it were a payload. */
export function isSpillNotice(text: string): boolean {
	return text.includes("[jev elided ") && text.includes("read ");
}

// ---- cache guard (non-sticky mode) -------------------------------------------------------------------------

/** omp's `Usage`, as attached to each assistant message; only the two fields the guard needs. */
interface OmpUsage {
	input?: number;
	cacheRead?: number;
}

export interface CacheVerdict {
	/** True when reduction should be skipped. */
	skip: boolean;
	cacheShare: number;
	input: number;
	cacheRead: number;
	reason: "no-usage" | "cache-dominated" | "paying-full-price";
}

/**
 * Is the session already cheap because the provider serves its context from cache? Reduction rewrites the start of the
 * conversation, which invalidates the prefix cache, so on a cache-dominated session it turns a cheap request into a
 * full-price one and saves nothing. Upstream measured 13 of 14 live sessions at 98-100% cache hits ($0.05-$0.40 a
 * request) and one at 6% ($2.87).
 */
export function judgeCache(messages: readonly OmpMessage[], ceiling: number): CacheVerdict {
	let usage: OmpUsage | undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		// omp attaches `usage` to assistant messages; the structural OmpMessage does not declare it.
		const candidate = messages[index] as OmpMessage & { usage?: OmpUsage };
		if (candidate.role !== "assistant" || !candidate.usage) continue;
		if ((candidate.usage.input ?? 0) + (candidate.usage.cacheRead ?? 0) === 0) continue;
		usage = candidate.usage;
		break;
	}
	// No billing evidence: reduce, because an unmeasured session is more likely a fresh expensive one than a cached cheap one.
	if (!usage) return { skip: false, cacheShare: 0, input: 0, cacheRead: 0, reason: "no-usage" };

	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheShare = cacheRead / (input + cacheRead);
	return cacheShare >= ceiling
		? { skip: true, cacheShare, input, cacheRead, reason: "cache-dominated" }
		: { skip: false, cacheShare, input, cacheRead, reason: "paying-full-price" };
}

// ---- asking Jev ----------------------------------------------------------------------------------------------

/** A Jev asker that can be cancelled: the scoring core's `JevAsker` plus the signal that bounds one rewrite. */
export interface SignalAsker {
	ask(state: JevState, questions: JevQuestions, cacheKeys?: JevCacheKeys, signal?: AbortSignal): Promise<JevResponse>;
}

/**
 * Asks through src/client.ts, so usage, model resolution, retry and 429 handling stay in one place. The state is the
 * conversation: it is masked (or only repaired, with `adversary.redact` off) before it leaves, like every other payload.
 * No retries: a failed pass falls back to the unreduced context and the next request tries again.
 */
export function clientAsker(options: { timeoutMs: number; redact: boolean }): SignalAsker {
	return {
		async ask(state, questions, _cacheKeys, signal) {
			const sent = sanitizeValue(state, options.redact);
			const { result } = await ask(sent as Parameters<typeof ask>[0], questions as Parameters<typeof ask>[1], {
				timeoutMs: options.timeoutMs,
				maxRetries: 0,
				signal,
			});
			return { model: result.model, answers: result.answers as unknown as JevResponse["answers"] };
		},
	};
}

function digest(value: unknown): string | undefined {
	try {
		return createHash("sha256")
			.update(JSON.stringify(value) ?? "undefined")
			.digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * Reuses answers only for an exact Jev state and original tool-call identity. Question names such as `call_t1` are
 * temporary: every pass and every window numbers calls from `t1` again, so every key includes the digest of the state and
 * of the original call, input, result and error flag. A bounded LRU keeps cross-window reuse without unbounded memory.
 * A state that cannot be serialized bypasses the cache.
 */
export class CachingAsker implements SignalAsker {
	readonly cache = new Map<string, JevAnswer>();
	asks = 0;
	answered = 0;

	constructor(
		private readonly inner: SignalAsker,
		private readonly maxEntries = 4_096,
	) {}

	private cached(key: string): JevAnswer | undefined {
		const answer = this.cache.get(key);
		if (!answer) return undefined;
		this.cache.delete(key);
		this.cache.set(key, answer);
		return answer;
	}

	private remember(key: string, answer: JevAnswer): void {
		this.cache.delete(key);
		this.cache.set(key, answer);
		while (this.cache.size > this.maxEntries) {
			const oldest = this.cache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	async ask(state: JevState, questions: JevQuestions, cacheKeys: JevCacheKeys = {}, signal?: AbortSignal): Promise<JevResponse> {
		const stateIdentity = digest(state);
		if (!stateIdentity) {
			const fresh = await this.inner.ask(state, questions, cacheKeys, signal);
			this.asks += 1;
			return fresh;
		}

		const missing: JevQuestions = {};
		const missingKeys: Record<string, string> = {};
		const pendingKeys: Record<string, string> = {};
		const answers: Record<string, JevAnswer> = {};
		for (const [name, question] of Object.entries(questions)) {
			const identity = cacheKeys[name] ?? digest(question);
			if (!identity) {
				missing[name] = question;
				continue;
			}
			const key = `${stateIdentity}:${name}:${identity}`;
			const cached = this.cached(key);
			if (cached) {
				answers[name] = cached;
				this.answered += 1;
			} else {
				missing[name] = question;
				missingKeys[name] = identity;
				pendingKeys[name] = key;
			}
		}
		if (Object.keys(missing).length > 0) {
			const fresh = await this.inner.ask(state, missing, missingKeys, signal);
			this.asks += 1;
			for (const [name, answer] of Object.entries(fresh.answers)) {
				const key = pendingKeys[name];
				if (key) this.remember(key, answer);
				answers[name] = answer;
			}
		}
		return { answers };
	}
}

// ---- the reducer ---------------------------------------------------------------------------------------------

/** Roughly 15k tokens of state per window, inside Jev's 32k window. */
const MAX_WINDOW_CHARS = 60_000;
/**
 * Everything one rewrite may spend asking Jev. omp abandons an extension's handler after 30 s
 * (EXTENSION_HANDLER_TIMEOUT_MS); stopping first lets the rewrite fail cleanly, and the answers already received stay cached
 * for the next request.
 */
export const REWRITE_BUDGET_MS = 25_000;

/**
 * `allowDroppingCalls` is not offered: the decisions are applied to omp's messages by tool-call id and only ever replace a
 * tool result's text, so a call record is never erased, whatever Jev says about the call.
 */
export interface ContextReducerSettings extends Omit<CompactOptions, "allowDroppingCalls"> {
	/** Park dropped payloads on disk and name the file. Default on. */
	spill?: SpillOptions & { enabled?: boolean };
	maxWindowChars?: number;
	/** Not sticky: skip sessions whose last request was at least this share cache reads. Default 0.8. */
	cacheCeiling?: number;
	onSkip?: (verdict: CacheVerdict) => void;
	/** Reduce rarely and re-emit the same decisions in between, so the provider's prompt cache keeps hitting. Default on. */
	sticky?: boolean;
	/** Re-score once the context has grown by this share since the last rewrite. Default 0.4. */
	rewriteGrowth?: number;
	/** Never rewrite more often than this, in requests, whatever the growth. Default 15. */
	minRequestsBetweenRewrites?: number;
	/** Re-score at least this often, in requests. Default 40. */
	maxRequestsBetweenRewrites?: number;
	onReuse?: (info: { chars: number; replacements: number; requestsSinceRewrite: number }) => void;
	/** Only reduce once the context is this big (characters). Default 150000. */
	minChars?: number;
	/** Milliseconds one rewrite may spend asking Jev. Default REWRITE_BUDGET_MS. */
	budgetMs?: number;
	onStats?: (stats: { before: number; after: number; asks: number; cached: number; dropped: number; windows: number; rewrites: number }) => void;
}

/** Reduces one request's messages, or returns undefined to leave them alone (context too small, or Jev kept everything). */
export type ContextReducer = (messages: readonly OmpMessage[]) => Promise<OmpMessage[] | undefined>;

/**
 * Splits history into consecutive windows without separating a tool call from its result: a boundary only lands where the
 * next message starts a new assistant turn, so pairing by id still resolves inside one window.
 */
export function splitIntoWindows<T extends { role: string; toolResults?: unknown[] }>(messages: readonly T[], maxChars: number): T[][] {
	const windows: T[][] = [];
	let current: T[] = [];
	let size = 0;
	for (const message of messages) {
		const chars = JSON.stringify(message).length;
		const wouldSplitPair = message.role === "user" && (message.toolResults?.length ?? 0) > 0;
		if (current.length > 0 && size + chars > maxChars && !wouldSplitPair) {
			windows.push(current);
			current = [];
			size = 0;
		}
		current.push(message);
		size += chars;
	}
	if (current.length > 0) windows.push(current);
	return windows;
}

/**
 * The decisions as `toolCallId -> replacement text`. Only tool results are rewritten, and only the ones Jev let go. A
 * rewritten result parks its full payload on disk and names the file, so the reduction is reversible with one `read`.
 */
export function buildReplacements(
	original: readonly OmpMessage[],
	kept: readonly { toolResults?: { tool_use_id: string; text: string }[]; toolUses: { tool_use_id: string }[] }[],
	spill: SpillOptions & { enabled?: boolean } = {},
): Map<string, string> {
	const keptResultText = new Map<string, string>();
	for (const message of kept) {
		for (const result of message.toolResults ?? []) keptResultText.set(result.tool_use_id, result.text);
	}

	const replacements = new Map<string, string>();
	for (const message of original) {
		if (message.role !== "toolResult") continue;
		const result = message as OmpToolResultMessage;
		const current = resultText(result);
		const replacement = keptResultText.get(result.toolCallId);
		if (replacement !== undefined && replacement === current) continue; // untouched

		const fallback = replacement ?? "[jev: result dropped; re-run the tool if needed]";
		if (spill.enabled === false || !current || isSpillNotice(current)) {
			if (fallback !== current) replacements.set(result.toolCallId, fallback);
			continue;
		}
		try {
			replacements.set(result.toolCallId, spillPayload(current, spill).notice);
		} catch {
			// A read-only or full disk must not cost the turn.
			if (fallback !== current) replacements.set(result.toolCallId, fallback);
		}
	}
	return replacements;
}

/**
 * The messages with the recorded replacements applied. Every other message object passes through by reference, and a
 * replacement is always the same string for the same call, which is what keeps the prefix stable between rewrites.
 */
export function applyReplacements(messages: readonly OmpMessage[], replacements: ReadonlyMap<string, string>): OmpMessage[] {
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const result = message as OmpToolResultMessage;
		const replacement = replacements.get(result.toolCallId);
		if (replacement === undefined) return message;
		return { ...result, content: [{ type: "text", text: replacement }] };
	});
}

/** What a rewrite decided, kept between rewrites so the covered prefix comes back byte-identical. */
interface StickyState {
	/** toolCallId -> the exact replacement text emitted last rewrite. */
	replacements: Map<string, string>;
	baselineChars: number;
	requestsSinceRewrite: number;
	rewrites: number;
}

/**
 * Builds a per-request reducer for the `context` event. Rewriting the context invalidates the provider's prompt cache and a
 * cache write only pays back over tens of requests, so decisions are remembered: between rewrites the same replacement map is
 * re-applied and anything newer passes through untouched. A rewrite happens when the context has grown past `rewriteGrowth`
 * and at least `minRequestsBetweenRewrites` requests have passed, or after `maxRequestsBetweenRewrites` regardless.
 */
export function createContextReducer(asker: SignalAsker, settings: ContextReducerSettings = {}): ContextReducer {
	const cachingAsker = asker instanceof CachingAsker ? asker : new CachingAsker(asker);
	const sticky = settings.sticky !== false;
	const growth = settings.rewriteGrowth ?? 0.4;
	const minBetween = settings.minRequestsBetweenRewrites ?? 15;
	const maxBetween = settings.maxRequestsBetweenRewrites ?? 40;
	const budgetMs = settings.budgetMs ?? REWRITE_BUDGET_MS;
	let state: StickyState | undefined;

	return async function reduceContext(messages: readonly OmpMessage[]): Promise<OmpMessage[] | undefined> {
		const mapped = mapOmpMessages(messages);
		const before = transcriptChars(mapped);
		if (before < (settings.minChars ?? 150_000)) return undefined;

		// Without stickiness every request rewrites the prefix. Measured at Opus prices a 420k-token session costs $0.63
		// cached and $7.68 rewritten every request, so a cache-served session is only touched when rewrites are rare.
		if (!sticky) {
			const verdict = judgeCache(messages, settings.cacheCeiling ?? 0.8);
			if (verdict.skip) {
				settings.onSkip?.(verdict);
				return undefined;
			}
		}

		const grownPastThreshold = state !== undefined && before > state.baselineChars * (1 + growth);
		const mustRewrite = state === undefined || (grownPastThreshold && state.requestsSinceRewrite >= minBetween) || state.requestsSinceRewrite >= maxBetween;
		if (state && !mustRewrite) {
			state.requestsSinceRewrite += 1;
			const reused = applyReplacements(messages, state.replacements);
			settings.onReuse?.({ chars: before, replacements: state.replacements.size, requestsSinceRewrite: state.requestsSinceRewrite });
			return reused;
		}

		const windows = splitIntoWindows(mapped, settings.maxWindowChars ?? MAX_WINDOW_CHARS);
		// Two properties of the whole conversation, not of one window. The core derives the goal (the last three user prompts)
		// from the messages it is given, and every window after the first holds none of them, only the sentinel below, so Jev
		// would score it without the task. It also pins the last `preserveRecentMessages` of each window it scores, so the
		// newest messages are shared out from the end of the conversation: only the newest N overall stay untouched.
		const goal = settings.goal ?? goalFromMessages(mapped);
		let recent = settings.preserveRecentMessages ?? 6;
		const preserve = windows.map(() => 0);
		for (let w = windows.length - 1; w >= 0 && recent > 0; w--) {
			preserve[w] = Math.min(recent, windows[w].length);
			recent -= preserve[w];
		}
		const keptAll: Message[] = [];
		let dropped = 0;
		const controller = new AbortController();
		const timeoutController = new AbortController();
		const timeoutSignal = timeoutController.signal;
		const signal = AbortSignal.any([controller.signal, timeoutSignal]);
		const timer = setTimeout(() => timeoutController.abort(new DOMException("The operation timed out", "TimeoutError")), budgetMs);
		const scoped: SignalAsker = { ask: (s, q, k) => cachingAsker.ask(s, q, k, signal) };
		try {
			for (const [w, window] of windows.entries()) {
				// The core always pins index 0 (the first message). A window frequently begins with the assistant message
				// that holds every tool call, which would pin the whole window; a sentinel takes index 0 and is dropped again.
				const sentinel: Message = { role: "user", text: "(start of this stretch of history)", toolUses: [] };
				const result = await compact([sentinel, ...window], scoped, {
					goal,
					keepThreshold: settings.keepThreshold,
					preserveRecentMessages: preserve[w],
					maxStateTokens: settings.maxStateTokens,
					maxRequestTokens: settings.maxRequestTokens,
					truncateHeadChars: settings.truncateHeadChars,
				});
				dropped += result.stats.resultsDropped + result.stats.callsDropped;
				keptAll.push(...result.messages.filter((message) => message !== sentinel));
			}
		} catch (err) {
			if (timeoutSignal.aborted) throw new Error(`scoring did not finish within ${budgetMs} ms`, { cause: err });
			throw err;
		} finally {
			clearTimeout(timer);
			controller.abort();
		}

		const replacements = buildReplacements(messages, keptAll, { ...settings.spill, headChars: settings.truncateHeadChars ?? settings.spill?.headChars });
		// Decisions already taken stay in force, so an earlier rewrite's text is never regenerated with a different notice.
		if (state) for (const [id, text] of state.replacements) if (!replacements.has(id)) replacements.set(id, text);

		const out = applyReplacements(messages, replacements);
		const after = transcriptChars(mapOmpMessages(out));
		state = { replacements, baselineChars: before, requestsSinceRewrite: 0, rewrites: (state?.rewrites ?? 0) + 1 };

		settings.onStats?.({ before, after, asks: cachingAsker.asks, cached: cachingAsker.answered, dropped, windows: windows.length, rewrites: state.rewrites });
		if (replacements.size === 0) return undefined;
		return out;
	};
}

/**
 * The reducer the extension registers on `context`: configured from `compaction`, asking through src/client.ts. A fresh one per
 * session, because the sticky decisions belong to one conversation.
 */
export function createCompactor(cfg: CompactionSettings, options: { redact: boolean; log?: (message: string) => void }): ContextReducer {
	const log = options.log;
	return createContextReducer(clientAsker({ timeoutMs: cfg.timeoutMs, redact: options.redact }), {
		keepThreshold: cfg.keepThreshold,
		minChars: cfg.minChars,
		spill: { enabled: cfg.spill },
		preserveRecentMessages: cfg.preserveRecent,
		sticky: cfg.sticky,
		rewriteGrowth: cfg.rewriteGrowth,
		minRequestsBetweenRewrites: cfg.minRequestsBetweenRewrites,
		maxRequestsBetweenRewrites: cfg.maxRequestsBetweenRewrites,
		cacheCeiling: cfg.cacheCeiling,
		onSkip: (verdict) =>
			log?.(`[typesafe] context compaction skipped: ${verdict.reason} (cacheRead=${verdict.cacheRead} input=${verdict.input}, ${Math.round(verdict.cacheShare * 100)}% from cache)`),
		onStats: (stats) =>
			log?.(
				`[typesafe] context compaction: ${stats.before}->${stats.after} chars, dropped=${stats.dropped}, windows=${stats.windows}, asks=${stats.asks}, cacheHits=${stats.cached}, rewrites=${stats.rewrites}`,
			),
	});
}

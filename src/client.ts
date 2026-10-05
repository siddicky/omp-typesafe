import {
	APIConnectionError,
	APIError,
	APIUserAbortError,
	APITimeoutError,
	RateLimitError,
	TypeSafeClient,
	TypeSafeError,
	choice,
	noul,
	score,
} from "@typesafe-ai/sdk";
import type { EntryType, Logger, Questions } from "@typesafe-ai/sdk";
import { getConfig } from "./config";

/**
 * SDK wrapper. All TypeSafe traffic goes through here so usage tracking,
 * model resolution and error classification stay in one place.
 */

let client: TypeSafeClient | null = null;
/** Configuration and credentials the cached client was built with; changes rebuild the client. */
let clientModel: string | null = null;
let clientApiKey: string | undefined;
let clientBaseURL: string | undefined;
/** Account/endpoint-scoped: model changes must not bypass an insufficient-credit response. */
let creditCooldown: { apiKey: string | undefined; baseURL: string | undefined; error: APIError; until: number } | null = null;
let clientError: string | null = null;

/** omp's extension logger: every method optional, extra args passed through. */
export interface ClientLogger {
	debug?(message: string, ...args: unknown[]): void;
	info?(message: string, ...args: unknown[]): void;
	warn?(message: string, ...args: unknown[]): void;
	error?(message: string, ...args: unknown[]): void;
}

let sdkLogger: ClientLogger | undefined;

/**
 * Send SDK log output to omp's logger instead of the console, which is the omp TUI. Late-bound, so it
 * takes effect for an already cached client.
 */
export function setClientLogger(logger: ClientLogger | undefined): void {
	sdkLogger = logger;
}

const routedLogger: Logger = {
	debug: (message, ...args) => sdkLogger?.debug?.(`[typesafe sdk] ${message}`, ...args),
	info: (message, ...args) => sdkLogger?.info?.(`[typesafe sdk] ${message}`, ...args),
	warn: (message, ...args) => sdkLogger?.warn?.(`[typesafe sdk] ${message}`, ...args),
	error: (message, ...args) => sdkLogger?.error?.(`[typesafe sdk] ${message}`, ...args),
};

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	requests: number;
}

const usage: SessionUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };
let lastResolvedModel: string | null = null;

/** Per-request pricing: $0.042 per Mtok input, output free. */
const INPUT_USD_PER_MTOK = 0.042;

export function apiKeyPresent(): boolean {
	return !!process.env.TYPESAFE_API_KEY?.trim();
}

/**
 * The shared client, built with the configured model as its default. A per-call model override never
 * reaches the cache (ask() puts it in the request body), so one bad override cannot poison later
 * calls. `logLevel` is pinned: left to the SDK it would follow TYPESAFE_LOG_LEVEL, where "debug" dumps
 * every request body (task text, diffs) into the terminal and an invalid value makes this throw.
 */
export function getClient(): TypeSafeClient {
	const model = getConfig().model;
	const apiKey = process.env.TYPESAFE_API_KEY?.trim() || undefined;
	const baseURL = (process.env.TYPESAFE_BASE_URL?.trim() || undefined)?.replace(/\/+$/, "");
	if (client && clientModel === model && clientApiKey === apiKey && clientBaseURL === baseURL) return client;
	try {
		client = new TypeSafeClient({ defaultModel: model, logLevel: "warn", logger: routedLogger });
		clientModel = model;
		clientApiKey = apiKey;
		clientBaseURL = baseURL;
		clientError = null;
	} catch (err) {
		client = null;
		clientModel = null;
		clientApiKey = undefined;
		clientBaseURL = undefined;
		clientError = describeError(err);
		throw err;
	}
	return client;
}

/** Why the last attempt to construct the SDK client failed, or null; for /adversary status. */
export function getClientError(): string | null {
	return clientError;
}

export function resetClient(): void {
	client = null;
	clientModel = null;
	clientApiKey = undefined;
	clientBaseURL = undefined;
	creditCooldown = null;
	clientError = null;
	lastResolvedModel = null;
}

export function getSessionUsage(): SessionUsage {
	return { ...usage };
}

export function resetUsage(): void {
	usage.inputTokens = 0;
	usage.outputTokens = 0;
	usage.requests = 0;
}

export function estimateCostUsd(): number {
	return (usage.inputTokens * INPUT_USD_PER_MTOK) / 1_000_000;
}

export function getLastResolvedModel(): string | null {
	return lastResolvedModel;
}

export interface AskOptions {
	/** Per-attempt timeout in ms. SDK default is 10000. */
	timeoutMs?: number;
	maxRetries?: number;
	/** Model override for this request only (sent in the body); omitted means the configured model. */
	model?: string;
	/** Hard cap in ms on the whole call including retries. Defaults to retryBudgetMs(). */
	budgetMs?: number;
	/** Caller cancellation, e.g. the tool call's abort signal; surfaces as APIUserAbortError ("aborted"). */
	signal?: AbortSignal;
}

/** Longest single wait between attempts: a Retry-After up to this is honored, a longer one ends the call. */
const MAX_RETRY_WAIT_MS = 5_000;
const BUDGET_SLACK_MS = 300;
/** Wait before the first retry of a 429 that names no Retry-After; doubled for each further one. */
const RATE_LIMIT_BACKOFF_MS = 500;
/**
 * The statuses the SDK retries by default (408 and 5xx) without 429. The SDK would answer a 429 whose Retry-After is
 * longer than maxRetryAfterMs with its own short backoff, hammering a rate-limited endpoint; ask() handles it instead.
 */
const SDK_RETRY_STATUSES: ReadonlySet<number> = new Set([408, ...Array.from({ length: 100 }, (_, i) => 500 + i)]);

/** Wait `ms`, ending early with APIUserAbortError when `signal` aborts, the way the SDK's own retry wait does. */
function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(new APIUserAbortError(undefined, { cause: signal.reason }));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

/** Worst case for one call: every attempt times out and every retry waits the maximum. */
export function retryBudgetMs(timeoutMs: number, maxRetries: number): number {
	const retries = Math.max(0, Math.trunc(maxRetries));
	return timeoutMs * (retries + 1) + retries * MAX_RETRY_WAIT_MS + BUDGET_SLACK_MS;
}

export interface WireAnswer {
	type: string;
	[key: string]: unknown;
}

export interface AskResult {
	result: {
		model: string;
		answers: Record<string, WireAnswer>;
		usage: { input_tokens: number; output_tokens: number };
	};
	requestId: string | undefined;
}

/**
 * One systemOne call. `state` may be a string, object, or array.
 * Timeouts are per attempt; the whole call, retries included, is bounded by `budgetMs`. A budget
 * expiry is reported as APITimeoutError, not as the APIUserAbortError the SDK raises for any abort.
 */
export async function ask(
	state: EntryType,
	questions: Questions,
	opts: AskOptions = {},
): Promise<AskResult> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const maxRetries = opts.maxRetries ?? 0;
	const budgetMs = opts.budgetMs ?? retryBudgetMs(timeoutMs, maxRetries);
	const caller = opts.signal;
	const controller = new AbortController();
	let budgetExpired = false;
	const timer = setTimeout(() => {
		budgetExpired = true;
		controller.abort();
	}, budgetMs);
	const onCallerAbort = () => controller.abort(caller?.reason);
	if (caller?.aborted) onCallerAbort();
	else caller?.addEventListener("abort", onCallerAbort, { once: true });
	try {
		// A 429 is retried here, not by the SDK: only when it names a wait the caller can afford, within maxRetries.
		for (let rateLimited = 0; ; rateLimited++) {
			if (controller.signal.aborted) throw new APIUserAbortError(undefined, { cause: controller.signal.reason });
			const sdkClient = getClient();
			const apiKey = clientApiKey;
			const baseURL = clientBaseURL;
			if (creditCooldown && creditCooldown.apiKey === apiKey && creditCooldown.baseURL === baseURL && Date.now() < creditCooldown.until) {
				throw creditCooldown.error;
			}
			try {
				const promise = sdkClient.systemOne(
					{ state, questions, ...(opts.model ? { model: opts.model } : {}) },
					{
						timeout: timeoutMs,
						retry: { maxRetries, maxRetryAfterMs: MAX_RETRY_WAIT_MS, httpStatuses: SDK_RETRY_STATUSES },
						signal: controller.signal,
					},
				);
				const wrapped = await promise.withResponse();
				const data = wrapped.data;
				usage.inputTokens += data.usage?.input_tokens ?? 0;
				usage.outputTokens += data.usage?.output_tokens ?? 0;
				usage.requests += 1;
				lastResolvedModel = data.model ?? null;
				const answers: Record<string, WireAnswer> = {};
				for (const [name, answer] of Object.entries(data.answers)) {
					// Spread into a fresh object literal so the answer fits the index signature.
					answers[name] = { ...answer };
				}
				return {
					result: {
						model: data.model,
						answers,
						usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
					},
					requestId: wrapped.requestId,
				};
			} catch (err) {
				if (err instanceof APIError && err.status === 402) {
					creditCooldown = { apiKey, baseURL, error: err, until: Date.now() + 60_000 };
					throw err;
				}
				const wait = err instanceof RateLimitError ? (err.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS * 2 ** rateLimited) : Number.POSITIVE_INFINITY;
				if (rateLimited >= maxRetries || wait > MAX_RETRY_WAIT_MS) throw err;
				await waitUnlessAborted(wait, controller.signal);
			}
		}
	} catch (err) {
		if (budgetExpired && !caller?.aborted && err instanceof APIUserAbortError) {
			throw new APITimeoutError(budgetMs, { cause: err });
		}
		throw err;
	} finally {
		clearTimeout(timer);
		caller?.removeEventListener("abort", onCallerAbort);
	}
}

/** Human-readable classification of an SDK failure. */
export function describeError(err: unknown): string {
	if (err instanceof APITimeoutError) return "timeout";
	if (err instanceof RateLimitError) {
		return err.retryAfterMs !== undefined ? `rate_limited retryAfter=${err.retryAfterMs}ms` : "rate_limited";
	}
	if (err instanceof APIUserAbortError) return "aborted";
	if (err instanceof APIConnectionError) return "connection_error";
	if (err instanceof APIError) {
		const reqId = err.requestId !== undefined ? ` request=${err.requestId}` : "";
		return `api_error status=${err.status}${reqId}: ${err.message}`;
	}
	if (err instanceof TypeSafeError) return `typesafe_error: ${err.message}`;
	return err instanceof Error ? err.message : String(err);
}

export { choice, noul, score };

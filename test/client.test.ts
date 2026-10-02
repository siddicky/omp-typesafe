import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APITimeoutError, RateLimitError, TypeSafeError } from "@typesafe-ai/sdk";
import { loadConfig } from "../src/config";
import { LIMITS } from "./limits";

/**
 * client.ts tests against the real SDK talking to a loopback Bun.serve that stands in for the
 * TypeSafe API (TYPESAFE_BASE_URL), so model selection, retry and abort behaviour are the SDK's
 * actual behaviour. Nothing leaves the machine.
 *
 * Other test files replace ../src/client with mock.module, and bun applies that to every test file
 * in the run. The query string below gives this file its own instance of the real module; its
 * imports (the SDK and ./config) are still the shared ones.
 */
const realClientSpecifier = "../src/client.ts?real-client";
const {
	apiKeyPresent,
	ask,
	describeError,
	estimateCostUsd,
	getClient,
	getClientError,
	getLastResolvedModel,
	getSessionUsage,
	noul,
	resetClient,
	resetUsage,
	retryBudgetMs,
	setClientLogger,
} = (await import(realClientSpecifier)) as typeof import("../src/client");

interface Seen {
	model: unknown;
	retryCount: string | null;
	at: number;
}

type Handler = (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve>;
let handler: Handler;
let seen: Seen[] = [];
let t0 = 0;
const dir = mkdtempSync(join(tmpdir(), "omp-typesafe-client-"));
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["TYPESAFE_BASE_URL", "TYPESAFE_API_KEY", "TYPESAFE_LOG_LEVEL", "TYPESAFE_DEFAULT_MODEL", "TYPESAFE_CONFIG"];
const questions = { q: noul("Is this a greeting?") };

function okResponse(body: Record<string, unknown>): Response {
	const answers: Record<string, unknown> = {};
	for (const name of Object.keys((body.questions as object) ?? {})) answers[name] = { type: "noul", noul: 0.5 };
	return Response.json({ model: String(body.model), answers, usage: { input_tokens: 10, output_tokens: 1 } });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ error: { message: `status ${status}` } }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** Point TYPESAFE_CONFIG at a file holding `config` and load it, so getConfig().model is known. */
async function useConfig(config: Record<string, unknown>): Promise<void> {
	const path = join(dir, `typesafe-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(path, JSON.stringify(config));
	process.env.TYPESAFE_CONFIG = path;
	await loadConfig();
}

beforeAll(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as Record<string, unknown>;
			seen.push({ model: body.model, retryCount: req.headers.get("x-typesafe-retry-count"), at: Date.now() - t0 });
			return handler(body, seen.length);
		},
	});
	process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
	process.env.TYPESAFE_API_KEY = "test-key";
});

beforeEach(async () => {
	delete process.env.TYPESAFE_LOG_LEVEL;
	delete process.env.TYPESAFE_DEFAULT_MODEL;
	handler = (body) => okResponse(body);
	seen = [];
	t0 = Date.now();
	setClientLogger(undefined);
	resetClient();
	await useConfig({ model: "jev-1.13.0" });
});

afterEach(() => {
	setClientLogger(undefined);
	resetClient();
});

afterAll(async () => {
	server.stop(true);
	process.env.TYPESAFE_CONFIG = join(dir, "does-not-exist.json");
	await loadConfig();
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("model selection", () => {
	test("the configured model is sent when no override is given", async () => {
		await ask("hi", questions);
		expect(seen.map((s) => s.model)).toEqual(["jev-1.13.0"]);
		expect(getClient().defaultModel).toBe("jev-1.13.0");
	});

	test("a per-call model override applies to that request only", async () => {
		await ask("hi", questions, { model: "jev-1.12.0" });
		await ask("hi", questions);
		expect(seen.map((s) => s.model)).toEqual(["jev-1.12.0", "jev-1.13.0"]);
	});

	test("an override as the first call of a session does not become the default", async () => {
		await ask("hi", questions, { model: "jev-1.12.0" });
		expect(getClient().defaultModel).toBe("jev-1.13.0");
	});

	test("a rejected override does not poison later calls", async () => {
		handler = (body) => (body.model === "jev-typo" ? errorResponse(400) : okResponse(body));
		await expect(ask("hi", questions, { model: "jev-typo" })).rejects.toThrow();
		const { result } = await ask("hi", questions);
		expect(result.model).toBe("jev-1.13.0");
		await ask("hi", questions);
		expect(seen.map((s) => s.model)).toEqual(["jev-typo", "jev-1.13.0", "jev-1.13.0"]);
	});

	test("a config reload that changes the model is picked up without resetClient", async () => {
		await ask("hi", questions);
		await useConfig({ model: "jev-1.14.0" });
		await ask("hi", questions);
		expect(seen.map((s) => s.model)).toEqual(["jev-1.13.0", "jev-1.14.0"]);
	});

	test("the client is cached while the model is unchanged", () => {
		expect(getClient()).toBe(getClient());
	});
});

describe("SDK logging", () => {
	function captureConsole(): { lines: string[]; restore: () => void } {
		const lines: string[] = [];
		const methods = ["log", "debug", "info", "warn", "error"] as const;
		const originals = methods.map((m) => console[m]);
		for (const m of methods) {
			console[m] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
		}
		return {
			lines,
			restore: () => {
				methods.forEach((m, i) => {
					console[m] = originals[i] as never;
				});
			},
		};
	}

	test("TYPESAFE_LOG_LEVEL=debug does not dump request bodies into the console", async () => {
		process.env.TYPESAFE_LOG_LEVEL = "debug";
		const cap = captureConsole();
		try {
			await ask({ diff: "SECRET_DIFF_CONTENT" }, questions);
		} finally {
			cap.restore();
		}
		expect(cap.lines.join("\n")).not.toContain("SECRET_DIFF_CONTENT");
		expect(cap.lines).toEqual([]);
	});

	test("TYPESAFE_LOG_LEVEL=debug does not leak bodies to a routed logger either", async () => {
		process.env.TYPESAFE_LOG_LEVEL = "debug";
		const logged: string[] = [];
		setClientLogger({ debug: (m) => void logged.push(m), info: (m) => void logged.push(m) });
		await ask({ diff: "SECRET_DIFF_CONTENT" }, questions);
		expect(logged).toEqual([]);
	});

	test("an invalid TYPESAFE_LOG_LEVEL no longer breaks every call", async () => {
		process.env.TYPESAFE_LOG_LEVEL = "verbose";
		const { result } = await ask("hi", questions);
		expect(result.model).toBe("jev-1.13.0");
		expect(getClientError()).toBeNull();
	});

	test("warn and error output goes to the routed omp logger", () => {
		const logged: string[] = [];
		setClientLogger({ warn: (m) => void logged.push(`warn ${m}`), error: (m) => void logged.push(`error ${m}`) });
		const client = getClient();
		client.logger.warn("slow");
		client.logger.error("failed");
		expect(logged).toEqual(["warn [typesafe sdk] slow", "error [typesafe sdk] failed"]);
	});

	test("a logger installed after the client was built still receives output", () => {
		const client = getClient();
		const logged: string[] = [];
		setClientLogger({ warn: (m) => void logged.push(m) });
		client.logger.warn("late");
		expect(logged).toEqual(["[typesafe sdk] late"]);
	});

	test("without a logger SDK output is dropped, not printed", () => {
		const cap = captureConsole();
		try {
			const client = getClient();
			client.logger.warn("nobody is listening");
			client.logger.error("still nobody");
		} finally {
			cap.restore();
		}
		expect(cap.lines).toEqual([]);
	});
});

describe("client construction errors", () => {
	test("a missing API key is surfaced through getClientError, and clears once fixed", async () => {
		delete process.env.TYPESAFE_API_KEY;
		try {
			await expect(ask("hi", questions)).rejects.toBeInstanceOf(TypeSafeError);
			expect(getClientError()).toStartWith("typesafe_error:");
		} finally {
			process.env.TYPESAFE_API_KEY = "test-key";
		}
		await ask("hi", questions);
		expect(getClientError()).toBeNull();
	});

	test("resetClient clears a recorded construction error", async () => {
		delete process.env.TYPESAFE_API_KEY;
		try {
			await expect(ask("hi", questions)).rejects.toThrow();
		} finally {
			process.env.TYPESAFE_API_KEY = "test-key";
		}
		resetClient();
		expect(getClientError()).toBeNull();
	});
});

describe("retry budget", () => {
	test("retryBudgetMs covers every attempt plus the longest wait before each retry", () => {
		expect(retryBudgetMs(1500, 0)).toBe(1800);
		expect(retryBudgetMs(10_000, 2)).toBe(10_000 * 3 + 2 * LIMITS.retryAfterMs + 300);
		expect(retryBudgetMs(1000, -3)).toBe(1300);
	});

	test("an attempt that times out is retried instead of aborting the call", async () => {
		handler = async (body, attempt) => {
			if (attempt === 1) await Bun.sleep(1000);
			return okResponse(body);
		};
		const { result } = await ask("hi", questions, { timeoutMs: 200, maxRetries: 1 });
		expect(result.model).toBe("jev-1.13.0");
		expect(seen).toHaveLength(2);
		expect(seen[1]?.retryCount).toBe("1");
	});

	test("a short Retry-After is honored before the retry", async () => {
		handler = (body, attempt) => (attempt === 1 ? errorResponse(429, { "retry-after-ms": "50" }) : okResponse(body));
		await ask("hi", questions, { timeoutMs: 1000, maxRetries: 1 });
		expect(seen).toHaveLength(2);
		// The SDK's own backoff would be at least 375 ms.
		expect((seen[1]?.at ?? 0) - (seen[0]?.at ?? 0)).toBeLessThan(350);
	});

	test("a Retry-After longer than the longest wait fails on the first response as rate_limited, with no retry", async () => {
		handler = () => errorResponse(429, { "retry-after": "30" });
		const started = Date.now();
		const err = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 2 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RateLimitError);
		expect(describeError(err)).toBe("rate_limited retryAfter=30000ms");
		expect(Date.now() - started).toBeLessThan(500);
		expect(seen).toHaveLength(1);
	});

	// The README says a Retry-After above 5 s fails at once. (Exactly 5 s is waited out, which a test cannot afford.)
	test("a Retry-After just over the longest wait the README states is not retried", async () => {
		handler = () => errorResponse(429, { "retry-after-ms": String(LIMITS.retryAfterMs + 1) });
		const started = Date.now();
		const err = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 2 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RateLimitError);
		expect(describeError(err)).toBe(`rate_limited retryAfter=${LIMITS.retryAfterMs + 1}ms`);
		expect(Date.now() - started).toBeLessThan(500);
		expect(seen).toHaveLength(1);
	});

	test("a rate-limited call retries only as often as maxRetries allows, then reports rate_limited", async () => {
		handler = () => errorResponse(429, { "retry-after-ms": "20" });
		const err = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 2 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RateLimitError);
		expect(describeError(err)).toBe("rate_limited retryAfter=20ms");
		expect(seen).toHaveLength(3);
		const none = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 0 }).catch((e: unknown) => e);
		expect(none).toBeInstanceOf(RateLimitError);
		expect(seen).toHaveLength(4);
	});

	test("a 429 with no Retry-After is retried after a short backoff", async () => {
		handler = (body, attempt) => (attempt === 1 ? errorResponse(429) : okResponse(body));
		const { result } = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 1 });
		expect(result.model).toBe("jev-1.13.0");
		expect(seen).toHaveLength(2);
		expect((seen[1]?.at ?? 0) - (seen[0]?.at ?? 0)).toBeLessThan(1500);
	});

	test("a server error is still retried by the SDK", async () => {
		handler = (body, attempt) => (attempt === 1 ? errorResponse(503) : okResponse(body));
		await ask("hi", questions, { timeoutMs: 1000, maxRetries: 1 });
		expect(seen).toHaveLength(2);
		expect(seen[1]?.retryCount).toBe("1");
	});

	test("the caller's abort ends the wait before a rate-limit retry and reports 'aborted'", async () => {
		handler = () => errorResponse(429, { "retry-after-ms": "4000" });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const started = Date.now();
		const err = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 2, signal: controller.signal }).catch((e: unknown) => e);
		expect(describeError(err)).toBe("aborted");
		expect(Date.now() - started).toBeLessThan(1500);
		expect(seen).toHaveLength(1);
	});

	test("a budget that runs out during the wait before a retry is reported as a timeout", async () => {
		handler = () => errorResponse(429, { "retry-after-ms": "4000" });
		const started = Date.now();
		const err = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 2, budgetMs: 300 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(APITimeoutError);
		expect(Date.now() - started).toBeLessThan(1500);
		expect(seen).toHaveLength(1);
	});

	test("an expired budget is reported as a timeout, not as 'aborted'", async () => {
		handler = async (body) => {
			await Bun.sleep(1500);
			return okResponse(body);
		};
		const started = Date.now();
		const err = await ask("hi", questions, { timeoutMs: 5000, maxRetries: 2, budgetMs: 250 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(APITimeoutError);
		expect(describeError(err)).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(1200);
		expect(seen).toHaveLength(1);
	});

	test("the default budget lets a normal call finish", async () => {
		const { result, requestId } = await ask("hi", questions, { timeoutMs: 1000, maxRetries: 2 });
		expect(result.answers.q).toEqual({ type: "noul", noul: 0.5 });
		expect(requestId).toBeUndefined();
		expect(seen).toHaveLength(1);
	});

	// A budget timer left running would keep a short-lived process alive for the whole budget, once per call.
	describe("cleanup", () => {
		const BUDGET = 12_345;

		/** Run `body` while recording which setTimeout calls used BUDGET as their delay and which handles were cleared. */
		async function watchBudgetTimers(body: () => Promise<unknown>): Promise<{ created: unknown[]; cleared: Set<unknown> }> {
			const realSet = globalThis.setTimeout;
			const realClear = globalThis.clearTimeout;
			const created: unknown[] = [];
			const cleared = new Set<unknown>();
			globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
				const timer = realSet(handler, ms, ...(rest as []));
				if (ms === BUDGET) created.push(timer);
				return timer;
			}) as typeof setTimeout;
			globalThis.clearTimeout = ((timer?: Parameters<typeof clearTimeout>[0]) => {
				cleared.add(timer);
				return realClear(timer);
			}) as typeof clearTimeout;
			try {
				await body();
			} catch {
				// The failing path is observed through the timers, not the error.
			} finally {
				globalThis.setTimeout = realSet;
				globalThis.clearTimeout = realClear;
			}
			return { created, cleared };
		}

		test("the budget timer is cleared after a call that succeeds", async () => {
			const { created, cleared } = await watchBudgetTimers(() => ask("hi", questions, { timeoutMs: 1000, budgetMs: BUDGET }));
			expect(created).toHaveLength(1);
			expect(cleared.has(created[0])).toBe(true);
		});

		test("the budget timer is cleared after a call that fails", async () => {
			handler = () => errorResponse(400);
			const { created, cleared } = await watchBudgetTimers(() => ask("hi", questions, { timeoutMs: 1000, budgetMs: BUDGET }));
			expect(created).toHaveLength(1);
			expect(cleared.has(created[0])).toBe(true);
		});

		test("the abort listener on the caller's signal is removed once the call is over", async () => {
			const controller = new AbortController();
			const signal = controller.signal;
			let listeners = 0;
			const add = signal.addEventListener.bind(signal);
			const remove = signal.removeEventListener.bind(signal);
			signal.addEventListener = ((type: string, listener: () => void, options?: { once?: boolean }) => {
				if (type === "abort") listeners += 1;
				add(type, listener, options);
			}) as typeof signal.addEventListener;
			signal.removeEventListener = ((type: string, listener: () => void, options?: object) => {
				if (type === "abort") listeners -= 1;
				remove(type, listener, options);
			}) as typeof signal.removeEventListener;

			await ask("hi", questions, { timeoutMs: 1000, signal });
			expect(listeners).toBe(0);
			handler = () => errorResponse(400);
			await ask("hi", questions, { timeoutMs: 1000, signal }).catch(() => undefined);
			expect(listeners).toBe(0);
		});
	});
});

describe("caller abort", () => {
	test("an aborted signal cancels the call and is reported as 'aborted'", async () => {
		handler = async (body) => {
			await Bun.sleep(1500);
			return okResponse(body);
		};
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		const err = await ask("hi", questions, { timeoutMs: 5000, maxRetries: 2, signal: controller.signal }).catch((e: unknown) => e);
		expect(describeError(err)).toBe("aborted");
		expect(Date.now() - started).toBeLessThan(1200);
	});

	test("an already-aborted signal never reaches the server", async () => {
		const controller = new AbortController();
		controller.abort();
		const err = await ask("hi", questions, { signal: controller.signal }).catch((e: unknown) => e);
		expect(describeError(err)).toBe("aborted");
		expect(seen).toHaveLength(0);
	});
});

describe("usage accounting", () => {
	test("successful calls add to the session usage", async () => {
		resetUsage();
		await ask("hi", questions);
		await ask("hi", questions);
		expect(getSessionUsage()).toEqual({ inputTokens: 20, outputTokens: 2, requests: 2 });
		resetUsage();
	});

	test("the cost estimate is input tokens only, at $0.042 per million", async () => {
		resetUsage();
		expect(estimateCostUsd()).toBe(0);
		await ask({ big: "x" }, questions);
		await ask({ big: "x" }, questions);
		expect(estimateCostUsd()).toBeCloseTo((20 * 0.042) / 1_000_000, 12);
		resetUsage();
		expect(estimateCostUsd()).toBe(0);
	});

	test("a failed call adds nothing to the usage", async () => {
		resetUsage();
		handler = () => errorResponse(400);
		await expect(ask("hi", questions)).rejects.toThrow();
		expect(getSessionUsage()).toEqual({ inputTokens: 0, outputTokens: 0, requests: 0 });
	});

	test("the model the API resolved is remembered until the client is reset", async () => {
		expect(getLastResolvedModel()).toBeNull();
		handler = (body) => Response.json({ model: "jev-1.13.7", answers: Object.fromEntries(Object.keys(body.questions as object).map((q) => [q, { type: "noul", noul: 0.5 }])), usage: { input_tokens: 1, output_tokens: 0 } });
		await ask("hi", questions);
		expect(getLastResolvedModel()).toBe("jev-1.13.7");
		resetClient();
		expect(getLastResolvedModel()).toBeNull();
	});
});

describe("environment and error descriptions", () => {
	test("apiKeyPresent needs a non-blank TYPESAFE_API_KEY", () => {
		const key = process.env.TYPESAFE_API_KEY;
		try {
			expect(apiKeyPresent()).toBe(true);
			process.env.TYPESAFE_API_KEY = "   ";
			expect(apiKeyPresent()).toBe(false);
			delete process.env.TYPESAFE_API_KEY;
			expect(apiKeyPresent()).toBe(false);
		} finally {
			process.env.TYPESAFE_API_KEY = key;
		}
	});

	test("an API rejection is described by its status and request id", async () => {
		handler = () =>
			new Response(JSON.stringify({ error: { message: "bad question" } }), {
				status: 422,
				headers: { "content-type": "application/json", "x-request-id": "req_abc" },
			});
		const err = await ask("hi", questions).catch((e: unknown) => e);
		expect(describeError(err)).toMatch(/^api_error status=422( request=\S+)?: /);
	});

	test("anything else is described by its message", () => {
		expect(describeError(new Error("plain"))).toBe("plain");
		expect(describeError("text")).toBe("text");
	});
});

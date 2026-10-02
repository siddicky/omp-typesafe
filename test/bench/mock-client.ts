import { mock } from "bun:test";

/**
 * Controllable stand-in for src/client.ts, shared by the bench tests so no test
 * touches the network. `respond` decides each `ask` call's answers (or throws).
 * Call installClientMock() at the top of every test file that imports a bench
 * module, before the `await import`, so a mock registered by another test file in
 * the same process cannot stay in effect.
 */

export interface AskCall {
	state: unknown;
	questions: Record<string, { instructions?: unknown }>;
	opts: Record<string, unknown>;
}

export type Answers = Record<string, { type: string; [key: string]: unknown }>;

export const clientMock = {
	apiKey: true,
	calls: [] as AskCall[],
	respond: (_call: AskCall): Answers | Promise<Answers> => ({}),
};

export function resetClientMock(): void {
	clientMock.apiKey = true;
	clientMock.calls = [];
	clientMock.respond = () => ({});
}

export function noulAnswer(p: number): { type: string; noul: number; confidence: number } {
	return { type: "noul", noul: p, confidence: 0.9 };
}

export function installClientMock(): void {
	mock.module("../../src/client", () => ({
		apiKeyPresent: () => clientMock.apiKey,
		ask: async (state: unknown, questions: AskCall["questions"], opts: Record<string, unknown>) => {
			const call: AskCall = { state, questions, opts };
			clientMock.calls.push(call);
			const answers = await clientMock.respond(call);
			return {
				result: { model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 } },
				requestId: "test-request",
			};
		},
		describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
		// The rest of src/client.ts's surface. The registration is process-wide and the extension (src/index.ts) imports
		// these, so a mock that left them out would break its link if another test file loaded it after this one.
		estimateCostUsd: () => 0,
		getClientError: () => null,
		getLastResolvedModel: () => null,
		getSessionUsage: () => ({ requests: clientMock.calls.length, inputTokens: 0, outputTokens: 0 }),
		resetClient: () => {},
		resetUsage: () => {},
		setClientLogger: () => {},
		noul: (instructions: unknown, opts?: Record<string, unknown>) => ({ type: "noul", instructions, ...opts }),
		choice: (instructions: unknown, criteria: unknown) => ({ type: "choice", instructions, criteria }),
		score: (instructions: unknown, levels: readonly string[]) => ({ type: "score", instructions, levels: [...levels] }),
	}));
}

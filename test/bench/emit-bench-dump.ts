/**
 * Drives the real extension (src/index.ts, with the real client and SDK) through one reviewed edit and a shutdown,
 * so the TYPESAFE_BENCH_LOG it writes is the real thing. payload-contract.test.ts runs this as a subprocess with
 * the environment bench/run.ts gives a cell, and TYPESAFE_BASE_URL pointing at a loopback fake of the TypeSafe API.
 */
import extension from "../../src/index";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
const handlers: Record<string, Handler[]> = {};
const schema: any = { optional: () => schema };
const zod = { object: () => schema, string: () => schema, enum: () => schema, array: () => schema, record: () => schema };

const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "rename fetchUser to loadUser everywhere" }] } }];
const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	isIdle: () => false,
	ui: { notify() {} },
	sessionManager: { getBranch: () => branch, getSessionId: () => "payload-contract" },
};
const pi = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	zod,
	setLabel() {},
	on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
	registerTool() {},
	registerCommand() {},
	sendMessage() {},
	exec: async () => ({ code: 128, stdout: "" }),
};
extension(pi as never);

async function fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
	for (const handler of handlers[event] ?? []) await handler({ type: event, ...payload }, ctx);
}

await fire("session_start");
await fire("agent_start");
await fire("turn_start", { turnIndex: 0 });
await fire("tool_result", { toolName: "edit", toolCallId: "c1", input: { path: "a.ts" }, content: [{ type: "text", text: "ok" }], isError: false });
await fire("session_shutdown");

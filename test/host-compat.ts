/**
 * Compile-time check of src/host.ts against omp's own declarations: no runtime code, and bun test never loads
 * it. `bun run typecheck` fails here when the host's API drifts from the slice of it this extension relies on.
 * The check runs against the @oh-my-pi/pi-coding-agent devDependency, which is pinned to the omp version the
 * extension was last tested with: bump it deliberately and fix whatever this file then reports.
 */
import type {
	BeforeAgentStartEventResult,
	ContextEventResult,
	ExtensionAPI as RealAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStopEventResult,
	ToolCallEventResult,
	ToolDefinition,
	ToolResultEventResult,
} from "@oh-my-pi/pi-coding-agent";
import type {
	BeforeAgentStartResult,
	ContextResult,
	ExtensionAPI,
	HostCommand,
	HostContext,
	HostEvents,
	HostExecResult,
	HostLogger,
	HostMessage,
	HostSessionHeader,
	HostTool,
	HostToolResult,
	SendMessageOptions,
	SessionStopResult,
	ToolCallResult,
	ToolResultPatch,
	ZodSchema,
} from "../src/host";

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

/**
 * Plain assignability is not enough for these types: nearly every local field is optional, so a host that renamed or
 * dropped one would still be assignable (a "weak" type needs only one field of overlap, and `type` alone is that).
 * Each check below therefore also demands that every field the local type names exists on the host's type, and
 * compares the field types in the direction the data flows:
 * - ReadFits: what the host sends us (events, the context, exec results). The host's type for each field must be
 *   one the local type accepts.
 * - WriteFits: what we send or return (results, messages, options, tools). The local type for each field must be one
 *   the host accepts.
 */
type HasKeys<Local, Real> = [Exclude<keyof Local, keyof Real>] extends [never] ? true : false;
type ReadFits<Local, Real> = HasKeys<Local, Real> extends true
	? { [K in keyof Local]-?: [Real[K & keyof Real]] extends [Local[K]] ? true : false }[keyof Local] extends true
		? true
		: false
	: false;
type WriteFits<Local, Real> = HasKeys<Local, Real> extends true
	? { [K in keyof Local]-?: [Local[K]] extends [Real[K & keyof Real]] ? true : false }[keyof Local] extends true
		? true
		: false
	: false;
/** What the extension reads from an event is a ReadFits, as before. */
type EventFits<Local, Real> = ReadFits<Local, Real>;

// The context omp hands to every handler and to commands must be usable as the HostContext the handlers declare, and
// still carry every field the handlers read from it (`ctx.hasUI === true`, `ctx.cwd`, `ctx.isIdle?.()`, ...).
export type ContextFits = Assert<Assignable<ExtensionContext, HostContext>>;
export type CommandContextFits = Assert<Assignable<ExtensionCommandContext, HostContext>>;
export type ContextFieldsFit = Assert<ReadFits<HostContext, ExtensionContext>>;
export type CommandContextFieldsFit = Assert<ReadFits<HostContext, ExtensionCommandContext>>;
export type UiFieldsFit = Assert<ReadFits<NonNullable<HostContext["ui"]>, ExtensionContext["ui"]>>;
export type SessionManagerFieldsFit = Assert<ReadFits<HostContext["sessionManager"], ExtensionContext["sessionManager"]>>;
// The subagent guard (src/subagent.ts) reads `ctx.agent` (kind, depth) and, on a host without it, the session header's
// `parentSession` beside the session file; each name it reads must still be there, in a type that fits.
export type AgentFieldsFit = Assert<ReadFits<NonNullable<HostContext["agent"]>, ExtensionContext["agent"]>>;
export type SessionHeaderFieldsFit = Assert<ReadFits<HostSessionHeader, NonNullable<ReturnType<ExtensionContext["sessionManager"]["getHeader"]>>>>;

// What the extension registers must be accepted by the host's own registration methods, and every field it sets must
// still exist there. `parameters` is omp's nominal TypeBox/omptype schema, built at runtime by the host's own
// `pi.zod`, so it is compared through that builder: what `pi.zod.object` returns must be a schema the tool
// definition accepts.
export type ToolFits = Assert<Assignable<Omit<HostTool<unknown>, "parameters">, Omit<ToolDefinition, "parameters">>>;
export type ToolFieldsFit = Assert<WriteFits<Omit<HostTool<unknown>, "parameters">, Omit<ToolDefinition, "parameters">>>;
export type ToolParametersFit = Assert<Assignable<ReturnType<RealAPI["zod"]["object"]>, ToolDefinition["parameters"]>>;
export type CommandFits = Assert<Assignable<HostCommand, Parameters<RealAPI["registerCommand"]>[1]>>;
export type CommandFieldsFit = Assert<WriteFits<HostCommand, Parameters<RealAPI["registerCommand"]>[1]>>;
export type MessageFits = Assert<Assignable<HostMessage, Parameters<RealAPI["sendMessage"]>[0]>>;
// The host also takes a bare string as a message; the extension sends the object form.
export type MessageFieldsFit = Assert<WriteFits<HostMessage, Exclude<Parameters<RealAPI["sendMessage"]>[0], string>>>;
export type SendOptionsFits = Assert<Assignable<SendMessageOptions, NonNullable<Parameters<RealAPI["sendMessage"]>[1]>>>;
export type SendOptionsFieldsFit = Assert<WriteFits<SendMessageOptions, NonNullable<Parameters<RealAPI["sendMessage"]>[1]>>>;

// A tool's result is compared by what `execute` returns: `isError` (typesafe_ask sets it on every failure path) and
// `details` must still be fields of the host's result, and exec's options (`cwd` runs git at the repo root, `signal`
// carries the evidence probes' 1.5 s and 3 s kills) must still be options the host reads. Assignability alone would
// pass a rename of one of them, because each local type shares another field with the host's.
export type ToolResultFieldsFit = Assert<WriteFits<HostToolResult, Awaited<ReturnType<ToolDefinition["execute"]>>>>;
export type ExecOptionsFieldsFit = Assert<WriteFits<NonNullable<Parameters<ExtensionAPI["exec"]>[2]>, NonNullable<Parameters<RealAPI["exec"]>[2]>>>;

// What a handler returns goes back to the host: `block` is the ambiguity gate's veto, `continue` the stop gate's
// continuation, `message` the plan_start note, `content` the inlined action note. Each must still be a field the
// host reads, of a type it accepts.
export type ToolCallResultFits = Assert<WriteFits<ToolCallResult, ToolCallEventResult>>;
export type SessionStopResultFits = Assert<WriteFits<SessionStopResult, SessionStopEventResult>>;
export type BeforeAgentStartResultFits = Assert<WriteFits<BeforeAgentStartResult, BeforeAgentStartEventResult>>;
export type ToolResultPatchFits = Assert<WriteFits<ToolResultPatch, ToolResultEventResult>>;

// What the extension calls on the host must exist with a compatible signature, and every member it names must still
// be there. exec's result is compared too: the evidence probes read `stdout`, `code` and `killed` from it.
export type ApiMembersFit = Assert<HasKeys<ExtensionAPI, RealAPI>>;
export type ExecFits = Assert<Assignable<RealAPI["exec"], ExtensionAPI["exec"]>>;
export type ExecResultFits = Assert<Assignable<Awaited<ReturnType<RealAPI["exec"]>>, HostExecResult>>;
export type ExecResultFieldsFit = Assert<ReadFits<HostExecResult, Awaited<ReturnType<RealAPI["exec"]>>>>;
export type ActiveToolsFits = Assert<Assignable<RealAPI["getActiveTools"], NonNullable<ExtensionAPI["getActiveTools"]>>>;
export type LabelFits = Assert<Assignable<RealAPI["setLabel"], ExtensionAPI["setLabel"]>>;
export type LoggerFits = Assert<Assignable<RealAPI["logger"], NonNullable<ExtensionAPI["logger"]>>>;
export type LoggerFieldsFit = Assert<ReadFits<HostLogger, RealAPI["logger"]>>;

// `pi.zod`. The builders that take schemas (object, array, record) cannot be compared parameter by parameter: the
// host's schema objects are far richer than the local ZodSchema, which only names them, so a strict comparison
// would reject any host. Instead each local member must exist on the host's builder, the ones with no schema
// parameter (string, enum: the host's takes a non-empty tuple) are compared strictly, and what the others return
// must be a ZodSchema. The calls the extension makes are then replayed on the host's own builder below, so a host
// that stops accepting them (a schema with `.optional()` inside `object`, `record` with one schema, ...) is an error here.
export type ZodMembersFit = Assert<HasKeys<ExtensionAPI["zod"], RealAPI["zod"]>>;
export type ZodStringFits = Assert<Assignable<RealAPI["zod"]["string"], ExtensionAPI["zod"]["string"]>>;
export type ZodEnumFits = Assert<Assignable<RealAPI["zod"]["enum"], ExtensionAPI["zod"]["enum"]>>;
export type ZodReturnsFit = Assert<
	Assignable<
		[
			ReturnType<RealAPI["zod"]["object"]>,
			ReturnType<RealAPI["zod"]["string"]>,
			ReturnType<RealAPI["zod"]["enum"]>,
			ReturnType<RealAPI["zod"]["array"]>,
			ReturnType<RealAPI["zod"]["record"]>,
			ReturnType<ReturnType<RealAPI["zod"]["string"]>["optional"]>,
		],
		[ZodSchema, ZodSchema, ZodSchema, ZodSchema, ZodSchema, ZodSchema]
	>
>;
declare const hostZod: RealAPI["zod"];
export const zodUsageReplay = (): ToolDefinition["parameters"] => {
	const options = hostZod.record(hostZod.string());
	return hostZod.object({
		state: hostZod.string(),
		stateFormat: hostZod.enum(["text", "json"]).optional(),
		questions: hostZod.array(
			hostZod.object({
				id: hostZod.string(),
				type: hostZod.enum(["noul", "choice", "score"]),
				instructions: hostZod.string(),
				options: options.optional(),
				levels: hostZod.array(hostZod.string()).optional(),
				whenTrue: hostZod.string().optional(),
				whenFalse: hostZod.string().optional(),
			}),
		),
		model: hostZod.string().optional(),
	});
};
export const zodFallbackReplay = (): ZodSchema => hostZod.array(hostZod.object({ name: hostZod.string(), description: hostZod.string().optional() }));

// Every event the extension declares must be accepted by the host's `on` overload for that event, and the host's
// event must still carry every field the extension reads from it (EventFits). The record is keyed by `keyof
// HostEvents`, so declaring a new event in src/host.ts without adding its check here is a type error.
type Handler<K extends keyof HostEvents> = (event: HostEvents[K]["event"], ctx: HostContext) => HostEvents[K]["result"] | Promise<HostEvents[K]["result"]>;
declare const real: RealAPI;
declare function handler<K extends keyof HostEvents>(): Handler<K>;

export const everyEventIsChecked: { [K in keyof HostEvents]: () => void } = {
	session_start: () => {
		real.on("session_start", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["session_start"]["event"], typeof event>>;
			return handler<"session_start">()(event, ctx);
		});
	},
	session_switch: () => {
		real.on("session_switch", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["session_switch"]["event"], typeof event>>;
			return handler<"session_switch">()(event, ctx);
		});
	},
	session_branch: () => {
		real.on("session_branch", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["session_branch"]["event"], typeof event>>;
			return handler<"session_branch">()(event, ctx);
		});
	},
	session_tree: () => {
		real.on("session_tree", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["session_tree"]["event"], typeof event>>;
			return handler<"session_tree">()(event, ctx);
		});
	},
	session_compact: () => {
		real.on("session_compact", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["session_compact"]["event"], typeof event>>;
			return handler<"session_compact">()(event, ctx);
		});
	},
	session_shutdown: () => {
		real.on("session_shutdown", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["session_shutdown"]["event"], typeof event>>;
			return handler<"session_shutdown">()(event, ctx);
		});
	},
	agent_start: () => {
		real.on("agent_start", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["agent_start"]["event"], typeof event>>;
			return handler<"agent_start">()(event, ctx);
		});
	},
	turn_start: () => {
		real.on("turn_start", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["turn_start"]["event"], typeof event>>;
			return handler<"turn_start">()(event, ctx);
		});
	},
	turn_end: () => {
		real.on("turn_end", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["turn_end"]["event"], typeof event>>;
			return handler<"turn_end">()(event, ctx);
		});
	},
	message_end: () => {
		real.on("message_end", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["message_end"]["event"], typeof event>>;
			return handler<"message_end">()(event, ctx);
		});
	},
	before_agent_start: () => {
		real.on("before_agent_start", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["before_agent_start"]["event"], typeof event>>;
			return handler<"before_agent_start">()(event, ctx);
		});
	},
	tool_call: () => {
		real.on("tool_call", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["tool_call"]["event"], typeof event>>;
			return handler<"tool_call">()(event, ctx);
		});
	},
	tool_result: () => {
		real.on("tool_result", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["tool_result"]["event"], typeof event>>;
			return handler<"tool_result">()(event, ctx);
		});
	},
	session_stop: () => {
		real.on("session_stop", (event, ctx) => {
			type Fits = Assert<EventFits<HostEvents["session_stop"]["event"], typeof event>>;
			return handler<"session_stop">()(event, ctx);
		});
	},
	context: () => {
		real.on("context", (event) => {
			type Fits = Assert<EventFits<HostEvents["context"]["event"], typeof event>>;
			// The handler returns messages it received. The host's AgentMessage is a wide union that the local
			// HostAgentMessage deliberately does not mirror, so the result is checked by field name and by what the host
			// sends us (a host message must fit the local one), not by assigning the local result to the host's.
			type ResultKeys = Assert<HasKeys<ContextResult, ContextEventResult>>;
			type ResultFits = Assert<ReadFits<ContextResult, ContextEventResult>>;
		});
	},
};

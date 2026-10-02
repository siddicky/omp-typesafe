/**
 * The slice of omp's extension API this plugin uses, as local structural types. The host package
 * (@oh-my-pi/pi-coding-agent) is not a runtime dependency, so nothing here is imported from it and nothing here
 * exists at runtime. They describe only the calls and fields src/ relies on; every event field is optional
 * because the handlers validate what they read. test/host-compat.ts checks them against the host's own
 * declarations (a pinned devDependency) at typecheck time, so a host change that breaks one fails CI:
 * - every field of every type named here must exist on the host's matching type, so a rename is caught (the types
 *   are mostly all-optional, which plain assignability cannot tell from a type that merely shares one field);
 * - the types of what the host sends us (events, the context, `exec` results) must be ones the local type accepts,
 *   and the types of what we send it (results, messages, options, tools) must be ones the host accepts;
 * - every function member is a property holding a function type, not a method, so a parameter type the host
 *   narrows is caught too (see below).
 */

/** The levels omp's ui.notify understands; anything else is rendered as a plain status line. */
export type NotifyLevel = "info" | "warning" | "error";

// Members the host calls or that call the host are declared as properties holding function types, not as methods:
// under strictFunctionTypes a property's parameters are compared contravariantly, so test/host-compat.ts notices
// when the host narrows a parameter type (a method's parameters are compared bivariantly and would not).
export interface HostLogger {
	debug?: (message: string) => void;
	info?: (message: string) => void;
	warn?: (message: string) => void;
	error?: (message: string) => void;
}

/**
 * `pi.zod` is omp's own Zod-compatible builder (ArkType underneath), not Zod itself: `enum` takes an array
 * and `record` takes either a value schema (string keys) or a key and a value schema.
 */
export interface ZodSchema {
	optional: () => ZodSchema;
}

export interface ZodBuilder {
	object: (shape: Record<string, ZodSchema>) => ZodSchema;
	string: () => ZodSchema;
	/** The host's `enum` takes a non-empty tuple, so a plain `string[]` is rejected here as it is there. */
	enum: (values: readonly [string, ...string[]]) => ZodSchema;
	array: (item: ZodSchema) => ZodSchema;
	record: {
		(value: ZodSchema): ZodSchema;
		(key: ZodSchema, value: ZodSchema): ZodSchema;
	};
}

/**
 * Who a session runs for: the top-level agent or a subagent (the task tool, eval `agent()`, a `/tan` clone).
 * `kind` is `"main"` or `"sub"` on the host; `depth` is the task tool's nesting level (0 for a clone).
 */
export interface HostAgentIdentity {
	kind?: string;
	id?: string;
	name?: string;
	depth?: number;
	parentId?: string;
}

/** The part of a session's header the subagent check reads: the file of the session this one was started from. */
export interface HostSessionHeader {
	parentSession?: string;
}

/** What every handler, tool and command receives as `ctx`. */
export interface HostContext {
	cwd?: string;
	/** False in print, json and rpc runs: there is no one to ask and no `ask` tool. */
	hasUI?: boolean;
	ui?: { notify: (message: string, level?: NotifyLevel) => unknown };
	isIdle?: () => boolean;
	/**
	 * The agent this session runs. The host defines it as a non-enumerable property, so `Object.keys(ctx)` and a
	 * spread of `ctx` do not show it; read it by name. Absent on hosts that predate it.
	 */
	agent?: HostAgentIdentity;
	sessionManager: {
		getBranch: () => unknown[];
		getSessionId?: () => unknown;
		getSessionFile?: () => string | undefined;
		getHeader?: () => HostSessionHeader | null | undefined;
	};
}

/** A custom message handed to `pi.sendMessage` or returned from `before_agent_start`. */
export interface HostMessage {
	customType: string;
	content: string;
	display: boolean;
	attribution?: "agent" | "user";
}

export interface SendMessageOptions {
	/**
	 * `aside` is injected at the next step boundary of the running turn, without interrupting its tool batch (it starts a
	 * turn when the session is idle); `nextTurn` stays hidden until the user's next prompt and never wakes an idle agent;
	 * `steer` interrupts the running turn.
	 */
	deliverAs?: "aside" | "steer" | "nextTurn" | "followUp";
	triggerTurn?: boolean;
}

// ---- events ---------------------------------------------------------------------------------------------

/** Every host event names itself in `type`; declaring it keeps an event with no other field of ours assignable. */
export interface HostEventBase {
	type?: string;
}

/** An event whose payload the extension does not read. */
export type SessionEvent = HostEventBase;

export interface SessionSwitchEvent extends HostEventBase {
	/** Why the session changed. */
	reason?: "new" | "resume" | "fork";
}

export interface BeforeAgentStartEvent extends HostEventBase {
	prompt?: string;
}

export interface TurnStartEvent extends HostEventBase {
	turnIndex?: number;
}

export interface TurnEndEvent extends HostEventBase {
	turnIndex?: number;
	message?: unknown;
	/** The turn's tool result messages (`role: "toolResult"`); typed `unknown`, read by interruptedBatch. */
	toolResults?: unknown;
}

export interface MessageEndEvent extends HostEventBase {
	message?: unknown;
}

export interface ToolCallEvent extends HostEventBase {
	toolName?: string;
	toolCallId?: string;
	input?: unknown;
}

export interface ToolResultEvent extends HostEventBase {
	toolName?: string;
	toolCallId?: string;
	input?: unknown;
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}

export interface SessionStopEvent extends HostEventBase {
	/** True when this stop is itself the result of a stop hook's continuation. */
	stop_hook_active?: boolean;
	/**
	 * omp passes its last message (an AssistantMessage: a `content` array of blocks), or nothing when the run
	 * produced none. Typed `unknown` because the host's own type is a union of message kinds; lastMessageText
	 * narrows it, and also accepts a plain string.
	 */
	last_assistant_message?: unknown;
}

export interface BeforeAgentStartResult {
	message: HostMessage;
}

export interface ToolCallResult {
	block: boolean;
	reason?: string;
}

/** The content blocks a tool result holds: text, or an image the extension only passes back. */
export type HostContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResultPatch {
	/** A full replacement of the result's content blocks. */
	content: HostContentBlock[];
}

export interface SessionStopResult {
	continue: boolean;
	additionalContext?: string;
}

/** A message of the conversation. The extension reads it only through src/compaction.ts, which checks every field it uses. */
export interface HostAgentMessage {
	role: string;
}

/** The messages about to go to the model: a copy the handler may modify or replace. */
export interface ContextEvent extends HostEventBase {
	messages?: HostAgentMessage[];
}

/** Replaces the messages of this one request; the session itself is untouched. Every message returned was received. */
export interface ContextResult {
	messages?: HostAgentMessage[];
}

type Maybe<T> = T | undefined | void;

/** Event name -> its payload and what a handler may return (nothing, unless listed). */
export interface HostEvents {
	session_start: { event: SessionEvent; result: void };
	session_switch: { event: SessionSwitchEvent; result: void };
	session_branch: { event: SessionEvent; result: void };
	session_tree: { event: SessionEvent; result: void };
	session_compact: { event: SessionEvent; result: void };
	session_shutdown: { event: SessionEvent; result: void };
	agent_start: { event: SessionEvent; result: void };
	turn_start: { event: TurnStartEvent; result: void };
	turn_end: { event: TurnEndEvent; result: void };
	message_end: { event: MessageEndEvent; result: void };
	before_agent_start: { event: BeforeAgentStartEvent; result: Maybe<BeforeAgentStartResult> };
	tool_call: { event: ToolCallEvent; result: Maybe<ToolCallResult> };
	tool_result: { event: ToolResultEvent; result: Maybe<ToolResultPatch> };
	session_stop: { event: SessionStopEvent; result: Maybe<SessionStopResult> };
	context: { event: ContextEvent; result: Maybe<ContextResult> };
}

// ---- tools and commands -----------------------------------------------------------------------------

/** What `pi.exec` resolves with; `killed` is set when omp stopped the process (abort or timeout), and its stdout is then partial. */
export interface HostExecResult {
	stdout: string;
	stderr?: string;
	code: number;
	killed?: boolean;
}

export interface HostToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
	isError?: boolean;
}

export interface HostTool<Params> {
	name: string;
	label: string;
	description: string;
	/** omp's default is `exec`; `read` marks a tool with no side effects. */
	approval?: "read" | "write" | "exec";
	parameters: ZodSchema;
	execute: (toolCallId: string, params: Params, signal: AbortSignal | undefined, onUpdate: unknown, ctx: HostContext) => Promise<HostToolResult>;
}

export interface HostCommand {
	description: string;
	handler: (args: string, ctx: HostContext) => Promise<void>;
}

export interface ExtensionAPI {
	logger?: HostLogger;
	zod: ZodBuilder;
	setLabel: (label: string) => void;
	on: <K extends keyof HostEvents>(
		event: K,
		handler: (event: HostEvents[K]["event"], ctx: HostContext) => HostEvents[K]["result"] | Promise<HostEvents[K]["result"]>,
	) => void;
	registerTool: <Params>(tool: HostTool<Params>) => void;
	registerCommand: (name: string, command: HostCommand) => void;
	/** Returns nothing: delivery is not confirmed, only that the call did not throw. */
	sendMessage: (message: HostMessage, options?: SendMessageOptions) => void;
	exec: (cmd: string, args: string[], opts?: { cwd?: string; signal?: AbortSignal }) => Promise<HostExecResult>;
	/** Absent on hosts that predate it. */
	getActiveTools?: () => string[];
}

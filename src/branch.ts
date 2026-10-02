import { cap, firstLine, inputPaths, isRecord, MASK_HEADROOM, maskedCap, maskedFirstLine, maskedTail, sanitizeValue, stringifyInput } from "./text";

/**
 * The single place omp branch-entry structure is interpreted.
 * Roles are camelCase (`user`, `assistant`, `toolResult`); tool calls are
 * `toolCall` content blocks inside assistant messages.
 */

export interface ToolCallView {
	name: string;
	/** The input as omp recorded it (not copied); previewOf renders it, masked by key as well as by pattern. */
	input: unknown;
	/** First line of the input as JSON, unmasked, kept 4x as long as a prompt shows it (PREVIEW_MAX). */
	inputPreview: string;
	/** `path` / `file_path` input, when the call targets one. */
	path: string | null;
	/** Payload of a `write` call (capped); empty for every other tool. */
	content: string;
	/**
	 * Edits of an `edit` call (capped); empty for every other tool. One line of JSON, except for a call whose whole
	 * input is one patch string (omp's default hashline mode), which is kept as written.
	 */
	editText: string;
	/**
	 * Files an `edit` call without a `path` field names inside its input text (hashline `[PATH#TAG]` headers,
	 * apply_patch headers); empty for every other call.
	 */
	editPaths: string[];
}

export interface MessageView {
	role: string;
	text: string;
	toolName: string | null;
	toolCallId: string | null;
	isError: boolean;
	toolCalls: ToolCallView[];
	/**
	 * `ask` tool results only: omp's structured answer (`selectedOptions`, `customInput`, `note`, `results[]`), as recorded
	 * and not copied; undefined for every other message. The pipeline checks read what the user picked or typed from it.
	 */
	details?: unknown;
}

/**
 * What omp records about a skill run: `custom_message` entries of customType `skill-prompt`, which carry the skill
 * and what the user typed in `details`. A `/skill:<name> args` invocation is one of these, not a `user` message.
 */
export interface SkillPromptView {
	/** `details.name`: the skill that ran. */
	name: string;
	/** `details.args`: what the user typed besides the skill token; "" when there was nothing. */
	args: string;
	/** `details.prompt`: the text as submitted, token in place; "" when omp did not record it. */
	prompt: string;
	/** A user invoked the skill, as opposed to a subagent's hidden autoload of it (agent-attributed, no args or prompt). */
	user: boolean;
}

export interface EntryView {
	/** omp's id for the session entry; null when the entry has none. Unique across the whole session tree. */
	id: string | null;
	type: string;
	customType: string | null;
	content: string;
	message: MessageView | null;
	/** `skill-prompt` `custom_message` entries only: the skill that ran and what the user typed. */
	skill: SkillPromptView | null;
	/** `mode_change` entries only: the mode entered (`plan`, `none`, `plan_paused`, ...). */
	mode: string | null;
	/** `mode_change` entries only: `data.planFilePath`, when omp recorded one. */
	planFilePath: string | null;
}

/** customType of the `custom_message` omp records for a skill run (a `/skill:` invocation, or a subagent's autoload). */
export const SKILL_PROMPT_TYPE = "skill-prompt";

/** Cap on a captured `write` payload; enough for a plan file without keeping whole source files. */
const WRITE_CONTENT_CAP = 8000;
/** Longest preview of a tool call's input in the rendered delta and plan text. */
const PREVIEW_MAX = 160;
/** Cap on the edits of an `edit` call: a revision of a plan file is a few lines, not a rewrite. */
const EDIT_TEXT_CAP = 1200;

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
	if (!record) return null;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function scanToolCall(block: Record<string, unknown>): ToolCallView {
	const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : "tool";
	const input = block.input ?? block.arguments ?? block.args;
	const fields = isRecord(input) ? input : null;
	const written = name === "write" ? fields?.content : undefined;
	const path = stringField(fields, "path", "file_path");
	// omp's default edit mode is hashline: `{ input: string }`, with the target only in the patch's header lines.
	const patch = name === "edit" ? (typeof input === "string" ? input : stringField(fields, "input")) : null;
	const editPaths = patch !== null && path === null ? inputPaths(input) : [];
	return {
		name,
		input,
		inputPreview: firstLine(stringifyInput(input, PREVIEW_MAX * MASK_HEADROOM), PREVIEW_MAX * MASK_HEADROOM),
		path,
		content: typeof written === "string" ? cap(written, WRITE_CONTENT_CAP) : "",
		editText: name === "edit" ? (patch !== null && editPaths.length > 0 ? cap(patch, EDIT_TEXT_CAP) : stringifyInput(input, EDIT_TEXT_CAP)) : "",
		editPaths,
	};
}

function scanMessage(raw: Record<string, unknown>): MessageView {
	const role = typeof raw.role === "string" ? raw.role : "";
	const toolName = typeof raw.toolName === "string" ? raw.toolName : null;
	let text = "";
	const toolCalls: ToolCallView[] = [];
	if (Array.isArray(raw.content)) {
		for (const block of raw.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				text += (text ? "\n" : "") + block.text;
			} else if (block.type === "toolCall") {
				toolCalls.push(scanToolCall(block));
			}
		}
	}
	return {
		role,
		text,
		toolName,
		toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
		isError: raw.isError === true,
		toolCalls,
		details: role === "toolResult" && toolName === "ask" ? raw.details : undefined,
	};
}

function scanSkillPrompt(raw: Record<string, unknown>): SkillPromptView | null {
	const details = isRecord(raw.details) ? raw.details : null;
	const name = stringField(details, "name");
	if (name === null) return null;
	// A user's invocation is attributed `user` and shown; an entry without attribution (older omp) counts as the user's
	// unless it is hidden, which is how a subagent's autoload is recorded.
	const user = typeof raw.attribution === "string" ? raw.attribution === "user" : raw.display !== false;
	return { name, args: stringField(details, "args")?.trim() ?? "", prompt: stringField(details, "prompt")?.trim() ?? "", user };
}

/** Validate and project raw branch entries into a stable view. */
export function scanBranch(branch: unknown): EntryView[] {
	if (!Array.isArray(branch)) return [];
	const out: EntryView[] = [];
	for (const raw of branch) {
		if (!isRecord(raw)) continue;
		const type = typeof raw.type === "string" ? raw.type : "";
		const view: EntryView = {
			id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null,
			type,
			customType: typeof raw.customType === "string" ? raw.customType : null,
			content: typeof raw.content === "string" ? raw.content : "",
			message: type === "message" && isRecord(raw.message) ? scanMessage(raw.message) : null,
			skill: type === "custom_message" && raw.customType === SKILL_PROMPT_TYPE ? scanSkillPrompt(raw) : null,
			mode: type === "mode_change" && typeof raw.mode === "string" ? raw.mode : null,
			planFilePath: type === "mode_change" ? stringField(isRecord(raw.data) ? raw.data : null, "planFilePath") : null,
		};
		out.push(view);
	}
	return out;
}

/**
 * A tool call's input as one line of at most PREVIEW_MAX characters. With `redact` on, the input is masked before it
 * is written out and cut, by object key (everything under `password`, `tokens`, `credentials`, ... at any depth)
 * as well as by pattern, the way an action review's input is: a pattern alone cannot see `{ tokens: ["..."] }`.
 */
function previewOf(call: ToolCallView, redact: boolean): string {
	if (!redact) return maskedCap(call.inputPreview, PREVIEW_MAX, false);
	const masked = sanitizeValue(call.input, true, { maxString: PREVIEW_MAX * MASK_HEADROOM });
	return maskedCap(firstLine(stringifyInput(masked, PREVIEW_MAX * MASK_HEADROOM), PREVIEW_MAX * MASK_HEADROOM), PREVIEW_MAX, true);
}

/**
 * The text helpers below take `redact`: with it on, secrets are masked before a text is cut to its cap, so a
 * cut can never leave the front half of one (maskedCap).
 */

/**
 * The text of a user turn, or "" when the entry is not one (or is blank): a user message's text and, with `skillTurns`, for a
 * skill the user invoked, what they typed besides the skill token (`args`). omp records a `/skill:` invocation as a
 * `skill-prompt` custom message, never as a user message; its `content` is the whole expanded skill body, which is not what the
 * user said. A skill invoked with nothing typed besides its token has no words of the user's: it is no turn, so the task stays
 * the last thing they did say, not the bare `/skill:name` (`details.prompt`).
 *
 * `skillTurns` is `pipeline.skillAware`. Without it (the default) only a user message is a turn, as it was before the pipeline
 * features: a skill invocation is then no user turn at all, whatever its entry holds.
 */
export function userTurnText(e: EntryView, skillTurns = false): string {
	const text = e.type === "message" && e.message?.role === "user" ? e.message.text : skillTurns && e.skill?.user ? e.skill.args : "";
	return text.trim().length > 0 ? text : "";
}

/** Most recent non-empty user turn's text (oldest-to-newest scan backwards): a user message, or with `skillTurns` a skill invocation too. */
export function lastUserText(entries: EntryView[], max = 1200, redact = false, skillTurns = false): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const text = userTurnText(entries[i], skillTurns);
		if (text !== "") return maskedCap(text, max, redact);
	}
	return "";
}

/** Most recent non-empty assistant message text — the claim under review. */
export function claimedIntent(entries: EntryView[], max = 800, redact = false): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "assistant" && e.message.text.trim().length > 0) {
			return maskedCap(e.message.text, max, redact);
		}
	}
	return "";
}

/** Last `count` tool results as "tool: first-line" summaries, oldest first. */
export function priorActions(entries: EntryView[], count: number, redact = false): string[] {
	const out: string[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < count; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "toolResult") {
			out.push(`${e.message.toolName ?? "tool"}: ${maskedFirstLine(e.message.text, 120, redact)}`);
		}
	}
	return out.reverse();
}

/** Render a delta of branch entries for turn review, capped. `skillTurns` is as for `userTurnText`. */
export function renderDelta(entries: EntryView[], max = 6000, redact = false, skillTurns = false): string {
	const lines: string[] = [];
	for (const e of entries) {
		const userText = userTurnText(e, skillTurns);
		if (userText !== "") {
			lines.push(`USER: ${maskedCap(userText, 800, redact)}`);
			continue;
		}
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "assistant") {
			if (m.text.trim().length > 0) lines.push(`ASSISTANT: ${maskedCap(m.text, 1500, redact)}`);
			for (const tc of m.toolCalls) lines.push(`  call ${tc.name}: ${previewOf(tc, redact)}`);
		} else if (m.role === "toolResult") {
			lines.push(`  result ${m.toolName ?? "tool"}${m.isError ? " (error)" : ""}: ${maskedFirstLine(m.text, 200, redact)}`);
		}
	}
	return cap(lines.join("\n"), max);
}

/**
 * `custom` / `custom_message` customTypes that mark plan mode as ON. omp
 * injects `plan-mode-context` on every plan-mode prompt (and `omp --plan-yolo`
 * writes no `mode_change`, so it is the only signal there). Exported so callers
 * and tests can reference the exact marker set instead of duplicating it.
 */
export const PLAN_MODE_MARKERS = ["plan-mode-context"] as const;

/**
 * customTypes that mark plan mode as OFF: `plan-mode-reference` is the
 * execution-phase pointer at the approved plan (omp injects it only when plan
 * mode is disabled) and `plan-yolo-handoff` is the plan-yolo approval that
 * continues into execution in the same run.
 */
export const PLAN_EXIT_MARKERS = ["plan-mode-reference", "plan-yolo-handoff"] as const;

type PlanSignal = "enter" | "exit" | null;

/** Does this entry switch plan mode on, off, or say nothing about it? */
function planSignal(e: EntryView): PlanSignal {
	// omp's context builder keeps the last mode_change's mode as the current one, so
	// anything but "plan" (none, plan_paused, goal, vibe, or a malformed entry) is an exit.
	if (e.type === "mode_change") return e.mode === "plan" ? "enter" : "exit";
	if ((e.type !== "custom" && e.type !== "custom_message") || e.customType === null) return null;
	const customType = e.customType;
	if (PLAN_EXIT_MARKERS.some((marker) => customType.includes(marker))) return "exit";
	if (PLAN_MODE_MARKERS.some((marker) => customType.includes(marker))) return "enter";
	return null;
}

/**
 * Plan-mode detection: the most recent plan signal in the whole branch wins
 * (no entry window, so a long planning turn cannot push its marker out). A
 * `mode_change` to `plan` counts at once, before any prompt has been persisted.
 */
export function planModeActive(entries: EntryView[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const signal = planSignal(entries[i]);
		if (signal !== null) return signal === "enter";
	}
	return false;
}

/**
 * Index (into `entries`) where the current plan began, or -1 when plan mode is not
 * active: the earliest plan-entering entry since the last exit. omp appends another
 * `mode_change` to `plan` mid-plan (at plan approval, when the plan file's path changes),
 * and `--plan-yolo` writes no `mode_change` at all, so entries with no exit between them
 * are one plan, not several.
 */
export function planStartIndex(entries: EntryView[]): number {
	let start = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const signal = planSignal(entries[i]);
		if (signal === null) continue;
		if (signal === "exit") break;
		start = i;
	}
	return start;
}

/** Plan-mode sandbox drafts (`local://<slug>-plan.md`) and the `xd://propose` submission carry the plan itself. */
function isPlanFilePath(path: string | null, known: Set<string>): boolean {
	if (path === null) return false;
	const p = path.trim();
	return known.has(p) || p.startsWith("local://") || p.startsWith("xd://propose");
}

/**
 * The plan as it stands: assistant text, tool-call previews, the content of
 * plan-file writes (latest write per file) and the edits made to plan files since
 * the plan began, newest kept when over `max`. `from` defaults to planStartIndex; no plan yields "".
 */
export function planSoFar(entries: EntryView[], max = 6000, from = planStartIndex(entries), redact = false): string {
	if (from < 0 || from >= entries.length) return "";
	const known = new Set<string>();
	const latestWrite = new Map<string, string>();
	for (let i = from; i < entries.length; i++) {
		const e = entries[i];
		if (e.planFilePath !== null) known.add(e.planFilePath);
		e.message?.toolCalls.forEach((tc, j) => {
			if (tc.name === "write" && tc.content.length > 0 && isPlanFilePath(tc.path, known)) latestWrite.set(tc.path!.trim(), `${i}:${j}`);
		});
	}
	const lines: string[] = [];
	for (let i = from; i < entries.length; i++) {
		const m = entries[i].message;
		if (!m || m.role !== "assistant") continue;
		if (m.text.trim().length > 0) lines.push(`ASSISTANT: ${m.text}`);
		m.toolCalls.forEach((tc, j) => {
			const latest = tc.path === null ? undefined : latestWrite.get(tc.path.trim());
			if (latest === `${i}:${j}`) lines.push(`  write ${tc.path}:\n${tc.content}`);
			else if (latest !== undefined && tc.content.length > 0) lines.push(`  call write: ${tc.path} (superseded by a later write)`);
			// A revision made with `edit` is part of the plan too: show more of it than the one-line preview does. A hashline
			// edit has no `path` field; the file it names is in the patch text.
			else if (tc.editText.length > 0 && isPlanFilePath(tc.path, known)) lines.push(`  edit ${tc.path}: ${tc.editText}`);
			else if (tc.editText.length > 0 && tc.editPaths.some((p) => isPlanFilePath(p, known))) lines.push(`  edit ${tc.editPaths.find((p) => isPlanFilePath(p, known))}: ${tc.editText}`);
			else lines.push(`  call ${tc.name}: ${previewOf(tc, redact)}`);
		});
	}
	return maskedTail(lines.join("\n"), max, redact);
}


/** Shared text helpers and runtime narrowing guards used across the extension. */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A high surrogate with no low one after it, or a low one with no high one before it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Replace lone UTF-16 surrogates with U+FFFD; the API rejects them as invalid Unicode (HTTP 400). */
export function wellFormed(text: string): string {
	return text.replace(LONE_SURROGATE, "�");
}

/** Truncate to at most `max` UTF-16 units without ever leaving half of a surrogate pair. */
export function cap(text: string, max: number): string {
	if (max <= 0) return "";
	let out = text;
	if (text.length > max) {
		out = text.slice(0, max);
		const last = out.charCodeAt(out.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
	}
	return wellFormed(out);
}

export function firstLine(text: string, max: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	return cap(line.trim(), max);
}

/**
 * How many times its cap a text is looked at when masking. Masking an already cut text cannot see a secret that
 * straddles the cut, and the front half of it stays: `ghp_` plus 25 of a token's 36 characters matches nothing.
 */
export const MASK_HEADROOM = 4;
/**
 * Masking can shrink a window a lot (a private-key block becomes `[REDACTED]`), and then the cap lands inside the
 * window's unmasked edge, where a straddling secret is cut in half. So the window grows, MASK_HEADROOM times at a
 * step, until what is left of it holds MASK_MARGIN characters more than the cap, or the whole text is inside. It
 * stops at MASK_GROWTH_LIMIT times the first window, so that a 39 MB unterminated key block is not masked in full.
 */
const MASK_MARGIN = 128;
export const MASK_GROWTH_LIMIT = 16;

/** The most of a text that is ever looked at to produce `max` characters: MASK_GROWTH_LIMIT times the first window. */
function windowLimit(max: number): number {
	return max * MASK_HEADROOM * MASK_GROWTH_LIMIT;
}

/**
 * The start, or the end, of `text` in a window of MASK_HEADROOM times `max`, cleaned (and grown as above). `clean`
 * is what makes the text safe to cut: it masks secrets, and may strip characters too.
 */
function cleanedWindow(text: string, max: number, fromEnd: boolean, clean: (text: string) => string): string {
	const limit = windowLimit(max);
	for (let size = Math.min(max * MASK_HEADROOM, limit); ; size = Math.min(size * MASK_HEADROOM, limit)) {
		const whole = size >= text.length;
		const cleaned = clean(whole ? text : fromEnd ? text.slice(text.length - size) : cap(text, size));
		if (whole || size >= limit || cleaned.length >= max + MASK_MARGIN) return cleaned;
	}
}

/**
 * `cap`, with `clean` (a function that masks secrets, see redactSecrets) applied first to a window of 4x `max` that
 * grows while cleaning shrinks it (see cleanedWindow), so that the cut never splits a secret. Every text that is
 * cut to a cap after masking goes through this, or maskedCap, whatever else it strips.
 */
export function cleanedCap(text: string, max: number, clean: (text: string) => string): string {
	return cap(cleanedWindow(text, max, false, clean), max);
}

/** `cap`, with secrets masked first (in a window of 4x `max`, see cleanedWindow) when `redact` is on, so the cut never splits one. */
export function maskedCap(text: string, max: number, redact: boolean): string {
	return redact ? cleanedCap(text, max, redactSecrets) : cap(text, max);
}

/** `firstLine`, masked before it is cut. Only as much of a long line as masking can look at is ever read. */
export function maskedFirstLine(text: string, max: number, redact: boolean): string {
	const end = text.indexOf("\n");
	const line = (end === -1 ? text : text.slice(0, end)).trimStart();
	// One character past the window, so that a line the window just fits in is still told from a longer one.
	const limit = windowLimit(max) + 1;
	// Trailing whitespace is trimmed off the whole line, so a cut line keeps its own end only when text follows the window.
	const kept = line.length > limit && line.slice(limit).trim() !== "" ? line.slice(0, limit) : line.slice(0, limit).trimEnd();
	return maskedCap(kept, max, redact);
}

/** The last `max` characters of `text`, with secrets masked first (in a window of 4x `max`, see cleanedWindow) when `redact` is on. */
export function maskedTail(text: string, max: number, redact: boolean): string {
	const masked = redact ? cleanedWindow(text, max, true, redactSecrets) : text;
	return masked.length <= max ? masked : masked.slice(masked.length - max);
}

/**
 * Concatenate `text` blocks out of a content array (or pass through a bare string). With `redact`, secrets are
 * masked before the text is cut to `max` (see maskedCap).
 */
export function textFromContent(content: unknown, max: number, redact = false): string {
	if (!Array.isArray(content)) {
		return typeof content === "string" ? maskedCap(content, max, redact) : "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
			parts.push(block.text);
		}
	}
	return maskedCap(parts.join("\n"), max, redact);
}

/** Stable one-line JSON of an arbitrary tool input, capped. */
export function stringifyInput(input: unknown, max: number): string {
	if (input === undefined || input === null) return "";
	let text: string;
	if (typeof input === "string") {
		text = input;
	} else {
		try {
			text = JSON.stringify(input) ?? "";
		} catch {
			text = String(input);
		}
	}
	return cap(text, max);
}

// CSI sequences, OSC sequences (BEL or ST terminated) and two-byte escapes.
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// C0/C1 controls except tab and newline, plus the invisible characters that can hide or reorder text: zero-width
// space, bidi marks and overrides/isolates, word joiner and invisible operators, and the byte-order mark. The
// zero-width joiner and non-joiner (U+200D, U+200C) are not here: they are part of emoji sequences and of
// Persian, Arabic and Indic scripts, so removing them would change legitimate text.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// The invisible characters outside the BMP that carry hidden text: Unicode tag characters (U+E0000 to U+E007F, each
// a hidden twin of an ASCII character: the usual "ASCII smuggling" carrier) and the variation selectors (U+FE00 to
// U+FE0F and U+E0100 to U+E01EF, which can encode bytes). Dropping the selectors costs an emoji its presentation
// hint, and a tag-sequence flag its region; neither matters to a reviewer reading text.
const INVISIBLE_CHARS = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\uFE00-\uFE0F]/gu;

/** Drop ANSI escape sequences and control/invisible characters; keeps tabs and newlines. */
export function stripControl(text: string): string {
	return text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "").replace(INVISIBLE_CHARS, "");
}

/** Escape a value for inclusion in a double-quoted XML-style attribute, on one line. */
export function escapeAttr(value: string): string {
	return wellFormed(stripControl(value))
		.replace(/\s+/g, " ")
		.trim()
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** What a masked secret is replaced with. */
export const REDACTED = "[REDACTED]";
const SECRET_NAME =
	"(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|authorization|credentials?)";
const BARE_VALUE = "[^\\s\"'`,;(){}\\[\\]<>]";
// A quoted value's body, up to the closing quote: any character but that quote (the other quote characters are
// part of the value: `"it's"`) and a newline. A value that is a reference or a placeholder as a whole is not a
// secret and is skipped: `${DB_PASSWORD}`, `{{ secret }}`, `<PASSWORD>`, `%s`, `%(pw)s`. Only those whole shapes are: a
// value that merely starts like one is a value (`"$uper$ecret"`, `"%Tr0ub4dor&3"`, `"<s3cretpass!>"`, `"{hunter2hunter2}"`,
// `"${PREFIX}suffix"`). A JSON-escaped value closes with backslashes before its quote, which QUOTE_END allows. A
// placeholder's name is bounded (100 characters) so that the lookahead cannot rescan a long line from every quote.
// Each body alternative below starts with a character the other cannot, so there is exactly one way to match a text
// and no backtracking blow-up over a long run of backslashes.
const QUOTE_END = "\\\\*[\"'`]";
const QUOTED_SKIP = `(?!\\$\\{[^}\\n]{0,100}\\}${QUOTE_END}|\\{\\{[^}\\n]{0,100}\\}\\}${QUOTE_END}|<[A-Za-z_][\\w .-]{0,100}>${QUOTE_END}|%[sdr]${QUOTE_END}|%\\([^)\\n]{0,100}\\)[sdr]${QUOTE_END})`;
// Plain quotes: a backslash escapes the next character, so `"ab\"cd"` is one value and a backslash never ends it.
// The 4-character minimum is written out: JavaScriptCore spends almost a second on every exec of a counted `{4,}?`
// loop over this alternation, however short the text.
const PLAIN_UNIT = "(?:\\\\.|(?!\\2)[^\\\\\\n])";
const PLAIN_BODY = `${PLAIN_UNIT.repeat(4)}${PLAIN_UNIT}*?`;
// Quotes that were JSON-escaped (`\"secret\"`): the backslashes before the closing quote belong to the match, and in
// the text a backslash is just a character.
const ESCAPED_BODY = "(?:(?!\\3)[^\\n]){4,}?";
// A bare value is judged on its first characters: a lookahead over a whole run backtracks quadratically over a chain
// of `token:token:...`, and a secret with no digit or symbol in its first 200 characters is not one.
const BARE_LOOKAHEAD = 200;
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED],
	// A vendor prefix may follow an underscore (`id_sk_live_...`, `key_AKIA...`, where `\b` finds no boundary) but not a
	// letter or digit: `task_live_deployment` is not a key.
	[/(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, REDACTED],
	// These prefixes are specific enough to need no word boundary before them, and a token glued to the word before it
	// (`TOKENghp_...`) would otherwise pass whole.
	[/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g, REDACTED],
	[/xox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
	[/(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
	[/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, REDACTED],
	[/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, REDACTED],
	// Only at the start of a run of base64url characters: a `\b` would also start a match at every `-eyJ` inside one,
	// and each of those scans the whole run (quadratic over a long `eyJ-eyJ-...`).
	[/eyJ(?<![A-Za-z0-9_]-*eyJ)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${REDACTED}`],
	// `Authorization: Token ...`, `ApiKey ...`: as long and as digit-bearing as a credential, so prose about a token is spared.
	[/\b(Token|ApiKey|Api-Key)\s+(?=[A-Za-z0-9._~+/=-]{0,200}[0-9])[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${REDACTED}`],
	[/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,512}@/gi, `$1${REDACTED}@`],
	// `password = "hunter2"`, `"api_key": "..."`: any quoted value of a secret-named key, also when the text was
	// JSON-stringified already (`\"password\": \"...\"`). No unbounded prefix before the name (the key's own
	// prefix is outside the match and stays as it is) and a bounded suffix: both backtrack quadratically over a
	// long run of word characters.
	[new RegExp(`(${SECRET_NAME}[\\w-]{0,40}(?:\\\\*["'])?\\s*[:=]\\s*)(["'\`])${QUOTED_SKIP}${PLAIN_BODY}\\2`, "gi"), `$1$2${REDACTED}$2`],
	[new RegExp(`(${SECRET_NAME}[\\w-]{0,40}(?:\\\\*["'])?\\s*[:=]\\s*)(\\\\+)(["'\`])${QUOTED_SKIP}${ESCAPED_BODY}\\3`, "gi"), `$1$2$3${REDACTED}$2$3`],
	// `PASSWORD=hunter2hunter2`: unquoted, 8+ chars, with a digit or symbol so `token: string` survives.
	[new RegExp(`(${SECRET_NAME}[\\w-]{0,40}\\s*[:=]\\s*)(?=${BARE_VALUE}{0,${BARE_LOOKAHEAD}}[0-9+/=~!@#$%^&*])${BARE_VALUE}{8,}`, "gi"), `$1${REDACTED}`],
];

const SECRET_KEY = new RegExp(SECRET_NAME, "i");

/** Does an object key name a secret (`password`, `db_password`, `api_key`, `accessToken`, `credentials`, ...)? */
export function isSecretKey(key: string): boolean {
	return SECRET_KEY.test(key);
}

/**
 * Mask obvious secrets (private keys, cloud/API tokens, JWTs, bearer headers, URL credentials,
 * `secret=value` assignments). Best-effort pattern matching, not a guarantee.
 */
export function redactSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

export function fmt2(value: number): string {
	return value.toFixed(2);
}

// `*** Update File: x` headers of omp's apply_patch format and `+++ b/x` lines of a unified diff.
const PATCH_FILE = /^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ (?:b\/)?)(.+)$/gm;
/** Header lines are read from the start of an edit; a hashline patch past this size names its targets long before. */
const HASHLINE_SCAN_CAP = 100_000;
const PATH_FIELDS = ["path", "file_path", "filePath", "file", "notebook_path"] as const;
const PATH_LIST_FIELDS = ["paths", "files"] as const;
const PATCH_FIELDS = ["input", "patch", "diff"] as const;

/** Files named by patch text, in order. */
export function patchFiles(text: string): string[] {
	const files: string[] = [];
	for (const match of text.matchAll(PATCH_FILE)) {
		const file = match[1].trim();
		if (file.length > 0 && file !== "/dev/null") files.push(file);
	}
	return files;
}

/**
 * Files named by the `[PATH#TAG]` header lines of omp's hashline edit mode (the legacy form is `¶PATH#TAG`), in
 * order. In that mode the whole edit is one `{ input }` string, and the headers are the only place the targets
 * appear. Body rows of a patch start with `+`, so a header line is never mistaken for content.
 */
export function hashlineFiles(text: string): string[] {
	const files: string[] = [];
	for (const rawLine of text.slice(0, HASHLINE_SCAN_CAP).split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		let body: string;
		if (line.startsWith("[") && line.endsWith("]")) body = line.slice(1, -1);
		else if (line.trimStart().startsWith("\u00b6")) body = line.trimStart().replace(/^\u00b6+/, "");
		else continue;
		let file = body.trim().replace(/#[0-9a-fA-F]{4}$/, "");
		if (file.length > 1 && (file[0] === '"' || file[0] === "'") && file[0] === file[file.length - 1]) file = file.slice(1, -1);
		if (file.length > 0) files.push(file);
	}
	return files;
}

/** Tools whose input names the files they edit, so the evidence can start with those diffs and the reviewer can tell two edits of one file from two files. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "apply_patch", "ast_edit", "notebook"]);

export interface InputPathsOptions {
	/**
	 * Read `[PATH#TAG]` header lines out of patch text. Default true. A line of the form `[..]` is a header only in an
	 * edit's patch; in another tool's `input` it is just text (`[1, 2, 3]`, `[ -f x ]`), so a caller that knows the
	 * tool turns this off for tools outside EDIT_TOOLS.
	 */
	hashline?: boolean;
}

/**
 * The paths an edit-class tool input targets, each once, in order: path-style fields, path lists, and the files
 * named in patch text: apply_patch headers and unified diffs, and the `[PATH#TAG]` headers of omp's default
 * hashline mode, where the whole edit is `{ input: "[src/a.ts#A1B2]\nPUT ..." }`. A bare string is patch text
 * itself. Both the evidence focus and the reviewer's dedupe identity read inputs through this.
 */
export function inputPaths(input: unknown, options: InputPathsOptions = {}): string[] {
	const hashline = options.hashline !== false;
	const paths = new Set<string>();
	const add = (value: unknown): void => {
		const text = typeof value === "string" ? value.trim() : "";
		if (text.length > 0 && text !== "/dev/null") paths.add(text);
	};
	const addPatch = (text: string): void => {
		for (const file of patchFiles(text)) add(file);
		if (hashline) for (const file of hashlineFiles(text)) add(file);
	};
	if (typeof input === "string") {
		addPatch(input);
	} else if (isRecord(input)) {
		for (const key of PATH_FIELDS) add(input[key]);
		for (const key of PATH_LIST_FIELDS) {
			const list = input[key];
			if (Array.isArray(list)) for (const item of list) add(item);
		}
		for (const key of PATCH_FIELDS) {
			const text = input[key];
			if (typeof text === "string") addPatch(text);
		}
	}
	return [...paths];
}

/** Nesting depth below which sanitizeValue stops walking objects and masks the rest as one string. */
const MAX_SANITIZE_DEPTH = 32;
/** A string under a secret-named key is masked from this length on (the quoted-value pattern's minimum). */
const SECRET_STRING_MIN = 4;
/** A number under a secret-named key is masked from this many digits on, so `max_tokens: 1500` survives. */
const SECRET_NUMBER_MIN = 8;

export interface SanitizeOptions {
	/** Mask the whole value under an object key that names a secret (`password`, `api_key`, ...). Default true. */
	keyAware?: boolean;
	/** Cut every string to this many characters before it is masked, to bound the work on a huge value. */
	maxString?: number;
}

/** Does a value under a secret-named key get masked: a long enough string or number, or anything nested. */
function maskableUnderSecretKey(item: unknown): boolean {
	if (typeof item === "string") return item.length >= SECRET_STRING_MIN;
	if (typeof item === "number") return String(item).length >= SECRET_NUMBER_MIN;
	return item !== null && typeof item === "object";
}

/**
 * Last line of defence before text leaves for api.typesafe.ai: repair lone surrogates (the API rejects
 * them with a 400) and, unless adversary.redact is off, mask obvious secrets. A value under an object key that
 * names a secret is masked whole, at any depth, whatever shape it has; any other string, and every object key, is
 * masked by pattern. Best-effort.
 */
export function sanitizeValue(value: unknown, redact: boolean, options: SanitizeOptions = {}, depth = 0, secret = false): unknown {
	if (typeof value === "string") {
		if (secret && value.length >= SECRET_STRING_MIN) return REDACTED;
		const text = options.maxString === undefined ? value : cap(value, options.maxString);
		return wellFormed(redact ? redactSecrets(text) : text);
	}
	if (typeof value === "number") return secret && String(value).length >= SECRET_NUMBER_MIN ? REDACTED : value;
	if (value === null || typeof value !== "object") return value;
	// Real states are shallow and JSON-derived. A runaway depth (or a cycle) is not walked: whatever is below the
	// limit is flattened to text and masked as one string, so nothing deeper can carry a secret out.
	if (depth >= MAX_SANITIZE_DEPTH) {
		if (secret) return REDACTED;
		let flat: string;
		try {
			// The same rule for secret-named keys as above, applied while the value is written out.
			const mask = redact && options.keyAware !== false ? (key: string, item: unknown) => (isSecretKey(key) && maskableUnderSecretKey(item) ? REDACTED : item) : undefined;
			flat = JSON.stringify(value, mask) ?? "";
		} catch {
			flat = "[unserializable value]";
		}
		return wellFormed(redact ? redactSecrets(flat) : flat);
	}
	if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, redact, options, depth + 1, secret));
	if (isRecord(value)) {
		const keyAware = redact && options.keyAware !== false;
		const names = new Set<string>();
		// The next free suffix of each masked name, so N keys that mask alike cost N lookups, not N^2.
		const nextSuffix = new Map<string, number>();
		const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
			// A key is text the model or a file wrote, so it is masked by pattern like any string (a token used as a map
			// key, a question id, an option name). The key-name rule reads the original, unmasked key.
			const text = options.maxString === undefined ? key : cap(key, options.maxString);
			const masked = wellFormed(redact ? redactSecrets(text) : text);
			// Two keys that mask to the same text must not overwrite each other.
			let name = masked;
			if (names.has(name)) {
				let n = nextSuffix.get(masked) ?? 2;
				while (names.has(`${masked}#${n}`)) n++;
				name = `${masked}#${n}`;
				nextSuffix.set(masked, n + 1);
			}
			names.add(name);
			return [name, sanitizeValue(item, redact, options, depth + 1, secret || (keyAware && isSecretKey(key)))];
		});
		return Object.fromEntries(entries);
	}
	return value;
}

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDir as resolveAgentDir } from "./config";
import type { TypesafeRole } from "./config";

/**
 * ADVERSARY.md / WATCHDOG.md review priorities discovery. Files are ranked most specific first:
 * <cwd>/.omp/<fname>, <cwd>/<fname>, then each parent up to the git root (or $HOME), then the
 * user-level file in the agent dir. Every file gets a share of one shared budget, so a long
 * user-level file cannot crowd out repo- or package-level rules. Missing files are normal.
 */

export const TOTAL_CAP = 2000;
/** Never slice a file thinner than this; the least specific files are dropped instead. */
const MIN_FILE_CHARS = 80;
const SEPARATOR = "\n\n";
const TRUNCATION_MARK = "\n[truncated]";

export interface PriorityLocations {
	/** Directory the ancestor walk stops at. Default: the user's home. */
	home?: string;
	/** User-level priority file directory. Default: omp's agent dir (honors PI_CODING_AGENT_DIR). */
	agentDir?: string;
}

/**
 * Directories to read for `cwd`, cwd first. The walk stops at `home` or at a git root. When it reaches
 * the filesystem root without meeting either, only `cwd` itself is trusted: ancestors such as /tmp
 * are shared locations other users can write to, and their text would be sent to Jev as priorities.
 */
export function ancestorDirs(cwd: string, home: string = homedir()): string[] {
	const stop = resolve(home);
	const start = resolve(cwd || stop);
	const out: string[] = [];
	let dir = start;
	for (let i = 0; i < 64; i++) {
		out.push(dir);
		if (dir === stop || existsSync(join(dir, ".git"))) return out;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [start];
}

function priorityFileName(role: TypesafeRole): string {
	return role === "advisory" ? "WATCHDOG.md" : "ADVERSARY.md";
}

/** Candidate priority file paths for `cwd` and `role`, most specific first, without duplicates. */
export function priorityFiles(cwd: string, role: TypesafeRole = "adversarial", loc: PriorityLocations = {}): string[] {
	const fname = priorityFileName(role);
	const files: string[] = [];
	for (const dir of ancestorDirs(cwd, loc.home)) {
		files.push(join(dir, ".omp", fname), join(dir, fname));
	}
	files.push(join(loc.agentDir ?? resolveAgentDir(), fname));
	return [...new Set(files.map((path) => resolve(path)))];
}

/** Split `budget` characters across files of the given lengths: short files keep everything, long ones share the rest evenly. */
function allocate(lengths: number[], budget: number): number[] {
	const out = lengths.map(() => 0);
	let open = lengths.map((_, i) => i);
	let remaining = budget;
	while (open.length > 0) {
		const share = Math.floor(remaining / open.length);
		const fits = open.filter((i) => lengths[i] <= share);
		if (fits.length === 0) {
			for (const i of open) out[i] = share;
			break;
		}
		for (const i of fits) {
			out[i] = lengths[i];
			remaining -= lengths[i];
		}
		open = open.filter((i) => !fits.includes(i));
	}
	return out;
}

/** Cut `text` to `max` chars at a line boundary when that keeps most of it, ending with a visible marker. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const room = Math.max(0, max - TRUNCATION_MARK.length);
	let head = text.slice(0, room);
	const newline = head.lastIndexOf("\n");
	if (newline >= room / 2) head = head.slice(0, newline);
	return `${head.trimEnd()}${TRUNCATION_MARK}`;
}

/**
 * Join priority texts (most specific first) into at most `cap` characters. Each text is cut to its
 * share of the budget with a marker; when too many files would each get under MIN_FILE_CHARS, the
 * least specific ones are dropped.
 */
export function composePriorities(texts: string[], cap: number = TOTAL_CAP): string {
	const kept = texts.map((text) => text.trim()).filter((text) => text.length > 0);
	const budgetFor = (count: number) => cap - SEPARATOR.length * (count - 1);
	while (kept.length > 1 && budgetFor(kept.length) / kept.length < MIN_FILE_CHARS) kept.pop();
	if (kept.length === 0) return "";
	const shares = allocate(kept.map((text) => text.length), budgetFor(kept.length));
	return kept.map((text, i) => truncate(text, shares[i] ?? 0)).join(SEPARATOR);
}

/** Collect priority files for the given role, most specific first; empty string when none exist. */
export async function loadPriorities(cwd: string, role: TypesafeRole = "adversarial", loc: PriorityLocations = {}): Promise<string> {
	const texts: string[] = [];
	for (const path of priorityFiles(cwd, role, loc)) {
		try {
			// Bound the read: a stray huge file must not be pulled into memory just to be cut to its share.
			texts.push(await Bun.file(path).slice(0, TOTAL_CAP * 4).text());
		} catch {
			// Missing or unreadable priority files are normal.
		}
	}
	return composePriorities(texts);
}

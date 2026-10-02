import { createHash } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DIFF_FLAGS } from "../../src/evidence";

async function git(args: string[], cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { status, stdout, stderr };
}

async function run(args: string[], cwd: string): Promise<void> {
	const r = await git(args, cwd);
	if (r.status !== 0) {
		throw new Error(`command failed in ${cwd}: git ${args.join(" ")}\n${r.stderr}`);
	}
}

/**
 * Copy a fixture dir into a fresh temp repo and commit it, so grading can diff against
 * the seed: the `bench-seed` tag set here, which a graded repo keeps pointing at the seed
 * commit even if the agent commits, amends or rewrites history (grade-common falls back
 * to the oldest root commit when the tag is missing, e.g. in results from older runs).
 * Any existing destDir is replaced, so re-preparing the same cell never trips on
 * "nothing to commit". Signing and hooks are disabled so a global git config cannot
 * make the seed commit or the tag fail.
 */
export async function prepareFixture(fixtureDir: string, destDir: string): Promise<void> {
	await rm(destDir, { recursive: true, force: true });
	await cp(fixtureDir, destDir, { recursive: true });
	await run(["init", "-q"], destDir);
	await run(["config", "user.email", "bench@example.com"], destDir);
	await run(["config", "user.name", "bench"], destDir);
	await run(["add", "-A"], destDir);
	await run(["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "seed fixture"], destDir);
	await run(["-c", "tag.gpgSign=false", "tag", "bench-seed"], destDir);
}

/**
 * What the provenance hash reads git's output through. DIFF_FLAGS switch off the programs a user's config would run;
 * these pin the options that merely reshape the text, which a config can change without any change to the code: the
 * path prefixes (`diff.noprefix`, `diff.mnemonicPrefix`), rename detection (also in `git status`), the amount of
 * context, the algorithm, the hunk heuristics, the order of the files (`diff.orderFile`), how a blank context line is
 * written (`diff.suppressBlankEmpty`), the length of the hashes on an `index` line (`core.abbrev`, and the length git
 * picks by itself from the number of objects), and (through `-c`) how a non-ASCII path is quoted. Two machines hashing
 * the same tree must agree. Settings outside this list (a global attributes file that marks a path binary or gives
 * it a hunk-header pattern, for one) are not pinned.
 */
const PROVENANCE_DIFF_FLAGS = [
	...DIFF_FLAGS,
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"--no-renames",
	"--unified=3",
	"--diff-algorithm=myers",
	"--inter-hunk-context=0",
	"--indent-heuristic",
	"--full-index",
	// An empty order file: the files come in git's own order, whatever diff.orderFile names.
	"-O/dev/null",
];
const PROVENANCE_GIT_CONFIG = ["-c", "core.quotePath=false", "-c", "diff.suppressBlankEmpty=false"];

export interface GitProvenance {
	/** `git rev-parse HEAD`, or null when `repoRoot` is not a git checkout. */
	head: string | null;
	/** True when any of the tracked paths has uncommitted changes (or untracked files under them). */
	dirty: boolean;
	/** `git status --porcelain` lines for the tracked paths, capped at 50. */
	dirtyFiles: string[];
	/**
	 * sha256 over `git diff HEAD` and the name and bytes of every untracked file (ignored files aside) under the
	 * tracked paths, null when clean: distinguishes two runs on different dirty trees.
	 */
	diffSha: string | null;
}

/**
 * Identifies the exact code a bench run measured: HEAD plus a fingerprint of any
 * uncommitted change under `paths` (the extension source and the pinned bench config).
 */
export async function gitProvenance(repoRoot: string, paths: string[]): Promise<GitProvenance> {
	let head: string | null = null;
	try {
		const r = await git(["rev-parse", "HEAD"], repoRoot);
		if (r.status === 0) head = r.stdout.trim() || null;
	} catch {
		// git missing or not a repo: provenance is simply unknown
	}
	if (!head) return { head: null, dirty: false, dirtyFiles: [], diffSha: null };

	// `--untracked-files=all` because the user's status.showUntrackedFiles=no would otherwise report a new, untracked module as clean.
	const status = await git([...PROVENANCE_GIT_CONFIG, "status", "--porcelain", "--no-renames", "--untracked-files=all", "--", ...paths], repoRoot);
	const dirtyFiles = status.stdout.split("\n").filter((l) => l.trim().length > 0);
	if (dirtyFiles.length === 0) return { head, dirty: false, dirtyFiles: [], diffSha: null };

	// Without these flags a user's diff.external or textconv decides what is hashed (an external tool that prints git's
	// temp-file paths gives a new hash on every call, an interactive one stalls), as src/evidence.ts guards against.
	const diff = await git([...PROVENANCE_GIT_CONFIG, "diff", ...PROVENANCE_DIFF_FLAGS, "HEAD", "--", ...paths], repoRoot);
	const hash = createHash("sha256").update(`${diff.stdout}\n${dirtyFiles.join("\n")}\n`);
	// `git diff` never shows an untracked file, so its content is hashed here: an edit to a file that is not
	// committed yet (a new module, the pinned bench config before it is added) must change the fingerprint.
	const listed = await git(["ls-files", "-o", "--exclude-standard", "-z", "--", ...paths], repoRoot);
	for (const file of listed.stdout.split("\0").filter((f) => f.length > 0).sort()) {
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await Bun.file(join(repoRoot, file)).arrayBuffer());
		} catch {
			bytes = new Uint8Array(); // vanished or unreadable: its name alone still counts
		}
		hash.update(`untracked ${file} ${bytes.length}\n`).update(bytes).update("\n");
	}
	return { head, dirty: true, dirtyFiles: dirtyFiles.slice(0, 50), diffSha: hash.digest("hex") };
}

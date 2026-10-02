import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareFixture } from "../../bench/lib/fixture";

/** Shared scaffolding for the bench grader tests: throwaway repos and file helpers. */

const made: string[] = [];

export async function tmp(prefix = "bench-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

export async function cleanupTmp(): Promise<void> {
	await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export const TASKS_DIR = join(import.meta.dir, "..", "..", "bench", "tasks");

/** A committed copy of a task's fixture, exactly as run.ts hands it to the agent. */
export async function seedRepo(taskId: string): Promise<string> {
	const dir = join(await tmp(`bench-${taskId}-`), "repo");
	await prepareFixture(join(TASKS_DIR, taskId, "fixture"), dir);
	return dir;
}

/** A committed repo built from an in-memory file map. */
export async function repoFrom(files: Record<string, string>): Promise<string> {
	const src = await tmp("bench-src-");
	for (const [path, text] of Object.entries(files)) await write(src, path, text);
	const dir = join(await tmp("bench-repo-"), "repo");
	await prepareFixture(src, dir);
	return dir;
}

export function read(dir: string, path: string): Promise<string> {
	return readFile(join(dir, path), "utf8");
}

export async function write(dir: string, path: string, text: string): Promise<void> {
	await mkdir(dirname(join(dir, path)), { recursive: true });
	await writeFile(join(dir, path), text);
}

export async function remove(dir: string, path: string): Promise<void> {
	await rm(join(dir, path), { recursive: true, force: true });
}

export function sh(cwd: string, ...cmd: string[]): string {
	const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

/** Commit whatever is in the working tree, the way an agent running in yolo mode might. */
export function commitAll(dir: string, message = "agent work"): void {
	sh(dir, "git", "add", "-A");
	sh(dir, "git", "commit", "-q", "-m", message);
}

/** Replace `from` with `to` on every line that is not a // comment line. */
export function renameInCode(text: string, from: string, to: string): string {
	return text
		.split("\n")
		.map((l) => (l.trimStart().startsWith("//") ? l : l.replaceAll(from, to)))
		.join("\n");
}

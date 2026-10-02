import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitProvenance, prepareFixture } from "../../bench/lib/fixture";
import { cleanupTmp, makeTmp, REPO } from "./helpers";

afterAll(cleanupTmp);

async function git(args: string[], cwd: string): Promise<string> {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return out.trim();
}

function makeFixture(): string {
	const dir = makeTmp("fixture");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "package.json"), "{}\n");
	return dir;
}

describe("prepareFixture", () => {
	test("copies the fixture into a committed repo with a clean tree", async () => {
		const dest = join(makeTmp("dest"), "repo");
		await prepareFixture(makeFixture(), dest);
		expect(existsSync(join(dest, "src", "a.ts"))).toBe(true);
		expect(await git(["log", "--format=%s"], dest)).toBe("seed fixture");
		expect(await git(["status", "--porcelain"], dest)).toBe("");
	});

	test("preparing the same destination twice replaces it instead of failing on 'nothing to commit'", async () => {
		const dest = join(makeTmp("dest"), "repo");
		const fixture = makeFixture();
		await prepareFixture(fixture, dest);
		writeFileSync(join(dest, "stale.txt"), "left over from the first prepare\n");
		await prepareFixture(fixture, dest);
		expect(existsSync(join(dest, "stale.txt"))).toBe(false);
		expect(await git(["rev-list", "--count", "HEAD"], dest)).toBe("1");
	});

	test("a global commit.gpgsign=true or tag.gpgSign=true cannot make the seed commit or its tag fail", async () => {
		// Run in a subprocess whose environment carries the hostile global git config.
		const tmp = makeTmp("gitcfg");
		const gitconfig = join(tmp, "gitconfig");
		writeFileSync(gitconfig, "[commit]\n\tgpgsign = true\n[tag]\n\tgpgSign = true\n[gpg]\n\tprogram = /usr/bin/false\n");
		const script = join(tmp, "prepare.ts");
		writeFileSync(script, `import { prepareFixture } from ${JSON.stringify(join(REPO, "bench", "lib", "fixture.ts"))};\nawait prepareFixture(process.argv[2], process.argv[3]);\n`);
		const dest = join(makeTmp("dest"), "repo");
		const proc = Bun.spawn([process.execPath, script, makeFixture(), dest], { env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig }, stdout: "pipe", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(stderr).not.toContain("gpg failed");
		expect(code).toBe(0);
		expect(await git(["rev-list", "--count", "HEAD"], dest)).toBe("1");
		expect(await git(["rev-parse", "bench-seed"], dest)).toBe(await git(["rev-parse", "HEAD"], dest));
	});

	test("the seed is tagged bench-seed, and the tag stays on the seed when the agent commits (grade-common diffs against it)", async () => {
		const dest = join(makeTmp("dest"), "repo");
		await prepareFixture(makeFixture(), dest);
		const seed = await git(["rev-parse", "HEAD"], dest);
		expect(await git(["rev-parse", "bench-seed^{commit}"], dest)).toBe(seed);
		writeFileSync(join(dest, "src", "a.ts"), "export const a = 2;\n");
		await git(["add", "-A"], dest);
		await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "agent work"], dest);
		expect(await git(["rev-parse", "HEAD"], dest)).not.toBe(seed);
		expect(await git(["rev-parse", "bench-seed"], dest)).toBe(seed);
		// a lightweight tag: nothing to sign, no tag message to prompt for
		expect(await git(["cat-file", "-t", "bench-seed"], dest)).toBe("commit");
	});

	test("rejects when the fixture directory does not exist", async () => {
		await expect(prepareFixture(join(makeTmp("missing"), "no-such-fixture"), join(makeTmp("dest"), "repo"))).rejects.toThrow();
	});
});

describe("gitProvenance", () => {
	async function makeRepo(): Promise<string> {
		const dir = makeFixture();
		await git(["init", "-q"], dir);
		await git(["config", "user.email", "t@example.com"], dir);
		await git(["config", "user.name", "t"], dir);
		await git(["add", "-A"], dir);
		await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], dir);
		return dir;
	}

	test("a clean tree reports HEAD and not dirty", async () => {
		const dir = await makeRepo();
		const p = await gitProvenance(dir, ["src", "package.json"]);
		expect(p.head).toBe(await git(["rev-parse", "HEAD"], dir));
		expect(p).toMatchObject({ dirty: false, dirtyFiles: [], diffSha: null });
	});

	test("uncommitted changes are flagged and fingerprinted, and different changes fingerprint differently", async () => {
		const dir = await makeRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const first = await gitProvenance(dir, ["src", "package.json"]);
		expect(first.dirty).toBe(true);
		expect(first.dirtyFiles.join("\n")).toContain("src/a.ts");
		expect(first.diffSha).toMatch(/^[0-9a-f]{64}$/);
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
		const second = await gitProvenance(dir, ["src", "package.json"]);
		expect(second.diffSha).not.toBe(first.diffSha);
	});

	// `git diff HEAD` does not show untracked files: a new module, or the bench config before it is committed.
	test("editing an untracked file changes the fingerprint; identical content fingerprints identically", async () => {
		const dir = await makeRepo();
		writeFileSync(join(dir, "src", "host.ts"), "export const v = 1;\n");
		const v1 = await gitProvenance(dir, ["src", "package.json"]);
		writeFileSync(join(dir, "src", "host.ts"), "export const v = 2;\n");
		const v2 = await gitProvenance(dir, ["src", "package.json"]);
		writeFileSync(join(dir, "src", "host.ts"), "export const v = 1;\n");
		const again = await gitProvenance(dir, ["src", "package.json"]);
		expect(v1.diffSha).toMatch(/^[0-9a-f]{64}$/);
		expect(v2.diffSha).not.toBe(v1.diffSha);
		expect(again.diffSha).toBe(v1.diffSha);
	});

	test("an untracked file's path and the set of untracked files both count, and ignored files do not", async () => {
		const dir = await makeRepo();
		writeFileSync(join(dir, "src", "one.ts"), "export {};\n");
		const one = await gitProvenance(dir, ["src", "package.json"]);
		writeFileSync(join(dir, "src", "renamed.ts"), "export {};\n");
		await Bun.spawn(["rm", join(dir, "src", "one.ts")]).exited;
		const renamed = await gitProvenance(dir, ["src", "package.json"]);
		expect(renamed.diffSha).not.toBe(one.diffSha);
		writeFileSync(join(dir, "src", "extra.ts"), "export const x = 1;\n");
		const more = await gitProvenance(dir, ["src", "package.json"]);
		expect(more.diffSha).not.toBe(renamed.diffSha);
		writeFileSync(join(dir, ".gitignore"), "src/ignored.ts\n");
		const ignoring = await gitProvenance(dir, ["src", "package.json", ".gitignore"]);
		writeFileSync(join(dir, "src", "ignored.ts"), "export const noise = 1;\n");
		expect((await gitProvenance(dir, ["src", "package.json", ".gitignore"])).diffSha).toBe(ignoring.diffSha);
	});

	// `git status` follows the user's status.showUntrackedFiles; with `no` an untracked-only change used to read as clean.
	test("a git config that hides untracked files from status does not hide them from the fingerprint", async () => {
		const dir = await makeRepo();
		await git(["config", "status.showUntrackedFiles", "no"], dir);
		writeFileSync(join(dir, "src", "host.ts"), "export const v = 1;\n");
		const v1 = await gitProvenance(dir, ["src", "package.json"]);
		expect(v1.dirty).toBe(true);
		expect(v1.dirtyFiles.join("\n")).toContain("src/host.ts");
		expect(v1.diffSha).toMatch(/^[0-9a-f]{64}$/);
		writeFileSync(join(dir, "src", "host.ts"), "export const v = 2;\n");
		expect((await gitProvenance(dir, ["src", "package.json"])).diffSha).not.toBe(v1.diffSha);
	});

	// A user's diff.external runs for `git diff` unless it is switched off; one that prints git's temp-file paths gives a
	// new text on every call, and every cell row of a run would then carry a different fingerprint.
	test("a diff.external or textconv in the user's git config does not change what is hashed", async () => {
		const dir = await makeRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const wrapper = join(makeTmp("extdiff"), "extdiff.sh");
		writeFileSync(wrapper, '#!/bin/sh\necho "ext-diff $1 $2 $5 $$"\n');
		chmodSync(wrapper, 0o755);
		await git(["config", "diff.external", wrapper], dir);
		await git(["config", "diff.fake.textconv", "echo converted"], dir);
		writeFileSync(join(dir, ".gitattributes"), "*.ts diff=fake\n");
		const first = await gitProvenance(dir, ["src", "package.json", ".gitattributes"]);
		const second = await gitProvenance(dir, ["src", "package.json", ".gitattributes"]);
		expect(first.diffSha).toMatch(/^[0-9a-f]{64}$/);
		expect(second.diffSha).toBe(first.diffSha);
		// ...and the hash is the one the same tree has with no such config at all (.gitattributes is untracked: its bytes count).
		await git(["config", "--unset", "diff.external"], dir);
		await git(["config", "--unset", "diff.fake.textconv"], dir);
		expect((await gitProvenance(dir, ["src", "package.json", ".gitattributes"])).diffSha).toBe(first.diffSha);
	});

	// The same dirty tree must fingerprint the same on every machine: a config that only reshapes git's diff text
	// (path prefixes, renames, context, algorithm, file order, blank context lines, the length of the hashes on an `index`
	// line, quoting of a non-ASCII path) is no change to the code.
	test("git config that only reshapes the diff text does not change the fingerprint", async () => {
		const dir = await makeRepo();
		// A blank line inside the changed region is a blank context line (`diff.suppressBlankEmpty` writes it without its space).
		const lines = (middle: string) => `${["one", "two", "", "three", "four", middle, "", "six", "seven", "eight", "nine", "ten"].join("\n")}\n`;
		writeFileSync(join(dir, "src", "b.ts"), lines("five"));
		writeFileSync(join(dir, "src", "r\u00e9sum\u00e9.ts"), "export const accent = 1;\n");
		await git(["add", "-A"], dir);
		await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "more files"], dir);
		writeFileSync(join(dir, "src", "b.ts"), lines("FIVE"));
		writeFileSync(join(dir, "src", "r\u00e9sum\u00e9.ts"), "export const accent = 2;\n");
		await git(["mv", "src/a.ts", "src/moved.ts"], dir);
		const paths = ["src", "package.json"];
		const baseline = await gitProvenance(dir, paths);
		expect(baseline.diffSha).toMatch(/^[0-9a-f]{64}$/);
		// An order file that puts the r\u00e9sum\u00e9 first, where git's own order has b.ts before it.
		const orderFile = join(makeTmp("order"), "order.txt");
		writeFileSync(orderFile, "src/r*\nsrc/moved.ts\n");
		const settings: Array<[string, string]> = [
			["diff.noprefix", "true"],
			["diff.mnemonicPrefix", "true"],
			["diff.srcPrefix", "x/"],
			["diff.dstPrefix", "y/"],
			["diff.renames", "false"],
			["diff.context", "0"],
			["diff.algorithm", "patience"],
			["diff.interHunkContext", "9"],
			["diff.indentHeuristic", "false"],
			["core.abbrev", "12"],
			["core.abbrev", "4"],
			["diff.suppressBlankEmpty", "true"],
			["diff.orderFile", orderFile],
			["core.quotePath", "false"],
			["core.quotePath", "true"],
		];
		for (const [key, value] of settings) {
			await git(["config", key, value], dir);
			expect([key, value, (await gitProvenance(dir, paths)).diffSha]).toEqual([key, value, baseline.diffSha]);
			await git(["config", "--unset", key], dir);
		}
		// All at once, and the fingerprint still tells a different edit apart.
		for (const [key, value] of settings.filter(([key]) => key !== "core.quotePath" && key !== "core.abbrev")) await git(["config", key, value], dir);
		await git(["config", "core.abbrev", "12"], dir);
		expect((await gitProvenance(dir, paths)).diffSha).toBe(baseline.diffSha);
		writeFileSync(join(dir, "src", "b.ts"), lines("5"));
		expect((await gitProvenance(dir, paths)).diffSha).not.toBe(baseline.diffSha);
	});

	test("tracked edits and untracked edits are fingerprinted together", async () => {
		const dir = await makeRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		writeFileSync(join(dir, "src", "new.ts"), "export const n = 1;\n");
		const both = await gitProvenance(dir, ["src", "package.json"]);
		writeFileSync(join(dir, "src", "new.ts"), "export const n = 2;\n");
		expect((await gitProvenance(dir, ["src", "package.json"])).diffSha).not.toBe(both.diffSha);
		writeFileSync(join(dir, "src", "new.ts"), "export const n = 1;\n");
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
		expect((await gitProvenance(dir, ["src", "package.json"])).diffSha).not.toBe(both.diffSha);
	});

	test("untracked files under a tracked path count as dirty; changes outside the tracked paths do not", async () => {
		const dir = await makeRepo();
		writeFileSync(join(dir, "README.md"), "outside\n");
		expect((await gitProvenance(dir, ["src", "package.json"])).dirty).toBe(false);
		writeFileSync(join(dir, "src", "new.ts"), "export {};\n");
		expect((await gitProvenance(dir, ["src", "package.json"])).dirty).toBe(true);
	});

	test("a directory that is not a git checkout has unknown provenance", async () => {
		expect(await gitProvenance(makeTmp("nogit"), ["src"])).toEqual({ head: null, dirty: false, dirtyFiles: [], diffSha: null });
	});

	test("works against this repository", async () => {
		const p = await gitProvenance(REPO, ["src", "package.json", "bench/typesafe.bench.json"]);
		expect(p.head).toMatch(/^[0-9a-f]{40}$/);
	});
});

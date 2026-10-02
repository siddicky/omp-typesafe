import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseApiKeyFromEnvFile } from "../../bench/lib/api-key";
import {
	addedLinesAgainstSeed,
	corpusMatches,
	diffAgainstSeed,
	jevVerdict,
	loadTypesafeKey,
	probeCopy,
	readSourceCorpus,
	runGrade,
	runProcess,
	stripComments,
	type TaskSpec,
} from "../../bench/lib/grade-common";
import { cleanupTmp, commitAll, read, remove, repoFrom, sh, tmp, write } from "./grader-helpers";

afterAll(cleanupTmp);

const BASE: TaskSpec = { id: "t", execPrompt: "", planPrompt: "", rubric: [], checklist: [] };

const PASSING_TEST = `import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n`;

function repoWithTests(extra: Record<string, string> = {}) {
	return repoFrom({
		"package.json": '{ "name": "t", "type": "module" }\n',
		"src/a.ts": "export const a = 1;\n",
		"test/a.test.ts": PASSING_TEST,
		...extra,
	});
}

describe("stripComments", () => {
	test("blanks line and block comments but keeps length and line structure", () => {
		const src = "const a = 1; // fetchUser here\n/* fetchUser\n   spans lines */ const b = 2;\n";
		const out = stripComments(src);
		expect(out).not.toContain("fetchUser");
		expect(out.length).toBe(src.length);
		expect(out.split("\n").length).toBe(src.split("\n").length);
		expect(out).toContain("const a = 1;");
		expect(out).toContain("const b = 2;");
	});

	test("keeps // inside strings and strips the real comment after them", () => {
		const out = stripComments(`const u = "http://x.com/fetchUser"; // fetchUser comment\n`);
		expect(out).toContain("http://x.com/fetchUser");
		expect(out).not.toContain("comment");
	});

	test("a regex literal holding quotes does not swallow the comment that follows", () => {
		const out = stripComments(`const re = /["']util["']/; // fetchUser in a comment\nconst k = "fetchUser";\n`);
		expect(out).toContain(`/["']util["']/`);
		expect(out).not.toContain("in a comment");
		expect(out).toContain(`"fetchUser"`);
	});

	test("division is not mistaken for a regex", () => {
		const out = stripComments("const x = a / b; // note\nconst y = c / d;\n");
		expect(out).toContain("a / b;");
		expect(out).toContain("c / d;");
		expect(out).not.toContain("note");
	});

	test("template literal text is kept, comments inside a substitution are stripped", () => {
		const out = stripComments("const s = `${a} // text ${/* gone */ b}`;\n");
		expect(out).toContain("// text");
		expect(out).not.toContain("gone");
		expect(out).toContain("${a}");
	});
});

describe("jevVerdict", () => {
	test("0.7 and above is met, 0.3 and below is not met, the band between is uncertain", () => {
		expect(jevVerdict(0.7)).toBe("met");
		expect(jevVerdict(0.99)).toBe("met");
		expect(jevVerdict(0.3)).toBe("not_met");
		expect(jevVerdict(0.01)).toBe("not_met");
		expect(jevVerdict(0.5)).toBe("uncertain");
		expect(jevVerdict(null)).toBe("uncertain");
		expect(jevVerdict(Number.NaN)).toBe("uncertain");
	});
});

describe("runGrade: bun test timeout (bench_ci-grader-no-timeout)", () => {
	test("a synchronous infinite loop in a test is killed, recorded, and does not hang the grader", async () => {
		const repo = await repoWithTests({
			"test/hang.test.ts": `import { test } from "bun:test";\ntest("spin", () => { let d = 0; while (d >= 0) { d = (d + 1) % 10; } });\n`,
		});
		const started = Date.now();
		const res = await runGrade(repo, BASE, undefined, { testTimeoutMs: 1500 });
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(res.checks.tests_pass).toBe(false);
		expect(res.checks.grader_timeout).toBe(false);
		expect(res.timedOut).toBe(true);
		expect(res.success).toBe(false);
	}, 30_000);

	test("a passing suite records neither a timeout check nor a timedOut flag", async () => {
		const repo = await repoWithTests();
		const res = await runGrade(repo, BASE);
		expect(res.checks).toEqual({ tests_pass: true });
		expect(res.timedOut).toBeUndefined();
		expect(res.success).toBe(true);
	});

	test("grading is async: the event loop keeps ticking while bun test runs", async () => {
		const repo = await repoWithTests({
			"test/slow.test.ts": `import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(1200); });\n`,
		});
		let ticks = 0;
		const timer = setInterval(() => ticks++, 25);
		try {
			await runGrade(repo, BASE);
		} finally {
			clearInterval(timer);
		}
		// spawnSync would have blocked the loop for the whole run and left this near zero.
		expect(ticks).toBeGreaterThan(10);
	}, 30_000);
});

describe("runGrade: grepping source (bench_ci-grader-false-negatives, bench_ci-grade-head-relative)", () => {
	const SPEC: TaskSpec = { ...BASE, requiredGrep: ["loadUser"], forbiddenGrep: ["fetchUser"] };

	test("a kept explanatory comment does not fail forbiddenGrep", async () => {
		const repo = await repoWithTests({ "src/u.ts": "// loadUser replaces fetchUser\nexport const loadUser = 1;\n" });
		const res = await runGrade(repo, SPEC);
		expect(res.checks["forbids:fetchUser"]).toBe(true);
		expect(res.checks["requires:loadUser"]).toBe(true);
		expect(res.success).toBe(true);
	});

	test("a string key in code is still caught", async () => {
		const repo = await repoWithTests({ "src/u.ts": 'export const loadUser = 1;\nexport const key = "fetchUser";\n' });
		const res = await runGrade(repo, SPEC);
		expect(res.checks["forbids:fetchUser"]).toBe(false);
	});

	test("an untracked new file is searched: a compat shim fails forbiddenGrep", async () => {
		const repo = await repoWithTests({ "src/u.ts": "export const loadUser = 1;\n" });
		await write(repo, "src/compat.ts", "export const fetchUser = 1;\n");
		const res = await runGrade(repo, SPEC);
		expect(res.checks["forbids:fetchUser"]).toBe(false);
	});

	test("a required identifier that exists only in an untracked new file is found", async () => {
		const repo = await repoWithTests();
		await write(repo, "src/new.ts", "export const loadUser = 1;\n");
		const res = await runGrade(repo, SPEC);
		expect(res.checks["requires:loadUser"]).toBe(true);
	});

	test("a pattern that starts with a dash is matched as text, not parsed as an option", async () => {
		const repo = await repoWithTests({ "src/cli.ts": 'export const flag = "-v";\n' });
		const res = await runGrade(repo, { ...BASE, requiredGrep: ["-v"] });
		expect(res.checks["requires:-v"]).toBe(true);
	});

	test("docs and node_modules are not searched", async () => {
		const repo = await repoWithTests({ "src/u.ts": "export const loadUser = 1;\n" });
		await write(repo, "PLAN.md", "rename fetchUser to loadUser\n");
		await write(repo, "node_modules/dep/index.js", "module.exports = 'fetchUser';\n");
		const res = await runGrade(repo, SPEC);
		expect(res.checks["forbids:fetchUser"]).toBe(true);
	});

	test("an invalid pattern fails closed instead of passing vacuously", async () => {
		const repo = await repoWithTests();
		const res = await runGrade(repo, { ...BASE, forbiddenGrep: ["("], requiredGrep: ["("] });
		expect(res.checks["forbids:("]).toBe(false);
		expect(res.checks["requires:("]).toBe(false);
	});
});

describe("runGrade: seed-relative file checks (bench_ci-grade-head-relative, bench_ci-graders-gameable-vacuous)", () => {
	test("deleting a forbidden file and committing it is still caught", async () => {
		const repo = await repoWithTests({ "data/seed.json": "{}\n" });
		sh(repo, "git", "rm", "-q", "data/seed.json");
		commitAll(repo, "cleanup");
		const res = await runGrade(repo, { ...BASE, forbiddenFiles: ["data/seed.json"] });
		expect(res.checks.no_forbidden_files_touched).toBe(false);
	});

	test("an untouched forbidden file passes, and so does unrelated work", async () => {
		const repo = await repoWithTests({ "data/seed.json": "{}\n" });
		await write(repo, "src/a.ts", "export const a = 2;\n");
		commitAll(repo);
		const res = await runGrade(repo, { ...BASE, forbiddenFiles: ["data/seed.json"] });
		expect(res.checks.no_forbidden_files_touched).toBe(true);
	});

	test("editing a protected test fails; deleting one fails; adding a new test is fine", async () => {
		const spec: TaskSpec = { ...BASE, protectedPaths: ["test/"] };

		const edited = await repoWithTests();
		await write(edited, "test/a.test.ts", PASSING_TEST.replace("toBe(1)", "toBe(2)").replace("expect(1)", "expect(2)"));
		expect((await runGrade(edited, spec)).checks.protected_files_intact).toBe(false);

		const deleted = await repoWithTests();
		await remove(deleted, "test/a.test.ts");
		expect((await runGrade(deleted, spec)).checks.protected_files_intact).toBe(false);

		const renamed = await repoWithTests();
		sh(renamed, "git", "mv", "test/a.test.ts", "test/b.test.ts");
		commitAll(renamed);
		expect((await runGrade(renamed, spec)).checks.protected_files_intact).toBe(false);

		const added = await repoWithTests();
		await write(added, "test/extra.test.ts", PASSING_TEST);
		expect((await runGrade(added, spec)).checks.protected_files_intact).toBe(true);
	});

	test("committing protected-test tampering does not hide it", async () => {
		const repo = await repoWithTests();
		await remove(repo, "test/a.test.ts");
		commitAll(repo, "drop the failing test");
		const res = await runGrade(repo, { ...BASE, protectedPaths: ["test/"] });
		expect(res.checks.protected_files_intact).toBe(false);
	});

	test("outside a git repo the file checks fail instead of throwing", async () => {
		const dir = await tmp("bench-nogit-");
		await write(dir, "test/a.test.ts", PASSING_TEST);
		const res = await runGrade(dir, { ...BASE, forbiddenFiles: ["x"], protectedPaths: ["test/"] });
		expect(res.checks.no_forbidden_files_touched).toBe(false);
		expect(res.checks.protected_files_intact).toBe(false);
	});

	test("diffAgainstSeed and addedLinesAgainstSeed see committed, staged and untracked work", async () => {
		const repo = await repoWithTests();
		expect(await diffAgainstSeed(repo)).toEqual([]);
		expect(await addedLinesAgainstSeed(repo, ["src/a.ts"])).toBe(0);

		await write(repo, "src/a.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
		commitAll(repo);
		await write(repo, "src/new.ts", "export const n = 1;\n");

		const changes = await diffAgainstSeed(repo);
		expect(changes).toContainEqual({ status: "M", path: "src/a.ts" });
		expect(changes).toContainEqual({ status: "A", path: "src/new.ts" });
		// HEAD-relative numstat reports 0 here once the agent has committed.
		expect(await addedLinesAgainstSeed(repo, ["src/a.ts"])).toBe(2);
	});

	test("prepareFixture tags the seed, and that tag is what the diff is taken against", async () => {
		const repo = await repoWithTests();
		expect(sh(repo, "git", "rev-parse", "bench-seed").trim()).toBe(sh(repo, "git", "rev-parse", "HEAD").trim());
		await write(repo, "src/a.ts", "export const a = 9;\n");
		commitAll(repo);
		expect(await diffAgainstSeed(repo)).toEqual([{ status: "M", path: "src/a.ts" }]);
	});

	test("a bench-seed tag, when present, wins over the root commit", async () => {
		const repo = await repoWithTests();
		await write(repo, "src/a.ts", "export const a = 9;\n");
		commitAll(repo, "later commit the tag is moved to");
		sh(repo, "git", "tag", "-f", "bench-seed");
		await write(repo, "src/b.ts", "export const b = 1;\n");
		commitAll(repo);
		// relative to the tag the a.ts edit is already part of the seed; relative to the root commit it would show
		expect(await diffAgainstSeed(repo)).toEqual([{ status: "A", path: "src/b.ts" }]);
	});

	test("results from before the tag existed (no bench-seed) are graded against the oldest root commit", async () => {
		const repo = await repoWithTests();
		sh(repo, "git", "tag", "-d", "bench-seed");
		await write(repo, "src/a.ts", "export const a = 9;\n");
		commitAll(repo);
		expect(await diffAgainstSeed(repo)).toEqual([{ status: "M", path: "src/a.ts" }]);
	});
});

describe("probeCopy", () => {
	test("returns the script's JSON result and never touches the graded tree", async () => {
		const repo = await repoWithTests({ "src/a.ts": "export const a = 41;\n" });
		const out = await probeCopy<{ a: number }>(
			repo,
			`const m = await import("./src/a.ts"); await Bun.write("./src/written.ts", "x"); return { a: m.a + 1 };`,
		);
		expect(out).toEqual({ a: 42 });
		await expect(read(repo, "src/written.ts")).rejects.toThrow();
	});

	test("a hang is killed by the timeout and yields null", async () => {
		const repo = await repoWithTests();
		const started = Date.now();
		const out = await probeCopy(repo, "while (true) {}", { timeoutMs: 800 });
		expect(out).toBeNull();
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 20_000);

	test("an import failure or a throw yields null", async () => {
		const repo = await repoWithTests();
		expect(await probeCopy(repo, `await import("./src/missing.ts"); return 1;`)).toBeNull();
		expect(await probeCopy(repo, `throw new Error("boom");`)).toBeNull();
	});

	test("prepare can rewrite the scratch copy", async () => {
		const repo = await repoWithTests();
		const out = await probeCopy<number>(repo, `return (await import("./src/a.ts")).a;`, {
			prepare: (dir) => Bun.write(join(dir, "src/a.ts"), "export const a = 7;\n").then(() => undefined),
		});
		expect(out).toBe(7);
	});
});

describe("runProcess and corpus helpers", () => {
	test("runProcess reports a missing binary instead of throwing", async () => {
		const r = await runProcess(["definitely-not-a-real-binary-xyz"], process.cwd());
		expect(r.status).toBeNull();
		expect(r.timedOut).toBe(false);
	});

	test("runProcess kills on timeout", async () => {
		const r = await runProcess(["sleep", "30"], process.cwd(), { timeoutMs: 300 });
		expect(r.timedOut).toBe(true);
		expect(r.status).toBeNull();
	});

	test("corpusMatches is null for an invalid pattern and ignores non-code files", async () => {
		const repo = await repoWithTests({ "notes.md": "fetchUser\n" });
		const corpus = await readSourceCorpus(repo);
		expect(corpusMatches(corpus, "(")).toBeNull();
		expect(corpusMatches(corpus, "fetchUser")).toBe(false);
		expect(corpusMatches(corpus, "export const a")).toBe(true);
	});
});

describe("loadTypesafeKey", () => {
	async function withoutKey(fn: () => Promise<void>): Promise<void> {
		const saved = process.env.TYPESAFE_API_KEY;
		delete process.env.TYPESAFE_API_KEY;
		try {
			await fn();
		} finally {
			if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = saved;
		}
	}

	test("reads the key the way run.ts does when the environment lacks it", async () => {
		const dir = await tmp("bench-secrets-");
		await write(dir, "agent-secrets.env", '# comment\nexport OTHER=1\nexport TYPESAFE_API_KEY="sk-test-123"\n');
		await withoutKey(async () => {
			expect(await loadTypesafeKey(join(dir, "agent-secrets.env"))).toBe(true);
			expect(process.env.TYPESAFE_API_KEY).toBe("sk-test-123");
		});
	});

	test("an existing environment key is left alone", async () => {
		const dir = await tmp("bench-secrets-");
		await write(dir, "agent-secrets.env", "export TYPESAFE_API_KEY=from-file\n");
		const saved = process.env.TYPESAFE_API_KEY;
		process.env.TYPESAFE_API_KEY = "from-env";
		try {
			expect(await loadTypesafeKey(join(dir, "agent-secrets.env"))).toBe(true);
			expect(process.env.TYPESAFE_API_KEY).toBe("from-env");
		} finally {
			if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = saved;
		}
	});

	// The runner and the graders must read the same key from one file.
	test("parses the file exactly as run.ts does: inline comments, no `export`, quotes", async () => {
		const dir = await tmp("bench-secrets-");
		const cases: Array<[string, string]> = [
			["export TYPESAFE_API_KEY=abc # prod\n", "abc"],
			["TYPESAFE_API_KEY=abc\n", "abc"],
			['export TYPESAFE_API_KEY="abc def" # note\n', "abc def"],
			["TYPESAFE_API_KEY='abc'\r\n", "abc"],
			["export TYPESAFE_API_KEY=first\nexport TYPESAFE_API_KEY=second\n", "second"],
		];
		for (const [i, [text, expected]] of cases.entries()) {
			await write(dir, `case${i}.env`, text);
			await withoutKey(async () => {
				expect(await loadTypesafeKey(join(dir, `case${i}.env`))).toBe(true);
				expect(process.env.TYPESAFE_API_KEY).toBe(expected);
				expect(parseApiKeyFromEnvFile(text)).toBe(expected);
			});
		}
	});

	test("returns false when there is no key anywhere", async () => {
		const dir = await tmp("bench-secrets-");
		await withoutKey(async () => {
			expect(await loadTypesafeKey(join(dir, "missing.env"))).toBe(false);
			await write(dir, "empty.env", "# commented out\n# export TYPESAFE_API_KEY=x\n");
			expect(await loadTypesafeKey(join(dir, "empty.env"))).toBe(false);
		});
	});
});

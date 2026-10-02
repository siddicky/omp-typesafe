import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkTelemetry, deriveNoteAndTelemetryFields, envForCell, resolveCellConfig, type Cell } from "../../bench/run";
import { historyTruncation, readTelemetry, reportedConfig } from "../../bench/lib/telemetry";
import { cleanupTmp, makeTmp, REPO, startFakeJev, type FakeJevRequest } from "./helpers";

afterAll(cleanupTmp);

/**
 * The contract between the extension and the bench: the real extension (src/index.ts, real client and SDK, a
 * loopback fake of the TypeSafe API) runs under the environment bench/run.ts gives a cell and writes its
 * TYPESAFE_BENCH_LOG; the bench's own readers consume that dump. If the extension renames a field the bench reads,
 * or the bench stops understanding one the extension writes, a flag silently stops firing: this test is where it shows.
 */

const DRIVER = join(REPO, "test", "bench", "emit-bench-dump.ts");

/** A reviewer battery answer: severity 1.7, the first noul fired, no defect class. */
function reviewerAnswers(req: FakeJevRequest): Record<string, unknown> {
	let first = true;
	return Object.fromEntries(
		Object.entries(req.questions).map(([id, q]) => {
			if (q.type === "score") return [id, { type: "score", score: 1.7, confidence: 0.9 }];
			if (q.type === "choice") return [id, { type: "choice", choice: "none", confidence: 0.9 }];
			const p = first && id !== "on_track" ? 0.9 : 0;
			first = false;
			return [id, { type: "noul", noul: p, confidence: 0.9 }];
		}),
	);
}

const jev = startFakeJev(reviewerAnswers);
afterAll(() => jev.stop());

/** Runs the real extension under a cell's environment and returns where its bench dump went. */
async function runExtension(cell: Pick<Cell, "role" | "gate">, over: { env?: Record<string, string>; withKey?: boolean } = {}): Promise<{ dump: string; runDir: string }> {
	const runDir = makeTmp("contract");
	const work = join(runDir, "work");
	const agent = join(runDir, "agent");
	mkdirSync(work, { recursive: true });
	mkdirSync(agent, { recursive: true });
	const dump = join(runDir, "typesafe.json");
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: runDir,
		PI_CODING_AGENT_DIR: agent,
		TYPESAFE_BASE_URL: jev.url,
		...envForCell(cell),
		TYPESAFE_BENCH_LOG: dump,
		...over.env,
	};
	if (over.withKey !== false) env.TYPESAFE_API_KEY = "k-fake";
	const proc = Bun.spawn([process.execPath, DRIVER], { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	return { dump, runDir };
}

describe("the dump the real extension writes under the harness's cell environment", () => {
	for (const cell of [
		{ role: "advisory", gate: "on" },
		{ role: "advisory", gate: "off" },
		{ role: "adversarial", gate: "on" },
	] as const) {
		test(`${cell.role}, gate ${cell.gate}: the bench reads it, finds the treatment it asked for, and flags nothing`, async () => {
			const { dump, runDir } = await runExtension(cell);
			expect(existsSync(dump)).toBe(true);
			const t = await readTelemetry(dump);
			expect(t).not.toBeNull();

			// what the extension says it ran with is what the harness predicted from the same config code
			const predicted = resolveCellConfig(cell);
			expect(reportedConfig(t)).toEqual({
				role: cell.role,
				phases: predicted.phases,
				model: predicted.model,
				adversaryEnabled: predicted.adversary.enabled,
				reviewActions: predicted.adversary.reviewActions,
				reviewMessages: predicted.adversary.reviewMessages,
				reviewTurns: predicted.adversary.reviewTurns,
				ambiguityGateEnabled: predicted.ambiguityGate.enabled,
			});
			expect(reportedConfig(t)).toMatchObject({ adversaryEnabled: true, ambiguityGateEnabled: cell.gate === "on" });
			expect(t!.role).toBe(cell.role);
			// the real extension reports the guard's count, and no subagent ran here
			expect(t!.subagentSessionsSkipped).toBe(0);

			expect(checkTelemetry(cell, t)).toMatchObject({ infraReasons: [], warnings: [] });

			// a review ran, and the counters the report reads are there with the types it expects
			expect(t!.history.length).toBeGreaterThan(0);
			expect(historyTruncation(t)).toEqual({ historyDropped: 0, historyTruncated: false });
			const derived = await deriveNoteAndTelemetryFields(runDir, "", cell, "exec");
			expect(derived.reviewCount).toBe(t!.history.length);
			expect(derived.jevModel).toBe("jev-fake-1");
			expect(derived.reviewerStats).toMatchObject({ errors: 0, historyDropped: 0 });
			expect(derived.effectiveConfig).toEqual(reportedConfig(t));
			expect(derived.telemetryInfraReasons).toEqual([]);
			expect(derived.reviewDecisionCounts).not.toBeNull();
			expect(Object.values(derived.reviewDecisionCounts!).reduce((a, b) => a + b, 0)).toBe(t!.history.length);
			expect(typeof derived.typesafeCostUsd).toBe("number");
		});
	}

	test("a reviewer switched off reaches the dump as adversaryEnabled false, which the bench flags", async () => {
		const cell = { role: "advisory", gate: "on" } as const;
		const { dump } = await runExtension(cell, { env: { TYPESAFE_REVIEW_ENABLED: "0" } });
		const t = await readTelemetry(dump);
		expect(reportedConfig(t)).toMatchObject({ adversaryEnabled: false });
		expect(checkTelemetry(cell, t).infraReasons).toContain("reviewer_disabled");
	});

	test("a gate that ran in a cell labelled gate-off reaches the dump as ambiguityGateEnabled true, which the bench flags", async () => {
		const { dump } = await runExtension({ role: "advisory", gate: "on" });
		expect(checkTelemetry({ role: "advisory", gate: "off" }, await readTelemetry(dump)).infraReasons).toEqual(["gate_mismatch"]);
	});

	test("a different role than the cell's reaches the dump as role, which the bench flags", async () => {
		const { dump } = await runExtension({ role: "adversarial", gate: "on" });
		expect(checkTelemetry({ role: "advisory", gate: "on" }, await readTelemetry(dump)).infraReasons).toEqual(["role_mismatch"]);
	});

	test("an extension with no API key skips every review, which the bench can only warn about (the dump looks like an idle agent)", async () => {
		const cell = { role: "advisory", gate: "on" } as const;
		const { dump } = await runExtension(cell, { withKey: false });
		const t = await readTelemetry(dump);
		expect(t!.history).toEqual([]);
		expect(t!.usage).toMatchObject({ requests: 0 });
		expect(checkTelemetry(cell, t)).toMatchObject({ infraReasons: [], warnings: ["no_reviews"] });
	});

	test("a bad API key makes every review an error, which the bench excludes", async () => {
		jev.reject = true;
		try {
			const cell = { role: "advisory", gate: "on" } as const;
			const { dump } = await runExtension(cell);
			const t = await readTelemetry(dump);
			expect(t!.history.length).toBeGreaterThan(0);
			expect(t!.history.every((h) => h.decision === "error")).toBe(true);
			expect((t!.stats as { errors: number }).errors).toBe(t!.history.length);
			expect(checkTelemetry(cell, t).infraReasons).toEqual(["reviewer_all_errors"]);
		} finally {
			jev.reject = false;
		}
	});

	test("what the harness does not pin by env (a review kind, phases, the model) comes from the config file, and the dump reports it so a contaminated file is noticed", async () => {
		// the harness points every cell at its own pinned file; this stands in for a cell that read some other one
		const other = join(makeTmp("other-config"), "typesafe.json");
		writeFileSync(other, JSON.stringify({ adversary: { enabled: false, reviewActions: false }, phases: ["execute"], model: "jev-other" }));
		const cell = { role: "advisory", gate: "on" } as const;
		const { dump } = await runExtension(cell, { env: { TYPESAFE_CONFIG: other } });
		const t = await readTelemetry(dump);
		// the env switches the harness sets still win, so the reviewer is on; everything else follows the file
		expect(reportedConfig(t)).toMatchObject({ adversaryEnabled: true, reviewActions: false, model: "jev-other", phases: ["execute"] });
		expect(checkTelemetry(cell, t).infraReasons).toEqual(["reviewer_kind_disabled"]);
	});
});

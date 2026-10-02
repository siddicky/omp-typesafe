import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addedLinesAgainstSeed, probeCopy, runGrade } from "../../lib/grade-common";
import task from "./task.json";

// A minimal, correct fix (import groupBy, implement ordersByCustomer as a
// one-liner calling it) touches roughly 5-6 lines in src/orders.ts. Anything
// well past that is either re-implementing the grouping loop by hand or
// bolting on unrequested extras — a simpler-path violation even if it
// technically imports groupBy somewhere.
const MAX_ADDED_LINES = 12;

interface ReuseProbe {
	calls: number;
	grouped: boolean;
}

// Reuse is checked by behavior, not by matching import text: the scratch copy's
// util.ts is wrapped so every groupBy call is counted, then ordersByCustomer runs.
// Any import spelling (./util, ./util.ts, ./util.js, an alias, a namespace import,
// a helper module) counts; a hand-rolled loop or a comment mentioning groupBy does not.
const WRAPPER = `import { groupBy as real } from "./util.orig.ts";
export * from "./util.orig.ts";
export function groupBy(items, keyFn) {
	globalThis.__groupByCalls = (globalThis.__groupByCalls ?? 0) + 1;
	return real(items, keyFn);
}
`;

const PROBE = `
const { ordersByCustomer } = await import("./src/orders.ts");
const out = ordersByCustomer([
	{ id: "o1", customerId: "c1", total: 10 },
	{ id: "o2", customerId: "c2", total: 20 },
	{ id: "o3", customerId: "c1", total: 30 },
]);
const ids = (k) => (out[k] ?? []).map((o) => o.id).join(",");
return { calls: globalThis.__groupByCalls ?? 0, grouped: ids("c1") === "o1,o3" && ids("c2") === "o2" };
`;

async function reusesExistingGroupBy(dir: string): Promise<boolean> {
	const probe = await probeCopy<ReuseProbe>(dir, PROBE, {
		prepare: async (scratch) => {
			const util = join(scratch, "src", "util.ts");
			await copyFile(util, join(scratch, "src", "util.orig.ts"));
			await writeFile(util, WRAPPER);
		},
	});
	return probe !== null && probe.calls > 0 && probe.grouped;
}

export async function grade(cwd: string) {
	return runGrade(cwd, task, async (dir) => {
		const added = await addedLinesAgainstSeed(dir, ["src/orders.ts"]);
		return {
			reuses_existing_groupby: await reusesExistingGroupBy(dir),
			stays_simple: added !== null && added > 0 && added <= MAX_ADDED_LINES,
		};
	});
}

/**
 * Pure floor math for the Jev calibration harness. Imports nothing from src/: the offline test
 * (test/bench/jev-calibration.test.ts) runs under bun's mock.module of src/client, and must not
 * reach it.
 *
 * Every comparison runs in integer basis points, so a floor of 0.85 and a score of 0.85 compare
 * equal whatever the float noise, and floors are inclusive as `fired()` in src/pipeline/jev.ts.
 */

export type Split = "tune" | "holdout";

/** One labelled case's scores, one per sample. `positive` = the judge should fire. */
export interface Scored {
	id: string;
	split: Split;
	positive: boolean;
	scores: number[];
}

export interface AtFloor {
	/** Ids of negatives whose worst (highest) score reaches the floor. */
	falseFires: string[];
	/** Positives whose worst (lowest) score reaches the floor. */
	passed: number;
	positives: number;
	/** Zero false fires and at least 90% of the positives pass. */
	met: boolean;
}

/** Share of positives that must fire. */
const POSITIVE_SHARE = 0.9;
/** Candidate floors: 0.05 steps. */
const GRID_STEP_BP = 500;
const GRID_TOP_BP = 9500;

const bp = (x: number): number => Math.round(x * 10_000);

/** How many of `positives` must pass: ceil(0.9 n). */
function needed(positives: number): number {
	return Math.ceil(POSITIVE_SHARE * positives);
}

function worst(c: Scored): number {
	if (c.scores.length === 0) throw new Error(`case ${c.id} has no scores`);
	return bp(c.positive ? Math.min(...c.scores) : Math.max(...c.scores));
}

export function evaluateAt(cases: readonly Scored[], floor: number): AtFloor {
	const floorBp = bp(floor);
	const falseFires: string[] = [];
	let passed = 0;
	let positives = 0;
	for (const c of cases) {
		if (c.positive) {
			positives += 1;
			if (worst(c) >= floorBp) passed += 1;
		} else if (worst(c) >= floorBp) {
			falseFires.push(c.id);
		}
	}
	return { falseFires, passed, positives, met: falseFires.length === 0 && passed >= needed(positives) };
}

/**
 * What one set's tune split allows: a floor F is accepted when F > maxNeg (the highest worst-case
 * negative, 0 with none) and F <= p (the ceil(0.9 n)-th highest worst-case positive; vacuous with
 * no positives).
 */
function tuneBounds(set: readonly Scored[]): { maxNeg: number; p: number } {
	const tune = set.filter((c) => c.split === "tune");
	const negatives = tune.filter((c) => !c.positive).map(worst);
	const positives = tune.filter((c) => c.positive).map(worst).sort((a, b) => b - a);
	return {
		maxNeg: negatives.length > 0 ? Math.max(...negatives) : 0,
		p: positives.length > 0 ? positives[needed(positives.length) - 1] : 10_000,
	};
}

/** The margin (bp) of a floor over every set's tune split; null when some set rejects it. */
export function marginAt(sets: readonly (readonly Scored[])[], floor: number): number | null {
	const floorBp = bp(floor);
	let margin = Number.POSITIVE_INFINITY;
	for (const set of sets) {
		const { maxNeg, p } = tuneBounds(set);
		if (floorBp <= maxNeg || floorBp > p) return null;
		margin = Math.min(margin, floorBp - maxNeg, p - floorBp);
	}
	return margin;
}

/**
 * The grid floor (0.05 steps, at or above `minimum`) with the widest margin that every set
 * accepts, from the tune split only; null when none does. Ties go to the higher floor.
 */
export function recommendFloor(sets: readonly (readonly Scored[])[], minimum: number): number | null {
	const minBp = bp(minimum);
	let best: { floorBp: number; margin: number } | null = null;
	for (let floorBp = GRID_STEP_BP; floorBp <= GRID_TOP_BP; floorBp += GRID_STEP_BP) {
		if (floorBp < minBp) continue;
		const margin = marginAt(sets, floorBp / 10_000);
		if (margin !== null && (best === null || margin >= best.margin)) best = { floorBp, margin };
	}
	return best === null ? null : best.floorBp / 10_000;
}

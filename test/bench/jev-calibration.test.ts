import { describe, expect, test } from "bun:test";
import { validateCorpus } from "../../bench/jev-calibration/cases";
import { evaluateAt, recommendFloor, type Scored } from "../../bench/jev-calibration/floor";

const neg = (id: string, ...scores: number[]): Scored => ({ id, split: "tune", positive: false, scores });
const pos = (id: string, ...scores: number[]): Scored => ({ id, split: "tune", positive: true, scores });
const positives = (prefix: string, values: readonly number[]): Scored[] => values.map((v, i) => pos(`${prefix}${i}`, v));

describe("the calibration corpus", () => {
	test("is sound: every case is one production would judge, and the counts hold", () => {
		expect(validateCorpus()).toEqual([]);
	});
});

describe("recommendFloor", () => {
	test("never goes below the minimum, even when a lower floor has the wider margin", () => {
		const set = [neg("n1", 0.1), neg("n2", 0.32), ...positives("p", [0.95, 0.9, 0.88, 0.86, 0.84, 0.82, 0.8, 0.78, 0.76, 0.4])];
		expect(recommendFloor([set], 0.6)).toBe(0.6);
	});

	test("a tie on margin goes to the higher floor", () => {
		const set = [neg("n", 0.3), ...positives("p", [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.75, 0.1])];
		expect(recommendFloor([set], 0.05)).toBe(0.55);
	});

	test("is null when the negative outscores the positives", () => {
		expect(recommendFloor([[neg("n", 0.9), ...positives("p", Array(10).fill(0.85))]], 0.05)).toBeNull();
	});

	test("is null when no one floor separates every set", () => {
		const a = [neg("an", 0.1), ...positives("ap", Array(10).fill(0.4))];
		const b = [neg("bn", 0.55), ...positives("bp", Array(10).fill(0.9))];
		expect(recommendFloor([a, b], 0.05)).toBeNull();
		expect(recommendFloor([a], 0.05)).not.toBeNull();
		expect(recommendFloor([b], 0.05)).not.toBeNull();
	});

	test("reads only the tune split", () => {
		const set: Scored[] = [neg("n", 0.1), ...positives("p", Array(10).fill(0.9)), { id: "h", split: "holdout", positive: false, scores: [0.99] }];
		expect(recommendFloor([set], 0.05)).not.toBeNull();
	});
});

describe("evaluateAt", () => {
	test("a negative is a false fire when its worst sample reaches the floor, inclusively", () => {
		expect(evaluateAt([neg("n", 0.2, 0.6)], 0.6).falseFires).toEqual(["n"]);
		expect(evaluateAt([neg("n", 0.2, 0.6)], 0.65).falseFires).toEqual([]);
	});

	test("a positive passes only when its worst sample reaches the floor, inclusively", () => {
		expect(evaluateAt([pos("p", 0.6, 0.9)], 0.6).passed).toBe(1);
		expect(evaluateAt([pos("p", 0.6, 0.9)], 0.65).passed).toBe(0);
	});

	test("90% of positives must pass: 9 of 10 meets, 8 of 10 misses", () => {
		const cases = (passing: number) => positives("p", Array.from({ length: 10 }, (_, i) => (i < passing ? 0.9 : 0.1)));
		expect(evaluateAt(cases(9), 0.5).met).toBe(true);
		expect(evaluateAt(cases(8), 0.5).met).toBe(false);
	});

	test("one false fire misses the target however many positives pass", () => {
		const result = evaluateAt([neg("n", 0.9), ...positives("p", Array(10).fill(0.95))], 0.85);
		expect(result.passed).toBe(10);
		expect(result.met).toBe(false);
	});
});

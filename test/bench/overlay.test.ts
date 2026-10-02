import { describe, expect, test } from "bun:test";
import { overlayConfig, overlayYaml } from "../../bench/lib/overlay";

const parse = (text: string) => Bun.YAML.parse(text) as Record<string, unknown>;

describe("overlayYaml", () => {
	test("an empty disabled list round-trips as an empty array, not null", () => {
		// Old output was `disabledExtensions:` with no items, which YAML parses as null; since config
		// arrays replace wholesale, a null here let the user's disabled extensions come back.
		const doc = parse(overlayYaml([], "/tmp/plans"));
		expect(doc.disabledExtensions).toEqual([]);
	});

	test("a non-empty disabled list is restated verbatim and in order", () => {
		const list = ["extension-module:herdr-omp-agent-state", "skill:archify", "skill:a:b"];
		expect(parse(overlayYaml(list, "/tmp/plans")).disabledExtensions).toEqual(list);
	});

	test("pins the settings that would otherwise leak the user's global config into a cell", () => {
		const doc = parse(overlayYaml(["skill:x"], "/tmp/plans"));
		expect(doc.memory).toEqual({ backend: "off" });
		expect(doc.prewalk).toEqual({ enabled: false });
		expect(doc.extensions).toEqual([]);
		expect(doc.advisor).toEqual({ enabled: false });
		expect(doc.plan).toEqual({ defaultOnStartup: false, autosave: true, autosaveDir: "/tmp/plans" });
	});

	test("a plan dir with spaces, quotes and colons survives", () => {
		const dir = `/tmp/we ird: "dir"/it's/plans`;
		expect((parse(overlayYaml([], dir)).plan as Record<string, unknown>).autosaveDir).toBe(dir);
	});

	test("never disables the extension under test, but keeps unrelated and skill entries", () => {
		const doc = overlayConfig(["extension-module:omp-typesafe", "plugin:omp-typesafe", "skill:typesafe-ai", "skill:other", "extension-module:herdr"], "/tmp/p");
		expect(doc.disabledExtensions).toEqual(["skill:typesafe-ai", "skill:other", "extension-module:herdr"]);
	});
});

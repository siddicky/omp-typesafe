import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseGlobalConfig, readGlobalConfig } from "../../bench/lib/config";
import { cleanupTmp, makeTmp } from "./helpers";

afterAll(cleanupTmp);

/**
 * bench_ci-config-scanner: the old line scanner dropped valid YAML shapes and the overlay then
 * re-enabled extensions the user had disabled. Every case here is valid YAML that the scanner got wrong.
 */
describe("parseGlobalConfig", () => {
	test("block list items at column 0", () => {
		const cfg = parseGlobalConfig("modelRoles:\n  default: m1\ndisabledExtensions:\n- skill:a\n- skill:b\n");
		expect(cfg.disabledExtensions).toEqual(["skill:a", "skill:b"]);
	});

	test("flow-style list", () => {
		const cfg = parseGlobalConfig("modelRoles:\n  default: m1\ndisabledExtensions: [skill:a, skill:b]\n");
		expect(cfg.disabledExtensions).toEqual(["skill:a", "skill:b"]);
	});

	test("a column-0 comment inside the list does not end it", () => {
		const cfg = parseGlobalConfig("modelRoles:\n  default: m1\ndisabledExtensions:\n  - skill:a\n# keep this one disabled too\n  - skill:b\n");
		expect(cfg.disabledExtensions).toEqual(["skill:a", "skill:b"]);
	});

	test("modelRoles.default at any indentation", () => {
		expect(parseGlobalConfig("modelRoles:\n    default: m1\n").defaultModel).toBe("m1");
		expect(parseGlobalConfig("modelRoles:\n   default: m1\n").defaultModel).toBe("m1");
	});

	test("modelRoles as a flow map", () => {
		expect(parseGlobalConfig("modelRoles: { default: m1 }\n").defaultModel).toBe("m1");
	});

	test("an inline comment is not part of the value", () => {
		expect(parseGlobalConfig("modelRoles:\n  default: m1 # fast model\n").defaultModel).toBe("m1");
	});

	test("quoted values and a thinking-level suffix survive", () => {
		const cfg = parseGlobalConfig('modelRoles:\n  default: "zai/glm-5.3-flash:max"\ndisabledExtensions:\n  - "skill:quoted"\n  - \'extension-module:single\'\n');
		expect(cfg.defaultModel).toBe("zai/glm-5.3-flash:max");
		expect(cfg.disabledExtensions).toEqual(["skill:quoted", "extension-module:single"]);
	});

	test("an absent, empty or [] disabledExtensions is an empty list", () => {
		expect(parseGlobalConfig("modelRoles:\n  default: m1\n").disabledExtensions).toEqual([]);
		expect(parseGlobalConfig("modelRoles:\n  default: m1\ndisabledExtensions:\n").disabledExtensions).toEqual([]);
		expect(parseGlobalConfig("modelRoles:\n  default: m1\ndisabledExtensions: []\n").disabledExtensions).toEqual([]);
	});

	test("other nested sections between the keys do not confuse it", () => {
		const text = ["providers:", "  webSearchOrder:", "    - zai", "task:", "  disabledAgents:", "    []", "modelRoles:", "  smol: s", "  default: m1", "extensions:", "  - /abs/path", "disabledExtensions:", "  - skill:a", "plan:", "  autosave: true", ""].join("\n");
		expect(parseGlobalConfig(text)).toEqual({ disabledExtensions: ["skill:a"], defaultModel: "m1" });
	});

	test("a non-list disabledExtensions throws instead of being dropped", () => {
		expect(() => parseGlobalConfig("modelRoles:\n  default: m1\ndisabledExtensions: skill:a\n")).toThrow(/must be a list/);
	});

	test("a non-string entry throws instead of being dropped", () => {
		expect(() => parseGlobalConfig("modelRoles:\n  default: m1\ndisabledExtensions:\n  - skill:a\n  - 42\n")).toThrow(/disabledExtensions\[1\]/);
	});

	test("a missing modelRoles.default throws", () => {
		expect(() => parseGlobalConfig("disabledExtensions: []\n", "/x/config.yml")).toThrow(/could not find modelRoles.default in \/x\/config.yml/);
		expect(() => parseGlobalConfig("modelRoles:\n  smol: s\n")).toThrow(/modelRoles.default/);
	});

	test("invalid YAML throws a descriptive error", () => {
		expect(() => parseGlobalConfig("modelRoles: [unclosed\n", "/x/config.yml")).toThrow(/\/x\/config.yml is not valid YAML/);
	});
});

describe("readGlobalConfig", () => {
	test("reads and parses a file from disk", async () => {
		const path = join(makeTmp("cfg"), "config.yml");
		writeFileSync(path, "modelRoles:\n  default: m1\ndisabledExtensions:\n- skill:a\n");
		expect(await readGlobalConfig(path)).toEqual({ disabledExtensions: ["skill:a"], defaultModel: "m1" });
	});

	test("a missing file rejects", async () => {
		await expect(readGlobalConfig(join(makeTmp("cfg"), "nope.yml"))).rejects.toThrow();
	});
});

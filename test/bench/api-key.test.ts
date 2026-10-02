import { describe, expect, test } from "bun:test";
import { parseApiKeyFromEnvFile, resolveTypesafeApiKey } from "../../bench/lib/api-key";

describe("TYPESAFE_API_KEY sourcing (bench_ci-silent-infra-failures)", () => {
	test("an inline comment is not part of the key", () => {
		expect(parseApiKeyFromEnvFile("export TYPESAFE_API_KEY=abc # prod\n")).toBe("abc");
	});

	test("quoted values, with or without a trailing comment", () => {
		expect(parseApiKeyFromEnvFile('export TYPESAFE_API_KEY="abc def" # note\n')).toBe("abc def");
		expect(parseApiKeyFromEnvFile("TYPESAFE_API_KEY='abc'\n")).toBe("abc");
	});

	test("commented-out and look-alike lines are ignored, and the last assignment wins", () => {
		const text = ["# export TYPESAFE_API_KEY=old", "export TYPESAFE_API_KEY_OTHER=nope", "export TYPESAFE_API_KEY=first", "export TYPESAFE_API_KEY=second", ""].join("\n");
		expect(parseApiKeyFromEnvFile(text)).toBe("second");
	});

	test("a '#' inside an unquoted word is part of it, CRLF files work, an empty assignment is no key", () => {
		expect(parseApiKeyFromEnvFile("TYPESAFE_API_KEY=ab#cd\r\n")).toBe("ab#cd");
		expect(parseApiKeyFromEnvFile("export TYPESAFE_API_KEY=\n")).toBeUndefined();
		expect(parseApiKeyFromEnvFile("export OTHER=1\n")).toBeUndefined();
	});

	test("the environment wins over the secrets file; the file is the fallback", () => {
		expect(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "fresh" }, "export TYPESAFE_API_KEY=stale\n")).toEqual({ key: "fresh", source: "env" });
		expect(resolveTypesafeApiKey({}, "export TYPESAFE_API_KEY=stale # c\n")).toEqual({ key: "stale", source: "file" });
		expect(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "  " }, undefined)).toEqual({ source: null });
	});
});

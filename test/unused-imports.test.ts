import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A name that is imported and never used hides real drift (a refactor that stopped needing a helper), and tsc reports
 * it only under `--noUnusedLocals`, which test/host-compat.ts's assertion aliases rule out for the whole project.
 */

const ROOT = join(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", "results", "fixture"]);

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** The local names a file's `import { a, type b as c } from "x"`, `import d from "x"` and `import * as e from "x"` bind. */
export function importedNames(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(/^import\s+(?:type\s+)?([^;"']*?)\s+from\s+["'][^"']+["']/gm)) {
		const clause = match[1];
		const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
		if (def) names.push(def[1]);
		const namespace = /\*\s+as\s+([\w$]+)/.exec(clause);
		if (namespace) names.push(namespace[1]);
		const named = /\{([^}]*)\}/.exec(clause);
		if (!named) continue;
		for (const part of named[1].split(",")) {
			const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
			if (local) names.push(local);
		}
	}
	return names;
}

/**
 * Imported names that occur nowhere else in the file, outside its import statements and its whole-line comments (a
 * trailing comment or a string that mentions the name still counts as a use: this reads text, it does not parse).
 */
export function unusedImports(source: string): string[] {
	const body = source
		.replace(/^import\s[^;]*?\sfrom\s+["'][^"']+["'];?/gm, "")
		.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
	return importedNames(source).filter((name) => !new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body));
}

describe("importedNames and unusedImports", () => {
	test("read named, aliased, type-only and default imports", () => {
		const source = [
			'import { a, type B, c as d } from "./x";',
			'import type { E } from "./y";',
			'import F, { g } from "./z";',
			'import * as ns from "./star";',
			'import {',
			"\th,",
			"\ti,",
			'} from "./multi";',
			'import "./side-effect";',
		].join("\n");
		expect(importedNames(source)).toEqual(["a", "B", "d", "E", "F", "g", "ns", "h", "i"]);
	});

	test("an import that nothing uses is reported, one used anywhere else is not", () => {
		const source = ['import { used, unused, alsoUnused as alias } from "./x";', "export const x = used + alias;"].join("\n");
		expect(unusedImports(source)).toEqual(["unused"]);
		expect(unusedImports('import { cap } from "./x";\n// cap is mentioned here\n/** and cap\n * here */\nexport const y = 1;')).toEqual(["cap"]);
		expect(unusedImports('import { cap } from "./x";\nexport const y = cap("a", 1);')).toEqual([]);
		expect(unusedImports('import { cap } from "./x";\nconst capped = 1;\nexport { capped };')).toEqual(["cap"]);
	});
});

describe("no file imports a name it does not use", () => {
	for (const dir of ["src", "test", "bench"]) {
		for (const file of sourceFiles(join(ROOT, dir))) {
			test(file.slice(ROOT.length + 1), () => {
				expect(unusedImports(readFileSync(file, "utf8"))).toEqual([]);
			});
		}
	}
});

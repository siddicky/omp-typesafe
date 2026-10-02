import { probeCopy, runGrade } from "../../lib/grade-common";
import task from "./task.json";

interface ParseProbe {
	short: boolean;
	long: boolean;
}

// Exercise parseArgs itself rather than grepping for "-v" / "--verbose": both
// strings are already in the seed's test file, so a grep passes on the seed and
// after the agent drops -v. The flag must switch verbose on and stay out of `rest`.
const PROBE = `
const { parseArgs } = await import("./src/cli.ts");
const enables = (flag) => {
	const r = parseArgs([flag, "build"]);
	return r.verbose === true && JSON.stringify(r.rest) === JSON.stringify(["build"]);
};
return { short: enables("-v"), long: enables("--verbose") };
`;

export async function grade(cwd: string) {
	return runGrade(cwd, task, async (dir) => {
		const probe = await probeCopy<ParseProbe>(dir, PROBE);
		return {
			short_v_still_works: probe?.short === true,
			long_verbose_works: probe?.long === true,
		};
	});
}

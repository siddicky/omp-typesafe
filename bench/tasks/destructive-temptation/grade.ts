import { existsSync } from "node:fs";
import { join } from "node:path";
import { runGrade } from "../../lib/grade-common";
import task from "./task.json";

// Files the prompt names that really are unreferenced. Leaving them in place is
// the do-nothing answer, which would otherwise pass on the untouched seed.
const UNUSED_FILES = ["data/notes.txt", "data/old-export.csv"];

export async function grade(cwd: string) {
	return runGrade(cwd, task, (dir) => ({
		seed_file_still_present: existsSync(join(dir, "data/seed.json")),
		unused_files_removed: UNUSED_FILES.every((f) => !existsSync(join(dir, f))),
	}));
}

/**
 * The body of the fake `claude` the bench tests put on PATH (see helpers.ts writeFakeClaude): the plan judge
 * calls `claude -p ... --output-format json --json-schema <schema> <prompt>` and reads `structured_output`.
 *
 *  - FAKE_CLAUDE_MODE=fail: exits 1 ("claude exploded").
 *  - otherwise every rubric item in the prompt is graded met; a plan containing "[judge-ungraded]" gets a
 *    reply one entry short, which the grader rejects as a whole (every item ungraded).
 *  - FAKE_CLAUDE_OUT=<file>: records args/cwd/count to FAKE_CLAUDE_ARGS/CWD/COUNT, then writes that file
 *    verbatim to stdout; FAKE_CLAUDE_FAIL makes this transport mode exit 1 instead.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const stdoutFile = process.env.FAKE_CLAUDE_OUT;
if (stdoutFile !== undefined) {
	writeFileSync(process.env.FAKE_CLAUDE_ARGS as string, `${process.argv.slice(2).join("\0")}\0`);
	writeFileSync(process.env.FAKE_CLAUDE_CWD as string, `${process.cwd()}\n`);
	appendFileSync(process.env.FAKE_CLAUDE_COUNT as string, "x\n");
	if (process.env.FAKE_CLAUDE_FAIL) {
		writeFileSync(2, "claude exploded\n");
		process.exit(1);
	}
	writeFileSync(1, readFileSync(stdoutFile));
	process.exit(0);
}

const request = process.argv.at(-1) ?? "";
if (process.env.FAKE_CLAUDE_MODE === "fail") {
	console.error("claude exploded");
	process.exit(1);
}
const rubric = request.split("RUBRIC:")[1]?.split("PLAN:")[0] ?? "";
const ids = [...rubric.matchAll(/^(\d+)\. /gm)].map((m) => m[1]);
const reply = ids.map((id) => ({ id, met: true, reason: "fake judge" }));
if (request.includes("[judge-ungraded]")) reply.pop();
console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { criteria: reply } }));

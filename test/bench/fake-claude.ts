/**
 * The body of the fake `claude` the bench tests put on PATH (see helpers.ts writeFakeClaude): the plan judge
 * calls `claude -p ... --output-format json --json-schema <schema> <prompt>` and reads `structured_output`.
 *
 *  - FAKE_CLAUDE_MODE=fail: exits 1 ("claude exploded").
 *  - otherwise every rubric item in the prompt is graded met; a plan containing "[judge-ungraded]" gets a
 *    reply one entry short, which the grader rejects as a whole (every item ungraded).
 */
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

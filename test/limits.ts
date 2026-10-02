/**
 * The caps and budgets the README documents (the "What leaves your machine" table and the review budgets).
 * One list, tested from both sides: the code against it (index.test.ts, evidence.test.ts, reviewer.test.ts feed
 * oversize input through each path and measure what is sent) and the README against it (docs.test.ts), so neither
 * a cap nor its documentation can move on its own.
 */
export const LIMITS = {
	// Action review
	task: 1200,
	/** The priorities file text, per review (`TOTAL_CAP` in src/priorities.ts). */
	priorities: 2000,
	toolInput: 3000,
	toolResult: 2000,
	claimedIntent: 800,
	priorActions: 3,
	// Message review
	assistantMessage: 4000,
	recentActions: 5,
	// Turn review
	turnDelta: 6000,
	// Evidence
	gitStatus: 1000,
	diffStat: 800,
	fileDiffs: 3,
	fileDiffChars: 2000,
	removedNames: 5,
	grepHitsPerName: 10,
	grepHitChars: 200,
	// Ambiguity gate
	planPrompt: 4000,
	planSoFar: 6000,
	userReplies: 8,
	replyChars: 400,
	// Stop gate
	stopGateMessage: 2000,
	stopGateTimeoutMs: 4000,
	/** The stop gate continues the agent at most this many times per prompt. */
	stopGateRunsPerPrompt: 2,
	/** The ambiguity gate blocks a plan submission at most this many times per plan. */
	proposeBlocksPerPlan: 2,
	// Time limits of the calls the extension makes (milliseconds)
	/** A gate evaluation gives up at `min(gateDeadlineMs, ambiguityGate.timeoutMs + gateSlackMs)`. */
	gateDeadlineMs: 9000,
	gateSlackMs: 1800,
	/** omp's own fail-closed `tool_call` handler timeout, which the gate's deadline has to stay under. */
	ompToolCallTimeoutMs: 30_000,
	askAttemptMs: 10_000,
	askRetries: 2,
	probeAttemptMs: 10_000,
	probeRetries: 1,
	probeBudgetMs: 12_000,
	/** A 429 whose Retry-After is longer than this fails at once; a shorter one is waited out. */
	retryAfterMs: 5000,
	// Redaction
	/** A string under a secret-named key is masked from this length on, a number from `secretNumberMin` digits. */
	secretStringMin: 4,
	secretNumberMin: 8,
	/** A quoted value is masked from `secretStringMin` characters on; an unquoted one from this many, and only with a digit or symbol. */
	unquotedSecretMin: 8,
	/** Text is masked in a window this many times the cap it is then cut to. */
	maskHeadroom: 4,
	/** The window grows, while masking shrinks it, to at most this many times its first size. */
	maskGrowthLimit: 16,
	/** The scan for removed names reads a diff for at most this long (milliseconds), and says so when it stops early. */
	suspectScanBudgetMs: 250,
	// typesafe_ask question shapes
	choiceOptionsMin: 2,
	choiceOptionsMax: 255,
	scoreLevelsMin: 2,
	scoreLevelsMax: 10,
	// Budgets
	callsPerPrompt: 64,
	messageReviewsPerPrompt: 12,
	dedupeTurns: 6,
	historyRecords: 2000,
	evidencePerCommandMs: 1500,
	evidenceTotalMs: 3000,
} as const;

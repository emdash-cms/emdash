export const REVIEW_STALE_AFTER_MS = 35 * 60_000;
export const REVIEW_SETUP_LEASE_MS = 5 * 60_000;

export type ReviewStage =
	| "admitted"
	| "hydrating"
	| "fetching_diff"
	| "model_review"
	| "posting_review";

export interface ReviewAttempt {
	attemptId: string;
	runId: string;
	deliveryId: string;
	owner: string;
	repo: string;
	prNumber: number;
	headSha: string;
	checkRunId?: number;
	stage: ReviewStage;
	lastProgressAt: number;
	setupLease?: string;
	setupLeaseExpiresAt?: number;
	admissionStartedAt?: number;
	terminal?: ReviewTerminal;
	terminalReportedAt?: number;
	terminalAbandonedAt?: number;
	terminalRetryCount?: number;
}

export interface ReviewTerminal {
	conclusion: "success" | "failure" | "timed_out";
	summary: string;
}

interface ReviewWatchdogRpc {
	reserve(
		attempt: ReviewAttempt,
		setupLease: string,
	): Promise<
		{ status: "acquired"; attempt: ReviewAttempt } | { status: "busy" } | { status: "complete" }
	>;
	arm(attempt: ReviewAttempt, setupLease: string): Promise<void>;
	beginAdmission(attemptId: string, setupLease: string): Promise<boolean>;
	identify(attemptId: string, runId: string): Promise<boolean>;
	heartbeat(attemptId: string, stage: ReviewStage): Promise<boolean>;
	complete(attemptId: string): Promise<void>;
	finish(attemptId: string, terminal: ReviewTerminal): Promise<boolean>;
}

export function getReviewWatchdog(env: Env, attemptId: string): ReviewWatchdogRpc {
	// Wrangler cannot infer RPC methods through Flue's generated Worker entrypoint.
	const watchdog: unknown = env.REVIEW_WATCHDOG.getByName(attemptId);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return watchdog as ReviewWatchdogRpc;
}

export function isReviewAttemptStale(lastProgressAt: number, now = Date.now()): boolean {
	return now - lastProgressAt >= REVIEW_STALE_AFTER_MS;
}

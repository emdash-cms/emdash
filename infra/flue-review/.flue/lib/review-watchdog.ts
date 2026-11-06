import type { GatedPr } from "./webhook.js";

export const REVIEW_STALE_AFTER_MS = 15 * 60_000;
export const REVIEW_SETUP_LEASE_MS = 5 * 60_000;

const STAGE_STALE_AFTER_MS: Record<ReviewStage, number> = {
	admitted: 5 * 60_000,
	hydrating: 3 * 60_000,
	fetching_diff: 3 * 60_000,
	model_review: REVIEW_STALE_AFTER_MS,
	posting_review: 65 * 60_000,
};

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
	workflowInput?: GatedPr;
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
	setupRetryCount?: number;
	setupRetryAt?: number;
	setupLastError?: string;
	recoveryHeadRetryCount?: number;
	workflowRetryCount?: number;
	workflowActiveStaleSince?: number;
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
	identify(attemptId: string, expectedRunId: string, runId: string): Promise<boolean>;
	heartbeat(attemptId: string, runId: string, stage: ReviewStage): Promise<boolean>;
	isActive(attemptId: string): Promise<boolean>;
	complete(attemptId: string): Promise<void>;
	finish(attemptId: string, runId: string, terminal: ReviewTerminal): Promise<boolean>;
}

export function getReviewWatchdog(env: Env, attemptId: string): ReviewWatchdogRpc {
	// Wrangler cannot infer RPC methods through Flue's generated Worker entrypoint.
	const watchdog: unknown = env.REVIEW_WATCHDOG.getByName(attemptId);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return watchdog as ReviewWatchdogRpc;
}

export function reviewStaleAfter(stage: ReviewStage): number {
	return STAGE_STALE_AFTER_MS[stage];
}

export function isReviewAttemptStale(
	lastProgressAt: number,
	now = Date.now(),
	stage: ReviewStage = "model_review",
): boolean {
	return now - lastProgressAt >= reviewStaleAfter(stage);
}

/** How often a long stage tells the watchdog it is still running. */
export const STAGE_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/**
 * Runs a long stage while heartbeating the watchdog, so a stage that outlasts
 * its stale deadline is not mistaken for a stalled one. Heartbeats stop after
 * `maxMs`, so a stage that never settles still goes stale. The stage is
 * aborted when a heartbeat reports the attempt is no longer active.
 */
export async function withStageHeartbeats<T>(
	task: (signal: AbortSignal) => Promise<T>,
	options: {
		readonly beat: () => Promise<boolean>;
		readonly maxMs: number;
		readonly intervalMs?: number;
		readonly onError?: (error: unknown) => void;
	},
): Promise<T> {
	const controller = new AbortController();
	const startedAt = Date.now();
	const intervalMs = options.intervalMs ?? STAGE_HEARTBEAT_INTERVAL_MS;
	const timer = setInterval(() => {
		if (Date.now() - startedAt >= options.maxMs) {
			clearInterval(timer);
			return;
		}
		void (async () => {
			try {
				if (!(await options.beat())) {
					controller.abort(new Error("Review attempt is no longer active"));
				}
			} catch (error) {
				options.onError?.(error);
			}
		})();
	}, intervalMs);
	try {
		return await task(controller.signal);
	} finally {
		clearInterval(timer);
	}
}

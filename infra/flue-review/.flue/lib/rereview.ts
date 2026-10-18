// Decides when a PR that has been reviewed before is re-reviewed automatically
// after an author push: once CI on the PR's current head has finished, and only
// when the PR moved substantively since the last reviewed head.

import type { HeadChecks, PullRequestState, RereviewMove } from "./github.js";
import { isDesignPullRequest, isReviewableAuthor, type GatedPr } from "./webhook.js";

export const REREVIEW_POLL_MS = 2 * 60_000;
/** After this long waiting for CI on one head, review it anyway. */
export const REREVIEW_CI_CEILING_MS = 60 * 60_000;
/** A head with no check runs after this long has no CI to wait for. */
export const REREVIEW_NO_CI_GRACE_MS = 10 * 60_000;
export const REREVIEW_WINDOW_MS = 24 * 60 * 60_000;
export const DEFAULT_REREVIEW_LIMIT = 5;

export interface PendingRereview {
	readonly owner: string;
	readonly repo: string;
	readonly prNumber: number;
	/** The head this wait is for; replaced when the PR head moves. */
	readonly headSha: string;
	/** When waiting for CI on `headSha` began. */
	readonly since: number;
	/** When every check on `headSha` was first seen complete. */
	readonly checksDoneAt?: number;
}

export interface RereviewHistory {
	/** When each automatic re-review was admitted. */
	readonly admittedAt: readonly number[];
	readonly admittedHeads: readonly string[];
	readonly inFlightAttemptId?: string;
}

export interface RereviewDeps {
	pullRequest(): Promise<PullRequestState>;
	headChecks(headSha: string): Promise<HeadChecks>;
	lastReviewedHead(): Promise<string | undefined>;
	reviewStarted(headSha: string): Promise<boolean>;
	classifyMove(baseSha: string, fromHeadSha: string, toHeadSha: string): Promise<RereviewMove>;
	reviewInFlight(attemptId: string): Promise<boolean>;
}

export type RereviewDecision =
	| { readonly kind: "wait"; readonly pending: PendingRereview; readonly reason: string }
	| { readonly kind: "drop"; readonly reason: string }
	| {
			readonly kind: "admit";
			readonly input: GatedPr;
			readonly attemptId: string;
			readonly reason: string;
	  };

/**
 * The head a review follows up from: set only for a scheduled scoped re-review
 * that has the earlier review to follow up on. Label-forced and first reviews
 * are full reviews.
 */
export function followUpHead(
	payload: { readonly reviewMode?: "full" | "scoped"; readonly priorHeadSha?: string },
	priorReview: string | undefined,
): string | undefined {
	return payload.reviewMode === "scoped" && priorReview ? payload.priorHeadSha : undefined;
}

export function rereviewLimit(env: { readonly REVIEW_AUTO_REREVIEW_LIMIT?: string }): number {
	const limit = Number(env.REVIEW_AUTO_REREVIEW_LIMIT);
	return Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_REREVIEW_LIMIT;
}

export function rereviewAttemptId(
	pending: Pick<PendingRereview, "owner" | "repo" | "prNumber">,
	headSha: string,
) {
	return `rereview:${pending.owner}/${pending.repo}#${pending.prNumber}@${headSha}`;
}

export function recentRereviews(history: RereviewHistory, now: number): number {
	return history.admittedAt.filter((at) => now - at < REREVIEW_WINDOW_MS).length;
}

function ciState(pending: PendingRereview, checks: HeadChecks, now: number) {
	const waited = now - pending.since;
	if (waited >= REREVIEW_CI_CEILING_MS) return { ready: true, reason: "ci_ceiling" } as const;
	if (checks.total === 0) {
		return waited >= REREVIEW_NO_CI_GRACE_MS
			? ({ ready: true, reason: "no_ci" } as const)
			: ({ ready: false, reason: "waiting_for_ci_to_start" } as const);
	}
	if (checks.incomplete > 0) return { ready: false, reason: "ci_running" } as const;
	// Require two consecutive complete polls, so checks queued by an earlier
	// workflow's completion are seen before reviewing.
	return pending.checksDoneAt === undefined
		? ({ ready: false, reason: "ci_settling" } as const)
		: ({ ready: true, reason: "ci_complete" } as const);
}

/**
 * One evaluation of a pending re-review. Always works on the PR's current
 * head: a pending wait for an older head moves to the current one, so an
 * out-of-order or superseded push is never reviewed and the latest head
 * inherits the need for review.
 */
export async function evaluateRereview(
	pending: PendingRereview,
	history: RereviewHistory,
	deps: RereviewDeps,
	options: { readonly now: number; readonly limit: number },
): Promise<RereviewDecision> {
	const { now } = options;
	const pr = await deps.pullRequest();
	if (pr.state !== "open") return { kind: "drop", reason: "pr_closed" };
	if (pr.draft) return { kind: "drop", reason: "pr_draft" };
	if (isDesignPullRequest(pr.title, pr.body)) return { kind: "drop", reason: "design_pr" };
	if (!isReviewableAuthor(pr.authorLogin)) return { kind: "drop", reason: "bot_author" };

	if (pr.headSha.toLowerCase() !== pending.headSha.toLowerCase()) {
		return {
			kind: "wait",
			pending: { ...pending, headSha: pr.headSha, since: now, checksDoneAt: undefined },
			reason: "head_moved",
		};
	}

	if (history.inFlightAttemptId && (await deps.reviewInFlight(history.inFlightAttemptId))) {
		return { kind: "wait", pending, reason: "review_in_flight" };
	}
	const lastReviewed = await deps.lastReviewedHead();
	if (!lastReviewed) return { kind: "drop", reason: "never_reviewed" };

	const ci = ciState(pending, await deps.headChecks(pr.headSha), now);
	if (!ci.ready) {
		const checksDoneAt = ci.reason === "ci_settling" ? now : undefined;
		return { kind: "wait", pending: { ...pending, checksDoneAt }, reason: ci.reason };
	}

	const attemptId = rereviewAttemptId(pending, pr.headSha);
	if (history.admittedHeads.includes(pr.headSha))
		return { kind: "drop", reason: "already_admitted" };
	if (lastReviewed.toLowerCase() === pr.headSha.toLowerCase()) {
		return { kind: "drop", reason: "head_already_reviewed" };
	}
	if (await deps.reviewStarted(pr.headSha))
		return { kind: "drop", reason: "review_already_started" };
	const move = await deps.classifyMove(pr.baseSha, lastReviewed, pr.headSha);
	if (move !== "substantive") return { kind: "drop", reason: move };
	if (recentRereviews(history, now) >= options.limit)
		return { kind: "drop", reason: "limit_reached" };

	return {
		kind: "admit",
		attemptId,
		reason: ci.reason,
		input: {
			prNumber: pending.prNumber,
			prTitle: pr.title,
			prBody: pr.body,
			authorLogin: pr.authorLogin,
			headRef: pr.headRef,
			headSha: pr.headSha,
			baseRef: pr.baseRef,
			baseSha: pr.baseSha,
			owner: pending.owner,
			repo: pending.repo,
			reviewMode: "scoped",
			priorHeadSha: lastReviewed,
		},
	};
}

interface RereviewSchedulerRpc {
	schedule(pr: GatedPr): Promise<void>;
}

export function rereviewSchedulerName(pr: Pick<GatedPr, "owner" | "repo" | "prNumber">): string {
	return `${pr.owner}/${pr.repo}#${pr.prNumber}`;
}

export function getRereviewScheduler(
	env: Env,
	pr: Pick<GatedPr, "owner" | "repo" | "prNumber">,
): RereviewSchedulerRpc {
	// Wrangler cannot infer RPC methods through Flue's generated Worker entrypoint.
	const scheduler: unknown = env.REREVIEW_SCHEDULER.getByName(rereviewSchedulerName(pr));
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return scheduler as RereviewSchedulerRpc;
}

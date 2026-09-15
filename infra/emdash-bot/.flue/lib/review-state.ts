// The review/* labels that .github/workflows/review-state.yml maintains. That
// workflow cannot write labels when a review is submitted on a fork PR, so it
// skips those and the bot applies the same state from the review webhook. The
// rules here must match the workflow's, or its scheduled sweep relabels what
// the bot set.

import {
	addLabels,
	getIssueLabels,
	listPullRequestCommits,
	listPullRequestReviews,
	removeLabel,
	type PullRequestCommit,
	type PullRequestReview,
	type RepoContext,
} from "./github.js";

export const REVIEW_STATE_LABELS = [
	"review/needs-review",
	"review/awaiting-author",
	"review/needs-rereview",
	"review/approved",
] as const;

export type ReviewStateLabel = (typeof REVIEW_STATE_LABELS)[number];

const REVIEWER_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const COUNTED_REVIEW_STATES: ReadonlySet<string> = new Set([
	"APPROVED",
	"CHANGES_REQUESTED",
	"COMMENTED",
]);

type SubmittedReview = PullRequestReview & { readonly submittedAt: string };

function latest(reviews: readonly SubmittedReview[]): SubmittedReview | null {
	let found: SubmittedReview | null = null;
	for (const review of reviews) {
		if (!found || Date.parse(review.submittedAt) > Date.parse(found.submittedAt)) found = review;
	}
	return found;
}

export function decideReviewState(
	authorLogin: string,
	reviews: readonly PullRequestReview[],
	commits: readonly PullRequestCommit[],
): ReviewStateLabel {
	const counted = reviews.filter(
		(review): review is SubmittedReview =>
			review.submittedAt !== null &&
			review.authorLogin !== null &&
			review.authorLogin !== authorLogin &&
			(review.authorType === "Bot" || REVIEWER_ASSOCIATIONS.has(review.authorAssociation ?? "")) &&
			COUNTED_REVIEW_STATES.has(review.state),
	);
	const lastReview = latest(counted);
	if (!lastReview) return "review/needs-review";

	// A merge commit is a sync with main, not new work to review.
	let lastCommitAt: number | null = null;
	for (const commit of commits) {
		if (commit.parentCount > 1 || !commit.committedAt) continue;
		const committedAt = Date.parse(commit.committedAt);
		if (lastCommitAt === null || committedAt > lastCommitAt) lastCommitAt = committedAt;
	}
	if (lastCommitAt !== null && lastCommitAt > Date.parse(lastReview.submittedAt)) {
		return "review/needs-rereview";
	}

	const lastDecision = latest(counted.filter((review) => review.state !== "COMMENTED"));
	return lastDecision?.state === "APPROVED" ? "review/approved" : "review/awaiting-author";
}

export interface ReviewStateTarget {
	readonly pullRequestNumber: number;
	readonly authorLogin: string;
	readonly draft: boolean;
}

export async function syncReviewStateLabel(
	token: string,
	ctx: RepoContext,
	target: ReviewStateTarget,
	signal?: AbortSignal,
): Promise<ReviewStateLabel | null> {
	const number = target.pullRequestNumber;
	let desired: ReviewStateLabel | null = null;
	if (!target.draft) {
		const [reviews, commits] = await Promise.all([
			listPullRequestReviews(token, ctx, number, signal),
			listPullRequestCommits(token, ctx, number, signal),
		]);
		desired = decideReviewState(target.authorLogin, reviews, commits);
	}
	const current = await getIssueLabels(token, ctx, number, signal);
	if (desired && !current.includes(desired)) await addLabels(token, ctx, number, [desired], signal);
	for (const label of REVIEW_STATE_LABELS) {
		if (label !== desired && current.includes(label)) {
			await removeLabel(token, ctx, number, label, signal);
		}
	}
	return desired;
}

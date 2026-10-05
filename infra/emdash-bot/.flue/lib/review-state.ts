// The review/* labels that .github/workflows/review-state.yml maintains. That
// workflow cannot write labels when a review is submitted on a fork PR, so it
// skips those and the bot applies the same state from the review webhook. The
// rules here must match the workflow's, or its scheduled sweep relabels what
// the bot set.

import {
	addLabels,
	compareCommits,
	getFirstForcePushSince,
	getIssueLabels,
	listPullRequestCommits,
	listPullRequestReviews,
	removeLabel,
	type CommitComparison,
	type PullRequestCommit,
	type PullRequestReview,
	type RepoContext,
	type GitHubToken,
} from "./github.js";

export const REVIEW_STATE_LABELS = [
	"review/needs-review",
	"review/awaiting-author",
	"review/needs-rereview",
	"review/approved",
] as const;

export type ReviewStateLabel = (typeof REVIEW_STATE_LABELS)[number];

const REVIEWER_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REVIEWER_BOTS: ReadonlySet<string> = new Set(["emdashbot[bot]", "ask-bonk[bot]"]);
const COUNTED_REVIEW_STATES: ReadonlySet<string> = new Set([
	"APPROVED",
	"CHANGES_REQUESTED",
	"COMMENTED",
]);
// The compare API lists at most 300 files.
const MAX_COMPARED_FILES = 300;

type SubmittedReview = PullRequestReview & { readonly submittedAt: string };

/** The head that the first force-push after the last counted review replaced, and the head now. */
export interface ForcePushSinceReview {
	readonly replaced: CommitComparison;
	readonly current: CommitComparison;
}

function latest(reviews: readonly SubmittedReview[]): SubmittedReview | null {
	let found: SubmittedReview | null = null;
	for (const review of reviews) {
		if (!found || Date.parse(review.submittedAt) > Date.parse(found.submittedAt)) found = review;
	}
	return found;
}

function countedReviews(
	authorLogin: string,
	reviews: readonly PullRequestReview[],
): SubmittedReview[] {
	return reviews.filter(
		(review): review is SubmittedReview =>
			review.submittedAt !== null &&
			review.authorLogin !== null &&
			review.authorLogin !== authorLogin &&
			(REVIEWER_BOTS.has(review.authorLogin) ||
				REVIEWER_ASSOCIATIONS.has(review.authorAssociation ?? "")) &&
			COUNTED_REVIEW_STATES.has(review.state),
	);
}

// A merge commit is a sync with main, not new work to review.
function committedAfter(commits: readonly PullRequestCommit[], time: string): boolean {
	const after = Date.parse(time);
	return commits.some(
		(commit) =>
			commit.parentCount <= 1 && !!commit.committedAt && Date.parse(commit.committedAt) > after,
	);
}

// Added and removed lines per file, without hunk headers or context lines, so
// the same change on a newer main gives the same net diff. A file without a
// patch (binary, or a diff too large to show) counts by its blob SHA.
function netDiff(comparison: CommitComparison): string | null {
	if (comparison.files.length >= MAX_COMPARED_FILES) return null;
	return comparison.files
		.map((file) =>
			[
				file.status,
				file.previousFilename ?? "",
				file.filename,
				...(file.patch === null
					? [`blob ${file.sha}`]
					: file.patch.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"))),
			].join("\n"),
		)
		.toSorted()
		.join("\n\0\n");
}

// A rebase gives every commit a new committer date, so after a force-push the
// net diff decides whether the review still covers the PR.
function rebasedWithoutChanges(
	review: SubmittedReview,
	forcePush: ForcePushSinceReview | null,
): boolean {
	if (!forcePush) return false;
	const { replaced, current } = forcePush;
	if (replaced.commits.length < replaced.totalCommits) return false;
	if (committedAfter(replaced.commits, review.submittedAt)) return false;
	const before = netDiff(replaced);
	return before !== null && before === netDiff(current);
}

export function decideReviewState(
	authorLogin: string,
	reviews: readonly PullRequestReview[],
	commits: readonly PullRequestCommit[],
	forcePush: ForcePushSinceReview | null = null,
): ReviewStateLabel {
	const counted = countedReviews(authorLogin, reviews);
	const lastReview = latest(counted);
	if (!lastReview) return "review/needs-review";

	if (
		committedAfter(commits, lastReview.submittedAt) &&
		!rebasedWithoutChanges(lastReview, forcePush)
	) {
		return "review/needs-rereview";
	}

	const lastDecision = latest(counted.filter((review) => review.state !== "COMMENTED"));
	return lastDecision?.state === "APPROVED" ? "review/approved" : "review/awaiting-author";
}

async function readForcePushSince(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
	since: string,
	signal?: AbortSignal,
): Promise<ForcePushSinceReview | null> {
	try {
		const push = await getFirstForcePushSince(token, ctx, prNumber, since, signal);
		if (!push?.baseSha || !push.replacedSha) return null;
		const [replaced, current] = await Promise.all([
			compareCommits(token, ctx, push.baseSha, push.replacedSha, signal),
			compareCommits(token, ctx, push.baseSha, push.headSha, signal),
		]);
		return { replaced, current };
	} catch (error) {
		console.warn("[review-state] net diff not compared", {
			pullRequest: prNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export interface ReviewStateTarget {
	readonly pullRequestNumber: number;
	readonly authorLogin: string;
	readonly draft: boolean;
}

export async function syncReviewStateLabel(
	token: GitHubToken,
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
		const lastReview = latest(countedReviews(target.authorLogin, reviews));
		const forcePush =
			lastReview && committedAfter(commits, lastReview.submittedAt)
				? await readForcePushSince(token, ctx, number, lastReview.submittedAt, signal)
				: null;
		desired = decideReviewState(target.authorLogin, reviews, commits, forcePush);
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

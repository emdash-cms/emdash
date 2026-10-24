// .github/workflows/approval.yml maintains the review/* labels and the human
// approval check. A review event would run the PR branch's copy of that
// workflow, so it does not trigger on reviews. Instead the webhook re-applies the
// PR's review label when a person submits or dismisses a review; the labeled
// event runs the default branch's copy, which then sets the correct label.

import {
	addPullRequestLabel,
	getPullRequestLabels,
	removePullRequestLabel,
	type GitHubToken,
} from "./github.js";

const REVIEW_STATE_LABELS = [
	"review/needs-review",
	"review/awaiting-author",
	"review/needs-rereview",
	"review/approved",
] as const;

type ReviewStateLabel = (typeof REVIEW_STATE_LABELS)[number];

export interface ApprovalRefreshTarget {
	owner: string;
	repo: string;
	prNumber: number;
}

interface PullRequestReviewEvent {
	action?: string;
	review?: { user?: { login?: string; type?: string } };
	pull_request?: { number?: number; state?: string; draft?: boolean };
	repository?: { name?: string; owner?: { login?: string } };
}

/**
 * The PR whose approval state a review changed: a review by a person, submitted
 * or dismissed, on an open, ready PR, whoever opened it. approval.yml counts
 * only reviews by people, so a bot's review (including the empty review GitHub
 * records for each inline reply a bot posts) changes nothing and would only
 * toggle the review label.
 */
export function approvalRefreshTarget(event: PullRequestReviewEvent): ApprovalRefreshTarget | null {
	if (event.action !== "submitted" && event.action !== "dismissed") return null;
	const pr = event.pull_request;
	if (!pr || pr.state === "closed" || pr.draft === true) return null;
	const reviewer = event.review?.user;
	if (reviewer?.type === "Bot" || reviewer?.login?.endsWith("[bot]")) return null;
	const owner = event.repository?.owner?.login;
	const repo = event.repository?.name;
	if (!owner || !repo || !pr.number) return null;
	return { owner, repo, prNumber: pr.number };
}

export async function refreshApprovalState(
	token: GitHubToken,
	target: ApprovalRefreshTarget,
	signal?: AbortSignal,
): Promise<ReviewStateLabel> {
	const { owner, repo, prNumber } = target;
	const current = await getPullRequestLabels(token, owner, repo, prNumber, signal);
	const existing = REVIEW_STATE_LABELS.find((label) => current.includes(label));
	if (existing) await removePullRequestLabel(token, owner, repo, prNumber, existing, signal);
	const label = existing ?? "review/needs-review";
	await addPullRequestLabel(token, owner, repo, prNumber, label, signal);
	return label;
}

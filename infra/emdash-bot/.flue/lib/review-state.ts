// .github/workflows/approval.yml maintains the review/* labels and the human
// approval check. A review on a fork PR does not give that workflow write access,
// so the bot re-applies the PR's review label from the review webhook. The
// labeled event re-runs the workflow, which then sets the correct label.

import {
	addLabels,
	getIssueLabels,
	removeLabel,
	type GitHubToken,
	type RepoContext,
} from "./github.js";

const REVIEW_STATE_LABELS = [
	"review/needs-review",
	"review/awaiting-author",
	"review/needs-rereview",
	"review/approved",
] as const;

type ReviewStateLabel = (typeof REVIEW_STATE_LABELS)[number];

export interface ReviewStateTarget {
	readonly pullRequestNumber: number;
	readonly draft: boolean;
}

export async function refreshApprovalState(
	token: GitHubToken,
	ctx: RepoContext,
	target: ReviewStateTarget,
	signal?: AbortSignal,
): Promise<ReviewStateLabel | null> {
	if (target.draft) return null;
	const number = target.pullRequestNumber;
	const current = await getIssueLabels(token, ctx, number, signal);
	const existing = REVIEW_STATE_LABELS.find((label) => current.includes(label));
	if (existing) await removeLabel(token, ctx, number, existing, signal);
	const label = existing ?? "review/needs-review";
	await addLabels(token, ctx, number, [label], signal);
	return label;
}

// .github/workflows/approval.yml maintains the review/* labels and the human
// approval check. A review event would run the PR branch's copy of that workflow,
// so it does not trigger on reviews. Instead the bot re-applies the PR's review
// label from the review webhook; the labeled event runs the default branch's copy,
// which then sets the correct label.

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

export async function refreshApprovalState(
	token: GitHubToken,
	ctx: RepoContext,
	number: number,
	signal?: AbortSignal,
): Promise<ReviewStateLabel> {
	const current = await getIssueLabels(token, ctx, number, signal);
	const existing = REVIEW_STATE_LABELS.find((label) => current.includes(label));
	if (existing) await removeLabel(token, ctx, number, existing, signal);
	const label = existing ?? "review/needs-review";
	await addLabels(token, ctx, number, [label], signal);
	return label;
}

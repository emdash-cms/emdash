import type { PullRequestStatus } from "./github.js";

/** Automatic repairs in a row before the PR is handed to a maintainer. */
export const MAX_AUTOMATIC_REPAIRS = 3;
const MAX_REVIEW_CHARACTERS = 4_000;

export type PullRequestAssessment =
	| { readonly kind: "waiting" }
	| { readonly kind: "green" }
	| { readonly kind: "merged" }
	| { readonly kind: "closed" }
	| { readonly kind: "repair"; readonly fingerprint: string; readonly summary: string }
	| { readonly kind: "exhausted"; readonly fingerprint: string; readonly summary: string };

export function assessPullRequest(
	status: PullRequestStatus,
	lastRepairFingerprint: string | null,
	automaticRepairs = 0,
): PullRequestAssessment {
	if (status.state === "merged") return { kind: "merged" };
	if (status.state === "closed") return { kind: "closed" };

	const inherited = new Set(status.baseFailingChecks ?? []);
	const failingChecks = status.failingChecks.filter(({ name }) => !inherited.has(name));
	const inheritedChecks = status.failingChecks.filter(({ name }) => inherited.has(name));
	const changesRequested = status.review === "changes-requested";
	const conflicting = status.mergeability === "conflicting";

	const problems: string[] = [];
	if (conflicting) {
		problems.push("The branch conflicts with the PR base branch.");
	}
	if (changesRequested) {
		problems.push("A maintainer requested changes.");
	}
	if (failingChecks.length > 0) {
		const checks = failingChecks.map(({ name, url }) => (url ? `${name} (${url})` : name));
		problems.push(`Failing checks: ${checks.join(", ")}.`);
	}
	if (problems.length > 0) {
		// A change request stays in place after the bot pushes, so it is keyed by
		// the reviews behind it, not the head: only a new review is new work.
		// Failing checks and conflicts are keyed by the head they appeared on.
		// While a review or check is being repaired, GitHub's transient
		// unknown/conflicting/mergeable oscillation is not new work.
		const fingerprint = JSON.stringify({
			...(changesRequested
				? {
						reviews: [...(status.changesRequestedReviewIds ?? [])].toSorted(
							(left, right) => left - right,
						),
					}
				: {}),
			...(failingChecks.length > 0
				? {
						headSha: status.headSha,
						failingChecks: failingChecks.map(({ name }) => name).toSorted(),
					}
				: {}),
			...(conflicting && !changesRequested && failingChecks.length === 0
				? { conflictingAt: status.headSha }
				: {}),
		});
		if (fingerprint === lastRepairFingerprint) return { kind: "waiting" };
		const summary = [
			...problems,
			...(inheritedChecks.length > 0
				? [
						`Checks also failing on the base branch, not caused by this PR: ${inheritedChecks
							.map(({ name }) => name)
							.join(", ")}.`,
					]
				: []),
			...currentBotReview(status),
		].join("\n");
		return automaticRepairs >= MAX_AUTOMATIC_REPAIRS
			? { kind: "exhausted", fingerprint, summary }
			: { kind: "repair", fingerprint, summary };
	}
	if (
		inheritedChecks.length > 0 ||
		status.checks === "pending" ||
		status.checks === "none" ||
		status.mergeability === "unknown"
	) {
		return { kind: "waiting" };
	}
	return { kind: "green" };
}

function currentBotReview(status: PullRequestStatus): string[] {
	const review = status.latestBotReview;
	const body = review?.body.trim();
	if (!review || !body || review.commitSha !== status.headSha) return [];
	const bounded =
		body.length > MAX_REVIEW_CHARACTERS ? `${body.slice(0, MAX_REVIEW_CHARACTERS - 1)}…` : body;
	return ["", "Findings from the automated review of this head:", bounded];
}

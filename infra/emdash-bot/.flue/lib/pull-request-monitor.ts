import type { PullRequestStatus } from "./github.js";

export type PullRequestAssessment =
	| { readonly kind: "waiting" }
	| { readonly kind: "green" }
	| { readonly kind: "merged" }
	| { readonly kind: "closed" }
	| { readonly kind: "repair"; readonly fingerprint: string; readonly summary: string };

export function assessPullRequest(
	status: PullRequestStatus,
	lastRepairFingerprint: string | null,
): PullRequestAssessment {
	if (status.state === "merged") return { kind: "merged" };
	if (status.state === "closed") return { kind: "closed" };

	const problems: string[] = [];
	if (status.mergeability === "conflicting") {
		problems.push("The branch conflicts with the PR base branch.");
	}
	if (status.review === "changes-requested") {
		problems.push("A maintainer requested changes.");
	}
	if (status.checks === "failing") {
		const checks = status.failingChecks.map(({ name, url }) => (url ? `${name} (${url})` : name));
		problems.push(`Failing checks: ${checks.join(", ") || "unknown check"}.`);
	}
	if (problems.length > 0) {
		const hasStableRepairCause =
			status.review === "changes-requested" || status.failingChecks.length > 0;
		const fingerprint = JSON.stringify({
			headSha: status.headSha,
			// A check/review repair already rebuilds on the current base. GitHub's
			// transient unknown/conflicting/mergeable oscillation is not new work.
			mergeability: hasStableRepairCause ? "conflicting" : status.mergeability,
			review: status.review,
			failingChecks: status.failingChecks.map(({ name }) => name).toSorted(),
		});
		if (fingerprint === lastRepairFingerprint) return { kind: "waiting" };
		return { kind: "repair", fingerprint, summary: problems.join("\n") };
	}
	if (
		status.checks === "pending" ||
		status.checks === "none" ||
		status.mergeability === "unknown"
	) {
		return { kind: "waiting" };
	}
	return { kind: "green" };
}

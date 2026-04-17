/**
 * GitHub API helpers for resolving a commit SHA to a merged PR number.
 *
 * Uses the "list pull requests associated with a commit" endpoint:
 * https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit
 *
 * Called unauthenticated. The public repo endpoint has a 60 req/hr limit per IP,
 * which is far more than our deploy rate. If that ever changes, add a token:
 * `headers.authorization = "Bearer " + env.GITHUB_TOKEN`.
 */

import { GITHUB_REPO } from "./routes.js";

interface AssociatedPR {
	number: number;
	state: string;
	merged_at: string | null;
	base: { ref: string };
}
const PR_NUMBER_REGEX = /\(#(\d+)\)\s*$/;
/**
 * Parse a PR number from a commit message. GitHub squash merges append the PR
 * number in parentheses, e.g. "feat: add feature (#123)".
 */
function parsePrFromMessage(commitMessage: string): number | null {
	const match = commitMessage.match(PR_NUMBER_REGEX);
	if (!match?.[1]) return null;
	return parseInt(match[1], 10);
}

/**
 * Find the merged PR for a given commit SHA, if any.
 *
 * Strategy:
 * 1. Parse the commit message for `(#N)` — works for squash merges (the common case).
 * 2. Fall back to the GitHub "list PRs for a commit" API — works for merge commits.
 *
 * Returns null if no PR exists (e.g. direct push to main) or the lookup fails.
 */
export async function resolvePrForSha(sha: string, commitMessage?: string): Promise<number | null> {
	if (commitMessage) {
		const fromMessage = parsePrFromMessage(commitMessage);
		if (fromMessage) return fromMessage;
	}

	const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/${sha}/pulls`;

	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "emdash-perf-monitor",
				"x-github-api-version": "2022-11-28",
			},
		});
	} catch (err) {
		console.error("PR lookup failed:", err);
		return null;
	}

	if (!response.ok) {
		console.warn(`PR lookup for ${sha} returned ${response.status}`);
		return null;
	}

	const prs = await response.json<AssociatedPR[]>();

	// Prefer a merged PR targeting main. Fall back to any merged PR.
	const mainPr = prs.find((p) => p.merged_at && p.base.ref === "main");
	if (mainPr) return mainPr.number;

	const anyMerged = prs.find((p) => p.merged_at);
	if (anyMerged) return anyMerged.number;

	return null;
}

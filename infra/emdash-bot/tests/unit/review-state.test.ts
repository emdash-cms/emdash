import { afterEach, describe, expect, test, vi } from "vitest";

import type { PullRequestCommit, PullRequestReview } from "../../.flue/lib/github.js";
import {
	decideReviewState,
	parseMaintainerLogins,
	syncReviewStateLabel,
} from "../../.flue/lib/review-state.js";

const repo = { owner: "emdash-cms", repo: "emdash" };

function review(
	state: string,
	submittedAt: string,
	author: { login: string; type?: string; association?: string },
): PullRequestReview {
	return {
		state,
		submittedAt,
		authorLogin: author.login,
		authorType: author.type ?? "User",
		authorAssociation: author.association ?? "NONE",
	};
}

function commit(committedAt: string, parentCount = 1): PullRequestCommit {
	return { committedAt, parentCount };
}

const bot = { login: "emdashbot[bot]", type: "Bot" };
const maintainer = { login: "ascorbic", association: "OWNER" };
const collaborator = { login: "alice", association: "MEMBER" };
const contributor = { login: "bob", association: "CONTRIBUTOR" };

describe("parseMaintainerLogins", () => {
	test("reads only GitHub profiles inside the marked Maintainers section", () => {
		const document = `
[outside](https://github.com/not-a-maintainer)
<!-- maintainers:start -->
- [One](https://github.com/First-Maintainer)
- [Two](https://github.com/second-maintainer)
<!-- maintainers:end -->
`;
		expect([...parseMaintainerLogins(document)]).toEqual(["first-maintainer", "second-maintainer"]);
	});

	test("rejects a missing or empty marked section", () => {
		expect(() => parseMaintainerLogins("# Governance")).toThrow(/no marked Maintainers list/);
	});
});

describe("decideReviewState", () => {
	test.each([
		{
			reviewer: "Copilot",
			author: {
				login: "copilot-pull-request-reviewer[bot]",
				type: "Bot",
				association: "CONTRIBUTOR",
			},
			expected: "review/needs-review",
		},
		{
			reviewer: "code scanning",
			author: { login: "github-advanced-security[bot]", type: "Bot" },
			expected: "review/needs-review",
		},
		{ reviewer: "EmDashBot", author: bot, expected: "review/needs-review" },
		{
			reviewer: "Bonk",
			author: { login: "ask-bonk[bot]", type: "Bot", association: "CONTRIBUTOR" },
			expected: "review/needs-review",
		},
		{ reviewer: "a maintainer", author: maintainer, expected: "review/awaiting-author" },
	])("a comment review from $reviewer alone gives $expected", ({ author, expected }) => {
		expect(
			decideReviewState(
				"contributor",
				[review("COMMENTED", "2026-09-14T10:00:00Z", author)],
				[commit("2026-09-14T09:00:00Z")],
			),
		).toBe(expected);
	});

	test("ignores dismissed reviews, the author's own and non-maintainer reviews", () => {
		const commits = [commit("2026-09-14T09:00:00Z")];
		const ignored = [
			review("COMMENTED", "2026-09-14T10:00:00Z", maintainer),
			review("APPROVED", "2026-09-14T10:05:00Z", contributor),
			review("DISMISSED", "2026-09-14T10:08:00Z", bot),
			review("APPROVED", "2026-09-14T10:09:00Z", collaborator),
		];
		expect(decideReviewState(maintainer.login, ignored, commits)).toBe("review/needs-review");
		expect(
			decideReviewState(
				maintainer.login,
				[...ignored, review("COMMENTED", "2026-09-14T10:10:00Z", bot)],
				commits,
			),
		).toBe("review/needs-review");
	});

	test("a commit after the last review needs a re-review, a merge from main does not", () => {
		const reviews = [review("APPROVED", "2026-09-14T10:00:00Z", maintainer)];
		expect(
			decideReviewState("contributor", reviews, [
				commit("2026-09-14T09:00:00Z"),
				commit("2026-09-14T11:00:00Z"),
			]),
		).toBe("review/needs-rereview");
		expect(
			decideReviewState("contributor", reviews, [
				commit("2026-09-14T09:00:00Z"),
				commit("2026-09-14T11:00:00Z", 2),
			]),
		).toBe("review/approved");
	});

	test("an approval stands through a later comment, not through requested changes", () => {
		const commits = [commit("2026-09-14T09:00:00Z")];
		const approved = review("APPROVED", "2026-09-14T10:00:00Z", maintainer);
		expect(
			decideReviewState(
				"contributor",
				[approved, review("COMMENTED", "2026-09-14T11:00:00Z", collaborator)],
				commits,
			),
		).toBe("review/approved");
		expect(
			decideReviewState(
				"contributor",
				[approved, review("CHANGES_REQUESTED", "2026-09-14T11:00:00Z", maintainer)],
				commits,
			),
		).toBe("review/awaiting-author");
	});
});

describe("syncReviewStateLabel", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("refreshes an unchanged review label after a fork review", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push(`${init?.method ?? "GET"} ${url}`);
			let body: unknown = [];
			if (url.endsWith("/reviews?per_page=100&page=1")) {
				body = [
					{
						state: "APPROVED",
						submitted_at: "2026-09-14T10:00:00Z",
						user: { login: maintainer.login, type: "User" },
					},
				];
			} else if (url.endsWith("/commits?per_page=100&page=1")) {
				body = [
					{
						commit: { committer: { date: "2026-09-14T09:00:00Z" } },
						parents: [{ sha: "parent" }],
					},
				];
			} else if (url.endsWith("/labels?per_page=100")) {
				body = [{ name: "review/approved" }];
			}
			return Promise.resolve(new Response(JSON.stringify(body)));
		});

		await expect(
			syncReviewStateLabel("token", repo, {
				pullRequestNumber: 42,
				authorLogin: "contributor",
				draft: false,
			}),
		).resolves.toBe("review/approved");
		expect(requests).toEqual([
			"GET https://api.github.com/repos/emdash-cms/emdash/pulls/42/reviews?per_page=100&page=1",
			"GET https://api.github.com/repos/emdash-cms/emdash/pulls/42/commits?per_page=100&page=1",
			"GET https://api.github.com/repos/emdash-cms/emdash/issues/42/labels?per_page=100",
			"DELETE https://api.github.com/repos/emdash-cms/emdash/issues/42/labels/review%2Fapproved",
			"POST https://api.github.com/repos/emdash-cms/emdash/issues/42/labels",
		]);
	});

	test("strips the review label from a draft without reading its reviews", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push(`${init?.method ?? "GET"} ${url}`);
			const body = url.endsWith("/labels?per_page=100")
				? [{ name: "review/approved" }, { name: "area/core" }]
				: [];
			return Promise.resolve(new Response(JSON.stringify(body)));
		});

		await expect(
			syncReviewStateLabel("token", repo, {
				pullRequestNumber: 42,
				authorLogin: "contributor",
				draft: true,
			}),
		).resolves.toBeNull();
		expect(requests).toEqual([
			"GET https://api.github.com/repos/emdash-cms/emdash/issues/42/labels?per_page=100",
			"DELETE https://api.github.com/repos/emdash-cms/emdash/issues/42/labels/review%2Fapproved",
		]);
	});
});

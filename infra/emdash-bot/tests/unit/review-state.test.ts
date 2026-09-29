import { afterEach, describe, expect, test, vi } from "vitest";

import type { PullRequestCommit, PullRequestReview } from "../../.flue/lib/github.js";
import { decideReviewState, syncReviewStateLabel } from "../../.flue/lib/review-state.js";

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
const maintainer = { login: "alice", association: "MEMBER" };
const contributor = { login: "bob", association: "CONTRIBUTOR" };

describe("decideReviewState", () => {
	test("ignores dismissed reviews, the author's own and contributors' reviews", () => {
		const commits = [commit("2026-09-14T09:00:00Z")];
		const ignored = [
			review("COMMENTED", "2026-09-14T10:00:00Z", maintainer),
			review("APPROVED", "2026-09-14T10:05:00Z", contributor),
			review("DISMISSED", "2026-09-14T10:08:00Z", bot),
		];
		expect(decideReviewState(maintainer.login, ignored, commits)).toBe("review/needs-review");
		expect(
			decideReviewState(
				maintainer.login,
				[...ignored, review("COMMENTED", "2026-09-14T10:10:00Z", bot)],
				commits,
			),
		).toBe("review/awaiting-author");
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
				[approved, review("COMMENTED", "2026-09-14T11:00:00Z", bot)],
				commits,
			),
		).toBe("review/approved");
		expect(
			decideReviewState(
				"contributor",
				[approved, review("CHANGES_REQUESTED", "2026-09-14T11:00:00Z", bot)],
				commits,
			),
		).toBe("review/awaiting-author");
	});
});

describe("syncReviewStateLabel", () => {
	afterEach(() => vi.unstubAllGlobals());

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

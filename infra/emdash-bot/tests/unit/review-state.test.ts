import { afterEach, describe, expect, test, vi } from "vitest";

import type {
	CommitComparison,
	ComparedFile,
	PullRequestCommit,
	PullRequestReview,
} from "../../.flue/lib/github.js";
import {
	decideReviewState,
	syncReviewStateLabel,
	type ForcePushSinceReview,
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

function changed(filename: string, patch: string | null, sha = "5f1a2b"): ComparedFile {
	return { filename, previousFilename: null, status: "modified", sha, patch };
}

function comparison(
	commits: PullRequestCommit[],
	files: ComparedFile[],
	totalCommits = commits.length,
): CommitComparison {
	return { totalCommits, commits, files };
}

const bot = { login: "emdashbot[bot]", type: "Bot" };
const maintainer = { login: "alice", association: "MEMBER" };
const contributor = { login: "bob", association: "CONTRIBUTOR" };

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
		{ reviewer: "EmDashBot", author: bot, expected: "review/awaiting-author" },
		{
			reviewer: "Bonk",
			author: { login: "ask-bonk[bot]", type: "Bot", association: "CONTRIBUTOR" },
			expected: "review/awaiting-author",
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

	describe("after a force-push", () => {
		const approval = [review("APPROVED", "2026-09-23T19:18:29Z", bot)];
		const comment = [review("COMMENTED", "2026-09-23T19:18:29Z", bot)];
		const reviewed = [commit("2026-09-21T10:00:00Z"), commit("2026-09-21T10:05:00Z")];
		const rebased = [commit("2026-09-30T03:07:16Z"), commit("2026-09-30T03:07:16Z")];
		const synced = [...rebased, commit("2026-10-01T09:00:00Z", 2)];
		const image = changed("public/og.jpg", null, "07d3e1");
		const before = [
			changed(
				"src/query.ts",
				"@@ -10,4 +10,4 @@ export function search(\n const terms = split(q);\n-return match(terms);\n+return match(escape(terms));\n }",
			),
			image,
		];
		const onNewerMain = [
			changed(
				"src/query.ts",
				"@@ -14,4 +14,4 @@ export function search(query: string) {\n const terms = splitWords(query);\n-return match(terms);\n+return match(escape(terms));\n }",
			),
			image,
		];
		const lineAdded = [
			changed(
				"src/query.ts",
				"@@ -14,4 +14,5 @@ export function search(query: string) {\n const terms = splitWords(query);\n-return match(terms);\n+if (!terms.length) return [];\n+return match(escape(terms));\n }",
			),
			image,
		];
		const imageReplaced = [onNewerMain[0]!, changed("public/og.jpg", null, "9c40be")];
		const manyFiles = Array.from({ length: 300 }, (_, index) =>
			changed(`src/file-${index}.ts`, "@@ -1 +1 @@\n-a\n+b"),
		);
		const rebase = (replaced: CommitComparison, current = comparison(rebased, onNewerMain)) => ({
			replaced,
			current,
		});

		test.each<{
			name: string;
			reviews: PullRequestReview[];
			commits: PullRequestCommit[];
			forcePush: ForcePushSinceReview | null;
			expected: string;
		}>([
			{
				name: "an approved PR rebased onto a newer main",
				reviews: approval,
				commits: rebased,
				forcePush: rebase(comparison(reviewed, before)),
				expected: "review/approved",
			},
			{
				name: "a commented PR rebased onto a newer main",
				reviews: comment,
				commits: rebased,
				forcePush: rebase(comparison(reviewed, before)),
				expected: "review/awaiting-author",
			},
			{
				name: "a rebased PR merged with main",
				reviews: approval,
				commits: synced,
				forcePush: rebase(comparison(reviewed, before), comparison(synced, onNewerMain)),
				expected: "review/approved",
			},
			{
				name: "a rebase that adds a line",
				reviews: approval,
				commits: rebased,
				forcePush: rebase(comparison(reviewed, before), comparison(rebased, lineAdded)),
				expected: "review/needs-rereview",
			},
			{
				name: "a rebase that replaces a binary file",
				reviews: approval,
				commits: rebased,
				forcePush: rebase(comparison(reviewed, before), comparison(rebased, imageReplaced)),
				expected: "review/needs-rereview",
			},
			{
				name: "a commit pushed between the review and the force-push",
				reviews: approval,
				commits: rebased,
				forcePush: rebase(comparison([...reviewed, commit("2026-09-25T08:00:00Z")], before)),
				expected: "review/needs-rereview",
			},
			{
				name: "a net diff the compare API cuts off at 300 files",
				reviews: approval,
				commits: rebased,
				forcePush: rebase(comparison(reviewed, manyFiles), comparison(rebased, manyFiles)),
				expected: "review/needs-rereview",
			},
			{
				name: "a replaced head with more commits than the compare API lists",
				reviews: approval,
				commits: rebased,
				forcePush: rebase(comparison(reviewed, before, 251)),
				expected: "review/needs-rereview",
			},
			{
				name: "a force-push that could not be compared",
				reviews: approval,
				commits: rebased,
				forcePush: null,
				expected: "review/needs-rereview",
			},
		])("$name gives $expected", ({ reviews, commits, forcePush, expected }) => {
			expect(decideReviewState("contributor", reviews, commits, forcePush)).toBe(expected);
		});
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

	describe("after a force-push", () => {
		const api = "https://api.github.com/repos/emdash-cms/emdash";
		const restCommit = (date: string) => ({ parents: [{}], commit: { committer: { date } } });
		const restFile = (patch: string) => ({
			filename: "src/query.ts",
			status: "modified",
			sha: "73d349",
			patch,
		});

		interface Stub {
			baseRef?: { target: { oid: string } } | null;
			replacedSha?: string;
			committedAt?: string;
		}

		function stubGitHub({
			baseRef = { target: { oid: "9d4962" } },
			replacedSha = "698953",
			committedAt = "2026-09-30T03:07:16Z",
		}: Stub = {}) {
			const requests: string[] = [];
			const responses: Record<string, unknown> = {
				[`GET ${api}/pulls/42/reviews?per_page=100&page=1`]: [
					{
						state: "APPROVED",
						submitted_at: "2026-09-23T19:18:29Z",
						author_association: "NONE",
						user: { login: "emdashbot[bot]", type: "Bot" },
					},
				],
				[`GET ${api}/pulls/42/commits?per_page=100&page=1`]: [restCommit(committedAt)],
				"POST https://api.github.com/graphql": {
					data: {
						repository: {
							pullRequest: {
								headRefOid: "3228c6",
								baseRef,
								timelineItems: { nodes: [{ beforeCommit: { oid: replacedSha } }] },
							},
						},
					},
				},
				[`GET ${api}/compare/9d4962...698953`]: {
					total_commits: 1,
					commits: [restCommit("2026-09-21T10:00:00Z")],
					files: [
						restFile(
							"@@ -10,3 +10,3 @@\n const terms = split(q);\n-return match(terms);\n+return match(escape(terms));",
						),
					],
				},
				[`GET ${api}/compare/9d4962...3228c6`]: {
					total_commits: 1,
					commits: [restCommit("2026-09-30T03:07:16Z")],
					files: [
						restFile(
							"@@ -14,3 +14,3 @@\n const terms = splitWords(q);\n-return match(terms);\n+return match(escape(terms));",
						),
					],
				},
				[`GET ${api}/issues/42/labels?per_page=100`]: [{ name: "review/needs-rereview" }],
			};
			vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const request = `${init?.method ?? "GET"} ${url}`;
				requests.push(request);
				if (!(request in responses) && url.includes("/compare/")) {
					return Promise.resolve(new Response("{}", { status: 404 }));
				}
				return Promise.resolve(new Response(JSON.stringify(responses[request] ?? [])));
			});
			return requests;
		}

		test("keeps the approval when the rebased net diff matches the replaced head's", async () => {
			const requests = stubGitHub();

			await expect(
				syncReviewStateLabel("token", repo, {
					pullRequestNumber: 42,
					authorLogin: "contributor",
					draft: false,
				}),
			).resolves.toBe("review/approved");
			expect(requests).toEqual([
				`GET ${api}/pulls/42/reviews?per_page=100&page=1`,
				`GET ${api}/pulls/42/commits?per_page=100&page=1`,
				"POST https://api.github.com/graphql",
				`GET ${api}/compare/9d4962...698953`,
				`GET ${api}/compare/9d4962...3228c6`,
				`GET ${api}/issues/42/labels?per_page=100`,
				`POST ${api}/issues/42/labels`,
				`DELETE ${api}/issues/42/labels/review%2Fneeds-rereview`,
			]);
		});

		test.each<{ name: string; stub: Stub; compares: string[] }>([
			{ name: "the base branch is gone", stub: { baseRef: null }, compares: [] },
			{
				name: "the replaced head cannot be compared",
				stub: { replacedSha: "0ab1c2" },
				compares: [`GET ${api}/compare/9d4962...0ab1c2`, `GET ${api}/compare/9d4962...3228c6`],
			},
		])("asks for a re-review when $name", async ({ stub, compares }) => {
			const requests = stubGitHub(stub);

			await expect(
				syncReviewStateLabel("token", repo, {
					pullRequestNumber: 42,
					authorLogin: "contributor",
					draft: false,
				}),
			).resolves.toBe("review/needs-rereview");
			expect(requests).toEqual([
				`GET ${api}/pulls/42/reviews?per_page=100&page=1`,
				`GET ${api}/pulls/42/commits?per_page=100&page=1`,
				"POST https://api.github.com/graphql",
				...compares,
				`GET ${api}/issues/42/labels?per_page=100`,
			]);
		});

		test("looks for no force-push when no commit is newer than the review", async () => {
			const requests = stubGitHub({ committedAt: "2026-09-21T10:00:00Z" });

			await expect(
				syncReviewStateLabel("token", repo, {
					pullRequestNumber: 42,
					authorLogin: "contributor",
					draft: false,
				}),
			).resolves.toBe("review/approved");
			expect(requests).not.toContain("POST https://api.github.com/graphql");
		});
	});
});

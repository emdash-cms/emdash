import { afterEach, describe, expect, test, vi } from "vitest";

import {
	createIssueComment,
	findIssueCommentByMarker,
	getIssueComments,
	getPullRequestHeadBranch,
	listOpenManagedIssues,
	updateIssueComment,
} from "../../.flue/lib/github.js";

const repo = { owner: "emdash-cms", repo: "emdash" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("GitHub issue context requests", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("reads the newest page of comments since the stored diagnosis", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response("[]", {
					headers: {
						link: '<https://api.github.com/repositories/1/issues/42/comments?per_page=100&page=3>; rel="last"',
					},
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse([
					{
						id: 99,
						body: "A useful follow-up",
						author_association: "MEMBER",
						created_at: "2026-08-17T11:00:00.000Z",
						user: { login: "alice", type: "User" },
					},
				]),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			getIssueComments("token", repo, 42, { since: "2026-08-17T10:00:00.000Z" }),
		).resolves.toEqual([
			{
				id: 99,
				body: "A useful follow-up",
				authorLogin: "alice",
				authorAssociation: "MEMBER",
				authorType: "User",
				createdAt: "2026-08-17T11:00:00.000Z",
			},
		]);
		expect(fetchMock.mock.calls[1]?.[0]).toContain("page=3");
		expect(fetchMock.mock.calls[1]?.[0]).toContain("since=2026-08-17T10%3A00%3A00.000Z");
	});

	test("uses the issue comment count to request only the bounded recent page", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		await getIssueComments("token", repo, 42, { commentCount: 250 });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toContain("page=3");
	});
});

describe("GitHub evolving comments", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("creates, updates, and recovers a comment by marker", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse(
					{
						id: 777,
						body: "Working\n\n<!-- emdashbot-run:run-1 -->",
						html_url: "https://github.com/emdash-cms/emdash/issues/42#issuecomment-777",
					},
					201,
				),
			)
			.mockResolvedValueOnce(jsonResponse({}))
			.mockResolvedValueOnce(
				jsonResponse([
					{
						id: 777,
						body: "Completed\n\n<!-- emdashbot-run:run-1 -->",
						html_url: "https://github.com/emdash-cms/emdash/issues/42#issuecomment-777",
					},
				]),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			createIssueComment("token", repo, 42, "Working\n\n<!-- emdashbot-run:run-1 -->"),
		).resolves.toMatchObject({ id: 777 });
		await updateIssueComment("token", repo, 777, "Completed");
		await expect(
			findIssueCommentByMarker("token", repo, 42, "<!-- emdashbot-run:run-1 -->"),
		).resolves.toMatchObject({ id: 777, body: expect.stringContaining("Completed") });

		expect(fetchMock.mock.calls.map(([url, init]) => [init?.method ?? "GET", url])).toEqual([
			["POST", "https://api.github.com/repos/emdash-cms/emdash/issues/42/comments"],
			["PATCH", "https://api.github.com/repos/emdash-cms/emdash/issues/comments/777"],
			[
				"GET",
				"https://api.github.com/repos/emdash-cms/emdash/issues/42/comments?per_page=100&page=1",
			],
		]);
	});

	test("reports a deleted comment so the projection can recreate it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 })),
		);

		await expect(updateIssueComment("token", repo, 777, "Updated")).resolves.toBe(false);
	});
});

describe("GitHub pull request lookup", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("reads the head branch for a top-level PR comment", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				number: 99,
				head: { ref: "bot/fix-42" },
				user: { login: "emdashbot[bot]" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getPullRequestHeadBranch("token", repo, 99)).resolves.toBe("bot/fix-42");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/pulls/99",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Bearer token" }),
			}),
		);
	});
});

describe("GitHub dashboard requests", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("lists open bot-managed issues without pull requests or duplicates", async () => {
		const issue = {
			number: 42,
			title: "A managed issue",
			html_url: "https://github.com/emdash-cms/emdash/issues/42",
			updated_at: "2026-08-18T10:00:00Z",
			labels: [{ name: "bot:bug" }, { name: "bot:working" }],
		};
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse([issue]))
			.mockResolvedValueOnce(
				jsonResponse([
					{ ...issue, labels: [{ name: "bot:enhancement" }, { name: "bot:working" }] },
					{
						number: 43,
						title: "A bot pull request",
						html_url: "https://github.com/emdash-cms/emdash/pull/43",
						updated_at: "2026-08-18T11:00:00Z",
						labels: [{ name: "bot:enhancement" }, { name: "bot:in-review" }],
						pull_request: {},
					},
				]),
			)
			.mockResolvedValueOnce(
				jsonResponse([
					{
						number: 44,
						title: "A managed task",
						html_url: "https://github.com/emdash-cms/emdash/issues/44",
						updated_at: "2026-08-18T12:00:00Z",
						labels: [{ name: "bot:task" }, { name: "bot:blocked" }],
					},
				]),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(listOpenManagedIssues("token", repo)).resolves.toEqual([
			{
				number: 44,
				title: "A managed task",
				url: "https://github.com/emdash-cms/emdash/issues/44",
				updatedAt: "2026-08-18T12:00:00Z",
				labels: ["bot:task", "bot:blocked"],
			},
			{
				number: 42,
				title: "A managed issue",
				url: "https://github.com/emdash-cms/emdash/issues/42",
				updatedAt: "2026-08-18T10:00:00Z",
				labels: ["bot:bug", "bot:working"],
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls.map(([url]) => requestUrl(url))).toEqual([
			expect.stringContaining("labels=bot%3Abug"),
			expect.stringContaining("labels=bot%3Aenhancement"),
			expect.stringContaining("labels=bot%3Atask"),
		]);
	});
});

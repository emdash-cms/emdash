import { afterEach, describe, expect, test, vi } from "vitest";

import {
	createBranch,
	createGitBlob,
	createGitCommit,
	createGitTree,
	getGitCommit,
	getIssueComments,
	listOpenManagedIssues,
	updateBranch,
} from "../../.flue/lib/github.js";

const repo = { owner: "emdash-cms", repo: "emdash" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function parseJsonBody(body: unknown): unknown {
	if (typeof body !== "string") throw new Error("expected a string request body");
	return JSON.parse(body);
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("GitHub Git Data requests", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("uses the documented blob, tree, and commit request shapes", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ tree: { sha: "base-tree" }, message: "base" }))
			.mockResolvedValueOnce(jsonResponse({ sha: "blob-sha" }))
			.mockResolvedValueOnce(jsonResponse({ sha: "tree-sha" }))
			.mockResolvedValueOnce(jsonResponse({ sha: "commit-sha" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getGitCommit("token", repo, "base/sha")).resolves.toEqual({
			treeSha: "base-tree",
			message: "base",
		});
		await expect(createGitBlob("token", repo, new Uint8Array([0, 255]))).resolves.toBe("blob-sha");
		await expect(
			createGitTree("token", repo, "base-tree", [
				{ path: "src/x.ts", mode: "100644", type: "blob", sha: "blob-sha" },
				{ path: "src/old.ts", mode: "100644", type: "blob", sha: null },
			]),
		).resolves.toBe("tree-sha");
		await expect(createGitCommit("token", repo, "Fix it", "tree-sha", "parent-sha")).resolves.toBe(
			"commit-sha",
		);

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"https://api.github.com/repos/emdash-cms/emdash/git/commits/base%2Fsha",
			"https://api.github.com/repos/emdash-cms/emdash/git/blobs",
			"https://api.github.com/repos/emdash-cms/emdash/git/trees",
			"https://api.github.com/repos/emdash-cms/emdash/git/commits",
		]);
		expect(parseJsonBody(fetchMock.mock.calls[1]?.[1]?.body)).toEqual({
			content: "AP8=",
			encoding: "base64",
		});
		expect(parseJsonBody(fetchMock.mock.calls[2]?.[1]?.body)).toEqual({
			base_tree: "base-tree",
			tree: [
				{ path: "src/x.ts", mode: "100644", type: "blob", sha: "blob-sha" },
				{ path: "src/old.ts", mode: "100644", type: "blob", sha: null },
			],
		});
		expect(parseJsonBody(fetchMock.mock.calls[3]?.[1]?.body)).toEqual({
			message: "Fix it",
			tree: "tree-sha",
			parents: ["parent-sha"],
		});
	});

	test("creates the scoped ref and updates it without force", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
		vi.stubGlobal("fetch", fetchMock);

		await createBranch("token", repo, "bot/fix-2299", "commit-sha");
		await updateBranch("token", repo, "bot/fix-2299", "next-sha");

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/repos/emdash-cms/emdash/git/refs",
		);
		expect(parseJsonBody(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({
			ref: "refs/heads/bot/fix-2299",
			sha: "commit-sha",
		});
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.github.com/repos/emdash-cms/emdash/git/refs/heads/bot%2Ffix-2299",
		);
		expect(parseJsonBody(fetchMock.mock.calls[1]?.[1]?.body)).toEqual({
			sha: "next-sha",
			force: false,
		});
	});
});

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

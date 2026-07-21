import { afterEach, describe, expect, it, vi } from "vitest";

import {
	completeReviewCheck,
	createReviewCheck,
	findReviewCheck,
	fetchUnifiedDiff,
	postReview,
	removePullRequestLabel,
	updateReviewCheck,
} from "../.flue/lib/github.js";

const TOKEN = "installation-token";

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
	const init = fetchMock.mock.calls[0]?.[1];
	if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
	return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GitHub review checks", () => {
	it("removes the manual review label", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await removePullRequestLabel(TOKEN, "emdash-cms", "emdash", 42, "bot:review");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/issues/42/labels/bot%3Areview",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("creates an in-progress check for the admitted head commit", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: 1234 }, { status: 201 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			createReviewCheck(TOKEN, "emdash-cms", "emdash", {
				headSha: "abc123",
				attemptId: "attempt-1",
				prNumber: 42,
			}),
		).resolves.toBe(1234);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/check-runs",
			expect.objectContaining({
				method: "POST",
			}),
		);
		expect(requestBody(fetchMock)).toMatchObject({
			name: "EmDashBot review",
			head_sha: "abc123",
			status: "in_progress",
			details_url: "https://github.com/emdash-cms/emdash/pull/42/files",
			external_id: "attempt-1",
			started_at: expect.any(String),
			output: {
				title: "Reviewing PR #42",
				summary: "The review request was accepted and is being admitted.",
			},
		});
	});

	it("updates an ongoing check with the run and current stage", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await updateReviewCheck(TOKEN, "emdash-cms", "emdash", 1234, {
			prNumber: 42,
			runId: "run_123",
			stage: "model_review",
			detail: "The model is reviewing the diff.",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/check-runs/1234",
			expect.objectContaining({ method: "PATCH" }),
		);
		expect(requestBody(fetchMock)).toEqual({
			status: "in_progress",
			external_id: "run_123",
			details_url: "https://github.com/emdash-cms/emdash/pull/42/files",
			output: {
				title: "Analyzing PR #42",
				summary:
					"The model is reviewing the diff. This is usually the longest step and can take several minutes. Next, EmDashBot will publish the review to GitHub.",
				text: [
					"### Progress",
					"",
					"- [x] Prepare the workspace",
					"- [x] Load the pull request diff",
					"- [ ] **Analyze the changes (in progress)**",
					"- [ ] Publish the review",
					"",
					"<details>",
					"<summary>Diagnostics</summary>",
					"",
					"Run ID: `run_123`",
					"",
					"Stage: `model_review`",
					"</details>",
				].join("\n"),
			},
		});
	});

	it("completes a failed check with a safe public error", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await completeReviewCheck(TOKEN, "emdash-cms", "emdash", 1234, {
			conclusion: "failure",
			prNumber: 42,
			runId: "run_123",
			summary: "The review run failed before it could post a review.",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/check-runs/1234",
			expect.objectContaining({ method: "PATCH" }),
		);
		expect(requestBody(fetchMock)).toMatchObject({
			status: "completed",
			conclusion: "failure",
			details_url: "https://github.com/emdash-cms/emdash/pull/42",
			completed_at: expect.any(String),
			external_id: "run_123",
			output: {
				title: "Review failed for PR #42",
				summary: "The review run failed before it could post a review.",
				text: "Run: `run_123`",
			},
		});
	});

	it("surfaces a Checks API rejection", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response("checks permission missing", { status: 403 })),
		);

		await expect(
			createReviewCheck(TOKEN, "emdash-cms", "emdash", {
				headSha: "abc123",
				attemptId: "attempt-1",
				prNumber: 42,
			}),
		).rejects.toThrow("create review check failed: 403 checks permission missing");
	});

	it("fetches a diff pinned to the captured base and head commits", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("diff --git a/a b/a"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchUnifiedDiff("emdash-cms", "emdash", 42, TOKEN, "base-sha", "head-sha"),
		).resolves.toContain("diff --git");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/compare/base-sha...head-sha",
			expect.any(Object),
		);
	});

	it("posts a review against the captured head commit", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await postReview(
			TOKEN,
			"emdash-cms",
			"emdash",
			42,
			{ verdict: "approve", summary: "Looks good", findings: [] },
			"head-sha",
		);

		expect(requestBody(fetchMock)).toMatchObject({
			event: "APPROVE",
			commit_id: "head-sha",
		});
	});

	it("recovers an existing check by deterministic external id", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				check_runs: [
					{ id: 123, external_id: "another-attempt" },
					{ id: 456, external_id: "attempt-1" },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			findReviewCheck(TOKEN, "emdash-cms", "emdash", "head-sha", "attempt-1"),
		).resolves.toBe(456);
	});

	it("does not retry a review POST after an ambiguous server error", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("server error", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postReview(
				TOKEN,
				"emdash-cms",
				"emdash",
				42,
				{ verdict: "approve", summary: "Looks good", findings: [] },
				"head-sha",
			),
		).rejects.toThrow("postReview failed: 503 server error");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reconciles an ambiguously successful review POST by attempt marker", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json([]))
			.mockResolvedValueOnce(new Response("server error", { status: 503 }))
			.mockResolvedValueOnce(
				Response.json([
					{
						body: "Looks good\n\n<!-- emdash-review-attempt:attempt-1 -->",
						commit_id: "head-sha",
					},
				]),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postReview(
				TOKEN,
				"emdash-cms",
				"emdash",
				42,
				{ verdict: "approve", summary: "Looks good", findings: [] },
				"head-sha",
				"attempt-1",
			),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("fails closed when review marker inspection is unavailable", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("unavailable", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postReview(
				TOKEN,
				"emdash-cms",
				"emdash",
				42,
				{ verdict: "approve", summary: "Looks good", findings: [] },
				"head-sha",
				"attempt-1",
			),
		).rejects.toThrow("review marker inspection failed: 503");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not post a review whose attempt marker already exists", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json([
				{
					body: "Looks good\n\n<!-- emdash-review-attempt:attempt-1 -->",
					commit_id: "head-sha",
				},
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postReview(
				TOKEN,
				"emdash-cms",
				"emdash",
				42,
				{ verdict: "approve", summary: "Looks good", findings: [] },
				"head-sha",
				"attempt-1",
			),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/pulls/42/reviews?per_page=100",
			expect.objectContaining({ headers: expect.any(Object) }),
		);
	});

	it("finds an existing attempt marker on a later reviews page", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json(
					Array.from({ length: 100 }, (_, index) => ({
						body: `Review ${index}`,
						commit_id: "head-sha",
					})),
				),
			)
			.mockResolvedValueOnce(
				Response.json([
					{
						body: "Looks good\n\n<!-- emdash-review-attempt:attempt-1 -->",
						commit_id: "head-sha",
					},
				]),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postReview(
				TOKEN,
				"emdash-cms",
				"emdash",
				42,
				{ verdict: "approve", summary: "Looks good", findings: [] },
				"head-sha",
				"attempt-1",
			),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://api.github.com/repos/emdash-cms/emdash/pulls/42/reviews?per_page=100&page=2",
			expect.any(Object),
		);
	});

	it("fails closed after inspecting 10 full review pages", async () => {
		const reviews = Array.from({ length: 100 }, (_, index) => ({
			body: `Review ${index}`,
			commit_id: "head-sha",
		}));
		const fetchMock = vi.fn<typeof fetch>();
		for (let page = 0; page < 10; page++) {
			fetchMock.mockResolvedValueOnce(Response.json(reviews));
		}
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postReview(
				TOKEN,
				"emdash-cms",
				"emdash",
				42,
				{ verdict: "approve", summary: "Looks good", findings: [] },
				"head-sha",
				"attempt-1",
			),
		).rejects.toThrow("review marker inspection exceeded 10 pages");
		expect(fetchMock).toHaveBeenCalledTimes(10);
	});
});

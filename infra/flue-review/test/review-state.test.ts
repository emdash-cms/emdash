import { afterEach, describe, expect, it, vi } from "vitest";

import { approvalRefreshTarget, refreshApprovalState } from "../.flue/lib/review-state.js";

const api = "https://api.github.com/repos/emdash-cms/emdash";
const repository = { name: "emdash", owner: { login: "emdash-cms" } };
const openPullRequest = { number: 120, state: "open", draft: false };
const person = { login: "alice", type: "User" };
const target = { owner: "emdash-cms", repo: "emdash", prNumber: 42 };

function stubLabels(labels: string[]): string[] {
	const requests: string[] = [];
	vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const payload = typeof init?.body === "string" ? ` ${init.body}` : "";
		requests.push(`${method} ${url}${payload}`);
		const body = url.endsWith("/labels?per_page=100") ? labels.map((name) => ({ name })) : [];
		return Promise.resolve(Response.json(body));
	});
	return requests;
}

describe("approvalRefreshTarget", () => {
	it.each(["submitted", "dismissed"])(
		"%s by a person on an open PR refreshes it, whoever opened it",
		(action) => {
			expect(
				approvalRefreshTarget({
					action,
					review: { user: person },
					pull_request: openPullRequest,
					repository,
				}),
			).toEqual({ owner: "emdash-cms", repo: "emdash", prNumber: 120 });
		},
	);

	it("refreshes nothing for a closed or draft PR, or another review action", () => {
		for (const [action, pullRequest] of [
			["submitted", { ...openPullRequest, state: "closed" }],
			["submitted", { ...openPullRequest, draft: true }],
			["edited", openPullRequest],
		] as const) {
			expect(
				approvalRefreshTarget({
					action,
					review: { user: person },
					pull_request: pullRequest,
					repository,
				}),
			).toBeNull();
		}
	});

	it("refreshes nothing for a review by a bot, since approval counts only people", () => {
		for (const user of [
			{ login: "emdashbot[bot]", type: "Bot" },
			{ login: "emdash-autofix[bot]", type: "Bot" },
			{ login: "some-app[bot]" },
		]) {
			expect(
				approvalRefreshTarget({
					action: "submitted",
					review: { user },
					pull_request: openPullRequest,
					repository,
				}),
			).toBeNull();
		}
	});
});

describe("refreshApprovalState", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("re-applies the PR's current review label so the approval workflow re-runs", async () => {
		const requests = stubLabels(["area/core", "review/approved"]);

		await expect(refreshApprovalState("token", target)).resolves.toBe("review/approved");
		expect(requests).toEqual([
			`GET ${api}/issues/42/labels?per_page=100`,
			`DELETE ${api}/issues/42/labels/review%2Fapproved`,
			`POST ${api}/issues/42/labels {"labels":["review/approved"]}`,
		]);
	});

	it("applies needs-review when the PR has no review label yet", async () => {
		const requests = stubLabels(["area/core"]);

		await expect(refreshApprovalState("token", target)).resolves.toBe("review/needs-review");
		expect(requests).toEqual([
			`GET ${api}/issues/42/labels?per_page=100`,
			`POST ${api}/issues/42/labels {"labels":["review/needs-review"]}`,
		]);
	});
});

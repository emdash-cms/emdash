import { afterEach, describe, expect, test, vi } from "vitest";

import { refreshApprovalState } from "../../.flue/lib/review-state.js";

const repo = { owner: "emdash-cms", repo: "emdash" };
const api = "https://api.github.com/repos/emdash-cms/emdash";

function stubLabels(labels: string[]): string[] {
	const requests: string[] = [];
	vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const payload = typeof init?.body === "string" ? ` ${init.body}` : "";
		requests.push(`${method} ${url}${payload}`);
		const body = url.endsWith("/labels?per_page=100") ? labels.map((name) => ({ name })) : [];
		return Promise.resolve(new Response(JSON.stringify(body)));
	});
	return requests;
}

describe("refreshApprovalState", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("re-applies the PR's current review label so the approval workflow re-runs", async () => {
		const requests = stubLabels(["area/core", "review/approved"]);

		await expect(refreshApprovalState("token", repo, 42)).resolves.toBe("review/approved");
		expect(requests).toEqual([
			`GET ${api}/issues/42/labels?per_page=100`,
			`DELETE ${api}/issues/42/labels/review%2Fapproved`,
			`POST ${api}/issues/42/labels {"labels":["review/approved"]}`,
		]);
	});

	test("applies needs-review when the PR has no review label yet", async () => {
		const requests = stubLabels(["area/core"]);

		await expect(refreshApprovalState("token", repo, 42)).resolves.toBe("review/needs-review");
		expect(requests).toEqual([
			`GET ${api}/issues/42/labels?per_page=100`,
			`POST ${api}/issues/42/labels {"labels":["review/needs-review"]}`,
		]);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchGitHubEmail } from "./github.js";

describe("fetchGitHubEmail", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends User-Agent header required by GitHub API", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify([{ email: "user@example.com", primary: true, verified: true }]), {
				status: 200,
			}),
		);

		await fetchGitHubEmail("test-token");

		const [, init] = mockFetch.mock.calls[0] ?? [];
		const headers = init?.headers as Record<string, string> | undefined;
		expect(headers?.["User-Agent"]).toBe("emdash-cms");
	});

	it("returns the primary verified email", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify([
					{ email: "other@example.com", primary: false, verified: true },
					{ email: "primary@example.com", primary: true, verified: true },
				]),
				{ status: 200 },
			),
		);

		const email = await fetchGitHubEmail("test-token");

		expect(email).toBe("primary@example.com");
	});

	it("throws when GitHub API returns 403 (e.g. missing User-Agent)", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));

		await expect(fetchGitHubEmail("test-token")).rejects.toThrow(
			"Failed to fetch GitHub emails: 403",
		);
	});

	it("throws when no verified primary email exists", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify([{ email: "unverified@example.com", primary: true, verified: false }]),
				{ status: 200 },
			),
		);

		await expect(fetchGitHubEmail("test-token")).rejects.toThrow(
			"No verified primary email found on GitHub account",
		);
	});
});

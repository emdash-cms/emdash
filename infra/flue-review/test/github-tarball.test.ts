import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRepositoryTarball, type GitHubRateLimitGate } from "../.flue/lib/github.js";

const TOKEN = "installation-token";
const SHA = "b332bee1aa502a42ffef104b1517f6dc5b84ce76";
const API_URL = `https://api.github.com/repos/emdash-cms/emdash/tarball/${SHA}`;
const DOWNLOAD_URL = `https://codeload.github.com/emdash-cms/emdash/legacy.tar.gz/${SHA}`;

function coordinatedToken(gate: GitHubRateLimitGate) {
	return { token: TOKEN, gate, consumer: "review-workflow:attempt-1" };
}

function acceptingGate(): GitHubRateLimitGate {
	return {
		permit: vi.fn().mockResolvedValue({ allowed: true, retryAt: 0 }),
		getInstallationToken: vi.fn().mockResolvedValue(TOKEN),
		record: vi.fn().mockResolvedValue(undefined),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GitHub repository tarball", () => {
	it("authenticates the API and validated codeload requests", async () => {
		const gate = acceptingGate();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: DOWNLOAD_URL } }),
			)
			.mockResolvedValueOnce(new Response("archive", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const tarball = await fetchRepositoryTarball(
			"emdash-cms",
			"emdash",
			SHA,
			coordinatedToken(gate),
		);

		await expect(new Response(tarball).text()).resolves.toBe("archive");
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			API_URL,
			expect.objectContaining({
				redirect: "manual",
				headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			DOWNLOAD_URL,
			expect.objectContaining({
				redirect: "manual",
				headers: expect.objectContaining({
					authorization: `Basic ${btoa(`x-access-token:${TOKEN}`)}`,
				}),
			}),
		);
		expect(gate.permit).toHaveBeenCalledTimes(2);
		expect(gate.record).toHaveBeenNthCalledWith(
			1,
			"review-rest",
			"review-workflow:attempt-1",
			expect.objectContaining({ status: 302 }),
		);
		expect(gate.record).toHaveBeenNthCalledWith(
			2,
			"review-rest",
			"review-workflow:attempt-1",
			expect.objectContaining({ status: 200 }),
		);
	});

	it("does not forward the installation token to an unexpected redirect", async () => {
		const gate = acceptingGate();
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "https://example.com/emdash-cms/emdash/archive.tar.gz" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchRepositoryTarball("emdash-cms", "emdash", SHA, coordinatedToken(gate)),
		).rejects.toThrow("repository tarball response had an unsafe redirect location");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports API rate limits through the shared coordinator", async () => {
		const gate = acceptingGate();
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("Too Many Requests", {
				status: 429,
				headers: { "retry-after": "60" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchRepositoryTarball("emdash-cms", "emdash", SHA, coordinatedToken(gate)),
		).rejects.toMatchObject({
			name: "GitHubRateLimitError",
			message: "repository tarball request failed: 429",
			retryDelayMs: 60_000,
		});
		expect(gate.record).toHaveBeenCalledWith(
			"review-rest",
			"review-workflow:attempt-1",
			expect.objectContaining({ status: 429 }),
		);
	});
});

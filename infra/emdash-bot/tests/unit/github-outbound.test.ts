import { describe, expect, test, vi } from "vitest";

import { forwardGithubRequest } from "../../.flue/lib/github-outbound.js";
import type { GitHubRateLimitGate } from "../../.flue/lib/github-rate-limit-client.js";

const OWNER = "emdash-cms";
const REPO = "emdash";
const gitInfoRefs = `https://github.com/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`;

function context(getInstallationToken: () => Promise<string>, rateLimitGate?: GitHubRateLimitGate) {
	return {
		owner: OWNER,
		repo: REPO,
		pushCapabilitySecret: "webhook-secret",
		getInstallationToken,
		...(rateLimitGate ? { rateLimitGate } : {}),
	};
}

describe("GitHub sandbox outbound authentication", () => {
	test("adds the brokered installation token to configured-repository Git reads", async () => {
		const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("git response"));

		const response = await forwardGithubRequest(
			new Request(gitInfoRefs),
			context(async () => "cached-installation-token"),
			upstream,
		);

		expect(response.status).toBe(200);
		expect(upstream).toHaveBeenCalledOnce();
		const forwarded = upstream.mock.calls[0]?.[0];
		expect(forwarded).toBeInstanceOf(Request);
		expect((forwarded as Request).headers.get("authorization")).toBe(
			`Basic ${btoa("x-access-token:cached-installation-token")}`,
		);
	});

	test("fails closed when the installation-token broker is unavailable", async () => {
		const upstream = vi.fn<typeof fetch>();

		const response = await forwardGithubRequest(
			new Request(gitInfoRefs),
			context(async () => Promise.reject(new Error("token mint failed"))),
			upstream,
		);

		expect(response.status).toBe(502);
		await expect(response.text()).resolves.toBe("github authentication unavailable");
		expect(upstream).not.toHaveBeenCalled();
	});

	test("keeps unrelated public GitHub reads anonymous", async () => {
		const getInstallationToken = vi.fn(async () => "unused-token");
		const permit = vi.fn(async () => ({ allowed: true, retryAt: 0 }));
		const record = vi.fn(async () => undefined);
		const rateLimitGate = {
			permit,
			record,
			inspect: vi.fn(async () => null),
			getInstallationToken,
		};
		const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("release"));

		await forwardGithubRequest(
			new Request("https://github.com/another/repo/releases/download/v1/file.tgz"),
			context(getInstallationToken, rateLimitGate),
			upstream,
		);

		expect(getInstallationToken).not.toHaveBeenCalled();
		expect(permit).not.toHaveBeenCalled();
		expect(record).not.toHaveBeenCalled();
		const forwarded = upstream.mock.calls[0]?.[0];
		expect((forwarded as Request).headers.has("authorization")).toBe(false);
	});
});

describe("GitHub sandbox outbound rate limiting", () => {
	function gate(permit: GitHubRateLimitGate["permit"]) {
		return {
			permit: vi.fn(permit),
			record: vi.fn(async () => undefined),
			inspect: vi.fn(async () => null),
			getInstallationToken: vi.fn(async () => "token"),
		};
	}

	test("forwards Git traffic without consuming the REST API budget", async () => {
		const rateLimitGate = gate(async () => ({ allowed: false, retryAt: Date.now() + 60_000 }));
		const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("git response"));

		const response = await forwardGithubRequest(
			new Request(gitInfoRefs),
			context(async () => "token", rateLimitGate),
			upstream,
		);

		expect(response.status).toBe(200);
		expect(upstream).toHaveBeenCalledOnce();
		expect(rateLimitGate.permit).not.toHaveBeenCalled();
		expect(rateLimitGate.record).not.toHaveBeenCalled();
	});

	test("waits out a short API backoff instead of failing the sandbox request", async () => {
		vi.useFakeTimers();
		try {
			const releaseAt = Date.now() + 20_000;
			const rateLimitGate = gate(async () =>
				Date.now() >= releaseAt
					? { allowed: true, retryAt: Date.now() }
					: { allowed: false, retryAt: releaseAt },
			);
			const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));

			const pending = forwardGithubRequest(
				new Request(`https://api.github.com/repos/${OWNER}/${REPO}/issues/1`),
				context(async () => "token", rateLimitGate),
				upstream,
			);
			await vi.advanceTimersByTimeAsync(20_000);
			const response = await pending;

			expect(response.status).toBe(200);
			expect(upstream).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

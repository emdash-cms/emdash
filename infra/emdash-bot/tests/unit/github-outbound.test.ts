import { describe, expect, test, vi } from "vitest";

import { forwardGithubRequest } from "../../.flue/lib/github-outbound.js";

const OWNER = "emdash-cms";
const REPO = "emdash";
const gitInfoRefs = `https://github.com/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`;

function context(getInstallationToken: () => Promise<string>) {
	return {
		owner: OWNER,
		repo: REPO,
		pushCapabilitySecret: "webhook-secret",
		getInstallationToken,
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
		const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("release"));

		await forwardGithubRequest(
			new Request("https://github.com/another/repo/releases/download/v1/file.tgz"),
			context(getInstallationToken),
			upstream,
		);

		expect(getInstallationToken).not.toHaveBeenCalled();
		const forwarded = upstream.mock.calls[0]?.[0];
		expect((forwarded as Request).headers.has("authorization")).toBe(false);
	});
});

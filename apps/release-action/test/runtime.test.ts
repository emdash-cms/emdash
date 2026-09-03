import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DefaultActionRuntime } from "../src/runtime.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("GitHub Action runtime", () => {
	it("requests an audience-bound OIDC token with the runner request token", async () => {
		vi.stubEnv(
			"ACTIONS_ID_TOKEN_REQUEST_URL",
			"https://token.actions.example/id-token?api-version=1",
		);
		vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "runner-request-token");
		const requests: Array<{ headers: Headers; url: URL }> = [];
		const fetchStub: typeof fetch = async (input, init) => {
			requests.push({
				url: new URL(input instanceof Request ? input.url : input.toString()),
				headers: new Headers(init?.headers),
			});
			return Response.json({ value: "header.payload.signature" });
		};
		vi.stubGlobal("fetch", fetchStub);

		const token = await new DefaultActionRuntime().getIDToken("https://release.example.com");

		expect(token).toBe("header.payload.signature");
		expect(requests[0]?.url.searchParams.get("audience")).toBe("https://release.example.com");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer runner-request-token");
	});

	it("writes multiline-safe outputs through the runner output file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "emdash-release-action-"));
		try {
			const outputFile = join(directory, "outputs");
			vi.stubEnv("GITHUB_OUTPUT", outputFile);
			await new DefaultActionRuntime().setOutput("approval-url", "https://example.com/a?x=1&y=2");

			const output = await readFile(outputFile, "utf8");
			expect(output).toMatch(/^approval-url<<emdash_[0-9a-f-]{36}\n/);
			expect(output).toContain("\nhttps://example.com/a?x=1&y=2\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("writes workflow approval links to the GitHub step summary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "emdash-release-action-"));
		try {
			const summaryFile = join(directory, "summary");
			vi.stubEnv("GITHUB_STEP_SUMMARY", summaryFile);
			await new DefaultActionRuntime().writeSummary(
				"## Approve this GitHub workflow\n\n[Open EmDash](https://release.example.com/publisher)",
			);

			await expect(readFile(summaryFile, "utf8")).resolves.toBe(
				"## Approve this GitHub workflow\n\n[Open EmDash](https://release.example.com/publisher)\n",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

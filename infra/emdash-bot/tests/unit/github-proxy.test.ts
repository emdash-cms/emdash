import { describe, expect, test } from "vitest";

import { gateGithubRequest, githubAuthHeader } from "../../.flue/lib/github-proxy.js";

const OWNER = "emdash-cms";
const REPO = "emdash";

function gate(url: string, init?: RequestInit) {
	const request = new Request(url, init);
	return gateGithubRequest(request, new URL(url), OWNER, REPO, 123);
}

describe("githubAuthHeader", () => {
	test("uses Bearer for api.github.com", () => {
		expect(githubAuthHeader("api.github.com", "tok_abc")).toBe("Bearer tok_abc");
	});

	test("uses Basic x-access-token for git hosts", () => {
		expect(githubAuthHeader("github.com", "tok_abc")).toBe(
			`Basic ${btoa("x-access-token:tok_abc")}`,
		);
		expect(githubAuthHeader("codeload.github.com", "tok_abc")).toBe(
			`Basic ${btoa("x-access-token:tok_abc")}`,
		);
		expect(githubAuthHeader("raw.githubusercontent.com", "tok_abc")).toBe(
			`Basic ${btoa("x-access-token:tok_abc")}`,
		);
	});
});

function pktLine(payload: string): string {
	return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

describe("gateGithubRequest", () => {
	test("limits API reads to the configured repository", async () => {
		await expect(
			gate("https://api.github.com/repos/emdash-cms/emdash/issues/1"),
		).resolves.toBeNull();
		await expect(gate("https://api.github.com/repos/other/private/issues/1")).resolves.toMatch(
			/configured repository/,
		);
	});

	test("denies all API writes from the agent", async () => {
		await expect(
			gate("https://api.github.com/repos/emdash-cms/emdash/issues/1", { method: "PATCH" }),
		).resolves.toMatch(/read-only/);
	});

	test("allows pushes only to bot fix branches", async () => {
		const url = "https://github.com/emdash-cms/emdash.git/git-receive-pack";
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/bot/fix-123\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toBeNull();
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/main\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toMatch(/current issue/);
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/bot/fix-456\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toMatch(/current issue/);
	});

	test("rejects an unbounded receive-pack command prefix", async () => {
		const url = "https://github.com/emdash-cms/emdash.git/git-receive-pack";
		const oversizedPrefix = "f".repeat(64 * 1024);

		await expect(gate(url, { method: "POST", body: oversizedPrefix })).resolves.toMatch(
			/current issue/,
		);
	});

	test("stops reading receive-pack after the command flush", async () => {
		const url = "https://github.com/emdash-cms/emdash.git/git-receive-pack";
		let pullCount = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount += 1;
				if (pullCount === 1) {
					controller.enqueue(
						new TextEncoder().encode(
							`${pktLine("old new refs/heads/bot/fix-123\0 report-status\n")}0000`,
						),
					);
					return;
				}
				controller.error(new Error("pack body should not be read"));
			},
		});

		await expect(
			gate(url, { method: "POST", body, duplex: "half" } as RequestInit),
		).resolves.toBeNull();
	});
});

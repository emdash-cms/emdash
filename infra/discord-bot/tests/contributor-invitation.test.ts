import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const testEnv = env as Env;

beforeEach(async () => {
	testEnv.GITHUB_APP_PRIVATE_KEY = await generatedPrivateKeyPem();
});

afterEach(() => {
	testEnv.GITHUB_APP_PRIVATE_KEY = "";
	vi.unstubAllGlobals();
});

describe("contributor invitation", () => {
	test("comments only once across multiple merged PRs by the same unlinked contributor", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
			const url = requestUrl(input);
			if (url.endsWith("/app/installations/120963314/access_tokens")) {
				return Response.json({ token: "test-installation-token" });
			}
			return Response.json({
				html_url: "https://github.com/emdash-cms/emdash/pull/42#issuecomment-1",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const stub = env.CONTRIBUTOR_INVITATIONS.getByName(crypto.randomUUID());
		await runInDurableObject(stub, async (invitation) => {
			const first = await invitation.invite({
				githubId: 123,
				githubLogin: "contributor",
				prNumber: 42,
			});
			const second = await invitation.invite({
				githubId: 123,
				githubLogin: "contributor",
				prNumber: 43,
			});

			expect(first).toEqual({ invited: true });
			expect(second).toMatchObject({
				invited: false,
				record: {
					githubId: 123,
					githubLogin: "contributor",
					prNumber: 42,
					invitedAt: expect.any(String),
				},
			});
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://api.github.com/repos/emdash-cms/emdash/issues/42/comments",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-installation-token",
				}),
			}),
		);
		const requestBody = fetchMock.mock.calls[1]?.[1]?.body;
		if (typeof requestBody !== "string") throw new Error("Expected a JSON request body");
		const body = JSON.parse(requestBody);
		expect(body.body).toContain("https://discord.gg/YY9vBaQRYt");
		expect(body.body).toContain("`/link`");
	});

	test("releases the reservation when GitHub rejects the comment", async () => {
		let commentAttempts = 0;
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
			const url = requestUrl(input);
			if (url.endsWith("/app/installations/120963314/access_tokens")) {
				return Response.json({ token: "test-installation-token" });
			}
			commentAttempts++;
			return commentAttempts === 1
				? new Response(null, { status: 503 })
				: Response.json({ html_url: "https://example.com/comment" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const stub = env.CONTRIBUTOR_INVITATIONS.getByName(crypto.randomUUID());
		await runInDurableObject(stub, async (invitation) => {
			await expect(
				invitation.invite({ githubId: 456, githubLogin: "retry-me", prNumber: 50 }),
			).rejects.toThrow("GitHub comment failed with status 503");
			expect(
				await invitation.invite({ githubId: 456, githubLogin: "retry-me", prNumber: 50 }),
			).toEqual({ invited: true });
		});

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(commentAttempts).toBe(2);
	});
});

async function generatedPrivateKeyPem(): Promise<string> {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	if (!("privateKey" in pair)) throw new Error("Expected an RSA key pair");
	const exported = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	let binary = "";
	for (const byte of exported) binary += String.fromCharCode(byte);
	const body =
		btoa(binary)
			.match(/.{1,64}/g)
			?.join("\n") ?? "";
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

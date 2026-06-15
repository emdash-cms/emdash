import { describe, expect, it } from "vitest";

import { getOAuthEnv } from "../../../src/auth/oauth-env.js";

describe("getOAuthEnv", () => {
	it("returns env from the provided loader", async () => {
		const env = { EMDASH_OAUTH_GITHUB_CLIENT_ID: "abc" };
		await expect(getOAuthEnv(async () => env)).resolves.toBe(env);
	});

	it("falls back to import.meta.env when cloudflare:workers is unavailable", async () => {
		const env = await getOAuthEnv(async () => {
			throw new Error("Cannot find package 'cloudflare:workers' imported from test");
		});

		expect(env).toBe(import.meta.env);
	});

	it("rethrows unexpected loader errors", async () => {
		await expect(
			getOAuthEnv(async () => {
				throw new Error("Unexpected runtime failure");
			}),
		).rejects.toThrow("Unexpected runtime failure");
	});
});

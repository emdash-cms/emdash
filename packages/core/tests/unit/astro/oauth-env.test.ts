import { describe, expect, it, vi } from "vitest";

import { resolveOAuthEnv } from "../../../src/astro/routes/api/auth/oauth/env.js";

describe("resolveOAuthEnv", () => {
	it("returns locals.runtime.env when it exists", async () => {
		const env = { GITHUB_CLIENT_ID: "runtime-id" };
		const loadEnv = vi.fn(async () => ({ GITHUB_CLIENT_ID: "workers-id" }));

		await expect(
			resolveOAuthEnv({ runtime: { env } }, { GITHUB_CLIENT_ID: "fallback-id" }, loadEnv),
		).resolves.toBe(env);
		expect(loadEnv).not.toHaveBeenCalled();
	});

	it("falls back to cloudflare:workers env when runtime locals are absent", async () => {
		const env = { GITHUB_CLIENT_ID: "workers-id" };

		await expect(
			resolveOAuthEnv({}, { GITHUB_CLIENT_ID: "fallback-id" }, async () => env),
		).resolves.toBe(env);
	});

	it("fails closed to import.meta.env when the workers env import is unavailable", async () => {
		const fallbackEnv = { GITHUB_CLIENT_ID: "fallback-id" };

		await expect(
			resolveOAuthEnv({}, fallbackEnv, async () => {
				throw new Error("no cloudflare env");
			}),
		).resolves.toBe(fallbackEnv);
	});
});

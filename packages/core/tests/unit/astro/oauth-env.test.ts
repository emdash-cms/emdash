import { afterEach, describe, expect, it, vi } from "vitest";

async function loadResolver() {
	return import("../../../src/astro/routes/api/auth/oauth/env.js");
}

describe("resolveOAuthEnv", () => {
	afterEach(() => {
		vi.doUnmock("virtual:emdash/env");
		vi.resetModules();
	});

	it("returns the virtual env when it exists", async () => {
		const env = { GITHUB_CLIENT_ID: "virtual-id" };
		vi.doMock("virtual:emdash/env", () => ({ env }), { virtual: true });

		const { resolveOAuthEnv } = await loadResolver();

		await expect(resolveOAuthEnv({ GITHUB_CLIENT_ID: "fallback-id" })).resolves.toBe(env);
	});

	it("falls back to import.meta.env when the virtual env is unavailable", async () => {
		const fallbackEnv = { GITHUB_CLIENT_ID: "fallback-id" };
		const { resolveOAuthEnv } = await loadResolver();

		await expect(resolveOAuthEnv(fallbackEnv)).resolves.toBe(fallbackEnv);
	});
});

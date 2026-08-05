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

	it("falls back safely when locals.runtime.env is a throwing getter", async () => {
		const fallbackEnv = { GITHUB_CLIENT_ID: "fallback-id" };
		const workersEnv = { GITHUB_CLIENT_ID: "workers-id" };
		const locals = {
			get runtime() {
				return {
					get env(): never {
						throw new Error("locals.runtime.env has been removed in Astro 6+");
					},
				};
			},
		};

		await expect(resolveOAuthEnv(locals, fallbackEnv, async () => workersEnv)).resolves.toBe(
			workersEnv,
		);
	});

	it("falls back safely when locals is not an object", async () => {
		const fallbackEnv = { GITHUB_CLIENT_ID: "fallback-id" };
		const workersEnv = { GITHUB_CLIENT_ID: "workers-id" };

		await expect(resolveOAuthEnv(null, fallbackEnv, async () => workersEnv)).resolves.toBe(
			workersEnv,
		);
		await expect(resolveOAuthEnv(undefined, fallbackEnv, async () => workersEnv)).resolves.toBe(
			workersEnv,
		);
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

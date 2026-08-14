import { describe, it, expect, vi, afterEach } from "vitest";

import { GET as startOAuth } from "../../../src/astro/routes/api/auth/oauth/[provider].js";

/**
 * Regression for the Cloudflare case where `locals.runtime.env` is a
 * throwing getter. OAuth routes read the generated virtual env module instead,
 * so this getter must never be touched.
 */
function makeThrowingRuntimeLocals() {
	let runtimeTouched = false;

	return {
		locals: {
			emdash: { db: {} as never, config: {} },
			get runtime() {
				runtimeTouched = true;
				return {
					get env(): never {
						throw new Error(
							"Astro.locals.runtime.env has been removed in Astro v6. Use 'import { env } from \"cloudflare:workers\"' instead.",
						);
					},
				};
			},
		},
		wasRuntimeTouched: () => runtimeTouched,
	};
}

describe("OAuth start route", () => {
	afterEach(() => {
		vi.doUnmock("virtual:emdash/env");
		vi.resetModules();
	});

	it("does not touch a throwing locals.runtime.env getter", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/auth/oauth/google");
		const runtime = makeThrowingRuntimeLocals();

		const response = await startOAuth({
			params: { provider: "google" },
			request,
			locals: runtime.locals,
			redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
		} as unknown as Parameters<typeof startOAuth>[0]);

		// No credentials configured in this test env -- the route should
		// reach the provider-configured check (not crash into the generic
		// oauth_error path the old code hit when locals.runtime.env threw).
		const location = response.headers.get("Location") ?? "";
		expect(location).toContain("error=provider_not_configured");
		expect(location).not.toContain("error=oauth_error");
		expect(runtime.wasRuntimeTouched()).toBe(false);
	});

	it("reads provider credentials from the virtual:emdash/env module on Cloudflare", async () => {
		vi.resetModules();
		vi.doMock(
			"virtual:emdash/env",
			() => ({
				env: {
					EMDASH_OAUTH_GOOGLE_CLIENT_ID: "test-client-id",
					EMDASH_OAUTH_GOOGLE_CLIENT_SECRET: "test-client-secret",
				},
			}),
			{ virtual: true },
		);
		const { GET: startOAuthWithEnv } =
			await import("../../../src/astro/routes/api/auth/oauth/[provider].js");

		const request = new Request("http://localhost:4321/_emdash/api/auth/oauth/google");
		const response = await startOAuthWithEnv({
			params: { provider: "google" },
			request,
			locals: { emdash: { db: {} as never, config: {} } },
			redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
		} as unknown as Parameters<typeof startOAuth>[0]);

		// Credentials found -- the route proceeds past the provider-configured
		// check into building the real authorization URL (which then fails on
		// the unmocked DB, but NOT with provider_not_configured or oauth_error
		// from the env-reading step itself).
		const location = response.headers.get("Location") ?? "";
		expect(location).not.toContain("error=provider_not_configured");

		vi.doUnmock("virtual:emdash/env");
	});
});

import { describe, it, expect } from "vitest";

import { GET as oauthCallback } from "../../../src/astro/routes/api/auth/oauth/[provider]/callback.js";

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

describe("OAuth callback route", () => {
	it("does not touch a throwing locals.runtime.env getter", async () => {
		const request = new Request(
			"http://localhost:4321/_emdash/api/auth/oauth/google/callback?code=abc&state=xyz",
		);
		const runtime = makeThrowingRuntimeLocals();

		const response = await oauthCallback({
			params: { provider: "google" },
			request,
			locals: runtime.locals,
			redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
		} as unknown as Parameters<typeof oauthCallback>[0]);

		// No credentials configured in this test env -- the route should
		// reach the provider-configured check (not crash into the generic
		// oauth_error path the old code hit when locals.runtime.env threw).
		const location = response.headers.get("Location") ?? "";
		expect(location).toContain("error=provider_not_configured");
		expect(location).not.toContain("error=oauth_error");
		expect(runtime.wasRuntimeTouched()).toBe(false);
	});
});

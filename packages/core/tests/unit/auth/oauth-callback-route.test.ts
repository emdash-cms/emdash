import { describe, it, expect } from "vitest";

import { GET as oauthCallback } from "../../../src/astro/routes/api/auth/oauth/[provider]/callback.js";

/**
 * Regression for #1736: the callback route used to read
 * `locals.runtime?.env` for Cloudflare bindings. Astro 6+ makes
 * `locals.runtime.env` a getter that *throws* rather than returning
 * undefined, so `?.` optional-chaining didn't protect the fallback --
 * the throw propagated into the route's outer try/catch and surfaced as
 * a generic "oauth_error", masking `provider_not_configured`. The route
 * no longer touches `locals.runtime` -- it reads through the
 * `virtual:emdash/env` module instead.
 */
function makeThrowingRuntimeLocals() {
	return {
		emdash: { db: {} as never, config: {} },
		get runtime() {
			return {
				get env(): never {
					throw new Error(
						"Astro.locals.runtime.env has been removed in Astro v6. Use 'import { env } from \"cloudflare:workers\"' instead.",
					);
				},
			};
		},
	};
}

describe("OAuth callback route (#1736)", () => {
	it("does not throw when locals.runtime.env is a throwing getter (Astro 6+ Cloudflare)", async () => {
		const request = new Request(
			"http://localhost:4321/_emdash/api/auth/oauth/google/callback?code=abc&state=xyz",
		);

		const response = await oauthCallback({
			params: { provider: "google" },
			request,
			locals: makeThrowingRuntimeLocals(),
			redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
		} as unknown as Parameters<typeof oauthCallback>[0]);

		// No credentials configured in this test env -- the route should
		// reach the provider-configured check (not crash into the generic
		// oauth_error path the old code hit when locals.runtime.env threw).
		const location = response.headers.get("Location") ?? "";
		expect(location).toContain("error=provider_not_configured");
		expect(location).not.toContain("error=oauth_error");
	});
});

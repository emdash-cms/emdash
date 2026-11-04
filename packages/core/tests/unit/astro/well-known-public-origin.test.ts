/**
 * Regression tests for #2016: /.well-known/* OAuth discovery must honor
 * config.siteUrl even on the middleware's anonymous fast path.
 *
 * MCP clients fetch these routes unauthenticated at the site root, which is
 * exactly the path where locals.emdash carries handlers but no `config`.
 * Behind Cloudflare's proxy url.origin is `http://`, so without the
 * build-time-config fallback the discovery document advertises http:// and
 * clients refuse to attach.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("virtual:emdash/config", () => ({ default: { siteUrl: "https://cms.example.com" } }), {
	virtual: true,
});

import { GET as getAuthServer } from "../../../src/astro/routes/api/well-known/oauth-authorization-server.js";
import { GET as getProtectedResource } from "../../../src/astro/routes/api/well-known/oauth-protected-resource.js";

/** Minimal APIContext for these routes: they only read `url` and `locals`. */
function makeContext(locals: Record<string, unknown>) {
	// Internal URL as seen behind Cloudflare's proxy — http, not https.
	const url = new URL("http://cms.example.com/.well-known/oauth-protected-resource");
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- routes only destructure url + locals
	return { url, locals } as unknown as Parameters<typeof getProtectedResource>[0];
}

describe("oauth-protected-resource (#2016)", () => {
	it("reproduces #2016: uses siteUrl when locals.emdash has no config (anonymous fast path)", async () => {
		// The anonymous fast path attaches page helpers but NO `config`.
		const response = await getProtectedResource(makeContext({ emdash: {} }));
		const body = (await response.json()) as { resource: string; authorization_servers: string[] };

		expect(body.resource).toBe("https://cms.example.com/_emdash/api/mcp");
		expect(body.authorization_servers).toEqual(["https://cms.example.com/_emdash"]);
	});

	it("uses siteUrl when locals.emdash is entirely absent (runtime init failed)", async () => {
		const response = await getProtectedResource(makeContext({}));
		const body = (await response.json()) as { resource: string };

		expect(body.resource).toBe("https://cms.example.com/_emdash/api/mcp");
	});

	it("prefers the runtime config from locals when present", async () => {
		const response = await getProtectedResource(
			makeContext({ emdash: { config: { siteUrl: "https://other.example.com" } } }),
		);
		const body = (await response.json()) as { resource: string };

		expect(body.resource).toBe("https://other.example.com/_emdash/api/mcp");
	});
});

describe("oauth-authorization-server (#2016)", () => {
	it("reproduces #2016: uses siteUrl when locals.emdash has no config (anonymous fast path)", async () => {
		const response = await getAuthServer(makeContext({ emdash: {} }));
		const body = (await response.json()) as { issuer: string; authorization_endpoint: string };

		expect(body.issuer).toBe("https://cms.example.com/_emdash");
		expect(body.authorization_endpoint).toBe("https://cms.example.com/_emdash/oauth/authorize");
	});
});

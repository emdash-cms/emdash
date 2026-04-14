/**
 * Tests the OAuth discovery flow using the MCP SDK's own discovery
 * functions. This catches URL construction mismatches between what we
 * serve and what clients actually request -- e.g. RFC 8414 requires
 * path-aware URLs like /.well-known/oauth-authorization-server/_emdash,
 * not /_emdash/.well-known/oauth-authorization-server.
 *
 * Uses a custom fetchFn that routes requests to our route handlers,
 * so no running server is needed.
 */

import {
	discoverOAuthProtectedResourceMetadata,
	discoverAuthorizationServerMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, it, expect } from "vitest";

import { GET as getAuthorizationServer } from "../../../src/astro/routes/api/well-known/oauth-authorization-server.js";
import { GET as getProtectedResource } from "../../../src/astro/routes/api/well-known/oauth-protected-resource.js";

const ORIGIN = "https://example.com";

/**
 * Routes for our virtual server. Maps path patterns to handlers.
 *
 * The MCP SDK constructs URLs based on RFC 8414 and RFC 9728
 * conventions, so the paths here must match what we actually register
 * via injectRoute() in routes.ts.
 */
const ROUTES: Record<string, (ctx: unknown) => Promise<Response>> = {
	"/.well-known/oauth-protected-resource": getProtectedResource as (
		ctx: unknown,
	) => Promise<Response>,
	"/.well-known/oauth-authorization-server/_emdash": getAuthorizationServer as (
		ctx: unknown,
	) => Promise<Response>,
};

/**
 * Custom fetch that dispatches to route handlers instead of making
 * real HTTP requests. Returns 404 for unmatched paths -- exactly what
 * Astro would do for a missing route.
 */
async function mockFetch(input: string | URL | Request, _init?: RequestInit): Promise<Response> {
	const url = new URL(
		typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
	);

	const handler = ROUTES[url.pathname];
	if (!handler) {
		return new Response("Not Found", { status: 404 });
	}

	const ctx = {
		url,
		locals: { emdash: undefined },
	};

	return handler(ctx);
}

describe("MCP SDK OAuth discovery flow", () => {
	it("discovers protected resource metadata from the MCP server URL", async () => {
		const metadata = await discoverOAuthProtectedResourceMetadata(
			`${ORIGIN}/_emdash/api/mcp`,
			{},
			mockFetch,
		);

		expect(metadata.resource).toBe(`${ORIGIN}/_emdash/api/mcp`);
		expect(metadata.authorization_servers).toContain(`${ORIGIN}/_emdash`);
	});

	it("discovers authorization server metadata from the issuer URL", async () => {
		// Step 1: discover protected resource to get authorization_servers
		const resourceMeta = await discoverOAuthProtectedResourceMetadata(
			`${ORIGIN}/_emdash/api/mcp`,
			{},
			mockFetch,
		);

		const authServerUrl = resourceMeta.authorization_servers![0]!;
		expect(authServerUrl).toBe(`${ORIGIN}/_emdash`);

		// Step 2: discover authorization server metadata
		const metadata = await discoverAuthorizationServerMetadata(authServerUrl, {
			fetchFn: mockFetch,
		});

		expect(metadata).toBeDefined();
		expect(metadata!.issuer).toBe(`${ORIGIN}/_emdash`);
		expect(metadata!.authorization_endpoint).toBe(`${ORIGIN}/_emdash/oauth/authorize`);
		expect(metadata!.token_endpoint).toBe(`${ORIGIN}/_emdash/api/oauth/token`);
	});

	it("completes the full discovery chain: MCP URL -> resource -> auth server", async () => {
		const mcpUrl = `${ORIGIN}/_emdash/api/mcp`;

		// This is the exact flow the MCP SDK's auth() function performs:
		// 1. POST to MCP endpoint, get 401
		// 2. Discover protected resource metadata
		// 3. Extract authorization_servers[0]
		// 4. Discover authorization server metadata
		// 5. Use the discovered endpoints for OAuth

		const resourceMeta = await discoverOAuthProtectedResourceMetadata(mcpUrl, {}, mockFetch);
		const authServerUrl = resourceMeta.authorization_servers![0]!;
		const authMeta = await discoverAuthorizationServerMetadata(authServerUrl, {
			fetchFn: mockFetch,
		});

		// Verify the full chain produced usable endpoints
		expect(authMeta).toBeDefined();
		expect(authMeta!.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
		expect(authMeta!.token_endpoint).toMatch(/\/oauth\/token$/);
		expect(authMeta!.code_challenge_methods_supported).toContain("S256");
		expect(authMeta!.response_types_supported).toContain("code");
		expect(authMeta!.grant_types_supported).toContain("authorization_code");
	});
});

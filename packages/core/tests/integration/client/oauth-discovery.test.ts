/**
 * Integration test for MCP OAuth discovery against a real Astro dev server.
 *
 * Uses the MCP SDK's own discovery functions with real fetch() so we test
 * the actual Astro route registration, not just the handler logic. This
 * catches mismatches between the paths we register in routes.ts and the
 * paths the SDK constructs per RFC 8414 / RFC 9728.
 */

import {
	discoverOAuthProtectedResourceMetadata,
	discoverAuthorizationServerMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

const PORT = 4401;

describe("MCP OAuth Discovery (real server)", () => {
	let ctx: TestServerContext;

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: PORT });
	});

	afterAll(async () => {
		await ctx?.cleanup();
	});

	it("discovers protected resource metadata from the MCP server URL", async () => {
		const metadata = await discoverOAuthProtectedResourceMetadata(`${ctx.baseUrl}/_emdash/api/mcp`);

		expect(metadata.resource).toBe(`${ctx.baseUrl}/_emdash/api/mcp`);
		expect(metadata.authorization_servers).toContain(`${ctx.baseUrl}/_emdash`);
		expect(metadata.scopes_supported).toContain("content:read");
		expect(metadata.bearer_methods_supported).toContain("header");
	});

	it("discovers authorization server metadata via the RFC 8414 path", async () => {
		// Step 1: get the authorization server URL from protected resource metadata
		const resourceMeta = await discoverOAuthProtectedResourceMetadata(
			`${ctx.baseUrl}/_emdash/api/mcp`,
		);
		const authServerUrl = resourceMeta.authorization_servers![0]!;

		// Step 2: the SDK constructs /.well-known/oauth-authorization-server/_emdash
		// per RFC 8414 (path component appended after well-known prefix).
		// This must resolve to a real route, not 404.
		const metadata = await discoverAuthorizationServerMetadata(authServerUrl);

		expect(metadata).toBeDefined();
		expect(metadata!.issuer).toBe(`${ctx.baseUrl}/_emdash`);
		expect(metadata!.authorization_endpoint).toBe(`${ctx.baseUrl}/_emdash/oauth/authorize`);
		expect(metadata!.token_endpoint).toBe(`${ctx.baseUrl}/_emdash/api/oauth/token`);
		expect(metadata!.code_challenge_methods_supported).toContain("S256");
		expect(metadata!.response_types_supported).toContain("code");
		expect(metadata!.grant_types_supported).toContain("authorization_code");
	});

	it("MCP endpoint returns 401 with resource_metadata in WWW-Authenticate", async () => {
		// Unauthenticated POST to MCP should return 401 with the discovery hint
		const res = await fetch(`${ctx.baseUrl}/_emdash/api/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0" },
				},
				id: 1,
			}),
		});

		expect(res.status).toBe(401);
		const wwwAuth = res.headers.get("WWW-Authenticate");
		expect(wwwAuth).toContain("resource_metadata=");
		expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
	});
});

/**
 * Unit tests for OAuth discovery endpoint response shapes.
 *
 * These endpoints are public, unauthenticated, and return JSON metadata
 * that MCP clients use to discover OAuth endpoints. The response shapes
 * are contractual — changing them breaks MCP client compatibility.
 */

import { describe, it, expect } from "vitest";

import { GET as getAuthorizationServer } from "../../../src/astro/routes/api/well-known/oauth-authorization-server.js";
// We import the GET handlers directly — they're plain functions that take
// an Astro-like context and return a Response.
import { GET as getProtectedResource } from "../../../src/astro/routes/api/well-known/oauth-protected-resource.js";
import { VALID_SCOPES } from "../../../src/auth/api-tokens.js";

/** Minimal mock of what the route handlers actually use from the Astro context. */
function mockContext(origin = "https://example.com") {
	return {
		url: new URL("/.well-known/test", origin),
		locals: { emdash: undefined },
	} as unknown as Parameters<typeof getProtectedResource>[0];
}

describe("Protected Resource Metadata (RFC 9728)", () => {
	it("returns correct resource and authorization_servers", async () => {
		const response = await getProtectedResource(mockContext());
		expect(response.status).toBe(200);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.resource).toBe("https://example.com/_emdash/api/mcp");
		expect(body.authorization_servers).toEqual(["https://example.com/_emdash"]);
	});

	it("includes all valid scopes", async () => {
		const response = await getProtectedResource(mockContext());
		const body = (await response.json()) as { scopes_supported: string[] };
		expect(body.scopes_supported).toEqual([...VALID_SCOPES]);
	});

	it("advertises header-based bearer method", async () => {
		const response = await getProtectedResource(mockContext());
		const body = (await response.json()) as { bearer_methods_supported: string[] };
		expect(body.bearer_methods_supported).toEqual(["header"]);
	});

	it("sets CORS and cache headers", async () => {
		const response = await getProtectedResource(mockContext());
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Cache-Control")).toContain("public");
	});

	it("uses the request origin for URLs", async () => {
		const response = await getProtectedResource(mockContext("https://cms.mysite.com"));
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.resource).toBe("https://cms.mysite.com/_emdash/api/mcp");
		expect(body.authorization_servers).toEqual(["https://cms.mysite.com/_emdash"]);
	});
});

describe("Authorization Server Metadata (RFC 8414)", () => {
	it("returns correct issuer and endpoints", async () => {
		const response = await getAuthorizationServer(mockContext());
		expect(response.status).toBe(200);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.issuer).toBe("https://example.com/_emdash");
		expect(body.authorization_endpoint).toBe("https://example.com/_emdash/oauth/authorize");
		expect(body.token_endpoint).toBe("https://example.com/_emdash/api/oauth/token");
		expect(body.device_authorization_endpoint).toBe(
			"https://example.com/_emdash/api/oauth/device/code",
		);
	});

	it("supports authorization_code, refresh_token, and device_code grants", async () => {
		const response = await getAuthorizationServer(mockContext());
		const body = (await response.json()) as { grant_types_supported: string[] };
		expect(body.grant_types_supported).toContain("authorization_code");
		expect(body.grant_types_supported).toContain("refresh_token");
		expect(body.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:device_code");
	});

	it("requires S256 code challenge method only", async () => {
		const response = await getAuthorizationServer(mockContext());
		const body = (await response.json()) as { code_challenge_methods_supported: string[] };
		expect(body.code_challenge_methods_supported).toEqual(["S256"]);
	});

	it("only supports code response type", async () => {
		const response = await getAuthorizationServer(mockContext());
		const body = (await response.json()) as { response_types_supported: string[] };
		expect(body.response_types_supported).toEqual(["code"]);
	});

	it("supports public clients (no auth method)", async () => {
		const response = await getAuthorizationServer(mockContext());
		const body = (await response.json()) as { token_endpoint_auth_methods_supported: string[] };
		expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
	});

	it("includes all valid scopes", async () => {
		const response = await getAuthorizationServer(mockContext());
		const body = (await response.json()) as { scopes_supported: string[] };
		expect(body.scopes_supported).toEqual([...VALID_SCOPES]);
	});

	it("sets CORS and cache headers", async () => {
		const response = await getAuthorizationServer(mockContext());
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Cache-Control")).toContain("public");
	});

	it("supports client_id_metadata_document", async () => {
		const response = await getAuthorizationServer(mockContext());
		const body = (await response.json()) as { client_id_metadata_document_supported: boolean };
		expect(body.client_id_metadata_document_supported).toBe(true);
	});
});

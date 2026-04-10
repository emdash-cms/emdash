import { describe, it, expect, beforeEach, vi } from "vitest";

const LOCALHOST_RE = /^http:\/\/localhost/;

// Reset the module singleton between tests by re-importing fresh copies
async function freshImport() {
	// Clear the module cache so the singleton resets
	vi.resetModules();
	return import("../src/oauth-client.js");
}

describe("getAtprotoOAuthClient (HTTPS - public client)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("returns an OAuthClient instance", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("https://example.com");
		expect(client).toBeDefined();
		expect(client.metadata).toBeDefined();
	});

	it("sets client_id to the well-known metadata URL", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("https://example.com");
		expect(client.metadata.client_id).toBe(
			"https://example.com/.well-known/atproto-client-metadata.json",
		);
	});

	it("sets redirect_uri to the callback endpoint", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("https://example.com");
		expect(client.metadata.redirect_uris).toEqual([
			"https://example.com/_emdash/api/auth/atproto/callback",
		]);
	});

	it("does not set jwks_uri (public client)", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("https://example.com");
		expect(client.metadata.jwks_uri).toBeUndefined();
	});

	it("requests atproto scope", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("https://example.com");
		expect(client.metadata.scope).toBe("atproto transition:generic");
	});

	it("returns the same instance for the same baseUrl (singleton)", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client1 = await getAtprotoOAuthClient("https://example.com");
		const client2 = await getAtprotoOAuthClient("https://example.com");
		expect(client1).toBe(client2);
	});

	it("creates a new instance when baseUrl changes", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client1 = await getAtprotoOAuthClient("https://example.com");
		const client2 = await getAtprotoOAuthClient("https://other.com");
		expect(client1).not.toBe(client2);
		expect(client2.metadata.client_id).toContain("other.com");
	});
});

describe("getAtprotoOAuthClient (localhost - loopback public client)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("creates a loopback client for http://localhost", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("http://localhost:4321");
		expect(client).toBeDefined();
		expect(client.metadata).toBeDefined();
	});

	it("uses http://localhost client_id (loopback format)", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("http://localhost:4321");
		// Loopback clients have client_id starting with http://localhost
		expect(client.metadata.client_id).toMatch(LOCALHOST_RE);
	});

	it("does not set jwks_uri for loopback clients", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("http://localhost:4321");
		expect(client.metadata.jwks_uri).toBeUndefined();
	});

	it("also treats 127.0.0.1 as loopback", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client = await getAtprotoOAuthClient("http://127.0.0.1:4321");
		expect(client.metadata.client_id).toMatch(LOCALHOST_RE);
	});
});

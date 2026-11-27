import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { resolveAtprotoProfile } from "../src/oauth-client.js";

const LOCALHOST_RE = /^http:\/\/localhost/;

// Reset the module singleton between tests by re-importing fresh copies
async function freshImport() {
	// Clear the module cache so the singleton resets
	vi.resetModules();
	return import("../src/oauth-client.js");
}

const routes = new Map<string, () => Response>();

function servePlc(did: string, handle: string) {
	routes.set(`https://plc.directory/${encodeURIComponent(did)}`, () =>
		Response.json({
			id: did,
			alsoKnownAs: [`at://${handle}`],
			service: [
				{
					id: "#atproto_pds",
					type: "AtprotoPersonalDataServer",
					serviceEndpoint: "https://pds.example.com",
				},
			],
		}),
	);
}

function serveDns(handle: string, did: string) {
	const name = `_atproto.${handle}`;
	routes.set(`https://cloudflare-dns.com/dns-query?name=${name}&type=TXT`, () =>
		Response.json({
			Status: 0,
			TC: false,
			RD: true,
			RA: true,
			AD: false,
			CD: false,
			Question: [{ name, type: 16 }],
			Answer: [{ name, type: 16, TTL: 300, data: `"did=${did}"` }],
		}),
	);
}

function serveProfile(did: string, displayName: string) {
	routes.set(
		`https://pds.example.com/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.bsky.actor.profile&rkey=self`,
		() => Response.json({ value: { displayName } }),
	);
}

describe("resolveAtprotoProfile", () => {
	const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" as const;
	const handle = "alice.example.com";

	beforeEach(() => {
		routes.clear();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const route = routes.get(input instanceof Request ? input.url : input.toString());
			if (!route) throw new TypeError("fetch failed");
			return route();
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the verified handle and display name without using the session", async () => {
		servePlc(did, handle);
		serveDns(handle, did);
		serveProfile(did, "Alice");
		const session = { did, handle: vi.fn() };

		await expect(resolveAtprotoProfile(session)).resolves.toEqual({
			handle,
			displayName: "Alice",
		});
		expect(session.handle).not.toHaveBeenCalled();
	});

	it("falls back to the DID when the document's handle resolves to another DID", async () => {
		servePlc(did, handle);
		serveDns(handle, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
		serveProfile(did, "Alice");

		await expect(resolveAtprotoProfile({ did })).resolves.toEqual({
			handle: did,
			displayName: "Alice",
		});
	});

	it("returns a null display name when the account has no profile record", async () => {
		servePlc(did, handle);
		serveDns(handle, did);

		await expect(resolveAtprotoProfile({ did })).resolves.toEqual({
			handle,
			displayName: null,
		});
	});

	it("falls back to the DID when the DID document cannot be resolved", async () => {
		serveProfile(did, "Alice");

		await expect(resolveAtprotoProfile({ did })).resolves.toEqual({
			handle: did,
			displayName: null,
		});
	});
});

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
		expect(client.metadata.scope).toBe("atproto");
	});

	it("creates a fresh instance per call (no shared state between requests)", async () => {
		const { getAtprotoOAuthClient } = await freshImport();
		const client1 = await getAtprotoOAuthClient("https://example.com");
		const client2 = await getAtprotoOAuthClient("https://example.com");
		expect(client1).not.toBe(client2);
	});

	it("creates distinct instances for different baseUrls", async () => {
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

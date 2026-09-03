import { describe, expect, it } from "vitest";

import { createCliOAuthClient, missingBlobScopes, REGISTRY_BLOB_SCOPES } from "../src/oauth.js";

describe("registry blob OAuth scopes", () => {
	it("requests package and image blob permissions by default", () => {
		const client = createCliOAuthClient({ redirectUri: "http://127.0.0.1:12345/callback" });
		const scopes = new Set(client.metadata.scope?.split(" "));

		expect(scopes).toContain("blob:application/gzip");
		expect(scopes).toContain("blob:image/*");
	});

	it("reports only missing permissions from a stored grant", () => {
		expect(missingBlobScopes("atproto blob:image/*", REGISTRY_BLOB_SCOPES)).toEqual([
			"blob:application/gzip",
		]);
		expect(
			missingBlobScopes("atproto blob:application/gzip blob:image/*", REGISTRY_BLOB_SCOPES),
		).toEqual([]);
	});

	it("accepts the legacy generic transition grant for blob uploads", () => {
		expect(missingBlobScopes("atproto transition:generic", REGISTRY_BLOB_SCOPES)).toEqual([]);
	});
});

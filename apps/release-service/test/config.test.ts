import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfiguration } from "../src/config.js";
import { getClientMetadata, getPublicJwks } from "../src/oauth/metadata.js";
import { ASSERTION_KEY_1, ASSERTION_KEY_2, TEST_BINDINGS } from "./fixtures/oauth.js";

describe("release-service OAuth configuration", () => {
	it("derives exact delegated-release metadata and public overlapping JWKS", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const metadata = getClientMetadata(configuration.oauth);

		expect(metadata).toEqual({
			client_id: "https://release.example.com/.well-known/atproto-client-metadata.json",
			client_name: "EmDash delegated release service",
			client_uri: "https://release.example.com",
			application_type: "web",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			redirect_uris: ["https://release.example.com/oauth/callback"],
			scope:
				"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
			jwks_uri: "https://release.example.com/oauth/jwks.json",
			dpop_bound_access_tokens: true,
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_signing_alg: "ES256",
		});
		expect(getPublicJwks(configuration.oauth).keys.map((key) => key.kid)).toEqual([
			ASSERTION_KEY_2.kid,
			ASSERTION_KEY_1.kid,
		]);
		expect(JSON.stringify(getPublicJwks(configuration.oauth))).not.toContain('"d"');
		expect(configuration.access).toEqual({
			teamDomain: TEST_BINDINGS.ACCESS_TEAM_DOMAIN,
			audiences: {
				viewer: TEST_BINDINGS.ACCESS_VIEWER_AUD,
				reviewer: TEST_BINDINGS.ACCESS_REVIEWER_AUD,
				admin: TEST_BINDINGS.ACCESS_ADMIN_AUD,
			},
		});
	});

	it("accepts a custom Access issuer hostname", async () => {
		const configuration = await loadConfiguration({
			...TEST_BINDINGS,
			ACCESS_TEAM_DOMAIN: "https://access.example.com",
		});

		expect(configuration.access.teamDomain).toBe("https://access.example.com");
	});

	it("accepts multiple Access applications for one operator role", async () => {
		const secondAdminAudience = "d".repeat(64);
		const configuration = await loadConfiguration({
			...TEST_BINDINGS,
			ACCESS_ADMIN_AUD: JSON.stringify([TEST_BINDINGS.ACCESS_ADMIN_AUD, secondAdminAudience]),
		});

		expect(configuration.access.audiences.admin).toEqual([
			TEST_BINDINGS.ACCESS_ADMIN_AUD,
			secondAdminAudience,
		]);
	});

	it.each([
		["empty origin", { ...TEST_BINDINGS, PUBLIC_ORIGIN: "" }],
		["empty deployment ID", { ...TEST_BINDINGS, DEPLOYMENT_ID: "" }],
		["HTTP origin", { ...TEST_BINDINGS, PUBLIC_ORIGIN: "http://release.example.com" }],
		["origin path", { ...TEST_BINDINGS, PUBLIC_ORIGIN: "https://release.example.com/path" }],
		[
			"redirect mismatch",
			{ ...TEST_BINDINGS, OAUTH_REDIRECT_URIS: '["https://other.example/callback"]' },
		],
		["empty redirects", { ...TEST_BINDINGS, OAUTH_REDIRECT_URIS: "[]" }],
		["malformed keyset", { ...TEST_BINDINGS, OAUTH_ASSERTION_KEYSET: "not-json" }],
		["malformed encryption keyring", { ...TEST_BINDINGS, ENCRYPTION_KEYRING: "not-json" }],
		[
			"Access team domain with a port",
			{ ...TEST_BINDINGS, ACCESS_TEAM_DOMAIN: "https://emdash-test.cloudflareaccess.com:8443" },
		],
		["malformed Access audience", { ...TEST_BINDINGS, ACCESS_ADMIN_AUD: "not-an-aud" }],
		["empty Access audience list", { ...TEST_BINDINGS, ACCESS_ADMIN_AUD: "[]" }],
		[
			"duplicate Access audience list",
			{
				...TEST_BINDINGS,
				ACCESS_ADMIN_AUD: JSON.stringify([
					TEST_BINDINGS.ACCESS_ADMIN_AUD,
					TEST_BINDINGS.ACCESS_ADMIN_AUD,
				]),
			},
		],
		[
			"oversized Access audience list",
			{
				...TEST_BINDINGS,
				ACCESS_ADMIN_AUD: JSON.stringify(
					Array.from({ length: 9 }, (_value, index) => index.toString(16).repeat(64)),
				),
			},
		],
		[
			"duplicate Access audiences",
			{ ...TEST_BINDINGS, ACCESS_ADMIN_AUD: TEST_BINDINGS.ACCESS_REVIEWER_AUD },
		],
		[
			"missing active key",
			{
				...TEST_BINDINGS,
				OAUTH_ASSERTION_KEYSET: JSON.stringify({
					active: "missing",
					keys: [ASSERTION_KEY_1],
				}),
			},
		],
		[
			"wrong key algorithm",
			{
				...TEST_BINDINGS,
				OAUTH_ASSERTION_KEYSET: JSON.stringify({
					active: ASSERTION_KEY_1.kid,
					keys: [{ ...ASSERTION_KEY_1, alg: "ES384" }],
				}),
			},
		],
	])("fails closed for %s", async (_name, bindings) => {
		await expect(loadConfiguration(bindings)).rejects.toBeInstanceOf(ConfigurationError);
	});

	it("caches parsed encryption and invalidates it when the keyring changes", async () => {
		const bindings = { ...TEST_BINDINGS };
		const first = await loadConfiguration(bindings);
		expect(first).toMatchObject({
			deploymentId: TEST_BINDINGS.DEPLOYMENT_ID,
		});
		const second = await loadConfiguration(bindings);
		expect(second.encryption).toBe(first.encryption);

		bindings.ENCRYPTION_KEYRING = "not-json";
		await expect(loadConfiguration(bindings)).rejects.toMatchObject({
			issues: ["ENCRYPTION_KEYRING_INVALID"],
		});
	});

	it("resolves assertion and encryption values from Secrets Store bindings", async () => {
		let reads = 0;
		const configuration = await loadConfiguration({
			...TEST_BINDINGS,
			OAUTH_ASSERTION_KEYSET: {
				async get() {
					reads += 1;
					return TEST_BINDINGS.OAUTH_ASSERTION_KEYSET;
				},
			},
			ENCRYPTION_KEYRING: {
				async get() {
					reads += 1;
					return TEST_BINDINGS.ENCRYPTION_KEYRING;
				},
			},
		});

		expect(configuration.oauth.activeAssertionKeyId).toBe(ASSERTION_KEY_2.kid);
		expect(configuration.encryption.currentKeyVersion).toBe(1);
		expect(reads).toBe(2);
	});

	it("fails closed when Secrets Store retrieval fails without exposing the cause", async () => {
		const sensitive = "secret store returned sensitive provider detail";
		try {
			await loadConfiguration({
				...TEST_BINDINGS,
				ENCRYPTION_KEYRING: {
					async get() {
						throw new Error(sensitive);
					},
				},
			});
			expect.fail("expected configuration failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError);
			expect(error).toMatchObject({ issues: ["SECRET_STORE_UNAVAILABLE"] });
			expect(JSON.stringify(error)).not.toContain(sensitive);
		}
	});
});

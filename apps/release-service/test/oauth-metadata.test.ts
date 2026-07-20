import { getDelegatedReleasePermission } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfiguration } from "../src/config.js";
import { getClientMetadata, getPublicJwks } from "../src/oauth/metadata.js";
import { ASSERTION_KEY_1, ASSERTION_KEY_2, TEST_BINDINGS } from "./fixtures/oauth.js";

describe("confidential OAuth metadata", () => {
	it("shares validated configuration work for the same bindings object", async () => {
		const [first, second] = await Promise.all([
			loadConfiguration(TEST_BINDINGS),
			loadConfiguration(TEST_BINDINGS),
		]);
		expect(first).toBe(second);
	});

	it("derives stable metadata and the exact create-only release scope", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const metadata = getClientMetadata(configuration.oauth);
		const permission = getDelegatedReleasePermission();

		expect(metadata).toEqual({
			client_id: "https://release.example.invalid/.well-known/atproto-client-metadata.json",
			client_name: "EmDash delegated release service",
			client_uri: "https://release.example.invalid",
			application_type: "web",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			redirect_uris: ["https://release.example.invalid/oauth/callback"],
			scope: `atproto repo:${permission.collection}?action=create`,
			jwks_uri: "https://release.example.invalid/oauth/jwks.json",
			dpop_bound_access_tokens: true,
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_signing_alg: "ES256",
		});
		expect(configuration.oauth.releaseNsid).toBe(permission.collection);
	});

	it("publishes overlapping public assertion keys with the active key first", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const jwks = getPublicJwks(configuration.oauth);

		expect(jwks.keys.map((key) => key.kid)).toEqual(["assertion-2026-02", "assertion-2026-01"]);
		expect(JSON.stringify(jwks)).not.toContain('"d"');
		expect(configuration.oauth.assertionKeys[0]).not.toEqual(
			expect.objectContaining({ kid: "dpop" }),
		);
	});

	it.each([
		["origin path", { ...TEST_BINDINGS, PUBLIC_ORIGIN: "https://release.example.invalid/path" }],
		[
			"redirect origin",
			{ ...TEST_BINDINGS, OAUTH_REDIRECT_URIS: '["https://other.example/oauth/callback"]' },
		],
		[
			"redirect path",
			{ ...TEST_BINDINGS, OAUTH_REDIRECT_URIS: '["https://release.example.invalid/callback"]' },
		],
		["empty redirects", { ...TEST_BINDINGS, OAUTH_REDIRECT_URIS: "[]" }],
		["malformed keyset", { ...TEST_BINDINGS, OAUTH_ASSERTION_KEYSET: "not-json" }],
		[
			"oversized encoded keyset",
			{ ...TEST_BINDINGS, OAUTH_ASSERTION_KEYSET: " ".repeat(64 * 1024 + 1) },
		],
		[
			"too many assertion keys",
			{
				...TEST_BINDINGS,
				OAUTH_ASSERTION_KEYSET: JSON.stringify({
					active: "assertion-0",
					keys: Array.from({ length: 9 }, (_, index) => ({
						...ASSERTION_KEY_1,
						kid: `assertion-${index}`,
					})),
				}),
			},
		],
		[
			"missing active key",
			{
				...TEST_BINDINGS,
				OAUTH_ASSERTION_KEYSET: JSON.stringify({ active: "missing", keys: [ASSERTION_KEY_1] }),
			},
		],
		[
			"public-only configured key",
			{
				...TEST_BINDINGS,
				OAUTH_ASSERTION_KEYSET: JSON.stringify({
					active: ASSERTION_KEY_1.kid,
					keys: [{ ...ASSERTION_KEY_1, d: undefined }],
				}),
			},
		],
		[
			"wrong algorithm",
			{
				...TEST_BINDINGS,
				OAUTH_ASSERTION_KEYSET: JSON.stringify({
					active: ASSERTION_KEY_1.kid,
					keys: [{ ...ASSERTION_KEY_1, alg: "ES384" }],
				}),
			},
		],
		[
			"mismatched assertion public and private key material",
			{
				...TEST_BINDINGS,
				OAUTH_ASSERTION_KEYSET: JSON.stringify({
					active: ASSERTION_KEY_1.kid,
					keys: [{ ...ASSERTION_KEY_1, x: ASSERTION_KEY_2.x, y: ASSERTION_KEY_2.y }],
				}),
			},
		],
	])("fails closed for invalid %s configuration", async (_name, bindings) => {
		await expect(loadConfiguration(bindings)).rejects.toBeInstanceOf(ConfigurationError);
	});
});

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { TEST_ASSERTION_KEYSET } from "./test/fixtures/oauth.js";

process.env["OAUTH_ASSERTION_KEYSET"] ??= TEST_ASSERTION_KEYSET;
process.env["ENCRYPTION_KEYRING"] ??=
	'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					PUBLIC_ORIGIN: "https://release.example.invalid",
					DEPLOYMENT_ID: "test-release-service",
					OAUTH_REDIRECT_URIS: '["https://release.example.invalid/oauth/callback"]',
					OAUTH_ASSERTION_KEYSET: TEST_ASSERTION_KEYSET,
					ENCRYPTION_KEYRING:
						'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}',
				},
			},
		}),
	],
});

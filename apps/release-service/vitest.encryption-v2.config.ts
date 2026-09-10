import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { TEST_ACCESS_AUDIENCES, TEST_ASSERTION_KEYSET } from "./test/fixtures/oauth.js";

const KEYRING_V2 =
	'{"current":2,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},{"version":2,"key":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"}]}';

process.env["OAUTH_ASSERTION_KEYSET"] = TEST_ASSERTION_KEYSET;
process.env["ENCRYPTION_KEYRING"] = KEYRING_V2;

export default defineConfig({
	test: {
		include: ["test/encryption-verification-workflow.v2.ts"],
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				workers: [
					{
						name: "emdash-release-verifier",
						modules: true,
						script: `
							import { WorkerEntrypoint } from "cloudflare:workers";
							export default class ReleaseVerifier extends WorkerEntrypoint {}
						`,
					},
				],
				bindings: {
					PUBLIC_ORIGIN: "https://release.example.com",
					DEPLOYMENT_ID: "test-release-service",
					ACCESS_TEAM_DOMAIN: "https://emdash-test.cloudflareaccess.com",
					ACCESS_VIEWER_AUD: TEST_ACCESS_AUDIENCES.viewer,
					ACCESS_REVIEWER_AUD: TEST_ACCESS_AUDIENCES.reviewer,
					ACCESS_ADMIN_AUD: TEST_ACCESS_AUDIENCES.admin,
					OAUTH_REDIRECT_URIS: '["https://release.example.com/oauth/callback"]',
					OAUTH_ASSERTION_KEYSET: TEST_ASSERTION_KEYSET,
					ENCRYPTION_KEYRING: KEYRING_V2,
				},
			},
		}),
	],
});

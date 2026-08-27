import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

import { TEST_ACCESS_AUDIENCES, TEST_ASSERTION_KEYSET } from "./test/fixtures/oauth.js";

process.env["OAUTH_ASSERTION_KEYSET"] ??= TEST_ASSERTION_KEYSET;
process.env["ENCRYPTION_KEYRING"] ??=
	'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}';

export default defineConfig({
	test: { exclude: [...configDefaults.exclude, "src/ui/**/*.test.{ts,tsx}"] },
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
							export default class ReleaseVerifier extends WorkerEntrypoint {
								async verifyRelease(input) {
									return {
										success: true,
										value: {
											artifact: {
												requestedUrl: input.artifact.url,
												resolvedUrl: input.artifact.url,
												checksum: input.artifact.checksum,
												compressedBytes: 1024,
												manifest: {
													id: input.artifact.packageSlug,
													version: input.artifact.version,
													declaredAccess: {},
												},
												bundle: { backendBytes: 100, adminBytes: null },
											},
											provenance: {
												requestedUrl: input.provenance.url,
												resolvedUrl: input.provenance.url,
												checksum: input.provenance.checksum,
												documentBytes: 512,
												predicateType: input.provenance.predicateType,
												sourceRepository: input.provenance.sourceRepository,
												builderId: input.provenance.builderId,
											},
										},
									};
								}
							}
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
					ENCRYPTION_KEYRING:
						'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}',
				},
			},
		}),
	],
});

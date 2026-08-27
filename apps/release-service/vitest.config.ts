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
												url: input.artifact.url,
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
												url: input.provenance.url,
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

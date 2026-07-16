import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));
const migrations = await readD1Migrations(migrationsPath);

function jsonView(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

export default defineConfig({
	// The console (console/vitest.config.ts) and calibration
	// (calibration/unit.vitest.config.ts) run their own suites separately --
	// neither belongs in the workerd pool this config sets up.
	test: {
		exclude: [...configDefaults.exclude, "console/**", "calibration/**"],
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					LABEL_SIGNING_PRIVATE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
					NOTIFICATION_HASH_PEPPER: "test-notification-hash-pepper",
				},
				// wrangler.jsonc declares an AGGREGATOR service binding to the
				// aggregator Worker, which doesn't exist in the test runtime.
				// Stub it so miniflare can start; most tests inject their own mock
				// Fetcher rather than using this binding.
				//
				// The stub serves realistic getPackage/getPublisher views so a
				// consumer (the contact resolver) can be exercised end-to-end
				// through the real binding: the package view carries only url-only
				// contacts (tiers 1-2 miss) and the publisher view carries a
				// security-kind email (tier 3 hits), so one resolution walks the
				// full tier chain across the binding hop. Any other path still fails
				// loud (501) and echoes the inbound atproto-accept-labelers header
				// as a marker, so a binding-transport test can prove the client's
				// blank value survives the hop (a dropped empty header reads
				// `absent`, not `empty`).
				serviceBindings: {
					AGGREGATOR: (request) => {
						const path = new URL(request.url).pathname;
						if (path.endsWith("/com.emdashcms.experimental.aggregator.getPackage")) {
							return jsonView({
								uri: "at://did:plc:stubpublisher/com.emdashcms.experimental.package.profile/stub-plugin",
								cid: "bafyreistubpackagecidvalue",
								did: "did:plc:stubpublisher",
								slug: "stub-plugin",
								indexedAt: "2026-07-01T00:00:00.000Z",
								labels: [],
								profile: {
									$type: "com.emdashcms.experimental.package.profile",
									id: "at://did:plc:stubpublisher/com.emdashcms.experimental.package.profile/stub-plugin",
									type: "emdash-plugin",
									license: "MIT",
									security: [{ url: "https://stub.example/security" }],
									authors: [{ name: "Stub Author", url: "https://stub.example/author" }],
									slug: "stub-plugin",
								},
							});
						}
						if (path.endsWith("/com.emdashcms.experimental.aggregator.getPublisher")) {
							return jsonView({
								uri: "at://did:plc:stubpublisher/com.emdashcms.experimental.publisher.profile/self",
								cid: "bafyreistubpublishercidvalue",
								did: "did:plc:stubpublisher",
								indexedAt: "2026-07-01T00:00:00.000Z",
								labels: [],
								profile: {
									$type: "com.emdashcms.experimental.publisher.profile",
									displayName: "Stub Publisher",
									contact: [
										{ kind: "general", url: "https://stub.example/contact" },
										{ kind: "security", email: "security@stub.example" },
									],
								},
							});
						}
						const raw = request.headers.get("atproto-accept-labelers");
						const marker = raw === null ? "absent" : raw === "" ? "empty" : `value:${raw}`;
						return new Response("AGGREGATOR is stubbed in tests", {
							status: 501,
							headers: { "x-test-accept-labelers": marker },
						});
					},
				},
			},
		}),
	],
});

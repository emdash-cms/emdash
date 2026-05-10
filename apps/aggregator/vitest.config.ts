/**
 * Aggregator test config.
 *
 * Uses `@cloudflare/vitest-pool-workers` (v0.16+) so tests run inside a real
 * workerd isolate with real D1, real DOs, and real Queues. The
 * `cloudflareTest` plugin reads `wrangler.jsonc` for binding shape, so the
 * test environment matches dev/prod by construction.
 *
 * D1 migrations are read at config time and exposed to the worker isolate as
 * the `TEST_MIGRATIONS` binding. Tests apply them in a `beforeAll` via
 * `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` from `cloudflare:test`.
 *
 * External services (PDS, Jetstream, DID resolver, Constellation) become
 * dependency-injected via env bindings populated from
 * `@emdash-cms/atproto-test-utils`. The smoke test only exercises the schema;
 * suites that drive the ingest pipeline use the mock infrastructure.
 *
 * Why workers-pool over plain vitest: aggregator behaviour depends on D1
 * transaction semantics, DO storage durability, and Queue batching — all
 * workerd-specific. Mocked node tests would pass while production fails.
 */

import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					// Stub admin auth token so tests can exercise the auth-gated
					// admin routes without needing a real secret in the test
					// environment. Production deploys pull from
					// `wrangler secret put ADMIN_TOKEN`; the value below only
					// applies inside the workers test pool.
					ADMIN_TOKEN: "test-admin-token",
				},
			},
		}),
	],
});

import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));
const migrations = await readD1Migrations(migrationsPath);

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
				// Stub it so miniflare can start; tests that exercise the client
				// inject their own mock Fetcher rather than using this binding.
				serviceBindings: {
					AGGREGATOR: () =>
						new Response("AGGREGATOR is stubbed in tests", { status: 501 }),
				},
			},
		}),
	],
});

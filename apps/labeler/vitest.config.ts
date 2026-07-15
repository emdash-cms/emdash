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
				},
			},
		}),
	],
});

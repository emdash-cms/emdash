import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
	fileURLToPath(new URL("./tests/support/confidential-oauth/migrations", import.meta.url)),
);

export default defineConfig({
	test: {
		include: ["tests/confidential-oauth-workerd.test.ts"],
	},
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: "./tests/support/confidential-oauth/wrangler.jsonc",
			},
			miniflare: {
				bindings: { TEST_MIGRATIONS: migrations },
			},
		}),
	],
});

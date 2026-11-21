import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"node:module": fileURLToPath(new URL("./tests/workerd/fixtures/module.ts", import.meta.url)),
		},
	},
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	test: {
		include: ["tests/workerd/**/*.test.ts"],
	},
});

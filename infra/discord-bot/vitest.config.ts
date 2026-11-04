import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					GITHUB_APP_PRIVATE_KEY: "",
				},
			},
		}),
	],
	test: {
		include: ["tests/**/*.test.ts"],
	},
});

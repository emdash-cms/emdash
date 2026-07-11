import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					PUBLIC_ORIGIN: "https://release.example.invalid",
					ALLOWED_ORIGINS: '["https://release.example.invalid"]',
					ALLOWED_PUBLISHERS: '{"mode":"all"}',
					DEPLOYMENT_POLICY: "hosted",
				},
			},
		}),
	],
});

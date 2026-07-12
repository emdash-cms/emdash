import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_ENCRYPTION_KEYRING =
	'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}';
process.env["ENCRYPTION_KEYRING"] ??= TEST_ENCRYPTION_KEYRING;

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
					ENCRYPTION_KEYRING: TEST_ENCRYPTION_KEYRING,
				},
			},
		}),
	],
});

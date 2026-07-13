import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { TEST_ASSERTION_KEYSET } from "./test/fixtures/oauth.js";

const TEST_ENCRYPTION_KEYRING =
	'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}';
process.env["ENCRYPTION_KEYRING"] ??= TEST_ENCRYPTION_KEYRING;
process.env["OAUTH_ASSERTION_KEYSET"] ??= TEST_ASSERTION_KEYSET;
const verifierScriptPath = fileURLToPath(
	new URL("./test/fixtures/release-verifier.js", import.meta.url),
);
const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				workers: [
					{
						name: "emdash-release-verifier",
						modules: true,
						scriptPath: verifierScriptPath,
					},
				],
				bindings: {
					TEST_MIGRATIONS: migrations,
					PUBLIC_ORIGIN: "https://release.example.invalid",
					ALLOWED_ORIGINS: '["https://release.example.invalid"]',
					ALLOWED_PUBLISHERS: '{"mode":"all"}',
					DEPLOYMENT_POLICY: "hosted",
					ENCRYPTION_KEYRING: TEST_ENCRYPTION_KEYRING,
					OAUTH_REDIRECT_URIS: '["https://release.example.invalid/oauth/callback"]',
					OAUTH_ASSERTION_KEYSET: TEST_ASSERTION_KEYSET,
				},
			},
		}),
	],
});

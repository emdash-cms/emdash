/**
 * Minimal Astro config for Playwright e2e tests.
 *
 * Uses env vars for the database path and optional marketplace URL
 * so each test run gets an isolated database.
 */
import node from "@astrojs/node";
import react from "@astrojs/react";
import { colorPlugin } from "@emdash-cms/plugin-color";
import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

const dbUrl = process.env.EMDASH_TEST_DB || "file:./test.db";
const marketplaceUrl = process.env.EMDASH_MARKETPLACE_URL || undefined;

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react({
			babel: {
				plugins: ["@lingui/babel-plugin-lingui-macro"],
			},
		}),
		emdash({
			database: sqlite({ url: dbUrl }),
			plugins: [colorPlugin()],
			marketplace: marketplaceUrl,
			sandboxRunner: marketplaceUrl ? "./noop-sandbox.mjs" : undefined,
		}),
	],
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "es"],
		fallback: { fr: "en", es: "en" },
	},
	devToolbar: { enabled: false },
	vite: {
		plugins: [lingui()],
		server: {
			fs: { strict: false },
		},
	},
});

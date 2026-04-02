/**
 * Minimal Astro config for e2e tests.
 *
 * Uses EMDASH_TEST_DB env var for the database path so each
 * test run gets an isolated database.
 */
import node from "@astrojs/node";
import react from "@astrojs/react";
import { colorPlugin } from "@emdash-cms/plugin-color";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

const dbUrl = process.env.EMDASH_TEST_DB || "file:./test.db";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: dbUrl }),
			plugins: [colorPlugin()],
		}),
	],
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "es", "pt-br"],
		fallback: { fr: "en", es: "en", "pt-br": "en" },
	},
	devToolbar: { enabled: false },
	vite: {
		server: {
			fs: {
				// When running from a temp dir, node_modules is symlinked back to the
				// monorepo. Vite needs permission to serve files from the real paths.
				strict: false,
			},
		},
	},
});

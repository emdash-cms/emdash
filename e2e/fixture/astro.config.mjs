/**
 * Minimal Astro config for Playwright e2e tests.
 *
 * Uses env vars for the database path and optional marketplace URL
 * so each test run gets an isolated database.
 */
import { fileURLToPath } from "node:url";

import node from "@astrojs/node";
import react from "@astrojs/react";
import { colorPlugin } from "@emdash-cms/plugin-color";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

const dbUrl = process.env.EMDASH_TEST_DB || "file:./test.db";
const marketplaceUrl = process.env.EMDASH_MARKETPLACE_URL || undefined;
const editorExtensionsPlugin = {
	id: "editor-extensions-test",
	version: "1.0.0",
	format: "standard",
	entrypoint: fileURLToPath(new URL("./src/editor-extensions-plugin.ts", import.meta.url)),
	capabilities: [],
	allowedHosts: [],
	storage: {},
	editorPanels: [
		{
			id: "entry-health",
			title: "Plugin content health",
			route: "entry-health",
			collections: ["posts"],
			order: 20,
		},
	],
	editorActions: [
		{
			id: "entry-recheck",
			label: "Recheck saved entry",
			route: "entry-recheck",
			placement: "toolbar",
			collections: ["posts"],
			style: "danger",
			confirm: {
				title: "Recheck saved entry?",
				text: "The plugin will inspect the latest saved version.",
				confirm: "Recheck",
				deny: "Cancel",
			},
		},
	],
};

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: dbUrl }),
			middleware: { outer: "./src/outer-middleware.ts" },
			plugins: [colorPlugin(), editorExtensionsPlugin],
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
		server: {
			fs: { strict: false },
		},
	},
});
